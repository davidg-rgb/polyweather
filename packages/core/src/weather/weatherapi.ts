/**
 * WeatherAPI.com — external comparison source (§ source_forecasts).
 *
 * Free "forecast.json" gives up to 3 daily aggregates directly:
 * `forecast.forecastday[].day.maxtemp_c`, keyed by `forecastday[].date`
 * (YYYY-MM-DD already in the queried location's local tz — no aggregation or
 * tz conversion needed, unlike OpenWeatherMap's 3-hourly feed). Ground truth:
 * research/weatherapi_forecast_{RKSI,KORD}.json.
 */
import { SourceShapeError } from '../errors.ts';

const WEATHERAPI_BASE = 'https://api.weatherapi.com';

/** forecast.json URL — q="lat,lon", N daily aggregates, weather only. */
export function weatherApiForecastUrl(
  coords: { lat: number; lon: number },
  apiKey: string,
  days = 3,
  base = WEATHERAPI_BASE,
): string {
  const u = new URL(`${base}/v1/forecast.json`);
  u.searchParams.set('key', apiKey);
  u.searchParams.set('q', `${coords.lat},${coords.lon}`);
  u.searchParams.set('days', String(days));
  u.searchParams.set('aqi', 'no');
  u.searchParams.set('alerts', 'no');
  return u.toString();
}

interface ForecastDay {
  date?: unknown;
  day?: { maxtemp_c?: unknown };
}

/** Per-day max temperature (°C) from forecast.forecastday[]. */
export function parseWeatherApiDailyMax(json: unknown): { targetDate: string; tmaxC: number }[] {
  const root = json as { error?: { message?: unknown }; forecast?: { forecastday?: unknown } };
  if (root?.error) {
    throw new SourceShapeError(`WeatherAPI error: ${String(root.error.message ?? 'unknown')}`);
  }
  const fd = root?.forecast?.forecastday;
  if (!Array.isArray(fd)) {
    throw new SourceShapeError('WeatherAPI forecast.forecastday is not an array');
  }
  return (fd as ForecastDay[]).map((e) => {
    if (typeof e?.date !== 'string' || typeof e?.day?.maxtemp_c !== 'number') {
      throw new SourceShapeError('WeatherAPI forecastday missing date or day.maxtemp_c');
    }
    return { targetDate: e.date, tmaxC: Math.round(e.day.maxtemp_c * 100) / 100 };
  });
}
