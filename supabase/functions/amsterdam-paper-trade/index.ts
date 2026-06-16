/** Edge Function entry — amsterdam-paper-trade (Amsterdam paper-sim place + grade). Schedule: 30 15 * * * UTC. */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { amsterdamPaperTrade } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `amsterdam-paper-trade:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob(
    'amsterdam-paper-trade',
    periodKey,
    req,
    (ctx) => amsterdamPaperTrade(ctx, { now }),
    { db },
  );
});
