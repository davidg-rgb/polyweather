/**
 * replica-forward — the badatmath-replica forward loop ported to a Supabase Edge tick (migration 0056).
 *
 * End-to-end against PGlite (the real SQL functions): replica_forward_inputs reconstructs the run/open/
 * resolutions/book/candidates, then the Edge handler RECONCILES resolved open positions (DB winner + a stubbed
 * Polymarket Gamma fallback) and PLACES a live candidate, persisting via the upsert-only write path. Mirrors
 * amsterdam-sim.test.ts. NOT trading — read-only analytics; the live rail stays DORMANT.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { replicaForward } from '../functions/replica-forward/handler.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const cfg = parseConfigRows([]);
const TZ = 'Asia/Kuala_Lumpur'; // UTC+8, no DST → localDayWindow(D).endUtc = D 16:00:00Z
const NOW = new Date('2026-06-22T12:00:00Z');
const ts = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let eventAId: string; // DB-resolved (winning_bucket_idx=3) — open pos bucket 3 wins
let eventCId: string; // unresolved in DB — closed via the Gamma fallback (condC → Yes)
let eventBId: string; // live candidate to PLACE

const ctx = (): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: NOW });

// Gamma stub: /markets returns ONLY the resolved markets whose conditionId appears in the query (condC won 'Yes').
// outcomes/outcomePrices are STRINGIFIED JSON — the real Gamma shape — so parseGammaStrArray's decode runs.
const GAMMA_RESOLVED: Record<string, [string, string]> = { condC: ['1', '0'] };
const stubFetch = (url: string): Promise<unknown> => {
  if (url.includes('/markets')) {
    const markets = Object.entries(GAMMA_RESOLVED)
      .filter(([cid]) => url.includes(cid))
      .map(([cid, prices]) => ({
        conditionId: cid,
        outcomes: '["Yes","No"]',
        outcomePrices: JSON.stringify(prices),
        closed: true,
      }));
    return Promise.resolve(markets);
  }
  return Promise.resolve([]);
};

async function seedCity(): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ('kuala-lumpur', 'Kuala Lumpur', 'MY', 'C', $1, 'southeast-asia', now(), now())`,
    [TZ],
  );
  return (await rows<{ id: string }>(db, `select id from cities where slug = 'kuala-lumpur'`))[0]!.id;
}

async function seedEvent(
  cityId: string,
  targetDate: string,
  winningBucketIdx: number | null,
): Promise<string> {
  const ev = (
    await db.query<{ id: string }>(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok, winning_bucket_idx)
       values ($1, $2, $3, $4, 'C', 'highest', true, $5) returning id`,
      [`poly-kl-${targetDate}`, `highest-temperature-in-kuala-lumpur-on-${targetDate}`, cityId, targetDate, winningBucketIdx],
    )
  ).rows[0]!;
  return ev.id;
}

async function seedBucket(
  eventId: string,
  bucketIdx: number,
  conditionId: string,
  low: number,
  high: number,
): Promise<string> {
  const b = (
    await db.query<{ id: string }>(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no, tick_size, fee_rate)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 0.01, 0.05) returning id`,
      [eventId, bucketIdx, `${low}–${high}°C`, low, high, conditionId, `ty-${conditionId}`, `tn-${conditionId}`],
    )
  ).rows[0]!;
  return b.id;
}

async function seedSnap(bucketId: string, capturedAt: string, bid: number, ask: number): Promise<void> {
  await db.query(
    `insert into market_snapshots (bucket_id, best_bid, best_ask, mid, captured_at)
     values ($1, $2, $3, $4, $5)`,
    [bucketId, bid, ask, (bid + ask) / 2, capturedAt],
  );
}

/** Record the prior forward state (a run + two open positions) the cloud tick resumes from. */
async function seedForwardState(): Promise<void> {
  const STRAT = {
    cheapBandLo: 0.1, cheapBandHi: 0.25, entryLeadHours: 36, breadthPerCityDay: 3,
    positionStakeUsd: 12, dailyBankrollCapUsd: 250, tickSize: 0.01, feeRate: 0.05,
  };
  // ranAt = the prior day's run, so the handler's run (ranAt = NOW) is the latest by ran_at — the order the
  // dashboard + the inputs RPC select on (in prod deps.now ≈ wall clock; here NOW is a fixed past date).
  await db.query(`select public.replica_record_run($1::jsonb)`, [
    JSON.stringify({ mode: 'forward', ranAt: '2026-06-21T07:00:00Z', whitelist: ['kuala-lumpur'], strat: STRAT, nOpen: 2 }),
  ]);

  const openPos = (over: Record<string, unknown>) => ({
    citySlug: 'kuala-lumpur', region: 'southeast-asia', targetDate: '2026-06-20',
    resolutionTs: ts('2026-06-20T16:00:00Z'), entryTs: ts('2026-06-19T04:00:00Z'), entryDayUtc: '2026-06-19',
    entryCapturedTs: ts('2026-06-19T05:00:00Z'), makerPrice: 0.12, takerPrice: 0.18, stakeUsd: 12, feeRate: 0.05,
    bucketWon: null, makerRealisticFilled: false, status: 'open',
    placedAtUtc: '2026-06-19T07:00:00Z', closedAtUtc: null,
    ...over,
  });
  await db.query(`select public.replica_record_positions('forward', true, $1::jsonb)`, [
    JSON.stringify([
      openPos({ conditionId: 'condA3', eventId: eventAId, bucketIdx: 3, bucketLabel: '30–31°C' }),
      openPos({
        conditionId: 'condC', eventId: eventCId, bucketIdx: 2, bucketLabel: '29–30°C',
        targetDate: '2026-06-19', resolutionTs: ts('2026-06-19T16:00:00Z'),
      }),
    ]),
  ]);
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  const cityId = await seedCity();

  // Event A — DB-resolved (winner bucket 3). The open pos on bucket 3 WINS; its book touches the bid → fills.
  eventAId = await seedEvent(cityId, '2026-06-20', 3);
  const a3 = await seedBucket(eventAId, 3, 'condA3', 30, 31);
  await seedSnap(a3, '2026-06-19T04:00:00Z', 0.12, 0.18); // pre-entryCaptured (05:00) → excluded by the fill window
  await seedSnap(a3, '2026-06-19T05:00:00Z', 0.12, 0.18); // entry book — ask 0.18 > 0.12, no fill yet
  await seedSnap(a3, '2026-06-20T10:00:00Z', 0.10, 0.10); // ask 0.10 ≤ 0.12 → ask-touch fill

  // Event C — UNRESOLVED in our DB; closed via the Gamma fallback (condC → Yes). A distinct target_date from
  // event A so the (city_id, target_date, kind) / poly_event_id / slug uniqueness holds.
  eventCId = await seedEvent(cityId, '2026-06-19', null);
  const c2 = await seedBucket(eventCId, 2, 'condC', 29, 30);
  await seedSnap(c2, '2026-06-19T05:00:00Z', 0.12, 0.18);
  await seedSnap(c2, '2026-06-20T09:00:00Z', 0.05, 0.05); // ask 0.05 ≤ 0.12 → fill

  // Event B — a LIVE candidate to place: resolves 2026-06-23 (KL 16:00Z), the 36h entry instant has arrived by
  // NOW (2026-06-22 12:00Z), unresolved, with a cheap-Yes (0.12) bid at the entry book.
  eventBId = await seedEvent(cityId, '2026-06-23', null);
  const b1 = await seedBucket(eventBId, 1, 'condB1', 31, 32);
  await seedSnap(b1, '2026-06-22T05:00:00Z', 0.12, 0.18); // entry book at/after entryTs = 2026-06-22 04:00Z

  await seedForwardState();
});

afterAll(async () => {
  await db?.close();
});

describe('replica_forward_inputs — the RPC-only reconstruction of the script reads', () => {
  it('returns the five-key object: the run, the open positions, their DB resolution, the book, and candidates', async () => {
    const nowSec = Math.floor(NOW.getTime() / 1000);
    const r = await rows<{ replica_forward_inputs: Record<string, unknown> }>(
      db,
      `select public.replica_forward_inputs($1, $2, $3) as replica_forward_inputs`,
      [nowSec, '2026-06-20', '2026-06-26'],
    );
    const inp = r[0]!.replica_forward_inputs;

    const run = inp.run as { whitelist: string[]; strat: Record<string, unknown> };
    expect(run.whitelist).toEqual(['kuala-lumpur']);
    expect(run.strat.entryLeadHours).toBe(36);

    const open = inp.open as { eventId: string; conditionId: string; entryCapturedTs: number }[];
    expect(open.length).toBe(2);
    expect(open.every((p) => Number.isFinite(p.entryCapturedTs))).toBe(true); // the 0056 column round-trips

    // resolutions: only the DB-resolved event A (event C is unresolved → absent, left to the Gamma fallback).
    const resolutions = inp.resolutions as Record<string, number>;
    expect(resolutions[eventAId]).toBe(3);
    expect(resolutions[eventCId]).toBeUndefined();

    // askSeries: the open positions' books, keyed by conditionId.
    const askSeries = inp.askSeries as Record<string, unknown[]>;
    expect(Object.keys(askSeries).sort()).toEqual(['condA3', 'condC']);
    expect(askSeries.condA3!.length).toBe(3);

    // candidates: event B (the live one) is present with its bucket + windowed book.
    const candidates = inp.candidates as { targetDate: string; buckets: { snapshots: unknown[] }[] }[];
    const evB = candidates.find((c) => c.targetDate.startsWith('2026-06-23'));
    expect(evB).toBeDefined();
    expect(evB!.buckets[0]!.snapshots.length).toBeGreaterThan(0);
  });

  it('returns a jsonb OBJECT, never a top-level array (the migration-0044 supabasePort trap)', async () => {
    const nowSec = Math.floor(NOW.getTime() / 1000);
    const r = await rows<{ typ: string; open_is_array: boolean }>(
      db,
      `select jsonb_typeof(public.replica_forward_inputs($1,$2,$3)) as typ,
              jsonb_typeof(public.replica_forward_inputs($1,$2,$3) -> 'open') = 'array' as open_is_array`,
      [nowSec, '2026-06-20', '2026-06-26'],
    );
    expect(r[0]!.typ).toBe('object');
    expect(r[0]!.open_is_array).toBe(true);
  });
});

describe('replica-forward handler — reconcile + place + persist', () => {
  it('reconciles a DB-resolved AND a Gamma-resolved open position, and places the live candidate', async () => {
    const stats = await replicaForward(ctx(), { now: NOW, fetchJson: stubFetch });
    expect(stats).toMatchObject({ openBefore: 2, reconciled: 2, opened: 1, open: 1, gammaResolved: 1 });

    // event A closed on the DB winner — bucket 3 won, the book touched the rested bid → maker-realistic filled.
    const a = await rows<{ status: string; bucket_won: boolean; maker_realistic_filled: boolean; closed_at_utc: string }>(
      db,
      `select status, bucket_won, maker_realistic_filled, closed_at_utc
       from replica_positions where source='forward' and event_id=$1`,
      [eventAId],
    );
    expect(a[0]!.status).toBe('resolved');
    expect(a[0]!.bucket_won).toBe(true);
    expect(a[0]!.maker_realistic_filled).toBe(true);
    expect(a[0]!.closed_at_utc).toBeTruthy();

    // event C closed on the Gamma fallback (Yes → its bucket-2 Yes leg won).
    const c = await rows<{ status: string; bucket_won: boolean }>(
      db,
      `select status, bucket_won from replica_positions where source='forward' and event_id=$1`,
      [eventCId],
    );
    expect(c[0]!.status).toBe('resolved');
    expect(c[0]!.bucket_won).toBe(true);

    // event B opened (the live placement) — locked prices, still pending.
    const b = await rows<{ status: string; bucket_won: boolean | null; maker_price: string; stake_usd: string }>(
      db,
      `select status, bucket_won, maker_price, stake_usd from replica_positions where source='forward' and event_id=$1`,
      [eventBId],
    );
    expect(b.length).toBe(1);
    expect(b[0]!.status).toBe('open');
    expect(b[0]!.bucket_won).toBeNull();
    expect(Number(b[0]!.maker_price)).toBeCloseTo(0.12, 6);
    expect(Number(b[0]!.stake_usd)).toBe(12);

    // the forward source now holds exactly 3 positions: 2 resolved + 1 open.
    const tally = await rows<{ n: string; resolved: string }>(
      db,
      `select count(*) n, count(*) filter (where status='resolved') resolved
       from replica_positions where source='forward'`,
    );
    expect(Number(tally[0]!.n)).toBe(3);
    expect(Number(tally[0]!.resolved)).toBe(2);

    // the run row records the accurate post-run totals (closed = prior 0 + 2; open = 1).
    const run = await rows<{ n_open: number; n_closed: number; n_opened: number; n_reconciled: number }>(
      db,
      `select n_open, n_closed, n_opened, n_reconciled from replica_runs where mode='forward' order by ran_at desc limit 1`,
    );
    expect(run[0]).toMatchObject({ n_open: 1, n_closed: 2, n_opened: 1, n_reconciled: 2 });
  });

  it('is idempotent — a second tick reconciles nothing new and opens nothing (the live candidate is deduped)', async () => {
    const stats = await replicaForward(ctx(), { now: NOW, fetchJson: stubFetch });
    expect(stats).toMatchObject({ reconciled: 0, opened: 0, open: 1 });
    const tally = await rows<{ n: string }>(db, `select count(*) n from replica_positions where source='forward'`);
    expect(Number(tally[0]!.n)).toBe(3); // unchanged
  });

  it('no fetchJson → a clean tick that still closes DB-resolved positions (Gamma simply skipped)', async () => {
    // A fresh DB so this is observed in isolation: one open position whose event our DB has resolved.
    const db2 = await freshDb();
    const port2 = pglitePort(db2);
    await db2.query(
      `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
       values ('kuala-lumpur', 'Kuala Lumpur', 'MY', 'C', $1, 'southeast-asia', now(), now())`,
      [TZ],
    );
    const cid = (await rows<{ id: string }>(db2, `select id from cities where slug='kuala-lumpur'`))[0]!.id;
    const ev = (
      await db2.query<{ id: string }>(
        `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok, winning_bucket_idx)
         values ('p-kl-x','highest-temperature-in-kuala-lumpur-on-2026-06-20',$1,'2026-06-20','C','highest',true,1) returning id`,
        [cid],
      )
    ).rows[0]!.id;
    const bk = (
      await db2.query<{ id: string }>(
        `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no, tick_size, fee_rate)
         values ($1,1,'29–30°C',29,30,'condX','ty','tn',0.01,0.05) returning id`,
        [ev],
      )
    ).rows[0]!.id;
    await db2.query(
      `insert into market_snapshots (bucket_id, best_bid, best_ask, mid, captured_at) values ($1,0.12,0.10,0.11,'2026-06-20T10:00:00Z')`,
      [bk],
    );
    await db2.query(`select public.replica_record_run($1::jsonb)`, [JSON.stringify({ mode: 'forward', whitelist: ['kuala-lumpur'], strat: {} })]);
    await db2.query(`select public.replica_record_positions('forward', true, $1::jsonb)`, [
      JSON.stringify([{
        conditionId: 'condX', eventId: ev, citySlug: 'kuala-lumpur', region: 'southeast-asia', targetDate: '2026-06-20',
        bucketIdx: 1, bucketLabel: '29–30°C', resolutionTs: ts('2026-06-20T16:00:00Z'), entryTs: ts('2026-06-19T04:00:00Z'),
        entryDayUtc: '2026-06-19', entryCapturedTs: ts('2026-06-19T05:00:00Z'), makerPrice: 0.12, takerPrice: 0.18,
        stakeUsd: 12, feeRate: 0.05, bucketWon: null, makerRealisticFilled: false, status: 'open',
        placedAtUtc: '2026-06-19T07:00:00Z', closedAtUtc: null,
      }]),
    ]);

    const stats = await replicaForward({ db: port2, config: cfg, log: () => {}, startedAt: NOW }, { now: NOW });
    expect(stats).toMatchObject({ reconciled: 1, gammaResolved: 0 });
    const row = await rows<{ status: string; bucket_won: boolean }>(
      db2,
      `select status, bucket_won from replica_positions where source='forward' and event_id=$1`,
      [ev],
    );
    expect(row[0]!.status).toBe('resolved');
    expect(row[0]!.bucket_won).toBe(true); // bucket 1 === winner 1
    await db2.close();
  });
});

// --- review-hardening: parity + edge cases (each test on its own fresh DB) -----------------------------------
/** Compact db-parametrized seeders so each isolated test stays self-contained. */
function seeders(database: PGlite) {
  return {
    async city(slug = 'kuala-lumpur', tz = TZ): Promise<string> {
      await database.query(
        `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
         values ($1, $1, 'MY', 'C', $2, 'southeast-asia', now(), now()) on conflict (slug) do nothing`,
        [slug, tz],
      );
      return (await rows<{ id: string }>(database, `select id from cities where slug=$1`, [slug]))[0]!.id;
    },
    async event(cityId: string, targetDate: string, winningBucketIdx: number | null, key: string): Promise<string> {
      return (
        await database.query<{ id: string }>(
          `insert into market_events (poly_event_id, slug, city_id, target_date, unit, kind, ladder_ok, winning_bucket_idx)
           values ($1, $2, $3, $4, 'C', 'highest', true, $5) returning id`,
          [`poly-${key}`, `highest-temperature-in-${key}`, cityId, targetDate, winningBucketIdx],
        )
      ).rows[0]!.id;
    },
    async bucket(eventId: string, idx: number, cond: string, low: number, high: number): Promise<string> {
      return (
        await database.query<{ id: string }>(
          `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no, tick_size, fee_rate)
           values ($1,$2,$3,$4,$5,$6,$7,$8,0.01,0.05) returning id`,
          [eventId, idx, `${low}-${high}C`, low, high, cond, `ty-${cond}`, `tn-${cond}`],
        )
      ).rows[0]!.id;
    },
    async snap(bucketId: string, capturedAt: string, bid: number, ask: number): Promise<void> {
      await database.query(
        `insert into market_snapshots (bucket_id, best_bid, best_ask, mid, captured_at) values ($1,$2,$3,$4,$5)`,
        [bucketId, bid, ask, (bid + ask) / 2, capturedAt],
      );
    },
    run(payload: Record<string, unknown>): Promise<unknown> {
      return database.query(`select public.replica_record_run($1::jsonb)`, [JSON.stringify(payload)]);
    },
    pos(list: Record<string, unknown>[]): Promise<unknown> {
      return database.query(`select public.replica_record_positions('forward', true, $1::jsonb)`, [JSON.stringify(list)]);
    },
  };
}

const nowSecOf = (): number => Math.floor(NOW.getTime() / 1000);
const inputsOf = (database: PGlite): Promise<{ candidates: { citySlug: string }[] }> =>
  rows<{ x: { candidates: { citySlug: string }[] } }>(
    database,
    `select public.replica_forward_inputs($1,'2026-06-20','2026-06-26') as x`,
    [nowSecOf()],
  ).then((r) => r[0]!.x);

describe('replica_forward_inputs — whitelist FILTERS (not just round-trips) + is case-insensitive', () => {
  it('excludes a non-whitelisted city, and a mixed-case whitelist still matches the lowercase slug', async () => {
    const tdb = await freshDb();
    const s = seeders(tdb);
    const kl = await s.city('kuala-lumpur', TZ);
    const tok = await s.city('tokyo', 'Asia/Tokyo');
    const evKL = await s.event(kl, '2026-06-23', null, 'kl-2026-06-23');
    await s.snap(await s.bucket(evKL, 1, 'cKL', 31, 32), '2026-06-22T05:00:00Z', 0.12, 0.18);
    const evTok = await s.event(tok, '2026-06-23', null, 'tok-2026-06-23');
    await s.snap(await s.bucket(evTok, 1, 'cTok', 31, 32), '2026-06-22T05:00:00Z', 0.12, 0.18);

    // whitelist = kuala-lumpur only → tokyo must be ABSENT from candidates (proves the WHERE actually filters).
    await s.run({ mode: 'forward', ranAt: '2026-06-21T07:00:00Z', whitelist: ['kuala-lumpur'], strat: {} });
    let slugs = (await inputsOf(tdb)).candidates.map((c) => c.citySlug);
    expect(slugs).toContain('kuala-lumpur');
    expect(slugs).not.toContain('tokyo');

    // mixed-case whitelist STILL matches the lowercase slug (parity with loadCandidates' toLowerCase).
    await s.run({ mode: 'forward', ranAt: '2026-06-21T08:00:00Z', whitelist: ['Kuala-Lumpur'], strat: {} });
    slugs = (await inputsOf(tdb)).candidates.map((c) => c.citySlug);
    expect(slugs).toContain('kuala-lumpur');
    await tdb.close();
  });
});

describe('replica-forward handler — review-hardening edge cases', () => {
  const ctxOn = (port: ReturnType<typeof pglitePort>): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: NOW });

  it('does NOT re-open a position resolved early via Gamma whose resolutionTs is still in the future (open+closed dedup)', async () => {
    const tdb = await freshDb();
    const s = seeders(tdb);
    const tport = pglitePort(tdb);
    const kl = await s.city();
    // P: target 2026-06-23 → resolutionTs 2026-06-23T16:00Z is in the FUTURE vs NOW (2026-06-22T12:00Z); DB
    // unresolved (winning_bucket_idx null), so it is BOTH a live candidate AND Gamma-resolvable — the exact
    // close-then-reopen trap. Its 36h entry instant (2026-06-22T04:00Z) has passed, with a cheap-Yes book.
    const evP = await s.event(kl, '2026-06-23', null, 'p-2026-06-23');
    await s.snap(await s.bucket(evP, 1, 'condP', 31, 32), '2026-06-22T05:00:00Z', 0.12, 0.18);
    await s.run({ mode: 'forward', ranAt: '2026-06-21T07:00:00Z', whitelist: ['kuala-lumpur'], strat: {} });
    await s.pos([{
      conditionId: 'condP', eventId: evP, citySlug: 'kuala-lumpur', region: 'southeast-asia', targetDate: '2026-06-23',
      bucketIdx: 1, bucketLabel: '31-32C', resolutionTs: ts('2026-06-23T16:00:00Z'), entryTs: ts('2026-06-22T04:00:00Z'),
      entryDayUtc: '2026-06-22', entryCapturedTs: ts('2026-06-22T05:00:00Z'), makerPrice: 0.12, takerPrice: 0.18,
      stakeUsd: 12, feeRate: 0.05, bucketWon: null, makerRealisticFilled: false, status: 'open',
      placedAtUtc: '2026-06-22T05:00:00Z', closedAtUtc: null,
    }]);
    const gamma = (url: string): Promise<unknown> =>
      Promise.resolve(
        url.includes('/markets') && url.includes('condP')
          ? [{ conditionId: 'condP', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', closed: true }]
          : [],
      );

    // Tick 1: Gamma closes P (resolved). Tick 2: P is resolved (absent from `open`) but still a live candidate —
    // the open+closed placedKeys must keep it from being re-placed/re-opened.
    const t1 = await replicaForward(ctxOn(tport), { now: NOW, fetchJson: gamma });
    expect(t1).toMatchObject({ reconciled: 1 });
    const t2 = await replicaForward(ctxOn(tport), { now: NOW, fetchJson: gamma });
    expect(t2.opened).toBe(0); // placeBuysPure did NOT re-emit the resolved position

    const row = await rows<{ status: string; bucket_won: boolean }>(
      tdb, `select status, bucket_won from replica_positions where source='forward' and event_id=$1`, [evP],
    );
    expect(row.length).toBe(1);
    expect(row[0]!.status).toBe('resolved'); // never flipped back to open
    expect(row[0]!.bucket_won).toBe(true);
    await tdb.close();
  });

  it('cold start (no forward run): falls back to DEFAULT strat + all-cities candidates and still places', async () => {
    const tdb = await freshDb();
    const s = seeders(tdb);
    const tport = pglitePort(tdb);
    const kl = await s.city();
    const ev = await s.event(kl, '2026-06-23', null, 'cold-2026-06-23');
    await s.snap(await s.bucket(ev, 1, 'condCold', 31, 32), '2026-06-22T05:00:00Z', 0.12, 0.18);
    // NO replica_record_run → run:null → DEFAULT_REPLICA_STRATEGY + empty whitelist (v_whitelist null → all cities).
    const stats = await replicaForward(ctxOn(tport), { now: NOW });
    expect(stats.opened).toBe(1);
    const row = await rows<{ status: string }>(tdb, `select status from replica_positions where source='forward' and event_id=$1`, [ev]);
    expect(row[0]!.status).toBe('open');
    await tdb.close();
  });

  it('toCandidates silently drops an event with an invalid tz; a valid-tz sibling still places', async () => {
    const tdb = await freshDb();
    const s = seeders(tdb);
    const tport = pglitePort(tdb);
    const good = await s.city('kuala-lumpur', TZ);
    const bad = await s.city('badtz', 'Not/AZone'); // invalid IANA tz → localDayWindow throws → toCandidates skips
    const evG = await s.event(good, '2026-06-23', null, 'good-2026-06-23');
    await s.snap(await s.bucket(evG, 1, 'condG', 31, 32), '2026-06-22T05:00:00Z', 0.12, 0.18);
    const evB = await s.event(bad, '2026-06-23', null, 'bad-2026-06-23');
    await s.snap(await s.bucket(evB, 1, 'condB', 31, 32), '2026-06-22T05:00:00Z', 0.12, 0.18);
    await s.run({ mode: 'forward', ranAt: '2026-06-21T07:00:00Z', whitelist: [], strat: {} }); // empty → all cities

    const stats = await replicaForward(ctxOn(tport), { now: NOW });
    expect(stats.opened).toBe(1); // only the valid-tz event placed; the bad-tz one was dropped, no throw
    const placed = await rows<{ city_slug: string }>(tdb, `select city_slug from replica_positions where source='forward'`);
    expect(placed.map((p) => p.city_slug)).toEqual(['kuala-lumpur']);
    await tdb.close();
  });
});
