/** Edge Function entry — replica-forward (the badatmath-replica daily forward loop, migration 0056). Schedule: 0 5 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { replicaForward } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `replica-forward:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob(
    'replica-forward',
    periodKey,
    req,
    (ctx) => replicaForward(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
