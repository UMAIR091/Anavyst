import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ unstable_cache: (fn: unknown) => fn, revalidateTag: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => s }));
vi.mock("@/lib/billing/limits", () => ({ checkIntegrationLimit: async () => ({ allowed: true }) }));

import { buildConnectionsView, expiryOf, type ConnectionRow, type SourceRow } from "./connectionsView";
import { subjectHash } from "./connections";

// The Connections page's data: expiry only ever from the platform's own
// dates (never estimated), health per sign-in, ownership, accounts shared
// between clients, and sources left waiting for an account.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12);
const inDays = (d: number) => new Date(NOW + d * DAY).toISOString();

const conn = (over: Partial<ConnectionRow> & { id: string }): ConnectionRow => ({
  type: "meta_ads", client_id: null, identity_provider: null, display_name: "Ali Umair", subject_hash: null,
  status: "connected", token_expires_at: inDays(50), refresh_expires_at: null, created_at: inDays(-30), ...over,
});
const src = (over: Partial<SourceRow> & { id: string; connection_id: string; client_id: string }): SourceRow => ({
  type: "meta_ads", account_key: "act_1", status: "connected", last_synced_at: inDays(-1), last_sync_error: null,
  config: { accounts: [{ id: "act_1", name: "Acme UK" }], account_id: "act_1" }, created_at: inDays(-30), ...over,
});
const clients = [
  { id: "c1", name: "Acme", archived: false },
  { id: "c2", name: "Bolt", archived: false },
];

describe("expiry", () => {
  it("dates only what the platform dated, and says when it doesn't", () => {
    expect(expiryOf(conn({ id: "a" }), "Meta Ads", NOW)).toMatchObject({ kind: "reconnect_by", date: inDays(50), confirmed: true });
    expect(expiryOf(conn({ id: "b", type: "linkedin_ads", refresh_expires_at: inDays(300) }), "LinkedIn Ads", NOW)).toMatchObject({
      kind: "renews_until", date: inDays(300), confirmed: true,
    });
    // LinkedIn before its refresh date is known: no invented date.
    expect(expiryOf(conn({ id: "c", type: "linkedin_ads" }), "LinkedIn Ads", NOW)).toMatchObject({ kind: "renews", date: null, confirmed: false });
    expect(expiryOf(conn({ id: "d", token_expires_at: inDays(36500) }), "Meta Ads", NOW)).toMatchObject({ kind: "never" });
    expect(expiryOf(conn({ id: "e", type: "instagram", identity_provider: "instagram" }), "Instagram", NOW)).toMatchObject({ kind: "renews" });
  });
});

describe("buildConnectionsView", () => {
  it("summarises each sign-in: owner, clients, health, last sync, reconnect link", () => {
    const view = buildConnectionsView({
      connections: [conn({ id: "s1" }), conn({ id: "own", client_id: "c2", display_name: "Bolt Owner" })],
      sources: [
        src({ id: "d1", connection_id: "s1", client_id: "c1", last_synced_at: inDays(-2) }),
        src({ id: "d2", connection_id: "s1", client_id: "c2", account_key: "act_2", last_synced_at: inDays(-1), status: "error", last_sync_error: "nope" }),
        src({ id: "d3", connection_id: "own", client_id: "c2", account_key: "act_3" }),
      ],
      clients,
      now: NOW,
    });
    const [shared, own] = view.signIns;
    expect(shared).toMatchObject({ owner: { kind: "agency" }, health: "attention", lastSyncedAt: inDays(-1) });
    expect(shared.clients.map((c) => c.clientName)).toEqual(["Acme", "Bolt"]);
    expect(shared.reconnectHref).toBe("/dashboard/connect/meta_ads?clientId=c1");
    expect(shared.revokesAtProvider).toBe(true); // Meta has an official revoke
    // A client's own sign-in is renewed by the client, through a link.
    expect(own).toMatchObject({ owner: { kind: "client", clientId: "c2", clientName: "Bolt" }, reconnectHref: null });
  });

  it("marks expired and waiting sign-ins", () => {
    const view = buildConnectionsView({
      connections: [conn({ id: "x", status: "revoked" }), conn({ id: "w" })],
      sources: [
        src({ id: "d1", connection_id: "x", client_id: "c1" }),
        src({ id: "d2", connection_id: "w", client_id: "c1", account_key: "", config: { accounts: [] } }),
      ],
      clients,
      now: NOW,
    });
    expect(view.signIns.map((s) => s.health)).toEqual(["expired", "waiting"]);
    expect(view.waiting).toEqual([{ sourceId: "d2", clientId: "c1", clientName: "Acme", platform: "Meta Ads", since: inDays(-30) }]);
  });

  it("finds one ad account on two clients, and nothing else", () => {
    const view = buildConnectionsView({
      connections: [conn({ id: "s1" })],
      sources: [
        src({ id: "d1", connection_id: "s1", client_id: "c1" }),
        src({ id: "d2", connection_id: "s1", client_id: "c2" }),
        src({ id: "d3", connection_id: "s1", client_id: "c2", account_key: "act_9" }),
      ],
      clients,
      now: NOW,
    });
    expect(view.sharedAccounts).toEqual([{ platform: "Meta Ads", account: "Acme UK", clients: ["Acme", "Bolt"] }]);
  });

  it("flags a proven duplicate sign-in with a review link, not a name-only match across different ids", () => {
    const h = subjectHash("meta_ads", "meta-user:1");
    const view = buildConnectionsView({
      connections: [conn({ id: "old", subject_hash: h }), conn({ id: "new", subject_hash: h }), conn({ id: "other", subject_hash: subjectHash("meta_ads", "meta-user:2") })],
      sources: [src({ id: "d1", connection_id: "new", client_id: "c1" })],
      clients,
      now: NOW,
    });
    expect(view.signIns[1].duplicateOf).toMatchObject({ id: "old", strong: true });
    expect(view.signIns[1].reviewHref).toBe("/dashboard/connect/meta_ads/review?clientId=c1&connection=new");
    expect(view.signIns[2].duplicateOf).toBeNull();
  });
});
