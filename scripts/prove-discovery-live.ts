/**
 * prove-discovery-live — the §14 P2 DoD evidence run, hosted-Supabase-free:
 * boots an embedded Postgres (PGlite + full migration chain), runs the REAL
 * discover-markets handler against the LIVE Gamma API, then seed-stations
 * against the LIVE OurAirports CSV, and asserts the DoD:
 *   - live run discovers all ~49 cities
 *   - stations resolved for ≥45 with coordinates
 *
 * Run: pnpm tsx scripts/prove-discovery-live.ts
 */
import { fetchJson } from '../packages/io/src/index.ts';
import { discoverMarkets } from '../supabase/functions/discover-markets/handler.ts';
import type { Alert } from '../supabase/functions/_shared/slack.ts';
import { freshDb, rows } from '../supabase/tests/harness.ts';
import { pglitePort } from '../supabase/tests/pglite-port.ts';
import { fetchAirportsCsv, seedStations } from './seed-stations.ts';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

const db = await freshDb();
const port = pglitePort(db);
const alerts: Alert[] = [];

console.log('— live discovery against', GAMMA_BASE);
const stats = await discoverMarkets(
  {
    db: port,
    config: { jobWallLimitSec: 150 } as never,
    log: (msg, extra) => console.log(`  [job] ${msg}`, extra ?? ''),
    startedAt: new Date(),
  },
  {
    fetchPage: (offset) =>
      fetchJson(`${GAMMA_BASE}/events?tag_id=104596&active=true&closed=false&limit=100&offset=${offset}`),
    notify: async (a) => {
      alerts.push(a);
      return true;
    },
    todayUtcISO: new Date().toISOString().slice(0, 10),
  },
);
console.log('  stats:', JSON.stringify(stats));

console.log('— seed-stations against live OurAirports');
const scriptDb = {
  query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const pgParams = params.map((p) =>
      Array.isArray(p) ? `{${p.map((x) => `"${String(x)}"`).join(',')}}` : p,
    );
    return (await db.query<T>(sql, pgParams)).rows;
  },
};
const seeded = await seedStations({ db: scriptDb, fetchCsv: fetchAirportsCsv, log: (m) => console.log(`  ${m}`) });

const cities = (await rows<{ n: number }>(db, 'select count(*)::int as n from cities'))[0]!.n;
const withCoords = (
  await rows<{ n: number }>(
    db,
    `select count(distinct cs.icao)::int as n
     from city_stations cs join stations s on s.icao = cs.icao
     where cs.valid_to is null and s.lat is not null`,
  )
)[0]!.n;
const events = (await rows<{ n: number }>(db, 'select count(*)::int as n from market_events'))[0]!.n;
const buckets = (await rows<{ n: number }>(db, 'select count(*)::int as n from market_buckets'))[0]!.n;

console.log('\n=== P2 DoD evidence ===');
console.log(`cities discovered:            ${cities}`);
console.log(`stations mapped w/ coords:    ${withCoords}`);
console.log(`market events / buckets:      ${events} / ${buckets}`);
console.log(`zombies filtered:             ${stats['zombies']}`);
console.log(`parse failures:               ${stats['parseFailures']}`);
console.log(`unmatched ICAOs:              ${seeded.unmatched.join(', ') || '(none)'}`);
console.log(`alerts (NEW_CITY/STATION/…):  ${alerts.length}`);

await db.close();

const pass = cities >= 45 && withCoords >= 45;
console.log(pass ? '\nP2 DoD: PASS' : '\nP2 DoD: FAIL');
process.exit(pass ? 0 : 1);
