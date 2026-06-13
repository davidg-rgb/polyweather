/**
 * toPgliteParam — serialize a JS value into a PGlite query parameter that
 * matches how postgres-js (the real `makeScriptDb` path) encodes the same
 * value, so the PGlite-backed test twins faithfully mirror production.
 *
 *   array of objects  → JSON text   (→ `$n::jsonb` yields a jsonb ARRAY)
 *   array of scalars  → PG array literal `{a,b}` (→ text[]/uuid[])
 *   plain object       → JSON text   (jsonb)
 *   Date / scalar / null → passthrough (PGlite binds these natively)
 *
 * The jsonb case is the one that bit the hosted backfill: postgres-js DETECTS
 * a `$n::jsonb` cast and JSON-encodes the JS value itself, so a PRE-stringified
 * string double-encodes into a jsonb *string* and `jsonb_to_recordset` throws
 * "cannot call jsonb_to_recordset on a non-array". Call sites therefore pass the
 * RAW array/object; this twin mirrors postgres-js by JSON-stringifying it for
 * PGlite's text→jsonb cast. (Mirrors supabase/tests/pglite-port.ts's encoder.)
 */
export function toPgliteParam(v: unknown): unknown {
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== 'object')) {
      return `{${v.map((x) => `"${String(x).replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
    }
    return JSON.stringify(v);
  }
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    return JSON.stringify(v);
  }
  return v;
}
