import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type PlaceInputs } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { amsterdamPaperTrade } from '../functions/amsterdam-paper-trade/handler.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

// The forecast-aware nowcast (0040): at the EARLY arms (<= 14:00) the running-max floor is lifted to
// the de-biased lead-1 forecast — basis = max(floor, forecast) → wuRound. At 15:00/16:00 the floor is
// already the peak, so the forecast is ignored. This test seeds enough finalized history for the
// de-bias to be trusted (>= 20 prior pairs) and a target day whose 13:00/14:00 floors sit BELOW the
// forecast, proving the lift moves the predicted bucket up while the late arms stay on the floor.

const LADDER = [
  { idx: 0, label: '14°C or below', low: null as number | null, high: 14 as number | null },
  { idx: 1, label: '15°C', low: 15, high: 15 },
  { idx: 2, label: '16°C', low: 16, high: 16 },
  { idx: 3, label: '17°C', low: 17, high: 17 },
  { idx: 4, label: '18°C', low: 18, high: 18 },
  { idx: 5, label: '19°C', low: 19, high: 19 },
  { idx: 6, label: '20°C', low: 20, high: 20 },
  { idx: 7, label: '21°C', low: 21, high: 21 },
  { idx: 8, label: '22°C', low: 22, high: 22 },
  { idx: 9, label: '23°C', low: 23, high: 23 },
  { idx: 10, label: '24°C or higher', low: 24, high: null },
];

const TARGET = '2026-07-01';
let db: PGlite;
let port: ReturnType<typeof pglitePort>;
const cfg = parseConfigRows([]);
const ctxAt = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });

async function seedEvent(cityId: string, targetDate: string): Promise<string> {
  const ev = (
    await db.query<{ id: string }>(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok)
       values ($1, $2, $3, $4, 'C', 'highest', true) returning id`,
      [`poly-ams-${targetDate}`, `highest-temperature-in-amsterdam-on-${targetDate}`, cityId, targetDate],
    )
  ).rows[0]!;
  for (const b of LADDER) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, 'cond-${b.idx}', 'ty-${b.idx}', 'tn-${b.idx}')`,
      [ev.id, b.idx, b.label, b.low, b.high],
    );
  }
  return ev.id;
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ('amsterdam', 'Amsterdam', 'NL', 'C', 'Etc/GMT-2', 'europe-west', now(), now())`,
  );
  await db.query(
    `insert into stations (icao, country_code, tz, source) values ('EHAM', 'NL', 'Etc/GMT-2', 'manual')
     on conflict (icao) do nothing`,
  );
  const city = (await rows<{ id: string }>(db, `select id from cities where slug = 'amsterdam'`))[0]!;
  await db.query(
    `insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
     values ($1, 'EHAM', 'NL', now(), true)`,
    [city.id],
  );

  // 22 prior finalized days, each lead-1 forecast 20.0 and actual 21.0 → trailing bias = +1.0 (n=22 ≥ 20).
  for (let i = 1; i <= 22; i++) {
    const d = `2026-06-${String(i).padStart(2, '0')}`;
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
       values ('EHAM', 'ecmwf_ifs025', $1::date, 1, 20.0, '10Z', 'forecast_api', ($1::date - interval '1 day'))`,
      [d],
    );
    await db.query(
      `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
       values ('EHAM', $1, 21.0, 'C', 30, false, now())`,
      [d],
    );
  }

  // Target day: lead-1 forecast mean 21.0 → de-biased = 21.0 + 1.0 = 22.0.
  const ev = await seedEvent(city.id, TARGET);
  await db.query(
    `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
     values ('EHAM', 'ecmwf_ifs025', $1::date, 1, 21.0, '10Z', 'forecast_api', ($1::date - interval '1 day')),
            ('EHAM', 'gfs_seamless', $1::date, 1, 21.0, '10Z', 'forecast_api', ($1::date - interval '1 day'))`,
    [TARGET],
  );
  // Running max (cumulative): 13:00→19.4, 14:00→19.8 (both below 22 → lifted), 15:00→20.6, 16:00→20.9
  // (floor 21°C → idx7, the forecast is gated out so they stay on the floor).
  for (const [h, v] of Object.entries({ 11: 18.0, 12: 19.0, 13: 19.4, 14: 19.8, 15: 20.6, 16: 20.9 })) {
    await db.query(
      `insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values ('EHAM', $1, $2, $3)`,
      [TARGET, Number(h), v],
    );
  }
  // A clean quote on every bucket at 11:00Z (13:00 local) — before every arm asof, so all arms forward-fill.
  for (const b of LADDER) {
    const bucket = (
      await rows<{ id: string }>(db, `select id from market_buckets where event_id = $1 and bucket_idx = $2`, [
        ev,
        b.idx,
      ])
    )[0]!;
    const ask = b.idx === 7 ? 0.6 : b.idx === 8 ? 0.7 : 0.02;
    await db.query(`insert into market_snapshots (bucket_id, best_ask, captured_at) values ($1, $2, $3)`, [
      bucket.id,
      ask,
      `${TARGET}T11:00:00Z`,
    ]);
  }
});

afterAll(async () => {
  await db?.close();
});

describe('amsterdam_sim_place_inputs — de-biased forecast in the payload (0040)', () => {
  it('returns the de-biased lead-1 forecast (raw 21.0 + trailing bias 1.0 = 22.0)', async () => {
    const r = await rows<{ v: PlaceInputs }>(
      db,
      `select public.amsterdam_sim_place_inputs($1::date, $2::timestamptz) as v`,
      [TARGET, `${TARGET}T15:30:00Z`],
    );
    expect(Number(r[0]!.v.forecastC)).toBeCloseTo(22.0, 6);
  });
});

describe('amsterdam-paper-trade — forecast-aware placement (0040)', () => {
  it('lifts 13:00/14:00 to the forecast bucket, leaves 15:00/16:00 on the floor', async () => {
    const stats = await amsterdamPaperTrade(ctxAt(new Date(`${TARGET}T15:30:00Z`)), {
      now: new Date(`${TARGET}T15:30:00Z`),
      targetDate: TARGET,
    });
    expect(stats).toMatchObject({ target: TARGET, placed: 4 });

    const bets = await rows<{
      arm_hour: number;
      predicted_native_c: number;
      bucket_idx: number;
      running_max_c: string;
      forecast_c: string | null;
    }>(
      db,
      `select arm_hour, predicted_native_c, bucket_idx, running_max_c, forecast_c
       from amsterdam_paper_bets where target_date = $1 order by arm_hour`,
      [TARGET],
    );
    expect(bets.map((b) => b.arm_hour)).toEqual([13, 14, 15, 16]);
    // 13:00 floor 19°C and 14:00 floor 20°C are both LIFTED to the de-biased forecast bucket (22°C, idx8).
    expect(bets[0]).toMatchObject({ predicted_native_c: 22, bucket_idx: 8 });
    expect(bets[1]).toMatchObject({ predicted_native_c: 22, bucket_idx: 8 });
    // 15:00 (20.6→21°C) and 16:00 (20.9→21°C) are PAST the gate → the forecast is ignored; floor stands.
    expect(bets[2]).toMatchObject({ predicted_native_c: 21, bucket_idx: 7 });
    expect(bets[3]).toMatchObject({ predicted_native_c: 21, bucket_idx: 7 });
    // The de-biased forecast is recorded on every arm (what was available), used or not.
    expect(bets.every((b) => Math.abs(Number(b.forecast_c) - 22.0) < 1e-6)).toBe(true);
    expect(Number(bets[0]!.running_max_c)).toBeCloseTo(19.4, 4);
  });
});
