/** Edge Function entry — city-paper-trade (multi-city paper-sim place + grade, migration 0070). Schedule: 0 10 * * * UTC. */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { cityPaperTrade } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `city-paper-trade:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob('city-paper-trade', periodKey, req, (ctx) => cityPaperTrade(ctx, { now }), { db });
});
