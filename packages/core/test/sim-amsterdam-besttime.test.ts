/**
 * Tests for the Amsterdam best-time-to-bet fusion (core/sim/amsterdam-besttime). Asserts the model wires
 * the committed climatology (peak-hour floor confidence) together with the empirical hit rate (prediction
 * accuracy) and recommends a defensible lock hour under both the live-odds and the cold-start regimes.
 */
import { describe, expect, it } from 'vitest';
import {
  AMSTERDAM_CLIMATOLOGY,
  AMSTERDAM_MODEL_SKILL_PRIOR,
  blendWinProb,
  peakHourWindow,
  recommendBestTime,
  type BestTimeArmInput,
} from '../src/sim/amsterdam-besttime.ts';

const ARMS = [13, 14, 15, 16];
const armInputs = (over: Partial<Record<number, Partial<BestTimeArmInput>>> = {}): BestTimeArmInput[] =>
  ARMS.map((hour) => ({ hour, hitRate: null, avgAsk: null, nGraded: 0, ...(over[hour] ?? {}) }));

// June (month 6) climatology values are committed in amsterdam-climatology.ts and stable.
const JUNE = AMSTERDAM_CLIMATOLOGY.months.find((m) => m.month === 6)!;
const floorOf = (hour: number, hot = false): number =>
  (hot ? JUNE.hot!.decisionByHour : JUNE.decisionByHour).find((d) => d.hour === hour)!.leUpside05;

describe('blendWinProb — shrinkage', () => {
  it('returns the prior when there are no graded bets', () => {
    expect(blendWinProb(null, 0, 0.7, 10)).toBe(0.7);
    expect(blendWinProb(0.9, 0, 0.7, 10)).toBe(0.7);
  });
  it('returns the prior for a non-finite empirical rate (NaN / Infinity guard)', () => {
    expect(blendWinProb(NaN, 10, 0.7, 10)).toBe(0.7);
    expect(blendWinProb(Infinity, 10, 0.7, 10)).toBe(0.7);
  });
  it('clamps an out-of-range empirical rate into [0,1] before blending', () => {
    // A malformed >1 or <0 rate must never produce a >100% or negative blended confidence.
    expect(blendWinProb(1.5, 50, 0.7, 10)).toBeCloseTo((50 * 1 + 10 * 0.7) / 60, 10);
    expect(blendWinProb(1.5, 50, 0.7, 10)).toBeLessThanOrEqual(1);
    expect(blendWinProb(-0.3, 50, 0.7, 10)).toBeCloseTo((50 * 0 + 10 * 0.7) / 60, 10);
    expect(blendWinProb(-0.3, 50, 0.7, 10)).toBeGreaterThanOrEqual(0);
  });
  it('moves from prior toward the empirical rate as sample size grows', () => {
    const prior = 0.7;
    const emp = 0.4;
    const small = blendWinProb(emp, 5, prior, 10);
    const big = blendWinProb(emp, 100, prior, 10);
    expect(small).toBeGreaterThan(big); // smaller n stays closer to the prior
    expect(small).toBeLessThan(prior);
    expect(big).toBeCloseTo((100 * emp + 10 * prior) / 110, 10);
    expect(big).toBeGreaterThan(emp);
  });
});

describe('recommendBestTime — out-of-range input hardening', () => {
  it('keeps predictiveConfidence in [0,1] for a malformed hit rate and drops an illegal ask', () => {
    const view = recommendBestTime({
      month: 6,
      arms: armInputs({
        15: { hitRate: 1.5, avgAsk: 1.4, nGraded: 50 }, // both out of spec
        16: { hitRate: -0.2, avgAsk: 0.97, nGraded: 50 },
      }),
    });
    const r15 = view.rows.find((r) => r.hour === 15)!;
    const r16 = view.rows.find((r) => r.hour === 16)!;
    expect(r15.predictiveConfidence).toBeLessThanOrEqual(1);
    expect(r16.predictiveConfidence).toBeGreaterThanOrEqual(0);
    expect(r15.avgAsk).toBeNull(); // ask 1.4 > 1 → no odds, no bogus EV
    expect(r15.evBlended).toBeNull();
  });
});

describe('recommendBestTime — structural max-floor reduce branch (no hour clears 0.8)', () => {
  it('picks the higher-floor hour when every armed hour is below the safe target', () => {
    // Only the early April arms 13:00/14:00 (both floor confidence < 0.8) → `find(>=0.8)` misses, reduce fires.
    const view = recommendBestTime({
      month: 4,
      arms: [
        { hour: 13, hitRate: null, avgAsk: null, nGraded: 0 },
        { hour: 14, hitRate: null, avgAsk: null, nGraded: 0 },
      ],
    });
    const r13 = view.rows.find((r) => r.hour === 13)!;
    const r14 = view.rows.find((r) => r.hour === 14)!;
    expect(r13.floorConfidence).toBeLessThan(0.8);
    expect(r14.floorConfidence).toBeLessThan(0.8);
    expect(view.basis).toBe('structural');
    // reduce must pick the strictly higher-floor hour — a flipped comparator would fail this.
    const higher = r14.floorConfidence > r13.floorConfidence ? 14 : 13;
    expect(view.recommendedHour).toBe(higher);
  });
});

describe('recommendBestTime — cold start (no graded bets, no odds)', () => {
  const view = recommendBestTime({ month: 6, arms: armInputs() });

  it('emits one row per arm with floor confidence straight from the June climatology', () => {
    expect(view.rows.map((r) => r.hour)).toEqual(ARMS);
    for (const r of view.rows) expect(r.floorConfidence).toBe(floorOf(r.hour));
  });

  it('uses the structural prior (floorConf × skill prior) as predictive confidence with no data', () => {
    const r15 = view.rows.find((r) => r.hour === 15)!;
    expect(r15.empiricalHitRate).toBeNull();
    expect(r15.predictiveConfidence).toBeCloseTo(floorOf(15) * AMSTERDAM_MODEL_SKILL_PRIOR, 10);
    expect(r15.evBlended).toBeNull(); // no odds → no EV
  });

  it('falls back to the earliest structurally-safe hour (floorConf ≥ 0.8) → 16:00', () => {
    expect(view.basis).toBe('structural');
    expect(view.recommendedHour).toBe(16); // 13:0.34 14:0.50 15:0.70 16:0.84 → first ≥0.8 is 16
    expect(view.rows.filter((r) => r.recommended)).toHaveLength(1);
    expect(view.headline.recommendedHour).toBe(16);
    expect(view.rationale).toContain('16:00');
  });
});

describe('recommendBestTime — with live odds picks max blended EV among locked hours', () => {
  // Asks climb through the afternoon (market prices the floor in); floor confidence gates eligibility.
  const view = recommendBestTime({
    month: 6,
    arms: armInputs({
      13: { hitRate: 0.45, avgAsk: 0.34, nGraded: 12 },
      14: { hitRate: 0.6, avgAsk: 0.55, nGraded: 12 },
      15: { hitRate: 0.82, avgAsk: 0.8, nGraded: 12 },
      16: { hitRate: 0.95, avgAsk: 0.97, nGraded: 12 },
    }),
  });

  it('computes blended EV per hour and recommends an EV-max, floor-locked hour', () => {
    expect(view.basis).toBe('ev');
    expect(view.recommendedHour).not.toBeNull();
    const rec = view.rows.find((r) => r.recommended)!;
    // 13:00 floorConf 0.34 < 0.5 → ineligible regardless of fat odds; recommendation is 14/15/16.
    expect(rec.floorConfidence).toBeGreaterThanOrEqual(0.5);
    expect(rec.hour).toBeGreaterThanOrEqual(14);
    // The recommended hour has the highest EV among eligible hours.
    const eligible = view.rows.filter((r) => r.evBlended != null && r.floorConfidence >= 0.5);
    const maxEv = Math.max(...eligible.map((r) => r.evBlended!));
    expect(rec.evBlended!).toBeCloseTo(maxEv, 10);
  });

  it('blends empirical hit toward the structural prior (12 bets, k=10 → ~55/45)', () => {
    const r15 = view.rows.find((r) => r.hour === 15)!;
    const structural = floorOf(15) * AMSTERDAM_MODEL_SKILL_PRIOR;
    const expected = (12 * 0.82 + 10 * structural) / 22;
    expect(r15.predictiveConfidence).toBeCloseTo(expected, 10);
    expect(r15.evBlended).toBeCloseTo(expected / 0.8 - 1, 10);
  });
});

describe('recommendBestTime — hot day uses the later-peaking ≥25°C climatology', () => {
  const view = recommendBestTime({ month: 6, forecastC: 28, arms: armInputs() });

  it('switches to the hot sub-climatology and reports a later median peak', () => {
    expect(view.hot).toBe(true);
    expect(view.usedHotClimatology).toBe(true);
    expect(view.medianPeakHour).toBe(JUNE.hot!.medianPeakHour); // 17 vs 16 all-day
    const r15 = view.rows.find((r) => r.hour === 15)!;
    expect(r15.floorConfidence).toBe(floorOf(15, true)); // 0.56 hot vs 0.70 all-day → lower, riskier
    expect(r15.floorConfidence).toBeLessThan(floorOf(15));
    expect(view.rationale.toLowerCase()).toContain('hot');
  });
});

describe('recommendBestTime — strong empirical evidence overrides the structural prior', () => {
  it('drives predictive confidence toward a low measured hit rate at large n', () => {
    const view = recommendBestTime({ month: 6, arms: armInputs({ 16: { hitRate: 0.5, avgAsk: 0.95, nGraded: 200 } }) });
    const r16 = view.rows.find((r) => r.hour === 16)!;
    const structural = floorOf(16) * AMSTERDAM_MODEL_SKILL_PRIOR; // ~0.71
    expect(r16.predictiveConfidence).toBeLessThan(structural);
    expect(r16.predictiveConfidence).toBeCloseTo((200 * 0.5 + 10 * structural) / 210, 10);
  });
});

describe('recommendBestTime — degenerate inputs', () => {
  it('returns no recommendation with empty arms', () => {
    const view = recommendBestTime({ month: 6, arms: [] });
    expect(view.recommendedHour).toBeNull();
    expect(view.basis).toBe('none');
    expect(view.rows).toHaveLength(0);
  });
  it('ignores arm hours outside the climatology decision window', () => {
    const view = recommendBestTime({ month: 6, arms: [{ hour: 3, hitRate: null, avgAsk: null, nGraded: 0 }] });
    expect(view.rows).toHaveLength(0); // hour 3 not in decisionHours 10..19
  });
});

describe('peakHourWindow', () => {
  it('finds the modal peak hour and a central ≥50% window for June', () => {
    const w = peakHourWindow(JUNE);
    expect(w.modeHour).toBe(17); // June peaks modally at 17:00 local (median 16:00; 15/16/17 all close)
    expect(w.fromHour).toBeLessThanOrEqual(w.modeHour);
    expect(w.toHour).toBeGreaterThanOrEqual(w.modeHour);
    const mass = JUNE.peakHourHistogram.slice(w.fromHour, w.toHour + 1).reduce((a, b) => a + b, 0);
    expect(mass).toBeGreaterThanOrEqual(0.5);
  });

  it('collapses to the median peak on a degenerate (all-zero) histogram instead of shading the whole day', () => {
    const w = peakHourWindow({
      nDays: 0,
      medianPeakHour: 16,
      peakHourHistogram: new Array(24).fill(0),
      decisionByHour: [],
    });
    expect(w).toEqual({ modeHour: 16, fromHour: 16, toHour: 16 });
  });
});
