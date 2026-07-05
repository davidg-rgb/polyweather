/**
 * 0082 trading-activation + risk-console twin tests (STAGED DARK — the migration is written, never applied to a
 * live DB; this exercises it in PGlite). Covers: the single-row trade_config surface + seed, the §9R $25 CHECK
 * ceiling, the F5 60-day run-window cap, the ENFORCED append-only audit (F6 — no role holds UPDATE/DELETE),
 * every RPC's OBJECT-envelope shape (0081 tripwire), the live-mode INTERLOCK across all branches (no-PASS /
 * forward-PASS / backtest-PASS-rejected / EXPIRING override set+clear (F1) / expired window / stake>cap /
 * daily-loss kill absolute+fractional over the N1 REALIZED-at-sell-time shared definition (the four required
 * N1 cases: cross-midnight loss lands in the sell day, open-buys-only day is NOT a loss, profitable round
 * trips — same-day and cross-midnight — are 0) / dry-run isolation (addendum)), the F3 non-operator
 * ERR_FORBIDDEN guards, the seven bot_order_* T1 OrderLedger RPCs (F4 partial-unique reserve semantics,
 * mode-scoped keys, N2 exact marginal notionals, N3/N7 raise-on-unknown-id across ALL FOUR record_* fns with
 * silent terminal echoes, N4 monotonic size_matched, N6 fill-on-intent promotion + late record_placed, the
 * N9 ≥5-min-stale dangling-intent sweep, cancel preserving size_matched), and the packages/trading TS reader.
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

/** Call as an authenticated NON-operator — the F3 negative-guard identity. */
const asIntruder = <T>(fn: () => Promise<T>) =>
  asRole(db, 'authenticated', { email: 'intruder@example.com' }, fn);

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

/** Wipe the order/fill ledger (fills first — FK). */
async function resetLedger(): Promise<void> {
  await db.exec(`delete from public.live_fills`);
  await db.exec(`delete from public.live_orders`);
}

let seedSeq = 0;
/** Insert a live_orders row directly (superuser) with a unique key; returns its id. */
async function seedOrder(opts: {
  mode: 'live' | 'dry-run';
  side?: 'BUY' | 'SELL';
  status?: string;
  price: number;
  size: number;
  marketId?: string;
}): Promise<string> {
  seedSeq += 1;
  const r = await rows<{ id: string }>(
    db,
    `insert into public.live_orders
       (intent_key, client_order_id, market_id, token_id, side, purpose, order_type,
        price, size, trade_date, mode, status)
     values ($1, $2, $3, 'tok', $4, 'entry', 'GTC', $5, $6, current_date, $7, $8)
     returning id`,
    [
      `seed-k${seedSeq}`, `seed-c${seedSeq}`, opts.marketId ?? 'mkt-1', opts.side ?? 'BUY',
      opts.price, opts.size, opts.mode, opts.status ?? 'intent',
    ],
  );
  return r[0]!.id;
}

/** Insert a live_fills row for an order. fill_notional = price × size (the N2 exact-cash column); filledAt
 * defaults to now() — pass an ISO timestamp to backdate (the N1 cross-midnight tests). */
async function seedFill(
  orderId: string, price: number, size: number, fee = 0, filledAt?: string,
): Promise<void> {
  await rows(
    db,
    `insert into public.live_fills (order_id, fill_price, fill_size, fill_notional, fee_usd, filled_at)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))`,
    [orderId, price, size, price * size, fee, filledAt ?? null],
  );
}

/** Yesterday, same wall-clock — always before today's UTC-midnight loss window. */
const YESTERDAY = () => new Date(Date.now() - 86_400_000).toISOString();

/** A filled order + its fill in one call — the realized-P&L seed for the daily-loss tests. */
async function seedRealized(
  mode: 'live' | 'dry-run', side: 'BUY' | 'SELL', price: number, size: number, filledAt?: string,
): Promise<void> {
  const id = await seedOrder({ mode, side, status: 'filled', price, size });
  await seedFill(id, price, size, 0, filledAt);
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

  it('F4: live_orders has the PARTIAL-UNIQUE (mode, intent_key) over non-terminal rows', async () => {
    const [idx] = await rows<{ indexdef: string }>(
      db,
      `select indexdef from pg_indexes where schemaname='public' and tablename='live_orders'
         and indexname = 'live_orders_intent_open_key'`,
    );
    expect(idx).toBeDefined();
    expect(idx!.indexdef).toContain('UNIQUE');
    expect(idx!.indexdef).toMatch(/\(mode,\s*intent_key\)/);
    expect(idx!.indexdef).toContain('WHERE');
    expect(idx!.indexdef).toMatch(/canceled/);
    expect(idx!.indexdef).toMatch(/failed/);
  });

  it('one OPEN row per client_order_id (partial-unique — record_* lookups key on it)', async () => {
    const [idx] = await rows<{ indexdef: string }>(
      db,
      `select indexdef from pg_indexes where schemaname='public' and tablename='live_orders'
         and indexname = 'live_orders_client_open_key'`,
    );
    expect(idx).toBeDefined();
    expect(idx!.indexdef).toContain('UNIQUE');
    expect(idx!.indexdef).toContain('WHERE');
  });

  it('F9: the status enum is T1-aligned — single-L canceled admitted, double-L cancelled rejected', async () => {
    await seedOrder({ mode: 'live', price: 0.3, size: 10, status: 'canceled' });
    await expect(seedOrder({ mode: 'live', price: 0.3, size: 10, status: 'cancelled' })).rejects.toThrow(/check/i);
    await expect(seedOrder({ mode: 'live', price: 0.3, size: 10, status: 'expired' })).rejects.toThrow(/check/i);
    await resetLedger();
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

  it('F5: rejects active_until more than 60 days out', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_config_set(p_active_until := (current_date + 61))`)),
    ).rejects.toThrow(/more than 60 days out/);
  });

  it('F5: accepts active_until exactly 60 days out', async () => {
    await asOperator(() => rows(db, `select public.trade_config_set(p_active_until := (current_date + 60))`));
    const [c] = await rows<{ active_until: string }>(db, `select active_until from public.trade_config`);
    expect(c!.active_until).toBeTruthy();
  });
});

describe('0082 audit — append-only whole-config old/new jsonb (F6: enforced by grants)', () => {
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

  it('F6: service_role cannot UPDATE or DELETE audit rows (append-only enforced, not just claimed)', async () => {
    await expect(
      asRole(db, 'service_role', null, () =>
        rows(db, `update public.trade_config_audit set changed_by = 'tampered' where true`),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asRole(db, 'service_role', null, () => rows(db, `delete from public.trade_config_audit where true`)),
    ).rejects.toThrow(/permission denied/i);
  });

  it('F6/F7: a DIRECT service_role trade_config write still audits (INSERT grant suffices; changed_by = role)', async () => {
    const before = await rows<{ n: number }>(db, `select count(*)::int n from public.trade_config_audit`);
    await asRole(db, 'service_role', null, () =>
      rows(db, `update public.trade_config set daily_loss_kill_usd = 29 where id = 1`),
    );
    const after = await rows<{ n: number }>(db, `select count(*)::int n from public.trade_config_audit`);
    expect(after[0]!.n).toBe(before[0]!.n + 1);
    const [last] = await rows<{ changed_by: string }>(
      db,
      `select changed_by from public.trade_config_audit order by changed_at desc, id desc limit 1`,
    );
    // F7: changed_by records the EFFECTIVE ROLE, not a person.
    expect(last!.changed_by).toBe('service_role');
  });
});

describe('0082 RPC envelopes — every no-arg jsonb RPC returns an OBJECT (0081 tripwire)', () => {
  afterEach(async () => {
    await db.exec(`delete from public.trade_gate_override`);
  });

  it('trade_config_get / trade_live_preflight / dash_trading / trade_gate_override_clear are objects', async () => {
    const shapes = await asOperator(() =>
      rows<{ getk: string; pfk: string; dashk: string; clrk: string }>(
        db,
        `select jsonb_typeof(public.trade_config_get())         as getk,
                jsonb_typeof(public.trade_live_preflight())      as pfk,
                jsonb_typeof(public.dash_trading())              as dashk,
                jsonb_typeof(public.trade_gate_override_clear()) as clrk`,
      ),
    );
    expect(shapes[0]).toEqual({ getk: 'object', pfk: 'object', dashk: 'object', clrk: 'object' });
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

  it('dash_trading carries config + preflight + openOrders + today + dryRun', async () => {
    const [r] = await asOperator(() =>
      rows<Record<string, boolean>>(
        db,
        `select (public.dash_trading() ? 'config')     as c,
                (public.dash_trading() ? 'preflight')  as p,
                (public.dash_trading() ? 'openOrders') as o,
                (public.dash_trading() ? 'today')      as t,
                (public.dash_trading() ? 'dryRun')     as d`,
      ),
    );
    expect(r).toEqual({ c: true, p: true, o: true, t: true, d: true });
  });

  it('trade_gate_override_set returns { override: {…} } with the stored row', async () => {
    const [r] = await asOperator(() =>
      rows<{ v: { override: { reason: string; note: string | null } } }>(
        db,
        `select public.trade_gate_override_set('shape test', now() + interval '1 hour', 'note-1') as v`,
      ),
    );
    expect(r!.v.override.reason).toBe('shape test');
    expect(r!.v.override.note).toBe('note-1');
  });
});

describe('0082 F3 — authenticated NON-operator gets ERR_FORBIDDEN from every guarded RPC', () => {
  // These four FAIL if the operator_guard() first-statement is ever deleted: without the guard,
  // trade_config_set would update, dash_trading would return data, and the override RPCs would write.
  it('trade_config_set', async () => {
    await expect(
      asIntruder(() => rows(db, `select public.trade_config_set(p_mode := 'off')`)),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });

  it('dash_trading', async () => {
    await expect(asIntruder(() => rows(db, `select public.dash_trading()`))).rejects.toThrow(/ERR_FORBIDDEN/);
  });

  it('trade_gate_override_set', async () => {
    await expect(
      asIntruder(() => rows(db, `select public.trade_gate_override_set('nope', now() + interval '1 hour')`)),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });

  it('trade_gate_override_clear', async () => {
    await expect(asIntruder(() => rows(db, `select public.trade_gate_override_clear()`))).rejects.toThrow(
      /ERR_FORBIDDEN/,
    );
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
    await resetLedger();
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

  it('F8: same-timestamp snapshots tiebreak on id desc — the later insert wins', async () => {
    await goLive();
    // Same computed_at for both rows: only the id order separates them; the later insert (KILL) must win.
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (date_trunc('minute', now()), 'paper', 'forward', 'PASS')`,
    );
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (date_trunc('minute', now()), 'paper', 'forward', 'KILL')`,
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.checks.gatePass).toBe(false);
  });

  it('F1: an ACTIVE override (via trade_gate_override_set) clears it even with no gate PASS', async () => {
    await goLive();
    await asOperator(() =>
      rows(db, `select public.trade_gate_override_set('operator forward-tested manually', now() + interval '2 hours')`),
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(true);
    expect(r!.checks.override).toBe(true);
    expect(r!.checks.overrideReason).toBe('operator forward-tested manually');
    expect(r!.checks.overrideExpiresAt).toBeTruthy();
  });

  it('F1: an EXPIRED override does NOT unlock', async () => {
    await goLive();
    // Direct insert — the RPC (correctly) refuses to write an already-expired override.
    await db.exec(
      `insert into public.trade_gate_override (reason, expires_at)
       values ('stale override', now() - interval '1 minute')`,
    );
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.checks.override).toBe(false);
    expect(r!.reasons.join(' | ')).toMatch(/no ACTIVE trade_gate_override/);
  });

  it('F1: a CLEARED override does not unlock (clear expires active rows in place)', async () => {
    await goLive();
    await asOperator(() =>
      rows(db, `select public.trade_gate_override_set('to be cleared', now() + interval '2 hours')`),
    );
    const [cleared] = await asOperator(() =>
      rows<{ v: { cleared: number } }>(db, `select public.trade_gate_override_clear() as v`),
    );
    expect(cleared!.v.cleared).toBe(1);
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.checks.override).toBe(false);
    // The row survives (audit trail) — it is expired, not deleted.
    const kept = await rows(db, `select 1 from public.trade_gate_override where reason = 'to be cleared'`);
    expect(kept).toHaveLength(1);
  });

  it('F1: trade_gate_override_set rejects a past expiry and an empty reason', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_gate_override_set('late', now() - interval '1 second')`)),
    ).rejects.toThrow(/expires_at must be in the future/);
    await expect(
      asOperator(() => rows(db, `select public.trade_gate_override_set('   ', now() + interval '1 hour')`)),
    ).rejects.toThrow(/reason must be non-empty/);
  });

  it('F1-residual: an override may live at most 14 days — 15d rejected, 14d accepted', async () => {
    await expect(
      asOperator(() => rows(db, `select public.trade_gate_override_set('too long', now() + interval '15 days')`)),
    ).rejects.toThrow(/more than 14 days out/);
    const [r] = await asOperator(() =>
      rows<{ v: { override: { reason: string } } }>(
        db,
        `select public.trade_gate_override_set('two weeks', now() + interval '14 days') as v`,
      ),
    );
    expect(r!.v.override.reason).toBe('two weeks');
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

  it('F2/N1: the ABSOLUTE daily-loss kill blocks on a REALIZED same-day losing round trip', async () => {
    await goLive();
    await passingGate();
    // kill at $5 absolute; frac 1 → basis $100 (out of the way). Buy $10 → sell for $5 ⇒ realized −$5.
    await asOperator(() =>
      rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 5, p_daily_loss_kill_frac := 1)`),
    );
    await seedRealized('live', 'BUY', 0.5, 20);   // $10 in
    await seedRealized('live', 'SELL', 0.25, 20); // $5 out ⇒ realized −$5 ≥ kill $5
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    expect(r!.reasons.join(' | ')).toMatch(/daily-loss kill: .* daily_loss_kill_usd/);
    expect(Number(r!.checks.todayLossUsd)).toBe(5);
  });

  it('F2/N1: the FRACTIONAL daily-loss kill blocks (loss ≥ frac × total_concurrent_cap_usd)', async () => {
    await goLive();
    await passingGate();
    // frac 0.05 × cap $100 = $5 basis; absolute kill $25 stays clear → ONLY the fractional branch fires.
    await asOperator(() =>
      rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 25, p_daily_loss_kill_frac := 0.05)`),
    );
    await seedRealized('live', 'BUY', 0.5, 20);   // $10 in
    await seedRealized('live', 'SELL', 0.25, 20); // realized −$5 ≥ basis $5, < $25 absolute
    const [r] = await preflight();
    expect(r!.ok).toBe(false);
    const joined = r!.reasons.join(' | ');
    expect(joined).toMatch(/total_concurrent_cap_usd basis/);
    expect(joined).not.toMatch(/>= daily_loss_kill_usd/);
    expect(Number(r!.checks.dailyLossKillFracBasisUsd)).toBe(5);
  });

  it('N1: a small realized loss below both thresholds does not trip (and is measured exactly)', async () => {
    await goLive();
    await passingGate();
    await asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 5)`));
    await seedRealized('live', 'BUY', 0.5, 20);  // $10 in
    await seedRealized('live', 'SELL', 0.4, 20); // $8 out ⇒ realized −$2 < $5
    const [r] = await preflight();
    expect(r!.ok).toBe(true);
    expect(Number(r!.checks.todayLossUsd)).toBe(2);
  });

  it('N1 (required 1): a CROSS-MIDNIGHT losing round trip lands in the SELL day — buy $30 in D, sell $20 in D+1 ⇒ D+1 loss $10, kill trips at threshold', async () => {
    await goLive();
    await passingGate();
    await asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 10)`));
    await seedRealized('live', 'BUY', 0.3, 100, YESTERDAY()); // $30 deployed YESTERDAY (day D)
    await seedRealized('live', 'SELL', 0.2, 100);             // $20 back TODAY (day D+1)
    const [r] = await preflight();
    // The old cashflow definition clamped this to 0 in D+1 (sells $20 > buys $0 today) — the falsifier.
    expect(Number(r!.checks.todayLossUsd)).toBe(10);
    expect(r!.ok).toBe(false); // 10 ≥ kill 10 — trips exactly at threshold
    expect(r!.reasons.join(' | ')).toMatch(/daily-loss kill/);
  });

  it('N1 (required 2): an open-buys-only healthy day is NOT a loss — no kill', async () => {
    await goLive();
    await passingGate();
    await asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 5)`));
    await seedRealized('live', 'BUY', 0.3, 100); // $30 deployed today, nothing sold
    const [r] = await preflight();
    // The old cashflow definition read this as a $30 "loss" ≥ kill $5 — the second falsifier.
    expect(Number(r!.checks.todayLossUsd)).toBe(0);
    expect(r!.ok).toBe(true);
  });

  it('N1 (required 3): a same-day PROFITABLE round trip ⇒ loss 0', async () => {
    await goLive();
    await passingGate();
    await asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 5)`));
    await seedRealized('live', 'BUY', 0.3, 100);  // $30 in
    await seedRealized('live', 'SELL', 0.4, 100); // $40 out ⇒ realized +$10
    const [r] = await preflight();
    expect(Number(r!.checks.todayLossUsd)).toBe(0);
    expect(r!.ok).toBe(true);
  });

  it('N1 (required 4): a CROSS-MIDNIGHT profitable round trip ⇒ loss 0', async () => {
    await goLive();
    await passingGate();
    await asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 5)`));
    await seedRealized('live', 'BUY', 0.3, 100, YESTERDAY()); // $30 in yesterday
    await seedRealized('live', 'SELL', 0.4, 100);             // $40 out today ⇒ realized +$10
    const [r] = await preflight();
    expect(Number(r!.checks.todayLossUsd)).toBe(0);
    expect(r!.ok).toBe(true);
  });

  it('N1: the loss window is NAMED in checks (lossWindowStart = UTC midnight)', async () => {
    const [r] = await asOperator(() =>
      rows<{ named: boolean; start: string }>(
        db,
        `select (public.trade_live_preflight()->'checks'->>'lossWindowStart')::timestamptz
                  = date_trunc('day', now()) as named,
                public.trade_live_preflight()->'checks'->>'lossWindowStart' as start`,
      ),
    );
    expect(r!.start).toBeTruthy();
    expect(r!.named).toBe(true);
  });

  it('ADDENDUM: dry-run fills move NOTHING — no loss, no exposure, preflight stays green', async () => {
    await goLive();
    await passingGate();
    await asOperator(() => rows(db, `select public.trade_config_set(p_daily_loss_kill_usd := 5)`));
    await seedRealized('dry-run', 'BUY', 0.5, 100);            // $50 dry-run buy — must NOT count
    await seedOrder({ mode: 'dry-run', price: 0.3, size: 30 }); // $9 open dry-run intent — must NOT count
    const [r] = await preflight();
    expect(r!.ok).toBe(true);
    expect(Number(r!.checks.todayLossUsd)).toBe(0);
    expect(Number(r!.checks.openExposureUsd)).toBe(0);
    expect(r!.checks.perMarketExposureUsd).toEqual({});
  });

  it('F2: open LIVE buy-side exposure is reported, total + per-market (SELL and dry-run excluded)', async () => {
    await goLive();
    await passingGate();
    await seedOrder({ mode: 'live', price: 0.3, size: 20, marketId: 'm1' });                 // $6 open BUY
    await seedOrder({ mode: 'live', price: 0.2, size: 20, marketId: 'm2', status: 'placed' }); // $4 open BUY
    await seedOrder({ mode: 'live', side: 'SELL', price: 0.7, size: 10, marketId: 'm1' });   // SELL — excluded
    await seedOrder({ mode: 'dry-run', price: 0.5, size: 20, marketId: 'm3' });              // dry-run — excluded
    const [r] = await preflight();
    expect(r!.ok).toBe(true); // exposure is reported, NOT blocking — the runner enforces the caps per placement
    expect(Number(r!.checks.openExposureUsd)).toBe(10);
    const perMkt = r!.checks.perMarketExposureUsd as Record<string, number>;
    expect(Number(perMkt['m1'])).toBe(6);
    expect(Number(perMkt['m2'])).toBe(4);
    expect(perMkt['m3']).toBeUndefined();
  });

  it('ADDENDUM: dash_trading money figures are LIVE-only; dryRun section counts the shadow rail', async () => {
    await seedRealized('dry-run', 'BUY', 0.5, 100);             // $50 dry-run fill
    await seedOrder({ mode: 'dry-run', price: 0.3, size: 30 }); // open dry-run intent
    await seedRealized('live', 'BUY', 0.5, 8);                  // $4 live fill
    const [d] = await asOperator(() =>
      rows<{ v: { today: { buyUsd: number; lossUsd: number; nFills: number }; openOrders: unknown[]; dryRun: { openOrders: number; total: number } } }>(
        db,
        `select public.dash_trading() as v`,
      ),
    );
    expect(Number(d!.v.today.buyUsd)).toBe(4);   // the $50 dry-run fill is invisible here
    expect(Number(d!.v.today.lossUsd)).toBe(0);  // N1: an open buy is NOT a loss — dash uses the SHARED definition
    expect(Number(d!.v.today.nFills)).toBe(1);
    expect(d!.v.openOrders).toEqual([]);          // the open dry-run intent is not a live open order
    expect(Number(d!.v.dryRun.openOrders)).toBe(1);
    expect(Number(d!.v.dryRun.total)).toBe(2);
  });

  it('N1: dash_trading.today.lossUsd is the SAME shared definition as preflight (cross-midnight case)', async () => {
    await seedRealized('live', 'BUY', 0.3, 100, YESTERDAY()); // $30 in yesterday
    await seedRealized('live', 'SELL', 0.2, 100);             // $20 out today ⇒ realized −$10
    const [r] = await asOperator(() =>
      rows<{ dash_loss: string; pf_loss: string }>(
        db,
        `select public.dash_trading()->'today'->>'lossUsd' as dash_loss,
                public.trade_live_preflight()->'checks'->>'todayLossUsd' as pf_loss`,
      ),
    );
    expect(Number(r!.dash_loss)).toBe(10);
    expect(Number(r!.dash_loss)).toBe(Number(r!.pf_loss)); // one definition, two consumers
  });
});

describe('0082 §9 — the six bot_order_* RPCs (the T1 OrderLedger contract)', () => {
  afterEach(resetLedger);

  const reserve = async (over: Record<string, unknown> = {}): Promise<string> => {
    const [r] = await port.rpc<{ bot_order_reserve_intent: string }>('bot_order_reserve_intent', {
      p_mode: 'live', p_intent_key: 'k1', p_client_order_id: 'c1', p_market_id: 'm1', p_token_id: 't1',
      p_side: 'BUY', p_purpose: 'entry', p_order_type: 'GTC', p_price: 0.3, p_size: 10,
      p_trade_date: '2026-07-05', ...over,
    });
    return r!.bot_order_reserve_intent;
  };

  const byIntent = async (key = 'k1', mode = 'live'): Promise<Record<string, unknown> | null> => {
    const [r] = await port.rpc<{ bot_order_by_intent: Record<string, unknown> | null }>('bot_order_by_intent', {
      p_intent_key: key, p_mode: mode,
    });
    return r?.bot_order_by_intent ?? null;
  };

  it('reserve → reserved; a second reserve on the same (mode, intent) → exists (the race semantics)', async () => {
    expect(await reserve()).toBe('reserved');
    expect(await reserve({ p_client_order_id: 'c1-retry' })).toBe('exists');
    const n = await rows<{ n: number }>(db, `select count(*)::int n from public.live_orders`);
    expect(n[0]!.n).toBe(1); // never a second row for the open intent
  });

  it('by_intent returns the OPEN snake_case row (mapLedgerRow input shape); other mode → null', async () => {
    await reserve();
    const row = await byIntent();
    expect(row).not.toBeNull();
    expect(row!['intent_key']).toBe('k1');
    expect(row!['client_order_id']).toBe('c1');
    expect(row!['status']).toBe('intent');
    expect(row!['side']).toBe('BUY');
    expect(row!['purpose']).toBe('entry');
    expect(Number(row!['size_matched'])).toBe(0);
    expect(row!['order_id']).toBeNull();
    // F4: dry-run and live are distinct intents — the same key in the other mode is empty.
    expect(await byIntent('k1', 'dry-run')).toBeNull();
  });

  it('F4: dry-run and live reserve the SAME key independently and coexist', async () => {
    expect(await reserve()).toBe('reserved');
    expect(await reserve({ p_mode: 'dry-run', p_client_order_id: 'c1-dry' })).toBe('reserved');
    const live = await byIntent('k1', 'live');
    const dry = await byIntent('k1', 'dry-run');
    expect(live!['mode']).toBe('live');
    expect(dry!['mode']).toBe('dry-run');
  });

  it('record_placed: intent → placed, stamps the venue orderID', async () => {
    await reserve();
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-77' });
    const row = await byIntent();
    expect(row!['status']).toBe('placed');
    expect(row!['order_id']).toBe('venue-77');
    expect(row!['placed_at']).toBeTruthy();
  });

  it('N2: record_fill stores the MARGINAL notional — the lens example 5@0.30 then 8@0.31 sums to 2.48 EXACTLY', async () => {
    await reserve();
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-77' });

    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 5, p_avg_price: 0.3, p_status: 'partial',
    });
    let row = await byIntent();
    expect(row!['status']).toBe('partial');
    expect(Number(row!['size_matched'])).toBe(5);

    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 8, p_avg_price: 0.31, p_status: 'filled',
    });
    row = await byIntent();
    expect(row!['status']).toBe('filled');
    expect(Number(row!['size_matched'])).toBe(8);
    expect(Number(row!['avg_price'])).toBeCloseTo(0.31);

    const fills = await rows<{ fill_size: string; fill_price: string; fill_notional: string }>(
      db,
      `select fill_size, fill_price, fill_notional from public.live_fills order by created_at asc, filled_at asc`,
    );
    expect(fills.map((f) => Number(f.fill_size))).toEqual([5, 3]); // the deltas, not the cumulatives
    // Marginal notionals: 0.30×5 = 1.50, then 0.31×8 − 0.30×5 = 0.98 (the second delta's TRUE cash — the old
    // cumulative-avg fill_price would have claimed 0.31×3 = 0.93).
    expect(Number(fills[0]!.fill_notional)).toBe(1.5);
    expect(Number(fills[1]!.fill_notional)).toBe(0.98);
    // fill_price is display-only: marginal/delta (0.98/3 ≈ 0.326667 — the second leg filled ABOVE 0.31).
    expect(Number(fills[1]!.fill_price)).toBeCloseTo(0.326667, 5);
    // THE lens assertion — the true cash sums EXACTLY (numeric equality in SQL, no float slack):
    const [exact] = await rows<{ ok: boolean }>(
      db,
      `select sum(fill_notional) = 2.48 as ok from public.live_fills`,
    );
    expect(exact!.ok).toBe(true);
    // and why fill_notional (not fill_price × fill_size) carries it: 0.98/3 is non-terminating, so the
    // price×size sum can only be CLOSE to 2.48 — documented in the migration header.
    const [approx] = await rows<{ s: string }>(
      db,
      `select sum(fill_price * fill_size)::text as s from public.live_fills`,
    );
    expect(Number(approx!.s)).toBeCloseTo(2.48, 4);
  });

  it('N3: record_fill RAISES on an id with NO ledger row (a reconcile bug must never be swallowed)', async () => {
    await expect(
      port.rpc('bot_order_record_fill', {
        p_client_order_id: 'ghost', p_size_matched: 5, p_avg_price: 0.3, p_status: 'partial',
      }),
    ).rejects.toThrow(/unknown client_order_id/);
  });

  it('N3: record_fill is SILENT on a row that exists but is TERMINAL (duplicate venue echo)', async () => {
    await reserve();
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    // Same id, row exists (canceled) → at-least-once delivery is benign: resolves, writes nothing.
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 5, p_avg_price: 0.3, p_status: 'partial',
    });
    const n = await rows<{ n: number }>(db, `select count(*)::int n from public.live_fills`);
    expect(n[0]!.n).toBe(0);
    const [o] = await rows<{ status: string }>(db, `select status from public.live_orders where client_order_id = 'c1'`);
    expect(o!.status).toBe('canceled'); // untouched
  });

  it('record_fill rejects a bad p_status outright', async () => {
    await reserve();
    await expect(
      port.rpc('bot_order_record_fill', {
        p_client_order_id: 'c1', p_size_matched: 5, p_avg_price: 0.3, p_status: 'canceled',
      }),
    ).rejects.toThrow(/must be filled\|partial/);
  });

  it('N4: a SHRINKING cumulative echo is a full no-op — size_matched is strictly monotonic', async () => {
    await reserve();
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-77' });
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 5, p_avg_price: 0.3, p_status: 'partial',
    });
    // Anomalous venue echo claims cumulative 3 < 5 — nothing may move.
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 3, p_avg_price: 0.29, p_status: 'partial',
    });
    const row = await byIntent();
    expect(Number(row!['size_matched'])).toBe(5);            // no regression
    expect(Number(row!['avg_price'])).toBeCloseTo(0.3);      // untouched
    expect(row!['status']).toBe('partial');
    const n = await rows<{ n: number }>(db, `select count(*)::int n from public.live_fills`);
    expect(n[0]!.n).toBe(1);                                  // no phantom fill row
  });

  it('N6: a fill on an INTENT row promotes directly (instant FOK beats record_placed)', async () => {
    await reserve();
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 10, p_avg_price: 0.3, p_status: 'filled',
    });
    const row = await byIntent();
    expect(row!['status']).toBe('filled');
    expect(Number(row!['size_matched'])).toBe(10);
    const fills = await rows<{ fill_notional: string }>(db, `select fill_notional from public.live_fills`);
    expect(fills.map((f) => Number(f.fill_notional))).toEqual([3]);
  });

  it('N6: a LATE record_placed never regresses status but still records the venue order_id', async () => {
    await reserve();
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 10, p_avg_price: 0.3, p_status: 'filled',
    });
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-late-9' });
    const row = await byIntent();
    expect(row!['status']).toBe('filled');           // NOT regressed to 'placed'
    expect(row!['order_id']).toBe('venue-late-9');   // the venue id still lands
    expect(row!['placed_at']).toBeTruthy();
  });

  it('F4: record_canceled frees the key — a re-reserve succeeds as a NEW row', async () => {
    await reserve();
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    expect(await byIntent()).toBeNull(); // no OPEN row for the key
    expect(await reserve({ p_client_order_id: 'c1-reprice' })).toBe('reserved');
    const n = await rows<{ n: number }>(db, `select count(*)::int n from public.live_orders`);
    expect(n[0]!.n).toBe(2); // the canceled row is kept (history), the new intent is open
  });

  it('ADDENDUM: record_canceled PRESERVES size_matched (the reprice partial-accounting reads it)', async () => {
    await reserve();
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-77' });
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 5, p_avg_price: 0.3, p_status: 'partial',
    });
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    const [o] = await rows<{ status: string; size_matched: string; avg_price: string }>(
      db,
      `select status, size_matched, avg_price from public.live_orders where client_order_id = 'c1'`,
    );
    expect(o!.status).toBe('canceled');
    expect(Number(o!.size_matched)).toBe(5);      // preserved through the cancel transition
    expect(Number(o!.avg_price)).toBeCloseTo(0.3); // basis preserved too
  });

  it('ADDENDUM: bot_order_list_dangling returns {rows:[...]} of intent+order_id-null rows, mode-scoped', async () => {
    // c1: live intent, no order_id → DANGLING. c2: live placed (has order_id) → not dangling.
    // c3: dry-run intent, no order_id → dangling only under p_mode='dry-run'. c4: live canceled → never.
    await reserve();                                                              // c1/k1 live intent
    await reserve({ p_intent_key: 'k2', p_client_order_id: 'c2' });
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c2', p_order_id: 'venue-2' });
    await reserve({ p_mode: 'dry-run', p_intent_key: 'k3', p_client_order_id: 'c3' });
    await reserve({ p_intent_key: 'k4', p_client_order_id: 'c4' });
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c4' });

    // Envelope shape (post-0081 idiom): an OBJECT carrying rows — never a top-level array, args or not.
    const [shape] = await rows<{ outer: string; inner: string }>(
      db,
      `select jsonb_typeof(public.bot_order_list_dangling('live')) as outer,
              jsonb_typeof(public.bot_order_list_dangling('live')->'rows') as inner`,
    );
    expect(shape).toEqual({ outer: 'object', inner: 'array' });

    // p_older_than_min: 0 — these rows were reserved milliseconds ago (the N9 default of 5 min would
    // correctly hide them; age-0 shows everything, which is what THIS test scopes on).
    const [live] = await port.rpc<{ bot_order_list_dangling: { rows: Record<string, unknown>[] } }>(
      'bot_order_list_dangling', { p_mode: 'live', p_older_than_min: 0 },
    );
    const liveRows = live!.bot_order_list_dangling.rows;
    expect(liveRows.map((r) => r['client_order_id'])).toEqual(['c1']);
    // the row shape matches bot_order_by_intent's (same to_jsonb(live_orders) fields)
    expect(liveRows[0]!['intent_key']).toBe('k1');
    expect(liveRows[0]!['status']).toBe('intent');
    expect(liveRows[0]!['order_id']).toBeNull();
    expect(liveRows[0]!['side']).toBe('BUY');
    expect(Number(liveRows[0]!['size_matched'])).toBe(0);

    const [dry] = await port.rpc<{ bot_order_list_dangling: { rows: Record<string, unknown>[] } }>(
      'bot_order_list_dangling', { p_mode: 'dry-run', p_older_than_min: 0 },
    );
    expect(dry!.bot_order_list_dangling.rows.map((r) => r['client_order_id'])).toEqual(['c3']);
  });

  it('ADDENDUM: bot_order_list_dangling returns {rows:[]} (not null/array) when nothing dangles', async () => {
    const [empty] = await port.rpc<{ bot_order_list_dangling: { rows: unknown[] } }>(
      'bot_order_list_dangling', { p_mode: 'live' },
    );
    expect(empty!.bot_order_list_dangling).toEqual({ rows: [] });
  });

  it('N9: the staleness window — a JUST-RESERVED intent is invisible to the default sweep; a backdated one shows', async () => {
    await reserve(); // c1/k1, reserved milliseconds ago — inside the normal reserve→post→record window
    // Default sweep (p_older_than_min omitted → SQL NULL positionally → coalesces to 5): fresh intent hidden.
    const [fresh] = await port.rpc<{ bot_order_list_dangling: { rows: unknown[] } }>(
      'bot_order_list_dangling', { p_mode: 'live' },
    );
    expect(fresh!.bot_order_list_dangling.rows).toEqual([]);
    // The same via the SQL default-arg path (T1's (p_mode)-only PostgREST call shape).
    const [sqlDefault] = await rows<{ n: number }>(
      db,
      `select jsonb_array_length(public.bot_order_list_dangling('live')->'rows')::int as n`,
    );
    expect(sqlDefault!.n).toBe(0);
    // Backdate the reservation past the window → the sweep now sees it.
    await db.exec(
      `update public.live_orders set created_at = now() - interval '10 minutes' where client_order_id = 'c1'`,
    );
    const [stale] = await port.rpc<{ bot_order_list_dangling: { rows: Record<string, unknown>[] } }>(
      'bot_order_list_dangling', { p_mode: 'live' },
    );
    expect(stale!.bot_order_list_dangling.rows.map((r) => r['client_order_id'])).toEqual(['c1']);
  });

  it('N7: record_placed RAISES on a ghost id; a terminal-row echo stays silent', async () => {
    await expect(
      port.rpc('bot_order_record_placed', { p_client_order_id: 'ghost', p_order_id: 'venue-x' }),
    ).rejects.toThrow(/unknown client_order_id/);
    await reserve();
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    // Row exists (canceled) → silent no-op: status untouched, order_id NOT stamped.
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-late' });
    const [o] = await rows<{ status: string; order_id: string | null }>(
      db,
      `select status, order_id from public.live_orders where client_order_id = 'c1'`,
    );
    expect(o!.status).toBe('canceled');
    expect(o!.order_id).toBeNull();
  });

  it('N7: record_canceled RAISES on a ghost id; an already-canceled echo stays silent', async () => {
    await expect(
      port.rpc('bot_order_record_canceled', { p_client_order_id: 'ghost' }),
    ).rejects.toThrow(/unknown client_order_id/);
    await reserve();
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    // The duplicate cancel echo: row exists, terminal → resolves silently, stays canceled.
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    const [o] = await rows<{ status: string }>(
      db,
      `select status from public.live_orders where client_order_id = 'c1'`,
    );
    expect(o!.status).toBe('canceled');
  });

  it('N7: record_failed RAISES on a ghost id; a terminal-row echo stays silent (no reason overwrite)', async () => {
    await expect(
      port.rpc('bot_order_record_failed', { p_client_order_id: 'ghost', p_error: 'boom' }),
    ).rejects.toThrow(/unknown client_order_id/);
    await reserve();
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    // Row exists (canceled) → silent no-op: status stays canceled, no failure reason lands.
    await port.rpc('bot_order_record_failed', { p_client_order_id: 'c1', p_error: 'late failure echo' });
    const [o] = await rows<{ status: string; reason: string | null }>(
      db,
      `select status, reason from public.live_orders where client_order_id = 'c1'`,
    );
    expect(o!.status).toBe('canceled');
    expect(o!.reason).toBeNull();
  });

  it('F4: record_failed frees the key too and stores the error', async () => {
    await reserve();
    await port.rpc('bot_order_record_failed', { p_client_order_id: 'c1', p_error: 'venue 500' });
    const [failed] = await rows<{ status: string; reason: string }>(
      db,
      `select status, reason from public.live_orders where client_order_id = 'c1'`,
    );
    expect(failed!.status).toBe('failed');
    expect(failed!.reason).toBe('venue 500');
    expect(await reserve({ p_client_order_id: 'c1-retry' })).toBe('reserved');
  });

  it('a FILLED order is immutable — cancel on filled is a no-op and the key stays HELD', async () => {
    await reserve();
    await port.rpc('bot_order_record_placed', { p_client_order_id: 'c1', p_order_id: 'venue-77' });
    await port.rpc('bot_order_record_fill', {
      p_client_order_id: 'c1', p_size_matched: 10, p_avg_price: 0.3, p_status: 'filled',
    });
    await port.rpc('bot_order_record_canceled', { p_client_order_id: 'c1' });
    const row = await byIntent();
    expect(row!['status']).toBe('filled'); // not canceled
    expect(await reserve({ p_client_order_id: 'c1-again' })).toBe('exists'); // filled HOLDS the key — never re-place
  });

  it('all seven ledger RPCs are service-role ONLY (anon + authenticated revoked)', async () => {
    const sigs = [
      'public.bot_order_by_intent(text, text)',
      'public.bot_order_reserve_intent(text, text, text, text, text, text, text, text, numeric, numeric, date)',
      'public.bot_order_record_placed(text, text)',
      // 0084 #17/#19: record_fill was DROP+RECREATED with a trailing p_fee_usd (the 0054 no-overload idiom).
      'public.bot_order_record_fill(text, numeric, numeric, text, numeric)',
      'public.bot_order_record_canceled(text)',
      'public.bot_order_record_failed(text, text)',
      'public.bot_order_list_dangling(text, integer)',
      // 0084 #18: the hold-to-resolution loss booking joins the service-role-only ledger surface.
      'public.bot_order_record_resolution_loss(text, text, text)',
    ];
    for (const sig of sigs) {
      const [g] = await rows<{ anon_can: boolean; authd_can: boolean; svc_can: boolean }>(
        db,
        `select has_function_privilege('anon', '${sig}', 'EXECUTE')          as anon_can,
                has_function_privilege('authenticated', '${sig}', 'EXECUTE') as authd_can,
                has_function_privilege('service_role', '${sig}', 'EXECUTE')  as svc_can`,
      );
      expect(g!.anon_can, `${sig} anon`).toBe(false);
      expect(g!.authd_can, `${sig} authenticated`).toBe(false);
      expect(g!.svc_can, `${sig} service_role`).toBe(true);
    }
  });
});

describe('0082 packages/trading TS reader (via the PGlite twin port)', () => {
  afterEach(async () => {
    await db.exec(`delete from public.bot_gate_snapshot`);
    await db.exec(`delete from public.trade_gate_override`);
    await resetLedger();
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

  it('preflightLive returns a typed verdict — blocked on the DARK default, zeroed money figures', async () => {
    const pf = await preflightLive(port);
    expect(pf.ok).toBe(false);
    expect(pf.reasons.length).toBeGreaterThan(0);
    expect(pf.checks.mode).toBe('off');
    expect(pf.checks.gatePass).toBe(false);
    expect(Number(pf.checks.todayLossUsd)).toBe(0);
    expect(pf.checks.lossWindowStart).toBeTruthy(); // N1: the loss window is named, typed through
    expect(Number(pf.checks.openExposureUsd)).toBe(0);
    expect(pf.checks.perMarketExposureUsd).toEqual({});
  });

  it('preflightLive.ok flips true once live + fresh window + a forward PASS; exposure figures ride along', async () => {
    await db.exec(
      `insert into public.bot_gate_snapshot (computed_at, mode, source, label)
       values (now(), 'paper', 'forward', 'PASS')`,
    );
    await asOperator(() =>
      rows(db, `select public.trade_config_set(p_mode := 'live', p_active_until := (current_date + 7))`),
    );
    await seedOrder({ mode: 'live', price: 0.25, size: 40, marketId: 'm9' }); // $10 open live BUY
    const pf = await preflightLive(port);
    expect(pf.ok).toBe(true);
    expect(pf.reasons).toEqual([]);
    expect(pf.checks.gatePass).toBe(true);
    expect(Number(pf.checks.openExposureUsd)).toBe(10);
    expect(Number(pf.checks.perMarketExposureUsd['m9'])).toBe(10);
    expect(Number(pf.checks.totalConcurrentCapUsd)).toBe(100);
    expect(Number(pf.checks.perMarketCapUsd)).toBe(40);
  });
});
