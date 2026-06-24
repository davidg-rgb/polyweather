/**
 * Tests for scripts/reward-snapshot — the pure near-mid-depth reducer (Phase A time-series logger).
 * toSnapshotRow turns one market's live book into the competition-denominator row (depth shares + USD
 * within max_spread, each side). Pure — no network, no fs.
 */
import { describe, expect, it } from 'vitest';
import { toSnapshotRow } from './reward-snapshot.ts';
import type { MarketRewardInputs } from '../packages/core/src/sim/reward-farming.ts';

const mkt = (over: Partial<MarketRewardInputs> = {}): MarketRewardInputs => ({
  conditionId: 'c1',
  slug: 's',
  dailyPoolUsd: 20,
  maxSpreadCents: 4.5,
  minSize: 50,
  bestBid: 0.1,
  bestAsk: 0.13,
  bids: [
    { price: 0.1, size: 100 }, // 1.5c from mid 0.115 → in band
    { price: 0.05, size: 999 }, // 6.5c away → out of band
  ],
  asks: [{ price: 0.13, size: 200 }], // 1.5c from mid → in band
  ...over,
});

describe('toSnapshotRow', () => {
  it('sums only in-band depth (within max_spread of mid), each side', () => {
    const r = toSnapshotRow(mkt(), '2026-06-24T00:00:00Z');
    expect(r.mid).toBeCloseTo(0.115, 9);
    expect(r.bidDepthShares).toBe(100); // the 0.05 order is out of band
    expect(r.askDepthShares).toBe(200);
    expect(r.bidDepthUsd).toBeCloseTo(100 * 0.1, 9);
    expect(r.askDepthUsd).toBeCloseTo(200 * (1 - 0.13), 9);
    expect(r.capturedUtc).toBe('2026-06-24T00:00:00Z');
  });

  it('handles a market with no usable book (null mid, depth 0)', () => {
    // mid is derived from the book itself (reduceBookDepth) — an empty book ⇒ null mid + zero depth.
    const r = toSnapshotRow(mkt({ bestBid: null, bestAsk: null, bids: [], asks: [] }), 't');
    expect(r.mid).toBeNull();
    expect(r.bidDepthShares).toBe(0);
    expect(r.askDepthUsd).toBe(0);
  });
});
