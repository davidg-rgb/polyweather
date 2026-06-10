/** Edge Function entry — snapshot-forecasts (§6.14). Schedule: 15 10,22 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { snapshotForecasts } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = now.getUTCHours() < 16 ? '10Z' : '22Z';
  const periodKey = `snapshot-forecasts:${now.toISOString().slice(0, 10)}T${slot}`;
  const db = await getServiceDb();
  const apiKey = getEnv('OPENMETEO_API_KEY');
  const prefix = apiKey ? 'customer-' : '';
  return runJob(
    'snapshot-forecasts',
    periodKey,
    req,
    (ctx) =>
      snapshotForecasts(ctx, {
        fetchJson: (url) => fetchJson(url),
        notify: (alert) => notifySlack(db, alert),
        slot,
        now,
        omForecastBase: `https://${prefix}api.open-meteo.com`,
        omPreviousRunsBase: `https://${prefix}previous-runs-api.open-meteo.com`,
        ...(apiKey ? { apiKey } : {}),
      }),
    { db },
  );
});
