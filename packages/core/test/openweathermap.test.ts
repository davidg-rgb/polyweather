import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { owmForecastUrl, parseOwmDailyMax, SourceShapeError } from '../src/index.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', '..', 'research');
const fixture = (f: string): unknown => JSON.parse(readFileSync(join(RESEARCH, f), 'utf8'));

describe('OpenWeatherMap source (§ source_forecasts)', () => {
  it('owmForecastUrl — metric 5-day/3-hour shape', () => {
    expect(owmForecastUrl({ lat: 37.4691, lon: 126.4505 }, 'TESTKEY')).toBe(
      'https://api.openweathermap.org/data/2.5/forecast?lat=37.4691&lon=126.4505&appid=TESTKEY&units=metric',
    );
  });

  it('parseOwmDailyMax — RKSI (Asia/Seoul) per-local-day max, afternoon-gated', () => {
    // Hand-verified from the live fixture via zoneinfo. UTC day 06-13 has no
    // afternoon-local points (all shift to 06-14+ at +9) → dropped.
    expect(parseOwmDailyMax(fixture('openweathermap_forecast_RKSI.json'), 'Asia/Seoul')).toEqual([
      { targetDate: '2026-06-14', tmaxC: 19.32 },
      { targetDate: '2026-06-15', tmaxC: 19.64 },
      { targetDate: '2026-06-16', tmaxC: 20.16 },
      { targetDate: '2026-06-17', tmaxC: 19.93 },
      { targetDate: '2026-06-18', tmaxC: 19.98 },
    ]);
  });

  it('parseOwmDailyMax — KORD (America/Chicago) per-local-day max', () => {
    expect(parseOwmDailyMax(fixture('openweathermap_forecast_KORD.json'), 'America/Chicago')).toEqual([
      { targetDate: '2026-06-13', tmaxC: 28.23 },
      { targetDate: '2026-06-14', tmaxC: 21.86 },
      { targetDate: '2026-06-15', tmaxC: 24.27 },
      { targetDate: '2026-06-16', tmaxC: 25.68 },
      { targetDate: '2026-06-17', tmaxC: 23.3 },
    ]);
  });

  it('drops a local day whose points miss the afternoon peak window', () => {
    // a single early-morning point (06:00 local) → no afternoon coverage → dropped
    const json = { cod: '200', list: [{ dt: Date.parse('2026-06-20T21:00:00Z') / 1000, main: { temp_max: 30 } }] };
    // 21:00Z is 06:00 next day in Seoul (+9) → local hour 6, not in [12,17]
    expect(parseOwmDailyMax(json, 'Asia/Seoul')).toEqual([]);
  });

  it('throws SourceShapeError on an error cod, a non-array list, or a missing temp', () => {
    expect(() => parseOwmDailyMax({ cod: '401', message: 'Invalid API key.' }, 'Asia/Seoul')).toThrow(SourceShapeError);
    expect(() => parseOwmDailyMax({ cod: '200', list: {} }, 'Asia/Seoul')).toThrow(SourceShapeError);
    expect(() =>
      parseOwmDailyMax({ cod: '200', list: [{ dt: 1781362800, main: {} }] }, 'Asia/Seoul'),
    ).toThrow(SourceShapeError);
  });
});
