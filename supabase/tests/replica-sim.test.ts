/**
 * replica paper-trial persistence (0053) — replica_record_positions / replica_record_run (service-role
 * writes) + dash_replica_sim (operator read). Verifies the jsonb→row mapping, the replace + natural-key
 * upsert paths, the read shape, and the operator gate. The three-curve roll-up is the loader's job (scored
 * via the core engine) and is covered in apps/web/test/replica-loader.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

let db: PGlite;
const OPERATOR = { email: 'david.geborek@gmail.com' };

const UID = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const positionRow = (over: Record<string, unknown>) => ({
  conditionId: 'cond',
  eventId: UID(1),
  citySlug: 'chicago',
  region: 'us',
  targetDate: '2026-05-01',
  bucketIdx: 3,
  bucketLabel: '70–71°F',
  resolutionTs: 1_700_000_000,
  entryTs: 1_699_870_000,
  entryDayUtc: '2026-04-29',
  entryCapturedTs: 1_699_870_500,
  makerPrice: 0.2,
  takerPrice: 0.25,
  stakeUsd: 12,
  feeRate: 0,
  bucketWon: true,
  makerRealisticFilled: true,
  status: 'resolved',
  placedAtUtc: null,
  closedAtUtc: null,
  ...over,
});

const STRAT = {
  cheapBandLo: 0.1, cheapBandHi: 0.25, entryLeadHours: 36, breadthPerCityDay: 3,
  positionStakeUsd: 12, dailyBankrollCapUsd: 250, tickSize: 0.01, feeRate: 0.05,
};

const recordPositions = (source: string, replace: boolean, list: unknown[]): Promise<unknown[]> =>
  rows(db, `select public.replica_record_positions($1, $2, $3::jsonb) as n`, [source, replace, JSON.stringify(list)]);

const recordRun = (payload: unknown): Promise<unknown[]> =>
  rows(db, `select public.replica_record_run($1::jsonb) as id`, [JSON.stringify(payload)]);

const readSim = (): Promise<Record<string, unknown>> =>
  asRole(db, 'authenticated', OPERATOR, async () => {
    const r = await rows<{ dash_replica_sim: Record<string, unknown> }>(db, `select public.dash_replica_sim() as dash_replica_sim`);
    return r[0]!.dash_replica_sim;
  });

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db?.close();
});

describe('replica_record_positions / _run + dash_replica_sim (0053)', () => {
  it('records positions for both sources + a run row per mode, and reads them back', async () => {
    await recordPositions('backtest', true, [
      positionRow({ eventId: UID(1), citySlug: 'chicago', bucketWon: true, makerRealisticFilled: false }),
      positionRow({ eventId: UID(2), citySlug: 'denver', targetDate: '2026-05-02', makerPrice: 0.1, takerPrice: 0.15, bucketWon: false, makerRealisticFilled: true }),
    ]);
    await recordPositions('forward', true, [
      positionRow({ source: 'forward', eventId: UID(3), citySlug: 'beijing', targetDate: '2026-06-22', bucketWon: true, status: 'resolved', placedAtUtc: '2026-06-20T07:00:00Z', closedAtUtc: '2026-06-23T07:00:00Z' }),
      positionRow({ source: 'forward', eventId: UID(4), citySlug: 'busan', targetDate: '2026-06-24', bucketWon: null, makerRealisticFilled: false, status: 'open', placedAtUtc: '2026-06-23T07:00:00Z' }),
    ]);
    await recordRun({ mode: 'backtest', seedFrom: '2026-04-21', seedTo: '2026-06-21', whitelist: [], strat: STRAT, nCandidates: 5000, nBand: 900, nSelected: 300, nAllocated: 180, nClosed: 180 });
    await recordRun({ mode: 'forward', whitelist: ['chicago', 'beijing', 'busan'], strat: STRAT, nOpen: 1, nClosed: 1, nOpened: 1, nReconciled: 0 });

    const out = await readSim();
    const positions = out.positions as Record<string, unknown>[];
    expect(positions.length).toBe(4);
    // jsonb→row→jsonb round-trip preserves the typed fields the loader coerces.
    const open = positions.find((p) => p.status === 'open')!;
    expect(open.citySlug).toBe('busan');
    expect(open.bucketWon).toBeNull();
    expect(Number(open.stakeUsd)).toBe(12);
    expect(Number(open.entryCapturedTs)).toBe(1_699_870_500); // 0056: the fill-window start round-trips through dash_replica_sim

    const runs = out.runs as { backtest: Record<string, unknown>; forward: Record<string, unknown> };
    expect(Number(runs.backtest.nAllocated)).toBe(180);
    expect(Number(runs.backtest.nCandidates)).toBe(5000);
    expect(runs.forward.whitelist).toEqual(['chicago', 'beijing', 'busan']);
    expect((runs.forward.strat as Record<string, unknown>).positionStakeUsd).toBe(12);

    expect((out.recentRuns as unknown[]).length).toBe(2);
  });

  it('replace=true reseeds a source without touching the other', async () => {
    // Reseed backtest with a single row; forward (4-row set above → 2 forward rows) must be untouched.
    await recordPositions('backtest', true, [positionRow({ eventId: UID(9), citySlug: 'amsterdam' })]);
    const out = await readSim();
    const positions = out.positions as Record<string, unknown>[];
    expect(positions.filter((p) => p.source === 'backtest').length).toBe(1);
    expect(positions.filter((p) => p.source === 'forward').length).toBe(2); // unchanged
  });

  it('replace=false upserts by (source, event_id, bucket_idx) — open→resolved updates in place', async () => {
    await recordPositions('forward', true, [
      positionRow({ source: 'forward', eventId: UID(20), citySlug: 'denver', bucketIdx: 5, bucketWon: null, status: 'open' }),
    ]);
    // same natural key, now resolved → must UPDATE the existing row, not insert a duplicate.
    await recordPositions('forward', false, [
      positionRow({ source: 'forward', eventId: UID(20), citySlug: 'denver', bucketIdx: 5, bucketWon: true, status: 'resolved', closedAtUtc: '2026-06-25T07:00:00Z' }),
    ]);
    const cnt = await rows<{ n: string }>(db, `select count(*) n from public.replica_positions where source='forward' and event_id=$1 and bucket_idx=5`, [UID(20)]);
    expect(Number(cnt[0]!.n)).toBe(1);
    const row = await rows<{ status: string; bucket_won: boolean }>(db, `select status, bucket_won from public.replica_positions where source='forward' and event_id=$1 and bucket_idx=5`, [UID(20)]);
    expect(row[0]!.status).toBe('resolved');
    expect(row[0]!.bucket_won).toBe(true);
  });

  it('refuses to downgrade a resolved position back to open (resolution is final — the 0056 close-then-reopen guard)', async () => {
    await recordPositions('forward', true, [
      positionRow({ source: 'forward', eventId: UID(30), citySlug: 'osaka', bucketIdx: 7, bucketWon: true, status: 'resolved', closedAtUtc: '2026-06-25T07:00:00Z' }),
    ]);
    // a stale/duplicate placement of the SAME natural key as 'open' must NOT revert the resolved row.
    await recordPositions('forward', false, [
      positionRow({ source: 'forward', eventId: UID(30), citySlug: 'osaka', bucketIdx: 7, bucketWon: null, makerRealisticFilled: false, status: 'open', closedAtUtc: null }),
    ]);
    const row = await rows<{ status: string; bucket_won: boolean }>(db, `select status, bucket_won from public.replica_positions where source='forward' and event_id=$1 and bucket_idx=7`, [UID(30)]);
    expect(row[0]!.status).toBe('resolved'); // unchanged — the ON CONFLICT WHERE status <> 'resolved' blocked the downgrade
    expect(row[0]!.bucket_won).toBe(true);
  });

  it('dash_replica_sim is operator-gated (ERR_FORBIDDEN for a non-operator)', async () => {
    await expect(
      asRole(db, 'authenticated', { email: 'intruder@example.com' }, () => rows(db, `select public.dash_replica_sim()`)),
    ).rejects.toThrow(/ERR_FORBIDDEN/);
  });
});
