/**
 * Tests for depth-capture/pure — the executable-depth walk that is the ONE thing this job adds over poll-markets.
 * Node/vitest. Exercises the exec-price DIVERGENCE from best_ask (the job's raison d'être), partial fills, empty +
 * one-sided books (the two-sided gate, finding E), non-default perPositionUsd (finding H), and the delta/heartbeat
 * write gate (finding C) — the coverage v1's single full-fill fixture lacked (finding I-1).
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedBook } from '../../../packages/core/src/index.ts';
import { computeDepth, isTwoSided, shouldWrite } from './pure.ts';

/** A NormalizedBook (best-first both sides) from best-first [price,size] level lists. */
function book(asks: Array<[number, number]>, bids: Array<[number, number]>): NormalizedBook {
  return {
    market: '', assetId: '', timestamp: 0, hash: '', minOrderSize: 0, tickSize: 0, negRisk: false,
    lastTradePrice: null,
    asks: asks.map(([price, size]) => ({ price, size })),
    bids: bids.map(([price, size]) => ({ price, size })),
  };
}

describe('computeDepth — exec-price walk + two-sided gate', () => {
  it('full-fill deep book: execAsk == best_ask, execBid == best_bid, top-of-book + depth carried', () => {
    const d = computeDepth(book([[0.11, 2000], [0.12, 1000]], [[0.1, 2000], [0.095, 500]]), 20)!;
    expect(d).not.toBeNull();
    expect(d.best_ask).toBeCloseTo(0.11, 6);
    expect(d.best_bid).toBeCloseTo(0.1, 6);
    expect(d.mid).toBeCloseTo(0.105, 6);
    expect(d.spread).toBeCloseTo(0.01, 6);
    // a $20 (~182-share) buy fills entirely at the 2000-share best level → execAsk == best_ask.
    expect(d.exec_ask).toBeCloseTo(0.11, 6);
    expect(d.exec_bid).toBeCloseTo(0.1, 6);
    // depthUsd = asks within +10% of 0.11 (≤0.121): 0.11×2000 + 0.12×1000 = 340;
    // sellback = bids ≥ 0.10×0.9 (0.09): 0.10×2000 + 0.095×500 = 247.5.
    expect(d.depth_usd).toBeCloseTo(340, 6);
    expect(d.sellback_depth_usd).toBeCloseTo(247.5, 6);
    expect(d.sellback_usd).toBeCloseTo(200, 6);
  });

  it('THIN book: execAsk DIVERGES above best_ask (walks into L2) — the job’s whole reason for existing', () => {
    // best level holds only 50 shares; a ~182-share $20 buy walks into 0.14 → avg > 0.11.
    const d = computeDepth(book([[0.11, 50], [0.14, 2000]], [[0.1, 2000]]), 20)!;
    expect(d.best_ask).toBeCloseTo(0.11, 6);
    expect(d.exec_ask!).toBeGreaterThan(0.11); // diverges from top-of-book — substituting best_ask would be optimistic
  });

  it('PARTIAL fill: too-thin book still emits the avg over what filled (finding I-a documented behavior)', () => {
    // total book depth (80 shares) < the ~182-share target → avg over 80, still finite, still > best_ask.
    const d = computeDepth(book([[0.11, 50], [0.14, 30]], [[0.1, 2000]]), 20)!;
    expect(d.exec_ask).not.toBeNull();
    expect(d.exec_ask!).toBeCloseTo((50 * 0.11 + 30 * 0.14) / 80, 6); // 0.12125
    expect(d.exec_ask!).toBeGreaterThan(0.11);
  });

  it('EMPTY book (fetchable, both sides empty) → null (no row) — the two-sided gate', () => {
    expect(computeDepth(book([], []), 20)).toBeNull();
  });

  it('ONE-SIDED asks-only book → null (finding E: no bid ⇒ no exit ⇒ never entered)', () => {
    expect(computeDepth(book([[0.11, 100]], []), 20)).toBeNull();
  });

  it('ONE-SIDED bids-only book → null', () => {
    expect(computeDepth(book([], [[0.1, 100]]), 20)).toBeNull();
  });

  it('degenerate (0,1) quote → null (the no-real-book sentinel)', () => {
    expect(computeDepth(book([[1, 100]], [[0, 100]]), 20)).toBeNull();
  });

  it('perPositionUsd changes the walk — a bigger size walks deeper into the book (finding H)', () => {
    const b = book([[0.11, 100], [0.2, 2000]], [[0.1, 5000]]);
    const small = computeDepth(b, 20)!;   // ~182 shares: 100@0.11 + ~82@0.20
    const large = computeDepth(b, 150)!;  // ~1363 shares: 100@0.11 + rest@0.20 → deeper, higher avg
    expect(large.exec_ask!).toBeGreaterThan(small.exec_ask!);
  });
});

describe('isTwoSided', () => {
  it('requires both sides present and rejects the (0,1) sentinel', () => {
    expect(isTwoSided(0.1, 0.11)).toBe(true);
    expect(isTwoSided(null, 0.11)).toBe(false);
    expect(isTwoSided(0.1, null)).toBe(false);
    expect(isTwoSided(0, 1)).toBe(false);
  });
});

describe('shouldWrite — delta / heartbeat / first-observation gate (finding C)', () => {
  const NOW = new Date('2026-07-08T12:00:00Z').getTime();
  const row = (ask: number | null, bid: number | null) =>
    ({ best_bid: bid, best_ask: ask, mid: null, spread: null, exec_ask: ask, exec_bid: bid,
       depth_usd: 0, sellback_depth_usd: 0, sellback_usd: 0 });
  const DELTA = 0.005;
  const HB = 30 * 60_000;

  it('first observation (no prior row) → write', () => {
    expect(shouldWrite(row(0.11, 0.1), { exec_ask: null, exec_bid: null, captured_at: null }, NOW, DELTA, HB)).toBe(true);
  });

  it('unchanged within heartbeat → deduped (no write)', () => {
    const last = { exec_ask: 0.11, exec_bid: 0.1, captured_at: new Date(NOW - 60_000).toISOString() };
    expect(shouldWrite(row(0.11, 0.1), last, NOW, DELTA, HB)).toBe(false);
  });

  it('exec_ask moved ≥ delta within heartbeat → write', () => {
    const last = { exec_ask: 0.11, exec_bid: 0.1, captured_at: new Date(NOW - 60_000).toISOString() };
    expect(shouldWrite(row(0.12, 0.1), last, NOW, DELTA, HB)).toBe(true);
  });

  it('exec_bid moved ≥ delta within heartbeat → write (TP-relevant convergence is captured)', () => {
    const last = { exec_ask: 0.11, exec_bid: 0.1, captured_at: new Date(NOW - 60_000).toISOString() };
    expect(shouldWrite(row(0.11, 0.13), last, NOW, DELTA, HB)).toBe(true);
  });

  it('unchanged but past the heartbeat → write (periodic trajectory anchor)', () => {
    const last = { exec_ask: 0.11, exec_bid: 0.1, captured_at: new Date(NOW - HB - 1).toISOString() };
    expect(shouldWrite(row(0.11, 0.1), last, NOW, DELTA, HB)).toBe(true);
  });

  it('an unparseable stored timestamp → write (fail-open, never silently stuck)', () => {
    const last = { exec_ask: 0.11, exec_bid: 0.1, captured_at: 'not-a-date' };
    expect(shouldWrite(row(0.11, 0.1), last, NOW, DELTA, HB)).toBe(true);
  });

  it('coerces a string-typed stored numeric (PostgREST returns numeric as string)', () => {
    const last = { exec_ask: '0.11' as unknown as number, exec_bid: '0.10' as unknown as number,
                   captured_at: new Date(NOW - 60_000).toISOString() };
    expect(shouldWrite(row(0.11, 0.1), last, NOW, DELTA, HB)).toBe(false); // within delta despite string types
    expect(shouldWrite(row(0.13, 0.1), last, NOW, DELTA, HB)).toBe(true);
  });
});
