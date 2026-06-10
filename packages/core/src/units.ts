/**
 * core/units — unit conversion & WU rounding replica (ARCHITECTURE.md §6.2).
 *
 * Encodes exactly how the resolution source rounds, once. ADR-04: WU integers
 * are never re-derived from converted values in the grading path — these
 * helpers exist for forecasts (°C → native-space bucketization) and for the
 * METAR replica used in cross-checks.
 */
import type { Unit } from './types.ts';

/** Exact linear conversion c × 9/5 + 32 — no rounding. */
export function cToF(c: number): number {
  return c * (9 / 5) + 32;
}

/** Inverse linear conversion — display/diagnostics only. */
export function fToC(f: number): number {
  return (f - 32) * (5 / 9);
}

/**
 * WU display-rounding replica: round-half-up on the absolute value (half away
 * from zero). 30.6 → 31; 23.4 → 23; 30.5 → 31; −0.5 → −1.
 *
 * The negative-half behavior (−0.5 → −1) is an ASSUMPTION (A-11): flagged for
 * empirical confirmation against live WU winter data during the paper phase.
 */
export function wuRound(x: number): number {
  const r = Math.sign(x) * Math.round(Math.abs(x));
  return r === 0 ? 0 : r; // normalize -0 (e.g. wuRound(-0.4)) to 0
}

/**
 * Continuous °C forecast value → continuous native-unit degrees, NO rounding —
 * the distribution is bucketized in native space (ADR-04); rounding here would
 * double-round against the bucket boundaries.
 */
export function toNative(tC: number, unit: Unit): number {
  return unit === 'F' ? cToF(tC) : tC;
}

/**
 * Replicate WU's integer for a METAR tenths-°C max: unit='C' → wuRound(max);
 * unit='F' → wuRound(cToF(max)). Used ONLY for cross-checks/nowcast, never grading.
 * Live-verified KORD case: metarMaxToNative(30.6, 'F') = 87.
 */
export function metarMaxToNative(maxTenthsC: number, unit: Unit): number {
  return unit === 'F' ? wuRound(cToF(maxTenthsC)) : wuRound(maxTenthsC);
}
