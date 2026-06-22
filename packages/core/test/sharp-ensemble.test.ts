/**
 * Tests for core/sim/sharp-ensemble — MOVE 5: the sharps as FORECASTERS (BADATMATH-GAP-PLAN.md §3
 * Move 5). Covers the three forecaster distributions (market / EMOS / sharp-tilt) + their null
 * universe filters, the convex blend + simplex weight fit, the no-lookahead walk-forward stack, the
 * paired-Brier arm scoring, the zero-skill-sharp Monte-Carlo false-positive guard, and the frozen
 * branch-table verdict — including a constructed PASS (the sharp carries event-specific orthogonal
 * skill), a KILL (the sharp's pick is uncorrelated with the outcome), and INSUFFICIENT below minN.
 * All pure — no network, no DB.
 */
import { describe, expect, it } from 'vitest';
import {
  SHARP_ENSEMBLE,
  type ArmScore,
  type EnsembleBucket,
  type EnsembleEvent,
  blend,
  emosDist,
  ensembleVerdict,
  fitWeights,
  marketDist,
  prepareEvent,
  runSharpEnsembleStudy,
  scoreArm,
  sharpDist,
  walkForwardStack,
  zeroSkillSharpMc,
} from '../src/sim/sharp-ensemble.ts';

// ── builders ────────────────────────────────────────────────────────────────────────────────────

function bucket(over: Partial<EnsembleBucket> & { bucketIdx: number }): EnsembleBucket {
  return {
    emosP: 0.33,
    marketP: 0.33,
    sharpStakeUsd: 0,
    sharpEntryPrice: null,
    ...over,
  };
}

const dateAt = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

/** A 3-bucket event with the given winner; market/emos uninformative, sharp bets `sharpPick` cheap. */
function ev3(
  i: number,
  winner: number,
  sharpPick: number | null,
  over: Partial<EnsembleEvent> = {},
): EnsembleEvent {
  const ask = [0.4, 0.35, 0.25];
  const buckets = [0, 1, 2].map((idx) =>
    bucket({
      bucketIdx: idx,
      emosP: ask[idx]!,
      marketP: ask[idx]!,
      sharpStakeUsd: sharpPick === idx ? 100 : 0,
      sharpEntryPrice: sharpPick === idx ? 0.1 : null,
    }),
  );
  return {
    eventId: `e${i}`,
    station: 'EHAM',
    citySlug: 'amsterdam',
    targetDate: dateAt(i),
    lead: 1,
    winnerIdx: winner,
    buckets,
    ...over,
  };
}

/** A fabricated ArmScore for verdict-branch unit tests. */
function arm(over: Omit<Partial<ArmScore>, 'improvement'> & { improvement?: Partial<ArmScore['improvement']> } = {}): ArmScore {
  const { improvement, ...rest } = over;
  return {
    key: 'M+S',
    n: 100,
    brierStack: 0.4,
    brierBaseline: 0.5,
    improvement: { mean: 0.1, lo: 0.05, hi: 0.15, se: 0.02, n: 100, ...improvement },
    pValue: 0.01,
    ...rest,
  };
}

// ── distributions ──────────────────────────────────────────────────────────────────────────────

describe('marketDist / emosDist', () => {
  it('renormalizes the market asks to a distribution summing to 1', () => {
    const d = marketDist(ev3(0, 0, null))!;
    expect(d.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    expect(d[0]).toBeGreaterThan(d[2]!); // 0.4 ask > 0.25 ask
  });

  it('returns null when fewer than two buckets carry a usable ask', () => {
    const e = ev3(0, 0, null);
    e.buckets[1]!.marketP = null;
    e.buckets[2]!.marketP = 0; // only bucket 0 usable
    expect(marketDist(e)).toBeNull();
  });

  it('emosDist is null when no bucket carries positive EMOS mass', () => {
    const e = ev3(0, 0, null);
    for (const b of e.buckets) b.emosP = 0;
    expect(emosDist(e)).toBeNull();
  });
});

describe('sharpDist', () => {
  it('tilts the market toward the cheap sharp pick without zeroing the favourite', () => {
    const d = sharpDist(ev3(0, 2, 2))!; // sharp bets bucket 2
    expect(d.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    expect(d[2]).toBeGreaterThan(marketDist(ev3(0, 2, 2))![2]!); // bucket 2 up-weighted
    expect(d[0]).toBeGreaterThan(0); // favourite not zeroed
  });

  it('ignores stake placed at or above the cheap cut', () => {
    const e = ev3(0, 0, 0);
    e.buckets[0]!.sharpEntryPrice = SHARP_ENSEMBLE.cheapMax; // not cheap → not an engine pick
    expect(sharpDist(e)).toBeNull();
  });

  it('is null when the sharp made no pick (no stake)', () => {
    expect(sharpDist(ev3(0, 0, null))).toBeNull();
  });
});

describe('blend', () => {
  it('produces a convex combination that is a distribution', () => {
    const out = blend(
      [
        [0.6, 0.4],
        [0.2, 0.8],
      ],
      [0.5, 0.5],
    );
    expect(out).toEqual([
      expect.closeTo(0.4, 9),
      expect.closeTo(0.6, 9),
    ]);
  });

  it('falls back to the first dist when the blend has no positive mass', () => {
    expect(blend([[0, 0]], [1])).toEqual([0, 0]); // renormalize → null → fallback dists[0]
  });
});

describe('prepareEvent (universe filter)', () => {
  it('accepts an event with all three forecasters defined and the winner on the ladder', () => {
    expect(prepareEvent(ev3(0, 1, 1))).not.toBeNull();
  });

  it('rejects fewer than two buckets, a missing forecaster, or an off-ladder winner', () => {
    expect(prepareEvent({ ...ev3(0, 0, 0), buckets: [bucket({ bucketIdx: 0 })] })).toBeNull();
    expect(prepareEvent(ev3(0, 0, null))).toBeNull(); // no sharp pick
    const noMkt = ev3(0, 0, 0);
    for (const b of noMkt.buckets) b.marketP = null;
    expect(prepareEvent(noMkt)).toBeNull();
    expect(prepareEvent(ev3(0, 9, 0))).toBeNull(); // winner bucketIdx 9 off-ladder
  });
});

// ── weight fitting + walk-forward ─────────────────────────────────────────────────────────────

describe('fitWeights', () => {
  it('defers to the first key (market) on an empty training set or a single forecaster', () => {
    expect(fitWeights([], ['market', 'sharp'])).toEqual([1, 0]);
    expect(fitWeights([], ['market'])).toEqual([1]);
  });

  it('puts weight on the forecaster that lowers pooled Brier', () => {
    // train: the winner is always idx0; dists[1] points hard at idx0 → fit should favour it.
    const train = Array.from({ length: 10 }, () => ({
      dists: [
        [0.4, 0.35, 0.25],
        [0.9, 0.05, 0.05],
      ],
      outcomePos: 0,
    }));
    const w = fitWeights(train, ['market', 'sharp']);
    expect(w[1]).toBeGreaterThan(0.5); // sharp-like forecaster up-weighted
  });

  it('fits a three-way simplex', () => {
    const train = Array.from({ length: 10 }, () => ({
      dists: [
        [0.34, 0.33, 0.33],
        [0.34, 0.33, 0.33],
        [0.9, 0.05, 0.05],
      ],
      outcomePos: 0,
    }));
    const w = fitWeights(train, ['market', 'emos', 'sharp']);
    expect(w).toHaveLength(3);
    expect(w.reduce((a, x) => a + x, 0)).toBeCloseTo(1, 9);
    expect(w[2]).toBeGreaterThan(0); // the informative third forecaster gets weight
  });
});

describe('walkForwardStack', () => {
  it('defers to the market before minTrain, then fits (no lookahead)', () => {
    const events = Array.from({ length: 40 }, (_, i) => ev3(i, 0, 0));
    const prepared = events.map((e) => prepareEvent(e)!);
    const stack = walkForwardStack(prepared, ['market', 'sharp'], { minTrain: 20 });
    // first event (no training) must equal the market dist exactly
    expect(stack[0]).toEqual(prepared[0]!.market);
    expect(stack).toHaveLength(40);
  });

  it('is deterministic and handles same-date events via the eventId tiebreak', () => {
    const events = [ev3(0, 0, 0, { targetDate: '2026-02-01', eventId: 'b' }),
                    ev3(1, 0, 0, { targetDate: '2026-02-01', eventId: 'a' })];
    const prepared = events.map((e) => prepareEvent(e)!);
    const a = walkForwardStack(prepared, ['market', 'sharp']);
    const b = walkForwardStack(prepared, ['market', 'sharp']);
    expect(a).toEqual(b);
  });
});

// ── arm scoring + zero-skill MC ───────────────────────────────────────────────────────────────

describe('scoreArm', () => {
  it('reports a positive improvement and a low p-value when the stack beats the baseline', () => {
    const baseline = Array.from({ length: 50 }, () => 0.5);
    const stack = Array.from({ length: 50 }, () => 0.3); // uniformly sharper
    const s = scoreArm('M+S', stack, baseline);
    expect(s.improvement.mean).toBeCloseTo(0.2, 9);
    expect(s.improvement.lo).toBeGreaterThan(0);
    expect(s.pValue).toBeLessThan(0.05);
  });
});

describe('zeroSkillSharpMc', () => {
  it('rarely passes when the shuffled sharp is uninformative', () => {
    const prepared = Array.from({ length: 60 }, (_, i) => prepareEvent(ev3(i, i % 3, i % 3))!);
    const baseline = prepared.map(
      (pe) => (pe.market[pe.outcomePos]! - 1) ** 2 +
        pe.market.reduce((a, x, j) => a + (j === pe.outcomePos ? 0 : x * x), 0),
    );
    const mc = zeroSkillSharpMc(prepared, baseline, { iters: 20 });
    expect(mc.pPass).toBeGreaterThanOrEqual(0);
    expect(mc.pPass).toBeLessThan(SHARP_ENSEMBLE.zeroSkillMax); // a real signal shuffled away → no pass
  });

  it('is total on an empty universe', () => {
    expect(Number.isNaN(zeroSkillSharpMc([], []).pPass)).toBe(true);
  });
});

// ── the verdict (frozen branch table) ────────────────────────────────────────────────────────

describe('ensembleVerdict', () => {
  const ok = {
    n: 100,
    marketVsSharp: arm(),
    marginalSharp: { mean: 0.05, lo: 0.02, hi: 0.08, se: 0.01, n: 100 },
    zeroSkill: { pPass: 0.0, iters: 200 },
  };

  it('PASSes only when all four guards clear', () => {
    const v = ensembleVerdict(ok);
    expect(v.case).toBe('SHARP_ADDS_SKILL');
    expect(v.pass).toBe(true);
    expect(v.next).toMatch(/analytics product|smart-money/);
  });

  it('KILLs when the binding CI includes 0', () => {
    const v = ensembleVerdict({ ...ok, marketVsSharp: arm({ improvement: { lo: -0.01 } }) });
    expect(v.case).toBe('KILL_ALREADY_PRICED');
    expect(v.pass).toBe(false);
  });

  it('KILLs when the paired bootstrap p is not significant', () => {
    expect(ensembleVerdict({ ...ok, marketVsSharp: arm({ pValue: 0.2 }) }).pass).toBe(false);
  });

  it('KILLs when the zero-skill MC passes too often', () => {
    expect(ensembleVerdict({ ...ok, zeroSkill: { pPass: 0.5, iters: 200 } }).pass).toBe(false);
  });

  it('KILLs when the marginal-sharp arm does not clear (EMOS-confound guard)', () => {
    expect(ensembleVerdict({ ...ok, marginalSharp: { mean: 0, lo: -0.02, hi: 0.02, se: 0.01, n: 100 } }).pass).toBe(
      false,
    );
  });

  it('is INSUFFICIENT below minN', () => {
    const v = ensembleVerdict({ ...ok, n: SHARP_ENSEMBLE.minN - 1 });
    expect(v.case).toBe('INSUFFICIENT');
  });
});

// ── end-to-end study ─────────────────────────────────────────────────────────────────────────

describe('runSharpEnsembleStudy', () => {
  it('PASSes when the sharp bets the true (event-specific) winner the market underprices', () => {
    // winner varies by event; the sharp always bets the actual winner cheap → orthogonal skill.
    const events = Array.from({ length: 90 }, (_, i) => ev3(i, i % 3, i % 3));
    const res = runSharpEnsembleStudy(events, { mcIters: 25 });
    expect(res.n).toBe(90);
    expect(res.marketVsSharp.improvement.lo).toBeGreaterThan(0);
    expect(res.zeroSkill.pPass).toBeLessThan(SHARP_ENSEMBLE.zeroSkillMax);
    expect(res.verdict.case).toBe('SHARP_ADDS_SKILL');
  });

  it('KILLs when the sharp pick is uncorrelated with the outcome', () => {
    // the sharp always bets bucket 0, but the winner rotates → no orthogonal info.
    const events = Array.from({ length: 90 }, (_, i) => ev3(i, i % 3, 0));
    const res = runSharpEnsembleStudy(events, { mcIters: 25 });
    expect(res.n).toBe(90);
    expect(res.verdict.pass).toBe(false);
    expect(res.verdict.case).toBe('KILL_ALREADY_PRICED');
  });

  it('is INSUFFICIENT below minN and skips the (NaN) MC', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev3(i, i % 3, i % 3));
    const res = runSharpEnsembleStudy(events);
    expect(res.verdict.case).toBe('INSUFFICIENT');
    expect(Number.isNaN(res.zeroSkill.pPass)).toBe(true);
  });
});
