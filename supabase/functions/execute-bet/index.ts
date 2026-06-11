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
