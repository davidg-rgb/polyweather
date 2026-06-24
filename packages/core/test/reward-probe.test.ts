/**
 * Tests for core/sim/reward-probe — the REC-9 probe-plan + ground-truth reconciliation (no money, no
 * rail). Covers buildProbePlan (top-N by predicted reward, fixed min_size two-sided, dust/pool gate,
 * strict-two-sided flag, totals) and scoreProbe (reward-ratio headline, GROUND_TRUTH_CONFIRMS /
 * OVER_ADVERTISED / INCONCLUSIVE incl. the fills-ate-the-reward case, fill-pnl fallback, no-match).
 * Pure — no network, no DB.
 */
import { describe, expect, it } from 'vitest';
import type { MarketRewardInputs } from '../src/sim/reward-farming.ts';
import {
  type ProbeActual,
  type ProbePlan,
  buildProbePlan,
  scoreProbe,
} from '../src/sim/reward-probe.ts';

const mkt = (over: Partial<MarketRewardInputs> = {}): MarketRewardInputs => ({
  conditionId: 'c1',
  slug: 'highest-temperature-in-testville',
  dailyPoolUsd: 20,
  maxSpreadCents: 4.5,
  minSize: 50,
  bestBid: 0.1,
  bestAsk: 0.13,
  bids: [{ price: 0.1, size: 200 }],
  asks: [{ price: 0.13, size: 200 }],
  ...over,
});

describe('buildProbePlan', () => {
  it('rests exactly min_size shares two-sided and predicts the economics', () => {
    const plan = buildProbePlan([mkt()], { nMarkets: 3 });
    expect(plan.nMarkets).toBe(1);
    const t = plan.targets[0]!;
    expect(t.sizeShares).toBe(50);
    expect(t.bidPx).toBeLessThan(t.mid);
    expect(t.askPx).toBeGreaterThan(t.mid);
    expect(t.predictedDailyRewardUsd).toBeGreaterThan(0);
    expect(t.capitalUsd).toBeGreaterThan(0);
    // capital ≈ min_size × two-sided collateral, far below a $100 budget
    expect(t.capitalUsd).toBeLessThan(60);
  });

  it('skips dust pools below minPoolUsd', () => {
    const plan = buildProbePlan([mkt({ dailyPoolUsd: 0.001 })], { minPoolUsd: 5 });
    expect(plan.nMarkets).toBe(0);
  });

  it('skips markets with no usable mid', () => {
    const plan = buildProbePlan([mkt({ bestBid: null, bestAsk: null })]);
    expect(plan.nMarkets).toBe(0);
  });

  it('takes the top-N by predicted daily reward', () => {
    const markets = [
      mkt({ conditionId: 'a', dailyPoolUsd: 10 }),
      mkt({ conditionId: 'b', dailyPoolUsd: 200 }),
      mkt({ conditionId: 'c', dailyPoolUsd: 50 }),
    ];
    const plan = buildProbePlan(markets, { nMarkets: 2 });
    expect(plan.nMarkets).toBe(2);
    expect(plan.targets[0]!.conditionId).toBe('b'); // biggest pool first
    expect(plan.targets[0]!.predictedDailyRewardUsd).toBeGreaterThanOrEqual(
      plan.targets[1]!.predictedDailyRewardUsd,
    );
  });

  it('flags the strict two-sided regime when mid < 0.10', () => {
    const plan = buildProbePlan([mkt({ bestBid: 0.04, bestAsk: 0.06 })]);
    expect(plan.targets[0]!.strictTwoSided).toBe(true);
  });

  it('excludes markets resolving sooner than minHoursToResolution', () => {
    const now = 1_750_000_000;
    const soon = new Date((now + 2 * 3600) * 1000).toISOString(); // 2h out
    const later = new Date((now + 30 * 3600) * 1000).toISOString(); // 30h out
    const plan = buildProbePlan(
      [mkt({ conditionId: 'soon', endDateIso: soon }), mkt({ conditionId: 'later', endDateIso: later })],
      { nowSec: now, minHoursToResolution: 18 },
    );
    expect(plan.targets.map((t) => t.conditionId)).toEqual(['later']);
    expect(plan.targets[0]!.hoursToResolution).toBeCloseTo(30, 1);
  });

  it('keeps markets when nowSec is omitted (gate skipped)', () => {
    const plan = buildProbePlan([mkt({ endDateIso: '2020-01-01T00:00:00Z' })]);
    expect(plan.nMarkets).toBe(1);
  });

  it('excludes degenerate mids (~0 / ~1) via midGuard', () => {
    const lo = buildProbePlan([mkt({ bestBid: 0.005, bestAsk: 0.015 })], { midGuard: 0.03 }); // mid 0.01
    const hi = buildProbePlan([mkt({ bestBid: 0.985, bestAsk: 0.995 })], { midGuard: 0.03 }); // mid 0.99
    expect(lo.nMarkets).toBe(0);
    expect(hi.nMarkets).toBe(0);
  });

  it('totals sum the chosen targets; empty input → empty plan', () => {
    const plan = buildProbePlan([mkt({ conditionId: 'a' }), mkt({ conditionId: 'b' })], { nMarkets: 2 });
    expect(plan.totalCapitalUsd).toBeCloseTo(plan.targets.reduce((a, t) => a + t.capitalUsd, 0), 9);
    expect(plan.totalPredictedRewardUsd).toBeCloseTo(
      plan.targets.reduce((a, t) => a + t.predictedDailyRewardUsd, 0),
      9,
    );
    expect(buildProbePlan([]).nMarkets).toBe(0);
  });
});

describe('scoreProbe', () => {
  const plan: ProbePlan = buildProbePlan(
    [mkt({ conditionId: 'a', dailyPoolUsd: 100 }), mkt({ conditionId: 'b', dailyPoolUsd: 80 })],
    { nMarkets: 2 },
  );

  it('GROUND_TRUTH_CONFIRMS when actual ≈ predicted and net > 0', () => {
    const actuals: ProbeActual[] = plan.targets.map((t) => ({
      conditionId: t.conditionId,
      actualRewardUsd: t.predictedDailyRewardUsd, // pays exactly as predicted
      actualFillPnlUsd: 0, // no adverse fills
    }));
    const s = scoreProbe(plan, actuals);
    expect(s.nMatched).toBe(2);
    expect(s.meanRewardRatio).toBeCloseTo(1, 6);
    expect(s.label).toBe('GROUND_TRUTH_CONFIRMS');
  });

  it('OVER_ADVERTISED when actual is a small fraction of predicted', () => {
    const actuals: ProbeActual[] = plan.targets.map((t) => ({
      conditionId: t.conditionId,
      actualRewardUsd: t.predictedDailyRewardUsd * 0.1, // pays 10% of advertised
    }));
    const s = scoreProbe(plan, actuals);
    expect(s.meanRewardRatio).toBeCloseTo(0.1, 6);
    expect(s.label).toBe('OVER_ADVERTISED');
  });

  it('INCONCLUSIVE when reward clears the bar but fills eat it (net ≤ 0)', () => {
    const actuals: ProbeActual[] = plan.targets.map((t) => ({
      conditionId: t.conditionId,
      actualRewardUsd: t.predictedDailyRewardUsd,
      actualFillPnlUsd: -t.predictedDailyRewardUsd * 2, // big adverse fill loss
    }));
    const s = scoreProbe(plan, actuals);
    expect(s.totalActualNetUsd).toBeLessThanOrEqual(0);
    expect(s.label).toBe('INCONCLUSIVE');
  });

  it('falls back to the model fill cost when actualFillPnl is absent', () => {
    const t = plan.targets[0]!;
    const s = scoreProbe(plan, [{ conditionId: t.conditionId, actualRewardUsd: t.predictedDailyRewardUsd }]);
    expect(s.rows[0]!.actualNetUsd).toBeCloseTo(t.predictedDailyRewardUsd - t.predictedFillCostUsd, 9);
  });

  it('INCONCLUSIVE when nothing matches', () => {
    const s = scoreProbe(plan, [{ conditionId: 'zzz', actualRewardUsd: 5 }]);
    expect(s.nMatched).toBe(0);
    expect(s.label).toBe('INCONCLUSIVE');
  });
});
