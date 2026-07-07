import { describe, expect, it } from 'vitest';
import {
  aggregateHour,
  buildCityReport,
  evPerDollar,
  forecastAccuracy,
  localHourInTz,
  mean,
  median,
  ourBucketIdx,
  parseForecastForCity,
  purchasabilityVerdict,
  type BucketRead,
} from './city-best-hour.ts';

describe('localHourInTz', () => {
  it('is DST-correct across tz (same instant, different local hour)', () => {
    const t = '2026-07-07T00:00:00Z';
    expect(localHourInTz(t, 'Asia/Karachi')).toBe(5); // UTC+5
    expect(localHourInTz(t, 'Asia/Singapore')).toBe(8); // UTC+8
    expect(localHourInTz(t, 'Europe/Istanbul')).toBe(3); // UTC+3
    expect(localHourInTz(t, 'America/Chicago')).toBe(19); // July = CDT (UTC−5) → 24−5
  });
  it('normalizes local midnight to 0 (not 24)', () => {
    // 2026-07-06T19:00Z = 2026-07-07 00:00 in Karachi (+5)
    expect(localHourInTz('2026-07-06T19:00:00Z', 'Asia/Karachi')).toBe(0);
  });
});

describe('ourBucketIdx', () => {
  const b = (idx: number, houseProb: number | null, mid: number | null): { idx: number; mid: number | null; bestAsk: null; bestBid: null; execAsk: null; houseProb: number | null; depthUsd: null } => ({
    idx,
    mid,
    bestAsk: null,
    bestBid: null,
    execAsk: null,
    houseProb,
    depthUsd: null,
  });
  it('picks argmax houseProb when present', () => {
    expect(ourBucketIdx([b(0, 0.2, 0.9), b(1, 0.5, 0.1), b(2, 0.3, 0.4)])).toBe(1);
  });
  it('falls back to argmax mid when no houseProb', () => {
    expect(ourBucketIdx([b(0, null, 0.2), b(1, null, 0.7), b(2, null, 0.4)])).toBe(1);
  });
  it('returns null when neither houseProb nor mid is present', () => {
    expect(ourBucketIdx([b(0, null, null), b(1, null, null)])).toBeNull();
  });
});

describe('evPerDollar', () => {
  it('is accuracy/price − 1 (positive when accuracy exceeds price)', () => {
    expect(evPerDollar(0.51, 0.45)).toBeCloseTo(0.1333, 4);
    expect(evPerDollar(0.51, 0.51)).toBeCloseTo(0, 10);
    expect(evPerDollar(0.51, 0.72)).toBeCloseTo(-0.2917, 4);
  });
  it('is NaN at non-positive price', () => {
    expect(evPerDollar(0.51, 0)).toBeNaN();
  });
});

describe('purchasabilityVerdict', () => {
  it('grades by fillable fraction then depth', () => {
    expect(purchasabilityVerdict(0.8, 300)).toBe('YES (deep)');
    expect(purchasabilityVerdict(0.8, 50)).toBe('yes');
    expect(purchasabilityVerdict(0.6, 999)).toBe('thin');
    expect(purchasabilityVerdict(0.3, 999)).toBe('NO');
  });
});

describe('mean / median', () => {
  it('mean averages, NaN on empty', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNaN();
  });
  it('median handles odd/even/empty', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});

describe('aggregateHour', () => {
  const r = (bestAsk: number | null, execAsk: number | null, mid: number | null, depthUsd: number): BucketRead => ({
    bestAsk,
    execAsk,
    bestBid: bestAsk !== null ? bestAsk - 0.02 : null,
    mid,
    houseProb: 0.48,
    depthUsd,
  });
  it('gates fillable on execAsk>0 AND depth ≥ stake', () => {
    const reads = [r(0.5, 0.52, 0.49, 100), r(0.5, 0.55, 0.49, 3), r(0.5, null, 0.49, 100)];
    const agg = aggregateHour(11, reads, 10);
    expect(agg.n).toBe(3);
    expect(agg.fillable).toBe(1); // only the first: execAsk>0 and depth 100≥10
    expect(agg.fillFrac).toBeCloseTo(1 / 3, 6);
    expect(agg.avgBestAsk).toBeCloseTo(0.5, 10);
    expect(agg.avgSpread).toBeCloseTo(0.02, 10);
  });
  it('is empty-safe', () => {
    const agg = aggregateHour(3, [], 10);
    expect(agg.n).toBe(0);
    expect(agg.fillFrac).toBe(0);
    expect(agg.verdict).toBe('NO');
  });
});

describe('parseForecastForCity', () => {
  const text =
    'event_id,fc_city,pred_bucket_l0\n' +
    'aaa,karachi,5\n' +
    'bbb,houston,7\n' +
    'ccc,karachi,6\n' +
    'ddd,karachi,\n';
  it('keeps only the city rows and maps eventId → pred_bucket_l0, dropping blanks', () => {
    const m = parseForecastForCity(text, 'karachi');
    expect(m.size).toBe(2);
    expect(m.get('aaa')).toBe(5);
    expect(m.get('ccc')).toBe(6);
    expect(m.get('bbb')).toBeUndefined();
    expect(m.get('ddd')).toBeUndefined(); // blank pred dropped
  });
});

describe('forecastAccuracy', () => {
  it('returns NaN/0 when the forecast CSV is absent', () => {
    const res = forecastAccuracy('karachi', '/no/such/dir', '/no/such/file.csv');
    expect(res.nEvents).toBe(0);
    expect(res.accuracy).toBeNaN();
  });
});

describe('buildCityReport', () => {
  it('picks the max-EV hour among purchasable (fillFrac ≥ 0.7) hours', () => {
    // two events, two hours. Hour 10 cheap+fillable, hour 14 pricey+fillable, hour 3 cheap but unfillable.
    const reads = new Map<string, BucketRead>([
      ['e1|10', { bestAsk: 0.45, execAsk: 0.47, bestBid: 0.43, mid: 0.44, houseProb: 0.48, depthUsd: 500 }],
      ['e2|10', { bestAsk: 0.46, execAsk: 0.48, bestBid: 0.44, mid: 0.45, houseProb: 0.48, depthUsd: 500 }],
      ['e1|14', { bestAsk: 0.6, execAsk: 0.72, bestBid: 0.58, mid: 0.59, houseProb: 0.48, depthUsd: 500 }],
      ['e2|14', { bestAsk: 0.62, execAsk: 0.74, bestBid: 0.6, mid: 0.61, houseProb: 0.48, depthUsd: 500 }],
      ['e1|3', { bestAsk: 0.4, execAsk: null, bestBid: null, mid: 0.39, houseProb: 0.48, depthUsd: 0 }],
    ]);
    const r = buildCityReport('karachi', 'Asia/Karachi', reads, 0.51, 49, 10);
    expect(r.archiveEvents).toBe(2);
    expect(r.bestHour?.hour).toBe(10); // cheapest purchasable → best EV
    // hour 3 is cheapest but unfillable (execAsk null) → excluded from bestHour
    const h3 = r.hours.find((h) => h.hour === 3)!;
    expect(h3.fillable).toBe(0);
  });
});
