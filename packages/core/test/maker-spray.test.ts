/**
 * Tests for core/sim/maker-spray — the PURE maker-spray feasibility analytics (the maker twin of
 * copy-trade). Covers restPrice (all 3 rules, tick-rounded DOWN), the NOVEL maker fill model
 * (simulateFill ask_touch + last_trade, known-fill / known-no-fill series), makerNetEvPerDollar
 * (win/loss/fee/rebate), makerEntry (sole entry-snapshot owner + cheap gate), simulateSpray (fill
 * rate, the R-4 known-loser adverse-selection diagnostic, Brier-vs-market, per-station REAL CIs, the
 * zero-skill-MC calibration), makerSprayVerdict (pass/fail incl. NaN-CI → false), and byte-identical
 * determinism. All pure — no network, no DB. Deterministic (seed 42), []/NaN-safe.
 */
import { describe, expect, it } from 'vitest';
import {
  type FillSnapshot,
  type MakerSprayReport,
  type RestingBid,
  crossValidateFillModel,
  makerEntry,
  makerNetEvPerDollar,
  makerSprayVerdict,
  restPrice,
  simulateFill,
  simulateSpray,
} from '../src/sim/maker-spray.ts';

const snap = (
  capturedAt: number,
  bid: number | null,
  ask: number | null,
  lastTrade: number | null = null,
): FillSnapshot => ({
  capturedAt,
  bid,
  ask,
  mid: bid != null && ask != null ? (bid + ask) / 2 : null,
  lastTrade,
});

/** A resting bid factory. Default: a CHEAP bucket (bid 0.08) with a post-entry series that DOES fill. */
function bid(over: Partial<RestingBid> = {}): RestingBid {
  return {
    conditionId: '0xc',
    bucketIdx: 3,
    calibratedP: 0.18,
    marketProbAtEntry: 0.12,
    bucketWon: true,
    feeRate: 0.05,
    tickSize: 0.01,
    citySlug: 'amsterdam',
    station: 'EHAM',
    tzOffsetHours: 2,
    targetDate: '2026-06-22',
    resolutionTs: 100000,
    entryTs: 90000,
    snapshots: [
      snap(89000, 0.07, 0.11, 0.1), // pre-entry (before entryTs 90000)
      snap(91000, 0.08, 0.12, 0.11), // entry snapshot (first ≥ 90000); bid 0.08 → restPx 0.08
      snap(95000, 0.06, 0.08, 0.09), // ask 0.08 ≤ 0.08 → ask_touch FILLS here
      snap(99000, 0.05, 0.07, 0.06), // last
    ],
    ...over,
  };
}

describe('restPrice (all 3 rules, tick-rounded DOWN, validated (0,1])', () => {
  const opts = { tickSize: 0.01, askOffset: 0.07 };
  it("'bid' rests at best_bid, tick-rounded down", () => {
    expect(restPrice(snap(0, 0.083, 0.17), 'bid', opts)).toBeCloseTo(0.08, 9);
  });
  it("'bid_plus_tick' rests one tick above the bid", () => {
    expect(restPrice(snap(0, 0.08, 0.17), 'bid_plus_tick', opts)).toBeCloseTo(0.09, 9);
  });
  it("'ask_offset' rests at ask − offset, rounded down", () => {
    // ask 0.20 − 0.07 = 0.13
    expect(restPrice(snap(0, 0.1, 0.2), 'ask_offset', opts)).toBeCloseTo(0.13, 9);
  });
  it('rounds DOWN (a maker never rounds up into a worse fill)', () => {
    // bid 0.137 → floor to 0.13 on a 0.01 tick
    expect(restPrice(snap(0, 0.137, 0.3), 'bid', opts)).toBeCloseTo(0.13, 9);
  });
  it('null when the needed price is missing/unusable; never throws', () => {
    expect(restPrice(snap(0, null, 0.2), 'bid', opts)).toBeNull();
    expect(restPrice(snap(0, 0.1, null), 'ask_offset', opts)).toBeNull();
    // ask_offset that floors to ≤ 0 → null
    expect(restPrice(snap(0, 0.1, 0.05), 'ask_offset', opts)).toBeNull();
    // bid > 1 is not a usable price
    expect(restPrice(snap(0, 1.5, 0.2), 'bid', opts)).toBeNull();
  });
});

describe('simulateFill (the NOVEL maker fill model)', () => {
  it('ask_touch — FILLS iff min(best_ask after entry) ≤ restPx; reports minAskAfter + fillIdx', () => {
    const series = [snap(0, 0.1, 0.14), snap(1, 0.09, 0.11), snap(2, 0.08, 0.09), snap(3, 0.07, 0.085)];
    // restPx 0.09 → ask 0.09 at idx 2 ≤ 0.09 → filled at idx 2; min ask over series = 0.085
    const r = simulateFill(0.09, series, 'ask_touch');
    expect(r.filled).toBe(true);
    expect(r.fillIdx).toBe(2);
    expect(r.minAskAfter).toBeCloseTo(0.085, 9);
  });
  it('ask_touch — known NO-FILL series (ask never drops to the rested bid)', () => {
    const series = [snap(0, 0.1, 0.14), snap(1, 0.11, 0.15), snap(2, 0.12, 0.16)];
    const r = simulateFill(0.09, series, 'ask_touch'); // min ask 0.14 > 0.09
    expect(r.filled).toBe(false);
    expect(r.fillIdx).toBeNull();
    expect(r.minAskAfter).toBeCloseTo(0.14, 9);
  });
  it('last_trade — operates on FillSnapshot.lastTrade (not the imported BucketSnapshot)', () => {
    const series = [snap(0, 0.1, 0.2, 0.15), snap(1, 0.1, 0.2, 0.08), snap(2, 0.1, 0.2, 0.2)];
    // restPx 0.09 → lastTrade 0.08 at idx 1 ≤ 0.09 → filled
    const r = simulateFill(0.09, series, 'last_trade');
    expect(r.filled).toBe(true);
    expect(r.fillIdx).toBe(1);
    // a series with NO lastTrade ≤ restPx does not fill under last_trade even if the ask would
    const noFill = simulateFill(0.09, [snap(0, 0.1, 0.08, 0.5)], 'last_trade');
    expect(noFill.filled).toBe(false);
  });
  it('empty / non-finite postEntry → not filled, null diagnostics; never throws', () => {
    expect(simulateFill(0.09, [], 'ask_touch')).toEqual({
      filled: false,
      minAskAfter: null,
      fillIdx: null,
    });
    // non-finite asks are skipped, not crashing
    const r = simulateFill(0.09, [snap(0, null, null), snap(1, 0.1, 0.05)], 'ask_touch');
    expect(r.filled).toBe(true);
    expect(simulateFill(NaN, [snap(0, 0.1, 0.05)], 'ask_touch').filled).toBe(false);
  });
});

describe('makerNetEvPerDollar (NEW fn — win/loss/fee/rebate)', () => {
  it('win: shares·(1−restPx) minus the canonical taker fee', () => {
    // restPx 0.1 → shares 10; fee = 10·0.05·0.1·0.9 = 0.045; win = 10·0.9 = 9 → 8.955
    expect(makerNetEvPerDollar(0.1, true, 0.05, 0)).toBeCloseTo(8.955, 6);
  });
  it('loss: −1 minus the fee', () => {
    expect(makerNetEvPerDollar(0.1, false, 0.05, 0)).toBeCloseTo(-1.045, 6);
  });
  it('rebate offsets the fee but never goes negative (max(0, fee − rebate·shares))', () => {
    // shares 10; fee 0.045; rebate 0.01/share → rebate·shares 0.1 > fee → netFee clamped to 0
    expect(makerNetEvPerDollar(0.1, true, 0.05, 0.01)).toBeCloseTo(9, 9); // win 9, no fee
    // a small rebate only partially offsets
    expect(makerNetEvPerDollar(0.1, true, 0.05, 0.001)).toBeCloseTo(9 - (0.045 - 0.01), 6);
  });
  it('fee-free reduces to the gross maker P&L', () => {
    expect(makerNetEvPerDollar(0.25, true, 0, 0)).toBeCloseTo(3, 9); // 1/0.25 − 1
    expect(makerNetEvPerDollar(0.5, false, 0, 0)).toBeCloseTo(-1, 9);
  });
  it('NaN on a degenerate restPx', () => {
    expect(makerNetEvPerDollar(0, true, 0.05, 0)).toBeNaN();
    expect(makerNetEvPerDollar(1.5, true, 0.05, 0)).toBeNaN();
    expect(makerNetEvPerDollar(NaN, true, 0.05, 0)).toBeNaN();
  });
});

describe('makerEntry (sole entry-snapshot owner; cheap gate; grades only when filled)', () => {
  it('resolves the entry snapshot (first ≥ entryTs), prices, fills, grades', () => {
    const e = makerEntry(bid());
    expect(e.entrySnapshot?.capturedAt).toBe(91000); // first ≥ 90000
    expect(e.restPx).toBeCloseTo(0.08, 9); // bid 0.08
    expect(e.eligibleCheap).toBe(true);
    expect(e.filled).toBe(true); // ask 0.08 ≤ 0.08 at 95000
    expect(e.won).toBe(true);
    expect(e.netEvFilled).toBeCloseTo(makerNetEvPerDollar(0.08, true, 0.05, 0), 9);
    expect(e.edgeFilled).toBeCloseTo(1 - 0.08, 9);
  });
  it('drops to ineligible when restPx ≥ cheapMax', () => {
    // bid 0.40 → restPx 0.40 ≥ 0.25 default cheapMax
    const e = makerEntry(bid({ snapshots: [snap(91000, 0.4, 0.45), snap(95000, 0.38, 0.4)], entryTs: 90000 }));
    expect(e.restPx).toBeCloseTo(0.4, 9);
    expect(e.eligibleCheap).toBe(false);
    expect(e.filled).toBe(false);
    expect(e.netEvFilled).toBeNaN();
  });
  it('no usable entry book / no snapshot at-or-after entryTs → null restPx, ineligible, NaN EV', () => {
    const e = makerEntry(bid({ snapshots: [snap(89000, 0.08, 0.12)], entryTs: 90000 })); // only pre-entry
    expect(e.entrySnapshot).toBeNull();
    expect(e.restPx).toBeNull();
    expect(e.eligibleCheap).toBe(false);
    expect(e.netEvFilled).toBeNaN();
  });
  it('eligible-but-unfilled when the ask never touches the rested bid → NaN EV (only filled graded)', () => {
    const e = makerEntry(
      bid({ snapshots: [snap(91000, 0.08, 0.12), snap(95000, 0.085, 0.13), snap(99000, 0.09, 0.14)] }),
    );
    expect(e.eligibleCheap).toBe(true);
    expect(e.filled).toBe(false);
    expect(e.netEvFilled).toBeNaN();
    expect(e.edgeFilled).toBeNaN();
  });
});

describe('select: forecast vs all (the selection axis — does OUR forecast pick the cheap buckets)', () => {
  it("'all' (default) rests on every cheap bucket regardless of calibratedP", () => {
    // calibratedP 0.02 < restPx 0.08 — our forecast does NOT like it, but 'all' rests anyway.
    expect(makerEntry(bid({ calibratedP: 0.02 }), { select: 'all' }).eligibleCheap).toBe(true);
    expect(makerEntry(bid({ calibratedP: 0.02 })).eligibleCheap).toBe(true); // default === 'all'
  });
  it("'forecast' rests ONLY where calibratedP > restPx (the maker cheap-longshot rule)", () => {
    // restPx = 0.08 (bid). calibratedP 0.02 ≤ 0.08 → our forecast says NOT underpriced → excluded.
    const out = makerEntry(bid({ calibratedP: 0.02 }), { select: 'forecast' });
    expect(out.eligibleCheap).toBe(false);
    expect(out.filled).toBe(false);
    expect(out.netEvFilled).toBeNaN();
    // calibratedP 0.18 > 0.08 → our forecast says underpriced → included (and fills + grades).
    const inn = makerEntry(bid({ calibratedP: 0.18 }), { select: 'forecast' });
    expect(inn.eligibleCheap).toBe(true);
    expect(inn.filled).toBe(true);
  });
  it("'forecast' shrinks the eligible set in simulateSpray vs 'all'", () => {
    const bids = [
      bid({ conditionId: 'liked', calibratedP: 0.2 }), // > restPx 0.08 → in BOTH modes
      bid({ conditionId: 'disliked', calibratedP: 0.03 }), // ≤ restPx 0.08 → only in 'all'
    ];
    expect(simulateSpray(bids, { select: 'all', mcIters: 20 }).nCheapEligible).toBe(2);
    expect(simulateSpray(bids, { select: 'forecast', mcIters: 20 }).nCheapEligible).toBe(1);
  });
});

describe('simulateSpray — aggregation', () => {
  it('fill rate, filled fee-net EV CI, per-station REAL CIs', () => {
    const bids = [
      bid({ conditionId: 'a', station: 'EHAM', bucketWon: true }),
      bid({ conditionId: 'b', station: 'EHAM', bucketWon: false }),
      bid({ conditionId: 'c', station: 'EGLC', bucketWon: true }),
    ];
    const r = simulateSpray(bids, { mcIters: 50 });
    expect(r.nCandidates).toBe(3);
    expect(r.nCheapEligible).toBe(3);
    expect(r.nFilled).toBe(3); // all three fill (ask 0.08 ≤ 0.08)
    expect(r.fillRate).toBeCloseTo(1, 9);
    expect(r.filledNetEv.n).toBe(3);
    expect(Number.isFinite(r.filledNetEv.ev)).toBe(true);
    // per-station are real CIs the verdict can read
    expect(r.perStation.get('EHAM')?.nFilled).toBe(2);
    expect(r.perStation.get('EGLC')?.nFilled).toBe(1);
    expect(Number.isFinite(r.perStation.get('EHAM')!.filledNetEv.evCiLo)).toBe(true);
  });

  it('R-4: known-loser adverse selection — only the filled bid is a LOSER → filledHit=0, allHit>0', () => {
    // Two eligible bids; only the LOSER fills (its ask drops to the bid), the WINNER never fills.
    const loserFills = bid({
      conditionId: 'loser',
      bucketWon: false,
      snapshots: [snap(91000, 0.08, 0.12), snap(95000, 0.06, 0.08)], // ask 0.08 ≤ restPx 0.08 → FILLS
    });
    const winnerNoFill = bid({
      conditionId: 'winner',
      bucketWon: true,
      snapshots: [snap(91000, 0.08, 0.12), snap(95000, 0.085, 0.13)], // ask never ≤ 0.08 → NO fill
    });
    const r = simulateSpray([loserFills, winnerNoFill], { mcIters: 50 });
    expect(r.nCheapEligible).toBe(2);
    expect(r.nFilled).toBe(1);
    expect(r.adverseSelection.filledHitRate).toBe(0); // the only fill is a loser
    expect(r.adverseSelection.allEligibleHitRate).toBeCloseTo(0.5, 9); // 1 of 2 eligible won
    expect(r.adverseSelection.asConfirmed).toBe(true); // 0 < 0.5
  });

  it('brierVsMarket computed against market-implied-at-entry (lower is better)', () => {
    // our calibratedP 0.9 on a WINNER vs market 0.5 → our Brier far lower (we are sharper).
    const sharp = bid({ calibratedP: 0.9, marketProbAtEntry: 0.5, bucketWon: true });
    const r = simulateSpray([sharp], { mcIters: 10 });
    expect(r.brierVsMarket.nEvents).toBe(1);
    // ours = (0.9−1)²+(0.1−0)² = 0.02 ; market = (0.5−1)²+(0.5−0)² = 0.5
    expect(r.brierVsMarket.ours).toBeCloseTo(0.02, 9);
    expect(r.brierVsMarket.market).toBeCloseTo(0.5, 9);
    expect(r.brierVsMarket.delta).toBeLessThan(0); // ours sharper
  });

  it('empty / all-ineligible → zeroed report, never throws', () => {
    const empty = simulateSpray([]);
    expect(empty.nCandidates).toBe(0);
    expect(empty.nCheapEligible).toBe(0);
    expect(empty.nFilled).toBe(0);
    expect(empty.fillRate).toBeNaN();
    expect(empty.filledNetEv.ev).toBeNaN();
    expect(empty.zeroSkillMc.pPass).toBeNaN();
    expect(empty.perStation.size).toBe(0);

    // all-ineligible (restPx ≥ cheapMax) also zeroes the filled set without throwing
    const pricey = simulateSpray([
      bid({ snapshots: [snap(91000, 0.5, 0.55), snap(95000, 0.48, 0.5)], entryTs: 90000 }),
    ]);
    expect(pricey.nCheapEligible).toBe(0);
    expect(pricey.filledNetEv.ev).toBeNaN();
  });
});

describe('zero-skill Monte-Carlo calibration', () => {
  it('pure-noise input (no price↔outcome link, true EV ≈ 0) → modest P(PASS)', () => {
    // The gate is "pooled filled fee-net EV CI > 0". A calibrated false-positive probe needs a TRUE EV ≈ 0
    // AND a non-degenerate shuffle: if every fill shared one price, shuffling `won` within a station would
    // leave the pooled mean unchanged (it depends only on the win COUNT), giving the MC zero variance. So
    // the probe must SPREAD prices across bids. Here restPx ranges 0.10→0.45 and a fair coin (50% win,
    // independent of price) sets the outcomes — there is NO real edge, but a win at a cheap price pays far
    // more than at a dear one, so reassigning which bucket won genuinely moves the pooled EV. We set the
    // price to the breakeven so the unconditional EV centres near 0; the CI>0 gate should then fire on well
    // under half the within-station shuffles. (A cheap price with a 50% win rate is genuinely +EV — real
    // cheap-bucket edge, NOT noise — which is why breakeven-priced, price-independent outcomes are the
    // right probe.)
    const stations = ['EHAM', 'EGLC', 'KJFK', 'RJTT'];
    const bids: RestingBid[] = [];
    const rng = (() => {
      let a = 12345 >>> 0;
      return () => ((a = (a * 1103515245 + 12345) >>> 0) / 4294967296);
    })();
    for (let i = 0; i < 80; i++) {
      // a price in [0.10, 0.45], the rested bid; the entry book carries that bid + a touching ask
      const px = 0.1 + (i % 8) * 0.05;
      // win iff the fair coin lands below px → the win RATE equals the price ⇒ unconditional EV ≈ 0,
      // and outcomes are independent of nothing exploitable (no skill, just calibrated frequency).
      const won = rng() < px;
      bids.push(
        bid({
          conditionId: `n${i}`,
          station: stations[i % stations.length]!,
          bucketWon: won,
          feeRate: 0, // isolate from the fee so the centring is exact
          snapshots: [
            snap(91000, px, px + 0.04),
            // ask dips a clear tick below the rested px → fills (kept off the float boundary)
            snap(95000, Math.max(0.01, px - 0.03), Math.max(0.02, px - 0.02)),
          ],
        }),
      );
    }
    const r = simulateSpray(bids, { mcIters: 500, cheapMax: 0.5 });
    expect(r.nFilled).toBeGreaterThan(30); // a substantial filled set drives the MC
    expect(Number.isFinite(r.zeroSkillMc.pPass)).toBe(true);
    expect(r.zeroSkillMc.iters).toBe(500);
    // a true-zero-EV, no-skill outcome set should NOT pass the CI>0 gate often.
    expect(r.zeroSkillMc.pPass).toBeLessThan(0.5);
  });
});

describe('makerSprayVerdict (BINDING pooled gate; reads per-station; NaN→false)', () => {
  const mkReport = (
    ev: number,
    lo: number,
    hi: number,
    perStation: Map<string, { filledNetEv: { ev: number; evCiLo: number; evCiHi: number; n: number }; nFilled: number }> = new Map(),
    asConfirmed = true,
    pPass = 0.01,
  ): MakerSprayReport =>
    ({
      filledNetEv: { ev, evCiLo: lo, evCiHi: hi, n: 30 },
      perStation,
      adverseSelection: { asConfirmed } as MakerSprayReport['adverseSelection'],
      zeroSkillMc: { pPass, iters: 1000 },
    }) as unknown as MakerSprayReport;

  it('PASS when the POOLED CI lower bound clears 0; clearsMargin when EV ≥ threshold', () => {
    const v = makerSprayVerdict(mkReport(0.05, 0.01, 0.09));
    expect(v.pass).toBe(true);
    expect(v.clearsMargin).toBe(true); // 0.05 ≥ 0.02
    expect(v.summary).toMatch(/PASS/);
  });
  it('PASS-but-below-margin when the CI clears 0 but EV < threshold', () => {
    const v = makerSprayVerdict(mkReport(0.01, 0.001, 0.02));
    expect(v.pass).toBe(true);
    expect(v.clearsMargin).toBe(false);
  });
  it('FAIL when the CI straddles 0', () => {
    const v = makerSprayVerdict(mkReport(0.02, -0.01, 0.05));
    expect(v.pass).toBe(false);
    expect(v.summary).toMatch(/market efficient/);
  });
  it('NaN CI → pass:false (insufficient evidence fails the gate)', () => {
    expect(makerSprayVerdict(mkReport(NaN, NaN, NaN)).pass).toBe(false);
  });
  it('reads per-station evCiLo to COUNT clearing stations (descriptor, never re-stats); ehamOnly', () => {
    const per = new Map([
      ['EHAM', { filledNetEv: { ev: 0.04, evCiLo: 0.01, evCiHi: 0.08, n: 25 }, nFilled: 25 }],
      ['EGLC', { filledNetEv: { ev: 0.0, evCiLo: -0.03, evCiHi: 0.03, n: 22 }, nFilled: 22 }],
    ]);
    const v = makerSprayVerdict(mkReport(0.03, 0.005, 0.06, per));
    expect(v.stationsClearing).toEqual(['EHAM']); // only EHAM's own CI clears
    expect(v.ehamOnly).toBe(true);
  });
  it('surfaces asSuspect (AS not confirmed) and the zero-skill P(PASS)', () => {
    const v = makerSprayVerdict(mkReport(0.05, 0.01, 0.09, new Map(), /*asConfirmed*/ false, /*pPass*/ 0.08));
    expect(v.asSuspect).toBe(true);
    expect(v.zeroSkillPPass).toBeCloseTo(0.08, 9);
  });
});

describe('crossValidateFillModel (F-008)', () => {
  it('agreement = fraction of real fills our model predicts filled; empty → NaN/0', () => {
    const fills = [
      { restPx: 0.1, postEntry: [snap(0, 0.1, 0.09)] }, // ask 0.09 ≤ 0.1 → predicted filled
      { restPx: 0.1, postEntry: [snap(0, 0.1, 0.2)] }, // ask 0.2 > 0.1 → predicted NOT filled
    ];
    expect(crossValidateFillModel(fills, 'ask_touch')).toEqual({ agreementRate: 0.5, n: 2 });
    expect(crossValidateFillModel([], 'ask_touch')).toEqual({ agreementRate: NaN, n: 0 });
  });
});

describe('determinism — two runs byte-identical (seeded mulberry32)', () => {
  it('the same input produces a byte-identical serialized report', () => {
    const stations = ['EHAM', 'EGLC', 'KJFK'];
    const bids: RestingBid[] = [];
    for (let i = 0; i < 30; i++) {
      bids.push(
        bid({
          conditionId: `d${i}`,
          station: stations[i % stations.length]!,
          bucketWon: i % 3 !== 0,
          snapshots: [snap(91000, 0.08, 0.12), snap(95000, 0.06, 0.08)],
        }),
      );
    }
    const serialize = (r: MakerSprayReport): string =>
      JSON.stringify({
        ...r,
        perStation: [...r.perStation.entries()].sort(([a], [b]) => a.localeCompare(b)),
      });
    const a = simulateSpray(bids, { mcIters: 200 });
    const b = simulateSpray(bids, { mcIters: 200 });
    expect(serialize(a)).toBe(serialize(b));
  });
});
