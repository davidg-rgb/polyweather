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
 *
 * v7 (2026-07-03, WS-1): the per-city fetch goes through the SAME bounded worker pool as maker-exit-panel v4
 * (concurrency 5 / 30s per-city timeout / 240s overall budget / partial-view degradation) + the 0077
 * server-thinned RPC. The v6 sequential loop had NO fetch timeout — one hung statement stalled the whole tick
 * past the ~400s isolate wall (the 2026-07-03 incident class; the cron was paused on v6 pending this fix).
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

/**
 * per-city fetch tuning — mirror of maker-exit-panel v4 (one incident class, one fix shape): bounded
 * concurrency keeps each statement under the 8s PostgREST cap while collapsing the wall clock; the per-city
 * timeout bounds a hung fetch (the DbPort fetch has none); the overall budget degrades to a PARTIAL view
 * (skipped cities count into cityErrors, which the page already surfaces) — a partial snapshot beats a dead tick.
 */
const FETCH_CONCURRENCY = 5;
const CITY_TIMEOUT_MS = 30_000;
const FETCH_BUDGET_MS = 240_000;

export interface ConvergencePanelDeps {
  now: Date;
  /** test seams — production uses the module defaults above. */
  fetchConcurrency?: number;
  cityTimeoutMs?: number;
  fetchBudgetMs?: number;
}

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
}

/** race a promise against a rejection timer (the DbPort has no fetch timeout); always clears the timer. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const killer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([p, killer]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function convergencePanel(ctx: JobCtx, deps: ConvergencePanelDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // Use the §9R-locked code defaults (the 10-city TRADABLE allowlist + perPositionUsd stake + tpDeltaPp +
  // fee/depth) — NOT the live `bot.cities` config, which is the 45-city CAPTURE universe. This pins the
  // dashboard to the SAME scope as the authoritative opening-bracket-score scorer (the 10-city §9R allowlist),
  // so the page's entries/gate/money match the scorer rather than the broader capture set.
  const cfg = BOT_DEFAULTS;

  // 1) raw inputs (trimmed buckets; since 0077 server-thinned to the 20-min replay grid) for the
  //    fresh-allowlist window — fetched PER CITY through the bounded worker pool (see the tuning block above);
  //    merge the per-city results. Interleaved arrival order is safe: buildEvents groups per event and sorts
  //    ticks by capturedAt internally.
  const fetchConcurrency = deps.fetchConcurrency ?? FETCH_CONCURRENCY;
  const cityTimeoutMs = deps.cityTimeoutMs ?? CITY_TIMEOUT_MS;
  const fetchBudgetMs = deps.fetchBudgetMs ?? FETCH_BUDGET_MS;
  const captures: RawCaptureRow[] = [];
  const resolutions: RawResolution[] = [];
  let cityErrors = 0;
  let budgetSkipped = 0;
  const fetchStarted = Date.now();
  let nextCity = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextCity++;
      if (i >= cfg.cities.length) return;
      const city = cfg.cities[i]!;
      if (Date.now() - fetchStarted > fetchBudgetMs) {
        budgetSkipped++;
        cityErrors++;
        continue;
      }
      try {
        const r = await withTimeout(
          db.rpc<{ convergence_capture_inputs: CaptureInputs }>('convergence_capture_inputs', {
            p_days: PANEL_DAYS,
            p_cities: [city],
          }),
          cityTimeoutMs,
          `convergence_capture_inputs(${city}) timed out after ${cityTimeoutMs}ms`,
        );
        const inp = r[0]?.convergence_capture_inputs ?? { captures: [], resolutions: [] };
        if (Array.isArray(inp.captures)) captures.push(...inp.captures);
        if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
      } catch (e) {
        cityErrors++;
        log('city inputs fetch failed (non-fatal)', { city, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(fetchConcurrency, cfg.cities.length)) }, () => worker()),
  );
  if (budgetSkipped > 0) {
    log('fetch budget exhausted — partial view', { budgetSkipped, budgetMs: fetchBudgetMs });
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
    budgetSkipped,
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
