/** Edge Function entry — snapshot-ensembles (§6.14). Schedule: 35 10,22 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { snapshotEnsembles } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = now.getUTCHours() < 16 ? '10Z' : '22Z';
  const periodKey = `snapshot-ensembles:${now.toISOString().slice(0, 10)}T${slot}`;
  const db = await getServiceDb();
  const apiKey = getEnv('OPENMETEO_API_KEY');
  const prefix = apiKey ? 'customer-' : '';
  return runJob(
    'snapshot-ensembles',
    periodKey,
    req,
    (ctx) =>
      snapshotEnsembles(ctx, {
        fetchJson: (url) => fetchJson(url),
        slot,
        now,
        omEnsembleBase: `https://${prefix}ensemble-api.open-meteo.com`,
        ...(apiKey ? { apiKey } : {}),
      }),
    { db },
  );
});
