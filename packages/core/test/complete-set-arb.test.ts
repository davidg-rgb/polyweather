/**
 * Tests for core/sim/complete-set-arb — the structural (forecast-free) complete-set arbitrage and
 * the fee-wall measurement (COMPLETE-SET-ARB.md, the 8th signal). Covers: the top-of-book edge math
 * (under/over net of the per-leg taker fee, the NO=1−bid symmetry), the raw-vs-net distinction (the
 * fee wall), the contemporaneity gate (the stale-quote trap), depth-limited executable profit
 * (under + over duals), the scan summary, the frozen economic verdict (PASS/MARGINAL/FAIL), and the
 * pure/total guarantees (junk → null/zeroed, never throws).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIN_FEE_CLEARED_FRAC,
  FEE_RATE_WEATHER,
  MAX_STALE_MIN,
  type ArbScanSummary,
  type BookLevel,
  type CompleteSetEdge,
  completeSetArbVerdict,
  completeSetEdge,
  executableArb,
  isContemporaneous,
  overroundExecutable,
  summarizeScan,
  underroundExecutable,
} from '../src/sim/complete-set-arb.ts';
import { takerFeePerShare } from '../src/fees.ts';

// ── top-of-book edge math ────────────────────────────────────────────────────────────────────────

describe('completeSetEdge — the riskless identity, net of the taker fee', () => {
  it('detects a genuine UNDERROUND (Σask<1) clearing the fee', () => {
    // a freshly-opened thin book like Wuhan: Σask = 0.77 ≪ 1 − fee
    const asks = [0.1, 0.2, 0.2, 0.18, 0.02, 0.02, 0.011, 0.011, 0.004, 0.004, 0.01];
    const bids = asks.map((a) => a - 0.005);
    const e = completeSetEdge(asks, bids);
    const sumAsk = asks.reduce((s, a) => s + a, 0);
    expect(e.sumAsk).toBeCloseTo(sumAsk, 9);
    expect(e.rawUnder).toBeCloseTo(1 - sumAsk, 9);
    expect(e.underNet!).toBeCloseTo(1 - sumAsk - e.feeYesTotal, 9);
    expect(e.underNet!).toBeGreaterThan(0); // 0.77 set → ~+20% net
    expect(e.side).toBe('under');
    expect(e.bestNet).toBe(e.underNet);
  });

  it('a mature book straddling $1 from above is NOT an arb (efficient overround)', () => {
    // Σask ≈ 1.07 (NYC-like): no underround; bids sum < 1: no overround.
    const asks = [0.021, 0.05, 0.19, 0.34, 0.35, 0.13, 0.031, 0.004, 0.004, 0.003, 0.001];
    const bids = [0.02, 0.033, 0.18, 0.33, 0.33, 0.1, 0.022, 0.002, 0.001, 0.001, 0.0005];
    const e = completeSetEdge(asks, bids);
    expect(e.sumAsk!).toBeGreaterThan(1);
    expect(e.underNet!).toBeLessThan(0);
    expect(e.overNet!).toBeLessThan(0);
    expect(e.side).toBe('none');
    expect(e.bestNet).toBeLessThanOrEqual(0);
  });

  it('THE FEE WALL: Σask just below 1 but the per-leg taker fee erases it', () => {
    // chengdu-like: raw underround positive but sub-fee → net negative.
    const asks = [0.09, 0.18, 0.2, 0.18, 0.1, 0.05, 0.03, 0.02, 0.01, 0.01, 0.012]; // Σ=0.882
    const e = completeSetEdge(asks, asks.map((a) => a - 0.005));
    expect(e.rawUnder!).toBeGreaterThan(0); // book IS internally cheap pre-fee
    // construct the razor case where raw>0 but raw < fee
    const tight = [0.2, 0.2, 0.2, 0.2, 0.19]; // Σ=0.99 → raw +0.01
    const te = completeSetEdge(tight, tight.map((a) => a - 0.005));
    expect(te.rawUnder!).toBeCloseTo(0.01, 9);
    expect(te.feeYesTotal).toBeGreaterThan(0.01); // fee on 5 mid-priced legs > 1¢
    expect(te.underNet!).toBeLessThan(0); // fee wall
    expect(te.side).toBe('none');
  });

  it('OVERROUND uses the NO=1−bid symmetry: feeNoTotal == Σ takerFee(bid)', () => {
    const bids = [0.4, 0.45, 0.3]; // Σbid = 1.15 > 1 → raw overround +0.15
    const asks = bids.map((b) => b + 0.02);
    const e = completeSetEdge(asks, bids);
    const expectFee = bids.reduce((s, b) => s + takerFeePerShare(b, FEE_RATE_WEATHER), 0);
    expect(e.feeNoTotal).toBeCloseTo(expectFee, 12);
    expect(e.rawOver!).toBeCloseTo(0.15, 9);
    expect(e.overNet!).toBeCloseTo(0.15 - expectFee, 9);
    expect(e.overNet!).toBeGreaterThan(0); // 15% raw clears the ~3 mid-leg fee
    expect(e.side).toBe('over');
  });

  it('an incomplete side (a null/degenerate leg) drops that side, never throws', () => {
    const e = completeSetEdge([0.2, null, 0.3], [0.1, 0.1, 0.1]);
    expect(e.completeAsk).toBe(false);
    expect(e.sumAsk).toBeNull();
    expect(e.underNet).toBeNull();
    expect(e.completeBid).toBe(true);
    // junk inputs → no throw, side 'none'
    expect(() => completeSetEdge([], [])).not.toThrow();
    expect(completeSetEdge([], []).side).toBe('none');
    expect(completeSetEdge(null as never, undefined as never).bestNet).toBe(-1);
  });

  it('respects a custom fee rate (0 fee → raw == net)', () => {
    const asks = [0.2, 0.2, 0.2, 0.19];
    const e = completeSetEdge(asks, asks.map((a) => a - 0.01), 0);
    expect(e.feeYesTotal).toBe(0);
    expect(e.underNet).toBeCloseTo(e.rawUnder!, 12); // no wall when fee=0
    expect(e.underNet!).toBeGreaterThan(0);
  });
});

// ── the contemporaneity gate (the stale-quote trap) ───────────────────────────────────────────────

describe('isContemporaneous — guards the Karachi stale-ghost trap', () => {
  it('accepts an all-fresh set and rejects any stale leg', () => {
    expect(isContemporaneous([0, 5, 9, 4.9, 5])).toBe(true);
    expect(isContemporaneous([5, 270, 4, 0])).toBe(false); // a 4.5h-stale ghost leg
    expect(MAX_STALE_MIN).toBe(30);
    expect(isContemporaneous([20, 25, 29])).toBe(true);
    expect(isContemporaneous([20, 25, 31])).toBe(false);
  });
  it('total on junk: empty / negative / NaN → false', () => {
    expect(isContemporaneous([])).toBe(false);
    expect(isContemporaneous(null as never)).toBe(false);
    expect(isContemporaneous([-1, 2])).toBe(false);
    expect(isContemporaneous([NaN, 2])).toBe(false);
  });
});

// ── depth-limited executable profit ───────────────────────────────────────────────────────────────

describe('executable arb — the capacity question (real book depth)', () => {
  it('UNDERROUND: profit scales with the thinnest leg, fees walk the ladder', () => {
    // 3-leg set, each leg one ask level of 100 shares; Σ best ask = 0.6 → +0.4/set gross.
    const ladders: BookLevel[][] = [
      [{ price: 0.2, size: 100 }],
      [{ price: 0.2, size: 100 }],
      [{ price: 0.2, size: 50 }], // thinnest leg caps at 50 sets
    ];
    const ex = underroundExecutable(ladders);
    expect(ex.sets).toBe(50);
    const fee = 50 * 3 * takerFeePerShare(0.2, FEE_RATE_WEATHER);
    expect(ex.costUsd).toBeCloseTo(50 * 0.6 + fee, 9);
    expect(ex.profitUsd).toBeCloseTo(50 * 1 - 50 * 0.6 - fee, 9); // 50 sets * ($1 - $0.6) - fee
    expect(ex.profitUsd).toBeGreaterThan(0);
  });

  it('UNDERROUND: deeper sets cost more as the book is eaten — picks the profit max', () => {
    // cheap thin top (Σ=0.2/set) then a dear deep level where the legs sum to 1.15/set (loss-making):
    // profit must peak at the 10-share top and NOT chase the deep level.
    const ladders: BookLevel[][] = [
      [{ price: 0.1, size: 10 }, { price: 0.95, size: 1000 }],
      [{ price: 0.1, size: 10 }, { price: 0.2, size: 1000 }], // deep Σ = 0.95+0.20 = 1.15 > $1
    ];
    const ex = underroundExecutable(ladders);
    expect(ex.sets).toBe(10);
    expect(ex.profitUsd).toBeGreaterThan(0);
  });

  it('no executable arb when depth is absent or a leg is empty', () => {
    expect(underroundExecutable([]).profitUsd).toBe(0);
    expect(underroundExecutable([[{ price: 0.2, size: 5 }], []]).sets).toBe(0); // one empty leg
    expect(executableArb(null as never, 1).profitUsd).toBe(0);
  });

  it('OVERROUND: derives NO ask = 1 − YES bid and pays $(N−1) per set', () => {
    // 3 buckets, each YES bid 0.4 (size 100) → NO ask 0.6; complete NO set redeems to $2.
    const bidLadders: BookLevel[][] = [
      [{ price: 0.4, size: 100 }],
      [{ price: 0.4, size: 100 }],
      [{ price: 0.4, size: 100 }],
    ];
    const ex = overroundExecutable(bidLadders);
    // cost/set = 3 NO * 0.6 = 1.8; payout $(3-1)=$2 → +0.2/set gross minus fee.
    expect(ex.sets).toBe(100);
    const fee = 100 * 3 * takerFeePerShare(0.6, FEE_RATE_WEATHER); // == fee at 0.4 by symmetry
    expect(ex.profitUsd).toBeCloseTo(100 * 2 - 100 * 1.8 - fee, 6);
    expect(ex.profitUsd).toBeGreaterThan(0);
  });
});

// ── scan summary + frozen verdict ─────────────────────────────────────────────────────────────────

const mkEdge = (asks: number[], bids: number[]): CompleteSetEdge => completeSetEdge(asks, bids);

describe('summarizeScan + completeSetArbVerdict — the frozen economic criterion', () => {
  it('separates RAW dislocations from FEE-cleared ones (the wall, quantified)', () => {
    const edges: CompleteSetEdge[] = [
      mkEdge([0.2, 0.2, 0.2, 0.19], [0.18, 0.18, 0.18, 0.17]), // Σask 0.79 raw+ AND fee-cleared
      mkEdge([0.2, 0.2, 0.2, 0.405], [0.18, 0.18, 0.18, 0.38]), // Σask 1.005 raw-
      mkEdge([0.2, 0.2, 0.2, 0.397], [0.18, 0.18, 0.18, 0.37]), // Σask 0.997 raw+ but sub-fee → not cleared
    ];
    const s = summarizeScan(edges);
    expect(s.instants).toBe(3);
    expect(s.underRawBelow1).toBe(2); // two have Σask<1
    expect(s.underFeeCleared).toBe(1); // only the deep one clears the fee
    expect(s.bestUnderNet).toBeGreaterThan(0);
  });

  it('FAIL when nothing clears the fee (fee-walled)', () => {
    const summary: ArbScanSummary = {
      instants: 43781,
      underRawBelow1: 1755,
      overRawAbove1: 5172,
      underFeeCleared: 0,
      overFeeCleared: 0,
      bestUnderNet: -0.01,
      bestOverNet: -0.02,
      meanUnderNet: -0.15,
    };
    const v = completeSetArbVerdict(summary);
    expect(v.label).toBe('FAIL');
    expect(v.rawFrac).toBeGreaterThan(0.1); // raw inefficiency is real…
    expect(v.feeClearedFrac).toBe(0); // …but fully fee-walled
  });

  it('MARGINAL when a tiny outlier-dominated fraction clears (the real history)', () => {
    const summary: ArbScanSummary = {
      instants: 43781,
      underRawBelow1: 1755,
      overRawAbove1: 5172,
      underFeeCleared: 161,
      overFeeCleared: 25,
      bestUnderNet: 0.2082,
      bestOverNet: 0.0235,
      meanUnderNet: -0.1522,
    };
    const v = completeSetArbVerdict(summary);
    expect(v.label).toBe('MARGINAL'); // 186/43781 = 0.42% < 2% bar
    expect(v.feeClearedFrac).toBeCloseTo(186 / 43781, 6);
  });

  it('PASS only above the standing-inefficiency bar', () => {
    const summary: ArbScanSummary = {
      instants: 1000,
      underRawBelow1: 400,
      overRawAbove1: 100,
      underFeeCleared: 50, // 5% ≥ 2% bar
      overFeeCleared: 0,
      bestUnderNet: 0.05,
      bestOverNet: -0.01,
      meanUnderNet: 0.01,
    };
    expect(completeSetArbVerdict(summary).label).toBe('PASS');
    expect(DEFAULT_MIN_FEE_CLEARED_FRAC).toBe(0.02);
  });

  it('total on empty input', () => {
    expect(summarizeScan([]).instants).toBe(0);
    expect(summarizeScan(null as never).instants).toBe(0);
    const v = completeSetArbVerdict(summarizeScan([]));
    expect(v.label).toBe('FAIL');
  });
});
