/**
 * scripts/research/city-best-hour — the promoted, generalized twin of the Karachi entry-hour recon
 * (KARACHI-ENTRY-HOUR.md). For any city on the winners board, establish the best/least-bad live-taker
 * ENTRY HOUR by combining, per city-local hour:
 *   - our predictive ACCURACY (event-level l0 hit rate — CONSTANT across hours; the hour never changes
 *     whether we're right, only the price), read from the market-history + forecast MID set, AND
 *   - the REAL executable BUY PRICE of our bucket at that hour, read from the opening_captures bid/ask
 *     archive (our bucket = argmax houseProb = the bot's pick; price = bestAsk, the $-order top-of-book).
 * EV per $1 = accuracy / buy_price − 1 → buy at the cheapest hour we can actually FILL.
 *
 * ⚠ ACCURACY IS NOT CONSTANT BY HOUR FOR THE FLOOR STRATEGY (correction 2026-07-07). This script applies a
 * single flat l0 accuracy across all hours. That is right for a FIXED forecast bucket, but WRONG for the
 * strategy the paper sim + live city-taker lane actually run: they bet the running-max FLOOR, whose accuracy
 * climbs through the day as the day's high is observed (~36% at forecast-only early arms → ~96% once the floor
 * locks, cutover at city_sim_config.forecast_max_hour). So the flat-accuracy EV column below is INDICATIVE
 * ONLY and understates the late hours. The DECISION metric is the realized forward paper P&L by arm hour in
 * `city_paper_bets` (the actual test) — which shows the best hours are LATE (Karachi 13-14 / Houston 15 /
 * Singapore 15 / Ankara 16), not the cheap early hours a flat-accuracy read points to. What this script gets
 * RIGHT and is used for: the REAL executable ask / spread / depth / PURCHASABILITY by hour.
 *
 * Why two data sources (they barely overlap — see KARACHI-ENTRY-HOUR.md §sources):
 *   - accuracy needs (forecast ∩ resolved winner): market-history/{city}/*.json + forecast-by-event.csv
 *     (~47-49 events/city). MID only.
 *   - real ask needs the live book: opening-captures-archive (~10-11 recent events/city, full 24h, but
 *     NOT in the forecast CSV / market-history winner set). Bridge: accuracy is event-level & ~stationary,
 *     so take it from the 49-event set; take the price from the archive using argmax(houseProb) as "our
 *     bucket" (that IS what the live city-taker lane buys). houseProb ≈ the model's own confidence — a
 *     sanity check on the borrowed accuracy.
 *
 * The $-order buy price ≈ bestAsk: archive execAsk is the walk-the-book VWAP to fill probeStakeUsd=$20
 * (packages/core/src/edge.ts), a CONSERVATIVE upper bound for a $5-$10 order that fills the top and stops.
 *
 * Read-only, no DB, no capital. Run:
 *   pnpm tsx scripts/research/city-best-hour.ts                 # all 4 board cities
 *   pnpm tsx scripts/research/city-best-hour.ts karachi houston # a subset
 *   pnpm tsx scripts/research/city-best-hour.ts --stake 10      # fillable gate at $10 (paper stake)
 * Output: out/city-best-hour/{city}.md + out/city-best-hour/summary.md + console.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const ARCHIVE_DIR = join(OUT_DIR, 'opening-captures-archive');
const MH_DIR = join(OUT_DIR, 'market-history');
const FORECAST_CSV = join(OUT_DIR, 'forecast-by-event.csv');

/** The winners board (city_promotion_board) → IANA tz. tz drives the local-hour bucketing (DST-correct). */
export const BOARD_CITIES: Record<string, string> = {
  karachi: 'Asia/Karachi',
  houston: 'America/Chicago',
  singapore: 'Asia/Singapore',
  ankara: 'Europe/Istanbul',
};

// ── archive row shape (subset we read) ───────────────────────────────────────────────────────────
export interface ArchiveBucket {
  idx: number;
  mid: number | null;
  bestAsk: number | null;
  bestBid: number | null;
  execAsk: number | null;
  houseProb: number | null;
  depthUsd: number | null;
}
export interface ArchiveRow {
  city: string;
  event_id: string | null;
  captured_at: string;
  tz_name: string | null;
  buckets: ArchiveBucket[];
}

// ── market-history event-file shape (for accuracy) ───────────────────────────────────────────────
interface MhBucket {
  idx: number;
  resolvedOutcome: 'win' | 'lose' | null;
}
interface MhEvent {
  eventId: string | number;
  buckets: MhBucket[];
}

// ── Pure core (exported for tests) ───────────────────────────────────────────────────────────────

/**
 * Local hour (0..23) of an ISO instant in an IANA tz. DST-correct (America/Chicago in July → UTC−5).
 * Intl `hour12:false` can emit '24' at local midnight in some ICU builds → normalized to 0.
 */
export function localHourInTz(capturedAtIso: string, tzName: string): number {
  const d = new Date(capturedAtIso);
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tzName, hour: '2-digit', hour12: false }).format(d);
  const h = Number.parseInt(s, 10);
  return h === 24 ? 0 : h;
}

/** Our predicted bucket idx = argmax houseProb (the bot's seed); fallback argmax mid; null if neither. */
export function ourBucketIdx(buckets: ArchiveBucket[]): number | null {
  let best: ArchiveBucket | null = null;
  let key = -Infinity;
  for (const b of buckets) {
    if (b.houseProb !== null && b.houseProb > key) {
      key = b.houseProb;
      best = b;
    }
  }
  if (best) return best.idx;
  key = -Infinity;
  for (const b of buckets) {
    if (b.mid !== null && b.mid > key) {
      key = b.mid;
      best = b;
    }
  }
  return best ? best.idx : null;
}

/** EV per $1 staked buying our bucket at `price` and holding to a $1 binary payoff: accuracy/price − 1. */
export function evPerDollar(accuracy: number, price: number): number {
  return price > 0 ? accuracy / price - 1 : NaN;
}

/** Purchasability verdict from the fillable fraction and avg ask depth ($). */
export function purchasabilityVerdict(fillFrac: number, avgDepthUsd: number): 'YES (deep)' | 'yes' | 'thin' | 'NO' {
  if (fillFrac >= 0.7) return avgDepthUsd >= 200 ? 'YES (deep)' : 'yes';
  if (fillFrac >= 0.5) return 'thin';
  return 'NO';
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN);
export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.floor(s.length / 2);
  return s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2;
}

export interface HourAgg {
  hour: number;
  n: number;
  fillable: number;
  fillFrac: number;
  avgBestAsk: number;
  avgExecAsk: number;
  avgMid: number;
  avgHouseProb: number;
  avgSpread: number;
  medDepth: number;
  verdict: string;
}

/** One capture's read of our bucket (the fields the aggregation needs). */
export interface BucketRead {
  bestAsk: number | null;
  execAsk: number | null;
  bestBid: number | null;
  mid: number | null;
  houseProb: number | null;
  depthUsd: number;
}

/** Aggregate one hour's per-event bucket reads → averages + fillability + verdict. `stakeUsd` gates fillable. */
export function aggregateHour(hour: number, reads: BucketRead[], stakeUsd: number): HourAgg {
  const n = reads.length;
  const basks: number[] = [];
  const execs: number[] = [];
  const mids: number[] = [];
  const hps: number[] = [];
  const spreads: number[] = [];
  const depths: number[] = [];
  let fillable = 0;
  for (const r of reads) {
    if (r.execAsk !== null && r.execAsk > 0 && r.depthUsd >= stakeUsd) fillable++;
    if (r.bestAsk !== null && r.bestAsk > 0) basks.push(r.bestAsk);
    if (r.execAsk !== null && r.execAsk > 0) execs.push(r.execAsk);
    if (r.mid !== null && r.mid > 0) mids.push(r.mid);
    if (r.houseProb !== null) hps.push(r.houseProb);
    if (r.bestAsk !== null && r.bestBid !== null) spreads.push(r.bestAsk - r.bestBid);
    depths.push(r.depthUsd);
  }
  const fillFrac = n ? fillable / n : 0;
  const medDepth = median(depths);
  return {
    hour,
    n,
    fillable,
    fillFrac,
    avgBestAsk: mean(basks),
    avgExecAsk: mean(execs),
    avgMid: mean(mids),
    avgHouseProb: mean(hps),
    avgSpread: mean(spreads),
    medDepth: Number.isFinite(medDepth) ? medDepth : NaN,
    verdict: purchasabilityVerdict(fillFrac, Number.isFinite(medDepth) ? medDepth : 0),
  };
}

/** Parse forecast-by-event.csv rows for one city → eventId → pred_bucket_l0. */
export function parseForecastForCity(text: string, city: string): Map<string, number> {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? '').split(',');
  const iId = header.indexOf('event_id');
  const iCity = header.indexOf('fc_city');
  const iL0 = header.indexOf('pred_bucket_l0');
  const out = new Map<string, number>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c[iCity] !== city) continue;
    const id = c[iId];
    const raw = c[iL0];
    if (!id || raw === undefined || raw.trim() === '') continue; // empty pred → NOT bucket 0
    const l0 = Number(raw);
    if (Number.isFinite(l0)) out.set(id, l0);
  }
  return out;
}

/**
 * Event-level accuracy (l0 hit rate) for a city from the MID substrate: fraction of (forecast ∩ resolved)
 * events whose pred_bucket_l0 equals the winning bucket. Returns {accuracy, nEvents}. NaN if no join.
 */
export function forecastAccuracy(city: string, mhDir: string, forecastCsv: string): { accuracy: number; nEvents: number } {
  if (!existsSync(forecastCsv)) return { accuracy: NaN, nEvents: 0 };
  const fc = parseForecastForCity(readFileSync(forecastCsv, 'utf8'), city);
  const cityDir = join(mhDir, city);
  if (!existsSync(cityDir)) return { accuracy: NaN, nEvents: 0 };
  let wins = 0;
  let n = 0;
  for (const f of readdirSync(cityDir)) {
    if (!f.endsWith('.json')) continue;
    let ev: MhEvent;
    try {
      ev = JSON.parse(readFileSync(join(cityDir, f), 'utf8')) as MhEvent;
    } catch {
      continue;
    }
    const pred = fc.get(String(ev.eventId));
    if (pred === undefined) continue;
    const winB = ev.buckets.find((b) => b.resolvedOutcome === 'win');
    if (!winB) continue;
    n++;
    if (pred === winB.idx) wins++;
  }
  return { accuracy: n ? wins / n : NaN, nEvents: n };
}

// ── Archive streaming ────────────────────────────────────────────────────────────────────────────

/** Per (event, localHour) LAST capture's our-bucket read, grouped by city. Streams the gz shards once. */
export function loadArchiveReads(
  archiveDir: string,
  cities: Record<string, string>,
): Map<string, Map<string, BucketRead>> {
  const byCity = new Map<string, Map<string, BucketRead>>();
  for (const c of Object.keys(cities)) byCity.set(c, new Map());
  if (!existsSync(archiveDir)) return byCity;
  const shards = readdirSync(archiveDir)
    .filter((f) => /^part-\d+\.ndjson\.gz$/.test(f))
    .sort();
  for (const shard of shards) {
    const text = gunzipSync(readFileSync(join(archiveDir, shard))).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      // cheap pre-filter: only parse lines mentioning a wanted city
      let hit: string | null = null;
      for (const c of Object.keys(cities)) {
        if (line.includes(`"${c}"`)) {
          hit = c;
          break;
        }
      }
      if (!hit) continue;
      let row: ArchiveRow;
      try {
        row = JSON.parse(line) as ArchiveRow;
      } catch {
        continue;
      }
      const city = row.city;
      if (!(city in cities) || !row.event_id) continue;
      const idx = ourBucketIdx(row.buckets);
      if (idx === null) continue;
      const b = row.buckets.find((x) => x.idx === idx);
      if (!b) continue;
      const tz = row.tz_name ?? cities[city]!;
      const h = localHourInTz(row.captured_at, tz);
      const key = `${row.event_id}|${h}`;
      byCity.get(city)!.set(key, {
        bestAsk: b.bestAsk,
        execAsk: b.execAsk,
        bestBid: b.bestBid,
        mid: b.mid,
        houseProb: b.houseProb,
        depthUsd: b.depthUsd ?? 0,
      });
    }
  }
  return byCity;
}

// ── Per-city report ──────────────────────────────────────────────────────────────────────────────

export interface CityReport {
  city: string;
  tz: string;
  accuracy: number;
  accEvents: number;
  archiveEvents: number;
  hours: HourAgg[];
  bestHour: HourAgg | null; // best EV among purchasable (fillFrac ≥ 0.7) hours
}

const c = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}¢` : '—');
const ev = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(3)}` : '—');

export function buildCityReport(city: string, tz: string, reads: Map<string, BucketRead>, accuracy: number, accEvents: number, stakeUsd: number): CityReport {
  const events = new Set<string>();
  const byHour = new Map<number, BucketRead[]>();
  for (const [key, r] of reads) {
    const [eid, hStr] = key.split('|');
    events.add(eid!);
    const h = Number(hStr);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(r);
  }
  const hours: HourAgg[] = [];
  for (let h = 0; h < 24; h++) hours.push(aggregateHour(h, byHour.get(h) ?? [], stakeUsd));
  // best hour = max EV (acc/bestAsk−1) among purchasable hours (fillFrac ≥ 0.7 and a real bestAsk)
  let bestHour: HourAgg | null = null;
  let bestEv = -Infinity;
  for (const hr of hours) {
    if (hr.fillFrac < 0.7 || !Number.isFinite(hr.avgBestAsk)) continue;
    const e = evPerDollar(accuracy, hr.avgBestAsk);
    if (Number.isFinite(e) && e > bestEv) {
      bestEv = e;
      bestHour = hr;
    }
  }
  return { city, tz, accuracy, accEvents, archiveEvents: events.size, hours, bestHour };
}

function reportMd(r: CityReport, stakeUsd: number): string {
  const md: string[] = [];
  md.push(`## ${r.city} (${r.tz})`);
  md.push('');
  md.push(
    `- Accuracy (l0, event-level, ${r.accEvents}-event MID set): **${c(r.accuracy)}** · real-book events (archive): **${r.archiveEvents}** · fillable gate: depth ≥ $${stakeUsd}.`,
  );
  if (r.bestHour) {
    const utc = ((r.bestHour.hour - offsetHours(r.tz, r.bestHour.hour)) % 24 + 24) % 24;
    md.push(
      `- **Best/least-bad executable hour: ${String(r.bestHour.hour).padStart(2, '0')}:00 local (≈ ${String(utc).padStart(2, '0')}:00Z)** — ` +
        `bestAsk ${c(r.bestHour.avgBestAsk)}, EV ${ev(evPerDollar(r.accuracy, r.bestHour.avgBestAsk))}, fillable ${r.bestHour.fillable}/${r.bestHour.n}.`,
    );
  } else {
    md.push('- **No purchasable hour cleared the fillable gate.**');
  }
  md.push('');
  md.push('| local hr | nEv | fillable | bestAsk | execAsk($20) | mid | houseProb | spread | medDepth | EV=acc/ask−1 | purchasable |');
  md.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:--|');
  for (const h of r.hours) {
    if (h.n === 0) continue;
    md.push(
      `| ${String(h.hour).padStart(2, '0')}:00 | ${h.n} | ${h.fillable}/${h.n} | ${c(h.avgBestAsk)} | ${c(h.avgExecAsk)} | ${c(h.avgMid)} | ${c(h.avgHouseProb)} | ${c(h.avgSpread)} | $${Number.isFinite(h.medDepth) ? h.medDepth.toFixed(0) : '—'} | ${ev(evPerDollar(r.accuracy, h.avgBestAsk))} | ${h.verdict} |`,
    );
  }
  md.push('');
  return md.join('\n');
}

/** crude UTC offset (hours) for a tz at a given local hour on an arbitrary reference day — display only. */
function offsetHours(tz: string, _localHour: number): number {
  const ref = new Date('2026-07-07T12:00:00Z');
  const local = new Date(ref.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(ref.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local.getTime() - utc.getTime()) / 3600000);
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let stakeUsd = 10;
  const cityArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stake') {
      stakeUsd = Number(argv[++i]);
    } else {
      cityArgs.push(argv[i]!.toLowerCase());
    }
  }
  const cities: Record<string, string> = {};
  for (const city of cityArgs.length ? cityArgs : Object.keys(BOARD_CITIES)) {
    if (!(city in BOARD_CITIES)) {
      console.error(`  ⚠ unknown board city '${city}' — known: ${Object.keys(BOARD_CITIES).join(', ')}`);
      continue;
    }
    cities[city] = BOARD_CITIES[city]!;
  }
  if (!Object.keys(cities).length) throw new Error('no valid cities to analyse');

  console.log(`Loading real-book archive for ${Object.keys(cities).join(', ')} (fillable gate $${stakeUsd}) …`);
  const readsByCity = loadArchiveReads(ARCHIVE_DIR, cities);

  const outDir = join(OUT_DIR, 'city-best-hour');
  mkdirSync(outDir, { recursive: true });
  const reports: CityReport[] = [];
  for (const [city, tz] of Object.entries(cities)) {
    const { accuracy, nEvents } = forecastAccuracy(city, MH_DIR, FORECAST_CSV);
    const r = buildCityReport(city, tz, readsByCity.get(city) ?? new Map(), accuracy, nEvents, stakeUsd);
    reports.push(r);
    writeFileSync(join(outDir, `${city}.md`), `# ${city} — best entry hour (real book vs accuracy)\n\n${reportMd(r, stakeUsd)}`);
  }

  // summary
  const sm: string[] = [];
  sm.push('# City best-hour — winners board (real executable book vs event-level accuracy)');
  sm.push('');
  sm.push('_EV per $1 = accuracy / bestAsk − 1. bestAsk = the $-order top-of-book price; execAsk is the $20-probe upper bound._');
  sm.push('');
  sm.push('| city | tz | accuracy (l0) | best/least-bad hour | best bestAsk | best EV | purchasable window |');
  sm.push('|:--|:--|---:|:--|---:|---:|:--|');
  for (const r of reports) {
    const purch = r.hours.filter((h) => h.fillFrac >= 0.7 && h.n > 0).map((h) => h.hour);
    const win = purch.length ? `${String(Math.min(...purch)).padStart(2, '0')}–${String(Math.max(...purch)).padStart(2, '0')}h` : 'none';
    const bh = r.bestHour;
    sm.push(
      `| ${r.city} | ${r.tz} | ${c(r.accuracy)} (n=${r.accEvents}) | ${bh ? `${String(bh.hour).padStart(2, '0')}:00` : '—'} | ${bh ? c(bh.avgBestAsk) : '—'} | ${bh ? ev(evPerDollar(r.accuracy, bh.avgBestAsk)) : '—'} | ${win} |`,
    );
  }
  sm.push('');
  for (const r of reports) sm.push(reportMd(r, stakeUsd));
  const summaryPath = join(outDir, 'summary.md');
  writeFileSync(summaryPath, sm.join('\n') + '\n');

  // console
  for (const r of reports) {
    console.log(`\n=== ${r.city} (${r.tz}) · acc ${c(r.accuracy)} (n=${r.accEvents}) · archive ${r.archiveEvents} events ===`);
    if (r.bestHour) {
      console.log(`    BEST/least-bad hour ${String(r.bestHour.hour).padStart(2, '0')}:00 · bestAsk ${c(r.bestHour.avgBestAsk)} · EV ${ev(evPerDollar(r.accuracy, r.bestHour.avgBestAsk))} · fillable ${r.bestHour.fillable}/${r.bestHour.n}`);
    } else {
      console.log('    NO purchasable hour cleared the gate.');
    }
    console.log('    hr | n  | fill | bestAsk | execAsk | mid   | EV     | verdict');
    for (const h of r.hours) {
      if (h.n === 0) continue;
      console.log(
        `    ${String(h.hour).padStart(2, '0')} | ${String(h.n).padStart(2)} | ${String(h.fillable).padStart(1)}/${h.n} | ${c(h.avgBestAsk).padStart(6)} | ${c(h.avgExecAsk).padStart(6)} | ${c(h.avgMid).padStart(6)} | ${ev(evPerDollar(r.accuracy, h.avgBestAsk)).padStart(6)} | ${h.verdict}`,
      );
    }
  }
  console.log(`\n    summary → ${summaryPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
