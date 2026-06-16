/**
 * scripts/lib/script-db — direct-Postgres access for local CLIs (§6.22).
 * Scripts talk straight SQL over DATABASE_URL (service role); tests inject a
 * PGlite-backed twin of the same interface.
 *
 * This is the single RETRYING DB path, the mirror of packages/io/http's single
 * retrying HTTP path: a transient connection drop (the hosted Supabase pooler
 * recycling a connection mid-query) rejects with a raw ECONNRESET that would
 * otherwise crash a long, unattended backfill. We retry such drops with
 * exponential backoff + jitter; postgres-js lazily reconnects for the next
 * attempt. Server-side query rejections (unique-violation, etc.) are NOT
 * retried — only connection-level failures. Safe because every script query in
 * this repo is idempotent (upserts / reads / rebuilds).
 */
import postgres from 'postgres';

export interface ScriptDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  end(): Promise<void>;
}

export interface ScriptDbOpts {
  /** Retries AFTER the first attempt on transient connection errors (default 3). */
  retries?: number;
  /** Base backoff in ms; attempt n waits base × 2^(n−1) × jitter (default 400). */
  backoffMs?: number;
  /** Injectable sleeper (tests pass a no-op to skip real backoff). */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transient = the connection dropped or could not be (re)established, NOT a query
 * the server rejected on its merits. postgres-js surfaces socket failures with a
 * Node errno code and its own CONNECTION_* codes; Postgres class-08 (connection
 * exception) and cannot-connect / admin-shutdown SQLSTATEs are connection-level
 * too. App SQLSTATEs (e.g. 23505 unique_violation) are NOT transient.
 */
const TRANSIENT_CODES = new Set([
  // Node socket errno
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND',
  // postgres-js connection lifecycle
  'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', 'CONNECTION_CONNECT_TIMEOUT', 'CONNECT_TIMEOUT',
  // Postgres class 08 (connection exception) + cannot-connect-now / admin shutdown
  '08000', '08001', '08003', '08004', '08006', '57P01', '57P03', '53300',
]);

const TRANSIENT_MSG = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|EAI_AGAIN|Connection terminated|connection closed|CONNECTION_CLOSED|CONNECTION_ENDED|write CONNECTION/i;

export function isTransientDbError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return TRANSIENT_MSG.test(msg);
}

/**
 * Run `exec` with retry-on-transient-connection-error. Extracted from makeScriptDb
 * so the retry policy is unit-testable without a live Postgres.
 */
export async function runWithDbRetry<T>(
  exec: () => Promise<T>,
  opts?: ScriptDbOpts,
): Promise<T> {
  const retries = opts?.retries ?? 3;
  const backoffMs = opts?.backoffMs ?? 400;
  const sleep = opts?.sleep ?? realSleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1) * (1 + Math.random() * 0.25));
    try {
      return await exec();
    } catch (e) {
      lastErr = e;
      if (!isTransientDbError(e)) throw e;
      // transient connection drop — fall through; postgres-js reconnects lazily.
    }
  }
  throw lastErr;
}

export function makeScriptDb(databaseUrl?: string, opts?: ScriptDbOpts): ScriptDb {
  const url = databaseUrl ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set — scripts need direct Postgres access (§11.2)');
  }
  const sql = postgres(url, { max: 4, prepare: false });
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return runWithDbRetry(
        async () => (await sql.unsafe(text, params as never[])) as unknown as T[],
        opts,
      );
    },
    async end(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
