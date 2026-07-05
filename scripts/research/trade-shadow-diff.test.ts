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

  it('anchors resolvesByEvent to the first finite resolvesAt (the maker-exit time-stop clock)', () => {
    const RESOLVES = '2026-07-07T22:00:00.000Z';
    const rows = evtRows('E1').map((r, i) => (i === 0 ? { ...r, resolvesAt: RESOLVES } : r));
    const idx = buildCaptureIndex(rows);
    expect(idx.resolvesByEvent.get('E1')).toBe(Date.parse(RESOLVES));
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

  it('L1: a failed-then-retried entry is a RETRY, not a reprice; only canceled predecessors count', () => {
    const idx = buildCaptureIndex(twoEvents());
    // failed → placed: retry, not a reprice.
    const retry = normalizeLedger(
      [
        led({ clientOrderId: 'f1', status: 'failed', createdAt: '2026-07-06T08:00:05.000Z' }),
        led({ clientOrderId: 'f2', status: 'placed', createdAt: '2026-07-06T08:00:40.000Z' }),
      ],
      idx,
    );
    expect(retry[0]!.nReprices).toBe(0);
    // canceled → canceled → placed: two genuine reprices.
    const twice = normalizeLedger(
      [
        led({ clientOrderId: 'c1', status: 'canceled', createdAt: '2026-07-06T08:00:05.000Z' }),
        led({ clientOrderId: 'c2', status: 'canceled', createdAt: '2026-07-06T08:00:35.000Z' }),
        led({ clientOrderId: 'c3', status: 'placed', createdAt: '2026-07-06T08:01:05.000Z' }),
      ],
      idx,
    );
    expect(twice[0]!.nReprices).toBe(2);
    // a trailing kill-cancel with no successor is not a reprice either.
    const killed = normalizeLedger([led({ clientOrderId: 'k1', status: 'canceled' })], idx);
    expect(killed[0]!.nReprices).toBe(0);
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

describe('lens fixes — M1 global normalization, M2 multi-bucket, M3 intent-only suppression, L3 city scope', () => {
  const fourEventRows = (): RawCaptureRow[] => [...evtRows('E1'), ...evtRows('E2'), ...evtRows('E3'), ...evtRows('E4')];
  const idx4 = buildCaptureIndex(fourEventRows());
  const events4 = buildEvents(fourEventRows(), new Map());
  /** a FILLED A entry (live-shaped ledger row) — makes intentOnly false so price/size actually score. */
  const filledLed = (eventId: string, size: number, over: Partial<DryRunLedgerRow> = {}): DryRunLedgerRow =>
    led({
      clientOrderId: `${eventId}-co`,
      marketId: `${eventId}-c2`,
      tokenId: `${eventId}-y2`,
      price: 0.11,
      size,
      sizeMatched: size,
      status: 'filled',
      fillNotionalUsd: 0.11 * size,
      fillSize: size,
      ...over,
    });

  it('M1: a GLOBAL stake-scale + price offset is detected ONCE and normalized out — uniform rows score 0', () => {
    // three both-entered rows, ALL with the same A size (66) and price (0.11) vs B's perPositionUsd sizing —
    // the config-mismatch shape M1 describes. A fourth row deviates (size 33 → double the B/A ratio).
    const ledger = [filledLed('E1', 66), filledLed('E2', 66), filledLed('E3', 66), filledLed('E4', 33)];
    const rep = computeShadowDiff(events4, idx4, ledger, CFG, 3);
    const rows = ['E1', 'E2', 'E3', 'E4'].map((id) => rep.rows.find((r) => r.eventId === id)!);
    const [e1, , , e4] = rows;

    // the global ratio = the (uniform) per-row B/A ratio of the majority rows; the median absorbs E4's outlier.
    const uniformRatio = e1!.b.entrySizeShares! / e1!.a.entrySizeShares!;
    expect(rep.summary.globalSizeRatioBOverA).toBeCloseTo(uniformRatio, 6);
    expect(rep.summary.globalNormalizationApplied).toBe(true);
    // the systematic price offset (B fill − A ledger price) lands in the summary, not in every row's score.
    expect(rep.summary.medianEntryPriceDeltaCents).toBeCloseTo((e1!.b.entryPrice! - 0.11) * 100, 6);

    // uniform rows: residual 0 on BOTH axes → score exactly 0 despite the raw ×~2.5 size and +1¢ price deltas.
    for (const r of rows.slice(0, 3)) {
      expect(r!.divergenceScore).toBe(0);
      expect(r!.notes.some((n) => n.includes('SIZE divergence'))).toBe(false);
    }
    // the deviating row scores its residual (ratio 2× the global → residualRel 1 → +10) and gets the alert.
    expect(e4!.divergenceScore).toBeCloseTo(10, 6);
    expect(e4!.notes.some((n) => n.includes('SIZE divergence beyond the global scale'))).toBe(true);
  });

  it('M2: a multi-bucket event (one event, two buckets entered) scores ≥50 and its note ranks FIRST', () => {
    const idx = buildCaptureIndex(twoEvents());
    const events = buildEvents(twoEvents(), new Map());
    const ledger = [
      led({ clientOrderId: 'm1', marketId: 'E1-c2', tokenId: 'E1-y2' }),
      led({ clientOrderId: 'm2', marketId: 'E1-c1', tokenId: 'E1-y1' }),
    ];
    const rep = computeShadowDiff(events, idx, ledger, CFG, 3);
    const e1 = rep.rows.find((r) => r.eventId === 'E1')!;
    expect(e1.a.multiBucket).toBe(true);
    expect(e1.a.bucketsEntered).toContain(1);
    expect(e1.a.bucketsEntered).toContain(2);
    expect(e1.divergenceScore).toBeGreaterThanOrEqual(50);
    // the anomaly leads notes[0] — never buried behind EXPECTED tags (the table shows only notes[0]).
    expect(e1.notes[0]).toContain('MULTI-BUCKET');
  });

  it('M3: a repriced intent NEVER scores its price/size delta — tagged intent-only instead', () => {
    const idx = buildCaptureIndex(twoEvents());
    const events = buildEvents(twoEvents(), new Map());
    // one reprice, both rows priced FAR from B's fill (0.05 vs ~0.12) — pre-fix this scored ~+7.
    const ledger = [
      led({ clientOrderId: 'r1', marketId: 'E1-c2', price: 0.05, status: 'canceled', createdAt: '2026-07-06T08:00:05.000Z' }),
      led({ clientOrderId: 'r2', marketId: 'E1-c2', price: 0.05, status: 'placed', createdAt: '2026-07-06T08:00:40.000Z' }),
    ];
    const rep = computeShadowDiff(events, idx, ledger, CFG, 3);
    const e1 = rep.rows.find((r) => r.eventId === 'E1')!;
    expect(e1.a.nReprices).toBe(1);
    expect(e1.entryPriceDelta).not.toBeNull(); // the delta stays REPORTED…
    expect(Math.abs(e1.entryPriceDelta!)).toBeGreaterThan(0.05);
    expect(e1.divergenceScore).toBe(0); // …but NEVER scored (expected classes cannot inflate the ranking)
    expect(e1.notes.some((n) => n.includes('EXPECTED(intent-only price/size)'))).toBe(true);
  });

  it('L3: an A-only row for a city outside --cities is tagged EXPECTED(city-scope) and UNscored', () => {
    const idx = buildCaptureIndex(twoEvents());
    const events = buildEvents(twoEvents(), new Map());
    const parisCfg = makerExitCfg(['paris']); // harness scoped to paris; the fixtures are amsterdam
    const rep = computeShadowDiff(events, idx, [led({ marketId: 'E1-c2' })], parisCfg, 3);
    const e1 = rep.rows.find((r) => r.eventId === 'E1')!;
    expect(e1.a.entered).toBe(true);
    expect(e1.b.entered).toBe(false); // off the replay's city allowlist
    expect(e1.outOfScopeA).toBe(true);
    expect(e1.divergenceScore).toBe(0); // an expected scope artifact, not a score-100 phantom
    expect(e1.notes.some((n) => n.includes('EXPECTED(city-scope)'))).toBe(true);
    expect(rep.summary.nOutOfScopeA).toBe(1);
    // a truly UNMAPPED market keeps its score-100 alert (it could be a real capture-coverage gap).
    const rep2 = computeShadowDiff(events, idx, [led({ marketId: 'ghost', tokenId: 'g' })], parisCfg, 3);
    const ghost = rep2.rows.find((r) => r.key.startsWith('unmapped:ghost'))!;
    expect(ghost.divergenceScore).toBeGreaterThanOrEqual(100);
    expect(ghost.notes[0]).toContain('UNMAPPED');
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
