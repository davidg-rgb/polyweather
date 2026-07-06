/**
 * scripts/lib/trading-db — a `TradingDb` (packages/trading) backed by the local `ScriptDb` (direct
 * service-role Postgres over DATABASE_URL). Shared by the live trading daemon + the credential smoke.
 *
 * The runner (service_role, no operator jwt) reaches the 0082 activation console + the T1 order ledger
 * through Postgres directly. Every RETURNS-jsonb / RETURNS-scalar function is called as
 * `select public.fn(named => $n) as fn`, so the row shape is `[{ [fn]: value }]` — EXACTLY what supabasePort
 * yields and what tradeConfig.ts / order-ledger.ts read (`rows[0].<fn>`). Array params (text[]) are inlined
 * as `array[$a,$b,…]::text[]`; object params (jsonb) are JSON-stringified + cast `::jsonb`; scalars bind
 * plainly. (This file imports only the `TradingDb`/`TradeMode` TYPES from packages/trading — the §15
 * boundary allow-lists it alongside the two scripts.)
 *
 * Beyond the port, this file carries the two DIRECT-SQL reads the daemon needs that 0082's RPC surface does
 * not expose (0082 is final — scripts talk straight SQL over the service DSN, the `getConfigRows` idiom):
 *   • `listOpenEntryRows` — the POSITION-IDENTITY read (review findings #4/#5/#9): every open BUY/entry
 *     ledger row for a mode. A position, once entered, is enumerated from the LEDGER — its own
 *     conditionId/tokenYes identity — never from the capture stream's current argmax-houseProb bucket,
 *     so a forecast-center drift or an unseeded capture can never orphan it from exit management.
 *   • `acquireTradeBotLock` — the SINGLE-INSTANCE guard (review finding #16): a session-scoped
 *     `pg_try_advisory_lock` per mode, taken once at daemon startup. Two concurrent same-mode daemons
 *     could over-sell via the FAK adjudication path (one adjudicates the peer's live partial FAK from a
 *     stale snapshot), so the second instance must refuse to start.
 */
import type { TradeMode, TradingDb } from '../../packages/trading/src/index.ts';
import type { ScriptDb } from './script-db.ts';

/** One open BUY/entry ledger row's identity — the daemon's position-enumeration unit. */
export interface OpenEntryRow {
  /** conditionId — the market the position was ENTERED in (its identity for its whole life). */
  marketId: string;
  /** the YES token actually traded (post-0083 the ledger carries it from placement). */
  tokenId: string;
  /** the intent-key trade date (YYYY-MM-DD). */
  tradeDate: string;
}

/** A predicted bucket's venue identity — the CITY-LIVE lane's (conditionId, tokenYes) for a place. */
export interface CityBucketIdentity {
  marketId: string;
  tokenId: string;
}

/**
 * `TradingDb` + the daemon-only direct-SQL reads. Structurally a `TradingDb`, so every existing consumer
 * (rpcOrderLedger, loadTradeConfig, preflightLive, the smoke) is untouched.
 */
export interface ScriptTradingDb extends TradingDb {
  /**
   * Every OPEN (non-canceled/failed) BUY/entry ledger row for `mode` with a recent trade_date — the
   * position-identity read. `filled` rows are INCLUDED (a filled entry IS a held position); the
   * `status not in ('canceled','failed')` predicate mirrors `bot_order_by_intent`'s open-row semantics.
   * Bounded by `OPEN_ENTRY_LOOKBACK_DAYS` (a position lives 1–2 days; resolved markets' rows age out of
   * the scan, and a fully-flattened position plans nothing anyway).
   */
  listOpenEntryRows(mode: TradeMode): Promise<OpenEntryRow[]>;

  /**
   * The CITY-LIVE lane's bucket-identity read (CITY-LIVE.md §3): the (conditionId, token_yes) of one
   * predicted bucket, so a live taker entry can faithfully mirror the sim's locked bucket. `city_sim_place_inputs`
   * gives the bucketIdx + ask but not the venue identity (its ladder is bucketIdx/low/high), so the daemon
   * resolves it here from `market_buckets` — the same DIRECT-SQL idiom as `listOpenEntryRows` (a daemon read
   * 0082's RPC surface does not expose). `market_buckets` is table 0004 (always present), so this never
   * depends on 0085. Returns null when the (event, bucket) pair is unknown.
   */
  cityBucketIdentity(eventId: string, bucketIdx: number): Promise<CityBucketIdentity | null>;
}

/** The trade_date lookback for the open-entry scan — generous vs the 1–2 day position life. */
export const OPEN_ENTRY_LOOKBACK_DAYS = 7;

export function makeTradingDb(sdb: ScriptDb): ScriptTradingDb {
  return {
    async rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      const keys = Object.keys(args ?? {});
      if (keys.length === 0) {
        return (await sdb.query(`select public.${fn}() as ${fn}`)) as unknown as T[];
      }
      const params: unknown[] = [];
      const parts: string[] = [];
      for (const k of keys) {
        const v = (args as Record<string, unknown>)[k];
        if (Array.isArray(v)) {
          const placeholders = v.map((el) => {
            params.push(el);
            return `$${params.length}`;
          });
          parts.push(`${k} => array[${placeholders.join(', ')}]::text[]`);
        } else if (v !== null && typeof v === 'object') {
          params.push(JSON.stringify(v));
          parts.push(`${k} => $${params.length}::jsonb`);
        } else {
          params.push(v);
          parts.push(`${k} => $${params.length}`);
        }
      }
      return (await sdb.query(`select public.${fn}(${parts.join(', ')}) as ${fn}`, params)) as unknown as T[];
    },
    async getConfigRows(): Promise<{ key: string; value: string }[]> {
      return await sdb.query<{ key: string; value: string }>(`select key, value from public.config`);
    },
    async listOpenEntryRows(mode: TradeMode): Promise<OpenEntryRow[]> {
      const rows = await sdb.query<OpenEntryRow>(
        `select market_id as "marketId", token_id as "tokenId", trade_date::text as "tradeDate"
           from public.live_orders
          where mode = $1
            and side = 'BUY'
            and purpose = 'entry'
            and status not in ('canceled', 'failed')
            and trade_date >= (now() - interval '${OPEN_ENTRY_LOOKBACK_DAYS} days')::date
          order by created_at`,
        [mode],
      );
      return Array.isArray(rows) ? rows : [];
    },
    async cityBucketIdentity(eventId: string, bucketIdx: number): Promise<CityBucketIdentity | null> {
      const rows = await sdb.query<CityBucketIdentity>(
        `select condition_id as "marketId", token_yes as "tokenId"
           from public.market_buckets
          where event_id = $1 and bucket_idx = $2
          limit 1`,
        [eventId, bucketIdx],
      );
      const r = Array.isArray(rows) ? rows[0] : undefined;
      return r && r.marketId && r.tokenId ? { marketId: r.marketId, tokenId: r.tokenId } : null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Single-instance guard (review finding #16) — a session advisory lock per (namespace, mode).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The advisory-lock namespace (classid) — 'TRDB' as an int4; fixed forever (the lock's identity). */
export const TRADE_BOT_LOCK_CLASS = 0x54524442;

/** The per-mode lock object id — dry-run and live daemons may coexist (mode-scoped ledgers, only live
 *  touches the venue); two SAME-mode daemons are the over-sell hazard and must contend. */
export function tradeBotLockObj(mode: TradeMode): number {
  return mode === 'live' ? 2 : 1;
}

/**
 * Try to take the trade-bot single-instance lock for `mode`. Session-scoped: it is held until this
 * process's DB session ends (sdb.end() / process exit), so a crashed daemon frees it automatically.
 * Returns false when another instance already holds it — the caller must refuse to start.
 *
 * NOTE: session advisory locks require a SESSION-mode (or direct) Postgres connection — the repo's
 * script DSN idiom (§11.2 DATABASE_URL, postgres-js). A transaction-mode pooler (PgBouncer :6543)
 * would detach the lock from this process; do not point DATABASE_URL at one for the daemon.
 */
export async function acquireTradeBotLock(sdb: ScriptDb, mode: TradeMode): Promise<boolean> {
  const rows = await sdb.query<{ locked: boolean }>(
    `select pg_try_advisory_lock($1, $2) as locked`,
    [TRADE_BOT_LOCK_CLASS, tradeBotLockObj(mode)],
  );
  return rows[0]?.locked === true;
}
