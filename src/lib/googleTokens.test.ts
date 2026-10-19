import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Tokens live on the shared sign-in (migrations 0046/0047), refreshed with the
// service role. Long-lived tokens that renew themselves only while still valid
// (Business Login for Instagram) used to be renewed in the last minute before
// expiry, so a once-a-day sync found them already expired and the connection
// died. These pin the early renewal, that it stays best-effort, and that the
// sign-in (never the client's row) is what gets refreshed.

const refresh = vi.fn();
// Set to make the next renewal fail. A plain throw rather than a vi.fn()
// implementation: Vitest reports an error thrown by a mock as a test failure
// even after the code under test has caught it.
let failRenewal: Error | null = null;
const renew = async (...args: unknown[]) => {
  if (failRenewal) throw failRenewal;
  return refresh(...args);
};
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("@/lib/google", () => ({ refreshAccessToken: vi.fn() }));
vi.mock("@/lib/integrations/registry", () => ({
  oauthForType: (type: string) =>
    type === "instagram"
      ? { refresh: renew, renewal: (ctx?: { provider?: string }) => (ctx?.provider === "instagram" ? "extend" : "reconnect") }
      : { refresh: renew },
}));
const admin = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.db }));

import { getValidAccessToken } from "./googleTokens";

const DAY = 24 * 60 * 60 * 1000;
type Row = Record<string, unknown> & { id: string };

// Just enough of the Supabase query builder for googleTokens: the lease update
// (…maybeSingle), the token re-read (select…maybeSingle) and plain updates.
function fakeDb(row: Row) {
  const writes: Record<string, unknown>[] = [];
  const from = (table: string) => {
    let op: "select" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const b = {
      update(p: Record<string, unknown>) { op = "update"; payload = p; return b; },
      select() { return b; },
      eq() { return b; },
      or() { return b; },
      maybeSingle: async () => ({ data: op === "update" ? { id: row.id } : { ...row } }),
      then(resolve: (v: unknown) => unknown) {
        if (op === "update") {
          writes.push({ table, ...payload });
          if (payload.access_token) Object.assign(row, payload);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return b;
  };
  return { db: { from } as unknown as SupabaseClient, writes };
}

// A client's source on a shared sign-in expiring in `daysLeft` days. The
// sign-in's fake database is installed as the service-role client.
function source(type: string, daysLeft: number, provider?: string) {
  const signIn: Row = {
    id: "conn1",
    identity_provider: provider ?? null,
    access_token: "enc:current",
    refresh_token: "enc:current",
    token_expires_at: new Date(Date.now() + daysLeft * DAY).toISOString(),
  };
  const shared = fakeDb(signIn);
  admin.db = shared.db;
  return { row: { id: "ds1", type, config: {}, connection: signIn }, writes: shared.writes };
}

beforeEach(() => {
  refresh.mockReset();
  failRenewal = null;
});

describe("early renewal of self-extending tokens", () => {
  it("renews an Instagram sign-in token once fewer than 10 days are left", async () => {
    refresh.mockResolvedValue({ access_token: "renewed", refresh_token: "renewed", expires_in: 60 * 86400 });
    const { row, writes } = source("instagram", 5, "instagram");
    expect(await getValidAccessToken(row as never)).toBe("renewed");
    expect(refresh).toHaveBeenCalledWith("current", { provider: "instagram" });
    const saved = writes.find((w) => w.access_token);
    expect(saved?.table).toBe("connections");
    expect(saved?.access_token).toBe("enc:renewed");
    expect(new Date(saved?.token_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 59 * DAY);
  });

  it("leaves it alone while more than 10 days are left", async () => {
    const { row } = source("instagram", 20, "instagram");
    expect(await getValidAccessToken(row as never)).toBe("current");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("keeps using the current token when an early renewal fails", async () => {
    failRenewal = new Error("Instagram API error: temporarily unavailable");
    const { row } = source("instagram", 5, "instagram");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getValidAccessToken(row as never)).toBe("current");
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("other tokens are unchanged", () => {
  it("doesn't touch a Facebook sign-in token early (it can't be extended)", async () => {
    const { row } = source("instagram", 5, "facebook");
    expect(await getValidAccessToken(row as never)).toBe("current");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("still refreshes an expired refresh-token sign-in, and still fails loudly", async () => {
    refresh.mockResolvedValueOnce({ access_token: "fresh", expires_in: 3600 });
    const { row } = source("gsc", -0.01);
    expect(await getValidAccessToken(row as never)).toBe("fresh");

    failRenewal = new Error("invalid_grant");
    const dead = source("gsc", -0.01);
    await expect(getValidAccessToken(dead.row as never)).rejects.toThrow("invalid_grant");
  });

  it("saves when the refresh token itself runs out, when the provider says (LinkedIn, Pinterest)", async () => {
    refresh.mockResolvedValueOnce({ access_token: "fresh", refresh_token: "rt2", expires_in: 3600, refresh_expires_in: 300 * 86400 });
    const { row, writes } = source("linkedin_ads", -0.01);
    await getValidAccessToken(row as never);
    const saved = writes.find((w) => w.access_token)!;
    expect(saved.refresh_token).toBe("enc:rt2");
    expect(new Date(saved.refresh_expires_at as string).getTime()).toBeGreaterThan(Date.now() + 299 * DAY);

    refresh.mockResolvedValueOnce({ access_token: "fresh", expires_in: 3600 });
    const other = source("gsc", -0.01);
    await getValidAccessToken(other.row as never);
    expect(other.writes.find((w) => w.access_token)).not.toHaveProperty("refresh_expires_at");
  });
});

describe("shared sign-ins", () => {
  it("takes the sign-in route from the sign-in when the client's row records none", async () => {
    refresh.mockResolvedValue({ access_token: "renewed", refresh_token: "renewed", expires_in: 60 * 86400 });
    const { row, writes } = source("instagram", 5, "instagram");
    expect(await getValidAccessToken({ ...row, config: {} } as never)).toBe("renewed");
    expect(refresh).toHaveBeenCalledWith("current", { provider: "instagram" });
    expect(writes.filter((w) => w.access_token).map((w) => w.table)).toEqual(["connections"]);
  });

  it("asks for a reconnect when a source has no saved sign-in", async () => {
    await expect(getValidAccessToken({ id: "ds1", type: "gsc", config: {}, connection: null } as never)).rejects.toThrow(
      "no saved sign-in"
    );
  });
});
