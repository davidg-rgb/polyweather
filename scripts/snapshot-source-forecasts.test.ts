/**
 * snapshot-source-forecasts against PGlite + the REAL OpenWeatherMap fixtures:
 * fetch+parse per station → source_forecasts with leads off the station-local
 * target date and the AM/PM slot.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { owmForecastUrl, parseOwmDailyMax } from '../packages/core/src/index.ts';
import { freshDb } from '../supabase/tests/harness.ts';
import { toPgliteParam } from './lib/pglite-param.ts';
import { snapshotSourceForecasts, type Db, type SourceDef } from './snapshot-source-forecasts.ts';

const RESEARCH = join(import.meta.dirname, '..', 'research');
const fixture = (f: string): unknown => JSON.parse(readFileSync(join(RESEARCH, f), 'utf8'));
const RKSI = fixture('openweathermap_forecast_RKSI.json');
const KORD = fixture('openweathermap_forecast_KORD.json');

const NOW = new Date('2026-06-13T10:00:00Z'); // UTC hour 10 < 16 → slot 10Z

let db: PGlite;
let scriptDb: Db;

beforeAll(async () => {
  db = await freshDb();
  scriptDb = {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await db.query<T>(sql, params.map(toPgliteParam))).rows,
  };
  await db.exec(`
    insert into stations (icao, country_code, tz, lat, lon, source) values
      ('RKSI', 'KR', 'Asia/Seoul',        37.4691, 126.4505, 'ourairports'),
      ('KORD', 'US', 'America/Chicago',   41.9742, -87.9073, 'ourairports');
  `);
});

afterAll(async () => {
  await db.close();
});

const owmSource = (): SourceDef => ({
  source: 'openweathermap',
  url: (c) => owmForecastUrl(c, 'TESTKEY'),
  parse: parseOwmDailyMax,
});

// fixture by station (URL carries the lat)
const fetchByLat = async (url: string): Promise<unknown> => {
  if (url.includes('lat=37.4691')) return RKSI;
  if (url.includes('lat=41.9742')) return KORD;
  throw new Error(`unexpected url ${url}`);
};

describe('snapshot-source-forecasts (§ external-source capture)', () => {
  it('captures OpenWeatherMap daily-max per station with leads + slot', async () => {
    const stats = await snapshotSourceForecasts(scriptDb, {
      fetchJson: fetchByLat,
      sources: [owmSource()],
      now: NOW,
    });

    // RKSI (Seoul +9) emits 06-14..18 = leads 1..5; KORD (Chicago −5) emits 06-13..17 = leads 0..4.
    expect(stats.stations).toBe(2);
    expect(stats.slot).toBe('10Z');
    expect(stats.failures).toBe(0);
    expect(stats.perSource).toEqual({ openweathermap: 10 });
    expect(stats.written).toBe(10);

    const rows = (
      await db.query<{ icao: string; lead_days: number; snapshot_slot: string; tmax_c: string }>(
        `select icao, lead_days, snapshot_slot, tmax_c from source_forecasts
         where source = 'openweathermap' order by icao, lead_days`,
      )
    ).rows;
    expect(rows).toHaveLength(10);

    // RKSI 06-14 = lead 1, slot 10Z, 19.32 (hand-verified from the fixture)
    const rksiL1 = rows.find((r) => r.icao === 'RKSI' && r.lead_days === 1)!;
    expect(rksiL1.snapshot_slot).toBe('10Z');
    expect(Number(rksiL1.tmax_c)).toBeCloseTo(19.32, 2);

    // KORD 06-13 = lead 0, 28.23
    const kordL0 = rows.find((r) => r.icao === 'KORD' && r.lead_days === 0)!;
    expect(Number(kordL0.tmax_c)).toBeCloseTo(28.23, 2);
  });

  it('skips a source that errors on a station without failing the run', async () => {
    const boom: SourceDef = { source: 'openweathermap', url: () => 'x', parse: parseOwmDailyMax };
    const stats = await snapshotSourceForecasts(scriptDb, {
      fetchJson: async () => {
        throw new Error('HTTP 401');
      },
      sources: [boom],
      now: NOW,
    });
    expect(stats.failures).toBe(2); // both stations
    expect(stats.written).toBe(0);
  });
});
