// Snapchat Ads backend (Snapchat Marketing API v1). OAuth 2.0 with a short-lived
// (1-hour) access token + long-lived refresh token, so the shared refresh flow
// runs on nearly every sync. Ad performance is normalized into the shared
// AdsReport rendered by AdsAnalytics. Spend is reported in micro-currency and a
// "swipe" is Snapchat's click equivalent.
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import { adWindows, adsTotals, windowFields, withRetry, type AdsDay, type AdsReport } from "../metrics";

const API = "https://adsapi.snapchat.com/v1";
const AUTH = "https://accounts.snapchat.com/login/oauth2";
const SCOPE = "snapchat-marketing-api";
const MICRO = 1_000_000;
const FIELDS = ["spend", "impressions", "swipes", "conversion_purchases"];

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function snapchatConfigured(): boolean {
  return Boolean(process.env.SNAPCHAT_CLIENT_ID && process.env.SNAPCHAT_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/snapchat/callback`;
}

async function snapGet<T>(path: string, accessToken: string, params?: Record<string, string>): Promise<T> {
  return withRetry(async () => {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    const res = await fetch(`${API}${path}${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (res.status === 429) throw new Error("Snapchat rate limit (429)");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Snapchat reports failures in debug_message/display_message with an
      // error_code — not the OAuth-style error_description we used to read, so
      // every stats rejection surfaced as a bare "Bad Request (400)" with
      // nothing to act on.
      const body = data as {
        debug_message?: string; display_message?: string; error_code?: string;
        error_description?: string; message?: string;
      };
      const detail = body.debug_message ?? body.display_message ?? body.error_description ?? body.message ?? res.statusText;
      const code = body.error_code ? ` [${body.error_code}]` : "";
      throw new Error(`Snapchat API error: ${detail}${code} (${res.status})`);
    }
    return data as T;
  });
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${AUTH}/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: env("SNAPCHAT_CLIENT_ID"),
      client_secret: env("SNAPCHAT_CLIENT_SECRET"),
      ...body,
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Snapchat token request failed: ${data.error_description ?? res.statusText} (${res.status})`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in ?? 3600 };
}

export const snapchatOAuth: OAuthProvider = {
  id: "snapchat",
  authUrl(state) {
    const params = new URLSearchParams({
      client_id: env("SNAPCHAT_CLIENT_ID"),
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPE,
      state,
    });
    return `${AUTH}/authorize?${params.toString()}`;
  },
  exchangeCode(code) {
    return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  },
  async refresh(refreshToken) {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    return { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken };
  },
  async identity(accessToken) {
    try {
      const data = await snapGet<{ me?: { email?: string; display_name?: string } }>("/me", accessToken);
      return data.me?.email ?? data.me?.display_name ?? "Snapchat account";
    } catch {
      return "Snapchat account";
    }
  },

  async subject(accessToken) {
    try {
      const data = await snapGet<{ me?: { id?: string } }>("/me", accessToken);
      return data.me?.id ? `snapchat:${data.me.id}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/snapchat/callback",
};

// Snapchat wraps every entity as { <entity>: {...} } inside a plural list.
type OrgWrap = { organization?: { id: string; name?: string } };
type AdAccountWrap = { adaccount?: { id: string; name?: string; timezone?: string; currency?: string } };
type CampaignWrap = { campaign?: { id: string; name?: string } };

// Lists the ad accounts across all the user's organizations.
export async function listSnapchatAdAccounts(accessToken: string): Promise<IntegrationAccount[]> {
  const orgs = await snapGet<{ organizations?: OrgWrap[] }>("/me/organizations", accessToken);
  const orgIds = (orgs.organizations ?? []).map((o) => o.organization?.id).filter((v): v is string => Boolean(v));

  const accounts: IntegrationAccount[] = [];
  for (const orgId of orgIds.slice(0, 20)) {
    try {
      const data = await snapGet<{ adaccounts?: AdAccountWrap[] }>(`/organizations/${encodeURIComponent(orgId)}/adaccounts`, accessToken);
      for (const a of data.adaccounts ?? []) {
        if (a.adaccount?.id) accounts.push({ id: a.adaccount.id, name: a.adaccount.name ?? a.adaccount.id });
      }
    } catch {
      // Skip an org we can't read rather than failing the whole listing.
    }
  }
  return accounts;
}

// ── Stats ────────────────────────────────────────────────────

// The account timezone offset (e.g. "-08:00") at a given instant, so day
// boundaries align to the ad account's day as Snapchat's stats API requires.
function tzOffset(timezone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(at);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
    const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) return "+00:00";
    return `${m[1]}${m[2].padStart(2, "0")}:${m[3] ?? "00"}`;
  } catch {
    return "+00:00";
  }
}

// A day boundary as Snapchat wants it: the AD ACCOUNT's calendar date at
// midnight in its own timezone. Taking the UTC date instead would land on the
// wrong day for accounts whose offset crosses midnight, and the offset is
// recomputed per date so DST transitions inside a range stay correct.
function dayStart(daysAgo: number, timezone: string): { ymd: string; iso: string } {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
  return { ymd, iso: `${ymd}T00:00:00.000${tzOffset(timezone, at)}` };
}

// Snapchat rejects a synchronous DAY-granularity query whose range exceeds 31
// days ("time must be of day boundary, start_time and end_time within 31
// days"), so the 90-day report has to be fetched in windows and stitched back
// together. Requesting the whole range in one call is what made every Snapchat
// sync fail with a bare 400.
const MAX_DAY_SPAN = 31;

type TimeseriesEntry = { start_time?: string; stats?: Record<string, number> };
type TimeseriesStats = {
  timeseries_stats?: {
    timeseries_stat?: {
      timeseries?: TimeseriesEntry[];
      breakdown_stats?: { campaign?: { id?: string; timeseries?: TimeseriesEntry[] }[] };
    };
  }[];
};
type BreakdownStats = {
  total_stats?: { total_stat?: { breakdown_stats?: { campaign?: { id: string; stats?: Record<string, number> }[] } } }[];
};

const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toDay(start: string, stats: Record<string, number> | undefined): AdsDay {
  return {
    date: (start ?? "").slice(0, 10),
    spend: n(stats?.spend) / MICRO,
    impressions: n(stats?.impressions),
    clicks: n(stats?.swipes),
    conversions: n(stats?.conversion_purchases),
  };
}

async function accountDetail(accessToken: string, adAccountId: string): Promise<{ timezone: string; currency: string }> {
  try {
    const data = await snapGet<{ adaccounts?: AdAccountWrap[] }>(`/adaccounts/${encodeURIComponent(adAccountId)}`, accessToken);
    const acc = data.adaccounts?.[0]?.adaccount;
    return { timezone: acc?.timezone ?? "UTC", currency: acc?.currency ?? "" };
  } catch {
    return { timezone: "UTC", currency: "" };
  }
}

// Sums the daily rows of a stats response, whether they arrive as one series
// for the whole account or as one series per campaign under breakdown_stats.
function totalsByDay(data: TimeseriesStats): AdsDay[] {
  const byDay = new Map<string, AdsDay>();
  for (const wrap of data.timeseries_stats ?? []) {
    const stat = wrap.timeseries_stat;
    const campaigns = stat?.breakdown_stats?.campaign;
    const series = campaigns?.length ? campaigns.map((c) => c.timeseries ?? []) : [stat?.timeseries ?? []];
    for (const entries of series) {
      for (const entry of entries) {
        const day = toDay(entry.start_time ?? "", entry.stats);
        const prev = byDay.get(day.date);
        byDay.set(day.date, prev
          ? {
              date: day.date,
              spend: prev.spend + day.spend,
              impressions: prev.impressions + day.impressions,
              clicks: prev.clicks + day.clicks,
              conversions: prev.conversions + day.conversions,
            }
          : day);
      }
    }
  }
  return Array.from(byDay.values());
}

// Snapchat answers "Only field 'spend' should be used when querying AdAccount
// stats" (E1008) to anything richer asked of an ad account as a whole — which
// is what our impressions/swipes/conversions request was. Those metrics are
// only served broken down, so we ask for the campaign breakdown and add the
// campaigns back up into account totals. If even that is refused, fall back to
// the one shape an ad account always accepts so the source still syncs with
// spend rather than failing outright.
async function dailyStats(accessToken: string, adAccountId: string, startIso: string, endIso: string): Promise<AdsDay[]> {
  const path = `/adaccounts/${encodeURIComponent(adAccountId)}/stats`;
  const base = { granularity: "DAY", start_time: startIso, end_time: endIso, omit_empty: "false" };
  try {
    return totalsByDay(await snapGet<TimeseriesStats>(path, accessToken, {
      ...base, fields: FIELDS.join(","), breakdown: "campaign",
    }));
  } catch (err) {
    if (!/E1008|Unsupported Stats Query/i.test(String((err as Error).message ?? ""))) throw err;
    return totalsByDay(await snapGet<TimeseriesStats>(path, accessToken, { ...base, fields: "spend" }));
  }
}

// Walks a range (expressed in days-ago boundaries, older → newer) in windows of
// at most MAX_DAY_SPAN. Sequential on purpose: three chunks of a 90-day report
// are cheap, and Snapchat allows only 10 req/s per access token.
async function dailyStatsRange(
  accessToken: string, adAccountId: string, fromDaysAgo: number, toDaysAgo: number, timezone: string
): Promise<AdsDay[]> {
  const rows: AdsDay[] = [];
  for (let from = fromDaysAgo; from > toDaysAgo; from -= MAX_DAY_SPAN) {
    const to = Math.max(from - MAX_DAY_SPAN, toDaysAgo);
    rows.push(...(await dailyStats(accessToken, adAccountId, dayStart(from, timezone).iso, dayStart(to, timezone).iso)));
  }
  return rows;
}

async function topCampaigns(accessToken: string, adAccountId: string, startIso: string, endIso: string): Promise<AdsReport["topCampaigns"]> {
  const [campaigns, breakdown] = await Promise.all([
    snapGet<{ campaigns?: CampaignWrap[] }>(`/adaccounts/${encodeURIComponent(adAccountId)}/campaigns`, accessToken).catch(() => ({ campaigns: [] as CampaignWrap[] })),
    snapGet<BreakdownStats>(`/adaccounts/${encodeURIComponent(adAccountId)}/stats`, accessToken, {
      granularity: "TOTAL",
      breakdown: "campaign",
      fields: FIELDS.join(","),
      start_time: startIso,
      end_time: endIso,
    }).catch(() => ({} as BreakdownStats)),
  ]);
  const names = new Map((campaigns.campaigns ?? []).map((c) => [c.campaign?.id, c.campaign?.name]));
  const rows = breakdown.total_stats?.[0]?.total_stat?.breakdown_stats?.campaign ?? [];
  return rows
    .map((r) => {
      const impressions = n(r.stats?.impressions);
      const clicks = n(r.stats?.swipes);
      return {
        name: names.get(r.id) ?? r.id,
        spend: n(r.stats?.spend) / MICRO,
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : 0,
        conversions: n(r.stats?.conversion_purchases),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);
}

// Fetches the normalized ads report for one ad account and period, plus the
// prior equal-length period. accountId = the Snapchat ad account id.
export async function fetchSnapchatAdsReport(
  accessToken: string, adAccountId: string, periodDays: number
): Promise<AdsReport> {
  const { timezone, currency } = await accountDetail(accessToken, adAccountId);

  const start = dayStart(periodDays, timezone);
  const end = dayStart(0, timezone);

  const [dailyRows, prevRows, campaigns] = await Promise.all([
    dailyStatsRange(accessToken, adAccountId, periodDays, 0, timezone),
    dailyStatsRange(accessToken, adAccountId, periodDays * 2, periodDays, timezone).catch(() => [] as AdsDay[]),
    topCampaigns(accessToken, adAccountId, start.iso, end.iso).catch(() => [] as AdsReport["topCampaigns"]),
  ]);

  // Zero-fill the day range so charts don't skip omitted days. The days are
  // the ACCOUNT's calendar days — the same ones the requests above cover
  // (midnight local today minus N, to midnight local today). Keying them by
  // UTC dates dropped the newest local day whenever the two calendars differ.
  const w = adWindows(periodDays, timezone);
  const byDay = new Map<string, AdsDay>();
  for (const d of w.days) byDay.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  for (const r of dailyRows) if (byDay.has(r.date)) byDay.set(r.date, r);
  const byDate = Array.from(byDay.values());

  return {
    platform: "snapchat_ads",
    currency,
    totals: adsTotals(byDate),
    previousTotals: prevRows.length ? adsTotals(prevRows) : null,
    ...windowFields(w, prevRows.length > 0),
    byDate,
    topCampaigns: campaigns,
  };
}
