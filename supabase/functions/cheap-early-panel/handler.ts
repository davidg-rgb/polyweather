/**
 * cheap-early-panel — the HOURLY forward CHEAP-EARLY-ENTRY paper view tick (migration 0117).
 *
 * The cheap-early twin of maker-exit-panel (0073), simpler (a hold-to-resolution taker bet — no exit leg). One
 * idempotent run:
 *   1. read the cheap-early config (cheap_early.cities — the one allowed widening; cheap_early.enabled — the pause).
 *      If disabled, the tick is a no-op (no writes) — a clean pause, the page just shows the last snapshot.
 *   2. pull the RAW fresh-allowlist capture series + the venue resolution map PER CITY (convergence_capture_inputs,
 *      service-role — the SAME inputs the taker bracket / maker-exit views use; it already carries every field the
 *      cheap-early engine reads: idx, label, bestAsk, depthUsd, houseProb, resolvesAt).
 *   3. run the PURE cheap-early replay view (buildCheapEarlyView → replayCheapEarlyPanel over the frozen params).
 *   4. store the small view (record_cheap_early_panel) — the /cheap-early page reads only that snapshot.
 *   5. persist the §9R-E verdict (record_cheap_early_gate, source='forward-cheap-early' PINNED) so the operator
 *      watches the clustered CI narrowing over forward days — the DEGRADED-TICK GUARD withholds the gate-of-record
 *      write on a partial tick (biased city subset), exactly like 0073's maker-exit loop.
 *
 * PARAMS are pinned in CODE (CHEAP_EARLY_DEFAULTS: window [24,36]h · ask band 0.20–0.33 · $20 stake) so the loop
 * never mutates shared bot.* keys; only the city set + the pause are live-tunable. NOT trading — read-only
 * analytics; the bot rail stays DORMANT (no capital until a frozen paper PASS + an operator decision, gated on the
 * §9R-E verdict, never this build). A capture gap just yields a smaller/empty view, never a failed job; the
 * per-city fetch-error count is surfaced in the view. No record_bot_tick write (the loop's freshness is the panel's
 * captured_at — surfaced on the page — and the distinct source keeps it out of the shared 'paper' deadman feed).
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import { retryWrite, withTimeout } from '../_shared/retry.ts';
import {
  buildCheapEarlyView,
  cheapEarlyCfg,
  parseCheapEarlyConfig,
  type RawCaptureRow,
  type RawResolution,
} from '../../../packages/core/src/index.ts';

/** the look-back window — wide enough for the §9R-E gate (≥40 markets / ≥7 days) to accrue. */
const PANEL_DAYS = 21;

/** per-city fetch tuning — mirrors maker-exit-panel (the same 40s RPC statement_timeout must be outlasted). The
 *  cheap-early default is only 4 cities so this is ample headroom; the bounded pool keeps a city widening safe. */
const FETCH_CONCURRENCY = 3;
/** exported for the tripwire test — must OUTLAST the RPC's 40s statement_timeout. */
export const CITY_TIMEOUT_MS = 45_000;
const FETCH_BUDGET_MS = 270_000;

/** gate-write degradation floor (mirror 0073 §gate-write): a PARTIAL tick (per-city errors / budget skips)
 *  computes the verdict over a biased city subset — a label the full panel never issued. The panel snapshot still
 *  lands (ops telemetry, /cheap-early), but the gate-of-record write is withheld. Floor: cityErrors > 2 OR the
 *  view's scored nMarkets below the §9R-E 40-market bar. */
const GATE_WRITE_MAX_CITY_ERRORS = 2;

/** terminal-write retry tuning (mirror 0073 / WS-5): 2 retries / 3s then 8s / 15s hard per-attempt timeout for the
 *  panel insert; the best-effort gate write gets a 10s hard timeout and NO retry (a timed-out-but-landed retry
 *  would duplicate a row in the never-pruned §9R-E gate history). */
const RECORD_WRITE_RETRIES = 2;
const RECORD_WRITE_BACKOFF_MS = [3_000, 8_000];
const RECORD_WRITE_TIMEOUT_MS = 15_000;
const BOOKKEEPING_TIMEOUT_MS = 10_000;

export interface CheapEarlyPanelDeps {
  now: Date;
  /** test seams — production uses the module defaults above. */
  fetchConcurrency?: number;
  cityTimeoutMs?: number;
  fetchBudgetMs?: number;
  bookkeepingTimeoutMs?: number;
  gateMaxCityErrors?: number;
  gateMinMarkets?: number;
  retrySleep?: (ms: number) => Promise<void>;
}

interface CaptureInputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
}

export async function cheapEarlyPanel(ctx: JobCtx, deps: CheapEarlyPanelDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // 1) the operational config — the city set (the one allowed widening) + the pause gate. Falls back to the frozen
  //    4 live cities / enabled if the config is unreadable.
  let cfgRows: { key: string; value: string | null }[] = [];
  try {
    cfgRows = await db.getConfigRows();
  } catch {
    /* config unreadable → parseCheapEarlyConfig returns the frozen defaults */
  }
  const opCfg = parseCheapEarlyConfig(cfgRows);
  if (!opCfg.enabled) {
    log('cheap-early-panel paused (cheap_early.enabled=0) — no compute, no writes');
    return { asOf: deps.now.toISOString(), paused: true };
  }
  const cfg = cheapEarlyCfg(opCfg.cities);

  // 2) raw inputs per city, through a bounded worker pool with a per-city timeout + an overall budget (mirror
  //    maker-exit-panel). Interleaved arrival is safe — buildEvents groups per event + sorts ticks internally.
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

  // 3) the pure cheap-early view (entries / measured reads / fictive money / §9R-E gate). cityErrors is threaded
  //    in so the page can flag when allowlist cities were dropped this tick (a silent gate undercount).
  const view = { ...buildCheapEarlyView(captures, resolutions, cfg), days: PANEL_DAYS, cityErrors };

  // 4) store the small snapshot — BOUNDED RETRY (mirror 0073 / WS-5): one transient timeout must not discard the
  //    per-city fetch work. Safe to retry: record_cheap_early_panel is a pure insert + prune-to-200, and
  //    dash_cheap_early reads only the LATEST row.
  const w = await retryWrite(
    () => db.rpc<{ record_cheap_early_panel: number }>('record_cheap_early_panel', { p_view: view }),
    {
      retries: RECORD_WRITE_RETRIES,
      delaysMs: RECORD_WRITE_BACKOFF_MS,
      attemptTimeoutMs: RECORD_WRITE_TIMEOUT_MS,
      label: 'record_cheap_early_panel',
      onRetry: (attempt, e) =>
        log('record_cheap_early_panel write failed — retrying', {
          attempt: attempt + 1,
          error: e instanceof Error ? e.message : String(e),
        }),
    },
    deps.retrySleep,
  );
  const snapshotId = Number(w[0]?.record_cheap_early_panel ?? 0);

  // 5) persist the §9R-E verdict (the gate-of-record; source='forward-cheap-early' PINNED in record_cheap_early_gate).
  //    Best-effort, BOUNDED at 10s, NO retry (a timed-out-but-landed retry would duplicate a never-pruned gate row).
  //    DEGRADED-TICK GUARD (#8/#10, mirror 0073): a partial tick must NOT write the gate of record — its verdict was
  //    computed over a biased city subset. The panel snapshot (step 4) is UNCHANGED; only the gate write is withheld.
  const gateMaxCityErrors = deps.gateMaxCityErrors ?? GATE_WRITE_MAX_CITY_ERRORS;
  const gateMinMarkets = deps.gateMinMarkets ?? view.gate.minMarkets;
  const gateDegraded = cityErrors > gateMaxCityErrors || !(view.gate.nMarkets >= gateMinMarkets);
  if (gateDegraded) {
    log('degraded tick — gate-of-record write SKIPPED (panel snapshot unaffected)', {
      cityErrors,
      budgetSkipped,
      nMarkets: view.gate.nMarkets,
      floor: { maxCityErrors: gateMaxCityErrors, minMarkets: gateMinMarkets },
    });
  }
  const bookkeepingTimeoutMs = deps.bookkeepingTimeoutMs ?? BOOKKEEPING_TIMEOUT_MS;
  try {
    if (!gateDegraded) {
      await withTimeout(
        db.rpc('record_cheap_early_gate', {
          p_payload: {
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
            totalNetUsd: view.money.realizedPnlUsd,
            nOpen: view.money.nOpen,
          },
        }),
        bookkeepingTimeoutMs,
        `record_cheap_early_gate timed out after ${bookkeepingTimeoutMs}ms`,
      );
    }
  } catch (e) {
    log('gate-snapshot write failed (non-fatal)', { error: e instanceof Error ? e.message : String(e) });
  }

  const stats: JobStats = {
    asOf: deps.now.toISOString(),
    cities: cfg.cities.length,
    cityErrors,
    budgetSkipped,
    captureRows: captures.length,
    considered: view.nConsidered,
    entries: view.entries.length,
    nMarkets: view.gate.nMarkets,
    meanNetReturn: view.assumptions.meanNetReturn,
    winRate: view.assumptions.winRate,
    label: view.gate.label,
    snapshotId,
    ...(gateDegraded ? { gateWriteSkipped: 'degraded' as const } : {}),
  };
  log('cheap-early-panel complete', stats);
  return stats;
}
