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
import { BOT_DEFAULTS, parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';

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

  it('the APPLIED 0066 config mirror parses to BOT_DEFAULTS — pins the real migration SQL, not a hand-copied literal (TEST3-1)', async () => {
    // The packages/core F10 test asserts parseBotConfig(a TEST LITERAL) === BOT_DEFAULTS, which cannot catch an
    // edit to the migration's `insert into config` block (a drifted value would override the code default at
    // runtime via opening-spike loadCfg → parseBotConfig). This reads the ACTUAL applied rows and pins them.
    const cfgRows = await rows<{ key: string; value: string }>(
      db,
      `select key, value from config where key = 'bot_enabled' or key like 'bot.%' order by key`,
    );
    expect(parseBotConfig(cfgRows)).toEqual(BOT_DEFAULTS);
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

  it('bp_one_open_per_bucket REJECTS a second OPEN position on the same (event,bucket); allows reopen after close', async () => {
    const fresh = await freshDb();
    try {
      const evId = await seedEvent(fresh, { slug: 'do-city', date: '2026-06-28', winner: 1 });
      const insPos = (state: string): Promise<unknown> =>
        fresh.query(
          `insert into bot_positions (mode, event_id, city, target_date, tz_name, bucket_idx, bucket_label, token_yes, condition_id, state)
           values ('paper', $1, 'do-city', '2026-06-28', 'Europe/Amsterdam', 0, '20°C', 'y0', 'c0', $2)`,
          [evId, state],
        );
      await insPos('armed'); // first open position — ok
      await expect(insPos('maker_resting')).rejects.toThrow(); // a 2nd OPEN on the same (event,bucket) → unique violation
      // close the first; a new open on the same bucket is now allowed (the partial-unique only covers OPEN states).
      await fresh.query(`update bot_positions set state = 'closed' where event_id = $1 and bucket_idx = 0`, [evId]);
      await expect(insPos('armed')).resolves.toBeDefined();
    } finally {
      await fresh.close();
    }
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

      // both RPCs return a jsonb OBJECT { rows: [...] }, NEVER a top-level array (the 0044 port-misread trap):
      // a bare array would be read by the service-role port as a RETURNS TABLE rowset → result[0].fn undefined.
      const latestObj = (await fport.rpc<{ bot_latest_captures: { rows: { eventId: string; peakMid: number }[] } }>(
        'bot_latest_captures', { p_max_age_min: 5 },
      ))[0]!.bot_latest_captures;
      expect(Array.isArray(latestObj)).toBe(false);          // object, not a bare array
      expect(Array.isArray(latestObj.rows)).toBe(true);
      const latest = latestObj.rows;
      expect(latest.length).toBe(2); // one per event
      const ams = latest.find((c) => c.eventId === e1)!;
      expect(Number(ams.peakMid)).toBeCloseTo(0.1, 6); // the NEWER (30s-old) capture, not the 180s-old 0.15

      const seriesObj = (await fport.rpc<{ bot_capture_series: { rows: { eventId: string; capturedAt: string }[] } }>(
        'bot_capture_series', { p_days: 7 },
      ))[0]!.bot_capture_series;
      expect(Array.isArray(seriesObj)).toBe(false);
      const series = seriesObj.rows;
      expect(series.length).toBe(3); // the full series (2 for e1 + 1 for e2)
      // ordered by (event_id, captured_at): captured_at is non-decreasing WITHIN each event (the spike's contract).
      const e1times = series.filter((r) => r.eventId === e1).map((r) => Date.parse(r.capturedAt));
      expect(e1times).toEqual([...e1times].sort((a, b) => a - b));
    } finally {
      await fresh.close();
    }
  });

  // 0068 — bot_spike_series caps rows PER EVENT (the full series aggregates >1 GB of jsonb at the 45-city scale,
  // past Postgres's field cap → the Phase-0.5 gate could not render). Every event still appears (its EARLIEST
  // captures, which contain the first-usable-house the spike scores) so seededCoverage + distinct target_dates
  // are preserved. The spike reads this via raw service-role SQL (script-db), so test it that way.
  it('bot_spike_series caps captures per event to p_cap (earliest first), keeping every event present', async () => {
    const fresh = await freshDb();
    try {
      const e1 = await seedEvent(fresh, { slug: 'sc-ams', date: '2026-06-28', winner: 1 });
      const e2 = await seedEvent(fresh, { slug: 'sc-par', date: '2026-06-29', winner: 1 });
      const fport = pglitePort(fresh);
      const cap = (eventId: string, city: string, td: string, agoSec: number) => ({
        capturedAt: new Date(Date.now() - agoSec * 1000).toISOString(), eventId, city,
        targetDate: td, tzName: 'Europe/Amsterdam', createdAtGamma: null, listingDetectedAt: null,
        resolvesAt: null, hoursSinceListing: 0.5, peakMid: 0.1, isFlatOpen: true, houseSeeded: true,
        buckets: [], evVol24h: 9000, negRisk: true,
      });
      // e1: 4 captures; e2: 1 capture. cap=2 must return the 2 EARLIEST of e1 + the 1 of e2 = 3 rows total.
      await asRole(fresh, 'service_role', null, () =>
        fport.rpc('record_opening_captures', {
          p_rows: [
            cap(e1, 'sc-ams', '2026-06-28', 400), cap(e1, 'sc-ams', '2026-06-28', 300),
            cap(e1, 'sc-ams', '2026-06-28', 200), cap(e1, 'sc-ams', '2026-06-28', 100),
            cap(e2, 'sc-par', '2026-06-29', 50),
          ],
        }),
      );
      const [row] = await rows<{ s: { rows: { eventId: string; capturedAt: string }[] } }>(
        fresh, 'select public.bot_spike_series(7, 2) as s',
      );
      const series = row!.s.rows;
      expect(Array.isArray(row!.s)).toBe(false); // { rows: [...] } object, not a bare array (the 0044 trap)
      const e1rows = series.filter((r) => r.eventId === e1);
      expect(e1rows.length).toBe(2); // capped to p_cap=2 (was 4)
      expect(series.filter((r) => r.eventId === e2).length).toBe(1); // every event still present
      // the 2 kept e1 rows are the EARLIEST (400s + 300s ago), not the latest two
      const kept = e1rows.map((r) => Date.parse(r.capturedAt)).sort((a, b) => a - b);
      const all = [400, 300, 200, 100].map((s) => Date.now() - s * 1000).sort((a, b) => a - b);
      expect(kept[0]).toBeCloseTo(all[0]!, -3);
      expect(kept[1]).toBeCloseTo(all[1]!, -3);
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

  it('bot_seed_quality counts contributing models date-wide but gates calibration coverage on the EVENT lead (EDGE2-3/EDGE2-4)', async () => {
    const fresh = await freshDb();
    const fport = pglitePort(fresh);
    try {
      await fresh.query(
        `insert into stations (icao, country_code, tz, lat, lon, source) values ('BSQ1', 'KR', 'Asia/Seoul', 37, 127, 'ourairports')`,
      );
      // two models forecast 2026-07-01 — one at lead 0, one at lead 1 → nModels (date-wide) = 2 regardless of lead.
      await fresh.query(
        `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
           ('BSQ1','ecmwf_ifs025','2026-07-01',0,25.0,'10Z','forecast_api','2026-07-01T10:00:00Z'),
           ('BSQ1','gfs_seamless','2026-07-01',1,24.0,'10Z','forecast_api','2026-06-30T10:00:00Z')`,
      );
      // calibration coverage (model_stats) exists ONLY at lead 0.
      await fresh.query(
        `insert into model_stats (icao, model, lead_days, snapshot_slot, stats_version) values ('BSQ1','ecmwf_ifs025',0,'10Z',1)`,
      );

      const q = async (lead: number | null) =>
        (await fport.rpc<{ bot_seed_quality: { nModels: number; hasStats: boolean } }>('bot_seed_quality', {
          p_icao: 'BSQ1', p_target_date: '2026-07-01', p_lead: lead,
        }))[0]!.bot_seed_quality;

      const atLead0 = await q(0);
      expect(Number(atLead0.nModels)).toBe(2); // date-wide count, NOT lead-keyed
      expect(atLead0.hasStats).toBe(true); // model_stats covers lead 0
      const atLead1 = await q(1);
      expect(Number(atLead1.nModels)).toBe(2); // still date-wide (the fragile lead-keying was removed)
      expect(atLead1.hasStats).toBe(false); // but NO calibration coverage at lead 1 → fail-closed
      const stationWide = await q(null);
      expect(stationWide.hasStats).toBe(true); // p_lead null → station-wide coverage fallback
    } finally {
      await fresh.close();
    }
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

  it('ALL FOUR consumer exclusions actually patched the live function bodies (the guarded string-replace did not no-op)', async () => {
    // The exclusions are applied at migration time by pg_get_functiondef → replace(...) of an EXACT predicate
    // literal. If a target body ever drifts from that literal the replace silently no-ops yet still logs
    // "patched" — a bot seed would then leak into that consumer's champion/argmax. dash_data + calib are also
    // covered behaviorally above; this pins the two that aren't (dash_amsterdam_sim, poll_known_events) and
    // guards all four against future drift in one shot.
    for (const fn of ['dash_data', 'calib_scored_rows', 'dash_amsterdam_sim', 'poll_known_events']) {
      const [r] = await rows<{ def: string }>(
        db,
        `select pg_get_functiondef(p.oid) as def from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = $1 limit 1`,
        [fn],
      );
      expect(r, `function ${fn} not found`).toBeDefined();
      expect(r!.def.includes('coalesce(bp.seeded'), `${fn} missing the seeded-exclusion guard (string-replace no-op?)`).toBe(true);
    }

    // dash_data applies THREE distinct replaces (house_gaussian, market_consensus, the in(...) set); the loop
    // above only proves ≥1 landed. Pin that the market_consensus exclusion SPECIFICALLY is present — if that one
    // replace target ever drifts and silently no-ops, a bot seed would leak into the consensus read (TEST2-5).
    const [dd] = await rows<{ def: string }>(
      db,
      `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'dash_data' limit 1`,
    );
    expect(
      /market_consensus'\s+and\s+bp\.nowcast\s*=\s*false\s+and\s+coalesce\(bp\.seeded/.test(dd!.def),
      'dash_data market_consensus seeded-exclusion missing (the multi-replace partially no-opped?)',
    ).toBe(true);
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

// CAP-1/CAP-2 regression guard: capture flowing healthily but NEVER inside the flat-open window (the universe
// filter excluding the OPEN) is the silent corruption that would make the Phase-0.5 spike a false NO-GO. The
// seeded-fraction check above misses it (its v_n>=v_window guard never trips with 0 flat-open rows).
describe('capture_deadman_check — the flat-open-never-sampled guard (CAP-1/CAP-2)', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  beforeAll(async () => { db = await freshDb(); port = pglitePort(db); });
  afterAll(async () => { await db?.close(); });

  const check = async () =>
    (await port.rpc<{ capture_deadman_check: { alarmed: boolean; noFlatOpen: boolean } }>('capture_deadman_check', {}))[0]!
      .capture_deadman_check;
  const insCap = (capturedAtSql: string, isFlatOpen: boolean) =>
    db.query(
      `insert into opening_captures (captured_at, city, target_date, tz_name, is_flat_open, house_seeded)
       values (${capturedAtSql}, 'amsterdam', current_date, 'Europe/Amsterdam', ${isFlatOpen}, true)`,
    );

  it('ALARMS when capture is healthy (fresh latest) but ZERO captures are flat-open over the warmup span', async () => {
    await db.query('delete from opening_captures');
    await insCap("now() - interval '3 days 1 hour'", false); // span ≥ 3d warmup …
    await insCap("now() - interval '1 day'", false);
    await insCap("now() - interval '1 minute'", false); // … and the latest is FRESH (not stale)
    const out = await check();
    expect(out.noFlatOpen).toBe(true);
    expect(out.alarmed).toBe(true); // the universe filter is excluding the open the spike must measure
  });

  it('does NOT alarm once even a single flat-open capture exists in the span', async () => {
    await db.query('delete from opening_captures');
    await insCap("now() - interval '3 days 1 hour'", false);
    await insCap("now() - interval '1 minute'", true); // a flat-open capture lands → the open IS being sampled
    const out = await check();
    expect(out.noFlatOpen).toBe(false);
    expect(out.alarmed).toBe(false);
  });

  it('does NOT alarm before the warmup span elapses (cannot false-fire on day one)', async () => {
    await db.query('delete from opening_captures');
    await insCap("now() - interval '12 hours'", false);
    await insCap("now() - interval '1 minute'", false);
    const out = await check();
    expect(out.noFlatOpen).toBe(false); // span 0.5d < 3d warmup — not yet judgeable
  });
});
