/**
 * LiveExecutor — the real order path, DORMANT (ARCHITECTURE.md §6.20, F-032).
 *
 * Compiled + unit-tested against mocks from day one; constructible only behind
 * a passing goLiveGate (execute-bet enforces that — C1). The clob client and
 * POLY_PRIVATE_KEY live ONLY in this file (§15 grep invariant); production
 * constructs the client via dynamic npm: specifiers (Deno edge runtime),
 * tests inject a mock factory.
 *
 * Phase A semantics: GTC limit at the recommendation's executable ask
 * (taker-or-better); the maker-resting strategy is a §12 Phase-5 enhancement.
 * getOrder's response fields are mock-verified only — re-verify against the
 * live CLOB at P10 go-live (docs/GO-LIVE-CHECKLIST).
 */
import { ExecutionError, FillRejected } from '@weather-edge/core';
import {
  makerLimitPrice,
  orderIntentKey,
  parseCancelResult,
  parseOpenOrders,
  parseOrderBookTop,
  parseOrderFillPoll,
  redactOrderPayload,
  resolveTradeMode,
  takerLimitPrice,
} from './order-intent.ts';
import { rpcOrderLedger } from './order-ledger.ts';
import type {
  ApprovedBet,
  CancelResult,
  FillResult,
  FillRpcResult,
  MakerOrderRequest,
  OpenOrder,
  OrderFillPoll,
  OrderLedger,
  OrderPlacementResult,
  OrderType,
  TakerOrderRequest,
  TradeAlert,
  TradeExecutor,
  TradingDb,
} from './types.ts';

/** The slice of @polymarket/clob-client the Phase-A taker executor touches. */
export interface ClobClientish {
  getTickSize(tokenID: string): Promise<number | string>;
  createOrder(
    args: { tokenID: string; price: number; size: number; side: 'BUY' | 'SELL' },
    options: { tickSize: number; negRisk: boolean },
  ): Promise<unknown>;
  /** `postOnly` is the native 3rd positional bool (GTC/GTD-only) — research report §9.2. */
  postOrder(
    order: unknown,
    orderType: OrderType,
    postOnly?: boolean,
  ): Promise<{ orderID?: string; success?: boolean }>;
  getOrder(orderID: string): Promise<{
    status?: string;
    price?: string | number;
    size?: string | number;
    original_size?: string | number;
    size_matched?: string | number;
    order_type?: string;
  }>;
  cancelOrder(payload: { orderID: string }): Promise<unknown>;
}

/**
 * The extended slice the MAKER-EXIT rail touches — adds the read-side book (for maker pricing) and the
 * full cancel/reconcile surface (research report §3/§4/§5). A superset of `ClobClientish`, so the same
 * live client drives both the dormant Phase-A taker path and the maker rail.
 */
export interface MakerClobClientish extends ClobClientish {
  getOrderBook(tokenID: string): Promise<unknown>;
  getOpenOrders(params?: { market?: string; asset_id?: string }): Promise<unknown>;
  cancelOrders(payload: { orderIDs: string[] }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
  cancelMarketOrders(payload: { market?: string; asset_id?: string }): Promise<unknown>;
}

export interface LiveExecutorDeps {
  db: TradingDb;
  /** Mock in tests; createClobClient (below) in the Deno edge runtime. */
  client: () => Promise<ClobClientish>;
  notify: (alert: TradeAlert) => Promise<boolean>;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Deno.env in Edge Functions, process.env elsewhere — local copy so this package depends on nothing above it. */
function envVar(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env[name];
}

/**
 * Production client factory: ClobClient(host, chainId=137, signer from
 * POLY_PRIVATE_KEY, creds via createOrDeriveApiKey). Dynamic non-literal
 * specifiers: resolved by Deno at run time, invisible to tsc/Node — nothing
 * is installed until the live phase actually deploys it.
 */
export async function createClobClient(): Promise<MakerClobClientish> {
  const key = envVar('POLY_PRIVATE_KEY');
  if (!key) {
    throw new ExecutionError('ERR_NO_KEY', 'POLY_PRIVATE_KEY missing from execute-bet function secrets');
  }
  const ethersSpec = 'npm:ethers@5';
  const clobSpec = 'npm:@polymarket/clob-client@4';
  const { Wallet } = (await import(ethersSpec)) as { Wallet: new (k: string) => unknown };
  const { ClobClient } = (await import(clobSpec)) as {
    ClobClient: new (host: string, chainId: number, signer: unknown, creds?: unknown, sigType?: number, funder?: string) => MakerClobClientish & {
      createOrDeriveApiKey(): Promise<unknown>;
    };
  };
  const signer = new Wallet(key);
  const sigType = Number(envVar('POLY_SIGNATURE_TYPE') ?? 0);
  const funder = envVar('POLY_FUNDER_ADDRESS');
  const bootstrap = new ClobClient('https://clob.polymarket.com', 137, signer, undefined, sigType, funder);
  const creds = await bootstrap.createOrDeriveApiKey();
  return new ClobClient('https://clob.polymarket.com', 137, signer, creds, sigType, funder);
}

export class LiveExecutor implements TradeExecutor {
  readonly mode = 'live' as const;

  constructor(private readonly deps: LiveExecutorDeps) {}

  async place(bet: ApprovedBet): Promise<FillResult> {
    const { db, notify } = this.deps;
    let orderId: string | undefined;
    let limit = bet.execAsk;
    try {
      const client = await this.deps.client();
      // Tick-size & min-size re-fetched per market; BUY limit rounds DOWN to
      // the grid — never pay above the recommendation's executable ask.
      const tick = Number(await client.getTickSize(bet.tokenYes));
      if (tick > 0) limit = round6(Math.floor((bet.execAsk + 1e-9) / tick) * tick);
      if (bet.recShares < bet.minOrderSize) {
        throw new ExecutionError(
          'ERR_MIN_SIZE',
          `recShares ${bet.recShares} < market min order size ${bet.minOrderSize}`,
        );
      }
      const order = await client.createOrder(
        { tokenID: bet.tokenYes, price: limit, size: bet.recShares, side: 'BUY' },
        { tickSize: tick, negRisk: true },
      );
      const posted = await client.postOrder(order, 'GTC');
      orderId = posted?.orderID;
      if (!orderId) {
        throw new ExecutionError('ERR_CLOB_POST', 'postOrder returned no orderID');
      }

      const status = await client.getOrder(orderId);
      if (status?.status === 'matched') {
        const px = round6(Number(status.price ?? limit));
        const matched = Math.floor(Number(status.size_matched ?? bet.recShares));
        const [res] = await db.rpc<{ fill_bet_with_caps: FillRpcResult }>('fill_bet_with_caps', {
          p_bet_id: bet.betId,
          p_price: px,
          p_shares: matched,
        });
        const out = res?.fill_bet_with_caps;
        if (out?.outcome !== 'filled') {
          // A real order matched but the record was refused — operational
          // anomaly (poll-markets sized within caps); surface loudly.
          throw new ExecutionError(
            'ERR_FILL_RECORD',
            `live order ${orderId} matched but fill record refused: ${out?.outcome} ${(out?.details ?? []).join('; ')}`,
          );
        }
        return { price: Number(out.price), shares: Number(out.shares), feeUsd: Number(out.feeUsd), mode: 'live' };
      }

      // Posted but unmatched: record the resting GTC so poll-markets' expiry
      // can pull it via execute-bet {action:'cancel'} (§6.20a chokepoint).
      await db.rpc('note_resting_order', { p_bet_id: bet.betId, p_order_id: orderId });
      return { price: limit, shares: 0, feeUsd: 0, mode: 'live' };
    } catch (e) {
      // NEVER retries placement automatically — no accidental doubles
      // (idempotency by client order id). Bet → 'execution_failed' + CRITICAL.
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await db.rpc('set_bet_execution_failed', { p_bet_id: bet.betId, p_error: message });
      await notify({
        kind: 'EXECUTION_FAIL',
        severity: 'CRITICAL',
        title: `Live execution failed: ${bet.eventSlug} · ${bet.label}`,
        body: `${message}${orderId ? `\norder ${orderId} may be resting — verify on Polymarket` : ''}`,
        dedupeKey: `exec-fail:${bet.betId}`,
      });
      if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
      throw new ExecutionError('ERR_CLOB', message);
    }
  }

  /** Pull a resting GTC order recorded by place() (notes 'resting:{orderID}'). */
  async cancel(betId: string): Promise<void> {
    const [row] = await this.deps.db.rpc<{ bet_for_execution: { notes?: string | null } | null }>(
      'bet_for_execution',
      { p_bet_id: betId },
    );
    const notes = row?.bet_for_execution?.notes ?? '';
    const m = /resting:(\S+)/.exec(notes);
    if (!m) return; // nothing resting — cancel is a no-op
    const client = await this.deps.client();
    await client.cancelOrder({ orderID: m[1]! });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// MakerExecutor — the tuned MAKER-EXIT strategy's live order rail (T1).
//
// Extends the dormant taker rail above with: (1) MAKER placement (resting GTC/GTD, maker-ness enforced
// BY PRICE — BUY strictly below best ask, SELL strictly above best bid — with the native `post_only`
// flag passed as defense-in-depth); (2) the order lifecycle (cancel / cancel-all-for-market / list /
// fill-poll with partial-fill accounting / cancel-then-repost reprice); (3) DB-ledger idempotency (a
// retry or crash-restart NEVER double-places); (4) a `TRADE_MODE` (off | dry-run | live) that defaults
// to dry-run and can only reach a real post via the explicit `TRADE_MODE=live`. Mock-tested from day one
// exactly like `LiveExecutor`; the wallet key + clob client stay inside this file (§15). A taker FAK exit
// (`placeTaker`) completes the strategy's stop-loss / time-stop leg.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

export interface MakerExecutorDeps {
  db: TradingDb;
  /** Mock in tests; `createClobClient` in the live runtime. */
  client: () => Promise<MakerClobClientish>;
  notify: (alert: TradeAlert) => Promise<boolean>;
  /** Deno.env.get / process.env probe — `TRADE_MODE` gate. */
  getEnvVar: (name: string) => string | undefined;
  /** The idempotency + lifecycle ledger. Defaults to `rpcOrderLedger(db)` (goes through TradingDb). */
  ledger?: OrderLedger;
  /** Client-order-id minter — injected for deterministic tests; defaults to `crypto.randomUUID`. */
  newClientOrderId?: () => string;
  /** Structured logger for the dry-run payload + audit; defaults to redacting-console JSON. */
  log?: (entry: Record<string, unknown>) => void;
}

const defaultLog = (entry: Record<string, unknown>): void => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(entry));
};

export class MakerExecutor {
  private readonly ledger: OrderLedger;
  private readonly newId: () => string;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly deps: MakerExecutorDeps) {
    this.ledger = deps.ledger ?? rpcOrderLedger(deps.db);
    this.newId = deps.newClientOrderId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? defaultLog;
  }

  get mode(): ReturnType<typeof resolveTradeMode> {
    return resolveTradeMode(this.deps.getEnvVar);
  }

  /**
   * Post a resting MAKER order for the tuned strategy (entry or take-profit). The limit is re-priced to
   * sit strictly inside the spread (never crosses → never pays taker fees), then posted GTC/GTD with
   * `post_only`. Idempotent: an OPEN intent for `(market|side|purpose|date)` is never re-placed.
   */
  async place(req: MakerOrderRequest): Promise<OrderPlacementResult> {
    const mode = this.mode;
    const intentKey = orderIntentKey(req);
    const orderType: OrderType = req.orderType ?? 'GTC';
    const base = {
      mode,
      intentKey,
      side: req.side,
      purpose: req.purpose,
      orderType,
      postOnly: true,
      size: req.size,
    } as const;

    if (mode === 'off') {
      return { ...base, status: 'skipped_off', clientOrderId: null, orderId: null, limitPrice: null, sizeMatched: 0, reason: 'TRADE_MODE=off' };
    }

    // Idempotency gate #1 — an open intent for this key must NEVER be re-placed (crash-restart safety).
    const open = await this.ledger.findByIntentKey(intentKey);
    if (open) {
      return { ...base, status: 'duplicate', clientOrderId: open.clientOrderId, orderId: open.orderId, limitPrice: open.price, sizeMatched: open.sizeMatched, reason: `open intent already ${open.status}` };
    }

    const client = await this.deps.client();
    const top = parseOrderBookTop(await client.getOrderBook(req.tokenId));
    const tick = top.tickSize > 0 ? top.tickSize : Number(await client.getTickSize(req.tokenId));
    const priced = makerLimitPrice({ side: req.side, targetPrice: req.targetPrice, bestBid: top.bestBid, bestAsk: top.bestAsk, tick });
    if (!priced.ok) {
      return { ...base, status: 'not_makeable', clientOrderId: null, orderId: null, limitPrice: null, sizeMatched: 0, reason: priced.reason };
    }
    const minSize = req.minOrderSize ?? top.minOrderSize;
    if (minSize > 0 && req.size < minSize) {
      throw new ExecutionError('ERR_MIN_SIZE', `size ${req.size} < market min order size ${minSize}`);
    }

    const clientOrderId = this.newId();
    const order = await client.createOrder(
      { tokenID: req.tokenId, price: priced.price, size: req.size, side: req.side },
      { tickSize: tick, negRisk: req.negRisk ?? true },
    );

    // DRY-RUN: build + log the EXACT (redacted) payload, return synthetic accepted — never posts, never
    // writes the ledger (a simulation leaves no on-book or on-ledger footprint).
    if (mode === 'dry-run') {
      this.log({ msg: 'maker.dry_run', intentKey, clientOrderId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType, postOnly: true, price: priced.price, size: req.size, payload: redactOrderPayload(order) });
      return { ...base, status: 'dry_run', clientOrderId, orderId: null, limitPrice: priced.price, sizeMatched: 0 };
    }

    // LIVE: reserve the intent BEFORE posting (the crash-safety anchor), then place, then record.
    const reserved = await this.ledger.reserveIntent({ intentKey, clientOrderId, marketId: req.marketId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType, price: priced.price, size: req.size, tradeDate: req.tradeDate });
    if (reserved === 'exists') {
      // Idempotency gate #2 — a concurrent placer won the partial-unique race; do NOT double-place.
      return { ...base, status: 'duplicate', clientOrderId: null, orderId: null, limitPrice: priced.price, sizeMatched: 0, reason: 'intent reserved concurrently' };
    }
    return this.postAndRecord(client, order, clientOrderId, { ...base, clientOrderId, limitPrice: priced.price }, orderType, true, req.size, `${req.marketId} ${req.side} ${req.purpose}`);
  }

  /**
   * Post a TAKER exit (FAK marketable-limit with a worst-price slippage guard) — the stop-loss /
   * time-stop leg. FAK takes whatever depth exists and cancels the rest (never hangs a resting order in
   * a thin weather book — research report §1). Idempotent through the same ledger; `post_only` is never
   * set (the venue rejects it on FOK/FAK).
   */
  async placeTaker(req: TakerOrderRequest): Promise<OrderPlacementResult> {
    const mode = this.mode;
    const intentKey = orderIntentKey(req);
    const base = { mode, intentKey, side: req.side, purpose: req.purpose, orderType: 'FAK' as OrderType, postOnly: false, size: req.size } as const;

    if (mode === 'off') {
      return { ...base, status: 'skipped_off', clientOrderId: null, orderId: null, limitPrice: null, sizeMatched: 0, reason: 'TRADE_MODE=off' };
    }
    const open = await this.ledger.findByIntentKey(intentKey);
    if (open) {
      return { ...base, status: 'duplicate', clientOrderId: open.clientOrderId, orderId: open.orderId, limitPrice: open.price, sizeMatched: open.sizeMatched, reason: `open intent already ${open.status}` };
    }

    const client = await this.deps.client();
    const tick = Number(await client.getTickSize(req.tokenId));
    const price = takerLimitPrice(req.side, req.worstPrice, tick);
    if (req.minOrderSize != null && req.minOrderSize > 0 && req.size < req.minOrderSize) {
      throw new ExecutionError('ERR_MIN_SIZE', `size ${req.size} < market min order size ${req.minOrderSize}`);
    }
    const clientOrderId = this.newId();
    const order = await client.createOrder({ tokenID: req.tokenId, price, size: req.size, side: req.side }, { tickSize: tick, negRisk: req.negRisk ?? true });

    if (mode === 'dry-run') {
      this.log({ msg: 'taker.dry_run', intentKey, clientOrderId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType: 'FAK', price, size: req.size, payload: redactOrderPayload(order) });
      return { ...base, status: 'dry_run', clientOrderId, orderId: null, limitPrice: price, sizeMatched: 0 };
    }
    const reserved = await this.ledger.reserveIntent({ intentKey, clientOrderId, marketId: req.marketId, tokenId: req.tokenId, side: req.side, purpose: req.purpose, orderType: 'FAK', price, size: req.size, tradeDate: req.tradeDate });
    if (reserved === 'exists') {
      return { ...base, status: 'duplicate', clientOrderId: null, orderId: null, limitPrice: price, sizeMatched: 0, reason: 'intent reserved concurrently' };
    }
    return this.postAndRecord(client, order, clientOrderId, { ...base, clientOrderId, limitPrice: price }, 'FAK', false, req.size, `${req.marketId} ${req.side} ${req.purpose}`);
  }

  /** Post + record the fill (shared live tail). NEVER auto-retries on error — no accidental doubles. */
  private async postAndRecord(
    client: MakerClobClientish,
    order: unknown,
    clientOrderId: string,
    result: Omit<OrderPlacementResult, 'status' | 'orderId' | 'sizeMatched'> & { clientOrderId: string },
    orderType: OrderType,
    postOnly: boolean,
    requestedSize: number,
    label: string,
  ): Promise<OrderPlacementResult> {
    let orderId: string | undefined;
    try {
      const posted = await client.postOrder(order, orderType, postOnly);
      orderId = posted?.orderID;
      if (!orderId) throw new ExecutionError('ERR_CLOB_POST', 'postOrder returned no orderID');
      await this.ledger.recordPlaced(clientOrderId, orderId);

      const poll = parseOrderFillPoll(await client.getOrder(orderId), orderId, requestedSize);
      if (poll.filled) {
        await this.ledger.recordFill(clientOrderId, poll.sizeMatched || requestedSize, poll.avgPrice ?? result.limitPrice ?? 0, 'filled');
      } else if (poll.partial) {
        await this.ledger.recordFill(clientOrderId, poll.sizeMatched, poll.avgPrice ?? result.limitPrice ?? 0, 'partial');
      }
      // resting (maker unmatched): stays 'placed'; the loop repolls / reprices / cancels via the chokepoint.
      return { ...result, status: 'placed', orderId, sizeMatched: poll.sizeMatched };
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      await this.ledger.recordFailed(clientOrderId, message);
      await this.deps.notify({
        kind: 'ORDER_FAIL',
        severity: 'CRITICAL',
        title: `Live order failed: ${label}`,
        body: `${message}${orderId ? `\norder ${orderId} may be resting — verify on Polymarket` : ''}`,
        dedupeKey: `order-fail:${clientOrderId}`,
      });
      if (e instanceof ExecutionError || e instanceof FillRejected) throw e;
      throw new ExecutionError('ERR_CLOB', message);
    }
  }

  /** Cancel one resting order (live only; dry-run/off are no-ops — no real order exists). */
  async cancel(orderId: string, clientOrderId?: string): Promise<CancelResult> {
    if (this.mode !== 'live') {
      return { requested: [orderId], canceled: [orderId], notCanceled: {}, allCanceled: true };
    }
    const client = await this.deps.client();
    const res = parseCancelResult(await client.cancelOrder({ orderID: orderId }), [orderId]);
    if (clientOrderId && res.allCanceled) await this.ledger.recordCanceled(clientOrderId);
    return res;
  }

  /** Cancel every resting order on a market (the flatten/kill primitive; live only). */
  async cancelAllForMarket(marketId: string, tokenId?: string): Promise<CancelResult> {
    if (this.mode !== 'live') {
      return { requested: [], canceled: [], notCanceled: {}, allCanceled: true };
    }
    const client = await this.deps.client();
    const payload = tokenId ? { market: marketId, asset_id: tokenId } : { market: marketId };
    return parseCancelResult(await client.cancelMarketOrders(payload), []);
  }

  /** List our open orders (reconcile source of truth; live only). */
  async listOpenOrders(params?: { market?: string; asset_id?: string }): Promise<OpenOrder[]> {
    if (this.mode !== 'live') return [];
    const client = await this.deps.client();
    return parseOpenOrders(await client.getOpenOrders(params));
  }

  /** Poll one order for fills (partial-fill aware). Non-live returns a synthetic resting poll. */
  async pollFill(orderId: string, requestedSize = 0): Promise<OrderFillPoll> {
    if (this.mode !== 'live') {
      return { orderId, status: 'dry-run', originalSize: requestedSize, sizeMatched: 0, avgPrice: null, filled: false, partial: false, resting: true };
    }
    const client = await this.deps.client();
    return parseOrderFillPoll(await client.getOrder(orderId), orderId, requestedSize);
  }

  /**
   * Reprice a resting maker order: cancel-then-repost the UNFILLED REMAINDER (no atomic amend exists —
   * research report §3). Never assumes the cancel succeeded — a cancel that races a fill (`not_canceled`)
   * recomputes the remainder from `size_matched`; if nothing (or below min) remains, it does NOT repost
   * (guards the §3 double-position hazard). The repost reuses the same intent key (freed by the cancel).
   */
  async reprice(
    oldOrderId: string,
    oldClientOrderId: string | undefined,
    newReq: MakerOrderRequest,
  ): Promise<{ cancel: CancelResult; placed: OrderPlacementResult }> {
    const cancel = await this.cancel(oldOrderId, oldClientOrderId);
    let size = newReq.size;
    if (!cancel.allCanceled) {
      // The cancel raced a fill — recompute the remainder from the live order state before reposting.
      const poll = await this.pollFill(oldOrderId, newReq.size);
      size = Math.max(0, newReq.size - poll.sizeMatched);
      const min = newReq.minOrderSize ?? 0;
      if (size <= 0 || size < min) {
        const intentKey = orderIntentKey(newReq);
        return {
          cancel,
          placed: { mode: this.mode, status: 'rejected', intentKey, clientOrderId: null, orderId: null, side: newReq.side, purpose: newReq.purpose, orderType: newReq.orderType ?? 'GTC', postOnly: true, limitPrice: null, size, sizeMatched: poll.sizeMatched, reason: 'reprice remainder below min after racing fill' },
        };
      }
    }
    return { cancel, placed: await this.place({ ...newReq, size }) };
  }
}
