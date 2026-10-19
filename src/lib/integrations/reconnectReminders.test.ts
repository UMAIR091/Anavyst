import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./testing/fakeSupabase";

// "Reconnect by" emails (migration 0052): due 14 days before, 3 days before
// and just after a sign-in's deadline, one email per agency, each stage sent
// once, nothing for sign-ins that renew on their own or only serve archived
// clients.

const state = vi.hoisted(() => ({
  db: null as unknown as import("./testing/fakeSupabase").FakeDb,
  sent: [] as { to: string | string[]; subject: string; html: string; idempotencyKey?: string }[],
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db.client() }));
vi.mock("@/lib/agencyContact", () => ({
  agencyContact: async (_db: unknown, id: string) => ({ email: id === "ag-none" ? null : `${id}@agency.test`, name: `Agency ${id}` }),
}));
vi.mock("@/lib/email", async () => {
  const template = await vi.importActual<typeof import("@/lib/email/template")>("@/lib/email/template");
  return {
    emailConfigured: () => true,
    reconnectReminderEmailHtml: template.reconnectReminderEmailHtml,
    sendEmailWithRetry: async (args: (typeof state.sent)[number]) => {
      state.sent.push(args);
      return { id: `msg-${state.sent.length}`, attempts: 1 };
    },
  };
});

import { dueReminders, reminderStage, sendReconnectReminders } from "./reconnectReminders";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 11, 1, 6);
const inDays = (d: number) => new Date(NOW + d * DAY).toISOString();
const APP = "https://app.test";

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  state.db = db;
  state.sent = [];
});

function signIn(id: string, over: Record<string, unknown>, clients: { id: string; name: string; archived?: boolean }[]) {
  db.rows("connections").push({
    id, agency_id: "ag-1", type: "meta_ads", client_id: null, identity_provider: null, display_name: "Ali Umair",
    token_expires_at: inDays(60), refresh_expires_at: null, status: "connected", ...over,
  });
  for (const c of clients) {
    if (!db.rows("clients").some((r) => r.id === c.id)) db.rows("clients").push({ id: c.id, name: c.name, archived: c.archived ?? false });
    db.rows("data_sources").push({
      id: `ds-${id}-${c.id}`, agency_id: over.agency_id ?? "ag-1", client_id: c.id, type: over.type ?? "meta_ads", connection_id: id,
      config: { account_id: `${id}-${c.id}` }, status: "connected",
    });
  }
}

describe("reminderStage", () => {
  it("picks the stage by days left, and stops a week after the date", () => {
    expect(reminderStage(inDays(20), NOW)).toBeNull();
    expect(reminderStage(inDays(14), NOW)).toBe("14d");
    expect(reminderStage(inDays(4), NOW)).toBe("14d");
    expect(reminderStage(inDays(3), NOW)).toBe("3d");
    expect(reminderStage(inDays(-1), NOW)).toBe("expired");
    expect(reminderStage(inDays(-8), NOW)).toBeNull();
  });
});

describe("dueReminders", () => {
  it("finds Facebook and LinkedIn sign-ins coming due, and nothing that renews itself", async () => {
    signIn("fb", { token_expires_at: inDays(10) }, [{ id: "c1", name: "Acme" }, { id: "c2", name: "Bolt" }]);
    signIn("li", { type: "linkedin_ads", token_expires_at: inDays(40), refresh_expires_at: inDays(2) }, [{ id: "c1", name: "Acme" }]);
    signIn("biz", { token_expires_at: inDays(36500) }, [{ id: "c3", name: "Corp" }]); // Meta business: never
    signIn("gsc", { type: "gsc", token_expires_at: inDays(-1) }, [{ id: "c4", name: "Dune" }]); // refreshes itself
    const due = await dueReminders(db.client(), APP, NOW);
    expect(due.map((d) => [d.connectionId, d.stage, d.platform, d.clients])).toEqual([
      ["fb", "14d", "Meta Ads", ["Acme", "Bolt"]],
      ["li", "3d", "LinkedIn Ads", ["Acme"]],
    ]);
    expect(due[0].actionUrl).toBe(`${APP}/dashboard/connect/meta_ads?clientId=c1`);
  });

  it("skips sign-ins that only serve archived clients", async () => {
    signIn("fb", { token_expires_at: inDays(10) }, [{ id: "c1", name: "Old", archived: true }]);
    expect(await dueReminders(db.client(), APP, NOW)).toEqual([]);
  });

  it("points a client's own sign-in at its connect links", async () => {
    signIn("own", { token_expires_at: inDays(2), client_id: "c1" }, [{ id: "c1", name: "Acme" }]);
    const [due] = await dueReminders(db.client(), APP, NOW);
    expect(due.clientOwnedBy).toBe("Acme");
    expect(due.actionUrl).toBe(`${APP}/dashboard/clients/c1/data-sources`);
  });
});

describe("sendReconnectReminders", () => {
  it("emails each agency once, and doesn't repeat a stage", async () => {
    signIn("fb", { token_expires_at: inDays(10) }, [{ id: "c1", name: "Acme" }]);
    signIn("li", { type: "linkedin_ads", refresh_expires_at: inDays(12) }, [{ id: "c1", name: "Acme" }]);
    signIn("other", { agency_id: "ag-2", token_expires_at: inDays(3) }, [{ id: "c9", name: "Zeta" }]);

    expect(await sendReconnectReminders(db.client(), APP, NOW)).toEqual({ agencies: 2, reminders: 3, failed: 0 });
    expect(state.sent.map((m) => [m.to, m.subject])).toEqual([
      ["ag-1@agency.test", "2 data connections need reconnecting soon"],
      ["ag-2@agency.test", "Reconnect Meta Ads to keep your reports updating"],
    ]);
    expect(state.sent[0].html).toContain("Reconnect by");
    expect(state.sent[0].html).toContain(`${APP}/dashboard/connect/meta_ads?clientId=c1`);
    expect(db.rows("connection_reminders")).toHaveLength(3);

    // The next day: same stage, nothing new.
    state.sent = [];
    expect((await sendReconnectReminders(db.client(), APP, NOW + DAY)).reminders).toBe(0);
    expect(state.sent).toEqual([]);

    // A week on: Meta Ads is inside 3 days (its next stage, once), LinkedIn
    // has nothing new, and the other agency's sign-in has expired.
    expect((await sendReconnectReminders(db.client(), APP, NOW + 8 * DAY)).reminders).toBe(2);
    expect(state.sent.map((m) => [m.to, m.subject])).toEqual([
      ["ag-1@agency.test", "Reconnect Meta Ads to keep your reports updating"],
      ["ag-2@agency.test", "Your Meta Ads connection has expired"],
    ]);
    // A day later LinkedIn reaches its own 3-day mark; nothing else repeats.
    state.sent = [];
    expect((await sendReconnectReminders(db.client(), APP, NOW + 9 * DAY)).reminders).toBe(1);
    expect(state.sent[0].subject).toBe("Reconnect LinkedIn Ads to keep your reports updating");
    state.sent = [];
    expect((await sendReconnectReminders(db.client(), APP, NOW + 9.5 * DAY)).reminders).toBe(0);
    // On Meta Ads' date itself, the "expired" email.
    expect((await sendReconnectReminders(db.client(), APP, NOW + 10 * DAY)).reminders).toBe(1);
    expect(state.sent[0].subject).toBe("Your Meta Ads connection has expired");
  });

  it("starts over after a reconnect sets a new deadline", async () => {
    signIn("fb", { token_expires_at: inDays(10) }, [{ id: "c1", name: "Acme" }]);
    await sendReconnectReminders(db.client(), APP, NOW);
    db.connection("fb")!.token_expires_at = inDays(70);
    state.sent = [];
    expect((await sendReconnectReminders(db.client(), APP, NOW + 57 * DAY)).reminders).toBe(1);
  });

  it("says so when one has already expired", async () => {
    signIn("fb", { token_expires_at: inDays(-1), status: "revoked" }, [{ id: "c1", name: "Acme" }]);
    await sendReconnectReminders(db.client(), APP, NOW);
    expect(state.sent[0].subject).toBe("Your Meta Ads connection has expired");
    expect(state.sent[0].html).toContain("Expired on");
  });

  it("escapes names in the email", async () => {
    signIn("fb", { token_expires_at: inDays(5), display_name: "<b>x</b>" }, [{ id: "c1", name: "A&B <script>" }]);
    await sendReconnectReminders(db.client(), APP, NOW);
    expect(state.sent[0].html).not.toContain("<script>");
    expect(state.sent[0].html).toContain("A&amp;B &lt;script&gt;");
  });
});
