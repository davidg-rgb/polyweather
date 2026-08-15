/**
 * Tests for core/sim/cheap-early-entry-replay — the forward-paper engine for the operator's CHEAP-EARLY-ENTRY
 * proposal (CHEAP-EARLY-ENTRY.md). Pins the frozen strategy (handoff §0/§3.1):
 *   - the LATEST allowable in-window entry (smallest hours-to-close in [24,36]) is chosen (no look-ahead);
 *   - NO in-window capture → no entry; ask OUT of band → no entry; THIN depth → no entry; off-universe → no entry;
 *   - grading is by TEMPERATURE LABEL, never the bucket index (the sort-safe join — traps #7);
 *   - the fee math is pinned to (won − ask − takerFeePerShare(ask))/ask (the cheap-entry-realbook.py twin);
 *   - the panel verdict binds on ciLow>0 + zero-skill MC, NOT winFrac (minWinFrac 0); totality (junk → no throw).
 *
 * …and the PRE-REGISTERED variant knobs on top of it (CHEAP-EARLY-IMPROVE.md §8): entryRule 'first' vs 'latest',
 * the minEdge margin (0 = off, so the canonical path is unchanged), the fail-closed top-K city filter, and the
 * frozen six-variant registry + its DISJOINT entry-window set (0128).
 */
import { describe, expect, it } from 'vitest';
import {
  replayCheapEarlyEvent,
  replayCheapEarlyPanel,
  cheapEarlyCfg,
  cheapEarlyEligibleCities,
  cheapEarlyWindowSet,
  parseTemp,
  CANONICAL_VARIANT_ID,
  CHEAP_EARLY_CITIES,
  CHEAP_EARLY_DEFAULTS,
  CHEAP_EARLY_VARIANTS,
  type CheapEarlyCfg,
} from '../src/sim/cheap-early-entry-replay.ts';
import type { EventReplayInput, ReplayTick } from '../src/sim/opening-bracket-replay.ts';
import type { OpeningBucket } from '../src/sim/opening-convergence.ts';
import { takerFeePerShare } from '../src/fees.ts';

const TZ = 'Europe/Helsinki';
const DATE = '2026-06-22';
// resolution at 2026-06-22T00:00Z; captures dated so hours-to-close lands where each test needs it.
const RESOLVE_MS = new Date('2026-06-22T00:00:00Z').getTime();
const HOUR = 3_600_000;
/** an ISO capture time `htc` hours BEFORE resolution (so hours-to-close === htc). */
const atHtc = (htc: number): string => new Date(RESOLVE_MS - htc * HOUR).toISOString();

const cfg = (over: Partial<CheapEarlyCfg> = {}): CheapEarlyCfg => cheapEarlyCfg(['helsinki'], over);

const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx, label: `${20 + idx}°C`, loF: null, hiF: null, mid: 0.15, bestAsk: 0.16, execAsk: 0.16, depthUsd: 200,
  bestBid: 0.14, sellbackUsd: 100, execBid: 0.14, sellbackDepthUsd: 100, houseProb: idx === 1 ? 0.4 : 0.15,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
// a 3-bucket ladder; bucket 1 is the house pick (highest houseProb). `center` overrides the pick's book.
const ladder = (center: Partial<OpeningBucket> = {}): OpeningBucket[] => [b(0), b(1, center), b(2)];
const tick = (htc: number, center: Partial<OpeningBucket> = {}): ReplayTick => ({
  capturedAt: atHtc(htc), hoursSinceListing: 60 - htc, tz: TZ, targetDate: DATE, buckets: ladder(center),
});
const input = (ticks: ReplayTick[], winnerIdx: number | null = 1, gradingMismatch = false): EventReplayInput => ({
  eventId: 'E', city: 'helsinki', targetDate: DATE, tz: TZ, ticks, resolution: { winnerIdx, gradingMismatch },
});

describe('parseTemp', () => {
  it('parses signed integers from labels and returns null when none', () => {
    expect(parseTemp('25°C')).toBe(25);
    expect(parseTemp('-3°C')).toBe(-3);
    expect(parseTemp('≥ 40°C')).toBe(40);
    expect(parseTemp('warm')).toBeNull();
    expect(parseTemp(null)).toBeNull();
    expect(parseTemp('')).toBeNull();
  });
});

describe('replayCheapEarlyEvent — entry gating', () => {
  it('enters the LATEST allowable in-window capture (smallest hours-to-close in [24,36])', () => {
    // htc 30 (ask 0.30) and htc 26 (ask 0.24) both in-window; the min-htc (26) capture is the entry.
    const t = replayCheapEarlyEvent(
      input([tick(30, { bestAsk: 0.3 }), tick(26, { bestAsk: 0.24 })]),
      cfg(),
      RESOLVE_MS,
    );
    expect(t.entered).toBe(true);
    expect(t.entryAsk).toBeCloseTo(0.24, 9);
    expect(t.htcAtEntry).toBeCloseTo(26, 6);
    expect(t.entryLabel).toBe('21°C'); // bucket idx 1
  });

  it('no in-window capture → no entry (all ticks are too close or too far)', () => {
    const t = replayCheapEarlyEvent(input([tick(48, { bestAsk: 0.25 }), tick(12, { bestAsk: 0.25 })]), cfg(), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('no_in_window_capture');
  });

  it('ask below the band → no entry (records the diagnostic ask)', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.12 })]), cfg(), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('ask_out_of_band');
    expect(t.entryAsk).toBeCloseTo(0.12, 9);
  });

  it('ask above the band → no entry', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.45 })]), cfg(), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('ask_out_of_band');
  });

  it('thin depth (below the stake) → no entry', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25, depthUsd: 5 })]), cfg({ stakeUsd: 20 }), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('thin_depth');
    expect(t.depthUsd).toBe(5);
  });

  it('off-universe city → no entry', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25 })]), cfg({ cities: ['ankara'] }), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('off_universe');
  });

  it('grading_mismatch → excluded from scoring', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25 })], 1, true), cfg(), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('grading_mismatch');
  });

  it('no resolution clock → cannot window → no entry', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25 })]), cfg(), null);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('no_resolve_clock');
  });

  it('a pick with no houseProb on any bucket → no in-window capture', () => {
    const noSeed: ReplayTick = { ...tick(30), buckets: ladder().map((x) => ({ ...x, houseProb: null })) };
    const t = replayCheapEarlyEvent(input([noSeed]), cfg(), RESOLVE_MS);
    expect(t.entered).toBe(false);
    expect(t.reason).toBe('no_in_window_capture');
  });
});

describe('replayCheapEarlyEvent — grading + fee math', () => {
  it('WIN: pick temp == winner temp → payout redeemed, net return matches (1 − ask − fee)/ask', () => {
    // pick = bucket 1, label 21°C; winnerIdx 1 → winner label 21°C → temps match → win.
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25 })], 1), cfg({ stakeUsd: 20 }), RESOLVE_MS);
    expect(t.entered).toBe(true);
    expect(t.won).toBe(true);
    expect(t.status).toBe('realized');
    const fee = takerFeePerShare(0.25, CHEAP_EARLY_DEFAULTS.takerFeeRate);
    const expectedNetReturn = (1 - 0.25 - fee) / 0.25; // the cheap-entry-realbook.py net_return form
    expect(t.netReturn).toBeCloseTo(expectedNetReturn, 9);
    expect(t.netReturn).toBeGreaterThan(0);
  });

  it('LOSE: pick temp != winner temp → total loss of stake + fee', () => {
    // winnerIdx 0 → winner label 20°C; pick 21°C → temps differ → lose.
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25 })], 0), cfg({ stakeUsd: 20 }), RESOLVE_MS);
    expect(t.won).toBe(false);
    const shares = 20 / 0.25;
    const fee = takerFeePerShare(0.25, 0.05) * shares;
    expect(t.netPnlUsd).toBeCloseTo(-20 - fee, 6); // no payout; lost the stake + the entry fee
    expect(t.netReturn).toBeLessThan(0);
  });

  it('grades by TEMPERATURE LABEL, not the bucket index (traps #7): idx mismatch but temp match → WIN', () => {
    // pick is bucket idx 1 (label 25°C); the WINNER is a DIFFERENT idx (2) whose label is ALSO 25°C. A naive
    // pickIdx===winnerIdx compare (1===2) would call this a LOSS; temperature grading calls it a WIN.
    const buckets: OpeningBucket[] = [
      b(0, { label: '20°C' }),
      b(1, { label: '25°C', houseProb: 0.5, bestAsk: 0.25 }), // the pick
      b(2, { label: '25°C', houseProb: 0.1 }), // same temperature, different index = the winner
    ];
    const t = replayCheapEarlyEvent(
      { eventId: 'E', city: 'helsinki', targetDate: DATE, tz: TZ, ticks: [{ capturedAt: atHtc(30), hoursSinceListing: 30, tz: TZ, targetDate: DATE, buckets }], resolution: { winnerIdx: 2, gradingMismatch: false } },
      cfg(),
      RESOLVE_MS,
    );
    expect(t.entered).toBe(true);
    expect(t.entryTemp).toBe(25);
    expect(t.winnerTemp).toBe(25);
    expect(t.won).toBe(true); // temperature match despite idx 1 ≠ idx 2
  });

  it('unresolved (winnerIdx null) → an OPEN position marked to the last bid, excluded from realized', () => {
    const t = replayCheapEarlyEvent(input([tick(30, { bestAsk: 0.25, execBid: 0.22 })], null), cfg(), RESOLVE_MS);
    expect(t.entered).toBe(true);
    expect(t.status).toBe('open');
    expect(t.won).toBeNull();
  });
});

describe('replayCheapEarlyPanel', () => {
  const ev = (id: string, winnerIdx: number | null, ask = 0.25): EventReplayInput => ({
    eventId: id, city: 'helsinki', targetDate: `2026-06-${id.padStart(2, '0')}`, tz: TZ,
    ticks: [tick(30, { bestAsk: ask })], resolution: { winnerIdx, gradingMismatch: false },
  });
  const resolvesMap = (ids: string[]): Map<string, number> => new Map(ids.map((id) => [id, RESOLVE_MS]));

  it('ledgers entered trades, tallies non-entries, and INSUFFICIENT at low n', () => {
    const events = [ev('10', 1), ev('11', 0), ev('12', 1, 0.9 /* out of band */)];
    const panel = replayCheapEarlyPanel(events, cfg(), resolvesMap(['10', '11', '12']));
    expect(panel.nConsidered).toBe(3);
    expect(panel.nExecuted).toBe(2); // events 10, 11 entered; 12 out of band
    expect(panel.reasonTally.ask_out_of_band).toBe(1);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA');
    expect(panel.verdict.nMarkets).toBe(2);
  });

  it('the verdict is scored on the real-book basis and minWinFrac 0 (binds on CI, not the hit rate)', () => {
    const panel = replayCheapEarlyPanel([ev('10', 1)], cfg(), resolvesMap(['10']));
    expect(panel.verdict.priceBasis).toBe('real-book');
    // winRate is informational (a hold win == netPnl>0); the gate does not require it ≥ 0.5.
    expect(Number.isFinite(panel.winRate)).toBe(true);
  });

  it('is total on junk input (empty events → empty panel, no throw)', () => {
    const panel = replayCheapEarlyPanel([], cfg(), new Map());
    expect(panel.ledger).toEqual([]);
    expect(panel.nExecuted).toBe(0);
    expect(panel.verdict.label).toBe('INSUFFICIENT_DATA');
  });
});

describe('the pre-registered variant knobs (CHEAP-EARLY-IMPROVE.md §8)', () => {
  // one synthetic event with THREE in-window ticks: 35h (ask 0.32), 30h (ask 0.22), 26h (ask 0.24).
  const threeTick = (): EventReplayInput =>
    input([tick(35, { bestAsk: 0.32 }), tick(30, { bestAsk: 0.22 }), tick(26, { bestAsk: 0.24 })]);

  it("entryRule 'latest' takes the smallest hours-to-close; 'first' takes the earliest clearing tick", () => {
    const latest = replayCheapEarlyEvent(threeTick(), cfg({ entryRule: 'latest' }), RESOLVE_MS);
    expect(latest.entered).toBe(true);
    expect(latest.htcAtEntry).toBeCloseTo(26, 6);
    expect(latest.entryAsk).toBeCloseTo(0.24, 9);

    const first = replayCheapEarlyEvent(threeTick(), cfg({ entryRule: 'first' }), RESOLVE_MS);
    expect(first.entered).toBe(true);
    expect(first.htcAtEntry).toBeCloseTo(35, 6); // the EARLIEST capture — what the live lane did
    expect(first.entryAsk).toBeCloseTo(0.32, 9);

    // and 'latest' is the frozen default (the canonical path is unchanged by the knob existing)
    expect(replayCheapEarlyEvent(threeTick(), cfg(), RESOLVE_MS).htcAtEntry).toBeCloseTo(26, 6);
  });

  it("entryRule 'first' SKIPS an earlier tick that fails the band and takes the next one that clears", () => {
    // 35h is out of band (0.60) → the first CLEARING tick is 30h @ 0.22, not the 26h 'latest' pick.
    const ev = input([tick(35, { bestAsk: 0.6 }), tick(30, { bestAsk: 0.22 }), tick(26, { bestAsk: 0.24 })]);
    const t = replayCheapEarlyEvent(ev, cfg({ entryRule: 'first' }), RESOLVE_MS);
    expect(t.entered).toBe(true);
    expect(t.htcAtEntry).toBeCloseTo(30, 6);
  });

  it('minEdge blocks a pick whose houseProb − ask falls short (and 0 disables the gate entirely)', () => {
    // pick houseProb 0.40, ask 0.32 → edge 0.08.
    const ev = (): EventReplayInput => input([tick(30, { bestAsk: 0.32, houseProb: 0.4 })]);
    expect(replayCheapEarlyEvent(ev(), cfg({ minEdge: 0.05 }), RESOLVE_MS).entered).toBe(true); // 0.08 ≥ 0.05
    const blocked = replayCheapEarlyEvent(ev(), cfg({ minEdge: 0.12 }), RESOLVE_MS); // 0.08 < 0.12
    expect(blocked.entered).toBe(false);
    expect(blocked.reason).toBe('below_min_edge');
    expect(blocked.entryAsk).toBeCloseTo(0.32, 9); // the diagnostic ask is still recorded

    // minEdge 0 (the frozen default) must NOT filter a pick priced ABOVE its house probability.
    const rich = input([tick(30, { bestAsk: 0.3, houseProb: 0.22 })]);
    expect(replayCheapEarlyEvent(rich, cfg(), RESOLVE_MS).entered).toBe(true);
  });

  it('the topK city filter ranks by hit rate and drops the under-graded + the out-of-rank cities', () => {
    const c = cheapEarlyCfg(['helsinki', 'ankara', 'wellington', 'madrid'], {
      cityFilter: { kind: 'topK', k: 2, minGraded: 8, windowDays: 28 },
    });
    const rates = {
      helsinki: { hitRate: 0.5, graded: 20 }, // rank 1
      ankara: { hitRate: 0.45, graded: 12 }, // rank 2
      wellington: { hitRate: 0.9, graded: 3 }, // BEST rate but graded < minGraded → ineligible
      madrid: { hitRate: 0.4, graded: 30 }, // eligible but ranked 3rd of 3 → outside k=2
    };
    expect(cheapEarlyEligibleCities(c, rates)).toEqual(['helsinki', 'ankara']);
    // fail-closed: no hit rates ⇒ NO city is eligible (a missing input must never widen the universe).
    expect(cheapEarlyEligibleCities(c, undefined)).toEqual([]);
    // 'all' is unaffected by the hit rates.
    expect(cheapEarlyEligibleCities(cheapEarlyCfg(['helsinki', 'ankara']), rates)).toEqual(['helsinki', 'ankara']);
  });

  it('the panel scores ONLY the eligible cities under a topK filter (and nothing without hit rates)', () => {
    const events: EventReplayInput[] = [
      { eventId: '10', city: 'helsinki', targetDate: '2026-06-10', tz: TZ, ticks: [tick(30, { bestAsk: 0.25 })], resolution: { winnerIdx: 1, gradingMismatch: false } },
      { eventId: '11', city: 'madrid', targetDate: '2026-06-11', tz: TZ, ticks: [tick(30, { bestAsk: 0.25 })], resolution: { winnerIdx: 1, gradingMismatch: false } },
    ];
    const resolves = new Map([['10', RESOLVE_MS], ['11', RESOLVE_MS]]);
    const c = cheapEarlyCfg(['helsinki', 'madrid'], { cityFilter: { kind: 'topK', k: 1, minGraded: 8, windowDays: 28 } });
    const rates = { helsinki: { hitRate: 0.5, graded: 20 }, madrid: { hitRate: 0.4, graded: 30 } };

    const scoped = replayCheapEarlyPanel(events, c, resolves, {}, rates);
    expect(scoped.scoredCities).toEqual(['helsinki']);
    expect(scoped.nConsidered).toBe(1); // madrid is out of the universe entirely, not a non-entry
    expect(scoped.nExecuted).toBe(1);

    const blind = replayCheapEarlyPanel(events, c, resolves);
    expect(blind.scoredCities).toEqual([]);
    expect(blind.nConsidered).toBe(0);
    expect(blind.nExecuted).toBe(0);
  });

  it('the variant registry is the pre-registered six, canonical first and unmodified', () => {
    expect(CHEAP_EARLY_VARIANTS.map((v) => v.id)).toEqual([
      'canonical', 'live-replica', 'wide-band', 'wide-band-open', 'late-12h', 'survivor',
    ]);
    expect(CHEAP_EARLY_VARIANTS[0]!.id).toBe(CANONICAL_VARIANT_ID);
    // the canonical variant carries NO cfg delta — its block must be the headline panel, byte for byte.
    expect(CHEAP_EARLY_VARIANTS[0]!.over).toEqual({});
    // every variant carries the backtest cell it was registered from (the "backtest vs forward" column).
    for (const v of CHEAP_EARLY_VARIANTS) {
      expect(v.backtestRef.n).toBeGreaterThan(0);
      expect(v.backtestRef.ciLow).toBeLessThanOrEqual(v.backtestRef.netRet);
      expect(v.backtestRef.ciHigh).toBeGreaterThanOrEqual(v.backtestRef.netRet);
    }
    // the window SET must cover every variant's window, or a variant is starved rather than measured — and it
    // must stay DISJOINT (0128), because the contiguous union [12,36] reads ~2x the captures per city.
    const base = cheapEarlyCfg([...CHEAP_EARLY_CITIES]);
    expect(cheapEarlyWindowSet(base)).toEqual([{ loH: 12, hiH: 15 }, { loH: 24, hiH: 36 }]);
  });
});

describe('cheapEarlyWindowSet — the disjoint window set the slim read is asked for (0128)', () => {
  const base = cheapEarlyCfg([...CHEAP_EARLY_CITIES]);
  const setOf = (...windows: Array<[number, number]>) =>
    cheapEarlyWindowSet(
      base,
      windows.map(([lo, hi], i) => ({
        id: `v${i}`,
        label: `[${lo},${hi}]`,
        over: { windowLoH: lo, windowHiH: hi },
        backtestRef: { n: 1, netRet: 0, ciLow: 0, ciHigh: 0 },
      })),
    );

  it('a CONTAINED variant window merges into the canonical one ([24,36] ∪ [33,36] → [24,36])', () => {
    expect(setOf([33, 36])).toEqual([{ loH: 24, hiH: 36 }]);
  });

  it('an OVERLAPPING window extends the slice rather than adding one', () => {
    expect(setOf([20, 30])).toEqual([{ loH: 20, hiH: 36 }]);
  });

  it('a TOUCHING window merges (adjacent, no dead gap to save)', () => {
    expect(setOf([12, 24])).toEqual([{ loH: 12, hiH: 36 }]);
  });

  it('a DETACHED window stays its own slice — the dead middle is never read', () => {
    expect(setOf([12, 15])).toEqual([{ loH: 12, hiH: 15 }, { loH: 24, hiH: 36 }]);
  });

  it('several detached windows come back sorted and disjoint', () => {
    expect(setOf([6, 8], [12, 15], [13, 16])).toEqual([
      { loH: 6, hiH: 8 }, { loH: 12, hiH: 16 }, { loH: 24, hiH: 36 },
    ]);
  });

  it('the canonical window alone is the whole set when no variant widens it', () => {
    expect(cheapEarlyWindowSet(base, [])).toEqual([{ loH: 24, hiH: 36 }]);
  });

  it('junk windows (NaN / inverted) are dropped, never emitted as a slice', () => {
    expect(setOf([Number.NaN, 20], [30, 10])).toEqual([{ loH: 24, hiH: 36 }]);
  });
});

describe('config', () => {
  it('cheapEarlyCfg pins the frozen defaults and takes the city list', () => {
    const c = cheapEarlyCfg([...CHEAP_EARLY_CITIES]);
    expect(c.windowLoH).toBe(24);
    expect(c.windowHiH).toBe(36);
    expect(c.askBandLo).toBe(0.2);
    expect(c.askBandHi).toBe(0.33);
    expect(c.stakeUsd).toBe(20);
    expect(c.cities).toEqual(['ankara', 'helsinki', 'kuala-lumpur', 'wellington']);
  });
});
