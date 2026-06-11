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
 * (5) Open-Meteo model meta sampled — a model stuck >24h ⇒ WARN.
 * (6) Tomorrow-events sanity: ≥80% of active cities must have tomorrow's event.
 */
import { evaluateBreakers } from '../../../packages/core/src/index.ts';
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

/** §6.19 staleness matrix, minutes (W7: discovery 10h). */
const STALENESS_MATRIX: Record<string, number> = {
  'poll-markets': 15,
  'metar-nowcast': 45,
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
    staleJobs: 0, reaped: 0, resent: 0, deadManHalts: 0,
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

  log('health pass complete', stats);
  return stats;
}
