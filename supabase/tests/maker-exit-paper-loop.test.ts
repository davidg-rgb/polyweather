/**
 * Migration 0073 (the forward maker-exit paper loop) — the PGlite twin against the real migration chain.
 *
 * Pins: convergence_capture_inputs now carries bestBid (the maker-exit spread diagnostic reads it); the
 * maker_exit_panel snapshot round-trips via record_maker_exit_panel → dash_maker_exit (operator-guarded);
 * record_bot_gate_snapshot persists a forward §9R-E verdict with the maker-exit aggregate columns; record_bot_tick
 * writes a liveness row; and bot_deadman_check's tick-staleness threshold is cadence-aware (bot.tickStaleMin
 * raises it above the 3-min default so a 15-min re-replay loop's forensic tick log does not false-alarm).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

/** Seed a city + a fresh opening_captures row (eventId, age<1h, a bucket carrying bestBid) for the inputs RPC. */
async function seedFreshCapture(db: PGlite, slug: string): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'NL', 'C', 'Europe/Amsterdam', 'europe-west', now(), now()) on conflict (slug) do nothing`,
    [slug],
  );
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
     select 'pe-' || $1, 'ev-' || $1, id, current_date, 'C', true, 1 from cities where slug = $1 returning id`,
    [slug],
  );
  const evId = ev.rows[0]!.id;
  const buckets = JSON.stringify([
    { idx: 0, label: '20°C', mid: 0.1, bestAsk: 0.16, execAsk: 0.16, depthUsd: 200, bestBid: 0.13, execBid: 0.13, houseProb: 0.4 },
  ]);
  await db.query(
    `insert into opening_captures
       (captured_at, event_id, city, target_date, tz_name, created_at_gamma, resolves_at, hours_since_listing,
        peak_mid, is_flat_open, house_seeded, buckets, ev_vol24h, neg_risk)
     values (now() - interval '5 minutes', $1, $2, current_date, 'Europe/Amsterdam', now() - interval '30 minutes',
        now() + interval '1 day', 0.5, 0.16, true, true, $3::jsonb, 9000, true)`,
    [evId, slug, buckets],
  );
  return evId;
}

describe('0073 maker-exit paper loop — schema + RPCs', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  it('convergence_capture_inputs now emits bestBid in the trimmed buckets (the maker-exit spread diagnostic)', async () => {
    await seedFreshCapture(db, 'mx-ams');
    const [r] = await rows<{ out: { captures: { buckets: { bestBid: number; bestAsk: number }[] }[] } }>(
      db, `select public.convergence_capture_inputs(21, array['mx-ams']) as out`,
    );
    const caps = r!.out.captures;
    expect(caps.length).toBeGreaterThan(0);
    const bucket0 = caps[0]!.buckets[0]!;
    expect(Number(bucket0.bestBid)).toBeCloseTo(0.13, 6); // present (0069 trimmed it out; 0073 adds it back)
    expect(Number(bucket0.bestAsk)).toBeCloseTo(0.16, 6);
  });

  it('maker_exit_panel round-trips: record_maker_exit_panel → dash_maker_exit (operator-guarded)', async () => {
    const view = { entries: [], gate: { label: 'INSUFFICIENT_DATA', nMarkets: 0 }, days: 21 };
    const ins = await rows<{ id: number }>(db, `select public.record_maker_exit_panel($1::jsonb) as id`, [JSON.stringify(view)]);
    expect(Number(ins[0]!.id)).toBeGreaterThan(0);

    // dash_maker_exit is operator-guarded → forbidden without the operator role …
    await expect(rows(db, `select public.dash_maker_exit() as out`)).rejects.toThrow();
    // … and returns the latest snapshot for the operator.
    const out = await asRole(db, 'authenticated', OPERATOR, async () =>
      (await rows<{ out: { view: { gate: { label: string } } } }>(db, `select public.dash_maker_exit() as out`))[0]!.out,
    );
    expect(out.view.gate.label).toBe('INSUFFICIENT_DATA');
  });

  it('record_bot_gate_snapshot persists a forward verdict with the maker-exit aggregate columns', async () => {
    const payload = {
      mode: 'paper', source: 'forward', label: 'KILL', nMarkets: 42, nCities: 7, nDistinctDays: 9,
      winFrac: 0.55, meanNetReturn: 0.05, ciLow: -0.01, ciHigh: 0.11, zeroSkillPassRate: 0.02,
      reason: 'ciLow ≤ 0', makerExitFrac: 0.6, realizedRebateUsd: 1.23, totalNetUsd: 4.5, nOpen: 3,
    };
    await rows(db, `select public.record_bot_gate_snapshot($1::jsonb)`, [JSON.stringify(payload)]);
    const [g] = await rows<{ label: string; maker_exit_frac: number; realized_rebate_usd: number; n_open: number; source: string }>(
      db, `select label, maker_exit_frac, realized_rebate_usd, n_open, source from bot_gate_snapshot order by computed_at desc limit 1`,
    );
    expect(g!.label).toBe('KILL');
    expect(g!.source).toBe('forward');
    expect(Number(g!.maker_exit_frac)).toBeCloseTo(0.6, 6);
    expect(Number(g!.realized_rebate_usd)).toBeCloseTo(1.23, 6);
    expect(Number(g!.n_open)).toBe(3);
  });

  it('record_bot_tick writes a liveness row', async () => {
    await rows(db, `select public.record_bot_tick($1::jsonb)`, [JSON.stringify({ mode: 'paper', ran: true, placed: 5, filled: 5, exited: 4, gateReason: 'KILL' })]);
    const [t] = await rows<{ mode: string; placed: number; exited: number }>(
      db, `select mode, placed, exited from bot_tick_log order by as_of desc limit 1`,
    );
    expect(t!.mode).toBe('paper');
    expect(Number(t!.placed)).toBe(5);
    expect(Number(t!.exited)).toBe(4);
  });
});

describe('0073 bot_deadman_check — cadence-aware, MODE-SCOPED tick threshold (bot.tickStaleMin.<mode>)', () => {
  it('a 10-min paper tick does NOT alarm with bot.tickStaleMin.paper=45, but DOES under the 3-min default', async () => {
    const db = await freshDb();
    try {
      // a recent forward gate snapshot (so the gate branch never alarms) + a 10-min-old paper tick.
      await db.query(`insert into bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'paper', 'forward', 'INSUFFICIENT_DATA')`);
      await db.query(`insert into bot_tick_log (as_of, mode, ran) values (now() - interval '10 minutes', 'paper', true)`);

      // 0073 seeds bot.tickStaleMin.paper=45 → greatest(45,3)=45 min threshold → a 10-min tick is fresh → no alarm.
      const ok = await rows<{ out: { alarmed: boolean } }>(db, `select public.bot_deadman_check() as out`);
      expect(ok[0]!.out.alarmed).toBe(false);

      // remove the PAPER override → the threshold falls back to 3× tickIntervalSec (≈1.5 → floored to 3 min) → the
      // SAME 10-min tick now alarms. This is exactly the false-alarm the cadence-aware override prevents.
      await db.query(`delete from config where key = 'bot.tickStaleMin.paper'`);
      const stale = await rows<{ out: { alarmed: boolean } }>(db, `select public.bot_deadman_check() as out`);
      expect(stale[0]!.out.alarmed).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('the 45-min relaxation is MODE-SCOPED: a future live 30s-tick bot keeps its tight ~3-min deadman', async () => {
    const db = await freshDb();
    try {
      // simulate the live bot: tradingMode=live, a 30s tick interval, and a 10-min-old LIVE tick.
      await db.query(`insert into config (key, value) values ('tradingMode', 'live') on conflict (key) do update set value = excluded.value`);
      await db.query(`insert into bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'live', 'forward', 'INSUFFICIENT_DATA')`);
      await db.query(`insert into bot_tick_log (as_of, mode, ran) values (now() - interval '10 minutes', 'live', true)`);

      // bot.tickStaleMin.paper=45 is present (from 0073) but it must NOT apply to LIVE mode — the live threshold
      // falls back to greatest(3× tickIntervalSec, 3) = 3 min, so a 10-min live tick alarms (positions unmanaged).
      const out = await rows<{ out: { alarmed: boolean } }>(db, `select public.bot_deadman_check() as out`);
      expect(out[0]!.out.alarmed).toBe(true);
    } finally {
      await db.close();
    }
  });
});
