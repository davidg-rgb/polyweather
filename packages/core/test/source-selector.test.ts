/**
 * Tests for core/sim/source-selector — the PURE per-city "best-matching forecast source" selector for the
 * Fahrenheit US-city bidding test (WS-A). Pins the decisive properties:
 *  - scoreSource: ladder-bucket match via googleBucketIdx (exact / within-1 / miss counting); events with a
 *    null winner, a null source center, or an unbucketable forecast are EXCLUDED from n (not counted as misses).
 *  - the frozen selection is the multiple-comparisons guard: a source overrides raw Google for a city ONLY when
 *    it beats BOTH raw Google AND the blend out-of-sample by the margin, with sufficient TRAIN & TEST coverage;
 *    every other path SHRINKS to the blend (the four fallback reasons).
 *  - unit threading: a °C center is converted (cToF) before bucketing on an °F ladder.
 */
import { describe, expect, it } from 'vitest';
import {
  SOURCE_SELECTOR_DEFAULTS,
  type SelectorCfg,
  type SourceSelEvent,
  scoreSource,
  scoreSources,
  selectSourcesPerCity,
  selectionMap,
  summarizeSelections,
} from '../src/sim/source-selector.ts';
import type { OpeningBucket } from '../src/sim/opening-convergence.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const mkB = (idx: number, label: string): OpeningBucket => ({
  idx,
  label,
  loF: null,
  hiF: null,
  mid: 0.1,
  bestAsk: 0.11,
  execAsk: 0.11,
  depthUsd: 100,
  bestBid: 0.09,
  sellbackUsd: 100,
  execBid: 0.1,
  sellbackDepthUsd: 100,
  houseProb: null,
  tokenYes: `y${idx}`,
  tokenNo: `n${idx}`,
  conditionId: `c${idx}`,
});

/** a 5-bucket °C ladder 14–18°C (bare labels, matching google-bucket-replay.test.ts). idx == array pos here. */
const L: OpeningBucket[] = [mkB(0, '14°C'), mkB(1, '15°C'), mkB(2, '16°C'), mkB(3, '17°C'), mkB(4, '18°C')];
/** a 5-bucket °F ladder 92–96°F. */
const LF: OpeningBucket[] = [mkB(0, '92°F'), mkB(1, '93°F'), mkB(2, '94°F'), mkB(3, '95°F'), mkB(4, '96°F')];

const ev = (
  eventId: string,
  city: string,
  winningBucketIdx: number | null,
  forecastC: Record<string, number | null | undefined>,
  over: Partial<SourceSelEvent> = {},
): SourceSelEvent => ({ eventId, city, unit: 'C', ladder: L, winningBucketIdx, forecastC, ...over });

const rep = (n: number, mk: (i: number) => SourceSelEvent): SourceSelEvent[] =>
  Array.from({ length: n }, (_, i) => mk(i));

// ── scoreSource ──────────────────────────────────────────────────────────────────────────────────────
describe('scoreSource — ladder-bucket match', () => {
  it('counts exact / within-1 / miss and rates on the winner bucket (idx 2 = 16°C)', () => {
    const events: SourceSelEvent[] = [
      ev('e1', 'x', 2, { wx: 16.0 }), // 16 → idx2 → exact
      ev('e2', 'x', 2, { wx: 17.0 }), // 17 → idx3 → miss 1 (within1)
      ev('e3', 'x', 2, { wx: 18.0 }), // 18 → idx4 → miss 2 (not within1)
    ];
    const s = scoreSource(events, 'wx');
    expect(s.n).toBe(3);
    expect(s.exact).toBe(1);
    expect(s.within1).toBe(2);
    expect(s.missSum).toBe(3);
    expect(s.exactRate).toBeCloseTo(1 / 3, 10);
    expect(s.within1Rate).toBeCloseTo(2 / 3, 10);
    expect(s.meanMiss).toBeCloseTo(1.0, 10);
  });

  it('EXCLUDES events with a null winner, a null/absent source center, or an unbucketable forecast', () => {
    const events: SourceSelEvent[] = [
      ev('ok', 'x', 2, { wx: 16.0 }), // the one scoreable event
      ev('nullWinner', 'x', null, { wx: 16.0 }), // null winner → excluded
      ev('nullCenter', 'x', 2, { wx: null }), // null center → excluded
      ev('absent', 'x', 2, {}), // source key absent → excluded
      ev('emptyLadder', 'x', 2, { wx: 16.0 }, { ladder: [] }), // unbucketable (googleBucketIdx → null) → excluded
    ];
    const s = scoreSource(events, 'wx');
    expect(s.n).toBe(1);
    expect(s.exact).toBe(1);
  });

  it('n=0 → NaN rates, never throws on junk', () => {
    const s = scoreSource([], 'wx');
    expect(s.n).toBe(0);
    expect(Number.isNaN(s.exactRate)).toBe(true);
    expect(Number.isNaN(s.meanMiss)).toBe(true);
    // total on malformed input
    expect(() => scoreSource([{ } as unknown as SourceSelEvent], 'wx')).not.toThrow();
  });

  it('threads the market unit: a °C center is cToF-converted before bucketing an °F ladder', () => {
    // 33.9°C → cToF 93.02 → wuRound 93 → °F ladder idx1 (93°F) = the winner
    const e = ev('f1', 'houston', 1, { wx: 33.9 }, { unit: 'F', ladder: LF });
    const s = scoreSource([e], 'wx');
    expect(s.n).toBe(1);
    expect(s.exact).toBe(1);
  });
});

describe('scoreSources — reports every named source, including uncovered ones', () => {
  it('returns an entry per source (n=0 for absent)', () => {
    const scores = scoreSources([ev('e1', 'x', 2, { a: 16.0 })], ['a', 'b']);
    expect(scores.a!.n).toBe(1);
    expect(scores.a!.exact).toBe(1);
    expect(scores.b!.n).toBe(0);
  });
});

// ── selectSourcesPerCity — the frozen multiple-comparisons guard ───────────────────────────────────────
describe('selectSourcesPerCity — TRAIN pick → OOS validate → shrink to blend', () => {
  // Common per-event source centers: weatherapi nails the 16°C winner (exact); google is cold-biased to 14°C
  // (idx0, the real Google-°F failure mode); blend sits at 15°C (idx1); openweathermap at 17°C (idx3).
  const WIN = 2;
  const goodFc = { weatherapi: 16.0, google: 14.0, blend: 15.0, openweathermap: 17.0 };
  // On TEST for 'phoenix', weatherapi collapses (overfit): it now lands 15°C while the blend nails 16°C.
  const collapseFc = { weatherapi: 15.0, google: 14.0, blend: 16.0, openweathermap: 17.0 };

  const cfg: SelectorCfg = {
    candidates: ['google', 'weatherapi', 'openweathermap', 'blend'],
    baseline: 'google',
    fallback: 'blend',
    metric: 'exact',
    minTrainN: 8,
    minTestN: 6,
    marginPp: 0.05,
  };

  const train: SourceSelEvent[] = [
    ...rep(10, (i) => ev(`hou-tr-${i}`, 'houston', WIN, goodFc)),
    ...rep(4, (i) => ev(`dal-tr-${i}`, 'dallas', WIN, goodFc)), // < minTrainN
    ...rep(9, (i) => ev(`mia-tr-${i}`, 'miami', WIN, goodFc)),
    ...rep(9, (i) => ev(`phx-tr-${i}`, 'phoenix', WIN, goodFc)), // weatherapi wins TRAIN…
  ];
  const test: SourceSelEvent[] = [
    ...rep(8, (i) => ev(`hou-te-${i}`, 'houston', WIN, goodFc)), // …and holds OOS → SELECTED
    ...rep(8, (i) => ev(`dal-te-${i}`, 'dallas', WIN, goodFc)),
    ...rep(3, (i) => ev(`mia-te-${i}`, 'miami', WIN, goodFc)), // < minTestN
    ...rep(8, (i) => ev(`phx-te-${i}`, 'phoenix', WIN, collapseFc)), // …but collapses OOS → shrink
  ];

  const sels = selectSourcesPerCity(train, test, cfg);
  const get = (city: string) => {
    const s = sels.find((x) => x.city === city);
    if (!s) throw new Error(`no selection for ${city}`);
    return s;
  };

  it('SELECTS a source only when it beats raw-Google AND the blend OOS (houston → weatherapi)', () => {
    expect(get('houston').reason).toBe('selected');
    expect(get('houston').chosen).toBe('weatherapi');
    expect(get('houston').trainWinner).toBe('weatherapi');
    expect(get('houston').test.chosenRate).toBeCloseTo(1.0, 10);
    expect(get('houston').test.baselineRate).toBeCloseTo(0.0, 10);
    expect(get('houston').test.fallbackRate).toBeCloseTo(0.0, 10);
  });

  it('falls back on insufficient TRAIN coverage (dallas)', () => {
    expect(get('dallas').reason).toBe('fallback-insufficient-train');
    expect(get('dallas').chosen).toBe('blend');
  });

  it('falls back on insufficient TEST coverage (miami)', () => {
    expect(get('miami').reason).toBe('fallback-insufficient-test');
    expect(get('miami').chosen).toBe('blend');
  });

  it('falls back when the TRAIN winner fails OOS — the overfit guard (phoenix)', () => {
    expect(get('phoenix').trainWinner).toBe('weatherapi');
    expect(get('phoenix').reason).toBe('fallback-no-oos-margin');
    expect(get('phoenix').chosen).toBe('blend');
  });

  it('summarize + selectionMap reflect exactly one override', () => {
    const sum = summarizeSelections(sels);
    expect(sum.nCities).toBe(4);
    expect(sum.nSelected).toBe(1);
    expect(sum.nFallback).toBe(3);
    expect(sum.selectedCities).toEqual([{ city: 'houston', source: 'weatherapi' }]);

    const map = selectionMap(sels);
    expect(map.get('houston')).toBe('weatherapi');
    expect(map.get('dallas')).toBe('blend');
    expect(map.get('phoenix')).toBe('blend');
  });

  it('is deterministic and total on empty input', () => {
    expect(selectSourcesPerCity([], [])).toEqual([]);
    expect(summarizeSelections([])).toEqual({ nCities: 0, nSelected: 0, nFallback: 0, selectedCities: [] });
  });
});

describe('SOURCE_SELECTOR_DEFAULTS', () => {
  it('defaults to the blend as fallback, raw google as the beat-baseline, within1 metric', () => {
    expect(SOURCE_SELECTOR_DEFAULTS.fallback).toBe('blend');
    expect(SOURCE_SELECTOR_DEFAULTS.baseline).toBe('google');
    expect(SOURCE_SELECTOR_DEFAULTS.metric).toBe('within1');
  });
});
