/**
 * scripts/seed-stations — OurAirports → stations table (ARCHITECTURE.md §6.22).
 *
 * Downloads airports.csv (cached locally), upserts coordinates/name/country
 * for every ICAO referenced by city_stations plus the research-known set, and
 * prints unmatched ICAOs for manual entry. tz comes from tz-lookup on the
 * coordinates; an operator-set (non-provisional) tz is never overwritten.
 *
 * Run: pnpm tsx scripts/seed-stations.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tzlookup from 'tz-lookup';
import { parseCsvWithHeader } from './lib/csv.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

const AIRPORTS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const CACHE_PATH = join(dirname(fileURLToPath(import.meta.url)), '.cache', 'airports.csv');

/** Stations the research corpus references regardless of discovery state. */
export const RESEARCH_ICAOS = ['RKSI', 'EGLL', 'KORD', 'KLGA', 'EGLC', 'LFPB'];

export interface StationRow {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  elevationM: number | null;
  countryCode: string;
  /** US state from iso_region (US-IL → IL) — the IEM {ST}_ASOS network needs it. */
  usState: string | null;
  tz: string;
}

/** Pure transform: OurAirports CSV + wanted ICAOs → station rows + unmatched list. */
export function buildStationRows(
  csvText: string,
  icaos: string[],
): { matched: StationRow[]; unmatched: string[] } {
  const wanted = new Set(icaos.map((i) => i.toUpperCase()));
  const byIdent = new Map<string, Record<string, string>>();
  for (const row of parseCsvWithHeader(csvText)) {
    const ident = row['ident']?.toUpperCase();
    const gps = row['gps_code']?.toUpperCase();
    if (ident && wanted.has(ident) && !byIdent.has(ident)) byIdent.set(ident, row);
    if (gps && wanted.has(gps) && !byIdent.has(gps)) byIdent.set(gps, row);
  }

  const matched: StationRow[] = [];
  const unmatched: string[] = [];
  for (const icao of wanted) {
    const row = byIdent.get(icao);
    const lat = row ? Number(row['latitude_deg']) : NaN;
    const lon = row ? Number(row['longitude_deg']) : NaN;
    if (!row || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      unmatched.push(icao);
      continue;
    }
    const elevationFt = Number(row['elevation_ft']);
    const cc = (row['iso_country'] ?? 'ZZ').toUpperCase();
    const region = row['iso_region'] ?? '';
    matched.push({
      icao,
      name: row['name'] ?? icao,
      lat,
      lon,
      elevationM: Number.isFinite(elevationFt) ? Math.round(elevationFt * 0.3048 * 10) / 10 : null,
      countryCode: cc,
      usState: cc === 'US' && /^US-[A-Z]{2}$/.test(region) ? region.slice(3) : null,
      tz: tzlookup(lat, lon),
    });
  }
  return { matched, unmatched: unmatched.sort() };
}

export interface SeedDeps {
  db: Pick<ScriptDb, 'query'>;
  fetchCsv: () => Promise<string>;
  log: (msg: string) => void;
}

export async function seedStations(deps: SeedDeps): Promise<{ updated: number; unmatched: string[] }> {
  const referenced = await deps.db.query<{ icao: string }>(
    `select distinct icao from city_stations
     union
     select icao from stations
     union
     select unnest($1::text[])`,
    [RESEARCH_ICAOS],
  );
  const icaos = referenced.map((r) => r.icao);
  deps.log(`seeding ${icaos.length} ICAO(s) from OurAirports…`);

  const { matched, unmatched } = buildStationRows(await deps.fetchCsv(), icaos);
  for (const s of matched) {
    // tz: only replace PROVISIONAL (Etc/*) zones — operator overrides stick (§6.22).
    await deps.db.query(
      `insert into stations (icao, name, lat, lon, elevation_m, country_code, us_state, tz, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'ourairports')
       on conflict (icao) do update
         set name = excluded.name,
             lat = excluded.lat,
             lon = excluded.lon,
             elevation_m = excluded.elevation_m,
             country_code = excluded.country_code,
             us_state = excluded.us_state,
             tz = case when stations.tz like 'Etc/%' then excluded.tz else stations.tz end,
             source = 'ourairports'`,
      [s.icao, s.name, s.lat, s.lon, s.elevationM, s.countryCode, s.usState, s.tz],
    );
  }

  if (unmatched.length > 0) {
    deps.log(`UNMATCHED ICAOs (manual entry needed): ${unmatched.join(', ')}`);
  }
  deps.log(`updated ${matched.length} station(s); ${unmatched.length} unmatched`);
  return { updated: matched.length, unmatched };
}

/** Download with a local cache — the CSV is ~12MB and changes rarely. */
export async function fetchAirportsCsv(): Promise<string> {
  if (existsSync(CACHE_PATH)) {
    return readFileSync(CACHE_PATH, 'utf8');
  }
  const res = await fetch(AIRPORTS_CSV_URL);
  if (!res.ok) throw new Error(`airports.csv download failed: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, text, 'utf8');
  return text;
}

// CLI entry — only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = makeScriptDb();
  try {
    await seedStations({ db, fetchCsv: fetchAirportsCsv, log: console.log });
  } finally {
    await db.end();
  }
}
