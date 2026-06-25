/** Edge Function entry — arb-depth-capture (Move 1 forward depth-capture for the complete-set
 * arbitrage, 8th signal, migration 0060). Schedule: every 30 min.
 *
 * For every open temperature ladder with lead≤2d AND age<2h, fetches the full CLOB book for
 * all buckets and captures depth, exec profit, and the fee-clearing flag into
 * complete_set_depth_captures (append-only, no position taken).
 *
 * Move 3 (fee-structure reopening monitor): once per day at the UTC hour configured below,
 * checks the full open-ladder universe and Slack-alerts if ANY ladder shows fee_cleared — the
 * mechanical trigger that reopens the signal (Polymarket restructured the weather taker fee).
 */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { arbDepthCapture } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // 30-minute period slot: each cron fire claims a distinct run.
  const slot = Math.floor(now.getUTCMinutes() / 30) * 30;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `arb-depth-capture:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob(
    'arb-depth-capture',
    periodKey,
    req,
    (ctx) => arbDepthCapture(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
