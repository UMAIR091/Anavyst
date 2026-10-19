import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, accountKey } from "@/lib/integrations/testing/fakeSupabase";

// Combining the same login signed in twice (the review page's choices).
// Credentials are only ever combined when the provider's own id proves both
// sign-ins are the same login, never on a matching name or email, and only
// when no client would lose access to its account.

const state = vi.hoisted(() => ({
  db: null as unknown as import("@/lib/integrations/testing/fakeSupabase").FakeDb,
  listed: {} as Record<string, string[]>,
}));

vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => s }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => state.db.client() }));
vi.mock("@/lib/agency", () => ({ getCurrentUserAndAgency: async () => ({ user: { id: "u-1" }, agency: { id: "ag-1" } }) }));
vi.mock("@/lib/billing/limits", () => ({ checkIntegrationLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/googleTokens", () => ({
  getValidAccessToken: async ({ connection }: { connection: { id: string } }) => `tok:${connection.id}`,
}));
vi.mock("@/lib/sync", () => ({ syncDataSource: async () => ({ ok: true }) }));
vi.mock("@/lib/integrationHealth", () => ({ revalidateIntegrationHealth: () => undefined }));
vi.mock("@/lib/errorLog", () => ({ logError: async () => undefined }));
vi.mock("@/lib/integrations/registry", () => {
  const def = {
    id: "meta_ads",
    name: "Meta Ads",
    accountNoun: "ad account",
    accountConfigKey: "account_id",
    listAccounts: async (token: string) => (state.listed[token.replace("tok:", "")] ?? []).map((id) => ({ id, name: `Account ${id}` })),
    buildConfig: (accounts: { id: string }[]) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
    readAccounts: (cfg: Record<string, unknown>) => (cfg.accounts as { id: string; name: string }[]) ?? [],
    readSelected: (cfg: Record<string, unknown>) => (cfg.account_id as string | null) ?? null,
  };
  return { SINGLE_ACCOUNT_TYPES: new Set(["gsc", "ga4"]), getIntegration: () => def, isLive: () => true };
});

import { POST } from "./route";

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  state.listed = {};
  db.rows("clients").push({ id: "c-1", agency_id: "ag-1" });
});

function conn(id: string, over: Record<string, unknown> = {}) {
  db.rows("connections").push({
    id, agency_id: "ag-1", type: "meta_ads", client_id: null, identity_provider: null, display_name: "Ali Umair",
    subject_hash: "same", status: "connected", access_token: `enc:${id}`, refresh_token: `enc:${id}`, token_expires_at: "2027-01-01", ...over,
  });
}
function source(id: string, client: string, connection: string, account: string) {
  db.rows("data_sources").push({
    id, agency_id: "ag-1", client_id: client, type: "meta_ads", connection_id: connection, status: "connected",
    config: { accounts: [{ id: account, name: `Account ${account}` }], account_id: account },
  });
}
const post = (fields: Record<string, string>) => {
  const body = new FormData();
  for (const [k, v] of Object.entries({ clientId: "c-1", ...fields })) body.set(k, v);
  return POST(new Request("https://app.test/api/connections/merge", { method: "POST", body }));
};
const errorOf = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("connect_error");

describe("renew: one sign-in from two copies of the same login", () => {
  beforeEach(() => {
    conn("saved");
    conn("fresh");
    source("ds-2", "c-2", "saved", "B");
    source("ds-1", "c-1", "fresh", "A");
  });

  it("combines them when the provider proves it's the same login and every account stays reachable", async () => {
    state.listed.fresh = ["A", "B"];
    const res = await post({ from: "fresh", into: "saved", mode: "renew" });
    expect(errorOf(res)).toBeNull();
    expect(db.connection("saved")).toMatchObject({ access_token: "enc:fresh", status: "connected" });
    expect(db.connection("fresh")).toBeUndefined();
    expect(db.rows("data_sources").map((r) => [r.id, r.connection_id, accountKey(r)])).toEqual([
      ["ds-2", "saved", "B"],
      ["ds-1", "saved", "A"],
    ]);
  });

  it("refuses when the names match but the provider can't confirm the login", async () => {
    db.connection("saved")!.subject_hash = null;
    db.connection("fresh")!.subject_hash = null;
    state.listed.fresh = ["A", "B"];
    const res = await post({ from: "fresh", into: "saved", mode: "renew" });
    expect(errorOf(res)).toContain("can't confirm these are the same login");
    expect(db.connection("saved")!.access_token).toBe("enc:saved");
    expect(db.connection("fresh")).toBeDefined();
  });

  it("refuses when another client would lose its account", async () => {
    state.listed.fresh = ["A"];
    const res = await post({ from: "fresh", into: "saved", mode: "renew" });
    expect(errorOf(res)).toContain("can't reach “Account B”");
    expect(db.connection("saved")!.access_token).toBe("enc:saved");
    expect(db.rows("data_sources").find((r) => r.id === "ds-1")!.connection_id).toBe("fresh");
  });
});

describe("reuse: this client moves onto the saved sign-in", () => {
  it("moves only this client's sources, once the saved sign-in is shown to reach them", async () => {
    conn("saved", { subject_hash: null });
    conn("fresh", { subject_hash: null });
    source("ds-2", "c-2", "saved", "B");
    source("ds-1", "c-1", "fresh", "A");
    state.listed.saved = ["A", "B"];
    const res = await post({ from: "fresh", into: "saved", mode: "reuse" });
    expect(errorOf(res)).toBeNull();
    expect(db.rows("data_sources").find((r) => r.id === "ds-1")!.connection_id).toBe("saved");
    expect(db.connection("fresh")).toBeUndefined();
    expect(db.connection("saved")!.access_token).toBe("enc:saved");
  });

  it("refuses when the saved sign-in can't reach this client's account", async () => {
    conn("saved");
    conn("fresh");
    source("ds-1", "c-1", "fresh", "A");
    state.listed.saved = ["B"];
    const res = await post({ from: "fresh", into: "saved", mode: "reuse" });
    expect(errorOf(res)).toContain("can't reach “Account A”");
    expect(db.rows("data_sources")[0].connection_id).toBe("fresh");
  });
});

describe("isolation", () => {
  it("never combines a client's own sign-in with the agency's", async () => {
    conn("saved");
    conn("fresh", { client_id: "c-1" });
    source("ds-1", "c-1", "fresh", "A");
    state.listed.fresh = ["A"];
    const res = await post({ from: "fresh", into: "saved", mode: "renew" });
    expect(errorOf(res)).toBe("Those sign-ins can't be combined.");
  });

  it("never touches another workspace's sign-in", async () => {
    conn("saved", { agency_id: "ag-2" });
    conn("fresh");
    source("ds-1", "c-1", "fresh", "A");
    const res = await post({ from: "fresh", into: "saved", mode: "reuse" });
    expect(errorOf(res)).toBe("Those sign-ins can't be combined.");
    expect(db.rows("data_sources")[0].connection_id).toBe("fresh");
  });
});
