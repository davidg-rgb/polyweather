import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
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
