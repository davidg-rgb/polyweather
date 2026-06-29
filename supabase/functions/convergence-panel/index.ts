/** Edge Function entry — convergence-panel (opening-convergence forward-paper view snapshot, migration 0069).
 * Schedule: every 15 min. Reads the raw fresh-allowlist capture series via convergence_capture_inputs, runs the
 * pure bracket-replay view (core/sim/opening-convergence-view), and records the small view via
 * record_convergence_panel. Read-only against the DB inputs; no external API, no packages/trading (rail paper). */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { convergencePanel } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // 15-min slot key — one idempotent snapshot per quarter-hour (the panel moves slowly).
  const slot = Math.floor(now.getUTCMinutes() / 15) * 15;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `convergence-panel:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob('convergence-panel', periodKey, req, (ctx) => convergencePanel(ctx, { now }), { db });
});
