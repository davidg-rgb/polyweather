/**
 * Tests for the forecast-lookup + enrich pure helpers (the DB/stream I/O runs live). Pins: °C→native
 * conversion, the predicted-bucket assignment (floor + open tails), the per-event pivot, the wide CSV row, and
 * the enrich column contract (the appended columns match the lookup header tail; blanks for a missing event).
 */
import { describe, expect, it } from 'vitest';
import {
  toNative,
  predictedBucket,
  pivotForecasts,
  forecastRow,
  FORECAST_HEADER,
  type BucketSpan,
} from './build-forecast-lookup.ts';
import { APPENDED_COLS } from './enrich-market-history.ts';

describe('toNative', () => {
  it('converts to °F only for a Fahrenheit city', () => {
    expect(toNative(30, 'C')).toBe(30);
    expect(toNative(30, 'F')).toBe(86); // 30°C = 86°F
    expect(toNative(0, 'fahrenheit')).toBe(32);
    expect(toNative(null, 'F')).toBeNull();
    expect(toNative(Number.NaN, 'C')).toBeNull();
  });
});

describe('predictedBucket', () => {
  const buckets: BucketSpan[] = [
    { idx: 0, low: null, high: 21 }, // "≤21"
    { idx: 1, low: 22, high: 22 },
    { idx: 2, low: 23, high: 23 },
    { idx: 3, low: 24, high: null }, // "≥24"
  ];
  it('floors the prediction to the °bin and finds the span (open tails clamp)', () => {
    expect(predictedBucket(22.7, buckets)).toBe(1); // floor 22 → bucket 1
    expect(predictedBucket(23.0, buckets)).toBe(2);
    expect(predictedBucket(19.4, buckets)).toBe(0); // lower tail
    expect(predictedBucket(40, buckets)).toBe(3);   // upper tail
    expect(predictedBucket(null, buckets)).toBeNull();
    expect(predictedBucket(22, [])).toBeNull();
  });
});

describe('pivotForecasts + forecastRow', () => {
  it('pivots per-(event,lead) rows into one native-unit event row with the predicted bucket', () => {
    const rows = [
      { event_id: 'E', city: 'amsterdam', unit: 'C', weather_date: '2026-06-20', lead_days: 0, tmax_c_blend: 31.2, tmax_c_raw: 31.8, n_models: 8 },
      { event_id: 'E', city: 'amsterdam', unit: 'C', weather_date: '2026-06-20', lead_days: 1, tmax_c_blend: 30.6, tmax_c_raw: 31.0, n_models: 8 },
      { event_id: 'E', city: 'amsterdam', unit: 'C', weather_date: '2026-06-20', lead_days: 2, tmax_c_blend: 29.4, tmax_c_raw: 30.1, n_models: 7 },
    ];
    const ev = pivotForecasts(rows).get('E')!;
    expect(ev.predC[0]).toBeCloseTo(31.2, 6);
    expect(ev.predRaw[2]).toBeCloseTo(30.1, 6);
    const buckets: BucketSpan[] = [
      { idx: 0, low: null, high: 29 }, { idx: 1, low: 30, high: 30 }, { idx: 2, low: 31, high: null },
    ];
    // row order: event_id,fc_city,weather_date,unit, pred_c_l2,l1,l0, pred_raw_l2,l1,l0, pred_bucket_l2,l1,l0
    const cells = forecastRow(ev, buckets).split(',');
    expect(cells[0]).toBe('E');
    expect(cells[4]).toBe('29.4'); // pred_c_l2
    expect(cells[6]).toBe('31.2'); // pred_c_l0
    expect(cells[10]).toBe('0');   // pred_bucket_l2 (floor 29.4 = 29 → bucket 0)
    expect(cells[11]).toBe('1');   // pred_bucket_l1 (floor 30.6 = 30 → bucket 1)
    expect(cells[12]).toBe('2');   // pred_bucket_l0 (floor 31.2 = 31 → bucket 2)
  });

  it('converts to °F for a Fahrenheit city', () => {
    const ev = pivotForecasts([
      { event_id: 'N', city: 'nyc', unit: 'F', weather_date: '2026-06-20', lead_days: 0, tmax_c_blend: 30, tmax_c_raw: 30, n_models: 8 },
    ]).get('N')!;
    expect(ev.predC[0]).toBe(86); // 30°C → 86°F
  });
});

describe('the enrich column contract', () => {
  it('the appended columns are exactly the lookup header minus its 4 meta cols', () => {
    const headerCols = FORECAST_HEADER.split(',');
    expect(APPENDED_COLS).toEqual(headerCols.slice(4));
    expect(APPENDED_COLS).toContain('pred_c_l0');
    expect(APPENDED_COLS).toContain('pred_bucket_l2');
    expect(APPENDED_COLS.length).toBe(9);
  });
});
