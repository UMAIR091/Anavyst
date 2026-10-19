// TikTok Ads backend (TikTok for Business API v1.3). OAuth issues a long-lived
// token; TikTok exposes no refresh grant, so "refresh" re-validates the stored
// token and extends our local horizon (revocation surfaces as an auth error →
// reconnect prompt). TikTok's envelope is HTTP 200 + {code!=0} on errors, so
// failures are normalized here into messages the shared classifier can read.
// Fills the normalized AdsReport rendered by the shared AdsAnalytics block.
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import {
  adWindows, adsTotals, windowFields, withRetry,
  type AdsCampaign, type AdsDay, type AdsReport, type AdsVideoTotals,
} from "../metrics";

const API = "https://business-api.tiktok.com/open_api/v1.3";
const ONE_YEAR = 365 * 24 * 60 * 60;
// TikTok caps report page_size at 1000; 200 keeps payloads small while making
// the common case (a period or campaign list under 200 rows) a single request.
const PAGE_SIZE = 200;
// Hard stop so a pathological account can't spin the sync forever.
const MAX_PAGES = 50;

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_APP_ID && process.env.TIKTOK_APP_SECRET);
}

type PageInfo = { page?: number; page_size?: number; total_number?: number; total_page?: number };
type Envelope<T> = { code?: number; message?: string; data?: T };

// TikTok returns HTTP 200 with a non-zero `code` for every failure, including
// auth and rate limiting. Left raw, those messages are invisible to
// classifyIntegrationError (whose signals are Google/Meta shaped), so a revoked
// token would be retried forever instead of prompting a reconnect. Normalize
// here: auth failures carry "please reconnect", throttling carries "rate limit",
// and 5xxxx server codes carry "temporarily unavailable" — all of which the
// shared classifier and withRetry already understand.
function normalizeTiktokError(code: number | undefined, message: string): Error {
  const raw = message || "Unknown TikTok API error";
  const c = code ?? 0;

  // Auth / permission: 40001 & 40100-40199 cover invalid, expired and revoked
  // tokens as well as app-permission failures. Also match on wording, since
  // TikTok has changed codes between API versions.
  const authByCode = c === 40001 || (c >= 40100 && c <= 40199);
  const authByText = /access token|not authorized|no permission|invalid.*token|token.*invalid|expired|revoked/i.test(raw);
  if (authByCode || authByText) {
    return new Error(`TikTok authorization failed: ${raw} (${c}). Please reconnect.`);
  }

  // Throttling. TikTok signals this with wording more reliably than with a
  // stable code, so match both.
  if (/rate limit|qps|too many requests|frequency/i.test(raw) || c === 40016) {
    return new Error(`TikTok rate limit reached: ${raw} (${c})`);
  }

  // 5xxxx = TikTok-side failure. Mark transient so the sync retries later
  // rather than flagging the user's connection as broken.
  if (c >= 50000) {
    return new Error(`TikTok service temporarily unavailable: ${raw} (${c})`);
  }

  return new Error(`TikTok API error: ${raw} (${c})`);
}

async function ttRequest<T>(
  path: string,
  accessToken: string | null,
  params?: Record<string, string>
): Promise<{ data: T; pageInfo: PageInfo | null }> {
  return withRetry(async () => {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : "";
    const res = await fetch(`${API}${path}${qs}`, {
      headers: accessToken ? { "Access-Token": accessToken } : {},
    });

    // Transport-level throttling/outage (as opposed to the JSON envelope).
    if (res.status === 429) throw new Error("TikTok rate limit reached (429)");
    if (res.status >= 500) throw new Error(`TikTok service temporarily unavailable (${res.status})`);

    const body = (await res.json().catch(() => ({}))) as Envelope<T> & { data?: { page_info?: PageInfo } };
    if (!res.ok) throw normalizeTiktokError(res.status, res.statusText);
    if (body.code !== undefined && body.code !== 0) {
      throw normalizeTiktokError(body.code, body.message ?? "");
    }
    return { data: body.data as T, pageInfo: body.data?.page_info ?? null };
  });
}

export const tiktokOAuth: OAuthProvider = {
  id: "tiktok",
  authUrl(state) {
    const params = new URLSearchParams({
      app_id: env("TIKTOK_APP_ID"),
      state,
      redirect_uri: `${env("NEXT_PUBLIC_APP_URL")}/api/tiktok/callback`,
    });
    return `https://business-api.tiktok.com/portal/auth?${params.toString()}`;
  },

  async exchangeCode(code): Promise<TokenSet> {
    const res = await fetch(`${API}/oauth2/access_token/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: env("TIKTOK_APP_ID"), secret: env("TIKTOK_APP_SECRET"), auth_code: code }),
    });
    const body = (await res.json().catch(() => ({}))) as Envelope<{ access_token?: string; expires_in?: number }>;
    if (!res.ok || body.code !== 0 || !body.data?.access_token) {
      throw normalizeTiktokError(body.code ?? res.status, body.message ?? `token exchange failed (${res.status})`);
    }
    // Prefer TikTok's own expiry when it sends one rather than assuming a year,
    // so a shorter-lived token is refreshed on time instead of being trusted
    // until it silently fails mid-sync.
    const expiresIn = Number(body.data.expires_in) > 0 ? Number(body.data.expires_in) : ONE_YEAR;
    return { access_token: body.data.access_token, refresh_token: body.data.access_token, expires_in: expiresIn };
  },

  // TikTok has no refresh grant. Re-validate the stored token against a cheap
  // authenticated endpoint: if it still works, extend the local horizon; if it
  // was revoked, ttRequest throws a "please reconnect" error and the sync
  // pipeline flips the source to `revoked` and prompts the user.
  async refresh(token): Promise<TokenSet> {
    await ttRequest<{ list?: unknown[] }>("/oauth2/advertiser/get/", token, {
      app_id: env("TIKTOK_APP_ID"),
      secret: env("TIKTOK_APP_SECRET"),
    });
    return { access_token: token, refresh_token: token, expires_in: ONE_YEAR };
  },

  async identity(accessToken) {
    try {
      const { data } = await ttRequest<{ display_name?: string; email?: string }>("/user/info/", accessToken);
      return data.email ?? data.display_name ?? "TikTok account";
    } catch {
      return "TikTok account";
    }
  },

  async subject(accessToken) {
    try {
      const { data } = await ttRequest<{ core_user_id?: string }>("/user/info/", accessToken);
      return data.core_user_id ? `tiktok:${data.core_user_id}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/tiktok/callback",
};

export async function listTiktokAdvertisers(accessToken: string): Promise<IntegrationAccount[]> {
  const { data } = await ttRequest<{ list?: { advertiser_id: string; advertiser_name?: string }[] }>(
    "/oauth2/advertiser/get/", accessToken,
    { app_id: env("TIKTOK_APP_ID"), secret: env("TIKTOK_APP_SECRET") }
  );
  return (data.list ?? []).map((a) => ({ id: a.advertiser_id, name: a.advertiser_name ?? a.advertiser_id }));
}

// The advertiser's reporting currency. Spend in the report payload is expressed
// in it, so reports must not assume USD — a GBP advertiser showing "$" would be
// wrong in a client-facing document. Best-effort: falls back to USD.
// The advertiser's currency and time zone. TikTok buckets `stat_time_day` by
// the advertiser's own calendar, so the report window is computed in it.
async function advertiserDetail(accessToken: string, advertiserId: string): Promise<{ currency: string; timeZone: string | null }> {
  try {
    const { data } = await ttRequest<{ list?: { currency?: string; timezone?: string }[] }>("/advertiser/info/", accessToken, {
      advertiser_ids: JSON.stringify([advertiserId]),
      fields: JSON.stringify(["currency", "timezone", "advertiser_id", "advertiser_name"]),
    });
    return { currency: data.list?.[0]?.currency || "", timeZone: data.list?.[0]?.timezone || null };
  } catch {
    // Unknown, not "probably dollars" — the UI omits the symbol instead — and
    // an unknown zone makes adWindows end on a day that has ended everywhere.
    return { currency: "", timeZone: null };
  }
}

type ReportRow = {
  dimensions?: Record<string, string | undefined>;
  metrics?: Record<string, string | number | undefined>;
};

type DataLevel = "AUCTION_ADVERTISER" | "AUCTION_CAMPAIGN" | "AUCTION_ADGROUP" | "AUCTION_AD";

// Pages through /report/integrated/get/ until TikTok says there are no more.
// Previously only the first page was read, so an advertiser with more campaigns
// (or a longer period) than one page silently lost rows.
async function report(
  accessToken: string, advertiserId: string, sinceIso: string, untilIso: string,
  dataLevel: DataLevel, dimensions: string[], metrics: string[]
): Promise<ReportRow[]> {
  const out: ReportRow[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const { data, pageInfo } = await ttRequest<{ list?: ReportRow[]; page_info?: PageInfo }>(
      "/report/integrated/get/", accessToken, {
        advertiser_id: advertiserId,
        report_type: "BASIC",
        data_level: dataLevel,
        dimensions: JSON.stringify(dimensions),
        metrics: JSON.stringify(metrics),
        start_date: sinceIso,
        end_date: untilIso,
        page: String(page),
        page_size: String(PAGE_SIZE),
      }
    );

    const rows = data.list ?? [];
    out.push(...rows);

    const totalPages = pageInfo?.total_page ?? 1;
    // Stop on the reported last page, or when a short page proves exhaustion —
    // belt and braces, since page_info has been inconsistent across accounts.
    if (page >= totalPages || rows.length < PAGE_SIZE) break;
    page++;
  }

  return out;
}

const num = (v: string | number | undefined) =>
  v !== undefined && v !== null && v !== "-" && v !== "" ? Number(v) || 0 : 0;

// Metrics every TikTok ad account reports.
const CORE_METRICS = ["spend", "impressions", "clicks", "conversion"];
// Revenue/value metrics. Availability depends on the advertiser's conversion
// setup, and TikTok rejects the whole request when a metric isn't valid for the
// account — so these are requested optionally and dropped on failure rather
// than being allowed to break the core report.
const REVENUE_METRICS = ["total_complete_payment_rate", "complete_payment", "value_per_complete_payment"];
// Video engagement, same optional treatment.
const VIDEO_METRICS = [
  "video_play_actions", "video_watched_2s", "video_watched_6s",
  "video_views_p100", "video_views_p25",
];

// Runs a report with the optional metric set appended, falling back to the core
// set if TikTok rejects any of the extras. Returns which set actually applied so
// callers know whether the optional fields are populated.
async function reportWithOptional(
  accessToken: string, advertiserId: string, since: string, until: string,
  dataLevel: DataLevel, dimensions: string[], optional: string[]
): Promise<{ rows: ReportRow[]; optionalApplied: boolean }> {
  if (optional.length) {
    try {
      const rows = await report(accessToken, advertiserId, since, until, dataLevel, dimensions, [...CORE_METRICS, ...optional]);
      return { rows, optionalApplied: true };
    } catch {
      // Fall through to the core-only request below.
    }
  }
  const rows = await report(accessToken, advertiserId, since, until, dataLevel, dimensions, CORE_METRICS);
  return { rows, optionalApplied: false };
}

function sumRevenue(rows: ReportRow[]): number {
  // TikTok expresses purchase value per row; sum whichever field the account
  // actually returned.
  return rows.reduce((s, r) => {
    const m = r.metrics ?? {};
    const perPayment = num(m.value_per_complete_payment) * num(m.complete_payment);
    return s + (perPayment > 0 ? perPayment : num(m.total_complete_payment_rate));
  }, 0);
}

function videoTotals(rows: ReportRow[]): AdsVideoTotals | undefined {
  const views = rows.reduce((s, r) => s + num(r.metrics?.video_play_actions), 0);
  const completions = rows.reduce((s, r) => s + num(r.metrics?.video_views_p100), 0);
  const watched2s = rows.reduce((s, r) => s + num(r.metrics?.video_watched_2s), 0);
  const watched6s = rows.reduce((s, r) => s + num(r.metrics?.video_watched_6s), 0);
  if (views === 0 && completions === 0 && watched2s === 0) return undefined;
  return {
    views, watched2s, watched6s, completions,
    completionRate: views > 0 ? completions / views : 0,
  };
}

// Maps a breakdown report (campaign / ad group / ad) into the shared shape.
function toBreakdown(rows: ReportRow[], nameKey: string, idKey: string): AdsCampaign[] {
  return rows
    .map((r) => {
      const impressions = num(r.metrics?.impressions);
      const clicks = num(r.metrics?.clicks);
      return {
        name: String(r.metrics?.[nameKey] ?? r.dimensions?.[idKey] ?? "—"),
        spend: num(r.metrics?.spend),
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : 0,
        conversions: num(r.metrics?.conversion),
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);
}

// Fetches the normalized ads report for one advertiser and period, plus the
// prior equal-length period for comparison.
export async function fetchTiktokAdsReport(
  accessToken: string, advertiserId: string, periodDays: number
): Promise<AdsReport> {
  const { currency, timeZone } = await advertiserDetail(accessToken, advertiserId);
  const w = adWindows(periodDays, timeZone);
  const { since, until } = w;

  const [daily, prev, campaigns, adGroups, ads] = await Promise.all([
    reportWithOptional(accessToken, advertiserId, since, until, "AUCTION_ADVERTISER", ["stat_time_day"], [...REVENUE_METRICS, ...VIDEO_METRICS]),
    reportWithOptional(accessToken, advertiserId, w.prevSince, w.prevUntil, "AUCTION_ADVERTISER", ["stat_time_day"], REVENUE_METRICS)
      .catch(() => ({ rows: [] as ReportRow[], optionalApplied: false })),
    report(accessToken, advertiserId, since, until, "AUCTION_CAMPAIGN", ["campaign_id"], [...CORE_METRICS, "campaign_name"])
      .catch(() => [] as ReportRow[]),
    report(accessToken, advertiserId, since, until, "AUCTION_ADGROUP", ["adgroup_id"], [...CORE_METRICS, "adgroup_name"])
      .catch(() => [] as ReportRow[]),
    report(accessToken, advertiserId, since, until, "AUCTION_AD", ["ad_id"], [...CORE_METRICS, "ad_name"])
      .catch(() => [] as ReportRow[]),
  ]);

  // Zero-fill the period so charts don't skip days TikTok omits.
  const byDay = new Map<string, AdsDay>();
  for (const d of w.days) byDay.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  for (const r of daily.rows) {
    const row = byDay.get((r.dimensions?.stat_time_day ?? "").slice(0, 10));
    if (!row) continue;
    row.spend += num(r.metrics?.spend);
    row.impressions += num(r.metrics?.impressions);
    row.clicks += num(r.metrics?.clicks);
    row.conversions += num(r.metrics?.conversion);
  }
  const byDate = Array.from(byDay.values());

  // Previous period: only the aggregate matters, so map each row to a day-shaped
  // record carrying its own date rather than fabricating one.
  let previousTotals: AdsReport["previousTotals"] = null;
  if (prev.rows.length) {
    const prevDays: AdsDay[] = prev.rows.map((r) => ({
      date: (r.dimensions?.stat_time_day ?? "").slice(0, 10),
      spend: num(r.metrics?.spend),
      impressions: num(r.metrics?.impressions),
      clicks: num(r.metrics?.clicks),
      conversions: num(r.metrics?.conversion),
    }));
    previousTotals = adsTotals(prevDays, prev.optionalApplied ? sumRevenue(prev.rows) : 0);
  }

  const revenue = daily.optionalApplied ? sumRevenue(daily.rows) : 0;
  const video = daily.optionalApplied ? videoTotals(daily.rows) : undefined;

  return {
    platform: "tiktok_ads",
    currency,
    totals: adsTotals(byDate, revenue),
    previousTotals,
    ...windowFields(w, previousTotals !== null),
    byDate,
    topCampaigns: toBreakdown(campaigns, "campaign_name", "campaign_id"),
    topAdGroups: toBreakdown(adGroups, "adgroup_name", "adgroup_id"),
    topAds: toBreakdown(ads, "ad_name", "ad_id"),
    video,
  };
}
