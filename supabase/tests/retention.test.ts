import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from './harness.ts';

/**
 * §15 "Downsample cron enforces EVERY retention rule" — fixture rows aged
 * artificially, then one ops_downsample() pass, then survivor assertions.
 */
let db: PGlite;
let eventId: string;
let staleEventId: string;
let bucketId: string;

beforeAll(async () => {
  db = await freshDb();

  await db.exec(`
    insert into stations (icao, lat, lon, country_code, tz)
    values ('ZZZZ', 40.0, -74.0, 'US', 'America/New_York');

    insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
    values ('testville', 'Testville', 'US', 'F', 'America/New_York', 'na-east', now(), now());
  `);

  const cityRow = await rows<{ id: string }>(db, `select id from cities where slug = 'testville'`);
  const cityId = cityRow[0]!.id;

  const ev = await rows<{ id: string }>(
    db,
    `insert into market_events (poly_event_id, slug, city_id, icao_at_creation, target_date, unit, ladder_ok, resolved_at, closed)
     values ('pe-1', 'testville-highest-jan1', $1, 'ZZZZ', '2026-01-01', 'F', true, now() - interval '40 days', true)
     returning id`,
    [cityId],
  );
  eventId = ev[0]!.id;

  // A second, UNRESOLVED event — its rows must never be touched by §7.12 retention.
  const ev2 = await rows<{ id: string }>(
    db,
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
     values ('pe-2', 'testville-highest-open', $1, '2026-12-01', 'F', true)
     returning id`,
    [cityId],
  );
  staleEventId = ev2[0]!.id;

  const bucket = await rows<{ id: string }>(
    db,
    `insert into market_buckets (event_id, bucket_idx, label, condition_id, token_yes, token_no)
     values ($1, 0, '80-81°F', 'cond-1', 'tok-yes', 'tok-no')
     returning id`,
    [eventId],
  );
  bucketId = bucket[0]!.id;
});

afterAll(async () => {
  await db.close();
});

describe('ops_downsample() retention rules', () => {
  it('enforces every rule in one pass', async () => {
    // --- §7.5 forecast_snapshots: >90d keeps only leads 0–2 @ 10Z -------------
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
        ('ZZZZ', 'ecmwf_ifs025', '2026-03-01', 0, 20.0, '10Z', 'forecast_api', now() - interval '100 days'),
        ('ZZZZ', 'ecmwf_ifs025', '2026-03-01', 2, 21.0, '10Z', 'forecast_api', now() - interval '100 days'),
        ('ZZZZ', 'ecmwf_ifs025', '2026-03-01', 5, 22.0, '10Z', 'forecast_api', now() - interval '100 days'),
        ('ZZZZ', 'ecmwf_ifs025', '2026-03-01', 1, 23.0, '22Z', 'forecast_api', now() - interval '100 days'),
        ('ZZZZ', 'ecmwf_ifs025', '2026-03-02', 3, 24.0, 'backfill', 'backfill_prev_runs', now() - interval '100 days'),
        ('ZZZZ', 'ecmwf_ifs025', '2026-05-01', 5, 25.0, '22Z', 'forecast_api', now() - interval '50 days')
    `);

    // --- §7.11 market_snapshots tiers ----------------------------------------
    await db.exec(`
      insert into market_snapshots (bucket_id, best_bid, best_ask, mid, captured_at)
      select '${bucketId}', 0.40, 0.44, 0.42, t from (values
        -- >7d tier: two in the same hour (one survives), one alone (survives).
        -- Anchored to the hour start so the pair NEVER straddles an hour
        -- boundary regardless of the wall-clock minute the test runs at.
        (date_trunc('hour', now()) - interval '10 days' + interval '5 minutes'),
        (date_trunc('hour', now()) - interval '10 days' + interval '15 minutes'),
        (date_trunc('hour', now()) - interval '10 days' + interval '2 hours'),
        -- >30d tier: distinct hours 0,1,2,3 and 6,7 and 12 and 18 on one UTC day → 4 survive
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '0 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '1 hour'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '2 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '3 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '6 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '7 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '12 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '40 days' + interval '18 hours'),
        -- >180d tier: three distinct hours on one UTC day → 1 survives
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '200 days' + interval '1 hour'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '200 days' + interval '9 hours'),
        (date_trunc('day', now() at time zone 'utc') at time zone 'utc' - interval '200 days' + interval '15 hours')
      ) v(t)
    `);

    // --- §7.12 bucket_probabilities: resolved 40d ago -------------------------
    await db.exec(`
      insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, scored_for_leads) values
        ('${eventId}', 'house_gaussian', 1, false, now() - interval '50 days', 'h1', '{0.5,0.5}', '{1}'),
        ('${eventId}', 'house_gaussian', 1, false, now() - interval '49 days', 'h2', '{0.6,0.4}', '{}'),
        ('${eventId}', 'house_gaussian', 0, false, now() - interval '48 days', 'h3', '{0.7,0.3}', '{}'),
        ('${eventId}', 'market_consensus', 0, true, now() - interval '47 days', 'n1', '{0.5,0.5}', '{}'),
        ('${eventId}', 'market_consensus', 0, true, now() - interval '46 days' - interval '12 hours', 'n2', '{0.6,0.4}', '{}'),
        ('${eventId}', 'market_consensus', 0, true, now() - interval '46 days', 'n3', '{0.8,0.2}', '{}'),
        ('${staleEventId}', 'house_gaussian', 5, false, now() - interval '300 days', 'open1', '{0.5,0.5}', '{}')
    `);

    // --- §7.21 / §7.8 / 90d ops rows ------------------------------------------
    await db.exec(`
      insert into edge_evaluations (event_id, bucket_idx, captured_hour, edge, pass) values
        ('${eventId}', 0, date_trunc('hour', now() - interval '40 days'), 0.05, false),
        ('${eventId}', 0, date_trunc('hour', now() - interval '10 days'), 0.06, true);

      insert into intraday_max (icao, date_local, max_tenths_c, n_obs) values
        ('ZZZZ', current_date - 20, 25.0, 10),
        ('ZZZZ', current_date - 5, 26.0, 12);

      insert into job_runs (job, period_key, status, created_at) values
        ('poll-markets', 'old', 'ok', now() - interval '100 days'),
        ('poll-markets', 'new', 'ok', now() - interval '1 day');

      insert into alerts_log (kind, severity, title, created_at) values
        ('JOB_FAIL', 'CRITICAL', 'ancient', now() - interval '100 days'),
        ('JOB_FAIL', 'CRITICAL', 'recent', now() - interval '1 day');
    `);

    // --- run the cron body -----------------------------------------------------
    const result = await rows<{ ops_downsample: Record<string, number> }>(
      db,
      `select public.ops_downsample()`,
    );
    const counts = result[0]!.ops_downsample;

    // §7.5: of the five >90d rows, leads 0 and 2 @10Z survive; lead-5@10Z,
    // lead-1@22Z, backfill go; the 50d row is untouched.
    expect(counts['forecast_snapshots']).toBe(3);
    const fc = await rows<{ lead_days: number; snapshot_slot: string }>(
      db,
      `select lead_days, snapshot_slot from forecast_snapshots
       where captured_at < now() - interval '90 days' order by lead_days`,
    );
    expect(fc).toEqual([
      { lead_days: 0, snapshot_slot: '10Z' },
      { lead_days: 2, snapshot_slot: '10Z' },
    ]);
    const recent = await rows(db, `select 1 from forecast_snapshots where captured_at > now() - interval '60 days'`);
    expect(recent.length).toBe(1);

    // §7.11: 14 inserted (3 + 8 + 3) → hourly pass removes 1 (same-hour dup);
    // 6h pass removes 4 of the 8 forty-day rows; daily pass removes 2 of the 3 two-hundred-day rows.
    expect(counts['market_snapshots_hourly']).toBe(1);
    expect(counts['market_snapshots_4perday']).toBe(4);
    expect(counts['market_snapshots_daily']).toBe(2);
    const ms = await rows<{ n: number }>(db, `select count(*)::int as n from market_snapshots`);
    expect(ms[0]!.n).toBe(14 - 1 - 4 - 2);

    // §7.12: scored row, final house row, nowcast first+last (n3 is also the
    // consensus final) survive; h2 and n2 deleted; unresolved event untouched.
    expect(counts['bucket_probabilities']).toBe(2);
    const probs = await rows<{ inputs_hash: string }>(
      db,
      `select inputs_hash from bucket_probabilities order by inputs_hash`,
    );
    expect(probs.map((p) => p.inputs_hash)).toEqual(['h1', 'h3', 'n1', 'n3', 'open1']);

    // §7.21 edge_evaluations 30d
    expect(counts['edge_evaluations']).toBe(1);
    const ee = await rows<{ n: number }>(db, `select count(*)::int as n from edge_evaluations`);
    expect(ee[0]!.n).toBe(1);

    // §7.8 intraday 14d
    expect(counts['intraday_max']).toBe(1);
    const im = await rows<{ date_local: string }>(db, `select date_local from intraday_max`);
    expect(im.length).toBe(1);

    // 90d ops prunes
    expect(counts['job_runs']).toBe(1);
    expect(counts['alerts_log']).toBe(1);
    const jr = await rows<{ period_key: string }>(db, `select period_key from job_runs`);
    expect(jr.map((r) => r.period_key)).toEqual(['new']);
    const al = await rows<{ title: string }>(db, `select title from alerts_log`);
    expect(al.map((r) => r.title)).toEqual(['recent']);
  });

  it('is idempotent — a second pass deletes nothing', async () => {
    const result = await rows<{ ops_downsample: Record<string, number> }>(
      db,
      `select public.ops_downsample()`,
    );
    const counts = result[0]!.ops_downsample;
    for (const [rule, n] of Object.entries(counts)) {
      expect(n, `rule ${rule} should be settled`).toBe(0);
    }
  });
});
