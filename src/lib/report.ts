// Data-processing layer for client reports. Pure functions — no React, no DB,
// no Google API. Merges the cached Search Console and GA4 snapshots into the
// unified payload the report UI renders, defines the empty-state rules, maps the
// data to the AI input, and derives the reporting window from the real data.
import type { GscReportFull, Ga4ReportFull } from "@/lib/google";
import type { ReportInsights, InsightsInput } from "@/lib/ai";
import type { ReportBlock } from "@/lib/integrations/blocks";
import { detectSignals } from "@/lib/insights/signals";
import { sourceNotes, type ReportSourceStatus } from "@/lib/reports/dataQuality";

// The unified payload stored in reports.data and rendered by ReportDocument.
// Either Google source may be null (only one connected). `insightsHash`
// fingerprints the metrics the insights were generated from for cache
// invalidation.
//
// `blocks` carries EVERY other connected integration — paid media, commerce,
// CRM, email, social, calls, video, local — already projected into the neutral
// display vocabulary (lib/integrations/blocks.ts). Reports, the PDF, email and
// exports read this one field, so a new integration reaches all of them without
// any of those layers learning about the provider.
export type ReportData = {
  gsc: GscReportFull | null;
  ga4: Ga4ReportFull | null;
  blocks: ReportBlock[];
  insights: ReportInsights | null;
  insightsHash?: string;
  /**
   * The reporting window as requested, plus how much of it the data actually
   * covers. Additive and optional — reports stored before this existed simply
   * have no `meta`, and every reader treats that as "unknown coverage".
   */
  meta?: ReportMeta;
};

export type ReportMeta = {
  /** The "last N days" the user selected. */
  periodDays: number;
  /** The canonical window those N days resolve to. */
  requested: { start: string; end: string };
  /** Extent of real data inside it, or null when the sources returned none. */
  coverage: { start: string; end: string } | null;
  /**
   * What kind of report this is — "seo" | "paid" | "analytics" |
   * "cross_channel" | "custom". Inferred from the contributing sources unless
   * the user picked one. Absent on reports generated before types existed.
   */
  reportType?: string;
  /** Integration ids that actually contributed data, e.g. ["gsc","meta_ads"]. */
  sourceIds?: string[];
  /** Which period preset produced this window, e.g. "previous_month". */
  periodPreset?: string;
  /** "rolling" | "calendar" | "custom". */
  periodKind?: string;
  /** Human label: "Last 28 days", "August 2026", "Q2 2026". */
  periodLabel?: string;
  /** True when the window was still running when the report was generated. */
  periodInProgress?: boolean;
  /**
   * Sections that could not be rebuilt for a derived window, with the reason.
   * Rendered as an explicit "not available for this period" note — never
   * silently omitted and never approximated.
   */
  unavailable?: { section: string; reason: string }[];
  /**
   * Every connected source and what it contributed: included, partial, or
   * left out as stale / without data / not yet synced, with the dates its
   * figures cover. Absent on reports generated before it existed.
   */
  sources?: ReportSourceStatus[];
};

/**
 * Everything a reader of this report needs to know about the data behind it,
 * as plain sentences: sources left out and why, sources covering only part of
 * the period, per-platform date windows, and figures a rebuilt period cannot
 * show. One list for the web report, the PDF and the AI prompt.
 */
export function dataQualityLines(meta: ReportMeta | null | undefined): string[] {
  if (!meta) return [];
  return [
    ...sourceNotes(meta.sources, meta.requested),
    ...(meta.unavailable ?? []).map((u) => `${u.section}: ${u.reason}`),
  ];
}

// Stable, dependency-free hash (FNV-1a) of exactly the metrics the AI analyzes.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function reportDataHash(data: { gsc: GscReportFull | null; ga4: Ga4ReportFull | null; blocks?: ReportBlock[] }): string {
  const basis = JSON.stringify({
    // Blocks participate in the fingerprint so a change in ad spend (or any
    // other non-Google channel) correctly invalidates the cached AI insights.
    // instanceId only when a report has two accounts of one platform, so
    // every other report keeps its fingerprint (and its cached insights).
    blocks: (data.blocks ?? []).map((b) => ({ id: b.sourceId, ...(b.instanceId ? { instance: b.instanceId } : {}), kpis: b.kpis, tables: b.tables })),
    gsc: data.gsc
      ? {
          totals: data.gsc.totals,
          previousTotals: data.gsc.previousTotals ?? null,
          topQueries: data.gsc.topQueries,
          topPages: data.gsc.topPages,
          topCountries: data.gsc.topCountries ?? [],
          topDevices: data.gsc.topDevices ?? [],
          movers: data.gsc.movers ?? null,
        }
      : null,
    ga4: data.ga4
      ? {
          totals: data.ga4.totals,
          previousTotals: data.ga4.previousTotals ?? null,
          trafficSources: data.ga4.trafficSources,
          topLandingPages: data.ga4.topLandingPages,
          devices: data.ga4.devices,
          countries: data.ga4.countries,
        }
      : null,
  });
  return fnv1a(basis);
}

export function isGscEmpty(g: GscReportFull | null | undefined): boolean {
  if (!g) return true;
  const noTotals = !g.totals || (g.totals.clicks === 0 && g.totals.impressions === 0);
  const noTrend = !Array.isArray(g.byDate) || g.byDate.length === 0;
  return noTotals && noTrend;
}

export function isGa4Empty(g: Ga4ReportFull | null | undefined): boolean {
  if (!g) return true;
  const noTotals = !g.totals || (g.totals.users === 0 && g.totals.sessions === 0);
  const noTrend = !Array.isArray(g.byDate) || g.byDate.length === 0;
  return noTotals && noTrend;
}

// A report is empty only when every connected channel is empty/absent — the
// Google pair AND every projected block. A client with only TikTok Ads
// connected produces a perfectly valid report.
export function isReportEmpty(data: { gsc: GscReportFull | null; ga4: Ga4ReportFull | null; blocks?: ReportBlock[] }): boolean {
  const noBlocks = !data.blocks?.some((b) => b.kpis.length > 0 || b.tables.length > 0);
  return isGscEmpty(data.gsc) && isGa4Empty(data.ga4) && noBlocks;
}

// Merges every cached source with the (optional) AI insights into the final
// payload. Single source of truth for the reports.data shape.
export function assembleReport(
  gsc: GscReportFull | null,
  ga4: Ga4ReportFull | null,
  insights: ReportInsights | null,
  blocks: ReportBlock[] = [],
  meta?: ReportMeta
): ReportData {
  return {
    gsc, ga4, blocks, insights,
    insightsHash: reportDataHash({ gsc, ga4, blocks }),
    ...(meta ? { meta } : {}),
  };
}

// Normalizes any stored reports.data — the unified {gsc,ga4} shape OR the legacy
// flat GSC-only shape — into the unified shape, so old reports keep rendering.
export function normalizeReportData(raw: unknown): ReportData {
  const data = (raw ?? {}) as Record<string, unknown>;
  // Reports stored before blocks existed have no `blocks` key — default to an
  // empty list so they keep rendering unchanged.
  const blocks = Array.isArray(data.blocks) ? (data.blocks as ReportBlock[]) : [];

  if ("gsc" in data || "ga4" in data) {
    return {
      gsc: (data.gsc as GscReportFull) ?? null,
      ga4: (data.ga4 as Ga4ReportFull) ?? null,
      blocks,
      insights: (data.insights as ReportInsights) ?? null,
      insightsHash: data.insightsHash as string | undefined,
      meta: (data.meta as ReportMeta | undefined) ?? undefined,
    };
  }
  // Legacy: Search Console fields stored at the top level.
  if (data.totals && (data.topQueries || data.byDate)) {
    const { insights, insightsHash, ...gsc } = data;
    return {
      gsc: gsc as unknown as GscReportFull,
      ga4: null,
      blocks: [],
      insights: (insights as ReportInsights) ?? null,
      insightsHash: insightsHash as string | undefined,
    };
  }
  return { gsc: null, ga4: null, blocks, insights: (data.insights as ReportInsights) ?? null };
}

// Maps the unified report data to the AI insights input.
export function toInsightsInput(data: ReportData, clientName: string, periodLabel: string): InsightsInput {
  return {
    clientName,
    periodLabel,
    gsc: data.gsc
      ? {
          totals: data.gsc.totals,
          previousTotals: data.gsc.previousTotals ?? null,
          topQueries: data.gsc.topQueries,
          topPages: data.gsc.topPages,
          topCountries: data.gsc.topCountries,
          topDevices: data.gsc.topDevices,
          movers: data.gsc.movers,
        }
      : null,
    ga4: data.ga4
      ? {
          totals: data.ga4.totals,
          previousTotals: data.ga4.previousTotals ?? null,
          unavailableMetrics: data.ga4.unavailableMetrics ?? [],
          trafficSources: data.ga4.trafficSources,
          topLandingPages: data.ga4.topLandingPages,
          devices: data.ga4.devices,
          countries: data.ga4.countries,
        }
      : null,
    blocks: data.blocks?.length ? data.blocks : null,
    // What the model must know about the data's limits — sources left out,
    // partial coverage, per-platform windows, figures a rebuilt period lacks —
    // so it hedges or stays silent rather than reading a gap as a zero.
    dataQuality: dataQualityLines(data.meta),
    // The same anomalies the report renders, handed to the model so its prose
    // agrees with the figures printed beside it — and so it has no reason to
    // invent an anomaly of its own.
    signals: detectSignals(data.gsc, data.ga4).map((s) => ({
      title: s.title,
      detail: s.detail,
      metric: s.metric,
      confidence: s.confidence,
    })),
  };
}

// Derives the report's covered period from whichever source has daily data, so
// the printed dates match the cached numbers. Falls back to the default window.
// ── The canonical reporting window ──────────────────────────────────────────
//
// One definition, used by generation, storage, the PDF and every UI surface.
//
// Previously the stored period came from `reportPeriod` — the min/max dates
// that happened to appear in the data. A client whose Search Console had only
// two days of history produced a report labelled "27 Jul – 28 Jul" after the
// user asked for "Last 28 days". The window the user chose is the report's
// period; how much data landed inside it is a separate fact (see `coverage`).
//
// The 2-day lag matches the providers: Search Console finalises ~2 days back
// and most ad platforms settle within the same window, so a period ending
// today would always look artificially empty at the end.
export const REPORT_LAG_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDayUTC = (offsetDays: number, from: number) =>
  new Date(from - offsetDays * DAY_MS).toISOString().slice(0, 10);

/** The window a "last N days" selection actually means — N inclusive days. */
export function canonicalPeriod(periodDays: number, now: number = Date.now()): { start: string; end: string } {
  return {
    start: isoDayUTC(periodDays + REPORT_LAG_DAYS - 1, now),
    end: isoDayUTC(REPORT_LAG_DAYS, now),
  };
}

/** Inclusive whole days between two YYYY-MM-DD dates. */
export function periodDayCount(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (!isFinite(a) || !isFinite(b) || b < a) return 0;
  return Math.round((b - a) / DAY_MS) + 1;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Compact label for report titles and lists: "Aug 2026" when the window sits in
 * one month, "Jul–Aug 2026" within a year, "Dec 2025–Jan 2026" across one.
 * Parsed from the date parts so no timezone can shift the month.
 */
export function periodLabel(start: string | null | undefined, end: string | null | undefined): string | null {
  const p = (s: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").slice(0, 10));
    if (!m) return null;
    const mi = Number(m[2]) - 1;
    return mi >= 0 && mi <= 11 ? { y: Number(m[1]), m: mi } : null;
  };
  const a = p(start);
  const b = p(end);
  if (!a || !b) return null;
  if (a.y === b.y && a.m === b.m) return `${MONTHS_SHORT[a.m]} ${a.y}`;
  if (a.y === b.y) return `${MONTHS_SHORT[a.m]}–${MONTHS_SHORT[b.m]} ${a.y}`;
  return `${MONTHS_SHORT[a.m]} ${a.y}–${MONTHS_SHORT[b.m]} ${b.y}`;
}

/**
 * The exact window phrase handed to the model, so its prose can never describe a
 * period the report doesn't cover.
 *
 * Generation and regeneration MUST agree on this, and they didn't. Generation
 * passed the real resolved window; the regenerate-insights route rebuilt "the
 * last N days" from `byDate` row counts, which named the wrong window on any
 * calendar or custom period (a Q2 report was described as "the last 61 days")
 * and no window at all on a report with no Google source. Both paths now call
 * this, so they cannot drift apart again.
 *
 * The output is byte-identical to what generation built before, which matters:
 * the AI insight cache is keyed on a hash of the model input, so changing the
 * phrasing would invalidate every cached insight.
 */
export function insightsPeriodPhrase(input: {
  label?: string | null;
  start: string;
  end: string;
  days?: number | null;
}): string {
  const days = input.days && input.days > 0 ? input.days : periodDayCount(input.start, input.end);
  const label = input.label?.trim() || periodLabel(input.start, input.end) || "This period";
  return `${label} — ${input.start} to ${input.end}${days ? ` (${days} days)` : ""}`;
}

/**
 * The extent of the data that actually landed, or null when there is none.
 * Reported alongside the canonical window so a partially-covered report can say
 * so honestly instead of quietly shrinking its own period.
 */
export function dataCoverage(
  data: { gsc: GscReportFull | null; ga4: Ga4ReportFull | null; blocks?: ReportBlock[] }
): { start: string; end: string } | null {
  const blockDates = (data.blocks ?? []).flatMap((b) => b.series.flatMap((s) => s.points.map((p) => p.date)));
  const dates = [...(data.gsc?.byDate ?? []), ...(data.ga4?.byDate ?? [])]
    .map((d) => d.date)
    .concat(blockDates)
    .filter(Boolean)
    .sort();
  return dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
}

// Kept for callers that still want the data-derived window (and for the
// coverage calculation above). New reports store `canonicalPeriod`.
export function reportPeriod(
  data: { gsc: GscReportFull | null; ga4: Ga4ReportFull | null; blocks?: ReportBlock[] },
  fallback: { start: string; end: string }
): { start: string; end: string } {
  // Block series count too, so a client with only non-Google sources still gets
  // a period derived from real data rather than the fallback window.
  const blockDates = (data.blocks ?? []).flatMap((b) => b.series.flatMap((s) => s.points.map((p) => p.date)));
  const dates = [...(data.gsc?.byDate ?? []), ...(data.ga4?.byDate ?? [])]
    .map((d) => d.date)
    .concat(blockDates)
    .filter(Boolean)
    .sort();
  if (dates.length === 0) return fallback;
  return { start: dates[0], end: dates[dates.length - 1] };
}
