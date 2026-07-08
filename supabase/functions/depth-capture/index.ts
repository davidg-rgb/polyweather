/** Edge Function entry — depth-capture (the continuous executable-depth layer for market_snapshots, 0087).
 * Schedule: every 5 min.
 *
 * Walks the TRUE CLOB depth of near-dated live 'highest' buckets and writes the computed depth into
 * market_snapshots.depth (money-path-safe — poll-markets is untouched). Read-only against Polymarket, keyless.
 */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { depthCapture } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = Math.floor(now.getUTCMinutes() / 5) * 5;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `depth-capture:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob(
    'depth-capture',
    periodKey,
    req,
    (ctx) => depthCapture(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
