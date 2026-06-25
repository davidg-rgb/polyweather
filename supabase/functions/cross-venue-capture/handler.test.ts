/**
 * Tests for the cross-venue-capture pure helpers (pure.ts) — the venue→ladder transforms + the
 * engine-driven capture-row assembly. Node/vitest; pure.ts imports only @weather-edge/core.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedEvent } from '../../../packages/core/src/index.ts';
import {
  buildCaptureRow,
  executableLegSpecs,
  isOverlapEvent,
  leadDays,
  parseKalshiLadder,
  polyLadderFromEvent,
} from './pure.ts';
import type { CrossVenueEdge } from '../../../packages/core/src/sim/cross-venue-arb.ts';

const NOW = new Date('2026-06-25T12:00:00Z');

/** Build a minimal ParsedEvent: even-start Polymarket buckets [low, high, bid, ask] + 24h volume. */
function polyEvent(
  citySlug: string,
  targetDate: string,
  buckets: Array<[number | null, number | null, number, number]>,
  opts: { kind?: 'highest' | 'lowest'; unit?: 'F' | 'C'; vol?: number } = {},
): ParsedEvent {
  return {
    slug: `highest-temperature-in-${citySlug}-on-x`,
    citySlug,
    targetDate,
    unit: opts.unit ?? 'F',
    kind: opts.kind ?? 'highest',
    buckets: buckets.map(([low, high, bid, ask]) => ({
      def: { low, high, unit: opts.unit ?? 'F' },
      tokenYes: `yes-${low}`,
      tokenNo: `no-${low}`,
      bestBid: bid,
      bestAsk: ask,
      volume24h: opts.vol ?? 5000,
    })),
  } as unknown as ParsedEvent;
}

// A Polymarket NYC ladder concentrated on ~82°F (even-start grid), matching the live shape.
const NYC_POLY = (): ParsedEvent =>
  polyEvent('nyc', '2026-06-25', [
    [null, 79, 0.01, 0.02],
    [80, 81, 0.15, 0.17],
    [82, 83, 0.58, 0.6],
    [84, 85, 0.2, 0.21],
    [86, 87, 0.028, 0.04],
    [88, null, 0.004, 0.009],
  ]);

// The verified Kalshi NYC markets (odd-start grid), same ~82°F day.
const NYC_KALSHI_MARKETS = [
  { ticker: 'KXHIGHNY-26JUN25-T79', strike_type: 'less', cap_strike: 79, yes_bid_dollars: '0.00', yes_ask_dollars: '0.01', open_interest_fp: '2000' },
  { ticker: 'KXHIGHNY-26JUN25-B79.5', strike_type: 'between', floor_strike: 79, cap_strike: 80, yes_bid_dollars: '0.10', yes_ask_dollars: '0.12', open_interest_fp: '700' },
  { ticker: 'KXHIGHNY-26JUN25-B81.5', strike_type: 'between', floor_strike: 81, cap_strike: 82, yes_bid_dollars: '0.58', yes_ask_dollars: '0.62', open_interest_fp: '1200' },
  { ticker: 'KXHIGHNY-26JUN25-B83.5', strike_type: 'between', floor_strike: 83, cap_strike: 84, yes_bid_dollars: '0.31', yes_ask_dollars: '0.35', open_interest_fp: '900' },
  { ticker: 'KXHIGHNY-26JUN25-B85.5', strike_type: 'between', floor_strike: 85, cap_strike: 86, yes_bid_dollars: '0.02', yes_ask_dollars: '0.03', open_interest_fp: '500' },
  { ticker: 'KXHIGHNY-26JUN25-T86', strike_type: 'greater', floor_strike: 86, yes_bid_dollars: '0.00', yes_ask_dollars: '0.01', open_interest_fp: '2800' },
];

describe('leadDays', () => {
  it('is sub-1 for today, >1 for tomorrow, negative for the past', () => {
    const today = leadDays('2026-06-25', NOW);
    expect(today).toBeGreaterThan(0);
    expect(today).toBeLessThan(1);
    expect(leadDays('2026-06-26', NOW)).toBeGreaterThan(1);
    expect(leadDays('2026-06-23', NOW)).toBeLessThan(0);
  });
});

describe('isOverlapEvent', () => {
  it('accepts a near-dated highest °F event for a Kalshi-covered city', () => {
    expect(isOverlapEvent(NYC_POLY(), NOW)).toBe(true);
  });
  it('rejects a non-overlap city, a lowest event, a °C event, and a far date', () => {
    expect(isOverlapEvent(polyEvent('london', '2026-06-25', [[80, 81, 0.5, 0.5]]), NOW)).toBe(false);
    expect(isOverlapEvent(polyEvent('nyc', '2026-06-25', [[80, 81, 0.5, 0.5]], { kind: 'lowest' }), NOW)).toBe(false);
    expect(isOverlapEvent(polyEvent('nyc', '2026-06-25', [[80, 81, 0.5, 0.5]], { unit: 'C' }), NOW)).toBe(false);
    expect(isOverlapEvent(polyEvent('nyc', '2026-07-15', [[80, 81, 0.5, 0.5]]), NOW)).toBe(false);
  });
});

describe('polyLadderFromEvent', () => {
  it('maps BucketDef [low, high] → [loF, hiF] (null tails) + top-of-book + the volume depth proxy', () => {
    const ladder = polyLadderFromEvent(NYC_POLY());
    expect(ladder.venue).toBe('polymarket');
    expect(ladder.buckets.map((b) => b.loF)).toEqual([null, 80, 82, 84, 86, 88]); // EVEN-start
    expect(ladder.buckets[2]).toMatchObject({ loF: 82, hiF: 83, yesAsk: 0.6, yesBid: 0.58 });
    expect(ladder.buckets[2]!.topAskSize).toBe(5000);
  });
});

describe('buildCaptureRow (the engine plumbing — math owned by cross-venue-arb.test.ts)', () => {
  it('assembles a complete, well-formed row + the engine edge from a matched (poly, kalshi) pair', () => {
    const { ladder: kalshi } = parseKalshiLadder(NYC_KALSHI_MARKETS, 'nyc', '2026-06-25');
    const out = buildCaptureRow('nyc', '2026-06-25', polyLadderFromEvent(NYC_POLY()), kalshi, NOW.toISOString());
    expect(out).not.toBeNull();
    const { row, edge } = out!;
    expect(row.city).toBe('nyc');
    expect(row.targetDate).toBe('2026-06-25');
    expect(row.polyNBuckets).toBeGreaterThan(3);
    expect(row.kalshiNBuckets).toBeGreaterThan(3);
    // every numeric engine output flows through finite (never NaN — the recorder's nullif relies on it)
    for (const v of [row.polyMeanF, row.kalshiMeanF, row.meanDiffF, row.maxAbsGap, row.bestNetEdge, row.cashflow, row.expPayoff, row.limitDepth]) {
      expect(Number.isFinite(v as number)).toBe(true);
    }
    // both venues centre on ~82°F → a small implied-mean difference
    expect(Math.abs(row.meanDiffF!)).toBeLessThan(3);
    expect(['buyPolySellKalshi', 'buyKalshiSellPoly', 'none']).toContain(row.direction);
    expect(typeof row.netPositive).toBe('boolean');
    expect(typeof row.hasRealDepth).toBe('boolean');
    // executability is NOT set by the pure layer — it is the handler's both-book depth walk
    expect(row.execSize).toBeNull();
    expect(row.isExecutable).toBe(false);
    // the edge carries the legs the handler walks
    expect(Array.isArray(edge.buyLegsLoF)).toBe(true);
    expect(Array.isArray(edge.sellLegsLoF)).toBe(true);
  });

  it('returns null when one venue has no usable quotes', () => {
    const { ladder: kalshi } = parseKalshiLadder(NYC_KALSHI_MARKETS, 'nyc', '2026-06-25');
    const empty = { venue: 'polymarket' as const, buckets: [] };
    expect(buildCaptureRow('nyc', '2026-06-25', empty, kalshi, NOW.toISOString())).toBeNull();
  });
});

describe('executableLegSpecs — engine leg loFs → concrete (ticker/token, side) for the depth walk', () => {
  it('maps Kalshi buy legs → tickers (ask) and Polymarket sell legs → tokens (bid)', () => {
    const { bins } = parseKalshiLadder(NYC_KALSHI_MARKETS, 'nyc', '2026-06-25');
    // long Kalshi YES≥83 (bins 83,85,87) ; short Poly YES≥82 (buckets 82,84,86,88)
    const edge = {
      direction: 'buyKalshiSellPoly', atF: 83,
      buyVenue: 'kalshi', sellVenue: 'polymarket',
      buyLegsLoF: [83, 85, 87], sellLegsLoF: [82, 84, 86, 88],
    } as unknown as CrossVenueEdge;
    const { buyLegs, sellLegs } = executableLegSpecs(NYC_POLY(), bins, edge);
    expect(buyLegs.every((l) => l.venue === 'kalshi' && l.side === 'ask' && l.id !== '')).toBe(true);
    expect(buyLegs.map((l) => l.id)).toEqual(['KXHIGHNY-26JUN25-B83.5', 'KXHIGHNY-26JUN25-B85.5', 'KXHIGHNY-26JUN25-T86']);
    expect(sellLegs.every((l) => l.venue === 'polymarket' && l.side === 'bid')).toBe(true);
    expect(sellLegs.map((l) => l.id)).toEqual(['yes-82', 'yes-84', 'yes-86', 'yes-88']);
  });

  it('preserves an unmappable leg as id:"" (size 0 downstream — never silently dropped)', () => {
    const { bins } = parseKalshiLadder(NYC_KALSHI_MARKETS, 'nyc', '2026-06-25');
    const edge = {
      buyVenue: 'kalshi', sellVenue: 'polymarket', buyLegsLoF: [999], sellLegsLoF: [],
    } as unknown as CrossVenueEdge;
    const { buyLegs } = executableLegSpecs(NYC_POLY(), bins, edge);
    expect(buyLegs).toHaveLength(1);
    expect(buyLegs[0]!.id).toBe('');
  });
});
