import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, hasUniqueIndex, rows } from './harness.ts';

// Migration 0050 — wallet_pnl_daily + wallet_bet_calibration + wallet_forensics_record (Build #2 persist).
// The PGlite twin: the real migration chain (incl. 0049 tracked_wallets and 0050) applies, the record RPC
// is idempotent, and the natural keys / RLS / grants mirror the 0043/0049 idiom.

const WALLET = '0xtestwallet0000000000000000000000000000aa';

const DAILY = [
  { date: '2026-05-09', realizedUsd: 100, cumUsd: 100 },
  { date: '2026-05-10', realizedUsd: -40, cumUsd: 60 },
  { date: '2026-05-16', realizedUsd: 559, cumUsd: 619 },
];

const BETS = [
  {
    conditionId: 'c-cheap',
    outcome: 'Yes',
    entryPrice: 0.1,
    won: true,
    realizedUsd: 90,
    stakedUsd: 10,
    citySlug: 'kuala-lumpur',
    targetDate: '2026-05-16',
    region: 'INTL',
  },
  {
    conditionId: 'c-mid',
    outcome: 'No',
    entryPrice: 0.6,
    won: false,
    realizedUsd: -10,
    stakedUsd: 10,
    citySlug: 'houston',
    targetDate: '2026-05-16',
    region: 'US',
  },
];

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
});

afterAll(async () => {
  await db.close();
});

describe('0050 wallet_forensics_persist — schema', () => {
  it('both tables exist with their natural keys', async () => {
    const tbls = await rows<{ t: string }>(
      db,
      `select table_name t from information_schema.tables
       where table_schema = 'public' and table_name in ('wallet_pnl_daily','wallet_bet_calibration')
       order by table_name`,
    );
    expect(tbls.map((r) => r.t)).toEqual(['wallet_bet_calibration', 'wallet_pnl_daily']);

    // wallet_pnl_daily PK is (address, day)
    expect(await hasUniqueIndex(db, 'wallet_pnl_daily', ['address', 'day'])).toBe(true);
    // wallet_bet_calibration natural key is (address, condition_id, outcome)
    expect(await hasUniqueIndex(db, 'wallet_bet_calibration', ['address', 'condition_id', 'outcome'])).toBe(true);
  });

  it('wallet_pnl_daily.address FKs tracked_wallets (0049)', async () => {
    const fk = await rows<{ n: number }>(
      db,
      `select count(*)::int n from information_schema.table_constraints tc
       join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
       where tc.table_name = 'wallet_pnl_daily' and tc.constraint_type = 'FOREIGN KEY'
         and ccu.table_name = 'tracked_wallets'`,
    );
    expect(fk[0]!.n).toBeGreaterThanOrEqual(1);
  });
});

describe('0050 wallet_forensics_record — idempotent persist', () => {
  it('records the daily curve + per-bet calibration, auto-registering the wallet', async () => {
    const res = await rows<{ daily: number; cal: number }>(
      db,
      `select * from public.wallet_forensics_record($1, $2::jsonb, $3::jsonb)`,
      [WALLET, JSON.stringify(DAILY), JSON.stringify(BETS)],
    );
    expect(Number(res[0]!.daily)).toBe(3);
    expect(Number(res[0]!.cal)).toBe(2);

    // the wallet was auto-registered in tracked_wallets
    const tw = await rows<{ address: string }>(db, `select address from tracked_wallets where address = $1`, [WALLET]);
    expect(tw).toHaveLength(1);

    const daily = await rows<{ day: string; cum_usd: string }>(
      db,
      `select day::text, cum_usd from wallet_pnl_daily where address = $1 order by day`,
      [WALLET],
    );
    expect(daily).toHaveLength(3);
    expect(Number(daily[2]!.cum_usd)).toBeCloseTo(619, 4);

    const cal = await rows<{ condition_id: string; won: boolean; region: string }>(
      db,
      `select condition_id, won, region from wallet_bet_calibration where address = $1 order by condition_id`,
      [WALLET],
    );
    expect(cal).toHaveLength(2);
    expect(cal.find((r) => r.condition_id === 'c-cheap')!.won).toBe(true);
    expect(cal.find((r) => r.condition_id === 'c-mid')!.region).toBe('US');
  });

  it('a re-run upserts in place (no duplicate rows; revised values overwrite)', async () => {
    const revisedDaily = [...DAILY, { date: '2026-05-17', realizedUsd: 1000, cumUsd: 1619 }];
    const revisedBets = [{ ...BETS[0]!, realizedUsd: 95 }, BETS[1]!];
    await rows(db, `select * from public.wallet_forensics_record($1, $2::jsonb, $3::jsonb)`, [
      WALLET,
      JSON.stringify(revisedDaily),
      JSON.stringify(revisedBets),
    ]);

    const nDaily = await rows<{ n: number }>(db, `select count(*)::int n from wallet_pnl_daily where address = $1`, [WALLET]);
    expect(nDaily[0]!.n).toBe(4); // 3 upserted + 1 new, no dupes

    const nCal = await rows<{ n: number }>(db, `select count(*)::int n from wallet_bet_calibration where address = $1`, [WALLET]);
    expect(nCal[0]!.n).toBe(2); // still 2 — upsert by (address,condition_id,outcome)

    const cheap = await rows<{ realized_usd: string }>(
      db,
      `select realized_usd from wallet_bet_calibration where address = $1 and condition_id = 'c-cheap'`,
      [WALLET],
    );
    expect(Number(cheap[0]!.realized_usd)).toBeCloseTo(95, 4); // revised value overwrote
  });

  it('null/empty jsonb arrays are a no-op (total)', async () => {
    const res = await rows<{ daily: number; cal: number }>(
      db,
      `select * from public.wallet_forensics_record($1, '[]'::jsonb, '[]'::jsonb)`,
      [WALLET],
    );
    expect(Number(res[0]!.daily)).toBe(0);
    expect(Number(res[0]!.cal)).toBe(0);
  });
});
