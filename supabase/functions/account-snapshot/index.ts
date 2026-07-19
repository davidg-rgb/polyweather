/** Edge Function entry — account-snapshot (venue cash + positions marks, migration 0113). Schedule: 9,39 * * * * UTC. */
import { fetchJson } from '../../../packages/io/src/index.ts';

// eszip npm-snapshot hints — NEVER executed (the buy-table-tick F-032 idiom, keep in lockstep with
// live.ts): createClobClient lazy-imports these via non-literal specifiers, so the deploy-time bundler
// needs the literal constraint strings here or the snapshot ships without them and the cash read fails
// with "Could not find constraint 'ethers@5'" (the first live fire's exact note).
const eszipNpmHints = () => [
  import('npm:ethers@5'),
  import('npm:@polymarket/clob-client-v2@1'),
];
void eszipNpmHints;
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { accountSnapshot } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // Half-hour period key — one snapshot per cron slot; a manual re-fire inside the slot is a no-op.
  const periodKey = `account-snapshot:${now.toISOString().slice(0, 13)}:${now.getUTCMinutes() < 30 ? '00' : '30'}`;
  const db = await getServiceDb();
  return runJob(
    'account-snapshot',
    periodKey,
    req,
    (ctx) => accountSnapshot(ctx as { db: Parameters<typeof accountSnapshot>[0]['db'] }, {
      now,
      fetchJson: (url, init, opts) => fetchJson(url, init, opts),
    }),
    { db },
  );
});
