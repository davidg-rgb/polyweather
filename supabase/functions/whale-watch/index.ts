/** Edge Function entry — whale-watch (Polymarket large-trade alarm, migration 0055). Schedule: every 10 min. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { whaleWatch } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // 1-minute slot key so each every-minute cron fire claims its own period (claim_job_run) — alert ASAP.
  // ISO 'YYYY-MM-DDTHH:MM' (16 chars) = a distinct slot per minute (a 10-min key would 409 nine ticks in ten).
  const periodKey = `whale-watch:${now.toISOString().slice(0, 16)}`;
  const db = await getServiceDb();
  return runJob(
    'whale-watch',
    periodKey,
    req,
    (ctx) => whaleWatch(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
