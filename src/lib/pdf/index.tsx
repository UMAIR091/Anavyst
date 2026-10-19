// Server-side premium white-label PDF generation for reports. Uses
// @react-pdf/renderer (no headless browser) so it runs on Vercel serverless.
// Renders the unified GSC + GA4 report into a branded, multi-page business
// document: cover page, a one-page executive dashboard (score gauge + hero
// KPIs + AI summary), sectioned performance detail with smoothed vector charts
// and zebra tables, scannable insight/action cards, a trend-based forecast, and
// running header/footer with page numbers. Layout building blocks live in
// ./components.tsx and ./charts.tsx; derived analytics in ./analysis.ts; design
// tokens in ./theme.ts.
import React from "react";
import { Document, Page, View, Text, Font, renderToBuffer } from "@react-pdf/renderer";
import { normalizeReportData, periodDayCount, dataQualityLines } from "@/lib/report";
import { ga4Has } from "@/lib/reports/dataQuality";
import { safeFetch } from "@/lib/ssrf";
import type { GscReportFull, Ga4ReportFull } from "@/lib/google";
import { makeStyles, safeColor, tint, tones, seriesColors, ink, up, down, type Tone } from "./theme";
import { fmt, pct1, fmtDate, deltaPct, deltaLabel, pagePathOf } from "./format";
import { CoverPage, PageChrome, Section, VerdictPanel, KpiCard, DataTable, HighlightChips, ChartCard, Bullets, GaugePanel, DashTile, InsightCards, ActionCard, type Branding, type Highlight, type Col } from "./components";
import { LineChart, BarList, ShareBar } from "./charts";
import { Icon, TrendArrow } from "./icons";
import { detectSignals } from "@/lib/insights/signals";
import { allSoWhat, allActions, NO_EVIDENCE_NOTE } from "@/lib/reports/soWhat";
import { buildExecutiveSummary, blockHasComparison, hasCalculableKpis, hasComparison, periodSubtitle } from "@/lib/reports/summary";
import { buildVerdict } from "@/lib/reports/verdict";
import { agencyNote, cleanBullets, cleanCommentary } from "@/lib/reports/commentary";
import { badgeRepeatsTitle, coverBadgeLabel } from "@/lib/reports/types";
import { assessComposition, MAX_CHANNEL_KPIS, MIN_BREAKDOWN_ROWS, MIN_DAYS_FOR_PROJECTION, MIN_TREND_POINTS, shortPeriodNote } from "@/lib/reports/composition";
import { performanceScore, bestChannel, biggestOpportunity, biggestRisk, toInsightCard, buildForecast } from "./analysis";
import { blockKey, type BlockFormat, type ReportBlock } from "@/lib/integrations/blocks";

export type { Branding };

// Business documents shouldn't hyphenate ("Re-port" on the cover). Words wrap
// whole; long URLs/queries are pre-truncated by the table layer.
Font.registerHyphenationCallback((word) => [word]);

// A4 content width: 595pt − 2 × 46pt page padding.
const CONTENT_W = 503;
const CARD_PAD = 22; // ChartCard horizontal padding (11 × 2)
const HALF_W = Math.floor((CONTENT_W - 10) / 2);

// ── Generic channel rendering ────────────────────────────────────────────────
// Search Console and GA4 keep their bespoke, hand-tuned sections above. EVERY
// other connected integration arrives as a ReportBlock and is rendered by the
// code below, so a newly added integration appears in the PDF with no change
// here. Blocks carry their own labels, formats and currency, so nothing in this
// file needs to know which provider produced them.

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", AUD: "A$", CAD: "C$", INR: "₹" };

function moneyPrefix(currency: string | null): string {
  if (!currency) return "";
  return CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `;
}

function fmtBlockValue(value: number | null, format: BlockFormat, currency: string | null): string {
  // Matches the on-screen report: not calculable renders as an em dash, so the
  // PDF a client receives never states a rate that has no denominator.
  if (value === null || !Number.isFinite(value)) return "—";
  switch (format) {
    case "percent": return pct1(value);
    case "currency": return `${moneyPrefix(currency)}${fmt(Math.round(value * 100) / 100)}`;
    case "duration": return value >= 60 ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s` : `${Math.round(value)}s`;
    case "position": return value.toFixed(1);
    default: return fmt(value);
  }
}

// One connected channel: its KPI cards, up to two trend charts, and its tables.
function ChannelSection({ s, color, palette, block, sectionNum }: {
  s: ReturnType<typeof makeStyles>;
  color: string;
  palette: string[];
  block: ReportBlock;
  sectionNum: string;
}) {
  // Every metric the source reported, up to the cap. A row where nothing is
  // calculable is a row of em dashes: an individual "—" beside real figures
  // tells the reader that metric has no denominator, but a whole row of them
  // carries no information at all.
  const allKpis = block.kpis.slice(0, MAX_CHANNEL_KPIS);
  const kpis = hasCalculableKpis(allKpis) ? allKpis : [];
  // Same rule as the Google trend sections: a two-point line is decoration.
  const charts = block.series.filter((ser) => ser.points.length >= 5).slice(0, 2);

  return (
    <Section
      s={s}
      num={sectionNum}
      title={block.sourceName}
      subtitle={`${periodSubtitle("Performance during this period", blockHasComparison(block))}.`}
      // The KPI row travels with the channel's heading, so a section can never
      // announce a channel on one page and show its figures on the next.
      keepWithHead={kpis.length > 0 ? (
        <View style={s.kpiRow} wrap={false}>
          {kpis.map((k) => (
            <KpiCard
              key={k.label}
              s={s}
              color={color}
              label={k.label}
              value={fmtBlockValue(k.value, k.format, block.currency)}
              delta={deltaPct(k.value, k.previous)}
              lowerBetter={k.lowerBetter}
            />
          ))}
        </View>
      ) : null}
    >
      {charts.length > 0 ? (
        <View style={s.chartRow}>
          {charts.map((ser, i) => (
            <View key={ser.label} style={s.chartCol}>
              <ChartCard
                s={s}
                title={ser.label}
                value={fmtBlockValue(ser.points.reduce((a, p) => a + p.value, 0), ser.format, block.currency)}
                hint={block.sourceName}
              >
                <LineChart
                  id={`${blockKey(block)}-${i}`}
                  values={ser.points.map((p) => p.value)}
                  dates={ser.points.map((p) => p.date)}
                  color={i === 0 ? color : palette[(i + 1) % palette.length]}
                  width={HALF_W - CARD_PAD}
                />
              </ChartCard>
            </View>
          ))}
        </View>
      ) : null}

      {/* Heading and table move together: `wrap={false}` on the pair keeps a
          "Top campaigns" title from sitting at the foot of one page with its
          table on the next. Capped at 8 rows, so the pair always fits a page. */}
      {block.tables.map((table) => (
        table.rows.length >= MIN_BREAKDOWN_ROWS ? (
          <View key={table.title} style={{ marginTop: 10 }} wrap={false}>
            <Text style={s.h3}>{table.title}</Text>
            <DataTable
              s={s}
              cols={table.columns.map((c, ci) => ({
                header: c.label,
                ...(ci === 0 ? { flex: 2 } : { width: 62, align: "right" as const, strong: ci === 1 }),
                cell: (row: Record<string, string | number>) => {
                  const v = row[c.key];
                  return typeof v === "number" ? fmtBlockValue(v, c.format, block.currency) : String(v ?? "—");
                },
              })) satisfies Col<Record<string, string | number>>[]}
              rows={table.rows.slice(0, 8)}
            />
          </View>
        ) : null
      ))}

      {block.notes.map((note) => (
        <Text key={note} style={s.chartHint}>{note}</Text>
      ))}
    </Section>
  );
}

/**
 * A caption that tells the reader what the line MEANS, computed from the line
 * itself: first half of the period against the second. A chart with a title and
 * a number still leaves "is that good?" unanswered.
 *
 * Says nothing when there are too few points to compare — an unsupported
 * "trending up" on four days of data is exactly the kind of claim this report
 * must not make.
 */
function trendCaption(label: string, values: number[], source: string): string {
  // Below MIN_DAYS_FOR_PROJECTION the two halves are three or four days each, so
  // "ran 12% higher in the second half" is a claim about day-of-week variation
  // as much as about performance. The chart still shows the shape, which is
  // real; the sentence that interprets it waits for enough days to mean it.
  if (values.length < MIN_DAYS_FOR_PROJECTION) {
    return values.length > 0
      ? `${source} · ${values.length} day${values.length === 1 ? "" : "s"} of data — too few to describe a trend`
      : `${source} · no daily data`;
  }
  const half = Math.floor(values.length / 2);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const first = mean(values.slice(0, half));
  const second = mean(values.slice(half));
  if (first === 0) return `${source} · no earlier activity to compare against`;
  const pct = ((second - first) / first) * 100;
  // Under 5% either way is noise, not a movement worth narrating.
  if (Math.abs(pct) < 5) return `${source} · broadly flat across the period`;
  const dir = pct > 0 ? "higher" : "lower";
  return `${source} · ${label.toLowerCase()} ran ${Math.abs(pct).toFixed(0)}% ${dir} in the second half of the period`;
}

// Which metric a label refers to, regardless of how the label is worded.
// "Traffic (sessions)" on a hero card and "Sessions" on a movement chip are the
// same number; so are "Impressions" and "Search impressions". Used to keep the
// dashboard from stating a movement twice on one page.
function metricKey(label: string): string {
  const t = label.toLowerCase();
  if (/revenue/.test(t)) return "revenue";
  if (/conversion rate/.test(t)) return "conversion-rate";
  if (/conversion/.test(t)) return "conversions";
  if (/session|traffic/.test(t)) return "sessions";
  if (/impression/.test(t)) return "impressions";
  if (/click-through|ctr/.test(t)) return "ctr";
  if (/click/.test(t)) return "clicks";
  if (/position/.test(t)) return "position";
  if (/new users/.test(t)) return "new-users";
  if (/user/.test(t)) return "users";
  if (/engagement/.test(t)) return "engagement";
  return t;
}

// ── Auto-computed "at a glance" movements for the executive summary ──────────
function buildHighlights(gsc: GscReportFull | null, ga4: Ga4ReportFull | null): Highlight[] {
  type Cand = { label: string; cur: number; prev: number | null | undefined; lowerBetter?: boolean; format: (n: number) => string };
  const cands: Cand[] = [];
  if (gsc) {
    cands.push(
      { label: "Organic clicks", cur: gsc.totals.clicks, prev: gsc.previousTotals?.clicks, format: fmt },
      { label: "Search impressions", cur: gsc.totals.impressions, prev: gsc.previousTotals?.impressions, format: fmt },
      { label: "Avg. CTR", cur: gsc.totals.ctr, prev: gsc.previousTotals?.ctr, format: pct1 },
      { label: "Avg. position", cur: gsc.totals.position, prev: gsc.previousTotals?.position, lowerBetter: true, format: (n) => n.toFixed(1) },
    );
  }
  if (ga4) {
    // A total a rebuilt period could not measure is not a candidate: its 0 is
    // a placeholder, not a result (lib/reports/dataQuality ga4Has).
    if (ga4Has(ga4, "users")) cands.push({ label: "Users", cur: ga4.totals.users, prev: ga4.previousTotals?.users, format: fmt });
    cands.push({ label: "Sessions", cur: ga4.totals.sessions, prev: ga4.previousTotals?.sessions, format: fmt });
    if (ga4Has(ga4, "engagementRate")) cands.push({ label: "Engagement rate", cur: ga4.totals.engagementRate, prev: ga4.previousTotals?.engagementRate, format: pct1 });
    if (ga4Has(ga4, "conversions")) cands.push({ label: "Conversions", cur: ga4.totals.conversions, prev: ga4.previousTotals?.conversions, format: fmt });
    if (ga4Has(ga4, "totalRevenue") && ga4.totals.totalRevenue > 0) {
      cands.push({ label: "Revenue", cur: ga4.totals.totalRevenue, prev: ga4.previousTotals?.totalRevenue, format: fmt });
    }
  }
  return cands
    .map((c) => ({ c, delta: deltaPct(c.cur, c.prev) }))
    .filter((x): x is { c: Cand; delta: number } => x.delta != null && Math.abs(x.delta) >= 2)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6)
    .map(({ c, delta }) => ({
      text: `${c.label}: ${c.format(c.cur)} (${deltaLabel(delta)})`,
      delta,
      good: c.lowerBetter ? delta < 0 : delta > 0,
    }));
}

// ── Document ─────────────────────────────────────────────────────────────────
function ReportPdfDoc({ data, branding, logoSrc, clientLogoSrc, clientName, title, period, generatedAt }: {
  data: unknown;
  branding: Branding;
  logoSrc: string | null;
  clientLogoSrc: string | null;
  clientName: string;
  title: string;
  period: { start: string; end: string };
  generatedAt: string;
}) {
  const color = safeColor(branding.brand_color);
  const s = makeStyles(color);
  const { gsc, ga4, blocks, insights, meta } = normalizeReportData(data);

  // Every connected integration other than Search Console / GA4, already
  // projected into the neutral block vocabulary by lib/integrations/blocks.ts.
  const channelBlocks = (blocks ?? []).filter((b) => b.kpis.length > 0 || b.tables.length > 0);

  const ins = insights as {
    executiveSummary?: string; summary?: string;
    keyWins?: string[]; highlights?: string[];
    issuesDetected?: string[]; growthOpportunities?: string[];
    recommendedActions?: string[]; recommendations?: string[];
  } | null;
  // AI text is cleaned before it is trusted: models add list numbering to
  // strings that are already list items, and a bullet that is a numbering
  // artefact ("1") rendered beside a card's own ordinal read as "1. 1" in a
  // report a client received.
  const executiveSummary = (ins?.executiveSummary ?? ins?.summary ?? "").trim();
  const keyWins = cleanBullets(ins?.keyWins ?? ins?.highlights);
  const issuesDetected = cleanBullets(ins?.issuesDetected);
  const growthOpportunities = cleanBullets(ins?.growthOpportunities);

  const movers = gsc?.movers ?? null;
  const opportunities = movers?.opportunities ?? [];
  const allHighlights = buildHighlights(gsc, ga4);
  // Whether this report has a previous period behind it at all. Section
  // subtitles promised "compared with the previous period" regardless, which
  // sat above KPI cards carrying no deltas.
  const comparison = hasComparison({ gsc, ga4, blocks: channelBlocks });
  // The cover badge describes what the report actually IS. It used to be
  // `gsc && ga4 ? … : ga4 ? … : "SEO Report"`, so anything without GA4 — a
  // Meta-Ads-only paid report included — was stamped "SEO Report". The stored
  // report type is authoritative; the connected channels are the fallback for
  // reports generated before types existed.
  const channelNames = [
    ...(gsc ? ["Search Console"] : []),
    ...(ga4 ? ["Analytics"] : []),
    ...channelBlocks.map((b) => b.sourceName),
  ];
  const badgeLabel = coverBadgeLabel(meta?.reportType, channelNames);
  // Dropped when the title already says it — the cover carried the same phrase
  // twice, once as a badge and once in the title beneath it.
  const badge = badgeRepeatsTitle(badgeLabel, title) ? "" : badgeLabel;
  const chrome = { s, branding, title, generatedAt, logoSrc };

  const revenue = ga4 && ga4Has(ga4, "totalRevenue") && ga4.totals.totalRevenue > 0 ? ga4.totals.totalRevenue : null;
  const hasConv = ga4Has(ga4, "conversions");
  const convRate = ga4 && hasConv && ga4.totals.sessions > 0 ? ga4.totals.conversions / ga4.totals.sessions : null;
  const prevConvRate = hasConv && ga4?.previousTotals && ga4.previousTotals.sessions > 0 ? ga4.previousTotals.conversions / ga4.previousTotals.sessions : null;
  // A GA4 card for a total this period could not measure reads "—", not 0.
  const ga4Card = (key: "users" | "newUsers" | "engagementRate" | "conversions", format: (n: number) => string) =>
    ga4 && ga4Has(ga4, key)
      ? { value: format(ga4.totals[key]), delta: deltaPct(ga4.totals[key], ga4.previousTotals?.[key]) }
      : { value: "—", delta: null };

  // Hero KPIs for the dashboard: the four metrics that matter most to an
  // executive, built from whatever this report actually has. ROAS needs ad
  // spend (not in the GSC+GA4 model), so it's omitted rather than invented.
  type Hero = { icon: string; label: string; value: string; delta: number | null; lowerBetter?: boolean };
  const heroKpis: Hero[] = [];
  if (revenue != null) heroKpis.push({ icon: "dollar", label: "Revenue", value: fmt(revenue), delta: deltaPct(revenue, ga4!.previousTotals?.totalRevenue) });
  if (convRate != null) heroKpis.push({ icon: "checkCircle", label: "Conversion Rate", value: pct1(convRate), delta: deltaPct(convRate, prevConvRate) });
  if (ga4) heroKpis.push({ icon: "activity", label: "Traffic (sessions)", value: fmt(ga4.totals.sessions), delta: deltaPct(ga4.totals.sessions, ga4.previousTotals?.sessions) });
  else if (gsc) heroKpis.push({ icon: "clicks", label: "Organic Clicks", value: fmt(gsc.totals.clicks), delta: deltaPct(gsc.totals.clicks, gsc.previousTotals?.clicks) });
  if (ga4 && revenue == null && ga4Has(ga4, "users")) heroKpis.push({ icon: "users", label: "Users", value: fmt(ga4.totals.users), delta: deltaPct(ga4.totals.users, ga4.previousTotals?.users) });
  else if (gsc) heroKpis.push({ icon: "eye", label: "Impressions", value: fmt(gsc.totals.impressions), delta: deltaPct(gsc.totals.impressions, gsc.previousTotals?.impressions) });
  else if (ga4 && hasConv) heroKpis.push({ icon: "target", label: "Conversions", value: fmt(ga4.totals.conversions), delta: deltaPct(ga4.totals.conversions, ga4.previousTotals?.conversions) });
  const allHeroKpis = heroKpis.slice(0, 4);

  // The chips used to restate the hero cards: a rich report showed REVENUE +20%
  // and TRAFFIC (SESSIONS) +15% as cards, then "Revenue: 48,000 (+20%)" and
  // "Sessions: 31,000 (+15%)" as chips directly beneath them. Anything already
  // on a card is dropped from the chips, so the two rows say different things.
  const heroKeys = new Set(allHeroKpis.map((k) => metricKey(k.label)));
  const highlights = allHighlights.filter((h) => !heroKeys.has(metricKey(h.text.split(":")[0])));

  // Executive-dashboard derivations (deterministic, real data only).
  const score = performanceScore(gsc, ga4);
  const channelTile = bestChannel(ga4);
  const opportunityTile = biggestOpportunity(gsc, growthOpportunities);
  const riskTile = biggestRisk(gsc, issuesDetected);
  const dashTiles = [channelTile, opportunityTile, riskTile].filter((t): t is NonNullable<typeof t> => t != null);
  const forecast = buildForecast(gsc, ga4);

  // The interpretation layer. Signals are arithmetic over the client's own
  // rows; buildSoWhat attaches the standing meaning of each pattern and
  // allActions the next step, each carrying the figure that motivated it.
  const signals = detectSignals(gsc, ga4, 6);
  const soWhat = allSoWhat(signals, channelBlocks, 3);
  // The executive dashboard page only exists when a Google source is present.
  // Without it the interpretation layer had nowhere to render at all, which is
  // why an ads-only report showed no "what this means" — it moves to the
  // insights page instead of being dropped.
  const soWhatOffDashboard = gsc || ga4 ? [] : soWhat;
  const evidenceActions = allActions(signals, channelBlocks, 5);

  // The executive summary. The AI paragraph is preferred when there is one;
  // otherwise it is built from the measured figures, which is possible with or
  // without a previous period to compare against. The old fallback read only
  // Search Console and Analytics, so a paid-media report was told "a written
  // summary needs a full period of data to compare against" while holding real
  // spend, clicks and conversions.
  const summary = buildExecutiveSummary({
    clientName, period, gsc, ga4, blocks: channelBlocks,
    watch: evidenceActions[0] ? { action: evidenceActions[0].action, because: evidenceActions[0].because } : null,
  });
  const summaryText = executiveSummary || summary.text;

  // The verdict. Built from the snapshot rather than the AI paragraph: this is
  // the block a client is guaranteed to read, so it states only what the
  // figures prove. Null when nothing measurable came back, in which case the
  // panel is omitted rather than heading an empty report with a cheerful line.
  const verdict = buildVerdict({
    period, gsc, ga4, blocks: channelBlocks,
    watch: evidenceActions[0] ? { action: evidenceActions[0].action, because: evidenceActions[0].because } : null,
  });

  // Commentary the AI wrote that isn't already covered by the evidence-backed
  // steps. Empty after cleaning means the section does not render at all.
  const commentary = cleanCommentary(
    ins?.recommendedActions ?? ins?.recommendations,
    evidenceActions.map((a) => a.action),
  );

  // The agency's own closing note — null when they haven't written one.
  const note = agencyNote(branding.footer_text);

  // Whether the report has any connected source at all. A report with data but
  // no action worth taking says so outright; a report with nothing in it has
  // already said so in the summary and doesn't repeat itself.
  const hasAnySource = !!(gsc || ga4 || channelBlocks.length > 0);

  // Coverage and limitations, stated in the document the client receives —
  // not just in the dashboard. A partially-covered period must never look like
  // a full one.
  const coverageLines: string[] = [];
  if (meta) {
    const requested = periodDayCount(meta.requested.start, meta.requested.end);
    if (!meta.coverage) {
      coverageLines.push(`No day-by-day data was returned for ${meta.requested.start} to ${meta.requested.end}, so the totals above are the period figures each source reported.`);
    } else {
      const covered = periodDayCount(meta.coverage.start, meta.coverage.end);
      if (requested > 0 && covered > 0 && covered < requested) {
        coverageLines.push(`Data is available for ${covered} of the ${requested} days in this period (${meta.coverage.start} to ${meta.coverage.end}). Figures reflect the days measured.`);
      }
    }
    if (meta.periodInProgress) {
      coverageLines.push("This period is still running, so the figures cover it up to the most recent complete day.");
    }
    // What a short window is too short to show. Only where the analyses in
    // question apply at all: they read Search Console and Analytics history.
    if (gsc || ga4) {
      const short = shortPeriodNote(requested);
      if (short) coverageLines.push(short);
    }
    // Sources left out or covering part of the period, per-platform windows,
    // and figures a rebuilt period can't show — the same list the web report
    // and the AI prompt read.
    coverageLines.push(...dataQualityLines(meta));
  }

  // MIN_TREND_POINTS is shared with the composition assessment so the page
  // planner and the renderer agree on what counts as a chart.
  const hasTrends = (gsc?.byDate?.length ?? 0) >= MIN_TREND_POINTS || (ga4?.byDate?.length ?? 0) >= MIN_TREND_POINTS;
  const hasSearch = !!gsc && (gsc.topQueries.length > 0 || (movers?.winners?.length ?? 0) > 0 || opportunities.length > 0);
  // A breakdown needs MIN_BREAKDOWN_ROWS rows to be a breakdown, so a section
  // whose tables all hold a single row does not open at all.
  const hasChannels = (ga4?.trafficSources?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const hasLandingPages = (ga4?.topLandingPages?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const hasDevices = (ga4?.devices?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const hasCountries = (ga4?.countries?.length ?? 0) >= MIN_BREAKDOWN_ROWS;
  const hasTraffic = !!ga4 && (hasChannels || hasLandingPages);
  const hasAudience = !!ga4 && (hasDevices || hasCountries);
  const hasDetails = hasTrends || hasSearch || hasTraffic || hasAudience;
  // Composition is decided from how much renderable content exists, not from
  // a shape that happened to match one sparse test account.
  const composition = assessComposition({
    gsc, ga4, blocks: channelBlocks,
    insightUnits: soWhat.length + evidenceActions.length,
  });
  const compact = composition.flowSummary;
  // Heaviest channel first, so the one carrying the most data leads instead of
  // every channel getting equal billing in connection order.
  const orderedChannelBlocks = composition.channels
    .map((c) => channelBlocks.find((b) => blockKey(b) === c.key))
    .filter((b): b is ReportBlock => !!b);
  // A channel only shares the dashboard page when it has too little to fill
  // one of its own AND that page exists — an ads-only report has no dashboard
  // page, and diverting into it dropped the section entirely.
  //
  // Density is part of the condition on purpose. Dropping it, so that any thin
  // channel merged, was measured on the seven-day fixture: the dashboard page
  // was already full, so the channel spilled onto a page of its own anyway —
  // same page count, and the channel now read before the trends and tables
  // instead of after them. A merge only helps when the page it merges into has
  // room, which is what minimal density means.
  const soloChannel = composition.channels.length === 1 && !composition.channels[0].standalone;
  const mergeChannel = compact && soloChannel && !!(gsc || ga4);

  // On a thin report the hero row and the Performance Overview that follows it
  // on the same page are the same two or three numbers, presented twice at
  // full size. With plenty of data the two earn their places — the hero row is
  // the 30-second read and the overview breaks it out further — but with a
  // handful of figures the overview is a strict superset, so the hero row is
  // dropped rather than restating it. Nothing is lost: every hero metric
  // appears in the overview, with its CTR and position alongside.
  const heroRow = compact && (gsc || ga4) ? [] : allHeroKpis;

  // Channels are grouped onto pages rather than given one page each. The
  // composition assessment already measures whether a channel has enough to
  // justify opening a page (`standalone`); that answer was only being used for
  // the single-channel case, so a thin second channel — five KPI cards and
  // nothing else — still got a page to itself. One that doesn't qualify now
  // flows onto the page before it. No page target is involved: a channel with
  // enough content still leads its own page, and nothing is dropped either way.
  const channelPages: ReportBlock[][] = [];
  for (const b of mergeChannel ? [] : orderedChannelBlocks) {
    const standalone = composition.channels.find((c) => c.key === blockKey(b))?.standalone ?? true;
    if (channelPages.length === 0 || standalone) channelPages.push([b]);
    else channelPages[channelPages.length - 1].push(b);
  }
  const hasInsightCards = keyWins.length > 0 || issuesDetected.length > 0 || growthOpportunities.length > 0;
  // Previously excluded the evidence layer, so a report whose only content
  // was "what this means" + coverage skipped the page holding them entirely.
  // Where the written summary lands. The dashboard page holds it when there is
  // one; otherwise the first channel page opens with it; and a report with
  // neither still gets it, on the closing page, rather than none at all.
  const summaryOnDashboard = !!(gsc || ga4);
  const summaryOnChannelPage = !summaryOnDashboard && channelPages.length > 0;
  const summaryOnInsightsPage = !summaryOnDashboard && !summaryOnChannelPage;
  const hasInsights =
    hasInsightCards || commentary.length > 0 || !!note || evidenceActions.length > 0 ||
    coverageLines.length > 0 || soWhatOffDashboard.length > 0 || summaryOnInsightsPage;

  // Sections are numbered in document order; only rendered sections count.
  let sn = 0;
  const num = () => String(++sn).padStart(2, "0");

  const palette = seriesColors(color);

  const queryCols: Col<{ key: string; clicks: number; impressions: number; ctr: number; position: number }>[] = [
    { header: "Query", flex: 1, cell: (q) => q.key },
    { header: "Clicks", width: 48, align: "right", strong: true, cell: (q) => fmt(q.clicks) },
    { header: "Impressions", width: 62, align: "right", cell: (q) => fmt(q.impressions) },
    { header: "CTR", width: 42, align: "right", cell: (q) => pct1(q.ctr) },
    { header: "Position", width: 44, align: "right", cell: (q) => q.position.toFixed(1) },
  ];

  // Extracted so the same section can render either on its own page or, when
  // the report is thin, inside the dashboard page. Defined as a function so
  // num() fires in document order and only for the branch that renders.
  const renderOverview = () => (
    <>

        {(gsc || ga4) ? (
          <Section s={s} num={num()} title="Performance Overview" subtitle={`${periodSubtitle("Key metrics for this reporting period", comparison)}.`}>
            {gsc ? (
              <View wrap={false}>
                <Text style={s.groupLabel}>Search visibility · Google Search Console</Text>
                <View style={s.kpiRow}>
                  <KpiCard s={s} color={color} icon="clicks" label="Clicks" value={fmt(gsc.totals.clicks)} delta={deltaPct(gsc.totals.clicks, gsc.previousTotals?.clicks)} />
                  <KpiCard s={s} color={color} icon="eye" label="Impressions" value={fmt(gsc.totals.impressions)} delta={deltaPct(gsc.totals.impressions, gsc.previousTotals?.impressions)} />
                  <KpiCard s={s} color={color} icon="percent" label="Avg. CTR" value={pct1(gsc.totals.ctr)} delta={deltaPct(gsc.totals.ctr, gsc.previousTotals?.ctr)} />
                  <KpiCard s={s} color={color} icon="target" label="Avg. Position" value={gsc.totals.position.toFixed(1)} delta={deltaPct(gsc.totals.position, gsc.previousTotals?.position)} lowerBetter />
                </View>
              </View>
            ) : null}
            {ga4 ? (
              <View wrap={false}>
                <Text style={s.groupLabel}>Website engagement · Google Analytics 4</Text>
                <View style={s.kpiRow}>
                  <KpiCard s={s} color={color} icon="users" label="Users" {...ga4Card("users", fmt)} />
                  <KpiCard s={s} color={color} icon="activity" label="Sessions" value={fmt(ga4.totals.sessions)} delta={deltaPct(ga4.totals.sessions, ga4.previousTotals?.sessions)} />
                  <KpiCard s={s} color={color} icon="zap" label="Engagement Rate" {...ga4Card("engagementRate", pct1)} />
                  <KpiCard s={s} color={color} icon="checkCircle" label="Conversions" {...ga4Card("conversions", fmt)} />
                </View>
              </View>
            ) : null}
            {ga4 && revenue != null ? (
              <View wrap={false}>
                <Text style={s.groupLabel}>Ecommerce & conversions</Text>
                <View style={s.kpiRow}>
                  <KpiCard s={s} color={color} icon="dollar" label="Total Revenue" value={fmt(revenue)} delta={deltaPct(revenue, ga4.previousTotals?.totalRevenue)} />
                  <KpiCard s={s} color={color} icon="percent" label="Conversion Rate" value={convRate != null ? pct1(convRate) : "—"} delta={convRate != null ? deltaPct(convRate, prevConvRate) : null} />
                  <KpiCard s={s} color={color} icon="userPlus" label="New Users" {...ga4Card("newUsers", fmt)} />
                  <KpiCard s={s} color={color} icon="file" label="Pageviews" value={fmt(ga4.totals.views)} delta={deltaPct(ga4.totals.views, ga4.previousTotals?.views)} />
                </View>
              </View>
            ) : null}
          </Section>
        ) : null}
    </>
  );

  // The summary section for a report with no executive-dashboard page — that
  // page is gated on a Google source, and a paid-media-only report was
  // therefore shipping with no written summary at all. Rendered at the top of
  // the first channel page instead, where it opens the document.
  const renderStandaloneSummary = () => (
    <>
    {verdict ? <VerdictPanel s={s} color={color} v={verdict} /> : null}
    <Section s={s} num={num()} title="Executive Summary" subtitle={`${fmtDate(period.start)} – ${fmtDate(period.end)}`}>
      <View style={s.summaryPanel}>
        <Text style={s.para}>{summaryText}</Text>
      </View>
    </Section>
    </>
  );

  return (
    <Document title={title} author={branding.name || "Agency"} subject={`Performance report for ${clientName}`} creator={branding.name || "Agency"}>
      <CoverPage s={s} color={color} branding={branding} logoSrc={logoSrc} clientLogoSrc={clientLogoSrc} badge={badge} title={title} clientName={clientName} period={period} generatedAt={generatedAt} />

      {/* ── Executive dashboard: the whole report in 30 seconds ── */}
      {(gsc || ga4) ? (
        <Page size="A4" style={s.page}>
          <PageChrome {...chrome} />
          {/* The thirty-second answer, above every numbered section. */}
          {verdict ? <VerdictPanel s={s} color={color} v={verdict} /> : null}
          <Section s={s} num={num()} title="Executive Dashboard" subtitle={`${fmtDate(period.start)} – ${fmtDate(period.end)}`}>
            {/* Score gauge + AI summary */}
            <View style={s.dashRow}>
              {score ? <GaugePanel s={s} color={color} data={score} /> : null}
              <View style={s.dashSummaryCard}>
                <Text style={s.dashSummaryTitle}>Executive Summary</Text>
                <Text style={s.dashSummaryText}>{summaryText}</Text>
              </View>
            </View>

            {/* Hero KPIs */}
            {heroRow.length > 0 ? (
              <View style={[s.dashRow, { marginBottom: dashTiles.length > 0 ? 12 : 0 }]} wrap={false}>
                {heroRow.map((k) => (
                  <KpiCard key={k.label} s={s} color={color} icon={k.icon} label={k.label} value={k.value} delta={k.delta} lowerBetter={k.lowerBetter} hero />
                ))}
              </View>
            ) : null}

            {/* Biggest movements — measured deltas, not a restatement of the
                summary. Previously these sat on a second page under a repeated
                copy of the same summary text. */}
            {highlights.length > 0 ? (
              <View style={{ marginBottom: dashTiles.length > 0 ? 12 : 0 }}>
                <Text style={s.groupLabel}>Biggest movements this period</Text>
                <HighlightChips s={s} items={highlights} />
              </View>
            ) : null}

            {/* Best channel / biggest opportunity / biggest risk */}
            {dashTiles.length > 0 ? (
              <View style={s.dashRow} wrap={false}>
                {channelTile ? <DashTile s={s} tone={tones.info} icon="compass" data={channelTile} /> : null}
                {opportunityTile ? <DashTile s={s} tone={{ fg: tint(color, 0.15), bg: tint(color, 0.9), border: color }} icon="bulb" data={opportunityTile} /> : null}
                {riskTile ? <DashTile s={s} tone={tones.warning} icon="alert" data={riskTile} /> : null}
              </View>
            ) : null}
          </Section>

          {/* "So what?" — what the measured movements mean and what to do.
              Sits on the opening page so the 60-second read is: score, summary,
              headline numbers, meaning, next steps. */}
          {soWhat.length > 0 ? (
            <Section s={s} num={num()} title="What this means" subtitle="What the figures above point to.">
              {soWhat.map((w) => (
                <View key={w.observation} style={s.soWhatRow} wrap={false}>
                  <Text style={s.soWhatObs}>{w.observation}</Text>
                  <Text style={s.soWhatMeaning}>{w.meaning}</Text>
                  <Text style={s.soWhatEvidence}>
                    {w.metric} · {w.source} · {w.confidence} confidence — {w.confidenceReason}
                  </Text>
                </View>
              ))}
            </Section>
          ) : null}

          {/* The overview joins the dashboard rather than opening a page of its
              own. It used to do so only for a thin report, which left a
              substantial one with a dashboard page that spilled two lines onto
              the next page and then began a fresh page for four KPI cards. The
              two belong together at any density — the dashboard states the
              headline figures and the overview breaks them out — and letting
              them flow means the break falls where the content runs out rather
              than where the template said. */}
          {renderOverview()}
          {mergeChannel ? (
            <ChannelSection s={s} color={color} palette={palette} block={orderedChannelBlocks[0] ?? channelBlocks[0]} sectionNum={num()} />
          ) : null}
        </Page>
      ) : null}

      {/* ── Detailed performance ── */}
      {hasDetails ? (
        <Page size="A4" style={s.page}>
          <PageChrome {...chrome} />

          {hasTrends ? (
            <Section s={s} num={num()} title="Performance Trends" subtitle="Daily movement across the reporting period.">
              <View style={s.chartRow}>
                {(gsc?.byDate?.length ?? 0) >= MIN_TREND_POINTS ? (
                  <View style={s.chartCol}>
                    <ChartCard s={s} title="Organic clicks" value={fmt(gsc!.totals.clicks)} hint={trendCaption("Organic clicks", gsc!.byDate.map((d) => d.clicks), "Google Search Console")}>
                      <LineChart id="clicks" values={gsc!.byDate.map((d) => d.clicks)} dates={gsc!.byDate.map((d) => d.date)} color={color} width={HALF_W - CARD_PAD} />
                    </ChartCard>
                  </View>
                ) : null}
                {(ga4?.byDate?.length ?? 0) >= MIN_TREND_POINTS ? (
                  <View style={s.chartCol}>
                    <ChartCard s={s} title="Sessions" value={fmt(ga4!.totals.sessions)} hint={trendCaption("Sessions", ga4!.byDate.map((d) => d.sessions), "Google Analytics 4")}>
                      <LineChart id="sessions" values={ga4!.byDate.map((d) => d.sessions)} dates={ga4!.byDate.map((d) => d.date)} color={palette[1]} width={HALF_W - CARD_PAD} />
                    </ChartCard>
                  </View>
                ) : null}
              </View>
              {(gsc?.byDate?.length ?? 0) > 1 ? (
                <View style={{ marginTop: 10 }}>
                  <ChartCard s={s} title="Average search position" value={gsc!.totals.position.toFixed(1)} hint="Lower is better, so an upward line means rankings improved.">
                    <LineChart id="position" values={gsc!.byDate.map((d) => d.position)} dates={gsc!.byDate.map((d) => d.date)} color={palette[2]} width={CONTENT_W - CARD_PAD} height={60} reversed />
                  </ChartCard>
                </View>
              ) : null}
            </Section>
          ) : null}

          {hasSearch ? (
            <Section s={s} num={num()} title="Search Performance" subtitle="What people searched to find the site, and how rankings moved.">
              {gsc!.topQueries.length > 0 ? (
                <View>
                  <Text style={s.h3}>Top queries by clicks</Text>
                  <DataTable s={s} cols={queryCols} rows={gsc!.topQueries.slice(0, 10)} />
                </View>
              ) : null}
              {(movers?.winners?.length ?? 0) > 0 || (movers?.decliners?.length ?? 0) > 0 ? (
                <View style={[s.twoCol, { marginTop: 12 }]} wrap={false}>
                  {(movers?.winners?.length ?? 0) > 0 ? (
                    <View style={s.col}>
                      <Text style={s.h3}>Winning keywords</Text>
                      <DataTable
                        s={s}
                        cols={[
                          { header: "Query", flex: 1, cell: (m) => m.key },
                          { header: "Clicks", width: 40, align: "right", strong: true, cell: (m) => fmt(m.clicks) },
                          { header: "Change", width: 46, align: "right", cell: (m) => deltaLabel(m.changePct) },
                        ] satisfies Col<NonNullable<typeof movers>["winners"][number]>[]}
                        rows={movers!.winners.slice(0, 5)}
                      />
                    </View>
                  ) : null}
                  {(movers?.decliners?.length ?? 0) > 0 ? (
                    <View style={s.col}>
                      <Text style={s.h3}>Declining keywords</Text>
                      <DataTable
                        s={s}
                        cols={[
                          { header: "Query", flex: 1, cell: (m) => m.key },
                          { header: "Clicks", width: 40, align: "right", strong: true, cell: (m) => fmt(m.clicks) },
                          { header: "Change", width: 46, align: "right", cell: (m) => deltaLabel(m.changePct) },
                        ] satisfies Col<NonNullable<typeof movers>["decliners"][number]>[]}
                        rows={movers!.decliners.slice(0, 5)}
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}
              {opportunities.length > 0 ? (
                <View style={{ marginTop: 12 }} wrap={false}>
                  <Text style={s.h3}>Ranking opportunities (just off page one)</Text>
                  <DataTable
                    s={s}
                    cols={[
                      { header: "Query", flex: 1, cell: (o) => o.key },
                      { header: "Impressions", width: 62, align: "right", cell: (o) => fmt(o.impressions) },
                      { header: "Position", width: 46, align: "right", strong: true, cell: (o) => o.position.toFixed(1) },
                    ] satisfies Col<(typeof opportunities)[number]>[]}
                    rows={opportunities.slice(0, 5)}
                  />
                </View>
              ) : null}
            </Section>
          ) : null}

          {hasTraffic ? (
            <Section s={s} num={num()} title="Traffic & Acquisition" subtitle="Where sessions came from and which pages received them.">
              {hasChannels ? (
                <View wrap={false}>
                  <Text style={s.h3}>Sessions by channel</Text>
                  <BarList s={s} color={color} rows={ga4!.trafficSources!.map((t) => ({ label: t.key, value: t.sessions }))} />
                </View>
              ) : null}
              {hasLandingPages ? (
                <View style={{ marginTop: 10 }}>
                  <Text style={s.h3}>Top landing pages</Text>
                  <DataTable
                    s={s}
                    cols={[
                      { header: "Page", flex: 1, cell: (p) => pagePathOf(p.key) },
                      { header: "Sessions", width: 56, align: "right", strong: true, cell: (p) => fmt(p.sessions) },
                      { header: "Users", width: 50, align: "right", cell: (p) => fmt(p.users) },
                    ] satisfies Col<{ key: string; sessions: number; users: number }>[]}
                    rows={ga4!.topLandingPages!.slice(0, 8)}
                  />
                </View>
              ) : null}
            </Section>
          ) : null}

          {hasAudience ? (
            <Section s={s} num={num()} title="Audience" subtitle="Devices and locations of the people visiting the site.">
              <View style={s.twoCol} wrap={false}>
                {hasDevices ? (
                  <View style={s.col}>
                    <Text style={s.h3}>Sessions by device</Text>
                    <ShareBar
                      s={s}
                      colors={palette}
                      segments={ga4!.devices!.slice(0, 4).map((d) => ({ label: d.key.charAt(0).toUpperCase() + d.key.slice(1), value: d.sessions }))}
                    />
                  </View>
                ) : null}
                {hasCountries ? (
                  <View style={s.col}>
                    <Text style={s.h3}>Top countries</Text>
                    <DataTable
                      s={s}
                      cols={[
                        { header: "Country", flex: 1, cell: (c) => c.key },
                        { header: "Sessions", width: 56, align: "right", strong: true, cell: (c) => fmt(c.sessions) },
                      ] satisfies Col<{ key: string; sessions: number; users: number }>[]}
                      rows={ga4!.countries!.slice(0, 6)}
                    />
                  </View>
                ) : null}
              </View>
            </Section>
          ) : null}
        </Page>
      ) : null}

      {/* ── Connected channels (every non-Google integration) ──
          Provider-agnostic: each block renders itself from its own labels,
          formats and currency, so new integrations need no change here. */}
      {channelPages.map((group, i) => (
        <Page key={blockKey(group[0])} size="A4" style={s.page}>
          <PageChrome {...chrome} />
          {i === 0 && summaryOnChannelPage ? renderStandaloneSummary() : null}
          {group.map((block) => (
            <ChannelSection key={blockKey(block)} s={s} color={color} palette={palette} block={block} sectionNum={num()} />
          ))}
        </Page>
      ))}

      {/* ── Insights & recommendations ── */}
      {hasInsights ? (
        <Page size="A4" style={s.page}>
          <PageChrome {...chrome} />

          {summaryOnInsightsPage ? renderStandaloneSummary() : null}

          {/* One "what stood out and what it means" section rather than three
              separate ones. Wins, risks, opportunities and the interpretation
              layer are the same act of reading for the client, and splitting
              them opened pages that each carried a heading and a card. */}
          {hasInsightCards || soWhatOffDashboard.length > 0 ? (
            <Section s={s} num={num()} title="What stood out, and what it means" subtitle="Highlights from the period, and what they point to.">
              {keyWins.length > 0 ? (
                <View style={{ marginBottom: 12 }}>
                  <Text style={s.groupLabel}>Key Wins</Text>
                  <InsightCards s={s} tone={tones.positive} icon="check" kind="Win" items={keyWins.map(toInsightCard)} />
                </View>
              ) : null}
              {issuesDetected.length > 0 ? (
                <View style={{ marginBottom: 12 }}>
                  <Text style={s.groupLabel}>Risks</Text>
                  <InsightCards s={s} tone={tones.warning} icon="alert" kind="Risk" items={issuesDetected.map(toInsightCard)} />
                </View>
              ) : null}
              {growthOpportunities.length > 0 ? (
                <View style={{ marginBottom: soWhatOffDashboard.length > 0 ? 12 : 0 }}>
                  <Text style={s.groupLabel}>Opportunities</Text>
                  <InsightCards s={s} tone={tones.info} icon="bulb" kind="Opportunity" items={growthOpportunities.map(toInsightCard)} />
                </View>
              ) : null}
              {soWhatOffDashboard.length > 0 ? (
                <View>
                  {hasInsightCards ? <Text style={s.groupLabel}>What this means</Text> : null}
                  {soWhatOffDashboard.map((w) => (
                    <View key={w.observation} style={s.soWhatRow} wrap={false}>
                      <Text style={s.soWhatObs}>{w.observation}</Text>
                      <Text style={s.soWhatMeaning}>{w.meaning}</Text>
                      <Text style={s.soWhatEvidence}>{w.metric} · {w.source} · {w.confidence} confidence — {w.confidenceReason}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </Section>
          ) : null}

          {/* Evidence-backed next steps, with the AI's remaining commentary
              beneath them in the same section rather than under a heading of its
              own. Priority comes from the confidence and weight of the signal
              behind each step, not from list position, and every step carries
              the measurement that prompted it. */}
          {evidenceActions.length > 0 || commentary.length > 0 || hasAnySource ? (
            <Section s={s} num={num()} title="Recommended actions" subtitle={evidenceActions.length > 0 ? "Each step below is prompted by a figure measured in this report." : "What this period's data does, and does not, support acting on."}>
              {/* Nothing measured cleared the bar. Said outright, because a
                  section that silently disappears reads as an omission. */}
              {evidenceActions.length === 0 ? (
                <Text style={s.para}>{NO_EVIDENCE_NOTE}</Text>
              ) : null}

              {evidenceActions.map((a) => (
                <View key={a.action} style={s.evActionRow} wrap={false}>
                  <Text style={[s.evActionPriority, a.priority === "High" ? { color: tones.warning.fg } : a.priority === "Medium" ? { color: color } : { color: ink[500] }]}>
                    {a.priority}
                  </Text>
                  <View style={s.evActionBody}>
                    <Text style={s.evActionText}>{a.action}</Text>
                    <Text style={s.evActionBecause}>Because: {a.because} ({a.source})</Text>
                  </View>
                </View>
              ))}

              {/* Only reached when cleaning left something that reads as
                  commentary. A section titled "Further commentary" whose whole
                  content was a numbering artefact shipped to a client once. */}
              {commentary.length > 0 ? (
                <View style={{ marginTop: evidenceActions.length > 0 ? 12 : 0 }}>
                  {/* The label and the first card are one unwrappable unit.
                      minPresenceAhead alone does not hold them together when the
                      card itself is unwrappable, which is how a heading came to
                      sit at the foot of one page with its only card on the next.
                      No priority or impact badge here either: the steps above
                      carry priorities derived from the confidence and weight of
                      a measurement, and there is nothing measured behind a badge
                      on free prose. */}
                  <View wrap={false}>
                    <Text style={s.groupLabel}>Further commentary</Text>
                    <ActionCard s={s} color={color} index={0} card={toInsightCard(commentary[0])} />
                  </View>
                  {commentary.slice(1, 4).map((a, i) => (
                    <ActionCard key={i} s={s} color={color} index={i + 1} card={toInsightCard(a)} />
                  ))}
                </View>
              ) : null}
            </Section>
          ) : null}

          {/* Stated plainly rather than buried: what this period does and
              doesn't cover, and which figures could not be produced for it. */}
          {coverageLines.length > 0 ? (
            <View style={s.coverageNote} wrap={false}>
              <Text style={s.coverageTitle}>About the data in this report</Text>
              {coverageLines.map((line) => (
                <Text key={line} style={s.coverageText}>· {line}</Text>
              ))}
            </View>
          ) : null}

          {/* The agency's own note, only when they wrote one. A truthy check
              let a field left at whitespace open an empty "Notes" section. */}
          {note ? (
            <Section s={s} num={num()} title="Notes">
              <Bullets s={s} items={[note]} />
            </Section>
          ) : null}
        </Page>
      ) : null}

      {/* ── Forecast & outlook (only when enough historical data exists) ── */}
      {forecast ? (
        <Page size="A4" style={s.page}>
          <PageChrome {...chrome} />
          <Section s={s} num={num()} title="Forecast & Outlook" subtitle={`Projected performance for the next ${forecast.days} days, based on the current trend.`}>
            <View style={{ marginBottom: 12 }}>
              <Text style={[s.confidenceBadge, forecast.confidence === "High" ? { backgroundColor: tones.positive.bg, color: tones.positive.fg } : forecast.confidence === "Moderate" ? { backgroundColor: tones.info.bg, color: tones.info.fg } : { backgroundColor: ink.bgSoft, color: ink[500] }]}>
                {forecast.confidence} confidence
              </Text>
            </View>
            <View style={s.forecastGrid}>
              {forecast.items.map((it) => {
                const good = it.growthPct >= 0;
                return (
                  <View key={it.label} style={s.forecastCard} wrap={false}>
                    <View style={s.kpiTop}>
                      <View style={s.kpiIconBox}><Icon name={it.icon} size={9} color={color} strokeWidth={2.2} /></View>
                      <Text style={s.kpiLabel}>{it.label}</Text>
                    </View>
                    <Text style={s.forecastProj}>{fmt(it.projected)}</Text>
                    <View style={s.kpiDeltaRow}>
                      <TrendArrow dir={good ? "up" : "down"} color={good ? up : down} size={5.5} />
                      <Text style={[s.kpiDelta, good ? s.up : s.down]}>{deltaLabel(it.growthPct)}</Text>
                    </View>
                    <Text style={s.forecastCur}>Current: {fmt(it.current)}</Text>
                  </View>
                );
              })}
            </View>
            <View style={s.summaryPanel}>
              <Text style={s.para}>{forecast.narrative}</Text>
            </View>
          </Section>
        </Page>
      ) : null}
    </Document>
  );
}

// ── Logo prefetch ────────────────────────────────────────────────────────────
// react-pdf's <Image> can fetch remote URLs itself, but a slow or broken logo
// URL would then fail the whole render. Fetch it up front with a short timeout
// and an SSRF guard, and fall back to the monogram on any problem. PNG/JPEG
// only — the PDF engine doesn't decode SVG or WebP.
const EMBEDDABLE = new Set(["image/png", "image/jpeg", "image/jpg"]);

async function fetchLogoDataUri(url: string | null | undefined): Promise<string | null> {
  if (!url) return null;
  // Already inlined: apply the same media-type and size rules, then use it as
  // is. Fetching is a means to an embeddable image, not the point of this.
  const inline = /^data:([^;,]+)(;base64)?,/i.exec(url);
  if (inline) {
    const type = inline[1].trim().toLowerCase();
    if (!EMBEDDABLE.has(type)) return null;
    return url.length > 2_800_000 ? null : url;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    // SSRF-safe: IP-pinned at connect time + per-hop redirect validation.
    const res = await safeFetch(url, { timeoutMs: 3500 });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!EMBEDDABLE.has(ct)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 2_000_000) return null;
    return `data:${ct === "image/jpg" ? "image/jpeg" : ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// Renders the report to a PDF buffer (for download or email attachment).
export async function renderReportPdf(args: {
  data: unknown;
  branding: Branding;
  clientName: string;
  /** The client's own logo, scoped to this report by the branding loader. */
  clientLogoUrl?: string | null;
  title: string;
  period: { start: string; end: string };
  generatedAt?: string;
}): Promise<Buffer> {
  const generatedAt = args.generatedAt ?? new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  // Resolved independently: a client whose logo is missing or unreachable
  // still gets the agency's, and neither can ever stand in for the other.
  const [logoSrc, clientLogoSrc] = await Promise.all([
    fetchLogoDataUri(args.branding.logo_url),
    fetchLogoDataUri(args.clientLogoUrl),
  ]);
  return renderToBuffer(
    <ReportPdfDoc {...args} logoSrc={logoSrc} clientLogoSrc={clientLogoSrc} generatedAt={generatedAt} />,
  );
}
