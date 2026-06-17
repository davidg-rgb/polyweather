/**
 * scripts/research/amsterdam-climatology-emit — turns the 20-year per-day peak record (KNMI station 240)
 * into the COMMITTED, typed climatology asset the prediction model + the /amsterdam UI read at runtime:
 *   packages/core/src/sim/amsterdam-climatology.ts
 *
 * Why a committed asset, not a DB table: the climatology is a static multi-decade artifact that changes
 * ~never (re-derive at most yearly). A TS const is dependency-free, fully tree-shakeable, unit-testable,
 * and needs no migration / RPC / Edge refresh — the simple solve that ships. Regenerate with
 *   pnpm tsx scripts/research/amsterdam-peak-hour.ts --emit packages/core/src/sim/amsterdam-climatology.ts
 *
 * Self-contained: takes only the structural per-day peaks (so there is no import cycle with the analysis
 * script), recomputes the forward-upside distribution itself, and writes the file. Pure + deterministic
 * (no Date/random) → same data in ⇒ byte-identical file out, so regen produces a clean diff.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The structural shape the emitter needs from each day — a subset of the analysis script's DayPeak. */
export interface DayPeakLike {
  month: number; // 1..12, station-local
  maxC: number; // the day's max temperature, °C
  peakLocalHour: number; // local hour (0..23) the max was first reached
  byLocalHour: Map<number, number>; // local hour -> tenths°C observed
}

/** Local hours we store per-hour decision stats for (the candidate evaluation/lock window). */
const DECISION_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
/** A hot-day sub-climatology is only emitted when at least this many ≥25°C days exist for the month. */
const HOT_MIN_DAYS = 30;
/** °C threshold defining a "hot day" — boundaries are most in play here, and the peak runs later. */
const HOT_THRESHOLD_C = 25;

const r1 = (x: number): number => Math.round(x * 10) / 10;
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function p90(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(0.9 * s.length) - 1));
  return s[i] ?? 0;
}
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? 0;
}

/** Running max (°C) over local hours ≤ h present in the day; null if nothing observed by h yet. */
function runningMaxAt(byLocalHour: Map<number, number>, h: number): number | null {
  let m = -Infinity;
  for (const [hr, t] of byLocalHour) if (hr <= h && t > m) m = t;
  return m === -Infinity ? null : m / 10;
}

/**
 * Forward upside (°C) still possible after locking at local hour h:
 *   max(0, (max temp at hours > h) − (running max at hours ≤ h)).
 * Zero once the peak is past — the only honest "how much more can the floor rise" quantity. null if no
 * observation exists by h (no floor yet).
 */
function forwardUpsideC(byLocalHour: Map<number, number>, h: number): number | null {
  let runMax = -Infinity;
  let fwdMax = -Infinity;
  let sawH = false;
  for (const [hr, t] of byLocalHour) {
    if (hr <= h) {
      sawH = true;
      if (t > runMax) runMax = t;
    } else if (t > fwdMax) fwdMax = t;
  }
  if (!sawH) return null;
  if (fwdMax === -Infinity) return 0;
  return Math.max(0, (fwdMax - runMax) / 10);
}

interface HourDecisionStat {
  hour: number;
  peakedPct: number;
  leUpside05: number;
  leUpside10: number;
  meanUpsideC: number;
  p90UpsideC: number;
  n: number;
}

function decisionStats(days: DayPeakLike[]): HourDecisionStat[] {
  return DECISION_HOURS.map((h) => {
    // peakedPct is UNCONDITIONAL: P(max reached by h) over ALL period days (peakLocalHour is always known),
    // divided by the constant days.length — so it is monotone non-decreasing in h by construction and matches
    // the "P max already reached" JSDoc. (Dividing by the coverage-conditioned upside count `n` would only be
    // monotone when n is constant across hours, which holds in the committed asset by accident, not design.)
    let peaked = 0;
    for (const d of days) if (d.peakLocalHour <= h) peaked++;
    // The upside distribution is measured only over days that have an observation by h (a floor to measure from).
    const upsides: number[] = [];
    for (const d of days) {
      const u = forwardUpsideC(d.byLocalHour, h);
      if (u != null) upsides.push(u);
    }
    const n = upsides.length;
    const le = (t: number): number => (n ? upsides.filter((x) => x <= t).length / n : 0);
    return {
      hour: h,
      peakedPct: r3(days.length ? peaked / days.length : 0),
      leUpside05: r3(le(0.5)),
      leUpside10: r3(le(1.0)),
      meanUpsideC: r2(mean(upsides)),
      p90UpsideC: r2(p90(upsides)),
      n,
    };
  });
}

function peakHistogram(days: DayPeakLike[]): number[] {
  const counts = new Array<number>(24).fill(0);
  for (const d of days) counts[d.peakLocalHour] = (counts[d.peakLocalHour] ?? 0) + 1;
  return counts.map((c) => r3(days.length ? c / days.length : 0));
}

function buildMonth(month: number, days: DayPeakLike[]): unknown {
  const avgTempC: number[] = [];
  const avgRunMaxC: number[] = [];
  for (let h = 0; h < 24; h++) {
    const temps: number[] = [];
    const runs: number[] = [];
    for (const d of days) {
      const t = d.byLocalHour.get(h);
      if (t != null) temps.push(t / 10);
      const rm = runningMaxAt(d.byLocalHour, h);
      if (rm != null) runs.push(rm);
    }
    // Refuse to fabricate a 0°C curve point from an empty sample (mean([])→0): fail the regen loudly instead.
    // The committed 20-year asset populates every local hour; this only bites a future narrow/sparse regen.
    if (temps.length === 0 || runs.length === 0) {
      throw new Error(
        `climatology emit: month ${month} local hour ${h} has no ${temps.length === 0 ? 'temperature' : 'running-max'} ` +
          `samples across ${days.length} days — refusing to emit a fabricated 0°C average. Widen the year range.`,
      );
    }
    avgTempC.push(r1(mean(temps)));
    avgRunMaxC.push(r1(mean(runs)));
  }
  const hotDays = days.filter((d) => d.maxC >= HOT_THRESHOLD_C);
  const hot =
    hotDays.length >= HOT_MIN_DAYS
      ? {
          nDays: hotDays.length,
          medianPeakHour: median(hotDays.map((d) => d.peakLocalHour)),
          peakHourHistogram: peakHistogram(hotDays),
          decisionByHour: decisionStats(hotDays),
        }
      : null;
  return {
    month,
    nDays: days.length,
    medianPeakHour: median(days.map((d) => d.peakLocalHour)),
    avgTempC,
    avgRunMaxC,
    peakHourHistogram: peakHistogram(days),
    decisionByHour: decisionStats(days),
    hot,
  };
}

const FILE_HEADER = `/**
 * packages/core/sim/amsterdam-climatology — AUTO-GENERATED. Do not edit by hand.
 *
 * The Schiphol (EHAM / KNMI station 240) hour-of-day temperature climatology that powers the Amsterdam
 * best-time-to-bet model and the /amsterdam hero chart. Derived from ~20 years of KNMI hourly T (free,
 * no-auth daggegevens/uurgegevens, var T at 1.5 m, 0.1°C), converted to Europe/Amsterdam local time, one
 * peak-hour per local calendar day (the day the market resolves over). See scripts/research/
 * amsterdam-peak-hour.ts and AMSTERDAM-SIM.md §"peak-hour model".
 *
 * REGENERATE (only when extending the year range or refreshing the climate normal):
 *   pnpm tsx scripts/research/amsterdam-peak-hour.ts --emit packages/core/src/sim/amsterdam-climatology.ts
 *
 * Fields, per month (and a hot-day ≥25°C sub-climatology where the sample supports it):
 *   avgTempC[24]            mean instantaneous temperature by local hour (the "20-yr average" trace)
 *   avgRunMaxC[24]          mean running-max-so-far by local hour (directly comparable to today's bet floor)
 *   peakHourHistogram[24]   share of days whose max is first reached at each local hour (sums ≈ 1)
 *   medianPeakHour          median local hour of the daily max
 *   decisionByHour[10..19]  per lock-hour: peakedPct (P max already reached), leUpside05/leUpside10
 *                           (P remaining warming ≤ 0.5 / 1.0°C — floor-break safety), mean/p90 forward upside°C
 */
`;

const INTERFACES = `export interface HourDecisionStat {
  /** Local hour (Europe/Amsterdam) this row describes. */
  hour: number;
  /** P(the day's max was already reached at/before this hour). */
  peakedPct: number;
  /** P(remaining warming after this hour ≤ 0.5°C) — the floor is essentially locked for a ~1°C bucket. */
  leUpside05: number;
  /** P(remaining warming after this hour ≤ 1.0°C). */
  leUpside10: number;
  /** Mean forward upside (°C) still possible after this hour. */
  meanUpsideC: number;
  /** 90th-percentile forward upside (°C) — the bad-tail floor-break risk. */
  p90UpsideC: number;
  /** Days with an observation by this hour — the upside-distribution denominator (peakedPct uses all period days). */
  n: number;
}

export interface PeriodClimatology {
  nDays: number;
  medianPeakHour: number;
  peakHourHistogram: number[];
  decisionByHour: HourDecisionStat[];
}

export interface MonthClimatology {
  month: number;
  nDays: number;
  medianPeakHour: number;
  /** Mean instantaneous temperature (°C) by local hour 0..23. */
  avgTempC: number[];
  /** Mean running-max-so-far (°C) by local hour 0..23 — comparable to today's bet floor. */
  avgRunMaxC: number[];
  peakHourHistogram: number[];
  decisionByHour: HourDecisionStat[];
  /** Hot-day (≥25°C) sub-climatology, or null when the month lacks a usable hot-day sample. */
  hot: PeriodClimatology | null;
}

export interface AmsterdamClimatology {
  station: number;
  source: string;
  fromYear: number;
  toYear: number;
  nDays: number;
  /** Local hours decisionByHour covers. */
  decisionHours: number[];
  months: MonthClimatology[];
}
`;

export interface EmitOpts {
  outPath: string;
  fromYear: number;
  toYear: number;
}

/** Build the climatology object + write the typed core asset. Returns the object (for tests/logging). */
export function emitClimatologyAsset(peaks: DayPeakLike[], opts: EmitOpts): { nDays: number; nMonths: number } {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    months.push(buildMonth(m, peaks.filter((d) => d.month === m)));
  }
  const asset = {
    station: 240,
    source: 'knmi-240',
    fromYear: opts.fromYear,
    toYear: opts.toYear,
    nDays: peaks.length,
    decisionHours: DECISION_HOURS,
    months,
  };
  // One line per month keeps the generated diff readable while staying compact.
  const monthsJson = months.map((m) => '    ' + JSON.stringify(m)).join(',\n');
  const body =
    `export const AMSTERDAM_CLIMATOLOGY: AmsterdamClimatology = {\n` +
    `  station: ${asset.station},\n` +
    `  source: ${JSON.stringify(asset.source)},\n` +
    `  fromYear: ${asset.fromYear},\n` +
    `  toYear: ${asset.toYear},\n` +
    `  nDays: ${asset.nDays},\n` +
    `  decisionHours: ${JSON.stringify(DECISION_HOURS)},\n` +
    `  months: [\n${monthsJson},\n  ],\n` +
    `};\n`;
  const out = `${FILE_HEADER}\n${INTERFACES}\n${body}`;
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, out);
  return { nDays: peaks.length, nMonths: months.length };
}
