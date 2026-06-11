/** Edge Function entry — health-monitor (§6.19). Schedule: every 30 min UTC. */
import { buildAlertBlocks, fetchJson, slackPost } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { healthMonitor } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const periodKey = `health-monitor:${now.toISOString().slice(0, 13)}:${now.getUTCMinutes() < 30 ? '00' : '30'}`;
  const db = await getServiceDb();
  return runJob(
    'health-monitor',
    periodKey,
    req,
    (ctx) =>
      healthMonitor(ctx, {
        notify: (a) => notifySlack(db, a),
        postAlert: async (a) => {
          const webhook = getEnv('SLACK_WEBHOOK_URL');
          return webhook ? slackPost(webhook, buildAlertBlocks(a)) : false;
        },
        fetchModelMeta: async (slug) => {
          // Docs-based meta shape — re-verified by scripts/smoke-live-apis (P8).
          const meta = (await fetchJson(`https://api.open-meteo.com/data/${slug}/static/meta.json`)) as {
            last_run_initialisation_time?: number;
          };
          return typeof meta?.last_run_initialisation_time === 'number'
            ? meta.last_run_initialisation_time
            : null;
        },
        now,
      }),
    { db },
  );
});
