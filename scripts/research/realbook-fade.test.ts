import { describe, expect, it } from 'vitest';
import { normLabel } from './realbook-fade.ts';

describe('normLabel — the semantic winner-join key (archive labels are UTF-8-mojibaked)', () => {
  it('matches a clean label to its mojibaked twin (strips non-ascii + punctuation)', () => {
    // DB label vs archive mojibake — both must normalize to the same key or the join fails
    expect(normLabel('27°C or below')).toBe(normLabel('27Â°C or below'));
    expect(normLabel('27°C or below')).toBe('27corbelow');
  });
  it('normalizes range and above labels', () => {
    expect(normLabel('28-29°C')).toBe('2829c');
    expect(normLabel('44°C or above')).toBe('44corabove');
  });
  it('is case- and space-insensitive', () => {
    expect(normLabel('  84-85°F ')).toBe(normLabel('84-85°f'));
  });
  it('handles null/empty', () => {
    expect(normLabel(null)).toBe('');
    expect(normLabel(undefined)).toBe('');
    expect(normLabel('')).toBe('');
  });
  it('distinguishes genuinely different buckets', () => {
    expect(normLabel('27°C or below')).not.toBe(normLabel('28°C'));
  });
});
