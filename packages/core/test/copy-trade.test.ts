/**
 * Tests for core/sim/copy-trade — the copy-trade (fill-mirror) feasibility analytics. Covers the
 * snapshot lookups, the canonical fee-net EV, the per-fill follower simulation (entry selection,
 * staleness drop, maker/taker character, drift sign), the aggregate report's filtering + reuse of
 * armEdgeStats, and the pre-registered verdict logic. All pure — no network, no DB.
 */
import { describe, expect, it } from 'vitest';
import {
  type BucketSnapshot,
  type MirrorFill,
  copyTradeVerdict,
  followerEntry,
  netEvPerDollar,
  simulateMirror,
  snapshotAtOrAfter,
  snapshotAtOrBefore,
} from '../src/sim/copy-trade.ts';

const snap = (capturedAt: number, bid: number | null, ask: number | null): BucketSnapshot => ({
  capturedAt,
  bid,
  ask,
  mid: bid != null && ask != null ? (bid + ask) / 2 : null,
});

function fill(over: Partial<MirrorFill> = {}): MirrorFill {
  return {
    conditionId: '0xc',
    outcome: 'Yes',
    fillPrice: 0.09,
    sizeShares: 100,
    usdcSize: 9,
    timestamp: 1000,
    citySlug: 'amsterdam',
    targetDate: '2026-06-22',
    outcomeWon: true,
    feeRate: 0.05,
    snapshots: [
      snap(900, 0.08, 0.12), // mid 0.10 — contemporaneous at/before fill
      snap(1200, null, null),
      snap(1500, 0.13, 0.17), // mid 0.15 — first post-(fill+lag) book with an ask
      snap(2000, 0.28, 0.32), // mid 0.30 — last (the drift target)
    ],
    ...over,
  };
}

describe('snapshot lookups', () => {
  const s = [snap(100, 0.1, 0.2), snap(200, 0.1, 0.2), snap(300, 0.1, 0.2)];
  it('snapshotAtOrBefore returns the latest ≤ t', () => {
    expect(snapshotAtOrBefore(s, 250)?.capturedAt).toBe(200);
    expect(snapshotAtOrBefore(s, 100)?.capturedAt).toBe(100);
    expect(snapshotAtOrBefore(s, 50)).toBeNull();
  });
  it('snapshotAtOrAfter returns the earliest ≥ t', () => {
    expect(snapshotAtOrAfter(s, 150)?.capturedAt).toBe(200);
    expect(snapshotAtOrAfter(s, 300)?.capturedAt).toBe(300);
    expect(snapshotAtOrAfter(s, 350)).toBeNull();
  });
});

describe('netEvPerDollar (canonical takerFeeTotal fee math)', () => {
  it('matches the worked fee on a 0.10 longshot win', () => {
    // shares=10; fee = 10·0.05·0.1·0.9 = 0.045; win = 10·0.9 = 9 → 8.955
    expect(netEvPerDollar(0.1, true, 0.05)).toBeCloseTo(8.955, 6);
  });
  it('loss returns −1 minus the fee', () => {
    expect(netEvPerDollar(0.1, false, 0.05)).toBeCloseTo(-1.045, 6);
  });
  it('fee-free reduces to 1/ask−1', () => {
    expect(netEvPerDollar(0.5, true, 0)).toBeCloseTo(1, 9);
    expect(netEvPerDollar(0.25, true, 0)).toBeCloseTo(3, 9);
  });
  it('NaN on a degenerate ask', () => {
    expect(netEvPerDollar(0, true, 0.05)).toBeNaN();
    expect(netEvPerDollar(1.5, true, 0.05)).toBeNaN();
  });
});

describe('followerEntry', () => {
  it('takes the first post-(fill+lag) ask and computes staleness', () => {
    const e = followerEntry(fill(), { detectionLagSec: 300 }); // fill+lag = 1300
    expect(e.entrySnapshot?.capturedAt).toBe(1500); // 1200 has no ask → 1500
    expect(e.entryAsk).toBe(0.17);
    expect(e.entryStalenessSec).toBe(200); // 1500 − 1300
  });
  it('drops the entry when the only post-lag book is staler than the cap', () => {
    const e = followerEntry(fill(), { detectionLagSec: 300, maxEntryStalenessSec: 100 });
    expect(e.entryAsk).toBeNull(); // 1500 is 200s away > 100 cap
  });
  it('reads the contemporaneous (≤fill) ask as the optimistic bound', () => {
    const e = followerEntry(fill());
    expect(e.fillMid).toBeCloseTo(0.1, 9);
    // contemporaneous ask 0.12 win, fee-net: shares=8.333, fee=8.333·0.05·0.12·0.88=0.044, win=8.333·0.88=7.333→7.289
    expect(e.netEvTakerContemporaneous).toBeCloseTo(netEvPerDollar(0.12, true, 0.05), 9);
  });
  it('flags badatmath as a maker (fill below the mid)', () => {
    const e = followerEntry(fill({ fillPrice: 0.09 })); // mid 0.10
    expect(e.fillVsMid).toBeCloseTo(-0.01, 9);
  });
  it('signs the drift toward the bought outcome (Yes up, No down)', () => {
    const yes = followerEntry(fill({ outcome: 'Yes' })); // mid 0.10 → 0.30
    expect(yes.driftToward).toBeCloseTo(0.2, 9);
    const no = followerEntry(fill({ outcome: 'No' }));
    expect(no.driftToward).toBeCloseTo(-0.2, 9);
  });
  it('is total when there are no snapshots', () => {
    const e = followerEntry(fill({ snapshots: [] }));
    expect(e.entryAsk).toBeNull();
    expect(e.fillMid).toBeNull();
    expect(e.netEvTaker).toBeNaN();
  });
});

describe('simulateMirror', () => {
  it('filters to cheap + resolved + has-snapshots and scores the usable set', () => {
    const fills = [
      fill({ conditionId: 'a', fillPrice: 0.09, outcomeWon: true }), // cheap, resolved, usable
      fill({ conditionId: 'b', fillPrice: 0.6, outcomeWon: true }), // not cheap → excluded
      fill({ conditionId: 'c', fillPrice: 0.1, outcomeWon: null }), // unresolved → excluded
      fill({ conditionId: 'd', fillPrice: 0.1, outcomeWon: false, snapshots: [] }), // no snaps → excluded
    ];
    const r = simulateMirror(fills, { detectionLagSec: 300 });
    expect(r.nFills).toBe(4);
    expect(r.nCheapResolved).toBe(1); // only 'a' (c unresolved, d no-snaps, b not cheap)
    expect(r.nUsable).toBe(1);
    expect(r.sharpGross.nGraded).toBe(1);
    expect(r.followerGross.avgAsk).toBeCloseTo(0.17, 9); // the post-lag ask
  });

  it('the follower keeps LESS than the sharp (spread + fee erode it) — capturable < 1', () => {
    // A mix of wins and losses so EVs are finite and the ratio is meaningful.
    const fills = [
      fill({ conditionId: 'w1', outcomeWon: true }),
      fill({ conditionId: 'w2', outcomeWon: true }),
      fill({ conditionId: 'l1', outcomeWon: false }),
    ];
    const r = simulateMirror(fills, { detectionLagSec: 300 });
    expect(r.nUsable).toBe(3);
    // sharp enters at 0.09, follower at 0.17 → the follower's gross EV must be lower.
    expect(r.followerGross.ev).toBeLessThan(r.sharpGross.ev);
    expect(r.followerNet.ev).toBeLessThan(r.followerGross.ev); // fee erodes further
  });

  it('is total on empty input', () => {
    const r = simulateMirror([]);
    expect(r.nFills).toBe(0);
    expect(r.nUsable).toBe(0);
    expect(r.followerNet.n).toBe(0);
    expect(r.followerNet.ev).toBeNaN();
  });
});

describe('copyTradeVerdict (pre-registered kill-criterion)', () => {
  const mkReport = (ev: number, lo: number, hi: number) =>
    ({ followerNet: { ev, evCiLo: lo, evCiHi: hi, n: 10 } } as Parameters<typeof copyTradeVerdict>[0]);

  it('PASS when the CI lower bound clears 0', () => {
    const v = copyTradeVerdict(mkReport(0.05, 0.01, 0.09));
    expect(v.pass).toBe(true);
    expect(v.clearsMargin).toBe(true); // 0.05 ≥ 0.02
  });
  it('PASS-but-below-margin when CI clears 0 but EV < threshold', () => {
    const v = copyTradeVerdict(mkReport(0.01, 0.001, 0.02));
    expect(v.pass).toBe(true);
    expect(v.clearsMargin).toBe(false);
  });
  it('FAIL when the CI straddles 0', () => {
    const v = copyTradeVerdict(mkReport(0.02, -0.01, 0.05));
    expect(v.pass).toBe(false);
    expect(v.summary).toMatch(/late-follower confirmed/);
  });
});
