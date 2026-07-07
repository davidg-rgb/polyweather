import { describe, expect, it } from 'vitest';
import {
  bootstrapMeanP10,
  findFirstCheapEntry,
  findFixedEntry,
  localHourToUtc,
  parseForecastCsv,
  quantile,
  walkExit,
} from './karachi-entry-exit.ts';

describe('localHourToUtc', () => {
  it('maps local midnight of the weather day to UTC-5h (Karachi UTC+5)', () => {
    expect(localHourToUtc('2026-05-14', 0)).toBe(Date.parse('2026-05-13T19:00:00Z') / 1000);
  });
  it('adds h hours on top of local midnight', () => {
    expect(localHourToUtc('2026-05-14', 14)).toBe(localHourToUtc('2026-05-14', 0) + 14 * 3600);
  });
});

describe('findFixedEntry', () => {
  const pts: Array<[number, number]> = [
    [1000, 0.2],
    [2000, 0.3],
    [3000, 0.4],
  ];
  it('returns the LAST in-window tick with its index', () => {
    expect(findFixedEntry(pts, 2500, 3600)).toEqual({ i: 1, t: 2000, price: 0.3 });
    expect(findFixedEntry(pts, 3000, 3600)).toEqual({ i: 2, t: 3000, price: 0.4 }); // exact hit inclusive
  });
  it('returns null when the last in-range tick is older than the window', () => {
    expect(findFixedEntry(pts, 10000, 5400)).toBeNull(); // newest point 3000 < 4600
  });
  it('returns null when every tick is after the target', () => {
    expect(findFixedEntry(pts, 500, 5400)).toBeNull();
  });
});

describe('findFirstCheapEntry', () => {
  const pts: Array<[number, number]> = [
    [1000, 0.5],
    [2000, 0.3],
    [3000, 0.09], // first ≤ 0.10
    [4000, 0.02],
  ];
  it('returns the FIRST tick at or below the cap with its index (early/cheap by construction)', () => {
    expect(findFirstCheapEntry(pts, 0.1)).toEqual({ i: 2, t: 3000, price: 0.09 });
    expect(findFirstCheapEntry(pts, 0.35)).toEqual({ i: 1, t: 2000, price: 0.3 });
  });
  it('returns null when the bucket never trades at or below the cap', () => {
    expect(findFirstCheapEntry(pts, 0.01)).toBeNull();
  });
  it('skips a 0 / sub-zero sentinel (entry must be a real buyable price)', () => {
    const withZero: Array<[number, number]> = [
      [1000, 0.5],
      [2000, 0],
      [3000, 0.08],
    ];
    expect(findFirstCheapEntry(withZero, 0.1)).toEqual({ i: 2, t: 3000, price: 0.08 });
  });
});

describe('walkExit', () => {
  // entry at 0.10 → 10 shares per $1; ticks walked in time order, no look-ahead, break at first firing.
  const rise: Array<[number, number]> = [
    [10, 0.12],
    [20, 0.28],
    [30, 0.35], // TP 0.30 first fires here
    [40, 0.55],
  ];
  it('TP fires at the FIRST crossing tick and sells at that mid (no look-ahead past it)', () => {
    const r = walkExit(0.1, true, rise, { tp: 0.3 });
    expect(r.reason).toBe('tp');
    expect(r.exitPrice).toBeCloseTo(0.35, 10); // 0.35, NOT the later 0.55 → break at first firing
    expect(r.netReturn).toBeCloseTo(0.35 / 0.1 - 1, 10); // +2.5
  });

  const fall: Array<[number, number]> = [
    [10, 0.09],
    [20, 0.04], // SL 0.05 first fires here
    [30, 0.5], // a later spike must NOT be seen (already exited)
  ];
  it('SL fires at the first tick at/below the stop and ignores a later spike', () => {
    const r = walkExit(0.1, false, fall, { tp: 0.3, sl: 0.05 });
    expect(r.reason).toBe('sl');
    expect(r.exitPrice).toBeCloseTo(0.04, 10);
    expect(r.netReturn).toBeCloseTo(0.04 / 0.1 - 1, 10); // -0.6
  });

  it('HOLD-WIN: no firing tick, winner → proceeds 1 → netReturn = 1/entry − 1', () => {
    const flat: Array<[number, number]> = [
      [10, 0.11],
      [20, 0.12],
    ];
    const r = walkExit(0.1, true, flat, { tp: 0.3, sl: 0.05 });
    expect(r.reason).toBe('hold-win');
    expect(r.exitPrice).toBe(1);
    expect(r.netReturn).toBeCloseTo(1 / 0.1 - 1, 10); // +9
  });

  it('HOLD-LOSE: no firing tick, loser → proceeds 0 → netReturn = −1', () => {
    const flat: Array<[number, number]> = [
      [10, 0.11],
      [20, 0.09],
    ];
    const r = walkExit(0.1, false, flat, { tp: 0.3, sl: 0.05 });
    expect(r.reason).toBe('hold-lose');
    expect(r.exitPrice).toBe(0);
    expect(r.netReturn).toBe(-1);
  });

  it('HOLD-only rule (no tp/sl) never exits early — pure buy-and-hold', () => {
    const win = walkExit(0.4, true, rise, {});
    expect(win.reason).toBe('hold-win');
    expect(win.netReturn).toBeCloseTo(1 / 0.4 - 1, 10); // +1.5, the classic (1−p)/p
    const lose = walkExit(0.4, false, rise, {});
    expect(lose.reason).toBe('hold-lose');
    expect(lose.netReturn).toBe(-1);
  });

  it('a resting TP already satisfied by the first post-entry tick fills immediately at that mid', () => {
    // entered at 0.50, TP 0.30 is already below entry → first tick ≥ 0.30 fires at ~breakeven
    const r = walkExit(0.5, false, [[10, 0.49], [20, 0.2]], { tp: 0.3 });
    expect(r.reason).toBe('tp');
    expect(r.exitPrice).toBeCloseTo(0.49, 10);
    expect(r.netReturn).toBeCloseTo(0.49 / 0.5 - 1, 10); // ≈ −0.02 (sold at roughly entry)
  });
});

describe('bootstrapMeanP10', () => {
  it('is deterministic for a given seed (reproducible run to run)', () => {
    const xs = [2.5, -1, 2.5, -1, 2.5, -1, 2.5, -1, 2.5, -1];
    expect(bootstrapMeanP10(xs, 42)).toBe(bootstrapMeanP10(xs, 42));
  });
  it('sits at or below the sample mean (a shrinkage lower bound)', () => {
    const xs = [2.5, -1, 2.5, -1, 2.5, -1, 2.5, -1, 2.5, 2.5];
    const m = xs.reduce((a, v) => a + v, 0) / xs.length;
    expect(bootstrapMeanP10(xs, 42)).toBeLessThanOrEqual(m + 1e-9);
  });
});

describe('quantile', () => {
  it('interpolates like a linear percentile', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([10, 20, 30], 0.1)).toBeCloseTo(12, 10);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('parseForecastCsv', () => {
  it('keeps only karachi rows and maps eventId → pred_bucket_l0', () => {
    const text =
      'event_id,fc_city,weather_date,unit,pred_c_l2,pred_c_l1,pred_c_l0,pred_raw_l2,pred_raw_l1,pred_raw_l0,pred_bucket_l2,pred_bucket_l1,pred_bucket_l0\n' +
      '476147,karachi,2026-05-14,C,37,36,35,37,36,35,10,10,9\n' +
      '999,singapore,2026-05-14,C,30,30,30,30,30,30,3,3,3\n';
    const m = parseForecastCsv(text);
    expect(m.size).toBe(1);
    expect(m.get('476147')).toBe(9);
    expect(m.get('999')).toBeUndefined();
  });
});
