/** Edge Function entry — execute-bet (§6.20a). On-demand, synchronous, never cron-scheduled. */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getEnv } from '../_shared/auth.ts';
import { getServiceDb } from '../_shared/db.ts';
import { notifySlack } from '../_shared/slack.ts';
import { executeBet } from './handler.ts';

const CLOB_BASE = 'https://clob.polymarket.com';
// The documented geo-restrictions list (research REPORT-polymarket-api.md §5
// — no structured geoblock API exists); goLiveGate scans it for Sweden and
// fails closed on any fetch error.
const GEOBLOCK_URL = 'https://docs.polymarket.com/api-reference/geoblock.md';

// eszip npm-snapshot hints — NEVER executed. LiveExecutor (packages/trading/
// src/live.ts, F-032) lazy-imports these via non-literal specifiers so the
// apps/web webpack build never sees them; that also hides them from the
// deploy-time bundler, which would ship a snapshot missing both packages and
// 500 every live-mode fill at P10. Listing the SAME constraint strings as
// literals here puts them in the snapshot; the runtime resolves live.ts's
// non-literal lookups against it. Keep in lockstep with live.ts.
const eszipNpmHints = () => [
  import('npm:ethers@5'),
  import('npm:@polymarket/clob-client@4'),
];
void eszipNpmHints;

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const db = await getServiceDb();
  return executeBet(req, {
    db,
    fetchBook: (tokenId) => fetchJson(`${CLOB_BASE}/book?token_id=${tokenId}`),
    fetchGeoblock: async () => {
      const r = await fetch(GEOBLOCK_URL);
      if (!r.ok) throw new Error(`geoblock fetch ${r.status}`);
      return r.text();
    },
    getEnvVar: getEnv,
    notify: (a) => notifySlack(db, a),
    now: () => new Date(),
  });
});
