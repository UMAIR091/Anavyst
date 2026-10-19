import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { syncDataSource } from "@/lib/sync";
import { saveSignIn } from "@/lib/integrations/connections";
import { getIntegration } from "@/lib/integrations/registry";
import { xAccessToken, packXToken, listXAdsAccounts, xIdentity, X_OAUTH_COOKIE } from "@/lib/integrations/oauth/xads";

export const runtime = "nodejs";

// OAuth 1.0a tokens don't expire — store a far-future horizon so the shared
// refresh path never runs for X (revocation surfaces as an API error → reconnect).
const HUNDRED_YEARS_MS = 100 * 365 * 24 * 60 * 60 * 1000;

// X Ads OAuth 1.0a redirect target. X returns ?oauth_token=&oauth_verifier=
// (not ?code=), so this completes the exchange itself, then stores the connection
// through the same encrypted data_sources pipeline every other provider uses.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
  const jar = await cookies();
  const raw = jar.get(X_OAUTH_COOKIE)?.value;
  const clear = () => jar.set(X_OAUTH_COOKIE, "", { maxAge: 0, path: "/" });

  const fail = (msg: string, clientId?: string) => {
    clear();
    const dest = clientId ? `/dashboard/clients/${clientId}` : "/dashboard/clients";
    return NextResponse.redirect(`${base}${dest}?connect_error=${encodeURIComponent(msg)}`);
  };

  if (url.searchParams.get("denied")) return fail("You denied the X authorization request.");
  const oauthToken = url.searchParams.get("oauth_token");
  const verifier = url.searchParams.get("oauth_verifier");
  if (!oauthToken || !verifier) return fail("Missing authorization response from X");
  if (!raw) return fail("Your X sign-in session expired. Please try again.");

  let saved: { clientId: string; token: string; secret: string };
  try {
    saved = JSON.parse(raw);
  } catch {
    return fail("Invalid X sign-in session. Please try again.");
  }
  // The request token must match the one we started with (CSRF check).
  if (saved.token !== oauthToken) return fail("Invalid X sign-in session. Please try again.");

  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.redirect(`${base}/login`);

  const def = getIntegration("x_ads");
  if (!def?.buildConfig) return fail("Unsupported integration", saved.clientId);

  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("id").eq("id", saved.clientId).maybeSingle();
  if (!client) return fail("Client not found");

  try {
    const { token, secret, userId } = await xAccessToken(saved.token, saved.secret, verifier);
    const stored = packXToken(token, secret);
    const [identity, accounts] = await Promise.all([xIdentity(stored), listXAdsAccounts(stored)]);
    const config = def.buildConfig(accounts);

    // Saved as a shared sign-in (0046) other clients can reuse, on the
    // client's source for the chosen account (0049).
    const { source } = await saveSignIn(supabase, {
      agencyId: agency.id,
      clientId: saved.clientId,
      def,
      tokens: {
        accessToken: stored,
        refreshToken: null, // 1.0a tokens are permanent — nothing to refresh
        expiresAt: new Date(Date.now() + HUNDRED_YEARS_MS).toISOString(),
      },
      identity,
      config,
      subject: userId ? `x:${userId}` : null,
      userId: user.id,
      enforceLimit: true,
    });

    if (def.readSelected?.(source.config ?? {})) await syncDataSource(supabase, source);
    clear();
    return NextResponse.redirect(`${base}/dashboard/clients/${saved.clientId}?connected=${def.id}`);
  } catch (err) {
    return fail((err as Error).message, saved.clientId);
  }
}
