/**
 * Regression guard for scripts/lib/pglite-param.ts. The hosted backfill broke
 * because the PGlite twins turned an array-of-objects into a PG array literal
 * (`{…}`) instead of jsonb — masking that real postgres-js JSON-encodes raw
 * arrays under a `$n::jsonb` cast. These assertions pin the correct mirror.
 */
import { describe, it, expect } from 'vitest';
import { toPgliteParam } from './lib/pglite-param.ts';

describe('toPgliteParam (postgres-js jsonb/array mirror)', () => {
  it('array of objects → JSON array text (NOT a PG array literal)', () => {
    const out = toPgliteParam([{ a: 1 }, { a: 2 }]);
    expect(typeof out).toBe('string');
    expect(out as string).toBe('[{"a":1},{"a":2}]');
    expect((out as string).startsWith('[')).toBe(true); // the bug produced a '{' literal
  });

  it('array of scalars → PG array literal with escaping', () => {
    expect(toPgliteParam(['a', 'b'])).toBe('{"a","b"}');
    expect(toPgliteParam([1, 2, 3])).toBe('{"1","2","3"}');
    expect(toPgliteParam(['x"y', 'a\\b'])).toBe('{"x\\"y","a\\\\b"}');
  });

  it('plain object → JSON text (jsonb)', () => {
    expect(toPgliteParam({ k: 'v', n: 2 })).toBe('{"k":"v","n":2}');
  });

  it('Date passes through untouched (PGlite binds it natively)', () => {
    const d = new Date('2026-06-13T00:00:00Z');
    expect(toPgliteParam(d)).toBe(d);
  });

  it('scalars and null pass through', () => {
    expect(toPgliteParam('hello')).toBe('hello');
    expect(toPgliteParam(42)).toBe(42);
    expect(toPgliteParam(null)).toBe(null);
    expect(toPgliteParam(true)).toBe(true);
  });

  it('empty array of scalars → empty PG literal', () => {
    expect(toPgliteParam([])).toBe('{}');
  });
});
