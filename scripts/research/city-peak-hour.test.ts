/**
 * Tests for the pure core of the ERA5 peak-hour pipeline (scripts/research/city-peak-hour): URL construction,
 * payload parsing, day-peak grouping, the correlation metric, and the KNMI self-check comparison — the parts
 * that must be right for the fetched numbers (and the pipeline-validation gate) to mean anything. Network +
 * disk are exercised only by the CLI; here everything is fed synthetic inputs. Mirrors the discipline of the
 * script's own sanity() self-test but as first-class vitest cases.
 */
import { describe, expect, it } from 'vitest';
import { AMSTERDAM_CLIMATOLOGY } from '../../packages/core/src/index.ts';
import { DECISION_HOURS, type DayPeakLike } from './amsterdam-climatology-emit.ts';
import {
  archiveHourlyUrl,
  buildDayPeaks,
  parseHourlyPayload,
  pearson,
  sanity,
  selfCheckAgainstKnmi,
  SELF_CHECK_TOLERANCE,
  type HourObs,
} from './city-peak-hour.ts';

describe('city-peak-hour pure helpers', () => {
  it('sanity() self-test passes (url/parse/day-peaks/pearson/self-check)', () => {
    expect(() => sanity()).not.toThrow();
  });

  it('archiveHourlyUrl encodes the IANA tz and spans the whole year', () => {
    const u = archiveHourlyUrl({ lat: 1.35, lon: 103.99, tz: 'Asia/Singapore' }, 2021);
    expect(u).toContain('archive-api.open-meteo.com/v1/archive');
    expect(u).toContain('latitude=1.35');
    expect(u).toContain('longitude=103.99');
    expect(u).toContain('hourly=temperature_2m');
    expect(u).toContain('timezone=Asia%2FSingapore'); // encoded slash
    expect(u).toContain('start_date=2021-01-01');
    expect(u).toContain('end_date=2021-12-31');
    // NO api key, NO other vars — the free, single-variable request
    expect(u).not.toMatch(/apikey|key=/);
  });

  it('parseHourlyPayload skips nulls/malformed and converts °C to tenths', () => {
    const obs = parseHourlyPayload({
      time: ['2020-07-01T00:00', '2020-07-01T14:00', 'nope', '2020-07-01T15:00', '2020-07-01T25:00'],
      temperature_2m: [16.14, 21.4, 9, null, 10],
    });
    expect(obs).toHaveLength(2);
    expect(obs[0]).toEqual({ localDate: '2020-07-01', localHour: 0, tenths: 161 }); // round(16.14*10)
    expect(obs[1]).toEqual({ localDate: '2020-07-01', localHour: 14, tenths: 214 });
  });

  it('parseHourlyPayload tolerates mismatched/absent arrays', () => {
    expect(parseHourlyPayload({ time: [], temperature_2m: [] })).toEqual([]);
    // @ts-expect-error deliberately malformed payload
    expect(parseHourlyPayload({ time: undefined, temperature_2m: undefined })).toEqual([]);
  });

  it('buildDayPeaks finds the peak local hour + max, drops incomplete days, tags the month', () => {
    // a full day rising to 25°C @15:00 then falling
    const full: HourObs[] = [];
    for (let h = 0; h < 24; h++) {
      const c = h <= 15 ? 10 + h : 10 + (30 - h);
      full.push({ localDate: '2020-08-03', localHour: h, tenths: c * 10 });
    }
    const peaks = buildDayPeaks(full);
    expect(peaks).toHaveLength(1);
    expect(peaks[0]).toMatchObject({ month: 8, maxC: 25, peakLocalHour: 15 });
    expect(peaks[0]!.byLocalHour.get(15)).toBe(250);

    // fewer than minHours (default 20) → dropped
    expect(buildDayPeaks(full.slice(0, 10))).toHaveLength(0);
    // custom minHours
    expect(buildDayPeaks(full.slice(0, 10), 10)).toHaveLength(1);
  });

  it('buildDayPeaks keeps the FIRST reading at a repeated local hour (DST fold determinism)', () => {
    const rows: HourObs[] = [];
    for (let h = 0; h < 24; h++) rows.push({ localDate: '2021-03-28', localHour: h, tenths: 100 + h });
    rows.push({ localDate: '2021-03-28', localHour: 2, tenths: 999 }); // a duplicated local hour
    const p = buildDayPeaks(rows)[0]!;
    expect(p.byLocalHour.get(2)).toBe(102); // first-seen wins, not the 999 dup
  });

  it('pearson: perfect, anti, and degenerate', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 10);
    expect(Number.isNaN(pearson([], []))).toBe(true);
    expect(Number.isNaN(pearson([5, 5, 5], [1, 2, 3]))).toBe(true); // zero variance
  });
});

describe('selfCheckAgainstKnmi (pipeline-validation gate)', () => {
  /** Build synthetic ERA5 day-peaks whose per-month peak hour = KNMI median + `shiftH`. */
  const synthPeaks = (shiftH: number): DayPeakLike[] => {
    const out: DayPeakLike[] = [];
    for (const km of AMSTERDAM_CLIMATOLOGY.months) {
      const peakHour = Math.min(23, Math.max(0, km.medianPeakHour + shiftH));
      for (let i = 0; i < 60; i++) {
        const byLocalHour = new Map<number, number>();
        for (let h = 0; h < 24; h++) byLocalHour.set(h, h <= peakHour ? 100 + h : 100 + (2 * peakHour - h));
        out.push({ month: km.month, maxC: (100 + peakHour) / 10, peakLocalHour: peakHour, byLocalHour });
      }
    }
    return out;
  };

  it('aligned peak hours reproduce KNMI → high correlation, worst month within ±1h', () => {
    const res = selfCheckAgainstKnmi(synthPeaks(0));
    expect(res.nPeakedCells).toBe(12 * DECISION_HOURS.length);
    expect(res.peakedCorr).toBeGreaterThanOrEqual(SELF_CHECK_TOLERANCE.minPeakedCorr);
    expect(res.medianHourMaxDiff).toBeLessThanOrEqual(SELF_CHECK_TOLERANCE.maxMedianHourDiff);
  });

  it('a several-hour peak shift (the shape of a tz bug) FAILS the gate', () => {
    const res = selfCheckAgainstKnmi(synthPeaks(4));
    expect(res.medianHourMaxDiff).toBeGreaterThan(SELF_CHECK_TOLERANCE.maxMedianHourDiff);
    expect(res.pass).toBe(false);
  });

  it('empty ERA5 input yields no cells and does not throw', () => {
    const res = selfCheckAgainstKnmi([]);
    expect(res.nPeakedCells).toBe(0);
    expect(res.pass).toBe(false);
  });
});
