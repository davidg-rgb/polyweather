/**
 * google-paper-panel — the hourly Google-picks-bucket forward-paper view tick (migration 0086; INCREMENTAL
 * REPLAY since 0103).
 *
 * The Google twin of convergence-panel (0069). One idempotent run:
 *   1. read the light per-event INDEX of the fresh window (google_paper_event_index) + the cached replay
 *      units (google_replay_cache_read, keyed by engine-version+cfg). A RESOLVED, non-gm event's replay is
 *      deterministic forever — its cached unit is reused; only OPEN/new events get their capture series
 *      fetched (google_paper_inputs_v2, event-filtered, per city through the bounded pool) and re-replayed.
 *      Newly-resolved units are written back (google_replay_cache_write). CPU/wall now scales with the
 *      handful of open events, not the whole 21-day window — the fix for the runs dying at the ~400s
 *      isolate wall as the post-07-07-prune window refilled (loop C27/C34, 2026-07-17).
 *   2. assemble the PURE view (assembleGoogleView over cached+fresh units — byte-identical to the legacy
 *      buildGoogleView by construction) and store the small snapshot (record_google_paper).
 *
 * FALLBACK (staged-dark): if the 0103 index/cache RPCs are absent or fail, the tick runs the LEGACY full
 * path — fetch every city's full series (google_paper_inputs v1) + buildGoogleView — exactly the pre-0103
 * behavior. The panel must never die because its cache did.
 *
 * SCOPE = the live `bot.cities` CAPTURE universe (~45 cities), NOT the 10-city §9R TRADABLE allowlist. PARAMS
 * stay pinned to GOOGLE_DEFAULTS in code. NOT trading — read-only analytics; the bot rail stays paper/DORMANT
 * (FINDINGS.md). A capture gap just yields a smaller/empty view, never a failed job; the per-city fetch-error
 * count is surfaced in the view so the page can flag an undercount.
 */
import type { JobCtx, JobStats } from '../_shared/runJob.ts';
import { retryWrite, withTimeout } from '../_shared/retry.ts';
import {
  BOT_DEFAULTS,
  assembleGoogleView,
  buildGoogleReplayUnits,
  buildGoogleView,
  googleCfg,
  googleReplayCacheKey,
  parseBotConfig,
  type GoogleEventReplay,
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
 * CITY_TIMEOUT_MS must OUTLAST the RPC's own `statement_timeout='40s'` (0086/0103) — 45s = 40s + 5s transport
 * margin. FETCH_CONCURRENCY 3 (not 5) keeps per-call latency near the uncontended floor (the 2026-07-06
 * maker-exit incident). On the incremental path only the cities holding OPEN/uncached events are fetched at
 * all, so the pool usually runs a handful of small event-filtered calls.
 */
const FETCH_CONCURRENCY = 3;
/** exported for a tripwire test — must OUTLAST the RPC's 40s statement_timeout. */
export const CITY_TIMEOUT_MS = 45_000;
const FETCH_BUDGET_MS = 270_000;

/** terminal-write retry tuning (mirrors convergence-panel / maker-exit-panel; see _shared/retry.ts). */
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

/** One row of google_paper_event_index (0103). */
interface IndexRow {
  eventId: string;
  city: string;
  targetDate: string;
  resolved: boolean;
  gm: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const REPLAY_KINDS = new Set(['no_google', 'excluded_f', 'unbucketable', 'traded']);
/** Defensive shape check on a cache-deserialized unit — a malformed row is dropped, never folded. */
function isReplayUnit(u: unknown): u is GoogleEventReplay {
  if (u == null || typeof u !== 'object') return false;
  const o = u as Record<string, unknown>;
  return (
    typeof o['eventId'] === 'string' &&
    typeof o['city'] === 'string' &&
    typeof o['targetDate'] === 'string' &&
    typeof o['kind'] === 'string' &&
    REPLAY_KINDS.has(o['kind'])
  );
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
  const cacheKey = googleReplayCacheKey(cfg);
  const fetchConcurrency = deps.fetchConcurrency ?? FETCH_CONCURRENCY;
  const cityTimeoutMs = deps.cityTimeoutMs ?? CITY_TIMEOUT_MS;
  const fetchBudgetMs = deps.fetchBudgetMs ?? FETCH_BUDGET_MS;

  // 1) INCREMENTAL PREFLIGHT — the event index + the cache read. ANY failure (absent RPC pre-0103, a
  //    timeout, a shapeless result) drops this run to the legacy full path; the panel never dies of cache.
  let index: IndexRow[] | null = null;
  try {
    const r = await withTimeout(
      db.rpc<{ google_paper_event_index: { rows?: unknown } | null }>('google_paper_event_index', {
        p_days: PANEL_DAYS,
        p_cities: cfg.cities,
      }),
      cityTimeoutMs,
      `google_paper_event_index timed out after ${cityTimeoutMs}ms`,
    );
    const rows = r[0]?.google_paper_event_index?.rows;
    if (Array.isArray(rows)) {
      index = rows.filter(
        (x): x is IndexRow => x != null && typeof (x as IndexRow).eventId === 'string' && typeof (x as IndexRow).city === 'string',
      );
    }
  } catch (e) {
    log('event index unavailable — legacy full replay this run', { error: errMsg(e) });
  }

  let cachedRaw: GoogleEventReplay[] | null = null;
  if (index != null) {
    try {
      const r = await withTimeout(
        db.rpc<{ google_replay_cache_read: { rows?: unknown } | null }>('google_replay_cache_read', {
          p_cache_key: cacheKey,
          p_event_ids: index.map((x) => x.eventId),
        }),
        cityTimeoutMs,
        `google_replay_cache_read timed out after ${cityTimeoutMs}ms`,
      );
      const rows = r[0]?.google_replay_cache_read?.rows;
      if (Array.isArray(rows)) cachedRaw = rows.filter(isReplayUnit);
    } catch (e) {
      log('cache read unavailable — legacy full replay this run', { error: errMsg(e) });
    }
  }
  const incremental = index != null && cachedRaw != null;

  // 2) plan the fetch: legacy = every city, full series (v1). incremental = only the cities holding an
  //    event that NEEDS replay (open, or resolved-but-uncached), event-filtered (v2).
  let jobs: Array<{ city: string; eventIds: string[] | null }>;
  if (incremental) {
    const cachedIds = new Set(cachedRaw!.map((u) => u.eventId));
    const needByCity = new Map<string, string[]>();
    for (const row of index!) {
      if (row.gm) continue; // grading-mismatch: excluded from the population entirely
      if (row.resolved && cachedIds.has(row.eventId)) continue; // frozen + cached — nothing to do
      const list = needByCity.get(row.city);
      if (list) list.push(row.eventId);
      else needByCity.set(row.city, [row.eventId]);
    }
    jobs = [...needByCity.entries()].map(([city, eventIds]) => ({ city, eventIds }));
  } else {
    jobs = cfg.cities.map((city) => ({ city, eventIds: null }));
  }

  // 3) the bounded per-city fetch pool (unchanged shape; the incremental path just has far fewer, smaller jobs).
  const captures: RawCaptureRow[] = [];
  const resolutions: RawResolution[] = [];
  const google: RawGooglePrediction[] = [];
  let cityErrors = 0;
  let budgetSkipped = 0;
  const fetchStarted = Date.now();
  let nextJob = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = nextJob++;
      if (i >= jobs.length) return;
      const job = jobs[i]!;
      if (Date.now() - fetchStarted > fetchBudgetMs) {
        budgetSkipped++;
        cityErrors++;
        continue;
      }
      try {
        const rpcName = job.eventIds == null ? 'google_paper_inputs' : 'google_paper_inputs_v2';
        const args: Record<string, unknown> =
          job.eventIds == null
            ? { p_days: PANEL_DAYS, p_cities: [job.city] }
            : { p_days: PANEL_DAYS, p_cities: [job.city], p_event_ids: job.eventIds };
        const r = await withTimeout(
          db.rpc<Record<string, GoogleInputs | null>>(rpcName, args),
          cityTimeoutMs,
          `${rpcName}(${job.city}) timed out after ${cityTimeoutMs}ms`,
        );
        const inp = r[0]?.[rpcName] ?? { captures: [], resolutions: [], google: [] };
        if (Array.isArray(inp.captures)) captures.push(...inp.captures);
        if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
        if (Array.isArray(inp.google)) google.push(...inp.google);
      } catch (e) {
        cityErrors++;
        log('city inputs fetch failed (non-fatal)', { city: job.city, error: errMsg(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(fetchConcurrency, Math.max(jobs.length, 1))) }, () => worker()));
  if (budgetSkipped > 0) {
    log('fetch budget exhausted — partial view', { budgetSkipped, budgetMs: fetchBudgetMs });
  }

  // 4) the pure view. incremental: fold cached-frozen units + freshly-replayed units (assembleGoogleView —
  //    byte-identical to buildGoogleView by construction); legacy: the full replay exactly as pre-0103.
  let view: Record<string, unknown>;
  let cacheUnitsUsed = 0;
  let replayedEvents = 0;
  let cacheWrites = 0;
  if (incremental) {
    const freshUnits = buildGoogleReplayUnits(captures, resolutions, google, cfg);
    replayedEvents = freshUnits.length;
    const freshIds = new Set(freshUnits.map((u) => u.eventId));
    const gmIds = new Set(index!.filter((r) => r.gm).map((r) => r.eventId));
    const indexIds = new Set(index!.map((r) => r.eventId));
    // cached units count only while still in the window, not gm-flipped since caching, and not recomputed.
    const usableCached = cachedRaw!.filter((u) => indexIds.has(u.eventId) && !gmIds.has(u.eventId) && !freshIds.has(u.eventId));
    cacheUnitsUsed = usableCached.length;
    const units = [...usableCached, ...freshUnits];
    view = { ...assembleGoogleView(units, cfg), days: PANEL_DAYS, cityErrors };

    // write back the units frozen this run (resolved + non-gm per the fresh index) — BEFORE the snapshot
    // write so a failed record still warms the cache. Non-fatal: a failed write just means a re-replay.
    const freezeIds = new Set(index!.filter((r) => r.resolved && !r.gm).map((r) => r.eventId));
    const toWrite = freshUnits.filter((u) => freezeIds.has(u.eventId));
    if (toWrite.length > 0) {
      try {
        const w = await withTimeout(
          db.rpc<{ google_replay_cache_write: number }>('google_replay_cache_write', {
            p_cache_key: cacheKey,
            p_rows: toWrite,
          }),
          RECORD_WRITE_TIMEOUT_MS,
          `google_replay_cache_write timed out after ${RECORD_WRITE_TIMEOUT_MS}ms`,
        );
        cacheWrites = Number(w[0]?.google_replay_cache_write ?? 0);
      } catch (e) {
        log('cache write failed (non-fatal — units re-replay next run)', { error: errMsg(e), attempted: toWrite.length });
      }
    }
  } else {
    view = { ...buildGoogleView(captures, resolutions, google, cfg), days: PANEL_DAYS, cityErrors };
  }

  // 4.5) GUARD (C35): an ALL-FAILED fetch must never overwrite a good snapshot with an empty view (the
  //      10:24Z 07-17 incident: 45/45 v2 calls raised on the 0103 uuid-cast bug and an empty panel
  //      replaced the real one on the dash). Zero folded events + at least one fetch error ⇒ skip the
  //      record — the dash keeps the last good snapshot; cityErrors/the deadman surface the incident.
  //      A legitimately empty universe (no fresh events, no errors) still records.
  const foldedEvents = Number((view as { nFreshEvents?: unknown }).nFreshEvents ?? 0);
  if (foldedEvents === 0 && cityErrors > 0) {
    const skipStats: JobStats = {
      asOf: deps.now.toISOString(),
      incremental,
      cityErrors,
      budgetSkipped,
      captureRows: captures.length,
      skippedEmptyRecord: true,
      snapshotId: 0,
    };
    log('empty view with fetch errors — snapshot NOT recorded (keeping the last good one)', skipStats);
    return skipStats;
  }

  // 5) store the small snapshot — BOUNDED RETRY (idempotent insert; dash reads only the latest row).
  const w = await retryWrite(
    () => db.rpc<{ record_google_paper: number }>('record_google_paper', { p_view: view }),
    {
      retries: RECORD_WRITE_RETRIES,
      delaysMs: RECORD_WRITE_BACKOFF_MS,
      attemptTimeoutMs: RECORD_WRITE_TIMEOUT_MS,
      label: 'record_google_paper',
      onRetry: (attempt, e) =>
        log('record_google_paper write failed — retrying', { attempt: attempt + 1, error: errMsg(e) }),
    },
    deps.retrySleep,
  );
  const snapshotId = Number(w[0]?.record_google_paper ?? 0);

  const v = view as { nFreshEvents: number; nGoogleEvents: number; nNoGoogleEvents: number; entries: unknown[]; gate: { nMarkets: number; label: string } };
  const stats: JobStats = {
    asOf: deps.now.toISOString(),
    incremental,
    indexEvents: index?.length ?? null,
    cacheUnitsUsed,
    replayedEvents,
    cacheWrites,
    cityErrors,
    budgetSkipped,
    captureRows: captures.length,
    freshEvents: v.nFreshEvents,
    googleEvents: v.nGoogleEvents,
    noGoogleEvents: v.nNoGoogleEvents,
    entries: v.entries.length,
    nMarkets: v.gate.nMarkets,
    label: v.gate.label,
    snapshotId,
  };
  log('google-paper-panel complete', stats);
  return stats;
}
