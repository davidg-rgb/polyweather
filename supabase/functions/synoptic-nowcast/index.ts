// Edge Function entry — synoptic-nowcast (DATA-SOURCES.md §Synoptic).
// Schedule: 5,19,35,49 * * * * (15-min odd-minute lane, checked vs LIVE prod crons; quarters clear).
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { buildDistributionForEvent } from '../_shared/distributions.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
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
