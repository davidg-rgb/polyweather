/**
 * Tests for core/sim/selector-learn — REC-1: is badatmath's cheap-bucket selection learnable OOS?
 * Covers the logistic primitives (sigmoid, standardiser, L2 fit + convergence), the cluster-mean
 * t-interval (the honest few-cluster gate), in-sample + leave-one-cluster-out selection, the zero-skill
 * calibration-null, and the frozen three-branch verdict (PASS on a strong learnable signal across many
 * clusters, FAIL on noise, INSUFFICIENT_DATA below MIN_CLUSTERS). All pure — no network, no DB;
 * deterministic (seeded). The end-to-end controls use REALISTIC geometry (continuous features + varying
 * restPx in [0.10,0.25)) — the geometry the real universe has, where the gate calibrates honestly.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/calibration/scores.ts';
import {
  SELECTOR_LEARN,
  type LabeledPick,
  type SelectedPick,
  clusterMeanTCi,
  fitLogisticL2,
  fitStandardizer,
  inSampleSelect,
  leaveOneClusterOut,
  predictProba,
  runSelectorLearn,
  selectionStats,
  selectorVerdict,
  sigmoid,
  standardizeRow,
  tCritical95,
  zeroSkillNull,
} from '../src/sim/selector-learn.ts';

/**
 * Realistic synthetic universe (deterministic via a seeded RNG). Each pick: a continuous restPx in
 * [0.10,0.24), a continuous signal feature x, a noise feature, and restPx itself as a feature. The true
 * win prob is `restPx + effect·(x−0.5)` — so when `effect>0` high-x buckets are genuinely underpriced
 * (a learnable signal); `effect=0` is a perfectly-calibrated market (pure noise, true edge 0).
 */
function universe(o: { nClusters: number; perCluster: number; effect: number; seed: number }): LabeledPick[] {
  const rand = mulberry32(o.seed);
  const out: LabeledPick[] = [];
  for (let c = 0; c < o.nClusters; c++) {
    const cluster = `2026-06-${String(c + 1).padStart(2, '0')}`;
    for (let i = 0; i < o.perCluster; i++) {
      const restPx = 0.1 + rand() * 0.14;
      const x = rand();
      const noise = rand();
      const trueP = Math.min(0.95, Math.max(0, restPx + o.effect * (x - 0.5)));
      const won = rand() < trueP;
      out.push({ features: [x, noise, restPx], restPx, won, cluster, feeRate: 0.05 });
    }
  }
  return out;
}

describe('sigmoid', () => {
  it('is 0.5 at 0, monotone, and stable at large |z|', () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(50)).toBeGreaterThan(0.99);
    expect(sigmoid(-50)).toBeLessThan(0.01);
    expect(Number.isFinite(sigmoid(1000))).toBe(true);
    expect(Number.isFinite(sigmoid(-1000))).toBe(true);
    expect(Number.isNaN(sigmoid(NaN))).toBe(true);
  });
});

describe('tCritical95', () => {
  it('matches the t-table for small df and falls back to z for df > 30', () => {
    expect(tCritical95(1)).toBeCloseTo(12.706, 3);
    expect(tCritical95(3)).toBeCloseTo(3.182, 3);
    expect(tCritical95(7)).toBeCloseTo(2.365, 3);
    expect(tCritical95(50)).toBeCloseTo(1.96, 2);
    expect(Number.isNaN(tCritical95(0))).toBe(true);
  });
});

describe('fitStandardizer / standardizeRow', () => {
  it('computes per-column mean + population SD; a constant column maps to 0', () => {
    const { mean, std } = fitStandardizer([
      [0, 5],
      [2, 5],
    ]);
    expect(mean).toEqual([1, 5]);
    expect(std[0]).toBeCloseTo(1, 9); // population SD of {0,2} = 1
    expect(std[1]).toBe(0); // constant column
    const z = standardizeRow([2, 5], mean, std);
    expect(z[0]).toBeCloseTo(1, 9);
    expect(z[1]).toBe(0); // constant feature contributes nothing
  });
  it('is total on empty', () => {
    expect(fitStandardizer([])).toEqual({ mean: [], std: [] });
  });
});

describe('fitLogisticL2 / predictProba', () => {
  it('converges on a linearly-separable toy (high feature ⇒ high pWin)', () => {
    const X = [[0], [0], [1], [1], [2], [2]];
    const y = [0, 0, 0, 1, 1, 1];
    const model = fitLogisticL2(X, y, { l2: 0.01, iters: 400, lr: 0.5 });
    expect(predictProba(model, [2])).toBeGreaterThan(predictProba(model, [0]));
    expect(predictProba(model, [2])).toBeGreaterThan(0.5);
    expect(predictProba(model, [0])).toBeLessThan(0.5);
  });
  it('empty fit ⇒ empty model ⇒ predictProba 0.5; non-finite row ⇒ NaN (never selectable)', () => {
    const empty = fitLogisticL2([], []);
    expect(empty.weights).toEqual([]);
    expect(predictProba(empty, [1])).toBe(0.5);
    const model = fitLogisticL2([[0], [1]], [0, 1], { iters: 50 });
    expect(Number.isNaN(predictProba(model, [NaN]))).toBe(true);
  });
  it('is deterministic (no RNG): two fits are byte-identical', () => {
    const X = [[0], [1], [2]];
    const y = [0, 1, 1];
    const a = fitLogisticL2(X, y, { iters: 100 });
    const b = fitLogisticL2(X, y, { iters: 100 });
    expect(a.weights).toEqual(b.weights);
    expect(a.bias).toBe(b.bias);
  });
});

describe('clusterMeanTCi', () => {
  it('collapses to the point on identical values', () => {
    const ci = clusterMeanTCi([0.2, 0.2, 0.2, 0.2], ['a', 'a', 'b', 'b']);
    expect(ci.mean).toBeCloseTo(0.2, 9);
    expect(ci.lo).toBeCloseTo(0.2, 9);
    expect(ci.hi).toBeCloseTo(0.2, 9);
  });
  it('a single cluster ⇒ a degenerate CI at its mean (no between-cluster spread)', () => {
    const ci = clusterMeanTCi([0.1, 0.9], ['a', 'a']);
    expect(ci.mean).toBeCloseTo(0.5, 9);
    expect(ci.lo).toBe(ci.mean);
    expect(ci.hi).toBe(ci.mean);
  });
  it('weights clusters EQUALLY (a big cluster does not dominate the mean)', () => {
    // cluster a: 100 values at 0; cluster b: 1 value at 1 → equal-weight cluster mean = 0.5.
    const vals = [...Array<number>(100).fill(0), 1];
    const clusters = [...Array<string>(100).fill('a'), 'b'];
    const ci = clusterMeanTCi(vals, clusters);
    expect(ci.mean).toBeCloseTo(0.5, 9);
  });
  it('widens for fewer clusters (t-explosion) — same spread, 3 vs 8 clusters', () => {
    const mk = (k: number) => {
      const vals: number[] = [];
      const cl: string[] = [];
      for (let c = 0; c < k; c++) {
        vals.push(c % 2 === 0 ? 0.0 : 0.2); // alternating cluster means → fixed between-cluster spread
        cl.push(`c${c}`);
      }
      return clusterMeanTCi(vals, cl);
    };
    const w3 = mk(3).hi - mk(3).lo;
    const w8 = mk(8).hi - mk(8).lo;
    expect(w3).toBeGreaterThan(w8);
  });
  it('is total on empty / mismatched input', () => {
    expect(clusterMeanTCi([], [])).toEqual({ mean: NaN, lo: NaN, hi: NaN });
    expect(clusterMeanTCi([1], ['a', 'b'])).toEqual({ mean: NaN, lo: NaN, hi: NaN });
  });
});

describe('inSampleSelect / leaveOneClusterOut', () => {
  const learnable = universe({ nClusters: 8, perCluster: 30, effect: 0.5, seed: 11 });

  it('in-sample ceiling selects underpriced picks ⇒ win-rate above the rested price', () => {
    const sel = inSampleSelect(learnable, { fitIters: 200 });
    expect(sel.length).toBeGreaterThan(0);
    const edge = sel.reduce((a, s) => a + ((s.won ? 1 : 0) - s.restPx), 0) / sel.length;
    expect(edge).toBeGreaterThan(0);
  });

  it('LOCO generalises across held-out clusters (signal is the same every day)', () => {
    const sel = leaveOneClusterOut(learnable, { fitIters: 200 });
    expect(sel.length).toBeGreaterThan(0);
    const edge = sel.reduce((a, s) => a + ((s.won ? 1 : 0) - s.restPx), 0) / sel.length;
    expect(edge).toBeGreaterThan(0);
  });

  it('LOCO needs ≥2 clusters', () => {
    const one = universe({ nClusters: 1, perCluster: 30, effect: 0.5, seed: 1 });
    expect(leaveOneClusterOut(one)).toEqual([]);
  });
});

describe('selectionStats', () => {
  it('reports edge (per-bucket + cluster-t) and both EV models; total on empty', () => {
    const sel: SelectedPick[] = [
      { restPx: 0.1, won: true, cluster: 'a', feeRate: 0.05, pWin: 0.4 },
      { restPx: 0.1, won: false, cluster: 'b', feeRate: 0.05, pWin: 0.4 },
    ];
    const s = selectionStats(sel);
    expect(s.n).toBe(2);
    expect(s.nClusters).toBe(2);
    expect(s.edge.mean).toBeCloseTo(0.4, 9); // mean of (1-0.1) and (0-0.1) = 0.4
    expect(s.edgeClusterT.mean).toBeCloseTo(0.4, 9);
    // realistic rebate must lift EV above conservative (a won + a lost position)
    expect(s.evRealistic.mean).toBeGreaterThan(s.evConservative.mean);
    const empty = selectionStats([]);
    expect(empty.n).toBe(0);
    expect(Number.isNaN(empty.edge.mean)).toBe(true);
  });
});

describe('zeroSkillNull', () => {
  it('runs deterministically, returns pPass in [0,1], and skips when mcIters=0', () => {
    const u = universe({ nClusters: 8, perCluster: 25, effect: 0.5, seed: 3 });
    const a = zeroSkillNull(u, 'loco', { mcIters: 30, fitIters: 120 });
    const b = zeroSkillNull(u, 'loco', { mcIters: 30, fitIters: 120 });
    expect(a.pPass).toBe(b.pPass); // deterministic
    expect(a.pPass).toBeGreaterThanOrEqual(0);
    expect(a.pPass).toBeLessThanOrEqual(1);
    expect(a.iters).toBe(30);
    expect(Number.isNaN(zeroSkillNull(u, 'loco', { mcIters: 0 }).pPass)).toBe(true);
  });
});

describe('selectorVerdict (frozen kill-criterion)', () => {
  const goodOos = { ...selectionStats([]), nClusters: 10, edgeClusterT: { mean: 0.04, lo: 0.01, hi: 0.07 } };
  const goodCeiling = { ...selectionStats([]), edge: { mean: 0.04, lo: 0.02, hi: 0.06 } };

  it('below MIN_CLUSTERS ⇒ INSUFFICIENT_DATA even with a great point estimate', () => {
    const v = selectorVerdict({ oos: goodOos, inSample: goodCeiling, zeroSkillPPass: 0.0, nClusters: 4 });
    expect(v.outcome).toBe('INSUFFICIENT_DATA');
  });
  it('clears all gates ⇒ PASS', () => {
    const v = selectorVerdict({ oos: goodOos, inSample: goodCeiling, zeroSkillPPass: 0.02, nClusters: 10 });
    expect(v.outcome).toBe('PASS');
  });
  it('OOS CI straddles 0 (enough clusters) ⇒ FAIL', () => {
    const straddle = { ...goodOos, edgeClusterT: { mean: 0.01, lo: -0.02, hi: 0.04 } };
    const v = selectorVerdict({ oos: straddle, inSample: goodCeiling, zeroSkillPPass: 0.02, nClusters: 10 });
    expect(v.outcome).toBe('FAIL');
  });
  it('zero-skill null fires (≥5%) ⇒ FAIL', () => {
    const v = selectorVerdict({ oos: goodOos, inSample: goodCeiling, zeroSkillPPass: 0.2, nClusters: 10 });
    expect(v.outcome).toBe('FAIL');
  });
});

describe('runSelectorLearn (end-to-end, deterministic)', () => {
  const opts = { iters: 150, fitIters: 150, mcIters: 40 };

  it('a strong learnable signal across MANY clusters ⇒ PASS', () => {
    const u = universe({ nClusters: 12, perCluster: 25, effect: 0.5, seed: 3 });
    const r = runSelectorLearn(u, opts);
    expect(r.nClusters).toBe(12);
    expect(r.oos.edgeClusterT.lo).toBeGreaterThan(0);
    expect(r.verdict.outcome).toBe('PASS');
  });

  it('pure noise (calibrated market) across many clusters ⇒ FAIL (no learnable edge)', () => {
    const u = universe({ nClusters: 12, perCluster: 25, effect: 0, seed: 2 });
    const r = runSelectorLearn(u, opts);
    expect(r.nClusters).toBe(12);
    expect(r.verdict.outcome).toBe('FAIL');
  });

  it('too few clusters ⇒ INSUFFICIENT_DATA regardless of the signal', () => {
    const u = universe({ nClusters: 4, perCluster: 30, effect: 0.5, seed: 3 });
    const r = runSelectorLearn(u, opts);
    expect(r.verdict.outcome).toBe('INSUFFICIENT_DATA');
  });

  it('is byte-identical across runs', () => {
    const u = universe({ nClusters: 10, perCluster: 25, effect: 0.4, seed: 5 });
    const a = runSelectorLearn(u, opts);
    const b = runSelectorLearn(u, opts);
    expect(a.oos.edgeClusterT).toEqual(b.oos.edgeClusterT);
    expect(a.nullOos.pPass).toBe(b.nullOos.pPass);
    expect(a.verdict.outcome).toBe(b.verdict.outcome);
  });

  it('empty input ⇒ INSUFFICIENT_DATA, total', () => {
    const r = runSelectorLearn([]);
    expect(r.nPicks).toBe(0);
    expect(r.verdict.outcome).toBe('INSUFFICIENT_DATA');
  });

  it('exposes the frozen config (MIN_CLUSTERS, cheap band)', () => {
    expect(SELECTOR_LEARN.minClusters).toBe(8);
    expect(SELECTOR_LEARN.cheapLo).toBe(0.1);
    expect(SELECTOR_LEARN.cheapMax).toBe(0.25);
  });
});
