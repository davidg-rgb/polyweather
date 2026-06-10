import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyLiquidityFilters, computeBucketEdges, executableAsk } from '../src/edge.ts';
import { minEdgeRequired, takerFeePerShare } from '../src/fees.ts';
import type { BucketDef, EdgeConfig, NormalizedBook } from '../src/types.ts';

const cfg: EdgeConfig = {
  uncertaintyMargin: 0.05,
  spreadBufferMin: 0.01,
  feeRate: 0.05,
  probeStakeUsd: 20,
  maxSpread: 0.05,
  minEventVolumeUsd: 2000,
  minHoursBeforeClose: 2,
};

/** Minimal raw→normalized for the fixture: numbers + best-first (raw last = best). */
function loadFixtureBook(): NormalizedBook {
  const raw = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', '..', 'research', 'clob-book-nyc-94-95f.json'), 'utf8'),
  ) as {
    market: string; asset_id: string; timestamp: string; hash: string;
    bids: { price: string; size: string }[]; asks: { price: string; size: string }[];
    min_order_size: string; tick_size: string; neg_risk: boolean; last_trade_price: string;
  };
  const lvl = (l: { price: string; size: string }) => ({ price: Number(l.price), size: Number(l.size) });
  return {
    market: raw.market,
    assetId: raw.asset_id,
    timestamp: Number(raw.timestamp),
    hash: raw.hash,
    bids: raw.bids.map(lvl).reverse(),
    asks: raw.asks.map(lvl).reverse(),
    minOrderSize: Number(raw.min_order_size),
    tickSize: Number(raw.tick_size),
    negRisk: raw.neg_risk,
    lastTradePrice: Number(raw.last_trade_price),
  };
}

function syntheticBook(asks: [number, number][]): NormalizedBook {
  return {
    market: 'm', assetId: 'a', timestamp: 0, hash: 'h',
    bids: [], asks: asks.map(([price, size]) => ({ price, size })),
    minOrderSize: 5, tickSize: 0.01, negRisk: true, lastTradePrice: null,
  };
}

const bucket: BucketDef = { low: 94, high: 95, unit: 'F' };

describe('executableAsk (§6.7)', () => {
  const book = loadFixtureBook();

  it('research CLOB fixture: best ask is the normalized first level (0.36 × 13.4)', () => {
    expect(book.asks[0]).toEqual({ price: 0.36, size: 13.4 });
    const { avgPrice, fillableShares } = executableAsk(book, 5);
    expect(avgPrice).toBeCloseTo(0.36, 12);
    expect(fillableShares).toBe(5);
  });

  it('walks depth across levels for 30 shares: 13.4@0.36 + 12.86@0.37 + 3.74@0.38', () => {
    const { avgPrice, fillableShares } = executableAsk(book, 30);
    expect(fillableShares).toBe(30);
    expect(avgPrice).toBeCloseTo((13.4 * 0.36 + 12.86 * 0.37 + 3.74 * 0.38) / 30, 12);
    expect(avgPrice).toBeCloseTo(0.36678, 5);
  });

  it('signals insufficient depth: fillableShares < requested on an oversized walk', () => {
    const totalDepth = book.asks.reduce((a, l) => a + l.size, 0);
    const { avgPrice, fillableShares } = executableAsk(book, totalDepth + 1000);
    expect(fillableShares).toBeCloseTo(totalDepth, 9);
    const totalCost = book.asks.reduce((a, l) => a + l.size * l.price, 0);
    expect(avgPrice).toBeCloseTo(totalCost / totalDepth, 12);
  });

  it('empty asks → 0 fillable with NaN price', () => {
    const { avgPrice, fillableShares } = executableAsk(syntheticBook([]), 10);
    expect(fillableShares).toBe(0);
    expect(Number.isNaN(avgPrice)).toBe(true);
  });
});

describe('computeBucketEdges (§6.7)', () => {
  it('edge math: q − execAsk, fee from the MARKET feeRate, spread carried, pass on big edge', () => {
    const book = syntheticBook([[0.3, 1000]]);
    const rows = computeBucketEdges([0.45], [bucket], [book], [{ feeRate: 0.05, spread: 0.02 }], cfg);
    const row = rows[0]!;
    expect(row.execAsk).toBeCloseTo(0.3, 12);
    expect(row.edge).toBeCloseTo(0.15, 12);
    expect(row.feePerShare).toBeCloseTo(takerFeePerShare(0.3, 0.05), 12);
    expect(row.spread).toBe(0.02);
    expect(row.minEdge).toBeCloseTo(minEdgeRequired(0.3, 0.02, cfg), 12);
    expect(row.pass).toBe(true);
    expect(row.reasons).toEqual([]);
  });

  it('per-market feeRate overrides cfg.feeRate in both fee and threshold', () => {
    const book = syntheticBook([[0.3, 1000]]);
    const [zeroFee] = computeBucketEdges([0.4], [bucket], [book], [{ feeRate: 0, spread: null }], cfg);
    const [withFee] = computeBucketEdges([0.4], [bucket], [book], [{ feeRate: 0.05, spread: null }], cfg);
    expect(zeroFee!.feePerShare).toBe(0);
    expect(withFee!.feePerShare).toBeGreaterThan(0);
    expect(zeroFee!.minEdge!).toBeLessThan(withFee!.minEdge!);
  });

  it('reasons[] populated per failed criterion', () => {
    const thin = syntheticBook([[0.4, 2]]); // 2 shares << probe target
    const rows = computeBucketEdges(
      [0.41, 0.5, 0.5],
      [bucket, bucket, bucket],
      [thin, null, syntheticBook([])],
      [
        { feeRate: 0.05, spread: 0.01 },
        { feeRate: 0.05, spread: null },
        { feeRate: 0.05, spread: null },
      ],
      cfg,
    );
    expect(rows[0]!.reasons).toEqual(['insufficient_depth', 'edge_below_min']);
    expect(rows[0]!.pass).toBe(false);
    expect(rows[1]!.reasons).toEqual(['no_book']);
    expect(rows[2]!.reasons).toEqual(['no_ask_depth']);
  });

  it('null spread uses the buffer floor in minEdge', () => {
    const book = syntheticBook([[0.3, 1000]]);
    const [row] = computeBucketEdges([0.45], [bucket], [book], [{ feeRate: 0.05, spread: null }], cfg);
    expect(row!.minEdge).toBeCloseTo(minEdgeRequired(0.3, 0, cfg), 12);
  });
});

describe('applyLiquidityFilters (§6.7) — each veto individually', () => {
  const book = syntheticBook([[0.3, 1000]]);
  const passing = computeBucketEdges([0.45], [bucket], [book], [{ feeRate: 0.05, spread: 0.02 }], cfg)[0]!;
  const goodEv = {
    volume24h: 5000,
    secondsToLocalMidnight: 10 * 3600,
    stationVerified: true,
    halted: false,
  };

  it('passes a liquid, verified, unhalted event', () => {
    const row = applyLiquidityFilters(passing, goodEv, cfg);
    expect(row.pass).toBe(true);
    expect(row.reasons).toEqual([]);
  });

  it.each([
    ['volume_below_min', { ...goodEv, volume24h: 1999 }],
    ['too_close_to_resolution', { ...goodEv, secondsToLocalMidnight: 2 * 3600 - 1 }],
    ['station_unverified', { ...goodEv, stationVerified: false }],
    ['halted', { ...goodEv, halted: true }],
  ] as const)('vetoes %s', (reason, ev) => {
    const row = applyLiquidityFilters(passing, ev, cfg);
    expect(row.pass).toBe(false);
    expect(row.reasons).toEqual([reason]);
  });

  it('vetoes spread_above_max from the row spread', () => {
    const wide = { ...passing, spread: 0.06 };
    const row = applyLiquidityFilters(wide, goodEv, cfg);
    expect(row.pass).toBe(false);
    expect(row.reasons).toEqual(['spread_above_max']);
  });

  it('volume at exactly the threshold passes (veto is strict <)', () => {
    expect(applyLiquidityFilters(passing, { ...goodEv, volume24h: 2000 }, cfg).pass).toBe(true);
  });

  it('does not mutate the input row', () => {
    const before = JSON.stringify(passing);
    applyLiquidityFilters(passing, { ...goodEv, halted: true }, cfg);
    expect(JSON.stringify(passing)).toBe(before);
  });
});
