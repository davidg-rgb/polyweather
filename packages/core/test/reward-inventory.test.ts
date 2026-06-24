/**
 * Tests for core/sim/reward-inventory — REC-10: the MEASURED two-sided maker fill+inventory cost of
 * forecast-free liquidity-reward farming. Covers the fill model (both legs, round-trip, adverse
 * inventory to resolution, the inventory cap, the rebate), the per-regime cluster-mean aggregation,
 * the capital-share reward income, the net synthesis, the frozen verdict, and the pure/total
 * guarantees (junk → skipped/zeroed, never throws).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INVENTORY_PARAMS,
  type BucketInventoryResult,
  type FundedMarket,
  type InventoryParams,
  type QuoteSnapshot,
  type RegimeFillCost,
  type RegimeRewardYield,
  type ResolvedBucketSeries,
  regimeFillCost,
  regimeNet,
  regimeOf,
  regimeRewardYield,
  rewardInventoryVerdict,
  rewardYieldPerDay,
  runInventoryStudy,
  simulateBucketInventory,
} from '../src/sim/reward-inventory.ts';

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────
const snap = (t: number, bid: number | null, ask: number | null): QuoteSnapshot => ({
  capturedAt: t,
  bid,
  ask,
});
const series = (
  snapshots: QuoteSnapshot[],
  won: boolean,
  over: Partial<ResolvedBucketSeries> = {},
): ResolvedBucketSeries => ({
  key: 'cond|0',
  station: 'EHAM',
  weatherDay: '2026-06-01',
  won,
  snapshots,
  ...over,
});
/** rebate-off, no inventory cap, minEpochs 1 — for exact-arithmetic fill tests. */
const P = (over: Partial<InventoryParams> = {}): InventoryParams => ({
  ...DEFAULT_INVENTORY_PARAMS,
  rebateRate: 0,
  invCapMult: 1000,
  minEpochs: 1,
  ...over,
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// regimeOf
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('regimeOf', () => {
  it('classifies by the docs-verbatim 0.10 / 0.90 thresholds', () => {
    expect(regimeOf(0.05)).toBe('cheap');
    expect(regimeOf(0.5)).toBe('mid');
    expect(regimeOf(0.95)).toBe('rich');
  });
  it('boundaries are mid (strict < / >)', () => {
    expect(regimeOf(0.1)).toBe('mid');
    expect(regimeOf(0.9)).toBe('mid');
  });
  it('null / NaN → mid (the conservative default)', () => {
    expect(regimeOf(null)).toBe('mid');
    expect(regimeOf(undefined)).toBe('mid');
    expect(regimeOf(NaN)).toBe('mid');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// simulateBucketInventory — the measurement
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('simulateBucketInventory — adverse fills on a LOSER (bid leg)', () => {
  it('accumulates a long position into a falling loser and loses it to resolution', () => {
    // mid 0.50 → 0.40 → 0.30; bid fills each epoch (ask dips below bidPx), resolves LOSE (o=0).
    const r = simulateBucketInventory(
      series([snap(0, 0.49, 0.51), snap(60, 0.39, 0.41), snap(120, 0.29, 0.31)], false),
      P(),
    );
    expect(r.skipped).toBe(false);
    expect(r.nBidFills).toBe(2); // bought @0.49 and @0.39
    expect(r.nAskFills).toBe(0); // a falling book never lifts our ask
    expect(r.finalInventoryShares).toBe(200);
    // cash = −100·0.49 − 100·0.39 = −88; residual inventory × o(=0) = 0.
    expect(r.fillPnlUsd).toBeCloseTo(-88, 9);
    expect(r.capitalUsd).toBe(100); // fixed nominal capital = sizeShares
    expect(r.fillYield).toBeCloseTo(-88 / 100, 9);
    // flatten variant marks the 200 residual shares to the last mid (0.30): −88 + 200·0.30 = −28.
    expect(r.fillPnlFlattenUsd).toBeCloseTo(-28, 9);
    expect(r.fillYieldFlatten).toBeCloseTo(-28 / 100, 9);
    expect(r.regime).toBe('mid');
  });
});

describe('simulateBucketInventory — adverse fills on a WINNER (ask leg)', () => {
  it('accumulates a short position into a rising winner and loses it to resolution', () => {
    // mid 0.50 → 0.62 → 0.72; ask fills each epoch (bid lifts above askPx), resolves WIN (o=1).
    const r = simulateBucketInventory(
      series([snap(0, 0.49, 0.51), snap(60, 0.61, 0.63), snap(120, 0.71, 0.73)], true),
      P(),
    );
    expect(r.nAskFills).toBe(2); // sold @0.51 and @0.63
    expect(r.nBidFills).toBe(0);
    expect(r.finalInventoryShares).toBe(-200);
    // cash = +100·0.51 + 100·0.63 = 114; residual (−200) × o(=1) = −200 → −86.
    expect(r.fillPnlUsd).toBeCloseTo(-86, 9);
    expect(r.fillYield).toBeLessThan(0);
    // flatten marks the −200 residual to the last mid (0.72): 114 − 200·0.72 = −30.
    expect(r.fillPnlFlattenUsd).toBeCloseTo(-30, 9);
  });
});

describe('simulateBucketInventory — spread capture (round-trip, both legs)', () => {
  it('buys low then sells higher around a stable mid → positive, flat inventory', () => {
    // epoch0: ask dips to 0.50 → buy @0.49? bidPx at mid .50 = .49. ask 0.49 ≤ .49 → buy@0.49.
    // epoch1 (mid back to .50): bid lifts to .52 ≥ askPx .51 → sell @0.51. Net flat, +spread.
    const r = simulateBucketInventory(
      series([snap(0, 0.49, 0.51), snap(60, 0.48, 0.49), snap(120, 0.52, 0.54)], false),
      P(),
    );
    expect(r.nBidFills).toBe(1);
    expect(r.nAskFills).toBe(1);
    expect(r.finalInventoryShares).toBe(0);
    expect(r.fillPnlUsd).toBeGreaterThan(0); // sold above the buy → captured spread, no resolution risk
  });
});

describe('simulateBucketInventory — inventory cap', () => {
  it('stops quoting the side that would breach invCapMult × size', () => {
    // same faller as the loser test, but invCapMult 1 (cap = 100 shares): after the first buy
    // inventory hits the cap, so the second epoch must not buy again.
    const r = simulateBucketInventory(
      series([snap(0, 0.49, 0.51), snap(60, 0.39, 0.41), snap(120, 0.29, 0.31)], false),
      P({ invCapMult: 1 }),
    );
    expect(r.nBidFills).toBe(1);
    expect(r.finalInventoryShares).toBe(100);
    expect(r.fillPnlUsd).toBeCloseTo(-49, 9); // bought once @0.49, resolves to 0
    expect(r.fillYield).toBeCloseTo(-0.49, 9); // on fixed $100 capital
  });
});

describe('simulateBucketInventory — rebate', () => {
  it('a positive rebateRate credits the maker on fills (less negative than rebate-0)', () => {
    const base = series([snap(0, 0.49, 0.51), snap(60, 0.39, 0.41), snap(120, 0.29, 0.31)], false);
    const noReb = simulateBucketInventory(base, P({ rebateRate: 0 }));
    const withReb = simulateBucketInventory(base, P({ rebateRate: 0.25 }));
    expect(withReb.fillPnlUsd).toBeGreaterThan(noReb.fillPnlUsd);
  });
});

describe('simulateBucketInventory — pure/total guards', () => {
  it('skips a series with too few usable epochs (default minEpochs)', () => {
    const r = simulateBucketInventory(series([snap(0, 0.49, 0.51), snap(60, 0.48, 0.5)], false));
    expect(r.skipped).toBe(true);
    expect(Number.isNaN(r.fillYield)).toBe(true);
    expect(r.capitalUsd).toBeNaN();
  });
  it('skips when no snapshot has a usable two-sided mid', () => {
    const r = simulateBucketInventory(
      series([snap(0, null, 0.5), snap(60, 0.4, null), snap(120, 1.2, 0.3)], false),
      P(),
    );
    expect(r.skipped).toBe(true);
  });
  it('never throws on junk input', () => {
    expect(() =>
      simulateBucketInventory({ snapshots: null } as unknown as ResolvedBucketSeries, P()),
    ).not.toThrow();
    const r = simulateBucketInventory({ snapshots: null } as unknown as ResolvedBucketSeries, P());
    expect(r.skipped).toBe(true);
  });
  it('honours a degenerate sizeShares by falling back to the default', () => {
    const r = simulateBucketInventory(
      series([snap(0, 0.49, 0.51), snap(60, 0.39, 0.41), snap(120, 0.29, 0.31)], false),
      P({ sizeShares: 0 }),
    );
    expect(r.skipped).toBe(false);
    expect(r.nBidFills).toBeGreaterThan(0); // default size kicked in
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// regimeFillCost — cluster-mean aggregation over weather-days
// ════════════════════════════════════════════════════════════════════════════════════════════════
const mkResult = (over: Partial<BucketInventoryResult>): BucketInventoryResult => ({
  key: 'k',
  station: 'EHAM',
  weatherDay: '2026-06-01',
  regime: 'mid',
  won: false,
  medianMid: 0.5,
  fillPnlUsd: -10,
  fillPnlFlattenUsd: -5,
  capitalUsd: 100,
  fillYield: -0.1,
  fillYieldFlatten: -0.05,
  finalInventoryShares: 0,
  nBidFills: 1,
  nAskFills: 0,
  nEpochs: 10,
  windowDays: 0.5,
  skipped: false,
  ...over,
});

describe('regimeFillCost', () => {
  it('clusters by weather-day and reports the cluster-mean fill yield', () => {
    const results: BucketInventoryResult[] = [
      mkResult({ regime: 'mid', weatherDay: 'd1', fillYield: -0.1 }),
      mkResult({ regime: 'mid', weatherDay: 'd2', fillYield: -0.2 }),
      mkResult({ regime: 'cheap', weatherDay: 'd1', fillYield: 0.0 }),
    ];
    const cost = regimeFillCost(results, 'mid');
    expect(cost.nBuckets).toBe(2);
    expect(cost.nDays).toBe(2);
    expect(cost.meanFillYield).toBeCloseTo(-0.15, 9); // mean of cluster means (d1=-0.1, d2=-0.2)
    expect(cost.medianFillYield).toBeCloseTo(-0.15, 9);
  });
  it('excludes skipped / non-finite and other regimes', () => {
    const results = [
      mkResult({ regime: 'mid', fillYield: -0.1 }),
      mkResult({ regime: 'mid', skipped: true, fillYield: NaN }),
      mkResult({ regime: 'cheap', fillYield: -0.5 }),
    ];
    const cost = regimeFillCost(results, 'mid');
    expect(cost.nBuckets).toBe(1);
  });
  it('empty regime → NaN mean, zero buckets', () => {
    const cost = regimeFillCost([], 'rich');
    expect(cost.nBuckets).toBe(0);
    expect(cost.meanFillYield).toBeNaN();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// rewardYieldPerDay + regimeRewardYield — the income side (capital-share)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('rewardYieldPerDay', () => {
  it('= pool / (capital + κ·competing)', () => {
    expect(rewardYieldPerDay(86.8, 1364, 100, 1)).toBeCloseTo(86.8 / 1464, 9);
  });
  it('alone in the market (κ=0) → pool / capital', () => {
    expect(rewardYieldPerDay(80, 1000, 100, 0)).toBeCloseTo(0.8, 9);
  });
  it('degenerate inputs → 0', () => {
    expect(rewardYieldPerDay(0, 1000, 100, 1)).toBe(0);
    expect(rewardYieldPerDay(80, 1000, 0, 1)).toBeGreaterThan(0); // capital 0 but competing > 0 → still defined
    expect(rewardYieldPerDay(80, 0, 0, 1)).toBe(0); // no capital, no competition → 0
  });
  it('treats negative competing as 0', () => {
    expect(rewardYieldPerDay(80, -50, 100, 1)).toBeCloseTo(0.8, 9);
  });
});

describe('regimeRewardYield', () => {
  const markets: FundedMarket[] = [
    { conditionId: 'a', dailyPoolUsd: 50, competingCapitalUsd: 1000, mid: 0.5 },
    { conditionId: 'b', dailyPoolUsd: 40, competingCapitalUsd: 364, mid: 0.6 },
    { conditionId: 'c', dailyPoolUsd: 5, competingCapitalUsd: 200, mid: 0.05 },
  ];
  it('aggregates the live universe by regime, capital-weighted', () => {
    const r = regimeRewardYield(markets, 'mid', 100, 1);
    expect(r.nMarkets).toBe(2);
    expect(r.totalPoolUsd).toBe(90);
    expect(r.totalCompetingUsd).toBe(1364);
    // 90 / (2·100 + 1·1364) = 90 / 1564
    expect(r.meanRewardYield).toBeCloseTo(90 / 1564, 9);
  });
  it('cheap regime picks up the cheap market only', () => {
    const r = regimeRewardYield(markets, 'cheap', 100, 1);
    expect(r.nMarkets).toBe(1);
    expect(r.totalPoolUsd).toBe(5);
  });
  it('empty regime → 0 yield', () => {
    expect(regimeRewardYield(markets, 'rich', 100, 1).meanRewardYield).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// regimeNet + the frozen verdict
// ════════════════════════════════════════════════════════════════════════════════════════════════
const mkCost = (over: Partial<RegimeFillCost>): RegimeFillCost => ({
  regime: 'mid',
  nBuckets: 50,
  nDays: 20,
  meanFillYield: -0.1,
  ciLo: -0.13,
  ciHi: -0.07,
  medianFillYield: -0.1,
  bidFillsPerBucket: 1,
  askFillsPerBucket: 1,
  ...over,
});
const mkReward = (over: Partial<RegimeRewardYield>): RegimeRewardYield => ({
  regime: 'mid',
  nMarkets: 300,
  totalPoolUsd: 29000,
  totalCompetingUsd: 460000,
  meanRewardYield: 0.06,
  ...over,
});

describe('regimeNet', () => {
  it('net = reward + fill, with the CI propagating the fill-cost uncertainty', () => {
    const n = regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: -0.1, ciLo: -0.13, ciHi: -0.07 }));
    expect(n.netYield).toBeCloseTo(-0.04, 9);
    expect(n.netLo).toBeCloseTo(0.06 - 0.13, 9);
    expect(n.netHi).toBeCloseTo(0.06 - 0.07, 9);
  });
});

describe('rewardInventoryVerdict — frozen kill-criterion', () => {
  it('FAIL when the measured fill cost erases the reward share (net ≤ 0)', () => {
    const v = rewardInventoryVerdict(regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: -0.1 })));
    expect(v.label).toBe('FAIL');
    expect(v.reason).toMatch(/FAIL/);
  });
  it('PASS when net > 0 and the 95% CI lower bound clears 0', () => {
    const v = rewardInventoryVerdict(
      regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: -0.02, ciLo: -0.03, ciHi: -0.01 })),
    );
    // net 0.04, netLo 0.06−0.03 = 0.03 > 0
    expect(v.label).toBe('PASS');
  });
  it('PROMISING when net > 0 but the CI straddles 0', () => {
    const v = rewardInventoryVerdict(
      regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: -0.04, ciLo: -0.09, ciHi: 0.01 })),
    );
    // net 0.02, netLo 0.06−0.09 = −0.03 < 0
    expect(v.label).toBe('PROMISING');
  });
  it('sanity null: zero fill cost + positive reward → PASS', () => {
    const v = rewardInventoryVerdict(
      regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: 0, ciLo: 0, ciHi: 0 })),
    );
    expect(v.label).toBe('PASS');
  });
  it('sanity null: zero reward + negative cost → FAIL', () => {
    const v = rewardInventoryVerdict(
      regimeNet(mkReward({ meanRewardYield: 0 }), mkCost({ meanFillYield: -0.05 })),
    );
    expect(v.label).toBe('FAIL');
  });
  it('NaN net → FAIL (insufficient evidence fails the gate)', () => {
    const v = rewardInventoryVerdict(
      regimeNet(mkReward({ meanRewardYield: NaN }), mkCost({ meanFillYield: NaN })),
    );
    expect(v.label).toBe('FAIL');
  });
  it('data-limited (< MIN_CI_DAYS): a positive net CANNOT be certified → PROMISING, not PASS', () => {
    const v = rewardInventoryVerdict(
      // net 0.04, CI clears 0 — but only 2 weather-days, so PASS is downgraded.
      regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: -0.02, ciLo: -0.03, ciHi: -0.01, nDays: 2 })),
    );
    expect(v.label).toBe('PROMISING');
    expect(v.dataLimited).toBe(true);
    expect(v.reason).toMatch(/cannot be certified/);
  });
  it('a wide-margin FAIL stays FAIL even when data-limited (direction is robust)', () => {
    const v = rewardInventoryVerdict(
      regimeNet(mkReward({ meanRewardYield: 0.06 }), mkCost({ meanFillYield: -0.5, nDays: 2 })),
    );
    expect(v.label).toBe('FAIL');
    expect(v.dataLimited).toBe(true);
    expect(v.reason).toMatch(/DIRECTIONAL/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// runInventoryStudy — end to end
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('runInventoryStudy', () => {
  const results: BucketInventoryResult[] = [
    mkResult({ regime: 'mid', weatherDay: 'd1', fillYield: -0.1 }),
    mkResult({ regime: 'mid', weatherDay: 'd2', fillYield: -0.12 }),
    mkResult({ regime: 'cheap', weatherDay: 'd1', fillYield: -0.01 }),
    mkResult({ skipped: true, fillYield: NaN }),
  ];
  const markets: FundedMarket[] = [
    { conditionId: 'a', dailyPoolUsd: 50, competingCapitalUsd: 1000, mid: 0.5 },
    { conditionId: 'b', dailyPoolUsd: 40, competingCapitalUsd: 364, mid: 0.6 },
    { conditionId: 'c', dailyPoolUsd: 5, competingCapitalUsd: 200, mid: 0.05 },
  ];
  it('populates all regimes, adjudicates the binding mid regime, and counts coverage', () => {
    const study = runInventoryStudy(results, markets, { kappa: 1, capitalPerMarketUsd: 100 });
    expect(study.nModelled).toBe(3);
    expect(study.nSkipped).toBe(1);
    expect(study.cost.mid.nBuckets).toBe(2);
    expect(study.reward.mid.nMarkets).toBe(2);
    expect(study.verdict.binding.regime).toBe('mid');
    // mid reward 90/1564 ≈ 0.0575; mid fill ≈ −0.11 → net < 0 → FAIL
    expect(study.verdict.label).toBe('FAIL');
  });
  it('defaults kappa=1 and capital≈size when unspecified', () => {
    const study = runInventoryStudy(results, markets);
    expect(study.kappa).toBe(1);
    expect(study.capitalPerMarketUsd).toBe(DEFAULT_INVENTORY_PARAMS.sizeShares);
  });
  it('empty inputs → zeroed study, never throws', () => {
    const study = runInventoryStudy([], []);
    expect(study.nModelled).toBe(0);
    expect(study.verdict.label).toBe('FAIL');
  });
});
