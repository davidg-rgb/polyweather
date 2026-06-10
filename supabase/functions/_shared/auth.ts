/**
 * functions/_shared/auth — requireCronAuth (ARCHITECTURE.md §6.12, §11.5).
 *
 * Runtime-agnostic (Deno Edge Functions + Node tests): env via globalThis probing.
 */
import { AuthError, ConfigError } from '../../../packages/core/src/index.ts';

/** Deno.env in Edge Functions, process.env elsewhere. */
export function getEnv(name: string): string | undefined {
  const g = globalThis as {
    Deno?: { env: { get(n: string): string | undefined } };
    process?: { env: Record<string, string | undefined> };
  };
  if (g.Deno) return g.Deno.env.get(name);
  return g.process?.env[name];
}

/** Constant-time string compare — no early exit on first mismatching char. */
function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Constant-time compare of the 'x-cron-secret' header against env CRON_SECRET
 * (pg_cron passes it; admin trigger-job and the approve proxy pass it
 * server-side). Throws AuthError (401) on mismatch; ConfigError when the
 * secret is missing or under the §11.2 32-char floor (fail closed).
 */
export function requireCronAuth(req: Request): void {
  const secret = getEnv('CRON_SECRET');
  if (!secret || secret.length < 32) {
    throw new ConfigError('CRON_SECRET missing or shorter than 32 chars — refusing all job calls');
  }
  const header = req.headers.get('x-cron-secret') ?? '';
  if (!constantTimeEqual(header, secret)) {
    throw new AuthError('bad or missing x-cron-secret');
  }
}
