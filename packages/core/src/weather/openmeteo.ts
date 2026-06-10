/**
 * core/weather/openmeteo — Open-Meteo URLs & parsers (ARCHITECTURE.md §6.10). Pure.
 *
 * Every URL shape and payload key is live-verified in research/REPORT-weather-data.md;
 * the `base` host is caller config (free vs customer- paid hosts — identical params).
 */
import { z } from 'zod';
import { OpenMeteoShapeError } from '../errors.ts';

export interface StationCoords {
  lat: number;
  lon: number;
}

/** The live-verified working model set — KMA/ecmwf_ifs04/gfs025 are traps (accepted, zero data). */
export const KNOWN_FORECAST_MODELS = new Set([
  'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless', 'gem_seamless',
  'meteofrance_seamless', 'ukmo_seamless', 'cma_grapes_global', 'best_match',
]);

function assertKnownModels(models: string[]): void {
  const unknown = models.filter((m) => !KNOWN_FORECAST_MODELS.has(m));
  if (unknown.length > 0) {
    throw new OpenMeteoShapeError(`unknown forecast model(s): ${unknown.join(', ')}`, { unknown });
  }
  if (models.length === 0) {
    throw new OpenMeteoShapeError('empty model list');
  }
}

const withKey = (url: string, apikey?: string) => (apikey ? `${url}&apikey=${apikey}` : url);

/** Multi-model daily snapshot URL (the research-verified working shape). */
export function forecastUrl(
  base: string,
  st: StationCoords,
  models: string[],
  days: number,
  apikey?: string,
): string {
  assertKnownModels(models);
  return withKey(
    `${base}/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&daily=temperature_2m_max&timezone=auto&forecast_days=${days}&models=${models.join(',')}`,
    apikey,
  );
}

const DailySchema = z.object({
  daily: z.object({ time: z.array(z.string()) }).passthrough(),
});

/**
 * Read daily.time[] × temperature_2m_max_{model} suffixed arrays; null entries
 * skipped (per-model horizon). Per-model absence tolerated; ALL models absent
 * → OpenMeteoShapeError (upstream shape change).
 *
 * SINGLE-MODEL CALLS DROP THE SUFFIX (live-verified 2026-06-11, fixture
 * openmeteo_historical_forecast_daily_single_model_RKSI.json): when exactly
 * one model was requested and its suffixed key is absent, the bare
 * `temperature_2m_max` series is that model's data.
 */
export function parseMultiModelDaily(
  json: unknown,
  models: string[],
): { model: string; targetDate: string; tmaxC: number }[] {
  const parsed = DailySchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenMeteoShapeError('payload has no daily.time[]', { issues: parsed.error.issues });
  }
  const daily = parsed.data.daily as Record<string, unknown> & { time: string[] };
  const rows: { model: string; targetDate: string; tmaxC: number }[] = [];
  let presentModels = 0;
  for (const model of models) {
    const raw = daily[`temperature_2m_max_${model}`] ??
      (models.length === 1 ? daily['temperature_2m_max'] : undefined); // unsuffixed single-model shape
    if (!Array.isArray(raw)) continue; // tolerated — logged by the caller
    const series: unknown[] = raw;
    presentModels++;
    daily.time.forEach((date, i) => {
      const v = series[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        rows.push({ model, targetDate: date, tmaxC: v });
      }
    });
  }
  if (presentModels === 0) {
    throw new OpenMeteoShapeError(`none of the requested models present in daily payload`, { models });
  }
  return rows;
}

/** Previous-Runs hourly URL — the lead-time dimension (daily-max not supported there). */
export function previousRunsUrl(
  base: string,
  st: StationCoords,
  models: string[],
  leads: number[],
  dates?: { start: string; end: string },
  apikey?: string,
): string {
  assertKnownModels(models);
  const vars = leads
    .map((l) => (l === 0 ? 'temperature_2m' : `temperature_2m_previous_day${l}`))
    .join(',');
  const range = dates ? `&start_date=${dates.start}&end_date=${dates.end}` : '';
  return withKey(
    `${base}/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&hourly=${vars}&timezone=auto&models=${models.join(',')}${range}`,
    apikey,
  );
}

const HourlySchema = z.object({
  hourly: z.object({ time: z.array(z.string()) }).passthrough(),
});

/**
 * Group the hourly series by local day and take the max per (model, lead, day);
 * days with < 20 hourly points are dropped (partial-day guard).
 *
 * Day grouping uses the payload's own local-time stamps: previousRunsUrl always
 * sets timezone=auto, so hourly.time[] is already station-local — the date
 * prefix IS the local day (equivalent to localDayWindow bucketing; the tz
 * param documents the contract and is validated against nothing else here).
 *
 * SINGLE-MODEL CALLS DROP THE `_{model}` SUFFIX (live-verified 2026-06-11,
 * fixture openmeteo_prevruns_hourly_single_model_RKSI.json) — when exactly one
 * model was requested and its suffixed key is absent, the bare per-lead series
 * is that model's data.
 */
export function parsePreviousRunsHourly(
  json: unknown,
  models: string[],
  leads: number[],
  _tz: string,
): { model: string; leadDays: number; targetDate: string; tmaxC: number }[] {
  const parsed = HourlySchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenMeteoShapeError('payload has no hourly.time[]', { issues: parsed.error.issues });
  }
  const hourly = parsed.data.hourly as Record<string, unknown> & { time: string[] };

  const dayIndexes = new Map<string, number[]>();
  hourly.time.forEach((t, i) => {
    const day = t.slice(0, 10);
    const list = dayIndexes.get(day) ?? [];
    list.push(i);
    dayIndexes.set(day, list);
  });

  const rows: { model: string; leadDays: number; targetDate: string; tmaxC: number }[] = [];
  for (const model of models) {
    for (const lead of leads) {
      const key = lead === 0 ? `temperature_2m_${model}` : `temperature_2m_previous_day${lead}_${model}`;
      const raw = hourly[key] ??
        (models.length === 1
          ? hourly[lead === 0 ? 'temperature_2m' : `temperature_2m_previous_day${lead}`]
          : undefined);
      if (!Array.isArray(raw)) continue;
      const series: unknown[] = raw;
      for (const [day, idxs] of dayIndexes) {
        if (idxs.length < 20) continue; // partial local day — never grade a truncated max
        const vals = idxs
          .map((i) => series[i])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
        if (vals.length < 20) continue;
        rows.push({ model, leadDays: lead, targetDate: day, tmaxC: Math.max(...vals) });
      }
    }
  }
  return rows;
}

/** Ensemble per-member daily URL — ONE MODEL PER CALL (I2: the multi-model name-mangled variant has no fixture). */
export function ensembleUrl(
  base: string,
  st: StationCoords,
  model: string,
  days: number,
  apikey?: string,
): string {
  if (model.includes(',')) {
    throw new OpenMeteoShapeError(`ensembleUrl takes ONE model per call (I2), got '${model}'`);
  }
  return withKey(
    `${base}/v1/ensemble?latitude=${st.lat}&longitude=${st.lon}&daily=temperature_2m_max&timezone=auto&forecast_days=${days}&models=${model}`,
    apikey,
  );
}

/**
 * Single-model ensemble daily payload: bare `temperature_2m_max` is the
 * CONTROL (stored as member 0); `temperature_2m_max_memberNN` are the
 * perturbed members (fixture-verified scheme).
 */
export function parseEnsembleDaily(json: unknown): { member: number; targetDate: string; tmaxC: number }[] {
  const parsed = DailySchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenMeteoShapeError('ensemble payload has no daily.time[]', { issues: parsed.error.issues });
  }
  const daily = parsed.data.daily as Record<string, unknown> & { time: string[] };
  const rows: { member: number; targetDate: string; tmaxC: number }[] = [];
  let seriesCount = 0;
  for (const [key, series] of Object.entries(daily)) {
    if (key === 'time' || !Array.isArray(series)) continue;
    let member: number;
    if (key === 'temperature_2m_max') {
      member = 0; // control
    } else {
      const m = /^temperature_2m_max_member(\d+)$/.exec(key);
      if (!m) continue;
      member = Number(m[1]);
    }
    seriesCount++;
    daily.time.forEach((date, i) => {
      const v = series[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        rows.push({ member, targetDate: date, tmaxC: v });
      }
    });
  }
  if (seriesCount === 0) {
    throw new OpenMeteoShapeError('ensemble payload carries no temperature_2m_max series');
  }
  return rows;
}

/** ERA5T archive URL — gridded pseudo-truth sanity column (F-008), ~1-day lag. */
export function archiveUrl(
  base: string,
  st: StationCoords,
  dates: { start: string; end: string },
  apikey?: string,
): string {
  return withKey(
    `${base}/v1/archive?latitude=${st.lat}&longitude=${st.lon}&daily=temperature_2m_max&timezone=auto&start_date=${dates.start}&end_date=${dates.end}`,
    apikey,
  );
}

/** ERA5T daily parse — bare temperature_2m_max series. */
export function parseEra5Daily(json: unknown): { date: string; tmaxC: number }[] {
  const parsed = DailySchema.safeParse(json);
  if (!parsed.success) {
    throw new OpenMeteoShapeError('archive payload has no daily.time[]', { issues: parsed.error.issues });
  }
  const daily = parsed.data.daily as Record<string, unknown> & { time: string[] };
  const series = daily['temperature_2m_max'];
  if (!Array.isArray(series)) {
    throw new OpenMeteoShapeError('archive payload has no temperature_2m_max');
  }
  const rows: { date: string; tmaxC: number }[] = [];
  daily.time.forEach((date, i) => {
    const v = series[i];
    if (typeof v === 'number' && Number.isFinite(v)) rows.push({ date, tmaxC: v });
  });
  return rows;
}

/** Historical Forecast API — day-0 stitched pseudo-truth (NOT lead-time data; see research). */
export function historicalForecastUrl(
  base: string,
  st: StationCoords,
  models: string[],
  dates: { start: string; end: string },
  apikey?: string,
): string {
  assertKnownModels(models);
  return withKey(
    `${base}/v1/forecast?latitude=${st.lat}&longitude=${st.lon}&daily=temperature_2m_max&timezone=auto&models=${models.join(',')}&start_date=${dates.start}&end_date=${dates.end}`,
    apikey,
  );
}

/**
 * Open-Meteo's fractional call accounting: >10 variables and >2-week spans
 * scale the cost multiplicatively — keeps the budgeter under 600/min, 5k/h, 10k/day.
 */
export function requestWeight(varsCount: number, daysSpan: number): number {
  return Math.max(1, varsCount / 10) * Math.max(1, daysSpan / 14);
}
