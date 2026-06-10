/**
 * §6.22 backfill scripts against PGlite: chunked Previous-Runs ingest with
 * archive_start clamping, day-0 pseudo-truth, §9.7 kill/restart resumability
 * (cursor continuation, no refetch), the budget sleeper, WU/IEM provenance,
 * advance logging, and the initial nowcast_lift FINAL PASS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from '../supabase/tests/harness.ts';
import { listDatesISO, type Db } from './lib/backfill.ts';
import { advancesFromObs, backfillActuals, SPARSE_MIN_OBS } from './backfill-actuals.ts';
import { backfillForecasts } from './backfill-forecasts.ts';

const NOW = new Date('2026-06-11T12:00:00Z');
const noop = () => {};
const noSleep = async () => {};

let db: PGlite;
let scriptDb: Db;

beforeAll(async () => {
  db = await freshDb();
  scriptDb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const pgParams = params.map((p) =>
        Array.isArray(p) ? `{${p.map((x) => `"${String(x)}"`).join(',')}}` : p,
      );
      return (await db.query<T>(sql, pgParams)).rows;
    },
  };
  await db.exec(`
    insert into stations (icao, country_code, tz, lat, lon, source) values
      ('CALA', 'KR', 'Asia/Seoul', 37, 127, 'ourairports'),
      ('CALC', 'KR', 'Asia/Seoul', 37, 127, 'ourairports'),
      ('CALD', 'KR', 'Asia/Seoul', 37, 127, 'ourairports')
  `);
});

afterAll(async () => {
  await db.close();
});

// --- mock payload builders (research-fixture shapes) -------------------------

function prevRunsPayload(model: string, start: string, end: string): unknown {
  const time: string[] = [];
  for (const d of listDatesISO(start, end)) {
    for (let h = 0; h < 24; h++) time.push(`${d}T${String(h).padStart(2, '0')}:00`);
  }
  const hourly: Record<string, unknown> = { time };
  for (const lead of [1, 2, 3, 4, 5, 6, 7]) {
    hourly[`temperature_2m_previous_day${lead}_${model}`] = time.map(() => 20 + lead);
  }
  return { hourly };
}

function day0Payload(models: string[], start: string, end: string): unknown {
  const dates = listDatesISO(start, end);
  const daily: Record<string, unknown> = { time: dates };
  for (const m of models) daily[`temperature_2m_max_${m}`] = dates.map(() => 25);
  return { daily };
}

function makeForecastMock(opts: { throwOnPrevRunsCall?: number } = {}) {
  const urls: string[] = [];
  let prevCalls = 0;
  const fetchJson = async (url: string): Promise<unknown> => {
    urls.push(url);
    const u = new URL(url);
    const start = u.searchParams.get('start_date')!;
    const end = u.searchParams.get('end_date')!;
    const models = u.searchParams.get('models')!.split(',');
    if (u.hostname.includes('previous-runs')) {
      prevCalls++;
      if (prevCalls === opts.throwOnPrevRunsCall) throw new Error('simulated kill');
      return prevRunsPayload(models[0]!, start, end);
    }
    return day0Payload(models, start, end);
  };
  return { urls, fetchJson };
}

const fcDeps = (fetchJson: (u: string) => Promise<unknown>) => ({
  db: scriptDb, fetchJson, log: noop, now: () => NOW, sleep: noSleep,
});

describe('backfill-forecasts (§6.22, §9.7)', () => {
  it('chunked previous-runs ingest + day-0 pseudo-truth, slot/source/captured_at correct', async () => {
    const { urls, fetchJson } = makeForecastMock();
    const stats = await backfillForecasts(
      { from: '2026-05-01', to: '2026-05-28', stations: ['CALA'], models: ['ecmwf_ifs025'], budget: 1000 },
      fcDeps(fetchJson),
    );
    expect(stats).toMatchObject({ scopes: 2, scopesDone: 2, scopesErrored: 0, chunksFetched: 4 });
    expect(stats.rowsUpserted).toBe(28 * 7 + 28); // 28 days × leads 1–7 + 28 day-0 rows

    const [counts] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from forecast_snapshots
       where icao = 'CALA' and snapshot_slot = 'backfill' and source = 'backfill_prev_runs'`,
    );
    expect(counts!.n).toBe(224);

    const [lead3] = await rows<{ tmax_c: string; captured_at: Date }>(
      db,
      `select tmax_c, captured_at from forecast_snapshots
       where icao = 'CALA' and lead_days = 3 and target_date = '2026-05-10'`,
    );
    expect(Number(lead3!.tmax_c)).toBe(23); // 20 + lead
    expect(new Date(lead3!.captured_at).toISOString()).toBe('2026-05-07T12:00:00.000Z');

    const [day0] = await rows<{ tmax_c: string }>(
      db,
      `select tmax_c from forecast_snapshots where icao = 'CALA' and lead_days = 0 and target_date = '2026-05-10'`,
    );
    expect(Number(day0!.tmax_c)).toBe(25);

    const progress = await rows<{ scope: string; cursor: Date; status: string }>(
      db,
      `select scope, cursor, status from backfill_progress where script = 'backfill-forecasts' and scope like 'CALA%' order by scope`,
    );
    expect(progress.map((p) => [p.scope, p.status])).toEqual([
      ['CALA:_day0', 'done'],
      ['CALA:ecmwf_ifs025', 'done'],
    ]);

    const [budgetRow] = await rows<{ weighted_calls_used: string }>(
      db,
      `select weighted_calls_used from backfill_progress
       where script = 'backfill-forecasts' and scope = '_budget:2026-06-11'`,
    );
    expect(Number(budgetRow!.weighted_calls_used)).toBeCloseTo(4, 6); // 2 prev chunks + 2 day-0 chunks, weight 1 each
    expect(urls.filter((u) => u.includes('previous-runs')).length).toBe(2);
  });

  it('clamps the range start to the model archive_start', async () => {
    await db.exec(`update models set archive_start = '2026-05-15' where slug = 'gfs_seamless'`);
    const { urls, fetchJson } = makeForecastMock();
    const stats = await backfillForecasts(
      { from: '2026-05-01', to: '2026-05-28', stations: ['CALA'], models: ['gfs_seamless'], budget: 1000 },
      fcDeps(fetchJson),
    );
    expect(stats.scopesErrored).toBe(0);
    const prevUrls = urls.filter((u) => u.includes('previous-runs'));
    expect(prevUrls.length).toBe(1); // one 14-day chunk: 05-15..05-28
    expect(prevUrls[0]).toContain('start_date=2026-05-15');
  });

  it('§9.7 kill mid-run → restart continues from the cursor, refetches nothing', async () => {
    const killed = makeForecastMock({ throwOnPrevRunsCall: 2 });
    const run1 = await backfillForecasts(
      { from: '2026-05-01', to: '2026-05-28', stations: ['CALC'], models: ['ecmwf_ifs025'], budget: 1000 },
      fcDeps(killed.fetchJson),
    );
    expect(run1.scopesErrored).toBe(1);

    const [p1] = await rows<{ cursor: Date; status: string }>(
      db,
      `select cursor, status from backfill_progress where script = 'backfill-forecasts' and scope = 'CALC:ecmwf_ifs025'`,
    );
    expect(p1!.status).toBe('error');
    expect(new Date(p1!.cursor).toISOString().slice(0, 10)).toBe('2026-05-14'); // chunk 1 committed
    const [mid] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from forecast_snapshots where icao = 'CALC' and lead_days between 1 and 7`,
    );
    expect(mid!.n).toBe(14 * 7);

    const healthy = makeForecastMock();
    const run2 = await backfillForecasts(
      { from: '2026-05-01', to: '2026-05-28', stations: ['CALC'], models: ['ecmwf_ifs025'], budget: 1000 },
      fcDeps(healthy.fetchJson),
    );
    expect(run2.scopesErrored).toBe(0);
    const prevUrls2 = healthy.urls.filter((u) => u.includes('previous-runs'));
    expect(prevUrls2.length).toBe(1); // ONLY the missing chunk
    expect(prevUrls2[0]).toContain('start_date=2026-05-15');
    expect(healthy.urls.filter((u) => u.includes('historical-forecast')).length).toBe(0); // day-0 already done

    const [after] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from forecast_snapshots where icao = 'CALC' and lead_days between 1 and 7`,
    );
    expect(after!.n).toBe(28 * 7); // complete, no duplicates (natural-key upsert)
    const [p2] = await rows<{ status: string }>(
      db,
      `select status from backfill_progress where script = 'backfill-forecasts' and scope = 'CALC:ecmwf_ifs025'`,
    );
    expect(p2!.status).toBe('done');
  });

  it('budget sleeper engages at the daily cap and resumes on the next UTC day', async () => {
    // own clock month — earlier tests already spent against the 2026-06-11 day row
    const clock = { t: new Date('2026-07-01T10:00:00Z') };
    const sleeps: number[] = [];
    const { fetchJson } = makeForecastMock();
    const stats = await backfillForecasts(
      { from: '2026-05-01', to: '2026-05-28', stations: ['CALD'], models: ['ecmwf_ifs025'], budget: 1.5 },
      {
        db: scriptDb,
        fetchJson,
        log: noop,
        now: () => clock.t,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock.t = new Date(clock.t.getTime() + ms);
        },
      },
    );
    expect(stats.scopesErrored).toBe(0);
    // 4 unit-weight spends against a 1.5/day cap → sleeps before spends 2, 3, 4
    expect(sleeps.length).toBe(3);
    expect(sleeps[0]).toBe(14 * 3_600_000 + 1_000); // 10:00Z → next UTC midnight + 1s pad
    const budgetDays = await rows<{ scope: string; weighted_calls_used: string }>(
      db,
      `select scope, weighted_calls_used from backfill_progress
       where script = 'backfill-forecasts' and scope like '_budget:2026-07%' order by scope`,
    );
    expect(budgetDays.map((b) => [b.scope, Number(b.weighted_calls_used)])).toEqual([
      ['_budget:2026-07-01', 1], ['_budget:2026-07-02', 1], ['_budget:2026-07-03', 1], ['_budget:2026-07-04', 1],
    ]);
  });
});

// --- actuals -------------------------------------------------------------------

const seoulEpoch = (iso: string, hour: number) =>
  Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00+09:00`) / 1000;
const chicagoEpoch = (iso: string, hour: number) =>
  Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00-05:00`) / 1000; // CDT in May

function wuPayload(icao: string, iso: string): unknown {
  if (icao === 'CACT') {
    if (iso === '2026-05-05') return { observations: [] }; // WU empty → IEM fallback
    if (iso === '2026-05-06') {
      // sparse (3 < SPARSE_MIN_OBS) → IEM fallback for the daily value
      return {
        observations: [15, 16, 17].map((t, i) => ({ valid_time_gmt: seoulEpoch(iso, 6 + i), temp: t })),
      };
    }
    const temps = [15, 16, 17, 18, 20, 24, 23, 22]; // °C — max 24 at local hour 11
    return { observations: temps.map((t, i) => ({ valid_time_gmt: seoulEpoch(iso, 6 + i), temp: t })) };
  }
  const temps = [59, 61, 63, 64, 68, 75, 73, 72]; // °F — max 75 at local hour 11
  return { observations: temps.map((t, i) => ({ valid_time_gmt: chicagoEpoch(iso, 6 + i), temp: t })) };
}

function makeActualsMock() {
  const urls: string[] = [];
  const fetchJson = async (url: string): Promise<unknown> => {
    urls.push(url);
    if (url.includes('api.weather.com')) {
      const icao = /location\/(\w{4}):9/.exec(url)![1]!;
      const d = /startDate=(\d{8})/.exec(url)![1]!;
      return wuPayload(icao, `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
    }
    if (url.includes('mesonet')) return { data: [{ max_tmpf: 68 }] };
    throw new Error(`unexpected url: ${url}`);
  };
  return { urls, fetchJson };
}

const WU_KEY_HTML = '<script>var x = "apiKey=abcdef0123456789abcdef0123456789&units=e";</script>';

describe('backfill-actuals (§6.22, §7.7 provenance, §7.8a lift)', () => {
  beforeAll(async () => {
    await db.exec(`
      insert into stations (icao, country_code, tz, lat, lon, us_state, source) values
        ('CACT', 'KR', 'Asia/Seoul', 37, 127, null, 'ourairports'),
        ('KACT', 'US', 'America/Chicago', 41, -87, 'IL', 'ourairports');
      insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen) values
        ('actcity', 'actcity', 'KR', 'C', 'Asia/Seoul', 'east-asia', now(), now()),
        ('factcity', 'factcity', 'US', 'F', 'America/Chicago', 'na-central', now(), now());
      insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
        select id, 'CACT', 'KR', now(), true from cities where slug = 'actcity';
      insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
        select id, 'KACT', 'US', now(), true from cities where slug = 'factcity';
    `);
  });

  it('WU truth rows + IEM fallback provenance + key extraction + advances + lift FINAL PASS', async () => {
    const { urls, fetchJson } = makeActualsMock();
    const stats = await backfillActuals(
      { from: '2026-05-01', to: '2026-05-12', stations: ['CACT', 'KACT'], budget: 1000 },
      {
        db: scriptDb, fetchJson, fetchText: async () => WU_KEY_HTML,
        log: noop, now: () => NOW, sleep: noSleep,
      },
    );

    expect(stats).toMatchObject({ stationsDone: 2, datesProcessed: 24, wuRows: 22, iemRows: 2, gaps: 0 });

    const [key] = await rows<{ value: string }>(db, `select value from config where key = 'wuApiKey'`);
    expect(key!.value).toBe('abcdef0123456789abcdef0123456789');

    const [wuC] = await rows<{ tmax_wu_native: number; unit: string; n_obs: number; provenance: string; provisional: boolean }>(
      db,
      `select tmax_wu_native, unit, n_obs, provenance, provisional from observations
       where icao = 'CACT' and date_local = '2026-05-03'`,
    );
    expect(wuC).toMatchObject({ tmax_wu_native: 24, unit: 'C', n_obs: 8, provenance: 'wu', provisional: false });

    // empty WU day → IEM 68°F → °C native wuRound(20.0) = 20
    const [iemEmpty] = await rows<{ tmax_wu_native: number; provenance: string; n_obs: number }>(
      db,
      `select tmax_wu_native, provenance, n_obs from observations where icao = 'CACT' and date_local = '2026-05-05'`,
    );
    expect(iemEmpty).toMatchObject({ tmax_wu_native: 20, provenance: 'iem_fallback', n_obs: 0 });

    // sparse WU day (3 obs < ${SPARSE_MIN_OBS}) → IEM value, WU obs count kept
    const [iemSparse] = await rows<{ provenance: string; n_obs: number }>(
      db,
      `select provenance, n_obs from observations where icao = 'CACT' and date_local = '2026-05-06'`,
    );
    expect(iemSparse).toMatchObject({ provenance: 'iem_fallback', n_obs: 3 });
    expect(SPARSE_MIN_OBS).toBeGreaterThan(3);

    const [wuF] = await rows<{ tmax_wu_native: number; unit: string; provenance: string }>(
      db,
      `select tmax_wu_native, unit, provenance from observations where icao = 'KACT' and date_local = '2026-05-03'`,
    );
    expect(wuF).toMatchObject({ tmax_wu_native: 75, unit: 'F', provenance: 'wu' });

    // °F advances land in °C tenths: 75°F → 23.9 at local hour 11
    const adv = await rows<{ local_hour: number; max_tenths_c: string }>(
      db,
      `select local_hour, max_tenths_c from intraday_advances
       where icao = 'KACT' and date_local = '2026-05-03' order by local_hour`,
    );
    expect(adv.map((a) => [a.local_hour, Number(a.max_tenths_c)])).toEqual([
      [6, 15], [7, 16.1], [8, 17.2], [9, 17.8], [10, 20], [11, 23.9],
    ]);

    // historic dates are beyond aviationweather's reach — never called
    expect(urls.some((u) => u.includes('aviationweather'))).toBe(false);

    // FINAL PASS: lift quantiles via the shared rebuild RPC
    expect(stats.liftRowsBuilt).toBeGreaterThan(0);
    const [liftC] = await rows<{ p50_remaining: string; p90_remaining: string; n: number }>(
      db,
      `select p50_remaining, p90_remaining, n from nowcast_lift where icao = 'CACT' and local_hour = 9`,
    );
    // 10 full days lift 24−18 = 6.0 + the sparse day 17−17 = 0 → p50 stays 6.0
    expect(Number(liftC!.p50_remaining)).toBeCloseTo(6.0, 6);
    expect(liftC!.n).toBe(11);
    const [liftF] = await rows<{ p50_remaining: string; n: number }>(
      db,
      `select p50_remaining, n from nowcast_lift where icao = 'KACT' and local_hour = 9`,
    );
    expect(Number(liftF!.p50_remaining)).toBeCloseTo(6.1, 6); // 23.9 − 17.8
    expect(liftF!.n).toBe(12);
  });

  it('re-run is a no-op: cursor at range end, zero WU fetches', async () => {
    const { urls, fetchJson } = makeActualsMock();
    const stats = await backfillActuals(
      { from: '2026-05-01', to: '2026-05-12', stations: ['CACT', 'KACT'], budget: 1000 },
      {
        db: scriptDb, fetchJson, fetchText: async () => WU_KEY_HTML,
        log: noop, now: () => NOW, sleep: noSleep,
      },
    );
    expect(stats.datesProcessed).toBe(0);
    expect(urls.filter((u) => u.includes('api.weather.com')).length).toBe(0);
  });

  it('advancesFromObs: running-max walk, °F→°C, same-hour collapse', () => {
    const obs = [
      { validTimeGmt: seoulEpoch('2026-05-01', 6), tempInt: 50 },
      { validTimeGmt: seoulEpoch('2026-05-01', 6) + 1800, tempInt: 52 }, // same local hour — collapses
      { validTimeGmt: seoulEpoch('2026-05-01', 9), tempInt: 51 }, // not a new max — skipped
      { validTimeGmt: seoulEpoch('2026-05-01', 12), tempInt: 75 },
      { validTimeGmt: seoulEpoch('2026-05-01', 14), tempInt: null }, // null temp — skipped
    ];
    expect(advancesFromObs(obs, 'Asia/Seoul', 'F')).toEqual([
      { hour: 6, maxTenthsC: 11.1 }, // 52°F
      { hour: 12, maxTenthsC: 23.9 }, // 75°F
    ]);
  });
});
