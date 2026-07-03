import { describe, expect, it } from 'vitest';
import {
  gradeSimBet,
  nowcastBasisC,
  placeSimBet,
  planPlacements,
  planSettlements,
  predictedBucketIdx,
  predictedNativeC,
  type GradeInputRow,
  type PlaceInputs,
  type SimLadderBucket,
} from '../src/sim/amsterdam.ts';
import { LadderGapError } from '../src/errors.ts';

/**
 * Houston (KHOU) is the first °F city enrolled in the multi-city paper-trade (migration 0070,
 * city_sim_config, 2026-07-03). The engine (predictedNativeC/predictedBucketIdx/placeSimBet/
 * gradeSimBet/planPlacements/planSettlements — all in this file) is used verbatim for every city
 * regardless of unit: the 0070 RPCs convert the °C-stored running max + forecast to the city's
 * native unit BEFORE calling these functions (see city_sim_place_inputs, migration comment "Unit-
 * general ... so a °F city (future) is correct too"). These fixtures prove that claim with the
 * ACTUAL Polymarket °F ladder convention (2°F-wide interior buckets, even-start pairing — verified
 * against real fixtures in buckets.test.ts's NYC ladder, e.g. '94-95°F','96-97°F') rather than the
 * 1°C-wide Amsterdam/Singapore ladder every existing amsterdam.ts test uses. No unit branch exists
 * in this file's functions (wuRound/winningBucket operate on whatever native number they're given —
 * see units.ts/buckets.ts) — these tests exist to LOCK that in before Houston's first live tick
 * (2026-07-04 10:00Z), not because a per-unit code path was found.
 */

// A KHOU-shaped °F ladder: 2°F interior pairs, even-start (matches the real Polymarket convention —
// buckets.test.ts's NYC jun11 fixture: '88-89°F','90-91°F',... '106°F or higher').
const LADDER_F: SimLadderBucket[] = [
  { bucketIdx: 0, low: null, high: 89 }, // '89°F or below'
  { bucketIdx: 1, low: 90, high: 91 },
  { bucketIdx: 2, low: 92, high: 93 },
  { bucketIdx: 3, low: 94, high: 95 },
  { bucketIdx: 4, low: 96, high: 97 },
  { bucketIdx: 5, low: 98, high: 99 },
  { bucketIdx: 6, low: 100, high: 101 },
  { bucketIdx: 7, low: 102, high: 103 },
  { bucketIdx: 8, low: 104, high: null }, // '104°F or higher'
];

describe('predictedNativeC — wuRound is unit-agnostic (°F running max)', () => {
  it('rounds a °F running max exactly as the market resolves, same half-up rule as °C', () => {
    expect(predictedNativeC(96.4)).toBe(96); // task fixture: running max 96.4°F
    expect(predictedNativeC(98.1)).toBe(98); // task fixture: forecast 98.1°F
    expect(predictedNativeC(96.49)).toBe(96);
  });

  it('x.5°F rounding-boundary case: half-up crosses a 2-wide bucket PAIR boundary', () => {
    // Amsterdam's 1°C-wide ladder never exercises this: every wuRound outcome is its own bucket.
    // A 2°F-wide ladder pairs {96,97} and {98,99} — 97.5°F must round UP to 98, landing in the
    // NEXT pair {98,99}, not the {96,97} pair its floor value belongs to.
    expect(predictedNativeC(97.5)).toBe(98); // half-up (away from zero), same rule as °C
    expect(predictedNativeC(97.49)).toBe(97); // one hundredth below the boundary stays in {96,97}
  });
});

describe('predictedBucketIdx — route a °F prediction through the real 2°F-wide ladder', () => {
  it('maps interior whole-°F values to their 2-wide bucket (both members of the pair)', () => {
    expect(predictedBucketIdx(LADDER_F, 96.4)).toBe(4); // wuRound 96 → {96,97}
    expect(predictedBucketIdx(LADDER_F, 97.5)).toBe(5); // wuRound 98 → {98,99} (the boundary case above)
    expect(predictedBucketIdx(LADDER_F, 90.0)).toBe(1); // {90,91}
  });

  it('routes the open tails (≤89°F and ≥104°F) correctly', () => {
    expect(predictedBucketIdx(LADDER_F, 85.0)).toBe(0);
    expect(predictedBucketIdx(LADDER_F, 89.4)).toBe(0); // rounds to 89 → tail
    expect(predictedBucketIdx(LADDER_F, 108.9)).toBe(8);
    expect(predictedBucketIdx(LADDER_F, 103.6)).toBe(8); // rounds to 104 → tail
  });

  it('throws LadderGapError on a malformed ladder (no unit-specific behaviour — same guard as °C)', () => {
    const broken: SimLadderBucket[] = [{ bucketIdx: 0, low: 200, high: 201 }];
    expect(() => predictedBucketIdx(broken, 96)).toThrow(LadderGapError);
  });
});

describe('nowcastBasisC — the running-max floor lifted to the forecast, values already in °F', () => {
  // nowcastBasisC/placeSimBet/etc. take whatever unit they are handed; the 0070 RPC hands them
  // already-converted °F values (city_sim_place_inputs: "v_unit = 'F' then ... * 9.0/5.0 + 32").
  it('lifts the °F floor to the °F forecast at an early arm (task fixture: 96.4 floor, 98.1 forecast)', () => {
    expect(nowcastBasisC(96.4, 11, 98.1, 14)).toBe(98.1); // hour 11 <= fmh 14 → forecast wins
    expect(predictedNativeC(nowcastBasisC(96.4, 11, 98.1, 14))).toBe(98);
    expect(predictedBucketIdx(LADDER_F, nowcastBasisC(96.4, 11, 98.1, 14))).toBe(5); // {98,99}
  });

  it('ignores the forecast at a late arm — the floor already IS the peak', () => {
    expect(nowcastBasisC(96.4, 16, 98.1, 14)).toBe(96.4); // hour 16 > fmh 14 → pure floor
    expect(predictedBucketIdx(LADDER_F, nowcastBasisC(96.4, 16, 98.1, 14))).toBe(4); // {96,97}
  });

  it('a forecast below the floor never lowers the call (hard minimum), in °F same as °C', () => {
    expect(nowcastBasisC(96.4, 11, 94.0, 14)).toBe(96.4);
  });
});

describe('placeSimBet — fixed-stake YES on a °F bucket at the recorded odds', () => {
  it('buys stake/ask shares on the predicted °F bucket', () => {
    const p = placeSimBet(LADDER_F, 96.4, 0.15, { feeRate: 0.05 });
    expect(p).not.toBeNull();
    expect(p!.predictedNativeC).toBe(96);
    expect(p!.bucketIdx).toBe(4);
    expect(p!.shares).toBeCloseTo(10 / 0.15, 10);
  });

  it('returns null (no-bet, not a loss) on an unusable ask — same guard as °C', () => {
    expect(placeSimBet(LADDER_F, 96.4, null)).toBeNull();
    expect(placeSimBet(LADDER_F, 96.4, 0)).toBeNull();
    expect(placeSimBet(LADDER_F, 96.4, 1.4)).toBeNull();
  });
});

describe('gradeSimBet — °F win/loss + P&L net of fee (bucket-index comparison only, unit-blind)', () => {
  it('a winning °F bet pays shares·(1−ask) minus the taker fee', () => {
    const p = placeSimBet(LADDER_F, 98.1, 0.15, { feeRate: 0.05 })!; // predicted 98 → idx5
    const g = gradeSimBet(p, 5); // {98,99} wins
    expect(g.won).toBe(true);
    // shares = 10/0.15 = 66.6667; fee = 0.05 * 0.15*0.85 * shares = 0.4250; profit = shares*0.85 - fee
    expect(p.shares).toBeCloseTo(10 / 0.15, 6);
    expect(g.feeUsd).toBeCloseTo(0.05 * 0.15 * 0.85 * (10 / 0.15), 6);
    expect(g.pnlUsd).toBeCloseTo((10 / 0.15) * 0.85 - 0.05 * 0.15 * 0.85 * (10 / 0.15), 6);
  });

  it('a losing °F bet loses the stake plus the fee', () => {
    const p = placeSimBet(LADDER_F, 96.4, 0.15, { feeRate: 0.05 })!; // predicted 96 → idx4
    const g = gradeSimBet(p, 5); // {98,99} actually won
    expect(g.won).toBe(false);
    expect(g.payoutUsd).toBe(0);
    expect(g.pnlUsd).toBeCloseTo(-10 - 0.05 * 0.15 * 0.85 * (10 / 0.15), 6);
  });
});

const fullAsks = (m: Record<number, number | null>) =>
  LADDER_F.map((b) => ({ bucketIdx: b.bucketIdx, ask: m[b.bucketIdx] ?? null }));

describe('planPlacements — the shared place decision, KHOU-shaped °F arms', () => {
  const base: Omit<PlaceInputs, 'arms'> = {
    targetDate: '2026-07-04',
    eventId: 'evt-khou-1',
    feeRate: 0.05,
    ladder: LADDER_F,
    labels: { 4: '96-97°F', 5: '98-99°F' },
    forecastMaxHour: 14, // KHOU's actual enrolled forecast_max_hour (FASTTRACK-PLAN.md C21)
  };

  it('an early arm (11:00) lifts the °F floor to the °F forecast bucket; the recorded ask is on THAT bucket', () => {
    const rows = planPlacements({
      ...base,
      forecastC: 98.1, // already-native °F, as the 0070 RPC hands it
      arms: [{ hour: 11, runMaxC: 96.4, asks: fullAsks({ 4: 0.05, 5: 0.15 }) }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      armHour: 11,
      predictedNativeC: 98,
      bucketIdx: 5,
      label: '98-99°F',
      ask: 0.15,
      runMaxC: 96.4,
      forecastC: 98.1,
    });
    expect(rows[0]!.shares).toBeCloseTo(10 / 0.15, 10);
  });

  it('a late arm (16:00) stays on the °F floor even with a higher forecast recorded', () => {
    const rows = planPlacements({
      ...base,
      forecastC: 99.0,
      arms: [{ hour: 16, runMaxC: 96.4, asks: fullAsks({ 4: 0.6, 5: 0.1 }) }],
    });
    expect(rows[0]).toMatchObject({ armHour: 16, predictedNativeC: 96, bucketIdx: 4, ask: 0.6 });
  });

  it('multiple arms racing the same day (mirrors the real KHOU config, arms 11..16)', () => {
    const rows = planPlacements({
      ...base,
      forecastC: 98.1,
      arms: [
        { hour: 11, runMaxC: 90.0, asks: fullAsks({ 5: 0.12 }) }, // lifted: floor 90 -> forecast 98.1 -> idx5
        { hour: 14, runMaxC: 96.4, asks: fullAsks({ 5: 0.2 }) }, // lifted (boundary hour): idx5
        { hour: 15, runMaxC: 96.4, asks: fullAsks({ 4: 0.55 }) }, // NOT lifted (past fmh 14): idx4
        { hour: 16, runMaxC: 97.5, asks: fullAsks({ 5: 0.7 }) }, // NOT lifted; floor itself crosses the pair boundary
      ],
    });
    expect(rows.map((r) => ({ h: r.armHour, idx: r.bucketIdx, pred: r.predictedNativeC }))).toEqual([
      { h: 11, idx: 5, pred: 98 },
      { h: 14, idx: 5, pred: 98 },
      { h: 15, idx: 4, pred: 96 },
      { h: 16, idx: 5, pred: 98 }, // 97.5 wuRounds to 98 even with no forecast lift
    ]);
  });

  it('skips an arm whose predicted °F bucket has no quote (no-bet, not a loss)', () => {
    const rows = planPlacements({
      ...base,
      arms: [{ hour: 16, runMaxC: 96.4, asks: fullAsks({ 5: 0.5 }) }], // quote only on idx5, we predict idx4
    });
    expect(rows).toHaveLength(0);
  });
});

describe('planSettlements — the shared resolve decision, °F winner/actual carried through untouched', () => {
  const rows: GradeInputRow[] = [
    { betId: 'khou-a', bucketIdx: 5, ask: 0.15, shares: 10 / 0.15, stakeUsd: 10, feeRate: 0.05, winnerIdx: 5, actualNativeC: 99 },
    { betId: 'khou-b', bucketIdx: 4, ask: 0.6, shares: 10 / 0.6, stakeUsd: 10, feeRate: 0.05, winnerIdx: 5, actualNativeC: 99 },
  ];
  it('grades a °F win and a °F loss, carrying the native actual (99°F) through untouched', () => {
    const s = planSettlements(rows);
    expect(s[0]).toMatchObject({ betId: 'khou-a', won: true, winnerIdx: 5, actualNativeC: 99 });
    expect(s[0]!.pnlUsd).toBeGreaterThan(0);
    expect(s[1]).toMatchObject({ betId: 'khou-b', won: false, winnerIdx: 5, actualNativeC: 99 });
    expect(s[1]!.pnlUsd).toBeCloseTo(-10 - 0.05 * 0.6 * 0.4 * (10 / 0.6), 6);
  });
});
