/**
 * Daemon-wiring tests (the pure decision spine is covered in scripts/lib/trade-bot-decide.test.ts).
 * NO network — the CLOB client, executor, ledger, and DB are fixtures:
 *
 *   §11.1  `venueSoldFor` treats a cursor-bearing / at-page-limit `getTrades` page as DEGRADED (exactly
 *          like a throw) so an incomplete page can never under-count `soldSize` and let a SELL over-sell;
 *          a normal short page reads the true SELL sum with `degraded=false`.
 *   §11.2  `refreshFill` reports `fresh=false` ONLY when a LIVE poll of a resting order THREW — the signal
 *          the decide spine uses to DEFER a kill-cancel off a possibly-stale `sizeMatched=0`.
 *   #4/#5/#9  position identity is LEDGER-keyed: `buildEventMeta` indexes EVERY identity bucket (argmax-
 *          free) and `reconstructPositions` enumerates the ledger's open entries — an argmax drift or an
 *          unseeded/absent capture never orphans an open position from exit management.
 *   #13/#14/#24  a failed capture-discovery read degrades the tick honestly (positions retained from the
 *          ledger, degraded heartbeat, one alert) instead of silently emptying the position set.
 *   #15    a failed preflight READ holds (no venue-side cancel) and escalates after N consecutive ticks;
 *          only a REAL negative verdict cancels resting entries.
 *   #26    `resolveTickSec` clamps negative/sub-second tick intervals to the MIN_TICK_SEC floor.
 */
import { describe, expect, it, vi } from 'vitest';
import { orderIntentKey } from '../packages/trading/src/index.ts';
import type { MakerClobClientish, MakerExecutor, OrderFillPoll, OrderLedger, OrderLedgerRow, TradeAlert, TradeMode } from '../packages/trading/src/index.ts';
import type { RawCaptureRow } from '../packages/core/src/index.ts';
import { assemblePosition, decideTick, metaDegradedAlert, sellHoldAlerts, toDecideCfg } from './lib/trade-bot-decide.ts';
import { makerExitCfg } from '../packages/core/src/index.ts';
import {
  buildEventMeta,
  MIN_TICK_SEC,
  PREFLIGHT_READ_FAIL_ESCALATE_AFTER,
  makeTickRuntime,
  preflightReadFailedAlert,
  reconstructPositions,
  refreshFill,
  resolveTickSec,
  tick,
  venueSoldFor,
  type Daemon,
} from './trade-bot.ts';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────
// OUR taker-perspective SELL (an FAK stop/time-stop fill): top-level side/size ARE ours.
const sell = (size: number, status = 'CONFIRMED') => ({ price: '0.2', side: 'SELL', size: String(size), asset_id: 'tokA', status, trader_side: 'TAKER', taker_order_id: '0xT', maker_orders: [] });
// a maker-perspective trade (the venue record is TAKER-centric: top-level side = the TAKER's; our fill is a leg).
const makerTrade = (
  takerSide: 'BUY' | 'SELL',
  legs: Array<{ side: 'BUY' | 'SELL'; size: number; addr?: string; orderId?: string; tokenId?: string }>,
  takerSize = 50,
) => ({
  price: '0.2',
  side: takerSide,
  size: String(takerSize),
  asset_id: 'tokA',
  status: 'CONFIRMED',
  trader_side: 'MAKER',
  taker_order_id: '0xT',
  maker_orders: legs.map((l, i) => ({ order_id: l.orderId ?? `0xM${i}`, side: l.side, price: '0.2', matched_amount: String(l.size), maker_address: l.addr ?? '0xUS', asset_id: l.tokenId ?? 'tokA' })),
});

function daemon(over: Partial<Daemon> = {}): { d: Daemon; alerts: TradeAlert[] } {
  const alerts: TradeAlert[] = [];
  const notify = async (a: TradeAlert): Promise<boolean> => (alerts.push(a), true);
  const d: Daemon = {
    mode: 'live',
    db: {} as Daemon['db'],
    ledger: {} as OrderLedger,
    executor: {} as MakerExecutor,
    client: {} as MakerClobClientish,
    notify,
    address: '0xUS',
    warnedDust: new Set(),
    ...over,
  };
  return { d, alerts };
}

const clientWithTrades = (getTrades: (p?: unknown) => Promise<unknown>): MakerClobClientish =>
  ({ getTrades } as unknown as MakerClobClientish);

const row = (over: Partial<OrderLedgerRow> = {}): OrderLedgerRow => ({
  mode: 'live',
  intentKey: 'm1|BUY|entry|2026-07-06',
  clientOrderId: 'c1',
  status: 'placed',
  orderId: 'v1',
  side: 'BUY',
  purpose: 'entry',
  price: 0.14,
  size: 66,
  sizeMatched: 0,
  tokenId: 'tokA',
  marketId: 'm1',
  createdAt: '2026-07-06T05:00:00Z',
  ...over,
});

// ── §11.1 — venueSoldFor: truncation degrades exactly like a throw ────────────────────────────────────
describe('venueSoldFor — §11.1 truncation is degraded (over-sell backstop)', () => {
  it('a normal short page sums our SELL fills with degraded=false (BUYs + FAILED SELLs excluded)', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => [sell(40), { ...sell(5), side: 'BUY' }, sell(9, 'FAILED')]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: 40, degraded: false });
  });

  it('short page → { sold: <SELL sum>, degraded: false }', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => [sell(40), sell(26)]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: 66, degraded: false });
  });

  it('a cursor-bearing page (more pages) → { sold: null, degraded: true } (identical to a throw)', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => ({ next_cursor: 'MTAw', data: [sell(40)] })) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: null, degraded: true });
  });

  it('an at-page-limit page (100 rows) → degraded (conservative: could be a truncated first page)', async () => {
    const full = Array.from({ length: 100 }, () => sell(1));
    const { d } = daemon({ client: clientWithTrades(async () => full) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: null, degraded: true });
  });

  it('a getTrades THROW → degraded (the pre-existing outage path, unchanged)', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => { throw new Error('CLOB 503'); }) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: null, degraded: true });
  });

  it('dry-run never reads the venue → { sold: null, degraded: false }', async () => {
    const spy = vi.fn(async () => [sell(40)]);
    const { d } = daemon({ mode: 'dry-run', client: clientWithTrades(spy) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: null, degraded: false });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── VENUE TAKER-CENTRIC SEMANTICS — the CRITICAL side-inversion falsifiers ────────────────────────────
describe('venueSoldFor — taker-centric trade records (trader_side + maker_orders resolve OUR side/size)', () => {
  it('FALSIFIER: our filled maker BUY entry (top-level side=SELL — the taker sold into our bid) counts ZERO sold — the position must NOT be marked flattened', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => [makerTrade('SELL', [{ side: 'BUY', size: 20 }], 20)]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: 0, degraded: false });
  });

  it('FALSIFIER: our maker TP SELL lifted by a taker BUY (top-level side=BUY) IS counted — at the LEG matched_amount, not the taker total', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => [makerTrade('BUY', [{ side: 'SELL', size: 12 }], 50)]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: 12, degraded: false });
  });

  it('mixed history: maker entry fill + maker TP fill + taker FAK sell sum to exactly OUR sells', async () => {
    const { d } = daemon({
      client: clientWithTrades(async () => [
        makerTrade('SELL', [{ side: 'BUY', size: 20 }], 20), // entry fill — not sold
        makerTrade('BUY', [{ side: 'SELL', size: 12 }], 40), // TP fill — sold 12
        sell(6), // taker stop remainder — sold 6
      ]),
    });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: 18, degraded: false });
  });

  it("a SIBLING maker's SELL leg in the same taker order (different maker_address) is NOT ours", async () => {
    const { d } = daemon({ client: clientWithTrades(async () => [makerTrade('BUY', [{ side: 'SELL', size: 12 }, { side: 'SELL', size: 40, addr: '0xTHEM' }], 52)]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: 12, degraded: false });
  });

  it('secondary attribution: a known SELL order id counts even when addresses are unavailable', async () => {
    const { d } = daemon({ address: null, client: clientWithTrades(async () => [makerTrade('BUY', [{ side: 'SELL', size: 12, addr: '', orderId: '0xTP' }])]) });
    expect(await venueSoldFor(d, 'tokA', new Set(['0xTP']))).toEqual({ sold: 12, degraded: false });
  });

  it('an UNATTRIBUTABLE maker SELL leg degrades the read (hold sells) — never guessed in either direction', async () => {
    const { d } = daemon({ address: null, client: clientWithTrades(async () => [makerTrade('BUY', [{ side: 'SELL', size: 12, addr: '' }])]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: null, degraded: true });
  });

  it('a trades page missing trader_side (shape drift) degrades via the fail-loud parse — never silently inverted', async () => {
    const { d } = daemon({ client: clientWithTrades(async () => [{ price: '0.2', side: 'SELL', size: '20', asset_id: 'tokA', status: 'CONFIRMED' }]) });
    expect(await venueSoldFor(d, 'tokA')).toEqual({ sold: null, degraded: true });
  });

  it('END-TO-END: a truncated page drives the SAME hold + CRITICAL path as a throw; a short page does NOT', async () => {
    const meta = { marketId: 'm1', tokenId: 'tokA', city: 'amsterdam', targetDate: '2026-07-06', tz: 'Europe/Amsterdam', modelProb: 0.3, resolvesAtMs: 1 };
    const entry = row({ status: 'filled', sizeMatched: 66 });

    for (const trunc of [async () => ({ next_cursor: 'abc', data: [] }), async () => { throw new Error('down'); }]) {
      const { d } = daemon({ client: clientWithTrades(trunc) });
      const vs = await venueSoldFor(d, 'tokA');
      const pos = assemblePosition({ meta, entry, tp: null, stopLoss: null, timeStop: null, mark: 0.05, venueSoldSize: vs.sold, soldTruthDegraded: vs.degraded })!;
      expect(pos.soldTruthDegraded).toBe(true);
      const held = sellHoldAlerts([pos]);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ kind: 'TRADE_BOT_SELL_HOLD', severity: 'CRITICAL' });
    }

    const { d } = daemon({ client: clientWithTrades(async () => [sell(40)]) });
    const vs = await venueSoldFor(d, 'tokA');
    const pos = assemblePosition({ meta, entry, tp: null, stopLoss: null, timeStop: null, mark: 0.05, venueSoldSize: vs.sold, soldTruthDegraded: vs.degraded })!;
    expect(pos.soldTruthDegraded).toBe(false);
    expect(sellHoldAlerts([pos])).toHaveLength(0); // healthy read → sells run
  });
});

// ── §11.2 — refreshFill: fresh=false ONLY when a live poll of a resting order threw ───────────────────
describe('refreshFill — §11.2 entry-poll freshness signal', () => {
  const poll = (over: Partial<OrderFillPoll> = {}): OrderFillPoll => ({ orderId: 'v1', status: 'live', originalSize: 66, sizeMatched: 0, avgPrice: null, filled: false, partial: false, resting: true, ...over });
  const executorWith = (pollFill: (id: string, size?: number) => Promise<OrderFillPoll>): MakerExecutor => ({ pollFill } as unknown as MakerExecutor);
  const ledgerReturning = (r: OrderLedgerRow, recordFill = vi.fn(async () => {})): OrderLedger =>
    ({ recordFill, findByIntentKey: async () => r } as unknown as OrderLedger);

  it('dry-run: no poll, fresh=true', async () => {
    const spy = vi.fn();
    const { d } = daemon({ mode: 'dry-run', executor: executorWith(spy as never) });
    const res = await refreshFill(d, row());
    expect(res.fresh).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('live, no orderId (dangling intent): no poll, fresh=true (reconcile owns it)', async () => {
    const spy = vi.fn();
    const { d } = daemon({ executor: executorWith(spy as never) });
    const res = await refreshFill(d, row({ orderId: null, status: 'intent' }));
    expect(res.fresh).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('live, terminal status: no poll, fresh=true', async () => {
    const spy = vi.fn();
    const { d } = daemon({ executor: executorWith(spy as never) });
    const res = await refreshFill(d, row({ status: 'filled', sizeMatched: 66 }));
    expect(res.fresh).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('live, resting, poll SUCCEEDS with no new fill: fresh=true (the 0-matched state is CONFIRMED)', async () => {
    const { d } = daemon({ executor: executorWith(async () => poll({ sizeMatched: 0 })) });
    const res = await refreshFill(d, row());
    expect(res.fresh).toBe(true);
    expect(res.row!.sizeMatched).toBe(0);
  });

  it('live, resting, poll SUCCEEDS with a NEW fill: records it and returns the refreshed row, fresh=true', async () => {
    const refreshed = row({ status: 'partial', sizeMatched: 30 });
    const recordFill = vi.fn(async () => {});
    const { d } = daemon({ executor: executorWith(async () => poll({ sizeMatched: 30, partial: true })), ledger: ledgerReturning(refreshed, recordFill) });
    const res = await refreshFill(d, row());
    expect(recordFill).toHaveBeenCalledOnce();
    expect(res.fresh).toBe(true);
    expect(res.row!.sizeMatched).toBe(30);
  });

  it('live, resting, poll THROWS: fresh=FALSE + a CRITICAL needs-reconcile alert fires', async () => {
    const { d, alerts } = daemon({ executor: executorWith(async () => { throw new Error('getOrder 500'); }) });
    const res = await refreshFill(d, row());
    expect(res.fresh).toBe(false); // the §11.2 signal — the decide spine will DEFER the kill-cancel
    expect(res.row!.sizeMatched).toBe(0); // the stale ledger value is returned (NOT trusted for a cancel)
    expect(alerts.some((a) => a.severity === 'CRITICAL' && a.kind === 'ORDER_NEEDS_RECONCILE')).toBe(true);
  });
});

// ── findings #4/#5/#9 — LEDGER-keyed position identity ──────────────────────────────────────────────

const bucketFix = (over: Record<string, unknown> = {}) => ({
  idx: 5, label: '20-21C', loF: 20, hiF: 21, mid: 0.14, bestAsk: 0.16, execAsk: 0.15, depthUsd: 300,
  bestBid: 0.12, sellbackUsd: 5, execBid: 0.12, sellbackDepthUsd: 200, houseProb: 0.28,
  tokenYes: 'tokA', tokenNo: 'tokA2', conditionId: 'mA', ...over,
});
const rawFix = (buckets: Record<string, unknown>[], over: Record<string, unknown> = {}): RawCaptureRow =>
  ({
    eventId: 'e1', capturedAt: '2026-07-06T05:59:00Z', city: 'amsterdam', targetDate: '2026-07-06',
    tzName: 'Europe/Amsterdam', createdAtGamma: '2026-07-06T05:30:00Z', resolvesAt: '2026-07-06T20:00:00Z',
    hoursSinceListing: 0.5, peakMid: 0.14, isFlatOpen: true, houseSeeded: true, buckets, evVol24h: 9000,
    negRisk: true, ...over,
  } as unknown as RawCaptureRow);

const ENTRY_KEY = orderIntentKey({ marketId: 'mA', side: 'BUY', purpose: 'entry', tradeDate: '2026-07-06' });
const entryRow = (mode: TradeMode = 'dry-run', over: Partial<OrderLedgerRow> = {}): OrderLedgerRow => ({
  mode, intentKey: ENTRY_KEY, clientOrderId: 'cA', status: 'filled', orderId: 'vA', side: 'BUY',
  purpose: 'entry', price: 0.15, size: 66, sizeMatched: 66, tokenId: 'tokA', marketId: 'mA',
  createdAt: '2026-07-01T00:00:00Z', ...over,
});
const ledgerOf = (rows: OrderLedgerRow[]): OrderLedger =>
  ({
    findByIntentKey: async (key: string, mode: TradeMode) =>
      rows.find((r) => r.intentKey === key && r.mode === mode && r.status !== 'canceled' && r.status !== 'failed') ?? null,
  } as unknown as OrderLedger);

const OPEN_A = { marketId: 'mA', tokenId: 'tokA', tradeDate: '2026-07-06' };
const DECIDE_CFG = toDecideCfg(makerExitCfg(['amsterdam']), 5);
const TRADE_CONFIG = {
  mode: 'live' as const, stakePerBuyUsd: 10, perPositionCapUsd: 25, perMarketCapUsd: 40,
  totalConcurrentCapUsd: 100, dailyLossKillUsd: 30, dailyLossKillFrac: 0.25, cityAllowlist: null,
  activeUntil: '2026-12-31',
};

describe('buildEventMeta — every identity bucket, argmax-free (findings #4/#5/#9)', () => {
  it('indexes EVERY bucket with venue identity, not just the argmax', () => {
    const meta = buildEventMeta([rawFix([bucketFix(), bucketFix({ idx: 6, conditionId: 'mB', tokenYes: 'tokB', houseProb: 0.31 })])]);
    expect([...meta.keys()].sort()).toEqual(['mA', 'mB']);
    expect(meta.get('mA')).toMatchObject({ tokenId: 'tokA', modelProb: 0.28, city: 'amsterdam' });
    expect(meta.get('mB')).toMatchObject({ tokenId: 'tokB', modelProb: 0.31 });
  });

  it('an UNSEEDED capture (houseProb null everywhere, the designed seed-outage shape) still carries identity + clock', () => {
    const meta = buildEventMeta([rawFix([bucketFix({ houseProb: null })], { houseSeeded: false })]);
    expect(meta.get('mA')).toMatchObject({ modelProb: null, tokenId: 'tokA' });
    expect(meta.get('mA')!.resolvesAtMs).toBe(Date.parse('2026-07-06T20:00:00Z'));
  });

  it('skips identity-less buckets (pre-0083 rows) and keys off the LATEST capture per event', () => {
    const older = rawFix([bucketFix({ houseProb: 0.9 })], { capturedAt: '2026-07-06T05:00:00Z' });
    const latest = rawFix(
      [bucketFix({ houseProb: 0.25 }), bucketFix({ idx: 7, conditionId: null, tokenYes: null })],
      { capturedAt: '2026-07-06T06:30:00Z' },
    );
    const meta = buildEventMeta([older, latest]);
    expect(meta.size).toBe(1);
    expect(meta.get('mA')!.modelProb).toBe(0.25); // the latest tick's value, junk bucket skipped
  });
});

describe('reconstructPositions — a position is managed by ITS OWN ledger identity (findings #4/#5/#9)', () => {
  it('(a) FALSIFYING: the argmax bucket SHIFTS after entry → the old position still gets time-stop planning against its own token', async () => {
    // latest capture: the forecast center has MOVED to mB (0.31 > 0.28). The old code keyed positions off
    // the argmax and silently dropped the open mA position from all exit management.
    const captures = [rawFix([bucketFix({ houseProb: 0.28 }), bucketFix({ idx: 6, conditionId: 'mB', tokenYes: 'tokB', houseProb: 0.31 })])];
    const { d } = daemon({ mode: 'dry-run', ledger: ledgerOf([entryRow()]) });
    const positions = await reconstructPositions(d, [OPEN_A], buildEventMeta(captures));
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ marketId: 'mA', tokenId: 'tokA', metaDegraded: false, filledSize: 66 });
    expect(positions[0]!.resolvesAtMs).toBe(Date.parse('2026-07-06T20:00:00Z'));

    // now = past resolvesAt−18h ⇒ the time-stop FIRES for mA, sized to its own remainder
    const now = new Date('2026-07-06T04:00:00Z');
    const plan = decideTick({ mode: 'dry-run', config: TRADE_CONFIG, preflight: null, cfg: DECIDE_CFG, now, candidates: [], positions });
    const ex = plan.intents.find((i) => i.kind === 'exit_taker');
    expect(ex).toMatchObject({ purpose: 'time_stop', req: { marketId: 'mA', tokenId: 'tokA', size: 66 } });
  });

  it('(b) FALSIFYING: an UNSEEDED capture tick → the position is retained and the time-stop still evaluated', async () => {
    const captures = [rawFix([bucketFix({ houseProb: null }), bucketFix({ idx: 6, conditionId: 'mB', tokenYes: 'tokB', houseProb: null })], { houseSeeded: false })];
    const { d } = daemon({ mode: 'dry-run', ledger: ledgerOf([entryRow()]) });
    const positions = await reconstructPositions(d, [OPEN_A], buildEventMeta(captures));
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ marketId: 'mA', metaDegraded: false, modelProb: null });

    const now = new Date('2026-07-06T04:00:00Z'); // past the resolvesAt−18h clock carried by the unseeded capture
    const plan = decideTick({ mode: 'dry-run', config: TRADE_CONFIG, preflight: null, cfg: DECIDE_CFG, now, candidates: [], positions });
    expect(plan.intents.some((i) => i.kind === 'exit_taker' && i.purpose === 'time_stop')).toBe(true);
  });

  it('(c) captures EMPTY (discovery outage / aged window): the position is RETAINED metaDegraded — never dropped', async () => {
    const { d } = daemon({ mode: 'dry-run', ledger: ledgerOf([entryRow()]) });
    const positions = await reconstructPositions(d, [OPEN_A], buildEventMeta([]));
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ marketId: 'mA', tokenId: 'tokA', metaDegraded: true, modelProb: null });
    expect(metaDegradedAlert(positions)).toMatchObject({ kind: 'TRADE_BOT_META_DEGRADED', severity: 'WARN' });
  });

  it('the LEDGER token identity wins over capture meta (its OWN token for its whole life)', async () => {
    const captures = [rawFix([bucketFix({ tokenYes: 'tokDRIFTED' })])];
    const { d } = daemon({ mode: 'dry-run', ledger: ledgerOf([entryRow()]) });
    const positions = await reconstructPositions(d, [OPEN_A], buildEventMeta(captures));
    expect(positions[0]!.tokenId).toBe('tokA'); // the entry row's token, not the capture's
  });

  it('a raced-terminal entry (open list stale) is skipped without throwing', async () => {
    const { d } = daemon({ mode: 'dry-run', ledger: ledgerOf([]) }); // by_intent finds nothing open
    const positions = await reconstructPositions(d, [OPEN_A], buildEventMeta([]));
    expect(positions).toHaveLength(0);
  });
});

// ── tick-level failure paths (findings #13/#14/#24 + #15) ───────────────────────────────────────────

interface DbScript {
  discovery: 'throw' | 'empty' | 'shapeless';
  preflight: 'ok' | 'kill' | 'throw';
}

function makeDb(script: DbScript, heartbeats: Array<Record<string, unknown>>, open: Array<{ marketId: string; tokenId: string; tradeDate: string }>): Daemon['db'] {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'trade_config_get') {
        return [{ trade_config_get: { config: { mode: 'live', stake_per_buy_usd: 10, per_position_cap_usd: 25, per_market_cap_usd: 40, total_concurrent_cap_usd: 100, daily_loss_kill_usd: 30, daily_loss_kill_frac: 0.25, city_allowlist: null, active_until: '2026-12-31' } } }];
      }
      if (fn === 'convergence_capture_inputs') {
        if (script.discovery === 'throw') throw new Error('canceling statement due to statement timeout');
        if (script.discovery === 'shapeless') return [{ convergence_capture_inputs: null }];
        return [{ convergence_capture_inputs: { captures: [], resolutions: [] } }];
      }
      if (fn === 'record_bot_tick') {
        heartbeats.push((args as { p_payload: Record<string, unknown> }).p_payload);
        return [{ record_bot_tick: 1 }];
      }
      if (fn === 'trade_live_preflight') {
        if (script.preflight === 'throw') throw new Error('canceling statement due to statement timeout');
        const ok = script.preflight !== 'kill';
        return [{ trade_live_preflight: { ok, reasons: ok ? [] : ['daily-loss kill tripped'], checks: {} } }];
      }
      throw new Error(`unexpected rpc: ${fn}`);
    },
    getConfigRows: async () => [],
    listOpenEntryRows: async () => open,
  } as unknown as Daemon['db'];
}

function makeExecutor(mode: TradeMode): MakerExecutor & { place: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; reprice: ReturnType<typeof vi.fn> } {
  const result = (req: { side?: string; purpose?: string; targetPrice?: number; size?: number }) => ({
    mode, status: mode === 'live' ? 'placed' : 'dry_run', intentKey: 'k', clientOrderId: 'c',
    orderId: mode === 'live' ? 'v' : null, side: req.side ?? 'BUY', purpose: req.purpose ?? 'entry',
    orderType: 'GTC', postOnly: true, limitPrice: req.targetPrice ?? 0, size: req.size ?? 0, sizeMatched: 0,
  });
  return {
    mode,
    place: vi.fn(async (req: never) => result(req)),
    placeTaker: vi.fn(async (req: never) => result(req)),
    reprice: vi.fn(async () => { throw new Error('reprice must not be reached in these fixtures'); }),
    cancel: vi.fn(async (orderId: string) => ({ requested: [orderId], canceled: [orderId], notCanceled: {}, allCanceled: true })),
    pollFill: vi.fn(async (orderId: string, size: number) => ({ orderId, status: 'live', originalSize: size, sizeMatched: 0, avgPrice: null, filled: false, partial: false, resting: true })),
  } as unknown as MakerExecutor & { place: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; reprice: ReturnType<typeof vi.fn> };
}

describe('tick — a failed discovery read degrades honestly, positions retained from the LEDGER (findings #13/#14/#24)', () => {
  it('DRY-RUN: discovery throws → the position is still TP-managed, the heartbeat says degraded, Slack stays silent', async () => {
    const heartbeats: Array<Record<string, unknown>> = [];
    const executor = makeExecutor('dry-run');
    const { d, alerts } = daemon({
      mode: 'dry-run',
      db: makeDb({ discovery: 'throw', preflight: 'ok' }, heartbeats, [OPEN_A]),
      ledger: ledgerOf([entryRow('dry-run')]),
      executor,
    });
    await tick(d, ['amsterdam'], 5, makeTickRuntime());

    // the position was NOT dropped: its TP rest was planned + executed on the degraded tick
    expect(executor.place).toHaveBeenCalledTimes(1);
    expect((executor.place.mock.calls[0]![0] as { purpose: string; marketId: string })).toMatchObject({ purpose: 'take_profit', marketId: 'mA' });
    // the tick is marked degraded in the heartbeat (payload field + the gate_reason marker)
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]).toMatchObject({ degraded: true });
    expect(String(heartbeats[0]!['gateReason'])).toContain('[DEGRADED');
    // dry-run: nothing rests at the venue → the alert channel stays silent (logged locally instead)
    expect(alerts).toHaveLength(0);
  });

  it('LIVE: discovery throws → ONE WARN alert fires (discovery degraded) + the meta-degraded WARN naming the position', async () => {
    const heartbeats: Array<Record<string, unknown>> = [];
    const executor = makeExecutor('live');
    const client = { getTrades: async () => [], getOrderBook: async () => { throw new Error('no book'); } } as unknown as MakerClobClientish;
    const { d, alerts } = daemon({
      mode: 'live',
      db: makeDb({ discovery: 'throw', preflight: 'ok' }, heartbeats, [OPEN_A]),
      ledger: ledgerOf([entryRow('live')]),
      executor,
      client,
    });
    await tick(d, ['amsterdam'], 5, makeTickRuntime());

    expect(alerts.some((a) => a.kind === 'TRADE_BOT_DISCOVERY_DEGRADED' && a.severity === 'WARN')).toBe(true);
    expect(alerts.some((a) => a.kind === 'TRADE_BOT_META_DEGRADED' && a.body.includes('mA'))).toBe(true);
    expect(executor.place).toHaveBeenCalledTimes(1); // the TP rest still ran — management never suspended
    expect(heartbeats[0]).toMatchObject({ degraded: true });
  });

  it('a SHAPELESS discovery envelope (version skew / SQL NULL) is treated as a failed read, not an empty universe', async () => {
    const heartbeats: Array<Record<string, unknown>> = [];
    const { d, alerts } = daemon({
      mode: 'dry-run',
      db: makeDb({ discovery: 'shapeless', preflight: 'ok' }, heartbeats, []),
      ledger: ledgerOf([]),
      executor: makeExecutor('dry-run'),
    });
    await tick(d, ['amsterdam'], 5, makeTickRuntime());
    expect(heartbeats[0]).toMatchObject({ degraded: true });
    expect(alerts).toHaveLength(0); // dry-run silence
  });

  it('a HEALTHY tick is not marked degraded', async () => {
    const heartbeats: Array<Record<string, unknown>> = [];
    const { d } = daemon({
      mode: 'dry-run',
      db: makeDb({ discovery: 'empty', preflight: 'ok' }, heartbeats, []),
      ledger: ledgerOf([]),
      executor: makeExecutor('dry-run'),
    });
    await tick(d, ['amsterdam'], 5, makeTickRuntime());
    expect(heartbeats[0]).toMatchObject({ degraded: false });
    expect(String(heartbeats[0]!['gateReason'])).not.toContain('[DEGRADED');
  });
});

describe('tick — a failed preflight READ holds and escalates; only a REAL kill cancels (finding #15)', () => {
  const restingEntry = () => entryRow('live', { status: 'placed', sizeMatched: 0 }); // resting since 2026-07-01 (way past the maker window)

  it('read failure ticks: NO venue-side cancel, WARN-only until the escalation threshold, CRITICAL at it; a real kill then cancels', async () => {
    const heartbeats: Array<Record<string, unknown>> = [];
    const script: DbScript = { discovery: 'empty', preflight: 'throw' };
    const executor = makeExecutor('live');
    const client = { getTrades: async () => [], getOrderBook: async () => { throw new Error('no book'); } } as unknown as MakerClobClientish;
    const { d, alerts } = daemon({
      mode: 'live',
      db: makeDb(script, heartbeats, [OPEN_A]),
      ledger: ledgerOf([restingEntry()]),
      executor,
      client,
    });
    const runtime = makeTickRuntime();

    for (let i = 1; i < PREFLIGHT_READ_FAIL_ESCALATE_AFTER; i++) {
      await tick(d, ['amsterdam'], 5, runtime);
      expect(executor.cancel).not.toHaveBeenCalled(); // a DB blip never cancels at the venue
      expect(alerts.some((a) => a.kind === 'TRADE_BOT_PREFLIGHT_READ_FAILED')).toBe(false); // below the threshold
    }
    await tick(d, ['amsterdam'], 5, runtime); // the Nth consecutive failure
    expect(executor.cancel).not.toHaveBeenCalled();
    expect(alerts.some((a) => a.kind === 'TRADE_BOT_PREFLIGHT_READ_FAILED' && a.severity === 'CRITICAL')).toBe(true);
    expect(runtime.preflightReadFailures).toBe(PREFLIGHT_READ_FAIL_ESCALATE_AFTER);
    expect(heartbeats.at(-1)).toMatchObject({ degraded: true }); // the read-failure tick is marked degraded

    // recovery resets the consecutive counter
    script.preflight = 'ok';
    await tick(d, ['amsterdam'], 5, runtime);
    expect(runtime.preflightReadFailures).toBe(0);
    expect(executor.cancel).not.toHaveBeenCalled(); // preflight PASSes — nothing to cancel

    // a REAL negative verdict (successful read) DOES cancel the fully-unfilled resting entry
    script.preflight = 'kill';
    await tick(d, ['amsterdam'], 5, runtime);
    expect(executor.cancel).toHaveBeenCalledTimes(1);
    expect(executor.cancel.mock.calls[0]![0]).toBe('vA');
  });
});

// ── finding #26 — tick-interval clamp ───────────────────────────────────────────────────────────────
describe('resolveTickSec (finding #26)', () => {
  it('clamps a negative TRADE_TICK_SEC to the floor (the hot-spin guard)', () => {
    expect(resolveTickSec('-30', 30)).toEqual({ tickSec: MIN_TICK_SEC, clamped: true });
  });
  it('clamps a sub-second value', () => {
    expect(resolveTickSec('0.01', 30)).toEqual({ tickSec: MIN_TICK_SEC, clamped: true });
  });
  it('clamps a sub-floor CONFIG value too (the env-less path)', () => {
    expect(resolveTickSec(undefined, -10)).toEqual({ tickSec: MIN_TICK_SEC, clamped: true });
    expect(resolveTickSec(undefined, 2)).toEqual({ tickSec: MIN_TICK_SEC, clamped: true });
  });
  it('passes a sane env value through unclamped', () => {
    expect(resolveTickSec('60', 30)).toEqual({ tickSec: 60, clamped: false });
    expect(resolveTickSec(undefined, 30)).toEqual({ tickSec: 30, clamped: false });
  });
  it('NaN / empty fall back to the 30s default (pre-existing semantics), never clamped', () => {
    expect(resolveTickSec('abc', 30)).toEqual({ tickSec: 30, clamped: false });
    expect(resolveTickSec('', 30)).toEqual({ tickSec: 30, clamped: false });
  });
});

describe('preflightReadFailedAlert — the consecutive-failure escalation (finding #15)', () => {
  it('stays null below the threshold', () => {
    for (let i = 0; i < PREFLIGHT_READ_FAIL_ESCALATE_AFTER; i++) expect(preflightReadFailedAlert(i)).toBeNull();
  });
  it('escalates CRITICAL at and beyond the threshold', () => {
    expect(preflightReadFailedAlert(PREFLIGHT_READ_FAIL_ESCALATE_AFTER)).toMatchObject({ kind: 'TRADE_BOT_PREFLIGHT_READ_FAILED', severity: 'CRITICAL' });
    expect(preflightReadFailedAlert(PREFLIGHT_READ_FAIL_ESCALATE_AFTER + 5)).toMatchObject({ severity: 'CRITICAL' });
  });
});
