/**
 * scripts/research/mos-pointskill — forecasting-skill R&D probe #1 (DF5-FINDINGS lever 2).
 *
 * THE QUESTION: DF-5 says house loses to market on AIM, not width — μ lands in the wrong
 * bucket more often (p(winner) 0.344 vs 0.373) even though mean bias ≈ 0. A mean bias of ≈0
 * with bad aim is the textbook signature of CONDITIONAL bias (slope error): a model that runs
 * warm on hot days and cold on cold days has ~0 average error but a systematically mis-aimed μ.
 * The live model corrects each model with a single EMA intercept (correctPoint = f − bias,
 * slope fixed at 1.0) — which cannot remove a slope error. Standard fix: regression MOS,
 * obs = a + b·forecast with b free (per station × model × lead).
 *
 * WHAT THIS DOES (read-only, touches NOTHING): a controlled walk-forward A/B over the backfill
 * forecast_snapshots vs finalized observations. Each arm shares the EXACT same information set
 * and the same inverse-MSE blend weights — ONLY the per-model point correction changes — so the
 * RMSE/MAE delta isolates the correction effect. Metric is ladder-free point error in °C (the
 * direct proxy for aim), measured over the FULL backfill (months × all covered stations), NOT the
 * 30-day market window — precisely to dodge the overfit trap DF-5 flagged for the prior-σ lever.
 *
 * ARMS (per station × model × lead, fit on the trailing sigmaWindowDays of pairs, walk-forward):
 *   baseline   — f − EMA_bias            (the live model: intercept only, slope ≡ 1)
 *   mos        — a + b·f                 (OLS, slope free; falls back to baseline when n < minN)
 *   mos_shrunk — a' + b'·f, b' shrinks toward 1 by n/(n+k) (regularized; controls small-window overfit)
 *
 * Weights are held at the live baseline inverse-MSE for ALL arms (controlled variable = correction).
 *
 * Run: pnpm tsx scripts/research/mos-pointskill.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leads 1,2,3] [--stations RKSI,EGLL] [--shrink-k 10] [--min-pairs 200]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  computeModelWeights,
  correctPoint,
  fToC,
  parseConfigRows,
  updateBias,
  type AppConfig,
} from '../../packages/core/src/index.ts';
import { addDaysISO, listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'mos-pointskill';

// --- pure stats -------------------------------------------------------------------

/** Simple OLS of y on x. Returns null when n < 2 or x has ~no variance (degenerate slope). */
export function olsFit(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length;
  if (n < 2 || xs.length !== ys.length) return null;
  const xbar = xs.reduce((s, x) => s + x, 0) / n;
  const ybar = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - xbar;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - ybar);
  }
  if (sxx < 1e-6) return null; // forecasts all but identical over the window — no slope to fit
  const b = sxy / sxx;
  return { a: ybar - b * xbar, b };
}

/** Shrink an OLS slope toward 1 (the no-conditional-bias prior) by n/(n+k); re-anchor the intercept. */
export function shrinkFit(fit: { a: number; b: number }, xbar: number, n: number, k: number): { a: number; b: number } {
  const w = n / (n + k);
  const b = w * fit.b + (1 - w) * 1;
  // keep the corrected mean at the OLS mean: a + b·xbar must equal the OLS prediction at xbar (= ybar).
  const ybarPred = fit.a + fit.b * xbar;
  return { a: ybarPred - b * xbar, b };
}

// --- per (model, lead) rolling state ----------------------------------------------

interface ModelWindow {
  bias: number | null; // running EMA bias (the live baseline correction)
  fs: number[]; // trailing forecasts (°C), capped at sigmaWindowDays
  os: number[]; // trailing observations (°C), aligned with fs
}

export type Arm = 'baseline' | 'mos' | 'mos_shrunk';
const ARMS: Arm[] = ['baseline', 'mos', 'mos_shrunk'];

export class StationModel {
  private readonly win = new Map<string, ModelWindow>(); // key = `${model}|${lead}`

  constructor(private readonly cfg: AppConfig, private readonly shrinkK: number) {}

  private key(model: string, lead: number): string {
    return `${model}|${lead}`;
  }
  private get(model: string, lead: number): ModelWindow {
    const k = this.key(model, lead);
    let w = this.win.get(k);
    if (!w) {
      w = { bias: null, fs: [], os: [] };
      this.win.set(k, w);
    }
    return w;
  }

  /** Corrected point estimate of a NEW forecast f under one arm, using the current window only. */
  correctedPoint(arm: Arm, model: string, lead: number, f: number): number {
    const w = this.get(model, lead);
    if (arm === 'baseline') return correctPoint(f, w.bias ?? 0);
    if (w.fs.length < this.cfg.sigmaMinN) return correctPoint(f, w.bias ?? 0); // not enough to fit → fall back
    const fit = olsFit(w.fs, w.os);
    if (!fit) return correctPoint(f, w.bias ?? 0);
    if (arm === 'mos') return fit.a + fit.b * f;
    const xbar = w.fs.reduce((s, x) => s + x, 0) / w.fs.length;
    const sh = shrinkFit(fit, xbar, w.fs.length, this.shrinkK);
    return sh.a + sh.b * f;
  }

  /** Baseline inverse-MSE weights (HELD CONSTANT across correction arms): live qualification (n ≥ minN). */
  baselineWeights(models: string[], lead: number): Map<string, number> {
    return this.weightsVariant(models, lead, 'invmse', 0);
  }

  /**
   * Weighting probe (#2, DF5-FINDINGS lever 1). Correction held at baseline; only the blend weights
   * change. 'invmse' = live 1/MSE. 'recency' = 1/MSE where the window MSE is exponentially time-decayed
   * (half-life `halflife` days → recent skill dominates). 'concentrate' = 1/MSE² (sharper toward the
   * best model). All qualify a model at n ≥ minN and use baseline-corrected residuals (apples-to-apples).
   */
  weightsVariant(models: string[], lead: number, variant: 'invmse' | 'recency' | 'concentrate', halflife: number): Map<string, number> {
    const mse = new Map<string, number>();
    for (const m of models) {
      const w = this.get(m, lead);
      const n = w.fs.length;
      if (n < this.cfg.sigmaMinN) continue;
      const bias = w.bias ?? 0;
      if (variant === 'recency') {
        const lambda = Math.pow(0.5, 1 / Math.max(1e-6, halflife));
        let num = 0;
        let den = 0;
        for (let i = 0; i < n; i++) {
          const decay = Math.pow(lambda, n - 1 - i); // age 0 = newest
          const r = correctPoint(w.fs[i]!, bias) - w.os[i]!;
          num += decay * r * r;
          den += decay;
        }
        mse.set(m, num / den);
      } else {
        let s = 0;
        for (let i = 0; i < n; i++) {
          const r = correctPoint(w.fs[i]!, bias) - w.os[i]!;
          s += r * r;
        }
        mse.set(m, s / n);
      }
    }
    if (variant === 'concentrate') {
      const inv = new Map<string, number>();
      let tot = 0;
      for (const [m, v] of mse) {
        const x = 1 / Math.max(v, 1e-6) ** 2;
        inv.set(m, x);
        tot += x;
      }
      const out = new Map<string, number>();
      for (const [m, x] of inv) out.set(m, tot > 0 ? x / tot : 0);
      return out;
    }
    return computeModelWeights(mse); // invmse + recency: 1/MSE on plain / decayed MSE
  }

  /** Fold one target day's (model→forecast, obs) into every involved window (chronological). */
  fold(points: { model: string; f: number }[], lead: number, obsC: number): void {
    for (const { model, f } of points) {
      const w = this.get(model, lead);
      w.bias = updateBias(w.bias, f - obsC, this.cfg.biasAlpha);
      w.fs.push(f);
      w.os.push(obsC);
      if (w.fs.length > this.cfg.sigmaWindowDays) {
        w.fs.shift();
        w.os.shift();
      }
    }
  }
}

// --- experiment -------------------------------------------------------------------

export interface MosArgs {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  shrinkK: number;
  /** Skip any (station,lead) cell with fewer than this many scored build-days (thin-cell noise guard). */
  minPairs: number;
}

export interface MosDeps {
  db: Db;
  log: (msg: string) => void;
}

interface Acc {
  n: number;
  se: Record<string, number>; // Σ squared error, keyed by arm name
  ae: Record<string, number>; // Σ |error|, keyed by arm name
}
const emptyAcc = (): Acc => ({ n: 0, se: {}, ae: {} });

// Blended-μ arms: 'baseline' = live model (baseline correction + invmse weights). mos/mos_shrunk vary
// the CORRECTION (probe #1, invmse weights held). recency/concentrate vary the WEIGHTS (probe #2,
// baseline correction held). All are measured against 'baseline'.
const BLEND_ARMS = ['baseline', 'mos', 'mos_shrunk', 'recency', 'concentrate'];

export async function runMosExperiment(args: MosArgs, deps: MosDeps): Promise<{
  overall: Acc;
  byLead: Map<string, Acc>;
  perModel: Map<string, Acc>; // single-model corrected point (blend-independent), key `${model}|${lead}`
  byStation: Map<string, Acc>;
}> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));
  const leadSet = new Set(args.leads);

  // scope: covered stations with finalized obs
  let stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit
     from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null
     join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const want = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => want.has(s.icao.toUpperCase()));
  }
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  const icaos = stationRows.map((s) => s.icao);
  if (icaos.length === 0) throw new Error('no stations in scope');

  // forecasts (backfill slot) → icao → targetISO → lead → model → tmaxC
  const fRows = await db.query<{ icao: string; model: string; target_date: string | Date; lead_days: number; tmax_c: string }>(
    `select icao, model, target_date, lead_days, tmax_c
     from forecast_snapshots
     where snapshot_slot = 'backfill' and icao = any($1) and lead_days = any($2) and target_date <= $3`,
    [icaos, args.leads, args.to],
  );
  const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
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

  // finalized observations → icao → targetISO → °C
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit
     from observations where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obs = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const m = obs.get(r.icao) ?? new Map<string, number>();
    const native = Number(r.tmax_wu_native);
    m.set(dISO(r.date_local), (r.unit ?? unitByIcao.get(r.icao)) === 'F' ? fToC(native) : native);
    obs.set(r.icao, m);
  }

  const stateByIcao = new Map(icaos.map((i) => [i, new StationModel(cfg, args.shrinkK)]));

  const overall = emptyAcc();
  const byLead = new Map<string, Acc>();
  const perModel = new Map<string, Acc>();
  const byStation = new Map<string, Acc>();
  const bump = (acc: Acc, arm: string, err: number) => {
    acc.se[arm] = (acc.se[arm] ?? 0) + err * err;
    acc.ae[arm] = (acc.ae[arm] ?? 0) + Math.abs(err);
  };
  const recencyHalflife = 10; // probe #2 recency window half-life (days)
  const get = (m: Map<string, Acc>, k: string): Acc => {
    let a = m.get(k);
    if (!a) {
      a = emptyAcc();
      m.set(k, a);
    }
    return a;
  };

  // warm-up: fold everything strictly before `from` so the walk starts with primed windows.
  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);
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
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  // the walk: build (score) each (icao, target, lead), then fold the day's truth.
  for (const d of listDatesISO(args.from, args.to)) {
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) continue;
      const sm = stateByIcao.get(icao)!;
      for (const [lead, byModel] of byLeadMap) {
        if (!leadSet.has(lead)) continue;
        const entries = [...byModel].map(([model, f]) => ({ model, f }));
        if (entries.length === 0) continue;

        // per-model corrected-point error (blend-independent aim signal)
        for (const { model, f } of entries) {
          const pm = get(perModel, `${model}|${lead}`);
          pm.n++;
          for (const arm of ARMS) bump(pm, arm, sm.correctedPoint(arm, model, lead, f) - o);
        }

        // blended house μ. A weighted mean of corrected points; the (correction, weights) pair
        // is what each arm varies. 'baseline' = the live model.
        const ms = entries.map((e) => e.model);
        const blendWith = (correction: Arm, weights: Map<string, number>): number => {
          const haveW = [...weights.values()].some((v) => v > 0);
          let num = 0;
          let den = 0;
          for (const { model, f } of entries) {
            const weight = haveW ? (weights.get(model) ?? 0) : 1 / entries.length;
            if (weight <= 0) continue;
            num += weight * sm.correctedPoint(correction, model, lead, f);
            den += weight;
          }
          return den > 0 ? num / den : NaN;
        };
        const wInv = sm.baselineWeights(ms, lead);
        const errs: { arm: string; mu: number }[] = [
          { arm: 'baseline', mu: blendWith('baseline', wInv) }, // live model (== invmse weights)
          { arm: 'mos', mu: blendWith('mos', wInv) }, // probe #1: correction varies
          { arm: 'mos_shrunk', mu: blendWith('mos_shrunk', wInv) },
          { arm: 'recency', mu: blendWith('baseline', sm.weightsVariant(ms, lead, 'recency', recencyHalflife)) }, // probe #2: weights vary
          { arm: 'concentrate', mu: blendWith('baseline', sm.weightsVariant(ms, lead, 'concentrate', 0)) },
        ];
        if (errs.some((e) => Number.isNaN(e.mu))) continue;
        for (const lvl of [overall, get(byLead, String(lead)), get(byStation, icao)]) lvl.n++;
        for (const { arm, mu } of errs) {
          for (const lvl of [overall, get(byLead, String(lead)), get(byStation, icao)]) bump(lvl, arm, mu - o);
        }
      }
    }
    for (const icao of icaos) foldDay(icao, d);
  }

  // --- report ----------------------------------------------------------------------
  const rmse = (a: Acc, arm: string) => Math.sqrt((a.se[arm] ?? 0) / Math.max(1, a.n));
  const pct = (base: number, x: number) => ((base - x) / base) * 100;
  const fmt = (a: Acc, label: string, arms: string[]) => {
    const base = rmse(a, arms[0]!);
    const parts = arms.map((arm, i) =>
      i === 0
        ? `${arm} ${base.toFixed(4)}`
        : `${arm} ${rmse(a, arm).toFixed(4)} (${pct(base, rmse(a, arm)) >= 0 ? '+' : ''}${pct(base, rmse(a, arm)).toFixed(2)}%)`,
    );
    return `${label.padEnd(15)} n=${String(a.n).padStart(6)}  RMSE ${parts.join('  ')}`;
  };
  const CORR_ARMS = ['baseline', 'mos', 'mos_shrunk'];

  log(`=== mos-pointskill ${args.from} → ${args.to} · leads ${args.leads.join(',')} · shrinkK ${args.shrinkK} · recencyHL ${recencyHalflife}d ===`);
  log(`scope: ${icaos.length} stations · ${overall.n} blended build-days scored`);
  log('(% = RMSE reduction vs baseline=live model; positive = arm BEATS the live model. point error °C.)');
  log('');
  log('BLENDED HOUSE μ — probe #1 correction arms (mos/mos_shrunk) + probe #2 weighting arms (recency/concentrate):');
  log('  ' + fmt(overall, 'overall', BLEND_ARMS));
  for (const lead of [...byLead.keys()].sort((a, b) => Number(a) - Number(b))) {
    log('  ' + fmt(byLead.get(lead)!, `lead ${lead}`, BLEND_ARMS));
  }
  log('');
  log('PER-STATION (blended; thin cells < minPairs omitted):');
  for (const icao of [...byStation.keys()].sort()) {
    const a = byStation.get(icao)!;
    if (a.n >= args.minPairs) log('  ' + fmt(a, icao, BLEND_ARMS));
  }
  log('');
  log('PER-MODEL corrected point (blend-independent — does slope correction fix each model\'s aim?):');
  for (const k of [...perModel.keys()].sort()) {
    const a = perModel.get(k)!;
    if (a.n >= args.minPairs) log('  ' + fmt(a, k, CORR_ARMS));
  }
  log('');
  log('NOTE: ladder-free point RMSE in °C over the full backfill is the AIM proxy (DF-5). A real');
  log('Brier/edge gain still needs the 30-day market-overlap re-run; this probe decides which lever');
  log('(correction vs weighting) is worth wiring into the calibration fold first.');
  return { overall, byLead, perModel, byStation };
}

// --- self-test + CLI --------------------------------------------------------------

function sanity(): void {
  // perfect line y = 2 + 0.5x → slope 0.5, intercept 2
  const xs = [0, 2, 4, 6, 8];
  const ys = xs.map((x) => 2 + 0.5 * x);
  const fit = olsFit(xs, ys)!;
  if (Math.abs(fit.b - 0.5) > 1e-9 || Math.abs(fit.a - 2) > 1e-9) {
    throw new Error(`olsFit self-test failed: got a=${fit.a} b=${fit.b}`);
  }
  // shrink toward 1: with k = n, slope halves the distance to 1 → 0.5 → 0.75
  const sh = shrinkFit(fit, 4, 5, 5);
  if (Math.abs(sh.b - 0.75) > 1e-9) throw new Error(`shrinkFit self-test failed: got b=${sh.b}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      'shrink-k': { type: 'string' },
      'min-pairs': { type: 'string' },
    },
  });
  const db = makeScriptDb();
  try {
    await runMosExperiment(
      {
        from: values.from ?? '2025-01-01',
        to: values.to ?? '2026-06-12',
        leads: (splitList(values.leads) ?? ['1', '2', '3']).map(Number),
        stations: splitList(values.stations),
        shrinkK: values['shrink-k'] ? Number(values['shrink-k']) : 10,
        minPairs: values['min-pairs'] ? Number(values['min-pairs']) : 200,
      },
      { db, log: console.log },
    );
  } finally {
    await db.end();
  }
}
