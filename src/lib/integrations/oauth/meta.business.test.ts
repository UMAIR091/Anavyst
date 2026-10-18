import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaOAuth, metaDialogUrl } from "./meta";
import { instagramOAuth } from "./instagram";

// Facebook Login for Business configurations (18 Oct 2026): the dialog is
// opened with config_id and the code exchanges for a business system-user
// token that never expires, instead of a person's ~60-day token. These pin
// the dialog URL either way, and how each kind of token comes back.

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
const stateFor = (provider?: string) =>
  Buffer.from(JSON.stringify({ clientId: "c", nonce: "n", type: "instagram", provider })).toString("base64url");

describe("login dialog", () => {
  it("uses the Ads configuration instead of scopes when it is set", () => {
    process.env.META_ADS_CONFIG_ID = "1796014487969309";
    const url = new URL(metaOAuth.authUrl("s"));
    expect(url.searchParams.get("config_id")).toBe("1796014487969309");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("override_default_response_type")).toBe("true");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("falls back to the plain scoped login when no configuration is set", () => {
    const url = new URL(metaOAuth.authUrl("s"));
    expect(url.searchParams.get("scope")).toBe("ads_read,business_management");
    expect(url.searchParams.has("config_id")).toBe(false);
  });

  it("gives Instagram's Facebook route its own configuration", () => {
    process.env.META_INSTAGRAM_CONFIG_ID = "1095318549962378";
    process.env.META_ADS_CONFIG_ID = "1796014487969309";
    const url = new URL(instagramOAuth.authUrl(stateFor("facebook")));
    expect(url.searchParams.get("config_id")).toBe("1095318549962378");
    expect(new URL(metaDialogUrl("s", ["x"], "ads")).searchParams.get("config_id")).toBe("1796014487969309");
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
