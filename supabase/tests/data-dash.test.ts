/**
 * dash_data (migration 0065) — the /data forecast-accuracy RPC. End-to-end against PGlite (the REAL SQL).
 * harness only db.exec()s the CREATE FUNCTION and plpgsql parses bodies lazily, so applying 0065 proves nothing
 * about runtime behaviour — this is the behavioural cover for the build's most error-prone, novel logic:
 *   • argmax via `unnest(probs) with ordinality` → i-1 is 0-based, must equal winning_bucket_idx;
 *   • the `order by p desc, i` tie-break must pick the LOWER index;
 *   • distinct-on-latest-made_at dedup per (event, lead);
 *   • the matched hg⋈mc join (only events where BOTH our model and the market have a call);
 *   • the >=5 station floor + the >=5/day brier floor + the ADR-16 scored_for_leads keying;
 *   • the jsonb-OBJECT contract (0044 trap), the empty-DB path, and operator_guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const INTRUDER = { email: 'intruder@example.com' };

const svc = (db: PGlite, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> =>
  asRole(db, 'service_role', null, () => rows(db, sql, params));

async function seedCity(db: PGlite, slug: string): Promise<string> {
  const r = await svc(
    db,
    `insert into public.cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'XX', 'C', 'UTC', 'europe-west', now(), now()) returning id`,
    [slug],
  );
  return r[0]!.id as string;
}

async function seedEvent(db: PGlite, cityId: string, slug: string, targetDate: string, winIdx: number | null): Promise<string> {
  const r = await svc(
    db,
    `insert into public.market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
     values ($1, $1, $2, $3, 'C', true, $4) returning id`,
    [slug, cityId, targetDate, winIdx],
  );
  return r[0]!.id as string;
}

interface DistOpts {
  probs: number[];
  hash: string;
  lead?: number;
  brier?: number | null;
  scored?: string; // a smallint[] literal, e.g. '{1}'
  offsetMin?: number; // made_at = now() - offsetMin minutes (older = larger)
}
function seedDist(db: PGlite, eventId: string, source: string, o: DistOpts): Promise<unknown> {
  return svc(
    db,
    `insert into public.bucket_probabilities
       (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, scored_for_leads, brier)
     values ($1, $2, $3, false, now() - ($4 * interval '1 minute'), $5, $6::numeric[], $7::smallint[], $8)`,
    [eventId, source, o.lead ?? 1, o.offsetMin ?? 0, o.hash, `{${o.probs.join(',')}}`, o.scored ?? '{}', o.brier ?? null],
  );
}

const dash = (db: PGlite): Promise<Record<string, unknown>> =>
  asRole(db, 'authenticated', OPERATOR, async () => {
    const r = await rows<{ out: Record<string, unknown> }>(db, `select public.dash_data() as out`);
    return r[0]!.out;
  });

const byLead1 = (out: Record<string, unknown>): Record<string, unknown> | undefined =>
  (out.byLead as Record<string, unknown>[]).find((r) => Number(r.lead) === 1);

describe('dash_data — argmax (0-based + tie), dedup, matched join, shape, guard', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    const city = await seedCity(db, 'testcity');
    // One market per (city, date) — the natural key is (city_id, target_date, kind) — so each event is a
    // distinct DAY. 5 matched days. House argmax (0-based; tie → lower) == winner for ALL → houseExact 1, miss 0.
    // Market argmax is deliberately wrong on each → marketExact 0, a known within-1/miss spread.
    const evs = [
      { slug: 'e1', date: '2026-06-16', win: 1, house: [0.1, 0.7, 0.2], market: [0.7, 0.2, 0.1] }, // hAM 1, mAM 0 (|0-1|=1)
      { slug: 'e2', date: '2026-06-17', win: 2, house: [0.2, 0.1, 0.7], market: [0.6, 0.3, 0.1] }, // hAM 2, mAM 0 (|0-2|=2)
      { slug: 'e3', date: '2026-06-18', win: 0, house: [0.5, 0.5, 0.0], market: [0.1, 0.2, 0.7] }, // hAM TIE→0, mAM 2 (|2-0|=2)
      { slug: 'e4', date: '2026-06-19', win: 2, house: [0.0, 0.3, 0.7], market: [0.5, 0.4, 0.1] }, // hAM 2, mAM 0 (|0-2|=2)
      { slug: 'e5', date: '2026-06-20', win: 0, house: [0.6, 0.3, 0.1], market: [0.2, 0.7, 0.1] }, // hAM 0, mAM 1 (|1-0|=1)
    ];
    for (const e of evs) {
      const id = await seedEvent(db, city, e.slug, e.date, e.win);
      await seedDist(db, id, 'house_gaussian', { probs: e.house, hash: `${e.slug}-h` });
      await seedDist(db, id, 'market_consensus', { probs: e.market, hash: `${e.slug}-m` });
    }
    // dedup: e1 gets an OLDER, WRONG house dist (argmax 0 != win 1). The latest (offset 0, correct) must win.
    const e1 = (await svc(db, `select id from public.market_events where slug = 'e1'`))[0]!.id as string;
    await seedDist(db, e1, 'house_gaussian', { probs: [0.7, 0.2, 0.1], hash: 'e1-h-old', offsetMin: 60 });
    // matched exclusion: a house-only and a market-only DAY must NOT enter byLead/byStation.
    const h6 = await seedEvent(db, city, 'e6-house-only', '2026-06-21', 2);
    await seedDist(db, h6, 'house_gaussian', { probs: [0.1, 0.1, 0.8], hash: 'e6-h' });
    const m7 = await seedEvent(db, city, 'e7-market-only', '2026-06-22', 2);
    await seedDist(db, m7, 'market_consensus', { probs: [0.1, 0.1, 0.8], hash: 'e7-m' });
  });
  afterAll(async () => { await db?.close(); });

  it('returns a jsonb OBJECT, never a top-level array (the 0044 trap)', async () => {
    const ty = await asRole(db, 'authenticated', OPERATOR, async () =>
      (await rows<{ ty: string }>(db, `select jsonb_typeof(public.dash_data()) as ty`))[0]!.ty,
    );
    expect(ty).toBe('object');
  });

  it('house argmax is 0-based (i-1) AND tie-to-lower AND dedup-latest → houseExact 1; matched-only n=5', async () => {
    const l1 = byLead1(await dash(db))!;
    expect(l1).toBeDefined();
    expect(Number(l1.n)).toBe(5); // e6/e7 excluded — not matched
    expect(Number(l1.stations)).toBe(1);
    // If argmax were index-0-based-wrong, or the tie picked the higher index, or dedup kept the stale e1 row,
    // at least one of e1..e5 would miss and this would drop below 1.
    expect(Number(l1.houseExact)).toBeCloseTo(1, 6);
    expect(Number(l1.houseWithin1)).toBeCloseTo(1, 6);
    expect(Number(l1.houseMiss)).toBeCloseTo(0, 6);
  });

  it('the market is argmax-scored on the SAME events, independently (exact 0, within1 0.4, miss 1.6)', async () => {
    const l1 = byLead1(await dash(db))!;
    expect(Number(l1.marketExact)).toBeCloseTo(0, 6);
    expect(Number(l1.marketWithin1)).toBeCloseTo(0.4, 6); // e1 + e5 within 1
    expect(Number(l1.marketMiss)).toBeCloseTo(1.6, 6); // (1+2+2+2+1)/5
  });

  it('byStation surfaces the one city with >=5 matched events: exact 1 / within1 1 / miss 0', async () => {
    const out = await dash(db);
    expect(out.byStation).toHaveLength(1);
    const s = (out.byStation as Record<string, unknown>[])[0]!;
    expect(s.city).toBe('testcity');
    expect(s.region).toBe('europe-west');
    expect(Number(s.exactPct)).toBeCloseTo(1, 6);
    expect(Number(s.within1Pct)).toBeCloseTo(1, 6);
    expect(Number(s.meanMiss)).toBeCloseTo(0, 6);
    expect(Number(s.marketMeanMiss)).toBeCloseTo(1.6, 6);
  });

  it('operator_guard refuses a non-operator authenticated caller', async () => {
    await expect(
      asRole(db, 'authenticated', INTRUDER, () => rows(db, `select public.dash_data() as out`)),
    ).rejects.toThrow();
  });
});

describe('dash_data — a station below the >=5 matched floor is dropped from byStation', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    const city = await seedCity(db, 'thincity');
    const days = ['2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20'];
    for (let i = 0; i < 4; i++) {
      const id = await seedEvent(db, city, `t${i}`, days[i]!, 1);
      await seedDist(db, id, 'house_gaussian', { probs: [0.2, 0.6, 0.2], hash: `t${i}-h` });
      await seedDist(db, id, 'market_consensus', { probs: [0.2, 0.6, 0.2], hash: `t${i}-m` });
    }
  });
  afterAll(async () => { await db?.close(); });

  it('4 matched events (< 5) → byStation empty, but byLead still aggregates them', async () => {
    const out = await dash(db);
    expect(out.byStation).toEqual([]);
    expect(Number(byLead1(out)!.n)).toBe(4);
  });
});

describe('dash_data — brierSeries keys on scored_for_leads@1 + the >=5/day floor', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
    const A = '2026-06-20';
    const B = '2026-06-21';
    // One market per (city, date), so a SINGLE day's >=5 floor needs 5 distinct cities. Day A: 5 scored
    // house+market days (brier set, scored_for_leads {1}). The FIRST house row has lead_days=0 but
    // scored_for_leads {1} — it must still count, proving the series keys on scored_for_leads, not lead_days.
    for (let i = 0; i < 5; i++) {
      const c = await seedCity(db, `ca${i}`);
      const id = await seedEvent(db, c, `a${i}`, A, 1);
      await seedDist(db, id, 'house_gaussian', { probs: [0.2, 0.6, 0.2], brier: 0.7, scored: '{1}', lead: i === 0 ? 0 : 1, hash: `a${i}-h` });
      await seedDist(db, id, 'market_consensus', { probs: [0.3, 0.5, 0.2], brier: 0.6, scored: '{1}', hash: `a${i}-m` });
    }
    // Day A noise that must NOT inflate nHouse@1: a row scored for lead 2 only, and a row scored '{}'.
    const cn1 = await seedCity(db, 'can1');
    const n1 = await seedEvent(db, cn1, 'a-lead2', A, 1);
    await seedDist(db, n1, 'house_gaussian', { probs: [0.2, 0.6, 0.2], brier: 0.9, scored: '{2}', lead: 2, hash: 'a-l2-h' });
    const cn2 = await seedCity(db, 'can2');
    const n2 = await seedEvent(db, cn2, 'a-empty', A, 1);
    await seedDist(db, n2, 'house_gaussian', { probs: [0.2, 0.6, 0.2], brier: 0.9, scored: '{}', lead: 1, hash: 'a-empty-h' });
    // Day B: only 4 scored house days → below the >=5/day floor → the whole day is omitted.
    for (let i = 0; i < 4; i++) {
      const c = await seedCity(db, `cb${i}`);
      const id = await seedEvent(db, c, `b${i}`, B, 1);
      await seedDist(db, id, 'house_gaussian', { probs: [0.2, 0.6, 0.2], brier: 0.8, scored: '{1}', hash: `b${i}-h` });
      await seedDist(db, id, 'market_consensus', { probs: [0.3, 0.5, 0.2], brier: 0.6, scored: '{1}', hash: `b${i}-m` });
    }
  });
  afterAll(async () => { await db?.close(); });

  it('only day A (>=5 scored house) survives; nHouse counts scored_for_leads@1, not lead_days', async () => {
    const series = (await dash(db)).brierSeries as Record<string, unknown>[];
    expect(series).toHaveLength(1);
    const day = series[0]!;
    expect(day.date).toBe('2026-06-20');
    expect(Number(day.nHouse)).toBe(5); // the lead_days=0-but-scored@1 row counted; the {2} and {} rows did NOT
    expect(Number(day.nMarket)).toBe(5);
    expect(Number(day.brierHouse)).toBeCloseTo(0.7, 6);
    expect(Number(day.brierMarket)).toBeCloseTo(0.6, 6);
  });
});

describe('dash_data — empty DB', () => {
  it('returns a non-null meta with empty byLead/byStation/brierSeries, no throw', async () => {
    const db = await freshDb();
    try {
      const out = await asRole(db, 'authenticated', OPERATOR, async () =>
        (await rows<{ out: Record<string, unknown> }>(db, `select public.dash_data() as out`))[0]!.out,
      );
      const meta = out.meta as Record<string, unknown>;
      expect(meta.champion).toBe('house_gaussian');
      expect(Number(meta.leadStation)).toBe(1);
      expect(out.byLead).toEqual([]);
      expect(out.byStation).toEqual([]);
      expect(out.brierSeries).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
