/** Edge Function entry — poll-markets (§6.17). Schedule: every 5 minutes UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { pollMarkets } from './handler.ts';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `poll-markets:${now.toISOString().slice(0, 16)}`;
  const db = await getServiceDb();
  return runJob(
    'poll-markets',
    periodKey,
    req,
    (ctx) =>
      pollMarkets(ctx, {
        fetchPage: (offset) =>
          fetchJson(
            `${GAMMA_BASE}/events?tag_id=104596&active=true&closed=false&limit=100&offset=${offset}`,
          ),
        fetchBook: (tokenId) => fetchJson(`${CLOB_BASE}/book?token_id=${tokenId}`),
        notify: (a) => notifySlack(db, a),
        // §6.20a chokepoint: live-mode expiry pulls the resting GTC via
        // execute-bet {action:'cancel'} over HTTP — never a direct clob call.
        cancelLiveOrder: async (betId) => {
          await fetch(`${getEnv('SUPABASE_URL')}/functions/v1/execute-bet`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-cron-secret': getEnv('CRON_SECRET') ?? '',
            },
            body: JSON.stringify({ betId, action: 'cancel' }),
          });
        },
        now,
        runId: crypto.randomUUID(),
      }),
    { db },
  );
});
