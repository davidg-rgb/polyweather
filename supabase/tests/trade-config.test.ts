/**
 * 0082 trading-activation + risk-console twin tests (STAGED DARK — the migration is written, never applied to a
 * live DB; this exercises it in PGlite). Covers: the single-row trade_config surface + seed, the §9R $25 CHECK
 * ceiling, the append-only audit trigger, every RPC's OBJECT-envelope shape (0081 tripwire), the live-mode
 * INTERLOCK across all branches (no-PASS blocks / forward-PASS passes / override passes / backtest-PASS does NOT
 * pass / expired active_until blocks / stake>cap blocks), dash_trading, and the packages/trading TS reader.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { loadTradeConfig, preflightLive, STAKE_CEILING_USD } from '../../packages/trading/src/index.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

/** Call an operator-guarded RPC as the single allow-listed operator (service_role + the email claim). */
const asOperator = <T>(fn: () => Promise<T>) => asRole(db, 'service_role', OPERATOR, fn);

/** Restore the singleton to a known baseline (mode off, defaults, run window + allowlist cleared). */
async function resetCfg(): Promise<void> {
  await asOperator(() =>
    rows(
      db,
      `select public.trade_config_set(
         p_mode := 'off', p_stake_per_buy_usd := 10, p_per_position_cap_usd := 25,
         p_per_market_cap_usd := 40, p_total_concurrent_cap_usd := 100,
         p_daily_loss_kill_usd := 30, p_daily_loss_kill_frac := 0.25,
         p_clear_city_allowlist := true, p_clear_active_until := true)`,
    ),
  );
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});
afterAll(async () => {
  await db.close();
});

describe('0082 schema — single-row trade_config, ledger, RLS', () => {
  it('creates all five tables with RLS enabled', async () => {
    const found = await rows<{ relname: string; rls: boolean }>(
      db,
      `select c.relname, c.relrowsecurity as rls
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and c.relname in ('trade_config','trade_config_audit','trade_gate_override','live_orders','live_fills')
       order by c.relname`,
    );
    expect(found.map((r) => r.relname)).toEqual([
      'live_fills', 'live_orders', 'trade_config', 'trade_config_audit', 'trade_gate_override',
    ]);
    for (const r of found) expect(r.rls, `${r.relname} needs RLS`).toBe(true);
  });

  it('seeds exactly one config row, mode DARK (off) with the spec defaults', async () => {
    const [c] = await rows<Record<string, string>>(db, `select * from public.trade_config`);
    expect(c!.id).toBe(1);
    expect(c!.mode).toBe('off');
    expect(Number(c!.stake_per_buy_usd)).toBe(10);
    expect(Number(c!.per_position_cap_usd)).toBe(25);
    expect(Number(c!.per_market_cap_usd)).toBe(40);
    expect(Number(c!.total_concurrent_cap_usd)).toBe(100);
    expect(Number(c!.daily_loss_kill_usd)).toBe(30);
    expect(Number(c!.daily_loss_kill_frac)).toBe(0.25);
    expect(c!.city_allowlist).toBeNull();
    expect(c!.active_until).toBeNull();
    const cnt = await rows<{ n: number }>(db, `select count(*)::int as n from public.trade_config`);
    expect(cnt[0]!.n).toBe(1);
  });

  it('the singleton guard rejects a second row', async () => {
    await expect(
      asRole(db, 'service_role', null, () => rows(db, `insert into public.trade_config (id) values (2)`)),
    ).rejects.toThrow();
  });

  it('live_orders.intent_key is UNIQUE (the idempotency backstop)', async () => {
    const idx = await rows(
      db,
      `select 1 from pg_indexes where schemaname='public' and tablename='live_orders'
         and indexdef like '%UNIQUE%' and indexdef like '%intent_key%'`,
    );
    expect(idx.length).toBe(1);
  });
});

describe('0082 §9R CHECK ceiling — the $25 stake/position cap is code, not config', () => {
  afterEach(resetCfg);

  it('mirrors the DB ceiling in code (STAKE_CEILING_USD = 25)', () => {
    expect(STAKE_CEILING_USD).toBe(25);
  });

  it('rejects stake_per_buy_usd > 25', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_config_set(p_stake_per_buy_usd := 30)`)),
    ).rejects.toThrow(/trade_config_ceiling|check/i);
  });

  it('rejects per_position_cap_usd > 25', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_config_set(p_per_position_cap_usd := 26)`)),
    ).rejects.toThrow(/trade_config_ceiling|check/i);
  });

  it('rejects daily_loss_kill_frac > 1', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_frac := 1.5)`)),
    ).rejects.toThrow(/trade_config_frac|check/i);
  });

  it('rejects a non-positive stake', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_config_set(p_stake_per_buy_usd := 0)`)),
    ).rejects.toThrow(/trade_config_positive|check/i);
  });

  it('accepts stake at the ceiling ($25)', async () => {
    await asOperator(() => rows(db, `select public.trade_config_set(p_stake_per_buy_usd := 25)`));
    const [c] = await rows<{ stake_per_buy_usd: string }>(db, `select stake_per_buy_usd from public.trade_config`);
    expect(Number(c!.stake_per_buy_usd)).toBe(25);
  });
});

describe('0082 audit trigger — append-only whole-config old/new jsonb', () => {
  afterEach(resetCfg);

  it('the seed INSERT wrote one audit row (old null, new the row, changed_by set)', async () => {
    // Assert the shape of the seed row (id=1 INSERT) — the earliest audit entry.
    const [seed] = await rows<{ old_value: unknown; new_value: { mode: string }; changed_by: string }>(
      db,
      `select old_value, new_value, changed_by from public.trade_config_audit order by changed_at asc, id asc limit 1`,
    );
    expect(seed!.old_value).toBeNull();
    expect(seed!.new_value.mode).toBe('off');
    expect(seed!.changed_by).toBeTruthy();
  });

  it('every trade_config_set appends an audit row capturing old→new', async () => {
    const before = await rows<{ n: number }>(db, `select count(*)::int n from public.trade_config_audit`);
    await asOperator(() => rows(db, `select public.trade_config_set(p_mode := 'dry-run', p_stake_per_buy_usd := 12)`));
    const after = await rows<{ n: number }>(db, `select count(*)::int n from public.trade_config_audit`);
    expect(after[0]!.n).toBe(before[0]!.n + 1);

    const [last] = await rows<{ old_value: { mode: string }; new_value: { mode: string; stake_per_buy_usd: number } }>(
      db,
      `select old_value, new_value from public.trade_config_audit order by changed_at desc, id desc limit 1`,
    );
    expect(last!.old_value.mode).toBe('off');
    expect(last!.new_value.mode).toBe('dry-run');
    expect(Number(last!.new_value.stake_per_buy_usd)).toBe(12);
  });
});

describe('0082 RPC envelopes — every no-arg jsonb RPC returns an OBJECT (0081 tripwire)', () => {
  it('trade_config_get / trade_live_preflight / dash_trading are objects, never top-level arrays', async () => {
    const shapes = await asOperator(() =>
      rows<{ getk: string; pfk: string; dashk: string }>(
        db,
        `select jsonb_typeof(public.trade_config_get())    as getk,
                jsonb_typeof(public.trade_live_preflight()) as pfk,
                jsonb_typeof(public.dash_trading())         as dashk`,
      ),
    );
    expect(shapes[0]).toEqual({ getk: 'object', pfk: 'object', dashk: 'object' });
  });

  it('trade_config_get envelopes the row under { config: {…} }', async () => {
    const [r] = await asOperator(() =>
      rows<{ has_config: boolean; mode: string }>(
        db,
        `select (public.trade_config_get() ? 'config') as has_config,
                public.trade_config_get()->'config'->>'mode' as mode`,
      ),
    );
    expect(r!.has_config).toBe(true);
    expect(r!.mode).toBe('off');
  });

  it('dash_trading carries config + preflight + openOrders + today', async () => {
    const [r] = await asOperator(() =>
      rows<Record<string, boolean>>(
        db,
        `select (public.dash_trading() ? 'config')     as c,
                (public.dash_trading() ? 'preflight')  as p,
                (public.dash_trading() ? 'openOrders') as o,
                (public.dash_trading() ? 'today')      as t`,
      ),
    );
    expect(r).toEqual({ c: true, p: true, o: true, t: true });
  });
});

describe('0082 live-mode INTERLOCK — trade_live_preflight() across every branch', () => {
  const preflight = () =>
    asOperator(() => rows<{ ok: boolean; reasons: string[]; checks: Record<string, unknown> }>(
      db,
      `select (public.trade_live_preflight()->>'ok')::boolean as ok,
              public.trade_live_preflight()->'reasons' as reasons,
              public.trade_live_preflight()->'checks'  as checks`,
    ));

  afterEach(async () => {
    await db.exec(`delete from public.bot_gate_snapshot`);
    await db.exec(`delete from public.trade_gate_override`);
    await resetCfg();
  });

  const passingGate = () =>
    db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (now(), 'paper', 'forward', 'PASS')`,
    );

  const goLive = () =>
    asOperator(() =>
      rows(db, `select public.trade_config_set(p_mode := 'live', p_active_until := (current_date + 7))`),
    );

  it('DARK config (mode off, no window, no gate) blocks with mode + active_until + gate reasons', async () => {
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    const joined = r!.reasons.join(' | ');
    expect(joined).toMatch(/mode is .*off.* — not 'live'/);
    expect(joined).toMatch(/active_until not set/);
    expect(joined).toMatch(/no PASS forward paper gate/);
  });

  it('mode=live + fresh window, but NO gate and NO override → blocks on the gate only', async () => {
    await goLive();
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.reasons).toHaveLength(1);
    expect(r!.reasons[0]).toMatch(/no PASS forward paper gate/);
  });

  it('a forward paper-gate PASS clears the interlock', async () => {
    await goLive();
    await passingGate();
    const [r] = await preflight();
    expect(r!.ok).toBe(true);
    expect(r!.reasons).toEqual([]);
    expect(r!.checks.gatePass).toBe(true);
  });

  it('a BACKTEST PASS does NOT clear it (the capital gate reads forward only)', async () => {
    await goLive();
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (now(), 'paper', 'backtest', 'PASS')`,
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.reasons[0]).toMatch(/no PASS forward paper gate/);
    expect(r!.checks.gatePass).toBe(false);
  });

  it('the NEWEST forward gate wins — a later KILL after a PASS blocks', async () => {
    await goLive();
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label) values
         (now() - interval '2 hours', 'paper', 'forward', 'PASS'),
         (now(),                      'paper', 'forward', 'KILL')`,
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.checks.gatePass).toBe(false);
  });

  it('an explicit trade_gate_override row clears it even with no gate PASS', async () => {
    await goLive();
    await db.exec(`insert into public.trade_gate_override (reason) values ('operator forward-tested manually')`);
    const [r] = await preflight();
    expect(r!.ok).toBe(true);
    expect(r!.checks.override).toBe(true);
    expect(r!.checks.overrideReason).toBe('operator forward-tested manually');
  });

  it('an EXPIRED active_until blocks even with a passing gate', async () => {
    await passingGate();
    await asOperator(() =>
      rows(db, `select public.trade_config_set(p_mode := 'live', p_active_until := (current_date - 1))`),
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.reasons.join(' | ')).toMatch(/run window expired/);
  });

  it('stake above the per-position cap blocks (both within the $25 ceiling)', async () => {
    await passingGate();
    // stake 20, cap 15 — both ≤ 25 (ceiling holds) but stake > cap → interlock blocks.
    await asOperator(() =>
      rows(
        db,
        `select public.trade_config_set(
           p_mode := 'live', p_active_until := (current_date + 7),
           p_stake_per_buy_usd := 20, p_per_position_cap_usd := 15)`,
      ),
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.reasons.join(' | ')).toMatch(/exceeds per_position_cap_usd/);
  });
});

describe('0082 packages/trading TS reader (via the PGlite twin port)', () => {
  afterEach(async () => {
    await db.exec(`delete from public.bot_gate_snapshot`);
    await db.exec(`delete from public.trade_gate_override`);
    await resetCfg();
  });

  it('loadTradeConfig maps the single row to a typed camelCase config', async () => {
    await asOperator(() =>
      rows(
        db,
        `select public.trade_config_set(
           p_mode := 'dry-run', p_stake_per_buy_usd := 8, p_per_position_cap_usd := 20,
           p_per_market_cap_usd := 35, p_total_concurrent_cap_usd := 90,
           p_daily_loss_kill_usd := 15, p_daily_loss_kill_frac := 0.2,
           p_city_allowlist := array['singapore','karachi']::text[], p_active_until := (current_date + 3))`,
      ),
    );
    const cfg = await loadTradeConfig(port);
    expect(cfg.mode).toBe('dry-run');
    expect(cfg.stakePerBuyUsd).toBe(8);
    expect(cfg.perPositionCapUsd).toBe(20);
    expect(cfg.perMarketCapUsd).toBe(35);
    expect(cfg.totalConcurrentCapUsd).toBe(90);
    expect(cfg.dailyLossKillUsd).toBe(15);
    expect(cfg.dailyLossKillFrac).toBe(0.2);
    expect(cfg.cityAllowlist).toEqual(['singapore', 'karachi']);
    expect(cfg.activeUntil).toBeTruthy();
  });

  it('preflightLive returns a typed verdict — blocked on the DARK default', async () => {
    const pf = await preflightLive(port);
    expect(pf.ok).toBe(false);
    expect(pf.reasons.length).toBeGreaterThan(0);
    expect(pf.checks.mode).toBe('off');
    expect(pf.checks.gatePass).toBe(false);
  });

  it('preflightLive.ok flips true once live + fresh window + a forward PASS', async () => {
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (now(), 'paper', 'forward', 'PASS')`,
    );
    await asOperator(() =>
      rows(db, `select public.trade_config_set(p_mode := 'live', p_active_until := (current_date + 7))`),
    );
    const pf = await preflightLive(port);
    expect(pf.ok).toBe(true);
    expect(pf.reasons).toEqual([]);
    expect(pf.checks.gatePass).toBe(true);
  });
});
