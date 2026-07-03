/**
 * Migration 0077 (capture read thinning) — the PGlite twin against the real migration chain.
 *
 * Pins: convergence_capture_inputs keeps ONE capture row per event per 20-min epoch grid bucket with a
 * deterministic pick (min captured_at, id tiebreak) PLUS always the NEWEST tick per event (the 0069
 * `rn = cnt` invariant — the replay's time-stop check + open-position marks read the freshest retained tick,
 * so a live event's still-forming final bucket must not hide it); when the earliest tick of the last bucket
 * IS the last tick, it appears exactly once (no dup); rows in DIFFERENT buckets all survive; the earliest
 * tick per event always survives (the buildEvents FRESH re-check invariant — opening-bracket-ingest.ts); the
 * jsonb OBJECT {captures, resolutions} envelope + the 0073 bucket trim (incl. bestBid) are unchanged;
 * resolutions are untouched by the thinning; exactly ONE overload exists (the 0054/0058 overload trap the
 * migration deliberately avoids); and the service-role-only grants hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from './harness.ts';

const GRID_MS = 20 * 60_000;
/** A 20-min epoch grid bucket start comfortably in the past (so bucket b0+GRID is also non-future-fragile). */
const B0 = Math.floor((Date.now() - 60 * 60_000) / GRID_MS) * GRID_MS;

/** Normalize a Postgres `timestamptz::text` ("2026-07-03 11:40:00+00") to epoch ms. */
const epochMs = (s: string): number => Date.parse(s.replace(' ', 'T').replace(/\+00(:00)?$/, 'Z'));

interface CaptureOut {
  eventId: string;
  capturedAt: string;
  buckets: { idx: number; label: string; bestAsk: number; execAsk: number; execBid: number; bestBid: number; depthUsd: number; houseProb: number }[];
}
interface InputsOut {
  captures: CaptureOut[];
  resolutions: { id: string; winnerIdx: number | null; gradingMismatch: boolean }[];
}

/** Seed a city + a resolved market event (winner 1) for the inputs RPC (mirrors the 0073 twin's seed). */
async function seedEvent(db: PGlite, slug: string): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'NL', 'C', 'Europe/Amsterdam', 'europe-west', now(), now()) on conflict (slug) do nothing`,
    [slug],
  );
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
     select 'pe-' || $1, 'ev-' || $1, id, current_date, 'C', true, 1 from cities where slug = $1 returning id`,
    [slug],
  );
  return ev.rows[0]!.id;
}

/** One capture tick at an exact epoch-ms instant (deterministic grid-bucket placement). */
async function insCapture(db: PGlite, evId: string, slug: string, atMs: number, hours: number): Promise<void> {
  const buckets = JSON.stringify([
    { idx: 0, label: '20°C', mid: 0.1, bestAsk: 0.16, execAsk: 0.16, depthUsd: 200, bestBid: 0.13, execBid: 0.13, houseProb: 0.4 },
  ]);
  await db.query(
    `insert into opening_captures
       (captured_at, event_id, city, target_date, tz_name, created_at_gamma, resolves_at, hours_since_listing,
        peak_mid, is_flat_open, house_seeded, buckets, ev_vol24h, neg_risk)
     values (to_timestamp($3::float8 / 1000.0), $1, $2, current_date, 'Europe/Amsterdam', now() - interval '30 minutes',
        now() + interval '1 day', $4, 0.16, true, true, $5::jsonb, 9000, true)`,
    [evId, slug, atMs, hours, buckets],
  );
}

const inputs = async (db: PGlite, slugs: string[]): Promise<InputsOut> => {
  // inline array literal (slugs are test constants) — the 0073 twin's call idiom, no text[] param binding.
  const arr = slugs.map((s) => `'${s}'`).join(',');
  return (await rows<{ out: InputsOut }>(db, `select public.convergence_capture_inputs(21, array[${arr}]) as out`))[0]!.out;
};

describe('0077 capture read thinning — convergence_capture_inputs 20-min grid', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  it('3 ticks inside ONE still-forming bucket → BOTH the earliest AND the latest returned, only those', async () => {
    const evId = await seedEvent(db, 'thin-one');
    // three ticks inside the SAME epoch grid bucket [B0, B0+20min) — a live event's still-forming bucket.
    await insCapture(db, evId, 'thin-one', B0, 0.2);
    await insCapture(db, evId, 'thin-one', B0 + 5 * 60_000, 0.4);
    await insCapture(db, evId, 'thin-one', B0 + 10 * 60_000, 0.6);

    const out = await inputs(db, ['thin-one']);
    const caps = out.captures.filter((c) => c.eventId === evId);
    // earliest-of-bucket (the FRESH re-check anchor: min hours_since_listing sits at the first tick) AND the
    // global-latest tick (the replay's time-stop / open-position mark anchor); the middle tick is thinned.
    expect(caps.map((c) => epochMs(c.capturedAt))).toEqual([B0, B0 + 10 * 60_000]);
  });

  it('DEDUP: when the earliest tick of the last bucket IS the last tick per event, it appears exactly once', async () => {
    const evId = await seedEvent(db, 'thin-dedup');
    // bucket A carries 3 ticks; the FINAL bucket carries exactly one — that tick is simultaneously
    // earliest-of-its-bucket AND the event's newest tick, so the OR of the two keep-rules must not dup it.
    await insCapture(db, evId, 'thin-dedup', B0 - GRID_MS, 0.2);
    await insCapture(db, evId, 'thin-dedup', B0 - GRID_MS + 5 * 60_000, 0.3);
    await insCapture(db, evId, 'thin-dedup', B0 - GRID_MS + 10 * 60_000, 0.4);
    await insCapture(db, evId, 'thin-dedup', B0 + 30_000, 0.6);

    const out = await inputs(db, ['thin-dedup']);
    const caps = out.captures.filter((c) => c.eventId === evId);
    // earliest of bucket A + the final tick once — NOT [.., B0+30s, B0+30s], and bucket A's tail is gone
    // (its latest tick is neither earliest-of-bucket nor the event's newest).
    expect(caps.map((c) => epochMs(c.capturedAt))).toEqual([B0 - GRID_MS, B0 + 30_000]);
  });

  it('multi-bucket event → earliest-per-bucket rows + the global latest row, nothing else', async () => {
    const evId = await seedEvent(db, 'thin-many');
    // two ticks in EACH of three distinct buckets
    const at = [B0 - 2 * GRID_MS + 30_000, B0 - GRID_MS + 30_000, B0 + 30_000];
    for (const [i, ms] of at.entries()) {
      await insCapture(db, evId, 'thin-many', ms, 0.2 + i * 0.1);
      await insCapture(db, evId, 'thin-many', ms + 7 * 60_000, 0.25 + i * 0.1);
    }

    const out = await inputs(db, ['thin-many']);
    const caps = out.captures.filter((c) => c.eventId === evId);
    // the three earliest-of-bucket ticks + the global latest (the last bucket's second tick), ASC order.
    expect(caps.map((c) => epochMs(c.capturedAt))).toEqual([...at, at[2]! + 7 * 60_000]);
  });

  it('CROSS-EVENT: two events sharing one 20-min bucket window each keep their OWN earliest + latest rows', async () => {
    // the only lock on the `partition by event_id` key: under a GLOBAL-partition regression the shared bucket
    // would yield ONE grid_rn=1 row (x1's T0) and ONE global-latest row (x2's T0+3m) across BOTH events —
    // x1 would lose its latest and x2 its earliest. Interleaved ticks make either regression fail loudly.
    const e1 = await seedEvent(db, 'thin-x1');
    const e2 = await seedEvent(db, 'thin-x2');
    const T0 = B0 - 3 * GRID_MS; // a bucket window shared by BOTH events, distinct from the other tests'
    await insCapture(db, e1, 'thin-x1', T0, 0.2);
    await insCapture(db, e2, 'thin-x2', T0 + 60_000, 0.2);
    await insCapture(db, e1, 'thin-x1', T0 + 2 * 60_000, 0.3);
    await insCapture(db, e2, 'thin-x2', T0 + 3 * 60_000, 0.3);

    const out = await inputs(db, ['thin-x1', 'thin-x2']); // BOTH cities in ONE call
    const capsFor = (evId: string) =>
      out.captures.filter((c) => c.eventId === evId).map((c) => epochMs(c.capturedAt));
    expect(capsFor(e1)).toEqual([T0, T0 + 2 * 60_000]); // own earliest-of-bucket + own latest
    expect(capsFor(e2)).toEqual([T0 + 60_000, T0 + 3 * 60_000]);
  });

  it('a grading_mismatch event maps gradingMismatch: true in resolutions', async () => {
    const evId = await seedEvent(db, 'thin-gm');
    await db.query(`update market_events set grading_mismatch = true where id = $1`, [evId]);
    await insCapture(db, evId, 'thin-gm', B0 + 60_000, 0.2);
    const out = await inputs(db, ['thin-gm']);
    expect(out.resolutions.length).toBe(1);
    expect(out.resolutions[0]!.gradingMismatch).toBe(true);
  });

  it('a city with zero capture rows yields the coalesce-empty envelope { captures: [], resolutions: [] }', async () => {
    const out = await inputs(db, ['thin-nothing-here']);
    expect(out.captures).toEqual([]);
    expect(out.resolutions).toEqual([]);
  });

  it('the envelope + the 0073 bucket trim are unchanged: jsonb OBJECT {captures, resolutions}, bestBid present', async () => {
    const out = await inputs(db, ['thin-one']);
    expect(Array.isArray(out)).toBe(false); // OBJECT, never a top-level array (the 0044 port-misread trap)
    expect(Array.isArray(out.captures)).toBe(true);
    expect(Array.isArray(out.resolutions)).toBe(true);
    const b0 = out.captures[0]!.buckets[0]!;
    // the DECISION-read trim fields (0073): idx/label/bestAsk/execAsk/execBid/bestBid/depthUsd/houseProb
    expect(Number(b0.bestBid)).toBeCloseTo(0.13, 6);
    expect(Number(b0.bestAsk)).toBeCloseTo(0.16, 6);
    expect(Number(b0.execAsk)).toBeCloseTo(0.16, 6);
    expect(Number(b0.execBid)).toBeCloseTo(0.13, 6);
    expect(Number(b0.depthUsd)).toBe(200);
    expect(Number(b0.houseProb)).toBeCloseTo(0.4, 6);
    expect(b0.idx).toBe(0);
  });

  it('resolutions are unaffected by the thinning (one row per fresh event, winner intact)', async () => {
    const one = await inputs(db, ['thin-one']);
    const many = await inputs(db, ['thin-many']);
    expect(one.resolutions.length).toBe(1);
    expect(many.resolutions.length).toBe(1);
    expect(Number(one.resolutions[0]!.winnerIdx)).toBe(1); // winning_bucket_idx from the seed
    expect(one.resolutions[0]!.gradingMismatch).toBe(false);
  });

  it('exactly ONE overload exists — no lingering fat 2-arg body next to a new signature (the 0054/0058 trap)', async () => {
    const overloads = await rows<{ nargs: number }>(
      db,
      `select pronargs as nargs from pg_proc
        where proname = 'convergence_capture_inputs' and pronamespace = 'public'::regnamespace`,
    );
    expect(overloads.map((o) => Number(o.nargs))).toEqual([2]);
  });

  it('grants intact: service_role EXECUTEs; public/anon/authenticated do not', async () => {
    const has = async (role: string): Promise<boolean> =>
      (await rows<{ has: boolean }>(
        db,
        `select has_function_privilege('${role}', 'public.convergence_capture_inputs(int, text[])', 'EXECUTE') as has`,
      ))[0]!.has;
    expect(await has('service_role')).toBe(true);
    expect(await has('anon')).toBe(false);
    expect(await has('authenticated')).toBe(false);
    expect(await has('public')).toBe(false);
  });
});
