/**
 * Google Maps Platform Weather API — external comparison source (§ source_forecasts).
 *
 * The daily forecast (`/v1/forecast/days:lookup`) returns up to 10 days of per-day aggregates directly:
 * `forecastDays[].maxTemperature.degrees` (°C when unitsSystem=METRIC), keyed by `forecastDays[].displayDate`
 * (`{year,month,day}` — the location-LOCAL calendar day, so no aggregation or tz conversion is needed, like
 * WeatherAPI and unlike OpenWeatherMap's 3-hourly feed). pageSize is set to cover the requested days so the
 * single capture-loop fetch needs no pagination.
 *
 * NO DEEP HISTORY. The Weather API's history endpoint caps at 24 hours — there is NOTHING to backfill; this is a
 * FORWARD comparison source (it accumulates from the moment the cron/seed first runs). Its forecasting shares the
 * IBM/The-Weather-Company lineage of the Wunderground market-resolution source, so it is a high-value lens on the
 * resolved truth — tracked alongside openweathermap/weatherapi and scored vs WU/IEM truth (source_accuracy),
 * deliberately ISOLATED from the trading blend until a deliberate promotion (migration 0025).
 */
import { SourceShapeError } from '../errors.ts';

const GOOGLE_WEATHER_BASE = 'https://weather.googleapis.com';

/** daily-forecast URL — up to 10 days, °C; pageSize covers the days so the single fetch returns one page. */
export function googleForecastUrl(
  coords: { lat: number; lon: number },
  apiKey: string,
  days = 10,
  base = GOOGLE_WEATHER_BASE,
): string {
  const u = new URL(`${base}/v1/forecast/days:lookup`);
  u.searchParams.set('key', apiKey);
  u.searchParams.set('location.latitude', String(coords.lat));
  u.searchParams.set('location.longitude', String(coords.lon));
  u.searchParams.set('days', String(days));
  u.searchParams.set('pageSize', String(days)); // one page — the capture loop does a single fetch (no pagination)
  u.searchParams.set('unitsSystem', 'METRIC'); // → maxTemperature.degrees in °C (the unit field is still honored below)
  return u.toString();
}

interface GoogleForecastDay {
  displayDate?: { year?: unknown; month?: unknown; day?: unknown };
  maxTemperature?: { degrees?: unknown; unit?: unknown };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Per-day max temperature (°C) from forecastDays[]. Unit-defensive: converts if the API returns FAHRENHEIT. */
export function parseGoogleDailyMax(json: unknown): { targetDate: string; tmaxC: number }[] {
  const root = json as { error?: { message?: unknown; status?: unknown }; forecastDays?: unknown };
  if (root?.error) {
    throw new SourceShapeError(`Google Weather error: ${String(root.error.message ?? root.error.status ?? 'unknown')}`);
  }
  const fd = root?.forecastDays;
  if (!Array.isArray(fd)) {
    throw new SourceShapeError('Google Weather forecastDays is not an array');
  }
  return (fd as GoogleForecastDay[]).map((e) => {
    const d = e?.displayDate;
    const degrees = e?.maxTemperature?.degrees;
    if (
      typeof d?.year !== 'number' || typeof d?.month !== 'number' || typeof d?.day !== 'number' ||
      typeof degrees !== 'number'
    ) {
      throw new SourceShapeError('Google Weather forecastDay missing displayDate or maxTemperature.degrees');
    }
    const unit = String(e?.maxTemperature?.unit ?? 'CELSIUS').toUpperCase();
    const c = unit === 'FAHRENHEIT' ? ((degrees - 32) * 5) / 9 : degrees;
    return { targetDate: `${d.year}-${pad2(d.month)}-${pad2(d.day)}`, tmaxC: Math.round(c * 100) / 100 };
  });
}
