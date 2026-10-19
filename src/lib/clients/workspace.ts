// The client workspace's shared data load.
//
// This is the query and derivation logic that used to sit inline at the top of
// the single client page, lifted out unchanged so the five workspace tabs read
// from one implementation instead of five copies. Nothing here is new: the
// queries, the N+1 avoidance, the health classification, the "why is this
// blocked" reasoning and the shapes handed to IntegrationCard / ClientPerformance
// / GenerateReport are exactly what the page did before.
//
// Every tab needs most of it — Overview counts sources and their health,
// Performance needs the visualizable ones, Data sources needs the cards, and
// both Reports and Automations gate on whether a synced snapshot exists — so it
// is loaded once per tab rather than split into partial loaders that would drift
// apart.
//
// A client can connect several accounts of one platform (migration 0049), so
// there is one entry per connected ACCOUNT (data source), plus one empty entry
// for each live platform the client hasn't connected.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { IntegrationSource } from "@/components/IntegrationCard";
import type { PerformanceSource } from "@/components/ClientPerformance";
import type { ConnectableIntegration } from "@/components/ConnectAccountModal";
import { allowsMultipleAccounts, liveIntegrations, listIntegrations, isConnectable } from "@/lib/integrations/registry";
import { hasAnalyticsView, groupForIntegration } from "@/lib/integrations/analyticsViews";
import { sourceHealth } from "@/lib/integrations/status";
import { reconnectDeadline } from "@/lib/integrations/tokenRenewal";
import type { CachedPeriodDays } from "@/lib/reports/periods";
import type { IntegrationDef } from "@/lib/integrations/types";

export type WorkspaceIntegration = {
  /** Unique within the workspace: the data source id, or the platform id for
   *  a platform that isn't connected. */
  key: string;
  def: IntegrationDef;
  source: IntegrationSource;
  snapshot: unknown;
  status: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  ready: boolean;
  health: ReturnType<typeof sourceHealth> | null;
  selectedDatasetId: string | null;
  selectedTableId: string | null;
  /** For a token that can't be extended (Facebook Login): the date to
   *  reconnect by, once it is near or past. Null when nothing is due. */
  reconnectBy: string | null;
  /** How many OTHER clients use the same saved sign-in (migration 0046). */
  sharedWith: number;
  /** This client's other accounts of the same platform on the same sign-in. */
  sameSignInHere: number;
  /** The chosen account's name, when one is chosen. */
  accountLabel: string | null;
  /** This client's other sources of the same platform. */
  siblings: number;
  /** Whether this platform takes more than one account per client. */
  allowsMultiple: boolean;
};

export type ClientWorkspace = {
  /** Which cached window every snapshot in this load came from. */
  periodDays: CachedPeriodDays;
  integrations: WorkspaceIntegration[];
  /** Sources the user has actually connected. */
  connectedIntegrations: WorkspaceIntegration[];
  /** Connected sources, anything unhealthy first. */
  sortedConnected: WorkspaceIntegration[];
  needingAttention: WorkspaceIntegration[];
  /** Sources with a real synced snapshot AND a chart block to render. */
  vizSources: WorkspaceIntegration[];
  performanceSources: PerformanceSource[];
  connectableIntegrations: ConnectableIntegration[];
  anyReady: boolean;
  anyConnected: boolean;
  hasSyncedData: boolean;
  /** Names whichever setup stage is actually missing, or undefined when ready. */
  dataBlockedReason: string | undefined;
};

type DsRow = {
  id: string;
  type: string;
  display_name: string | null;
  config: Record<string, unknown> | null;
  status: string | null;
  last_synced_at: string | null;
  last_sync_error: string | null;
  connection_id: string | null;
  created_at?: string | null;
  connection: SignInRow | SignInRow[] | null;
};

// The saved sign-in a source uses: no tokens, just what the UI shows.
type SignInRow = { identity_provider: string | null; token_expires_at: string | null; refresh_expires_at?: string | null };
const signInOf = (d: DsRow): SignInRow | null => (Array.isArray(d.connection) ? d.connection[0] ?? null : d.connection);

// Anything not healthy leads the list — needs_account / sync_error /
// needs_reconnect, in that order of how blocking they are.
const ATTENTION_RANK: Record<string, number> = { needs_reconnect: 0, sync_error: 1, needs_account: 2, healthy: 3 };

export async function loadClientWorkspace(
  supabase: SupabaseClient,
  clientId: string,
  // Which cached snapshot window to read. Every sync stores one row per window
  // in CACHED_PERIOD_DAYS, so this only ever selects between rows that already
  // exist — no derivation, no provider call, no change to any figure. 28 stays
  // the default, so every tab but Performance loads exactly as it did before.
  periodDays: CachedPeriodDays = 28,
): Promise<ClientWorkspace> {
  // Load this client's connections + the cached snapshots for `periodDays`
  // WITHOUT an N+1:
  // one query for all data_sources, then one query per snapshot table for the
  // connected sources (was: 2 queries × every live integration ≈ 60/page load).
  const { data: dsRows } = await supabase
    .from("data_sources")
    .select(
      "id, type, display_name, config, status, last_synced_at, last_sync_error, connection_id, created_at, " +
        "connection:connections!data_sources_connection_fkey(identity_provider, token_expires_at, refresh_expires_at)"
    )
    .eq("client_id", clientId)
    .order("created_at");
  const rows = (dsRows ?? []) as unknown as DsRow[];
  const dsByType = new Map<string, DsRow[]>();
  for (const d of rows) dsByType.set(d.type, [...(dsByType.get(d.type) ?? []), d]);

  // How many other clients share each saved sign-in this client uses.
  const signInIds = [...new Set(rows.map((d) => d.connection_id).filter((id): id is string => Boolean(id)))];
  const sharedClients = new Map<string, Set<string>>();
  if (signInIds.length) {
    const { data: siblings } = await supabase
      .from("data_sources")
      .select("connection_id, client_id")
      .in("connection_id", signInIds)
      .neq("client_id", clientId);
    for (const s of siblings ?? []) {
      const id = s.connection_id as string;
      const set = sharedClients.get(id) ?? new Set<string>();
      set.add(s.client_id as string);
      sharedClients.set(id, set);
    }
  }

  // Group connected sources by snapshot table, then bulk-fetch snapshots.
  const tableToIds = new Map<string, string[]>();
  for (const def of liveIntegrations()) {
    for (const ds of dsByType.get(def.id) ?? []) {
      if (!def.snapshotTable) continue;
      tableToIds.set(def.snapshotTable, [...(tableToIds.get(def.snapshotTable) ?? []), ds.id]);
    }
  }
  const snapshotByDsId = new Map<string, unknown>();
  await Promise.all(
    Array.from(tableToIds, async ([table, ids]) => {
      const { data: snaps } = await supabase
        .from(table)
        .select("data_source_id, data")
        .in("data_source_id", ids)
        .eq("period_days", periodDays);
      for (const s of snaps ?? []) snapshotByDsId.set(s.data_source_id as string, (s.data as unknown) ?? null);
    }),
  );

  const entryFor = (def: IntegrationDef, ds: DsRow | null, sameType: DsRow[]): WorkspaceIntegration => {
    const snapshot = ds?.id ? snapshotByDsId.get(ds.id) ?? null : null;
    const config = (ds?.config as Record<string, unknown> | null) ?? {};
    const accounts = def.readAccounts?.(config) ?? [];
    const selectedAccountId = def.readSelected?.(config) ?? null;
    const source: IntegrationSource = ds
      ? { id: ds.id, display_name: ds.display_name ?? null, accounts, selectedAccountId }
      : null;

    return {
      key: ds?.id ?? def.id,
      def,
      source,
      snapshot,
      status: ds?.status ?? null,
      lastSyncedAt: ds?.last_synced_at ?? null,
      lastSyncError: ds?.last_sync_error ?? null,
      ready: Boolean(source?.selectedAccountId),
      // Same classifier the dashboard, health page and integrations page read,
      // so this section's "needs attention" can't disagree with their counts.
      health: ds
        ? sourceHealth({
            status: ds.status,
            lastSyncError: ds.last_sync_error,
            selectedAccountId: source?.selectedAccountId ?? null,
          })
        : null,
      // BigQuery drills deeper than a single account — surface its dataset/table
      // selection so its dedicated card can restore the picker state.
      selectedDatasetId: (config.dataset_id as string | null) ?? null,
      selectedTableId: (config.table_id as string | null) ?? null,
      // Expiry and sign-in route belong to the saved sign-in when there is one.
      reconnectBy:
        ds && ds.status !== "revoked"
          ? reconnectDeadline({
              type: ds.type,
              config: { ...config, identity_provider: signInOf(ds)?.identity_provider ?? config.identity_provider },
              token_expires_at: signInOf(ds)?.token_expires_at ?? null,
              refresh_expires_at: signInOf(ds)?.refresh_expires_at ?? null,
            })
          : null,
      sharedWith: ds?.connection_id ? sharedClients.get(ds.connection_id)?.size ?? 0 : 0,
      sameSignInHere: ds?.connection_id ? sameType.filter((o) => o.id !== ds.id && o.connection_id === ds.connection_id).length : 0,
      accountLabel: selectedAccountId ? accounts.find((a) => a.id === selectedAccountId)?.name ?? selectedAccountId : null,
      siblings: ds ? sameType.length - 1 : 0,
      allowsMultiple: allowsMultipleAccounts(def),
    };
  };

  const integrations: WorkspaceIntegration[] = liveIntegrations().flatMap((def) => {
    const sameType = dsByType.get(def.id) ?? [];
    return sameType.length ? sameType.map((ds) => entryFor(def, ds, sameType)) : [entryFor(def, null, [])];
  });

  const connectedIntegrations = integrations.filter((i) => i.source !== null);
  const sortedConnected = [...connectedIntegrations].sort(
    (a, b) => (ATTENTION_RANK[a.health ?? "healthy"] ?? 3) - (ATTENTION_RANK[b.health ?? "healthy"] ?? 3),
  );
  const needingAttention = connectedIntegrations.filter((i) => i.health && i.health !== "healthy");

  const anyReady = integrations.some((i) => i.ready);
  const anyConnected = connectedIntegrations.length > 0;
  // Report generation reads a CACHED SNAPSHOT — a connected source with an
  // account selected but no completed sync still produces nothing.
  const hasSyncedData = integrations.some((i) => i.snapshot);
  const dataBlockedReason = hasSyncedData
    ? undefined
    : !anyConnected
      ? "Connect a data source before scheduling — there's nothing to report on yet."
      : !anyReady
        ? "Finish setting up the data source (choose a property or account), then run a sync."
        : "Waiting for the first sync. Use “Refresh now” on the data source — reports are built from synced data.";

  // A source only qualifies for a chart block once it has a real synced
  // snapshot — nothing here is ever fabricated.
  const vizSources = integrations.filter((i) => hasAnalyticsView(i.def.id) && i.snapshot);
  const performanceSources: PerformanceSource[] = vizSources.map((i) => ({
    id: i.def.id,
    key: i.key,
    // Two accounts of one platform are told apart by accountLabel.
    name: i.def.name,
    accountLabel: i.accountLabel,
    // Metric family, so Performance only ever combines like with like.
    group: groupForIntegration(i.def.id),
    snapshot: i.snapshot,
  }));

  // Everything in the registry, so discovery is complete: connectable providers
  // link into the existing consent screen, and the rest are listed as "Coming
  // soon" (disabled) rather than taking up a card.
  const connectableIntegrations: ConnectableIntegration[] = listIntegrations().map((def) => ({
    id: def.id,
    name: def.name,
    description: def.description,
    icon: def.icon,
    accent: def.accent,
    connected: dsByType.has(def.id),
    comingSoon: !isConnectable(def),
  }));

  return {
    periodDays,
    integrations,
    connectedIntegrations,
    sortedConnected,
    needingAttention,
    vizSources,
    performanceSources,
    connectableIntegrations,
    anyReady,
    anyConnected,
    hasSyncedData,
    dataBlockedReason,
  };
}
