/**
 * Tests for core/sim/cross-venue-arb — the cross-venue (Kalshi ↔ Polymarket) relative-value
 * measurement (CROSS-VENUE-SPIKE.md, the 10th-signal candidate). Covers: overround removal in the
 * implied-PMF reconstruction, survival monotonicity, the descriptive divergence profile, the basis
 * straddle model, the executable consensus-valued edge (a genuine dislocation survives; two venues
 * pricing the SAME distribution on offset 1°F grids do NOT manufacture a tradable edge — only the
 * documented sub-bin noise floor), the frozen verdict (PASS / KILL / INSUFFICIENT_DATA at the
 * operator-ratified 10% / CI bar), and the pure/total guarantees.
 *
 * Fixtures build BOTH venues' ladders from ONE shared true integer PMF (binned onto each venue's
 * offset parity — Polymarket even-start, Kalshi odd-start) so "no edge from the offset alone" is a
 * real test, not an artifact of hand-tuned numbers.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BASIS_PRIOR,
  NEUTRAL_BASIS,
  GRID_LO_F,
  KALSHI_FEE_RATE,
  POLY_FEE_RATE,
  type BasisModel,
  type PanelDay,
  type VenueBucket,
  type VenueLadder,
  type VenueName,
  basisStraddleProb,
  crossVenueDivergence,
  crossVenueEdge,
  crossVenueVerdict,
  impliedLadder,
  survivalAt,
} from '../src/sim/cross-venue-arb.ts';

// ── shared-PMF fixtures ────────────────────────────────────────────────────────────────────────────

/** A realistic single-peaked daily-high PMF (°F → P), summing to 1. */
const TRUE_PMF: Record<number, number> = { 79: 0.02, 80: 0.09, 81: 0.15, 82: 0.30, 83: 0.24, 84: 0.12, 85: 0.05, 86: 0.03 };

const PMF_LO = 70;
const PMF_HI = 95;
const sumP = (pmf: Record<number, number>, lo: number, hi: number): number => {
  let s = 0;
  for (let k = lo; k <= hi; k++) s += pmf[k] ?? 0;
  return s;
};
const clampPx = (x: number): number => Math.max(0.002, Math.min(0.998, x));
const mkBucket = (loF: number | null, hiF: number | null, pmf: Record<number, number>, spread: number, size: number): VenueBucket => {
  const mass = sumP(pmf, loF ?? PMF_LO, hiF ?? PMF_HI);
  const mid = clampPx(mass);
  return { loF, hiF, yesAsk: clampPx(mid + spread / 2), yesBid: clampPx(mid - spread / 2), topAskSize: size, topBidSize: size };
};
/** Polymarket parity: EVEN-start 2°F bins (80-81, 82-83, …) + open tails. */
const polyFromPmf = (pmf: Record<number, number>, spread = 0.02, size = 400): VenueLadder => ({
  venue: 'polymarket',
  buckets: ([[null, 79], [80, 81], [82, 83], [84, 85], [86, 87], [88, null]] as Array<[number | null, number | null]>)
    .map(([lo, hi]) => mkBucket(lo, hi, pmf, spread, size)),
});
/** Kalshi parity: ODD-start 2°F bins (79-80, 81-82, …) + open tails — the 1°F offset vs Polymarket. */
const kalshiFromPmf = (pmf: Record<number, number>, spread = 0.02, size = 600): VenueLadder => ({
  venue: 'kalshi',
  buckets: ([[null, 78], [79, 80], [81, 82], [83, 84], [85, 86], [87, null]] as Array<[number | null, number | null]>)
    .map(([lo, hi]) => mkBucket(lo, hi, pmf, spread, size)),
});
/** Shift a PMF hotter by `d`°F (a genuine cross-venue distributional dislocation). */
const shiftPmf = (pmf: Record<number, number>, d: number): Record<number, number> =>
  Object.fromEntries(Object.entries(pmf).map(([k, p]) => [Number(k) + d, p]));

// ── implied PMF reconstruction ──────────────────────────────────────────────────────────────────

describe('impliedLadder — overround removed, proper PMF', () => {
  it('normalizes an overround book to a PMF summing to 1', () => {
    // inflate every quote so the book is heavily overround; normalization must still give Σpmf=1
    const impl = impliedLadder(polyFromPmf(TRUE_PMF, 0.1));
    expect(impl.ok).toBe(true);
    expect(impl.pmf.reduce((a, p) => a + p, 0)).toBeCloseTo(1, 9);
  });

  it('puts the implied mean near the modal bucket (~82°F)', () => {
    const impl = impliedLadder(polyFromPmf(TRUE_PMF));
    expect(impl.meanF).toBeGreaterThan(81);
    expect(impl.meanF).toBeLessThan(84);
  });

  it('survival is monotone non-increasing in k, =1 at the floor, =0 above the grid', () => {
    const impl = impliedLadder(polyFromPmf(TRUE_PMF));
    expect(survivalAt(impl, GRID_LO_F)).toBeCloseTo(1, 9);
    let prev = 1;
    for (let k = GRID_LO_F + 1; k <= 130; k++) {
      const s = survivalAt(impl, k);
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    expect(survivalAt(impl, 131)).toBe(0); // nothing above the grid ceiling
  });

  it('concentrates a dominant open tail near its boundary — no phantom mean distortion (the Denver fix)', () => {
    // Live lesson (Denver 2026-06-25): a cool day put 83% on "74° or below". Spreading that uniformly to
    // GRID_LO_F dragged the implied mean to ~53°F and faked a 21°F divergence. The mean must sit low-70s.
    const coolDenver: VenueLadder = {
      venue: 'kalshi',
      buckets: [
        { loF: null, hiF: 74, yesAsk: 0.84, yesBid: 0.83, topAskSize: 100, topBidSize: 100 },
        { loF: 75, hiF: 76, yesAsk: 0.11, yesBid: 0.09, topAskSize: 100, topBidSize: 100 },
        { loF: 77, hiF: 78, yesAsk: 0.04, yesBid: 0.03, topAskSize: 100, topBidSize: 100 },
        { loF: 79, hiF: 80, yesAsk: 0.01, yesBid: null, topAskSize: 100, topBidSize: 100 },
        { loF: 81, hiF: 82, yesAsk: 0.03, yesBid: null, topAskSize: 100, topBidSize: 100 },
        { loF: 83, hiF: null, yesAsk: 0.01, yesBid: null, topAskSize: 100, topBidSize: 100 },
      ],
    };
    const impl = impliedLadder(coolDenver);
    expect(impl.ok).toBe(true);
    expect(impl.meanF).toBeGreaterThan(71);
    expect(impl.meanF).toBeLessThan(76);
  });

  it('is total: junk / empty input → ok:false, never throws', () => {
    expect(impliedLadder({ venue: 'polymarket', buckets: [] }).ok).toBe(false);
    // @ts-expect-error — deliberately malformed
    expect(impliedLadder(null).ok).toBe(false);
    // @ts-expect-error — deliberately malformed (no usable price)
    expect(impliedLadder({ venue: 'kalshi', buckets: [{ loF: 80, hiF: 81 }] }).ok).toBe(false);
  });
});

// ── descriptive divergence ────────────────────────────────────────────────────────────────────────

describe('crossVenueDivergence — the analytics signal', () => {
  it('two venues pricing the SAME distribution show a near-zero mean difference', () => {
    const d = crossVenueDivergence(impliedLadder(polyFromPmf(TRUE_PMF)), impliedLadder(kalshiFromPmf(TRUE_PMF)));
    expect(d.ok).toBe(true);
    expect(Math.abs(d.meanDiffF)).toBeLessThan(0.6);
  });

  it('detects a genuine divergence when one venue is shifted +5°F hot', () => {
    const d = crossVenueDivergence(impliedLadder(polyFromPmf(TRUE_PMF)), impliedLadder(kalshiFromPmf(shiftPmf(TRUE_PMF, 5))));
    expect(d.meanDiffF).toBeLessThan(-3); // Kalshi hotter ⇒ poly − kalshi mean is strongly negative
    expect(d.maxAbsGap).toBeGreaterThan(0.4);
  });

  it('is total: a degenerate side → ok:false', () => {
    expect(crossVenueDivergence(impliedLadder({ venue: 'polymarket', buckets: [] }), impliedLadder(kalshiFromPmf(TRUE_PMF))).ok).toBe(false);
  });
});

// ── the basis model ────────────────────────────────────────────────────────────────────────────────

describe('basisStraddleProb — the dual-resolution-source friction', () => {
  it('is zero when the basis is degenerate (CLI == WU always)', () => {
    const impl = impliedLadder(polyFromPmf(TRUE_PMF));
    expect(basisStraddleProb(impl.pmf, { pmf: { 0: 1 } }, 82)).toBeCloseTo(0, 9);
  });

  it('grows with the basis spread and is largest near the modal threshold', () => {
    const impl = impliedLadder(polyFromPmf(TRUE_PMF));
    const wide: BasisModel = { pmf: { 0: 0.5, 1: 0.3, 2: 0.2 } };
    const atMode = basisStraddleProb(impl.pmf, wide, 83);
    const farTail = basisStraddleProb(impl.pmf, wide, 100);
    expect(atMode).toBeGreaterThan(farTail);
    expect(atMode).toBeGreaterThan(0);
  });
});

// ── the executable edge (the crux) ──────────────────────────────────────────────────────────────────

describe('crossVenueEdge — a genuine dislocation survives; the bin offset alone does NOT', () => {
  it('two venues pricing the SAME distribution yield no tradable edge (only sub-bin noise)', () => {
    // Both ladders are the SAME true PMF binned onto offset 1°F grids. The ONLY thing the engine can
    // find is the ~1-bin sub-bin interpolation residual — well under any executable threshold, and
    // (being unbiased) filtered by the gate's CI-excludes-0 requirement. Bound it generously.
    const e = crossVenueEdge(impliedLadder(polyFromPmf(TRUE_PMF)), impliedLadder(kalshiFromPmf(TRUE_PMF)));
    expect(e.bestNetEdge).toBeLessThan(0.05);
  });

  it('a real +5°F cross-venue dislocation produces a large positive executable edge', () => {
    // Kalshi genuinely hotter than Polymarket by 5°F — far beyond any basis — so Kalshi's high-temp
    // YES is richly bid: buy the cheap Polymarket leg, sell the rich Kalshi leg.
    const e = crossVenueEdge(impliedLadder(polyFromPmf(TRUE_PMF)), impliedLadder(kalshiFromPmf(shiftPmf(TRUE_PMF, 5))));
    expect(e.ok).toBe(true);
    expect(e.bestNetEdge).toBeGreaterThan(0.15);
    expect(e.direction).toBe('buyPolySellKalshi');
    expect(e.limitDepth).toBeGreaterThan(0);
  });

  it('the basis adjustment never INFLATES a Kalshi-rich dislocation edge (it is a cost)', () => {
    const poly = impliedLadder(polyFromPmf(TRUE_PMF));
    const kalshi = impliedLadder(kalshiFromPmf(shiftPmf(TRUE_PMF, 5)));
    const noBasis = crossVenueEdge(poly, kalshi, NEUTRAL_BASIS); // = the default now
    const withBasis = crossVenueEdge(poly, kalshi, DEFAULT_BASIS_PRIOR); // explicit CLI-hot prior
    expect(withBasis.direction).toBe('buyPolySellKalshi');
    expect(withBasis.bestNetEdge).toBeLessThanOrEqual(noBasis.bestNetEdge + 1e-9);
  });

  it('defaults to NEUTRAL_BASIS — the CLI-hot prior must not silently manufacture a buy-Kalshi edge', () => {
    // Two venues pricing the SAME WU distribution on offset grids. Under the default (now NEUTRAL) the
    // edge is sub-bin noise; under the explicit CLI-hot prior it is a larger phantom buy-Kalshi edge.
    const poly = impliedLadder(polyFromPmf(TRUE_PMF));
    const kalshi = impliedLadder(kalshiFromPmf(TRUE_PMF));
    const dft = crossVenueEdge(poly, kalshi); // default
    const prior = crossVenueEdge(poly, kalshi, DEFAULT_BASIS_PRIOR);
    expect(dft.bestNetEdge).toBeCloseTo(crossVenueEdge(poly, kalshi, NEUTRAL_BASIS).bestNetEdge, 9);
    expect(prior.bestNetEdge).toBeGreaterThan(dft.bestNetEdge); // the prior inflates the phantom
  });

  it('an EFFICIENT (≤0-edge) day still reports ok:true + real book depth — NOT a zeroed/no-depth edge', () => {
    // The winners-only-denominator BLOCKER: edge used to be tracked only when >0, so agreeing (efficient)
    // days fell through to a zeroed edge with limitDepth/bookDepth 0 and were dropped from the gate. Now a
    // constructible efficient day reports its true ≤0 edge AND the real book depth, so it counts as a KILL day.
    const poly = impliedLadder(polyFromPmf(TRUE_PMF, 0.02, 400));
    const kalshi = impliedLadder(kalshiFromPmf(TRUE_PMF, 0.02, 600));
    const e = crossVenueEdge(poly, kalshi);
    expect(e.ok).toBe(true);
    expect(e.polyBookDepth).toBe(400);
    expect(e.kalshiBookDepth).toBe(600);
    expect(e.bestNetEdge).toBeLessThan(0.05); // efficient — small/≤0 edge, but the day is NOT dropped
  });

  it('is total: a degenerate side → ok:false, zero edge, no throw', () => {
    const e = crossVenueEdge(impliedLadder({ venue: 'polymarket', buckets: [] }), impliedLadder(kalshiFromPmf(TRUE_PMF)));
    expect(e.ok).toBe(false);
    expect(e.bestNetEdge).toBe(0);
  });

  it('uses the two distinct fee curves (Polymarket 0.05, Kalshi 0.07) and a CLI-hot prior', () => {
    expect(POLY_FEE_RATE).toBe(0.05);
    expect(KALSHI_FEE_RATE).toBe(0.07);
    expect(DEFAULT_BASIS_PRIOR.pmf[0]).toBeGreaterThan(DEFAULT_BASIS_PRIOR.pmf[1]!);
  });
});

// ── the frozen verdict ──────────────────────────────────────────────────────────────────────────────

describe('crossVenueVerdict — the operator-ratified kill gate (clustered by city)', () => {
  const CITIES6 = ['nyc', 'la', 'chi', 'mia', 'aus', 'den'];
  const DATES5 = ['2026-06-21', '2026-06-22', '2026-06-23', '2026-06-24', '2026-06-25'];
  /** Build a panel: edgeFn(cityIdx, dateIdx) → netEdge; depth on by default. */
  const mkPanel = (
    edgeFn: (ci: number, di: number) => number,
    o: { cities?: string[]; dates?: string[]; depth?: boolean } = {},
  ): PanelDay[] => {
    const cities = o.cities ?? CITIES6;
    const dates = o.dates ?? DATES5;
    return cities.flatMap((c, ci) => dates.map((dt, di) => ({ city: c, targetDate: dt, netEdge: edgeFn(ci, di), hasRealDepth: o.depth ?? true })));
  };

  it('INSUFFICIENT_DATA below the minimum row count', () => {
    expect(crossVenueVerdict(mkPanel(() => 0.05, { cities: ['nyc', 'la'], dates: ['2026-06-24', '2026-06-25'] })).label).toBe('INSUFFICIENT_DATA');
  });

  it('INSUFFICIENT_DATA with enough rows but too FEW CITIES (a single-city signal is not cross-venue)', () => {
    const v = crossVenueVerdict(mkPanel(() => 0.05, { cities: ['nyc', 'la', 'chi'] })); // 3 cities × 5 dates = 15 rows
    expect(v.nDepthDays).toBe(15);
    expect(v.nCities).toBe(3);
    expect(v.label).toBe('INSUFFICIENT_DATA');
  });

  it('INSUFFICIENT_DATA with enough rows/cities but too FEW DISTINCT DATES (~1 calendar day is not a week)', () => {
    const v = crossVenueVerdict(mkPanel(() => 0.05, { dates: ['2026-06-24', '2026-06-25'] })); // 6 cities × 2 dates = 12 rows
    expect(v.nDistinctDays).toBe(2);
    expect(v.label).toBe('INSUFFICIENT_DATA');
  });

  it('KILL when fewer than 10% of real-depth days are net-positive', () => {
    const v = crossVenueVerdict(mkPanel((ci, di) => (ci === 0 && di === 0 ? 0.02 : -0.03))); // 1/30 positive
    expect(v.label).toBe('KILL');
    expect(v.winFrac).toBeCloseTo(1 / 30, 6);
  });

  it('KILL when half the days win but the CITY-CLUSTERED CI straddles 0', () => {
    // alternate cities strongly +/−: winFrac≈0.5 but the 6 city means straddle 0 → CI includes 0.
    const v = crossVenueVerdict(mkPanel((ci) => (ci % 2 === 0 ? 0.25 : -0.25)));
    expect(v.winFrac).toBeCloseTo(0.5, 6);
    expect(v.ciLow).toBeLessThan(0);
    expect(v.label).toBe('KILL');
  });

  it('PASS only when ≥10% win AND the city-clustered CI excludes 0', () => {
    const v = crossVenueVerdict(mkPanel((ci, di) => 0.04 + ((ci + di) % 3) * 0.003)); // all positive, low between-city var
    expect(v.winFrac).toBe(1);
    expect(v.nCities).toBe(6);
    expect(v.ciLow).toBeGreaterThan(0);
    expect(v.label).toBe('PASS');
  });

  it('clustering is conservative: a per-CITY artifact (one city carries all the edge) does NOT PASS', () => {
    // only nyc is strongly positive; the other 5 cities ~0. Naive i.i.d. might over-weight nyc's many rows;
    // city-clustering makes nyc one observation among 6 → between-city variance is large → CI straddles 0.
    const v = crossVenueVerdict(mkPanel((ci) => (ci === 0 ? 0.5 : 0.001)));
    expect(v.label).not.toBe('PASS');
  });

  it('excludes non-real-depth days from the panel (the book-liquidity filter)', () => {
    const v = crossVenueVerdict(mkPanel(() => 0.05, { depth: false }));
    expect(v.nDepthDays).toBe(0);
    expect(v.label).toBe('INSUFFICIENT_DATA');
  });

  it('is total: empty / junk panel → INSUFFICIENT_DATA, no throw', () => {
    expect(crossVenueVerdict([]).label).toBe('INSUFFICIENT_DATA');
    // @ts-expect-error — deliberately malformed
    expect(crossVenueVerdict(null).label).toBe('INSUFFICIENT_DATA');
  });
});
