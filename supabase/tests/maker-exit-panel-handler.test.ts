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
import { describe, expect, it } from 'vitest';
import { makerExitPanel } from '../functions/maker-exit-panel/handler.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';

const NOW = new Date('2026-07-03T00:00:00Z');

type CityBehavior = 'ok' | 'hang' | number; // number = resolve after N ms

interface FakeDbOpts {
  cities: string[];
  behavior?: (city: string) => CityBehavior;
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
      if (fn === 'record_maker_exit_panel') return [{ record_maker_exit_panel: 7 }] as T[];
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
    const cities = Array.from({ length: 6 }, (_, i) => `c${i}`);
    const db = fakeDb({ cities, behavior: () => 30 });
    // budget 0ms: the first wave (claimed at elapsed≈0) proceeds; every later claim sees elapsed≥30ms → skipped.
    const stats = await makerExitPanel(ctx(db), { now: NOW, fetchConcurrency: 2, fetchBudgetMs: 0 });
    expect(db.fetchedCities.length).toBe(2);
    expect(stats.budgetSkipped).toBe(4);
    expect(stats.cityErrors).toBe(4); // skipped cities surface through the count the page already shows
    expect(db.writes).toContain('record_maker_exit_panel'); // partial view beats a dead tick
    expect(db.writes).toContain('record_bot_gate_snapshot');
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
  });
});
