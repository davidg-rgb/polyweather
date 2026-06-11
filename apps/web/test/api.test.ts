/**
 * §8.2 operator API against PGlite + the REAL Seoul fixture event, with the
 * approve proxy wired to the REAL execute-bet handler — the full §9.4 paper
 * cycle (recommendation → approve → fill → grade) runs end-to-end in here.
 * Every route: auth enforcement (401), contract status codes/bodies verbatim,
 * and the 0021 SQL guard as defense-in-depth.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type RawGammaEvent } from '../../../packages/core/src/index.ts';
import { discoverMarkets } from '../../../supabase/functions/discover-markets/handler.ts';
import { executeBet } from '../../../supabase/functions/execute-bet/handler.ts';
import { gradeEvent } from '../../../supabase/functions/_shared/grading.ts';
import { runJob } from '../../../supabase/functions/_shared/runJob.ts';
import { freshDb, rows } from '../../../supabase/tests/harness.ts';
import { pglitePort } from '../../../supabase/tests/pglite-port.ts';
import type { ApiDeps, WebAlert } from '../src/lib/api/deps.ts';
import {
  adminExport,
  adminHalt,
  adminManualBet,
  adminPromoteSource,
  adminResume,
  adminTriggerJob,
  adminUpdateConfig,
  adminVerifyStation,
  approveBet,
  healthCheck,
  skipBet,
} from '../src/lib/api/routes.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'research');
const fixtureEvent = (name: string): RawGammaEvent => {
  const raw = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as RawGammaEvent | RawGammaEvent[];
  return structuredClone(Array.isArray(raw) ? raw[0]! : raw);
};

const OPERATOR = 'david.geborek@gmail.com'; // the 0010-seeded operatorEmail
const SECRET = 'web-api-test-secret-0123456789abcdef-40c';
const NIL = '00000000-0000-0000-0000-0000000000aa';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let alerts: WebAlert[] = [];
let seoul: { id: string; slug: string; distId: string; bucket22: string; bucket23: string };

/** Raw CLOB shape: bids ascend / asks descend — best quote LAST (live-verified). */
const rawBook = (bestAsk: number) => ({
  market: '0xcond', asset_id: 'tok', timestamp: '1749600000000', hash: `bh-${bestAsk}`,
  bids: [{ price: '0.01', size: '5000' }, { price: (bestAsk - 0.02).toFixed(2), size: '1000' }],
  asks: [{ price: (bestAsk + 0.05).toFixed(2), size: '5000' }, { price: bestAsk.toFixed(2), size: '1000' }],
  min_order_size: '5', tick_size: '0.01', neg_risk: true, last_trade_price: bestAsk.toFixed(2),
});

/** The REAL execute-bet handler, PGlite-backed — the proxy target. */
const edgeExecuteBet = (body: unknown): Promise<Response> =>
  executeBet(
    new Request('http://edge/functions/v1/execute-bet', {
      method: 'POST',
      headers: { 'x-cron-secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    {
      db: port,
      fetchBook: async () => rawBook(0.3),
      fetchGeoblock: async () => 'Blocked: US, UK, France',
      getEnvVar: () => undefined,
      notify: async () => true,
      now: () => new Date(),
    },
  );

const deps = (over: Partial<ApiDeps> = {}): ApiDeps => ({
  db: port,
  getSessionEmail: async () => OPERATOR,
  operatorEmail: OPERATOR,
  proxyExecuteBet: (body) => edgeExecuteBet(body),
  proxyTriggerJob: async () => new Response(JSON.stringify({ accepted: true }), { status: 202 }),
  notify: async (a) => (alerts.push(a), true),
  now: () => new Date(),
  ...over,
});

const req = (body: unknown = {}): Request =>
  new Request('http://web/api/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function makeRec(bucketId: string, shares: number, execAsk: number, mode = 'paper'): Promise<string> {
  const [r] = await port.rpc<{ bet_id: string }>('upsert_recommendation', {
    p_event_id: seoul.id, p_bucket_id: bucketId, p_mode: mode,
    p_our_q: 0.55, p_best_ask: execAsk, p_exec_ask: execAsk,
    p_edge: 0.2, p_min_edge: 0.1, p_fee_per_share: 0.01,
    p_kelly_raw: 0.08, p_kelly_frac: 0.02, p_capped_frac: 0.02,
    p_stake: Math.round(shares * execAsk * 100) / 100, p_shares: shares,
    p_audit: {}, p_dist_row_id: seoul.distId,
  });
  return r!.bet_id;
}

beforeAll(async () => {
  process.env['CRON_SECRET'] = SECRET;
  db = await freshDb();
  port = pglitePort(db);
  // SQL-side defense-in-depth: is_operator() reads the jwt email claim.
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
  const buckets = await rows<{ id: string; label: string }>(
    db, `select id, label from market_buckets where event_id = $1 order by bucket_idx`, [ev!.id],
  );
  const dist = await db.query<{ id: string }>(
    `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
     values ($1::text::uuid, 'house_gaussian', 0, false, now(), 'dist-' || $1::text, array[0.01,0.01,0.01,0.01,0.05,0.55,0.2,0.1,0.03,0.02,0.01]::numeric[]) returning id`,
    [ev!.id],
  );
  seoul = {
    id: ev!.id, slug: ev!.slug, distId: dist.rows[0]!.id,
    bucket22: buckets.find((b) => b.label === '22°C')!.id,
    bucket23: buckets.find((b) => b.label === '23°C')!.id,
  };
});

afterAll(async () => {
  delete process.env['CRON_SECRET'];
  await db.close();
});

describe('auth (§8.2 — all routes reject non-operator sessions)', () => {
  it('401 on every route without a session, and with a non-allow-listed email', async () => {
    for (const sessions of [async () => null, async () => 'intruder@example.com'] as const) {
      const d = deps({ getSessionEmail: sessions });
      const responses = await Promise.all([
        approveBet(req(), d, NIL),
        skipBet(req(), d, NIL),
        adminHalt(req(), d),
        adminResume(req(), d),
        adminUpdateConfig(req(), d),
        adminVerifyStation(req(), d),
        adminTriggerJob(req(), d),
        adminPromoteSource(req(), d),
        adminManualBet(req(), d),
        adminExport(req(), d),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: 'ERR_AUTH' });
      }
    }
  });

  it('SQL guard (0021) refuses a non-operator jwt even if a route check were bypassed', async () => {
    await db.exec(`select set_config('request.jwt.claims', '{"email":"intruder@example.com"}', false)`);
    try {
      await expect(port.rpc('operator_skip_bet', { p_bet_id: NIL, p_reason: 'x' })).rejects.toThrow(/ERR_FORBIDDEN/);
    } finally {
      await db.exec(`select set_config('request.jwt.claims', '{"email":"${OPERATOR}"}', false)`);
    }
  });
});

describe('the §9.4 paper cycle: recommendation → approve → fill → grade', () => {
  it('approve relays the execute-bet fill verbatim, then the event grades and the bet resolves', async () => {
    const betId = await makeRec(seoul.bucket22, 60, 0.27);

    const res = await approveBet(req(), deps(), betId);
    expect(res.status).toBe(200);
    // worse-of(0.27 stored, 0.30 live) + 1¢ slippage; 60 sh fits the 2% cap
    expect(await res.json()).toEqual({
      fill: { price: 0.31, shares: 60, feeUsd: 0.6417, mode: 'paper' },
    });

    // re-approve → 409 relayed verbatim
    const again = await approveBet(req(), deps(), betId);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'ERR_BAD_STATUS', status: 'filled' });

    // truth lands → grade → resolved (winner '22°C' = idx 5; fill price 0.31)
    await port.rpc('upsert_observation', { p_icao: 'RKSI', p_date: '2026-06-11', p_tmax: 22, p_unit: 'C', p_n_obs: 30 });
    await port.rpc('finalize_observation', {
      p_icao: 'RKSI', p_date: '2026-06-11',
      p_metar_tenths: null, p_metar_native: null, p_iem_f: null, p_era5_c: null, p_divergence: [],
    });
    const graded = await gradeEvent(port, parseConfigRows(await port.getConfigRows()), seoul.id, { notify: async () => true });
    expect(graded.graded).toBe(true);
    const [bet] = await rows<{ status: string; pnl_usd: string }>(db, `select status, pnl_usd from bets where id = $1`, [betId]);
    expect(bet!.status).toBe('resolved_win');
    expect(Number(bet!.pnl_usd)).toBeCloseTo(60 * (1 - 0.31) - 0.6417, 2);
  });

  it('approve: 404 unknown id (fast pre-check); 503 gate reasons relayed when config is live (C1 upheld)', async () => {
    expect((await approveBet(req(), deps(), NIL)).status).toBe(404);
    expect((await approveBet(req(), deps(), 'not-a-uuid')).status).toBe(404);

    const betId = await makeRec(seoul.bucket23, 40, 0.3);
    await port.rpc('set_config_value', { p_key: 'tradingMode', p_value: 'live' });
    try {
      const res = await approveBet(req(), deps(), betId);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; reasons: string[] };
      expect(body.error).toBe('ERR_GATE_FAILED');
      expect(body.reasons.length).toBeGreaterThan(0);
      const [b] = await rows<{ status: string }>(db, `select status from bets where id = $1`, [betId]);
      expect(b!.status).toBe('recommended'); // never paper-filled
    } finally {
      await port.rpc('set_config_value', { p_key: 'tradingMode', p_value: 'paper' });
    }
  });

  it('skip: 200 + reason note; 409 once skipped; 404 unknown', async () => {
    const [open] = await rows<{ id: string }>(db, `select id from bets where status = 'recommended' limit 1`);
    const res = await skipBet(req({ reason: 'too close to close' }), deps(), open!.id);
    expect(res.status).toBe(200);
    const [b] = await rows<{ status: string; notes: string }>(db, `select status, notes from bets where id = $1`, [open!.id]);
    expect(b).toMatchObject({ status: 'skipped', notes: 'too close to close' });

    expect((await skipBet(req({ reason: 'again' }), deps(), open!.id)).status).toBe(409);
    expect((await skipBet(req({ reason: 'x' }), deps(), NIL)).status).toBe(404);
  });
});

describe('admin routes (§8.2 contracts)', () => {
  it('halt: validation 400s; city_lead key + audit + Slack CRITICAL; resume: confirm mismatch 400, then lifts', async () => {
    alerts = [];
    const bad = await adminHalt(req({ scope: 'city_lead', reason: '' }), deps());
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: string; details: string[] };
    expect(badBody.error).toBe('ERR_VALIDATION');
    expect(badBody.details.length).toBeGreaterThanOrEqual(2); // city + lead + reason

    const ok = await adminHalt(req({ scope: 'city_lead', city: 'seoul', lead: 1, reason: 'manual review' }), deps());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, haltKey: 'halt:city_lead:seoul:1' });
    expect(await rows(db, `select 1 from config where key = 'halt:city_lead:seoul:1'`)).toHaveLength(1);
    const [audit] = await rows<{ actor: string }>(
      db, `select actor from config_audit where key = 'halt:city_lead:seoul:1' order by created_at desc limit 1`,
    );
    expect(audit!.actor).toBe('admin-ui'); // §7.19 actor category
    expect(alerts.filter((a) => a.kind === 'OPERATOR_HALT' && a.severity === 'CRITICAL')).toHaveLength(1);

    const mismatch = await adminResume(req({ haltKey: 'halt:city_lead:seoul:1', confirm: 'nope' }), deps());
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: 'ERR_CONFIRM_MISMATCH' });

    const lifted = await adminResume(req({ haltKey: 'halt:city_lead:seoul:1', confirm: 'halt:city_lead:seoul:1' }), deps());
    expect(lifted.status).toBe(200);
    expect(await rows(db, `select 1 from config where key = 'halt:city_lead:seoul:1'`)).toHaveLength(0);
    expect((await adminResume(req({ haltKey: 'halt:city_lead:seoul:1', confirm: 'halt:city_lead:seoul:1' }), deps())).status).toBe(404);
  });

  it('config: unknown key and bad value rejected with per-key details; applied changes audit; bankroll change WARNs', async () => {
    alerts = [];
    const bad = await adminUpdateConfig(
      req({ changes: [{ key: 'nonsense', value: '1' }, { key: 'kellyFraction', value: 'abc' }] }),
      deps(),
    );
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { details: { key: string; message: string }[] };
    expect(badBody.details.map((d) => d.key).sort()).toEqual(['kellyFraction', 'nonsense']);

    const ok = await adminUpdateConfig(
      req({ changes: [{ key: 'bankrollUsd', value: '1500' }, { key: 'maxSpread', value: '0.06' }] }),
      deps(),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, applied: 2 });
    const [row] = await rows<{ value: string }>(db, `select value from config where key = 'bankrollUsd'`);
    expect(row!.value).toBe('1500');
    expect(await rows(db, `select 1 from config_audit where key = 'maxSpread' and new_value = '0.06'`)).toHaveLength(1);
    expect(alerts.filter((a) => a.kind === 'CONFIG_CHANGE' && a.severity === 'WARN')).toHaveLength(1);

    // restore
    await adminUpdateConfig(req({ changes: [{ key: 'bankrollUsd', value: '1000' }, { key: 'maxSpread', value: '0.05' }] }), deps());
  });

  it('verify-station: sets verified + re-enables betting; superseded row 409; unknown 404', async () => {
    await db.query(`update cities set betting_enabled = false where slug = 'seoul'`);
    const [cs] = await rows<{ id: string }>(db, `select id from city_stations where valid_to is null limit 1`);

    const ok = await adminVerifyStation(req({ cityStationId: cs!.id }), deps());
    expect(ok.status).toBe(200);
    const [verified] = await rows<{ verified: boolean }>(db, `select verified from city_stations where id = $1`, [cs!.id]);
    expect(verified!.verified).toBe(true);
    const [city] = await rows<{ betting_enabled: boolean }>(db, `select betting_enabled from cities where slug = 'seoul'`);
    expect(city!.betting_enabled).toBe(true);

    await db.query(`update city_stations set valid_to = now() where id = $1`, [cs!.id]);
    expect((await adminVerifyStation(req({ cityStationId: cs!.id }), deps())).status).toBe(409);
    await db.query(`update city_stations set valid_to = null where id = $1`, [cs!.id]);
    expect((await adminVerifyStation(req({ cityStationId: NIL }), deps())).status).toBe(404);
  });

  it('trigger-job: unknown 400; manual periodKey flows through the REAL runJob (no slot collision); unreachable 502', async () => {
    expect((await adminTriggerJob(req({ job: 'mystery' }), deps())).status).toBe(400);

    // The proxy target is the REAL runJob honoring the §8.1 body periodKey.
    const ran: string[] = [];
    const viaRunJob = (job: string, periodKey: string): Promise<Response> =>
      runJob(
        job,
        `${job}:derived-slot`,
        new Request('http://edge/x', {
          method: 'POST',
          headers: { 'x-cron-secret': SECRET, 'content-type': 'application/json' },
          body: JSON.stringify({ periodKey }),
        }),
        async () => (ran.push(periodKey), {}),
        { db: port, waitUntil: () => {} },
      );

    const ok = await adminTriggerJob(req({ job: 'poll-markets' }), deps({ proxyTriggerJob: viaRunJob }));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { accepted: boolean; periodKey: string };
    expect(body.accepted).toBe(true);
    expect(body.periodKey).toContain('poll-markets:manual:');
    const runs = await rows<{ period_key: string }>(db, `select period_key from job_runs where job = 'poll-markets'`);
    expect(runs.map((r) => r.period_key)).toContain(body.periodKey); // NOT the derived slot

    const down = await adminTriggerJob(req({ job: 'poll-markets' }), deps({
      proxyTriggerJob: async () => { throw new Error('network down'); },
    }));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: 'ERR_JOB_UNREACHABLE' });
  });

  it('promote-source: ineligible candidate blocked 409 with reasons; eligible candidate flips the champion + audit', async () => {
    const blocked = await adminPromoteSource(req({ source: 'house_ensemble' }), deps());
    expect(blocked.status).toBe(409);
    const blockedBody = (await blocked.json()) as { error: string; reasons: string[] };
    expect(blockedBody.error).toBe('ERR_GATE_FAILED');
    expect(blockedBody.reasons.some((r) => r.includes('out-of-sample days'))).toBe(true);

    // Seed 65 graded events where house_ensemble beats market_consensus by ≥5%.
    await db.exec(`
      insert into market_events (poly_event_id, slug, kind, city_id, target_date, unit, ladder_ok, closed, winning_bucket_idx, resolved_at)
      select 'promo-' || g, 'promo-ev-' || g, 'highest',
             (select id from cities where slug = 'seoul'),
             date '2026-02-01' + g, 'C', true, true, 5, now() - interval '1 day'
      from generate_series(1, 65) g;
      insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, brier, scored_for_leads)
      select me.id, s.source, 1, false, now(), s.source || '-' || me.slug, array[1]::numeric[], s.brier, array[1]::smallint[]
      from market_events me,
           (values ('house_ensemble', 0.10::numeric), ('market_consensus', 0.20::numeric)) s(source, brier)
      where me.slug like 'promo-ev-%';
    `);
    const ok = await adminPromoteSource(req({ source: 'house_ensemble' }), deps());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, champion: 'house_ensemble' });
    const [champ] = await rows<{ value: string }>(db, `select value from config where key = 'championSource'`);
    expect(champ!.value).toBe('house_ensemble');
    expect(await rows(db, `select 1 from config_audit where key = 'championSource' and new_value = 'house_ensemble'`)).toHaveLength(1);

    // already champion → 409
    expect((await adminPromoteSource(req({ source: 'house_ensemble' }), deps())).status).toBe(409);
    await port.rpc('operator_set_champion', { p_source: 'house_gaussian' }); // restore
  });

  it('manual-bet (F-035): validation 400; unknown event 404; paper path proxies the standard fill; open-rec conflict 409; external live fill recorded verbatim', async () => {
    const bad = await adminManualBet(req({ eventSlug: seoul.slug, bucketLabel: '22°C', shares: 1.5, mode: 'paper' }), deps());
    expect(bad.status).toBe(400);

    const missing = await adminManualBet(
      req({ eventSlug: 'no-such-event', bucketLabel: '22°C', shares: 10, price: 0.3, mode: 'paper' }), deps(),
    );
    expect(missing.status).toBe(404);

    const paper = await adminManualBet(
      req({ eventSlug: seoul.slug, bucketLabel: '24°C', shares: 20, price: 0.3, mode: 'paper' }), deps(),
    );
    expect(paper.status).toBe(200);
    const paperBody = (await paper.json()) as { betId: string; fill: { mode: string; shares: number } };
    expect(paperBody.fill.mode).toBe('paper');
    const [filled] = await rows<{ status: string; audit: { manual: boolean } }>(
      db, `select status, audit from bets where id = $1`, [paperBody.betId],
    );
    expect(filled).toMatchObject({ status: 'filled', audit: { manual: true, by: OPERATOR } });

    // an open rec already on the bucket+side → 409
    const recId = await makeRec(seoul.bucket23, 10, 0.3);
    const conflict = await adminManualBet(
      req({ eventSlug: seoul.slug, bucketLabel: '23°C', shares: 10, price: 0.3, mode: 'paper' }), deps(),
    );
    expect(conflict.status).toBe(409);
    await port.rpc('operator_skip_bet', { p_bet_id: recId, p_reason: 'cleanup' });

    // live external fill: recorded verbatim, no executor, ledger entry written
    await db.exec(`insert into bankroll_ledger (entry_type, amount_usd, mode) values ('init', 1000, 'live')
                   on conflict do nothing`);
    const ext = await adminManualBet(
      req({ eventSlug: seoul.slug, bucketLabel: '25°C', shares: 15, price: 0.4, mode: 'live', executedExternally: true }), deps(),
    );
    expect(ext.status).toBe(200);
    const extBody = (await ext.json()) as { betId: string; fill?: unknown };
    expect(extBody.fill).toBeUndefined();
    const [extBet] = await rows<{ status: string; mode: string; executed_price: string }>(
      db, `select status, mode, executed_price from bets where id = $1`, [extBody.betId],
    );
    expect(extBet).toMatchObject({ status: 'filled', mode: 'live' });
    expect(Number(extBet!.executed_price)).toBe(0.4);
  });

  it('export: bad range 400; CSV covers fills AND resolutions with USD amounts (K4-ready)', async () => {
    expect((await adminExport(req({ from: 'nope', to: '2026-06-12' }), deps())).status).toBe(400);
    expect((await adminExport(req({ from: '2026-06-13', to: '2026-06-12' }), deps())).status).toBe(400);

    const today = new Date().toISOString().slice(0, 10);
    const res = await adminExport(req({ from: '2026-06-01', to: today, mode: 'paper' }), deps());
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv');
    const csv = await res.text();
    const lines = csv.split('\n');
    expect(lines[0]).toBe('type,date,event,bucket,side,mode,shares,price,amount_usd,fee_usd,pnl_usd');
    expect(lines.some((l) => l.startsWith('fill,') && l.includes(seoul.slug))).toBe(true);
    expect(lines.some((l) => l.startsWith('resolution,') && l.includes('22°C'))).toBe(true);
    const resolution = lines.find((l) => l.startsWith('resolution,') && l.includes('22°C'))!;
    expect(resolution.split(',').at(-1)).not.toBe(''); // pnl_usd present on resolutions
  });

  it('health: 200 with the newest job run; 503 when the DB is unreachable', async () => {
    const ok = await healthCheck(req(), deps());
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { db: string; newestJobRun: string | null };
    expect(body.db).toBe('ok');
    expect(body.newestJobRun).not.toBeNull(); // trigger-job test recorded a run

    const down = await healthCheck(req(), deps({
      db: { rpc: async () => { throw new Error('db down'); }, getConfigRows: async () => [] },
    }));
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ db: 'down' });
  });
});
