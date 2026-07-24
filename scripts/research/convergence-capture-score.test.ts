/**
 * Tests for the market-signal convergence-capture scorer (scripts/research/convergence-capture-score.ts) and the
 * on-disk archive loader (scripts/research/opening-captures-archive-ingest.ts).
 *
 * Brings into CI the two seams a DB-free unit test can own: the ARCHIVE row mapping (snake_case → the camelCase
 * `RawCaptureRow` the core ingest consumes, plus the null-`event_id` drop) and the pure M1..M4 SELECT rules on
 * small synthetic ladders. The engine-side seam (targetIdx / ignoreHouseEdge / no-look-ahead) is covered by
 * packages/core/test/opening-convergence-select-seam.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  makeRuleM1,
  makeRuleM4,
  makeSelectRule,
  ruleM0,
  ruleM2,
  ruleM3,
  buildTradeRows,
  diagnose,
  splitByDate,
  report,
  sanity,
  DEFAULT_TPS,
  SELECT_RULES,
  RULE_CAVEATS,
  type SelectRule,
} from './convergence-capture-score.ts';
import { mapArchiveRow, type ArchiveRow } from './opening-captures-archive-ingest.ts';
import { buildEvents } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import { replayPanel, type EventReplayInput, type ReplayTick } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { BOT_DEFAULTS, type OpeningBucket, type OpeningCfg } from '../../packages/core/src/sim/opening-convergence.ts';

const TZ = 'Europe/Amsterdam';
const DATE = '2026-06-28';
const cfg: OpeningCfg = { ...BOT_DEFAULTS, cities: ['amsterdam'], depthFloorUsd: 50, takerFeeRate: 0.05 };

const b = (idx: number, over: Partial<OpeningBucket> = {}): OpeningBucket => ({
  idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
  bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: null,
  tokenYes: `y${idx}`, tokenNo: `n${idx}`, conditionId: `c${idx}`, ...over,
});
const tick = (buckets: OpeningBucket[], capturedAt = '2026-06-28T08:00:00.000Z'): ReplayTick => ({
  capturedAt, hoursSinceListing: 0.2, tz: TZ, targetDate: DATE, buckets,
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// archive row mapping
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** a real archive line's shape (verified against part-000001.ndjson.gz, 2026-07-24). */
const archiveRow = (over: Partial<ArchiveRow> = {}): ArchiveRow => ({
  id: 42,
  city: 'amsterdam',
  buckets: [{ idx: 2, label: '21C', mid: 0.1, bestAsk: 0.12, execAsk: 0.18, depthUsd: 100, bestBid: 0.09, houseProb: 0.35, tokenYes: 'y', tokenNo: 'n', conditionId: 'c' }],
  tz_name: TZ,
  event_id: 'E1',
  neg_risk: true,
  peak_mid: 0.1,
  ev_vol24h: 5000,
  captured_at: '2026-06-28T08:00:00.000+00:00',
  resolves_at: '2026-06-28T12:00:00+00:00',
  target_date: DATE,
  house_seeded: true,
  is_flat_open: false,
  created_at_gamma: '2026-06-27T04:00:00.000000+00:00',
  hours_since_listing: 0.2,
  listing_detected_at: '2026-06-28T08:00:00.000+00:00',
  ...over,
});

describe('mapArchiveRow — snake_case archive row → camelCase RawCaptureRow', () => {
  it('maps every field the core ingest reads', () => {
    const m = mapArchiveRow(archiveRow());
    expect(m).toMatchObject({
      eventId: 'E1',
      capturedAt: '2026-06-28T08:00:00.000+00:00',
      city: 'amsterdam',
      targetDate: DATE,
      tzName: TZ,
      createdAtGamma: '2026-06-27T04:00:00.000000+00:00',
      resolvesAt: '2026-06-28T12:00:00+00:00',
      hoursSinceListing: 0.2,
      peakMid: 0.1,
      isFlatOpen: false,
      houseSeeded: true,
      evVol24h: 5000,
      negRisk: true,
    });
    expect(m.buckets).toHaveLength(1);
    expect(m.buckets![0]!.execAsk).toBe(0.18); // buckets pass through as-is (already camelCase)
  });

  it('is total on junk — nulls/absent fields never throw', () => {
    const m = mapArchiveRow({});
    expect(m.eventId).toBeNull();
    expect(m.capturedAt).toBe('');
    expect(m.hoursSinceListing).toBeNull();
    expect(m.buckets).toBeNull();
    expect(mapArchiveRow({ buckets: 'not-an-array' }).buckets).toBeNull();
    // numeric strings (a pg numeric dumped as text) still parse
    expect(mapArchiveRow({ hours_since_listing: '1.5' }).hoursSinceListing).toBe(1.5);
  });

  it('a bucket lacking the exit-side columns (the earliest shards) maps to null execBid, not 0¢', () => {
    const rows = [mapArchiveRow(archiveRow({ buckets: [{ idx: 0, label: 'x', bestAsk: 0.001, depthUsd: 0 }] }))];
    const ev = buildEvents(rows, new Map());
    expect(ev[0]!.ticks[0]!.buckets[0]!.execBid).toBeNull();
    expect(ev[0]!.ticks[0]!.buckets[0]!.sellbackDepthUsd).toBe(0);
  });

  it('null event_id rows are dropped at the buildEvents stage', () => {
    const rows = [mapArchiveRow(archiveRow({ event_id: null })), mapArchiveRow(archiveRow({ event_id: 'E1' }))];
    const ev = buildEvents(rows, new Map());
    expect(ev.map((e) => e.eventId)).toEqual(['E1']);
  });

  it('joins the resolution map by event id', () => {
    const ev = buildEvents([mapArchiveRow(archiveRow())], new Map([['E1', { winnerIdx: 2, gradingMismatch: false }]]));
    expect(ev[0]!.resolution.winnerIdx).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// the select rules
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('M0 — the control', () => {
  it('always defers to the engine default', () => {
    expect(ruleM0([tick([b(0)])], 0)).toBeNull();
    expect(makeSelectRule('M0', cfg)([tick([b(0)])], 0)).toBeNull();
  });
});

describe('M1 — bid-leader among still-cheap buckets', () => {
  const rule = makeRuleM1(0.2);
  it('picks the max bestBid', () => {
    expect(rule([tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.15 }), b(2, { bestBid: 0.1 })])], 0)).toBe(1);
  });
  it('excludes buckets above the entry cap even when their bid leads', () => {
    expect(rule([tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.9, execAsk: 0.95 })])], 0)).toBe(0);
  });
  it('breaks ties on higher mid, then lower idx', () => {
    expect(rule([tick([b(0, { bestBid: 0.1, mid: 0.1 }), b(1, { bestBid: 0.1, mid: 0.2 })])], 0)).toBe(1);
    expect(rule([tick([b(0, { bestBid: 0.1, mid: 0.2 }), b(1, { bestBid: 0.1, mid: 0.2 })])], 0)).toBe(0);
  });
  it('returns null when nothing is quoted or nothing is cheap', () => {
    expect(rule([tick([b(0, { bestBid: null }), b(1, { bestBid: null })])], 0)).toBeNull();
    expect(rule([tick([b(0, { execAsk: 0.5 })])], 0)).toBeNull();
    expect(rule([], 0)).toBeNull();
  });
});

describe('M2 — market-implied mode', () => {
  it('picks the max mid regardless of price', () => {
    expect(ruleM2([tick([b(0, { mid: 0.1 }), b(1, { mid: 0.4, execAsk: 0.9 }), b(2, { mid: 0.2 })])], 0)).toBe(1);
  });
  it('skips buckets with no two-sided quote and is null on an unquoted ladder', () => {
    expect(ruleM2([tick([b(0, { mid: null }), b(1, { mid: 0.05 })])], 0)).toBe(1);
    expect(ruleM2([tick([b(0, { mid: null })])], 0)).toBeNull();
  });
});

describe('M3 — floor-adjacent (bid-mass substitute for the observed running-max floor)', () => {
  it('targets one above the HIGHEST ≥0.90-bid bucket', () => {
    expect(ruleM3([tick([b(0, { bestBid: 0.95 }), b(1, { bestBid: 0.92 }), b(2), b(3)])], 0)).toBe(2);
  });
  it('falls back to one above the coldest QUOTED rung when no bucket is bid that high', () => {
    expect(ruleM3([tick([b(0, { mid: null }), b(1, { mid: 0.1 }), b(2), b(3)])], 0)).toBe(2);
  });
  it('clamps to the top of the ladder', () => {
    expect(ruleM3([tick([b(0, { bestBid: 0.95 }), b(1, { bestBid: 0.95 })])], 0)).toBe(1);
  });
  it('is null on an empty / fully unquoted ladder', () => {
    expect(ruleM3([tick([])], 0)).toBeNull();
    expect(ruleM3([tick([b(0, { mid: null, bestBid: null })])], 0)).toBeNull();
  });
});

describe('M4 — early bid momentum (past ticks only)', () => {
  const rule = makeRuleM4(0.2);
  it('is null at i = 0 (no history yet)', () => {
    expect(rule([tick([b(0)])], 0)).toBeNull();
  });
  it('picks the biggest bid gain over the K look-back', () => {
    const past = tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.05 })]);
    const now = tick([b(0, { bestBid: 0.06 }), b(1, { bestBid: 0.12 })]);
    expect(rule([past, now], 1)).toBe(1);
  });
  it('caps the look-back at 5 ticks and still reads only past ticks', () => {
    const series = Array.from({ length: 9 }, (_v, k) => tick([b(0, { bestBid: 0.01 * k }), b(1, { bestBid: 0.2 - 0.01 * k })]));
    expect(rule(series.slice(0, 9), 8)).toBe(0); // idx 0 rose over the last 5, idx 1 fell
  });
  it('is null on a FLAT book — no momentum is not a pick (never silently the coldest rung)', () => {
    const flat = tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.05 })]);
    expect(rule([flat, flat], 1)).toBeNull();
    // …and a falling book is likewise no signal
    expect(rule([tick([b(0, { bestBid: 0.1 })]), tick([b(0, { bestBid: 0.05 })])], 1)).toBeNull();
  });

  it('excludes buckets that are no longer cheap, and is null when none qualify', () => {
    const past = tick([b(0, { bestBid: 0.05 }), b(1, { bestBid: 0.05 })]);
    const now = tick([b(0, { bestBid: 0.06 }), b(1, { bestBid: 0.19, execAsk: 0.5 })]);
    expect(rule([past, now], 1)).toBe(0);
    expect(rule([tick([b(0, { bestBid: null })]), tick([b(0, { bestBid: 0.1 })])], 1)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// harness plumbing
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildTradeRows / diagnose / splitByDate / report', () => {
  const evt = (id: string, targetDate: string, winnerIdx: number | null, ticks: ReplayTick[]): EventReplayInput => ({
    eventId: id, city: 'amsterdam', targetDate, tz: TZ, ticks, resolution: { winnerIdx, gradingMismatch: false },
  });
  const seeded = (over: Partial<OpeningBucket> = {}): OpeningBucket[] => [
    b(0, { houseProb: 0.1 }), b(1, { houseProb: 0.2 }), b(2, { houseProb: 0.35, ...over }), b(3, { houseProb: 0.2 }),
  ];
  const tpTicks = (): ReplayTick[] => [
    tick(seeded(), '2026-06-28T08:00:00.000Z'),
    tick(seeded(), '2026-06-28T08:00:30.000Z'),
    tick(seeded({ execBid: 0.6 }), '2026-06-28T08:01:00.000Z'),
  ];

  it('reports the mechanism fractions on a take-profit trade', () => {
    const d = diagnose(buildTradeRows([evt('E', DATE, 3, tpTicks())], cfg, 0.25));
    expect(d.nExecuted).toBe(1);
    expect(d.tpCaptureFrac).toBe(1);
    expect(d.reRateUpFrac).toBe(1);
    expect(d.nTpWithKnownWinner).toBe(1);
    expect(d.tpWouldHaveWonFrac).toBe(0); // sold on the bump; bucket 2 would have LOST (winner 3)
    expect(d.meanEntryPrice).toBeGreaterThan(0);
  });

  it('honours the select rule + ignoreHouseEdge it is handed', () => {
    const bare = [b(0), b(1), b(2)];
    const ticks = [tick(bare, '2026-06-28T08:00:00.000Z'), tick(bare, '2026-06-28T08:00:30.000Z')];
    expect(buildTradeRows([evt('E', DATE, 1, ticks)], cfg, 0.25).rows).toHaveLength(0);
    expect(
      buildTradeRows([evt('E', DATE, 1, ticks)], cfg, 0.25, { selectRule: () => 1, ignoreHouseEdge: true }).rows,
    ).toHaveLength(1);
  });

  it('requireRuleTarget makes a silent rule SKIP the tick instead of falling back to the forecast', () => {
    const ticks = tpTicks(); // bucket 2 carries the forecast argmax (houseProb 0.35)
    // a rule that is silent on tick 0 and names bucket 1 from tick 1 onward
    const late: SelectRule = (_ts, i) => (i === 0 ? null : 1);
    // WITHOUT the flag: the silent tick 0 falls back to the forecast argmax ⇒ we buy bucket 2 (contamination).
    const blended = buildTradeRows([evt('E', DATE, 3, ticks)], cfg, 0.25, { selectRule: late, ignoreHouseEdge: true });
    expect(blended.rows[0]!.bucketIdx).toBe(2);
    // WITH it: tick 0 is skipped and the rule's own pick is honoured ⇒ a pure market-signal arm.
    const pure = buildTradeRows([evt('E', DATE, 3, ticks)], cfg, 0.25, {
      selectRule: late, ignoreHouseEdge: true, requireRuleTarget: true,
    });
    expect(pure.rows[0]!.bucketIdx).toBe(1);
    // a rule that is ALWAYS silent enters nothing under the flag (rather than replaying M0 under another name)
    expect(
      buildTradeRows([evt('E', DATE, 3, ticks)], cfg, 0.25, { selectRule: () => null, requireRuleTarget: true }).rows,
    ).toHaveLength(0);
  });

  it('emits one row per executed trade carrying the FILL-TICK book the inverse-side (NO) arm needs', () => {
    const set = buildTradeRows([evt('E', DATE, 3, tpTicks())], cfg, 0.25, {}, { select: 'M2', houseEdge: false });
    expect(set.rows).toHaveLength(1);
    const r = set.rows[0]!;
    // the ENTRY-side columns — a null entryExecBid silently breaks the NO arm, so pin them as real numbers
    expect(r).toMatchObject({
      eventId: 'E', city: 'amsterdam', targetDate: DATE, bucketIdx: 2, entryLabel: 'b2',
      entryBestBid: 0.09, entryExecBid: 0.1, entryDepthUsd: 100, entrySellbackDepthUsd: 100,
      winnerIdx: 3, bucketWon: false, tpDeltaPp: 0.25, select: 'M2', houseEdge: false, isMaker: true,
    });
    expect(r.entryPrice).toBeGreaterThan(0);
    expect(r.exitReason.startsWith('take_profit')).toBe(true);
    expect(r.exitPrice).toBe(0.6);
    expect(r.netReturn).toBeGreaterThan(0);
    expect(r.bestReachableBid).toBe(0.6);
    // the NO arm's two derived quantities are computable from the row alone
    expect(1 - r.entryExecBid!).toBeCloseTo(0.9, 10); // NO ask
    expect(r.entrySellbackDepthUsd!).toBeGreaterThan(0); // …and it has executable size
  });

  it('counts UNKNOWN resolutions instead of scoring them as losses', () => {
    const set = buildTradeRows(
      [evt('A', DATE, 3, tpTicks()), evt('B', DATE, null, tpTicks())],
      cfg,
      0.25,
    );
    expect(set.rows).toHaveLength(2);
    expect(set.nConsidered).toBe(2);
    expect(set.nUnknownResolution).toBe(1);
    const unknown = set.rows.find((r) => r.eventId === 'B')!;
    expect(unknown.winnerIdx).toBeNull();
    expect(unknown.bucketWon).toBeNull(); // NOT false — it must never fall into a loss bucket
    expect(diagnose(set).nUnknownResolution).toBe(1);
    expect(diagnose(set).nTpWithKnownWinner).toBe(1); // the unknown row is excluded from the win-rate basis
  });

  it('reports a missing fill-tick bid as null (not 0¢) so an uncomputable NO arm is visible', () => {
    const bare = (over: Partial<OpeningBucket> = {}): OpeningBucket[] => [
      b(0, { houseProb: 0.35, execBid: null, bestBid: null, sellbackDepthUsd: 0, ...over }),
    ];
    const ticks = [tick(bare(), '2026-06-28T08:00:00.000Z'), tick(bare(), '2026-06-28T08:00:30.000Z')];
    const set = buildTradeRows([evt('E', DATE, 0, ticks)], cfg, 0.25);
    expect(set.rows).toHaveLength(1);
    expect(set.rows[0]!.entryExecBid).toBeNull();
    expect(set.rows[0]!.entryBestBid).toBeNull();
    const d = diagnose(set);
    expect(d.nWithEntryBid).toBe(0);
    expect(d.nWithSellbackDepth).toBe(0);
  });

  it('is total on an empty panel', () => {
    const d = diagnose(buildTradeRows([], cfg, 0.25));
    expect(d.nExecuted).toBe(0);
    expect(d.nUnknownResolution).toBe(0);
    expect(Number.isNaN(d.tpCaptureFrac)).toBe(true);
    report(replayPanel([], cfg, DEFAULT_TPS), { select: 'M0', houseEdge: true, feeRate: 0.05, minDepthUsd: 50, cities: 1 }, d, () => {});
  });

  it('splits by date with the earliest dates as TRAIN', () => {
    const evs = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'].map((d) => evt(d, d, null, []));
    expect(splitByDate(evs, { splitDate: '2026-06-03' }).train.map((e) => e.targetDate)).toEqual(['2026-06-01', '2026-06-02']);
    expect(splitByDate(evs, { trainFrac: 0.75 }).splitDate).toBe('2026-06-04');
    expect(splitByDate(evs, {}).test).toEqual([]); // no split requested ⇒ everything is train
  });

  it('exposes exactly the five documented rule ids and passes its own CLI self-test', () => {
    expect([...SELECT_RULES]).toEqual(['M0', 'M1', 'M2', 'M3', 'M4']);
    // the two rules that are NOT what their name promises must carry a caveat the report always prints
    expect(RULE_CAVEATS.M3).toContain('PROXY');
    expect(RULE_CAVEATS.M4).toContain('NOT LIKE-FOR-LIKE');
    expect(RULE_CAVEATS.M0).toBeNull();
    expect(() => sanity()).not.toThrow();
  });
});
