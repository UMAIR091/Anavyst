import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/integrations/testing/fakeSupabase";

// A shared sign-in serves many clients' accounts. Meta reports a missing
// permission on one ad account with the same OAuthException as a dead token,
// and treating that as "the sign-in expired" stopped every client on it. These
// pin that the sync tells the two apart (by listing the sign-in's accounts),
// and that it never fetches with a sign-in that isn't the source's own.

const state = vi.hoisted(() => ({
  db: null as unknown as import("@/lib/integrations/testing/fakeSupabase").FakeDb,
  fetchSnapshot: vi.fn(),
  listAccounts: vi.fn(),
  subject: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => s }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/billing/limits", () => ({ checkIntegrationLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/archivedClients", () => ({ isSourceClientPaused: async () => false, ARCHIVED_CLIENT_ERROR: "paused" }));
vi.mock("@/lib/usage", () => ({ trackUsage: async () => undefined }));
vi.mock("@/lib/googleTokens", () => ({ getValidAccessToken: async () => "tok" }));
vi.mock("@/lib/errorLog", () => ({ logError: async () => undefined }));
vi.mock("@/lib/metrics/history", () => ({ recordDailyMetrics: async () => ({}) }));
vi.mock("@/lib/integrations/registry", () => ({
  SINGLE_ACCOUNT_TYPES: new Set(["gsc", "ga4"]),
  oauthForType: () => ({ subject: (...a: unknown[]) => state.subject(...a) }),
  getIntegration: () => ({
    id: "meta_ads",
    name: "Meta Ads",
    accountNoun: "ad account",
    accountConfigKey: "account_id",
    snapshotTable: "integration_snapshots",
    fetchSnapshot: (...a: unknown[]) => state.fetchSnapshot(...a),
    listAccounts: (...a: unknown[]) => state.listAccounts(...a),
    readAccounts: (cfg: Record<string, unknown>) => (cfg.accounts as { id: string; name: string }[]) ?? [],
    readSelected: (cfg: Record<string, unknown>) => (cfg.account_id as string | null) ?? null,
  }),
}));

import { accountReach, syncDataSource, type SyncableSource } from "./sync";
import { subjectHash } from "@/lib/integrations/connections";

let db: FakeDb;
const conn = { id: "s1", agency_id: "ag-1", type: "meta_ads", client_id: null, identity_provider: null, access_token: "x", refresh_token: "x", token_expires_at: null, status: "connected" };
const source = (over: Partial<SyncableSource> = {}): SyncableSource => ({
  id: "ds-1", agency_id: "ag-1", client_id: "c-1", type: "meta_ads", connection_id: "s1",
  config: { accounts: [{ id: "A", name: "Acme UK" }], account_id: "A" }, connection: { ...conn }, ...over,
});

beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  state.fetchSnapshot.mockReset();
  state.listAccounts.mockReset();
  state.subject.mockReset();
  db.rows("connections").push({ ...conn });
  for (const [id, client, account] of [["ds-1", "c-1", "A"], ["ds-2", "c-2", "B"]]) {
    db.rows("data_sources").push({
      id, agency_id: "ag-1", client_id: client, type: "meta_ads", connection_id: "s1", status: "connected",
      config: { accounts: [{ id: account, name: `Acct ${account}` }], account_id: account },
    });
  }
});

const row = (id: string) => db.rows("data_sources").find((r) => r.id === id)!;

describe("an auth-looking failure on one account", () => {
  it("stays on that source when the sign-in still works and no longer lists the account", async () => {
    state.fetchSnapshot.mockRejectedValue(new Error("Meta API error: (#200) OAuthException: Ad account owner has NOT granted ads_read"));
    state.listAccounts.mockResolvedValue([{ id: "B", name: "Acct B" }]);

    const res = await syncDataSource(db.client(), source());
    expect(res.ok).toBe(false);
    expect(row("ds-1").status).toBe("error");
    expect(row("ds-1").last_sync_error).toContain("can't access the ad account “Acme UK”");
    // The sign-in and the other client on it carry on.
    expect(db.connection("s1")!.status).toBe("connected");
    expect(row("ds-2").status).toBe("connected");
  });

  it("says the provider refused it when the account is still listed", async () => {
    state.fetchSnapshot.mockRejectedValue(new Error("OAuthException: (#10) permission denied"));
    state.listAccounts.mockResolvedValue([{ id: "A", name: "Acme UK" }]);
    await syncDataSource(db.client(), source());
    expect(row("ds-1").status).toBe("error");
    expect(row("ds-1").last_sync_error).toMatch(/^Meta Ads refused access to “Acme UK”: OAuthException/);
    expect(db.connection("s1")!.status).toBe("connected");
  });

  it("expires the sign-in for every client when the token itself is dead", async () => {
    const dead = new Error("OAuthException code 190: Error validating access token: Session has expired");
    state.fetchSnapshot.mockRejectedValue(dead);
    state.listAccounts.mockRejectedValue(dead);
    await syncDataSource(db.client(), source());
    expect(row("ds-1").status).toBe("revoked");
    expect(row("ds-2").status).toBe("revoked");
    expect(db.connection("s1")!.status).toBe("revoked");
  });
});

describe("a sign-in that isn't the source's own", () => {
  it.each([
    ["another workspace's", { agency_id: "ag-2" }],
    ["another client's", { client_id: "c-9" }],
    ["another platform's", { type: "google_ads" }],
  ])("is never used: %s", async (_label, mismatch) => {
    const res = await syncDataSource(db.client(), source({ connection: { ...conn, ...mismatch } }));
    expect(res.ok).toBe(false);
    expect(state.fetchSnapshot).not.toHaveBeenCalled();
    expect(row("ds-1").status).toBe("error");
  });
});

describe("accountReach", () => {
  it("only reports a dead token when listing fails the same way", async () => {
    const def = (impl: () => Promise<{ id: string }[]>) => ({ listAccounts: impl });
    expect(await accountReach(def(async () => [{ id: "A" }]), "t", "A")).toBe("listed");
    expect(await accountReach(def(async () => []), "t", "A")).toBe("not_listed");
    expect(await accountReach(def(async () => { throw new Error("invalid_grant"); }), "t", "A")).toBe("token_dead");
    // A listing hiccup is no proof the token died.
    expect(await accountReach(def(async () => { throw new Error("503 Service Unavailable"); }), "t", "A")).toBe("listed");
  });
});

describe("a sign-in saved before who-signed-in was recorded", () => {
  it("learns its login id on the next successful sync, once", async () => {
    state.fetchSnapshot.mockResolvedValue({ totals: {} });
    state.subject.mockResolvedValue("meta-user:7");
    db.connection("s1")!.subject_hash = null;
    const res = await syncDataSource(db.client(), source({ connection: { ...conn, subject_hash: null } }));
    expect(res.ok).toBe(true);
    expect(db.connection("s1")!.subject_hash).toBe(subjectHash("meta_ads", "meta-user:7"));

    // Already recorded: not asked again.
    state.subject.mockClear();
    await syncDataSource(db.client(), source({ connection: { ...conn, subject_hash: "known" } }));
    expect(state.subject).not.toHaveBeenCalled();
  });
});
