/**
 * Sanity tests for the committed city-scan verdict record (core/sim/city-scan-results). Mirrors
 * amsterdam-climatology.test.ts's discipline: guard the frozen record's structural invariants + golden
 * values so a bad hand-edit can't silently ship a number the source docs (SIGNAL-BACKLOG.md §12 verdict +
 * Data appendix, FASTTRACK-PLAN.md C15-C21) don't actually support — including proving the two enrolled
 * candidates genuinely clear the pre-registered bar (TRAIN LB > 0 AND TEST net > 0), the three rejected
 * cells genuinely don't, and the pooled tables stay internally consistent (n sums, ROI = net/(n*$10),
 * curve-vs-tercile net totals within display rounding).
 */
import { describe, expect, it } from 'vitest';
import {
  CITY_SCAN_ASK_SPLIT,
  CITY_SCAN_CAVEATS,
  CITY_SCAN_CONFIDENCE_TERCILES,
  CITY_SCAN_CONFIRMATION_CLOCK,
  CITY_SCAN_ENROLLMENT,
  CITY_SCAN_META,
  CITY_SCAN_POOLED_CURVE,
  CITY_SCAN_TOP5_TRAIN_CELLS,
} from '../src/sim/city-scan-results.ts';

describe('city-scan-results record', () => {
  describe('CITY_SCAN_META', () => {
    it('cells = bets + skips, and the skip breakdown sums to the skip total', () => {
      expect(CITY_SCAN_META.nBets + CITY_SCAN_META.nSkips).toBe(CITY_SCAN_META.nCells);
      const { askTooHigh, alreadyResolved, noTick } = CITY_SCAN_META.skipBreakdown;
      expect(askTooHigh + alreadyResolved + noTick).toBe(CITY_SCAN_META.nSkips);
    });

    it('DB-recovered + frozen-seed-fallback percentages sum to ~100%', () => {
      expect(CITY_SCAN_META.pctDbRecoveredForecast + CITY_SCAN_META.pctFrozenSeedFallback).toBeCloseTo(100, 0);
    });

    it('the frozen-seed fallback count is consistent with its share of total bets (~4.1%)', () => {
      const impliedPct = (CITY_SCAN_META.nFallbackBets / CITY_SCAN_META.nBets) * 100;
      expect(impliedPct).toBeCloseTo(CITY_SCAN_META.pctFrozenSeedFallback, 1);
    });

    it('TRAIN ends strictly before TEST begins', () => {
      expect(CITY_SCAN_META.trainLastDate < CITY_SCAN_META.testFirstDate).toBe(true);
    });

    it('carries the reproducibility record (2 independent runs, 1 review lens)', () => {
      expect(CITY_SCAN_META.nIndependentRuns).toBe(2);
      expect(CITY_SCAN_META.nReviewLenses).toBeGreaterThanOrEqual(1);
      expect(CITY_SCAN_META.sourceDocs.length).toBeGreaterThan(0);
    });

    it('scan universe matches the pre-registration (golden values)', () => {
      expect(CITY_SCAN_META.nEvents).toBe(844);
      expect(CITY_SCAN_META.nCities).toBe(45);
      expect(CITY_SCAN_META.nDays).toBe(21);
      expect(CITY_SCAN_META.nBets).toBe(7262);
      expect(CITY_SCAN_META.nSkips).toBe(2022);
      expect(CITY_SCAN_META.nDbPullRows).toBe(10909);
      expect(CITY_SCAN_META.nFallbackBets).toBe(296);
    });
  });

  describe('CITY_SCAN_POOLED_CURVE (Data appendix golden values)', () => {
    it('covers all 11 pre-registered entry hours (9..19), sequential', () => {
      expect(CITY_SCAN_POOLED_CURVE.map((r) => r.hour)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    });

    it('per-hour n sums to the total bet count (7,262)', () => {
      expect(CITY_SCAN_POOLED_CURVE.reduce((s, r) => s + r.n, 0)).toBe(CITY_SCAN_META.nBets);
    });

    it('every hour is negative — "pooled negative at every arm hour"', () => {
      for (const r of CITY_SCAN_POOLED_CURVE) {
        expect(r.roiPp, `roiPp @${r.hour}h`).toBeLessThan(0);
        expect(r.netUsd, `netUsd @${r.hour}h`).toBeLessThan(0);
      }
    });

    it('ROI equals net/(n × $10) at display precision, every row', () => {
      for (const r of CITY_SCAN_POOLED_CURVE) {
        const implied = (r.netUsd / (r.n * 10)) * 100;
        expect(Math.abs(implied - r.roiPp), `ROI consistency @${r.hour}h`).toBeLessThanOrEqual(0.06);
      }
    });

    it('golden extremes: best −11.4pp @14h, worst −101.9pp @19h', () => {
      const best = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'best')!;
      const worst = CITY_SCAN_POOLED_CURVE.find((r) => r.label === 'worst')!;
      expect(best.hour).toBe(14);
      expect(best.roiPp).toBe(-11.4);
      expect(best.n).toBe(742);
      expect(best.netUsd).toBe(-843.89);
      expect(worst.hour).toBe(19);
      expect(worst.roiPp).toBe(-101.9);
      expect(worst.n).toBe(327);
      expect(worst.netUsd).toBe(-3333.21);
      // the labelled best/worst genuinely are the min/max magnitude of the whole curve
      for (const r of CITY_SCAN_POOLED_CURVE) {
        expect(r.roiPp).toBeLessThanOrEqual(best.roiPp);
        expect(r.roiPp).toBeGreaterThanOrEqual(worst.roiPp);
      }
    });

    it('monotone collapse holds from 14h → 19h (the fixed-bucket late-hour leg)', () => {
      const from14 = CITY_SCAN_POOLED_CURVE.filter((r) => r.hour >= 14);
      for (let i = 1; i < from14.length; i++) {
        expect(from14[i]!.roiPp, `monotone @${from14[i]!.hour}h`).toBeLessThan(from14[i - 1]!.roiPp);
        expect(from14[i]!.winRate, `winRate falls @${from14[i]!.hour}h`).toBeLessThan(from14[i - 1]!.winRate);
        expect(from14[i]!.meanAsk, `meanAsk falls @${from14[i]!.hour}h`).toBeLessThan(from14[i - 1]!.meanAsk);
      }
    });

    it('CIs are ordered (lo < hi) and contain the point estimate', () => {
      for (const r of CITY_SCAN_POOLED_CURVE) {
        expect(r.ciPp[0]).toBeLessThan(r.ciPp[1]);
        expect(r.roiPp).toBeGreaterThanOrEqual(r.ciPp[0]);
        expect(r.roiPp).toBeLessThanOrEqual(r.ciPp[1]);
        expect(r.winRate).toBeGreaterThanOrEqual(0);
        expect(r.winRate).toBeLessThanOrEqual(1);
        expect(r.meanAsk).toBeGreaterThan(0);
        expect(r.meanAsk).toBeLessThan(1);
      }
    });

    it('implied pooled winners (Σ n·winRate) reconcile with the ask-split winner count', () => {
      const implied = CITY_SCAN_POOLED_CURVE.reduce((s, r) => s + r.n * r.winRate, 0);
      expect(Math.abs(implied - CITY_SCAN_ASK_SPLIT.winN)).toBeLessThan(5); // 0.1pp-per-row rounding envelope
    });
  });

  describe('CITY_SCAN_ASK_SPLIT', () => {
    it('golden values with ns summing to the bet total', () => {
      expect(CITY_SCAN_ASK_SPLIT.winMeanAsk).toBe(0.539);
      expect(CITY_SCAN_ASK_SPLIT.loseMeanAsk).toBe(0.241);
      expect(CITY_SCAN_ASK_SPLIT.winN).toBe(2351);
      expect(CITY_SCAN_ASK_SPLIT.loseN).toBe(4911);
      expect(CITY_SCAN_ASK_SPLIT.winN + CITY_SCAN_ASK_SPLIT.loseN).toBe(CITY_SCAN_META.nBets);
      expect(CITY_SCAN_ASK_SPLIT.winMeanAsk).toBeGreaterThan(CITY_SCAN_ASK_SPLIT.loseMeanAsk);
    });
  });

  describe('CITY_SCAN_CONFIDENCE_TERCILES (Data appendix golden values)', () => {
    it('three rows, n summing to the bet total, contiguous confidence ranges', () => {
      expect(CITY_SCAN_CONFIDENCE_TERCILES.map((t) => t.tercile)).toEqual(['low', 'mid', 'high']);
      expect(CITY_SCAN_CONFIDENCE_TERCILES.reduce((s, t) => s + t.n, 0)).toBe(CITY_SCAN_META.nBets);
      for (let i = 1; i < CITY_SCAN_CONFIDENCE_TERCILES.length; i++) {
        // boundaries touch within display rounding (0.382/0.382 exact; 0.497→0.498 is a 0.001 rounding gap;
        // tolerance 0.0015 absorbs the IEEE754 epsilon on the subtraction)
        const gap = CITY_SCAN_CONFIDENCE_TERCILES[i]!.confRange[0] - CITY_SCAN_CONFIDENCE_TERCILES[i - 1]!.confRange[1];
        expect(Math.abs(gap)).toBeLessThanOrEqual(0.0015);
      }
    });

    it('golden values: monotone "higher confidence → less bad, never positive"', () => {
      const [low, mid, high] = CITY_SCAN_CONFIDENCE_TERCILES as [
        (typeof CITY_SCAN_CONFIDENCE_TERCILES)[number],
        (typeof CITY_SCAN_CONFIDENCE_TERCILES)[number],
        (typeof CITY_SCAN_CONFIDENCE_TERCILES)[number],
      ];
      expect(low.roiPp).toBe(-37.9);
      expect(mid.roiPp).toBe(-26.8);
      expect(high.roiPp).toBe(-22.2);
      expect(low.winRate).toBe(0.255);
      expect(mid.winRate).toBe(0.313);
      expect(high.winRate).toBe(0.404);
      // monotone, and never positive
      expect(low.roiPp).toBeLessThan(mid.roiPp);
      expect(mid.roiPp).toBeLessThan(high.roiPp);
      expect(high.roiPp).toBeLessThan(0);
      expect(low.winRate).toBeLessThan(mid.winRate);
      expect(mid.winRate).toBeLessThan(high.winRate);
    });

    it('ROI equals net/(n × $10) at display precision, and tercile net total matches the curve total (±$0.02)', () => {
      for (const t of CITY_SCAN_CONFIDENCE_TERCILES) {
        const implied = (t.netUsd / (t.n * 10)) * 100;
        expect(Math.abs(implied - t.roiPp), `tercile ${t.tercile}`).toBeLessThanOrEqual(0.06);
      }
      const tercileTotal = CITY_SCAN_CONFIDENCE_TERCILES.reduce((s, t) => s + t.netUsd, 0);
      const curveTotal = CITY_SCAN_POOLED_CURVE.reduce((s, r) => s + r.netUsd, 0);
      // known $0.01 display-rounding gap between the two appendix tables — flagged in the asset doc
      expect(Math.abs(tercileTotal - curveTotal)).toBeLessThanOrEqual(0.02);
    });
  });

  describe('CITY_SCAN_TOP5_TRAIN_CELLS (Data appendix golden values)', () => {
    it('has exactly five cells, in TRAIN-LB ranking order (descending)', () => {
      expect(CITY_SCAN_TOP5_TRAIN_CELLS).toHaveLength(5);
      expect(CITY_SCAN_TOP5_TRAIN_CELLS.map((c) => c.city)).toEqual([
        'munich', 'ankara', 'houston', 'buenos-aires', 'helsinki',
      ]);
      for (let i = 1; i < CITY_SCAN_TOP5_TRAIN_CELLS.length; i++) {
        expect(CITY_SCAN_TOP5_TRAIN_CELLS[i]!.trainLbPp).toBeLessThan(CITY_SCAN_TOP5_TRAIN_CELLS[i - 1]!.trainLbPp);
      }
    });

    it('exactly two cells clear the locked bar (TRAIN LB > 0 AND TEST net > 0) and are flagged candidates', () => {
      const candidates = CITY_SCAN_TOP5_TRAIN_CELLS.filter((c) => c.isCandidate);
      expect(candidates.map((c) => c.city).sort()).toEqual(['ankara', 'houston']);
      for (const c of candidates) {
        expect(c.trainLbPp).toBeGreaterThan(0);
        expect(c.testNetUsd).toBeGreaterThan(0);
        expect(c.failReason).toBeNull();
      }
    });

    it('golden candidate figures (ankara/houston)', () => {
      const ankara = CITY_SCAN_TOP5_TRAIN_CELLS.find((c) => c.city === 'ankara')!;
      expect(ankara).toMatchObject({
        icao: 'LTAC', arm: 14, trainN: 11, trainNetUsd: 78.82, trainLbPp: 3.6,
        testN: 8, testNetUsd: 44.88, testWinRate: 0.75,
      });
      expect(ankara.testCiPp).toEqual([-28.1, 64.4]);
      const houston = CITY_SCAN_TOP5_TRAIN_CELLS.find((c) => c.city === 'houston')!;
      expect(houston).toMatchObject({
        icao: 'KHOU', arm: 14, trainN: 11, trainNetUsd: 29.32, trainLbPp: 3.1,
        testN: 7, testNetUsd: 12.04, testWinRate: 0.857,
      });
      expect(houston.testCiPp).toEqual([-25.6, 47.4]);
    });

    it('every non-candidate fails at least one prong of the locked bar, with a stated reason', () => {
      const rejected = CITY_SCAN_TOP5_TRAIN_CELLS.filter((c) => !c.isCandidate);
      expect(rejected.map((c) => c.city).sort()).toEqual(['buenos-aires', 'helsinki', 'munich']);
      for (const c of rejected) {
        expect(c.trainLbPp <= 0 || c.testNetUsd <= 0, `${c.city} fails a prong`).toBe(true);
        expect(c.failReason).toBeTruthy();
      }
    });

    it('the two asymmetry poster children: munich tops TRAIN yet loses TEST; helsinki wins TEST yet fails TRAIN', () => {
      const munich = CITY_SCAN_TOP5_TRAIN_CELLS[0]!;
      expect(munich.city).toBe('munich');
      expect(munich.trainLbPp).toBe(6.9); // the highest LB of all five
      expect(munich.testNetUsd).toBe(-30.86); // and it loses out-of-sample
      const helsinki = CITY_SCAN_TOP5_TRAIN_CELLS[4]!;
      expect(helsinki.city).toBe('helsinki');
      expect(helsinki.trainLbPp).toBe(-0.1); // fails the TRAIN prong
      expect(helsinki.testNetUsd).toBe(44.23); // its positive TEST net does NOT make it a candidate
      expect(helsinki.isCandidate).toBe(false);
    });

    it('every TEST CI straddles zero at n=7-8 (the pre-registered humility clause)', () => {
      for (const c of CITY_SCAN_TOP5_TRAIN_CELLS) {
        expect(c.testN).toBeGreaterThanOrEqual(7);
        expect(c.testN).toBeLessThanOrEqual(8);
        expect(c.testCiPp[0], `${c.city} ciLo`).toBeLessThan(0);
        expect(c.testCiPp[1], `${c.city} ciHi`).toBeGreaterThan(0);
        expect(c.trainN).toBeGreaterThanOrEqual(10);
        expect(c.testWinRate).toBeGreaterThanOrEqual(0);
        expect(c.testWinRate).toBeLessThanOrEqual(1);
      }
    });

    it('both enrolled candidates share arm 14h and city+arm pairs are unique', () => {
      for (const c of CITY_SCAN_TOP5_TRAIN_CELLS.filter((c) => c.isCandidate)) expect(c.arm).toBe(14);
      const keys = CITY_SCAN_TOP5_TRAIN_CELLS.map((c) => `${c.city}-${c.arm}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('CITY_SCAN_CAVEATS', () => {
    it('carries exactly the three pre-registered/verdict caveats', () => {
      expect(CITY_SCAN_CAVEATS).toHaveLength(3);
      for (const c of CITY_SCAN_CAVEATS) expect(c.length).toBeGreaterThan(20);
    });

    it('names the fixed-bucket artifact, the straddle-zero CIs, and the select-vs-confirm discipline', () => {
      expect(CITY_SCAN_CAVEATS[0]).toMatch(/fixed.bucket/i);
      expect(CITY_SCAN_CAVEATS[1]).toMatch(/straddle/i);
      expect(CITY_SCAN_CAVEATS[2]).toMatch(/SELECTS/);
      expect(CITY_SCAN_CAVEATS[2]).toMatch(/CONFIRMS/);
    });
  });

  describe('CITY_SCAN_ENROLLMENT', () => {
    it('enrolls exactly ankara + houston, both racing through the scan-selected arm', () => {
      expect(CITY_SCAN_ENROLLMENT.map((e) => e.city).sort()).toEqual(['ankara', 'houston']);
      for (const e of CITY_SCAN_ENROLLMENT) {
        expect(e.armHours).toContain(e.forecastMaxHour);
        expect(e.forecastMaxHour).toBe(14);
        expect(e.activeUntil).toBe('2026-07-31');
        expect(e.backfillNGraded).toBeLessThanOrEqual(e.backfillNBets);
      }
    });

    it('every enrolled city also appears in the candidate table with a matching arm', () => {
      for (const e of CITY_SCAN_ENROLLMENT) {
        const cell = CITY_SCAN_TOP5_TRAIN_CELLS.find((c) => c.city === e.city);
        expect(cell?.isCandidate).toBe(true);
        expect(cell?.arm).toBe(e.forecastMaxHour);
      }
    });

    it('houston is flagged as the sim\'s first Fahrenheit city', () => {
      const houston = CITY_SCAN_ENROLLMENT.find((e) => e.city === 'houston');
      expect(houston?.note).toMatch(/first.*F.*city/i);
    });
  });

  it('the confirmation clock post-dates the enrollment backfill window (in-sample discipline)', () => {
    const houston = CITY_SCAN_ENROLLMENT.find((e) => e.city === 'houston')!;
    expect(houston.backfillLastDate < CITY_SCAN_CONFIRMATION_CLOCK).toBe(true);
    expect(CITY_SCAN_CONFIRMATION_CLOCK).toBe('2026-07-04');
  });
});
