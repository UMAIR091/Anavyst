import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, accountKey } from "@/lib/integrations/testing/fakeSupabase";

// A client picking their account on a connect link: only on their own
// waiting source, never re-pointing what the agency connected itself.

const state = vi.hoisted(() => ({ db: null as unknown as import("@/lib/integrations/testing/fakeSupabase").FakeDb }));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/sync", () => ({ syncDataSource: async () => ({ ok: true }) }));
vi.mock("@/lib/integrations/connections", () => ({ loadOneSyncable: async (id: string) => ({ id }) }));
vi.mock("@/lib/integrationHealth", () => ({ revalidateIntegrationHealth: () => undefined }));
vi.mock("@/lib/rateLimit", () => ({ clientIp: () => "1.1.1.1", rateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/connectLinks", () => ({
  isLinkToken: () => true,
  linkConnectable: () => true,
  loadConnectLink: async () => ({
    ok: true,
    link: { id: "l1", agencyId: "ag-1", clientId: "c-1", types: ["meta_ads"], agency: { name: "Northstar" } },
  }),
}));
vi.mock("@/lib/integrations/registry", () => ({
  getIntegration: () => ({
    id: "meta_ads",
    name: "Meta Ads",
    accountNoun: "ad account",
    accountConfigKey: "account_id",
    readAccounts: (cfg: Record<string, unknown>) => (cfg.accounts as { id: string; name: string }[]) ?? [],
    readSelected: (cfg: Record<string, unknown>) => (cfg.account_id as string | null) ?? null,
  }),
}));

import { POST } from "./route";

let db: FakeDb;
const accounts = ["A", "B"].map((id) => ({ id, name: `Account ${id}` }));
beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  db.rows("connections").push({ id: "agency", agency_id: "ag-1", type: "meta_ads", client_id: null, status: "connected" });
  db.rows("connections").push({ id: "own", agency_id: "ag-1", type: "meta_ads", client_id: "c-1", status: "connected" });
});
function source(id: string, connection: string, account: string | null) {
  db.rows("data_sources").push({
    id, agency_id: "ag-1", client_id: "c-1", type: "meta_ads", connection_id: connection, status: "connected",
    config: { accounts, account_id: account },
  });
}
const pick = (accountId: string) => {
  const body = new FormData();
  body.set("token", "t");
  body.set("type", "meta_ads");
  body.set("accountId", accountId);
  return POST(new Request("https://app.test/api/connect-link/select", { method: "POST", body }));
};
const query = (res: Response) => new URL(res.headers.get("location")!).searchParams;

describe("a client's pick on a connect link", () => {
  it("lands on the client's own waiting source", async () => {
    source("ds-agency", "agency", "A");
    source("ds-own", "own", null);
    const res = await pick("B");
    expect(query(res).get("connected")).toBe("meta_ads");
    expect(db.rows("data_sources").map((r) => [r.id, r.connection_id, accountKey(r)])).toEqual([
      ["ds-agency", "agency", "A"],
      ["ds-own", "own", "B"],
    ]);
  });

  it("never re-points an account the agency connected itself", async () => {
    source("ds-agency", "agency", "A");
    source("ds-own", "own", null);
    const res = await pick("A");
    expect(query(res).get("error")).toContain("Northstar already has that ad account connected");
    expect(db.rows("data_sources").find((r) => r.id === "ds-agency")!.connection_id).toBe("agency");
  });

  it("needs the client's own sign-in first", async () => {
    source("ds-agency", "agency", null);
    const res = await pick("A");
    expect(query(res).get("error")).toBe("Connect Meta Ads first.");
  });
});
