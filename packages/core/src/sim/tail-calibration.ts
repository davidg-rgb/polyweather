/**
 * core/sim/tail-calibration — the M1 calibration DIAGNOSIS (BADATMATH-GAP-PLAN.md Move 1, the
 * "free router"). The pure analytics twin of the `scripts/research/m1-tail-calibration.ts` spine.
 *
 * THE QUESTION (the ONE arm of the gap-plan router never measured). The four replication angles are
 * all falsified (WALLET-RECON-HANDOFF.md §10–§12): our forecast can't beat the day-before market
 * (KILL-GATE 2), a taker-follower loses (§11), and resting OUR-own cheap bids loses too (§12, the
 * maker-spray "M2" arm — adverse selection). Every one of those used OUR forecast as the SELECTOR.
 * The never-asked question is the reverse: **do badatmath's REVEALED cheap picks resolve more often
 * than OUR EMOS predicts?** If yes, our tail is underweighted — a fixable forecast (Case A), not just
 * an un-replicable rent. If no, the forecast is not the gap and the honest destination is the
 * analytics product (Move 10). This module scores that diagnosis on data we already own.
 *
 * POSTURE: analytics diagnosis, NOT a trading green-light. A PASS does NOT reopen the live rail — it
 * routes to a tail-recalibration experiment (Move 7) whose harvest is then re-tested by the (already
 * built) maker-spray simulator. The result feeds the analytics product either way (the only forensic
 * reconstruction of the #1 weather sharp scored against a calibrated model IS the deliverable).
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * FROZEN METRICS + THRESHOLDS — pre-registered (BADATMATH-GAP-PLAN.md §3 Move 1, §6). DO NOT MOVE
 * THEM to fit a result (WO-5 discipline). The mis-design lesson from §12 (a heavy-tailed EV/$1 gate
 * that "passes" pure noise) is honored here: the BINDING metric is the LOW-VARIANCE paired gap
 * (won − EMOS_p), whose normal CI is trustworthy — never a per-bet EV.
 *   • M1 cheap-tail cut:   OUR EMOS_p(bucket) < 0.15  (the buckets our model itself calls longshots).
 *   • M1 PASS (Case A):    pooled (won − EMOS_p) ≥ +0.03 (+3pp) AND lower-95% CI > 0  → tail
 *                          underweighted → recalibrate (Move 7), then re-run the maker-spray harvest.
 *   • M1 KILL (combined):  pooled gap < +0.01 (+1pp). With M2 ALREADY FAIL (§12 maker-spray), the
 *                          pre-committed kill fires → our forecast is NOT the gap → Moves 3/4
 *                          (running-max physics) or pivot to the analytics product (Move 10).
 *   • Otherwise:           AMBIGUOUS (1–3pp, or ≥3pp with a CI that includes 0) → weak; treat as an
 *                          analytics input, do NOT reopen the harvest.
 *   • minN = 30:           below it the diagnosis is INSUFFICIENT (mirrors pairedBootstrapPValue's
 *                          n<30 guard) — not a pass, not a kill.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { meanConfidenceInterval, wilsonInterval } from './stats.ts';

/** The frozen M1 cut + thresholds. Pre-registered; do not move (WO-5). */
export const TAIL_CALIB = {
  /** M1 cheap-tail cut on OUR EMOS prob — the buckets our model rates as longshots. */
  emosTailMax: 0.15,
  /** M1 PASS edge (Case A — our tail underweighted): pooled (won − EMOS_p) ≥ this AND lower-CI > 0. */
  m1PassEdge: 0.03,
  /** Combined-KILL arm: pooled gap < this (with M2 already FAIL) ⇒ our forecast is not the gap. */
  m1KillEdge: 0.01,
  /** Below this many cheap-tail picks the diagnosis is INSUFFICIENT (n<30 guard). */
  minN: 30,
} as const;

/**
 * One badatmath cheap pick (a position, NOT a micro-fill — fills are aggregated per city·day·bucket so
 * n is not inflated by perfectly-correlated splits) joined to OUR walk-forward EMOS forecast for that
 * (station, target_date, bucket) and the resolved outcome. Yes-leg semantics: `won` = that bucket won.
 */
export interface TailPick {
  /** badatmath's volume-weighted entry price (their maker bid), in (0,1). */
  entryPrice: number;
  /** OUR walk-forward EMOS probability that this bucket wins, in [0,1]. */
  emosP: number;
  /** Contemporaneous market-implied prob (the day-before ask on the bucket) at our entry-lead, or null. */
  marketP: number | null;
  /** Did the bucket badatmath bought actually win (Yes-leg resolution). */
  won: boolean;
  station: string;
  citySlug: string;
  targetDate: string;
}

/** M1 — our-tail calibration on THEIR picks (the binding diagnosis). */
export interface M1Result {
  /** Cheap-tail picks scored (EMOS_p < 0.15). */
  n: number;
  /** Empirical resolution frequency of those picks (Wilson CI). */
  empiricalFreq: number;
  freqCiLo: number;
  freqCiHi: number;
  /** Mean OUR EMOS_p over the picks (what our model said they were worth). */
  meanEmosP: number;
  /** THE BINDING METRIC: pooled (won − EMOS_p) — the calibration gap. mean ± normal CI (low-variance). */
  gap: number;
  gapCiLo: number;
  gapCiHi: number;
}

/**
 * M1: on badatmath's cheap picks where OUR EMOS_p < 0.15, the pooled (won − EMOS_p) gap and its
 * low-variance CI. A positive gap means their longshots resolve MORE often than our model's tail
 * predicts → our tail is underweighted (Case A). Pure; total ({n:0, NaN} on empty).
 */
export function m1TailCalibration(picks: TailPick[]): M1Result {
  const tail = picks.filter((p) => Number.isFinite(p.emosP) && p.emosP < TAIL_CALIB.emosTailMax);
  const n = tail.length;
  const nWon = tail.filter((p) => p.won).length;
  const freq = wilsonInterval(nWon, n);
  const gap = meanConfidenceInterval(tail.map((p) => (p.won ? 1 : 0) - p.emosP));
  return {
    n,
    empiricalFreq: n === 0 ? NaN : nWon / n,
    freqCiLo: freq.lo,
    freqCiHi: freq.hi,
    meanEmosP: n === 0 ? NaN : tail.reduce((a, p) => a + p.emosP, 0) / n,
    gap: gap.mean,
    gapCiLo: gap.lo,
    gapCiHi: gap.hi,
  };
}

/** M3 — tail-local Brier deficit (is the calibration gap tail-specific?). */
export interface M3Result {
  n: number;
  /** Mean per-pick Brier of OUR EMOS_p (squared error vs the 0/1 outcome). */
  brierOurs: number;
  /** Mean per-pick Brier of the contemporaneous market prob. */
  brierMarket: number;
  /** ours − market; NEGATIVE ⇒ our forecast is sharper on the cheap tail. mean ± normal CI. */
  delta: number;
  deltaCiLo: number;
  deltaCiHi: number;
}

/**
 * M3: on the same cheap-tail subset (EMOS_p < 0.15) WITH a market prob, the paired per-pick Brier
 * difference (ours − market). Negative ⇒ our tail is the sharper forecaster there; positive ⇒ the
 * market is (corroborating KILL-GATE 2). Pure; total.
 */
export function m3TailBrier(picks: TailPick[]): M3Result {
  const tail = picks.filter(
    (p) =>
      Number.isFinite(p.emosP) &&
      p.emosP < TAIL_CALIB.emosTailMax &&
      p.marketP != null &&
      Number.isFinite(p.marketP),
  );
  const diffs = tail.map((p) => {
    const o = p.won ? 1 : 0;
    return (p.emosP - o) ** 2 - ((p.marketP as number) - o) ** 2;
  });
  const ci = meanConfidenceInterval(diffs);
  const n = tail.length;
  return {
    n,
    brierOurs: n === 0 ? NaN : tail.reduce((a, p) => a + (p.emosP - (p.won ? 1 : 0)) ** 2, 0) / n,
    brierMarket:
      n === 0 ? NaN : tail.reduce((a, p) => a + ((p.marketP as number) - (p.won ? 1 : 0)) ** 2, 0) / n,
    delta: ci.mean,
    deltaCiLo: ci.lo,
    deltaCiHi: ci.hi,
  };
}

/** One badatmath entry-price decile — their realized per-bet edge by price band (M4). */
export interface DecileRow {
  /** 1..nBins, ascending by entry price. */
  decile: number;
  n: number;
  meanEntry: number;
  /** Empirical resolution frequency in the band. */
  hitRate: number;
  /** hitRate − meanEntry: their realized edge in the band (positive ⇒ underpriced by the market). */
  edge: number;
}

/**
 * M4: badatmath's realized per-bet edge by ENTRY-PRICE decile (the target we'd be trying to match).
 * Bins the picks into `nBins` equal-count bands by entry price (ascending) and reports n, mean entry,
 * hit rate, and edge (hit − entry) per band. Descriptive. Pure; total ([] on empty).
 */
export function m4EntryDeciles(picks: TailPick[], nBins = 10): DecileRow[] {
  const usable = picks
    .filter((p) => Number.isFinite(p.entryPrice) && p.entryPrice > 0)
    .slice()
    .sort((a, b) => a.entryPrice - b.entryPrice);
  const N = usable.length;
  if (N === 0) return [];
  const bins = Math.min(nBins, N);
  const out: DecileRow[] = [];
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor((b * N) / bins);
    const hi = Math.floor(((b + 1) * N) / bins);
    const band = usable.slice(lo, hi);
    if (band.length === 0) continue;
    const meanEntry = band.reduce((a, p) => a + p.entryPrice, 0) / band.length;
    const hitRate = band.filter((p) => p.won).length / band.length;
    out.push({ decile: b + 1, n: band.length, meanEntry, hitRate, edge: hitRate - meanEntry });
  }
  return out;
}

export type TailCase =
  | 'A_FIXABLE_FORECAST'
  | 'KILL_NOT_THE_GAP'
  | 'AMBIGUOUS'
  | 'INSUFFICIENT';

/** The pre-registered M1 adjudication (BADATMATH-GAP-PLAN.md §5 branch table). */
export interface TailVerdict {
  case: TailCase;
  /** ≥ +3pp AND lower-95% CI > 0. */
  m1Pass: boolean;
  /** < +1pp (the combined-kill arm; binding only with M2 already FAIL). */
  m1Kill: boolean;
  summary: string;
  /** The frozen next move this result routes to. */
  next: string;
}

/**
 * Adjudicate M1 against the FROZEN thresholds + the §5 branch table. `m2Failed` is the §12 maker-spray
 * result (TRUE — its lower-CI < 0), passed explicitly so the combined kill is auditable, not hidden.
 * Pure; deterministic.
 */
export function tailCalibrationVerdict(m1: M1Result, opts: { m2Failed: boolean }): TailVerdict {
  if (m1.n < TAIL_CALIB.minN || !Number.isFinite(m1.gap)) {
    return {
      case: 'INSUFFICIENT',
      m1Pass: false,
      m1Kill: false,
      summary: `n=${m1.n} cheap-tail picks (< ${TAIL_CALIB.minN}) — insufficient evidence to adjudicate`,
      next: 'Crawl more fills / widen the window before reading the gap.',
    };
  }
  // m1Pass / m1Kill are properties of M1 ALONE (always reported truthfully); only the CASE routing
  // depends on M2 — the combined kill fires only when the M1 arm AND the §12 M2 FAIL coincide.
  const m1Pass = m1.gap >= TAIL_CALIB.m1PassEdge && m1.gapCiLo > 0;
  const m1Kill = m1.gap < TAIL_CALIB.m1KillEdge;
  const pp = (v: number) => `${(v * 100).toFixed(2)}pp`;
  const band = `gap ${pp(m1.gap)} [${pp(m1.gapCiLo)}, ${pp(m1.gapCiHi)}] (n=${m1.n})`;
  if (m1Pass) {
    return {
      case: 'A_FIXABLE_FORECAST',
      m1Pass,
      m1Kill,
      summary: `Case A — OUR tail is UNDERWEIGHTED: ${band}. Their cheap picks resolve materially more often than EMOS predicts.`,
      next: 'Move 7 — tail recalibration (kernel dressing / ensemble inflation / σ-tail widening), THEN re-run the maker-spray harvest. Not a live-rail reopen.',
    };
  }
  if (m1Kill && opts.m2Failed) {
    return {
      case: 'KILL_NOT_THE_GAP',
      m1Pass,
      m1Kill,
      summary: `PRE-COMMITTED KILL — our forecast is NOT the gap: ${band} (< +1pp) AND M2 (maker-spray) already FAIL.`,
      next: 'Route to Moves 3/4 (intraday running-max physics — genuinely new out-of-market info); if those null too, the destination is the analytics product (Move 10). Do NOT spawn a new forecast lever.',
    };
  }
  return {
    case: 'AMBIGUOUS',
    m1Pass,
    m1Kill,
    summary: `AMBIGUOUS — ${band}: between +1pp and +3pp, ≥+3pp with a CI that includes 0, or the kill arm without an M2 fail. A weak signal, not a clean PASS.`,
    next: 'Treat as an analytics input (the sharp ≈ our tail). Do NOT reopen the harvest on this alone.',
  };
}
