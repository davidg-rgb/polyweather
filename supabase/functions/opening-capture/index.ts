/** Edge Function entry — opening-capture (Phase 0 of the opening-convergence bot; the keyless forward
 * measurement harness — ARCHITECTURE-OPENING-CONVERGENCE.md §6.10a).
 * Schedule: ~every 2 min FIRST-SEEN poll (§16-D — the flat-open window is ≤~1h, so a slower sweep risks
 * missing it). Read-only against Polymarket; no key, no packages/trading. A structural clone of
 * cross-venue-capture/index.ts (the name + the ~2-min slot differ).
 */
import { fetchJson } from '../../../packages/io/src/index.ts';
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { openingCapture } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  const slot = Math.floor(now.getUTCMinutes() / 2) * 2; // ~2-min first-seen slot (§16-D)
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `opening-capture:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob(
    'opening-capture',
    periodKey,
    req,
    (ctx) => openingCapture(ctx, { now, fetchJson: (url, init, opts) => fetchJson(url, init, opts) }),
    { db },
  );
});
