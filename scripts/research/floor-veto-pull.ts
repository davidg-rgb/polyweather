/**
 * scripts/research/floor-veto-pull — DB slices for the FLOOR-VETO backtest (read-only).
 *
 * The floor-veto question: should the live buy-table lane refuse entries whose picked bucket sits
 * ≥N°C above the current METAR running-max floor late in the station-local day? The replay itself
 * runs over the local opening-captures archive (the per-tick real book + houseProb — what the lane
 * actually sees); this script pulls only the small DB-side joins the archive rows don't carry:
 *
 *   out/floor-veto/events.csv    — winner idx + mismatch + the 0106 fold pick (selector validation)
 *                                  for every city-day event in the window
 *   out/floor-veto/advances.csv  — intraday_advances (the running-max floor log as our DB learned it)
 *   out/floor-veto/config.csv    — buy_table.* / bot.* tunables (lane-parity gates)
 *   out/floor-veto/live_fills.csv— the actual live entry fills (frozen-veto would-have-blocked check)
 *
 * Run: pnpm tsx scripts/research/floor-veto-pull.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'floor-veto');

const csv = (rows: Record<string, unknown>[]): string => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  mkdirSync(OUT, { recursive: true });

  const events = await db.query(
    `select me.id as event_id, c.slug as city, c.unit, cs.icao, me.target_date,
            coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) as winner_idx,
            coalesce(me.grading_mismatch, false) as mismatch,
            g.predicted_idx as fold_predicted_idx, g.graded_capture_at as fold_capture_at, g.hit as fold_hit
     from market_events me
     join cities c on c.id = me.city_id
     join city_stations cs on cs.city_id = c.id
     left join city_prediction_grades g on g.event_id = me.id
     where me.target_date between '2026-07-01' and '2026-07-28'
     order by me.target_date, c.slug`,
  );
  writeFileSync(join(OUT, 'events.csv'), csv(events));
  console.log(`events.csv: ${events.length} rows`);

  const advances = await db.query(
    `select icao, date_local, local_hour, max_tenths_c, created_at
     from intraday_advances
     where date_local between '2026-06-28' and '2026-07-28'
     order by icao, created_at`,
  );
  writeFileSync(join(OUT, 'advances.csv'), csv(advances));
  console.log(`advances.csv: ${advances.length} rows`);

  const config = await db.query(
    `select key, value::text as value from config
     where key like 'buy_table.%' or key like 'bot.%'
     order by key`,
  );
  writeFileSync(join(OUT, 'config.csv'), csv(config));
  console.log(`config.csv: ${config.length} rows`);

  const fills = await db.query(
    `select lo.created_at, lo.trade_date, lo.avg_price, lo.size_matched, lo.status,
            lo.market_id as condition_id, mb.label, mb.low_native, mb.high_native, mb.bucket_idx,
            c.slug as city, c.unit, cs.icao, me.target_date,
            coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) as winner_idx
     from live_orders lo
     join market_buckets mb on mb.condition_id = lo.market_id
     join market_events me on me.id = mb.event_id
     join cities c on c.id = me.city_id
     join city_stations cs on cs.city_id = c.id
     where lo.mode = 'live' and lo.side = 'BUY' and lo.purpose = 'entry' and lo.status = 'filled'
     order by lo.created_at`,
  );
  writeFileSync(join(OUT, 'live_fills.csv'), csv(fills));
  console.log(`live_fills.csv: ${fills.length} rows`);

  await db.end();
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
