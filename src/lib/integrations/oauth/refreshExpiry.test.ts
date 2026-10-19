import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// LinkedIn and Pinterest say when their refresh token itself runs out
// (refresh_token_expires_in); it is passed on so the sign-in can warn before
// a fresh sign-in is needed (migration 0052). Others say nothing.

const fetchMock = vi.fn();
beforeEach(() => {
  process.env.LINKEDIN_CLIENT_ID = "li";
  process.env.LINKEDIN_CLIENT_SECRET = "li-secret";
  process.env.PINTEREST_APP_ID = "pin";
  process.env.PINTEREST_APP_SECRET = "pin-secret";
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

import { linkedinOAuth } from "./linkedin";
import { pinterestOAuth } from "./pinterest";

describe("refresh token lifetimes", () => {
  it("LinkedIn: its fixed year", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "a", expires_in: 5184000, refresh_token: "r", refresh_token_expires_in: 31536000 }));
    expect(await linkedinOAuth.exchangeCode("code")).toMatchObject({ refresh_token: "r", refresh_expires_in: 31536000 });

    fetchMock.mockResolvedValueOnce(json({ access_token: "a2", expires_in: 5184000, refresh_token: "r", refresh_token_expires_in: 26000000 }));
    expect(await linkedinOAuth.refresh("r")).toMatchObject({ access_token: "a2", refresh_expires_in: 26000000 });
  });

  it("Pinterest: its rolling 60 days, with the replaced refresh token", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "a", expires_in: 2592000, refresh_token: "r2", refresh_token_expires_in: 5184000 }));
    expect(await pinterestOAuth.refresh("r1")).toMatchObject({ refresh_token: "r2", refresh_expires_in: 5184000 });
  });

  it("nothing when the provider doesn't say", async () => {
    fetchMock.mockResolvedValueOnce(json({ access_token: "a", expires_in: 5184000 }));
    expect(await linkedinOAuth.exchangeCode("code")).not.toHaveProperty("refresh_expires_in");
  });
});
