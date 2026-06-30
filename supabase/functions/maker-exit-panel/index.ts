/** Edge Function entry — maker-exit-panel (forward maker-exit paper view snapshot, migration 0073).
 * Schedule: every 15 min. The maker-exit twin of convergence-panel: reads the fresh-allowlist capture series via
 * convergence_capture_inputs, runs the pure maker-exit replay view (core/sim/opening-maker-exit-view →
 * replayMakerExitPanel), records the small view (record_maker_exit_panel) + the §9R-E verdict
 * (record_bot_gate_snapshot, source='forward') + a liveness tick (record_bot_tick). Read-only against the DB
 * inputs; no external API, no packages/trading (rail paper/DORMANT). */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { makerExitPanel } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // 15-min slot key — one idempotent snapshot per quarter-hour (the panel moves slowly).
  const slot = Math.floor(now.getUTCMinutes() / 15) * 15;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `maker-exit-panel:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob('maker-exit-panel', periodKey, req, (ctx) => makerExitPanel(ctx, { now }), { db });
});
