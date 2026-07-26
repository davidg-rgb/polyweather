/**
 * Sanity tests for the committed 45-city RESOLUTION-GRADE floor-formation climatology asset
 * (core/sim/city-floor-climatology — IEM METAR rendered-integer space, CITY-ORACLE-BUILDOUT Build 1).
 * Mirrors city-climatology.test.ts's discipline: guard the generated record's structural invariants +
 * the physical monotonicities so a bad regen can't silently ship a wrong number. Also pins the Build-1
 * acceptance floor: ≥ 3 calendar years of coverage for ≥ 40 cities.
 */
import { describe, expect, it } from 'vitest';
import {
  CITY_FLOOR_CLIMATOLOGY as C,
  cityFloorMonth,
  getCityFloorClimatology,
} from '../src/sim/city-floor-climatology.ts';

/** The committed 45-city universe (identical to city-climatology.test.ts's list). */
const EXPECTED_SLUGS = [
  'amsterdam', 'beijing', 'chengdu', 'guangzhou', 'kuala-lumpur', 'madrid', 'manila', 'paris', 'qingdao', 'shanghai',
  'ankara', 'atlanta', 'austin', 'buenos-aires', 'busan', 'cape-town', 'chicago', 'chongqing', 'dallas', 'denver',
  'helsinki', 'houston', 'jeddah', 'karachi', 'london', 'los-angeles', 'lucknow', 'mexico-city', 'miami', 'milan',
  'munich', 'nyc', 'panama-city', 'san-francisco', 'sao-paulo', 'seattle', 'seoul', 'shenzhen', 'singapore', 'taipei',
  'tokyo', 'toronto', 'warsaw', 'wellington', 'wuhan',
].sort();

describe('city-floor-climatology asset', () => {
  it('is the resolution-grade 45-city universe', () => {
    expect(C.source).toBe('iem-metar');
    expect(C.nCities).toBe(C.cities.length);
    expect(C.cities.map((c) => c.slug).sort()).toEqual(EXPECTED_SLUGS);
    expect(new Set(C.cities.map((c) => c.icao)).size).toBe(C.cities.length); // unique stations
  });

  it('meets the Build-1 acceptance floor: ≥3 calendar years of coverage for ≥40 cities', () => {
    const wide = C.cities.filter((c) => c.toYear - c.fromYear + 1 >= 3);
    expect(wide.length).toBeGreaterThanOrEqual(40);
  });

  for (const c of C.cities) {
    describe(`${c.slug} (${c.icao})`, () => {
      it('carries coherent metadata and a meaningful sample', () => {
        expect(c.unit === 'C' || c.unit === 'F').toBe(true);
        expect(c.fromYear).toBeLessThanOrEqual(c.toYear);
        expect(c.nDays).toBeGreaterThan(0);
        expect(c.months).toHaveLength(12);
        // the non-null months can never sum past the city's total day count
        const monthSum = c.months.reduce((acc, m) => acc + (m?.nDays ?? 0), 0);
        expect(monthSum).toBeLessThanOrEqual(c.nDays);
      });

      it('every emitted month obeys the decided-curve physics', () => {
        for (const m of c.months) {
          if (m === null) continue;
          const ctx = `${c.slug} m${m.month}`;
          expect(m.nDays, `${ctx} nDays`).toBeGreaterThanOrEqual(30);
          expect(m.decidedPct, `${ctx} curve length`).toHaveLength(24);
          for (const p of m.decidedPct) {
            expect(p, `${ctx} prob range`).toBeGreaterThanOrEqual(0);
            expect(p, `${ctx} prob range`).toBeLessThanOrEqual(1);
          }
          // decided is an absorbing state: the curve can only rise, and every day decides by its end
          for (let h = 1; h < 24; h++) {
            expect(m.decidedPct[h]!, `${ctx} monotone @h${h}`).toBeGreaterThanOrEqual(m.decidedPct[h - 1]!);
          }
          expect(m.decidedPct[23], `${ctx} terminal`).toBe(1);
          // decided-hour percentiles: valid local hours, ordered
          for (const p of [m.decidedHourP10, m.decidedHourMedian, m.decidedHourP90]) {
            expect(Number.isInteger(p), `${ctx} pct integer`).toBe(true);
            expect(p, `${ctx} pct range`).toBeGreaterThanOrEqual(0);
            expect(p, `${ctx} pct range`).toBeLessThanOrEqual(23);
          }
          expect(m.decidedHourP10, `${ctx} pct order`).toBeLessThanOrEqual(m.decidedHourMedian);
          expect(m.decidedHourMedian, `${ctx} pct order`).toBeLessThanOrEqual(m.decidedHourP90);
        }
      });
    });
  }

  it('helpers resolve as the /cities page expects', () => {
    const ams = getCityFloorClimatology('amsterdam');
    expect(ams).not.toBeNull();
    expect(getCityFloorClimatology('atlantis')).toBeNull();
    const jul = cityFloorMonth(ams!, 7);
    expect(jul?.month).toBe(7);
    // Amsterdam July: the day is essentially always decided by evening (hand-checked vs the report)
    expect(jul!.decidedPct[20]!).toBeGreaterThan(0.9);
  });
});
