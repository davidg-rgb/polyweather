/**
 * Edge Function entry — discover-markets (§6.13).
 * Schedule: 10 2,4,5,11,17 * * * UTC (migration 0009).
 */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { discoverMarkets } from './handler.ts';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `discover-markets:${now.toISOString().slice(0, 10)}T${String(now.getUTCHours()).padStart(2, '0')}Z`;
  const db = await getServiceDb();
  return runJob(
    'discover-markets',
    periodKey,
    req,
    (ctx) =>
      discoverMarkets(ctx, {
        fetchPage: (offset) =>
          fetchJson(
            `${GAMMA_BASE}/events?tag_id=104596&active=true&closed=false&limit=100&offset=${offset}`,
          ),
        notify: (alert) => notifySlack(db, alert),
        todayUtcISO: new Date().toISOString().slice(0, 10),
      }),
    { db },
  );
});
