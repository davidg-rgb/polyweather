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

// 0099: getTrading now calls TWO RPCs — dash_trading (primary) + buy_table_live_cycles (fail-soft). The stub
// routes per function: `cycles` is the cycles RPC's payload (default: throws not-applied, the pre-0099 state).
const stubDb = (
  payload: unknown,
  opts: { throwsMessage?: string; cycles?: unknown; cyclesThrows?: string } = {},
): WebDb => ({
  rpc: (async (fn: string) => {
    if (fn === 'buy_table_live_cycles') {
      if (opts.cycles === undefined || opts.cyclesThrows != null) {
        throw new Error(opts.cyclesThrows ?? 'PGRST202: could not find the function public.buy_table_live_cycles');
      }
      return [{ [fn]: opts.cycles }];
    }
    if (opts.throwsMessage != null) throw new Error(opts.throwsMessage);
    return [{ [fn]: payload }];
  }) as WebDb['rpc'],
  getConfigRows: async () => [],
});

const CYCLES = {
  cycles: [
    { city: 'houston', targetDate: '2026-07-13', minAsk: '0.11', maxAsk: '0.34', nTicks: 41, firstAt: '2026-07-11T20:00:00+00:00', lastAt: '2026-07-12T08:10:00+00:00' },
    { city: 'houston', targetDate: '2026-07-14', minAsk: '0.16', maxAsk: '0.40', nTicks: 12, firstAt: '2026-07-12T02:00:00+00:00', lastAt: '2026-07-12T08:10:00+00:00' },
  ],
};

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
  // 0096: the BUY-TABLE lane position ledger (ANY-status rows + outcome + totals).
  buyTable: {
    rows: [
      {
        id: 'bt-1', createdAt: '2026-07-05T08:00:00Z', status: 'filled', reason: null,
        marketId: '0xCCC', tokenId: 'tok-c', tradeDate: '2026-07-05',
        city: 'karachi', cityName: 'Karachi', eventSlug: 'ev-karachi', targetDate: '2026-07-05',
        label: '34°C bucket', bucketIdx: 1, winnerIdx: 1,
        price: '0.120', size: '70.0000', sizeMatched: '70.0000', avgPrice: '0.120',
        costUsd: '8.400000', feeUsd: '0.00', outcome: 'won', resolvedPnlUsd: '61.600000',
      },
    ],
    totals: { nRows: 1, nOpen: 0, nWon: 1, nLost: 0, costUsd: '8.400000', resolvedPnlUsd: '61.600000' },
    // 0097: the operator price-range config (global cap + per-city overrides).
    priceConfig: { globalMax: 0.15, cityRanges: { karachi: { min: 0.05, max: 0.3 } } },
  },
  recentAudit: [{ id: 3, old_value: { mode: 'dry-run' }, new_value: { mode: 'live' }, changed_at: '2026-07-05T09:00:00Z', changed_by: 'service_role' }],
  generatedAt: '2026-07-05T09:05:00Z',
};

describe('getTrading — dash_trading passthrough + null-tolerant defaults', () => {
  it('passes the full activation-console payload through as { kind: ok }', async () => {
    const load = await getTrading(stubDb(PAYLOAD, { cycles: CYCLES }));
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
    // 0096: the buyTable section passes through — rows + totals intact.
    expect(v.buyTable).not.toBeNull();
    expect(v.buyTable!.rows).toHaveLength(1);
    expect(v.buyTable!.rows[0]!.outcome).toBe('won');
    expect(v.buyTable!.rows[0]!.city).toBe('karachi');
    expect(v.buyTable!.totals).toEqual({ nRows: 1, nOpen: 0, nWon: 1, nLost: 0, costUsd: '8.400000', resolvedPnlUsd: '61.600000' });
    // 0097: priceConfig passes through — global cap + the per-city override map intact.
    expect(v.buyTable!.priceConfig).toEqual({ globalMax: 0.15, cityRanges: { karachi: { min: 0.05, max: 0.3 } } });
    // 0099: liveCycles is merged in from the SEPARATE buy_table_live_cycles() RPC, order preserved.
    expect(v.buyTable!.liveCycles).toHaveLength(2);
    expect(v.buyTable!.liveCycles![0]).toMatchObject({ city: 'houston', targetDate: '2026-07-13', minAsk: '0.11', maxAsk: '0.34' });
  });

  it('0099: an absent buy_table_live_cycles (pre-0099 DB) → liveCycles null; the console is untouched', async () => {
    const load = await getTrading(stubDb(PAYLOAD)); // cycles RPC throws PGRST202 by default
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable).not.toBeNull();
    expect(load.view.buyTable!.priceConfig).not.toBeNull(); // the 0097 editor still renders
    expect(load.view.buyTable!.liveCycles).toBeNull(); // the panel hides its cycle columns + notes it
  });

  it('0099: a FAILING cycles read (timeout/transient) degrades to liveCycles null — NEVER the console error state', async () => {
    // The 0098 incident contract: the cycles read blowing the 8s statement timeout must not take /trading down.
    const load = await getTrading(
      stubDb(PAYLOAD, { cyclesThrows: 'rpc buy_table_live_cycles failed: canceling statement due to statement timeout' }),
    );
    expect(load.kind).toBe('ok'); // the console renders in full
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable!.rows).toHaveLength(1);
    expect(load.view.buyTable!.liveCycles).toBeNull();
  });

  it('0099: a shapeless cycles envelope (no cycles array) → liveCycles null, never a throw', async () => {
    const load = await getTrading(stubDb(PAYLOAD, { cycles: { unexpected: true } }));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable!.liveCycles).toBeNull();
  });

  it('0097: a pre-0097 buyTable (no priceConfig key) → priceConfig null (staged-dark, never a throw)', async () => {
    const { priceConfig: _omitted, ...pre0097BuyTable } = PAYLOAD.buyTable;
    const load = await getTrading(stubDb({ ...PAYLOAD, buyTable: pre0097BuyTable }));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable).not.toBeNull();
    expect(load.view.buyTable!.rows).toHaveLength(1); // the 0096 ledger still renders
    expect(load.view.buyTable!.priceConfig).toBeNull(); // the panel shows its "0097 not applied" note
  });

  it('0096: a pre-0096 payload (no buyTable key) → buyTable null (the staged-dark degradation, never a throw)', async () => {
    const { buyTable: _omitted, ...pre0096 } = PAYLOAD;
    const load = await getTrading(stubDb(pre0096));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable).toBeNull();
  });

  it('0096: a lean buyTable envelope gets null-tolerant inner defaults (rows [] / totals null / priceConfig null / liveCycles null)', async () => {
    const load = await getTrading(stubDb({ ...PAYLOAD, buyTable: {} }));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable).toEqual({ rows: [], totals: null, priceConfig: null, liveCycles: null });
  });

  it('0099: cycles succeeding while buyTable is ABSENT (pre-0096) still yields buyTable null', async () => {
    const { buyTable: _omitted, ...pre0096 } = PAYLOAD;
    const load = await getTrading(stubDb(pre0096, { cycles: CYCLES }));
    expect(load.kind).toBe('ok');
    if (load.kind !== 'ok') throw new Error('expected ok');
    expect(load.view.buyTable).toBeNull(); // no ledger section to hang the columns on
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
    expect(v.buyTable).toBeNull(); // 0096: absent key degrades to null
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
