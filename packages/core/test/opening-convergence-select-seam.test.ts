/**
 * Tests for the 2026-07-24 MARKET-SIGNAL selection seam (CONVERGENCE-CAPTURE-HANDOFF.md §4):
 * `selectEntries`' optional `targetIdx` / `ignoreHouseEdge`, and the replay engine's `selectRule` /
 * `ignoreHouseEdge` pass-through.
 *
 * The load-bearing property is BACKWARD COMPATIBILITY: with the new opts unset, every existing caller must
 * behave byte-identically to the frozen forecast-seeded engine (the whole point of the seam is that SELECTION
 * is the only moving part — if the default path shifted, the M0 control would no longer be the control).
 * The second load-bearing property is NO LOOK-AHEAD: the select rule must physically only ever see ticks[0..i].
 */
import { describe, expect, it } from 'vitest';
import {
  selectEntries,
  BOT_DEFAULTS,
  type OpeningBucket,
  type OpeningCapture,
  type OpeningCfg,
} from '../src/sim/opening-convergence.ts';
import { replayEvent, type EventReplayInput, type ReplayTick } from '../src/sim/opening-bracket-replay.ts';

const TZ = 'Europe/Amsterdam';
const DATE = '2026-06-28'; // CEST ⇒ local noon = 10:00Z
const NOW = new Date('2026-06-28T08:00:00.000Z'); // 120 min of runway
const cfg: OpeningCfg = { ...BOT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05 };

const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
  bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: null,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});

/** the frozen fixture: houseProb peaks at idx 2, every bucket cheap + deep enough to buy. */
const cap = (buckets: OpeningBucket[]): OpeningCapture => ({
  eventId: 'E', city: 'amsterdam', targetDate: DATE, tz: TZ, createdAtGamma: null, hoursSinceListing: 0.2,
  resolvesAt: null, negRisk: true, evVol24h: 5000, buckets, houseSeeded: true,
});
const ladder = (): OpeningBucket[] => [
  b(0, { houseProb: 0.1 }), b(1, { houseProb: 0.2 }), b(2, { houseProb: 0.35 }),
  b(3, { houseProb: 0.2 }), b(4, { houseProb: 0.1 }),
];

describe('selectEntries — defaults are byte-identical to the frozen behavior', () => {
  it('pins the forecast-argmax center (mode 2 ± centerHalfWidth 1 ⇒ idx 1,2,3) with no opts', () => {
    const out = selectEntries(cap(ladder()), cfg, NOW, { requireFlatOpen: false });
    expect(out.map((c) => c.bucketIdx)).toEqual([1, 2, 3]);
    // the exact frozen candidate: reservation = min(0.20, houseProb − 0.05), edge = houseProb − execAsk
    expect(out[1]).toEqual({
      eventId: 'E', city: 'amsterdam', targetDate: DATE, tz: TZ, bucketIdx: 2, label: 'b2',
      tokenYes: 'y2', tokenNo: 'n2', conditionId: 'c2', negRisk: true, resolvesAt: null,
      execAsk: 0.11, modelProb: 0.35, edge: 0.35 - 0.11, makerLimit: 0.11, targetShares: cfg.perPositionUsd / 0.11,
      targetUsd: cfg.perPositionUsd,
    });
  });

  it('explicitly-undefined new opts are identical to omitting them', () => {
    const bare = selectEntries(cap(ladder()), cfg, NOW, { requireFlatOpen: false });
    const explicit = selectEntries(cap(ladder()), cfg, NOW, { requireFlatOpen: false, targetIdx: undefined, ignoreHouseEdge: false });
    expect(explicit).toEqual(bare);
  });

  it('still returns [] when NO bucket carries a houseProb and no target is given', () => {
    expect(selectEntries(cap([b(0), b(1), b(2)]), cfg, NOW, { requireFlatOpen: false })).toEqual([]);
  });
});

describe('selectEntries — targetIdx overrides the center', () => {
  it('centers on the explicit target instead of argmax(houseProb)', () => {
    const out = selectEntries(cap(ladder()), cfg, NOW, { requireFlatOpen: false, targetIdx: 0 });
    // the window is 0 ± 1 (clamped by the ladder); idx 0 then fails the UNCHANGED edge gate on its own merits
    // (reservation min(0.20, 0.10 − 0.05) = 0.05 < execAsk 0.11) — the target moved the center, not the gates.
    expect(out.map((c) => c.bucketIdx)).toEqual([1]);
  });

  it('an explicit target is a valid center even with NO houseProb anywhere (the guard must not fire)', () => {
    const out = selectEntries(cap([b(0), b(1), b(2)]), cfg, NOW, { requireFlatOpen: false, targetIdx: 1, ignoreHouseEdge: true });
    expect(out.map((c) => c.bucketIdx)).toEqual([0, 1, 2]);
  });

  it('a target with no houseProb is still gated out when the model edge is REQUIRED', () => {
    expect(selectEntries(cap([b(0), b(1), b(2)]), cfg, NOW, { requireFlatOpen: false, targetIdx: 1 })).toEqual([]);
  });
});

describe('selectEntries — ignoreHouseEdge', () => {
  it('admits a null-houseProb bucket and caps the reservation at maxEntryPrice (NaN modelProb/edge)', () => {
    const out = selectEntries(cap([b(1, { execAsk: 0.2, bestAsk: 0.2 })]), cfg, NOW, {
      requireFlatOpen: false, targetIdx: 1, ignoreHouseEdge: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.execAsk).toBe(0.2); // exactly AT the 0.20 cap — admitted
    expect(Number.isNaN(out[0]!.modelProb)).toBe(true);
    expect(Number.isNaN(out[0]!.edge)).toBe(true);
    expect(out[0]!.makerLimit).toBe(0.2);
    expect(out[0]!.targetShares).toBe(cfg.perPositionUsd / 0.2); // NaN never reached the share math
  });

  it('keeps a KNOWN houseProb on the candidate (only the edge REQUIREMENT is dropped)', () => {
    const out = selectEntries(cap([b(1, { houseProb: 0.12, execAsk: 0.19, bestAsk: 0.19 })]), cfg, NOW, {
      requireFlatOpen: false, targetIdx: 1, ignoreHouseEdge: true,
    });
    // with the edge required this would fail (0.19 > 0.12 − 0.05); with it dropped only the 0.20 cap binds
    expect(out).toHaveLength(1);
    expect(out[0]!.modelProb).toBe(0.12);
    expect(selectEntries(cap([b(1, { houseProb: 0.12, execAsk: 0.19, bestAsk: 0.19 })]), cfg, NOW, { requireFlatOpen: false, targetIdx: 1 })).toEqual([]);
  });

  it('the hard price cap, depth floor and execAsk > 0 gates all still bind', () => {
    const o = { requireFlatOpen: false, targetIdx: 1, ignoreHouseEdge: true } as const;
    expect(selectEntries(cap([b(1, { execAsk: 0.21 })]), cfg, NOW, o)).toEqual([]); // above the cap
    expect(selectEntries(cap([b(1, { depthUsd: 10 })]), cfg, NOW, o)).toEqual([]); // below the depth floor
    expect(selectEntries(cap([b(1, { execAsk: 0 })]), cfg, NOW, o)).toEqual([]); // no executable ask
    expect(selectEntries({ ...cap([b(1)]), city: 'london' }, cfg, NOW, o)).toEqual([]); // off-allowlist city
  });
});

describe('replayEvent — the selectRule seam', () => {
  const tick = (capturedAt: string, buckets: OpeningBucket[]): ReplayTick => ({
    capturedAt, hoursSinceListing: 0.2, tz: TZ, targetDate: DATE, buckets,
  });
  const expensive = (): OpeningBucket[] => ladder().map((x) => ({ ...x, execAsk: 0.9, bestAsk: 0.9 }));
  const evt = (ticks: ReplayTick[]): EventReplayInput => ({
    eventId: 'E', city: 'amsterdam', targetDate: DATE, tz: TZ, ticks, resolution: { winnerIdx: 2, gradingMismatch: false },
  });

  it('hands the rule ticks[0..i] ONLY — never a future tick', () => {
    const seen: { i: number; len: number; lastAt: string }[] = [];
    const ticks = [
      tick('2026-06-28T08:00:00.000Z', expensive()),
      tick('2026-06-28T08:00:30.000Z', expensive()),
      tick('2026-06-28T08:01:00.000Z', ladder()),
      tick('2026-06-28T08:01:30.000Z', ladder()),
    ];
    replayEvent(evt(ticks), cfg, 0.25, {
      selectRule: (ts, i) => {
        seen.push({ i, len: ts.length, lastAt: ts[ts.length - 1]!.capturedAt });
        return null;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s.len).toBe(s.i + 1); // structural no-look-ahead
      expect(s.lastAt).toBe(ticks[s.i]!.capturedAt);
    }
    expect(seen.map((s) => s.i)).toEqual([0, 1, 2]); // stops at the first enterable tick
  });

  it('a null rule falls back to the frozen forecast argmax center', () => {
    const ticks = [tick('2026-06-28T08:00:00.000Z', ladder()), tick('2026-06-28T08:00:30.000Z', ladder())];
    const base = replayEvent(evt(ticks), cfg, 0.25);
    const ruled = replayEvent(evt(ticks), cfg, 0.25, { selectRule: () => null });
    expect(ruled).toEqual(base);
    expect(base.bucketIdx).toBe(2);
  });

  it('a market-signal target moves the BOUGHT bucket (and records it on the trade)', () => {
    const ticks = [tick('2026-06-28T08:00:00.000Z', ladder()), tick('2026-06-28T08:00:30.000Z', ladder())];
    const t = replayEvent(evt(ticks), cfg, 0.25, { selectRule: () => 4, ignoreHouseEdge: true });
    expect(t.executed).toBe(true);
    expect(t.bucketIdx).toBe(4);
    expect(t.wouldHaveWonAtResolution).toBe(false); // winnerIdx 2 ≠ bought 4
  });

  it('ignoreHouseEdge admits an event our forecast never seeded at all', () => {
    const bare = [b(0), b(1), b(2)];
    const ticks = [tick('2026-06-28T08:00:00.000Z', bare), tick('2026-06-28T08:00:30.000Z', bare)];
    expect(replayEvent(evt(ticks), cfg, 0.25, { selectRule: () => 1 }).executed).toBe(false);
    const t = replayEvent(evt(ticks), cfg, 0.25, { selectRule: () => 1, ignoreHouseEdge: true });
    expect(t.executed).toBe(true);
    expect(t.bucketIdx).toBe(1);
    expect(Number.isFinite(t.netReturn)).toBe(true); // a NaN modelProb never leaked into the P&L
  });
});
