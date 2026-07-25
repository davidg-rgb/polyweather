import { describe, it, expect } from 'vitest';
import {
  noArmBet,
  holdArmBet,
  bracketBet,
  buildArm,
  clusterCi,
  clusterBootstrapCi,
  summarizeArm,
  analyzeArtifact,
  ciSign,
  powerWarning,
  DEGENERATE_NO_PRICE,
  type ArmBet,
} from './convergence-side-arms.ts';
import type { TradeRow } from './convergence-capture-score.ts';

const FEE = 0.05;

const row = (over: Partial<TradeRow> = {}): TradeRow => ({
  eventId: 'E1', city: 'ankara', targetDate: '2026-07-10', bucketIdx: 3, entryLabel: '30°C',
  entryAgeH: 0.2, entryPrice: 0.2, isMaker: false, entryBestBid: 0.15, entryExecBid: 0.14,
  entryDepthUsd: 200, entrySellbackDepthUsd: 200, exitReason: 'take_profit:x', exitPrice: 0.3,
  stakeUsd: 5, netPnlUsd: 1, netReturn: 0.2, bestReachableBid: 0.3, winnerIdx: 3, bucketWon: true,
  tpDeltaPp: 0.25, select: 'M0', houseEdge: true, ...over,
});

const bet = (city: string, day: string, edge: number): ArmBet => ({
  eventId: `${city}-${day}-${edge}`, city, targetDate: day,
  price: 0.5, fee: 0, payoff: 1, edgePerShare: edge, edgePerDollar: edge * 2, depthUsd: 100, won: edge > 0,
});

describe('side arms · the NO leg', () => {
  it('prices NO off the EXECUTABLE bid, not top-of-book — the flattering substitution is refused', () => {
    // execBid 0.14 (depth-walked) vs bestBid 0.15 (size-1): using bestBid would make NO 1¢ cheaper on every row.
    const b = noArmBet(row(), FEE)!;
    expect(b.price).toBeCloseTo(0.86, 12);
    expect(b.price).not.toBeCloseTo(1 - 0.15, 12);
  });

  it('pays out on the INVERSE outcome and always charges the taker fee, even behind a maker YES entry', () => {
    const lost = noArmBet(row({ bucketWon: true }), FEE)!; // bucket won ⇒ NO is a total loss
    expect(lost.payoff).toBe(0);
    expect(lost.edgePerShare).toBeCloseTo(-0.86 - FEE * 0.86 * 0.14, 12);
    expect(lost.won).toBe(false);

    const won = noArmBet(row({ bucketWon: false }), FEE)!;
    expect(won.payoff).toBe(1);
    expect(won.edgePerShare).toBeCloseTo(0.14 - FEE * 0.86 * 0.14, 12);
    // buying NO lifts the YES bid — a maker YES entry does NOT make the NO leg fee-free
    expect(noArmBet(row({ bucketWon: false, isMaker: true }), FEE)!.fee).toBeCloseTo(FEE * 0.86 * 0.14, 12);
  });

  it('refuses to invent a cost basis: no execBid ⇒ no bet, never a silent 0¢', () => {
    expect(noArmBet(row({ entryExecBid: null }), FEE)).toBeNull();
    const { bets, drops } = buildArm([row({ entryExecBid: null })], 'NO', FEE, 0);
    expect(bets).toHaveLength(0);
    expect(drops.noPrice).toBe(1);
  });

  it('drops an unresolved row instead of scoring it as a loss, and counts the drop', () => {
    const { bets, drops } = buildArm([row(), row({ eventId: 'E2', bucketWon: null, winnerIdx: null })], 'NO', FEE, 0);
    expect(bets).toHaveLength(1);
    expect(drops.unknownResolution).toBe(1);
  });

  it('counts the degenerate $1.00 NO (no YES bid) — and any real depth floor removes it', () => {
    const noBid = row({ eventId: 'E2', entryExecBid: 0, entrySellbackDepthUsd: 0 });
    const at0 = buildArm([row(), noBid], 'NO', FEE, 0);
    const s0 = summarizeArm(at0.bets, at0.drops, 'NO', 0, { iters: 200 });
    expect(s0.n).toBe(2);
    expect(s0.nDegeneratePrice).toBe(1);
    expect(at0.bets.find((b) => b.eventId === 'E2')!.price).toBeGreaterThanOrEqual(DEGENERATE_NO_PRICE);

    const at50 = buildArm([row(), noBid], 'NO', FEE, 50);
    expect(summarizeArm(at50.bets, at50.drops, 'NO', 50, { iters: 200 }).nDegeneratePrice).toBe(0);
    expect(at50.drops.belowDepthFloor).toBe(1);
  });

  it('checks capacity on the BID side (what a NO buyer consumes), not the ask side', () => {
    // thick ask, empty bid: buyable as YES, NOT sellable — so HOLD survives the floor and NO does not.
    const thinBid = row({ entryDepthUsd: 500, entrySellbackDepthUsd: 5 });
    expect(buildArm([thinBid], 'NO', FEE, 50).bets).toHaveLength(0);
    expect(buildArm([thinBid], 'HOLD', FEE, 50).bets).toHaveLength(1);
    expect(buildArm([thinBid], 'BRACKET', FEE, 50).bets).toHaveLength(1);
  });
});

describe('side arms · the HOLD leg', () => {
  it('settles at resolution with the entry fee only, honoring a maker fill at $0', () => {
    const maker = holdArmBet(row({ isMaker: true }), FEE)!;
    expect(maker.fee).toBe(0);
    expect(maker.payoff).toBe(1);
    expect(maker.edgePerShare).toBeCloseTo(1 - 0.2, 12); // no exit fee — a resolution redeem is free
    const taker = holdArmBet(row({ isMaker: false }), FEE)!;
    expect(taker.fee).toBeCloseTo(FEE * 0.2 * 0.8, 12);
    expect(holdArmBet(row({ bucketWon: false }), FEE)!.edgePerShare).toBeCloseTo(-0.2 - FEE * 0.2 * 0.8, 12);
  });

  it('is scored per $1 on capital actually put up (fee inside the denominator)', () => {
    const t = holdArmBet(row({ bucketWon: false }), FEE)!;
    expect(t.edgePerDollar).toBeCloseTo(t.edgePerShare / (t.price + t.fee), 12);
  });
});

describe('side arms · the BRACKET baseline', () => {
  it('reads the engine netReturn straight through — the arms are never compared to a re-simulation', () => {
    const b = bracketBet(row({ netReturn: 0.2, entryPrice: 0.2 }), FEE)!;
    expect(b.edgePerDollar).toBe(0.2);
    expect(b.edgePerShare).toBeCloseTo(0.04, 12); // per-$ × price ⇒ per-share
    expect(Number.isNaN(b.payoff)).toBe(true); // it exits before resolution; there is no settle
  });

  it('survives an unresolved row (it never needed the winner)', () => {
    expect(buildArm([row({ bucketWon: null, winnerIdx: null })], 'BRACKET', FEE, 0).bets).toHaveLength(1);
  });
});

describe('side arms · estimators', () => {
  it('clusters: the mean is the mean of CITY means, so one busy city cannot outvote a quiet one', () => {
    const bets = [bet('a', 'd1', 0.1), bet('a', 'd2', 0.1), bet('a', 'd3', 0.1), bet('b', 'd1', -0.3)];
    // pooled mean would be 0.0; the clustered estimand is (0.1 + −0.3)/2 = −0.1
    const ci = clusterCi(bets, (b) => b.city, (b) => b.edgePerShare);
    expect(ci.mean).toBeCloseTo(-0.1, 12);
    expect(ci.nClusters).toBe(2);
  });

  it('the cluster bootstrap is WIDER than the iid row bootstrap on clustered data (that is the correction)', () => {
    // 5 cities × 8 identical rows each: an iid row resample sees 40 "independent" draws that are really 5.
    const bets = [0.4, 0.2, -0.1, -0.3, 0.05].flatMap((v, c) =>
      Array.from({ length: 8 }, (_, i) => bet(`c${c}`, `d${i}`, v)));
    const byCity = (b: ArmBet): string => b.city;
    const val = (b: ArmBet): number => b.edgePerShare;
    const clustered = clusterBootstrapCi(bets, byCity, val, { iters: 3000, seed: 7 });
    const iid = clusterBootstrapCi(bets, byCity, val, { iters: 3000, seed: 7, clusterUnit: 'row' });
    expect(clustered.n).toBe(5);
    expect(iid.n).toBe(40);
    expect(clustered.hi - clustered.lo).toBeGreaterThan(iid.hi - iid.lo);
  });

  it('is seeded — same input, same interval, run to run', () => {
    const bets = [bet('a', 'd1', 0.2), bet('b', 'd1', -0.4), bet('c', 'd2', 0.05), bet('d', 'd2', 0.3)];
    const args = [bets, (b: ArmBet) => b.city, (b: ArmBet) => b.edgePerShare, { iters: 500, seed: 99 }] as const;
    expect(clusterBootstrapCi(...args)).toEqual(clusterBootstrapCi(...args));
    expect(clusterBootstrapCi(...args)).not.toEqual(
      clusterBootstrapCi(bets, (b) => b.city, (b) => b.edgePerShare, { iters: 500, seed: 100 }),
    );
  });

  it('fails closed rather than reporting a point-mass interval on <2 clusters', () => {
    const one = [bet('a', 'd1', 0.2), bet('a', 'd2', 0.4)];
    const b = clusterBootstrapCi(one, (x) => x.city, (x) => x.edgePerShare, { iters: 200 });
    expect(Number.isNaN(b.lo)).toBe(true);
    expect(ciSign(b.lo, b.hi)).toBe('UNDEFINED');
  });

  it('ciSign is a mechanical read of the interval, not a verdict', () => {
    expect(ciSign(0.01, 0.2)).toBe('POSITIVE_EXCLUDES_0');
    expect(ciSign(-0.2, -0.01)).toBe('NEGATIVE_EXCLUDES_0');
    expect(ciSign(-0.2, 0.1)).toBe('STRADDLES_0');
    expect(ciSign(NaN, 0.1)).toBe('UNDEFINED');
  });

  it('flags a cell below the §9R-E floor, and a constant-outcome cell whose CI is narrow for want of variance', () => {
    expect(powerWarning(120, 10, 19, 0.4)).toBe('');
    expect(powerWarning(10, 6, 9, 0.4)).toContain('UNDERPOWERED');
    expect(powerWarning(120, 4, 19, 0.4)).toContain('UNDERPOWERED');
    expect(powerWarning(120, 10, 5, 0.4)).toContain('UNDERPOWERED');
    // the false-positive shape: every bet won, so the t-CI measures price spread and "excludes 0" on any n
    expect(powerWarning(120, 10, 19, 1)).toContain('CONSTANT OUTCOME');
    expect(powerWarning(120, 10, 19, 0)).toContain('CONSTANT OUTCOME');
  });

  it('a 10-row all-winners cell carries a warning even though its CI excludes zero', () => {
    // 10 bets, all won, spread over 6 cities — the exact cell shape that reads as a finding and is not one.
    const bets = Array.from({ length: 10 }, (_, i) => ({
      ...bet(`c${i % 6}`, `d${i}`, 0.14 + i * 0.002), payoff: 1, price: 0.85, won: true,
    }));
    const s = summarizeArm(bets, { noPrice: 0, unknownResolution: 0, belowDepthFloor: 0 }, 'NO', 150, { iters: 500 });
    expect(s.sign).toBe('POSITIVE_EXCLUDES_0');
    expect(s.powerWarning).toContain('UNDERPOWERED');
    expect(s.powerWarning).toContain('CONSTANT OUTCOME');
  });
});

describe('side arms · analyzeArtifact', () => {
  it('scores the HEADLINE TP only — the swept TPs in the same array must not be double-counted', () => {
    const art = {
      params: { select: 'M1' as const, houseEdge: false, cities: 'bot', feeRate: FEE },
      panel: { headlineTp: 0.25, perTp: [{ tpDeltaPp: 0.25, label: 'KILL' }] },
      tradeRows: [row(), row({ eventId: 'E2', tpDeltaPp: 0.1 }), row({ eventId: 'E3', tpDeltaPp: 0.06 })],
    };
    const res = analyzeArtifact(art, 'x.json', { iters: 200 });
    expect(res.nHeadlineRows).toBe(1);
    expect(res.select).toBe('M1');
    expect(res.bracketLabel).toBe('KILL');
    expect(res.arms).toHaveLength(9); // 3 arms × 3 depth floors
    expect(res.arms.every((a) => a.n <= 1)).toBe(true);
  });

  it('is total on an artifact with no rows at all', () => {
    const res = analyzeArtifact({ tradeRows: [], panel: { headlineTp: 0.25 } }, 'empty.json', { iters: 100 });
    expect(res.nHeadlineRows).toBe(0);
    expect(res.arms.every((a) => a.n === 0 && a.sign === 'UNDEFINED')).toBe(true);
  });
});
