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
import { retryWrite, withTimeout } from '../_shared/retry.ts';
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

/**
 * terminal-write retry tuning (WS-5, 2026-07-03) — see _shared/retry.ts for the idempotency argument. 2
 * retries / 3s then 8s backoff / a 15s hard per-attempt timeout (the snapshot is "tens of KB" per the 0073
 * header, so 15s is generous even under pooler jam; a hang past that is exactly the failure class the
 * incident showed — bound it, don't wait on it). The two step-4 bookkeeping writes get a 10s hard timeout
 * EACH but NO retry — they are best-effort by design (a timeout degrades exactly like any other step-4
 * failure: logged non-fatal inside the existing try/catch, never fails the job), and retrying them could
 * write duplicate rows into the never-pruned §9R-E gate history (bot_gate_snapshot) — unacceptable there,
 * unlike the pruned-and-latest-read panel table.
 *
 * ARITHMETIC — the COMPLETE post-claim chain stays under the ~400s isolate wall with margin to spare:
 *   fetch phase worst case  = FETCH_BUDGET_MS (240s) + one in-flight city's CITY_TIMEOUT_MS tail (30s) = 270s
 *   (unchanged by this fix — the budget check only stops NEW claims, the city already in flight when the
 *   budget trips still runs to its own timeout).
 *   terminal-write phase worst case = 3 attempts × RECORD_WRITE_TIMEOUT_MS (15s = 45s) + 2 backoffs
 *   (3s + 8s = 11s) = 56s (every attempt hangs to its own timeout — the true worst case, not the common one).
 *   step-4 bookkeeping worst case = 2 × BOOKKEEPING_TIMEOUT_MS (10s) = 20s (both writes hang to their bound).
 *   total = 270s + 56s + 20s = 346s, leaving a ~54s (≈13%) margin under the 400s wall even in the all-hang
 *   case. (convergence-panel has NO step 4, so its chain is 270s + 56s = 326s / ~74s margin.)
 */
const RECORD_WRITE_RETRIES = 2;
const RECORD_WRITE_BACKOFF_MS = [3_000, 8_000];
const RECORD_WRITE_TIMEOUT_MS = 15_000;
const BOOKKEEPING_TIMEOUT_MS = 10_000;

export interface MakerExitPanelDeps {
  now: Date;
  /** test seams — production uses the module defaults above. */
  fetchConcurrency?: number;
  cityTimeoutMs?: number;
  fetchBudgetMs?: number;
  bookkeepingTimeoutMs?: number;
  /** test seam for the terminal-write retry backoff — production uses the real setTimeout-based sleep. */
  retrySleep?: (ms: number) => Promise<void>;
}

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
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

  // 3) store the small snapshot — BOUNDED RETRY (WS-5): one transient "upstream request timeout" on this
  //    single insert must not discard the several minutes of per-city fetch work already done (today's
  //    incident). Safe to retry: record_maker_exit_panel is a pure insert + prune-to-200 (no upsert, no
  //    uniqueness constraint), and dash_maker_exit reads only the LATEST row — see _shared/retry.ts for the
  //    full idempotency argument and the tuning block above for the wall-clock arithmetic.
  const w = await retryWrite(
    () => db.rpc<{ record_maker_exit_panel: number }>('record_maker_exit_panel', { p_view: view }),
    {
      retries: RECORD_WRITE_RETRIES,
      delaysMs: RECORD_WRITE_BACKOFF_MS,
      attemptTimeoutMs: RECORD_WRITE_TIMEOUT_MS,
      label: 'record_maker_exit_panel',
      onRetry: (attempt, e) =>
        log('record_maker_exit_panel write failed — retrying', {
          attempt: attempt + 1,
          error: e instanceof Error ? e.message : String(e),
        }),
    },
    deps.retrySleep,
  );
  const snapshotId = Number(w[0]?.record_maker_exit_panel ?? 0);

  // 4) persist the §9R-E verdict (the gate-of-record bot_deadman watches) + a liveness tick. Best-effort — a
  //    snapshot already landed; never fail the job on the bookkeeping writes. Each write is BOUNDED at 10s
  //    (WS-5 review fix): an unbounded hung call here (the same pooler-stall class as the incident) would run
  //    the isolate toward the ~400s wall even though the tick's real work is done. NO retry — a timed-out-but-
  //    landed write retried here would duplicate a row in the never-pruned §9R-E gate history; on timeout this
  //    degrades exactly like any other step-4 failure (the catch below logs it non-fatally).
  const bookkeepingTimeoutMs = deps.bookkeepingTimeoutMs ?? BOOKKEEPING_TIMEOUT_MS;
  try {
    await withTimeout(
      db.rpc('record_bot_gate_snapshot', {
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
      }),
      bookkeepingTimeoutMs,
      `record_bot_gate_snapshot timed out after ${bookkeepingTimeoutMs}ms`,
    );
    await withTimeout(
      db.rpc('record_bot_tick', {
        p_payload: {
          mode: 'paper',
          ran: true,
          placed: view.money.nEntries,
          filled: view.money.nEntries,
          exited: view.money.nRealized,
          gateReason: view.gate.label,
        },
      }),
      bookkeepingTimeoutMs,
      `record_bot_tick timed out after ${bookkeepingTimeoutMs}ms`,
    );
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
    qualifyingTickFrac: view.assumptions.qualifyingTickFrac,
    dominantDisqualifier: view.assumptions.dominantDisqualifier, // v2 "WHY zero" pool-context extension
    label: view.gate.label,
    snapshotId,
  };
  log('maker-exit-panel complete', stats);
  return stats;
}
