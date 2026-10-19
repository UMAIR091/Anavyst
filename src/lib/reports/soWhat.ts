// The "So What?" layer: what the numbers MEAN, and what to do next.
//
// A client report full of figures still leaves the reader asking "and?". This
// turns measured signals into an interpretation and a next step — without
// inventing anything.
//
// The honesty rule, and how it is enforced structurally:
//   · Every FIGURE comes from `detectSignals` / the report blocks, which
//     compute over the client's own rows. Nothing here calculates a metric.
//   · Every INTERPRETATION is a fixed editorial line keyed to the KIND of
//     pattern that was measured — not generated prose. "Clicks fell 32%" is
//     the measurement; "demand or visibility changed, worth diagnosing before
//     it compounds" is the standing meaning of a traffic drop. The mapping is
//     the same for every client, so it can never become a claim about this
//     client that the data doesn't support.
//   · Every action carries the measurement that motivated it, so a reader can
//     always trace a recommendation back to a number in the report.
//
// Priority is derived from the signal's own confidence and weight, never from
// its position in a list.
import type { Signal, Confidence } from "@/lib/insights/signals";
import type { BlockKpi, ReportBlock } from "@/lib/integrations/blocks";
import { blockKey, formatBlockValue } from "@/lib/integrations/blocks";

export type Priority = "High" | "Medium" | "Low";

export type SoWhat = {
  /** The measured fact, as reported by the signal. */
  observation: string;
  /** What that kind of movement means. Fixed per pattern, never generated. */
  meaning: string;
  /** The headline figure and where it came from. */
  metric: string;
  source: string;
  confidence: Confidence;
  confidenceReason: string;
};

/**
 * Whether a step addresses something going wrong or builds on something going
 * right. Recorded explicitly because a recommendation engine that only reads
 * problems produces a report that reads as a list of faults even when the data
 * shows a channel working — and because "protect what is working" is a real
 * recommendation, not filler.
 */
export type ActionKind = "risk" | "opportunity";

export type RecommendedAction = {
  action: string;
  /** The measurement behind it — always a real figure from the report. */
  because: string;
  priority: Priority;
  source: string;
  kind: ActionKind;
};

// What each measured pattern means. Deliberately general: these describe the
// pattern, not the client, so they stay true whatever the numbers are.
//
// Each line is an implication of the measurement it is attached to and nothing
// more. Earlier versions reached past the data — "declines usually compound as
// competitors consolidate the position" asserts a general market behaviour the
// report never measured, and "terms already moving up respond best to further
// investment" is a claim about marketing in general rather than about this
// client. Both are gone: what remains states what the measured pattern implies
// for the account in front of the reader.
const MEANING: Record<Signal["kind"], string> = {
  winning_keyword:
    "The page behind this term is already ranking and gaining clicks, so building on it extends something measured rather than testing something new.",
  declining_keyword:
    "The fall is in this site's own measured performance, not a new baseline — what changed on the page, and in its ranking, is what to establish.",
  winning_page:
    "One page carries a disproportionate share of the traffic recorded here: the site's most exposed asset, and its clearest working example to copy.",
  opportunity:
    "The audience is reaching this listing and not choosing it, so the gap is in the listing itself rather than in visibility.",
  traffic_spike:
    "The day sits outside this site's own daily variation, so something specific caused it — identifying what makes it repeatable.",
  traffic_drop:
    "The day sits outside this site's own daily variation, so demand, visibility or tracking changed — which of the three determines the fix.",
  conversion_opportunity:
    "Sessions are arriving but conversions are not following at the same rate, so the constraint is the path through the site, not the volume reaching it.",
};

/** Whether each pattern is a problem to fix or a position to build on. */
const KIND: Record<Signal["kind"], ActionKind> = {
  winning_keyword: "opportunity",
  declining_keyword: "risk",
  winning_page: "opportunity",
  opportunity: "opportunity",
  traffic_spike: "opportunity",
  traffic_drop: "risk",
  conversion_opportunity: "risk",
};

// The next step each pattern calls for.
const ACTION: Record<Signal["kind"], string> = {
  winning_keyword: "Expand the content behind this term and add internal links to it while it has momentum.",
  declining_keyword: "Review what changed on this page and in the results for this term, then refresh it.",
  winning_page: "Apply what works on this page to comparable pages, and protect it from unrelated changes.",
  opportunity: "Rewrite the title and meta description for this listing to earn more of the impressions it already has.",
  traffic_spike: "Identify the source of the increase and decide whether it can be repeated.",
  traffic_drop: "Check tracking first, then rankings and seasonality, to confirm the cause before reacting.",
  conversion_opportunity: "Review the conversion path for the highest-traffic landing pages.",
};

/** High confidence and heavy weight are what make something urgent. */
function priorityOf(sig: Signal): Priority {
  if (sig.confidence === "high" && sig.weight >= 60) return "High";
  if (sig.confidence === "low") return "Low";
  return sig.confidence === "high" || sig.weight >= 40 ? "Medium" : "Low";
}

const RANK: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };

// Something going wrong leads something going right at the same priority. A
// client reading a report wants the problem first; the opportunity beside it is
// what to do with the budget once the problem is understood.
const KIND_RANK: Record<ActionKind, number> = { risk: 0, opportunity: 1 };

const byPriority = (a: RecommendedAction, b: RecommendedAction) =>
  RANK[a.priority] - RANK[b.priority] || KIND_RANK[a.kind] - KIND_RANK[b.kind];

/**
 * The interpretation layer. One entry per measured signal, strongest first,
 * capped so the opening page stays readable in about a minute.
 */
export function buildSoWhat(signals: Signal[], limit = 3): SoWhat[] {
  return signals.slice(0, limit).map((sig) => ({
    observation: sig.detail,
    meaning: MEANING[sig.kind],
    metric: sig.metric,
    source: sig.source,
    confidence: sig.confidence,
    confidenceReason: sig.confidenceReason,
  }));
}

/**
 * Evidence-backed next steps. Each is tied to the signal that motivated it, so
 * "why are you telling me this?" is answerable from the report itself.
 *
 * De-duplicated by action text: three winning keywords produce one "expand the
 * content" step, not three near-identical ones.
 */
export function buildActions(signals: Signal[], limit = 4): RecommendedAction[] {
  const seen = new Set<string>();
  const out: RecommendedAction[] = [];

  for (const sig of signals) {
    const action = ACTION[sig.kind];
    if (!action || seen.has(action)) continue;
    seen.add(action);
    out.push({ action, because: sig.detail, priority: priorityOf(sig), source: sig.source, kind: KIND[sig.kind] });
  }

  return out.sort(byPriority).slice(0, limit);
}

/**
 * What the Recommended actions section says when the data produced nothing.
 *
 * Previously the section simply did not render, which reads as an omission
 * rather than a finding: the client cannot tell whether the report had no
 * advice or forgot to give any. Every step in this report is tied to a
 * measurement, so when no measurement clears the bar the honest output is to
 * say that plainly and recommend waiting — not to soften a weak signal into a
 * recommendation to fill the space.
 */
export const NO_EVIDENCE_NOTE =
  "No optimization decision should be made on this period's data yet: nothing measured here is strong enough to tie a recommendation to. A further period of data is needed before this report can recommend a change.";
/** Reads a KPI by label, case-insensitively. */
function kpiOf(b: ReportBlock, label: string): BlockKpi | undefined {
  return b.kpis.find((k) => k.label.toLowerCase() === label.toLowerCase());
}

/** A KPI's value when it is genuinely calculable, else null. */
function val(k: BlockKpi | undefined): number | null {
  return k?.value != null && Number.isFinite(k.value) ? k.value : null;
}

/**
 * Cost per conversion for a paid block, preferring the platform's own figure
 * and falling back to spend ÷ conversions — which is the same arithmetic the
 * report already shows, not a new estimate.
 */
function costPerConversion(b: ReportBlock): number | null {
  const reported = val(kpiOf(b, "Cost per conversion"));
  if (reported != null && reported > 0) return reported;
  const spend = val(kpiOf(b, "Spend"));
  const conv = val(kpiOf(b, "Conversions"));
  if (spend != null && spend > 0 && conv != null && conv > 0) return spend / conv;
  return null;
}

/**
 * The best row of a channel's own campaign table, by conversions where the
 * table reports them and by spend otherwise. Returns nothing unless there is a
 * table with at least two rows — "the top campaign" of a single-row table is
 * not a finding.
 */
function topCampaign(b: ReportBlock): { name: string; conversions: number | null; spend: number | null } | null {
  const table = b.tables.find((t) => /campaign/i.test(t.title) && t.rows.length >= 2);
  if (!table) return null;
  const numberAt = (row: Record<string, string | number>, key: string): number | null => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const rows = table.rows
    .map((r) => ({
      name: typeof r.name === "string" ? r.name : null,
      conversions: numberAt(r, "conversions"),
      spend: numberAt(r, "spend"),
    }))
    .filter((r): r is { name: string; conversions: number | null; spend: number | null } => !!r.name && r.name !== "—");
  if (rows.length < 2) return null;
  const byConversions = rows.filter((r) => (r.conversions ?? 0) > 0).sort((a, z) => (z.conversions ?? 0) - (a.conversions ?? 0));
  if (byConversions.length > 0) return byConversions[0];
  const bySpend = rows.filter((r) => (r.spend ?? 0) > 0).sort((a, z) => (z.spend ?? 0) - (a.spend ?? 0));
  return bySpend[0] ?? null;
}

/**
 * Measured checks over non-Google channels, where `detectSignals` doesn't
 * reach. Each is a plain arithmetic fact about the block's own KPIs — spend
 * with nothing to show for it, clicks that never convert, a return the platform
 * itself reports — not a model's opinion. Returns nothing when the components
 * aren't present, so a channel without conversion tracking is never accused of
 * failing to convert, and a channel with no reported return is never called
 * efficient.
 *
 * Both halves matter. An engine that only fires on problems produces a report
 * that reads as a list of faults even for an account where a channel is plainly
 * working, and leaves the two questions a client asks about a working channel —
 * do we protect it, do we scale it — unanswered.
 */
export function blockActions(blocks: ReportBlock[]): RecommendedAction[] {
  const out: RecommendedAction[] = [];

  // The paid channel carrying the most budget. Used to keep the campaign-level
  // step to one, on the account where it matters most.
  const heaviestPaidId = blocks
    .filter((b) => b.category === "paid")
    .map((b) => ({ id: blockKey(b), spend: val(kpiOf(b, "Spend")) ?? 0 }))
    .sort((a, z) => z.spend - a.spend)[0]?.id;

  for (const b of blocks) {
    if (b.category !== "paid") continue;
    const spend = kpiOf(b, "Spend");
    const conversions = kpiOf(b, "Conversions");
    const clicks = kpiOf(b, "Clicks");
    const money = (v: number) => formatBlockValue(v, "currency", b.currency);
    const spendValue = val(spend);

    // Spend recorded, conversions tracked as a metric, and none of them landed.
    if (spendValue != null && spendValue > 0 && conversions?.value === 0) {
      out.push({
        action: `Confirm conversion tracking is firing for ${b.sourceName}, then review targeting and landing pages.`,
        because: `${b.sourceName} recorded ${money(spendValue)} of spend and no conversions in this period.`,
        priority: "High",
        source: b.sourceName,
        kind: "risk",
      });
      continue;
    }

    // Money spent, and not a single click to show for it.
    if (spendValue != null && spendValue > 0 && clicks?.value === 0) {
      out.push({
        action: `Review creative and targeting for ${b.sourceName} — the ads are being served but not clicked.`,
        because: `${b.sourceName} recorded ${money(spendValue)} of spend and no clicks in this period.`,
        priority: "High",
        source: b.sourceName,
        kind: "risk",
      });
      continue;
    }

    // ── The channel is working: what to do about that ──
    const conv = val(conversions);
    if (spendValue == null || spendValue <= 0 || conv == null || conv <= 0) continue;

    const roas = val(kpiOf(b, "ROAS"));
    const cpa = costPerConversion(b);
    const prevCpa = kpiOf(b, "Cost per conversion")?.previous ?? null;

    // A return the platform itself reports, above break-even on its own figures.
    if (roas != null && roas >= 2) {
      out.push({
        action: `Hold or increase ${b.sourceName} budget while the return holds, and re-check against the same figures next period.`,
        because: `${b.sourceName} returned ${roas.toFixed(1)}x on ${money(spendValue)} of spend across ${conv.toLocaleString()} conversions.`,
        priority: roas >= 3 ? "High" : "Medium",
        source: b.sourceName,
        kind: "opportunity",
      });
    } else if (cpa != null && prevCpa != null && prevCpa > 0 && cpa < prevCpa * 0.9) {
      // Efficiency improved on the platform's own before-and-after figures.
      const improvement = ((prevCpa - cpa) / prevCpa) * 100;
      out.push({
        action: `Keep ${b.sourceName} at its current budget and identify what drove the improvement, so it can be applied elsewhere.`,
        because: `${b.sourceName} brought cost per conversion down ${improvement.toFixed(0)}% to ${money(cpa)} while producing ${conv.toLocaleString()} conversions.`,
        priority: "Medium",
        source: b.sourceName,
        kind: "opportunity",
      });
    }

    // The channel's own strongest campaign, named from its own table. Emitted
    // for the heaviest-spending channel only — one per channel produced a run of
    // near-identical "review the top campaign" steps that crowded out the rest.
    if (blockKey(b) === heaviestPaidId) {
      const top = topCampaign(b);
      if (top) {
        const evidence =
          top.conversions != null && top.conversions > 0
            ? `“${top.name}” was the highest-converting campaign on ${b.sourceName}, with ${top.conversions.toLocaleString()} conversions${top.spend != null && top.spend > 0 ? ` on ${money(top.spend)} of spend` : ""}.`
            : `“${top.name}” took the largest share of ${b.sourceName} spend at ${money(top.spend ?? 0)}.`;
        out.push({
          action: `Use “${top.name}” as the reference for the rest of the ${b.sourceName} account before changing budget.`,
          because: evidence,
          priority: "Medium",
          source: b.sourceName,
          kind: "opportunity",
        });
      }
    }
  }

  // ── Across channels: the same outcome at two different prices ──
  // Only ever stated when both channels report a cost per conversion, and only
  // when the gap is large enough to be worth acting on rather than noise.
  const priced = blocks
    .filter((b) => b.category === "paid")
    .map((b) => ({ b, cpa: costPerConversion(b) }))
    .filter((x): x is { b: ReportBlock; cpa: number } => x.cpa != null && x.cpa > 0)
    .sort((a, z) => a.cpa - z.cpa);
  if (priced.length >= 2) {
    const cheap = priced[0];
    const dear = priced[priced.length - 1];
    if (dear.cpa >= cheap.cpa * 1.25) {
      const gap = ((dear.cpa - cheap.cpa) / dear.cpa) * 100;
      out.push({
        action: `Test moving part of the ${dear.b.sourceName} budget to ${cheap.b.sourceName} and compare cost per conversion again next period.`,
        because: `${cheap.b.sourceName} bought a conversion for ${formatBlockValue(cheap.cpa, "currency", cheap.b.currency)} against ${formatBlockValue(dear.cpa, "currency", dear.b.currency)} on ${dear.b.sourceName} — ${gap.toFixed(0)}% cheaper for the same outcome.`,
        // A gap this wide is a budget decision rather than a note, and the
        // figure behind it is the platforms' own cost per conversion.
        priority: gap >= 40 ? "High" : "Medium",
        source: `${cheap.b.sourceName} · ${dear.b.sourceName}`,
        kind: "opportunity",
      });
    }
  }

  return out;
}

/**
 * Observations from non-Google channels.
 *
 * `detectSignals` only reaches Search Console and Analytics, so a paid-media
 * or commerce report produced no interpretation at all — the "so what" layer
 * was simply absent from exactly the reports that most needed it. These are
 * plain readings of the block's own KPIs: what was spent, what came back, and
 * whether the two are consistent. No figure is computed here that the block
 * didn't already carry, and a KPI that is null (not calculable) is skipped
 * rather than read as zero.
 */
export function blockSoWhat(blocks: ReportBlock[], limit = 2): SoWhat[] {
  const out: SoWhat[] = [];

  for (const b of blocks) {
    const kpi = (label: string) => b.kpis.find((k) => k.label.toLowerCase() === label.toLowerCase());
    const money = (v: number) => formatBlockValue(v, "currency", b.currency);
    const spend = kpi("Spend")?.value ?? null;
    const clicks = kpi("Clicks")?.value ?? null;
    const conversions = kpi("Conversions")?.value ?? null;
    const impressions = kpi("Impressions")?.value ?? null;

    if (spend != null && spend > 0 && conversions === 0) {
      out.push({
        observation: `${b.sourceName} spent ${money(spend)} and recorded no conversions in this period.`,
        meaning:
          "Either conversions are not being tracked back to the ads, or the traffic is not converting — which of the two changes the fix entirely, so confirm it before adjusting budget.",
        metric: money(spend),
        source: b.sourceName,
        confidence: "high",
        confidenceReason: "Spend and conversion counts are reported directly by the platform.",
      });
      continue;
    }

    if (spend != null && spend > 0 && impressions != null && impressions > 0 && clicks === 0) {
      out.push({
        observation: `${b.sourceName} served ${impressions.toLocaleString()} impressions for ${money(spend)} and received no clicks.`,
        meaning:
          "The ads are being shown but not acted on, which points at creative or audience match rather than budget or delivery.",
        metric: `0 clicks`,
        source: b.sourceName,
        confidence: "high",
        confidenceReason: "Impressions and clicks are reported directly by the platform.",
      });
      continue;
    }

    if (spend != null && spend > 0 && conversions != null && conversions > 0) {
      const cpa = spend / conversions;
      const roas = val(kpiOf(b, "ROAS"));
      const revenue = val(kpiOf(b, "Revenue"));
      out.push({
        observation:
          `${b.sourceName} produced ${conversions.toLocaleString()} conversions from ${money(spend)} of spend at ${money(cpa)} each` +
          (roas != null && roas > 0
            ? `, a reported return of ${roas.toFixed(1)}x${revenue != null && revenue > 0 ? ` on ${money(revenue)} of revenue` : ""}.`
            : `.`),
        meaning:
          roas != null && roas >= 2
            ? "The channel returns more than it costs on the platform's own figures, so the open question is how much further to fund it — and what in the account is producing that result."
            : "The channel converts, so the open question is efficiency rather than whether it works — compare the cost per conversion above against the same outcome bought elsewhere.",
        metric: `${money(cpa)} per conversion`,
        source: b.sourceName,
        confidence: "high",
        confidenceReason: "Both figures come from the platform's own reporting for this period.",
      });
    }
  }

  return out.slice(0, limit);
}

/**
 * Everything the report can honestly interpret, Google sources first.
 *
 * The Google signals used to fill the limit on their own, so a cross-channel
 * report interpreted its Search Console and Analytics figures and said nothing
 * at all about the paid channels it also contained. One slot is now reserved for
 * a channel-derived reading whenever there is one, so every source the report
 * carries is represented in the layer that explains it.
 */
export function allSoWhat(signals: Signal[], blocks: ReportBlock[], limit = 3): SoWhat[] {
  const fromSignals = buildSoWhat(signals, limit);
  const fromBlocks = blockSoWhat(blocks, limit);
  if (limit <= 0) return [];
  if (fromSignals.length + fromBlocks.length <= limit) return [...fromSignals, ...fromBlocks];
  if (fromBlocks.length === 0) return fromSignals.slice(0, limit);
  // Keep the strongest signals, then hand the last place to a channel.
  return [...fromSignals.slice(0, limit - 1), fromBlocks[0]];
}

/**
 * Merges signal-derived and channel-derived actions, strongest first.
 *
 * Priority still decides the order, but the cut is not purely by priority: a
 * report whose problems happen to outnumber the limit would otherwise drop
 * every opportunity, which is how the engine came to read as a list of faults
 * on accounts where a channel was working. So when the slice would contain no
 * opportunity and one was actually measured, the weakest step in the slice
 * gives up its place. Nothing is invented to fill the slot — if the data
 * produced no opportunity, none appears.
 */
export function allActions(signals: Signal[], blocks: ReportBlock[], limit = 4): RecommendedAction[] {
  const merged = [...blockActions(blocks), ...buildActions(signals, limit + 2)];

  // De-duplicate by step text: two channels can motivate the same instruction.
  const seen = new Set<string>();
  const unique = merged.filter((a) => {
    const k = a.action.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const ranked = unique.sort(byPriority);
  if (limit <= 0) return [];
  const head = ranked.slice(0, limit);
  if (head.some((a) => a.kind === "opportunity")) return head;

  // head shorter than the limit means it already holds every ranked step, so
  // the absence of an opportunity there is the absence of one entirely.
  const opportunity = ranked.find((a) => a.kind === "opportunity");
  if (!opportunity) return head;

  // Swap out the last (lowest-priority) step rather than extending the list.
  return [...head.slice(0, limit - 1), opportunity];
}
