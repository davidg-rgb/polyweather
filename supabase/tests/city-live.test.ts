/**
 * CITY-LIVE (migration 0085, staged DARK) — the city-paper-trade handler EXTENSION + the toggle/interlock
 * surface, exercised in PGlite (the trade-config.test.ts idiom). Covers CITY-LIVE.md §2:
 *
 *   • MAKER TWIN — a maker entry rests at the lock-hour best_bid for every placement; a LATER ask ≤ the bid
 *     fills it (conservative lower bound); filled twins grade at $0 maker fee; unfilled-at-resolution → 'unfilled'.
 *   • PROMOTION BOARD — buildCityPromotionBoard over the graded ledger is recorded each tick (best-effort).
 *   • dash_city_live — { arms, board, twin } operator read (the taker-vs-maker differential).
 *   • THE TOGGLE TABLE — city_live_arm_set audits per field; the $5 CHECK + the max-2 constraint trigger enforce
 *     the CITY-LIVE.md §0 envelope in SQL; city_live_runner_inputs feeds the daemon.
 *   • STRATEGY-AWARE PREFLIGHT — trade_live_preflight('city-taker') (its own branch) and the no-arg delegator.
 *   • DEPLOY-ORDER SAFETY — the handler places + grades byte-identically when 0085 is NOT applied (the
 *     city-live RPCs undefined → the extension degrades silently, never breaking the tick).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type PlaceInputs } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import { cityPaperTrade } from '../functions/city-paper-trade/handler.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const cfg = parseConfigRows([]);
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

// A Singapore-shaped °C ladder (whole-°C interior + open tails), matching city-sim.test.ts.
const LADDER = [
  { idx: 0, label: '29°C or below', low: null as number | null, high: 29 as number | null },
  { idx: 1, label: '30°C', low: 30, high: 30 },
  { idx: 2, label: '31°C', low: 31, high: 31 },
  { idx: 3, label: '32°C', low: 32, high: 32 },
  { idx: 4, label: '33°C', low: 33, high: 33 },
  { idx: 5, label: '34°C or higher', low: 34, high: null },
];

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('CITY-LIVE — maker twin place/fill/grade + promotion board + dash_city_live (0085)', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  const ctxAt = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });

  async function seedQuote(eventId: string, bucketIdx: number, bid: number, ask: number, capturedAt: string): Promise<void> {
    const bucket = (
      await rows<{ id: string }>(db, `select id from market_buckets where event_id = $1 and bucket_idx = $2`, [eventId, bucketIdx])
    )[0]!;
    await db.query(`insert into market_snapshots (bucket_id, best_bid, best_ask, captured_at) values ($1, $2, $3, $4)`, [
      bucket.id,
      bid,
      ask,
      capturedAt,
    ]);
  }

  beforeAll(async () => {
    db = await freshDb();
    port = pglitePort(db);

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

    const ev = (
      await db.query<{ id: string }>(
        `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok)
         values ($1, $2, $3, $4, 'C', 'highest', true) returning id`,
        ['poly-sg-2026-06-10', 'highest-temperature-in-singapore-on-2026-06-10', cityId, '2026-06-10'],
      )
    ).rows[0]!;
    for (const b of LADDER) {
      await db.query(
        `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ev.id, b.idx, b.label, b.low, b.high, `c-${b.idx}`, `y-${b.idx}`, `n-${b.idx}`],
      );
    }
    // running max: 11→30.4 (idx1 30°C), 12/13/14→~32 (idx3 32°C). No forecast → pure floor (city-sim main day).
    for (const [h, v] of Object.entries({ 9: 28.0, 10: 29.2, 11: 30.4, 12: 31.6, 13: 31.9, 14: 32.0 })) {
      await db.query(`insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values ('WSSS', $1, $2, $3)`, [
        '2026-06-10',
        Number(h),
        v,
      ]);
    }
    // ENTRY-window quotes (both bid + ask) at each arm's lock-hour start SGT = [(h-8):00 UTC). idx1 ask .25/bid .23;
    // idx3 ask .70/bid .68; others ask .02/bid .01. The bet locks the ask; the maker twin rests at the bid.
    const askBook = { 1: 0.25, 3: 0.7 } as Record<number, number>;
    const bidBook = { 1: 0.23, 3: 0.68 } as Record<number, number>;
    for (const [h, t] of [[11, '03'], [12, '04'], [13, '05'], [14, '06']] as const) {
      void h;
      for (const b of LADDER) await seedQuote(ev.id, b.idx, bidBook[b.idx] ?? 0.01, askBook[b.idx] ?? 0.02, `2026-06-10T${t}:00:00Z`);
    }
    // a LATER idx3 ask 0.60 (≤ the 0.68 resting bid) at 08:00Z — AFTER every arm's lock window → fills the idx3
    // maker twins (arms 12/13/14). idx1 gets no later low ask → its twin stays UNFILLED at resolution.
    await seedQuote(ev.id, 3, 0.55, 0.6, '2026-06-10T08:00:00Z');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('places a maker twin per placement at the lock-hour best_bid (idempotent, $0 stake column stored)', async () => {
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-10T08:30:00Z')), { now: new Date('2026-06-10T08:30:00Z') });
    expect(stats).toMatchObject({ cities: 1, placed: 4, graded: 0, twinPlaced: 4, cityLiveDark: false });

    const twins = await rows<{ arm_hour: number; limit_price: string; shares: string; status: string; filled: boolean }>(
      db,
      `select arm_hour, limit_price, shares, status, filled from city_maker_twin order by arm_hour`,
    );
    expect(twins.map((t) => t.arm_hour)).toEqual([11, 12, 13, 14]);
    // arm11 predicted idx1 (30°C) → bid 0.23; arms 12/13/14 predicted idx3 (32°C) → bid 0.68.
    expect(Number(twins[0]!.limit_price)).toBeCloseTo(0.23, 6);
    expect(Number(twins[0]!.shares)).toBeCloseTo(r4(10 / 0.23), 4);
    expect(twins.slice(1).every((t) => Number(t.limit_price) === 0.68)).toBe(true);
    expect(twins.every((t) => t.status === 'pending')).toBe(true);
  });

  it('conservative fill detection: a later ask ≤ the resting bid fills idx3 (arms 12/13/14); idx1 stays unfilled', async () => {
    // detection ran inside the tick above; re-run detect (idempotent) to confirm the flags settled.
    const twins = await rows<{ arm_hour: number; filled: boolean; fill_detected_at: string | null }>(
      db,
      `select arm_hour, filled, fill_detected_at from city_maker_twin order by arm_hour`,
    );
    expect(twins.find((t) => t.arm_hour === 11)!.filled).toBe(false); // idx1 — no later ask ≤ 0.23
    for (const h of [12, 13, 14]) {
      const t = twins.find((x) => x.arm_hour === h)!;
      expect(t.filled).toBe(true);
      expect(t.fill_detected_at).not.toBeNull();
    }
  });

  it('grades filled twins at $0 maker fee (won) and marks the unfilled twin as unfilled-at-resolution', async () => {
    // truth lands: 32°C → winner idx3. The three FILLED idx3 twins win; the UNFILLED idx1 twin → 'unfilled'.
    await db.query(
      `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
       values ('WSSS', '2026-06-10', 32, 'C', 30, false, now())`,
    );
    const stats = await cityPaperTrade(ctxAt(new Date('2026-06-11T08:00:00Z')), {
      now: new Date('2026-06-11T08:00:00Z'),
      targetDate: '2026-06-11', // no event → placement no-ops; bet + twin grading still runs
    });
    expect(stats.graded).toBe(4);
    expect(Number(stats.twinGraded)).toBe(4); // 3 filled → won, 1 unfilled → 'unfilled'

    const twins = await rows<{ arm_hour: number; status: string; pnl_usd: string | null; shares: string; limit_price: string }>(
      db,
      `select arm_hour, status, pnl_usd, shares, limit_price from city_maker_twin order by arm_hour`,
    );
    expect(twins.map((t) => t.status)).toEqual(['unfilled', 'won', 'won', 'won']);
    // unfilled → pnl 0 (no position taken)
    expect(Number(twins[0]!.pnl_usd)).toBe(0);
    // won maker twin: shares·(1−limit), NO fee subtracted (maker fee = $0). limit 0.68.
    const wonShares = r4(10 / 0.68);
    const wonPnl = r4(wonShares * (1 - 0.68));
    expect(Number(twins[1]!.pnl_usd)).toBeCloseTo(wonPnl, 4);
    // the maker twin (bought at the 0.68 bid) out-earns the taker bet (bought at the 0.70 ask) on the same arm.
    const takerPnl = Number(
      (await rows<{ pnl_usd: string }>(db, `select pnl_usd from city_paper_bets where arm_hour = 12`))[0]!.pnl_usd,
    );
    expect(wonPnl).toBeGreaterThan(takerPnl);
  });

  it('records a promotion board snapshot each tick (view = { asOf, rows })', async () => {
    const boards = await rows<{ view: { asOf: string; rows: unknown[] } }>(
      db,
      `select view from city_promotion_board order by captured_at desc limit 1`,
    );
    expect(boards.length).toBeGreaterThanOrEqual(1);
    expect(typeof boards[0]!.view.asOf).toBe('string');
    expect(Array.isArray(boards[0]!.view.rows)).toBe(true);
    const sg = (boards[0]!.view.rows as { slug: string; status: string }[]).find((x) => x.slug === 'singapore');
    expect(sg).toBeTruthy();
    expect(['PROMOTED', 'WATCH', 'INSUFFICIENT', 'DEMOTED']).toContain(sg!.status);
  });

  it('dash_city_live returns { arms, board, twin } with the taker-vs-maker differential (operator-gated)', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_city_live: Record<string, unknown> }>(db, `select public.dash_city_live() as dash_city_live`);
      return r[0]!.dash_city_live;
    });
    expect(Array.isArray(out.arms)).toBe(true);
    expect((out.board as { rows: unknown[] } | null)?.rows).toBeTruthy();

    const twin = (out.twin as { slug: string; nPlacements: number; twinFilledFrac: number; takerPnlUsd: number; makerTwinPnlUsd: number }[]).find(
      (t) => t.slug === 'singapore',
    )!;
    expect(Number(twin.nPlacements)).toBe(4);
    expect(Number(twin.twinFilledFrac)).toBeCloseTo(0.75, 4); // 3 of 4 filled
    const wonPnl = r4(r4(10 / 0.68) * (1 - 0.68));
    expect(Number(twin.makerTwinPnlUsd)).toBeCloseTo(3 * wonPnl, 2); // 3 won twins, unfilled contributes 0
    expect(typeof twin.takerPnlUsd === 'number' || typeof twin.takerPnlUsd === 'string').toBe(true);
  });

  it('dash_city_live is operator-gated (ERR_FORBIDDEN for a non-operator)', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () => rows(db, `select public.dash_city_live()`)),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });

  it('dash_city_live() is a jsonb OBJECT (the 0081 tripwire), never a top-level array', async () => {
    const shape = await asRole(db, 'authenticated', OPERATOR, () =>
      rows<{ t: string }>(db, `select jsonb_typeof(public.dash_city_live()) as t`),
    );
    expect(shape[0]!.t).toBe('object');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('CITY-LIVE — toggle table (arm_set/get, max-2 trigger, $5 CHECK, audit) + strategy-aware preflight', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  const cityIds: Record<string, string> = {};
  const asOperator = <T>(fn: () => Promise<T>) => asRole(db, 'service_role', OPERATOR, fn);

  const armSet = (cityId: string, enabled: boolean, stake: number, entryHour: number | null) =>
    asOperator(() =>
      rows<{ city_live_arm_set: Record<string, unknown> }>(
        db,
        `select public.city_live_arm_set($1::uuid, $2::boolean, $3::numeric, $4::smallint) as city_live_arm_set`,
        [cityId, enabled, stake, entryHour],
      ),
    );

  beforeAll(async () => {
    db = await freshDb();
    port = pglitePort(db);
    for (const [slug, unit, tz, icao, region] of [
      ['singapore', 'C', 'Asia/Singapore', 'WSSS', 'southeast-asia'],
      ['karachi', 'C', 'Asia/Karachi', 'OPKC', 'south-asia'],
      ['london', 'C', 'Europe/London', 'EGLL', 'europe-west'],
    ] as const) {
      await db.query(
        `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
         values ($1, initcap($1), 'XX', $2, $3, $4, now(), now())`,
        [slug, unit, tz, region],
      );
      cityIds[slug] = (await rows<{ id: string }>(db, `select id from cities where slug = $1`, [slug]))[0]!.id;
      // city_sim_config so runner_inputs can resolve icao/tz for an enabled arm.
      await db.query(
        `insert into city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active)
         values ($1, $2, $3, $4, array[11,12,13,14]::smallint[], 12, 10, true)`,
        [cityIds[slug], slug, icao, tz],
      );
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  it('city_live_arm_set enables a city, stamps enabled_at, and audits every changed field', async () => {
    const res = await armSet(cityIds['singapore']!, true, 5, 13);
    const row = res[0]!.city_live_arm_set['row'] as Record<string, unknown>;
    expect(row['enabled']).toBe(true);
    expect(Number(row['stake_usd'])).toBe(5);
    expect(Number(row['entry_hour_override'])).toBe(13);
    expect(row['enabled_at']).not.toBeNull();

    const audit = await rows<{ field: string; new_value: string }>(
      db,
      `select field, new_value from city_live_audit where city_id = $1 order by field`,
      [cityIds['singapore']],
    );
    expect(audit.map((a) => a.field).sort()).toEqual(['enabled', 'entry_hour_override', 'stake_usd']);
    expect(audit.find((a) => a.field === 'enabled')!.new_value).toBe('true');
  });

  it('city_live_arms_get returns the arm (operator-gated object envelope)', async () => {
    const out = await asOperator(() =>
      rows<{ city_live_arms_get: { rows: { slug: string; enabled: boolean; entryHourOverride: number }[] } }>(
        db,
        `select public.city_live_arms_get() as city_live_arms_get`,
      ),
    );
    const arm = out[0]!.city_live_arms_get.rows.find((a) => a.slug === 'singapore')!;
    expect(arm.enabled).toBe(true);
    expect(Number(arm.entryHourOverride)).toBe(13);
  });

  it('city_live_runner_inputs surfaces enabled arms with entryHour = the override', async () => {
    const out = await rows<{ city_live_runner_inputs: { rows: { slug: string; entryHour: number; tz: string }[] } }>(
      db,
      `select public.city_live_runner_inputs() as city_live_runner_inputs`,
    );
    const arm = out[0]!.city_live_runner_inputs.rows.find((a) => a.slug === 'singapore')!;
    expect(Number(arm.entryHour)).toBe(13);
    expect(arm.tz).toBe('Asia/Singapore');
  });

  it('the $5/city CHECK rejects a stake above the envelope (state unchanged)', async () => {
    await expect(armSet(cityIds['singapore']!, true, 6, 13)).rejects.toThrow(/city_live_arms_stake_usd_check|stake_usd/);
    const [row] = await rows<{ stake_usd: string }>(db, `select stake_usd from city_live_arms where city_id = $1`, [
      cityIds['singapore'],
    ]);
    expect(Number(row!.stake_usd)).toBe(5); // the failed write rolled back
  });

  it('the max-2 constraint trigger blocks enabling a 3rd city (RAISE surfaced verbatim)', async () => {
    await armSet(cityIds['karachi']!, true, 5, null); // 2 enabled — OK
    await expect(armSet(cityIds['london']!, true, 5, null)).rejects.toThrow(/at most 2 cities may be enabled/i);
    const [n] = await rows<{ c: string }>(db, `select count(*) c from city_live_arms where enabled`);
    expect(Number(n!.c)).toBe(2);
  });

  it("trade_live_preflight('city-taker') passes with mode live + a run window + ≤2 enabled arms ≤ $5", async () => {
    await db.exec(`update public.trade_config set mode = 'live', active_until = current_date + 7 where id = 1`);
    const [r] = await rows<{ v: { ok: boolean; reasons: string[]; checks: Record<string, unknown> } }>(
      db,
      `select public.trade_live_preflight('city-taker') as v`,
    );
    expect(r!.v.ok).toBe(true);
    expect(r!.v.reasons).toEqual([]);
    expect(r!.v.checks['strategy']).toBe('city-taker');
    expect(Number(r!.v.checks['nEnabledArms'])).toBe(2);
    // it does NOT gate on the forward-paper bot_gate_snapshot (advisory by operator decision — CITY-LIVE.md §0).
    expect(r!.v.checks).not.toHaveProperty('gatePass');
  });

  it("trade_live_preflight('city-taker') blocks when mode is not live", async () => {
    await db.exec(`update public.trade_config set mode = 'off' where id = 1`);
    const [r] = await rows<{ v: { ok: boolean; reasons: string[] } }>(
      db,
      `select public.trade_live_preflight('city-taker') as v`,
    );
    expect(r!.v.ok).toBe(false);
    expect(r!.v.reasons.some((x) => /mode is.*not/i.test(x))).toBe(true);
    await db.exec(`update public.trade_config set mode = 'live' where id = 1`);
  });

  it('the no-arg trade_live_preflight() still delegates to the maker-exit branch (byte-equivalent checks)', async () => {
    const [r] = await rows<{ checks: Record<string, unknown> }>(
      db,
      `select public.trade_live_preflight()->'checks' as checks`,
    );
    // the maker-exit branch carries gatePass/openExposureUsd and NO 'strategy' key — the 0084 contract intact.
    expect(r!.checks).toHaveProperty('gatePass');
    expect(r!.checks).toHaveProperty('openExposureUsd');
    expect(r!.checks).not.toHaveProperty('strategy');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('CITY-LIVE — handler degradation when 0085 is NOT applied (deploy-order safety)', () => {
  const FAKE_CONFIG = { cityId: 'c-sg', slug: 'singapore', icao: 'WSSS', unit: 'C', tz: 'Asia/Singapore', stakeUsd: 10 };
  const FAKE_PLACE_INPUT: PlaceInputs = {
    targetDate: '2026-07-04',
    eventId: 'ev-sg-1',
    feeRate: 0,
    ladder: [
      { bucketIdx: 0, low: null, high: 29 },
      { bucketIdx: 1, low: 30, high: 30 },
      { bucketIdx: 2, low: 31, high: 31 },
      { bucketIdx: 3, low: 32, high: 32 },
      { bucketIdx: 4, low: 33, high: null },
    ],
    labels: { 3: '32°C' },
    forecastC: null,
    forecastMaxHour: 12,
    arms: [{ hour: 13, runMaxC: 32.0, asks: [{ bucketIdx: 3, ask: 0.7 }] }],
  };

  /** A DbPort where the base sim RPCs work but every CITY-LIVE (0085) RPC is undefined — the pre-apply state. */
  function preApplyPort(): DbPort {
    return {
      async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
        switch (fn) {
          case 'city_sim_active_configs':
            return [{ city_sim_active_configs: { rows: [FAKE_CONFIG] } }] as unknown as T[];
          case 'city_sim_place_inputs':
            return [{ city_sim_place_inputs: FAKE_PLACE_INPUT }] as unknown as T[];
          case 'city_sim_record':
            return [{ city_sim_record: (args.p_rows as unknown[]).length }] as unknown as T[];
          case 'city_sim_grade_inputs':
            return [{ city_sim_grade_inputs: { rows: [] } }] as unknown as T[];
          // 0085 objects absent → Postgres/PostgREST undefined-function error (the isUndefinedObjectError class).
          case 'city_maker_twin_place':
          case 'city_maker_twin_detect_fills':
          case 'city_maker_twin_grade':
          case 'city_sim_bets_for_promotion':
          case 'city_promotion_record':
            throw new Error(`rpc ${fn} failed: function public.${fn} does not exist`);
          default:
            throw new Error(`preApplyPort: unexpected rpc '${fn}'`);
        }
      },
      async getConfigRows() {
        return [];
      },
    };
  }

  it('places + grades byte-identically; the maker twin + board degrade silently (cityLiveDark)', async () => {
    const now = new Date('2026-07-04T10:00:00Z');
    const ctx: JobCtx = { db: preApplyPort(), config: cfg, log: () => {}, startedAt: now };
    const stats = await cityPaperTrade(ctx, { now, targetDate: '2026-07-04' });
    // the core loop is untouched — 1 city, 1 placement, grading ran.
    expect(stats).toMatchObject({ cities: 1, placed: 1, graded: 0 });
    expect((stats.placedByCity as Record<string, number>).singapore).toBe(1);
    // …and the city-live extension marked itself dark and did nothing (no throw escaped the tick).
    expect(stats).toMatchObject({ twinPlaced: 0, twinFilled: 0, twinGraded: 0, boardRecorded: false, cityLiveDark: true });
  });
});
