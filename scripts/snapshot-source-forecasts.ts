/**
 * scripts/snapshot-source-forecasts — local/manual capture of external-source
 * daily-max forecasts into source_forecasts (§ external-source accuracy tracking).
 *
 * For every coord-seeded station, fetch each available comparison source's
 * daily-max forecast and upsert into source_forecasts. The capture loop is the
 * SHARED supabase/functions/_shared/source-capture.ts module — the exact code
 * the autonomous snapshot-sources Edge Function runs twice a day — so this seed
 * and the cron can never diverge. Sources are built from whatever keys are in
 * .env.local (auto-loaded).
 *
 * Requires source_forecasts (migration 0025) on the target DB. For ONGOING
 * daily accumulation, deploy the snapshot-sources Edge Function and set
 * OPENWEATHERMAP_API_KEY / WEATHERAPI_API_KEY as Edge Function secrets (see
 * RUNBOOK § external-source collection); this script remains the manual seed /
 * backfill path. Run: pnpm tsx scripts/snapshot-source-forecasts.ts
 */
import { pathToFileURL } from 'node:url';
import {
  captureSourceForecasts,
  sourcesFromKeys,
  type SourceDef,
} from '../supabase/functions/_shared/source-capture.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';
import type { ScriptDb } from './lib/script-db.ts';

export type { SourceDef };
export type Db = Pick<ScriptDb, 'query'>;

export interface SnapshotSourceDeps {
  fetchJson: (url: string) => Promise<unknown>;
  sources: SourceDef[];
  now: Date;
}

export interface SnapshotSourceStats {
  stations: number;
  slot: '10Z' | '22Z';
  rows: number;
  written: number;
  perSource: Record<string, number>;
  failures: number;
}

interface Station {
  icao: string;
  lat: number;
  lon: number;
  tz: string;
}

export async function snapshotSourceForecasts(db: Db, deps: SnapshotSourceDeps): Promise<SnapshotSourceStats> {
  const stations = await db.query<Station>(
    `select icao, lat::float8 as lat, lon::float8 as lon, tz from stations where lat is not null and lon is not null order by icao`,
  );
  const { rows, perSource, failures, slot } = await captureSourceForecasts(
    stations.map((s) => ({ icao: s.icao, lat: Number(s.lat), lon: Number(s.lon), tz: s.tz })),
    deps.sources,
    deps.fetchJson,
    deps.now,
  );

  let written = 0;
  if (rows.length > 0) {
    // raw array under ::jsonb — postgres-js JSON-encodes it (never pre-stringify)
    const [res] = await db.query<{ n: number }>('select upsert_source_forecasts($1::jsonb) as n', [rows]);
    written = Number(res?.n ?? 0);
  }

  return { stations: stations.length, slot, rows: rows.length, written, perSource, failures };
}

/** Build the live source list from whatever API keys are present. */
export function liveSources(env: NodeJS.ProcessEnv): SourceDef[] {
  return sourcesFromKeys({ owm: env['OPENWEATHERMAP_API_KEY'], weatherapi: env['WEATHERAPI_API_KEY'] });
}

async function liveFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': 'weather-edge/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const sources = liveSources(process.env);
  if (sources.length === 0) {
    console.error('No source API keys set (OPENWEATHERMAP_API_KEY / WEATHERAPI_API_KEY) — nothing to capture.');
    process.exit(1);
  }
  const db = makeScriptDb();
  snapshotSourceForecasts(db, { fetchJson: liveFetchJson, sources, now: new Date() })
    .then((stats) => {
      console.log(
        `snapshot-source-forecasts: ${stats.stations} stations, slot ${stats.slot}, ` +
          `${stats.written} rows written ${JSON.stringify(stats.perSource)}, ${stats.failures} fetch failures`,
      );
    })
    .catch((err) => {
      console.error('snapshot-source-forecasts crashed:', err?.message ?? err);
      process.exitCode = 1;
    })
    .finally(() => db.end());
}
