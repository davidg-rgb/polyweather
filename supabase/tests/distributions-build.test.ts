import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import { buildDistributionForEvent } from '../functions/_shared/distributions.ts';
import { buildDistributions } from '../functions/build-distributions/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const NOW = new Date('2026-06-11T10:50:00Z'); // Seoul 19:50 Jun-11 → Jun-12 is lead 1
const cfg = parseConfigRows([]);

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let seoulEvent: string;
const alerts: Alert[] = [];
const deps = { notify: async (a: Alert) => (alerts.push(a), true), now: NOW };

const ctx = (): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: NOW });

const LADDER = [
  { idx: 0, label: '19°C or below', low: null, high: 19 },
  { idx: 1, label: '20°C', low: 20, high: 20 },
  { idx: 2, label: '21°C', low: 21, high: 21 },
  { idx: 3, label: '22°C', low: 22, high: 22 },
  { idx: 4, label: '23°C or higher', low: 23, high: null },
];

async function seedCityEvent(slug: string, icao: string, target: string, verified = true) {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'KR', 'C', 'Asia/Seoul', 'east-asia', now(), now())
     on conflict (slug) do nothing`,
    [slug],
  );
  await db.query(
    `insert into stations (icao, country_code, tz, lat, lon, source) values ($1, 'KR', 'Asia/Seoul', 37, 127, 'ourairports')
     on conflict (icao) do nothing`,
    [icao],
  );
  await db.query(
    `insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
     select id, $2, 'KR', now(), $3 from cities where slug = $1
     on conflict do nothing`,
    [slug, icao, verified],
  );
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
     select 'pe-' || $1 || '-' || $2, 'highest-temperature-in-' || $1 || '-x', id, ($2)::date, 'C', true
     from cities where slug = $1 returning id`,
    [slug, target],
  );
  const evId = ev.rows[0]!.id;
  for (const b of LADDER) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, 'c', 'y', 'n')`,
      [evId, b.idx, b.label, b.low, b.high],
    );
  }
  return evId;
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  seoulEvent = await seedCityEvent('seoul', 'RKSI', '2026-06-12');
  await db.exec(`
    insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
      ('RKSI', 'ecmwf_ifs025', '2026-06-12', 1, 21.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z'),
      ('RKSI', 'gfs_seamless', '2026-06-12', 1, 22.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z'),
      ('RKSI', 'icon_seamless', '2026-06-12', 1, 23.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z');
    insert into models (slug, display_name, enabled, is_ensemble) values ('blend', 'Blend pseudo-model', false, false)
      on conflict (slug) do nothing;
    insert into model_stats (icao, model, lead_days, snapshot_slot, bias_c, residual_sigma_c, weight, stats_version) values
      ('RKSI', 'ecmwf_ifs025', 1, '10Z', 1.0, 1.2, 0.5, 3),
      ('RKSI', 'gfs_seamless', 1, '10Z', 0.0, 1.4, 0.3, 3),
      ('RKSI', 'icon_seamless', 1, '10Z', -1.0, 1.6, 0.2, 3),
      ('RKSI', 'blend', 1, '10Z', 0.0, 1.5, null, 3);
    insert into ensemble_snapshots (icao, model, target_date, lead_days, snapshot_slot, members_c, n_members, captured_at)
      values ('RKSI', 'ecmwf_ifs025_ens', '2026-06-12', 1, '10Z',
              (select array_agg(20 + (i % 5)::numeric) from generate_series(1, 30) i), 30, '2026-06-11T10:35:00Z');
  `);
});

afterAll(async () => {
  await db.close();
});

describe('buildDistributionForEvent (§6.16)', () => {
  it('builds house_gaussian (bias-corrected weighted μ, blend σ) and house_ensemble', async () => {
    const r = await buildDistributionForEvent(port, cfg, seoulEvent, deps);
    expect(r.written).toBe(2);

    const hg = (await rows<{ mu_native: string; sigma_native: string; probs: number[]; lead_days: number; nowcast: boolean }>(
      db,
      `select mu_native, sigma_native, probs, lead_days, nowcast from bucket_probabilities
       where event_id = '${seoulEvent}' and source = 'house_gaussian'`,
    ))[0]!;
    // corrected: 21−1=20 (w .5), 22−0=22 (w .3), 23+1=24 (w .2) → μ = 21.4; σ = blend 1.5
    expect(Number(hg.mu_native)).toBeCloseTo(21.4, 6);
    expect(Number(hg.sigma_native)).toBeCloseTo(1.5, 6);
    expect(hg.lead_days).toBe(1);
    expect(hg.nowcast).toBe(false);
    const sum = hg.probs.reduce((a, b) => a + Number(b), 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);

    const he = await rows(db, `select 1 from bucket_probabilities where event_id = '${seoulEvent}' and source = 'house_ensemble'`);
    expect(he.length).toBe(1);
  });

  it('unchanged inputs hash ⇒ skip; changed forecast ⇒ new row, history retained', async () => {
    const again = await buildDistributionForEvent(port, cfg, seoulEvent, deps);
    expect(again).toEqual({ written: 0, skipped: 2 });

    // a new 22Z snapshot supersedes the 10Z one → different snapshot ids → new hash
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('RKSI', 'gfs_seamless', '2026-06-12', 0, 25.0, '22Z', 'forecast_api', '2026-06-11T22:15:00Z')
    `);
    const after = await buildDistributionForEvent(port, cfg, seoulEvent, deps);
    expect(after.written).toBeGreaterThanOrEqual(1);
    const hgRows = await rows(db, `select 1 from bucket_probabilities where event_id = '${seoulEvent}' and source = 'house_gaussian'`);
    expect(hgRows.length).toBe(2); // old + new — history retained
  });

  it('W19: a NEWER backfill row never feeds the live build', async () => {
    const before = (await rows<{ n: number }>(db, `select count(*)::int as n from bucket_probabilities where event_id = '${seoulEvent}'`))[0]!.n;
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('RKSI', 'ecmwf_ifs025', '2026-06-12', 1, 99.0, 'backfill', 'backfill_prev_runs', '2026-06-11T23:00:00Z')
    `);
    const r = await buildDistributionForEvent(port, cfg, seoulEvent, deps);
    expect(r.written).toBe(0); // inputs unchanged — the backfill row is invisible
    const after = (await rows<{ n: number }>(db, `select count(*)::int as n from bucket_probabilities where event_id = '${seoulEvent}'`))[0]!.n;
    expect(after).toBe(before);
  });

  it('no stats at all → equal weights + prior σ ladder (floored)', async () => {
    const ev = await seedCityEvent('busan', 'PUSN', '2026-06-12');
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
        ('PUSN', 'ecmwf_ifs025', '2026-06-12', 1, 21.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z'),
        ('PUSN', 'gfs_seamless', '2026-06-12', 1, 22.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z'),
        ('PUSN', 'icon_seamless', '2026-06-12', 1, 23.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z');
    `);
    await buildDistributionForEvent(port, cfg, ev, deps);
    const hg = (await rows<{ mu_native: string; sigma_native: string }>(
      db,
      `select mu_native, sigma_native from bucket_probabilities where event_id = '${ev}' and source = 'house_gaussian'`,
    ))[0]!;
    expect(Number(hg.mu_native)).toBeCloseTo(22.0, 6); // unweighted mean, no bias
    expect(Number(hg.sigma_native)).toBeCloseTo(1.9, 6); // priorSigmaByLead[1]
  });

  it('target-day + intraday max ⇒ ADDITIONAL nowcast=true rows with eliminated buckets zeroed', async () => {
    const ev = await seedCityEvent('incheon', 'INCH', '2026-06-11'); // lead 0 at NOW
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('INCH', 'ecmwf_ifs025', '2026-06-11', 0, 21.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z');
      insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs)
      values ('INCH', '2026-06-11', 24.0, 24, 12);
    `);
    const r = await buildDistributionForEvent(port, cfg, ev, deps);
    expect(r.written).toBe(2); // base + nowcast (gaussian only; no ensemble rows seeded)
    const ncast = (await rows<{ probs: number[] }>(
      db,
      `select probs from bucket_probabilities where event_id = '${ev}' and nowcast = true`,
    ))[0]!;
    // running max 24 eliminates every closed bucket (≤19, 20, 21, 22) → top tail certain
    expect(ncast.probs.map(Number)).toEqual([0, 0, 0, 0, 1]);
  });

  it('DistributionError (too-few ensemble members) ⇒ source skipped + WARN, others written', async () => {
    const ev = await seedCityEvent('daegu', 'DAEG', '2026-06-12');
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('DAEG', 'ecmwf_ifs025', '2026-06-12', 1, 21.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z');
      insert into ensemble_snapshots (icao, model, target_date, lead_days, snapshot_slot, members_c, n_members, captured_at)
      values ('DAEG', 'ecmwf_ifs025_ens', '2026-06-12', 1, '10Z', '{20,21,22}', 3, '2026-06-11T10:35:00Z');
    `);
    const r = await buildDistributionForEvent(port, cfg, ev, deps);
    expect(r.written).toBe(1); // gaussian only
    expect(alerts.some((a) => a.kind === 'DIST_SKIP' && a.title.includes('house_ensemble'))).toBe(true);
    const he = await rows(db, `select 1 from bucket_probabilities where event_id = '${ev}' and source = 'house_ensemble'`);
    expect(he.length).toBe(0);
  });

  it('biasCorrect:false centers on the RAW cross-model consensus (no per-model debias) — the convergence split', async () => {
    // Same 21/22/23 forecasts + biases [+1, 0, −1] / weights [.5,.3,.2] as the calibrated test. The CALIBRATED
    // center is 21.4 (20·.5 + 22·.3 + 24·.2); the RAW center drops the bias → 21·.5 + 22·.3 + 23·.2 = 21.7. The
    // 0.3°C gap = the weighted bias the convergence seed must NOT apply (it would move us off the crowd's center).
    const ev = await seedCityEvent('rawcity', 'RAWC', '2026-06-12');
    await db.exec(`
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
        ('RAWC', 'ecmwf_ifs025', '2026-06-12', 1, 21.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z'),
        ('RAWC', 'gfs_seamless', '2026-06-12', 1, 22.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z'),
        ('RAWC', 'icon_seamless', '2026-06-12', 1, 23.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z');
      insert into model_stats (icao, model, lead_days, snapshot_slot, bias_c, residual_sigma_c, weight, stats_version) values
        ('RAWC', 'ecmwf_ifs025', 1, '10Z', 1.0, 1.2, 0.5, 3),
        ('RAWC', 'gfs_seamless', 1, '10Z', 0.0, 1.4, 0.3, 3),
        ('RAWC', 'icon_seamless', 1, '10Z', -1.0, 1.6, 0.2, 3),
        ('RAWC', 'blend', 1, '10Z', 0.0, 1.5, null, 3);
    `);

    // calibrated (default) first → μ 21.4.
    await buildDistributionForEvent(port, cfg, ev, deps);
    // raw → μ 21.7, AND it must be a SEPARATE row (the 'raw' hash tag prevents the on-conflict-drop collision).
    const rawRes = await buildDistributionForEvent(port, cfg, ev, { ...deps, biasCorrect: false });
    expect(rawRes.written).toBeGreaterThanOrEqual(1); // not silently dropped as a hash collision with the calibrated row

    const hg = await rows<{ mu_native: string; sigma_native: string }>(
      db,
      `select mu_native, sigma_native from bucket_probabilities
       where event_id = '${ev}' and source = 'house_gaussian' order by mu_native`,
    );
    const mus = hg.map((r) => Number(r.mu_native));
    expect(mus).toHaveLength(2); // calibrated + raw coexist
    expect(mus[0]).toBeCloseTo(21.4, 6); // calibrated center
    expect(mus[1]).toBeCloseTo(21.7, 6); // raw consensus center (the convergence seed's number)
    // sigma is unchanged by the split — only the systematic offset is dropped, the spread stays calibrated.
    expect(hg.every((r) => Number(r.sigma_native) === 1.5)).toBe(true);
  });
});

describe('buildDistributions job (§6.16)', () => {
  it('builds only verified-station, open, ladder-ok events', async () => {
    await seedCityEvent('ulsan', 'ULSN', '2026-06-12', false); // UNVERIFIED → excluded
    const stats = await buildDistributions(ctx(), deps);
    const buildable = await rows(db, `select * from list_buildable_events()`);
    expect(stats['events']).toBe(buildable.length);
    const ulsanRows = await rows(
      db,
      `select 1 from bucket_probabilities bp join market_events me on me.id = bp.event_id
       join cities c on c.id = me.city_id where c.slug = 'ulsan'`,
    );
    expect(ulsanRows.length).toBe(0);
  });
});

describe('DF-2/DF-3: get_build_inputs p_allow_backfill (0031/0033) — opt-in + R-A3 structural guard', () => {
  // The SQL guard (FIX 5, 0033) keys off `current_date`, so target dates are computed RELATIVE to it
  // to stay robust to the wall clock: a PAST target (yesterday) must EXCLUDE backfill rows even with
  // the flag true; a FUTURE target (tomorrow) must INCLUDE them. buildDistributionForEvent's lead
  // check uses deps.now, so for the future-target build we pass a deps.now anchored to that date.
  let pastBfEvent: string; // target = yesterday → backfill must stay excluded under allowBackfill
  let futureBfEvent: string; // target = tomorrow → backfill admitted under allowBackfill
  let tieEvent: string; // target = today, both a live and a backfill row per model → live wins (FIX 6)
  let yday: string;
  let tmrw: string;
  let today: string;

  const dateAdd = async (deltaDays: number): Promise<string> => {
    const [r] = await rows<{ d: string }>(db, `select (current_date + ${deltaDays})::text as d`);
    return r!.d;
  };
  // deps with a now anchored so leadDays(now, target, Asia/Seoul) is in [0, maxLeadDays].
  const depsAt = (now: Date) => ({ notify: async (a: Alert) => (alerts.push(a), true), now });

  beforeAll(async () => {
    yday = await dateAdd(-1);
    tmrw = await dateAdd(1);
    today = await dateAdd(0);

    pastBfEvent = await seedCityEvent('jeju', 'RKPC', yday);
    futureBfEvent = await seedCityEvent('sokcho', 'RKSC', tmrw);
    tieEvent = await seedCityEvent('daejeon', 'RKTU', today);

    // Backfill-only rows for the PAST and FUTURE events (captured recently = the backfill run instant).
    for (const [icao, ev, target] of [['RKPC', pastBfEvent, yday], ['RKSC', futureBfEvent, tmrw]] as const) {
      await db.query(
        `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
          ($1, 'ecmwf_ifs025', $2::date, 1, 21.0, 'backfill', 'backfill_prev_runs', now()),
          ($1, 'gfs_seamless',  $2::date, 1, 22.0, 'backfill', 'backfill_prev_runs', now()),
          ($1, 'icon_seamless', $2::date, 1, 23.0, 'backfill', 'backfill_prev_runs', now())`,
        [icao, target],
      );
      await db.query(
        `insert into ensemble_snapshots (icao, model, target_date, lead_days, snapshot_slot, members_c, n_members, captured_at)
         values ($1, 'ecmwf_ifs025_ens', $2::date, 1, 'backfill',
                 (select array_agg(20 + (i % 5)::numeric) from generate_series(1, 30) i), 30, now())`,
        [icao, target],
      );
      void ev;
    }

    // FIX 6 tie fixture: a LIVE row (older captured_at) AND a backfill row (NEWER captured_at) for the
    // SAME model/target (today). The backfill is more recently RUN, but live must still be chosen.
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
        ('RKTU', 'ecmwf_ifs025', $1::date, 0, 21.0, '10Z',      'forecast_api',       now() - interval '2 hours'),
        ('RKTU', 'ecmwf_ifs025', $1::date, 0, 99.0, 'backfill',  'backfill_prev_runs', now())`,
      [today],
    );
    await db.query(
      `insert into ensemble_snapshots (icao, model, target_date, lead_days, snapshot_slot, members_c, n_members, captured_at) values
        ('RKTU', 'ecmwf_ifs025_ens', $1::date, 0, '10Z',     (select array_agg(20 + (i % 5)::numeric) from generate_series(1,30) i), 30, now() - interval '2 hours'),
        ('RKTU', 'ecmwf_ifs025_ens', $1::date, 0, 'backfill', (select array_agg(80 + (i % 5)::numeric) from generate_series(1,30) i), 30, now())`,
      [today],
    );
  });

  it('default (p_allow_backfill omitted/false) excludes backfill rows — W19 path bit-identical', async () => {
    // Direct RPC, single arg → PostgREST/PGlite resolves the default false.
    const [r0] = await rows<{ get_build_inputs: { forecasts: unknown[]; ensembles: unknown[] } }>(
      db, `select get_build_inputs('${futureBfEvent}'::uuid) as get_build_inputs`,
    );
    expect(r0!.get_build_inputs.forecasts).toEqual([]);
    expect(r0!.get_build_inputs.ensembles).toEqual([]);
    // Explicit false matches.
    const [rFalse] = await rows<{ get_build_inputs: { forecasts: unknown[] } }>(
      db, `select get_build_inputs('${futureBfEvent}'::uuid, false) as get_build_inputs`,
    );
    expect(rFalse!.get_build_inputs.forecasts).toEqual([]);
  });

  it('p_allow_backfill=true on a TODAY/FUTURE target INCLUDES backfill rows (latest-per-model)', async () => {
    const [rTrue] = await rows<{
      get_build_inputs: { forecasts: { model: string; slot: string }[]; ensembles: { model: string }[] };
    }>(db, `select get_build_inputs('${futureBfEvent}'::uuid, true) as get_build_inputs`);
    const fc = rTrue!.get_build_inputs.forecasts;
    expect(fc).toHaveLength(3);
    expect(fc.every((f) => f.slot === 'backfill')).toBe(true);
    expect(rTrue!.get_build_inputs.ensembles).toHaveLength(1);
  });

  it('FIX 5 (R-A3): p_allow_backfill=true on a PAST target_date EXCLUDES backfill rows (no ADR-16 peek)', async () => {
    // The flag is true but target_date < current_date → the structural guard suppresses backfill.
    const [rTrue] = await rows<{ get_build_inputs: { forecasts: unknown[]; ensembles: unknown[] } }>(
      db, `select get_build_inputs('${pastBfEvent}'::uuid, true) as get_build_inputs`,
    );
    expect(rTrue!.get_build_inputs.forecasts).toEqual([]);
    expect(rTrue!.get_build_inputs.ensembles).toEqual([]);
  });

  it('FIX 6: on a tie (live + newer-run backfill for the same model/target), the LIVE row is chosen', async () => {
    const [r] = await rows<{
      get_build_inputs: { forecasts: { model: string; slot: string; tmaxC: number }[]; ensembles: { model: string; members: number[] }[] };
    }>(db, `select get_build_inputs('${tieEvent}'::uuid, true) as get_build_inputs`);
    const fc = r!.get_build_inputs.forecasts;
    expect(fc).toHaveLength(1);
    expect(fc[0]!.slot).toBe('10Z'); // live preferred over the more-recently-run backfill (99.0)
    expect(Number(fc[0]!.tmaxC)).toBe(21.0);
    const ens = r!.get_build_inputs.ensembles;
    expect(ens).toHaveLength(1);
    // The live ensemble members (20-24 band), not the backfill members (80-84 band), are returned.
    expect(Math.max(...ens[0]!.members.map(Number))).toBeLessThan(30);
  });

  it('buildDistributionForEvent forwards allowBackfill on a FUTURE target ⇒ builds; default skips', async () => {
    // deps.now anchored to the eve of the future target so leadDays(now, tmrw, tz) is in range.
    const evening = new Date(`${today}T11:00:00Z`); // ~20:00 Asia/Seoul → tomorrow is lead 1
    const fdeps = depsAt(evening);

    // Default opts → forecasts=[] → nothing written.
    const off = await buildDistributionForEvent(port, cfg, futureBfEvent, fdeps);
    expect(off).toEqual({ written: 0, skipped: 0 });
    expect(await rows(db, `select 1 from bucket_probabilities where event_id = '${futureBfEvent}'`)).toHaveLength(0);

    // allowBackfill:true → backfill rows feed the build → house rows written.
    const on = await buildDistributionForEvent(port, cfg, futureBfEvent, fdeps, { allowBackfill: true });
    expect(on.written).toBeGreaterThanOrEqual(1);
    const hg = await rows(db, `select 1 from bucket_probabilities where event_id = '${futureBfEvent}' and source = 'house_gaussian'`);
    expect(hg).toHaveLength(1);
  });
});
