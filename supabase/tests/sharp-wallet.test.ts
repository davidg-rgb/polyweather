/**
 * sharp-wallet-track + dash_amsterdam_sim.sharps (migration 0049, WALLET-RECON-HANDOFF.md Build #1).
 *
 * End-to-end against PGlite (the real SQL functions): the Edge handler ingesting a stubbed Polymarket
 * leaderboard + positions through the record RPCs (condition_id → event_id/bucket_idx resolution,
 * idempotency, the citySlug filter), and the dash `sharps` block (3-way disagreement + graceful empty state).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { sharpWalletTrack } from '../functions/sharp-wallet-track/handler.ts';
import { SHARP_WALLET_ADDRESS } from '../functions/_shared/polymarket-wallet.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const cfg = parseConfigRows([]);

const LADDER = [
  { idx: 0, label: '14°C or below', low: null as number | null, high: 14 as number | null },
  { idx: 1, label: '15°C', low: 15, high: 15 },
  { idx: 2, label: '16°C', low: 16, high: 16 },
  { idx: 3, label: '17°C', low: 17, high: 17 },
  { idx: 4, label: '18°C', low: 18, high: 18 },
  { idx: 5, label: '19°C', low: 19, high: 19 },
  { idx: 6, label: '20°C', low: 20, high: 20 },
  { idx: 7, label: '21°C', low: 21, high: 21 },
  { idx: 8, label: '22°C', low: 22, high: 22 },
  { idx: 9, label: '23°C', low: 23, high: 23 },
  { idx: 10, label: '24°C or higher', low: 24, high: null },
];

async function seedAmsterdamEvent(db: PGlite, targetDate: string): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ('amsterdam','Amsterdam','NL','C','Etc/GMT-2','europe-west',now(),now())
     on conflict (slug) do nothing`,
  );
  const cid = (await rows<{ id: string }>(db, `select id from cities where slug='amsterdam'`))[0]!.id;
  const ev = (
    await db.query<{ id: string }>(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok)
       values ($1, $2, $3, $4, 'C', 'highest', true) returning id`,
      [`poly-ams-${targetDate}`, `highest-temperature-in-amsterdam-on-${targetDate}`, cid, targetDate],
    )
  ).rows[0]!.id;
  for (const b of LADDER) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ev, b.idx, b.label, b.low, b.high, `cond-${b.idx}`, `y-${b.idx}`, `n-${b.idx}`],
    );
  }
  return ev;
}

describe('sharp-wallet-track — ingest a stubbed leaderboard + positions through the record RPCs', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  const NOW = new Date('2026-06-22T16:00:00Z');
  const ctx = (): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: NOW });

  // Stub Polymarket: leaderboard (2 entries — the sharp + a rival) and the sharp's positions
  // (2 Amsterdam legs whose conditionIds match the seeded ladder, 1 Paris leg, 1 non-temperature leg).
  const RIVAL = '0x1111111111111111111111111111111111111111';
  const stub = async (url: string): Promise<unknown> => {
    if (url.includes('/v1/leaderboard')) {
      return [
        { rank: '1', proxyWallet: SHARP_WALLET_ADDRESS, userName: 'badatmath.', pnl: 22927.5, vol: 1196849.5 },
        { rank: '2', proxyWallet: RIVAL, userName: 'rival', pnl: 100, vol: 200 },
      ];
    }
    if (url.includes('/positions')) {
      const isSharp = url.includes(SHARP_WALLET_ADDRESS);
      if (!isSharp) return []; // rival holds nothing
      return [
        {
          proxyWallet: SHARP_WALLET_ADDRESS, conditionId: 'cond-1', asset: 'a1', outcome: 'Yes',
          size: 500, avgPrice: 0.15, curPrice: 0.2, currentValue: 100, cashPnl: 25, realizedPnl: 0,
          redeemable: false, title: 'Will the highest temperature in Amsterdam be 15°C on June 22?',
          slug: 'highest-temperature-in-amsterdam-on-june-22-2026-15c',
          eventSlug: 'highest-temperature-in-amsterdam-on-june-22-2026', endDate: '2026-06-22',
        },
        {
          proxyWallet: SHARP_WALLET_ADDRESS, conditionId: 'cond-5', asset: 'a5', outcome: 'No',
          size: 100, avgPrice: 0.6, curPrice: 0.55, currentValue: 55, cashPnl: -5, realizedPnl: 0,
          redeemable: false, title: 'Will the highest temperature in Amsterdam be 19°C on June 22?',
          slug: 'highest-temperature-in-amsterdam-on-june-22-2026-19c',
          eventSlug: 'highest-temperature-in-amsterdam-on-june-22-2026', endDate: '2026-06-22',
        },
        {
          proxyWallet: SHARP_WALLET_ADDRESS, conditionId: 'paris-cond', asset: 'ap', outcome: 'Yes',
          size: 40, avgPrice: 0.05, curPrice: 0.08, currentValue: 3.2, cashPnl: 1.2, realizedPnl: 0,
          redeemable: false, title: 'Will the highest temperature in Paris be 30°C on June 22?',
          slug: 'highest-temperature-in-paris-on-june-22-2026-30c',
          eventSlug: 'highest-temperature-in-paris-on-june-22-2026', endDate: '2026-06-22',
        },
        {
          proxyWallet: SHARP_WALLET_ADDRESS, conditionId: 'sports-cond', asset: 'as', outcome: 'No',
          size: 10, avgPrice: 0.5, curPrice: 0.5, currentValue: 5, cashPnl: 0, realizedPnl: 0,
          redeemable: false, title: 'Will Team X win?', slug: 'will-team-x-win', eventSlug: 'will-team-x-win',
          endDate: '2026-06-22',
        },
      ];
    }
    return [];
  };

  beforeAll(async () => {
    db = await freshDb();
    port = pglitePort(db);
    await seedAmsterdamEvent(db, '2026-06-22');
  });

  afterAll(async () => {
    await db?.close();
  });

  it('records the leaderboard, registers wallets, snapshots temperature positions, resolves bucket_idx', async () => {
    const stats = await sharpWalletTrack(ctx(), { now: NOW, fetchJson: stub, topN: 5 });
    expect(stats).toMatchObject({
      asOf: '2026-06-22',
      leaderboardEntries: 2,
      leaderboardRecorded: 2,
      walletsIngested: 2, // the seeded sharp + the rival (deduped; sharp appears in the board too)
      positionsRecorded: 3, // 2 Amsterdam legs + 1 Paris leg (the non-temperature leg is dropped)
    });

    // leaderboard snapshot persisted
    const lb = await rows<{ rank: number; address: string; pnl_usd: string }>(
      db,
      `select rank, address, pnl_usd from wallet_leaderboard_snapshots order by rank`,
    );
    expect(lb.map((r) => r.rank)).toEqual([1, 2]);
    expect(lb[0]!.address).toBe(SHARP_WALLET_ADDRESS);

    // both wallets registered; the rival came from the board
    const tw = await rows<{ address: string; source: string }>(
      db,
      `select address, source from tracked_wallets order by source`,
    );
    expect(tw.find((w) => w.address === RIVAL)?.source).toBe('leaderboard');
    expect(tw.find((w) => w.address === SHARP_WALLET_ADDRESS)?.source).toBe('manual'); // seeded by 0049

    // the two Amsterdam legs resolved to the right ladder buckets + event; the Paris leg stored with no bucket
    const pos = await rows<{ city_slug: string; bucket_idx: number | null; outcome: string; event_id: string | null }>(
      db,
      `select city_slug, bucket_idx, outcome, event_id from wallet_positions_daily
       where address = $1 order by city_slug, bucket_idx nulls last`,
      [SHARP_WALLET_ADDRESS],
    );
    expect(pos.length).toBe(3);
    const ams = pos.filter((p) => p.city_slug === 'amsterdam');
    expect(ams.map((p) => p.bucket_idx).sort()).toEqual([1, 5]);
    expect(ams.every((p) => p.event_id !== null)).toBe(true);
    const paris = pos.find((p) => p.city_slug === 'paris')!;
    expect(paris.bucket_idx).toBeNull(); // we have no Paris market → unresolved
    expect(paris.event_id).toBeNull();
  });

  it('is idempotent — a second tick upserts the same rows (no duplication)', async () => {
    await sharpWalletTrack(ctx(), { now: NOW, fetchJson: stub, topN: 5 });
    const cnt = await rows<{ n: string }>(
      db,
      `select count(*) n from wallet_positions_daily where address = $1 and as_of_date = '2026-06-22'`,
      [SHARP_WALLET_ADDRESS],
    );
    expect(Number(cnt[0]!.n)).toBe(3);
    const lbCnt = await rows<{ n: string }>(db, `select count(*) n from wallet_leaderboard_snapshots`);
    expect(Number(lbCnt[0]!.n)).toBe(2); // same captured_at → on-conflict-do-nothing
  });

  it('no fetchJson → a clean no-op tick', async () => {
    const stats = await sharpWalletTrack(ctx(), { now: NOW });
    expect(stats).toMatchObject({ leaderboardEntries: 0, walletsIngested: 0, positionsRecorded: 0 });
  });
});

describe('dash_amsterdam_sim — the sharps disagreement block (0049)', () => {
  let db: PGlite;
  let focusDate: string;
  let today: string;
  let eventId: string;

  beforeAll(async () => {
    db = await freshDb();
    const d = await rows<{ tmrw: string; today: string }>(
      db,
      `select ((now() at time zone 'Etc/GMT-2')::date + 1)::text tmrw, ((now() at time zone 'Etc/GMT-2')::date)::text today`,
    );
    focusDate = d[0]!.tmrw;
    today = d[0]!.today;
    eventId = await seedAmsterdamEvent(db, focusDate);

    // The sharp's revealed bets (written directly): biggest-conviction YES on bucket 1 (their call), plus
    // NO legs above. as_of = today so it is the latest pull.
    const ins = async (cond: string, idx: number, outcome: string, size: number, avg: number) => {
      await db.query(
        `select public.sharp_wallet_record_positions($1,$2,$3::date,$4::jsonb)`,
        [
          SHARP_WALLET_ADDRESS, 'badatmath.', today,
          JSON.stringify([
            { conditionId: cond, citySlug: 'amsterdam', targetDate: focusDate, outcome,
              sizeShares: size, avgPrice: avg, curPrice: avg, curValueUsd: size * avg, cashPnlUsd: 0,
              realizedPnlUsd: 0, redeemable: false, title: `ams ${idx}` },
          ]),
        ],
      );
    };
    await ins('cond-1', 1, 'Yes', 500, 0.18); // their max-size YES → sharpBucketIdx = 1
    await ins('cond-0', 0, 'Yes', 120, 0.12);
    await ins('cond-5', 5, 'No', 80, 0.7);

    // Our forecast: house_ensemble probs argmax at bucket 3.
    await db.query(
      `insert into bucket_probabilities (event_id, source, made_at, inputs_hash, probs)
       values ($1, 'house_ensemble', now(), 'hash-1',
               array[0.02,0.05,0.10,0.50,0.15,0.08,0.04,0.03,0.02,0.01,0.00]::numeric[])`,
      [eventId],
    );

    // The market's modal bucket: highest mid on bucket 5.
    for (const b of LADDER) {
      const bucketId = (
        await rows<{ id: string }>(db, `select id from market_buckets where event_id=$1 and bucket_idx=$2`, [eventId, b.idx])
      )[0]!.id;
      const mid = b.idx === 5 ? 0.6 : 0.05;
      await db.query(
        `insert into market_snapshots (bucket_id, best_bid, best_ask, mid, captured_at)
         values ($1, $2, $3, $4, now())`,
        [bucketId, mid - 0.02, mid + 0.02, mid],
      );
    }
  });

  afterAll(async () => {
    await db?.close();
  });

  const readDash = (database: PGlite) =>
    asRole(database, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_amsterdam_sim: Record<string, unknown> }>(
        database,
        `select public.dash_amsterdam_sim() as dash_amsterdam_sim`,
      );
      return r[0]!.dash_amsterdam_sim;
    });

  it('surfaces the 3-way disagreement (sharp 15°C vs ours 17°C vs market 19°C)', async () => {
    const out = await readDash(db);
    const s = out.sharps as Record<string, unknown>;
    expect(s.hasSharp).toBe(true);
    expect(s.address).toBe(SHARP_WALLET_ADDRESS);
    expect(s.label).toBe('badatmath.');
    expect(s.targetDate).toBe(focusDate);
    expect(Number(s.sharpBucketIdx)).toBe(1);
    expect(s.sharpLabel).toBe('15°C');
    expect(Number(s.ourBucketIdx)).toBe(3);
    expect(s.ourLabel).toBe('17°C');
    expect(Number(s.marketBucketIdx)).toBe(5);
    expect(s.marketLabel).toBe('19°C');
    expect(Number(s.disagreement)).toBe(3); // three distinct calls
    expect(Number(s.signedDeltaIdx)).toBe(-2); // sharp(1) − ours(3)
    const positions = s.positions as unknown[];
    expect(positions.length).toBe(3);
  });

  it('includes the latest leaderboard standing once the board is snapshotted', async () => {
    await db.query(
      `select public.sharp_wallet_record_leaderboard(now(), 'MONTH', $1::jsonb)`,
      [JSON.stringify([{ rank: 1, address: SHARP_WALLET_ADDRESS, label: 'badatmath.', pnlUsd: 22927, volumeUsd: 1196849 }])],
    );
    const out = await readDash(db);
    const s = out.sharps as Record<string, unknown>;
    expect(Number(s.rank)).toBe(1);
    expect(Number(s.pnlUsd)).toBeCloseTo(22927, 0);
  });
});

describe('dash_amsterdam_sim — sharps empty state (no tracker rows)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('hasSharp=false with empty positions until the tracker has written a row', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_amsterdam_sim: Record<string, unknown> }>(
        db,
        `select public.dash_amsterdam_sim() as dash_amsterdam_sim`,
      );
      return r[0]!.dash_amsterdam_sim;
    });
    const s = out.sharps as Record<string, unknown>;
    expect(s.hasSharp).toBe(false);
    expect(s.address).toBe(SHARP_WALLET_ADDRESS);
    expect(s.label).toBe('badatmath.'); // the seeded tracked_wallets label still resolves
    expect(s.positions).toEqual([]);
    expect(s.sharpBucketIdx).toBeNull();
    expect(Number(s.disagreement)).toBe(0);
  });
});
