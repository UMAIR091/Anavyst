// Pinterest Ads backend (Pinterest REST API v5). Standard OAuth 2.0: the token
// endpoint uses HTTP Basic auth (app id:secret) and issues a short-lived access
// token plus a refresh token, so this plugs into the shared refresh flow. Ad
// performance is normalized into the shared AdsReport rendered by AdsAnalytics.
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import { adWindows, adsTotals, windowFields, withRetry, type AdsDay, type AdsReport } from "../metrics";

const API = "https://api.pinterest.com/v5";
// Read-only scopes: ad metrics + the account identity used to label the connection.
const SCOPES = ["ads:read", "user_accounts:read"];
// SPEND_IN_DOLLAR is reported in USD; _1 columns are first-order ad events
// (CLICKTHROUGH_1 = ad Pin clicks). All read-only reporting columns.
const COLUMNS = ["SPEND_IN_DOLLAR", "IMPRESSION_1", "CLICKTHROUGH_1", "TOTAL_CONVERSIONS"];
// Conversion value, used for revenue and ROAS. Availability depends on the
// advertiser having conversion tracking configured, and Pinterest rejects the
// whole request when a column isn't valid for the account — so these are
// requested optionally and dropped on failure rather than breaking the report.
const REVENUE_COLUMNS = ["TOTAL_CONVERSIONS_VALUE_IN_MICRO_DOLLAR"];
const MICRO = 1_000_000;

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function pinterestConfigured(): boolean {
  return Boolean(process.env.PINTEREST_APP_ID && process.env.PINTEREST_APP_SECRET);
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/pinterest/callback`;
}

function basicAuth(): string {
  return Buffer.from(`${env("PINTEREST_APP_ID")}:${env("PINTEREST_APP_SECRET")}`).toString("base64");
}

// GET against the v5 API. Query arrays (columns) are comma-joined as Pinterest
// expects. 429 is marked retryable for withRetry's backoff.
async function pinGet<T>(path: string, accessToken: string, params?: Record<string, string>): Promise<T> {
  return withRetry(async () => {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    const res = await fetch(`${API}${path}${qs}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (res.status === 429) throw new Error("Pinterest rate limit (429)");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { message?: string; code?: number }).message ?? res.statusText;
      throw new Error(`Pinterest API error: ${detail} (${res.status})`);
    }
    return data as T;
  });
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number };

// POST /oauth/token — Basic-authed, form-encoded. Used for both the initial
// code exchange and refresh.
async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse & { message?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Pinterest token request failed: ${data.message ?? res.statusText} (${res.status})`);
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in ?? 30 * 24 * 60 * 60,
  };
}

export const pinterestOAuth: OAuthProvider = {
  id: "pinterest",
  authUrl(state) {
    const params = new URLSearchParams({
      client_id: env("PINTEREST_APP_ID"),
      redirect_uri: redirectUri(),
      response_type: "code",
      // Pinterest expects a COMMA-separated scope list (not the OAuth 2.0
      // space-delimited default) — space-separated is rejected as invalid_scope.
      scope: SCOPES.join(","),
      state,
    });
    return `https://www.pinterest.com/oauth/?${params.toString()}`;
  },
  exchangeCode(code) {
    return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  },
  async refresh(refreshToken) {
    const tokens = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
    // Pinterest often omits a fresh refresh_token on refresh — keep the existing
    // one so the connection stays refreshable.
    return { ...tokens, refresh_token: tokens.refresh_token ?? refreshToken };
  },
  async identity(accessToken) {
    try {
      const data = await pinGet<{ username?: string }>("/user_account", accessToken);
      return data.username ? `@${data.username}` : "Pinterest account";
    } catch {
      return "Pinterest account";
    }
  },

  // The user account's id; a username can be changed, so it isn't used.
  async subject(accessToken) {
    try {
      const data = await pinGet<{ id?: string }>("/user_account", accessToken);
      return data.id ? `pinterest:${data.id}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/pinterest/callback",
};

type Paginated<T> = { items?: T[]; bookmark?: string };

// Hard stop so a pathological account can't spin the sync forever.
const MAX_PAGES = 25;

// Follows Pinterest's `bookmark` cursor to the end of a collection. Without
// this, an advertiser with more than one page of ad accounts or campaigns
// silently loses everything after the first page.
async function paginate<T>(
  accessToken: string, path: string, params: Record<string, string>
): Promise<T[]> {
  const out: T[] = [];
  let bookmark: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const data: Paginated<T> = await pinGet<Paginated<T>>(path, accessToken, {
      ...params,
      ...(bookmark ? { bookmark } : {}),
    });
    out.push(...(data.items ?? []));
    if (!data.bookmark) break;
    bookmark = data.bookmark;
  }
  return out;
}

// Lists the ad accounts the authenticated user can access.
export async function listPinterestAdAccounts(accessToken: string): Promise<IntegrationAccount[]> {
  const items = await paginate<{ id: string; name?: string }>(accessToken, "/ad_accounts", { page_size: "100" });
  return items.map((a) => ({ id: a.id, name: a.name ?? a.id }));
}

// The ad account's reporting currency. Despite the SPEND_IN_DOLLAR column name,
// Pinterest reports spend in the ad account's own currency, so a EUR account
// must not be rendered with "$" in a client-facing report. Best-effort: falls
// back to USD.
async function adAccountCurrency(accessToken: string, adAccountId: string): Promise<string> {
  try {
    const data = await pinGet<{ currency?: string }>(`/ad_accounts/${encodeURIComponent(adAccountId)}`, accessToken);
    return data.currency || "USD";
  } catch {
    return "USD";
  }
}

// One analytics row is keyed by column name plus a DATE (for DAY granularity).
type AnalyticsRow = Record<string, string | number | undefined> & { DATE?: string; CAMPAIGN_ID?: string };

const num = (v: string | number | undefined): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};

// Pinterest analytics endpoints return a JSON array of rows; tolerate an object
// wrapper defensively so a minor response-shape change can't crash the sync.
function asRows(data: unknown): AnalyticsRow[] {
  if (Array.isArray(data)) return data as AnalyticsRow[];
  const wrapped = (data as { data?: unknown; rows?: unknown })?.data ?? (data as { rows?: unknown })?.rows;
  return Array.isArray(wrapped) ? (wrapped as AnalyticsRow[]) : [];
}

// Requests the core columns plus the optional revenue columns, falling back to
// core-only if Pinterest rejects the extras. Reports whether revenue applied so
// the caller knows if ROAS is real or simply unavailable.
async function accountAnalytics(
  accessToken: string, adAccountId: string, start: string, end: string
): Promise<{ rows: AnalyticsRow[]; revenueApplied: boolean }> {
  const path = `/ad_accounts/${encodeURIComponent(adAccountId)}/analytics`;
  const base = { start_date: start, end_date: end, granularity: "DAY" };

  try {
    const data = await pinGet<unknown>(path, accessToken, { ...base, columns: [...COLUMNS, ...REVENUE_COLUMNS].join(",") });
    return { rows: asRows(data), revenueApplied: true };
  } catch {
    const data = await pinGet<unknown>(path, accessToken, { ...base, columns: COLUMNS.join(",") });
    return { rows: asRows(data), revenueApplied: false };
  }
}

// Sums conversion value, converting Pinterest's micro-dollar units.
function sumRevenue(rows: AnalyticsRow[]): number {
  return rows.reduce((total, r) => total + num(r.TOTAL_CONVERSIONS_VALUE_IN_MICRO_DOLLAR) / MICRO, 0);
}

function toDay(r: AnalyticsRow): AdsDay {
  return {
    date: (r.DATE ?? "").slice(0, 10),
    spend: num(r.SPEND_IN_DOLLAR),
    impressions: num(r.IMPRESSION_1),
    clicks: num(r.CLICKTHROUGH_1),
    conversions: num(r.TOTAL_CONVERSIONS),
  };
}

// Best-effort top campaigns: list campaigns, then pull their aggregated metrics.
async function topCampaigns(accessToken: string, adAccountId: string, start: string, end: string): Promise<AdsReport["topCampaigns"]> {
  const items = await paginate<{ id: string; name?: string }>(
    accessToken, `/ad_accounts/${encodeURIComponent(adAccountId)}/campaigns`, { page_size: "100" }
  );
  if (!items.length) return [];
  const names = new Map(items.map((c) => [c.id, c.name ?? c.id]));

  const data = await pinGet<unknown>(`/ad_accounts/${encodeURIComponent(adAccountId)}/campaigns/analytics`, accessToken, {
    start_date: start,
    end_date: end,
    granularity: "TOTAL",
    columns: COLUMNS.join(","),
    campaign_ids: items.slice(0, 100).map((c) => c.id).join(","),
  });

  return asRows(data)
    .map((r) => {
      const impressions = num(r.IMPRESSION_1);
      const clicks = num(r.CLICKTHROUGH_1);
      return {
        name: names.get(String(r.CAMPAIGN_ID)) ?? String(r.CAMPAIGN_ID ?? "—"),
        spend: num(r.SPEND_IN_DOLLAR),
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : 0,
        conversions: num(r.TOTAL_CONVERSIONS),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);
}

// Fetches the normalized ads report for one ad account and period, plus the
// prior equal-length period for comparison. accountId = the Pinterest ad account id.
export async function fetchPinterestAdsReport(
  accessToken: string, adAccountId: string, periodDays: number
): Promise<AdsReport> {
  // Analytics dates are UTC: start_date/end_date are "Metric report … date
  // (UTC)" in Pinterest's v5 spec (checked 16 Oct 2026), and a start more than
  // 90 days back is rejected. The old zoneless window ended a day further back,
  // which pushed a 90-day start to 91 days ago. UTC days ending on the last
  // complete one keep it at exactly 90.
  const w = adWindows(periodDays, "UTC");
  const { since, until } = w;

  const [currency, daily, prev, campaigns] = await Promise.all([
    adAccountCurrency(accessToken, adAccountId),
    accountAnalytics(accessToken, adAccountId, since, until),
    accountAnalytics(accessToken, adAccountId, w.prevSince, w.prevUntil)
      .catch(() => ({ rows: [] as AnalyticsRow[], revenueApplied: false })),
    topCampaigns(accessToken, adAccountId, since, until).catch(() => [] as AdsReport["topCampaigns"]),
  ]);

  const dailyRows = daily.rows;
  const prevRows = prev.rows;

  const byDay = new Map<string, AdsDay>();
  for (const d of w.days) byDay.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  for (const r of dailyRows) {
    const day = byDay.get((r.DATE ?? "").slice(0, 10));
    if (!day) continue;
    day.spend += num(r.SPEND_IN_DOLLAR);
    day.impressions += num(r.IMPRESSION_1);
    day.clicks += num(r.CLICKTHROUGH_1);
    day.conversions += num(r.TOTAL_CONVERSIONS);
  }
  const byDate = Array.from(byDay.values());
  const previousTotals = prevRows.length
    ? adsTotals(prevRows.map(toDay), prev.revenueApplied ? sumRevenue(prevRows) : 0)
    : null;

  return {
    platform: "pinterest_ads",
    currency,
    totals: adsTotals(byDate, daily.revenueApplied ? sumRevenue(dailyRows) : 0),
    previousTotals,
    ...windowFields(w, previousTotals !== null),
    byDate,
    topCampaigns: campaigns,
  };
}
