/**
 * core/weather/synoptic — Synoptic Data v2 timeseries parsing (2026-07-25).
 * Pure. The US sub-hourly nowcast source: 5-minute METAR / HF-ASOS air temps
 * (probed live: median 5.0-min cadence on KORD/KHOU vs the 30–60-min
 * aviationweather path). Emits the SAME `MetarOb` shape as `parseMetarJson`
 * so `metarRunningMax` / `metarMaxToNative` are reused verbatim downstream.
 *
 * Tier reality (probed 2026-07-25): the open-access account serves US
 * stations ONLY — requesting an out-of-tier station yields RESPONSE_CODE 2
 * ("no stations"), which parses as an EMPTY result, not an error.
 */
import { z } from 'zod';
import { WuShapeError } from '../errors.ts';
import type { MetarOb } from './metar.ts';

const SynopticSchema = z
  .object({
    SUMMARY: z.object({ RESPONSE_CODE: z.number() }).passthrough(),
    STATION: z
      .array(
        z
          .object({
            STID: z.string(),
            OBSERVATIONS: z
              .object({
                date_time: z.array(z.string()),
                air_temp_set_1: z.array(z.number().nullable()),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * Synoptic v2 `stations/timeseries` JSON (units=metric, vars=air_temp) → typed
 * obs. RESPONSE_CODE 2 ("no stations for this request / no tier access") is a
 * valid empty result. Null temps and unparsable timestamps are skipped; a
 * date_time/air_temp length mismatch is a shape error (fixtures are ground truth).
 */
export function parseSynopticTimeseries(json: unknown): MetarOb[] {
  const parsed = SynopticSchema.safeParse(json);
  if (!parsed.success) {
    throw new WuShapeError('Synoptic payload is not the v2 timeseries shape', {
      issues: parsed.error.issues,
    });
  }
  if (parsed.data.SUMMARY.RESPONSE_CODE !== 1) return [];

  const out: MetarOb[] = [];
  for (const s of parsed.data.STATION ?? []) {
    const times = s.OBSERVATIONS.date_time;
    const temps = s.OBSERVATIONS.air_temp_set_1;
    if (times.length !== temps.length) {
      throw new WuShapeError(`Synoptic ${s.STID}: date_time/air_temp_set_1 length mismatch`, {
        times: times.length,
        temps: temps.length,
      });
    }
    for (let i = 0; i < times.length; i++) {
      const t = temps[i];
      if (typeof t !== 'number' || !Number.isFinite(t)) continue;
      const ms = Date.parse(times[i] ?? '');
      if (!Number.isFinite(ms)) continue;
      out.push({ icaoId: s.STID, obsTimeUtc: Math.floor(ms / 1000), tempTenthsC: t });
    }
  }
  return out;
}
