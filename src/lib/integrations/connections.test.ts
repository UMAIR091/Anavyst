import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationAccount, IntegrationDef } from "./types";
import { FakeDb, accountKey } from "./testing/fakeSupabase";

// Shared agency sign-ins (0046), one source per ACCOUNT (0049). These run
// saveSignIn / placeSource against an in-memory database that enforces the
// real rules (unique account per client, the sign-in foreign key, a client's
// own sign-in, unused sign-ins deleted), and pin:
//   - several accounts of one platform per client, and old connections
//     working unchanged before and after 0051;
//   - the same login signed in twice recognised by the provider's id only;
//   - a renewal restoring every client it can, naming the accounts it can't,
//     and never taking another person's login;
//   - a connect-link sign-in never re-pointing the agency's own sources.

vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
const state = vi.hoisted(() => ({ db: null as unknown as import("./testing/fakeSupabase").FakeDb, limitOk: true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/billing/limits", () => ({
  checkIntegrationLimit: async () => ({ allowed: state.limitOk, reason: "Your Trial plan allows 1 integration per client." }),
}));

import { duplicatesOf, isShareable, placeSource, saveSignIn, subjectHash } from "./connections";
import { getIntegration } from "./registry";
import { UserFacingError } from "@/lib/errors";

const listed = (ids: string[]): IntegrationAccount[] => ids.map((id) => ({ id, name: `Account ${id}` }));
const def = {
  id: "meta_ads",
  name: "Meta Ads",
  accountNoun: "ad account",
  accountConfigKey: "account_id",
  listAccounts: async () => [],
  buildConfig: (accounts: IntegrationAccount[]) => ({ accounts, account_id: accounts.length === 1 ? accounts[0].id : null }),
  readAccounts: (cfg: Record<string, unknown>) => (cfg.accounts as IntegrationAccount[] | undefined) ?? [],
  readSelected: (cfg: Record<string, unknown>) => (cfg.account_id as string | null | undefined) ?? null,
} as unknown as IntegrationDef;
const tokens = { accessToken: "tok", refreshToken: "tok", expiresAt: "2026-12-15T00:00:00.000Z" };

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  state.limitOk = true;
});

function seedConnection(c: Partial<Record<string, unknown>> & { id: string }) {
  db.rows("connections").push({
    agency_id: "ag-1", type: "meta_ads", client_id: null, identity_provider: null, display_name: "Ali Umair",
    subject_hash: null, status: "connected", access_token: "enc:old", refresh_token: "enc:old", ...c,
  });
}
function seedSource(s: Partial<Record<string, unknown>> & { id: string; client_id: string; connection_id: string; account?: string }) {
  const { account, ...rest } = s;
  db.rows("data_sources").push({
    agency_id: "ag-1", type: "meta_ads", status: "connected", last_sync_error: null,
    config: { accounts: listed(account ? [account] : []), account_id: account ?? null }, ...rest,
  });
}
const sourcesOf = (clientId: string) =>
  db.rows("data_sources").filter((r) => r.client_id === clientId).map((r) => ({ account: accountKey(r), connection: r.connection_id }));

const signIn = (over: Partial<Parameters<typeof saveSignIn>[1]> = {}) =>
  saveSignIn(db.client(), {
    agencyId: "ag-1", clientId: "c-1", def, tokens, identity: "Ali Umair",
    config: def.buildConfig!(listed(["A", "B"])), userId: "u-1", ...over,
  });

describe("saving a new sign-in", () => {
  it("keeps the tokens on the sign-in, never on the client's source", async () => {
    const { source, connectionId, duplicate } = await signIn();
    const conn = db.connection(connectionId)!;
    expect(conn).toMatchObject({ agency_id: "ag-1", created_by: "u-1", display_name: "Ali Umair", access_token: "enc:tok" });
    expect(db.rows("data_sources")[0]).not.toHaveProperty("access_token");
    expect(source.connection).toMatchObject({ id: connectionId, access_token: "enc:tok" });
    expect(duplicate).toBeNull();
  });

  it("waits for an account when the sign-in lists several", async () => {
    await signIn();
    expect(sourcesOf("c-1")).toEqual([{ account: "", connection: expect.any(String) }]);
  });

  it("places a lone account directly, replacing an unfinished attempt", async () => {
    const first = await signIn();
    const second = await signIn({ config: def.buildConfig!(listed(["C"])) });
    expect(sourcesOf("c-1")).toEqual([{ account: "C", connection: second.connectionId }]);
    // The abandoned attempt's sign-in had no other use, so it went too.
    expect(db.connection(first.connectionId)).toBeUndefined();
  });

  it("removes the fresh sign-in again when it can't be placed", async () => {
    state.limitOk = false;
    seedConnection({ id: "s1" });
    seedSource({ id: "ds-a", client_id: "c-1", connection_id: "s1", account: "A" });
    await expect(signIn({ config: def.buildConfig!(listed(["B"])), enforceLimit: true })).rejects.toThrow("Trial plan");
    expect(db.rows("connections").map((c) => c.id)).toEqual(["s1"]);
    expect(sourcesOf("c-1")).toEqual([{ account: "A", connection: "s1" }]);
  });
});

describe("several accounts of one platform", () => {
  it("adds a second account as its own source, keeping the first", async () => {
    seedConnection({ id: "s1" });
    seedSource({ id: "ds-a", client_id: "c-1", connection_id: "s1", account: "A" });
    const { connectionId } = await signIn({ config: def.buildConfig!(listed(["B"])) });
    expect(sourcesOf("c-1")).toEqual([
      { account: "A", connection: "s1" },
      { account: "B", connection: connectionId },
    ]);
  });

  it("re-points an account the client already has instead of copying it, keeping its history", async () => {
    seedConnection({ id: "s1" });
    seedSource({ id: "ds-a", client_id: "c-1", connection_id: "s1", account: "A" });
    const { source, connectionId } = await signIn({ config: def.buildConfig!(listed(["A"])) });
    expect(source.id).toBe("ds-a");
    expect(sourcesOf("c-1")).toEqual([{ account: "A", connection: connectionId }]);
    expect(db.connection("s1")).toBeUndefined();
    expect(db.clearedHistory).toEqual([]);
  });

  it("keeps Search Console to one site per client, renewing it in place", async () => {
    const gsc = getIntegration("gsc")!;
    db.rows("connections").push({ id: "g1", agency_id: "ag-1", type: "gsc", client_id: null, status: "connected" });
    db.rows("data_sources").push({
      id: "ds-g", agency_id: "ag-1", client_id: "c-1", type: "gsc", connection_id: "g1",
      config: { sites: ["https://x.com/"], site_url: "https://x.com/" }, status: "connected",
    });
    await saveSignIn(db.client(), {
      agencyId: "ag-1", clientId: "c-1", def: gsc, tokens, identity: "a@x.com",
      config: gsc.buildConfig!(listed(["https://x.com/", "https://y.com/"])),
    });
    const rows = db.rows("data_sources").filter((r) => r.type === "gsc");
    expect(rows).toHaveLength(1);
    expect(accountKey(rows[0])).toBe("https://x.com/");
  });

  it("before 0051 is applied, renews the platform's one source as the old code did", async () => {
    db.legacyIndex = true;
    seedConnection({ id: "s1" });
    seedSource({ id: "ds-a", client_id: "c-1", connection_id: "s1", account: "A" });

    const kept = await signIn();
    expect(sourcesOf("c-1")).toEqual([{ account: "A", connection: kept.connectionId }]);

    // A login that can't see the account leaves it to be chosen again.
    const other = await signIn({ config: def.buildConfig!(listed(["B", "C"])) });
    expect(sourcesOf("c-1")).toEqual([{ account: "", connection: other.connectionId }]);
  });
});

describe("the same login signed in twice", () => {
  const known = subjectHash("meta_ads", "meta-user:1");

  it("is recognised by the provider's own id", async () => {
    seedConnection({ id: "s1", subject_hash: known });
    seedSource({ id: "ds-x", client_id: "c-2", connection_id: "s1", account: "X" });
    const { duplicate } = await signIn({ subject: "meta-user:1" });
    expect(duplicate).toEqual({ id: "s1", displayName: "Ali Umair", strong: true });
  });

  it("is not matched on the name when the ids differ", async () => {
    seedConnection({ id: "s1", subject_hash: subjectHash("meta_ads", "meta-user:2") });
    seedSource({ id: "ds-x", client_id: "c-2", connection_id: "s1", account: "X" });
    expect((await signIn({ subject: "meta-user:1" })).duplicate).toBeNull();
  });

  it("is only a hint when the provider gives no id", async () => {
    seedConnection({ id: "s1" });
    seedSource({ id: "ds-x", client_id: "c-2", connection_id: "s1", account: "X" });
    expect((await signIn({ subject: null })).duplicate).toEqual({ id: "s1", displayName: "Ali Umair", strong: false });
  });

  it("never matches across sign-in routes or owners", () => {
    const base = { id: "new", client_id: null, identity_provider: "business", display_name: "Ali", subject_hash: known, status: "connected" };
    expect(duplicatesOf(base, [{ ...base, id: "p", identity_provider: "personal" }])).toEqual([]);
    expect(duplicatesOf(base, [{ ...base, id: "own", client_id: "c-2" }])).toEqual([]);
    expect(duplicatesOf(base, [{ ...base, id: "same" }])).toEqual([{ id: "same", displayName: "Ali", strong: true }]);
  });
});

describe("renewing a shared sign-in", () => {
  const x = subjectHash("meta_ads", "meta-user:1");
  beforeEach(() => {
    seedConnection({ id: "s1", subject_hash: x, status: "revoked" });
    seedSource({ id: "ds-1", client_id: "c-1", connection_id: "s1", account: "A", status: "revoked" });
    seedSource({ id: "ds-2", client_id: "c-2", connection_id: "s1", account: "B", status: "revoked", last_sync_error: "expired" });
    seedSource({ id: "ds-3", client_id: "c-3", connection_id: "s1", account: "C", status: "revoked" });
  });

  it("restores every client whose account it still reaches, and names the ones it doesn't", async () => {
    const { renewal, connectionId } = await signIn({ connectionId: "s1", subject: "meta-user:1", tokens: { ...tokens, accessToken: "new" } });
    expect(connectionId).toBe("s1");
    expect(db.connection("s1")).toMatchObject({ access_token: "enc:new", status: "connected" });
    const byId = Object.fromEntries(db.rows("data_sources").map((r) => [r.id, r]));
    expect(byId["ds-1"]).toMatchObject({ status: "connected", last_sync_error: null });
    expect(byId["ds-2"]).toMatchObject({ status: "connected", last_sync_error: null });
    expect(byId["ds-3"].status).toBe("error");
    expect(byId["ds-3"].last_sync_error).toContain("“Account C”");
    expect(renewal).toEqual({ restored: 2, lacking: [{ sourceId: "ds-3", clientId: "c-3", account: "Account C" }] });
    // Every account keeps its own selection: nothing was re-chosen.
    expect(db.rows("data_sources").map(accountKey)).toEqual(["A", "B", "C"]);
  });

  it("refuses another person's login and changes nothing", async () => {
    const err = await signIn({ connectionId: "s1", subject: "meta-user:9", identity: "Someone Else" }).catch((e) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect(err.message).toContain("this saved sign-in is Ali Umair");
    expect(db.connection("s1")).toMatchObject({ access_token: "enc:old", status: "revoked" });
    expect(db.rows("data_sources").every((r) => r.status === "revoked")).toBe(true);
  });

  it("records who signed in on a sign-in saved before that was kept", async () => {
    db.connection("s1")!.subject_hash = null;
    await signIn({ connectionId: "s1", subject: "meta-user:1" });
    expect(db.connection("s1")!.subject_hash).toBe(x);
  });

  it("stays inside the agency", async () => {
    await expect(signIn({ agencyId: "ag-2", connectionId: "s1", subject: "meta-user:1" })).rejects.toThrow("no longer exists");
    expect(db.connection("s1")!.access_token).toBe("enc:old");
  });

  it("won't renew a client's own sign-in for another client", async () => {
    db.connection("s1")!.client_id = "c-3";
    await expect(signIn({ connectionId: "s1", subject: "meta-user:1" })).rejects.toThrow("another client");
  });

  it("brings in the client that reconnected it, when it didn't use the sign-in yet", async () => {
    await signIn({ clientId: "c-4", connectionId: "s1", subject: "meta-user:1" });
    expect(sourcesOf("c-4")).toEqual([{ account: "", connection: "s1" }]);
  });
});

describe("connect-link sign-ins", () => {
  it("never re-point a source the agency connected with its own sign-in", async () => {
    seedConnection({ id: "agency" });
    seedSource({ id: "ds-a", client_id: "c-1", connection_id: "agency", account: "A" });
    const { connectionId } = await signIn({ config: def.buildConfig!(listed(["A"])), clientOwned: true });
    expect(db.connection(connectionId)!.client_id).toBe("c-1");
    expect(sourcesOf("c-1")).toEqual([
      { account: "A", connection: "agency" },
      { account: "", connection: connectionId },
    ]);
  });

  it("can't be used for another client (the database refuses it)", async () => {
    seedConnection({ id: "own", client_id: "c-2" });
    await expect(
      placeSource(db.client(), { agencyId: "ag-1", clientId: "c-1", def, connectionId: "own", displayName: null, config: {} })
    ).rejects.toThrow("another client");
  });
});

describe("isShareable", () => {
  it("shares sign-ins except where a per-client value is collected first", () => {
    const listable = { listAccounts: async () => [], buildConfig: () => ({}) };
    expect(isShareable({ ...def, ...listable } as IntegrationDef)).toBe(true);
    expect(isShareable({ ...def, ...listable, connectField: { name: "shop", label: "Shop", placeholder: "" } } as IntegrationDef)).toBe(false);
    expect(isShareable(undefined)).toBe(false);
  });
});
