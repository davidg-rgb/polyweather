import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { weatherApiForecastUrl, parseWeatherApiDailyMax, SourceShapeError } from '../src/index.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', '..', 'research');
const fixture = (f: string): unknown => JSON.parse(readFileSync(join(RESEARCH, f), 'utf8'));

describe('WeatherAPI.com source (§ source_forecasts)', () => {
  it('weatherApiForecastUrl — q="lat,lon", 3-day, weather-only', () => {
    expect(weatherApiForecastUrl({ lat: 37.4691, lon: 126.4505 }, 'TESTKEY')).toBe(
      'https://api.weatherapi.com/v1/forecast.json?key=TESTKEY&q=37.4691%2C126.4505&days=3&aqi=no&alerts=no',
    );
  });

  it('parseWeatherApiDailyMax — RKSI daily maxes (already local-date)', () => {
    expect(parseWeatherApiDailyMax(fixture('weatherapi_forecast_RKSI.json'))).toEqual([
      { targetDate: '2026-06-13', tmaxC: 24.7 },
      { targetDate: '2026-06-14', tmaxC: 23.9 },
      { targetDate: '2026-06-15', tmaxC: 24.2 },
    ]);
  });

  it('parseWeatherApiDailyMax — KORD daily maxes', () => {
    expect(parseWeatherApiDailyMax(fixture('weatherapi_forecast_KORD.json'))).toEqual([
      { targetDate: '2026-06-13', tmaxC: 33.3 },
      { targetDate: '2026-06-14', tmaxC: 21.2 },
      { targetDate: '2026-06-15', tmaxC: 23.6 },
    ]);
  });

  it('throws SourceShapeError on an error body, a missing forecast, or a missing max', () => {
    expect(() => parseWeatherApiDailyMax({ error: { code: 2006, message: 'API key is invalid.' } })).toThrow(
      SourceShapeError,
    );
    expect(() => parseWeatherApiDailyMax({ forecast: {} })).toThrow(SourceShapeError);
    expect(() => parseWeatherApiDailyMax({ forecast: { forecastday: [{ date: '2026-06-13', day: {} }] } })).toThrow(
      SourceShapeError,
    );
  });
});
