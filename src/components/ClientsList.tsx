"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Search, MoreHorizontal, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { setClientArchivedAction } from "@/app/dashboard/clients/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { StatusChip } from "@/components/ui/status-chip";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ClientMonogram } from "@/components/dashboard/HomeCards";
import { getIntegrationName } from "@/lib/integrations/names";
import type { ClientStatus } from "@/lib/dashboard/clientStatus";

export type ClientRow = {
  id: string;
  name: string;
  logo_url: string | null;
  email: string | null;
  website: string | null;
  notes: string | null;
  archived: boolean;
  data_sources: { type: string; updated_at: string }[] | null;
  /** Rolled up from the client's sources (lib/dashboard/clientStatus). */
  status: ClientStatus;
  /** Formatted on the server; null when there is none. */
  lastReport: string | null;
  nextDelivery: string | null;
};

type Filter = "all" | "attention" | "healthy";

// Display names come from the shared map (P0-3) — this file used to keep its
// own three-entry table and fall back to the raw type, which is how
// "instagram" / "pinterest_ads" / "meta_ads" reached the UI.

const needsYou = (c: ClientRow) => c.status.key !== "healthy" && c.status.key !== "first_sync";

const GRID = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_36px] items-center gap-3";

export function ClientsList({ clients }: { clients: ClientRow[] }) {
  const router = useRouter();
  const supabase = createClient();
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const confirm = useConfirm();

  // Close the row menu on outside-click or Escape (consistent dropdown behavior).
  useEffect(() => {
    if (!menuId) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as Element).closest("[data-row-menu]")) setMenuId(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuId(null);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (c.archived !== showArchived) return false;
      if (!showArchived && filter === "attention" && !needsYou(c)) return false;
      if (!showArchived && filter === "healthy" && c.status.key !== "healthy") return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.website ?? "").toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q);
    });
  }, [clients, search, showArchived, filter]);

  const active = clients.filter((c) => !c.archived);
  const activeCount = active.length;
  const archivedCount = clients.length - activeCount;

  async function setArchived(id: string, archived: boolean) {
    setBusyId(id);
    setMenuId(null);
    // Through the server: restoring a client counts against the plan limit.
    const res = await setClientArchivedAction(id, archived);
    setBusyId(null);
    if (!res.ok) {
      if (res.upgrade) {
        toast.error(res.error, { action: { label: "Upgrade", onClick: () => router.push("/dashboard/billing") } });
      } else {
        toast.error(res.error);
      }
      return;
    }
    toast.success(archived ? "Client archived" : "Client restored");
    router.refresh();
  }

  async function remove(id: string, name: string) {
    setMenuId(null);
    if (!(await confirm({ title: "Delete client?", description: `Deleting “${name}” also removes its reports. This can’t be undone.`, confirmLabel: "Delete", destructive: true }))) return;
    setBusyId(id);
    await supabase.from("clients").delete().eq("id", id);
    setBusyId(null);
    toast.success("Client deleted");
    router.refresh();
  }

  if (clients.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-ink-300 bg-surface px-6 py-14 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <UserPlus size={22} aria-hidden />
        </span>
        <h2 className="mt-3.5 text-lg font-semibold text-ink-900">Add your first client</h2>
        <p className="mx-auto mt-1.5 max-w-[420px] text-sm leading-relaxed text-ink-500">
          A client is where everything lives — connect their data once and every report, schedule and insight is built
          for them automatically.
        </p>
        <Button asChild className="mt-[18px]">
          <Link href="/dashboard/clients/new">Add client</Link>
        </Button>
      </div>
    );
  }

  const menu = (c: ClientRow) => (
    <div className="relative" data-row-menu>
      <button
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuId(menuId === c.id ? null : c.id); }}
        aria-expanded={menuId === c.id}
        aria-label={`Actions for ${c.name}`}
        className="flex h-8 w-8 items-center justify-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-ink-900"
        disabled={busyId === c.id}
      >
        <MoreHorizontal size={17} />
      </button>
      {menuId === c.id && (
        <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-control border border-ink-200 bg-surface py-1 shadow-lg">
          <Link href={`/dashboard/clients/${c.id}/edit`} className="block px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-50">Edit</Link>
          <button onClick={() => setArchived(c.id, !c.archived)} className="block w-full px-3 py-1.5 text-left text-sm text-ink-700 hover:bg-ink-50">
            {c.archived ? "Unarchive" : "Archive"}
          </button>
          <button onClick={() => remove(c.id, c.name)} className="block w-full px-3 py-1.5 text-left text-sm text-danger-600 hover:bg-danger-50">Delete</button>
        </div>
      )}
    </div>
  );

  const chips = (c: ClientRow) => {
    const sources = c.data_sources ?? [];
    // One chip per platform; a client can connect several accounts of one.
    const perType = new Map<string, number>();
    for (const s of sources) perType.set(s.type, (perType.get(s.type) ?? 0) + 1);
    return sources.length ? (
      [...perType].map(([type, n]) => (
        <span key={type} className="whitespace-nowrap rounded-md bg-surface-muted px-[7px] py-0.5 text-[11.5px] text-ink-600">
          {getIntegrationName(type)}
          {n > 1 ? ` ×${n}` : ""}
        </span>
      ))
    ) : (
      <span className="rounded-md bg-surface-muted px-[7px] py-0.5 text-[11.5px] text-ink-500">None yet</span>
    );
  };

  const status = (c: ClientRow) =>
    c.archived ? <StatusChip tone="muted">Archived</StatusChip> : <StatusChip tone={c.status.tone}>{c.status.label}</StatusChip>;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[220px] flex-[1_1_260px]">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <Input
            aria-label="Search clients"
            placeholder="Search by name, website or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {!showArchived && (
          <Segmented<Filter>
            label="Filter clients by status"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "attention", label: "Needs attention", count: active.filter(needsYou).length },
              { value: "healthy", label: "Healthy" },
            ]}
          />
        )}
        <Segmented<"active" | "archived">
          label="Show active or archived clients"
          value={showArchived ? "archived" : "active"}
          onChange={(v) => setShowArchived(v === "archived")}
          options={[
            { value: "active", label: "Active", count: activeCount },
            { value: "archived", label: "Archived", count: archivedCount },
          ]}
        />
      </div>

      {visible.length === 0 ? (
        <div className="rounded-card border border-dashed border-ink-300 bg-surface p-10 text-center text-sm text-ink-500">
          {showArchived ? "No archived clients." : search ? "No clients match your search." : "No clients in this view."}
        </div>
      ) : (
        <>
          {/* Table from 640px up. */}
          <section aria-label="Clients" className="hidden overflow-hidden rounded-card border border-ink-200 bg-surface sm:block">
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div aria-hidden className={`${GRID} border-b border-ink-100 bg-ink-50 px-[18px] py-2.5 text-xs text-ink-400`}>
                  <span>Client</span>
                  <span>Data sources</span>
                  <span>Status</span>
                  <span>Last report</span>
                  <span>Next delivery</span>
                  <span />
                </div>
                <ul>
                  {visible.map((c) => (
                    <li key={c.id} className={`${GRID} relative border-b border-ink-100 px-[18px] py-[13px] text-[13.5px] transition-colors last:border-b-0 hover:bg-ink-50`}>
                      <span className="flex min-w-0 items-center gap-[11px]">
                        <ClientMonogram name={c.name} logoUrl={c.logo_url} size={34} />
                        <span className="min-w-0">
                          {/* The name is the row's link; the overlay makes the whole row clickable. */}
                          <Link href={`/dashboard/clients/${c.id}`} className="block truncate font-medium text-ink-900 after:absolute after:inset-0 after:content-['']">
                            {c.name}
                          </Link>
                          <span className="block truncate text-xs text-ink-400">{c.website || c.email || "No website"}</span>
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1">{chips(c)}</span>
                      <span>{status(c)}</span>
                      <span className="text-ink-500"><span className="sr-only">Last report: </span>{c.lastReport ?? "—"}</span>
                      <span className="text-ink-500"><span className="sr-only">Next delivery: </span>{c.nextDelivery ?? "—"}</span>
                      <span className="relative z-10 flex justify-center">{menu(c)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          {/* Cards below 640px. */}
          <ul className="flex flex-col gap-2.5 sm:hidden">
            {visible.map((c) => (
              <li key={c.id} className="relative rounded-card border border-ink-200 bg-surface p-4">
                <div className="flex items-start gap-3">
                  <ClientMonogram name={c.name} logoUrl={c.logo_url} size={34} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/dashboard/clients/${c.id}`} className="block truncate font-medium text-ink-900 after:absolute after:inset-0 after:content-['']">
                      {c.name}
                    </Link>
                    <span className="block truncate text-xs text-ink-400">{c.website || c.email || "No website"}</span>
                  </div>
                  <span className="relative z-10">{menu(c)}</span>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {status(c)}
                  {chips(c)}
                </div>
                <p className="mt-2.5 text-xs text-ink-500">
                  Last report {c.lastReport ?? "—"} · Next {c.nextDelivery ?? "—"}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
