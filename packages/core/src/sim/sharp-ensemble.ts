/**
 * core/sim/sharp-ensemble — MOVE 5: the sharps as FORECASTERS, not traders to copy
 * (BADATMATH-GAP-PLAN.md §3 Move 5). The pure analytics twin of the
 * `scripts/research/m5-sharp-ensemble.ts` spine.
 *
 * THE QUESTION (the one Move the four falsified angles never asked). §10–§13 of
 * WALLET-RECON-HANDOFF.md falsified every way to *trade* badatmath (forecast-beats-market,
 * day-before-edge, copy-trade-mirror, maker-spray) — all harvesting problems. None asked the
 * forecasting question: **does the sharp's revealed cheap-spray carry orthogonal information that,
 * folded into a stacked forecaster, beats the market-implied distribution we already lose to?**
 * The market is the sharper forecaster (KILL-GATE 2 / M3), so the ONLY honest baseline is the
 * market-implied distribution — not our EMOS. This module builds the stack and scores it against it.
 *
 * POSTURE: analytics study, NOT a trading green-light. The deliverable is a *forecast* — the
 * "smart-money-consensus" distribution — and the analytics measurement of whether smart money adds
 * orthogonal skill over the market. A PASS upgrades the forecast/analytics product; it does NOT
 * reopen the (dormant) live rail (the harvest is still adverse-selection-bound — §12). A KILL is
 * itself the deliverable: a clean "the #1 sharp's revealed distribution is already priced by the
 * market" measurement. Ships nothing to prod, no migration, never imports `packages/trading`.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * FROZEN METRICS + THRESHOLDS — pre-registered (BADATMATH-GAP-PLAN.md §3 Move 5). DO NOT MOVE THEM
 * to fit a result (WO-5 discipline). The §12 heavy-tailed-EV mis-design lesson is honored: the
 * BINDING metric is the LOW-VARIANCE paired per-event multi-category Brier difference, whose normal
 * CI is trustworthy — never a per-bet EV. Three independent guards must ALL clear (no single-metric
 * pass): the low-variance CI, the paired bootstrap, and a zero-skill Monte-Carlo on the sharp signal.
 *   • Universe:            sharp-TOUCHED resolved events — the sharp bet ≥1 bucket at < cheapMax (the
 *                          cheap-longshot "engine", §3) — with a valid market dist + EMOS dist.
 *   • Forecasters (each a per-event distribution over the ladder, Σ=1):
 *       MARKET = renormalized market-implied asks at entry (the baseline that already beats us).
 *       EMOS   = our walk-forward gaussian bucket probs (already normalized).
 *       SHARP  = MARKET tilted toward the sharp's cheap revealed stake: mkt·(1+λ·stakeShare),
 *                renormalized (λ frozen — never zeros the favourite, so it is a fair forecaster).
 *   • Stacks (walk-forward CONVEX weights, fit on STRICTLY-PRIOR target dates only — no lookahead):
 *       M+S   = the BINDING arm (does the sharp add over the market?).
 *       M+E+S = the full smart-money consensus; M+E = the EMOS-confound control.
 *   • M5 PASS (the sharp adds orthogonal skill):  pooled (Brier_MARKET − Brier_{M+S}) > 0 with
 *       lower-95% CI > 0  AND  pairedBootstrapPValue(Brier_{M+S} − Brier_MARKET) < alpha  AND the
 *       zero-skill-MC P(PASS | shuffled sharp) < zeroSkillMax  AND the marginal sharp arm
 *       (Brier_{M+E} − Brier_{M+E+S}) lower-CI > 0 (the sharp adds BEYOND market+our-forecast too).
 *   • M5 KILL (no orthogonal info):  the binding CI includes 0 OR p ≥ alpha → the sharp's revealed
 *       distribution is already priced by the market → analytics product (Move 10). The default prior.
 *   • minN = 30:  below it the study is INSUFFICIENT (mirrors pairedBootstrapPValue's n<30 guard).
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
import { brierScore, mulberry32, pairedBootstrapPValue } from '../calibration/scores.ts';
import { meanConfidenceInterval, type MeanCi } from './stats.ts';

/** The frozen Move-5 cut + thresholds. Pre-registered; do not move (WO-5). */
export const SHARP_ENSEMBLE = {
  /** The cheap-longshot "engine" cut: a bucket counts as a sharp pick only at an entry < this. */
  cheapMax: 0.25,
  /** Tilt strength of the sharp's revealed stake on the market prior. Frozen; robustness-checkable. */
  tiltLambda: 4,
  /** Walk-forward convex-weight grid step (coarse → small overfit surface). */
  gridStep: 0.05,
  /** Min training events on STRICTLY-prior target dates before a stack is fit; else defer to market. */
  minTrain: 20,
  /** Below this many scored sharp-touched events the study is INSUFFICIENT (paired-bootstrap n<30). */
  minN: 30,
  /** Paired-bootstrap significance threshold (the stack reliably beats the market). */
  alpha: 0.05,
  /** Zero-skill MC: P(PASS | shuffled sharp signal) must be below this to trust the gate. */
  zeroSkillMax: 0.05,
  /** Deterministic seeds + iters (the repo reproducibility contract — determinism is load-bearing). */
  bootstrapSeed: 42,
  mcSeed: 1234,
  mcIters: 200,
} as const;

/** The three stackable forecasters. 'market' is ALWAYS index 0 of a key list (the baseline). */
export type ForecasterKey = 'market' | 'emos' | 'sharp';

/** One ladder bucket of a resolved event, carrying all three forecasters' raw inputs. */
export interface EnsembleBucket {
  /** The ladder bucket index (the join key to winnerIdx — NOT necessarily the array position). */
  bucketIdx: number;
  /** OUR walk-forward EMOS prob for this bucket (gaussianBucketProbs — already ~normalized over the ladder). */
  emosP: number;
  /** Contemporaneous market-implied prob (the ask at our entry-lead) for this bucket, or null. */
  marketP: number | null;
  /** The sharp's revealed stake (USDC) on this bucket — 0 if they did not bet it. */
  sharpStakeUsd: number;
  /** The sharp's volume-weighted entry price on this bucket (the cheap-engine cut), or null if unbet. */
  sharpEntryPrice: number | null;
}

/** One resolved bucket event = the unit of the study (the full ladder + the realized winner). */
export interface EnsembleEvent {
  eventId: string;
  station: string;
  citySlug: string;
  /** ISO target date — the walk-forward ordering key (fit on strictly-earlier dates only). */
  targetDate: string;
  lead: number;
  /** The winning ladder bucketIdx (joined to a bucket's `bucketIdx`, not the array position). */
  winnerIdx: number;
  /** The FULL ladder (ascending bucketIdx). */
  buckets: EnsembleBucket[];
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// distribution helpers (pure, total)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Renormalize to a probability distribution; null if no positive finite mass. */
function renormalize(xs: number[]): number[] | null {
  let sum = 0;
  for (const x of xs) {
    if (!Number.isFinite(x) || x < 0) return null;
    sum += x;
  }
  if (sum <= 0) return null;
  return xs.map((x) => x / sum);
}

/** MARKET = renormalized market-implied asks at entry. null if < 2 buckets carry a usable ask. */
export function marketDist(ev: EnsembleEvent): number[] | null {
  const usable = ev.buckets.filter(
    (b) => b.marketP != null && Number.isFinite(b.marketP) && b.marketP > 0,
  );
  if (usable.length < 2) return null;
  return renormalize(ev.buckets.map((b) => (b.marketP != null && b.marketP > 0 ? b.marketP : 0)));
}

/** EMOS = renormalized walk-forward gaussian bucket probs. null if no positive mass. */
export function emosDist(ev: EnsembleEvent): number[] | null {
  return renormalize(ev.buckets.map((b) => (Number.isFinite(b.emosP) && b.emosP > 0 ? b.emosP : 0)));
}

/**
 * SHARP = the MARKET prior tilted toward the sharp's CHEAP revealed stake: mkt·(1+λ·share),
 * renormalized. `share` is computed over buckets the sharp bet at < cheapMax (the engine, §3). The
 * tilt never zeros the favourite (it multiplies the market mass), so SHARP is a fair standalone
 * forecaster, not a degenerate stake-share. null if MARKET is null or the sharp made no cheap pick.
 */
export function sharpDist(ev: EnsembleEvent, lambda: number = SHARP_ENSEMBLE.tiltLambda): number[] | null {
  const mkt = marketDist(ev);
  if (mkt == null) return null;
  const stakes = ev.buckets.map((b) =>
    b.sharpStakeUsd > 0 &&
    Number.isFinite(b.sharpStakeUsd) &&
    b.sharpEntryPrice != null &&
    b.sharpEntryPrice < SHARP_ENSEMBLE.cheapMax
      ? b.sharpStakeUsd
      : 0,
  );
  const total = stakes.reduce((a, s) => a + s, 0);
  if (total <= 0) return null;
  const tilted = mkt.map((m, i) => m * (1 + lambda * (stakes[i]! / total)));
  return renormalize(tilted);
}

/** Convex blend of aligned distributions: Σ wᵢ·distᵢ, renormalized. weights need not pre-sum to 1. */
export function blend(dists: number[][], weights: number[]): number[] {
  const k = dists.length;
  const len = dists[0]!.length;
  const out = new Array<number>(len).fill(0);
  for (let i = 0; i < k; i++) {
    const w = weights[i]!;
    const d = dists[i]!;
    for (let j = 0; j < len; j++) out[j]! += w * d[j]!;
  }
  return renormalize(out) ?? dists[0]!;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// per-event prepared inputs (forecaster dists + the outcome's array position)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** An event reduced to its three forecaster dists + the winner's ARRAY position (not bucketIdx). */
export interface PreparedEvent {
  ev: EnsembleEvent;
  market: number[];
  emos: number[];
  sharp: number[];
  /** The winner's index into the (aligned) distribution arrays; -1 if the winner is off-ladder. */
  outcomePos: number;
}

/**
 * Reduce an event to the study universe form: all three forecaster dists present, a valid market +
 * EMOS, the sharp touched a cheap bucket, and the winner is on the ladder. Returns null if the event
 * is not in the universe (any forecaster undefined / winner off-ladder). Pure.
 */
export function prepareEvent(ev: EnsembleEvent, lambda: number = SHARP_ENSEMBLE.tiltLambda): PreparedEvent | null {
  if (ev.buckets.length < 2) return null;
  const market = marketDist(ev);
  const emos = emosDist(ev);
  const sharp = sharpDist(ev, lambda);
  if (market == null || emos == null || sharp == null) return null;
  const outcomePos = ev.buckets.findIndex((b) => b.bucketIdx === ev.winnerIdx);
  if (outcomePos < 0) return null;
  return { ev, market, emos, sharp, outcomePos };
}

/** Pull the dist arrays for a key list out of a prepared event (market always first). */
function distsFor(pe: PreparedEvent, keys: ForecasterKey[]): number[][] {
  return keys.map((k) => (k === 'market' ? pe.market : k === 'emos' ? pe.emos : pe.sharp));
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// walk-forward convex-weight fit (grid search over the simplex, deterministic) → no lookahead
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Enumerate the simplex grid for k weights at the given step (k ∈ {1,2,3}). */
function simplexGrid(k: number, step: number): number[][] {
  if (k <= 1) return [[1]];
  const steps = Math.round(1 / step);
  const out: number[][] = [];
  if (k === 2) {
    for (let i = 0; i <= steps; i++) out.push([i / steps, 1 - i / steps]);
    return out;
  }
  // k === 3
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps - i; j++) {
      out.push([i / steps, j / steps, (steps - i - j) / steps]);
    }
  }
  return out;
}

/**
 * Fit convex blend weights (one per key, Σ=1) minimizing the POOLED multi-category Brier over the
 * training events, by deterministic simplex grid search. Ties break to the first (lowest-index) grid
 * point — which, since 'market' is index 0 and the grid scans market-weight descending only for k=2,
 * favours the simpler market-heavier blend. Pure. Empty train → all weight on the first key (market).
 */
export function fitWeights(
  train: { dists: number[][]; outcomePos: number }[],
  keys: ForecasterKey[],
  step: number = SHARP_ENSEMBLE.gridStep,
): number[] {
  const k = keys.length;
  if (k === 1 || train.length === 0) return keys.map((_, i) => (i === 0 ? 1 : 0));
  let best: number[] | null = null;
  let bestBrier = Infinity;
  for (const w of simplexGrid(k, step)) {
    let s = 0;
    for (const t of train) s += brierScore(blend(t.dists, w), t.outcomePos);
    if (s < bestBrier - 1e-12) {
      bestBrier = s;
      best = w;
    }
  }
  return best ?? keys.map((_, i) => (i === 0 ? 1 : 0));
}

/**
 * Walk-forward stack: events scored chronologically by targetDate; for each date the weights are fit
 * on ALL strictly-earlier dates' events (expanding window) then applied to that date's events. Before
 * `minTrain` training events accrue, the stack defers to the market (weight 1 on key 0). Returns the
 * per-event stacked distribution aligned to `prepared` order. Pure (deterministic grid + no RNG).
 */
export function walkForwardStack(
  prepared: PreparedEvent[],
  keys: ForecasterKey[],
  opts: { minTrain?: number; step?: number } = {},
): number[][] {
  const minTrain = opts.minTrain ?? SHARP_ENSEMBLE.minTrain;
  const step = opts.step ?? SHARP_ENSEMBLE.gridStep;
  // chronological order; stable by eventId within a date for determinism.
  const order = prepared
    .map((pe, idx) => ({ pe, idx }))
    .sort((a, b) =>
      a.pe.ev.targetDate < b.pe.ev.targetDate
        ? -1
        : a.pe.ev.targetDate > b.pe.ev.targetDate
          ? 1
          : a.pe.ev.eventId < b.pe.ev.eventId
            ? -1
            : a.pe.ev.eventId > b.pe.ev.eventId
              ? 1
              : 0,
    );
  const out = new Array<number[]>(prepared.length);
  const trainPool: { dists: number[][]; outcomePos: number }[] = [];
  let i = 0;
  while (i < order.length) {
    const date = order[i]!.pe.ev.targetDate;
    let j = i;
    while (j < order.length && order[j]!.pe.ev.targetDate === date) j++;
    // fit on the pool as it stands BEFORE this date's events are added (no lookahead)
    const weights =
      trainPool.length >= minTrain ? fitWeights(trainPool, keys, step) : keys.map((_, k) => (k === 0 ? 1 : 0));
    for (let m = i; m < j; m++) {
      const { pe, idx } = order[m]!;
      out[idx] = blend(distsFor(pe, keys), weights);
    }
    for (let m = i; m < j; m++) {
      const { pe } = order[m]!;
      trainPool.push({ dists: distsFor(pe, keys), outcomePos: pe.outcomePos });
    }
    i = j;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// scoring: paired per-event Brier diffs vs MARKET, the low-variance CI + the paired bootstrap
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One stacked arm scored against the market baseline (paired, per-event). */
export interface ArmScore {
  key: string;
  n: number;
  brierStack: number;
  brierBaseline: number;
  /** Pooled (Brier_baseline − Brier_stack): POSITIVE ⇒ the stack is the sharper forecaster. */
  improvement: MeanCi;
  /** pairedBootstrapPValue(Brier_stack − Brier_baseline): < alpha ⇒ stack reliably better. */
  pValue: number;
}

/** Per-event Brier of a set of distributions vs their outcome positions. */
function brierSeries(dists: number[][], prepared: PreparedEvent[]): number[] {
  return dists.map((d, i) => brierScore(d, prepared[i]!.outcomePos));
}

/**
 * Score a stacked arm against a baseline series, paired per event. `improvement` is the low-variance
 * (baseline − stack) mean CI (positive + lower-CI>0 ⇒ stack reliably sharper); `pValue` is the
 * one-sided paired bootstrap on (stack − baseline) (< alpha ⇒ reliably sharper). Pure.
 */
export function scoreArm(
  key: string,
  stackBrier: number[],
  baselineBrier: number[],
  seed: number = SHARP_ENSEMBLE.bootstrapSeed,
): ArmScore {
  const n = stackBrier.length;
  const improvements = stackBrier.map((s, i) => baselineBrier[i]! - s); // baseline − stack
  const stackMinusBase = stackBrier.map((s, i) => s - baselineBrier[i]!);
  const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, x) => a + x, 0) / xs.length);
  return {
    key,
    n,
    brierStack: mean(stackBrier),
    brierBaseline: mean(baselineBrier),
    improvement: meanConfidenceInterval(improvements),
    pValue: pairedBootstrapPValue(stackMinusBase, 2000, seed),
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// zero-skill Monte-Carlo: shuffle the sharp signal across events, does the gate still "pass"?
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Fisher–Yates shuffle of [0..n) with a seeded RNG (deterministic). */
function shuffledIndices(n: number, rng: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * The false-positive guard (the §12 zero-skill-MC discipline, applied to the SHARP signal). Permute
 * which event's sharp dist is glued to which event's market/outcome, re-run the M+S walk-forward
 * stack, and count how often the binding gate (improvement lower-CI > 0 AND p < alpha) fires on a
 * sharp signal that is — by construction — uninformative. A real edge should clear; noise should not.
 * Returns P(PASS | shuffled sharp) over `iters`. Pure (seeded). The market/emos baselines are fixed;
 * only the sharp dist is permuted, so this isolates the sharp's contribution from the stacking machinery.
 */
export function zeroSkillSharpMc(
  prepared: PreparedEvent[],
  baselineBrier: number[],
  opts: { iters?: number; seed?: number; minTrain?: number; step?: number; alpha?: number } = {},
): { pPass: number; iters: number } {
  const iters = opts.iters ?? SHARP_ENSEMBLE.mcIters;
  const alpha = opts.alpha ?? SHARP_ENSEMBLE.alpha;
  const rng = mulberry32(opts.seed ?? SHARP_ENSEMBLE.mcSeed);
  const n = prepared.length;
  if (n === 0) return { pPass: NaN, iters };
  let passes = 0;
  for (let it = 0; it < iters; it++) {
    const perm = shuffledIndices(n, rng);
    const shuffled = prepared.map((pe, i) => ({ ...pe, sharp: prepared[perm[i]!]!.sharp }));
    const stack = walkForwardStack(shuffled, ['market', 'sharp'], {
      minTrain: opts.minTrain,
      step: opts.step,
    });
    const sb = brierSeries(stack, shuffled);
    const score = scoreArm('mc', sb, baselineBrier, (opts.seed ?? SHARP_ENSEMBLE.mcSeed) + it);
    if (score.improvement.lo > 0 && score.pValue < alpha) passes++;
  }
  return { pPass: passes / iters, iters };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the study: load → prepare → walk-forward all arms → score → verdict
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export type EnsembleCase = 'SHARP_ADDS_SKILL' | 'KILL_ALREADY_PRICED' | 'INSUFFICIENT';

export interface EnsembleVerdict {
  case: EnsembleCase;
  /** The binding M+S arm cleared (CI lower>0 ∧ p<alpha ∧ zero-skill MC < max ∧ marginal sharp clears). */
  pass: boolean;
  summary: string;
  next: string;
}

export interface SharpEnsembleResult {
  /** Sharp-touched events that entered the scored universe (all three forecasters defined). */
  n: number;
  /** Events seen before the universe filter (for the coverage line). */
  nSeen: number;
  /** The binding arm: M+S vs MARKET. */
  marketVsSharp: ArmScore;
  /** The EMOS-confound control: M+E vs MARKET (expected ≈0/negative per KILL-GATE 2). */
  marketVsEmos: ArmScore;
  /** The full smart-money consensus: M+E+S vs MARKET. */
  fullStack: ArmScore;
  /** The marginal sharp contribution beyond market+our-forecast: (M+E) − (M+E+S), paired. */
  marginalSharp: MeanCi;
  /** P(PASS | shuffled sharp) — the false-positive guard. */
  zeroSkill: { pPass: number; iters: number };
  verdict: EnsembleVerdict;
}

/**
 * Run the full Move-5 study on prepared per-event inputs (the spine prepares them from live data).
 * Walk-forward stacks M, M+E, M+S, M+E+S; scores each against the MARKET baseline; runs the
 * zero-skill MC on the sharp signal; adjudicates the FROZEN verdict. Pure / deterministic.
 */
export function runSharpEnsembleStudy(
  events: EnsembleEvent[],
  opts: { lambda?: number; minTrain?: number; step?: number; mcIters?: number; seed?: number } = {},
): SharpEnsembleResult {
  const lambda = opts.lambda ?? SHARP_ENSEMBLE.tiltLambda;
  const prepared = events
    .map((ev) => prepareEvent(ev, lambda))
    .filter((p): p is PreparedEvent => p !== null);
  const n = prepared.length;

  const marketBrier = brierSeries(
    prepared.map((pe) => pe.market),
    prepared,
  );
  const seed = opts.seed ?? SHARP_ENSEMBLE.bootstrapSeed;

  const msStack = walkForwardStack(prepared, ['market', 'sharp'], opts);
  const meStack = walkForwardStack(prepared, ['market', 'emos'], opts);
  const mesStack = walkForwardStack(prepared, ['market', 'emos', 'sharp'], opts);

  const msBrier = brierSeries(msStack, prepared);
  const meBrier = brierSeries(meStack, prepared);
  const mesBrier = brierSeries(mesStack, prepared);

  const marketVsSharp = scoreArm('M+S', msBrier, marketBrier, seed);
  const marketVsEmos = scoreArm('M+E', meBrier, marketBrier, seed);
  const fullStack = scoreArm('M+E+S', mesBrier, marketBrier, seed);
  // marginal sharp: does adding the sharp to (market+EMOS) help? paired (M+E) − (M+E+S).
  const marginalSharp = meanConfidenceInterval(meBrier.map((b, i) => b - mesBrier[i]!));

  const zeroSkill =
    n >= SHARP_ENSEMBLE.minN
      ? zeroSkillSharpMc(prepared, marketBrier, {
          iters: opts.mcIters,
          seed,
          minTrain: opts.minTrain,
          step: opts.step,
        })
      : { pPass: NaN, iters: opts.mcIters ?? SHARP_ENSEMBLE.mcIters };

  const verdict = ensembleVerdict({ n, marketVsSharp, marginalSharp, zeroSkill });

  return {
    n,
    nSeen: events.length,
    marketVsSharp,
    marketVsEmos,
    fullStack,
    marginalSharp,
    zeroSkill,
    verdict,
  };
}

/**
 * Adjudicate Move-5 against the FROZEN thresholds. PASS requires ALL FOUR guards: the binding M+S
 * improvement CI lower>0, the paired bootstrap p<alpha, the zero-skill MC P(PASS) < max, AND the
 * marginal-sharp CI lower>0 (the sharp adds beyond market+EMOS, neutralizing the EMOS confound). Any
 * miss → KILL (already priced) → analytics product (Move 10). n<minN → INSUFFICIENT. Pure.
 */
export function ensembleVerdict(parts: {
  n: number;
  marketVsSharp: ArmScore;
  marginalSharp: MeanCi;
  zeroSkill: { pPass: number; iters: number };
}): EnsembleVerdict {
  const { n, marketVsSharp: ms, marginalSharp, zeroSkill } = parts;
  if (n < SHARP_ENSEMBLE.minN || !Number.isFinite(ms.improvement.mean)) {
    return {
      case: 'INSUFFICIENT',
      pass: false,
      summary: `n=${n} sharp-touched events (< ${SHARP_ENSEMBLE.minN}) — insufficient to adjudicate.`,
      next: 'Crawl more fills / widen the window before reading the stack.',
    };
  }
  const ciClears = ms.improvement.lo > 0;
  const pClears = ms.pValue < SHARP_ENSEMBLE.alpha;
  const mcClears = Number.isFinite(zeroSkill.pPass) && zeroSkill.pPass < SHARP_ENSEMBLE.zeroSkillMax;
  const marginalClears = Number.isFinite(marginalSharp.lo) && marginalSharp.lo > 0;
  const pass = ciClears && pClears && mcClears && marginalClears;
  const pp = (v: number) => `${(v * 100 >= 0 ? '+' : '')}${(v * 100).toFixed(2)}pp`;
  const band = `M+S improvement ${pp(ms.improvement.mean)} 95% CI [${pp(ms.improvement.lo)}, ${pp(ms.improvement.hi)}] (n=${n}), p=${ms.pValue.toFixed(3)}, zero-skill P(PASS)=${(zeroSkill.pPass * 100).toFixed(1)}%`;
  if (pass) {
    return {
      case: 'SHARP_ADDS_SKILL',
      pass: true,
      summary: `Move 5 PASS — the sharp's revealed distribution adds ORTHOGONAL skill over the market: ${band}.`,
      next: 'Upgrade the forecast/analytics product with the smart-money-consensus forecaster. NOT a live-rail reopen (the harvest is still adverse-selection-bound, §12).',
    };
  }
  return {
    case: 'KILL_ALREADY_PRICED',
    pass: false,
    summary: `Move 5 KILL — the sharp's distribution is already priced by the market (no orthogonal skill): ${band}.`,
    next: 'The measurement IS the deliverable. Route to the analytics product (Move 10). Do NOT spawn a new forecast lever.',
  };
}
