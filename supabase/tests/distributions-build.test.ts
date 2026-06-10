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
