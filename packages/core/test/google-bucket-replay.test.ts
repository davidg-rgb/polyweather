/**
 * Tests for core/sim/google-bucket-replay — the PURE Google-picks-bucket taker replay engine ("Test 2").
 *
 * Pins the decisive properties: googleBucketIdx maps a °C forecast to the ladder bucket (°C direct / °F
 * converted / FLOOR semantics / tails / junk → null); entry fires ONLY when the predicted bucket's execAsk is
 * strictly below askMax (0.18); each absolute exit (take-profit ≥ 0.30 / stop-loss ≤ 0.15); hold-to-resolution
 * settlement (win $1 / lose $0 / unresolved mark); a null predicted idx → executed:false 'no_google'; and —
 * load-bearing — NO LOOK-AHEAD (a huge up-tick AFTER a stop-loss must not rescue the trade). Pure + total.
 */
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_DEFAULTS,
  googleBucketIdx,
  googleCfg,
  replayGoogleBracket,
  type GoogleBracketCfg,
} from '../src/sim/google-bucket-replay.ts';
import type { EventReplayInput, ReplayTick } from '../src/sim/opening-bracket-replay.ts';
import type { OpeningBucket } from '../src/sim/opening-convergence.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const TZ = 'Europe/Amsterdam';
const DATE = '2026-07-01';
const cfg: GoogleBracketCfg = { ...GOOGLE_DEFAULTS, cities: ['amsterdam'] };

const mkB = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx,
  label: `${14 + idx}°C`,
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
  ...over,
});

/** a 5-bucket ladder; `center` shapes the idx-2 bucket (the one the Google forecast picks in these fixtures). */
const ladder = (center: Partial<OpeningBucket> = {}): OpeningBucket[] => [mkB(0), mkB(1), mkB(2, center), mkB(3), mkB(4)];

const tk = (capturedAt: string, age: number, center: Partial<OpeningBucket> = {}): ReplayTick => ({
  capturedAt,
  hoursSinceListing: age,
  tz: TZ,
  targetDate: DATE,
  buckets: ladder(center),
});

const T0 = '2026-07-01T08:00:00.000Z';
const T1 = '2026-07-01T08:00:30.000Z';
const T2 = '2026-07-01T08:01:00.000Z';

const ev = (over: Partial<EventReplayInput> = {}): EventReplayInput => ({
  eventId: 'ev-1',
  city: 'amsterdam',
  targetDate: DATE,
  tz: TZ,
  ticks: [],
  resolution: { winnerIdx: null, gradingMismatch: false },
  ...over,
});

/** the entry tick — idx2 priced cheap (execAsk 0.17 < askMax 0.18). */
const entry = (capturedAt = T0): ReplayTick => tk(capturedAt, 0.2, { execAsk: 0.17, execBid: 0.1 });

// ── 1 · googleBucketIdx — °C direct, °F converted, FLOOR semantics, tails, junk ─────────────────────────

describe('googleBucketIdx — Google °C forecast → ladder bucket idx', () => {
  const cLadder: OpeningBucket[] = [
    mkB(0, { label: '14°C or below' }),
    mkB(1, { label: '15°C' }),
    mkB(2, { label: '16°C' }),
    mkB(3, { label: '17°C' }),
    mkB(4, { label: '18°C or higher' }),
  ];
  const fLadder: OpeningBucket[] = [
    mkB(0, { label: '89°F or below' }),
    mkB(1, { label: '90-91°F' }),
    mkB(2, { label: '92-93°F' }),
    mkB(3, { label: '94-95°F' }),
    mkB(4, { label: '96°F or higher' }),
  ];

  it('°C city: floors to the whole degree and finds the containing bucket', () => {
    expect(googleBucketIdx(cLadder, 16.7, 'C')).toBe(2); // floor 16 → 16°C
    expect(googleBucketIdx(cLadder, 15.0, 'C')).toBe(1);
    expect(googleBucketIdx(cLadder, 15.9, 'C')).toBe(1); // FLOOR (not round): 15.9 → 15, not 16
  });

  it('°C tails: below the low tail / above the high tail resolve to the tail buckets', () => {
    expect(googleBucketIdx(cLadder, 11.2, 'C')).toBe(0);
    expect(googleBucketIdx(cLadder, 25.0, 'C')).toBe(4);
  });

  it('°F city: converts °C→°F, floors, then buckets (34°C = 93.2°F → 92-93°F)', () => {
    expect(googleBucketIdx(fLadder, 34, 'F')).toBe(2);
    expect(googleBucketIdx(fLadder, 35, 'F')).toBe(3); // 95.0°F → 94-95°F
  });

  it('returns null (never throws) on junk: empty ladder, unparseable label, or NaN forecast', () => {
    expect(googleBucketIdx([], 16, 'C')).toBeNull();
    expect(googleBucketIdx([mkB(0, { label: 'not-a-bucket' })], 16, 'C')).toBeNull();
    expect(googleBucketIdx(cLadder, Number.NaN, 'C')).toBeNull();
  });
});

// ── 2 · entry gating (execAsk strictly below askMax) ────────────────────────────────────────────────────

describe('replayGoogleBracket — entry gating', () => {
  it('enters at the first tick whose predicted bucket ask is strictly below askMax (0.18)', () => {
    const trade = replayGoogleBracket(ev({ ticks: [entry(), tk(T1, 0.3, { execBid: 0.35 })] }), 2, cfg);
    expect(trade.executed).toBe(true);
    expect(trade.isMaker).toBe(false); // pure taker
    expect(trade.entryLabel).toBe('16°C');
    expect(trade.entryPrice).toBeCloseTo(0.18, 9); // 0.17 ask + 0.01 pessimistic slippage
  });

  it('never enters when the ask never drops below askMax (0.18 is NOT < 0.18 — strict)', () => {
    const trade = replayGoogleBracket(ev({ ticks: [tk(T0, 0.2, { execAsk: 0.18, execBid: 0.1 })] }), 2, cfg);
    expect(trade.executed).toBe(false);
    expect(trade.exitReason).toBe('never_enterable');
  });

  it('a null / negative predicted idx (no Google data) → executed:false no_google', () => {
    expect(replayGoogleBracket(ev({ ticks: [entry()] }), null, cfg).exitReason).toBe('no_google');
    expect(replayGoogleBracket(ev({ ticks: [entry()] }), -1, cfg).exitReason).toBe('no_google');
  });
});

// ── 3 · the two absolute exits + hold-to-resolution ─────────────────────────────────────────────────────

describe('replayGoogleBracket — absolute bracket exits', () => {
  it('take_profit: sells at the execBid that reaches tpAbs (0.30)', () => {
    const trade = replayGoogleBracket(ev({ ticks: [entry(), tk(T1, 0.3, { execBid: 0.35 })] }), 2, cfg);
    expect(trade.exitReason.startsWith('take_profit')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.35, 9);
    expect(trade.netReturn).toBeGreaterThan(0);
  });

  it('stop_loss: sells at the execBid that reaches slAbs (0.15)', () => {
    const trade = replayGoogleBracket(ev({ ticks: [entry(), tk(T1, 0.3, { execBid: 0.1 })] }), 2, cfg);
    expect(trade.exitReason.startsWith('stop_loss')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.1, 9);
    expect(trade.netReturn).toBeLessThan(0);
  });

  it('the ENTRY-tick bid never self-triggers — exits are evaluated from the NEXT tick only', () => {
    // entry tick idx2 bid 0.10 (≤ slAbs) but the ONLY later tick holds at 0.20 → no exit → settles, not an
    // instant same-tick stop. (Guards the "cross-the-spread bid is not a sell signal" design choice.)
    const trade = replayGoogleBracket(
      ev({ ticks: [entry(), tk(T1, 0.3, { execBid: 0.2 })], resolution: { winnerIdx: 2, gradingMismatch: false } }),
      2,
      cfg,
    );
    expect(trade.exitReason).toBe('resolution_settle:win');
  });
});

// ── 4 · hold-to-resolution settlement ───────────────────────────────────────────────────────────────────

describe('replayGoogleBracket — resolution settlement', () => {
  const held = [entry(), tk(T1, 0.3, { execBid: 0.2 }), tk(T2, 0.4, { execBid: 0.2 })]; // never TP/SL

  it('settles a WIN at $1 when the bought bucket is the resolved winner', () => {
    const trade = replayGoogleBracket(ev({ ticks: held, resolution: { winnerIdx: 2, gradingMismatch: false } }), 2, cfg);
    expect(trade.exitReason).toBe('resolution_settle:win');
    expect(trade.exitPrice).toBe(1);
    expect(trade.netReturn).toBeGreaterThan(0);
  });

  it('settles a LOSE at $0 when another bucket wins', () => {
    const trade = replayGoogleBracket(ev({ ticks: held, resolution: { winnerIdx: 9, gradingMismatch: false } }), 2, cfg);
    expect(trade.exitReason).toBe('resolution_settle:lose');
    expect(trade.exitPrice).toBe(0);
    // a taker LOSE returns slightly worse than −1: the stake is gone AND the entry taker fee was a real cost.
    expect(trade.netReturn).toBeLessThan(-1);
    expect(trade.netReturn).toBeGreaterThan(-1.1);
  });

  it('marks to the last execBid (no payout) when unresolved', () => {
    const trade = replayGoogleBracket(ev({ ticks: held, resolution: { winnerIdx: null, gradingMismatch: false } }), 2, cfg);
    expect(trade.exitReason).toBe('mtm_unresolved');
    expect(trade.exitPrice).toBeCloseTo(0.2, 9);
  });
});

// ── 5 · NO LOOK-AHEAD ───────────────────────────────────────────────────────────────────────────────────

describe('replayGoogleBracket — NO LOOK-AHEAD', () => {
  it('a huge up-tick AFTER a stop-loss fired does NOT rescue the trade (only bestReachableBid records it)', () => {
    const trade = replayGoogleBracket(
      ev({
        ticks: [
          entry(),
          tk(T1, 0.3, { execBid: 0.1 }), // stop-loss fires here (≤ 0.15)
          tk(T2, 0.4, { execBid: 0.9 }), // a later 0.90 up-tick — must NOT change the realized exit
        ],
      }),
      2,
      cfg,
    );
    expect(trade.exitReason.startsWith('stop_loss')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.1, 9);
    expect(trade.bestReachableBid).toBeGreaterThanOrEqual(0.9); // the ceiling SAW it; the rule didn't take it
  });
});

// ── 6 · totality + config helper ────────────────────────────────────────────────────────────────────────

describe('replayGoogleBracket — totality + googleCfg', () => {
  it('is total: null / empty / junk → no throw, executed:false', () => {
    expect(() => replayGoogleBracket(null as unknown as EventReplayInput, 2, cfg)).not.toThrow();
    expect(replayGoogleBracket(null as unknown as EventReplayInput, 2, cfg).executed).toBe(false);
    expect(replayGoogleBracket(ev({ ticks: [] }), 2, cfg).executed).toBe(false);
    const junk = ev({
      ticks: [{ capturedAt: 'not-a-date', hoursSinceListing: Number.NaN, tz: '', targetDate: '', buckets: undefined as unknown as OpeningBucket[] }],
    });
    expect(() => replayGoogleBracket(junk, 2, cfg)).not.toThrow();
    expect(replayGoogleBracket(junk, 2, cfg).executed).toBe(false);
  });

  it('googleCfg pins the run cities and keeps the frozen thresholds', () => {
    const c = googleCfg(['amsterdam', 'paris']);
    expect(c.cities).toEqual(['amsterdam', 'paris']);
    expect(c.askMax).toBe(0.18);
    expect(c.tpAbs).toBe(0.3);
    expect(c.slAbs).toBe(0.15);
    expect(googleCfg([]).cities).toEqual(GOOGLE_DEFAULTS.cities); // empty → the default scope
  });
});
