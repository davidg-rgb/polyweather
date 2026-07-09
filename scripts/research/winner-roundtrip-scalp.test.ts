import { describe, expect, it } from 'vitest';
import { curvature, DEFAULT_PARAMS, type RoundTrip, type ScalpParams, scoreTrip, simulateRoundTrip } from './winner-roundtrip-scalp.ts';

const P: ScalpParams = DEFAULT_PARAMS; // peak .25, dip [.10,.15], sell .25
const pts = (...ps: number[]): Array<[number, number]> => ps.map((p, i) => [i, p]);

describe('simulateRoundTrip — the peak→dip→recover state machine', () => {
  it('enters after a peak+dip and exits on recovery (target hit)', () => {
    const rt = simulateRoundTrip(pts(0.28, 0.12, 0.3), false, P)!;
    expect(rt.entryP).toBeCloseTo(0.12, 10);
    expect(rt.targetHit).toBe(true);
    expect(rt.proceedsMid).toBeCloseTo(P.sell, 10);
  });
  it('requires the peak BEFORE the dip — a dip with no prior peak does not arm', () => {
    // never reaches 0.25 before the dip, so no entry
    expect(simulateRoundTrip(pts(0.2, 0.12, 0.18), false, P)).toBeNull();
  });
  it('does not buy outside the dip band', () => {
    // peaks, then only ever sits at 0.18 (above dipHi) — never enters
    expect(simulateRoundTrip(pts(0.3, 0.18, 0.22), false, P)).toBeNull();
    // peaks, then gaps straight through the band to 0.05 — strict band means no fill
    expect(simulateRoundTrip(pts(0.3, 0.05, 0.02), false, P)).toBeNull();
  });
  it('holds to resolution when the target is never recovered — loser → 0', () => {
    const rt = simulateRoundTrip(pts(0.3, 0.13, 0.08, 0.02), false, P)!;
    expect(rt.targetHit).toBe(false);
    expect(rt.proceedsMid).toBe(0); // lost
  });
  it('holds to resolution when the target is never recovered — winner → 1', () => {
    // enters at 0.13, never crosses 0.25 in-sample but resolves a winner (edge case)
    const rt = simulateRoundTrip(pts(0.3, 0.13, 0.2, 0.24), true, P)!;
    expect(rt.targetHit).toBe(false);
    expect(rt.proceedsMid).toBe(1);
  });
});

describe('curvature agrees with simulateRoundTrip on the same path', () => {
  // The two independent code paths MUST agree on "did it recover" — this invariant is what
  // makes Part A's recovery-rate == Part B's target-hit rate (the cross-check in the run).
  const cases: Array<[number[], boolean]> = [
    [[0.28, 0.12, 0.3], true],
    [[0.3, 0.13, 0.08, 0.02], false],
    [[0.2, 0.12, 0.18], false], // never armed → no dip-after-peak
  ];
  for (const [path, expectRecover] of cases) {
    it(`path ${path.join('→')} → recovered=${expectRecover}`, () => {
      const cv = curvature(pts(...path), P);
      const rt = simulateRoundTrip(pts(...path), false, P);
      // recovery (curvature) and targetHit (trade) must be the same boolean when an entry exists
      if (rt) expect(cv.recovered).toBe(rt.targetHit);
      expect(cv.recovered).toBe(expectRecover);
    });
  }
  it('counts multiple peak→dip→recover oscillations (a fresh peak is required after each recovery)', () => {
    // peak, dip, recover(cycle1), FRESH peak, dip, recover(cycle2) → 2 cycles
    const cv = curvature(pts(0.28, 0.12, 0.26, 0.28, 0.13, 0.3), P);
    expect(cv.cycles).toBe(2);
    expect(cv.peakDips).toBe(2);
  });
  it('does NOT count a second dip that arrives before a fresh peak', () => {
    // peak, dip, recover(cycle1), dip-again-with-no-new-peak → still 1 cycle
    const cv = curvature(pts(0.28, 0.12, 0.27, 0.13, 0.3), P);
    expect(cv.cycles).toBe(1);
    expect(cv.peakDips).toBe(1);
  });
});

describe('scoreTrip — cost ordering and the martingale-breakeven identity', () => {
  const hit: RoundTrip = { entryP: 0.14, targetHit: true, proceedsMid: 0.25, won: false, entryIdx: 1, exitIdx: 2 };
  const miss: RoundTrip = { entryP: 0.14, targetHit: false, proceedsMid: 0, won: false, entryIdx: 1, exitIdx: 3 };

  it('frictionless beats maker beats taker on a target-hit trade (costs strictly reduce edge)', () => {
    const f = scoreTrip(hit, P, 'frictionless', 1)!;
    const m = scoreTrip(hit, P, 'maker', 1)!;
    const t = scoreTrip(hit, P, 'taker', 1)!;
    expect(f.netReturn).toBeGreaterThan(m.netReturn);
    expect(m.netReturn).toBeGreaterThan(t.netReturn);
  });
  it('a non-recovering loser is a total loss frictionless (−100%)', () => {
    const f = scoreTrip(miss, P, 'frictionless', 1)!;
    expect(f.netReturn).toBeCloseTo(-1, 10);
  });
  it('spread ×0 taker still charges the fee both legs (worse than frictionless)', () => {
    const f = scoreTrip(hit, P, 'frictionless', 0)!;
    const t0 = scoreTrip(hit, P, 'taker', 0)!;
    expect(t0.netReturn).toBeLessThan(f.netReturn);
  });
  it('martingale identity: frictionless hit-at-sell EV is ~0 when hit-rate == entry/sell', () => {
    // buy 0.125, sell 0.25 → win +0.125 on hit, −0.125 on miss(→0). Fair p = 0.125/0.25 = 0.5.
    const e = 0.125;
    const win = scoreTrip({ entryP: e, targetHit: true, proceedsMid: 0.25, won: false, entryIdx: 0, exitIdx: 1 }, P, 'frictionless', 1)!;
    const lose = scoreTrip({ entryP: e, targetHit: false, proceedsMid: 0, won: false, entryIdx: 0, exitIdx: 1 }, P, 'frictionless', 1)!;
    const p = e / P.sell; // 0.5
    const evNet = p * win.netPnl + (1 - p) * lose.netPnl;
    expect(evNet).toBeCloseTo(0, 10);
  });
});
