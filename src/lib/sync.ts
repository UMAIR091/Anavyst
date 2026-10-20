import type { SupabaseClient } from "@supabase/supabase-js";
import { getValidAccessToken } from "@/lib/googleTokens";
import { getIntegration, oauthForType } from "@/lib/integrations/registry";
import { accountLockedMessage, classifyIntegrationError, isAccountLockedError, reconnectMessage } from "@/lib/integrations/errors";
import { logError } from "@/lib/errorLog";
import { trackUsage } from "@/lib/usage";
import { recordDailyMetrics } from "@/lib/metrics/history";
import { CACHED_PERIOD_DAYS } from "@/lib/reports/periods";
import { ARCHIVED_CLIENT_ERROR, isSourceClientPaused } from "@/lib/archivedClients";
import { createAdminClient } from "@/lib/supabase/admin";
import { noAccessMessage, subjectHash, type ConnectionTokens } from "@/lib/integrations/connections";
import crypto from "node:crypto";
import { logConnectionEvent } from "@/lib/integrations/connectionEvents";

// Periods we keep warm in the cache (match the report/analytics date ranges).
// Declared once in lib/reports/periods so the client Performance view, which
// reads these snapshots straight back, can offer exactly the windows that exist.
const PERIODS = CACHED_PERIOD_DAYS;
// The window mirrored into the historical archive — the widest we fetch, so
// each sync contributes the most days and gaps close fastest after downtime.
const WIDEST_PERIOD = Math.max(...PERIODS);

// Only needed for callers that didn't already select client_id.
async function lookupClientId(supabase: SupabaseClient, dataSourceId: string): Promise<string | null> {
  const { data } = await supabase.from("data_sources").select("client_id").eq("id", dataSourceId).maybeSingle();
  return (data?.client_id as string | undefined) ?? null;
}

export type SyncableSource = {
  id: string;
  agency_id: string;
  /** Optional: callers that already selected it save a lookup in the archive step. */
  client_id?: string | null;
  type?: string | null;
  config: Record<string, unknown> | null;
  /** The shared sign-in this source uses, with its tokens (migration 0046).
   *  Load with lib/integrations/connections (service role). */
  connection_id?: string | null;
  connection?: ConnectionTokens | null;
};

// Syncs one data source of any integration type: resolve the provider from the
// registry, get a valid token, pull each period, and upsert into the provider's
// snapshot table. Records sync status on the source. Never throws, so the cron
// can keep going across every source.
//
// Every exit path stamps last_sync_attempt_at so the batch cron rotates fairly:
// a source that keeps failing still moves to the back of the queue and can't
// starve the others (see migration 0013).
export async function syncDataSource(
  supabase: SupabaseClient,
  ds: SyncableSource
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const attemptedAt = new Date().toISOString();

  // Archived clients are paused (lib/archivedClients.ts): no token refresh, no
  // provider calls, no usage, and nothing written onto the source but the
  // attempt stamp, so a restore picks up exactly where it left off. State that
  // can't be read fails closed as an ordinary failure.
  let paused: boolean;
  try {
    paused = await isSourceClientPaused(supabase, ds.id);
  } catch (err) {
    await supabase.from("data_sources").update({ last_sync_attempt_at: attemptedAt }).eq("id", ds.id);
    return { ok: false, error: (err as Error).message };
  }
  if (paused) {
    await supabase.from("data_sources").update({ last_sync_attempt_at: attemptedAt }).eq("id", ds.id);
    return { ok: false, skipped: true, error: ARCHIVED_CLIENT_ERROR };
  }

  const def = getIntegration(ds.type);
  if (!def || !def.fetchSnapshot || !def.snapshotTable || !def.readSelected) {
    await supabase.from("data_sources").update({ last_sync_attempt_at: attemptedAt }).eq("id", ds.id);
    return { ok: false, error: `Unsupported integration: ${ds.type ?? "unknown"}` };
  }

  const accountId = def.readSelected(ds.config ?? {});
  if (!accountId) {
    // Persist the reason so the UI can explain why nothing is syncing. This is a
    // configuration gap, not an auth failure — leave status untouched.
    const error = `No ${def.accountNoun} selected`;
    await supabase
      .from("data_sources")
      .update({ last_sync_error: error, last_sync_attempt_at: attemptedAt })
      .eq("id", ds.id);
    return { ok: false, error };
  }

  // The sign-in must belong to this source's workspace and platform, and a
  // client's own sign-in (connect link) to this client. The database enforces
  // all three (migrations 0046 and 0048); this refuses a mismatched pairing
  // rather than fetch with someone else's access, whatever loaded it.
  const mismatch = signInMismatch(ds);
  if (mismatch) {
    const error = "This source's sign-in doesn't belong to it. Reconnect the source.";
    await supabase
      .from("data_sources")
      .update({ status: "error", last_sync_error: error, last_sync_attempt_at: attemptedAt, last_sync_failed_at: attemptedAt })
      .eq("id", ds.id);
    await logError({ context: "sync", agencyId: ds.agency_id, dataSourceId: ds.id, provider: ds.type ?? null, errorType: "config", message: mismatch, retryStatus: "needs_reconnect" });
    return { ok: false, error };
  }

  // A real sync execution is about to run (past the config-gap early returns).
  await trackUsage(ds.agency_id, "sync_executions");

  // Identity provider stored at connect time (e.g. microsoft | google), passed
  // through so the backend can add any provider-specific API headers.
  const provider =
    ds.connection?.identity_provider ??
    (typeof ds.config?.identity_provider === "string" ? ds.config.identity_provider : undefined);
  let accessToken: string | null = null;

  try {
    accessToken = await getValidAccessToken(ds);
    const token = accessToken;
    const now = new Date().toISOString();

    // Widest window first, so the archive write below sees the most history.
    let widest: unknown = null;
    for (const period of PERIODS) {
      const data = await def.fetchSnapshot(token, accountId, period, { provider }, ds.config ?? {});
      await supabase
        .from(def.snapshotTable)
        .upsert(
          { data_source_id: ds.id, agency_id: ds.agency_id, period_days: period, data, synced_at: now },
          { onConflict: "data_source_id,period_days" }
        );
      if (period === WIDEST_PERIOD) widest = data;
    }

    // Snapshots above are a rolling cache — each sync overwrites them, so
    // nothing older than the widest window survives there. Mirror the daily
    // totals into the append-only archive so long-range (monthly, quarterly,
    // yearly) reporting can be served from our own database later, even once
    // the provider stops offering the range. Best-effort: a failure here is
    // logged but never fails the sync.
    if (widest) {
      const clientId = ds.client_id !== undefined ? ds.client_id : await lookupClientId(supabase, ds.id);
      const archived = await recordDailyMetrics(supabase, {
        dataSourceId: ds.id,
        agencyId: ds.agency_id,
        clientId,
        provider: ds.type ?? "unknown",
        snapshot: widest,
      });
      if (archived.error) console.error(`metric_daily write failed for ${ds.id}: ${archived.error}`);
    }

    await supabase
      .from("data_sources")
      .update({ last_synced_at: now, last_sync_attempt_at: now, last_sync_error: null, status: "connected" })
      .eq("id", ds.id);
    // The sign-in demonstrably works, whatever an earlier failure said.
    if (ds.connection && ds.connection.status === "revoked") {
      await createAdminClient().from("connections").update({ status: "connected" }).eq("id", ds.connection.id);
    }
    // A sign-in saved before who-signed-in was recorded (0049) learns it now,
    // once, so the same login can be recognised later.
    if (ds.connection && ds.connection.subject_hash === null) await recordSubject(ds, def, token, provider);

    return { ok: true };
  } catch (err) {
    const message = (err as Error).message;
    // Distinguish a genuinely dead grant (needs the user to reconnect) from a
    // temporary provider/network blip (retry next run). Only the former flips
    // the source to "revoked" and surfaces a Reconnect prompt; transient errors
    // stay "error" and keep the existing tokens for the next attempt.
    const kind = classifyIntegrationError(err);

    // The platform locked the account behind the sign-in (a Facebook security
    // check). Nothing to reconnect and nothing to expire for the other clients
    // on it: the person clears the check on the platform and the same sign-in
    // works again. Say exactly that, and retry on the next run.
    if (isAccountLockedError(err)) {
      const error = accountLockedMessage(def.name);
      await supabase
        .from("data_sources")
        .update({ status: "error", last_sync_error: error, last_sync_attempt_at: attemptedAt, last_sync_failed_at: attemptedAt })
        .eq("id", ds.id);
      await logError({
        context: "sync",
        agencyId: ds.agency_id,
        dataSourceId: ds.id,
        provider: ds.type ?? null,
        errorType: "transient",
        message: `account locked by provider: ${message}`,
        retryStatus: "will_retry",
      });
      return { ok: false, error };
    }

    // A shared sign-in serves many accounts. When the provider refuses this
    // one account (Meta wraps a missing ad-account permission in the same
    // OAuthException as a dead token), expiring the sign-in would stop every
    // other client on it. So before treating it as expired, check whether the
    // sign-in itself still works by listing its accounts.
    if (kind === "reauth" && accessToken && def.listAccounts) {
      const reach = await accountReach(def, accessToken, accountId, provider);
      if (reach !== "token_dead") {
        const name = def.readAccounts?.(ds.config ?? {}).find((a) => a.id === accountId)?.name ?? accountId;
        const error = reach === "not_listed" ? noAccessMessage(def, name, null) : `${def.name} refused access to “${name}”: ${message}`;
        await supabase
          .from("data_sources")
          .update({ status: "error", last_sync_error: error, last_sync_attempt_at: attemptedAt, last_sync_failed_at: attemptedAt })
          .eq("id", ds.id);
        await logError({
          context: "sync",
          agencyId: ds.agency_id,
          dataSourceId: ds.id,
          provider: ds.type ?? null,
          errorType: "transient",
          message: `account-level refusal, sign-in still valid: ${message}`,
          retryStatus: "will_retry",
        });
        return { ok: false, error };
      }
    }

    const patch =
      kind === "reauth"
        ? { status: "revoked", last_sync_error: reconnectMessage(def.name), last_sync_attempt_at: attemptedAt, last_sync_failed_at: attemptedAt }
        : { status: "error", last_sync_error: message, last_sync_attempt_at: attemptedAt, last_sync_failed_at: attemptedAt };

    await supabase.from("data_sources").update(patch).eq("id", ds.id);
    // A dead sign-in is dead for every client on it: say so on all of them at
    // once, rather than each discovering it on its own next sync.
    const connectionId = ds.connection?.id ?? ds.connection_id ?? null;
    if (kind === "reauth" && connectionId) {
      try {
        const admin = createAdminClient();
        if (ds.connection?.status !== "revoked") {
          await logConnectionEvent({
            agencyId: ds.agency_id, action: "expired", actor: "provider", connectionId, dataSourceId: ds.id,
            clientId: ds.client_id ?? null, platform: ds.type ?? null, detail: { error: reconnectMessage(def.name) },
          });
        }
        await admin.from("connections").update({ status: "revoked" }).eq("id", connectionId);
        await admin
          .from("data_sources")
          .update({ status: "revoked", last_sync_error: reconnectMessage(def.name) })
          .eq("connection_id", connectionId)
          .neq("id", ds.id);
      } catch (markErr) {
        console.error(`could not mark sign-in ${connectionId} revoked: ${(markErr as Error).message}`);
      }
    }
    // Append to the historical error log (best-effort; never blocks the sync).
    await logError({
      context: "sync",
      agencyId: ds.agency_id,
      dataSourceId: ds.id,
      provider: ds.type ?? null,
      errorType: kind,
      message,
      retryStatus: kind === "reauth" ? "needs_reconnect" : "will_retry",
    });
    return { ok: false, error: message };
  }
}

// Why a source's sign-in can't be used for it, or null when it can.
export function signInMismatch(ds: SyncableSource): string | null {
  const c = ds.connection;
  if (!c) return null;
  if (c.agency_id && c.agency_id !== ds.agency_id) return `sign-in ${c.id} is another workspace's`;
  if (c.type && ds.type && c.type !== ds.type) return `sign-in ${c.id} is for ${c.type}, not ${ds.type}`;
  if (c.client_id && ds.client_id && c.client_id !== ds.client_id) return `sign-in ${c.id} belongs to another client`;
  return null;
}

// After an auth-looking failure: does the sign-in still work, and does it
// still list this account? Listing fails the same way only when the token
// itself is dead.
export async function accountReach(
  def: { listAccounts?: (token: string, ctx?: { provider?: string; connectValue?: string }) => Promise<{ id: string }[]> },
  accessToken: string,
  accountId: string,
  provider?: string
): Promise<"listed" | "not_listed" | "token_dead"> {
  if (!def.listAccounts) return "token_dead";
  try {
    const accounts = await def.listAccounts(accessToken, { provider, connectValue: accountId });
    return accounts.some((a) => a.id === accountId) ? "listed" : "not_listed";
  } catch (err) {
    return classifyIntegrationError(err) === "reauth" ? "token_dead" : "listed";
  }
}

// Best-effort: the provider's stable id for the login (an API key's own hash
// for key-based integrations), stored only if still unrecorded.
async function recordSubject(
  ds: SyncableSource,
  def: { id: string; authKind?: string },
  token: string,
  provider: string | undefined
): Promise<void> {
  try {
    const subject =
      def.authKind === "apikey"
        ? `key:${crypto.createHash("sha256").update(token).digest("hex")}`
        : await oauthForType(ds.type)?.subject?.(token, { provider });
    const hash = subjectHash(def.id, subject ?? null);
    if (!hash || !ds.connection) return;
    await createAdminClient().from("connections").update({ subject_hash: hash }).eq("id", ds.connection.id).is("subject_hash", null);
  } catch {
    // Recorded on a later sync instead.
  }
}
