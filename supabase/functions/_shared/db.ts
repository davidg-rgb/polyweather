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
      // C2 (ADR-19) diagnostic — when a call resolves to the fabricated-empty
      // branch, record WHETHER PostgREST sent null (no rows over the wire) vs []
      // (an empty SETOF). The #2 capture defect makes list_active_stations()
      // return empty in the deployed isolate while returning 45 server-side; this
      // one structured line on the next real fire pins null-vs-[] deterministically.
      if (data === null || (Array.isArray(data) && data.length === 0)) {
        console.log(JSON.stringify({ rpc: fn, empty: true, dataWasNull: data === null }));
      }
      // PostgREST returns the BARE value for non-row-returning functions;
      // normalize to the [{ [fn]: value }] row shape every handler (and the
      // PGlite twin, which runs `select * from fn()`) consumes. Safe because
      // no migration fn is SETOF (tripwire in migrations.test.ts) and bare
      // jsonb fns return objects/scalars, never top-level arrays — so an
      // array here is always a RETURNS TABLE row set. Mirrors apps/web port.ts.
      return (Array.isArray(data) ? data : data === null ? [] : [{ [fn]: data }]) as T[];
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
  // LITERAL npm: specifier — the deploy-time bundler builds the eszip npm
  // snapshot from statically-visible specifiers only; the previous non-literal
  // import(spec) left supabase-js OUT of the snapshot and every hosted
  // function failed its first request with "Could not find constraint
  // '@supabase/supabase-js@2' in the list of packages" (2026-06-11). tsc
  // accepts the specifier via _shared/npm-specifiers.d.ts; vitest skips
  // analysis via @vite-ignore; Node never executes this path (tests inject).
  const mod = (await import(/* @vite-ignore */ 'npm:@supabase/supabase-js@2')) as {
    createClient: (u: string, k: string, o?: unknown) => SupabaseishClient;
  };
  const client = mod.createClient(url, key, { auth: { persistSession: false } });
  singleton = supabasePort(client);
  return singleton;
}
