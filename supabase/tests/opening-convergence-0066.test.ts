/**
 * Migration 0066 (opening-convergence Phase 0) — the PGlite twin of the keyless capture/seed schema.
 *
 * End-to-end against the real migration chain (freshDb applies 0001..0066): the seed-isolation `seeded`
 * columns, the 9 bot tables + the bot_positions partial-unique double-open belt, the capture/seed RPCs
 * (record_opening_captures round-trip, bot_latest_captures freshest-per-event, bot_capture_series ordered,
 * latest_house_dist labelled join), the §15 seed-isolation regression (a bot-seeded house_gaussian row is
 * EXCLUDED from dash_data's champion/argmax set AND from calib_scored_rows), upsert_distribution's p_seeded,
 * and that BOTH deadmen run no-alarm on an empty DB. RPCs are exercised through pglitePort (the FN_ARGS map
 * the production DbPort uses) so the positional-arg additions are themselves under test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, freshDb, hasUniqueIndex, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };

/** Seed a city + a resolved market_event + its bucket ladder (the distributions-build idiom). */
async function seedEvent(
  db: PGlite,
  o: { slug: string; date: string; winner: number; nBuckets?: number },
): Promise<string> {
  const n = o.nBuckets ?? 3;
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'NL', 'C', 'Europe/Amsterdam', 'europe-west', now(), now())
     on conflict (slug) do nothing`,
    [o.slug],
  );
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx)
     select 'pe-' || $1, 'ev-' || $1, id, ($2)::date, 'C', true, $3
     from cities where slug = $1 returning id`,
    [o.slug, o.date, o.winner],
  );
  const evId = ev.rows[0]!.id;
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [evId, i, `${20 + i}°C`, 20 + i, 20 + i, `c${i}`, `y${i}`, `n${i}`],
    );
  }
  return evId;
}

/** Insert a bucket_probabilities distribution row directly (service_role bypasses RLS via the bootstrap superuser). */
const insDist = (
  db: PGlite,
  evId: string,
  o: { source: string; hash: string; probs: string; seeded?: boolean; ageMin?: number; lead?: number; brier?: number; scored?: boolean },
): Promise<unknown> =>
  db.query(
    `insert into bucket_probabilities
       (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, seeded, scored_for_leads, brier)
     values ($1, $2, $3, false, now() - make_interval(mins => $4), $5, $6::numeric(8,6)[], $7, $8::smallint[], $9)`,
    [
      evId, o.source, o.lead ?? 1, o.ageMin ?? 0, o.hash, o.probs, o.seeded ?? false,
      o.scored === false ? '{}' : '{1}', o.brier ?? 0.1,
    ],
  );

// ── schema: columns, tables, indexes ───────────────────────────────────────────────────────────────────

describe('0066 schema — seeded columns, the 9 bot tables, the double-open belt', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  it('adds the seeded column to bucket_probabilities AND forecast_snapshots', async () => {
    const cols = await rows<{ table_name: string }>(
      db,
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'seeded'
         and table_name in ('bucket_probabilities', 'forecast_snapshots')`,
    );
    const names = new Set(cols.map((c) => c.table_name));
    expect(names.has('bucket_probabilities')).toBe(true);
    expect(names.has('forecast_snapshots')).toBe(true);
  });

  it('creates all 9 bot tables', async () => {
    const found = await rows<{ table_name: string }>(
      db,
      `select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const names = new Set(found.map((r) => r.table_name));
    for (const t of [
      'opening_captures', 'bot_positions', 'bot_orders', 'bot_loop_lease', 'bot_gate_snapshot',
      'bot_tick_log', 'bot_bankroll', 'bot_daily_kill', 'bot_circuit_state',
    ]) {
      expect(names, `missing bot table ${t}`).toContain(t);
    }
  });

  it('bot_positions carries the partial-unique double-open belt bp_one_open_per_bucket on (event_id, bucket_idx)', async () => {
    expect(await hasUniqueIndex(db, 'bot_positions', ['event_id', 'bucket_idx'], { partial: true })).toBe(true);
    // and it is named as the migration declares
    const [idx] = await rows<{ indexname: string }>(
      db,
      `select indexname from pg_indexes where schemaname = 'public' and tablename = 'bot_positions'
         and indexname = 'bp_one_open_per_bucket'`,
    );
    expect(idx).toBeDefined();
  });
});

// ── capture/seed RPCs ───────────────────────────────────────────────────────────────────────────────────

describe('0066 capture/seed RPCs (via pglitePort + FN_ARGS)', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  beforeAll(async () => { db = await freshDb(); port = pglitePort(db); });
  afterAll(async () => { await db?.close(); });

  it('record_opening_captures round-trips two rows (jsonb buckets, flags, neg_risk default, tz_name)', async () => {
    const captures = [
      {
        capturedAt: new Date(Date.now() - 60_000).toISOString(), eventId: null,
        city: 'amsterdam', targetDate: '2026-06-28', tzName: 'Europe/Amsterdam',
        createdAtGamma: new Date(Date.now() - 120_000).toISOString(),
        listingDetectedAt: new Date(Date.now() - 120_000).toISOString(),
        resolvesAt: '2026-06-28T22:00:00.000Z', hoursSinceListing: 0.5, peakMid: 0.12,
        isFlatOpen: true, houseSeeded: true,
        buckets: [{
          idx: 0, label: '20°C', loF: null, hiF: null, mid: 0.12, bestAsk: 0.13, depthUsd: 100,
          bestBid: 0.11, sellbackUsd: 80, houseProb: 0.3, tokenYes: 'y', tokenNo: 'n', conditionId: 'c',
        }],
        evVol24h: 12000, negRisk: true,
      },
      {
        // a NON-flat, NON-seeded capture; negRisk OMITTED → the SQL coalesce default (true) must apply.
        capturedAt: new Date().toISOString(), eventId: null,
        city: 'paris', targetDate: '2026-06-28', tzName: 'Europe/Paris',
        createdAtGamma: null, listingDetectedAt: null, resolvesAt: null,
        hoursSinceListing: 3.0, peakMid: 0.4, isFlatOpen: false, houseSeeded: false,
        buckets: [], evVol24h: null,
      },
    ];
    const n = await asRole(db, 'service_role', null, async () => {
      const r = await port.rpc<{ record_opening_captures: number }>('record_opening_captures', { p_rows: captures });
      return Number(r[0]!.record_opening_captures);
    });
    expect(n).toBe(2);

    const got = await rows<Record<string, unknown>>(db, `select * from public.opening_captures order by city`);
    expect(got.length).toBe(2);
    const ams = got.find((r) => r.city === 'amsterdam')!;
    expect(ams.is_flat_open).toBe(true);
    expect(ams.house_seeded).toBe(true);
    expect(ams.neg_risk).toBe(true);
    expect(ams.tz_name).toBe('Europe/Amsterdam');
    expect(Array.isArray(ams.buckets)).toBe(true);
    expect((ams.buckets as { houseProb: number }[])[0]!.houseProb).toBe(0.3); // jsonb buckets preserved
    expect(Number(ams.ev_vol24h)).toBe(12000);

    const par = got.find((r) => r.city === 'paris')!;
    expect(par.is_flat_open).toBe(false);
    expect(par.house_seeded).toBe(false);
    expect(par.neg_risk).toBe(true); // the coalesce(...,true) default kicked in
    expect(par.ev_vol24h).toBeNull();
  });

  it('bot_latest_captures returns the freshest capture per event; bot_capture_series returns the ordered series', async () => {
    const fresh = await freshDb();
    const fport = pglitePort(fresh);
    try {
      const e1 = await seedEvent(fresh, { slug: 'lc-ams', date: '2026-06-28', winner: 1 });
      const e2 = await seedEvent(fresh, { slug: 'lc-par', date: '2026-06-28', winner: 1 });
      const cap = (eventId: string, city: string, agoSec: number, peak: number) => ({
        capturedAt: new Date(Date.now() - agoSec * 1000).toISOString(), eventId, city,
        targetDate: '2026-06-28', tzName: 'Europe/Amsterdam', createdAtGamma: null, listingDetectedAt: null,
        resolvesAt: null, hoursSinceListing: 0.5, peakMid: peak, isFlatOpen: true, houseSeeded: true,
        buckets: [], evVol24h: 9000, negRisk: true,
      });
      await asRole(fresh, 'service_role', null, () =>
        fport.rpc('record_opening_captures', {
          p_rows: [cap(e1, 'lc-ams', 180, 0.15), cap(e1, 'lc-ams', 30, 0.1), cap(e2, 'lc-par', 60, 0.11)],
        }),
      );

      const latest = (await fport.rpc<{ bot_latest_captures: { eventId: string; peakMid: number }[] }>(
        'bot_latest_captures', { p_max_age_min: 5 },
      ))[0]!.bot_latest_captures;
      expect(latest.length).toBe(2); // one per event
      const ams = latest.find((c) => c.eventId === e1)!;
      expect(Number(ams.peakMid)).toBeCloseTo(0.1, 6); // the NEWER (30s-old) capture, not the 180s-old 0.15

      const series = (await fport.rpc<{ bot_capture_series: unknown[] }>('bot_capture_series', { p_days: 7 }))[0]!
        .bot_capture_series;
      expect(series.length).toBe(3); // the full series (2 for e1 + 1 for e2)
    } finally {
      await fresh.close();
    }
  });

  it('latest_house_dist joins the freshest non-nowcast house_gaussian to its labelled buckets; null for an unknown event', async () => {
    const evId = await seedEvent(db, { slug: 'ld-city', date: '2026-06-20', winner: 2, nBuckets: 3 });
    await insDist(db, evId, { source: 'house_gaussian', hash: 'h1', probs: '{0.1,0.2,0.7}' });

    const dist = (await port.rpc<{ latest_house_dist: { source: string; buckets: { label: string; prob: number }[] } | null }>(
      'latest_house_dist', { p_event_id: evId },
    ))[0]!.latest_house_dist!;
    expect(dist).not.toBeNull();
    expect(dist.source).toBe('house_gaussian');
    expect(dist.buckets.length).toBe(3);
    expect(dist.buckets[2]!.label).toBe('22°C'); // joined from market_buckets (W6b — bare probs[] carries no label)
    expect(Number(dist.buckets[2]!.prob)).toBeCloseTo(0.7, 6);

    const none = (await port.rpc<{ latest_house_dist: unknown }>(
      'latest_house_dist', { p_event_id: '00000000-0000-0000-0000-000000000000' },
    ))[0]!.latest_house_dist;
    expect(none).toBeNull();
  });

  it('upsert_distribution writes seeded=true with p_seeded=true and seeded=false by default (10-arg form)', async () => {
    const evId = await seedEvent(db, { slug: 'ud-city', date: '2026-06-20', winner: 1, nBuckets: 3 });
    await asRole(db, 'service_role', null, () =>
      port.rpc('upsert_distribution', {
        p_event_id: evId, p_source: 'house_gaussian', p_lead: 1, p_nowcast: false, p_inputs_hash: 'seeded-1',
        p_probs: [0.2, 0.5, 0.3], p_mu: 21, p_sigma: 1, p_stats_version: 1, p_seeded: true,
      }),
    );
    await asRole(db, 'service_role', null, () =>
      port.rpc('upsert_distribution', {
        p_event_id: evId, p_source: 'house_gaussian', p_lead: 1, p_nowcast: false, p_inputs_hash: 'default-1',
        p_probs: [0.2, 0.5, 0.3], p_mu: 21, p_sigma: 1, p_stats_version: 1, // p_seeded OMITTED → SQL default false
      }),
    );
    const got = await rows<{ inputs_hash: string; seeded: boolean }>(
      db, `select inputs_hash, seeded from public.bucket_probabilities where event_id = $1`, [evId],
    );
    const bySeed = new Map(got.map((r) => [r.inputs_hash, r.seeded]));
    expect(bySeed.get('seeded-1')).toBe(true);
    expect(bySeed.get('default-1')).toBe(false);
  });
});

// ── §15 seed-isolation regression (the consumer exclusions) ─────────────────────────────────────────────

describe('0066 §15 seed-isolation — a bot seed never becomes the scored champion', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); });
  afterAll(async () => { await db?.close(); });

  it('dash_data excludes a bot-seeded house_gaussian from the argmax/champion set', async () => {
    // winner = idx 2. The UNSEEDED row is correct (argmax 2) and OLDER; the SEEDED row is WRONG (argmax 0)
    // and NEWER, so without the exclusion the distinct-on-made_at-desc would pick the seeded row → houseExact 0.
    const evId = await seedEvent(db, { slug: 'si-city', date: '2026-06-20', winner: 2, nBuckets: 3 });
    await insDist(db, evId, { source: 'house_gaussian', hash: 'hg-real', probs: '{0.1,0.2,0.7}', seeded: false, ageMin: 60 });
    await insDist(db, evId, { source: 'house_gaussian', hash: 'hg-seed', probs: '{0.7,0.2,0.1}', seeded: true, ageMin: 10 });
    await insDist(db, evId, { source: 'market_consensus', hash: 'mc', probs: '{0.1,0.2,0.7}', seeded: false, ageMin: 20 });

    const data = await asRole(db, 'authenticated', OPERATOR, async () =>
      (await rows<{ out: { byLead: { lead: number; houseExact: number }[] } }>(db, `select public.dash_data(1::smallint) as out`))[0]!.out,
    );
    const lead1 = data.byLead.find((r) => r.lead === 1);
    expect(lead1).toBeDefined();
    // houseExact = 1 ⇒ the CORRECT unseeded row scored; the wrong (newer) SEEDED row was excluded.
    expect(Number(lead1!.houseExact)).toBe(1);
  });

  it('calib_scored_rows excludes a bot-seeded scored row', async () => {
    const fresh = await freshDb();
    try {
      const evId = await seedEvent(fresh, { slug: 'cs-city', date: '2026-06-20', winner: 1, nBuckets: 3 });
      await insDist(fresh, evId, { source: 'house_gaussian', hash: 'hg-real', probs: '{0.2,0.6,0.2}', seeded: false });
      await insDist(fresh, evId, { source: 'house_gaussian', hash: 'hg-seed', probs: '{0.6,0.2,0.2}', seeded: true });
      await insDist(fresh, evId, { source: 'market_consensus', hash: 'mc', probs: '{0.2,0.6,0.2}', seeded: false });

      const cr = await rows<{ scored: { source: string }[] }>(
        fresh, `select scored from public.calib_scored_rows(30, '2026-06-20'::date)`,
      );
      expect(cr.length).toBe(1); // one city
      const scored = cr[0]!.scored;
      // 3 rows × one scored lead each = 3 candidates; the seeded house_gaussian is dropped → 2 remain.
      expect(scored.length).toBe(2);
      expect(scored.filter((s) => s.source === 'house_gaussian').length).toBe(1); // only the unseeded one
    } finally {
      await fresh.close();
    }
  });
});

// ── the deadmen ─────────────────────────────────────────────────────────────────────────────────────────

describe('0066 deadmen — run no-alarm on an empty/default DB', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  beforeAll(async () => { db = await freshDb(); port = pglitePort(db); });
  afterAll(async () => { await db?.close(); });

  it('capture_deadman_check returns jsonb without error and does NOT alarm when there is no capture data', async () => {
    const out = (await port.rpc<{ capture_deadman_check: { alarmed: boolean; latestCaptureAt: string | null } }>(
      'capture_deadman_check', {},
    ))[0]!.capture_deadman_check;
    expect(out.alarmed).toBe(false);
    expect(out.latestCaptureAt).toBeNull(); // not-yet-producing ⇒ no alarm
  });

  it('bot_deadman_check returns jsonb without error and does NOT alarm when the bot has never ticked', async () => {
    const out = (await port.rpc<{ bot_deadman_check: { alarmed: boolean; mode: string } }>(
      'bot_deadman_check', {},
    ))[0]!.bot_deadman_check;
    expect(out.alarmed).toBe(false);
    expect(out.mode).toBe('paper'); // mode-aware: reads tradingMode (seeded 'paper')
  });
});
