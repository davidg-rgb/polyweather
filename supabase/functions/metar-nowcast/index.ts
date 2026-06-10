// Edge Function entry — metar-nowcast (§6.15). Schedule: every 15 minutes UTC.
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { metarNowcast } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `metar-nowcast:${now.toISOString().slice(0, 16)}`;
  const db = await getServiceDb();
  return runJob(
    'metar-nowcast',
    periodKey,
    req,
    (ctx) => metarNowcast(ctx, { fetchJson: (url) => fetchJson(url), now }),
    { db },
  );
});
