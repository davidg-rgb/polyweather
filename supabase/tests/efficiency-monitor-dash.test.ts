/**
 * record_efficiency_monitor + dash_efficiency_monitor (migration 0091) — the forward efficiency-monitor
 * paper-loop recorder + operator read. End-to-end against PGlite (the real SQL): the record→read
 * round-trip, the latest-snapshot collapse, the compact trend-series extraction (the #>> jsonb path
 * contract the dashboard reads), retention, and operator_guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const INTRUDER = { email: 'not-the-operator@example.com' };

/** A representative view (the shape efficiency-monitor-run.ts --record persists). */
const VIEW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  window: { from: '2026-04-21', switchDate: '2026-06-15', to: '2026-07-08', liveSlot: '10Z', leads: [1, 2] },
  nEvents: 1001,
  s1: {
    verdict: { label: 'KILL', nMarkets: 3442, nCities: 45, nDistinctDays: 21, winFrac: 0.06, meanNetReturn: -0.0009, ciLow: -0.010, ciHigh: 0.0082, zeroSkillPassRate: 0.013, reason: 'KILL' },
    edge: { edge: 0.0016, edgeCiLo: -0.0059, edgeCiHi: 0.0092, nGraded: 3442, hitRate: 0.06, avgAsk: 0.065 },
    byQuartile: { 1: { edge: -0.0067 }, 2: { edge: -0.0061 }, 3: { edge: 0.0044 }, 4: { edge: 0.0116 } },
    q4DayClustered: { nClusters: 21, mean: 0.0105, lo: -0.0111, hi: 0.0320 },
    q4DistinctWeatherDays: 21,
    nPurchases: 3442,
  },
  s2: { verdict: { label: 'INSUFFICIENT_DATA', nMarkets: 10, nCities: 9, nDistinctDays: 7 }, edge: { edge: 0.0299, nGraded: 10 }, nTroughs: 10, nPurchases: 10 },
  ...over,
});

const record = (db: PGlite, asOf: string, view: Record<string, unknown>): Promise<number> =>
  asRole(db, 'service_role', null, async () => {
    const r = await rows<{ id: number }>(db, `select public.record_efficiency_monitor($1::date, $2::jsonb) as id`, [asOf, JSON.stringify(view)]);
    return Number(r[0]!.id);
  });

const dash = (db: PGlite, actor = OPERATOR): Promise<Record<string, unknown>> =>
  asRole(db, 'authenticated', actor, async () => {
    const r = await rows<{ out: Record<string, unknown> }>(db, `select public.dash_efficiency_monitor() as out`);
    return r[0]!.out;
  });

describe('efficiency-monitor dash (0091)', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  it('records a snapshot and reads it back with the S1 verdict intact', async () => {
    await record(db, '2026-07-08', VIEW());
    const out = await dash(db);
    expect(out.asOf).toBe('2026-07-08');
    const view = out.view as {
      s1: { verdict: { label: string }; q4DayClustered: { lo: number } };
      s2: { verdict: { label: string } };
    };
    expect(view.s1.verdict.label).toBe('KILL');
    expect(Number(view.s1.q4DayClustered.lo)).toBeCloseTo(-0.0111, 4);
    expect(view.s2.verdict.label).toBe('INSUFFICIENT_DATA');
  });

  it('returns the LATEST snapshot and a trend series with the dashboard #>> paths populated', async () => {
    await record(db, '2026-07-09', VIEW({ nEvents: 1050 }));
    const out = await dash(db);
    expect(out.asOf).toBe('2026-07-09'); // latest wins
    const history = out.history as Record<string, unknown>[];
    expect(history.length).toBeGreaterThanOrEqual(2);
    const pt = history[history.length - 1]!; // newest
    expect(pt.s1Label).toBe('KILL');
    expect(Number(pt.s1N)).toBe(3442);
    expect(Number(pt.s1Q4Edge)).toBeCloseTo(0.0105, 4);
    expect(Number(pt.s1Q4Days)).toBe(21);
    expect(pt.s2Label).toBe('INSUFFICIENT_DATA');
  });

  it('empty state returns a null-view object (page renders the deploying banner)', async () => {
    const fresh = await freshDb();
    try {
      const out = await dash(fresh);
      expect(out.view).toBeNull();
      expect(out.history).toEqual([]);
    } finally { await fresh.close(); }
  });

  it('operator_guard blocks a non-operator', async () => {
    await expect(dash(db, INTRUDER)).rejects.toThrow();
  });
});
