import { describe, expect, it } from 'vitest';
import {
  attribution,
  brierVsOutcomes,
  dailyPnlCurve,
  ENTRY_PRICE_CUTS,
  MARKET_BASELINE_PROB,
  type RealizedBet,
  reconstructRealizedPnl,
  regimeChange,
  regimeOnset,
  roiBelow025,
  roiByEntryBucket,
  roiMid045to075,
  usRegionForCity,
  utcDay,
  type WalletFill,
  walletEdgeStats,
  winRateCi,
} from '../src/sim/wallet-forensics.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// fixture builders
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const DAY = 86_400;
const T0 = Math.floor(Date.parse('2026-05-01T00:00:00Z') / 1000); // a fixed UTC anchor
const PAST = '2026-05-02'; // a target_date strictly before RESOLVED_BEFORE → graded as resolved
const RESOLVED_BEFORE = '2026-06-01';

function buy(
  conditionId: string,
  outcome: string,
  shares: number,
  price: number,
  tsOffsetDays = 0,
  extra: Partial<WalletFill> = {},
): WalletFill {
  return {
    type: 'TRADE',
    side: 'BUY',
    conditionId,
    outcome,
    sizeShares: shares,
    usdcSize: shares * price,
    timestamp: T0 + tsOffsetDays * DAY,
    citySlug: null,
    targetDate: PAST,
    ...extra,
  };
}

/**
 * A REDEEM row as Polymarket actually sends it (verified live): empty outcome/side, price 0, and
 * usdcSize == size (the $1/share winning payout). A LOSER has NO redeem at all — model a loss by simply
 * omitting the redeem and grading with resolvedBefore (the cash-flow model). payoutPerShare is therefore
 * effectively always 1 here (a redeem only exists for winners); kept as a param for explicit fixtures.
 */
function redeem(
  conditionId: string,
  shares: number,
  payoutPerShare = 1,
  tsOffsetDays = 0,
  extra: Partial<WalletFill> = {},
): WalletFill {
  return {
    type: 'REDEEM',
    side: null,
    conditionId,
    outcome: '', // REDEEM carries no leg
    sizeShares: shares,
    usdcSize: shares * payoutPerShare,
    timestamp: T0 + tsOffsetDays * DAY,
    citySlug: null,
    targetDate: PAST,
    ...extra,
  };
}

function sell(
  conditionId: string,
  outcome: string,
  shares: number,
  price: number,
  tsOffsetDays = 0,
): WalletFill {
  return {
    type: 'TRADE',
    side: 'SELL',
    conditionId,
    outcome,
    sizeShares: shares,
    usdcSize: shares * price,
    timestamp: T0 + tsOffsetDays * DAY,
    citySlug: null,
    targetDate: null,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// FIFO realized-PnL reconstruction
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('reconstructRealizedPnl — conditionId cash-flow identity', () => {
  it('a single cheap winning longshot: buy 100 @0.20 ($20), REDEEM 100 @$1 ($100) → +$80', () => {
    const fills = [buy('c1', 'Yes', 100, 0.2), redeem('c1', 100)];
    const r = reconstructRealizedPnl(fills);
    expect(r.realizedTotalUsd).toBeCloseTo(80, 6); // 100 proceeds − 20 cost
    expect(r.volumeUsd).toBeCloseTo(20, 6);
    expect(r.nWins).toBe(1);
    expect(r.nLosses).toBe(0);
    expect(r.winRate).toBe(1);
    expect(r.roiOnVolume).toBeCloseTo(4, 6); // 80 / 20
    expect(r.bets).toHaveLength(1);
    expect(r.bets[0]!.entryPrice).toBeCloseTo(0.2, 6);
    expect(r.bets[0]!.won).toBe(true);
    expect(r.bets[0]!.outcome).toBe('Yes'); // dominant leg label recovered from the BUYs
  });

  it('a LOSER has no settlement event: buy 50 @0.40 ($20), no redeem + resolvedBefore → −$20, lost', () => {
    const fills = [buy('c2', 'Yes', 50, 0.4)];
    const r = reconstructRealizedPnl(fills, { resolvedBefore: RESOLVED_BEFORE });
    expect(r.realizedTotalUsd).toBeCloseTo(-20, 6); // −cost, total loss
    expect(r.nWins).toBe(0);
    expect(r.nLosses).toBe(1);
    expect(r.bets[0]!.won).toBe(false);
  });

  it('without resolvedBefore an unsettled (BUY-only) market stays OPEN — excluded from the realized total', () => {
    const fills = [buy('c2', 'Yes', 50, 0.4)];
    const r = reconstructRealizedPnl(fills); // no resolvedBefore
    expect(r.realizedTotalUsd).toBe(0); // open, not realized
    expect(r.nWins).toBe(0);
    expect(r.nLosses).toBe(0);
    expect(r.volumeUsd).toBeCloseTo(20, 6); // staked still counted
  });

  it('SELL proceeds net against BUY cost at the conditionId level', () => {
    // Buy 100 @0.10 ($10) + 100 @0.30 ($30) = $40 cost; SELL 150 @0.50 = $75 proceeds.
    // Cash-flow: 75 − 40 = +35 realized (SELL closes the market). entry VWAP = 0.20.
    const fills = [buy('c3', 'Yes', 100, 0.1, 0), buy('c3', 'Yes', 100, 0.3, 1), sell('c3', 'Yes', 150, 0.5, 2)];
    const r = reconstructRealizedPnl(fills);
    expect(r.realizedTotalUsd).toBeCloseTo(35, 6);
    expect(r.volumeUsd).toBeCloseTo(40, 6);
    expect(r.bets).toHaveLength(1);
    expect(r.bets[0]!.won).toBe(true);
    expect(r.bets[0]!.entryPrice).toBeCloseTo(0.2, 6); // VWAP over both buys
  });

  it('a hand-built multi-market ledger sums to a known realized total (winners redeem, losers do not)', () => {
    // A: buy 100 @0.05 ($5), REDEEM 100 @$1 ($100) → +95   (cheap longshot win)
    // B: buy 100 @0.60 ($60), NO redeem (loser) → −60        (the "No spray" bleed; resolvedBefore grades it)
    // C: buy 200 @0.20 ($40), REDEEM 200 @$1 ($200) → +160
    // total = 95 − 60 + 160 = +195
    const fills = [
      buy('A', 'Yes', 100, 0.05, 0),
      redeem('A', 100, 1, 5),
      buy('B', 'Yes', 100, 0.6, 1),
      buy('C', 'Yes', 200, 0.2, 2),
      redeem('C', 200, 1, 7),
    ];
    const r = reconstructRealizedPnl(fills, { resolvedBefore: RESOLVED_BEFORE });
    expect(r.realizedTotalUsd).toBeCloseTo(195, 6);
    expect(r.volumeUsd).toBeCloseTo(105, 6); // 5 + 60 + 40
    expect(r.nWins).toBe(2);
    expect(r.nLosses).toBe(1);
    expect(r.winRate).toBeCloseTo(2 / 3, 6);
  });

  it('groups by conditionId (REDEEM has no leg) — a REDEEM is matched to its market regardless of leg', () => {
    // The wallet bought the Yes leg of market x for $30 and it won (REDEEM $100). +70 on the one market.
    const fills = [buy('x', 'Yes', 100, 0.3, 0), redeem('x', 100, 1, 1)];
    const r = reconstructRealizedPnl(fills, { resolvedBefore: RESOLVED_BEFORE });
    expect(r.realizedTotalUsd).toBeCloseTo(70, 6);
    expect(r.bets).toHaveLength(1); // one MARKET, not two legs
  });

  it('MERGE is a TRADING proceed; MAKER_REBATE / REWARD are incentives (decomposed, not netted into the bet)', () => {
    // Buy 100 @0.30 ($30 cost) on market m; later a MERGE returns $25 + a MAKER_REBATE $2 + a REWARD $3.
    // TRADING-ONLY: proceeds (MERGE 25) − cost 30 = −5 realized. Incentives (rebate 2 + reward 3) = 5, booked
    // SEPARATELY. trading+incentives = 0. The bet row carries the trading-only −5 (won = false).
    const merge = (cond: string, usd: number, day = 1): WalletFill => ({
      type: 'MERGE', side: null, conditionId: cond, outcome: '', sizeShares: usd, usdcSize: usd,
      timestamp: T0 + day * DAY, citySlug: null, targetDate: PAST,
    });
    const rebate = (cond: string, type: string, usd: number, day = 1): WalletFill => ({
      type, side: null, conditionId: cond, outcome: '', sizeShares: usd, usdcSize: usd,
      timestamp: T0 + day * DAY, citySlug: null, targetDate: PAST,
    });
    const fills = [
      buy('m', 'Yes', 100, 0.3, 0),
      merge('m', 25),
      rebate('m', 'MAKER_REBATE', 2),
      rebate('m', 'REWARD', 3),
    ];
    const r = reconstructRealizedPnl(fills, { resolvedBefore: RESOLVED_BEFORE });
    expect(r.realizedTotalUsd).toBeCloseTo(-5, 6); // trading-only: 25 MERGE in − 30 BUY out
    expect(r.incentivesUsd).toBeCloseTo(5, 6); // rebate 2 + reward 3, booked separately
    expect(r.tradingPlusIncentivesUsd).toBeCloseTo(0, 6);
    expect(r.mergeProceedsUsd).toBeCloseTo(25, 6);
    expect(r.buyCostUsd).toBeCloseTo(30, 6);
    expect(r.bets).toHaveLength(1);
    expect(r.bets[0]!.realizedUsd).toBeCloseTo(-5, 6); // per-bet row is trading-only
    expect(r.bets[0]!.won).toBe(false); // −5 is not > 0
    // the daily curve is trading-only too → endpoint = −5 (incentives excluded)
    const cum = dailyPnlCurve(fills).at(-1)!.cumUsd;
    expect(cum).toBeCloseTo(-5, 6);
  });

  it('decomposes proceeds by event type on a hand-built ledger (exact trading-only vs trading+incentives)', () => {
    // Known ledger with one of each cash-in event:
    //   A: BUY 100 @0.10 ($10) + REDEEM 100 @$1 ($100)            → trading +90
    //   B: BUY 100 @0.50 ($50) + SELL 100 @0.70 ($70)             → trading +20
    //   C: BUY 100 @0.40 ($40) + MERGE $30                        → trading −10
    //   D: BUY 100 @0.60 ($60), no settlement (loser, graded)     → trading −60
    //   incentives: MAKER_REBATE $7 (on A) + REWARD $5 (on B)     → incentives +12
    // Σ BUY = 10+50+40+60 = 160; Σ SELL = 70; Σ REDEEM = 100; Σ MERGE = 30; Σ incentives = 12
    // trading-only = (70 + 100 + 30) − 160 = +40 ; trading+incentives = 40 + 12 = +52
    const incentive = (cond: string, type: string, u: number, day = 3): WalletFill => ({
      type, side: null, conditionId: cond, outcome: '', sizeShares: u, usdcSize: u,
      timestamp: T0 + day * DAY, citySlug: null, targetDate: PAST,
    });
    const fills: WalletFill[] = [
      buy('A', 'Yes', 100, 0.1, 0),
      redeem('A', 100, 1, 4),
      incentive('A', 'MAKER_REBATE', 7),
      buy('B', 'Yes', 100, 0.5, 1),
      sell('B', 'Yes', 100, 0.7, 5),
      incentive('B', 'REWARD', 5),
      buy('C', 'Yes', 100, 0.4, 2),
      { type: 'MERGE', side: null, conditionId: 'C', outcome: '', sizeShares: 30, usdcSize: 30,
        timestamp: T0 + 6 * DAY, citySlug: null, targetDate: PAST },
      buy('D', 'Yes', 100, 0.6, 2),
    ];
    const r = reconstructRealizedPnl(fills, { resolvedBefore: RESOLVED_BEFORE });
    expect(r.buyCostUsd).toBeCloseTo(160, 6);
    expect(r.sellProceedsUsd).toBeCloseTo(70, 6);
    expect(r.redeemProceedsUsd).toBeCloseTo(100, 6);
    expect(r.mergeProceedsUsd).toBeCloseTo(30, 6);
    expect(r.incentivesUsd).toBeCloseTo(12, 6);
    expect(r.realizedTotalUsd).toBeCloseTo(40, 6); // trading-only headline
    expect(r.tradingPlusIncentivesUsd).toBeCloseTo(52, 6);
    expect(r.nWins).toBe(2); // A (+90), B (+20)
    expect(r.nLosses).toBe(2); // C (−10), D (−60)
    // daily curve is trading-only → endpoint = trading-only total
    expect(dailyPnlCurve(fills).at(-1)!.cumUsd).toBeCloseTo(40, 6);
  });

  it('is order-independent on input (aggregates, never replays)', () => {
    const a = [buy('c', 'Yes', 100, 0.1, 0), buy('c', 'Yes', 100, 0.3, 1), sell('c', 'Yes', 150, 0.5, 2)];
    const shuffled = [a[2]!, a[0]!, a[1]!];
    expect(reconstructRealizedPnl(shuffled).realizedTotalUsd).toBeCloseTo(
      reconstructRealizedPnl(a).realizedTotalUsd,
      6,
    );
  });

  it('empty fills → zeroed aggregate, NaN ratios, no throw', () => {
    const r = reconstructRealizedPnl([]);
    expect(r.realizedTotalUsd).toBe(0);
    expect(r.volumeUsd).toBe(0);
    expect(r.bets).toEqual([]);
    expect(Number.isNaN(r.winRate)).toBe(true);
    expect(Number.isNaN(r.roiOnVolume)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// dailyPnlCurve
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('dailyPnlCurve — cumulative net cash flow by day', () => {
  it('books BUY as cash-out and SELL/REDEEM as cash-in on their own day', () => {
    const fills = [
      buy('A', 'Yes', 100, 0.2, 0), // −20 day0
      redeem('A', 100, 1, 1), // +100 day1
      buy('B', 'Yes', 100, 0.4, 1), // −40 day1 (a loser → never redeems)
    ];
    const curve = dailyPnlCurve(fills);
    expect(curve).toHaveLength(2);
    expect(curve[0]!.date).toBe(utcDay(T0));
    expect(curve[0]!.realizedUsd).toBeCloseTo(-20, 6); // cash out on the buy day
    expect(curve[0]!.cumUsd).toBeCloseTo(-20, 6);
    expect(curve[1]!.realizedUsd).toBeCloseTo(60, 6); // +100 redeem − 40 buy
    expect(curve[1]!.cumUsd).toBeCloseTo(40, 6); // net cash flow = realized total (loser B's −40 is in)
  });

  it('the final cumUsd equals reconstructRealizedPnl total (the reconciliation invariant)', () => {
    const fills = [
      buy('A', 'Yes', 100, 0.05, 0),
      redeem('A', 100, 1, 5),
      buy('B', 'Yes', 100, 0.6, 1), // loser, no redeem
      buy('C', 'Yes', 200, 0.2, 2),
      redeem('C', 200, 1, 7),
    ];
    const curve = dailyPnlCurve(fills);
    const total = reconstructRealizedPnl(fills, { resolvedBefore: RESOLVED_BEFORE }).realizedTotalUsd;
    expect(curve[curve.length - 1]!.cumUsd).toBeCloseTo(total, 6); // both = +195
    expect(total).toBeCloseTo(195, 6);
  });

  it('empty → []', () => {
    expect(dailyPnlCurve([])).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// roiByEntryBucket + the first-class cuts
// ──────────────────────────────────────────────────────────────────────────────────────────────────

function mkBet(entryPrice: number, won: boolean, staked: number, realized: number, citySlug: string | null = null): RealizedBet {
  return {
    conditionId: `c${entryPrice}-${citySlug}`,
    outcome: 'Yes',
    entryPrice,
    ask: entryPrice,
    won,
    realizedUsd: realized,
    stakedUsd: staked,
    citySlug,
    targetDate: null,
    region: usRegionForCity(citySlug),
  };
}

describe('roiByEntryBucket — the decisive cuts', () => {
  it('assigns bets to the five cuts and computes ROI per cut', () => {
    const bets = [
      mkBet(0.05, true, 10, 40), // [0,0.10)
      mkBet(0.2, true, 10, 20), // [0.10,0.25)
      mkBet(0.3, false, 10, -10), // [0.25,0.45)
      mkBet(0.6, false, 10, -10), // [0.45,0.75)  the No-spray bleed
      mkBet(0.9, true, 10, 2), // [0.75,1]
    ];
    const cuts = roiByEntryBucket(bets);
    expect(cuts).toHaveLength(5);
    expect(cuts[0]!.label).toBe(ENTRY_PRICE_CUTS[0]!.label);
    expect(cuts[0]!.roi).toBeCloseTo(4, 6); // 40/10
    expect(cuts[1]!.roi).toBeCloseTo(2, 6); // 20/10
    expect(cuts[3]!.roi).toBeCloseTo(-1, 6); // -10/10
  });

  it('1.0 lands in the top (closed) cut, not dropped', () => {
    const cuts = roiByEntryBucket([mkBet(1, true, 10, 0)]);
    expect(cuts[4]!.nBets).toBe(1);
  });

  it('roiBelow025 unions the two cheap cuts; roiMid045to075 isolates the bleed', () => {
    const bets = [
      mkBet(0.05, true, 100, 400),
      mkBet(0.2, true, 100, 200),
      mkBet(0.6, false, 100, -100),
    ];
    const cheap = roiBelow025(bets);
    expect(cheap.nBets).toBe(2);
    expect(cheap.stakedUsd).toBeCloseTo(200, 6);
    expect(cheap.realizedUsd).toBeCloseTo(600, 6);
    expect(cheap.roi).toBeCloseTo(3, 6); // 600/200 — POSITIVE (the cheap-longshot signature)

    const mid = roiMid045to075(bets);
    expect(mid.nBets).toBe(1);
    expect(mid.roi).toBeCloseTo(-1, 6); // NEGATIVE (the mid spray)
  });

  it('the cheap-longshot-positive / mid-negative signature is captured end to end', () => {
    const cheap = roiBelow025([mkBet(0.1, true, 100, 50)]);
    const mid = roiMid045to075([mkBet(0.55, false, 100, -100)]);
    expect(cheap.roi).toBeGreaterThan(0);
    expect(mid.roi).toBeLessThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// attribution
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('attribution — city → country → region', () => {
  it('rolls up by city and by US vs international region', () => {
    const bets = [
      mkBet(0.1, true, 10, 50, 'amsterdam'),
      mkBet(0.1, true, 10, 30, 'amsterdam'),
      mkBet(0.1, true, 10, 20, 'houston'), // US
    ];
    const a = attribution(bets);
    const ams = a.byCity.find((r) => r.key === 'amsterdam')!;
    expect(ams.nBets).toBe(2);
    expect(ams.realizedUsd).toBeCloseTo(80, 6);

    const us = a.byRegion.find((r) => r.key === 'US')!;
    const intl = a.byRegion.find((r) => r.key === 'INTL')!;
    expect(us.realizedUsd).toBeCloseTo(20, 6);
    expect(intl.realizedUsd).toBeCloseTo(80, 6);
  });

  it('usRegionForCity: known US slug → US; unknown → INTL; null → null', () => {
    expect(usRegionForCity('houston')).toBe('US');
    expect(usRegionForCity('kuala-lumpur')).toBe('INTL');
    expect(usRegionForCity(null)).toBe(null);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// brierVsOutcomes
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('brierVsOutcomes — calibration of revealed buys', () => {
  it('matches a hand-computed Brier on a tiny ledger', () => {
    // bet1: entry 0.2, won  → brier = (0.2−1)² + (0.8−0)² = 0.64 + 0.64 = 1.28
    // bet2: entry 0.8, lost → brier = (0.8−0)² + (0.2−1)² = 0.64 + 0.64 = 1.28
    // mean walletBrier = 1.28
    const bets = [mkBet(0.2, true, 10, 40), mkBet(0.8, false, 10, -10)];
    const r = brierVsOutcomes(bets);
    expect(r.n).toBe(2);
    expect(r.walletBrier).toBeCloseTo(1.28, 6);
    // market baseline 0.5 each side: brier = (0.5−1)²+(0.5−0)² = 0.25+0.25 = 0.5 for either outcome
    expect(r.marketBrier).toBeCloseTo(0.5, 6);
    expect(MARKET_BASELINE_PROB).toBe(0.5);
  });

  it('a well-calibrated cheap-longshot book scores BELOW the 0.5 baseline', () => {
    // 100 bets at entry 0.1 that win 10% of the time = perfectly calibrated cheap longshots.
    const bets: RealizedBet[] = [];
    for (let i = 0; i < 100; i++) bets.push(mkBet(0.1, i < 10, 10, i < 10 ? 90 : -10));
    const r = brierVsOutcomes(bets);
    // wallet brier per bet at q=0.1: win→(0.1−1)²+(0.9)²=1.62; loss→(0.1)²+(0.9−1)²=0.02
    // mean = (10*1.62 + 90*0.02)/100 = (16.2 + 1.8)/100 = 0.18  ≪ 0.5 baseline
    expect(r.walletBrier).toBeCloseTo(0.18, 6);
    expect(r.walletBrier).toBeLessThan(r.marketBrier);
    // ≥30 bets so the paired bootstrap runs; the wallet is reliably sharper → small p.
    expect(r.pairedBootstrapP).toBeLessThan(0.05);
  });

  it('empty → NaN brier, p=1, no throw', () => {
    const r = brierVsOutcomes([]);
    expect(r.n).toBe(0);
    expect(Number.isNaN(r.walletBrier)).toBe(true);
    expect(r.pairedBootstrapP).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// regimeChange — PELT-lite
// ──────────────────────────────────────────────────────────────────────────────────────────────────

function curveFromDeltas(deltas: number[]): { date: string; realizedUsd: number; cumUsd: number }[] {
  let cum = 0;
  return deltas.map((d, i) => {
    cum += d;
    return { date: utcDay(T0 + i * DAY), realizedUsd: d, cumUsd: cum };
  });
}

describe('regimeChange — single-breakpoint slope flip detector', () => {
  it('pins a synthetic flat→vertical flip at the known breakpoint day', () => {
    // 10 days flat at ~0, then 10 days +1000/day — the badatmath inflection shape.
    const deltas = [...Array(10).fill(0), ...Array(10).fill(1000)];
    const curve = curveFromDeltas(deltas);
    const rc = regimeChange(curve);
    // the break lands at the flat→vertical transition (day index 9 or 10 — both are the same kink, the
    // OLS-maximizing split can anchor on either side of the last flat point). Pin it to the kink window.
    expect([curve[9]!.date, curve[10]!.date]).toContain(rc.breakpointDate);
    expect(rc.preSlope).toBeLessThanOrEqual(0.0001);
    expect(rc.postSlope).toBeGreaterThan(500);
  });

  it('pins a losing→winning sign flip', () => {
    // 8 days −50/day (losing), then 8 days +200/day (winning).
    const deltas = [...Array(8).fill(-50), ...Array(8).fill(200)];
    const curve = curveFromDeltas(deltas);
    const rc = regimeChange(curve);
    expect([curve[7]!.date, curve[8]!.date]).toContain(rc.breakpointDate);
    expect(rc.preSlope).toBeLessThan(0);
    expect(rc.postSlope).toBeGreaterThan(0);
  });

  it('a single steady regime flags no break', () => {
    const deltas = Array(20).fill(100); // a constant +100/day slope — one regime
    const rc = regimeChange(curveFromDeltas(deltas));
    expect(rc.breakpointDate).toBe(null);
  });

  it('too few points → no break, NaN slopes, no throw', () => {
    const rc = regimeChange(curveFromDeltas([1, 2, 3]));
    expect(rc.breakpointDate).toBe(null);
    expect(Number.isNaN(rc.preSlope)).toBe(true);
  });

  it('reports BOTH an onset and a best-fit kink on a flat→losing→accelerating curve', () => {
    // A flat era, a dip to a trough, then an accelerating rise (the badatmath shape). The min-SSE kink is
    // dragged LATER by the accelerating tail; the causal onset (final trough crossing) sits at the trough.
    const deltas = [0, 0, 0, -50, -50, 30, 80, 160, 320, 640]; // trough at index 4 (cum −100)
    const curve = curveFromDeltas(deltas);
    const rc = regimeChange(curve);
    expect(rc.onsetDate).not.toBeNull();
    expect(rc.breakpointDate).not.toBeNull();
    // onset is the trough day (index 4) — the last day at/below the running minimum before the durable rise.
    expect(rc.onsetDate).toBe(curve[4]!.date);
    // the accelerating tail drags the min-SSE kink strictly LATER than the causal onset (the whole point).
    expect(rc.breakpointDate! >= rc.onsetDate!).toBe(true);
  });
});

describe('regimeOnset — causal final-trough-crossing onset estimator', () => {
  it('pins the onset to the trough day on a flat→trough→rising curve', () => {
    // trough at the cumulative minimum (index 4), then a durable rise that never returns to it.
    const deltas = [0, 0, -20, -30, -50, 40, 40, 40, 40]; // cum min at index 4 (−100)
    const curve = curveFromDeltas(deltas);
    expect(regimeOnset(curve)).toBe(curve[4]!.date);
  });

  it('is endpoint-stable: appending an accelerating tail does NOT move the onset', () => {
    const base = [0, 0, -20, -30, -50, 40, 40, 40]; // trough index 4
    const c1 = curveFromDeltas(base);
    const c2 = curveFromDeltas([...base, 200, 400, 800, 1600]); // a much steeper right edge
    expect(regimeOnset(c1)).toBe(c1[4]!.date);
    expect(regimeOnset(c2)).toBe(c2[4]!.date); // same trough day → same onset
  });

  it('matches the handoff badatmath curve onset (the trough day, week of the inflection)', () => {
    // The weekly ground-truth curve from WALLET-RECON-HANDOFF.md §2a anchored at the trough week 2026-05-02
    // (−$625) → rising thereafter and never returning below the trough.
    const weekly: { date: string; cum: number }[] = [
      { date: '2026-04-25', cum: -612 },
      { date: '2026-05-02', cum: -625 }, // ← trough
      { date: '2026-05-09', cum: -425 },
      { date: '2026-05-16', cum: 135 },
      { date: '2026-05-23', cum: 1146 },
      { date: '2026-05-30', cum: 2531 },
      { date: '2026-06-06', cum: 5329 },
    ];
    let prev = 0;
    const curve = weekly.map((w) => {
      const realizedUsd = w.cum - prev;
      prev = w.cum;
      return { date: w.date, realizedUsd, cumUsd: w.cum };
    });
    expect(regimeOnset(curve)).toBe('2026-05-02'); // the trough day — a few days before the §6 quick May 14–21
  });

  it('null when the curve never leaves its trough (monotone down) or too few points', () => {
    expect(regimeOnset(curveFromDeltas([0, -10, -20, -30, -40]))).toBe(null); // trough is the final point
    expect(regimeOnset(curveFromDeltas([1, 2]))).toBe(null); // too few points
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// reuse of stats.ts helpers
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('walletEdgeStats / winRateCi — reuse sim/stats', () => {
  it('feeds realized bets straight into armEdgeStats as GradedBets', () => {
    const bets = [mkBet(0.1, true, 10, 90), mkBet(0.1, false, 10, -10)];
    const s = walletEdgeStats(bets);
    expect(s.nGraded).toBe(2);
    expect(s.nWon).toBe(1);
    expect(s.avgAsk).toBeCloseTo(0.1, 6);
  });

  it('winRateCi gives a Wilson interval over the decisive bets', () => {
    const r = reconstructRealizedPnl(
      [
        buy('A', 'Yes', 100, 0.2, 0),
        redeem('A', 100, 1, 1), // winner
        buy('B', 'Yes', 100, 0.4, 0), // loser, no redeem
      ],
      { resolvedBefore: RESOLVED_BEFORE },
    );
    const ci = winRateCi(r);
    expect(ci.lo).toBeGreaterThanOrEqual(0);
    expect(ci.hi).toBeLessThanOrEqual(1);
    expect(ci.lo).toBeLessThan(ci.hi);
  });
});
