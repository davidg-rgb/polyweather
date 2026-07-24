/**
 * scripts/research/convergence-capture-score — the MARKET-SIGNAL selection variant of the bracket-EXIT scorer
 * (docs/ops/CONVERGENCE-CAPTURE-HANDOFF.md, 2026-07-24).
 *
 * WHAT IT CHANGES vs `opening-bracket-score.ts` — exactly two things:
 *   1. It reads the ON-DISK ARCHIVES (the only historical bid/ask book we have) instead of the live
 *      `opening_captures` table, which storage tiering prunes to ~2 days. BOTH archives are merged by default —
 *      the primary plus the older c96-20260707 dump, which contributes genuine pre-07-06 events the primary
 *      never captured. The primary WINS every event_id collision (`--dir` pins a single archive).
 *   2. It makes the bucket SELECTION rule swappable. Every prior convergence run bought `argmax(houseProb)` —
 *      OUR forecast's mode. This one can buy the bucket the MARKET points to (`--select M1..M4`). The entry cap,
 *      depth floor, runway, centerHalfWidth, exit bracket, cost model and the frozen §9R-E gate are IDENTICAL —
 *      selection is the only moving part, which is what makes the comparison clean.
 *
 * THE SELECT RULES (each returns a bucket idx from ticks[0..i] ONLY — no look-ahead; the engine hands the rule a
 * sliced copy that physically cannot contain a future tick):
 *   M0  control      — null ⇒ the frozen forecast argmax(houseProb).
 *   M1  bid-leader   — max `bestBid` among buckets still cheap enough to buy (execAsk ≤ maxEntryPrice). "Bet
 *                      where the book's money already leans, while it is still cheap."
 *   M2  market-mode  — max `mid`: the market's own implied-probability mode, unconstrained by our price cap
 *                      (the entry cap still applies downstream, so an expensive mode simply never fills).
 *   M3  floor-adjacent — the bucket immediately ABOVE the market-implied floor. ⚠ DOCUMENTED SUBSTITUTE: the
 *                      handoff's ideal is the per-tick OBSERVED running-max floor, which is NOT in the archive
 *                      rows (they carry only the book), so the floor is derived from bid mass: `f` = the highest
 *                      idx with `bestBid ≥ 0.90` (a bucket the market treats as already-cleared), and failing
 *                      that the lowest idx with a finite `mid` (the coldest quoted rung); target = f + 1, clamped
 *                      to the ladder. BE HONEST ABOUT ITS WEAKNESS: this ladder is winner-take-all, not
 *                      cumulative, so a ≥0.90 bid means "the market already picked this bucket" — and at the
 *                      cheap early ticks this rule is designed for, essentially no bucket is bid that high, so
 *                      in practice M3 degenerates to "one above the coldest quoted rung". Read its result as
 *                      that rule, not as a true floor-tracker.
 *   M4  momentum     — max STRICTLY POSITIVE (bestBid at tick i − bestBid at tick i−K), K = min(i, 5), among
 *                      buckets with execAsk ≤ maxEntryPrice at tick i. ⚠ NOT LIKE-FOR-LIKE: it is silent at
 *                      i = 0, so it baselines on tick 1 and enters no earlier than tick 2 while M0–M3 enter on
 *                      tick 1 — its result confounds entry TIMING with selection. See RULE_CAVEATS.
 *
 * RULE-SILENT POLICY. For M1–M4 a null from the rule means DO NOT ENTER THIS TICK (`requireRuleTarget`), never
 * 'fall back to the forecast argmax' — a fallback would blend the market arm with the M0 control precisely where
 * the market rule is weakest, and the blend would be invisible in the result. M0 IS the forecast arm, so the
 * policy is moot there.
 *
 * `--house-edge off` additionally drops the model-edge requirement (`execAsk ≤ houseProb − entryEdgeMargin`) and
 * prices the reservation at the hard `maxEntryPrice` cap alone. That is REQUIRED for an honest market-signal run:
 * the bucket the book points to routinely has no houseProb at all, and gating it on our model would silently
 * re-introduce the forecast selection the run exists to remove. (One residual coupling, stated plainly: with
 * `tpAtModelProb` on, a bucket that DOES carry a houseProb can still take profit at that prob. It is left in so
 * the exit rule stays byte-identical to the control.)
 *
 * VERDICT + RIGOR. Per swept TP the FROZEN §9R-E `openingVerdict` runs on the real-book panel; the HEADLINE is
 * the pre-registered `tpDeltaPp = 0.25` row. Selecting the best TP *or* the best select-rule in-sample is the
 * winner's-curse — `--train-frac` / `--split-date` produce the by-date OOS split, and a rule is chosen by max
 * `ciLow`, never max point estimate. A positive point estimate whose CI includes 0 is a KILL. This script
 * decides NOTHING about capital.
 *
 * THE `--out` ARTIFACT CARRIES THE PER-TRADE POPULATION, not just aggregates: `tradeRows` is one row per EXECUTED
 * trade per swept TP, including the FILL-tick book (`entryExecBid`, `entrySellbackDepthUsd`) and the resolution
 * (`winnerIdx`, `bucketWon`). That is deliberate — it makes two further arms pure ARITHMETIC over the SAME executed
 * population rather than a second engine: the INVERSE-SIDE arm (buy NO at `1 − entryExecBid`, capacity-checked
 * against the YES bid-side depth) and the HOLD-TO-RESOLUTION arm (settle at `bucketWon` instead of selling into the
 * convergence). Identical selection, identical gates, inverse side ⇒ a clean comparison. Rows whose `winnerIdx` is
 * null are UNRESOLVED and must be dropped from win-rate arithmetic, never scored as losses (`nUnknownResolution`
 * reports how many that is). See the TradeRow doc comment for the exact formulas.
 *
 * Read-only. Reads the archive + `market_events`; writes only the `--out` JSON artifact. Never places an order,
 * never imports packages/trading, never reads credentials.
 *
 * Run:
 *   pnpm tsx scripts/research/convergence-capture-score.ts --select M1 --house-edge off --cities bot \
 *     --fee-rate 0.05 --out scripts/research/out/convergence-capture-M1.json
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import {
  replayEvent,
  replayPanel,
  type BracketPanel,
  type BracketTrade,
  type EventReplayInput,
  type ReplayTick,
} from '../../packages/core/src/sim/opening-bracket-replay.ts';
import {
  BOT_DEFAULTS,
  type OpeningBucket,
  type OpeningCfg,
} from '../../packages/core/src/sim/opening-convergence.ts';
import { loadArchiveEvents, DEFAULT_ARCHIVE_DIRS, type ArchiveLoadStats } from './opening-captures-archive-ingest.ts';

export const SCRIPT = 'convergence-capture-score';

export const DEFAULT_FEE_RATE = 0.05;
export const DEFAULT_MIN_DEPTH_USD = 50;
export const DEFAULT_TPS = [0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25];

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const signedPct = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${pct(v)}` : '—');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');
const meanOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · the select rules (pure, exported, testable — each reads ticks[0..i] ONLY)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type SelectRuleId = 'M0' | 'M1' | 'M2' | 'M3' | 'M4';
export const SELECT_RULES: readonly SelectRuleId[] = ['M0', 'M1', 'M2', 'M3', 'M4'];
export type SelectRule = (ticks: ReplayTick[], i: number) => number | null;

/** the bucket bid a rule ranks on (missing quote ⇒ not a candidate). */
const bucketsAt = (ticks: ReplayTick[], i: number): OpeningBucket[] => {
  const t = ticks[i];
  return t && Array.isArray(t.buckets) ? t.buckets : [];
};

/** M0 — the control: defer to the engine's frozen forecast argmax(houseProb). */
export const ruleM0: SelectRule = () => null;

/**
 * M1 — bid-leader: max `bestBid` among buckets that are still CHEAP (finite execAsk ≤ maxEntryPrice).
 * Ties → higher `mid`, then lower idx (deterministic).
 */
export function makeRuleM1(maxEntryPrice: number): SelectRule {
  return (ticks, i) => {
    let best: OpeningBucket | null = null;
    for (const b of bucketsAt(ticks, i)) {
      if (!fin(b.bestBid)) continue;
      if (!fin(b.execAsk) || b.execAsk > maxEntryPrice) continue;
      if (best == null) { best = b; continue; }
      const bb = best.bestBid as number;
      if (b.bestBid > bb) best = b;
      else if (b.bestBid === bb) {
        const bm = fin(best.mid) ? best.mid : -Infinity;
        const cm = fin(b.mid) ? b.mid : -Infinity;
        if (cm > bm || (cm === bm && b.idx < best.idx)) best = b;
      }
    }
    return best ? best.idx : null;
  };
}

/** M2 — market-mode: argmax of `mid` over every bucket carrying a two-sided quote. Ties → lower idx. */
export const ruleM2: SelectRule = (ticks, i) => {
  let best: OpeningBucket | null = null;
  for (const b of bucketsAt(ticks, i)) {
    if (!fin(b.mid)) continue;
    if (best == null || b.mid > (best.mid as number) || (b.mid === best.mid && b.idx < best.idx)) best = b;
  }
  return best ? best.idx : null;
};

/** the ≥ this bestBid a bucket must show for M3 to treat it as already-cleared by the market. */
export const M3_FLOOR_BID = 0.9;

/** M3 — floor-adjacent (see the header's DOCUMENTED SUBSTITUTE caveat: derived from bid mass, not an observed floor). */
export const ruleM3: SelectRule = (ticks, i) => {
  const buckets = bucketsAt(ticks, i);
  if (buckets.length === 0) return null;
  let floorIdx: number | null = null;
  for (const b of buckets) {
    if (fin(b.bestBid) && b.bestBid >= M3_FLOOR_BID && (floorIdx == null || b.idx > floorIdx)) floorIdx = b.idx;
  }
  if (floorIdx == null) {
    for (const b of buckets) {
      if (fin(b.mid) && (floorIdx == null || b.idx < floorIdx)) floorIdx = b.idx;
    }
  }
  if (floorIdx == null) return null;
  const idxs = buckets.map((b) => b.idx).filter((n) => Number.isFinite(n));
  if (idxs.length === 0) return null;
  return Math.min(Math.max(floorIdx + 1, Math.min(...idxs)), Math.max(...idxs));
};

/**
 * M4 — momentum over a K = min(i, 5) look-back on `bestBid`, among buckets still cheap at tick i.
 *
 * ⚠ NOT A LIKE-FOR-LIKE SELECTION SWAP, and it cannot be made into one. Momentum needs a prior tick, so M4 is
 * structurally silent at i = 0 — which is the tick M0–M3 essentially always enter on. Under `requireRuleTarget`
 * that means M4 BASELINES on tick 1 and can first enter on tick 2: it buys a strictly later book than every other
 * arm, at a different price, with a different runway. A difference in its result is therefore entry TIMING +
 * selection confounded, never selection alone. Read it as its own arm; do not rank it against M0–M3.
 *
 * It also requires a STRICTLY POSITIVE delta. An all-flat book (every Δ = 0, the common case at the fresh open)
 * is the absence of momentum, not a signal, and returning the lowest-idx zero would silently make M4 "buy the
 * coldest rung" — a rule nobody proposed. Null instead ⇒ wait for a tick that actually moves.
 */
export const M4_LOOKBACK = 5;
export function makeRuleM4(maxEntryPrice: number): SelectRule {
  return (ticks, i) => {
    if (i <= 0) return null; // baseline tick — no history to measure momentum against
    const k = Math.min(i, M4_LOOKBACK);
    const past = new Map<number, number>();
    for (const b of bucketsAt(ticks, i - k)) if (fin(b.bestBid)) past.set(b.idx, b.bestBid);
    let bestIdx: number | null = null;
    let bestDelta = Number.NEGATIVE_INFINITY;
    for (const b of bucketsAt(ticks, i)) {
      if (!fin(b.bestBid)) continue;
      if (!fin(b.execAsk) || b.execAsk > maxEntryPrice) continue;
      const p = past.get(b.idx);
      if (!fin(p)) continue;
      const d = b.bestBid - p;
      if (d > bestDelta || (d === bestDelta && bestIdx != null && b.idx < bestIdx)) {
        bestDelta = d;
        bestIdx = b.idx;
      }
    }
    return bestDelta > 0 ? bestIdx : null; // a flat book is no momentum, not a pick
  };
}

/**
 * The per-rule health warning printed with EVERY table + stamped into the artifact. Two of these rules are not
 * what their name promises, and a reader who sees only the number will draw the wrong conclusion.
 */
export const RULE_CAVEATS: Record<SelectRuleId, string | null> = {
  M0: null,
  M1: null,
  M2: null,
  M3: 'PROXY — the observed running-max floor is NOT in the archive rows, so the floor is inferred from bid mass. '
    + 'At the cheap early ticks this rule targets, essentially no bucket is bid ≥0.90, so M3 degenerates to "one '
    + 'above the coldest quoted rung". Judge it as THAT rule, not as a floor-tracker.',
  M4: 'NOT LIKE-FOR-LIKE — momentum needs a prior tick, so M4 baselines on tick 1 and enters no earlier than '
    + 'tick 2, while M0–M3 enter on tick 1. Its result confounds entry TIMING with selection; do not rank it '
    + 'against the other arms.',
};

/** Build the rule for an id (M0 ⇒ the engine's default center). */
export function makeSelectRule(id: SelectRuleId, cfg: OpeningCfg): SelectRule {
  switch (id) {
    case 'M1': return makeRuleM1(cfg.maxEntryPrice);
    case 'M2': return ruleM2;
    case 'M3': return ruleM3;
    case 'M4': return makeRuleM4(cfg.maxEntryPrice);
    default: return ruleM0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · per-trade rows — the executed population, one row per trade, so INVERSE-SIDE and HOLD arms are
//     computable as post-processing instead of needing a second engine
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * ONE executed trade. The aggregates above answer "did the YES bracket net positive"; these rows exist so two
 * further arms are pure arithmetic over the SAME executed population — identical selection, identical gates:
 *
 *   • the NO arm — buy NO on the selected bucket instead of YES. Cost basis is `1 − entryExecBid` (the YES bid is
 *     the NO ask), executable size is capped by `entrySellbackDepthUsd` (the YES BID-side depth is what a NO buyer
 *     consumes). ⚠ THE DEPTH CHECK IS NOT OPTIONAL: this project has already killed a signal (CROSS-VENUE-SPIKE)
 *     that looked +EV on quoted prices and died at 1–10 contracts of true executable depth.
 *   • the HOLD arm — ignore the convergence sell and settle at resolution: `bucketWon` is the payout, so the per-$
 *     return is `(bucketWon ? 1 : 0) / entryPrice − 1` less the entry fee. Rows with `winnerIdx === null` MUST be
 *     dropped from that arithmetic, never scored as losses (`nUnknownResolution` counts what the drop costs).
 *
 * NaN is normalized to `null` so the in-memory type matches what JSON.stringify actually writes to `--out`
 * (JSON has no NaN — it would serialize to null anyway, and a typed null is the honest declaration).
 */
export interface TradeRow {
  eventId: string;
  city: string;
  targetDate: string;
  bucketIdx: number;
  entryLabel: string;
  /** hours_since_listing at the FILL tick. */
  entryAgeH: number | null;
  /** what we actually PAID for YES (maker limit, or the taker-fallback worse-of + slippage). */
  entryPrice: number | null;
  isMaker: boolean;
  // ── the FILL-tick book (see BracketTrade's field docs). entryExecBid is the load-bearing one: no NO arm without it. ──
  entryBestBid: number | null;
  entryExecBid: number | null;
  /** ask-side (buyable) depth $ — the YES arm's capacity. */
  entryDepthUsd: number | null;
  /** BID-side (sellable) depth $ — the NO arm's capacity. 0 is ambiguous (genuine zero vs an absent early-shard column). */
  entrySellbackDepthUsd: number | null;
  exitReason: string;
  exitPrice: number | null;
  stakeUsd: number;
  netPnlUsd: number;
  netReturn: number | null;
  /** the max execBid reached after the fill — REPORT-ONLY look-ahead ceiling, never a decision input. */
  bestReachableBid: number | null;
  /** the resolution's winning bucket idx; null = UNKNOWN (no market_events row) → exclude from win-rate arithmetic. */
  winnerIdx: number | null;
  /** did the bucket we bought win? null when the winner is unknown. */
  bucketWon: boolean | null;
  // ── run scope, stamped per row so rows from several runs stay disambiguable after concatenation ──
  tpDeltaPp: number;
  select: SelectRuleId;
  houseEdge: boolean;
}

/** the executed population at one take-profit, plus the two denominators the rows themselves cannot carry. */
export interface TradeRowSet {
  rows: TradeRow[];
  /** events considered (grading_mismatch excluded) — the executed-fraction denominator. */
  nConsidered: number;
  /** EXECUTED trades whose resolution is UNKNOWN (no `market_events` row ⇒ winnerIdx null). They must be excluded
   *  from any win-rate arithmetic rather than counted as losses; this is the count of what that exclusion costs. */
  nUnknownResolution: number;
}

export interface RowMeta { select: SelectRuleId; houseEdge: boolean }

/** NaN → null, so the declared type is what actually lands in the JSON artifact. */
const jn = (v: number | null | undefined): number | null => (fin(v) ? Number(v) : null);

/**
 * Replay every considered event at ONE take-profit and emit a row per EXECUTED trade. The executed population is
 * TP-INVARIANT (entry runs off `cfg`, never `tpDeltaPp` — only the exit leg sweeps), so `nConsidered` /
 * `nUnknownResolution` / the entry-side columns are identical across TPs; only exitReason/exitPrice/netReturn move.
 */
export function buildTradeRows(
  events: EventReplayInput[],
  cfg: OpeningCfg,
  tp: number,
  opts: { selectRule?: SelectRule; ignoreHouseEdge?: boolean; requireRuleTarget?: boolean } = {},
  meta: RowMeta = { select: 'M0', houseEdge: true },
): TradeRowSet {
  const considered = (Array.isArray(events) ? events : []).filter((e) => e && !e.resolution?.gradingMismatch);
  const rows: TradeRow[] = [];
  let nUnknownResolution = 0;
  for (const e of considered) {
    const t: BracketTrade = replayEvent(e, cfg, tp, opts);
    if (!t.executed) continue;
    const winnerIdx = e.resolution?.winnerIdx ?? null;
    if (winnerIdx == null) nUnknownResolution++;
    rows.push({
      eventId: e.eventId,
      city: e.city,
      targetDate: e.targetDate,
      bucketIdx: t.bucketIdx,
      entryLabel: t.entryLabel,
      entryAgeH: jn(t.entryAgeH),
      entryPrice: jn(t.entryPrice),
      isMaker: t.isMaker,
      entryBestBid: jn(t.entryBestBid),
      entryExecBid: jn(t.entryExecBid),
      entryDepthUsd: jn(t.entryDepthUsd),
      entrySellbackDepthUsd: jn(t.entrySellbackDepthUsd),
      exitReason: t.exitReason,
      exitPrice: jn(t.exitPrice),
      stakeUsd: t.stakeUsd,
      netPnlUsd: t.netPnlUsd,
      netReturn: jn(t.netReturn),
      bestReachableBid: jn(t.bestReachableBid),
      winnerIdx,
      bucketWon: t.wouldHaveWonAtResolution, // null ⇔ winnerIdx null (grading_mismatch is already filtered out)
      tpDeltaPp: tp,
      select: meta.select,
      houseEdge: meta.houseEdge,
    });
  }
  return { rows, nConsidered: considered.length, nUnknownResolution };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · diagnostics — the mechanism questions the headline number cannot answer
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface CaptureDiagnostics {
  nEvents: number;
  nExecuted: number;
  nCities: number;
  nDistinctDays: number;
  meanEntryPrice: number;
  /** share of executed trades whose execBid EVER re-rated above the entry price (the convergence pulse). */
  reRateUpFrac: number;
  /** share of executed trades the FIXED rule actually exited on take-profit (the capture rate). */
  tpCaptureFrac: number;
  /** among trades held to a resolution settle, the share that won ($1). */
  holdToResolutionWinFrac: number;
  nHeldToResolution: number;
  /** among TAKE-PROFIT exits with a known winner: share whose bought bucket WOULD have won at resolution.
   *  Low ⇒ we harvest a transient momentum bump; high ⇒ the market was pricing in a correct outcome. */
  tpWouldHaveWonFrac: number;
  nTpWithKnownWinner: number;
  meanNetReturnExecuted: number;
  /** executed trades with NO resolution row — excluded from every win-rate above (never scored as losses). */
  nUnknownResolution: number;
  /** executed trades carrying a usable NO-arm cost basis (finite entryExecBid) — if this is far below nExecuted
   *  the inverse-side arm is NOT computable on this panel and must not be reported as if it were. */
  nWithEntryBid: number;
  /** …and of those, how many also show non-zero YES bid-side depth (the NO arm's executable-size check). */
  nWithSellbackDepth: number;
  meanEntryExecBid: number;
  meanEntrySellbackDepthUsd: number;
}

export function diagnose(set: TradeRowSet): CaptureDiagnostics {
  const rows = set.rows;
  const tps = rows.filter((r) => r.exitReason.startsWith('take_profit'));
  const held = rows.filter((r) => r.exitReason.includes('resolution_settle'));
  const tpKnown = tps.filter((r) => r.bucketWon != null);
  const withBid = rows.filter((r) => r.entryExecBid != null);
  return {
    nEvents: set.nConsidered,
    nExecuted: rows.length,
    nCities: new Set(rows.map((r) => r.city)).size,
    nDistinctDays: new Set(rows.map((r) => r.targetDate)).size,
    meanEntryPrice: meanOf(rows.map((r) => r.entryPrice).filter((v): v is number => v != null)),
    reRateUpFrac: rows.length
      ? rows.filter((r) => r.bestReachableBid != null && r.entryPrice != null && r.bestReachableBid > r.entryPrice).length / rows.length
      : NaN,
    tpCaptureFrac: rows.length ? tps.length / rows.length : NaN,
    holdToResolutionWinFrac: held.length ? held.filter((r) => r.exitReason.includes('win')).length / held.length : NaN,
    nHeldToResolution: held.length,
    tpWouldHaveWonFrac: tpKnown.length ? tpKnown.filter((r) => r.bucketWon === true).length / tpKnown.length : NaN,
    nTpWithKnownWinner: tpKnown.length,
    meanNetReturnExecuted: meanOf(rows.map((r) => r.netReturn).filter((v): v is number => v != null)),
    nUnknownResolution: set.nUnknownResolution,
    nWithEntryBid: withBid.length,
    nWithSellbackDepth: withBid.filter((r) => (r.entrySellbackDepthUsd ?? 0) > 0).length,
    meanEntryExecBid: meanOf(withBid.map((r) => r.entryExecBid).filter((v): v is number => v != null)),
    meanEntrySellbackDepthUsd: meanOf(rows.map((r) => r.entrySellbackDepthUsd).filter((v): v is number => v != null)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · OOS split by date (earliest dates = TRAIN)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function splitByDate(
  events: EventReplayInput[],
  opts: { trainFrac?: number; splitDate?: string },
): { train: EventReplayInput[]; test: EventReplayInput[]; splitDate: string | null } {
  const dates = [...new Set(events.map((e) => e.targetDate).filter((d) => !!d))].sort();
  if (dates.length === 0) return { train: [], test: [], splitDate: null };
  let cut = opts.splitDate ?? null;
  if (cut == null && fin(opts.trainFrac) && opts.trainFrac > 0 && opts.trainFrac < 1) {
    const n = Math.max(1, Math.min(dates.length - 1, Math.round(dates.length * opts.trainFrac)));
    cut = dates[n]!; // the first TEST date
  }
  if (cut == null) return { train: events, test: [], splitDate: null };
  return {
    train: events.filter((e) => e.targetDate < cut!),
    test: events.filter((e) => e.targetDate >= cut!),
    splitDate: cut,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5 · report
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function report(
  panel: BracketPanel,
  meta: { select: SelectRuleId; houseEdge: boolean; feeRate: number; minDepthUsd: number; cities: number; requireRuleTarget?: boolean },
  diag: CaptureDiagnostics | null,
  log: (m: string) => void,
): void {
  const headline = panel.perTp.find((r) => r.tpDeltaPp === panel.headlineTp) ?? null;
  log('=== convergence-capture-score · MARKET-SIGNAL selection × the bracket-EXIT edge (archive replay) ===');
  log(
    `  select ${meta.select} · house-edge ${meta.houseEdge ? 'on' : 'off'} · taker fee ${pct(meta.feeRate)} ` +
      `(rate·p·(1−p), taker legs only) · min depth $${meta.minDepthUsd} · ${meta.cities} allowlist cities · ` +
      `headline TP +${pct(panel.headlineTp, 0)} (pre-registered)`,
  );
  log(
    `  rule-silent policy: ${meta.requireRuleTarget ? 'SKIP THE TICK (no forecast fallback — a pure market-signal arm)' : 'fall back to the forecast argmax'}`,
  );
  const caveat = RULE_CAVEATS[meta.select];
  if (caveat) {
    log('');
    log(`  ⚠ ${meta.select}: ${caveat}`);
  }
  log('');
  log('  the bet scored: BUY the SELECTED bucket at the first enterable tick (maker-first, taker fallback), then');
  log('  SELL on the FIRST of take-profit / stop-loss / station-local-noon time-stop, walking the ARCHIVED order');
  log('  book tick-by-tick (NO LOOK-AHEAD — the select rule sees ticks[0..i] only). Leftover settles at resolution.');
  log('  §9R-E floors (per TP): ≥40 executed markets · ≥6 cities · ≥7 distinct days — below any → INSUFFICIENT_DATA.');
  log('');
  log(
    `  ${'TP'.padStart(5)}  ${'nMkts'.padStart(5)}  ${'cities'.padStart(6)}  ${'dates'.padStart(5)}  ` +
      `${'exec%'.padStart(6)}  ${'winFrac'.padStart(7)}  ${'meanNetRet'.padStart(10)}  ${'CI95'.padStart(18)}  ` +
      `${'zsMC'.padStart(6)}  ${'ruleRoi'.padStart(7)}  ${'ceiling'.padStart(7)}  verdict`,
  );
  for (const r of panel.perTp) {
    const mark = r.tpDeltaPp === panel.headlineTp ? '*' : ' ';
    log(
      `${mark} ${`+${pct(r.tpDeltaPp, 0)}`.padStart(5)}  ${String(r.nMarkets).padStart(5)}  ` +
        `${String(r.nCities).padStart(6)}  ${String(r.nDistinctDays).padStart(5)}  ${pct(r.executedFrac).padStart(6)}  ` +
        `${pct(r.winFrac).padStart(7)}  ${signedPct(r.meanNetReturn).padStart(10)}  ` +
        `${`[${pct(r.ciLow)}, ${pct(r.ciHigh)}]`.padStart(18)}  ${pct(r.zeroSkillPassRate).padStart(6)}  ` +
        `${signedPct(r.ruleCaptureRoi).padStart(7)}  ${signedPct(r.avgBestReachableRoundtrip).padStart(7)}  ${r.label}`,
    );
  }
  log('');
  log('=== HEADLINE VERDICT (the pre-registered §9R-E gate at TP +25%) ===');
  log(headline ? `  ${headline.label} — ${headline.reason}` : '  INSUFFICIENT_DATA — no headline row (empty panel).');
  if (diag) {
    log('');
    log('=== MECHANISM DIAGNOSTICS (headline TP) ===');
    log(`  events considered ${diag.nEvents} · executed ${diag.nExecuted} · ${diag.nCities} cities · ${diag.nDistinctDays} dates`);
    log(`  mean entry price ${f3(diag.meanEntryPrice)} · mean net return (executed, incl. in-flight marks) ${signedPct(diag.meanNetReturnExecuted)}`);
    log(`  execBid re-rated UP vs entry: ${pct(diag.reRateUpFrac)} · TP-capture: ${pct(diag.tpCaptureFrac)}`);
    log(`  held to resolution: ${diag.nHeldToResolution} trades · win ${pct(diag.holdToResolutionWinFrac)}`);
    log(
      `  of TP-sold buckets with a known winner (${diag.nTpWithKnownWinner}): ${pct(diag.tpWouldHaveWonFrac)} would have WON ` +
        '— low ⇒ we harvest a transient momentum bump, high ⇒ the market was pricing a correct outcome.',
    );
    log(
      `  resolution UNKNOWN (no market_events row): ${diag.nUnknownResolution} of ${diag.nExecuted} executed — EXCLUDED from ` +
        'every win rate above (never scored as losses).',
    );
    log(
      `  inverse-side (NO) arm computability: ${diag.nWithEntryBid}/${diag.nExecuted} rows carry a finite entryExecBid ` +
        `(mean ${f3(diag.meanEntryExecBid)} ⇒ NO costs ~${f3(1 - diag.meanEntryExecBid)}) · ` +
        `${diag.nWithSellbackDepth} of those show non-zero YES bid-side depth (mean $${f3(diag.meanEntrySellbackDepthUsd)}).`,
    );
    if (diag.nExecuted > 0 && diag.nWithEntryBid < diag.nExecuted) {
      log(
        `  ⚠ ${diag.nExecuted - diag.nWithEntryBid} executed rows have NO entry-tick bid — the NO arm is NOT computable ` +
          'for them (the earliest archive shards predate the exit-side book columns). Do not silently treat them as 0¢.',
      );
    }
  }
  log('');
  log('  CAVEATS — the TP sweep AND the select-rule choice are EXPLORATORY (in-sample selection = winner\'s-curse);');
  log('  pick by max ciLow on TRAIN and confirm on held-out dates. A positive point estimate whose CI includes 0 is');
  log('  a KILL, not "promising". This screen decides NOTHING about capital — the forward paper gate is the gate of record.');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6 · self-test (runs on CLI invocation, no DB/network — mirrors the other research spines)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function sanity(): void {
  const TZ = 'Europe/Amsterdam';
  const DATE = '2026-06-28';
  const cfg: OpeningCfg = { ...BOT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05 };

  const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
    idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
    bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: null,
    tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
  });
  const tick = (buckets: OpeningBucket[]): ReplayTick => ({
    capturedAt: '2026-06-28T08:00:00.000Z', hoursSinceListing: 0.2, tz: TZ, targetDate: DATE, buckets,
  });

  // M1 picks the max bestBid among cheap buckets (the expensive higher bid is excluded by the entry cap)
  const t1 = tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.15 }), b(2, { bestBid: 0.4, execAsk: 0.5 })]);
  if (makeRuleM1(0.2)([t1], 0) !== 1) throw new Error('sanity: M1 bid-leader');
  // M2 picks the max mid regardless of price
  if (ruleM2([tick([b(0, { mid: 0.1 }), b(1, { mid: 0.3 }), b(2, { mid: 0.2 })])], 0) !== 1) throw new Error('sanity: M2 market-mode');
  // M3: one above the ≥0.90-bid bucket; with none, one above the coldest quoted rung
  if (ruleM3([tick([b(0, { bestBid: 0.95 }), b(1), b(2)])], 0) !== 1) throw new Error('sanity: M3 floor+1');
  if (ruleM3([tick([b(0, { mid: null }), b(1, { mid: 0.1 }), b(2)])], 0) !== 2) throw new Error('sanity: M3 fallback');
  // M4: null at i=0; else the biggest bid gain over the look-back
  if (makeRuleM4(0.2)([t1], 0) !== null) throw new Error('sanity: M4 must be null at i=0');
  const past = tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.05 })]);
  const now = tick([b(0, { bestBid: 0.06 }), b(1, { bestBid: 0.12 })]);
  if (makeRuleM4(0.2)([past, now], 1) !== 1) throw new Error('sanity: M4 momentum');
  // report() + the row/diagnostics path are total on an empty panel
  const empty = buildTradeRows([], cfg, 0.25);
  if (empty.rows.length !== 0 || empty.nConsidered !== 0 || empty.nUnknownResolution !== 0) throw new Error('sanity: buildTradeRows empty');
  report(replayPanel([], cfg, DEFAULT_TPS), { select: 'M0', houseEdge: true, feeRate: 0.05, minDepthUsd: 50, cities: 1 }, diagnose(empty), () => {});
  // splitByDate: earliest dates train, the rest test
  const ev = (d: string): EventReplayInput => ({ eventId: d, city: 'amsterdam', targetDate: d, tz: TZ, ticks: [], resolution: { winnerIdx: null, gradingMismatch: false } });
  const sp = splitByDate([ev('2026-06-01'), ev('2026-06-02'), ev('2026-06-03'), ev('2026-06-04')], { trainFrac: 0.5 });
  if (sp.train.length !== 2 || sp.test.length !== 2) throw new Error('sanity: splitByDate');
  if (splitByDate([], {}).splitDate !== null) throw new Error('sanity: splitByDate empty');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 7 · CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      select: { type: 'string' },
      'house-edge': { type: 'string' },
      cities: { type: 'string' },
      tps: { type: 'string' },
      'fee-rate': { type: 'string' },
      'min-depth': { type: 'string' },
      'max-shards': { type: 'string' },
      dir: { type: 'string' },
      out: { type: 'string' },
      'train-frac': { type: 'string' },
      'split-date': { type: 'string' },
    },
  });

  const selectId = (String(values.select ?? 'M0').toUpperCase() as SelectRuleId);
  if (!SELECT_RULES.includes(selectId)) throw new Error(`--select must be one of ${SELECT_RULES.join('|')}`);
  const houseEdge = String(values['house-edge'] ?? 'on').toLowerCase() !== 'off';
  const citiesMode = String(values.cities ?? 'bot').toLowerCase();
  if (citiesMode !== 'bot' && citiesMode !== 'all') throw new Error('--cities must be bot|all');
  const feeRate = Math.max(0, Number(values['fee-rate'] ?? DEFAULT_FEE_RATE) || 0);
  const minDepthUsd = values['min-depth'] != null ? Math.max(0, Number(values['min-depth']) || 0) : DEFAULT_MIN_DEPTH_USD;
  const maxShards = values['max-shards'] != null ? Math.max(1, Math.floor(Number(values['max-shards']) || 0)) : undefined;
  const tps = values.tps != null
    ? String(values.tps).split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v) && v >= 0)
    : DEFAULT_TPS;
  const trainFrac = values['train-frac'] != null ? Number(values['train-frac']) : undefined;
  const splitDate = values['split-date'] != null ? String(values['split-date']) : undefined;
  // default = BOTH archives merged, primary first (it wins every event_id collision); --dir pins a single one.
  const dirs = values.dir != null ? [String(values.dir)] : DEFAULT_ARCHIVE_DIRS;
  // a market-signal arm must never silently fall back to argmax(houseProb) — that would blend it with the M0
  // control exactly where its own rule is weakest. M0 IS the forecast arm, so the policy is moot there.
  const requireRuleTarget = selectId !== 'M0';

  const db = makeScriptDb();
  try {
    process.stderr.write(
      `${SCRIPT} · ${new Date().toISOString()} · select ${selectId} · house-edge ${houseEdge ? 'on' : 'off'} · ` +
        `cities ${citiesMode}${maxShards ? ` · max-shards ${maxShards} (SMOKE — truncated series, NOT a verdict)` : ''} — ` +
        'read-only; places NOTHING\n',
    );
    const load = await loadArchiveEvents({
      dirs,
      cities: citiesMode === 'bot' ? BOT_DEFAULTS.cities : undefined,
      maxShards,
      db,
      onProgress: (m) => process.stderr.write(`${m}\n`),
    });
    const s: ArchiveLoadStats = load.stats;
    process.stderr.write(
      `  archive: ${s.shardsRead} shards · ${s.rowsRead} rows read · ${s.rowsDroppedNullEventId} dropped (null event_id) · ` +
        `${s.rowsDroppedCityFilter} dropped (city filter) · ${s.rowsKept} kept\n` +
        `  events: ${s.archiveEvents} in archive · resolution coverage ${s.eventsWithResolution} covered / ` +
        `${s.eventsWithoutResolution} UNCOVERED · fresh-filter kept ${s.eventsAfterFreshFilter} ` +
        `(dropped ${s.eventsDroppedNotFresh} not-fresh) · ${s.ticks} ticks · ${s.cities.length} cities\n`,
    );

    // the city allowlist the engine gates on: the bot's 10 for `bot`, every archive city for `all`.
    const cfg: OpeningCfg = {
      ...BOT_DEFAULTS,
      cities: citiesMode === 'bot' ? BOT_DEFAULTS.cities : s.cities,
      depthFloorUsd: minDepthUsd,
      takerFeeRate: feeRate,
    };
    const selectRule = selectId === 'M0' ? undefined : makeSelectRule(selectId, cfg);
    const replayOpts = { selectRule, ignoreHouseEdge: !houseEdge, requireRuleTarget };

    // priceBasis 'real-book': the archive carries the observed depth-walked exec bid/ask, not mids.
    const panel = replayPanel(load.events, cfg, tps, { priceBasis: 'real-book', ...replayOpts });

    // per-trade rows at EVERY swept TP (the panel's own TP set, so the headline row is always present). The
    // executed population is TP-invariant; only the exit columns move. Each row is stamped with its tpDeltaPp +
    // the select/house-edge scope, so the array is a self-describing population the NO / HOLD arms replay over.
    const rowMeta: RowMeta = { select: selectId, houseEdge };
    const rowSets = new Map<number, TradeRowSet>();
    for (const tp of panel.perTp.map((r) => r.tpDeltaPp)) {
      rowSets.set(tp, buildTradeRows(load.events, cfg, tp, replayOpts, rowMeta));
    }
    const headlineSet = rowSets.get(panel.headlineTp) ?? buildTradeRows(load.events, cfg, panel.headlineTp, replayOpts, rowMeta);
    const tradeRows = [...rowSets.values()].flatMap((s) => s.rows);
    const diag = diagnose(headlineSet);
    report(panel, { select: selectId, houseEdge, feeRate, minDepthUsd, cities: cfg.cities.length, requireRuleTarget }, diag, console.log);

    // OOS by-date split (exploratory — a rule is chosen on TRAIN by max ciLow and confirmed on TEST).
    let oos: { splitDate: string | null; train: BracketPanel | null; test: BracketPanel | null } = { splitDate: null, train: null, test: null };
    if (trainFrac != null || splitDate != null) {
      const sp = splitByDate(load.events, { trainFrac, splitDate });
      oos = {
        splitDate: sp.splitDate,
        train: replayPanel(sp.train, cfg, tps, { priceBasis: 'real-book', ...replayOpts }),
        test: replayPanel(sp.test, cfg, tps, { priceBasis: 'real-book', ...replayOpts }),
      };
      console.log('');
      console.log(`=== OOS SPLIT (train < ${sp.splitDate} ≤ test) ===`);
      for (const [name, p] of [['TRAIN', oos.train], ['TEST', oos.test]] as const) {
        const h = p?.perTp.find((r) => r.tpDeltaPp === p.headlineTp);
        console.log(
          `  ${name}: ${h ? `${h.label} · n=${h.nMarkets} · mean ${signedPct(h.meanNetReturn)} · CI [${pct(h.ciLow)}, ${pct(h.ciHigh)}]` : '—'}`,
        );
      }
    }

    if (values.out != null) {
      const outPath = String(values.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(
        outPath,
        `${JSON.stringify(
          {
            script: SCRIPT,
            generatedAt: new Date().toISOString(),
            params: { select: selectId, houseEdge, cities: citiesMode, feeRate, minDepthUsd, tps, maxShards: maxShards ?? null, trainFrac: trainFrac ?? null, splitDate: splitDate ?? null, dirs, requireRuleTarget, ruleCaveat: RULE_CAVEATS[selectId] },
            archive: s,
            panel,
            diagnostics: diag,
            oos,
            // the per-trade population — one row per EXECUTED trade per swept TP. See the TradeRow doc comment:
            // this is what makes the inverse-side (NO) and hold-to-resolution arms pure post-processing on an
            // IDENTICAL selection/gate population instead of a second engine.
            tradeRowsMeta: {
              headlineTp: panel.headlineTp,
              tps: panel.perTp.map((r) => r.tpDeltaPp),
              nRows: tradeRows.length,
              nExecutedPerTp: headlineSet.rows.length, // TP-invariant (entry never reads tpDeltaPp)
              nConsidered: headlineSet.nConsidered,
              nUnknownResolution: headlineSet.nUnknownResolution,
              nWithEntryBid: diag.nWithEntryBid,
              nWithSellbackDepth: diag.nWithSellbackDepth,
            },
            tradeRows,
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      process.stderr.write(
        `  artifact → ${outPath} · ${tradeRows.length} trade rows ` +
          `(${headlineSet.rows.length} executed × ${panel.perTp.length} TPs; ${headlineSet.nUnknownResolution} unresolved)\n`,
      );
    }
  } finally {
    await db.end();
  }
}
