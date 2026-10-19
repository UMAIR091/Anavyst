import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { syncDataSource } from "@/lib/sync";
import { saveSignIn } from "@/lib/integrations/connections";
import { getIntegration } from "@/lib/integrations/registry";
import {
  exchangeShopifyCode, getShopName, normalizeShopDomain, verifyShopifyHmac,
} from "@/lib/integrations/oauth/shopify";

export const runtime = "nodejs";

const NONCE_COOKIE = "oauth_nonce";

// Shopify OAuth redirect target. Mirrors the generic handleCallback but
// verifies Shopify's HMAC signature and carries the shop domain from state
// (the token exchange happens against the shop's own domain).
export async function GET(req: Request) {
  const { searchParams, origin } = new URL(req.url);
  const fail = async (msg: string) => {
    (await cookies()).set(NONCE_COOKIE, "", { maxAge: 0, path: "/" });
    return NextResponse.redirect(`${origin}/dashboard/clients?connect_error=${encodeURIComponent(msg)}`);
  };

  const code = searchParams.get("code");
  const state = searchParams.get("state");
  if (!code || !state) return fail("Missing authorization code");
  if (!verifyShopifyHmac(searchParams)) return fail("Invalid Shopify signature");

  let clientId: string;
  let shop: string;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    clientId = parsed.clientId;
    shop = parsed.shop;
    const cookieNonce = (await cookies()).get(NONCE_COOKIE)?.value;
    if (!cookieNonce || cookieNonce !== parsed.nonce) return fail("Invalid state");
  } catch {
    return fail("Invalid state");
  }
  // The shop echoing back must match the one authorized in state.
  const echoedShop = normalizeShopDomain(searchParams.get("shop") ?? "");
  if (!shop || echoedShop !== shop) return fail("Shop mismatch");

  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.redirect(`${origin}/login`);

  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return fail("Client not found");

  try {
    const tokens = await exchangeShopifyCode(shop, code);
    const displayName = await getShopName(shop, tokens.access_token);
    const config = { accounts: [{ id: shop, name: displayName }], account_id: shop };

    // A store's token serves that one store, so it's its own sign-in (0046),
    // on the client's source for that store (0049): a client can connect two.
    const def = getIntegration("shopify");
    if (!def) throw new Error("Shopify isn't available");
    const { source } = await saveSignIn(supabase, {
      agencyId: agency.id,
      clientId,
      def,
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: null, // offline tokens don't rotate — revocation = reconnect
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      },
      identity: displayName,
      config,
      // The token stands for the store itself.
      subject: `shopify:${shop}`,
      userId: user.id,
      enforceLimit: true,
    });

    await syncDataSource(supabase, source);
    (await cookies()).set(NONCE_COOKIE, "", { maxAge: 0, path: "/" });
    return NextResponse.redirect(`${origin}/dashboard/clients/${clientId}?connected=shopify`);
  } catch (err) {
    return fail((err as Error).message);
  }
}
