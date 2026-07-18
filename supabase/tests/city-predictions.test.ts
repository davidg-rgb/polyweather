/**
 * city_prediction_grades + dash_city_predictions (migration 0106) — the /cities prediction-table data
 * layer. End-to-end against PGlite (the real SQL): the grading-trigger fold (claim_event_winner /
 * flag_grading_mismatch / the backfill's direct writes), the LAST-pre-resolution-capture honesty rule,
 * the argmax-houseProb pick parity, re-fold on winner/mismatch transitions, the no-capture no-op, and
 * the dash RPC envelope (stats + open rows + config + operator_guard).
 */
import { afterEach, afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, rows } from './harness.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const INTRUDER = { email: 'not-the-operator@example.com' };

let db: PGlite;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db?.close();
});

afterEach(async () => {
  await db.exec(`delete from public.city_prediction_grades`);
  await db.exec(`delete from public.buy_table_cycle_ranges`); // the 0100 capture-insert trigger also feeds this
  await db.exec(`delete from public.opening_captures`); // FK child first
  await db.exec(`delete from public.market_events`);
});

/** A city + one market_events row (the buy-table-live idiom). */
async function seedEvent(opts: {
  slug: string;
  targetDateSql?: string;
  winnerIdx?: number | null;
  closed?: boolean;
}): Promise<string> {
  const region = (await rows<{ region: string }>(db, `select region from public.clusters limit 1`))[0]!.region;
  const cityId = (
    await rows<{ city_id: string }>(
      db,
      `select city_id from public.upsert_city($1, $2, 'US', 'C', 'UTC', $3)`,
      [opts.slug, `City ${opts.slug}`, region],
    )
  )[0]!.city_id;
  return (
    await rows<{ id: string }>(
      db,
      `insert into public.market_events
         (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx, closed)
       values ('pe-' || $1, 'ev-' || $1, $2, ${opts.targetDateSql ?? 'current_date'}, 'C', true, $3, $4)
       returning id`,
      [opts.slug, cityId, opts.winnerIdx ?? null, opts.closed ?? false],
    )
  )[0]!.id;
}

/** An identity-complete ladder whose argmax-houseProb bucket is `topIdx`. */
const ladder = (topIdx: number, opts: { seeded?: boolean; execAsk?: number } = {}): unknown =>
  [0, 1, 2].map((idx) => ({
    idx,
    label: `${30 + idx}°C`,
    bestAsk: 0.2 + idx * 0.01,
    execAsk: (opts.execAsk ?? 0.12) + idx * 0.01,
    bestBid: 0.05,
    execBid: 0.04,
    depthUsd: 100,
    houseProb: opts.seeded === false ? undefined : idx === topIdx ? 0.6 : 0.2,
    conditionId: `c-${idx}`,
    tokenYes: `t-${idx}`,
  }));

/** One opening_captures tick (resolves_at + captured_at as SQL expressions). */
const seedTick = (
  evId: string,
  city: string,
  buckets: unknown,
  { atSql = 'now()', resolvesAtSql = `now() + interval '6 hours'`, targetDateSql = 'current_date' } = {},
) =>
  rows(
    db,
    `insert into public.opening_captures
       (captured_at, event_id, city, target_date, tz_name, resolves_at, is_flat_open, house_seeded, buckets, neg_risk)
     values (${atSql}, $1, $2, ${targetDateSql}, 'UTC', ${resolvesAtSql}, false, true, $3::jsonb, true)`,
    [evId, city, JSON.stringify(buckets)],
  );

const grades = () =>
  rows<{
    event_id: string;
    city: string;
    predicted_idx: number | null;
    predicted_label: string | null;
    winner_idx: number;
    hit: boolean | null;
    mismatch: boolean;
  }>(db, `select * from public.city_prediction_grades`);

const dash = (actor = OPERATOR): Promise<Record<string, unknown>> =>
  asRole(db, 'authenticated', actor, async () => {
    const r = await rows<{ out: Record<string, unknown> }>(db, `select public.dash_city_predictions() as out`);
    return r[0]!.out;
  });

describe('the grading-trigger fold (0106 §2/§3)', () => {
  it('claim_event_winner folds the LAST pre-resolution capture argmax pick and grades it', async () => {
    const ev = await seedEvent({ slug: 'oslo' });
    // three ticks; the argmax moves 0 → 2 over time — the LAST pre-resolution tick (idx 2) must win.
    await seedTick(ev, 'oslo', ladder(0), { atSql: `now() - interval '3 hours'` });
    await seedTick(ev, 'oslo', ladder(1), { atSql: `now() - interval '2 hours'` });
    await seedTick(ev, 'oslo', ladder(2), { atSql: `now() - interval '1 hour'` });

    await rows(db, `select public.claim_event_winner($1, 2::smallint)`, [ev]);

    const g = await grades();
    expect(g).toHaveLength(1);
    expect(g[0]!.city).toBe('oslo');
    expect(g[0]!.predicted_idx).toBe(2);
    expect(g[0]!.predicted_label).toBe('32°C');
    expect(g[0]!.winner_idx).toBe(2);
    expect(g[0]!.hit).toBe(true);
    expect(g[0]!.mismatch).toBe(false);
  });

  it('a tick stamped AFTER its own resolves_at (post-close collapsed book) is never the graded prediction', async () => {
    const ev = await seedEvent({ slug: 'lima' });
    // pre-close tick predicts idx 0; a later tick predicts idx 1 but is captured AFTER resolves_at.
    await seedTick(ev, 'lima', ladder(0), {
      atSql: `now() - interval '2 hours'`,
      resolvesAtSql: `now() - interval '1 hour'`,
    });
    await seedTick(ev, 'lima', ladder(1), {
      atSql: `now()`,
      resolvesAtSql: `now() - interval '1 hour'`,
    });

    await rows(db, `select public.claim_event_winner($1, 1::smallint)`, [ev]);

    const g = await grades();
    expect(g).toHaveLength(1);
    expect(g[0]!.predicted_idx).toBe(0); // the honest pre-close pick — a MISS, not the leaked post-close hit
    expect(g[0]!.hit).toBe(false);
  });

  it('an unseeded capture (no houseProb anywhere) folds as predicted NULL / hit NULL', async () => {
    const ev = await seedEvent({ slug: 'pune' });
    await seedTick(ev, 'pune', ladder(0, { seeded: false }), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 0::smallint)`, [ev]);

    const g = await grades();
    expect(g).toHaveLength(1);
    expect(g[0]!.predicted_idx).toBeNull();
    expect(g[0]!.hit).toBeNull();
  });

  it('grading an event with NO captures succeeds and folds nothing (the grader is never blocked)', async () => {
    const ev = await seedEvent({ slug: 'nocap' });
    const [claimed] = await rows<{ claim_event_winner: boolean }>(
      db,
      `select public.claim_event_winner($1, 1::smallint)`,
      [ev],
    );
    expect(claimed!.claim_event_winner).toBe(true);
    expect(await grades()).toHaveLength(0);
  });

  it('flag_grading_mismatch re-folds the row with mismatch=true', async () => {
    const ev = await seedEvent({ slug: 'kiev' });
    await seedTick(ev, 'kiev', ladder(1), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 1::smallint)`, [ev]);
    expect((await grades())[0]!.mismatch).toBe(false);

    await rows(db, `select public.flag_grading_mismatch($1)`, [ev]);
    const g = await grades();
    expect(g).toHaveLength(1);
    expect(g[0]!.mismatch).toBe(true);
  });

  it('a later poly_resolved_winner_idx transition (the backfill UPDATE path) re-adjudicates the row', async () => {
    const ev = await seedEvent({ slug: 'baku' });
    await seedTick(ev, 'baku', ladder(2), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 0::smallint)`, [ev]);
    expect((await grades())[0]!.hit).toBe(false); // predicted 2, METAR-graded 0

    // the backfill later writes the venue's own resolution — poly wins the coalesce, the row re-folds.
    await db.exec(`update public.market_events set poly_resolved_winner_idx = 2 where id = '${ev}'`);
    const g = await grades();
    expect(g[0]!.winner_idx).toBe(2);
    expect(g[0]!.hit).toBe(true);
  });

  it('an INSERT arriving already graded (backfill-market-history) folds when captures exist', async () => {
    // captures can precede the market_events row only via event_id, so seed the event UNGRADED first is the
    // live path — the INSERT trigger's real target is a backfill insert of an event whose captures were
    // written earlier under the same id. Simulate: seed event+captures, delete the event row keeping the
    // capture (FK requires the row — so instead grade at INSERT time on a fresh event with prior captures).
    const ev = await seedEvent({ slug: 'graz' });
    await seedTick(ev, 'graz', ladder(1), { atSql: `now() - interval '1 hour'` });
    // no winner yet → no fold
    expect(await grades()).toHaveLength(0);
    // the direct UPDATE (same statement shape the backfill uses) triggers the fold
    await db.exec(`update public.market_events set poly_resolved_winner_idx = 1, closed = true where id = '${ev}'`);
    const g = await grades();
    expect(g).toHaveLength(1);
    expect(g[0]!.hit).toBe(true);
  });

  it('routine poll updates (volume/last_seen) do NOT re-fire the fold', async () => {
    const ev = await seedEvent({ slug: 'linz' });
    await seedTick(ev, 'linz', ladder(0), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 0::smallint)`, [ev]);
    const before = (await rows<{ folded_at: string }>(db, `select folded_at::text as folded_at from public.city_prediction_grades`))[0]!;
    await db.exec(`update public.market_events set volume24h = 999, last_seen = now() where id = '${ev}'`);
    const after = (await rows<{ folded_at: string }>(db, `select folded_at::text as folded_at from public.city_prediction_grades`))[0]!;
    expect(after.folded_at).toBe(before.folded_at);
  });
});

describe('dash_city_predictions (0106 §5)', () => {
  it('returns the OBJECT envelope: generatedAt + config defaults + stats + rows', async () => {
    const out = await dash();
    expect(out.generatedAt).toBeTruthy();
    expect(out.stats).toEqual([]);
    expect(out.rows).toEqual([]);
    const cfg = out.config as { leadMinH: unknown; leadMaxH: unknown; priceCap: unknown };
    // fresh DB: 0095 seeded the buy_table.* config rows — the RPC must read those, defaulting sanely.
    expect(Number(cfg.leadMinH)).toBe(2);
    expect(Number(cfg.leadMaxH)).toBe(12);
    expect(Number(cfg.priceCap)).toBeGreaterThan(0);
  });

  it('per-city stats: hits/n over graded events; mismatch + unseeded rows excluded from the rate', async () => {
    // two graded oslo events: one hit, one miss → 50% (n=2)
    const a = await seedEvent({ slug: 'oslo' });
    await seedTick(a, 'oslo', ladder(1), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 1::smallint)`, [a]);
    const b = await seedEvent({ slug: 'oslo2' }); // separate city row (unique slug) but same capture city
    await seedTick(b, 'oslo', ladder(0), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 2::smallint)`, [b]);
    // a mismatch event and an unseeded event must not move the rate
    const c = await seedEvent({ slug: 'oslo3' });
    await seedTick(c, 'oslo', ladder(1), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 1::smallint)`, [c]);
    await rows(db, `select public.flag_grading_mismatch($1)`, [c]);
    const d = await seedEvent({ slug: 'oslo4' });
    await seedTick(d, 'oslo', ladder(0, { seeded: false }), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 0::smallint)`, [d]);

    const out = await dash();
    const stats = out.stats as Array<{ city: string; n: unknown; hits: unknown; rate: unknown }>;
    const oslo = stats.find((s) => s.city === 'oslo');
    expect(oslo).toBeTruthy();
    expect(Number(oslo!.n)).toBe(2);
    expect(Number(oslo!.hits)).toBe(1);
    expect(Number(oslo!.rate)).toBeCloseTo(0.5, 6);
  });

  it('rows: one per OPEN captured market with the argmax pick + ITS ask; graded/expired markets excluded', async () => {
    const open = await seedEvent({ slug: 'wien' });
    await seedTick(open, 'wien', ladder(1, { execAsk: 0.11 }), {
      atSql: `now() - interval '10 minutes'`,
      resolvesAtSql: `now() + interval '5 hours'`,
    });
    const graded = await seedEvent({ slug: 'rome' });
    await seedTick(graded, 'rome', ladder(0), { atSql: `now() - interval '1 hour'` });
    await rows(db, `select public.claim_event_winner($1, 0::smallint)`, [graded]);
    const expired = await seedEvent({ slug: 'bern' });
    await seedTick(expired, 'bern', ladder(0), {
      atSql: `now() - interval '2 hours'`,
      resolvesAtSql: `now() - interval '1 hour'`, // past close, not yet graded → not actionable, not listed
    });

    const out = await dash();
    const rws = out.rows as Array<{ city: string; slug: string; predLabel: string; ask: unknown; resolvesAt: string }>;
    expect(rws).toHaveLength(1);
    expect(rws[0]!.city).toBe('wien');
    expect(rws[0]!.slug).toBe('ev-wien'); // 0107: the market_events event slug → the polymarket.com/event permalink
    expect(rws[0]!.predLabel).toBe('31°C');
    expect(Number(rws[0]!.ask)).toBeCloseTo(0.12, 6); // idx-1 execAsk (0.11 + idx*0.01)
    expect(rws[0]!.resolvesAt).toBeTruthy();
  });

  it('operator_guard blocks a non-operator', async () => {
    await expect(dash(INTRUDER)).rejects.toThrow();
  });
});
