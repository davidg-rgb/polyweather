import { describe, expect, it } from 'vitest';
import { seasonOf, tercile, terciles } from './wo3-regime-weighting.ts';

describe('seasonOf — meteorological seasons from month index (0=Jan)', () => {
  it('maps DJF / MAM / JJA / SON', () => {
    expect(seasonOf(11)).toBe('DJF'); // Dec
    expect(seasonOf(0)).toBe('DJF'); // Jan
    expect(seasonOf(1)).toBe('DJF'); // Feb
    expect(seasonOf(2)).toBe('MAM'); // Mar
    expect(seasonOf(4)).toBe('MAM'); // May
    expect(seasonOf(5)).toBe('JJA'); // Jun
    expect(seasonOf(7)).toBe('JJA'); // Aug
    expect(seasonOf(8)).toBe('SON'); // Sep
    expect(seasonOf(10)).toBe('SON'); // Nov
  });
});

describe('terciles / tercile — rolling spread bucketing', () => {
  it('returns null cutoffs until ≥30 samples (defaults to mid)', () => {
    expect(terciles([1, 2, 3])).toBeNull();
    expect(tercile(5, null)).toBe('mid');
  });

  it('splits a uniform 0..99 distribution into lo/mid/hi at ~33/67', () => {
    const sorted = Array.from({ length: 99 }, (_, i) => i);
    const cut = terciles(sorted)!;
    expect(tercile(5, cut)).toBe('lo');
    expect(tercile(50, cut)).toBe('mid');
    expect(tercile(95, cut)).toBe('hi');
    expect(cut[0]).toBeLessThan(cut[1]);
  });
});
