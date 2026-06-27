/**
 * Tests for the Phase-0.5 GO/NO-GO spike (scripts/research/opening-spike.ts) — the gate that AUTHORIZES building
 * the execution stack (Phases 2–6). Its pure core (runSpike/spikeVerdict/centerDepth/hasUsableHouse) previously
 * had only a CLI-time sanity() that does NOT run under `pnpm test`; this brings it into CI. The decisive
 * adversarial property here is "the spike cannot say GO when the signal is actually absent" — covered by the
 * seededCoverage-floor cases (TEST-1): a flat-open seeded MINORITY must NOT GO off the healthy subset.
 */
import { describe, expect, it } from 'vitest';
import { parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';
import {
  MIN_SEEDED_COVERAGE,
  hasUsableHouse,
  runSpike,
  spikeVerdict,
  type RawBucket,
  type RawCaptureRow,
  type SpikeResult,
} from './opening-spike.ts';

const cfg = parseBotConfig([]); // BOT_DEFAULTS: peakMidMax 0.18, listingMaxHours 1, centerHalfWidth 1, depthFloor 50, spikeGoFrac 0.5

const bucket = (idx: number, mid: number, houseProb: number | null, depthUsd: number): RawBucket => ({
  idx, label: `b${idx}`, loF: idx, hiF: idx + 1, mid, bestAsk: mid, execAsk: mid, depthUsd,
  bestBid: mid, sellbackUsd: depthUsd, execBid: mid, sellbackDepthUsd: depthUsd,
  houseProb, tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`,
});

const cap = (over: Partial<RawCaptureRow> & { eventId: string; capturedAt: string }): RawCaptureRow => ({
  city: 'amsterdam', targetDate: '2026-07-01', tzName: 'Europe/Amsterdam', createdAtGamma: null, resolvesAt: null,
  hoursSinceListing: 0.5, peakMid: null, isFlatOpen: null, houseSeeded: false, buckets: null, evVol24h: 9000,
  negRisk: true, ...over,
});

const flatMids = [bucket(0, 0.1, null, 0), bucket(1, 0.11, null, 0), bucket(2, 0.1, null, 0)];
const seededFlat = [bucket(1, 0.1, 0.2, 60), bucket(2, 0.11, 0.5, 100), bucket(3, 0.1, 0.2, 70)];

/** A panel literal with enough target-dates/events to clear the sufficiency gates, parameterized by the verdict inputs. */
const base = (over: Partial<SpikeResult>): SpikeResult => ({
  nCaptures: 50, nEvents: 12, nSeededEvents: 10, nDroppedNoEventId: 0, seededCoverage: 10 / 12,
  nPass: 6, goFraction: 0.6, goCiLow: 0.3, goCiHigh: 0.85, spanDays: 8, nCaptureDays: 8,
  nDistinctTargetDates: 8, events: [], ...over,
});

describe('runSpike — first-house-dist read per event', () => {
  it('picks each event\'s FIRST usable-house capture and scores flat-open + cheap center depth', () => {
    // A: unseeded-then-seeded, still flat, mode idx 2, depth 100 ≥ 50 → PASS
    const A1 = cap({ eventId: 'A', capturedAt: '2026-07-01T00:00:00Z', buckets: flatMids, hoursSinceListing: 0.2 });
    const A2 = cap({ eventId: 'A', capturedAt: '2026-07-01T00:30:00Z', buckets: seededFlat, houseSeeded: true, hoursSinceListing: 0.8 });
    // B: seeded but already converged (a 0.40 mid > peakMidMax) → not flat → FAIL
    const B = cap({ eventId: 'B', capturedAt: '2026-07-02T00:00:00Z', targetDate: '2026-07-02', houseSeeded: true, buckets: [bucket(1, 0.4, 0.6, 100), bucket(2, 0.1, 0.2, 100)] });
    // C: seeded, flat, but center depth below floor (10 < 50) → FAIL
    const C = cap({ eventId: 'C', capturedAt: '2026-07-03T00:00:00Z', targetDate: '2026-07-03', houseSeeded: true, buckets: [bucket(1, 0.1, 0.5, 10), bucket(2, 0.1, 0.2, 10)] });
    // D: never seeds → reachedSeed=false (lowers coverage, excluded from the GO denominator)
    const D = cap({ eventId: 'D', capturedAt: '2026-07-04T00:00:00Z', targetDate: '2026-07-04', buckets: flatMids });

    const res = runSpike([A1, A2, B, C, D], cfg);
    expect(res.nEvents).toBe(4);
    expect(res.nSeededEvents).toBe(3); // A, B, C reached a usable dist; D never did
    expect(res.nPass).toBe(1); // only A
    expect(res.goFraction).toBeCloseTo(1 / 3, 9);
    expect(res.seededCoverage).toBeCloseTo(3 / 4, 9);
    // distinct target_date among SEEDED events: A(07-01)/B(07-02)/C(07-03) → 3; D(07-04) never seeded → excluded
    expect(res.nDistinctTargetDates).toBe(3);

    const evA = res.events.find((e) => e.eventId === 'A')!;
    expect(evA.pass).toBe(true);
    expect(evA.modeLabel).toBe('b2'); // argmax houseProb (0.5 at idx 2)
    expect(evA.centerDepthUsd).toBe(100);
    const evD = res.events.find((e) => e.eventId === 'D')!;
    expect(evD.reachedSeed).toBe(false);
    expect(evD.reasons[0]).toBe('never_seeded');
  });

  it('a flat-open, DEEP center bucket whose EXECUTABLE ask is above the entry cap is NOT a PASS (TEST2-1)', () => {
    const b = (idx: number, mid: number, execAsk: number, houseProb: number, depthUsd: number): RawBucket => ({
      idx, label: `b${idx}`, loF: idx, hiF: idx + 1, mid, bestAsk: mid, execAsk, depthUsd,
      bestBid: mid, sellbackUsd: depthUsd, execBid: mid, sellbackDepthUsd: depthUsd,
      houseProb, tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`,
    });
    // mode = idx 2 (houseProb 0.5); MID 0.12 ≤ peakMidMax 0.18 (flat) and depth 100 ≥ floor, but execAsk 0.30
    // walks above maxEntryPrice 0.20 → selectEntries would reject it → centerDepth (enterable-only) sees $0.
    const buckets = [b(1, 0.12, 0.30, 0.2, 100), b(2, 0.12, 0.30, 0.5, 100), b(3, 0.12, 0.30, 0.2, 100)];
    const res = runSpike([cap({ eventId: 'E', capturedAt: '2026-07-01T00:00:00Z', houseSeeded: true, buckets })], cfg);
    const ev = res.events.find((e) => e.eventId === 'E')!;
    expect(ev.reachedSeed).toBe(true);
    expect(ev.flat).toBe(true); // the BOOK is flat-open (mid ≤ 0.18)…
    expect(ev.centerDepthUsd).toBe(0); // …but no ENTERABLE center depth (ask above the cap)
    expect(ev.pass).toBe(false); // so NOT a GO-eligible market
  });

  it('a capture with no houseProb anywhere is not usable → excluded from the seeded denominator', () => {
    const noHouse = runSpike([cap({ eventId: 'X', capturedAt: '2026-07-01T00:00:00Z', buckets: flatMids })], cfg);
    expect(noHouse.nSeededEvents).toBe(0);
    expect(hasUsableHouse({
      city: 'x', targetDate: 'd', tz: 'Europe/Amsterdam', createdAtGamma: null, hoursSinceListing: 0.5,
      resolvesAt: null, negRisk: true, evVol24h: 1, buckets: [], houseSeeded: false, eventId: 'X',
    })).toBe(false);
  });

  it('prefers the first ALIGNED-houseProb capture over an earlier seed-flag-only one (TEST3-4)', () => {
    const flagOnly = [bucket(1, 0.1, null, 0), bucket(2, 0.1, null, 0)]; // houseSeeded but NO aligned per-bucket houseProb
    const c1 = cap({ eventId: 'F', capturedAt: '2026-07-01T00:00:00Z', houseSeeded: true, buckets: flagOnly, hoursSinceListing: 0.3 });
    const c2 = cap({ eventId: 'F', capturedAt: '2026-07-01T00:20:00Z', houseSeeded: true, buckets: seededFlat, hoursSinceListing: 0.6 });
    const ev = runSpike([c1, c2], cfg).events.find((e) => e.eventId === 'F')!;
    expect(ev.reachedSeed).toBe(true);
    expect(ev.modeLabel).toBe('b2'); // the ALIGNED capture's mode — not the earlier flag-only one (modeIdx −1)
    expect(ev.pass).toBe(true); // would be false (no_house_prob) if it scored the flag-only capture instead
  });

  it('counts captures with no eventId as dropped, without inflating nEvents (TEST3-5)', () => {
    const withId = cap({ eventId: 'G', capturedAt: '2026-07-01T00:00:00Z', houseSeeded: true, buckets: seededFlat });
    const noId = cap({ eventId: null as unknown as string, capturedAt: '2026-07-01T00:05:00Z' });
    const res = runSpike([withId, noId], cfg);
    expect(res.nDroppedNoEventId).toBe(1);
    expect(res.nEvents).toBe(1); // only the eventId'd row forms an event
  });
});

describe('spikeVerdict — the frozen GO/NO-GO gate', () => {
  it('GO when the pass fraction clears the bar AND seed coverage is broad', () => {
    expect(spikeVerdict(base({ nPass: 6, goFraction: 0.6, seededCoverage: 0.8 }), cfg).label).toBe('GO');
  });

  it('NO-GO when the pass fraction is below the go bar', () => {
    expect(spikeVerdict(base({ nPass: 4, goFraction: 0.4, seededCoverage: 0.8 }), cfg).label).toBe('NO-GO');
  });

  it('INSUFFICIENT_DATA below ≥1 week of distinct TARGET dates or the minimum seeded-event count', () => {
    expect(spikeVerdict(base({ nDistinctTargetDates: 3 }), cfg).label).toBe('INSUFFICIENT_DATA');
    expect(spikeVerdict(base({ nSeededEvents: 3 }), cfg).label).toBe('INSUFFICIENT_DATA');
    expect(spikeVerdict(base({ nCaptures: 0 }), cfg).label).toBe('INSUFFICIENT_DATA');
  });

  // CAP-review A1 (the 45-city expansion's binding gate fix): nCaptureDays measures only CRON UPTIME — at 45
  // cities one daily batch lists ~45 markets for a SINGLE target_date, so ≥8 seeded events + ≥7 capture-days can
  // still be ~1 independent weather-day. The verdict must gate on distinct TARGET dates, not capture-days.
  it('does NOT proceed to a verdict on cron uptime alone — high capture-days but few target-dates is INSUFFICIENT', () => {
    // plenty of capture-days + seeded events, but the seeded events span only 2 weather-days → INSUFFICIENT, not GO
    const v = spikeVerdict(base({ nCaptureDays: 14, nDistinctTargetDates: 2, nSeededEvents: 45, nPass: 30, goFraction: 30 / 45, seededCoverage: 0.9 }), cfg);
    expect(v.label).toBe('INSUFFICIENT_DATA');
    expect(v.reason).toContain('target date');
  });

  // TEST2-4 — sufficiency is checked BEFORE the coverage floor: a thin EARLY universe that is also low-coverage
  // must read INSUFFICIENT_DATA (keep capturing), NOT NO-GO (a premature KILL). Locks the branch ordering.
  it('low coverage AND too few seeded events → INSUFFICIENT_DATA (not a premature NO-GO)', () => {
    expect(spikeVerdict(base({ nSeededEvents: 3, seededCoverage: 0.1, goFraction: 0.9, nPass: 3 }), cfg).label).toBe('INSUFFICIENT_DATA');
  });

  // TEST-1 (the decisive adversarial property): a high goFraction over a flat-open seeded MINORITY must NOT GO.
  it('NO-GO when most listed events never seed while flat-open, even if the seeded subset all passes (R-13 mode b)', () => {
    const v = spikeVerdict(base({ nEvents: 100, nSeededEvents: 10, seededCoverage: 0.1, nPass: 9, goFraction: 0.9 }), cfg);
    expect(v.label).toBe('NO-GO');
    expect(v.reason).toContain('coverage');
  });

  it('the coverage floor binds exactly at MIN_SEEDED_COVERAGE', () => {
    const justBelow = spikeVerdict(base({ seededCoverage: MIN_SEEDED_COVERAGE - 0.01, goFraction: 0.9, nPass: 9 }), cfg);
    const atFloor = spikeVerdict(base({ seededCoverage: MIN_SEEDED_COVERAGE, goFraction: 0.9, nPass: 9 }), cfg);
    expect(justBelow.label).toBe('NO-GO');
    expect(atFloor.label).toBe('GO'); // ≥ floor passes
  });
});

describe('runSpike — robustness on real prod-scale data (F1/F2/F4)', () => {
  it('does NOT RangeError on a large multi-week panel (F1 — no Math.max(...) array spread)', () => {
    // the spike runs over a FULL multi-week panel (~10^4 rows/day); spreading the timestamp array into
    // Math.max/min throws a call-stack RangeError above ~10^5 elements, suppressing the verdict entirely.
    const N = 200_000;
    const big: RawCaptureRow[] = Array.from({ length: N }, (_, i) =>
      cap({ eventId: 'BIG', capturedAt: new Date(Date.UTC(2026, 6, 1) + i * 60_000).toISOString(), houseSeeded: true, buckets: seededFlat }),
    );
    let res: SpikeResult | undefined;
    expect(() => { res = runSpike(big, cfg); }).not.toThrow();
    expect(res!.nCaptures).toBe(N);
    expect(res!.spanDays).toBeGreaterThan(100); // ~138d of minute-spaced rows — the span path ran
  });

  it('counts DISTINCT UTC capture-days, independent of the host timezone (F2)', () => {
    // 1h apart but across UTC midnight → 2 distinct UTC days …
    const two = runSpike([
      cap({ eventId: 'U', capturedAt: '2026-07-01T23:30:00Z', houseSeeded: true, buckets: seededFlat }),
      cap({ eventId: 'U', capturedAt: '2026-07-02T00:30:00Z', houseSeeded: true, buckets: seededFlat }),
    ], cfg);
    expect(two.nCaptureDays).toBe(2);
    // … 23h apart but within ONE UTC day → 1 distinct day (a raw local-string slice could miscount either)
    const one = runSpike([
      cap({ eventId: 'V', capturedAt: '2026-07-01T00:30:00Z', houseSeeded: true, buckets: seededFlat }),
      cap({ eventId: 'V', capturedAt: '2026-07-01T23:30:00Z', houseSeeded: true, buckets: seededFlat }),
    ], cfg);
    expect(one.nCaptureDays).toBe(1);
  });

  it('reports center_ask_above_cap (not below_depth_floor) when a DEEP center bucket is priced out (F4)', () => {
    const b = (idx: number, mid: number, execAsk: number, houseProb: number, depthUsd: number): RawBucket => ({
      ...bucket(idx, mid, houseProb, depthUsd), execAsk,
    });
    // mode idx 2, flat (mid 0.12), depth 100 ≥ floor, but execAsk 0.30 > cap 0.20 → priced out, NOT thin.
    const buckets = [b(1, 0.12, 0.3, 0.2, 100), b(2, 0.12, 0.3, 0.5, 100), b(3, 0.12, 0.3, 0.2, 100)];
    const ev = runSpike([cap({ eventId: 'P', capturedAt: '2026-07-01T00:00:00Z', houseSeeded: true, buckets })], cfg).events[0]!;
    expect(ev.centerDepthUsd).toBe(0);
    expect(ev.reasons).toContain('center_ask_above_cap');
    expect(ev.reasons).not.toContain('below_depth_floor'); // the depth was fine — the price wasn't
  });
});
