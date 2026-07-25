/**
 * Tests for the pure resolution-grade floor-climatology builder (city-floor-climatology-emit.ts):
 * the decided-hour semantics in rendered-integer space, decidedPct monotonicity/terminal-1 invariants,
 * the thin-month null gating, and the refuse-to-emit-empty guard. The committed asset is validated
 * separately in packages/core/test/city-floor-climatology.test.ts; this guards the generator itself.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_MONTH_DAYS,
  buildCityFloorClimatology,
  buildMonthFloor,
  decidedHour,
  finalRenderedMax,
  pct,
  type CityFloorEmitInput,
  type DayRenderedSeries,
} from './city-floor-climatology-emit.ts';

/** A synthetic day whose rendered running max reaches its final value at `decideAt` (rise-then-fall). */
function day(month: number, decideAt: number, hours: number[] = [...Array(24).keys()]): DayRenderedSeries {
  const byLocalHour = new Map<number, number>();
  for (const h of hours) byLocalHour.set(h, h <= decideAt ? 10 + h : 10 + decideAt - 1);
  return { month, byLocalHour };
}

const base: Omit<CityFloorEmitInput, 'days'> = {
  slug: 'test',
  icao: 'TEST',
  name: 'Test City',
  tz: 'Europe/Amsterdam',
  unit: 'C',
  fromYear: 2021,
  toYear: 2026,
};

describe('decidedHour / finalRenderedMax', () => {
  it('finds the first hour the final rendered max is reached', () => {
    const d = day(7, 15);
    expect(finalRenderedMax(d)).toBe(25);
    expect(decidedHour(d)).toBe(15);
  });

  it('a re-touch of the same max later never moves the decided hour (first occurrence wins)', () => {
    const byLocalHour = new Map<number, number>();
    for (let h = 0; h < 24; h++) byLocalHour.set(h, h === 10 || h === 16 ? 30 : 20);
    expect(decidedHour({ month: 7, byLocalHour })).toBe(10);
  });

  it('a day with missing early hours decides no earlier than its first observation', () => {
    const d = day(7, 5, [...Array(24).keys()].filter((h) => h >= 8)); // flat after 5 → max sits at every hour ≥ 8
    expect(decidedHour(d)).toBe(8);
  });

  it('a monotone-rising day decides at its last observed hour', () => {
    const byLocalHour = new Map<number, number>();
    for (let h = 0; h < 24; h++) byLocalHour.set(h, h);
    expect(decidedHour({ month: 1, byLocalHour })).toBe(23);
  });
});

describe('buildMonthFloor', () => {
  it('returns null under the MIN_MONTH_DAYS floor', () => {
    expect(buildMonthFloor(7, Array.from({ length: MIN_MONTH_DAYS - 1 }, () => day(7, 14)))).toBeNull();
  });

  it('decidedPct is monotone non-decreasing and ends at exactly 1', () => {
    const days = [
      ...Array.from({ length: 20 }, () => day(7, 12)),
      ...Array.from({ length: 15 }, () => day(7, 15)),
      ...Array.from({ length: 10 }, () => day(7, 18)),
    ];
    const m = buildMonthFloor(7, days)!;
    expect(m.nDays).toBe(45);
    expect(m.decidedPct).toHaveLength(24);
    for (let h = 1; h < 24; h++) expect(m.decidedPct[h]!).toBeGreaterThanOrEqual(m.decidedPct[h - 1]!);
    expect(m.decidedPct[23]).toBe(1);
    // hand-check: 20/45 decided by 12, 35/45 by 15, 45/45 by 18
    expect(m.decidedPct[11]).toBe(0);
    expect(m.decidedPct[12]).toBeCloseTo(20 / 45, 3);
    expect(m.decidedPct[15]).toBeCloseTo(35 / 45, 3);
    expect(m.decidedPct[18]).toBe(1);
  });

  it('decided-hour percentiles are ordered p10 ≤ median ≤ p90 and land on the mass', () => {
    const days = [
      ...Array.from({ length: 30 }, () => day(6, 13)),
      ...Array.from({ length: 10 }, () => day(6, 17)),
    ];
    const m = buildMonthFloor(6, days)!;
    expect(m.decidedHourP10).toBe(13);
    expect(m.decidedHourMedian).toBe(13);
    expect(m.decidedHourP90).toBe(17);
    expect(m.decidedHourP10).toBeLessThanOrEqual(m.decidedHourMedian);
    expect(m.decidedHourMedian).toBeLessThanOrEqual(m.decidedHourP90);
  });
});

describe('buildCityFloorClimatology', () => {
  it('emits 12 month slots with thin months null and carries metadata + coverage', () => {
    const clim = buildCityFloorClimatology({
      ...base,
      days: [
        ...Array.from({ length: 40 }, () => day(7, 15)),
        ...Array.from({ length: 5 }, () => day(1, 13)), // thin → null
      ],
    });
    expect(clim.slug).toBe('test');
    expect(clim.unit).toBe('C');
    expect(clim.nDays).toBe(45);
    expect(clim.months).toHaveLength(12);
    expect(clim.months[0]).toBeNull(); // January: 5 days < floor
    expect(clim.months[6]).not.toBeNull(); // July: 40 days
    expect(clim.months[6]!.month).toBe(7);
    expect(clim.months[6]!.decidedHourMedian).toBe(15);
  });

  it('refuses to emit a city with zero complete days', () => {
    expect(() => buildCityFloorClimatology({ ...base, days: [] })).toThrow(/zero complete days/);
  });
});

describe('pct', () => {
  it('matches the repo ceil convention', () => {
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10)).toBe(1);
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(pct([], 50)).toBeNaN();
  });
});
