/**
 * §6.19 support jobs against PGlite + the REAL Seoul/London fixture events:
 * grade-bets sweep (local-midnight+3h gate, missed-grading catch via the real
 * gradeEvent orchestrator, market-resolved-but-no-truth CRITICAL, F-033 live
 * reconciliation against the REAL data-api positions fixture shape),
 * daily-digest (every section from seeded data + the F-036 monthly reminder
 * in live mode only), health-monitor (W7 staleness matrix incl. the 10h
 * discovery threshold, running-young freshness, ADR-12 reaper, ADR-11 resend,
 * dead-man halts, model-stuck WARN, tomorrow-events sanity).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type RawGammaEvent } from '../../packages/core/src/index.ts';
import { discoverMarkets } from '../functions/discover-markets/handler.ts';
import { gradeBetsSweep } from '../functions/grade-bets/handler.ts';
import { dailyDigest } from '../functions/daily-digest/handler.ts';
import { healthMonitor, type HealthDeps } from '../functions/health-monitor/handler.ts';
import { gradeEvent } from '../functions/_shared/grading.ts';
import { resendUnsentAlerts, type Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research');
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
const fixtureEvent = (name: string): RawGammaEvent => {
  const raw = fixture<RawGammaEvent | RawGammaEvent[]>(name);
  return structuredClone(Array.isArray(raw) ? raw[0]! : raw);
};

interface RawPositionFixture {
  asset: string;
  size: number;
  avgPrice: number;
  redeemable: boolean;
  [k: string]: unknown;
}

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let alerts: Alert[] = [];

let seoul: { id: string; distId: string; bucket22: string; bucket23: string };
let london: { id: string; distId: string; bucket: string; token: string };

const notify = async (a: Alert): Promise<boolean> => (alerts.push(a), true);
const ofKind = (kind: string): Alert[] => alerts.filter((a) => a.kind === kind);

const freshCtx = async (now: Date): Promise<JobCtx> => ({
  db: port,
  config: parseConfigRows(await port.getConfigRows()),
  log: () => {},
  startedAt: now,
});

const setConfig = (key: string, value: string) =>
  port.rpc('set_config_value', { p_key: key, p_value: value });

async function makeRec(
  eventId: string, bucketId: string, distId: string,
  shares: number, execAsk: number, mode = 'paper',
): Promise<string> {
  const [r] = await port.rpc<{ bet_id: string; was_insert: boolean }>('upsert_recommendation', {
    p_event_id: eventId, p_bucket_id: bucketId, p_mode: mode,
    p_our_q: 0.55, p_best_ask: execAsk, p_exec_ask: execAsk,
    p_edge: 0.2, p_min_edge: 0.1, p_fee_per_share: 0.01,
    p_kelly_raw: 0.08, p_kelly_frac: 0.02, p_capped_frac: 0.02,
    p_stake: Math.round(shares * execAsk * 100) / 100, p_shares: shares,
    p_audit: {}, p_dist_row_id: distId,
  });
  return r!.bet_id;
}

const sweepDeps = (now: Date, fetchPositions?: () => Promise<unknown>) => ({
  notify,
  gradeEvent: async (eventId: string) =>
    gradeEvent(port, parseConfigRows(await port.getConfigRows()), eventId, { notify }),
  ...(fetchPositions ? { fetchPositions } : {}),
  now,
});

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);

  await discoverMarkets(
    { db: port, config: parseConfigRows(await port.getConfigRows()), log: () => {}, startedAt: new Date('2026-06-11T02:10:00Z') },
    {
      fetchPage: async (offset) =>
        offset === 0
          ? [fixtureEvent('gamma-event-temperature-seoul-jun11.json'), fixtureEvent('gamma-event-temperature-london-jun11.json')]
          : [],
      notify: async () => true,
      todayUtcISO: '2026-06-11',
    },
  );

  const evs = await rows<{ id: string; slug: string }>(db, `select id, slug from market_events order by slug`);
  const seoulEv = evs.find((e) => e.slug.includes('seoul'))!;
  const londonEv = evs.find((e) => e.slug.includes('london'))!;

  // Champion + consensus distributions (11-bucket ladders; winner idx 5 ⇒ probs[6]).
  const probs = (peak: number): string => {
    const p = Array(11).fill((1 - peak) / 10);
    p[5] = peak;
    return `{${p.map((x: number) => x.toFixed(4)).join(',')}}`;
  };
  const dist = async (eventId: string, source: string, peak: number): Promise<string> =>
    (await db.query<{ id: string }>(
      `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
       values ($1::text::uuid, $2, 0, false, now(), $2 || '-' || $1::text, $3::numeric[]) returning id`,
      [eventId, source, probs(peak)],
    )).rows[0]!.id;

  const seoulBuckets = await rows<{ id: string; label: string }>(
    db, `select id, label from market_buckets where event_id = $1 order by bucket_idx`, [seoulEv.id],
  );
  const londonBuckets = await rows<{ id: string; token_yes: string }>(
    db, `select id, token_yes from market_buckets where event_id = $1 order by bucket_idx`, [londonEv.id],
  );

  seoul = {
    id: seoulEv.id,
    distId: await dist(seoulEv.id, 'house_gaussian', 0.55),
    bucket22: seoulBuckets.find((b) => b.label === '22°C')!.id,
    bucket23: seoulBuckets.find((b) => b.label === '23°C')!.id,
  };
  await dist(seoulEv.id, 'market_consensus', 0.3);
  london = {
    id: londonEv.id,
    distId: await dist(londonEv.id, 'house_gaussian', 0.5),
    bucket: londonBuckets[5]!.id,
    token: londonBuckets[5]!.token_yes,
  };

  // Finalized Seoul truth: 22°C ⇒ winner idx 5 ('22°C').
  await port.rpc('upsert_observation', { p_icao: 'RKSI', p_date: '2026-06-11', p_tmax: 22, p_unit: 'C', p_n_obs: 30 });
  await port.rpc('finalize_observation', {
    p_icao: 'RKSI', p_date: '2026-06-11',
    p_metar_tenths: null, p_metar_native: null, p_iem_f: null, p_era5_c: null, p_divergence: [],
  });
});

afterAll(async () => {
  await db.close();
});

describe('grade-bets sweep (§6.19)', () => {
  it('respects the local-midnight+3h grace: nothing graded one hour after Seoul close', async () => {
    alerts = [];
    // Seoul 2026-06-11 ends 15:00Z; +3h grace ⇒ eligible from 18:00Z.
    const stats = await gradeBetsSweep(await freshCtx(new Date('2026-06-11T16:00:00Z')), sweepDeps(new Date('2026-06-11T16:00:00Z')));
    expect(stats).toMatchObject({ candidates: 0, graded: 0 });
    const [ev] = await rows<{ winning_bucket_idx: number | null }>(db, `select winning_bucket_idx from market_events where id = $1`, [seoul.id]);
    expect(ev!.winning_bucket_idx).toBeNull();
  });

  it('grades the missed event through the real gradeEvent path and settles its bet', async () => {
    alerts = [];
    // A filled paper bet on the winning bucket: 60 sh @ 0.27 ($16.20, fee $0.5913).
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 60, 0.27);
    const [fill] = await port.rpc<{ fill_bet_with_caps: { outcome: string } }>('fill_bet_with_caps', {
      p_bet_id: betId, p_price: 0.27, p_shares: 60,
    });
    expect(fill!.fill_bet_with_caps.outcome).toBe('filled');

    const NOW = new Date('2026-06-12T12:00:00Z');
    const stats = await gradeBetsSweep(await freshCtx(NOW), sweepDeps(NOW));
    expect(stats).toMatchObject({ candidates: 2, graded: 1, truthBehindMarket: 0 }); // London past grace too, but truthless+unresolved

    const [ev] = await rows<{ winning_bucket_idx: number }>(db, `select winning_bucket_idx from market_events where id = $1`, [seoul.id]);
    expect(ev!.winning_bucket_idx).toBe(5);
    const [bet] = await rows<{ status: string; pnl_usd: string }>(db, `select status, pnl_usd from bets where id = $1`, [betId]);
    expect(bet!.status).toBe('resolved_win');
    expect(Number(bet!.pnl_usd)).toBeCloseTo(43.21, 2); // 60×0.73 − 0.5913
  });

  it('market resolved but no finalized truth ⇒ CRITICAL TRUTH_BEHIND_MARKET, never graded', async () => {
    alerts = [];
    await db.query(`update market_events set poly_resolved_winner_idx = 3 where id = $1`, [london.id]);
    const NOW = new Date('2026-06-12T12:00:00Z');
    const stats = await gradeBetsSweep(await freshCtx(NOW), sweepDeps(NOW));
    expect(stats).toMatchObject({ candidates: 1, graded: 0, truthBehindMarket: 1 });
    expect(ofKind('TRUTH_BEHIND_MARKET')).toHaveLength(1);
    expect(ofKind('TRUTH_BEHIND_MARKET')[0]!.severity).toBe('CRITICAL');
    const [ev] = await rows<{ winning_bucket_idx: number | null }>(db, `select winning_bucket_idx from market_events where id = $1`, [london.id]);
    expect(ev!.winning_bucket_idx).toBeNull();
  });

  it('paper mode never touches the data-api (F-033 is live-only)', async () => {
    alerts = [];
    let called = 0;
    const NOW = new Date('2026-06-12T12:00:00Z');
    await gradeBetsSweep(await freshCtx(NOW), sweepDeps(NOW, async () => (called++, [])));
    expect(called).toBe(0);
  });

  it('F-033 live reconciliation: clean positions pass; size/redeemable/unknown drifts raise ONE CRITICAL POSITION_DRIFT', async () => {
    await setConfig('tradingMode', 'live');
    try {
      await db.exec(`insert into bankroll_ledger (entry_type, amount_usd, mode) values ('init', 1000, 'live')`);
      const liveBet = await makeRec(london.id, london.bucket, london.distId, 40, 0.3, 'live');
      const [fill] = await port.rpc<{ fill_bet_with_caps: { outcome: string } }>('fill_bet_with_caps', {
        p_bet_id: liveBet, p_price: 0.3, p_shares: 40,
      });
      expect(fill!.fill_bet_with_caps.outcome).toBe('filled');

      // REAL data-api fixture rows — values aligned to the seeded bet, SHAPE untouched.
      const fix = fixture<RawPositionFixture[]>('dataapi-positions-sample.json');
      const clean: RawPositionFixture = { ...fix[0]!, asset: london.token, size: 40, avgPrice: 0.3, redeemable: false };

      alerts = [];
      const NOW = new Date('2026-06-12T12:00:00Z');
      const ok = await gradeBetsSweep(await freshCtx(NOW), sweepDeps(NOW, async () => [clean]));
      expect(ok).toMatchObject({ reconciledBets: 1, drifts: 0 });
      expect(ofKind('POSITION_DRIFT')).toHaveLength(0);

      alerts = [];
      const drifted = await gradeBetsSweep(
        await freshCtx(NOW),
        sweepDeps(NOW, async () => [
          { ...clean, size: 45, redeemable: true }, // size drift + redeemable-but-unresolved
          fix[1]!, // a REAL position matching no live bet ⇒ unknown-position drift
        ]),
      );
      expect(drifted).toMatchObject({ reconciledBets: 1, drifts: 3 });
      const drift = ofKind('POSITION_DRIFT');
      expect(drift).toHaveLength(1);
      expect(drift[0]!.severity).toBe('CRITICAL');
      expect(drift[0]!.body).toContain('size 45 vs recorded 40');
      expect(drift[0]!.body).toContain('redeemable');
      expect(drift[0]!.body).toContain('matches no live bet');
    } finally {
      await setConfig('tradingMode', 'paper');
    }
  });
});

describe('daily-digest (§6.19)', () => {
  it('renders every section from seeded data', async () => {
    alerts = [];
    // Δ24h needs a pre-existing baseline: backdate the init entry.
    await db.query(`update bankroll_ledger set created_at = now() - interval '2 days' where entry_type = 'init' and mode = 'paper'`);
    // An open recommendation, a 30d Brier pair, and an active halt.
    await makeRec(seoul.id, seoul.bucket23, seoul.distId, 40, 0.3);
    await db.query(
      `insert into calibration_scores (city_id, source, lead_days, window_tag, brier, n_events)
       select c.id, s.source, 1, '30d', s.brier, 20
       from cities c, (values ('house_gaussian', 0.15::numeric), ('market_consensus', 0.20::numeric)) s(source, brier)
       where c.slug = 'seoul'`,
    );
    await port.rpc('apply_halt', { p_scope: 'city:seoul', p_reason: 'digest test' });

    const NOW = new Date(); // resolutions window is rolling-24h from real grading time
    const stats = await dailyDigest(await freshCtx(NOW), { notify, now: NOW });
    expect(stats).toMatchObject({ resolutions: 1, openRecs: 1, brierCities: 1, halts: 1, monthlyReminder: false });

    const digest = ofKind('DAILY_DIGEST');
    expect(digest).toHaveLength(1);
    const body = digest[0]!.body;
    expect(body).toContain('*Bankroll (paper)*: $1043.21 (+$43.21 24h)'); // 1000 − 16.79 + 60
    expect(body).toContain('22°C (actual 22°C)');
    expect(body).toContain('our q 55.0% vs market 30.0%');
    expect(body).toContain('WIN $43.21');
    expect(body).toContain('*Open recommendations*: 1 (proposed $12.00)');
    expect(body).toContain('seoul: 0.15 vs 0.2');
    expect(body).toMatch(/decile 5: n=1 hit 100\.0%/);
    expect(body).toContain('*Breakers ACTIVE*: halt:city:seoul');
    expect(body).toContain('*Jobs 24h*: 0 ok / 0 failed');
    expect(body).not.toContain('Monthly reminder');

    await db.query(`delete from config where key = 'halt:city:seoul'`);
  });

  it('appends the F-036 withdrawal reminder only on the first of the month in live mode', async () => {
    await setConfig('tradingMode', 'live');
    try {
      alerts = [];
      const FIRST = new Date('2026-07-01T07:00:00Z');
      const stats = await dailyDigest(await freshCtx(FIRST), { notify, now: FIRST });
      expect(stats).toMatchObject({ monthlyReminder: true });
      expect(ofKind('DAILY_DIGEST')[0]!.body).toContain('Monthly reminder (F-036)');
      expect(ofKind('DAILY_DIGEST')[0]!.body).toContain('ledgerReconciledAt');
    } finally {
      await setConfig('tradingMode', 'paper');
    }
  });
});

describe('health-monitor (§6.19)', () => {
  const hdeps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
    notify,
    postAlert: async () => true,
    fetchModelMeta: async () => Math.floor(Date.now() / 1000) - 3600, // fresh run an hour ago
    now: new Date(),
    ...over,
  });

  it('W7 staleness matrix + running-young rule + reaper + model-stuck + tomorrow sanity (fresh data ⇒ no dead-man)', async () => {
    alerts = [];
    await db.exec(`
      insert into job_runs (job, period_key, status, started_at, finished_at) values
        ('poll-markets',       'pm:1', 'ok',      now() - interval '32 minutes', now() - interval '30 minutes'),
        ('discover-markets',   'dm:1', 'ok',      now() - interval '9 hours 5 minutes', now() - interval '9 hours'),
        ('metar-nowcast',      'mn:1', 'running', now() - interval '1 minute',  null),
        ('fetch-actuals',      'fa:1', 'running', now() - interval '10 minutes', null),
        ('snapshot-forecasts', 'sf:1', 'ok',      now() - interval '10 minutes', now() - interval '9 minutes'),
        ('snapshot-ensembles', 'se:1', 'ok',      now() - interval '10 minutes', now() - interval '9 minutes'),
        ('run-calibration',    'rc:1', 'ok',      now() - interval '2 hours',   now() - interval '2 hours');
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('RKSI', 'ecmwf_ifs025', '2026-06-12', 1, 21.5, '10Z', 'forecast_api', now());
      insert into market_snapshots (bucket_id, best_ask, captured_at)
      select id, 0.3, now() from market_buckets limit 1;
      update cities set betting_enabled = true where slug = 'seoul';
    `);

    const stats = await healthMonitor(await freshCtx(new Date()), hdeps({
      fetchModelMeta: async (slug) =>
        slug === 'ecmwf_ifs025'
          ? Math.floor(Date.now() / 1000) - 30 * 3600 // stuck 30h
          : Math.floor(Date.now() / 1000) - 3600,
    }));

    // poll-markets (30 min > 15) + fetch-actuals (running past wall, no success) are stale;
    // discover-markets at 9h stays quiet (10h threshold, W7); metar-nowcast 'running' young is fresh.
    expect(stats).toMatchObject({ staleJobs: 2, reaped: 1, deadManHalts: 0, modelAnomalies: 1, tomorrowCoverage: 0 });
    const staleTitles = ofKind('JOB_STALE').map((a) => a.title);
    expect(staleTitles).toContain('poll-markets is stale');
    expect(staleTitles).toContain('fetch-actuals is stale');
    expect(staleTitles).not.toContain('discover-markets is stale');
    expect(staleTitles).not.toContain('metar-nowcast is stale');

    // Reaper flipped the stuck run; the period is CAS-retryable again (ADR-12).
    const [reapedRun] = await rows<{ status: string; error: string }>(
      db, `select status, error from job_runs where job = 'fetch-actuals' and period_key = 'fa:1'`,
    );
    expect(reapedRun!.status).toBe('failed');
    expect(reapedRun!.error).toContain('reaped');
    expect(ofKind('JOB_REAPED')).toHaveLength(1);

    expect(ofKind('MODEL_STUCK')).toHaveLength(1);
    expect(ofKind('MODEL_STUCK')[0]!.title).toContain('ecmwf_ifs025');
    expect(ofKind('TOMORROW_COVERAGE')).toHaveLength(1);
    expect(ofKind('DEAD_MAN')).toHaveLength(0);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(0);
  });

  it('dead-man: stale data applies the global halt + CRITICAL (W7 dead-man checks)', async () => {
    alerts = [];
    await db.exec(`delete from forecast_snapshots; delete from market_snapshots;`);
    const stats = await healthMonitor(await freshCtx(new Date()), hdeps());
    expect(stats.deadManHalts).toBe(2); // forecast ≥30h AND price ≥30min (both vacuously infinite)
    expect(ofKind('DEAD_MAN')).toHaveLength(2);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
    await db.query(`delete from config where key = 'halt:global'`);
    await db.query(`delete from config_audit where key = 'halt:global'`);
  });

  it('C3/R-A6 auto-recovery: fresh forecast + SYSTEM halt:global ⇒ clears it + WARN', async () => {
    alerts = [];
    // System dead-man halt persists from a prior stale pass (apply_halt → actor='system').
    await port.rpc('apply_halt', { p_scope: 'global', p_reason: 'dead-man from prior pass' });
    // Forecast freshness recovers (< 30h staleForecastHaltH); a price snapshot too (else the
    // price dead-man re-applies a global halt this pass and recovery is correctly suppressed).
    await db.exec(`
      delete from forecast_snapshots; delete from market_snapshots;
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('RKSI', 'ecmwf_ifs025', '2026-06-12', 1, 21.5, '10Z', 'forecast_api', now());
      insert into market_snapshots (bucket_id, best_ask, captured_at)
      select id, 0.3, now() from market_buckets limit 1;
    `);
    const stats = await healthMonitor(await freshCtx(new Date()), hdeps());
    expect(stats.deadManHalts).toBe(0); // nothing stale this pass
    expect(stats.recoveredHalts).toBe(1);
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(0);
    expect(ofKind('DEAD_MAN_RECOVERED')).toHaveLength(1);
    expect(ofKind('DEAD_MAN_RECOVERED')[0]!.title).toContain('global');
    // Auditing went through clear_system_halt → actor='system-recover'.
    const [aud] = await rows<{ actor: string }>(
      db, `select actor from config_audit where key = 'halt:global' order by created_at desc, id desc limit 1`,
    );
    expect(aud!.actor).toBe('system-recover');
    await db.query(`delete from config_audit where key = 'halt:global'`);
  });

  it('C3/R-A6: does NOT clear while still stale (forecast missing ⇒ halt re-applied, not lifted)', async () => {
    alerts = [];
    await port.rpc('apply_halt', { p_scope: 'global', p_reason: 'dead-man persists' });
    await db.exec(`delete from forecast_snapshots; delete from market_snapshots;`); // age = Infinity
    const stats = await healthMonitor(await freshCtx(new Date()), hdeps());
    expect(stats.recoveredHalts).toBe(0); // still stale ⇒ recovery branch is gated off
    expect(stats.deadManHalts).toBe(2); // forecast + price dead-man re-fire instead
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
    expect(ofKind('DEAD_MAN_RECOVERED')).toHaveLength(0);
    await db.query(`delete from config where key = 'halt:global'`);
    await db.query(`delete from config_audit where key = 'halt:global'`);
  });

  it('C3/R-A6: NEVER clears an OPERATOR halt even when fresh (config_audit.actor=admin-ui)', async () => {
    alerts = [];
    // Operator-authored halt (operator_halt → actor='admin-ui'); set the operator JWT claim.
    await db.exec(
      `select set_config('request.jwt.claims', '${JSON.stringify({ email: 'david.geborek@gmail.com' })}', false)`,
    );
    await db.exec(`select public.operator_halt('global', 'deliberate operator stop')`);
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
    await db.exec(`
      delete from forecast_snapshots; delete from market_snapshots;
      insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
      values ('RKSI', 'ecmwf_ifs025', '2026-06-12', 1, 21.5, '10Z', 'forecast_api', now());
      insert into market_snapshots (bucket_id, best_ask, captured_at)
      select id, 0.3, now() from market_buckets limit 1;
    `);
    const stats = await healthMonitor(await freshCtx(new Date()), hdeps());
    expect(stats.recoveredHalts).toBe(0); // operator halt is never auto-cleared
    expect(await rows(db, `select 1 from config where key = 'halt:global'`)).toHaveLength(1);
    expect(ofKind('DEAD_MAN_RECOVERED')).toHaveLength(0);
    await db.query(`delete from config where key = 'halt:global'`);
    await db.query(`delete from config_audit where key = 'halt:global'`);
  });

  it('ADR-11 resend: delivers unsent alerts older than 10 min and flips sent on 2xx only', async () => {
    await db.exec(`
      insert into alerts_log (kind, severity, title, body, sent, created_at) values
        ('TEST_RESEND', 'WARN', 'old unsent', 'body', false, now() - interval '20 minutes'),
        ('TEST_FRESH',  'WARN', 'too fresh',  'body', false, now() - interval '2 minutes');
    `);
    expect(await resendUnsentAlerts(port, 10, async () => true)).toBe(1);
    const [old] = await rows<{ sent: boolean }>(db, `select sent from alerts_log where kind = 'TEST_RESEND'`);
    expect(old!.sent).toBe(true);
    const [fresh] = await rows<{ sent: boolean }>(db, `select sent from alerts_log where kind = 'TEST_FRESH'`);
    expect(fresh!.sent).toBe(false); // younger than the 10-min window — left for the next sweep

    // A failed post never consumes the row (ADR-11).
    await db.query(`update alerts_log set created_at = now() - interval '20 minutes' where kind = 'TEST_FRESH'`);
    expect(await resendUnsentAlerts(port, 10, async () => false)).toBe(0);
    const [still] = await rows<{ sent: boolean }>(db, `select sent from alerts_log where kind = 'TEST_FRESH'`);
    expect(still!.sent).toBe(false);
  });
});
