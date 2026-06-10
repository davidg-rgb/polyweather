/**
 * scripts/lib/script-db — direct-Postgres access for local CLIs (§6.22).
 * Scripts talk straight SQL over DATABASE_URL (service role); tests inject a
 * PGlite-backed twin of the same interface.
 */
import postgres from 'postgres';

export interface ScriptDb {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  end(): Promise<void>;
}

export function makeScriptDb(databaseUrl?: string): ScriptDb {
  const url = databaseUrl ?? process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL is not set — scripts need direct Postgres access (§11.2)');
  }
  const sql = postgres(url, { max: 4, prepare: false });
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async end(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
