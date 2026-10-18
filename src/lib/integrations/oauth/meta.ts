// Meta (Facebook) OAuth backend + Marketing API helpers. Pure HTTP, no DB.
//
// Two kinds of token, depending on how the login dialog is opened:
// - With a Facebook Login for Business configuration (META_ADS_CONFIG_ID /
//   META_INSTAGRAM_CONFIG_ID, set 18 Oct 2026): the person picks a business
//   portfolio and the assets to share, and the code exchanges for a business
//   integration system-user token that never expires. It lasts until that
//   business removes the app (Business Settings → Integrations → Connected
//   apps).
// - Without one: a person's long-lived (~60 day) user token, which can't be
//   extended (see refresh), so the user has to sign in again.
import crypto from "node:crypto";
import type { OAuthProvider, TokenSet, IntegrationAccount } from "../types";
import { adWindows, windowFields } from "../metrics";

const API_VERSION = process.env.META_API_VERSION || "v21.0";
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;
export const META_DIALOG = `https://www.facebook.com/${API_VERSION}/dialog/oauth`;
const SCOPES = ["ads_read", "business_management"];
const SIXTY_DAYS = 60 * 24 * 60 * 60;

// Exported for sibling Meta-platform backends (Instagram, Facebook Pages).
export function metaEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}
const env = metaEnv;

// True only when the Meta app is fully configured. Meta Ads and Instagram share
// this app, so both stay "soon" until every var exists — otherwise the UI would
// offer a Connect whose authUrl() throws on the missing env var (a 500).
export function metaConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_OAUTH_REDIRECT_URI);
}

// HMAC of the access token with the app secret. Meta requires this on server-side
// Graph calls when "Require App Secret proof" is enabled, and accepts it otherwise.
function appSecretProof(accessToken: string): string {
  return crypto.createHmac("sha256", env("META_APP_SECRET")).update(accessToken).digest("hex");
}

// GET against the Graph API with Meta's error envelope surfaced as a real error.
// Calls that carry a user access token are automatically signed with appsecret_proof.
// Exported so sibling Meta-platform backends (Instagram, Facebook Pages) reuse it.
export async function graphGet<T = Record<string, unknown>>(path: string, params: Record<string, string>): Promise<T> {
  const signed = params.access_token ? { ...params, appsecret_proof: appSecretProof(params.access_token) } : params;
  const res = await fetch(`${GRAPH}${path}?${new URLSearchParams(signed).toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data as { error?: { message?: string } }).error) {
    const msg = (data as { error?: { message?: string } }).error?.message ?? res.statusText;
    throw new Error(`Meta API error: ${msg}`);
  }
  return data as T;
}

// ── Facebook Login for Business ─────────────────────────────
export type MetaLoginKind = "ads" | "instagram";
const CONFIG_ENV: Record<MetaLoginKind, string> = { ads: "META_ADS_CONFIG_ID", instagram: "META_INSTAGRAM_CONFIG_ID" };

// The two Facebook sign-in routes offered on the consent screen (stored as the
// connection's identity_provider). "business" picks a Business portfolio and
// the assets to share, and gets a token that never expires. "personal" is a
// person's own login (~60 days), for ad accounts or Pages that aren't in any
// Business portfolio, or someone who isn't an admin of one. A connection with
// no identity_provider was made the personal way, before the choice existed.
export const META_BUSINESS = "business";
export const META_PERSONAL = "personal";

// The Login for Business configuration for this kind of connection, if set.
// Unsetting the variable hides the business route and leaves the personal one.
export function metaBusinessConfig(kind: MetaLoginKind): string | null {
  return process.env[CONFIG_ENV[kind]]?.trim() || null;
}

export function metaBusinessLoginConfigured(kind: MetaLoginKind): boolean {
  return metaBusinessConfig(kind) !== null;
}

// authUrl only receives the state string, so the sign-in route chosen on the
// consent screen is read back out of it (handleConnect builds it).
export function stateProvider(state: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return typeof parsed.provider === "string" ? parsed.provider : undefined;
  } catch {
    return undefined;
  }
}

// The login dialog. On the business route, `config_id` replaces `scope` (the
// configuration carries the permissions and assets), and a system-user token
// needs the authorization-code grant, hence override_default_response_type.
// Anything else, or a business route with no configuration, is the plain
// scoped login.
export function metaDialogUrl(state: string, scopes: string[], kind: MetaLoginKind, business: boolean): string {
  const params = new URLSearchParams({
    client_id: env("META_APP_ID"),
    redirect_uri: env("META_OAUTH_REDIRECT_URI"),
    state,
    response_type: "code",
  });
  const config = business ? metaBusinessConfig(kind) : null;
  if (config) {
    params.set("config_id", config);
    params.set("override_default_response_type", "true");
  } else {
    params.set("scope", scopes.join(","));
  }
  return `${META_DIALOG}?${params.toString()}`;
}

// A system-user token doesn't expire; stored with a far-future expiry like
// other non-expiring credentials, so it is never refreshed or flagged.
const NEVER = 100 * 365 * 24 * 60 * 60;

// The business a system-user token was issued to, or null for a person's
// token (asking a user node for client_business_id is an error).
export async function metaClientBusiness(accessToken: string): Promise<{ id: string; name: string | null } | null> {
  try {
    const me = await graphGet<{ client_business_id?: string }>("/me", {
      fields: "client_business_id",
      access_token: accessToken,
    });
    if (!me.client_business_id) return null;
    const business = await graphGet<{ name?: string }>(`/${me.client_business_id}`, {
      fields: "name",
      access_token: accessToken,
    }).catch(() => ({}) as { name?: string });
    return { id: me.client_business_id, name: business.name ?? null };
  } catch {
    return null;
  }
}

export const metaOAuth: OAuthProvider = {
  id: "meta",
  authUrl: (state) => metaDialogUrl(state, SCOPES, "ads", stateProvider(state) === META_BUSINESS),

  // Exchange the auth code. A business configuration hands back the
  // never-expiring system-user token itself; a plain login hands back a
  // short-lived user token, upgraded here to a long-lived (~60 day) one and
  // stored as both access + refresh token.
  async exchangeCode(code): Promise<TokenSet> {
    const short = await graphGet<{ access_token: string }>("/oauth/access_token", {
      client_id: env("META_APP_ID"),
      client_secret: env("META_APP_SECRET"),
      redirect_uri: env("META_OAUTH_REDIRECT_URI"),
      code,
    });
    if (await metaClientBusiness(short.access_token)) {
      return { access_token: short.access_token, expires_in: NEVER };
    }
    const long = await graphGet<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: env("META_APP_ID"),
      client_secret: env("META_APP_SECRET"),
      fb_exchange_token: short.access_token,
    });
    return { access_token: long.access_token, refresh_token: long.access_token, expires_in: long.expires_in || SIXTY_DAYS };
  },

  // Re-exchange a still-valid long-lived token. This does NOT extend it: Meta
  // returns a new token with the same expiry (checked with debug_token,
  // 17 Oct 2026), and expires_in is the time left. Hence renewal "reconnect".
  async refresh(token): Promise<TokenSet> {
    const long = await graphGet<{ access_token: string; expires_in?: number }>("/oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: env("META_APP_ID"),
      client_secret: env("META_APP_SECRET"),
      fb_exchange_token: token,
    });
    return { access_token: long.access_token, refresh_token: long.access_token, expires_in: long.expires_in || SIXTY_DAYS };
  },

  // Who the connection is: the business for a system-user token (its own
  // "name" is a generated system user), otherwise the person who signed in.
  async identity(accessToken): Promise<string> {
    const business = await metaClientBusiness(accessToken);
    if (business) return business.name ? `${business.name} (business)` : "Meta business";
    const me = await graphGet<{ name?: string }>("/me", { fields: "name", access_token: accessToken });
    return me.name ?? "Meta account";
  },

  // De-authorizes the app for this user (removes all granted permissions).
  // Best-effort — disconnect proceeds even if this fails.
  async revoke({ accessToken }): Promise<void> {
    if (!accessToken) return;
    const params = new URLSearchParams({ access_token: accessToken, appsecret_proof: appSecretProof(accessToken) });
    const res = await fetch(`${GRAPH}/me/permissions?${params.toString()}`, { method: "DELETE" });
    if (!res.ok) throw new Error(`Meta permission revoke failed: ${await res.text()}`);
  },

  // A long-lived Facebook user token can't be extended server-side; the user
  // must sign in again within its ~60 days. (A system-user token is stored
  // with a far-future expiry, so this never comes due for it.)
  renewal: () => "reconnect",

  // Registered in the Meta app's Facebook Login settings.
  callbackPath: "/api/meta/callback",
};

// Lists the ad accounts the authenticated user can access (Marketing API).
// Account ids come back as "act_<id>" — the form the insights endpoints expect.
export async function listMetaAdAccounts(accessToken: string): Promise<IntegrationAccount[]> {
  const data = await graphGet<{ data?: { id: string; account_id?: string; name?: string }[] }>("/me/adaccounts", {
    fields: "account_id,name,account_status,currency",
    limit: "200",
    access_token: accessToken,
  });
  return (data.data ?? []).map((a) => ({
    id: a.id, // already "act_<id>"
    name: a.name || a.account_id || a.id,
  }));
}

// ── Marketing API insights (real data cached by the sync job) ────────────────
export type MetaAdsTotals = {
  spend: number; impressions: number; clicks: number; ctr: number; cpc: number;
  reach: number; conversions: number; costPerConversion: number;
};
export type MetaAdsDay = { date: string; spend: number; impressions: number; clicks: number };
export type MetaAdsCampaign = { name: string; spend: number; impressions: number; clicks: number; ctr: number };
export type MetaAdsReport = {
  /** The ad account's own reporting currency — Meta reports spend in it, and a
   *  PKR or EUR account must never be rendered with "$". Optional so snapshots
   *  synced before this field existed still deserialize; consumers fall back. */
  currency?: string;
  totals: MetaAdsTotals;
  previousTotals: MetaAdsTotals | null;
  byDate: MetaAdsDay[];
  topCampaigns: MetaAdsCampaign[];
  /** Inclusive dates requested, in the ad account's own calendar. */
  window?: { start: string; end: string };
  previousWindow?: { start: string; end: string } | null;
  timeZone?: string | null;
};

// The ad account's reporting currency. Meta already returns this on the account
// node; it was previously fetched in listMetaAdAccounts and discarded, leaving
// every Meta report to be rendered as USD downstream. Best-effort: an error here
// must not fail the whole sync, so it degrades to undefined and the UI omits the
// symbol rather than inventing one.
//
// The account's time zone comes from the same call: Meta's insights are bucketed
// by the ad account's calendar, so the report window is computed in it.
async function metaAccountDetail(accessToken: string, accountId: string): Promise<{ currency?: string; timeZone?: string }> {
  try {
    const data = await graphGet<{ currency?: string; timezone_name?: string }>(`/${accountId}`, {
      fields: "currency,timezone_name",
      access_token: accessToken,
    });
    return { currency: data.currency || undefined, timeZone: data.timezone_name || undefined };
  } catch {
    return {};
  }
}


type InsightRow = {
  date_start?: string;
  spend?: string; impressions?: string; clicks?: string; ctr?: string; cpc?: string; reach?: string;
  campaign_name?: string;
  actions?: { action_type: string; value: string }[];
};

const num = (v: string | undefined) => (v ? Number(v) : 0);

// Sum conversion-like actions (purchases, leads, registrations, custom conversions).
function conversionsFrom(actions?: { action_type: string; value: string }[]): number {
  if (!actions) return 0;
  const wanted = /purchase|lead|complete_registration|offsite_conversion/i;
  return actions.filter((a) => wanted.test(a.action_type)).reduce((s, a) => s + Number(a.value || 0), 0);
}

function totalsFrom(row: InsightRow | undefined): MetaAdsTotals {
  const spend = num(row?.spend);
  const conversions = conversionsFrom(row?.actions);
  return {
    spend,
    impressions: num(row?.impressions),
    clicks: num(row?.clicks),
    ctr: num(row?.ctr) / 100, // Meta returns CTR as a percentage
    cpc: num(row?.cpc),
    reach: num(row?.reach),
    conversions,
    costPerConversion: conversions > 0 ? spend / conversions : 0,
  };
}

// The insights edge pages its results, 25 rows to a page by default. Only the
// first page used to be read, so a 28- or 90-day daily breakdown stopped after
// 25 days: the trend chart, every custom-period rebuild and the metric_daily
// archive silently lost the rest of the window. Follows the cursor to the end,
// with a bound so a misbehaving cursor cannot loop forever.
const INSIGHTS_PAGE_SIZE = "100";
const MAX_INSIGHTS_PAGES = 20;

export async function insights(accessToken: string, accountId: string, params: Record<string, string>): Promise<InsightRow[]> {
  const rows: InsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_INSIGHTS_PAGES; page++) {
    const data = await graphGet<{ data?: InsightRow[]; paging?: { next?: string; cursors?: { after?: string } } }>(
      `/${accountId}/insights`,
      { access_token: accessToken, limit: INSIGHTS_PAGE_SIZE, ...params, ...(after ? { after } : {}) }
    );
    rows.push(...(data.data ?? []));
    after = data.paging?.next ? data.paging.cursors?.after : undefined;
    if (!after) return rows;
  }
  throw new Error("Meta API error: insights paging did not finish");
}

// Fetches a real insights report for one ad account and period, plus the prior
// equal-length period for comparison. No mock data.
export async function fetchMetaAdsReport(accessToken: string, accountId: string, periodDays: number): Promise<MetaAdsReport> {
  // The window ends on the account's last complete day (adWindows): read the
  // account's time zone first, because the dates depend on it.
  const { currency, timeZone } = await metaAccountDetail(accessToken, accountId);
  const w = adWindows(periodDays, timeZone);
  const { since, until, prevSince, prevUntil } = w;
  const range = (s: string, u: string) => JSON.stringify({ since: s, until: u });
  const totalsFields = "spend,impressions,clicks,ctr,cpc,reach,actions";

  const [totalsRows, prevRows, dailyRows, campaignRows] = await Promise.all([
    insights(accessToken, accountId, { time_range: range(since, until), fields: totalsFields }),
    insights(accessToken, accountId, { time_range: range(prevSince, prevUntil), fields: totalsFields }).catch(() => []),
    insights(accessToken, accountId, { time_range: range(since, until), time_increment: "1", fields: "spend,impressions,clicks" }),
    insights(accessToken, accountId, { time_range: range(since, until), level: "campaign", fields: "campaign_name,spend,impressions,clicks,ctr" }),
  ]);

  // "Top campaigns" means top by spend. The API was asked for the first 10 rows
  // in its own order, which is not a ranking, so every campaign is read and the
  // ranking is done here.
  const topCampaignRows = campaignRows.slice().sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 10);

  return {
    currency,
    totals: totalsFrom(totalsRows[0]),
    previousTotals: prevRows.length ? totalsFrom(prevRows[0]) : null,
    ...windowFields(w, prevRows.length > 0),
    byDate: dailyRows.map((r) => ({ date: r.date_start ?? "", spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks) })),
    topCampaigns: topCampaignRows.map((r) => ({ name: r.campaign_name ?? "—", spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), ctr: num(r.ctr) / 100 })),
  };
}
