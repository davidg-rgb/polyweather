/** Edge Function entry — fetch-actuals (§6.15). Schedule: 20 * * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { gradeEvent } from '../_shared/grading.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { fetchActuals } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `fetch-actuals:${now.toISOString().slice(0, 13)}`;
  const db = await getServiceDb();
  const apiKey = getEnv('OPENMETEO_API_KEY');
  return runJob(
    'fetch-actuals',
    periodKey,
    req,
    (ctx) =>
      fetchActuals(ctx, {
        fetchJson: (url) => fetchJson(url),
        fetchText: async (url) => {
          const res = await fetch(url);
          return res.text();
        },
        notify: (alert) => notifySlack(db, alert),
        gradeEvent: (eventId) => gradeEvent(db, ctx.config, eventId, { notify: (a) => notifySlack(db, a) }),
        now,
        omArchiveBase: `https://${apiKey ? 'customer-' : ''}archive-api.open-meteo.com`,
        ...(apiKey ? { apiKey } : {}),
      }),
    { db },
  );
});
