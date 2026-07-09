/**
 * scripts/research/nonprice-fingerprint-panel — the NON-PRICE WINNER-FINGERPRINT feature panel.
 *
 * The operator's open direction (from C20/C21): is there a tradeable edge in a NON-PRICE fingerprint —
 * momentum / hold-time / path-shape — rather than the price level, which we've proven is calibrated
 * (C19) and un-scalpable (C21)? The rigorous framing is the SUFFICIENT-STATISTIC test: at any instant
 * the market MID is its own win-probability estimate; a feature only carries an edge if
 * `E[won | price, feature] ≠ E[won | price]`. This script builds the instant-level panel — at sampled
 * instants along every bucket's price path it records the current price, the eventual outcome, and a
 * catalog of non-price path features — for the conditional-calibration test (done in Python).
 *
 * Over the full local `market-history` archive (46 cities, ~1-min MID/implied-prob series,
 * `resolvedOutcome` baked in). MID only (no bid/ask — the order-flow fingerprint is a separate test on
 * `opening_captures`). Read-only; writes only out/.
 *
 * Run: pnpm tsx scripts/research/nonprice-fingerprint-panel.ts
 *      pnpm tsx scripts/research/nonprice-fingerprint-panel.ts --cities nyc,london --gridH 3
 * Output: out/nonprice-fingerprint-panel.csv
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type Bucket, type EventFile, winnerIdx } from './winner-band-prices.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, 'out', 'market-history');
const OUT_DIR = join(HERE, 'out');

const OSC_TH = 0.05; // a "swing" = a ≥5¢ reversal
const BAND_LO = 0.02; // only sample instants where the bucket is in the tradable band
const BAND_HI = 0.95;
const MIN_POINTS = 4; // need a little history before features are meaningful

/** Last index i with times[i] ≤ t (binary search); -1 if t precedes the first point. */
export function priceAtIdx(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export interface Prefix {
  runMax: number[];
  runMin: number[];
  tAtMax: number[];
  osc: number[];
  sum: number[];
  sumSq: number[];
}
/** Forward prefix stats over a bucket's price series: running max/min (+ time of max), zig-zag swing
 *  count (≥OSC_TH reversals), and cumulative sum/sumSq for running vol. All O(n). */
export function buildPrefix(times: number[], prices: number[]): Prefix {
  const n = prices.length;
  const runMax = new Array<number>(n);
  const runMin = new Array<number>(n);
  const tAtMax = new Array<number>(n);
  const osc = new Array<number>(n);
  const sum = new Array<number>(n);
  const sumSq = new Array<number>(n);
  let mx = prices[0]!;
  let mn = prices[0]!;
  let tmx = times[0]!;
  let s = prices[0]!;
  let sq = prices[0]! * prices[0]!;
  runMax[0] = mx;
  runMin[0] = mn;
  tAtMax[0] = tmx;
  osc[0] = 0;
  sum[0] = s;
  sumSq[0] = sq;
  // zig-zag state
  let dir = 0;
  let ext = prices[0]!;
  let candHigh = prices[0]!;
  let candLow = prices[0]!;
  let oscCount = 0;
  for (let k = 1; k < n; k++) {
    const p = prices[k]!;
    if (p > mx) {
      mx = p;
      tmx = times[k]!;
    }
    if (p < mn) mn = p;
    runMax[k] = mx;
    runMin[k] = mn;
    tAtMax[k] = tmx;
    s += p;
    sq += p * p;
    sum[k] = s;
    sumSq[k] = sq;
    if (dir === 0) {
      candHigh = Math.max(candHigh, p);
      candLow = Math.min(candLow, p);
      if (p >= candLow + OSC_TH) {
        dir = 1;
        ext = p;
      } else if (p <= candHigh - OSC_TH) {
        dir = -1;
        ext = p;
      }
    } else if (dir === 1) {
      if (p > ext) ext = p;
      else if (p <= ext - OSC_TH) {
        oscCount++;
        dir = -1;
        ext = p;
      }
    } else {
      if (p < ext) ext = p;
      else if (p >= ext + OSC_TH) {
        oscCount++;
        dir = 1;
        ext = p;
      }
    }
    osc[k] = oscCount;
  }
  return { runMax, runMin, tAtMax, osc, sum, sumSq };
}

export interface FeatureRow {
  fracLife: number;
  p: number;
  mom1h: number | null;
  mom3h: number | null;
  mom6h: number | null;
  accel: number | null; // 2nd difference over 1h
  drawdown: number; // runMax − p (≥0)
  runup: number; // p − runMin (≥0)
  hrsSincePeak: number;
  oscCount: number;
  volSoFar: number;
  dwellFrac: number; // frac of last 3h within ±2¢ of p
}

/** Features at sampled index k of a bucket path. Null momentum when the lookback predates the series. */
export function featuresAt(times: number[], prices: number[], pre: Prefix, k: number): FeatureRow {
  const tk = times[k]!;
  const pk = prices[k]!;
  const t0 = times[0]!;
  const tEnd = times[times.length - 1]!;
  const span = tEnd - t0;
  const look = (dtSec: number): number | null => {
    const idx = priceAtIdx(times, tk - dtSec);
    return idx < 0 ? null : prices[idx]!;
  };
  const p1 = look(3600);
  const p3 = look(3 * 3600);
  const p6 = look(6 * 3600);
  const p2 = look(2 * 3600);
  const mom1h = p1 === null ? null : pk - p1;
  const mom3h = p3 === null ? null : pk - p3;
  const mom6h = p6 === null ? null : pk - p6;
  const accel = p1 === null || p2 === null ? null : pk - 2 * p1 + p2;
  const n = k + 1;
  const mean = pre.sum[k]! / n;
  const varr = Math.max(0, pre.sumSq[k]! / n - mean * mean);
  // dwell: fraction of points in the last 3h window within ±2¢ of pk
  const wStart = priceAtIdx(times, tk - 3 * 3600);
  let inWin = 0;
  let near = 0;
  for (let j = Math.max(0, wStart); j <= k; j++) {
    inWin++;
    if (Math.abs(prices[j]! - pk) <= 0.02) near++;
  }
  return {
    fracLife: span > 0 ? (tk - t0) / span : 0,
    p: pk,
    mom1h,
    mom3h,
    mom6h,
    accel,
    drawdown: pre.runMax[k]! - pk,
    runup: pk - pre.runMin[k]!,
    hrsSincePeak: (tk - pre.tAtMax[k]!) / 3600,
    oscCount: pre.osc[k]!,
    volSoFar: Math.sqrt(varr),
    dwellFrac: inWin > 0 ? near / inWin : 0,
  };
}

const csv = (v: string | number | null): string => {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const f4 = (x: number | null): string => (x === null || !Number.isFinite(x) ? '' : x.toFixed(4));

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { cities: { type: 'string' }, gridH: { type: 'string' } } });
  if (!existsSync(OUT_ROOT)) throw new Error(`no archive at ${OUT_ROOT} — run pull-market-history first`);
  const gridSec = (values.gridH ? Number(values.gridH) : 3) * 3600;
  const cityFilter = values.cities ? new Set(values.cities.split(',').map((s) => s.trim())) : null;
  const cities = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!cityFilter || cityFilter.has(d.name)))
    .map((d) => d.name)
    .sort();

  const header = [
    'city', 'target_date', 'event_id', 'bucket_idx', 'offset', 'won',
    'frac_life', 'p', 'mom1h', 'mom3h', 'mom6h', 'accel', 'drawdown', 'runup', 'hrs_since_peak', 'osc_count', 'vol_so_far', 'dwell_frac',
  ].join(',');
  const lines: string[] = [header];

  let events = 0;
  let resolved = 0;
  let rows = 0;
  for (const city of cities) {
    const dir = join(OUT_ROOT, city);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      events++;
      let ev: EventFile;
      try {
        ev = JSON.parse(readFileSync(join(dir, f), 'utf8')) as EventFile;
      } catch {
        continue;
      }
      const wi = winnerIdx(ev.buckets);
      if (wi === null) continue;
      resolved++;
      for (const b of ev.buckets as Bucket[]) {
        if (!b.points || b.points.length < MIN_POINTS) continue;
        const times = b.points.map((pt) => pt[0]);
        const prices = b.points.map((pt) => pt[1]);
        const pre = buildPrefix(times, prices);
        const won = b.resolvedOutcome === 'win' ? 1 : 0;
        const off = b.idx - wi;
        // sample on a fixed grid of market-LIFE time (t0 + gridSec, +2·gridSec, …)
        const t0 = times[0]!;
        const tEnd = times[times.length - 1]!;
        for (let g = t0 + gridSec; g <= tEnd; g += gridSec) {
          const k = priceAtIdx(times, g);
          if (k < MIN_POINTS - 1) continue;
          const pk = prices[k]!;
          if (pk < BAND_LO || pk > BAND_HI) continue;
          const ft = featuresAt(times, prices, pre, k);
          lines.push(
            [
              csv(ev.city), csv(ev.targetDate), csv(ev.eventId), b.idx, off, won,
              ft.fracLife.toFixed(4), f4(ft.p), f4(ft.mom1h), f4(ft.mom3h), f4(ft.mom6h), f4(ft.accel),
              f4(ft.drawdown), f4(ft.runup), ft.hrsSincePeak.toFixed(2), ft.oscCount, f4(ft.volSoFar), ft.dwellFrac.toFixed(4),
            ].join(','),
          );
          rows++;
        }
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'nonprice-fingerprint-panel.csv');
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\n=== non-price fingerprint panel: ${resolved.toLocaleString()}/${events.toLocaleString()} resolved · ${rows.toLocaleString()} instant rows (grid ${gridSec / 3600}h) ===`);
  console.log(`    panel → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
