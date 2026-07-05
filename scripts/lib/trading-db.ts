/**
 * scripts/lib/trading-db — a `TradingDb` (packages/trading) backed by the local `ScriptDb` (direct
 * service-role Postgres over DATABASE_URL). Shared by the live trading daemon + the credential smoke.
 *
 * The runner (service_role, no operator jwt) reaches the 0082 activation console + the T1 order ledger
 * through Postgres directly. Every RETURNS-jsonb / RETURNS-scalar function is called as
 * `select public.fn(named => $n) as fn`, so the row shape is `[{ [fn]: value }]` — EXACTLY what supabasePort
 * yields and what tradeConfig.ts / order-ledger.ts read (`rows[0].<fn>`). Array params (text[]) are inlined
 * as `array[$a,$b,…]::text[]`; object params (jsonb) are JSON-stringified + cast `::jsonb`; scalars bind
 * plainly. (This file imports only the `TradingDb` TYPE from packages/trading — the §15 boundary allow-lists
 * it alongside the two scripts.)
 */
import type { TradingDb } from '../../packages/trading/src/index.ts';
import type { ScriptDb } from './script-db.ts';

export function makeTradingDb(sdb: ScriptDb): TradingDb {
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
  };
}
