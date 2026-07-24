/**
 * scripts/research/convergence-no-side-gate — the CHEAP GATE on the INVERSE bet.
 *
 * THE QUESTION. Every prior run in this project BOUGHT a selected daily-Tmax bucket and lost money. The
 * operator asks the inverse: if the selected bucket is systematically OVERPRICED, is betting NO on it (or
 * simply holding it to resolution when the price is low enough) profitable?
 *
 * THE ARITHMETIC (per share, hold to resolution — no exit path, no look-ahead, no convergence):
 *   YES at ask A:            edge = P − A − f(A)
 *   NO  at (1 − B), B = the YES best bid   (a bid on YES at 0.20 IS an ask on NO at 0.80 — complementary
 *                                           CTF tokens, so the NO book is the exact MIRROR of the YES book)
 *                            edge = B − P − f(1−B)
 *   taker fee f(p) = feeRate·p·(1−p), feeRate 0.05, evaluated at the price paid on THAT side. Note
 *   f(1−B) ≡ f(B) (symmetric) and it is MINIMISED at extreme prices.
 * So NO is +EV iff B > P + f. This script measures P honestly per selection rule and compares it to A and B.
 *
 * ⚠ THE MIRROR IS AN ASSUMPTION, NOT A MEASUREMENT. The archive stores only the YES book. We price the NO
 * leg as 1 − bestBid(YES). negRisk conversion, a separately-quoted NO book, and NO-side depth that is not the
 * YES bid depth could all break it. Every NO number below inherits that assumption — stated, not hidden.
 *
 * POPULATION (this is the part the live Google track cannot give you). We take EVERY selected bucket at the
 * fresh open and hold it NOTIONALLY to resolution — no take-profit, no stop, no early exit. So this pool is
 * UNCONDITIONAL: it is NOT the adversely-selected residue the live track measures (there the likely-winners
 * were sold early as take-profits, leaving a hold-to-resolution pool biased downward, ~5% — a floor, not P).
 *
 * DATA. The opening-captures archive (the only historical real bid/ask book) — both the primary dump and the
 * older pre-07-06 copy, deduped by event_id — joined to public.market_events for the resolved winner index.
 * Read-only, writes ONLY scripts/research/out/. Never imports packages/trading, never places anything.
 *
 * ESTIMATORS. Reused from the repo: wilsonInterval / meanConfidenceInterval / bootstrapMeanCi (core/sim/stats),
 * tCritical95 (core/sim/selector-learn), mulberry32 (core/calibration/scores). Written here: clusteredMeanCi
 * (a byte-mirror of the FROZEN private clusteredCiBy in core/sim/opening-convergence:371 — cluster means → t-CI
 * on C−1 df; it is not exported, so it is mirrored, not re-invented) and clusterBootstrapCi (resample CLUSTERS
 * with replacement — the NO payoff is inverted-tail, risk ~0.9 to win ~0.1, so mean ± z·SE understates it).
 *
 * Run:  pnpm tsx scripts/research/convergence-no-side-gate.ts [--fee-rate 0.05] [--no-old-archive]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { ScriptDb } from '../lib/script-db.ts';
import { mapBucket, type RawBucket, type Resolution } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { OpeningBucket } from '../../packages/core/src/sim/opening-convergence.ts';
import { wilsonInterval, meanConfidenceInterval, bootstrapMeanCi } from '../../packages/core/src/sim/stats.ts';
import { tCritical95 } from '../../packages/core/src/sim/selector-learn.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';

export const SCRIPT = 'convergence-no-side-gate';
export const DEFAULT_FEE_RATE = 0.05;
const OUT_DIR = path.resolve(import.meta.dirname, 'out');
const ARCHIVE_PRIMARY = path.join(OUT_DIR, 'opening-captures-archive');
const ARCHIVE_OLD = path.join(OUT_DIR, 'opening-captures-archive-c96-20260707');

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// cost model — the ONE fee function; both legs pay it as takers at the price paid on that side.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const takerFee = (p: number, feeRate: number): number =>
  Number.isFinite(p) ? feeRate * p * (1 - p) : NaN;

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const spct = (v: number, d = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${pct(v, d)}` : '—');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');
const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, v) => a + v, 0) / xs.length);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// clustered estimators
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Cluster-mean 95% t-CI — a byte-mirror of the FROZEN clusteredCiBy (core/sim/opening-convergence:371):
 * collapse each cluster to its mean, then mean ± t(C−1)·SE over the CLUSTER means. N bets across few weather
 * days is NOT N observations; this is the estimator the §9R-E gate uses and the only honest one here.
 */
export function clusteredMeanCi(
  values: number[],
  keys: string[],
): { mean: number; ciLow: number; ciHigh: number; nClusters: number } {
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < values.length; i++) {
    const k = keys[i] ?? '';
    const arr = byKey.get(k) ?? [];
    arr.push(values[i]!);
    byKey.set(k, arr);
  }
  const cms = [...byKey.values()].map((vs) => mean(vs));
  const C = cms.length;
  if (C === 0) return { mean: NaN, ciLow: NaN, ciHigh: NaN, nClusters: 0 };
  const m = mean(cms);
  const variance = C > 1 ? cms.reduce((a, v) => a + (v - m) ** 2, 0) / (C - 1) : 0;
  const se = Math.sqrt(variance / Math.max(1, C));
  const t = tCritical95(C - 1);
  if (!Number.isFinite(t)) return { mean: m, ciLow: NaN, ciHigh: NaN, nClusters: C };
  return { mean: m, ciLow: m - t * se, ciHigh: m + t * se, nClusters: C };
}

/**
 * Seeded percentile bootstrap over CLUSTERS (resample whole clusters with replacement, then pool). Correct for
 * an inverted-tail payoff under within-cluster correlation — the per-bet bootstrap would treat correlated
 * same-city/same-day bets as independent draws and shrink the interval.
 */
export function clusterBootstrapCi(
  values: number[],
  keys: string[],
  opts: { iters?: number; seed?: number; alpha?: number } = {},
): { mean: number; lo: number; hi: number; nClusters: number } {
  const byKey = new Map<string, number[]>();
  for (let i = 0; i < values.length; i++) {
    const k = keys[i] ?? '';
    const arr = byKey.get(k) ?? [];
    arr.push(values[i]!);
    byKey.set(k, arr);
  }
  const clusters = [...byKey.values()];
  const C = clusters.length;
  const m = mean(values);
  if (C <= 1) return { mean: m, lo: NaN, hi: NaN, nClusters: C };
  const iters = opts.iters ?? 4000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 42);
  const means: number[] = [];
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    let n = 0;
    for (let c = 0; c < C; c++) {
      const pick = clusters[Math.floor(rand() * C)]!;
      for (const v of pick) {
        sum += v;
        n++;
      }
    }
    if (n > 0) means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const q = (p: number): number => {
    if (means.length === 0) return NaN;
    const pos = (means.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? means[lo]! : means[lo]! * (hi - pos) + means[hi]! * (pos - lo);
  };
  return { mean: m, lo: q(alpha / 2), hi: q(1 - alpha / 2), nClusters: C };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// archive streaming — keep ONLY the first tick + the entry tick per event (2 rows, not 312k)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The two ticks per event the gate needs, plus the meta the panel clusters on. */
export interface ArchiveEvent {
  eventId: string;
  city: string;
  targetDate: string;
  tzName: string;
  /** the earliest captured tick (the M4 momentum baseline). */
  firstRow: Record<string, unknown>;
  firstCapturedAt: string;
  /** the SECOND-earliest tick — M4's entry, because the fresh-open entry tick IS the first tick (no prior book). */
  secondRow: Record<string, unknown>;
  secondCapturedAt: string;
  secondHsl: number;
  /** the FRESH-OPEN entry tick: the earliest tick with hours_since_listing < 1. */
  entryRow: Record<string, unknown>;
  entryCapturedAt: string;
  entryHsl: number;
  /** true when NO tick had hours_since_listing < 1 → the entry fell back to the earliest tick. */
  entryIsFallback: boolean;
  nTicks: number;
  source: 'primary' | 'old';
}

// top-level-only keys (bucket objects carry none of these), so a regex prefilter is safe and ~10× faster
// than JSON.parse-ing all ~630k rows just to read two fields.
const RE_EVENT = /"event_id":"([0-9a-fA-F-]{36})"/;
const RE_CAP = /"captured_at":"([^"]+)"/;
const RE_HSL = /"hours_since_listing":(null|-?[\d.]+(?:[eE][-+]?\d+)?)/;
const RE_CITY = /"city":"([^"]*)"/;
const RE_TD = /"target_date":"([^"]*)"/;
const RE_TZ = /"tz_name":"([^"]*)"/;

export interface ArchiveScan {
  events: Map<string, ArchiveEvent>;
  rowsSeen: number;
  nullEventIdRows: number;
  shards: number;
}

/** Stream one archive dir's gz NDJSON shards, retaining per event only the first + entry tick. */
export function scanArchive(dir: string, source: 'primary' | 'old', log: (m: string) => void): ArchiveScan {
  const events = new Map<string, ArchiveEvent>();
  let rowsSeen = 0;
  let nullEventIdRows = 0;
  if (!existsSync(dir)) return { events, rowsSeen, nullEventIdRows, shards: 0 };
  const shards = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz')).sort();
  for (let s = 0; s < shards.length; s++) {
    const text = gunzipSync(readFileSync(path.join(dir, shards[s]!))).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.length < 2) continue;
      rowsSeen++;
      const em = RE_EVENT.exec(line);
      if (!em) {
        nullEventIdRows++;
        continue;
      }
      const eventId = em[1]!;
      const capturedAt = RE_CAP.exec(line)?.[1] ?? '';
      const hslRaw = RE_HSL.exec(line)?.[1] ?? 'null';
      const hsl = hslRaw === 'null' ? NaN : Number(hslRaw);
      let ev = events.get(eventId);
      if (!ev) {
        ev = {
          eventId,
          city: RE_CITY.exec(line)?.[1] ?? '',
          targetDate: RE_TD.exec(line)?.[1] ?? '',
          tzName: RE_TZ.exec(line)?.[1] ?? '',
          firstRow: {},
          firstCapturedAt: '',
          secondRow: {},
          secondCapturedAt: '',
          secondHsl: NaN,
          entryRow: {},
          entryCapturedAt: '',
          entryHsl: NaN,
          entryIsFallback: true,
          nTicks: 0,
          source,
        };
        events.set(eventId, ev);
      }
      ev.nTicks++;
      // Candidates are JSON.parse-d IMMEDIATELY rather than stashed as strings: split() yields SLICED strings
      // that pin their ~25 MB parent shard in V8, so retaining two lines per event across 213 shards would
      // retain gigabytes. Parsing here costs ~2 parses per event (rows arrive id-ascending, so the first tick
      // and the first fresh tick each win exactly once) instead of one parse per row.
      if (ev.firstCapturedAt === '' || capturedAt < ev.firstCapturedAt) {
        // a new earliest tick demotes the old one to the second slot (keeps the pair correct if ids ever
        // arrive out of capture order across a shard boundary).
        if (ev.firstCapturedAt !== '') {
          ev.secondCapturedAt = ev.firstCapturedAt;
          ev.secondRow = ev.firstRow;
          ev.secondHsl = Number(ev.firstRow['hours_since_listing'] ?? NaN);
        }
        ev.firstCapturedAt = capturedAt;
        ev.firstRow = JSON.parse(line) as Record<string, unknown>;
      } else if (ev.secondCapturedAt === '' || capturedAt < ev.secondCapturedAt) {
        ev.secondCapturedAt = capturedAt;
        ev.secondHsl = hsl;
        ev.secondRow = JSON.parse(line) as Record<string, unknown>;
      }
      if (Number.isFinite(hsl) && hsl < 1 && (ev.entryIsFallback || capturedAt < ev.entryCapturedAt)) {
        ev.entryCapturedAt = capturedAt;
        ev.entryHsl = hsl;
        ev.entryIsFallback = false;
        ev.entryRow = JSON.parse(line) as Record<string, unknown>;
      }
    }
    if ((s + 1) % 40 === 0 || s === shards.length - 1) log(`    ${dir.split(/[\\/]/).pop()} shard ${s + 1}/${shards.length} · ${events.size} events`);
  }
  // fall back to the earliest tick when NO tick was inside the fresh (<1h) window — flagged, never silent.
  for (const ev of events.values()) {
    if (ev.entryIsFallback) {
      ev.entryRow = ev.firstRow;
      ev.entryCapturedAt = ev.firstCapturedAt;
      ev.entryHsl = Number(ev.firstRow['hours_since_listing'] ?? NaN);
    }
  }
  return { events, rowsSeen, nullEventIdRows, shards: shards.length };
}

const bucketsOf = (row: Record<string, unknown>): OpeningBucket[] => {
  const raw = row['buckets'];
  return Array.isArray(raw) ? (raw as RawBucket[]).map(mapBucket) : [];
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// selection rules — the target bucket at the ENTRY tick (no look-ahead; M4 reads the FIRST tick only)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type RuleId = 'M0' | 'M1' | 'M2' | 'M4' | 'CHEAP';
export const RULES: { id: RuleId; label: string }[] = [
  { id: 'M0', label: 'forecast argmax(houseProb) — the control every prior run bought' },
  { id: 'M1', label: 'bid-leader: argmax(bestBid) among finite-execAsk buckets' },
  { id: 'M2', label: 'market-mode: argmax(mid)' },
  // ⚠ M4 is the ONE rule that cannot enter at the same tick as the others: the fresh-open entry tick IS the
  // first captured tick for essentially every event (the harness starts capturing at listing detection), so
  // "Δ bestBid from the first tick to the entry tick" is identically 0 there. M4 therefore enters one tick
  // LATER — baseline = tick 1, entry = tick 2 — which is still inside the fresh window but is NOT the same
  // entry price as M0/M1/M2/CHEAP. Read it as its own bet, not as a like-for-like selection swap.
  { id: 'M4', label: 'momentum: argmax(Δ bestBid) tick1→tick2, ENTERED AT TICK 2 (later entry than the others)' },
  { id: 'CHEAP', label: 'cheapest bucket with execAsk ∈ [0.02, 0.15] (the longshot cohort)' },
];

const argmaxBy = (bs: OpeningBucket[], val: (b: OpeningBucket) => number): OpeningBucket | null => {
  let best: OpeningBucket | null = null;
  let bestV = -Infinity;
  for (const b of bs) {
    const v = val(b);
    if (Number.isFinite(v) && v > bestV) {
      bestV = v;
      best = b;
    }
  }
  return best;
};

/** Pick the target bucket for one rule. Returns null when the rule is inapplicable at this event. */
export function selectBucket(rule: RuleId, entry: OpeningBucket[], first: OpeningBucket[], sameTick: boolean): OpeningBucket | null {
  switch (rule) {
    case 'M0':
      return argmaxBy(entry, (b) => (fin(b.houseProb) ? b.houseProb! : NaN));
    case 'M1':
      return argmaxBy(entry.filter((b) => fin(b.execAsk)), (b) => (fin(b.bestBid) ? b.bestBid! : NaN));
    case 'M2':
      return argmaxBy(entry, (b) => (fin(b.mid) ? b.mid! : NaN));
    case 'M4': {
      if (sameTick) return null; // no prior tick — no momentum window (documented skip, not a silent 0)
      const base = new Map(first.map((b) => [b.idx, fin(b.bestBid) ? b.bestBid! : 0]));
      return argmaxBy(entry, (b) => (fin(b.bestBid) ? b.bestBid! - (base.get(b.idx) ?? 0) : NaN));
    }
    case 'CHEAP': {
      const elig = entry.filter((b) => fin(b.execAsk) && b.execAsk! >= 0.02 && b.execAsk! <= 0.15);
      if (elig.length === 0) return null;
      return elig.reduce((a, b) => (b.execAsk! < a.execAsk! ? b : a));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the per-selection record + the per-rule reduction
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface Pick {
  eventId: string;
  city: string;
  targetDate: string;
  idx: number;
  label: string;
  won: boolean;
  execAsk: number;
  bestBid: number;
  spread: number;
  /** the YES bid depth = the NO-side fillable size under the mirror assumption. */
  noDepthUsd: number;
  yesEdge: number;
  noEdge: number;
  noRoi: number;
  gradingMismatch: boolean;
}

export interface RuleStat {
  rule: RuleId;
  label: string;
  nSelected: number;
  /** the NO-scorable population (finite bestBid) — the headline n for this gate. */
  nScored: number;
  /** the YES-scorable population (finite execAsk) — a different, usually smaller set. */
  nYesScored: number;
  nCities: number;
  nDates: number;
  nDropNoAsk: number;
  nDropNoBid: number;
  nInapplicable: number;
  P: number;
  pCiLo: number;
  pCiHi: number;
  /** mean (B − f) — the win rate above which the NO side stops being +EV. */
  breakevenP: number;
  meanNoPrice: number;
  /** true only when the Wilson UPPER bound of P is below breakevenP (rare-event-safe evidence). */
  rareEventEstablished: boolean;
  meanAsk: number;
  meanBid: number;
  meanSpread: number;
  yesEdge: number;
  yesEdgeCiLo: number;
  yesEdgeCiHi: number;
  yesCityCiLo: number;
  yesCityCiHi: number;
  yesDayCiLo: number;
  yesDayCiHi: number;
  noEdge: number;
  noEdgeCiLo: number;
  noEdgeCiHi: number;
  noCityMean: number;
  noCityCiLo: number;
  noCityCiHi: number;
  noDayMean: number;
  noDayCiLo: number;
  noDayCiHi: number;
  noRoi: number;
  noRoiBootLo: number;
  noRoiBootHi: number;
  noRoiCityBootLo: number;
  noRoiCityBootHi: number;
  noRoiDayBootLo: number;
  noRoiDayBootHi: number;
  depthGe50: number;
  depthGe150: number;
  verdict: string;
}

/** Reduce a rule's picks to the full CI bundle. All CIs 95%; clustered CIs collapse to cluster means first. */
export function reduceRule(
  rule: RuleId,
  label: string,
  picks: Pick[],
  counts: { nSelected: number; nDropNoAsk: number; nDropNoBid: number; nInapplicable: number },
): RuleStat {
  // each leg is scored on ITS OWN tradable population (a missing YES ask does not disqualify the NO leg).
  const yesPicks = picks.filter((p) => Number.isFinite(p.execAsk));
  const noPicks = picks.filter((p) => Number.isFinite(p.bestBid));
  const n = noPicks.length;
  const cities = noPicks.map((p) => p.city);
  const dates = noPicks.map((p) => p.targetDate);
  const nWon = noPicks.filter((p) => p.won).length;
  const w = wilsonInterval(nWon, n);
  const yes = meanConfidenceInterval(yesPicks.map((p) => p.yesEdge));
  const no = meanConfidenceInterval(noPicks.map((p) => p.noEdge));
  const yesCity = clusteredMeanCi(yesPicks.map((p) => p.yesEdge), yesPicks.map((p) => p.city));
  const yesDay = clusteredMeanCi(yesPicks.map((p) => p.yesEdge), yesPicks.map((p) => p.targetDate));
  const noCity = clusteredMeanCi(noPicks.map((p) => p.noEdge), cities);
  const noDay = clusteredMeanCi(noPicks.map((p) => p.noEdge), dates);
  const roi = noPicks.map((p) => p.noRoi);
  const roiBoot = bootstrapMeanCi(roi, { seed: 42 });
  const roiCityBoot = clusterBootstrapCi(roi, cities, { seed: 42 });
  const roiDayBoot = clusterBootstrapCi(roi, dates, { seed: 42 });
  // The RARE-EVENT check the mean-CI cannot do. When the selected bucket almost never wins (CHEAP: 4/415),
  // most day/city clusters contain ZERO winners, so the cluster-mean CI collapses to a near-degenerate band
  // around the deterministic (B − f) term and looks decisively positive on essentially no outcome evidence.
  // The honest test is on P itself: NO is +EV iff P < B − f. Compare the WILSON UPPER bound of P against that
  // breakeven — if the upper bound clears it, the NO edge is not established no matter how tight the mean CI.
  const meanNoPrice = mean(noPicks.map((p) => 1 - p.bestBid));
  const breakevenP = mean(noPicks.map((p) => p.bestBid - takerFee(1 - p.bestBid, 0.05)));
  const rareEventEstablished = Number.isFinite(breakevenP) && w.hi < breakevenP;
  // the BINDING gate: the NO side must clear 0 on BOTH clustered CIs AND survive the rare-event check.
  const binding = !(noCity.ciLow > 0) || !(noDay.ciLow > 0) || !rareEventEstablished;
  const verdict =
    n < 40 || new Set(cities).size < 6 || new Set(dates).size < 7
      ? 'INSUFFICIENT'
      : binding
        ? 'KILL'
        : 'PASS_PENDING_REAL_NO_BOOK';
  return {
    rule,
    label,
    nSelected: counts.nSelected,
    nScored: n,
    nYesScored: yesPicks.length,
    nCities: new Set(cities).size,
    nDates: new Set(dates).size,
    nDropNoAsk: counts.nDropNoAsk,
    nDropNoBid: counts.nDropNoBid,
    nInapplicable: counts.nInapplicable,
    P: n === 0 ? NaN : nWon / n,
    pCiLo: w.lo,
    pCiHi: w.hi,
    breakevenP,
    meanNoPrice,
    rareEventEstablished,
    meanAsk: mean(yesPicks.map((p) => p.execAsk)),
    meanBid: mean(noPicks.map((p) => p.bestBid)),
    meanSpread: mean(picks.filter((p) => Number.isFinite(p.spread)).map((p) => p.spread)),
    yesEdge: yes.mean,
    yesEdgeCiLo: yes.lo,
    yesEdgeCiHi: yes.hi,
    yesCityCiLo: yesCity.ciLow,
    yesCityCiHi: yesCity.ciHigh,
    yesDayCiLo: yesDay.ciLow,
    yesDayCiHi: yesDay.ciHigh,
    noEdge: no.mean,
    noEdgeCiLo: no.lo,
    noEdgeCiHi: no.hi,
    noCityMean: noCity.mean,
    noCityCiLo: noCity.ciLow,
    noCityCiHi: noCity.ciHigh,
    noDayMean: noDay.mean,
    noDayCiLo: noDay.ciLow,
    noDayCiHi: noDay.ciHigh,
    noRoi: roiBoot.mean,
    noRoiBootLo: roiBoot.lo,
    noRoiBootHi: roiBoot.hi,
    noRoiCityBootLo: roiCityBoot.lo,
    noRoiCityBootHi: roiCityBoot.hi,
    noRoiDayBootLo: roiDayBoot.lo,
    noRoiDayBootHi: roiDayBoot.hi,
    depthGe50: n === 0 ? NaN : noPicks.filter((p) => p.noDepthUsd >= 50).length / n,
    depthGe150: n === 0 ? NaN : noPicks.filter((p) => p.noDepthUsd >= 150).length / n,
    verdict,
  };
}

/** Build the per-rule picks from the panel. Returns picks + the honest drop accounting. */
export function buildPicks(
  rule: RuleId,
  panel: ArchiveEvent[],
  resMap: Map<string, Resolution>,
  feeRate: number,
): { picks: Pick[]; counts: { nSelected: number; nDropNoAsk: number; nDropNoBid: number; nInapplicable: number } } {
  const picks: Pick[] = [];
  let nSelected = 0;
  let nDropNoAsk = 0;
  let nDropNoBid = 0;
  let nInapplicable = 0;
  for (const ev of panel) {
    const res = resMap.get(ev.eventId);
    if (!res || res.winnerIdx == null) continue; // uncovered — counted separately, never silently pooled
    const first = bucketsOf(ev.firstRow);
    // M4 alone enters at tick 2 (it needs a prior tick to have momentum at all) — see the RULES note.
    const isM4 = rule === 'M4';
    const entryRow = isM4 ? ev.secondRow : ev.entryRow;
    const entry = bucketsOf(entryRow);
    const sameTick = isM4 ? ev.secondCapturedAt === '' || !(ev.secondHsl < 1) : ev.entryCapturedAt === ev.firstCapturedAt;
    const b = selectBucket(rule, entry, first, sameTick);
    if (!b) {
      nInapplicable++;
      continue;
    }
    nSelected++;
    const A = fin(b.execAsk) && b.execAsk! > 0 && b.execAsk! < 1 ? b.execAsk! : NaN;
    const B = fin(b.bestBid) && b.bestBid! > 0 && b.bestBid! < 1 ? b.bestBid! : NaN;
    // A missing YES ask does NOT disqualify the NO leg and vice versa — the legs are scored on their OWN
    // tradable populations. (The earlier version dropped 518 M0 events from the NO panel for want of a YES
    // ask the NO trade never touches; that was a real bias against the very question being asked.)
    if (!Number.isFinite(A)) nDropNoAsk++;
    if (!Number.isFinite(B)) nDropNoBid++;
    if (!Number.isFinite(A) && !Number.isFinite(B)) continue;
    const won = res.winnerIdx === b.idx;
    const y = (won ? 1 : 0) - A - takerFee(A, feeRate);
    const noPrice = 1 - B;
    const noCost = noPrice + takerFee(noPrice, feeRate);
    const nEdge = (won ? 0 : 1) - noPrice - takerFee(noPrice, feeRate);
    picks.push({
      eventId: ev.eventId,
      city: ev.city,
      targetDate: ev.targetDate,
      idx: b.idx,
      label: b.label,
      won,
      execAsk: A,
      bestBid: B,
      spread: A - B,
      noDepthUsd: Math.max(b.sellbackDepthUsd ?? 0, b.sellbackUsd ?? 0),
      yesEdge: y,
      noEdge: nEdge,
      noRoi: noCost > 0 ? nEdge / noCost : NaN,
      gradingMismatch: res.gradingMismatch,
    });
  }
  return { picks, counts: { nSelected, nDropNoAsk, nDropNoBid, nInapplicable } };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// price-stratified table — "does our predicted hit rate price low enough to flip it around?"
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export const BANDS: { label: string; lo: number; hi: number }[] = [
  { label: '<0.05', lo: 0, hi: 0.05 },
  { label: '0.05–0.15', lo: 0.05, hi: 0.15 },
  { label: '0.15–0.30', lo: 0.15, hi: 0.3 },
  { label: '0.30–0.50', lo: 0.3, hi: 0.5 },
  { label: '>0.50', lo: 0.5, hi: 1.01 },
];

export interface BandStat {
  band: string;
  n: number;
  nCities: number;
  nDates: number;
  P: number;
  pCiLo: number;
  pCiHi: number;
  meanAsk: number;
  meanBid: number;
  yesEdge: number;
  noEdge: number;
  noDayCiLo: number;
  noDayCiHi: number;
  noCityCiLo: number;
  noCityCiHi: number;
}

/** Strata are keyed on the ENTRY ASK, so this table is necessarily the both-legs-quoted subset. */
export function stratify(all: Pick[]): BandStat[] {
  const picks = all.filter((p) => Number.isFinite(p.execAsk) && Number.isFinite(p.bestBid));
  return BANDS.map((band) => {
    const ps = picks.filter((p) => p.execAsk >= band.lo && p.execAsk < band.hi);
    const nWon = ps.filter((p) => p.won).length;
    const w = wilsonInterval(nWon, ps.length);
    const noCity = clusteredMeanCi(ps.map((p) => p.noEdge), ps.map((p) => p.city));
    const noDay = clusteredMeanCi(ps.map((p) => p.noEdge), ps.map((p) => p.targetDate));
    return {
      band: band.label,
      n: ps.length,
      nCities: new Set(ps.map((p) => p.city)).size,
      nDates: new Set(ps.map((p) => p.targetDate)).size,
      P: ps.length === 0 ? NaN : nWon / ps.length,
      pCiLo: w.lo,
      pCiHi: w.hi,
      meanAsk: mean(ps.map((p) => p.execAsk)),
      meanBid: mean(ps.map((p) => p.bestBid)),
      yesEdge: mean(ps.map((p) => p.yesEdge)),
      noEdge: mean(ps.map((p) => p.noEdge)),
      noCityCiLo: noCity.ciLow,
      noCityCiHi: noCity.ciHigh,
      noDayCiLo: noDay.ciLow,
      noDayCiHi: noDay.ciHigh,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DB (read-only)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export async function loadResolutions(db: ScriptDb, ids: string[]): Promise<Map<string, Resolution>> {
  const m = new Map<string, Resolution>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db.query<Record<string, unknown>>(
      `select id, poly_resolved_winner_idx, winning_bucket_idx, grading_mismatch
         from public.market_events where id = any($1::uuid[])`,
      [chunk],
    );
    for (const r of rows) {
      const poly = fin(r['poly_resolved_winner_idx']) ? Number(r['poly_resolved_winner_idx']) : null;
      const win = fin(r['winning_bucket_idx']) ? Number(r['winning_bucket_idx']) : null;
      m.set(String(r['id']), { winnerIdx: poly ?? win, gradingMismatch: r['grading_mismatch'] === true });
    }
  }
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// self-test (CLI invocation; no DB, no archive)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function sanity(): void {
  // fee is symmetric across the mirror + minimised at the extremes
  if (Math.abs(takerFee(0.2, 0.05) - takerFee(0.8, 0.05)) > 1e-12) throw new Error('sanity: fee must be mirror-symmetric');
  if (!(takerFee(0.5, 0.05) > takerFee(0.05, 0.05))) throw new Error('sanity: fee must peak at 0.5');

  // clusteredMeanCi collapses to cluster means: 100 bets on 2 cities is 2 observations, not 100
  const vals = [...Array(50).fill(1), ...Array(50).fill(-1)];
  const keys = [...Array(50).fill('a'), ...Array(50).fill('b')];
  const cc = clusteredMeanCi(vals, keys);
  if (cc.nClusters !== 2 || Math.abs(cc.mean) > 1e-12) throw new Error('sanity: cluster mean');
  const flat = meanConfidenceInterval(vals);
  if (!(cc.ciHigh - cc.ciLow > flat.hi - flat.lo)) throw new Error('sanity: clustered CI must be WIDER than the per-bet CI');
  if (clusteredMeanCi([], []).nClusters !== 0) throw new Error('sanity: empty clustered');

  // cluster bootstrap is seeded → reproducible, and wider than the naive per-bet bootstrap here
  const b1 = clusterBootstrapCi(vals, keys, { iters: 500, seed: 7 });
  const b2 = clusterBootstrapCi(vals, keys, { iters: 500, seed: 7 });
  if (b1.lo !== b2.lo || b1.hi !== b2.hi) throw new Error('sanity: cluster bootstrap must be reproducible');

  // selection rules
  const mk = (idx: number, o: Partial<OpeningBucket> = {}): OpeningBucket => ({
    idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.12, execAsk: 0.12, depthUsd: 100,
    bestBid: 0.08, sellbackUsd: 100, execBid: 0.08, sellbackDepthUsd: 100, houseProb: 0.1,
    tokenYes: 'y', tokenNo: 'n', conditionId: 'c', ...o,
  });
  const entry = [mk(0, { houseProb: 0.5, bestBid: 0.05, mid: 0.06, execAsk: 0.5 }), mk(1, { houseProb: 0.2, bestBid: 0.3, mid: 0.33, execAsk: 0.35 }), mk(2, { houseProb: 0.1, bestBid: 0.02, mid: 0.03, execAsk: 0.04 })];
  const first = [mk(0, { bestBid: 0.05 }), mk(1, { bestBid: 0.29 }), mk(2, { bestBid: 0.0 })];
  if (selectBucket('M0', entry, first, false)?.idx !== 0) throw new Error('sanity: M0 argmax houseProb');
  if (selectBucket('M1', entry, first, false)?.idx !== 1) throw new Error('sanity: M1 bid-leader');
  if (selectBucket('M2', entry, first, false)?.idx !== 1) throw new Error('sanity: M2 market-mode');
  if (selectBucket('M4', entry, first, false)?.idx !== 2) throw new Error('sanity: M4 momentum (+0.02 beats +0.01)');
  if (selectBucket('M4', entry, first, true) !== null) throw new Error('sanity: M4 must skip a single-tick event');
  if (selectBucket('CHEAP', entry, first, false)?.idx !== 2) throw new Error('sanity: CHEAP cheapest in [0.02,0.15]');
  if (selectBucket('CHEAP', [mk(0, { execAsk: 0.9 })], first, false) !== null) throw new Error('sanity: CHEAP inapplicable');

  // the edge arithmetic: a LOSING bucket bought NO at 1−B nets +B − fee; a WINNING one nets −(1−B) − fee
  const ev = (over: Partial<ArchiveEvent>): ArchiveEvent => ({
    eventId: 'E', city: 'x', targetDate: '2026-07-01', tzName: 'UTC',
    firstRow: { buckets: first.map((b) => ({ ...b })) }, firstCapturedAt: 't0',
    secondRow: { buckets: entry.map((b) => ({ ...b })) }, secondCapturedAt: 't1', secondHsl: 0.3,
    entryRow: { buckets: entry.map((b) => ({ ...b })) }, entryCapturedAt: 't1',
    entryHsl: 0.2, entryIsFallback: false, nTicks: 2, source: 'primary', ...over,
  });
  const built = buildPicks('M0', [ev({})], new Map([['E', { winnerIdx: 1, gradingMismatch: false }]]), 0.05);
  const p = built.picks[0]!;
  if (p.won !== false || p.idx !== 0) throw new Error('sanity: M0 pick lost');
  const expectedNo = 1 - (1 - 0.05) - takerFee(0.95, 0.05);
  if (Math.abs(p.noEdge - expectedNo) > 1e-12) throw new Error(`sanity: NO edge arithmetic ${p.noEdge} vs ${expectedNo}`);
  if (Math.abs(p.yesEdge - (0 - 0.5 - takerFee(0.5, 0.05))) > 1e-12) throw new Error('sanity: YES edge arithmetic');
  const winPick = buildPicks('M0', [ev({})], new Map([['E', { winnerIdx: 0, gradingMismatch: false }]]), 0.05).picks[0]!;
  if (!(winPick.noEdge < 0 && winPick.yesEdge > 0)) throw new Error('sanity: NO and YES edges must be mirror-signed');
  // NO edge + YES edge = −(spread) − both fees: the round-trip cost identity
  if (Math.abs(winPick.noEdge + winPick.yesEdge - (-(winPick.execAsk - winPick.bestBid) - takerFee(winPick.execAsk, 0.05) - takerFee(1 - winPick.bestBid, 0.05))) > 1e-12) {
    throw new Error('sanity: YES+NO must equal minus the spread minus both fees');
  }
  // an unresolved event is DROPPED, never scored as a loss
  if (buildPicks('M0', [ev({})], new Map(), 0.05).picks.length !== 0) throw new Error('sanity: unresolved must drop');
  if (buildPicks('M0', [ev({})], new Map([['E', { winnerIdx: null, gradingMismatch: false }]]), 0.05).picks.length !== 0) throw new Error('sanity: null winnerIdx must drop');
  // a null bestBid is a NO-side drop, COUNTED not pooled (M0 can select such a bucket; M1 by construction
  // cannot — its argmax is over bestBid itself, so a bid-less bucket is never its target).
  const noBid = buildPicks('M0', [ev({ entryRow: { buckets: [mk(0, { bestBid: null, execAsk: 0.2 })] } })], new Map([['E', { winnerIdx: 5, gradingMismatch: false }]]), 0.05);
  if (noBid.counts.nDropNoBid !== 1) throw new Error('sanity: null bestBid must be a counted NO-leg drop');
  if (Number.isFinite(noBid.picks[0]?.noEdge) || !Number.isFinite(noBid.picks[0]?.yesEdge)) throw new Error('sanity: ask-only → YES finite, NO NaN');
  if (reduceRule('M0', 'x', noBid.picks, noBid.counts).nScored !== 0) throw new Error('sanity: an ask-only pick must not enter the NO panel');
  // both legs missing ⇒ the pick is dropped entirely
  const neither = buildPicks('M0', [ev({ entryRow: { buckets: [mk(0, { execAsk: null, bestBid: null })] } })], new Map([['E', { winnerIdx: 5, gradingMismatch: false }]]), 0.05);
  if (neither.picks.length !== 0) throw new Error('sanity: a bucket with neither side quoted must drop');

  // the legs are scored on their OWN populations: a bucket with a bid but NO ask still scores the NO leg
  const bidOnly = buildPicks('M0', [ev({ entryRow: { buckets: [mk(0, { execAsk: null, bestBid: 0.1 })] } })], new Map([['E', { winnerIdx: 5, gradingMismatch: false }]]), 0.05);
  if (bidOnly.picks.length !== 1 || bidOnly.counts.nDropNoAsk !== 1) throw new Error('sanity: a bid-only bucket must still score the NO leg');
  if (!Number.isFinite(bidOnly.picks[0]!.noEdge) || Number.isFinite(bidOnly.picks[0]!.yesEdge)) throw new Error('sanity: bid-only → NO finite, YES NaN');
  const bidOnlyStat = reduceRule('M0', 'x', bidOnly.picks, bidOnly.counts);
  if (bidOnlyStat.nScored !== 1 || bidOnlyStat.nYesScored !== 0) throw new Error('sanity: per-leg populations must differ');

  // the rare-event guard: a 0-winner sample has a near-degenerate mean CI but must NOT read as established
  const rare = Array.from({ length: 30 }, (_, i) => ({
    eventId: `r${i}`, city: `c${i % 3}`, targetDate: `2026-07-0${(i % 3) + 1}`, idx: 0, label: 'l', won: false,
    execAsk: 0.05, bestBid: 0.01, spread: 0.04, noDepthUsd: 10,
    yesEdge: -0.05, noEdge: 0.01 - takerFee(0.99, 0.05), noRoi: 0.01, gradingMismatch: false,
  }));
  const rareStat = reduceRule('CHEAP', 'x', rare, { nSelected: 30, nDropNoAsk: 0, nDropNoBid: 0, nInapplicable: 0 });
  if (!(rareStat.noDayCiLo > 0)) throw new Error('sanity: the zero-variance mean CI should look decisive here');
  if (rareStat.rareEventEstablished) throw new Error('sanity: 0/30 winners must NOT establish a ~1% breakeven edge');

  // reduce + stratify are total on empty
  const empty = reduceRule('M0', 'x', [], { nSelected: 0, nDropNoAsk: 0, nDropNoBid: 0, nInapplicable: 0 });
  if (empty.verdict !== 'INSUFFICIENT') throw new Error('sanity: empty rule must be INSUFFICIENT');
  if (stratify([]).length !== BANDS.length) throw new Error('sanity: stratify must be total');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({ options: { 'fee-rate': { type: 'string' }, 'no-old-archive': { type: 'boolean' } } });
  const feeRate = Math.max(0, Number(values['fee-rate'] ?? DEFAULT_FEE_RATE) || 0);
  const useOld = values['no-old-archive'] !== true;
  const log = (m: string): void => console.log(m);
  const err = (m: string): void => {
    process.stderr.write(`${m}\n`);
  };

  err(`${SCRIPT} · ${new Date().toISOString()} · read-only; places NOTHING, never imports packages/trading`);
  err('  scanning archives (first tick + fresh-open entry tick per event only)…');
  const primary = scanArchive(ARCHIVE_PRIMARY, 'primary', err);
  const old = useOld ? scanArchive(ARCHIVE_OLD, 'old', err) : { events: new Map<string, ArchiveEvent>(), rowsSeen: 0, nullEventIdRows: 0, shards: 0 };

  // merge: primary wins on collision (it is the canonical-sort-corrected dump); old ADDS pre-07-06 history.
  const merged = new Map(primary.events);
  let overlap = 0;
  let added = 0;
  for (const [id, ev] of old.events) {
    if (merged.has(id)) overlap++;
    else {
      merged.set(id, ev);
      added++;
    }
  }
  const panel = [...merged.values()];
  const fallbackCount = panel.filter((e) => e.entryIsFallback).length;

  const db = makeScriptDb();
  try {
    const resMap = await loadResolutions(db, panel.map((e) => e.eventId));
    const covered = panel.filter((e) => (resMap.get(e.eventId)?.winnerIdx ?? null) != null);
    const noRow = panel.filter((e) => !resMap.has(e.eventId)).length;
    const nullWinner = panel.length - covered.length - noRow;
    const mismatch = covered.filter((e) => resMap.get(e.eventId)!.gradingMismatch).length;

    log('=== convergence-no-side-gate · is BETTING NO on the selected bucket +EV? (hold to resolution) ===');
    log(`  taker fee f(p) = ${feeRate}·p·(1−p) on the price paid on THAT side (f(1−B) ≡ f(B)).`);
    log('  NO price = 1 − bestBid(YES). ⚠ MIRROR ASSUMPTION — the archive stores only the YES book.');
    log('');
    log('--- 1 · DATA ---');
    log(`  primary archive : ${primary.shards} shards · ${primary.rowsSeen} rows · ${primary.events.size} events · ${primary.nullEventIdRows} null-event_id rows DROPPED`);
    log(`  old archive     : ${old.shards} shards · ${old.rowsSeen} rows · ${old.events.size} events · ${old.nullEventIdRows} null-event_id rows DROPPED`);
    log(`  merge           : ${overlap} events overlap (primary kept) · ${added} events ADDED by the old archive · ${panel.length} total`);
    log(`  entry tick      : ${panel.length - fallbackCount} events had a fresh tick (hours_since_listing < 1); ${fallbackCount} fell back to the earliest tick`);
    log(`  resolution join : ${covered.length} COVERED · ${noRow} no market_events row · ${nullWinner} row-but-null-winner · ${mismatch} grading_mismatch among covered`);
    log(`  scored panel    : ${covered.length} events · ${new Set(covered.map((e) => e.city)).size} cities · ${new Set(covered.map((e) => e.targetDate)).size} target dates`);
    log('  POPULATION IS UNCONDITIONAL: every selected bucket is held notionally to resolution — no take-profit,');
    log('  no stop, no early exit. This is NOT the adversely-selected hold-to-resolution residue of the live track.');
    log('');

    const perRule: RuleStat[] = [];
    const picksByRule = new Map<RuleId, Pick[]>();
    for (const r of RULES) {
      const { picks, counts } = buildPicks(r.id, panel, resMap, feeRate);
      picksByRule.set(r.id, picks);
      perRule.push(reduceRule(r.id, r.label, picks, counts));
    }

    log('--- 2 · PER-RULE (resolved events only; P = realized win fraction of the SELECTED bucket) ---');
    log('  n = the NO-scorable population (finite bestBid). The YES leg is scored on its OWN population (nYes below).');
    log(`  ${'rule'.padEnd(6)}${'n'.padStart(5)}${'cty'.padStart(5)}${'day'.padStart(5)}  ${'P (Wilson95)'.padStart(22)}  ${'A'.padStart(6)}${'B'.padStart(7)}${'sprd'.padStart(7)}  ${'YESedge'.padStart(8)}  ${'NOedge'.padStart(8)}  ${'NO city-CI'.padStart(18)}  ${'NO day-CI'.padStart(18)}  verdict`);
    for (const s of perRule) {
      log(
        `  ${s.rule.padEnd(6)}${String(s.nScored).padStart(5)}${String(s.nCities).padStart(5)}${String(s.nDates).padStart(5)}  ` +
          `${`${pct(s.P)} [${pct(s.pCiLo)}, ${pct(s.pCiHi)}]`.padStart(22)}  ${f2(s.meanAsk).padStart(6)}${f2(s.meanBid).padStart(7)}${f2(s.meanSpread).padStart(7)}  ` +
          `${spct(s.yesEdge, 2).padStart(8)}  ${spct(s.noEdge, 2).padStart(8)}  ` +
          `${`[${spct(s.noCityCiLo, 2)}, ${spct(s.noCityCiHi, 2)}]`.padStart(18)}  ` +
          `${`[${spct(s.noDayCiLo, 2)}, ${spct(s.noDayCiHi, 2)}]`.padStart(18)}  ${s.verdict}`,
      );
    }
    log('');
    log('  RARE-EVENT ADJUDICATION — NO is +EV iff P < B − f. When the selected bucket almost never wins, most');
    log('  clusters hold zero winners and the mean CI collapses around the deterministic (B−f) term, looking');
    log('  decisive on no outcome evidence. The binding test is the WILSON UPPER bound of P vs the breakeven.');
    log(`  ${'rule'.padEnd(6)}${'nYes'.padStart(6)}  ${'P'.padStart(7)}${'P upper95'.padStart(11)}${'breakevenP'.padStart(12)}   established?`);
    for (const s of perRule) {
      log(
        `  ${s.rule.padEnd(6)}${String(s.nYesScored).padStart(6)}  ${pct(s.P, 2).padStart(7)}${pct(s.pCiHi, 2).padStart(11)}${pct(s.breakevenP, 2).padStart(12)}   ` +
          `${s.nScored === 0 ? '—' : s.rareEventEstablished ? 'YES — P upper95 < breakeven' : 'NO — P upper95 ≥ breakeven (edge NOT established)'}`,
      );
    }
    log('');
    log(`  ${'rule'.padEnd(6)}${'sel'.padStart(5)}${'noAsk'.padStart(7)}${'noBid'.padStart(7)}${'n/a'.padStart(6)}  ${'YES per-bet CI'.padStart(20)}  ${'YES city-CI'.padStart(20)}  ${'YES day-CI'.padStart(20)}`);
    for (const s of perRule) {
      log(
        `  ${s.rule.padEnd(6)}${String(s.nSelected).padStart(5)}${String(s.nDropNoAsk).padStart(7)}${String(s.nDropNoBid).padStart(7)}${String(s.nInapplicable).padStart(6)}  ` +
          `${`[${spct(s.yesEdgeCiLo, 2)}, ${spct(s.yesEdgeCiHi, 2)}]`.padStart(20)}  ` +
          `${`[${spct(s.yesCityCiLo, 2)}, ${spct(s.yesCityCiHi, 2)}]`.padStart(20)}  ` +
          `${`[${spct(s.yesDayCiLo, 2)}, ${spct(s.yesDayCiHi, 2)}]`.padStart(20)}`,
      );
    }
    log('');
    log('--- 3 · NO-side per-$1 ROI (inverted tail → seeded bootstrap; clusters resampled whole) ---');
    log(`  ${'rule'.padEnd(6)}${'ROI/$1'.padStart(9)}  ${'per-bet boot'.padStart(20)}  ${'city-cluster boot'.padStart(20)}  ${'day-cluster boot'.padStart(20)}`);
    for (const s of perRule) {
      log(
        `  ${s.rule.padEnd(6)}${spct(s.noRoi, 2).padStart(9)}  ${`[${spct(s.noRoiBootLo, 2)}, ${spct(s.noRoiBootHi, 2)}]`.padStart(20)}  ` +
          `${`[${spct(s.noRoiCityBootLo, 2)}, ${spct(s.noRoiCityBootHi, 2)}]`.padStart(20)}  ` +
          `${`[${spct(s.noRoiDayBootLo, 2)}, ${spct(s.noRoiDayBootHi, 2)}]`.padStart(20)}`,
      );
    }
    log('');
    log('--- 4 · NO-side EXECUTABLE DEPTH (fillable size = the YES bid depth, under the mirror assumption) ---');
    for (const s of perRule) log(`  ${s.rule.padEnd(6)} ≥$50: ${pct(s.depthGe50).padStart(6)}   ≥$150: ${pct(s.depthGe150).padStart(6)}`);
    log('');

    const strata: Record<string, BandStat[]> = {};
    for (const r of RULES) {
      const picks = picksByRule.get(r.id) ?? [];
      strata[r.id] = stratify(picks);
      if (picks.length === 0) continue;
      log(`--- 5 · PRICE-STRATIFIED · ${r.id} (${r.label}) ---`);
      log(`  ${'band'.padEnd(11)}${'n'.padStart(5)}${'cty'.padStart(5)}${'day'.padStart(5)}  ${'P (Wilson95)'.padStart(22)}  ${'A'.padStart(6)}${'B'.padStart(7)}  ${'YESedge'.padStart(8)}  ${'NOedge'.padStart(8)}  ${'NO day-CI'.padStart(18)}`);
      for (const b of strata[r.id]!) {
        if (b.n === 0) continue;
        log(
          `  ${b.band.padEnd(11)}${String(b.n).padStart(5)}${String(b.nCities).padStart(5)}${String(b.nDates).padStart(5)}  ` +
            `${`${pct(b.P)} [${pct(b.pCiLo)}, ${pct(b.pCiHi)}]`.padStart(22)}  ${f2(b.meanAsk).padStart(6)}${f2(b.meanBid).padStart(7)}  ` +
            `${spct(b.yesEdge, 2).padStart(8)}  ${spct(b.noEdge, 2).padStart(8)}  ${`[${spct(b.noDayCiLo, 2)}, ${spct(b.noDayCiHi, 2)}]`.padStart(18)}`,
        );
      }
      log('');
    }

    // ── OOS: split by DATE (train = earliest 70% of distinct target_dates). Pick the rule by TRAIN day-clustered
    // ciLow (never the point estimate), then report the HELD-OUT number. Any in-sample best is a winner's-curse
    // upper bound and is labelled as such.
    const allDates = [...new Set(covered.map((e) => e.targetDate))].sort();
    const cut = Math.floor(allDates.length * 0.7);
    const trainDates = new Set(allDates.slice(0, cut));
    let oos: Record<string, unknown> = { skipped: 'too few distinct dates' };
    if (allDates.length >= 10) {
      const scored = RULES.map((r) => {
        const ps = (picksByRule.get(r.id) ?? []).filter((p) => Number.isFinite(p.bestBid));
        const tr = ps.filter((p) => trainDates.has(p.targetDate));
        const te = ps.filter((p) => !trainDates.has(p.targetDate));
        return {
          rule: r.id,
          trainN: tr.length,
          trainNoCiLow: clusteredMeanCi(tr.map((p) => p.noEdge), tr.map((p) => p.targetDate)).ciLow,
          testN: te.length,
          test: clusteredMeanCi(te.map((p) => p.noEdge), te.map((p) => p.targetDate)),
          testCity: clusteredMeanCi(te.map((p) => p.noEdge), te.map((p) => p.city)),
        };
      }).filter((s) => s.trainN >= 10 && s.testN >= 10);
      const best = scored.slice().sort((a, b) => (b.trainNoCiLow || -Infinity) - (a.trainNoCiLow || -Infinity))[0] ?? null;
      oos = {
        trainDates: cut,
        testDates: allDates.length - cut,
        perRule: scored,
        selectedOnTrainByCiLow: best?.rule ?? null,
        heldOutNoEdge: best?.test ?? null,
      };
      log('--- 6 · OOS (train = earliest 70% of dates; rule selected on TRAIN day-clustered ciLow, NOT the point estimate) ---');
      for (const s of scored) {
        log(`  ${s.rule.padEnd(6)} train n=${String(s.trainN).padStart(4)} ciLow ${spct(s.trainNoCiLow, 2).padStart(8)}  →  test n=${String(s.testN).padStart(4)} NOedge ${spct(s.test.mean, 2).padStart(8)} day-CI [${spct(s.test.ciLow, 2)}, ${spct(s.test.ciHigh, 2)}]`);
      }
      if (best) log(`  SELECTED ON TRAIN: ${best.rule} → HELD-OUT NO edge ${spct(best.test.mean, 2)} day-CI [${spct(best.test.ciLow, 2)}, ${spct(best.test.ciHigh, 2)}]`);
      log('');
    }

    const artifact = {
      script: SCRIPT,
      generatedAt: new Date().toISOString(),
      feeRate,
      assumptions: [
        'NO price = 1 − bestBid(YES) — the mirror assumption; the archive stores only the YES book. negRisk conversion and separate NO-side liquidity could break it.',
        'NO fillable size = the YES bid depth (sellbackDepthUsd/sellbackUsd) — same mirror assumption.',
        'Population is UNCONDITIONAL: every selected bucket held notionally to resolution, no early exit, so it carries NONE of the live track\'s take-profit adverse selection.',
        'Hold-to-resolution only: no convergence exit is modelled here by design — this is the cheap gate on the INVERSE bet, not a re-run of the (dead) convergence thesis.',
      ],
      data: {
        primary: { shards: primary.shards, rows: primary.rowsSeen, events: primary.events.size, nullEventIdRows: primary.nullEventIdRows },
        old: { shards: old.shards, rows: old.rowsSeen, events: old.events.size, nullEventIdRows: old.nullEventIdRows, used: useOld },
        merge: { overlap, addedByOld: added, total: panel.length },
        entryFallbackEvents: fallbackCount,
        resolution: { covered: covered.length, noRow, rowButNullWinner: nullWinner, gradingMismatch: mismatch },
        panel: { n: covered.length, cities: new Set(covered.map((e) => e.city)).size, dates: new Set(covered.map((e) => e.targetDate)).size },
      },
      perRule,
      strata,
      oos,
    };
    const outPath = path.join(OUT_DIR, 'convergence-no-side-gate.json');
    writeFileSync(outPath, JSON.stringify(artifact, null, 2));
    log(`RESULT ${JSON.stringify({ artifact: outPath, panelN: covered.length, rules: perRule.map((s) => ({ rule: s.rule, n: s.nScored, P: s.P, noEdge: s.noEdge, noCityCiLo: s.noCityCiLo, noDayCiLo: s.noDayCiLo, verdict: s.verdict })) })}`);
  } finally {
    await db.end();
  }
}
