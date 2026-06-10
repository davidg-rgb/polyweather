/**
 * core/weather/wu — Wunderground/TWC v1 observations (ARCHITECTURE.md §6.10). Pure.
 *
 * THE resolution source (api.weather.com v1 hourly obs — NEVER the v3
 * dailysummary, which diverges from the History page; live-verified).
 */
import { z } from 'zod';
import { WuShapeError } from '../errors.ts';

/** v1 observations/historical URL for the {ICAO}:9:{CC} location code, startDate=endDate. */
export function wuObsUrl(
  icao: string,
  cc: string,
  unit: 'e' | 'm',
  yyyymmdd: string,
  apiKey: string,
): string {
  return `https://api.weather.com/v1/location/${icao}:9:${cc.toUpperCase()}/observations/historical.json?apiKey=${apiKey}&units=${unit}&startDate=${yyyymmdd}&endDate=${yyyymmdd}`;
}

/**
 * Regex the 32-hex public frontend key out of a wunderground.com history page.
 * Runtime extraction — never hardcoded; cached in config with TTL so key
 * rotation self-heals.
 */
export function extractWuApiKey(html: string): string | null {
  const m = /apiKey=([a-f0-9]{32})/.exec(html);
  return m ? m[1]! : null;
}

const WuPayloadSchema = z.object({
  observations: z.array(
    z
      .object({
        valid_time_gmt: z.number(),
        temp: z.number().nullable().optional(),
      })
      .passthrough(),
  ),
});

/**
 * Typed obs list from the v1 payload — temp is WU's server-rounded integer in
 * the requested unit. WuShapeError on a shape change; an empty observations[]
 * returns [] (the caller decides retry vs no-data).
 */
export function parseWuObservations(json: unknown): { validTimeGmt: number; tempInt: number | null }[] {
  const parsed = WuPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new WuShapeError('payload has no observations[] of the v1 shape', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data.observations.map((o) => ({
    validTimeGmt: o.valid_time_gmt,
    tempInt: o.temp ?? null,
  }));
}

/**
 * Max of non-null tempInt; null when no usable obs. nObs counts usable
 * (non-null-temp) observations — low counts are suspicious and persisted.
 */
export function wuDailyMax(
  obs: { validTimeGmt: number; tempInt: number | null }[],
): { maxInt: number; nObs: number } | null {
  const usable = obs.filter((o) => o.tempInt !== null);
  if (usable.length === 0) return null;
  return { maxInt: Math.max(...usable.map((o) => o.tempInt!)), nObs: usable.length };
}

/** Polymarket's finalization rule replica: ≥1 observation exists for the FOLLOWING local day. */
export function isFinalized(nextDayObs: { validTimeGmt: number }[]): boolean {
  return nextDayObs.length >= 1;
}
