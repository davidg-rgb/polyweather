/**
 * order-ledger — binds the abstract `OrderLedger` port (types.ts) to the `TradingDb.rpc` seam.
 *
 * This is the CONTRACT the T3 lane must ship as `bot_orders` + these seven RPCs. The maker executor
 * only ever sees the `OrderLedger` interface (injected, faked in tests); `rpcOrderLedger(db)` is the
 * production binding — the DB write "goes through the existing TradingDb port" (T1 brief) while the
 * table/migration stays entirely in T3's lane. No clob client, no key, no direct SQL here.
 *
 * RPC contract (snake_case, `p_`-prefixed args, jsonb single-row return — the project idiom).
 * MODE-SCOPED (the T3 F4 amendment): rows are keyed by (mode, intent_key); the load-bearing index is
 * PARTIAL-UNIQUE on `(mode, intent_key) WHERE status NOT IN ('canceled','failed')` — a dry-run row can
 * never block a live intent, and vice versa. reserve/find/list take an explicit `p_mode`; the
 * `record_*` RPCs are keyed by the globally-unique `p_client_order_id` and need no mode. The schema's
 * mode CHECK allows only 'dry-run'|'live' — 'off' must never reach a ledger write (the executor's
 * off-mode early return guarantees it; tested). record_fill's p_size_matched is CUMULATIVE (the schema
 * appends only positive deltas to live_fills; a same-cumulative echo writes nothing).
 *
 *   bot_order_by_intent(p_intent_key text, p_mode text)           → the OPEN (non-terminal) row for
 *                                                                    (mode, intent_key) | null
 *   bot_order_reserve_intent(p_mode, p_intent_key,                → 'reserved' | 'exists'
 *       p_client_order_id, p_market_id, p_token_id, p_side,          (CONDITIONAL insert guarded by the
 *       p_purpose, p_order_type, p_price, p_size, p_trade_date)       partial-unique index above — the
 *                                                                     never-double-place guarantee)
 *   bot_order_list_dangling(p_mode text)                          → jsonb OBJECT ENVELOPE `{rows:[…]}`
 *                                                                    of rows with status='intent' AND
 *                                                                    order_id IS NULL (the startup-
 *                                                                    reconcile input). T3-CONFIRMED
 *                                                                    (round 2): ships as `{rows:[…]}` —
 *                                                                    the post-0081 idiom, NO top-level
 *                                                                    jsonb arrays on the money path.
 *                                                                    Adapter: null/undefined result → []
 *                                                                    (RPC not yet live / SQL NULL);
 *                                                                    non-null-but-shapeless — including
 *                                                                    a bare array (version skew) — RAISES
 *   bot_order_record_placed(p_client_order_id, p_order_id)        → void  (intent → placed, sets orderId)
 *   bot_order_record_fill(p_client_order_id, p_size_matched,      → void  (placed → partial | filled;
 *       p_avg_price, p_status)                                       size_matched is CUMULATIVE)
 *   bot_order_record_canceled(p_client_order_id)                  → void  (→ canceled, terminal;
 *                                                                    T3-CONFIRMED it preserves
 *                                                                    size_matched — partial-fill
 *                                                                    accounting survives the transition)
 *   bot_order_record_failed(p_client_order_id, p_error)           → void  (→ failed, terminal; never retried)
 */
import { ExecutionError } from '@weather-edge/core';
import type {
  OrderLedger,
  OrderLedgerRow,
  OrderLedgerStatus,
  OrderSide,
  OrderPurpose,
  ReserveIntentInput,
  TradeMode,
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
    mode: String(o['mode'] ?? 'live') as TradeMode,
    intentKey: String(o['intent_key'] ?? o['intentKey'] ?? ''),
    clientOrderId: String(o['client_order_id'] ?? o['clientOrderId'] ?? ''),
    status: String(o['status'] ?? 'intent') as OrderLedgerStatus,
    orderId: o['order_id'] == null && o['orderId'] == null ? null : String(o['order_id'] ?? o['orderId']),
    side: String(o['side'] ?? 'BUY') as OrderSide,
    purpose: String(o['purpose'] ?? 'entry') as OrderPurpose,
    price: num(o['price']),
    size: num(o['size']),
    sizeMatched: num(o['size_matched'] ?? o['sizeMatched']),
    tokenId: String(o['token_id'] ?? o['tokenId'] ?? ''),
    marketId: String(o['market_id'] ?? o['marketId'] ?? ''),
    createdAt:
      o['created_at'] == null && o['createdAt'] == null
        ? null
        : String(o['created_at'] ?? o['createdAt']),
  };
}

/** The production `OrderLedger`, bound to `TradingDb.rpc`. */
export function rpcOrderLedger(db: TradingDb): OrderLedger {
  return {
    async findByIntentKey(intentKey: string, mode: TradeMode): Promise<OrderLedgerRow | null> {
      const [row] = await db.rpc<{ bot_order_by_intent: unknown }>('bot_order_by_intent', {
        p_intent_key: intentKey,
        p_mode: mode,
      });
      return mapLedgerRow(row?.bot_order_by_intent ?? null);
    },

    async reserveIntent(input: ReserveIntentInput): Promise<'reserved' | 'exists'> {
      const [row] = await db.rpc<{ bot_order_reserve_intent: string }>('bot_order_reserve_intent', {
        p_mode: input.mode,
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

    async listDanglingIntents(mode: TradeMode): Promise<OrderLedgerRow[]> {
      const [row] = await db.rpc<{ bot_order_list_dangling: unknown }>('bot_order_list_dangling', {
        p_mode: mode,
      });
      const res = row?.bot_order_list_dangling;
      // null/undefined = the RPC isn't live yet (or returned SQL NULL) — reconcile degrades to a no-op.
      if (res == null) return [];
      // T3 ships an OBJECT ENVELOPE {rows:[…]} (post-0081 idiom: no top-level jsonb arrays on the
      // money path). Anything non-null that isn't that shape — including a bare array (version skew
      // between adapter and RPC) — RAISES per the MEDIUM-3 posture: the reconcile input must never
      // silently coerce to [] (an empty sweep would look like "nothing dangling" and skip reconcile).
      const rows = (res as { rows?: unknown }).rows;
      if (!Array.isArray(rows)) {
        throw new ExecutionError(
          'ERR_LEDGER_SHAPE',
          `bot_order_list_dangling returned a shapeless result (expected {rows:[…]}): ${JSON.stringify(res).slice(0, 80)}`,
        );
      }
      return rows.map(mapLedgerRow).filter((r): r is OrderLedgerRow => r !== null);
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
