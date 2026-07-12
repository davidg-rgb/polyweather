/**
 * health-monitor — the watchdog (ARCHITECTURE.md §6.19). Schedule: every 30 min.
 *
 * (1) Job staleness vs the W7 matrix (discovery threshold 10h — the real
 *     17:10→02:10 gap is 9h; an 8h threshold would false-alarm nightly).
 *     'running' counts as fresh only while younger than the wall limit.
 * (2) REAPER (ADR-12): runs stuck 'running' past the wall limit → 'failed'
 *     + alert; the period becomes CAS-retryable.
 * (3) ALERT RESEND (ADR-11): unsent alerts_log rows older than 10 min re-post.
 * (4) Dead-man data checks: newest forecast/market snapshot ages through
 *     evaluateBreakers → halt + CRITICAL.
 * (4b) AUTO-RECOVERY (C3/R-A6): when forecast freshness is CURRENTLY below the
 *     staleForecastHaltH threshold AND a SYSTEM-authored halt:global persists,
 *     clear_system_halt('global') lifts it (NEVER an operator halt) + WARN.
 * (5) Open-Meteo model meta sampled — a model stuck >24h ⇒ WARN.
 * (6) Tomorrow-events sanity: ≥80% of active cities must have tomorrow's event.
 */
import {
  DEAD_MAN_FORECAST_REASON_PREFIX,
  DEAD_MAN_PRICE_REASON_PREFIX,
  evaluateBreakers,
} from '../../../packages/core/src/index.ts';
import { resendUnsentAlerts } from '../_shared/slack.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface HealthDeps {
  notify: (alert: Alert) => Promise<boolean>;
  /** Raw webhook poster for the ADR-11 resend sweep (no new alerts_log row). */
  postAlert: (alert: Alert) => Promise<boolean>;
  /**
   * Open-Meteo per-model meta sample → epoch seconds of the model's last run
   * initialisation, or null when unavailable. Shape is docs-based and
   * re-verified by scripts/smoke-live-apis (BUILD-STATE deviation).
   */
  fetchModelMeta: (slug: string) => Promise<number | null>;
  now: Date;
}

/** §6.19 staleness matrix, minutes (W7: discovery 10h; C15 compute-shed: poll every 15m + metar every 30m ⇒ cadence + 1 missed tick + margin). */
const STALENESS_MATRIX: Record<string, number> = {
  'poll-markets': 35,
  'metar-nowcast': 75,
  'fetch-actuals': 120,
  'snapshot-forecasts': 14 * 60,
  'snapshot-ensembles': 14 * 60,
  'run-calibration': 26 * 60,
  'discover-markets': 10 * 60,
};

const MODEL_STUCK_H = 24;
const RESEND_AFTER_MIN = 10;
const TOMORROW_COVERAGE_MIN = 0.8;

export async function healthMonitor(ctx: JobCtx, deps: HealthDeps): Promise<JobStats> {
  const { db, config: cfg, log } = ctx;
  const nowMs = deps.now.getTime();
  const stats = {
    staleJobs: 0, reaped: 0, resent: 0, deadManHalts: 0, recoveredHalts: 0,
    modelAnomalies: 0, tomorrowCoverage: 1,
  };

  // --- (1) staleness matrix -----------------------------------------------------
  const freshness = await db.rpc<{ job: string; last_ok: string | null; running_started: string | null }>(
    'job_freshness', {},
  );
  const byJob = new Map(freshness.map((f) => [f.job, f]));
  const sixHourBucket = Math.floor(nowMs / 21_600_000); // 6h dedupe window
  for (const [job, maxMin] of Object.entries(STALENESS_MATRIX)) {
    const f = byJob.get(job);
    let freshest = f?.last_ok ? new Date(f.last_ok).getTime() : 0;
    if (f?.running_started) {
      const started = new Date(f.running_started).getTime();
      // 'running' is fresh only while younger than the wall limit (a zombie
      // isolate must not suppress the alarm).
      if (nowMs - started < cfg.jobWallLimitSec * 1000) freshest = Math.max(freshest, started);
    }
    const staleMin = (nowMs - freshest) / 60_000;
    if (staleMin > maxMin) {
      stats.staleJobs++;
      await deps.notify({
        kind: 'JOB_STALE',
        severity: 'CRITICAL',
        title: `${job} is stale`,
        body: f
          ? `last success ${f.last_ok ?? 'never'} — ${Math.round(staleMin)} min ago exceeds the ${maxMin} min threshold (W7 matrix)`
          : `no run recorded at all — expected every ${maxMin} min`,
        dedupeKey: `job-stale:${job}:${sixHourBucket}`,
      });
    }
  }

  // --- (2) reaper (ADR-12) --------------------------------------------------------
  const reaped = await db.rpc<{ job: string; period_key: string }>('reap_stale_runs', {
    p_wall_sec: cfg.jobWallLimitSec,
  });
  stats.reaped = reaped.length;
  if (reaped.length > 0) {
    await deps.notify({
      kind: 'JOB_REAPED',
      severity: 'WARN',
      title: `${reaped.length} stuck run(s) reaped (ADR-12)`,
      body: reaped.map((r) => `${r.job} · ${r.period_key} — flipped to 'failed', period retryable`).join('\n'),
      dedupeKey: `job-reaped:${sixHourBucket}`,
    });
  }

  // --- (3) alert resend (ADR-11) ---------------------------------------------------
  stats.resent = await resendUnsentAlerts(db, RESEND_AFTER_MIN, deps.postAlert);

  // --- (4) dead-man data checks + (6) tomorrow sanity -------------------------------
  const tomorrow = new Date(nowMs + 86_400_000).toISOString().slice(0, 10);
  const [dfRow] = await db.rpc<{
    data_freshness: {
      newestForecastAt: string | null;
      newestSnapshotAt: string | null;
      activeCities: number;
      tomorrowEventCities: number;
    };
  }>('data_freshness', { p_tomorrow: tomorrow });
  const df = dfRow!.data_freshness;

  const forecastAgeH = df.newestForecastAt
    ? (nowMs - new Date(df.newestForecastAt).getTime()) / 3_600_000
    : Number.POSITIVE_INFINITY;
  const priceAgeMin = df.newestSnapshotAt
    ? (nowMs - new Date(df.newestSnapshotAt).getTime()) / 60_000
    : Number.POSITIVE_INFINITY;
  const halts = evaluateBreakers(
    {
      consecutiveLossesByCityLead: new Map(),
      dailyPnlPct: 0,
      drawdownPct: 0,
      rollingBrierByCity: new Map(),
      freshestForecastAgeH: forecastAgeH,
      freshestPriceAgeMin: priceAgeMin,
    },
    cfg,
  );
  for (const halt of halts) {
    stats.deadManHalts++;
    await db.rpc('apply_halt', { p_scope: halt.scope, p_reason: halt.reason });
    await deps.notify({
      kind: 'DEAD_MAN',
      severity: 'CRITICAL',
      title: `Dead-man halt applied: ${halt.scope}`,
      body: `${halt.reason} — halt written; resume from /admin once the pipeline recovers.`,
      dedupeKey: `dead-man:${halt.scope}:${halt.reason.split(' ').slice(0, 2).join('-')}`,
    });
  }
  // The breaker fired a global halt this pass ⇒ recovery is suppressed (FIX 1/R-A6, gate below).
  const appliedGlobalHaltThisPass = halts.some((h) => h.scope === 'global');

  if (Number(df.activeCities) > 0) {
    stats.tomorrowCoverage = Number(df.tomorrowEventCities) / Number(df.activeCities);
    if (stats.tomorrowCoverage < TOMORROW_COVERAGE_MIN) {
      await deps.notify({
        kind: 'TOMORROW_COVERAGE',
        severity: 'WARN',
        title: `Tomorrow's events cover only ${Math.round(stats.tomorrowCoverage * 100)}% of active cities`,
        body: `${df.tomorrowEventCities}/${df.activeCities} betting-enabled cities have an open event for ${tomorrow} (need ≥80%) — check discover-markets.`,
        dedupeKey: `tomorrow-coverage:${tomorrow}`,
      });
    }
  }

  // --- (5) model run availability ------------------------------------------------
  const models = await db.rpc<{ slug: string }>('list_enabled_models', { p_is_ensemble: false });
  for (const m of models) {
    try {
      const lastRunEpoch = await deps.fetchModelMeta(m.slug);
      if (lastRunEpoch === null) continue; // meta unavailable — sampled, not alarmed
      if (nowMs / 1000 - lastRunEpoch > MODEL_STUCK_H * 3600) {
        stats.modelAnomalies++;
        await deps.notify({
          kind: 'MODEL_STUCK',
          severity: 'WARN',
          title: `${m.slug} has not produced a run in >24h`,
          body: `last run initialisation ${new Date(lastRunEpoch * 1000).toISOString()} — check Open-Meteo model status.`,
          dedupeKey: `model-stuck:${m.slug}`,
        });
      }
    } catch (e) {
      log('model meta sample failed — skipped', { model: m.slug, error: String(e) });
    }
  }

  // --- (4b) dead-man halt AUTO-RECOVERY (C3 / R-A6) --------------------------------
  // Placed LAST (FIX 7): the tomorrow-coverage + model-stuck WARN checks above must run even if the
  // recovery RPC throws, so recovery is the final step AND is wrapped so a failure logs+continues
  // (recovery failure must never fail the whole health pass).
  //
  // The apply path (§4) only STOPS re-applying once data goes fresh — the existing halt:global row
  // persists, leaving poll-markets halted() true indefinitely. Lift a SYSTEM-authored dead-man halt
  // only when: no global halt was applied THIS pass, forecast freshness is CURRENTLY healthy
  // (info-time-matched to the SAME staleForecastHaltH threshold), AND price freshness is healthy too
  // (else the price dead-man re-fires and clearing would race it). clear_system_halt is REASON-AWARE
  // (FIX 1): we pass ONLY the dead-man forecast/price prefixes, so a calibration-drift / P&L /
  // operator halt — whose reason carries no such prefix — is never auto-cleared. FIX 8: skip the
  // RPC round-trip entirely unless a halt:global is actually present in the config fetched here.
  try {
    // The config was fetched at job start; re-reading the raw rows here is the cheapest way to learn
    // BOTH whether a halt:global is present (FIX 8 — skip the clear RPC otherwise) and its stored
    // reason (FIX 10 — to key the recovery alert by episode, before the row is deleted).
    const haltGlobalRow = (await db.getConfigRows()).find((r) => r.key === 'halt:global');
    const dataFresh = forecastAgeH < cfg.staleForecastHaltH && priceAgeMin < cfg.stalePriceHaltMin;
    if (haltGlobalRow && !appliedGlobalHaltThisPass && dataFresh) {
      // The dead-man reason tag, matching the DEAD_MAN apply alert's dedupeKey construction
      // (reason.split(' ').slice(0,2).join('-')). Parsed from the stored JSON value's `reason`.
      let haltReason = '';
      try {
        haltReason = String((JSON.parse(haltGlobalRow.value) as { reason?: unknown }).reason ?? '');
      } catch {
        haltReason = '';
      }
      const reasonTag = haltReason.split(' ').slice(0, 2).join('-');
      const [cleared] = await db.rpc<{ clear_system_halt: boolean }>('clear_system_halt', {
        p_scope: 'global',
        p_reason_prefixes: [DEAD_MAN_FORECAST_REASON_PREFIX, DEAD_MAN_PRICE_REASON_PREFIX],
      });
      if (cleared?.clear_system_halt) {
        stats.recoveredHalts++;
        await deps.notify({
          kind: 'DEAD_MAN_RECOVERED',
          severity: 'WARN',
          title: 'Dead-man halt auto-cleared: global',
          body: `data freshness recovered (forecast ${forecastAgeH.toFixed(1)}h < ${cfg.staleForecastHaltH}h, price ${priceAgeMin.toFixed(0)}min < ${cfg.stalePriceHaltMin}min dead-man thresholds) — system-authored halt:global lifted automatically (C3/R-A6). Trading recommendations resume.`,
          // FIX 10: key by the recovered dead-man EPISODE (scope + reason tag, mirroring the DEAD_MAN
          // apply key) + the 6h bucket, so a forecast-outage recovery and a later price-outage recovery
          // are distinct alerts instead of being swallowed by a single global-only key.
          dedupeKey: `dead-man-recovered:global:${reasonTag}:${sixHourBucket}`,
        });
      }
    }
  } catch (e) {
    // Recovery is best-effort: never let a transient clear_system_halt failure fail the health pass.
    log('dead-man auto-recovery skipped (clear_system_halt failed)', { error: String(e) });
  }

  log('health pass complete', stats);
  return stats;
}
