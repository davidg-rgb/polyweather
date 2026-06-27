/**
 * Tests for core/sim/opening-convergence — the PURE decision core of the opening-convergence bot
 * (ARCHITECTURE-OPENING-CONVERGENCE.md / OPENING-CONVERGENCE-HANDOFF.md, the 12th-signal scoped lever).
 * Covers: the flat-open uninformed-window gate + its reason ledger; entry selection (universe / liquidity /
 * flat-open / minimum-runway gates, the W6b argmax mode, the 20% hard cap, the depth floor, fail-closed on a
 * non-IANA tz); the bracket exit decision (TP at entry+δ OR modelProb, the F13/F1 TERNARY stop, the F11
 * DST-correct station-local-noon time-stop for real APAC + US-west zones, the maker-window cancel); the
 * deterministic pessimistic paper-fill model (maker fills only on a through-the-limit live ask, taker
 * worse-of + slippage + fee); the frozen §9R-E net-profit verdict (INSUFFICIENT / PASS / KILL, city-clustered
 * CI + the cluster-preserving zero-skill MC); the deterministic zero-skill rate; and the parseBotConfig
 * fallbacks + the F10-r8-FP migration-mirror pin (the 0066 config mirror MUST deep-equal BOT_DEFAULTS).
 *
 * Pure + total throughout (junk → null/[]/INSUFFICIENT, never throw) — mirrors cross-venue-arb.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  BOT_DEFAULTS,
  GATE_MIN_CITIES,
  GATE_MIN_DISTINCT_DAYS,
  GATE_MIN_MARKETS,
  GATE_MIN_WIN_FRAC,
  OPENING_DEFAULTS,
  ZERO_SKILL_MAX_PASS,
  type EntryCandidate,
  type OpeningBucket,
  type OpeningCapture,
  type OpeningCfg,
  type OpeningMarketResult,
  type OpenPosition,
  bracketDecision,
  isFlatOpen,
  openingVerdict,
  paperFill,
  parseBotConfig,
  selectEntries,
  zeroSkillPassRate,
} from '../src/sim/opening-convergence.ts';
import { takerFeePerShare } from '../src/fees.ts';
import { localHourInstant } from '../src/time.ts';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────

/** Defaults-first, override-after so an explicit `mid: null` (open tail / no quote) is preserved, not coalesced. */
const mkBucket = (over: Partial<OpeningBucket> & { idx: number }): OpeningBucket => ({
  label: `b${over.idx}`,
  loF: null,
  hiF: null,
  mid: 0.1,
  bestAsk: 0.11,
  execAsk: 0.11,
  depthUsd: 100,
  bestBid: 0.09,
  sellbackUsd: 100,
  houseProb: null,
  tokenYes: `y${over.idx}`,
  tokenNo: `n${over.idx}`,
  conditionId: `c${over.idx}`,
  ...over,
});

const mkCap = (over: Partial<OpeningCapture> = {}): OpeningCapture => ({
  eventId: 'ev-1',
  city: 'amsterdam',
  targetDate: '2026-06-28',
  tz: 'Europe/Amsterdam',
  createdAtGamma: '2026-06-28T07:30:00.000Z',
  hoursSinceListing: 0.5,
  resolvesAt: '2026-06-28T22:00:00.000Z',
  negRisk: true,
  evVol24h: 10_000,
  buckets: [],
  houseSeeded: true,
  ...over,
});

// shared panel builders for the verdict / zero-skill suites
const CITIES = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`);
const DAYS = (n: number): string[] => Array.from({ length: n }, (_, i) => `2026-06-${String(10 + i).padStart(2, '0')}`);
const mkPanel = (
  cities: string[],
  days: string[],
  rr: (ci: number, di: number) => number,
): OpeningMarketResult[] =>
  cities.flatMap((c, ci) =>
    days.map((d, di) => {
      const netReturn = rr(ci, di);
      return { city: c, targetDate: d, netReturn, netPnlUsd: netReturn * 20, stakeUsd: 20, executed: true };
    }),
  );

// ── 1 · isFlatOpen ───────────────────────────────────────────────────────────────────────────────────

describe('isFlatOpen — the uninformed-window gate (§16-D)', () => {
  const cfg = OPENING_DEFAULTS;

  it('flat when peak ≤ peakMidMax (0.18) AND hoursSinceListing ≤ listingMaxHours (1)', () => {
    const cap = mkCap({
      hoursSinceListing: 0.5,
      buckets: [mkBucket({ idx: 0, mid: 0.1 }), mkBucket({ idx: 1, mid: 0.12 }), mkBucket({ idx: 2, mid: 0.11 })],
    });
    const r = isFlatOpen(cap, cfg);
    expect(r.flat).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.peakMid).toBeCloseTo(0.12, 9);
    expect(r.hoursSinceListing).toBe(0.5);
  });

  it("'peak_above_max' when the peak bucket mid exceeds peakMidMax", () => {
    const r = isFlatOpen(mkCap({ buckets: [mkBucket({ idx: 0, mid: 0.1 }), mkBucket({ idx: 1, mid: 0.25 })] }), cfg);
    expect(r.flat).toBe(false);
    expect(r.reasons).toContain('peak_above_max');
  });

  it("'past_listing_window' when hoursSinceListing exceeds listingMaxHours", () => {
    const r = isFlatOpen(mkCap({ hoursSinceListing: 2, buckets: [mkBucket({ idx: 0, mid: 0.1 })] }), cfg);
    expect(r.flat).toBe(false);
    expect(r.reasons).toContain('past_listing_window');
  });

  it("'no_quotes' (peakMid NaN) when no bucket carries a two-sided mid", () => {
    const r = isFlatOpen(mkCap({ buckets: [mkBucket({ idx: 0, mid: null }), mkBucket({ idx: 1, mid: null })] }), cfg);
    expect(r.reasons).toContain('no_quotes');
    expect(Number.isNaN(r.peakMid)).toBe(true);
  });

  it("'no_listing_time' when hoursSinceListing is not finite", () => {
    const r = isFlatOpen(mkCap({ hoursSinceListing: Number.NaN, buckets: [mkBucket({ idx: 0, mid: 0.1 })] }), cfg);
    expect(r.reasons).toContain('no_listing_time');
  });

  it('lists EACH failed test that applies (no_quotes + no_listing_time together)', () => {
    const r = isFlatOpen(mkCap({ hoursSinceListing: Number.NaN, buckets: [mkBucket({ idx: 0, mid: null })] }), cfg);
    expect(r.reasons).toEqual(expect.arrayContaining(['no_quotes', 'no_listing_time']));
    expect(r.flat).toBe(false);
  });

  it('is total on empty / junk buckets — never throws', () => {
    expect(() => isFlatOpen(mkCap({ buckets: [] }), cfg)).not.toThrow();
    expect(isFlatOpen(mkCap({ buckets: [] }), cfg).reasons).toContain('no_quotes');
    expect(() => isFlatOpen({ ...mkCap(), buckets: undefined as unknown as OpeningBucket[] }, cfg)).not.toThrow();
  });
});

// ── 2 · selectEntries ──────────────────────────────────────────────────────────────────────────────────

describe('selectEntries — pick the flat-open buckets to buy (§9R-B / W6b / F7-r10)', () => {
  const cfg: OpeningCfg = { ...OPENING_DEFAULTS, cities: ['amsterdam'] };
  const NOON = localHourInstant('Europe/Amsterdam', '2026-06-28', 12); // 10:00Z (CEST)
  const NOW = new Date(NOON.getTime() - 2 * 3_600_000); // 08:00Z — 120 min of runway before the time-stop

  // a flat-open ladder peaked (by houseProb) at idx 2; all mids low so the BOOK is flat-open.
  const centerCap = mkCap({
    buckets: [
      mkBucket({ idx: 0, mid: 0.1, houseProb: 0.1, execAsk: 0.09, bestAsk: 0.1 }),
      mkBucket({ idx: 1, mid: 0.11, houseProb: 0.2, execAsk: 0.12, bestAsk: 0.13 }),
      mkBucket({ idx: 2, mid: 0.12, houseProb: 0.35, execAsk: 0.18, bestAsk: 0.19 }),
      mkBucket({ idx: 3, mid: 0.11, houseProb: 0.2, execAsk: 0.12, bestAsk: 0.13 }),
      mkBucket({ idx: 4, mid: 0.1, houseProb: 0.1, execAsk: 0.09, bestAsk: 0.1 }),
    ],
  });

  it('returns [] when the city is not in the allowlist', () => {
    expect(selectEntries({ ...centerCap, city: 'london' }, cfg, NOW)).toEqual([]);
  });

  it('returns [] when event vol24h is below the liquidity floor', () => {
    expect(selectEntries({ ...centerCap, evVol24h: 100 }, cfg, NOW)).toEqual([]);
    expect(selectEntries({ ...centerCap, evVol24h: null }, cfg, NOW)).toEqual([]);
  });

  it('returns [] when not flat-open (peak above max)', () => {
    const notFlat = { ...centerCap, buckets: centerCap.buckets.map((b, i) => (i === 0 ? { ...b, mid: 0.5 } : b)) };
    expect(selectEntries(notFlat, cfg, NOW)).toEqual([]);
  });

  it('returns [] when no bucket carries a houseProb (unseeded / quality-gate-failed — C1/F15)', () => {
    const noHouse = { ...centerCap, buckets: centerCap.buckets.map((b) => ({ ...b, houseProb: null })) };
    expect(selectEntries(noHouse, cfg, NOW)).toEqual([]);
  });

  it('picks the mode ± centerHalfWidth buckets that clear execAsk ≤ min(0.20, houseProb − margin) AND depth', () => {
    const out = selectEntries(centerCap, cfg, NOW);
    expect(out.map((c) => c.bucketIdx).sort((a, b) => a - b)).toEqual([1, 2, 3]); // mode 2 ± 1
    const mode = out.find((c) => c.bucketIdx === 2)!;
    expect(mode.modelProb).toBeCloseTo(0.35, 9); // W6b: modeIdx = argmax houseProb
    expect(mode.execAsk).toBeCloseTo(0.18, 9);
    expect(mode.edge).toBeCloseTo(0.35 - 0.18, 9);
    expect(mode.targetUsd).toBe(cfg.perPositionUsd);
    expect(mode.targetShares).toBeCloseTo(cfg.perPositionUsd / 0.18, 9);
    expect(mode.makerLimit).toBeCloseTo(0.19, 9); // min(reservation 0.20, bestAsk 0.19)
    expect(mode.city).toBe('amsterdam');
    expect(mode.tz).toBe('Europe/Amsterdam');
    expect(mode.negRisk).toBe(true);
    expect(mode.targetDate).toBe('2026-06-28');
  });

  it('the 20% hard cap binds — a mode bucket with a large model edge but execAsk > 0.20 is rejected', () => {
    const capCap = mkCap({
      buckets: [
        mkBucket({ idx: 0, mid: 0.12, houseProb: 0.4, execAsk: 0.22, bestAsk: 0.23 }), // mode; ask above the 0.20 cap
        mkBucket({ idx: 1, mid: 0.11, houseProb: 0.3, execAsk: 0.19, bestAsk: 0.2 }),
      ],
    });
    const out = selectEntries(capCap, cfg, NOW);
    // idx0 is the argmax (0.40) and execAsk 0.22 < houseProb−margin (0.35) — but the hard 0.20 cap blocks it.
    expect(out.map((c) => c.bucketIdx)).toEqual([1]);
    out.forEach((c) => expect(c.execAsk).toBeLessThanOrEqual(cfg.maxEntryPrice + 1e-9));
  });

  it('the depth floor drops a thin bucket even when its price clears (the mode bucket itself is dropped)', () => {
    const thinCap = mkCap({
      buckets: [
        mkBucket({ idx: 0, mid: 0.1, houseProb: 0.18, execAsk: 0.1, bestAsk: 0.11, depthUsd: 100 }),
        mkBucket({ idx: 1, mid: 0.12, houseProb: 0.3, execAsk: 0.15, bestAsk: 0.16, depthUsd: 10 }), // mode, price-OK, THIN
        mkBucket({ idx: 2, mid: 0.1, houseProb: 0.18, execAsk: 0.1, bestAsk: 0.11, depthUsd: 100 }),
      ],
    });
    expect(selectEntries(thinCap, cfg, NOW).map((c) => c.bucketIdx).sort((a, b) => a - b)).toEqual([0, 2]);
  });

  it('the F7-r10 minimum-runway guard returns [] for a market already near local noon (far-east tz)', () => {
    const sh = { ...centerCap, tz: 'Asia/Shanghai' };
    const noonSh = localHourInstant('Asia/Shanghai', '2026-06-28', 12); // 04:00Z (CST, no DST)
    const nowNearNoon = new Date(noonSh.getTime() - 10 * 60_000); // 10 min of runway < minHoldRunwayMin (30)
    expect(selectEntries(sh, cfg, nowNearNoon)).toEqual([]);
    // the SAME capture with a full runway DOES select — proving the runway guard, not another gate, blocked it.
    const nowFull = new Date(noonSh.getTime() - 6 * 3_600_000);
    expect(selectEntries(sh, cfg, nowFull).length).toBeGreaterThan(0);
  });

  it('fails closed (returns []) for a non-IANA or Etc/* tz — no DST-correct time-stop ⇒ never enter', () => {
    expect(selectEntries({ ...centerCap, tz: 'Etc/GMT-8' }, cfg, NOW)).toEqual([]);
    expect(selectEntries({ ...centerCap, tz: 'Mars/Olympus' }, cfg, NOW)).toEqual([]);
  });
});

// ── 3 · bracketDecision ────────────────────────────────────────────────────────────────────────────────

describe('bracketDecision — the pure exit decision (§9R-C / F1 / F11 / F13 / ADR-OC-7/12)', () => {
  const cfg = OPENING_DEFAULTS;
  const TZ = 'Europe/Amsterdam';
  const DATE = '2026-06-28';
  const NOON = localHourInstant(TZ, DATE, 12); // 10:00Z
  const BEFORE = new Date(NOON.getTime() - 2 * 3_600_000); // 08:00Z — before noon, so the time-stop never preempts
  const pos = (over: Partial<OpenPosition> = {}): OpenPosition => ({
    entryPrice: 0.15,
    modelProb: 0.99, // high by default so tpAtModelProb does not fire spuriously on small marks
    tokenYes: 'y',
    targetDate: DATE,
    side: 'BUY-YES',
    state: 'armed',
    ...over,
  });

  it('take_profit when mark ≥ entry + tpDeltaPp', () => {
    expect(bracketDecision(pos({ entryPrice: 0.15 }), 0.45, BEFORE, TZ, cfg).kind).toBe('take_profit');
  });

  it('take_profit when mark ≥ modelProb (let winners run toward the dist — tpAtModelProb)', () => {
    // 0.30 < entry+0.25 (0.35) so NOT via the delta path; ≥ modelProb 0.30 fires it.
    expect(bracketDecision(pos({ entryPrice: 0.1, modelProb: 0.3 }), 0.3, BEFORE, TZ, cfg).kind).toBe('take_profit');
  });

  it('the TERNARY stop: entry 0.15 stops at the ABSOLUTE 0.03 (entry−0.12), NOT the relative 0.075 a max() gives', () => {
    const p = pos({ entryPrice: 0.15 });
    expect(bracketDecision(p, 0.03, BEFORE, TZ, cfg).kind).toBe('stop_loss'); // mark ≤ 0.03 fires
    // 0.05 is below the relative floor (0.075) a max() would impose, but ABOVE the locked −12pp 0.03 → HOLD.
    expect(bracketDecision(p, 0.05, BEFORE, TZ, cfg).kind).toBe('hold');
  });

  it('the TERNARY stop: entry 0.10 (≤ slDeltaPp) falls to the relative floor entry×(1−slFrac) = 0.05', () => {
    const p = pos({ entryPrice: 0.1 });
    expect(bracketDecision(p, 0.05, BEFORE, TZ, cfg).kind).toBe('stop_loss'); // 0.05 = 0.10 × 0.5
    expect(bracketDecision(p, 0.06, BEFORE, TZ, cfg).kind).toBe('hold');
  });

  it('station-local-noon time_stop fires at exactly localHourInstant(tz,date,12) for an APAC and a US-west zone', () => {
    for (const tz of ['Asia/Tokyo', 'America/Los_Angeles']) {
      const noon = localHourInstant(tz, DATE, 12); // DST-aware date (June): Tokyo JST, LA PDT
      const p = pos();
      expect(bracketDecision(p, 0.15, noon, tz, cfg).kind).toBe('time_stop'); // at the instant
      expect(bracketDecision(p, 0.15, new Date(noon.getTime() - 1), tz, cfg).kind).not.toBe('time_stop'); // 1ms before
    }
  });

  it('a non-IANA / Etc/* tz is caught → conservative time_stop (fail toward flatten — ADR-OC-12)', () => {
    const a = bracketDecision(pos(), 0.15, BEFORE, 'Etc/GMT-8', cfg);
    expect(a.kind).toBe('time_stop');
    expect((a as { reason: string }).reason).toContain('invalid_tz_conservative_flatten');
    expect(bracketDecision(pos(), 0.15, BEFORE, 'Mars/Olympus', cfg).kind).toBe('time_stop');
  });

  it('cancel_maker_take when a maker entry has rested ≥ makerFillWindowMin', () => {
    const restingSince = new Date(BEFORE.getTime() - 20 * 60_000).toISOString(); // 20 min ≥ window 15
    const a = bracketDecision(pos({ state: 'maker_resting', makerRestingSince: restingSince }), null, BEFORE, TZ, cfg);
    expect(a.kind).toBe('cancel_maker_take');
  });

  it('holds a maker entry still inside its fill window', () => {
    const restingSince = new Date(BEFORE.getTime() - 5 * 60_000).toISOString(); // 5 min < window 15
    expect(
      bracketDecision(pos({ state: 'maker_resting', makerRestingSince: restingSince }), null, BEFORE, TZ, cfg).kind,
    ).toBe('hold');
  });

  it('holds when the bid-side mark is unavailable (mark null)', () => {
    expect(bracketDecision(pos(), null, BEFORE, TZ, cfg).kind).toBe('hold');
  });
});

// ── 4 · paperFill ──────────────────────────────────────────────────────────────────────────────────────

describe('paperFill — deterministic pessimistic fill (ADR-OC-6/9)', () => {
  const cfg = OPENING_DEFAULTS;
  const cand: EntryCandidate = {
    eventId: 'ev',
    city: 'amsterdam',
    targetDate: '2026-06-28',
    tz: 'Europe/Amsterdam',
    bucketIdx: 2,
    label: '21°C',
    tokenYes: 'y',
    tokenNo: 'n',
    conditionId: 'c',
    negRisk: true,
    resolvesAt: null,
    execAsk: 0.14,
    modelProb: 0.3,
    edge: 0.16,
    makerLimit: 0.15,
    targetShares: 20 / 0.14,
    targetUsd: 20,
  };

  it('maker fills ONLY when the live ask traded through the limit — at makerLimit, $0 fee', () => {
    const f = paperFill(cand, 0.13, 0.14, cfg, true);
    expect(f).not.toBeNull();
    expect(f!.price).toBeCloseTo(0.15, 9); // = makerLimit
    expect(f!.shares).toBeCloseTo(20 / 0.15, 9);
    expect(f!.feeUsd).toBe(0);
    expect(f!.isMaker).toBe(true);
  });

  it('maker does NOT fill when the live ask never reached the limit (or is missing)', () => {
    expect(paperFill(cand, 0.13, 0.16, cfg, true)).toBeNull(); // 0.16 > makerLimit 0.15
    expect(paperFill(cand, 0.13, null, cfg, true)).toBeNull();
  });

  it('taker fills at max(storedAsk, liveWalkedAsk) + paperSlippage with a takerFeePerShare fee', () => {
    const f = paperFill(cand, 0.12, 0.14, cfg, false);
    expect(f).not.toBeNull();
    const price = 0.14 + cfg.paperSlippage; // worse-of (0.14) + slippage
    expect(f!.price).toBeCloseTo(price, 9);
    expect(f!.shares).toBeCloseTo(cand.targetUsd / price, 9);
    expect(f!.feeUsd).toBeCloseTo(takerFeePerShare(price, cfg.takerFeeRate) * (cand.targetUsd / price), 12);
    expect(f!.feeUsd).toBeGreaterThan(0);
    expect(f!.isMaker).toBe(false);
  });

  it('returns null (no fill) when both the stored and live asks are unusable', () => {
    expect(paperFill(cand, null, null, cfg, false)).toBeNull();
  });
});

// ── 5 · openingVerdict ─────────────────────────────────────────────────────────────────────────────────

describe('openingVerdict — the frozen §9R-E net-profit gate', () => {
  it('exposes the §9R-E sufficiency bars', () => {
    expect(GATE_MIN_MARKETS).toBe(40);
    expect(GATE_MIN_CITIES).toBe(4);
    expect(GATE_MIN_DISTINCT_DAYS).toBe(7);
    expect(GATE_MIN_WIN_FRAC).toBe(0.5);
    expect(ZERO_SKILL_MAX_PASS).toBe(0.05);
  });

  it('INSUFFICIENT_DATA below the minimum market count', () => {
    expect(openingVerdict(mkPanel(CITIES(2), DAYS(7), () => 0.02)).label).toBe('INSUFFICIENT_DATA'); // 14 < 40
  });

  it('INSUFFICIENT_DATA with enough markets but too few cities', () => {
    const v = openingVerdict(mkPanel(CITIES(3), DAYS(14), () => 0.02)); // 42 markets, 3 cities < 4
    expect(v.nMarkets).toBe(42);
    expect(v.nCities).toBe(3);
    expect(v.label).toBe('INSUFFICIENT_DATA');
  });

  it('INSUFFICIENT_DATA with enough markets/cities but too few distinct days', () => {
    const v = openingVerdict(mkPanel(CITIES(8), DAYS(5), () => 0.02)); // 40 markets, 5 days < 7
    expect(v.nDistinctDays).toBe(5);
    expect(v.label).toBe('INSUFFICIENT_DATA');
  });

  it('a clearly-positive panel clears the data gates AND the descriptive bars (winFrac=1, city-clustered ciLow>0)', () => {
    const v = openingVerdict(mkPanel(CITIES(12), DAYS(7), () => 0.02)); // 84 markets, 12 cities, 7 days
    expect(v.nMarkets).toBe(84);
    expect(v.nCities).toBe(12);
    expect(v.nDistinctDays).toBe(7);
    expect(v.winFrac).toBe(1);
    expect(v.ciLow).toBeGreaterThan(0); // the city-clustered CI excludes 0
    expect(v.label).not.toBe('INSUFFICIENT_DATA'); // the three sufficiency gates are cleared
  });

  // The cluster-preserving zero-skill MC draws an INDEPENDENT Rademacher sign per city (a decorrelated hash,
  // not one LCG step over an arithmetic seed — the earlier bug collapsed every city to one coin flip and
  // floored the pass-rate ~0.4, making the gate un-passable). A clearly-positive panel must therefore clear
  // BOTH the descriptive bars AND the zero-skill floor → PASS.
  it('PASS — a clearly-positive panel clears the bars AND the zero-skill MC (independent per-city signs)', () => {
    const v = openingVerdict(mkPanel(CITIES(12), DAYS(7), () => 0.02));
    expect(v.zeroSkillPassRate).toBeLessThan(ZERO_SKILL_MAX_PASS); // a real positive edge beats noise ≪5%
    expect(v.label).toBe('PASS');
  });

  it('KILL — a noisy zero-mean panel: winFrac ≈ 0.5 but the city-clustered CI straddles 0', () => {
    const v = openingVerdict(mkPanel(CITIES(8), DAYS(7), (ci) => (ci % 2 === 0 ? 0.05 : -0.05)));
    expect(v.winFrac).toBeCloseTo(0.5, 6);
    expect(v.ciLow).toBeLessThan(0);
    expect(v.label).not.toBe('PASS');
    expect(v.label).toBe('KILL');
  });

  it('is total: an empty / junk panel → INSUFFICIENT_DATA, no throw', () => {
    expect(openingVerdict([]).label).toBe('INSUFFICIENT_DATA');
    expect(openingVerdict(null as unknown as OpeningMarketResult[]).label).toBe('INSUFFICIENT_DATA');
  });
});

// ── 6 · zeroSkillPassRate ──────────────────────────────────────────────────────────────────────────────

describe('zeroSkillPassRate — the cluster-preserving sign-flip MC (F28)', () => {
  const equalPanel = (cities: string[]): OpeningMarketResult[] =>
    cities.flatMap((c) =>
      DAYS(7).map((d) => ({ city: c, targetDate: d, netReturn: 0.02, netPnlUsd: 0.4, stakeUsd: 20, executed: true })),
    );

  it('is deterministic — the same seedSalt yields the same rate across runs (no Math.random)', () => {
    const p = equalPanel(CITIES(6));
    expect(zeroSkillPassRate(p, 500, 1234)).toBe(zeroSkillPassRate(p, 500, 1234));
    // and a DIFFERENT salt is a different (but still deterministic) draw
    expect(zeroSkillPassRate(p, 500, 9)).toBe(zeroSkillPassRate(p, 500, 9));
  });

  it('returns 1 (fail-closed) when there are fewer than 2 cities (no clustering possible)', () => {
    expect(zeroSkillPassRate(equalPanel(['only']), 500, 0)).toBe(1);
  });
});

// ── 7 · parseBotConfig + the F10-r8-FP migration-mirror pin ────────────────────────────────────────────

/** The EXACT key/value pairs migration 0066 SECTION 8 seeds into `config` (the bot.* mirror). */
const MIGRATION_0066_CONFIG_ROWS: { key: string; value: string }[] = [
  { key: 'bot_enabled', value: '0' },
  { key: 'bot.cities', value: 'amsterdam,chengdu,manila,qingdao,madrid,guangzhou,kuala-lumpur,beijing,shanghai,paris' },
  { key: 'bot.minVol24hUsd', value: '7000' },
  { key: 'bot.peakMidMax', value: '0.18' },
  { key: 'bot.listingMaxHours', value: '1' },
  { key: 'bot.centerHalfWidth', value: '1' },
  { key: 'bot.entryEdgeMargin', value: '0.05' },
  { key: 'bot.maxEntryPrice', value: '0.2' },
  { key: 'bot.depthFloorUsd', value: '50' },
  { key: 'bot.perPositionUsd', value: '20' },
  { key: 'bot.perMarketUsd', value: '40' },
  { key: 'bot.totalConcurrentUsd', value: '100' },
  { key: 'bot.paperBankrollUsd', value: '200' },
  { key: 'bot.bankrollBaseUsd', value: '200' },
  { key: 'bot.killLossUsd', value: '30' },
  { key: 'bot.killLossPct', value: '0.25' },
  { key: 'bot.firstNApprove', value: '10' },
  { key: 'bot.realTradesApproved', value: '0' },
  { key: 'bot.tpDeltaPp', value: '0.25' },
  { key: 'bot.tpAtModelProb', value: '1' },
  { key: 'bot.slDeltaPp', value: '0.12' },
  { key: 'bot.slFrac', value: '0.5' },
  { key: 'bot.timeStopLocalHour', value: '12' },
  { key: 'bot.makerFillWindowMin', value: '15' },
  { key: 'bot.minHoldRunwayMin', value: '30' },
  { key: 'bot.paperSlippage', value: '0.01' },
  { key: 'bot.takerFeeRate', value: '0.05' },
  { key: 'bot.paperBookMaxAgeMin', value: '5' },
  { key: 'bot.tickIntervalSec', value: '30' },
  { key: 'bot.tickWatchdogSec', value: '120' },
  { key: 'bot.leaseTtlSec', value: '600' },
  { key: 'bot.reconcileWatchdogSec', value: '300' },
  { key: 'bot.reconcileEveryTicks', value: '20' },
  { key: 'bot.markMaxAgeMin', value: '5' },
  { key: 'bot.maxClockDriftSec', value: '5' },
  { key: 'bot.maxConsecutiveFailures', value: '5' },
  { key: 'bot.maxConsecutiveAmbiguous', value: '4' },
  { key: 'bot.seedFreshnessMin', value: '180' },
  { key: 'bot.seedMinModels', value: '3' },
  { key: 'bot.captureStaleMin', value: '9' }, // consumed by capture_deadman_check (SQL), not parseBotConfig — must be ignored cleanly
  { key: 'bot.captureSeededFracMin', value: '0.25' },
  { key: 'bot.captureSeededFracWindow', value: '50' },
  { key: 'bot.minOrderSizeShares', value: '5' },
  { key: 'bot.minOrderNotionalUsd', value: '1' },
  { key: 'bot.freeCashReserveUsd', value: '5' },
  { key: 'bot.minPolGas', value: '0.5' },
  { key: 'bot.killDayTz', value: 'America/New_York' },
  { key: 'bot.killLatchPersistTicks', value: '3' },
  { key: 'bot.spikeGoFrac', value: '0.5' },
  { key: 'bot.gate.minMarkets', value: '40' },
  { key: 'bot.gate.minCities', value: '4' },
  { key: 'bot.gate.minDistinctDays', value: '7' },
  { key: 'bot.gate.minWinFrac', value: '0.5' },
];

describe('parseBotConfig — config fallbacks + the F10-r8-FP migration-mirror pin', () => {
  it('an empty config list returns the BOT_DEFAULTS code values exactly', () => {
    expect(parseBotConfig([])).toEqual(BOT_DEFAULTS);
  });

  it('row overrides parse: CSV cities → string[], bot_enabled "1" → true, numbers/booleans/strings parse', () => {
    const cfg = parseBotConfig([
      { key: 'bot.cities', value: 'nyc, la , chicago' },
      { key: 'bot_enabled', value: '1' },
      { key: 'bot.perPositionUsd', value: '33' },
      { key: 'bot.tpAtModelProb', value: '0' },
      { key: 'bot.killDayTz', value: 'Europe/Stockholm' },
      { key: 'bot.gate.minMarkets', value: '99' },
      { key: 'bot.peakMidMax', value: 'not-a-number' }, // junk → falls back to the default
    ]);
    expect(cfg.cities).toEqual(['nyc', 'la', 'chicago']); // trimmed + split
    expect(cfg.enabled).toBe(true);
    expect(cfg.perPositionUsd).toBe(33);
    expect(cfg.tpAtModelProb).toBe(false);
    expect(cfg.killDayTz).toBe('Europe/Stockholm');
    expect(cfg.gate.minMarkets).toBe(99);
    expect(cfg.peakMidMax).toBe(BOT_DEFAULTS.peakMidMax); // junk numeric → default
  });

  it('F10-r8-FP — parseBotConfig of the migration 0066 config mirror deep-equals BOT_DEFAULTS', () => {
    // This pins the migration mirror to the authoritative code defaults. If it fails, the migration's
    // SECTION-8 `insert into config` has drifted from packages/core BOT_DEFAULTS (or vice-versa).
    expect(parseBotConfig(MIGRATION_0066_CONFIG_ROWS)).toEqual(BOT_DEFAULTS);
  });
});
