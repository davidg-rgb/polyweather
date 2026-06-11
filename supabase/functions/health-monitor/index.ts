/** Edge Function entry — health-monitor (§6.19). Schedule: every 30 min UTC. */
import { buildAlertBlocks, fetchJson, slackPost } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { notifySlack } from '../_shared/slack.ts';
import { healthMonitor } from './handler.ts';

/** API model slug → open-meteo.com/data directory (live-verified 2026-06-11). */
const META_DIR: Record<string, string> = {
  gfs_seamless: 'ncep_gfs013',
  ecmwf_ifs025: 'ecmwf_ifs025',
  icon_seamless: 'dwd_icon',
  jma_seamless: 'jma_gsm',
  gem_seamless: 'cmc_gem_gdps',
  meteofrance_seamless: 'meteofrance_arpege_world025',
  ukmo_seamless: 'ukmo_global_deterministic_10km',
  cma_grapes_global: 'cma_grapes_global',
  // best_match is a composite with no data directory — intentionally absent.
};

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
          // The data directories use real-model names, not API slugs — the
          // seamless composites map to their primary member (live-verified
          // 2026-06-11 via scripts/smoke-live-apis; unmapped/composite models
          // return null = sampled-not-alarmed).
          const dir = META_DIR[slug];
          if (!dir) return null;
          const meta = (await fetchJson(`https://api.open-meteo.com/data/${dir}/static/meta.json`)) as {
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
