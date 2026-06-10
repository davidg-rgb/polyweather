import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/calibration/scores.ts';
import { KellyDomainError } from '../src/errors.ts';
import { takerFeePerShare } from '../src/fees.ts';
import { applyKellyFraction, applyRiskCaps, jointKellyStakes } from '../src/kelly.ts';
import { clusterOf, evaluateBreakers, exposureSummary } from '../src/risk.ts';
import type { RiskConfig } from '../src/types.ts';

const riskCfg: RiskConfig = {
  perTradeCapPct: 0.02,
  perEventCapPct: 0.05,
  clusterCapPct: 0.08,
  dailyCapPct: 0.15,
  minStakeUsd: 5,
  breakerConsecLosses: 8,
  breakerDailyLossPct: 0.05,
  breakerDrawdownPct: 0.25,
  breakerBrier: 0.3,
  staleForecastHaltH: 30,
  stalePriceHaltMin: 30,
};

describe('jointKellyStakes (§6.8, ADR-08)', () => {
  it('single bucket reduces to (q−p)/(1−p)', () => {
    const { fractions, c } = jointKellyStakes([0.4], [0.3]);
    expect(fractions[0]).toBeCloseTo((0.4 - 0.3) / (1 - 0.3), 12);
    expect(c).toBeCloseTo((1 - 0.4) / (1 - 0.3), 12);
  });

  it('all-zero when nothing survives the pre-filter (q ≤ p everywhere)', () => {
    const { fractions } = jointKellyStakes([0.3, 0.2], [0.35, 0.25]);
    expect(fractions).toEqual([0, 0]);
  });

  it('W20: a p ≥ 1 bucket is excluded WITHOUT throwing; the rest still size', () => {
    const { fractions } = jointKellyStakes([0.6, 0.5], [1.02, 0.4]);
    expect(fractions[0]).toBe(0);
    expect(fractions[1]).toBeGreaterThan(0);
  });

  it('KellyDomainError on true domain violations only', () => {
    expect(() => jointKellyStakes([0.4], [0])).toThrow(KellyDomainError);
    expect(() => jointKellyStakes([0.4], [-0.1])).toThrow(KellyDomainError);
    expect(() => jointKellyStakes([1.1], [0.4])).toThrow(KellyDomainError);
    expect(() => jointKellyStakes([-0.01], [0.4])).toThrow(KellyDomainError);
    expect(() => jointKellyStakes([0.4, 0.3], [0.2])).toThrow(KellyDomainError);
  });

  it('property invariants over 300 seeded random candidate sets', () => {
    const rand = mulberry32(20260610);
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + Math.floor(rand() * 6);
      const rawQ = Array.from({ length: n }, () => rand() + 0.01);
      const qTotal = rawQ.reduce((a, b) => a + b, 0);
      const q = rawQ.map((x) => (0.9 * x) / qTotal); // Σq ≤ 0.9
      const prices = q.map((qi) => Math.min(0.99, Math.max(0.01, qi * (0.4 + rand() * 1.4))));

      const { fractions, c } = jointKellyStakes(q, prices);
      const sumF = fractions.reduce((a, b) => a + b, 0);
      expect(sumF).toBeLessThanOrEqual(1 + 1e-9); // Σf ≤ 1
      for (let i = 0; i < n; i++) {
        expect(fractions[i]!).toBeGreaterThanOrEqual(0);
        if (fractions[i]! > 1e-12) {
          expect(q[i]! / prices[i]!).toBeGreaterThan(c); // inclusion ⇔ q/p > c
          expect(fractions[i]!).toBeCloseTo(q[i]! - c * prices[i]!, 9);
        } else {
          expect(q[i]! / prices[i]!).toBeLessThanOrEqual(c + 1e-9); // excluded ⇒ gradient ≤ 0
        }
      }
    }
  });

  it('W4 integration: fee-adjusted effective prices shrink stakes vs raw prices', () => {
    const q = [0.45, 0.35];
    const raw = [0.3, 0.25];
    const slippage = 0.01;
    const effective = raw.map((p) => p + takerFeePerShare(p, 0.05) + slippage);
    const { fractions: rawF } = jointKellyStakes(q, raw);
    const { fractions: effF } = jointKellyStakes(q, effective);
    const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    expect(total(effF)).toBeLessThan(total(rawF));
    expect(total(effF)).toBeGreaterThan(0);
  });
});

describe('applyKellyFraction (§6.8)', () => {
  it('scales fractions by k so the audit can show full vs fractional side by side', () => {
    expect(applyKellyFraction([0.4, 0.2, 0], 0.25)).toEqual([0.1, 0.05, 0]);
  });
});

describe('applyRiskCaps (§6.8)', () => {
  const ctx = { bankrollUsd: 1000, eventOpenUsd: 0, clusterOpenUsd: 0, dayOpenUsd: 0 };
  const item = (frac: number, price = 0.5, orderMinSize = 5, bucketIdx = 0) => ({
    bucketIdx,
    frac,
    price,
    orderMinSize,
  });

  it('per-trade cap (2%) clamps first and records the clamp', () => {
    const [plan] = applyRiskCaps([item(0.05)], ctx, riskCfg);
    expect(plan!.stakeUsd).toBe(20);
    expect(plan!.shares).toBe(40);
    expect(plan!.capAudit.some((s) => s.startsWith('per-trade cap: 50 -> 20'))).toBe(true);
  });

  it('cap order per-trade → event → cluster → daily, audit records every clamp', () => {
    const tight = { bankrollUsd: 1000, eventOpenUsd: 40, clusterOpenUsd: 75, dayOpenUsd: 144 };
    // raw 50 → per-trade 20 → event headroom 10 → cluster headroom 5 → daily headroom 6 (no clamp)
    const [plan] = applyRiskCaps([item(0.05, 0.5)], tight, riskCfg);
    expect(plan!.stakeUsd).toBe(5); // floor(5/0.5)=10 shares → $5, exactly minStake — kept
    const audit = plan!.capAudit.join(' | ');
    expect(audit).toContain('per-trade cap');
    expect(audit).toContain('per-event cap');
    expect(audit).toContain('cluster cap');
    expect(audit.indexOf('per-trade')).toBeLessThan(audit.indexOf('per-event'));
    expect(audit.indexOf('per-event')).toBeLessThan(audit.indexOf('cluster'));
  });

  it('shared event headroom depletes across buckets (largest fraction first)', () => {
    const tight = { ...ctx, eventOpenUsd: 25 }; // event headroom 25
    const plans = applyRiskCaps([item(0.02, 0.5, 5, 0), item(0.02, 0.5, 5, 1)], tight, riskCfg);
    expect(plans.length).toBe(2);
    expect(plans[0]!.stakeUsd).toBe(20);
    expect(plans[1]!.stakeUsd).toBe(5);
    expect(plans[1]!.capAudit.some((s) => s.includes('per-event cap'))).toBe(true);
  });

  it('share flooring respects orderMinSize — too few shares drops the stake', () => {
    // $20 per-trade cap at price 0.9 → 22 shares fine; but orderMinSize 25 kills it
    const plans = applyRiskCaps([item(0.02, 0.9, 25)], ctx, riskCfg);
    expect(plans).toEqual([]);
  });

  it('share flooring is recorded and reduces stake to whole shares', () => {
    const [plan] = applyRiskCaps([item(0.02, 0.33)], ctx, riskCfg);
    expect(plan!.shares).toBe(60); // floor(20 / 0.33)
    expect(plan!.stakeUsd).toBeCloseTo(19.8, 9);
    expect(plan!.capAudit.some((s) => s.includes('share floor'))).toBe(true);
  });

  it('sub-$5 stakes are dropped after caps', () => {
    const tight = { ...ctx, eventOpenUsd: 46 }; // headroom 4 < minStake
    const plans = applyRiskCaps([item(0.02, 0.4)], tight, riskCfg);
    expect(plans).toEqual([]);
  });
});

describe('evaluateBreakers (§6.8, F-027) — each rule at exactly its threshold', () => {
  const quiet = {
    consecutiveLossesByCityLead: new Map<string, number>(),
    dailyPnlPct: 0,
    drawdownPct: 0,
    rollingBrierByCity: new Map<string, number>(),
    freshestForecastAgeH: 1,
    freshestPriceAgeMin: 1,
  };

  it('quiet stats fire nothing', () => {
    expect(evaluateBreakers(quiet, riskCfg)).toEqual([]);
  });

  it('8 consecutive losses fires the city_lead halt; 7 does not', () => {
    const at7 = { ...quiet, consecutiveLossesByCityLead: new Map([['nyc:1', 7]]) };
    expect(evaluateBreakers(at7, riskCfg)).toEqual([]);
    const at8 = { ...quiet, consecutiveLossesByCityLead: new Map([['nyc:1', 8]]) };
    const halts = evaluateBreakers(at8, riskCfg);
    expect(halts.length).toBe(1);
    expect(halts[0]!.scope).toBe('city_lead:nyc:1');
  });

  it('−5% day fires global; −4.9% does not', () => {
    expect(evaluateBreakers({ ...quiet, dailyPnlPct: -0.049 }, riskCfg)).toEqual([]);
    const halts = evaluateBreakers({ ...quiet, dailyPnlPct: -0.05 }, riskCfg);
    expect(halts[0]!.scope).toBe('global');
  });

  it('25% drawdown fires; 24.9% does not', () => {
    expect(evaluateBreakers({ ...quiet, drawdownPct: 0.249 }, riskCfg)).toEqual([]);
    expect(evaluateBreakers({ ...quiet, drawdownPct: 0.25 }, riskCfg)[0]!.scope).toBe('global');
  });

  it('rolling Brier 0.30 fires the city halt', () => {
    expect(evaluateBreakers({ ...quiet, rollingBrierByCity: new Map([['nyc', 0.299]]) }, riskCfg)).toEqual([]);
    const halts = evaluateBreakers({ ...quiet, rollingBrierByCity: new Map([['nyc', 0.3]]) }, riskCfg);
    expect(halts[0]!.scope).toBe('city:nyc');
  });

  it('staleness rules fire at 30h forecasts / 30min prices', () => {
    expect(evaluateBreakers({ ...quiet, freshestForecastAgeH: 29.9 }, riskCfg)).toEqual([]);
    expect(evaluateBreakers({ ...quiet, freshestForecastAgeH: 30 }, riskCfg)[0]!.reason).toContain('dead-man');
    expect(evaluateBreakers({ ...quiet, freshestPriceAgeMin: 29 }, riskCfg)).toEqual([]);
    expect(evaluateBreakers({ ...quiet, freshestPriceAgeMin: 30 }, riskCfg).length).toBe(1);
  });

  it('multiple simultaneous breaches all fire', () => {
    const stats = {
      ...quiet,
      dailyPnlPct: -0.06,
      drawdownPct: 0.3,
      rollingBrierByCity: new Map([['lon', 0.31]]),
    };
    expect(evaluateBreakers(stats, riskCfg).length).toBe(3);
  });
});

describe('exposureSummary / clusterOf (§6.8)', () => {
  it('aggregates match the seeded fixture', () => {
    const bets = [
      { eventId: 'e1', citySlug: 'nyc', cluster: 'na-east', stakeUsd: 20, targetDate: '2026-06-11' },
      { eventId: 'e1', citySlug: 'nyc', cluster: 'na-east', stakeUsd: 10, targetDate: '2026-06-11' },
      { eventId: 'e2', citySlug: 'boston', cluster: 'na-east', stakeUsd: 15, targetDate: '2026-06-11' },
      { eventId: 'e3', citySlug: 'seoul', cluster: 'east-asia', stakeUsd: 8, targetDate: '2026-06-12' },
    ];
    const { byEvent, byCluster, byDay, bankrollUsd } = exposureSummary(bets, 1000);
    expect(byEvent.get('e1')).toBe(30);
    expect(byEvent.get('e2')).toBe(15);
    expect(byCluster.get('na-east')).toBe(45);
    expect(byCluster.get('east-asia')).toBe(8);
    expect(byDay.get('2026-06-11')).toBe(45);
    expect(byDay.get('2026-06-12')).toBe(8);
    expect(bankrollUsd).toBe(1000);
  });

  it('clusterOf returns the seeded region', () => {
    expect(clusterOf({ region: 'europe-west' })).toBe('europe-west');
  });
});
