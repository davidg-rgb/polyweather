/**
 * scripts/research/city-floor-climatology-emit — turns each city's RESOLUTION-GRADE (METAR/SPECI, IEM
 * archive) rendered-row record into the COMMITTED, typed floor-formation climatology asset:
 *   packages/core/src/sim/city-floor-climatology.ts
 *
 * This is the resolution-oracle sibling of city-climatology-emit.ts (ERA5). The two answer DIFFERENT
 * questions with different data grades:
 *   - city-climatology.ts (ERA5, ~20 y): the smooth climate-normal peak-hour distribution, °C space.
 *   - city-floor-climatology.ts (THIS, IEM METAR 2021+): per city × MONTH, when is the daily max
 *     EFFECTIVELY DECIDED in RENDERED-INTEGER space — P(WU-rendered running max at local hour h equals
 *     the day's final rendered max). That integer notion is exactly what resolves a temperature market
 *     (docs/DATA-SOURCES.md §resolution-oracle: the WU table is a bit-for-bit METAR re-render), so these
 *     curves are the market-relevant "when is the day decided" answer the ERA5 asset cannot give.
 *
 * Pure + deterministic (no Date/random/network/fs beyond the emit write): same day series in ⇒
 * byte-identical file out, so regen produces a clean diff. Self-contained: takes only structural
 * per-day rendered series — no import cycle with the loader script.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A month is emitted only when at least this many complete local days back it (below = null, honest). */
export const MIN_MONTH_DAYS = 30;

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Percentile with the repo's ceil convention (amsterdam-peak-hour.pct). */
export function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i] ?? NaN;
}

/**
 * One complete station-local day of the resolution stream, already rendered to WU integers.
 * byLocalHour holds the MAX rendered value observed within each local hour that has ≥1 row —
 * sufficient statistic for every running-max question at hourly resolution.
 */
export interface DayRenderedSeries {
  /** 1..12, station-local calendar month of the resolution day. */
  month: number;
  /** local hour (0..23) → max rendered WU integer observed within that hour. */
  byLocalHour: Map<number, number>;
  /** Station-local YYYY-MM-DD, when the producer keys days by date (truth-replica-crosscheck needs it). */
  date?: string;
}

/** Final rendered max of the day (over the hours actually present). */
export function finalRenderedMax(d: DayRenderedSeries): number {
  let m = -Infinity;
  for (const v of d.byLocalHour.values()) if (v > m) m = v;
  return m;
}

/**
 * First local hour at which the rendered running max reaches the day's final rendered max — the hour
 * the market outcome was structurally DECIDED (only ties can follow, never a higher bucket).
 */
export function decidedHour(d: DayRenderedSeries): number {
  const fin = finalRenderedMax(d);
  let run = -Infinity;
  for (let h = 0; h < 24; h++) {
    const v = d.byLocalHour.get(h);
    if (v !== undefined && v > run) run = v;
    if (run === fin) return h;
  }
  /* unreachable for a non-empty day: by hour 23 the running max IS the final max */
  return 23;
}

export interface MonthFloorClimatology {
  /** 1..12. */
  month: number;
  /** Complete local days backing this month's curve. */
  nDays: number;
  /**
   * P(rendered running max at local hour h == the day's final rendered max), h = 0..23.
   * Monotone non-decreasing by construction; decidedPct[23] === 1 (a day always decides by its end).
   * A day with no observation by h counts as NOT decided at h (no floor exists yet).
   */
  decidedPct: number[];
  /** First hour the rendered running max reaches the final value — distribution across days. */
  decidedHourP10: number;
  decidedHourMedian: number;
  decidedHourP90: number;
}

export interface CityFloorClimatology {
  slug: string;
  icao: string;
  name: string;
  tz: string;
  /** Native market/rendering unit — 'F' cities render wuRound(tmpf), 'C' cities wuRound(tmpc). */
  unit: 'C' | 'F';
  /** First / last calendar year with data actually present for this city (honest coverage). */
  fromYear: number;
  toYear: number;
  /** Total complete local days across all months (including months too thin to emit). */
  nDays: number;
  /** Index m−1 = month m; null when the month has < MIN_MONTH_DAYS complete days. */
  months: (MonthFloorClimatology | null)[];
}

export interface CityFloorClimatologyAsset {
  source: string;
  nCities: number;
  cities: CityFloorClimatology[];
}

export interface CityFloorEmitInput {
  slug: string;
  icao: string;
  name: string;
  tz: string;
  unit: 'C' | 'F';
  fromYear: number;
  toYear: number;
  /** Every complete local day loaded for this city, across all years. */
  days: DayRenderedSeries[];
}

/** Build one month's curve from its days. Pure. Returns null under the MIN_MONTH_DAYS floor. */
export function buildMonthFloor(month: number, days: DayRenderedSeries[]): MonthFloorClimatology | null {
  if (days.length < MIN_MONTH_DAYS) return null;
  const hours = days.map(decidedHour);
  const decidedPct: number[] = [];
  for (let h = 0; h < 24; h++) {
    let decided = 0;
    for (const dh of hours) if (dh <= h) decided++;
    decidedPct.push(r3(decided / days.length));
  }
  return {
    month,
    nDays: days.length,
    decidedPct,
    decidedHourP10: pct(hours, 10),
    decidedHourMedian: pct(hours, 50),
    decidedHourP90: pct(hours, 90),
  };
}

/** Build one city's 12-month floor climatology. Pure. Throws on an empty day set. */
export function buildCityFloorClimatology(input: CityFloorEmitInput): CityFloorClimatology {
  if (input.days.length === 0) {
    throw new Error(
      `city-floor-climatology emit: ${input.slug} (${input.icao}) has zero complete days — refusing to emit an empty city.`,
    );
  }
  const months: (MonthFloorClimatology | null)[] = [];
  for (let m = 1; m <= 12; m++) {
    months.push(buildMonthFloor(m, input.days.filter((d) => d.month === m)));
  }
  return {
    slug: input.slug,
    icao: input.icao,
    name: input.name,
    tz: input.tz,
    unit: input.unit,
    fromYear: input.fromYear,
    toYear: input.toYear,
    nDays: input.days.length,
    months,
  };
}

const FILE_HEADER = `/**
 * packages/core/sim/city-floor-climatology — AUTO-GENERATED. Do not edit by hand.
 *
 * The 45-city RESOLUTION-GRADE floor-formation climatology: per city × month, when is the daily max
 * effectively DECIDED — P(WU-rendered running max at local hour h == the day's final rendered max) —
 * derived from the IEM METAR/SPECI archive (the exact stream Polymarket temp markets resolve on,
 * docs/DATA-SOURCES.md §resolution-oracle), rendered per city in its native market unit and bucketed
 * to station-local days. The integer/rendered notion of "decided" is the market-relevant one: once the
 * rendered running max equals the day's final rendered max, no later observation can move the winning
 * bucket. Complements (does NOT replace) the ERA5 climate-normal asset city-climatology.ts.
 *
 * REGENERATE (extend out/iem-asos-archive/ first via scripts/research/iem-backfill.py):
 *   pnpm tsx scripts/research/city-floor-climatology.ts --emit packages/core/src/sim/city-floor-climatology.ts
 *
 * Per city (months[m-1], null when a month has < ${MIN_MONTH_DAYS} complete days):
 *   decidedPct[24]      P(day already decided at/before local hour h) — monotone, ends at 1
 *   decidedHourP10/Median/P90   distribution of the first hour the final rendered max is reached
 *   nDays, fromYear/toYear      honest per-city coverage
 */
`;

const INTERFACES = `export interface MonthFloorClimatology {
  /** 1..12. */
  month: number;
  /** Complete local days backing this month's curve. */
  nDays: number;
  /** P(rendered running max at local hour h == final rendered max), h = 0..23. Monotone, ends at 1. */
  decidedPct: number[];
  /** 10th percentile of the first local hour the final rendered max is reached. */
  decidedHourP10: number;
  /** Median first local hour the final rendered max is reached — "the day is usually decided by". */
  decidedHourMedian: number;
  /** 90th percentile — the late-forming tail. */
  decidedHourP90: number;
}

export interface CityFloorClimatology {
  slug: string;
  icao: string;
  name: string;
  tz: string;
  /** Native market/rendering unit — 'F' cities render wuRound(tmpf), 'C' cities wuRound(tmpc). */
  unit: 'C' | 'F';
  /** First / last calendar year with data actually present for this city. */
  fromYear: number;
  toYear: number;
  /** Total complete local days across all months. */
  nDays: number;
  /** Index m−1 = month m; null when the month has too few complete days. */
  months: (MonthFloorClimatology | null)[];
}

export interface CityFloorClimatologyAsset {
  source: string;
  nCities: number;
  cities: CityFloorClimatology[];
}
`;

const HELPERS = `
const BY_SLUG = new Map(CITY_FLOOR_CLIMATOLOGY.cities.map((c) => [c.slug, c]));

/** The city's floor climatology, or null when the slug is not in the committed universe. */
export function getCityFloorClimatology(slug: string): CityFloorClimatology | null {
  return BY_SLUG.get(slug) ?? null;
}

/** The month (1..12) entry, or null when that month's sample was too thin to emit. */
export function cityFloorMonth(clim: CityFloorClimatology, month: number): MonthFloorClimatology | null {
  return clim.months[month - 1] ?? null;
}
`;

/** Build the asset from per-city inputs + write the typed core file. Returns totals (for tests/logging). */
export function emitCityFloorClimatologyAsset(
  inputs: CityFloorEmitInput[],
  outPath: string,
): { nCities: number; totalDays: number } {
  const cities = inputs
    .map(buildCityFloorClimatology)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const totalDays = cities.reduce((acc, c) => acc + c.nDays, 0);
  // One line per city keeps the generated diff readable while staying compact.
  const citiesJson = cities.map((c) => '    ' + JSON.stringify(c)).join(',\n');
  const body =
    `export const CITY_FLOOR_CLIMATOLOGY: CityFloorClimatologyAsset = {\n` +
    `  source: 'iem-metar',\n` +
    `  nCities: ${cities.length},\n` +
    `  cities: [\n${citiesJson},\n  ],\n` +
    `};\n`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${FILE_HEADER}\n${INTERFACES}\n${body}${HELPERS}`);
  return { nCities: cities.length, totalDays };
}
