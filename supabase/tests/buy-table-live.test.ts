/**
 * BUY-TABLE live lane (migration 0095) — the config defaults, the ANY-status lane ledger read, the
 * strategy-aware trade_live_preflight('buy-table') branch, the crons (the §8.1 body-periodKey stamp),
 * the day-bucketed deadman, and the Slack push-kind allowlist. Exercised in PGlite (the
 * trade-config/city-live test idiom). The handler itself is unit-tested in buy-table-tick-handler.test.ts.
 *
 * + migration 0096: dash_trading().buyTable — the lane position ledger (ANY-status rows joined to their
 * market identity + graded won/lost/open/unfilled/failed against the market_events winner, with totals).
 *
 * + migration 0097: the per-city PRICE RANGES — buy_table_price_range_set (0093 slug-validation idiom;
 * null+null clears; 0 ≤ min < max ≤ 0.99) / buy_table_price_cap_set (0 < max ≤ 0.99) and
 * dash_trading().buyTable.priceConfig { globalMax, cityRanges }.
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
describe('0095 crons — the */10 edge tick with the §8.1 body periodKey + the pure-SQL deadman', () => {
  it('buy-table-tick is registered */10 with vault secrets AND a fire-time body periodKey', async () => {
    const [j] = await rows<{ schedule: string; command: string }>(
      db,
      `select schedule, command from cron.job where jobname = 'buy-table-tick'`,
    );
    expect(j).toBeTruthy();
    expect(j!.schedule).toBe('*/10 * * * *');
    expect(j!.command).toContain(`vault.decrypted_secrets where name = 'project_url'`);
    expect(j!.command).toContain(`vault.decrypted_secrets where name = 'cron_secret'`);
    expect(j!.command).toContain('/functions/v1/buy-table-tick');
    // §8.1 — the periodKey is stamped into the BODY at fire time (now() evaluates per fire).
    expect(j!.command).toContain(`body := jsonb_build_object('periodKey', 'buy-table-tick:' || to_char(now()`);
    // 4cb1e77: 10s (the generic 4500 was shorter than a cold Edge boot — the launch-day fix).
    expect(j!.command).toContain('timeout_milliseconds := 10000');
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
      'openOrders', 'preflight', 'recentAudit', 'today',
    ]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0097 buy-table price ranges — the operator RPCs + dash_trading().buyTable.priceConfig', () => {
  const setRange = (city: string, min: number | null, max: number | null) =>
    asOperator(() =>
      rows<{ r: { cityPriceRanges: Record<string, { min: number; max: number }> } }>(
        db,
        `select public.buy_table_price_range_set($1, $2, $3) as r`,
        [city, min, max],
      ),
    );
  const setCap = (max: number) =>
    asOperator(() =>
      rows<{ r: { priceCap: number | string } }>(db, `select public.buy_table_price_cap_set($1) as r`, [max]),
    );
  const rangesConfig = async (): Promise<string | null> => {
    const r = await rows<{ value: string }>(db, `select value from config where key = 'buy_table.city_price_ranges'`);
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
    await db.exec(`delete from config where key = 'buy_table.city_price_ranges'`);
    await db.exec(`update config set value = '0.15' where key = 'buy_table.price_cap'`);
  });

  it('is NOT seeded — a fresh chain carries no buy_table.city_price_ranges row (absent = no overrides)', async () => {
    expect(await rangesConfig()).toBeNull();
  });

  it('sets a normalized (lower/trim) override and returns the OBJECT envelope', async () => {
    const out = await setRange('  Karachi ', 0.05, 0.3);
    expect(out[0]!.r.cityPriceRanges).toEqual({ karachi: { min: 0.05, max: 0.3 } });
    // the stored config value round-trips as the same map
    expect(JSON.parse((await rangesConfig())!)).toEqual({ karachi: { min: 0.05, max: 0.3 } });
    // a second city upserts INTO the map without clobbering the first
    const out2 = await setRange('singapore', 0.1, 0.2);
    expect(out2[0]!.r.cityPriceRanges).toEqual({
      karachi: { min: 0.05, max: 0.3 },
      singapore: { min: 0.1, max: 0.2 },
    });
  });

  it('RAISES on an unknown slug, naming the offender verbatim (0093 idiom)', async () => {
    await expect(setRange('atlantis', 0.05, 0.3)).rejects.toThrow(/unknown city slug: atlantis/);
    expect(await rangesConfig()).toBeNull(); // the failed write stored nothing
  });

  it('RAISES on min ≥ max, min < 0, and max > 0.99 (the range envelope is the DB, not the route)', async () => {
    await expect(setRange('karachi', 0.3, 0.3)).rejects.toThrow(/need 0 <= min < max <= 0.99/);
    await expect(setRange('karachi', 0.4, 0.2)).rejects.toThrow(/need 0 <= min < max <= 0.99/);
    await expect(setRange('karachi', -0.1, 0.2)).rejects.toThrow(/need 0 <= min < max <= 0.99/);
    await expect(setRange('karachi', 0.1, 1)).rejects.toThrow(/need 0 <= min < max <= 0.99/);
  });

  it('RAISES on a half-set range (one bound null) — never guessed', async () => {
    await expect(setRange('karachi', 0.1, null)).rejects.toThrow(/BOTH null .* or BOTH set/);
  });

  it('null+null CLEARS the override (and clearing an absent/stale slug is a harmless no-op)', async () => {
    await setRange('karachi', 0.05, 0.3);
    const out = await setRange('karachi', null, null);
    expect(out[0]!.r.cityPriceRanges).toEqual({});
    // clearing a slug that was never set (or no longer exists in cities) does not throw
    const out2 = await setRange('never-set', null, null);
    expect(out2[0]!.r.cityPriceRanges).toEqual({});
  });

  it('buy_table_price_cap_set writes buy_table.price_cap and RAISES outside (0, 0.99]', async () => {
    const out = await setCap(0.25);
    expect(Number(out[0]!.r.priceCap)).toBeCloseTo(0.25, 9);
    const [row] = await rows<{ value: string }>(db, `select value from config where key = 'buy_table.price_cap'`);
    expect(Number(row!.value)).toBeCloseTo(0.25, 9);
    await expect(setCap(0)).rejects.toThrow(/need 0 < max <= 0.99/);
    await expect(setCap(1)).rejects.toThrow(/need 0 < max <= 0.99/);
  });

  it('both RPCs self-guard (a non-operator authenticated caller is ERR_FORBIDDEN) and carry the 0097 grants', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.buy_table_price_range_set('karachi', 0.05, 0.3)`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () =>
        rows(db, `select public.buy_table_price_cap_set(0.2)`),
      ),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
    const [g] = await rows<{ range_authd: boolean; range_anon: boolean; cap_authd: boolean; cap_anon: boolean }>(
      db,
      `select has_function_privilege('authenticated', 'public.buy_table_price_range_set(text,numeric,numeric)', 'EXECUTE') as range_authd,
              has_function_privilege('anon',          'public.buy_table_price_range_set(text,numeric,numeric)', 'EXECUTE') as range_anon,
              has_function_privilege('authenticated', 'public.buy_table_price_cap_set(numeric)', 'EXECUTE') as cap_authd,
              has_function_privilege('anon',          'public.buy_table_price_cap_set(numeric)', 'EXECUTE') as cap_anon`,
    );
    expect(g).toEqual({ range_authd: true, range_anon: false, cap_authd: true, cap_anon: false });
  });

  it('dash_trading().buyTable gains priceConfig { globalMax, cityRanges } — defaults 0.15 / {}', async () => {
    const [keys] = await asOperator(() =>
      rows<{ keys: string[] }>(
        db,
        `select array(select jsonb_object_keys(public.dash_trading()->'buyTable') order by 1) as keys`,
      ),
    );
    // 0099 REVERTED the 0098 liveCycles key — the cycles ride their own fail-soft RPC, never dash_trading.
    expect(keys!.keys).toEqual(['priceConfig', 'rows', 'totals']);
    const [before] = await asOperator(() =>
      rows<{ v: { globalMax: number | string; cityRanges: Record<string, unknown> } }>(
        db,
        `select public.dash_trading()->'buyTable'->'priceConfig' as v`,
      ),
    );
    expect(Number(before!.v.globalMax)).toBeCloseTo(0.15, 9);
    expect(before!.v.cityRanges).toEqual({});

    await setRange('karachi', 0.05, 0.3);
    await setCap(0.2);
    const [after] = await asOperator(() =>
      rows<{ v: { globalMax: number | string; cityRanges: Record<string, { min: number; max: number }> } }>(
        db,
        `select public.dash_trading()->'buyTable'->'priceConfig' as v`,
      ),
    );
    expect(Number(after!.v.globalMax)).toBeCloseTo(0.2, 9);
    expect(after!.v.cityRanges).toEqual({ karachi: { min: 0.05, max: 0.3 } });
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
      'openOrders', 'preflight', 'recentAudit', 'today',
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
describe('0095 Slack allowlist — the lane push kinds survive the prod pause gate', () => {
  it('appends BUY_TABLE_* + the executor ORDER_* kinds without disturbing the 0092 routing', async () => {
    const [r] = await rows<{ value: string }>(db, `select value from config where key = 'alerts_slack_allow_kinds'`);
    const kinds = r!.value.split(',');
    for (const k of ['BUY_TABLE_DEADMAN', 'BUY_TABLE_DEGRADED', 'BUY_TABLE_POST_FAILED', 'ORDER_FAIL', 'ORDER_NEEDS_RECONCILE']) {
      expect(kinds, `allowlist missing ${k}`).toContain(k);
    }
    // the 0092 backbone stays intact
    expect(kinds).toContain('DAILY_DIGEST');
    expect(kinds).not.toContain('WHALE_TRADE');
  });
});
