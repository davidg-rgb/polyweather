/**
 * Tests for the pure city-climatology builder (scripts/research/city-climatology-emit.buildCityClimatology):
 * the compact projection over the shared decision hours, the hemisphere warm-season gating (emit only when
 * the fetched warm sample is large enough), and the refuse-to-emit-empty guard. The full asset is validated
 * separately in packages/core/test/city-climatology.test.ts; this guards the generator itself.
 */
import { describe, expect, it } from 'vitest';
import type { DayPeakLike } from './amsterdam-climatology-emit.ts';
import { buildCityClimatology, type CityEmitInput } from './city-climatology-emit.ts';

/** N synthetic days for `month` peaking at `peakHour` (a clean rise-then-fall trace). */
function days(month: number, peakHour: number, n: number): DayPeakLike[] {
  return Array.from({ length: n }, (): DayPeakLike => {
    const byLocalHour = new Map<number, number>();
    for (let h = 0; h < 24; h++) byLocalHour.set(h, h <= peakHour ? 100 + h : 100 + (2 * peakHour - h));
    return { month, maxC: (100 + peakHour) / 10, peakLocalHour: peakHour, byLocalHour };
  });
}

const base: Omit<CityEmitInput, 'peaks' | 'warmMonths'> = {
  slug: 'test', icao: 'TEST', name: 'Test City', lat: 52, lon: 5, tz: 'Europe/Amsterdam', fromYear: 2016, toYear: 2025,
};

describe('buildCityClimatology', () => {
  it('projects the compact per-hour rows over [10..19] and carries metadata', () => {
    const clim = buildCityClimatology({ ...base, peaks: days(7, 15, 200), warmMonths: [5, 6, 7, 8, 9] });
    expect(clim.slug).toBe('test');
    expect(clim.nDays).toBe(200);
    expect(clim.medianPeakHour).toBe(15);
    expect(clim.peakHourHistogram).toHaveLength(24);
    expect(clim.decisionByHour.map((d) => d.hour)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    // compact row shape: exactly the four display fields (+ hour), nothing from the full HourDecisionStat
    expect(Object.keys(clim.decisionByHour[0]!).sort()).toEqual(['hour', 'leUpside05', 'meanUpsideC', 'n', 'peakedPct']);
    // by hour 16 the 15:00-peaking day is fully "already peaked"
    expect(clim.decisionByHour.find((d) => d.hour === 16)!.peakedPct).toBe(1);
    expect(clim.decisionByHour.find((d) => d.hour === 10)!.peakedPct).toBe(0);
  });

  it('emits a warm sub-climatology only when the warm sample clears the 60-day floor', () => {
    const thin = buildCityClimatology({ ...base, peaks: [...days(7, 15, 50), ...days(1, 13, 100)], warmMonths: [7] });
    expect(thin.warm).toBeNull(); // only 50 warm (July) days < 60

    const thick = buildCityClimatology({ ...base, peaks: [...days(7, 15, 80), ...days(1, 13, 100)], warmMonths: [7] });
    expect(thick.warm).not.toBeNull();
    expect(thick.warm!.nDays).toBe(80);
    expect(thick.warm!.medianPeakHour).toBe(15);
    expect(thick.warm!.decisionByHour.map((d) => d.hour)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('refuses to emit a city with zero day-peaks', () => {
    expect(() => buildCityClimatology({ ...base, peaks: [], warmMonths: [7] })).toThrow(/zero day-peaks/);
  });
});
