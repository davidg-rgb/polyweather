/**
 * scripts/research/l3b-residual-structure — WO-L3-b (FORECASTING-RD-HANDOFF).
 *
 * THE DECISION: do better INPUTS/FEATURES even have headroom, or is the live blend residual
 * irreducible noise? Probes #1/#2 showed correction + reweighting are exhausted. Before chasing a
 * new source (L3-c) or a feature correction, measure whether the live blend's residual (μ − obs)
 * carries STRUCTURE that an observable feature could explain. If the residual is ~uncorrelated with
 * every cheap covariate (its multivariate R² upper bound is tiny), then the point-skill ceiling is
 * irreducible NWP error → a feature/MOS lever is dead and lever-3 means a genuinely better SOURCE.
 * If structure exists, it NAMES the feature to add.
 *
 * READ-ONLY. Walk-forward over the backfill, baseline = the LIVE model exactly (imported StationModel).
 * Residual r = blended μ − obs (°C). Features (covariates, NOT forecast inputs — used only to detect
 * structure): cross-model disagreement (std of corrected points), seasonal sin/cos (day-of-year),
 * forecast anomaly (μ − station monthly climatology), lead. Reports per-feature Pearson |corr| and the
 * multivariate in-sample R² (an UPPER bound on exploitable variance — if even this is tiny, OOS is hopeless).
 *
 * Run: pnpm tsx scripts/research/l3b-residual-structure.ts [--from] [--to] [--leads 1,2,3] [--stations]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fToC, parseConfigRows } from '../../packages/core/src/index.ts';
import { StationModel } from './mos-pointskill.ts';
import { addDaysISO, listDatesISO, splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'l3b-residual-structure';

// --- pure stats -------------------------------------------------------------------

export function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const den = Math.sqrt(sxx * syy);
  return den < 1e-12 ? 0 : sxy / den;
}

/**
 * Multiple OLS R² of y on the feature columns (intercept added internally), via ridged normal
 * equations solved by Gaussian elimination. Ridge λ stabilizes a near-singular XᵀX without
 * materially shrinking R² at this n. Returns the coefficient of determination in [0, 1].
 */
export function multiOlsR2(rows: number[][], y: number[], lambda = 1e-6): number {
  const n = rows.length;
  if (n < 3) return 0;
  const k = rows[0]!.length + 1; // + intercept
  const X = rows.map((r) => [1, ...r]);
  // A = XᵀX + λI (skip ridging the intercept), b = Xᵀy
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const b = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let p = 0; p < k; p++) {
      b[p] += X[i]![p]! * y[i]!;
      for (let q = 0; q < k; q++) A[p]![q] += X[i]![p]! * X[i]![q]!;
    }
  }
  for (let p = 1; p < k; p++) A[p]![p] += lambda;
  const beta = solve(A, b);
  if (!beta) return 0;
  const ybar = y.reduce((a, c) => a + c, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let p = 0; p < k; p++) pred += beta[p]! * X[i]![p]!;
    ssRes += (y[i]! - pred) ** 2;
    ssTot += (y[i]! - ybar) ** 2;
  }
  return ssTot < 1e-12 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const k = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    const pivRow = M[col]!;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const row = M[r]!;
      const f = row[col]! / pivRow[col]!;
      for (let c = col; c <= k; c++) row[c] = row[c]! - f * pivRow[c]!;
    }
  }
  return M.map((row, i) => row[k]! / row[i]!);
}

// --- experiment -------------------------------------------------------------------

export interface L3bArgs {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
}
export interface L3bDeps {
  db: Db;
  log: (msg: string) => void;
}

interface Sample {
  r: number; // residual μ − obs (°C)
  spread: number;
  sin: number;
  cos: number;
  anomaly: number;
  lead: number;
}

export async function runL3b(args: L3bArgs, deps: L3bDeps): Promise<{ n: number; r2: number; residStd: number }> {
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
  const climSum = new Map<string, number[]>(); // icao → 12 [sum, ...]
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

  const stateByIcao = new Map(icaos.map((i) => [i, new StationModel(cfg, 10)]));
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
  const perStationResid = new Map<string, number[]>();

  for (const d of listDatesISO(args.from, args.to)) {
    const month = new Date(`${d}T00:00:00Z`).getUTCMonth();
    const doy = (Date.UTC(2001, month, new Date(`${d}T00:00:00Z`).getUTCDate()) - Date.UTC(2001, 0, 1)) / 86_400_000;
    const ang = (2 * Math.PI * doy) / 365.25;
    for (const icao of icaos) {
      const o = obs.get(icao)?.get(d);
      const byLeadMap = fc.get(icao)?.get(d);
      if (o === undefined || !byLeadMap) continue;
      const sm = stateByIcao.get(icao)!;
      for (const [lead, byModel] of byLeadMap) {
        if (!leadSet.has(lead)) continue;
        const entries = [...byModel].map(([model, f]) => ({ model, f }));
        if (entries.length === 0) continue;
        const corrected = entries.map((e) => sm.correctedPoint('baseline', e.model, lead, e.f));
        const w = sm.baselineWeights(entries.map((e) => e.model), lead);
        const haveW = [...w.values()].some((v) => v > 0);
        let num = 0;
        let den = 0;
        entries.forEach((e, i) => {
          const weight = haveW ? (w.get(e.model) ?? 0) : 1 / entries.length;
          if (weight <= 0) return;
          num += weight * corrected[i]!;
          den += weight;
        });
        if (den <= 0) continue;
        const mu = num / den;
        const cm = corrected.reduce((a, b) => a + b, 0) / corrected.length;
        const spread = Math.sqrt(corrected.reduce((a, b) => a + (b - cm) ** 2, 0) / corrected.length);
        const cl = clim(icao, month);
        samples.push({
          r: mu - o,
          spread,
          sin: Math.sin(ang),
          cos: Math.cos(ang),
          anomaly: Number.isNaN(cl) ? 0 : mu - cl,
          lead,
        });
        const ps = perStationResid.get(icao) ?? [];
        ps.push(mu - o);
        perStationResid.set(icao, ps);
      }
    }
    for (const icao of icaos) foldDay(icao, d);
  }

  // --- analysis --------------------------------------------------------------------
  const rs = samples.map((s) => s.r);
  const n = rs.length;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const std = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
  const residStd = std(rs);
  const feat: { name: string; vals: number[] }[] = [
    { name: 'disagreement', vals: samples.map((s) => s.spread) },
    { name: 'season_sin', vals: samples.map((s) => s.sin) },
    { name: 'season_cos', vals: samples.map((s) => s.cos) },
    { name: 'anomaly', vals: samples.map((s) => s.anomaly) },
    { name: 'lead', vals: samples.map((s) => s.lead) },
  ];
  const rowsMat = samples.map((s) => [s.spread, s.sin, s.cos, s.anomaly, s.lead]);
  const r2 = multiOlsR2(rowsMat, rs);

  log(`=== l3b-residual-structure ${args.from} → ${args.to} · leads ${args.leads.join(',')} ===`);
  log(`scope: ${icaos.length} stations · ${n} walk-forward baseline builds`);
  log(`residual (μ − obs): mean ${mean(rs).toFixed(4)}°C (≈0 confirms bias-corrected) · std ${residStd.toFixed(4)}°C ← the variance to explain`);
  log('');
  log('per-feature Pearson corr with the residual (|corr| → fraction of residual SD a single feature tracks):');
  for (const f of feat) log(`  ${f.name.padEnd(14)} corr ${pearson(f.vals, rs).toFixed(4)}`);
  log('');
  log(`MULTIVARIATE in-sample R² of residual on ALL features: ${(r2 * 100).toFixed(2)}%  (UPPER bound on exploitable variance)`);
  log('');
  log('per-station residual (does station-level bias survive the blend? mean should be ≈0):');
  for (const icao of [...perStationResid.keys()].sort()) {
    const ps = perStationResid.get(icao)!;
    if (ps.length >= 200) log(`  ${icao.padEnd(6)} n=${String(ps.length).padStart(5)}  mean ${mean(ps).toFixed(3)}  std ${std(ps).toFixed(3)}`);
  }
  log('');
  const verdict =
    r2 < 0.03
      ? `VERDICT: NO exploitable structure (R² ${(r2 * 100).toFixed(2)}% < 3% upper bound). The residual is ` +
        `effectively irreducible NWP error → a feature/MOS correction lever is DEAD. Lever-3 means a ` +
        `genuinely BETTER SOURCE (→ run L3-c), not a feature. Consistent with probes #1/#2.`
      : `VERDICT: structure EXISTS (R² ${(r2 * 100).toFixed(2)}%). Strongest feature(s) by |corr| name the ` +
        `candidate correction. Worth a walk-forward feature-correction arm before concluding.`;
  log(verdict);
  return { n, r2, residStd };
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
    },
  });
  const db = makeScriptDb();
  try {
    await runL3b(
      {
        from: values.from ?? '2025-01-01',
        to: values.to ?? '2026-06-12',
        leads: (splitList(values.leads) ?? ['1', '2', '3']).map(Number),
        stations: splitList(values.stations),
      },
      { db, log: console.log },
    );
  } finally {
    await db.end();
  }
}
