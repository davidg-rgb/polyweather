/**
 * scripts/research/city-peak-hour — "when does the daily max actually happen?", for every city (the 45-city
 * ERA5 generalization of amsterdam-peak-hour.ts).
 *
 * THE QUESTION (FASTTRACK D5). The Amsterdam paper-trade sim proved a peak-hour floor-confidence climatology
 * useful (amsterdam-climatology.ts, built from KNMI Schiphol hourly). The multi-city paper-trade (/paper-trade,
 * migration 0070) now races entry arms across ~45 cities — each of which wants the SAME climatology: the
 * empirical distribution of the local hour at which the daily max is reached, and how much the running-max
 * floor can still climb after a given lock hour. KNMI only covers Schiphol, so this builds that climatology
 * for every city from the FREE Open-Meteo ERA5 archive (reanalysis 2 m temperature, no auth, no key).
 *
 * METHOD (mirrors amsterdam-peak-hour.ts). Pull hourly temperature_2m per city per year, requesting the data
 * ALREADY in the city's DST-aware IANA local time (Open-Meteo `timezone=<IANA>` returns local timestamps), so
 * each row is (localDate, localHour, °C) directly — no manual UTC→local conversion. Group by local calendar
 * day (the day the market resolves over), take the max and the local hour it is first reached, then compute
 * the per-lock-hour decision stats (P(peak already reached), P(remaining warming ≤ 0.5°C), mean forward
 * upside) with the EXACT shared math the Amsterdam asset uses (amsterdam-climatology-emit.ts).
 *
 * FETCH DISCIPLINE (free tier: no key). Chunked per (city, year); each chunk disk-cached under a gitignored
 * dir (scripts/.cache/era5/) so re-runs are cheap and a crash / rate-limit mid-pull loses NOTHING (resumable
 * by construction — a cached chunk is never re-fetched). Throttled between network calls; fetchJson already
 * retries 429/5xx with exponential backoff. A (city, year) that still fails after retries is logged + skipped,
 * and the city is emitted from whatever years DID succeed — partial coverage is reported honestly, never
 * fabricated. NO DB access of any kind.
 *
 * OUTPUTS
 *   --emit <path>   regenerate the committed compact asset packages/core/src/sim/city-climatology.ts and exit.
 *   --self-check    fetch EHAM (Amsterdam) over the KNMI asset's own 2006–2025 span, rebuild its per-month
 *                   climatology from ERA5, and report correlation + max-abs-diff vs the committed KNMI-derived
 *                   AMSTERDAM_CLIMATOLOGY (the pipeline-validation gate). Exits non-zero if agreement is below
 *                   the documented tolerance.
 *   (default)       print the per-city peak-hour distributions + decision tables (human-facing report).
 *
 * RUN:
 *   pnpm tsx scripts/research/city-peak-hour.ts --self-check
 *   pnpm tsx scripts/research/city-peak-hour.ts --emit packages/core/src/sim/city-climatology.ts [--from 2006 --to 2025]
 *   pnpm tsx scripts/research/city-peak-hour.ts [--cities singapore,karachi] [--from 2018 --to 2025]
 */
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchJson } from '../../packages/io/src/index.ts';
import { AMSTERDAM_CLIMATOLOGY } from '../../packages/core/src/index.ts';
import { DECISION_HOURS, decisionStats, peakHistogram, median, type DayPeakLike } from './amsterdam-climatology-emit.ts';
import { CITY_CATALOG, CITY_BY_SLUG, warmMonths, type CatalogCity } from './city-catalog.ts';
import { emitCityClimatologyAsset, type CityEmitInput } from './city-climatology-emit.ts';

export const SCRIPT = 'city-peak-hour';

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com';
/** Gitignored (`.gitignore`: `scripts/.cache/`) — the same cache root seed-stations.ts uses. Resumable. */
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'era5');
/** ms to wait after each NETWORK fetch (cache miss) — gentle on the free tier (cache hits never sleep). */
const THROTTLE_MS = 350;
/** The self-check compares against the KNMI asset over ITS span, to isolate the instrument difference. */
const SELF_CHECK_FROM = 2006;
const SELF_CHECK_TO = 2025;

/** The raw two-array payload we cache per (city, year). */
interface HourlyPayload {
  time: string[]; // local ISO "YYYY-MM-DDTHH:MM" (DST-aware, in the requested tz)
  temperature_2m: (number | null)[];
}

/** One hourly observation, already in city-local time. */
export interface HourObs {
  localDate: string; // YYYY-MM-DD
  localHour: number; // 0..23
  tenths: number; // 0.1°C (round of the °C value — matches DayPeakLike.byLocalHour's tenths contract)
}

// =====================================================================================
// PURE HELPERS (no network / no fs — the testable core)
// =====================================================================================

/** ERA5 archive hourly URL for one city-year, requesting data in the city's local tz (DST-aware). Pure. */
export function archiveHourlyUrl(city: Pick<CatalogCity, 'lat' | 'lon' | 'tz'>, year: number): string {
  const tz = encodeURIComponent(city.tz);
  return (
    `${ARCHIVE_BASE}/v1/archive?latitude=${city.lat}&longitude=${city.lon}` +
    `&hourly=temperature_2m&timezone=${tz}&start_date=${year}-01-01&end_date=${year}-12-31`
  );
}

/** Parse an Open-Meteo hourly payload → local hourly obs. Skips null/non-finite temps + malformed times. Pure. */
export function parseHourlyPayload(payload: HourlyPayload): HourObs[] {
  const { time, temperature_2m } = payload;
  if (!Array.isArray(time) || !Array.isArray(temperature_2m)) return [];
  const out: HourObs[] = [];
  const n = Math.min(time.length, temperature_2m.length);
  for (let i = 0; i < n; i++) {
    const t = time[i];
    const v = temperature_2m[i];
    if (typeof t !== 'string' || t.length < 13) continue;
    if (v == null || !Number.isFinite(v)) continue;
    const localHour = Number(t.slice(11, 13));
    if (!Number.isInteger(localHour) || localHour < 0 || localHour > 23) continue;
    out.push({ localDate: t.slice(0, 10), localHour, tenths: Math.round(v * 10) });
  }
  return out;
}

/**
 * Group local hourly obs into one DayPeakLike per local calendar day. Requires ≥ MIN_HOURS obs per day (near-
 * complete coverage — the same guard amsterdam-peak-hour.ts uses). byLocalHour keeps the FIRST reading seen at
 * each local hour (deterministic). Pure.
 */
export function buildDayPeaks(obs: HourObs[], minHours = 20): DayPeakLike[] {
  const byDay = new Map<string, HourObs[]>();
  for (const o of obs) {
    const a = byDay.get(o.localDate);
    if (a) a.push(o);
    else byDay.set(o.localDate, [o]);
  }
  const peaks: DayPeakLike[] = [];
  for (const [localDate, rows] of byDay) {
    if (rows.length < minHours) continue;
    let max = -Infinity;
    let peakHour = -1;
    const byLocalHour = new Map<number, number>();
    for (const r of rows) {
      if (!byLocalHour.has(r.localHour)) byLocalHour.set(r.localHour, r.tenths);
      if (r.tenths > max) {
        max = r.tenths;
        peakHour = r.localHour;
      }
    }
    if (peakHour < 0) continue;
    peaks.push({
      month: Number(localDate.slice(5, 7)),
      maxC: max / 10,
      peakLocalHour: peakHour,
      byLocalHour,
    });
  }
  peaks.sort((a, b) => (a.month - b.month));
  return peaks;
}

/** Pearson correlation of two equal-length vectors; NaN if degenerate. Pure. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return NaN;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i]! - ma;
    const xb = b[i]! - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return NaN;
  return num / Math.sqrt(da * db);
}

export interface SelfCheckResult {
  /** peakedPct across 12 months × DECISION_HOURS: ERA5 vs committed KNMI. */
  peakedCorr: number;
  peakedMaxAbsDiff: number;
  /** peakHourHistogram across 12 months × 24 hours. */
  histCorr: number;
  histMaxAbsDiff: number;
  /** |ERA5 median peak hour − KNMI median peak hour|, worst over the 12 months. */
  medianHourMaxDiff: number;
  nPeakedCells: number;
  nHistCells: number;
  pass: boolean;
}

/**
 * Documented self-check tolerance (ERA5 2 m reanalysis vs KNMI Schiphol point station, same 2006–2025 span).
 * The PRIMARY criterion is correlation: the peak-hour SHAPE must match (a tz/parse/day-grouping bug would
 * shift the peak hours and collapse the correlation). The max-abs-diff bounds the worst SINGLE month×hour
 * cell — set at 0.35 because a gridded reanalysis and a metre-scale station legitimately differ by up to
 * ~0.25–0.30 on a steep-CDF shoulder hour, even at correlation ≈ 0.98; the bound sits above that physical
 * band so a future ERA5 refresh can't spuriously FAIL on one shoulder cell while the SHAPE gates still bind
 * (review-lens advisory, 2026-07-04: correlation is the defect detector, the abs-diff is a backstop).
 * Achieved on the 2026-07-04 run: peakedCorr 0.981, peakedMaxAbsDiff 0.270, histCorr 0.892,
 * medianHourMaxDiff 1h — PASS.
 */
export const SELF_CHECK_TOLERANCE = {
  minPeakedCorr: 0.9,
  maxPeakedAbsDiff: 0.35,
  minHistCorr: 0.85,
  maxMedianHourDiff: 1,
} as const;

/**
 * Compare an ERA5-derived EHAM per-month climatology against the committed KNMI AMSTERDAM_CLIMATOLOGY. Pure:
 * takes the ERA5 day-peaks, recomputes the per-month peakedPct + histogram with the SHARED helpers, diffs the
 * aligned (month, hour) cells. This is the pipeline-validation gate — a wrong tz / parse / day-grouping bug
 * shifts the peak hours and tanks the correlation.
 */
export function selfCheckAgainstKnmi(era5EhamPeaks: DayPeakLike[]): SelfCheckResult {
  const era5Peaked: number[] = [];
  const knmiPeaked: number[] = [];
  const era5Hist: number[] = [];
  const knmiHist: number[] = [];
  let medianHourMaxDiff = 0;

  for (const km of AMSTERDAM_CLIMATOLOGY.months) {
    const monthPeaks = era5EhamPeaks.filter((d) => d.month === km.month);
    if (monthPeaks.length === 0) continue;
    const eStats = decisionStats(monthPeaks);
    const eHist = peakHistogram(monthPeaks);
    // peakedPct over the shared decision hours
    for (const h of DECISION_HOURS) {
      const e = eStats.find((s) => s.hour === h);
      const k = km.decisionByHour.find((s) => s.hour === h);
      if (e && k) {
        era5Peaked.push(e.peakedPct);
        knmiPeaked.push(k.peakedPct);
      }
    }
    // histogram over 24 local hours
    for (let h = 0; h < 24; h++) {
      era5Hist.push(eHist[h] ?? 0);
      knmiHist.push(km.peakHourHistogram[h] ?? 0);
    }
    medianHourMaxDiff = Math.max(medianHourMaxDiff, Math.abs(median(monthPeaks.map((d) => d.peakLocalHour)) - km.medianPeakHour));
  }

  const maxAbs = (a: number[], b: number[]): number => {
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    return m;
  };
  const peakedCorr = pearson(era5Peaked, knmiPeaked);
  const histCorr = pearson(era5Hist, knmiHist);
  const peakedMaxAbsDiff = maxAbs(era5Peaked, knmiPeaked);
  const histMaxAbsDiff = maxAbs(era5Hist, knmiHist);
  const pass =
    peakedCorr >= SELF_CHECK_TOLERANCE.minPeakedCorr &&
    peakedMaxAbsDiff <= SELF_CHECK_TOLERANCE.maxPeakedAbsDiff &&
    histCorr >= SELF_CHECK_TOLERANCE.minHistCorr &&
    medianHourMaxDiff <= SELF_CHECK_TOLERANCE.maxMedianHourDiff;

  return {
    peakedCorr,
    peakedMaxAbsDiff,
    histCorr,
    histMaxAbsDiff,
    medianHourMaxDiff,
    nPeakedCells: era5Peaked.length,
    nHistCells: era5Hist.length,
    pass,
  };
}

// =====================================================================================
// FETCH (network + disk cache — resumable, throttled)
// =====================================================================================

const cacheFileFor = (icao: string, year: number): string => join(CACHE_DIR, `${icao}_${year}.json`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch (or load from cache) one city-year of hourly temperature. Resumable: a cached chunk is returned
 * without a network call. Throttles only on a genuine network fetch. Throws on an empty/malformed payload so
 * a bad chunk is NOT cached.
 */
export async function fetchCityYear(city: CatalogCity, year: number, log: (m: string) => void): Promise<HourlyPayload> {
  const cachePath = cacheFileFor(city.icao, year);
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as HourlyPayload;
  }
  const url = archiveHourlyUrl(city, year);
  const json = (await fetchJson(url, undefined, { timeoutMs: 60_000, retries: 4, backoffMs: 1_500 })) as {
    hourly?: { time?: unknown; temperature_2m?: unknown };
  };
  const time = json?.hourly?.time;
  const temp = json?.hourly?.temperature_2m;
  if (!Array.isArray(time) || !Array.isArray(temp) || time.length === 0) {
    throw new Error(`empty ERA5 payload for ${city.icao} ${year}`);
  }
  const payload: HourlyPayload = { time: time as string[], temperature_2m: temp as (number | null)[] };
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(payload));
  log(`  fetched ${city.slug} (${city.icao}) ${year}: ${payload.time.length} hourly rows`);
  await sleep(THROTTLE_MS);
  return payload;
}

export interface CityCoverage {
  city: CatalogCity;
  peaks: DayPeakLike[];
  yearsOk: number[];
  yearsFailed: number[];
}

/** Pull one city across [from,to], accumulating day-peaks; a failed year is logged + skipped (resumable). */
export async function collectCity(
  city: CatalogCity,
  from: number,
  to: number,
  log: (m: string) => void,
): Promise<CityCoverage> {
  const allObs: HourObs[] = [];
  const yearsOk: number[] = [];
  const yearsFailed: number[] = [];
  for (let y = from; y <= to; y++) {
    try {
      const payload = await fetchCityYear(city, y, log);
      allObs.push(...parseHourlyPayload(payload));
      yearsOk.push(y);
    } catch (e) {
      yearsFailed.push(y);
      log(`  ! ${city.slug} ${y} failed: ${(e as Error).message}`);
    }
  }
  return { city, peaks: buildDayPeaks(allObs), yearsOk, yearsFailed };
}

// =====================================================================================
// REPORT
// =====================================================================================

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

function printCityReport(cov: CityCoverage, log: (m: string) => void): void {
  const { city, peaks } = cov;
  log(`\n${'='.repeat(78)}`);
  log(`${city.slug} (${city.icao}, ${city.tz})  ${city.lat},${city.lon}`);
  log(`  years ok: ${cov.yearsOk.join(',') || '(none)'}${cov.yearsFailed.length ? `  FAILED: ${cov.yearsFailed.join(',')}` : ''}`);
  if (peaks.length === 0) {
    log('  no complete days — skipped');
    return;
  }
  log(`  ${peaks.length} complete local days · median peak hour ${median(peaks.map((d) => d.peakLocalHour))}:00 local`);
  const stats = decisionStats(peaks);
  log('  h(local)  peaked%   ≤0.5°C-safe%   meanUpside°C   (n)');
  for (const s of stats) {
    log(
      `   ${String(s.hour).padStart(2, '0')}     ${pct(s.peakedPct).padStart(6)}      ${pct(s.leUpside05).padStart(6)}         ` +
        `${s.meanUpsideC.toFixed(2).padStart(5)}       (${s.n})`,
    );
  }
}

// =====================================================================================
// SELF-TEST (no DB/network — mirrors city-scan.ts's sanity() pattern)
// =====================================================================================

export function sanity(): void {
  // archiveHourlyUrl: encodes the tz + spans the whole year.
  const u = archiveHourlyUrl({ lat: 52.3, lon: 4.76, tz: 'Europe/Amsterdam' }, 2020);
  if (!u.includes('timezone=Europe%2FAmsterdam') || !u.includes('start_date=2020-01-01') || !u.includes('end_date=2020-12-31')) {
    throw new Error(`sanity: archiveHourlyUrl malformed — ${u}`);
  }

  // parseHourlyPayload: skips nulls + malformed, converts °C → tenths.
  const parsed = parseHourlyPayload({
    time: ['2020-07-01T00:00', '2020-07-01T14:00', 'bad', '2020-07-01T15:00'],
    temperature_2m: [16.1, 21.4, 9, null],
  });
  if (parsed.length !== 2) throw new Error(`sanity: parseHourlyPayload should keep 2 rows, got ${parsed.length}`);
  if (parsed[1]!.tenths !== 214 || parsed[1]!.localHour !== 14) throw new Error('sanity: parseHourlyPayload tenths/hour');

  // buildDayPeaks: a synthetic day peaking at 15:00 with a rising-then-falling trace.
  const obs: HourObs[] = [];
  for (let h = 0; h < 24; h++) {
    const c = h <= 15 ? 10 + h : 10 + (30 - h); // rises to 25°C @15:00, then falls
    obs.push({ localDate: '2020-07-01', localHour: h, tenths: c * 10 });
  }
  const peaks = buildDayPeaks(obs);
  if (peaks.length !== 1) throw new Error(`sanity: buildDayPeaks should yield 1 day, got ${peaks.length}`);
  if (peaks[0]!.peakLocalHour !== 15) throw new Error(`sanity: buildDayPeaks peak hour should be 15, got ${peaks[0]!.peakLocalHour}`);
  if (peaks[0]!.maxC !== 25) throw new Error(`sanity: buildDayPeaks maxC should be 25, got ${peaks[0]!.maxC}`);
  // a short day (< minHours) is dropped
  if (buildDayPeaks(obs.slice(0, 5)).length !== 0) throw new Error('sanity: buildDayPeaks must drop an incomplete day');

  // pearson: perfect + anti correlation.
  if (Math.abs(pearson([1, 2, 3], [2, 4, 6]) - 1) > 1e-9) throw new Error('sanity: pearson perfect');
  if (Math.abs(pearson([1, 2, 3], [3, 2, 1]) + 1) > 1e-9) throw new Error('sanity: pearson anti');

  // selfCheckAgainstKnmi: feeding the KNMI asset's own decision structure back as ERA5 must ~self-agree.
  // Build synthetic day-peaks whose per-month peak-hour matches KNMI's median → high correlation, small diff.
  const synth: DayPeakLike[] = [];
  for (const km of AMSTERDAM_CLIMATOLOGY.months) {
    for (let i = 0; i < 40; i++) {
      const byLocalHour = new Map<number, number>();
      for (let h = 0; h < 24; h++) byLocalHour.set(h, (h <= km.medianPeakHour ? 100 + h : 100 + (2 * km.medianPeakHour - h)) as number);
      synth.push({ month: km.month, maxC: (100 + km.medianPeakHour) / 10, peakLocalHour: km.medianPeakHour, byLocalHour });
    }
  }
  const sc = selfCheckAgainstKnmi(synth);
  if (!Number.isFinite(sc.peakedCorr) || sc.nPeakedCells === 0) throw new Error('sanity: selfCheckAgainstKnmi produced no cells');

  process.stderr.write('  sanity OK — url/parse/day-peaks/pearson/self-check helpers verified\n');
}

// =====================================================================================
// CLI
// =====================================================================================
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  const { values } = parseArgs({
    options: {
      from: { type: 'string', default: '2006' },
      to: { type: 'string', default: '2025' },
      emit: { type: 'string' },
      'self-check': { type: 'boolean', default: false },
      cities: { type: 'string' },
    },
  });
  const from = Number(values.from);
  const to = Number(values.to);
  const log = (m: string): void => console.error(m);

  // --self-check: fetch EHAM over the KNMI span, rebuild, diff, exit.
  if (values['self-check']) {
    const eham = CITY_BY_SLUG.get('amsterdam')!;
    log(`Self-check: fetching ERA5 EHAM ${SELF_CHECK_FROM}–${SELF_CHECK_TO} (KNMI asset span)…`);
    const cov = await collectCity(eham, SELF_CHECK_FROM, SELF_CHECK_TO, log);
    const res = selfCheckAgainstKnmi(cov.peaks);
    log(`\n${'='.repeat(78)}`);
    log('SELF-CHECK — ERA5 EHAM vs committed KNMI AMSTERDAM_CLIMATOLOGY (2006–2025)');
    log(`  ERA5 days: ${cov.peaks.length} (years ok ${cov.yearsOk.length}/${SELF_CHECK_TO - SELF_CHECK_FROM + 1})`);
    log(`  peakedPct (${res.nPeakedCells} month×hour cells): corr ${res.peakedCorr.toFixed(4)}  maxAbsDiff ${res.peakedMaxAbsDiff.toFixed(3)}`);
    log(`  peakHourHistogram (${res.nHistCells} cells):        corr ${res.histCorr.toFixed(4)}  maxAbsDiff ${res.histMaxAbsDiff.toFixed(3)}`);
    log(`  median peak hour: worst month |Δ| = ${res.medianHourMaxDiff}h`);
    log(
      `  tolerance: peakedCorr ≥ ${SELF_CHECK_TOLERANCE.minPeakedCorr}, peakedMaxAbsDiff ≤ ${SELF_CHECK_TOLERANCE.maxPeakedAbsDiff}, ` +
        `histCorr ≥ ${SELF_CHECK_TOLERANCE.minHistCorr}, medianHourΔ ≤ ${SELF_CHECK_TOLERANCE.maxMedianHourDiff}h`,
    );
    log(`  VERDICT: ${res.pass ? 'PASS' : 'FAIL'}`);
    console.log(JSON.stringify({ selfCheck: res, era5Days: cov.peaks.length }));
    if (!res.pass) process.exit(1);
    process.exit(0);
  }

  // Determine the city set (all, or a --cities subset).
  const selected: CatalogCity[] = values.cities
    ? values.cities.split(',').map((s) => s.trim()).filter(Boolean).map((slug) => {
        const c = CITY_BY_SLUG.get(slug);
        if (!c) throw new Error(`unknown city slug: ${slug}`);
        return c;
      })
    : CITY_CATALOG;

  log(`Fetching ERA5 hourly for ${selected.length} cit${selected.length === 1 ? 'y' : 'ies'}, ${from}–${to}…`);
  const coverages: CityCoverage[] = [];
  for (const city of selected) {
    const cov = await collectCity(city, from, to, log);
    coverages.push(cov);
    log(`  ✓ ${city.slug}: ${cov.peaks.length} days (${cov.yearsOk.length} yr ok, ${cov.yearsFailed.length} failed)`);
  }

  // --emit: build the compact committed asset from whatever cities have days; report partial coverage.
  if (values.emit) {
    const inputs: CityEmitInput[] = coverages
      .filter((c) => c.peaks.length > 0)
      .map((c) => ({
        slug: c.city.slug,
        icao: c.city.icao,
        name: c.city.name,
        lat: c.city.lat,
        lon: c.city.lon,
        tz: c.city.tz,
        fromYear: c.yearsOk.length ? Math.min(...c.yearsOk) : from,
        toYear: c.yearsOk.length ? Math.max(...c.yearsOk) : to,
        peaks: c.peaks,
        warmMonths: warmMonths(c.city.lat),
      }));
    const res = emitCityClimatologyAsset(inputs, values.emit);
    const missing = coverages.filter((c) => c.peaks.length === 0).map((c) => c.city.slug);
    log(`\nEmitted ${res.nCities}/${CITY_CATALOG.length} cities → ${values.emit} (${res.totalDays} total days).`);
    if (missing.length) log(`  NOT covered (no data fetched): ${missing.join(', ')}`);
    process.exit(0);
  }

  // default: human-facing per-city report.
  for (const cov of coverages) printCityReport(cov, log);
}
