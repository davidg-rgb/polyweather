/**
 * functions/_shared/db — service-role data access (ARCHITECTURE.md §6.12).
 *
 * Jobs consume the narrow DbPort interface; production backs it with
 * supabase-js (PostgREST) inside the Deno edge runtime, and the test suite
 * backs it with PGlite so the SAME SQL functions (migration 0011) are
 * exercised end-to-end.
 */
import { ConfigError } from '../../../packages/core/src/index.ts';
import { getEnv } from './auth.ts';

export interface DbPort {
  /** Call a 0011 SQL function and return its rows. */
  rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]>;
  /** All config-table rows (tunables + halt keys + wiring). */
  getConfigRows(): Promise<{ key: string; value: string }[]>;
}

interface SupabaseishClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from(table: string): {
    select(cols: string): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

let singleton: DbPort | null = null;

/** Wrap any supabase-js-shaped client as a DbPort (exported for the test PGlite twin). */
export function supabasePort(client: SupabaseishClient): DbPort {
  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      const { data, error } = await client.rpc(fn, args);
      if (error) throw new ConfigError(`rpc ${fn} failed: ${error.message}`);
      return (Array.isArray(data) ? data : data === null ? [] : [data]) as T[];
    },
    async getConfigRows(): Promise<{ key: string; value: string }[]> {
      const { data, error } = await client.from('config').select('key, value');
      if (error) throw new ConfigError(`config select failed: ${error.message}`);
      return (data ?? []) as { key: string; value: string }[];
    },
  };
}

/**
 * Service-role client factory — singleton per isolate. Deno edge runtime only
 * (supabase-js arrives via the npm: specifier); tests inject their own port.
 */
export async function getServiceDb(): Promise<DbPort> {
  if (singleton) return singleton;
  const url = getEnv('SUPABASE_URL');
  const key = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new ConfigError('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  }
  // Dynamic non-literal specifier: resolved by Deno at runtime, invisible to tsc/Node.
  const specifier = 'npm:@supabase/supabase-js@2';
  const mod = (await import(specifier)) as {
    createClient: (u: string, k: string, o?: unknown) => SupabaseishClient;
  };
  const client = mod.createClient(url, key, { auth: { persistSession: false } });
  singleton = supabasePort(client);
  return singleton;
}
