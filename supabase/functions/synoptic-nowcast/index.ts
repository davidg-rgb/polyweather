// Edge Function entry — synoptic-nowcast (DATA-SOURCES.md §Synoptic).
// Schedule: 5,19,35,49 * * * * (15-min odd-minute lane, checked vs LIVE prod crons; quarters clear).
// CAPTURE-ONLY since 2026-07-25 (resolution-oracle finding, OBS-TRANSMISSION.md addendum):
// 5-min obs are NOT resolution-grade — this lane logs synoptic_obs and never touches intraday_max.
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { synopticNowcast } from './handler.ts';

const deno = (globalThis as {
  Deno?: {
    serve(handler: (req: Request) => Response | Promise<Response>): void;
    env: { get(name: string): string | undefined };
  };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `synoptic-nowcast:${now.toISOString().slice(0, 16)}`;
  const db = await getServiceDb();
  return runJob(
    'synoptic-nowcast',
    periodKey,
    req,
    (ctx) =>
      synopticNowcast(ctx, {
        fetchJson: (url) => fetchJson(url),
        now,
        token: deno?.env.get('SYNOPTIC_PUBLIC_TOKEN'),
      }),
    { db },
  );
});
