/**
 * Tests for core/sim/reward-farming — the PURE economics of REC-8 forecast-free liquidity-reward
 * farming (REWARD-FARMING-HANDOFF.md). Covers the docs-verbatim scoring formula (spreadScore quadratic,
 * sideScore size-weighting + max_spread gate, makerQmin two-sidedness rule incl. the strict <0.10
 * regime + the /c single-sided penalty), rewardShare normalization (alone / crowded / κ-sweep),
 * estimateMarketEconomics (skip on no-book, min_size gate, gross−fill+rebate net, capital), the universe
 * aggregate (totals, bootstrap CI, median, frac-positive), and the FROZEN PASS/PROMISING/FAIL verdict.
 * All pure — no network, no DB. Deterministic (seed 42), []/NaN-safe.
 */
import { describe, expect, it } from 'vitest';
import {
  type BookOrder,
  type MarketEconomics,
  type MarketRewardInputs,
  type RewardFarmingParams,
  DEFAULT_PARAMS,
  SCORING_C,
  estimateMarketEconomics,
  makerQmin,
  rewardFarmingVerdict,
  rewardShare,
  sideScore,
  spreadScore,
  summarizeUniverse,
} from '../src/sim/reward-farming.ts';

describe('spreadScore — S(v,s) = ((v−s)/v)²', () => {
  it('is 1 at the mid (s=0) and 0 at the edge (s=v)', () => {
    expect(spreadScore(4.5, 0)).toBe(1);
    expect(spreadScore(4.5, 4.5)).toBe(0);
  });
  it('is the quadratic in between', () => {
    // v=4, s=2 → ((4-2)/4)² = 0.25
    expect(spreadScore(4, 2)).toBeCloseTo(0.25, 12);
    // v=4.5, s=1 → ((3.5)/4.5)² = 0.6049…
    expect(spreadScore(4.5, 1)).toBeCloseTo((3.5 / 4.5) ** 2, 12);
  });
  it('is 0 beyond max_spread and on junk', () => {
    expect(spreadScore(4.5, 5)).toBe(0);
    expect(spreadScore(0, 1)).toBe(0);
    expect(spreadScore(-1, 1)).toBe(0);
    expect(spreadScore(4.5, NaN)).toBe(0);
    expect(spreadScore(4.5, -1)).toBe(0);
  });
});

describe('sideScore — size-weighted, max_spread-gated', () => {
  const mid = 0.5;
  it('weights each in-band order by size × spreadScore', () => {
    // one order 100 shares at mid (spread 0 → score 1) → 100; one 50 shares 2c away on v=4 → 50·0.25=12.5
    const orders: BookOrder[] = [
      { price: 0.5, size: 100 },
      { price: 0.48, size: 50 },
    ];
    expect(sideScore(orders, mid, 4)).toBeCloseTo(100 * 1 + 50 * 0.25, 9);
  });
  it('excludes orders beyond max_spread', () => {
    const orders: BookOrder[] = [{ price: 0.5 - 0.06, size: 999 }]; // 6c away, v=4.5 → out
    expect(sideScore(orders, mid, 4.5)).toBe(0);
  });
  it('is 0 on empty / junk / bad mid', () => {
    expect(sideScore([], mid, 4.5)).toBe(0);
    expect(sideScore([{ price: 0, size: 10 }], mid, 4.5)).toBe(0);
    expect(sideScore([{ price: 0.5, size: -1 }], mid, 4.5)).toBe(0);
    expect(sideScore([{ price: 0.5, size: 10 }], 0, 4.5)).toBe(0);
  });
});

describe('makerQmin — the two-sidedness rule', () => {
  it('in [0.10,0.90]: balanced two-sided returns the (equal) side score', () => {
    expect(makerQmin(10, 10, 0.5)).toBe(10);
  });
  it('in [0.10,0.90]: one-sided earns Q/c (the single-sided penalty), not 0', () => {
    // Qone=30, Qtwo=0 → max(min(30,0), max(30/3, 0)) = max(0, 10) = 10
    expect(makerQmin(30, 0, 0.5)).toBeCloseTo(30 / SCORING_C, 9);
  });
  it('in [0.10,0.90]: balanced beats the /c floor when min > max/c', () => {
    // Qone=Qtwo=30 → max(30, 10) = 30
    expect(makerQmin(30, 30, 0.5)).toBe(30);
  });
  it('below 0.10 (cheap longshot): STRICT two-sided — one-sided earns ZERO', () => {
    expect(makerQmin(30, 0, 0.05)).toBe(0);
    expect(makerQmin(30, 10, 0.05)).toBe(10); // = min
  });
  it('above 0.90: also strict two-sided', () => {
    expect(makerQmin(5, 40, 0.95)).toBe(5);
  });
  it('floors negative / NaN inputs to 0', () => {
    expect(makerQmin(-5, 10, 0.5)).toBeCloseTo(10 / SCORING_C, 9);
    expect(makerQmin(NaN, NaN, 0.5)).toBe(0);
  });
});

describe('rewardShare — myQ / (myQ + κ·compQ)', () => {
  it('is 1 when alone (no competition) and I score', () => {
    expect(rewardShare(10, 0)).toBe(1);
  });
  it('is 0 when I score nothing', () => {
    expect(rewardShare(0, 50)).toBe(0);
  });
  it('splits proportionally vs competition', () => {
    expect(rewardShare(10, 30)).toBeCloseTo(0.25, 12); // 10/(10+30)
  });
  it('κ scales competition (κ→0 = alone ceiling, κ>1 = more competition)', () => {
    expect(rewardShare(10, 30, 0)).toBe(1);
    expect(rewardShare(10, 10, 2)).toBeCloseTo(10 / 30, 12);
  });
});

describe('estimateMarketEconomics', () => {
  const market = (over: Partial<MarketRewardInputs> = {}): MarketRewardInputs => ({
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

  it('skips a market with no usable mid', () => {
    const e = estimateMarketEconomics(market({ bestBid: null, bestAsk: null }));
    expect(e.skipped).toBe(true);
    expect(e.netUsd).toBe(0);
    expect(Number.isNaN(e.netYield)).toBe(true);
  });

  it('produces a finite net + yield on a normal market', () => {
    const e = estimateMarketEconomics(market());
    expect(e.skipped).toBe(false);
    expect(e.mid).toBeCloseTo(0.115, 9);
    expect(e.mySizeShares).toBeGreaterThan(0);
    expect(e.share).toBeGreaterThan(0);
    expect(e.share).toBeLessThanOrEqual(1);
    expect(Number.isFinite(e.netUsd)).toBe(true);
    expect(Number.isFinite(e.netYield)).toBe(true);
    // net = gross − fillCost + rebate, by construction
    expect(e.netUsd).toBeCloseTo(e.grossRewardUsd - e.fillCostUsd + e.rebateCreditUsd, 9);
    // capital ≈ the budget
    expect(e.capitalUsd).toBeCloseTo(DEFAULT_PARAMS.capitalPerMarketUsd, 6);
  });

  it('flags the strict two-sided regime when mid < 0.10', () => {
    const e = estimateMarketEconomics(market({ bestBid: 0.04, bestAsk: 0.06 }));
    expect(e.strictTwoSided).toBe(true);
  });

  it('a larger competing book → a smaller share → less gross reward', () => {
    const thin = estimateMarketEconomics(market({ bids: [{ price: 0.1, size: 50 }], asks: [{ price: 0.13, size: 50 }] }));
    const thick = estimateMarketEconomics(
      market({ bids: [{ price: 0.1, size: 5000 }], asks: [{ price: 0.13, size: 5000 }] }),
    );
    expect(thin.share).toBeGreaterThan(thick.share);
    expect(thin.grossRewardUsd).toBeGreaterThan(thick.grossRewardUsd);
  });

  it('a higher adverse-selection tax → lower (eventually negative) net', () => {
    const lowTax: RewardFarmingParams = { ...DEFAULT_PARAMS, adverseTaxPerDollar: 0.0 };
    const highTax: RewardFarmingParams = { ...DEFAULT_PARAMS, adverseTaxPerDollar: 0.5 };
    const lo = estimateMarketEconomics(market(), lowTax);
    const hi = estimateMarketEconomics(market(), highTax);
    expect(hi.netUsd).toBeLessThan(lo.netUsd);
  });

  it('fixedSizeShares (probe mode): rests exactly N shares and derives capital from size', () => {
    const e = estimateMarketEconomics(market(), { ...DEFAULT_PARAMS, fixedSizeShares: 50 });
    expect(e.skipped).toBe(false);
    expect(e.mySizeShares).toBe(50);
    // capital = 50 × two-sided collateral (mid≈0.115) ≪ the $100 budget it ignores
    expect(e.capitalUsd).toBeGreaterThan(0);
    expect(e.capitalUsd).toBeLessThan(60);
    expect(e.share).toBeGreaterThan(0);
  });

  it('honours min_size: a capital too small to meet min_size scores nothing', () => {
    // capital $1 at mid≈0.115 → ~ a few shares ≪ min_size 50 → skipped-but-modelled, zero reward
    const e = estimateMarketEconomics(market(), { ...DEFAULT_PARAMS, capitalPerMarketUsd: 1 });
    expect(e.grossRewardUsd).toBe(0);
    expect(e.myQmin).toBe(0);
  });
});

describe('summarizeUniverse + the frozen verdict', () => {
  const econ = (netUsd: number, over: Partial<MarketEconomics> = {}): MarketEconomics => ({
    conditionId: 'c',
    slug: 's',
    mid: 0.1,
    dailyPoolUsd: 20,
    mySizeShares: 100,
    myQmin: 1,
    compQmin: 1,
    share: 0.5,
    grossRewardUsd: 10,
    capitalUsd: 100,
    filledNotionalUsd: 50,
    fillCostUsd: 10 - netUsd,
    rebateCreditUsd: 0,
    netUsd,
    netYield: netUsd / 100,
    strictTwoSided: true,
    skipped: false,
    ...over,
  });

  it('excludes skipped markets from the aggregate', () => {
    const s = summarizeUniverse([econ(1), econ(2), { ...econ(99), skipped: true }]);
    expect(s.nMarkets).toBe(2);
  });

  it('totals + median + frac-positive are correct', () => {
    const s = summarizeUniverse([econ(-1), econ(1), econ(3)]);
    expect(s.totalNetUsd).toBeCloseTo(3, 9);
    expect(s.medianNetUsd).toBe(1);
    expect(s.fracNetPositive).toBeCloseTo(2 / 3, 9);
    expect(s.totalCapitalUsd).toBeCloseTo(300, 9);
  });

  it('PASS when mean>0, CI lower bound>0, median>0', () => {
    const rows = Array.from({ length: 40 }, () => econ(5)); // tight positive → CI lo > 0
    const v = rewardFarmingVerdict(summarizeUniverse(rows));
    expect(v.label).toBe('PASS');
  });

  it('FAIL when mean ≤ 0', () => {
    const rows = Array.from({ length: 40 }, () => econ(-2));
    const v = rewardFarmingVerdict(summarizeUniverse(rows));
    expect(v.label).toBe('FAIL');
  });

  it('PROMISING when mean>0 but the CI straddles 0', () => {
    // a few big winners + many small losers → positive mean, CI lower bound < 0
    const rows = [econ(200), econ(180), ...Array.from({ length: 30 }, () => econ(-3))];
    const v = rewardFarmingVerdict(summarizeUniverse(rows));
    expect(v.label).toBe('PROMISING');
  });

  it('handles an all-skipped / empty universe without throwing', () => {
    const s = summarizeUniverse([]);
    expect(s.nMarkets).toBe(0);
    expect(Number.isNaN(s.meanNetUsd.mean)).toBe(true);
    expect(rewardFarmingVerdict(s).label).toBe('FAIL');
  });
});
