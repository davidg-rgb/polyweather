/**
 * scripts/research/amsterdam-peak-hour — "when does the daily max actually happen at Schiphol?"
 *
 * THE QUESTION (operator, 2026-06-17). The Amsterdam paper-trade sim evaluates/bets at 13/14/15/16
 * LOCAL. To pick the best evaluation time we need the empirical distribution of the *local hour at
 * which the daily max temperature is reached* — not a single eyeballed Wunderground day. This builds
 * that climatology from KNMI's free hourly record for Schiphol (station 240, var T, 1.5 m, 0.1°C),
 * the same station/provider as the floor "truth accuracy" feed (_shared/knmi.ts, migration 0043).
 *
 * METHOD. Pull hourly T per year (KNMI uurgegevens, hour 1..24 in UT). Each (date, hour) is an
 * observation at HH:00 UT → absolute UTC = date(00:00Z) + HH h. Convert to Europe/Amsterdam (DST-aware
 * via Intl) → local date + local hour. Group by LOCAL calendar day (the day the market resolves over),
 * take the max T and the local hour it first occurs. Then:
 *   - histogram of peak local hour (overall, warm season, core summer, and conditioned on a hot-day cut)
 *   - DECISION TABLE: for each local clock hour h, P(peak already reached by h) and the mean / p90
 *     of remaining warming after h — i.e. how much the day can still climb if you lock your call at h.
 * Peak hour is reported in BOTH local and UTC to settle the "~15:55" timezone ambiguity.
 *
 * RUN:  pnpm tsx scripts/research/amsterdam-peak-hour.ts [--from 2006] [--to 2025] [--csv]
 * No DB, no auth, no key — one POST per year to a free public endpoint.
 */
import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fetchJson } from '../../packages/io/src/index.ts';
import { emitClimatologyAsset } from './amsterdam-climatology-emit.ts';

const KNMI_UURGEGEVENS_URL = 'https://www.daggegevens.knmi.nl/klimatologie/uurgegevens';
const SCHIPHOL = 240;

interface RawHour {
  date?: string; // "2024-07-01T00:00:00.000Z" (UT calendar day)
  hour?: number; // 1..24, UT (HH = observation at HH:00 UT; 24 = 00:00 UT next day)
  T?: number | null; // temperature at 1.5 m, 0.1°C
}

interface Obs {
  localDate: string; // YYYY-MM-DD, Europe/Amsterdam
  localHour: number; // 0..23 local
  utcHour: number; // 0..23 UT
  tenths: number; // 0.1°C
}

interface DayPeak {
  localDate: string;
  month: number; // 1..12 (local)
  maxC: number;
  peakLocalHour: number;
  peakUtcHour: number;
  /** local hour -> tenths, for the "remaining warming after h" calc. */
  byLocalHour: Map<number, number>;
}

// DST-aware Europe/Amsterdam parts of an absolute instant.
const AMS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});
function toAms(utcMs: number): { date: string; hour: number } {
  const p = AMS.formatToParts(new Date(utcMs));
  const v = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  return { date: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')) };
}

async function fetchYear(year: number): Promise<Obs[]> {
  const body = `start=${year}010101&end=${year}123124&vars=T&stns=${SCHIPHOL}&fmt=json`;
  const payload = (await fetchJson(
    KNMI_UURGEGEVENS_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { timeoutMs: 60_000, retries: 3 },
  )) as RawHour[];
  if (!Array.isArray(payload)) return [];
  const out: Obs[] = [];
  for (const r of payload) {
    if (!r || typeof r.date !== 'string' || typeof r.hour !== 'number') continue;
    if (r.T == null || !Number.isFinite(r.T)) continue;
    const utcMs = Date.parse(r.date) + r.hour * 3_600_000;
    const ams = toAms(utcMs);
    out.push({
      localDate: ams.date,
      localHour: ams.hour,
      utcHour: r.hour % 24, // 24 -> 0
      tenths: r.T,
    });
  }
  return out;
}

function buildDayPeaks(obs: Obs[]): DayPeak[] {
  const byDay = new Map<string, Obs[]>();
  for (const o of obs) {
    const a = byDay.get(o.localDate);
    if (a) a.push(o);
    else byDay.set(o.localDate, [o]);
  }
  const peaks: DayPeak[] = [];
  for (const [localDate, rows] of byDay) {
    if (rows.length < 20) continue; // need near-complete local-day coverage
    let max = -Infinity;
    let peak: Obs | null = null;
    const byLocalHour = new Map<number, number>();
    for (const r of rows) {
      if (!byLocalHour.has(r.localHour)) byLocalHour.set(r.localHour, r.tenths);
      if (r.tenths > max) {
        max = r.tenths;
        peak = r;
      }
    }
    if (!peak) continue;
    peaks.push({
      localDate,
      month: Number(localDate.slice(5, 7)),
      maxC: max / 10,
      peakLocalHour: peak.localHour,
      peakUtcHour: peak.utcHour,
      byLocalHour,
    });
  }
  peaks.sort((a, b) => a.localDate.localeCompare(b.localDate));
  return peaks;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? NaN;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]) => pct(xs, 50);

function histogram(peaks: DayPeak[], key: (d: DayPeak) => number): Map<number, number> {
  const h = new Map<number, number>();
  for (const d of peaks) h.set(key(d), (h.get(key(d)) ?? 0) + 1);
  return h;
}

function printHist(title: string, peaks: DayPeak[], key: (d: DayPeak) => number, label: string): void {
  if (peaks.length === 0) {
    console.log(`\n${title}: (no days)`);
    return;
  }
  const h = histogram(peaks, key);
  const hours = [...h.keys()].sort((a, b) => a - b);
  const maxCount = Math.max(...h.values());
  const vals = peaks.map(key);
  console.log(`\n${title}  (n=${peaks.length}, median ${label} ${median(vals)}, IQR ${pct(vals, 25)}–${pct(vals, 75)})`);
  for (const hr of hours) {
    const c = h.get(hr) ?? 0;
    const share = ((c / peaks.length) * 100).toFixed(1).padStart(5);
    const bar = '█'.repeat(Math.round((c / maxCount) * 40));
    console.log(`  ${label} ${String(hr).padStart(2, '0')}  ${share}%  ${String(c).padStart(4)}  ${bar}`);
  }
}

/**
 * riskUpside(h) for a day = max(0, (max T at local hours > h) − (running max T at hours ≤ h)).
 * This is the ONLY decision-relevant quantity: having observed the running-max floor through hour h,
 * how much higher can the day's max still climb *after* you lock your call? Zero once the peak is past.
 */
function riskUpsideC(d: DayPeak, h: number): number | null {
  let runMax = -Infinity; // max over hours <= h
  let fwdMax = -Infinity; // max over hours  > h
  let sawH = false;
  for (const [hr, t] of d.byLocalHour) {
    if (hr <= h) {
      sawH = true;
      if (t > runMax) runMax = t;
    } else if (t > fwdMax) fwdMax = t;
  }
  if (!sawH) return null; // need an observation by hour h to have a floor at all
  if (fwdMax === -Infinity) return 0; // h at/after end of day
  return Math.max(0, (fwdMax - runMax) / 10);
}

function decisionTable(title: string, peaks: DayPeak[]): void {
  if (peaks.length === 0) return;
  console.log(`\n${title}  —  lock your call at LOCAL hour h, FUTURE upside still possible after h:`);
  console.log('  h(local)  peaked%   stillRising%   meanUpside  p90Upside  p99Upside   (n)');
  for (let h = 11; h <= 19; h++) {
    const peakedShare = (peaks.filter((d) => d.peakLocalHour <= h).length / peaks.length) * 100;
    const up: number[] = [];
    for (const d of peaks) {
      const r = riskUpsideC(d, h);
      if (r != null) up.push(r);
    }
    const rising = (up.filter((x) => x > 0).length / up.length) * 100;
    const star = h >= 13 && h <= 16 ? ' *' : '  ';
    console.log(
      `   ${String(h).padStart(2, '0')}${star}    ${peakedShare.toFixed(1).padStart(6)}%    ${rising.toFixed(1).padStart(6)}%       ` +
        `${mean(up).toFixed(2).padStart(7)}°C  ${pct(up, 90).toFixed(2).padStart(6)}°C  ${pct(up, 99).toFixed(2).padStart(6)}°C   (${up.length})`,
    );
  }
  console.log('  (* = sim 13/14/15/16-local windows. peaked% = max already reached by h. stillRising% = days that climb further after h.)');
  console.log('  (meanUpside/p90/p99 = how much MORE the running-max floor rises after h, °C — the bucket-break risk if you lock at h.)');
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      from: { type: 'string', default: '2006' },
      to: { type: 'string', default: '2025' },
      csv: { type: 'boolean', default: false },
      emit: { type: 'string' },
    },
  });
  const from = Number(values.from);
  const to = Number(values.to);

  console.error(`Fetching KNMI hourly T for Schiphol (240), ${from}–${to}…`);
  const allObs: Obs[] = [];
  for (let y = from; y <= to; y++) {
    const yr = await fetchYear(y);
    allObs.push(...yr);
    console.error(`  ${y}: ${yr.length} hourly obs`);
    await new Promise((r) => setTimeout(r, 250));
  }

  const peaks = buildDayPeaks(allObs);

  // --emit: regenerate the committed core climatology asset and exit (skip the human-facing report).
  if (values.emit) {
    const res = emitClimatologyAsset(peaks, { outPath: values.emit, fromYear: from, toYear: to });
    console.error(`Wrote climatology asset → ${values.emit} (${res.nDays} days, ${res.nMonths} months)`);
    return;
  }
  console.log('\n' + '='.repeat(78));
  console.log(`AMSTERDAM (Schiphol/EHAM, KNMI 240) — hour of daily max temperature, ${from}–${to}`);
  console.log(`${peaks.length} complete local days · ${allObs.length} hourly observations`);
  console.log('='.repeat(78));

  const warm = peaks.filter((d) => d.month >= 5 && d.month <= 9); // May–Sep
  const jja = peaks.filter((d) => d.month >= 6 && d.month <= 8); // core summer
  const hotJja = jja.filter((d) => d.maxC >= 25); // bucket boundaries genuinely in play
  const mildJja = jja.filter((d) => d.maxC >= 20);

  // Peak hour distributions (LOCAL), then UTC for the timezone reconciliation.
  printHist('PEAK HOUR — all year (LOCAL)', peaks, (d) => d.peakLocalHour, 'L');
  printHist('PEAK HOUR — warm season May–Sep (LOCAL)', warm, (d) => d.peakLocalHour, 'L');
  printHist('PEAK HOUR — core summer JJA (LOCAL)', jja, (d) => d.peakLocalHour, 'L');
  printHist('PEAK HOUR — JJA & max≥25°C / hot days (LOCAL)', hotJja, (d) => d.peakLocalHour, 'L');
  printHist('PEAK HOUR — core summer JJA (UTC, to reconcile WU/time-zone)', jja, (d) => d.peakUtcHour, 'Z');

  // Decision tables tied to the sim's evaluation windows.
  decisionTable('DECISION — core summer JJA (all days)', jja);
  decisionTable('DECISION — JJA & max≥20°C', mildJja);
  decisionTable('DECISION — JJA & max≥25°C (hot days, boundaries in play)', hotJja);

  // Monthly medians, compact.
  console.log('\nMEDIAN peak hour by month (LOCAL / UTC):');
  for (let m = 1; m <= 12; m++) {
    const md = peaks.filter((d) => d.month === m);
    if (md.length === 0) continue;
    const L = median(md.map((d) => d.peakLocalHour));
    const Z = median(md.map((d) => d.peakUtcHour));
    console.log(`  ${String(m).padStart(2, '0')}  local ${String(L).padStart(2, '0')}:00   utc ${String(Z).padStart(2, '0')}:00   (n=${md.length})`);
  }

  if (values.csv) {
    mkdirSync('scripts/research/out', { recursive: true });
    const path = 'scripts/research/out/amsterdam-peak-hour.csv';
    const lines = ['local_date,month,max_c,peak_local_hour,peak_utc_hour'];
    for (const d of peaks) {
      lines.push(`${d.localDate},${d.month},${d.maxC.toFixed(1)},${d.peakLocalHour},${d.peakUtcHour}`);
    }
    writeFileSync(path, lines.join('\n'));
    console.log(`\nWrote per-day peaks → ${path} (${peaks.length} rows)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
