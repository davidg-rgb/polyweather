import { describe, expect, it } from 'vitest';
import {
  AMSTERDAM_SIM_ARM_HOURS,
  AMSTERDAM_SIM_FORECAST_MAX_HOUR,
  AMSTERDAM_SIM_PRIMARY_HOUR,
  AMSTERDAM_SIM_STAKE_USD,
  evPerDollar,
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

// The live Amsterdam ladder shape (0004 fixture verified against the hosted DB):
// idx 0 "≤14", idx 1..9 each a whole °C (15..23), idx 10 "≥24".
const LADDER: SimLadderBucket[] = [
  { bucketIdx: 0, low: null, high: 14 },
  { bucketIdx: 1, low: 15, high: 15 },
  { bucketIdx: 2, low: 16, high: 16 },
  { bucketIdx: 3, low: 17, high: 17 },
  { bucketIdx: 4, low: 18, high: 18 },
  { bucketIdx: 5, low: 19, high: 19 },
  { bucketIdx: 6, low: 20, high: 20 },
  { bucketIdx: 7, low: 21, high: 21 },
  { bucketIdx: 8, low: 22, high: 22 },
  { bucketIdx: 9, low: 23, high: 23 },
  { bucketIdx: 10, low: 24, high: null },
];

describe('predictedNativeC — whole-°C, WU rounding (half away from zero)', () => {
  it('rounds the running max exactly as the market resolves', () => {
    expect(predictedNativeC(21.9)).toBe(22);
    expect(predictedNativeC(22.3)).toBe(22);
    expect(predictedNativeC(22.5)).toBe(23); // half-up
    expect(predictedNativeC(17.49)).toBe(17);
    expect(predictedNativeC(18.0)).toBe(18);
  });
});

describe('predictedBucketIdx — route the prediction through the ladder', () => {
  it('maps an interior whole-°C to its single-degree bucket', () => {
    expect(predictedBucketIdx(LADDER, 18.2)).toBe(4); // 18°C
    expect(predictedBucketIdx(LADDER, 21.9)).toBe(8); // 22°C → idx 8
    expect(predictedBucketIdx(LADDER, 15.0)).toBe(1);
  });

  it('routes the tails (≤14 and ≥24) correctly', () => {
    expect(predictedBucketIdx(LADDER, 11.3)).toBe(0); // ≤14
    expect(predictedBucketIdx(LADDER, 14.4)).toBe(0); // rounds to 14 → ≤14
    expect(predictedBucketIdx(LADDER, 26.7)).toBe(10); // ≥24
    expect(predictedBucketIdx(LADDER, 23.6)).toBe(10); // rounds to 24 → ≥24
  });
});

describe('nowcastBasisC — running-max floor lifted by the de-biased forecast at early arms', () => {
  it('no forecast (null/NaN) → the pure floor, at every hour (original behaviour)', () => {
    expect(nowcastBasisC(19.4, 13, null)).toBe(19.4);
    expect(nowcastBasisC(19.4, 13, undefined)).toBe(19.4);
    expect(nowcastBasisC(19.4, 13, Number.NaN)).toBe(19.4);
    expect(nowcastBasisC(21.6, 16, null)).toBe(21.6);
  });

  it('forecast below the floor never lowers the call (the floor is a hard minimum)', () => {
    expect(nowcastBasisC(21.9, 13, 20.0)).toBe(21.9); // already warmer than forecast → keep floor
    expect(nowcastBasisC(21.9, 14, 21.9)).toBe(21.9); // equal → floor
  });

  it('lifts the floor to the forecast at early arms (≤ FORECAST_MAX_HOUR)', () => {
    expect(nowcastBasisC(19.4, 13, 22.0)).toBe(22.0); // day still warming → forecast wins
    expect(nowcastBasisC(19.4, AMSTERDAM_SIM_FORECAST_MAX_HOUR, 22.0)).toBe(22.0); // boundary included
  });

  it('ignores the forecast at late arms (> FORECAST_MAX_HOUR) — the floor is already the peak', () => {
    expect(nowcastBasisC(21.6, 15, 23.0)).toBe(21.6);
    expect(nowcastBasisC(21.9, 16, 24.0)).toBe(21.9);
    expect(AMSTERDAM_SIM_FORECAST_MAX_HOUR).toBe(14); // pin the empirically-tuned gate
  });

  it('a sub-degree lift flips the rounded bucket, and negative temps lift correctly (A-11 path)', () => {
    // floor 21.4 → wuRound 21, but the forecast 21.6 lifts the basis → wuRound 22 (the whole point).
    expect(predictedNativeC(nowcastBasisC(21.4, 13, 21.6))).toBe(22);
    expect(predictedNativeC(nowcastBasisC(21.4, 13, null))).toBe(21); // no forecast → floor bucket
    // negative-temperature lift: floor −2.6 (would round to −3), forecast −1.4 lifts → −1 (half-away-from-zero).
    expect(nowcastBasisC(-2.6, 13, -1.4)).toBe(-1.4);
    expect(predictedNativeC(nowcastBasisC(-2.6, 13, -1.4))).toBe(-1);
  });
});

describe('placeSimBet — fixed-stake YES at the recorded odds', () => {
  it('buys stake/ask shares on the predicted bucket', () => {
    const p = placeSimBet(LADDER, 18.1, 0.5, { feeRate: 0.05 });
    expect(p).not.toBeNull();
    expect(p!.bucketIdx).toBe(4);
    expect(p!.predictedNativeC).toBe(18);
    expect(p!.stakeUsd).toBe(AMSTERDAM_SIM_STAKE_USD);
    expect(p!.shares).toBeCloseTo(20, 10); // $10 / 0.5
  });

  it('honours a custom stake', () => {
    const p = placeSimBet(LADDER, 18.1, 0.25, { stakeUsd: 4 });
    expect(p!.shares).toBeCloseTo(16, 10);
  });

  it('returns null (no-bet day, not a loss) on an unusable ask', () => {
    expect(placeSimBet(LADDER, 18.1, null)).toBeNull();
    expect(placeSimBet(LADDER, 18.1, 0)).toBeNull();
    expect(placeSimBet(LADDER, 18.1, -0.1)).toBeNull();
    expect(placeSimBet(LADDER, 18.1, 1.2)).toBeNull();
    expect(placeSimBet(LADDER, Number.NaN, 0.5)).toBeNull();
  });
});

describe('gradeSimBet — win/loss + P&L net of fee', () => {
  it('a winning bet pays shares·(1−ask) minus the taker fee', () => {
    const p = placeSimBet(LADDER, 18.1, 0.5, { feeRate: 0.05 })!; // 20 shares
    const g = gradeSimBet(p, 4); // 18°C wins
    expect(g.won).toBe(true);
    expect(g.payoutUsd).toBeCloseTo(20, 10);
    // fee = 20 · 0.05·0.5·0.5 = 0.25 ; profit = 20·0.5 − 0.25 = 9.75
    expect(g.feeUsd).toBeCloseTo(0.25, 10);
    expect(g.pnlUsd).toBeCloseTo(9.75, 10);
  });

  it('a losing bet loses the stake plus the fee', () => {
    const p = placeSimBet(LADDER, 18.1, 0.5, { feeRate: 0.05 })!;
    const g = gradeSimBet(p, 7); // 21°C won instead
    expect(g.won).toBe(false);
    expect(g.payoutUsd).toBe(0);
    expect(g.pnlUsd).toBeCloseTo(-10 - 0.25, 10);
  });

  it('fee-free grading is the clean ±: win → shares−stake, loss → −stake', () => {
    const p = placeSimBet(LADDER, 18.1, 0.4)!; // 25 shares, no feeRate
    expect(gradeSimBet(p, 4).pnlUsd).toBeCloseTo(15, 10); // 25 − 10
    expect(gradeSimBet(p, 0).pnlUsd).toBeCloseTo(-10, 10);
  });

  it('a near-certain late bet barely profits even when right', () => {
    const p = placeSimBet(LADDER, 18.0, 0.98, { feeRate: 0.05 })!;
    const g = gradeSimBet(p, 4);
    expect(g.won).toBe(true);
    expect(g.pnlUsd).toBeGreaterThan(0);
    expect(g.pnlUsd).toBeLessThan(0.3); // $10 staked to win ~$0.2 — the 16:00 problem
  });
});

describe('evPerDollar — the lock-hour ranking lens', () => {
  it('is zero when the market prices our bucket at our hit rate (efficient)', () => {
    expect(evPerDollar(0.86, 0.86)).toBeCloseTo(0, 10);
  });
  it('is positive only when hit rate beats the ask', () => {
    expect(evPerDollar(0.5, 0.4)).toBeCloseTo(0.25, 10);
    expect(evPerDollar(0.5, 0.6)).toBeLessThan(0);
  });
  it('guards a non-positive ask', () => {
    expect(evPerDollar(0.5, 0)).toBe(0);
  });
});

describe('round-trip invariant: fee-free P&L is a martingale at a fair ask', () => {
  it('EV of profit equals zero when ask = true hit probability', () => {
    // p = ask = 0.7: win prob 0.7 → +shares·(1−ask); lose 0.3 → −stake.
    const ask = 0.7;
    const place = placeSimBet(LADDER, 18.1, ask)!;
    const win = gradeSimBet(place, 4).pnlUsd;
    const lose = gradeSimBet(place, 0).pnlUsd;
    expect(ask * win + (1 - ask) * lose).toBeCloseTo(0, 10);
  });
});

describe('arm constants', () => {
  it('the primary hour is one of the tracked arms', () => {
    expect(AMSTERDAM_SIM_ARM_HOURS).toContain(AMSTERDAM_SIM_PRIMARY_HOUR);
  });
});

describe('malformed ladder surfaces loudly', () => {
  it('throws LadderGapError when no bucket covers the prediction', () => {
    const broken: SimLadderBucket[] = [{ bucketIdx: 0, low: 30, high: 31 }];
    expect(() => predictedBucketIdx(broken, 18)).toThrow(LadderGapError);
  });
});

const fullAsks = (m: Record<number, number | null>) =>
  LADDER.map((b) => ({ bucketIdx: b.bucketIdx, ask: m[b.bucketIdx] ?? null }));

describe('planPlacements — the shared place decision', () => {
  const base: Omit<PlaceInputs, 'arms'> = {
    targetDate: '2026-06-17',
    eventId: 'evt-1',
    feeRate: 0.05,
    ladder: LADDER,
    labels: { 8: '22°C', 4: '18°C' },
  };

  it('places one row per arm with a usable quote on the predicted bucket', () => {
    const rows = planPlacements({
      ...base,
      arms: [
        { hour: 15, runMaxC: 21.9, asks: fullAsks({ 8: 0.8 }) }, // 22°C
        { hour: 16, runMaxC: 18.1, asks: fullAsks({ 4: 0.98 }) }, // 18°C
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ armHour: 15, bucketIdx: 8, label: '22°C', ask: 0.8, stakeUsd: 10 });
    expect(rows[0]!.shares).toBeCloseTo(12.5, 10);
    expect(rows[1]).toMatchObject({ armHour: 16, bucketIdx: 4, label: '18°C' });
  });

  it('skips an arm whose predicted bucket has no quote (no-bet, not a loss)', () => {
    const rows = planPlacements({
      ...base,
      arms: [
        { hour: 15, runMaxC: 21.9, asks: fullAsks({ 4: 0.5 }) }, // quote on 18°C, but we predict 22°C
        { hour: 16, runMaxC: 18.1, asks: fullAsks({ 4: 0.9 }) },
      ],
    });
    expect(rows.map((r) => r.armHour)).toEqual([16]);
  });

  it('honours a custom stake across arms', () => {
    const rows = planPlacements(
      { ...base, arms: [{ hour: 15, runMaxC: 18.1, asks: fullAsks({ 4: 0.5 }) }] },
      { stakeUsd: 5 },
    );
    expect(rows[0]!.stakeUsd).toBe(5);
    expect(rows[0]!.shares).toBeCloseTo(10, 10);
  });

  it('stores forecastC=null and bets the pure floor when no forecast is supplied', () => {
    const rows = planPlacements({
      ...base,
      arms: [{ hour: 13, runMaxC: 19.4, asks: fullAsks({ 5: 0.3 }) }], // 19°C floor
    });
    expect(rows[0]).toMatchObject({ armHour: 13, bucketIdx: 5, predictedNativeC: 19, forecastC: null });
  });

  it('lifts an early arm to the de-biased forecast bucket; the recorded ask is on THAT bucket', () => {
    // 13:00 floor is 19.4°C (→19°C, idx5), but the de-biased forecast says 22.0°C → we predict 22°C
    // (idx8) and must record the ask on idx8 (0.8), not the floor bucket's.
    const rows = planPlacements({
      ...base,
      forecastC: 22.0,
      arms: [{ hour: 13, runMaxC: 19.4, asks: fullAsks({ 5: 0.3, 8: 0.8 }) }],
    });
    expect(rows[0]).toMatchObject({
      armHour: 13,
      bucketIdx: 8,
      predictedNativeC: 22,
      label: '22°C',
      ask: 0.8,
      runMaxC: 19.4,
      forecastC: 22.0,
    });
  });

  it('does not lift a late arm — 15:00 keeps the floor even with a higher forecast', () => {
    const rows = planPlacements({
      ...base,
      forecastC: 23.0,
      arms: [{ hour: 15, runMaxC: 21.9, asks: fullAsks({ 8: 0.8, 9: 0.9 }) }], // floor 22°C (idx8)
    });
    expect(rows[0]).toMatchObject({ armHour: 15, bucketIdx: 8, predictedNativeC: 22, forecastC: 23.0 });
  });
});

describe('planSettlements — the shared resolve decision', () => {
  const rows: GradeInputRow[] = [
    { betId: 'a', bucketIdx: 8, ask: 0.8, shares: 12.5, stakeUsd: 10, feeRate: 0.05, winnerIdx: 8, actualNativeC: 22 },
    { betId: 'b', bucketIdx: 4, ask: 0.5, shares: 20, stakeUsd: 10, feeRate: 0, winnerIdx: 7, actualNativeC: 21 },
  ];
  it('grades wins and losses, carrying the fee and winner through', () => {
    const s = planSettlements(rows);
    expect(s[0]).toMatchObject({ betId: 'a', won: true, winnerIdx: 8, actualNativeC: 22 });
    expect(s[0]!.pnlUsd).toBeGreaterThan(0);
    expect(s[1]).toMatchObject({ betId: 'b', won: false });
    expect(s[1]!.pnlUsd).toBeCloseTo(-10, 10);
  });
});
