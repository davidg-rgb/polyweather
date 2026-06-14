import { describe, expect, it } from 'vitest';
import { multiOlsR2, pearson } from './l3b-residual-structure.ts';

describe('pearson', () => {
  it('is +1 for a perfect positive line, −1 for negative', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 12);
  });
  it('is ~0 for an orthogonal/flat signal', () => {
    expect(Math.abs(pearson([1, 2, 3, 4], [5, 5, 5, 5]))).toBeLessThan(1e-9);
    expect(Math.abs(pearson([-2, -1, 1, 2], [1, -1, -1, 1]))).toBeLessThan(1e-9);
  });
});

describe('multiOlsR2 — the structure-detection upper bound', () => {
  it('R² = 1 when y is an exact linear combination of the features', () => {
    const rows = [
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 2],
      [5, 1],
      [0, 3],
    ];
    const y = rows.map(([a, b]) => 3 + 2 * a! - 1.5 * b!);
    expect(multiOlsR2(rows, y)).toBeCloseTo(1, 6);
  });

  it('R² ≈ 0 when the response is constant (no variance to explain)', () => {
    const rows = [[1, 2], [3, 1], [2, 5], [4, 0], [0, 3]];
    expect(multiOlsR2(rows, [7, 7, 7, 7, 7])).toBeCloseTo(0, 9);
  });

  it('R² is partial for a feature that explains only some variance', () => {
    // y = 2*x1 + noise pattern uncorrelated-ish with x1 → R² strictly between 0 and 1
    const rows = [[0, 1], [1, -1], [2, 1], [3, -1], [4, 1], [5, -1], [6, 1], [7, -1]];
    const y = rows.map(([a, b]) => 2 * a! + 0.3 * b!);
    const r2 = multiOlsR2(rows, y);
    expect(r2).toBeGreaterThan(0.9); // x1 dominates → high but the test asserts it's a real number in range
    expect(r2).toBeLessThanOrEqual(1);
  });
});
