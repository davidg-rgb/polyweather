/**
 * scripts/research/item11-nonlinear-residual — SIGNAL-BACKLOG.md item 11: nonlinear-ML residual
 * post-processing. This is the one open gap the external-report crosscheck named: linear MOS was
 * killed and a linear feature search found R²=0.60% (l3b-residual-structure.ts), but no NONLINEAR
 * post-processor was ever run. Analytics-side (forecast skill), not a trading lever.
 *
 * PRE-REGISTERED DESIGN (locked before any measurement — SIGNAL-BACKLOG.md "## 11.", the
 * "📌 PRE-REGISTERED (2026-07-03 ~19:25)" block — implemented exactly, no deviation):
 *   - MODEL, fixed in advance: hand-rolled gradient-boosted regression trees (pure TS, no new deps),
 *     300 rounds · learning rate 0.1 · depth ≤ 2, chosen NOW, no tuning on TEST.
 *   - FEATURES: the same leakage-free pre-decision set l3b-residual-structure.ts used — see the
 *     FEATURE-SET NOTE below for exactly how that maps onto this file's 6 columns.
 *   - TARGET: the walk-forward blend residual (obs − blendedMu), leads 1–2; window 2026-04-21→06-21,
 *     split 2026-05-27 (identical window/split to conditional-efficiency-scan.ts / item10). TRAIN fits
 *     the model; TEST scores it only.
 *   - GATE (reported, not adjudicated here per instruction): corrected TEST MAE vs raw TEST MAE, with
 *     a day-clustered bootstrap 95% CI on the delta, over ≥30 TEST days and ≥30 stations.
 *
 * FEATURE-SET NOTE (read l3b-residual-structure.ts before touching this): its `Sample` interface is
 * {spread(disagreement), sin, cos, anomaly, lead} — 5 numeric columns, no per-model columns and no
 * station column. `EmosStation.disagreement` (db1-daybefore-efficiency.ts) is ALREADY documented,
 * verbatim, as "the exact formula l3b-residual-structure.ts uses for its 'disagreement' feature" — so
 * the pre-registered doc's "ensemble disagreement, per-model deviations" is ONE feature (disagreement
 * IS derived from per-model deviations), not two; reusing `EmosStation.disagreement` directly is the
 * literal, importable, leakage-free reuse the spec asks for. "Station identity" (also named in the doc,
 * absent from l3b's own struct) is added as ONE integer feature — an alphabetical icao rank — because a
 * depth-≤2 tree can split on an arbitrary numeric station id directly (no one-hot needed, no new
 * information invented, purely an identity label). No feature beyond this named list was added.
 *
 * CLIMATOLOGY CAVEAT (inherited, not introduced here): l3b computes the per-station monthly climatology
 * from EVERY observation row in [from,to] up front (not incrementally walk-forward per day) — so the
 * "anomaly" feature for a TEST-half row is technically built from a climatology average that also
 * includes TEST-period observations. This file reproduces l3b's OWN method exactly (faithful reuse of
 * "the same feature set", per the pre-registered instruction not to invent anything new) — flagged here
 * so the MAE/R² read accounts for it; it is not a new leak this file introduces.
 *
 * DETERMINISM: the gradient-boosted-tree fit here is a full-batch, exhaustive-greedy-split algorithm —
 * no row or feature subsampling — so it is already perfectly reproducible without any random component;
 * no seed is threaded through the model fit for that reason (adding an unauthorized stochastic
 * hyperparameter, e.g. bagging, would itself be a deviation from "fixed hyperparams, chosen now"). The
 * one place a seed IS used, and IS required, is the day-clustered bootstrap CI (`mulberry32`, reused
 * read-only from `core/calibration/scores.ts` — the project's existing bootstrap convention).
 *
 * Run: pnpm tsx scripts/research/item11-nonlinear-residual.ts [--from 2026-04-21] [--to 2026-06-21]
 *        [--split-date 2026-05-27] [--leads 1,2] [--stations EHAM,EGLC] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fToC, parseConfigRows } from '../../packages/core/src/index.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';
import { quantileSorted } from '../../packages/core/src/sim/stats.ts';
import { EmosStation } from './db1-daybefore-efficiency.ts';
import { listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'item11-nonlinear-residual';

// =====================================================================================
// PURE: hand-rolled gradient-boosted regression trees (depth <= 2), fixed hyperparams
// =====================================================================================

export const N_ROUNDS = 300;
export const LEARNING_RATE = 0.1;
export const MAX_DEPTH = 2;
/** Minimum samples per leaf — fixed NOW (not tuned on TEST), a plain regularization floor so 300 rounds
 *  of depth-<=2 trees cannot carve out single-row leaves on the TRAIN samples this project's window
 *  produces (thousands of rows; see SELF-TEST B for the pure-noise regularization check). */
export const MIN_LEAF = 20;

export interface TreeNode {
  value?: number; // leaf
  featureIdx?: number; // internal
  threshold?: number;
  left?: TreeNode;
  right?: TreeNode;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Greedy, deterministic, depth-limited regression-tree builder. Exhaustive best-split search over every
 *  feature via an O(n log n) sort + O(n) running-sum sweep (no O(n²) re-scoring). Ties broken by
 *  first-found (stable feature order, ascending threshold sweep) — fully reproducible. */
export function buildTree(X: number[][], y: number[], depth: number): TreeNode {
  const n = y.length;
  if (depth >= MAX_DEPTH || n < 2 * MIN_LEAF) return { value: mean(y) };
  const nFeatures = X[0]?.length ?? 0;
  const totalSumY = y.reduce((a, b) => a + b, 0);
  const totalSumY2 = y.reduce((a, b) => a + b * b, 0);
  const parentSse = totalSumY2 - (totalSumY * totalSumY) / n;

  let best: { f: number; threshold: number; gain: number; order: number[]; splitAt: number } | null = null;
  for (let f = 0; f < nFeatures; f++) {
    const order = [...Array(n).keys()].sort((a, b) => X[a]![f]! - X[b]![f]!);
    let leftSumY = 0;
    let leftSumY2 = 0;
    for (let i = 0; i < MIN_LEAF - 1; i++) {
      const yi = y[order[i]!]!;
      leftSumY += yi;
      leftSumY2 += yi * yi;
    }
    for (let i = MIN_LEAF; i <= n - MIN_LEAF; i++) {
      const yPrev = y[order[i - 1]!]!;
      leftSumY += yPrev;
      leftSumY2 += yPrev * yPrev;
      const a = X[order[i - 1]!]![f]!;
      const b = X[order[i]!]![f]!;
      if (a === b) continue; // can't split between equal feature values
      const nLeft = i;
      const nRight = n - i;
      const rightSumY = totalSumY - leftSumY;
      const rightSumY2 = totalSumY2 - leftSumY2;
      const leftSse = leftSumY2 - (leftSumY * leftSumY) / nLeft;
      const rightSse = rightSumY2 - (rightSumY * rightSumY) / nRight;
      const gain = parentSse - (leftSse + rightSse);
      if (!best || gain > best.gain) best = { f, threshold: (a + b) / 2, gain, order, splitAt: i };
    }
  }
  if (!best || best.gain <= 1e-9) return { value: mean(y) };
  const leftIdx = best.order.slice(0, best.splitAt);
  const rightIdx = best.order.slice(best.splitAt);
  return {
    featureIdx: best.f,
    threshold: best.threshold,
    left: buildTree(leftIdx.map((j) => X[j]!), leftIdx.map((j) => y[j]!), depth + 1),
    right: buildTree(rightIdx.map((j) => X[j]!), rightIdx.map((j) => y[j]!), depth + 1),
  };
}

export function predictTree(node: TreeNode, x: number[]): number {
  let cur = node;
  while (cur.value === undefined) cur = x[cur.featureIdx!]! <= cur.threshold! ? cur.left! : cur.right!;
  return cur.value;
}

export interface GbmModel {
  f0: number;
  trees: TreeNode[];
  lr: number;
}

/** Fit gradient-boosted regression trees (L2 loss ⇒ each round fits the current residual directly).
 *  Full-batch, deterministic — see the header's DETERMINISM note. */
export function fitGbm(X: number[][], y: number[], rounds = N_ROUNDS, lr = LEARNING_RATE): GbmModel {
  const n = y.length;
  const f0 = mean(y);
  const preds = new Array(n).fill(f0);
  const trees: TreeNode[] = [];
  for (let r = 0; r < rounds; r++) {
    const residuals = y.map((yi, i) => yi - preds[i]!);
    const tree = buildTree(X, residuals, 0);
    trees.push(tree);
    for (let i = 0; i < n; i++) preds[i] += lr * predictTree(tree, X[i]!);
  }
  return { f0, trees, lr };
}

export function predictGbm(model: GbmModel, x: number[]): number {
  let p = model.f0;
  for (const t of model.trees) p += model.lr * predictTree(t, x);
  return p;
}

// =====================================================================================
// PURE: day-clustered bootstrap CI on the MAE delta (raw − corrected)
// =====================================================================================

export interface MaeRow {
  day: string;
  absRaw: number; // |obs - blendedMu|
  absCorrected: number; // |obs - (blendedMu + predictedResidual)|
}
export interface BootCi {
  mean: number;
  lo: number;
  hi: number;
}

function maeDelta(rows: MaeRow[]): number {
  const n = rows.length;
  if (!n) return NaN;
  const rawMae = rows.reduce((a, r) => a + r.absRaw, 0) / n;
  const corrMae = rows.reduce((a, r) => a + r.absCorrected, 0) / n;
  return rawMae - corrMae;
}

/** Resample TEST DAYS (not rows) with replacement — the day-clustered bootstrap the pre-registered gate
 *  asks for, since rows within a day are not independent draws. Seeded (mulberry32) for reproducibility,
 *  the same convention `core/sim/stats.ts::bootstrapMeanCi` already uses. */
export function dayClusteredMaeDeltaBootstrap(rows: MaeRow[], opts: { iters?: number; seed?: number; alpha?: number } = {}): BootCi {
  const days = [...new Set(rows.map((r) => r.day))];
  const byDay = new Map<string, MaeRow[]>();
  for (const r of rows) {
    const a = byDay.get(r.day) ?? [];
    a.push(r);
    byDay.set(r.day, a);
  }
  const point = maeDelta(rows);
  if (days.length === 0) return { mean: point, lo: NaN, hi: NaN };
  const iters = opts.iters ?? 2000;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? 42);
  const deltas = new Array<number>(iters);
  for (let it = 0; it < iters; it++) {
    let sumRaw = 0;
    let sumCorr = 0;
    let cnt = 0;
    for (let k = 0; k < days.length; k++) {
      const d = days[Math.floor(rand() * days.length)]!;
      for (const r of byDay.get(d)!) {
        sumRaw += r.absRaw;
        sumCorr += r.absCorrected;
        cnt++;
      }
    }
    deltas[it] = cnt > 0 ? sumRaw / cnt - sumCorr / cnt : NaN;
  }
  deltas.sort((a, b) => a - b);
  return { mean: point, lo: quantileSorted(deltas, alpha / 2), hi: quantileSorted(deltas, 1 - alpha / 2) };
}

// =====================================================================================
// EXPERIMENT
// =====================================================================================

export interface Item11Args {
  from: string;
  to: string;
  splitDate: string;
  leads: number[];
  stations?: string[];
  json: boolean;
}

interface Sample {
  icao: string;
  targetDate: string;
  features: number[]; // [disagreement, seasonSin, seasonCos, anomaly, lead, stationIdx]
  residual: number; // obs - blendedMu (the target)
}

export interface Item11Result {
  nStations: number;
  nTrainSamples: number;
  nTestSamples: number;
  nTrainDays: number;
  nTestDays: number;
  nTestStations: number;
  rawTrainMae: number;
  correctedTrainMae: number;
  rawTestMae: number;
  correctedTestMae: number;
  maeDelta: number;
  maeDeltaCiLo: number;
  maeDeltaCiHi: number;
  testR2: number; // out-of-sample R2 of the model's predicted residual vs the TEST residual
}
export interface Item11Deps {
  db: Db;
  log: (msg: string) => void;
}

const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function runItem11(args: Item11Args, deps: Item11Deps): Promise<Item11Result> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));
  const leadSet = new Set(args.leads);

  let stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit
     from stations s join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const want = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => want.has(s.icao.toUpperCase()));
  }
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  const icaos = stationRows.map((s) => s.icao).sort(); // sorted → deterministic "station identity" rank
  if (icaos.length === 0) throw new Error('no stations in scope');
  const stationIdx = new Map(icaos.map((icao, i) => [icao, i]));

  // forecasts (backfill slot — the SAME baseline source items 2-4/10's TRAIN/TEST split convention uses)
  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string }>(
    `select icao, model, target_date, lead_days, tmax_c from forecast_snapshots
     where snapshot_slot='backfill' and icao = any($1) and lead_days = any($2) and target_date <= $3`,
    [icaos, args.leads, args.to],
  );
  const fc = new Map<string, Map<string, Map<number, Map<string, number>>>>();
  for (const r of fRows) {
    const t = dISO(r.target_date);
    const byT = fc.get(r.icao) ?? new Map();
    const byLead = byT.get(t) ?? new Map();
    const byModel = byLead.get(r.lead_days) ?? new Map();
    byModel.set(r.model, Number(r.tmax_c));
    byLead.set(r.lead_days, byModel);
    byT.set(t, byLead);
    fc.set(r.icao, byT);
  }

  // finalized observations + monthly climatology (IDENTICAL to l3b-residual-structure.ts's own method —
  // see the header's CLIMATOLOGY CAVEAT: built over the full [from,to] window, not walk-forward).
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit from observations
     where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obs = new Map<string, Map<string, number>>();
  const climSum = new Map<string, number[]>();
  const climN = new Map<string, number[]>();
  for (const r of oRows) {
    const t = dISO(r.date_local);
    const c = (r.unit ?? unitByIcao.get(r.icao)) === 'F' ? fToC(Number(r.tmax_wu_native)) : Number(r.tmax_wu_native);
    const m = obs.get(r.icao) ?? new Map<string, number>();
    m.set(t, c);
    obs.set(r.icao, m);
    const mo = new Date(`${t}T00:00:00Z`).getUTCMonth();
    const cs = climSum.get(r.icao) ?? new Array(12).fill(0);
    const cn = climN.get(r.icao) ?? new Array(12).fill(0);
    cs[mo] += c;
    cn[mo] += 1;
    climSum.set(r.icao, cs);
    climN.set(r.icao, cn);
  }
  const clim = (icao: string, month: number): number => {
    const s = climSum.get(icao);
    const n = climN.get(icao);
    return s && n && n[month]! > 0 ? s[month]! / n[month]! : NaN;
  };

  // --- walk-forward EmosStation (the SAME baseline/disagreement source db1/conditional-scan/item10 use) ---
  const stateByIcao = new Map(icaos.map((i) => [i, new EmosStation(cfg)]));
  const foldDay = (icao: string, t: string): void => {
    const o = obs.get(icao)?.get(t);
    const byLeadMap = fc.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const sm = stateByIcao.get(icao)!;
    for (const [lead, byModel] of byLeadMap) {
      if (!leadSet.has(lead)) continue;
      sm.fold([...byModel].map(([model, f]) => ({ model, f })), lead, o);
    }
  };
  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  const samples: Sample[] = [];
  for (const d of listDatesISO(args.from, args.to)) {
    const month = new Date(`${d}T00:00:00Z`).getUTCMonth();
    const doy = (Date.UTC(2001, month, new Date(`${d}T00:00:00Z`).getUTCDate()) - Date.UTC(2001, 0, 1)) / 86_400_000;
    const ang = (2 * Math.PI * doy) / 365.25;
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) { foldDay(icao, d); continue; }
      const sm = stateByIcao.get(icao)!;
      for (const [lead, byModel] of byLeadMap) {
        if (!leadSet.has(lead)) continue;
        const points = [...byModel].map(([model, f]) => ({ model, f }));
        if (points.length === 0) continue;
        const mu = sm.blendedMu(points, lead);
        if (mu == null || !Number.isFinite(mu)) continue;
        const disagreement = sm.disagreement(points, lead);
        if (disagreement == null || !Number.isFinite(disagreement)) continue;
        const cl = clim(icao, month);
        const anomaly = Number.isNaN(cl) ? 0 : mu - cl;
        samples.push({
          icao,
          targetDate: d,
          features: [disagreement, Math.sin(ang), Math.cos(ang), anomaly, lead, stationIdx.get(icao)!],
          residual: o - mu, // item 11's target sign: obs - blendedMu
        });
      }
      foldDay(icao, d);
    }
  }
  log(`${SCRIPT}: ${samples.length} walk-forward samples across ${icaos.length} stations`);

  const train = samples.filter((s) => s.targetDate < args.splitDate);
  const test = samples.filter((s) => s.targetDate >= args.splitDate);

  const Xtrain = train.map((s) => s.features);
  const ytrain = train.map((s) => s.residual);
  const model = fitGbm(Xtrain, ytrain, N_ROUNDS, LEARNING_RATE);

  const trainPred = train.map((s) => predictGbm(model, s.features));
  const testPred = test.map((s) => predictGbm(model, s.features));

  const rawTrainMae = mean(train.map((s) => Math.abs(s.residual)));
  const correctedTrainMae = mean(train.map((s, i) => Math.abs(s.residual - trainPred[i]!)));
  const rawTestMae = mean(test.map((s) => Math.abs(s.residual)));
  const correctedTestMae = mean(test.map((s, i) => Math.abs(s.residual - testPred[i]!)));

  const testResiduals = test.map((s) => s.residual);
  const testMeanResidual = mean(testResiduals);
  const ssTot = testResiduals.reduce((a, r) => a + (r - testMeanResidual) ** 2, 0);
  const ssRes = test.reduce((a, s, i) => a + (s.residual - testPred[i]!) ** 2, 0);
  const testR2 = ssTot > 1e-12 ? 1 - ssRes / ssTot : 0;

  const maeRows: MaeRow[] = test.map((s, i) => ({
    day: s.targetDate,
    absRaw: Math.abs(s.residual),
    absCorrected: Math.abs(s.residual - testPred[i]!),
  }));
  const boot = dayClusteredMaeDeltaBootstrap(maeRows, { seed: 42 });

  return {
    nStations: icaos.length,
    nTrainSamples: train.length,
    nTestSamples: test.length,
    nTrainDays: new Set(train.map((s) => s.targetDate)).size,
    nTestDays: new Set(test.map((s) => s.targetDate)).size,
    nTestStations: new Set(test.map((s) => s.icao)).size,
    rawTrainMae,
    correctedTrainMae,
    rawTestMae,
    correctedTestMae,
    maeDelta: boot.mean,
    maeDeltaCiLo: boot.lo,
    maeDeltaCiHi: boot.hi,
    testR2,
  };
}

// =====================================================================================
// REPORT
// =====================================================================================

const f4 = (x: number): string => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : 'n/a');

export function report(res: Item11Result, args: Item11Args, log: (m: string) => void): void {
  log(`=== ${SCRIPT} ${args.from} → ${args.to} (split ${args.splitDate}) · ${res.nStations} stations ===`);
  log('');
  log(`TRAIN: n=${res.nTrainSamples} samples / ${res.nTrainDays} days — raw MAE ${f4(res.rawTrainMae)}°C · corrected MAE ${f4(res.correctedTrainMae)}°C`);
  log(`TEST:  n=${res.nTestSamples} samples / ${res.nTestDays} days / ${res.nTestStations} stations — raw MAE ${f4(res.rawTestMae)}°C · corrected MAE ${f4(res.correctedTestMae)}°C`);
  log('');
  log(`MAE delta (raw − corrected), TEST: ${f4(res.maeDelta)}°C, day-clustered bootstrap 95% CI [${f4(res.maeDeltaCiLo)}, ${f4(res.maeDeltaCiHi)}]`);
  log(`TEST R² of predicted residual (out-of-sample; compare to l3b's linear in-sample upper bound 0.60%): ${pct(res.testR2)}`);
  if (args.json) log('JSON ' + JSON.stringify(res));
}

// =====================================================================================
// SELF-TEST (known-answer, printed at runtime) + CLI
// =====================================================================================

function sanity(): void {
  // A) must fit a synthetic NONLINEAR (step) function markedly better than a linear fit.
  const randA = mulberry32(7);
  const nA = 400;
  const XA: number[][] = [];
  const yA: number[] = [];
  for (let i = 0; i < nA; i++) {
    const x = randA() * 2 - 1;
    const target = x > 0.3 ? 2 : x < -0.3 ? -2 : 0; // a clean step function — no linear fit captures this
    XA.push([x]);
    yA.push(target);
  }
  const modelA = fitGbm(XA, yA, N_ROUNDS, LEARNING_RATE);
  const gbmMse = mean(XA.map((x, i) => (predictGbm(modelA, x) - yA[i]!) ** 2));
  const xs = XA.map((r) => r[0]!);
  const xbar = mean(xs);
  const ybar = mean(yA);
  const cov = mean(xs.map((x, i) => (x - xbar) * (yA[i]! - ybar)));
  const varx = mean(xs.map((x) => (x - xbar) ** 2));
  const slope = varx > 1e-12 ? cov / varx : 0;
  const intercept = ybar - slope * xbar;
  const linMse = mean(xs.map((x, i) => (intercept + slope * x - yA[i]!) ** 2));
  console.log(`SELF-TEST A (nonlinear step fn): GBM MSE ${gbmMse.toFixed(4)} vs linear-fit MSE ${linMse.toFixed(4)} — GBM must be markedly lower`);
  if (!(gbmMse < 0.3 * linMse)) throw new Error(`sanity A FAILED: gbmMse=${gbmMse} linMse=${linMse}`);

  // B) must predict ~0 on pure noise, scored HELD-OUT (fit on train noise, predict on unseen test noise).
  const randB = mulberry32(11);
  const nB = 400;
  const XB: number[][] = [];
  const yB: number[] = [];
  for (let i = 0; i < nB; i++) {
    XB.push([randB() * 2 - 1, randB() * 2 - 1]);
    yB.push(randB() * 2 - 1); // unrelated to X, mean ~0
  }
  const half = Math.floor(nB / 2);
  const modelB = fitGbm(XB.slice(0, half), yB.slice(0, half), N_ROUNDS, LEARNING_RATE);
  const testXB = XB.slice(half);
  const testYB = yB.slice(half);
  const testPredsB = testXB.map((x) => predictGbm(modelB, x));
  const meanAbsPred = mean(testPredsB.map((p) => Math.abs(p)));
  const stdTestY = Math.sqrt(mean(testYB.map((v) => (v - mean(testYB)) ** 2)));
  console.log(`SELF-TEST B (pure noise, held-out): mean|pred| ${meanAbsPred.toFixed(4)} vs held-out-y std ${stdTestY.toFixed(4)} — predictions must stay small/near 0`);
  if (!(meanAbsPred < 0.5 * stdTestY)) throw new Error(`sanity B FAILED: meanAbsPred=${meanAbsPred} stdTestY=${stdTestY}`);

  console.log('SELF-TEST: both known-answer checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'split-date': { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: Item11Args = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-21',
      splitDate: values['split-date'] ?? '2026-05-27',
      leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
      stations: splitList(values.stations),
      json: Boolean(values.json),
    };
    const res = await runItem11(args, { db, log: console.log });
    report(res, args, console.log);
  } finally {
    await db.end();
  }
}
