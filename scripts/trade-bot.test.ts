/**
 * Daemon-wiring tests for the two §11 venue-edge follow-ups (the pure decision spine is covered in
 * scripts/lib/trade-bot-decide.test.ts). NO network — the CLOB client, executor, and ledger are fixtures:
 *
 *   §11.1  `venueSoldFor` treats a cursor-bearing / at-page-limit `getTrades` page as DEGRADED (exactly
 *          like a throw) so an incomplete page can never under-count `soldSize` and let a SELL over-sell;
 *          a normal short page reads the true SELL sum with `degraded=false`.
 *   §11.2  `refreshFill` reports `fresh=false` ONLY when a LIVE poll of a resting order THREW — the signal
 *          the decide spine uses to DEFER a kill-cancel off a possibly-stale `sizeMatched=0`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { MakerClobClientish, MakerExecutor, OrderFillPoll, OrderLedger, OrderLedgerRow, TradeAlert } from '../packages/trading/src/index.ts';
import { assemblePosition, sellHoldAlerts } from './lib/trade-bot-decide.ts';
import { refreshFill, venueSoldFor, type Daemon } from './trade-bot.ts';

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
