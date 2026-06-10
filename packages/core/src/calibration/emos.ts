/**
 * core/calibration/emos — EMOS-style bias, σ, and model weights (ARCHITECTURE.md §6.6).
 */

/**
 * Decaying-average bias: bias ← α·error + (1−α)·prevBias, where
 * error = forecastC − observedC. prevBias = null seeds with the error.
 * α default 0.15 (config biasAlpha).
 */
export function updateBias(prevBias: number | null, error: number, alpha: number): number {
  if (prevBias === null) return error;
  return alpha * error + (1 - alpha) * prevBias;
}

/**
 * Sample std-dev (n−1 denominator) of the window's residuals
 * (corrected forecast − observed) per (station, model, lead, slot).
 * Returns null when n < minN (default 8) — the caller falls back to the
 * lead-pooled or global prior σ ladder in config.
 */
export function fitSigma(residuals: number[], minN: number): { sigma: number; n: number } | null {
  const n = residuals.length;
  if (n < minN || n < 2) return null;
  const mean = residuals.reduce((a, b) => a + b, 0) / n;
  const ss = residuals.reduce((a, r) => a + (r - mean) ** 2, 0);
  return { sigma: Math.sqrt(ss / (n - 1)), n };
}

/**
 * Inverse-MSE weights normalized to Σ=1. Models with missing recent data
 * (non-finite MSE) get weight 0; a perfect MSE of 0 is clamped to 1e-6 rather
 * than dividing by zero; single-valid-model fallback weight 1.
 */
export function computeModelWeights(mseByModel: Map<string, number>): Map<string, number> {
  const inverse = new Map<string, number>();
  for (const [model, mse] of mseByModel) {
    inverse.set(model, Number.isFinite(mse) && mse >= 0 ? 1 / Math.max(mse, 1e-6) : 0);
  }
  const total = [...inverse.values()].reduce((a, b) => a + b, 0);
  const weights = new Map<string, number>();
  for (const [model, inv] of inverse) {
    weights.set(model, total > 0 ? inv / total : 0);
  }
  return weights;
}

/**
 * rawC − bias. Trivial by design — the value is that this is the ONLY place
 * bias correction happens anywhere in the codebase (§15 grep invariant).
 */
export function correctPoint(rawC: number, bias: number): number {
  return rawC - bias;
}
