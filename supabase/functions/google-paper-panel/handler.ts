/**
 * google-paper-panel — the 15-min Google-picks-bucket forward-paper view tick (migration 0086).
 *
 * The Google twin of convergence-panel (0069). One idempotent run:
 *   1. pull the RAW fresh-allowlist capture series + the venue resolution map + the per-event latest Google
 *      forecast PER CITY (google_paper_inputs, service-role), through a bounded worker pool.
 *   2. run the PURE Google-bucket replay view (buildGoogleView → replayGoogleBracket over the frozen "Test 2"
 *      thresholds: buy execAsk < 0.15, NO stop-loss, hold-to-resolution as the floor — with FIVE take-profit exit
 *      variants {0.30..0.50} swept over the SAME fixed entry so the operator can compare which exit is most
 *      favourable; the canonical tpAbs 0.30 variant headlines. A taker strategy on the bucket Google points at).
 *   3. store the small view (record_google_paper) — the page reads only that snapshot.
 *
 * SCOPE = the live `bot.cities` CAPTURE universe (~45 cities), NOT the 10-city §9R TRADABLE allowlist: the
 * strategy runs across ALL cities (the Google forecast, not a house seed, picks the bucket), and the capture
 * stream already spans the full universe. Falls back to BOT_DEFAULTS.cities if the config row is absent. PARAMS
 * stay pinned to GOOGLE_DEFAULTS in code (the loop never mutates the shared bot.* keys). NOT trading — read-only
 * analytics; the bot rail stays paper/DORMANT (FINDINGS.md). A capture gap just yields a smaller/empty view,
 * never a failed job; the per-city fetch-error count is surfaced in the view so the page can flag an undercount.
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import { retryWrite, withTimeout } from '../_shared/retry.ts';
import {
  BOT_DEFAULTS,
  buildGoogleView,
  googleCfg,
  parseBotConfig,
  type RawCaptureRow,
  type RawGooglePrediction,
  type RawResolution,
} from '../../../packages/core/src/index.ts';

/** the look-back window — wide enough for the §9R-E gate (≥40 markets / ≥7 days) to accrue. */
const PANEL_DAYS = 21;

/**
 * per-city fetch tuning — mirror of maker-exit-panel (the 45-city case, one incident class, one fix shape):
 * bounded concurrency collapses the wall clock; the per-city timeout bounds a hung fetch (the DbPort fetch has
 * none); the overall budget degrades to a PARTIAL view (skipped cities count into cityErrors, which the page
 * already surfaces) — a partial snapshot beats a dead tick.
 *
 * CITY_TIMEOUT_MS must OUTLAST the RPC's own `statement_timeout='40s'` (0086) — 45s = 40s + 5s transport margin.
 * FETCH_CONCURRENCY 3 (not 5) keeps per-call latency near the uncontended ~6.5s floor: 5 concurrent heavy reads
 * self-contend on Micro compute and balloon per-call latency past the timeout (the 2026-07-06 maker-exit
 * incident). At 3 all ~45 cities clear well inside the 270s budget (~15 waves × ~12s ≈ 190s).
 */
const FETCH_CONCURRENCY = 3;
/** exported for a tripwire test — must OUTLAST the RPC's 40s statement_timeout. */
export const CITY_TIMEOUT_MS = 45_000;
const FETCH_BUDGET_MS = 270_000;

/**
 * terminal-write retry tuning (mirrors convergence-panel / maker-exit-panel — see _shared/retry.ts for the
 * idempotency argument). One transient "upstream request timeout" on the single snapshot insert must not discard
 * the minutes of per-city fetch already done; record_google_paper is a pure insert + prune-to-200 (no upsert, no
 * uniqueness) and dash_google_paper reads only the latest row, so a retry is safe.
 *
 * ARITHMETIC — stays under the ~400s isolate wall with margin (mirror convergence-panel + the 270s budget):
 *   fetch phase worst case  = FETCH_BUDGET_MS (270s) + one in-flight city's CITY_TIMEOUT_MS tail (45s) = 315s.
 *   terminal-write phase worst case = 3 attempts × 15s + (3s + 8s) backoffs = 56s.
 *   total = 315s + 56s = 371s, leaving a ~29s margin even in the all-hang case (the common case is ~250s).
 */
const RECORD_WRITE_RETRIES = 2;
const RECORD_WRITE_BACKOFF_MS = [3_000, 8_000];
const RECORD_WRITE_TIMEOUT_MS = 15_000;

export interface GooglePaperPanelDeps {
  now: Date;
  /** test seams — production uses the module defaults above. */
  fetchConcurrency?: number;
  cityTimeoutMs?: number;
  fetchBudgetMs?: number;
  /** test seam for the terminal-write retry backoff — production uses the real setTimeout-based sleep. */
  retrySleep?: (ms: number) => Promise<void>;
}

interface GoogleInputs {
  captures: RawCaptureRow[];
  resolutions: RawResolution[];
  google: RawGooglePrediction[];
}

export async function googlePaperPanel(ctx: JobCtx, deps: GooglePaperPanelDeps): Promise<JobStats> {
  const { db, log } = ctx;

  // SCOPE = the live bot.cities CAPTURE universe (~45 cities); the frozen "Test 2" thresholds live in
  // GOOGLE_DEFAULTS (code). Falls back to the 10-city BOT_DEFAULTS.cities if the config row is unreadable.
  let scopeCities: string[] = BOT_DEFAULTS.cities;
  try {
    const live = parseBotConfig(await db.getConfigRows()).cities;
    if (Array.isArray(live) && live.length > 0) scopeCities = live;
  } catch {
    /* config unreadable → the conservative 10-city fallback */
  }
  const cfg = googleCfg(scopeCities);

  // 1) raw inputs (captures + resolutions + per-event Google forecast) for the fresh-allowlist window — fetched
  //    PER CITY through the bounded worker pool; merge the per-city results. Interleaved arrival order is safe:
  //    buildEvents groups per event and sorts ticks by capturedAt internally.
  const fetchConcurrency = deps.fetchConcurrency ?? FETCH_CONCURRENCY;
  const cityTimeoutMs = deps.cityTimeoutMs ?? CITY_TIMEOUT_MS;
  const fetchBudgetMs = deps.fetchBudgetMs ?? FETCH_BUDGET_MS;
  const captures: RawCaptureRow[] = [];
  const resolutions: RawResolution[] = [];
  const google: RawGooglePrediction[] = [];
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
          db.rpc<{ google_paper_inputs: GoogleInputs }>('google_paper_inputs', {
            p_days: PANEL_DAYS,
            p_cities: [city],
          }),
          cityTimeoutMs,
          `google_paper_inputs(${city}) timed out after ${cityTimeoutMs}ms`,
        );
        const inp = r[0]?.google_paper_inputs ?? { captures: [], resolutions: [], google: [] };
        if (Array.isArray(inp.captures)) captures.push(...inp.captures);
        if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
        if (Array.isArray(inp.google)) google.push(...inp.google);
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

  // 2) the pure view (entries / per-day / fictive money / Google coverage / §9R-E gate). cityErrors is threaded
  //    in so the page can flag when capture-universe cities were dropped this tick (a silent gate undercount).
  const view = { ...buildGoogleView(captures, resolutions, google, cfg), days: PANEL_DAYS, cityErrors };

  // 3) store the small snapshot — BOUNDED RETRY (see the tuning block for the idempotency + wall-clock argument).
  const w = await retryWrite(
    () => db.rpc<{ record_google_paper: number }>('record_google_paper', { p_view: view }),
    {
      retries: RECORD_WRITE_RETRIES,
      delaysMs: RECORD_WRITE_BACKOFF_MS,
      attemptTimeoutMs: RECORD_WRITE_TIMEOUT_MS,
      label: 'record_google_paper',
      onRetry: (attempt, e) =>
        log('record_google_paper write failed — retrying', {
          attempt: attempt + 1,
          error: e instanceof Error ? e.message : String(e),
        }),
    },
    deps.retrySleep,
  );
  const snapshotId = Number(w[0]?.record_google_paper ?? 0);

  const stats: JobStats = {
    asOf: deps.now.toISOString(),
    cityErrors,
    budgetSkipped,
    captureRows: captures.length,
    freshEvents: view.nFreshEvents,
    googleEvents: view.nGoogleEvents,
    noGoogleEvents: view.nNoGoogleEvents,
    entries: view.entries.length,
    nMarkets: view.gate.nMarkets,
    label: view.gate.label,
    snapshotId,
  };
  log('google-paper-panel complete', stats);
  return stats;
}
