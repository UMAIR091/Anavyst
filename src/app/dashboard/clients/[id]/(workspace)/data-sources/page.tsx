import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { ClientSection } from "@/components/ClientSection";
import { IntegrationCard } from "@/components/IntegrationCard";
import { BigQueryCard } from "@/components/BigQueryCard";
import { ConnectAccountButton } from "@/components/ConnectAccountModal";
import { ConnectLinkButton, type ActiveLink } from "@/components/ConnectLinkButton";
import { linkConnectable } from "@/lib/connectLinks";
import {
  AvailableIntegrations, ConnectedSource, type AvailableIntegration,
} from "@/components/ClientDataSourceGroups";
import { loadClientWorkspace, type WorkspaceIntegration } from "@/lib/clients/workspace";
import { descriptor } from "@/lib/integrations/registry";
import { groupForIntegration, type MetricGroup } from "@/lib/integrations/analyticsViews";

export const dynamic = "force-dynamic";

// Data sources, in the three states a source can actually be in.
//
//   Needs attention — connected but not working: a revoked grant, a failed
//     sync, or no account chosen yet. Always open, always first, because each
//     one is a task.
//   Connected — working. Collapsed to a line each; the same card, with the
//     same account picker, Save, Refresh now and Disconnect, is one click away.
//   Available — what could be connected next, as a short grid over the full
//     searchable list.
//
// Every action is the one that was already here: the cards are unchanged and
// still call the same routes, and every "connect" link points at the existing
// consent screen. What changed is that a client with eight healthy sources and
// one broken one no longer buries the broken one under eight open forms.
//
// Integrations that can't be connected yet are not listed. A row you can't
// click isn't a feature, and they remain findable by name in the full list.

// A source in the "Available" grid is shown only if it isn't connected and can
// actually be connected. Paid ads first — the order the connect modal uses.
const GROUP_ORDER: MetricGroup[] = ["paid", "seo", "analytics", "social", "commerce", "crm", "email", "calls", "other"];
/** Enough to suggest a next step without becoming a catalogue. */
const MAX_AVAILABLE_TILES = 8;

export default async function ClientDataSourcesPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) redirect("/login");

  const supabase = createClient();
  const { data: client } = await supabase.from("clients").select("id, name, archived").eq("id", params.id).maybeSingle();
  if (!client) notFound();

  const ws = await loadClientWorkspace(supabase, client.id as string);
  const clientId = client.id as string;

  const healthy = ws.connectedIntegrations.filter((i) => i.health === "healthy");
  const attention = ws.needingAttention;

  const connectAction = (
    <ConnectAccountButton clientId={clientId} integrations={ws.connectableIntegrations} label="Add data source" />
  );

  // "Send connect link" (migration 0048): platforms a client can connect
  // through a link, and this client's links that still work. RLS-scoped; the
  // links carry no token (only its hash is stored, and that isn't readable).
  // One entry per platform (a client can have several accounts of one).
  const linkIntegrations = ws.integrations
    .filter((i, n, all) => linkConnectable(i.def) && all.findIndex((o) => o.def.id === i.def.id) === n)
    .map((i) => ({
      id: i.def.id,
      name: i.def.name,
      icon: i.def.icon,
      connected: ws.connectedIntegrations.some((c) => c.def.id === i.def.id),
    }));
  const { data: linkRows } = await supabase
    .from("connect_links")
    .select("id, types, expires_at, last_used_at")
    .eq("client_id", clientId)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });
  const activeLinks: ActiveLink[] = (linkRows ?? []).map((l) => ({
    id: l.id as string,
    types: l.types as string[],
    expiresAt: l.expires_at as string,
    lastUsedAt: (l.last_used_at as string | null) ?? null,
  }));
  const headerActions = (
    <div className="flex flex-wrap gap-2">
      {!client.archived && (
        <ConnectLinkButton
          clientId={clientId}
          clientName={(client.name as string) ?? "this client"}
          integrations={linkIntegrations}
          links={activeLinks}
        />
      )}
      {connectAction}
    </div>
  );

  // Everything connectable that this client hasn't connected, in the same
  // grouped order the modal browses in.
  const available = ws.connectableIntegrations.filter((i) => !i.connected && !i.comingSoon);
  const availableTiles: AvailableIntegration[] = GROUP_ORDER.flatMap((g) =>
    available.filter((i) => groupForIntegration(i.id) === g),
  )
    .slice(0, MAX_AVAILABLE_TILES)
    .map((i) => ({ id: i.id, name: i.name, icon: i.icon, accent: i.accent }));

  // The card for one source — identical props to before, so behaviour is too.
  const card = (i: WorkspaceIntegration) =>
    i.def.id === "bigquery" ? (
      <BigQueryCard
        descriptor={descriptor(i.def)}
        clientId={clientId}
        source={i.source}
        selectedDatasetId={i.selectedDatasetId}
        selectedTableId={i.selectedTableId}
        status={i.status}
        lastSyncedAt={i.lastSyncedAt}
        lastSyncError={i.lastSyncError}
      />
    ) : (
      <IntegrationCard
        descriptor={descriptor(i.def)}
        clientId={clientId}
        source={i.source}
        status={i.status}
        lastSyncedAt={i.lastSyncedAt}
        lastSyncError={i.lastSyncError}
        reconnectBy={i.reconnectBy}
        sharedWith={i.sharedWith}
        sameSignInHere={i.sameSignInHere}
        accountLabel={i.siblings > 0 ? i.accountLabel : null}
        allowsMultiple={i.allowsMultiple}
      />
    );

  const accountName = (i: WorkspaceIntegration) =>
    i.source?.accounts.find((a) => a.id === i.source?.selectedAccountId)?.name ?? i.source?.display_name ?? null;

  if (ws.connectedIntegrations.length === 0) {
    return (
      <ClientSection
        title="Data sources"
        description="Connect a platform to start pulling this client's data."
        action={headerActions}
      >
        <div className="rounded-2xl border border-dashed border-ink-300 bg-surface px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink-800">No data sources connected yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-500">
            Connect this client&apos;s Search Console, GA4, Meta Ads or any of the other platforms. Anavyst syncs
            the data automatically and builds their reports from it.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <ConnectAccountButton
              clientId={clientId}
              integrations={ws.connectableIntegrations}
              label="Add data source"
              variant="default"
            />
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/integrations">Browse all integrations</Link>
            </Button>
          </div>
        </div>
      </ClientSection>
    );
  }

  return (
    <div>
      {attention.length > 0 && (
        <ClientSection
          title="Needs attention"
          description={`${attention.length} source${attention.length === 1 ? "" : "s"} can't sync until you act.`}
        >
          {/* No per-card label above these: each card already names the source
              and states its problem in a coloured banner, so a heading would
              print the same two facts a second time. */}
          <div className="space-y-3">
            {attention.map((i) => (
              <div key={i.key}>{card(i)}</div>
            ))}
          </div>
        </ClientSection>
      )}

      <ClientSection
        title="Connected"
        description={
          healthy.length === 0
            ? "Nothing is syncing cleanly yet."
            : `${healthy.length} source${healthy.length === 1 ? "" : "s"} syncing. Open one to change its account or refresh it.`
        }
        action={headerActions}
      >
        {healthy.length === 0 ? (
          <p className="rounded-card border border-dashed border-ink-300 bg-surface px-4 py-6 text-center text-sm text-ink-500">
            Every connected source is listed above — fix those and they appear here.
          </p>
        ) : (
          <div className="overflow-hidden rounded-card border border-ink-200 bg-surface">
            {healthy.map((i) => (
              <ConnectedSource
                key={i.key}
                rowId={i.key}
                name={i.def.name}
                icon={i.def.icon}
                accent={i.def.accent}
                accountLabel={accountName(i)}
                lastSyncedAt={i.lastSyncedAt}
              >
                {card(i)}
              </ConnectedSource>
            ))}
          </div>
        )}
      </ClientSection>

      {availableTiles.length > 0 && (
        <ClientSection title="Add another platform" description="Connected per client, read-only.">
          <AvailableIntegrations
            clientId={clientId}
            integrations={availableTiles}
            totalAvailable={available.length}
            browseAction={connectAction}
          />
        </ClientSection>
      )}
    </div>
  );
}
