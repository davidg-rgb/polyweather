/** Edge Function entry — google-paper-panel (Google-picks-bucket forward-paper view snapshot, migration 0086).
 * Schedule: every 15 min. The Google twin of convergence-panel: reads the fresh-allowlist capture series + the
 * per-event latest Google forecast via google_paper_inputs, runs the pure Google-bucket replay view
 * (core/sim/google-bucket-view → buildGoogleView), and records the small view (record_google_paper). Read-only
 * against the DB inputs; no external API, no packages/trading (rail paper/DORMANT). */
import { getServiceDb } from '../_shared/db.ts';
import { runJob } from '../_shared/runJob.ts';
import { googlePaperPanel } from './handler.ts';

const deno = (globalThis as {
  Deno?: { serve(handler: (req: Request) => Response | Promise<Response>): void };
}).Deno;

deno?.serve(async (req: Request) => {
  const now = new Date();
  // 15-min slot key — one idempotent snapshot per quarter-hour (the panel moves slowly).
  const slot = Math.floor(now.getUTCMinutes() / 15) * 15;
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(slot).padStart(2, '0');
  const periodKey = `google-paper-panel:${now.toISOString().slice(0, 10)}T${hh}:${mm}`;
  const db = await getServiceDb();
  return runJob('google-paper-panel', periodKey, req, (ctx) => googlePaperPanel(ctx, { now }), { db });
});
