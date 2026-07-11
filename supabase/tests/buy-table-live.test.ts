/**
 * BUY-TABLE live lane (migration 0095) — the config defaults, the ANY-status lane ledger read, the
 * strategy-aware trade_live_preflight('buy-table') branch, the crons (the §8.1 body-periodKey stamp),
 * the day-bucketed deadman, and the Slack push-kind allowlist. Exercised in PGlite (the
 * trade-config/city-live test idiom). The handler itself is unit-tested in buy-table-tick-handler.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from './harness.ts';

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db?.close();
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('0095 config defaults', () => {
  it('seeds buy_table.price_cap 0.15 / lead 2–12h / tick_enabled true', async () => {
    const cfg = await rows<{ key: string; value: string }>(
      db,
      `select key, value from config where key like 'buy_table.%' order by key`,
    );
    expect(Object.fromEntries(cfg.map((r) => [r.key, r.value]))).toEqual({
      'buy_table.price_cap': '0.15',
      'buy_table.lead_max_h': '12',
      'buy_table.lead_min_h': '2',
      'buy_table.tick_enabled': 'true',
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
    expect(j!.command).toContain('timeout_milliseconds := 4500');
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
