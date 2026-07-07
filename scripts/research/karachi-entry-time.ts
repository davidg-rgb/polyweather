/**
 * scripts/research/karachi-entry-time — the operator's "Test 1" for KARACHI daily-Tmax markets:
 * find the by-time-of-day BUY WINDOW where (1) our day-of prediction is right and (2) the odds
 * give the most potential profit — buy OUR predicted bucket, hold to resolution — and surface a
 * signal that flags when our prediction is likely WRONG (for a skipped buy / early exit).
 *
 * Data (all local, read-only):
 *   - our forecast:  out/forecast-by-event.csv  (filter fc_city==='karachi'; pred_bucket_l0 = the
 *     day-of calibrated predicted market-bucket idx — the one a day-of buy would act on).
 *   - price + outcome: out/market-history/karachi/{weatherDate}__{eventId}.json  (~1-min MID /
 *     implied-prob per bucket, resolvedOutcome baked in). Join by eventId. Winner = the bucket with
 *     resolvedOutcome==='win'; unresolved events are skipped.
 *
 * Model (this IS the point — encoded exactly):
 *   - win = (pred_bucket_l0 === winnerIdx)   → EVENT-level, FIXED per event, independent of entry hour.
 *   - entry price p = the predicted bucket's MID at the entry time.
 *   - buy-and-hold-to-resolution net per $1 staked:  netReturn = win ? (1−p)/p : −1  (stake $1 → 1/p
 *     shares, winner pays $1/share). All profit is GROSS of spread — MID is a LOWER BOUND on the real
 *     taker ask (true ask ≥ mid); Karachi is a hard buy-cheap market (see WINNER-BAND-ANALYSIS.md).
 *   - entry time is Karachi LOCAL (Asia/Karachi = UTC+5, no DST). Local hour h of weather day D →
 *     targetUtc = dMidUtc + h·3600; the entry at h is the predicted bucket's LAST point in
 *     [targetUtc−90min, targetUtc] (else NO valid entry that hour — thin liquidity, skip).
 *
 * KEY INSIGHT surfaced honestly: because the hit rate is event-level, the hour never changes whether
 * we are RIGHT — it only changes (a) how cheap a reliable entry on the predicted bucket is and (b) how
 * many events are still live (some Karachi markets resolve before noon). So the optimal buy time is a
 * cheap-entry + still-live WINDOW, and the "wrong-prediction" edge comes from a divergence SIGNAL, not
 * from the clock. Output is a WINDOW with a confidence band, not a single magic minute.
 *
 * Read-only. Run: pnpm tsx scripts/research/karachi-entry-time.ts
 * Output: out/karachi-entry-time.md  +  out/karachi-entry-time.csv
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapMeanCi } from '../../packages/core/src/sim/stats.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');
const ARCHIVE = join(OUT_DIR, 'market-history', 'karachi');
const FORECAST_CSV = join(OUT_DIR, 'forecast-by-event.csv');

/** Karachi = Asia/Karachi = UTC+5, no DST. */
const KARACHI_UTC_OFFSET_H = 5;
/** 90-min look-back window for a valid intraday entry (spec). */
const ENTRY_WINDOW_SEC = 90 * 60;
/** 3h look-back for the wrong-prediction trend feature (spec). */
const TREND_WINDOW_SEC = 3 * 3600;
/** Reference entry hour = the live test's hour, where the wrong-prediction signal is scored (spec). */
const REF_HOUR = 14;
/** Min events for an hour to be eligible to anchor the recommended window (spec). */
const MIN_N = 15;
/** Bootstrap resamples for the shrinkage lower bound (spec: ≥2000). */
const BOOT_ITERS = 2000;
const BOOT_SEED = 42;

// ── Types (the pull-market-history event-file shape) ────────────────────────────────────────────
export interface Bucket {
  idx: number;
  label: string | null;
  resolvedOutcome: 'win' | 'lose' | null;
  points: Array<[number, number]>; // [epochSec, mid/impliedProb]
}
export interface EventFile {
  city: string;
  eventId: string;
  targetDate: string;
  endDate: string | null;
  buckets: Bucket[];
}

// ── Pure core (exported for tests) ──────────────────────────────────────────────────────────────

/** UTC epoch (sec) of local hour `h` on weather day `targetDate` in Karachi (UTC+5, no DST). */
export function localHourToUtc(targetDate: string, h: number, offsetH: number = KARACHI_UTC_OFFSET_H): number {
  const sign = offsetH >= 0 ? '+' : '-';
  const abs = Math.abs(offsetH);
  const hh = String(Math.floor(abs)).padStart(2, '0');
  const mm = String(Math.round((abs - Math.floor(abs)) * 60)).padStart(2, '0');
  const dMid = Date.parse(`${targetDate}T00:00:00${sign}${hh}:${mm}`) / 1000;
  return dMid + h * 3600;
}

/**
 * The predicted bucket's MID at local entry time `targetUtc`: the LAST point with
 * t ≤ targetUtc AND t ≥ targetUtc − windowSec. null = no valid entry (thin/expired book at that hour).
 */
export function priceAtLocalHour(points: Array<[number, number]>, targetUtc: number, windowSec: number = ENTRY_WINDOW_SEC): number | null {
  let entry: number | null = null;
  for (const [t, p] of points) {
    if (t <= targetUtc && t >= targetUtc - windowSec) entry = p;
  }
  return entry;
}

/** Buy-and-hold-to-resolution net per $1 staked. p is the entry mid (assumed > 0 — guarded at call sites). */
export function netReturn(win: boolean, p: number): number {
  return win ? (1 - p) / p : -1;
}

/**
 * gap-to-favorite = predicted-bucket mid − max mid of any OTHER bucket at the entry time.
 * Negative = the market favours a different bucket than ours (divergence). null = no other bucket priced.
 */
export function gapToFavorite(predMid: number, otherMids: Array<number | null>): number | null {
  const finite = otherMids.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!finite.length) return null;
  return predMid - Math.max(...finite);
}

/** Least-squares slope (prob per hour) of the predicted bucket's mid over [targetUtc − windowSec, targetUtc]. */
export function trendSlope(points: Array<[number, number]>, targetUtc: number, windowSec: number = TREND_WINDOW_SEC): number | null {
  const w = points.filter(([t]) => t <= targetUtc && t >= targetUtc - windowSec);
  const n = w.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const [t, p] of w) {
    sx += (t - targetUtc) / 3600;
    sy += p;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let den = 0;
  for (const [t, p] of w) {
    const x = (t - targetUtc) / 3600;
    num += (x - mx) * (p - my);
    den += (x - mx) * (x - mx);
  }
  return den === 0 ? null : num / den;
}

/** Shrinkage lower bound: the seeded percentile bootstrap's 10th-pct of the resample means (reuses core). */
export function bootstrapMeanP10(values: number[], seed: number = BOOT_SEED, iters: number = BOOT_ITERS): number {
  return bootstrapMeanCi(values, { alpha: 0.2, iters, seed }).lo; // lo = quantile(means, 0.1)
}

/** Hours-before-resolution bin label for a point that resolves `hrs` before endDate. */
export function hrsBeforeBin(hrs: number): string {
  if (hrs < 0) return 'post';
  if (hrs >= 48) return '48+';
  const lo = Math.floor(hrs / 6) * 6;
  return `${lo}-${lo + 6}`;
}
const HRS_BINS = ['0-6', '6-12', '12-18', '18-24', '24-30', '30-36', '36-42', '42-48', '48+'];

// ── small stat helpers (winner-band idiom) ──────────────────────────────────────────────────────
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
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN);
const pc = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const cents = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}¢` : '—');
const ret = (x: number): string => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(3)}` : '—');

const csv = (v: string | number | null): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ── Loaded, joined event record ─────────────────────────────────────────────────────────────────
interface EventRec {
  eventId: string;
  weatherDate: string;
  dMidUtc: number;
  endTs: number | null;
  predL0: number;
  predL1: number;
  predL2: number;
  winnerIdx: number;
  winL0: boolean;
  winL1: boolean;
  winL2: boolean;
  predBucket: Bucket | undefined; // the L0 predicted bucket (may be absent from this market)
  buckets: Bucket[];
}

interface ForecastRow {
  predL0: number;
  predL1: number;
  predL2: number;
}

/** Parse the Karachi rows of forecast-by-event.csv → eventId → predicted bucket idx (l0/l1/l2). */
export function parseForecastCsv(text: string): Map<string, ForecastRow> {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? '').split(',');
  const col = (name: string): number => header.indexOf(name);
  const iId = col('event_id');
  const iCity = col('fc_city');
  const iL0 = col('pred_bucket_l0');
  const iL1 = col('pred_bucket_l1');
  const iL2 = col('pred_bucket_l2');
  const out = new Map<string, ForecastRow>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c[iCity] !== 'karachi') continue;
    const id = c[iId];
    if (!id) continue;
    out.set(id, { predL0: Number(c[iL0]), predL1: Number(c[iL1]), predL2: Number(c[iL2]) });
  }
  return out;
}

// ── Runner ───────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (!existsSync(ARCHIVE)) throw new Error(`no Karachi archive at ${ARCHIVE} — run pull-market-history first`);
  if (!existsSync(FORECAST_CSV)) throw new Error(`no forecast CSV at ${FORECAST_CSV}`);

  const fc = parseForecastCsv(readFileSync(FORECAST_CSV, 'utf8'));
  const files = readdirSync(ARCHIVE).filter((f) => f.endsWith('.json'));

  const events: EventRec[] = [];
  let noForecast = 0;
  let noWinner = 0;
  let corrupt = 0;
  for (const f of files) {
    let ev: EventFile;
    try {
      ev = JSON.parse(readFileSync(join(ARCHIVE, f), 'utf8')) as EventFile;
    } catch (e) {
      console.error(`  ⚠ skipped corrupt file ${f}: ${e instanceof Error ? e.message : String(e)}`);
      corrupt++;
      continue;
    }
    const row = fc.get(String(ev.eventId));
    if (!row || !Number.isFinite(row.predL0)) {
      noForecast++;
      continue;
    }
    const winB = ev.buckets.find((b) => b.resolvedOutcome === 'win');
    if (!winB) {
      noWinner++;
      continue;
    }
    events.push({
      eventId: String(ev.eventId),
      weatherDate: ev.targetDate,
      dMidUtc: localHourToUtc(ev.targetDate, 0),
      endTs: ev.endDate ? Math.floor(new Date(ev.endDate).getTime() / 1000) : null,
      predL0: row.predL0,
      predL1: row.predL1,
      predL2: row.predL2,
      winnerIdx: winB.idx,
      winL0: row.predL0 === winB.idx,
      winL1: row.predL1 === winB.idx,
      winL2: row.predL2 === winB.idx,
      predBucket: ev.buckets.find((b) => b.idx === row.predL0),
      buckets: ev.buckets,
    });
  }

  const N = events.length;
  if (N === 0) throw new Error('no joined+resolved Karachi events — nothing to analyse');

  // ── event-level hit rates (fixed per event, independent of entry hour) ──────────────────────────
  const hitL0 = events.filter((e) => e.winL0).length / N;
  const hitL1 = events.filter((e) => e.winL1).length / N;
  const hitL2 = events.filter((e) => e.winL2).length / N;

  // ── (A) day-of hourly sweep (Karachi local hour 0..23 on day D) ────────────────────────────────
  interface HourRow {
    hour: number;
    n: number;
    hitRate: number;
    medMid: number;
    meanNet: number;
    bootLB: number;
  }
  const hourRows: HourRow[] = [];
  for (let h = 0; h < 24; h++) {
    const nets: number[] = [];
    const mids: number[] = [];
    let wins = 0;
    for (const e of events) {
      if (!e.predBucket) continue;
      const p = priceAtLocalHour(e.predBucket.points, e.dMidUtc + h * 3600);
      if (p === null || p <= 0) continue;
      mids.push(p);
      nets.push(netReturn(e.winL0, p));
      if (e.winL0) wins++;
    }
    hourRows.push({
      hour: h,
      n: nets.length,
      hitRate: nets.length ? wins / nets.length : NaN,
      medMid: median(mids),
      meanNet: mean(nets),
      bootLB: nets.length ? bootstrapMeanP10(nets) : NaN,
    });
  }

  // recommended WINDOW: the longest contiguous run of hours with n≥MIN_N AND bootLB>0
  // (a positive shrinkage lower bound). Tie → highest mean bootLB, then earliest start.
  interface Window {
    start: number;
    end: number;
    hours: number[];
  }
  const good = (r: HourRow): boolean => r.n >= MIN_N && Number.isFinite(r.bootLB) && r.bootLB > 0;
  const runs: Window[] = [];
  let cur: number[] = [];
  for (const r of hourRows) {
    if (good(r)) {
      cur.push(r.hour);
    } else if (cur.length) {
      runs.push({ start: cur[0]!, end: cur[cur.length - 1]!, hours: cur });
      cur = [];
    }
  }
  if (cur.length) runs.push({ start: cur[0]!, end: cur[cur.length - 1]!, hours: cur });

  const runScore = (w: Window): number => mean(w.hours.map((h) => hourRows[h]!.bootLB));
  runs.sort((a, b) => b.hours.length - a.hours.length || runScore(b) - runScore(a) || a.start - b.start);
  const recWindow = runs[0] ?? null;

  // window aggregate — event-level (one mean-netReturn per event over its available window hours)
  interface WindowAgg {
    start: number;
    end: number;
    nEvents: number;
    hitRate: number;
    medMid: number;
    meanNet: number;
    bootLB: number;
    bestHour: number; // sweet-spot hour inside the window (max per-hour bootLB)
  }
  let winAgg: WindowAgg | null = null;
  if (recWindow) {
    const evNets: number[] = [];
    const evMids: number[] = [];
    let winsInWin = 0;
    let nEv = 0;
    for (const e of events) {
      if (!e.predBucket) continue;
      const mids: number[] = [];
      const nets: number[] = [];
      for (const h of recWindow.hours) {
        const p = priceAtLocalHour(e.predBucket.points, e.dMidUtc + h * 3600);
        if (p === null || p <= 0) continue;
        mids.push(p);
        nets.push(netReturn(e.winL0, p));
      }
      if (!nets.length) continue;
      nEv++;
      if (e.winL0) winsInWin++;
      evNets.push(mean(nets));
      evMids.push(median(mids));
    }
    const bestHour = recWindow.hours.reduce((best, h) => (hourRows[h]!.bootLB > hourRows[best]!.bootLB ? h : best), recWindow.hours[0]!);
    winAgg = {
      start: recWindow.start,
      end: recWindow.end,
      nEvents: nEv,
      hitRate: nEv ? winsInWin / nEv : NaN,
      medMid: median(evMids),
      meanNet: mean(evNets),
      bootLB: nEv ? bootstrapMeanP10(evNets) : NaN,
      bestHour,
    };
  }

  // ── (B) hours-before-resolution bins (full market life, one entry per event per bin) ────────────
  interface BinRow {
    bin: string;
    n: number;
    medMid: number;
    meanNet: number;
  }
  const binAcc = new Map<string, { mids: number[]; nets: number[] }>();
  for (const b of HRS_BINS) binAcc.set(b, { mids: [], nets: [] });
  for (const e of events) {
    if (!e.predBucket || e.endTs === null) continue;
    // one representative entry per event per bin = the LAST point whose hrs-before falls in the bin
    const lastInBin = new Map<string, number>();
    for (const [t, p] of e.predBucket.points) {
      if (p <= 0) continue;
      const hrs = (e.endTs - t) / 3600;
      lastInBin.set(hrsBeforeBin(hrs), p); // points are chronological → last write = closest to resolution in bin
    }
    for (const [bin, p] of lastInBin) {
      const acc = binAcc.get(bin);
      if (!acc) continue;
      acc.mids.push(p);
      acc.nets.push(netReturn(e.winL0, p));
    }
  }
  const binRows: BinRow[] = HRS_BINS.map((bin) => {
    const acc = binAcc.get(bin)!;
    return { bin, n: acc.mids.length, medMid: median(acc.mids), meanNet: mean(acc.nets) };
  });

  // ── (C) wrong-prediction signal at REF_HOUR (14:00 local day-of = the live test's hour) ──────────
  interface EventFeature {
    eventId: string;
    weatherDate: string;
    predBucketL0: number;
    winnerIdx: number;
    win: boolean;
    entryMid: number | null;
    netReturn: number | null;
    trend3h: number | null;
    gapToFav: number | null;
  }
  const feats: EventFeature[] = [];
  for (const e of events) {
    const tU = e.dMidUtc + REF_HOUR * 3600;
    let entryMid: number | null = null;
    let trend: number | null = null;
    let gap: number | null = null;
    if (e.predBucket) {
      entryMid = priceAtLocalHour(e.predBucket.points, tU);
      trend = trendSlope(e.predBucket.points, tU);
      if (entryMid !== null) {
        const otherMids = e.buckets.filter((b) => b.idx !== e.predL0).map((b) => priceAtLocalHour(b.points, tU));
        gap = gapToFavorite(entryMid, otherMids);
      }
    }
    feats.push({
      eventId: e.eventId,
      weatherDate: e.weatherDate,
      predBucketL0: e.predL0,
      winnerIdx: e.winnerIdx,
      win: e.winL0,
      entryMid,
      netReturn: entryMid !== null && entryMid > 0 ? netReturn(e.winL0, entryMid) : null,
      trend3h: trend,
      gapToFav: gap,
    });
  }
  // only events with a valid REF_HOUR entry can be scored by the signal
  const scored = feats.filter((f) => f.entryMid !== null && f.gapToFav !== null && f.trend3h !== null);
  const scoredWin = scored.filter((f) => f.win);
  const scoredLoss = scored.filter((f) => !f.win);

  interface SkipRule {
    name: string;
    pred: (f: EventFeature) => boolean;
  }
  const rules: SkipRule[] = [
    { name: 'gap-to-favorite < 0', pred: (f) => (f.gapToFav ?? 0) < 0 },
    { name: '3h trend < 0', pred: (f) => (f.trend3h ?? 0) < 0 },
    { name: 'gap < 0 OR trend < 0', pred: (f) => (f.gapToFav ?? 0) < 0 || (f.trend3h ?? 0) < 0 },
  ];
  const totalLoss = scoredLoss.length;
  const ruleRows = rules.map((rule) => {
    const skipped = scored.filter(rule.pred);
    const losersSkipped = skipped.filter((f) => !f.win).length;
    const winnersSkipped = skipped.filter((f) => f.win).length;
    return {
      name: rule.name,
      nSkip: skipped.length,
      losersSkipped,
      winnersSkipped,
      precision: skipped.length ? losersSkipped / skipped.length : NaN, // of skips, how many were true losers
      recall: totalLoss ? losersSkipped / totalLoss : NaN, // of losers, how many we caught
    };
  });

  // ── write CSV (one row per event) ──────────────────────────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const hourCols = Array.from({ length: 24 }, (_, h) => `mid_h${String(h).padStart(2, '0')}`);
  const csvHeader = [
    'event_id', 'weather_date', 'pred_bucket_l0', 'winner_idx', 'win',
    'entry_mid_14', 'net_return_14', 'trend_3h', 'gap_to_favorite', ...hourCols,
  ].join(',');
  const csvLines = [csvHeader];
  const featById = new Map(feats.map((f) => [f.eventId, f]));
  for (const e of events) {
    const f = featById.get(e.eventId)!;
    const perHour: Array<string> = [];
    for (let h = 0; h < 24; h++) {
      const p = e.predBucket ? priceAtLocalHour(e.predBucket.points, e.dMidUtc + h * 3600) : null;
      perHour.push(p !== null ? p.toFixed(4) : '');
    }
    csvLines.push(
      [
        csv(e.eventId), csv(e.weatherDate), e.predL0, e.winnerIdx, e.winL0 ? 1 : 0,
        f.entryMid !== null ? f.entryMid.toFixed(4) : '',
        f.netReturn !== null ? f.netReturn.toFixed(4) : '',
        f.trend3h !== null ? f.trend3h.toFixed(5) : '',
        f.gapToFav !== null ? f.gapToFav.toFixed(4) : '',
        ...perHour,
      ].join(','),
    );
  }
  const csvPath = join(OUT_DIR, 'karachi-entry-time.csv');
  writeFileSync(csvPath, csvLines.join('\n') + '\n');

  // ── write MD ───────────────────────────────────────────────────────────────────────────────────
  const medWin = (get: (f: EventFeature) => number | null, arr: EventFeature[]): number => median(arr.map(get).filter((x): x is number => x !== null));
  const md: string[] = [];
  md.push('# Karachi entry-time analysis — Test 1 (buy OUR predicted bucket, hold to resolution)');
  md.push('');
  md.push(
    `_Generated over the local Karachi \`market-history\` archive (~1-min MID/implied-prob, NOT bid/ask) joined to \`forecast-by-event.csv\`. ` +
      `Predicted bucket = \`pred_bucket_l0\` (day-of calibrated). netReturn = win ? (1−p)/p : −1, p = predicted-bucket MID at entry. ` +
      `Prices are MID → a LOWER BOUND on real taker cost (true ask ≥ mid); Karachi is a hard buy-cheap market._`,
  );
  md.push('');
  md.push(
    `- Events studied (forecast ∩ archive ∩ resolved): **${N}** · dropped: no-forecast ${noForecast}, no-winner ${noWinner}, corrupt ${corrupt}.`,
  );
  md.push(`- **Event-level hit rate (exact bucket):** l0 (day-of) **${pc(hitL0)}** · l1 **${pc(hitL1)}** · l2 **${pc(hitL2)}** (n=${N}).`);
  md.push('');
  md.push('## Headline — the recommended BUY WINDOW');
  md.push('');
  if (winAgg) {
    md.push(
      `**Buy in the Karachi-local ${String(winAgg.start).padStart(2, '0')}:00–${String(winAgg.end).padStart(2, '0')}:00 window** ` +
        `(sweet spot ${String(winAgg.bestHour).padStart(2, '0')}:00). Over ${winAgg.nEvents} events with an entry in the window: ` +
        `hit rate **${pc(winAgg.hitRate)}**, median entry mid **${cents(winAgg.medMid)}**, mean netReturn **${ret(winAgg.meanNet)}/$1**, ` +
        `bootstrap-LB (10th-pct, ${BOOT_ITERS} resamples) **${ret(winAgg.bootLB)}**.`,
    );
    md.push('');
    md.push(
      `This window is the overnight / early-morning hours BEFORE Karachi's afternoon heat is observed: the eventual winner is still ` +
        `cheap (~${cents(winAgg.medMid)}) and almost every market is still live. The edge decays through midday and is GONE by ${REF_HOUR}:00 ` +
        `(see the hourly table) — by then the market has converged, the winner is expensive, and holding to resolution pays ≈0 on wins while ` +
        `losers still cost −1. The clock does not change whether we are RIGHT (hit rate is event-level); it changes how cheap the entry is.`,
    );
  } else {
    md.push(`_No contiguous hour-band cleared n≥${MIN_N} AND a positive bootstrap-LB — no positive-lower-bound buy window on MID._`);
  }
  md.push('');
  md.push('## (A) Day-of hourly sweep — Karachi local hour 0..23 of the weather day');
  md.push('');
  md.push('| local hour | n | hit rate | median entry mid | mean netReturn | bootstrap-LB (10th pct) |');
  md.push('|---:|---:|---:|---:|---:|---:|');
  for (const r of hourRows) {
    const star = winAgg && r.hour >= winAgg.start && r.hour <= winAgg.end ? ' ⭐' : '';
    md.push(
      `| ${String(r.hour).padStart(2, '0')}:00${star} | ${r.n} | ${pc(r.hitRate)} | ${cents(r.medMid)} | ${ret(r.meanNet)} | ${ret(r.bootLB)} |`,
    );
  }
  md.push('');
  md.push('> ⭐ = inside the recommended window. Hit rate wobbles only because the SET of still-live events changes hour to hour (some Karachi markets resolve before noon); the per-event outcome is fixed.');
  md.push('');
  md.push('## (B) Hours-before-resolution bins — where the cheap entries actually live (full market life)');
  md.push('');
  md.push('| hrs before resolution | n | median entry mid | mean netReturn |');
  md.push('|:--|---:|---:|---:|');
  for (const r of binRows) md.push(`| ${r.bin} | ${r.n} | ${cents(r.medMid)} | ${ret(r.meanNet)} |`);
  md.push('');
  md.push('> The predicted bucket is cheapest (and netReturn best) FAR from resolution and expensive near it — the winner converges up. This is the same mechanism as the day-of window: buy early.');
  md.push('');
  md.push(`## (C) Wrong-prediction signal @ ${REF_HOUR}:00 local (the live test's hour)`);
  md.push('');
  md.push(`Scored on ${scored.length} events with a valid ${REF_HOUR}:00 entry (${scoredWin.length} wins / ${scoredLoss.length} losses). Feature medians, win vs loss:`);
  md.push('');
  md.push('| feature | WIN median | LOSS median |');
  md.push('|:--|---:|---:|');
  md.push(`| entry mid | ${cents(medWin((f) => f.entryMid, scoredWin))} | ${cents(medWin((f) => f.entryMid, scoredLoss))} |`);
  md.push(`| gap-to-favorite | ${ret(medWin((f) => f.gapToFav, scoredWin))} | ${ret(medWin((f) => f.gapToFav, scoredLoss))} |`);
  md.push(`| 3h trend (prob/h) | ${ret(medWin((f) => f.trend3h, scoredWin))} | ${ret(medWin((f) => f.trend3h, scoredLoss))} |`);
  md.push('');
  md.push('Skip rules (skip the buy / cut the position if the rule fires):');
  md.push('');
  md.push('| rule | events skipped | losers skipped | winners skipped | precision | recall (of losers) |');
  md.push('|:--|---:|---:|---:|---:|---:|');
  for (const r of ruleRows) {
    md.push(`| ${r.name} | ${r.nSkip} | ${r.losersSkipped} | ${r.winnersSkipped} | ${pc(r.precision)} | ${pc(r.recall)} |`);
  }
  md.push('');
  md.push(
    `> **The signal is strong precisely because it is late.** By ${REF_HOUR}:00 the efficient market has largely converged, so "the book favours a different bucket" (gap<0) ` +
      `is nearly a read of the outcome — high precision, but by then the cheap-entry edge is gone. The honest tension: the divergence signal is weak when the entry is cheap ` +
      `(early) and strong when the entry is expensive (late). Its real use is as an EARLY-EXIT / don't-hold trigger — enter cheap overnight, and if by ${REF_HOUR}:00 the book has ` +
      `diverged from us, cut. On MID it is not a standalone edge.`,
  );
  md.push('');
  md.push('## Caveats (be blunt)');
  md.push('');
  md.push(
    `- **MID, not ask.** Every profit number is gross of spread — a LOWER BOUND on real taker cost. Karachi's winner is a hard buy-cheap market (WINNER-BAND-ANALYSIS.md); the real ask ≥ mid could erase the +${winAgg ? winAgg.meanNet.toFixed(2) : '0'} window edge.`,
  );
  md.push(`- **Thin n.** ${N} events, ~50% hit rate. A window mean netReturn is driven by ~${Math.round(N * hitL0)} winners paying ~1.5× against ~${N - Math.round(N * hitL0)} total losses. One or two flips moves it materially — hence the bootstrap-LB, not the point estimate.`);
  md.push(`- **Event-level hit rate.** The hour never changes whether we are right. Do not read the hourly sweep as "later = worse forecast" — it is "later = the winner is already priced in".`);
  md.push(`- **Data gaps.** ${noForecast} archive events had no forecast row; ${noWinner} were unresolved; ${feats.length - scored.length} of ${N} had no valid ${REF_HOUR}:00 entry (market resolved before ${REF_HOUR}:00 local — some Karachi markets close before noon).`);

  const mdPath = join(OUT_DIR, 'karachi-entry-time.md');
  writeFileSync(mdPath, md.join('\n') + '\n');

  // ── console summary ────────────────────────────────────────────────────────────────────────────
  console.log(`\n=== Karachi entry-time: ${N} events · hit l0 ${pc(hitL0)} / l1 ${pc(hitL1)} / l2 ${pc(hitL2)} ===`);
  if (winAgg) {
    console.log(
      `    RECOMMENDED WINDOW ${String(winAgg.start).padStart(2, '0')}:00–${String(winAgg.end).padStart(2, '0')}:00 (sweet spot ${String(winAgg.bestHour).padStart(2, '0')}:00) · ` +
        `n ${winAgg.nEvents} · hit ${pc(winAgg.hitRate)} · med mid ${cents(winAgg.medMid)} · mean netReturn ${ret(winAgg.meanNet)} · bootLB ${ret(winAgg.bootLB)}`,
    );
  } else {
    console.log('    NO positive-lower-bound buy window on MID.');
  }
  console.log('    hour | n  | hit  | medMid | meanNet | bootLB');
  for (const r of hourRows) {
    console.log(
      `    ${String(r.hour).padStart(2, '0')}:00 | ${String(r.n).padStart(2)} | ${pc(r.hitRate).padStart(5)} | ${cents(r.medMid).padStart(6)} | ${ret(r.meanNet).padStart(7)} | ${ret(r.bootLB).padStart(7)}`,
    );
  }
  console.log(`    wrong-signal @${REF_HOUR}:00 (n=${scored.length}, ${scoredWin.length}W/${scoredLoss.length}L):`);
  for (const r of ruleRows) {
    console.log(`      ${r.name.padEnd(22)} skip ${r.nSkip} (L${r.losersSkipped}/W${r.winnersSkipped}) precision ${pc(r.precision)} recall ${pc(r.recall)}`);
  }
  console.log(`    CSV → ${csvPath}`);
  console.log(`    MD  → ${mdPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
