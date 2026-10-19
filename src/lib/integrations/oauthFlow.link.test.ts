import { beforeEach, describe, expect, it, vi } from "vitest";

// Starting a sign-in from a client connect link (migration 0048). There is no
// Anavyst session, so the link is the authorization; these pin that a bad or
// out-of-scope request is sent back to the link page, and that a good one goes
// to the provider carrying the link in its state and the token in a cookie.

vi.hoisted(() => {
  process.env.META_APP_ID = "fb-app";
  process.env.META_APP_SECRET = "fb-secret";
  process.env.META_OAUTH_REDIRECT_URI = "https://tryreportflow.com/api/meta/callback";
  process.env.INSTAGRAM_APP_ID = "ig-app";
  process.env.INSTAGRAM_APP_SECRET = "ig-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://tryreportflow.com";
  delete process.env.LIVE_INTEGRATIONS;
});

const state = vi.hoisted(() => ({ link: null as unknown, existing: null as unknown, limitAllowed: true }));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const b = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: table === "connect_links" ? state.link : state.existing }),
        // The client's sources of the platform (several accounts are allowed).
        limit: async () => ({ data: state.existing ? [state.existing] : [] }),
      };
      return b;
    },
  }),
}));
vi.mock("@/lib/rateLimit", () => ({
  clientIp: () => "1.2.3.4",
  rateLimit: async () => ({ allowed: true, limit: 30, windowSeconds: 600 }),
}));
vi.mock("@/lib/billing/limits", () => ({
  checkIntegrationLimit: async () => ({ allowed: state.limitAllowed, reason: "limit" }),
}));

import { handleLinkConnect } from "./oauthFlow";
import { newLinkToken } from "@/lib/connectLinks";

const token = newLinkToken();
const start = (q: string) => handleLinkConnect(new Request(`https://tryreportflow.com/api/connect-link/start?${q}`));

beforeEach(() => {
  state.existing = null;
  state.limitAllowed = true;
  state.link = {
    id: "link-1",
    agency_id: "ag-1",
    client_id: "c-1",
    types: ["meta_ads", "instagram"],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    revoked_at: null,
    agencies: { name: "Bright Agency", logo_url: null, brand_color: null },
    clients: { name: "Acme", archived: false },
  };
});

describe("handleLinkConnect", () => {
  it("sends a valid request to the provider with the link in state and the token in a cookie", async () => {
    const res = await start(`token=${token}&type=meta_ads`);
    const to = new URL(res.headers.get("location")!);
    expect(to.hostname).toBe("www.facebook.com");
    const parsed = JSON.parse(Buffer.from(to.searchParams.get("state")!, "base64url").toString("utf8"));
    expect(parsed).toMatchObject({ clientId: "c-1", type: "meta_ads", linkId: "link-1" });
    // The token never goes to the provider.
    expect(to.toString()).not.toContain(token);
    const cookies = res.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/oauth_nonce=/);
    expect(cookies).toContain(`connect_link=${token}`);
    expect(cookies).toMatch(/HttpOnly/i);
  });

  it("sends an unknown or malformed link to the invalid-link page", async () => {
    state.link = null;
    expect((await start(`token=${token}&type=meta_ads`)).headers.get("location")).toBe(
      `https://tryreportflow.com/connect/${token}`
    );
    expect((await start("token=nope&type=meta_ads")).headers.get("location")).toBe("https://tryreportflow.com/connect/invalid");
  });

  it("refuses a platform the link doesn't name", async () => {
    const res = await start(`token=${token}&type=ga4`);
    expect(res.headers.get("location")).toContain(`/connect/${token}?error=`);
  });

  it("refuses the admin-only Instagram sign-in, but allows Instagram through Facebook", async () => {
    const denied = await start(`token=${token}&type=instagram&provider=instagram`);
    expect(denied.headers.get("location")).toContain("?error=");
    const allowed = await start(`token=${token}&type=instagram&provider=facebook`);
    expect(new URL(allowed.headers.get("location")!).hostname).toBe("www.facebook.com");
  });

  it("respects the agency's plan limit for a new platform", async () => {
    state.limitAllowed = false;
    const res = await start(`token=${token}&type=meta_ads`);
    expect(res.headers.get("location")).toContain("?error=");
  });

  it("lets a platform already connected sign in again (a further account is checked when added)", async () => {
    state.limitAllowed = false;
    state.existing = { id: "ds-1" };
    const res = await start(`token=${token}&type=meta_ads`);
    expect(new URL(res.headers.get("location")!).hostname).toBe("www.facebook.com");
  });
});
