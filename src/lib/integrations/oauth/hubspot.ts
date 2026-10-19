// HubSpot backend. Standard OAuth (fits the generic connect/callback flow) —
// short-lived access tokens with rotating refresh handled by the shared token
// machinery. CRM activity is normalized into CrmReport: new contacts (leads),
// new deals, closed-won deals and revenue.
import type { OAuthProvider, TokenSet } from "../types";
import type { IntegrationAccount } from "../types";
import { isoDay, withRetry, type CrmDay, type CrmReport, type CrmTotals } from "../metrics";

const API = "https://api.hubapi.com";
const SCOPES = ["oauth", "crm.objects.contacts.read", "crm.objects.deals.read"];

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function hubspotConfigured(): boolean {
  return Boolean(process.env.HUBSPOT_CLIENT_ID && process.env.HUBSPOT_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/hubspot/callback`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(`${API}/oauth/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`HubSpot token request failed: ${data.message ?? res.status}`);
  }
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in ?? 1800 };
}

export const hubspotOAuth: OAuthProvider = {
  id: "hubspot",
  authUrl(state) {
    const params = new URLSearchParams({
      client_id: env("HUBSPOT_CLIENT_ID"),
      redirect_uri: redirectUri(),
      scope: SCOPES.join(" "),
      state,
    });
    return `https://app.hubspot.com/oauth/authorize?${params.toString()}`;
  },
  exchangeCode: (code) =>
    tokenRequest({
      grant_type: "authorization_code",
      client_id: env("HUBSPOT_CLIENT_ID"),
      client_secret: env("HUBSPOT_CLIENT_SECRET"),
      redirect_uri: redirectUri(),
      code,
    }),
  refresh: (refreshToken) =>
    tokenRequest({
      grant_type: "refresh_token",
      client_id: env("HUBSPOT_CLIENT_ID"),
      client_secret: env("HUBSPOT_CLIENT_SECRET"),
      refresh_token: refreshToken,
    }),
  async identity(accessToken) {
    try {
      const res = await fetch(`${API}/oauth/v1/access-tokens/${accessToken}`);
      const data = await res.json().catch(() => ({}));
      return data.hub_domain ?? data.user ?? "HubSpot account";
    } catch {
      return "HubSpot account";
    }
  },

  // A HubSpot token belongs to one user in one portal.
  async subject(accessToken) {
    try {
      const res = await fetch(`${API}/oauth/v1/access-tokens/${accessToken}`);
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return data.hub_id && data.user_id ? `hubspot:${data.hub_id}:${data.user_id}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/hubspot/callback",
};

async function hsFetch<T>(path: string, accessToken: string, init?: RequestInit): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init?.headers },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { message?: string }).message ?? `${res.status} ${res.statusText}`;
      throw new Error(`HubSpot API error: ${detail}`);
    }
    return data as T;
  });
}

// A connection maps to one HubSpot portal (account).
export async function listHubspotAccounts(accessToken: string): Promise<IntegrationAccount[]> {
  const info = await hsFetch<{ portalId?: number; companyCurrency?: string }>(
    "/account-info/v3/details", accessToken
  );
  const id = String(info.portalId ?? "");
  if (!id) throw new Error("Couldn't read the HubSpot account id.");
  return [{ id, name: `Portal ${id}` }];
}

type SearchResult = {
  total?: number;
  results?: { properties?: Record<string, string | null> }[];
  paging?: { next?: { after?: string } };
};

// CRM search, paginated up to `cap` records (totals still use the API's total).
async function search(
  accessToken: string, object: "contacts" | "deals", body: Record<string, unknown>, cap: number
): Promise<{ total: number; rows: Record<string, string | null>[] }> {
  const rows: Record<string, string | null>[] = [];
  let after: string | undefined;
  let total = 0;
  while (rows.length < cap) {
    const page = await hsFetch<SearchResult>(`/crm/v3/objects/${object}/search`, accessToken, {
      method: "POST",
      body: JSON.stringify({ ...body, limit: 200, ...(after ? { after } : {}) }),
    });
    total = page.total ?? 0;
    for (const r of page.results ?? []) rows.push(r.properties ?? {});
    after = page.paging?.next?.after;
    if (!after) break;
  }
  return { total, rows };
}

const dateFilter = (property: string, sinceMs: number, untilMs: number) => ({
  filterGroups: [{
    filters: [
      { propertyName: property, operator: "GTE", value: String(sinceMs) },
      { propertyName: property, operator: "LTE", value: String(untilMs) },
    ],
  }],
});

function crmTotals(contactsTotal: number, dealsTotal: number, won: { total: number; revenue: number }): CrmTotals {
  return { newContacts: contactsTotal, newDeals: dealsTotal, wonDeals: won.total, wonRevenue: won.revenue };
}

// Fetches the normalized CRM report for the portal and period, plus the prior
// equal-length period for comparison.
export async function fetchHubspotReport(accessToken: string, _portalId: string, periodDays: number): Promise<CrmReport> {
  const DAY = 24 * 60 * 60 * 1000;
  const until = Date.now();
  const since = until - periodDays * DAY;
  const prevSince = until - periodDays * 2 * DAY;
  const CAP = 1000;

  const [contacts, deals, wonDeals, prevContacts, prevDeals, prevWon, info] = await Promise.all([
    search(accessToken, "contacts", { ...dateFilter("createdate", since, until), properties: ["createdate"], sorts: ["createdate"] }, CAP),
    search(accessToken, "deals", { ...dateFilter("createdate", since, until), properties: ["dealname", "amount", "createdate", "dealstage"], sorts: ["createdate"] }, CAP),
    search(accessToken, "deals", {
      filterGroups: [{
        filters: [
          { propertyName: "closedate", operator: "GTE", value: String(since) },
          { propertyName: "closedate", operator: "LTE", value: String(until) },
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        ],
      }],
      properties: ["amount"],
    }, CAP),
    search(accessToken, "contacts", { ...dateFilter("createdate", prevSince, since - 1), properties: ["createdate"] }, 1)
      .catch(() => ({ total: 0, rows: [] })),
    search(accessToken, "deals", { ...dateFilter("createdate", prevSince, since - 1), properties: ["createdate"] }, 1)
      .catch(() => ({ total: 0, rows: [] })),
    search(accessToken, "deals", {
      filterGroups: [{
        filters: [
          { propertyName: "closedate", operator: "GTE", value: String(prevSince) },
          { propertyName: "closedate", operator: "LTE", value: String(since - 1) },
          { propertyName: "hs_is_closed_won", operator: "EQ", value: "true" },
        ],
      }],
      properties: ["amount"],
    }, CAP).catch(() => ({ total: 0, rows: [] })),
    hsFetch<{ companyCurrency?: string }>("/account-info/v3/details", accessToken).catch(() => ({} as { companyCurrency?: string })),
  ]);

  const byDay = new Map<string, CrmDay>();
  for (let i = periodDays; i >= 1; i--) byDay.set(isoDay(i), { date: isoDay(i), contacts: 0, deals: 0 });
  for (const c of contacts.rows) {
    const d = byDay.get((c.createdate ?? "").slice(0, 10));
    if (d) d.contacts += 1;
  }
  for (const d0 of deals.rows) {
    const d = byDay.get((d0.createdate ?? "").slice(0, 10));
    if (d) d.deals += 1;
  }

  const sumAmount = (rows: Record<string, string | null>[]) => rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  return {
    platform: "hubspot",
    currency: info.companyCurrency ?? "USD",
    totals: crmTotals(contacts.total, deals.total, { total: wonDeals.total, revenue: sumAmount(wonDeals.rows) }),
    previousTotals: crmTotals(prevContacts.total, prevDeals.total, { total: prevWon.total, revenue: sumAmount(prevWon.rows) }),
    byDate: Array.from(byDay.values()),
    topDeals: deals.rows
      .map((r) => ({
        name: r.dealname ?? "—",
        amount: Number(r.amount ?? 0),
        stage: r.dealstage ?? "",
        createdAt: (r.createdate ?? "").slice(0, 10),
      }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8),
  };
}
