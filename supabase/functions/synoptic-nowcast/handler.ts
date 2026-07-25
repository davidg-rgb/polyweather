/**
 * synoptic-nowcast — US sub-hourly (5-min METAR / HF-ASOS) obs capture +
 * intraday running max via Synoptic Data v2 (DATA-SOURCES.md §Synoptic).
 *
 * Two jobs per tick (0119 widened the first):
 *  1. CAPTURE, around the clock: log every 5-min ob for EVERY active
 *     Polymarket-city station (`list_active_stations`) into `synoptic_obs` —
 *     the obs↔price research corpus (does fresh obs data lead Polymarket price
 *     moves?). The account tier decides which stations return (open-access =
 *     US-only, probed 2026-07-25); absent stations simply produce no rows, so
 *     a tier upgrade widens coverage with zero code change.
 *  2. NOWCAST, the metar-nowcast twin: for stations whose OPEN event targets
 *     the current local day (hour ≥ 6), advance the SAME monotonic
 *     `upsert_intraday` floor (it can only tighten) and rebuild nowcast
 *     distributions on an advance.
 *
 * Missing token → clean no-op (deploy-before-secret / post-trial safe).
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

interface ActiveStation {
  icao: string;
  tz: string;
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
    return { stationsPolled: 0, stationsReturned: 0, obsLogged: 0, liveTargets: 0, maxesAdvanced: 0, nowcastsRebuilt: 0, skipped: 'no_token' };
  }

  // ── 1. CAPTURE universe: every active Polymarket-city station (0119). ─────
  const universe = await db.rpc<ActiveStation>('list_active_stations', {});
  const icaos = [...new Set(universe.map((s) => s.icao))];
  if (icaos.length === 0) {
    return { stationsPolled: 0, stationsReturned: 0, obsLogged: 0, liveTargets: 0, maxesAdvanced: 0, nowcastsRebuilt: 0 };
  }

  // ONE batched Synoptic call. recent=45 min overlaps the 15-min cadence 3× so
  // a missed tick loses nothing; hfmetars=1 keeps the 5-minute variant on. The
  // token never reaches logs (fetchJson errors carry hostname only; redacted
  // defensively anyway).
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

  // Raw-obs log (idempotent on (icao, obs_at); RPC prunes >90d per 0119).
  let obsLogged = 0;
  const universeIcaos = new Set(icaos);
  const rows = obs
    .filter((o) => universeIcaos.has(o.icaoId))
    .map((o) => ({
      icao: o.icaoId,
      obs_at: new Date(o.obsTimeUtc * 1000).toISOString(),
      temp_tenths_c: o.tempTenthsC,
    }));
  if (rows.length > 0) {
    const [logged] = await db.rpc<{ synoptic_obs_log: number }>('synoptic_obs_log', { p_rows: rows });
    obsLogged = logged?.synoptic_obs_log ?? 0;
  }

  // ── 2. NOWCAST advance: the open-event daytime set (unchanged from 0118). ──
  const targets = await db.rpc<NowcastTarget>('nowcast_targets', {});
  const live = targets.filter((t) => {
    const hour = localHour(t.tz, deps.now);
    return hour >= 6 && localDateAt(t.tz, deps.now) === targetDate(t);
  });

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
    // serves (US-only on the trial; rises on a tier upgrade).
    stationsReturned: returned.size,
    obsLogged,
    liveTargets: live.length,
    maxesAdvanced,
    nowcastsRebuilt,
  };
  log('synoptic nowcast complete', stats);
  return stats;
}
