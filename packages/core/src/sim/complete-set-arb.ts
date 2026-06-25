/**
 * core/sim/complete-set-arb — the STRUCTURAL (forecast-free) complete-set arbitrage on
 * Polymarket weather ladders, and the measurement of why it does not pay. The 8th signal
 * (COMPLETE-SET-ARB.md) — the one net-positive *mechanism* the R&D program never tested, because
 * the whole program asked "is our forecast better than the market?" and this asks the orthogonal
 * question "is the market consistent with ITSELF?".
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE MECHANISM. A daily-Tmax event is one negRisk ladder of N mutually-exclusive, collectively-
 * exhaustive buckets ("87°F or below" … "106°F or higher"). EXACTLY ONE resolves YES (pays $1); the
 * rest pay $0. Two facts follow with ZERO forecast skill:
 *   • a complete set of one YES per bucket is worth EXACTLY $1 at resolution;
 *   • a complete set of one NO per bucket is worth EXACTLY $(N−1).
 * So there are two dual, riskless, buy-and-hold trades (no minting, no sells, no inventory marked to
 * a 0/1 outcome — a DETERMINISTIC payoff):
 *   UNDERROUND : Σ ask(YESᵢ) < 1            → buy every YES, hold → collect $1.        net = 1 − Σask
 *   OVERROUND  : Σ bid(YESᵢ) > 1  (⟺ Σ ask(NOᵢ) < N−1) → buy every NO, hold → $(N−1). net = Σbid − 1
 * Market efficiency w.r.t. a FORECAST is irrelevant here — this is an accounting identity. The only
 * questions are: does the dislocation clear the FEE, with executable DEPTH, on a non-negligible
 * fraction of LIVE instants?
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FEE WALL (the finding). Both riskless trades are aggressive (taker) BUYS, and weather markets
 * charge a per-share taker fee `rate·p·(1−p)` with `takerOnly:true` (verified in the gamma
 * feeSchedule). Summed over a full ladder the fee is ~2–4% of a $1 set — and that is LARGER than the
 * residual raw mispricing. Measured over the real book series (COMPLETE-SET-ARB.md): the RAW book is
 * inconsistent a meaningful fraction of the time (Σask<1 on ~4% of contemporaneous instants, Σbid>1
 * on ~12%), but after the per-leg taker fee only ~0.4% / ~0.06% clear — and those survivors live
 * almost entirely in the freshly-opened thin-book window where depth is the min-order-size (capacity
 * ≈ pennies). A live probe of all open ladders found 0 fee-clearing dislocations. The maker route
 * that would DODGE the taker fee (rest the legs) re-introduces the adverse-selection wall already
 * falsified seven times (maker-spray / reward-inventory). The structural lever is FEE-WALLED.
 *
 * Imports ONLY `fees` (the same taker-fee curve the live engine uses) — never `packages/trading`
 * (analytics-only; the live rail stays DORMANT). Pure + total: junk/degenerate input → a null/zeroed
 * result, never a throw. The frozen, economically-defined kill criterion is pre-registered below.
 */
import { takerFeePerShare } from '../fees.ts';

/** weather_fees taker rate (gamma feeSchedule.rate; takerOnly). The wall, in one constant. */
export const FEE_RATE_WEATHER = 0.05;

const usablePx = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p < 1;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the contemporaneous complete-set edge (top-of-book)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The riskless side, if any, that clears the fee at one instant. */
export type ArbSide = 'under' | 'over' | 'none';

/** The complete-set edge at one instant, from each bucket's top-of-book ask & bid. */
export interface CompleteSetEdge {
  /** Number of buckets seen. */
  n: number;
  /** True only when EVERY leg is quoted on the side needed (asks for under, bids for over). */
  completeAsk: boolean;
  completeBid: boolean;
  sumAsk: number | null;
  sumBid: number | null;
  /** Σ takerFee(askᵢ) — the cost of taking every YES. */
  feeYesTotal: number;
  /** Σ takerFee(1−bidᵢ) = Σ takerFee(bidᵢ) (symmetric) — the cost of taking every NO. */
  feeNoTotal: number;
  /** Raw (pre-fee) underround margin 1 − Σask; >0 ⇒ the book is internally cheap. */
  rawUnder: number | null;
  /** Raw (pre-fee) overround margin Σbid − 1; >0 ⇒ the book is internally rich. */
  rawOver: number | null;
  /** Net underround per $1 set: 1 − Σask − feeYes (buy all YES taker, hold → $1). */
  underNet: number | null;
  /** Net overround per $1 set: Σbid − 1 − feeNo (buy all NO taker, hold → $(N−1)). */
  overNet: number | null;
  /** The better of the two net edges (−Infinity-guarded to a finite −1 floor). */
  bestNet: number;
  /** Which side (if any) is net-positive. */
  side: ArbSide;
}

/**
 * Compute the complete-set edge from per-bucket best ask & best bid arrays (aligned by bucket).
 * A leg with an unusable ask drops the UNDER side to incomplete (you can't buy that YES); likewise
 * an unusable bid drops the OVER side. Pure + total.
 */
export function completeSetEdge(
  asks: (number | null)[],
  bids: (number | null)[],
  feeRate: number = FEE_RATE_WEATHER,
): CompleteSetEdge {
  const a = Array.isArray(asks) ? asks : [];
  const b = Array.isArray(bids) ? bids : [];
  const n = Math.max(a.length, b.length);
  const rate = Number.isFinite(feeRate) && feeRate >= 0 ? feeRate : FEE_RATE_WEATHER;

  const completeAsk = n > 0 && a.length === n && a.every(usablePx);
  const completeBid = n > 0 && b.length === n && b.every(usablePx);

  const sumAsk = completeAsk ? (a as number[]).reduce((s, x) => s + x, 0) : null;
  const sumBid = completeBid ? (b as number[]).reduce((s, x) => s + x, 0) : null;
  const feeYesTotal = completeAsk
    ? (a as number[]).reduce((s, x) => s + takerFeePerShare(x, rate), 0)
    : 0;
  // NO leg trades at price (1−bid); takerFee(1−bid)=rate·(1−bid)·bid = takerFee(bid). Symmetric.
  const feeNoTotal = completeBid
    ? (b as number[]).reduce((s, x) => s + takerFeePerShare(x, rate), 0)
    : 0;

  const rawUnder = sumAsk == null ? null : 1 - sumAsk;
  const rawOver = sumBid == null ? null : sumBid - 1;
  const underNet = sumAsk == null ? null : 1 - sumAsk - feeYesTotal;
  const overNet = sumBid == null ? null : sumBid - 1 - feeNoTotal;

  const u = underNet ?? Number.NEGATIVE_INFINITY;
  const o = overNet ?? Number.NEGATIVE_INFINITY;
  const bestRaw = Math.max(u, o);
  const bestNet = Number.isFinite(bestRaw) ? bestRaw : -1;
  const side: ArbSide = u <= 0 && o <= 0 ? 'none' : u >= o ? 'under' : 'over';

  return {
    n,
    completeAsk,
    completeBid,
    sumAsk,
    sumBid,
    feeYesTotal,
    feeNoTotal,
    rawUnder,
    rawOver,
    underNet,
    overNet,
    bestNet,
    side: bestNet > 0 ? side : 'none',
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the contemporaneity gate (the stale-quote trap)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A complete-set edge is only REAL if all legs are quoted SIMULTANEOUSLY. `market_snapshots` is
 * delta-deduped + heartbeated (poll-markets writes on a ≥0.5¢ move OR every 30 min for a candidate
 * ladder), so an un-rewritten quote is the live resting quote ONLY within the heartbeat window;
 * beyond it the poller stopped covering the leg and the carried value is a GHOST (the Karachi trap —
 * a 4.5-hour-stale 0.979 bid summed into a phantom 2.38 overround). Forward-filling without this gate
 * fabricates the entire signal. Default bound = the 30-min candidate heartbeat.
 */
export const MAX_STALE_MIN = 30;

/** True iff every leg's quote is within `maxStaleMin` of the instant (a contemporaneous book). */
export function isContemporaneous(staleMins: number[], maxStaleMin: number = MAX_STALE_MIN): boolean {
  if (!Array.isArray(staleMins) || staleMins.length === 0) return false;
  const bound = Number.isFinite(maxStaleMin) && maxStaleMin >= 0 ? maxStaleMin : MAX_STALE_MIN;
  return staleMins.every((m) => Number.isFinite(m) && m >= 0 && m <= bound);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// depth-limited executable profit (the capacity question)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One price level (best-first). */
export interface BookLevel {
  price: number;
  size: number;
}

/** The realizable arb after walking the real book depth. */
export interface ExecutableArb {
  /** Whole complete sets buyable at a net profit (0 if none). */
  sets: number;
  /** Total USDC spent on the legs (incl. fee). */
  costUsd: number;
  /** Total taker fee paid. */
  feeUsd: number;
  /** Net profit in USDC at the profit-maximising set count. */
  profitUsd: number;
}

const EMPTY_EXEC: ExecutableArb = { sets: 0, costUsd: 0, feeUsd: 0, profitUsd: 0 };

/** Cost+fee to take exactly `k` shares by walking an ask ladder best-first; null if too thin. */
function takeCost(levels: BookLevel[], k: number, rate: number): { cost: number; fee: number } | null {
  let need = k;
  let cost = 0;
  let fee = 0;
  for (const lvl of levels) {
    if (need <= 0) break;
    if (!usablePx(lvl?.price) || !(Number.isFinite(lvl.size) && lvl.size > 0)) continue;
    const take = Math.min(need, lvl.size);
    cost += take * lvl.price;
    fee += take * takerFeePerShare(lvl.price, rate);
    need -= take;
  }
  return need > 0 ? null : { cost, fee };
}

/**
 * Profit-maximising number of complete sets to buy when each leg has its own ask ladder. Each set
 * redeems to `payoutPerSet` ($1 for the underround YES set; $(N−1)/N is NOT how this works — see
 * underroundExecutable / overroundExecutable wrappers which pass the right ladders & payout). Walks
 * integer set counts up to the thinnest leg's total depth (capped). Pure + total.
 */
export function executableArb(
  legLadders: BookLevel[][],
  payoutPerSet: number,
  feeRate: number = FEE_RATE_WEATHER,
  maxSetsCap = 100_000,
): ExecutableArb {
  if (!Array.isArray(legLadders) || legLadders.length === 0) return EMPTY_EXEC;
  const rate = Number.isFinite(feeRate) && feeRate >= 0 ? feeRate : FEE_RATE_WEATHER;
  const depth = legLadders.map((l) =>
    (Array.isArray(l) ? l : []).reduce((s, lv) => s + (Number.isFinite(lv?.size) && lv.size > 0 ? lv.size : 0), 0),
  );
  const maxSets = Math.min(...depth);
  if (!(Number.isFinite(maxSets) && maxSets >= 1)) return EMPTY_EXEC;
  const cap = Math.min(Math.floor(maxSets), Math.max(1, maxSetsCap));

  let best = EMPTY_EXEC;
  for (let k = 1; k <= cap; k++) {
    let cost = 0;
    let fee = 0;
    let ok = true;
    for (const ladder of legLadders) {
      const c = takeCost(ladder, k, rate);
      if (c == null) {
        ok = false;
        break;
      }
      cost += c.cost;
      fee += c.fee;
    }
    if (!ok) break;
    const profit = k * payoutPerSet - cost - fee;
    if (profit > best.profitUsd) best = { sets: k, costUsd: cost + fee, feeUsd: fee, profitUsd: profit };
  }
  return best;
}

/** UNDERROUND executable: buy one YES of every bucket from its ask ladder; each set redeems to $1. */
export function underroundExecutable(askLadders: BookLevel[][], feeRate = FEE_RATE_WEATHER): ExecutableArb {
  return executableArb(askLadders, 1, feeRate);
}

/**
 * OVERROUND executable: buy one NO of every bucket; a complete NO set redeems to $(N−1). The NO ask
 * ladder is derived from the YES bid ladder leg-by-leg: NO ask price = 1 − yesBidPrice, size carried.
 */
export function overroundExecutable(yesBidLadders: BookLevel[][], feeRate = FEE_RATE_WEATHER): ExecutableArb {
  if (!Array.isArray(yesBidLadders) || yesBidLadders.length === 0) return EMPTY_EXEC;
  const n = yesBidLadders.length;
  const noAskLadders = yesBidLadders.map((bidLadder) =>
    (Array.isArray(bidLadder) ? bidLadder : [])
      .filter((lv) => usablePx(lv?.price) && Number.isFinite(lv.size) && lv.size > 0)
      .map((lv) => ({ price: 1 - lv.price, size: lv.size })),
  );
  return executableArb(noAskLadders, n - 1, feeRate);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// scan summary + the frozen verdict
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The aggregate picture across a body of contemporaneous complete-set instants. */
export interface ArbScanSummary {
  /** Contemporaneous (fresh) complete-set instants evaluated. */
  instants: number;
  /** Instants whose RAW underround margin (1 − Σask) > 0 — the book is internally cheap pre-fee. */
  underRawBelow1: number;
  /** Instants whose RAW overround margin (Σbid − 1) > 0 — internally rich pre-fee. */
  overRawAbove1: number;
  /** Instants whose underround NET (post per-leg taker fee) > 0 — a real taker arb. */
  underFeeCleared: number;
  /** Instants whose overround NET > 0. */
  overFeeCleared: number;
  /** Best net underround / overround edge seen (per $1 set). */
  bestUnderNet: number;
  bestOverNet: number;
  /** Mean net underround edge (concentration / typical-state diagnostic). */
  meanUnderNet: number;
}

/** Build a scan summary from a stream of per-instant edges (skips incomplete sets). Pure + total. */
export function summarizeScan(edges: CompleteSetEdge[]): ArbScanSummary {
  const rows = (Array.isArray(edges) ? edges : []).filter((e) => e && (e.completeAsk || e.completeBid));
  const underNets = rows.map((e) => e.underNet).filter((v): v is number => Number.isFinite(v as number));
  const overNets = rows.map((e) => e.overNet).filter((v): v is number => Number.isFinite(v as number));
  const cnt = (xs: (number | null)[], pred: (v: number) => boolean): number =>
    xs.filter((v): v is number => Number.isFinite(v as number) && pred(v as number)).length;
  return {
    instants: rows.length,
    underRawBelow1: cnt(rows.map((e) => e.rawUnder), (v) => v > 0),
    overRawAbove1: cnt(rows.map((e) => e.rawOver), (v) => v > 0),
    underFeeCleared: cnt(rows.map((e) => e.underNet), (v) => v > 0),
    overFeeCleared: cnt(rows.map((e) => e.overNet), (v) => v > 0),
    bestUnderNet: underNets.length ? Math.max(...underNets) : NaN,
    bestOverNet: overNets.length ? Math.max(...overNets) : NaN,
    meanUnderNet: underNets.length ? underNets.reduce((a, v) => a + v, 0) / underNets.length : NaN,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// persistence classifier — Move 2 (historical clears, forward captures)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A single timestamped snapshot for persistence analysis — whether the complete-set dislocation
 * was present (clearing or raw-inconsistent) and when the snapshot was taken.
 */
export interface ArbSnapshot {
  /** ISO-8601 timestamp of the snapshot. */
  capturedAt: string;
  /** True if the snapshot showed ANY fee-clearing (under or over net > 0). */
  clearing: boolean;
}

/** Classification of a fee-clearing dislocation: real persistent opportunity vs. blip. */
export type PersistenceClass = 'persistent' | 'singlePollBlip';

/** Per-snapshot persistence tag + context. */
export interface TaggedSnapshot extends ArbSnapshot {
  /** Whether this snapshot belongs to a persistent run (≥2 consecutive clears). */
  persistenceClass: PersistenceClass;
  /** Length of the consecutive-clearing run this snapshot belongs to (1 for blips). */
  runLength: number;
}

/** Summary of persistence analysis over a set of snapshots. */
export interface PersistenceSummary {
  /** Total clearing snapshots evaluated. */
  clearingCount: number;
  /** Clearing snapshots belonging to runs of ≥2 consecutive polls. */
  persistentCount: number;
  /** Single-poll blips: fee-clearing for exactly one capture, then gone. */
  blipCount: number;
  /** Fraction of clearing snapshots that are persistent. */
  persistentFrac: number;
  /** Number of distinct persistent runs (≥2 consecutive clears). */
  persistentRuns: number;
  /** Number of single-poll blip events. */
  blipRuns: number;
  /** Mean run length for persistent runs (0 if none). */
  meanPersistentRunLength: number;
}

/**
 * Classify a series of timestamped snapshots (within a single ladder/event) by whether each
 * fee-clearing instant was part of a PERSISTENT run (≥2 consecutive polls also clearing) or a
 * SINGLE-POLL BLIP (clearing for exactly one capture, then gone or pre-gap).
 *
 * Key design: "consecutive" means consecutive in the snapshots array, NOT within an absolute
 * time window. The caller is responsible for supplying snapshots from a single ladder ordered by
 * capturedAt. A clearing snapshot is PERSISTENT if the immediately preceding OR following snapshot
 * (in the same array) is also clearing. Pure + total.
 *
 * This answers the load-bearing question: even if Σask<1 clears the fee, can you assemble 11 legs
 * across the ladder in the time between polls? If the dislocation only lives for one 30-min
 * capture and is gone by the next, it's a blip — not executable in practice.
 */
export function classifyPersistence(snapshots: ArbSnapshot[]): {
  tagged: TaggedSnapshot[];
  summary: PersistenceSummary;
} {
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  if (snaps.length === 0) {
    return {
      tagged: [],
      summary: {
        clearingCount: 0,
        persistentCount: 0,
        blipCount: 0,
        persistentFrac: 0,
        persistentRuns: 0,
        blipRuns: 0,
        meanPersistentRunLength: 0,
      },
    };
  }

  // Walk the array and compute run lengths for consecutive clearing snapshots.
  // A "run" is a maximal block of consecutive (by array index) clearing snapshots.
  const runLengths: number[] = new Array(snaps.length).fill(0);
  let i = 0;
  while (i < snaps.length) {
    if (!snaps[i]!.clearing) {
      i++;
      continue;
    }
    // find the end of this clearing run
    let j = i;
    while (j < snaps.length && snaps[j]!.clearing) j++;
    const len = j - i;
    for (let k = i; k < j; k++) runLengths[k] = len;
    i = j;
  }

  const tagged: TaggedSnapshot[] = snaps.map((snap, idx) => ({
    ...snap,
    persistenceClass: (runLengths[idx]! >= 2 ? 'persistent' : 'singlePollBlip') as PersistenceClass,
    runLength: runLengths[idx]!,
  }));

  const clearing = tagged.filter((s) => s.clearing);
  const persistent = clearing.filter((s) => s.persistenceClass === 'persistent');
  const blips = clearing.filter((s) => s.persistenceClass === 'singlePollBlip');

  // Count distinct runs
  let persistentRuns = 0;
  let blipRuns = 0;
  {
    let k = 0;
    while (k < snaps.length) {
      if (!snaps[k]!.clearing) { k++; continue; }
      let j = k;
      while (j < snaps.length && snaps[j]!.clearing) j++;
      const len = j - k;
      if (len >= 2) persistentRuns++;
      else blipRuns++;
      k = j;
    }
  }

  const persistentRunLengths = tagged
    .filter((s) => s.clearing && s.persistenceClass === 'persistent' && s.runLength > 0)
    .map((s) => s.runLength);
  // De-dup to get one entry per run (each run length appears runLength times)
  const uniqueRunLengths: number[] = [];
  {
    let k = 0;
    while (k < snaps.length) {
      if (!snaps[k]!.clearing) { k++; continue; }
      let j = k;
      while (j < snaps.length && snaps[j]!.clearing) j++;
      const len = j - k;
      if (len >= 2) uniqueRunLengths.push(len);
      k = j;
    }
  }
  const meanPersistentRunLength =
    uniqueRunLengths.length > 0
      ? uniqueRunLengths.reduce((a, v) => a + v, 0) / uniqueRunLengths.length
      : 0;

  return {
    tagged,
    summary: {
      clearingCount: clearing.length,
      persistentCount: persistent.length,
      blipCount: blips.length,
      persistentFrac: clearing.length > 0 ? persistent.length / clearing.length : 0,
      persistentRuns,
      blipRuns,
      meanPersistentRunLength,
    },
  };
}

export type ArbVerdictLabel = 'PASS' | 'MARGINAL' | 'FAIL';

export interface ArbVerdict {
  label: ArbVerdictLabel;
  /** Fraction of contemporaneous instants with ANY fee-cleared side. */
  feeClearedFrac: number;
  /** Fraction with a RAW (pre-fee) dislocation — what the fee wall removes. */
  rawFrac: number;
  reason: string;
}

/**
 * The pre-registered, ECONOMICALLY-DEFINED kill criterion (frozen by the structure of the trade, not
 * fitted to a result — WO-5 discipline). A forecast-free taker arb is net-positive iff, on a
 * NON-NEGLIGIBLE fraction of LIVE contemporaneous instants, a complete set clears the per-leg taker
 * fee: Σask < 1 − Σfee(ask)  (or the overround dual). The threshold below is the bar for "a strategy
 * worth wiring capital to", not a p-value to game:
 *
 *   PASS     = ≥ `minFeeClearedFrac` of instants clear the fee on some side (a standing, harvestable
 *              inefficiency) — build a complete-set scanner/executor.
 *   MARGINAL = some clear, but below the bar (rare, outlier/thin-open-book dominated) — real but
 *              capacity-bound; not worth capital without a depth/persistence study.
 *   FAIL     = ~none clear → the structural lever is fee-walled; the raw inefficiency is smaller than
 *              the taker fee. Rail stays DORMANT.
 */
export const DEFAULT_MIN_FEE_CLEARED_FRAC = 0.02; // 2% of instants — a generous floor for "standing"

export function completeSetArbVerdict(
  summary: ArbScanSummary,
  opts: { minFeeClearedFrac?: number } = {},
): ArbVerdict {
  const minFrac = opts.minFeeClearedFrac ?? DEFAULT_MIN_FEE_CLEARED_FRAC;
  const N = summary.instants > 0 ? summary.instants : 0;
  const cleared = summary.underFeeCleared + summary.overFeeCleared;
  const raw = summary.underRawBelow1 + summary.overRawAbove1;
  const feeClearedFrac = N > 0 ? cleared / N : 0;
  const rawFrac = N > 0 ? raw / N : 0;
  const pctf = (v: number): string => `${(v * 100).toFixed(2)}%`;

  if (N === 0) {
    return { label: 'FAIL', feeClearedFrac: 0, rawFrac: 0, reason: 'FAIL — no contemporaneous complete-set instants to adjudicate.' };
  }
  if (feeClearedFrac >= minFrac) {
    return {
      label: 'PASS',
      feeClearedFrac,
      rawFrac,
      reason:
        `PASS — ${pctf(feeClearedFrac)} of contemporaneous instants clear the per-leg taker fee on some side ` +
        `(≥ ${pctf(minFrac)} bar). A standing structural inefficiency; a complete-set scanner/executor is justified ` +
        `pending a depth/persistence study.`,
    };
  }
  if (cleared > 0) {
    return {
      label: 'MARGINAL',
      feeClearedFrac,
      rawFrac,
      reason:
        `MARGINAL — the RAW book is internally inconsistent ${pctf(rawFrac)} of the time, but the taker fee ` +
        `(takerOnly, ~2–4%/ladder) erases all but ${pctf(feeClearedFrac)} (< ${pctf(minFrac)} bar). The survivors are ` +
        `outlier / freshly-opened-thin-book dominated (depth ≈ min-order-size). Real but capacity-bound — not worth ` +
        `capital. Rail stays DORMANT.`,
    };
  }
  return {
    label: 'FAIL',
    feeClearedFrac,
    rawFrac,
    reason:
      `FAIL — fee-walled. The raw book is inconsistent ${pctf(rawFrac)} of the time, but ZERO instants clear the ` +
      `per-leg taker fee: the residual mispricing is smaller than the takerOnly fee (~2–4%/ladder). Forecast-free ` +
      `structural arbitrage is net-negative. Rail stays DORMANT.`,
  };
}
