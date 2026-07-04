/**
 * Tests for the committed 45-city ERA5 catalog (scripts/research/city-catalog). Guards that the INPUT to the
 * climatology pull matches the committed migration universe (0066 + 0067): the right 45 slugs, unique ICAOs,
 * geographically-valid coordinates, real DST-aware IANA timezones (never an Etc/* placeholder), and the
 * hemisphere warm-season logic. A drift here would silently pull the wrong station or mislabel a zone.
 */
import { describe, expect, it } from 'vitest';
import { CITY_CATALOG, CITY_BY_SLUG, warmMonths } from './city-catalog.ts';

/** The 45 committed slugs: 0066's 10 §9R trade cities + 0067's 35 capture-universe cities. */
const EXPECTED_SLUGS = [
  'amsterdam', 'beijing', 'chengdu', 'guangzhou', 'kuala-lumpur', 'madrid', 'manila', 'paris', 'qingdao', 'shanghai',
  'ankara', 'atlanta', 'austin', 'buenos-aires', 'busan', 'cape-town', 'chicago', 'chongqing', 'dallas', 'denver',
  'helsinki', 'houston', 'jeddah', 'karachi', 'london', 'los-angeles', 'lucknow', 'mexico-city', 'miami', 'milan',
  'munich', 'nyc', 'panama-city', 'san-francisco', 'sao-paulo', 'seattle', 'seoul', 'shenzhen', 'singapore', 'taipei',
  'tokyo', 'toronto', 'warsaw', 'wellington', 'wuhan',
];

/** Timezones lifted verbatim from migrations 0066/0067 — a spot-check that the catalog didn't drift. */
const TZ_GOLDEN: Record<string, string> = {
  amsterdam: 'Europe/Amsterdam',
  singapore: 'Asia/Singapore',
  karachi: 'Asia/Karachi',
  'buenos-aires': 'America/Argentina/Buenos_Aires',
  wellington: 'Pacific/Auckland',
  lucknow: 'Asia/Kolkata', // the half-hour offset a fixed Etc/* zone can't represent (0067 note)
  ankara: 'Europe/Istanbul',
  houston: 'America/Chicago',
};

describe('city-catalog', () => {
  it('is exactly the committed 45-city universe', () => {
    expect(CITY_CATALOG).toHaveLength(45);
    expect(CITY_CATALOG.map((c) => c.slug).sort()).toEqual([...EXPECTED_SLUGS].sort());
  });

  it('has unique slugs and unique ICAOs', () => {
    expect(new Set(CITY_CATALOG.map((c) => c.slug)).size).toBe(45);
    expect(new Set(CITY_CATALOG.map((c) => c.icao)).size).toBe(45);
  });

  it('every city has valid geo + a real DST-aware IANA timezone', () => {
    for (const c of CITY_CATALOG) {
      expect(c.icao, c.slug).toMatch(/^[A-Z]{4}$/);
      expect(c.name.length, c.slug).toBeGreaterThan(0);
      expect(c.lat, c.slug).toBeGreaterThanOrEqual(-90);
      expect(c.lat, c.slug).toBeLessThanOrEqual(90);
      expect(c.lon, c.slug).toBeGreaterThanOrEqual(-180);
      expect(c.lon, c.slug).toBeLessThanOrEqual(180);
      expect(c.tz.startsWith('Etc/'), `${c.slug} must not be an Etc/* placeholder`).toBe(false);
      expect(c.tz, c.slug).toMatch(/^[A-Za-z]+\/[A-Za-z_/-]+$/);
    }
  });

  it('timezones match the committed migration values (spot-check)', () => {
    for (const [slug, tz] of Object.entries(TZ_GOLDEN)) {
      expect(CITY_BY_SLUG.get(slug)?.tz, slug).toBe(tz);
    }
  });

  it('CITY_BY_SLUG resolves every catalog city and nothing else', () => {
    expect(CITY_BY_SLUG.size).toBe(45);
    for (const c of CITY_CATALOG) expect(CITY_BY_SLUG.get(c.slug)).toBe(c);
    expect(CITY_BY_SLUG.get('atlantis')).toBeUndefined();
  });

  it('southern-hemisphere cities carry lat < 0 and get the Nov–Mar warm season', () => {
    const south = CITY_CATALOG.filter((c) => c.lat < 0).map((c) => c.slug).sort();
    expect(south).toEqual(['buenos-aires', 'cape-town', 'sao-paulo', 'wellington']);
    expect(warmMonths(-33)).toEqual([11, 12, 1, 2, 3]);
    expect(warmMonths(52)).toEqual([5, 6, 7, 8, 9]);
    expect(warmMonths(0)).toEqual([5, 6, 7, 8, 9]); // equator → northern default (harmless, seasonless)
  });
});
