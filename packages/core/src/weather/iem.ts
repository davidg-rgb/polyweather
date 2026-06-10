/**
 * core/weather/iem — Iowa Environmental Mesonet daily summaries
 * (ARCHITECTURE.md §6.10). Pure. Secondary daily-max opinion only — expect
 * occasional 1°F divergence; NOT a resolution source.
 */
import { z } from 'zod';
import { ValidationError, WuShapeError } from '../errors.ts';

/**
 * Network convention (live-verified): US → '{ST}_ASOS' with the 3-letter id
 * (IL_ASOS / ORD); intl → '{CC}__ASOS' with the full ICAO (KR__ASOS / RKSI —
 * TWO underscores). The US state is not derivable from cc+icao, so it must be
 * supplied for US stations (deviation from the §6.10 two-arg signature,
 * logged in BUILD-STATE.md).
 */
export function iemNetworkFor(
  cc: string,
  icao: string,
  usState?: string,
): { network: string; station: string } {
  if (cc.toUpperCase() === 'US') {
    if (!usState) {
      throw new ValidationError(`US station ${icao} needs a state for the {ST}_ASOS network`, { icao });
    }
    return { network: `${usState.toUpperCase()}_ASOS`, station: icao.replace(/^K/, '') };
  }
  return { network: `${cc.toUpperCase()}__ASOS`, station: icao };
}

/** mesonet.agron.iastate.edu daily API URL. */
export function iemDailyUrl(station: string, network: string, dateISO: string): string {
  return `https://mesonet.agron.iastate.edu/api/1/daily.json?station=${station}&network=${network}&date=${dateISO}`;
}

const IemSchema = z.object({
  data: z.array(z.object({ max_tmpf: z.number().nullable().optional() }).passthrough()),
});

/** First data row's max_tmpf; null on an empty data array (no report for that day). */
export function parseIemDaily(json: unknown): { maxTmpF: number } | null {
  const parsed = IemSchema.safeParse(json);
  if (!parsed.success) {
    throw new WuShapeError('IEM payload is not the daily.json shape', { issues: parsed.error.issues });
  }
  const first = parsed.data.data[0];
  if (!first || typeof first.max_tmpf !== 'number') return null;
  return { maxTmpF: first.max_tmpf };
}
