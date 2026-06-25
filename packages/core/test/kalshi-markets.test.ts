/**
 * Tests for core/kalshi/markets — the Kalshi venue parsers for the cross-venue measurement
 * (CROSS-VENUE-SPIKE.md). Built against the VERIFIED live KXHIGHNY shapes (2026-06-25): the strike →
 * integer-°F convention (between / greater+1 / less−1 — the load-bearing off-by-one for the 1°F bin
 * offset), the ticker date segment, the reciprocal order book (NO bids → YES asks), and the
 * pure/total guarantees.
 */
import { describe, expect, it } from 'vitest';
import {
  type KalshiRawMarket,
  kalshiStrikeSpan,
  kalshiTickerDate,
  parseKalshiBin,
  parseKalshiLadder,
  parseKalshiOrderbook,
} from '../src/kalshi/markets.ts';
import { impliedLadder } from '../src/sim/cross-venue-arb.ts';

// Verified live NYC ladder (2026-06-25).
const NYC_MARKETS: KalshiRawMarket[] = [
  { ticker: 'KXHIGHNY-26JUN25-T86', strike_type: 'greater', floor_strike: 86, yes_sub_title: '87° or above', yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0100', open_interest_fp: '2807.63' },
  { ticker: 'KXHIGHNY-26JUN25-T79', strike_type: 'less', cap_strike: 79, yes_sub_title: '78° or below', yes_bid_dollars: '0.0000', yes_ask_dollars: '0.0100', open_interest_fp: '2011.44' },
  { ticker: 'KXHIGHNY-26JUN25-B85.5', strike_type: 'between', floor_strike: 85, cap_strike: 86, yes_sub_title: '85° to 86°', yes_bid_dollars: '0.0200', yes_ask_dollars: '0.0300', open_interest_fp: '500' },
  { ticker: 'KXHIGHNY-26JUN25-B83.5', strike_type: 'between', floor_strike: 83, cap_strike: 84, yes_sub_title: '83° to 84°', yes_bid_dollars: '0.3100', yes_ask_dollars: '0.3500', open_interest_fp: '900' },
  { ticker: 'KXHIGHNY-26JUN25-B81.5', strike_type: 'between', floor_strike: 81, cap_strike: 82, yes_sub_title: '81° to 82°', yes_bid_dollars: '0.5800', yes_ask_dollars: '0.6200', open_interest_fp: '1200' },
  { ticker: 'KXHIGHNY-26JUN25-B79.5', strike_type: 'between', floor_strike: 79, cap_strike: 80, yes_sub_title: '79° to 80°', yes_bid_dollars: '0.1000', yes_ask_dollars: '0.1200', open_interest_fp: '700' },
];

describe('kalshiTickerDate', () => {
  it('parses the date segment to YYYY-MM-DD', () => {
    expect(kalshiTickerDate('KXHIGHNY-26JUN25-B83.5')).toBe('2026-06-25');
    expect(kalshiTickerDate('KXHIGHLAX-26JUL02-T99')).toBe('2026-07-02');
  });
  it('is total: junk → null', () => {
    expect(kalshiTickerDate('garbage')).toBeNull();
    expect(kalshiTickerDate(undefined)).toBeNull();
    expect(kalshiTickerDate('KXHIGHNY-26XXX25-B1')).toBeNull();
  });
});

describe('kalshiStrikeSpan — the verified integer-°F convention', () => {
  it('between → [floor, cap]', () => {
    expect(kalshiStrikeSpan({ strike_type: 'between', floor_strike: 83, cap_strike: 84 })).toEqual({ loF: 83, hiF: 84 });
  });
  it('greater → loF = floor + 1 (strictly above)', () => {
    expect(kalshiStrikeSpan({ strike_type: 'greater', floor_strike: 86 })).toEqual({ loF: 87, hiF: null });
  });
  it('less → hiF = cap − 1 (strictly below)', () => {
    expect(kalshiStrikeSpan({ strike_type: 'less', cap_strike: 79 })).toEqual({ loF: null, hiF: 78 });
  });
  it('falls back to the human subtitle when strike fields are absent', () => {
    expect(kalshiStrikeSpan({ yes_sub_title: '83° to 84°' })).toEqual({ loF: 83, hiF: 84 });
    expect(kalshiStrikeSpan({ yes_sub_title: '87° or above' })).toEqual({ loF: 87, hiF: null });
    expect(kalshiStrikeSpan({ yes_sub_title: '78° or below' })).toEqual({ loF: null, hiF: 78 });
  });
  it('is total: no strike, no subtitle → null', () => {
    expect(kalshiStrikeSpan({})).toBeNull();
  });
});

describe('parseKalshiBin', () => {
  it('maps a between market to a usable bin (0.00 quotes → null, not a fake 0 price)', () => {
    const bin = parseKalshiBin(NYC_MARKETS[4]!); // 81-82, 0.58/0.62
    expect(bin).not.toBeNull();
    expect(bin!.loF).toBe(81);
    expect(bin!.hiF).toBe(82);
    expect(bin!.yesAsk).toBeCloseTo(0.62, 9);
    expect(bin!.yesBid).toBeCloseTo(0.58, 9);
    expect(bin!.openInterest).toBe(1200);
  });
  it('treats a 0.00 bid as no quote (null), keeping a one-sided ask', () => {
    const bin = parseKalshiBin(NYC_MARKETS[0]!); // T86: bid 0.00, ask 0.01
    expect(bin!.yesBid).toBeNull();
    expect(bin!.yesAsk).toBeCloseTo(0.01, 9);
  });
});

describe('parseKalshiLadder — odd-start grid for one target date', () => {
  it('builds a sorted VenueLadder filtered to the target date', () => {
    const { ladder, bins, eventTicker } = parseKalshiLadder(NYC_MARKETS, 'nyc', '2026-06-25');
    expect(ladder.venue).toBe('kalshi');
    expect(bins.length).toBe(6);
    // sorted ascending by loF (the less-bin's loF is null → sorts first)
    expect(ladder.buckets[0]!.hiF).toBe(78);
    expect(ladder.buckets.map((b) => b.loF)).toEqual([null, 79, 81, 83, 85, 87]); // ODD-start
    expect(eventTicker).toBeDefined();
  });
  it('excludes markets from other dates', () => {
    const mixed = [...NYC_MARKETS, { ticker: 'KXHIGHNY-26JUN26-B81.5', strike_type: 'between', floor_strike: 81, cap_strike: 82, yes_ask_dollars: '0.50', yes_bid_dollars: '0.48' }];
    const { bins } = parseKalshiLadder(mixed, 'nyc', '2026-06-25');
    expect(bins.length).toBe(6); // the JUN26 market is excluded
  });
  it('feeds the engine: the implied ladder reconstructs a sane PMF centred ~82°F', () => {
    const { ladder } = parseKalshiLadder(NYC_MARKETS, 'nyc', '2026-06-25');
    const impl = impliedLadder(ladder);
    expect(impl.ok).toBe(true);
    expect(impl.meanF).toBeGreaterThan(80);
    expect(impl.meanF).toBeLessThan(84);
  });
  it('is total: junk payload → empty ladder', () => {
    expect(parseKalshiLadder(null, 'nyc', '2026-06-25').bins).toEqual([]);
    expect(parseKalshiLadder('nope', 'nyc', '2026-06-25').ladder.buckets).toEqual([]);
  });
});

describe('parseKalshiOrderbook — the reciprocal book (NO bids → YES asks)', () => {
  it('maps yes_dollars → YES bids (desc) and no_dollars → YES asks at 1−p (asc)', () => {
    const raw = {
      orderbook_fp: {
        yes_dollars: [['0.2400', '10.37'], ['0.2500', '23.00'], ['0.2600', '27.00']],
        no_dollars: [['0.5400', '50.00'], ['0.5500', '6.00'], ['0.7200', '33.74']],
      },
    };
    const { yesBids, yesAsks } = parseKalshiOrderbook(raw);
    expect(yesBids[0]).toEqual({ price: 0.26, size: 27 }); // highest YES bid first
    // best YES ask = 1 − highest NO bid (0.72) = 0.28
    expect(yesAsks[0]!.price).toBeCloseTo(0.28, 9);
    expect(yesAsks[0]!.size).toBe(33.74);
    expect(yesAsks[yesAsks.length - 1]!.price).toBeCloseTo(0.46, 9); // 1 − 0.54
  });
  it('is total: junk → empty ladders', () => {
    expect(parseKalshiOrderbook(null)).toEqual({ yesBids: [], yesAsks: [] });
    expect(parseKalshiOrderbook({ orderbook_fp: {} })).toEqual({ yesBids: [], yesAsks: [] });
  });
});
