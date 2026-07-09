/**
 * scripts/research/model-trim.test — the pure trim engine + the adopt-or-shrink decision.
 */
import { describe, it, expect } from 'vitest';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import {
  blendPoint,
  toNativeInt,
  scoreSubset,
  perDayErrors,
  stepwiseSelect,
  cityClusteredBootstrap,
  buildPanels,
  runLead,
  CORE8,
  type ScoreDay,
  type DayMember,
  type TrimArgs,
} from './model-trim.ts';

const day = (city: string, date: string, obs: number, models: Record<string, number>, opts?: { unit?: string; wRaw?: (m: string) => number; warm?: boolean }): ScoreDay => {
  const members = new Map<string, DayMember>();
  for (const [m, p] of Object.entries(models)) members.set(m, { p, wRaw: opts?.wRaw?.(m) ?? 1, qualified: true });
  const unit = opts?.unit ?? 'C';
  return { city, date, unit, obsC: obs, obsNative: unit === 'F' ? Math.round((obs * 9) / 5 + 32) : Math.round(obs), members, warm: opts?.warm ?? true };
};

describe('blendPoint', () => {
  it('inverse-MSE weights toward the high-wRaw (low-MSE) member', () => {
    expect(blendPoint([{ p: 10, wRaw: 9, qualified: true }, { p: 20, wRaw: 1, qualified: true }], 'invmse')).toBeCloseTo(11, 9);
  });
  it('equal averages regardless of wRaw', () => {
    expect(blendPoint([{ p: 10, wRaw: 9, qualified: true }, { p: 20, wRaw: 1, qualified: true }], 'equal')).toBeCloseTo(15, 9);
  });
  it('falls back to equal mean when no member qualifies (the builder 1/N path)', () => {
    expect(blendPoint([{ p: 10, wRaw: 0, qualified: false }, { p: 20, wRaw: 0, qualified: false }], 'invmse')).toBeCloseTo(15, 9);
  });
  it('returns null for an empty subset', () => {
    expect(blendPoint([], 'invmse')).toBeNull();
  });
});

describe('toNativeInt', () => {
  it('rounds °C directly for C markets', () => {
    expect(toNativeInt(21.4, 'C')).toBe(21);
    expect(toNativeInt(21.6, 'C')).toBe(22);
  });
  it('converts to native °F for F markets', () => {
    expect(toNativeInt(20, 'F')).toBe(68); // 20°C = 68°F
    expect(toNativeInt(0, 'F')).toBe(32);
  });
});

describe('scoreSubset', () => {
  it('a perfect forecast scores rmse 0 and 100% exact', () => {
    const days = [day('X', '2026-01-01', 15, { ecmwf_ifs025: 15 }), day('X', '2026-01-02', 20, { ecmwf_ifs025: 20 })];
    const s = scoreSubset(days, new Set(['ecmwf_ifs025']), 'equal');
    expect(s.n).toBe(2);
    expect(s.rmseC).toBeCloseTo(0, 9);
    expect(s.exactRate).toBe(1);
  });
  it('skips days where the subset has no member', () => {
    const days = [day('X', '2026-01-01', 15, { gfs_seamless: 15 })];
    expect(scoreSubset(days, new Set(['ecmwf_ifs025']), 'equal').n).toBe(0);
  });
});

describe('stepwiseSelect', () => {
  it('drops a pure-noise model a clean model dominates', () => {
    const days: ScoreDay[] = [];
    for (let i = 0; i < 40; i++) {
      const obs = 15 + (i % 7);
      days.push(day('X', `2026-01-${String(i + 1).padStart(2, '0')}`, obs, {
        ecmwf_ifs025: obs + 0.05 * Math.sin(i),
        cma_grapes_global: obs + 5 * ((i % 2) - 0.5), // ±2.5 alternating noise
      }));
    }
    const sel = stepwiseSelect(days, ['ecmwf_ifs025', 'cma_grapes_global'], 'equal');
    expect(sel.subset.has('ecmwf_ifs025')).toBe(true);
    expect(sel.subset.has('cma_grapes_global')).toBe(false);
  });
  it('keeps BOTH models when each carries independent signal (averaging helps)', () => {
    const days: ScoreDay[] = [];
    for (let i = 0; i < 60; i++) {
      const obs = 15 + 5 * Math.sin(i / 3);
      // two independent-error models: their average is better than either alone
      const eA = Math.sin(i * 1.7);
      const eB = Math.cos(i * 2.3);
      days.push(day('X', `2026-02-${String((i % 28) + 1).padStart(2, '0')}${i}`, obs, {
        ecmwf_ifs025: obs + eA,
        gfs_seamless: obs + eB,
      }));
    }
    const sel = stepwiseSelect(days, ['ecmwf_ifs025', 'gfs_seamless'], 'equal');
    expect(sel.subset.size).toBe(2);
  });
});

describe('cityClusteredBootstrap', () => {
  it('point mean is the grand pooled mean; CI brackets it', () => {
    const m = new Map<string, number[]>([['A', [1, 1, 1]], ['B', [3, 3, 3]]]);
    const ci = cityClusteredBootstrap(m, 500, 7);
    expect(ci.mean).toBeCloseTo(2, 9);
    expect(ci.nCities).toBe(2);
    expect(ci.nObs).toBe(6);
    expect(ci.lo).toBeLessThanOrEqual(ci.mean);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.mean);
  });
  it('empty → NaN', () => {
    expect(Number.isNaN(cityClusteredBootstrap(new Map(), 100, 1).mean)).toBe(true);
  });
});

describe('perDayErrors', () => {
  it('emits one record per scoreable day with abs error + hit flags', () => {
    const days = [day('X', '2026-01-01', 15, { ecmwf_ifs025: 16 }, { unit: 'C' })];
    const recs = perDayErrors(days, new Set(['ecmwf_ifs025']), 'equal');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.absErrC).toBeCloseTo(1, 9);
    expect(recs[0]!.within1).toBe(1);
    expect(recs[0]!.exact).toBe(0);
  });
});

const mkArgs = (over: Partial<TrimArgs> = {}): TrimArgs => ({
  leads: [1], slot: '22Z', seam: '2026-06-12', marginC: 0.05, minTrain: 20, minTest: 8, warmup: 0, iters: 400, seed: 42, scheme: 'equal', ...over,
});

describe('runLead adopt-or-shrink', () => {
  const buildPanel = (noiseModel: boolean) => {
    const train: ScoreDay[] = [];
    const test: ScoreDay[] = [];
    const cities = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
    for (const c of cities) {
      for (let i = 0; i < 30; i++) {
        const obs = 15 + (i % 9);
        const cma = noiseModel ? obs + 6 * ((i % 2) - 0.5) : obs + 0.1 * Math.cos(i);
        train.push(day(c, `2026-05-${String((i % 28) + 1).padStart(2, '0')}x${i}`, obs, { ecmwf_ifs025: obs + 0.1 * Math.sin(i), cma_grapes_global: cma }));
      }
      for (let i = 0; i < 14; i++) {
        const obs = 16 + (i % 8);
        const cma = noiseModel ? obs + 6 * ((i % 2) - 0.5) : obs + 0.1 * Math.cos(i);
        test.push(day(c, `2026-07-${String((i % 28) + 1).padStart(2, '0')}`, obs, { ecmwf_ifs025: obs + 0.1 * Math.sin(i), cma_grapes_global: cma }));
      }
    }
    return { train, test };
  };

  it('ADOPTS the trim when dropping a noisy model beats the full blend OOS by the margin', () => {
    const r = runLead(1, buildPanel(true), 'equal', mkArgs());
    expect(r.nAdopted).toBe(6);
    expect(r.adoptedMaeReductionC.mean).toBeGreaterThan(0.05);
    expect(r.adoptedMaeReductionC.lo).toBeGreaterThan(0);
    // the HONEST naive OOS number is also strongly positive when the effect is real on train AND test
    // (the zero-skill null is meaningful only when every model has data every day — i.e. the real run,
    // not this 2-of-8-models synthetic panel)
    expect(r.naiveMaeReductionC.mean).toBeGreaterThan(0.05);
    expect(r.naiveMaeReductionC.lo).toBeGreaterThan(0);
    // every adopted set drops CMA
    for (const c of r.perCity) expect(c.adopted).not.toContain('cma_grapes_global');
  });

  it('SHRINKS to the full blend when both models are good (no OOS margin)', () => {
    const r = runLead(1, buildPanel(false), 'equal', mkArgs());
    expect(r.nAdopted).toBe(0);
    expect(Math.abs(r.adoptedMaeReductionC.mean)).toBeLessThan(0.05);
    // naive trim of two good models is ≈0 (no real per-city signal to exploit)
    expect(Math.abs(r.naiveMaeReductionC.mean)).toBeLessThan(0.05);
    for (const c of r.perCity) expect(c.reason).not.toBe('adopted');
  });
});

describe('buildPanels', () => {
  const cfg = parseConfigRows([]);
  it('stitches backfill (train) + live slot (test), bias-corrects, and splits at the seam', () => {
    const fc: { icao: string; model: string; target_date: string; lead_days: number; tmax_c: string; snapshot_slot: string }[] = [];
    const obs: { icao: string; date_local: string; tmax_wu_native: number; unit: string }[] = [];
    // 20 backfill days + 10 live days, one model that always runs +3°C hot → bias should learn ≈3
    for (let i = 0; i < 30; i++) {
      const date = `2026-0${i < 20 ? '5' : '6'}-${String((i % 20) + 1).padStart(2, '0')}`;
      const slot = i < 20 ? 'backfill' : '22Z';
      const truth = 18;
      fc.push({ icao: 'EHAM', model: 'ecmwf_ifs025', target_date: date, lead_days: 1, tmax_c: String(truth + 3), snapshot_slot: slot });
      obs.push({ icao: 'EHAM', date_local: date, tmax_wu_native: truth, unit: 'C' });
    }
    const panels = buildPanels(fc, obs, cfg, mkArgs({ seam: '2026-05-31', warmup: 0 }));
    const p = panels.get(1)!;
    expect(p.train.length).toBe(20);
    expect(p.test.length).toBe(10);
    // by the live window the EMA bias has converged → corrected point ≈ truth (well within a degree)
    const lastTest = p.test[p.test.length - 1]!;
    const mem = lastTest.members.get('ecmwf_ifs025')!;
    expect(Math.abs(mem.p - 18)).toBeLessThan(0.75);
  });
});

// CORE8 is the frozen universe
describe('CORE8', () => {
  it('is the 8 deterministic models', () => {
    expect(CORE8).toHaveLength(8);
    expect(CORE8).toContain('ecmwf_ifs025');
    expect(CORE8).not.toContain('best_match');
  });
});
