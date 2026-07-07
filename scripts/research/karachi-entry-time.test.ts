import { describe, expect, it } from 'vitest';
import {
  bootstrapMeanP10,
  gapToFavorite,
  hrsBeforeBin,
  localHourToUtc,
  netReturn,
  parseForecastCsv,
  priceAtLocalHour,
  quantile,
  trendSlope,
} from './karachi-entry-time.ts';

describe('localHourToUtc', () => {
  it('maps local midnight of the weather day to UTC-5h (Karachi UTC+5)', () => {
    // 2026-05-14 00:00 +05:00 === 2026-05-13T19:00:00Z
    expect(localHourToUtc('2026-05-14', 0)).toBe(Date.parse('2026-05-13T19:00:00Z') / 1000);
  });
  it('adds h hours on top of local midnight', () => {
    expect(localHourToUtc('2026-05-14', 14)).toBe(localHourToUtc('2026-05-14', 0) + 14 * 3600);
  });
});

describe('priceAtLocalHour', () => {
  const pts: Array<[number, number]> = [
    [1000, 0.2],
    [2000, 0.3],
    [3000, 0.4],
  ];
  it('returns the LAST point at or before the target within the window', () => {
    expect(priceAtLocalHour(pts, 2500, 3600)).toBe(0.3); // last point ≤ 2500
    expect(priceAtLocalHour(pts, 3000, 3600)).toBe(0.4); // exact hit is inclusive
  });
  it('returns null when the last in-range point is older than the window (thin/expired book)', () => {
    // target 10000, 90-min window = 5400s → earliest allowed 4600; newest point 3000 < 4600 → no entry
    expect(priceAtLocalHour(pts, 10000, 5400)).toBeNull();
  });
  it('returns null when every point is after the target', () => {
    expect(priceAtLocalHour(pts, 500, 5400)).toBeNull();
  });
});

describe('netReturn', () => {
  it('pays (1−p)/p on a win, −1 on a loss', () => {
    expect(netReturn(true, 0.4)).toBeCloseTo(1.5, 10); // 0.6/0.4
    expect(netReturn(true, 0.5)).toBeCloseTo(1.0, 10);
    expect(netReturn(false, 0.4)).toBe(-1);
    expect(netReturn(false, 0.99)).toBe(-1);
  });
});

describe('gapToFavorite', () => {
  it('is predicted mid minus the best OTHER bucket (negative = market favours another bucket)', () => {
    expect(gapToFavorite(0.3, [0.1, 0.5, 0.2])).toBeCloseTo(0.3 - 0.5, 10); // −0.2, diverges
    expect(gapToFavorite(0.6, [0.1, 0.2])).toBeCloseTo(0.4, 10); // +0.4, market agrees
  });
  it('ignores null/NaN other buckets and returns null when none are priced', () => {
    expect(gapToFavorite(0.3, [null, 0.5])).toBeCloseTo(-0.2, 10);
    expect(gapToFavorite(0.3, [null, null])).toBeNull();
  });
});

describe('trendSlope', () => {
  it('recovers the slope of a linear rising series (prob per hour)', () => {
    // +0.1 prob per hour: at t=targetUtc−7200 p=0.2, −3600 p=0.3, 0 p=0.4
    const pts: Array<[number, number]> = [
      [10000 - 7200, 0.2],
      [10000 - 3600, 0.3],
      [10000, 0.4],
    ];
    expect(trendSlope(pts, 10000, 10800)!).toBeCloseTo(0.1, 6);
  });
  it('is negative for a falling series and null with < 2 points in window', () => {
    const falling: Array<[number, number]> = [
      [10000 - 3600, 0.5],
      [10000, 0.2],
    ];
    expect(trendSlope(falling, 10000, 10800)!).toBeLessThan(0);
    expect(trendSlope(falling, 10000, 60)).toBeNull(); // only the last point falls in a 60s window
  });
});

describe('bootstrapMeanP10', () => {
  it('is deterministic for a given seed (reproducible run to run)', () => {
    const xs = [1.5, -1, 1.5, -1, 1.5, -1, 1.5, -1, 1.5, -1];
    expect(bootstrapMeanP10(xs, 42)).toBe(bootstrapMeanP10(xs, 42));
  });
  it('collapses to the constant for a zero-variance sample', () => {
    expect(bootstrapMeanP10([0.5, 0.5, 0.5, 0.5], 42)).toBeCloseTo(0.5, 10);
  });
  it('sits at or below the sample mean (a shrinkage lower bound)', () => {
    const xs = [1.5, -1, 1.5, -1, 1.5, -1, 1.5, -1, 1.5, 1.5];
    const m = xs.reduce((a, v) => a + v, 0) / xs.length;
    expect(bootstrapMeanP10(xs, 42)).toBeLessThanOrEqual(m + 1e-9);
  });
});

describe('hrsBeforeBin', () => {
  it('buckets hours-before-resolution into 6h bins capped at 48+', () => {
    expect(hrsBeforeBin(0)).toBe('0-6');
    expect(hrsBeforeBin(5.9)).toBe('0-6');
    expect(hrsBeforeBin(6)).toBe('6-12');
    expect(hrsBeforeBin(47)).toBe('42-48');
    expect(hrsBeforeBin(48)).toBe('48+');
    expect(hrsBeforeBin(200)).toBe('48+');
  });
});

describe('quantile', () => {
  it('interpolates like a linear percentile', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([10, 20, 30], 0.1)).toBeCloseTo(12, 10);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('parseForecastCsv', () => {
  it('keeps only karachi rows and maps eventId → predicted bucket idx (l0/l1/l2)', () => {
    const text =
      'event_id,fc_city,weather_date,unit,pred_c_l2,pred_c_l1,pred_c_l0,pred_raw_l2,pred_raw_l1,pred_raw_l0,pred_bucket_l2,pred_bucket_l1,pred_bucket_l0\n' +
      '476147,karachi,2026-05-14,C,37,36,35,37,36,35,10,10,9\n' +
      '999,singapore,2026-05-14,C,30,30,30,30,30,30,3,3,3\n';
    const m = parseForecastCsv(text);
    expect(m.size).toBe(1);
    expect(m.get('476147')).toEqual({ predL0: 9, predL1: 10, predL2: 10 });
    expect(m.get('999')).toBeUndefined();
  });
});
