/**
 * core/sim/entry-watch — the paper-trade entry-time watcher. Pins the ranking discipline (edgeCiLo, NOT the
 * point estimate, so a thin lucky arm can't out-rank a deep tight one), the confidence ladder
 * (insufficient → provisional → sufficient), and the total/deterministic contract.
 */
import { describe, expect, it } from 'vitest';
import { type ArmGradedBets, ENTRY_WATCH_MIN_GRADED, recommendEntryHour } from '../src/sim/entry-watch.ts';
import type { GradedBet } from '../src/sim/stats.ts';

/** `w` wins + `l` losses, all at the same ask — a deterministic graded-bet sample. */
function bets(w: number, l: number, ask: number): GradedBet[] {
  return [
    ...Array.from({ length: w }, () => ({ won: true, ask })),
    ...Array.from({ length: l }, () => ({ won: false, ask })),
  ];
}

describe('recommendEntryHour — ranking, confidence, totality', () => {
  it('empty / no graded bets → INSUFFICIENT with a null recommendation', () => {
    expect(recommendEntryHour([]).recommendedHour).toBeNull();
    const r = recommendEntryHour([{ hour: 11, bets: [] }, { hour: 12, bets: [] }]);
    expect(r.confidence).toBe('insufficient');
    expect(r.recommendedHour).toBeNull();
    expect(r.arms.map((a) => a.hour)).toEqual([11, 12]); // sorted by hour, both present
    expect(r.arms.every((a) => a.rank === null && !a.recommended)).toBe(true);
  });

  it('all arms thinner than minGraded → INSUFFICIENT but surfaces the best point-estimate hint', () => {
    const r = recommendEntryHour([
      { hour: 11, bets: bets(2, 1, 0.5) }, // edge = (2·0.5 − 1·0.5)/3 = +0.1667
      { hour: 12, bets: bets(1, 2, 0.5) }, // edge negative
    ]);
    expect(r.confidence).toBe('insufficient');
    expect(r.recommendedHour).toBe(11); // the higher-edge hint, even though neither is eligible
    expect(r.rationale).toMatch(/keep racing/i);
  });

  it('ranks ELIGIBLE arms by edgeCiLo, not the point edge — the deep tight arm beats the thin lucky one', () => {
    // Arm 11: high POINT edge (+0.40) but high variance → wide CI, low lower bound (~+0.10).
    // Arm 12: lower point edge (+0.30) but zero variance → edgeCiLo = +0.30. Lower-bound ranking ⇒ 12 wins.
    const r = recommendEntryHour([
      { hour: 11, bets: bets(6, 6, 0.1) }, // gaps {+0.9 ×6, −0.1 ×6} → mean +0.40, wide
      { hour: 12, bets: bets(30, 0, 0.7) }, // gaps {+0.30 ×30} → mean +0.30, tight
    ]);
    const a11 = r.arms.find((a) => a.hour === 11)!;
    const a12 = r.arms.find((a) => a.hour === 12)!;
    expect(a11.edge).toBeGreaterThan(a12.edge); // 11 has the higher POINT edge …
    expect(a12.edgeCiLo).toBeGreaterThan(a11.edgeCiLo); // … but the lower CI bound ranks 12 first
    expect(a12.rank).toBe(1);
    expect(a11.rank).toBe(2);
    expect(r.recommendedHour).toBe(12);
    // 12 is credible (edgeCiLo>0) but NOT separated (11's point edge 0.40 > 12's lower bound) → provisional.
    expect(r.confidence).toBe('provisional');
  });

  it('a credible AND separated leader → SUFFICIENT (the promotion cue)', () => {
    const r = recommendEntryHour([
      { hour: 13, bets: bets(18, 2, 0.5) }, // edge +0.40, edgeCiLo well above 0
      { hour: 14, bets: bets(10, 10, 0.5) }, // edge 0
      { hour: 15, bets: bets(2, 1, 0.5) }, // thin → not eligible, ignored for the verdict
    ]);
    expect(r.recommendedHour).toBe(13);
    expect(r.confidence).toBe('sufficient');
    const a13 = r.arms.find((a) => a.hour === 13)!;
    expect(a13.recommended).toBe(true);
    expect(a13.rank).toBe(1);
    expect(r.arms.find((a) => a.hour === 15)!.eligible).toBe(false); // n=3 < minGraded
  });

  it('best eligible arm is not credibly +EV → PROVISIONAL (least-bad, keep racing)', () => {
    const r = recommendEntryHour([
      { hour: 11, bets: bets(10, 10, 0.5) }, // edge 0 → edgeCiLo < 0
      { hour: 12, bets: bets(8, 12, 0.5) }, // edge negative
    ]);
    expect(r.confidence).toBe('provisional');
    expect(r.recommendedHour).toBe(11); // highest edgeCiLo even though not > 0
    expect(r.rationale).toMatch(/not yet credibly/i);
  });

  it('a lone eligible arm with a credible edge is trivially separated → SUFFICIENT', () => {
    const r = recommendEntryHour([
      { hour: 12, bets: bets(16, 4, 0.5) }, // edge +0.30, eligible & credible
      { hour: 13, bets: bets(1, 1, 0.5) }, // thin
    ]);
    expect(r.recommendedHour).toBe(12);
    expect(r.confidence).toBe('sufficient');
    expect(r.rationale).toMatch(/only arm with enough data/i);
  });

  it('minGraded is tunable — lowering it promotes a thinner arm to eligible', () => {
    const arms: ArmGradedBets[] = [{ hour: 12, bets: bets(7, 1, 0.3) }]; // n=8, edge +0.575, edgeCiLo ~+0.33
    expect(recommendEntryHour(arms).confidence).toBe('insufficient'); // n=8 < default minGraded 10
    const lowered = recommendEntryHour(arms, { minGraded: 5 });
    expect(lowered.confidence).toBe('sufficient'); // now eligible, credibly +EV, lone arm
    expect(lowered.recommendedHour).toBe(12);
  });

  it('is deterministic and total — same input twice is identical; junk hours/asks are dropped, never throw', () => {
    const arms: ArmGradedBets[] = [
      { hour: Number.NaN, bets: bets(20, 0, 0.5) }, // junk hour → filtered out entirely
      { hour: 13, bets: [...bets(15, 5, 0.5), { won: true, ask: 0 }, { won: true, ask: 1.5 }] }, // bad asks dropped by armEdgeStats
    ];
    const a = recommendEntryHour(arms);
    const b = recommendEntryHour(arms);
    expect(a).toEqual(b);
    expect(a.arms.map((x) => x.hour)).toEqual([13]); // the NaN-hour arm removed
    expect(a.arms[0]!.nGraded).toBe(20); // only the 20 usable bets counted
    expect(ENTRY_WATCH_MIN_GRADED).toBe(10);
  });
});
