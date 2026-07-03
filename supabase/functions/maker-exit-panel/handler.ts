/**
 * maker-exit-panel — the 15-min forward MAKER-EXIT paper view tick (migration 0073).
 *
 * The maker-exit twin of convergence-panel (0069). One idempotent run:
 *   1. pull the RAW fresh-allowlist capture series + the venue resolution map PER CITY (convergence_capture_inputs,
 *      service-role — the same inputs the taker bracket view uses; now carrying bestBid for the spread diagnostic).
 *   2. run the PURE maker-exit replay view (buildMakerExitView → replayMakerExitPanel over the §9R-locked +
 *      tuned MAKER_EXIT config) — entries, the three measured assumptions, the fictive money tracker, the gate.
 *   3. store the small view (record_maker_exit_panel) — the /maker-exit page reads only that snapshot.
 *   4. persist the §9R-E verdict to bot_gate_snapshot (source='forward') so bot_deadman_check watches the gate
 *      clock + the project keeps ONE gate-of-record, and write a liveness tick (record_bot_tick).
 *
 * PARAMS stay pinned to the tuned MAKER_EXIT config (the §5 sweep optimum: tp 0.12 / sl 0.20 / tstop 18h /
 * chw 0 / depth $150 / makerWindow 30 / rebate 0 — re-confirmed as the coordinate-wise optimum on the CORRECTED
 * 819-event archive, 2026-07-03) so the loop never mutates the shared bot.* keys. The panel SCOPE, however, is
 * the live `bot.cities` CAPTURE universe (~45 cities), NOT the 10-city TRADABLE allowlist (2026-07-03 change):
 * the corrected-archive §9R-E validation PASSES on the 45-city panel (n=382, CI [+0.3%, +12.0%]) while the
 * 10-city subset is structurally starved (10 city-clusters → CI [−7.8%, +13.9%] even at n=88) — the paper gate
 * measures the SIGNAL, and the capture stream already spans the full universe; which cities eventually carry
 * capital stays a separate §9R liquidity decision. NOT trading — read-only analytics; the bot rail stays
 * paper/DORMANT (no capital until a frozen paper PASS + an operator decision). A capture gap just yields a
 * smaller/empty view, never a failed job; the per-city fetch-error count is surfaced in the view.
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import {
  BOT_DEFAULTS,
  buildMakerExitView,
  makerExitCfg,
  parseBotConfig,
  type RawCaptureRow,
  type RawResolution,
} from '../../../packages/core/src/index.ts';

/** the look-back window — wide enough for the §9R-E gate (≥40 markets / ≥7 days) to accrue. */
const PANEL_DAYS = 21;

/**
 * per-city fetch tuning — the 45-city scope must fit the ~400s isolate wall-clock with margin. The 2026-07-03
 * 45-city redeploy's first ticks DIED at the wall: 45 SEQUENTIAL convergence_capture_inputs calls (~3–8s each,
 * unbounded — the DbPort fetch has no timeout, so one hung statement stalls the whole loop) never reached the
 * snapshot write, leaving job_runs rows wedged 'running' and the gate-of-record stale. Bounded concurrency keeps
 * each statement under the 8s PostgREST cap while collapsing the wall to ~⌈45/5⌉ batches; the per-city timeout
 * bounds a hung fetch; the overall budget degrades to a PARTIAL view (skipped cities count into cityErrors,
 * which the page already surfaces) — a partial snapshot beats a dead tick.
 */
const FETCH_CONCURRENCY = 5;
const CITY_TIMEOUT_MS = 30_000;
const FETCH_BUDGET_MS = 240_000;

export interface MakerExitPanelDeps {
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

export async function makerExitPanel(ctx: JobCtx, deps: MakerExitPanelDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // the tuned maker-exit PARAMS pinned in code; the panel SCOPE = the live bot.cities CAPTURE universe (the
  // 2026-07-03 corrected-archive validation passed on the 45-city panel — the 10-city trade subset is
  // structurally starved for the clustered CI). Falls back to BOT_DEFAULTS.cities if the config row is absent.
  let scopeCities: string[] = BOT_DEFAULTS.cities;
  try {
    const live = parseBotConfig(await db.getConfigRows()).cities;
    if (Array.isArray(live) && live.length > 0) scopeCities = live;
  } catch {
    /* config unreadable → the conservative 10-city fallback */
  }
  const cfg = makerExitCfg(scopeCities);

  // 1) raw inputs (trimmed buckets, +bestBid; since 0077 server-thinned to ONE row per event per 20-min grid
  //    bucket PLUS the newest tick per event — the SAMPLE_MIN cadence class, so each per-city statement
  //    detoasts a fraction of the tick series) for the fresh-allowlist window — fetched PER CITY to stay under the 8s PostgREST
  //    statement cap (the whole-allowlist build exceeds it), through a bounded worker pool with a per-city
  //    timeout + an overall budget (see the tuning block above); merge the per-city results. Interleaved
  //    arrival order is safe: buildEvents groups per event and sorts ticks by capturedAt internally.
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

  // 2) the pure maker-exit view (entries / 3 measured assumptions / fictive money / §9R-E gate). cityErrors is
  //    threaded in so the page can flag when allowlist cities were dropped this tick (a silent gate undercount).
  const view = { ...buildMakerExitView(captures, resolutions, cfg), days: PANEL_DAYS, cityErrors };

  // 3) store the small snapshot.
  const w = await db.rpc<{ record_maker_exit_panel: number }>('record_maker_exit_panel', { p_view: view });
  const snapshotId = Number(w[0]?.record_maker_exit_panel ?? 0);

  // 4) persist the §9R-E verdict (the gate-of-record bot_deadman watches) + a liveness tick. Best-effort — a
  //    snapshot already landed; never fail the job on the bookkeeping writes.
  try {
    await db.rpc('record_bot_gate_snapshot', {
      p_payload: {
        mode: 'paper',
        source: 'forward',
        label: view.gate.label,
        nMarkets: view.gate.nMarkets,
        nCities: view.gate.nCities,
        nDistinctDays: view.gate.nDistinctDays,
        winFrac: view.gate.winFrac,
        meanNetReturn: view.gate.meanNetReturn,
        ciLow: view.gate.ciLow,
        ciHigh: view.gate.ciHigh,
        zeroSkillPassRate: view.gate.zeroSkillPassRate,
        reason: view.gate.reason,
        makerExitFrac: view.assumptions.makerFillRate,
        realizedRebateUsd: view.assumptions.realizedRebateUsd,
        totalNetUsd: view.money.realizedPnlUsd,
        nOpen: view.money.nOpen,
      },
    });
    await db.rpc('record_bot_tick', {
      p_payload: {
        mode: 'paper',
        ran: true,
        placed: view.money.nEntries,
        filled: view.money.nEntries,
        exited: view.money.nRealized,
        gateReason: view.gate.label,
      },
    });
  } catch (e) {
    log('gate-snapshot / tick write failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
  }

  const stats: JobStats = {
    asOf: deps.now.toISOString(),
    cityErrors,
    budgetSkipped,
    captureRows: captures.length,
    freshEvents: view.nFreshEvents,
    entries: view.entries.length,
    nMarkets: view.gate.nMarkets,
    makerFillRate: view.assumptions.makerFillRate,
    realizedRebateUsd: view.assumptions.realizedRebateUsd,
    label: view.gate.label,
    snapshotId,
  };
  log('maker-exit-panel complete', stats);
  return stats;
}
