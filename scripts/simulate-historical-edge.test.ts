/**
 * §6.22 simulate-historical-edge against PGlite + the REAL June-9 NYC event
 * (ingested by the REAL backfill-market-history with the REAL interval=max
 * captures) + synthetic constant-bias forecasts/observations (§15):
 *
 * - walk-forward μ/σ/Brier hand-derived: constant-bias models fold to exact
 *   bias ⇒ corrected μ == truth ⇒ μ_native == 81°F, σ == floor;
 * - scoring at the ADR-16 cutoffs only (a juicy post-cutoff consensus row is
 *   never selected);
 * - the NO-PEEKING SENTINEL: an outlier observation at D_s changes only the
 *   evals whose stats horizon includes D_s (lead-L of D folds ≤ D−L−2);
 * - lead-0 P&L through the §6.17 pipeline (edges → joint Kelly → caps →
 *   settlement identities, per-trade cap respected);
 * - 'backtest' calibration_scores written over time-matched pairs and
 *   readable through the /calibration loader RPC;
 * - fidelity table + HONEST-FIDELITY NOTE printed; CSV written.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  brierScore,
  fToC,
  gaussianBucketProbs,
  type BucketDef,
  type RawGammaEvent,
} from '../packages/core/src/index.ts';
import { freshDb, rows } from '../supabase/tests/harness.ts';
import { backfillMarketHistory } from './backfill-market-history.ts';
import { simulateHistoricalEdge, type SimReport } from './simulate-historical-edge.ts';
import { listDatesISO, type Db } from './lib/backfill.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'research');
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const OBS_F = 81; // every day's true max — lands in the real event's '80-81°F' bucket (idx 5)
const OBS_C = fToC(OBS_F);
const GFS_C = Math.round((OBS_C + 1.0) * 100) / 100; // numeric(5,2) storage, constant +1°C-ish bias
const ECM_C = Math.round((OBS_C - 0.5) * 100) / 100;
const SIGMA_NATIVE = 0.45 * (9 / 5); // floor σ (°C) × F-conversion: corrected residuals are all 0

let db: PGlite;
let scriptDb: Db;
let realLadder: BucketDef[] = [];

const resolvedEvent = (): RawGammaEvent => {
  const raw = fixture<RawGammaEvent | RawGammaEvent[]>('gamma-event-nyc-jun9-resolved.json');
  return structuredClone(Array.isArray(raw) ? raw[0]! : raw);
};
const winnerToken = (): string => {
  const ev = resolvedEvent();
  const win = ev.markets.find((m) => JSON.parse(m.outcomePrices!)[0] === '1')!;
  return (JSON.parse(win.clobTokenIds!) as string[])[0]!;
};

const run = (over: { from?: string; to?: string; source?: string; out?: string } = {}): Promise<SimReport> =>
  simulateHistoricalEdge(
    { from: over.from ?? '2026-06-01', to: over.to ?? '2026-06-09', source: over.source, out: over.out },
    { db: scriptDb, log: () => {} },
  );

const evalOf = (r: SimReport, date: string, lead: number) =>
  r.evals.find((e) => e.date === date && e.lead === lead && e.citySlug === 'nyc');

beforeAll(async () => {
  db = await freshDb();
  scriptDb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const pgParams = params.map((p) =>
        Array.isArray(p) ? `{${p.map((x) => `"${String(x)}"`).join(',')}}` : p,
      );
      return (await db.query<T>(sql, pgParams)).rows;
    },
  };
  await db.exec(`
    insert into stations (icao, country_code, tz, lat, lon, source)
    values ('KLGA', 'US', 'America/New_York', 40.7769, -73.8740, 'ourairports');
    insert into cities (slug, display_name, country_code, unit, tz, region, betting_enabled, first_seen, last_seen)
    values ('nyc', 'New York City', 'US', 'F', 'America/New_York', 'na-east', false, now(), now());
    insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
    select id, 'KLGA', 'us', now() - interval '60 days', true from cities where slug = 'nyc';
  `);

  // the REAL resolved event + REAL cutoff consensus via the REAL backfill script
  const winnerHist = fixture('clob-prices-history-max-nyc-jun9-winner-80-81f.json');
  const loserHist = fixture('clob-prices-history-max-nyc-jun9-loser-78-79f.json');
  await backfillMarketHistory(
    {},
    {
      db: scriptDb,
      fetchPage: async (offset) => (offset === 0 ? [resolvedEvent()] : []),
      fetchPricesHistory: async (tok) => structuredClone(tok === winnerToken() ? winnerHist : loserHist),
      log: () => {},
      now: () => new Date('2026-06-11T12:00:00Z'),
    },
  );
  const ladderRows = await rows<{ low_native: number | null; high_native: number | null }>(
    db, `select low_native, high_native from market_buckets b
         join market_events e on e.id = b.event_id where e.slug like '%june-9%' order by b.bucket_idx`,
  );
  realLadder = ladderRows.map((b) => ({
    low: b.low_native === null ? null : Number(b.low_native),
    high: b.high_native === null ? null : Number(b.high_native),
    unit: 'F',
  }));

  // constant-bias backfill forecasts (leads 1+2) + finalized obs, 2026-05-25 → 06-09
  for (const d of listDatesISO('2026-05-25', '2026-06-09')) {
    for (const [model, tmax] of [['gfs_seamless', GFS_C], ['ecmwf_ifs025', ECM_C]] as const) {
      for (const lead of [1, 2]) {
        const capturedAt = new Date(Date.parse(`${d}T12:00:00Z`) - lead * 86_400_000).toISOString();
        await db.query(
          `insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at)
           values ('KLGA', $1, $2, $3, $4, 'backfill', 'backfill_prev_runs', $5)`,
          [model, d, lead, tmax, capturedAt],
        );
      }
    }
    await db.query(
      `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provenance, provisional, finalized_at)
       values ('KLGA', $1, $2, 'F', 24, 'wu', false, now())`,
      [d, OBS_F],
    );
  }

  // mini synthetic events June 6–8 (3-bucket ladders) for horizon/sentinel assertions
  for (const d of ['2026-06-06', '2026-06-07', '2026-06-08']) {
    await db.exec(`
      insert into market_events (poly_event_id, slug, kind, city_id, target_date, unit, ladder_ok, closed, first_seen, last_seen)
      select 'mini-${d}', 'mini-nyc-${d}', 'highest', id, '${d}', 'F', true, true, now(), now() from cities where slug = 'nyc';
      insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
      select e.id, x.idx, x.label, x.lo, x.hi, 'c-${d}-' || x.idx, 't-${d}-' || x.idx || 'y', 't-${d}-' || x.idx || 'n'
      from market_events e, (values (0, '79°F or below', null::smallint, 79::smallint),
                                    (1, '80-81°F', 80::smallint, 81::smallint),
                                    (2, '82°F or higher', 82::smallint, null::smallint)) as x(idx, label, lo, hi)
      where e.slug = 'mini-nyc-${d}';
    `);
  }
});

afterAll(async () => {
  await db.close();
});

describe('simulate-historical-edge (§6.22, ADR-16)', () => {
  it('walk-forward μ/σ/Brier match hand-derived values; backtest scores written + readable on /calibration', async () => {
    const r = await run();

    // June 9 lead 0: constant-bias models, fully converged ⇒ corrected μ == truth == 81°F; σ == floor
    const e0 = evalOf(r, '2026-06-09', 0)!;
    expect(e0).toBeDefined();
    expect(e0.muNative).toBeCloseTo(81, 6);
    expect(e0.sigmaNative).toBeCloseTo(SIGMA_NATIVE, 6);
    expect(e0.winnerIdx).toBe(5); // '80-81°F' — the real event's resolved winner bucket
    const expectedProbs = gaussianBucketProbs(81, SIGMA_NATIVE, realLadder);
    e0.probs.forEach((p, i) => expect(p).toBeCloseTo(expectedProbs[i]!, 9));
    expect(e0.brierHouse).toBeCloseTo(brierScore(expectedProbs, 5), 9);

    // time-matched against the REAL backfilled consensus rows at both cutoffs
    const e1 = evalOf(r, '2026-06-09', 1)!;
    expect(e0.matched).toBe(true);
    expect(e1.matched).toBe(true);
    for (const [lead, ev] of [[0, e0], [1, e1]] as const) {
      const cutoff = new Date(Date.parse('2026-06-09T04:00:00Z') - lead * 86_400_000);
      const [cons] = await rows<{ probs: string[]; made_at: Date }>(
        db,
        `select bp.probs, bp.made_at from bucket_probabilities bp
         join market_events e on e.id = bp.event_id and e.slug like '%june-9%'
         where bp.source = 'market_consensus' and bp.made_at <= $1
         order by bp.made_at desc limit 1`,
        [cutoff.toISOString()],
      );
      expect(ev.brierMarket).toBeCloseTo(brierScore(cons!.probs.map(Number), 5), 9);
      expect(new Date(ev.consensusMadeAt!).getTime()).toBeLessThanOrEqual(cutoff.getTime());
    }

    // counters: minis (3 days × 2 leads) + June 9 × 2 = 8 evals; only June 9 has consensus
    expect(r.counters.evalsBuilt).toBe(8);
    expect(r.counters.matchedPairs).toBe(2);
    expect(r.counters.houseOnlyEvals).toBe(6);
    expect(r.counters.polyWinnerMismatches).toBe(0);

    // 'backtest' rows over matched pairs only — readable through the §6.21 loader RPC
    const scores = await rows<{ lead_days: number; brier: string; brier_market: string; n_events: number }>(
      db, `select lead_days, brier, brier_market, n_events from calibration_scores where window_tag = 'backtest' order by lead_days`,
    );
    expect(scores).toHaveLength(2);
    expect(Number(scores[0]!.brier)).toBeCloseTo(e0.brierHouse!, 5);
    expect(Number(scores[0]!.brier_market)).toBeCloseTo(e0.brierMarket!, 5);
    expect(scores[0]!.n_events).toBe(1);
    await db.exec(`select set_config('request.jwt.claims', '{"email":"david.geborek@gmail.com"}', false)`);
    const calib = await db.query<{ dash_calibration: { scores: { window: string }[] } }>(
      `select * from public.dash_calibration('house_gaussian')`,
    );
    expect(calib.rows[0]!.dash_calibration.scores.some((s) => s.window === 'backtest')).toBe(true);
  });

  it('ADR-16 cutoffs only: a juicy post-cutoff consensus row is never selected', async () => {
    const before = evalOf(await run(), '2026-06-09', 0)!;
    await db.exec(`
      insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
      select id, 'market_consensus', 0, false, '2026-06-09T06:00:00Z', 'juicy-post-cutoff',
             array[0,0,0,0,0,1,0,0,0,0,0]::numeric[]
      from market_events where slug like '%june-9%'
    `);
    try {
      const after = evalOf(await run(), '2026-06-09', 0)!;
      expect(after.brierMarket).toBeCloseTo(before.brierMarket!, 9); // still the pre-cutoff row
      expect(new Date(after.consensusMadeAt!).getTime()).toBeLessThanOrEqual(Date.parse('2026-06-09T04:00:00Z'));
    } finally {
      await db.query(`delete from bucket_probabilities where inputs_hash = 'juicy-post-cutoff'`);
    }
  });

  it('NO-PEEKING SENTINEL: an outlier at D_s moves only evals whose horizon includes D_s', async () => {
    const base = await run();
    // sentinel: June 7's true max becomes wildly different
    await db.query(`update observations set tmax_wu_native = 50 where date_local = '2026-06-07'`);
    try {
      const poked = await run();
      // unaffected: horizons before June 7 — lead-0 of June 8 folds ≤ June 6; lead-1 of June 9 folds ≤ June 6
      expect(evalOf(poked, '2026-06-08', 0)!.muNative).toBeCloseTo(evalOf(base, '2026-06-08', 0)!.muNative, 12);
      expect(evalOf(poked, '2026-06-08', 1)!.muNative).toBeCloseTo(evalOf(base, '2026-06-08', 1)!.muNative, 12);
      expect(evalOf(poked, '2026-06-09', 1)!.muNative).toBeCloseTo(evalOf(base, '2026-06-09', 1)!.muNative, 12);
      // affected: lead-0 of June 9 folds ≤ June 7 — the sentinel is in its window
      expect(
        Math.abs(evalOf(poked, '2026-06-09', 0)!.muNative - evalOf(base, '2026-06-09', 0)!.muNative),
      ).toBeGreaterThan(0.05);
      // and June 7's own eval scores against the doctored truth (scoring uses truth at D,
      // independent of the fold horizon)
      expect(evalOf(poked, '2026-06-07', 0)!.winnerIdx).toBe(0); // 50°F → '79°F or below'
    } finally {
      await db.query(`update observations set tmax_wu_native = ${OBS_F} where date_local = '2026-06-07'`);
    }
  });

  it('lead-0 P&L: bets pass the edge bar, settle by identity, respect the per-trade cap', async () => {
    const r = await run();
    expect(r.counters.betsPlaced).toBeGreaterThanOrEqual(1);
    const winBet = r.bets.find((b) => b.bucketIdx === 5 && b.date === '2026-06-09');
    expect(winBet).toBeDefined();
    expect(winBet!.win).toBe(true);
    for (const b of r.bets) {
      // settlement identity: pnl = (win ? sh×(1−p) : −sh×p) − fee
      const expected = (b.win ? b.shares * (1 - b.price) : -b.shares * b.price) - b.fee;
      expect(b.pnl).toBeCloseTo(expected, 9);
      expect(b.stake).toBeLessThanOrEqual(0.02 * 1000 + 1e-9); // per-trade cap, $1000 bankroll
      expect(b.edge).toBeGreaterThan(0);
    }
    const totalPnl = r.bets.reduce((a, b) => a + b.pnl, 0);
    expect(r.finalBankroll).toBeCloseTo(1000 + totalPnl, 2);
    expect(r.equity.at(-1)!.balance).toBeCloseTo(r.finalBankroll, 2);
    const d = r.deciles.find((x) => x.n > 0)!;
    expect(d.hitRate).toBeGreaterThanOrEqual(0);
  });

  it('prints the fidelity table + HONEST-FIDELITY NOTE and writes the CSV', async () => {
    const out = mkdtempSync(join(tmpdir(), 'we-backtest-'));
    const logs: string[] = [];
    try {
      const r = await simulateHistoricalEdge(
        { from: '2026-06-01', to: '2026-06-09', out },
        { db: scriptDb, log: (m) => logs.push(m) },
      );
      const all = logs.join('\n');
      expect(all).toContain('brier(house)');
      expect(all).toMatch(/nyc\s+0\s+1/);
      expect(all).toContain('HONEST-FIDELITY NOTE');
      expect(all).toContain('GATING DIRECTION only');
      expect(r.csvPath).not.toBeNull();
      const csv = readFileSync(r.csvPath!, 'utf8');
      expect(csv).toContain('section,city,lead,n,brier_house,brier_market,ratio');
      expect(csv).toMatch(/fidelity,nyc,0,1,/);
      expect(csv).toContain('section,date,balance');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("refuses 'house_ensemble' with the documented reason (no archived members to replay)", async () => {
    await expect(run({ source: 'house_ensemble' })).rejects.toThrow(/no ensemble members/);
  });
});
