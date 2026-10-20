import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow, format } from "date-fns";
import { AlertTriangle, CheckCircle2, Clock, Copy, ExternalLink, History, Users } from "lucide-react";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { integrationIcon, integrationTint } from "@/components/integrationVisuals";
import { RemoveSignInButton } from "@/components/RemoveSignInButton";
import { getIntegrationName } from "@/lib/integrations/names";
import {
  buildConnectionsView, WAITING_FLAG_DAYS, type ClientRow, type ConnectionRow, type SignInView, type SourceRow,
} from "@/lib/integrations/connectionsView";

export const dynamic = "force-dynamic";

// Every saved sign-in in the workspace in one place (shared sign-ins 0046,
// client connect links 0048, accounts 0049): who authorized it, who owns it,
// which clients use it, its health, last good sync and when it must be
// reconnected, with Reconnect, Review duplicate and Remove everywhere. Also
// ad accounts on more than one client, sources left waiting for an account,
// and recent connection activity (0053). All reads are RLS-scoped and none
// touch tokens.

const HEALTH: Record<SignInView["health"], { label: string; tone: string }> = {
  healthy: { label: "Healthy", tone: "bg-success-50 text-success-700" },
  attention: { label: "Needs attention", tone: "bg-warning-50 text-warning-800" },
  expired: { label: "Expired", tone: "bg-danger-50 text-danger-700" },
  waiting: { label: "Waiting for an account", tone: "bg-info-50 text-info-800" },
};

const ACTION_LABELS: Record<string, string> = {
  connect: "Connected",
  reconnect: "Reconnected",
  client_connect: "Client connected through a link",
  attach: "Used a saved sign-in",
  select_account: "Chose an account",
  combine: "Combined two sign-ins",
  reuse: "Switched to a saved sign-in",
  disconnect: "Disconnected from a client",
  remove_sign_in: "Removed everywhere",
  revoke_at_provider: "Access cancelled at the platform",
  expired: "Expired at the platform",
  deauthorized: "Removed by the person at the platform",
  data_deleted: "Data deletion request from the platform",
  store_uninstalled: "App uninstalled from the store",
  store_data_deleted: "Store data deletion request",
};

const day = (iso: string) => format(new Date(iso), "d MMM yyyy");

export default async function ConnectionsPage() {
  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) redirect("/login");
  const supabase = createClient();

  const [{ data: conns }, { data: sources }, { data: clients }, { data: events }] = await Promise.all([
    supabase
      .from("connections")
      .select("id, type, client_id, identity_provider, display_name, subject_hash, status, token_expires_at, refresh_expires_at, created_at")
      .eq("agency_id", agency.id)
      .order("created_at"),
    supabase
      .from("data_sources")
      .select("id, client_id, type, connection_id, account_key, status, last_synced_at, last_sync_error, config, created_at")
      .eq("agency_id", agency.id),
    supabase.from("clients").select("id, name, archived").eq("agency_id", agency.id),
    supabase
      .from("connection_events")
      .select("id, action, actor, outcome, platform, client_id, detail, created_at")
      .eq("agency_id", agency.id)
      .order("created_at", { ascending: false })
      .limit(30),
  ]);

  const view = buildConnectionsView({
    connections: (conns ?? []) as ConnectionRow[],
    sources: (sources ?? []) as SourceRow[],
    clients: (clients ?? []) as ClientRow[],
  });
  const clientName = new Map(((clients ?? []) as ClientRow[]).map((c) => [c.id, c.name ?? "a client"]));
  type EventRow = { id: string; action: string; actor: string; outcome: string; platform: string | null; client_id: string | null; detail: Record<string, unknown>; created_at: string };

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-[clamp(24px,3vw,28px)] font-semibold tracking-[-0.03em] text-ink-900">Connections</h1>
        <p className="mt-1 text-[14.5px] text-ink-500">
          Every saved sign-in in your workspace: who signed in, which clients use it, and when it needs renewing.
          Reconnecting a sign-in renews it for every client on it.
        </p>
      </div>

      {view.sharedAccounts.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <Copy size={16} className="text-warning-600" /> Accounts connected to more than one client
            </div>
            <p className="mt-1 text-sm text-ink-500">
              Each of these clients&apos; reports shows the same account&apos;s figures. That&apos;s fine for a shared account;
              if it wasn&apos;t intended, change the account on one of them.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-ink-700">
              {view.sharedAccounts.map((a) => (
                <li key={`${a.platform}-${a.account}`}>
                  <span className="font-medium">{a.platform} · {a.account}</span>: {a.clients.join(", ")}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {view.waiting.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <Clock size={16} className="text-info-600" /> Waiting for an account for over {WAITING_FLAG_DAYS} days
            </div>
            <p className="mt-1 text-sm text-ink-500">
              Signed in, but no account was chosen, so nothing syncs. Choose one, or disconnect it from the client.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm">
              {view.waiting.map((w) => (
                <li key={w.sourceId}>
                  <Link href={`/dashboard/clients/${w.clientId}/data-sources`} className="font-medium text-brand-600 hover:underline">
                    {w.platform} for {w.clientName}
                  </Link>{" "}
                  <span className="text-ink-500">since {day(w.since)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {view.signIns.length === 0 ? (
        <p className="rounded-card border border-dashed border-ink-300 bg-surface px-4 py-8 text-center text-sm text-ink-500">
          No saved sign-ins yet. Connect a platform from a client&apos;s Data sources tab.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.signIns.map((s) => {
            const Icon = integrationIcon(s.icon);
            const health = HEALTH[s.health];
            const names = [...new Set(s.clients.map((c) => c.clientName))];
            return (
              <li key={s.id}>
                <Card>
                  <CardContent className="p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${integrationTint(s.accent)}`}>
                          <Icon size={18} aria-hidden />
                        </span>
                        <div className="min-w-0">
                          <p className="font-medium text-ink-900">
                            {s.platform}
                            {s.signedInAs && <span className="font-normal text-ink-500"> · signed in as {s.signedInAs}</span>}
                            {s.via && <span className="font-normal text-ink-500"> · via {s.via}</span>}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-500">
                            {s.owner.kind === "client"
                              ? `${s.owner.clientName}'s own sign-in (connect link): only ${s.owner.clientName} can use it`
                              : "Agency sign-in: can be used for any of your clients"}
                            {s.lastSyncedAt ? ` · last synced ${formatDistanceToNow(new Date(s.lastSyncedAt), { addSuffix: true })}` : " · not synced yet"}
                          </p>
                        </div>
                      </div>
                      <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${health.tone}`}>{health.label}</span>
                    </div>

                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                      <div>
                        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
                          <Users size={13} aria-hidden /> Used for
                        </p>
                        {s.clients.length === 0 ? (
                          <p className="mt-1 text-sm text-ink-500">No client.</p>
                        ) : (
                          <ul className="mt-1 space-y-1 text-sm text-ink-700">
                            {s.clients.map((c) => (
                              <li key={c.sourceId}>
                                <Link href={`/dashboard/clients/${c.clientId}/data-sources`} className="hover:underline">
                                  {c.clientName}
                                </Link>
                                <span className="text-ink-500"> · {c.account ?? "no account chosen"}</span>
                                {c.archived && <span className="text-ink-400"> · archived</span>}
                                {c.status === "error" && c.error && (
                                  <span className="mt-0.5 block text-xs text-warning-800">{c.error}</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <div>
                        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-500">
                          <Clock size={13} aria-hidden /> Renewal
                        </p>
                        <p className="mt-1 text-sm text-ink-700">
                          {s.expiry.kind === "reconnect_by" && s.expiry.date
                            ? `Reconnect by ${day(s.expiry.date)}`
                            : s.expiry.kind === "renews_until" && s.expiry.date
                              ? `Renews until ${day(s.expiry.date)}`
                              : s.expiry.kind === "never"
                                ? "Doesn't expire"
                                : "Renews automatically"}
                        </p>
                        <p className="text-xs text-ink-500">
                          {s.expiry.note}
                          {s.expiry.date && s.expiry.confirmed ? ` (date from ${s.platform})` : ""}.
                        </p>
                      </div>
                    </div>

                    {s.duplicateOf && (
                      <p className="mt-4 flex items-start gap-2 text-xs text-warning-800">
                        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                        <span>
                          {s.duplicateOf.strong ? "The same login as" : "Same name as"} “{s.duplicateOf.displayName ?? "another sign-in"}”,
                          saved earlier.{" "}
                          {s.reviewHref && (
                            <Link href={s.reviewHref} className="font-medium underline">
                              Review
                            </Link>
                          )}
                        </span>
                      </p>
                    )}

                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
                      {s.reconnectHref && (
                        <Button asChild size="sm" variant={s.health === "expired" ? "default" : "outline"}>
                          <Link href={s.reconnectHref}>Reconnect</Link>
                        </Button>
                      )}
                      {s.owner.kind === "client" && (
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/dashboard/clients/${s.owner.clientId}/data-sources`}>Send a new connect link</Link>
                        </Button>
                      )}
                      <RemoveSignInButton
                        connectionId={s.id}
                        platform={s.platform}
                        signedInAs={s.signedInAs}
                        clients={names}
                        clientCount={new Set(s.clients.map((c) => c.clientId)).size}
                        revokesAtProvider={s.revokesAtProvider}
                        accessSettings={s.accessSettings}
                      />
                      {!s.revokesAtProvider && s.accessSettings.url && (
                        <a
                          href={s.accessSettings.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-800"
                        >
                          Manage access at {s.platform} <ExternalLink size={12} aria-hidden />
                        </a>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <History size={16} className="text-brand-600" /> Recent connection activity
          </div>
          {(events ?? []).length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">Nothing yet. Connections, reconnects and removals appear here.</p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100 text-sm">
              {((events ?? []) as EventRow[]).map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                  <span className="text-ink-800">
                    {e.outcome === "failed" ? (
                      <AlertTriangle size={13} className="mr-1 inline text-warning-600" aria-hidden />
                    ) : (
                      <CheckCircle2 size={13} className="mr-1 inline text-success-600" aria-hidden />
                    )}
                    {ACTION_LABELS[e.action] ?? e.action}
                    {e.outcome === "failed" ? " (failed)" : ""}
                    {e.platform ? ` · ${getIntegrationName(e.platform)}` : ""}
                    {e.client_id ? ` · ${clientName.get(e.client_id) ?? "a client"}` : ""}
                    {typeof e.detail?.signedInAs === "string" ? ` · ${e.detail.signedInAs}` : ""}
                    {e.outcome === "failed" && typeof e.detail?.error === "string" ? (
                      <span className="block text-xs text-ink-500">{e.detail.error}</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-ink-500">{formatDistanceToNow(new Date(e.created_at), { addSuffix: true })}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
