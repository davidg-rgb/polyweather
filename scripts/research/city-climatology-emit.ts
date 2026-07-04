/**
 * scripts/research/city-climatology-emit — turns each city's ERA5 per-day peak record into the COMMITTED,
 * typed, COMPACT climatology asset the /paper-trade page reads at runtime:
 *   packages/core/src/sim/city-climatology.ts
 *
 * This is the 45-city generalization of amsterdam-climatology-emit.ts. It REUSES that module's decision math
 * verbatim (decisionStats / peakHistogram / median / DECISION_HOURS) so the per-hour floor-confidence numbers
 * are computed by the exact same code the Amsterdam asset uses — the two only differ in DATA SOURCE (ERA5
 * reanalysis vs KNMI station) and in the asset SHAPE (compact: one annual + one warm-season curve per city,
 * no per-month avgTemp/avgRunMax traces — the /paper-trade display needs only peak hour + floor confidence).
 *
 * Pure + deterministic (no Date/random): same day-peaks in ⇒ byte-identical file out, so regen gives a clean
 * diff. Self-contained emit (takes only structural DayPeakLike + metadata) — no import cycle with the fetch
 * script.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DECISION_HOURS,
  type DayPeakLike,
  type HourDecisionStat,
  decisionStats,
  median,
  peakHistogram,
} from './amsterdam-climatology-emit.ts';

/** A warm-season sub-period is only emitted when at least this many warm-month days were fetched. */
const WARM_MIN_DAYS = 60;

const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** The compact per-hour floor-confidence row (a projection of the shared HourDecisionStat). */
export interface CityHourFloorStat {
  hour: number;
  /** P(the day's max was already reached at/before this local hour) — the headline "floor confidence". */
  peakedPct: number;
  /** P(remaining warming after this hour ≤ 0.5°C) — the floor is essentially locked for a ~1°C bucket. */
  leUpside05: number;
  /** Mean forward upside (°C) still possible after this hour. */
  meanUpsideC: number;
  /** Days with an observation by this hour (the upside-distribution denominator). */
  n: number;
}

export interface CitySeasonClimatology {
  nDays: number;
  medianPeakHour: number;
  decisionByHour: CityHourFloorStat[];
}

export interface CityClimatology {
  slug: string;
  icao: string;
  name: string;
  lat: number;
  lon: number;
  tz: string;
  /** First / last CALENDAR YEAR actually fetched for this city (honest per-city coverage). */
  fromYear: number;
  toYear: number;
  nDays: number;
  medianPeakHour: number;
  /** Share of days whose max is first reached at each local hour 0..23 (sums ≈ 1). */
  peakHourHistogram: number[];
  decisionByHour: CityHourFloorStat[];
  /** Hemisphere warm-season sub-climatology, or null when the fetched warm sample is too thin. */
  warm: CitySeasonClimatology | null;
}

export interface CityClimatologyAsset {
  source: string;
  decisionHours: number[];
  nCities: number;
  cities: CityClimatology[];
}

/** Project the full shared decision stat to the compact display subset. */
function compactStat(s: HourDecisionStat): CityHourFloorStat {
  return { hour: s.hour, peakedPct: s.peakedPct, leUpside05: s.leUpside05, meanUpsideC: s.meanUpsideC, n: s.n };
}

export interface CityEmitInput {
  slug: string;
  icao: string;
  name: string;
  lat: number;
  lon: number;
  tz: string;
  fromYear: number;
  toYear: number;
  /** Every complete local day fetched for this city, across all cached years. */
  peaks: DayPeakLike[];
  /** The months (1..12) counted as this city's warm season (hemisphere-aware). */
  warmMonths: number[];
}

/** Build one city's compact climatology from its day-peaks. Pure. Throws on an empty peak set. */
export function buildCityClimatology(input: CityEmitInput): CityClimatology {
  if (input.peaks.length === 0) {
    throw new Error(`city-climatology emit: ${input.slug} (${input.icao}) has zero day-peaks — refusing to emit an empty city.`);
  }
  const warmSet = new Set(input.warmMonths);
  const warmDays = input.peaks.filter((d) => warmSet.has(d.month));
  const warm: CitySeasonClimatology | null =
    warmDays.length >= WARM_MIN_DAYS
      ? {
          nDays: warmDays.length,
          medianPeakHour: median(warmDays.map((d) => d.peakLocalHour)),
          decisionByHour: decisionStats(warmDays).map(compactStat),
        }
      : null;
  return {
    slug: input.slug,
    icao: input.icao,
    name: input.name,
    lat: input.lat,
    lon: input.lon,
    tz: input.tz,
    fromYear: input.fromYear,
    toYear: input.toYear,
    nDays: input.peaks.length,
    medianPeakHour: median(input.peaks.map((d) => d.peakLocalHour)),
    peakHourHistogram: peakHistogram(input.peaks),
    decisionByHour: decisionStats(input.peaks).map(compactStat),
    warm,
  };
}

const FILE_HEADER = `/**
 * packages/core/sim/city-climatology — AUTO-GENERATED. Do not edit by hand.
 *
 * The 45-city hour-of-day temperature climatology that powers the /paper-trade per-city climatology column
 * (peak hour + floor confidence at the recommended entry arm). It is the ERA5 generalization of the
 * Amsterdam-only KNMI climatology (amsterdam-climatology.ts): derived from ~two decades of FREE Open-Meteo
 * ERA5 archive hourly 2 m temperature per city (no auth, no key), converted to each city's DST-aware local
 * time, one peak-hour per local calendar day (the day the market resolves over), scored by the SAME decision
 * math the Amsterdam asset uses (scripts/research/amsterdam-climatology-emit.ts: decisionStats/peakHistogram).
 *
 * The city SET + timezones are the committed 45-city universe (migrations 0066/0067 → scripts/research/
 * city-catalog.ts). Coordinates are each city's primary weather station (documented provenance in the
 * catalog). DISPLAY-ONLY: nothing here feeds the sim, bet placement, or the entry-watch math.
 *
 * REGENERATE (only when extending the year range or refreshing the climate normal):
 *   pnpm tsx scripts/research/city-peak-hour.ts --emit packages/core/src/sim/city-climatology.ts [--from 2006 --to 2025]
 *
 * Per city:
 *   fromYear/toYear         the calendar-year span actually fetched (honest per-city coverage)
 *   medianPeakHour          median local hour of the daily max
 *   peakHourHistogram[24]   share of days whose max is first reached at each local hour (sums ≈ 1)
 *   decisionByHour[10..19]  per lock-hour: peakedPct (P max already reached — the floor confidence),
 *                           leUpside05 (P remaining warming ≤ 0.5°C), meanUpsideC, n
 *   warm                    hemisphere warm-season sub-climatology (null when the fetched sample is thin)
 */
`;

const INTERFACES = `export interface CityHourFloorStat {
  /** Local hour this row describes. */
  hour: number;
  /** P(the day's max was already reached at/before this local hour) — the headline "floor confidence". */
  peakedPct: number;
  /** P(remaining warming after this hour ≤ 0.5°C) — the floor is essentially locked for a ~1°C bucket. */
  leUpside05: number;
  /** Mean forward upside (°C) still possible after this hour. */
  meanUpsideC: number;
  /** Days with an observation by this hour (the upside-distribution denominator). */
  n: number;
}

export interface CitySeasonClimatology {
  nDays: number;
  medianPeakHour: number;
  decisionByHour: CityHourFloorStat[];
}

export interface CityClimatology {
  slug: string;
  icao: string;
  name: string;
  lat: number;
  lon: number;
  tz: string;
  /** First / last calendar year actually fetched for this city. */
  fromYear: number;
  toYear: number;
  nDays: number;
  medianPeakHour: number;
  /** Share of days whose max is first reached at each local hour 0..23 (sums ≈ 1). */
  peakHourHistogram: number[];
  decisionByHour: CityHourFloorStat[];
  /** Hemisphere warm-season sub-climatology, or null when the fetched warm sample is too thin. */
  warm: CitySeasonClimatology | null;
}

export interface CityClimatologyAsset {
  source: string;
  decisionHours: number[];
  nCities: number;
  cities: CityClimatology[];
}
`;

const HELPERS = `/** slug → this city's climatology, or null when the city is not in the ERA5 universe. */
export function getCityClimatology(slug: string): CityClimatology | null {
  return CITY_CLIMATOLOGY.cities.find((c) => c.slug === slug) ?? null;
}

/**
 * The floor confidence (P the day's max is already reached) at a given local lock hour for a city — the
 * display number shown next to the entry-watch recommendation on /paper-trade. null when the city is unknown
 * or the hour is outside the covered decision window.
 */
export function cityFloorConfidenceAt(slug: string, hour: number): number | null {
  const clim = getCityClimatology(slug);
  if (!clim) return null;
  return clim.decisionByHour.find((d) => d.hour === hour)?.peakedPct ?? null;
}
`;

export interface CityEmitResult {
  nCities: number;
  totalDays: number;
}

/** Build every city's compact climatology + write the typed core asset. Returns a coverage summary. */
export function emitCityClimatologyAsset(inputs: CityEmitInput[], outPath: string): CityEmitResult {
  const cities = inputs
    .map((i) => buildCityClimatology(i))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const asset: CityClimatologyAsset = {
    source: 'openmeteo-era5',
    decisionHours: DECISION_HOURS,
    nCities: cities.length,
    cities,
  };
  // Round every stored number to a compact, stable precision (probabilities r3, °C r2, coords/hist untouched
  // — coords are catalog literals; the histogram is already r3 from peakHistogram).
  const rounded = cities.map((c) => ({
    ...c,
    decisionByHour: c.decisionByHour.map((d) => ({
      hour: d.hour,
      peakedPct: r3(d.peakedPct),
      leUpside05: r3(d.leUpside05),
      meanUpsideC: r2(d.meanUpsideC),
      n: d.n,
    })),
    warm: c.warm
      ? {
          nDays: c.warm.nDays,
          medianPeakHour: c.warm.medianPeakHour,
          decisionByHour: c.warm.decisionByHour.map((d) => ({
            hour: d.hour,
            peakedPct: r3(d.peakedPct),
            leUpside05: r3(d.leUpside05),
            meanUpsideC: r2(d.meanUpsideC),
            n: d.n,
          })),
        }
      : null,
  }));
  const citiesJson = rounded.map((c) => '    ' + JSON.stringify(c)).join(',\n');
  const body =
    `export const CITY_CLIMATOLOGY: CityClimatologyAsset = {\n` +
    `  source: ${JSON.stringify(asset.source)},\n` +
    `  decisionHours: ${JSON.stringify(DECISION_HOURS)},\n` +
    `  nCities: ${asset.nCities},\n` +
    `  cities: [\n${citiesJson},\n  ],\n` +
    `};\n`;
  const out = `${FILE_HEADER}\n${INTERFACES}\n${body}\n${HELPERS}`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out);
  return { nCities: cities.length, totalDays: cities.reduce((s, c) => s + c.nDays, 0) };
}
