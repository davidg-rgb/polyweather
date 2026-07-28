/**
 * BUY-TABLE live lane (migration 0095) — the config defaults, the ANY-status lane ledger read, the
 * strategy-aware trade_live_preflight('buy-table') branch, the crons (the §8.1 body-periodKey stamp),
 * the day-bucketed deadman, and the Slack push-kind allowlist. Exercised in PGlite (the
 * trade-config/city-live test idiom). The handler itself is unit-tested in buy-table-tick-handler.test.ts.
 *
 * + migration 0096: dash_trading().buyTable — the lane position ledger (ANY-status rows joined to their
 * market identity + graded won/lost/open/unfilled/failed against the market_events winner, with totals).
 *
 * + migration 0097→0109: the per-city price caps, MAX-ONLY since 0109 (operator 2026-07-18 — the min-bid
 * input is gone; the lane buys whenever the ask ≤ the cap) — buy_table_city_cap_set (0093 slug-validation
 * idiom; null max clears; 0 < max ≤ 0.99) / buy_table_price_cap_set (0 < max ≤ 0.99) and
 * dash_trading().buyTable.priceConfig { globalMax, cityCaps }. 0109 also RETIRES the 0097 range surface
 * (buy_table_price_range_set dropped, buy_table.city_price_ranges folded to maxes + deleted).
 *
 * + migrations 0098→0099→0100: the live-cycle logged lo/hi. 0098 inlined the scan into dash_trading() and
 * took the console down on the authenticated role's 8s statement timeout; 0099 split it into the fail-soft
 * buy_table_live_cycles() RPC; 0100 made it O(1) — a statement-level trigger on opening_captures folds each
 * new capture tick's gate price (the predicted bucket's executable ask — the exact selectBuyTableCandidates
 * pick) into the buy_table_cycle_ranges running aggregates, and the RPC just reads that tiny table.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

let db: PGlite;

/** Call the operator-guarded dash_trading() as the single allow-listed operator (the trade-config idiom). */
const asOperator = <T>(fn: () => Promise<T>) =>
  asRole(db, 'service_role', { email: 'david.geborek@gmail.com' }, fn);

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0095 config defaults (+ the 0102 entry-rule defaults)', () => {
  it('seeds buy_table.price_cap 0.15 / lead 2–12h / tick_enabled true / entry rules OFF (1 attempt, no halt)', async () => {
    const cfg = await rows<{ key: string; value: string }>(
      db,
      `select key, value from config where key like 'buy_table.%' order by key`,
    );
    expect(Object.fromEntries(cfg.map((r) => [r.key, r.value]))).toEqual({
      'buy_table.price_cap': '0.15',
      'buy_table.lead_max_h': '12',
      'buy_table.lead_min_h': '2',
      'buy_table.tick_enabled': 'true',
      // 0102: defaults reproduce the original one-attempt-EVER behavior exactly
      'buy_table.max_entry_attempts': '1',
      'buy_table.stop_after_first_success': 'false',
      // 0115: the dead-bucket guards (dead-pick min bid + favorite veto prob)
      'buy_table.dead_pick_min_bid': '0.02',
      'buy_table.favorite_veto_prob': '0.85',
      // 0121: the floor veto (armed by the seed — gap 3°C above the running max at local ≥10h)
      'buy_table.floor_veto_gap_c': '3',
      'buy_table.floor_veto_min_local_hour': '10',
    });
  });

  it('a re-apply preserves an operator edit (on-conflict-do-nothing seeding)', async () => {
    await db.exec(`update config set value = '0.12' where key = 'buy_table.price_cap'`);
    // re-run just the seed statement (the idempotency contract the full-chain double-apply also covers)
    await db.exec(
      `insert into public.config (key, value) values ('buy_table.price_cap', '0.15') on conflict (key) do nothing`,
    );
    const [r] = await rows<{ value: string }>(db, `select value from config where key = 'buy_table.price_cap'`);
    expect(r!.value).toBe('0.12');
    await db.exec(`update config set value = '0.15' where key = 'buy_table.price_cap'`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0095 buy_table_entries — the ANY-status lane ledger read (the one-entry-EVER gate input)', () => {
  afterEach(async () => {
    await db.exec(`delete from public.live_fills`);
    await db.exec(`delete from public.live_orders`);
  });

  it('returns a jsonb OBJECT envelope {rows:[]} when empty (0081 tripwire)', async () => {
    const [r] = await rows<{ t: string; v: { rows: unknown[] } }>(
      db,
      `select jsonb_typeof(public.buy_table_entries('live')) as t, public.buy_table_entries('live') as v`,
    );
    expect(r!.t).toBe('object');
    expect(r!.v.rows).toEqual([]);
  });

  it('returns buy-table BUY/entry rows for the mode INCLUDING terminal failed rows; other strategies/modes excluded', async () => {
    const ins = (mode: string, strategy: string, status: string, key: string) =>
      db.query(
        `insert into public.live_orders
           (mode, intent_key, client_order_id, market_id, token_id, side, purpose, order_type, price, size, trade_date, status, strategy)
         values ($1, $2, $2 || ':cid', 'mkt-' || $2, 'tok-' || $2, 'BUY', 'entry', 'FAK', 0.12, 40, '2026-07-11', $3, $4)`,
        [mode, key, status, strategy],
      );
    await ins('live', 'buy-table', 'filled', 'k1');
    await ins('live', 'buy-table', 'failed', 'k2'); // terminal — MUST still be visible (no re-entry ever)
    await ins('live', 'maker-exit', 'filled', 'k3'); // other lane — excluded
    await ins('dry-run', 'buy-table', 'filled', 'k4'); // other mode — excluded

    const [r] = await rows<{ v: { rows: Array<{ intentKey: string; status: string }> } }>(
      db,
      `select public.buy_table_entries('live') as v`,
    );
    expect(r!.v.rows.map((x) => [x.intentKey, x.status])).toEqual([
      ['k1', 'filled'],
      ['k2', 'failed'],
    ]);
  });

  it('is service-role only (anon/authenticated cannot EXECUTE)', async () => {
    const [g] = await rows<{ anon_can: boolean; authd_can: boolean; svc_can: boolean }>(
      db,
      `select has_function_privilege('anon', 'public.buy_table_entries(text)', 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', 'public.buy_table_entries(text)', 'EXECUTE') as authd_can,
              has_function_privilege('service_role', 'public.buy_table_entries(text)', 'EXECUTE') as svc_can`,
    );
    expect(g).toEqual({ anon_can: false, authd_can: false, svc_can: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("0095 trade_live_preflight('buy-table') — the generic interlock tagged with the strategy", () => {
  const preflight = () =>
    rows<{ v: { ok: boolean; reasons: string[]; checks: Record<string, unknown> } }>(
      db,
      `select public.trade_live_preflight('buy-table') as v`,
    );

  afterEach(async () => {
    await db.exec(`delete from public.bot_gate_snapshot`);
    await db.exec(`delete from public.trade_gate_override`);
    await db.exec(`update public.trade_config set mode = 'off', active_until = null where id = 1`);
  });

  it('DARK config blocks with mode + window + gate reasons; checks carry strategy=buy-table', async () => {
    const [r] = await preflight();
    expect(r!.v.ok).toBe(false);
    const joined = r!.v.reasons.join(' | ');
    expect(joined).toMatch(/mode is/);
    expect(joined).toMatch(/active_until not set/);
    expect(joined).toMatch(/no PASS forward paper gate/);
    expect(r!.v.checks['strategy']).toBe('buy-table');
    expect(r!.v.checks).toHaveProperty('gatePass');
    expect(r!.v.checks).toHaveProperty('openExposureUsd');
  });

  it('mode live + run window WITHOUT gate/override still blocks (the interlock is not weakened)', async () => {
    await db.exec(`update public.trade_config set mode = 'live', active_until = current_date + 7 where id = 1`);
    const [r] = await preflight();
    expect(r!.v.ok).toBe(false);
    expect(r!.v.reasons).toEqual([
      'no PASS forward paper gate (bot_gate_snapshot mode=paper/source=forward) and no ACTIVE trade_gate_override row',
    ]);
  });

  it('an ACTIVE trade_gate_override unlocks it (the operator route for this KILLed-record lane)', async () => {
    await db.exec(`update public.trade_config set mode = 'live', active_until = current_date + 7 where id = 1`);
    await db.exec(
      `insert into public.trade_gate_override (reason, expires_at) values ('buy-table live small', now() + interval '7 days')`,
    );
    const [r] = await preflight();
    expect(r!.v.ok).toBe(true);
    expect(r!.v.reasons).toEqual([]);
    expect(r!.v.checks['override']).toBe(true);
    expect(r!.v.checks['strategy']).toBe('buy-table');
  });

  it('a BACKTEST PASS does NOT unlock it (forward-only gate, unchanged)', async () => {
    await db.exec(`update public.trade_config set mode = 'live', active_until = current_date + 7 where id = 1`);
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'paper', 'backtest', 'PASS')`,
    );
    const [r] = await preflight();
    expect(r!.v.ok).toBe(false);
    expect(r!.v.checks['gatePass']).toBe(false);
  });

  it('a FORWARD paper PASS unlocks it (same gate of record as the generic branch)', async () => {
    await db.exec(`update public.trade_config set mode = 'live', active_until = current_date + 7 where id = 1`);
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label) values (now(), 'paper', 'forward', 'PASS')`,
    );
    const [r] = await preflight();
    expect(r!.v.ok).toBe(true);
    expect(r!.v.checks['gatePass']).toBe(true);
  });

  it('the maker-exit default + the no-arg delegator stay byte-equivalent (no strategy key)', async () => {
    const [r] = await rows<{ one: Record<string, unknown>; noarg: Record<string, unknown> }>(
      db,
      `select public.trade_live_preflight('maker-exit')->'checks' as one,
              public.trade_live_preflight()->'checks' as noarg`,
    );
    for (const checks of [r!.one, r!.noarg]) {
      expect(checks).toHaveProperty('gatePass');
      expect(checks).toHaveProperty('openExposureUsd');
      expect(checks).not.toHaveProperty('strategy');
    }
    expect(r!.one).toEqual(r!.noarg);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0095/0108 crons — the laned edge tick with the §8.1 body periodKey + the pure-SQL deadman', () => {
  it('buy-table-tick is registered on the C15 minute lane with vault secrets, the region pin AND a fire-time body periodKey', async () => {
    const [j] = await rows<{ schedule: string; command: string }>(
      db,
      `select schedule, command from cron.job where jobname = 'buy-table-tick'`,
    );
    expect(j).toBeTruthy();
    // 0108: the C15 compute-shed minute lane codified (was 0095's */10 — quarter minutes are contended).
    // 0114: window-split — the 10-min lane keeps only the OFF-window hours (candidates exist only ~00-10Z;
    // the fast lane below covers the window).
    expect(j!.schedule).toBe('3,13,23,33,43,53 10-23 * * *');
    expect(j!.command).toContain(`vault.decrypted_secrets where name = 'project_url'`);
    expect(j!.command).toContain(`vault.decrypted_secrets where name = 'cron_secret'`);
    expect(j!.command).toContain('/functions/v1/buy-table-tick');
    // 0108 — the C44 root-cause fix: pin execution to eu-west-1 (the default egress geolocated DE and
    // Polymarket 403-region-blocks its ORDER endpoint there; Dublin reaches it — the keyless probe proof).
    expect(j!.command).toContain(`'x-region', 'eu-west-1'`);
    // §8.1 — the periodKey is stamped into the BODY at fire time (now() evaluates per fire).
    expect(j!.command).toContain(`body := jsonb_build_object('periodKey', 'buy-table-tick:' || to_char(now()`);
    // 4cb1e77: 10s (the generic 4500 was shorter than a cold Edge boot — the launch-day fix).
    expect(j!.command).toContain('timeout_milliseconds := 10000');
  });

  it('0114: buy-table-tick-fast covers the candidate window at ~2-min with the SAME command (region pin included)', async () => {
    const [slow] = await rows<{ command: string }>(
      db,
      `select command from cron.job where jobname = 'buy-table-tick'`,
    );
    const [fast] = await rows<{ schedule: string; command: string }>(
      db,
      `select schedule, command from cron.job where jobname = 'buy-table-tick-fast'`,
    );
    expect(fast).toBeTruthy();
    // even minutes − {0,30} (the C15 permanently-bad quarters) − {12,42} (poll-markets stays sole-tenant),
    // scoped to hours 0-9 — the only hours candidates can exist (12:00Z closes, [2,12]h lead window).
    expect(fast!.schedule).toBe('2,4,6,8,10,14,16,18,20,22,24,26,28,32,34,36,38,40,44,46,48,50,52,54,56,58 0-9 * * *');
    // the COMMAND is byte-identical to the slow lane's (same fn, same vault reads, same eu-west-1 region
    // pin, same minute-stamped body periodKey) — only the schedule differs.
    expect(fast!.command).toBe(slow!.command);
  });

  it('buy-table-deadman is registered */15 invoking buy_table_deadman_check()', async () => {
    const [j] = await rows<{ schedule: string; command: string }>(
      db,
      `select schedule, command from cron.job where jobname = 'buy-table-deadman'`,
    );
    expect(j).toBeTruthy();
    expect(j!.schedule).toBe('*/15 * * * *');
    expect(j!.command).toBe('select public.buy_table_deadman_check();');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0095 buy_table_deadman_check — day-bucketed staleness + all-degraded window', () => {
  afterEach(async () => {
    await db.exec(`delete from public.job_runs where job = 'buy-table-tick'`);
    await db.exec(`delete from public.alerts_log where kind = 'BUY_TABLE_DEADMAN'`);
  });

  it('stays silent before any run exists (a fresh deploy does not false-page)', async () => {
    const [r] = await rows<{ v: { alarmed: boolean; latestRunAt: string | null } }>(
      db,
      `select public.buy_table_deadman_check() as v`,
    );
    expect(r!.v.alarmed).toBe(false);
    expect(r!.v.latestRunAt).toBeNull();
  });

  it('pages CRITICAL once per UTC day when the newest run is stale (> 30 min default)', async () => {
    await db.query(
      `insert into public.job_runs (job, period_key, status, started_at) values ('buy-table-tick', 'p1', 'ok', now() - interval '2 hours')`,
    );
    const [r1] = await rows<{ v: { alarmed: boolean } }>(db, `select public.buy_table_deadman_check() as v`);
    expect(r1!.v.alarmed).toBe(true);
    const [r2] = await rows<{ v: { alarmed: boolean } }>(db, `select public.buy_table_deadman_check() as v`);
    expect(r2!.v.alarmed).toBe(true); // still alarmed…
    const alerts = await rows(db, `select 1 from alerts_log where kind = 'BUY_TABLE_DEADMAN'`);
    expect(alerts.length).toBe(1); // …but the day-bucketed dedupe key pages ONCE (0092 policy)
  });

  it('pages when the last N ok-runs are ALL degraded (discovery broken while the cron looks alive)', async () => {
    for (let i = 0; i < 6; i++) {
      await db.query(
        `insert into public.job_runs (job, period_key, status, started_at, stats)
         values ('buy-table-tick', 'deg-' || $1, 'ok', now() - ($1 || ' minutes')::interval, '{"degraded": true}'::jsonb)`,
        [String(i)],
      );
    }
    const [r] = await rows<{ v: { alarmed: boolean; degradedInWindow: number } }>(
      db,
      `select public.buy_table_deadman_check() as v`,
    );
    expect(r!.v.alarmed).toBe(true);
    expect(Number(r!.v.degradedInWindow)).toBe(6);
    const alerts = await rows<{ dedupe_key: string }>(
      db,
      `select dedupe_key from alerts_log where kind = 'BUY_TABLE_DEADMAN'`,
    );
    expect(alerts.some((a) => a.dedupe_key.includes(':degraded:'))).toBe(true);
  });

  it('does NOT page on a healthy window (fresh runs, not all degraded)', async () => {
    for (let i = 0; i < 6; i++) {
      await db.query(
        `insert into public.job_runs (job, period_key, status, started_at, stats)
         values ('buy-table-tick', 'ok-' || $1, 'ok', now() - ($1 || ' minutes')::interval, '{"degraded": false}'::jsonb)`,
        [String(i)],
      );
    }
    const [r] = await rows<{ v: { alarmed: boolean } }>(db, `select public.buy_table_deadman_check() as v`);
    expect(r!.v.alarmed).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0096 dash_trading().buyTable — the BUY-TABLE lane position ledger (ANY status + outcome + totals)', () => {
  interface BuyTableRow {
    intentKey?: string;
    marketId: string;
    city: string | null;
    label: string | null;
    targetDate: string | null;
    status: string;
    outcome: string;
    sizeMatched: string | number;
    costUsd: string | number;
    resolvedPnlUsd: string | number | null;
  }
  interface BuyTablePayload {
    rows: BuyTableRow[];
    totals: {
      nRows: number; nOpen: number; nWon: number; nLost: number;
      costUsd: string | number; resolvedPnlUsd: string | number;
    };
  }

  const buyTable = async (): Promise<BuyTablePayload> => {
    const [r] = await asOperator(() =>
      rows<{ v: BuyTablePayload }>(db, `select public.dash_trading()->'buyTable' as v`),
    );
    return r!.v;
  };

  let seq = 0;
  /** Insert a buy-table live_orders row (superuser) + an optional exact fill; returns the order id. */
  async function seedEntry(opts: {
    marketId: string;
    tokenId: string;
    status: string;
    matched?: number;
    avgPrice?: number;
    feeUsd?: number;
    mode?: string;
    strategy?: string;
    createdAt?: string;
  }): Promise<string> {
    seq += 1;
    const matched = opts.matched ?? 0;
    const avg = opts.avgPrice ?? null;
    const r = await rows<{ id: string }>(
      db,
      `insert into public.live_orders
         (intent_key, client_order_id, market_id, token_id, side, purpose, order_type,
          price, size, size_matched, avg_price, trade_date, mode, status, strategy, created_at)
       values ($1, $1 || ':cid', $2, $3, 'BUY', 'entry', 'FAK',
               $4, 70, $5, $6, '2026-07-11', $7, $8, $9, coalesce($10::timestamptz, now()))
       returning id`,
      [
        `bt-${seq}`, opts.marketId, opts.tokenId, opts.avgPrice ?? 0.15, matched, avg,
        opts.mode ?? 'live', opts.status, opts.strategy ?? 'buy-table', opts.createdAt ?? null,
      ],
    );
    const id = r[0]!.id;
    if (matched > 0 && avg != null) {
      await rows(
        db,
        `insert into public.live_fills (order_id, fill_price, fill_size, fill_notional, fee_usd)
         values ($1, $2, $3, $4, $5)`,
        [id, avg, matched, avg * matched, opts.feeUsd ?? 0],
      );
    }
    return id;
  }

  /** A market_events + 2-bucket market for a city; returns the two bucket condition/token ids. */
  async function seedMarket(opts: {
    slugStem: string;
    winnerIdx?: number | null;
  }): Promise<Array<{ conditionId: string; tokenYes: string }>> {
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (
      await rows<{ city_id: string }>(
        db,
        `select city_id from public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`,
        [opts.slugStem, opts.slugStem, region],
      )
    )[0]!.city_id;
    const eventId = (
      await rows<{ id: string }>(
        db,
        `insert into public.market_events
           (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
         values ('pe-' || $1, 'ev-' || $1, $2, '2026-07-11', 'C', true, $3)
         returning id`,
        [opts.slugStem, cityId, opts.winnerIdx ?? null],
      )
    )[0]!.id;
    const out: Array<{ conditionId: string; tokenYes: string }> = [];
    for (const idx of [0, 1]) {
      const conditionId = `cond-${opts.slugStem}-${idx}`;
      const tokenYes = `tokyes-${opts.slugStem}-${idx}`;
      await rows(
        db,
        `insert into public.market_buckets
           (event_id, bucket_idx, label, condition_id, token_yes, token_no)
         values ($1, $2, $3, $4, $5, $5 || '-no')`,
        [eventId, idx, `${idx === 0 ? '33°C' : '34°C'} bucket`, conditionId, tokenYes],
      );
      out.push({ conditionId, tokenYes });
    }
    return out;
  }

  afterEach(async () => {
    await db.exec(`delete from public.live_fills`);
    await db.exec(`delete from public.live_orders`);
    await db.exec(`delete from public.market_buckets`);
    await db.exec(`delete from public.market_events`);
  });

  it('empty ledger → { rows: [], totals: zeros } — an OBJECT, never a bare array (0081 tripwire)', async () => {
    const [shape] = await asOperator(() =>
      rows<{ outer: string; rowsTyp: string; totalsTyp: string }>(
        db,
        `select jsonb_typeof(public.dash_trading()->'buyTable')           as outer,
                jsonb_typeof(public.dash_trading()->'buyTable'->'rows')   as "rowsTyp",
                jsonb_typeof(public.dash_trading()->'buyTable'->'totals') as "totalsTyp"`,
      ),
    );
    expect(shape).toEqual({ outer: 'object', rowsTyp: 'array', totalsTyp: 'object' });
    const v = await buyTable();
    expect(v.rows).toEqual([]);
    expect(Number(v.totals.nRows)).toBe(0);
    expect(Number(v.totals.nOpen)).toBe(0);
    expect(Number(v.totals.nWon)).toBe(0);
    expect(Number(v.totals.nLost)).toBe(0);
    expect(Number(v.totals.costUsd)).toBe(0);
    expect(Number(v.totals.resolvedPnlUsd)).toBe(0);
  });

  it('grades a resolved market: filled-on-winner → won (+matched−cost−fee); filled-on-loser → lost (−cost)', async () => {
    // one graded event (winner = bucket 0), our two entries on its two buckets.
    const buckets = await seedMarket({ slugStem: 'btp-graded', winnerIdx: 0 });
    // WON: 70 sh @ 0.12 ($8.40) + $0.10 fee → pnl = 70 − 8.40 − 0.10 = +61.50
    await seedEntry({
      marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes,
      status: 'filled', matched: 70, avgPrice: 0.12, feeUsd: 0.1, createdAt: '2026-07-11T10:00:00Z',
    });
    // LOST: 70 sh @ 0.10 ($7) → pnl = −7
    await seedEntry({
      marketId: buckets[1]!.conditionId, tokenId: buckets[1]!.tokenYes,
      status: 'filled', matched: 70, avgPrice: 0.1, createdAt: '2026-07-11T11:00:00Z',
    });

    const v = await buyTable();
    expect(v.rows).toHaveLength(2);
    // newest first: the LOST row (11:00) leads.
    const [lost, won] = v.rows as [BuyTableRow, BuyTableRow];
    expect(lost.outcome).toBe('lost');
    expect(Number(lost.resolvedPnlUsd)).toBeCloseTo(-7, 6);
    expect(won.outcome).toBe('won');
    expect(Number(won.resolvedPnlUsd)).toBeCloseTo(61.5, 6);
    // the best-effort market join carries city / label / target date.
    expect(won.city).toBe('btp-graded');
    expect(won.label).toBe('33°C bucket');
    expect(won.targetDate).toBe('2026-07-11');
    // totals over the enumerated rows.
    expect(Number(v.totals.nRows)).toBe(2);
    expect(Number(v.totals.nWon)).toBe(1);
    expect(Number(v.totals.nLost)).toBe(1);
    expect(Number(v.totals.nOpen)).toBe(0);
    expect(Number(v.totals.costUsd)).toBeCloseTo(8.5 + 7, 6);
    expect(Number(v.totals.resolvedPnlUsd)).toBeCloseTo(61.5 - 7, 6);
  });

  it("an unresolved market stays 'open'; a joinless market renders fail-soft with nulls (never hidden)", async () => {
    const buckets = await seedMarket({ slugStem: 'btp-open', winnerIdx: null });
    await seedEntry({
      marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes,
      status: 'filled', matched: 70, avgPrice: 0.14,
    });
    // no market_buckets row at all for this condition id — the join misses.
    await seedEntry({ marketId: 'cond-unknown', tokenId: 'tok-unknown', status: 'filled', matched: 50, avgPrice: 0.1 });

    const v = await buyTable();
    expect(v.rows).toHaveLength(2);
    const joinless = v.rows.find((r) => r.marketId === 'cond-unknown')!;
    expect(joinless.city).toBeNull();
    expect(joinless.label).toBeNull();
    expect(joinless.outcome).toBe('open'); // fail-soft: never guess a verdict without the winner join
    const open = v.rows.find((r) => r.marketId !== 'cond-unknown')!;
    expect(open.outcome).toBe('open');
    expect(open.resolvedPnlUsd).toBeNull();
    expect(Number(v.totals.nOpen)).toBe(2);
    expect(Number(v.totals.resolvedPnlUsd)).toBe(0);
  });

  it("terminal no-fill rows grade 'failed' / 'unfilled' — the ANY-status visibility the open-orders table lacks", async () => {
    await seedEntry({ marketId: 'm-f', tokenId: 't-f', status: 'failed' });
    await seedEntry({ marketId: 'm-c', tokenId: 't-c', status: 'canceled' }); // a FAK that missed
    const v = await buyTable();
    expect(v.rows.map((r) => r.outcome).sort()).toEqual(['failed', 'unfilled']);
    expect(Number(v.totals.nRows)).toBe(2);
    expect(Number(v.totals.costUsd)).toBe(0);
  });

  it('scopes to the LIVE buy-table lane: dry-run rows and other strategies never appear (the 0082 invariant)', async () => {
    await seedEntry({ marketId: 'm-dry', tokenId: 't-dry', status: 'filled', matched: 70, avgPrice: 0.1, mode: 'dry-run' });
    await seedEntry({ marketId: 'm-mx', tokenId: 't-mx', status: 'filled', matched: 70, avgPrice: 0.1, strategy: 'maker-exit' });
    const v = await buyTable();
    expect(v.rows).toEqual([]);
    expect(Number(v.totals.nRows)).toBe(0);
  });

  it('every pre-0096 dash_trading key is byte-preserved alongside buyTable', async () => {
    const [r] = await asOperator(() =>
      rows<{ keys: string[] }>(
        db,
        `select array(select jsonb_object_keys(public.dash_trading()) order by 1) as keys`,
      ),
    );
    expect(r!.keys).toEqual([
      'buyTable', 'config', 'dryRun', 'generatedAt', 'openExposureUsd',
      'openOrders', 'openPositions', 'preflight', 'recentAudit', 'today',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0109 buy-table price caps (max-only) — the operator RPCs + dash_trading().buyTable.priceConfig', () => {
  const setCityCap = (city: string, max: number | null) =>
    asOperator(() =>
      rows<{ r: { cityPriceCaps: Record<string, number> } }>(
        db,
        `select public.buy_table_city_cap_set($1, $2) as r`,
        [city, max],
      ),
    );
  const setCap = (max: number) =>
    asOperator(() =>
      rows<{ r: { priceCap: number | string } }>(db, `select public.buy_table_price_cap_set($1) as r`, [max]),
    );
  const capsConfig = async (): Promise<string | null> => {
    const r = await rows<{ value: string }>(db, `select value from config where key = 'buy_table.city_price_caps'`);
    return r[0]?.value ?? null;
  };

  beforeAll(async () => {
    // valid slug targets for the 0093-idiom validation (the shared freshDb has no seeded cities).
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    for (const slug of ['karachi', 'singapore']) {
      await rows(db, `select public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`, [slug, slug, region]);
    }
  });

  afterEach(async () => {
    await db.exec(`delete from config where key = 'buy_table.city_price_caps'`);
    await db.exec(`update config set value = '0.15' where key = 'buy_table.price_cap'`);
  });

  it('is NOT seeded — a fresh chain carries no buy_table.city_price_caps row (absent = no overrides)', async () => {
    expect(await capsConfig()).toBeNull();
  });

  it('the 0097 range surface is RETIRED — the RPC is dropped and the old config key is gone', async () => {
    const [fn] = await rows<{ oldfn: string | null }>(
      db,
      `select to_regprocedure('public.buy_table_price_range_set(text,numeric,numeric)')::text as oldfn`,
    );
    expect(fn!.oldfn).toBeNull();
    const old = await rows<{ value: string }>(
      db,
      `select value from config where key = 'buy_table.city_price_ranges'`,
    );
    expect(old.length).toBe(0);
  });

  it('sets a normalized (lower/trim) MAX override and returns the OBJECT envelope (flat map — no min anywhere)', async () => {
    const out = await setCityCap('  Karachi ', 0.3);
    expect(out[0]!.r.cityPriceCaps).toEqual({ karachi: 0.3 });
    // the stored config value round-trips as the same flat map
    expect(JSON.parse((await capsConfig())!)).toEqual({ karachi: 0.3 });
    // a second city upserts INTO the map without clobbering the first
    const out2 = await setCityCap('singapore', 0.2);
    expect(out2[0]!.r.cityPriceCaps).toEqual({ karachi: 0.3, singapore: 0.2 });
  });

  it('RAISES on an unknown slug, naming the offender verbatim (0093 idiom)', async () => {
    await expect(setCityCap('atlantis', 0.3)).rejects.toThrow(/unknown city slug: atlantis/);
    expect(await capsConfig()).toBeNull(); // the failed write stored nothing
  });

  it('RAISES outside (0, 0.99] (the cap envelope is the DB, not the route)', async () => {
    await expect(setCityCap('karachi', 0)).rejects.toThrow(/need 0 < max <= 0.99/);
    await expect(setCityCap('karachi', -0.1)).rejects.toThrow(/need 0 < max <= 0.99/);
    await expect(setCityCap('karachi', 1)).rejects.toThrow(/need 0 < max <= 0.99/);
  });

  it('a null max CLEARS the override (and clearing an absent/stale slug is a harmless no-op)', async () => {
    await setCityCap('karachi', 0.3);
    const out = await setCityCap('karachi', null);
    expect(out[0]!.r.cityPriceCaps).toEqual({});
    // clearing a slug that was never set (or no longer exists in cities) does not throw
    const out2 = await setCityCap('never-set', null);
    expect(out2[0]!.r.cityPriceCaps).toEqual({});
  });

  it('buy_table_price_cap_set writes buy_table.price_cap and RAISES outside (0, 0.99]', async () => {
    const out = await setCap(0.25);
    expect(Number(out[0]!.r.priceCap)).toBeCloseTo(0.25, 9);
    const [row] = await rows<{ value: string }>(db, `select value from config where key = 'buy_table.price_cap'`);
    expect(Number(row!.value)).toBeCloseTo(0.25, 9);
    await expect(setCap(0)).rejects.toThrow(/need 0 < max <= 0.99/);
    await expect(setCap(1)).rejects.toThrow(/need 0 < max <= 0.99/);
  });

  it('both RPCs self-guard (a non-operator authenticated caller is ERR_FORBIDDEN) and carry the 0109 grants', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.buy_table_city_cap_set('karachi', 0.3)`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.buy_table_price_cap_set(0.2)`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    const [g] = await rows<{ city_authd: boolean; city_anon: boolean; cap_authd: boolean; cap_anon: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'public.buy_table_city_cap_set(text,numeric)', 'EXECUTE') as city_authd,
              has_function_privilege('anon',          'public.buy_table_city_cap_set(text,numeric)', 'EXECUTE') as city_anon,
              has_function_privilege('authenticated', 'public.buy_table_price_cap_set(numeric)', 'EXECUTE') as cap_authd,
              has_function_privilege('anon',          'public.buy_table_price_cap_set(numeric)', 'EXECUTE') as cap_anon`,
    );
    expect(g).toEqual({ city_authd: true, city_anon: false, cap_authd: true, cap_anon: false });
  });

  it('dash_trading().buyTable carries priceConfig { globalMax, cityCaps } — defaults 0.15 / {}', async () => {
    const [keys] = await asOperator(() =>
      rows<{ keys: string[] }>(
        db,
        `select array(select jsonb_object_keys(public.dash_trading()->'buyTable') order by 1) as keys`,
      ),
    );
    // 0099 REVERTED the 0098 liveCycles key — the cycles ride their own fail-soft RPC, never dash_trading.
    expect(keys!.keys).toEqual(['priceConfig', 'rows', 'totals']);
    const [before] = await asOperator(() =>
      rows<{ v: { globalMax: number | string; cityCaps: Record<string, unknown> } }>(
        db,
        `select public.dash_trading()->'buyTable'->'priceConfig' as v`,
      ),
    );
    expect(Number(before!.v.globalMax)).toBeCloseTo(0.15, 9);
    expect(before!.v.cityCaps).toEqual({});

    await setCityCap('karachi', 0.3);
    await setCap(0.2);
    const [after] = await asOperator(() =>
      rows<{ v: { globalMax: number | string; cityCaps: Record<string, number> } }>(
        db,
        `select public.dash_trading()->'buyTable'->'priceConfig' as v`,
      ),
    );
    expect(Number(after!.v.globalMax)).toBeCloseTo(0.2, 9);
    expect(after!.v.cityCaps).toEqual({ karachi: 0.3 });
  });

  it('every pre-0097 dash_trading TOP-LEVEL key stays byte-preserved (the 0096 pin, re-asserted)', async () => {
    const [r] = await asOperator(() =>
      rows<{ keys: string[] }>(
        db,
        `select array(select jsonb_object_keys(public.dash_trading()) order by 1) as keys`,
      ),
    );
    expect(r!.keys).toEqual([
      'buyTable', 'config', 'dryRun', 'generatedAt', 'openExposureUsd',
      'openOrders', 'openPositions', 'preflight', 'recentAudit', 'today',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0099/0100 buy_table_live_cycles() — per live cycle, the trigger-fed logged lo/hi of the gate price', () => {
  /** A city + one market_events row (no buckets needed — liveCycles reads opening_captures). */
  async function seedEvent(opts: {
    slug: string;
    targetDateSql: string; // a SQL expression, e.g. `current_date + 1`
    winnerIdx?: number | null;
  }): Promise<string> {
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (
      await rows<{ city_id: string }>(
        db,
        `select city_id from public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`,
        [opts.slug, opts.slug, region],
      )
    )[0]!.city_id;
    return (
      await rows<{ id: string }>(
        db,
        `insert into public.market_events
           (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
         values ('pe-' || $1, 'ev-' || $1, $2, ${opts.targetDateSql}, 'C', true, $3)
         returning id`,
        [opts.slug, cityId, opts.winnerIdx ?? null],
      )
    )[0]!.id;
  }

  /** One opening_captures tick for an event (resolves_at as a SQL expression; buckets as a JSON value). */
  const seedTick = (evId: string, city: string, targetDateSql: string, resolvesAtSql: string, buckets: unknown, atSql = 'now()') =>
    rows(
      db,
      `insert into public.opening_captures
         (captured_at, event_id, city, target_date, tz_name, resolves_at, is_flat_open, house_seeded, buckets, neg_risk)
       values (${atSql}, $1, $2, ${targetDateSql}, 'UTC', ${resolvesAtSql}, false, true, $3::jsonb, true)`,
      [evId, city, JSON.stringify(buckets)],
    );

  const liveCycles = async (): Promise<
    Array<{ city: string; targetDate: string; minAsk: unknown; maxAsk: unknown; nTicks: unknown; firstAt: string; lastAt: string }>
  > => {
    const [r] = await asOperator(() =>
      rows<{ v: Array<{ city: string; targetDate: string; minAsk: unknown; maxAsk: unknown; nTicks: unknown; firstAt: string; lastAt: string }> }>(
        db,
        `select public.buy_table_live_cycles()->'cycles' as v`,
      ),
    );
    return r!.v;
  };

  afterEach(async () => {
    await db.exec(`delete from public.buy_table_cycle_ranges`); // the trigger-fed aggregates
    await db.exec(`delete from public.opening_captures`); // FK child first
    await db.exec(`delete from public.market_events`);
  });

  it("empty stream → { cycles: [] } — an OBJECT envelope with an ARRAY value (0081 tripwire)", async () => {
    const [shape] = await asOperator(() =>
      rows<{ outer: string; inner: string }>(
        db,
        `select jsonb_typeof(public.buy_table_live_cycles())           as outer,
                jsonb_typeof(public.buy_table_live_cycles()->'cycles') as inner`,
      ),
    );
    expect(shape).toEqual({ outer: 'object', inner: 'array' });
    expect(await liveCycles()).toEqual([]);
  });

  it('is operator-guarded (a non-operator authenticated caller is ERR_FORBIDDEN) with the dash grants', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.buy_table_live_cycles()`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    const [g] = await rows<{ anon_can: boolean; authd_can: boolean; svc_can: boolean }>(
      db,
      `select has_function_privilege('anon', 'public.buy_table_live_cycles()', 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', 'public.buy_table_live_cycles()', 'EXECUTE') as authd_can,
              has_function_privilege('service_role', 'public.buy_table_live_cycles()', 'EXECUTE') as svc_can`,
    );
    expect(g).toEqual({ anon_can: false, authd_can: true, svc_can: true });
  });

  it('the ingest trigger NEVER breaks the capture writer: a mangled-buckets insert succeeds and folds nothing', async () => {
    const ev = await seedEvent({ slug: 'lc-mangled', targetDateSql: `current_date + 1` });
    // buckets = a non-array jsonb — the fold filter skips it; the INSERT itself must succeed regardless
    // (the trigger body is exception-swallowed: aggregates are display-only, the writer feeds the live lane).
    await seedTick(ev, 'lc-mangled', `current_date + 1`, `now() + interval '20 hours'`, { oops: true });
    const [n] = await rows<{ n: number }>(db, `select count(*)::int as n from public.opening_captures`);
    expect(n!.n).toBe(1); // the write landed
    const [agg] = await rows<{ n: number }>(db, `select count(*)::int as n from public.buy_table_cycle_ranges`);
    expect(agg!.n).toBe(0); // nothing folded
  });

  it('aggregates min/max of the PICK ask over the cycle, mirroring the handler pick exactly', async () => {
    const ev = await seedEvent({ slug: 'lc-houston', targetDateSql: `current_date + 1` });
    const T = `current_date + 1`;
    const R = `now() + interval '20 hours'`;
    // tick A: pick = argmax houseProb (0.5) → execAsk 0.11; the 0.9-ask bucket has LOWER prob and must not leak in.
    await seedTick(ev, 'lc-houston', T, R, [
      { idx: 3, label: '33°C', conditionId: 'c-3', tokenYes: 't-3', houseProb: 0.5, execAsk: 0.11, bestAsk: 0.12 },
      { idx: 4, label: '34°C', conditionId: 'c-4', tokenYes: 't-4', houseProb: 0.2, execAsk: 0.9, bestAsk: 0.9 },
    ], `now() - interval '3 hours'`);
    // tick B: the pick has NO execAsk → bestAsk 0.34 fallback (the handler's exact coalesce).
    await seedTick(ev, 'lc-houston', T, R, [
      { idx: 3, label: '33°C', conditionId: 'c-3', tokenYes: 't-3', houseProb: 0.6, bestAsk: 0.34 },
    ], `now() - interval '2 hours'`);
    // tick C: the TOP-prob bucket lacks tokenYes → the pick falls to the next identity-COMPLETE bucket (0.20),
    // exactly like the handler's pick loop (identity required to be pickable at all).
    await seedTick(ev, 'lc-houston', T, R, [
      { idx: 3, label: '33°C', conditionId: 'c-3', houseProb: 0.9, execAsk: 0.5 }, // no tokenYes — unpickable
      { idx: 4, label: '34°C', conditionId: 'c-4', tokenYes: 't-4', houseProb: 0.3, execAsk: 0.2 },
    ], `now() - interval '1 hour'`);
    // tick D: unseeded (no houseProb anywhere) → contributes NOTHING (the lane could not have bought).
    await seedTick(ev, 'lc-houston', T, R, [
      { idx: 3, label: '33°C', conditionId: 'c-3', tokenYes: 't-3', execAsk: 0.01 },
    ]);
    // tick E: the pick (top prob, identity-complete) has NO usable ask → the tick drops entirely — it must
    // NOT fall through to the lower-prob bucket's 0.02 (the handler's no_ask skip, not a re-pick).
    await seedTick(ev, 'lc-houston', T, R, [
      { idx: 3, label: '33°C', conditionId: 'c-3', tokenYes: 't-3', houseProb: 0.8 },
      { idx: 4, label: '34°C', conditionId: 'c-4', tokenYes: 't-4', houseProb: 0.1, execAsk: 0.02 },
    ]);
    // tick F: hand-mangled buckets (not an array) → guarded out, never a raise.
    await seedTick(ev, 'lc-houston', T, R, { oops: true });

    const [expected] = await rows<{ d: string }>(db, `select (current_date + 1)::text as d`);
    const mine = (await liveCycles()).filter((c) => c.city === 'lc-houston');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.targetDate).toBe(expected!.d);
    expect(Number(mine[0]!.minAsk)).toBeCloseTo(0.11, 9);
    expect(Number(mine[0]!.maxAsk)).toBeCloseTo(0.34, 9);
    expect(Number(mine[0]!.nTicks)).toBe(3); // A + B + C only — D/E/F contribute nothing
    expect(mine[0]!.firstAt < mine[0]!.lastAt).toBe(true); // the coverage window spans the logged ticks
  });

  it('only CURRENTLY-LIVE cycles appear: resolved, closed, and out-of-window events are all excluded', async () => {
    const bucket = [{ idx: 0, label: '30°C', conditionId: 'c-0', tokenYes: 't-0', houseProb: 0.5, execAsk: 0.15 }];
    // resolved (winner set) — excluded even though its resolves_at is still in the future.
    const evResolved = await seedEvent({ slug: 'lc-resolved', targetDateSql: `current_date`, winnerIdx: 0 });
    await seedTick(evResolved, 'lc-resolved', `current_date`, `now() + interval '4 hours'`, bucket);
    // closed (resolves_at past) but not yet graded — no longer live, excluded.
    const evClosed = await seedEvent({ slug: 'lc-closed', targetDateSql: `current_date - 1` });
    await seedTick(evClosed, 'lc-closed', `current_date - 1`, `now() - interval '2 hours'`, bucket);
    // ancient unresolved stray — outside the target_date scan bound, excluded.
    const evOld = await seedEvent({ slug: 'lc-old', targetDateSql: `current_date - 10` });
    await seedTick(evOld, 'lc-old', `current_date - 10`, `now() + interval '1 hour'`, bucket);
    // …and one genuinely live control that MUST appear.
    const evLive = await seedEvent({ slug: 'lc-live', targetDateSql: `current_date + 2` });
    await seedTick(evLive, 'lc-live', `current_date + 2`, `now() + interval '40 hours'`, bucket);

    const cities = (await liveCycles()).map((c) => c.city);
    expect(cities).toContain('lc-live');
    expect(cities).not.toContain('lc-resolved');
    expect(cities).not.toContain('lc-closed');
    expect(cities).not.toContain('lc-old');
  });

  it('two live cycles for ONE city stay separate rows (the per-date head-columns contract)', async () => {
    const bucket = (ask: number) => [
      { idx: 0, label: '30°C', conditionId: 'c-0', tokenYes: 't-0', houseProb: 0.5, execAsk: ask },
    ];
    const evD1 = await seedEvent({ slug: 'lc-two-a', targetDateSql: `current_date + 1` });
    // (one city = one cities row; reuse the same slug's city via a second event on another date)
    const cityId = (await rows<{ city_id: string }>(db, `select id as city_id from public.cities where slug = 'lc-two-a'`))[0]!.city_id;
    const evD2 = (
      await rows<{ id: string }>(
        db,
        `insert into public.market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
         values ('pe-lc-two-b', 'ev-lc-two-b', $1, current_date + 2, 'C', true) returning id`,
        [cityId],
      )
    )[0]!.id;
    await seedTick(evD1, 'lc-two-a', `current_date + 1`, `now() + interval '20 hours'`, bucket(0.11));
    await seedTick(evD1, 'lc-two-a', `current_date + 1`, `now() + interval '20 hours'`, bucket(0.34));
    await seedTick(evD2, 'lc-two-a', `current_date + 2`, `now() + interval '44 hours'`, bucket(0.16));
    await seedTick(evD2, 'lc-two-a', `current_date + 2`, `now() + interval '44 hours'`, bucket(0.4));

    const mine = (await liveCycles()).filter((c) => c.city === 'lc-two-a');
    expect(mine).toHaveLength(2);
    expect(mine.map((c) => [Number(c.minAsk), Number(c.maxAsk), Number(c.nTicks)])).toEqual([
      [0.11, 0.34, 2],
      [0.16, 0.4, 2],
    ]); // ordered city, target_date — the operator's Houston example verbatim
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0111 buy_table_intraday_floor — the dead-bucket gate read (city+date → observed running max)', () => {
  beforeAll(async () => {
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (
      await rows<{ city_id: string }>(db, `select city_id from public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`, [
        'floorville', 'floorville', region,
      ])
    )[0]!.city_id;
    await db.exec(`insert into stations (icao, country_code, tz) values ('EFXX', 'FI', 'Europe/Helsinki')
                   on conflict (icao) do nothing`);
    await rows(
      db,
      `insert into city_stations (city_id, icao, wu_country_code, valid_from) values ($1, 'EFXX', 'FI', now() - interval '30 days')`,
      [cityId],
    );
    await db.exec(`insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs, last_obs_at)
                   values ('EFXX', '2026-07-19', 20.0, 20, 7, now())
                   on conflict (icao, date_local) do update set max_tenths_c = excluded.max_tenths_c`);
  });

  it('returns the OBJECT envelope with the observed max for matching (city, date) pairs only', async () => {
    const [r] = await asOperator(() =>
      rows<{ v: { floors: Array<{ city: string; targetDate: string; maxTenthsC: string | number }> } }>(
        db,
        `select public.buy_table_intraday_floor(array['floorville','nosuchcity'], array['2026-07-19','2026-07-20']::date[]) as v`,
      ),
    );
    expect(r!.v.floors).toHaveLength(1);
    expect(r!.v.floors[0]!.city).toBe('floorville');
    expect(r!.v.floors[0]!.targetDate).toBe('2026-07-19');
    expect(Number(r!.v.floors[0]!.maxTenthsC)).toBeCloseTo(20.0, 6);
    // no matching date → empty list, never null (the 0081 OBJECT-envelope rule)
    const [empty] = await asOperator(() =>
      rows<{ v: { floors: unknown[] } }>(
        db,
        `select public.buy_table_intraday_floor(array['floorville'], array['2026-01-01']::date[]) as v`,
      ),
    );
    expect(empty!.v.floors).toEqual([]);
  });

  it('is service_role-only (the convergence_capture_inputs grant idiom)', async () => {
    const [g] = await rows<{ authd: boolean; anon: boolean; svc: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'public.buy_table_intraday_floor(text[],date[])', 'EXECUTE') as authd,
              has_function_privilege('anon',          'public.buy_table_intraday_floor(text[],date[])', 'EXECUTE') as anon,
              has_function_privilege('service_role',  'public.buy_table_intraday_floor(text[],date[])', 'EXECUTE') as svc`,
    );
    expect(g).toEqual({ authd: false, anon: false, svc: true });
  });
});

describe('0095/0110 Slack allowlist — the lane push kinds survive the prod pause gate', () => {
  it('appends BUY_TABLE_* + the executor ORDER_* kinds without disturbing the 0092 routing', async () => {
    const [r] = await rows<{ value: string }>(db, `select value from config where key = 'alerts_slack_allow_kinds'`);
    const kinds = r!.value.split(',');
    for (const k of ['BUY_TABLE_DEADMAN', 'BUY_TABLE_DEGRADED', 'BUY_TABLE_POST_FAILED', 'ORDER_FAIL', 'ORDER_NEEDS_RECONCILE']) {
      expect(kinds, `allowlist missing ${k}`).toContain(k);
    }
    // 0110: the fill push (operator 2026-07-18 — "what was bought and at what price") is allowlisted,
    // else claim_alert suppresses it UNRECORDED (the known new-kind gotcha).
    expect(kinds).toContain('BUY_TABLE_FILLED');
    // the 0092 backbone stays intact
    expect(kinds).toContain('DAILY_DIGEST');
    expect(kinds).not.toContain('WHALE_TRADE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0113 account_funds() — the venue account snapshot read (fail-soft, OBJECT envelope)', () => {
  afterEach(async () => {
    await db.exec(`delete from public.account_snapshot`);
  });

  it('no snapshot row → all-null OBJECT with the honest note (0081 tripwire: never a bare null/array)', async () => {
    const [r] = await asOperator(() =>
      rows<{ t: string; v: { cashUsd: unknown; note: string } }>(
        db,
        `select jsonb_typeof(public.account_funds()) as t, public.account_funds() as v`,
      ),
    );
    expect(r!.t).toBe('object');
    expect(r!.v.cashUsd).toBeNull();
    expect(r!.v.note).toContain('no snapshot yet');
  });

  it('serves the single snapshot row verbatim (nulls preserved — a null cash is honest, not zero)', async () => {
    await db.exec(
      `insert into public.account_snapshot (id, cash_usd, positions_value_usd, n_positions, note)
       values (1, 18.25, 4.10, 4, null)`,
    );
    const [r] = await asOperator(() =>
      rows<{ v: { cashUsd: string | number; positionsValueUsd: string | number; nPositions: number; capturedAt: string; note: null } }>(
        db,
        `select public.account_funds() as v`,
      ),
    );
    expect(Number(r!.v.cashUsd)).toBeCloseTo(18.25, 6);
    expect(Number(r!.v.positionsValueUsd)).toBeCloseTo(4.1, 6);
    expect(Number(r!.v.nPositions)).toBe(4);
    expect(r!.v.capturedAt).toBeTruthy();
    expect(r!.v.note).toBeNull();
  });

  it('is operator-guarded with the dash grants; the cron rides 9,39 (off every contended lane)', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.account_funds()`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    const [g] = await rows<{ authd: boolean; anon: boolean; svc: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'public.account_funds()', 'EXECUTE') as authd,
              has_function_privilege('anon',          'public.account_funds()', 'EXECUTE') as anon,
              has_function_privilege('service_role',  'public.account_funds()', 'EXECUTE') as svc`,
    );
    expect(g).toEqual({ authd: true, anon: false, svc: true });
    const [c] = await rows<{ schedule: string }>(
      db,
      `select schedule from cron.job where jobname = 'account-snapshot'`,
    );
    expect(c!.schedule).toBe('9,39 * * * *');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0112 dash_trading().openPositions — held positions marked to the latest captured book', () => {
  interface OpenPosRow {
    marketId: string;
    tokenId: string | null;
    city: string | null;
    label: string | null;
    targetDate: string | null;
    shares: string | number;
    avgPrice: string | number | null;
    costUsd: string | number;
    curBid: string | number | null;
    curAsk: string | number | null;
    curMid: string | number | null;
    markAt: string | null;
    valueMidUsd: string | number | null;
    unrealizedMidUsd: string | number | null;
    unrealizedBidUsd: string | number | null;
  }
  interface OpenPosPayload {
    rows: OpenPosRow[];
    totals: {
      nPositions: number; nMarked: number;
      costUsd: string | number; valueMidUsd: string | number; valueBidUsd: string | number;
      unrealizedMidUsd: string | number; unrealizedBidUsd: string | number; oldestMarkAt: string | null;
    };
  }

  const openPositions = async (): Promise<OpenPosPayload> => {
    const [r] = await asOperator(() =>
      rows<{ v: OpenPosPayload }>(db, `select public.dash_trading()->'openPositions' as v`),
    );
    return r!.v;
  };

  let seq = 0;
  /** Insert a live_orders row (either side, superuser) + an exact fill; returns the order id. */
  async function seedOrder(opts: {
    marketId: string;
    tokenId: string;
    side?: 'BUY' | 'SELL';
    status?: string;
    matched?: number;
    avgPrice?: number;
    feeUsd?: number;
    mode?: string;
    strategy?: string;
    createdAt?: string;
  }): Promise<string> {
    seq += 1;
    const side = opts.side ?? 'BUY';
    const matched = opts.matched ?? 0;
    const avg = opts.avgPrice ?? null;
    const r = await rows<{ id: string }>(
      db,
      `insert into public.live_orders
         (intent_key, client_order_id, market_id, token_id, side, purpose, order_type,
          price, size, size_matched, avg_price, trade_date, mode, status, strategy, created_at)
       values ($1, $1 || ':cid', $2, $3, $4, $5, 'FAK',
               $6, 100, $7, $8, '2026-07-19', $9, $10, $11, coalesce($12::timestamptz, now()))
       returning id`,
      [
        `op-${seq}`, opts.marketId, opts.tokenId, side, side === 'BUY' ? 'entry' : 'take_profit',
        opts.avgPrice ?? 0.15, matched, avg, opts.mode ?? 'live', opts.status ?? 'filled',
        opts.strategy ?? 'buy-table', opts.createdAt ?? null,
      ],
    );
    const id = r[0]!.id;
    if (matched > 0 && avg != null) {
      await rows(
        db,
        `insert into public.live_fills (order_id, fill_price, fill_size, fill_notional, fee_usd)
         values ($1, $2, $3, $4, $5)`,
        [id, avg, matched, avg * matched, opts.feeUsd ?? 0],
      );
    }
    return id;
  }

  /** A market_events + 2-bucket market for a city; returns event id + the bucket condition/token ids. */
  async function seedMarket(opts: {
    slugStem: string;
    winnerIdx?: number | null;
  }): Promise<{ eventId: string; buckets: Array<{ conditionId: string; tokenYes: string }> }> {
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (
      await rows<{ city_id: string }>(
        db,
        `select city_id from public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`,
        [opts.slugStem, opts.slugStem, region],
      )
    )[0]!.city_id;
    const eventId = (
      await rows<{ id: string }>(
        db,
        `insert into public.market_events
           (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
         values ('pe-' || $1, 'ev-' || $1, $2, '2026-07-19', 'C', true, $3)
         returning id`,
        [opts.slugStem, cityId, opts.winnerIdx ?? null],
      )
    )[0]!.id;
    const buckets: Array<{ conditionId: string; tokenYes: string }> = [];
    for (const idx of [0, 1]) {
      const conditionId = `cond-${opts.slugStem}-${idx}`;
      const tokenYes = `tokyes-${opts.slugStem}-${idx}`;
      await rows(
        db,
        `insert into public.market_buckets
           (event_id, bucket_idx, label, condition_id, token_yes, token_no)
         values ($1, $2, $3, $4, $5, $5 || '-no')`,
        [eventId, idx, `${idx === 0 ? '33°C' : '34°C'} bucket`, conditionId, tokenYes],
      );
      buckets.push({ conditionId, tokenYes });
    }
    return { eventId, buckets };
  }

  /** One opening_captures tick (buckets as a JSON value; captured_at as a SQL expression). */
  const seedCapture = (evId: string, city: string, buckets: unknown, atSql = 'now()') =>
    rows(
      db,
      `insert into public.opening_captures
         (captured_at, event_id, city, target_date, tz_name, resolves_at, is_flat_open, house_seeded, buckets, neg_risk)
       values (${atSql}, $1, $2, '2026-07-19', 'UTC', '2026-07-19T12:00:00Z', false, true, $3::jsonb, true)`,
      [evId, city, JSON.stringify(buckets)],
    );

  afterEach(async () => {
    await db.exec(`delete from public.live_fills`);
    await db.exec(`delete from public.live_orders`);
    await db.exec(`delete from public.buy_table_cycle_ranges`); // the 0100 trigger-fed aggregates
    await db.exec(`delete from public.opening_captures`);
    await db.exec(`delete from public.market_buckets`);
    await db.exec(`delete from public.market_events`);
  });

  it('empty ledger → { rows: [], totals: zeros } — an OBJECT, never a bare array (0081 tripwire)', async () => {
    const [shape] = await asOperator(() =>
      rows<{ outer: string; rowsTyp: string; totalsTyp: string }>(
        db,
        `select jsonb_typeof(public.dash_trading()->'openPositions')           as outer,
                jsonb_typeof(public.dash_trading()->'openPositions'->'rows')   as "rowsTyp",
                jsonb_typeof(public.dash_trading()->'openPositions'->'totals') as "totalsTyp"`,
      ),
    );
    expect(shape).toEqual({ outer: 'object', rowsTyp: 'array', totalsTyp: 'object' });
    const v = await openPositions();
    expect(v.rows).toEqual([]);
    expect(Number(v.totals.nPositions)).toBe(0);
    expect(Number(v.totals.nMarked)).toBe(0);
    expect(Number(v.totals.costUsd)).toBe(0);
    expect(Number(v.totals.unrealizedMidUsd)).toBe(0);
  });

  it('marks held positions to the LATEST capture — tokenYes match preferred, idx fallback; unrealized math exact', async () => {
    const { eventId, buckets } = await seedMarket({ slugStem: 'op-live', winnerIdx: null });
    // A: 70 sh @ 0.12 + $0.10 fee → cost 8.50 (bucket 0, matched by tokenYes)
    await seedOrder({
      marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes,
      matched: 70, avgPrice: 0.12, feeUsd: 0.1, createdAt: '2026-07-19T02:00:00Z',
    });
    // B: 50 sh @ 0.10 → cost 5.00 (bucket 1; its capture element has NO tokenYes → idx fallback)
    await seedOrder({
      marketId: buckets[1]!.conditionId, tokenId: buckets[1]!.tokenYes,
      matched: 50, avgPrice: 0.1, createdAt: '2026-07-19T03:00:00Z',
    });
    // an OLDER capture whose prices must NOT be used…
    await seedCapture(eventId, 'op-live', [
      { idx: 0, tokenYes: buckets[0]!.tokenYes, bestBid: 0.01, bestAsk: 0.02, mid: 0.015 },
      { idx: 1, bestBid: 0.01, bestAsk: 0.02, mid: 0.015 },
    ], `now() - interval '2 hours'`);
    // …and the NEWEST capture that must be the mark.
    await seedCapture(eventId, 'op-live', [
      { idx: 0, tokenYes: buckets[0]!.tokenYes, bestBid: 0.30, bestAsk: 0.34, mid: 0.32 },
      { idx: 1, bestBid: 0.05, bestAsk: 0.07, mid: 0.06 },
    ]);

    const v = await openPositions();
    expect(v.rows).toHaveLength(2);
    // newest first buy first: B (03:00) leads.
    const [b, a] = v.rows as [OpenPosRow, OpenPosRow];
    expect(a.city).toBe('op-live');
    expect(a.label).toBe('33°C bucket');
    expect(a.targetDate).toBe('2026-07-19');
    expect(Number(a.shares)).toBeCloseTo(70, 6);
    expect(Number(a.avgPrice)).toBeCloseTo(0.12, 6);
    expect(Number(a.costUsd)).toBeCloseTo(8.5, 6);
    expect(Number(a.curBid)).toBeCloseTo(0.3, 6);
    expect(Number(a.curMid)).toBeCloseTo(0.32, 6);
    expect(Number(a.valueMidUsd)).toBeCloseTo(70 * 0.32, 6);          // 22.40
    expect(Number(a.unrealizedMidUsd)).toBeCloseTo(22.4 - 8.5, 6);    // +13.90
    expect(Number(a.unrealizedBidUsd)).toBeCloseTo(21 - 8.5, 6);      // +12.50
    expect(b.label).toBe('34°C bucket');
    expect(Number(b.curMid)).toBeCloseTo(0.06, 6);                    // idx-fallback element
    expect(Number(b.unrealizedMidUsd)).toBeCloseTo(50 * 0.06 - 5, 6); // −2.00
    expect(Number(b.unrealizedBidUsd)).toBeCloseTo(50 * 0.05 - 5, 6); // −2.50
    // totals over both rows
    expect(Number(v.totals.nPositions)).toBe(2);
    expect(Number(v.totals.nMarked)).toBe(2);
    expect(Number(v.totals.costUsd)).toBeCloseTo(13.5, 6);
    expect(Number(v.totals.valueMidUsd)).toBeCloseTo(22.4 + 3, 6);
    expect(Number(v.totals.valueBidUsd)).toBeCloseTo(21 + 2.5, 6);
    expect(Number(v.totals.unrealizedMidUsd)).toBeCloseTo(13.9 - 2, 6);
    expect(Number(v.totals.unrealizedBidUsd)).toBeCloseTo(12.5 - 2.5, 6);
    expect(v.totals.oldestMarkAt).not.toBeNull();
  });

  it('nets sells at lifetime-average and keeps only the residual held shares', async () => {
    const { buckets } = await seedMarket({ slugStem: 'op-net', winnerIdx: null });
    // BUY 100 @ 0.20 ($20), then SELL 40 @ 0.30 → held 60 sh, cost 20 × (1 − 0.4) = $12.
    await seedOrder({ marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes, matched: 100, avgPrice: 0.2 });
    await seedOrder({ marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes, side: 'SELL', matched: 40, avgPrice: 0.3 });

    const v = await openPositions();
    expect(v.rows).toHaveLength(1);
    expect(Number(v.rows[0]!.shares)).toBeCloseTo(60, 6);
    expect(Number(v.rows[0]!.avgPrice)).toBeCloseTo(0.2, 6);
    expect(Number(v.rows[0]!.costUsd)).toBeCloseTo(12, 6);
    // fully-sold position disappears
    await seedOrder({ marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes, side: 'SELL', matched: 60, avgPrice: 0.35 });
    const v2 = await openPositions();
    expect(v2.rows).toEqual([]);
  });

  it('a ONE-SIDED book marks honestly: missing bid → bid-mark $0 (executable truth), mid → visible-side midpoint', async () => {
    const { eventId, buckets } = await seedMarket({ slugStem: 'op-oneside', winnerIdx: null });
    // A: a dead bucket — 5000 sh @ 0.001 ($5), the book has NO bid and a $0.001 ask (the 07-19 live shape).
    await seedOrder({ marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes, matched: 5000, avgPrice: 0.001, createdAt: '2026-07-19T02:00:00Z' });
    // B: a bid-only book — 10 sh @ 0.30 ($3), bid 0.4 and no ask.
    await seedOrder({ marketId: buckets[1]!.conditionId, tokenId: buckets[1]!.tokenYes, matched: 10, avgPrice: 0.3, createdAt: '2026-07-19T03:00:00Z' });
    await seedCapture(eventId, 'op-oneside', [
      { idx: 0, tokenYes: buckets[0]!.tokenYes, bestAsk: 0.001 }, // no bestBid, no mid
      { idx: 1, tokenYes: buckets[1]!.tokenYes, bestBid: 0.4 },   // no bestAsk, no mid
    ]);

    const v = await openPositions();
    expect(v.rows).toHaveLength(2);
    const [bidOnly, dead] = v.rows as [OpenPosRow, OpenPosRow]; // newest first buy first
    // the dead bucket: curBid null (that side IS empty) but the verdict is not hidden —
    expect(dead.curBid).toBeNull();
    expect(Number(dead.curAsk)).toBeCloseTo(0.001, 9);
    expect(Number(dead.curMid)).toBeCloseTo(0.0005, 9);                     // (0 + ask)/2
    expect(Number(dead.unrealizedMidUsd)).toBeCloseTo(5000 * 0.0005 - 5, 6); // −2.50
    expect(Number(dead.unrealizedBidUsd)).toBeCloseTo(-5, 6);               // nothing to sell into → −cost
    // the bid-only bucket: mid falls back to the bid itself
    expect(Number(bidOnly.curMid)).toBeCloseTo(0.4, 9);
    expect(Number(bidOnly.unrealizedBidUsd)).toBeCloseTo(10 * 0.4 - 3, 6);  // +1.00
    // BOTH count as marked — null marks are reserved for "no capture element at all"
    expect(Number(v.totals.nMarked)).toBe(2);
    expect(Number(v.totals.unrealizedBidUsd)).toBeCloseTo(-5 + 1, 6);
  });

  it('excludes resolved markets (they are the buyTable won/lost rows), dry-run rows, and zero-matched rows', async () => {
    const resolved = await seedMarket({ slugStem: 'op-res', winnerIdx: 0 });
    await seedOrder({ marketId: resolved.buckets[0]!.conditionId, tokenId: resolved.buckets[0]!.tokenYes, matched: 70, avgPrice: 0.12 });
    await seedOrder({ marketId: 'm-dry', tokenId: 't-dry', matched: 70, avgPrice: 0.1, mode: 'dry-run' });
    await seedOrder({ marketId: 'm-none', tokenId: 't-none', status: 'canceled', matched: 0 });

    const v = await openPositions();
    // the dry-run/zero rows are excluded by mode/matched; the resolved market by its known winner.
    expect(v.rows.map((r) => r.marketId)).toEqual([]);
    expect(Number(v.totals.nPositions)).toBe(0);
  });

  it('a held position with NO capture (or no market join) renders fail-soft with null marks — never hidden', async () => {
    const { buckets } = await seedMarket({ slugStem: 'op-nomark', winnerIdx: null });
    await seedOrder({ marketId: buckets[0]!.conditionId, tokenId: buckets[0]!.tokenYes, matched: 70, avgPrice: 0.14 });
    // a joinless market too — no market_buckets row at all (winner unknowable → fail-soft open)
    await seedOrder({ marketId: 'cond-unknown', tokenId: 'tok-unknown', matched: 50, avgPrice: 0.1, strategy: 'city-taker' });

    const v = await openPositions();
    expect(v.rows).toHaveLength(2);
    const joined = v.rows.find((r) => r.marketId !== 'cond-unknown')!;
    expect(joined.label).toBe('33°C bucket');
    expect(joined.curMid).toBeNull();
    expect(joined.markAt).toBeNull();
    expect(joined.valueMidUsd).toBeNull();
    expect(joined.unrealizedMidUsd).toBeNull();
    const joinless = v.rows.find((r) => r.marketId === 'cond-unknown')!;
    expect(joinless.city).toBeNull();
    expect(joinless.label).toBeNull();
    expect(Number(joinless.costUsd)).toBeCloseTo(5, 6);
    // totals: positions counted, none marked, unrealized sums stay 0 (marked rows only — honest, not fabricated)
    expect(Number(v.totals.nPositions)).toBe(2);
    expect(Number(v.totals.nMarked)).toBe(0);
    expect(Number(v.totals.costUsd)).toBeCloseTo(9.8 + 5, 6);
    expect(Number(v.totals.unrealizedMidUsd)).toBe(0);
    expect(v.totals.oldestMarkAt).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("0114 buy_table_tick_inputs — the tick's slim discovery read (latest capture per event)", () => {
  async function seedEvent(slug: string, winnerIdx: number | null = null): Promise<string> {
    const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
    const cityId = (
      await rows<{ city_id: string }>(
        db,
        `select city_id from public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`,
        [slug, slug, region],
      )
    )[0]!.city_id;
    return (
      await rows<{ id: string }>(
        db,
        `insert into public.market_events
           (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
         values ('pe-' || $1, 'ev-' || $1, $2, current_date + 1, 'C', true, $3)
         returning id`,
        [slug, cityId, winnerIdx],
      )
    )[0]!.id;
  }

  const bucket = (slug: string, idx: number, execAsk: number) => ({
    idx,
    label: `${29 + idx}°C`,
    bestAsk: execAsk,
    execAsk,
    execBid: null,
    bestBid: null,
    depthUsd: 100,
    houseProb: idx === 1 ? 0.6 : 0.2,
    conditionId: `c-${slug}-${idx}`,
    tokenYes: `y-${slug}-${idx}`,
    tokenNo: `n-${slug}-${idx}`,
  });

  /** One capture tick; hoursSinceListing defaults INSIDE the fresh gate (< 1). */
  const seedTick = (
    evId: string,
    slug: string,
    execAsk: number,
    opts?: { atSql?: string; hoursSinceListing?: number },
  ) =>
    rows(
      db,
      `insert into public.opening_captures
         (captured_at, event_id, city, target_date, tz_name, resolves_at, hours_since_listing,
          is_flat_open, house_seeded, buckets, neg_risk)
       values (${opts?.atSql ?? 'now()'}, $1, $2, current_date + 1, 'UTC', now() + interval '6 hours', $3,
               false, true, $4::jsonb, true)`,
      [
        evId,
        slug,
        opts?.hoursSinceListing ?? 0.5,
        JSON.stringify([bucket(slug, 0, 0.05), bucket(slug, 1, execAsk), bucket(slug, 2, 0.05)]),
      ],
    );

  type SlimEnv = {
    captures: Array<{ eventId: string; city: string; buckets: Array<Record<string, unknown>> }>;
    resolutions: Array<{ id: string; winnerIdx: number | null; gradingMismatch: boolean }>;
  };
  const slim = async (cities: string[]): Promise<SlimEnv> =>
    (
      await rows<{ v: SlimEnv }>(db, `select public.buy_table_tick_inputs($1::text[]) as v`, [cities])
    )[0]!.v;

  afterEach(async () => {
    await db.exec(`delete from public.buy_table_cycle_ranges`);
    await db.exec(`delete from public.opening_captures`);
    await db.exec(`delete from public.market_events`);
  });

  it('returns an OBJECT envelope with captures/resolutions ARRAYS on an empty stream (0081 tripwire)', async () => {
    const [shape] = await rows<{ outer: string; caps: string; res: string }>(
      db,
      `select jsonb_typeof(public.buy_table_tick_inputs(array['nowhere']))                as outer,
              jsonb_typeof(public.buy_table_tick_inputs(array['nowhere'])->'captures')    as caps,
              jsonb_typeof(public.buy_table_tick_inputs(array['nowhere'])->'resolutions') as res`,
    );
    expect(shape).toEqual({ outer: 'object', caps: 'array', res: 'array' });
  });

  it('returns ONLY the latest capture per event, buckets ordered by idx with the 0083 identity keys', async () => {
    const ev = await seedEvent('slim-a');
    await seedTick(ev, 'slim-a', 0.10, { atSql: `now() - interval '2 hours'`, hoursSinceListing: 0.5 });
    await seedTick(ev, 'slim-a', 0.20, { atSql: `now() - interval '1 hour'`, hoursSinceListing: 1.5 });
    await seedTick(ev, 'slim-a', 0.30, { atSql: 'now()', hoursSinceListing: 2.5 });
    const v = await slim(['slim-a']);
    expect(v.captures).toHaveLength(1); // the 2-day grid is GONE — one row per event
    const caps = v.captures[0]!;
    expect(caps.eventId).toBe(ev);
    expect(caps.buckets.map((b) => b['idx'])).toEqual([0, 1, 2]);
    const pick = caps.buckets[1]!;
    expect(pick['execAsk']).toBe(0.3); // the LATEST tick's ask, not the first
    expect(pick['conditionId']).toBe('c-slim-a-1');
    expect(pick['tokenYes']).toBe('y-slim-a-1');
    expect(pick['tokenNo']).toBe('n-slim-a-1');
  });

  it('has NO fresh-listing gate: an event whose young rows aged out of the lookback is STILL visible', async () => {
    // The convergence read's fresh CTE (min(hours_since_listing) < 1 within p_days) blinded the lane to any
    // market listed ≳2.4 days before its close for the ENTIRE [2,12]h buy window (measured live 2026-07-20:
    // the 07-20 events' first-hour rows sat outside the 2-day lookback while the market was 6h from close).
    // The slim read deliberately drops it — the tick's own gates bound what it can act on.
    const ev = await seedEvent('slim-old', 2);
    await seedTick(ev, 'slim-old', 0.1, { hoursSinceListing: 50 }); // captured LONG after listing → still in
    const v = await slim(['slim-old']);
    expect(v.captures).toHaveLength(1);
    expect(v.resolutions).toEqual([{ id: ev, winnerIdx: 2, gradingMismatch: false }]);
  });

  it('scopes by p_cities and carries resolutions (winnerIdx) for the loss sweep', async () => {
    const evA = await seedEvent('slim-b', 2);
    const evB = await seedEvent('slim-c');
    await seedTick(evA, 'slim-b', 0.1);
    await seedTick(evB, 'slim-c', 0.1);
    const v = await slim(['slim-b']);
    expect(v.captures.map((c) => c.city)).toEqual(['slim-b']);
    expect(v.resolutions).toEqual([{ id: evA, winnerIdx: 2, gradingMismatch: false }]);
  });

  it('is service_role-only (the tick is the sole caller — no operator/anon surface)', async () => {
    const [g] = await rows<{ anon_can: boolean; authd_can: boolean; svc_can: boolean }>(
      db,
      `select has_function_privilege('anon', 'public.buy_table_tick_inputs(text[], integer)', 'EXECUTE') as anon_can,
              has_function_privilege('authenticated', 'public.buy_table_tick_inputs(text[], integer)', 'EXECUTE') as authd_can,
              has_function_privilege('service_role', 'public.buy_table_tick_inputs(text[], integer)', 'EXECUTE') as svc_can`,
    );
    expect(g).toEqual({ anon_can: false, authd_can: false, svc_can: true });
  });
});
