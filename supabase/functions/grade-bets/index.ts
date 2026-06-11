/** Edge Function entry — grade-bets sweep (§6.19). Schedule: 0 6 * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { gradeEvent } from '../_shared/grading.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { gradeBetsSweep } from './handler.ts';

const DATA_API = 'https://data-api.polymarket.com';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `grade-bets:${now.toISOString().slice(0, 10)}`;
  const db = await getServiceDb();
  const wallet = getEnv('POLY_FUNDER_ADDRESS');
  return runJob(
    'grade-bets',
    periodKey,
    req,
    (ctx) =>
      gradeBetsSweep(ctx, {
        notify: (a) => notifySlack(db, a),
        gradeEvent: (eventId) => gradeEvent(db, ctx.config, eventId, { notify: (a) => notifySlack(db, a) }),
        ...(wallet ? { fetchPositions: () => fetchJson(`${DATA_API}/positions?user=${wallet}`) } : {}),
        now,
      }),
    { db },
  );
});
