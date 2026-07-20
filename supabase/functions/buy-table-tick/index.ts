/** Edge Function entry — buy-table-tick (the CLOUD BUY-TABLE live lane, migration 0095; fast lane 0114).
 * Schedule: ~every 2 min 00-10Z ('buy-table-tick-fast') + every 10 min otherwise ('buy-table-tick'). Both
 * crons stamp a MINUTE-precision periodKey into the request BODY at fire time (the §8.1 idiom — runJob's
 * body override claims it); this entry derives the same minute key as the fallback for manual/keyless
 * invocations, so every fire claims its own slot at any cadence ≥ 1/min. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { notifySlack } from '../_shared/slack.ts';
import { runJob } from '../_shared/runJob.ts';
import { buyTableTick } from './handler.ts';

// eszip npm-snapshot hints — NEVER executed. LiveExecutor (packages/trading/
// src/live.ts, F-032) lazy-imports these via non-literal specifiers so the
// apps/web webpack build never sees them; that also hides them from the
// deploy-time bundler, which would ship a snapshot missing both packages and
// 500 every live-mode fill at P10. Listing the SAME constraint strings as
// literals here puts them in the snapshot; the runtime resolves live.ts's
// non-literal lookups against it. Keep in lockstep with live.ts.
const eszipNpmHints = () => [
  import('npm:ethers@5'),
  import('npm:@polymarket/clob-client-v2@1'),
];
void eszipNpmHints;

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // minute-precision fallback — matches the cron body stamp's format (the cron body key wins when present)
  const periodKey = `buy-table-tick:${now.toISOString().slice(0, 16)}`;
  const db = await getServiceDb();
  return runJob(
    'buy-table-tick',
    periodKey,
    req,
    (ctx) =>
      buyTableTick(ctx, {
        now,
        getEnvVar: getEnv,
        notify: (a) => notifySlack(db, a),
        fetchJson: (url, init, opts) => fetchJson(url, init, opts),
      }),
    { db },
  );
});
