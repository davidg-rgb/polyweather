/**
 * order-ledger — binds the abstract `OrderLedger` port (types.ts) to the `TradingDb.rpc` seam.
 *
 * This is the CONTRACT the T3 lane must ship as `bot_orders` + these six RPCs. The maker executor
 * only ever sees the `OrderLedger` interface (injected, faked in tests); `rpcOrderLedger(db)` is the
 * production binding — the DB write "goes through the existing TradingDb port" (T1 brief) while the
 * table/migration stays entirely in T3's lane. No clob client, no key, no direct SQL here.
 *
 * RPC contract (snake_case, `p_`-prefixed args, jsonb single-row return — the project idiom):
 *   bot_order_by_intent(p_intent_key text)                       → the OPEN (non-terminal) row | null
 *   bot_order_reserve_intent(p_intent_key, p_client_order_id,     → 'reserved' | 'exists'
 *       p_market_id, p_token_id, p_side, p_purpose, p_order_type,   (CONDITIONAL insert; the load-bearing
 *       p_price, p_size, p_trade_date)                              partial-unique index on
 *                                                                   intent_key WHERE status NOT IN
 *                                                                   ('canceled','failed') makes this the
 *                                                                   never-double-place guarantee)
 *   bot_order_record_placed(p_client_order_id, p_order_id)        → void  (intent → placed, sets orderId)
 *   bot_order_record_fill(p_client_order_id, p_size_matched,      → void  (placed → partial | filled)
 *       p_avg_price, p_status)
 *   bot_order_record_canceled(p_client_order_id)                 → void  (→ canceled, terminal)
 *   bot_order_record_failed(p_client_order_id, p_error)          → void  (→ failed, terminal; never retried)
 */
import type {
  OrderLedger,
  OrderLedgerRow,
  OrderLedgerStatus,
  OrderSide,
  OrderPurpose,
  ReserveIntentInput,
  TradingDb,
} from './types.ts';

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Map a DB `bot_orders` jsonb row (snake_case) to the camelCase `OrderLedgerRow`. */
export function mapLedgerRow(raw: unknown): OrderLedgerRow | null {
  if (raw == null) return null;
  const o = asRecord(raw);
  if (Object.keys(o).length === 0) return null;
  return {
    intentKey: String(o['intent_key'] ?? o['intentKey'] ?? ''),
    clientOrderId: String(o['client_order_id'] ?? o['clientOrderId'] ?? ''),
    status: String(o['status'] ?? 'intent') as OrderLedgerStatus,
    orderId: o['order_id'] == null && o['orderId'] == null ? null : String(o['order_id'] ?? o['orderId']),
    side: String(o['side'] ?? 'BUY') as OrderSide,
    purpose: String(o['purpose'] ?? 'entry') as OrderPurpose,
    price: num(o['price']),
    size: num(o['size']),
    sizeMatched: num(o['size_matched'] ?? o['sizeMatched']),
  };
}

/** The production `OrderLedger`, bound to `TradingDb.rpc`. */
export function rpcOrderLedger(db: TradingDb): OrderLedger {
  return {
    async findByIntentKey(intentKey: string): Promise<OrderLedgerRow | null> {
      const [row] = await db.rpc<{ bot_order_by_intent: unknown }>('bot_order_by_intent', {
        p_intent_key: intentKey,
      });
      return mapLedgerRow(row?.bot_order_by_intent ?? null);
    },

    async reserveIntent(input: ReserveIntentInput): Promise<'reserved' | 'exists'> {
      const [row] = await db.rpc<{ bot_order_reserve_intent: string }>('bot_order_reserve_intent', {
        p_intent_key: input.intentKey,
        p_client_order_id: input.clientOrderId,
        p_market_id: input.marketId,
        p_token_id: input.tokenId,
        p_side: input.side,
        p_purpose: input.purpose,
        p_order_type: input.orderType,
        p_price: input.price,
        p_size: input.size,
        p_trade_date: input.tradeDate,
      });
      return row?.bot_order_reserve_intent === 'exists' ? 'exists' : 'reserved';
    },

    async recordPlaced(clientOrderId: string, orderId: string): Promise<void> {
      await db.rpc('bot_order_record_placed', {
        p_client_order_id: clientOrderId,
        p_order_id: orderId,
      });
    },

    async recordFill(
      clientOrderId: string,
      sizeMatched: number,
      avgPrice: number,
      status: 'filled' | 'partial',
    ): Promise<void> {
      await db.rpc('bot_order_record_fill', {
        p_client_order_id: clientOrderId,
        p_size_matched: sizeMatched,
        p_avg_price: avgPrice,
        p_status: status,
      });
    },

    async recordCanceled(clientOrderId: string): Promise<void> {
      await db.rpc('bot_order_record_canceled', { p_client_order_id: clientOrderId });
    },

    async recordFailed(clientOrderId: string, error: string): Promise<void> {
      await db.rpc('bot_order_record_failed', { p_client_order_id: clientOrderId, p_error: error });
    },
  };
}
