import { describe, expect, it } from 'vitest';
import { cToF, fToC, metarMaxToNative, toNative, wuRound } from '../src/units.ts';

describe('cToF / fToC (§6.2)', () => {
  it('exact anchor points', () => {
    expect(cToF(0)).toBe(32);
    expect(cToF(100)).toBe(212);
    expect(cToF(-40)).toBe(-40);
    expect(fToC(32)).toBe(0);
    expect(fToC(212)).toBe(100);
  });

  it('exact round-trip on integers −40..50 °C', () => {
    for (let c = -40; c <= 50; c++) {
      expect(fToC(cToF(c))).toBeCloseTo(c, 10);
    }
  });
});

describe('wuRound — WU display-rounding replica (§6.2)', () => {
  it('checklist values: 30.6 → 31, 23.4 → 23', () => {
    expect(wuRound(30.6)).toBe(31);
    expect(wuRound(23.4)).toBe(23);
  });

  it('half cases: round-half-up on the absolute value (half away from zero)', () => {
    expect(wuRound(0.5)).toBe(1);
    expect(wuRound(30.5)).toBe(31);
    expect(wuRound(-0.5)).toBe(-1); // A-11 assumption — confirm empirically in paper phase
    expect(wuRound(-30.5)).toBe(-31);
  });

  it('near-zero negatives normalize to plain 0 (no -0)', () => {
    expect(Object.is(wuRound(-0.4), 0)).toBe(true);
    expect(wuRound(0)).toBe(0);
  });

  it('plain cases including negatives', () => {
    expect(wuRound(-2.4)).toBe(-2);
    expect(wuRound(-2.6)).toBe(-3);
  });
});

describe('toNative (§6.2, ADR-04)', () => {
  it('°F conversion is continuous — no rounding before bucketization', () => {
    expect(toNative(30.6, 'F')).toBeCloseTo(87.08, 10);
    expect(toNative(30.6, 'F')).not.toBe(87); // double-rounding guard
  });

  it('°C passes through untouched', () => {
    expect(toNative(12.3, 'C')).toBe(12.3);
  });
});

describe('metarMaxToNative (§6.2)', () => {
  it('live-verified KORD case: 30.6 °C → 87 °F', () => {
    expect(metarMaxToNative(30.6, 'F')).toBe(87);
  });

  it('°C stations round in °C: RKSI 25.0 → 25; 25.5 → 26; 25.4 → 25', () => {
    expect(metarMaxToNative(25.0, 'C')).toBe(25);
    expect(metarMaxToNative(25.5, 'C')).toBe(26);
    expect(metarMaxToNative(25.4, 'C')).toBe(25);
  });

  it('negative-degree path follows the wuRound half rule', () => {
    expect(metarMaxToNative(-0.5, 'C')).toBe(-1);
    expect(metarMaxToNative(-17.8, 'F')).toBe(0); // -17.8C = -0.04F → 0, not -0
    expect(Object.is(metarMaxToNative(-17.8, 'F'), 0)).toBe(true);
  });
});
