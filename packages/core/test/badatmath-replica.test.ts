/**
 * Tests for core/sim/badatmath-replica — the pure "recreate badatmath's buying model" engine.
 * Covers entryQuote (peak-odds instant, floored bid, ask), bandEligible, selectBuys (band filter +
 * per-city·day breadth + per-entry-day bankroll cap + deterministic order), the three price legs
 * (makerIdeal / makerRealistic via the §12 ask-touch fill model / taker), hold-to-resolution win/loss
 * P&L (gross + fee-net), legStats / summarize (the spread-tax + adverse-selection-tax deltas), the
 * day-to-day ledger (cumulatives, gross vs net), rankCitiesByRoi (min-n + ordering), determinism, and
 * empty/pending safety. All pure — no DB, no network.
 */
import { describe, expect, it } from 'vitest';
import type { BucketSnapshot } from '../src/sim/copy-trade.ts';
import {
  DEFAULT_REPLICA_STRATEGY,
  type ForwardPosition,
  type LockedBuy,
  type ReplicaCandidate,
  type ReplicaStrategy,
  bandEligible,
  dailyLedger,
  entryQuote,
  legStats,
  placeBuysPure,
  rankCitiesByRoi,
  reconcilePure,
  scoreBuy,
  scoreBuys,
  scoreLocked,
  selectBuys,
  summarize,
} from '../src/sim/badatmath-replica.ts';

const STRAT = DEFAULT_REPLICA_STRATEGY;
const RES = 1_700_000_000; // a resolution instant (unix s)
const ENTRY = RES - STRAT.entryLeadHours * 3600; // = RES − 129600

const snap = (capturedAt: number, bid: number | null, ask: number | null): BucketSnapshot => ({
  capturedAt,
  bid,
  ask,
  mid: bid != null && ask != null ? (bid + ask) / 2 : null,
});

/** Default candidate: cheap-Yes bid 0.12 / ask 0.18 at the entry instant, winner, NO maker fill. */
function cand(over: Partial<ReplicaCandidate> = {}): ReplicaCandidate {
  const resolutionTs = over.resolutionTs ?? RES;
  const entryTs = resolutionTs - STRAT.entryLeadHours * 3600;
  return {
    conditionId: '0xc',
    eventId: 'E1',
    citySlug: 'kuala-lumpur',
    region: 'southeast-asia',
    targetDate: '2026-06-10',
    bucketIdx: 3,
    bucketLabel: '29–30°C',
    bucketWon: true,
    feeRate: 0.05,
    tickSize: 0.01,
    resolutionTs,
    snapshots: [
      snap(entryTs - 600, 0.05, 0.3), // pre-entry — ignored
      snap(entryTs + 60, 0.12, 0.18), // entry book: bid 0.12 (in band), ask 0.18
      snap(entryTs + 3600, 0.13, 0.19), // later asks > 0.12 → the rested bid never fills
    ],
    ...over,
  };
}

/** A candidate whose book DOES touch the rested bid (a post-entry ask ≤ 0.12 → maker-realistic fills). */
function candFills(over: Partial<ReplicaCandidate> = {}): ReplicaCandidate {
  const resolutionTs = over.resolutionTs ?? RES;
  const entryTs = resolutionTs - STRAT.entryLeadHours * 3600;
  return cand({
    snapshots: [
      snap(entryTs + 60, 0.12, 0.18), // entry book
      snap(entryTs + 3600, 0.1, 0.11), // ask 0.11 ≤ bid 0.12 → ask-touch fill
    ],
    ...over,
  });
}

const only = <T>(xs: T[]): T => {
  expect(xs).toHaveLength(1);
  return xs[0]!;
};

describe('entryQuote + bandEligible', () => {
  it('prices the maker (floored bid) and taker (ask) at the first snapshot ≥ the peak-odds instant', () => {
    const q = entryQuote(cand(), STRAT);
    expect(q.entryTs).toBe(ENTRY);
    expect(q.entrySnapshot?.capturedAt).toBe(ENTRY + 60);
    expect(q.makerPrice).toBeCloseTo(0.12, 10);
    expect(q.takerPrice).toBeCloseTo(0.18, 10);
  });

  it('floors the bid to the bucket tick (a maker never rounds up into a worse fill)', () => {
    const c = cand({ tickSize: 0.05, snapshots: [snap(ENTRY + 60, 0.13, 0.2)] });
    expect(entryQuote(c, STRAT).makerPrice).toBeCloseTo(0.1, 10); // 0.13 floored to the 0.05 grid
  });

  it('returns nulls when no snapshot reaches the entry instant', () => {
    const c = cand({ snapshots: [snap(ENTRY - 600, 0.12, 0.18)] }); // all before entry
    const q = entryQuote(c, STRAT);
    expect(q.entrySnapshot).toBeNull();
    expect(q.makerPrice).toBeNull();
    expect(q.takerPrice).toBeNull();
  });

  it('band-eligibility keys on the rested BID in [lo, hi) with a usable ask', () => {
    expect(bandEligible(cand(), STRAT)).toBe(true);
    expect(bandEligible(cand({ snapshots: [snap(ENTRY + 60, 0.08, 0.18)] }), STRAT)).toBe(false); // bid below band (dead zone)
    expect(bandEligible(cand({ snapshots: [snap(ENTRY + 60, 0.26, 0.3)] }), STRAT)).toBe(false); // bid above band
    expect(bandEligible(cand({ snapshots: [snap(ENTRY + 60, 0.12, null)] }), STRAT)).toBe(false); // no ask
  });
});

describe('selectBuys — band + breadth + bankroll cap', () => {
  it('keeps only the cheapest breadthPerCityDay buckets per city·day', () => {
    const day = '2026-06-10';
    const cands = [0.11, 0.12, 0.13, 0.14, 0.15].map((bid, i) =>
      cand({ bucketIdx: i, conditionId: `0x${i}`, targetDate: day, snapshots: [snap(ENTRY + 60, bid, bid + 0.06)] }),
    );
    const sel = selectBuys(cands, { ...STRAT, breadthPerCityDay: 3 });
    expect(sel).toHaveLength(3);
    expect(sel.map((s) => s.makerPrice).sort()).toEqual([0.11, 0.12, 0.13]); // the three cheapest in band
  });

  it('caps total daily stake at the bankroll, across cities, on the entry day', () => {
    // 25 distinct cities, each one in-band bucket, same resolution → same entry day.
    const cands = Array.from({ length: 25 }, (_, i) =>
      cand({ citySlug: `city-${String(i).padStart(2, '0')}`, conditionId: `0x${i}`, bucketIdx: 0 }),
    );
    const sel = selectBuys(cands, { ...STRAT, positionStakeUsd: 12, dailyBankrollCapUsd: 250 });
    const allocated = sel.filter((s) => s.allocated);
    expect(allocated).toHaveLength(20); // floor(250 / 12) = 20
    expect(allocated.reduce((a, s) => a + s.stakeUsd, 0)).toBe(240);
    expect(sel.filter((s) => !s.allocated)).toHaveLength(5); // the rest returned, but $0 — no silent cap
  });

  it('is deterministic (same input → byte-identical selection)', () => {
    const cands = Array.from({ length: 10 }, (_, i) =>
      cand({ citySlug: `c${i}`, conditionId: `0x${i}` }),
    );
    expect(JSON.stringify(selectBuys(cands, STRAT))).toBe(JSON.stringify(selectBuys(cands, STRAT)));
  });
});

describe('scoreBuy — the three price legs', () => {
  it('makerIdeal + taker fill and score hold-to-resolution P&L on a winner', () => {
    const s = scoreBuy(only(selectBuys([cand()], STRAT)), STRAT);
    // makerIdeal: $12 @ 0.12 → 100 shares; win → payoff 100, gross 88; fee 100·0.05·0.12·0.88=0.528.
    expect(s.makerIdeal.shares).toBeCloseTo(100, 6);
    expect(s.makerIdeal.grossPnlUsd).toBeCloseTo(88, 6);
    expect(s.makerIdeal.feeUsd).toBeCloseTo(0.528, 6);
    expect(s.makerIdeal.netPnlUsd).toBeCloseTo(88 - 0.528, 6);
    // taker: $12 @ 0.18 → 66.667 shares; win → gross 54.667.
    expect(s.taker.shares).toBeCloseTo(12 / 0.18, 6);
    expect(s.taker.grossPnlUsd).toBeCloseTo(12 / 0.18 - 12, 6);
    // the spread tax: the taker keeps far less of the same winner than the maker.
    expect(s.taker.grossPnlUsd).toBeLessThan(s.makerIdeal.grossPnlUsd);
  });

  it('a loser caps every leg loss at the stake', () => {
    const s = scoreBuy(only(selectBuys([cand({ bucketWon: false })], STRAT)), STRAT);
    expect(s.makerIdeal.grossPnlUsd).toBeCloseTo(-12, 6);
    expect(s.taker.grossPnlUsd).toBeCloseTo(-12, 6);
    // the entry fee is charged at purchase regardless of outcome (the copy-trade/maker-spray convention:
    // net = (won ? payoff : −stake) − fee), so a loser still pays it.
    expect(s.makerIdeal.feeUsd).toBeCloseTo(0.528, 6);
    expect(s.makerIdeal.netPnlUsd).toBeCloseTo(-12 - 0.528, 6);
  });

  it('makerRealistic does NOT fill when the book never touches the rested bid (deploys $0)', () => {
    const s = scoreBuy(only(selectBuys([cand()], STRAT)), STRAT);
    expect(s.makerRealistic.filled).toBe(false);
    expect(s.makerRealistic.stakeUsd).toBe(0);
    expect(s.makerRealistic.grossPnlUsd).toBe(0);
  });

  it('makerRealistic fills and scores when a post-entry ask touches the rested bid', () => {
    const s = scoreBuy(only(selectBuys([candFills()], STRAT)), STRAT);
    expect(s.makerRealistic.filled).toBe(true);
    expect(s.makerRealistic.grossPnlUsd).toBeCloseTo(88, 6); // filled at 0.12 like makerIdeal
  });

  it('a pending (unresolved) buy holds stake but crystallizes no P&L', () => {
    const s = scoreBuy(only(selectBuys([cand({ bucketWon: null })], STRAT)), STRAT);
    expect(s.resolved).toBe(false);
    expect(s.makerIdeal.grossPnlUsd).toBe(0);
    expect(s.taker.grossPnlUsd).toBe(0);
  });
});

describe('scoreLocked — the forward path (locked prices + a pre-decided fill flag)', () => {
  const locked = (over: Partial<LockedBuy> = {}): LockedBuy => ({
    conditionId: '0xc',
    eventId: 'E1',
    citySlug: 'kuala-lumpur',
    region: 'southeast-asia',
    targetDate: '2026-06-10',
    bucketIdx: 3,
    bucketLabel: '29–30°C',
    resolutionTs: RES,
    entryTs: ENTRY,
    entryDayUtc: '2026-06-08',
    makerPrice: 0.12,
    takerPrice: 0.18,
    stakeUsd: 12,
    feeRate: 0.05,
    bucketWon: true,
    makerRealisticFilled: true,
    ...over,
  });

  it('scores the three legs from locked prices identically to the backtest path on a winner', () => {
    const s = scoreLocked(locked(), STRAT);
    expect(s.makerIdeal.grossPnlUsd).toBeCloseTo(88, 6); // $12 @ 0.12 → 100 shares, win
    expect(s.taker.grossPnlUsd).toBeCloseTo(12 / 0.18 - 12, 6);
    expect(s.makerRealistic.filled).toBe(true);
    expect(s.makerRealistic.grossPnlUsd).toBeCloseTo(88, 6);
  });

  it('honors the pre-decided makerRealisticFilled=false (the rest never filled → $0 on that leg)', () => {
    const s = scoreLocked(locked({ makerRealisticFilled: false }), STRAT);
    expect(s.makerRealistic.filled).toBe(false);
    expect(s.makerRealistic.stakeUsd).toBe(0);
    expect(s.makerRealistic.grossPnlUsd).toBe(0);
    expect(s.makerIdeal.grossPnlUsd).toBeCloseTo(88, 6); // ideal still scores
  });

  it('a pending locked buy (bucketWon null) crystallizes no P&L', () => {
    const s = scoreLocked(locked({ bucketWon: null }), STRAT);
    expect(s.resolved).toBe(false);
    expect(s.makerIdeal.grossPnlUsd).toBe(0);
  });
});

describe('summarize — three curves + the tax deltas', () => {
  it('reports the spread tax (maker vs taker) as a positive ROI gap on winners', () => {
    const cands = Array.from({ length: 6 }, (_, i) => cand({ citySlug: `c${i}`, conditionId: `0x${i}` }));
    const sel = selectBuys(cands, STRAT);
    const scored = scoreBuys(sel, STRAT);
    const sum = summarize(scored, { nCandidates: cands.length, nBandEligible: cands.length });
    expect(sum.nAllocated).toBe(6);
    expect(sum.nResolved).toBe(6);
    expect(sum.makerIdeal.roiGross).toBeGreaterThan(sum.taker.roiGross);
    expect(sum.spreadTaxRoi).toBeCloseTo(sum.makerIdeal.roiGross - sum.taker.roiGross, 10);
  });

  it('reports the adverse-selection tax and the maker fill rate from the §12 model', () => {
    // mix: 3 that fill the rested bid, 3 that never fill → fill rate 0.5.
    const fills = Array.from({ length: 3 }, (_, i) => candFills({ citySlug: `f${i}`, conditionId: `0xf${i}` }));
    const nofill = Array.from({ length: 3 }, (_, i) => cand({ citySlug: `n${i}`, conditionId: `0xn${i}` }));
    const scored = scoreBuys(selectBuys([...fills, ...nofill], STRAT), STRAT);
    const sum = summarize(scored, { nCandidates: 6, nBandEligible: 6 });
    expect(sum.makerFillRate).toBeCloseTo(0.5, 10);
    // makerRealistic only earns on the filled half → less total gross than makerIdeal (all six).
    expect(sum.makerRealistic.grossPnlUsd).toBeLessThan(sum.makerIdeal.grossPnlUsd);
    expect(sum.adverseSelTaxRoi).toBeCloseTo(sum.makerIdeal.roiGross - sum.makerRealistic.roiGross, 10);
  });

  it('an empty selection yields a zeroed, NaN-safe summary (never throws)', () => {
    const sum = summarize([], { nCandidates: 0, nBandEligible: 0 });
    expect(sum.nAllocated).toBe(0);
    expect(Number.isNaN(sum.makerIdeal.roiGross)).toBe(true);
    expect(Number.isNaN(sum.spreadTaxRoi)).toBe(true);
  });
});

describe('legStats', () => {
  it('computes ROI, hit rate, and edge on the resolved, filled outcomes of a leg', () => {
    // two winners + two losers on makerIdeal: stake 4×12=48, gross 2·88 + 2·(−12) = 152.
    const cands = [
      cand({ citySlug: 'a', conditionId: '0xa', bucketWon: true }),
      cand({ citySlug: 'b', conditionId: '0xb', bucketWon: true }),
      cand({ citySlug: 'c', conditionId: '0xc', bucketWon: false }),
      cand({ citySlug: 'd', conditionId: '0xd', bucketWon: false }),
    ];
    const ls = legStats(scoreBuys(selectBuys(cands, STRAT), STRAT), 'makerIdeal');
    expect(ls.nResolved).toBe(4);
    expect(ls.wins).toBe(2);
    expect(ls.stakeUsd).toBeCloseTo(48, 6);
    expect(ls.grossPnlUsd).toBeCloseTo(2 * 88 - 2 * 12, 6);
    expect(ls.roiGross).toBeCloseTo((2 * 88 - 2 * 12) / 48, 6);
    expect(ls.hitRate).toBeCloseTo(0.5, 6);
  });
});

describe('dailyLedger', () => {
  it('accumulates per-resolution-day P&L per leg (gross by default)', () => {
    const cands = [
      cand({ citySlug: 'a', conditionId: '0xa', targetDate: '2026-06-10', bucketWon: true }),
      cand({ citySlug: 'b', conditionId: '0xb', targetDate: '2026-06-11', bucketWon: false }),
    ];
    const rows = dailyLedger(scoreBuys(selectBuys(cands, STRAT), STRAT));
    expect(rows.map((r) => r.date)).toEqual(['2026-06-10', '2026-06-11']);
    expect(rows[0]!.makerIdealPnl).toBeCloseTo(88, 6);
    expect(rows[0]!.makerIdealCum).toBeCloseTo(88, 6);
    expect(rows[1]!.makerIdealPnl).toBeCloseTo(-12, 6);
    expect(rows[1]!.makerIdealCum).toBeCloseTo(76, 6); // 88 − 12 running
  });

  it('net=true deducts fees from each leg', () => {
    const rows = dailyLedger(scoreBuys(selectBuys([cand()], STRAT), STRAT), { net: true });
    expect(rows[0]!.makerIdealPnl).toBeCloseTo(88 - 0.528, 6);
  });
});

describe('reconcilePure — the forward reconcile step (DB primary, Gamma fallback, §12 fill replay)', () => {
  const NOW = RES + 1000; // any instant after resolution; only stamps closedAtUtc
  const fwd = (over: Partial<ForwardPosition> = {}): ForwardPosition => ({
    conditionId: '0xc',
    eventId: 'E1',
    citySlug: 'kuala-lumpur',
    region: 'southeast-asia',
    targetDate: '2026-06-10',
    bucketIdx: 3,
    bucketLabel: '29–30°C',
    resolutionTs: RES,
    entryTs: ENTRY,
    entryDayUtc: '2026-06-08',
    entryCapturedTs: ENTRY,
    makerPrice: 0.12,
    takerPrice: 0.18,
    stakeUsd: 12,
    feeRate: 0.05,
    bucketWon: null,
    makerRealisticFilled: false,
    placedAtUtc: '2026-06-08T00:00:00.000Z',
    closedAtUtc: null,
    ...over,
  });

  it('closes a DB-resolved winner, replays the book for the maker fill, and does NOT mutate the input', () => {
    const open = [fwd({ eventId: 'E1', bucketIdx: 3, conditionId: '0xc' })];
    // post-entry ask 0.11 ≤ the 0.12 rested bid → ask-touch fill.
    const askSeries = new Map([['0xc', [snap(ENTRY + 60, 0.12, 0.18), snap(ENTRY + 3600, 0.1, 0.11)]]]);
    const { stillOpen, newlyClosed } = reconcilePure(open, { dbWinners: new Map([['E1', 3]]) }, askSeries, NOW);
    expect(stillOpen).toHaveLength(0);
    expect(newlyClosed).toHaveLength(1);
    expect(newlyClosed[0]!.bucketWon).toBe(true); // bucketIdx 3 === winner 3
    expect(newlyClosed[0]!.makerRealisticFilled).toBe(true);
    expect(newlyClosed[0]!.closedAtUtc).toBe(new Date(NOW * 1000).toISOString());
    expect(open[0]!.bucketWon).toBeNull(); // purity: input untouched
    expect(open[0]!.closedAtUtc).toBeNull();
  });

  it('closes a loser and leaves the maker rest unfilled when the book never touches the bid', () => {
    const open = [fwd({ eventId: 'E2', bucketIdx: 5, conditionId: '0xd' })];
    const askSeries = new Map([['0xd', [snap(ENTRY + 60, 0.12, 0.18), snap(ENTRY + 3600, 0.13, 0.19)]]]);
    const { newlyClosed } = reconcilePure(open, { dbWinners: new Map([['E2', 3]]) }, askSeries, NOW);
    expect(newlyClosed[0]!.bucketWon).toBe(false); // 5 !== 3
    expect(newlyClosed[0]!.makerRealisticFilled).toBe(false);
  });

  it('falls back to a Gamma Yes/No by conditionId when our DB has not resolved the event', () => {
    const open = [fwd({ eventId: 'E3', conditionId: '0xg', bucketIdx: 3 })];
    const askSeries = new Map([['0xg', [snap(ENTRY + 60, 0.12, 0.18)]]]);
    const won = reconcilePure(open, { dbWinners: new Map(), gammaWinners: new Map([['0xg', 'Yes']]) }, askSeries, NOW);
    expect(won.newlyClosed[0]!.bucketWon).toBe(true);
    const lost = reconcilePure(open, { dbWinners: new Map(), gammaWinners: new Map([['0xg', 'No']]) }, askSeries, NOW);
    expect(lost.newlyClosed[0]!.bucketWon).toBe(false);
  });

  it('keeps an unresolved position open (no DB winner, no Gamma)', () => {
    const open = [fwd({ eventId: 'E4', conditionId: '0xh' })];
    const { stillOpen, newlyClosed } = reconcilePure(open, { dbWinners: new Map() }, new Map(), NOW);
    expect(stillOpen).toHaveLength(1);
    expect(newlyClosed).toHaveLength(0);
  });

  it('prefers the DB winner over Gamma when both are present', () => {
    const open = [fwd({ eventId: 'E5', conditionId: '0xi', bucketIdx: 3 })];
    // DB says winner=5 (we lose); Gamma says Yes (we win) — DB is primary.
    const { newlyClosed } = reconcilePure(
      open,
      { dbWinners: new Map([['E5', 5]]), gammaWinners: new Map([['0xi', 'Yes']]) },
      new Map(),
      NOW,
    );
    expect(newlyClosed[0]!.bucketWon).toBe(false);
  });

  it('falls back to entryTs for the fill window when entryCapturedTs is non-finite (legacy/pre-0056 state)', () => {
    // The only ask ≤ the rested 0.12 bid sits at ENTRY+30 (inside the entryTs window). A NaN entryCapturedTs
    // must fall back to entryTs — NOT filter on `>= NaN`, which would drop every snapshot → a wrongly-unfilled rest.
    const open = [fwd({ eventId: 'L', bucketIdx: 3, conditionId: '0xL', entryCapturedTs: Number.NaN })];
    const askSeries = new Map([['0xL', [snap(ENTRY + 30, 0.1, 0.1)]]]);
    const { newlyClosed } = reconcilePure(open, { dbWinners: new Map([['L', 3]]) }, askSeries, NOW);
    expect(newlyClosed[0]!.makerRealisticFilled).toBe(true);
  });
});

describe('placeBuysPure — the forward place step (live filter + §15 playbook + dedupe)', () => {
  const NOW_PLACE = RES - 3600; // 1h before resolution: entry instant (36h prior) has arrived, not yet resolved

  it('opens a live, unresolved, band-eligible candidate with prices LOCKED at the placement book', () => {
    const c = cand({ bucketWon: null, eventId: 'EV', bucketIdx: 3, conditionId: '0xc' });
    const opened = placeBuysPure([c], new Set(), STRAT, NOW_PLACE);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.eventId).toBe('EV');
    expect(opened[0]!.bucketWon).toBeNull();
    expect(opened[0]!.makerRealisticFilled).toBe(false);
    expect(opened[0]!.entryCapturedTs).toBe(ENTRY + 60); // the placement snapshot's capturedAt
    expect(opened[0]!.makerPrice).toBeCloseTo(0.12, 6);
    expect(opened[0]!.takerPrice).toBeCloseTo(0.18, 6);
    expect(opened[0]!.placedAtUtc).toBe(new Date(NOW_PLACE * 1000).toISOString());
  });

  it('skips a candidate already placed (dedupe by event|bucket)', () => {
    const c = cand({ bucketWon: null, eventId: 'EV', bucketIdx: 3 });
    expect(placeBuysPure([c], new Set(['EV|3']), STRAT, NOW_PLACE)).toHaveLength(0);
  });

  it('skips an already-resolved candidate even when otherwise live', () => {
    const resolved = cand({ bucketWon: true, eventId: 'R', bucketIdx: 0 });
    expect(placeBuysPure([resolved], new Set(), STRAT, NOW_PLACE)).toHaveLength(0);
  });

  it('skips a candidate whose 36h entry instant has not arrived yet', () => {
    const c = cand({ bucketWon: null, eventId: 'F', bucketIdx: 1 });
    expect(placeBuysPure([c], new Set(), STRAT, ENTRY - 7200)).toHaveLength(0);
  });

  it('opens only the bankroll-allocated buys (capped buys are not opened)', () => {
    const cands = Array.from({ length: 25 }, (_, i) =>
      cand({ citySlug: `c${i}`, conditionId: `0x${i}`, eventId: `E${i}`, bucketIdx: 0, bucketWon: null }),
    );
    const opened = placeBuysPure(cands, new Set(), { ...STRAT, positionStakeUsd: 12, dailyBankrollCapUsd: 250 }, NOW_PLACE);
    expect(opened).toHaveLength(20); // floor(250 / 12)
  });

  it('falls back to strat.feeRate when a candidate carries feeRate 0 (a null-fee bucket)', () => {
    const opened = placeBuysPure([cand({ bucketWon: null, eventId: 'F0', bucketIdx: 3, feeRate: 0 })], new Set(), STRAT, NOW_PLACE);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.feeRate).toBe(STRAT.feeRate); // 0.05, not the candidate's 0
  });
});

describe('rankCitiesByRoi', () => {
  it('ranks cities by ROI and drops those below the min-n floor', () => {
    // KL: 10 winners (high ROI). London: 10 losers (negative ROI). Tokyo: 2 winners (below min-n → dropped).
    const kl = Array.from({ length: 10 }, (_, i) =>
      cand({ citySlug: 'kuala-lumpur', region: 'southeast-asia', conditionId: `0xk${i}`, targetDate: `2026-06-${10 + i}`, bucketWon: true }),
    );
    const lon = Array.from({ length: 10 }, (_, i) =>
      cand({ citySlug: 'london', region: 'europe-west', conditionId: `0xl${i}`, targetDate: `2026-06-${10 + i}`, bucketWon: false }),
    );
    const tok = Array.from({ length: 2 }, (_, i) =>
      cand({ citySlug: 'tokyo', region: 'east-asia', conditionId: `0xt${i}`, targetDate: `2026-06-${10 + i}`, bucketWon: true }),
    );
    const ranked = rankCitiesByRoi(scoreBuys(selectBuys([...kl, ...lon, ...tok], STRAT), STRAT), { minResolved: 8 });
    expect(ranked.map((r) => r.city)).toEqual(['kuala-lumpur', 'london']); // tokyo dropped (n=2)
    expect(ranked[0]!.roiGross).toBeGreaterThan(ranked[1]!.roiGross);
    expect(ranked[1]!.roiGross).toBeLessThan(0); // all-losers city bleeds
  });
});
