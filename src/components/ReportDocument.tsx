"use client";

import { normalizeReportData, periodDayCount } from "@/lib/report";
import { ga4Has, sourceNotes } from "@/lib/reports/dataQuality";
import { blockKey, formatBlockValue, type BlockKpi } from "@/lib/integrations/blocks";
import { detectSignals } from "@/lib/insights/signals";
import { allSoWhat, allActions, NO_EVIDENCE_NOTE } from "@/lib/reports/soWhat";
import { buildExecutiveSummary, blockHasComparison, hasCalculableKpis, periodSubtitle } from "@/lib/reports/summary";
import { buildVerdict } from "@/lib/reports/verdict";
import { VerdictPanel } from "@/components/VerdictPanel";
import { agencyNote, cleanBullets, cleanCommentary } from "@/lib/reports/commentary";
import { badgeRepeatsTitle, coverBadgeLabel } from "@/lib/reports/types";
import { MAX_CHANNEL_KPIS, MIN_BREAKDOWN_ROWS, MIN_TREND_POINTS, shortPeriodNote } from "@/lib/reports/composition";
import type { GscReportFull, Ga4ReportFull } from "@/lib/google";
import { pctChange } from "@/lib/metrics/change";
import {
  CHART, Callout, EdgeKeywords, IdeaTile, KpiCard, MeaningCard, MiniStat, MoversPanels, Note, NotePanel,
  PositionChip, ReportBody, ReportCover, ReportFooter, ReportPaper, Section, ShareBreakdown, ShareRows, StepList,
  StepRow, SubHead, T, ThinBar, TileGrid, ToneTile, TrendCard, brandTones, sharePalette,
  type Brand, type Delta, type GlanceCell, type Tone,
} from "@/components/report/ui";

type Branding = { name: string; logo_url: string | null; brand_color: string; website: string | null; footer_text: string | null };

// Accepts both the current grouped insights and the legacy
// {summary, highlights, recommendations, actionPlan} shape.
type RawInsights = {
  executiveSummary?: string; keyWins?: string[]; issuesDetected?: string[];
  growthOpportunities?: string[]; recommendedActions?: string[];
  summary?: string; highlights?: string[]; recommendations?: string[]; actionPlan?: string[];
} | null | undefined;

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;

function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function delta(cur: number, prev: number | null | undefined, lowerIsBetter = false) {
  const pct = pctChange(cur, prev);
  if (pct === null) return null;
  return { pct, good: lowerIsBetter ? pct < 0 : pct > 0 };
}

// The KPI delta as the cards print it: "▲ 18%", coloured by whether the move
// is good for this metric (a lower position or cost is good).
function deltaLabel(d: { pct: number; good: boolean } | null): Delta {
  return d ? { text: `${d.pct >= 0 ? "▲" : "▼"} ${Math.abs(d.pct).toFixed(0)}%`, good: d.good } : null;
}

// A connected channel's KPI delta. An individual "—" beside real figures says
// that metric has no denominator, so no delta is drawn for it.
function blockDelta(k: BlockKpi): Delta {
  const d = k.value === null || k.previous === null || k.previous === 0 ? null : (k.value - k.previous) / Math.abs(k.previous);
  if (d === null) return null;
  const good = k.lowerBetter ? d < 0 : d > 0;
  return { text: `${d > 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(1)}%`, good };
}

// The cover of a client-facing deliverable shouldn't read "2026-07-15 →
// 2026-08-11". Parsed from the parts rather than `new Date(iso)` so a browser
// west of UTC doesn't render the previous day. Anything that isn't a plain
// YYYY-MM-DD is passed through untouched.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseIsoDay(s: string | null | undefined): { d: number; m: number; y: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s ?? "").slice(0, 10));
  if (!m) return null;
  const month = Number(m[2]) - 1;
  if (month < 0 || month > 11) return null;
  return { y: Number(m[1]), m: month, d: Number(m[3]) };
}

function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  const a = parseIsoDay(start);
  const b = parseIsoDay(end);
  if (!a || !b) return [start, end].filter(Boolean).join(" → ");
  const left = a.y === b.y ? `${a.d} ${MONTHS[a.m]}` : `${a.d} ${MONTHS[a.m]} ${a.y}`;
  return `${left} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
}

function pagePathOf(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname || "/") + (u.search || "");
  } catch {
    return url;
  }
}

// AI text is cleaned before it is trusted. Models add list numbering to strings
// that are already list items, and the renderer used to pass every element
// through — a bullet reading "1" rendered next to the list's own ordinal.
function normInsights(ins: RawInsights) {
  if (!ins) return null;
  const executiveSummary = (ins.executiveSummary ?? ins.summary ?? "").trim();
  const keyWins = cleanBullets(ins.keyWins ?? ins.highlights);
  const issuesDetected = cleanBullets(ins.issuesDetected);
  const growthOpportunities = cleanBullets(ins.growthOpportunities);
  const recommendedActions = ins.recommendedActions ?? ins.recommendations ?? [];
  const empty = !executiveSummary && !keyWins.length && !issuesDetected.length && !growthOpportunities.length && !recommendedActions.length;
  return empty ? null : { executiveSummary, keyWins, issuesDetected, growthOpportunities, recommendedActions };
}

// Merge GSC pages (clicks/impressions) and GA4 landing pages (sessions/users)
// keyed by path, so SEO traffic and on-site engagement sit side by side.
type LandingRow = { path: string; clicks?: number; impressions?: number; sessions?: number; users?: number };
function mergeLandingPages(gsc: GscReportFull | null, ga4: Ga4ReportFull | null): LandingRow[] {
  const map = new Map<string, LandingRow>();
  for (const p of gsc?.topPages ?? []) {
    const path = pagePathOf(p.key);
    const cur = map.get(path) ?? { path };
    cur.clicks = (cur.clicks ?? 0) + p.clicks;
    cur.impressions = (cur.impressions ?? 0) + p.impressions;
    map.set(path, cur);
  }
  for (const p of ga4?.topLandingPages ?? []) {
    const path = p.key || "/";
    const cur = map.get(path) ?? { path };
    cur.sessions = (cur.sessions ?? 0) + p.sessions;
    cur.users = (cur.users ?? 0) + p.users;
    map.set(path, cur);
  }
  return Array.from(map.values())
    .sort((a, b) => (b.sessions ?? b.clicks ?? 0) - (a.sessions ?? a.clicks ?? 0))
    .slice(0, 8);
}

export function ReportDocument({
  branding,
  clientName,
  clientLogoUrl,
  title,
  period,
  data,
}: {
  branding: Branding;
  clientName: string;
  /** The client's own logo, scoped to this report by the branding loader. */
  clientLogoUrl?: string | null;
  title: string;
  period: { start: string; end: string };
  data: unknown;
}) {
  const color = branding.brand_color || "#4f46e5";
  const brand = brandTones(color);
  const { gsc, ga4, blocks, insights, meta } = normalizeReportData(data);
  // Every connected integration other than Search Console / GA4, already
  // projected into the neutral block vocabulary. Rendered generically below, so
  // a new integration appears here without touching this component.
  const channelBlocks = (blocks ?? []).filter((b) => b.kpis.length > 0 || b.tables.length > 0);
  const ins = normInsights(insights as RawInsights);

  const winners = gsc?.movers?.winners ?? [];
  const decliners = gsc?.movers?.decliners ?? [];
  const opportunities = gsc?.movers?.opportunities ?? [];

  // A line needs enough points to be a line. The PDF has enforced this since
  // Phase 2B; the on-screen report did not, so three days of data drew a
  // "trend" chart here that the same data was refused in the document the
  // client receives. Same constant, so the two can't drift apart again.
  const gscTrend = (gsc?.byDate?.length ?? 0) >= MIN_TREND_POINTS;
  const ga4Trend = (ga4?.byDate?.length ?? 0) >= MIN_TREND_POINTS;
  const hasTrendCharts = gscTrend || ga4Trend;

  // Sparklines follow the same rule as the charts: only from a daily series
  // long enough to be a trend. Position is negated so "up" reads as better.
  const gscSpark = (pick: (d: GscReportFull["byDate"][number]) => number) => (gscTrend ? gsc!.byDate.map(pick) : null);
  const ga4Spark = (pick: (d: Ga4ReportFull["byDate"][number]) => number) => (ga4Trend ? ga4!.byDate.map(pick) : null);

  // GSC KPI cards.
  const gscClicksD = gsc ? delta(gsc.totals.clicks, gsc.previousTotals?.clicks) : null;
  const gscPosD = gsc ? delta(gsc.totals.position, gsc.previousTotals?.position, true) : null;
  const gscKpis = gsc ? [
    { l: "Clicks", v: fmt(gsc.totals.clicks), d: gscClicksD, s: gscSpark((d) => d.clicks) },
    { l: "Impressions", v: fmt(gsc.totals.impressions), d: delta(gsc.totals.impressions, gsc.previousTotals?.impressions), s: gscSpark((d) => d.impressions) },
    { l: "Avg CTR", v: pct1(gsc.totals.ctr), d: delta(gsc.totals.ctr, gsc.previousTotals?.ctr), s: gscSpark((d) => d.ctr) },
    { l: "Avg Position", v: gsc.totals.position.toFixed(1), d: gscPosD, s: gscSpark((d) => -d.position) },
  ] : [];

  // GA4 KPI cards. Engagement and conversions have no daily series, so they
  // carry no sparkline.
  const ga4SessionsD = ga4 ? delta(ga4.totals.sessions, ga4.previousTotals?.sessions) : null;
  // A total a rebuilt period could not measure (ga4Has) reads "—" with no
  // delta and no sparkline: its 0 is a placeholder, and "0 conversions" would
  // tell the client nothing converted.
  const hasUsers = ga4Has(ga4, "users");
  const hasEngagement = ga4Has(ga4, "engagementRate");
  const hasConversions = ga4Has(ga4, "conversions");
  const ga4ConversionsD = ga4 && hasConversions ? delta(ga4.totals.conversions, ga4.previousTotals?.conversions) : null;
  const ga4Kpis = ga4 ? [
    { l: "Users", v: hasUsers ? fmt(ga4.totals.users) : "—", d: hasUsers ? delta(ga4.totals.users, ga4.previousTotals?.users) : null, s: hasUsers ? ga4Spark((d) => d.users) : null },
    { l: "Sessions", v: fmt(ga4.totals.sessions), d: ga4SessionsD, s: ga4Spark((d) => d.sessions) },
    { l: "Engagement", v: hasEngagement ? pct1(ga4.totals.engagementRate) : "—", d: hasEngagement ? delta(ga4.totals.engagementRate, ga4.previousTotals?.engagementRate) : null, s: null },
    { l: "Conversions", v: hasConversions ? fmt(ga4.totals.conversions) : "—", d: ga4ConversionsD, s: null },
  ] : [];

  // Average position moves in spots, which is how a client reads it; only
  // stated when there is a previous position to measure from.
  const posSpots = gsc && gsc.previousTotals && gsc.previousTotals.position > 0 ? gsc.previousTotals.position - gsc.totals.position : null;
  const posDelta: Delta = posSpots != null && Math.abs(posSpots) >= 0.05
    ? { text: `${posSpots > 0 ? "▲" : "▼"} ${Math.abs(posSpots).toFixed(1)} spots`, good: posSpots > 0 }
    : null;

  // The traffic section is worth a heading when it has a chart, the GA4
  // mini-stats, or a channel breakdown — not merely because a byDate array
  // exists.
  // A breakdown needs MIN_BREAKDOWN_ROWS rows to be a breakdown: one row is a
  // single number the totals already carry, under a heading promising a
  // ranking. A short window drew "Sessions by device: Mobile 100%" — 100% by
  // construction, because mobile was the only row returned.
  const hasChannels = (ga4?.trafficSources?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const hasDevices = (ga4?.devices?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const hasCountries = (ga4?.countries?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const showTrafficSection = hasTrendCharts || hasChannels || !!ga4;

  const landing = mergeLandingPages(gsc, ga4);
  const landingMax = Math.max(1, ...landing.map((r) => r.sessions ?? r.clicks ?? 0));
  const organic = ga4?.trafficSources?.find((s) => /organic search/i.test(s.key)) ?? null;
  const organicShare = ga4 && ga4.totals.sessions > 0 && organic ? organic.sessions / ga4.totals.sessions : null;
  const convRate = ga4 && hasConversions && ga4.totals.sessions > 0 ? ga4.totals.conversions / ga4.totals.sessions : null;
  // Shares are of all sessions, so the breakdowns add up to the total the
  // KPI cards show rather than to the rows that happen to be listed.
  const sessionsTotal = ga4 ? (ga4.totals.sessions || (ga4.trafficSources ?? []).reduce((s, r) => s + r.sessions, 0)) : 0;

  // ── Executive-summary callouts, each requiring a measured fact ──────────
  // Built as a list rather than three fixed slots so a slot with nothing real
  // behind it simply doesn't appear. Nothing here is generated language: every
  // string interpolates a number that came from the client's own data.
  type CalloutSpec = { tone: Tone; title: string; text: string };
  const callouts: CalloutSpec[] = [];

  if (winners[0]) {
    callouts.push({ tone: "good", title: "Key win", text: `“${winners[0].key}” up ${Math.round(winners[0].changePct)}%.` });
  } else if (gscClicksD?.good) {
    callouts.push({ tone: "good", title: "Key win", text: `Search clicks up ${Math.abs(gscClicksD.pct).toFixed(0)}%.` });
  } else if (ga4 && ga4.totals.sessions > 0) {
    callouts.push({ tone: "good", title: "Key win", text: hasEngagement ? `${fmt(ga4.totals.sessions)} sessions, ${pct1(ga4.totals.engagementRate)} engaged.` : `${fmt(ga4.totals.sessions)} sessions.` });
  }

  if (decliners[0]) {
    callouts.push({ tone: "bad", title: "Watch", text: `“${decliners[0].key}” down ${Math.abs(Math.round(decliners[0].changePct))}%.` });
  } else if (ga4 && convRate != null && ga4.totals.sessions > 0) {
    callouts.push({ tone: "bad", title: "Watch", text: `Conversion rate ${pct1(convRate)} of sessions.` });
  }

  if (gscPosD && gsc) {
    callouts.push({ tone: "watch", title: "Trend", text: `Average position ${gscPosD.good ? "improved" : "slipped"} to ${gsc.totals.position.toFixed(1)}.` });
  } else if (organicShare != null) {
    callouts.push({ tone: "watch", title: "Trend", text: `Organic search is ${pct1(organicShare)} of sessions.` });
  } else if (opportunities.length > 0) {
    // Only when there ARE opportunities — "0 keywords near page one" was
    // presented to clients as a trend.
    callouts.push({ tone: "watch", title: "Trend", text: `${opportunities.length} keyword${opportunities.length === 1 ? "" : "s"} near page one.` });
  }

  const unavailable = meta?.unavailable ?? [];

  const coverBadgeRaw = coverBadgeLabel(meta?.reportType, [
    ...(gsc ? ["Search Console"] : []),
    ...(ga4 ? ["Analytics"] : []),
    ...channelBlocks.map((b) => b.sourceName),
  ]);
  // Dropped when the title already says it: the header carried the same phrase
  // twice, once as a pill and once in the title below it.
  const coverBadge = badgeRepeatsTitle(coverBadgeRaw, title) ? "" : coverBadgeRaw;

  // ── At a glance: up to four headline figures, each one measured ─────────
  // Only figures this report actually has. A cell with nothing behind it is
  // left out rather than shown as a dash, and a single cell is not a strip.
  const glance: GlanceCell[] = [];
  const addCell = (c: GlanceCell) => {
    if (glance.length < 4 && !glance.some((g) => g.label === c.label)) glance.push(c);
  };
  if (ga4 && hasConversions && ga4.totals.conversions > 0) addCell({ label: "Conversions", value: fmt(ga4.totals.conversions), delta: deltaLabel(ga4ConversionsD) });
  if (gsc) addCell({ label: "Search clicks", value: fmt(gsc.totals.clicks), delta: deltaLabel(gscClicksD) });
  if (ga4) addCell({ label: "Sessions", value: fmt(ga4.totals.sessions), delta: deltaLabel(ga4SessionsD) });
  if (gsc) addCell({ label: "Avg Position", value: gsc.totals.position.toFixed(1), delta: posDelta });
  for (const b of channelBlocks) {
    for (const k of b.kpis.slice(0, MAX_CHANNEL_KPIS)) {
      if (k.value !== null) addCell({ label: k.label, value: formatBlockValue(k.value, k.format, b.currency), delta: blockDelta(k) });
    }
  }
  const glanceCells = glance.length >= 2 ? glance : [];

  // "vs previous period" only when something in the report was actually
  // compared with one.
  const compared = !!(gsc?.previousTotals || ga4?.previousTotals || channelBlocks.some((b) => blockHasComparison(b)));

  // Same interpretation layer the PDF uses, so the on-screen report and the
  // document the client receives never disagree.
  const signals = detectSignals(gsc, ga4, 6);
  const soWhat = allSoWhat(signals, blocks ?? [], 3);
  const evidenceActions = allActions(signals, blocks ?? [], 5);

  // The written summary. The AI paragraph is preferred where one exists;
  // otherwise it is built from the measured figures. It used to be neither: with
  // no AI text the section said "a written summary needs a full period of data
  // to compare against" and stopped, on reports that had spend, clicks and
  // conversions in them. A comparison enriches the summary; its absence does not
  // make one impossible.
  const summary = buildExecutiveSummary({
    clientName, period, gsc, ga4, blocks: channelBlocks,
    watch: evidenceActions[0] ? { action: evidenceActions[0].action, because: evidenceActions[0].because } : null,
  });
  const summaryText = ins?.executiveSummary || summary.text;

  // The verdict panel. Deliberately built from the same measured figures as the
  // summary rather than from the AI text: this is the one part of the report a
  // client is guaranteed to read, so it states only what the snapshot proves.
  // Null when nothing measurable came back, in which case the panel is omitted
  // rather than rendering a cheerful headline over an empty report.
  const verdict = buildVerdict({
    period, gsc, ga4, blocks: channelBlocks,
    watch: evidenceActions[0] ? { action: evidenceActions[0].action, because: evidenceActions[0].because } : null,
  });

  // Commentary the AI wrote that the evidence-backed steps don't already cover.
  // Empty after cleaning means the section does not render.
  const commentary = cleanCommentary(ins?.recommendedActions, evidenceActions.map((a) => a.action));

  // The agency's own closing note — null when they haven't written one.
  const note = agencyNote(branding.footer_text);

  // Whether the report has any connected source at all. A report with data but
  // no action worth taking says so outright; a report with nothing in it has
  // already said so in the summary and doesn't repeat itself.
  const hasAnySource = !!(gsc || ga4 || channelBlocks.length > 0);

  // States plainly when the period is only partly covered, rather than letting
  // the cover imply a full window of measurement.
  const coverageNote = (() => {
    const m = meta;
    if (!m) return null;
    const requested = periodDayCount(m.requested.start, m.requested.end);
    const lines: string[] = [];
    if (!m.coverage) {
      lines.push(`This report covers ${m.requested.start} to ${m.requested.end}. No day-by-day data was returned for it, so the totals above are the period figures each source reported.`);
    } else {
      const covered = periodDayCount(m.coverage.start, m.coverage.end);
      if (requested > 0 && covered > 0 && covered < requested) {
        lines.push(`Data is available for ${covered} of the ${requested} days in this period (${m.coverage.start} to ${m.coverage.end}). Figures reflect the days measured; the connected sources had no data for the rest.`);
      }
    }
    // What a short window is too short to show, so its compactness reads as a
    // decision rather than an omission.
    if (gsc || ga4) {
      const short = shortPeriodNote(requested);
      if (short) lines.push(short);
    }
    // Sources left out (stale, disconnected, no data) or covering only part
    // of the period, and the dates each platform's figures cover.
    lines.push(...sourceNotes(m.sources, m.requested));
    return lines.length > 0 ? lines.join(" ") : null;
  })();

  let n = 0;
  const next = () => (n += 1);

  return (
    // The sheet itself (ReportPaper) is pinned to theme-light: a report is a
    // deliverable that gets printed, exported to PDF and opened by a client, so
    // it stays on white paper regardless of the theme the app is being read in.
    <ReportPaper>
      {/* Cover. Same rule as the PDF cover for the badge: the stored report
          type is authoritative, with the actually-connected channels as the
          fallback for reports generated before types existed. This used to be
          `gsc && ga4 ? … : ga4 ? … : "SEO Report"`, which labelled every
          cross-channel and ads-only report "SEO Report". */}
      <ReportCover
        brand={brand}
        agencyName={branding.name}
        agencyLogoUrl={branding.logo_url}
        agencyWebsite={branding.website}
        badge={coverBadge}
        title={title}
        clientName={clientName}
        clientLogoUrl={clientLogoUrl}
        meta={[formatPeriod(period.start, period.end), compared ? "vs previous period" : ""]}
        glance={glanceCells}
      />

      <ReportBody>
        {/* The verdict. Unnumbered and above everything, because it is not a
            section of the report so much as the answer the report exists to
            give. A client who reads only this should still know whether the
            money is working, whether it improved, and what happens next. */}
        {verdict && <VerdictPanel v={verdict} color={color} />}

        {/* Executive Summary.
            Every callout must be backed by a measured fact. The slots used to
            be filled unconditionally, so a report with almost no data told the
            client "Performance held steady", "No major declines to flag" and
            "0 keywords near page one" — reassurance the numbers never
            supported. A slot with no fact behind it is now omitted, and when
            nothing at all qualifies the section says so plainly. */}
        <Section n={next()} title="Executive Summary" subtitle="Performance at a glance" brand={brand}>
          <p className="max-w-[680px] text-[16.5px] leading-[1.7] text-report-body [text-wrap:pretty]">{summaryText}</p>

          {callouts.length > 0 && (
            <TileGrid min={200} className="mt-5">
              {callouts.map((c) => (
                <Callout key={c.title} tone={c.tone} title={c.title} text={c.text} />
              ))}
            </TileGrid>
          )}

          {coverageNote && <Note className="mt-4">{coverageNote}</Note>}

          {/* What this period genuinely cannot show, and why. A custom or
              calendar window is rebuilt from daily history, and some figures —
              keyword tables, unique visitors, per-period breakdowns — cannot be
              recovered from daily totals. Saying so is the honest alternative
              to omitting them silently or estimating them. */}
          {unavailable.length > 0 && (
            <Note className="mt-4">
              <p className="font-semibold text-report-ink">Not available for this period</p>
              <ul className="mt-1.5 space-y-1.5">
                {unavailable.map((u) => (
                  <li key={u.section}>
                    <span className="font-medium text-report-ink">{u.section}.</span> {u.reason}
                  </li>
                ))}
              </ul>
            </Note>
          )}
        </Section>

        {/* SEO vs Website Performance — combined KPIs */}
        {(gsc || ga4) && (
          <Section n={next()} title={gsc && ga4 ? "Search vs Website Performance" : gsc ? "Search Performance" : "Website Performance"} subtitle={gsc && ga4 ? "Search visibility and on-site results, side by side" : gsc ? "Search visibility for the reporting period" : "On-site results for the reporting period"} brand={brand}>
            <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
              {gsc && <KpiGroup label="Search Console" kpis={gscKpis} brand={brand} />}
              {ga4 && <KpiGroup label="Website engagement (GA4)" kpis={ga4Kpis} brand={brand} />}
            </div>
            {gsc && ga4 && (
              <Note className="mt-4 text-sm">
                <strong className="font-semibold text-report-ink">{fmt(gsc.totals.clicks)}</strong> organic search clicks drove a site that saw{" "}
                <strong className="font-semibold text-report-ink">{fmt(ga4.totals.sessions)}</strong> sessions
                {hasEngagement && <> at <strong className="font-semibold text-report-ink">{pct1(ga4.totals.engagementRate)}</strong> engagement</>}
                {organicShare != null && <> — organic search is <strong className="font-semibold text-report-ink">{pct1(organicShare)}</strong> of all sessions</>}.
              </Note>
            )}
          </Section>
        )}

        {/* Organic Traffic Overview.
            The charts used to render on any number of daily rows, so three days
            of data drew a "trend" the PDF had already refused to draw at the
            same threshold. Both renderers now use MIN_TREND_POINTS, and the
            section only appears when something inside it survives that test —
            an empty frame around two flat lines is worse than no section. */}
        {showTrafficSection && (
          <Section
            n={next()}
            title="Organic Traffic Overview"
            subtitle={hasTrendCharts ? "How traffic and visibility moved this period" : "Traffic composition for this period"}
            brand={brand}
          >
            {ga4 && (
              <TileGrid min={140} className="mb-4">
                <MiniStat label="Organic sessions" value={organic ? fmt(organic.sessions) : "—"} />
                <MiniStat label="Organic share" value={organicShare != null ? pct1(organicShare) : "—"} />
                <MiniStat label="New users" value={ga4Has(ga4, "newUsers") ? fmt(ga4.totals.newUsers) : "—"} />
                <MiniStat label="Avg engagement" value={ga4Has(ga4, "avgEngagementTime") ? fmtDuration(ga4.totals.avgEngagementTime) : "—"} />
              </TileGrid>
            )}
            {(gscTrend || ga4Trend) && (
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))]">
                {gscTrend ? (
                  <TrendCard title="Search clicks" total={fmt(gsc!.totals.clicks)} delta={deltaLabel(gscClicksD)} data={gsc!.byDate} dataKey="clicks" color={brand.color} />
                ) : null}
                {ga4Trend ? (
                  <TrendCard title="Sessions" total={fmt(ga4!.totals.sessions)} delta={deltaLabel(ga4SessionsD)} data={ga4!.byDate} dataKey="sessions" color={CHART.second} />
                ) : null}
              </div>
            )}
            {gscTrend ? (
              <div className="mt-4">
                <TrendCard
                  title="Average position (lower is better)"
                  total={gsc!.totals.position.toFixed(1)}
                  delta={posDelta}
                  data={gsc!.byDate}
                  dataKey="position"
                  color={CHART.position}
                  reversed
                />
              </div>
            ) : null}
            {hasChannels ? (
              <div className="mt-6">
                <SubHead>Traffic by channel</SubHead>
                <ShareBreakdown
                  rows={ga4!.trafficSources!.slice(0, 6).map((r) => ({ key: r.key, value: r.sessions }))}
                  total={sessionsTotal}
                  colors={sharePalette(brand)}
                  format={fmt}
                />
              </div>
            ) : null}
          </Section>
        )}

        {/* Landing Page Performance */}
        {landing.length >= MIN_BREAKDOWN_ROWS && (
          <Section n={next()} title="Landing Page Performance" subtitle="Where search traffic lands and how it engages" brand={brand}>
            <div className={T.wrap}>
              <table className={`${T.table} min-w-[560px]`}>
                <thead>
                  <tr className={T.headRow}>
                    <th className={T.th}>Page</th>
                    {gsc && <th className={T.thNum}>Clicks</th>}
                    {gsc && <th className={T.thNum}>Impr.</th>}
                    {ga4 && <th className={T.thNum}>Sessions</th>}
                    {ga4 && <th className={T.thNum}>Users</th>}
                  </tr>
                </thead>
                <tbody>
                  {landing.map((r) => (
                    <tr key={r.path} className={T.row}>
                      <td className={`${T.td} max-w-0 w-[44%]`} title={r.path}>
                        <span className="block truncate font-report-mono text-[13px]">{r.path}</span>
                        <ThinBar share={(r.sessions ?? r.clicks ?? 0) / landingMax} color={brand.color} />
                      </td>
                      {gsc && <td className={T.tdNum}>{r.clicks != null ? fmt(r.clicks) : "—"}</td>}
                      {gsc && <td className={`${T.tdNum} text-report-meta`}>{r.impressions != null ? fmt(r.impressions) : "—"}</td>}
                      {ga4 && <td className={`${T.tdNum} font-semibold`}>{r.sessions != null ? fmt(r.sessions) : "—"}</td>}
                      {ga4 && <td className={`${T.tdNum} text-report-meta`}>{r.users != null ? fmt(r.users) : "—"}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        )}

        {/* Search Queries Driving Traffic */}
        {gsc && gsc.topQueries.length > 0 && (
          <Section n={next()} title="Search Queries Driving Traffic" subtitle="Your biggest organic traffic drivers" brand={brand}>
            <div className={T.wrap}>
              <table className={`${T.table} min-w-[520px]`}>
                <thead>
                  <tr className={T.headRow}>
                    {/* The query gets the room; the four figures are short. */}
                  <th className={`${T.th} w-[46%]`}>Query</th>
                    <th className={T.thNum}>Clicks</th>
                    <th className={T.thNum}>Impr.</th>
                    <th className={T.thNum}>CTR</th>
                    <th className={T.thNum}>Pos.</th>
                  </tr>
                </thead>
                <tbody>
                  {gsc.topQueries.slice(0, 8).map((q) => (
                    <tr key={q.key} className={T.row}>
                      <td className={`${T.td} max-w-0 truncate font-medium`}>{q.key}</td>
                      <td className={`${T.tdNum} font-semibold`}>{fmt(q.clicks)}</td>
                      <td className={`${T.tdNum} text-report-meta`}>{fmt(q.impressions)}</td>
                      <td className={`${T.tdNum} text-report-meta`}>{pct1(q.ctr)}</td>
                      <td className={T.tdNum}><PositionChip position={q.position} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(winners.length > 0 || decliners.length > 0) && (
              <div className="mt-[22px]">
                <MoversPanels
                  winners={winners.map((k) => ({ key: k.key, pct: k.changePct }))}
                  decliners={decliners.map((k) => ({ key: k.key, pct: k.changePct }))}
                />
              </div>
            )}
          </Section>
        )}

        {/* Conversion Opportunities.
            The presence of GA4 alone used to open this section, so a property
            with no conversions and no near-page-one keywords got a heading
            promising "where the next gains are" above a conversion count of
            zero — a figure the KPI group above already carries. It now needs
            something to point at: ranking opportunities, written ones, or
            conversion activity to talk about. */}
        {(opportunities.length > 0
          || (ins?.growthOpportunities.length ?? 0) > 0
          || (ga4 != null && (ga4.totals.conversions > 0 || ga4.totals.totalRevenue > 0))) && (
          <Section n={next()} title="Conversion Opportunities" subtitle="Where the next gains are — quick wins" brand={brand}>
            {ga4 && (
              <TileGrid min={150} className="mb-5">
                <MiniStat label="Conversions" value={fmt(ga4.totals.conversions)} />
                <MiniStat label="Conversion rate" value={convRate != null ? pct1(convRate) : "—"} />
                {ga4.totals.totalRevenue > 0 && <MiniStat label="Total revenue" value={fmt(ga4.totals.totalRevenue)} />}
              </TileGrid>
            )}
            {opportunities.length > 0 && (
              <>
                <SubHead>Keywords on the edge of page one</SubHead>
                <EdgeKeywords rows={opportunities.map((o) => ({ key: o.key, impressions: o.impressions, position: o.position }))} brand={brand} />
              </>
            )}
            {ins && ins.growthOpportunities.length > 0 && (
              <ul className={`flex flex-col gap-2 ${opportunities.length > 0 ? "mt-[18px]" : ""}`}>
                {ins.growthOpportunities.map((g, i) => (
                  <IdeaTile key={i}>{g}</IdeaTile>
                ))}
              </ul>
            )}
          </Section>
        )}

        {/* Audience — GA4 devices & countries */}
        {ga4 && (hasDevices || hasCountries) && (
          <Section n={next()} title="Audience" subtitle="How visitors reach the site — by device and country" brand={brand}>
            <div className="grid gap-6 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
              {hasDevices && (
                <div>
                  <SubHead className="!mb-1.5">Devices</SubHead>
                  <ShareRows rows={ga4.devices!.slice(0, 6).map((r) => ({ key: r.key, value: r.sessions }))} total={sessionsTotal} brand={brand} format={fmt} label={titleCase} />
                </div>
              )}
              {hasCountries && (
                <div>
                  <SubHead className="!mb-1.5">Top countries</SubHead>
                  <ShareRows rows={ga4.countries!.slice(0, 6).map((r) => ({ key: r.key, value: r.sessions }))} total={sessionsTotal} brand={brand} format={fmt} />
                </div>
              )}
            </div>
          </Section>
        )}

        {/* Connected channels — provider-agnostic, one section per integration */}
        {channelBlocks.map((block) => (
          <Section
            key={blockKey(block)}
            n={next()}
            title={block.sourceName}
            subtitle={periodSubtitle("Performance during this period", blockHasComparison(block))}
            brand={brand}
          >
            {/* Same rule as the PDF: an individual "—" beside real figures says
                that metric has no denominator, but a whole row of them says
                nothing, so the row is dropped rather than rendered empty. */}
            {hasCalculableKpis(block.kpis.slice(0, MAX_CHANNEL_KPIS)) && (
              <TileGrid min={150}>
                {block.kpis.slice(0, MAX_CHANNEL_KPIS).map((k) => (
                  <KpiCard key={k.label} label={k.label} value={formatBlockValue(k.value, k.format, block.currency)} delta={blockDelta(k)} brand={brand} />
                ))}
              </TileGrid>
            )}

            {block.tables.map((table) => (
              table.rows.length >= MIN_BREAKDOWN_ROWS && (
                <div key={table.title} className="mt-6">
                  <SubHead>{table.title}</SubHead>
                  <div className={T.wrap}>
                    <table className={`${T.table} min-w-[500px]`}>
                      <thead>
                        <tr className={T.headRow}>
                          {table.columns.map((c, ci) => (
                            <th key={c.key} className={ci === 0 ? T.th : T.thNum}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.slice(0, 8).map((row, ri) => (
                          <tr key={ri} className={T.row}>
                            {table.columns.map((c, ci) => (
                              <td key={c.key} className={ci === 0 ? `${T.td} max-w-0 truncate` : T.tdNum}>
                                {typeof row[c.key] === "number"
                                  ? formatBlockValue(row[c.key] as number, c.format, block.currency)
                                  : String(row[c.key] ?? "—")}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            ))}

            {block.notes.map((note) => (
              <p key={note} className="mt-3 text-[13px] leading-normal text-report-meta">{note}</p>
            ))}
          </Section>
        ))}

        {/* What stood out, and what it means.
            Wins, risks and the interpretation layer were three sections, each
            with its own heading and a short list under it — the same act of
            reading for the client, fragmented. They share one section now, and
            the interpretation layer still pairs each measured signal with the
            standing meaning of that pattern, so the client gets "and
            therefore…" rather than another table. */}
        {((ins && (ins.keyWins.length > 0 || ins.issuesDetected.length > 0)) || soWhat.length > 0) && (
          <Section n={next()} title="What stood out, and what it means" subtitle="Highlights from the period, and what they point to" brand={brand}>
            {ins && (ins.keyWins.length > 0 || ins.issuesDetected.length > 0) && (
              <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))]">
                {ins.keyWins.length > 0 && (
                  <div>
                    <p className="mb-2 text-[13px] font-semibold text-report-good">Key wins</p>
                    <ul className="flex flex-col gap-2">
                      {ins.keyWins.map((w, i) => (
                        <ToneTile key={i} tone="good">{w}</ToneTile>
                      ))}
                    </ul>
                  </div>
                )}
                {ins.issuesDetected.length > 0 && (
                  <div>
                    <p className="mb-2 text-[13px] font-semibold text-report-bad">Issues detected</p>
                    <ul className="flex flex-col gap-2">
                      {ins.issuesDetected.map((it, i) => (
                        <ToneTile key={i} tone="bad">{it}</ToneTile>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {soWhat.length > 0 && (
              <div className={ins && (ins.keyWins.length > 0 || ins.issuesDetected.length > 0) ? "mt-6" : ""}>
                {ins && (ins.keyWins.length > 0 || ins.issuesDetected.length > 0) && (
                  <p className="mb-2.5 text-[13px] font-semibold text-report-secondary">What this means</p>
                )}
                <div className="flex flex-col gap-3">
                  {soWhat.map((w) => (
                    <MeaningCard
                      key={w.observation}
                      observation={w.observation}
                      meaning={w.meaning}
                      metric={w.metric}
                      source={w.source}
                      confidence={w.confidence}
                      confidenceReason={w.confidenceReason}
                    />
                  ))}
                </div>
              </div>
            )}
          </Section>
        )}

        {/* Evidence-backed next steps, each carrying the figure behind it, with
            the AI's remaining commentary beneath them in the same section. The
            commentary only appears when cleaning left something that reads as
            commentary — it had its own heading before, which meant a heading
            could ship above a single malformed list item. */}
        {(evidenceActions.length > 0 || commentary.length > 0 || hasAnySource) && (
          <Section n={next()} title="Recommended actions" subtitle={evidenceActions.length > 0 ? "Each step is prompted by a figure measured in this report" : "What this period's data does, and does not, support acting on"} brand={brand}>
            {/* Nothing measured cleared the bar. Said outright, because a
                section that silently disappears reads as an omission. */}
            {evidenceActions.length === 0 && <Note className="text-sm">{NO_EVIDENCE_NOTE}</Note>}

            {evidenceActions.length > 0 && (
              <StepList>
                {evidenceActions.map((a, i) => (
                  <StepRow
                    key={a.action}
                    n={i + 1}
                    brand={brand}
                    action={a.action}
                    because={`Because: ${a.because} (${a.source})`}
                    priority={a.priority}
                  />
                ))}
              </StepList>
            )}

            {/* Always below something: the steps, or the no-evidence note. */}
            {commentary.length > 0 && (
              <div className="mt-5">
                <p className="mb-2.5 text-[13px] font-semibold text-report-secondary">Further commentary</p>
                <StepList>
                  {commentary.map((r, i) => (
                    <StepRow key={i} n={i + 1} brand={brand} action={r} />
                  ))}
                </StepList>
              </div>
            )}
          </Section>
        )}

        {/* Agency Notes.
            Rendered only when the agency actually wrote one. This section used
            to render unconditionally, filling itself with a sentence the agency
            never said — in italics, under "A note from your team". */}
        {note && (
          <Section n={next()} title="Agency Notes" subtitle="A note from your team" brand={brand}>
            <NotePanel brand={brand} agencyName={branding.name} agencyLogoUrl={branding.logo_url}>
              <p>{note}</p>
            </NotePanel>
          </Section>
        )}

        <ReportFooter left={<>Prepared by {branding.name || "Your Agency"}</>} right={branding.website} />
      </ReportBody>
    </ReportPaper>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function KpiGroup({ label, kpis, brand }: { label: string; kpis: { l: string; v: string; d: { pct: number; good: boolean } | null; s: number[] | null }[]; brand: Brand }) {
  return (
    <div className="min-w-0">
      <p className="mb-2.5 text-[13px] font-semibold text-report-secondary">{label}</p>
      <div className="grid grid-cols-2 gap-2.5">
        {kpis.map((m) => (
          <KpiCard key={m.l} label={m.l} value={m.v} delta={deltaLabel(m.d)} spark={m.s} brand={brand} />
        ))}
      </div>
    </div>
  );
}

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
