/**
 * record_cross_venue_captures + dash_cross_venue (migrations 0062 + 0063) — the cross-venue RV panel
 * recorder + operator read RPC. End-to-end against PGlite (the real SQL functions). Closes the
 * code-review gaps (ranks 4 + 7): the TS-CaptureRow ↔ SQL-column round-trip (a silent NULL-on-rename
 * for a week otherwise), the jsonb-OBJECT contract (the 0044 trap), the latest-per-(city,date) collapse,
 * the has_real_depth denominator, the real-depth-scoped headline (0063), and operator_guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const INTRUDER = { email: 'not-the-operator@example.com' };

/** A fully-populated capture row (camelCase, exactly what CrossVenueCaptureRow sends). */
const ROW = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  capturedAt: new Date(Date.now() - 60_000).toISOString(),
  city: 'nyc', targetDate: '2026-06-25',
  polyNBuckets: 11, kalshiNBuckets: 6,
  polyMeanF: 82.561, kalshiMeanF: 82.205, meanDiffF: 0.356,
  maxAbsGap: 0.1526, maxGapAtF: 83,
  bestNetEdge: 0.05346, edgeAtF: 83, direction: 'buyKalshiSellPoly',
  cashflow: 0.3816, expPayoff: -0.3281,
  limitDepth: 891, hasRealDepth: true, netPositive: true,
  execSize: 120, isExecutable: true, // 0064: a net-positive row is a WIN only if executable at touch depth
  ...over,
});

const record = (db: PGlite, rowsArr: Record<string, unknown>[]): Promise<number> =>
  asRole(db, 'service_role', null, async () => {
    const r = await rows<{ n: number }>(db, `select public.record_cross_venue_captures($1::jsonb) as n`, [JSON.stringify(rowsArr)]);
    return Number(r[0]!.n);
  });

const dash = (db: PGlite, days = 14): Promise<Record<string, unknown>> =>
  asRole(db, 'authenticated', OPERATOR, async () => {
    const r = await rows<{ out: Record<string, unknown> }>(db, `select public.dash_cross_venue($1) as out`, [days]);
    return r[0]!.out;
  });

describe('record_cross_venue_captures — TS ↔ SQL round-trip (rank 4)', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  it('every field round-trips to its column (multi-word names + booleans + nullif optionals)', async () => {
    expect(await record(db, [ROW()])).toBe(1);
    const r = await rows<Record<string, unknown>>(db, `select * from public.cross_venue_captures where city = 'nyc'`);
    const got = r[0]!;
    expect(Number(got.poly_n_buckets)).toBe(11);
    expect(Number(got.kalshi_n_buckets)).toBe(6);
    expect(Number(got.max_gap_at_f)).toBe(83);
    expect(Number(got.best_net_edge)).toBeCloseTo(0.05346, 5);
    expect(Number(got.mean_diff_f)).toBeCloseTo(0.356, 3);
    expect(got.direction).toBe('buyKalshiSellPoly');
    expect(got.has_real_depth).toBe(true);
    expect(got.net_positive).toBe(true);
    expect(Number(got.exec_size)).toBe(120); // 0064 true-depth round-trip
    expect(got.is_executable).toBe(true);
  });

  it('absent optionals become NULL (nullif), not 0 — a sparse row', async () => {
    await record(db, [ROW({ city: 'sparse', polyMeanF: '', kalshiMeanF: '', bestNetEdge: '', maxGapAtF: '' })]);
    const r = await rows<Record<string, unknown>>(db, `select * from public.cross_venue_captures where city = 'sparse'`);
    expect(r[0]!.poly_mean_f).toBeNull();
    expect(r[0]!.best_net_edge).toBeNull();
    expect(r[0]!.max_gap_at_f).toBeNull();
  });
});

describe('dash_cross_venue — shape, collapse, denominator, guard (rank 7)', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // nyc: two ticks SAME (city,date) → collapse to latest (best_net_edge 0.06); real-depth, net-positive.
    // la/chi/mia: real-depth efficient days (net-negative) — the KILL evidence the BLOCKER fix now keeps.
    // den: a THIN-depth day (has_real_depth false) — must be excluded from the gate denominator.
    await record(db, [
      ROW({ city: 'nyc', capturedAt: new Date(Date.now() - 40 * 60_000).toISOString(), bestNetEdge: 0.02, netPositive: true }),
      ROW({ city: 'nyc', capturedAt: new Date(Date.now() - 20 * 60_000).toISOString(), bestNetEdge: 0.06, netPositive: true }),
      ROW({ city: 'la', bestNetEdge: -0.03, netPositive: false }),
      ROW({ city: 'chi', bestNetEdge: -0.01, netPositive: false }),
      ROW({ city: 'mia', bestNetEdge: -0.02, netPositive: false }),
      ROW({ city: 'den', bestNetEdge: 0.40, netPositive: true, hasRealDepth: false }),
    ]);
  });
  afterAll(async () => { await db?.close(); });

  it('returns a jsonb OBJECT (the 0044 trap) with array sub-fields', async () => {
    const ty = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ ty: string }>(db, `select jsonb_typeof(public.dash_cross_venue(14)) as ty`, []);
      return r[0]!.ty;
    });
    expect(ty).toBe('object'); // never a top-level array
    const out = await dash(db);
    expect(Array.isArray(out.perCity)).toBe(true);
    expect(Array.isArray(out.recentCaptures)).toBe(true);
  });

  it('collapses multi-tick to latest-per-city-date; counts city-days not ticks', async () => {
    const out = await dash(db);
    expect(Number(out.matchedDays)).toBe(5); // nyc(collapsed), la, chi, mia, den
    expect(Number(out.realDepthDays)).toBe(4); // den excluded (thin)
    expect(Number(out.netPositiveDepthDays)).toBe(1); // only nyc (latest 0.06)
    expect(Number(out.executableWinDays)).toBe(1); // nyc's win fills at depth (ROW default isExecutable)
    expect(Number(out.winFrac)).toBeCloseTo(0.25, 4); // 1 of 4 real-depth days
  });

  it('the capacity wall: a net-positive but NON-executable row is quoted, NOT a win (0064)', async () => {
    const fresh = await freshDb();
    try {
      await record(fresh, [
        ROW({ city: 'nyc', bestNetEdge: 0.30, netPositive: true, isExecutable: true, execSize: 60 }), // real win
        ROW({ city: 'mia', bestNetEdge: 0.25, netPositive: true, isExecutable: false, execSize: 6 }), // quoted only — thin
        ROW({ city: 'la', bestNetEdge: 0.18, netPositive: true, isExecutable: false, execSize: 8 }),  // quoted only — thin
        ROW({ city: 'chi', bestNetEdge: -0.01, netPositive: false, isExecutable: false }),            // efficient
      ]);
      const out = await asRole(fresh, 'authenticated', OPERATOR, async () =>
        (await rows<{ out: Record<string, unknown> }>(fresh, `select public.dash_cross_venue(14) as out`, []))[0]!.out,
      );
      expect(Number(out.realDepthDays)).toBe(4);
      expect(Number(out.netPositiveDepthDays)).toBe(3); // quoted net-positive (nyc, mia, la)
      expect(Number(out.executableWinDays)).toBe(1); // only nyc fills at real touch depth
      expect(Number(out.winFrac)).toBeCloseTo(0.25, 4); // 1 executable win / 4 real-depth — NOT 0.75
      expect(Number(out.maxExecSize)).toBe(60);
    } finally {
      await fresh.close();
    }
  });

  it('headline bestEdgeSeen is scoped to real-depth (0063) — the thin den 0.40 does NOT surface', async () => {
    const out = await dash(db);
    expect(Number(out.bestEdgeSeen)).toBeCloseTo(0.06, 4); // nyc's latest, not den's thin 0.40
  });

  it('operator_guard refuses a non-operator caller', async () => {
    await expect(
      asRole(db, 'authenticated', INTRUDER, () => rows(db, `select public.dash_cross_venue(14) as out`, [])),
    ).rejects.toThrow();
  });

  it('empty feed → zeros, no throw', async () => {
    const fresh = await freshDb();
    try {
      const out = await asRole(fresh, 'authenticated', OPERATOR, async () => {
        const r = await rows<{ out: Record<string, unknown> }>(fresh, `select public.dash_cross_venue(14) as out`, []);
        return r[0]!.out;
      });
      expect(Number(out.matchedDays)).toBe(0);
      expect(Number(out.realDepthDays)).toBe(0);
    } finally {
      await fresh.close();
    }
  });
});
