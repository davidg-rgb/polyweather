/**
 * Tests for buildGoogleView (core/sim/google-bucket-view) — the /convergence page view-model, repurposed as the
 * GOOGLE-PICKS-BUCKET forward paper panel ("Test 2"). The replay engine + the raw mappers have their own suites;
 * this exercises the AGGREGATION the page renders: entry logging keyed to the GOOGLE-predicted bucket, exit-kind
 * classification, per-day chances, the fictive money tracker, the §9R-E gate counts, the five-TP-variant exit
 * COMPARISON (same fixed entry, monotone exit mix, per-variant P&L), and — load-bearing for the ~1-week seed —
 * Google COVERAGE (markets with no Google feed are counted + surfaced, never crash).
 */
import { describe, expect, it } from 'vitest';
import { GOOGLE_DEFAULTS, type GoogleBracketCfg } from '../src/sim/google-bucket-replay.ts';
import { buildGoogleView, GOOGLE_TP_VARIANTS, type RawGooglePrediction } from '../src/sim/google-bucket-view.ts';
import type { RawBucket, RawCaptureRow } from '../src/sim/opening-bracket-ingest.ts';

// pins askMax 0.15 + excludeFahrenheit false so the existing 0.14-ask °C fixtures are insulated from the
// production default changes (askMax 0.12, °C-only). The new defaults are asserted directly in the suites below.
const cfg: GoogleBracketCfg = { ...GOOGLE_DEFAULTS, askMax: 0.15, excludeFahrenheit: false, cities: ['amsterdam'] };
const TZ = 'Europe/Amsterdam';
const DATE = '2026-07-01';

const bucket = (idx: number, label: string, over: Partial<RawBucket> = {}): RawBucket => ({
  idx,
  label,
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
  houseProb: 0.1,
  tokenYes: `y${idx}`,
  tokenNo: `n${idx}`,
  conditionId: `c${idx}`,
  ...over,
});

/** a tailed 5-bucket °C ladder; `center` shapes idx2 (= '16°C', the bucket Google's 16.4°C forecast picks). */
const ladder = (center: Partial<RawBucket> = {}): RawBucket[] => [
  bucket(0, '14°C or below'),
  bucket(1, '15°C'),
  bucket(2, '16°C', center),
  bucket(3, '17°C'),
  bucket(4, '18°C or higher'),
];

const row = (eventId: string, capturedAt: string, age: number, center: Partial<RawBucket> = {}): RawCaptureRow => ({
  eventId,
  capturedAt,
  city: 'amsterdam',
  targetDate: DATE,
  tzName: TZ,
  createdAtGamma: null,
  resolvesAt: null,
  hoursSinceListing: age,
  peakMid: 0.1,
  isFlatOpen: true,
  houseSeeded: true,
  buckets: ladder(center),
  evVol24h: 5000,
  negRisk: true,
});

/** google forecast 16.4°C ⇒ floor 16 ⇒ idx2 ('16°C') is the predicted (bought) bucket. */
const gp = (eventId: string): RawGooglePrediction => ({ eventId, tmaxC: 16.4, unit: 'C', tz: TZ });

describe('buildGoogleView — the /convergence (Google-picks-bucket) view-model', () => {
  // TP: enter idx2 at execAsk 0.14 (< 0.15), then execBid re-rates to 0.35 (≥ tpAbs 0.30) → take-profit.
  const tpEvent: RawCaptureRow[] = [
    row('TP', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }),
    row('TP', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: 0.35 }),
  ];
  // OPEN: enter idx2 at 0.14, then execBid holds at 0.12 (below the 0.15 entry, no SL, below TP 0.30) → mark.
  const openEvent: RawCaptureRow[] = [
    row('OPEN', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }),
    row('OPEN', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: 0.12 }),
  ];

  const view = buildGoogleView([...tpEvent, ...openEvent], [], [gp('TP'), gp('OPEN')], cfg);

  it('logs one entry per entered market keyed to the GOOGLE-predicted bucket', () => {
    expect(view.nFreshEvents).toBe(2);
    expect(view.nGoogleEvents).toBe(2);
    expect(view.entries).toHaveLength(2);
    const tp = view.entries.find((e) => e.eventId === 'TP')!;
    const op = view.entries.find((e) => e.eventId === 'OPEN')!;
    expect(tp.exitKind).toBe('take_profit');
    expect(tp.status).toBe('realized');
    expect(tp.entryLabel).toBe('16°C'); // the Google-predicted bucket (16.4°C floored → 16 → idx2)
    expect(tp.predictedNative).toBe(16);
    expect(tp.googleTmaxC).toBeCloseTo(16.4, 9);
    expect(tp.entryPrice).toBeCloseTo(0.15, 9); // 0.14 + slippage
    expect(tp.netPnlUsd).toBeGreaterThan(0);
    expect(op.exitKind).toBe('open_marked');
    expect(op.status).toBe('open');
    expect(op.netPnlUsd).toBeLessThan(0); // bought 0.15, marked 0.12
  });

  it('builds the fictive money tracker at the fixed per-entry stake', () => {
    const m = view.money;
    expect(m.perEntryStakeUsd).toBe(cfg.perPositionUsd); // $20
    expect(m.nEntries).toBe(2);
    expect(m.nRealized).toBe(1);
    expect(m.nOpen).toBe(1);
    expect(m.nWins).toBe(1);
    expect(m.nLosses).toBe(0);
    expect(m.deployedUsd).toBeCloseTo(40, 0); // 2 × ~$20
    expect(m.netPnlUsd).toBeCloseTo(m.realizedPnlUsd + m.openMarkedPnlUsd, 6);
    expect(m.equity).toHaveLength(1); // one target day
    expect(m.equity[0]!.cumUsd).toBeCloseTo(m.netPnlUsd, 6);
  });

  it('computes per-day chances (considered vs entered, fire rate)', () => {
    expect(view.perDay).toHaveLength(1);
    expect(view.perDay[0]!.date).toBe(DATE);
    expect(view.perDay[0]!.considered).toBe(2);
    expect(view.perDay[0]!.entered).toBe(2);
    expect(view.perDay[0]!.firePct).toBeCloseTo(1, 9);
  });

  it('exposes the REALIZED-only §9R-E gate counts + the config thresholds', () => {
    expect(view.askMax).toBe(0.15);
    expect(view.tpAbs).toBe(0.3);
    expect(view.slAbs).toBe(0); // the no-SL sentinel
    expect(view.gate.nMarkets).toBe(1); // only the realized TP feeds the gate; the OPEN (mtm) is excluded
    expect(view.gate.minMarkets).toBe(40);
    expect(view.gate.label).toBe('INSUFFICIENT_DATA'); // 1 < 40
  });

  it('defaults cityErrors to 0 (the handler overrides it)', () => {
    expect(view.cityErrors).toBe(0);
  });
});

// ── five-TP-variant exit comparison: same fixed entry, monotone exit mix, per-variant P&L ────────────────
describe('buildGoogleView — five-TP-variant exit comparison (same fixed entry)', () => {
  // a market that enters cheap (execAsk 0.14 < 0.15) then peaks at `peak` on the next tick, then resolves.
  const mkt = (id: string, peak: number): RawCaptureRow[] => [
    row(id, '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }),
    row(id, '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: peak }),
  ];

  it('sweeps {0.30..0.50} over the SAME entry: identical nEntered, monotone exit mix, per-variant P&L', () => {
    // one controlled market: peaks at 0.40, resolves LOSE. TP-hit for tp ≤ 0.40 (all sell at the SAME 0.40 tick),
    // held→lose for tp > 0.40. So the low-TP variants share an identical gain; the high-TP variants share a loss.
    const v = buildGoogleView(mkt('P40', 0.4), [{ id: 'P40', winnerIdx: 9, gradingMismatch: false }], [gp('P40')], cfg);
    const vs = v.tpComparison.variants;
    expect(vs.map((x) => x.tpAbs)).toEqual([...GOOGLE_TP_VARIANTS]);
    expect(v.tpComparison.nEntered).toBe(1);
    expect(vs.every((x) => x.nTrades === 1)).toBe(true); // entry is TP-independent → identical population
    expect(vs.map((x) => x.nTpHit)).toEqual([1, 1, 1, 0, 0]);
    expect(vs.map((x) => x.nHeldToResolution)).toEqual([0, 0, 0, 1, 1]);
    // P&L: the three TP-hit variants sold at the SAME 0.40 tick → identical gain; the two held variants lost.
    expect(vs[0]!.netPnlUsd).toBeCloseTo(vs[1]!.netPnlUsd, 9);
    expect(vs[1]!.netPnlUsd).toBeCloseTo(vs[2]!.netPnlUsd, 9);
    expect(vs[0]!.netPnlUsd).toBeGreaterThan(0);
    expect(vs[3]!.netPnlUsd).toBeLessThan(0);
    expect(vs[3]!.netPnlUsd).toBeCloseTo(vs[4]!.netPnlUsd, 9);
    // all resolved (no open) → realizedPnl == netPnl; winRate 1 on the TP-hit gain, 0 on the held-lose.
    expect(vs[0]!.realizedPnlUsd).toBeCloseTo(vs[0]!.netPnlUsd, 9);
    expect(vs[0]!.winRate).toBeCloseTo(1, 9);
    expect(vs[3]!.winRate).toBeCloseTo(0, 9);
  });

  it('TP-hit counts are monotone non-increasing (held-to-resolution non-decreasing) as tpAbs rises', () => {
    // three markets peaking at 0.35 / 0.45 / 0.55, all resolving WIN — a spread across the TP grid.
    const v = buildGoogleView(
      [...mkt('S35', 0.35), ...mkt('S45', 0.45), ...mkt('S55', 0.55)],
      [
        { id: 'S35', winnerIdx: 2, gradingMismatch: false },
        { id: 'S45', winnerIdx: 2, gradingMismatch: false },
        { id: 'S55', winnerIdx: 2, gradingMismatch: false },
      ],
      [gp('S35'), gp('S45'), gp('S55')],
      cfg,
    );
    const vs = v.tpComparison.variants;
    expect(v.tpComparison.nEntered).toBe(3);
    expect(vs.every((x) => x.nTrades === 3)).toBe(true); // same fixed entry → same population every variant
    expect(vs.map((x) => x.nTpHit)).toEqual([3, 3, 2, 2, 1]);
    expect(vs.map((x) => x.nHeldToResolution)).toEqual([0, 0, 1, 1, 2]);
    for (let i = 1; i < vs.length; i++) {
      expect(vs[i]!.nTpHit).toBeLessThanOrEqual(vs[i - 1]!.nTpHit);
      expect(vs[i]!.nHeldToResolution).toBeGreaterThanOrEqual(vs[i - 1]!.nHeldToResolution);
      expect(vs[i]!.nTpHit + vs[i]!.nHeldToResolution).toBe(vs[i]!.nTrades); // all resolved (no open)
    }
  });
});

// ── Google coverage: markets with no Google feed are counted + surfaced, never crash ────────────────────
describe('buildGoogleView — Google coverage (the ~1-week forward seed)', () => {
  const withGoogle: RawCaptureRow[] = [
    row('HASG', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }),
    row('HASG', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: 0.35 }),
  ];
  // a fresh market in a city with NO Google feed (or a null forecast) — must be counted, not entered, not crash.
  const noGoogle: RawCaptureRow[] = [
    { ...row('NOG', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }), city: 'karachi' },
    { ...row('NOG', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: 0.35 }), city: 'karachi' },
  ];

  it('counts fresh markets without a Google forecast into nNoGoogleEvents + citiesNoGoogle, enters only those with one', () => {
    const v = buildGoogleView(
      [...withGoogle, ...noGoogle],
      [],
      [gp('HASG'), { eventId: 'NOG', tmaxC: null, unit: 'C', tz: TZ }], // NOG has a null forecast
      cfg,
    );
    expect(v.nFreshEvents).toBe(2);
    expect(v.nGoogleEvents).toBe(1);
    expect(v.nNoGoogleEvents).toBe(1);
    expect(v.citiesNoGoogle).toEqual(['karachi']);
    expect(v.entries.map((e) => e.eventId)).toEqual(['HASG']); // only the Google-covered market traded
  });

  it('is total on empty input', () => {
    const empty = buildGoogleView([], [], [], cfg);
    expect(empty.entries).toEqual([]);
    expect(empty.perDay).toEqual([]);
    expect(empty.money.nEntries).toBe(0);
    expect(empty.money.equity).toEqual([]);
    expect(empty.nFreshEvents).toBe(0);
    expect(empty.nGoogleEvents).toBe(0);
    expect(empty.gate.label).toBe('INSUFFICIENT_DATA');
  });
});

// ── grading_mismatch exclusion: the gm-excluded population drives entries / money / per-day / gate ──────
describe('buildGoogleView — grading_mismatch is excluded everywhere (one population)', () => {
  const clean: RawCaptureRow[] = [
    row('CLEAN', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }),
    row('CLEAN', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: 0.35 }),
  ];
  const mm: RawCaptureRow[] = [
    { ...row('MM', '2026-07-02T08:00:00.000Z', 0.2, { execAsk: 0.14, execBid: 0.1 }), targetDate: '2026-07-02' },
    { ...row('MM', '2026-07-02T08:00:30.000Z', 0.3, { execAsk: 0.14, execBid: 0.35 }), targetDate: '2026-07-02' },
  ];

  it('drops the ambiguous-payout market from entries, money, per-day, coverage AND the gate counts', () => {
    const v = buildGoogleView(
      [...clean, ...mm],
      [{ id: 'MM', winnerIdx: 2, gradingMismatch: true }],
      [gp('CLEAN'), { ...gp('MM'), tmaxC: 16.4 }],
      cfg,
    );
    expect(v.entries.map((e) => e.eventId)).toEqual(['CLEAN']);
    expect(v.money.nEntries).toBe(1);
    expect(v.perDay.map((d) => d.date)).toEqual(['2026-07-01']); // the 07-02 mm day is gone
    expect(v.nFreshEvents).toBe(1);
    expect(v.nGoogleEvents).toBe(1);
    expect(v.gate.nMarkets).toBe(1);
  });
});

// ── °C-only mode: US °F markets are excluded (excludeFahrenheit) ──────────────────────────────────────────
describe('buildGoogleView — °C-only mode excludes US °F markets', () => {
  // a °F ladder (US market): Google 34°C = 93.2°F floors to 93 → idx2 ('92-93°F') is the predicted bucket.
  const fLadder = (center: Partial<RawBucket> = {}): RawBucket[] => [
    bucket(0, '89°F or below'),
    bucket(1, '90-91°F'),
    bucket(2, '92-93°F', center),
    bucket(3, '94-95°F'),
    bucket(4, '96°F or higher'),
  ];
  const fRow = (eventId: string, capturedAt: string, age: number, center: Partial<RawBucket> = {}): RawCaptureRow => ({
    ...row(eventId, capturedAt, age, center),
    city: 'dallas',
    buckets: fLadder(center),
  });
  // a °F market that WOULD enter (cheap 0.11 ask, bucketable forecast) but for the °C-only filter.
  const fEvent: RawCaptureRow[] = [
    fRow('FAHR', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.11, execBid: 0.1 }),
    fRow('FAHR', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.35 }),
  ];
  const cEvent: RawCaptureRow[] = [
    row('CELS', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.11, execBid: 0.1 }),
    row('CELS', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.35 }),
  ];
  const google: RawGooglePrediction[] = [{ eventId: 'FAHR', tmaxC: 34, unit: 'F', tz: TZ }, gp('CELS')];

  it('excludeFahrenheit ON: the °F market is skipped (nExcludedFahrenheit), only the °C market trades', () => {
    const v = buildGoogleView([...fEvent, ...cEvent], [], google, { ...cfg, excludeFahrenheit: true, askMax: 0.12 });
    expect(v.excludeFahrenheit).toBe(true);
    expect(v.nExcludedFahrenheit).toBe(1);
    expect(v.nGoogleEvents).toBe(1); // only the °C market is actionable
    expect(v.entries.map((e) => e.eventId)).toEqual(['CELS']);
  });

  it('excludeFahrenheit OFF: the °F market IS entered — proving the °C-only filter is what excludes it', () => {
    const v = buildGoogleView([...fEvent, ...cEvent], [], google, { ...cfg, excludeFahrenheit: false, askMax: 0.12 });
    expect(v.excludeFahrenheit).toBe(false);
    expect(v.nExcludedFahrenheit).toBe(0);
    expect(v.nGoogleEvents).toBe(2);
    expect(v.entries.map((e) => e.eventId).sort()).toEqual(['CELS', 'FAHR']);
  });
});
