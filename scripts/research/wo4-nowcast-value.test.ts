import { describe, expect, it } from 'vitest';
import { median } from './wo4-nowcast-value.ts';

describe('median', () => {
  it('odd length → middle element', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });
  it('even length → mean of the two middles', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([10, 0])).toBe(5);
  });
  it('is order-independent and NaN on empty', () => {
    expect(median([9, 1, 7, 3, 5])).toBe(5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});
