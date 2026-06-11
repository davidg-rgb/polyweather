/**
 * The UI data layer against PGlite + the REAL engine (§6.21, §15):
 *
 * 1. No-silent-drift: poll-markets (the real §6.17 handler) persists hourly
 *    edge_evaluations; getEventDetail's display recompute through the SAME
 *    core computeBucketEdges over the stored book_top3 must equal the stored
 *    rows field-for-field — and a doctored stored row must be FLAGGED
 *    (the check has teeth).
 * 2. Reliability/heatmap shapers driven through the real dash RPCs against
 *    seeded calibration_scores/model_stats rows.
 * 3. §15 9.9: the /admin goLiveGate readout red→green — every condition
 *    family named while red (wallet key carrying the web caveat), then a
 *    fully green pass; tradingMode restored to 'paper' afterwards.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type RawGammaEvent } from '../../../packages/core/src/index.ts';
import { discoverMarkets } from '../../../supabase/functions/discover-markets/handler.ts';
import { pollMarkets, type PollDeps } from '../../../supabase/functions/poll-markets/handler.ts';
import type { JobCtx } from '../../../supabase/functions/_shared/runJob.ts';
import { freshDb, rows } from '../../../supabase/tests/harness.ts';
import { pglitePort } from '../../../supabase/tests/pglite-port.ts';
import { NUMERIC_TOL } from '../src/lib/edge-display.ts';
import {
  getAdminState,
  getCalibrationView,
  getCityDetail,
  getEventDetail,
  getTodayOverview,
} from '../src/lib/loaders.ts';
import { shapeHeatmap, shapeReliability, heatmapKey } from '../src/lib/shapers.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'research');
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const OPERATOR = 'david.geborek@gmail.com';
const T1 = new Date('2026-06-11T12:03:00Z'); // Seoul 21:03 → lead 0; minute 3 ⇒ hourly audit persists

/** The real Seoul jun-11 event with bids patched onto the three bottom-tail
 *  buckets (live capture had none; values adjusted, SHAPE untouched) —
 *  identical preparation to the poll-markets suite. */
function seoulPage(): RawGammaEvent[] {
  const raw = fixture<RawGammaEvent | RawGammaEvent[]>('gamma-event-temperature-seoul-jun11.json');
  const ev = structuredClone(Array.isArray(raw) ? raw[0]! : raw);
  for (const m of ev.markets) {
    if (m.bestBid == null) m.bestBid = Math.max(0.0005, (m.bestAsk ?? 0.001) / 2);
  }
  return [ev];
}

/** Raw CLOB shape: bids ascend / asks descend — best quote LAST (live-verified). */
const rawBook = (bestAsk: number) => ({
  market: '0xcond', asset_id: 'tok', timestamp: '1749600000000', hash: `bh-${bestAsk}`,
  bids: [{ price: '0.01', size: '5000' }, { price: (bestAsk - 0.02).toFixed(2), size: '1000' }],
  asks: [{ price: (bestAsk + 0.05).toFixed(2), size: '5000' }, { price: bestAsk.toFixed(2), size: '1000' }],
  min_order_size: '5', tick_size: '0.01', neg_risk: true, last_trade_price: bestAsk.toFixed(2),
});

const Q_STRONG = [0.001, 0.001, 0.002, 0.004, 0.015, 0.55, 0.3, 0.08, 0.03, 0.012, 0.005];

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let slug = '';

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
  await db.exec(`select set_config('request.jwt.claims', '{"email":"${OPERATOR}"}', false)`);

  // The real event through discovery, station operator-verified, betting on.
  await discoverMarkets(
    { db: port, config: parseConfigRows(await port.getConfigRows()), log: () => {}, startedAt: new Date('2026-06-11T02:10:00Z') },
    { fetchPage: async (offset) => (offset === 0 ? seoulPage() : []), notify: async () => true, todayUtcISO: '2026-06-11' },
  );
  await db.exec(`
    update cities set tz = 'Asia/Seoul', betting_enabled = true where slug = 'seoul';
    update stations set tz = 'Asia/Seoul';
    update city_stations set verified = true;
    insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, mu_native, sigma_native, stats_version)
    select me.id, 'house_gaussian', 0, false, '2026-06-11T11:00:00Z', 'champ-ui', '{${Q_STRONG.join(',')}}', 22.5, 1.4, 7
    from market_events me where me.poly_event_id = '575039';
  `);
  const [ev] = await rows<{ slug: string }>(db, `select slug from market_events`);
  slug = ev!.slug;

  // ONE real poll-markets tick: snapshots + book attach + rec + hourly edge_evaluations.
  const ctx: JobCtx = { db: port, config: parseConfigRows(await port.getConfigRows()), log: () => {}, startedAt: T1 };
  const deps: PollDeps = {
    fetchPage: async (offset) => (offset === 0 ? seoulPage() : []),
    fetchBook: async () => rawBook(0.27),
    notify: async () => true,
    now: T1,
    runId: crypto.randomUUID(),
  };
  const stats = await pollMarkets(ctx, deps);
  expect(stats).toMatchObject({ recommendationsNew: 1, evaluationsPersisted: 11, booksFetched: 1 });

  // calibration rows for the shaper round trip (two rows ⇒ n-weighted merge),
  // model_stats rows for the heatmap.
  await db.exec(`
    insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market, ece, sharpness, reliability, n_events)
    select c.id, 'house_gaussian', 1, '30d', 0.15, 0.20, 0.03, 0.6,
           '[{"bin":0.5,"hit":0.52,"n":40}]'::jsonb, 40 from cities c where c.slug = 'seoul';
    insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market, ece, sharpness, reliability, n_events)
    select c.id, 'house_gaussian', 0, '30d', 0.14, 0.19, 0.02, 0.7,
           '[{"bin":0.5,"hit":0.6,"n":10},{"bin":0.3,"hit":0.31,"n":20}]'::jsonb, 30 from cities c where c.slug = 'seoul';
    insert into model_stats (icao, model, lead_days, snapshot_slot, bias_c, residual_sigma_c, n_residuals, mse, weight, stats_version)
    values ('RKSI', 'gfs_seamless', 1, '10Z', 0.50, 1.20, 40, 1.44, 0.60000, 7),
           ('RKSI', 'gfs_seamless', 3, '10Z', -0.20, 1.80, 35, 3.24, 0.40000, 7),
           ('RKSI', 'ecmwf_ifs025', 1, '10Z', 0.10, 0.90, 38, 0.81, 0.70000, 7);
  `);
});

afterAll(async () => {
  await db.close();
});

describe('EdgeChart display recompute == stored edge_evaluations (§15 no silent drift)', () => {
  it('the loader recompute reproduces the engine row field-for-field on the booked bucket', async () => {
    const view = (await getEventDetail(port, slug))!;
    expect(view).not.toBeNull();
    const { detail, recomputed, comparison } = view;

    // engine persisted 11 rows at T1's hour
    expect(detail.edgeEvaluations.length).toBe(11);

    // bucket 5 ('22°C') carried the book — exact agreement within numeric(8,6) rounding
    const stored5 = detail.edgeEvaluations.find((e) => e.bucketIdx === 5)!;
    const r5 = recomputed![5]!;
    expect(r5.execAsk).not.toBeNull();
    for (const f of ['q', 'execAsk', 'edge', 'minEdge'] as const) {
      expect(Math.abs(Number(stored5[f]) - (r5[f] as number))).toBeLessThanOrEqual(NUMERIC_TOL);
    }
    expect(stored5.pass).toBe(true);
    expect(r5.pass).toBe(true);

    // the comparison verdict the page renders: 1 comparable bucket, zero drift
    expect(comparison.comparedCount).toBe(1);
    expect(comparison.driftCount).toBe(0);

    // screened buckets carry their honest stored reasons and are not "compared"
    const row6 = comparison.rows.find((r) => r.bucketIdx === 6)!;
    expect(row6.comparable).toBe(false);
    expect(row6.stored!.reasons).toEqual(['screened_out']);

    // §15: the rec's audit JSON is visible on the event payload
    const rec = detail.bets.find((b) => b.status === 'recommended')!;
    expect(rec.audit['kellyC']).toBeDefined();
    expect(rec.audit['bookHash']).toBe('bh-0.27');
  });

  it('a doctored stored row is FLAGGED as drift (the check has teeth)', async () => {
    await db.query(`update edge_evaluations set edge = edge + 0.01 where bucket_idx = 5`);
    try {
      const view = (await getEventDetail(port, slug))!;
      expect(view.comparison.driftCount).toBe(1);
      const row5 = view.comparison.rows.find((r) => r.bucketIdx === 5)!;
      expect(row5.drift).toEqual(['edge']);
    } finally {
      await db.query(`update edge_evaluations set edge = edge - 0.01 where bucket_idx = 5`);
    }
    expect((await getEventDetail(port, slug))!.comparison.driftCount).toBe(0);
  });
});

describe('reliability + heatmap shapers through the real dash RPCs (§15)', () => {
  it('shapeReliability n-weight-merges the stored calibration_scores payloads', async () => {
    const v = await getCalibrationView(port);
    expect(v.champion).toBe('house_gaussian');
    const points = shapeReliability(v.scores.filter((s) => s.source === 'house_gaussian'));
    expect(points).toEqual([
      { x: 0.3, y: 0.31, n: 20 },
      { x: 0.5, y: (0.52 * 40 + 0.6 * 10) / 50, n: 50 },
    ]);
  });

  it('shapeHeatmap grids the stored model_stats rows per slot', async () => {
    const city = (await getCityDetail(port, 'seoul'))!;
    expect(city).not.toBeNull();
    const grid = shapeHeatmap(city.city.calibrationHeatmap, '10Z');
    expect(grid.models).toEqual(['ecmwf_ifs025', 'gfs_seamless']);
    expect(grid.leads).toEqual([1, 3]);
    expect(grid.cells[heatmapKey('gfs_seamless', 1)]).toEqual({ bias: 0.5, sigma: 1.2, n: 40, weight: 0.6 });
    expect(grid.cells[heatmapKey('ecmwf_ifs025', 3)]).toBeUndefined();
    // the §12 city-page overlay: today's open event loaded with distributions
    expect(city.openEvent).not.toBeNull();
    expect(city.openEvent!.detail.houseDist).not.toBeNull();
    // and the overview loader runs end-to-end on the same data
    const overview = await getTodayOverview(port);
    expect(overview.openRecs).toHaveLength(1);
    expect(Number(overview.bankroll)).toBe(1000);
    expect(overview.exposures.byCluster[0]!.key).toBe('east-asia');
  });
});

describe('goLiveGate readout on /admin: red → green (§15 9.9)', () => {
  const NOW = new Date('2026-06-11T12:00:00Z');

  it('red: every failing condition family is named verbatim; the wallet-key row carries the web caveat', async () => {
    await db.exec(`insert into config (key, value) values ('halt:global', 'ui-test') on conflict (key) do update set value = excluded.value`);
    try {
      const v = await getAdminState(port, {
        getEnvVar: () => undefined,
        fetchGeoblock: async () => 'Blocked: US, UK, Sweden, France',
        now: NOW,
      });
      expect(v.goLiveChecklist.pass).toBe(false);
      const texts = v.goLiveChecklist.reasons.map((r) => r.text);
      expect(texts.some((t) => t.includes('missing from execute-bet function secrets'))).toBe(true);
      expect(texts.some((t) => t.includes("tradingMode is 'paper'"))).toBe(true);
      expect(texts.some((t) => t.includes('distinct out-of-sample days'))).toBe(true);
      expect(texts.some((t) => t.includes('pooled 60d calibration row missing'))).toBe(true);
      expect(texts.some((t) => t.includes('halt active: halt:global'))).toBe(true);
      expect(texts.some((t) => t.includes('Sweden appears on the Polymarket blocked list'))).toBe(true);
      expect(texts.some((t) => t.includes('KYC'))).toBe(true);
      expect(texts.some((t) => t.includes('not reconciled within the last 35 days'))).toBe(true);
      // the §8.3 caveat lands exactly on the wallet-key row
      const keyReason = v.goLiveChecklist.reasons.find((r) => r.text.includes('function secrets'))!;
      expect(keyReason.webCaveat).toBe(true);
      expect(v.goLiveChecklist.reasons.filter((r) => r.webCaveat)).toHaveLength(1);
    } finally {
      await db.query(`delete from config where key = 'halt:global'`);
    }
  });

  it('green: with every condition satisfied the readout passes — then tradingMode goes back to paper', async () => {
    // 61 graded out-of-sample days with scored champion rows + the pooled gate row
    await db.exec(`
      insert into market_events (poly_event_id, slug, kind, city_id, target_date, unit, ladder_ok, closed, winning_bucket_idx, first_seen, last_seen)
      select 'gate-' || g, 'gate-ev-' || g, 'highest',
             (select id from cities where slug = 'seoul'),
             date '2026-03-01' + g, 'C', true, true, 5, now(), now()
      from generate_series(1, 61) g;
      insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, brier)
      select id, 'house_gaussian', 1, false, now(), 'gate-' || slug, array[1]::numeric[], 0.10
      from market_events where slug like 'gate-ev-%';
      insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market, bootstrap_p, n_events)
      values ('00000000-0000-0000-0000-000000000000', 'house_gaussian', -1, '60d', 0.18, 0.20, 0.01, 80);
      update config set value = 'live' where key = 'tradingMode';
      insert into config (key, value) values ('kycAttestedAt', '2026-06-01'), ('ledgerReconciledAt', '2026-06-01')
      on conflict (key) do update set value = excluded.value;
    `);
    try {
      const v = await getAdminState(port, {
        getEnvVar: () => 'mock-wallet-key-never-real',
        fetchGeoblock: async () => 'Blocked: US, UK, France, Germany',
        now: NOW,
      });
      expect(v.goLiveChecklist.error).toBeNull();
      expect(v.goLiveChecklist.reasons).toEqual([]);
      expect(v.goLiveChecklist.pass).toBe(true);
    } finally {
      await db.query(`update config set value = 'paper' where key = 'tradingMode'`);
    }
    // the invariant the whole build holds: paper stays paper
    const [mode] = await rows<{ value: string }>(db, `select value from config where key = 'tradingMode'`);
    expect(mode!.value).toBe('paper');
  });
});
