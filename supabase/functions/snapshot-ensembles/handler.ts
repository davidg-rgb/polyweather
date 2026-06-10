/**
 * snapshot-ensembles — per-member ensemble capture (ARCHITECTURE.md §6.14, I2).
 */
import {
  UpstreamError,
  ensembleUrl,
  leadDays,
  parseEnsembleDaily,
} from '../../../packages/core/src/index.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface EnsembleDeps {
  fetchJson: (url: string) => Promise<unknown>;
  slot: '10Z' | '22Z';
  now: Date;
  omEnsembleBase: string;
  apiKey?: string;
}

/** models table slug → Ensemble API model string (one model per call — I2). */
const API_MODEL: Record<string, string> = {
  ecmwf_ifs025_ens: 'ecmwf_ifs025',
  gfs05_ens: 'gfs05',
};

export async function snapshotEnsembles(ctx: JobCtx, deps: EnsembleDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const stations = await db.rpc<{ icao: string; lat: number; lon: number; tz: string }>(
    'list_active_stations',
    {},
  );
  const models = (await db.rpc<{ slug: string }>('list_enabled_models', { p_is_ensemble: true })).map(
    (m) => m.slug,
  );

  let rowsUpserted = 0;
  let callsFailed = 0;

  for (const st of stations) {
    for (const slug of models) {
      const apiModel = API_MODEL[slug];
      if (!apiModel) {
        log('no API mapping for ensemble model — skipped', { slug });
        continue;
      }
      let members;
      try {
        const json = await deps.fetchJson(
          ensembleUrl(deps.omEnsembleBase, { lat: Number(st.lat), lon: Number(st.lon) }, apiModel, 16, deps.apiKey),
        );
        members = parseEnsembleDaily(json);
      } catch (e) {
        if (e instanceof UpstreamError) {
          callsFailed++;
          log('ensemble call failed', { icao: st.icao, slug, error: String(e) });
          continue;
        }
        throw e;
      }

      // member rows → one array per target date
      const byDate = new Map<string, number[]>();
      for (const m of members) {
        const arr = byDate.get(m.targetDate) ?? [];
        arr.push(m.tmaxC);
        byDate.set(m.targetDate, arr);
      }
      const rows = [...byDate.entries()]
        .map(([targetDate, arr]) => ({ targetDate, arr, lead: leadDays(deps.now, targetDate, st.tz) }))
        .filter((r) => r.lead >= 0 && r.lead <= 16);

      const [n] = await db.rpc<{ upsert_ensemble_rows: number }>('upsert_ensemble_rows', {
        p_rows: rows.map((r) => ({
          icao: st.icao,
          model: slug,
          target_date: r.targetDate,
          lead_days: r.lead,
          snapshot_slot: deps.slot,
          members_c: r.arr,
          n_members: r.arr.length,
          captured_at: deps.now.toISOString(),
        })),
      });
      rowsUpserted += n?.upsert_ensemble_rows ?? 0;
    }
  }

  const stats = { stations: stations.length, models: models.length, rowsUpserted, callsFailed };
  log('ensemble snapshot complete', stats);
  return stats;
}
