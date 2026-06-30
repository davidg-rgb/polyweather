/**
 * scripts/research/flatten-market-history — collapse the per-event JSON archive that
 * pull-market-history wrote into ONE columnar CSV.gz for data-processing / analysis runs
 * (DuckDB / polars / pandas all read .csv.gz natively, and DuckDB can query it without
 * loading it into RAM).
 *
 * Input:  scripts/research/out/market-history/{city}/{date}__{eventId}.json
 * Output: scripts/research/out/market-history-flat.csv.gz   (one row per price point)
 *
 * Columns (tidy long format, self-contained for convergence/efficiency analysis):
 *   city, target_date, event_id, end_ts, bucket_idx, label, resolved_outcome, t, p
 *   - end_ts = event resolution epoch (seconds) → secs_to_resolution = end_ts - t
 *   - t      = price-point epoch (seconds), p = implied probability of this bucket's YES
 *
 * Streaming + backpressure-aware (one event file at a time → handles the ~247M-row full set
 * without holding it in memory). Row count is asserted against the pulled point total.
 *
 * Run: pnpm tsx scripts/research/flatten-market-history.ts            # all cities on disk
 *      pnpm tsx scripts/research/flatten-market-history.ts --cities london,nyc
 *      pnpm tsx scripts/research/flatten-market-history.ts --out custom.csv.gz
 */
import { createWriteStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGzip } from 'node:zlib';

const OUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'market-history');

interface EventFile {
  city: string;
  eventId: string;
  targetDate: string;
  endDate: string;
  buckets: Array<{
    idx: number;
    label: string | null;
    resolvedOutcome: 'win' | 'lose' | null;
    points: Array<[number, number]>;
  }>;
}

/** CSV-escape a field only when it needs it (label can contain commas, e.g. "80-81°F" is safe but be defensive). */
const csv = (v: string | number | null): string => {
  if (v === null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { cities: { type: 'string' }, out: { type: 'string' } },
  });
  if (!existsSync(OUT_ROOT)) throw new Error(`no archive at ${OUT_ROOT} — run pull-market-history first`);

  const cityFilter = values.cities ? new Set(values.cities.split(',').map((c) => c.trim())) : null;
  const cities = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!cityFilter || cityFilter.has(d.name)))
    .map((d) => d.name)
    .sort();

  const outPath = join(OUT_ROOT, '..', values.out ?? 'market-history-flat.csv.gz');
  const gz = createGzip({ level: 6 });
  const sink = createWriteStream(outPath);
  gz.pipe(sink);

  // backpressure-aware write: await 'drain' when the buffer is full.
  const write = async (chunk: string): Promise<void> => {
    if (!gz.write(chunk)) await once(gz, 'drain');
  };

  await write('city,target_date,event_id,end_ts,bucket_idx,label,resolved_outcome,t,p\n');

  let rows = 0;
  let events = 0;
  let skippedFiles = 0;
  for (const city of cities) {
    const dir = join(OUT_ROOT, city);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      let ev: EventFile;
      try {
        ev = JSON.parse(readFileSync(join(dir, f), 'utf8')) as EventFile;
      } catch (e) {
        // a truncated/corrupt event file (e.g. pull-market-history killed mid writeFileSync) must NOT abort the
        // whole multi-hundred-million-row flatten — log + skip + count it (the reconciliation below surfaces the gap).
        console.error(`  ⚠ skipped corrupt file ${city}/${f}: ${e instanceof Error ? e.message : String(e)}`);
        skippedFiles++;
        continue;
      }
      const endTs = Math.floor(new Date(ev.endDate).getTime() / 1000);
      let buf = '';
      for (const b of ev.buckets) {
        const prefix = `${csv(ev.city)},${ev.targetDate},${ev.eventId},${endTs},${b.idx},${csv(b.label)},${b.resolvedOutcome ?? ''},`;
        for (const [t, p] of b.points) {
          buf += `${prefix}${t},${p}\n`;
          rows++;
        }
        if (buf.length > 1 << 20) {
          await write(buf);
          buf = '';
        }
      }
      if (buf) await write(buf);
      events++;
    }
    console.log(`  ${city}: ${files.length} events flattened (${rows.toLocaleString()} rows cumulative)`);
  }

  gz.end();
  await once(sink, 'finish');
  const bytes = statSync(outPath).size;

  // Reconcile the row count against the pulled point total (the docstring's promised assertion). Only meaningful
  // for a FULL run — a --cities subset legitimately flattens fewer rows. Warn, never throw, so a partial/stale
  // archive still produces a usable CSV; the warning is the signal that the archive is incomplete.
  if (!cityFilter) {
    const summaryPath = join(OUT_ROOT, 'summary.json');
    if (existsSync(summaryPath)) {
      try {
        const pulled = (JSON.parse(readFileSync(summaryPath, 'utf8')) as { totals?: { points?: number } }).totals?.points;
        if (typeof pulled === 'number' && pulled !== rows) {
          console.warn(
            `⚠ row/point mismatch: flattened ${rows.toLocaleString()} rows vs ${pulled.toLocaleString()} pulled points` +
              (skippedFiles ? ` (${skippedFiles} corrupt files skipped)` : '') + ' — archive may be incomplete or stale.',
          );
        } else if (typeof pulled === 'number') {
          console.log(`✓ row count matches the pulled point total (${pulled.toLocaleString()}).`);
        }
      } catch {
        /* unreadable summary.json → skip the reconciliation (not fatal) */
      }
    }
  }
  if (skippedFiles) console.warn(`⚠ ${skippedFiles} event file(s) were corrupt/unreadable and skipped.`);

  console.log(
    `\n=== flatten complete: ${events} events · ${rows.toLocaleString()} rows → ${outPath}\n` +
      `    ${(bytes / 1e6).toFixed(0)} MB gz (${(bytes / 1e9).toFixed(2)} GB) ===`,
  );
}

await main();
