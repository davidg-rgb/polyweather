/**
 * Tests for scripts/research/sim-maker-exit — the pure improvement-lever helpers (2026-07-03):
 *   - wilsonLower: the shrinkage bound the city gate ranks on (never the point estimate);
 *   - gateCities / CITY_GATE_PRE0613: the per-city selector-accuracy gate, fitted PRE-panel (2026-05-13 →
 *     2026-06-12) so its application to the archive replay (2026-06-13+) is temporally out-of-sample;
 *   - cfgFrom: the SimParams → MakerExitCfg plumbing for the new levers (tpMode/tpAbs/minEntryAgeH).
 */
import { describe, expect, it } from 'vitest';
import { wilsonLower, gateCities, CITY_GATE_PRE0613, cfgFrom, DEFAULT_PARAMS } from './sim-maker-exit.ts';

describe('wilsonLower', () => {
  it('matches the known 95% bound at p=0.5, n=100 (~0.4038)', () => {
    expect(wilsonLower(50, 100)).toBeCloseTo(0.4038, 3);
  });
  it('is 0 on an empty/degenerate sample and bounded in [0, p]', () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(5, 10)).toBeGreaterThan(0);
    expect(wilsonLower(5, 10)).toBeLessThan(0.5);
    expect(wilsonLower(10, 10)).toBeLessThan(1); // even a perfect small sample stays below 1 (shrinkage)
  });
  it('grows with n at fixed p (more evidence → a tighter bound)', () => {
    expect(wilsonLower(90, 100)).toBeGreaterThan(wilsonLower(9, 10));
  });
});

describe('gateCities (the pre-panel city gate)', () => {
  it('minLb ≤ 0 admits every table city (no gate)', () => {
    expect(gateCities(CITY_GATE_PRE0613, 'hit1', 0).length).toBe(Object.keys(CITY_GATE_PRE0613).length);
  });
  it('excludes the weak selectors and keeps the strong ones at a 0.7 hit1 floor', () => {
    const gated = new Set(gateCities(CITY_GATE_PRE0613, 'hit1', 0.7));
    expect(gated.has('madrid')).toBe(true); // 55/58 — LB ≈ .86
    expect(gated.has('karachi')).toBe(true); // 54/58
    expect(gated.has('amsterdam')).toBe(false); // 20/58 — LB ≈ .24 (the worst major selector)
    expect(gated.has('chongqing')).toBe(false); // 32/58
    expect(gated.has('lucknow')).toBe(false); // n=2 — the Wilson bound rejects the tiny sample naturally
  });
  it('hit0 gates on the exact-bucket pick (chw0 quality) — a different, stricter set', () => {
    const g0 = new Set(gateCities(CITY_GATE_PRE0613, 'hit0', 0.5));
    expect(g0.has('mexico-city')).toBe(true); // 41/58 exact — LB ≈ .58
    expect(g0.has('london')).toBe(false); // 9/58 exact
    expect(g0.size).toBeLessThan(gateCities(CITY_GATE_PRE0613, 'hit1', 0.5).length);
  });
  it('is monotone: a higher floor never admits more cities', () => {
    for (const metric of ['hit0', 'hit1'] as const) {
      let prev = gateCities(CITY_GATE_PRE0613, metric, 0).length;
      for (const lb of [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const n = gateCities(CITY_GATE_PRE0613, metric, lb).length;
        expect(n).toBeLessThanOrEqual(prev);
        prev = n;
      }
    }
  });
});

describe('cfgFrom (SimParams → MakerExitCfg plumbing)', () => {
  it('maps the new levers onto the engine cfg', () => {
    const c = cfgFrom({ ...DEFAULT_PARAMS, tpMode: 'abs', tpAbs: 0.4, minEntryAgeH: 2 }, ['madrid']);
    expect(c.tpMode).toBe('abs');
    expect(c.tpAbsTarget).toBe(0.4);
    expect(c.minEntryAgeH).toBe(2);
    expect(c.cities).toEqual(['madrid']);
  });
  it('the defaults are the historical behavior (delta mode, no age gate, no city gate)', () => {
    const c = cfgFrom(DEFAULT_PARAMS, ['madrid']);
    expect(c.tpMode).toBe('delta');
    expect(c.minEntryAgeH).toBe(0);
    expect(DEFAULT_PARAMS.cityGateLb).toBe(0);
  });
});
