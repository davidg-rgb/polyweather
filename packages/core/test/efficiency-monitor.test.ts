import { describe, it, expect } from 'vitest';
import {
  detectLadderTroughs,
  scoreEfficiencyMonitor,
  MONITOR_DEFAULTS,
  type MonitorEvent,
  type LadderLeg,
} from '../src/sim/efficiency-monitor.ts';

const leg = (tempKey: number, ask: number, won = false): LadderLeg => ({ tempKey, ask, won });
const D = { troughDelta: MONITOR_DEFAULTS.troughDelta, shoulderMin: MONITOR_DEFAULTS.shoulderMin };

describe('detectLadderTroughs', () => {
  it('finds no trough in a clean unimodal ladder', () => {
    expect(detectLadderTroughs([leg(0, 0.02), leg(1, 0.1), leg(2, 0.82), leg(3, 0.13), leg(4, 0.02)], D)).toEqual([]);
  });
  it('finds the interior trough in a bimodal ladder', () => {
    expect(detectLadderTroughs([leg(0, 0.02), leg(1, 0.3), leg(2, 0.05), leg(3, 0.35), leg(4, 0.02)], D)).toEqual([2]);
  });
  it('ignores a sub-delta dip (noise floor)', () => {
    expect(detectLadderTroughs([leg(0, 0.3), leg(1, 0.29), leg(2, 0.31)], D)).toEqual([]);
  });
  it('ignores an immaterial-shoulder dip in the flat far tail', () => {
    expect(detectLadderTroughs([leg(0, 0.04), leg(1, 0.01), leg(2, 0.045)], D)).toEqual([]);
  });
  it('finds no interior extremum in a monotone ladder', () => {
    expect(detectLadderTroughs([leg(0, 0.6), leg(1, 0.3), leg(2, 0.08), leg(3, 0.02)], D)).toEqual([]);
  });
});

describe('scoreEfficiencyMonitor — S1 regime cheap-subset', () => {
  it('nets won − ask − fee per purchase and clusters by city in the gate', () => {
    // 8 cities × a losing cheap bet → the gate must KILL (winFrac 0), and edge is negative.
    const events: MonitorEvent[] = Array.from({ length: 8 }, (_, i) => ({
      city: `c${i}`, targetDate: `2026-07-${String(i + 1).padStart(2, '0')}`,
      quartile: (i % 4 + 1) as 1 | 2 | 3 | 4,
      cheapBets: [{ won: false, ask: 0.1 }],
      ladder: [],
    }));
    const r = scoreEfficiencyMonitor(events);
    expect(r.s1Regime.nPurchases).toBe(8);
    expect(r.s1Regime.verdict.label).not.toBe('PASS'); // all losers → never a PASS
    expect(r.s1Regime.edge.edge).toBeLessThan(0);
  });

  it('routes Q4 bets into the day-clustered breakdown by weather-day', () => {
    // 3 Q4 bets on 2 distinct days → q4DistinctWeatherDays === 2 (the C24 clustering unit)
    const events: MonitorEvent[] = [
      { city: 'a', targetDate: '2026-07-01', quartile: 4, cheapBets: [{ won: true, ask: 0.1 }], ladder: [] },
      { city: 'b', targetDate: '2026-07-01', quartile: 4, cheapBets: [{ won: false, ask: 0.1 }], ladder: [] },
      { city: 'c', targetDate: '2026-07-02', quartile: 4, cheapBets: [{ won: false, ask: 0.1 }], ladder: [] },
      { city: 'd', targetDate: '2026-07-03', quartile: 1, cheapBets: [{ won: false, ask: 0.1 }], ladder: [] },
    ];
    const r = scoreEfficiencyMonitor(events);
    expect(r.s1Regime.q4DistinctWeatherDays).toBe(2);
    expect(r.s1Regime.byQuartile[4].nGraded).toBe(3);
    expect(r.s1Regime.byQuartile[1].nGraded).toBe(1);
  });

  it('thin panel → INSUFFICIENT_DATA, never a verdict on noise', () => {
    const r = scoreEfficiencyMonitor([
      { city: 'a', targetDate: '2026-07-01', quartile: 2, cheapBets: [{ won: true, ask: 0.2 }], ladder: [] },
    ]);
    expect(r.s1Regime.verdict.label).toBe('INSUFFICIENT_DATA');
  });
});

describe('scoreEfficiencyMonitor — S2 geometry', () => {
  it('buys only detected troughs and grades them', () => {
    const events: MonitorEvent[] = [
      { // one interior trough at k=2 (temp 2), which WON → a winning geometry purchase
        city: 'a', targetDate: '2026-07-01', quartile: null, cheapBets: [],
        ladder: [leg(0, 0.02), leg(1, 0.3), leg(2, 0.05, true), leg(3, 0.35), leg(4, 0.02)],
      },
      { // clean unimodal → no trough, no purchase
        city: 'b', targetDate: '2026-07-01', quartile: null, cheapBets: [],
        ladder: [leg(0, 0.02), leg(1, 0.1), leg(2, 0.82, true), leg(3, 0.1), leg(4, 0.02)],
      },
    ];
    const r = scoreEfficiencyMonitor(events);
    expect(r.s2Geometry.nTroughs).toBe(1);
    expect(r.s2Geometry.nPurchases).toBe(1);
    expect(r.s2Geometry.edge.nWon).toBe(1);
  });

  it('sorts by temperature before detecting (never trusts input order)', () => {
    // same bimodal ladder, legs shuffled — detection must still find the trough
    const events: MonitorEvent[] = [{
      city: 'a', targetDate: '2026-07-01', quartile: null, cheapBets: [],
      ladder: [leg(3, 0.35), leg(0, 0.02), leg(2, 0.05, true), leg(4, 0.02), leg(1, 0.3)],
    }];
    const r = scoreEfficiencyMonitor(events);
    expect(r.s2Geometry.nTroughs).toBe(1);
  });
});
