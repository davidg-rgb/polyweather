import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bucketRange, parseBucketLabel, validateLadder, winningBucket } from '../src/buckets.ts';
import { BucketParseError, LadderGapError } from '../src/errors.ts';
import type { BucketDef } from '../src/types.ts';

const RESEARCH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'research');

interface GammaMarket {
  groupItemTitle?: string;
  outcomePrices?: string;
}

function fixtureMarkets(file: string): GammaMarket[] {
  const raw = JSON.parse(readFileSync(join(RESEARCH, file), 'utf8')) as unknown;
  const ev = (Array.isArray(raw) ? raw[0] : raw) as { markets: GammaMarket[] };
  return ev.markets;
}

/** Ladder from a gamma event fixture, sorted ascending by range. */
function fixtureLadder(file: string): BucketDef[] {
  return fixtureMarkets(file)
    .map((m) => parseBucketLabel(m.groupItemTitle!))
    .sort((a, b) => bucketRange(a).lo - bucketRange(b).lo);
}

const EVENT_FIXTURES = [
  'gamma-event-temperature-nyc-jun11.json',
  'gamma-event-temperature-london-jun11.json',
  'gamma-event-temperature-paris-jun11.json',
  'gamma-event-temperature-seoul-jun11.json',
  'gamma-event-nyc-jun9-resolved.json',
];

describe('parseBucketLabel (§6.3)', () => {
  // §15: every label in every research fixture enumerated in one table-driven test.
  const observed: Array<[string, BucketDef]> = [
    // NYC jun11 — 2°F ladder
    ['87°F or below', { low: null, high: 87, unit: 'F' }],
    ['88-89°F', { low: 88, high: 89, unit: 'F' }],
    ['90-91°F', { low: 90, high: 91, unit: 'F' }],
    ['92-93°F', { low: 92, high: 93, unit: 'F' }],
    ['94-95°F', { low: 94, high: 95, unit: 'F' }],
    ['96-97°F', { low: 96, high: 97, unit: 'F' }],
    ['98-99°F', { low: 98, high: 99, unit: 'F' }],
    ['100-101°F', { low: 100, high: 101, unit: 'F' }],
    ['102-103°F', { low: 102, high: 103, unit: 'F' }],
    ['104-105°F', { low: 104, high: 105, unit: 'F' }],
    ['106°F or higher', { low: 106, high: null, unit: 'F' }],
    // London jun11 — bare 1°C ladder (W1: dominant interior shape)
    ['9°C or below', { low: null, high: 9, unit: 'C' }],
    ['10°C', { low: 10, high: 10, unit: 'C' }],
    ['11°C', { low: 11, high: 11, unit: 'C' }],
    ['12°C', { low: 12, high: 12, unit: 'C' }],
    ['13°C', { low: 13, high: 13, unit: 'C' }],
    ['14°C', { low: 14, high: 14, unit: 'C' }],
    ['15°C', { low: 15, high: 15, unit: 'C' }],
    ['16°C', { low: 16, high: 16, unit: 'C' }],
    ['17°C', { low: 17, high: 17, unit: 'C' }],
    ['18°C', { low: 18, high: 18, unit: 'C' }],
    ['19°C or higher', { low: 19, high: null, unit: 'C' }],
    // Paris jun11
    ['14°C or below', { low: null, high: 14, unit: 'C' }],
    ['15°C', { low: 15, high: 15, unit: 'C' }],
    ['24°C or higher', { low: 24, high: null, unit: 'C' }],
    // Seoul jun11
    ['17°C or below', { low: null, high: 17, unit: 'C' }],
    ['27°C or higher', { low: 27, high: null, unit: 'C' }],
    // NYC jun9 resolved
    ['71°F or below', { low: null, high: 71, unit: 'F' }],
    ['72-73°F', { low: 72, high: 73, unit: 'F' }],
    ['80-81°F', { low: 80, high: 81, unit: 'F' }],
    ['90°F or higher', { low: 90, high: null, unit: 'F' }],
  ];

  it.each(observed)('parses observed label %s', (label, expected) => {
    expect(parseBucketLabel(label)).toEqual(expected);
  });

  it('parses EVERY label in EVERY research gamma fixture (55 labels)', () => {
    let total = 0;
    for (const file of EVENT_FIXTURES) {
      for (const m of fixtureMarkets(file)) {
        expect(() => parseBucketLabel(m.groupItemTitle!), `${file}: ${m.groupItemTitle}`).not.toThrow();
        total++;
      }
    }
    expect(total).toBe(55);
  });

  it('tolerates NBSP, EN-dash, EM-dash, U+2212 minus, and stray whitespace', () => {
    expect(parseBucketLabel('94–95°F')).toEqual({ low: 94, high: 95, unit: 'F' }); // EN-dash
    expect(parseBucketLabel('94—95°F')).toEqual({ low: 94, high: 95, unit: 'F' }); // EM-dash
    expect(parseBucketLabel('94−95°F')).toEqual({ low: 94, high: 95, unit: 'F' }); // minus sign
    expect(parseBucketLabel('15 °C')).toEqual({ low: 15, high: 15, unit: 'C' }); // NBSP
    expect(parseBucketLabel('  19°C  or  higher ')).toEqual({ low: 19, high: null, unit: 'C' });
    expect(parseBucketLabel('87 °F or below')).toEqual({ low: null, high: 87, unit: 'F' });
  });

  it('parses negative degrees in every shape', () => {
    expect(parseBucketLabel('-5°C')).toEqual({ low: -5, high: -5, unit: 'C' });
    expect(parseBucketLabel('-10--9°C')).toEqual({ low: -10, high: -9, unit: 'C' });
    expect(parseBucketLabel('−5–−4°C')).toEqual({ low: -5, high: -4, unit: 'C' }); // −5–−4
    expect(parseBucketLabel('-2°C or below')).toEqual({ low: null, high: -2, unit: 'C' });
    expect(parseBucketLabel('-1°C or higher')).toEqual({ low: -1, high: null, unit: 'C' });
  });

  it('throws BucketParseError on unknown shapes — never guesses', () => {
    for (const bad of [
      '', 'hello', '94', '°F', '94-95', '94 to 95°F', '94°K', '94-95°', '94°F-95°F',
      'between 94 and 95°F', '94°F or above', '94°F or lower', '94.5°F', '94-95-96°F',
    ]) {
      expect(() => parseBucketLabel(bad), `should reject '${bad}'`).toThrow(BucketParseError);
    }
  });

  it('throws BucketParseError on inverted ranges', () => {
    expect(() => parseBucketLabel('95-94°F')).toThrow(BucketParseError);
  });
});

describe('bucketRange (§6.3)', () => {
  it('±0.5 continuity correction', () => {
    expect(bucketRange({ low: 94, high: 95, unit: 'F' })).toEqual({ lo: 93.5, hi: 95.5 });
    expect(bucketRange({ low: 15, high: 15, unit: 'C' })).toEqual({ lo: 14.5, hi: 15.5 });
  });

  it('tails open to ±Infinity', () => {
    expect(bucketRange({ low: null, high: 87, unit: 'F' })).toEqual({ lo: -Infinity, hi: 87.5 });
    expect(bucketRange({ low: 106, high: null, unit: 'F' })).toEqual({ lo: 105.5, hi: Infinity });
  });

  it('consecutive ladder buckets meet exactly (continuity invariant)', () => {
    const ladder = fixtureLadder('gamma-event-temperature-nyc-jun11.json');
    for (let i = 0; i < ladder.length - 1; i++) {
      expect(bucketRange(ladder[i]!).hi).toBe(bucketRange(ladder[i + 1]!).lo);
    }
  });
});

describe('validateLadder (§6.3)', () => {
  it.each(EVENT_FIXTURES)('passes the research fixture %s', (file) => {
    const verdict = validateLadder(fixtureLadder(file));
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  const f = (low: number | null, high: number | null): BucketDef => ({ low, high, unit: 'F' });

  it('fails a gapped ladder', () => {
    const verdict = validateLadder([f(null, 87), f(88, 89), f(92, 93), f(94, null)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((p) => p.includes('gap'))).toBe(true);
  });

  it('fails a duplicate/overlapping ladder', () => {
    const verdict = validateLadder([f(null, 87), f(88, 89), f(88, 89), f(90, null)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((p) => p.includes('overlap/duplicate'))).toBe(true);
  });

  it('fails a mixed-unit ladder', () => {
    const verdict = validateLadder([
      { low: null, high: 87, unit: 'F' },
      { low: 88, high: 89, unit: 'C' },
      { low: 90, high: null, unit: 'F' },
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((p) => p.includes('mixed units'))).toBe(true);
  });

  it('fails on missing or doubled tails and wrong tail positions', () => {
    expect(validateLadder([f(86, 87), f(88, 89), f(90, null)]).problems.some((p) => p.includes('low tail'))).toBe(true);
    expect(validateLadder([f(null, 87), f(88, 89), f(90, 91)]).problems.some((p) => p.includes('high tail'))).toBe(true);
    expect(validateLadder([f(null, 87), f(null, 89), f(90, null)]).ok).toBe(false);
    expect(validateLadder([f(88, 89), f(null, 87), f(90, null)]).problems.some((p) => p.includes('first bucket'))).toBe(true);
  });

  it('fails a degenerate ladder', () => {
    expect(validateLadder([]).ok).toBe(false);
    expect(validateLadder([f(null, 87)]).ok).toBe(false);
  });
});

describe('winningBucket (§6.3)', () => {
  const nycJun11 = fixtureLadder('gamma-event-temperature-nyc-jun11.json');

  it("winningBucket(93°F) lands in '92-93°F' (whole-degree semantics)", () => {
    const idx = winningBucket(nycJun11, 93);
    expect(nycJun11[idx]).toEqual({ low: 92, high: 93, unit: 'F' });
  });

  it('tails capture out-of-ladder extremes', () => {
    expect(winningBucket(nycJun11, 60)).toBe(0);
    expect(winningBucket(nycJun11, 120)).toBe(nycJun11.length - 1);
  });

  it('throws LadderGapError on an impossible value', () => {
    // valid ladders have no holes for integers; a non-integer "actual" exposes the guard
    expect(() => winningBucket(nycJun11, 93.5)).toThrow(LadderGapError);
    const gapped: BucketDef[] = [
      { low: null, high: 87, unit: 'F' },
      { low: 92, high: null, unit: 'F' },
    ];
    expect(() => winningBucket(gapped, 89)).toThrow(LadderGapError);
  });

  it("NYC resolved fixture: our winner '80-81°F' matches Polymarket outcomePrices", () => {
    const markets = fixtureMarkets('gamma-event-nyc-jun9-resolved.json');
    // outcomePrices is double-encoded JSON: '["1", "0"]' means YES resolved.
    const polyWinner = markets.find((m) => {
      const [yes] = JSON.parse(m.outcomePrices!) as [string, string];
      return Number(yes) === 1;
    });
    expect(polyWinner?.groupItemTitle).toBe('80-81°F');

    const ladder = fixtureLadder('gamma-event-nyc-jun9-resolved.json');
    for (const actual of [80, 81]) {
      const idx = winningBucket(ladder, actual);
      expect(ladder[idx]).toEqual({ low: 80, high: 81, unit: 'F' });
    }
  });
});
