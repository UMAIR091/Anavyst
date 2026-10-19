// Pure HTTP helpers for Google OAuth + Search Console. No DB access here.

import { lastCompleteDay } from "@/lib/integrations/metrics";

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE = "https://oauth2.googleapis.com/revoke";
const USERINFO = "https://www.googleapis.com/oauth2/v2/userinfo";
const GSC = "https://www.googleapis.com/webmasters/v3";
const GA4_ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_DATA = "https://analyticsdata.googleapis.com/v1beta";

// Request Search Console now + Analytics (for Phase 6) so users connect once.
const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
];

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

// Optional scope override lets scope-specific OAuth backends (Google Ads,
// Business Profile, Sheets) reuse this flow with their own consent scopes.
//
// Each connection asks for ITS OWN scopes only. `include_granted_scopes` used
// to be set, which folds every scope the account ever granted Anavyst into
// each new request — so once someone had connected YouTube (scope still under
// Google review) or Sheets, connecting even Search Console or Google Ads
// showed "Google hasn't verified this app", because the request now carried
// the unverified scope too. Every token is used only for its own product, so
// nothing needs the accumulated scopes.
export function getAuthUrl(state: string, scopes: string[] = SCOPES): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: env("GOOGLE_OAUTH_REDIRECT_URI"),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

export async function exchangeCode(code: string): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      redirect_uri: env("GOOGLE_OAUTH_REDIRECT_URI"),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json();
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env("GOOGLE_CLIENT_ID"),
      client_secret: env("GOOGLE_CLIENT_SECRET"),
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json();
}

// Best-effort revocation of a Google OAuth grant. Revoking the refresh token
// invalidates the whole grant (access + refresh). Google returns 200 on success
// and 400 if the token is already invalid — both mean the grant is gone, so the
// caller treats any thrown error as non-fatal.
export async function revokeGoogleToken(token: string): Promise<void> {
  const res = await fetch(OAUTH_REVOKE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok) throw new Error(`Google token revoke failed: ${await res.text()}`);
}

export async function getGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return "google account";
  const data = await res.json();
  return data.email ?? "google account";
}

// The Google account's permanent id (userinfo v2 `id`, the OpenID `sub`):
// unlike the email, it never changes and is never reused.
export async function getGoogleSubject(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.id === "string" && data.id ? `google:${data.id}` : null;
  } catch {
    return null;
  }
}

export async function listGscSites(accessToken: string): Promise<string[]> {
  const res = await fetch(`${GSC}/sites`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Listing Search Console sites failed: ${await res.text()}`);
  const data = await res.json();
  return (data.siteEntry ?? [])
    .filter((s: { permissionLevel?: string }) => s.permissionLevel !== "siteUnverifiedUser")
    .map((s: { siteUrl: string }) => s.siteUrl);
}

export type GscRow = { key: string; clicks: number; impressions: number; ctr: number; position: number };
export type GscDay = { date: string; clicks: number; impressions: number; ctr: number; position: number };

export type GscReport = {
  totals: { clicks: number; impressions: number; ctr: number; position: number };
  topQueries: GscRow[];
  topPages: GscRow[];
  topCountries: GscRow[];
  topDevices: GscRow[];
  byDate: GscDay[];
};

// Search Console returns ISO 3166-1 alpha-3 country codes (lowercase, e.g. "usa").
// Map the most common ones to readable names; fall back to the upper-cased code.
const COUNTRY_NAMES: Record<string, string> = {
  usa: "United States", gbr: "United Kingdom", can: "Canada", aus: "Australia",
  ind: "India", deu: "Germany", fra: "France", esp: "Spain", ita: "Italy",
  nld: "Netherlands", bra: "Brazil", mex: "Mexico", jpn: "Japan", chn: "China",
  pak: "Pakistan", are: "United Arab Emirates", sau: "Saudi Arabia", zaf: "South Africa",
  irl: "Ireland", nzl: "New Zealand", sgp: "Singapore", swe: "Sweden", che: "Switzerland",
  pol: "Poland", tur: "Turkey", idn: "Indonesia", phl: "Philippines", nga: "Nigeria",
  rus: "Russia", kor: "South Korea", bel: "Belgium", aut: "Austria", dnk: "Denmark",
  nor: "Norway", fin: "Finland", prt: "Portugal", grc: "Greece", egy: "Egypt",
};

function countryName(code: string): string {
  return COUNTRY_NAMES[code.toLowerCase()] ?? code.toUpperCase();
}

// Device dimension keys come back upper-cased (DESKTOP / MOBILE / TABLET).
function deviceName(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1).toLowerCase();
}

async function gscQuery(accessToken: string, siteUrl: string, body: object) {
  const res = await fetch(`${GSC}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Search Console query failed: ${await res.text()}`);
  return res.json();
}

// Lightweight single-query fetch of period totals — used to compare the current
// reporting period against the previous one without pulling full dimension data.
export async function fetchGscTotals(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GscReport["totals"]> {
  const res = await gscQuery(accessToken, siteUrl, { startDate, endDate });
  const t = res.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position };
}

export type GscMover = { key: string; clicks: number; prevClicks: number; changePct: number; position: number };
export type GscOpportunity = { key: string; clicks: number; impressions: number; position: number };
export type GscMovers = { winners: GscMover[]; decliners: GscMover[]; opportunities: GscOpportunity[] };

// Compares query performance between the current and previous period to surface
// winning keywords (biggest growth), declining keywords (biggest drop), and
// growth opportunities (ranking just off page one with real impression volume).
export async function fetchGscQueryMovers(
  accessToken: string,
  siteUrl: string,
  curStart: string,
  curEnd: string,
  prevStart: string,
  prevEnd: string
): Promise<GscMovers> {
  const [curRes, prevRes] = await Promise.all([
    gscQuery(accessToken, siteUrl, { startDate: curStart, endDate: curEnd, dimensions: ["query"], rowLimit: 100 }),
    gscQuery(accessToken, siteUrl, { startDate: prevStart, endDate: prevEnd, dimensions: ["query"], rowLimit: 100 }),
  ]);

  type Row = { keys: string[]; clicks: number; impressions: number; ctr: number; position: number };
  const cur = (curRes.rows ?? []) as Row[];
  const prevMap = new Map<string, Row>();
  for (const r of (prevRes.rows ?? []) as Row[]) prevMap.set(r.keys[0], r);

  const movers: GscMover[] = cur.map((r) => {
    const prevClicks = prevMap.get(r.keys[0])?.clicks ?? 0;
    const changePct = prevClicks > 0 ? ((r.clicks - prevClicks) / prevClicks) * 100 : (r.clicks > 0 ? 100 : 0);
    return { key: r.keys[0], clicks: r.clicks, prevClicks, changePct, position: r.position };
  });

  const winners = movers
    .filter((m) => m.clicks >= 3 && m.changePct > 5)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 5);

  const decliners = movers
    .filter((m) => m.prevClicks >= 3 && m.changePct < -5)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 5);

  // Near page one (positions ~8–20) with the most impressions = quickest wins.
  const opportunities = cur
    .filter((r) => r.position >= 8 && r.position <= 20 && r.impressions >= 20)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 5)
    .map((r) => ({ key: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }));

  return { winners, decliners, opportunities };
}

export async function fetchGscReport(
  accessToken: string,
  siteUrl: string,
  startDate: string,
  endDate: string
): Promise<GscReport> {
  const [totalsRes, queriesRes, pagesRes, countriesRes, devicesRes, dateRes] = await Promise.all([
    gscQuery(accessToken, siteUrl, { startDate, endDate }),
    gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ["query"], rowLimit: 10 }),
    gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ["page"], rowLimit: 10 }),
    gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ["country"], rowLimit: 10 }),
    gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ["device"], rowLimit: 10 }),
    gscQuery(accessToken, siteUrl, { startDate, endDate, dimensions: ["date"], rowLimit: 1000 }),
  ]);

  const t = totalsRes.rows?.[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const mapRows = (
    r: { rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[] },
    label: (k: string) => string = (k) => k
  ) =>
    (r.rows ?? []).map((row) => ({
      key: label(row.keys[0]),
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));

  return {
    totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
    topQueries: mapRows(queriesRes),
    topPages: mapRows(pagesRes),
    topCountries: mapRows(countriesRes, countryName),
    topDevices: mapRows(devicesRes, deviceName),
    byDate: mapRows(dateRes).map((r) => ({ date: r.key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
  };
}

// A snapshot enriched with everything needed to render a full period-over-period
// report offline: the current-period report plus the previous period's totals
// and query movers. Computed at sync time and cached, so report generation never
// has to call Google.
export type GscReportFull = GscReport & {
  previousTotals: GscReport["totals"] | null;
  movers: GscMovers | null;
  /**
   * The inclusive dates the totals were requested for, and the comparison
   * window. Optional: snapshots synced before these were recorded have
   * neither, and readers infer the window from the sync time instead.
   */
  window?: ReportWindow;
  previousWindow?: ReportWindow | null;
};

export type ReportWindow = { start: string; end: string };

// UTC calendar days. The old version took the LOCAL date and printed it in
// UTC, which on a machine east of UTC gave yesterday's date before dawn.
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

// Fetches the report for the last `periodDays` plus the equal-length window
// immediately before it, so period-over-period deltas and winning/declining
// keywords are baked into the cached snapshot. The comparison parts degrade
// gracefully: if they fail, the report still has current-period data.
//
// WINDOW: exactly `periodDays` days ending 3 days ago. This used to run from
// periodDays+2 to 2 days ago — periodDays+1 days — against a previous window of
// periodDays. Search Console only returns FINAL data, which at the 06:00 UTC
// sync reaches 3 days back, so the extra day was usually empty and the totals
// happened to cover 28 days; whenever it had landed, the current period had one
// day more than the period it was compared with and every delta read ~3.6%
// high. Ending on the last final day makes both windows the same length by
// construction.
/** Search Console's current and comparison windows: equal length, contiguous. */
export function gscWindows(periodDays: number) {
  return {
    start: isoDaysAgo(periodDays + 2),
    end: isoDaysAgo(3),
    prevStart: isoDaysAgo(periodDays * 2 + 2),
    prevEnd: isoDaysAgo(periodDays + 3),
  };
}

export async function fetchGscReportWithComparison(
  accessToken: string,
  siteUrl: string,
  periodDays: number
): Promise<GscReportFull> {
  const { start, end, prevStart, prevEnd } = gscWindows(periodDays);

  const [report, previousTotals, movers] = await Promise.all([
    fetchGscReport(accessToken, siteUrl, start, end),
    fetchGscTotals(accessToken, siteUrl, prevStart, prevEnd).catch(() => null),
    fetchGscQueryMovers(accessToken, siteUrl, start, end, prevStart, prevEnd).catch(() => null),
  ]);

  return {
    ...report,
    previousTotals,
    movers,
    window: { start, end },
    previousWindow: previousTotals ? { start: prevStart, end: prevEnd } : null,
  };
}

// ─── Google Analytics 4 ──────────────────────────────────────────────────────
// Mirrors the Search Console helpers above: pure HTTP, no DB access. Uses the
// same OAuth tokens (the analytics.readonly scope is requested up front).

export type Ga4Property = { id: string; name: string; account?: string };

// Lists every GA4 property the authenticated user can access, via the Admin API.
export async function listGa4Properties(accessToken: string): Promise<Ga4Property[]> {
  const res = await fetch(`${GA4_ADMIN}/accountSummaries?pageSize=200`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Listing GA4 properties failed: ${await res.text()}`);
  const data = await res.json();
  const out: Ga4Property[] = [];
  for (const acc of data.accountSummaries ?? []) {
    for (const p of acc.propertySummaries ?? []) {
      const id = String(p.property ?? "").replace("properties/", "");
      if (id) out.push({ id, name: p.displayName ?? id, account: acc.displayName });
    }
  }
  return out;
}

export type Ga4Totals = {
  users: number;
  newUsers: number;
  sessions: number;
  engagedSessions: number;
  engagementRate: number; // 0..1
  avgEngagementTime: number; // seconds per user
  views: number;
  conversions: number;
  totalRevenue: number;
};
export type Ga4Day = { date: string; users: number; sessions: number; views: number };
export type Ga4Dim = { key: string; sessions: number; users: number };

export type Ga4Report = {
  totals: Ga4Totals;
  byDate: Ga4Day[];
  topLandingPages: Ga4Dim[];
  trafficSources: Ga4Dim[];
  devices: Ga4Dim[];
  countries: Ga4Dim[];
};
export type Ga4ReportFull = Ga4Report & {
  previousTotals: Ga4Totals | null;
  /** Inclusive dates requested; absent on snapshots synced before it existed. */
  window?: ReportWindow;
  previousWindow?: ReportWindow | null;
  /**
   * Totals that could NOT be measured for this window. A report rebuilt from
   * daily rows has no unique-user, engagement, conversion or revenue figures,
   * and those fields hold 0 only because the type is numeric. Every reader must
   * treat a listed metric as "not available", never as a measured zero.
   */
  unavailableMetrics?: (keyof Ga4Totals)[];
};

type Ga4Row = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] };

async function runGa4Report(accessToken: string, propertyId: string, body: object): Promise<{ rows?: Ga4Row[] }> {
  const res = await fetch(`${GA4_DATA}/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GA4 report failed: ${await res.text()}`);
  return res.json();
}

// GA4 returns dates as "YYYYMMDD".
function ga4Date(v: string): string {
  return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}

const TOTALS_METRICS = [
  "totalUsers", "newUsers", "sessions", "engagedSessions", "engagementRate",
  "userEngagementDuration", "screenPageViews", "conversions", "totalRevenue",
];

function parseGa4Totals(rows?: Ga4Row[]): Ga4Totals {
  const m = (i: number) => Number(rows?.[0]?.metricValues?.[i]?.value ?? 0);
  const users = m(0);
  const engagementDuration = m(5);
  return {
    users,
    newUsers: m(1),
    sessions: m(2),
    engagedSessions: m(3),
    engagementRate: m(4),
    avgEngagementTime: users > 0 ? engagementDuration / users : 0,
    views: m(6),
    conversions: m(7),
    totalRevenue: m(8),
  };
}

const dimRows = (rows?: Ga4Row[]): Ga4Dim[] =>
  (rows ?? []).map((r) => ({
    key: r.dimensionValues?.[0]?.value ?? "",
    sessions: Number(r.metricValues?.[0]?.value ?? 0),
    users: Number(r.metricValues?.[1]?.value ?? 0),
  }));

// Lightweight totals-only fetch — used for the previous-period comparison.
async function fetchGa4Totals(accessToken: string, propertyId: string, startDate: string, endDate: string): Promise<Ga4Totals> {
  const res = await runGa4Report(accessToken, propertyId, {
    dateRanges: [{ startDate, endDate }],
    metrics: TOTALS_METRICS.map((name) => ({ name })),
  });
  return parseGa4Totals(res.rows);
}

export async function fetchGa4Report(
  accessToken: string,
  propertyId: string,
  startDate: string,
  endDate: string
): Promise<Ga4Report> {
  const dateRanges = [{ startDate, endDate }];
  const byMetrics = [{ name: "sessions" }, { name: "totalUsers" }];
  const orderBySessions = [{ metric: { metricName: "sessions" }, desc: true }];

  const [totalsRes, dateRes, landingRes, channelRes, deviceRes, countryRes] = await Promise.all([
    runGa4Report(accessToken, propertyId, { dateRanges, metrics: TOTALS_METRICS.map((name) => ({ name })) }),
    runGa4Report(accessToken, propertyId, {
      dateRanges,
      dimensions: [{ name: "date" }],
      metrics: [{ name: "totalUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 400,
    }),
    runGa4Report(accessToken, propertyId, { dateRanges, dimensions: [{ name: "landingPagePlusQueryString" }], metrics: byMetrics, orderBys: orderBySessions, limit: 10 }),
    runGa4Report(accessToken, propertyId, { dateRanges, dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: byMetrics, orderBys: orderBySessions, limit: 10 }),
    runGa4Report(accessToken, propertyId, { dateRanges, dimensions: [{ name: "deviceCategory" }], metrics: byMetrics, orderBys: orderBySessions, limit: 10 }),
    runGa4Report(accessToken, propertyId, { dateRanges, dimensions: [{ name: "country" }], metrics: byMetrics, orderBys: orderBySessions, limit: 10 }),
  ]);

  const byDate: Ga4Day[] = (dateRes.rows ?? []).map((r) => ({
    date: ga4Date(r.dimensionValues?.[0]?.value ?? ""),
    users: Number(r.metricValues?.[0]?.value ?? 0),
    sessions: Number(r.metricValues?.[1]?.value ?? 0),
    views: Number(r.metricValues?.[2]?.value ?? 0),
  }));

  return {
    totals: parseGa4Totals(totalsRes.rows),
    byDate,
    topLandingPages: dimRows(landingRes.rows),
    trafficSources: dimRows(channelRes.rows),
    devices: dimRows(deviceRes.rows),
    countries: dimRows(countryRes.rows),
  };
}

// Mirrors fetchGscReportWithComparison: the period plus the equal-length window
// before it, so the cached snapshot carries period-over-period deltas. GA4 data
// finalizes within ~24h, so windows end 1 day ago.
//
// WINDOW: exactly `periodDays` days. It used to start periodDays+1 days ago —
// periodDays+1 days of data compared against a previous window of periodDays —
// so every GA4 period-over-period change was overstated by about 1/periodDays.
//
// GA4 dates are the PROPERTY's calendar days, so the window ends on the last
// day that has fully ended in the property's time zone (lastCompleteDay). At
// the 06:00 UTC sync, "yesterday in UTC" is still running for a property in
// the Americas.
/**
 * GA4's current and comparison windows: equal length, contiguous, ending on the
 * property's last complete day. An unknown zone ends on a day that has ended
 * everywhere.
 */
export function ga4Windows(periodDays: number, timeZone?: string | null, now: number = Date.now()) {
  const end = lastCompleteDay(timeZone, now);
  const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const start = shift(end, -(periodDays - 1));
  const prevEnd = shift(start, -1);
  return { start, end, prevStart: shift(prevEnd, -(periodDays - 1)), prevEnd };
}

/** The property's reporting time zone (IANA), or null when it can't be read. */
async function ga4PropertyTimeZone(accessToken: string, propertyId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GA4_ADMIN}/properties/${encodeURIComponent(propertyId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { timeZone?: unknown };
    return typeof body.timeZone === "string" && body.timeZone ? body.timeZone : null;
  } catch {
    return null;
  }
}

export async function fetchGa4ReportWithComparison(
  accessToken: string,
  propertyId: string,
  periodDays: number
): Promise<Ga4ReportFull> {
  const { start, end, prevStart, prevEnd } = ga4Windows(periodDays, await ga4PropertyTimeZone(accessToken, propertyId));

  const [report, previousTotals] = await Promise.all([
    fetchGa4Report(accessToken, propertyId, start, end),
    fetchGa4Totals(accessToken, propertyId, prevStart, prevEnd).catch(() => null),
  ]);

  return {
    ...report,
    previousTotals,
    window: { start, end },
    previousWindow: previousTotals ? { start: prevStart, end: prevEnd } : null,
  };
}
