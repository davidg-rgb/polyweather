/**
 * Tests for the opening-capture pure helpers (pure.ts) — the capture-row assembly + flat-open flagging +
 * the BY-LABEL-IDENTITY houseProb alignment (W6). Node/vitest; pure.ts imports only @weather-edge/core.
 * (The impure handler's seed/walk/record path is exercised end-to-end by the migration-0066 PGlite twin +
 * live prod verification — mirroring how cross-venue-capture tests its pure.ts here.)
 */
import { describe, expect, it } from 'vitest';
import type { ParsedEvent } from '../../../packages/core/src/index.ts';
import { BOT_DEFAULTS } from '../../../packages/core/src/sim/opening-convergence.ts';
import { bucketMid, buildOpeningCaptureRow, hoursSinceListing, openingUniverseReason, type BucketDepth, type UniverseOpts } from './pure.ts';

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

describe('openingUniverseReason — the capture universe (CAP-1/CAP-2: the fresh OPEN must be admitted)', () => {
  // §9R ladders list ~2.8 lead-days ahead with sub-floor 24h volume; NOW = 06:10Z, so a batch listed at ~05:40Z
  // (0.5h ago) for a target 2 days out is the flat OPEN the spike must measure.
  const opts: UniverseOpts = {
    cities: new Set(['amsterdam', 'paris', 'beijing']),
    minVol24hUsd: 7000,
    now: NOW,
    maxLeadDays: 2,
    freshListingMaxH: 3,
  };
  // a scoped 'highest' event with explicit createdAt/lead/vol; target 2.7 days out (the daily-batch listing lead).
  const ev = (over: { createdAt?: string | null; vol?: number; td?: string; city?: string; kind?: string; accepting?: boolean }) =>
    ({
      kind: over.kind ?? 'highest',
      acceptingOrders: over.accepting ?? true,
      citySlug: over.city ?? 'amsterdam',
      targetDate: over.td ?? '2026-06-29', // ~2.74 lead-days from NOW
      createdAt: over.createdAt === undefined ? '2026-06-27T05:40:00Z' : over.createdAt, // 0.5h ago
      eventVolume24h: over.vol ?? 1800,
    }) as unknown as ParsedEvent;

  it("admits a FRESHLY-LISTED low-vol high-lead event as 'fresh' (the bug fix — was excluded, now the open is sampled)", () => {
    // createdAt 0.5h ago, lead 2.74 (> maxLeadDays 2), vol 1800 (< floor 7000): the OLD lead≤2 ∧ vol≥7k filter
    // would have dropped this, so the ≤1h flat open was never captured → a structural false NO-GO.
    expect(openingUniverseReason(ev({}), opts)).toBe('fresh');
  });

  it("excludes the SAME event once it is past the fresh window AND still sub-floor/over-lead (no double-admit)", () => {
    // createdAt 5h ago (> freshListingMaxH 3) and still lead 2.74 / vol 1800 → neither path admits it.
    expect(openingUniverseReason(ev({ createdAt: '2026-06-27T01:10:00Z' }), opts)).toBeNull();
  });

  it("admits the near-dated LIQUID trajectory as 'liquid' (lead ≤ 2 ∧ vol ≥ floor), even when not fresh", () => {
    expect(openingUniverseReason(ev({ td: '2026-06-28', vol: 9000, createdAt: '2026-06-25T00:00:00Z' }), opts)).toBe('liquid');
  });

  it('does NOT fresh-admit a freshly-listed FAR-FUTURE market (the loose lead sanity cap)', () => {
    expect(openingUniverseReason(ev({ td: '2026-07-10' }), opts)).toBeNull(); // fresh but lead ≫ maxLeadDays+1.5
  });

  it('excludes out-of-universe events (non-scoped city, non-highest, not accepting, resolved)', () => {
    expect(openingUniverseReason(ev({ city: 'tokyo' }), opts)).toBeNull();
    expect(openingUniverseReason(ev({ kind: 'lowest' }), opts)).toBeNull();
    expect(openingUniverseReason(ev({ accepting: false }), opts)).toBeNull();
    expect(openingUniverseReason(ev({ td: '2026-06-25' }), opts)).toBeNull(); // lead < -0.5 (resolved)
  });

  it('a missing/invalid createdAt fails closed to the liquid test (no fresh-admit without a listing anchor)', () => {
    expect(openingUniverseReason(ev({ createdAt: null, vol: 1800 }), opts)).toBeNull(); // no anchor, sub-floor → out
    expect(openingUniverseReason(ev({ createdAt: null, td: '2026-06-28', vol: 9000 }), opts)).toBe('liquid'); // liquid still works
  });
});

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
    [2, { execAsk: 0.13, depthUsd: 250, bestBid: 0.11, sellbackUsd: 40, execBid: 0.11, sellbackDepthUsd: 220 }],
    [3, { execAsk: 0.12, depthUsd: 180, bestBid: 0.1, sellbackUsd: 30, execBid: 0.1, sellbackDepthUsd: 150 }],
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
    expect(row.buckets[2]).toMatchObject({ idx: 2, depthUsd: 250, execAsk: 0.13, execBid: 0.11, sellbackDepthUsd: 220, tokenYes: 'yes-2', conditionId: 'cond-2' });
    expect(row.buckets[0]!.depthUsd).toBe(0); // unwalked bucket ⇒ depth 0
    expect(row.buckets[0]!.execAsk).toBeNull();
    expect(row.buckets[0]!.execBid).toBeNull(); // unwalked ⇒ no exit mark either
    expect(row.buckets[0]!.sellbackDepthUsd).toBe(0);
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
