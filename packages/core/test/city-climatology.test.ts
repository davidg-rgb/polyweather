/**
 * Sanity tests for the committed 45-city ERA5 climatology asset (core/sim/city-climatology). Mirrors
 * amsterdam-climatology.test.ts's discipline: guard the generated record's structural invariants + the
 * physical monotonicities so a bad regen can't silently ship a wrong number — full 45-city coverage (the
 * committed 0066/0067 universe), complete decision curves over the shared lock hours [10..19], probabilities
 * in range, and the physics (peak-hour histogram sums to ~1; the floor can only get more "already-peaked"
 * later; remaining upside can only fall later). Also proves the display helpers resolve as /paper-trade
 * expects.
 */
import { describe, expect, it } from 'vitest';
import {
  CITY_CLIMATOLOGY as C,
  type CityClimatology,
  cityFloorConfidenceAt,
  getCityClimatology,
} from '../src/sim/city-climatology.ts';

/** The committed 45-city universe: the 10 §9R trade cities (0066) + the 35 capture cities (0067). */
const EXPECTED_SLUGS = [
  'amsterdam', 'beijing', 'chengdu', 'guangzhou', 'kuala-lumpur', 'madrid', 'manila', 'paris', 'qingdao', 'shanghai',
  'ankara', 'atlanta', 'austin', 'buenos-aires', 'busan', 'cape-town', 'chicago', 'chongqing', 'dallas', 'denver',
  'helsinki', 'houston', 'jeddah', 'karachi', 'london', 'los-angeles', 'lucknow', 'mexico-city', 'miami', 'milan',
  'munich', 'nyc', 'panama-city', 'san-francisco', 'sao-paulo', 'seattle', 'seoul', 'shenzhen', 'singapore', 'taipei',
  'tokyo', 'toronto', 'warsaw', 'wellington', 'wuhan',
].sort();

const DECISION_HOURS = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];

describe('city-climatology asset', () => {
  it('is the ERA5 45-city universe with the shared decision-hour window', () => {
    expect(C.source).toBe('openmeteo-era5');
    expect(C.decisionHours).toEqual(DECISION_HOURS);
    expect(C.nCities).toBe(C.cities.length);
    expect(C.cities.map((c) => c.slug).sort()).toEqual(EXPECTED_SLUGS);
    expect(new Set(C.cities.map((c) => c.slug)).size).toBe(C.cities.length); // no dupes
    expect(new Set(C.cities.map((c) => c.icao)).size).toBe(C.cities.length); // unique stations
  });

  const checkDecisionRows = (
    rows: CityClimatology['decisionByHour'],
    ctx: string,
  ): void => {
    expect(rows.map((r) => r.hour), `${ctx} hours`).toEqual(DECISION_HOURS);
    for (const s of rows) {
      for (const p of [s.peakedPct, s.leUpside05]) {
        expect(p, `${ctx} h${s.hour} prob`).toBeGreaterThanOrEqual(0);
        expect(p, `${ctx} h${s.hour} prob`).toBeLessThanOrEqual(1);
      }
      expect(s.meanUpsideC, `${ctx} h${s.hour} upside`).toBeGreaterThanOrEqual(0);
      expect(s.n, `${ctx} h${s.hour} n`).toBeGreaterThan(0);
    }
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.peakedPct, `${ctx} peaked monotone @${rows[i]!.hour}`).toBeGreaterThanOrEqual(rows[i - 1]!.peakedPct - 1e-9);
      expect(rows[i]!.leUpside05, `${ctx} safe monotone @${rows[i]!.hour}`).toBeGreaterThanOrEqual(rows[i - 1]!.leUpside05 - 1e-9);
      expect(rows[i]!.meanUpsideC, `${ctx} upside falls @${rows[i]!.hour}`).toBeLessThanOrEqual(rows[i - 1]!.meanUpsideC + 1e-9);
    }
  };

  for (const c of C.cities) {
    describe(`${c.slug} (${c.icao})`, () => {
      it('carries valid geo + coverage metadata', () => {
        expect(c.slug.length).toBeGreaterThan(0);
        expect(c.icao.length).toBeGreaterThanOrEqual(4);
        expect(c.name.length).toBeGreaterThan(0);
        expect(c.tz).toMatch(/^[A-Za-z]+\/[A-Za-z_/-]+$/); // a real IANA zone, never an Etc/* placeholder
        expect(c.tz.startsWith('Etc/')).toBe(false);
        expect(c.lat).toBeGreaterThanOrEqual(-90);
        expect(c.lat).toBeLessThanOrEqual(90);
        expect(c.lon).toBeGreaterThanOrEqual(-180);
        expect(c.lon).toBeLessThanOrEqual(180);
        expect(c.fromYear).toBeLessThanOrEqual(c.toYear);
        expect(c.fromYear).toBeGreaterThanOrEqual(2000);
        expect(c.toYear).toBeLessThanOrEqual(2100);
        expect(c.nDays).toBeGreaterThan(0);
      });

      it('has a complete peak-hour histogram summing to ~1 and a sane median hour', () => {
        expect(c.peakHourHistogram).toHaveLength(24);
        for (const p of c.peakHourHistogram) {
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThanOrEqual(1);
        }
        const sum = c.peakHourHistogram.reduce((a, b) => a + b, 0);
        expect(sum).toBeGreaterThan(0.97);
        expect(sum).toBeLessThan(1.03);
        expect(c.medianPeakHour).toBeGreaterThanOrEqual(0);
        expect(c.medianPeakHour).toBeLessThanOrEqual(23);
        // the daily max essentially never peaks overnight — a coarse tz/parse-bug catcher
        const overnight = [0, 1, 2, 3, 4, 5].reduce((s, h) => s + (c.peakHourHistogram[h] ?? 0), 0);
        expect(overnight, `${c.slug} overnight peak share`).toBeLessThan(0.2);
      });

      it('has monotone, in-range annual decision stats over [10..19]', () => {
        checkDecisionRows(c.decisionByHour, c.slug);
      });

      it('warm sub-climatology, when present, is a valid later-or-equal-peaking period', () => {
        if (!c.warm) return;
        expect(c.warm.nDays).toBeGreaterThanOrEqual(60);
        expect(c.warm.nDays).toBeLessThanOrEqual(c.nDays);
        expect(c.warm.medianPeakHour).toBeGreaterThanOrEqual(0);
        expect(c.warm.medianPeakHour).toBeLessThanOrEqual(23);
        checkDecisionRows(c.warm.decisionByHour, `${c.slug} warm`);
      });
    });
  }

  describe('display helpers (/paper-trade wiring)', () => {
    it('getCityClimatology resolves known cities and null for unknown', () => {
      expect(getCityClimatology('singapore')?.icao).toBe('WSSS');
      expect(getCityClimatology('karachi')?.slug).toBe('karachi');
      expect(getCityClimatology('atlantis')).toBeNull();
    });

    it('cityFloorConfidenceAt returns the peakedPct at a lock hour, null outside the window/universe', () => {
      const sg = getCityClimatology('singapore')!;
      const at14 = sg.decisionByHour.find((d) => d.hour === 14)!.peakedPct;
      expect(cityFloorConfidenceAt('singapore', 14)).toBe(at14);
      expect(cityFloorConfidenceAt('singapore', 9)).toBeNull(); // below the decision window
      expect(cityFloorConfidenceAt('singapore', 23)).toBeNull(); // above it
      expect(cityFloorConfidenceAt('atlantis', 14)).toBeNull(); // unknown city
    });
  });

  it('every committed decision hour offers ≥1 city with a meaningfully-confident floor (asset is usable)', () => {
    for (const h of DECISION_HOURS) {
      const anyConfident = C.cities.some((c) => (cityFloorConfidenceAt(c.slug, h) ?? 0) > 0.3 || h < 12);
      expect(anyConfident, `hour ${h}`).toBe(true);
    }
  });
});
