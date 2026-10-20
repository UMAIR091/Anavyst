// Generic OAuth connect + callback, shared by every integration route (Google,
// Meta, and future providers). Routes are thin wrappers that delegate here, so
// the flow lives in one place and adding a provider needs no new flow code.
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { syncDataSource } from "@/lib/sync";
import { availableIdentityProviders, getIntegration, getOAuthProvider, isLive } from "./registry";
import { isPlatformAdmin } from "@/lib/admin";
import { classifyIntegrationError } from "./errors";
import { revalidateIntegrationHealth } from "@/lib/integrationHealth";
import { logError } from "@/lib/errorLog";
import { logDetail, publicMessage } from "@/lib/errors";
import { checkIntegrationLimit } from "@/lib/billing/limits";
import type { IntegrationDef, OAuthProvider } from "./types";
import { saveSignIn, type DuplicateMatch } from "./connections";
import { logConnectionEvent } from "./connectionEvents";
import { CONNECT_FLASH_COOKIE, CONNECT_FLASH_MAX_AGE, encodeConnectFlash, type ConnectFlash } from "./connectFlash";
import { createAdminClient } from "@/lib/supabase/admin";
import { clientIp, rateLimit } from "@/lib/rateLimit";
import { LINK_COOKIE, isLinkToken, linkConnectable, linkSignInOptions, loadConnectLink } from "@/lib/connectLinks";

const NONCE_COOKIE = "oauth_nonce";
const FLOW_COOKIE_MAX_AGE = 1800; // see handleConnect

// Starts an OAuth flow from a client connect link (migration 0048):
// `?token=&type=&provider=`. The client has no Anavyst session, so the link is
// the authorization: it must be valid, name this platform and belong to a
// workspace that can still add it. The token rides in an httpOnly cookie, not
// the provider-visible state, so the callback can find the link and return
// the client to its page.
export async function handleLinkConnect(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const type = url.searchParams.get("type") ?? "";
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
  const back = (msg?: string) =>
    NextResponse.redirect(
      `${appBase}/connect/${isLinkToken(token) ? token : "invalid"}${msg ? `?error=${encodeURIComponent(msg)}` : ""}`
    );

  const limited = await rateLimit(`connect-link:${clientIp(req)}`, { limit: 30, windowSeconds: 600 });
  if (!limited.allowed) return back("Too many attempts. Please wait a few minutes and try again.");

  const admin = createAdminClient();
  const found = await loadConnectLink(admin, token);
  if (!found.ok) return back();
  const { link } = found;

  const def = getIntegration(type);
  const oauth = getOAuthProvider(def?.oauthProviderId);
  if (!link.types.includes(type) || !linkConnectable(def) || !oauth) {
    return back("That platform isn't part of this link.");
  }

  let provider: string | undefined;
  if (def.identityProviders?.length) {
    const options = linkSignInOptions(def);
    provider = url.searchParams.get("provider") ?? options[0]?.id;
    if (!options.some((p) => p.id === provider)) return back("That sign-in option isn't available.");
  }

  // The agency's plan still decides what its clients can add. (A further
  // account of a platform already connected is checked when it is added.)
  const { data: existing } = await admin
    .from("data_sources")
    .select("id")
    .eq("client_id", link.clientId)
    .eq("type", def.id)
    .limit(1);
  if (!existing?.length) {
    const limit = await checkIntegrationLimit(admin, link.agencyId, link.clientId);
    if (!limit.allowed) {
      return back(`This connection isn't available right now. Please let ${link.agency.name} know.`);
    }
  }

  const nonce = crypto.randomUUID();
  const state = Buffer.from(
    JSON.stringify({ clientId: link.clientId, nonce, type: def.id, provider, linkId: link.id })
  ).toString("base64url");
  const res = NextResponse.redirect(oauth.authUrl(state));
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set(NONCE_COOKIE, nonce, { httpOnly: true, secure, sameSite: "lax", maxAge: FLOW_COOKIE_MAX_AGE, path: "/" });
  res.cookies.set(LINK_COOKIE, token, { httpOnly: true, secure, sameSite: "lax", maxAge: FLOW_COOKIE_MAX_AGE, path: "/" });
  return res;
}

// Finishes a connect-link flow inside handleCallback: the link (found from
// its cookie, matching the state) stands in for a signed-in user. Writes use
// the service role, scoped to the link's own workspace and client, and the
// sign-in is saved as the client's own.
async function completeLinkCallback(args: {
  appBase: string;
  linkId: string;
  type: string;
  provider?: string;
  code: string;
}): Promise<Response> {
  const token = (await cookies()).get(LINK_COOKIE)?.value ?? "";
  const page = (query: string) => {
    const res = NextResponse.redirect(`${args.appBase}/connect/${isLinkToken(token) ? token : "invalid"}?${query}`);
    res.cookies.set(NONCE_COOKIE, "", { maxAge: 0, path: "/" });
    res.cookies.set(LINK_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };

  const admin = createAdminClient();
  const found = await loadConnectLink(admin, token);
  if (!found.ok || found.link.id !== args.linkId) {
    return page(`error=${encodeURIComponent("This link has expired or was revoked. Ask your agency for a new one.")}`);
  }
  const { link } = found;

  const def = getIntegration(args.type);
  const oauth = getOAuthProvider(def?.oauthProviderId);
  if (!link.types.includes(args.type) || !linkConnectable(def) || !oauth) {
    return page(`error=${encodeURIComponent("That platform isn't part of this link.")}`);
  }

  try {
    await completeOAuthConnect(admin, link.agencyId, link.clientId, def, oauth, args.code, args.provider, undefined, {
      clientOwned: true,
    });
    await admin.from("connect_links").update({ last_used_at: new Date().toISOString() }).eq("id", link.id);
    return page(`connected=${encodeURIComponent(def.id)}`);
  } catch (err) {
    await logError({
      context: "oauth_callback",
      agencyId: link.agencyId,
      provider: def.id,
      errorType: classifyIntegrationError(err),
      message: logDetail(err),
    });
    const shown = publicMessage(err, `Couldn't connect ${def.name}. Please try again.`, { provider: def.id });
    await logConnectionEvent({
      agencyId: link.agencyId, action: "client_connect", actor: "client", outcome: "failed", clientId: link.clientId,
      platform: def.id, detail: { error: shown, route: args.provider ?? null },
    });
    return page(`error=${encodeURIComponent(shown)}`);
  }
}

// Starts an OAuth flow for `?clientId=&type=`. Validates the target integration
// is live and has a registered OAuth backend, sets a CSRF nonce, and redirects
// to the provider's consent screen.
export async function handleConnect(req: Request): Promise<Response> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", req.url));

  const url = new URL(req.url);
  const clientId = url.searchParams.get("clientId");
  if (!clientId) return NextResponse.json({ error: "clientId required" }, { status: 400 });

  // Require an explicit integration type — never silently default to GSC, or a
  // caller with a missing/typo'd type would connect the wrong provider.
  const type = url.searchParams.get("type");
  if (!type) return NextResponse.json({ error: "type required" }, { status: 400 });
  const def = getIntegration(type);
  const oauth = getOAuthProvider(def?.oauthProviderId);
  if (!def || !isLive(def.id) || !oauth) {
    return NextResponse.json({ error: "This integration can't be connected yet." }, { status: 400 });
  }

  const { data: client } = await supabase.from("clients").select("id, agency_id").eq("id", clientId).maybeSingle();
  if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  // Enforce the plan's per-client integration limit (trial only; paid =
  // unlimited) before a first connection. Renewing a platform the client
  // already has adds nothing; a further account is checked as it is added.
  const { data: sameType } = await supabase
    .from("data_sources")
    .select("id")
    .eq("client_id", clientId)
    .eq("type", def.id)
    .limit(1);
  const limit = sameType?.length
    ? { allowed: true, reason: null }
    : await checkIntegrationLimit(supabase, client.agency_id as string, clientId);
  if (!limit.allowed) {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? url.origin;
    return NextResponse.redirect(`${base}/dashboard/clients/${clientId}?connect_error=${encodeURIComponent(limit.reason ?? "Integration limit reached.")}`);
  }

  // Identity-provider selection for integrations that accept more than one (e.g.
  // Microsoft Ads: microsoft | google). Default to the first declared provider;
  // reject an unknown value so a typo can't silently mis-route the sign-in.
  let provider: string | undefined;
  if (def.identityProviders?.length) {
    const options = availableIdentityProviders(def, isPlatformAdmin(user.email));
    provider = url.searchParams.get("provider") ?? options[0]?.id;
    if (!options.some((p) => p.id === provider)) {
      return NextResponse.json({ error: "Unsupported sign-in provider." }, { status: 400 });
    }
  }

  // One value some integrations need before OAuth can start — the Shopify store
  // domain, the Google Sheet to read — collected on the consent screen and
  // posted here. It rides inside the state so it survives the round trip to the
  // provider without a second cookie.
  let field: string | undefined;
  if (def.connectField) {
    field = (url.searchParams.get(def.connectField.name) ?? "").trim();
    if (!field) return NextResponse.json({ error: `${def.connectField.label} is required.` }, { status: 400 });
  }

  // Reconnecting a saved sign-in (?connection=) renews it for every client on
  // it. Checked here as the user (RLS: their own workspace, same integration)
  // and again, scoped to the agency, when the sign-in is saved.
  let connectionId: string | undefined;
  const requested = url.searchParams.get("connection");
  if (requested) {
    const { data: conn } = await supabase.from("connections").select("id, type").eq("id", requested).maybeSingle();
    if (!conn || conn.type !== def.id) {
      return NextResponse.json({ error: "That sign-in can't be reconnected here." }, { status: 400 });
    }
    connectionId = conn.id as string;
  }

  const nonce = crypto.randomUUID();
  const state = Buffer.from(JSON.stringify({ clientId, nonce, type: def.id, provider, field, connectionId })).toString("base64url");
  // 30 minutes: long enough to survive a consent screen where the user has to
  // stop and enable an API or pick an account, short enough to stay a
  // meaningful CSRF window. The nonce is still single-use and httpOnly, and is
  // cleared on both success and failure.
  (await cookies()).set(NONCE_COOKIE, nonce, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 1800, path: "/" });

  const authorizationUrl = oauth.authUrl(state);
  return NextResponse.redirect(authorizationUrl);
}

// Handles the provider's redirect back: verifies CSRF state, then completes the
// connection (token exchange, account listing, storage, initial sync).
export async function handleCallback(req: Request): Promise<Response> {
  const { searchParams, origin } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // Always return the user to the canonical host, so a callback that arrived on
  // a secondary domain doesn't strand them there (signed out, on the wrong URL).
  const appBase = process.env.NEXT_PUBLIC_APP_URL ?? origin;
  const fail = (msg: string) => {
    // Single-use nonce: clear on failure too, so a retried/replayed callback
    // can't reuse it, and the next connect attempt starts clean. Cleared on the
    // redirect response itself, which needs no async request API.
    const res = NextResponse.redirect(`${appBase}/dashboard/clients?connect_error=${encodeURIComponent(msg)}`);
    res.cookies.set(NONCE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };

  // A client connect link's flow returns the client to the link page, never
  // to the agency's dashboard, including when they cancel at the provider.
  const linkFail = async (msg: string) => {
    const token = (await cookies()).get(LINK_COOKIE)?.value ?? "";
    const res = NextResponse.redirect(
      `${appBase}/connect/${isLinkToken(token) ? token : "invalid"}?error=${encodeURIComponent(msg)}`
    );
    res.cookies.set(NONCE_COOKIE, "", { maxAge: 0, path: "/" });
    res.cookies.set(LINK_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };
  const fromLink = (() => {
    try {
      return Boolean(state && JSON.parse(Buffer.from(state, "base64url").toString("utf8")).linkId);
    } catch {
      return false;
    }
  })();

  // Providers signal denial via error/error_description instead of a code.
  const providerError = searchParams.get("error_description") || searchParams.get("error");
  if (providerError) return fromLink ? linkFail(providerError) : fail(providerError);
  if (!code || !state) return fromLink ? linkFail("Missing authorization code") : fail("Missing authorization code");

  let clientId: string;
  let type: string;
  let provider: string | undefined;
  let field: string | undefined;
  let connectionId: string | undefined;
  let linkId: string | undefined;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    clientId = parsed.clientId;
    type = parsed.type;
    provider = parsed.provider;
    field = typeof parsed.field === "string" ? parsed.field : undefined;
    connectionId = typeof parsed.connectionId === "string" ? parsed.connectionId : undefined;
    linkId = typeof parsed.linkId === "string" ? parsed.linkId : undefined;
    if (!clientId || !type) return fail("Invalid state");
    const cookieNonce = (await cookies()).get(NONCE_COOKIE)?.value;
    if (!cookieNonce || cookieNonce !== parsed.nonce) {
      if (linkId) {
        return linkFail("Your connection attempt expired. Please open the link again and retry.");
      }
      // The CSRF check is doing its job, but it also trips on two ordinary,
      // user-fixable situations: the flow was started on a different domain
      // than the one the provider redirects back to (the cookie is scoped to
      // the first host), or it sat unfinished past the cookie's lifetime.
      // Log it — this used to fail silently, leaving nothing to diagnose — and
      // say something the user can act on.
      await logError({
        context: "oauth_callback",
        provider: type,
        errorType: "config",
        message: `OAuth state rejected on ${origin}: ${cookieNonce ? "nonce mismatch" : "no nonce cookie on this host"}`,
      });
      return fail(
        "Your connection attempt expired or started on a different address. Please open the client page again and retry the connection."
      );
    }
  } catch {
    return fail("Invalid state");
  }

  // A client connect link: no Anavyst session, the link authorizes it.
  if (linkId) return completeLinkCallback({ appBase, linkId, type, provider, code });

  const def = getIntegration(type);
  const oauth = getOAuthProvider(def?.oauthProviderId);
  if (!def || !isLive(def.id) || !oauth) return fail("Unsupported integration");

  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) return NextResponse.redirect(`${appBase}/login`);

  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("id").eq("id", clientId).maybeSingle();
  if (!client) return fail("Client not found");

  try {
    const { flash, connectionId: savedId, duplicate } = await completeOAuthConnect(
      supabase, agency.id, clientId, def, oauth, code, provider, field, { connectionId, userId: user.id }
    );
    (await cookies()).set(NONCE_COOKIE, "", { maxAge: 0, path: "/" });
    // The same login was already saved: let the user choose to renew that
    // one, reuse it, or keep both, rather than silently piling up copies.
    const res = NextResponse.redirect(
      duplicate
        ? `${appBase}/dashboard/connect/${def.id}/review?clientId=${clientId}&connection=${savedId}`
        : `${appBase}/dashboard/clients/${clientId}?connected=${def.id}`
    );
    // Read once by ConnectStatusToast, so it isn't httpOnly.
    res.cookies.set(CONNECT_FLASH_COOKIE, encodeConnectFlash(flash), {
      maxAge: CONNECT_FLASH_MAX_AGE,
      path: "/dashboard",
      sameSite: "lax",
      secure: appBase.startsWith("https://"),
    });
    return res;
  } catch (err) {
    // Token exchange / account-listing / storage failed — record it, then fail
    // with a user-safe message (raw provider/DB detail stays in the logs).
    await logError({
      context: "oauth_callback",
      agencyId: agency.id,
      provider: def.id,
      errorType: classifyIntegrationError(err),
      message: logDetail(err),
    });
    const shown = publicMessage(err, `Couldn't connect ${def.name}. Please try again.`, { provider: def.id });
    await logConnectionEvent({
      agencyId: agency.id, action: connectionId ? "reconnect" : "connect", outcome: "failed", userId: user.id,
      clientId, connectionId: connectionId ?? null, platform: def.id, detail: { error: shown, route: provider ?? null },
    });
    return fail(shown);
  }
}

export type ConnectOutcome = {
  flash: ConnectFlash;
  connectionId: string;
  // A fresh sign-in that looks like one already saved (see saveSignIn).
  duplicate: DuplicateMatch | null;
};

// Exchanges the code, lists accounts, saves the sign-in (shared across the
// agency's clients, migration 0046) and places it on one of this client's
// sources: the account it auto-selected, or the client's pending source for
// the platform (migration 0049). Syncs whatever has an account chosen. With a
// connectionId it renews that saved sign-in, reconnecting every client on it,
// and only with the same login. Returns who signed in and which account was
// selected, for the success toast.
export async function completeOAuthConnect(
  supabase: SupabaseClient,
  agencyId: string,
  clientId: string,
  def: IntegrationDef,
  oauth: OAuthProvider,
  code: string,
  provider?: string,
  connectValue?: string,
  opts: { connectionId?: string; userId?: string; clientOwned?: boolean } = {}
): Promise<ConnectOutcome> {
  if (!def.listAccounts || !def.buildConfig) throw new Error("Integration is not connectable");

  const tokens = await oauth.exchangeCode(code, { provider });
  const accessToken = tokens.access_token;
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  const [identity, subject, accounts] = await Promise.all([
    oauth.identity(accessToken, { provider }),
    oauth.subject ? oauth.subject(accessToken, { provider }).catch(() => null) : Promise.resolve(null),
    def.listAccounts(accessToken, { provider, connectValue }),
  ]);
  const config = def.buildConfig(accounts);

  // The identity provider is recorded so refresh and provider-specific API
  // headers route correctly later.
  const saved = await saveSignIn(supabase, {
    agencyId,
    clientId,
    def,
    tokens: {
      accessToken,
      refreshToken: tokens.refresh_token,
      expiresAt,
      refreshExpiresAt: tokens.refresh_expires_in ? new Date(Date.now() + tokens.refresh_expires_in * 1000).toISOString() : null,
    },
    identity,
    identityProvider: provider,
    config,
    subject,
    accounts,
    connectionId: opts.connectionId,
    userId: opts.userId,
    clientOwned: opts.clientOwned,
    enforceLimit: true,
  });

  const chosen = def.readSelected?.(saved.source.config ?? {}) ?? null;
  await logConnectionEvent({
    agencyId,
    action: opts.connectionId ? "reconnect" : opts.clientOwned ? "client_connect" : "connect",
    actor: opts.clientOwned ? "client" : "user",
    userId: opts.userId ?? null,
    clientId,
    connectionId: saved.connectionId,
    dataSourceId: saved.source.id,
    platform: def.id,
    detail: {
      signedInAs: typeof identity === "string" ? identity : null,
      route: provider ?? null,
      account: chosen ? accounts.find((a) => a.id === chosen)?.name ?? chosen : null,
      accountsListed: accounts.length,
      ...(saved.renewal ? { restored: saved.renewal.restored, lacking: saved.renewal.lacking.length } : {}),
      ...(saved.duplicate ? { looksLike: saved.duplicate.displayName ?? "a saved sign-in", proven: saved.duplicate.strong } : {}),
    },
  });

  for (const source of saved.clientSources) {
    if (def.readSelected?.(source.config ?? {})) await syncDataSource(supabase, source);
  }

  // Reflect the new connection in the cached dashboard health rollup at once.
  revalidateIntegrationHealth(agencyId);

  const selected = def.readSelected?.(saved.source.config ?? {}) ?? null;
  const renewal = saved.renewal;
  const note = renewal
    ? `Renewed for ${renewal.restored} source${renewal.restored === 1 ? "" : "s"}` +
      (renewal.lacking.length
        ? `; ${renewal.lacking.length} ${def.accountNoun}${renewal.lacking.length === 1 ? "" : "s"} still need${renewal.lacking.length === 1 ? "s" : ""} access`
        : "")
    : null;
  return {
    flash: {
      account: selected
        ? (accounts.find((a) => a.id === selected)?.name ?? def.readAccounts?.(saved.source.config ?? {}).find((a) => a.id === selected)?.name ?? null)
        : null,
      identity: typeof identity === "string" ? identity : null,
      ...(note ? { note } : {}),
    },
    connectionId: saved.connectionId,
    duplicate: saved.duplicate,
  };
}
