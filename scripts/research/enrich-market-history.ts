/**
 * scripts/research/enrich-market-history — broadcast the per-event forecast lookup (build-forecast-lookup.ts)
 * onto EVERY price-point row of the flattened odds archive, so each row carries the predicted Tmax at 2 days
 * prior / 1 day prior / day-of (the forecast is constant per event, broadcast by `event_id`).
 *
 * Input:  out/market-history-flat.csv.gz  (city,target_date,event_id,end_ts,bucket_idx,label,resolved_outcome,t,p)
 *         out/forecast-by-event.csv        (event_id → pred_c_l2/1/0, pred_raw_l2/1/0, pred_bucket_l2/1/0)
 * Output: out/market-history-flat-enriched.csv.gz — the same rows + the forecast columns appended (blank when the
 *         event has no forecast: older/untracked events, or pre-2026-04-01 before the forecast capture started).
 *
 * Streaming + backpressure-aware (readline over the gunzip stream → gzip out) — never holds the 238 M-row set in
 * memory; only the ~2 134-event lookup map. Then re-run csv-to-parquet.py on the enriched file for the Parquet.
 *
 * Run: pnpm tsx scripts/research/enrich-market-history.ts
 *      pnpm tsx scripts/research/enrich-market-history.ts --in X.csv.gz --lookup Y.csv --out Z.csv.gz
 */
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { FORECAST_HEADER } from './build-forecast-lookup.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
/** the forecast columns appended to each row (the lookup header minus its join/meta cols event_id,fc_city,weather_date,unit). */
export const APPENDED_COLS = FORECAST_HEADER.split(',').slice(4); // pred_c_l2 … pred_bucket_l0
const BLANKS = ',' .repeat(APPENDED_COLS.length); // N empty cells for an event with no forecast

/** Load forecast-by-event.csv → Map<event_id, the appended forecast cells (comma-joined, no leading comma)>. */
export function loadLookup(path: string): Map<string, string> {
  const m = new Map<string, string>();
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const firstComma = line.indexOf(',');
    if (firstComma < 0) continue;
    const eventId = line.slice(0, firstComma);
    // drop the 4 meta cols (event_id,fc_city,weather_date,unit) → keep the forecast cells
    const parts = line.split(',');
    m.set(eventId, parts.slice(4).join(','));
  }
  return m;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { in: { type: 'string' }, lookup: { type: 'string' }, out: { type: 'string' } } });
  const inPath = values.in ?? join(OUT_DIR, 'market-history-flat.csv.gz');
  const lookupPath = values.lookup ?? join(OUT_DIR, 'forecast-by-event.csv');
  const outPath = values.out ?? join(OUT_DIR, 'market-history-flat-enriched.csv.gz');
  if (!existsSync(inPath)) throw new Error(`no flat file at ${inPath} — run flatten-market-history.ts first`);
  if (!existsSync(lookupPath)) throw new Error(`no lookup at ${lookupPath} — run build-forecast-lookup.ts first`);

  const lookup = loadLookup(lookupPath);
  process.stderr.write(`enrich-market-history · ${lookup.size} events in the forecast lookup\n`);

  const gz = createGzip({ level: 6 });
  const sink = createWriteStream(outPath);
  gz.pipe(sink);
  const write = async (chunk: string): Promise<void> => {
    if (!gz.write(chunk)) await once(gz, 'drain');
  };

  const rl = createInterface({ input: createReadStream(inPath).pipe(createGunzip()), crlfDelay: Infinity });
  let rows = 0;
  let enriched = 0;
  let buf = '';
  let headerDone = false;
  const eventIdCol = 2; // city,target_date,event_id,…  → index 2
  for await (const line of rl) {
    if (!headerDone) {
      // the header → append the forecast column names
      await write(`${line},${APPENDED_COLS.join(',')}\n`);
      headerDone = true;
      continue;
    }
    if (!line) continue;
    // event_id is the 3rd field; it never contains a comma (a numeric Gamma id), so a bounded split is safe.
    let c = 0, start = 0, eventId = '';
    for (let i = 0; i < line.length && c <= eventIdCol; i++) {
      if (line[i] === ',') {
        if (c === eventIdCol) { eventId = line.slice(start, i); break; }
        c++; start = i + 1;
      }
    }
    if (eventId === '' && c === eventIdCol) eventId = line.slice(start); // (defensive; event_id is never last)
    const fc = lookup.get(eventId);
    if (fc !== undefined) { buf += `${line},${fc}\n`; enriched++; }
    else buf += `${line}${BLANKS}\n`;
    rows++;
    if (buf.length > 1 << 20) { await write(buf); buf = ''; }
    if (rows % 20_000_000 === 0) process.stderr.write(`  …${rows.toLocaleString()} rows (${enriched.toLocaleString()} enriched)\n`);
  }
  if (buf) await write(buf);
  gz.end();
  await once(sink, 'finish');
  const bytes = statSync(outPath).size;
  process.stderr.write(
    `\n=== enrich complete: ${rows.toLocaleString()} rows · ${enriched.toLocaleString()} with a forecast ` +
    `(${rows ? ((100 * enriched) / rows).toFixed(1) : '0'}%) → ${outPath} (${(bytes / 1e6).toFixed(0)} MB gz)\n` +
    `    next: python scripts/research/csv-to-parquet.py --in "${outPath}" --out "${outPath.replace(/\.csv\.gz$/, '.parquet')}"\n`,
  );
}

if (import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
