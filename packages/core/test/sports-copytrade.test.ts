/**
 * Tests for core/sim/sports-copytrade — the SPORTS copy-trade analytics that feed the tested
 * sim/copy-trade.ts mirror. Covers the categoriser, CLOB-history→snapshot construction, resolution from
 * a settled price, the fill-aligned drift curve (the "when does the move happen" signature), the trader
 * fingerprint, and an end-to-end flow through simulateMirror (the reuse contract).
 */
import { describe, expect, it } from 'vitest';
import type { PricePoint } from '../src/polymarket/clob.ts';
import { copyTradeVerdict, simulateMirror } from '../src/sim/copy-trade.ts';
import {
  alignDriftCurve,
  buildSnapshotsFromHistory,
  categorizeMarket,
  priceAtOrBefore,
  resolveOutcomeFromHistory,
  sharpOwnEdge,
  sportsSubcategory,
  toMirrorFill,
  traderFingerprint,
  type FingerprintFill,
  type SportsFillInput,
} from '../src/sim/sports-copytrade.ts';

describe('categorizeMarket', () => {
  it('tags real Polymarket sports titles as sports', () => {
    expect(categorizeMarket('Will IR Iran win on 2026-06-15?', 'fifwc-irn-nzl-2026-06-15-irn')).toBe('sports');
    expect(categorizeMarket('Lakers vs. Celtics', 'nba-lal-bos')).toBe('sports');
    expect(categorizeMarket('Chiefs spread: -3.5', 'nfl-kc')).toBe('sports');
  });
  it('separates non-sports categories', () => {
    expect(categorizeMarket('Highest temperature in NYC on June 20')).toBe('weather');
    expect(categorizeMarket('Bitcoin above $100k by Friday')).toBe('crypto');
    expect(categorizeMarket('Will Trump win the nomination')).toBe('politics');
    expect(categorizeMarket('June CPI above 3%')).toBe('macro');
    expect(categorizeMarket('Some unrelated event')).toBe('other');
  });
  it('is total on empty/garbage input', () => {
    expect(categorizeMarket('', '')).toBe('other');
    expect(categorizeMarket(undefined as unknown as string)).toBe('other');
  });
});

describe('sportsSubcategory', () => {
  it('buckets common sports', () => {
    expect(sportsSubcategory('Will IR Iran win', 'fifwc-irn-nzl')).toBe('soccer');
    expect(sportsSubcategory('NBA Finals: Celtics')).toBe('basketball');
    expect(sportsSubcategory('NFL Week 1: Chiefs')).toBe('football');
    expect(sportsSubcategory('UFC 300 main event')).toBe('mma');
    expect(sportsSubcategory('Monaco Grand Prix winner')).toBe('motorsport');
    expect(sportsSubcategory('Dota 2 TI final')).toBe('esports');
    expect(sportsSubcategory('Something curling related')).toBe('other-sport');
  });
});

describe('buildSnapshotsFromHistory', () => {
  const hist: PricePoint[] = [
    { t: 100, p: 0.4 },
    { t: 160, p: 0.45 },
    { t: 220, p: 0.99 },
  ];
  it('maps mid=p and ask=p (no haircut)', () => {
    const snaps = buildSnapshotsFromHistory(hist);
    expect(snaps).toHaveLength(3);
    expect(snaps[0]).toEqual({ capturedAt: 100, bid: 0.4, ask: 0.4, mid: 0.4 });
  });
  it('applies the spread haircut to the ask and clamps to ≤1', () => {
    const snaps = buildSnapshotsFromHistory(hist, { spreadHaircut: 0.02 });
    expect(snaps[0]!.ask).toBeCloseTo(0.42, 10);
    expect(snaps[0]!.mid).toBe(0.4); // mid unaffected
    expect(snaps[2]!.ask).toBe(1); // 0.99 + 0.02 clamps to 1
  });
  it('is total on an empty history', () => {
    expect(buildSnapshotsFromHistory([])).toEqual([]);
  });
});

describe('resolveOutcomeFromHistory', () => {
  it('reads a settled-to-1 series as a win', () => {
    expect(resolveOutcomeFromHistory([{ t: 1, p: 0.5 }, { t: 2, p: 0.9995 }])).toBe(true);
  });
  it('reads a settled-to-0 series as a loss', () => {
    expect(resolveOutcomeFromHistory([{ t: 1, p: 0.5 }, { t: 2, p: 0.002 }])).toBe(false);
  });
  it('refuses to grade an unsettled (mid-band) series', () => {
    expect(resolveOutcomeFromHistory([{ t: 1, p: 0.5 }, { t: 2, p: 0.55 }])).toBeNull();
  });
  it('is total on empty', () => {
    expect(resolveOutcomeFromHistory([])).toBeNull();
  });
});

describe('toMirrorFill', () => {
  const fill: SportsFillInput = {
    conditionId: '0xabc',
    asset: 'tok1',
    fillPrice: 0.5,
    sizeShares: 1000,
    usdcSize: 500,
    timestamp: 1000,
    history: [
      { t: 940, p: 0.5 },
      { t: 1060, p: 0.52 },
      { t: 2000, p: 0.99 },
    ],
    feeRate: 0.05,
  };
  it('always sets outcome=Yes (the sign trick) and resolves from the bought token series', () => {
    const mf = toMirrorFill(fill);
    expect(mf.outcome).toBe('Yes');
    expect(mf.outcomeWon).toBe(true); // last price 0.99 → the bought leg won
    expect(mf.snapshots).toHaveLength(3);
    expect(mf.fillPrice).toBe(0.5);
  });
  it('threads the spread haircut into the snapshot asks', () => {
    const mf = toMirrorFill(fill, { spreadHaircut: 0.03 });
    expect(mf.snapshots[0]!.ask).toBeCloseTo(0.53, 10);
  });
  it('prefers an explicit authoritative outcomeWon over the price-tail heuristic', () => {
    // history settles to 0.99 (heuristic → won), but the authoritative flag says LOST → trust the flag.
    expect(toMirrorFill({ ...fill, outcomeWon: false }).outcomeWon).toBe(false);
    // explicit null forces "unresolved" even though the tail is extreme.
    expect(toMirrorFill({ ...fill, outcomeWon: null }).outcomeWon).toBeNull();
    // undefined (default) falls back to the tail heuristic (won).
    expect(toMirrorFill(fill).outcomeWon).toBe(true);
  });
});

describe('priceAtOrBefore', () => {
  const hist: PricePoint[] = [
    { t: 100, p: 0.4 },
    { t: 200, p: 0.5 },
    { t: 300, p: 0.6 },
  ];
  it('returns the last point at-or-before t', () => {
    expect(priceAtOrBefore(hist, 250)).toBe(0.5);
    expect(priceAtOrBefore(hist, 300)).toBe(0.6);
  });
  it('returns null before the first point', () => {
    expect(priceAtOrBefore(hist, 50)).toBeNull();
  });
});

describe('alignDriftCurve', () => {
  // Two fills at t=1000, both with a flat-then-jump path: flat ~0.48 until +360s, then jumps to ~0.7.
  // This is the "move comes AFTER the fill" signature — the curve should be ~0 early and strongly positive late.
  const mkPath = (): PricePoint[] => [
    { t: 700, p: 0.5 },
    { t: 1000, p: 0.48 },
    { t: 1300, p: 0.48 },
    { t: 1420, p: 0.7 },
    { t: 1900, p: 0.72 },
  ];
  const fills = [
    { timestamp: 1000, history: mkPath() },
    { timestamp: 1000, history: mkPath() },
  ];
  it('shows ~flat early drift and a positive late jump relative to the fill', () => {
    const curve = alignDriftCurve(fills, [-300, 0, 60, 300, 600, 900]);
    const at = (o: number) => curve.find((c) => c.offsetSec === o)!;
    expect(at(0).meanDeltaFromFill).toBeCloseTo(0, 10); // delta from fill at t=0 is 0
    expect(at(300).meanDeltaFromFill).toBeCloseTo(0, 10); // still flat at +5min (0.48 - 0.48)
    expect(at(600).meanDeltaFromFill).toBeCloseTo(0.22, 10); // jumped (0.70 - 0.48)
    expect(at(600).n).toBe(2);
  });
  it('drops fills with no usable sample at an offset (total)', () => {
    const curve = alignDriftCurve([{ timestamp: 1000, history: [{ t: 1000, p: 0.5 }] }], [-300, 0]);
    expect(curve.find((c) => c.offsetSec === -300)!.n).toBe(0);
    expect(curve.find((c) => c.offsetSec === -300)!.meanDeltaFromFill).toBeNaN();
  });
});

describe('traderFingerprint', () => {
  const fills: FingerprintFill[] = [
    // a same-second sweep of a soccer market at 0.50 (the mintblade pattern)
    { title: 'Will IR Iran win on 2026-06-15?', slug: 'fifwc-irn', side: 'BUY', price: 0.5, notionalUsd: 100000, timestamp: 1000, won: true },
    { title: 'Will IR Iran win on 2026-06-15?', slug: 'fifwc-irn', side: 'BUY', price: 0.5, notionalUsd: 5000, timestamp: 1000, won: true },
    // an NBA cheap longshot, unrelated market, unresolved
    { title: 'NBA Lakers', slug: 'nba-lal', side: 'BUY', price: 0.15, notionalUsd: 8000, timestamp: 50000, won: null },
    // a crypto bet that lost
    { title: 'Bitcoin above 100k', slug: 'btc', side: 'BUY', price: 0.6, notionalUsd: 12000, timestamp: 99999, won: false },
  ];
  const fp = traderFingerprint(fills, { burstWindowSec: 120 });

  it('summarises notional + buy fraction', () => {
    expect(fp.nFills).toBe(4);
    expect(fp.totalNotionalUsd).toBe(125000);
    expect(fp.buyFraction).toBe(1);
  });
  it('detects the same-second sweep', () => {
    expect(fp.sweepFraction).toBeCloseTo(0.5, 10); // the two 0.50 fills are a same-market burst
  });
  it('computes category + sports mix by notional', () => {
    // soccer 105k, basketball 8k of sports (113k); crypto 12k. sports share = 113/125.
    expect(fp.categoryMix.sports).toBeCloseTo(113000 / 125000, 6);
    expect(fp.categoryMix.crypto).toBeCloseTo(12000 / 125000, 6);
    expect(fp.sportsMix.soccer!).toBeCloseTo(105000 / 113000, 6);
    expect(fp.sportsMix.basketball!).toBeCloseTo(8000 / 113000, 6);
  });
  it('grades only the resolved subset for win rate + edge over implied', () => {
    // resolved: two wins at 0.5, one loss at 0.6 → 2/3 win rate; implied mean = (0.5+0.5+0.6)/3.
    expect(fp.resolved.n).toBe(3);
    expect(fp.resolved.winRate).toBeCloseTo(2 / 3, 6);
    expect(fp.resolved.meanImpliedProb).toBeCloseTo((0.5 + 0.5 + 0.6) / 3, 6);
    expect(fp.resolved.edgeOverImplied).toBeCloseTo(2 / 3 - (1.6 / 3), 6);
  });
  it('is total on empty input', () => {
    const z = traderFingerprint([]);
    expect(z.nFills).toBe(0);
    expect(z.resolved.winRate).toBeNaN();
  });
});

describe('sharpOwnEdge', () => {
  it("grades the sharp's own resolved BUYs (won, ask=fillPrice)", () => {
    const fills: FingerprintFill[] = [
      { title: 'a', slug: 'a', side: 'BUY', price: 0.5, notionalUsd: 1, timestamp: 1, won: true },
      { title: 'b', slug: 'b', side: 'BUY', price: 0.5, notionalUsd: 1, timestamp: 2, won: false },
      { title: 'c', slug: 'c', side: 'SELL', price: 0.5, notionalUsd: 1, timestamp: 3, won: true }, // excluded (SELL)
    ];
    const edge = sharpOwnEdge(fills);
    expect(edge.nGraded).toBe(2);
    expect(edge.hitRate).toBeCloseTo(0.5, 10);
  });
});

describe('end-to-end: toMirrorFill → simulateMirror (the reuse contract)', () => {
  // A winning fill at 0.5 whose price drifts up only AFTER a 5-min lag — a follower entering at +5min
  // (lag default 300s) should still get a usable, gradeable entry through the reused engine.
  const fills: SportsFillInput[] = Array.from({ length: 8 }, (_, i) => ({
    conditionId: `0x${i}`,
    asset: `tok${i}`,
    fillPrice: 0.5,
    sizeShares: 1000,
    usdcSize: 500,
    timestamp: 1000,
    history: [
      { t: 1000, p: 0.5 },
      { t: 1320, p: 0.5 }, // still 0.5 at +320s (just after the 300s lag) — follower entry point
      { t: 2000, p: 0.98 }, // resolves to a win
    ],
    feeRate: 0.05,
  }));
  it('produces a scored report + a pre-registered verdict', () => {
    const mirror = fills.map((f) => toMirrorFill(f, { spreadHaircut: 0.01 }));
    const report = simulateMirror(mirror, { cheapMaxPrice: 0.99, detectionLagSec: 300, maxEntryStalenessSec: 3600 });
    expect(report.nUsable).toBeGreaterThan(0);
    expect(report.sharpGross.nGraded).toBe(report.nUsable);
    const verdict = copyTradeVerdict(report);
    expect(typeof verdict.pass).toBe('boolean');
    expect(verdict.summary).toMatch(/follower fee-net EV/);
  });
});
