import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { syncDataSource } from "@/lib/sync";
import { saveSignIn } from "@/lib/integrations/connections";
import crypto from "node:crypto";
import { getIntegration, isLive } from "@/lib/integrations/registry";
import { logError } from "@/lib/errorLog";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { publicMessage } from "@/lib/errors";
import { checkIntegrationLimit } from "@/lib/billing/limits";

export const runtime = "nodejs";

// Generic connect handler for API-key integrations (Klaviyo, CallRail, Ahrefs,
// Semrush …). The consent screen POSTs the secret field(s) here so they never
// appear in a URL/history. We verify them via the provider's verifyApiKey, then
// store the connection through the same pipeline the OAuth flow uses.
export async function POST(req: Request) {
  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.redirect(new URL("/login", req.url));

  const form = await req.formData();
  const clientId = String(form.get("clientId") ?? "");
  const type = String(form.get("type") ?? "");
  const origin = new URL(req.url).origin;
  const base = process.env.NEXT_PUBLIC_APP_URL ?? origin;
  const fail = (msg: string, cid = clientId) =>
    NextResponse.redirect(`${base}/dashboard/${cid ? `clients/${cid}` : "clients"}?connect_error=${encodeURIComponent(msg)}`);

  const def = getIntegration(type);
  if (!def || !isLive(def.id) || def.authKind !== "apikey" || !def.verifyApiKey || !def.buildConfig) {
    return fail("This integration can't be connected this way.");
  }
  if (!clientId) return fail("Missing client");

  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("id, agency_id").eq("id", clientId).maybeSingle();
  if (!client) return fail("Client not found");

  // Enforce the plan's per-client integration limit (trial only; paid =
  // unlimited) before a first connection; a further account is checked as it
  // is added (saveSignIn).
  const { data: sameType } = await supabase.from("data_sources").select("id").eq("client_id", clientId).eq("type", def.id).limit(1);
  if (!sameType?.length) {
    const limit = await checkIntegrationLimit(supabase, client.agency_id as string, clientId);
    if (!limit.allowed) return fail(limit.reason ?? "Integration limit reached.");
  }

  // Collect only the declared fields (trimmed).
  const fields: Record<string, string> = {};
  for (const f of def.connectFields ?? []) fields[f.name] = String(form.get(f.name) ?? "").trim();

  try {
    const { displayName, token, accounts } = await def.verifyApiKey(fields);
    const config = def.buildConfig(accounts);

    // Saved as a shared sign-in (migration 0046), so an agency-wide key such as
    // Ahrefs or Semrush can serve every client, on the client's source for the
    // chosen account (0049). The key itself identifies the login: the same key
    // entered twice is recognised (its hash, never the key, is compared).
    const { source, duplicate } = await saveSignIn(supabase, {
      agencyId: agency.id,
      clientId,
      def,
      tokens: {
        accessToken: token,
        refreshToken: null, // api keys don't rotate — revocation = reconnect
        expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000).toISOString(),
      },
      identity: displayName,
      config,
      subject: `key:${crypto.createHash("sha256").update(token).digest("hex")}`,
      userId: user.id,
      enforceLimit: true,
    });

    if (def.readSelected?.(source.config ?? {})) await syncDataSource(supabase, source);
    revalidateIntegrationHealth(agency.id);
    return NextResponse.redirect(
      duplicate
        ? `${base}/dashboard/connect/${def.id}/review?clientId=${clientId}&connection=${source.connection_id}`
        : `${base}/dashboard/clients/${clientId}?connected=${def.id}`
    );
  } catch (err) {
    // Invalid key, provider verification failure, or storage error. Log the raw
    // detail; show the user a safe message (an invalid-key message is surfaced
    // verbatim by publicMessage's allowlist; internals are masked).
    await logError({ context: "api_route", agencyId: agency.id, provider: def.id, message: (err as Error).message });
    return fail(publicMessage(err, `Couldn't connect ${def.name}. Check your details and try again.`, { provider: def.id }));
  }
}
