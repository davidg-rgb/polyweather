/**
 * snapshot-sources — autonomous twice-daily capture of external comparison
 * sources (OpenWeatherMap, WeatherAPI.com) into source_forecasts
 * (ARCHITECTURE.md § external-source accuracy tracking; migration 0025).
 *
 * Deliberately ISOLATED from trading: these forecasts are scored against the
 * same WU/IEM truth by source_accuracy / check-source-accuracy but never enter
 * list_enabled_models, the house blend, or run-calibration. The capture loop is
 * the SHARED _shared/source-capture.ts module — the same code the local seed
 * script (scripts/snapshot-source-forecasts.ts) runs — so the two never drift.
 */
import {
  captureSourceForecasts,
  slotForHour,
  type SourceDef,
  type StationCoord,
} from '../_shared/source-capture.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface SnapshotSourcesDeps {
  fetchJson: (url: string) => Promise<unknown>;
  notify: (alert: Alert) => Promise<boolean>;
  sources: SourceDef[];
  now: Date;
}

export async function snapshotSources(ctx: JobCtx, deps: SnapshotSourcesDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const stations = await db.rpc<StationCoord>('list_active_stations', {});
  const slot = slotForHour(deps.now);

  // A deploy with no source keys captures nothing forever — make that loud once.
  if (deps.sources.length === 0) {
    await deps.notify({
      kind: 'CONFIG',
      severity: 'WARN',
      title: 'snapshot-sources: no source API keys configured',
      body: 'Set OPENWEATHERMAP_API_KEY and/or WEATHERAPI_API_KEY as Edge Function secrets — no external-source forecasts are being captured.',
      dedupeKey: 'snapshot-sources:no-keys',
    });
    return { stations: stations.length, slot, rows: 0, written: 0, perSource: {}, failures: 0, sources: 0 };
  }

  const { rows, perSource, failures } = await captureSourceForecasts(stations, deps.sources, deps.fetchJson, deps.now);

  let written = 0;
  if (rows.length > 0) {
    const [r] = await db.rpc<{ upsert_source_forecasts: number }>('upsert_source_forecasts', { p_rows: rows });
    written = Number(r?.upsert_source_forecasts ?? 0);
  }

  // Every fetch failing with nothing captured = a dead key / upstream outage — surface it.
  if (rows.length === 0 && failures > 0) {
    await deps.notify({
      kind: 'SOURCE_FETCH',
      severity: 'WARN',
      title: 'snapshot-sources: every source fetch failed',
      body: `${failures} fetch failures across ${stations.length} stations, 0 rows captured — check source API keys/quotas.`,
      dedupeKey: 'snapshot-sources:all-failed',
    });
  }

  const stats: JobStats = {
    stations: stations.length,
    slot,
    rows: rows.length,
    written,
    perSource,
    failures,
    sources: deps.sources.length,
  };
  log('source snapshot', stats);
  return stats;
}
