/**
 * _shared/source-capture — external comparison-source daily-max capture
 * (ARCHITECTURE.md § external-source accuracy tracking; migration 0025).
 *
 * The pure fetch → parse → lead loop shared by BOTH the snapshot-sources Edge
 * Function (the autonomous twice-daily cron) and scripts/snapshot-source-forecasts.ts
 * (the local/manual seed) so the capture semantics — lead window, AM/PM slot,
 * per-station error isolation — can never drift between them. No DB access: the
 * caller lists the stations and upserts the returned rows via upsert_source_forecasts.
 *
 * Deliberately ISOLATED from trading: these sources are scored against the same
 * WU/IEM truth (source_accuracy) but never enter list_enabled_models, the house
 * blend, or run-calibration's model_stats.
 */
import {
  leadDays,
  owmForecastUrl,
  parseOwmDailyMax,
  parseWeatherApiDailyMax,
  weatherApiForecastUrl,
} from '../../../packages/core/src/index.ts';

export interface SourceDef {
  source: string;
  url: (coords: { lat: number; lon: number }) => string;
  parse: (json: unknown, tz: string) => { targetDate: string; tmaxC: number }[];
}

export interface StationCoord {
  icao: string;
  lat: number;
  lon: number;
  tz: string;
}

/** A source_forecasts row — the upsert_source_forecasts jsonb element shape (0025). */
export interface SourceRow {
  icao: string;
  source: string;
  target_date: string;
  lead_days: number;
  snapshot_slot: '10Z' | '22Z';
  tmax_c: number;
  captured_at: string;
}

export interface CaptureResult {
  rows: SourceRow[];
  perSource: Record<string, number>;
  failures: number;
  slot: '10Z' | '22Z';
}

/** Two captures/day, mirroring the Open-Meteo 10Z/22Z cadence (UTC hour < 16 ⇒ AM). */
export function slotForHour(now: Date): '10Z' | '22Z' {
  return now.getUTCHours() < 16 ? '10Z' : '22Z';
}

/**
 * Fetch every source for every station, derive the lead off the station-local
 * target date, and build source_forecasts rows. A source erroring on one
 * station increments `failures` and is skipped — never fatal (one dead key or a
 * single upstream blip must not lose the whole capture). Leads outside 0..16 are
 * dropped (the source_forecasts check constraint upper bound).
 */
export async function captureSourceForecasts(
  stations: StationCoord[],
  sources: SourceDef[],
  fetchJson: (url: string) => Promise<unknown>,
  now: Date,
): Promise<CaptureResult> {
  const slot = slotForHour(now);
  const rows: SourceRow[] = [];
  const perSource: Record<string, number> = {};
  let failures = 0;

  for (const st of stations) {
    for (const src of sources) {
      try {
        const json = await fetchJson(src.url({ lat: Number(st.lat), lon: Number(st.lon) }));
        const days = src.parse(json, st.tz);
        for (const d of days) {
          const lead = leadDays(now, d.targetDate, st.tz);
          if (lead < 0 || lead > 16) continue;
          rows.push({
            icao: st.icao,
            source: src.source,
            target_date: d.targetDate,
            lead_days: lead,
            snapshot_slot: slot,
            tmax_c: d.tmaxC,
            captured_at: now.toISOString(),
          });
          perSource[src.source] = (perSource[src.source] ?? 0) + 1;
        }
      } catch {
        failures++;
      }
    }
  }
  return { rows, perSource, failures, slot };
}

/** Build the live source list from whatever API keys are present (env-agnostic). */
export function sourcesFromKeys(keys: { owm?: string | undefined; weatherapi?: string | undefined }): SourceDef[] {
  const sources: SourceDef[] = [];
  if (keys.owm) {
    const owmKey = keys.owm;
    sources.push({
      source: 'openweathermap',
      url: (c) => owmForecastUrl(c, owmKey),
      parse: parseOwmDailyMax,
    });
  }
  if (keys.weatherapi) {
    const waKey = keys.weatherapi;
    sources.push({
      source: 'weatherapi',
      url: (c) => weatherApiForecastUrl(c, waKey),
      parse: (json) => parseWeatherApiDailyMax(json), // date is already location-local; tz unused
    });
  }
  return sources;
}
