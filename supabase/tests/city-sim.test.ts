import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, planPlacements, planSettlements } from '../../packages/core/src/index.ts';
import type { GradeInputRow, PlaceInputs } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { cityPaperTrade } from '../functions/city-paper-trade/handler.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

// A Singapore-shaped °C ladder (whole-°C interior + open tails) — WSSS daily highs sit ~30–33°C.
const LADDER = [
  { idx: 0, label: '29°C or below', low: null as number | null, high: 29 as number | null },
  { idx: 1, label: '30°C', low: 30, high: 30 },
  { idx: 2, label: '31°C', low: 31, high: 31 },
  { idx: 3, label: '32°C', low: 32, high: 32 },
  { idx: 4, label: '33°C', low: 33, high: 33 },
  { idx: 5, label: '34°C or higher', low: 34, high: null },
];

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
const cfg = parseConfigRows([]);
const ctxAt = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });
const OPERATOR = { email: 'david.geborek@gmail.com' };

/** Seed the Singapore city + its city_sim_config (WSSS, Asia/Singapore, arms 11–14, lift ≤ 12). */
async function seedSingapore(): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ('singapore', 'Singapore', 'SG', 'C', 'Asia/Singapore', 'southeast-asia', now(), now())`,
  );
  await db.query(
    `insert into stations (icao, country_code, tz, source) values ('WSSS', 'SG', 'Asia/Singapore', 'manual')
     on conflict (icao) do nothing`,
  );
  const cityId = (await rows<{ id: string }>(db, `select id from cities where slug = 'singapore'`))[0]!.id;
  await db.query(
    `insert into city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active)
     values ($1, 'singapore', 'WSSS', 'Asia/Singapore', array[11,12,13,14]::smallint[], 12, 10, true)`,
    [cityId],
  );
  return cityId;
}

async function seedEvent(cityId: string, targetDate: string): Promise<string> {
  const ev = (
    await db.query<{ id: string }>(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok)
       values ($1, $2, $3, $4, 'C', 'highest', true) returning id`,
      [`poly-sg-${targetDate}`, `highest-temperature-in-singapore-on-${targetDate}`, cityId, targetDate],
    )
  ).rows[0]!;
  for (const b of LADDER) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ev.id, b.idx, b.label, b.low, b.high, `c-${b.idx}`, `y-${b.idx}`, `n-${b.idx}`],
    );
  }
  return ev.id;
}

async function seedIntraday(targetDate: string, byHour: Record<number, number>): Promise<void> {
  for (const [h, v] of Object.entries(byHour)) {
    await db.query(
      `insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values ('WSSS', $1, $2, $3)`,
      [targetDate, Number(h), v],
    );
  }
}

async function seedAsk(eventId: string, bucketIdx: number, ask: number, capturedAt: string): Promise<void> {
  const bucket = (
    await rows<{ id: string }>(db, `select id from market_buckets where event_id = $1 and bucket_idx = $2`, [eventId, bucketIdx])
  )[0]!;
  await db.query(`insert into market_snapshots (bucket_id, best_ask, captured_at) values ($1, $2, $3)`, [bucket.id, ask, capturedAt]);
}

async function seedFinalizedObs(targetDate: string, tmaxC: number): Promise<void> {
  await db.query(
    `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
     values ('WSSS', $1, $2, 'C', 30, false, now())`,
    [targetDate, tmaxC],
  );
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  const cityId = await seedSingapore();

  // main day (2026-06-10): running max climbs through midday and tops out by ~13:00 (tropical peak).
  const ev = await seedEvent(cityId, '2026-06-10');
  // 11→30.4 (wuRound 30, idx1), 12→31.6 (32, idx3), 13→31.9 (32, idx3), 14→32.0 (32, idx3)
  await seedIntraday('2026-06-10', { 9: 28.0, 10: 29.2, 11: 30.4, 12: 31.6, 13: 31.9, 14: 32.0 });
  // 0048 in-hour guard: each arm's ask must be QUOTED inside its lock hour [H:00,H+1:00) SGT = [(H-8):00,(H-7):00) UTC.
  // arm11=03Z, arm12=04Z, arm13=05Z, arm14=06Z. Seed the book on every bucket at each arm-hour start.
  const askBook = { 1: 0.25, 3: 0.7 } as Record<number, number>;
  for (const [h, t] of [[11, '03'], [12, '04'], [13, '05'], [14, '06']] as const) {
    void h;
    for (const b of LADDER) await seedAsk(ev, b.idx, askBook[b.idx] ?? 0.02, `2026-06-10T${t}:00:00Z`);
  }
  // a POISON quote on idx3 at 10:00Z (18:00 SGT) — AFTER every arm's lock hour; must be ignored.
  await seedAsk(ev, 3, 0.99, '2026-06-10T10:00:00Z');

  // a second day (2026-06-09) for the due-gate test (in-hour quotes for the two early arms 11/12).
  const ev2 = await seedEvent(cityId, '2026-06-09');
  await seedIntraday('2026-06-09', { 11: 30.4, 12: 31.6, 13: 31.9, 14: 32.0 });
  for (const [h, t] of [[11, '03'], [12, '04']] as const) {
    void h;
    for (const b of LADDER) await seedAsk(ev2, b.idx, askBook[b.idx] ?? 0.02, `2026-06-09T${t}:00:00Z`);
  }
});

afterAll(async () => {
  await db?.close();
});

describe('city-paper-trade — placement (per-city arms, in-lock-hour odds)', () => {
  it('places one bet per due arm on our predicted bucket at the as-of-hour odds', async () => {
    // now = 2026-06-10 16:00 SGT (08:00Z) → all of 11/12/13/14 are due
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-10T08:00:00Z')), { now: new Date('2026-06-10T08:00:00Z') });
    expect(stats).toMatchObject({ cities: 1, placed: 4, graded: 0 });

    const bets = await rows<{ arm_hour: number; predicted_native: number; bucket_idx: number; label: string; ask: string; shares: string; status: string; unit: string; icao: string }>(
      db,
      `select arm_hour, predicted_native, bucket_idx, label, ask, shares, status, unit, icao
       from city_paper_bets where target_date = '2026-06-10' order by arm_hour`,
    );
    expect(bets.map((b) => b.arm_hour)).toEqual([11, 12, 13, 14]);
    expect(bets.every((b) => b.unit === 'C' && b.icao === 'WSSS')).toBe(true);
    // 11:00 → 30°C (idx1) @0.25 ; 12/13/14 → 32°C (idx3) @0.70
    expect(bets[0]).toMatchObject({ predicted_native: 30, bucket_idx: 1, label: '30°C' });
    expect(Number(bets[0]!.ask)).toBeCloseTo(0.25, 6);
    expect(Number(bets[0]!.shares)).toBeCloseTo(10 / 0.25, 4);
    expect(bets[1]).toMatchObject({ predicted_native: 32, bucket_idx: 3 });
    // arm used its in-hour quote (0.70 on idx3); the 10:00Z poison (0.99) is after the lock hour → ignored
    expect(Number(bets[1]!.ask)).toBeCloseTo(0.7, 6);
    expect(bets[3]).toMatchObject({ predicted_native: 32, bucket_idx: 3 });
    expect(Number(bets[3]!.ask)).toBeCloseTo(0.7, 6);
    expect(bets.every((b) => b.status === 'pending')).toBe(true);
  });

  it('is idempotent — a second run places nothing new (odds lock at first placement)', async () => {
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-10T09:00:00Z')), { now: new Date('2026-06-10T09:00:00Z') });
    expect(stats.placed).toBe(0);
    const cnt = await rows<{ n: string }>(db, `select count(*) n from city_paper_bets where target_date = '2026-06-10'`);
    expect(Number(cnt[0]!.n)).toBe(4);
  });

  it('only places arms whose hour has passed (the due gate)', async () => {
    // now = 2026-06-09 13:00 SGT (05:00Z) → only 11 and 12 are due
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-09T05:00:00Z')), {
      now: new Date('2026-06-09T05:00:00Z'),
      targetDate: '2026-06-09',
    });
    expect(stats.placed).toBe(2);
    const hours = await rows<{ arm_hour: number }>(db, `select arm_hour from city_paper_bets where target_date = '2026-06-09' order by arm_hour`);
    expect(hours.map((h) => h.arm_hour)).toEqual([11, 12]);
  });
});

describe('city-paper-trade — grading', () => {
  it('resolves pending bets once the observation finalizes (32°C → idx3 wins)', async () => {
    await seedFinalizedObs('2026-06-10', 32);
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-11T08:00:00Z')), {
      now: new Date('2026-06-11T08:00:00Z'),
      targetDate: '2026-06-11', // no event → placement no-ops; grading still runs
    });
    expect(stats.graded).toBe(4);

    const bets = await rows<{ arm_hour: number; status: string; won: boolean; pnl_usd: string; winner_idx: number; actual_native: number }>(
      db,
      `select arm_hour, status, won, pnl_usd, winner_idx, actual_native
       from city_paper_bets where target_date = '2026-06-10' order by arm_hour`,
    );
    // 11:00 (30°C) lost, 12/13/14 (32°C) won
    expect(bets.map((b) => b.status)).toEqual(['lost', 'won', 'won', 'won']);
    expect(bets.every((b) => b.winner_idx === 3 && b.actual_native === 32)).toBe(true);
    expect(Number(bets[0]!.pnl_usd)).toBeCloseTo(-10, 6); // lost stake (no fee seeded)
    expect(Number(bets[1]!.pnl_usd)).toBeCloseTo((10 / 0.7) * (1 - 0.7), 4); // won: shares·(1−ask)
  });

  it('does not double-grade — a graded bet is no longer pending', async () => {
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-11T09:00:00Z')), { now: new Date('2026-06-11T09:00:00Z'), targetDate: '2026-06-11' });
    expect(stats.graded).toBe(0);
  });
});

describe('dash_city_sim — the per-city head-to-head read', () => {
  it('returns the city with per-arm standings, a leader, equity curves and the bet log', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_city_sim: Record<string, unknown> }>(db, `select public.dash_city_sim() as dash_city_sim`);
      return r[0]!.dash_city_sim;
    });

    const cities = out.cities as Record<string, unknown>[];
    expect(cities.length).toBe(1);
    const sg = cities[0]!;
    expect(sg.slug).toBe('singapore');
    expect(sg.icao).toBe('WSSS');

    const arms = sg.arms as { hour: number; nGraded: number; pnl: number }[];
    expect(arms.map((a) => a.hour)).toEqual([11, 12, 13, 14]);
    const a12 = arms.find((a) => a.hour === 12)!;
    expect(Number(a12.nGraded)).toBe(1);
    expect(Number(a12.pnl)).toBeCloseTo((10 / 0.7) * (1 - 0.7), 4);

    const leader = sg.leader as { hour: number; pnl: number };
    expect([12, 13, 14]).toContain(leader.hour); // the three winning arms lead

    const betsByArm = sg.betsByArm as Record<string, { won: boolean; ask: number }[]>;
    expect(betsByArm['12']).toEqual([{ won: true, ask: 0.7 }]);
    expect(betsByArm['11']).toEqual([{ won: false, ask: 0.25 }]);

    const equity = sg.equityByArm as Record<string, unknown[]>;
    expect(Object.keys(equity).sort()).toEqual(['11', '12', '13', '14']);
    expect(Array.isArray(sg.betLog)).toBe(true);

    const overall = out.overall as { nGraded: number; nWon: number };
    expect(Number(overall.nGraded)).toBe(4);
    expect(Number(overall.nWon)).toBe(3);
  });

  it('is operator-gated (ERR_FORBIDDEN for a non-operator)', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () => rows(db, `select public.dash_city_sim()`)),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });
});

describe('city_sim_grade_inputs — the 0044 port invariant', () => {
  it('returns { rows: [...] } (an object), never a top-level array', async () => {
    const shape = await rows<{ outer: string; inner: string }>(
      db,
      `select jsonb_typeof(public.city_sim_grade_inputs()) as outer,
              jsonb_typeof(public.city_sim_grade_inputs()->'rows') as inner`,
    );
    expect(shape[0]).toEqual({ outer: 'object', inner: 'array' });
  });
});

describe('city-paper-trade — no market', () => {
  it('no-ops cleanly when there is no event for the day', async () => {
    const stats = await cityPaperTrade(ctxAt(new Date('2030-01-01T08:00:00Z')), { now: new Date('2030-01-01T08:00:00Z'), targetDate: '2030-01-01' });
    expect(stats).toMatchObject({ placed: 0, graded: 0 });
  });
});

// =====================================================================================================
// Houston (KHOU) — the FIRST °F city enrolled in city_sim_config (2026-07-03, FASTTRACK-PLAN.md C21).
// Migration 0070 claims the RPCs are "unit-general ... so a °F city (future) is correct too" (city_sim_
// place_inputs converts intraday_advances.max_tenths_c / forecast_snapshots.tmax_c — both always °C — to
// the city's native unit BEFORE bucketing: `case when v_unit = 'F' then x * 9.0/5.0 + 32 else x end`, at
// the runmax line and the forecast line). This block exercises that SQL conversion arithmetic directly —
// pure-core unit handling is covered by packages/core/test/sim-city-fahrenheit.test.ts — with a real KHOU-
// shaped 2°F-wide ladder (matching Polymarket's actual convention verified in buckets.test.ts's NYC
// fixture), a forecast lift at an early arm, a floor-only late arm, and a win + a loss grading round trip.
// Uses direct RPC calls (mirrors amsterdam-forecast.test.ts's style for amsterdam_sim_place_inputs) rather
// than the cityPaperTrade handler, so it does not touch city_sim_config.active and cannot perturb the
// Singapore-scoped stats/dash_city_sim assertions above (declared first, already executed by this point).
describe('city-paper-trade — Houston (KHOU), the first °F city (0070 unit-conversion round trip)', () => {
  const TARGET = '2026-07-04';
  // KHOU-shaped ladder: 2°F interior pairs, even-start — the real Polymarket US convention.
  const LADDER_F = [
    { idx: 0, label: '89°F or below', low: null as number | null, high: 89 as number | null },
    { idx: 1, label: '90-91°F', low: 90, high: 91 },
    { idx: 2, label: '92-93°F', low: 92, high: 93 },
    { idx: 3, label: '94-95°F', low: 94, high: 95 },
    { idx: 4, label: '96-97°F', low: 96, high: 97 },
    { idx: 5, label: '98-99°F', low: 98, high: 99 },
    { idx: 6, label: '100°F or higher', low: 100, high: null },
  ];
  let cityId: string;
  let eventId: string;

  async function seedAllBucketAsks(capturedAtIso: string, askByIdx: Record<number, number>): Promise<void> {
    for (const b of LADDER_F) {
      const bucket = (
        await rows<{ id: string }>(db, `select id from market_buckets where event_id = $1 and bucket_idx = $2`, [eventId, b.idx])
      )[0]!;
      await db.query(`insert into market_snapshots (bucket_id, best_ask, captured_at) values ($1, $2, $3)`, [
        bucket.id,
        askByIdx[b.idx] ?? 0.02,
        capturedAtIso,
      ]);
    }
  }

  beforeAll(async () => {
    await db.query(
      `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
       values ('houston', 'Houston', 'US', 'F', 'America/Chicago', 'na-central', now(), now())`,
    );
    await db.query(
      `insert into stations (icao, country_code, tz, source) values ('KHOU', 'US', 'America/Chicago', 'manual')
       on conflict (icao) do nothing`,
    );
    cityId = (await rows<{ id: string }>(db, `select id from cities where slug = 'houston'`))[0]!.id;
    // active=false: this block calls the 0070 RPCs directly (never city_sim_active_configs/cityPaperTrade),
    // so it cannot affect — and is unaffected by — the Singapore-scoped active-config tests above.
    await db.query(
      `insert into city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active)
       values ($1, 'houston', 'KHOU', 'America/Chicago', array[11,16]::smallint[], 14, 10, false)`,
      [cityId],
    );

    const ev = (
      await db.query<{ id: string }>(
        `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok)
         values ($1, $2, $3, $4, 'F', 'highest', true) returning id`,
        [`poly-khou-${TARGET}`, `highest-temperature-in-houston-on-${TARGET}`, cityId, TARGET],
      )
    ).rows[0]!;
    eventId = ev.id;
    for (const b of LADDER_F) {
      await db.query(
        `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [eventId, b.idx, b.label, b.low, b.high, `c-khou-${b.idx}`, `y-khou-${b.idx}`, `n-khou-${b.idx}`],
      );
    }

    // Running max (°C storage — intraday_advances.max_tenths_c is ALWAYS °C, regardless of the city's
    // native unit; the RPC converts). Cumulative daily warming: through 11:00 CDT the floor is 32.2°C
    // (→ 89.96°F, wuRounds to 90); by 16:00 CDT it has climbed to 35.8°C (→ 96.44°F, wuRounds to 96).
    for (const [h, c] of Object.entries({ 9: 30.0, 10: 31.0, 11: 32.2, 12: 33.0, 13: 34.0, 14: 34.5, 15: 35.0, 16: 35.8 })) {
      await db.query(`insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values ('KHOU', $1, $2, $3)`, [
        TARGET,
        Number(h),
        c,
      ]);
    }

    // 25 trailing (forecast, actual) pairs with ZERO residual — forecast_snapshots.tmax_c=20.0°C every
    // day, matched by a finalized KHOU observation at exactly cToF(20.0)=68.0°F (unit='F') — so the
    // trailing bias = 0 and the target day's bias-corrected forecast equals its raw mean (37.0°C = 98.6°F).
    // 25 ≥ AMSTERDAM_SIM_DEBIAS_MIN_PAIRS(20) → the correction is trusted.
    for (let i = 1; i <= 25; i++) {
      const d = `2026-06-${String(i).padStart(2, '0')}`;
      await db.query(
        `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
         values ('KHOU', 'ecmwf_ifs025', $1::date, 1, 20.0, '10Z', 'forecast_api', ($1::date - interval '1 day'))`,
        [d],
      );
      await db.query(
        `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
         values ('KHOU', $1, 68, 'F', 24, false, now())`,
        [d],
      );
    }
    // The target day's lead-1 forecast: raw mean 37.0°C → bias-corrected (bias=0) 37.0°C → native
    // 37.0×9/5+32 = 98.6°F.
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
       values ('KHOU', 'ecmwf_ifs025', $1::date, 1, 37.0, '10Z', 'forecast_api', ($1::date - interval '1 day'))`,
      [TARGET],
    );

    // 0048 in-hour guard: seed the full book at each arm's LOCAL lock-hour start, in UTC (America/Chicago
    // is CDT = UTC-5 in July). 11:00 CDT = 16:00Z; 16:00 CDT = 21:00Z.
    await seedAllBucketAsks(`${TARGET}T16:00:00Z`, { 4: 0.55, 5: 0.12 });
    await seedAllBucketAsks(`${TARGET}T21:00:00Z`, { 4: 0.55, 5: 0.12 });
  });

  it('city_sim_place_inputs converts the °C-stored floor + forecast to native °F', async () => {
    const r = await rows<{ v: PlaceInputs & { unit: string } }>(
      db,
      `select public.city_sim_place_inputs($1::uuid, $2::date, $3::timestamptz) as v`,
      [cityId, TARGET, `${TARGET}T23:00:00Z`], // 18:00 CDT — both arms (11, 16) are due
    );
    const input = r[0]!.v;
    expect(input.unit).toBe('F');
    expect(Number(input.forecastC)).toBeCloseTo(98.6, 6); // 37.0°C bias-corrected, converted to °F
    expect(input.forecastMaxHour).toBe(14);
    const byHour = new Map(input.arms.map((a) => [a.hour, a]));
    expect(Number(byHour.get(11)!.runMaxC)).toBeCloseTo(89.96, 4); // 32.2°C → °F
    expect(Number(byHour.get(16)!.runMaxC)).toBeCloseTo(96.44, 4); // 35.8°C → °F

    // planPlacements (the shared core decision) must lift 11:00 to the forecast bucket (idx5, 98-99°F)
    // and leave 16:00 on the pure floor (idx4, 96-97°F) — the SAME forecast-vs-floor split the Amsterdam
    // 0040 test proves in °C, now proven end-to-end through the °F conversion arithmetic.
    const placements = planPlacements(input, { stakeUsd: 10 });
    expect(placements).toHaveLength(2);
    const byArm = new Map(placements.map((p) => [p.armHour, p]));
    expect(byArm.get(11)).toMatchObject({ predictedNativeC: 99, bucketIdx: 5, ask: 0.12 }); // wuRound(98.6) = 99
    expect(byArm.get(16)).toMatchObject({ predictedNativeC: 96, bucketIdx: 4, ask: 0.55 });

    const rec = await rows<{ city_sim_record: number }>(
      db,
      `select public.city_sim_record($1::uuid, $2::text, $3::text, $4::jsonb) as city_sim_record`,
      [cityId, 'KHOU', 'F', JSON.stringify(placements)],
    );
    expect(Number(rec[0]!.city_sim_record)).toBe(2);

    const bets = await rows<{ arm_hour: number; predicted_native: number; bucket_idx: number; unit: string; icao: string; status: string }>(
      db,
      `select arm_hour, predicted_native, bucket_idx, unit, icao, status from city_paper_bets where city_id = $1 order by arm_hour`,
      [cityId],
    );
    expect(bets.map((b) => b.arm_hour)).toEqual([11, 16]);
    expect(bets.every((b) => b.unit === 'F' && b.icao === 'KHOU' && b.status === 'pending')).toBe(true);
    expect(bets[0]).toMatchObject({ arm_hour: 11, predicted_native: 99, bucket_idx: 5 });
    expect(bets[1]).toMatchObject({ arm_hour: 16, predicted_native: 96, bucket_idx: 4 });
  });

  it('grades a °F win (11:00, 98-99°F) and a °F loss (16:00, 96-97°F) once the actual finalizes', async () => {
    // The real KHOU high lands at 99°F (native, unit='F' — no conversion at grading; tmax_wu_native is
    // already the city's native unit). Winner bucket = idx5 (98-99°F): the 11:00 forecast-lifted bet wins,
    // the 16:00 floor-only bet loses.
    await db.query(
      `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
       values ('KHOU', $1, 99, 'F', 24, false, now())`,
      [TARGET],
    );

    // city_sim_grade_inputs scans pending bets across ALL cities, joined to a FINALIZED observation on
    // (icao, target_date). The Singapore fixtures above leave exactly 2 bets pending (2026-06-09, arm
    // 11/12) but never finalize a WSSS observation for that date, so they never join in here — these 2
    // rows are the Houston bets just placed.
    const g = await rows<{ v: { rows: GradeInputRow[] } }>(db, `select public.city_sim_grade_inputs() as v`);
    const pending = g[0]!.v.rows;
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => row.winnerIdx === 5 && row.actualNativeC === 99)).toBe(true);

    const settlements = planSettlements(pending);
    const s = await rows<{ city_sim_settle: number }>(
      db,
      `select public.city_sim_settle($1::jsonb) as city_sim_settle`,
      [JSON.stringify(settlements)],
    );
    expect(Number(s[0]!.city_sim_settle)).toBe(2);

    const graded = await rows<{ arm_hour: number; status: string; won: boolean; winner_idx: number; actual_native: number; pnl_usd: string }>(
      db,
      `select arm_hour, status, won, winner_idx, actual_native, pnl_usd from city_paper_bets where city_id = $1 order by arm_hour`,
      [cityId],
    );
    expect(graded.map((b) => ({ arm_hour: b.arm_hour, status: b.status, won: b.won }))).toEqual([
      { arm_hour: 11, status: 'won', won: true },
      { arm_hour: 16, status: 'lost', won: false },
    ]);
    expect(graded.every((b) => b.winner_idx === 5 && b.actual_native === 99)).toBe(true);
    expect(Number(graded[0]!.pnl_usd)).toBeCloseTo((10 / 0.12) * (1 - 0.12), 4); // won: shares·(1−ask), no fee seeded
    expect(Number(graded[1]!.pnl_usd)).toBeCloseTo(-10, 6); // lost: −stake, no fee seeded
  });
});
