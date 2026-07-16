/**
 * Tests for the buy-lane verification tool's pure helpers — the skip histogram, the next-window estimate,
 * and the three-gate verdict. No network / no DB: importing the module never runs main() (the direct-invoke
 * guard is false under vitest). The funnel logic itself is the tick's own selectBuyTableCandidates, covered
 * by the handler's suite — here we cover only the diagnostic's own aggregation + verdict layer.
 */
import { describe, expect, it } from 'vitest';
import { skipTag, summarizeSkips, nextWindowOpen, buyLaneVerdict } from './diag-buy-lane.ts';

describe('skipTag', () => {
  it('extracts the leading tag from each skip-reason shape', () => {
    expect(skipTag('lead_window (24.9h to close ∉ [2, 12])')).toBe('lead_window');
    expect(skipTag('price_cap (ask 0.410 > cap 0.33)')).toBe('price_cap');
    expect(skipTag('already_entered (0xabc 2026-07-16) — one entry per market EVER')).toBe('already_entered');
    expect(skipTag('resolved — the market already graded')).toBe('resolved');
    expect(skipTag('no_house_prob — unseeded capture (no forecast center to buy)')).toBe('no_house_prob');
  });
  it('falls back to "other" for an unrecognized shape', () => {
    expect(skipTag('!!!')).toBe('other');
  });
});

describe('summarizeSkips', () => {
  it('counts by tag, most-common first, tie-broken by tag name', () => {
    const hist = summarizeSkips([
      { ref: 'a', reason: 'lead_window (24.9h)' },
      { ref: 'b', reason: 'lead_window (48.9h)' },
      { ref: 'c', reason: 'price_cap (ask 0.4 > 0.33)' },
      { ref: 'd', reason: 'lead_window (0.9h)' },
    ]);
    expect(hist).toEqual([
      { tag: 'lead_window', n: 3 },
      { tag: 'price_cap', n: 1 },
    ]);
  });
  it('is empty for no skips (and tolerates a non-array)', () => {
    expect(summarizeSkips([])).toEqual([]);
    expect(summarizeSkips(undefined as never)).toEqual([]);
  });
});

describe('nextWindowOpen', () => {
  const cfg = { leadMinH: 2, leadMaxH: 12 };
  const now = Date.parse('2026-07-16T11:00:00Z');
  it('returns the soonest resolvesAt−leadMax across the too-far markets', () => {
    const markets = [
      { resolvesAtMs: Date.parse('2026-07-17T12:00:00Z'), hoursToClose: 25 }, // opens 17T00:00
      { resolvesAtMs: Date.parse('2026-07-18T12:00:00Z'), hoursToClose: 49 }, // opens 18T00:00 (later)
    ];
    expect(nextWindowOpen(markets, cfg, now)).toBe(Date.parse('2026-07-17T00:00:00Z'));
  });
  it('ignores markets already inside or past the window', () => {
    const markets = [
      { resolvesAtMs: Date.parse('2026-07-16T18:00:00Z'), hoursToClose: 7 }, // in-window now
      { resolvesAtMs: Date.parse('2026-07-16T11:30:00Z'), hoursToClose: 0.5 }, // past floor
    ];
    expect(nextWindowOpen(markets, cfg, now)).toBeNull();
  });
});

describe('buyLaneVerdict', () => {
  const base = {
    mode: 'live',
    tickEnabled: true,
    preflightOk: true,
    preflightReasons: [] as string[],
    candidateCount: 1,
    topSkips: [] as Array<{ tag: string; n: number }>,
    nextWindowOpenIso: null as string | null,
  };

  it('is GREEN only when every gate is open AND a candidate exists', () => {
    const v = buyLaneVerdict(base);
    expect(v.canBuyNow).toBe(true);
    expect(v.blockers).toEqual([]);
    // even when green, the Edge-secret TRADE_MODE caveat is always noted
    expect(v.notes.some((n) => n.includes('TRADE_MODE'))).toBe(true);
  });

  it('reports the interlock reasons when preflight is not ok (the expired-override case)', () => {
    const v = buyLaneVerdict({
      ...base,
      preflightOk: false,
      preflightReasons: ['no PASS forward paper gate and no ACTIVE trade_gate_override row'],
    });
    expect(v.canBuyNow).toBe(false);
    expect(v.blockers.some((b) => b.includes('interlock:') && b.includes('override'))).toBe(true);
  });

  it('reports the dominant skip + next window when there is no candidate', () => {
    const v = buyLaneVerdict({
      ...base,
      candidateCount: 0,
      topSkips: [{ tag: 'lead_window', n: 8 }],
      nextWindowOpenIso: '2026-07-17T00:00:00Z',
    });
    expect(v.canBuyNow).toBe(false);
    expect(v.blockers.some((b) => b.includes('lead_window') && b.includes('2026-07-17'))).toBe(true);
  });

  it('0102: laneHalted (stop_after_first_success met) blocks GREEN and is worded as by-design', () => {
    const v = buyLaneVerdict({ ...base, laneHalted: true });
    expect(v.canBuyNow).toBe(false);
    expect(v.blockers.some((b) => b.includes('halted BY RULE') && b.includes('stop_after_first_success'))).toBe(true);
  });

  it('flags a disabled tick and a non-live mode independently', () => {
    const off = buyLaneVerdict({ ...base, mode: 'dry-run' });
    expect(off.canBuyNow).toBe(false);
    expect(off.blockers.some((b) => b.includes("mode='dry-run'"))).toBe(true);

    const disabled = buyLaneVerdict({ ...base, tickEnabled: false });
    expect(disabled.canBuyNow).toBe(false);
    expect(disabled.blockers.some((b) => b.includes('tick_enabled'))).toBe(true);
  });
});
