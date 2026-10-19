// LinkedIn Ads backend. OAuth 2.0 with rotating refresh tokens (available to
// apps approved for the Marketing Developer Platform); Rest.li 2.0 protocol
// with versioned headers. Fills the normalized AdsReport so LinkedIn renders
// in the same dashboards/reports as every other ad platform.
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import { adWindows, adsTotals, windowFields, withRetry, type AdsDay, type AdsReport } from "../metrics";

const API = "https://api.linkedin.com";
// LinkedIn ships a Marketing API version every month and supports each for
// about a year, after which calls pinned to it fail. 202506 was sunset in 2026
// (supported versions were 202510–202609 as of September 2026). The breaking
// changes since then only touch campaign/campaign-group creation, which
// Anavyst never does. Revisit before September 2027.
const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || "202609";
// r_ads reads accounts/campaigns; r_ads_reporting reads analytics;
// openid+profile let identity() label the connection.
const SCOPES = ["r_ads", "r_ads_reporting", "openid", "profile"];

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function linkedinConfigured(): boolean {
  return Boolean(process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/linkedin/callback`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`LinkedIn token request failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in ?? 3600 };
}

export const linkedinOAuth: OAuthProvider = {
  id: "linkedin",
  authUrl(state) {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: env("LINKEDIN_CLIENT_ID"),
      redirect_uri: redirectUri(),
      state,
      scope: SCOPES.join(" "),
    });
    return `https://www.linkedin.com/oauth/v2/authorization?${params.toString()}`;
  },
  exchangeCode: (code) =>
    tokenRequest({
      grant_type: "authorization_code",
      code,
      client_id: env("LINKEDIN_CLIENT_ID"),
      client_secret: env("LINKEDIN_CLIENT_SECRET"),
      redirect_uri: redirectUri(),
    }),
  refresh: (refreshToken) =>
    tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: env("LINKEDIN_CLIENT_ID"),
      client_secret: env("LINKEDIN_CLIENT_SECRET"),
    }),
  async identity(accessToken) {
    try {
      const res = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await res.json().catch(() => ({}));
      return data.email ?? data.name ?? "LinkedIn account";
    } catch {
      return "LinkedIn account";
    }
  },

  // OpenID Connect `sub`: the member's permanent id.
  async subject(accessToken) {
    try {
      const res = await fetch(`${API}/v2/userinfo`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return typeof data.sub === "string" && data.sub ? `linkedin:${data.sub}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/linkedin/callback",
};

// Rest.li 2.0 query strings use unencoded parentheses/colons — build manually.
async function liGet<T>(pathAndQuery: string, accessToken: string): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`${API}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "LinkedIn-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { message?: string }).message ?? `${res.status} ${res.statusText}`;
      throw new Error(`LinkedIn API error: ${detail}`);
    }
    return data as T;
  });
}

export async function listLinkedinAdAccounts(accessToken: string): Promise<IntegrationAccount[]> {
  const data = await liGet<{ elements?: { id: number; name?: string }[] }>(
    "/rest/adAccounts?q=search&pageSize=100", accessToken
  );
  return (data.elements ?? []).map((a) => ({ id: String(a.id), name: a.name ?? String(a.id) }));
}

type AnalyticsRow = {
  costInLocalCurrency?: string;
  impressions?: number;
  clicks?: number;
  externalWebsiteConversions?: number;
  dateRange?: { start?: { year: number; month: number; day: number } };
  pivotValues?: string[];
};

const liDate = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `(year:${y},month:${m},day:${d})`;
};

async function analytics(
  accessToken: string, accountId: string, sinceIso: string, untilIso: string,
  pivot: "ACCOUNT" | "CAMPAIGN", granularity: "DAILY" | "ALL"
): Promise<AnalyticsRow[]> {
  const query =
    `/rest/adAnalytics?q=analytics&pivot=${pivot}&timeGranularity=${granularity}` +
    `&dateRange=(start:${liDate(sinceIso)},end:${liDate(untilIso)})` +
    `&accounts=List(urn%3Ali%3AsponsoredAccount%3A${accountId})` +
    `&fields=costInLocalCurrency,impressions,clicks,externalWebsiteConversions,dateRange${pivot === "CAMPAIGN" ? ",pivotValues" : ""}`;
  const data = await liGet<{ elements?: AnalyticsRow[] }>(query, accessToken);
  return data.elements ?? [];
}

const rowKey = (r: AnalyticsRow) => {
  const s = r.dateRange?.start;
  return s ? `${s.year}-${String(s.month).padStart(2, "0")}-${String(s.day).padStart(2, "0")}` : "";
};

// Fetches the normalized ads report for one ad account and period, plus the
// prior equal-length period for comparison.
export async function fetchLinkedinAdsReport(
  accessToken: string, accountId: string, periodDays: number
): Promise<AdsReport> {
  // adAnalytics buckets days in UTC, whatever the ad account's own time zone
  // ("dateRange … Date is specified in UTC", Ads Reporting schema, checked
  // 16 Oct 2026). So the window is UTC days ending on the last complete one.
  // It used to pass no zone, which ended a day earlier than necessary.
  const w = adWindows(periodDays, "UTC");
  const { since, until } = w;

  const [account, dailyRows, prevRows, campaignRows, campaignNames] = await Promise.all([
    liGet<{ currency?: string }>(`/rest/adAccounts/${accountId}`, accessToken).catch(() => ({} as { currency?: string })),
    analytics(accessToken, accountId, since, until, "ACCOUNT", "DAILY"),
    analytics(accessToken, accountId, w.prevSince, w.prevUntil, "ACCOUNT", "ALL").catch(() => [] as AnalyticsRow[]),
    analytics(accessToken, accountId, since, until, "CAMPAIGN", "ALL").catch(() => [] as AnalyticsRow[]),
    liGet<{ elements?: { id: number; name?: string }[] }>(
      `/rest/adAccounts/${accountId}/adCampaigns?q=search&pageSize=100`, accessToken
    ).then((d) => new Map((d.elements ?? []).map((c) => [String(c.id), c.name ?? String(c.id)])))
      .catch(() => new Map<string, string>()),
  ]);

  const byDay = new Map<string, AdsDay>();
  for (const d of w.days) byDay.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  for (const r of dailyRows) {
    const row = byDay.get(rowKey(r));
    if (!row) continue;
    row.spend += Number(r.costInLocalCurrency ?? 0);
    row.impressions += r.impressions ?? 0;
    row.clicks += r.clicks ?? 0;
    row.conversions += r.externalWebsiteConversions ?? 0;
  }
  const byDate = Array.from(byDay.values());

  let previousTotals: AdsReport["previousTotals"] = null;
  if (prevRows.length) {
    const prev: AdsDay[] = prevRows.map((r) => ({
      date: since,
      spend: Number(r.costInLocalCurrency ?? 0),
      impressions: r.impressions ?? 0,
      clicks: r.clicks ?? 0,
      conversions: r.externalWebsiteConversions ?? 0,
    }));
    previousTotals = adsTotals(prev);
  }

  const topCampaigns = campaignRows
    .map((r) => {
      const urn = r.pivotValues?.[0] ?? "";
      const id = urn.split(":").pop() ?? "";
      const impressions = r.impressions ?? 0;
      const clicks = r.clicks ?? 0;
      return {
        name: campaignNames.get(id) ?? (id || "—"),
        spend: Number(r.costInLocalCurrency ?? 0),
        impressions,
        clicks,
        ctr: impressions > 0 ? clicks / impressions : 0,
        conversions: r.externalWebsiteConversions ?? 0,
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  return {
    platform: "linkedin_ads",
    currency: account.currency ?? "",
    totals: adsTotals(byDate),
    previousTotals,
    ...windowFields(w, previousTotals !== null),
    byDate,
    topCampaigns,
  };
}
