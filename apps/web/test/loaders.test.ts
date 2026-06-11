/**
 * §6.21 loader RPCs (0022) against PGlite + the REAL Seoul fixture, seeded
 * with a full paper cycle (rec → fill → grade) so every page's data shape is
 * exercised with real values: today overview, event detail (ladder + dists +
 * bets with FULL audit JSON + edge evaluations + running max), city detail,
 * calibration, bets ledger (equity curve + deciles), system health, admin
 * state (wuApiKey redaction §11.5) — all behind the is_operator() guard.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type RawGammaEvent } from '../../../packages/core/src/index.ts';
import { discoverMarkets } from '../../../supabase/functions/discover-markets/handler.ts';
import { gradeEvent } from '../../../supabase/functions/_shared/grading.ts';
import { freshDb, rows } from '../../../supabase/tests/harness.ts';
import { pglitePort } from '../../../supabase/tests/pglite-port.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'research');
const fixtureEvent = (name: string): RawGammaEvent => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as RawGammaEvent | RawGammaEvent[];
  return structuredClone(Array.isArray(raw) ? raw[0]! : raw);
};

const OPERATOR = 'david.geborek@gmail.com';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let slug = '';
let eventId = '';

const one = async <T,>(fn: string, args: Record<string, unknown>): Promise<T> => {
  const [r] = await port.rpc<Record<string, T>>(fn, args);
  return r![fn]!;
};

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await db.exec(`select set_config('request.jwt.claims', '{"email":"${OPERATOR}"}', false)`);

  await discoverMarkets(
    { db: port, config: parseConfigRows(await port.getConfigRows()), log: () => {}, startedAt: new Date('2026-06-11T02:10:00Z') },
    {
      fetchPage: async (offset) => (offset === 0 ? [fixtureEvent('gamma-event-temperature-seoul-jun11.json')] : []),
      notify: async () => true,
      todayUtcISO: '2026-06-11',
    },
  );
  const [ev] = await rows<{ id: string; slug: string }>(db, `select id, slug from market_events`);
  eventId = ev!.id;
  slug = ev!.slug;
  const buckets = await rows<{ id: string; label: string }>(
    db, `select id, label from market_buckets where event_id = $1 order by bucket_idx`, [eventId],
  );
  const b22 = buckets.find((b) => b.label === '22°C')!.id;

  // champion + consensus distributions, a market snapshot, edge evaluations,
  // intraday running max, calibration scores, a job run, an alert. RKSI gets
  // coordinates so it counts as ACTIVE for the §6.14 gap matrix.
  await db.exec(`
    update stations set lat = 37.4691, lon = 126.4505 where icao = 'RKSI';
    insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, mu_native, sigma_native)
    values ('${eventId}', 'house_gaussian', 0, false, now(), 'dash-house', array[0.01,0.01,0.01,0.01,0.05,0.55,0.2,0.1,0.03,0.02,0.01]::numeric[], 22.4, 1.3),
           ('${eventId}', 'market_consensus', 0, false, now(), 'dash-mkt', array[0.02,0.02,0.02,0.02,0.07,0.30,0.25,0.15,0.08,0.04,0.03]::numeric[], null, null);
    insert into market_snapshots (bucket_id, best_bid, best_ask, mid, spread, captured_at, book_top3)
    values ('${b22}', 0.25, 0.27, 0.26, 0.02, now(), '{"bids":[{"price":0.25,"size":100}],"asks":[{"price":0.27,"size":500}]}'::jsonb);
    insert into edge_evaluations (event_id, bucket_idx, captured_hour, q, exec_ask, edge, min_edge, pass, reasons)
    values ('${eventId}', 5, date_trunc('hour', now()), 0.55, 0.27, 0.28, 0.0735, true, '{}');
    insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs, last_obs_at)
    select cs.icao, '2026-06-11', 20.3, 20, 14, now() from city_stations cs where cs.valid_to is null;
    insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market, ece, sharpness, reliability, n_events)
    select c.id, 'house_gaussian', 1, '30d', 0.15, 0.20, 0.03, 0.6, '[{"bin":0.5,"hit":0.52,"n":40}]'::jsonb, 40 from cities c where c.slug = 'seoul';
    insert into job_runs (job, period_key, status, started_at, finished_at, duration_ms)
    values ('poll-markets', 'dash:1', 'ok', now(), now(), 1200);
    insert into alerts_log (kind, severity, title, body, sent) values ('BET_REC', 'ACTION', 'test alert', 'b', true);
  `);

  // full paper cycle: rec → fill → grade (winner 22°C, idx 5)
  const [rec] = await port.rpc<{ bet_id: string }>('upsert_recommendation', {
    p_event_id: eventId, p_bucket_id: b22, p_mode: 'paper',
    p_our_q: 0.55, p_best_ask: 0.27, p_exec_ask: 0.27, p_edge: 0.28, p_min_edge: 0.0735,
    p_fee_per_share: 0.00986, p_kelly_raw: 0.08, p_kelly_frac: 0.02, p_capped_frac: 0.018,
    p_stake: 16.2, p_shares: 60, p_audit: { q: 0.55, bookHash: 'bh', kellyC: 0.63 },
    p_dist_row_id: (await rows<{ id: string }>(db, `select id from bucket_probabilities where source = 'house_gaussian'`))[0]!.id,
  });
  await port.rpc('fill_bet_with_caps', { p_bet_id: rec!.bet_id, p_price: 0.27, p_shares: 60 });
  await port.rpc('upsert_observation', { p_icao: 'RKSI', p_date: '2026-06-11', p_tmax: 22, p_unit: 'C', p_n_obs: 30 });
  await port.rpc('finalize_observation', {
    p_icao: 'RKSI', p_date: '2026-06-11',
    p_metar_tenths: null, p_metar_native: null, p_iem_f: null, p_era5_c: null, p_divergence: ['metar-missing'],
  });
  await gradeEvent(port, parseConfigRows(await port.getConfigRows()), eventId, { notify: async () => true });
  // a fresh open rec for the overview
  const b23 = buckets.find((b) => b.label === '23°C')!.id;
  await port.rpc('upsert_recommendation', {
    p_event_id: eventId, p_bucket_id: b23, p_mode: 'paper',
    p_our_q: 0.2, p_best_ask: 0.15, p_exec_ask: 0.15, p_edge: 0.05, p_min_edge: 0.07,
    p_fee_per_share: 0.006, p_kelly_raw: 0.01, p_kelly_frac: 0.0025, p_capped_frac: 0.0025,
    p_stake: 6, p_shares: 40, p_audit: {}, p_dist_row_id: null,
  });
});

afterAll(async () => {
  await db.close();
});

describe('dashboard loader RPCs (0022, §6.21)', () => {
  it('guard: a non-operator jwt is refused on every dash RPC', async () => {
    await db.exec(`select set_config('request.jwt.claims', '{"email":"x@y.z"}', false)`);
    try {
      await expect(port.rpc('dash_today_overview', { p_mode: 'paper', p_champion: 'house_gaussian' })).rejects.toThrow(/ERR_FORBIDDEN/);
      await expect(port.rpc('dash_admin_state', {})).rejects.toThrow(/ERR_FORBIDDEN/);
    } finally {
      await db.exec(`select set_config('request.jwt.claims', '{"email":"${OPERATOR}"}', false)`);
    }
  });

  it('today overview: bankroll, open recs with Kelly math + audit, exposure basis, pnl series, breakers, job health', async () => {
    interface Overview {
      bankroll: number;
      openRecs: { label: string; stake: number; kellyRaw: number; audit: Record<string, unknown> }[];
      openBets: { citySlug: string; cluster: string; stakeUsd: number }[];
      pnlSeries: { balance: number }[];
      breakerStates: unknown[];
      jobHealth: { job: string }[];
    }
    const v = await one<Overview>('dash_today_overview', { p_mode: 'paper', p_champion: 'house_gaussian' });
    // 1000 init − (16.20 + 0.5913 fee) + 60 payout = 1043.21
    expect(Number(v.bankroll)).toBeCloseTo(1043.21, 2);
    expect(v.openRecs).toHaveLength(1);
    expect(v.openRecs[0]).toMatchObject({ label: '23°C' });
    expect(v.openBets).toHaveLength(1); // the open rec; the graded bet left the exposure basis
    expect(v.openBets[0]!.cluster).toBe('east-asia');
    expect(v.pnlSeries.length).toBeGreaterThanOrEqual(3); // init, stake, payout
    expect(v.jobHealth.map((j) => j.job)).toContain('poll-markets');
  });

  it('event detail: ladder + book, house/consensus dists, bets with FULL audit JSON, edge evaluations, running max', async () => {
    interface Detail {
      event: { slug: string; winningBucketIdx: number };
      ladder: { label: string; lastSnapshot: { bestAsk: number; bookTop3: unknown } | null }[];
      houseDist: { probs: number[]; mu: number };
      consensusDist: { probs: number[] };
      bets: { label: string; status: string; audit: Record<string, unknown> }[];
      edgeEvaluations: { bucketIdx: number; pass: boolean }[];
      runningMax: { maxNative: number; nObs: number };
    }
    const v = await one<Detail>('dash_event_detail', { p_slug: slug, p_champion: 'house_gaussian' });
    expect(v.event.winningBucketIdx).toBe(5);
    expect(v.ladder).toHaveLength(11);
    const b22 = v.ladder.find((l) => l.label === '22°C')!;
    expect(Number(b22.lastSnapshot!.bestAsk)).toBe(0.27);
    expect(b22.lastSnapshot!.bookTop3).not.toBeNull();
    expect(Number(v.houseDist.probs[5])).toBeCloseTo(0.55, 6);
    expect(Number(v.houseDist.mu)).toBeCloseTo(22.4, 2);
    // §15: the bet's audit JSON is fully visible — stake derivable from stored values
    const resolved = v.bets.find((b) => b.status === 'resolved_win')!;
    expect(resolved.audit).toMatchObject({ q: 0.55, bookHash: 'bh', kellyC: 0.63 });
    expect(v.edgeEvaluations[0]).toMatchObject({ bucketIdx: 5, pass: true });
    expect(v.runningMax).toMatchObject({ maxNative: 20, nObs: 14 });
  });

  it('city detail: station history, heatmap rows, brier trend, bet history, divergence log', async () => {
    interface City {
      city: { slug: string; region: string };
      stationHistory: { icao: string; verified: boolean }[];
      brierTrend: { brier: number; brierMarket: number }[];
      betHistory: { status: string }[];
      divergenceLog: { flags: string[] }[];
    }
    const v = await one<City>('dash_city_detail', { p_slug: 'seoul', p_champion: 'house_gaussian' });
    expect(v.city.region).toBe('east-asia');
    expect(v.stationHistory.length).toBeGreaterThanOrEqual(1);
    expect(Number(v.brierTrend[0]!.brier)).toBeCloseTo(0.15, 4);
    expect(v.betHistory.map((b) => b.status)).toContain('resolved_win');
    expect(v.divergenceLog[0]!.flags).toContain('metar-missing');
  });

  it('calibration: scores with reliability payloads + the current champion', async () => {
    interface Calib { scores: { city: string | null; reliability: unknown }[]; champion: string }
    const v = await one<Calib>('dash_calibration', { p_champion: 'house_gaussian' });
    expect(v.champion).toBe('house_gaussian');
    expect(v.scores.some((s) => s.city === 'seoul' && s.reliability !== null)).toBe(true);
  });

  it('bets ledger: rows, totals, equity curve from the window view, edge deciles', async () => {
    interface Ledger {
      bets: { status: string; pnl: number | null }[];
      totals: { n: number; wins: number; pnl: number };
      equityCurve: { balance: number }[];
      hitRateByEdgeDecile: { decile: number; n: number; hitRate: number }[];
    }
    const v = await one<Ledger>('dash_bets_ledger', { p_mode: 'paper' });
    expect(Number(v.totals.wins)).toBe(1);
    expect(Number(v.totals.pnl)).toBeCloseTo(60 * 0.73 - 0.5913, 2);
    expect(Number(v.equityCurve.at(-1)!.balance)).toBeCloseTo(1043.21, 2);
    expect(v.hitRateByEdgeDecile).toHaveLength(1);
    expect(Number(v.hitRateByEdgeDecile[0]!.hitRate)).toBe(1);
    // hand-computed: edge 0.28 → width_bucket(0.28, 0, 0.5, 10) = 6; n = 1 resolved bet (W-2)
    expect(Number(v.hitRateByEdgeDecile[0]!.decile)).toBe(6);
    expect(Number(v.hitRateByEdgeDecile[0]!.n)).toBe(1);
  });

  it('system health: job runs, failures, alerts, data gaps (missing cells), storage counts', async () => {
    interface Sys {
      jobRuns: { job: string; status: string }[];
      alertsRecent: { kind: string }[];
      dataGaps: { icao: string; model: string }[];
      storage: { snapshotRows: number };
    }
    const v = await one<Sys>('dash_system_health', {});
    expect(v.jobRuns.some((j) => j.job === 'poll-markets' && j.status === 'ok')).toBe(true);
    expect(v.alertsRecent.some((a) => a.kind === 'BET_REC')).toBe(true);
    expect(v.dataGaps.length).toBeGreaterThan(0); // no forecasts seeded for most cells
    expect(Number(v.storage.snapshotRows)).toBe(1);
  });

  it('admin state: config with wuApiKey REDACTED (§11.5), halts, audit, unverified stations', async () => {
    await port.rpc('set_config_value', { p_key: 'wuApiKey', p_value: 'abcdef0123456789abcdef0123456789' });
    interface Admin {
      config: { key: string; value: string }[];
      unverifiedStations: { city: string; icao: string }[];
      audit: unknown[];
      halts: unknown[];
    }
    const v = await one<Admin>('dash_admin_state', {});
    const wu = v.config.find((c) => c.key === 'wuApiKey')!;
    expect(wu.value).not.toContain('abcdef0123456789');
    expect(wu.value).toContain('redacted');
    expect(v.unverifiedStations.some((s) => s.city === 'seoul')).toBe(true); // discovery left it unverified
    await db.query(`delete from config where key = 'wuApiKey'`);
  });
});
