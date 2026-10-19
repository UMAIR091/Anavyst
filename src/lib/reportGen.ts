// Report generation core, extracted so both the manual "Generate report" route
// and the scheduled-delivery cron can create reports the same way. Builds a
// unified GSC + GA4 report purely from cached snapshots — no live Google calls.
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateReportInsightsCached } from "@/lib/ai";
import { trackUsage, reserveReportGeneration, releaseReportGeneration } from "@/lib/usage";
import { checkReportLimit } from "@/lib/billing/limits";
import { featuresForPlan } from "@/lib/billing/config";
import { ARCHIVED_CLIENT_ERROR } from "@/lib/archivedClients";
import type { GscReportFull, Ga4ReportFull } from "@/lib/google";
import { snapshotToBlock, orderBlocks, type ReportBlock } from "@/lib/integrations/blocks";
import { resolvePeriod, isPeriodPreset, previousWindow, dayCount, type PeriodPreset, type ResolveResult } from "@/lib/reports/periods";
import { deriveGsc, deriveGa4, deriveBlock, seriesCoverage, covers, distinctDaysWithin, MIN_PERIOD_COVERAGE, archiveToGscByDate, archiveToGa4ByDate, archiveRowsToSeries, mergeByDate, mergeSeries, comparisonWindows, type Unavailable } from "@/lib/reports/derive";
import { assessSnapshotSource, assessDerivedSource, dominantWindow, sourceNotes, type ReportSourceStatus } from "@/lib/reports/dataQuality";
import { fetchHistory, extractDailySeries } from "@/lib/metrics/history";
import { inferReportType, isReportType, suggestReportTitle, type ReportType } from "@/lib/reports/types";
import { hasCalculableKpis } from "@/lib/reports/summary";
import { assembleReport, isGscEmpty, isGa4Empty, isReportEmpty, dataCoverage, periodLabel, insightsPeriodPhrase, toInsightsInput, type ReportData } from "@/lib/report";
import { getIntegration } from "@/lib/integrations/registry";

// The account a source reports on, by name, to tell two accounts of one
// platform apart in a report.
function accountLabel(type: string, config: unknown): string {
  const def = getIntegration(type);
  const cfg = (config ?? {}) as Record<string, unknown>;
  const id = def?.readSelected?.(cfg) ?? null;
  return (id && def?.readAccounts?.(cfg).find((a) => a.id === id)?.name) || id || "account";
}

/**
 * Bridges the legacy `periodDays` argument and the period presets.
 *
 * Backward compatibility is deliberate: every existing caller passes 28 or 90
 * (or nothing), and each maps onto the identical rolling window it produced
 * before, reading the same cached snapshot. Only a `period` preset opts into
 * the new calendar/custom behaviour.
 */
function resolveRequestedPeriod(opts: {
  periodDays?: number;
  period?: string;
  customStart?: string | null;
  customEnd?: string | null;
  now?: number;
}): ResolveResult {
  if (opts.period) {
    if (!isPeriodPreset(opts.period)) {
      return { ok: false, error: `Unknown reporting period "${opts.period}".` };
    }
    return resolvePeriod({
      preset: opts.period,
      customStart: opts.customStart,
      customEnd: opts.customEnd,
      now: opts.now,
    });
  }
  const preset: PeriodPreset = opts.periodDays === 90 ? "last_90" : "last_28";
  return resolvePeriod({ preset, now: opts.now });
}

export type CreateReportResult =
  | { ok: true; id: string; shareToken: string; title: string; data: ReportData; period: { start: string; end: string } }
  | { ok: false; status: number; error: string };

// Creates and stores one report for a client. `supabase` may be a user client
// (RLS-scoped) or the admin client (cron) — queries are scoped by agency/client
// explicitly so both are safe.
export async function createClientReport(
  supabase: SupabaseClient,
  agencyId: string,
  clientId: string,
  opts: {
    templateKey?: string;
    /** Legacy 28/90 selector — still honoured for existing callers. */
    periodDays?: number;
    /** Preferred: a period preset, with custom bounds when preset is "custom". */
    period?: string;
    customStart?: string | null;
    customEnd?: string | null;
    title?: string;
    reportType?: string;
    now?: number;
  } = {}
): Promise<CreateReportResult> {
  const templateKey = opts.templateKey || "seo";

  // ── Resolve the window before touching any data ──────────────────────────
  // `periodDays` remains supported so existing callers (and the 28/90 presets)
  // behave exactly as before. A `period` preset takes precedence.
  const resolved = resolveRequestedPeriod(opts);
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };
  let period = resolved.period;

  // Which cached snapshot to read. A window of 28 rolling days matches the
  // 28-day snapshot exactly and is served at full fidelity; anything else is
  // rebuilt from the 90-day daily series.
  const snapshotDays = period.preset === "last_28" ? 28 : 90;
  const derived = period.preset !== "last_28" && period.preset !== "last_90";

  const { data: client } = await supabase
    .from("clients").select("id, name, archived").eq("id", clientId).eq("agency_id", agencyId).maybeSingle();
  if (!client) return { ok: false, status: 404, error: "Client not found" };
  // Archived clients are paused: no new reports until a restore, which
  // re-checks the plan's client limit (lib/archivedClients.ts).
  if (client.archived !== false) return { ok: false, status: 409, error: ARCHIVED_CLIENT_ERROR };

  // Report cap (only the trial sets one — paid plans return allowed immediately).
  const reportLimit = await checkReportLimit(supabase, agencyId);
  if (!reportLimit.allowed) return { ok: false, status: 402, error: reportLimit.reason ?? "Report limit reached." };

  // Load EVERY connected source, not just the Google pair. Search Console and
  // GA4 keep their own snapshot tables and bespoke rich sections; every other
  // integration is read from integration_snapshots and projected into neutral
  // blocks, so adding an integration needs no change here.
  // Filtered by agency as well as client. The client lookup above already
  // refuses a client from another agency, but the cron runs this with the
  // service role, where RLS isn't there to catch a mismatched pair.
  const { data: sources } = await supabase
    .from("data_sources").select("id, type, config, status").eq("client_id", clientId).eq("agency_id", agencyId);
  const gscDs = sources?.find((s) => s.type === "gsc");
  const ga4Ds = sources?.find((s) => s.type === "ga4");
  const gscReady = Boolean((gscDs?.config as { site_url?: string } | undefined)?.site_url);
  const ga4Ready = Boolean((ga4Ds?.config as { property_id?: string } | undefined)?.property_id);
  const otherSources = (sources ?? []).filter((s) => s.type !== "gsc" && s.type !== "ga4");

  if (!gscReady && !ga4Ready && otherSources.length === 0) {
    return { ok: false, status: 400, error: "Connect at least one data source for this client first." };
  }

  // Each snapshot is read with its sync time: whether it may describe this
  // period at all is decided from when its data ends (lib/reports/dataQuality).
  type SnapRow = { data: unknown; synced_at: string | null };
  let gscData: GscReportFull | null = null;
  let gscSnap: SnapRow | null = null;
  if (gscReady && gscDs) {
    const { data: snap } = await supabase
      .from("gsc_snapshots").select("data, synced_at").eq("data_source_id", gscDs.id).eq("period_days", snapshotDays).maybeSingle();
    gscSnap = (snap as SnapRow | null) ?? null;
    const s = (snap?.data as GscReportFull | undefined) ?? null;
    gscData = isGscEmpty(s) ? null : s;
  }

  let ga4Data: Ga4ReportFull | null = null;
  let ga4Snap: SnapRow | null = null;
  if (ga4Ready && ga4Ds) {
    const { data: snap } = await supabase
      .from("ga4_snapshots").select("data, synced_at").eq("data_source_id", ga4Ds.id).eq("period_days", snapshotDays).maybeSingle();
    ga4Snap = (snap as SnapRow | null) ?? null;
    const s = (snap?.data as Ga4ReportFull | undefined) ?? null;
    ga4Data = isGa4Empty(s) ? null : s;
  }

  // Every non-Google source, projected into blocks. One query for all of them.
  // Each block stays paired with the data source it came from, so its archive
  // history is looked up by that source rather than by platform: two accounts
  // on one platform must never share a series.
  // A client can have two accounts of one platform (migration 0049). Their
  // blocks are then told apart (instanceId) and named by account; with one
  // account per platform nothing about a block changes.
  type Channel = {
    dsId: string; type: string; status: string | null; syncedAt: string | null; snapshot: unknown;
    block: ReportBlock | null; label: string | null;
  };
  let channels: Channel[] = [];
  if (otherSources.length) {
    const { data: snaps } = await supabase
      .from("integration_snapshots")
      .select("data_source_id, data, synced_at")
      .in("data_source_id", otherSources.map((s) => s.id))
      .eq("period_days", snapshotDays);
    const byId = new Map((snaps ?? []).map((r) => [r.data_source_id as string, r as SnapRow]));
    const perType = new Map<string, number>();
    for (const s of otherSources) perType.set(s.type as string, (perType.get(s.type as string) ?? 0) + 1);
    channels = otherSources.map((src) => {
      const row = byId.get(src.id as string);
      const projected = snapshotToBlock(src.type as string, row?.data);
      const label = (perType.get(src.type as string) ?? 0) > 1 ? accountLabel(src.type as string, src.config) : null;
      const block = projected && label
        ? { ...projected, instanceId: src.id as string, sourceName: `${projected.sourceName} · ${label}` }
        : projected;
      return {
        dsId: src.id as string,
        type: src.type as string,
        status: (src.status as string | null | undefined) ?? null,
        syncedAt: row?.synced_at ?? null,
        snapshot: row?.data ?? null,
        block: block && (block.kpis.length > 0 || block.tables.length > 0) ? block : null,
        label,
      };
    });
  }
  // Source notes ("Meta Ads is not included …") name the account too.
  const named = <T extends { name: string }>(st: T, label: string | null): T =>
    label ? { ...st, name: `${st.name} · ${label}` } : st;
  const blocksOf = (list: Channel[]) => orderBlocks(list.map((c) => c.block).filter((b): b is ReportBlock => b !== null));
  let blocks = blocksOf(channels);

  if (isReportEmpty({ gsc: gscData, ga4: ga4Data, blocks })) {
    return { ok: false, status: 400, error: "No analytics data is available yet. Click “Refresh now” on the client's data source, then generate the report." };
  }

  // What each source contributes, and why any is left out. Rendered on the
  // report and the PDF and handed to the AI, so a missing channel is never
  // read as a channel with zero results.
  const sourceStatus: ReportSourceStatus[] = [];

  // ── A cached rolling snapshot stands in for the period only while fresh ──
  // The snapshot path used to load every source whatever its state, so a
  // connection revoked in August kept contributing its August figures to an
  // October "Last 28 days". A snapshot whose data ends more than a few days
  // before the period does is excluded and named instead.
  if (!derived) {
    const judge = (type: string, connection: string | null, snap: SnapRow | null | undefined, hasData: boolean, label: string | null = null) => {
      const st = named(
        assessSnapshotSource({ type, connection, syncedAt: snap?.synced_at, snapshot: snap?.data, periodDays: snapshotDays, period }),
        label
      );
      if (st.included && !hasData) Object.assign(st, { included: false, state: "no_data", window: null });
      sourceStatus.push(st);
      return st.included;
    };
    if (gscReady && gscDs && !judge("gsc", (gscDs.status as string | null) ?? null, gscSnap, !!gscData)) gscData = null;
    if (ga4Ready && ga4Ds && !judge("ga4", (ga4Ds.status as string | null) ?? null, ga4Snap, !!ga4Data)) ga4Data = null;
    channels = channels.filter((c) =>
      judge(c.type, c.status, c.snapshot ? { data: c.snapshot, synced_at: c.syncedAt } : null, !!c.block, c.label)
    );
    blocks = blocksOf(channels);

    if (isReportEmpty({ gsc: gscData, ga4: ga4Data, blocks })) {
      return {
        ok: false,
        status: 400,
        error: `None of this client's sources has current data for ${period.start} to ${period.end}. ${sourceNotes(sourceStatus, period).join(" ")}`.trim(),
      };
    }

    // The stated period is the window the figures actually cover. "Last 28
    // days" was dated from the clock (ending two days back) while ad
    // platforms' snapshots end yesterday and Search Console's three days back,
    // so the cover named dates no source had measured exactly. It now names
    // the window most sources share, and sourceNotes names any that differ.
    const actual = dominantWindow(sourceStatus);
    if (actual) period = { ...period, start: actual.start, end: actual.end, days: dayCount(actual.start, actual.end) };
  }

  // ── Rebuild the requested window from the cached daily series ─────────────
  // Only for windows that don't match a cached snapshot.
  //
  // This used to demand that the stored series span the window COMPLETELY, and
  // refuse otherwise. That was stricter than the data warranted: the derive
  // functions below already clip to `inWindow`, so they cannot produce another
  // period's numbers however short the series is, and the report already
  // carries `requested` vs `coverage` — rendered on the web report and in the
  // PDF as "Data is available for N of the M days in this period". A quiet ad
  // account or a provider that reports nothing for a day or two is ordinary,
  // and it was refusing whole reports over it.
  //
  // So the window is now allowed through when a MAJORITY of its days have data,
  // and the shortfall is disclosed rather than hidden. Below that the original
  // refusal stands: at some point the headline totals stop describing the
  // period they are named after, which is what the guard was really for.
  const unavailable: Unavailable[] = [];
  if (derived) {
    // The comparison window is part of what has to be rebuilt: a calendar or
    // custom period gets a period-over-period change wherever the daily
    // history reaches back over it (comparisonWindows below).
    const prev = previousWindow(period, opts.now);
    const need = { start: prev.start, end: period.end };
    const gscDates = () => (gscData?.byDate ?? []).map((d) => d.date);
    const ga4Dates = () => (ga4Data?.byDate ?? []).map((d) => d.date);
    const blockDates = (b: ReportBlock) => b.series.flatMap((sr) => sr.points.map((p) => p.date));

    // Outside the rolling 90-day cache — a previous quarter almost always is —
    // the durable metric_daily archive every sync writes to fills the gap. No
    // provider call is made either way. Only the archive of THESE sources is
    // read: the client's whole archive used to be fetched and grouped by
    // platform, so a replaced or disconnected source's days were added to the
    // current one's.
    // Daily rows straight from each channel's snapshot, zeros included. The
    // projected block keeps a series only if it moved (an all-zero line is not
    // a chart), so rebuilding from it turned an account that genuinely spent
    // nothing into one with "no stored data" — a zero result reported as
    // missing data.
    channels = channels.map((c) =>
      c.block
        ? {
            ...c,
            block: {
              ...c.block,
              series: mergeSeries(
                c.block.series,
                archiveRowsToSeries(extractDailySeries(c.snapshot).map((p) => ({ date: p.date, provider: c.type, metrics: p.metrics })))
              ),
            },
          }
        : c
    );
    blocks = blocksOf(channels);
    const withData = channels.filter((c) => c.block);
    const ids = [
      ...(gscData && gscDs ? [gscDs.id as string] : []),
      ...(ga4Data && ga4Ds ? [ga4Ds.id as string] : []),
      ...withData.map((c) => c.dsId),
    ];
    const short = [
      ...(gscData ? [gscDates()] : []),
      ...(ga4Data ? [ga4Dates()] : []),
      ...withData.map((c) => blockDates(c.block!)),
    ].some((dates) => !covers(seriesCoverage(dates), need));
    if (short && ids.length) {
      const history = await fetchHistory(supabase, {
        agencyId, clientId, from: need.start, to: need.end, dataSourceIds: ids,
      }).catch(() => [] as Awaited<ReturnType<typeof fetchHistory>>);
      const rowsFor = (id: string) => history.filter((r) => r.data_source_id === id);

      // Archive rows first, the snapshot's own rows on top: the snapshot is the
      // newest read of any day both hold, and merging by date means a day
      // present in both is counted once.
      if (gscData && gscDs) gscData = { ...gscData, byDate: mergeByDate(archiveToGscByDate(rowsFor(gscDs.id as string)), gscData.byDate) };
      if (ga4Data && ga4Ds) ga4Data = { ...ga4Data, byDate: mergeByDate(archiveToGa4ByDate(rowsFor(ga4Ds.id as string)), ga4Data.byDate) };
      channels = channels.map((c) =>
        c.block ? { ...c, block: { ...c.block, series: mergeSeries(archiveRowsToSeries(rowsFor(c.dsId)), c.block.series) } } : c
      );
      blocks = blocksOf(channels);
    }

    const allDates = [...gscDates(), ...ga4Dates(), ...blocks.flatMap(blockDates)];
    const cached = seriesCoverage(allDates);
    // Distinct days, not rows: several sources each reporting the same date
    // cover one day between them, and counting rows would let three sources
    // with a third of the window each look like full coverage.
    const coveredDays = distinctDaysWithin(allDates, period);

    // Below the materiality bar — including zero days in the window — the
    // original refusal stands, unchanged.
    //
    // Zero deliberately refuses HERE rather than falling through to the
    // isReportEmpty path: that check runs before this block, against the
    // snapshot's own unclipped series, so a client with 30 days of August data
    // asking for Q2 sails past it and would end up storing an empty report.
    // Its message ("click Refresh now") would also be wrong — the data isn't
    // missing, the window is.
    if (coveredDays < Math.ceil(period.days * MIN_PERIOD_COVERAGE)) {
      return {
        ok: false,
        status: 400,
        error:
          `This report covers ${period.start} to ${period.end}, but stored history for this client only runs ` +
          `${cached ? `from ${cached.start} to ${cached.end}` : "for no days yet"}. ` +
          `Daily history builds up from the day a source is connected — choose a period inside that range.`,
      };
    }

    // Per source: may it describe this period, and over which days can it be
    // compared with the one before?
    if (gscReady && gscDs) {
      const dates = gscDates();
      const st = assessDerivedSource({ type: "gsc", connection: (gscDs.status as string | null) ?? null, syncedAt: gscSnap?.synced_at, dates, period });
      sourceStatus.push(st);
      const g = st.included ? deriveGsc(gscData, period, comparisonWindows(dates, period, prev)) : { data: null, unavailable: [] };
      gscData = g.data;
      unavailable.push(...g.unavailable);
    }
    if (ga4Ready && ga4Ds) {
      const dates = ga4Dates();
      const st = assessDerivedSource({ type: "ga4", connection: (ga4Ds.status as string | null) ?? null, syncedAt: ga4Snap?.synced_at, dates, period });
      sourceStatus.push(st);
      const a = st.included ? deriveGa4(ga4Data, period, comparisonWindows(dates, period, prev)) : { data: null, unavailable: [] };
      ga4Data = a.data;
      unavailable.push(...a.unavailable);
    }

    const rebuilt: ReportBlock[] = [];
    for (const c of channels) {
      const dates = c.block ? blockDates(c.block) : [];
      const st = named(assessDerivedSource({ type: c.type, connection: c.status, syncedAt: c.syncedAt, dates, period }), c.label);
      sourceStatus.push(st);
      if (!st.included || !c.block) continue;
      const r = deriveBlock(c.block, period, comparisonWindows(dates, period, prev));
      if (r.data) rebuilt.push(r.data);
      unavailable.push(...r.unavailable);
    }
    blocks = orderBlocks(rebuilt);

    if (isReportEmpty({ gsc: gscData, ga4: ga4Data, blocks })) {
      return {
        ok: false,
        status: 400,
        error: `No data was recorded between ${period.start} and ${period.end}. Choose a different period.`,
      };
    }
  }

  const { data: template } = await supabase
    .from("report_templates").select("name, sections").eq("key", templateKey).is("agency_id", null).maybeSingle();

  // ── One canonical window, from here to the stored row, the PDF and the UI ──
  // The period is what the user asked for. `coverage` records how much real
  // data landed inside it, so a partially-covered report can say so instead of
  // silently relabelling itself as a shorter period.
  // Coverage describes how much of THIS period the data spans, so it is clamped
  // to the window. Providers settle on different lags (GA4 and most channels
  // report through yesterday, Search Console two days back), which previously
  // let coverage run a day past the period end and read as though the report
  // covered dates outside its own stated range.
  //
  // Measured from each included source's own window where it is known. The
  // charted series used to stand in for it, and an all-zero line is never
  // charted, so an ad account that reported every day at zero spend read as
  // "no day-by-day data was returned" — a zero result described as missing.
  const knownWindows = sourceStatus.filter((st) => st.included && st.window).map((st) => st.window!);
  const rawCoverage = knownWindows.length
    ? {
        start: knownWindows.map((w) => w.start).sort()[0],
        end: knownWindows.map((w) => w.end).sort()[knownWindows.length - 1],
      }
    : dataCoverage({ gsc: gscData, ga4: ga4Data, blocks });
  const coverage = rawCoverage
    ? {
        start: rawCoverage.start < period.start ? period.start : rawCoverage.start,
        end: rawCoverage.end > period.end ? period.end : rawCoverage.end,
      }
    : null;

  // Only sources that actually contributed data describe the report. A
  // connected-but-empty source shouldn't make an SEO report look cross-channel.
  //
  // gscData and ga4Data are already nulled when empty. A block reaches here
  // whenever it carries any KPI at all, and a KPI can be present but null — a
  // channel that returned nothing still projects its ratio metrics as "not
  // calculable". A block like that contributed no figure, so it names nothing.
  const blockContributed = (b: ReportBlock) =>
    hasCalculableKpis(b.kpis) || b.tables.some((tbl) => tbl.rows.length > 0);
  // Platforms, once each, however many accounts of one contributed.
  const contributing = [
    ...new Set([
      ...(gscData ? ["gsc"] : []),
      ...(ga4Data ? ["ga4"] : []),
      ...blocks.filter(blockContributed).map((b) => b.sourceId).filter((id): id is string => Boolean(id)),
    ]),
  ];
  const reportType = isReportType(opts.reportType) ? opts.reportType : inferReportType(contributing);
  const meta = {
    periodDays: period.days,
    requested: { start: period.start, end: period.end },
    coverage,
    reportType,
    sourceIds: contributing,
    // What the period system resolved, and what could not be rebuilt for it.
    periodPreset: period.preset,
    periodKind: period.kind,
    periodLabel: period.label,
    periodInProgress: period.inProgress,
    unavailable: unavailable.length ? unavailable : undefined,
    sources: sourceStatus.length ? sourceStatus : undefined,
  };

  // ── The report is produced from here on, so this is where it is counted ──
  // Everything above only reads. The plan's report allowance is taken now,
  // atomically (reserve_report_generation, migration 0040): the agency is
  // locked, its generations counted, and the counter bumped only if there is
  // room, so two requests racing for the last slot can't both get it. The count
  // lives in usage_counters, which tenants can't write and which deleting a
  // saved report never touches. checkReportLimit above only spares loading data
  // for a request that is plainly over the limit.
  const reservation = await reserveReportGeneration(agencyId, {
    limit: reportLimit.limit ?? null,
    lifetime: reportLimit.plan !== "free",
  });
  if (!reservation.ok) {
    if (reservation.reason === "unavailable") {
      return { ok: false, status: 503, error: "Couldn't check your report allowance. Please try again in a moment." };
    }
    const latest = await checkReportLimit(supabase, agencyId);
    return { ok: false, status: 402, error: latest.reason ?? "Report limit reached." };
  }

  const unified = assembleReport(gscData, ga4Data, null, blocks, meta);
  // AI insights are a paid capability. The report still generates on the Free
  // plan — charts, tables and totals — it just carries no written analysis, and
  // the model is never called, so it costs nothing to serve.
  const aiAllowed = featuresForPlan(reportLimit.plan).aiInsights;
  // The AI is told the real window, not a generic "last N days" phrase, so its
  // prose can't describe a period the report doesn't cover.
  const { insights, cached } = aiAllowed
    ? await generateReportInsightsCached(
        toInsightsInput(
          unified,
          client.name,
          insightsPeriodPhrase({ label: period.label, start: period.start, end: period.end, days: period.days })
        )
      )
    : { insights: null, cached: false };
  // Meter AI usage only when the model actually ran (a cache hit costs nothing).
  if (insights && !cached) await trackUsage(agencyId, "ai_summaries");
  // Attach the insights to the report already built above rather than composing
  // the whole thing a second time. `assembleReport`'s insightsHash is computed
  // from { gsc, ga4, blocks } only — it does not depend on `insights` — so this
  // is the identical object, including key order, for one less full re-hash of
  // the payload per generation.
  const data: ReportData = { ...unified, insights };

  // Title: the user's own if they edited one, otherwise a suggestion built from
  // the client, the inferred type and the window. The old default came from the
  // template row, which is why a Meta-Ads-only client received an "SEO Report".
  const label = periodLabel(period.start, period.end);
  const suggested = suggestReportTitle({ clientName: client.name, type: reportType, periodLabel: label });
  const title = opts.title?.trim() ? opts.title.trim().slice(0, 200) : suggested;
  const shareToken = crypto.randomBytes(16).toString("hex");

  // Written by the server, never through the caller's own session. A report
  // row is what the plan allowance counts, so it is created only here, after
  // reserve_report_generation succeeded; migration 0044 takes INSERT/UPDATE on
  // reports away from tenants so a browser session can't write one directly.
  // agencyId is the caller's verified workspace and the client lookup above
  // already refused a client from any other.
  const { data: report, error } = await createAdminClient()
    .from("reports")
    .insert({
      agency_id: agencyId,
      client_id: clientId,
      template_key: templateKey,
      title,
      status: "ready",
      period_start: period.start,
      period_end: period.end,
      data,
      sections: template?.sections ?? [],
      share_token: shareToken,
    })
    .select("id, share_token")
    .single();
  if (error) {
    // Nothing was stored, so nothing was generated: give the allowance back.
    // Once a report is stored its generation stays counted, whatever later
    // happens to the report.
    await releaseReportGeneration(agencyId, reservation.periodMonth);
    return { ok: false, status: 400, error: error.message };
  }

  return { ok: true, id: report.id, shareToken: report.share_token, title, data, period };
}
