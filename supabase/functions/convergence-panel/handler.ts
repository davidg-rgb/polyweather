/**
 * convergence-panel — the 15-min opening-convergence forward-paper view tick (migration 0069).
 *
 * One idempotent run: pull the RAW fresh-allowlist capture series + the venue resolution map
 * (convergence_capture_inputs, service-role), run the PURE bracket-replay view (buildConvergenceView —
 * the SAME engine the bracket-score scorer uses: replayPanel/replayEvent over the §9R-locked config), and
 * store the small computed view via record_convergence_panel. The page reads only that snapshot.
 *
 * Pinned to BOT_DEFAULTS (the §9R-locked 10-city TRADABLE allowlist + per-position stake + take-profit +
 * fee/depth) — intentionally NOT config-driven: it does NOT read the live bot.* config (in particular it
 * ignores bot.cities, the ~45-city CAPTURE universe) so the page's entries/gate/money match the authoritative
 * opening-bracket-score scorer's scope, not the broader capture set. To re-scope the dashboard, change
 * BOT_DEFAULTS, not the config table. NOT trading — read-only analytics; the bot rail stays paper/DORMANT
 * (FINDINGS.md, the 12th signal). A capture gap just yields a smaller/empty view, never a failed job — and
 * the per-city fetch-error count is surfaced into the stored view so the page can flag a silent undercount.
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import {
  BOT_DEFAULTS,
  buildConvergenceView,
  type RawCaptureRow,
  type RawResolution,
} from '../../../packages/core/src/index.ts';

/** the look-back window — wide enough for the §9R-E gate (≥40 markets / ≥7 days) to accrue. */
const PANEL_DAYS = 21;

export interface ConvergencePanelDeps {
  now: Date;
}

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
}

export async function convergencePanel(ctx: JobCtx, deps: ConvergencePanelDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // Use the §9R-locked code defaults (the 10-city TRADABLE allowlist + perPositionUsd stake + tpDeltaPp +
  // fee/depth) — NOT the live `bot.cities` config, which is the 45-city CAPTURE universe. This pins the
  // dashboard to the SAME scope as the authoritative opening-bracket-score scorer (the 10-city §9R allowlist),
  // so the page's entries/gate/money match the scorer rather than the broader capture set.
  const cfg = BOT_DEFAULTS;

  // 1) raw inputs (trimmed buckets) for the fresh-allowlist window — fetched PER CITY. The whole-allowlist
  // build (~5k tick rows × a per-row bucket-trim) exceeds the 8s PostgREST statement cap; one city is ~470
  // rows and trims in well under a second, so we page by city and merge. Robust as the panel grows.
  const captures: RawCaptureRow[] = [];
  const resolutions: RawResolution[] = [];
  let cityErrors = 0;
  for (const city of cfg.cities) {
    try {
      const r = await db.rpc<{ convergence_capture_inputs: CaptureInputs }>('convergence_capture_inputs', {
        p_days: PANEL_DAYS,
        p_cities: [city],
      });
      const inp = r[0]?.convergence_capture_inputs ?? { captures: [], resolutions: [] };
      if (Array.isArray(inp.captures)) captures.push(...inp.captures);
      if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
    } catch (e) {
      cityErrors++;
      log('city inputs fetch failed (non-fatal)', { city, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // 2) the pure view (entries / exits / per-day / tuning / fictive money tracker / §9R-E gate). cityErrors is
  //    threaded in so the page can flag when allowlist cities were dropped this tick (a silent gate undercount).
  const view = { ...buildConvergenceView(captures, resolutions, cfg), days: PANEL_DAYS, cityErrors };

  // 3) store the small snapshot.
  const w = await db.rpc<{ record_convergence_panel: number }>('record_convergence_panel', { p_view: view });
  const snapshotId = Number(w[0]?.record_convergence_panel ?? 0);

  const stats: JobStats = {
    asOf: deps.now.toISOString(),
    cityErrors,
    captureRows: captures.length,
    freshEvents: view.nFreshEvents,
    entries: view.entries.length,
    nMarkets: view.gate.nMarkets,
    label: view.gate.label,
    snapshotId,
  };
  log('convergence-panel complete', stats);
  return stats;
}
