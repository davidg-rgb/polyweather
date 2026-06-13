/**
 * snapshot-sources Edge Function (§ external-source accuracy tracking) against
 * PGlite + the REAL OpenWeatherMap fixtures: list_active_stations → fetch+parse
 * per station → source_forecasts via upsert_source_forecasts, sharing the
 * _shared/source-capture.ts loop with the local seed script. Also covers the two
 * operator-visible WARN paths (no keys configured; every fetch failing).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { owmForecastUrl, parseOwmDailyMax } from '../../packages/core/src/index.ts';
import { snapshotSources } from '../functions/snapshot-sources/handler.ts';
import type { SourceDef } from '../functions/_shared/source-capture.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const RESEARCH = join(import.meta.dirname, '..', '..', 'research');
const fixture = (f: string): unknown => JSON.parse(readFileSync(join(RESEARCH, f), 'utf8'));
const RKSI = fixture('openweathermap_forecast_RKSI.json');
const KORD = fixture('openweathermap_forecast_KORD.json');

const NOW = new Date('2026-06-13T10:00:00Z'); // UTC hour 10 < 16 → slot 10Z

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

const ctx = (): JobCtx => ({
  db: port,
  config: { jobWallLimitSec: 150 } as JobCtx['config'],
  log: () => {},
  startedAt: NOW,
});

async function seedStation(
  slug: string,
  icao: string,
  cc: string,
  unit: string,
  tz: string,
  region: string,
  lat: number,
  lon: number,
) {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, $2, $3, $4, $5, now(), now())`,
    [slug, cc, unit, tz, region],
  );
  await db.query(
    `insert into stations (icao, country_code, tz, lat, lon, source) values ($1, $2, $3, $4, $5, 'ourairports')`,
    [icao, cc, tz, lat, lon],
  );
  await db.query(
    `insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
     select id, $2, $3, now(), true from cities where slug = $1`,
    [slug, icao, cc],
  );
}

const owmSource = (): SourceDef => ({
  source: 'openweathermap',
  url: (c) => owmForecastUrl(c, 'TESTKEY'),
  parse: parseOwmDailyMax,
});

// fixture by station (the URL carries the lat)
const fetchByLat = async (url: string): Promise<unknown> => {
  if (url.includes('lat=37.4691')) return RKSI;
  if (url.includes('lat=41.9742')) return KORD;
  throw new Error(`unexpected url ${url}`);
};

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await seedStation('seoul', 'RKSI', 'KR', 'C', 'Asia/Seoul', 'east-asia', 37.4691, 126.4505);
  await seedStation('chicago', 'KORD', 'US', 'F', 'America/Chicago', 'na-central', 41.9742, -87.9073);
});

afterAll(async () => {
  await db.close();
});

describe('snapshot-sources (§ external-source capture)', () => {
  it('captures OpenWeatherMap daily-max for every active station, isolated from forecast_snapshots', async () => {
    const alerts: Alert[] = [];
    const stats = await snapshotSources(ctx(), {
      fetchJson: fetchByLat,
      notify: async (a) => (alerts.push(a), true),
      sources: [owmSource()],
      now: NOW,
    });

    // RKSI (Seoul +9) emits 06-14..18 = leads 1..5; KORD (Chicago −5) emits 06-13..17 = leads 0..4.
    expect(stats['stations']).toBe(2);
    expect(stats['slot']).toBe('10Z');
    expect(stats['sources']).toBe(1);
    expect(stats['failures']).toBe(0);
    expect(stats['perSource']).toEqual({ openweathermap: 10 });
    expect(stats['written']).toBe(10);
    expect(alerts).toHaveLength(0);

    const sfRows = await rows<{ icao: string; lead_days: number; snapshot_slot: string; tmax_c: string }>(
      db,
      `select icao, lead_days, snapshot_slot, tmax_c from source_forecasts
       where source = 'openweathermap' order by icao, lead_days`,
    );
    expect(sfRows).toHaveLength(10);

    // RKSI 06-14 = lead 1, slot 10Z, 19.32 (hand-verified from the fixture)
    const rksiL1 = sfRows.find((r) => r.icao === 'RKSI' && r.lead_days === 1)!;
    expect(rksiL1.snapshot_slot).toBe('10Z');
    expect(Number(rksiL1.tmax_c)).toBeCloseTo(19.32, 2);
    // KORD 06-13 = lead 0, 28.23
    const kordL0 = sfRows.find((r) => r.icao === 'KORD' && r.lead_days === 0)!;
    expect(Number(kordL0.tmax_c)).toBeCloseTo(28.23, 2);

    // ISOLATION: external sources never touch the trading forecast table.
    const fsCount = (await rows<{ n: number }>(db, `select count(*)::int as n from forecast_snapshots`))[0]!.n;
    expect(fsCount).toBe(0);
  });

  it('with no source keys: writes nothing and raises a single CONFIG WARN', async () => {
    const alerts: Alert[] = [];
    const stats = await snapshotSources(ctx(), {
      fetchJson: fetchByLat,
      notify: async (a) => (alerts.push(a), true),
      sources: [],
      now: NOW,
    });
    expect(stats['stations']).toBe(2); // still lists the active stations
    expect(stats['sources']).toBe(0);
    expect(stats['written']).toBe(0);
    expect(stats['slot']).toBe('10Z');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('CONFIG');
    expect(alerts[0]!.severity).toBe('WARN');
    expect(alerts[0]!.dedupeKey).toBe('snapshot-sources:no-keys');
  });

  it('when every fetch fails: 0 rows, all-failed WARN, run still succeeds', async () => {
    const alerts: Alert[] = [];
    const stats = await snapshotSources(ctx(), {
      fetchJson: async () => {
        throw new Error('HTTP 401');
      },
      notify: async (a) => (alerts.push(a), true),
      sources: [owmSource()],
      now: NOW,
    });
    expect(stats['failures']).toBe(2); // both stations
    expect(stats['written']).toBe(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe('SOURCE_FETCH');
    expect(alerts[0]!.dedupeKey).toBe('snapshot-sources:all-failed');
  });
});
