import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaOAuth, metaDialogUrl } from "./meta";
import { instagramOAuth } from "./instagram";
import { availableIdentityProviders, getIntegration, signInButton, signInRouteOf } from "../registry";

// Facebook Login for Business configurations (18 Oct 2026): on the business
// route the dialog is opened with config_id and the code exchanges for a
// business system-user token that never expires. The personal route keeps a
// person's ~60-day token, for accounts outside any Business portfolio. These
// pin the dialog URL either way, the buttons, and how each token comes back.

const fetchMock = vi.fn();
beforeEach(() => {
  process.env.META_APP_ID = "fb-app";
  process.env.META_APP_SECRET = "fb-secret";
  process.env.META_OAUTH_REDIRECT_URI = "https://tryreportflow.com/api/meta/callback";
  delete process.env.META_ADS_CONFIG_ID;
  delete process.env.META_INSTAGRAM_CONFIG_ID;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const urlOf = (i: number) => new URL(String(fetchMock.mock.calls[i][0]));
const stateFor = (provider?: string, type = "instagram") =>
  Buffer.from(JSON.stringify({ clientId: "c", nonce: "n", type, provider })).toString("base64url");

describe("login dialog", () => {
  it("opens the Ads configuration instead of scopes on the business route", () => {
    process.env.META_ADS_CONFIG_ID = "1796014487969309";
    const url = new URL(metaOAuth.authUrl(stateFor("business", "meta_ads")));
    expect(url.searchParams.get("config_id")).toBe("1796014487969309");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("keeps the personal route, and sign-ins saved with no route, on the plain scoped login", () => {
    process.env.META_ADS_CONFIG_ID = "1796014487969309";
    for (const p of ["personal", undefined]) {
      const url = new URL(metaOAuth.authUrl(stateFor(p, "meta_ads")));
      expect(url.searchParams.get("scope")).toBe("ads_read,business_management");
      expect(url.searchParams.has("config_id")).toBe(false);
      expect(url.searchParams.has("override_default_response_type")).toBe(false);
    }
  });

  it("falls back to the plain scoped login when no configuration is set", () => {
    const url = new URL(metaOAuth.authUrl(stateFor("business", "meta_ads")));
    expect(url.searchParams.get("scope")).toBe("ads_read,business_management");
    expect(url.searchParams.has("config_id")).toBe(false);
  });

  it("gives Instagram's business route its own configuration, and its personal route none", () => {
    process.env.META_INSTAGRAM_CONFIG_ID = "1095318549962378";
    process.env.META_ADS_CONFIG_ID = "1796014487969309";
    const business = new URL(instagramOAuth.authUrl(stateFor("business")));
    expect(business.searchParams.get("config_id")).toBe("1095318549962378");
    const personal = new URL(instagramOAuth.authUrl(stateFor("facebook")));
    expect(personal.searchParams.has("config_id")).toBe(false);
    expect(personal.searchParams.get("scope")).toContain("instagram_manage_insights");
    expect(new URL(metaDialogUrl("s", ["x"], "ads", true)).searchParams.get("config_id")).toBe("1796014487969309");
  });
});

describe("sign-in options", () => {
  const def = getIntegration("meta_ads")!;
  const shown = () => availableIdentityProviders(def, false);

  it("offers the business login first, with the personal one as the fallback", () => {
    process.env.META_ADS_CONFIG_ID = "1796014487969309";
    expect(shown().map((p) => p.id)).toEqual(["business", "personal"]);
    expect(shown().map((p, i) => signInButton(p, i))).toEqual([
      { label: "Continue with Facebook", secondary: false },
      { label: "Use a personal Facebook account instead", secondary: true },
    ]);
  });

  it("leaves only the personal login, as a plain button, without the configuration", () => {
    expect(shown().map((p) => p.id)).toEqual(["personal"]);
    expect(signInButton(shown()[0], 0)).toEqual({ label: "Continue with Facebook", secondary: false });
  });

  it("treats sign-ins saved before the choice existed as personal ones", () => {
    expect(signInRouteOf(def, null)?.id).toBe("personal");
    expect(signInRouteOf(def, "business")?.via).toBe("Facebook (business)");
    expect(signInRouteOf(getIntegration("instagram")!, null)?.id).toBe("facebook");
    expect(signInRouteOf(getIntegration("gsc")!, null)).toBeUndefined();
  });
});

describe("code exchange", () => {
  it("keeps a business system-user token as never expiring, with no 60-day upgrade", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "suat", token_type: "bearer" }))
      .mockResolvedValueOnce(json({ client_business_id: "biz-1", id: "su-1" }))
      .mockResolvedValueOnce(json({ name: "Acme Ltd", id: "biz-1" }));
    const t = await metaOAuth.exchangeCode("code");
    expect(t.access_token).toBe("suat");
    expect(t.refresh_token).toBeUndefined();
    expect(t.expires_in).toBeGreaterThan(50 * 365 * 24 * 60 * 60);
    expect(fetchMock.mock.calls.map((c) => new URL(String(c[0])).searchParams.get("grant_type"))).not.toContain("fb_exchange_token");
  });

  it("still upgrades a person's token to a long-lived one", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ access_token: "short" }))
      .mockResolvedValueOnce(json({ error: { message: "(#100) Tried accessing nonexisting field (client_business_id)" } }, 400))
      .mockResolvedValueOnce(json({ access_token: "long", expires_in: 5184000 }));
    const t = await metaOAuth.exchangeCode("code");
    expect(t).toEqual({ access_token: "long", refresh_token: "long", expires_in: 5184000 });
    expect(urlOf(2).searchParams.get("grant_type")).toBe("fb_exchange_token");
  });
});

describe("identity", () => {
  it("names the business for a system-user token, and the person otherwise", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ client_business_id: "biz-1" }))
      .mockResolvedValueOnce(json({ name: "Acme Ltd" }));
    expect(await metaOAuth.identity("suat")).toBe("Acme Ltd (business)");

    fetchMock
      .mockResolvedValueOnce(json({ error: { message: "nonexisting field" } }, 400))
      .mockResolvedValueOnce(json({ name: "Ali Umair" }));
    expect(await metaOAuth.identity("user-token")).toBe("Ali Umair");
  });
});
