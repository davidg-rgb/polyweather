/**
 * poll-markets (§6.17) against PGlite + the REAL Seoul fixture event:
 * C8 lease semantics, delta-dedupe + tiered heartbeat snapshots, consensus
 * dedupe-by-hash, screen-then-book economy, fee-adjusted joint Kelly sizing
 * (W4) with full audit object, refresh-without-spam (>1¢ move, <20% stake),
 * ADR-09 CAS expiry (edge_collapsed + too_close), stale-champion skip,
 * hourly edge_evaluations (F-038), ADR-17 position watch, W13 page warning.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows, type RawGammaEvent } from '../../packages/core/src/index.ts';
import { discoverMarkets } from '../functions/discover-markets/handler.ts';
import { pollMarkets, type PollDeps } from '../functions/poll-markets/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research');
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const cfg = parseConfigRows([]);

let db: PGlite;
let port: ReturnType<typeof pglitePort>;
let alerts: Alert[] = [];

/** The real Seoul jun-11 event, with bids patched onto the three bottom-tail
 *  buckets (live capture had none — >2 missing mids would void the consensus
 *  benchmark; values adjusted, SHAPE untouched). */
function seoulPage(overrides?: { ask22?: number; bid22?: number; spread22?: number }): RawGammaEvent[] {
  const raw = fixture<RawGammaEvent | RawGammaEvent[]>('gamma-event-temperature-seoul-jun11.json');
  const ev = structuredClone(Array.isArray(raw) ? raw[0]! : raw);
  for (const m of ev.markets) {
    if (m.bestBid == null) m.bestBid = Math.max(0.0005, (m.bestAsk ?? 0.001) / 2);
    if (m.groupItemTitle === '22°C' && overrides) {
      m.bestAsk = overrides.ask22 ?? m.bestAsk;
      m.bestBid = overrides.bid22 ?? m.bestBid;
      m.spread = overrides.spread22 ?? m.spread;
    }
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

const ctx = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });
const deps = (now: Date, page: RawGammaEvent[], bookAsk: number, runId: string = crypto.randomUUID()): PollDeps => ({
  fetchPage: async (offset) => (offset === 0 ? page : []),
  fetchBook: async () => rawBook(bookAsk),
  notify: async (a) => (alerts.push(a), true),
  now,
  runId,
});

/** probs aligned to the 11-bucket ladder (idx 5 = '22°C', idx 6 = '23°C'). */
async function setChampion(probs: number[], madeAt: string): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, mu_native, sigma_native, stats_version)
     select me.id, 'house_gaussian', 0, false, $1::timestamptz, 'champ-' || $2::text, $3, 22.5, 1.4, 7
     from market_events me where me.poly_event_id = '575039' returning id`,
    [madeAt, madeAt, `{${probs.join(',')}}`],
  );
  return r.rows[0]!.id;
}

const Q_STRONG = [0.001, 0.001, 0.002, 0.004, 0.015, 0.55, 0.3, 0.08, 0.03, 0.012, 0.005];
const Q_COLLAPSED = [0.001, 0.001, 0.002, 0.004, 0.015, 0.1, 0.3, 0.53, 0.03, 0.012, 0.005];
const Q_WATCH = [0.001, 0.001, 0.002, 0.004, 0.015, 0.55, 0.1, 0.28, 0.03, 0.012, 0.005];

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);

  // Ingest the REAL event through discovery, then operator-verify the station.
  await discoverMarkets(ctx(new Date('2026-06-11T02:10:00Z')), {
    fetchPage: async (offset) => (offset === 0 ? seoulPage() : []),
    notify: async () => true,
    todayUtcISO: '2026-06-11',
  });
  await db.exec(`
    update cities set tz = 'Asia/Seoul', betting_enabled = true where slug = 'seoul';
    update stations set tz = 'Asia/Seoul';
    update city_stations set verified = true;
  `);
  await setChampion(Q_STRONG, '2026-06-11T11:00:00Z');
});

afterAll(async () => {
  await db.close();
});

describe('poll-markets lease (C8, §7.17a)', () => {
  it('single-CAS claim; second claim loses; wrong-holder release is a no-op; handler exits overlapped', async () => {
    expect((await port.rpc<{ claim_poll_lease: boolean }>('claim_poll_lease', { p_holder: 'a', p_wall_sec: 150 }))[0]!.claim_poll_lease).toBe(true);
    expect((await port.rpc<{ claim_poll_lease: boolean }>('claim_poll_lease', { p_holder: 'b', p_wall_sec: 150 }))[0]!.claim_poll_lease).toBe(false);

    const r = await pollMarkets(ctx(new Date('2026-06-11T12:00:00Z')), deps(new Date('2026-06-11T12:00:00Z'), seoulPage(), 0.27, 'c'));
    expect(r).toEqual({ overlapped: true });

    await port.rpc('release_poll_lease', { p_holder: 'WRONG' });
    expect((await port.rpc<{ claim_poll_lease: boolean }>('claim_poll_lease', { p_holder: 'b', p_wall_sec: 150 }))[0]!.claim_poll_lease).toBe(false);
    await port.rpc('release_poll_lease', { p_holder: 'a' });
    expect((await port.rpc<{ claim_poll_lease: boolean }>('claim_poll_lease', { p_holder: 'b', p_wall_sec: 150 }))[0]!.claim_poll_lease).toBe(true);
    await port.rpc('release_poll_lease', { p_holder: 'b' });
  });
});

describe('poll-markets pipeline (§6.17)', () => {
  it('tick 1: snapshots + consensus + screen-then-book + Kelly-sized recommendation with full audit', async () => {
    alerts = [];
    const T1 = new Date('2026-06-11T12:03:00Z'); // Seoul 21:03 → lead 0; minute 3 → hourly audit fires
    const stats = await pollMarkets(ctx(T1), deps(T1, seoulPage(), 0.27));

    expect(stats).toMatchObject({
      events: 1, pages: 1, snapshotsWritten: 11, booksFetched: 1,
      recommendationsNew: 1, refreshed: 0, expired: 0, evaluationsPersisted: 11,
    });

    // consensus row (lead 0, probs Σ=1)
    const cons = await rows<{ probs: number[]; lead_days: number }>(
      db, `select probs, lead_days from bucket_probabilities where source = 'market_consensus'`,
    );
    expect(cons.length).toBe(1);
    expect(cons[0]!.lead_days).toBe(0);
    expect(Math.abs(cons[0]!.probs.reduce((a, b) => a + Number(b), 0) - 1)).toBeLessThan(1e-6);

    // book top-3 attached to the 22°C bucket's latest snapshot
    const attached = await rows(
      db,
      `select 1 from market_snapshots ms join market_buckets b on b.id = ms.bucket_id
       where b.label = '22°C' and ms.book_top3 is not null`,
    );
    expect(attached.length).toBe(1);

    // the recommendation: q .55 vs execAsk .27 → kelly c=.45/.710145, capped at 2% → 74 shares
    const [bet] = await rows<{
      status: string; mode: string; our_q: string; exec_ask: string; rec_stake_usd: string;
      rec_shares: string; kelly_raw: string; capped_frac: string; audit: Record<string, unknown>;
    }>(db, `select status, mode, our_q, exec_ask, rec_stake_usd, rec_shares, kelly_raw, capped_frac, audit from bets`);
    expect(bet).toMatchObject({ status: 'recommended', mode: 'paper' });
    expect(Number(bet!.our_q)).toBeCloseTo(0.55, 6);
    expect(Number(bet!.exec_ask)).toBeCloseTo(0.27, 6);
    expect(Number(bet!.kelly_raw)).toBeCloseTo(0.366326, 4);
    expect(Number(bet!.rec_stake_usd)).toBeCloseTo(19.98, 2);
    expect(Number(bet!.rec_shares)).toBe(74);
    expect(Number(bet!.capped_frac)).toBeCloseTo(0.01998, 5);
    const audit = bet!.audit;
    expect(audit['bookHash']).toBe('bh-0.27');
    expect(audit['kellyC']).toBeCloseTo(0.633673, 4);
    expect(Array.isArray(audit['capAudit'])).toBe(true);
    expect((audit['capAudit'] as string[]).some((s) => s.includes('per-trade cap'))).toBe(true);
    expect((audit['config'] as Record<string, number>)['bankrollUsd']).toBe(1000);
    expect(audit['distRowId']).toBeTruthy();

    expect(alerts.filter((a) => a.kind === 'BET_REC' && a.severity === 'ACTION').length).toBe(1);

    // hourly audit: 11 rows, the screened bucket passing, the rest with honest reasons
    const evals = await rows<{ bucket_idx: number; pass: boolean; reasons: string[] }>(
      db, `select bucket_idx, pass, reasons from edge_evaluations order by bucket_idx`,
    );
    expect(evals.length).toBe(11);
    expect(evals[5]).toMatchObject({ pass: true, reasons: [] });
    expect(evals[6]!.reasons).toEqual(['screened_out']);
  });

  it('tick 2 (1 min later, unmoved): delta-dedupe writes nothing, consensus deduped, rec untouched', async () => {
    const T2 = new Date('2026-06-11T12:04:00Z');
    const stats = await pollMarkets(ctx(T2), deps(T2, seoulPage(), 0.27));
    expect(stats).toMatchObject({ snapshotsWritten: 0, recommendationsNew: 0, refreshed: 0, evaluationsPersisted: 0 });
    expect((await rows(db, `select 1 from bucket_probabilities where source = 'market_consensus'`)).length).toBe(1);
  });

  it('tick 3 (price moved >1¢): single snapshot, rec refreshed, NO re-notify under 20% stake change', async () => {
    const before = alerts.filter((a) => a.kind === 'BET_REC').length;
    const T3 = new Date('2026-06-11T12:10:00Z');
    const stats = await pollMarkets(ctx(T3), deps(T3, seoulPage({ ask22: 0.30, bid22: 0.26, spread22: 0.04 }), 0.30));
    expect(stats).toMatchObject({ snapshotsWritten: 1, recommendationsNew: 0, refreshed: 1 });

    const [bet] = await rows<{ exec_ask: string; rec_shares: string; rec_stake_usd: string; status: string }>(
      db, `select exec_ask, rec_shares, rec_stake_usd, status from bets where status = 'recommended'`,
    );
    expect(Number(bet!.exec_ask)).toBeCloseTo(0.30, 6);
    expect(Number(bet!.rec_shares)).toBe(66); // floor(20 / 0.30)
    expect(Number(bet!.rec_stake_usd)).toBeCloseTo(19.8, 2);
    expect(alerts.filter((a) => a.kind === 'BET_REC').length).toBe(before); // 0.9% stake change < 20%

    expect((await rows(db, `select 1 from bucket_probabilities where source = 'market_consensus'`)).length).toBe(2); // new mids → new hash
  });

  it('tick 4 (37 min after tick 1, unmoved): the candidate-tier 30-min heartbeat rewrites all buckets', async () => {
    const T4 = new Date('2026-06-11T12:40:00Z');
    const stats = await pollMarkets(ctx(T4), deps(T4, seoulPage({ ask22: 0.30, bid22: 0.26, spread22: 0.04 }), 0.30));
    expect(stats).toMatchObject({ snapshotsWritten: 11 });
  });

  it('champion q collapse: open-rec bucket is force-evaluated and the rec expires via ADR-09 CAS', async () => {
    await setChampion(Q_COLLAPSED, '2026-06-11T11:30:00Z'); // becomes the latest champion row
    const T5 = new Date('2026-06-11T12:45:00Z');
    const stats = await pollMarkets(ctx(T5), deps(T5, seoulPage({ ask22: 0.30, bid22: 0.26, spread22: 0.04 }), 0.30));
    expect(stats).toMatchObject({ expired: 1 });

    const [bet] = await rows<{ status: string; expires_reason: string }>(
      db, `select status, expires_reason from bets where expires_reason is not null`,
    );
    expect(bet).toMatchObject({ status: 'expired', expires_reason: 'edge_collapsed' });
    expect(alerts.some((a) => a.kind === 'BET_EXPIRED' && a.severity === 'INFO')).toBe(true);
  });

  it('expire_recommendation CAS: a concurrently-filled bet cannot be expired (the approval wins)', async () => {
    const ev = await db.query<{ id: string; eid: string }>(
      `select b.id, b.event_id as eid from market_buckets mb
       join market_events me on me.id = mb.event_id, lateral (
         select me.id as event_id, mb.id
       ) b where mb.label = '25°C' limit 1`,
    );
    const ins = await db.query<{ id: string }>(
      `insert into bets (event_id, bucket_id, side, status, mode, our_q, best_ask, exec_ask, edge, min_edge,
                         fee_per_share, kelly_raw, kelly_frac, capped_frac, rec_stake_usd, rec_shares, audit)
       values ($1, $2, 'YES', 'recommended', 'paper', 0.2, 0.06, 0.06, 0.1, 0.05, 0.003, 0.1, 0.025, 0.02, 10, 166, '{}')
       returning id`,
      [ev.rows[0]!.eid, ev.rows[0]!.id],
    );
    await db.query(`update bets set status = 'filled' where id = $1`, [ins.rows[0]!.id]); // the approval won
    const [r] = await port.rpc<{ expire_recommendation: boolean }>('expire_recommendation', {
      p_bet_id: ins.rows[0]!.id, p_reason: 'edge_collapsed',
    });
    expect(r!.expire_recommendation).toBe(false);
    const [still] = await rows<{ status: string }>(db, `select status from bets where id = '${ins.rows[0]!.id}'`);
    expect(still!.status).toBe('filled');
    await db.query(`delete from bets where id = $1`, [ins.rows[0]!.id]);
  });

  it('ADR-17 position watch: filled bet WARNs when current champion q < ½ entry q; rec recreated', async () => {
    // a filled position on '23°C' entered at q .30; Q_WATCH drops its champion q to .10
    await db.query(`
      insert into bets (event_id, bucket_id, side, status, mode, our_q, best_ask, exec_ask, edge, min_edge,
                        fee_per_share, kelly_raw, kelly_frac, capped_frac, rec_stake_usd, rec_shares,
                        executed_size_usd, executed_shares, executed_price, audit)
      select mb.event_id, mb.id, 'YES', 'filled', 'paper', 0.30, 0.39, 0.39, 0.01, 0.005,
             0.01, 0.1, 0.025, 0.02, 20, 51, 20, 51, 0.39, '{}'
      from market_buckets mb where mb.label = '23°C'
    `);
    await setChampion(Q_WATCH, '2026-06-11T11:45:00Z');
    const T6 = new Date('2026-06-11T12:50:00Z');
    const stats = await pollMarkets(ctx(T6), deps(T6, seoulPage({ ask22: 0.30, bid22: 0.26, spread22: 0.04 }), 0.30));
    expect(stats).toMatchObject({ recommendationsNew: 1 }); // 22°C rec recreated under Q_WATCH
    const watch = alerts.find((a) => a.kind === 'POSITION_WATCH');
    expect(watch).toBeDefined();
    expect(watch!.severity).toBe('WARN');
    expect(watch!.title).toContain('23°C');
  });

  it('t-to-close < 2h: open rec expires too_close_to_resolution and no new recs pass the veto', async () => {
    const T7 = new Date('2026-06-11T13:30:00Z'); // Seoul 22:30 → 1.5h to local midnight
    const stats = await pollMarkets(ctx(T7), deps(T7, seoulPage({ ask22: 0.30, bid22: 0.26, spread22: 0.04 }), 0.30));
    expect(stats).toMatchObject({ recommendationsNew: 0, expired: 1 });
    const expired = await rows<{ expires_reason: string }>(
      db, `select expires_reason from bets where status = 'expired' order by updated_at desc limit 1`,
    );
    expect(expired[0]!.expires_reason).toBe('too_close_to_resolution');
  });

  it('stale champion (>14h) ⇒ event skipped and counted', async () => {
    await db.exec(`delete from bucket_probabilities where source = 'house_gaussian'`);
    await setChampion(Q_STRONG, '2026-06-10T20:00:00Z'); // 17.6h before T8
    const T8 = new Date('2026-06-11T13:35:00Z');
    const stats = await pollMarkets(ctx(T8), deps(T8, seoulPage({ ask22: 0.30, bid22: 0.26, spread22: 0.04 }), 0.30));
    expect(stats).toMatchObject({ recommendationsNew: 0, staleChampions: 1 });
  });

  it('W13: universe past 4 pages raises the growth WARN', async () => {
    alerts = [];
    const junkPage = Array.from({ length: 100 }, () => ({})); // structurally insane — filtered, but pages count
    const T9 = new Date('2026-06-11T13:40:00Z');
    const stats = await pollMarkets(ctx(T9), {
      fetchPage: async (offset) => (offset < 500 ? junkPage : []),
      fetchBook: async () => rawBook(0.3),
      notify: async (a) => (alerts.push(a), true),
      now: T9,
      runId: crypto.randomUUID(),
    });
    expect(Number(stats['pages'])).toBe(6);
    expect(alerts.some((a) => a.kind === 'UNIVERSE_GROWTH' && a.severity === 'WARN')).toBe(true);
  });
});
