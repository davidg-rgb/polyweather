/** Edge Function entry — run-calibration (§6.18). Schedule: 30 11 * * * UTC. */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { runCalibration } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `run-calibration:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob(
    'run-calibration',
    periodKey,
    req,
    (ctx) => runCalibration(ctx, { notify: (a) => notifySlack(db, a), now }),
    { db },
  );
});
