import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncDataSource } from "@/lib/sync";
import { saveSignIn } from "@/lib/integrations/connections";
import { getIntegration } from "@/lib/integrations/registry";
import {
  getWooStoreName, packWooToken, wooConfig, readWooState,
} from "@/lib/integrations/oauth/woocommerce";

export const runtime = "nodejs";

// WooCommerce POSTs the generated key pair here, server-to-server, after the
// store owner approves. There is no user session on this request, so trust is
// established by decrypting the signed `state` we issued at connect time
// (only our authenticated connect route can mint a valid one), and the
// agency is resolved from the client row via the service-role client.
export async function POST(req: Request) {
  let body: {
    user_id?: string; consumer_key?: string; consumer_secret?: string; key_permissions?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { user_id, consumer_key, consumer_secret, key_permissions } = body;
  if (!user_id || !consumer_key || !consumer_secret) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 400 });
  }
  if (key_permissions && key_permissions !== "read" && key_permissions !== "read_write") {
    return NextResponse.json({ error: "Read access is required" }, { status: 400 });
  }

  let clientId: string;
  let storeUrl: string;
  try {
    ({ clientId, storeUrl } = readWooState(user_id)); // throws if forged/tampered
  } catch {
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: client } = await supabase
    .from("clients").select("id, agency_id").eq("id", clientId).maybeSingle();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  try {
    // Verifies the keys work and resolves a display name (throws on bad keys).
    const displayName = await getWooStoreName(storeUrl, consumer_key, consumer_secret);
    const config = wooConfig(storeUrl, displayName);

    // A store's key pair serves that one store, so it's its own sign-in
    // (0046); the client's row is upserted on (client_id, type), see 0023.
    const def = getIntegration("woocommerce");
    if (!def) throw new Error("WooCommerce isn't available");
    const { source } = await saveSignIn(supabase, {
      agencyId: client.agency_id as string,
      clientId,
      def,
      tokens: {
        accessToken: packWooToken(consumer_key, consumer_secret),
        refreshToken: null, // key pairs don't rotate — revocation = reconnect
        expiresAt: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000).toISOString(),
      },
      identity: displayName,
      config,
      enforceLimit: true,
    });

    await syncDataSource(supabase, source);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
