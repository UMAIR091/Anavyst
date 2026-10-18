// Integration health — per-connection status for the dashboard. Reads only the
// non-secret health columns from data_sources (never access/refresh tokens) and
// derives a token-expiration signal from token_expires_at + status.
import { unstable_cache, revalidateTag } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import { format } from "date-fns";
import { getIntegration } from "@/lib/integrations/registry";
import { RECONNECT_WARN_MS, renewalFor } from "@/lib/integrations/tokenRenewal";
import type { TokenRenewal } from "@/lib/integrations/types";
import { getIntegrationName } from "@/lib/integrations/names";
import { sourceHealth, countHealth, type SourceHealth } from "@/lib/integrations/status";
import { createAdminClient } from "@/lib/supabase/admin";

const healthTag = (agencyId: string) => `integration-health-${agencyId}`;

// Call after any change to an agency's connections (connect / reconnect /
// disconnect) so the cached health rollup reflects it immediately instead of
// waiting out the TTL. Safe to call from route handlers; no-op elsewhere.
export function revalidateIntegrationHealth(agencyId: string): void {
  try {
    revalidateTag(healthTag(agencyId));
  } catch {
    /* outside a request context (e.g. cron) — the short TTL covers it */
  }
}

export type ConnectionStatus = "connected" | "error" | "revoked";
// "valid_until": a token that can't be extended, not yet near its expiry.
// "expiring": the same, inside the warning window — reconnect by the date.
export type TokenState = "auto_refresh" | "no_expiry" | "valid_until" | "expiring" | "reconnect";

export type IntegrationHealth = {
  id: string;
  type: string;
  providerName: string;
  /** The client the source belongs to, for per-client status (sidebar, lists). */
  clientId: string | null;
  clientName: string;
  displayName: string | null;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  lastSyncFailedAt: string | null;
  lastSyncError: string | null;
  tokenExpiresAt: string | null;
  token: { state: TokenState; label: string };
  /** The selected account/property id stored in config, null if none chosen. */
  selectedAccountId: string | null;
  /** Canonical one-of-four health classification — the single truth every screen reads. */
  health: SourceHealth;
};

// API-key connections store a ~100-year expiry sentinel; anything beyond ~10
// years is treated as "no real expiry".
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export function tokenState(
  status: ConnectionStatus,
  tokenExpiresAt: string | null,
  renewal: TokenRenewal = "refresh",
  now: number = Date.now()
): { state: TokenState; label: string } {
  if (status === "revoked") return { state: "reconnect", label: "Reconnect required" };
  if (!tokenExpiresAt) return { state: "no_expiry", label: "No expiry" };
  const ms = new Date(tokenExpiresAt).getTime() - now;
  // API keys, permanent OAuth 1.0a tokens and Meta business system-user tokens.
  if (ms > TEN_YEARS_MS) return { state: "no_expiry", label: "No expiry" };
  // A token that can't be extended (Facebook Login) needs a fresh sign-in
  // before it expires, so it says by when, and warns as the date nears.
  if (renewal === "reconnect") {
    const day = format(new Date(tokenExpiresAt), "d MMM yyyy");
    if (ms <= 0) return { state: "reconnect", label: "Expired: reconnect" };
    if (ms <= RECONNECT_WARN_MS) return { state: "expiring", label: `Reconnect by ${day}` };
    return { state: "valid_until", label: `Valid until ${day}` };
  }
  // Other OAuth access tokens are short-lived and refreshed automatically by
  // the sync; an expired-but-not-revoked token is normal, not a problem.
  return { state: "auto_refresh", label: "Auto-refreshing" };
}

type Row = {
  id: string;
  type: string;
  client_id: string | null;
  display_name: string | null;
  status: string | null;
  last_synced_at: string | null;
  last_sync_failed_at: string | null;
  last_sync_error: string | null;
  // Carries the selected account/property, which decides needs_account. Config
  // holds no secrets — tokens live in their own encrypted columns.
  config: Record<string, unknown> | null;
  clients: { name: string | null } | { name: string | null }[] | null;
  // The saved sign-in the source uses (migration 0046): its expiry and route.
  connection: SignIn | SignIn[] | null;
};
type SignIn = { identity_provider: string | null; token_expires_at: string | null };

function clientName(row: Row): string {
  const c = row.clients;
  const name = Array.isArray(c) ? c[0]?.name : c?.name;
  return name ?? "—";
}

// Every connected data source for the agency, newest-touched first. `supabase`
// should be the caller's RLS-scoped client; the agency filter is explicit so the
// admin client is safe too.
// Short-TTL cached health rollup for the dashboard (perf audit P2-7). The badge
// tolerates ~60s staleness, so this cuts the 5-query rollup out of most dashboard
// loads. Uses the admin client (the read is explicitly agency-scoped below), so
// it's safe outside a request's RLS session and cacheable across requests.
export function getIntegrationHealthCached(agencyId: string): Promise<IntegrationHealth[]> {
  return unstable_cache(
    () => getIntegrationHealth(createAdminClient(), agencyId),
    ["integration-health", agencyId],
    { revalidate: 60, tags: [healthTag(agencyId)] }
  )();
}

export async function getIntegrationHealth(supabase: SupabaseClient, agencyId: string): Promise<IntegrationHealth[]> {
  const { data } = await supabase
    .from("data_sources")
    .select(
      "id, type, client_id, display_name, status, last_synced_at, last_sync_failed_at, last_sync_error, config, clients(name), " +
        "connection:connections!data_sources_connection_fkey(identity_provider, token_expires_at)"
    )
    .eq("agency_id", agencyId)
    .order("last_sync_attempt_at", { ascending: false, nullsFirst: false });

  return ((data ?? []) as unknown as Row[]).map((r) => {
    const status = (r.status ?? "connected") as ConnectionStatus;
    const signIn = Array.isArray(r.connection) ? r.connection[0] ?? null : r.connection;
    const tokenExpiresAt = signIn?.token_expires_at ?? null;
    const config = { ...(r.config ?? {}), identity_provider: signIn?.identity_provider ?? r.config?.identity_provider };
    const def = getIntegration(r.type);
    const selectedAccountId = def?.readSelected?.((r.config ?? {}) as never) ?? null;
    return {
      id: r.id,
      type: r.type,
      providerName: def?.name ?? getIntegrationName(r.type),
      clientId: r.client_id,
      clientName: clientName(r),
      displayName: r.display_name,
      status,
      lastSyncedAt: r.last_synced_at,
      lastSyncFailedAt: r.last_sync_failed_at,
      lastSyncError: r.last_sync_error,
      tokenExpiresAt,
      token: tokenState(status, tokenExpiresAt, renewalFor({ type: r.type, config })),
      selectedAccountId,
      // The one classification every screen reads (P0-1).
      health: sourceHealth({ status, lastSyncError: r.last_sync_error, selectedAccountId }),
    };
  });
}

// Small roll-up for the dashboard summary card and the health page.
//
// Derived from the shared classifier, so "connected" now means genuinely
// healthy — a source still waiting for an account selection is reported under
// needsAccount instead of silently inflating the connected count.
export function summarize(rows: IntegrationHealth[]) {
  const counts = countHealth(rows.map((r) => r.health));
  return {
    total: counts.total,
    connected: counts.healthy,
    errored: counts.syncError,
    needsReconnect: counts.needsReconnect,
    needsAccount: counts.needsAccount,
    /** Every source that isn't healthy — the number screens should headline. */
    needsAttention: counts.needsAttention,
  };
}
