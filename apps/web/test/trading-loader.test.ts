/**
 * getTrading (0082) — the LIVE-RAIL activation-console loader. A crafted dash_trading payload goes in; the
 * passthrough + the null-tolerant defaults come out. Pure unit test over a stubbed WebDb (no PGlite).
 *
 * 2026-07-05 review #22: the loader now returns a DISCRIMINATED TradingLoad instead of a conflating null —
 * ONLY the undefined-function error class (Postgres 42883 / PostgREST PGRST202 "could not find the function …
 * in the schema cache") maps to { kind: 'not-applied' } (the true staged-dark day-one state); every other
 * failure (transient 5xx, DB restart, operator_guard rejection) maps to { kind: 'error' } so /trading renders
 * "console temporarily unavailable" instead of a false "0082 NOT APPLIED" diagnosis post-apply.
 */
import { describe, expect, it } from 'vitest';
import { getTrading, isUndefinedFunctionError } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throwsMessage?: string } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throwsMessage != null) throw new Error(opts.throwsMessage);
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const PAYLOAD = {
  config: {
    id: 1, mode: 'live',
    stake_per_buy_usd: '10.00', per_position_cap_usd: '25.00', per_market_cap_usd: '40.00',
    total_concurrent_cap_usd: '100.00', daily_loss_kill_usd: '30.00', daily_loss_kill_frac: '0.2500',
    city_allowlist: ['singapore'], active_until: '2026-07-31', updated_at: '2026-07-05T09:00:00Z',
  },
  preflight: {
    ok: false,
    reasons: ['no PASS forward paper gate'],
    checks: {
      mode: 'live', activeUntil: '2026-07-31',
      stakePerBuyUsd: '10.00', perPositionCapUsd: '25.00', perMarketCapUsd: '40.00', totalConcurrentCapUsd: '100.00',
      gatePass: false, override: true, overrideReason: 'review window', overrideExpiresAt: '2026-07-08T09:00:00Z',
      todayLossUsd: '18.00', lossWindowStart: '2026-07-05T00:00:00Z',
      dailyLossKillUsd: '30.00', dailyLossKillFracBasisUsd: '25.00',
      openExposureUsd: '20.00', perMarketExposureUsd: { '0xAAA': '12.00', '0xBBB': '8.00' },
    },
  },
  openOrders: [{ id: 'o1', market_id: '0xAAA', side: 'BUY', status: 'partial', size: '100', size_matched: '50' }],
  openExposureUsd: '20.00',
  today: { buyUsd: '20.00', sellUsd: '2.00', feeUsd: '0.00', netUsd: '-18.00', lossUsd: '18.00', lossWindowStart: '2026-07-05T00:00:00Z', nFills: 3 },
  dryRun: { openOrders: 4, total: 37 },
  recentAudit: [{ id: 3, old_value: { mode: 'dry-run' }, new_value: { mode: 'live' }, changed_at: '2026-07-05T09:00:00Z', changed_by: 'service_role' }],
  generatedAt: '2026-07-05T09:05:00Z',
};

describe('getTrading — dash_trading passthrough + null-tolerant defaults', () => {
  it('passes the full activation-console payload through as { kind: ok }', async () => {
    const load = await getTrading(stubDb(PAYLOAD));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    const v = load.view;
    expect(v.config!.mode).toBe('live');
    expect(v.preflight!.ok).toBe(false);
    expect(v.preflight!.checks.override).toBe(true);
    expect(v.preflight!.checks.perMarketExposureUsd).toEqual({ '0xAAA': '12.00', '0xBBB': '8.00' });
    expect(v.openOrders).toHaveLength(1);
    expect(v.today!.nFills).toBe(3);
    expect(v.dryRun).toEqual({ openOrders: 4, total: 37 });
    expect(v.recentAudit).toHaveLength(1);
    expect(v.generatedAt).toBe('2026-07-05T09:05:00Z');
  });

  it('defaults the collection fields when a lean payload omits them', async () => {
    // The seeded-dark applied state: config present (mode off), preflight present, but no orders/audit yet.
    const lean = {
      config: { id: 1, mode: 'off' },
      preflight: { ok: false, reasons: [], checks: { mode: 'off' } },
      generatedAt: '2026-07-05T00:00:00Z',
    };
    const load = await getTrading(stubDb(lean));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    const v = load.view;
    expect(v.openOrders).toEqual([]);
    expect(v.recentAudit).toEqual([]);
    expect(v.openExposureUsd).toBe(0);
    expect(v.today).toBeNull();
    expect(v.dryRun).toBeNull();
    expect(v.config!.mode).toBe('off');
  });
});

describe('getTrading — #22: not-applied vs RPC-error discrimination', () => {
  it("PostgREST schema-cache miss (PGRST202 spelling) → 'not-applied'", async () => {
    const load = await getTrading(
      stubDb(null, {
        throwsMessage:
          'rpc dash_trading failed: Could not find the function public.dash_trading without parameters in the schema cache',
      }),
    );
    expect(load).toEqual({ kind: 'not-applied' });
  });

  it("Postgres 42883 spelling → 'not-applied'", async () => {
    const load = await getTrading(
      stubDb(null, { throwsMessage: 'rpc dash_trading failed: function public.dash_trading() does not exist' }),
    );
    expect(load).toEqual({ kind: 'not-applied' });
  });

  it("explicit error codes (PGRST202 / 42883) → 'not-applied'", async () => {
    expect(await getTrading(stubDb(null, { throwsMessage: 'PGRST202' }))).toEqual({ kind: 'not-applied' });
    expect(await getTrading(stubDb(null, { throwsMessage: 'error 42883' }))).toEqual({ kind: 'not-applied' });
  });

  it("a transient/DB-incident failure → 'error' with the message preserved (NEVER 'not-applied')", async () => {
    const load = await getTrading(
      stubDb(null, { throwsMessage: 'rpc dash_trading failed: upstream request timeout' }),
    );
    expect(load.kind).toBe('error');
    if (load.kind !== 'error') throw new Error('expected error');
    expect(load.message).toContain('upstream request timeout');
  });

  it("an operator_guard rejection → 'error', not 'not-applied'", async () => {
    const load = await getTrading(stubDb(null, { throwsMessage: 'rpc dash_trading failed: ERR_FORBIDDEN' }));
    expect(load.kind).toBe('error');
  });

  it("an empty (null) RPC result without a throw → 'error' (an anomaly, not the staged-dark state)", async () => {
    const load = await getTrading(stubDb(null));
    expect(load.kind).toBe('error');
  });
});

describe('isUndefinedFunctionError — the #22 classifier', () => {
  it('matches the undefined-function class only', () => {
    expect(isUndefinedFunctionError('PGRST202')).toBe(true);
    expect(isUndefinedFunctionError('42883')).toBe(true);
    expect(isUndefinedFunctionError('function public.dash_trading() does not exist')).toBe(true);
    expect(
      isUndefinedFunctionError('Could not find the function public.dash_trading without parameters in the schema cache'),
    ).toBe(true);
    expect(isUndefinedFunctionError('upstream request timeout')).toBe(false);
    expect(isUndefinedFunctionError('ERR_FORBIDDEN')).toBe(false);
    // an unrelated missing function must not masquerade as the dash_trading staged-dark state
    expect(isUndefinedFunctionError('function public.some_other_fn() does not exist')).toBe(false);
  });
});
