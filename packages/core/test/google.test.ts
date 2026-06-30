/**
 * Tests for core/weather/google — the Google Maps Platform Weather API comparison source. Pins the daily-forecast
 * URL shape, the forecastDays[].maxTemperature.degrees / displayDate parse (with zero-padded local dates), the
 * unit-defensive Fahrenheit conversion, and the error/shape guards (so a bad key / drifted response never poisons
 * source_forecasts — captureSourceForecasts treats a throw as a per-station failure, not fatal).
 */
import { describe, expect, it } from 'vitest';
import { googleForecastUrl, parseGoogleDailyMax } from '../src/weather/google.ts';
import { SourceShapeError } from '../src/errors.ts';

describe('googleForecastUrl', () => {
  it('builds the daily-forecast lookup URL with location, days, pageSize, and metric units', () => {
    const url = new URL(googleForecastUrl({ lat: 52.31, lon: 4.76 }, 'KEY123'));
    expect(url.origin + url.pathname).toBe('https://weather.googleapis.com/v1/forecast/days:lookup');
    expect(url.searchParams.get('key')).toBe('KEY123');
    expect(url.searchParams.get('location.latitude')).toBe('52.31');
    expect(url.searchParams.get('location.longitude')).toBe('4.76');
    expect(url.searchParams.get('days')).toBe('10'); // the 10-day max
    expect(url.searchParams.get('pageSize')).toBe('10'); // covers the days → single fetch, no pagination
    expect(url.searchParams.get('unitsSystem')).toBe('METRIC');
  });

  it('honors a custom days count + base (for tests/fixtures)', () => {
    const url = new URL(googleForecastUrl({ lat: 1, lon: 2 }, 'K', 3, 'https://example.test'));
    expect(url.origin).toBe('https://example.test');
    expect(url.searchParams.get('days')).toBe('3');
    expect(url.searchParams.get('pageSize')).toBe('3');
  });
});

describe('parseGoogleDailyMax', () => {
  const day = (y: number, m: number, d: number, degrees: number, unit = 'CELSIUS') => ({
    displayDate: { year: y, month: m, day: d },
    maxTemperature: { degrees, unit },
  });

  it('maps forecastDays[] → per-day max with zero-padded local dates', () => {
    const out = parseGoogleDailyMax({ forecastDays: [day(2026, 6, 30, 24.567), day(2026, 7, 1, 19.2)] });
    expect(out).toEqual([
      { targetDate: '2026-06-30', tmaxC: 24.57 }, // rounded to 2dp
      { targetDate: '2026-07-01', tmaxC: 19.2 },
    ]);
  });

  it('converts when the API returns FAHRENHEIT (unit-defensive)', () => {
    const out = parseGoogleDailyMax({ forecastDays: [day(2026, 6, 30, 68, 'FAHRENHEIT')] });
    expect(out[0]!.tmaxC).toBeCloseTo(20, 6); // 68°F = 20°C
  });

  it('throws SourceShapeError on an API error payload', () => {
    expect(() => parseGoogleDailyMax({ error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } })).toThrow(SourceShapeError);
  });

  it('throws when forecastDays is not an array', () => {
    expect(() => parseGoogleDailyMax({})).toThrow(SourceShapeError);
    expect(() => parseGoogleDailyMax({ forecastDays: null })).toThrow(SourceShapeError);
  });

  it('throws when a day is missing displayDate or maxTemperature.degrees', () => {
    expect(() => parseGoogleDailyMax({ forecastDays: [{ maxTemperature: { degrees: 20 } }] })).toThrow(SourceShapeError);
    expect(() => parseGoogleDailyMax({ forecastDays: [{ displayDate: { year: 2026, month: 6, day: 30 } }] })).toThrow(SourceShapeError);
  });
});
