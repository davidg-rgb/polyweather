/**
 * maker-exit-panel handler — the per-city fetch pool (2026-07-03 wall-clock fix).
 *
 * The 45-city redeploy's first ticks died at the ~400s isolate wall: 45 SEQUENTIAL convergence_capture_inputs
 * calls with NO fetch timeout never reached the snapshot write (job_runs wedged 'running', gate-of-record
 * stale). These tests pin the fix's three behaviors: (1) a hung per-city RPC is timed out and counted into
 * cityErrors instead of stalling the tick; (2) the worker pool is BOUNDED at fetchConcurrency but actually
 * parallelizes; (3) an exhausted fetch budget degrades to a PARTIAL view — remaining cities are skipped and
 * counted, and the snapshot still lands (a partial snapshot beats a dead tick).
 */
import { describe, expect, it, vi } from 'vitest';
import { makerExitPanel } from '../functions/maker-exit-panel/handler.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';

const NOW = new Date('2026-07-03T00:00:00Z');

type CityBehavior = 'ok' | 'hang' | number; // number = resolve after N ms

interface FakeDbOpts {
  cities: string[];
  behavior?: (city: string) => CityBehavior;
  /** how many leading calls to record_maker_exit_panel throw before one succeeds; Infinity = always fails. */
  writeFailures?: number;
  /** record_bot_gate_snapshot never resolves — the step-4 bookkeeping timeout must bound it. */
  gateSnapshotHangs?: boolean;
}

interface FakeDb {
  port: DbPort;
  fetchedCities: string[];
  maxInFlight: number;
  writes: string[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeDb(opts: FakeDbOpts): FakeDb {
  const state: FakeDb = { port: null as unknown as DbPort, fetchedCities: [], maxInFlight: 0, writes: [] };
  let inFlight = 0;
  let writeAttempts = 0;
  state.port = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      if (fn === 'convergence_capture_inputs') {
        const city = (args.p_cities as string[])[0]!;
        const b = opts.behavior?.(city) ?? 'ok';
        inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, inFlight);
        try {
          if (b === 'hang') return await new Promise<never>(() => {}); // never resolves — the timeout must fire
          if (typeof b === 'number') await sleep(b);
          state.fetchedCities.push(city);
          return [{ convergence_capture_inputs: { captures: [], resolutions: [] } }] as T[];
        } finally {
          inFlight--;
        }
      }
      state.writes.push(fn);
      if (fn === 'record_maker_exit_panel') {
        if (writeAttempts < (opts.writeFailures ?? 0)) {
          writeAttempts++;
          throw new Error('upstream request timeout');
        }
        return [{ record_maker_exit_panel: 7 }] as T[];
      }
      if (fn === 'record_bot_gate_snapshot' && opts.gateSnapshotHangs) {
        return await new Promise<never>(() => {}); // never resolves — the bookkeeping timeout must fire
      }
      return [];
    },
    async getConfigRows() {
      return [{ key: 'bot.cities', value: opts.cities.join(',') }];
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

describe('maker-exit-panel per-city fetch pool', () => {
  it('a hung city RPC is timed out and counted — the tick completes and the snapshot lands', async () => {
    const cities = ['c1', 'c2', 'c3'];
    const db = fakeDb({ cities, behavior: (c) => (c === 'c2' ? 'hang' : 'ok') });
    const stats = await makerExitPanel(ctx(db), { now: NOW, cityTimeoutMs: 50, fetchConcurrency: 3 });
    expect(stats.cityErrors).toBe(1);
    expect(stats.budgetSkipped).toBe(0);
    expect(db.fetchedCities.sort()).toEqual(['c1', 'c3']);
    expect(db.writes).toContain('record_maker_exit_panel'); // the snapshot still landed
    expect(stats.snapshotId).toBe(7);
  });

  it('the worker pool is bounded at fetchConcurrency but parallelizes', async () => {
    const cities = Array.from({ length: 12 }, (_, i) => `c${i}`);
    const db = fakeDb({ cities, behavior: () => 10 });
    const stats = await makerExitPanel(ctx(db), { now: NOW, fetchConcurrency: 4 });
    expect(db.fetchedCities.length).toBe(12); // every city fetched
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
      const cities = Array.from({ length: 6 }, (_, i) => `c${i}`);
      const db = fakeDb({ cities, behavior: () => 30 });
      // budget 0ms: the first wave (claimed at elapsed≡0, frozen by the fake clock) proceeds; every later
      // claim (after the 30ms fake-timer advance below) sees elapsed≥30ms → skipped.
      const statsPromise = makerExitPanel(ctx(db), { now: NOW, fetchConcurrency: 2, fetchBudgetMs: 0 });
      await vi.advanceTimersByTimeAsync(100); // fires every in-flight 30ms city sleep + drains the fallout
      const stats = await statsPromise;
      expect(db.fetchedCities.length).toBe(2);
      expect(stats.budgetSkipped).toBe(4);
      expect(stats.cityErrors).toBe(4); // skipped cities surface through the count the page already shows
      expect(db.writes).toContain('record_maker_exit_panel'); // partial view beats a dead tick
      expect(db.writes).toContain('record_bot_gate_snapshot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the healthy path fetches every city exactly once with zero errors', async () => {
    const cities = ['a', 'b', 'c', 'd', 'e'];
    const db = fakeDb({ cities });
    const stats = await makerExitPanel(ctx(db), { now: NOW });
    expect(db.fetchedCities.sort()).toEqual(cities);
    expect(stats.cityErrors).toBe(0);
    expect(stats.budgetSkipped).toBe(0);
    expect(db.writes).toEqual(
      expect.arrayContaining(['record_maker_exit_panel', 'record_bot_gate_snapshot', 'record_bot_tick']),
    );
    // SIGNAL-BACKLOG #1 follow-on — the reward-eligibility tick diagnostic flows into the stats payload (the
    // fake captures are empty, so it's the "no realized trades yet" NaN, but the field must be present + wired).
    expect('qualifyingTickFrac' in stats).toBe(true);
    expect(Number.isNaN(stats.qualifyingTickFrac as number)).toBe(true);
  });

  it('SIGNAL-BACKLOG #1 follow-on v2 (2026-07-04) — the "WHY zero" dominantDisqualifier flows into the stats payload', async () => {
    const cities = ['a', 'b'];
    const db = fakeDb({ cities });
    const stats = await makerExitPanel(ctx(db), { now: NOW });
    expect('dominantDisqualifier' in stats).toBe(true);
    // no realized trades in this fake fixture (empty captures) → zero resting ticks accrued → the honest 'none'.
    expect(stats.dominantDisqualifier).toBe('none');
  });
});

describe('maker-exit-panel terminal-write retry (WS-5) — wiring, not the retry logic itself (see _shared/retry.test.ts)', () => {
  it('one transient write timeout is retried and the tick still lands (no lost fetch work)', async () => {
    const cities = ['a', 'b', 'c'];
    const db = fakeDb({ cities, writeFailures: 1 }); // 1 failure, then succeeds — within the 2-retry budget
    const stats = await makerExitPanel(ctx(db), { now: NOW, retrySleep: async () => {} });
    expect(stats.snapshotId).toBe(7);
    expect(db.writes.filter((w) => w === 'record_maker_exit_panel')).toHaveLength(2); // 1 failed + 1 landed
    // the fetch phase's own work was NOT re-done or discarded by the write retry.
    expect(db.fetchedCities.sort()).toEqual(cities);
  });

  it('a write that fails on every attempt exhausts the 2 retries and the job throws (fails loudly, no swallow)', async () => {
    const cities = ['a', 'b'];
    const db = fakeDb({ cities, writeFailures: Infinity });
    await expect(makerExitPanel(ctx(db), { now: NOW, retrySleep: async () => {} })).rejects.toThrow(
      'upstream request timeout',
    );
    expect(db.writes.filter((w) => w === 'record_maker_exit_panel')).toHaveLength(3); // 1 initial + 2 retries, then gives up
  });

  it('a HUNG step-4 bookkeeping write is bounded by its timeout — the tick still completes, warning logged, no retry', async () => {
    // the review-fix wiring: record_bot_gate_snapshot / record_bot_tick were raw unbounded awaits inside the
    // step-4 try/catch — a pooler-stall hang there would run the isolate toward the ~400s wall even though
    // the snapshot had already landed. Bounded at bookkeepingTimeoutMs, a hang degrades EXACTLY like any
    // other step-4 failure: non-fatal log, job completes 'ok', and NO retry (a duplicate would pollute the
    // never-pruned §9R-E gate history).
    const cities = ['a', 'b'];
    const db = fakeDb({ cities, gateSnapshotHangs: true });
    const logged: string[] = [];
    const loggingCtx: JobCtx = {
      db: db.port,
      config: { jobWallLimitSec: 150 } as JobCtx['config'],
      log: (msg) => logged.push(msg),
      startedAt: NOW,
    };
    const stats = await makerExitPanel(loggingCtx, { now: NOW, bookkeepingTimeoutMs: 50 });
    expect(stats.snapshotId).toBe(7); // the terminal snapshot landed before step 4 — the tick is 'ok'
    expect(logged.some((m) => m.includes('gate-snapshot / tick write failed (non-fatal)'))).toBe(true);
    expect(db.writes.filter((w) => w === 'record_bot_gate_snapshot')).toHaveLength(1); // bounded, NOT retried
    // the hang in the FIRST bookkeeping write skips the second — the same degrade path as any step-4 throw.
    expect(db.writes).not.toContain('record_bot_tick');
  });
});
