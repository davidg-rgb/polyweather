/**
 * core/kelly — joint Kelly sizing & risk caps (ARCHITECTURE.md §6.8).
 */
import { KellyDomainError } from './errors.ts';
import type { RiskConfig, StakePlan } from './types.ts';

/**
 * Joint log-wealth-optimal stakes for mutually exclusive buckets: treat prices
 * as state prices; sort candidates by q/p descending; greedily include while
 * qᵢ/pᵢ > c, where c = (1 − Σ_inc qᵢ)/(1 − Σ_inc pᵢ) is recomputed per
 * inclusion; stakes fᵢ = qᵢ − c·pᵢ for included, 0 otherwise. Fractions are of
 * bankroll; Σfᵢ ≤ 1 by construction.
 *
 * `prices` are EFFECTIVE cost per $1 payout — execAsk + fee + paper slippage,
 * computed by the caller (W4: a fee-blind solver oversizes and can mis-order
 * inclusion near ties). Callers pre-filter to positive effective edge q > p
 * (ADR-08 hedge-exclusion policy); a p′ ≥ 1 bucket fails q/p > 1 ≥ c at the
 * first inclusion test and is excluded WITHOUT throwing (W20).
 *
 * KellyDomainError ONLY on true domain violations: p ≤ 0 or q outside [0,1].
 * Returns all-zero when nothing survives.
 */
export function jointKellyStakes(
  q: number[],
  prices: number[],
): { fractions: number[]; c: number } {
  if (q.length !== prices.length) {
    throw new KellyDomainError(`q and prices length mismatch: ${q.length} vs ${prices.length}`);
  }
  for (let i = 0; i < q.length; i++) {
    if (!(prices[i]! > 0)) {
      throw new KellyDomainError(`price must be > 0, got ${prices[i]} at index ${i}`, { i });
    }
    if (!(q[i]! >= 0 && q[i]! <= 1)) {
      throw new KellyDomainError(`q must be in [0,1], got ${q[i]} at index ${i}`, { i });
    }
  }

  const order = q
    .map((qi, i) => ({ i, ratio: qi / prices[i]! }))
    .sort((a, b) => b.ratio - a.ratio);

  const included: number[] = [];
  let sumQ = 0;
  let sumP = 0;
  let c = 1;
  for (const { i, ratio } of order) {
    if (ratio <= c) break; // sorted order — nothing later can qualify either
    const nextSumP = sumP + prices[i]!;
    if (nextSumP >= 1) break; // state-price budget exhausted; c would degenerate
    included.push(i);
    sumQ += q[i]!;
    sumP = nextSumP;
    c = (1 - sumQ) / (1 - sumP);
  }

  const fractions = q.map((qi, i) => (included.includes(i) ? qi - c * prices[i]! : 0));
  return { fractions, c };
}

/** Multiply by k (default 0.25). Separate so the audit can show full vs fractional side by side. */
export function applyKellyFraction(fractions: number[], k: number): number[] {
  return fractions.map((f) => f * k);
}

/**
 * Clamp in order — per-trade (2%) → per-event incl. existing open (5%) →
 * cluster (8%) → daily (15%); floor to whole shares respecting the market's
 * orderMinSize (5); record every clamp in capAudit[]; drop stakes whose
 * post-cap size < minStakeUsd ($5).
 *
 * Each proposed item carries its execution price and the market's orderMinSize
 * (the §6.8 signature elides them, but whole-share flooring is impossible
 * without a price — deviation logged in BUILD-STATE.md). Buckets are processed
 * in descending-fraction order; shared headrooms (event/cluster/day) deplete
 * as stakes are granted.
 */
export function applyRiskCaps(
  proposed: { bucketIdx: number; frac: number; price: number; orderMinSize: number }[],
  ctx: { bankrollUsd: number; eventOpenUsd: number; clusterOpenUsd: number; dayOpenUsd: number },
  cfg: RiskConfig,
): StakePlan[] {
  const round2 = (x: number) => Math.round(x * 100) / 100;
  let eventHeadroom = cfg.perEventCapPct * ctx.bankrollUsd - ctx.eventOpenUsd;
  let clusterHeadroom = cfg.clusterCapPct * ctx.bankrollUsd - ctx.clusterOpenUsd;
  let dayHeadroom = cfg.dailyCapPct * ctx.bankrollUsd - ctx.dayOpenUsd;

  const plans: StakePlan[] = [];
  for (const item of [...proposed].sort((a, b) => b.frac - a.frac)) {
    const capAudit: string[] = [];
    let stake = item.frac * ctx.bankrollUsd;

    const perTradeCap = cfg.perTradeCapPct * ctx.bankrollUsd;
    if (stake > perTradeCap) {
      capAudit.push(`per-trade cap: ${round2(stake)} -> ${round2(perTradeCap)}`);
      stake = perTradeCap;
    }
    if (stake > eventHeadroom) {
      capAudit.push(`per-event cap: ${round2(stake)} -> ${round2(Math.max(0, eventHeadroom))}`);
      stake = Math.max(0, eventHeadroom);
    }
    if (stake > clusterHeadroom) {
      capAudit.push(`cluster cap: ${round2(stake)} -> ${round2(Math.max(0, clusterHeadroom))}`);
      stake = Math.max(0, clusterHeadroom);
    }
    if (stake > dayHeadroom) {
      capAudit.push(`daily cap: ${round2(stake)} -> ${round2(Math.max(0, dayHeadroom))}`);
      stake = Math.max(0, dayHeadroom);
    }

    const shares = Math.floor(stake / item.price);
    if (shares < item.orderMinSize) {
      capAudit.push(`dropped: ${shares} shares < orderMinSize ${item.orderMinSize}`);
      continue;
    }
    const floored = shares * item.price;
    if (floored < stake) {
      capAudit.push(`share floor: ${round2(stake)} -> ${round2(floored)} (${shares} shares)`);
    }
    if (floored < cfg.minStakeUsd) {
      capAudit.push(`dropped: ${round2(floored)} < minStakeUsd ${cfg.minStakeUsd}`);
      continue;
    }

    eventHeadroom -= floored;
    clusterHeadroom -= floored;
    dayHeadroom -= floored;
    plans.push({ bucketIdx: item.bucketIdx, stakeUsd: floored, shares, capAudit });
  }
  return plans;
}
