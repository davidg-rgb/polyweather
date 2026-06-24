/**
 * core/sim/reward-probe — REC-9: the PURE probe-plan + ground-truth reconciliation for the minimal
 * real-money liquidity-reward probe (REWARD-FARMING-HANDOFF.md §9). The REC-8 first-pass threw a
 * PASS-per-criterion but it is NOT actionable: it is load-bearing on the advertised `rewards_daily_rate`
 * being PAID IN FULL and on an instantaneous-book competition proxy (~$420k maker capital already in-band
 * → an implausibly-high 7.5%/day implied gross). The decisive next step is EMPIRICAL, not more modeling:
 * rest ONE minimum-qualifying two-sided position in a few funded markets for 24h and observe the ACTUAL
 * USDC reward vs. the model's prediction. This module is the pure brain of that probe:
 *
 *   • buildProbePlan — pick the top-N funded markets by predicted reward, rest EXACTLY min_size shares
 *     two-sided `offsetCents` inside the mid (the minimum capital that still qualifies), and predict the
 *     daily reward / fill cost / net via the tested `estimateMarketEconomics` (fixed-size mode). The plan
 *     IS the operator's order list — markets, token, prices, size, capital. NOTHING here places an order;
 *     the live rail stays DORMANT (REWARD-FARMING-HANDOFF §7 guardrail — no `packages/trading` import).
 *
 *   • scoreProbe — after the operator funds + places + waits 24h, compare the ACTUAL observed reward
 *     (and any fills) per market to the prediction. The headline is the REWARD RATIO actual/predicted:
 *       ratio ≈ 1 + net-positive  → GROUND_TRUTH_CONFIRMS (pools pay as advertised; the PASS was real →
 *                                    scale up / design the bot);
 *       ratio ≪ 1                 → OVER_ADVERTISED (the first-pass PASS was an artifact; rail dormant).
 *     This is the §9 "real-but-ephemeral vs. measurement-artifact" decider, settled with ~$50, not math.
 *
 * Pure + total: junk / empty input → an empty plan / INCONCLUSIVE score, never throws. No network, no DB.
 */
import {
  type MarketRewardInputs,
  type RewardFarmingParams,
  DEFAULT_PARAMS,
  TWO_SIDED_LO,
  TWO_SIDED_HI,
  estimateMarketEconomics,
} from './reward-farming.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the probe PLAN (the operator's order list + the model's prediction)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One market to probe: exactly what to rest + what the model predicts it earns. */
export interface ProbeTarget {
  conditionId: string;
  slug: string;
  mid: number;
  dailyPoolUsd: number;
  maxSpreadCents: number;
  /** Shares to rest PER SIDE (= the market's min_size — the minimum qualifying size). */
  sizeShares: number;
  /** Rest a BUY here (mid − offset), tick-clamped into (0,1). */
  bidPx: number;
  /** Rest a SELL here (mid + offset). */
  askPx: number;
  /** Hours until resolution (from end_date_iso vs nowSec); NaN when unknown. */
  hoursToResolution: number;
  /** True when mid < 0.10 / > 0.90 → STRICT two-sided required (both legs mandatory to earn anything). */
  strictTwoSided: boolean;
  /** Model-predicted pool share at this size vs. the live book. */
  predictedShare: number;
  /** Model-predicted daily reward (USD) = share · pool. */
  predictedDailyRewardUsd: number;
  /** Model-predicted adverse-selection fill cost (USD). */
  predictedFillCostUsd: number;
  /** Model-predicted net (USD) = reward − fill cost + rebate. */
  predictedNetUsd: number;
  /** Capital at risk (USD) ≈ two-sided collateral for sizeShares. */
  capitalUsd: number;
}

export interface ProbePlan {
  targets: ProbeTarget[];
  nMarkets: number;
  totalCapitalUsd: number;
  totalPredictedRewardUsd: number;
  totalPredictedNetUsd: number;
  offsetCents: number;
  params: RewardFarmingParams;
}

export interface ProbePlanOpts {
  /** How many markets to probe. Default 3. */
  nMarkets?: number;
  /** How far inside the mid to rest, in cents. Default 1. */
  offsetCents?: number;
  /** Skip dust pools below this (USD/day) — probe markets that can actually pay. Default 5. */
  minPoolUsd?: number;
  /** Now (unix seconds) — for the time-to-resolution gate. When omitted, the gate is skipped. */
  nowSec?: number;
  /** Require ≥ this many hours to resolution so a full reward epoch accrues. Default 18. */
  minHoursToResolution?: number;
  /** Degenerate-mid guard: skip mid below this / above (1−this). Default 0.03 (keeps cheap longshots, drops ~0/~1). */
  midGuard?: number;
  /** Economics overrides (fill φ, adverse τ, rebate, c). fixedSizeShares is set per-market to min_size. */
  params?: Partial<RewardFarmingParams>;
}

const usableMid = (bid: number | null, ask: number | null): number | null =>
  bid != null && ask != null && bid > 0 && ask < 1 && bid <= ask ? (bid + ask) / 2 : null;

/** Hours from nowSec to the ISO resolution time; NaN when either is missing/unparseable. */
function hoursToResolution(endDateIso: string | null | undefined, nowSec: number | undefined): number {
  if (!endDateIso || nowSec == null || !Number.isFinite(nowSec)) return NaN;
  const endMs = Date.parse(endDateIso);
  if (!Number.isFinite(endMs)) return NaN;
  return (endMs / 1000 - nowSec) / 3600;
}

/**
 * Build the probe plan: for each funded market with a real pool + usable mid, rest EXACTLY min_size shares
 * two-sided at offsetCents inside the mid, predict the economics (fixed-size mode), then take the top-N by
 * predicted daily reward. Pure; empty / all-skipped input → an empty plan.
 */
export function buildProbePlan(inputs: MarketRewardInputs[], opts: ProbePlanOpts = {}): ProbePlan {
  const nMarkets = opts.nMarkets && opts.nMarkets > 0 ? Math.floor(opts.nMarkets) : 3;
  const offsetCents = opts.offsetCents != null && opts.offsetCents >= 0 ? opts.offsetCents : 1;
  const minPoolUsd = opts.minPoolUsd != null && opts.minPoolUsd >= 0 ? opts.minPoolUsd : 5;
  const minHours = opts.minHoursToResolution != null ? opts.minHoursToResolution : 18;
  const midGuard = opts.midGuard != null && opts.midGuard >= 0 ? opts.midGuard : 0.03;
  const list = Array.isArray(inputs) ? inputs : [];

  const targets: ProbeTarget[] = [];
  for (const m of list) {
    const mid = usableMid(m.bestBid, m.bestAsk);
    if (mid == null || !(m.dailyPoolUsd >= minPoolUsd) || !(m.maxSpreadCents > 0)) continue;
    // Degenerate-mid guard: about-to-resolve extremes are a bad reward test (keep cheap longshots though).
    if (mid < midGuard || mid > 1 - midGuard) continue;
    // Time-to-resolution gate: only probe markets with a full reward epoch ahead (skip if unknown nowSec).
    const hrs = hoursToResolution(m.endDateIso, opts.nowSec);
    if (opts.nowSec != null && Number.isFinite(hrs) && hrs < minHours) continue;
    const minSize = m.minSize > 0 ? m.minSize : 50;
    const params: RewardFarmingParams = {
      ...DEFAULT_PARAMS,
      ...opts.params,
      restOffsetCents: offsetCents,
      fixedSizeShares: minSize,
    };
    const e = estimateMarketEconomics(m, params);
    if (e.skipped || !(e.myQmin > 0)) continue;
    const off = Math.min(Math.max(offsetCents, 0), m.maxSpreadCents) / 100;
    targets.push({
      conditionId: m.conditionId,
      slug: m.slug,
      mid,
      dailyPoolUsd: m.dailyPoolUsd,
      maxSpreadCents: m.maxSpreadCents,
      sizeShares: minSize,
      bidPx: Math.max(0.01, mid - off),
      askPx: Math.min(0.99, mid + off),
      hoursToResolution: hrs,
      strictTwoSided: mid < TWO_SIDED_LO || mid > TWO_SIDED_HI,
      predictedShare: e.share,
      predictedDailyRewardUsd: e.grossRewardUsd,
      predictedFillCostUsd: e.fillCostUsd,
      predictedNetUsd: e.netUsd,
      capitalUsd: e.capitalUsd,
    });
  }
  targets.sort((a, b) => b.predictedDailyRewardUsd - a.predictedDailyRewardUsd);
  const chosen = targets.slice(0, nMarkets);
  const sum = (f: (t: ProbeTarget) => number): number => chosen.reduce((a, t) => a + f(t), 0);
  return {
    targets: chosen,
    nMarkets: chosen.length,
    totalCapitalUsd: sum((t) => t.capitalUsd),
    totalPredictedRewardUsd: sum((t) => t.predictedDailyRewardUsd),
    totalPredictedNetUsd: sum((t) => t.predictedNetUsd),
    offsetCents,
    params: { ...DEFAULT_PARAMS, ...opts.params, restOffsetCents: offsetCents },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the ground-truth RECONCILIATION (predicted vs. actual)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What the operator observes after 24h (one per probed market). */
export interface ProbeActual {
  conditionId: string;
  /** ACTUAL LP reward (USDC) paid to the wallet for this market over the probe window. */
  actualRewardUsd: number;
  /** OPTIONAL — actual filled notional (USD); for the fill-cost cross-check. */
  actualFilledNotionalUsd?: number;
  /** OPTIONAL — realized inventory P&L on fills (signed USD). When absent, the model's −fillCost is used. */
  actualFillPnlUsd?: number;
}

export interface ProbeScoreRow {
  conditionId: string;
  slug: string;
  predictedDailyRewardUsd: number;
  actualRewardUsd: number;
  /** actual / predicted reward — THE headline (≈1 confirms; ≪1 over-advertised). NaN when predicted=0. */
  rewardRatio: number;
  predictedNetUsd: number;
  /** actualReward + (actualFillPnl ?? −predictedFillCost). */
  actualNetUsd: number;
}

export type ProbeVerdictLabel = 'GROUND_TRUTH_CONFIRMS' | 'OVER_ADVERTISED' | 'INCONCLUSIVE';

export interface ProbeScore {
  rows: ProbeScoreRow[];
  nMatched: number;
  /** Mean reward ratio over matched markets with a positive prediction. */
  meanRewardRatio: number;
  totalPredictedRewardUsd: number;
  totalActualRewardUsd: number;
  totalActualNetUsd: number;
  label: ProbeVerdictLabel;
  reason: string;
}

/** The ratio band (and net sign) the verdict uses — frozen with the §9 reasoning. */
export const PROBE_CONFIRM_RATIO = 0.5; // actual ≥ 50% of predicted reward = "pays roughly as advertised"

/**
 * Score the actuals against the plan. Match by conditionId. The headline is the mean reward ratio:
 *   ≥ PROBE_CONFIRM_RATIO AND total actual net > 0 → GROUND_TRUTH_CONFIRMS (the PASS was real — the pools
 *       pay roughly as advertised AND survive real fills → scale up / design the two-sided MM bot);
 *   < PROBE_CONFIRM_RATIO                          → OVER_ADVERTISED (the first-pass PASS was a measurement
 *       artifact — advertised rate ≫ realized; rail stays DORMANT, record as a finding);
 *   nothing matched / ambiguous                    → INCONCLUSIVE.
 * Pure; empty actuals → INCONCLUSIVE.
 */
export function scoreProbe(plan: ProbePlan, actuals: ProbeActual[]): ProbeScore {
  const byId = new Map<string, ProbeActual>();
  for (const a of Array.isArray(actuals) ? actuals : []) {
    if (a && typeof a.conditionId === 'string') byId.set(a.conditionId, a);
  }
  const rows: ProbeScoreRow[] = [];
  for (const t of plan.targets) {
    const a = byId.get(t.conditionId);
    if (!a) continue;
    const actualRewardUsd = Number.isFinite(a.actualRewardUsd) ? a.actualRewardUsd : 0;
    const fillPnl = Number.isFinite(a.actualFillPnlUsd) ? a.actualFillPnlUsd! : -t.predictedFillCostUsd;
    rows.push({
      conditionId: t.conditionId,
      slug: t.slug,
      predictedDailyRewardUsd: t.predictedDailyRewardUsd,
      actualRewardUsd,
      rewardRatio: t.predictedDailyRewardUsd > 0 ? actualRewardUsd / t.predictedDailyRewardUsd : NaN,
      predictedNetUsd: t.predictedNetUsd,
      actualNetUsd: actualRewardUsd + fillPnl,
    });
  }
  const ratios = rows.map((r) => r.rewardRatio).filter((v) => Number.isFinite(v));
  const meanRewardRatio = ratios.length ? ratios.reduce((a, v) => a + v, 0) / ratios.length : NaN;
  const totalPredictedRewardUsd = rows.reduce((a, r) => a + r.predictedDailyRewardUsd, 0);
  const totalActualRewardUsd = rows.reduce((a, r) => a + r.actualRewardUsd, 0);
  const totalActualNetUsd = rows.reduce((a, r) => a + r.actualNetUsd, 0);

  const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');
  let label: ProbeVerdictLabel;
  let reason: string;
  if (rows.length === 0 || !Number.isFinite(meanRewardRatio)) {
    label = 'INCONCLUSIVE';
    reason = `INCONCLUSIVE — ${rows.length} markets matched / no comparable reward prediction. Re-probe or check the actuals ledger.`;
  } else if (meanRewardRatio >= PROBE_CONFIRM_RATIO && totalActualNetUsd > 0) {
    label = 'GROUND_TRUTH_CONFIRMS';
    reason = `GROUND_TRUTH_CONFIRMS — actual reward is ${f2(meanRewardRatio * 100)}% of predicted (≥ ${f2(
      PROBE_CONFIRM_RATIO * 100,
    )}%) and net actual $${f2(totalActualNetUsd)} > 0: the pools pay roughly as advertised AND survive real fills. The REC-8 PASS was REAL → scale up / design the two-sided MM bot (operator go).`;
  } else if (meanRewardRatio < PROBE_CONFIRM_RATIO) {
    label = 'OVER_ADVERTISED';
    reason = `OVER_ADVERTISED — actual reward is only ${f2(meanRewardRatio * 100)}% of predicted (< ${f2(
      PROBE_CONFIRM_RATIO * 100,
    )}%): the advertised rate ≫ realized payout. The REC-8 PASS was a measurement artifact. Record as a finding; rail stays DORMANT.`;
  } else {
    label = 'INCONCLUSIVE';
    reason = `INCONCLUSIVE — reward ratio ${f2(meanRewardRatio * 100)}% clears the bar but net actual $${f2(
      totalActualNetUsd,
    )} ≤ 0 (fills ate the reward). Larger / longer probe needed before any capital.`;
  }
  return {
    rows,
    nMatched: rows.length,
    meanRewardRatio,
    totalPredictedRewardUsd,
    totalActualRewardUsd,
    totalActualNetUsd,
    label,
    reason,
  };
}
