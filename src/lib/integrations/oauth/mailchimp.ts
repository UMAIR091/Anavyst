// Mailchimp backend. Standard OAuth2, but the access token alone isn't enough —
// every account lives in a specific data center ("dc"), which we discover via
// the metadata endpoint after the code exchange and pack into the stored token
// as "dc|token" so the generic sync (token + account id only) can reach the
// right API host. Mailchimp tokens don't expire and there's no refresh flow.
// A connection maps to one audience (list); data fills the shared EmailReport.
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import {
  dayRange, isoDay, ratio, withRetry, type EmailDay, type EmailReport, type EmailTotals,
} from "../metrics";

const AUTHORIZE = "https://login.mailchimp.com/oauth2/authorize";
const TOKEN = "https://login.mailchimp.com/oauth2/token";
const METADATA = "https://login.mailchimp.com/oauth2/metadata";
const NEVER_EXPIRES = 100 * 365 * 24 * 60 * 60;

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function mailchimpConfigured(): boolean {
  return Boolean(process.env.MAILCHIMP_CLIENT_ID && process.env.MAILCHIMP_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/mailchimp/callback`;
}

// The stored token is "dc|access_token" so the data center travels with it.
function packToken(dc: string, token: string): string {
  return `${dc}|${token}`;
}
function unpack(token: string): { dc: string; token: string } {
  const idx = token.indexOf("|");
  return idx === -1 ? { dc: "", token } : { dc: token.slice(0, idx), token: token.slice(idx + 1) };
}
function apiBase(dc: string): string {
  return `https://${dc}.api.mailchimp.com/3.0`;
}

export const mailchimpOAuth: OAuthProvider = {
  id: "mailchimp",
  authUrl(state) {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: env("MAILCHIMP_CLIENT_ID"),
      redirect_uri: redirectUri(),
      state,
    });
    return `${AUTHORIZE}?${params.toString()}`;
  },

  // Exchange the code, then look up the account's data center and pack it into
  // the token. Tokens don't expire, so refresh is never needed.
  async exchangeCode(code): Promise<TokenSet> {
    const res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env("MAILCHIMP_CLIENT_ID"),
        client_secret: env("MAILCHIMP_CLIENT_SECRET"),
        redirect_uri: redirectUri(),
        code,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Mailchimp token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
    }
    const metaRes = await fetch(METADATA, { headers: { Authorization: `OAuth ${data.access_token}` } });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta.dc) throw new Error("Couldn't resolve the Mailchimp data center.");
    return { access_token: packToken(meta.dc, data.access_token), expires_in: NEVER_EXPIRES };
  },

  refresh: async () => {
    throw new Error("Mailchimp access was revoked. Please reconnect the account.");
  },

  async identity(accessToken): Promise<string> {
    const { dc, token } = unpack(accessToken);
    try {
      const res = await fetch(`${apiBase(dc)}/`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      return data.account_name || data.email || "Mailchimp account";
    } catch {
      return "Mailchimp account";
    }
  },

  // The account plus the login within it.
  async subject(accessToken): Promise<string | null> {
    const { dc, token } = unpack(accessToken);
    try {
      const res = await fetch(`${apiBase(dc)}/`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return data.account_id ? `mailchimp:${data.account_id}:${data.login_id ?? ""}` : null;
    } catch {
      return null;
    }
  },

  callbackPath: "/api/mailchimp/callback",
};

async function mcGet<T>(dc: string, token: string, path: string): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`${apiBase(dc)}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) throw new Error("Mailchimp rate limit (429)");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { detail?: string; title?: string }).detail ?? (data as { title?: string }).title ?? res.statusText;
      throw new Error(`Mailchimp API error: ${detail} (${res.status})`);
    }
    return data as T;
  });
}

// Audiences (lists) are the selectable accounts.
export async function listMailchimpAudiences(accessToken: string): Promise<IntegrationAccount[]> {
  const { dc, token } = unpack(accessToken);
  const data = await mcGet<{ lists?: { id: string; name: string }[] }>(
    dc, token, "/lists?count=200&fields=lists.id,lists.name"
  );
  return (data.lists ?? []).map((l) => ({ id: l.id, name: l.name }));
}

type ActivityRow = {
  day?: string; emails_sent?: number; unique_opens?: number; recipient_clicks?: number;
  subs?: number; unsubs?: number;
};
type Campaign = {
  settings?: { title?: string };
  send_time?: string;
  emails_sent?: number;
  report_summary?: { open_rate?: number; click_rate?: number; opens?: number; clicks?: number };
};

function totalsFrom(rows: ActivityRow[], subscribers: number, campaigns: number): EmailTotals {
  const emailsSent = rows.reduce((s, r) => s + (r.emails_sent ?? 0), 0);
  const opens = rows.reduce((s, r) => s + (r.unique_opens ?? 0), 0);
  const clicks = rows.reduce((s, r) => s + (r.recipient_clicks ?? 0), 0);
  return {
    subscribers,
    newSubscribers: rows.reduce((s, r) => s + (r.subs ?? 0), 0),
    unsubscribes: rows.reduce((s, r) => s + (r.unsubs ?? 0), 0),
    campaigns,
    emailsSent,
    opens,
    openRate: ratio(opens, emailsSent),
    clicks,
    clickRate: ratio(clicks, emailsSent),
  };
}

// Fetches the normalized email report for one audience and period, plus the
// prior equal-length period for comparison. accountId = the Mailchimp list id.
export async function fetchMailchimpReport(accessToken: string, listId: string, periodDays: number): Promise<EmailReport> {
  const { dc, token } = unpack(accessToken);
  const since = isoDay(periodDays);
  const until = isoDay(1);
  const prevSince = isoDay(periodDays * 2);
  const prevUntil = isoDay(periodDays + 1);

  // List activity returns recent daily rows (up to ~180 days); one call covers
  // both the current and previous windows.
  const [list, activity, campaignsRes] = await Promise.all([
    mcGet<{ stats?: { member_count?: number } }>(dc, token, `/lists/${listId}?fields=stats.member_count`),
    mcGet<{ activity?: ActivityRow[] }>(dc, token, `/lists/${listId}/activity?count=${periodDays * 2 + 2}`),
    mcGet<{ campaigns?: Campaign[] }>(
      dc, token,
      `/campaigns?list_id=${listId}&status=sent&since_send_time=${since}T00:00:00Z&count=100&sort_field=send_time&sort_dir=DESC` +
      `&fields=campaigns.settings.title,campaigns.send_time,campaigns.emails_sent,campaigns.report_summary`
    ).catch(() => ({ campaigns: [] as Campaign[] })),
  ]);

  const subscribers = list.stats?.member_count ?? 0;
  const rows = activity.activity ?? [];
  const inWindow = (r: ActivityRow, a: string, b: string) => {
    const d = (r.day ?? "").slice(0, 10);
    return d >= a && d <= b;
  };
  const current = rows.filter((r) => inWindow(r, since, until));
  const previous = rows.filter((r) => inWindow(r, prevSince, prevUntil));
  const campaigns = campaignsRes.campaigns ?? [];

  const byDayMap = new Map<string, EmailDay>();
  for (const d of dayRange(periodDays)) byDayMap.set(d, { date: d, sent: 0, opens: 0, clicks: 0 });
  for (const r of current) {
    const day = byDayMap.get((r.day ?? "").slice(0, 10));
    if (day) {
      day.sent += r.emails_sent ?? 0;
      day.opens += r.unique_opens ?? 0;
      day.clicks += r.recipient_clicks ?? 0;
    }
  }

  return {
    platform: "mailchimp",
    totals: totalsFrom(current, subscribers, campaigns.length),
    previousTotals: previous.length ? totalsFrom(previous, subscribers, 0) : null,
    byDate: Array.from(byDayMap.values()),
    topCampaigns: campaigns.slice(0, 8).map((c) => ({
      name: c.settings?.title ?? "—",
      sentAt: (c.send_time ?? "").slice(0, 10),
      sent: c.emails_sent ?? 0,
      openRate: c.report_summary?.open_rate ?? 0,
      clickRate: c.report_summary?.click_rate ?? 0,
    })),
  };
}
