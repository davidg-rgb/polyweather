/**
 * core/sim/selector-learn — REC-1: is badatmath's cheap-bucket SELECTION learnable by us? The pure,
 * deterministic analytics twin of `scripts/research/m7-selector-learnability.ts`. Pre-registration:
 * SELECTOR-LEARNABILITY.md (frozen 2026-06-23).
 *
 * THE QUESTION (the one unrun maker lever — MAKER-REBATE-HANDOFF.md §4 / REC-1). §12 showed our
 * one-feature forecast selection (`calibratedP > restPx`) FAILS (−1.7pp) and indiscriminate selection
 * FAILS (−1.5pp); m6 showed resting on HIS revealed picks is +3.9pp but that is HIS edge (needs his
 * fills, latency wall §11). REC-1: can a SELECTOR trained on a richer set of PRE-ENTRY features
 * (microstructure + our forecast + price-action) independently pick the underpriced cheap buckets, and
 * hold up OUT-OF-SAMPLE? This module is the learning + honest-evaluation core; the script extracts the
 * features (no leakage) and loads the universe.
 *
 * THE BINDING REALISM (SELECTOR-LEARNABILITY.md §0). The cheap-eligible maker universe lives on only
 * ~4 distinct weather-days (book density). A weather-day is the unit of INDEPENDENCE (all stations on a
 * day share one synoptic state), so:
 *   • the honest CI is over CLUSTER MEANS (one weather-day = one unit), NOT per-bucket;
 *   • the honest OOS test is LEAVE-ONE-DAY-OUT (the small-sample form of walk-forward; strict
 *     forward-only is impossible on 4 days);
 *   • the verdict carries a DATA-SUFFICIENCY gate — below MIN_CLUSTERS independent days the result is
 *     INSUFFICIENT_DATA regardless of the point estimate (you cannot validate a learned selector on 4 days).
 *
 * THE GATE CI — a CLUSTER-MEAN t-INTERVAL (calibration amendment, SELECTOR-LEARNABILITY.md §0a). A
 * percentile cluster bootstrap was measured ANTI-CONSERVATIVE at few clusters (H0 false-positive rate
 * 7.5–12.5% at 12 clusters in pre-run simulation). The gate instead uses the textbook clustered-inference
 * interval: each weather-day's mean edge is one observation, and the CI is mean ± t_{K−1}·SD/√K over the
 * K cluster means (equal-weight clusters; t naturally explodes the interval for small K). Pre-run H0
 * simulation: false-positive rate ≈ 0% at K∈{8,12,20}; power ≈ 73–90% for a strong signal (effect 0.5)
 * at K∈{10,12}. This was chosen by calibrating the FALSE-POSITIVE control on simulated H0 data BEFORE the
 * real run (proper pre-registration discipline) — NOT by fitting to the real outcome.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * FROZEN CONFIG + KILL-CRITERION — pre-registered (SELECTOR-LEARNABILITY.md §8). DO NOT MOVE to fit a
 * result (WO-5). The §12 mis-design lesson (a heavy-tailed EV/$1 gate that "passes" pure noise) is
 * honoured: the BINDING metric is the LOW-VARIANCE selection edge (won − restPx) under the CLUSTER-MEAN
 * t-interval, never a per-bet EV. The EV (conservative rebate 0 / realistic weather_fees 0.25) is
 * reported alongside, never the gate.
 *   • cheap cut:      restPx ∈ [0.10, 0.25)   (the §15 engine band).
 *   • selection rule: rest iff pWin > restPx   (the model judges the bucket underpriced).
 *   • MIN_CLUSTERS=8: below 8 independent weather-days → INSUFFICIENT_DATA (today's 4 is far below).
 *   • PASS  = nClusters ≥ MIN_CLUSTERS AND OOS cluster-mean-t edge 95% CI lower bound > 0 AND zero-skill
 *             P(PASS) < 5% AND in-sample ceiling edge > 0.
 *   • FAIL  = nClusters ≥ MIN_CLUSTERS but the OOS CI straddles/below 0, OR zero-skill P(PASS) ≥ 5%.
 *   • INSUFFICIENT_DATA = nClusters < MIN_CLUSTERS.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Idiom: pure + total + deterministic. The logistic fit uses NO randomness (fixed zero init); the
 * zero-skill Monte-Carlo seeds `mulberry32` (seed 42 default) → byte-identical runs. Empty / degenerate
 * input returns a zeroed report (NaN point estimates), never throws. Non-finite feature rows can never be
 * selected (dot→NaN→pWin NaN→`NaN > restPx` is false); the script drops them upstream and reports coverage.
 */
import { mulberry32 } from '../calibration/scores.ts';
import { makerNetEvPerDollar } from './maker-spray.ts';
import { meanConfidenceInterval } from './stats.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// FROZEN config (pre-registered — do not move)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export const SELECTOR_LEARN = {
  /** Cheap-longshot band floor (the §15 engine band). */
  cheapLo: 0.1,
  /** Cheap-longshot band ceiling (the §3 cut). */
  cheapMax: 0.25,
  /** Below this many independent weather-day clusters → INSUFFICIENT_DATA (cannot validate a selector). */
  minClusters: 8,
  /** Zero-skill calibration-null P(PASS) must be below this to trust a PASS. */
  zeroSkillMaxPPass: 0.05,
  /** Weather-replica taker-fee rate (for the maker EV report). */
  feeRate: 0.05,
  /** Realistic weather_fees maker rebate share (the live config). */
  rebateRate: 0.25,
  /** Default L2 strength (per-sample scaled). */
  l2: 1.0,
  /** Logistic gradient-descent iterations. */
  fitIters: 600,
  /** Logistic gradient-descent learning rate. */
  fitLr: 0.3,
  /** The reproducibility seed (the zero-skill Monte-Carlo). */
  seed: 42,
} as const;

/** Two-sided 95% Student-t critical values, df 1..30 (then ≈ z for df > 30). */
const T95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
  2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
  2.045, 2.042,
];

/** Two-sided 95% t critical value for `df` degrees of freedom (z for df > 30). NaN for df ≤ 0. */
export function tCritical95(df: number): number {
  if (df <= 0) return NaN;
  return df <= 30 ? T95[df - 1]! : 1.959963984540054;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One cheap-eligible bucket reduced to its pre-entry feature vector + outcome + independence cluster. */
export interface LabeledPick {
  /** The pre-entry feature vector (SAME length + order across every pick). */
  features: number[];
  /** The rested price (entry best-bid, tick-floored), in (0,1) — the bar `pWin` must beat. */
  restPx: number;
  /** Resolved outcome: did this bucket win. */
  won: boolean;
  /** The independence unit — the weather-day (target_date). Outcomes within a cluster are correlated. */
  cluster: string;
  /** market_buckets.fee_rate for the maker EV. */
  feeRate: number;
}

/** A standardised + fitted logistic model (the scaler travels with the weights — fit on TRAIN only). */
export interface LogisticModel {
  weights: number[];
  bias: number;
  /** Per-feature train mean (the standardiser). */
  mean: number[];
  /** Per-feature train SD (0 → that constant feature contributes nothing). */
  std: number[];
}

/** A pick the selector chose to rest on, carrying the model's `pWin` for drill-down. */
export interface SelectedPick {
  restPx: number;
  won: boolean;
  cluster: string;
  feeRate: number;
  /** The model's predicted win probability (the reason it was selected: pWin > restPx). */
  pWin: number;
}

/** A confidence-interval triple. */
export interface Ci {
  mean: number;
  lo: number;
  hi: number;
}

/** The statistics of one selected set (the binding gate is `edgeClusterT`). */
export interface SelectionStats {
  n: number;
  nClusters: number;
  nWon: number;
  winRate: number;
  /** Selection edge (won − restPx), per-bucket mean ± z·SE (OPTIMISTIC — ignores day-clustering). */
  edge: Ci;
  /** Selection edge under the CLUSTER-MEAN t-interval (the HONEST gate; equal-weight weather-days). */
  edgeClusterT: Ci;
  /** Maker fee-net EV/$1, conservative (rebate 0 — full taker fee charged), cluster-mean t-interval. */
  evConservative: Ci;
  /** Maker fee-net EV/$1, realistic (weather_fees rebateRate 0.25), cluster-mean t-interval. */
  evRealistic: Ci;
}

/** The zero-skill calibration-null false-positive calibration. */
export interface ZeroSkillNull {
  /** P(OOS cluster-t edge CI clears 0 | outcomes drawn from a calibrated market). < 5% to trust. */
  pPass: number;
  iters: number;
}

export type SelectorOutcome = 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA';

/** The adjudication against the frozen kill-criterion. */
export interface SelectorVerdict {
  outcome: SelectorOutcome;
  nClusters: number;
  minClusters: number;
  /** The honest OOS (leave-one-day-out) selection stats — the gate reads `oos.edgeClusterT`. */
  oos: SelectionStats;
  /** The in-sample ceiling (optimistic upper bound) — a PASS precondition. */
  inSample: SelectionStats;
  zeroSkillPPass: number;
  summary: string;
}

/** Knobs for the learning + evaluation (defaults = the frozen config). */
export interface SelectorOpts {
  l2?: number;
  fitIters?: number;
  fitLr?: number;
  feeRate?: number;
  rebateRate?: number;
  seed?: number;
  /** Zero-skill Monte-Carlo iterations (0 → skip the null; the script default is ~200). */
  mcIters?: number;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// logistic regression (L2, standardised, deterministic — no RNG)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Numerically-stable logistic sigmoid. */
export function sigmoid(z: number): number {
  if (!Number.isFinite(z)) return NaN;
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

/** Per-column mean + population SD over a feature matrix (the standardiser). Total ({[],[]} on empty). */
export function fitStandardizer(X: number[][]): { mean: number[]; std: number[] } {
  const n = X.length;
  if (n === 0) return { mean: [], std: [] };
  const d = X[0]!.length;
  const mean = new Array<number>(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j]! += row[j]!;
  for (let j = 0; j < d; j++) mean[j]! /= n;
  const std = new Array<number>(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) std[j]! += (row[j]! - mean[j]!) ** 2;
  for (let j = 0; j < d; j++) std[j]! = Math.sqrt(std[j]! / n);
  return { mean, std };
}

/** Standardise one row with a fitted scaler; a 0-SD (constant) column maps to 0 (no contribution). */
export function standardizeRow(x: number[], mean: number[], std: number[]): number[] {
  return x.map((v, j) => {
    const s = std[j]!;
    return s > 0 ? (v - mean[j]!) / s : 0;
  });
}

/**
 * Fit L2-regularised logistic regression by full-batch gradient descent. Standardises X internally on
 * THIS X (the train fold — the scaler travels with the model so prediction applies the same transform).
 * Deterministic: zero init, fixed iteration count, no RNG. The L2 gradient (`l2·w/n`) is per-sample
 * scaled so it is comparable to the averaged data term; the bias is unpenalised. Total: n=0 → an empty
 * model (predictProba → 0.5).
 */
export function fitLogisticL2(
  X: number[][],
  y: number[],
  opts: { l2?: number; iters?: number; lr?: number } = {},
): LogisticModel {
  const n = X.length;
  if (n === 0) return { weights: [], bias: 0, mean: [], std: [] };
  const d = X[0]!.length;
  const { mean, std } = fitStandardizer(X);
  const Z = X.map((row) => standardizeRow(row, mean, std));
  const l2 = opts.l2 ?? SELECTOR_LEARN.l2;
  const iters = opts.iters ?? SELECTOR_LEARN.fitIters;
  const lr = opts.lr ?? SELECTOR_LEARN.fitLr;
  const w = new Array<number>(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    let gb = 0;
    const gw = new Array<number>(d).fill(0);
    for (let i = 0; i < n; i++) {
      const p = sigmoid(dot(w, Z[i]!) + b);
      const err = p - y[i]!;
      gb += err;
      for (let j = 0; j < d; j++) gw[j]! += err * Z[i]![j]!;
    }
    b -= lr * (gb / n);
    for (let j = 0; j < d; j++) w[j]! -= lr * (gw[j]! / n + (l2 * w[j]!) / n);
  }
  return { weights: w, bias: b, mean, std };
}

/** Predicted win probability for one feature row; an empty model or non-finite row → not-selectable. */
export function predictProba(model: LogisticModel, x: number[]): number {
  if (model.weights.length === 0) return 0.5;
  const z = standardizeRow(x, model.mean, model.std);
  return sigmoid(dot(model.weights, z) + model.bias);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// cluster-mean t-interval (the honest CI under cross-sectional correlation)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The textbook clustered-inference CI: collapse each cluster to its mean, then form mean ± t_{K−1}·SD/√K
 * over the K cluster means (EQUAL-WEIGHT clusters — one weather-day is one observation). t naturally
 * widens the interval for small K, which is exactly the honest behaviour when only a few independent days
 * exist. Returns `{ mean, lo, hi }` with `mean` = the equal-weight cluster mean. n=0 / mismatched → NaN;
 * a single cluster → a degenerate CI at its mean (no between-cluster spread to estimate).
 */
export function clusterMeanTCi(values: number[], clusters: string[]): Ci {
  if (values.length === 0 || values.length !== clusters.length) return { mean: NaN, lo: NaN, hi: NaN };
  const byCluster = new Map<string, { sum: number; n: number }>();
  for (let i = 0; i < values.length; i++) {
    const c = byCluster.get(clusters[i]!) ?? { sum: 0, n: 0 };
    c.sum += values[i]!;
    c.n += 1;
    byCluster.set(clusters[i]!, c);
  }
  const cmeans = [...byCluster.values()].map((c) => c.sum / c.n);
  const k = cmeans.length;
  const mean = cmeans.reduce((a, v) => a + v, 0) / k;
  if (k <= 1) return { mean, lo: mean, hi: mean };
  const variance = cmeans.reduce((a, v) => a + (v - mean) ** 2, 0) / (k - 1);
  const se = Math.sqrt(variance / k);
  const t = tCritical95(k - 1);
  return { mean, lo: mean - t * se, hi: mean + t * se };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// selection (in-sample ceiling + leave-one-cluster-out OOS)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const fitOpts = (opts: SelectorOpts) => ({ l2: opts.l2, iters: opts.fitIters, lr: opts.fitLr });

const toSelected = (p: LabeledPick, pWin: number): SelectedPick => ({
  restPx: p.restPx,
  won: p.won,
  cluster: p.cluster,
  feeRate: p.feeRate,
  pWin,
});

/**
 * The IN-SAMPLE ceiling: fit on ALL picks, select those the model judges underpriced (pWin > restPx).
 * Optimistic upper bound — if even this does not clear, OOS cannot. Pure.
 */
export function inSampleSelect(picks: LabeledPick[], opts: SelectorOpts = {}): SelectedPick[] {
  if (picks.length === 0) return [];
  const model = fitLogisticL2(
    picks.map((p) => p.features),
    picks.map((p) => (p.won ? 1 : 0)),
    fitOpts(opts),
  );
  const out: SelectedPick[] = [];
  for (const p of picks) {
    const pWin = predictProba(model, p.features);
    if (pWin > p.restPx) out.push(toSelected(p, pWin));
  }
  return out;
}

/**
 * Leave-one-CLUSTER-out OOS (the honest small-sample walk-forward): for each weather-day, train on the
 * OTHER days, predict the held-out day, select pWin > restPx, pool. Tests whether selection skill
 * GENERALISES across independent weather states (not within one day). Pure; deterministic.
 */
export function leaveOneClusterOut(picks: LabeledPick[], opts: SelectorOpts = {}): SelectedPick[] {
  const clusters = [...new Set(picks.map((p) => p.cluster))].sort();
  if (clusters.length < 2) return []; // need ≥2 clusters to hold one out
  const out: SelectedPick[] = [];
  for (const c of clusters) {
    const train = picks.filter((p) => p.cluster !== c);
    const test = picks.filter((p) => p.cluster === c);
    if (train.length === 0) continue;
    const model = fitLogisticL2(
      train.map((p) => p.features),
      train.map((p) => (p.won ? 1 : 0)),
      fitOpts(opts),
    );
    for (const t of test) {
      const pWin = predictProba(model, t.features);
      if (pWin > t.restPx) out.push(toSelected(t, pWin));
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// selection statistics
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const NAN_CI: Ci = { mean: NaN, lo: NaN, hi: NaN };

/**
 * Reduce a selected set to the binding selection-edge (won − restPx, per-bucket optimistic CI AND the
 * cluster-mean t-interval gate) and the maker fee-net EV/$1 (conservative rebate 0 + realistic
 * weather_fees 0.25, each a cluster-mean t-interval). Pure; total (empty → a zeroed/NaN bundle). The
 * `edgeClusterT` CI is the gate; everything else is reported alongside.
 */
export function selectionStats(sel: SelectedPick[], opts: SelectorOpts = {}): SelectionStats {
  const n = sel.length;
  const clusters = new Set(sel.map((s) => s.cluster));
  if (n === 0) {
    return {
      n: 0,
      nClusters: 0,
      nWon: 0,
      winRate: NaN,
      edge: NAN_CI,
      edgeClusterT: NAN_CI,
      evConservative: NAN_CI,
      evRealistic: NAN_CI,
    };
  }
  const feeRate = opts.feeRate ?? SELECTOR_LEARN.feeRate;
  const rebateRate = opts.rebateRate ?? SELECTOR_LEARN.rebateRate;

  const clusterKeys = sel.map((s) => s.cluster);
  const edges = sel.map((s) => (s.won ? 1 : 0) - s.restPx);
  const edgeMean = meanConfidenceInterval(edges);
  const edgeClusterT = clusterMeanTCi(edges, clusterKeys);

  const evCons = sel.map((s) => makerNetEvPerDollar(s.restPx, s.won, s.feeRate || feeRate, 0, 0));
  const evReal = sel.map((s) => makerNetEvPerDollar(s.restPx, s.won, s.feeRate || feeRate, 0, rebateRate));

  const nWon = sel.filter((s) => s.won).length;
  return {
    n,
    nClusters: clusters.size,
    nWon,
    winRate: nWon / n,
    edge: { mean: edgeMean.mean, lo: edgeMean.lo, hi: edgeMean.hi },
    edgeClusterT,
    evConservative: clusterMeanTCi(evCons, clusterKeys),
    evRealistic: clusterMeanTCi(evReal, clusterKeys),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// zero-skill calibration-null
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The defence-in-depth false-positive guard (the cluster-mean t-interval is the primary control). Draw
 * each pick's outcome `won_i ~ Bernoulli(restPx_i)` — a perfectly calibrated market (true edge 0) — then
 * re-run the WHOLE selector pipeline (fit → select → cluster-t edge CI) and count P(CI lower bound > 0).
 * `mode` picks the pipeline: 'loco' (honest) or 'insample' (ceiling). Seeded; total. NOTE: the null
 * conditions on the OBSERVED feature geometry, so it can understate the true FPR at few clusters — the
 * MIN_CLUSTERS gate and the cluster-t interval are the real protection; this is a corroborating check.
 */
export function zeroSkillNull(
  picks: LabeledPick[],
  mode: 'loco' | 'insample',
  opts: SelectorOpts = {},
): ZeroSkillNull {
  const iters = opts.mcIters ?? 0;
  if (picks.length === 0 || iters <= 0) return { pPass: NaN, iters: Math.max(0, iters) };
  const rand = mulberry32((opts.seed ?? SELECTOR_LEARN.seed) ^ 0x5eed);
  let passes = 0;
  for (let it = 0; it < iters; it++) {
    const synthetic: LabeledPick[] = picks.map((p) => ({ ...p, won: rand() < p.restPx }));
    const sel = mode === 'loco' ? leaveOneClusterOut(synthetic, opts) : inSampleSelect(synthetic, opts);
    if (sel.length === 0) continue;
    const edges = sel.map((s) => (s.won ? 1 : 0) - s.restPx);
    const ci = clusterMeanTCi(edges, sel.map((s) => s.cluster));
    if (Number.isFinite(ci.lo) && ci.lo > 0) passes++;
  }
  return { pPass: passes / iters, iters };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// verdict + orchestrator
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const pp = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}pp` : '—');
const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');

/**
 * Adjudicate against the FROZEN kill-criterion (SELECTOR-LEARNABILITY.md §8). Reads ONLY the cluster-mean
 * t OOS edge CI, the zero-skill P(PASS), the in-sample ceiling edge, and the cluster count. Below
 * MIN_CLUSTERS → INSUFFICIENT_DATA (cannot validate, regardless of the point estimate). Pure.
 */
export function selectorVerdict(args: {
  oos: SelectionStats;
  inSample: SelectionStats;
  zeroSkillPPass: number;
  nClusters: number;
  minClusters?: number;
}): SelectorVerdict {
  const minClusters = args.minClusters ?? SELECTOR_LEARN.minClusters;
  const { oos, inSample, zeroSkillPPass, nClusters } = args;

  let outcome: SelectorOutcome;
  let summary: string;
  if (nClusters < minClusters) {
    outcome = 'INSUFFICIENT_DATA';
    summary =
      `INSUFFICIENT_DATA — only ${nClusters} independent weather-day cluster(s) (< MIN_CLUSTERS ${minClusters}). ` +
      `A learned selector cannot be validated on so few independent days; today's universe is book-density-limited. ` +
      `OOS cluster-t edge ${pp(oos.edgeClusterT.mean)} [${pp(oos.edgeClusterT.lo)}, ${pp(oos.edgeClusterT.hi)}], ` +
      `in-sample ceiling ${pp(inSample.edge.mean)}, zero-skill P(PASS) ${pctf(zeroSkillPPass)} — reported as ` +
      `supporting evidence only. Re-run when book density grows (REC-3/REC-4). Rail stays DORMANT.`;
  } else {
    const oosClears = Number.isFinite(oos.edgeClusterT.lo) && oos.edgeClusterT.lo > 0;
    const nullOk = Number.isFinite(zeroSkillPPass) && zeroSkillPPass < SELECTOR_LEARN.zeroSkillMaxPPass;
    const ceilingOk = Number.isFinite(inSample.edge.mean) && inSample.edge.mean > 0;
    if (oosClears && nullOk && ceilingOk) {
      outcome = 'PASS';
      summary =
        `PASS — OOS cluster-t selection edge ${pp(oos.edgeClusterT.mean)} 95% CI ` +
        `[${pp(oos.edgeClusterT.lo)}, ${pp(oos.edgeClusterT.hi)}] clears 0 over ${nClusters} clusters; ` +
        `zero-skill P(PASS) ${pctf(zeroSkillPPass)} < 5%; in-sample ceiling ${pp(inSample.edge.mean)} > 0. ` +
        `Capturable selector candidate — ESCALATE to adversarial re-verification, THEN REC-2 (execution realism).`;
    } else {
      outcome = 'FAIL';
      summary =
        `FAIL — OOS cluster-t edge ${pp(oos.edgeClusterT.mean)} [${pp(oos.edgeClusterT.lo)}, ${pp(oos.edgeClusterT.hi)}]` +
        `${oosClears ? '' : ' does NOT clear 0'}` +
        `${nullOk ? '' : `; zero-skill P(PASS) ${pctf(zeroSkillPPass)} ≥ 5%`}` +
        `${ceilingOk ? '' : '; in-sample ceiling ≤ 0'}. His selection is NOT learnable by us OOS (REC-6). Rail DORMANT.`;
    }
  }
  return { outcome, nClusters, minClusters, oos, inSample, zeroSkillPPass, summary };
}

/** The full REC-1 report (the script renders it; the verdict is `verdict`). */
export interface SelectorLearnReport {
  nPicks: number;
  nClusters: number;
  /** The in-sample ceiling selection (optimistic). */
  inSample: SelectionStats;
  /** The leave-one-day-out OOS selection (honest). */
  oos: SelectionStats;
  /** The zero-skill null on the OOS pipeline (the gate's corroborating false-positive guard). */
  nullOos: ZeroSkillNull;
  verdict: SelectorVerdict;
}

/**
 * Orchestrate REC-1 end-to-end on a labelled universe: in-sample ceiling + LOCO OOS + zero-skill null +
 * the frozen verdict. Pure given `picks`; deterministic. Empty input → a zeroed INSUFFICIENT_DATA report.
 */
export function runSelectorLearn(picks: LabeledPick[], opts: SelectorOpts = {}): SelectorLearnReport {
  const nClusters = new Set(picks.map((p) => p.cluster)).size;
  const inSampleSel = inSampleSelect(picks, opts);
  const oosSel = leaveOneClusterOut(picks, opts);
  const inSample = selectionStats(inSampleSel, opts);
  const oos = selectionStats(oosSel, opts);
  const nullOos = zeroSkillNull(picks, 'loco', opts);
  const verdict = selectorVerdict({
    oos,
    inSample,
    zeroSkillPPass: nullOos.pPass,
    nClusters,
  });
  return { nPicks: picks.length, nClusters, inSample, oos, nullOos, verdict };
}
