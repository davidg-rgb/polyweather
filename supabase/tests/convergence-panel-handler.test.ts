/**
 * convergence-panel handler — the v7 per-city fetch pool (the maker-exit-panel v4 port, WS-1 2026-07-03).
 *
 * The v6 handler fetched the allowlist SEQUENTIALLY with no fetch timeout — the same shape that wedged the
 * maker-exit-panel ticks at the ~400s isolate wall (the cron was paused on v6 pending this fix). These tests
 * mirror the maker-exit-panel handler suite and pin the pool's behaviors on THIS handler: (1) a hung per-city
 * RPC is timed out and counted into cityErrors instead of stalling the tick; (2) the worker pool is BOUNDED at
 * fetchConcurrency but actually parallelizes; (3) an exhausted fetch budget degrades to a PARTIAL view —
 * remaining cities are skipped and counted, and the snapshot still lands; (4) INTERLEAVED per-city arrival is
 * safe — buildEvents groups per event and sorts ticks internally, so out-of-order merges lose nothing.
 */
import { describe, expect, it, vi } from 'vitest';
import { convergencePanel } from '../functions/convergence-panel/handler.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { BOT_DEFAULTS } from '../../packages/core/src/index.ts';

const NOW = new Date('2026-07-03T00:00:00Z');
// the handler is PINNED to the §9R-locked code allowlist (NOT bot.cities config) — drive the fakes off it.
const CITIES = BOT_DEFAULTS.cities;

type CityBehavior = 'ok' | 'hang' | number; // number = resolve after N ms

interface FakeDbOpts {
  behavior?: (city: string, i: number) => CityBehavior;
  /** rows returned per city (default none — an empty capture window). */
  rowsFor?: (city: string) => unknown[];
  /** how many leading calls to record_convergence_panel throw before one succeeds; Infinity = always fails. */
  writeFailures?: number;
}

interface FakeDb {
  port: DbPort;
  fetchedCities: string[];
  maxInFlight: number;
  writes: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeDb(opts: FakeDbOpts = {}): FakeDb {
  const state: FakeDb = { port: null as unknown as DbPort, fetchedCities: [], maxInFlight: 0, writes: [] };
  let inFlight = 0;
  let writeAttempts = 0;
  state.port = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      if (fn === 'convergence_capture_inputs') {
        const city = (args.p_cities as string[])[0]!;
        const b = opts.behavior?.(city, CITIES.indexOf(city)) ?? 'ok';
        inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, inFlight);
        try {
          if (b === 'hang') return await new Promise<never>(() => {}); // never resolves — the timeout must fire
          if (typeof b === 'number') await sleep(b);
          state.fetchedCities.push(city);
          return [
            { convergence_capture_inputs: { captures: opts.rowsFor?.(city) ?? [], resolutions: [] } },
          ] as T[];
        } finally {
          inFlight--;
        }
      }
      state.writes.push(fn);
      if (fn === 'record_convergence_panel') {
        if (writeAttempts < (opts.writeFailures ?? 0)) {
          writeAttempts++;
          throw new Error('upstream request timeout');
        }
        return [{ record_convergence_panel: 7 }] as T[];
      }
      return [];
    },
    async getConfigRows() {
      return []; // the handler must never need config — it is pinned to BOT_DEFAULTS (the v6 contract, kept)
    },
  };
  return state;
}

const ctx = (db: FakeDb): JobCtx => ({
  db: db.port,
  config: { jobWallLimitSec: 150 } as JobCtx['config'],
  log: () => {},
  startedAt: NOW,
});

/** A minimal FRESH capture row (eventId + min hours_since_listing < 1) buildEvents will keep. */
const freshRow = (city: string, minsAgo: number) => ({
  eventId: `ev-${city}`,
  capturedAt: new Date(NOW.getTime() - minsAgo * 60_000).toISOString(),
  city,
  targetDate: '2026-07-03',
  tzName: 'Europe/Amsterdam',
  createdAtGamma: null,
  resolvesAt: null,
  hoursSinceListing: 0.5,
  peakMid: 0.12,
  isFlatOpen: true,
  houseSeeded: true,
  buckets: [],
  evVol24h: 9000,
  negRisk: true,
});

describe('convergence-panel per-city fetch pool (v7)', () => {
  it('a hung city RPC is timed out and counted — the tick completes and the snapshot lands', async () => {
    const hung = CITIES[1]!;
    const db = fakeDb({ behavior: (c) => (c === hung ? 'hang' : 'ok') });
    const stats = await convergencePanel(ctx(db), { now: NOW, cityTimeoutMs: 50, fetchConcurrency: CITIES.length });
    expect(stats.cityErrors).toBe(1);
    expect(stats.budgetSkipped).toBe(0);
    expect(db.fetchedCities.sort()).toEqual([...CITIES].filter((c) => c !== hung).sort());
    expect(db.writes).toContain('record_convergence_panel'); // the snapshot still landed
    expect(stats.snapshotId).toBe(7);
  });

  it('the worker pool is bounded at fetchConcurrency but parallelizes', async () => {
    const db = fakeDb({ behavior: () => 10 });
    const stats = await convergencePanel(ctx(db), { now: NOW, fetchConcurrency: 4 });
    expect(db.fetchedCities.length).toBe(CITIES.length); // every allowlist city fetched
    expect(db.maxInFlight).toBeLessThanOrEqual(4); // never exceeds the bound …
    expect(db.maxInFlight).toBeGreaterThanOrEqual(2); // … and genuinely runs in parallel
    expect(stats.cityErrors).toBe(0);
  });

  it('an exhausted budget skips remaining cities into cityErrors and still writes a partial snapshot', async () => {
    // FAKE TIMERS (2026-07-03, WS-5): this test previously raced real wall-clock Date.now() against a
    // real setTimeout-based city latency — under machine load the scheduling jitter between "the first
    // wave's synchronous budget check" and "the actual elapsed ms" could let an extra city slip through
    // or drop (observed flake: "expected 1 to be 2"). Fake timers freeze Date.now() at exactly
    // fetchStarted until explicitly advanced, so the fetchBudgetMs:0 boundary is decided by the SAME
    // clock the test controls — deterministic regardless of host speed.
    vi.useFakeTimers();
    try {
      const db = fakeDb({ behavior: () => 30 });
      // budget 0ms: the first wave (claimed at elapsed≡0, frozen by the fake clock) proceeds; every later
      // claim (after the 30ms fake-timer advance below) sees elapsed≥30ms → skipped.
      const statsPromise = convergencePanel(ctx(db), { now: NOW, fetchConcurrency: 2, fetchBudgetMs: 0 });
      await vi.advanceTimersByTimeAsync(100); // fires every in-flight 30ms city sleep + drains the fallout
      const stats = await statsPromise;
      expect(db.fetchedCities.length).toBe(2);
      expect(stats.budgetSkipped).toBe(CITIES.length - 2);
      expect(stats.cityErrors).toBe(CITIES.length - 2); // skipped cities surface through the count the page shows
      expect(db.writes).toContain('record_convergence_panel'); // partial view beats a dead tick
    } finally {
      vi.useRealTimers();
    }
  });

  it('the healthy path fetches every allowlist city exactly once with zero errors', async () => {
    const db = fakeDb();
    const stats = await convergencePanel(ctx(db), { now: NOW });
    expect(db.fetchedCities.sort()).toEqual([...CITIES].sort());
    expect(stats.cityErrors).toBe(0);
    expect(stats.budgetSkipped).toBe(0);
    expect(db.writes).toContain('record_convergence_panel');
  });

  it('INTERLEAVED arrival is safe: reversed per-city latencies still yield every fresh event in the view', async () => {
    // later-claimed cities resolve FIRST (reversed delays) → the merged captures arrive out of allowlist
    // order; buildEvents groups per event + sorts ticks by capturedAt, so the view must count them all.
    const db = fakeDb({
      behavior: (_c, i) => (CITIES.length - i) * 5,
      rowsFor: (city) => [freshRow(city, 40), freshRow(city, 10)],
    });
    const stats = await convergencePanel(ctx(db), { now: NOW, fetchConcurrency: 5 });
    expect(stats.cityErrors).toBe(0);
    expect(stats.captureRows).toBe(CITIES.length * 2); // every row merged despite out-of-order completion
    expect(stats.freshEvents).toBe(CITIES.length); // one fresh event per city survived the grouping
    expect(db.writes).toContain('record_convergence_panel');
  });
});

describe('convergence-panel terminal-write retry (WS-5) — wiring, not the retry logic itself (see _shared/retry.test.ts)', () => {
  it('one transient write timeout is retried and the tick still lands (no lost fetch work)', async () => {
    const db = fakeDb({ writeFailures: 1 }); // 1 failure, then succeeds — within the 2-retry budget
    const stats = await convergencePanel(ctx(db), { now: NOW, retrySleep: async () => {} });
    expect(stats.snapshotId).toBe(7);
    expect(db.writes.filter((w) => w === 'record_convergence_panel')).toHaveLength(2); // 1 failed + 1 landed
    // the fetch phase's own work was NOT re-done or discarded by the write retry.
    expect(db.fetchedCities.sort()).toEqual([...CITIES].sort());
  });

  it('a write that fails on every attempt exhausts the 2 retries and the job throws (fails loudly, no swallow)', async () => {
    const db = fakeDb({ writeFailures: Infinity });
    await expect(convergencePanel(ctx(db), { now: NOW, retrySleep: async () => {} })).rejects.toThrow(
      'upstream request timeout',
    );
    expect(db.writes.filter((w) => w === 'record_convergence_panel')).toHaveLength(3); // 1 initial + 2 retries, then gives up
  });
});
