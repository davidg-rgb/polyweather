/**
 * Behavioral tests for seedHouseDist's seedFreshnessMin throttle + OM-on-absence flow (the EDGE2-1 restructure).
 * seedHouseDist is impure (db.rpc + fetchJson + buildDistributionForEvent), so we drive it with spy fakes and
 * assert the CALL PROFILE — which is exactly what regressed before: the old `built.written === 0` trigger
 * re-ran the Open-Meteo fetch on every 2-min tick even when a usable dist already existed. These pin:
 *   (a) a FRESH dist is reused — no upsert_bucket, no build, no OM fetch;
 *   (b) a STALE-but-present dist rebuilds but does NOT OM-fetch (build alone suffices / the dist persists);
 *   (c) a genuinely ABSENT dist triggers exactly ONE OM fetch.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedEvent } from '../../../packages/core/src/index.ts';
import { BOT_DEFAULTS } from '../../../packages/core/src/sim/opening-convergence.ts';
import { seedHouseDist, type SeedDeps, type SeedKeys } from './seed.ts';

const NOW = new Date('2026-06-28T06:00:00Z');
const KEYS: SeedKeys = { cityId: 'city-1', icao: 'EHAM', tz: 'Europe/Amsterdam' };

/** A minimal scoped-city ParsedEvent (only the fields seedHouseDist reads). */
function makeEv(): ParsedEvent {
  return {
    slug: 'highest-temperature-in-amsterdam-on-jun-28-2026',
    citySlug: 'amsterdam',
    targetDate: '2026-06-28',
    unit: 'C',
    station: { icao: 'EHAM', countryCode: 'NL' },
    negRiskMarketId: 'neg-1',
    createdAt: '2026-06-28T05:40:00Z',
    kind: 'highest',
    eventVolume24h: 9000,
    liquidity: 5000,
    acceptingOrders: true,
    ladderProblems: [],
    buckets: [
      { marketId: 'm0', conditionId: 'c0', label: '29-29°C', def: { low: 29, high: 29, unit: 'C' }, tokenYes: 'y0', tokenNo: 'n0', bestBid: 0.1, bestAsk: 0.12, tickSize: 0.01, minOrderSize: 5, feeRate: 0 },
      { marketId: 'm1', conditionId: 'c1', label: '30-30°C', def: { low: 30, high: 30, unit: 'C' }, tokenYes: 'y1', tokenNo: 'n1', bestBid: 0.11, bestAsk: 0.13, tickSize: 0.01, minOrderSize: 5, feeRate: 0 },
      { marketId: 'm2', conditionId: 'c2', label: '31-31°C', def: { low: 31, high: 31, unit: 'C' }, tokenYes: 'y2', tokenNo: 'n2', bestBid: 0.1, bestAsk: 0.12, tickSize: 0.01, minOrderSize: 5, feeRate: 0 },
    ],
  } as unknown as ParsedEvent;
}

interface DistLike {
  probs: number[];
  sigma: number;
  madeAt: string;
  buckets: { idx: number; label: string; prob: number }[];
}
const dist = (minutesAgo: number): DistLike => ({
  probs: [0.2, 0.5, 0.3],
  sigma: 1.5,
  madeAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  buckets: [
    { idx: 0, label: '29-29°C', prob: 0.2 },
    { idx: 1, label: '30-30°C', prob: 0.5 },
    { idx: 2, label: '31-31°C', prob: 0.3 },
  ],
});

/** Build a spy SeedDeps whose latest_house_dist returns the configured response on each successive call. */
function makeDeps(
  distSeq: (DistLike | null)[],
  quality: { nModels: number; hasStats: boolean } = { nModels: 5, hasStats: true },
  over: Partial<Pick<SeedDeps, 'botCfg' | 'buildDist'>> = {},
) {
  const calls: string[] = [];
  let fetchCalls = 0;
  let distIdx = 0;
  const reply = (fn: string): unknown[] => {
    calls.push(fn);
    switch (fn) {
      case 'upsert_event': return [{ event_id: 'evt-1', is_new: false }];
      case 'latest_house_dist': return [{ latest_house_dist: distSeq[Math.min(distIdx++, distSeq.length - 1)] ?? null }];
      case 'bot_seed_quality': return [{ bot_seed_quality: quality }];
      case 'get_build_inputs': return [{ get_build_inputs: null }]; // build no-ops (no forecasts) → written 0
      case 'upsert_distribution': return [{ upsert_distribution: false }];
      case 'upsert_forecast_rows': return [{ upsert_forecast_rows: 1 }];
      default: return [{}];
    }
  };
  const db = {
    rpc<T = Record<string, unknown>>(fn: string, _args: Record<string, unknown>): Promise<T[]> {
      return Promise.resolve(reply(fn) as T[]);
    },
    getConfigRows: async () => [],
  };
  const deps = {
    db,
    cfg: {} as SeedDeps['cfg'], // unused on the no-op build path (get_build_inputs null returns early)
    botCfg: BOT_DEFAULTS,
    fetchJson: async () => {
      fetchCalls++;
      return {};
    },
    now: NOW,
    omForecastBase: 'https://api.open-meteo.com',
    models: ['ecmwf_ifs025'],
    stations: [{ icao: 'EHAM', lat: 52.3, lon: 4.76, tz: 'Europe/Amsterdam' }],
    log: () => {},
    ...over,
  } as unknown as SeedDeps;
  return { deps, calls: () => calls, fetchCalls: () => fetchCalls };
}

describe('seedHouseDist — seedFreshnessMin throttle + OM-on-absence (EDGE2-1)', () => {
  it('(a) a FRESH usable dist is REUSED — no upsert_bucket, no build, no Open-Meteo fetch', async () => {
    const { deps, calls, fetchCalls } = makeDeps([dist(10)]); // made 10 min ago ≪ seedFreshnessMin 180
    const res = await seedHouseDist(makeEv(), 'poly-1', KEYS, deps);
    expect(res.seeded).toBe(true);
    expect(res.probsByLabel.get('30-30°C')).toBeCloseTo(0.5);
    expect(fetchCalls()).toBe(0); // the throttle's whole point — NO redundant OM fetch
    expect(calls()).not.toContain('upsert_bucket');
    expect(calls()).not.toContain('get_build_inputs');
    expect(calls()).not.toContain('upsert_forecast_rows');
  });

  it('(b) a STALE but present dist rebuilds (upsert_bucket + build) but does NOT Open-Meteo fetch', async () => {
    const { deps, calls, fetchCalls } = makeDeps([dist(200), dist(200)]); // 200 min old > 180 → not fresh; still present after build
    const res = await seedHouseDist(makeEv(), 'poly-1', KEYS, deps);
    expect(res.seeded).toBe(true);
    expect(calls()).toContain('upsert_bucket');
    expect(calls()).toContain('get_build_inputs');
    expect(fetchCalls()).toBe(0); // a dist exists after the build → the OM fallback must NOT fire
    expect(calls()).not.toContain('upsert_forecast_rows');
  });

  it('(c) a genuinely ABSENT dist triggers exactly ONE Open-Meteo fetch — the rare fallback (vs cases a/b: zero)', async () => {
    const { deps, calls, fetchCalls } = makeDeps([null, null]); // absent, still absent after the build
    await seedHouseDist(makeEv(), 'poly-1', KEYS, deps);
    expect(fetchCalls()).toBe(1); // OM fires ONLY on genuine absence — the EDGE2-1 fix (not every 2-min tick)
    expect(calls()).toContain('get_build_inputs'); // it DID try the cheap production build first
  });

  it('quality-gate failure (too few models) → houseProb null even when a fresh dist exists', async () => {
    const { deps } = makeDeps([dist(10)], { nModels: 1, hasStats: true }); // 1 model < seedMinModels 3
    const res = await seedHouseDist(makeEv(), 'poly-1', KEYS, deps);
    expect(res.seeded).toBe(false);
    expect(res.reason).toContain('quality_gate');
  });

  // THE CONVERGENCE/ACCURACY SPLIT: the seed forwards biasCorrect to buildDistributionForEvent per
  // botCfg.consensusSource. ensemble_raw/wunderground ⇒ raw center (false); calibrated ⇒ true.
  it.each([
    ['ensemble_raw', false],
    ['calibrated', true],
    ['wunderground', false],
  ] as const)('consensusSource=%s ⇒ buildDist called with biasCorrect=%s', async (source, expected) => {
    const seen: (boolean | undefined)[] = [];
    const buildDist = (async (_db, _cfg, _evId, d) => {
      seen.push(d.biasCorrect);
      return { written: 1, skipped: 0 };
    }) as NonNullable<SeedDeps['buildDist']>;
    const { deps } = makeDeps([dist(200), dist(200)], { nModels: 5, hasStats: true }, {
      botCfg: { ...BOT_DEFAULTS, consensusSource: source },
      buildDist,
    });
    const res = await seedHouseDist(makeEv(), 'poly-1', KEYS, deps);
    expect(res.seeded).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((b) => b === expected)).toBe(true);
  });
});
