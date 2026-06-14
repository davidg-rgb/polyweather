/**
 * scripts/research/wo3-regime-weighting — WO-3 (FORECASTING-RD-HANDOFF), DF5 lever 1 (regime half).
 *
 * HYPOTHESIS: model skill depends on the synoptic regime; weighting each model by its skill WITHIN
 * the current regime beats flat inverse-MSE. This is a DIFFERENT mechanism than L3-b — it reallocates
 * blend weight by regime-specific skill *ranking*, not a residual prediction — so it's measured even
 * though L3-b found ~0 residual structure.
 *
 * METHOD (controlled A/B, read-only, walk-forward): baseline = the LIVE model (imported StationModel:
 * per-model `f − EMA_bias`, global inverse-MSE weights). Regime arms keep PER-(model, lead, regime)
 * residual windows and, at build, classify the day's regime and weight by regime-specific inverse-MSE,
 * shrunk toward the global weights by n_regime/(n_regime + k) (overfit guard); fall back to global when
 * the regime is thin (< sigmaMinN). ONLY the weights change — correction held at baseline. Metric =
 * ladder-free point RMSE °C over the full backfill.
 *
 *   regime_season       — DJF / MAM / JJA / SON (deterministic from month; no threshold fitting)
 *   regime_disagreement — lo / mid / hi tercile of the day's cross-model spread, cutoffs from the
 *                         station's rolling PRIOR spreads (walk-forward; disagreement was L3-b's
 *                         strongest covariate at corr 0.0745)
 *
 * Run: pnpm tsx scripts/research/wo3-regime-weighting.ts [--from] [--to] [--leads 1,2,3] [--shrink-k 12]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { computeModelWeights, fToC, parseConfigRows, type AppConfig } from '../../packages/core/src/index.ts';
import { StationModel } from './mos-pointskill.ts';
import { addDaysISO, listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'wo3-regime-weighting';

const SEASONS = ['DJF', 'MAM', 'JJA', 'SON'];
export const seasonOf = (month0: number): string => SEASONS[Math.floor(((month0 + 1) % 12) / 3)]!;

/** Tercile label of x against sorted prior cutoffs [c33, c67]; 'mid' until enough history. */
export function tercile(x: number, cutoffs: [number, number] | null): 'lo' | 'mid' | 'hi' {
  if (!cutoffs) return 'mid';
  if (x <= cutoffs[0]) return 'lo';
  if (x >= cutoffs[1]) return 'hi';
  return 'mid';
}
export function terciles(sorted: number[]): [number, number] | null {
  const n = sorted.length;
  if (n < 30) return null;
  return [sorted[Math.floor(n / 3)]!, sorted[Math.floor((2 * n) / 3)]!];
}

type Arm = 'baseline' | 'regime_season' | 'regime_disagreement';
const ARMS: Arm[] = ['baseline', 'regime_season', 'regime_disagreement'];

interface Acc {
  n: number;
  se: Record<string, number>;
}
const emptyAcc = (): Acc => ({ n: 0, se: {} });

export interface Wo3Args {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  shrinkK: number;
  minPairs: number;
}
export interface Wo3Deps {
  db: Db;
  log: (msg: string) => void;
}

/** Regime skill windows layered on the imported baseline StationModel (which owns correction + global weights). */
class RegimeStation {
  private readonly base: StationModel;
  private readonly regimeResid = new Map<string, number[]>(); // `${regime}|${model}|${lead}` → corrected residuals
  private readonly spreadHist = new Map<number, number[]>(); // lead → rolling spreads (asc-sorted lazily)
  private readonly spreadCut = new Map<number, [number, number] | null>();

  constructor(private readonly cfg: AppConfig, shrinkK: number) {
    this.base = new StationModel(cfg, shrinkK);
    this.shrinkK = shrinkK;
  }
  private readonly shrinkK: number;

  private key(regime: string, model: string, lead: number): string {
    return `${regime}|${model}|${lead}`;
  }

  correctedPoints(entries: { model: string; f: number }[], lead: number): { model: string; c: number }[] {
    return entries.map((e) => ({ model: e.model, c: this.base.correctedPoint('baseline', e.model, lead, e.f) }));
  }

  spreadOf(corrected: { c: number }[]): number {
    const m = corrected.reduce((a, b) => a + b.c, 0) / corrected.length;
    return Math.sqrt(corrected.reduce((a, b) => a + (b.c - m) ** 2, 0) / corrected.length);
  }

  /** Regime label for one arm at build time. */
  regimeFor(arm: Arm, month0: number, spread: number, lead: number): string {
    if (arm === 'regime_season') return seasonOf(month0);
    if (arm === 'regime_disagreement') return tercile(spread, this.spreadCut.get(lead) ?? null);
    return 'all';
  }

  /** Global (live) inverse-MSE weights for the blend baseline. */
  globalWeights(models: string[], lead: number): Map<string, number> {
    return this.base.baselineWeights(models, lead);
  }

  /** Regime weights = inverse-MSE on the (regime,model,lead) window, shrunk toward global by n/(n+k). */
  regimeWeights(models: string[], lead: number, regime: string, global: Map<string, number>): Map<string, number> {
    const mse = new Map<string, number>();
    let nMin = Infinity;
    for (const m of models) {
      const res = this.regimeResid.get(this.key(regime, m, lead));
      if (res && res.length >= this.cfg.sigmaMinN) {
        mse.set(m, res.reduce((a, r) => a + r * r, 0) / res.length);
        nMin = Math.min(nMin, res.length);
      }
    }
    if (mse.size === 0) return global; // regime entirely thin → live weights
    const regimeW = computeModelWeights(mse);
    const alpha = nMin / (nMin + this.shrinkK);
    const out = new Map<string, number>();
    let tot = 0;
    for (const m of models) {
      // a model with no regime sample keeps its global weight (not zeroed)
      const rw = mse.has(m) ? (regimeW.get(m) ?? 0) : (global.get(m) ?? 0);
      const v = alpha * rw + (1 - alpha) * (global.get(m) ?? 0);
      out.set(m, v);
      tot += v;
    }
    if (tot <= 0) return global;
    for (const [m, v] of out) out.set(m, v / tot);
    return out;
  }

  /** Fold one target day: append regime residuals (pre-fold bias), update spread cutoffs, then fold baseline. */
  fold(entries: { model: string; f: number }[], lead: number, obsC: number, month0: number): void {
    const corrected = this.correctedPoints(entries, lead);
    const spread = this.spreadOf(corrected);
    // record this day's residuals into BOTH regime taxonomies' buckets (season + the disagreement tercile)
    const regimes = [seasonOf(month0), tercile(spread, this.spreadCut.get(lead) ?? null)];
    for (const { model, c } of corrected) {
      const resid = c - obsC;
      for (const regime of regimes) {
        const k = this.key(regime, model, lead);
        const arr = this.regimeResid.get(k) ?? [];
        arr.push(resid);
        if (arr.length > this.cfg.sigmaWindowDays) arr.shift();
        this.regimeResid.set(k, arr);
      }
    }
    // update rolling spread distribution + cutoffs (bounded history for stationarity)
    const hist = this.spreadHist.get(lead) ?? [];
    hist.push(spread);
    if (hist.length > 400) hist.shift();
    this.spreadHist.set(lead, hist);
    this.spreadCut.set(lead, terciles([...hist].sort((a, b) => a - b)));
    // fold the baseline model (updates EMA bias + global windows)
    this.base.fold(entries, lead, obsC);
  }
}

export async function runWo3(args: Wo3Args, deps: Wo3Deps): Promise<{ overall: Acc; byStation: Map<string, Acc> }> {
  const { db, log } = deps;
  const cfg = parseConfigRows(await db.query<{ key: string; value: string }>(`select key, value from config`));
  const leadSet = new Set(args.leads);

  let stationRows = await db.query<{ icao: string; unit: 'C' | 'F' }>(
    `select distinct s.icao, c.unit from stations s
     join city_stations cs on cs.icao = s.icao and cs.valid_to is null join cities c on c.id = cs.city_id`,
  );
  if (args.stations) {
    const want = new Set(args.stations.map((s) => s.toUpperCase()));
    stationRows = stationRows.filter((s) => want.has(s.icao.toUpperCase()));
  }
  const unitByIcao = new Map(stationRows.map((s) => [s.icao, s.unit]));
  const icaos = stationRows.map((s) => s.icao);
  if (icaos.length === 0) throw new Error('no stations in scope');

  const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
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
  const oRows = await db.query<{ icao: string; date_local: string | Date; tmax_wu_native: number; unit: 'C' | 'F' }>(
    `select icao, date_local, tmax_wu_native, unit from observations
     where finalized_at is not null and icao = any($1) and date_local <= $2`,
    [icaos, args.to],
  );
  const obs = new Map<string, Map<string, number>>();
  for (const r of oRows) {
    const m = obs.get(r.icao) ?? new Map<string, number>();
    m.set(dISO(r.date_local), (r.unit ?? unitByIcao.get(r.icao)) === 'F' ? fToC(Number(r.tmax_wu_native)) : Number(r.tmax_wu_native));
    obs.set(r.icao, m);
  }

  const state = new Map(icaos.map((i) => [i, new RegimeStation(cfg, args.shrinkK)]));
  const monthOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCMonth();
  const foldDay = (icao: string, t: string): void => {
    const o = obs.get(icao)?.get(t);
    const byLeadMap = fc.get(icao)?.get(t);
    if (o === undefined || !byLeadMap) return;
    const rs = state.get(icao)!;
    for (const [lead, byModel] of byLeadMap) {
      if (!leadSet.has(lead)) continue;
      rs.fold([...byModel].map(([model, f]) => ({ model, f })), lead, o, monthOf(t));
    }
  };
  const allTargets = new Set<string>();
  for (const byT of fc.values()) for (const t of byT.keys()) allTargets.add(t);
  for (const t of [...allTargets].sort()) if (t < args.from) for (const icao of icaos) foldDay(icao, t);

  const overall = emptyAcc();
  const byStation = new Map<string, Acc>();
  const bump = (acc: Acc, arm: string, err: number) => {
    acc.se[arm] = (acc.se[arm] ?? 0) + err * err;
  };
  const getS = (icao: string): Acc => {
    let a = byStation.get(icao);
    if (!a) {
      a = emptyAcc();
      byStation.set(icao, a);
    }
    return a;
  };

  for (const d of listDatesISO(args.from, args.to)) {
    const month0 = monthOf(d);
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) continue;
      const rs = state.get(icao)!;
      for (const [lead, byModel] of byLeadMap) {
        if (!leadSet.has(lead)) continue;
        const entries = [...byModel].map(([model, f]) => ({ model, f }));
        if (entries.length === 0) continue;
        const corrected = rs.correctedPoints(entries, lead);
        const spread = rs.spreadOf(corrected);
        const models = entries.map((e) => e.model);
        const global = rs.globalWeights(models, lead);
        const blend = (weights: Map<string, number>): number => {
          const haveW = [...weights.values()].some((v) => v > 0);
          let num = 0;
          let den = 0;
          for (const { model, c } of corrected) {
            const w = haveW ? (weights.get(model) ?? 0) : 1 / corrected.length;
            if (w <= 0) continue;
            num += w * c;
            den += w;
          }
          return den > 0 ? num / den : NaN;
        };
        const mus: Record<Arm, number> = {
          baseline: blend(global),
          regime_season: blend(rs.regimeWeights(models, lead, rs.regimeFor('regime_season', month0, spread, lead), global)),
          regime_disagreement: blend(rs.regimeWeights(models, lead, rs.regimeFor('regime_disagreement', month0, spread, lead), global)),
        };
        if (ARMS.some((a) => Number.isNaN(mus[a]))) continue;
        overall.n++;
        getS(icao).n++;
        for (const a of ARMS) {
          bump(overall, a, mus[a] - o);
          bump(getS(icao), a, mus[a] - o);
        }
      }
    }
    for (const icao of icaos) foldDay(icao, d);
  }

  // --- report ----------------------------------------------------------------------
  const rmse = (a: Acc, arm: string) => Math.sqrt((a.se[arm] ?? 0) / Math.max(1, a.n));
  const pct = (base: number, x: number) => ((base - x) / base) * 100;
  const fmt = (a: Acc, label: string) => {
    const base = rmse(a, 'baseline');
    const parts = ARMS.map((arm) =>
      arm === 'baseline'
        ? `baseline ${base.toFixed(4)}`
        : `${arm} ${rmse(a, arm).toFixed(4)} (${pct(base, rmse(a, arm)) >= 0 ? '+' : ''}${pct(base, rmse(a, arm)).toFixed(2)}%)`,
    );
    return `${label.padEnd(15)} n=${String(a.n).padStart(6)}  RMSE ${parts.join('  ')}`;
  };

  log(`=== wo3-regime-weighting ${args.from} → ${args.to} · leads ${args.leads.join(',')} · shrinkK ${args.shrinkK} ===`);
  log(`scope: ${icaos.length} stations · ${overall.n} blended build-days (% = RMSE reduction vs live baseline)`);
  log('');
  log('BLENDED HOUSE μ — regime-weighted vs live inverse-MSE (correction held at baseline):');
  log('  ' + fmt(overall, 'overall'));
  log('');
  log('PER-STATION (thin cells < minPairs omitted):');
  for (const icao of [...byStation.keys()].sort()) {
    const a = byStation.get(icao)!;
    if (a.n >= args.minPairs) log('  ' + fmt(a, icao));
  }
  log('');
  const best = Math.max(pct(rmse(overall, 'baseline'), rmse(overall, 'regime_season')), pct(rmse(overall, 'baseline'), rmse(overall, 'regime_disagreement')));
  log(
    best >= 1.5
      ? `VERDICT: a regime arm clears the +1.5% bar (best ${best.toFixed(2)}%) — worth a productionization sketch.`
      : `VERDICT: REJECTED — best regime arm ${best.toFixed(2)}% < +1.5% bar. Regime weighting does not move ` +
        `μ-aim; the model skill RANKING is regime-stable (consistent with L3-b's near-zero structure).`,
  );
  return { overall, byStation };
}

// --- CLI --------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
    await runWo3(
      {
        from: values.from ?? '2025-01-01',
        to: values.to ?? '2026-06-12',
        leads: (splitList(values.leads) ?? ['1', '2', '3']).map(Number),
        stations: splitList(values.stations),
        shrinkK: values['shrink-k'] ? Number(values['shrink-k']) : 12,
        minPairs: values['min-pairs'] ? Number(values['min-pairs']) : 300,
      },
      { db, log: console.log },
    );
  } finally {
    await db.end();
  }
}
