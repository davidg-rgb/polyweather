/**
 * Tests for the arb-depth-capture pure helpers (pure.ts) — the WALL-TIME-BOUNDING selection logic
 * that is the load-bearing fix for the prior arb timeout. Node/vitest; pure.ts imports only core.
 * (Code-review finding: this guard previously shipped with zero regression coverage.)
 */
import { describe, expect, it } from 'vitest';
import type { NormalizedBook, ParsedEvent, RawGammaEvent } from '../../../packages/core/src/index.ts';
import {
  buildPerLegDepth,
  CAPTURE_SUM_ASK_MAX,
  computeLeadDays,
  MAX_DEEP_CAPTURES,
  type RawAndParsed,
  selectDeepCandidates,
} from './pure.ts';

const NOW = new Date('2026-06-25T06:00:00Z');

/** Minimal ladder: N buckets each quoting bestAsk (bestBid just below), at a targetDate. */
function ladder(bestAsks: number[], targetDate: string, slug = 'l'): RawAndParsed {
  const buckets = bestAsks.map((a) => ({ bestAsk: a, bestBid: Math.max(a - 0.02, 0), tokenYes: 't' }));
  return {
    raw: {} as RawGammaEvent,
    parsed: { slug, targetDate, buckets } as unknown as ParsedEvent,
  };
}

const book = (asks: Array<{ price: number; size: number }>): NormalizedBook =>
  ({ asks, bids: [] }) as unknown as NormalizedBook;

describe('computeLeadDays', () => {
  it('is positive for a future target, sub-1 for today, negative for the past', () => {
    expect(computeLeadDays('2026-06-26', NOW)).toBeGreaterThan(1); // ~1.75
    expect(computeLeadDays('2026-06-26', NOW)).toBeLessThan(2);
    const today = computeLeadDays('2026-06-25', NOW);
    expect(today).toBeGreaterThan(0);
    expect(today).toBeLessThan(1);
    expect(computeLeadDays('2026-06-23', NOW)).toBeLessThan(0);
  });
});

describe('selectDeepCandidates (the wall-time bound)', () => {
  it('drops ladders with fewer than 3 buckets', () => {
    const out = selectDeepCandidates([ladder([0.3, 0.3], '2026-06-26')], NOW);
    expect(out).toHaveLength(0);
  });

  it('drops ladders whose lead exceeds MAX_LEAD_DAYS (≈2d)', () => {
    const out = selectDeepCandidates([ladder([0.3, 0.3, 0.3], '2026-06-30')], NOW); // lead ~5.7d
    expect(out).toHaveLength(0);
  });

  it('keeps only thin candidates (Σask ≤ CAPTURE_SUM_ASK_MAX) and sorts ascending by Σask', () => {
    const out = selectDeepCandidates(
      [
        ladder([0.4, 0.4, 0.4], '2026-06-26', 'thick'), // Σ=1.2 → dropped
        ladder([0.33, 0.33, 0.34], '2026-06-26', 'mid'), // Σ=1.0 → kept
        ladder([0.3, 0.3, 0.3], '2026-06-26', 'thin'), // Σ=0.9 → kept, lowest
      ],
      NOW,
    );
    expect(out).toHaveLength(2);
    expect(out[0]!.ev.parsed.slug).toBe('thin'); // ascending Σask
    expect(out[0]!.topSumAsk).toBeCloseTo(0.9, 9);
    expect(out[1]!.ev.parsed.slug).toBe('mid');
  });

  it('treats CAPTURE_SUM_ASK_MAX as inclusive (1.02 kept, 1.03 dropped)', () => {
    expect(CAPTURE_SUM_ASK_MAX).toBe(1.02);
    const atBound = selectDeepCandidates([ladder([0.34, 0.34, 0.34], '2026-06-26')], NOW); // Σ=1.02
    expect(atBound).toHaveLength(1);
    const overBound = selectDeepCandidates([ladder([0.35, 0.34, 0.34], '2026-06-26')], NOW); // Σ=1.03
    expect(overBound).toHaveLength(0);
  });

  it('caps the deep-capture set at MAX_DEEP_CAPTURES', () => {
    const many = Array.from({ length: MAX_DEEP_CAPTURES + 5 }, (_, i) =>
      ladder([0.3, 0.3, 0.3], '2026-06-26', `l${i}`),
    );
    expect(selectDeepCandidates(many, NOW)).toHaveLength(MAX_DEEP_CAPTURES);
  });
});

describe('buildPerLegDepth', () => {
  it('summarises top-of-book + total ask depth per leg, in bucket order', () => {
    const out = buildPerLegDepth([
      book([{ price: 0.3, size: 100 }, { price: 0.31, size: 50 }]),
      book([{ price: 0.5, size: 20 }]),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ bucketIdx: 0, topPrice: 0.3, topSize: 100, totalSize: 150 });
    expect(out[1]).toEqual({ bucketIdx: 1, topPrice: 0.5, topSize: 20, totalSize: 20 });
  });

  it('handles an empty ask side (the reachable branch): null top, zero total', () => {
    const out = buildPerLegDepth([book([])]);
    expect(out[0]).toEqual({ bucketIdx: 0, topPrice: null, topSize: null, totalSize: 0 });
  });
});
