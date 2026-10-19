// Stripe backend. Uses Stripe Connect OAuth (read-only) so agencies connect a
// client's Stripe account without handling keys. For Standard accounts the
// returned access token is the account-scoped key and doesn't expire, so there's
// no refresh flow (revocation surfaces as a 401 → reconnect). Charge data is
// normalized into the shared CommerceReport shape (metrics.ts) — the same one
// Shopify and WooCommerce fill — so payments read like any other storefront.
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import { isoDay, ratio, withRetry, type CommerceDay, type CommerceReport, type CommerceTotals } from "../metrics";

const CONNECT_AUTHORIZE = "https://connect.stripe.com/oauth/authorize";
const CONNECT_TOKEN = "https://connect.stripe.com/oauth/token";
const API = "https://api.stripe.com/v1";
const NEVER_EXPIRES = 100 * 365 * 24 * 60 * 60;

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_CONNECT_CLIENT_ID && process.env.STRIPE_SECRET_KEY);
}

function redirectUri(): string {
  return `${env("NEXT_PUBLIC_APP_URL")}/api/stripe/callback`;
}

export const stripeOAuth: OAuthProvider = {
  id: "stripe",
  authUrl(state) {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: env("STRIPE_CONNECT_CLIENT_ID"),
      scope: "read_only",
      redirect_uri: redirectUri(),
      state,
    });
    return `${CONNECT_AUTHORIZE}?${params.toString()}`;
  },
  // The platform secret key authenticates the token exchange; the returned
  // access token is the connected account's read-only key.
  async exchangeCode(code): Promise<TokenSet> {
    const res = await fetch(CONNECT_TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_secret: env("STRIPE_SECRET_KEY"),
        code,
        grant_type: "authorization_code",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Stripe token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
    }
    return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: NEVER_EXPIRES };
  },
  refresh: async () => {
    throw new Error("Stripe access was revoked. Please reconnect the account.");
  },
  async identity(accessToken) {
    try {
      const acc = await stripeGet<StripeAccount>(accessToken, "/account");
      return acc.settings?.dashboard?.display_name || acc.business_profile?.name || acc.id || "Stripe account";
    } catch {
      return "Stripe account";
    }
  },

  async subject(accessToken) {
    try {
      const acc = await stripeGet<StripeAccount>(accessToken, "/account");
      return acc.id ? `stripe:${acc.id}` : null;
    } catch {
      return null;
    }
  },
  callbackPath: "/api/stripe/callback",
};

type StripeAccount = {
  id?: string;
  default_currency?: string;
  business_profile?: { name?: string };
  settings?: { dashboard?: { display_name?: string } };
};

async function stripeGet<T>(accessToken: string, path: string): Promise<T> {
  return withRetry(async () => {
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) throw new Error("Stripe rate limit (429)");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (data as { error?: { message?: string } }).error?.message ?? res.statusText;
      throw new Error(`Stripe API error: ${detail} (${res.status})`);
    }
    return data as T;
  });
}

// The connected account is the sole selectable account.
export async function listStripeAccounts(accessToken: string): Promise<IntegrationAccount[]> {
  const acc = await stripeGet<StripeAccount>(accessToken, "/account");
  const name = acc.settings?.dashboard?.display_name || acc.business_profile?.name || acc.id || "Stripe account";
  return [{ id: acc.id ?? "account", name }];
}

type Charge = {
  amount?: number; // in the smallest currency unit
  amount_refunded?: number;
  currency?: string;
  status?: string;
  paid?: boolean;
  created?: number; // unix seconds
  customer?: string | null;
};

async function listCharges(accessToken: string, sinceUnix: number, untilUnix: number): Promise<Charge[]> {
  const out: Charge[] = [];
  let startingAfter: string | undefined;
  // Cap pagination so a high-volume account can't stall the sync.
  for (let i = 0; i < 20; i++) {
    const params = new URLSearchParams({ limit: "100", "created[gte]": String(sinceUnix), "created[lte]": String(untilUnix) });
    if (startingAfter) params.set("starting_after", startingAfter);
    const page = await stripeGet<{ data?: (Charge & { id: string })[]; has_more?: boolean }>(accessToken, `/charges?${params.toString()}`);
    const data = page.data ?? [];
    out.push(...data);
    if (!page.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  return out;
}

function commerceTotals(charges: Charge[]): CommerceTotals {
  const revenue = charges.reduce((s, c) => s + (c.amount ?? 0) - (c.amount_refunded ?? 0), 0) / 100;
  const customers = new Set(charges.map((c) => c.customer).filter(Boolean)).size;
  return { orders: charges.length, revenue, avgOrderValue: ratio(revenue, charges.length), customers };
}

const isCounted = (c: Charge) => c.paid && c.status === "succeeded";

// Fetches the normalized commerce report for the connected account and period,
// plus the prior equal-length period for comparison. accountId = stripe account id.
export async function fetchStripeReport(accessToken: string, _accountId: string, periodDays: number): Promise<CommerceReport> {
  const DAY = 86400;
  const now = Math.floor(Date.now() / 1000);
  const untilUnix = now - DAY; // through yesterday
  const sinceUnix = now - periodDays * DAY;

  const [rawCharges, rawPrev] = await Promise.all([
    listCharges(accessToken, sinceUnix, untilUnix),
    listCharges(accessToken, now - periodDays * 2 * DAY, sinceUnix - 1).catch(() => [] as Charge[]),
  ]);
  const charges = rawCharges.filter(isCounted);
  const prevCharges = rawPrev.filter(isCounted);

  const byDay = new Map<string, CommerceDay>();
  for (let i = periodDays; i >= 1; i--) byDay.set(isoDay(i), { date: isoDay(i), orders: 0, revenue: 0 });
  for (const c of charges) {
    const date = new Date((c.created ?? 0) * 1000).toISOString().slice(0, 10);
    const day = byDay.get(date);
    if (day) {
      day.orders += 1;
      day.revenue += ((c.amount ?? 0) - (c.amount_refunded ?? 0)) / 100;
    }
  }

  return {
    platform: "stripe",
    currency: (charges[0]?.currency ?? "usd").toUpperCase(),
    totals: commerceTotals(charges),
    previousTotals: prevCharges.length ? commerceTotals(prevCharges) : null,
    byDate: Array.from(byDay.values()),
    topProducts: [], // charges carry no product line items; product breakdown omitted.
  };
}
