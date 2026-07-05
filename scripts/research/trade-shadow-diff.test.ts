/**
 * Tests for the SHADOW-DIFF harness (scripts/research/trade-shadow-diff.ts) — the T5 build-only screen that
 * diffs the dry-run daemon's ledger (side A) against the maker-exit replay (side B). NO network, NO DB: every
 * input is a fixture (raw captures + fabricated ledger rows). Covers the pure pipeline — buildCaptureIndex,
 * normalizeLedger, computeShadowDiff (each diff dimension + the ranked divergence score + the summary), the
 * expected-divergence-class tagging, render/renderJson totality, and the CLI-time sanity() self-test.
 *
 * The harness CANNOT run against a DB until 0082 is applied AND the dry-run daemon has rows; these fixtures
 * prove the diff LOGIC forward so a divergence the shadow week produces is scored + surfaced correctly.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCaptureIndex,
  computeShadowDiff,
  normalizeLedger,
  render,
  renderJson,
  replayDecisionOf,
  sanity,
  EXPECTED_DIVERGENCE_CLASSES,
  type CaptureIndex,
  type DryRunLedgerRow,
  type RawBucket,
  type RawCaptureRow,
} from './trade-shadow-diff.ts';
import { buildEvents } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import { makerExitCfg } from '../../packages/core/src/sim/opening-maker-exit-replay.ts';

const TZ = 'Europe/Amsterdam';
const DATE = '2026-07-06';
const CFG = makerExitCfg(['amsterdam']);

// ── fixtures: a ladder that ENTERS (center idx 2) + a 3rd tick that takes the maker profit ──
const bk = (eventId: string, idx: number, over: Partial<RawBucket> = {}): RawBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
  bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: null,
  tokenYes: `${eventId}-y${idx}`, tokenNo: `${eventId}-n${idx}`, conditionId: `${eventId}-c${idx}`, ...over,
});
const ladder = (eventId: string, center: Partial<RawBucket> = {}): RawBucket[] => [
  bk(eventId, 0, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
  bk(eventId, 1, { houseProb: 0.2 }),
  bk(eventId, 2, { houseProb: 0.35, depthUsd: 200, ...center }),
  bk(eventId, 3, { houseProb: 0.2 }),
  bk(eventId, 4, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
];
const row = (eventId: string, capturedAt: string, age: number, center: Partial<RawBucket> = {}): RawCaptureRow => ({
  eventId, capturedAt, city: 'amsterdam', targetDate: DATE, tzName: TZ, createdAtGamma: null, resolvesAt: null,
  hoursSinceListing: age, peakMid: 0.1, isFlatOpen: true, houseSeeded: true, buckets: ladder(eventId, center), evVol24h: 5000, negRisk: true,
});
const evtRows = (eventId: string): RawCaptureRow[] => [
  row(eventId, '2026-07-06T08:00:00.000Z', 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 }),
  row(eventId, '2026-07-06T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.1 }),
  row(eventId, '2026-07-06T08:01:00.000Z', 0.35, { execBid: 0.45 }),
];
const led = (over: Partial<DryRunLedgerRow>): DryRunLedgerRow => ({
  mode: 'dry-run', intentKey: 'k', clientOrderId: 'co', orderId: 'dry-run:co', marketId: 'E1-c2', tokenId: 'E1-y2',
  side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.12, size: 66, sizeMatched: 0, avgPrice: null,
  tradeDate: DATE, status: 'placed', createdAt: '2026-07-06T08:00:10.000Z', placedAt: '2026-07-06T08:00:10.000Z',
  fillNotionalUsd: 0, fillFeeUsd: 0, fillSize: 0, ...over,
});

const twoEvents = (): RawCaptureRow[] => [...evtRows('E1'), ...evtRows('E2')];

describe('buildCaptureIndex — conditionId→event Rosetta + center + resolution anchor', () => {
  it('maps each bucket conditionId to its event and picks the argmax-houseProb center', () => {
    const idx = buildCaptureIndex(twoEvents());
    expect(idx.market.get('E1-c2')?.eventId).toBe('E1');
    expect(idx.market.get('E2-c0')?.eventId).toBe('E2');
    expect(idx.event.get('E1')?.centerBucketIdx).toBe(2); // idx 2 = houseProb 0.35 (max)
    expect(idx.event.get('E1')?.centerConditionId).toBe('E1-c2');
    expect(idx.resolvesByEvent.get('E1')).toBeNull(); // no resolvesAt in the fixture → noon fallback
  });

  it('is total on empty / null-eventId input', () => {
    const idx = buildCaptureIndex([]);
    expect(idx.market.size).toBe(0);
    expect(idx.event.size).toBe(0);
    expect(buildCaptureIndex([row('', '2026-07-06T08:00:00.000Z', 0.2)] as unknown as RawCaptureRow[]).event.size).toBeGreaterThanOrEqual(0);
  });
});

describe('normalizeLedger — group rows into per-market decisions + reprice counting', () => {
  it('collapses two entry rows for one market into one decision with nReprices=1', () => {
    const idx = buildCaptureIndex(twoEvents());
    const decs = normalizeLedger(
      [
        led({ clientOrderId: 'a', status: 'canceled', createdAt: '2026-07-06T08:00:05.000Z' }),
        led({ clientOrderId: 'b', status: 'placed', createdAt: '2026-07-06T08:00:40.000Z' }),
      ],
      idx,
    );
    expect(decs).toHaveLength(1);
    expect(decs[0]!.entered).toBe(true);
    expect(decs[0]!.nReprices).toBe(1);
    expect(decs[0]!.bucketIdx).toBe(2);
    expect(decs[0]!.entryFilledShares).toBe(0); // dry-run never fills
    expect(decs[0]!.exitKind).toBeNull(); // no exit rows in dry-run
    expect(decs[0]!.unmapped).toBe(false);
  });

  it('flags an unmapped market (conditionId not in the capture window)', () => {
    const idx = buildCaptureIndex(twoEvents());
    const decs = normalizeLedger([led({ marketId: 'ghost', tokenId: 'g' })], idx);
    expect(decs[0]!.unmapped).toBe(true);
    expect(decs[0]!.eventId).toBeNull();
  });
});

describe('replayDecisionOf — a not-entered replay carries its reason', () => {
  it('maps a NOT_EXECUTED trade to entered:false + reason', () => {
    const dec = replayDecisionOf({ executed: false, exitKind: 'never_enterable' } as never);
    expect(dec.entered).toBe(false);
    expect(dec.notEnteredReason).toBe('never_enterable');
  });
});

describe('computeShadowDiff — the diff dimensions, ranking, and summary', () => {
  const idx = buildCaptureIndex(twoEvents());
  const events = buildEvents(twoEvents(), new Map());
  const ledger: DryRunLedgerRow[] = [
    led({ clientOrderId: 'e1a', marketId: 'E1-c2', status: 'canceled', createdAt: '2026-07-06T08:00:05.000Z' }),
    led({ clientOrderId: 'e1b', marketId: 'E1-c2', status: 'placed', createdAt: '2026-07-06T08:00:40.000Z' }),
    led({ clientOrderId: 'zz', marketId: 'zzz', tokenId: 'yz' }),
  ];
  const report = computeShadowDiff(events, idx, ledger, CFG, 3);

  it('replays BOTH fixture events (entered + maker take-profit) — side B is live', () => {
    expect(events).toHaveLength(2);
    const e1b = report.rows.find((r) => r.eventId === 'E1')!.b;
    expect(e1b.entered).toBe(true);
    expect(e1b.bucketIdx).toBe(2);
    expect(e1b.exitKind).toBe('maker_take_profit');
  });

  it('AGREEMENT row (E1): both entered, same bucket, tagged dry-run-no-fill + reprice, LOW score', () => {
    const e1 = report.rows.find((r) => r.eventId === 'E1')!;
    expect(e1.enteredAgree).toBe(true);
    expect(e1.bucketAgree).toBe(true);
    expect(e1.a.nReprices).toBe(1);
    expect(e1.notes.some((n) => n.includes('EXPECTED(dry-run-no-fill)'))).toBe(true);
    expect(e1.notes.some((n) => n.includes('EXPECTED(reprice-vs-taker-fallback)'))).toBe(true);
    expect(e1.divergenceScore).toBeLessThan(50); // agreement — the expected classes are NOT scored
  });

  it('ENTER-DISAGREE rows (E2 B-only, zzz A-only) score ≥100 and rank first', () => {
    const e2 = report.rows.find((r) => r.eventId === 'E2')!;
    const zz = report.rows.find((r) => r.key.startsWith('unmapped:zzz'))!;
    expect(e2.a.entered).toBe(false);
    expect(e2.b.entered).toBe(true);
    expect(e2.divergenceScore).toBeGreaterThanOrEqual(100);
    expect(zz.a.entered).toBe(true);
    expect(zz.a.unmapped).toBe(true);
    expect(zz.divergenceScore).toBeGreaterThanOrEqual(100);
    // the ranked table puts the divergences above the agreement row
    expect(report.rows[0]!.divergenceScore).toBeGreaterThanOrEqual(report.rows[report.rows.length - 1]!.divergenceScore);
  });

  it('summary tallies the four join buckets + the expected-class counts', () => {
    const s = report.summary;
    expect(s.nEvents).toBe(3);
    expect(s.nBothEntered).toBe(1);
    expect(s.nAOnly).toBe(1);
    expect(s.nBOnly).toBe(1);
    expect(s.nUnmappedA).toBe(1);
    expect(s.nARepricesTotal).toBe(1);
    expect(s.nAEntriesUnfilled).toBe(2); // E1's entry + zzz's entry — both dry-run-unfilled
    expect(s.runnable).toBe(true);
    expect(Object.keys(s.exitKindDistB)).toContain('maker_take_profit');
  });

  it('surfaces a BUCKET disagreement when A entered a different bucket than B', () => {
    // A entered E1's idx-0 bucket (E1-c0), B enters idx 2 → bucket divergence + consensus-source tag.
    const ledgerDiffBucket: DryRunLedgerRow[] = [led({ marketId: 'E1-c0', tokenId: 'E1-y0' })];
    const rep = computeShadowDiff(events, idx, ledgerDiffBucket, CFG, 3);
    const e1 = rep.rows.find((r) => r.eventId === 'E1')!;
    expect(e1.a.entered).toBe(true);
    expect(e1.a.bucketIdx).toBe(0);
    expect(e1.b.bucketIdx).toBe(2);
    expect(e1.bucketAgree).toBe(false);
    expect(e1.divergenceScore).toBeGreaterThanOrEqual(50);
    expect(e1.notes.some((n) => n.includes('BUCKET DISAGREE'))).toBe(true);
  });
});

describe('render / renderJson — totality incl. the NOT-RUNNABLE empty-ledger path', () => {
  const idx: CaptureIndex = buildCaptureIndex(twoEvents());
  const events = buildEvents(twoEvents(), new Map());

  it('does not throw with rows, and the JSON carries the summary + rows', () => {
    const report = computeShadowDiff(events, idx, [led({ marketId: 'E1-c2' })], CFG, 3);
    expect(() => render(report, 30, () => {})).not.toThrow();
    const parsed = JSON.parse(renderJson(report));
    expect(parsed.summary).toBeTruthy();
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.expectedDivergenceClasses.length).toBe(EXPECTED_DIVERGENCE_CLASSES.length);
  });

  it('marks NOT RUNNABLE with an empty ledger and never throws', () => {
    const report = computeShadowDiff(events, idx, [], CFG, 3);
    expect(report.summary.runnable).toBe(false);
    expect(() => render(report, 30, () => {})).not.toThrow();
  });

  it('is total on all-empty input', () => {
    const empty = computeShadowDiff([], { market: new Map(), event: new Map(), resolvesByEvent: new Map() }, [], CFG, 3);
    expect(empty.rows).toEqual([]);
    expect(() => render(empty, 30, () => {})).not.toThrow();
  });
});

describe('sanity — the CLI self-test passes (no DB, no network)', () => {
  it('runs clean', () => {
    expect(() => sanity()).not.toThrow();
  });
});
