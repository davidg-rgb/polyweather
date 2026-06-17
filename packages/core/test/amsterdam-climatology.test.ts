/**
 * Sanity tests for the committed Schiphol climatology asset (core/sim/amsterdam-climatology). Guards the
 * generated data's structural invariants so a bad regen can't silently ship: full month coverage, complete
 * 24-hour curves, probabilities in range, and the physical monotonicities (the floor can only rise; once
 * the peak passes, remaining upside can only fall).
 */
import { describe, expect, it } from 'vitest';
import { AMSTERDAM_CLIMATOLOGY as C } from '../src/sim/amsterdam-climatology.ts';

describe('amsterdam-climatology asset', () => {
  it('covers ~20 years and every month', () => {
    expect(C.station).toBe(240);
    expect(C.fromYear).toBeLessThanOrEqual(2006);
    expect(C.toYear).toBeGreaterThanOrEqual(2025);
    expect(C.nDays).toBeGreaterThan(7000);
    expect(C.decisionHours).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(C.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  for (const m of C.months) {
    describe(`month ${m.month}`, () => {
      it('has complete 24-hour curves and a histogram that sums to ~1', () => {
        expect(m.avgTempC).toHaveLength(24);
        expect(m.avgRunMaxC).toHaveLength(24);
        expect(m.peakHourHistogram).toHaveLength(24);
        expect(m.nDays).toBeGreaterThan(0);
        // Curves must be physically sane Schiphol temperatures — catches a fabricated 0 (mean([])) or any
        // wild value from a bad regen (the generator now also throws on an empty-hour sample).
        for (const t of [...m.avgTempC, ...m.avgRunMaxC]) {
          expect(t).toBeGreaterThan(-20);
          expect(t).toBeLessThan(45);
        }
        const sum = m.peakHourHistogram.reduce((a, b) => a + b, 0);
        expect(sum).toBeGreaterThan(0.97);
        expect(sum).toBeLessThan(1.03);
        expect(m.medianPeakHour).toBeGreaterThanOrEqual(0);
        expect(m.medianPeakHour).toBeLessThanOrEqual(23);
      });

      it('avg running-max is non-decreasing through the day (a floor can only rise)', () => {
        for (let h = 1; h < 24; h++) {
          expect(m.avgRunMaxC[h]!).toBeGreaterThanOrEqual(m.avgRunMaxC[h - 1]! - 0.06); // rounding tolerance
        }
      });

      it('decision stats are in range and physically monotone across hours', () => {
        const d = m.decisionByHour;
        expect(d.map((x) => x.hour)).toEqual(C.decisionHours);
        for (const s of d) {
          for (const p of [s.peakedPct, s.leUpside05, s.leUpside10]) {
            expect(p).toBeGreaterThanOrEqual(0);
            expect(p).toBeLessThanOrEqual(1);
          }
          expect(s.leUpside10).toBeGreaterThanOrEqual(s.leUpside05 - 1e-9); // ≤1.0 is a superset of ≤0.5
          expect(s.meanUpsideC).toBeGreaterThanOrEqual(0);
          expect(s.p90UpsideC).toBeGreaterThanOrEqual(0);
          expect(s.n).toBeGreaterThan(0);
        }
        for (let i = 1; i < d.length; i++) {
          expect(d[i]!.peakedPct).toBeGreaterThanOrEqual(d[i - 1]!.peakedPct - 1e-9); // more peaked later
          expect(d[i]!.leUpside05).toBeGreaterThanOrEqual(d[i - 1]!.leUpside05 - 1e-9); // safer later
          expect(d[i]!.meanUpsideC).toBeLessThanOrEqual(d[i - 1]!.meanUpsideC + 1e-9); // less to climb later
          expect(d[i]!.p90UpsideC).toBeLessThanOrEqual(d[i - 1]!.p90UpsideC + 1e-9);
        }
      });

      it('hot sub-climatology, when present, is a valid later-peaking period', () => {
        if (!m.hot) return;
        expect(m.hot.nDays).toBeGreaterThanOrEqual(30);
        expect(m.hot.decisionByHour.map((x) => x.hour)).toEqual(C.decisionHours);
        // Hot days TEND to peak later, but it's an empirical tendency, not a generator-guaranteed invariant
        // (May's hot-day median equals its all-day median — margin 0 — on a thin 32-day hot sample). Allow a
        // one-hour slack so a future regen near HOT_MIN_DAYS doesn't spuriously fail a correctly-built asset.
        expect(m.hot.medianPeakHour).toBeGreaterThanOrEqual(m.medianPeakHour - 1);
        for (const s of m.hot.decisionByHour) {
          expect(s.leUpside05).toBeGreaterThanOrEqual(0);
          expect(s.leUpside05).toBeLessThanOrEqual(1);
        }
      });
    });
  }

  it('warm months carry a hot-day sub-climatology; deep-winter months do not', () => {
    expect(C.months.find((m) => m.month === 6)!.hot).not.toBeNull(); // June: plenty of ≥25°C days
    expect(C.months.find((m) => m.month === 1)!.hot).toBeNull(); // January: ~none
  });
});
