/** Edge Function entry — cheap-early-panel (forward CHEAP-EARLY-ENTRY paper view snapshot, migration 0117).
 * Schedule: hourly (:47 — a clean minute lane). The cheap-early twin of maker-exit-panel: reads the fresh-allowlist
 * capture series via convergence_capture_inputs, runs the pure cheap-early replay view (core/sim/cheap-early-entry-view
 * → replayCheapEarlyPanel), records the small view (record_cheap_early_panel) + the §9R-E verdict
 * (record_cheap_early_gate, source='forward-cheap-early' — a DISTINCT source, invisible to the live-capital
 * interlock). Read-only against the DB inputs; no external API, no packages/trading (rail DORMANT). */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { cheapEarlyPanel } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // hourly slot key — one idempotent snapshot per hour (the panel only changes as events resolve).
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const periodKey = `cheap-early-panel:${now.toISOString().slice(0, 10)}T${hh}:00`;
  const db = await getServiceDb();
  return runJob('cheap-early-panel', periodKey, req, (ctx) => cheapEarlyPanel(ctx, { now }), { db });
});
