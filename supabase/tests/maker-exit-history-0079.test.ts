/**
 * Migration 0079 (dash_maker_exit_history) — the PGlite twin against the real migration chain.
 *
 * Pins the /maker-exit "assumptions over time" read: dash_maker_exit_history(p_limit) is operator-guarded, returns
 * the last p_limit maker_exit_panel snapshots' assumption scalars ASCENDING (oldest→newest), passes NaN→null
 * assumption values through as null POINTS (no fabricated zeros — the sparkline null-break contract), and clamps
 * p_limit. Additive-only: the 0073 dash_maker_exit latest-only read is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

interface HistoryPoint {
  capturedAt: string;
  makerFillRate: number | null;
  realizedRebateUsd: number | null;
  qualifyingTickFrac: number | null;
  meanDistFromMidPp: number | null;
  fracWithinAdvertisedBand: number | null;
  fracFailsMinSize: number | null;
  dominantDisqualifier: string | null;
  nDistinctDays: number | null;
  nMarkets: number | null;
}
interface History { generatedAt: string; n: number; points: HistoryPoint[] }

/** Insert a maker_exit_panel snapshot directly (bypassing the 15-min tick) at an explicit age, with an assumptions blob. */
async function seedSnapshot(db: PGlite, minutesAgo: number, assumptions: Record<string, unknown>): Promise<void> {
  const view = JSON.stringify({ days: 21, entries: [], gate: { label: 'INSUFFICIENT_DATA' }, assumptions });
  await db.query(
    `insert into public.maker_exit_panel (captured_at, view)
     values (now() - ($1 || ' minutes')::interval, $2::jsonb)`,
    [String(minutesAgo), view],
  );
}

const readHistory = (db: PGlite, limit?: number): Promise<History> =>
  asRole(db, 'authenticated', OPERATOR, async () =>
    (
      await rows<{ out: History }>(
        db,
        limit == null
          ? `select public.dash_maker_exit_history() as out`
          : `select public.dash_maker_exit_history($1) as out`,
        limit == null ? undefined : [limit],
      )
    )[0]!.out,
  );

describe('0079 dash_maker_exit_history — trend read of the three measured assumptions', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    // three snapshots, 30 / 15 / 0 min ago. The oldest carries an all-NaN (→ JSON null) assumptions blob — the
    // no-realized-trade state the sparkline must draw as a GAP, not a zero.
    await seedSnapshot(db, 30, {
      makerFillRate: null, realizedRebateUsd: null, qualifyingTickFrac: null,
      meanDistFromMidPp: null, fracWithinAdvertisedBand: null, fracFailsMinSize: null,
      dominantDisqualifier: 'none', nDistinctDays: 2, nMarkets: 8,
    });
    await seedSnapshot(db, 15, {
      makerFillRate: 0.42, realizedRebateUsd: 1.1, qualifyingTickFrac: 0,
      meanDistFromMidPp: 12.3, fracWithinAdvertisedBand: 0.2, fracFailsMinSize: 0.1,
      dominantDisqualifier: 'band', nDistinctDays: 4, nMarkets: 22,
    });
    await seedSnapshot(db, 0, {
      makerFillRate: 0.49, realizedRebateUsd: 2.4, qualifyingTickFrac: 0.05,
      meanDistFromMidPp: 9.8, fracWithinAdvertisedBand: 0.31, fracFailsMinSize: 0.08,
      dominantDisqualifier: 'none', nDistinctDays: 7, nMarkets: 44,
    });
  });
  afterAll(async () => { await db?.close(); });

  it('is operator-guarded — forbidden without the operator role', async () => {
    await expect(rows(db, `select public.dash_maker_exit_history() as out`)).rejects.toThrow();
  });

  it('returns every snapshot ASCENDING (oldest→newest) with n', async () => {
    const h = await readHistory(db);
    expect(h.n).toBe(3);
    expect(h.points).toHaveLength(3);
    const ts = h.points.map((p) => Date.parse(p.capturedAt));
    expect(ts).toEqual([...ts].sort((a, b) => a - b)); // strictly ascending
    // newest point carries the latest assumption reads.
    const last = h.points[2]!;
    expect(Number(last.makerFillRate)).toBeCloseTo(0.49, 6);
    expect(Number(last.nDistinctDays)).toBe(7);
    expect(Number(last.nMarkets)).toBe(44);
  });

  it('passes NaN→null assumptions through as NULL points (no fabricated zeros)', async () => {
    const h = await readHistory(db);
    const oldest = h.points[0]!;
    // the all-NaN snapshot: makerFillRate/rebate/qualifyingTickFrac must be null, NOT 0.
    expect(oldest.makerFillRate).toBeNull();
    expect(oldest.realizedRebateUsd).toBeNull();
    expect(oldest.qualifyingTickFrac).toBeNull();
    expect(oldest.fracWithinAdvertisedBand).toBeNull();
    // a REAL zero (middle snapshot's qualifyingTickFrac) stays 0 — distinct from the null above.
    expect(Number(h.points[1]!.qualifyingTickFrac)).toBe(0);
    // categorical passthrough survives.
    expect(oldest.dominantDisqualifier).toBe('none');
    expect(h.points[1]!.dominantDisqualifier).toBe('band');
  });

  it('respects p_limit — the newest k snapshots, still ascending', async () => {
    const h = await readHistory(db, 2);
    expect(h.n).toBe(2);
    expect(h.points).toHaveLength(2);
    // the two NEWEST (15 + 0 min), ascending → makerFillRate 0.42 then 0.49.
    expect(Number(h.points[0]!.makerFillRate)).toBeCloseTo(0.42, 6);
    expect(Number(h.points[1]!.makerFillRate)).toBeCloseTo(0.49, 6);
  });

  it('clamps p_limit to ≥1 (a 0 / negative request still returns the newest one)', async () => {
    const h = await readHistory(db, 0);
    expect(h.n).toBe(1);
    expect(Number(h.points[0]!.makerFillRate)).toBeCloseTo(0.49, 6); // the single newest
  });

  it('empty panel → n 0 + empty points (never throws for the operator)', async () => {
    const empty = await freshDb();
    try {
      const h = await asRole(empty, 'authenticated', OPERATOR, async () =>
        (await rows<{ out: History }>(empty, `select public.dash_maker_exit_history() as out`))[0]!.out,
      );
      expect(h.n).toBe(0);
      expect(h.points).toEqual([]);
    } finally {
      await empty.close();
    }
  });
});
