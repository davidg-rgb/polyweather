/**
 * Operator-API dependency surface (ARCHITECTURE.md §8.2, §6.21).
 *
 * Route handlers are framework-free (Request → Response) and consume this
 * port — production binds it in prod.ts (RLS-scoped session client + the
 * CRON_SECRET-bearing server-side proxies); tests bind PGlite + the real
 * execute-bet handler.
 */

/** Structurally identical to functions/_shared DbPort / packages/trading TradingDb. */
export interface WebDb {
  rpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<T[]>;
  getConfigRows(): Promise<{ key: string; value: string }[]>;
}

export interface WebAlert {
  kind: string;
  severity: 'INFO' | 'ACTION' | 'WARN' | 'CRITICAL';
  title: string;
  body: string;
  dedupeKey?: string;
}

export interface ApiDeps {
  /** RLS-scoped (session-cookie) PostgREST port — never the service role (§11.5). */
  db: WebDb;
  /** Authenticated session email, or null. */
  getSessionEmail(): Promise<string | null>;
  /** The single allow-listed operator (env OPERATOR_EMAIL). */
  operatorEmail: string;
  /** Server-side proxy to /functions/v1/execute-bet — adds CRON_SECRET (ADR-10). */
  proxyExecuteBet(body: { betId: string; action?: 'place' | 'cancel' }): Promise<Response>;
  /** Server-side proxy to /functions/v1/{job} with a manual period key. */
  proxyTriggerJob(job: string, periodKey: string): Promise<Response>;
  notify(alert: WebAlert): Promise<boolean>;
  now(): Date;
}

export const json = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
