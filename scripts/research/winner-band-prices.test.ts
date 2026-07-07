import { describe, expect, it } from 'vitest';
import { priceStats, quantile, winnerBand, winnerIdx, type EventFile } from './winner-band-prices.ts';

const ev: EventFile = {
  city: 'testville',
  eventId: '1',
  targetDate: '2026-01-01',
  endDate: '2026-01-02T00:00:00Z',
  buckets: [
    { idx: 0, label: '≤10', resolvedOutcome: 'lose', points: [[100, 0.5], [200, 0.3]] },
    { idx: 1, label: '11', resolvedOutcome: 'lose', points: [[100, 0.4], [200, 0.6]] },
    { idx: 2, label: '12', resolvedOutcome: 'win', points: [[100, 0.1], [200, 0.2], [300, 0.9]] },
    { idx: 3, label: '13', resolvedOutcome: 'lose', points: [[100, 0.2], [200, 0.1]] },
    { idx: 4, label: '14', resolvedOutcome: 'lose', points: [] },
  ],
};

describe('winnerIdx', () => {
  it('finds the winning bucket idx', () => {
    expect(winnerIdx(ev.buckets)).toBe(2);
  });
  it('returns null for an unresolved event', () => {
    expect(winnerIdx(ev.buckets.map((b) => ({ ...b, resolvedOutcome: null })))).toBeNull();
  });
});

describe('priceStats', () => {
  it('computes min/max with their timestamps, first/last, mean, std', () => {
    const s = priceStats(ev.buckets[2]!.points)!;
    expect(s.n).toBe(3);
    expect(s.minP).toBeCloseTo(0.1, 10);
    expect(s.tAtMin).toBe(100);
    expect(s.maxP).toBeCloseTo(0.9, 10);
    expect(s.tAtMax).toBe(300);
    expect(s.firstP).toBeCloseTo(0.1, 10);
    expect(s.lastP).toBeCloseTo(0.9, 10);
    expect(s.meanP).toBeCloseTo(0.4, 10); // (0.1+0.2+0.9)/3
    expect(s.stdP).toBeCloseTo(Math.sqrt((0.01 + 0.04 + 0.81) / 3 - 0.16), 10);
  });
  it('returns null when there are no points', () => {
    expect(priceStats([])).toBeNull();
  });
  it('keeps a valid tAtMin/tAtMax even when prices never move', () => {
    const s = priceStats([[500, 0.42], [600, 0.42]])!;
    expect(s.minP).toBeCloseTo(0.42, 10);
    expect(s.maxP).toBeCloseTo(0.42, 10);
    expect(s.tAtMin).toBe(500);
    expect(s.stdP).toBeCloseTo(0, 10);
  });
});

describe('winnerBand', () => {
  it('returns the winner ±half neighbours that exist, flags the winner, and nulls empty buckets', () => {
    const band = winnerBand(ev, 2)!;
    expect(band.winnerIdx).toBe(2);
    expect(band.winnerLabel).toBe('12');
    expect(band.rows.map((r) => r.offset)).toEqual([-2, -1, 0, 1, 2]);
    const winRow = band.rows.find((r) => r.offset === 0)!;
    expect(winRow.isWinner).toBe(true);
    expect(winRow.bucketIdx).toBe(2);
    const plus2 = band.rows.find((r) => r.offset === 2)!; // idx 4 has no points
    expect(plus2.stats).toBeNull();
  });
  it('honours a smaller half-width', () => {
    const band = winnerBand(ev, 1)!;
    expect(band.rows.map((r) => r.bucketIdx)).toEqual([1, 2, 3]);
  });
  it('clamps at the low edge when the winner is bucket 0 (no negative neighbours)', () => {
    const edge: EventFile = { ...ev, buckets: ev.buckets.map((b, i) => ({ ...b, resolvedOutcome: i === 0 ? 'win' : 'lose' })) };
    const band = winnerBand(edge, 2)!;
    expect(band.rows.map((r) => r.offset)).toEqual([0, 1, 2]);
  });
  it('returns null for an unresolved event', () => {
    const open: EventFile = { ...ev, buckets: ev.buckets.map((b) => ({ ...b, resolvedOutcome: null })) };
    expect(winnerBand(open, 2)).toBeNull();
  });
});

describe('quantile', () => {
  it('interpolates like a linear percentile', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([10, 20, 30], 0)).toBe(10);
    expect(quantile([10, 20, 30], 1)).toBe(30);
    expect(quantile([], 0.5)).toBeNaN();
  });
});
