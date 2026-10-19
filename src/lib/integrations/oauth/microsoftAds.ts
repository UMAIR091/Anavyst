// Microsoft Advertising (Bing Ads) backend. Auth is the Microsoft identity
// platform (OAuth2 with rotating refresh tokens) plus a developer token, like
// Google Ads. The API is SOAP-only: accounts come from the Customer Management
// service, and reporting is asynchronous — submit a report request, poll until
// it's ready, download a ZIP, and parse the CSV inside. Everything normalizes
// into the shared AdsReport shape (metrics.ts) rendered by AdsAnalytics.
//
// NOTE: SOAP element order is significant (DataContract serialization); this is
// built to the documented v13 contracts and verified against live credentials.
import JSZip from "jszip";
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import { adWindows, adsTotals, windowFields, withRetry, type AdsDay, type AdsReport } from "../metrics";
import { getGoogleEmail, getGoogleSubject } from "@/lib/google";
import { UserFacingError } from "@/lib/errors";

// Microsoft Advertising accepts two identity providers (see the v13 auth docs):
//  • Microsoft identity (Entra) — personal MSA *and* work/school accounts. Use
//    the /common authority, which Microsoft recommends to support both; pinning
//    /consumers or /organizations breaks the other kind.
//  • Google — for accounts created with "Sign in with Google". These can NEVER
//    authenticate through Microsoft (you get error 126 IdentityTypeMismatch);
//    they use Google's OAuth and send an extra IdentityProvider=Google SOAP
//    header. We reuse the app's shared Google OAuth client for this.
const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";
const SCOPE = "https://ads.microsoft.com/msads.manage offline_access";
const PROVIDER_GOOGLE = "google";
// Bing Ads only needs the Google flow to identify the user; email/profile is
// enough. offline access → refresh tokens.
const GOOGLE_SCOPES = ["openid", "email", "profile"];
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const CUSTOMER_MGMT = "https://clientcenter.api.bingads.microsoft.com/Api/CustomerManagement/v13/CustomerManagementService.svc";
const REPORTING = "https://reporting.api.bingads.microsoft.com/Api/Advertiser/Reporting/v13/ReportingService.svc";
const CM_NS = "https://bingads.microsoft.com/Customer/v13";
const CM_ENT_NS = "https://bingads.microsoft.com/Customer/v13/Entities";
const REP_NS = "https://bingads.microsoft.com/Reporting/v13";
const ARRAYS_NS = "http://schemas.microsoft.com/2003/10/Serialization/Arrays";

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function microsoftAdsConfigured(): boolean {
  return Boolean(
    process.env.MICROSOFT_ADS_CLIENT_ID && process.env.MICROSOFT_ADS_CLIENT_SECRET && process.env.MICROSOFT_ADS_DEVELOPER_TOKEN
  );
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/microsoft/callback`;
}

// Google redirect URI for the Google-sign-in path. Derived from NEXT_PUBLIC_APP_URL
// — the SAME host the user browses and that the Microsoft path already uses — so
// the /api/google/callback request keeps its session + CSRF-nonce cookies. Using
// the shared GOOGLE_OAUTH_REDIRECT_URI instead risks a different host (e.g. a
// stale *.vercel.app value), which drops the cookies and bounces the user to the
// app login page. This exact URI must be registered in the Google OAuth client.
function googleRedirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/google/callback`;
}

function googleAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env("GOOGLE_CLIENT_ID"),
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH}?${params.toString()}`;
}

async function googleTokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token request failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in ?? 3600 };
}

// Which identity provider a given OAuth `state` selected (default Microsoft).
// state is the base64url JSON built in handleConnect; authUrl only receives the
// state string, so we read the provider back out of it here.
function providerFromState(state: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return typeof parsed.provider === "string" ? parsed.provider : "microsoft";
  } catch {
    return "microsoft";
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, scope: SCOPE }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Microsoft token request failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in ?? 3600 };
}

export const microsoftAdsOAuth: OAuthProvider = {
  id: "microsoft",
  // A Google-signed-in connection was minted by the shared Google OAuth app, so
  // it sits on the same grant as that account's Search Console, GA4 and the
  // rest — and would die with them if one of those were revoked. Reported here
  // so disconnect counts it as a sibling. Microsoft-authenticated connections
  // have their own grant and return null. This provider defines no `revoke`, so
  // the key only ever makes it a sibling, never a revoker.
  grantKey: ({ display_name, config }) =>
    config?.identity_provider === PROVIDER_GOOGLE && display_name ? `google:${display_name}` : null,
  authUrl(state) {
    // Google-sign-in users authenticate through the shared Google OAuth app,
    // which redirects to the already-registered /api/google/callback; the
    // generic callback resolves this as a Microsoft Ads connection from state.
    if (providerFromState(state) === PROVIDER_GOOGLE) {
      return googleAuthorizeUrl(state);
    }
    const params = new URLSearchParams({
      client_id: env("MICROSOFT_ADS_CLIENT_ID"),
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: SCOPE,
      state,
    });
    return `${AUTH}/authorize?${params.toString()}`;
  },
  exchangeCode: (code, ctx) =>
    ctx?.provider === PROVIDER_GOOGLE
      ? googleTokenRequest({
          grant_type: "authorization_code",
          code,
          client_id: env("GOOGLE_CLIENT_ID"),
          client_secret: env("GOOGLE_CLIENT_SECRET"),
          redirect_uri: googleRedirectUri(),
        })
      : tokenRequest({
          grant_type: "authorization_code",
          code,
          client_id: env("MICROSOFT_ADS_CLIENT_ID"),
          client_secret: env("MICROSOFT_ADS_CLIENT_SECRET"),
          redirect_uri: redirectUri(),
        }),
  refresh: (refreshToken, ctx) =>
    ctx?.provider === PROVIDER_GOOGLE
      ? googleTokenRequest({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: env("GOOGLE_CLIENT_ID"),
          client_secret: env("GOOGLE_CLIENT_SECRET"),
        })
      : tokenRequest({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: env("MICROSOFT_ADS_CLIENT_ID"),
          client_secret: env("MICROSOFT_ADS_CLIENT_SECRET"),
        }),
  async identity(accessToken, ctx) {
    // Google connections: label with the Google email (avoids a SOAP round-trip
    // and works before account discovery). Microsoft connections: GetUser.
    if (ctx?.provider === PROVIDER_GOOGLE) return getGoogleEmail(accessToken);
    try {
      const xml = await soapCall(CUSTOMER_MGMT, CM_NS, "GetUser", accessToken, "", `<GetUserRequest xmlns="${CM_NS}"><UserId i:nil="true"/></GetUserRequest>`, ctx?.provider);
      return tag(xml, "UserName") || tag(xml, "Name") || "Microsoft Ads account";
    } catch {
      return "Microsoft Ads account";
    }
  },
  async subject(accessToken, ctx) {
    if (ctx?.provider === PROVIDER_GOOGLE) return getGoogleSubject(accessToken);
    try {
      const xml = await soapCall(CUSTOMER_MGMT, CM_NS, "GetUser", accessToken, "", `<GetUserRequest xmlns="${CM_NS}"><UserId i:nil="true"/></GetUserRequest>`, ctx?.provider);
      // The User's own Id follows its ContactInfo, whose address has an Id of
      // its own, so read past it.
      const user = xml.split(/<\/(?:\w+:)?ContactInfo>/)[1] ?? "";
      const id = tag(user, "Id");
      return id && /^\d+$/.test(id) ? `msads:${id}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/microsoft/callback",
};

// ── SOAP plumbing ────────────────────────────────────────────

// Builds and sends a SOAP 1.1 envelope with the Bing Ads auth headers, returning
// the raw response XML. Header order follows the required contract.
async function soapCall(
  endpoint: string, ns: string, action: string, accessToken: string, extraHeaders: string, bodyXml: string, provider?: string
): Promise<string> {
  // Header element order follows Microsoft's documented v13 request: Action,
  // then AuthenticationToken (the OAuth access token), then DeveloperToken, then
  // any per-call headers (CustomerId/CustomerAccountId). i:nil="false" is set
  // explicitly on the tokens as the reference requests do.
  const envelope =
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">` +
    `<s:Header xmlns="${ns}">` +
    `<Action mustUnderstand="1">${action}</Action>` +
    `<AuthenticationToken i:nil="false">${accessToken}</AuthenticationToken>` +
    `<DeveloperToken i:nil="false">${env("MICROSOFT_ADS_DEVELOPER_TOKEN")}</DeveloperToken>` +
    // Google-authenticated connections must carry IdentityProvider=Google (a v13
    // SOAP header element, in the same service namespace) so Bing Ads validates
    // the access token against Google instead of Microsoft identity. The provider
    // is the connection's stored config.identity_provider — the single source of
    // truth, threaded explicitly (never inferred from the token).
    (provider === PROVIDER_GOOGLE ? `<IdentityProvider>Google</IdentityProvider>` : "") +
    extraHeaders +
    `</s:Header>` +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`;

  return withRetry(async () => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: action },
      body: envelope,
    });
    const text = await res.text();
    // Fault detection is prefix-agnostic (the server picks the envelope prefix).
    if (!res.ok || /<(?:\w+:)?Fault\b/.test(text) || text.includes("faultstring")) {
      // The top-level faultstring is usually generic ("Invalid client data. Check
      // the SOAP fault details..."); the actionable Code/ErrorCode/Message live in
      // the <detail>. Log the full response (not the request — it carries the
      // access + developer tokens) so the exact fault is visible in Vercel logs.
      console.error(`[microsoft-ads] SOAP fault on ${action} (HTTP ${res.status}):\n${text}`);
      const detail = parseSoapFault(text);
      const technical = `Microsoft Ads API error [${action}]: ${detail}`;
      // Wrong sign-in provider for this account (error 126): the user picked the
      // Microsoft button for a Google-sign-in account or vice-versa. Give a plain
      // instruction to switch buttons instead of the raw Bing Ads message.
      if (/IdentityTypeMismatch/i.test(detail) || /\bCode=126\b/.test(detail)) {
        throw new UserFacingError(
          'This Microsoft Advertising account uses a different sign-in method. Go back and choose the other option — if you clicked "Continue with Microsoft", use "Continue with Google" instead (or vice-versa).',
          technical
        );
      }
      throw new Error(technical);
    }
    return text;
  });
}

// Pulls the detailed Bing Ads fault out of the SOAP <detail> that the generic
// faultstring hides. Handles both ApiFaultDetail (OperationErrors/BatchErrors)
// and AdApiFaultDetail (AdApiError); namespace-prefix agnostic. Falls back to the
// top-level fault text when no structured error is present.
function parseSoapFault(xml: string): string {
  const errorBlocks = [
    ...blocks(xml, "OperationError"),
    ...blocks(xml, "BatchError"),
    ...blocks(xml, "AdApiError"),
  ];
  const parsed = errorBlocks
    .map((b) => {
      const code = tag(b, "Code");
      const errorCode = tag(b, "ErrorCode");
      const message = tag(b, "Message");
      const details = tag(b, "Details");
      return [
        code && `Code=${code}`,
        errorCode && `ErrorCode=${errorCode}`,
        message && `Message=${message}`,
        details && `Details=${details}`,
      ]
        .filter(Boolean)
        .join(" ");
    })
    .filter((s) => s.length > 0);
  if (parsed.length) return parsed.join(" | ");
  return tag(xml, "faultstring") || tag(xml, "Message") || "unknown SOAP fault";
}

// Minimal XML helpers (namespace-prefix agnostic) — we only read a few fields.
function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : undefined;
}
function tagAll(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${name}[ >][\\s\\S]*?</(?:\\w+:)?${name}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[0]);
  return out;
}

// ── Account listing (Customer Management: GetUser → SearchAccounts) ──

// Reads the authenticated user's own id from a GetUser response. The <User>
// element nests <ContactInfo> (and an <Address> inside it), each with its own
// <Id> that appears BEFORE the user's own <Id>. A naive first-<Id> match returns
// the address/contact id, and passing that to SearchAccounts fails with
// error 1310 "The user id not found" — so strip the contact block first.
function userIdFromGetUser(xml: string): string | undefined {
  const user = blocks(xml, "User")[0] ?? xml;
  const withoutContact = user.replace(/<(?:\w+:)?ContactInfo[\s\S]*?<\/(?:\w+:)?ContactInfo>/g, "");
  return tag(withoutContact, "Id");
}

// GetUser right after sign-in fails with 105 InvalidCredentials when the login
// itself worked but has no active Microsoft Advertising user behind it, e.g.
// someone signs in with a different Microsoft or Google account than the one
// that owns the ads account. "Please try again" can't fix that, so say which
// login to use instead.
function noAdvertisingUser(err: unknown, provider?: string): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (!/\bCode=105\b|InvalidCredentials/.test(message)) return err;
  return new UserFacingError(
    provider === PROVIDER_GOOGLE
      ? 'The Google account you chose isn\'t linked to an active Microsoft Advertising account. Sign in with the Google account you use for Microsoft Advertising, or go back and choose "Continue with Microsoft".'
      : 'The Microsoft account you signed in with has no active Microsoft Advertising account. If you sign in to Microsoft Advertising with Google, go back and choose "Continue with Google".',
    message
  );
}

// Lists the ad accounts the authenticated user can access. The account id is
// packed as "customerId:accountId" because reporting needs both in its headers.
export async function listMicrosoftAdsAccounts(accessToken: string, provider?: string): Promise<IntegrationAccount[]> {
  const userXml = await soapCall(CUSTOMER_MGMT, CM_NS, "GetUser", accessToken, "", `<GetUserRequest xmlns="${CM_NS}"><UserId i:nil="true"/></GetUserRequest>`, provider).catch(
    (err) => {
      throw noAdvertisingUser(err, provider);
    }
  );
  const userId = userIdFromGetUser(userXml);
  if (!userId) throw new Error("Couldn't read the Microsoft Ads user.");

  const searchBody =
    `<SearchAccountsRequest xmlns="${CM_NS}" xmlns:a="${CM_ENT_NS}">` +
    `<Predicates><a:Predicate><a:Field>UserId</a:Field><a:Operator>Equals</a:Operator><a:Value>${userId}</a:Value></a:Predicate></Predicates>` +
    `<Ordering i:nil="true"/>` +
    `<PageInfo><a:Index>0</a:Index><a:Size>100</a:Size></PageInfo>` +
    `</SearchAccountsRequest>`;
  const xml = await soapCall(CUSTOMER_MGMT, CM_NS, "SearchAccounts", accessToken, "", searchBody, provider);

  return blocks(xml, "AdvertiserAccount").map((b) => {
    const id = tag(b, "Id") ?? "";
    const parent = tag(b, "ParentCustomerId") ?? "";
    const name = tag(b, "Name") ?? id;
    return { id: `${parent}:${id}`, name: `${name} (${id})` };
  }).filter((a) => a.id.includes(":") && !a.id.startsWith(":"));
}

// ── Reporting (async: submit → poll → download ZIP → parse CSV) ──

const REPORT_COLUMNS = ["TimePeriod", "CurrencyCode", "Impressions", "Clicks", "Spend", "Conversions", "Revenue"];

function dateXml(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `<Day>${d}</Day><Month>${m}</Month><Year>${y}</Year>`;
}

function submitBody(accountId: string, since: string, until: string): string {
  const cols = REPORT_COLUMNS.map((c) => `<AccountPerformanceReportColumn>${c}</AccountPerformanceReportColumn>`).join("");
  return (
    `<SubmitGenerateReportRequest xmlns="${REP_NS}">` +
    `<ReportRequest i:type="AccountPerformanceReportRequest">` +
    `<ExcludeColumnHeaders>false</ExcludeColumnHeaders>` +
    `<ExcludeReportFooter>true</ExcludeReportFooter>` +
    `<ExcludeReportHeader>true</ExcludeReportHeader>` +
    `<Format>Csv</Format>` +
    `<ReportName>Anavyst</ReportName>` +
    `<ReturnOnlyCompleteData>false</ReturnOnlyCompleteData>` +
    `<Aggregation>Daily</Aggregation>` +
    `<Columns>${cols}</Columns>` +
    `<Scope><AccountIds xmlns:a="${ARRAYS_NS}"><a:long>${accountId}</a:long></AccountIds></Scope>` +
    `<Time>` +
    `<CustomDateRangeEnd>${dateXml(until)}</CustomDateRangeEnd>` +
    `<CustomDateRangeStart>${dateXml(since)}</CustomDateRangeStart>` +
    `</Time>` +
    `</ReportRequest>` +
    `</SubmitGenerateReportRequest>`
  );
}

async function generateReportCsv(
  accessToken: string, customerId: string, accountId: string, since: string, until: string, provider?: string
): Promise<string> {
  const headers = `<CustomerId>${customerId}</CustomerId><CustomerAccountId>${accountId}</CustomerAccountId>`;
  const submitted = await soapCall(REPORTING, REP_NS, "SubmitGenerateReport", accessToken, headers, submitBody(accountId, since, until), provider);
  const reportId = tag(submitted, "ReportRequestId");
  if (!reportId) throw new Error("Microsoft Ads did not return a report id.");

  // Poll until the report completes (bounded).
  let downloadUrl: string | undefined;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const pollBody = `<PollGenerateReportRequest xmlns="${REP_NS}"><ReportRequestId>${reportId}</ReportRequestId></PollGenerateReportRequest>`;
    const poll = await soapCall(REPORTING, REP_NS, "PollGenerateReport", accessToken, headers, pollBody, provider);
    const status = tag(poll, "Status");
    if (status === "Success") {
      downloadUrl = tag(poll, "ReportDownloadUrl");
      break;
    }
    if (status === "Error") throw new Error("Microsoft Ads report generation failed.");
    // "Pending" → keep polling.
  }
  if (!downloadUrl) return ""; // no data / timed out — treated as an empty report

  const zipRes = await fetch(downloadUrl.replace(/&amp;/g, "&"));
  if (!zipRes.ok) throw new Error(`Microsoft Ads report download failed (${zipRes.status})`);
  const zip = await JSZip.loadAsync(await zipRes.arrayBuffer());
  const csvFile = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".csv"));
  return csvFile ? csvFile.async("string") : "";
}

// Parses the report CSV into daily rows keyed by column name.
function parseCsv(csv: string): Record<string, string>[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const split = (line: string) => line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
  const header = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

const num = (v: string | undefined) => {
  const n = Number((v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Fetches the normalized ads report for one account and period, plus the prior
// equal-length period for comparison. accountId = "customerId:accountId".
export async function fetchMicrosoftAdsReport(accessToken: string, packedId: string, periodDays: number, provider?: string): Promise<AdsReport> {
  const [customerId, accountId] = packedId.split(":");
  // Report rows are UTC days: "The downloaded report data is always relative
  // to UTC time" (Reporting guide, Time Zones in Reporting, checked 16 Oct
  // 2026). The account's TimeZone setting doesn't change that, and
  // ReportTimeZone only sets what "today" means for predefined ranges, which
  // aren't used here. So the window is UTC days ending on the last complete one.
  const w = adWindows(periodDays, "UTC");
  const { since, until } = w;

  const [csv, prevCsv] = await Promise.all([
    generateReportCsv(accessToken, customerId, accountId, since, until, provider),
    generateReportCsv(accessToken, customerId, accountId, w.prevSince, w.prevUntil, provider).catch(() => ""),
  ]);

  const rows = parseCsv(csv);
  const byDay = new Map<string, AdsDay>();
  for (const d of w.days) byDay.set(d, { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  let revenue = 0;
  // Filled from the report's CurrencyCode column; stays unknown if absent
  // rather than defaulting to dollars.
  let currency = "";
  for (const r of rows) {
    const day = byDay.get((r.TimePeriod || "").slice(0, 10));
    if (r.CurrencyCode) currency = r.CurrencyCode;
    if (!day) continue;
    day.spend += num(r.Spend);
    day.impressions += num(r.Impressions);
    day.clicks += num(r.Clicks);
    day.conversions += num(r.Conversions);
    revenue += num(r.Revenue);
  }
  const byDate = Array.from(byDay.values());

  let previousTotals: AdsReport["previousTotals"] = null;
  const prevRows = parseCsv(prevCsv);
  if (prevRows.length) {
    const prevDay: AdsDay = { date: since, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
    let prevRevenue = 0;
    for (const r of prevRows) {
      prevDay.spend += num(r.Spend);
      prevDay.impressions += num(r.Impressions);
      prevDay.clicks += num(r.Clicks);
      prevDay.conversions += num(r.Conversions);
      prevRevenue += num(r.Revenue);
    }
    previousTotals = adsTotals([prevDay], prevRevenue);
  }

  return {
    platform: "microsoft_ads",
    currency,
    totals: adsTotals(byDate, revenue),
    previousTotals,
    ...windowFields(w, previousTotals !== null),
    byDate,
    topCampaigns: [], // account-level report; campaign breakdown omitted to keep one report call.
  };
}
