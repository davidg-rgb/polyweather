// Edge Function entry — metar-nowcast (§6.15). Schedule: every 15 minutes UTC.
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { buildDistributionForEvent } from '../_shared/distributions.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
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
    (ctx) =>
      metarNowcast(ctx, {
        fetchJson: (url) => fetchJson(url),
        now,
        // §6.16 nowcast variant, invoked in-process (never HTTP)
        rebuildNowcast: async (eventId) => {
          const r = await buildDistributionForEvent(db, ctx.config, eventId, {
            notify: (a) => notifySlack(db, a),
            now: new Date(),
          });
          return r.written > 0;
        },
      }),
    { db },
  );
});
