import { describe, expect, it } from 'vitest';
import {
  analyzeStationDay,
  buildFloorSteps,
  deadMass,
  floorAt,
  isDeadBucket,
  maxCtoFloorNative,
  quantile,
  type Bucket,
  type FloorStep,
  type Snap,
} from './wo5-market-staleness.ts';

describe('maxCtoFloorNative — running max °C → rounded native ladder floor', () => {
  it('converts to °F and rounds to nearest integer', () => {
    expect(maxCtoFloorNative(22.2, 'F')).toBe(72); // 22.2°C = 71.96°F → 72
    expect(maxCtoFloorNative(26.6, 'F')).toBe(80); // 79.88 → 80
    expect(maxCtoFloorNative(0, 'F')).toBe(32);
  });
  it('°C markets keep native and round', () => {
    expect(maxCtoFloorNative(22.4, 'C')).toBe(22);
    expect(maxCtoFloorNative(22.6, 'C')).toBe(23);
  });
});

describe('isDeadBucket — sub-floor buckets are logically impossible', () => {
  // ladder: 78-79, 80-81, 82-83; floor 80 (tmax guaranteed ≥80°F)
  it('dead only when the whole labeled range is below the integer floor', () => {
    expect(isDeadBucket(79, 80)).toBe(true); // 78-79 entirely below 80 → dead
    expect(isDeadBucket(81, 80)).toBe(false); // 80-81 contains the floor → alive
    expect(isDeadBucket(83, 80)).toBe(false); // above → alive
  });
  it('the bucket containing an odd floor stays alive (conservative)', () => {
    expect(isDeadBucket(81, 81)).toBe(false); // 80-81 with floor 81 → still winnable at 81
    expect(isDeadBucket(79, 81)).toBe(true); // 78-79 dead
  });
  it('open high tail (null high) is never dead', () => {
    expect(isDeadBucket(null, 200)).toBe(false);
  });
});

describe('buildFloorSteps — monotone floor increases from hourly maxes', () => {
  it('keeps only rows that raise the rounded native floor, sorted by knownUtc', () => {
    const rows = [
      { knownUtc: 300, maxC: 26.7 }, // 80°F — out of order
      { knownUtc: 100, maxC: 21.1 }, // 70°F
      { knownUtc: 200, maxC: 21.3 }, // 70°F (no raise → dropped)
      { knownUtc: 400, maxC: 27.3 }, // 81°F
    ];
    const steps = buildFloorSteps(rows, 'F');
    expect(steps).toEqual([
      { knownUtc: 100, floorNative: 70 },
      { knownUtc: 300, floorNative: 80 },
      { knownUtc: 400, floorNative: 81 },
    ]);
  });
  it('empty input → no steps', () => {
    expect(buildFloorSteps([], 'F')).toEqual([]);
  });
});

describe('floorAt — public floor and recency as of t', () => {
  const steps: FloorStep[] = [
    { knownUtc: 1000, floorNative: 70 },
    { knownUtc: 2000, floorNative: 80 },
  ];
  it('null before the first step', () => {
    expect(floorAt(steps, 999)).toBeNull();
  });
  it('returns the latest step ≤ t with elapsed ms', () => {
    expect(floorAt(steps, 1500)).toEqual({ floorNative: 70, sinceMs: 500 });
    expect(floorAt(steps, 2000)).toEqual({ floorNative: 80, sinceMs: 0 });
    expect(floorAt(steps, 5000)).toEqual({ floorNative: 80, sinceMs: 3000 });
  });
});

describe('deadMass — Σ Yes price on dead buckets', () => {
  const buckets: Bucket[] = [
    { idx: 0, low: null, high: 75 },
    { idx: 1, low: 76, high: 77 },
    { idx: 2, low: 78, high: 79 },
    { idx: 3, low: 80, high: 81 },
    { idx: 4, low: 82, high: 83 },
    { idx: 5, low: 84, high: null },
  ];
  it('sums mid + bid over sub-floor buckets only; unquoted dead bucket contributes 0', () => {
    const book = new Map([
      [0, { mid: 0.01, bid: 0.005 }],
      [1, { mid: 0.02, bid: null }],
      // idx 2 (78-79) intentionally never quoted → must count as dead but add 0
      [3, { mid: 0.4, bid: 0.39 }],
      [4, { mid: 0.5, bid: 0.49 }],
    ]);
    const r = deadMass(book, buckets, 80); // dead: idx0(75), idx1(77), idx2(79)
    expect(r.nDead).toBe(3);
    expect(r.mass).toBeCloseTo(0.03, 6); // 0.01 + 0.02 + 0 (idx2 unquoted)
    expect(r.massBid).toBeCloseTo(0.005, 6); // only idx0 had a bid
    expect(r.nDeadPriced).toBe(2); // idx0, idx1 priced > 0
    expect(r.sumMid).toBeCloseTo(0.93, 6);
  });
  it('zero floor effect when nothing is below the floor', () => {
    const book = new Map([[3, { mid: 0.6, bid: 0.59 }]]);
    const r = deadMass(book, buckets, 70); // nothing dead (lowest closed high is 75 ≥ 70)
    expect(r.nDead).toBe(0);
    expect(r.mass).toBe(0);
  });
});

describe('analyzeStationDay — forward-fill replay + poll grouping', () => {
  const buckets: Bucket[] = [
    { idx: 0, low: null, high: 75 },
    { idx: 1, low: 76, high: 77 },
    { idx: 2, low: 78, high: 79 },
    { idx: 3, low: 80, high: 81 },
  ];
  // floor rises to 80°F at t=10_000ms
  const steps: FloorStep[] = [{ knownUtc: 10_000, floorNative: 80 }];

  it('emits no measurement before any floor is public', () => {
    const snaps: Snap[] = [
      { idx: 0, t: 1_000, mid: 0.1, bid: null },
      { idx: 3, t: 1_000, mid: 0.5, bid: null },
    ];
    expect(analyzeStationDay(buckets, snaps, steps, 120)).toEqual([]);
  });

  it('forward-fills across polls: a stale low-bucket quote persists until overwritten', () => {
    const snaps: Snap[] = [
      // poll A @ t=1_000 (before floor): low buckets priced 0.1 each
      { idx: 0, t: 1_000, mid: 0.1, bid: 0.09 },
      { idx: 1, t: 1_001, mid: 0.1, bid: 0.09 },
      { idx: 3, t: 1_002, mid: 0.6, bid: 0.59 },
      // poll B @ t=20_000 (after floor=80): only idx3 reprints; idx0/idx1 NOT repriced (still 0.1 via fill)
      { idx: 3, t: 20_000, mid: 0.8, bid: 0.79 },
      // poll C @ t=40_000: idx1 finally zeroed to 0.0
      { idx: 1, t: 40_000, mid: 0.0, bid: 0.0 },
    ];
    const ms = analyzeStationDay(buckets, snaps, steps, 2); // 2s gap: separates the 20s/40s polls, groups the 1ms deltas
    // polls: A(@1_002, pre-floor → skipped), B(@20_000), C(@40_000)
    expect(ms).toHaveLength(2);
    // poll B: dead buckets idx0(75),idx1(77),idx2(79). idx0=0.1, idx1=0.1(filled), idx2 unquoted=0 → 0.2
    expect(ms[0]!.t).toBe(20_000);
    expect(ms[0]!.mass).toBeCloseTo(0.2, 6);
    expect(ms[0]!.nDeadPriced).toBe(2);
    // poll C: idx1 repriced to 0 → dead mass drops to 0.1 (only idx0 left stale)
    expect(ms[1]!.t).toBe(40_000);
    expect(ms[1]!.mass).toBeCloseTo(0.1, 6);
    expect(ms[1]!.minSinceNewMax).toBeCloseTo(0.5, 6); // (40_000-10_000)ms = 30_000ms = 0.5 min
  });

  it('groups near-simultaneous delta rows into one poll (no double count)', () => {
    const snaps: Snap[] = [
      { idx: 0, t: 20_000, mid: 0.05, bid: null },
      { idx: 1, t: 20_001, mid: 0.05, bid: null },
      { idx: 3, t: 20_002, mid: 0.9, bid: null },
    ];
    const ms = analyzeStationDay(buckets, snaps, steps, 120);
    expect(ms).toHaveLength(1);
    expect(ms[0]!.mass).toBeCloseTo(0.1, 6); // idx0+idx1 dead
  });
});

describe('quantile', () => {
  it('indexes into a sorted array', () => {
    const xs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    expect(quantile(xs, 0)).toBe(0);
    expect(quantile(xs, 0.9)).toBe(8);
    expect(quantile(xs, 1)).toBe(9);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
  });
});
