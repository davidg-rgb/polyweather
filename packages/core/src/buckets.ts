/**
 * core/buckets — bucket-label parsing, ladders, winners (ARCHITECTURE.md §6.3).
 *
 * Converts Polymarket's human bucket labels into machine ranges and back.
 * This module failing silently = betting on the wrong temperature; it is
 * fixture-tested against every label format observed in research/gamma-event-*.json.
 */
import { BucketParseError, LadderGapError } from './errors.ts';
import type { BucketDef, Unit } from './types.ts';

/**
 * Normalize observed unicode variants before parsing: NBSP/narrow-NBSP →
 * space, EN/EM-dash and U+2212 minus (between digits) → ASCII hyphen,
 * collapsed whitespace. Parsing stays strict AFTER normalization — unknown
 * shapes throw, never guess.
 */
function normalizeLabel(raw: string): string {
  return raw
    .replace(/[  ]/g, ' ')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const TAIL_LOW_RE = /^(-?\d+) ?° ?([CF]) or below$/;
const TAIL_HIGH_RE = /^(-?\d+) ?° ?([CF]) or higher$/;
const RANGE_RE = /^(-?\d+) ?- ?(-?\d+) ?° ?([CF])$/;
const BARE_RE = /^(-?\d+) ?° ?([CF])$/;

/**
 * Parse a bucket label into a BucketDef:
 *   '94-95°F'        → { low: 94,  high: 95,  unit: 'F' }
 *   '87°F or below'  → { low: null, high: 87, unit: 'F' }
 *   '19°C or higher' → { low: 19,  high: null, unit: 'C' }
 *   '15°C'           → { low: 15,  high: 15,  unit: 'C' }  (bare single degree —
 *                       the DOMINANT interior shape on °C events, 9 of 11 buckets, W1)
 * Tolerant of NBSP / EN-dash / extra whitespace / negative degrees.
 * BucketParseError on anything else — the caller must treat the whole event
 * as unbettable and alert (never guess).
 */
export function parseBucketLabel(label: string): BucketDef {
  const s = normalizeLabel(label);

  let m = TAIL_LOW_RE.exec(s);
  if (m) return { low: null, high: Number(m[1]), unit: m[2] as Unit };

  m = TAIL_HIGH_RE.exec(s);
  if (m) return { low: Number(m[1]), high: null, unit: m[2] as Unit };

  m = RANGE_RE.exec(s);
  if (m) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    if (low > high) {
      throw new BucketParseError(`inverted range in bucket label: '${label}'`, { label });
    }
    return { low, high, unit: m[3] as Unit };
  }

  m = BARE_RE.exec(s);
  if (m) {
    const n = Number(m[1]);
    return { low: n, high: n, unit: m[2] as Unit };
  }

  throw new BucketParseError(`unrecognized bucket label shape: '${label}'`, { label });
}

/**
 * Continuous integration bounds with ±0.5 continuity correction in native
 * degrees: {94,95} → [93.5, 95.5); {15,15} → [14.5, 15.5); tails → ±Infinity
 * on the open side.
 */
export function bucketRange(b: BucketDef): { lo: number; hi: number } {
  return {
    lo: b.low === null ? -Infinity : b.low - 0.5,
    hi: b.high === null ? Infinity : b.high + 0.5,
  };
}

/**
 * Assert ladder integrity: exactly one low tail + one high tail, contiguous
 * integer coverage, uniform unit, sorted ascending. Guards against Polymarket
 * changing ladder shape (currently 11 buckets, 2°F US / 1°C intl — NOT
 * assumed, verified per event).
 */
export function validateLadder(buckets: BucketDef[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (buckets.length < 2) {
    problems.push(`ladder has ${buckets.length} bucket(s); need at least both tails`);
    return { ok: false, problems };
  }

  const units = new Set(buckets.map((b) => b.unit));
  if (units.size > 1) {
    problems.push(`mixed units in ladder: ${[...units].join(', ')}`);
  }

  const lowTails = buckets.filter((b) => b.low === null);
  const highTails = buckets.filter((b) => b.high === null);
  if (lowTails.length !== 1) problems.push(`expected exactly 1 low tail, found ${lowTails.length}`);
  if (highTails.length !== 1) problems.push(`expected exactly 1 high tail, found ${highTails.length}`);

  if (buckets[0]!.low !== null) problems.push('first bucket is not the low tail');
  if (buckets[buckets.length - 1]!.high !== null) problems.push('last bucket is not the high tail');

  for (let i = 0; i < buckets.length - 1; i++) {
    const cur = buckets[i]!;
    const next = buckets[i + 1]!;
    if (cur.high === null || next.low === null) continue; // tail-position problems already recorded
    if (next.low !== cur.high + 1) {
      problems.push(
        next.low <= cur.high
          ? `overlap/duplicate at index ${i}→${i + 1}: ${cur.high} then ${next.low}`
          : `gap at index ${i}→${i + 1}: ${cur.high} then ${next.low}`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Index of the bucket containing the WU integer actual — whole-degree
 * semantics: 93°F → '92-93°F'. LadderGapError if no bucket contains the value
 * (impossible on a valid ladder; CRITICAL).
 */
export function winningBucket(buckets: BucketDef[], actualNative: number): number {
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i]!;
    if ((b.low === null || actualNative >= b.low) && (b.high === null || actualNative <= b.high)) {
      return i;
    }
  }
  throw new LadderGapError(
    `no bucket contains actual ${actualNative} — ladder gap or non-integer actual`,
    { actualNative, buckets },
  );
}
