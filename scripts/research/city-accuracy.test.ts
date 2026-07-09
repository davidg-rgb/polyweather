/**
 * scripts/research/city-accuracy.test — per-city won/lost accounting + the causal-forecast emit.
 */
import { describe, it, expect } from 'vitest';
import { cityAccuracy, forecastRows } from './city-accuracy.ts';
import { type ScoreDay, type DayMember } from './model-trim.ts';

const day = (city: string, date: string, obs: number, models: Record<string, number>, unit = 'C'): ScoreDay => {
  const members = new Map<string, DayMember>();
  for (const [m, p] of Object.entries(models)) members.set(m, { p, wRaw: 1, qualified: true });
  return { city, date, unit, obsC: obs, obsNative: unit === 'F' ? Math.round((obs * 9) / 5 + 32) : Math.round(obs), members, warm: true };
};

describe('cityAccuracy', () => {
  it('counts won/lost by exact bucket and reports the date span', () => {
    const days = [
      day('EGLC', '2026-05-01', 15, { ecmwf_ifs025: 15.1 }), // round 15 == 15 → won
      day('EGLC', '2026-05-02', 15, { ecmwf_ifs025: 16.4 }), // round 16 != 15 → lost, but within ±1
      day('EGLC', '2026-05-03', 20, { ecmwf_ifs025: 22.6 }), // round 23, off by 3 → lost, not near
    ];
    const [r] = cityAccuracy(days, 1);
    expect(r!.city).toBe('EGLC');
    expect(r!.n).toBe(3);
    expect(r!.won).toBe(1);
    expect(r!.lost).toBe(2);
    expect(r!.near).toBe(2); // 15 and 16 are within ±1; 23 is not
    expect(r!.winPct).toBeCloseTo(100 / 3, 5);
    expect(r!.first).toBe('2026-05-01');
    expect(r!.last).toBe('2026-05-03');
  });

  it('sorts cities by win rate descending', () => {
    const days = [
      day('AAA', '2026-05-01', 10, { ecmwf_ifs025: 10 }),
      day('BBB', '2026-05-01', 10, { ecmwf_ifs025: 14 }),
    ];
    const rows = cityAccuracy(days, 0);
    expect(rows.map((r) => r.city)).toEqual(['AAA', 'BBB']);
    expect(rows[0]!.winPct).toBe(100);
    expect(rows[1]!.winPct).toBe(0);
  });
});

describe('forecastRows (causal blend emit)', () => {
  it('emits one μ row per (icao,date,lead) with the native-integer bucket', () => {
    const panels = new Map<number, { train: ScoreDay[]; test: ScoreDay[] }>([
      [1, {
        train: [day('EGLC', '2026-05-01', 15, { ecmwf_ifs025: 14, gfs_seamless: 16 })], // blend 15
        test: [day('KLGA', '2026-06-20', 25, { ecmwf_ifs025: 25, gfs_seamless: 26 }, 'F')], // blend 25.5°C → 78°F
      }],
    ]);
    const rows = forecastRows(panels);
    expect(rows).toHaveLength(2);
    const eglc = rows.find((r) => r.icao === 'EGLC')!;
    expect(eglc.muC).toBeCloseTo(15, 6);
    expect(eglc.muNative).toBe(15);
    const klga = rows.find((r) => r.icao === 'KLGA')!;
    expect(klga.unit).toBe('F');
    expect(klga.muNative).toBe(Math.round((25.5 * 9) / 5 + 32)); // 78
  });
});
