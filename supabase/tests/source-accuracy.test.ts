/**
 * source_accuracy RPC (0025) + check-source-accuracy rollup — unified
 * cross-source temperature-forecast accuracy over finalized truth.
 * Hand-computed sufficient stats, the latest-capture dedup, and the ranking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from './harness.ts';
import { reportSourceAccuracy } from '../../scripts/check-source-accuracy.ts';

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    insert into stations (icao, country_code, tz, lat, lon, source)
      values ('TEST', 'KR', 'Asia/Seoul', 37, 127, 'ourairports');

    -- finalized truth (°C): 2026-06-01 = 20, 2026-06-02 = 22
    insert into observations (icao, date_local, tmax_wu_native, unit, provenance, provisional, finalized_at) values
      ('TEST', '2026-06-01', 20, 'C', 'wu', false, now()),
      ('TEST', '2026-06-02', 22, 'C', 'wu', false, now());

    -- Open-Meteo model (forecast_snapshots). For 06-01 lead1 there are TWO captures;
    -- the LATER (22Z, 20.0) must win the dedup over the earlier (10Z, 21.0).
    insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
      ('TEST', 'ecmwf_ifs025', '2026-06-01', 1, 21.0, '10Z', 'forecast_api', '2026-06-01T08:00:00Z'),
      ('TEST', 'ecmwf_ifs025', '2026-06-01', 1, 20.0, '22Z', 'forecast_api', '2026-06-01T20:00:00Z'),
      ('TEST', 'ecmwf_ifs025', '2026-06-02', 1, 25.0, '10Z', 'forecast_api', '2026-06-02T08:00:00Z');

    -- external source (source_forecasts): closer to truth
    insert into source_forecasts (icao, source, target_date, lead_days, snapshot_slot, tmax_c, captured_at) values
      ('TEST', 'weatherapi', '2026-06-01', 1, '10Z', 20.5, '2026-06-01T10:00:00Z'),
      ('TEST', 'weatherapi', '2026-06-02', 1, '10Z', 23.5, '2026-06-02T10:00:00Z');
  `);
});

afterAll(async () => {
  await db.close();
});

interface Cell {
  source: string;
  icao: string;
  lead_days: number;
  n: number;
  sum_abs: string;
  sum_err: string;
  sum_sq: string;
  hits_1c: number;
  hits_2c: number;
}

describe('source_accuracy (§ external-source tracking)', () => {
  it('scores each source with hand-computed sufficient stats, latest capture wins the dedup', async () => {
    const res = await db.query<Cell>('select * from source_accuracy(null) order by source');
    const rows = res.rows;
    expect(rows).toHaveLength(2);

    // ecmwf: 06-01 picks the LATER 22Z=20 (err 0), 06-02=25 (err +3).
    const ecm = rows.find((r) => r.source === 'ecmwf_ifs025')!;
    expect(ecm.icao).toBe('TEST');
    expect(ecm.lead_days).toBe(1);
    expect(ecm.n).toBe(2);
    expect(Number(ecm.sum_abs)).toBeCloseTo(3, 6); // |0| + |3|
    expect(Number(ecm.sum_err)).toBeCloseTo(3, 6); // 0 + 3
    expect(Number(ecm.sum_sq)).toBeCloseTo(9, 6); // 0 + 9
    expect(ecm.hits_1c).toBe(1); // only the 0
    expect(ecm.hits_2c).toBe(1); // +3 misses ±2

    // weatherapi: 06-01=20.5 (err +0.5), 06-02=23.5 (err +1.5)
    const wa = rows.find((r) => r.source === 'weatherapi')!;
    expect(wa.n).toBe(2);
    expect(Number(wa.sum_abs)).toBeCloseTo(2, 6); // 0.5 + 1.5
    expect(Number(wa.sum_err)).toBeCloseTo(2, 6);
    expect(Number(wa.sum_sq)).toBeCloseTo(2.5, 6); // 0.25 + 2.25
    expect(wa.hits_1c).toBe(1); // only 0.5
    expect(wa.hits_2c).toBe(2); // both within ±2
  });

  it('rolls up to a ranking where the more-accurate external source wins', async () => {
    const res = await db.query<Cell>('select * from source_accuracy(null)');
    const cells = res.rows.map((r) => ({
      source: r.source,
      icao: r.icao,
      lead_days: r.lead_days,
      n: r.n,
      sum_abs: Number(r.sum_abs),
      sum_err: Number(r.sum_err),
      sum_sq: Number(r.sum_sq),
      hits_1c: r.hits_1c,
      hits_2c: r.hits_2c,
    }));
    const lines = await reportSourceAccuracy(cells, null, true);
    const text = lines.join('\n');
    // weatherapi: 2/2 within ±2 = 100%; ecmwf: 1/2 = 50% → weatherapi ranks first.
    expect(text).toMatch(/WINNER:\s+weatherapi/);
    expect(text).toMatch(/LAGGARD:\s+ecmwf_ifs025/);
    // by-lead matrix present
    expect(text).toMatch(/ACCURACY BY LEAD/);
  });

  it('returns no rows when the window excludes all observations', async () => {
    const res = await db.query<Cell>('select * from source_accuracy(1)'); // obs are >1 day old
    expect(res.rows).toHaveLength(0);
  });
});
