/**
 * snapshot-forecasts — multi-model forecast capture + gap-fill (ARCHITECTURE.md §6.14).
 */
import {
  UpstreamError,
  forecastUrl,
  leadDays,
  parseMultiModelDaily,
  parsePreviousRunsHourly,
  previousRunsUrl,
} from '../../../packages/core/src/index.ts';
import type { Alert } from '../_shared/slack.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface SnapshotDeps {
  fetchJson: (url: string) => Promise<unknown>;
  notify: (alert: Alert) => Promise<boolean>;
  slot: '10Z' | '22Z';
  now: Date;
  omForecastBase: string;
  omPreviousRunsBase: string;
  apiKey?: string;
}

/** Previous-runs gap repair supports the 8 real models — best_match is unverified there. */
const PREV_RUNS_MODELS = new Set([
  'ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'jma_seamless',
  'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'cma_grapes_global',
]);

interface Station {
  icao: string;
  lat: number;
  lon: number;
  tz: string;
}

export async function snapshotForecasts(ctx: JobCtx, deps: SnapshotDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const stations = await db.rpc<Station>('list_active_stations', {});
  const models = (await db.rpc<{ slug: string }>('list_enabled_models', { p_is_ensemble: false })).map(
    (m) => m.slug,
  );

  let rowsUpserted = 0;
  let stationsFailed = 0;
  const rowsPerModel = new Map<string, number>(models.map((m) => [m, 0]));

  for (const st of stations) {
    let parsed;
    try {
      const json = await deps.fetchJson(
        forecastUrl(deps.omForecastBase, { lat: Number(st.lat), lon: Number(st.lon) }, models, 16, deps.apiKey),
      );
      parsed = parseMultiModelDaily(json, models);
    } catch (e) {
      if (e instanceof UpstreamError) {
        stationsFailed++;
        log('station snapshot failed', { icao: st.icao, error: String(e) });
        continue;
      }
      throw e;
    }

    const rows = parsed
      .map((r) => ({ ...r, lead: leadDays(deps.now, r.targetDate, st.tz) }))
      .filter((r) => r.lead >= 0 && r.lead <= 16);
    for (const r of rows) rowsPerModel.set(r.model, (rowsPerModel.get(r.model) ?? 0) + 1);

    const [n] = await db.rpc<{ upsert_forecast_rows: number }>('upsert_forecast_rows', {
      p_rows: rows.map((r) => ({
        icao: st.icao,
        model: r.model,
        target_date: r.targetDate,
        lead_days: r.lead,
        tmax_c: r.tmaxC,
        snapshot_slot: deps.slot,
        source: 'forecast_api',
        captured_at: deps.now.toISOString(),
      })),
    });
    rowsUpserted += n?.upsert_forecast_rows ?? 0;
  }

  if (stations.length > 0 && stationsFailed / stations.length > 0.2) {
    await deps.notify({
      kind: 'SNAPSHOT_PARTIAL',
      severity: 'WARN',
      title: `snapshot-forecasts: ${stationsFailed}/${stations.length} stations failed`,
      body: `slot ${deps.slot} — partial stats recorded; next slot retries naturally`,
      dedupeKey: `snapshot-partial:${deps.slot}`,
    });
  }

  // MODEL_DEGRADED: a model contributing zero rows across ALL stations, 3 runs straight.
  const modelsMissing: string[] = [];
  for (const model of models) {
    const wasNull = stations.length > 0 && (rowsPerModel.get(model) ?? 0) === 0;
    const [streakRow] = await db.rpc<{ bump_model_null_streak: number }>('bump_model_null_streak', {
      p_model: model,
      p_was_null: wasNull,
    });
    const streak = streakRow?.bump_model_null_streak ?? 0;
    if (wasNull) modelsMissing.push(model);
    if (streak >= 3) {
      await deps.notify({
        kind: 'MODEL_DEGRADED',
        severity: 'WARN',
        title: `Model ${model} returned no data for ${streak} consecutive runs`,
        body: 'Check Open-Meteo status; consider disabling the model row.',
        dedupeKey: `model-degraded:${model}`,
      });
      await db.rpc('bump_model_null_streak', { p_model: model, p_was_null: false }); // reset after alerting
    }
  }

  // GAP-FILL via previous-runs for stations with holes in the last 7 days.
  let gapsRepaired = 0;
  const gaps = await db.rpc<{ icao: string; model: string; target_date: string }>('forecast_gap_matrix', {
    p_days: 7,
  });
  const byStation = new Map<string, { models: Set<string>; dates: string[] }>();
  for (const g of gaps) {
    if (!PREV_RUNS_MODELS.has(g.model)) continue;
    const entry = byStation.get(g.icao) ?? { models: new Set(), dates: [] };
    entry.models.add(g.model);
    // PostgREST serializes date columns as strings; PGlite hands back Date objects.
    const date =
      typeof g.target_date === 'string'
        ? g.target_date.slice(0, 10)
        : new Date(g.target_date as unknown as Date).toISOString().slice(0, 10);
    entry.dates.push(date);
    byStation.set(g.icao, entry);
  }
  for (const [icao, gap] of byStation) {
    const st = stations.find((s) => s.icao === icao);
    if (!st) continue;
    const dates = gap.dates.sort();
    try {
      const json = await deps.fetchJson(
        previousRunsUrl(
          deps.omPreviousRunsBase,
          { lat: Number(st.lat), lon: Number(st.lon) },
          [...gap.models],
          [1, 2, 3, 4, 5, 6, 7],
          { start: dates[0]!, end: dates[dates.length - 1]! },
          deps.apiKey,
        ),
      );
      const repaired = parsePreviousRunsHourly(json, [...gap.models], [1, 2, 3, 4, 5, 6, 7], st.tz);
      if (repaired.length > 0) {
        const [n] = await db.rpc<{ upsert_forecast_rows: number }>('upsert_forecast_rows', {
          p_rows: repaired.map((r) => ({
            icao,
            model: r.model,
            target_date: r.targetDate,
            lead_days: r.leadDays,
            tmax_c: r.tmaxC,
            snapshot_slot: 'gapfill',
            source: 'previous_runs',
            captured_at: deps.now.toISOString(),
          })),
        });
        gapsRepaired += n?.upsert_forecast_rows ?? 0;
      }
    } catch (e) {
      log('gap-fill failed', { icao, error: String(e) });
    }
  }

  const stats = { stations: stations.length, stationsFailed, rowsUpserted, gapsRepaired, modelsMissing };
  log('snapshot complete', stats);
  return stats;
}
