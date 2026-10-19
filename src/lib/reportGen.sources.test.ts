import { describe, expect, it, vi } from "vitest";
import { createClientReport } from "./reportGen";

// Which sources a report may use, end to end through createClientReport with a
// stubbed database. The fixtures mirror production as audited on 2026-10-12:
// Search Console and Google Ads syncing daily, and a Meta Ads connection that
// was revoked in August but still has its August snapshot.

// Reports are inserted with the service role (migration 0044); route it to
// the same stub so the inserted row is still captured.
const adminDb = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminDb.client }));
vi.mock("@/lib/ai", () => ({
  generateReportInsightsCached: async () => ({ insights: null, cached: true }),
}));
vi.mock("@/lib/usage", () => ({
  trackUsage: async () => {},
  reserveReportGeneration: async () => ({ ok: true, periodMonth: "2026-10-01" }),
  releaseReportGeneration: async () => {},
}));
vi.mock("@/lib/billing/limits", () => ({ checkReportLimit: async () => ({ allowed: true }) }));

const NOW = Date.parse("2026-10-12T12:00:00Z");
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
function range(from: string, to: string) {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(iso(t));
  return out;
}

// 1 click / 10 impressions a day, so a window's clicks equal its length.
const gscSnapshot = (from: string, to: string) => ({
  totals: { clicks: 28, impressions: 280, ctr: 0.1, position: 5 },
  previousTotals: { clicks: 20, impressions: 200, ctr: 0.1, position: 6 },
  topQueries: [], topPages: [], topCountries: [], topDevices: [], movers: null,
  byDate: range(from, to).map((date) => ({ date, clicks: 1, impressions: 10, ctr: 0.1, position: 5 })),
});
const adsSnapshot = (from: string, to: string, spendPerDay: number) => ({
  platform: "x", currency: "USD",
  totals: { spend: spendPerDay * 28, impressions: 2800, clicks: 280, ctr: 0.1, cpc: 0.1, cpm: 1, conversions: 0, costPerConversion: 0, revenue: 0, roas: 0 },
  previousTotals: null,
  byDate: range(from, to).map((date) => ({ date, spend: spendPerDay, impressions: 100, clicks: 10, conversions: 0 })),
  topCampaigns: [],
});

type Source = { id: string; type: string; status: string; config: Record<string, unknown> };
type Snap = { data: unknown; synced_at: string };
type ArchiveRow = { date: string; provider: string; client_id: string; data_source_id: string; metrics: Record<string, number> };

function stub(opts: { sources: Source[]; gsc?: Record<string, Snap>; integrations?: Record<string, Snap>; archive?: ArchiveRow[] }) {
  const inserted: Record<string, unknown>[] = [];
  const archiveFilters: string[][] = [];
  const thenable = (resolveWith: () => unknown, extra: Record<string, unknown> = {}) => {
    const q: Record<string, unknown> = {};
    Object.assign(q, { select: () => q, eq: () => q, in: () => q, order: () => q, ...extra, then: (r: (v: unknown) => void) => r(resolveWith()) });
    return q;
  };

  const from = (name: string) => {
    if (name === "data_sources") return thenable(() => ({ data: opts.sources }));
    if (name === "integration_snapshots") {
      return thenable(() => ({
        data: Object.entries(opts.integrations ?? {}).map(([data_source_id, s]) => ({ data_source_id, ...s })),
      }));
    }
    if (name === "metric_daily") {
      // Deliberately ignores the data-source filter it is given (only records
      // it), so the test proves the generator itself keeps sources apart.
      let lo = "", hi = "", offset = 0;
      const q = thenable(() => ({ data: offset === 0 ? (opts.archive ?? []).filter((r) => r.date >= lo && r.date <= hi) : [], error: null }), {
        in: (_c: string, ids: string[]) => { archiveFilters.push(ids); return q; },
        gte: (_c: string, v: string) => { lo = v; return q; },
        lte: (_c: string, v: string) => { hi = v; return q; },
        range: (start: number) => { offset = start; return q; },
      });
      return q;
    }
    let dsId = "";
    const api: Record<string, unknown> = {};
    Object.assign(api, {
      select: () => api,
      in: () => api,
      is: () => api,
      eq: (col: string, val: string) => { if (col === "data_source_id") dsId = val; return api; },
      maybeSingle: async () => {
        if (name === "clients") return { data: { id: "c1", name: "Acme", archived: false } };
        if (name === "gsc_snapshots") return { data: opts.gsc?.[dsId] ?? null };
        if (name === "ga4_snapshots") return { data: null };
        if (name === "report_templates") return { data: { name: "Report", sections: [] } };
        return { data: null };
      },
      insert: (row: Record<string, unknown>) => { inserted.push(row); return api; },
      single: async () => ({ data: { id: "r1", share_token: "tok" }, error: null }),
    });
    return api;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, inserted, archiveFilters };
}

const SOURCES: Source[] = [
  { id: "ds-gsc", type: "gsc", status: "connected", config: { site_url: "sc-domain:acme.com" } },
  { id: "ds-ads", type: "google_ads", status: "connected", config: {} },
  { id: "ds-meta", type: "meta_ads", status: "revoked", config: {} },
];
const FRESH = "2026-10-12T06:00:00+00:00";
const AUGUST_SYNC = "2026-08-29T06:38:00+00:00";

type Stored = {
  gsc: { totals: { clicks: number }; previousTotals: { clicks: number } | null } | null;
  blocks: { sourceId: string; sourceName?: string; instanceId?: string; notes?: string[]; kpis: { label: string; value: number | null; previous: number | null }[] }[];
  meta: { sourceIds: string[]; sources: { type: string; name?: string; included: boolean; state: string }[] };
};

describe("rolling reports use only sources whose data describes the period", () => {
  const fixture = () =>
    stub({
      sources: SOURCES,
      gsc: { "ds-gsc": { data: gscSnapshot("2026-09-12", "2026-10-09"), synced_at: FRESH } },
      integrations: {
        "ds-ads": { data: adsSnapshot("2026-09-14", "2026-10-11", 10), synced_at: FRESH },
        "ds-meta": { data: adsSnapshot("2026-08-01", "2026-08-28", 99), synced_at: AUGUST_SYNC },
      },
    });

  it("writes the report row with the service role, never through the caller's session", async () => {
    // Migration 0044 takes INSERT on reports away from tenants; the caller's
    // own session must not be the one that writes the row.
    const s = fixture();
    const tenantWrites: string[] = [];
    const tenant = {
      from: (name: string) => {
        const api = s.client.from(name);
        if (name !== "reports") return api;
        return { ...api, insert: () => { tenantWrites.push(name); throw new Error("tenant may not insert reports"); } };
      },
    };
    adminDb.client = s.client;
    const res = await createClientReport(tenant as never, "a1", "c1", { now: NOW, period: "last_28" });
    expect(res.ok).toBe(true);
    expect(tenantWrites).toEqual([]);
    expect(s.inserted).toHaveLength(1);
  });

  it("leaves a revoked source's August figures out of an October report, and says so", async () => {
    const s = fixture();
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "last_28" });
    expect(res.ok).toBe(true);
    const data = s.inserted[0].data as Stored;
    // The stated period is the window the figures cover — Google Ads' (it
    // wins the tie with Search Console as the later one) — not a clock-based
    // 13 Sep – 10 Oct that no source measured exactly.
    expect(s.inserted[0].period_start).toBe("2026-09-14");
    expect(s.inserted[0].period_end).toBe("2026-10-11");

    expect(data.blocks.map((b) => b.sourceId)).toEqual(["google_ads"]);
    expect(data.meta.sourceIds).toEqual(["gsc", "google_ads"]);
    expect(data.meta.sources.find((x) => x.type === "meta_ads")).toMatchObject({ included: false, state: "stale" });
    expect(data.meta.sources.filter((x) => x.included).map((x) => x.type)).toEqual(["gsc", "google_ads"]);
  });

  it("refuses, naming why, when every source is stale", async () => {
    const s = stub({
      sources: [SOURCES[2]],
      integrations: { "ds-meta": { data: adsSnapshot("2026-08-01", "2026-08-28", 99), synced_at: AUGUST_SYNC } },
    });
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "last_28" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Meta Ads is not included: its latest data ends 2026-08-28/);
    expect(s.inserted).toHaveLength(0);
  });
});

describe("rebuilt periods", () => {
  it("compare with the previous period when the daily history covers it", async () => {
    // September 2026, generated 12 Oct: the 90-day cache (14 Jul – 9 Oct)
    // spans both September and August.
    const s = stub({
      sources: [SOURCES[0]],
      gsc: { "ds-gsc": { data: gscSnapshot("2026-07-12", "2026-10-09"), synced_at: FRESH } },
    });
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "previous_month" });
    expect(res.ok).toBe(true);
    const data = s.inserted[0].data as Stored;
    expect(data.gsc!.totals.clicks).toBe(30);
    expect(data.gsc!.previousTotals).toMatchObject({ clicks: 31 });
  });

  it("read only the archive of the report's own sources, never a replaced connection's", async () => {
    // Q3 2026 against Q2: older than the cache, so the archive fills it. A
    // replaced Search Console connection ("ds-old") left 5 clicks a day for
    // the same dates; folding it in would multiply the totals.
    const archive: ArchiveRow[] = [
      ...range("2026-04-01", "2026-07-11").map((date) => ({ date, provider: "gsc", client_id: "c1", data_source_id: "ds-gsc", metrics: { clicks: 1, impressions: 10, ctr: 0.1, position: 5 } })),
      ...range("2026-04-01", "2026-09-30").map((date) => ({ date, provider: "gsc", client_id: "c1", data_source_id: "ds-old", metrics: { clicks: 5, impressions: 50, ctr: 0.1, position: 5 } })),
    ];
    const s = stub({
      sources: [SOURCES[0]],
      gsc: { "ds-gsc": { data: gscSnapshot("2026-07-12", "2026-10-09"), synced_at: FRESH } },
      archive,
    });
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "previous_quarter" });
    expect(res.ok).toBe(true);
    const data = s.inserted[0].data as Stored;
    expect(s.archiveFilters).toEqual([["ds-gsc"]]);
    expect(data.gsc!.totals.clicks).toBe(92); // 1 Jul – 30 Sep
    expect(data.gsc!.previousTotals).toMatchObject({ clicks: 91 }); // Q2
  });

  it("report an ad account that spent nothing as zero spend, not as missing data", async () => {
    // Production case: LinkedIn, Snapchat and Google Ads connected and syncing
    // with no spend. Their all-zero daily lines aren't charted, and rebuilding
    // from the charted lines used to call them "no stored data yet".
    const s = stub({
      sources: [SOURCES[0], SOURCES[1]],
      gsc: { "ds-gsc": { data: gscSnapshot("2026-07-12", "2026-10-09"), synced_at: FRESH } },
      integrations: { "ds-ads": { data: { ...adsSnapshot("2026-07-14", "2026-10-11", 0), byDate: range("2026-07-14", "2026-10-11").map((date) => ({ date, spend: 0, impressions: 0, clicks: 0, conversions: 0 })) }, synced_at: FRESH } },
    });
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "previous_month" });
    expect(res.ok).toBe(true);
    const data = s.inserted[0].data as Stored;
    expect(data.meta.sources.find((x) => x.type === "google_ads")).toMatchObject({ included: true, state: "ok" });
    const ads = data.blocks.find((b) => b.sourceId === "google_ads")!;
    expect(ads.kpis.find((k) => k.label === "Spend")).toMatchObject({ value: 0 });
    expect(ads.kpis.find((k) => k.label === "CPC")).toMatchObject({ value: null });
    expect(ads.notes).toEqual(["No ads ran in this period."]);
  });

  it("include a revoked source's history for a past period it covers", async () => {
    // August is a period Meta Ads DID measure before it was revoked.
    const s = stub({
      sources: [SOURCES[2]],
      integrations: { "ds-meta": { data: adsSnapshot("2026-07-14", "2026-08-28", 10), synced_at: AUGUST_SYNC } },
    });
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "custom", customStart: "2026-08-01", customEnd: "2026-08-28" });
    expect(res.ok).toBe(true);
    const data = s.inserted[0].data as Stored;
    expect(data.blocks[0].kpis.find((k) => k.label === "Spend")).toMatchObject({ value: 280 });
    expect(data.meta.sources[0]).toMatchObject({ type: "meta_ads", included: true, state: "ok" });
  });
});

describe("two accounts of one platform (migration 0049)", () => {
  const twoMeta = (stale = false) =>
    stub({
      sources: [
        { id: "ds-uk", type: "meta_ads", status: "connected", config: { accounts: [{ id: "act_1", name: "Acme UK" }], account_id: "act_1" } },
        { id: "ds-us", type: "meta_ads", status: "connected", config: { accounts: [{ id: "act_2", name: "Acme US" }], account_id: "act_2" } },
      ],
      integrations: {
        "ds-uk": { data: adsSnapshot("2026-09-14", "2026-10-11", 10), synced_at: FRESH },
        "ds-us": stale
          ? { data: adsSnapshot("2026-08-01", "2026-08-28", 99), synced_at: AUGUST_SYNC }
          : { data: adsSnapshot("2026-09-14", "2026-10-11", 20), synced_at: FRESH },
      },
    });

  it("reports each account as its own section, named by account", async () => {
    const s = twoMeta();
    adminDb.client = s.client;
    const res = await createClientReport(s.client, "a1", "c1", { now: NOW, period: "last_28" });
    expect(res.ok).toBe(true);
    const data = s.inserted[0].data as Stored;
    expect(data.blocks.map((b) => [b.sourceId, b.instanceId, b.sourceName])).toEqual([
      ["meta_ads", "ds-uk", "Meta Ads · Acme UK"],
      ["meta_ads", "ds-us", "Meta Ads · Acme US"],
    ]);
    // Each keeps its own figures; nothing is mixed between the two.
    const spend = (i: number) => data.blocks[i].kpis.find((k) => k.label === "Spend")?.value;
    expect([spend(0), spend(1)]).toEqual([280, 560]);
    // The platform is named once among the report's sources.
    expect(data.meta.sourceIds).toEqual(["meta_ads"]);
  });

  it("names the account when one of the two is left out", async () => {
    const s = twoMeta(true);
    adminDb.client = s.client;
    await createClientReport(s.client, "a1", "c1", { now: NOW, period: "last_28" });
    const data = s.inserted[0].data as Stored;
    expect(data.meta.sources.map((x) => [x.name, x.included])).toEqual([
      ["Meta Ads · Acme UK", true],
      ["Meta Ads · Acme US", false],
    ]);
  });

  it("leaves a single-account report exactly as before", async () => {
    const s = stub({
      sources: [{ id: "ds-uk", type: "meta_ads", status: "connected", config: { accounts: [{ id: "act_1", name: "Acme UK" }], account_id: "act_1" } }],
      integrations: { "ds-uk": { data: adsSnapshot("2026-09-14", "2026-10-11", 10), synced_at: FRESH } },
    });
    adminDb.client = s.client;
    await createClientReport(s.client, "a1", "c1", { now: NOW, period: "last_28" });
    const data = s.inserted[0].data as Stored;
    expect(data.blocks[0]).toMatchObject({ sourceId: "meta_ads", sourceName: "Meta Ads" });
    expect(data.blocks[0]).not.toHaveProperty("instanceId");
  });
});
