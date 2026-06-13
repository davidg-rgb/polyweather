import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { JobInputError, UpstreamError } from '../../packages/core/src/index.ts';
import { snapshotEnsembles } from '../functions/snapshot-ensembles/handler.ts';
import { snapshotForecasts } from '../functions/snapshot-forecasts/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', 'research');
const multiModel = JSON.parse(readFileSync(join(RESEARCH, 'openmeteo_forecast_multimodel_daily_RKSI.json'), 'utf8'));
const prevRuns = JSON.parse(readFileSync(join(RESEARCH, 'openmeteo_previousruns_hourly_RKSI.json'), 'utf8'));
const ensembleFx = JSON.parse(readFileSync(join(RESEARCH, 'openmeteo_ensemble_daily_max_RKSI.json'), 'utf8'));

// The fixture's capture morning: leads line up with daily.time 2026-06-10..16.
const NOW = new Date('2026-06-10T10:15:00Z');

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

const ctx = (): JobCtx => ({
  db: port,
  config: { jobWallLimitSec: 150 } as JobCtx['config'],
  log: () => {},
  startedAt: NOW,
});

async function seedStation(slug: string, icao: string, tz: string, lat: number, lon: number) {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'KR', 'C', $2, 'east-asia', now(), now())`,
    [slug, tz],
  );
  await db.query(
    `insert into stations (icao, country_code, tz, lat, lon, source) values ($1, 'KR', $2, $3, $4, 'ourairports')`,
    [icao, tz, lat, lon],
  );
  await db.query(
    `insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
     select id, $2, 'KR', now(), true from cities where slug = $1`,
    [slug, icao],
  );
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await seedStation('seoul', 'RKSI', 'Asia/Seoul', 37.4602, 126.4407);
  await seedStation('busan', 'PUSN', 'Asia/Seoul', 35.17, 128.94);
});

afterAll(async () => {
  await db.close();
});

describe('snapshot-forecasts (§6.14)', () => {
  const alerts: Alert[] = [];
  const notify = async (a: Alert) => (alerts.push(a), true);

  it('captures the multi-model fixture for every active station at the slot', async () => {
    const urls: string[] = [];
    const stats = await snapshotForecasts(ctx(), {
      fetchJson: async (url) => (urls.push(url), multiModel),
      notify,
      slot: '10Z',
      now: NOW,
      omForecastBase: 'https://api.open-meteo.com',
      omPreviousRunsBase: 'https://previous-runs-api.open-meteo.com',
    });

    expect(stats['stations']).toBe(2);
    expect(stats['stationsFailed']).toBe(0);
    expect(urls[0]).toContain('models=ecmwf_ifs025,');
    expect(urls[0]).toContain('forecast_days=16');

    const dbCount = (await rows<{ n: number }>(db, `select count(*)::int as n from forecast_snapshots`))[0]!.n;
    expect(dbCount).toBe(stats['rowsUpserted'] as number);
    const spot = (await rows<{ tmax_c: string; lead_days: number }>(
      db,
      `select tmax_c, lead_days from forecast_snapshots
       where icao = 'RKSI' and model = 'ecmwf_ifs025' and target_date = '2026-06-10' and snapshot_slot = '10Z'`,
    ))[0]!;
    expect(Number(spot.tmax_c)).toBe(21.6);
    expect(spot.lead_days).toBe(0);
    expect(stats['gapsRepaired']).toBe(0); // matrix is full for today; older days have no expectations yet
  });

  it('re-run at the same slot is idempotent; the 22Z slot adds its own rows', async () => {
    const before = (await rows<{ n: number }>(db, `select count(*)::int as n from forecast_snapshots`))[0]!.n;
    await snapshotForecasts(ctx(), {
      fetchJson: async () => multiModel,
      notify, slot: '10Z', now: NOW,
      omForecastBase: 'x://f', omPreviousRunsBase: 'x://p',
    });
    const after10 = (await rows<{ n: number }>(db, `select count(*)::int as n from forecast_snapshots`))[0]!.n;
    expect(after10).toBe(before);

    await snapshotForecasts(ctx(), {
      fetchJson: async () => multiModel,
      notify, slot: '22Z', now: new Date('2026-06-10T22:15:00Z'),
      omForecastBase: 'x://f', omPreviousRunsBase: 'x://p',
    });
    const after22 = (await rows<{ n: number }>(db, `select count(*)::int as n from forecast_snapshots`))[0]!.n;
    expect(after22).toBeGreaterThan(before); // 22Z slot adds its own rows…
    // …but NOT for 2026-06-10: at 22:15Z it is already June 11 in Seoul — the
    // local day is over, lead = −1, correctly filtered.
    const staleTarget = await rows(
      db,
      `select 1 from forecast_snapshots where snapshot_slot = '22Z' and target_date = '2026-06-10'`,
    );
    expect(staleTarget.length).toBe(0);
  });

  it('station failure: skip + WARN when >20% fail; partial rows persist', async () => {
    const before = alerts.length;
    const stats = await snapshotForecasts(ctx(), {
      fetchJson: async (url) => {
        if (url.includes('latitude=35.17')) {
          throw new UpstreamError('boom', { source: 'open-meteo', status: 503, retryable: true });
        }
        return multiModel;
      },
      notify, slot: '10Z', now: NOW,
      omForecastBase: 'x://f', omPreviousRunsBase: 'x://p',
    });
    expect(stats['stationsFailed']).toBe(1); // 1/2 = 50% > 20%
    const warn = alerts.slice(before).find((a) => a.kind === 'SNAPSHOT_PARTIAL');
    expect(warn?.severity).toBe('WARN');
  });

  it('MODEL_DEGRADED fires after 3 consecutive all-null runs, then resets', async () => {
    const degraded = () => alerts.filter((a) => a.kind === 'MODEL_DEGRADED' && a.title.includes('ukmo_seamless'));
    const noUkmo = structuredClone(multiModel) as { daily: Record<string, unknown> };
    delete noUkmo.daily['temperature_2m_max_ukmo_seamless'];

    const deps = {
      fetchJson: async () => noUkmo,
      notify, slot: '10Z' as const, now: NOW,
      omForecastBase: 'x://f', omPreviousRunsBase: 'x://p',
    };
    await snapshotForecasts(ctx(), deps);
    await snapshotForecasts(ctx(), deps);
    expect(degraded().length).toBe(0);
    await snapshotForecasts(ctx(), deps);
    expect(degraded().length).toBe(1);

    // healthy run resets the streak
    await snapshotForecasts(ctx(), {
      ...deps,
      fetchJson: async () => multiModel,
    });
    const streak = await rows(db, `select 1 from config where key = 'modelNullRuns:ukmo_seamless'`);
    expect(streak.length).toBe(0);
  });

  it('gap-fill repairs a deliberately deleted day via previous-runs (slot gapfill)', async () => {
    await db.exec(
      `delete from forecast_snapshots where icao = 'RKSI' and model = 'gfs_seamless' and target_date = '2026-06-10'`,
    );
    const prevUrls: string[] = [];
    const stats = await snapshotForecasts(ctx(), {
      fetchJson: async (url) => {
        if (url.includes('previous-runs')) {
          prevUrls.push(url);
          return prevRuns;
        }
        return multiModel;
      },
      notify, slot: '22Z', now: new Date('2026-06-10T22:15:00Z'),
      omForecastBase: 'x://f', omPreviousRunsBase: 'x://previous-runs-api',
    });
    // 22Z re-upsert restores the 22Z cell, but 7-day matrix gaps (e.g. yesterday's
    // dates with no rows at all) drive a previous-runs call for the holes.
    expect(prevUrls.length).toBeGreaterThanOrEqual(1);
    expect(stats['gapsRepaired'] as number).toBeGreaterThan(0);
    const gapfill = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from forecast_snapshots where snapshot_slot = 'gapfill' and source = 'previous_runs'`,
    );
    expect(gapfill[0]!.n).toBeGreaterThan(0);
  });
});

// C1 (ADR-19) — the deployed-isolate capture defect (#2) makes list_active_stations()
// return 0 rows at runtime. A 0-row run must FAIL LOUD (retryable) rather than record
// a silent `ok` that permanently consumes the period as already_ran. Both snapshot
// handlers guard against it and emit the 'capture inputs' cardinality line first.
describe('snapshot capture: empty-station guard (C1, ADR-19)', () => {
  let edb: PGlite;
  let eport: ReturnType<typeof pglitePort>;
  const ectx = (logs: string[]): JobCtx => ({
    db: eport,
    config: { jobWallLimitSec: 150 } as JobCtx['config'],
    log: (msg, extra) => logs.push(JSON.stringify({ msg, ...extra })),
    startedAt: NOW,
  });

  beforeAll(async () => {
    edb = await freshDb(); // NO cities/stations seeded → list_active_stations() returns []
    eport = pglitePort(edb);
  });
  afterAll(async () => {
    await edb.close();
  });

  it('snapshot-forecasts throws JobInputError (→ retryable failed) and never fetches a station', async () => {
    const logs: string[] = [];
    let fetched = false;
    await expect(
      snapshotForecasts(ectx(logs), {
        fetchJson: async () => ((fetched = true), multiModel),
        notify: async () => true,
        slot: '10Z',
        now: NOW,
        omForecastBase: 'x://f',
        omPreviousRunsBase: 'x://p',
      }),
    ).rejects.toBeInstanceOf(JobInputError);
    expect(fetched).toBe(false); // threw before the per-station loop — no wasted upstream calls
    expect(logs.some((l) => l.includes('capture inputs') && l.includes('"stations":0'))).toBe(true);
  });

  it('snapshot-ensembles throws the identical guard before the models fetch', async () => {
    const logs: string[] = [];
    await expect(
      snapshotEnsembles(ectx(logs), {
        fetchJson: async () => ensembleFx,
        slot: '10Z',
        now: NOW,
        omEnsembleBase: 'x://e',
      }),
    ).rejects.toBeInstanceOf(JobInputError);
    expect(logs.some((l) => l.includes('capture inputs') && l.includes('"stations":0'))).toBe(true);
  });
});

describe('snapshot-ensembles (§6.14, I2)', () => {
  it('stores member arrays per (station, model, target, slot)', async () => {
    const urls: string[] = [];
    const stats = await snapshotEnsembles(ctx(), {
      fetchJson: async (url) => (urls.push(url), ensembleFx),
      slot: '10Z',
      now: NOW,
      omEnsembleBase: 'https://ensemble-api.open-meteo.com',
    });

    // 2 stations × 2 ensemble models, one call each — one model per call (I2)
    expect(urls.length).toBe(4);
    expect(urls.some((u) => u.includes('models=ecmwf_ifs025') && !u.includes(','))).toBe(true);
    expect(urls.some((u) => u.includes('models=gfs05'))).toBe(true);

    const row = (await rows<{ n_members: number; members_c: string; lead_days: number }>(
      db,
      `select n_members, members_c::text, lead_days from ensemble_snapshots
       where icao = 'RKSI' and model = 'ecmwf_ifs025_ens' and target_date = '2026-06-10'`,
    ))[0]!;
    expect(row.n_members).toBe(51); // control + 50 members
    expect(row.members_c).toContain('21.5'); // control value from the fixture
    expect(row.lead_days).toBe(0);
    expect(stats['rowsUpserted']).toBe(2 * 2 * 7); // stations × models × fixture dates

    // idempotent re-run
    const again = await snapshotEnsembles(ctx(), {
      fetchJson: async () => ensembleFx,
      slot: '10Z', now: NOW, omEnsembleBase: 'x://e',
    });
    expect(again['rowsUpserted']).toBe(28);
    const total = (await rows<{ n: number }>(db, `select count(*)::int as n from ensemble_snapshots`))[0]!.n;
    expect(total).toBe(28);
  });
});
