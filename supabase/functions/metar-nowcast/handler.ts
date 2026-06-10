/**
 * metar-nowcast — intraday running max + nowcast rebuild trigger (ARCHITECTURE.md §6.15).
 */
import {
  localDateAt,
  localHour,
  metarMaxToNative,
  metarRunningMax,
  parseMetarJson,
  type Unit,
} from '../../../packages/core/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface NowcastDeps {
  fetchJson: (url: string) => Promise<unknown>;
  now: Date;
  /** §6.16 buildDistributionForEvent nowcast variant, invoked in-process; absent until P4 wires it. */
  rebuildNowcast?: (eventId: string) => Promise<boolean>;
}

interface NowcastTarget {
  icao: string;
  tz: string;
  unit: Unit;
  city_slug: string;
  event_id: string;
  target_date: string | Date;
  has_distribution: boolean;
}

export async function metarNowcast(ctx: JobCtx, deps: NowcastDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const targets = await db.rpc<NowcastTarget>('nowcast_targets', {});

  // daytime/evening stations whose OPEN event targets the current local day
  const live = targets.filter((t) => {
    const date = typeof t.target_date === 'string' ? t.target_date.slice(0, 10) : new Date(t.target_date).toISOString().slice(0, 10);
    const hour = localHour(t.tz, deps.now);
    return hour >= 6 && localDateAt(t.tz, deps.now) === date;
  });
  if (live.length === 0) {
    return { stationsPolled: 0, maxesAdvanced: 0, nowcastsRebuilt: 0 };
  }

  // ONE batched aviationweather call for every station in play (§6.15)
  const icaos = [...new Set(live.map((t) => t.icao))];
  const obs = parseMetarJson(
    await deps.fetchJson(
      `https://aviationweather.gov/api/data/metar?ids=${icaos.join(',')}&format=json&hours=18`,
    ),
  );

  let maxesAdvanced = 0;
  let nowcastsRebuilt = 0;
  for (const t of live) {
    const date = typeof t.target_date === 'string' ? t.target_date.slice(0, 10) : new Date(t.target_date).toISOString().slice(0, 10);
    const stationObs = obs.filter((o) => o.icaoId === t.icao);
    const maxTenths = metarRunningMax(stationObs, t.tz, date);
    if (maxTenths === null) continue;

    const [advanced] = await db.rpc<{ upsert_intraday: boolean }>('upsert_intraday', {
      p_icao: t.icao,
      p_date: date,
      p_max_tenths: maxTenths,
      p_max_native: metarMaxToNative(maxTenths, t.unit),
      p_n_obs: stationObs.length,
    });
    if (advanced?.upsert_intraday) {
      maxesAdvanced++;
      if (t.has_distribution && deps.rebuildNowcast) {
        if (await deps.rebuildNowcast(t.event_id)) nowcastsRebuilt++;
      }
    }
  }

  const stats = { stationsPolled: icaos.length, maxesAdvanced, nowcastsRebuilt };
  log('nowcast complete', stats);
  return stats;
}
