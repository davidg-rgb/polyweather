/** Edge Function entry — build-distributions (§6.16). Schedule: 50 10,22 * * * UTC. */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { buildDistributions } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = now.getUTCHours() < 16 ? '10Z' : '22Z';
  const periodKey = `build-distributions:${now.toISOString().slice(0, 10)}T${slot}`;
  const db = await getServiceDb();
  return runJob(
    'build-distributions',
    periodKey,
    req,
    (ctx) => buildDistributions(ctx, { notify: (a) => notifySlack(db, a), now }),
    { db },
  );
});
