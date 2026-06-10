/**
 * core/weather/metar — aviationweather.gov METAR parsing & running max
 * (ARCHITECTURE.md §6.10). Pure. The independent cross-check + nowcast source:
 * tenths-°C temps, free, covers non-US stations.
 */
import { z } from 'zod';
import { WuShapeError } from '../errors.ts';
import { localDateAt } from '../time.ts';

const MetarSchema = z.array(
  z
    .object({
      icaoId: z.string(),
      obsTime: z.number(), // unix seconds
      temp: z.number().nullable().optional(),
    })
    .passthrough(),
);

export interface MetarOb {
  icaoId: string;
  /** Unix SECONDS (aviationweather.gov obsTime verbatim). */
  obsTimeUtc: number;
  /** °C, may carry tenths (e.g. 20.6). */
  tempTenthsC: number;
}

/** aviationweather.gov JSON array → typed obs; null-temp reports skipped. */
export function parseMetarJson(json: unknown): MetarOb[] {
  const parsed = MetarSchema.safeParse(json);
  if (!parsed.success) {
    throw new WuShapeError('METAR payload is not the aviationweather.gov array shape', {
      issues: parsed.error.issues,
    });
  }
  return parsed.data
    .filter((o) => typeof o.temp === 'number' && Number.isFinite(o.temp))
    .map((o) => ({ icaoId: o.icaoId, obsTimeUtc: o.obsTime, tempTenthsC: o.temp! }));
}

/** Max temp over obs whose station-local date is dateISO; null when none observed yet. */
export function metarRunningMax(obs: MetarOb[], tz: string, dateISO: string): number | null {
  const inDay = obs.filter((o) => localDateAt(tz, new Date(o.obsTimeUtc * 1000)) === dateISO);
  if (inDay.length === 0) return null;
  return Math.max(...inDay.map((o) => o.tempTenthsC));
}
