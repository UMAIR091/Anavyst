import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, accountKey } from "@/lib/integrations/testing/fakeSupabase";

// Choosing a source's account, now that a client can have several accounts
// of one platform (migration 0049): only listed accounts, no second copy of
// an account, and a switch clears what was stored for the old account.

const state = vi.hoisted(() => ({ db: null as unknown as import("@/lib/integrations/testing/fakeSupabase").FakeDb }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from: (t: string) => state.db.client().from(t),
  }),
}));
vi.mock("@/lib/sync", () => ({ syncDataSource: async () => ({ ok: true }) }));
vi.mock("@/lib/integrations/connections", () => ({ loadOneSyncable: async (id: string) => ({ id }) }));
vi.mock("@/lib/integrationHealth", () => ({ revalidateIntegrationHealth: () => undefined }));
vi.mock("@/lib/integrations/registry", () => ({
  getIntegration: () => ({
    id: "meta_ads",
    accountNoun: "ad account",
    accountConfigKey: "account_id",
    readAccounts: (cfg: Record<string, unknown>) => (cfg.accounts as { id: string; name: string }[]) ?? [],
    readSelected: (cfg: Record<string, unknown>) => (cfg.account_id as string | null) ?? null,
  }),
}));

import { POST } from "./route";

let db: FakeDb;
const accounts = ["A", "B", "C"].map((id) => ({ id, name: `Account ${id}` }));
beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  for (const id of ["s1", "s2"]) db.rows("connections").push({ id, agency_id: "ag-1", type: "meta_ads", client_id: null, status: "connected" });
});
function source(id: string, connection: string, account: string | null) {
  db.rows("data_sources").push({
    id, agency_id: "ag-1", client_id: "c-1", type: "meta_ads", connection_id: connection, display_name: connection, status: "connected",
    config: { accounts, account_id: account },
  });
}
const save = (dataSourceId: string, accountId: string) =>
  POST(new Request("https://app.test/api/google/save-property", { method: "POST", body: JSON.stringify({ dataSourceId, accountId }) }));

describe("choosing an account", () => {
  it("only accepts one the sign-in listed", async () => {
    source("ds-1", "s1", null);
    const res = await save("ds-1", "Z");
    expect(res.status).toBe(400);
    expect(accountKey(db.rows("data_sources")[0])).toBe("");
  });

  it("moves an account the client already has onto the newer sign-in instead of copying it", async () => {
    source("ds-a", "s1", "A");
    source("ds-new", "s2", null);
    const res = await save("ds-new", "A");
    expect(await res.json()).toEqual({ ok: true, merged: true });
    expect(db.rows("data_sources").map((r) => [r.id, r.connection_id, accountKey(r)])).toEqual([["ds-a", "s2", "A"]]);
    // s1 had no other use.
    expect(db.connection("s1")).toBeUndefined();
    expect(db.clearedHistory).toEqual([]);
  });

  it("won't switch a working source to an account the client already has", async () => {
    source("ds-a", "s1", "A");
    source("ds-b", "s1", "B");
    const res = await save("ds-b", "A");
    expect(res.status).toBe(409);
    expect(db.rows("data_sources").map(accountKey)).toEqual(["A", "B"]);
  });

  it("clears what a source stored for its old account when it switches", async () => {
    source("ds-a", "s1", "A");
    const res = await save("ds-a", "C");
    expect(res.status).toBe(200);
    expect(accountKey(db.rows("data_sources")[0])).toBe("C");
    expect(db.clearedHistory).toEqual(["ds-a"]);
  });
});
