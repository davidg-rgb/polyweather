/**
 * scripts/research/winner-band-prices — across the FULL local market-history archive (46 cities,
 * ~1-min implied-prob series, `resolvedOutcome` baked into every bucket), for every RESOLVED event
 * record the price behaviour of the WINNING bucket and its ±N index-neighbours — i.e. "the winning
 * temperature ± N degrees/buckets".
 *
 * For each (city, event, bucket-in-band) it logs, over the full market life: the LOWEST and HIGHEST
 * price seen, the range, first/last price, mean/std (fluctuation), n_points, and how many hours
 * before resolution the min and max occurred. A quick aggregate analysis (how cheap the eventual
 * winner gets, cheap-entry availability at <18¢/<30¢, fluctuation magnitude, per-city + per-offset
 * rollups, and WHEN in the market life the winner is cheapest) is printed and written to a note.
 *
 * NB: this series is ~1-min MID / implied-prob (the CLOB prices-history point), NOT bid/ask — the
 * real taker ask lives only in the 10-min `opening_captures` archive. So these are MARKET prices,
 * not the exact ask a taker pays; the cheap-entry numbers are a LOWER BOUND on real entry cost
 * (true ask ≥ mid). The recent ~10-day slice can be re-checked against opening-captures for spread.
 *
 * Read-only. Run: pnpm tsx scripts/research/winner-band-prices.ts               # all cities on disk
 *                pnpm tsx scripts/research/winner-band-prices.ts --cities karachi,singapore
 *                pnpm tsx scripts/research/winner-band-prices.ts --half 2 --out winner-band.csv
 * Output: out/winner-band-prices.csv  +  out/WINNER-BAND-ANALYSIS.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, 'out', 'market-history');
const OUT_DIR = join(HERE, 'out');

// ── Types (the pull-market-history event-file shape; same as flatten-market-history) ────────────
export interface Bucket {
  idx: number;
  label: string | null;
  resolvedOutcome: 'win' | 'lose' | null;
  points: Array<[number, number]>; // [epochSec, impliedProb/mid]
}
export interface EventFile {
  city: string;
  eventId: string;
  targetDate: string;
  endDate: string | null;
  buckets: Bucket[];
}

// ── Pure core (exported for tests) ──────────────────────────────────────────────────────────────

/** The idx of the winning bucket (resolvedOutcome==='win'), or null if the event is unresolved. */
export function winnerIdx(buckets: Bucket[]): number | null {
  const win = buckets.find((b) => b.resolvedOutcome === 'win');
  return win ? win.idx : null;
}

export interface PriceStats {
  n: number;
  minP: number;
  tAtMin: number;
  maxP: number;
  tAtMax: number;
  firstP: number;
  lastP: number;
  meanP: number;
  stdP: number;
}

/** min/max (with their timestamps), first/last, mean, population-std over a bucket's price points. */
export function priceStats(points: Array<[number, number]>): PriceStats | null {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  let minP = first[1];
  let maxP = first[1];
  let tAtMin = first[0];
  let tAtMax = first[0];
  let sum = 0;
  let sumSq = 0;
  for (const [t, p] of points) {
    if (p < minP) {
      minP = p;
      tAtMin = t;
    }
    if (p > maxP) {
      maxP = p;
      tAtMax = t;
    }
    sum += p;
    sumSq += p * p;
  }
  const n = points.length;
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { n, minP, tAtMin, maxP, tAtMax, firstP: first[1], lastP: last[1], meanP: mean, stdP: Math.sqrt(variance) };
}

export interface BandRow {
  offset: number; // -half..+half; 0 = the winning bucket
  bucketIdx: number;
  label: string | null;
  isWinner: boolean;
  stats: PriceStats | null; // null = the bucket has no traded points
}

/** The winning bucket + its ±half index-neighbours (only the buckets that actually exist). */
export function winnerBand(ev: EventFile, half: number): { winnerIdx: number; winnerLabel: string | null; rows: BandRow[] } | null {
  const wi = winnerIdx(ev.buckets);
  if (wi === null) return null;
  const byIdx = new Map(ev.buckets.map((b) => [b.idx, b]));
  const rows: BandRow[] = [];
  for (let off = -half; off <= half; off++) {
    const b = byIdx.get(wi + off);
    if (!b) continue; // edge bucket — the ±neighbour doesn't exist in this market
    rows.push({ offset: off, bucketIdx: b.idx, label: b.label, isWinner: off === 0, stats: priceStats(b.points) });
  }
  return { winnerIdx: wi, winnerLabel: byIdx.get(wi)?.label ?? null, rows };
}

// ── small stat helpers ──────────────────────────────────────────────────────────────────────────
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  const slo = s[lo] ?? NaN;
  const shi = s[hi] ?? NaN;
  return lo === hi ? slo : slo + (shi - slo) * (i - lo);
}
const median = (xs: number[]): number => quantile(xs, 0.5);
const fracOf = (xs: number[], pred: (x: number) => boolean): number => (xs.length ? xs.filter(pred).length / xs.length : NaN);
const pc = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const cents = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}¢` : '—');

const csv = (v: string | number | null): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── Runner ────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cities: { type: 'string' }, half: { type: 'string' }, out: { type: 'string' } } });
  if (!existsSync(OUT_ROOT)) throw new Error(`no archive at ${OUT_ROOT} — run pull-market-history first`);
  const half = values.half ? Math.max(0, Math.floor(Number(values.half))) : 2;
  const cityFilter = values.cities ? new Set(values.cities.split(',').map((c) => c.trim())) : null;
  const cities = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!cityFilter || cityFilter.has(d.name)))
    .map((d) => d.name)
    .sort();

  const csvHeader = [
    'city', 'target_date', 'event_id', 'end_ts', 'winner_idx', 'winner_label', 'offset', 'bucket_idx', 'label',
    'is_winner', 'n_points', 'min_p', 'min_hrs_to_resolve', 'max_p', 'max_hrs_to_resolve', 'first_p', 'last_p', 'mean_p', 'std_p', 'range_p',
  ].join(',');
  const lines: string[] = [csvHeader];

  // aggregates for the analysis
  const byOffset = new Map<number, { minP: number[]; maxP: number[]; range: number[]; std: number[]; hrsAtMin: number[] }>();
  const winnerByCity = new Map<string, number[]>(); // city → winner min_p per event
  let totalEvents = 0;
  let resolvedEvents = 0;
  let skippedFiles = 0;
  let emptyWinnerPointRows = 0;

  const bump = (off: number) => {
    if (!byOffset.has(off)) byOffset.set(off, { minP: [], maxP: [], range: [], std: [], hrsAtMin: [] });
    return byOffset.get(off)!;
  };

  for (const city of cities) {
    const dir = join(OUT_ROOT, city);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      totalEvents++;
      let ev: EventFile;
      try {
        ev = JSON.parse(readFileSync(join(dir, f), 'utf8')) as EventFile;
      } catch (e) {
        console.error(`  ⚠ skipped corrupt file ${city}/${f}: ${e instanceof Error ? e.message : String(e)}`);
        skippedFiles++;
        continue;
      }
      const band = winnerBand(ev, half);
      if (!band) continue; // unresolved event
      resolvedEvents++;
      const endTs = ev.endDate ? Math.floor(new Date(ev.endDate).getTime() / 1000) : null;
      const hrsTo = (t: number): number | null => (endTs === null ? null : Math.round(((endTs - t) / 3600) * 10) / 10);
      for (const r of band.rows) {
        const s = r.stats;
        const minHrs = s ? hrsTo(s.tAtMin) : null;
        const maxHrs = s ? hrsTo(s.tAtMax) : null;
        const range = s ? s.maxP - s.minP : null;
        lines.push(
          [
            csv(ev.city), csv(ev.targetDate), csv(ev.eventId), endTs ?? '', band.winnerIdx, csv(band.winnerLabel), r.offset, r.bucketIdx, csv(r.label),
            r.isWinner ? 1 : 0, s?.n ?? 0,
            s ? s.minP.toFixed(4) : '', minHrs ?? '', s ? s.maxP.toFixed(4) : '', maxHrs ?? '',
            s ? s.firstP.toFixed(4) : '', s ? s.lastP.toFixed(4) : '', s ? s.meanP.toFixed(4) : '', s ? s.stdP.toFixed(4) : '', range !== null ? range.toFixed(4) : '',
          ].join(','),
        );
        if (s) {
          const agg = bump(r.offset);
          agg.minP.push(s.minP);
          agg.maxP.push(s.maxP);
          agg.range.push(s.maxP - s.minP);
          agg.std.push(s.stdP);
          if (minHrs !== null) agg.hrsAtMin.push(minHrs);
        }
        if (r.isWinner) {
          if (!s) emptyWinnerPointRows++;
          else {
            if (!winnerByCity.has(ev.city)) winnerByCity.set(ev.city, []);
            winnerByCity.get(ev.city)!.push(s.minP);
          }
        }
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const csvPath = join(OUT_DIR, values.out ?? 'winner-band-prices.csv');
  writeFileSync(csvPath, lines.join('\n') + '\n');

  // ── analysis ──────────────────────────────────────────────────────────────────────────────────
  const offsets = [...byOffset.keys()].sort((a, b) => a - b);
  const offRows = offsets.map((off) => {
    const a = byOffset.get(off)!;
    return {
      off,
      n: a.minP.length,
      medMin: median(a.minP),
      p10Min: quantile(a.minP, 0.1),
      medMax: median(a.maxP),
      medRange: median(a.range),
      medStd: median(a.std),
      pctSub18: fracOf(a.minP, (x) => x < 0.18),
      pctSub30: fracOf(a.minP, (x) => x < 0.3),
      medHrsAtMin: median(a.hrsAtMin),
    };
  });

  const win = byOffset.get(0) ?? { minP: [], maxP: [], range: [], std: [], hrsAtMin: [] };
  const cityRows = [...winnerByCity.entries()]
    .map(([c, mins]) => ({ city: c, n: mins.length, medMin: median(mins), pctSub18: fracOf(mins, (x) => x < 0.18), pctSub30: fracOf(mins, (x) => x < 0.3) }))
    .sort((x, y) => x.medMin - y.medMin);

  const md: string[] = [];
  md.push('# Winner-band price analysis — 46-city market-history');
  md.push('');
  md.push(`_Generated over the local \`market-history\` archive (~1-min implied-prob/mid series, NOT bid/ask). Band = winning bucket ± ${half} index-neighbours ("winning temperature ± ${half}°"). Prices are mid → a LOWER BOUND on real taker ask._`);
  md.push('');
  md.push(`- Cities: **${cities.length}**${cityFilter ? ' (filtered)' : ''} · Event files scanned: **${totalEvents.toLocaleString()}** · Resolved (had a winner): **${resolvedEvents.toLocaleString()}** · Corrupt skipped: ${skippedFiles} · Winner buckets with zero traded points: ${emptyWinnerPointRows}`);
  md.push('');
  md.push('## Headline — the eventual WINNER (offset 0)');
  md.push('');
  md.push(`- **How cheap the winner gets** (min price over its life): median **${cents(median(win.minP))}**, p10 **${cents(quantile(win.minP, 0.1))}**, p90 **${cents(quantile(win.minP, 0.9))}**.`);
  md.push(`- **Cheap-entry availability:** the eventual winner traded **< 18¢ at some point in ${pc(fracOf(win.minP, (x) => x < 0.18))}** of events, **< 30¢ in ${pc(fracOf(win.minP, (x) => x < 0.3))}**, **< 50¢ in ${pc(fracOf(win.minP, (x) => x < 0.5))}**.`);
  md.push(`- **How high it climbs:** median intraday high **${cents(median(win.maxP))}** (a winner ultimately resolves toward 100¢).`);
  md.push(`- **When it is cheapest:** median **${Number.isFinite(median(win.hrsAtMin)) ? median(win.hrsAtMin).toFixed(1) : '—'} h before resolution** (higher = earlier in the market's life).`);
  md.push(`- **Fluctuation on the winner:** median intraday range **${cents(median(win.range))}**, median price σ **${cents(median(win.std))}**.`);
  md.push('');
  md.push('## By offset from the winning temperature');
  md.push('');
  md.push('| offset | n | median min | p10 min | median max | median range | median σ | % ever <18¢ | % ever <30¢ | med h-to-resolve @min |');
  md.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of offRows) {
    md.push(
      `| ${r.off >= 0 ? '+' + r.off : r.off} | ${r.n} | ${cents(r.medMin)} | ${cents(r.p10Min)} | ${cents(r.medMax)} | ${cents(r.medRange)} | ${cents(r.medStd)} | ${pc(r.pctSub18)} | ${pc(r.pctSub30)} | ${Number.isFinite(r.medHrsAtMin) ? r.medHrsAtMin.toFixed(1) : '—'} |`,
    );
  }
  md.push('');
  md.push('## By city — cheapest winner entries (sorted by median winner min price)');
  md.push('');
  md.push('| city | resolved events | median winner min | % winner <18¢ | % winner <30¢ |');
  md.push('|:--|---:|---:|---:|---:|');
  for (const r of cityRows) md.push(`| ${r.city} | ${r.n} | ${cents(r.medMin)} | ${pc(r.pctSub18)} | ${pc(r.pctSub30)} |`);
  md.push('');
  md.push('> Interpretation: a low "median winner min" + high "% winner <18¢" means the correct answer is frequently buyable cheap intraday — the raw precondition for the buy-low/hold-to-$1 thesis (Test 2\'s `<18¢` rule). It says nothing yet about whether *we can predict* which bucket wins — that\'s the forecast-conditional Test 1.');

  const mdPath = join(OUT_DIR, 'WINNER-BAND-ANALYSIS.md');
  writeFileSync(mdPath, md.join('\n') + '\n');

  console.log(`\n=== winner-band complete: ${resolvedEvents.toLocaleString()}/${totalEvents.toLocaleString()} resolved events · ${(lines.length - 1).toLocaleString()} band rows ===`);
  console.log(`    winner median min ${cents(median(win.minP))} · winner traded <18¢ in ${pc(fracOf(win.minP, (x) => x < 0.18))} of events · median intraday high ${cents(median(win.maxP))}`);
  console.log(`    CSV → ${csvPath}`);
  console.log(`    Analysis → ${mdPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
