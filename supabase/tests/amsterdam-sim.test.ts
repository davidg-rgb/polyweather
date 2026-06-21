import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { amsterdamPaperTrade } from '../functions/amsterdam-paper-trade/handler.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

// The live Amsterdam ladder (whole-°C interior + open tails), 0004/0039 verified.
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

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
const cfg = parseConfigRows([]);

const ctxAt = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });
const OPERATOR = { email: 'david.geborek@gmail.com' };

async function seedAmsterdam(): Promise<string> {
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
  return city.id;
}

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

/** Running max known by each local hour (cumulative). */
async function seedIntraday(targetDate: string, byHour: Record<number, number>): Promise<void> {
  for (const [h, v] of Object.entries(byHour)) {
    await db.query(
      `insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values ('EHAM', $1, $2, $3)`,
      [targetDate, Number(h), v],
    );
  }
}

async function seedAsk(eventId: string, bucketIdx: number, ask: number, capturedAt: string): Promise<void> {
  const bucket = (
    await rows<{ id: string }>(db, `select id from market_buckets where event_id = $1 and bucket_idx = $2`, [
      eventId,
      bucketIdx,
    ])
  )[0]!;
  await db.query(`insert into market_snapshots (bucket_id, best_ask, captured_at) values ($1, $2, $3)`, [
    bucket.id,
    ask,
    capturedAt,
  ]);
}

async function seedFinalizedObs(targetDate: string, tmaxC: number): Promise<void> {
  await db.query(
    `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
     values ('EHAM', $1, $2, 'C', 30, false, now())`,
    [targetDate, tmaxC],
  );
}

/** A KNMI-shaped payload for a single day (tenths °C), for the handler's truth-fetch stub. */
const knmiPayload = (date: string, txTenths: number) => [
  { station_code: 240, date: `${date}T00:00:00.000Z`, TX: txTenths },
];

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  const cityId = await seedAmsterdam();

  // --- main day (2026-06-10): running max climbs through the afternoon ---
  const ev = await seedEvent(cityId, '2026-06-10');
  // by 13:00→19.4 (idx5), 14:00→20.6 (idx7), 15:00→21.6 (idx8), 16:00→21.9 (idx8)
  await seedIntraday('2026-06-10', { 11: 16.0, 12: 18.2, 13: 19.4, 14: 20.6, 15: 21.6, 16: 21.9 });
  // a clean quote on every bucket at 11:00Z (13:00 local) — before every arm's asof, so all arms forward-fill it
  const asksAt11 = { 5: 0.3, 7: 0.5, 8: 0.8 } as Record<number, number>;
  for (const b of LADDER) await seedAsk(ev, b.idx, asksAt11[b.idx] ?? 0.02, '2026-06-10T11:00:00Z');
  // a POISON quote on the 22°C bucket at 18:00Z (20:00 local) — AFTER every arm asof; forward-fill must ignore it
  await seedAsk(ev, 8, 0.01, '2026-06-10T18:00:00Z');

  // --- a second day (2026-06-09) for the "only due arms" gate ---
  const ev2 = await seedEvent(cityId, '2026-06-09');
  await seedIntraday('2026-06-09', { 13: 19.4, 14: 20.6, 15: 21.6, 16: 21.9 });
  for (const b of LADDER) await seedAsk(ev2, b.idx, asksAt11[b.idx] ?? 0.02, '2026-06-09T10:00:00Z');
});

afterAll(async () => {
  await db?.close();
});

describe('amsterdam-paper-trade — placement (the four arms)', () => {
  it('places one $10 bet per due arm on our predicted bucket at the as-of-hour odds', async () => {
    // now = 2026-06-10 17:30 local (15:30Z) → all of 13/14/15/16 are due
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-10T15:30:00Z')), {
      now: new Date('2026-06-10T15:30:00Z'),
    });
    expect(stats).toMatchObject({ target: '2026-06-10', placed: 4, graded: 0 });

    const bets = await rows<{
      arm_hour: number;
      predicted_native_c: number;
      bucket_idx: number;
      label: string;
      ask: string;
      shares: string;
      status: string;
    }>(
      db,
      `select arm_hour, predicted_native_c, bucket_idx, label, ask, shares, status
       from amsterdam_paper_bets where target_date = '2026-06-10' order by arm_hour`,
    );
    expect(bets.map((b) => b.arm_hour)).toEqual([13, 14, 15, 16]);
    // 13:00 → 19°C (idx5) @0.30 ; 14:00 → 21°C (idx7) @0.50 ; 15:00 & 16:00 → 22°C (idx8) @0.80
    expect(bets[0]).toMatchObject({ predicted_native_c: 19, bucket_idx: 5, label: '19°C' });
    expect(Number(bets[0]!.ask)).toBeCloseTo(0.3, 6);
    expect(Number(bets[0]!.shares)).toBeCloseTo(10 / 0.3, 4);
    expect(bets[1]).toMatchObject({ predicted_native_c: 21, bucket_idx: 7 });
    expect(Number(bets[1]!.ask)).toBeCloseTo(0.5, 6);
    expect(bets[2]).toMatchObject({ predicted_native_c: 22, bucket_idx: 8 });
    // forward-fill ignored the 18:00Z poison (0.01) — used the 11:00Z 0.80 quote
    expect(Number(bets[2]!.ask)).toBeCloseTo(0.8, 6);
    expect(Number(bets[3]!.ask)).toBeCloseTo(0.8, 6);
    expect(bets.every((b) => b.status === 'pending')).toBe(true);
  });

  it('is idempotent — a second run places nothing new (odds lock at first placement)', async () => {
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-10T16:30:00Z')), {
      now: new Date('2026-06-10T16:30:00Z'),
    });
    expect(stats.placed).toBe(0);
    const cnt = await rows<{ n: string }>(
      db,
      `select count(*) n from amsterdam_paper_bets where target_date = '2026-06-10'`,
    );
    expect(Number(cnt[0]!.n)).toBe(4);
  });

  it('only places arms whose hour has passed (the due gate)', async () => {
    // now = 2026-06-09 14:00 local (12:00Z) → only 13 and 14 are due
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-09T12:00:00Z')), {
      now: new Date('2026-06-09T12:00:00Z'),
      targetDate: '2026-06-09',
    });
    expect(stats.placed).toBe(2);
    const hours = await rows<{ arm_hour: number }>(
      db,
      `select arm_hour from amsterdam_paper_bets where target_date = '2026-06-09' order by arm_hour`,
    );
    expect(hours.map((h) => h.arm_hour)).toEqual([13, 14]);
  });
});

describe('amsterdam-paper-trade — grading', () => {
  it('resolves pending bets once the observation finalizes (22°C → idx8 wins)', async () => {
    await seedFinalizedObs('2026-06-10', 22);
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-11T15:30:00Z')), {
      now: new Date('2026-06-11T15:30:00Z'),
      targetDate: '2026-06-11', // no event that day → placement no-ops; grading still runs
    });
    expect(stats.graded).toBe(4);

    const bets = await rows<{ arm_hour: number; status: string; won: boolean; pnl_usd: string; winner_idx: number; actual_native_c: number }>(
      db,
      `select arm_hour, status, won, pnl_usd, winner_idx, actual_native_c
       from amsterdam_paper_bets where target_date = '2026-06-10' order by arm_hour`,
    );
    // 13:00 (19°C) lost, 14:00 (21°C) lost, 15:00 & 16:00 (22°C) won
    expect(bets.map((b) => b.status)).toEqual(['lost', 'lost', 'won', 'won']);
    expect(bets.every((b) => b.winner_idx === 8 && b.actual_native_c === 22)).toBe(true);
    expect(Number(bets[0]!.pnl_usd)).toBeCloseTo(-10, 6); // lost the stake (no fee seeded)
    expect(Number(bets[2]!.pnl_usd)).toBeCloseTo(12.5 * (1 - 0.8), 4); // won: shares·(1−ask) = 2.5
  });

  it('does not double-grade — a graded bet is no longer pending', async () => {
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-11T16:30:00Z')), {
      now: new Date('2026-06-11T16:30:00Z'),
      targetDate: '2026-06-11',
    });
    expect(stats.graded).toBe(0);
  });
});

describe('amsterdam-paper-trade — no market', () => {
  it('no-ops cleanly when there is no Amsterdam event for the day', async () => {
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2030-01-01T15:30:00Z')), {
      now: new Date('2030-01-01T15:30:00Z'),
      targetDate: '2030-01-01',
    });
    expect(stats).toMatchObject({ placed: 0, armsAvailable: 0 });
  });
});

describe('dash_amsterdam_sim — the head-to-head read', () => {
  it('returns per-arm standings, a leader, equity curves and the bet log', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_amsterdam_sim: Record<string, unknown> }>(
        db,
        `select public.dash_amsterdam_sim() as dash_amsterdam_sim`,
      );
      return r[0]!.dash_amsterdam_sim;
    });

    const arms = out.arms as { hour: number; nGraded: number; pnl: number }[];
    expect(arms.map((a) => a.hour)).toEqual([13, 14, 15, 16]);
    // 2026-06-10 graded for all four; 2026-06-09's two arms still pending (no obs)
    const a15 = arms.find((a) => a.hour === 15)!;
    expect(Number(a15.nGraded)).toBe(1);
    expect(Number(a15.pnl)).toBeCloseTo(2.5, 4);

    const leader = out.leader as { hour: number; pnl: number };
    expect([15, 16]).toContain(leader.hour); // the two winning arms lead at +2.5
    expect(Number(leader.pnl)).toBeCloseTo(2.5, 4);

    const equity = out.equityByArm as Record<string, { date: string; cum: number }[]>;
    expect(Object.keys(equity).sort()).toEqual(['13', '14', '15', '16']);
    expect(Array.isArray(out.betLog)).toBe(true);
    expect((out.betLog as unknown[]).length).toBeGreaterThanOrEqual(4);

    // 0042: betsByArm carries the graded (won, ask) rows per arm — the CI input. 2026-06-10 graded all
    // four; 2026-06-09 is still pending (no obs) and must NOT appear (graded only).
    const betsByArm = out.betsByArm as Record<string, { won: boolean; ask: number }[]>;
    expect(Object.keys(betsByArm).sort()).toEqual(['13', '14', '15', '16']);
    expect(betsByArm['15']).toEqual([{ won: true, ask: 0.8 }]); // 22°C @0.80 won
    expect(betsByArm['13']).toEqual([{ won: false, ask: 0.3 }]); // 19°C @0.30 lost
    expect(betsByArm['16']!.every((r) => r.won === true)).toBe(true);

    const coverage = out.coverage as { nDays: number; nGradedDays: number };
    expect(Number(coverage.nDays)).toBe(2);
    expect(Number(coverage.nGradedDays)).toBe(1);
  });

  it('is operator-gated (ERR_FORBIDDEN for a non-operator)', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.dash_amsterdam_sim()`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });
});

describe('amsterdam-paper-trade — floor "truth accuracy" (0043)', () => {
  it('fetches KNMI, fills floor-truth + signed error on graded bets, independent of the market', async () => {
    // 2026-06-10's four bets are already graded on the market (22°C won). The real KNMI high was 22.4 →
    // floor 22. So 15:00/16:00 (predicted 22) are truth-hits; 13:00 (19) / 14:00 (21) are truth-misses —
    // and signed_error = running-max basis − 22.4 (no forecast seeded → basis = running max).
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-12T15:30:00Z')), {
      now: new Date('2026-06-12T15:30:00Z'),
      targetDate: '2026-06-12', // no event → place/grade no-op; the truth phase fetches + fills
      fetchJson: async () => knmiPayload('2026-06-10', 224),
    });
    expect(stats.truthIngested).toBe(1);
    expect(stats.truthFilled).toBe(4);

    const bets = await rows<{ arm_hour: number; predicted_native_c: number; actual_decimal_c: string; truth_won: boolean; signed_error_c: string; running_max_c: string }>(
      db,
      `select arm_hour, predicted_native_c, actual_decimal_c, truth_won, signed_error_c, running_max_c
       from amsterdam_paper_bets where target_date = '2026-06-10' order by arm_hour`,
    );
    expect(bets.every((b) => Number(b.actual_decimal_c) === 22.4)).toBe(true);
    expect(bets.map((b) => b.truth_won)).toEqual([false, false, true, true]); // 19,21 miss; 22,22 hit floor(22.4)=22
    // signed error = running max (basis, no forecast) − 22.4
    for (const b of bets) {
      expect(Number(b.signed_error_c)).toBeCloseTo(Number(b.running_max_c) - 22.4, 2);
    }
  });

  it('is idempotent — a second run fills nothing new (truth already current)', async () => {
    const stats = await amsterdamPaperTrade(ctxAt(new Date('2026-06-12T16:30:00Z')), {
      now: new Date('2026-06-12T16:30:00Z'),
      targetDate: '2026-06-12',
      fetchJson: async () => knmiPayload('2026-06-10', 224),
    });
    expect(stats.truthFilled).toBe(0);
  });

  it('surfaces the truth panel in dash_amsterdam_sim (truthByArm + per-arm hit/MAE/bias + coverage)', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_amsterdam_sim: Record<string, unknown> }>(
        db,
        `select public.dash_amsterdam_sim() as dash_amsterdam_sim`,
      );
      return r[0]!.dash_amsterdam_sim;
    });

    const truthByArm = out.truthByArm as Record<string, { truthWon: boolean; signedErrorC: number }[]>;
    expect(truthByArm['15']).toEqual([{ truthWon: true, signedErrorC: expect.closeTo(21.6 - 22.4, 2) }]);
    expect(truthByArm['13']![0]!.truthWon).toBe(false);

    const arms = out.arms as { hour: number; nTruth: number; truthHitRate: number | null; mae: number | null }[];
    const a15 = arms.find((a) => a.hour === 15)!;
    expect(Number(a15.nTruth)).toBe(1);
    expect(Number(a15.truthHitRate)).toBe(1); // floor-hit
    expect(Number(a15.mae)).toBeCloseTo(0.8, 2); // |21.6 − 22.4|

    const tc = out.truthCoverage as { nBetsWithTruth: number; nDaysWithTruth: number; tableNDays: number };
    expect(Number(tc.nBetsWithTruth)).toBe(4);
    expect(Number(tc.nDaysWithTruth)).toBe(1);
    expect(Number(tc.tableNDays)).toBe(1);
  });
});

describe('dash_amsterdam_sim — tomorrow + live running max (0046)', () => {
  it('surfaces tomorrow forecast (raw when <20 bias pairs) + bucket/odds + live running max', async () => {
    const cityId = (await rows<{ id: string }>(db, `select id from cities where slug = 'amsterdam'`))[0]!.id;
    // The RPC keys tomorrow/today off now() at Etc/GMT-2 — compute the same dates in SQL so the test is
    // date-independent (no hard-coded "tomorrow").
    const tmrw = (await rows<{ d: string }>(db, `select ((now() at time zone 'Etc/GMT-2')::date + 1)::text d`))[0]!.d;
    const today = (await rows<{ d: string }>(db, `select ((now() at time zone 'Etc/GMT-2')::date)::text d`))[0]!.d;
    const ev = await seedEvent(cityId, tmrw);
    // single lead-1 capture for tomorrow → mean 22.0 → wuRound 22 → bucket idx8 ('22°C'). No prior fc1/obs
    // pairs exist, so the bias is untrusted (<20) and the DISPLAY falls back to the raw forecast.
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
       values ('EHAM', 'gfs_seamless', $1, 1, 22.0, '10Z', 'forecast_api', now())`,
      [tmrw],
    );
    await seedAsk(ev, 8, 0.42, new Date('2026-06-21T08:00:00Z').toISOString()); // quote on the 22°C bucket
    await db.query(
      `insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs, last_obs_at)
       values ('EHAM', $1, 24.3, 24, 9, now())`,
      [today],
    );

    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_amsterdam_sim: Record<string, unknown> }>(
        db,
        `select public.dash_amsterdam_sim() as dash_amsterdam_sim`,
      );
      return r[0]!.dash_amsterdam_sim;
    });

    const t = out.tomorrow as Record<string, unknown>;
    expect(t.hasMarket).toBe(true);
    expect(Number(t.nModels)).toBe(1);
    expect(Number(t.rawForecastC)).toBeCloseTo(22.0, 3);
    expect(t.biasCorrected).toBe(false);
    expect(Number(t.forecastC)).toBeCloseTo(22.0, 3);
    expect(Number(t.predictedC)).toBe(22);
    expect(t.label).toBe('22°C');
    expect(Number(t.ask)).toBeCloseTo(0.42, 3);

    const l = out.liveRunMax as Record<string, unknown>;
    expect(Number(l.maxTenthsC)).toBeCloseTo(24.3, 3);
    expect(Number(l.nObs)).toBe(9);
    expect(l.lastObsAt).toBeTruthy();
  });
});

describe('amsterdam *_inputs RPC shape (0044 — the port invariant)', () => {
  it('grade_inputs / truth_inputs return { rows: [...] } (an object), never a top-level array', async () => {
    // A top-level jsonb array is misread by supabasePort as a RETURNS TABLE row set (arrays pass through
    // unwrapped), which silently zeroed the Edge tick's grade + truth-fill before 0044. Lock the wrapped
    // shape at the DB boundary so it can never regress. (The PGlite twin masks this — it wraps every shape
    // via `select * from fn()` — so the contract is asserted here directly on the function's return value.)
    const shape = await rows<{ g_outer: string; t_outer: string; g_rows: string; t_rows: string }>(
      db,
      `select jsonb_typeof(public.amsterdam_sim_grade_inputs())          as g_outer,
              jsonb_typeof(public.amsterdam_sim_truth_inputs())          as t_outer,
              jsonb_typeof(public.amsterdam_sim_grade_inputs()->'rows')  as g_rows,
              jsonb_typeof(public.amsterdam_sim_truth_inputs()->'rows')  as t_rows`,
    );
    expect(shape[0]).toEqual({ g_outer: 'object', t_outer: 'object', g_rows: 'array', t_rows: 'array' });
  });
});
