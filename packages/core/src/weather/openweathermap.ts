/**
 * OpenWeatherMap — external comparison source (§ source_forecasts).
 *
 * Free "5 day / 3 hour" forecast: api.openweathermap.org/data/2.5/forecast.
 * Returns 3-hourly points (`dt` UTC epoch seconds, `main.temp_max` in the
 * requested units). We always request units=metric → °C. The daily max is the
 * max over a station-LOCAL day; a day is emitted only when its points sample the
 * afternoon peak window (local hour 12–17), so partial first/last days that miss
 * the peak are dropped rather than understating it. Ground truth:
 * research/openweathermap_forecast_{RKSI,KORD}.json.
 */
import { SourceShapeError } from '../errors.ts';
import { localDateAt, localHour } from '../time.ts';

const OWM_BASE = 'https://api.openweathermap.org';

/** 5-day/3-hour forecast URL. units=metric → temp_max in °C. */
export function owmForecastUrl(coords: { lat: number; lon: number }, apiKey: string, base = OWM_BASE): string {
  const u = new URL(`${base}/data/2.5/forecast`);
  u.searchParams.set('lat', String(coords.lat));
  u.searchParams.set('lon', String(coords.lon));
  u.searchParams.set('appid', apiKey);
  u.searchParams.set('units', 'metric');
  return u.toString();
}

interface OwmEntry {
  dt: number;
  main?: { temp_max?: number };
}

/** Per-local-day max temperature (°C) from the 3-hourly forecast. */
export function parseOwmDailyMax(json: unknown, tz: string): { targetDate: string; tmaxC: number }[] {
  const root = json as { cod?: unknown; list?: unknown };
  if (root?.cod !== undefined && String(root.cod) !== '200') {
    throw new SourceShapeError(`OpenWeatherMap cod=${String(root.cod)}`, { cod: root.cod });
  }
  if (!Array.isArray(root?.list)) {
    throw new SourceShapeError('OpenWeatherMap forecast.list is not an array');
  }

  const byDay = new Map<string, { max: number; afternoon: boolean }>();
  for (const raw of root.list as unknown[]) {
    const e = raw as OwmEntry;
    if (typeof e?.dt !== 'number' || typeof e?.main?.temp_max !== 'number') {
      throw new SourceShapeError('OpenWeatherMap entry missing dt or main.temp_max');
    }
    const instant = new Date(e.dt * 1000);
    const day = localDateAt(tz, instant);
    const hr = localHour(tz, instant);
    const cur = byDay.get(day) ?? { max: -Infinity, afternoon: false };
    cur.max = Math.max(cur.max, e.main.temp_max);
    if (hr >= 12 && hr <= 17) cur.afternoon = true;
    byDay.set(day, cur);
  }

  return [...byDay.entries()]
    .filter(([, v]) => v.afternoon && Number.isFinite(v.max))
    .map(([targetDate, v]) => ({ targetDate, tmaxC: Math.round(v.max * 100) / 100 }))
    .sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}
