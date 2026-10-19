import Link from "next/link";
import { redirect } from "next/navigation";
import { format } from "date-fns";
import { Plus } from "lucide-react";
import { getCurrentUserAndAgency } from "@/lib/agency";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { OnboardingChecklist, type OnboardingStep } from "@/components/OnboardingChecklist";
import { WelcomeBack, type WelcomeBackData } from "@/components/WelcomeBack";
import { StatRow, type StatTileData } from "@/components/dashboard/StatTile";
import { NeedsAttention, type AttentionItem } from "@/components/dashboard/NeedsAttention";
import { ActivityTimeline } from "@/components/dashboard/ActivityTimeline";
import { UpNext } from "@/components/dashboard/NextScheduled";
import { AiPanel } from "@/components/dashboard/AiPanel";
import {
  SearchPerformance, HomeClients, SampleReportCard, BrandingCard, type HomeClientRow,
} from "@/components/dashboard/HomeCards";
import { NewReportButton } from "@/components/GenerateReportDialog";
import { detectSignals, forClient, type Signal } from "@/lib/insights/signals";
import { latestInsightsPerClient, siteLabel, INSIGHT_REPORT_SELECT, type InsightReportRow } from "@/lib/dashboard/aiInsights";
import { getSubscriptionState } from "@/lib/billing/subscription";
import { featuresForPlan } from "@/lib/billing/config";
import type { GscReportFull } from "@/lib/google";
import { buildActivity } from "@/lib/dashboard/activity";
import { getIntegrationName } from "@/lib/integrations/names";
import { getIntegrationHealthCached, summarize } from "@/lib/integrationHealth";
import { clientStatusMap, statusFor, CLIENT_STATUS_PRIORITY } from "@/lib/dashboard/clientStatus";

export const dynamic = "force-dynamic";

type ClientWithSources = { id: string; name: string; logo_url: string | null; created_at: string; data_sources: { type: string; created_at: string }[] | null };
type Day = { date: string; clicks: number; impressions: number; ctr: number; position: number };
type JoinedName = { name: string | null } | { name: string | null }[] | null;
type JoinedClient = { name: string | null; archived?: boolean | null } | { name: string | null; archived?: boolean | null }[] | null;

const fmt = (n: number) => Math.round(n).toLocaleString();
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const nameOf = (c: JoinedName) => (Array.isArray(c) ? c[0]?.name : c?.name) ?? "Client";

// Today's date and a time-of-day greeting in the agency's own time zone (set at
// onboarding), falling back to UTC when none is set or it isn't valid.
function localNow(timeZone: string | null): { date: string; hour: number } {
  const now = new Date();
  for (const tz of [timeZone, "UTC"]) {
    if (!tz) continue;
    try {
      const date = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz }).format(now);
      const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
      return { date, hour };
    } catch {
      // invalid zone: try the next one
    }
  }
  return { date: format(now, "EEEE d MMMM"), hour: now.getUTCHours() };
}

const greetingFor = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

const firstName = (meta: Record<string, unknown> | undefined): string | null => {
  const full = (meta?.full_name ?? meta?.name) as string | undefined;
  const first = full?.trim().split(/\s+/)[0];
  return first || null;
};

// Period-over-period change: first half vs second half of the daily series.
function trend(vals: number[], lowerIsBetter = false): { pct: number | null; good: boolean } {
  const h = Math.floor(vals.length / 2);
  if (h === 0) return { pct: null, good: true };
  const a = avg(vals.slice(0, h));
  if (!a) return { pct: null, good: true };
  const pct = ((avg(vals.slice(h)) - a) / a) * 100;
  return { pct, good: lowerIsBetter ? pct < 0 : pct > 0 };
}

export default async function DashboardPage() {
  const { user, agency } = await getCurrentUserAndAgency();
  if (!user || !agency) redirect("/login");

  const supabase = createClient();

  // Start of the current calendar month, for the "reports this month" stat.
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [
    { count: clientCount, data: activeClientRows }, { count: reportCount }, { count: reportsThisMonth }, { count: scheduleCount },
    { data: clientsRaw }, { data: snaps }, { data: gscSources }, { data: allSources },
    { data: reportsRaw }, { data: schedulesRaw }, { data: emailsRaw },
    { data: insightReportsRaw }, subState,
  ] = await Promise.all([
    // Ids too, so "still need a data source" can be checked per client.
    supabase.from("clients").select("id, name", { count: "exact" }).eq("archived", false),
    supabase.from("reports").select("id", { count: "exact", head: true }),
    supabase.from("reports").select("id", { count: "exact", head: true }).gte("created_at", monthStart.toISOString()),
    supabase.from("report_schedules").select("id", { count: "exact", head: true }).eq("enabled", true),
    supabase.from("clients").select("id, name, logo_url, created_at, data_sources(type, created_at)").eq("archived", false).order("created_at", { ascending: false }).limit(8),
    // Only the two fields the dashboard actually aggregates — drops the large
    // topQueries/topPages/movers arrays from the payload (perf audit P1-4).
    // `movers` is added for the AI insight cards. It's bounded (5 winners, 5
    // decliners, 5 opportunities) unlike topQueries/topPages, so the payload
    // stays close to what the perf audit trimmed it to.
    supabase.from("gsc_snapshots").select("data_source_id, totals:data->totals, series:data->byDate, movers:data->movers").eq("period_days", 28),
    supabase.from("data_sources").select("id, client_id, config, clients(name, archived)").eq("type", "gsc"),
    // Every source, for the integrations stat, the sync status and the timeline.
    supabase.from("data_sources").select("client_id, type, created_at, last_synced_at, last_sync_error"),
    supabase.from("reports").select("id, title, status, period_start, period_end, data, created_at, client_id, clients(name)").order("created_at", { ascending: false }).limit(5),
    supabase.from("report_schedules").select("id, client_id, frequency, next_run_at, template_key, clients(name)").eq("enabled", true).order("next_run_at", { ascending: true }).limit(5),
    supabase.from("email_logs").select("report_id, to_email, status, sent_at, error, source").order("sent_at", { ascending: false }).limit(10),
    // Reports whose stored data carries the AI-written analysis, newest first:
    // each client's latest one feeds the AI insights panel.
    supabase.from("reports").select(INSIGHT_REPORT_SELECT).not("data->insights->>executiveSummary", "is", null).order("created_at", { ascending: false }).limit(60),
    getSubscriptionState(supabase, agency.id),
  ]);

  const clients = (clientsRaw ?? []) as ClientWithSources[];

  // Integration health roll-up across every connected data source, and the
  // same rows rolled up per client for the clients table.
  const healthRows = await getIntegrationHealthCached(agency.id);
  const health = summarize(healthRows);
  const clientStatuses = clientStatusMap(healthRows);

  // Client connections — connected / pending / ready.
  const sources = (gscSources ?? []) as { id: string; client_id: string | null; config: { site_url?: string | null } | null; clients: JoinedClient }[];

  const everySource = (allSources ?? []) as {
    client_id: string | null; type: string; created_at: string;
    last_synced_at: string | null; last_sync_error: string | null;
  }[];

  // Active clients with no data source of ANY kind. This used to subtract
  // only the clients with Search Console, so a client reporting from LinkedIn
  // or Meta Ads was still counted as "needs a data source".
  const withAnySource = new Set(everySource.map((s) => s.client_id).filter(Boolean));
  const activeClients = (activeClientRows ?? []) as { id: string; name: string }[];
  const pendingCount = activeClients.filter((c) => !withAnySource.has(c.id)).length;

  // Performance — aggregated strictly from real cached snapshots. When there
  // is nothing to aggregate the KPI block is not rendered at all: Anavyst
  // never shows invented numbers, so an empty state takes its place.
  const snapRows = (snaps ?? []) as {
    data_source_id: string;
    totals: Day | null;
    series: Day[] | null;
    movers: GscReportFull["movers"] | null;
  }[];

  const byDate = new Map<string, { clicks: number; impressions: number; posW: number }>();
  let tClicks = 0, tImpr = 0, tPosW = 0;
  for (const s of snapRows) {
    const t = s.totals;
    if (t) { tClicks += t.clicks; tImpr += t.impressions; tPosW += t.position * t.impressions; }
    for (const d of s.series ?? []) {
      const e = byDate.get(d.date) ?? { clicks: 0, impressions: 0, posW: 0 };
      e.clicks += d.clicks; e.impressions += d.impressions; e.posW += d.position * d.impressions;
      byDate.set(d.date, e);
    }
  }
  const series: Day[] = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([date, e]) => ({
    date, clicks: e.clicks, impressions: e.impressions,
    ctr: e.impressions ? e.clicks / e.impressions : 0,
    position: e.impressions ? e.posW / e.impressions : 0,
  }));
  const perf = { clicks: tClicks, impressions: tImpr, ctr: tImpr ? tClicks / tImpr : 0, position: tImpr ? tPosW / tImpr : 0 };

  // Real data means a snapshot that actually carries measurements — a synced
  // source with an all-zero window still counts, an empty table does not.
  const hasReal = snapRows.length > 0 && series.length > 0;

  // Home's performance card headlines clicks; its trend is half the window
  // against the other half.
  const clicksArr = series.map((d) => d.clicks);
  const clicksT = trend(clicksArr);

  // The comparison is the same split the trend uses — half the window against
  // the other half — so the label can never drift from the maths above.
  const halfDays = Math.floor(series.length / 2);
  const comparison = halfDays > 0 ? `vs previous ${halfDays} day${halfDays === 1 ? "" : "s"}` : "";



  // The setup journey, in the order an agency actually lives it: a client to
  // report on, a source to pull from, data that has landed, branding on the
  // deliverable, a report, and then delivery. Every "done" is read from state
  // already fetched above — no extra queries, and nothing is tracked or
  // remembered that the workspace doesn't already record.
  //
  // "Connect a data source" and "See your first synced data" count every
  // integration type, not just Search Console: only the performance aggregate
  // (`hasReal`) is Search Console-specific.
  const steps: OnboardingStep[] = [
    {
      label: "Add your first client",
      done: (clientCount ?? 0) > 0,
      href: "/dashboard/clients/new",
      cta: "Add client",
      description: "Every report, data source and schedule hangs off a client.",
    },
    {
      label: "Connect a data source",
      done: everySource.length > 0,
      href: "/dashboard/clients",
      cta: "Connect a source",
      description: "Search Console, GA4, Meta Ads, Shopify and more — open a client and connect one.",
    },
    {
      label: "See your first synced data",
      // Any source's first completed sync, not just Search Console's.
      done: hasReal || everySource.some((s) => Boolean(s.last_synced_at)),
      href: "/dashboard/clients",
      cta: "View performance",
      description: "The first sync usually lands within a few minutes. Metrics then appear on the client page.",
    },
    {
      label: "Add your logo & branding",
      done: !!agency.logo_url,
      href: "/dashboard/settings",
      cta: "Add branding",
      description: "Clients see your agency on every report and email — not Anavyst.",
    },
    {
      label: "Generate your first report",
      done: (reportCount ?? 0) > 0,
      href: "/dashboard/clients",
      cta: "Pick a client",
      description: "Open a client, choose a template and date range, and generate.",
    },
    {
      label: "Send or schedule it",
      // A bounced or failed attempt doesn't count as delivered, so it doesn't
      // tick the step — the agency still has something to fix.
      done:
        (emailsRaw ?? []).some((e) => e.status !== "failed" && e.status !== "bounced" && e.status !== "pending") ||
        (scheduleCount ?? 0) > 0,
      href: "/dashboard/reports",
      cta: "Go to reports",
      description: "Email the report to your client, or put delivery on a recurring schedule.",
    },
  ];
  const setupComplete = steps.every((s) => s.done);

  const srcById = new Map(sources.map((s) => [s.id, s]));

  const reports = (reportsRaw ?? []) as { id: string; title: string; status: string; period_start: string | null; period_end: string | null; data: { totals?: Day } | null; created_at: string; client_id: string | null; clients: JoinedName }[];
  const schedules = (schedulesRaw ?? []) as { id: string; client_id: string | null; frequency: string; next_run_at: string; template_key: string; clients: JoinedName }[];
  const emails = (emailsRaw ?? []) as { report_id: string | null; to_email: string; status: string; sent_at: string; error: string | null; source: string | null }[];

  // ── Latest sync status ───────────────────────────────────────
  // The most recent successful sync across every source, plus how many are
  // genuinely failing (sync_error + needs_reconnect). Sources that are simply
  // waiting for an account selection (needs_account) are NOT counted here —
  // they produce a "No ad account selected" last_sync_error but that's a
  // setup-incomplete state, not a broken connection.
  const syncedTimes = everySource.map((s) => s.last_synced_at).filter((t): t is string => Boolean(t));
  const lastSyncAt = syncedTimes.length ? syncedTimes.sort((a, b) => b.localeCompare(a))[0] : null;
  // Use the health rollup already computed above (same data, single source of truth).
  const failingSyncs = health.errored + health.needsReconnect;

  // ── Activity timeline ────────────────────────────────────────
  // email_logs.source (migration 0031) carries how each send was triggered, so
  // scheduled deliveries and manual sends are distinguished from the record
  // rather than inferred. Pre-0031 rows have no source and read as manual.
  const activity = buildActivity({
    clients: clients.map((c) => ({ id: c.id, name: c.name, created_at: c.created_at })),
    sources: everySource,
    reports: reports.map((r) => ({ id: r.id, title: r.title, created_at: r.created_at, client_id: r.client_id, clientName: nameOf(r.clients) })),
    emails,
    integrationNames: Object.fromEntries(everySource.map((s) => [s.type, getIntegrationName(s.type)])),
  });

  // ── Headline stats ───────────────────────────────────────────
  const nextSchedule = schedules[0] ?? null;
  const upNext = schedules.map((s) => ({
    id: s.id,
    clientId: s.client_id,
    clientName: nameOf(s.clients),
    frequency: s.frequency,
    nextRunAt: s.next_run_at,
  }));

  // The integrations count now lives on the sidebar badge, and anything wrong
  // with a source is listed under Needs attention, so the strip is four cells.
  const stats: StatTileData[] = [
    {
      label: "Active clients",
      value: String(clientCount ?? 0),
      hint: pendingCount > 0 ? `${pendingCount} still need a data source` : "All clients have a source connected",
      icon: "users",
      tone: pendingCount > 0 ? "warning" : "positive",
      href: "/dashboard/clients",
    },
    {
      label: "Reports this month",
      value: String(reportsThisMonth ?? 0),
      hint: `${reportCount ?? 0} generated all time`,
      icon: "report",
      tone: "neutral",
      href: "/dashboard/reports",
    },
    {
      label: "Scheduled deliveries",
      value: String(scheduleCount ?? 0),
      hint: nextSchedule ? `Next: ${format(new Date(nextSchedule.next_run_at), "d MMM")}` : "Automate a client's delivery",
      icon: "calendar",
      tone: (scheduleCount ?? 0) > 0 ? "positive" : "neutral",
      href: "/dashboard/clients",
    },
    {
      label: "Latest sync",
      value: lastSyncAt ? format(new Date(lastSyncAt), "d MMM, HH:mm") : "—",
      hint: failingSyncs > 0 ? `${failingSyncs} source${failingSyncs === 1 ? "" : "s"} failing` : lastSyncAt ? "All sources healthy" : "No source has synced yet",
      icon: failingSyncs > 0 ? "alert" : "sync",
      tone: failingSyncs > 0 ? "danger" : lastSyncAt ? "positive" : "neutral",
      href: "/dashboard/settings/health",
    },
  ];

  // ── Needs attention ──────────────────────────────────────────
  // Every item below restates a fact already computed on this page, so the band
  // can never disagree with the tiles above it. Each becomes a link to wherever
  // the problem is actually fixed. Nothing is added when nothing is wrong.
  const failedEmails = emails.filter((e) => e.status === "failed" || e.status === "bounced").length;
  const attention: AttentionItem[] = [
    health.needsReconnect > 0 && {
      icon: "reconnect" as const,
      label: `${health.needsReconnect} source${health.needsReconnect === 1 ? "" : "s"} need reconnecting`,
      detail: "Access was revoked or expired. Reports skip this data until it's reconnected.",
      cta: "Reconnect",
      href: "/dashboard/settings/health",
      weight: 40,
    },
    health.errored > 0 && {
      icon: "error" as const,
      label: `${health.errored} source${health.errored === 1 ? "" : "s"} failing to sync`,
      detail: "The last sync failed, so reports may show older numbers.",
      cta: "Review",
      href: "/dashboard/settings/health",
      weight: 30,
    },
    health.needsAccount > 0 && {
      icon: "account" as const,
      label: `${health.needsAccount} source${health.needsAccount === 1 ? "" : "s"} need an account selected`,
      detail: "Connected, but Anavyst needs to know which account to report on.",
      cta: "Choose account",
      href: "/dashboard/integrations",
      weight: 20,
    },
    pendingCount > 0 && {
      icon: "client" as const,
      label: `${pendingCount} client${pendingCount === 1 ? "" : "s"} without a data source`,
      detail: "Reports can't be built for them until a source is connected.",
      cta: "Add a source",
      href: "/dashboard/clients",
      weight: 15,
    },
    failedEmails > 0 && {
      icon: "email" as const,
      label: `${failedEmails} report deliver${failedEmails === 1 ? "y" : "ies"} failed`,
      detail: "The email bounced or was rejected by the recipient's server.",
      cta: "Check & resend",
      href: "/dashboard/reports",
      weight: 10,
    },
  ].filter(Boolean) as AttentionItem[];

  // ── AI insight signals ───────────────────────────────────────
  // Computed per client from that client's own snapshot, then merged and
  // ranked across the workspace. Each card carries the client it belongs to,
  // so the panel says "where should I look today?" rather than restating an
  // aggregate the KPI row already shows. Nothing here is estimated: see
  // lib/insights/signals.ts.
  const signals: Signal[] = hasReal
    ? snapRows
        .flatMap((sn) => {
          const src = srcById.get(sn.data_source_id);
          const joined = src ? (Array.isArray(src.clients) ? src.clients[0] : src.clients) : null;
          // Each snapshot belongs to exactly one client; one that can't be
          // tied to a live client is dropped rather than shown unlabelled.
          if (!src?.client_id || !joined || joined.archived) return [];
          // Only the fields this snapshot actually selected are passed; the
          // detector emits nothing for the parts it can't see (e.g. top pages).
          const partial = {
            totals: sn.totals ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 },
            byDate: sn.series ?? [],
            movers: sn.movers ?? null,
            topQueries: [],
            topPages: [],
            topCountries: [],
            topDevices: [],
            previousTotals: null,
          } as unknown as GscReportFull;
          return forClient(detectSignals(partial, null, 3), {
            clientId: src.client_id,
            clientName: nameOf(src.clients),
            account: siteLabel(src.config?.site_url),
          });
        })
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 6)
    : [];

  // ── AI-written analysis, client by client ────────────────────
  // What the AI system wrote from each client's own data when that client's
  // latest report was generated (lib/dashboard/aiInsights). One block per
  // client, never pooled; clients with synced data but no recent analysis are
  // listed so the user can generate one.
  const aiOnPlan = featuresForPlan(subState.plan).aiInsights;
  const insightRows = (insightReportsRaw ?? []) as unknown as InsightReportRow[];
  const analyses = latestInsightsPerClient(insightRows, 4);
  const activeIds = new Set(activeClients.map((c) => c.id));
  const analysedIds = new Set(
    insightRows
      .filter((r) => r.client_id && activeIds.has(r.client_id) && r.summary?.trim())
      .map((r) => r.client_id as string)
  );
  const syncedIds = new Set(everySource.filter((s) => s.last_synced_at).map((s) => s.client_id));
  const awaitingAi = activeClients
    .filter((c) => syncedIds.has(c.id) && !analysedIds.has(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const showAi = analyses.length > 0 || signals.length > 0 || syncedIds.size > 0;


  // ── Returning-user "welcome back" summary (journey audit P2-9) ──
  // Only on a genuine return (last seen > 6h ago). Compute what changed since,
  // then stamp last_seen_at for next time.
  const lastSeen = agency.last_seen_at;
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const isReturn = !!lastSeen && Date.now() - new Date(lastSeen).getTime() > SIX_HOURS;
  let welcomeBack: WelcomeBackData | null = null;
  if (isReturn && lastSeen) {
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(); todayEnd.setUTCHours(23, 59, 59, 999);
    const [rep, syncedSrc, schedToday] = await Promise.all([
      supabase.from("reports").select("id", { count: "exact", head: true }).gt("created_at", lastSeen),
      supabase.from("data_sources").select("id", { count: "exact", head: true }).gt("last_synced_at", lastSeen),
      supabase.from("report_schedules").select("id", { count: "exact", head: true }).eq("enabled", true).gte("next_run_at", todayStart.toISOString()).lte("next_run_at", todayEnd.toISOString()),
    ]);
    const d: WelcomeBackData = {
      lastSeen,
      reportsSent: rep.count ?? 0,
      syncedSources: syncedSrc.count ?? 0,
      // Reuses the health rollup already computed above instead of its own
      // `status in (error, revoked)` count — that third definition is why the
      // banner said "1 source needs attention" beside a tile saying "3 failing".
      failedSyncs: health.needsAttention,
      schedulesToday: schedToday.count ?? 0,
    };
    // Only show if there's something worth saying.
    if (d.reportsSent || d.syncedSources || d.failedSyncs || d.schedulesToday) welcomeBack = d;
  }
  // Stamp last-seen for next visit. Awaited so it reliably persists (an
  // un-awaited promise in a Server Component can be dropped before it settles).
  await supabase.from("agencies").update({ last_seen_at: new Date().toISOString() }).eq("id", agency.id);

  // "Which client needs attention?" is one of the questions this page exists to
  // answer, so the table sorts by each client's rolled-up status (reconnect,
  // then sync errors, account choices and missing sources) before newest-first.
  const clientsByAttention = [...clients].sort(
    (a, b) => CLIENT_STATUS_PRIORITY[statusFor(clientStatuses, a.id).key] - CLIENT_STATUS_PRIORITY[statusFor(clientStatuses, b.id).key]
  );

  // Last report and next delivery for the five clients the table shows.
  const topClients = clientsByAttention.slice(0, 5);
  const topIds = topClients.map((c) => c.id);
  const [{ data: topReports }, { data: topSchedules }] = topIds.length
    ? await Promise.all([
        supabase.from("reports").select("client_id, created_at").in("client_id", topIds).order("created_at", { ascending: false }).limit(50),
        supabase.from("report_schedules").select("client_id, frequency, next_run_at").eq("enabled", true).in("client_id", topIds).order("next_run_at", { ascending: true }),
      ])
    : [{ data: [] }, { data: [] }];
  const lastReportBy = new Map<string, string>();
  for (const r of (topReports ?? []) as { client_id: string; created_at: string }[]) {
    if (!lastReportBy.has(r.client_id)) lastReportBy.set(r.client_id, r.created_at);
  }
  const nextDeliveryBy = new Map<string, { frequency: string; next_run_at: string }>();
  for (const s of (topSchedules ?? []) as { client_id: string; frequency: string; next_run_at: string }[]) {
    if (!nextDeliveryBy.has(s.client_id)) nextDeliveryBy.set(s.client_id, s);
  }
  const homeClientRows: HomeClientRow[] = topClients.map((c) => {
    const last = lastReportBy.get(c.id);
    const next = nextDeliveryBy.get(c.id);
    return {
      id: c.id,
      name: c.name,
      logoUrl: c.logo_url,
      sourceCount: (c.data_sources ?? []).length,
      status: statusFor(clientStatuses, c.id),
      lastReport: last ? format(new Date(last), "d MMM yyyy") : null,
      nextDelivery: next
        ? `${format(new Date(next.next_run_at), "d MMM")} · ${next.frequency.charAt(0).toUpperCase()}${next.frequency.slice(1)}`
        : null,
    };
  });

  // ── Render ───────────────────────────────────────────────────
  const { date: today, hour } = localNow(agency.timezone ?? null);
  const name = firstName(user.user_metadata as Record<string, unknown> | undefined);
  const header = (eyebrow: string, title: string, sub: string, actions?: React.ReactNode) => (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="font-app-mono text-xs text-ink-400">{eyebrow}</p>
        <h1 className="mt-1.5 text-[clamp(24px,3vw,30px)] font-semibold tracking-[-0.03em] text-ink-900">{title}</h1>
        <p className="mt-1 text-[14.5px] text-ink-500">{sub}</p>
      </div>
      {actions}
    </div>
  );

  // A brand-new workspace (no clients yet): the setup stepper IS the page, with
  // the sample report and branding pitch beside it.
  if ((clientCount ?? 0) === 0) {
    return (
      <div className="flex flex-col gap-6">
        {welcomeBack && <WelcomeBack data={welcomeBack} />}
        {header(
          agency.name,
          name ? `Welcome to Anavyst, ${name}` : "Welcome to Anavyst",
          `${steps.length} steps to your first branded report.`
        )}
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
          <OnboardingChecklist steps={steps} />
          <div className="flex flex-col gap-5">
            <SampleReportCard agencyName={agency.name} brandColor={agency.brand_color} />
            <BrandingCard />
          </div>
        </div>
      </div>
    );
  }

  const n = attention.length;
  const summary =
    n > 0
      ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} you today.${health.total > 0 ? " Everything else is syncing and sending on schedule." : ""}`
      : health.total > 0
        ? "Nothing needs you today. Everything is syncing and sending on schedule."
        : "Nothing needs you today.";

  return (
    <div className="flex flex-col gap-6">
      {welcomeBack && <WelcomeBack data={welcomeBack} />}

      {header(
        today,
        name ? `${greetingFor(hour)}, ${name}` : greetingFor(hour),
        summary,
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/clients/new">Add client</Link>
          </Button>
          <NewReportButton>
            <Plus size={15} strokeWidth={2.2} aria-hidden /> New report
          </NewReportButton>
        </div>
      )}

      <StatRow stats={stats} />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {/* Onboarding stays first-class until setup is actually finished. */}
          {!setupComplete && <OnboardingChecklist steps={steps} />}
          <NeedsAttention items={attention} />
          {showAi && (
            <AiPanel analyses={analyses} analysedTotal={analysedIds.size} signals={signals} awaiting={awaitingAi} aiOnPlan={aiOnPlan} />
          )}
          <HomeClients rows={homeClientRows} total={clientCount ?? 0} />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* The sample pitch is headed "Before you connect anything", so it is
              shown only to a workspace with no data source of any kind. It used
              to key off Search Console alone, so an agency reporting from
              LinkedIn or Meta Ads was still told it hadn't connected anything. */}
          {!setupComplete && everySource.length === 0 && <SampleReportCard agencyName={agency.name} brandColor={agency.brand_color} />}
          <UpNext items={upNext} />
          {hasReal && (
            <SearchPerformance
              clicks={fmt(perf.clicks)}
              impressions={fmt(perf.impressions)}
              ctr={`${(perf.ctr * 100).toFixed(1)}%`}
              position={perf.position.toFixed(1)}
              deltaPct={clicksT.pct}
              good={clicksT.good}
              comparison={comparison}
              series={clicksArr}
            />
          )}
          <ActivityTimeline events={activity} />
        </div>
      </div>
    </div>
  );
}
