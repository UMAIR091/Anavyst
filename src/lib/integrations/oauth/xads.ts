// X (Twitter) Ads backend (X Ads API v12).
//
// AUTH IS OAUTH 1.0a, not OAuth 2.0 — X's Ads API has never moved to OAuth 2.
// That doesn't fit the shared OAuthProvider contract (which assumes a sync
// authUrl(state) + code exchange + refresh), so X uses its own connect/callback
// routes (/api/x/*) that run the 1.0a dance, while reusing everything else:
// encrypted storage, the data_sources row shape, sync, dashboard and disconnect.
//
// 1.0a yields a permanent access token AND an access token secret, both needed to
// sign every request. They're stored together as "<token>:<secret>" in the
// encrypted access_token column (the same two-secrets-in-one pattern Moz uses),
// with a far-future expiry since 1.0a tokens don't expire or refresh.
import crypto from "node:crypto";
import type { IntegrationAccount } from "../types";
import { adWindows, adsTotals, windowFields, withRetry, type AdsDay, type AdsReport } from "../metrics";

// v12 is the current Ads API version (no deprecation date announced), and
// ads-api.x.com is its canonical host — the ads-api.twitter.com name still
// resolves, but only while X finishes the migration.
const ADS_API = "https://ads-api.x.com/12";
const OAUTH_BASE = "https://api.x.com/oauth";
const MICRO = 1_000_000;

// httpOnly cookie carrying the in-flight 1.0a request token + target client
// between /api/x/connect and /api/x/callback. Lives here rather than in a
// route file — Next.js only allows handler/config exports from route.ts.
export const X_OAUTH_COOKIE = "x_oauth1";

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

// X now calls these the app's API Key and Secret; OAuth 1.0a still signs them
// as the "consumer" key and secret. Either env name works, so a deployment that
// set one spelling doesn't silently read as unconfigured.
const clientKey = () => process.env.X_ADS_CLIENT_KEY || process.env.X_ADS_CONSUMER_KEY || "";
const clientSecret = () => process.env.X_ADS_CLIENT_SECRET || process.env.X_ADS_CONSUMER_SECRET || "";

function required(value: string, names: string): string {
  if (!value) throw new Error(`${names} is not set`);
  return value;
}

export function xAdsConfigured(): boolean {
  return Boolean(clientKey() && clientSecret());
}

export function xRedirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/x/callback`;
}

// ── OAuth 1.0a signing (RFC 5849) ────────────────────────────

// RFC 3986 percent-encoding — encodeURIComponent leaves !*'() unescaped.
function pct(v: string): string {
  return encodeURIComponent(v).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Builds the Authorization header for a signed 1.0a request. `extraOAuth` carries
// flow-specific params (oauth_callback / oauth_verifier); `query` must include any
// URL query params, which participate in the signature base string.
function authHeader(
  method: "GET" | "POST",
  url: string,
  query: Record<string, string>,
  token?: { key: string; secret: string },
  extraOAuth: Record<string, string> = {}
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: required(clientKey(), "X_ADS_CLIENT_KEY"),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token.key } : {}),
    ...extraOAuth,
  };

  // Signature base string: METHOD & url & sorted(oauth + query) params.
  const all: Record<string, string> = { ...oauth, ...query };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = `${method}&${pct(url)}&${pct(paramString)}`;
  const signingKey = `${pct(required(clientSecret(), "X_ADS_CLIENT_SECRET"))}&${pct(token?.secret ?? "")}`;
  const signature = crypto.createHmac("sha1", signingKey).update(base).digest("base64");

  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.keys(header).sort().map((k) => `${pct(k)}="${pct(header[k])}"`).join(", ")}`;
}

function parseForm(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  new URLSearchParams(text).forEach((v, k) => { out[k] = v; });
  return out;
}

// Step 1: get a request token; returns the token + secret and the authorize URL.
export async function xRequestToken(): Promise<{ token: string; secret: string; authorizeUrl: string }> {
  const url = `${OAUTH_BASE}/request_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authHeader("POST", url, {}, undefined, { oauth_callback: xRedirectUri() }) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X request_token failed: ${text.slice(0, 200)} (${res.status})`);
  const data = parseForm(text);
  if (!data.oauth_token || !data.oauth_token_secret) throw new Error("X request_token returned no token");
  return {
    token: data.oauth_token,
    secret: data.oauth_token_secret,
    authorizeUrl: `${OAUTH_BASE}/authorize?oauth_token=${encodeURIComponent(data.oauth_token)}`,
  };
}

// Step 3: exchange the verifier for a permanent access token + secret.
export async function xAccessToken(
  requestToken: string, requestSecret: string, verifier: string
): Promise<{ token: string; secret: string; userId: string | null }> {
  const url = `${OAUTH_BASE}/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader("POST", url, {}, { key: requestToken, secret: requestSecret }, { oauth_verifier: verifier }),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`X access_token failed: ${text.slice(0, 200)} (${res.status})`);
  const data = parseForm(text);
  if (!data.oauth_token || !data.oauth_token_secret) throw new Error("X access_token returned no token");
  // user_id: the X account's permanent id, returned with every access token.
  return { token: data.oauth_token, secret: data.oauth_token_secret, userId: data.user_id || null };
}

// The stored credential is "<token>:<secret>" — X tokens/secrets are base64-ish
// and never contain ":", so a first-colon split is unambiguous.
export function packXToken(token: string, secret: string): string {
  return `${token}:${secret}`;
}
function unpack(stored: string): { key: string; secret: string } {
  const i = stored.indexOf(":");
  if (i < 0) throw new Error("Malformed X credential — please reconnect.");
  return { key: stored.slice(0, i), secret: stored.slice(i + 1) };
}

// ── Ads API ──────────────────────────────────────────────────

async function xGet<T>(stored: string, path: string, query: Record<string, string> = {}): Promise<T> {
  const token = unpack(stored);
  const url = `${ADS_API}${path}`;
  return withRetry(async () => {
    const qs = Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
    const res = await fetch(`${url}${qs}`, {
      headers: { Authorization: authHeader("GET", url, query, token), Accept: "application/json" },
    });
    if (res.status === 429) throw new Error("X Ads rate limit (429)");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { errors?: { message?: string }[] }).errors?.[0]?.message ?? res.statusText;
      throw new Error(`X Ads API error: ${detail} (${res.status})`);
    }
    return data as T;
  });
}

type Listing<T> = { data?: T[]; next_cursor?: string | null };

// Lists the ad accounts the authenticated user can access.
// X reports spend as billed_charge_local_micro — in the ACCOUNT'S local
// currency, not USD. The account node doesn't carry the code, so it comes from
// the account's funding instrument. Best-effort: unknown returns "" so the UI
// omits the symbol rather than mislabelling the amount as dollars.
async function xAccountCurrency(stored: string, accountId: string): Promise<string> {
  try {
    const data = await xGet<Listing<{ currency?: string }>>(
      stored,
      `/accounts/${encodeURIComponent(accountId)}/funding_instruments`
    );
    return data.data?.find((f) => f.currency)?.currency ?? "";
  } catch {
    return "";
  }
}

export async function listXAdsAccounts(stored: string): Promise<IntegrationAccount[]> {
  const data = await xGet<Listing<{ id: string; name?: string }>>(stored, "/accounts");
  return (data.data ?? []).map((a) => ({ id: a.id, name: a.name ?? a.id }));
}

export async function xIdentity(stored: string): Promise<string> {
  try {
    const accounts = await listXAdsAccounts(stored);
    return accounts[0]?.name ?? "X Ads account";
  } catch {
    return "X Ads account";
  }
}

// X returns metrics as arrays aligned to the day buckets of the requested window.
type MetricArrays = Record<string, (number | null)[] | null | undefined>;
type StatsEntity = { id?: string; id_data?: { metrics?: MetricArrays }[] };

const at = (arr: (number | null)[] | null | undefined, i: number): number => {
  const v = arr?.[i];
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
};

// ── Stats windows ────────────────────────────────────────────
//
// X's synchronous stats endpoint rejects two things this connector used to
// send, and a catch turned both rejections into a report of zeros:
//   - DAY granularity needs start/end at MIDNIGHT IN THE AD ACCOUNT'S TIME ZONE
//     ("Expect time to be midnight in the account's local timezone"), so UTC
//     days only worked for accounts set to UTC.
//   - one request may span at most 7 days ("end_time can be a maximum of
//     7.days+1.hours after the start_time"), so a 28- or 90-day window is
//     fetched a week at a time.
// Both verified against ads-api.x.com on 16 Oct 2026.
export const X_MAX_SPAN_DAYS = 7;

const nextDay = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** "+05:00"-style UTC offset of `timeZone` at instant `at` (ms). */
function utcOffset(timeZone: string, at: number): string {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date(at))
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  return m ? `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}` : "+00:00";
}

const offsetMinutes = (off: string) => (off[0] === "-" ? -1 : 1) * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6)));

/** Midnight starting `ymd` in `timeZone`, as ISO 8601 with its offset. */
export function xLocalMidnight(ymd: string, timeZone: string): string {
  // First guess the offset at UTC midnight of that date, then re-read it at
  // the instant the guess names: that settles DST-change days where they differ.
  const utcMidnight = Date.parse(`${ymd}T00:00:00Z`);
  const guess = utcOffset(timeZone, utcMidnight);
  const off = utcOffset(timeZone, utcMidnight - offsetMinutes(guess) * 60_000);
  return `${ymd}T00:00:00${off}`;
}

/** Consecutive days split into runs of at most `max` (X's per-request span). */
export function xDayChunks(days: string[], max = X_MAX_SPAN_DAYS): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < days.length; i += max) out.push(days.slice(i, i + max));
  return out;
}

// The account's IANA time zone (e.g. "Asia/Karachi"), which X buckets days by.
async function xAccountTimeZone(stored: string, accountId: string): Promise<string | null> {
  const data = await xGet<{ data?: { timezone?: string | null } }>(stored, `/accounts/${encodeURIComponent(accountId)}`);
  return data.data?.timezone ?? null;
}

// Every campaign, deleted ones included: a campaign removed after it ran still
// spent inside the window. Follows the cursor so large accounts aren't cut at 200.
async function xCampaigns(stored: string, accountId: string): Promise<{ id: string; name?: string }[]> {
  const out: { id: string; name?: string }[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 10; page++) {
    const q: Record<string, string> = { count: "200", with_deleted: "true" };
    if (cursor) q.cursor = cursor;
    const data = await xGet<Listing<{ id: string; name?: string }>>(stored, `/accounts/${encodeURIComponent(accountId)}/campaigns`, q);
    out.push(...(data.data ?? []));
    cursor = data.next_cursor;
    if (!cursor) break;
  }
  return out;
}

// Stats accept at most 20 entity ids per call.
async function campaignStats(stored: string, accountId: string, ids: string[], start: string, end: string): Promise<StatsEntity[]> {
  const out: StatsEntity[] = [];
  for (let i = 0; i < ids.length; i += 20) {
    const chunk = ids.slice(i, i + 20);
    const data = await xGet<Listing<StatsEntity>>(stored, `/stats/accounts/${encodeURIComponent(accountId)}`, {
      entity: "CAMPAIGN",
      entity_ids: chunk.join(","),
      start_time: start,
      end_time: end,
      granularity: "DAY",
      metric_groups: "BILLING,ENGAGEMENT",
      placement: "ALL_ON_TWITTER",
    });
    out.push(...(data.data ?? []));
  }
  return out;
}

// Fetches the normalized ads report for one account and period. accountId = the
// X ad account id; `stored` is the packed "<token>:<secret>" credential.
// Errors propagate: a failed stats call must surface as a sync error, never as
// a report that says the client spent nothing.
export async function fetchXAdsReport(stored: string, accountId: string, periodDays: number): Promise<AdsReport> {
  const timeZone = (await xAccountTimeZone(stored, accountId)) ?? "UTC";
  const w = adWindows(periodDays, timeZone);

  const currency = await xAccountCurrency(stored, accountId);
  const items = await xCampaigns(stored, accountId);
  const names = new Map(items.map((c) => [c.id, c.name ?? c.id]));

  const byDay = new Map<string, AdsDay>();
  for (const d of w.days) byDay.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  const perCampaign = new Map<string, { spend: number; impressions: number; clicks: number }>();

  if (items.length) {
    const ids = items.map((c) => c.id);
    for (const chunk of xDayChunks(w.days)) {
      const start = xLocalMidnight(chunk[0], timeZone);
      const end = xLocalMidnight(nextDay(chunk[chunk.length - 1]), timeZone);
      const stats = await campaignStats(stored, accountId, ids, start, end);
      for (const entity of stats) {
        const m = entity.id_data?.[0]?.metrics;
        const total = perCampaign.get(entity.id ?? "") ?? { spend: 0, impressions: 0, clicks: 0 };
        chunk.forEach((d, i) => {
          const s = at(m?.billed_charge_local_micro, i) / MICRO;
          const imp = at(m?.impressions, i);
          const clk = at(m?.clicks, i);
          total.spend += s; total.impressions += imp; total.clicks += clk;
          const dayRow = byDay.get(d);
          if (dayRow) { dayRow.spend += s; dayRow.impressions += imp; dayRow.clicks += clk; }
        });
        perCampaign.set(entity.id ?? "", total);
      }
    }
  }

  // Campaigns that did nothing in the window (now including deleted ones) are
  // left off the leaderboard rather than listed at zero.
  const topCampaigns: AdsReport["topCampaigns"] = Array.from(perCampaign.entries())
    .filter(([, t]) => t.spend > 0 || t.impressions > 0 || t.clicks > 0)
    .map(([id, t]) => ({
      name: names.get(id) ?? (id || "—"),
      spend: t.spend, impressions: t.impressions, clicks: t.clicks,
      ctr: t.impressions > 0 ? t.clicks / t.impressions : 0,
      conversions: 0, // conversions require a separate metric group / attribution setup
    }));

  const byDate = Array.from(byDay.values());
  return {
    platform: "x_ads",
    // billed_charge_local_micro is in the account's LOCAL currency, so the code
    // comes from the funding instrument rather than being assumed.
    currency,
    totals: adsTotals(byDate),
    previousTotals: null,
    ...windowFields(w, false),
    byDate,
    topCampaigns: topCampaigns.sort((a, b) => b.spend - a.spend).slice(0, 10),
  };
}
