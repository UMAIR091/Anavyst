"use client";

// Performance section for a client: metric-group tabs, per-source filtering, and
// group-scoped aggregation.
//
// The rule this is built around: metrics are only ever combined INSIDE a group,
// and only where the arithmetic is genuinely valid. Search Console clicks, GA4
// sessions and ad spend count different things, so they are never summed and
// never share a chart. Each group renders its own section; "All" stacks those
// sections rather than merging them.
//
// Paid ads is the one group with a real cross-source total — spend, impressions,
// clicks, conversions and revenue are the same unit on every ad platform. That
// aggregation lives in lib/integrations/blocks.ts (shared with the PDF and AI),
// so this component adds no second data path.
//
// CONTROLS live in one sticky toolbar at the top: period, then metric group,
// then individual source — outermost filter first. They stay reachable while a
// long stack of charts scrolls beneath, which is the whole reason a client with
// ten connected sources stopped being usable: changing the filter used to mean
// scrolling all the way back up first. Period is a link (the server re-reads a
// different cached snapshot); group and source are local state.
import Link from "next/link";
import { useMemo, useState } from "react";
import { ClientAnalytics } from "@/components/ClientAnalytics";
import { aggregatePaidSnapshots, formatBlockValue } from "@/lib/integrations/blocks";
import { GROUP_LABELS, type MetricGroup } from "@/lib/integrations/analyticsViews";
import { buildOverview } from "@/lib/integrations/overview";

export type PerformanceSource = {
  /** Integration id, e.g. "meta_ads" — selects the right chart view. */
  id: string;
  /** Unique per source (the data source id): a client can have two accounts
   *  of one platform. Defaults to `id`. */
  key?: string;
  /** Display name, e.g. "Meta Ads". */
  name: string;
  /** The selected account within that source, when the provider exposes one. */
  accountLabel: string | null;
  /** Metric family this source belongs to; only same-group sources combine. */
  group: MetricGroup;
  snapshot: unknown;
};

/** One selectable cached window, resolved server-side into a link. */
const keyOf = (s: PerformanceSource) => s.key ?? s.id;

export type PerformancePeriodOption = {
  days: number;
  /** Full label, e.g. "Last 28 days" — used for the accessible name. */
  label: string;
  href: string;
  active: boolean;
};

const ALL = "__all__";

// Groups render in a consistent, meaningful order rather than connection order.
const GROUP_ORDER: MetricGroup[] = ["paid", "seo", "analytics", "social", "commerce", "crm", "email", "calls", "other"];

export function ClientPerformance({
  sources,
  periods = [],
  periodLabel,
}: {
  sources: PerformanceSource[];
  /** Cached windows the user can switch between. Fewer than two hides the control. */
  periods?: PerformancePeriodOption[];
  /** The active window's label, for provenance lines inside the section. */
  periodLabel?: string;
}) {
  const [group, setGroup] = useState<MetricGroup | typeof ALL>(ALL);
  const [source, setSource] = useState<string>(ALL);

  // Which groups actually have data, in display order.
  const groups = useMemo(
    () => GROUP_ORDER.filter((g) => sources.some((s) => s.group === g)),
    [sources]
  );

  // Sources inside the selected group (or all of them).
  const inGroup = useMemo(
    () => (group === ALL ? sources : sources.filter((s) => s.group === group)),
    [sources, group]
  );

  // Cross-platform paid total, scoped to whatever is currently visible so it
  // always matches the blocks beneath it.
  const visibleSources = source === ALL ? inGroup : inGroup.filter((s) => keyOf(s) === source);
  const paidAggregate = useMemo(
    () => aggregatePaidSnapshots(visibleSources.filter((s) => s.group === "paid").map((s) => ({ type: s.id, snapshot: s.snapshot }))),
    [visibleSources]
  );

  // Headline figure per channel family, for the "All" view only.
  const overview = useMemo(() => buildOverview(sources), [sources]);

  if (sources.length === 0) return null;

  const selectGroup = (g: MetricGroup | typeof ALL) => {
    setGroup(g);
    setSource(ALL); // a group change resets the source filter to that group's "all"
  };

  // Groups to render as sections. A specific source selection collapses to its
  // own group only.
  const renderGroups = group === ALL ? groups : [group];
  const windowLabel = periodLabel ? periodLabel.toLowerCase() : null;

  return (
    <div>
      {/* ── Toolbar ────────────────────────────────────────────────────────
          Sticky under the mobile app bar (h-14) and under nothing on desktop.
          z-20 keeps it below the app bar's z-30. */}
      <div className="sticky top-14 z-20 mb-6 border-b border-ink-100 bg-surface/95 py-3 backdrop-blur lg:top-0">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {/* Level 1 — metric group. Only meaningful with more than one. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-1 py-0.5">
            {groups.length > 1 ? (
              <>
                <Pill active={group === ALL} onClick={() => selectGroup(ALL)}>All</Pill>
                {groups.map((g) => (
                  <Pill key={g} active={group === g} onClick={() => selectGroup(g)}>
                    {GROUP_LABELS[g]}
                    <span className="ml-1.5 opacity-60">{sources.filter((s) => s.group === g).length}</span>
                  </Pill>
                ))}
              </>
            ) : (
              <p className="truncate text-sm font-medium text-ink-700">
                {groups.length === 1 ? GROUP_LABELS[groups[0]] : "Performance"}
              </p>
            )}
          </div>

          {/* Period — a real switch between the two cached windows every sync
              stores. Nothing is recalculated; a different snapshot is read. */}
          {periods.length > 1 && (
            <div
              role="group"
              aria-label="Reporting period"
              className="flex shrink-0 items-center gap-0.5 rounded-full border border-ink-200 bg-surface-subtle p-0.5"
            >
              {periods.map((p) => (
                <Link
                  key={p.days}
                  href={p.href}
                  scroll={false}
                  aria-label={p.label}
                  aria-current={p.active ? "true" : undefined}
                  className={`rounded-full px-3 py-1 text-xs font-medium tabular-nums transition-colors ${
                    p.active ? "bg-surface text-ink-900 shadow-xs" : "text-ink-500 hover:text-ink-800"
                  }`}
                >
                  {/* Abbreviated on phones so the group pills keep their room;
                      aria-label carries the full wording either way. */}
                  <span className="sm:hidden">{p.days}d</span>
                  <span className="hidden sm:inline">{p.days} days</span>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Level 2 — individual source within the current group. One scrolling
            row rather than a wrapping block, so the toolbar keeps its height
            however many sources a client has. */}
        {inGroup.length > 1 && (
          <div className="mt-2 flex items-center gap-2 overflow-x-auto px-1 py-0.5">
            <span className="shrink-0 text-xs text-ink-400">Source</span>
            <Pill small active={source === ALL} onClick={() => setSource(ALL)}>
              {group === ALL ? "All" : `All ${GROUP_LABELS[group].toLowerCase()}`}
            </Pill>
            {inGroup.map((s) => (
              <Pill key={keyOf(s)} small active={source === keyOf(s)} onClick={() => setSource(keyOf(s))}>
                {s.name}
                {s.accountLabel ? <span className="ml-1.5 opacity-60">{s.accountLabel}</span> : null}
              </Pill>
            ))}
          </div>
        )}
      </div>

      {/* Cross-channel overview — only on "All", and only when more than one
          channel family is connected. Each figure keeps its own provenance;
          nothing is summed across families, because no valid total exists. */}
      {group === ALL && source === ALL && groups.length > 1 && overview.length > 0 && (
        <div className="mb-8 rounded-xl border border-ink-200 bg-surface p-5">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink-900">Headline figures</h3>
            <p className="text-xs text-ink-500">One top line per channel{windowLabel ? ` · ${windowLabel}` : ""}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {overview.map((m) => (
              <div key={`${m.group}-${m.label}`}>
                <p className="text-xs text-ink-500">{m.label}</p>
                <p className="mt-0.5 text-lg font-semibold tracking-tight text-ink-900">{m.value ?? "—"}</p>
                <p className="mt-0.5 truncate text-[11px] text-ink-400" title={m.source}>{m.source}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
            Each figure comes from the channel named beneath it. Different channels measure different things, so they
            sit side by side rather than being added together.
          </p>
        </div>
      )}

      <div className="space-y-8">
        {renderGroups.map((g) => {
          const groupSources = visibleSources.filter((s) => s.group === g);
          if (groupSources.length === 0) return null;

          return (
            <section key={g}>
              {/* Group heading only earns its place when more than one group shows. */}
              {renderGroups.length > 1 && (
                <h3 className="mb-4 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-ink-500">
                  {GROUP_LABELS[g]}
                  <span className="h-px flex-1 bg-ink-100" aria-hidden />
                </h3>
              )}

              {/* Real cross-platform total — paid media only. */}
              {g === "paid" && paidAggregate && (
                <div className="mb-6 rounded-xl border border-ink-200 bg-surface p-5">
                  <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                    <h4 className="text-sm font-semibold text-ink-900">Combined paid media</h4>
                    <p className="text-xs text-ink-500">{paidAggregate.sourceNames.join(" · ")}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                    {paidAggregate.currency && (
                      <Metric label="Spend" value={formatBlockValue(paidAggregate.spend, "currency", paidAggregate.currency)} />
                    )}
                    <Metric label="Impressions" value={formatBlockValue(paidAggregate.impressions, "number")} />
                    <Metric label="Clicks" value={formatBlockValue(paidAggregate.clicks, "number")} />
                    <Metric label="CTR" value={formatBlockValue(paidAggregate.ctr, "percent")} />
                    {paidAggregate.currency && (
                      <Metric label="CPC" value={formatBlockValue(paidAggregate.cpc, "currency", paidAggregate.currency)} />
                    )}
                    <Metric label="Conversions" value={formatBlockValue(paidAggregate.conversions, "number")} />
                    {paidAggregate.currency && paidAggregate.revenue > 0 && (
                      <Metric label="Revenue" value={formatBlockValue(paidAggregate.revenue, "currency", paidAggregate.currency)} />
                    )}
                    {paidAggregate.revenue > 0 && (
                      <Metric label="ROAS" value={paidAggregate.roas === null ? "—" : `${paidAggregate.roas.toFixed(2)}×`} />
                    )}
                  </div>

                  {!paidAggregate.currency && (
                    <p className="mt-4 text-xs text-ink-500">
                      These ad accounts report in different currencies (or one didn&apos;t report a currency), so spend
                      and cost metrics aren&apos;t combined. Select a single platform above to see its spend.
                    </p>
                  )}
                </div>
              )}

              {/* SEO tools measure the same domain by different methods, so their
                  figures are shown side by side and never added together. */}
              {g === "seo" && groupSources.length > 1 && (
                <p className="mb-4 text-xs text-ink-500">
                  Search Console reports measured search data; SEO tools report their own estimates. They describe the
                  same site in different ways, so each is shown separately rather than combined.
                </p>
              )}

              <div className="space-y-8">
                {groupSources.map((s) => (
                  <div key={keyOf(s)}>
                    <h4 className="mb-3 text-sm font-medium text-ink-700">
                      {s.name}
                      {s.accountLabel ? <span className="ml-2 font-normal text-ink-500">{s.accountLabel}</span> : null}
                    </h4>
                    <ClientAnalytics id={s.id} snapshot={s.snapshot} />
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Pill({
  active, onClick, small, children,
}: {
  active: boolean; onClick: () => void; small?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 whitespace-nowrap rounded-full border transition-colors ${small ? "px-3 py-1 text-xs" : "px-3.5 py-1.5 text-sm"} ${
        active
          ? "border-primary bg-primary text-primary-fg"
          : "border-ink-200 bg-surface text-ink-600 hover:border-ink-300 hover:text-ink-900"
      }`}
    >
      {children}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-ink-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tracking-tight text-ink-900">{value}</p>
    </div>
  );
}
