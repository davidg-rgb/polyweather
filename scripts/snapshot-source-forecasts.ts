/**
 * scripts/snapshot-source-forecasts — capture external-source daily-max
 * forecasts into source_forecasts (§ external-source accuracy tracking).
 *
 * For every coord-seeded station, fetch each available comparison source's
 * daily-max forecast, derive the lead from the station-local target date, and
 * upsert into source_forecasts (slot = 10Z for an AM-UTC run, 22Z otherwise —
 * two captures/day, mirroring the Open-Meteo cadence). Sources are pluggable:
 * OpenWeatherMap is wired now; WeatherAPI joins once its key is valid and its
 * parser+fixture land. A source erroring on one station is skipped, not fatal.
 *
 * Requires source_forecasts (migration 0025) on the target DB and the source
 * API keys in .env.local (auto-loaded). Run: pnpm tsx scripts/snapshot-source-forecasts.ts
 */
import { pathToFileURL } from 'node:url';
import { leadDays, owmForecastUrl, parseOwmDailyMax } from '../packages/core/src/index.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb } from './lib/script-db.ts';
import type { ScriptDb } from './lib/script-db.ts';

export type Db = Pick<ScriptDb, 'query'>;

export interface SourceDef {
  source: string;
  url: (coords: { lat: number; lon: number }) => string;
  parse: (json: unknown, tz: string) => { targetDate: string; tmaxC: number }[];
}

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
  const slot: '10Z' | '22Z' = deps.now.getUTCHours() < 16 ? '10Z' : '22Z';

  const rows: Record<string, unknown>[] = [];
  const perSource: Record<string, number> = {};
  let failures = 0;

  for (const st of stations) {
    for (const src of deps.sources) {
      try {
        const json = await deps.fetchJson(src.url({ lat: Number(st.lat), lon: Number(st.lon) }));
        const days = src.parse(json, st.tz);
        for (const d of days) {
          const lead = leadDays(deps.now, d.targetDate, st.tz);
          if (lead < 0 || lead > 16) continue;
          rows.push({
            icao: st.icao,
            source: src.source,
            target_date: d.targetDate,
            lead_days: lead,
            snapshot_slot: slot,
            tmax_c: d.tmaxC,
            captured_at: deps.now.toISOString(),
          });
          perSource[src.source] = (perSource[src.source] ?? 0) + 1;
        }
      } catch {
        failures++;
      }
    }
  }

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
  const sources: SourceDef[] = [];
  const owmKey = env['OPENWEATHERMAP_API_KEY'];
  if (owmKey) {
    sources.push({
      source: 'openweathermap',
      url: (c) => owmForecastUrl(c, owmKey),
      parse: parseOwmDailyMax,
    });
  }
  // WeatherAPI joins here once WEATHERAPI_API_KEY is valid and its parser lands.
  return sources;
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
