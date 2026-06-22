/** Edge Function entry — sharp-wallet-track (WEATHER-leaderboard + tracked-wallet position snapshot). Schedule: 0 16 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { sharpWalletTrack } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `sharp-wallet-track:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  return runJob(
    'sharp-wallet-track',
    periodKey,
    req,
    (ctx) => sharpWalletTrack(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
