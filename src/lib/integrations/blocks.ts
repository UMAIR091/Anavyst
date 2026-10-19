// Provider-agnostic projection from a cached snapshot to display "blocks".
//
// Why this exists: the PDF, AI insights, email and export layers used to read
// Search Console and GA4 directly, so every other integration stopped at the
// dashboard. Rather than teach each of those layers about each provider (which
// would need editing every layer for every new integration), each snapshot is
// projected once into a small neutral vocabulary — KPIs, time series and tables
// — that all of them consume.
//
// The projection keys off the snapshot's SHAPE, not the provider id. Providers
// already normalize into a handful of shared shapes (AdsReport, CommerceReport,
// EmailReport, …), so any future integration that returns one of those shapes
// automatically appears everywhere with no code change here. Adding a genuinely
// new shape is the only case that needs a new projector.
import { getIntegrationName } from "./names";
import { promptLabel } from "@/lib/ai/untrusted";
import type { AdsCampaign, AdsTotals } from "./metrics";
import { pctChange } from "@/lib/metrics/change";

export type BlockFormat = "number" | "currency" | "percent" | "duration" | "position";

// Semantic grouping, used to order sections and to tell the AI what kind of
// channel it is looking at.
export type BlockCategory = "paid" | "organic" | "analytics" | "commerce" | "crm" | "email" | "social" | "calls" | "video" | "local" | "other";

export type BlockKpi = {
  label: string;
  /**
   * null when the metric cannot legitimately be calculated — CPC with no
   * clicks, ROAS with no spend, CTR with no impressions. Renders as "—".
   * A real measured zero (0 conversions) stays 0, which is a fact.
   */
  value: number | null;
  previous: number | null;
  format: BlockFormat;
  /** True where a fall is an improvement (cost per acquisition, search position). */
  lowerBetter?: boolean;
};

export type BlockSeries = {
  label: string;
  format: BlockFormat;
  points: { date: string; value: number }[];
};

export type BlockTable = {
  title: string;
  columns: { key: string; label: string; format: BlockFormat }[];
  rows: Record<string, string | number>[];
};

export type ReportBlock = {
  sourceId: string; // data_sources.type
  sourceName: string; // "TikTok Ads"
  /**
   * Set only when a report has two sources of one platform (two Meta ad
   * accounts, migration 0049): the data source id, which tells the blocks
   * apart, while sourceName then names the account too. Absent otherwise, so
   * single-account reports are unchanged.
   */
  instanceId?: string;
  category: BlockCategory;
  currency: string | null; // set for monetary blocks
  kpis: BlockKpi[];
  series: BlockSeries[];
  tables: BlockTable[];
  notes: string[];
};

/** Identifies a block within one report (sourceId alone repeats when a client
 *  has two accounts of one platform). */
export function blockKey(b: Pick<ReportBlock, "sourceId" | "instanceId">): string {
  return b.instanceId ?? b.sourceId;
}

// ── helpers ──────────────────────────────────────────────────

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/** Reads `obj.path.to.key` defensively — snapshots are untyped JSON from the DB. */
function at(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (!isRec(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function has(obj: unknown, ...keys: string[]): boolean {
  return isRec(obj) && keys.every((k) => k in obj);
}

function kpi(label: string, value: unknown, previous: unknown, format: BlockFormat, lowerBetter = false): BlockKpi {
  return {
    label,
    value: n(value),
    previous: previous === undefined || previous === null ? null : n(previous),
    format,
    ...(lowerBetter ? { lowerBetter: true } : {}),
  };
}

/**
 * A ratio KPI, nulled when its denominator is zero.
 *
 * The stored snapshots floor a divide-by-zero at 0 (see metrics.ratio), so a
 * paid account with impressions but no clicks stored `cpc: 0`. Rendering that
 * as "0" states a cost per click for traffic that never happened. The guard
 * lives here, at projection time, rather than rewriting historical snapshots.
 */
function ratioKpi(
  label: string,
  value: unknown,
  previous: unknown,
  format: BlockFormat,
  denominator: unknown,
  previousDenominator: unknown,
  lowerBetter = false
): BlockKpi {
  return {
    label,
    value: n(denominator) > 0 ? n(value) : null,
    previous:
      previous === undefined || previous === null || n(previousDenominator) <= 0 ? null : n(previous),
    format,
    ...(lowerBetter ? { lowerBetter: true } : {}),
  };
}

/**
 * Drops KPIs that are zero with no prior value — a metric the account doesn't
 * use. A null value (not calculable) is KEPT so it can render as "—": the
 * reader learns the metric exists but has no denominator, which is a different
 * statement from the metric being absent.
 */
function meaningful(kpis: BlockKpi[]): BlockKpi[] {
  return kpis.filter((k) => k.value === null || k.value !== 0 || (k.previous !== null && k.previous !== 0));
}

function seriesFrom(rows: unknown, key: string, label: string, format: BlockFormat): BlockSeries | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const points = rows
    .filter(isRec)
    .map((r) => ({ date: s(r.date), value: n(r[key]) }))
    .filter((p) => p.date);
  if (!points.length || points.every((p) => p.value === 0)) return null;
  return { label, format, points };
}

function nameOf(sourceId: string): string {
  return getIntegrationName(sourceId);
}

// ── shape projectors ─────────────────────────────────────────

const ADS_COLUMNS: BlockTable["columns"] = [
  { key: "name", label: "Name", format: "number" },
  { key: "spend", label: "Spend", format: "currency" },
  { key: "impressions", label: "Impressions", format: "number" },
  { key: "clicks", label: "Clicks", format: "number" },
  { key: "ctr", label: "CTR", format: "percent" },
  { key: "conversions", label: "Conversions", format: "number" },
];

function breakdownTable(title: string, rows: unknown): BlockTable | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const mapped = (rows as AdsCampaign[]).filter(isRec).map((r) => ({
    name: s(r.name) || "—",
    spend: n(r.spend),
    impressions: n(r.impressions),
    clicks: n(r.clicks),
    ctr: n(r.ctr),
    conversions: n(r.conversions),
  }));
  return { title, columns: ADS_COLUMNS, rows: mapped };
}

// AdsReport — Google Ads, Meta Ads, TikTok, LinkedIn, Microsoft, Pinterest,
// Snapchat, Reddit, Amazon, X, and any future paid-media source.
function projectAds(sourceId: string, snap: unknown): ReportBlock {
  const totals = at(snap, "totals") as Partial<AdsTotals> | undefined;
  const prev = at(snap, "previousTotals") as Partial<AdsTotals> | undefined;
  const byDate = at(snap, "byDate");

  const kpis = meaningful([
    kpi("Spend", totals?.spend, prev?.spend, "currency"),
    kpi("Impressions", totals?.impressions, prev?.impressions, "number"),
    kpi("Clicks", totals?.clicks, prev?.clicks, "number"),
    ratioKpi("CTR", totals?.ctr, prev?.ctr, "percent", totals?.impressions, prev?.impressions),
    ratioKpi("CPC", totals?.cpc, prev?.cpc, "currency", totals?.clicks, prev?.clicks, true),
    ratioKpi("CPM", totals?.cpm, prev?.cpm, "currency", totals?.impressions, prev?.impressions, true),
    kpi("Conversions", totals?.conversions, prev?.conversions, "number"),
    ratioKpi("Cost per conversion", totals?.costPerConversion, prev?.costPerConversion, "currency", totals?.conversions, prev?.conversions, true),
    kpi("Revenue", totals?.revenue, prev?.revenue, "currency"),
    ratioKpi("ROAS", totals?.roas, prev?.roas, "number", totals?.spend, prev?.spend),
    // Meta reports reach; other platforms don't. Harmless when absent.
    kpi("Reach", at(snap, "totals", "reach"), at(snap, "previousTotals", "reach"), "number"),
  ]);

  const series = [
    seriesFrom(byDate, "spend", "Spend", "currency"),
    seriesFrom(byDate, "clicks", "Clicks", "number"),
    seriesFrom(byDate, "impressions", "Impressions", "number"),
    seriesFrom(byDate, "conversions", "Conversions", "number"),
  ].filter((x): x is BlockSeries => x !== null);

  const tables = [
    breakdownTable("Top campaigns", at(snap, "topCampaigns")),
    breakdownTable("Top ad groups", at(snap, "topAdGroups")),
    breakdownTable("Top ads", at(snap, "topAds")),
  ].filter((x): x is BlockTable => x !== null);

  const notes: string[] = [];
  const video = at(snap, "video");
  if (isRec(video)) {
    kpis.push(
      kpi("Video views", video.views, null, "number"),
      kpi("Video completions", video.completions, null, "number"),
      kpi("Completion rate", video.completionRate, null, "percent"),
    );
  }

  // An account with no spend and nothing to compare against loses every
  // metric to `meaningful` and keeps only uncalculable ratios, which the
  // renderers drop, so the section showed a bare heading and read as broken.
  // Zero spend is the finding here: say it with the volume metrics.
  const dormant = isRec(totals) && !kpis.some((k) => k.value !== null && k.value !== 0);
  const shown = dormant
    ? [
        kpi("Spend", totals?.spend ?? 0, prev?.spend, "currency"),
        kpi("Impressions", totals?.impressions ?? 0, prev?.impressions, "number"),
        kpi("Clicks", totals?.clicks ?? 0, prev?.clicks, "number"),
      ]
    : kpis;
  if (dormant) notes.push("No ads ran in this period.");

  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "paid",
    // Never assume USD. An unknown currency stays null and the formatter omits
    // the symbol — showing "$" over PKR spend is worse than showing no symbol.
    currency: s(at(snap, "currency")) || null,
    kpis: shown,
    series,
    tables,
    notes,
  };
}

function projectCommerce(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  const products = at(snap, "topProducts");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "commerce",
    currency: s(at(snap, "currency")) || null,
    kpis: meaningful([
      kpi("Revenue", at(t, "revenue"), at(p, "revenue"), "currency"),
      kpi("Orders", at(t, "orders"), at(p, "orders"), "number"),
      kpi("Average order value", at(t, "avgOrderValue"), at(p, "avgOrderValue"), "currency"),
      kpi("Customers", at(t, "customers"), at(p, "customers"), "number"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "revenue", "Revenue", "currency"),
      seriesFrom(at(snap, "byDate"), "orders", "Orders", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: Array.isArray(products) && products.length
      ? [{
          title: "Top products",
          columns: [
            { key: "name", label: "Product", format: "number" as BlockFormat },
            { key: "quantity", label: "Units", format: "number" as BlockFormat },
            { key: "revenue", label: "Revenue", format: "currency" as BlockFormat },
          ],
          rows: products.filter(isRec).map((r) => ({ name: s(r.name) || "—", quantity: n(r.quantity), revenue: n(r.revenue) })),
        }]
      : [],
    notes: [],
  };
}

function projectCrm(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  const deals = at(snap, "topDeals");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "crm",
    currency: s(at(snap, "currency")) || null,
    kpis: meaningful([
      kpi("New contacts", at(t, "newContacts"), at(p, "newContacts"), "number"),
      kpi("New deals", at(t, "newDeals"), at(p, "newDeals"), "number"),
      kpi("Won deals", at(t, "wonDeals"), at(p, "wonDeals"), "number"),
      kpi("Won revenue", at(t, "wonRevenue"), at(p, "wonRevenue"), "currency"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "contacts", "New contacts", "number"),
      seriesFrom(at(snap, "byDate"), "deals", "New deals", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: Array.isArray(deals) && deals.length
      ? [{
          title: "Recent deals",
          columns: [
            { key: "name", label: "Deal", format: "number" as BlockFormat },
            { key: "stage", label: "Stage", format: "number" as BlockFormat },
            { key: "amount", label: "Amount", format: "currency" as BlockFormat },
          ],
          rows: deals.filter(isRec).map((r) => ({ name: s(r.name) || "—", stage: s(r.stage) || "—", amount: n(r.amount) })),
        }]
      : [],
    notes: [],
  };
}

function projectEmail(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  const campaigns = at(snap, "topCampaigns");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "email",
    currency: null,
    kpis: meaningful([
      kpi("Subscribers", at(t, "subscribers"), at(p, "subscribers"), "number"),
      kpi("New subscribers", at(t, "newSubscribers"), at(p, "newSubscribers"), "number"),
      kpi("Unsubscribes", at(t, "unsubscribes"), at(p, "unsubscribes"), "number", true),
      kpi("Emails sent", at(t, "emailsSent"), at(p, "emailsSent"), "number"),
      kpi("Open rate", at(t, "openRate"), at(p, "openRate"), "percent"),
      kpi("Click rate", at(t, "clickRate"), at(p, "clickRate"), "percent"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "sent", "Emails sent", "number"),
      seriesFrom(at(snap, "byDate"), "opens", "Opens", "number"),
      seriesFrom(at(snap, "byDate"), "clicks", "Clicks", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: Array.isArray(campaigns) && campaigns.length
      ? [{
          title: "Recent campaigns",
          columns: [
            { key: "name", label: "Campaign", format: "number" as BlockFormat },
            { key: "sent", label: "Sent", format: "number" as BlockFormat },
            { key: "openRate", label: "Open rate", format: "percent" as BlockFormat },
            { key: "clickRate", label: "Click rate", format: "percent" as BlockFormat },
          ],
          rows: campaigns.filter(isRec).map((r) => ({
            name: s(r.name) || "—", sent: n(r.sent), openRate: n(r.openRate), clickRate: n(r.clickRate),
          })),
        }]
      : [],
    notes: [],
  };
}

function projectCalls(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "calls",
    currency: null,
    kpis: meaningful([
      kpi("Calls", at(t, "calls"), at(p, "calls"), "number"),
      kpi("First-time callers", at(t, "leads"), at(p, "leads"), "number"),
      kpi("Answered", at(t, "answered"), at(p, "answered"), "number"),
      kpi("Missed", at(t, "missed"), at(p, "missed"), "number", true),
      kpi("Average duration", at(t, "avgDurationSec"), at(p, "avgDurationSec"), "duration"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "calls", "Calls", "number"),
      seriesFrom(at(snap, "byDate"), "leads", "First-time callers", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: [],
    notes: [],
  };
}

function projectSeo(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  const kw = at(snap, "topKeywords");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "organic",
    currency: null,
    kpis: meaningful([
      kpi("Domain rating", at(t, "domainRating"), at(p, "domainRating"), "number"),
      kpi("Organic keywords", at(t, "organicKeywords"), at(p, "organicKeywords"), "number"),
      kpi("Estimated organic traffic", at(t, "organicTraffic"), at(p, "organicTraffic"), "number"),
      kpi("Backlinks", at(t, "backlinks"), at(p, "backlinks"), "number"),
      kpi("Referring domains", at(t, "referringDomains"), at(p, "referringDomains"), "number"),
    ]),
    series: [],
    tables: Array.isArray(kw) && kw.length
      ? [{
          title: "Top keywords",
          columns: [
            { key: "keyword", label: "Keyword", format: "number" as BlockFormat },
            { key: "position", label: "Position", format: "position" as BlockFormat },
            { key: "volume", label: "Volume", format: "number" as BlockFormat },
            { key: "traffic", label: "Traffic", format: "number" as BlockFormat },
          ],
          rows: kw.filter(isRec).map((r) => ({
            keyword: s(r.keyword) || "—", position: n(r.position), volume: n(r.volume), traffic: n(r.traffic),
          })),
        }]
      : [],
    notes: [`Domain analyzed: ${s(at(snap, "target")) || "—"}`],
  };
}

function projectVideo(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  const top = at(snap, "topVideos");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "video",
    currency: null,
    kpis: meaningful([
      kpi("Views", at(t, "views"), at(p, "views"), "number"),
      kpi("Watch time (minutes)", at(t, "watchTimeMinutes"), at(p, "watchTimeMinutes"), "number"),
      kpi("Average view duration", at(t, "avgViewDurationSec"), at(p, "avgViewDurationSec"), "duration"),
      kpi("Subscribers", at(t, "subscribers"), at(p, "subscribers"), "number"),
      kpi("Subscribers gained", at(t, "subscribersGained"), at(p, "subscribersGained"), "number"),
      kpi("Likes", at(t, "likes"), at(p, "likes"), "number"),
      kpi("Comments", at(t, "comments"), at(p, "comments"), "number"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "views", "Views", "number"),
      seriesFrom(at(snap, "byDate"), "watchTimeMinutes", "Watch time (minutes)", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: Array.isArray(top) && top.length
      ? [{
          title: "Top videos",
          columns: [
            { key: "title", label: "Video", format: "number" as BlockFormat },
            { key: "views", label: "Views", format: "number" as BlockFormat },
            { key: "watchTimeMinutes", label: "Watch time (min)", format: "number" as BlockFormat },
          ],
          rows: top.filter(isRec).map((r) => ({ title: s(r.title) || "—", views: n(r.views), watchTimeMinutes: n(r.watchTimeMinutes) })),
        }]
      : [],
    notes: [],
  };
}

function projectSocial(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  const posts = at(snap, "topPosts");
  const notes = at(snap, "notes");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "social",
    currency: null,
    kpis: meaningful([
      kpi("Followers", at(t, "followers"), at(p, "followers"), "number"),
      kpi("Follower growth", at(t, "followerGrowth"), at(p, "followerGrowth"), "number"),
      kpi("Reach", at(t, "reach"), at(p, "reach"), "number"),
      kpi("Impressions", at(t, "impressions"), at(p, "impressions"), "number"),
      kpi("Profile views", at(t, "profileViews"), at(p, "profileViews"), "number"),
      kpi("Website clicks", at(t, "websiteClicks"), at(p, "websiteClicks"), "number"),
      kpi("Posts published", at(t, "posts"), at(p, "posts"), "number"),
      kpi("Likes", at(t, "likes"), at(p, "likes"), "number"),
      kpi("Comments", at(t, "comments"), at(p, "comments"), "number"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "reach", "Reach", "number"),
      seriesFrom(at(snap, "byDate"), "followerChange", "Follower change", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: Array.isArray(posts) && posts.length
      ? [{
          title: "Top content",
          columns: [
            { key: "caption", label: "Post", format: "number" as BlockFormat },
            { key: "likes", label: "Likes", format: "number" as BlockFormat },
            { key: "comments", label: "Comments", format: "number" as BlockFormat },
            { key: "shares", label: "Shares", format: "number" as BlockFormat },
          ],
          rows: posts.filter(isRec).map((r) => ({
            caption: (s(r.caption) || "—").slice(0, 80), likes: n(r.likes), comments: n(r.comments), shares: n(r.shares),
          })),
        }]
      : [],
    notes: Array.isArray(notes) ? notes.filter((x): x is string => typeof x === "string") : [],
  };
}

function projectLocal(sourceId: string, snap: unknown): ReportBlock {
  const t = at(snap, "totals");
  const p = at(snap, "previousTotals");
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "local",
    currency: null,
    kpis: meaningful([
      kpi("Profile impressions", at(t, "impressions"), at(p, "impressions"), "number"),
      kpi("Website clicks", at(t, "websiteClicks"), at(p, "websiteClicks"), "number"),
      kpi("Calls", at(t, "calls"), at(p, "calls"), "number"),
      kpi("Direction requests", at(t, "directionRequests"), at(p, "directionRequests"), "number"),
      kpi("Bookings", at(t, "bookings"), at(p, "bookings"), "number"),
    ]),
    series: [
      seriesFrom(at(snap, "byDate"), "impressions", "Profile impressions", "number"),
      seriesFrom(at(snap, "byDate"), "websiteClicks", "Website clicks", "number"),
    ].filter((x): x is BlockSeries => x !== null),
    tables: [],
    notes: [],
  };
}

function projectTable(sourceId: string, snap: unknown): ReportBlock {
  const headers = at(snap, "headers");
  const rows = at(snap, "rows");
  const cols = Array.isArray(headers) ? headers.map((h, i) => ({ key: `c${i}`, label: s(h) || `Column ${i + 1}`, format: "number" as BlockFormat })) : [];
  const mapped = Array.isArray(rows)
    ? rows.slice(0, 25).map((r) => {
        const out: Record<string, string | number> = {};
        if (Array.isArray(r)) r.forEach((cell, i) => { out[`c${i}`] = s(cell); });
        return out;
      })
    : [];
  return {
    sourceId,
    sourceName: nameOf(sourceId),
    category: "other",
    currency: null,
    kpis: [kpi("Rows", at(snap, "totalRows"), null, "number")],
    series: [],
    tables: cols.length ? [{ title: s(at(snap, "title")) || "Data", columns: cols, rows: mapped }] : [],
    notes: [],
  };
}

// ── shape detection ──────────────────────────────────────────

// Ordered most-distinctive first. Each predicate looks for fields unique to one
// shape so an unrelated snapshot can't be mis-projected.
export function snapshotToBlock(sourceId: string | null | undefined, snapshot: unknown): ReportBlock | null {
  if (!sourceId || !isRec(snapshot)) return null;
  const t = at(snapshot, "totals");

  // Ads: the only shape with spend + impressions. Covers both the shared
  // AdsReport and Meta's bespoke totals (which add `reach`).
  if (has(t, "spend") && has(t, "impressions")) return projectAds(sourceId, snapshot);
  if (has(t, "orders") && has(t, "avgOrderValue")) return projectCommerce(sourceId, snapshot);
  if (has(t, "newContacts") || has(t, "wonDeals")) return projectCrm(sourceId, snapshot);
  if (has(t, "subscribers") && has(t, "openRate")) return projectEmail(sourceId, snapshot);
  if (has(t, "calls") && has(t, "avgDurationSec")) return projectCalls(sourceId, snapshot);
  if (has(t, "organicKeywords") || has(t, "domainRating")) return projectSeo(sourceId, snapshot);
  if (has(t, "watchTimeMinutes")) return projectVideo(sourceId, snapshot);
  if (has(t, "followers")) return projectSocial(sourceId, snapshot);
  if (has(t, "directionRequests")) return projectLocal(sourceId, snapshot);
  if (has(snapshot, "headers") && has(snapshot, "rows")) return projectTable(sourceId, snapshot);

  // Unknown shape: better to omit the section than to render something wrong.
  return null;
}

const CATEGORY_ORDER: BlockCategory[] = ["paid", "organic", "analytics", "social", "commerce", "crm", "email", "calls", "video", "local", "other"];

/** Blocks in reading order: paid first, then organic, analytics, social, … */
export function orderBlocks(blocks: ReportBlock[]): ReportBlock[] {
  return blocks.slice().sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
}

/** Projects many snapshots at once, dropping the ones with no usable content. */
export function snapshotsToBlocks(
  entries: { type: string | null | undefined; snapshot: unknown }[]
): ReportBlock[] {
  return orderBlocks(
    entries
      .map((e) => snapshotToBlock(e.type, e.snapshot))
      .filter((b): b is ReportBlock => b !== null && (b.kpis.length > 0 || b.tables.length > 0))
  );
}

// ── Cross-source aggregation ─────────────────────────────────

export type PaidAggregate = {
  currency: string | null; // null when sources disagree — monetary values are then omitted
  sourceNames: string[];
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  // Derived metrics are null when their denominator is zero (see `ratio` below).
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  costPerConversion: number | null;
  roas: number | null;
};

/**
 * Combines paid-media sources into one set of totals.
 *
 * Only paid blocks participate: spend, impressions, clicks, conversions and
 * revenue are the same unit on every ad platform, so they add up. Everything
 * else does NOT — GA4 sessions and Search Console clicks measure different
 * things and are never combined, which is why this keys off the "paid"
 * category rather than summing whatever happens to share a field name.
 *
 * Ratio metrics (CTR, CPC, CPM, CPA, ROAS) are RECOMPUTED from the summed
 * components. Averaging per-platform ratios would silently weight a £5 campaign
 * the same as a £5,000 one.
 *
 * Currency: if connected ad accounts report in different currencies, summing
 * spend would be meaningless, so `currency` comes back null and callers must
 * omit the monetary figures. Returns null unless at least two paid sources
 * exist — a single source is already shown on its own.
 */
export function aggregatePaidSnapshots(
  entries: { type: string | null | undefined; snapshot: unknown }[]
): PaidAggregate | null {
  const paid = entries
    .map((e) => ({ block: snapshotToBlock(e.type, e.snapshot), snapshot: e.snapshot }))
    .filter((x): x is { block: ReportBlock; snapshot: unknown } => x.block !== null && x.block.category === "paid");

  if (paid.length < 2) return null;

  const sum = (key: string) => paid.reduce((acc, p) => acc + n(at(p.snapshot, "totals", key)), 0);

  const spend = sum("spend");
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const conversions = sum("conversions");
  const revenue = sum("revenue");

  // Every source must report a KNOWN currency and they must all agree. An
  // unknown code is not treated as "probably the same as the others" — that
  // would silently sum a PKR account into a USD total.
  const codes = paid.map((p) => (p.block.currency ?? "").toUpperCase());
  const currency = codes.every(Boolean) && new Set(codes).size === 1 ? codes[0] : null;

  // null, not 0, when the denominator is missing — "no clicks" is not "free".
  const ratio = (num: number, den: number) => (den > 0 ? num / den : null);

  return {
    currency,
    sourceNames: paid.map((p) => p.block.sourceName),
    spend, impressions, clicks, conversions, revenue,
    ctr: ratio(clicks, impressions),
    cpc: ratio(spend, clicks),
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    costPerConversion: ratio(spend, conversions),
    roas: ratio(revenue, spend),
  };
}

const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", GBP: "£", EUR: "€", JPY: "¥", AUD: "A$", CAD: "C$", INR: "₹" };

/**
 * Renders one block value for display. Shared by the on-screen report and any
 * other consumer, so a currency or percentage is formatted identically
 * everywhere. The PDF has its own variant using its typographic number helpers.
 */
export function formatBlockValue(value: number | null, format: BlockFormat, currency: string | null = null): string {
  // A metric with no valid denominator renders as an em dash everywhere —
  // on-screen, in the report and in the PDF.
  if (value === null || !Number.isFinite(value)) return "—";
  const num = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  switch (format) {
    case "percent": return `${(value * 100).toFixed(1)}%`;
    case "currency": {
      const sym = currency ? (CURRENCY_SYMBOLS[currency.toUpperCase()] ?? `${currency.toUpperCase()} `) : "";
      return `${sym}${num(Math.round(value * 100) / 100)}`;
    }
    case "duration": return value >= 60 ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s` : `${Math.round(value)}s`;
    case "position": return value.toFixed(1);
    default: return num(value);
  }
}

/**
 * Serializes blocks into the compact, labelled text the AI prompt consumes.
 * Kept here (next to the projection) so a new shape becomes visible to the model
 * at the same moment it becomes visible to the PDF.
 */
export function blocksToPromptText(blocks: ReportBlock[]): string {
  if (!blocks.length) return "";
  const pctLike = (f: BlockFormat) => f === "percent";
  const fmt = (v: number, f: BlockFormat) =>
    pctLike(f) ? `${(v * 100).toFixed(2)}%` : v.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const parts = blocks.map((b) => {
    const lines: string[] = [`## ${b.sourceName}${b.currency ? ` (amounts in ${b.currency})` : ""}`];

    for (const k of b.kpis) {
      // A KPI with no valid denominator is stated as such. Passing "0" would
      // invite the model to write about a cost per click that never existed.
      // Both changes are printed — percentage and absolute — so the model can
      // cite either without arithmetic of its own, which the post-generation
      // check (lib/ai/verify.ts) would reject. A prior of exactly 0 is a real
      // baseline with no percentage change, not a missing one.
      const lower = k.lowerBetter ? " [lower is better]" : "";
      if (k.value === null) {
        lines.push(`- ${k.label}: not calculable this period (no denominator — e.g. no clicks, spend or impressions)`);
      } else if (k.previous === null) {
        lines.push(`- ${k.label}: ${fmt(k.value, k.format)} (no prior-period baseline)${lower}`);
      } else if (k.previous === 0) {
        lines.push(
          k.value === 0
            ? `- ${k.label}: 0 vs 0 prior (unchanged)${lower}`
            : `- ${k.label}: ${fmt(k.value, k.format)} vs 0 prior (new this period; no percentage change from zero)${lower}`
        );
      } else {
        const delta = pctChange(k.value, k.previous) ?? 0;
        const dir = delta >= 0 ? "+" : "";
        const diff = k.value - k.previous;
        const absText = pctLike(k.format)
          ? `${diff >= 0 ? "+" : "-"}${(Math.abs(diff) * 100).toFixed(2)} percentage points`
          : `${diff >= 0 ? "+" : "-"}${fmt(Math.abs(diff), k.format)}`;
        lines.push(`- ${k.label}: ${fmt(k.value, k.format)} vs ${fmt(k.previous, k.format)} prior (${dir}${delta.toFixed(1)}%, ${absText})${lower}`);
      }
    }

    for (const table of b.tables) {
      if (!table.rows.length) continue;
      lines.push(`${table.title}:`);
      for (const row of table.rows.slice(0, 5)) {
        const cells = table.columns.map((c) => {
          const v = row[c.key];
          return `${c.label} ${typeof v === "number" ? fmt(v, c.format) : `"${promptLabel(v)}"`}`;
        });
        lines.push(`  - ${cells.join(", ")}`);
      }
    }

    for (const note of b.notes) lines.push(`  note: ${note}`);
    return lines.join("\n");
  });

  return parts.join("\n\n");
}
