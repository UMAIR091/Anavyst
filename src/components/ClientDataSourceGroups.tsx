"use client";

// The two pieces of structure the Data sources tab needs beyond the cards
// themselves.
//
// `ConnectedSource` collapses a healthy source to one line. Nothing is removed:
// the full IntegrationCard — account picker, Save, Refresh now, Disconnect — is
// passed in as children and rendered the moment the row is opened. A source
// that is working needs no controls on screen by default, and a client with ten
// of them was otherwise ten screens of identical dropdowns to scroll past
// before reaching the one that needed attention. Sources that DO need attention
// are never collapsed; they render as plain cards above this group.
//
// `AvailableIntegrations` is the third section: what could be connected next,
// as a short grid rather than the full catalogue. Each tile is a real link into
// the same consent screen the cards and the modal use.
import * as React from "react";
import { ChevronDown, Plus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { integrationIcon, integrationTint } from "@/components/integrationVisuals";
import { HealthChip } from "@/components/ui/status-chip";

export function ConnectedSource({
  name,
  icon,
  accent,
  accountLabel,
  lastSyncedAt,
  rowId,
  children,
}: {
  /** Unique per row (the data source id): a client can have two accounts of
   *  one platform. */
  rowId?: string;
  name: string;
  icon: string;
  accent: string;
  /** The chosen account/property, when the provider exposes one. */
  accountLabel: string | null;
  lastSyncedAt: string | null;
  /** The full IntegrationCard for this source. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const Icon = integrationIcon(icon);
  const tint = integrationTint(accent);
  const id = `source-${(rowId ?? name).replace(/\W/g, "")}`;

  // A row in the "Connected" list card (rows are divided by the list, not boxed).
  return (
    <div className="border-t border-ink-100 first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 px-[18px] py-[13px] text-left transition-colors hover:bg-ink-50"
      >
        <span className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] ${tint}`}>
          <Icon size={17} aria-hidden />
        </span>
        <span className="min-w-[160px] flex-1">
          <span className="block truncate text-sm font-medium text-ink-900">{name}</span>
          <span className="block truncate text-[12.5px] text-ink-400">{accountLabel ?? "Connected"}</span>
        </span>
        <span className="whitespace-nowrap text-[12.5px] text-ink-500">
          {lastSyncedAt ? `Synced ${formatDistanceToNow(new Date(lastSyncedAt), { addSuffix: true })}` : "Not synced yet"}
        </span>
        <HealthChip health="healthy" />
        <span className="shrink-0 text-[13px] font-medium text-brand-600">{open ? "Hide" : "Manage"}</span>
        <ChevronDown
          size={15}
          aria-hidden
          className={`shrink-0 text-ink-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {/* The card carries its own border, so the wrapper's is dropped when it
          opens rather than drawing a box inside a box. */}
      {open && (
        <div id={id} className="border-t border-ink-100 bg-ink-50 p-2 [&>div]:border-0 [&>div]:shadow-none">
          {children}
        </div>
      )}
    </div>
  );
}

export type AvailableIntegration = {
  id: string;
  name: string;
  icon: string;
  accent: string;
};

export function AvailableIntegrations({
  clientId,
  integrations,
  totalAvailable,
  browseAction,
}: {
  clientId: string;
  /** The short list actually shown as tiles. */
  integrations: AvailableIntegration[];
  /** How many are connectable in total, for the "browse all" line. */
  totalAvailable: number;
  /** The existing "Add data source" trigger, which opens the full searchable list. */
  browseAction?: React.ReactNode;
}) {
  if (integrations.length === 0) return null;

  return (
    <div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
        {integrations.map((i) => {
          const Icon = integrationIcon(i.icon);
          const tint = integrationTint(i.accent);
          return (
            <a
              key={i.id}
              // Same consent screen the cards and the modal link to — this is a
              // shortcut into the existing flow, not a second one.
              href={`/dashboard/connect/${i.id}?clientId=${clientId}`}
              className="flex items-center gap-2.5 rounded-xl border border-ink-200 bg-surface p-3 transition-colors hover:border-ink-900"
            >
              <span className={`flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg ${tint}`}>
                <Icon size={15} aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink-900">{i.name}</span>
              <Plus size={16} aria-hidden className="shrink-0 text-brand-600" />
            </a>
          );
        })}
      </div>

      {totalAvailable > integrations.length && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {browseAction}
          <p className="text-xs text-ink-500">
            {totalAvailable - integrations.length} more available — search the full list.
          </p>
        </div>
      )}
    </div>
  );
}
