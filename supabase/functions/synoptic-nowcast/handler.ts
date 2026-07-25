/**
 * synoptic-nowcast — US sub-hourly (5-min METAR / HF-ASOS) intraday running max
 * via Synoptic Data v2 (DATA-SOURCES.md §Synoptic). The metar-nowcast twin on a
 * finer clock: the SAME nowcast_targets universe, the SAME monotonic
 * upsert_intraday advance (the floor only ever tightens), plus a slim raw-obs
 * log (synoptic_obs, 14d retention) for sensor-peak-vs-print research.
 *
 * Tier reality (probed live 2026-07-25): the open-access account serves US
 * stations ONLY — stations absent from the response simply produce no obs and
 * are skipped, so an account upgrade lights up the intl cities with zero code
 * change. Missing token → clean no-op (deploy-before-secret safe).
 */
import {
  localDateAt,
  localHour,
  metarMaxToNative,
  metarRunningMax,
  parseSynopticTimeseries,
  type Unit,
} from '../../../packages/core/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface SynopticDeps {
  fetchJson: (url: string) => Promise<unknown>;
  now: Date;
  /** SYNOPTIC_PUBLIC_TOKEN; absent → the tick no-ops with skipped:'no_token'. */
  token?: string;
  /** §6.16 buildDistributionForEvent nowcast variant, invoked in-process. */
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

const targetDate = (t: NowcastTarget): string =>
  typeof t.target_date === 'string'
    ? t.target_date.slice(0, 10)
    : new Date(t.target_date).toISOString().slice(0, 10);

export async function synopticNowcast(ctx: JobCtx, deps: SynopticDeps): Promise<JobStats> {
  const { db, log } = ctx;

  if (!deps.token) {
    log('SYNOPTIC_PUBLIC_TOKEN not set — lane no-op');
    return { stationsPolled: 0, stationsReturned: 0, obsLogged: 0, maxesAdvanced: 0, nowcastsRebuilt: 0, skipped: 'no_token' };
  }

  const targets = await db.rpc<NowcastTarget>('nowcast_targets', {});

  // Daytime/evening stations whose OPEN event targets the current local day
  // (identical filter to metar-nowcast — the two lanes cover the same set).
  const live = targets.filter((t) => {
    const hour = localHour(t.tz, deps.now);
    return hour >= 6 && localDateAt(t.tz, deps.now) === targetDate(t);
  });
  if (live.length === 0) {
    return { stationsPolled: 0, stationsReturned: 0, obsLogged: 0, maxesAdvanced: 0, nowcastsRebuilt: 0 };
  }

  // ONE batched Synoptic call for every station in play. recent=45 min overlaps
  // the 15-min cadence 3× so a missed tick loses nothing; hfmetars=1 keeps the
  // 5-minute variant on. The token never reaches logs: fetchJson errors carry
  // only the hostname, and we redact defensively anyway.
  const icaos = [...new Set(live.map((t) => t.icao))];
  let raw: unknown;
  try {
    raw = await deps.fetchJson(
      `https://api.synopticdata.com/v2/stations/timeseries?stid=${icaos.join(',')}&recent=45&vars=air_temp&units=metric&hfmetars=1&token=${deps.token}`,
    );
  } catch (err) {
    throw new Error(String(err).split(deps.token).join('TOKEN_REDACTED'));
  }
  const obs = parseSynopticTimeseries(raw);
  const returned = new Set(obs.map((o) => o.icaoId));

  // Raw-obs log (idempotent on (icao, obs_at); RPC also prunes >14d).
  let obsLogged = 0;
  const liveIcaos = new Set(icaos);
  const rows = obs
    .filter((o) => liveIcaos.has(o.icaoId))
    .map((o) => ({
      icao: o.icaoId,
      obs_at: new Date(o.obsTimeUtc * 1000).toISOString(),
      temp_tenths_c: o.tempTenthsC,
    }));
  if (rows.length > 0) {
    const [logged] = await db.rpc<{ synoptic_obs_log: number }>('synoptic_obs_log', { p_rows: rows });
    obsLogged = logged?.synoptic_obs_log ?? 0;
  }

  let maxesAdvanced = 0;
  let nowcastsRebuilt = 0;
  for (const t of live) {
    const date = targetDate(t);
    const stationObs = obs.filter((o) => o.icaoId === t.icao);
    const maxTenths = metarRunningMax(stationObs, t.tz, date);
    if (maxTenths === null) continue;

    const [advanced] = await db.rpc<{ upsert_intraday: boolean }>('upsert_intraday', {
      p_icao: t.icao,
      p_date: date,
      p_max_tenths: maxTenths,
      p_max_native: metarMaxToNative(maxTenths, t.unit),
      p_n_obs: stationObs.length,
      p_local_hour: localHour(t.tz, deps.now),
    });
    if (advanced?.upsert_intraday) {
      maxesAdvanced++;
      if (t.has_distribution && deps.rebuildNowcast) {
        if (await deps.rebuildNowcast(t.event_id)) nowcastsRebuilt++;
      }
    }
  }

  const stats = {
    stationsPolled: icaos.length,
    // Tier-visibility gauge: how many polled stations the account actually
    // serves (US-only on open access; rises on a tier upgrade).
    stationsReturned: returned.size,
    obsLogged,
    maxesAdvanced,
    nowcastsRebuilt,
  };
  log('synoptic nowcast complete', stats);
  return stats;
}
