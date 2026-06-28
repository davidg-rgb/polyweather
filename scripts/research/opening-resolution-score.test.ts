/**
 * Tests for the hold-to-resolution scorer (scripts/research/opening-resolution-score.ts) — the screen that says
 * whether buying our forecast-center and holding to resolution carries edge. Its pure core (scoreBin/scoreAll +
 * the Šidák multiplicity headline, the independence floors, the executable-depth floor, the venue-vs-truth ruler
 * with grading_mismatch exclusion, probit/sidakZ, reduceEventBands/summarizeBand) previously had only a CLI-time
 * sanity() that does NOT run under `pnpm test`; this brings it into CI (mirrors opening-spike.test.ts).
 *
 * The decisive adversarial properties pinned here: (1) no GO/NO-GO on a single climatic draw (≥7 dates / ≥6
 * cities floors); (2) no TERMINAL NO-GO from a lone losing bin (≥MIN_NOGO_BINS); (3) the bin-sweep GO pays a
 * Šidák multiplicity penalty; (4) a $-thin top-of-book is not a scored entry; (5) grading_mismatch payouts are
 * excluded; (6) the band basket pays only HELD buckets, net the canonical rate·p·(1−p) fee.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_NOGO_BINS,
  MIN_RESOLVED,
  mean,
  meanCi95,
  probit,
  reduceEventBands,
  sampleStd,
  scoreAll,
  sidakZ,
  summarizeBand,
  type BandBucketRow,
  type ScoreRow,
} from './opening-resolution-score.ts';

const row = (over: Partial<ScoreRow>): ScoreRow => ({
  eventId: 'E', city: 'x', targetDate: '2026-06-29', binIdx: 3, binLabel: '1-2h', entryAgeH: 1.5,
  centerIdx: 5, execAsk: 0.3, execBid: 0.25, depthUsd: 100, evVol24h: 5000,
  mktFavIdx: 5, mktFavAsk: 0.3, polyWinnerIdx: null, winningBucketIdx: null, winnerIdx: null,
  gradingMismatch: false, resolvedAt: null, ...over,
});

const bb = (over: Partial<BandBucketRow>): BandBucketRow => ({
  eventId: 'B1', targetDate: '2026-06-29', forecastIdx: 5, bucketIdx: 5,
  minAsk: 0.2, maxAsk: 0.4, lowAgeH: 2, highAgeH: 0.1, winnerIdx: 6, gradingMismatch: false, resolvedAt: 'r', ...over,
});

/** N events in one bin, clearing the date/city floors (9 dates × 7 cities), VENUE-resolved (polyWinnerIdx set so
 *  the venue-resolution gate is cleared), with a per-event winner rule. */
const panel = (n: number, win: (i: number) => number, over: (i: number) => Partial<ScoreRow> = () => ({})): ScoreRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({
      eventId: `P${i}`, city: `c${i % 7}`, targetDate: `2026-06-${10 + (i % 9)}`,
      centerIdx: 5, winnerIdx: win(i), winningBucketIdx: win(i), polyWinnerIdx: win(i), resolvedAt: 'r', ...over(i),
    }),
  );

describe('pure stats', () => {
  it('mean / sampleStd', () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2, 12);
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(sampleStd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(Number.isNaN(sampleStd([1]))).toBe(true);
  });
  it('meanCi95 brackets the mean and is NaN for n<2', () => {
    const ci = meanCi95([0.1, 0.2, 0.3, 0.4]);
    expect(ci.low).toBeLessThan(ci.mean);
    expect(ci.high).toBeGreaterThan(ci.mean);
    expect(Number.isNaN(meanCi95([0.5]).low)).toBe(true);
  });
  it('probit (inverse normal CDF)', () => {
    expect(probit(0.975)).toBeCloseTo(1.959964, 4);
    expect(probit(0.95)).toBeCloseTo(1.644854, 4);
    expect(probit(0.5)).toBeCloseTo(0, 6);
    expect(Number.isNaN(probit(0))).toBe(true);
    expect(Number.isNaN(probit(1))).toBe(true);
  });
  it('sidakZ grows with the family size and equals nominal at k=1', () => {
    expect(sidakZ(1)).toBeCloseTo(1.959964, 4);
    expect(sidakZ(8)).toBeGreaterThan(2.7);
    expect(sidakZ(8)).toBeLessThan(2.75);
    expect(sidakZ(8)).toBeGreaterThan(sidakZ(2));
    expect(sidakZ(2)).toBeGreaterThan(sidakZ(1));
  });
});

describe('scoreAll — verdict gate', () => {
  it('unresolved panel ⇒ no bestBin, INSUFFICIENT', () => {
    const res = scoreAll([row({}), row({ eventId: 'F' })], 0);
    expect(res.nResolvedEvents).toBe(0);
    expect(res.bestBin).toBeNull();
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA');
  });

  it('clearly-winning panel (70% @ 0.30, 9 dates × 7 cities) ⇒ GO at k=1', () => {
    const res = scoreAll(panel(60, (i) => (i % 10 < 7 ? 5 : 1)), 0);
    const b3 = res.bins.find((b) => b.binIdx === 3)!;
    expect(b3.label).toBe('GO');
    expect(b3.centerHitRate).toBeCloseTo(0.7, 9);
    expect(res.headlineLabel).toBe('GO');
    expect(res.headlineZ).toBeCloseTo(1.959964, 3);
  });

  it('clearly-losing panel across 3 bins ⇒ terminal NO-GO', () => {
    const lose: ScoreRow[] = [];
    for (let bin = 0; bin < 3; bin++) {
      for (let i = 0; i < 40; i++) {
        const w = i % 20 === 0 ? 5 : 2;
        lose.push(row({
          eventId: `L${bin}_${i}`, binIdx: bin, binLabel: `b${bin}`, city: `c${i % 7}`,
          targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5,
          winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r',
        }));
      }
    }
    const res = scoreAll(lose, 0);
    expect(res.bins.find((b) => b.binIdx === 0)!.label).toBe('NO-GO');
    expect(res.nEligibleBins).toBe(3);
    expect(res.headlineLabel).toBe('NO-GO');
  });

  it('a SINGLE losing eligible bin is nominally NO-GO but does NOT terminal-NO-GO the lever (MIN_NOGO_BINS)', () => {
    const oneBin = panel(40, (i) => (i % 20 === 0 ? 5 : 2));
    const res = scoreAll(oneBin, 0);
    expect(res.bins.find((b) => b.binIdx === 3)!.label).toBe('NO-GO');
    expect(res.nEligibleBins).toBeLessThan(MIN_NOGO_BINS);
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA');
  });

  it('terminal NO-GO uses the Šidák-WIDENED upper bound, not the nominal one (kill side ≥ GO-side rigor)', () => {
    // 8 bins, each 13/40 wins @ $0.50 ⇒ meanRoi −0.35, nominal roiHigh ≈ −0.056 (<0 ⇒ each bin nominally NO-GO),
    // but the k=8 Šidák-widened upper bound ≈ +0.059 (>0) ⇒ the headline must NOT terminal-NO-GO ⇒ INSUFFICIENT.
    const marginal: ScoreRow[] = [];
    for (let bin = 0; bin < 8; bin++) {
      for (let i = 0; i < 40; i++) {
        const w = i < 13 ? 5 : 1;
        marginal.push(row({
          eventId: `Mg${bin}_${i}`, binIdx: bin, binLabel: `b${bin}`, city: `c${i % 7}`,
          targetDate: `2026-06-${10 + (i % 9)}`, execAsk: 0.5, mktFavAsk: 0.5,
          centerIdx: 5, winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r',
        }));
      }
    }
    const res = scoreAll(marginal, 0);
    expect(res.nEligibleBins).toBe(8);
    expect(res.bins.every((b) => b.label === 'NO-GO')).toBe(true); // nominal kill on every bin
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA'); // widened bound rescues it from a false terminal kill
  });

  it('fair panel (30% @ 0.30) ⇒ INSUFFICIENT (CI straddles 0)', () => {
    const res = scoreAll(panel(60, (i) => (i % 10 < 3 ? 5 : 9)), 0);
    expect(res.bins.find((b) => b.binIdx === 3)!.label).toBe('INSUFFICIENT_DATA');
  });

  // SINGLE-FLOOR ISOLATION (finding #1): each fixture violates exactly ONE of the three floors while clearing the
  // other two, so a regression dropping any single floor clause is independently caught.
  it('isolates MIN_RESOLVED: 39 resolved but ≥7 dates / ≥6 cities ⇒ INSUFFICIENT', () => {
    const f = panel(39, (i) => (i % 10 < 7 ? 5 : 1)); // 39 < 40, 9 dates, 7 cities
    const b = f[0]!;
    expect(new Set(f.map((r) => r.targetDate)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(f.map((r) => r.city)).size).toBeGreaterThanOrEqual(6);
    expect(b).toBeDefined();
    expect(scoreAll(f, 0).bins.find((x) => x.binIdx === 3)!.label).toBe('INSUFFICIENT_DATA');
  });
  it('isolates MIN_DATES: ≥40 resolved / ≥6 cities but only 6 dates ⇒ INSUFFICIENT', () => {
    const f = panel(48, (i) => (i % 10 < 7 ? 5 : 1), (i) => ({ targetDate: `2026-06-${10 + (i % 6)}`, city: `c${i % 7}` }));
    expect(new Set(f.map((r) => r.targetDate)).size).toBe(6);
    expect(new Set(f.map((r) => r.city)).size).toBeGreaterThanOrEqual(6);
    const res = scoreAll(f, 0);
    expect(res.bins.find((x) => x.binIdx === 3)!.nResolved).toBeGreaterThanOrEqual(MIN_RESOLVED);
    expect(res.bins.find((x) => x.binIdx === 3)!.label).toBe('INSUFFICIENT_DATA');
  });
  it('isolates MIN_CITIES: ≥40 resolved / ≥7 dates but only 5 cities ⇒ INSUFFICIENT', () => {
    const f = panel(48, (i) => (i % 10 < 7 ? 5 : 1), (i) => ({ targetDate: `2026-06-${10 + (i % 9)}`, city: `c${i % 5}` }));
    expect(new Set(f.map((r) => r.targetDate)).size).toBeGreaterThanOrEqual(7);
    expect(new Set(f.map((r) => r.city)).size).toBe(5);
    const res = scoreAll(f, 0);
    expect(res.bins.find((x) => x.binIdx === 3)!.nResolved).toBeGreaterThanOrEqual(MIN_RESOLVED);
    expect(res.bins.find((x) => x.binIdx === 3)!.label).toBe('INSUFFICIENT_DATA');
  });

  it('INDEPENDENCE FLOOR: 48 strong wins but only 2 dates / 2 cities ⇒ INSUFFICIENT (no GO on one climatic draw)', () => {
    const clustered = Array.from({ length: 48 }, (_, i) => {
      const w = i % 10 < 8 ? 5 : 1;
      return row({ eventId: `Cl${i}`, city: `c${i % 2}`, targetDate: `2026-06-${10 + (i % 2)}`, centerIdx: 5, winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r' });
    });
    const res = scoreAll(clustered, 0);
    expect(res.bins.find((b) => b.binIdx === 3)!.nResolved).toBeGreaterThanOrEqual(MIN_RESOLVED);
    expect(res.bins.find((b) => b.binIdx === 3)!.label).toBe('INSUFFICIENT_DATA');
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA');
  });

  it('EXECUTABLE-DEPTH FLOOR: $10-deep entries drop at --min-depth 50 (INSUFFICIENT) but score at 0 (GO)', () => {
    const thin = panel(60, (i) => (i % 10 < 7 ? 5 : 1)).map((r) => ({ ...r, depthUsd: 10 }));
    expect(scoreAll(thin, 0, 50).bins.find((b) => b.binIdx === 3)!.nResolved).toBe(0);
    expect(scoreAll(thin, 0, 50).bins.find((b) => b.binIdx === 3)!.label).toBe('INSUFFICIENT_DATA');
    expect(scoreAll(thin, 0, 0).bins.find((b) => b.binIdx === 3)!.label).toBe('GO');
  });

  it('MULTIPLICITY: 8 bins each nominally GO (27/40 @ 0.50) but the family-wise headline is INSUFFICIENT', () => {
    const multi: ScoreRow[] = [];
    for (let bin = 0; bin < 8; bin++) {
      for (let i = 0; i < 40; i++) {
        const w = i < 27 ? 5 : 1;
        multi.push(row({
          eventId: `M${bin}_${i}`, binIdx: bin, binLabel: `b${bin}`, city: `c${i % 7}`,
          targetDate: `2026-06-${10 + (i % 9)}`, execAsk: 0.5, mktFavAsk: 0.5,
          centerIdx: 5, winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r',
        }));
      }
    }
    const res = scoreAll(multi, 0);
    expect(res.nEligibleBins).toBe(8);
    expect(res.bins.every((b) => b.label === 'GO')).toBe(true);
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA');
  });
});

describe('scoreAll — resolution ruler (venue vs truth grade) + grading_mismatch', () => {
  it('excludes grading_mismatch and splits venue vs grade provenance', () => {
    const base = panel(60, (i) => (i % 10 < 7 ? 5 : 1));
    const prov = base.map((r, i) => ({ ...r, gradingMismatch: i % 3 === 0, polyWinnerIdx: i % 3 === 1 ? r.winnerIdx : null }));
    const res = scoreAll(prov, 0);
    expect(res.nMismatchExcluded).toBe(20);
    expect(res.nVenueResolved).toBe(20);
    expect(res.nGradeResolved).toBe(20);
    expect(res.bins.find((b) => b.binIdx === 3)!.nResolved).toBe(40); // 20 mismatch dropped
  });

  it('an all-grading_mismatch panel scores nothing ⇒ INSUFFICIENT', () => {
    const allMm = panel(60, (i) => (i % 10 < 7 ? 5 : 1)).map((r) => ({ ...r, gradingMismatch: true }));
    const res = scoreAll(allMm, 0);
    expect(res.bins.find((b) => b.binIdx === 3)!.nResolved).toBe(0);
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA');
  });

  it('VENUE GATE: a strong-GO panel resolved ONLY by our truth grade (no venue) ⇒ headline INSUFFICIENT (forecast-skill diagnostic, not venue P&L)', () => {
    const gradeOnly = panel(60, (i) => (i % 10 < 7 ? 5 : 1), () => ({ polyWinnerIdx: null }));
    const res = scoreAll(gradeOnly, 0);
    expect(res.nVenueResolved).toBe(0);
    expect(res.nGradeResolved).toBe(60);
    expect(res.bins.find((b) => b.binIdx === 3)!.label).toBe('GO'); // nominal forecast-skill GO
    expect(res.venueGated).toBe(true);
    expect(res.headlineLabel).toBe('INSUFFICIENT_DATA'); // refused — no venue resolution
  });
});

describe('scoreAll — canonical fee', () => {
  it('--fee-rate lowers ROI via rate·p·(1−p) but a strong GO survives the 5% rate', () => {
    const win = panel(60, (i) => (i % 10 < 7 ? 5 : 1));
    const gross = scoreAll(win, 0).bins.find((b) => b.binIdx === 3)!.meanRoi;
    const net = scoreAll(win, 0.05).bins.find((b) => b.binIdx === 3)!.meanRoi;
    expect(net).toBeLessThan(gross);
    expect(scoreAll(win, 0.05).headlineLabel).toBe('GO');
  });
});

describe('forecast-band — envelope, basketPaid vs bandHit, fee, grading_mismatch', () => {
  const bandRows: BandBucketRow[] = [
    bb({ eventId: 'B1', bucketIdx: 4, minAsk: 0.10, maxAsk: 0.30, winnerIdx: 6 }),
    bb({ eventId: 'B1', bucketIdx: 5, minAsk: 0.20, maxAsk: 0.40, winnerIdx: 6 }),
    bb({ eventId: 'B1', bucketIdx: 6, minAsk: 0.15, maxAsk: 0.35, winnerIdx: 6 }),
    bb({ eventId: 'B2', targetDate: '2026-06-30', bucketIdx: 4, minAsk: 0.12, maxAsk: 0.32, winnerIdx: 9 }),
    bb({ eventId: 'B2', targetDate: '2026-06-30', bucketIdx: 5, minAsk: 0.22, maxAsk: 0.42, winnerIdx: 9 }),
    bb({ eventId: 'B2', targetDate: '2026-06-30', bucketIdx: 6, minAsk: 0.18, maxAsk: 0.38, winnerIdx: 9 }),
  ];

  it('envelope + basket cost + bandHit/basketPaid', () => {
    const b1 = reduceEventBands(bandRows).find((e) => e.eventId === 'B1')!;
    expect(b1.singleLowAsk).toBe(0.10);
    expect(b1.singleHighAsk).toBe(0.40);
    expect(b1.basketCostLow).toBeCloseTo(0.45, 9);
    expect(b1.bandHit).toBe(true);
    expect(b1.basketPaid).toBe(true); // winner 6 ∈ held {4,5,6}
    const bs = summarizeBand(bandRows);
    expect(bs.nResolved).toBe(2);
    expect(bs.bandHitRate).toBeCloseTo(0.5, 9);
    expect(bs.bestCaseBasketRoi).toBeCloseTo(0.1111, 3);
  });

  it('basketPaid DIVERGES from bandHit when a within-±1 winner was never purchasable', () => {
    const unbought: BandBucketRow[] = [
      bb({ eventId: 'B3', bucketIdx: 5, minAsk: 0.2, maxAsk: 0.4, winnerIdx: 4 }),
      bb({ eventId: 'B3', bucketIdx: 6, minAsk: 0.15, maxAsk: 0.35, winnerIdx: 4 }),
    ];
    const e3 = reduceEventBands(unbought)[0]!;
    expect(e3.bandHit).toBe(true); // |4 − 5| = 1, forecast-accurate
    expect(e3.basketPaid).toBe(false); // 4 ∉ held {5,6}
    const bs = summarizeBand(unbought);
    expect(bs.bandHitRate).toBe(1);
    expect(bs.basketPaidRate).toBe(0);
    expect(bs.bestCaseBasketRoi).toBeLessThan(0); // unbought hit pays $0 ⇒ a loss
  });

  it('--fee-rate lowers basket ROI; grading_mismatch events drop', () => {
    expect(summarizeBand(bandRows, 0.05).bestCaseBasketRoi).toBeLessThan(summarizeBand(bandRows, 0).bestCaseBasketRoi);
    const dropped = summarizeBand(bandRows.map((r) => ({ ...r, gradingMismatch: r.eventId === 'B2' })));
    expect(dropped.nEvents).toBe(1);
    expect(dropped.nResolved).toBe(1);
  });

  it('empty band is total', () => {
    expect(summarizeBand([]).nEvents).toBe(0);
  });
});
