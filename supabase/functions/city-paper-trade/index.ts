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
  // Optional manual GAP-FILL: a request body { targetDate: 'YYYY-MM-DD' } overrides each city's local "today",
  // so the operator can backfill a specific day the daily tick missed (e.g. the 0081 defect's 2026-07-03/04
  // cities:0 zeros — docs/ops/CITY-SIM-PLACEMENT-FIX.md §3). Pair it with a unique { periodKey } (runJob reads
  // that from the same body) so the retrigger does not 409 against the day's already-claimed slot. Absent/invalid
  // body → the normal daily tick. Same req.clone().json() idiom runJob uses (req's own body is never consumed).
  let targetDate: string | undefined;
  try {
    const body = (await req.clone().json()) as { targetDate?: unknown };
    if (typeof body?.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.targetDate)) {
      targetDate = body.targetDate;
    }
  } catch {
    // no/invalid body — normal daily tick (each city's local today)
  }
  return runJob('city-paper-trade', periodKey, req, (ctx) => cityPaperTrade(ctx, { now, targetDate }), { db });
});
