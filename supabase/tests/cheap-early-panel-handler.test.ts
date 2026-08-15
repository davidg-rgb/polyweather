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
  /** 0128 staged idiom: the slim RPC exists but on the OLD 4-arg signature — only the p_windows call 42883s. */
  windowSetAbsent?: boolean;
  /** 0127: the top-K city filter's input — 'error' makes the read fail (it must stay non-fatal). */
  hitRates?: Record<string, { hitRate: number; graded: number }> | 'error';
  /** 0129: the persisted variant ledger read — 'error' makes it fail (it must stay non-fatal). */
  ledgerRead?: Record<string, unknown[]> | 'error';
  /** 0129: record_cheap_early_variant_entries always throws (the write must stay non-fatal). */
  ledgerWriteFails?: boolean;
}

interface FakeDb {
  port: DbPort;
  fetchedCities: string[];
  maxInFlight: number;
  writes: string[];
  /** every rpc call's args, by fn name (the window-set + canonical-gate-payload assertions read these). */
  args: Record<string, Record<string, unknown>[]>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fakeDb(opts: FakeDbOpts): FakeDb {
  const state: FakeDb = { port: null as unknown as DbPort, fetchedCities: [], maxInFlight: 0, writes: [], args: {} };
  let inFlight = 0;
  state.port = {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
      (state.args[fn] ??= []).push(args);
      // 0127: the top-K city filter's input — best-effort, so a failure must not fail the tick.
      if (fn === 'cheap_early_city_hit_rates') {
        if (opts.hitRates === 'error') throw new Error('cheap_early_city_hit_rates boom');
        return [{ cheap_early_city_hit_rates: opts.hitRates ?? {} }] as T[];
      }
      // 0129: the persisted variant ledger — best-effort on BOTH legs; neither may fail the tick.
      if (fn === 'cheap_early_variant_ledger_read') {
        if (opts.ledgerRead === 'error') throw new Error('cheap_early_variant_ledger_read boom');
        return [{ cheap_early_variant_ledger_read: opts.ledgerRead ?? {} }] as T[];
      }
      if (fn === 'record_cheap_early_variant_entries') {
        state.writes.push(fn);
        if (opts.ledgerWriteFails) throw new Error('record_cheap_early_variant_entries boom');
        return [{ record_cheap_early_variant_entries: (args.p_rows as unknown[]).length }] as T[];
      }
      // 0126: the panel's primary read. Pre-migration (slimAbsent) it throws undefined_function so the
      // handler's staged fallback to convergence_capture_inputs is exercised.
      if (fn === 'cheap_early_capture_inputs' && opts.slimAbsent) {
        throw new Error('function public.cheap_early_capture_inputs(...) does not exist (42883)');
      }
      // 0128: pre-migration the function exists on 0126's 4-arg signature — the p_windows call alone is undefined.
      if (fn === 'cheap_early_capture_inputs' && opts.windowSetAbsent && args.p_windows !== undefined) {
        throw new Error('function public.cheap_early_capture_inputs(integer, text[], double precision, double precision, double precision[]) does not exist (42883)');
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

  it('0128: the slim read is asked for the DISJOINT window SET, not the contiguous [12,36] union', async () => {
    const db = fakeDb({ cities: ['ankara'] });
    await cheapEarlyPanel(ctx(db), { now: NOW });
    const call = db.args.cheap_early_capture_inputs![0]!;
    // late-12h windows on [12,15] and the canonical/survivor on up to 36 — a narrower pull STARVES a variant,
    // while the contiguous union drags in the dead 15–24h middle (2x the rows/city — the 287s tick).
    expect(call.p_windows).toEqual([12, 15, 24, 36]);
    // the legacy scalars ride along as the span, so a 0128-less database still gets a serviceable window.
    expect(call.p_window_lo_h).toBe(12);
    expect(call.p_window_hi_h).toBe(36);
  });

  it('0128 staged idiom: an OLD-signature slim RPC (no p_windows) retries with the [12,36] span — no cityErrors', async () => {
    const db = fakeDb({ cities: ['ankara', 'helsinki'], windowSetAbsent: true });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(stats.cityErrors).toBe(0); // the 42883 is a fallback trigger, never an error
    expect(db.fetchedCities.sort()).toEqual(['ankara', 'helsinki']); // both cities served by the 0126 signature
    const served = db.args.cheap_early_capture_inputs!.filter((a) => a.p_windows === undefined);
    expect(served.length).toBeGreaterThan(0);
    for (const a of served) {
      expect(a.p_window_lo_h).toBe(12);
      expect(a.p_window_hi_h).toBe(36);
    }
    expect(db.args.convergence_capture_inputs).toBeUndefined(); // never degrades past the slim read
    expect(db.writes).toContain('record_cheap_early_panel');
  });

  it('0127: the city hit rates are read once with the registered top-K params', async () => {
    const db = fakeDb({ cities: ['ankara'], hitRates: { ankara: { hitRate: 0.4, graded: 12 } } });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(db.args.cheap_early_city_hit_rates).toHaveLength(1);
    expect(db.args.cheap_early_city_hit_rates![0]).toEqual({ p_window_days: 28, p_min_graded: 8 });
    expect(stats.cityHitRates).toBe(1);
    expect(stats.variants).toBe(6);
  });

  it('0127: a FAILING hit-rates read is non-fatal — the tick completes and the snapshot lands', async () => {
    const db = fakeDb({ cities: ['ankara'], hitRates: 'error' });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(stats.cityHitRates).toBe(0); // top-K variants score nothing (fail-closed), the rest are unaffected
    expect(stats.variants).toBe(6);
    expect(db.writes).toContain('record_cheap_early_panel');
  });

  it('SAFETY: the gate of record is written ONCE per tick, with the CANONICAL payload only', async () => {
    const db = fakeDb({ cities: ['ankara', 'helsinki'] });
    // gateMinMarkets 0 lifts the degraded-tick guard so the write actually happens on this synthetic tick.
    await cheapEarlyPanel(ctx(db), { now: NOW, gateMinMarkets: 0 });
    expect(db.writes.filter((w) => w === 'record_cheap_early_gate')).toHaveLength(1);
    const payload = db.args.record_cheap_early_gate![0]!.p_payload as Record<string, unknown>;
    // exactly the canonical gate fields — NO variant block, id, or verdict may ride along into bot_gate_snapshot.
    expect(Object.keys(payload).sort()).toEqual([
      'ciHigh', 'ciLow', 'label', 'meanNetReturn', 'nCities', 'nDistinctDays', 'nMarkets', 'nOpen',
      'reason', 'totalNetUsd', 'winFrac', 'zeroSkillPassRate',
    ]);
    expect(JSON.stringify(payload)).not.toContain('variant');
  });

  // ── 0129 · the persisted variant ledger (read once, write the realized rows back) ────────────────
  /** `n` synthetic PERSISTED canonical entries — the shape cheap_early_variant_ledger_read returns. */
  const ledgerRows = (n: number): Record<string, unknown[]> => ({
    canonical: Array.from({ length: n }, (_, i) => ({
      city: `c${i}`,
      targetDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
      label: '21C',
      ask: 0.25,
      hoursToClose: 30,
      depthUsd: 400,
      won: i % 4 === 0,
      net: i % 4 === 0 ? 2.85 : -1,
      stakeUsd: 20,
    })),
  });

  it('0129: the ledger is read ONCE and threaded into the view (the forward n survives the capture prune)', async () => {
    const db = fakeDb({ cities: ['ankara'], ledgerRead: ledgerRows(3) });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(db.args.cheap_early_variant_ledger_read).toHaveLength(1);
    expect(stats.ledgerAvailable).toBe(true);
    // the replay saw NO captures this tick, so every scored market came from the ledger.
    expect(stats.nMarkets).toBe(3);
    expect(db.writes).toContain('record_cheap_early_panel');
  });

  it('0129: a FAILING ledger read is non-fatal — the tick falls back to the replayed captures alone', async () => {
    const db = fakeDb({ cities: ['ankara'], ledgerRead: 'error' });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(stats.ledgerAvailable).toBe(false);
    expect(stats.nMarkets).toBe(0);
    expect(db.writes).toContain('record_cheap_early_panel'); // the snapshot still lands
  });

  it('0129: every REALIZED entry is written back once, chunked at 500 rows', async () => {
    const db = fakeDb({ cities: ['ankara'], ledgerRead: ledgerRows(600) });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    const calls = db.args.record_cheap_early_variant_entries!;
    // 600 canonical rows merged in -> 600 realized entries out, in two chunks (500 + 100). No other variant
    // has ledger rows and no captures were served, so nothing else contributes.
    expect(calls).toHaveLength(2);
    expect((calls[0]!.p_rows as unknown[]).length).toBe(500);
    expect((calls[1]!.p_rows as unknown[]).length).toBe(100);
    expect(stats.ledgerSent).toBe(600);
    expect(stats.ledgerWritten).toBe(600);
    // the row shape the 0129 RPC parses — key + grade + scoring + the engine tag.
    const row = (calls[0]!.p_rows as Record<string, unknown>[])[0]!;
    expect(row.variantId).toBe('canonical');
    expect(typeof row.city).toBe('string');
    expect(typeof row.targetDate).toBe('string');
    expect(typeof row.won).toBe('boolean');
    expect(typeof row.net).toBe('number');
    expect(row.stakeUsd).toBe(20);
    expect(row.engineVersion).toBe('ce2');
  });

  it('0129: the chunk size is a seam — 250 rows split into three calls of 100/100/50', async () => {
    const db = fakeDb({ cities: ['ankara'], ledgerRead: ledgerRows(250) });
    await cheapEarlyPanel(ctx(db), { now: NOW, ledgerChunk: 100 });
    const sizes = db.args.record_cheap_early_variant_entries!.map((a) => (a.p_rows as unknown[]).length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it('0129: a FAILING ledger write is non-fatal (retried once) — the tick completes and the snapshot lands', async () => {
    const db = fakeDb({ cities: ['ankara'], ledgerRead: ledgerRows(2), ledgerWriteFails: true });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    // one chunk, attempted twice (the single retry), then given up on — the next tick re-sends.
    expect(db.args.record_cheap_early_variant_entries).toHaveLength(2);
    expect(stats.ledgerWritten).toBe(0);
    expect(stats.ledgerSkipped).toBe(2);
    expect(db.writes).toContain('record_cheap_early_panel');
  });

  it('0129: nothing is written when there is nothing realized to persist', async () => {
    const db = fakeDb({ cities: ['ankara'] });
    const stats = await cheapEarlyPanel(ctx(db), { now: NOW });
    expect(db.args.record_cheap_early_variant_entries).toBeUndefined();
    expect(stats.ledgerSent).toBe(0);
  });
});
