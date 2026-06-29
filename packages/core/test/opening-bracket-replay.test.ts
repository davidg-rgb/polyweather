/**
 * Tests for core/sim/opening-bracket-replay — the PURE bracket-EXIT replay engine (sell into the convergence
 * BEFORE resolution; the 12th-signal mechanism the hold-to-resolution scorer cannot see).
 *
 * The decisive properties pinned here: entry on a NON-flat book (requireFlatOpen:false wired through);
 * the maker-first fill lifecycle (maker fills only on a through-the-limit later ask, else the cancel_maker_take
 * taker fallback); each bracket exit (take_profit / stop_loss / time_stop); resolution settlement win AND lose;
 * grading_mismatch exclusion; a never-filled order (executed:false, dropped from the verdict); the TP sweep
 * (a lower TP harvests a re-rating a higher delta misses); the frozen §9R-E verdict labels (PASS/KILL/
 * INSUFFICIENT at the floors); totality (junk → no throw); and — load-bearing — NO LOOK-AHEAD (a huge up-tick
 * AFTER a stop-loss fired must NOT rescue the trade, even though bestReachableBid records it).
 *
 * Pure + total throughout — mirrors opening-convergence.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  replayEvent,
  replayPanel,
  type EventReplayInput,
  type ReplayTick,
} from '../src/sim/opening-bracket-replay.ts';
import { OPENING_DEFAULTS, type OpeningBucket, type OpeningCfg } from '../src/sim/opening-convergence.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────
const TZ = 'Europe/Amsterdam';
const DATE = '2026-06-28'; // CEST → local noon = 10:00Z
const cfg: OpeningCfg = { ...OPENING_DEFAULTS, cities: ['amsterdam'] };

/** Defaults-first, override-after so an explicit `null` (open tail) survives. */
const mkB = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx,
  label: `b${idx}`,
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

/** A 5-bucket ladder peaked (houseProb) at idx 2; `centerOver` shapes the idx-2 center bucket per tick. */
const ladder = (centerOver: Partial<OpeningBucket> = {}): OpeningBucket[] => [
  mkB(0, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
  mkB(1, { houseProb: 0.2, execAsk: 0.11, bestAsk: 0.11 }),
  mkB(2, { houseProb: 0.35, ...centerOver }),
  mkB(3, { houseProb: 0.2, execAsk: 0.11, bestAsk: 0.11 }),
  mkB(4, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
];

const tk = (capturedAt: string, age: number, centerOver: Partial<OpeningBucket> = {}): ReplayTick => ({
  capturedAt,
  hoursSinceListing: age,
  tz: TZ,
  targetDate: DATE,
  buckets: ladder(centerOver),
});

const T0 = '2026-06-28T08:00:00.000Z'; // 120m of runway to noon → passes the minimum-runway guard
const T1 = '2026-06-28T08:00:30.000Z';
const T2 = '2026-06-28T08:01:00.000Z';
const T3 = '2026-06-28T08:01:30.000Z';
const T20 = '2026-06-28T08:20:00.000Z'; // 20m after T0 → past makerFillWindowMin (15)
const TNOON = '2026-06-28T10:00:00.000Z'; // exactly local noon → the hard time-stop

/** the entry tick — idx2 priced to be enterable, makerLimit = min(reservation 0.20, bestAsk 0.12) = 0.12. */
const entry = (capturedAt = T0): ReplayTick => tk(capturedAt, 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 });
/** a later tick whose idx2 ask ran DOWN to 0.11 ≤ makerLimit → the resting maker fills at 0.12. */
const makerFill = (capturedAt = T1): ReplayTick => tk(capturedAt, 0.3, { execAsk: 0.11, execBid: 0.1 });

const ev = (over: Partial<EventReplayInput> = {}): EventReplayInput => ({
  eventId: 'ev-1',
  city: 'amsterdam',
  targetDate: DATE,
  tz: TZ,
  ticks: [],
  resolution: { winnerIdx: null, gradingMismatch: false },
  ...over,
});

// ── 1 · entry on a NON-flat book (requireFlatOpen:false wired through) ──────────────────────────────────

describe('replayEvent — entry selection (requireFlatOpen:false)', () => {
  it('enters on a NON-flat book (peak mid > 0.18) — the flat-open gate is skipped, every other gate kept', () => {
    // idx2 mid 0.5 ⇒ isFlatOpen would be false; the bracket replay enters anyway (flat-open premise falsified).
    const t = tk(T0, 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1, mid: 0.5 });
    const trade = replayEvent(ev({ ticks: [t, makerFill(), tk(TNOON, 2, { execBid: 0.1 })] }), cfg, 0.25);
    expect(trade.executed).toBe(true);
  });

  it('never enters when the city is outside the allowlist (executed:false)', () => {
    const trade = replayEvent(ev({ city: 'london', ticks: [entry(), makerFill()] }), cfg, 0.25);
    expect(trade.executed).toBe(false);
    expect(trade.exitReason).toBe('never_enterable');
  });
});

// ── 2 · maker-first fill lifecycle ─────────────────────────────────────────────────────────────────────

describe('replayEvent — maker fill vs taker fallback', () => {
  it('maker fills at makerLimit (0.12, $0 fee) when a LATER ask trades through the limit', () => {
    const trade = replayEvent(ev({ ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.45 })] }), cfg, 0.25);
    expect(trade.executed).toBe(true);
    expect(trade.isMaker).toBe(true);
    expect(trade.entryPrice).toBeCloseTo(0.12, 9);
  });

  it('cancel_maker_take taker fallback once the maker window elapses (worse-of + slippage, taker fee)', () => {
    // T20 is 20m > makerFillWindowMin(15) and its ask 0.15 never reached makerLimit → cancel → taker at
    // max(stored 0.18, live 0.15) + slippage 0.01 = 0.19; time-stop closes it at noon.
    const trade = replayEvent(
      ev({ ticks: [entry(), tk(T20, 0.5, { execAsk: 0.15, execBid: 0.3 }), tk(TNOON, 2, { execBid: 0.3 })] }),
      cfg,
      0.25,
    );
    expect(trade.executed).toBe(true);
    expect(trade.isMaker).toBe(false);
    expect(trade.entryPrice).toBeCloseTo(0.19, 9);
    expect(trade.exitReason.startsWith('time_stop')).toBe(true);
  });

  it('never_filled (executed:false) when a rested maker never fills before the series ends', () => {
    // only two ticks; T1's ask 0.50 > makerLimit and the 15m window never elapses ⇒ the order rests unfilled.
    const trade = replayEvent(ev({ ticks: [entry(), tk(T1, 0.3, { execAsk: 0.5, execBid: 0.1 })] }), cfg, 0.25);
    expect(trade.executed).toBe(false);
    expect(trade.exitReason).toBe('never_filled');
  });
});

// ── 3 · the three bracket exits ────────────────────────────────────────────────────────────────────────

describe('replayEvent — bracket exits', () => {
  it('take_profit: sells at the execBid that crosses entry + tpDeltaPp', () => {
    const trade = replayEvent(ev({ ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.45 })] }), cfg, 0.25);
    expect(trade.exitReason.startsWith('take_profit')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.45, 9);
    expect(trade.netReturn).toBeGreaterThan(0);
  });

  it('stop_loss: sells at the execBid that breaches the stop (entry 0.12 ⇒ relative floor 0.06)', () => {
    const trade = replayEvent(ev({ ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.05 })] }), cfg, 0.25);
    expect(trade.exitReason.startsWith('stop_loss')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.05, 9);
    expect(trade.netReturn).toBeLessThan(0);
  });

  it('time_stop: flattens at the local-noon tick regardless of mark', () => {
    const trade = replayEvent(ev({ ticks: [entry(), makerFill(), tk(TNOON, 2, { execBid: 0.1 })] }), cfg, 0.25);
    expect(trade.exitReason.startsWith('time_stop')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.1, 9);
  });
});

// ── 4 · NO LOOK-AHEAD (the load-bearing invariant) ─────────────────────────────────────────────────────

describe('replayEvent — NO LOOK-AHEAD', () => {
  it('a huge up-tick AFTER a stop-loss fired does NOT rescue the trade (only bestReachableBid records it)', () => {
    const trade = replayEvent(
      ev({
        ticks: [
          entry(),
          makerFill(),
          tk(T2, 0.35, { execBid: 0.05 }), // stop-loss fires here
          tk(T3, 0.4, { execBid: 0.9 }), // a later 0.90 up-tick — must NOT change the realized exit
        ],
      }),
      cfg,
      0.25,
    );
    expect(trade.exitReason.startsWith('stop_loss')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.05, 9); // exited at the stop, not the 0.90
    expect(trade.netReturn).toBeLessThan(0);
    expect(trade.bestReachableBid).toBeGreaterThanOrEqual(0.9); // the ceiling SAW the up-tick, the rule didn't take it
  });
});

// ── 5 · resolution settlement (leftover open at series end) ─────────────────────────────────────────────

describe('replayEvent — resolution settlement', () => {
  const heldToEnd = [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.1 })]; // no TP/SL, no noon → settle

  it('settles a WIN at $1 when the center bucket is the resolved winner', () => {
    const trade = replayEvent(ev({ ticks: heldToEnd, resolution: { winnerIdx: 2, gradingMismatch: false } }), cfg, 0.25);
    expect(trade.exitReason).toBe('resolution_settle:win');
    expect(trade.exitPrice).toBe(1);
    expect(trade.netReturn).toBeGreaterThan(0);
  });

  it('settles a LOSE at $0 when another bucket wins (netReturn = −1)', () => {
    const trade = replayEvent(ev({ ticks: heldToEnd, resolution: { winnerIdx: 9, gradingMismatch: false } }), cfg, 0.25);
    expect(trade.exitReason).toBe('resolution_settle:lose');
    expect(trade.exitPrice).toBe(0);
    expect(trade.netReturn).toBeCloseTo(-1, 9);
  });

  it('marks to the last execBid (no payout) when the market is unresolved', () => {
    const trade = replayEvent(ev({ ticks: heldToEnd, resolution: { winnerIdx: null, gradingMismatch: false } }), cfg, 0.25);
    expect(trade.exitReason).toBe('mtm_unresolved');
    expect(trade.exitPrice).toBeCloseTo(0.1, 9);
  });
});

// ── 6 · the TP sweep ───────────────────────────────────────────────────────────────────────────────────

describe('replayEvent / replayPanel — the take-profit sweep', () => {
  // idx2 re-rates to 0.30 (T2) then falls to 0.08 (T3); resolution loses (winner 9).
  const reRate = ev({
    ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.3 }), tk(T3, 0.4, { execBid: 0.08 })],
    resolution: { winnerIdx: 9, gradingMismatch: false },
  });

  it('a LOWER TP harvests the convergence a higher delta misses', () => {
    const low = replayEvent(reRate, cfg, 0.06); // threshold 0.18 ⇒ take-profit at 0.30
    expect(low.exitReason.startsWith('take_profit')).toBe(true);
    expect(low.netReturn).toBeGreaterThan(0);

    const high = replayEvent(reRate, cfg, 0.25); // threshold 0.37 / modelProb 0.35 ⇒ never fires ⇒ settles a loss
    expect(high.exitReason).toBe('resolution_settle:lose');
    expect(high.netReturn).toBeLessThan(0);
  });

  it('replayPanel always includes the pre-registered headline TP in the sweep', () => {
    const panel = replayPanel([reRate], cfg, [0.06]);
    expect(panel.headlineTp).toBe(cfg.tpDeltaPp); // 0.25
    expect(panel.perTp.map((r) => r.tpDeltaPp)).toEqual([0.06, 0.25]); // headline unioned + sorted
  });
});

// ── 7 · the frozen §9R-E verdict at the floors ─────────────────────────────────────────────────────────

describe('replayPanel — the §9R-E verdict labels', () => {
  const panelCfg: OpeningCfg = { ...OPENING_DEFAULTS, cities: Array.from({ length: 8 }, (_, i) => `c${i}`) };
  const evTicks = (date: string): ReplayTick[] => [
    { capturedAt: `${date}T08:00:00.000Z`, hoursSinceListing: 0.2, tz: TZ, targetDate: date, buckets: ladder({ execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 }) },
    { capturedAt: `${date}T08:00:30.000Z`, hoursSinceListing: 0.3, tz: TZ, targetDate: date, buckets: ladder({ execAsk: 0.11, execBid: 0.1 }) },
    { capturedAt: `${date}T08:01:00.000Z`, hoursSinceListing: 0.35, tz: TZ, targetDate: date, buckets: ladder({ execBid: 0.1 }) },
  ];
  const settleEvent = (id: string, city: string, date: string, win: boolean): EventReplayInput => ({
    eventId: id, city, targetDate: date, tz: TZ, ticks: evTicks(date), resolution: { winnerIdx: win ? 2 : 9, gradingMismatch: false },
  });
  const DATES = (n: number): string[] => Array.from({ length: n }, (_, i) => `2026-06-${10 + i}`);
  const grid = (nc: number, nd: number, win: (ci: number) => boolean): EventReplayInput[] =>
    Array.from({ length: nc }, (_, ci) => ci).flatMap((ci) =>
      DATES(nd).map((d) => settleEvent(`E${ci}_${d}`, `c${ci}`, d, win(ci))),
    );

  it('PASS — 6 cities × 7 days, all win: clears the floors, the bars, and the zero-skill MC', () => {
    const panel = replayPanel(grid(6, 7, () => true), panelCfg, [0.25]);
    const h = panel.perTp.find((r) => r.tpDeltaPp === 0.25)!;
    expect(h.nMarkets).toBe(42);
    expect(h.executedFrac).toBeCloseTo(1, 9);
    expect(h.label).toBe('PASS');
  });

  it('KILL — 8 cities × 7 days, half win / half lose: winFrac ≈ 0.5 but the city-clustered CI straddles 0', () => {
    const panel = replayPanel(grid(8, 7, (ci) => ci % 2 === 0), panelCfg, [0.25]);
    const h = panel.perTp.find((r) => r.tpDeltaPp === 0.25)!;
    expect(h.winFrac).toBeCloseTo(0.5, 6);
    expect(h.label).toBe('KILL');
  });

  it('INSUFFICIENT_DATA — too few markets/cities (3 × 7 = 21 < 40)', () => {
    const panel = replayPanel(grid(3, 7, () => true), panelCfg, [0.25]);
    expect(panel.perTp[0]!.label).toBe('INSUFFICIENT_DATA');
  });
});

// ── 8 · grading_mismatch exclusion + totality ──────────────────────────────────────────────────────────

describe('replayEvent / replayPanel — grading_mismatch + totality', () => {
  it('a grading_mismatch market is dropped from the verdict (and marks-to-bid, not settled)', () => {
    const mm = ev({
      ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.1 })],
      resolution: { winnerIdx: 2, gradingMismatch: true },
    });
    expect(replayEvent(mm, cfg, 0.25).exitReason).toBe('mtm_grading_mismatch'); // ambiguous payout — never $1
    const panel = replayPanel([mm], cfg, [0.25]);
    expect(panel.perTp[0]!.nEvents).toBe(0); // excluded from "considered"
    expect(panel.perTp[0]!.nMarkets).toBe(0); // and from the scored verdict panel
  });

  it('executedFrac counts a considered-but-never-filled market in the denominator, not the verdict', () => {
    // a CLEAN (non-grading_mismatch) event that ENTERS but whose rested maker never fills before the series
    // ends — it is "considered" (inflates nEvents) yet must be dropped from nMarkets/nExecuted, so executedFrac
    // reads 0.5 next to one event that does fill. Pins the §9R-E panel divergence path at a non-trivial point.
    const filled = ev({ eventId: 'fill', ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.45 })] });
    const unfilled = ev({ eventId: 'nofill', ticks: [entry(), tk(T1, 0.3, { execAsk: 0.5, execBid: 0.1 })] });
    expect(replayEvent(unfilled, cfg, 0.25).executed).toBe(false); // never_filled, but clean → considered
    const h = replayPanel([filled, unfilled], cfg, [0.25]).perTp[0]!;
    expect(h.nEvents).toBe(2); // both considered (neither grading_mismatch)
    expect(h.nExecuted).toBe(1); // only the filled one reached the verdict
    expect(h.nMarkets).toBe(1); // openingVerdict scored just the executed market
    expect(h.executedFrac).toBeCloseTo(0.5, 9);
  });

  it('is total: null / empty / junk → no throw, executed:false', () => {
    expect(() => replayEvent(null as unknown as EventReplayInput, cfg, 0.25)).not.toThrow();
    expect(replayEvent(null as unknown as EventReplayInput, cfg, 0.25).executed).toBe(false);
    expect(replayEvent(ev({ ticks: [] }), cfg, 0.25).executed).toBe(false);
    const junk = ev({
      ticks: [{ capturedAt: 'not-a-date', hoursSinceListing: Number.NaN, tz: '', targetDate: '', buckets: undefined as unknown as OpeningBucket[] }],
    });
    expect(() => replayEvent(junk, cfg, 0.25)).not.toThrow();
    expect(replayEvent(junk, cfg, 0.25).executed).toBe(false);
    expect(() => replayPanel([], cfg, [])).not.toThrow();
    expect(replayPanel([], cfg, []).perTp.length).toBe(1); // the headline TP row always exists
    expect(() => replayPanel([junk, null as unknown as EventReplayInput], cfg, [0.25])).not.toThrow();
  });
});

// ── 9 · taker fallback requires a LIVE ask (vanished-book guard) ────────────────────────────────────────

describe('replayEvent — taker fallback needs a live ask (vanished-book guard)', () => {
  it('never_filled when the center bucket has no live ask at the maker-window-elapsed tick', () => {
    // at T20 the maker window (15m) has elapsed but the center bucket has NO live ask (book vanished) → the
    // take cannot fire on a stale stored ask; with only these two ticks the order rests unfilled to series end.
    const vanished = tk(T20, 0.5, { execAsk: null, bestAsk: null, execBid: 0.3 });
    const trade = replayEvent(ev({ ticks: [entry(), vanished] }), cfg, 0.25);
    expect(trade.executed).toBe(false);
    expect(trade.exitReason).toBe('never_filled');
  });

  it('retries past a vanished-book tick and takes once a live ask reappears', () => {
    const T21 = '2026-06-28T08:21:00.000Z';
    const vanished = tk(T20, 0.5, { execAsk: null, bestAsk: null, execBid: 0.3 });
    const revived = tk(T21, 0.6, { execAsk: 0.15, execBid: 0.3 }); // live ask back → taker max(0.18,0.15)+0.01
    const trade = replayEvent(ev({ ticks: [entry(), vanished, revived, tk(TNOON, 2, { execBid: 0.3 })] }), cfg, 0.25);
    expect(trade.executed).toBe(true);
    expect(trade.isMaker).toBe(false);
    expect(trade.entryPrice).toBeCloseTo(0.19, 9);
  });
});

// ── 10 · a fired-but-unfillable time_stop keeps its exit-kind attribution ───────────────────────────────

describe('replayEvent — unfillable time_stop attribution', () => {
  it('prefixes the settle reason so exitKindOf still reads time_stop when no bid ever exists', () => {
    // taker-fallback fill at T20 (execAsk 0.11 live), but the center bucket NEVER shows an execBid → at noon the
    // time-stop fires with nothing to flatten into → settles at resolution, tagged time_stop→resolution_settle.
    const trade = replayEvent(
      ev({
        ticks: [entry(), tk(T20, 0.5, { execAsk: 0.11, execBid: null }), tk(TNOON, 2, { execBid: null })],
        resolution: { winnerIdx: 2, gradingMismatch: false },
      }),
      cfg,
      0.25,
    );
    expect(trade.executed).toBe(true);
    expect(trade.exitReason.startsWith('time_stop')).toBe(true); // attribution survives the settlement fall-through
    expect(trade.exitReason).toContain('resolution_settle:win');
    expect(trade.exitPrice).toBe(1); // couldn't flatten on-book → redeemed at resolution
  });
});

// ── 11 · post-realization curve (did we exit at the right point?) ────────────────────────────────────────

describe('replayEvent — post-realization curve', () => {
  it('records the best/worst AFTER a take-profit exit, folding in the resolution payout as the terminal', () => {
    // TP fires at 0.45 (T2); after that the bid dips to 0.30 (T3); the market resolves YES → terminal $1.
    const trade = replayEvent(
      ev({
        ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.45 }), tk(T3, 0.4, { execBid: 0.3 })],
        resolution: { winnerIdx: 2, gradingMismatch: false },
      }),
      cfg,
      0.25,
    );
    expect(trade.exitReason.startsWith('take_profit')).toBe(true);
    expect(trade.exitPrice).toBeCloseTo(0.45, 9);
    expect(trade.postExitWorstBid).toBeCloseTo(0.3, 9); // the post-exit dip
    expect(trade.postExitBestBid).toBe(1); // the resolution terminal beats every post-exit bid
  });

  it('a stop-loss that recovers + resolves YES shows the foregone upside (the stop cut a winner)', () => {
    const trade = replayEvent(
      ev({
        ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.05 }), tk(T3, 0.4, { execBid: 0.5 })],
        resolution: { winnerIdx: 2, gradingMismatch: false },
      }),
      cfg,
      0.25,
    );
    expect(trade.exitReason.startsWith('stop_loss')).toBe(true);
    expect(trade.postExitBestBid).toBe(1); // recovered to 0.50 then settled $1 — we got stopped out of a winner
  });

  it('a position HELD to resolution has no post-realization curve (NaN — nothing was closed early)', () => {
    const held = [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.1 })];
    const trade = replayEvent(ev({ ticks: held, resolution: { winnerIdx: 2, gradingMismatch: false } }), cfg, 0.25);
    expect(trade.exitReason).toBe('resolution_settle:win');
    expect(Number.isNaN(trade.postExitBestBid)).toBe(true);
    expect(Number.isNaN(trade.postExitWorstBid)).toBe(true);
  });
});

// ── 12 · realized-only §9R-E gate (in-flight marks are entered but NOT scored) ───────────────────────────

describe('replayPanel — the gate scores REALIZED markets only', () => {
  it('an in-flight mtm position counts toward nExecuted/executedFrac but NOT nMarkets', () => {
    const tpEv = ev({ eventId: 'tp', ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.45 })] }); // take_profit (realized)
    const openEv = ev({ eventId: 'open', ticks: [entry(), makerFill(), tk(T2, 0.35, { execBid: 0.1 })] }); // holds, unresolved → mtm
    expect(replayEvent(openEv, cfg, 0.25).exitReason).toBe('mtm_unresolved');
    const h = replayPanel([tpEv, openEv], cfg, [0.25]).perTp[0]!;
    expect(h.nExecuted).toBe(2); // both ENTERED (filled)
    expect(h.executedFrac).toBeCloseTo(1, 9);
    expect(h.nMarkets).toBe(1); // only the realized take-profit feeds the verdict — the mtm mark is excluded
  });
});
