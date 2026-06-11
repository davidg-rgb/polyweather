/**
 * The Supabase-client → WebDb port wrapper shared by the API tier (prod.ts,
 * session parsed from a Request's cookie header) and the RSC tier
 * (supabase.ts, session from next/headers cookies).
 *
 * Wrapping rules match functions/_shared supabasePort: PostgREST returns a
 * bare scalar/object for non-row-returning functions — normalize to the
 * [{ [fn]: value }] row shape that every caller (and the PGlite test twin,
 * which runs `select * from fn()`) consumes.
 */
import type { WebDb } from './api/deps.ts';

export interface SupabaseishClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
  auth: { getUser(): Promise<{ data: { user: { email?: string } | null } }> };
}

export function webPort(client: SupabaseishClient): WebDb {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new Error(`rpc ${fn} failed: ${error.message}`);
      return (Array.isArray(data) ? data : data === null ? [] : [{ [fn]: data }]) as T[];
    },
    async getConfigRows(): Promise<{ key: string; value: string }[]> {
      const { data, error } = await client.from('config').select('key, value');
      if (error) throw new Error(`config select failed: ${error.message}`);
      return (data ?? []) as { key: string; value: string }[];
    },
  };
}
