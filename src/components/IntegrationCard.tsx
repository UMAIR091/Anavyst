"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { integrationIcon, integrationTint } from "@/components/integrationVisuals";
import type { IntegrationDescriptor } from "@/lib/integrations/types";

// Serializable, already-normalized connection passed from the server.
export type IntegrationSource = {
  id: string;
  display_name: string | null;
  accounts: { id: string; name: string }[];
  selectedAccountId: string | null;
} | null;

// One card for every integration: handles Connect, Select account, Save, Refresh
// (Sync), Disconnect, and Status. Behavior is identical across providers — only
// the descriptor differs.
export function IntegrationCard({
  descriptor,
  clientId,
  source,
  status = null,
  lastSyncedAt = null,
  lastSyncError = null,
  reconnectBy = null,
  sharedWith = 0,
  sameSignInHere = 0,
  accountLabel = null,
  allowsMultiple = false,
}: {
  descriptor: IntegrationDescriptor;
  clientId: string;
  source: IntegrationSource;
  status?: string | null;
  lastSyncedAt?: string | null;
  lastSyncError?: string | null;
  /** Set when the sign-in can't be renewed automatically and expires soon. */
  reconnectBy?: string | null;
  /** Other clients using the same saved sign-in (shared agency sign-ins). */
  sharedWith?: number;
  /** This client's other accounts of the platform on the same sign-in. */
  sameSignInHere?: number;
  /** Shown next to the name when the client has more than one account of
   *  this platform, to tell the cards apart. */
  accountLabel?: string | null;
  /** The platform takes more than one account per client (migration 0049). */
  allowsMultiple?: boolean;
}) {
  const router = useRouter();
  const [account, setAccount] = useState(source?.selectedAccountId ?? "");
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const Icon = integrationIcon(descriptor.icon);
  const tint = integrationTint(descriptor.accent);
  const noun = descriptor.accountNoun;
  // A revoked/expired grant needs the user to re-authorize — reuse the existing
  // consent → OAuth connect flow. connectHref is the same route as first connect.
  const needsReconnect = status === "revoked";
  // Connected but no account/property chosen yet — the sync cannot run.
  // Must be checked after needsReconnect so a revoked source doesn't also show
  // the account-selection banner (user needs to reconnect first).
  const needsAccount = !needsReconnect && source !== null && !source.selectedAccountId;
  const connectHref = `/dashboard/connect/${descriptor.id}?clientId=${clientId}`;
  // Facebook sign-ins last ~60 days and can't be extended, so the card warns
  // ahead of the date instead of the sync failing on the day.
  const expired = reconnectBy !== null && new Date(reconnectBy).getTime() <= Date.now();
  const showReconnectBy = !needsReconnect && reconnectBy !== null;
  // In UTC, so the server render and the browser agree on the day.
  const reconnectDay = reconnectBy
    ? new Date(reconnectBy).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    : null;

  if (!source) {
    return (
      <Card className="transition-colors hover:border-ink-300">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
              <Icon size={18} />
            </div>
            <div>
              <p className="font-medium text-ink-900">{descriptor.name}</p>
              <p className="text-sm text-ink-500">{descriptor.description}.</p>
            </div>
          </div>
          {descriptor.connectable ? (
            /* Route through the consent screen so the user sees what data is
               accessed and why before the provider's OAuth page — or, for
               api-key providers, before entering their key.
               This used to test `status === "live" && connectPath`, which hid
               the Connect button for every api-key integration and labelled it
               "Coming soon" even though the Integrations page offered it. */
            <Button asChild>
              <a href={`/dashboard/connect/${descriptor.id}?clientId=${clientId}`}>Connect</a>
            </Button>
          ) : (
            <span className="rounded-full bg-ink-100 px-2.5 py-1 text-xs font-medium text-ink-600">Coming soon</span>
          )}
        </CardContent>
      </Card>
    );
  }

  async function saveAccount() {
    // Switching a working source to another account: it then reports on that
    // one, and what it stored for the old one is cleared (so a report never
    // mixes the two). Adding the account alongside keeps both.
    const current = source!.selectedAccountId;
    if (current && account !== current) {
      const from = source!.accounts.find((a) => a.id === current)?.name ?? current;
      const to = source!.accounts.find((a) => a.id === account)?.name ?? account;
      const ok = await confirm({
        title: `Switch to ${to}?`,
        description: `This ${noun} will report on ${to} instead of ${from}, and the data stored for ${from} here is removed.${
          allowsMultiple ? ` To report on both, use “Add another ${noun}” instead.` : ""
        } Reports you’ve already generated are kept.`,
        confirmLabel: "Switch",
      });
      if (!ok) return;
    }
    setBusy(true);
    const res = await fetch("/api/google/save-property", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataSourceId: source!.id, accountId: account }),
    });
    setBusy(false);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(json.error ?? "Failed to save");
    toast.success(
      json.merged
        ? `That ${noun} was already connected for this client. It now uses this sign-in.`
        : `${noun.charAt(0).toUpperCase() + noun.slice(1)} saved`
    );
    router.refresh();
  }

  // With no account chosen there is nothing to sync yet, so "Refresh now" asks
  // the provider for its account list again instead. That is what the empty
  // state tells people to do, and the list is otherwise only read at connect.
  async function refreshNow() {
    setBusy(true);
    const relist = !source!.selectedAccountId;
    const res = await fetch(relist ? "/api/google/accounts" : "/api/google/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataSourceId: source!.id }),
    });
    setBusy(false);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return toast.error(json.error ?? (relist ? `Couldn’t fetch your ${noun} list` : "Failed to refresh data"));
    if (!relist) toast.success("Analytics refreshed");
    else if (json.accounts > 0) toast.success(`Found ${json.accounts} ${noun}${json.accounts === 1 ? "" : "s"}`);
    else toast.warning(`Still no ${noun} found for ${source!.display_name ?? "this connection"}`);
    router.refresh();
  }

  async function disconnect() {
    const what = accountLabel ? `${descriptor.name} (${accountLabel})` : descriptor.name;
    const keeps = [
      sharedWith > 0 ? `the ${sharedWith} other client${sharedWith === 1 ? "" : "s"} that use it` : null,
      sameSignInHere > 0 ? `this client’s other ${noun}${sameSignInHere === 1 ? "" : "s"} on it` : null,
    ].filter(Boolean);
    const description = keeps.length
      ? `This removes ${what} and its cached data from this client only. The sign-in stays for ${keeps.join(" and ")}. Reports you’ve already generated are kept.`
      : "This removes the connection and its cached data for this client, and deletes the saved sign-in. Reports you’ve already generated are kept.";
    if (!(await confirm({ title: `Disconnect ${descriptor.name}?`, description, confirmLabel: "Disconnect", destructive: true }))) return;
    setBusy(true);
    await fetch("/api/google/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataSourceId: source!.id }),
    });
    setBusy(false);
    toast.success("Disconnected");
    router.refresh();
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${tint}`}>
              <Icon size={18} />
            </div>
            <div>
              <p className="font-medium text-ink-900">
                {descriptor.name}
                {accountLabel && <span className="font-normal text-ink-500"> · {accountLabel}</span>}
              </p>
              {/* The header line must not read as a working connection while
                  the source cannot sync (P0-4). */}
              <p className="text-sm text-ink-500">
                Connected as {source.display_name}
                {sharedWith > 0 && (
                  <span>
                    {" "}· sign-in shared with {sharedWith} other client{sharedWith === 1 ? "" : "s"}
                  </span>
                )}
                {needsAccount && <span className="text-info-700"> — {noun} selection required</span>}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {(needsReconnect || showReconnectBy) && (
              <Button asChild size="sm">
                <a href={connectHref}>Reconnect</a>
              </Button>
            )}
            {allowsMultiple && source.selectedAccountId && (
              <a href={connectHref} className="text-xs font-medium text-brand-600 hover:underline">
                Add another {noun}
              </a>
            )}
            <button onClick={disconnect} disabled={busy} className="text-xs text-ink-500 transition-colors hover:text-danger-600 disabled:opacity-50">
              Disconnect
            </button>
          </div>
        </div>

        {needsReconnect && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-300 bg-warning-50 px-3 py-2.5 text-xs text-warning-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">Reconnection required.</span>{" "}
              {lastSyncError ?? `${descriptor.name} access has expired or was revoked.`} Syncing is paused until you{" "}
              <a href={connectHref} className="font-semibold underline">reconnect {descriptor.name}</a>.
            </span>
          </div>
        )}

        {showReconnectBy && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-300 bg-warning-50 px-3 py-2.5 text-xs text-warning-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              {/* Facebook sign-ins last ~60 days; LinkedIn needs a fresh sign-in
                  once a year. Either way it can't be renewed automatically. */}
              {expired ? (
                <>
                  <span className="font-semibold">{descriptor.name} access has expired.</span> It can&apos;t be renewed
                  automatically, so syncing stops until you{" "}
                </>
              ) : (
                <>
                  <span className="font-semibold">
                    {descriptor.name} access ends on {reconnectDay}.
                  </span>{" "}
                  {descriptor.name} needs a fresh sign-in by then; it can&apos;t be renewed automatically. To keep this
                  client&apos;s data syncing,{" "}
                </>
              )}
              <a href={connectHref} className="font-semibold underline">reconnect {descriptor.name}</a>
              {expired ? "." : " before then."}
            </span>
          </div>
        )}

        {needsAccount && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-info-200 bg-info-50 px-3 py-2.5 text-xs text-info-800">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">{noun.charAt(0).toUpperCase() + noun.slice(1)} selection required.</span>{" "}
              {source.accounts.length > 0 ? (
                <>
                  The connection succeeded, but no {noun} has been chosen yet — syncing is paused until you select one
                  below and click <span className="font-semibold">Save</span>.
                </>
              ) : (
                // Instagram and Pinterest land here: connected, but the provider
                // returned no selectable accounts, so "choose one below" would
                // point at an empty dropdown.
                <>
                  The connection succeeded, but no {noun} is available to choose yet. Click{" "}
                  <span className="font-semibold">Refresh now</span> to fetch the list — if it stays empty, the
                  connected profile has no {noun} that {descriptor.name} can report on.
                </>
              )}
            </span>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium capitalize text-ink-700">{noun}</label>
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="field h-10 w-full"
            >
              <option value="">Select a {noun}…</option>
              {source.accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>
          <Button variant="outline" onClick={saveAccount} disabled={busy || !account || account === source.selectedAccountId}>
            Save
          </Button>
          <Button onClick={refreshNow} disabled={busy}>
            <RefreshCw size={16} className={busy ? "animate-spin" : ""} /> {busy ? "Refreshing…" : "Refresh now"}
          </Button>
        </div>

        {source.selectedAccountId && lastSyncError && !needsReconnect && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              Last sync failed: {lastSyncError}. Click Refresh now to retry, or{" "}
              <a href={connectHref} className="font-semibold underline">
                reconnect {descriptor.name}
              </a>{" "}
              if access expired or was revoked.
            </span>
          </div>
        )}

        {source.selectedAccountId && (
          <p className="mt-3 text-xs text-ink-500">
            {lastSyncedAt
              ? `Auto-synced ${formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })} · refreshes automatically every few hours`
              : "Not synced yet — click Refresh now or wait for the next scheduled sync."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
