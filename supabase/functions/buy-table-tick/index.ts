/** Edge Function entry — buy-table-tick (the CLOUD BUY-TABLE live lane, migration 0095).
 * Schedule: every 10 min. The 0095 cron stamps a per-tick periodKey into the request BODY at fire time
 * (the §8.1 idiom — runJob's body override claims it); this entry derives the same 10-min slot key as the
 * fallback for manual/keyless invocations. */
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
  const slot = Math.floor(now.getUTCMinutes() / 10) * 10; // 10-min slot fallback (the cron body key wins)
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `buy-table-tick:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
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
      }),
    { db },
  );
});
