import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import { gradeEvent } from '../functions/_shared/grading.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
const cfg = parseConfigRows([]);

const F_LADDER = [
  { idx: 0, label: '79°F or below', low: null, high: 79 },
  { idx: 1, label: '80-81°F', low: 80, high: 81 },
  { idx: 2, label: '82-83°F', low: 82, high: 83 },
  { idx: 3, label: '84-85°F', low: 84, high: 85 },
  { idx: 4, label: '86°F or higher', low: 86, high: null },
];

async function seedCity(slug: string, tz: string, unit: 'C' | 'F', icao: string, region = 'na-east') {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'US', $2, $3, $4, now(), now())`,
    [slug, unit, tz, region],
  );
  await db.query(
    `insert into stations (icao, country_code, tz, source) values ($1, 'US', $2, 'manual')
     on conflict (icao) do nothing`,
    [icao, tz],
  );
  const city = (await rows<{ id: string }>(db, `select id from cities where slug = '${slug}'`))[0]!;
  await db.query(
    `insert into city_stations (city_id, icao, wu_country_code, valid_from, verified)
     values ($1, $2, 'US', now(), true)`,
    [city.id, icao],
  );
  return city.id;
}

async function seedEvent(
  cityId: string,
  slug: string,
  targetDate: string,
  unit: 'C' | 'F',
  ladder: { idx: number; label: string; low: number | null; high: number | null }[],
) {
  const ev = (
    await db.query<{ id: string }>(
      `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
       values ($1, $2, $3, $4, $5, true) returning id`,
      [`poly-${slug}`, slug, cityId, targetDate, unit],
    )
  ).rows[0]!;
  for (const b of ladder) {
    await db.query(
      `insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, condition_id, token_yes, token_no)
       values ($1, $2, $3, $4, $5, 'cond-${b.idx}', 'ty', 'tn')`,
      [ev.id, b.idx, b.label, b.low, b.high],
    );
  }
  return ev.id;
}

async function seedObservation(icao: string, dateLocal: string, tmax: number, unit: 'C' | 'F') {
  await db.query(
    `insert into observations (icao, date_local, tmax_wu_native, unit, n_obs, provisional, finalized_at)
     values ($1, $2, $3, $4, 30, false, now())`,
    [icao, dateLocal, tmax, unit],
  );
}

async function seedDist(eventId: string, source: string, madeAt: string, probs: number[], nowcast = false) {
  const id = (
    await db.query<{ id: string }>(
      `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
       values ($1, $2, 1, $3, $4, $5, $6) returning id`,
      [eventId, source, nowcast, madeAt, `${source}-${madeAt}-${nowcast}`, `{${probs.join(',')}}`],
    )
  ).rows[0]!;
  return id.id;
}

const BET_DEFAULTS = `our_q, best_ask, exec_ask, edge, min_edge, fee_per_share, kelly_raw, kelly_frac, capped_frac, rec_stake_usd, rec_shares`;
const BET_VALUES = `0.4, 0.3, 0.3, 0.1, 0.07, 0.0105, 0.14, 0.035, 0.02, 12, 40`;

async function seedBet(
  eventId: string,
  bucketIdx: number,
  status: string,
  opts: { shares?: number; price?: number; fee?: number; audit?: object; executedAt?: string } = {},
) {
  const bucket = (
    await db.query<{ id: string }>(
      `select id from market_buckets where event_id = $1 and bucket_idx = $2`,
      [eventId, bucketIdx],
    )
  ).rows[0]!;
  const r = await db.query<{ id: string }>(
    `insert into bets (event_id, bucket_id, status, mode, ${BET_DEFAULTS}, audit,
                       executed_price, executed_fee, executed_size_usd, executed_shares, executed_at)
     values ($1, $2, $3, 'paper', ${BET_VALUES}, $4, $5, $6, $7, $8, $9) returning id`,
    [
      eventId,
      bucket.id,
      status,
      JSON.stringify(opts.audit ?? {}),
      opts.price ?? null,
      opts.fee ?? null,
      opts.price && opts.shares ? opts.price * opts.shares : null,
      opts.shares ?? null,
      opts.executedAt ?? (status === 'recommended' ? null : new Date().toISOString()),
    ],
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});

afterAll(async () => {
  await db.close();
});

describe('gradeEvent (§6.12, ADR-16, C7, W18)', () => {
  let nycEvent: string;
  let r1: string, r2: string, r3: string, n1: string, m1: string;
  const alerts: Alert[] = [];
  const notify = async (a: Alert) => (alerts.push(a), true);

  it('NYC timeline (C7): lead-1 row from the 02:15 creation build, lead-0 from the last pre-midnight build', async () => {
    const cityId = await seedCity('nyc', 'America/New_York', 'F', 'KLGA');
    nycEvent = await seedEvent(cityId, 'highest-temperature-in-nyc-on-june-11-2026', '2026-06-11', 'F', F_LADDER);
    await seedObservation('KLGA', '2026-06-11', 81, 'F');

    // cutoff1 = 2026-06-10T04:00Z, cutoff0 = 2026-06-11T04:00Z (EDT midnight)
    r1 = await seedDist(nycEvent, 'house_gaussian', '2026-06-10T02:15:00Z', [0.1, 0.3, 0.3, 0.2, 0.1]);
    r2 = await seedDist(nycEvent, 'house_gaussian', '2026-06-10T10:50:00Z', [0.08, 0.4, 0.3, 0.17, 0.05]);
    r3 = await seedDist(nycEvent, 'house_gaussian', '2026-06-10T22:50:00Z', [0.05, 0.45, 0.3, 0.15, 0.05]);
    n1 = await seedDist(nycEvent, 'house_gaussian', '2026-06-11T14:00:00Z', [0, 0.8, 0.2, 0, 0], true);
    // W18: market consensus updated once, before BOTH cutoffs — one row carries both leads
    m1 = await seedDist(nycEvent, 'market_consensus', '2026-06-10T03:30:00Z', [0.2, 0.2, 0.2, 0.2, 0.2]);

    await seedBet(nycEvent, 1, 'filled', { shares: 40, price: 0.3, fee: 0.6 }); // winner
    await seedBet(nycEvent, 2, 'filled', { shares: 20, price: 0.25, fee: 0.25 }); // loser
    await seedBet(nycEvent, 3, 'recommended');

    const result = await gradeEvent(port, cfg, nycEvent, { notify });
    expect(result).toEqual({ graded: true, winnerIdx: 1, mismatch: false });

    const leads = new Map(
      (await rows<{ id: string; scored_for_leads: number[]; brier: string | null }>(
        db,
        `select id, scored_for_leads, brier from bucket_probabilities where event_id = '${nycEvent}'`,
      )).map((r) => [r.id, r]),
    );
    expect(leads.get(r1)!.scored_for_leads).toEqual([1]);
    expect(leads.get(r2)!.scored_for_leads).toEqual([]); // superseded by r3 for lead 0
    expect(leads.get(r3)!.scored_for_leads).toEqual([0]);
    expect(Number(leads.get(r3)!.brier)).toBeCloseTo(0.42, 6); // hand-computed
    expect(leads.get(m1)!.scored_for_leads).toEqual([1, 0]); // W18: both leads, one row
    expect(Number(leads.get(m1)!.brier)).toBeCloseTo(0.8, 6); // uniform 5-bucket
    expect(leads.get(n1)!.scored_for_leads).toEqual([]); // nowcast rows never carry leads
    expect(Number(leads.get(n1)!.brier)).toBeCloseTo(0.08, 6); // but get their Brier
  });

  it('settles bets per ADR-09: pnl math, single payout ledger entry, recommended expired', async () => {
    const bets = await rows<{ status: string; pnl_usd: string | null; resolution_native: number | null }>(
      db,
      `select bt.status, bt.pnl_usd, bt.resolution_native from bets bt
       join market_buckets b on b.id = bt.bucket_id
       where bt.event_id = '${nycEvent}' order by b.bucket_idx`,
    );
    expect(bets[0]).toMatchObject({ status: 'resolved_win', pnl_usd: '27.40', resolution_native: 81 });
    expect(bets[1]).toMatchObject({ status: 'resolved_lose', pnl_usd: '-5.25' });
    expect(bets[2]!.status).toBe('expired');

    const payouts = await rows<{ amount_usd: string }>(
      db,
      `select l.amount_usd from bankroll_ledger l join bets bt on bt.id = l.bet_id
       where bt.event_id = '${nycEvent}' and l.entry_type = 'payout'`,
    );
    expect(payouts.length).toBe(1);
    expect(payouts[0]!.amount_usd).toBe('40.00');
  });

  it('emits the deduped RESOLUTION INFO with our q vs market p', () => {
    const resolution = alerts.filter((a) => a.kind === 'RESOLUTION');
    expect(resolution.length).toBe(1);
    expect(resolution[0]!.severity).toBe('INFO');
    expect(resolution[0]!.title).toContain('80-81°F');
    expect(resolution[0]!.body).toContain('our q 0.450'); // r3 winner prob
    expect(resolution[0]!.body).toContain('market p 0.200'); // m1 winner prob
  });

  it('idempotent re-run is a no-op: CAS aborts, no double appends/ledger/briers', async () => {
    const again = await gradeEvent(port, cfg, nycEvent, { notify });
    expect(again).toEqual({ graded: false });

    const [claim] = await port.rpc<{ claim_event_winner: boolean }>('claim_event_winner', {
      p_event_id: nycEvent,
      p_winner_idx: 4,
    });
    expect(claim!.claim_event_winner).toBe(false); // direct CAS predicate proof

    const m1row = (await rows<{ scored_for_leads: number[] }>(
      db,
      `select scored_for_leads from bucket_probabilities where id = '${m1}'`,
    ))[0]!;
    expect(m1row.scored_for_leads).toEqual([1, 0]); // not [1,0,1,0]
    const payouts = await rows(
      db,
      `select 1 from bankroll_ledger l join bets bt on bt.id = l.bet_id
       where bt.event_id = '${nycEvent}' and l.entry_type = 'payout'`,
    );
    expect(payouts.length).toBe(1);
  });

  it('Wellington timeline (C7): UTC+12 cutoffs select the right rows', async () => {
    const cityId = await seedCity('wellington', 'Pacific/Auckland', 'C', 'NZWN', 'oceania');
    const C_LADDER = [
      { idx: 0, label: '9°C or below', low: null, high: 9 },
      { idx: 1, label: '10°C', low: 10, high: 10 },
      { idx: 2, label: '11°C', low: 11, high: 11 },
      { idx: 3, label: '12°C', low: 12, high: 12 },
      { idx: 4, label: '13°C or higher', low: 13, high: null },
    ];
    const ev = await seedEvent(cityId, 'highest-temperature-in-wellington-on-june-12-2026', '2026-06-12', 'C', C_LADDER);
    await seedObservation('NZWN', '2026-06-12', 12, 'C');

    // NZST: local midnight of jun-12 = 2026-06-11T12:00Z; cutoff1 = 2026-06-10T12:00Z
    const w1 = await seedDist(ev, 'house_gaussian', '2026-06-10T04:15:00Z', [0.2, 0.2, 0.2, 0.2, 0.2]);
    const w2 = await seedDist(ev, 'house_gaussian', '2026-06-10T10:50:00Z', [0.1, 0.2, 0.3, 0.3, 0.1]);
    const w3 = await seedDist(ev, 'house_gaussian', '2026-06-11T10:50:00Z', [0.05, 0.15, 0.3, 0.4, 0.1]);

    const result = await gradeEvent(port, cfg, ev, { notify });
    expect(result.graded).toBe(true);
    expect(result.winnerIdx).toBe(3);

    const leads = new Map(
      (await rows<{ id: string; scored_for_leads: number[] }>(
        db,
        `select id, scored_for_leads from bucket_probabilities where event_id = '${ev}'`,
      )).map((r) => [r.id, r.scored_for_leads]),
    );
    expect(leads.get(w1)).toEqual([]); // superseded by w2 for lead 1
    expect(leads.get(w2)).toEqual([1]);
    expect(leads.get(w3)).toEqual([0]);
  });

  it('ungraded paths: no finalized observation / unknown event → graded:false', async () => {
    const cityId = await seedCity('boston', 'America/New_York', 'F', 'KBOS');
    const ev = await seedEvent(cityId, 'highest-temperature-in-boston-on-june-11-2026', '2026-06-11', 'F', F_LADDER);
    expect(await gradeEvent(port, cfg, ev, { notify })).toEqual({ graded: false });
    expect(
      await gradeEvent(port, cfg, '00000000-0000-0000-0000-000000000000', { notify }),
    ).toEqual({ graded: false });
  });

  it('Polymarket-winner mismatch → CRITICAL + grading_mismatch flag', async () => {
    const cityId = await seedCity('chicago', 'America/Chicago', 'F', 'KORD');
    const ev = await seedEvent(cityId, 'highest-temperature-in-chicago-on-june-11-2026', '2026-06-11', 'F', F_LADDER);
    await seedObservation('KORD', '2026-06-11', 83, 'F'); // our winner: idx 2
    await db.query(
      `update market_buckets set resolved_outcome = 'win' where event_id = $1 and bucket_idx = 1`,
      [ev],
    ); // Polymarket says idx 1

    const result = await gradeEvent(port, cfg, ev, { notify });
    expect(result.mismatch).toBe(true);
    expect(result.winnerIdx).toBe(2);

    const flagged = (await rows<{ grading_mismatch: boolean }>(
      db,
      `select grading_mismatch from market_events where id = '${ev}'`,
    ))[0]!;
    expect(flagged.grading_mismatch).toBe(true);
    const critical = alerts.filter((a) => a.kind === 'GRADING_MISMATCH');
    expect(critical.length).toBe(1);
    expect(critical[0]!.severity).toBe('CRITICAL');
  });

  it('8 consecutive losses on a (city, lead) trip the streak breaker → halt + WARN', async () => {
    const cityId = await seedCity('denver', 'America/Denver', 'F', 'KDEN', 'na-west');
    // 8 already-resolved losing bets at lead 1 on prior events
    for (let d = 1; d <= 8; d++) {
      const ev = await seedEvent(cityId, `highest-temperature-in-denver-on-june-${d}-2026`, `2026-06-0${d > 9 ? d : `${d}`.padStart(1, '0')}`.slice(0, 10), 'F', F_LADDER);
      const bet = await seedBet(ev, 2, 'filled', {
        shares: 10, price: 0.3, fee: 0.1,
        audit: { leadDays: 1 },
        executedAt: `2026-06-0${d}T12:00:00Z`,
      });
      await db.query(`update bets set status = 'resolved_lose', pnl_usd = -3 where id = $1`, [bet]);
      await db.query(`update market_events set winning_bucket_idx = 0, resolved_at = now() where id = $1`, [ev]);
    }
    // the 9th event resolves now and triggers the breaker evaluation
    const ev9 = await seedEvent(cityId, 'highest-temperature-in-denver-on-june-11-2026', '2026-06-11', 'F', F_LADDER);
    await seedObservation('KDEN', '2026-06-11', 75, 'F');

    const result = await gradeEvent(port, cfg, ev9, { notify });
    expect(result.graded).toBe(true);

    const halt = await rows<{ value: string }>(db, `select value from config where key = 'halt:city_lead:denver:1'`);
    expect(halt.length).toBe(1);
    expect(halt[0]!.value).toContain('8 consecutive losses');
    const audit = await rows(db, `select 1 from config_audit where key = 'halt:city_lead:denver:1' and actor = 'system'`);
    expect(audit.length).toBe(1);
    expect(alerts.some((a) => a.kind === 'BREAKER' && a.title.includes('denver'))).toBe(true);
  });
});
