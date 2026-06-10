/**
 * PGlite-backed DbPort — the test twin of functions/_shared/db.ts supabasePort.
 * rpc() calls the SAME 0011 SQL functions production calls via PostgREST, so
 * the race-critical semantics are tested against the real implementation.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { DbPort } from '../functions/_shared/db.ts';

/** Positional arg order per SQL function (PostgREST passes by name; PGlite needs positions). */
const FN_ARGS: Record<string, string[]> = {
  claim_job_run: ['p_job', 'p_period_key', 'p_wall_limit_sec'],
  complete_job_run: ['p_run_id', 'p_attempt', 'p_status', 'p_stats', 'p_error', 'p_duration_ms'],
  claim_alert: ['p_kind', 'p_severity', 'p_dedupe_key', 'p_title', 'p_body'],
  mark_alert_sent: ['p_alert_id'],
};

export function pglitePort(db: PGlite): DbPort {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      const order = FN_ARGS[fn];
      if (!order) throw new Error(`pglitePort: unknown rpc '${fn}' — add it to FN_ARGS`);
      const params = order.map((name) => {
        const v = args[name];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const placeholders = order.map((_, i) => `$${i + 1}`).join(', ');
      const res = await db.query<T>(`select * from public.${fn}(${placeholders})`, params);
      return res.rows;
    },
    async getConfigRows(): Promise<{ key: string; value: string }[]> {
      const res = await db.query<{ key: string; value: string }>('select key, value from config');
      return res.rows;
    },
  };
}
