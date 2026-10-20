import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/integrations/testing/fakeSupabase";

// "Remove everywhere": takes a sign-in off every client that uses it, only
// when the confirmation saw the current number of clients, cancels access at
// the platform through the shared revoke rules, and logs it.

const state = vi.hoisted(() => ({
  db: null as unknown as import("@/lib/integrations/testing/fakeSupabase").FakeDb,
  revoke: vi.fn(),
  events: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
    from: (t: string) => state.db.client().from(t),
  }),
}));
vi.mock("@/lib/integrations/revocation", () => ({ revokeSignIn: (...a: unknown[]) => state.revoke(...a) }));
vi.mock("@/lib/integrations/connectionEvents", () => ({
  logConnectionEvent: async (e: Record<string, unknown>) => void state.events.push(e),
}));
vi.mock("@/lib/integrationHealth", () => ({ revalidateIntegrationHealth: () => undefined }));

import { POST } from "./route";

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  state.events = [];
  state.revoke.mockReset().mockResolvedValue("revoked");
  db.rows("connections").push({ id: "s1", agency_id: "ag-1", type: "meta_ads", client_id: null, display_name: "Ali", identity_provider: null, status: "connected" });
  db.rows("connections").push({ id: "s2", agency_id: "ag-1", type: "meta_ads", client_id: null, display_name: "Other", identity_provider: null, status: "connected" });
  for (const [id, client, conn, acct] of [["d1", "c1", "s1", "A"], ["d2", "c2", "s1", "B"], ["d3", "c1", "s2", "C"]]) {
    db.rows("data_sources").push({ id, agency_id: "ag-1", client_id: client, type: "meta_ads", connection_id: conn, status: "connected", config: { account_id: acct } });
  }
});
const remove = (body: object) =>
  POST(new Request("https://app.test/api/connections/remove", { method: "POST", body: JSON.stringify(body) }));

describe("remove everywhere", () => {
  it("removes the sign-in from every client on it, and nothing else", async () => {
    const res = await remove({ connectionId: "s1", expectedClients: 2 });
    expect(await res.json()).toEqual({ ok: true, removedSources: 2, revoked: "revoked" });
    expect(db.rows("data_sources").map((r) => r.id)).toEqual(["d3"]);
    expect(db.rows("connections").map((r) => r.id)).toEqual(["s2"]);
    expect(state.revoke).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      agencyId: "ag-1", connectionId: "s1", excludeSourceIds: ["d1", "d2"],
    }));
    expect(state.events).toEqual([expect.objectContaining({ action: "remove_sign_in", connectionId: "s1", detail: expect.objectContaining({ clients: 2 }) })]);
  });

  it("refuses when more clients use it than the confirmation showed", async () => {
    const res = await remove({ connectionId: "s1", expectedClients: 1 });
    expect(res.status).toBe(409);
    expect(db.rows("data_sources")).toHaveLength(3);
    expect(state.revoke).not.toHaveBeenCalled();
  });

  it("needs the count it was shown", async () => {
    expect((await remove({ connectionId: "s1" })).status).toBe(400);
    expect((await remove({ connectionId: "nope", expectedClients: 0 })).status).toBe(404);
  });
});
