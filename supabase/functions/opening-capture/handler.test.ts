/**
 * Tests for the opening-capture pure helpers (pure.ts) — the capture-row assembly + flat-open flagging +
 * the BY-LABEL-IDENTITY houseProb alignment (W6). Node/vitest; pure.ts imports only @weather-edge/core.
 * (The impure handler's seed/walk/record path is exercised end-to-end by the migration-0066 PGlite twin +
 * live prod verification — mirroring how cross-venue-capture tests its pure.ts here.)
 */
import { describe, expect, it } from 'vitest';
import type { ParsedEvent } from '../../../packages/core/src/index.ts';
import { BOT_DEFAULTS } from '../../../packages/core/src/sim/opening-convergence.ts';
import { bucketMid, buildOpeningCaptureRow, hoursSinceListing, type BucketDepth } from './pure.ts';

const NOW = new Date('2026-06-27T06:10:00Z');

/** A minimal flat-open ParsedEvent: every °C bucket ~10–12% (uninformed book). Buckets: [low, high, bid, ask]. */
function flatOpenEvent(
  citySlug: string,
  targetDate: string,
  buckets: Array<[number | null, number | null, number, number]>,
  opts: { createdAt?: string | null; negRisk?: boolean; vol?: number } = {},
): ParsedEvent {
  return {
    slug: `highest-temperature-in-${citySlug}-on-jun-28-2026`,
    citySlug,
    targetDate,
    unit: 'C',
    station: { icao: 'EHAM', countryCode: 'NL' },
    negRiskMarketId: opts.negRisk === false ? null : 'neg-risk-1',
    createdAt: opts.createdAt === undefined ? '2026-06-27T05:40:00Z' : opts.createdAt,
    kind: 'highest',
    eventVolume24h: opts.vol ?? 9000,
    liquidity: 5000,
    acceptingOrders: true,
    ladderProblems: [],
    buckets: buckets.map(([low, high, bid, ask], i) => ({
      marketId: `m-${i}`,
      conditionId: `cond-${i}`,
      label: low == null ? `<${high! + 1}°C` : high == null ? `>${low - 1}°C` : `${low}-${high}°C`,
      def: { low, high, unit: 'C' },
      tokenYes: `yes-${i}`,
      tokenNo: `no-${i}`,
      bestBid: bid,
      bestAsk: ask,
    })),
  } as unknown as ParsedEvent;
}

const AMS = (): ParsedEvent =>
  flatOpenEvent('amsterdam', '2026-06-28', [
    [null, 28, 0.1, 0.12],
    [29, 29, 0.1, 0.12],
    [30, 30, 0.11, 0.13],
    [31, 31, 0.1, 0.12],
    [32, null, 0.09, 0.11],
  ]);

describe('bucketMid', () => {
  it('is the midpoint of a two-sided quote; null when a side is missing or degenerate', () => {
    expect(bucketMid(0.1, 0.12)).toBeCloseTo(0.11);
    expect(bucketMid(null, 0.12)).toBeNull();
    expect(bucketMid(0, 1)).toBeNull(); // degenerate (no real book)
  });
});

describe('hoursSinceListing', () => {
  it('anchors on the Gamma createdAt; null when the anchor is absent (→ not flat-open)', () => {
    expect(hoursSinceListing('2026-06-27T05:40:00Z', NOW)).toBeCloseTo(0.5, 2);
    expect(hoursSinceListing(null, NOW)).toBeNull();
    expect(hoursSinceListing('not-a-date', NOW)).toBeNull();
  });
});

describe('buildOpeningCaptureRow', () => {
  const cfg = { ...BOT_DEFAULTS };
  const depth: Map<number, BucketDepth> = new Map([
    [2, { execAsk: 0.13, depthUsd: 250, bestBid: 0.11, sellbackUsd: 40 }],
    [3, { execAsk: 0.12, depthUsd: 180, bestBid: 0.1, sellbackUsd: 30 }],
  ]);

  it('flags a fresh, low-peak ladder as flat-open + carries per-bucket depth', () => {
    const row = buildOpeningCaptureRow({
      ev: AMS(),
      eventId: 'evt-1',
      polyEventId: 'poly-1',
      tzName: 'Europe/Amsterdam',
      createdAtGamma: '2026-06-27T05:40:00Z',
      resolvesAt: '2026-06-28T22:00:00Z',
      capturedAt: NOW.toISOString(),
      depthByIdx: depth,
      probsByLabel: new Map(),
      houseSeeded: false,
      now: NOW,
      cfg,
    });
    expect(row.isFlatOpen).toBe(true); // peak mid 0.12 ≤ 0.18 ∧ 0.5h ≤ 1h
    expect(row.peakMid).toBeCloseTo(0.12, 2);
    expect(row.city).toBe('amsterdam');
    expect(row.tzName).toBe('Europe/Amsterdam');
    expect(row.negRisk).toBe(true);
    expect(row.resolvesAt).toBe('2026-06-28T22:00:00Z');
    expect(row.buckets).toHaveLength(5);
    expect(row.buckets[2]).toMatchObject({ idx: 2, depthUsd: 250, execAsk: 0.13, tokenYes: 'yes-2', conditionId: 'cond-2' });
    expect(row.buckets[0]!.depthUsd).toBe(0); // unwalked bucket ⇒ depth 0
    expect(row.buckets[0]!.execAsk).toBeNull();
  });

  it('aligns houseProb to each bucket BY LABEL IDENTITY (W6), null where unseeded', () => {
    const probs = new Map<string, number>([
      ['30-30°C', 0.34],
      ['31-31°C', 0.27],
      ['29-29°C', 0.18],
    ]);
    const row = buildOpeningCaptureRow({
      ev: AMS(),
      eventId: 'evt-1',
      polyEventId: 'poly-1',
      tzName: 'Europe/Amsterdam',
      createdAtGamma: '2026-06-27T05:40:00Z',
      resolvesAt: null,
      capturedAt: NOW.toISOString(),
      depthByIdx: depth,
      probsByLabel: probs,
      houseSeeded: true,
      now: NOW,
      cfg,
    });
    expect(row.houseSeeded).toBe(true);
    expect(row.buckets[2]!.houseProb).toBeCloseTo(0.34); // '30-30°C'
    expect(row.buckets[3]!.houseProb).toBeCloseTo(0.27); // '31-31°C'
    expect(row.buckets[0]!.houseProb).toBeNull(); // '<29°C' not in the seed
    expect(row.buckets[4]!.houseProb).toBeNull(); // '>31°C' not in the seed
  });

  it('is NOT flat-open when the peak exceeds 18% (converged) or the listing anchor is missing', () => {
    const converged = buildOpeningCaptureRow({
      ev: flatOpenEvent('amsterdam', '2026-06-28', [
        [29, 29, 0.1, 0.12],
        [30, 30, 0.36, 0.4], // a 38% peak — already converged
        [31, 31, 0.1, 0.12],
      ]),
      eventId: 'e', polyEventId: 'p', tzName: 'Europe/Amsterdam', createdAtGamma: '2026-06-27T05:40:00Z',
      resolvesAt: null, capturedAt: NOW.toISOString(), depthByIdx: new Map(), probsByLabel: new Map(),
      houseSeeded: false, now: NOW, cfg,
    });
    expect(converged.isFlatOpen).toBe(false);
    expect(converged.peakMid).toBeGreaterThan(0.18);

    const noAnchor = buildOpeningCaptureRow({
      ev: flatOpenEvent('amsterdam', '2026-06-28', [[30, 30, 0.1, 0.12]], { createdAt: null }),
      eventId: 'e', polyEventId: 'p', tzName: 'Europe/Amsterdam', createdAtGamma: null,
      resolvesAt: null, capturedAt: NOW.toISOString(), depthByIdx: new Map(), probsByLabel: new Map(),
      houseSeeded: false, now: NOW, cfg,
    });
    expect(noAnchor.isFlatOpen).toBe(false); // no listing time ⇒ not flat-open (fail-closed)
    expect(noAnchor.hoursSinceListing).toBeNull();
  });
});
