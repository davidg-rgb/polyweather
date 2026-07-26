/**
 * synoptic-history-pull — secure the trial's rolling ~6-day 5-min obs window
 * for every US Polymarket city, before it slides away (probe 2026-07-25: 5d
 * back serves, 7d back 403s). One batched multi-station request per UTC day →
 * ① local NDJSON archive (scripts/research/out/synoptic-obs-archive/) and
 * ② the DB `synoptic_obs` corpus via the same idempotent RPC the live lane
 * uses (re-runs are safe; on-conflict-do-nothing).
 *
 * Usage: pnpm tsx scripts/research/synoptic-history-pull.ts [--from 2026-07-20] [--to 2026-07-25]
 * Budget: 1 request per day pulled (~6 on first run).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSynopticTimeseries } from '../../packages/core/src/index.ts';
import { loadEnv } from '../lib/load-env';
import { makeScriptDb } from '../lib/script-db.ts';

const OUT_DIR = join('scripts', 'research', 'out', 'synoptic-obs-archive');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function* utcDays(fromISO: string, toISO: string): Generator<string> {
  let t = Date.parse(fromISO + 'T00:00:00Z');
  const end = Date.parse(toISO + 'T00:00:00Z');
  for (; t <= end; t += 86400000) yield new Date(t).toISOString().slice(0, 10);
}

async function main() {
  loadEnv();
  const token = process.env.SYNOPTIC_PUBLIC_TOKEN ?? '';
  if (!token) throw new Error('SYNOPTIC_PUBLIC_TOKEN missing');
  const red = (s: string) => s.split(token).join('TOKEN_REDACTED');

  const db = makeScriptDb();
  try {
    const stations = await db.query<{ icao: string }>(
      `select distinct s.icao from stations s
       join city_stations cs on cs.icao = s.icao and cs.valid_to is null
       join cities c on c.id = cs.city_id
       where s.country_code = 'US' and c.last_seen > now() - interval '7 days'
       order by s.icao`,
    );
    const icaos = stations.map((s) => s.icao);
    console.log(`US Polymarket stations: ${icaos.join(' ')}`);

    const today = new Date().toISOString().slice(0, 10);
    const from = arg('from') ?? new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    const to = arg('to') ?? today;
    mkdirSync(OUT_DIR, { recursive: true });

    let totalObs = 0;
    let totalInserted = 0;
    for (const day of utcDays(from, to)) {
      const qs = new URLSearchParams({
        stid: icaos.join(','),
        start: day.replace(/-/g, '') + '0000',
        end: day.replace(/-/g, '') + '2359',
        vars: 'air_temp',
        units: 'metric',
        hfmetars: '1',
        obtimezone: 'utc',
        token,
      });
      let raw: unknown;
      try {
        const res = await fetch(`https://api.synopticdata.com/v2/stations/timeseries?${qs}`, {
          signal: AbortSignal.timeout(60000),
        });
        raw = await res.json();
      } catch (err) {
        console.log(`${day} → FETCH ERROR ${red(String(err)).slice(0, 100)}`);
        continue;
      }
      let obs;
      try {
        obs = parseSynopticTimeseries(raw);
      } catch (err) {
        console.log(`${day} → PARSE ERROR ${red(String(err)).slice(0, 100)}`);
        continue;
      }
      const rows = obs.map((o) => ({
        icao: o.icaoId,
        obs_at: new Date(o.obsTimeUtc * 1000).toISOString(),
        temp_tenths_c: o.tempTenthsC,
      }));
      // ① local NDJSON (idempotent overwrite per day)
      writeFileSync(join(OUT_DIR, `${day}.ndjson`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      // ② DB corpus via the same RPC (chunked; on-conflict-do-nothing)
      let inserted = 0;
      for (let i = 0; i < rows.length; i += 1000) {
        // RAW array — postgres-js detects the ::jsonb cast and JSON-encodes it
        const chunk = rows.slice(i, i + 1000);
        const [r] = await db.query<{ n: number }>(`select synoptic_obs_log($1::jsonb) as n`, [chunk]);
        inserted += r?.n ?? 0;
      }
      const byStation = new Set(rows.map((r) => r.icao)).size;
      console.log(`${day} → ${rows.length} obs / ${byStation} stations · ${inserted} new DB rows`);
      totalObs += rows.length;
      totalInserted += inserted;
    }
    console.log(`DONE: ${totalObs} obs archived locally, ${totalInserted} new DB rows.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
