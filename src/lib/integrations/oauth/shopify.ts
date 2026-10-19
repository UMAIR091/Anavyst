// Shopify backend. Shopify OAuth is per-shop (the authorize URL lives on the
// shop's own domain), so connect/callback have dedicated routes that carry the
// shop domain through state; everything downstream (storage, sync, UI) is the
// shared pipeline. The offline access token never expires — revocation shows
// up as a 401 and surfaces as a reconnect prompt.
import crypto from "node:crypto";
import type { IntegrationAccount, OAuthProvider, TokenSet } from "../types";
import { isoDay, ratio, withRetry, type CommerceDay, type CommerceReport, type CommerceTotals } from "../metrics";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";
// Read-only commerce scopes; override if your app needs more.
const SCOPES = process.env.SHOPIFY_SCOPES || "read_orders,read_products";
const FIVE_YEARS = 5 * 365 * 24 * 60 * 60;

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

export function shopifyConfigured(): boolean {
  return Boolean(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET);
}

// Accepts "my-store", "my-store.myshopify.com" or a full URL; returns the
// canonical *.myshopify.com host or null when it can't be a shop domain.
export function normalizeShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!s) return null;
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

export function shopifyAuthUrl(shop: string, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env("SHOPIFY_API_KEY"),
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

// Shopify signs callback query strings with the app secret (hmac param over
// the remaining params, sorted). Constant-time comparison.
// Webhooks are signed differently from the install redirect: a base64
// HMAC-SHA256 of the raw request body, in X-Shopify-Hmac-Sha256.
export function verifyShopifyWebhook(rawBody: string, hmacHeader: string | null): boolean {
  if (!hmacHeader || !process.env.SHOPIFY_API_SECRET) return false;
  const digest = crypto.createHmac("sha256", process.env.SHOPIFY_API_SECRET).update(rawBody, "utf8").digest();
  const given = Buffer.from(hmacHeader, "base64");
  return given.length === digest.length && crypto.timingSafeEqual(given, digest);
}

export function verifyShopifyHmac(searchParams: URLSearchParams): boolean {
  const hmac = searchParams.get("hmac");
  if (!hmac) return false;
  const pairs: string[] = [];
  searchParams.forEach((value, key) => {
    if (key !== "hmac" && key !== "signature") pairs.push(`${key}=${value}`);
  });
  const message = pairs.sort().join("&");
  const digest = crypto.createHmac("sha256", env("SHOPIFY_API_SECRET")).update(message).digest("hex");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmac);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function exchangeShopifyCode(shop: string, code: string): Promise<TokenSet> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("SHOPIFY_API_KEY"), client_secret: env("SHOPIFY_API_SECRET"), code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Shopify token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  // Offline tokens don't expire and can't be refreshed — only re-authorized.
  return { access_token: data.access_token, expires_in: FIVE_YEARS };
}

// Registered so the generic machinery can resolve callbackPath and produce a
// clear reconnect message; the connect flow itself uses the dedicated routes.
export const shopifyOAuth: OAuthProvider = {
  id: "shopify",
  authUrl: () => {
    throw new Error("Shopify connects via /api/shopify/connect (needs a shop domain).");
  },
  exchangeCode: () => {
    throw new Error("Shopify code exchange requires the shop domain.");
  },
  refresh: async () => {
    throw new Error("Shopify access was revoked. Please reconnect the store.");
  },
  identity: async () => "Shopify store",
  callbackPath: "/api/shopify/callback",
};

async function shopifyGet<T>(shop: string, accessToken: string, path: string): Promise<{ body: T; link: string | null }> {
  return withRetry(async () => {
    const res = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });
    if (res.status === 429) throw new Error("Shopify rate limit (429)"); // withRetry backs off
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = (body as { errors?: unknown }).errors ?? res.statusText;
      throw new Error(`Shopify API error: ${typeof detail === "string" ? detail : JSON.stringify(detail)} (${res.status})`);
    }
    return { body: body as T, link: res.headers.get("link") };
  });
}

export async function getShopName(shop: string, accessToken: string): Promise<string> {
  try {
    const { body } = await shopifyGet<{ shop?: { name?: string } }>(shop, accessToken, "/shop.json");
    return body.shop?.name ? `${body.shop.name} (${shop})` : shop;
  } catch {
    return shop;
  }
}

type ShopifyOrder = {
  created_at?: string;
  total_price?: string;
  currency?: string;
  customer?: { id?: number };
  line_items?: { title?: string; quantity?: number; price?: string }[];
};

function nextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const m = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function listOrders(shop: string, accessToken: string, sinceIso: string, untilIso: string): Promise<ShopifyOrder[]> {
  const out: ShopifyOrder[] = [];
  let pageInfo: string | null = null;
  // Cap pagination so a huge store can't stall the sync (2,500 orders/period).
  for (let page = 0; page < 10; page++) {
    const params: string = pageInfo
      ? `limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `limit=250&status=any&created_at_min=${sinceIso}T00:00:00Z&created_at_max=${untilIso}T23:59:59Z&fields=created_at,total_price,currency,customer,line_items`;
    const { body, link } = await shopifyGet<{ orders?: ShopifyOrder[] }>(shop, accessToken, `/orders.json?${params}`);
    out.push(...(body.orders ?? []));
    pageInfo = nextPageInfo(link);
    if (!pageInfo) break;
  }
  return out;
}

function commerceTotals(orders: ShopifyOrder[]): CommerceTotals {
  const revenue = orders.reduce((s, o) => s + Number(o.total_price ?? 0), 0);
  const customers = new Set(orders.map((o) => o.customer?.id).filter(Boolean)).size;
  return { orders: orders.length, revenue, avgOrderValue: ratio(revenue, orders.length), customers };
}

// Fetches the normalized commerce report for one store and period, plus the
// prior equal-length period for comparison. accountId = the shop domain.
export async function fetchShopifyReport(accessToken: string, shop: string, periodDays: number): Promise<CommerceReport> {
  const since = isoDay(periodDays);
  const until = isoDay(1);
  const [orders, prevOrders] = await Promise.all([
    listOrders(shop, accessToken, since, until),
    listOrders(shop, accessToken, isoDay(periodDays * 2), isoDay(periodDays + 1)).catch((err) => {
      console.error(`[shopify] previous period: ${(err as Error).message}`);
      return [] as ShopifyOrder[];
    }),
  ]);

  const byDay = new Map<string, CommerceDay>();
  for (let i = periodDays; i >= 1; i--) byDay.set(isoDay(i), { date: isoDay(i), orders: 0, revenue: 0 });
  const products = new Map<string, { name: string; quantity: number; revenue: number }>();
  for (const o of orders) {
    const day = byDay.get((o.created_at ?? "").slice(0, 10));
    if (day) {
      day.orders += 1;
      day.revenue += Number(o.total_price ?? 0);
    }
    for (const li of o.line_items ?? []) {
      const name = li.title ?? "—";
      const p = products.get(name) ?? { name, quantity: 0, revenue: 0 };
      p.quantity += li.quantity ?? 0;
      p.revenue += Number(li.price ?? 0) * (li.quantity ?? 0);
      products.set(name, p);
    }
  }

  return {
    platform: "shopify",
    currency: orders[0]?.currency ?? "USD",
    totals: commerceTotals(orders),
    previousTotals: prevOrders.length ? commerceTotals(prevOrders) : null,
    byDate: Array.from(byDay.values()),
    topProducts: Array.from(products.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
  };
}
