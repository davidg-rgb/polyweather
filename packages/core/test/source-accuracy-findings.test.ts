/**
 * Golden-value tests for the committed source-accuracy record (core/sim/source-accuracy-findings). Mirrors
 * city-scan-results.test.ts's discipline: guard the frozen record's structural invariants + every displayed
 * number so a bad hand-edit can't silently ship a figure the source docs (MAKER-EXIT-SIM.md §per-city,
 * CONVERGENCE-TUNING.md Finding 2 + banner, CITY-SIM.md §7) don't actually support — including that the
 * calibrated blend genuinely dominates every source at every lead, that the ~2,100-event lead-1 numbers tie
 * back to the CONVERGENCE-TUNING banner, and that the two use-cases pick opposite sources.
 */
import { describe, expect, it } from 'vitest';
import {
  FORECAST_USE_CASES,
  PER_CITY_HIGHLIGHTS,
  PER_CITY_OVERRIDE_NOTE,
  SELECTOR_DIAGNOSTIC,
  SELECTOR_DIAGNOSTIC_META,
  SOURCE_ACCURACY_BY_LEAD,
  SOURCE_ACCURACY_CAVEATS,
  SOURCE_ACCURACY_META,
  type SourceClass,
} from '../src/sim/source-accuracy-findings.ts';

const byLead = (src: SourceClass): [number, number, number] =>
  SOURCE_ACCURACY_BY_LEAD.find((r) => r.source === src)!.hitWithin1ByLead;

describe('source-accuracy-findings record', () => {
  describe('SOURCE_ACCURACY_META', () => {
    it('carries the recorded panel shape (golden values)', () => {
      expect(SOURCE_ACCURACY_META.nEventsApprox).toBe(2100);
      expect(SOURCE_ACCURACY_META.nCities).toBe(45);
      expect(SOURCE_ACCURACY_META.leads).toEqual([0, 1, 2]);
      expect(SOURCE_ACCURACY_META.recordedAt).toBe('2026-07-03');
      expect(SOURCE_ACCURACY_META.sourceDocs.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('SOURCE_ACCURACY_BY_LEAD (MAKER-EXIT-SIM.md §per-city golden values)', () => {
    it('the three source classes, in dominance order', () => {
      expect(SOURCE_ACCURACY_BY_LEAD.map((r) => r.source)).toEqual([
        'calibrated-blend', 'best-single-nwp', 'raw-ensemble',
      ]);
    });

    it('calibrated blend = 88/79/75 at lead 0/1/2 (exact record)', () => {
      const row = SOURCE_ACCURACY_BY_LEAD.find((r) => r.source === 'calibrated-blend')!;
      expect(row.hitWithin1ByLead).toEqual([88, 79, 75]);
      expect(row.systemName).toBe('house_gaussian (the calibrated blend)');
      expect(row.approx).toBe(false);
    });

    it('best single NWP model = ~70/66/62 at lead 0/1/2 (recorded approximate)', () => {
      const row = SOURCE_ACCURACY_BY_LEAD.find((r) => r.source === 'best-single-nwp')!;
      expect(row.hitWithin1ByLead).toEqual([70, 66, 62]);
      expect(row.approx).toBe(true);
    });

    it('raw ensemble = 66/62/59 at lead 0/1/2 (exact record)', () => {
      const row = SOURCE_ACCURACY_BY_LEAD.find((r) => r.source === 'raw-ensemble')!;
      expect(row.hitWithin1ByLead).toEqual([66, 62, 59]);
      expect(row.systemName).toBe('ensemble_raw');
      expect(row.approx).toBe(false);
    });

    it('the calibrated blend DOMINATES every source at every lead (the headline claim)', () => {
      const blend = byLead('calibrated-blend');
      const nwp = byLead('best-single-nwp');
      const raw = byLead('raw-ensemble');
      for (let l = 0; l < 3; l++) {
        expect(blend[l]!, `blend > nwp @lead${l}`).toBeGreaterThan(nwp[l]!);
        expect(blend[l]!, `blend > raw @lead${l}`).toBeGreaterThan(raw[l]!);
        // the best single model also beats the raw ensemble at every lead
        expect(nwp[l]!, `nwp > raw @lead${l}`).toBeGreaterThan(raw[l]!);
      }
    });

    it('each source degrades monotonically with lead (skill decay), and every rate is a valid percent', () => {
      for (const r of SOURCE_ACCURACY_BY_LEAD) {
        const [l0, l1, l2] = r.hitWithin1ByLead;
        expect(l0, `${r.source} l0>l1`).toBeGreaterThan(l1);
        expect(l1, `${r.source} l1>l2`).toBeGreaterThan(l2);
        for (const v of r.hitWithin1ByLead) {
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThanOrEqual(100);
        }
      }
    });
  });

  describe('PER_CITY_HIGHLIGHTS (illustrative extremes, lead 1)', () => {
    it('karachi/LA/miami ≥95% and amsterdam =52%, both at lead 1', () => {
      const best = PER_CITY_HIGHLIGHTS.find((h) => h.kind === 'best')!;
      expect(best.cities.sort()).toEqual(['karachi', 'los-angeles', 'miami']);
      expect(best.bracketPct).toBe(95);
      expect(best.comparator).toBe('>=');
      expect(best.lead).toBe(1);
      const worst = PER_CITY_HIGHLIGHTS.find((h) => h.kind === 'worst')!;
      expect(worst.cities).toEqual(['amsterdam']);
      expect(worst.bracketPct).toBe(52);
      expect(worst.comparator).toBe('=');
      expect(worst.lead).toBe(1);
    });

    it('the illustrative spread is enormous (best ≥ worst + 40pp) — "varies enormously"', () => {
      const best = PER_CITY_HIGHLIGHTS.find((h) => h.kind === 'best')!;
      const worst = PER_CITY_HIGHLIGHTS.find((h) => h.kind === 'worst')!;
      expect(best.bracketPct - worst.bracketPct).toBeGreaterThanOrEqual(40);
    });
  });

  describe('PER_CITY_OVERRIDE_NOTE (multiple-comparisons guard)', () => {
    it('8 cities beat the blend >10pp, best-of-10 at n≈48, and it does NOT survive scrutiny', () => {
      expect(PER_CITY_OVERRIDE_NOTE.nCitiesBeatingBlend).toBe(8);
      expect(PER_CITY_OVERRIDE_NOTE.minMarginPp).toBe(10);
      expect(PER_CITY_OVERRIDE_NOTE.selectionPoolPerCity).toBe(10);
      expect(PER_CITY_OVERRIDE_NOTE.nPerCityApprox).toBe(48);
      expect(PER_CITY_OVERRIDE_NOTE.survivesMultipleComparisons).toBe(false);
    });
  });

  describe('FORECAST_USE_CASES (CITY-SIM.md §7 split)', () => {
    it('exactly two use-cases, picking OPPOSITE sources', () => {
      expect(FORECAST_USE_CASES.map((u) => u.key)).toEqual(['accuracy-forecast', 'convergence-seed']);
      const accuracy = FORECAST_USE_CASES.find((u) => u.key === 'accuracy-forecast')!;
      const convergence = FORECAST_USE_CASES.find((u) => u.key === 'convergence-seed')!;
      expect(accuracy.sourceClass).toBe('calibrated-blend');
      expect(convergence.sourceClass).toBe('raw-ensemble');
      expect(accuracy.sourceClass).not.toBe(convergence.sourceClass);
    });

    it('the convergence seed maps to ensemble_raw (the live default consensusSource)', () => {
      const convergence = FORECAST_USE_CASES.find((u) => u.key === 'convergence-seed')!;
      expect(convergence.seedName).toBe('ensemble_raw');
      expect(convergence.consensusSource).toBe('ensemble_raw');
    });

    it('the accuracy forecast maps to the calibrated (bias-corrected) center', () => {
      const accuracy = FORECAST_USE_CASES.find((u) => u.key === 'accuracy-forecast')!;
      expect(accuracy.seedName).toMatch(/house_gaussian/);
      expect(accuracy.consensusSource).toBe('calibrated');
    });

    it('every use-case picks a source class that exists in the by-lead table', () => {
      const known = new Set(SOURCE_ACCURACY_BY_LEAD.map((r) => r.source));
      for (const u of FORECAST_USE_CASES) expect(known.has(u.sourceClass)).toBe(true);
    });
  });

  describe('SELECTOR_DIAGNOSTIC (CONVERGENCE-TUNING.md Finding 2 golden values)', () => {
    it('house_gaussian = 33.6/73.9/91.2 and house_ensemble = 21.9/52.8/73.4 at chw 0/1/2', () => {
      const g = SELECTOR_DIAGNOSTIC.find((r) => r.selector === 'house_gaussian')!;
      const e = SELECTOR_DIAGNOSTIC.find((r) => r.selector === 'house_ensemble')!;
      expect(g.bracketByChw).toEqual([33.6, 73.9, 91.2]);
      expect(g.bias).toBe('calibrated');
      expect(e.bracketByChw).toEqual([21.9, 52.8, 73.4]);
      expect(e.bias).toBe('raw');
    });

    it('the calibrated gaussian out-selects the raw ensemble at every width, and both rise with width', () => {
      const g = SELECTOR_DIAGNOSTIC.find((r) => r.selector === 'house_gaussian')!;
      const e = SELECTOR_DIAGNOSTIC.find((r) => r.selector === 'house_ensemble')!;
      for (let w = 0; w < 3; w++) expect(g.bracketByChw[w]!, `gaussian > ensemble @chw${w}`).toBeGreaterThan(e.bracketByChw[w]!);
      for (const r of SELECTOR_DIAGNOSTIC) {
        expect(r.bracketByChw[0]!).toBeLessThan(r.bracketByChw[1]!);
        expect(r.bracketByChw[1]!).toBeLessThan(r.bracketByChw[2]!);
      }
    });
  });

  describe('SELECTOR_DIAGNOSTIC_META (banner + DB-panel corroboration)', () => {
    it('carries the 708/819-event panels and the banner chw1 74.4% vs 53.0% (golden)', () => {
      expect(SELECTOR_DIAGNOSTIC_META.nEvents).toBe(708);
      expect(SELECTOR_DIAGNOSTIC_META.bannerNEvents).toBe(819);
      expect(SELECTOR_DIAGNOSTIC_META.bannerChw1Calibrated).toBe(74.4);
      expect(SELECTOR_DIAGNOSTIC_META.bannerChw1Raw).toBe(53.0);
    });

    it('the ~2,100-event lead-1 corroboration ties back to SOURCE_ACCURACY_BY_LEAD exactly', () => {
      // CONVERGENCE-TUNING banner: "79 % vs 62 % at lead 1 on the ~2,100-event DB panel" — the SAME numbers
      // as the calibrated-blend / raw-ensemble lead-1 cells in the by-lead table.
      expect(SELECTOR_DIAGNOSTIC_META.dbPanelLead1Calibrated).toBe(byLead('calibrated-blend')[1]);
      expect(SELECTOR_DIAGNOSTIC_META.dbPanelLead1Raw).toBe(byLead('raw-ensemble')[1]);
      expect(SELECTOR_DIAGNOSTIC_META.dbPanelLead1Calibrated).toBe(79);
      expect(SELECTOR_DIAGNOSTIC_META.dbPanelLead1Raw).toBe(62);
    });

    it('the alignment note is present but flags the rail stays DORMANT / unapplied', () => {
      expect(SELECTOR_DIAGNOSTIC_META.alignmentNote).toMatch(/consensusSource/);
      expect(SELECTOR_DIAGNOSTIC_META.alignmentNote).toMatch(/DORMANT|unchanged|NOT applied/i);
    });
  });

  describe('SOURCE_ACCURACY_CAVEATS (surface-only honesty)', () => {
    it('carries exactly three caveats, the first flagging the missing full per-city table', () => {
      expect(SOURCE_ACCURACY_CAVEATS).toHaveLength(3);
      for (const c of SOURCE_ACCURACY_CAVEATS) expect(c.length).toBeGreaterThan(20);
      expect(SOURCE_ACCURACY_CAVEATS[0]).toMatch(/per-city/i);
      expect(SOURCE_ACCURACY_CAVEATS[0]).toMatch(/not archived|fresh DB pull|out of scope/i);
    });

    it('names the trade-filter rejection and the Lane-B short-history caveat', () => {
      expect(SOURCE_ACCURACY_CAVEATS.some((c) => /trade filter/i.test(c))).toBe(true);
      expect(SOURCE_ACCURACY_CAVEATS.some((c) => /Lane-B|Google|OWM|WeatherAPI/i.test(c))).toBe(true);
    });
  });
});
