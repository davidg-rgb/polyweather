/**
 * Tests for the sharps-snapshot pure helpers (the /sharps fingerprint logic, migration 0059).
 * The Edge handler is a thin HTTP wrapper around these pure functions; only type-only imports remain
 * in handler.ts, so these are importable + testable in Node/vitest. Mirrors reward-snapshot.test.ts.
 *
 * The headline assertion (SPORTS-TRADERS.md §1): sweepFraction is the SAME-SECOND book-sweep signature
 * (the live-bot fingerprint), NOT a price-band proxy.
 */
import { describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  inferSport,
  type ParsedTrade,
  parseLeaders,
  parseTrades,
} from './handler.ts';

const buy = (over: Partial<ParsedTrade> = {}): ParsedTrade => ({
  side: 'BUY',
  price: 0.5,
  sizeShares: 100,
  notionalUsd: 50,
  timestamp: 0,
  outcome: 'Yes',
  slug: 'soccer-x',
  ...over,
});

describe('parseLeaders', () => {
  it('parses valid rows and computes a null-safe ROI proxy', () => {
    const out = parseLeaders([
      { rank: 1, proxyWallet: '0xaaa', userName: 'swisstony', pnl: 1000, vol: 100000 },
      { rank: 2, proxyWallet: '0xbbb', userName: '', pnl: 50, vol: 0 }, // vol=0 → roi 0, name falls back to wallet
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ rank: 1, wallet: '0xaaa', traderName: 'swisstony', pnlAllUsd: 1000 });
    expect(out[0]!.roiProxy).toBeCloseTo(0.01, 9);
    expect(out[1]!.traderName).toBe('0xbbb'); // empty userName → wallet
    expect(out[1]!.roiProxy).toBe(0); // vol=0 guarded
  });

  it('skips rows with no usable wallet, and a non-array payload', () => {
    expect(parseLeaders([{ proxyWallet: '' }, { pnl: 5 }, null])).toHaveLength(0);
    expect(parseLeaders({ not: 'an array' })).toHaveLength(0);
  });
});

describe('parseTrades', () => {
  it('parses, computes notional, defaults side to BUY, and skips incomplete rows', () => {
    const out = parseTrades([
      { side: 'buy', price: '0.4', size: '100', timestamp: '1700', outcome: 'Yes', slug: 's1' },
      { side: 'SELL', price: 0.6, size: 50, timestamp: 1800 },
      { price: 0.5, size: 10 }, // no timestamp → skipped
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ side: 'BUY', price: 0.4, sizeShares: 100, timestamp: 1700 });
    expect(out[0]!.notionalUsd).toBeCloseTo(40, 9);
    expect(out[1]!.side).toBe('SELL');
  });
});

describe('inferSport', () => {
  it('keyword-matches the major sports and falls back to other', () => {
    expect(inferSport('epl-arsenal-soccer')).toBe('soccer');
    expect(inferSport('nba-lakers-game')).toBe('basketball');
    expect(inferSport('wimbledon-tennis')).toBe('tennis');
    expect(inferSport('some-politics-market')).toBe('other');
  });
});

describe('computeFingerprint', () => {
  it('sweepFraction is the same-second burst fraction (not a price band)', () => {
    // 3 buys share ts=100 (a burst), 1 buy at ts=200 (solo) → 3/4 in a burst.
    const fp = computeFingerprint(
      [
        buy({ price: 0.1, notionalUsd: 10, timestamp: 100, slug: 'epl-soccer' }),
        buy({ price: 0.4, notionalUsd: 40, timestamp: 100, slug: 'nba-game' }),
        buy({ price: 0.5, notionalUsd: 50, timestamp: 100, slug: 'soccer-ucl' }),
        buy({ price: 0.9, notionalUsd: 90, timestamp: 200, slug: 'tennis-x' }),
      ],
      0.01,
    );
    expect(fp.nFills).toBe(4);
    expect(fp.sweepFraction).toBeCloseTo(0.75, 9);
    expect(fp.midOddsFraction).toBeCloseTo(0.5, 9); // 0.40 + 0.50 in [0.35, 0.65]
    expect(fp.vwapEntry).toBeCloseTo(123 / 190, 9); // notional-weighted
  });

  it('excludes SELLs and out-of-range (≤0 / ≥1) prices from the fill set', () => {
    const fp = computeFingerprint(
      [buy({ price: 0.5 }), buy({ side: 'SELL', price: 0.5 }), buy({ price: 1 }), buy({ price: 0 })],
      0.5,
    );
    expect(fp.nFills).toBe(1);
  });

  it('builds the odds histogram and the by-notional sub-sport mix', () => {
    const fp = computeFingerprint(
      [
        buy({ price: 0.1, notionalUsd: 10, slug: 'epl-soccer' }),
        buy({ price: 0.9, notionalUsd: 90, slug: 'tennis-x' }),
      ],
      0.5,
    );
    const top = fp.oddsHistogram.find((b) => b.label === '>85¢')!;
    expect(top.count).toBe(1);
    expect(top.notionalUsd).toBeCloseTo(90, 9);
    expect(fp.sportsMix.soccer).toBeCloseTo(0.1, 9); // 10 / 100
    expect(fp.sportsMix.tennis).toBeCloseTo(0.9, 9);
  });

  it('archetype: high fill count + low ROI → volume-machine, else high-roi-specialist', () => {
    const many = Array.from({ length: 60 }, (_, i) => buy({ timestamp: i }));
    expect(computeFingerprint(many, 0.01).archetype).toBe('volume-machine');
    expect(computeFingerprint(many, 0.5).archetype).toBe('high-roi-specialist'); // high ROI
    expect(computeFingerprint([buy()], 0.01).archetype).toBe('high-roi-specialist'); // too few fills
  });

  it('empty fill set yields a zeroed fingerprint (no NaN)', () => {
    const fp = computeFingerprint([], 0);
    expect(fp.nFills).toBe(0);
    expect(fp.sweepFraction).toBe(0);
    expect(fp.midOddsFraction).toBe(0);
    expect(fp.vwapEntry).toBe(0);
    expect(fp.sportsMix).toEqual({});
  });
});
