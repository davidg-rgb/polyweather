/** Edge Function entry — snapshot-sources (§ external-source accuracy tracking). Schedule: 25 10,22 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { sourcesFromKeys } from '../_shared/source-capture.ts';
import { snapshotSources } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = now.getUTCHours() < 16 ? '10Z' : '22Z';
  const periodKey = `snapshot-sources:${now.toISOString().slice(0, 10)}T${slot}`;
  const db = await getServiceDb();
  const sources = sourcesFromKeys({
    owm: getEnv('OPENWEATHERMAP_API_KEY'),
    weatherapi: getEnv('WEATHERAPI_API_KEY'),
  });
  return runJob(
    'snapshot-sources',
    periodKey,
    req,
    (ctx) =>
      snapshotSources(ctx, {
        fetchJson: (url) => fetchJson(url),
        notify: (alert) => notifySlack(db, alert),
        sources,
        now,
      }),
    { db },
  );
});
