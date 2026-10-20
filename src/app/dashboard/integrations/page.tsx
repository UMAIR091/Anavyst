import Link from "next/link";
import { redirect } from "next/navigation";
import { Users, Plug } from "lucide-react";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { IntegrationSearch } from "@/components/IntegrationSearch";
import { ConnectedAccountsTable, type ConnectedAccountRow } from "@/components/ConnectedAccountsTable";
import type { DataSourceCardData } from "@/components/DataSourceCard";
import { listIntegrations, isConnectable } from "@/lib/integrations/registry";
import { getIntegrationName } from "@/lib/integrations/names";
import { sourceHealth, countHealth } from "@/lib/integrations/status";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const { user } = await getCurrentUserAndAgency();
  if (!user) redirect("/login");

  const supabase = createClient();

  const { data: clientRows } = await supabase
    .from("clients")
    .select("id, name")
    .eq("archived", false)
    .order("name");
  const clients = clientRows ?? [];

  // Every connection across the agency's active clients, with the fields the
  // Connected Accounts table needs. One query — no per-client fan-out.
  type DsRow = {
    id: string; type: string; display_name: string | null;
    config: Record<string, unknown> | null; status: string | null;
    last_synced_at: string | null; last_sync_error: string | null; client_id: string;
  };
  const clientNameById = new Map(clients.map((c) => [c.id as string, c.name as string]));
  const { data: dsRows } = clients.length
    ? await supabase
        .from("data_sources")
        .select("id, type, display_name, config, status, last_synced_at, last_sync_error, client_id")
        .in("client_id", clients.map((c) => c.id))
    : { data: [] as DsRow[] };
  const sources = (dsRows ?? []) as DsRow[];

  const integrations = listIntegrations();
  const defById = new Map(integrations.map((d) => [d.id, d]));

  // Connecting happens on a client's page. Single-client agencies go straight
  // there; everyone else to the picker (or to create their first client).
  const connectHref =
    clients.length === 0 ? "/dashboard/clients/new" : clients.length === 1 ? `/dashboard/clients/${clients[0].id}` : "/dashboard/clients";

  // Clients, not sources: a client can connect several accounts of one
  // platform (migration 0049).
  const connectedCount = (typeId: string) => new Set(sources.filter((s) => s.type === typeId).map((s) => s.client_id)).size;

  // ── Available: only what a user can genuinely start connecting today. ──
  // isConnectable, not effectiveStatus, so this list can never offer a Connect
  // button for something the client page treats as unconnectable.
  const available: DataSourceCardData[] = integrations
    .filter(isConnectable)
    .map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      accent: def.accent,
      status: "live" as const,
      connectedCount: connectedCount(def.id),
      connectHref,
    }));

  // Genuinely not connectable yet — kept visible as a roadmap, clearly apart
  // from the connectable set above.
  const upcoming = integrations.filter((def) => !isConnectable(def));

  // ── Connected accounts, newest-looking issues first. ──
  const accountRows: ConnectedAccountRow[] = sources
    .map((s) => {
      const def = defById.get(s.type);
      const config = (s.config ?? {}) as Record<string, unknown>;
      const accounts = def?.readAccounts?.(config) ?? [];
      const selectedId = def?.readSelected?.(config) ?? null;
      return {
        dataSourceId: s.id,
        integrationId: s.type,
        platform: def?.name ?? getIntegrationName(s.type),
        icon: def?.icon ?? "Plug",
        accent: def?.accent ?? "ink",
        accountLabel: accounts.find((a) => a.id === selectedId)?.name ?? s.display_name ?? null,
        // Shared classifier (P0-1) rather than this page's own rule, which
        // only flagged a missing account when the provider had already fetched
        // its account list — so Instagram and Pinterest read as plain "Connected".
        health: sourceHealth({ status: s.status, lastSyncError: s.last_sync_error, selectedAccountId: selectedId }),
        clientId: s.client_id,
        clientName: clientNameById.get(s.client_id) ?? "Unknown client",
        status: s.status,
        lastSyncedAt: s.last_synced_at,
        lastSyncError: s.last_sync_error,
      };
    })
    // Surface anything needing attention at the top of the table.
    .sort((a, b) => {
      const weight = (r: ConnectedAccountRow) =>
        r.health === "needs_reconnect" ? 0 : r.health === "sync_error" ? 1 : r.health === "needs_account" ? 2 : 3;
      return weight(a) - weight(b) || a.clientName.localeCompare(b.clientName) || a.platform.localeCompare(b.platform);
    });

  // The summary strip reads the same classifier as every other health count.
  const counts = countHealth(accountRows.map((r) => r.health));
  const clientsWithSources = new Set(accountRows.map((r) => r.clientId)).size;
  const breakdown = [
    counts.needsReconnect && `${counts.needsReconnect} reconnect`,
    counts.syncError && `${counts.syncError} sync error${counts.syncError === 1 ? "" : "s"}`,
    counts.needsAccount && `${counts.needsAccount} account choice${counts.needsAccount === 1 ? "" : "s"}`,
  ].filter(Boolean).join(" · ");
  const heading = (title: string, sub: string, trailing?: React.ReactNode) => (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <div>
        <h2 className="text-[15px] font-semibold text-ink-900">{title}</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-400">{sub}</p>
      </div>
      {trailing}
    </div>
  );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[clamp(24px,3vw,28px)] font-semibold tracking-[-0.03em] text-ink-900">Integrations</h1>
          <p className="mt-1 text-[14.5px] text-ink-500">Every data source connected across your clients, and what you can add next.</p>
        </div>
        {/* Saved sign-ins, their renewal dates and activity (connections page). */}
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard/connections">Manage sign-ins</Link>
        </Button>
      </div>

      {accountRows.length > 0 && (
        <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-card border border-ink-200 bg-ink-200 sm:grid-cols-3">
          <div className="bg-surface px-[18px] py-4">
            <dt className="text-[12.5px] text-ink-400">Connections</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{counts.total}</dd>
            <dd className="text-[12.5px] text-ink-500">across {clientsWithSources} of {clients.length} client{clients.length === 1 ? "" : "s"}</dd>
          </div>
          <div className="bg-surface px-[18px] py-4">
            <dt className="text-[12.5px] text-ink-400">Healthy</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums text-success-700">{counts.healthy}</dd>
            <dd className="text-[12.5px] text-ink-500">syncing on schedule</dd>
          </div>
          <div className="bg-surface px-[18px] py-4">
            <dt className="text-[12.5px] text-ink-400">Need attention</dt>
            <dd className={`mt-1 text-2xl font-semibold tabular-nums ${counts.needsAttention ? "text-danger-700" : "text-ink-900"}`}>{counts.needsAttention}</dd>
            <dd className="text-[12.5px] text-ink-500">{breakdown || "nothing to fix"}</dd>
          </div>
        </dl>
      )}

      {/* ── Connected accounts ── */}
      <section>
        {heading(
          "Connected accounts",
          "Every account connected across your clients.",
          accountRows.length > 0 ? <span className="text-[12.5px] text-ink-400">Issues first</span> : undefined
        )}

        {clients.length === 0 ? (
          <EmptyState
            icon={Users}
            title="Add a client first"
            description="Integrations are connected per client. Add a client, then connect a data source."
            action={<Button asChild><Link href="/dashboard/clients/new">Add a client</Link></Button>}
          />
        ) : accountRows.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No accounts connected yet"
            description="Pick an integration above and connect it to one of your clients — its data appears here once linked."
            action={<Button asChild><Link href={connectHref}>Connect a data source</Link></Button>}
          />
        ) : (
          <ConnectedAccountsTable rows={accountRows} />
        )}
      </section>

      {/* ── Available integrations ── */}
      <section>
        {heading(
          "Available to connect",
          "Connected per client, read-only.",
          <span className="text-[12.5px] text-ink-400">{available.length} available</span>
        )}
        <IntegrationSearch integrations={available} />
      </section>

      {/* ── Roadmap: genuinely not connectable yet ── */}
      {upcoming.length > 0 && (
        <section>
          {heading("Coming soon", "Built and on the way — not yet available to connect.")}
          <div className="flex flex-wrap gap-1.5">
            {upcoming.map((def) => (
              <span key={def.id} className="rounded-full bg-segment px-2.5 py-[5px] text-[12.5px] text-ink-500">{def.name}</span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
