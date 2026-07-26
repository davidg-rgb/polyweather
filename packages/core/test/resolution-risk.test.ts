/**
 * Sanity tests for the committed per-city resolution-risk snapshot (core/sim/resolution-risk —
 * CITY-ORACLE-BUILDOUT Build 2: stored WU grading truth vs the METAR oracle replica, trailing ~90d).
 * Guards the generated record's structural invariants + the two adjudicated facts a regen must not
 * silently lose: shenzhen is the divergence hotspot (WU ≠ ZGSZ METAR), and the rest of the universe
 * agrees at ≳90%.
 */
import { describe, expect, it } from 'vitest';
import { RESOLUTION_RISK as R, getResolutionRisk } from '../src/sim/resolution-risk.ts';

describe('resolution-risk asset', () => {
  it('covers the 45-city universe with coherent rates', () => {
    expect(R.source).toBe('wu-vs-iem-metar-90d');
    expect(R.cities).toHaveLength(45);
    expect(new Set(R.cities.map((c) => c.slug)).size).toBe(45);
    expect(R.window[0] <= R.window[1]).toBe(true);
    for (const c of R.cities) {
      expect(c.n, `${c.slug} n`).toBeGreaterThan(30);
      expect(c.matchRate, `${c.slug} rate range`).toBeGreaterThanOrEqual(0);
      expect(c.matchRate, `${c.slug} rate range`).toBeLessThanOrEqual(1);
      expect(c.resolutionRisk, `${c.slug} risk = 1 − match`).toBeCloseTo(1 - c.matchRate, 3);
    }
  });

  it('pins the adjudicated facts: shenzhen is the hotspot, everywhere else ≥ 90%', () => {
    const shenzhen = getResolutionRisk('shenzhen');
    expect(shenzhen).not.toBeNull();
    expect(shenzhen!.resolutionRisk).toBeGreaterThan(0.5); // WU's page is NOT a ZGSZ METAR render
    for (const c of R.cities) {
      if (c.slug === 'shenzhen') continue;
      expect(c.matchRate, `${c.slug} agreement`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('helpers resolve', () => {
    expect(getResolutionRisk('amsterdam')?.matchRate).toBe(1);
    expect(getResolutionRisk('atlantis')).toBeNull();
  });
});
