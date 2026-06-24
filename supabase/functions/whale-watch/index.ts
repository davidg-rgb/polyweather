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
  // 10-minute slot key so each cron fire claims its own period (claim_job_run), not one slot per day.
  // ISO 'YYYY-MM-DDTHH:M' (15 chars) keeps the minute's tens digit; appending '0' floors to the 10-min slot.
  const periodKey = `whale-watch:${now.toISOString().slice(0, 15)}0`;
  const db = await getServiceDb();
  return runJob(
    'whale-watch',
    periodKey,
    req,
    (ctx) => whaleWatch(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
