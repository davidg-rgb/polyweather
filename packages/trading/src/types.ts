/**
 * packages/trading — executor boundary types (ARCHITECTURE.md §6.20, ADR-10).
 */

/**
 * Narrow data-access port — structurally identical to functions/_shared
 * DbPort, redeclared here so the package depends on nothing above it
 * (supabasePort and the PGlite test twin both satisfy it).
 */
export interface TradingDb {
  rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]>;
  getConfigRows(): Promise<{ key: string; value: string }[]>;
}

/** Minimal alert shape — structurally compatible with _shared/slack notifySlack. */
export interface TradeAlert {
  kind: string;
  severity: 'INFO' | 'ACTION' | 'WARN' | 'CRITICAL';
  title: string;
  body: string;
  dedupeKey?: string;
}

/** The bets row + stored book/audit fields execute-bet loads via bet_for_execution. */
export interface ApprovedBet {
  betId: string;
  status: string;
  mode: 'paper' | 'live';
  eventId: string;
  eventSlug: string;
  citySlug: string;
  label: string;
  tokenYes: string;
  feeRate: number;
  minOrderSize: number;
  tickSize: number | null;
  /** The recommendation's walked stored ask (§6.7 executableAsk at rec time). */
  execAsk: number;
  recShares: number;
  recStakeUsd: number;
  recommendedAt: string;
  notes: string | null;
}

export interface FillResult {
  price: number;
  /** Live resting GTC (posted, unmatched) reports shares 0 — §6.20 "record resting state". */
  shares: number;
  feeUsd: number;
  mode: 'paper' | 'live';
}

export interface TradeExecutor {
  readonly mode: 'paper' | 'live';
  place(bet: ApprovedBet): Promise<FillResult>;
  /**
   * Live phase: pulls a resting GTC order — reached ONLY via execute-bet
   * {action:'cancel'} (§6.20a, the chokepoint). Paper: no-op (no resting orders).
   */
  cancel(betId: string): Promise<void>;
}

/** fill_bet_with_caps jsonb result (0019). caps present on every outcome (parity test). */
export interface FillRpcResult {
  outcome: 'filled' | 'caps' | 'bad_status' | 'not_found';
  price?: number;
  shares?: number;
  feeUsd?: number;
  stakeUsd?: number;
  details?: string[];
  status?: string;
  caps?: {
    bankroll: number;
    perTradeCap: number;
    eventOpen: number;
    eventHeadroom: number;
    clusterOpen: number;
    clusterHeadroom: number;
    dayOpen: number;
    dayHeadroom: number;
  };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// MAKER-EXIT live rail (T1) — the boundary types the maker executor + its lifecycle expose.
//
// These extend the Phase-A taker rail above so the tuned MAKER-EXIT strategy (MAKER-EXIT-SIM.md:
// maker GTC entry + resting maker TP + taker FAK stop/time-stop) can run end-to-end. The SDK call
// surface here is grounded in `research/REPORT-clob-bracket-execution.md` PLUS a re-verification
// against the INSTALLED `@polymarket/clob-client@4.22.8` dist (the report's §9 resolved some surfaces
// against the different `clob-client-v2@1.0.6` package): order types GTC/GTD/FOK/FAK (§1); the v4 SDK
// has NO post_only anywhere — maker-ness is enforced BY PRICE alone (`makerLimitPrice`), and
// `postOrder`'s 3rd positional is `deferExec`, never passed; NO server-side client-order-id —
// idempotency is OUR own DB ledger (§5); no atomic amend — reprice = cancel-then-repost the remainder
// (§3); partial fills are tracked via cumulative `size_matched` (§4).
// ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The venue's four order types (research report §1). Maker-eligible: GTC/GTD. Taker: FOK/FAK. */
export type OrderType = 'GTC' | 'GTD' | 'FOK' | 'FAK';

/** BUY = long the YES token (entry); SELL = flatten (take-profit / stop / time-stop). */
export type OrderSide = 'BUY' | 'SELL';

/** Why an order exists — the third component of the idempotency key (with market + side + date). */
export type OrderPurpose = 'entry' | 'take_profit' | 'stop_loss' | 'time_stop';

/**
 * The execution posture. `off` = the rail does nothing (returns a no-op result). `dry-run` = build +
 * log the exact (redacted) order payload, RECORD the intent in the ledger under mode='dry-run' (the
 * shadow harness reads these rows) and return a synthetic accepted result WITHOUT ever posting or
 * canceling at the venue. `live` = actually post. Read from the `TRADE_MODE` env var by
 * `resolveTradeMode`, which defaults anything unset/unknown to `dry-run` — NEVER `live` (a live post
 * requires the explicit string).
 */
export type TradeMode = 'off' | 'dry-run' | 'live';

/**
 * One order-intent's lifecycle state (mirrors ADR-OC-4/ADR-OC-5). `intent` is the crash-safety
 * anchor — written BEFORE any post; a restart that finds an `intent`/`placed`/`partial`/`filled`
 * row for a (mode, key) must NEVER re-place in that mode. `canceled`/`failed` are terminal and free
 * the key for a reprice.
 */
export type OrderLedgerStatus = 'intent' | 'placed' | 'partial' | 'filled' | 'canceled' | 'failed';

/** A row of the order-intent ledger (the `bot_orders` table T3 owns). Rows are MODE-scoped (F4). */
export interface OrderLedgerRow {
  /** the trade mode this row was written under — the ledger key is (mode, intentKey). */
  mode: TradeMode;
  intentKey: string;
  clientOrderId: string;
  status: OrderLedgerStatus;
  /** the venue orderID — null until `recordPlaced` (the post→record critical section, ADR-OC-5).
   *  dry-run rows carry a synthetic `dry-run:{clientOrderId}` marker, never a venue id. */
  orderId: string | null;
  side: OrderSide;
  purpose: OrderPurpose;
  price: number;
  size: number;
  sizeMatched: number;
  /** the token + market the intent targets — required by startup reconcile (heuristic venue match). */
  tokenId: string;
  marketId: string;
  /** row creation time (ISO) when the DB provides it — reconcile recency input; null otherwise. */
  createdAt: string | null;
}

/** The write payload for `reserveIntent` (the pre-placement intent reservation). Mode-scoped (F4). */
export interface ReserveIntentInput {
  mode: TradeMode;
  intentKey: string;
  clientOrderId: string;
  marketId: string;
  tokenId: string;
  side: OrderSide;
  purpose: OrderPurpose;
  orderType: OrderType;
  price: number;
  size: number;
  tradeDate: string;
}

/**
 * The order-intent ledger port — the idempotency + lifecycle surface the maker executor needs and
 * the **T3 lane implements** over its `bot_orders` table. Abstract on purpose: `rpcOrderLedger(db)`
 * binds it to `TradingDb.rpc` (the RPC contract T3 must ship — see order-ledger.ts), and tests fake
 * it directly. The load-bearing invariant (F4-amended): `reserveIntent` is a CONDITIONAL insert
 * guarded by a PARTIAL-UNIQUE index on `(mode, intent_key) WHERE status NOT IN ('canceled','failed')`
 * — so a retry or a concurrent placer with the same intent IN THE SAME MODE gets `'exists'`, never a
 * second live order, while a dry-run row can never block a later live intent (and vice versa).
 * `findByIntentKey` returns the single OPEN (non-terminal) row for (mode, key), or null.
 * `listDanglingIntents` feeds startup reconcile: the non-terminal rows still missing a venue orderId
 * (status='intent', order_id IS NULL) for the given mode.
 */
export interface OrderLedger {
  findByIntentKey(intentKey: string, mode: TradeMode): Promise<OrderLedgerRow | null>;
  reserveIntent(input: ReserveIntentInput): Promise<'reserved' | 'exists'>;
  listDanglingIntents(mode: TradeMode): Promise<OrderLedgerRow[]>;
  recordPlaced(clientOrderId: string, orderId: string): Promise<void>;
  recordFill(
    clientOrderId: string,
    sizeMatched: number,
    avgPrice: number,
    status: 'filled' | 'partial',
    /** 0084 #17: the venue fee ($) attributed to THIS call's delta — $0 on the maker path (post-only never
     *  pays), computed caller-side for taker FAK exits (`TakerOrderRequest.feeRateBps` × the delta's
     *  notional). Omitted/undefined ⇒ 0 (the pre-0084 behavior). Lands on the delta's `live_fills.fee_usd`
     *  row so the N1 daily-loss definition's fee terms are live, not dead code. */
    feeUsd?: number,
  ): Promise<void>;
  recordCanceled(clientOrderId: string): Promise<void>;
  recordFailed(clientOrderId: string, error: string): Promise<void>;
}

/** Top-of-book (best bid/ask) + market params for maker pricing — parsed from `getOrderBook`. */
export interface OrderBookTop {
  bestBid: number | null;
  bestAsk: number | null;
  tickSize: number;
  minOrderSize: number;
}

/** A venue open order (`getOpenOrders`/`getOrder` fields, research report §5). */
export interface OpenOrder {
  orderId: string;
  status: string;
  side: string;
  tokenId: string;
  originalSize: number;
  sizeMatched: number;
  price: number;
  orderType: string;
}

/** The result of polling one order for fills (`getOrder`) — partial-fill aware (research report §4). */
export interface OrderFillPoll {
  orderId: string;
  status: string;
  originalSize: number;
  /** cumulative matched quantity (research report §4 — brackets arm against THIS, not requested size). */
  sizeMatched: number;
  avgPrice: number | null;
  filled: boolean;
  partial: boolean;
  resting: boolean;
}

/** Parsed venue cancel response (`{canceled, not_canceled}`, research report §3). */
export interface CancelResult {
  requested: string[];
  canceled: string[];
  notCanceled: Record<string, string>;
  /** true iff every requested id was canceled (none raced a fill). */
  allCanceled: boolean;
  /**
   * the order's POST-CANCEL cumulative matched size — set by `MakerExecutor.cancel`'s post-cancel
   * fill poll (a venue cancel can race a fill even when it reports `allCanceled`), so callers can
   * re-derive `remaining` from fresh truth before sizing a follow-up SELL. Absent when no poll ran
   * (parseCancelResult never sets it); 0 in non-live modes (dry-run rows never fill).
   */
  sizeMatched?: number;
}

/**
 * One maker leg of a venue trade record (`Trade.maker_orders[]`, installed SDK v4.22.8). The venue's
 * trade record is TAKER-centric — when WE were the maker, OUR fill is one (or more) of these legs:
 * `side` is the LEG's own side and `size` its `matched_amount`; `makerAddress` identifies whose leg it
 * is (the on-chain maker/funder address — legs from OTHER makers matched in the same taker order can
 * appear beside ours).
 */
export interface VenueTradeMakerLeg {
  orderId: string;
  side: string;
  price: number;
  /** this leg's `matched_amount` — OUR fill size when the leg is ours. */
  size: number;
  makerAddress: string;
  tokenId: string;
}

/**
 * A parsed venue trade/fill row (`getTrades`, installed SDK v4.22.8 `Trade`) — the reconcile evidence
 * read + the daemon's sell-truth floor. ⚠ TAKER-CENTRIC record: the top-level `side`/`size`/`price`
 * describe the TAKER order; `traderSide` says which side WE were. Our maker fills (this strategy's
 * dominant case — resting entries + TPs) live in `makerOrders[]` with per-leg side/size. NEVER read
 * the top-level `side`/`size` as ours without checking `traderSide` — use `sumOurSellSize` /
 * `tradeCouldBeOurFill` (order-intent.ts).
 */
export interface VenueTrade {
  /** the TAKER order's side — OUR side ONLY when `traderSide === 'TAKER'`. */
  side: string;
  price: number;
  /** the TAKER order's matched total — OUR size ONLY when `traderSide === 'TAKER'`. */
  size: number;
  tokenId: string;
  status: string;
  /** which side of the record WE were — the perspective key for every read of this row. */
  traderSide: 'TAKER' | 'MAKER';
  takerOrderId: string;
  makerOrders: VenueTradeMakerLeg[];
}

/**
 * One startup-reconcile decision per dangling ledger row (`MakerExecutor.reconcileOpenOrders`).
 * `adopted` = exactly one venue open order matched heuristically → recordPlaced with its orderId.
 * `freed`   = no open order AND no matching trade → confirmed never posted → key freed (recordFailed).
 * `held`    = AMBIGUOUS (multiple candidates, or a matching trade that could be our fill) → the row
 *             stays non-terminal + a WARN alert; a key is NEVER freed on ambiguity.
 */
export interface ReconcileOutcome {
  kind: 'adopted' | 'freed' | 'held';
  clientOrderId: string;
  intentKey: string;
  orderId: string | null;
  reason: string;
}

/** A maker order request (GTC/GTD, price-enforced maker). `targetPrice` is RE-PRICED to guarantee non-crossing. */
export interface MakerOrderRequest {
  /** conditionId — the market identity for the idempotency key + cancel-by-market. */
  marketId: string;
  /** the token being traded (YES side of the bucket). */
  tokenId: string;
  side: OrderSide;
  purpose: OrderPurpose;
  /** station-local trade date (idempotency-key component; ADR-OC-12 local-day math is the caller's). */
  tradeDate: string;
  /** desired limit BEFORE maker re-pricing; the executor moves it inside the spread (non-crossing). */
  targetPrice: number;
  size: number;
  negRisk?: boolean;
  minOrderSize?: number;
  /** GTC (default, rests) or GTD (self-expiring). Both are maker-eligible; FOK/FAK are not. */
  orderType?: 'GTC' | 'GTD';
  /** GTD expiration (epoch seconds) — caller owns the +buffer (research report §9.3). */
  expiresAt?: number;
}

/** A taker exit request (FAK marketable-limit with a worst-price slippage guard). */
export interface TakerOrderRequest {
  marketId: string;
  tokenId: string;
  side: OrderSide;
  purpose: OrderPurpose;
  tradeDate: string;
  /** the worst price we will accept — the FAK fills only through this limit, else fills 0. */
  worstPrice: number;
  size: number;
  negRisk?: boolean;
  minOrderSize?: number;
  /** 0084 #17: the venue's taker fee rate in BASIS POINTS (e.g. weather 5% ⇒ 500). When set, the executor
   *  books `feeRateBps/10 000 × avgPrice × sizeMatched` onto the fill's ledger row (live_fills.fee_usd) so
   *  taker exit fees reach the N1 daily-loss kill. Omitted ⇒ $0 recorded (the pre-0084 behavior). */
  feeRateBps?: number;
}

/** The outcome of a place attempt (maker or taker) across all trade modes. */
export interface OrderPlacementResult {
  mode: TradeMode;
  status:
    | 'placed' // live: posted (resting or (partly) matched)
    | 'dry_run' // dry-run: payload built + logged + ledger row recorded (mode dry-run); venue NOT called
    | 'skipped_off' // off: no-op
    | 'duplicate' // idempotency: an open intent for this (mode, key) already exists — NOT re-placed
    | 'not_makeable' // maker price would cross the book and cannot rest
    | 'rejected'; // pre-flight reject (e.g. reprice remainder too small)
  intentKey: string;
  clientOrderId: string | null;
  orderId: string | null;
  side: OrderSide;
  purpose: OrderPurpose;
  orderType: OrderType;
  /** the MAKER posture marker (true for resting entry/TP intents). ⚠ observability only: the pinned
   *  clob-client v4 has NO post_only wire flag — maker-ness is enforced entirely by `makerLimitPrice`. */
  postOnly: boolean;
  limitPrice: number | null;
  size: number;
  sizeMatched: number;
  reason?: string;
}
