/**
 * run-calibration (§6.18) against PGlite: residual join correctness (one
 * fixture day hand-checked), W3 slot separation, W19 backfill both-slot
 * seeding ×1.15, stats_version + history, time-matched 30/60/90d scores,
 * C7 matched-pair gate stats, pooled zero-UUID bootstrap row, drift +
 * Brier-breaker halts, promotion report, buildDistributions tail-call,
 * weekly nowcast_lift rebuild.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, updateBias } from '../../packages/core/src/index.ts';
import { runCalibration } from '../functions/run-calibration/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx, JobStats } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const NOW = new Date('2026-06-11T11:30:00Z'); // Thursday — weekly rebuild must NOT fire
const SUNDAY = new Date('2026-06-14T11:30:00Z'); // the next Sunday — rebuild fires
const cfg = parseConfigRows([]);
const ZERO = '00000000-0000-0000-0000-000000000000';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let alerts: Alert[] = [];
const deps = (now: Date) => ({ notify: async (a: Alert) => (alerts.push(a), true), now });
const ctx = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });

let run1: JobStats;

/** 10 local dates 2026-06-01..10, observed 20 °C, finalized at date+1 T01:00Z. */
async function seedTruth(icao: string) {
  for (let d = 1; d <= 10; d++) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    const fin = `2026-06-${String(d + 1).padStart(2, '0')}T01:00:00Z`;
    await db.query(
      `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provenance, provisional, finalized_at)
       values ($1, $2, 20, 'C', 24, 'wu', false, $3)`,
      [icao, date, fin],
    );
  }
}

async function seedStation(icao: string) {
  await db.query(
    `insert into stations (icao, country_code, tz, lat, lon, source) values ($1, 'KR', 'Asia/Seoul', 37, 127, 'ourairports')
     on conflict (icao) do nothing`,
    [icao],
  );
}

async function seedCity(slug: string, icao: string) {
  await seedStation(icao);
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'KR', 'C', 'Asia/Seoul', 'east-asia', now(), now()) on conflict (slug) do nothing`,
    [slug],
  );
  await db.query(
    `insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
     select id, $2, 'KR', now(), true from cities where slug = $1 on conflict do nothing`,
    [slug, icao],
  );
}

/** Resolved event (winner idx 0) carrying directly-seeded scored rows. */
async function seedScoredEvent(
  citySlug: string,
  date: string,
  rowsSpec: { source: string; probs: string; brier: number }[],
) {
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx, closed)
     select 'pe-' || $1 || '-' || $2, 'sc-' || $1 || '-' || $2, id, ($2)::date, 'C', true, 0, true
     from cities where slug = $1 returning id`,
    [citySlug, date],
  );
  for (const r of rowsSpec) {
    await db.query(
      `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, scored_for_leads, brier)
       values ($1, $2, 1, false, now(), $3, $4, '{0,1}', $5)`,
      [ev.rows[0]!.id, r.source, `h-${r.source}-${citySlug}-${date}`, r.probs, r.brier],
    );
  }
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);

  // --- stats fixtures ---------------------------------------------------------
  // CALA: model A constant error +1 at 10Z (hand-checkable: bias 1, σ 0), +3 at
  // 22Z (W3 separation); model B alternating error 2/0 at 10Z (σ = √(10/9)).
  await seedStation('CALA');
  await seedTruth('CALA');
  for (let d = 1; d <= 10; d++) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    const bVal = d % 2 === 1 ? 22.0 : 20.0;
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at) values
         ('CALA', 'ecmwf_ifs025', $1, 1, 21.0, '10Z', 'forecast_api', $2),
         ('CALA', 'ecmwf_ifs025', $1, 1, 23.0, '22Z', 'forecast_api', $2),
         ('CALA', 'gfs_seamless', $1, 1, $3, '10Z', 'forecast_api', $2)`,
      [date, `${date}T10:15:00Z`, bVal],
    );
  }

  // CALB: ONLY 'backfill' rows, alternating error 2/0 (W19: both slots, σ ×1.15).
  await seedStation('CALB');
  await seedTruth('CALB');
  for (let d = 1; d <= 10; d++) {
    const date = `2026-06-${String(d).padStart(2, '0')}`;
    const val = d % 2 === 1 ? 22.0 : 20.0;
    await db.query(
      `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
       values ('CALB', 'icon_seamless', $1, 2, $2, 'backfill', 'backfill_prev_runs', $3)`,
      [date, val, `${date}T05:00:00Z`],
    );
  }

  // --- scores fixtures --------------------------------------------------------
  // goodcity: 18 matched events (house 0.05 vs market 0.8 → 36 (event,lead)
  // pairs) + house_ensemble challenger 0.0125 + 3 house-only events (C7).
  await seedCity('goodcity', 'CGUD');
  const matchedDates: string[] = [];
  for (let i = 0; i < 18; i++) {
    const d = new Date('2026-05-25T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    matchedDates.push(d.toISOString().slice(0, 10));
  }
  for (const date of matchedDates) {
    await seedScoredEvent('goodcity', date, [
      { source: 'house_gaussian', probs: '{0.8,0.05,0.05,0.05,0.05}', brier: 0.05 },
      { source: 'house_ensemble', probs: '{0.9,0.025,0.025,0.025,0.025}', brier: 0.0125 },
      { source: 'market_consensus', probs: '{0.2,0.2,0.2,0.2,0.2}', brier: 0.8 },
    ]);
  }
  for (const date of ['2026-05-22', '2026-05-23', '2026-05-24']) {
    await seedScoredEvent('goodcity', date, [
      { source: 'house_gaussian', probs: '{0.8,0.05,0.05,0.05,0.05}', brier: 0.05 },
    ]);
  }

  // buildable OPEN event — proves the buildDistributions tail-call (step 6)
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
     select 'pe-good-open', 'highest-temperature-in-goodcity-x', id, '2026-06-12', 'C', true
     from cities where slug = 'goodcity' returning id`,
  );
  const ladder = [
    [0, '19°C or below', null, 19], [1, '20°C', 20, 20], [2, '21°C', 21, 21],
    [3, '22°C', 22, 22], [4, '23°C or higher', 23, null],
  ] as const;
  for (const [idx, label, low, high] of ladder) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, 'c', 'y', 'n')`,
      [ev.rows[0]!.id, idx, label, low, high],
    );
  }
  await db.exec(`
    insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
    values ('CGUD', 'ecmwf_ifs025', '2026-06-12', 1, 21.0, '10Z', 'forecast_api', '2026-06-11T10:15:00Z')
  `);

  alerts = [];
  run1 = await runCalibration(ctx(NOW), deps(NOW));
});

afterAll(async () => {
  await db.close();
});

describe('runCalibration §6.18 — residuals & stats (W3, W19)', () => {
  it('residual join hand-check: constant +1 error → bias 1.00, σ 0, mse 0, weight ≈ 1', async () => {
    const [r] = await rows<{ bias_c: string; residual_sigma_c: string; n_residuals: number; mse: string; weight: string; window_days: number }>(
      db,
      `select bias_c, residual_sigma_c, n_residuals, mse, weight, window_days from model_stats
       where icao = 'CALA' and model = 'ecmwf_ifs025' and lead_days = 1 and snapshot_slot = '10Z'`,
    );
    expect(Number(r!.bias_c)).toBeCloseTo(1.0, 6);
    expect(Number(r!.residual_sigma_c)).toBeCloseTo(0, 6);
    expect(r!.n_residuals).toBe(10);
    expect(Number(r!.mse)).toBeCloseTo(0, 6);
    expect(Number(r!.weight)).toBeGreaterThan(0.999); // inverse-MSE: near-perfect model dominates
    expect(r!.window_days).toBe(cfg.sigmaWindowDays);
  });

  it('alternating 2/0 error → bias = chronological decay fold, σ = √(10/9), tiny weight', async () => {
    let expected: number | null = null;
    for (let d = 1; d <= 10; d++) expected = updateBias(expected, d % 2 === 1 ? 2 : 0, cfg.biasAlpha);
    const [r] = await rows<{ bias_c: string; residual_sigma_c: string; mse: string; weight: string }>(
      db,
      `select bias_c, residual_sigma_c, mse, weight from model_stats
       where icao = 'CALA' and model = 'gfs_seamless' and lead_days = 1 and snapshot_slot = '10Z'`,
    );
    expect(Number(r!.bias_c)).toBeCloseTo(expected!, 2); // numeric(5,2)
    expect(Number(r!.residual_sigma_c)).toBeCloseTo(Math.sqrt(10 / 9), 2);
    expect(Number(r!.weight)).toBeLessThan(0.001);
  });

  it('W3: 10Z and 22Z stats never pooled — same model, distinct rows, distinct biases', async () => {
    const slots = await rows<{ snapshot_slot: string; bias_c: string }>(
      db,
      `select snapshot_slot, bias_c from model_stats
       where icao = 'CALA' and model = 'ecmwf_ifs025' and lead_days = 1 order by snapshot_slot`,
    );
    expect(slots.map((s) => s.snapshot_slot)).toEqual(['10Z', '22Z']);
    expect(Number(slots[0]!.bias_c)).toBeCloseTo(1.0, 6);
    expect(Number(slots[1]!.bias_c)).toBeCloseTo(3.0, 6);
  });

  it('W19: backfill rows seed BOTH slots with σ widened ×1.15', async () => {
    const slots = await rows<{ snapshot_slot: string; bias_c: string; residual_sigma_c: string; n_residuals: number }>(
      db,
      `select snapshot_slot, bias_c, residual_sigma_c, n_residuals from model_stats
       where icao = 'CALB' and model = 'icon_seamless' and lead_days = 2 order by snapshot_slot`,
    );
    expect(slots.map((s) => s.snapshot_slot)).toEqual(['10Z', '22Z']);
    for (const s of slots) {
      expect(Number(s.residual_sigma_c)).toBeCloseTo(1.15 * Math.sqrt(10 / 9), 2);
      expect(s.n_residuals).toBe(10);
    }
    expect(slots[0]!.bias_c).toBe(slots[1]!.bias_c);
  });

  it("writes the 'blend' σ row §6.16 reads", async () => {
    const blend = await rows<{ residual_sigma_c: string | null; n_residuals: number }>(
      db,
      `select residual_sigma_c, n_residuals from model_stats
       where icao = 'CALA' and model = 'blend' and lead_days = 1 and snapshot_slot = '10Z'`,
    );
    expect(blend.length).toBe(1);
    expect(blend[0]!.n_residuals).toBe(10);
    expect(blend[0]!.residual_sigma_c).not.toBeNull();
  });

  it('stats_version increments per run; history rows written; only stations with new obs refit', async () => {
    expect(run1['residualsAdded']).toBe(10 * 3 + 10 * 2); // CALA 3 groups ×10 + CALB 2 slots ×10
    const [v1] = await rows<{ v: number }>(db, `select max(stats_version)::int as v from model_stats`);
    expect(v1!.v).toBe(1);

    await db.exec(`
      insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provenance, provisional, finalized_at)
      values ('CALA', '2026-06-11', 20, 'C', 24, 'wu', false, '2026-06-12T01:00:00Z');
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('CALA', 'ecmwf_ifs025', '2026-06-11', 1, 21.0, '10Z', 'forecast_api', '2026-06-10T10:15:00Z');
    `);
    const run2 = await runCalibration(ctx(NOW), deps(NOW));
    expect(run2['residualsAdded']).toBe(1);

    const [a] = await rows<{ stats_version: number; n_residuals: number }>(
      db,
      `select stats_version, n_residuals from model_stats
       where icao = 'CALA' and model = 'ecmwf_ifs025' and lead_days = 1 and snapshot_slot = '10Z'`,
    );
    expect(a!.stats_version).toBe(2);
    expect(a!.n_residuals).toBe(11);
    // CALB had no new observations — untouched, still version 1
    const [b] = await rows<{ stats_version: number }>(
      db,
      `select stats_version from model_stats where icao = 'CALB' and model = 'icon_seamless' and snapshot_slot = '10Z'`,
    );
    expect(b!.stats_version).toBe(1);
    // history: one row per version for the refit key
    const hist = await rows<{ stats_version: number }>(
      db,
      `select stats_version from model_stats_history
       where icao = 'CALA' and model = 'ecmwf_ifs025' and lead_days = 1 and snapshot_slot = '10Z' order by stats_version`,
    );
    expect(hist.map((h) => h.stats_version)).toEqual([1, 2]);
  });

  it('cursor: a run with nothing new adds no residuals and bumps nothing', async () => {
    const run3 = await runCalibration(ctx(NOW), deps(NOW));
    expect(run3['residualsAdded']).toBe(0);
    expect(run3['statsUpserted']).toBe(0);
    const [v] = await rows<{ v: number }>(db, `select max(stats_version)::int as v from model_stats`);
    expect(v!.v).toBe(2);
  });
});

describe('runCalibration §6.18 — scores, gates, promotion, tail-call', () => {
  it('30/60/90d windows on ADR-16 scored rows; brier_market over matched pairs only', async () => {
    const score = await rows<{ window_tag: string; brier: string; brier_market: string; n_events: number; ece: string | null; sharpness: string; reliability: unknown }>(
      db,
      `select cs.window_tag, cs.brier, cs.brier_market, cs.n_events, cs.ece, cs.sharpness, cs.reliability
       from calibration_scores cs join cities c on c.id = cs.city_id
       where c.slug = 'goodcity' and cs.source = 'house_gaussian' and cs.lead_days = 1
       order by cs.window_tag`,
    );
    expect(score.map((s) => s.window_tag)).toEqual(['30d', '60d', '90d']);
    for (const s of score) {
      expect(s.n_events).toBe(21); // 18 matched + 3 house-only events
      expect(Number(s.brier)).toBeCloseTo(0.05, 6);
      expect(Number(s.brier_market)).toBeCloseTo(0.8, 6); // mean over the 18 matched ONLY
      expect(Number(s.sharpness)).toBeCloseTo(0.8, 6);
      expect(s.ece).not.toBeNull();
      expect(s.reliability).not.toBeNull();
    }
  });

  it('C7 + C5: pooled zero-UUID row carries time-matched n and a significant bootstrap_p', async () => {
    const pooled = await rows<{ window_tag: string; brier: string; brier_market: string; bootstrap_p: string; n_events: number; lead_days: number }>(
      db,
      `select window_tag, brier, brier_market, bootstrap_p, n_events, lead_days
       from calibration_scores where city_id = '${ZERO}' order by window_tag`,
    );
    expect(pooled.map((p) => p.window_tag)).toEqual(['30d', '60d']);
    for (const p of pooled) {
      expect(p.n_events).toBe(36); // 18 events × 2 leads — house-only events EXCLUDED (C7)
      expect(p.lead_days).toBe(-1); // pooled-across-leads sentinel
      expect(Number(p.brier)).toBeCloseTo(0.05, 6);
      expect(Number(p.brier_market)).toBeCloseTo(0.8, 6);
      expect(Number(p.bootstrap_p)).toBeLessThan(0.05); // champion clearly beats market
    }
  });

  it('healthy city: no drift alert, no halts', async () => {
    expect(alerts.some((a) => a.kind === 'CALIB_DRIFT')).toBe(false);
    const halts = await rows(db, `select 1 from config where key like 'halt:%'`);
    expect(halts.length).toBe(0);
  });

  it('promotion report: challenger ≥5% better on 60d time-matched ⇒ Slack ACTION', async () => {
    expect(run1['promotionCandidates']).toBe(1);
    const promo = alerts.find((a) => a.kind === 'PROMOTION');
    expect(promo).toBeDefined();
    expect(promo!.severity).toBe('ACTION');
    expect(promo!.title).toContain('house_ensemble');
  });

  it('tail-call: buildDistributions ran with the fresh stats (open event got a distribution)', async () => {
    const dist = await rows(
      db,
      `select 1 from bucket_probabilities bp join market_events me on me.id = bp.event_id
       where me.slug = 'highest-temperature-in-goodcity-x' and bp.source = 'house_gaussian'`,
    );
    expect(dist.length).toBeGreaterThanOrEqual(1);
  });
});

describe('intraday advances + weekly nowcast_lift rebuild (§7.8a)', () => {
  it('upsert_intraday logs an advance row only when the max advances', async () => {
    const call = (tenths: number, hour: number) =>
      port.rpc<{ upsert_intraday: boolean }>('upsert_intraday', {
        p_icao: 'CALA', p_date: '2026-06-11', p_max_tenths: tenths,
        p_max_native: Math.round(tenths), p_n_obs: 5, p_local_hour: hour,
      });
    expect((await call(25.0, 10))[0]!.upsert_intraday).toBe(true);
    expect((await call(24.0, 12))[0]!.upsert_intraday).toBe(false); // lower — no advance
    expect((await call(27.0, 12))[0]!.upsert_intraday).toBe(true);
    const adv = await rows<{ local_hour: number; max_tenths_c: string }>(
      db,
      `select local_hour, max_tenths_c from intraday_advances where icao = 'CALA' and date_local = '2026-06-11' order by local_hour`,
    );
    expect(adv.map((a) => [a.local_hour, Number(a.max_tenths_c)])).toEqual([[10, 25], [12, 27]]);
  });

  it('Sunday run rebuilds nowcast_lift from the advances log; old advances pruned', async () => {
    // 12 completed days with advances 20.0@8h → 24.0@11h → 26.0@14h
    for (let i = 0; i < 12; i++) {
      const d = new Date('2026-05-20T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      await db.query(
        `insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values
         ('CALA', $1, 8, 20.0), ('CALA', $1, 11, 24.0), ('CALA', $1, 14, 26.0)`,
        [date],
      );
    }
    // prune target: an ancient advance
    await db.exec(`insert into intraday_advances (icao, date_local, local_hour, max_tenths_c) values ('CALA', '2025-01-01', 9, 15.0)`);

    expect((await rows(db, `select 1 from nowcast_lift`)).length).toBe(0); // Thursday runs never rebuilt

    const sundayRun = await runCalibration(ctx(SUNDAY), deps(SUNDAY));
    expect(Number(sundayRun['liftRowsRebuilt'])).toBeGreaterThan(0);

    const lift = await rows<{ local_hour: number; p50_remaining: string; p90_remaining: string; n: number }>(
      db,
      `select local_hour, p50_remaining, p90_remaining, n from nowcast_lift where icao = 'CALA' order by local_hour`,
    );
    const byHour = new Map(lift.map((l) => [l.local_hour, l]));
    expect(byHour.has(5)).toBe(false); // no advance ≤ 5h on any day
    expect(Number(byHour.get(9)!.p50_remaining)).toBeCloseTo(6.0, 6); // 26 − 20
    expect(Number(byHour.get(12)!.p50_remaining)).toBeCloseTo(2.0, 6); // 26 − 24
    expect(Number(byHour.get(15)!.p50_remaining)).toBeCloseTo(0.0, 6);
    expect(Number(byHour.get(9)!.p90_remaining)).toBeCloseTo(6.0, 6); // identical days → p50 = p90
    expect(byHour.get(9)!.n).toBe(12);

    const ancient = await rows(db, `select 1 from intraday_advances where date_local = '2025-01-01'`);
    expect(ancient.length).toBe(0); // > 180d pruned during rebuild
  });
});

describe('runCalibration §6.18 — drift gate + Brier breaker (synthetic bad champion)', () => {
  let bad: PGlite;
  let badPort: ReturnType<typeof pglitePort>;
  let badAlerts: Alert[];

  beforeAll(async () => {
    bad = await freshDb();
    badPort = pglitePort(bad);
    badAlerts = [];
  });

  afterAll(async () => {
    await bad.close();
  });

  const badCtx = (): JobCtx => ({ db: badPort, config: cfg, log: () => {}, startedAt: NOW });
  const badDeps = { notify: async (a: Alert) => (badAlerts.push(a), true), now: NOW };

  it('empty database: a run is a clean no-op', async () => {
    const stats = await runCalibration(badCtx(), badDeps);
    expect(stats).toMatchObject({ residualsAdded: 0, statsUpserted: 0, scoresUpserted: 0, halts: 0 });
  });

  it('champion ≥ market on 30d AND 60d ⇒ WARN + auto-halt all; city Brier > 0.30 ⇒ city halt', async () => {
    await bad.query(
      `insert into stations (icao, country_code, tz, lat, lon, source) values ('CBAD', 'KR', 'Asia/Seoul', 37, 127, 'ourairports')`,
    );
    await bad.query(
      `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
       values ('badcity', 'badcity', 'KR', 'C', 'Asia/Seoul', 'east-asia', now(), now())`,
    );
    for (let i = 0; i < 18; i++) {
      const d = new Date('2026-05-25T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      const date = d.toISOString().slice(0, 10);
      const ev = await bad.query<{ id: string }>(
        `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx, closed)
         select 'pe-bad-' || $1, 'sc-bad-' || $1, id, ($1)::date, 'C', true, 0, true
         from cities where slug = 'badcity' returning id`,
        [date],
      );
      for (const [source, brier] of [['house_gaussian', 0.9], ['market_consensus', 0.1]] as const) {
        await bad.query(
          `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, scored_for_leads, brier)
           values ($1, $2, 1, false, now(), $3, '{0.2,0.2,0.2,0.2,0.2}', '{0,1}', $4)`,
          [ev.rows[0]!.id, source, `h-${source}-${date}`, brier],
        );
      }
    }

    const stats = await runCalibration(badCtx(), badDeps);
    expect(stats['halts']).toBe(2); // city Brier breaker + global drift halt

    const haltKeys = (await rows<{ key: string }>(bad, `select key from config where key like 'halt:%' order by key`)).map((r) => r.key);
    expect(haltKeys).toEqual(['halt:city:badcity', 'halt:global']);

    const drift = badAlerts.filter((a) => a.kind === 'CALIB_DRIFT');
    expect(drift.some((a) => a.severity === 'WARN')).toBe(true);
    expect(drift.some((a) => a.severity === 'CRITICAL')).toBe(true); // both windows failed → auto-halt
    expect(badAlerts.some((a) => a.kind === 'BREAKER' && a.title.includes('city:badcity'))).toBe(true);
  });
});
