/**
 * scripts/research/karachi-entry-exit — the operator's re-test of the KARACHI buy-the-predicted-bucket
 * play with (a) an EARLIER / cheaper ENTRY and (b) real EXIT points (TP / SL / hold), to find the
 * entry+exit that replaces the negative-EV 14:00 buy-and-hold.
 *
 * WHY this exists (read karachi-entry-time.ts + out/WINNER-BAND-ANALYSIS.md first):
 *   - karachi-entry-time found: buying our day-of predicted bucket (pred_bucket_l0) at 14:00 Karachi and
 *     HOLDING to resolution is negative-EV (by 14:00 the winner is already priced ~88¢, mean net ≈ −0.37/$1
 *     on MID). The cheap-entry edge is overnight (01–05h, winner ~41¢) but only breakeven on hold.
 *   - the winner-band analysis showed the eventual winner dips to a median 12.5¢ (traded <18¢ in 66%),
 *     median intraday HIGH 100¢, and even LOSING neighbours spike to a median max of 28–49¢ before dying.
 *   → so: move the entry earlier/cheaper AND add a take-profit that harvests the intraday spike instead of
 *     holding a converged (or dying) bucket to resolution.
 *
 * Data (all local, read-only — same join as karachi-entry-time.ts):
 *   - our forecast:  out/forecast-by-event.csv  (filter fc_city==='karachi'; pred_bucket_l0 = the day-of
 *     calibrated predicted market-bucket idx — the bucket a day-of buy would act on). 49 rows.
 *   - price + outcome: out/market-history/karachi/{weatherDate}__{eventId}.json  (~1-min MID / implied-prob
 *     per bucket, resolvedOutcome baked in). Join by eventId. Winner = the bucket with resolvedOutcome==='win'.
 *   - Karachi = Asia/Karachi = UTC+5, no DST.
 *
 * The GRID (BUY the pred_bucket_l0 bucket, then EXIT per rule; walk ticks AFTER entry, no look-ahead, break
 * at first firing):
 *   ENTRY rules (two families):
 *     1. FIXED Karachi-local hour h ∈ {1,2,3,4,5,8,11,14}: entry = the pred bucket's last mid within 90min of
 *        that local hour (priceAtLocalHour idiom). 14 = the negative-EV baseline; 1–5 = the "move earlier" test.
 *     2. FIRST-CHEAP: entry = the FIRST tick (chronological) where the pred bucket's mid ≤ cap, cap ∈
 *        {0.10,0.12,0.15,0.18,0.25}. Naturally enters early/cheap; CONDITIONS the sample (hitRate varies).
 *   EXIT rules (each applied to every entry rule):
 *     1. HOLD to resolution (win→proceeds 1, lose→0).
 *     2. TP-only: sell when mid ≥ tp, tp ∈ {0.30,0.50,0.70}; else hold to resolution.
 *     3. TP+SL: the tp above + SL sell when mid ≤ sl, sl ∈ {0.05,0.10}; else hold to resolution.
 *   netReturn per $1 staked: buy 1/entry shares at `entry`; a TP/SL exit at observed mid x → proceeds x/entry
 *     → netReturn = x/entry − 1; a HOLD exit → win ? (1/entry − 1) : −1. ALL on MID (see caveats — MID is a
 *     LOWER BOUND on the real taker ask, and a TP/SL SELL fills into the BID < mid, so TP numbers are OPTIMISTIC).
 *
 * RECOMMENDATION: the single best (entry × exit) config by bootstrap-LB (10th-pct, seed 42, alpha 0.2) among
 *   configs with nEntered ≥ 30. The 14:00-hold baseline is always shown for contrast.
 *
 * Read-only. Run: pnpm tsx scripts/research/karachi-entry-exit.ts
 * Output: out/karachi-entry-exit.md  +  out/karachi-entry-exit.csv
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
/** 90-min look-back window for a valid fixed-hour entry (matches karachi-entry-time). */
const ENTRY_WINDOW_SEC = 90 * 60;
/** Bootstrap resamples for the shrinkage lower bound. */
const BOOT_ITERS = 2000;
const BOOT_SEED = 42;
/** Min entered events for a config to be recommendable (spec). */
const MIN_ENTERED = 30;

/** Fixed Karachi-local entry hours (14 = baseline; 1–5 = the "move earlier" test). */
const FIXED_HOURS = [1, 2, 3, 4, 5, 8, 11, 14] as const;
/** First-cheap entry caps (mid ≤ cap). */
const CHEAP_CAPS = [0.1, 0.12, 0.15, 0.18, 0.25] as const;
/** Take-profit levels (sell when mid ≥ tp). */
const TPS = [0.3, 0.5, 0.7] as const;
/** Stop-loss levels (sell when mid ≤ sl). */
const SLS = [0.05, 0.1] as const;

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

/** An entry hit: the chosen tick's index into the (time-sorted) points array, its epoch and its mid. */
export interface EntryHit {
  i: number;
  t: number;
  price: number;
}

/**
 * FIXED-hour entry: the LAST point with t ≤ targetUtc AND t ≥ targetUtc − windowSec (with its index into
 * `points`). null = no valid entry (thin/expired book at that hour). `points` MUST be time-ascending.
 */
export function findFixedEntry(
  points: Array<[number, number]>,
  targetUtc: number,
  windowSec: number = ENTRY_WINDOW_SEC,
): EntryHit | null {
  let hit: EntryHit | null = null;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!pt) continue;
    const [t, p] = pt;
    if (t <= targetUtc && t >= targetUtc - windowSec) hit = { i, t, price: p };
  }
  return hit;
}

/**
 * FIRST-CHEAP entry: the FIRST tick (chronological) with 0 < mid ≤ cap (with its index). null = the bucket
 * never traded at or below `cap`. `points` MUST be time-ascending. The 0-guard excludes the archive's 0.0005
 * end-of-life sentinel from being a valid buy; in practice the mid walks down gradually from ~0.5 so the first
 * crossing lands near `cap`, not at the floor.
 */
export function findFirstCheapEntry(points: Array<[number, number]>, cap: number): EntryHit | null {
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    if (!pt) continue;
    const [t, p] = pt;
    if (p > 0 && p <= cap) return { i, t, price: p };
  }
  return null;
}

export type ExitReason = 'tp' | 'sl' | 'hold-win' | 'hold-lose';
export interface ExitResult {
  reason: ExitReason;
  exitPrice: number;
  netReturn: number;
}

/**
 * Walk `ticksAfter` (the pred bucket's points STRICTLY AFTER the entry tick, time-ascending) applying the exit
 * rule in time order, NO look-ahead, break at the FIRST firing tick:
 *   - tp defined & mid ≥ tp  → sell at that mid  (reason 'tp')
 *   - sl defined & mid ≤ sl  → sell at that mid  (reason 'sl')
 * No tick fires → HOLD to resolution: win → proceeds 1 (reason 'hold-win'), lose → proceeds 0 (reason 'hold-lose').
 * netReturn = exitPrice/entry − 1. `entry` MUST be > 0 (guarded at the call site). tp is checked before sl, but
 * the grid's tp (≥0.30) and sl (≤0.10) can never both fire on one tick, so order is immaterial in practice.
 */
export function walkExit(
  entry: number,
  win: boolean,
  ticksAfter: Array<[number, number]>,
  rule: { tp?: number; sl?: number },
): ExitResult {
  for (const pt of ticksAfter) {
    if (!pt) continue;
    const mid = pt[1];
    if (rule.tp !== undefined && mid >= rule.tp) return { reason: 'tp', exitPrice: mid, netReturn: mid / entry - 1 };
    if (rule.sl !== undefined && mid <= rule.sl) return { reason: 'sl', exitPrice: mid, netReturn: mid / entry - 1 };
  }
  const exitPrice = win ? 1 : 0;
  return { reason: win ? 'hold-win' : 'hold-lose', exitPrice, netReturn: exitPrice / entry - 1 };
}

/** Shrinkage lower bound: the seeded percentile bootstrap's 10th-pct of the resample means (reuses core). */
export function bootstrapMeanP10(values: number[], seed: number = BOOT_SEED, iters: number = BOOT_ITERS): number {
  return bootstrapMeanCi(values, { alpha: 0.2, iters, seed }).lo; // alpha 0.2 → lo = quantile(means, 0.1)
}

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
  predL0: number;
  winnerIdx: number;
  win: boolean; // pred_bucket_l0 === winnerIdx (event-level, fixed)
  predBucket: Bucket | undefined; // the L0 predicted bucket (may be absent from this market), points time-sorted
}

/** Parse the Karachi rows of forecast-by-event.csv → eventId → pred_bucket_l0. */
export function parseForecastCsv(text: string): Map<string, number> {
  const lines = text.trim().split(/\r?\n/);
  const header = (lines[0] ?? '').split(',');
  const col = (name: string): number => header.indexOf(name);
  const iId = col('event_id');
  const iCity = col('fc_city');
  const iL0 = col('pred_bucket_l0');
  const out = new Map<string, number>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c[iCity] !== 'karachi') continue;
    const id = c[iId];
    if (!id) continue;
    out.set(id, Number(c[iL0]));
  }
  return out;
}

// ── grid config shapes ──────────────────────────────────────────────────────────────────────────
type EntryRule =
  | { kind: 'fixed'; hour: number; id: string; label: string }
  | { kind: 'cheap'; cap: number; id: string; label: string };
interface ExitRule {
  id: string;
  label: string;
  rule: { tp?: number; sl?: number };
}
interface PerEventResult {
  eventId: string;
  weatherDate: string;
  predBucket: number;
  winnerIdx: number;
  win: boolean;
  entryIdx: number;
  entryT: number;
  entryLocalHour: number;
  entryPrice: number;
  reason: ExitReason;
  exitPrice: number;
  netReturn: number;
}
interface ConfigRow {
  entry: EntryRule;
  exit: ExitRule;
  nEntered: number;
  wins: number;
  hitRate: number;
  medEntry: number;
  medEntryHour: number; // median Karachi-local entry hour (negative = before the weather day; ~open ≈ −40h)
  meanNet: number;
  bootLB: number;
  nTp: number;
  nSl: number;
  nHoldWin: number;
  nHoldLose: number;
  perEvent: PerEventResult[];
}

function buildEntryRules(): EntryRule[] {
  const fixed: EntryRule[] = FIXED_HOURS.map((h) => ({
    kind: 'fixed',
    hour: h,
    id: `h${String(h).padStart(2, '0')}`,
    label: `${String(h).padStart(2, '0')}:00 local`,
  }));
  const cheap: EntryRule[] = CHEAP_CAPS.map((cap) => ({
    kind: 'cheap',
    cap,
    id: `cheap${Math.round(cap * 100)}`,
    label: `first ≤ ${cents(cap)}`,
  }));
  return [...fixed, ...cheap];
}

function buildExitRules(): ExitRule[] {
  const hold: ExitRule = { id: 'hold', label: 'hold', rule: {} };
  const tpOnly: ExitRule[] = TPS.map((tp) => ({ id: `tp${Math.round(tp * 100)}`, label: `TP ${cents(tp)}`, rule: { tp } }));
  const tpSl: ExitRule[] = TPS.flatMap((tp) =>
    SLS.map((sl) => ({
      id: `tp${Math.round(tp * 100)}_sl${Math.round(sl * 100)}`,
      label: `TP ${cents(tp)} / SL ${cents(sl)}`,
      rule: { tp, sl },
    })),
  );
  return [hold, ...tpOnly, ...tpSl];
}

/** Resolve an entry rule to its hit for one event (or null = no valid entry). */
function resolveEntry(entry: EntryRule, e: EventRec): EntryHit | null {
  if (!e.predBucket) return null;
  const pts = e.predBucket.points;
  const hit = entry.kind === 'fixed' ? findFixedEntry(pts, e.dMidUtc + entry.hour * 3600) : findFirstCheapEntry(pts, entry.cap);
  if (!hit || hit.price <= 0) return null;
  return hit;
}

/** Evaluate one (entry × exit) config over all events. */
function evalConfig(entry: EntryRule, exit: ExitRule, events: EventRec[]): ConfigRow {
  const perEvent: PerEventResult[] = [];
  for (const e of events) {
    if (!e.predBucket) continue;
    const hit = resolveEntry(entry, e);
    if (!hit) continue;
    const ticksAfter = e.predBucket.points.slice(hit.i + 1);
    const ex = walkExit(hit.price, e.win, ticksAfter, exit.rule);
    perEvent.push({
      eventId: e.eventId,
      weatherDate: e.weatherDate,
      predBucket: e.predL0,
      winnerIdx: e.winnerIdx,
      win: e.win,
      entryIdx: hit.i,
      entryT: hit.t,
      entryLocalHour: (hit.t - e.dMidUtc) / 3600,
      entryPrice: hit.price,
      reason: ex.reason,
      exitPrice: ex.exitPrice,
      netReturn: ex.netReturn,
    });
  }
  const nets = perEvent.map((r) => r.netReturn);
  const entries = perEvent.map((r) => r.entryPrice);
  const wins = perEvent.filter((r) => r.win).length;
  return {
    entry,
    exit,
    nEntered: perEvent.length,
    wins,
    hitRate: perEvent.length ? wins / perEvent.length : NaN,
    medEntry: median(entries),
    medEntryHour: median(perEvent.map((r) => r.entryLocalHour)),
    meanNet: mean(nets),
    bootLB: perEvent.length ? bootstrapMeanP10(nets) : NaN,
    nTp: perEvent.filter((r) => r.reason === 'tp').length,
    nSl: perEvent.filter((r) => r.reason === 'sl').length,
    nHoldWin: perEvent.filter((r) => r.reason === 'hold-win').length,
    nHoldLose: perEvent.filter((r) => r.reason === 'hold-lose').length,
    perEvent,
  };
}

const exitMix = (r: ConfigRow): string => `tp ${r.nTp} / sl ${r.nSl} / hold-W ${r.nHoldWin} / hold-L ${r.nHoldLose}`;

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
    const predL0 = fc.get(String(ev.eventId));
    if (predL0 === undefined || !Number.isFinite(predL0)) {
      noForecast++;
      continue;
    }
    const winB = ev.buckets.find((b) => b.resolvedOutcome === 'win');
    if (!winB) {
      noWinner++;
      continue;
    }
    const predBucket = ev.buckets.find((b) => b.idx === predL0);
    // defensively time-sort each bucket's points so slice-after-entry is guaranteed look-ahead-free
    if (predBucket) predBucket.points = [...predBucket.points].sort((a, b) => a[0] - b[0]);
    events.push({
      eventId: String(ev.eventId),
      weatherDate: ev.targetDate,
      dMidUtc: localHourToUtc(ev.targetDate, 0),
      predL0,
      winnerIdx: winB.idx,
      win: predL0 === winB.idx,
      predBucket,
    });
  }

  const N = events.length;
  if (N === 0) throw new Error('no joined+resolved Karachi events — nothing to analyse');
  const hitOverall = events.filter((e) => e.win).length / N;

  // ── evaluate the full grid ──────────────────────────────────────────────────────────────────────
  const entryRules = buildEntryRules();
  const exitRules = buildExitRules();
  const grid: ConfigRow[] = [];
  for (const entry of entryRules) for (const exit of exitRules) grid.push(evalConfig(entry, exit, events));

  // baseline: 14:00 entry + hold
  const baseline =
    grid.find((r) => r.entry.kind === 'fixed' && r.entry.hour === 14 && r.exit.id === 'hold') ?? null;

  // recommendation: max bootstrap-LB among configs with nEntered ≥ MIN_ENTERED
  const eligible = grid.filter((r) => r.nEntered >= MIN_ENTERED && Number.isFinite(r.bootLB));
  eligible.sort((a, b) => b.bootLB - a.bootLB || b.meanNet - a.meanNet || a.nEntered - b.nEntered);
  const rec = eligible[0] ?? null;

  // the SAME cheap entry but HOLD-to-resolution (no exit spread) — the honest robustness comparator to the
  // bootLB-max TP config, since HOLD settles at $1/$0 with zero exit spread while the TP sells into the bid.
  const recHold =
    rec && rec.exit.id !== 'hold'
      ? grid.find((r) => r.entry.id === rec.entry.id && r.exit.id === 'hold') ?? null
      : null;

  // top-12 by bootstrap-LB (across the whole grid, still note nEntered so thin configs are visible)
  const ranked = [...grid].filter((r) => Number.isFinite(r.bootLB)).sort((a, b) => b.bootLB - a.bootLB || b.meanNet - a.meanNet);
  const top = ranked.slice(0, 12);

  // ── write CSV (per-event rows for the RECOMMENDED config) ─────────────────────────────────────────
  mkdirSync(OUT_DIR, { recursive: true });
  const csvHeader = [
    'event_id', 'weather_date', 'pred_bucket', 'winner_idx', 'win',
    'entry_idx', 'entry_epoch', 'entry_local_hour', 'entry_price', 'exit_reason', 'exit_price', 'net_return',
  ].join(',');
  const csvLines = [csvHeader];
  if (rec) {
    for (const r of rec.perEvent) {
      csvLines.push(
        [
          csv(r.eventId), csv(r.weatherDate), r.predBucket, r.winnerIdx, r.win ? 1 : 0,
          r.entryIdx, r.entryT, r.entryLocalHour.toFixed(2), r.entryPrice.toFixed(4),
          csv(r.reason), r.exitPrice.toFixed(4), r.netReturn.toFixed(4),
        ].join(','),
      );
    }
  }
  const csvPath = join(OUT_DIR, 'karachi-entry-exit.csv');
  writeFileSync(csvPath, csvLines.join('\n') + '\n');

  // ── write MD ───────────────────────────────────────────────────────────────────────────────────
  const configLabel = (r: ConfigRow): string => `${r.entry.label} → ${r.exit.label}`;
  const gridLine = (r: ConfigRow): string =>
    `| ${r.entry.label} | ${r.exit.label} | ${r.nEntered} | ${pc(r.hitRate)} | ${cents(r.medEntry)} | ${ret(r.meanNet)} | ${ret(r.bootLB)} | ${exitMix(r)} |`;

  const md: string[] = [];
  md.push('# Karachi entry+exit re-test — buy the predicted bucket, EARLIER entry + real TP/SL exits');
  md.push('');
  md.push(
    `_Generated over the local Karachi \`market-history\` archive (~1-min **MID** / implied-prob, NOT bid/ask) joined to ` +
      `\`forecast-by-event.csv\`. Predicted bucket = \`pred_bucket_l0\` (day-of calibrated). Buy 1/entry shares at the entry mid; ` +
      `a TP/SL exit sells at the firing tick's mid → netReturn = exitMid/entry − 1; a HOLD exit → win ? (1/entry − 1) : −1. ` +
      `**Every number is MID and gross of spread — a TP/SL SELL fills into the BID (< mid), so TP-exit returns are OPTIMISTIC (see caveats).**_`,
  );
  md.push('');
  md.push(
    `- Events (forecast ∩ archive ∩ resolved): **${N}** · dropped: no-forecast ${noForecast}, no-winner ${noWinner}, corrupt ${corrupt}.`,
  );
  md.push(`- **Event-level hit rate** (pred_bucket_l0 === winner, fixed per event): **${pc(hitOverall)}** (n=${N}).`);
  md.push(`- Grid: **${entryRules.length} entry × ${exitRules.length} exit = ${grid.length} configs.** Recommendation = max bootstrap-LB (10th-pct, ${BOOT_ITERS} resamples, seed ${BOOT_SEED}) among configs with nEntered ≥ ${MIN_ENTERED}.`);
  md.push('');

  // Headline / recommendation
  md.push('## Headline — the RECOMMENDED entry + exit');
  md.push('');
  if (rec) {
    const whenStr =
      rec.medEntryHour < -6
        ? `≈ ${Math.abs(rec.medEntryHour).toFixed(0)} h BEFORE the weather day — i.e. at/near MARKET OPEN, not overnight-of-the-weather-day`
        : `Karachi-local hour ≈ ${rec.medEntryHour.toFixed(1)}`;
    const entryPt =
      rec.entry.kind === 'cheap'
        ? `**Enter:** the FIRST tick where the predicted bucket's mid ≤ **${cents(rec.entry.cap)}** (median realized entry **${cents(rec.medEntry)}**; median entry timing ${whenStr}).`
        : `**Enter:** at Karachi-local **${String(rec.entry.hour).padStart(2, '0')}:00** (median entry mid **${cents(rec.medEntry)}**).`;
    const exitPt =
      rec.exit.rule.tp === undefined
        ? `**Exit:** HOLD to resolution.`
        : rec.exit.rule.sl === undefined
          ? `**Exit:** sell when mid ≥ **${cents(rec.exit.rule.tp)}** (take-profit); else hold to resolution.`
          : `**Exit:** sell when mid ≥ **${cents(rec.exit.rule.tp)}** (TP) or mid ≤ **${cents(rec.exit.rule.sl)}** (stop); else hold to resolution.`;
    md.push(`**${configLabel(rec)}**`);
    md.push('');
    md.push(`- ${entryPt}`);
    md.push(`- ${exitPt}`);
    md.push(
      `- Over **${rec.nEntered}/${N}** entered events: hit rate **${pc(rec.hitRate)}**, median entry **${cents(rec.medEntry)}**, ` +
        `mean netReturn **${ret(rec.meanNet)}/$1**, **bootstrap-LB ${ret(rec.bootLB)}**.`,
    );
    md.push(`- Exit-reason mix: ${exitMix(rec)}.`);
    md.push('');
    const verdict =
      rec.bootLB > 0
        ? `The recommended config has a POSITIVE bootstrap lower bound on MID (${ret(rec.bootLB)}). Read that against the caveats before believing it: the TP-exit leg sells into the bid, and this is the same convergence-bracket mechanic that KILLed at executable spread on the broad 45-city panel.`
        : `**Even the best config has a bootstrap-LB of ${ret(rec.bootLB)} ≤ 0 on MID** — no config in the grid is a credible edge once you shrink for the thin n. Moving the entry earlier and adding a take-profit improves the point estimate but does not clear a positive lower bound.`;
    md.push(`> ${verdict}`);
  } else {
    md.push(`_No config reached nEntered ≥ ${MIN_ENTERED} — nothing recommendable._`);
  }
  md.push('');

  // Baseline contrast
  md.push('## The 14:00 buy-and-hold baseline (what we are trying to beat)');
  md.push('');
  if (baseline) {
    md.push('| config | nEntered | hit rate | median entry | mean netReturn | bootstrap-LB | exit mix |');
    md.push('|:--|---:|---:|---:|---:|---:|:--|');
    md.push(gridLine(baseline));
    md.push('');
    md.push(
      `> The negative-EV starting point: buying our predicted bucket at 14:00 Karachi and holding pays ` +
        `**${ret(baseline.meanNet)}/$1** on MID (median entry ${cents(baseline.medEntry)}) — by mid-afternoon the winner is already priced in, ` +
        `so wins pay ≈0 while losses still cost −1.`,
    );
  } else {
    md.push('_No 14:00-hold baseline computed (no valid 14:00 entries)._');
  }
  md.push('');

  // Grid table (top 12)
  md.push('## Grid — top 12 configs by bootstrap-LB (10th pct)');
  md.push('');
  md.push('| entry | exit | nEntered | hit rate | median entry | mean netReturn | bootstrap-LB | exit mix |');
  md.push('|:--|:--|---:|---:|---:|---:|---:|:--|');
  for (const r of top) md.push(gridLine(r));
  md.push('');
  md.push(
    `> Configs are ranked by the shrinkage LOWER BOUND, not the point estimate. \`nEntered\` varies because FIRST-CHEAP / low-cap ` +
      `entries CONDITION the sample (a bucket that never trades that cheap is skipped) and thin-book hours drop some events — so ` +
      `\`hit rate\` shifts config to config. Only configs with nEntered ≥ ${MIN_ENTERED} are eligible for the recommendation.`,
  );
  md.push('');

  // Narrative tying to Test C
  md.push('## What this says (tying back to the winner-band / Test C distribution)');
  md.push('');
  md.push(
    `- **The mechanism the TP-exit is trying to harvest is real on MID.** The winner-band analysis showed the eventual winner dips to a ` +
      `median **12.5¢** (traded <18¢ in 66% of events) and reaches a median intraday HIGH of **100¢**, while even LOSING neighbours ` +
      `spike to a median max of **28–49¢** before dying. So a cheap first-tick entry + a take-profit into the spike captures both (a) winners ` +
      `converging up and (b) losers that spike before they die — which is exactly why the TP configs beat the 14:00 hold on the MID point estimate.`,
  );
  md.push(
    `- **Moving the entry earlier / cheaper is the load-bearing change, not the exit.** The 14:00 hold is negative because the entry is ` +
      `expensive (winner already ~88¢). A first-cheap entry buys the SAME predicted bucket at a fraction of that, which is what turns the ` +
      `point estimate around; the TP then locks in the spike instead of round-tripping a converged bucket back down.`,
  );
  if (recHold) {
    md.push(
      `- **The exit barely moves the mean — and HOLD dodges the exit spread the TP reintroduces.** The SAME cheap entry with a plain ` +
        `HOLD-to-resolution (\`${recHold.entry.label} → hold\`) is **${ret(recHold.meanNet)}/$1** (bootLB ${ret(recHold.bootLB)}) vs the TP config's ` +
        `**${ret(rec!.meanNet)}** (bootLB ${ret(rec!.bootLB)}) — the take-profit mostly TIGHTENS the distribution (a hair more bootLB from variance ` +
        `reduction), it does not create the edge. This matters operationally: **HOLD settles at exactly $1/$0 with ZERO exit spread**, whereas the ` +
        `TP-exit SELLS into the bid — so the bootLB-max TP config is the LESS robust of the two once you price the real book. If any Karachi cheap-entry ` +
        `play is worth a live paper test, it is the cheap entry + HOLD (entry-spread only), NOT the cheap entry + TP (the killed bracket-exit spread).`,
    );
  }
  const recPositive = rec ? rec.bootLB > 0 : false;
  md.push(
    `- **Is it a real edge on MID?** ${
      recPositive
        ? `The recommended config's bootstrap-LB is positive (${ret(rec!.bootLB)}), so on MID it survives the shrinkage — BUT that is MID, and the TP leg sells into the bid.`
        : `No — the best config's bootstrap-LB is ${rec ? ret(rec.bootLB) : '—'} ≤ 0. The point estimate improves but the lower bound does not clear zero, so on MID this is not yet a credible edge at n=${N}.`
    } The honest read: the improvement is genuine on the tape, but it is one shrink and one spread away from disappearing.`,
  );
  md.push('');

  // Caveats
  md.push('## Caveats (blunt)');
  md.push('');
  md.push(
    `- **MID, not ask — and the TP leg sells into the BID.** Entry uses MID (a LOWER bound on the real taker ask, so entries are slightly ` +
      `cheaper than reality) and every TP/SL SELL is priced at MID (the real bid is BELOW mid, so exits are slightly worse than reality). ` +
      `Net: **the TP-exit returns are OPTIMISTIC** — the true round-trip spread eats into every number here.`,
  );
  md.push(
    `- **The TP-exit IS the convergence-bracket thesis, which was KILLED at executable spread.** Selling the predicted bucket into its ` +
      `intraday spike is precisely the opening-convergence / bracket play that FINDINGS.md falsified on the broad 45-city panel: the edge is ` +
      `REAL frictionless but the taker round-trip spread consumes it (breakeven ≈ ×0.70 of the real spread). A Karachi TP-exit that looks ` +
      `good on MID here is very unlikely to survive the real spread — treat any positive MID number as an UPPER bound, not a green light.`,
  );
  md.push(
    `- **Thin n (${N}), conditioned sub-samples.** Some configs enter far fewer than ${N} events (first-cheap skips buckets that never trade ` +
      `that cheap), and a ~${pc(hitOverall)} hit rate means a handful of winners drive the mean — hence the bootstrap-LB, not the point estimate. ` +
      `One or two flips move any single config materially.`,
  );
  md.push(
    `- **TP fill = the crossing tick's mid, not exactly \`tp\`.** A firing tick's mid can overshoot the threshold (mid ≥ tp), which slightly ` +
      `inflates the TP-exit return above a resting-limit fill at \`tp\`. At ~1-min fidelity the overshoot is small, but it is one more reason ` +
      `the MID numbers lean optimistic.`,
  );
  md.push(
    `- **Analysis only — no capital.** This is a read-only backtest on MID. It recommends where to look, not a trade; the live paper gate ` +
      `(the real bid/ask book) stays the gate of record.`,
  );

  const mdPath = join(OUT_DIR, 'karachi-entry-exit.md');
  writeFileSync(mdPath, md.join('\n') + '\n');

  // ── console summary ────────────────────────────────────────────────────────────────────────────
  console.log(`\n=== Karachi entry+exit: ${N} events · event-level hit ${pc(hitOverall)} · grid ${grid.length} configs ===`);
  if (rec) {
    console.log(
      `    RECOMMENDED  ${configLabel(rec)}  ·  n ${rec.nEntered}/${N} · hit ${pc(rec.hitRate)} · med entry ${cents(rec.medEntry)} · ` +
        `mean net ${ret(rec.meanNet)} · bootLB ${ret(rec.bootLB)}  ·  [${exitMix(rec)}]`,
    );
  } else {
    console.log(`    NO config reached nEntered ≥ ${MIN_ENTERED}.`);
  }
  if (baseline) {
    console.log(
      `    BASELINE 14:00-hold  ·  n ${baseline.nEntered}/${N} · hit ${pc(baseline.hitRate)} · med entry ${cents(baseline.medEntry)} · ` +
        `mean net ${ret(baseline.meanNet)} · bootLB ${ret(baseline.bootLB)}`,
    );
  }
  console.log('    TOP 12 by bootstrap-LB:');
  console.log('      entry                 | exit               |  n | hit   | medEnt | meanNet | bootLB');
  for (const r of top) {
    console.log(
      `      ${r.entry.label.padEnd(21)} | ${r.exit.label.padEnd(18)} | ${String(r.nEntered).padStart(2)} | ${pc(r.hitRate).padStart(5)} | ` +
        `${cents(r.medEntry).padStart(6)} | ${ret(r.meanNet).padStart(7)} | ${ret(r.bootLB).padStart(7)}`,
    );
  }
  console.log(`    CSV → ${csvPath}`);
  console.log(`    MD  → ${mdPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
