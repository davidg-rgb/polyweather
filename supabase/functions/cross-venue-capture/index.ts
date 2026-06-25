/** Edge Function entry — cross-venue-capture (the forward matched-panel capture for the cross-venue
 * Kalshi ↔ Polymarket relative-value measurement, 10th-signal candidate, migration 0062).
 * Schedule: every 30 min.
 *
 * For the 6 US cities both venues list daily-high markets for, fetches both order books top-of-book
 * CONTEMPORANEOUSLY (Gamma + Kalshi), runs the cross-venue engine, and captures the divergence +
 * executable basis-adjusted edge into cross_venue_captures (append-only, no position taken).
 */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { crossVenueCapture } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = Math.floor(now.getUTCMinutes() / 30) * 30;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `cross-venue-capture:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob(
    'cross-venue-capture',
    periodKey,
    req,
    (ctx) => crossVenueCapture(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
