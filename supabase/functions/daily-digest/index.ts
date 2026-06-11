/** Edge Function entry — daily-digest (§6.19). Schedule: 0 7 * * * UTC. */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { dailyDigest } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `daily-digest:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob(
    'daily-digest',
    periodKey,
    req,
    (ctx) => dailyDigest(ctx, { notify: (a) => notifySlack(db, a), now }),
    { db },
  );
});
