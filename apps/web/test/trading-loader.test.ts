/**
 * getTrading (0082) — the LIVE-RAIL activation-console loader. A crafted dash_trading payload goes in; the
 * passthrough + the null-tolerant defaults come out. Pure unit test over a stubbed WebDb (no PGlite). The
 * throws-path is the day-one "0082 NOT APPLIED" state: dash_trading() does not exist on prod (migration merged
 * dark) → the RPC throws → getTrading returns null. Mirrors city-sim-loader / amsterdam-loader.
 */
import { describe, expect, it } from 'vitest';
import { getTrading } from '../src/lib/loaders.ts';
import type { WebDb } from '../src/lib/api/deps.ts';

const stubDb = (payload: unknown, opts: { throws?: boolean } = {}): WebDb => ({
  rpc: (async (fn: string) => {
    if (opts.throws) throw new Error('rpc absent');
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
  it('passes the full activation-console payload through', async () => {
    const v = (await getTrading(stubDb(PAYLOAD)))!;
    expect(v).not.toBeNull();
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
    const v = (await getTrading(stubDb(lean)))!;
    expect(v.openOrders).toEqual([]);
    expect(v.recentAudit).toEqual([]);
    expect(v.openExposureUsd).toBe(0);
    expect(v.today).toBeNull();
    expect(v.dryRun).toBeNull();
    expect(v.config!.mode).toBe('off');
  });

  it('returns null when the RPC is absent (0082 not applied → dash_trading throws)', async () => {
    expect(await getTrading(stubDb(null, { throws: true }))).toBeNull();
  });

  it('returns null on an empty (null) RPC result', async () => {
    expect(await getTrading(stubDb(null))).toBeNull();
  });
});
