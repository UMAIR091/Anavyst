import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchInstagramReport, instagramOAuth, listInstagramAccounts } from "./instagram";
import { availableIdentityProviders, getIntegration } from "../registry";

// Instagram has three sign-in routes: two Facebook Logins, business and personal
// (graph.facebook.com, via a linked Facebook Page), and Business Login for
// Instagram (graph.instagram.com).
// These pin that each route reaches its own endpoints, and that connections
// made before the Instagram route existed keep using Facebook.

const fetchMock = vi.fn();
beforeEach(() => {
  process.env.META_APP_ID = "fb-app";
  process.env.META_APP_SECRET = "fb-secret";
  process.env.META_OAUTH_REDIRECT_URI = "https://tryreportflow.com/api/meta/callback";
  process.env.INSTAGRAM_APP_ID = "ig-app";
  process.env.INSTAGRAM_APP_SECRET = "ig-secret";
  delete process.env.META_INSTAGRAM_CONFIG_ID;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urlOf = (i: number) => new URL(String(fetchMock.mock.calls[i][0]));
const stateFor = (provider?: string) =>
  Buffer.from(JSON.stringify({ clientId: "c", nonce: "n", type: "instagram", provider })).toString("base64url");

describe("authUrl", () => {
  it("sends the Instagram route to instagram.com, asking which account every time", () => {
    const url = new URL(instagramOAuth.authUrl(stateFor("instagram")));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("ig-app");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic,instagram_business_manage_insights");
    expect(url.searchParams.get("force_reauth")).toBe("true");
    expect(url.searchParams.get("enable_fb_login")).toBe("false");
    expect(url.searchParams.get("redirect_uri")).toBe("https://tryreportflow.com/api/meta/callback");
  });

  it("keeps the Facebook route, and connections with no provider, on Facebook Login", () => {
    for (const p of ["facebook", undefined]) {
      const url = new URL(instagramOAuth.authUrl(stateFor(p)));
      expect(url.hostname).toBe("www.facebook.com");
      expect(url.searchParams.get("client_id")).toBe("fb-app");
      expect(url.searchParams.get("scope")).toContain("instagram_manage_insights");
    }
  });
});

describe("Instagram route tokens", () => {
  it("exchanges the code, then upgrades it to a 60-day token", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ data: [{ access_token: "short", user_id: "1", permissions: "instagram_business_basic" }] }))
      .mockResolvedValueOnce(json({ access_token: "long", token_type: "bearer", expires_in: 5183944 }));
    const t = await instagramOAuth.exchangeCode("code", { provider: "instagram" });
    expect(t).toEqual({ access_token: "long", refresh_token: "long", expires_in: 5183944 });

    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.instagram.com/oauth/access_token");
    const body = fetchMock.mock.calls[0][1].body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("client_secret")).toBe("ig-secret");
    expect(body.get("redirect_uri")).toBe("https://tryreportflow.com/api/meta/callback");

    expect(urlOf(1).origin + urlOf(1).pathname).toBe("https://graph.instagram.com/access_token");
    expect(urlOf(1).searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(urlOf(1).searchParams.get("access_token")).toBe("short");
  });

  it("accepts the older unwrapped token response", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "short", user_id: 1 }))
      .mockResolvedValueOnce(json({ access_token: "long", expires_in: 100 }));
    expect((await instagramOAuth.exchangeCode("code", { provider: "instagram" })).access_token).toBe("long");
  });

  it("surfaces Instagram's error message", async () => {
    fetchMock.mockResolvedValueOnce(json({ error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" }, 400));
    await expect(instagramOAuth.exchangeCode("bad", { provider: "instagram" })).rejects.toThrow("Instagram API error: Invalid authorization code");
  });

  it("refreshes with ig_refresh_token, and Facebook connections with fb_exchange_token", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "fresh", expires_in: 5183944 }));
    expect((await instagramOAuth.refresh("long", { provider: "instagram" })).access_token).toBe("fresh");
    expect(urlOf(0).origin + urlOf(0).pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(urlOf(0).searchParams.get("grant_type")).toBe("ig_refresh_token");

    fetchMock.mockResolvedValueOnce(json({ access_token: "fb-fresh", expires_in: 5183944 }));
    await instagramOAuth.refresh("fb-long");
    expect(urlOf(1).hostname).toBe("graph.facebook.com");
    expect(urlOf(1).searchParams.get("grant_type")).toBe("fb_exchange_token");
  });
});

describe("accounts and report", () => {
  it("lists exactly the signed-in account, by its professional account id", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "app-scoped-9", user_id: "17841400000000001", username: "acme" }));
    expect(await listInstagramAccounts("tok", "instagram")).toEqual([{ id: "17841400000000001", name: "@acme" }]);
    expect(urlOf(0).hostname).toBe("graph.instagram.com");
    expect(urlOf(0).pathname).toBe("/v25.0/me");
  });

  it("reads the report from graph.instagram.com without the website field", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      const u = new URL(input);
      if (u.pathname.endsWith("/17841400000000001")) return json({ id: "17841400000000001", username: "acme", followers_count: 10 });
      return json({ data: [] });
    });
    const report = await fetchInstagramReport("tok", "17841400000000001", 7, "instagram");
    expect(report.profile.username).toBe("acme");
    const hosts = new Set(fetchMock.mock.calls.map((c) => new URL(String(c[0])).hostname));
    expect([...hosts]).toEqual(["graph.instagram.com"]);
    const profileCall = fetchMock.mock.calls.map((c) => new URL(String(c[0]))).find((u) => u.pathname.endsWith("/17841400000000001"))!;
    expect(profileCall.searchParams.get("fields")).not.toContain("website");
    expect(profileCall.searchParams.get("appsecret_proof")).toBeNull();
  });
});

describe("sign-in options", () => {
  const def = getIntegration("instagram")!;

  it("shows the Instagram option to platform admins only, until Meta approves it", () => {
    expect(availableIdentityProviders(def, true).map((p) => p.id)).toEqual(["instagram", "facebook"]);
    expect(availableIdentityProviders(def, false).map((p) => p.id)).toEqual(["facebook"]);
  });

  it("puts the business Facebook login first once its configuration is set, keeping the personal one", () => {
    process.env.META_INSTAGRAM_CONFIG_ID = "1095318549962378";
    expect(availableIdentityProviders(def, true).map((p) => p.id)).toEqual(["instagram", "business", "facebook"]);
    expect(availableIdentityProviders(def, false).map((p) => p.id)).toEqual(["business", "facebook"]);
  });

  it("hides the Instagram option while its app credentials are missing", () => {
    delete process.env.INSTAGRAM_APP_SECRET;
    expect(availableIdentityProviders(def, true).map((p) => p.id)).toEqual(["facebook"]);
  });
});
