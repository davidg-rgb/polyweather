/**
 * scripts/research/city-floor-climatology — "when is the day DECIDED?", for every city, from the
 * RESOLUTION STREAM itself (CITY-ORACLE-BUILDOUT Build 1).
 *
 * THE QUESTION. Polymarket temp markets resolve on WU's Daily Observations table — a bit-for-bit
 * re-render of the METAR/SPECI stream (docs/DATA-SOURCES.md §resolution-oracle, validated 66/66).
 * So the market-relevant "when is the daily max locked in" is an INTEGER question about that exact
 * stream: at which local hour does the WU-rendered running max reach the day's final rendered value?
 * This generalizes the Amsterdam peak-hour model (AMSTERDAM-SIM.md §6) to all 45 cities × 12 months,
 * computed on the IEM METAR archive (out/iem-asos-archive/, scripts/research/iem-backfill.py) — the
 * same rows, rendering (wuRound, native unit) and station-local-day bucketing the validated oracle
 * replica uses (metar-kill-replay.py).
 *
 * vs the ERA5 asset (city-climatology.ts): ERA5 is a ~20-year smooth climate normal in °C space
 * (display on /paper-trade). THIS asset is 2021+ resolution-grade, rendered-integer space, per month —
 * the "floor confidence curve" a market analyst actually wants. They coexist deliberately.
 *
 * OUTPUTS
 *   --emit <path>   regenerate the committed asset packages/core/src/sim/city-floor-climatology.ts, exit.
 *   (default)       human-facing per-city report (add --cities slug,slug for per-month detail).
 *
 * RUN (extend the archive first: python scripts/research/iem-backfill.py --start 2021-01-01 --end <today>):
 *   pnpm tsx scripts/research/city-floor-climatology.ts --emit packages/core/src/sim/city-floor-climatology.ts
 *   pnpm tsx scripts/research/city-floor-climatology.ts --cities singapore,denver
 *
 * No DB, no network — reads the local gitignored archive only.
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wuRound } from '../../packages/core/src/units.ts';
import { CITY_BY_SLUG } from './city-catalog.ts';
import {
  buildCityFloorClimatology,
  decidedHour,
  emitCityFloorClimatologyAsset,
  type CityFloorEmitInput,
  type DayRenderedSeries,
} from './city-floor-climatology-emit.ts';

export const SCRIPT = 'city-floor-climatology';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVE_DIR = join(HERE, 'out', 'iem-asos-archive');
const CITY_MAP_PATH = join(HERE, 'city-map.json');

/**
 * A local day must have at least this many DISTINCT local hours with a rendered row to count as
 * complete. 12 mirrors the metar-kill-replay completeness bar; stations that legitimately stop
 * reporting overnight still pass (their floor genuinely cannot move in unreported hours — the
 * resolution table only contains reported rows).
 */
export const MIN_HOURS_PER_DAY = 12;

type CityMapRow = [icao: string, tz: string, unit: 'C' | 'F', cc: string, usState: string | null];

// =====================================================================================
// PURE HELPERS (no fs — the testable core)
// =====================================================================================

/** WU-table integer for one archive row in the city's native unit (§resolution-oracle rounding). */
export function renderRow(tmpf: number | null, tmpc: number | null, unit: 'C' | 'F'): number | null {
  if (unit === 'F') return tmpf !== null ? wuRound(tmpf) : null;
  if (tmpc !== null) return wuRound(tmpc);
  return tmpf !== null ? wuRound(((tmpf - 32) * 5) / 9) : null;
}

/** Parse an archive UTC timestamp "YYYY-MM-DD HH:MM" → epoch ms (fast slice parse, no Date.parse). */
export function parseUtcMs(valid: string): number {
  return Date.UTC(
    Number(valid.slice(0, 4)),
    Number(valid.slice(5, 7)) - 1,
    Number(valid.slice(8, 10)),
    Number(valid.slice(11, 13)),
    Number(valid.slice(14, 16)),
  );
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/**
 * tz-offset memo per (tz, UTC hour): every IANA transition in the 45-city universe lands on a whole
 * UTC hour (fractional-offset zones in the set — Asia/Kolkata — have no DST), so the offset is
 * constant within one UTC hour and one Intl call per (tz, hour) covers every row in it.
 */
const offsetCache = new Map<string, number>();

/** Station-local calendar date + hour of a UTC instant (DST-aware via Intl, memoized per UTC hour). */
export function localParts(tz: string, utcMs: number): { date: string; hour: number } {
  const key = `${tz}|${Math.floor(utcMs / 3_600_000)}`;
  let off = offsetCache.get(key);
  if (off === undefined) {
    const p = fmtFor(tz).formatToParts(new Date(utcMs));
    const v = (t: string): number => Number(p.find((x) => x.type === t)?.value ?? NaN);
    off = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute')) - utcMs;
    offsetCache.set(key, off);
  }
  const local = new Date(utcMs + off);
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() };
}

export interface StationDays {
  days: DayRenderedSeries[];
  /** calendar year (local) → complete-day count, the honest coverage record. */
  daysByYear: Map<string, number>;
  fromYear: number;
  toYear: number;
}

/**
 * Fold rendered archive rows into complete station-local days. Pure over its inputs: rows are
 * [validUtc, tmpf, tmpc] triples as stored by iem-backfill.py.
 */
export function buildStationDays(
  rows: Array<[string, number | null, number | null]>,
  tz: string,
  unit: 'C' | 'F',
): StationDays {
  const byDay = new Map<string, Map<number, number>>();
  for (const [valid, tmpf, tmpc] of rows) {
    const rendered = renderRow(tmpf, tmpc, unit);
    if (rendered === null) continue;
    const { date, hour } = localParts(tz, parseUtcMs(valid));
    let hours = byDay.get(date);
    if (!hours) {
      hours = new Map();
      byDay.set(date, hours);
    }
    const prev = hours.get(hour);
    if (prev === undefined || rendered > prev) hours.set(hour, rendered);
  }
  const days: DayRenderedSeries[] = [];
  const daysByYear = new Map<string, number>();
  for (const [date, byLocalHour] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (byLocalHour.size < MIN_HOURS_PER_DAY) continue;
    days.push({ month: Number(date.slice(5, 7)), byLocalHour, date });
    const y = date.slice(0, 4);
    daysByYear.set(y, (daysByYear.get(y) ?? 0) + 1);
  }
  // Coverage span counts only years with ≥30 complete days — the backfill's ±1-day UTC pad would
  // otherwise report a lone boundary day (e.g. 2020-12-31) as a covered calendar year.
  const substantive = [...daysByYear.entries()].filter(([, n]) => n >= 30).map(([y]) => Number(y));
  const allYears = [...daysByYear.keys()].map(Number);
  const span = substantive.length > 0 ? substantive : allYears;
  return {
    days,
    daysByYear,
    fromYear: span.length ? Math.min(...span) : 0,
    toYear: span.length ? Math.max(...span) : 0,
  };
}

// =====================================================================================
// ARCHIVE LOADING
// =====================================================================================

export function loadArchiveRows(icao: string): Array<[string, number | null, number | null]> {
  const path = join(ARCHIVE_DIR, `${icao}.ndjson`);
  if (!existsSync(path)) return [];
  const out: Array<[string, number | null, number | null]> = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as [string, number | null, number | null];
      if (typeof r[0] === 'string' && r[0].length >= 16) out.push(r);
    } catch {
      /* a torn line in a partial archive write is skipped, never fatal */
    }
  }
  return out;
}

interface LoadedCity {
  slug: string;
  icao: string;
  name: string;
  tz: string;
  unit: 'C' | 'F';
  station: StationDays;
}

function loadAllCities(slugFilter: Set<string> | null, log: (m: string) => void): LoadedCity[] {
  const cityMap = (
    JSON.parse(readFileSync(CITY_MAP_PATH, 'utf8')) as { cities: Record<string, CityMapRow> }
  ).cities;
  const loaded: LoadedCity[] = [];
  for (const [slug, [icao, tz, unit]] of Object.entries(cityMap).sort()) {
    if (slugFilter && !slugFilter.has(slug)) continue;
    const rows = loadArchiveRows(icao);
    if (rows.length === 0) {
      log(`  ! ${slug} (${icao}): no archive file / rows — skipped (run iem-backfill.py)`);
      continue;
    }
    const station = buildStationDays(rows, tz, unit);
    loaded.push({ slug, icao, name: CITY_BY_SLUG.get(slug)?.name ?? slug, tz, unit, station });
  }
  return loaded;
}

// =====================================================================================
// REPORT
// =====================================================================================

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function printCityDetail(c: LoadedCity, log: (m: string) => void): void {
  const clim = buildCityFloorClimatology(toEmitInput(c));
  log(`\n${'='.repeat(78)}`);
  log(`${c.slug} (${c.icao}, ${c.tz}, °${c.unit})  ${clim.nDays} complete days ${clim.fromYear}–${clim.toYear}`);
  log('  month   nDays  decided p10/med/p90   decidedPct @ 12  14  16  18  20 local');
  for (const m of clim.months) {
    if (!m) continue;
    const at = (h: number): string => `${Math.round((m.decidedPct[h] ?? 0) * 100)}`.padStart(3);
    log(
      `  ${MONTH_ABBR[m.month - 1]}     ${String(m.nDays).padStart(4)}   ${String(m.decidedHourP10).padStart(2)} / ${String(
        m.decidedHourMedian,
      ).padStart(2)} / ${String(m.decidedHourP90).padStart(2)}        ${at(12)} ${at(14)} ${at(16)} ${at(18)} ${at(20)} %`,
    );
  }
  const thin = clim.months.filter((m) => m === null).length;
  if (thin > 0) log(`  (${thin} month(s) under the ${'>'}=30-day floor — emitted as null)`);
}

function toEmitInput(c: LoadedCity): CityFloorEmitInput {
  return {
    slug: c.slug,
    icao: c.icao,
    name: c.name,
    tz: c.tz,
    unit: c.unit,
    fromYear: c.station.fromYear,
    toYear: c.station.toYear,
    days: c.station.days,
  };
}

// =====================================================================================
// SELF-TEST (no fs/network — the city-scan sanity() idiom)
// =====================================================================================

export function sanity(): void {
  // renderRow: native-unit selection + °F→°C fallback, the exact §resolution-oracle rounding.
  if (renderRow(77.9, 25.5, 'F') !== 78) throw new Error('sanity: renderRow F should wuRound(tmpf)');
  if (renderRow(77.9, 25.5, 'C') !== 26) throw new Error('sanity: renderRow C should wuRound(tmpc)');
  if (renderRow(77.9, null, 'C') !== 26) throw new Error('sanity: renderRow C should fall back to (tmpf−32)×5/9');
  if (renderRow(null, 25.5, 'F') !== null) throw new Error('sanity: renderRow F without tmpf must be null');

  // parseUtcMs: exact epoch for a known instant.
  if (parseUtcMs('2026-07-01 12:34') !== Date.UTC(2026, 6, 1, 12, 34)) throw new Error('sanity: parseUtcMs');

  // localParts: whole-offset DST zone + fractional-offset zone (the memo's hard case).
  const ams = localParts('Europe/Amsterdam', Date.UTC(2026, 6, 1, 12, 0)); // CEST = UTC+2
  if (ams.date !== '2026-07-01' || ams.hour !== 14) throw new Error(`sanity: localParts Amsterdam got ${JSON.stringify(ams)}`);
  const kol = localParts('Asia/Kolkata', Date.UTC(2026, 6, 1, 12, 40)); // +5:30 → 18:10
  if (kol.hour !== 18) throw new Error(`sanity: localParts Kolkata +5:30 got ${JSON.stringify(kol)}`);
  const kol2 = localParts('Asia/Kolkata', Date.UTC(2026, 6, 1, 12, 10)); // same UTC hour → 17:40 (memo must not smear)
  if (kol2.hour !== 17) throw new Error(`sanity: localParts Kolkata memo smeared the hour — got ${JSON.stringify(kol2)}`);
  const wlg = localParts('Pacific/Auckland', Date.UTC(2026, 6, 1, 12, 0)); // NZST = UTC+12 → next-day 00:00
  if (wlg.date !== '2026-07-02' || wlg.hour !== 0) throw new Error(`sanity: localParts Wellington got ${JSON.stringify(wlg)}`);

  // buildStationDays: one synthetic UTC day for a UTC+2 station → rows land on the right local day,
  // per-hour max wins, the decided hour matches the rendered peak.
  const rows: Array<[string, number | null, number | null]> = [];
  for (let h = 0; h < 24; h++) {
    const c = h <= 13 ? 10 + h : 10 + (26 - h); // local peak 23°C at local 15 (utc 13)
    rows.push([`2026-07-01 ${String(h).padStart(2, '0')}:20`, null, c]);
    rows.push([`2026-07-01 ${String(h).padStart(2, '0')}:50`, null, c - 0.4]); // SPECI-ish second row, lower
  }
  const st = buildStationDays(rows, 'Europe/Amsterdam', 'C');
  const full = st.days.find((d) => d.byLocalHour.size >= 20);
  if (!full) throw new Error('sanity: buildStationDays should yield one near-complete local day');
  if (decidedHour(full) !== 15) throw new Error(`sanity: decided hour should be local 15, got ${decidedHour(full)}`);
  if (full.byLocalHour.get(15) !== 23) throw new Error('sanity: per-hour max should keep the 23 over the 22.6 SPECI');

  process.stderr.write('  sanity OK — render/parse/localParts/day-fold verified\n');
}

// =====================================================================================
// CLI
// =====================================================================================
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  const { values } = parseArgs({
    options: {
      emit: { type: 'string' },
      cities: { type: 'string' },
    },
  });
  const log = (m: string): void => console.error(m);
  const filter = values.cities
    ? new Set(values.cities.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const loaded = loadAllCities(filter, log);
  if (loaded.length === 0) {
    log('no cities loaded — is out/iem-asos-archive/ populated? (scripts/research/iem-backfill.py)');
    process.exit(1);
  }

  if (values.emit) {
    const inputs = loaded.filter((c) => c.station.days.length > 0).map(toEmitInput);
    const res = emitCityFloorClimatologyAsset(inputs, values.emit);
    const thin = loaded.filter((c) => c.station.toYear - c.station.fromYear + 1 < 3).map((c) => c.slug);
    log(`\nEmitted ${res.nCities} cities → ${values.emit} (${res.totalDays} total complete days).`);
    log(
      thin.length
        ? `  coverage < 3 calendar years: ${thin.join(', ')}`
        : '  every emitted city spans ≥ 3 calendar years.',
    );
    process.exit(0);
  }

  // default: compact per-city summary; full per-month detail for an explicit --cities subset.
  log(`\n${'='.repeat(78)}`);
  log('CITY FLOOR-FORMATION SUMMARY — resolution-grade (IEM METAR), rendered-integer space');
  log('  city            days   span        Jul med decided   Jul p90   years<3?');
  for (const c of loaded) {
    const clim = buildCityFloorClimatology(toEmitInput(c));
    const jul = clim.months[6];
    log(
      `  ${c.slug.padEnd(15)} ${String(clim.nDays).padStart(5)}  ${clim.fromYear}–${clim.toYear}   ${
        jul ? `${String(jul.decidedHourMedian).padStart(7)}:00 local` : '   (thin)      '
      }   ${jul ? `${String(jul.decidedHourP90).padStart(5)}:00` : '    —'}   ${
        clim.toYear - clim.fromYear + 1 < 3 ? 'THIN' : ''
      }`,
    );
  }
  if (filter) for (const c of loaded) printCityDetail(c, log);
}
