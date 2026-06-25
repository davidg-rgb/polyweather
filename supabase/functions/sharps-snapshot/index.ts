/** Edge Function entry — sharps-snapshot (SPORTS-leaderboard roster + fingerprints, migration 0059). Schedule: 0 2 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { sharpsSnapshot } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // Daily period key — one snapshot per calendar day (leaderboard + fingerprints move slowly).
  const periodKey = `sharps-snapshot:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob(
    'sharps-snapshot',
    periodKey,
    req,
    (ctx) => sharpsSnapshot(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
