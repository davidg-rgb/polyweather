/**
 * scripts/research/model-trim — per-city NWP MODEL-SET TRIM (the "uniform model set" gap).
 *
 * THE QUESTION. The house point forecast (`house_gaussian` μ) is already per-station in its
 * *corrections*: each model is EMA-bias-corrected and inverse-MSE-weighted per
 * (icao, model, lead, slot) in `model_stats`. But the model *SET* is uniform — every city
 * ingests the same enabled models; a model is never hard-dropped for a city, only softly
 * down-weighted by 1/MSE. This probe asks the one thing the four rejected point-skill levers
 * (mos-pointskill, wo3-regime-weighting) never tested: **does hard per-city subset selection —
 * dropping the models that hurt a given city — beat the all-models blend out-of-sample?**
 *
 * WHY IT MIGHT (and might not). Inverse-MSE weighting is already *soft* trimming, so the prior
 * is that a hard trim buys little. It can still help when (a) a model injects correlated error
 * the weighting can't suppress, or (b) the 30-day weight estimate is itself noisy and a bad
 * model's inclusion adds estimation variance. It can HURT because a per-city best-of-2^8 pick on
 * ~40 days is a textbook multiple-comparisons false positive (source-accuracy-findings.ts already
 * proved a naive best-of-N per-city SOURCE pick `survivesMultipleComparisons:false` at n≈48).
 *
 * THE METHOD (honest by construction — the source-selector.ts posture, on a subset instead of a
 * single source):
 *   1. Panel = the STITCHED walk-forward the C24 stitch trick uses: TRAIN = `backfill` slot
 *      (2026-04-09 → seam), TEST = a live slot (10Z/22Z, seam+1 → today). TEST is REAL FORWARD
 *      data the selection never saw — a native backtest-vs-forward cross-check (traps.md #1).
 *   2. Baseline = the LIVE model: all 8 core deterministic models, EMA-bias-corrected,
 *      inverse-MSE-weighted (== computeModelWeights). Only the MEMBERSHIP set changes across arms.
 *   3. Select per city by bidirectional greedy stepwise on TRAIN point-RMSE (iterate add/drop
 *      until no further gain — the "iterate a few times" loop), from both the full set and empty.
 *   4. ADOPT a city's trim only if it beats the all-models baseline on the disjoint TEST window by
 *      a margin (min TRAIN/TEST coverage gated); else SHRINK to the full blend (the proven default).
 *   5. Report pooled TEST RMSE reduction with a CITY-CLUSTERED bootstrap CI, bucket hit-rate
 *      (native-integer exact / within-1) deltas, and a ZERO-SKILL permutation null (how often a
 *      RANDOM subset of the same size beats the baseline by the observed margin — does TRAIN
 *      selection carry forward information at all?).
 *
 * POSTURE: analytics study, read-only, writes only scripts/research/out/. Ships nothing to prod,
 * no migration, never imports packages/trading. A KILL (trimming ≤ full blend) is the deliverable;
 * a PASS upgrades the FORECAST product (a per-city model set), it does not touch the dormant rail.
 *
 * Run: pnpm tsx scripts/research/model-trim.ts [--leads 0,1,2,3] [--slot 22Z|10Z]
 *        [--seam 2026-06-12] [--stations EHAM,EGLL] [--margin-c 0.05] [--min-train 25]
 *        [--min-test 8] [--warmup 21] [--iters 3000] [--seed 42] [--json]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { correctPoint, updateBias, fToC, parseConfigRows, type AppConfig } from '../../packages/core/src/index.ts';
import { bootstrapMeanCi, quantileSorted, wilsonInterval } from '../../packages/core/src/sim/stats.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';
import { addDaysISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'model-trim';

/** The 8 core deterministic Open-Meteo NWP models present across the whole panel (best_match, the
 * meta-blend, only exists from 2026-06-13, and the ens members feed house_ensemble not the μ blend —
 * both excluded so TRAIN and TEST share one stable universe). */
export const CORE8 = [
  'ecmwf_ifs025',
  'gfs_seamless',
  'icon_seamless',
  'jma_seamless',
  'gem_seamless',
  'meteofrance_seamless',
  'ukmo_seamless',
  'cma_grapes_global',
] as const;

/** Short labels for compact reporting. */
export const MODEL_ABBR: Record<string, string> = {
  ecmwf_ifs025: 'ECMWF',
  gfs_seamless: 'GFS',
  icon_seamless: 'ICON',
  jma_seamless: 'JMA',
  gem_seamless: 'GEM',
  meteofrance_seamless: 'METFR',
  ukmo_seamless: 'UKMO',
  cma_grapes_global: 'CMA',
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PURE ENGINE
// ════════════════════════════════════════════════════════════════════════════════════════════════

export type Scheme = 'invmse' | 'equal';

/** One model's causal state for one (icao,lead,model) on a given build-day. */
export interface DayMember {
  /** bias-corrected point forecast (°C). */
  p: number;
  /** un-normalised inverse-MSE weight (1/max(mse,ε)); only meaningful when `qualified`. */
  wRaw: number;
  /** the model has ≥ minN trailing residuals → it participates in inverse-MSE weighting. */
  qualified: boolean;
}

/** One scoreable (icao, lead, target_date): the truth + every available model's causal member. */
export interface ScoreDay {
  city: string;
  date: string;
  unit: string; // 'C' | 'F'
  obsC: number; // observed daily high in °C
  obsNative: number; // observed daily high in the market's native integer unit (the resolved bucket)
  members: Map<string, DayMember>;
  /** window fully primed (≥ warmup days folded before this one) — TRAIN selection uses only warm days. */
  warm: boolean;
}

/** Native-integer bucket a °C center rounds into (the market resolves on integer native degrees). */
export function toNativeInt(pC: number, unit: string): number {
  return unit === 'F' ? Math.round((pC * 9) / 5 + 32) : Math.round(pC);
}

/**
 * Blend the provided members (already restricted to the chosen subset) into one point forecast.
 * invmse = inverse-MSE weighted over qualified members (== the live model), falling back to an
 * equal mean of all provided members when none qualify (mirrors build-distributions' 1/N fallback).
 * equal = plain mean. Returns null when the subset has no member this day.
 */
export function blendPoint(members: DayMember[], scheme: Scheme): number | null {
  if (members.length === 0) return null;
  if (scheme === 'invmse') {
    let num = 0;
    let den = 0;
    for (const m of members) {
      if (!m.qualified || !(m.wRaw > 0)) continue;
      num += m.wRaw * m.p;
      den += m.wRaw;
    }
    if (den > 0) return num / den;
    // no qualified member → equal-weight fallback (the live builder's 1/N path)
  }
  let s = 0;
  for (const m of members) s += m.p;
  return s / members.length;
}

export interface SubsetScore {
  n: number;
  rmseC: number;
  maeC: number;
  exact: number;
  within1: number;
  exactRate: number;
  within1Rate: number;
}

/** Score a subset over a set of days (equal-weighted across days). Pure + total. */
export function scoreSubset(days: readonly ScoreDay[], subset: ReadonlySet<string>, scheme: Scheme): SubsetScore {
  let n = 0;
  let sse = 0;
  let sae = 0;
  let exact = 0;
  let within1 = 0;
  for (const d of days) {
    const members: DayMember[] = [];
    for (const m of subset) {
      const mem = d.members.get(m);
      if (mem) members.push(mem);
    }
    const blend = blendPoint(members, scheme);
    if (blend === null || !Number.isFinite(blend)) continue;
    const err = blend - d.obsC;
    n += 1;
    sse += err * err;
    sae += Math.abs(err);
    const miss = Math.abs(toNativeInt(blend, d.unit) - d.obsNative);
    if (miss === 0) exact += 1;
    if (miss <= 1) within1 += 1;
  }
  return {
    n,
    rmseC: n > 0 ? Math.sqrt(sse / n) : NaN,
    maeC: n > 0 ? sae / n : NaN,
    exact,
    within1,
    exactRate: n > 0 ? exact / n : NaN,
    within1Rate: n > 0 ? within1 / n : NaN,
  };
}

/** Per-day absolute-error records for a subset (index-aligned to the scoreable subset of `days`). */
export interface DayErr {
  city: string;
  date: string;
  absErrC: number;
  exact: number; // 0/1
  within1: number; // 0/1
}
export function perDayErrors(days: readonly ScoreDay[], subset: ReadonlySet<string>, scheme: Scheme): DayErr[] {
  const out: DayErr[] = [];
  for (const d of days) {
    const members: DayMember[] = [];
    for (const m of subset) {
      const mem = d.members.get(m);
      if (mem) members.push(mem);
    }
    const blend = blendPoint(members, scheme);
    if (blend === null || !Number.isFinite(blend)) continue;
    const miss = Math.abs(toNativeInt(blend, d.unit) - d.obsNative);
    out.push({ city: d.city, date: d.date, absErrC: Math.abs(blend - d.obsC), exact: miss === 0 ? 1 : 0, within1: miss <= 1 ? 1 : 0 });
  }
  return out;
}

export interface StepRound {
  op: string; // 'init' | 'drop ECMWF' | 'add GFS'
  size: number;
  rmseC: number;
}
export interface Selection {
  subset: Set<string>;
  rmseC: number;
  rounds: StepRound[];
}

/** One bidirectional greedy path from `start`: repeatedly apply the single toggle (add/drop) that most
 * reduces TRAIN RMSE, until none improves by > minDelta. Never empties the set. */
function greedyFrom(train: readonly ScoreDay[], models: readonly string[], scheme: Scheme, start: ReadonlySet<string>, minDelta: number): Selection {
  const cur = new Set(start);
  let curR = cur.size > 0 ? scoreSubset(train, cur, scheme).rmseC : Infinity;
  const rounds: StepRound[] = [{ op: 'init', size: cur.size, rmseC: curR }];
  for (let iter = 0; iter < 32; iter++) {
    let bestR = curR;
    let bestSet: Set<string> | null = null;
    let bestOp = '';
    for (const m of models) {
      const cand = new Set(cur);
      let op: string;
      if (cand.has(m)) {
        if (cand.size === 1) continue; // never empty
        cand.delete(m);
        op = `drop ${MODEL_ABBR[m] ?? m}`;
      } else {
        cand.add(m);
        op = `add ${MODEL_ABBR[m] ?? m}`;
      }
      const r = scoreSubset(train, cand, scheme).rmseC;
      if (Number.isFinite(r) && r < bestR - minDelta) {
        bestR = r;
        bestSet = cand;
        bestOp = op;
      }
    }
    if (!bestSet) break;
    cur.clear();
    for (const m of bestSet) cur.add(m);
    curR = bestR;
    rounds.push({ op: bestOp, size: cur.size, rmseC: curR });
  }
  return { subset: cur, rmseC: curR, rounds };
}

/**
 * Bidirectional stepwise selection: run greedy from the FULL set (backward) and from EMPTY (forward),
 * keep whichever converges lower (ties → the simpler/smaller set). Reduces greedy path-dependence.
 */
export function stepwiseSelect(train: readonly ScoreDay[], models: readonly string[] = CORE8, scheme: Scheme = 'invmse', minDelta = 1e-4): Selection {
  const fromFull = greedyFrom(train, models, scheme, new Set(models), minDelta);
  const fromEmpty = greedyFrom(train, models, scheme, new Set(), minDelta);
  if (!Number.isFinite(fromEmpty.rmseC)) return fromFull;
  if (fromEmpty.rmseC < fromFull.rmseC - 1e-9) return fromEmpty;
  if (fromFull.rmseC < fromEmpty.rmseC - 1e-9) return fromFull;
  return fromEmpty.subset.size <= fromFull.subset.size ? fromEmpty : fromFull;
}

// --- city-clustered bootstrap on a paired per-day series ------------------------------------------

export interface ClusteredCi {
  mean: number;
  lo: number;
  hi: number;
  nCities: number;
  nObs: number;
}
/** Grand mean of the pooled per-day values; CI by resampling CITIES with replacement (clusters
 * the within-city day correlation — N days on 6 cities is closer to 6 obs than N). Seeded. */
export function cityClusteredBootstrap(byCity: Map<string, number[]>, iters = 3000, seed = 42, alpha = 0.05): ClusteredCi {
  const cities = [...byCity.keys()].filter((c) => (byCity.get(c)?.length ?? 0) > 0);
  const all: number[] = [];
  for (const c of cities) all.push(...byCity.get(c)!);
  const nObs = all.length;
  if (cities.length === 0 || nObs === 0) return { mean: NaN, lo: NaN, hi: NaN, nCities: 0, nObs: 0 };
  const mean = all.reduce((a, v) => a + v, 0) / nObs;
  if (cities.length === 1) return { mean, lo: mean, hi: mean, nCities: 1, nObs };
  const rand = mulberry32(seed);
  const means = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < cities.length; k++) {
      const arr = byCity.get(cities[Math.floor(rand() * cities.length)]!)!;
      for (const v of arr) {
        sum += v;
        cnt += 1;
      }
    }
    means[i] = cnt > 0 ? sum / cnt : NaN;
  }
  means.sort((a, b) => a - b);
  return { mean, lo: quantileSorted(means, alpha / 2), hi: quantileSorted(means, 1 - alpha / 2), nCities: cities.length, nObs };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DRIVER: build the walk-forward panel, run the arms per lead, report
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface FcRow { icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string; snapshot_slot: string }
interface ObsRow { icao: string; date_local: string | Date; tmax_wu_native: number | null; unit: string }

const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export interface TrimArgs {
  leads: number[];
  slot: string; // live TEST slot
  seam: string; // last TRAIN (backfill) date inclusive
  stations?: string[];
  marginC: number; // per-city adoption: trim must cut TEST MAE by ≥ this (°C) to be adopted
  minTrain: number;
  minTest: number;
  warmup: number;
  iters: number;
  seed: number;
  scheme: Scheme;
}

/** Build the stitched, causal per-(icao,lead) ScoreDay panels. TRAIN = backfill ≤ seam; TEST = live slot > seam. */
export function buildPanels(
  fcRows: FcRow[],
  obsRows: ObsRow[],
  cfg: AppConfig,
  args: TrimArgs,
): Map<number, { train: ScoreDay[]; test: ScoreDay[] }> {
  const unitByIcao = new Map<string, string>();
  const obs = new Map<string, Map<string, number>>(); // icao → dateISO → native
  for (const r of obsRows) {
    if (r.tmax_wu_native === null) continue;
    unitByIcao.set(r.icao, r.unit);
    const m = obs.get(r.icao) ?? new Map<string, number>();
    m.set(dISO(r.date_local), Number(r.tmax_wu_native));
    obs.set(r.icao, m);
  }

  // (icao,lead,date) → model → raw °C, choosing backfill for date ≤ seam else the live slot (no overlap).
  type Cell = Map<string, number>;
  const fc = new Map<string, Cell>(); // key `${icao}|${lead}|${date}`
  const key = (icao: string, lead: number, date: string) => `${icao}|${lead}|${date}`;
  for (const r of fcRows) {
    const date = dISO(r.target_date);
    const wantBackfill = date <= args.seam;
    if (wantBackfill ? r.snapshot_slot !== 'backfill' : r.snapshot_slot !== args.slot) continue;
    const k = key(r.icao, r.lead_days, date);
    const cell = fc.get(k) ?? new Map<string, number>();
    cell.set(r.model, Number(r.tmax_c));
    fc.set(k, cell);
  }

  // group the target dates per (icao,lead) once, so the walk below is O(cells), not O(icaos·leads·cells)
  const datesByIL = new Map<string, string[]>(); // `${icao}|${lead}` → sorted unique dates
  for (const k of fc.keys()) {
    const [ki, kl, kd] = k.split('|');
    const ilk = `${ki}|${kl}`;
    (datesByIL.get(ilk) ?? datesByIL.set(ilk, []).get(ilk)!).push(kd!);
  }
  for (const arr of datesByIL.values()) arr.sort();

  const icaos = [...new Set(fcRows.map((r) => r.icao))].filter((i) => obs.has(i)).sort();
  const out = new Map<number, { train: ScoreDay[]; test: ScoreDay[] }>();

  for (const lead of args.leads) {
    const train: ScoreDay[] = [];
    const test: ScoreDay[] = [];
    for (const icao of icaos) {
      const unit = unitByIcao.get(icao) ?? 'C';
      const dates = datesByIL.get(`${icao}|${lead}`) ?? [];
      // per-model causal window state
      const state = new Map<string, { bias: number | null; fs: number[]; os: number[] }>();
      const getState = (m: string) => {
        let s = state.get(m);
        if (!s) {
          s = { bias: null, fs: [], os: [] };
          state.set(m, s);
        }
        return s;
      };
      let scored = 0;
      for (const date of dates) {
        const cell = fc.get(key(icao, lead, date));
        const native = obs.get(icao)?.get(date);
        if (!cell || native === undefined) continue;
        const obsC = unit === 'F' ? fToC(native) : native;
        // score with CURRENT (pre-fold) windows — causal
        const members = new Map<string, DayMember>();
        for (const [model, raw] of cell) {
          const s = getState(model);
          const bias = s.bias ?? 0;
          const p = correctPoint(raw, bias);
          let wRaw = 0;
          const qualified = s.fs.length >= cfg.sigmaMinN;
          if (qualified) {
            let sse = 0;
            for (let i = 0; i < s.fs.length; i++) {
              const r = correctPoint(s.fs[i]!, bias) - s.os[i]!;
              sse += r * r;
            }
            const mse = sse / s.fs.length;
            wRaw = 1 / Math.max(mse, 1e-6);
          }
          members.set(model, { p, wRaw, qualified });
        }
        const day: ScoreDay = { city: icao, date, unit, obsC, obsNative: native, members, warm: scored >= args.warmup };
        if (date <= args.seam) train.push(day);
        else test.push(day);
        scored += 1;
        // fold truth into every present model's window (chronological, after scoring)
        for (const [model, raw] of cell) {
          const s = getState(model);
          s.bias = updateBias(s.bias, raw - obsC, cfg.biasAlpha);
          s.fs.push(raw);
          s.os.push(obsC);
          if (s.fs.length > cfg.sigmaWindowDays) {
            s.fs.shift();
            s.os.shift();
          }
        }
      }
    }
    out.set(lead, { train, test });
  }
  return out;
}

export interface CityTrim {
  city: string;
  selected: string[]; // TRAIN stepwise pick
  adopted: string[]; // after the OOS gate (== CORE8 when shrunk to blend)
  reason: 'adopted' | 'shrink-insufficient-train' | 'shrink-insufficient-test' | 'shrink-no-oos-margin';
  trainN: number;
  testN: number;
  baseTestMae: number;
  trimTestMae: number;
}

export interface LeadResult {
  lead: number;
  nCitiesTest: number;
  baseTest: SubsetScore;
  globalTrim: { subset: string[]; rounds: StepRound[]; test: SubsetScore };
  perCity: CityTrim[];
  nAdopted: number;
  // pooled OOS deltas (trim − baseline), positive = trim better.
  // NAIVE = TRAIN-selected subset applied forward to TEST with NO gate — the HONEST, deployable OOS
  // estimate (no test-set reuse). ADOPTED = the shrink-to-blend policy whose gate reads TEST, so its
  // pooled number is OPTIMISTIC (post-selection bias) and shown only as a deployment upper bound.
  naiveMaeReductionC: ClusteredCi;
  naiveExactDeltaPp: number;
  naiveWithin1DeltaPp: number;
  adoptedMaeReductionC: ClusteredCi;
  globalMaeReductionC: ClusteredCi;
  exactDeltaPp: number; // adopted − baseline, percentage points
  within1DeltaPp: number;
  zeroSkillPPass: number; // P(random same-size subset ≥ observed NAIVE gain)
  zeroSkillMeanGainC: number;
}

/** Pooled per-day trim−baseline deltas for a per-city subset map (no adoption gate). Pure. */
function pooledDeltas(
  test: readonly ScoreDay[],
  subsetByCity: Map<string, Set<string>>,
  full: Set<string>,
  scheme: Scheme,
): { byCity: Map<string, number[]>; exactPp: number; within1Pp: number; n: number } {
  const byCity = new Map<string, number[]>();
  let exactSum = 0;
  let within1Sum = 0;
  let n = 0;
  for (const d of test) {
    const sub = subsetByCity.get(d.city) ?? full;
    const bMem: DayMember[] = [];
    const tMem: DayMember[] = [];
    for (const m of full) {
      const mem = d.members.get(m);
      if (mem) bMem.push(mem);
    }
    for (const m of sub) {
      const mem = d.members.get(m);
      if (mem) tMem.push(mem);
    }
    const b = blendPoint(bMem, scheme);
    const t = blendPoint(tMem, scheme);
    if (b === null || t === null || !Number.isFinite(b) || !Number.isFinite(t)) continue;
    const bMiss = Math.abs(toNativeInt(b, d.unit) - d.obsNative);
    const tMiss = Math.abs(toNativeInt(t, d.unit) - d.obsNative);
    (byCity.get(d.city) ?? byCity.set(d.city, []).get(d.city)!).push(Math.abs(b - d.obsC) - Math.abs(t - d.obsC));
    exactSum += (tMiss === 0 ? 1 : 0) - (bMiss === 0 ? 1 : 0);
    within1Sum += (tMiss <= 1 ? 1 : 0) - (bMiss <= 1 ? 1 : 0);
    n += 1;
  }
  return { byCity, exactPp: (100 * exactSum) / Math.max(1, n), within1Pp: (100 * within1Sum) / Math.max(1, n), n };
}

/** Adopt-or-shrink test for one city (source-selector posture, on MAE). */
function adoptCity(city: string, selected: Set<string>, trainDays: ScoreDay[], testDays: ScoreDay[], scheme: Scheme, args: TrimArgs): CityTrim {
  const full = new Set(CORE8);
  const trN = trainDays.length;
  const teBase = scoreSubset(testDays, full, scheme);
  const teTrim = scoreSubset(testDays, selected, scheme);
  const base: Omit<CityTrim, 'reason' | 'adopted'> = {
    city,
    selected: [...selected].sort(),
    trainN: trN,
    testN: teBase.n,
    baseTestMae: teBase.maeC,
    trimTestMae: teTrim.maeC,
  };
  if (trN < args.minTrain) return { ...base, adopted: [...full].sort(), reason: 'shrink-insufficient-train' };
  if (teBase.n < args.minTest) return { ...base, adopted: [...full].sort(), reason: 'shrink-insufficient-test' };
  const beats = Number.isFinite(teTrim.maeC) && teBase.maeC - teTrim.maeC >= args.marginC;
  if (beats && !setsEqual(selected, full)) return { ...base, adopted: [...selected].sort(), reason: 'adopted' };
  return { ...base, adopted: [...full].sort(), reason: 'shrink-no-oos-margin' };
}

const setsEqual = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

export function runLead(lead: number, panel: { train: ScoreDay[]; test: ScoreDay[] }, scheme: Scheme, args: TrimArgs): LeadResult {
  const full = new Set(CORE8);
  const trainWarm = panel.train.filter((d) => d.warm);
  const test = panel.test;
  const citiesTest = [...new Set(test.map((d) => d.city))];

  const baseTest = scoreSubset(test, full, scheme);

  // global trim: one subset on pooled TRAIN
  const gsel = stepwiseSelect(trainWarm, CORE8, scheme);
  const globalTest = scoreSubset(test, gsel.subset, scheme);

  // per-city trim + adopt/shrink
  const trainByCity = new Map<string, ScoreDay[]>();
  const testByCity = new Map<string, ScoreDay[]>();
  for (const d of trainWarm) (trainByCity.get(d.city) ?? trainByCity.set(d.city, []).get(d.city)!).push(d);
  for (const d of test) (testByCity.get(d.city) ?? testByCity.set(d.city, []).get(d.city)!).push(d);

  const perCity: CityTrim[] = [];
  for (const city of citiesTest.sort()) {
    const tr = trainByCity.get(city) ?? [];
    const te = testByCity.get(city) ?? [];
    const sel = tr.length >= args.minTrain ? stepwiseSelect(tr, CORE8, scheme).subset : new Set(CORE8);
    perCity.push(adoptCity(city, sel, tr, te, scheme, args));
  }
  const nAdopted = perCity.filter((c) => c.reason === 'adopted').length;

  // subset maps
  const selectedByCity = new Map(perCity.map((c) => [c.city, new Set(c.selected)])); // TRAIN pick, NO gate
  const adoptedByCityFinal = new Map(perCity.map((c) => [c.city, new Set(c.adopted)])); // shrink-to-blend policy

  // HEADLINE (honest OOS): TRAIN-selected subset applied forward to TEST, no test-set reuse.
  const naive = pooledDeltas(test, selectedByCity, full, scheme);
  const naiveMaeReductionC = cityClusteredBootstrap(naive.byCity, args.iters, args.seed);

  // DEPLOYMENT (optimistic): the adopt-or-shrink policy — its gate peeked at TEST, so post-selection biased.
  const adopted = pooledDeltas(test, adoptedByCityFinal, full, scheme);
  const adoptedMaeReductionC = cityClusteredBootstrap(adopted.byCity, args.iters, args.seed);

  // global-trim pooled MAE reduction
  const gMap = pairReductionByCity(perDayErrors(test, full, scheme), perDayErrors(test, gsel.subset, scheme));
  const globalMaeReductionC = cityClusteredBootstrap(gMap, args.iters, args.seed);

  // zero-skill null: does TRAIN selection beat RANDOM subsets of the SAME per-city size? (vs the NAIVE gain)
  const sizeByCity = new Map<string, number>();
  for (const c of perCity) sizeByCity.set(c.city, new Set(c.selected).size);
  const { pPass, meanGain } = zeroSkillNull(test, sizeByCity, full, scheme, naiveMaeReductionC.mean, args);

  return {
    lead,
    nCitiesTest: citiesTest.length,
    baseTest,
    globalTrim: { subset: [...gsel.subset].map((m) => MODEL_ABBR[m] ?? m).sort(), rounds: gsel.rounds, test: globalTest },
    perCity,
    nAdopted,
    naiveMaeReductionC,
    naiveExactDeltaPp: naive.exactPp,
    naiveWithin1DeltaPp: naive.within1Pp,
    adoptedMaeReductionC,
    globalMaeReductionC,
    exactDeltaPp: adopted.exactPp,
    within1DeltaPp: adopted.within1Pp,
    zeroSkillPPass: pPass,
    zeroSkillMeanGainC: meanGain,
  };
}

/** Pair two index-independent per-day error lists by (city,date); reduction = base − trim, by city. */
function pairReductionByCity(base: DayErr[], trim: DayErr[]): Map<string, number[]> {
  const tByKey = new Map<string, DayErr>();
  for (const r of trim) tByKey.set(`${r.city}|${r.date}`, r);
  const m = new Map<string, number[]>();
  for (const b of base) {
    const t = tByKey.get(`${b.city}|${b.date}`);
    if (!t) continue;
    const a = m.get(b.city) ?? [];
    a.push(b.absErrC - t.absErrC);
    m.set(b.city, a);
  }
  return m;
}

/** How often does a RANDOM per-city subset (same sizes as adopted) match/beat the observed pooled MAE gain? */
function zeroSkillNull(test: ScoreDay[], sizeByCity: Map<string, number>, full: Set<string>, scheme: Scheme, observedGain: number, args: TrimArgs): { pPass: number; meanGain: number } {
  const rand = mulberry32(args.seed ^ 0x9e3779b9);
  const models = [...CORE8];
  const testByCity = new Map<string, ScoreDay[]>();
  for (const d of test) (testByCity.get(d.city) ?? testByCity.set(d.city, []).get(d.city)!).push(d);
  const K = 400;
  let pass = 0;
  let sumGain = 0;
  for (let it = 0; it < K; it++) {
    const byCity = new Map<string, number[]>();
    for (const [city, days] of testByCity) {
      const size = sizeByCity.get(city) ?? full.size;
      const subset = randomSubset(models, size, rand);
      for (const d of days) {
        const bMem: DayMember[] = [];
        const tMem: DayMember[] = [];
        for (const m of full) {
          const mem = d.members.get(m);
          if (mem) bMem.push(mem);
        }
        for (const m of subset) {
          const mem = d.members.get(m);
          if (mem) tMem.push(mem);
        }
        const b = blendPoint(bMem, scheme);
        const t = blendPoint(tMem, scheme);
        if (b === null || t === null || !Number.isFinite(b) || !Number.isFinite(t)) continue;
        (byCity.get(city) ?? byCity.set(city, []).get(city)!).push(Math.abs(b - d.obsC) - Math.abs(t - d.obsC));
      }
    }
    const all: number[] = [];
    for (const arr of byCity.values()) all.push(...arr);
    const gain = all.length ? all.reduce((a, v) => a + v, 0) / all.length : 0;
    sumGain += gain;
    if (gain >= observedGain - 1e-12) pass += 1;
  }
  return { pPass: pass / K, meanGain: sumGain / K };
}

function randomSubset(models: string[], size: number, rand: () => number): Set<string> {
  const idx = models.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const s = new Set<string>();
  for (let i = 0; i < Math.max(1, Math.min(size, models.length)); i++) s.add(models[idx[i]!]!);
  return s;
}

// --- report -------------------------------------------------------------------------------------

const f2 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '—');
const sp = (v: number) => (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3));

export function reportLead(r: LeadResult, log: (m: string) => void): void {
  log(`\n──────── LEAD ${r.lead}  (TEST = live forward window) ────────`);
  log(`  scope: ${r.nCitiesTest} cities · ${r.baseTest.n} scored city-days`);
  log(`  BASELINE (all 8, inv-MSE)      RMSE ${f3(r.baseTest.rmseC)}°C  MAE ${f3(r.baseTest.maeC)}°C  exact ${f2(100 * r.baseTest.exactRate)}%  ±1 ${f2(100 * r.baseTest.within1Rate)}%`);
  log(`  GLOBAL TRIM  {${r.globalTrim.subset.join(',')}}`);
  log(`    steps: ${r.globalTrim.rounds.map((s) => `${s.op}→${f3(s.rmseC)}`).join('  ')}`);
  log(`    TEST   RMSE ${f3(r.globalTrim.test.rmseC)}°C  MAE ${f3(r.globalTrim.test.maeC)}°C   ΔMAE ${sp(r.globalMaeReductionC.mean)}°C  95%CI[${sp(r.globalMaeReductionC.lo)},${sp(r.globalMaeReductionC.hi)}]`);
  log(`  PER-CITY TRIM — NAIVE OOS (TRAIN-select → apply forward, NO gate; the honest number):`);
  log(`    pooled ΔMAE ${sp(r.naiveMaeReductionC.mean)}°C  95%CI[${sp(r.naiveMaeReductionC.lo)},${sp(r.naiveMaeReductionC.hi)}]  (city-clustered, ${r.naiveMaeReductionC.nCities} cities/${r.naiveMaeReductionC.nObs} days)`);
  log(`    Δexact ${sp(r.naiveExactDeltaPp)}pp  Δ±1 ${sp(r.naiveWithin1DeltaPp)}pp`);
  log(`    zero-skill: P(random same-size subset ≥ naive gain) = ${(100 * r.zeroSkillPPass).toFixed(0)}%  (mean random gain ${sp(r.zeroSkillMeanGainC)}°C)`);
  log(`  PER-CITY TRIM — ADOPT-OR-SHRINK (deployment; gate reads TEST → OPTIMISTIC): ${r.nAdopted}/${r.nCitiesTest} adopted`);
  log(`    pooled ΔMAE ${sp(r.adoptedMaeReductionC.mean)}°C  95%CI[${sp(r.adoptedMaeReductionC.lo)},${sp(r.adoptedMaeReductionC.hi)}]  (upper bound, not deployable as-is)`);
  const adopted = r.perCity.filter((c) => c.reason === 'adopted');
  if (adopted.length) {
    log(`    cities that beat the full blend OOS by ≥margin:`);
    for (const c of adopted) log(`      ${c.city.padEnd(6)} {${c.adopted.map((m) => MODEL_ABBR[m] ?? m).join(',')}}  TEST MAE ${f3(c.trimTestMae)} vs base ${f3(c.baseTestMae)} (n=${c.testN})`);
  }
}

export async function loadRows(db: Db, args: TrimArgs): Promise<{ fc: FcRow[]; obs: ObsRow[] }> {
  const to = addDaysISO(new Date().toISOString().slice(0, 10), 20); // include forward-dated targets
  const fc = await db.query<FcRow>(
    `select icao, model, target_date, lead_days, tmax_c, snapshot_slot
     from forecast_snapshots
     where model = any($1) and lead_days = any($2)
       and snapshot_slot in ('backfill', $3) and target_date <= $4`,
    [CORE8 as unknown as string[], args.leads, args.slot, to],
  );
  const obs = await db.query<ObsRow>(
    `select icao, date_local, tmax_wu_native, unit from observations
     where finalized_at is not null and tmax_wu_native is not null and date_local >= '2026-04-01'`,
  );
  const want = args.stations ? new Set(args.stations.map((s) => s.toUpperCase())) : null;
  return {
    fc: want ? fc.filter((r) => want.has(r.icao.toUpperCase())) : fc,
    obs: want ? obs.filter((r) => want.has(r.icao.toUpperCase())) : obs,
  };
}

export async function runTrim(args: TrimArgs, deps: { db: Db; log: (m: string) => void }): Promise<LeadResult[]> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));
  const { fc, obs } = await loadRows(db, args);
  const panels = buildPanels(fc, obs, cfg, args);

  log(`\n═══════════ MODEL-TRIM · per-city NWP subset selection ═══════════`);
  log(`TRAIN backfill ≤ ${args.seam} · TEST slot ${args.slot} > ${args.seam} · window ${cfg.sigmaWindowDays}d minN ${cfg.sigmaMinN} · warmup ${args.warmup}d`);
  log(`universe: ${CORE8.map((m) => MODEL_ABBR[m]).join(', ')} · scheme ${args.scheme}${args.scheme === 'invmse' ? ' (== live model)' : ''} · adopt margin ${args.marginC}°C MAE`);

  const results: LeadResult[] = [];
  for (const lead of args.leads) {
    const panel = panels.get(lead);
    if (!panel || panel.test.length === 0) {
      log(`\n──────── LEAD ${lead}: no TEST data — skipped ────────`);
      continue;
    }
    const r = runLead(lead, panel, args.scheme, args);
    results.push(r);
    reportLead(r, log);
  }

  // ── the complexity ladder: does added structure keep buying OOS accuracy, or plateau? ──
  log(`\n═══════════ COMPLEXITY LADDER (OOS MAE reduction vs all-8 blend, mean across leads) ═══════════`);
  const avg = (f: (r: LeadResult) => number) => results.length ? results.reduce((a, r) => a + f(r), 0) / results.length : NaN;
  log(`  rung 0 · all-8 inv-MSE blend (the live model):  baseline`);
  log(`  rung 1 · global trim (one set, all cities):     ΔMAE ${sp(avg((r) => r.globalMaeReductionC.mean))}°C`);
  log(`  rung 2 · per-city trim, NAIVE OOS (honest):     ΔMAE ${sp(avg((r) => r.naiveMaeReductionC.mean))}°C`);
  log(`  rung 2*· per-city trim, adopt-or-shrink (opt.):  ΔMAE ${sp(avg((r) => r.adoptedMaeReductionC.mean))}°C  ← gate peeks at TEST; not deployable`);
  log(`  → the rung where the honest ΔMAE CI stops clearing 0 is where added structure stops paying.`);

  log(`\nRESULT ${JSON.stringify({
    script: SCRIPT,
    slot: args.slot,
    seam: args.seam,
    leads: results.map((r) => ({
      lead: r.lead,
      nCities: r.nCitiesTest,
      nDays: r.baseTest.n,
      baseRmseC: round4(r.baseTest.rmseC),
      baseMaeC: round4(r.baseTest.maeC),
      baseExactPct: round4(100 * r.baseTest.exactRate),
      globalTrim: r.globalTrim.subset,
      globalDMaeC: round4(r.globalMaeReductionC.mean),
      globalCI: [round4(r.globalMaeReductionC.lo), round4(r.globalMaeReductionC.hi)],
      naiveDMaeC: round4(r.naiveMaeReductionC.mean),
      naiveCI: [round4(r.naiveMaeReductionC.lo), round4(r.naiveMaeReductionC.hi)],
      naiveExactDeltaPp: round4(r.naiveExactDeltaPp),
      naiveWithin1DeltaPp: round4(r.naiveWithin1DeltaPp),
      zeroSkillPPass: round4(r.zeroSkillPPass),
      nAdopted: r.nAdopted,
      adoptedDMaeC: round4(r.adoptedMaeReductionC.mean),
      adoptedCI: [round4(r.adoptedMaeReductionC.lo), round4(r.adoptedMaeReductionC.hi)],
    })),
  })}`);

  writeArtifacts(args, results);
  return results;
}

const round4 = (v: number) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

function writeArtifacts(args: TrimArgs, results: LeadResult[]): void {
  const dir = 'scripts/research/out';
  mkdirSync(dir, { recursive: true });
  // per-(city,lead) selected + adopted sets with OOS MAE
  const lines = ['lead,city,reason,selected,adopted,trainN,testN,baseTestMae,trimTestMae'];
  for (const r of results) {
    for (const c of r.perCity) {
      lines.push([
        r.lead,
        c.city,
        c.reason,
        `"${c.selected.map((m) => MODEL_ABBR[m] ?? m).join('+')}"`,
        `"${c.adopted.map((m) => MODEL_ABBR[m] ?? m).join('+')}"`,
        c.trainN,
        c.testN,
        Number.isFinite(c.baseTestMae) ? c.baseTestMae.toFixed(4) : '',
        Number.isFinite(c.trimTestMae) ? c.trimTestMae.toFixed(4) : '',
      ].join(','));
    }
  }
  const path = `${dir}/model-trim-${args.slot}.csv`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n');
}

// --- self-test + CLI ------------------------------------------------------------------------------

function sanity(): void {
  // blendPoint: inv-MSE favours the low-MSE (high wRaw) member
  const a = blendPoint([{ p: 10, wRaw: 9, qualified: true }, { p: 20, wRaw: 1, qualified: true }], 'invmse')!;
  if (Math.abs(a - 11) > 1e-9) throw new Error(`blendPoint invmse self-test: got ${a}`);
  const e = blendPoint([{ p: 10, wRaw: 9, qualified: true }, { p: 20, wRaw: 1, qualified: true }], 'equal')!;
  if (Math.abs(e - 15) > 1e-9) throw new Error(`blendPoint equal self-test: got ${e}`);
  // stepwise must DROP a pure-noise model that a clean model dominates
  const days: ScoreDay[] = [];
  for (let i = 0; i < 40; i++) {
    const obs = 15 + (i % 7);
    const good = new Map<string, DayMember>([
      ['ecmwf_ifs025', { p: obs + 0.1 * Math.sin(i), wRaw: 1, qualified: true }],
      ['cma_grapes_global', { p: obs + 5 * ((i % 2) - 0.5), wRaw: 1, qualified: true }], // ±2.5 noise
    ]);
    days.push({ city: 'X', date: `2026-01-${String(i + 1).padStart(2, '0')}`, unit: 'C', obsC: obs, obsNative: obs, members: good, warm: true });
  }
  const sel = stepwiseSelect(days, ['ecmwf_ifs025', 'cma_grapes_global'], 'equal');
  if (!(sel.subset.has('ecmwf_ifs025') && !sel.subset.has('cma_grapes_global'))) {
    throw new Error(`stepwise self-test: expected to drop the noise model, got {${[...sel.subset].join(',')}}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      leads: { type: 'string' },
      slot: { type: 'string' },
      seam: { type: 'string' },
      stations: { type: 'string' },
      'margin-c': { type: 'string' },
      'min-train': { type: 'string' },
      'min-test': { type: 'string' },
      warmup: { type: 'string' },
      iters: { type: 'string' },
      seed: { type: 'string' },
      scheme: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const args: TrimArgs = {
    leads: (splitList(values.leads) ?? ['0', '1', '2', '3']).map(Number),
    slot: values.slot ?? '22Z',
    seam: values.seam ?? '2026-06-12',
    stations: splitList(values.stations),
    marginC: values['margin-c'] ? Number(values['margin-c']) : 0.05,
    minTrain: values['min-train'] ? Number(values['min-train']) : 25,
    minTest: values['min-test'] ? Number(values['min-test']) : 8,
    warmup: values.warmup ? Number(values.warmup) : 21,
    iters: values.iters ? Number(values.iters) : 3000,
    seed: values.seed ? Number(values.seed) : 42,
    scheme: values.scheme === 'equal' ? 'equal' : 'invmse',
  };
  const db = makeScriptDb();
  try {
    await runTrim(args, { db, log: console.log });
  } finally {
    await db.end();
  }
}
