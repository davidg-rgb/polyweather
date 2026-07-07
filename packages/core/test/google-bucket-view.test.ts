/**
 * Tests for buildGoogleView (core/sim/google-bucket-view) — the /convergence page view-model, repurposed as the
 * GOOGLE-PICKS-BUCKET forward paper panel ("Test 2"). The replay engine + the raw mappers have their own suites;
 * this exercises the AGGREGATION the page renders: entry logging keyed to the GOOGLE-predicted bucket, exit-kind
 * classification, per-day chances, the fictive money tracker, the §9R-E gate counts, and — load-bearing for the
 * ~1-week seed — Google COVERAGE (markets with no Google feed are counted + surfaced, never crash).
 */
import { describe, expect, it } from 'vitest';
import { GOOGLE_DEFAULTS, type GoogleBracketCfg } from '../src/sim/google-bucket-replay.ts';
import { buildGoogleView, type RawGooglePrediction } from '../src/sim/google-bucket-view.ts';
import type { RawBucket, RawCaptureRow } from '../src/sim/opening-bracket-ingest.ts';

const cfg: GoogleBracketCfg = { ...GOOGLE_DEFAULTS, cities: ['amsterdam'] };
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
  // TP: enter idx2 at execAsk 0.17, then execBid re-rates to 0.35 (≥ tpAbs 0.30) → take-profit.
  const tpEvent: RawCaptureRow[] = [
    row('TP', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.17, execBid: 0.1 }),
    row('TP', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.17, execBid: 0.35 }),
  ];
  // OPEN: enter idx2 at 0.17, then execBid holds at 0.16 (between SL 0.15 and TP 0.30) → unresolved mark.
  const openEvent: RawCaptureRow[] = [
    row('OPEN', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.17, execBid: 0.1 }),
    row('OPEN', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.17, execBid: 0.16 }),
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
    expect(tp.entryPrice).toBeCloseTo(0.18, 9); // 0.17 + slippage
    expect(tp.netPnlUsd).toBeGreaterThan(0);
    expect(op.exitKind).toBe('open_marked');
    expect(op.status).toBe('open');
    expect(op.netPnlUsd).toBeLessThan(0); // bought 0.18, marked 0.16
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
    expect(view.askMax).toBe(0.18);
    expect(view.tpAbs).toBe(0.3);
    expect(view.slAbs).toBe(0.15);
    expect(view.gate.nMarkets).toBe(1); // only the realized TP feeds the gate; the OPEN (mtm) is excluded
    expect(view.gate.minMarkets).toBe(40);
    expect(view.gate.label).toBe('INSUFFICIENT_DATA'); // 1 < 40
  });

  it('defaults cityErrors to 0 (the handler overrides it)', () => {
    expect(view.cityErrors).toBe(0);
  });
});

// ── Google coverage: markets with no Google feed are counted + surfaced, never crash ────────────────────
describe('buildGoogleView — Google coverage (the ~1-week forward seed)', () => {
  const withGoogle: RawCaptureRow[] = [
    row('HASG', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.17, execBid: 0.1 }),
    row('HASG', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.17, execBid: 0.35 }),
  ];
  // a fresh market in a city with NO Google feed (or a null forecast) — must be counted, not entered, not crash.
  const noGoogle: RawCaptureRow[] = [
    { ...row('NOG', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.17, execBid: 0.1 }), city: 'karachi' },
    { ...row('NOG', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.17, execBid: 0.35 }), city: 'karachi' },
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
    row('CLEAN', '2026-07-01T08:00:00.000Z', 0.2, { execAsk: 0.17, execBid: 0.1 }),
    row('CLEAN', '2026-07-01T08:00:30.000Z', 0.3, { execAsk: 0.17, execBid: 0.35 }),
  ];
  const mm: RawCaptureRow[] = [
    { ...row('MM', '2026-07-02T08:00:00.000Z', 0.2, { execAsk: 0.17, execBid: 0.1 }), targetDate: '2026-07-02' },
    { ...row('MM', '2026-07-02T08:00:30.000Z', 0.3, { execAsk: 0.17, execBid: 0.35 }), targetDate: '2026-07-02' },
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
