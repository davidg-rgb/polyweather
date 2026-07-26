/**
 * synoptic-nowcast — US sub-hourly (5-min METAR / HF-ASOS) obs CAPTURE via
 * Synoptic Data v2 (DATA-SOURCES.md §Synoptic).
 *
 * CAPTURE-ONLY since 2026-07-25 (the resolution-oracle finding, OBS-TRANSMISSION.md
 * addendum): the market resolves on WU's Daily Observations table, which is a
 * bit-for-bit re-render of the disseminated METAR/SPECI stream ONLY — the 5-min
 * obs stream NEVER appears in it, and its running max EXCEEDS the METAR-table
 * max on ~42% of days (validated 66/66 winner-replication + overshoot,
 * oracle-replica-validation.py). A 5-min ob is therefore a LEADING INDICATOR of
 * the next METAR, NOT resolution truth: this lane must never advance the
 * resolution-grade `intraday_max` floor (that stays exclusively metar-nowcast's
 * job). It logs every 5-min ob for EVERY active Polymarket-city station
 * (`list_active_stations`) into `synoptic_obs` — the obs↔price research corpus.
 * The account tier decides which stations return (open-access = US-only, probed
 * 2026-07-25); a tier upgrade widens coverage with zero code change.
 *
 * Missing token → clean no-op (deploy-before-secret / post-trial safe).
 */
import { parseSynopticTimeseries } from '../../../packages/core/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface SynopticDeps {
  fetchJson: (url: string) => Promise<unknown>;
  now: Date;
  /** SYNOPTIC_PUBLIC_TOKEN; absent → the tick no-ops with skipped:'no_token'. */
  token?: string;
}

interface ActiveStation {
  icao: string;
  tz: string;
}

export async function synopticNowcast(ctx: JobCtx, deps: SynopticDeps): Promise<JobStats> {
  const { db, log } = ctx;

  if (!deps.token) {
    log('SYNOPTIC_PUBLIC_TOKEN not set — lane no-op');
    return { stationsPolled: 0, stationsReturned: 0, obsLogged: 0, skipped: 'no_token' };
  }

  // ── CAPTURE universe: every active Polymarket-city station (0119). ─────────
  const universe = await db.rpc<ActiveStation>('list_active_stations', {});
  const icaos = [...new Set(universe.map((s) => s.icao))];
  if (icaos.length === 0) {
    return { stationsPolled: 0, stationsReturned: 0, obsLogged: 0 };
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

  const stats = {
    stationsPolled: icaos.length,
    // Tier-visibility gauge: how many polled stations the account actually
    // serves (US-only on the trial; rises on a tier upgrade).
    stationsReturned: returned.size,
    obsLogged,
  };
  log('synoptic capture complete', stats);
  return stats;
}
