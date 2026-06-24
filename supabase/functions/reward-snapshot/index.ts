/** Edge Function entry — reward-snapshot (REC-8/9 Phase A liquidity-reward time-series, migration 0057). Schedule: every 20 min. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { rewardSnapshot } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // 20-minute period slot so each cron fire claims a distinct run (parity with whale-watch's minute key).
  const slot = Math.floor(now.getUTCMinutes() / 20) * 20;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `reward-snapshot:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob(
    'reward-snapshot',
    periodKey,
    req,
    (ctx) => rewardSnapshot(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
