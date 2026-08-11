/**
 * cheap-early-panel handler (migration 0117) — the per-city fetch pool + the pause gate + the degraded-gate guard.
 *
 * Pins: (1) cheap_early.enabled=0 pauses the tick (no compute, no writes); (2) a hung per-city RPC is timed out and
 * counted into cityErrors instead of stalling the tick, and the snapshot still lands; (3) the worker pool is
 * BOUNDED at fetchConcurrency but parallelizes; (4) an exhausted budget degrades to a PARTIAL view; (5) the
 * degraded-tick guard withholds record_cheap_early_gate when the view is partial / undersized (the gate of record
 * must not be written over a biased city subset).
 */
import { describe, expect, it } from 'vitest';
import { CITY_TIMEOUT_MS, cheapEarlyPanel } from '../functions/cheap-early-panel/handler.ts';
import type { DbPort } from '../functions/_shared/db.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';

const NOW = new Date('2026-07-25T00:00:00Z');

type CityBehavior = 'ok' | 'hang' | number; // number = resolve after N ms

interface FakeDbOpts {
  cities: string[];
  enabled?: string; // the cheap_early.enabled config value ('1' default)
  behavior?: (city: string) => CityBehavior;
  gateHangs?: boolean; // record_cheap_early_gate never resolves — the bookkeeping timeout must bound it
  /** 0126 staged idiom: the slim RPC is absent (pre-migration) — throws undefined_function. */
  slimAbsent?: boolean;
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
      // 0126: the panel's primary read. Pre-migration (slimAbsent) it throws undefined_function so the
      // handler's staged fallback to convergence_capture_inputs is exercised.
      if (fn === 'cheap_early_capture_inputs' && opts.slimAbsent) {
        throw new Error('function public.cheap_early_capture_inputs(...) does not exist (42883)');
      }
      if (fn === 'cheap_early_capture_inputs' || fn === 'convergence_capture_inputs') {
        const city = (args.p_cities as string[])[0]!;
        const b = opts.behavior?.(city) ?? 'ok';
        inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, inFlight);
        try {
          if (b === 'hang') return await new Promise<never>(() => {}); // never resolves — the timeout must fire
          if (typeof b === 'number') await sleep(b);
          state.fetchedCities.push(city);
          return [{ [fn]: { captures: [], resolutions: [] } }] as T[];
        } finally {
          inFlight--;
        }
      }
      state.writes.push(fn);
      if (fn === 'record_cheap_early_panel') return [{ record_cheap_early_panel: 7 }] as T[];
      if (fn === 'record_cheap_early_gate' && opts.gateHangs) {
        return await new Promise<never>(() => {}); // never resolves — the bookkeeping timeout must fire
      }
      return [];
    },
    async getConfigRows() {
      return [
        { key: 'cheap_early.cities', value: opts.cities.join(',') },
        { key: 'cheap_early.enabled', value: opts.enabled ?? '1' },
      ];
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

describe('cheap-early-panel handler', () => {
  it('CITY_TIMEOUT_MS outlasts the RPC 40s statement_timeout', () => {
    expect(CITY_TIMEOUT_MS).toBeGreaterThan(40_000);
  });

  it('paused (cheap_early.enabled=0) — no compute, no writes', async () => {
    const db = fakeDb({ cities: ['ankara', 'helsinki'], enabled: '0' });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(stats.paused).toBe(true);
    expect(db.fetchedCities).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('fetches every city and lands the snapshot; the gate write is SKIPPED at n=0 (degraded/undersized)', async () => {
    const db = fakeDb({ cities: ['ankara', 'helsinki', 'kuala-lumpur', 'wellington'] });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(db.fetchedCities.sort()).toEqual(['ankara', 'helsinki', 'kuala-lumpur', 'wellington']);
    expect(db.writes).toContain('record_cheap_early_panel'); // the snapshot always lands
    expect(db.writes).not.toContain('record_cheap_early_gate'); // n=0 < 40 → the gate of record is withheld
    expect(stats.gateWriteSkipped).toBe('degraded');
    expect(stats.cityErrors).toBe(0);
  });

  it('a hung city RPC is timed out and counted — the tick completes and the snapshot lands', async () => {
    const db = fakeDb({
      cities: ['ankara', 'helsinki'],
      behavior: (c) => (c === 'helsinki' ? 'hang' : 'ok'),
    });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW, cityTimeoutMs: 40 });
    expect(stats.cityErrors).toBe(1);
    expect(db.fetchedCities).toEqual(['ankara']);
    expect(db.writes).toContain('record_cheap_early_panel');
  });

  it('the worker pool is bounded at fetchConcurrency but parallelizes', async () => {
    const db = fakeDb({ cities: ['a', 'b', 'c', 'd', 'e', 'f'], behavior: () => 20 });
    await cheapEarlyPanel(ctx(db), { now: NOW, fetchConcurrency: 2 });
    expect(db.maxInFlight).toBeLessThanOrEqual(2);
    expect(db.maxInFlight).toBeGreaterThan(1); // actually parallelized, not serial
    expect(db.fetchedCities.length).toBe(6);
  });

  it('an exhausted fetch budget degrades to a partial view (remaining cities skipped + counted)', async () => {
    const db = fakeDb({ cities: ['a', 'b', 'c', 'd'], behavior: () => 30 });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW, fetchConcurrency: 1, fetchBudgetMs: 10 });
    expect((stats.budgetSkipped as number)).toBeGreaterThan(0);
    expect(db.writes).toContain('record_cheap_early_panel'); // a partial snapshot still beats a dead tick
  });

  it('0126: the slim RPC (cheap_early_capture_inputs) is the primary read', async () => {
    const db = fakeDb({ cities: ['ankara', 'helsinki'] });
    const rpcNames: string[] = [];
    const inner = db.port.rpc.bind(db.port);
    db.port.rpc = async (fn: string, args: Record<string, unknown>) => (rpcNames.push(fn), inner(fn, args));
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(stats.cityErrors).toBe(0);
    expect(rpcNames.filter((f) => f === 'cheap_early_capture_inputs').length).toBe(2);
    expect(rpcNames).not.toContain('convergence_capture_inputs');
  });

  it('0126 staged idiom: an absent slim RPC (pre-migration) falls back to convergence_capture_inputs — no cityErrors', async () => {
    const db = fakeDb({ cities: ['ankara', 'helsinki'], slimAbsent: true });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(stats.cityErrors).toBe(0); // the 42883 is a fallback trigger, never an error
    expect(db.fetchedCities.sort()).toEqual(['ankara', 'helsinki']); // both cities served by the legacy read
    expect(db.writes).toContain('record_cheap_early_panel');
  });
});
