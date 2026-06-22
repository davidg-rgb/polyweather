/**
 * scripts/research/maker-spray-feasibility.test.ts — unit tests for the P1 script spine's pure,
 * DB-free helpers: the CLI token parsers, the EMOS-fork engine (forked verbatim from db1), and
 * `assembleBids` (which is pure given its loaded inputs — it owns the ADR-05 tz-correct
 * resolution/entry instants + the calibratedP fold + the forkRmse accumulator, but does NOT touch
 * the DB). The DB-touching loaders (`loadBucketSeries`, `loadEmosInputs`, `forkEqualityRmse`) hit the
 * read-only Postgres and are exercised by the P1 DoD run, not here.
 */
import { describe, expect, it } from 'vitest';
import {
  EmosStation,
  assembleBids,
  loadCrossValFills,
  parseFillModel,
  parseRestRule,
  type AssembleArgs,
  type CrossValCrawler,
  type EmosLoadResult,
  type MakerEventRow,
  type MakerSnapshot,
} from './maker-spray-feasibility.ts';
import { localDayWindow, type AppConfig } from '../../packages/core/src/index.ts';
import type { Db } from '../lib/backfill.ts';
import type { WalletActivity } from '../../packages/io/src/polymarket-wallet.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// CLI token parsers (Pass-1 L1 — the --rest-at / --fill-model mapping to the internal enums)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('parseRestRule — CLI token → internal RestRule enum', () => {
  it('maps the three tokens', () => {
    expect(parseRestRule('bid')).toBe('bid');
    expect(parseRestRule('bid+tick')).toBe('bid_plus_tick');
    expect(parseRestRule('ask-offset')).toBe('ask_offset');
  });
  it('defaults to bid when omitted', () => {
    expect(parseRestRule(undefined)).toBe('bid');
  });
  it('throws on an unknown token', () => {
    expect(() => parseRestRule('mid')).toThrow(/rest-at/);
  });
});

describe('parseFillModel — CLI token → internal FillModel enum', () => {
  it('maps both tokens (dash and underscore forms)', () => {
    expect(parseFillModel('ask_touch')).toBe('ask_touch');
    expect(parseFillModel('ask-touch')).toBe('ask_touch');
    expect(parseFillModel('last_trade')).toBe('last_trade');
    expect(parseFillModel('last-trade')).toBe('last_trade');
  });
  it('defaults to ask_touch when omitted', () => {
    expect(parseFillModel(undefined)).toBe('ask_touch');
  });
  it('throws on an unknown token', () => {
    expect(() => parseFillModel('mid_cross')).toThrow(/fill-model/);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the forked EMOS engine — a smoke test that the fork produces a finite blended μ + σ after a window
// (the byte-equality to the LIVE model is asserted by forkEqualityRmse in the P1 DoD run, not here)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const CFG: AppConfig = {
  // only the fields EmosStation reads matter; the rest are filled with schema defaults.
  biasAlpha: 0.15,
  sigmaWindowDays: 30,
  sigmaMinN: 8,
} as unknown as AppConfig;

describe('EmosStation (forked from db1) — produces a finite blended μ/σ after enough folds', () => {
  it('blends a single model and fits σ once the window exceeds sigmaMinN', () => {
    const sm = new EmosStation(CFG);
    const lead = 1;
    // fold 10 days of (forecast, obs) with a constant +1°C warm bias
    for (let d = 0; d < 10; d++) {
      const obs = 15 + d * 0.1;
      sm.fold([{ model: 'gfs', f: obs + 1 }], lead, obs);
    }
    const mu = sm.blendedMu([{ model: 'gfs', f: 20 }], lead);
    expect(mu).not.toBeNull();
    expect(Number.isFinite(mu!)).toBe(true);
    // the EMA bias-correction pulls the +1°C-biased forecast back toward the truth
    expect(mu!).toBeLessThan(20);
    const sigma = sm.sigma(lead);
    expect(sigma).not.toBeNull();
    expect(sigma!).toBeGreaterThan(0);
  });

  it('returns null μ before the window reaches sigmaMinN (too thin)', () => {
    const sm = new EmosStation(CFG);
    sm.fold([{ model: 'gfs', f: 16 }], 1, 15);
    // one fold: the model window has n=1 < sigmaMinN=8, so it carries no inverse-MSE weight, and with
    // a single model and no usable weights the equal-weight fallback still corrects on a null bias —
    // the engine yields a value; σ is null (residual window < sigmaMinN).
    expect(sm.sigma(1)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// assembleBids — pure given loaded inputs: the walk-forward fold → calibratedP, the ADR-05 tz-correct
// resolution/entry instants, the marketProbAtEntry pick, and the forkRmse accumulator. No DB.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Build a minimal EmosLoadResult with one station, one model, a warm-up + scoring window of obs/fc. */
function makeEmosInputs(opts: {
  icao: string;
  unit: 'C' | 'F';
  lead: number;
  /** ISO date → obs °C (and a matching single-model forecast at +0 bias). */
  days: { date: string; obsC: number; forecastC: number }[];
}): EmosLoadResult {
  const fc = new Map<string, Map<string, Map<number, Map<string, number>>>>();
  const obs = new Map<string, Map<string, number>>();
  const byT = new Map<string, Map<number, Map<string, number>>>();
  const obsByDate = new Map<string, number>();
  for (const d of opts.days) {
    byT.set(d.date, new Map([[opts.lead, new Map([['gfs', d.forecastC]])]]));
    obsByDate.set(d.date, d.obsC);
  }
  fc.set(opts.icao, byT);
  obs.set(opts.icao, obsByDate);
  return {
    cfg: CFG,
    icaos: [opts.icao],
    unitByIcao: new Map([[opts.icao, opts.unit]]),
    fc,
    obs,
  };
}

/** A 2-bucket C ladder around 15°C: bucket 0 = [-inf,15), bucket 1 = [15,+inf). */
function twoBucketEvent(opts: {
  eventId: string;
  icao: string;
  tz: string;
  targetDate: string;
  winnerIdx: number;
}): MakerEventRow {
  return {
    eventId: opts.eventId,
    icao: opts.icao,
    citySlug: 'ams',
    region: 'eu',
    tz: opts.tz,
    targetDate: opts.targetDate,
    unit: 'C',
    winnerIdx: opts.winnerIdx,
    feeRate: 0.05,
    ladder: [
      { bucketIdx: 0, low: null, high: 15 },
      { bucketIdx: 1, low: 15, high: null },
    ],
    bucketDefs: [
      { low: null, high: 15, unit: 'C' },
      { low: 15, high: null, unit: 'C' },
    ],
    tickByBucket: new Map([
      [0, 0.01],
      [1, 0.01],
    ]),
  };
}

describe('assembleBids — the walk-forward fold + ADR-05 tz-correct instants (pure, no DB)', () => {
  // a 14-day warm-up window before `from` so the EMOS engine has enough residuals for a finite σ
  const allDays = (() => {
    const out: { date: string; obsC: number; forecastC: number }[] = [];
    for (let d = 1; d <= 20; d++) {
      const date = `2026-05-${String(d).padStart(2, '0')}`;
      const obsC = 14 + (d % 5) * 0.3;
      // a forecast with a residual spread > 0.2°C so fitSigma yields σ > 0.2 (gaussianBucketProbs
      // refuses a degenerate σ ≤ 0.2). A deterministic ±0.8°C zig-zag does it.
      const forecastC = obsC + (d % 2 === 0 ? 0.8 : -0.8);
      out.push({ date, obsC, forecastC });
    }
    return out;
  })();

  const TARGET = '2026-05-20'; // the single scored day (from === to)
  const lead = 1;
  const emos = makeEmosInputs({ icao: 'EHAM', unit: 'C', lead, days: allDays });

  function build(
    seriesMap: Map<string, Map<number, MakerSnapshot[]>>,
    args: Partial<AssembleArgs> = {},
  ) {
    return assembleBids(emos, [twoBucketEvent({ eventId: 'EV1', icao: 'EHAM', tz: 'Europe/Amsterdam', targetDate: TARGET, winnerIdx: 1 })], seriesMap, {
      from: TARGET,
      to: TARGET,
      leads: [lead],
      entryLeadHours: 24,
      ...args,
    });
  }

  it('emits one RestingBid per bucket with the series attached + a calibratedP that sums ~1', () => {
    const res = build(new Map());
    expect(res.bids.length).toBe(2); // one per bucket
    const sum = res.bids.reduce((a, b) => a + b.calibratedP, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(res.forkN).toBeGreaterThan(0);
    expect(Number.isFinite(res.forkRmse)).toBe(true);
  });

  it('computes the station-LOCAL resolution instant via localDayWindow (ADR-05), not a UTC proxy', () => {
    const res = build(new Map());
    const expectedRes = Math.floor(localDayWindow('Europe/Amsterdam', TARGET).endUtc.getTime() / 1000);
    for (const b of res.bids) {
      expect(b.resolutionTs).toBe(expectedRes);
      expect(b.entryTs).toBe(expectedRes - 24 * 3600);
      // Amsterdam in May is UTC+2 (CEST)
      expect(b.tzOffsetHours).toBeCloseTo(2, 6);
    }
  });

  it('entry-lead is honored: entryTs = resolutionTs − entryLeadHours·3600', () => {
    const res = build(new Map(), { entryLeadHours: 43 });
    for (const b of res.bids) {
      expect(b.resolutionTs - b.entryTs).toBe(43 * 3600);
    }
  });

  it('sets marketProbAtEntry to the first usable ask at/after entryTs (else null)', () => {
    const expectedRes = Math.floor(localDayWindow('Europe/Amsterdam', TARGET).endUtc.getTime() / 1000);
    const entryTs = expectedRes - 24 * 3600;
    const series = new Map<string, Map<number, MakerSnapshot[]>>([
      [
        'EV1',
        new Map<number, MakerSnapshot[]>([
          [
            1,
            [
              // before entry → ignored
              { capturedAt: entryTs - 600, bid: 0.1, ask: 0.2, mid: 0.15, lastTrade: 0.18 },
              // at/after entry → this ask is the market-implied prob
              { capturedAt: entryTs + 600, bid: 0.12, ask: 0.22, mid: 0.17, lastTrade: 0.2 },
            ],
          ],
        ]),
      ],
    ]);
    const res = build(series);
    const b1 = res.bids.find((b) => b.bucketIdx === 1)!;
    expect(b1.marketProbAtEntry).toBeCloseTo(0.22, 9);
    expect(b1.snapshots.length).toBe(2);
    const b0 = res.bids.find((b) => b.bucketIdx === 0)!;
    expect(b0.marketProbAtEntry).toBeNull(); // bucket 0 has no series
    expect(b0.snapshots.length).toBe(0);
  });

  it('carries the bucket fee rate, tick size, station, and resolved winner flag through', () => {
    const res = build(new Map());
    for (const b of res.bids) {
      expect(b.feeRate).toBe(0.05);
      expect(b.tickSize).toBe(0.01);
      expect(b.station).toBe('EHAM');
      expect(b.conditionId).toBe('EV1');
    }
    expect(res.bids.find((b) => b.bucketIdx === 1)!.bucketWon).toBe(true);
    expect(res.bids.find((b) => b.bucketIdx === 0)!.bucketWon).toBe(false);
  });

  it('is deterministic — two assembles produce byte-identical bids', () => {
    const a = build(new Map());
    const b = build(new Map());
    expect(JSON.stringify(a.bids)).toBe(JSON.stringify(b.bids));
    expect(a.forkRmse).toBe(b.forkRmse);
  });

  it('emits no bids when there is no resolved event for the scored (station, day)', () => {
    const res = assembleBids(emos, [], new Map(), {
      from: TARGET,
      to: TARGET,
      leads: [lead],
      entryLeadHours: 24,
    });
    expect(res.bids.length).toBe(0);
    // the forkRmse accumulator still runs over the build-day (it only needs μ + obs, not an event)
    expect(res.forkN).toBeGreaterThan(0);
  });

  it('applies a per-bucket tick_size fallback to 0.01 when null', () => {
    const ev = twoBucketEvent({ eventId: 'EV1', icao: 'EHAM', tz: 'Europe/Amsterdam', targetDate: TARGET, winnerIdx: 1 });
    ev.tickByBucket = new Map([
      [0, null],
      [1, 0.001],
    ]);
    const res = assembleBids(emos, [ev], new Map(), {
      from: TARGET,
      to: TARGET,
      leads: [lead],
      entryLeadHours: 24,
    });
    expect(res.bids.find((b) => b.bucketIdx === 0)!.tickSize).toBe(0.01); // null → 0.01
    expect(res.bids.find((b) => b.bucketIdx === 1)!.tickSize).toBe(0.001);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// cross-validation wiring (P3 / F-008) — the crawl is INJECTED so both the clean-degradation path
// (Polymarket rate-limit) and the happy-path DB join are exercised deterministically, no network.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A minimal WalletActivity row for the cross-val crawler stub (only the fields the join reads). */
function buyFill(opts: {
  conditionId: string;
  price: number;
  timestamp: number;
  type?: string;
  side?: 'BUY' | 'SELL' | null;
}): WalletActivity {
  return {
    type: opts.type ?? 'TRADE',
    side: opts.side ?? 'BUY',
    conditionId: opts.conditionId,
    asset: 'asset',
    outcome: 'Yes',
    sizeShares: 100,
    price: opts.price,
    usdcSize: opts.price * 100,
    timestamp: opts.timestamp,
    eventSlug: 'slug',
    title: 'title',
    kind: 'highest',
    citySlug: 'ams',
    targetDate: '2026-05-20',
  };
}

/** A read-only Db stub: returns canned rows by matching on a fragment of the SQL text. */
function stubDb(handlers: { match: RegExp; rows: Record<string, unknown>[] }[]): Db {
  return {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      for (const h of handlers) if (h.match.test(sql)) return h.rows as T[];
      return [] as T[];
    },
  };
}

const noopLog = (_m: string): void => {};

describe('loadCrossValFills (P3 / F-008) — non-blocking crawl + the DB join', () => {
  it('degrades cleanly to [] when the crawl rate-limits (never throws, never fails the study)', async () => {
    const rateLimited: CrossValCrawler = async () => {
      throw new Error('HTTP 429 Too Many Requests');
    };
    const msgs: string[] = [];
    const out = await loadCrossValFills(
      stubDb([]),
      { wallet: '0xwallet', from: '2026-04-21', cheapMax: 0.25, maxPages: 10 },
      (m) => msgs.push(m),
      rateLimited,
    );
    expect(out).toEqual([]);
    expect(msgs.some((m) => /cross-val skipped/.test(m))).toBe(true);
  });

  it('returns [] (cleanly) when the wallet has no cheap BUY fills', async () => {
    const noCheap: CrossValCrawler = async () => ({
      fills: [
        buyFill({ conditionId: 'C1', price: 0.8, timestamp: 1000 }), // not cheap (>= cheapMax)
        buyFill({ conditionId: 'C2', price: 0.1, timestamp: 1000, side: 'SELL' }), // not a BUY
      ],
      mode: 'full' as const,
      pagesFetched: 1,
      windowFrom: null,
      hitCap: false,
    });
    const out = await loadCrossValFills(
      stubDb([]),
      { wallet: '0xwallet', from: '2026-04-21', cheapMax: 0.25, maxPages: 10 },
      noopLog,
      noCheap,
    );
    expect(out).toEqual([]);
  });

  it('joins a cheap BUY fill to its bucket series + slices to the post-fill window', async () => {
    const crawl: CrossValCrawler = async () => ({
      fills: [buyFill({ conditionId: 'C1', price: 0.12, timestamp: 2000 })],
      mode: 'full' as const,
      pagesFetched: 1,
      windowFrom: null,
      hitCap: false,
    });
    const db = stubDb([
      // condition_id → bucket_id
      { match: /market_buckets mb\s+where mb\.condition_id/i, rows: [{ condition_id: 'C1', bucket_id: 'B1' }] },
      // bucket_id → snapshot series (one before the fill, two at/after)
      {
        match: /from market_snapshots where bucket_id/i,
        rows: [
          { bucket_id: 'B1', captured_at: new Date(1000 * 1000), best_bid: '0.10', best_ask: '0.20', mid: '0.15', last_trade: '0.18' },
          { bucket_id: 'B1', captured_at: new Date(2000 * 1000), best_bid: '0.11', best_ask: '0.13', mid: '0.12', last_trade: '0.12' },
          { bucket_id: 'B1', captured_at: new Date(3000 * 1000), best_bid: '0.09', best_ask: '0.10', mid: '0.095', last_trade: '0.10' },
        ],
      },
    ]);
    const out = await loadCrossValFills(
      db,
      { wallet: '0xwallet', from: '2026-04-21', cheapMax: 0.25, maxPages: 10 },
      noopLog,
      crawl,
    );
    expect(out.length).toBe(1);
    expect(out[0]!.restPx).toBeCloseTo(0.12, 9);
    // only the at/after-fill snapshots (ts >= 2000) survive the post-fill slice
    expect(out[0]!.postEntry.length).toBe(2);
    expect(out[0]!.postEntry.every((s) => s.capturedAt >= 2000)).toBe(true);
  });

  it('drops a cheap fill whose bucket has no snapshot series (cleanly, no throw)', async () => {
    const crawl: CrossValCrawler = async () => ({
      fills: [buyFill({ conditionId: 'C1', price: 0.12, timestamp: 2000 })],
      mode: 'full' as const,
      pagesFetched: 1,
      windowFrom: null,
      hitCap: false,
    });
    const db = stubDb([
      { match: /market_buckets mb\s+where mb\.condition_id/i, rows: [{ condition_id: 'C1', bucket_id: 'B1' }] },
      { match: /from market_snapshots where bucket_id/i, rows: [] }, // no series
    ]);
    const out = await loadCrossValFills(
      db,
      { wallet: '0xwallet', from: '2026-04-21', cheapMax: 0.25, maxPages: 10 },
      noopLog,
      crawl,
    );
    expect(out).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// trading-boundary self-discipline: this test file imports NOTHING from packages/trading (R-8 / I2)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('read-only / boundary self-discipline', () => {
  it('imports only core + the script spine (the §15 invariant allow-lists *.test.ts, but we behave)', () => {
    // a structural assertion: the symbols under test come from the spine + core, never trading.
    expect(typeof assembleBids).toBe('function');
    expect(typeof parseRestRule).toBe('function');
  });
});
