/**
 * §6.20/§6.20a trading boundary against PGlite + the REAL Seoul/London
 * fixture events: fill_bet_with_caps (full in-PLPGSQL cap ladder under the
 * bankroll advisory lock — W5/W17), PaperExecutor worse-of pessimism (W9),
 * stale-book 422, ADR-09 CAS, single ledger entry, TS↔SQL cap-ladder parity,
 * execute-bet response contract (401/404/409/422/503), C1 (live gate failure
 * NEVER paper-fills), goLiveGate C5 conditions flipping independently, and a
 * fully mocked live E2E through the gate.
 *
 * PGlite is single-session (W16-style caveat): the W17 serialize-effect is
 * proven at the predicate level — the second fill re-derives exposure and sees
 * the first's stake + ledger entry. True interleaving rests on
 * pg_advisory_xact_lock semantics, re-verifiable on the hosted stack.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyRiskCaps,
  parseConfigRows,
  type RawGammaEvent,
} from '../../packages/core/src/index.ts';
import {
  PaperExecutor,
  goLiveGate,
  type ApprovedBet,
  type ClobClientish,
  type FillRpcResult,
} from '../../packages/trading/src/index.ts';
import { discoverMarkets } from '../functions/discover-markets/handler.ts';
import { executeBet, type ExecuteBetDeps } from '../functions/execute-bet/handler.ts';
import type { Alert } from '../functions/_shared/slack.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research');
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
const fixtureEvent = (name: string): RawGammaEvent => {
  const raw = fixture<RawGammaEvent | RawGammaEvent[]>(name);
  return structuredClone(Array.isArray(raw) ? raw[0]! : raw);
};

const cfg = parseConfigRows([]);
const SECRET = 'trading-test-secret-0123456789abcdef-40ch';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

let seoul: { id: string; distId: string; bucket22: string; bucket23: string; token22: string };
let london: { id: string; distId: string; bucket: string };

/** Raw CLOB shape: bids ascend / asks descend — best quote LAST (live-verified). */
const rawBook = (bestAsk: number) => ({
  market: '0xcond', asset_id: 'tok', timestamp: '1749600000000', hash: `bh-${bestAsk}`,
  bids: [{ price: '0.01', size: '5000' }, { price: (bestAsk - 0.02).toFixed(2), size: '1000' }],
  asks: [{ price: (bestAsk + 0.05).toFixed(2), size: '5000' }, { price: bestAsk.toFixed(2), size: '1000' }],
  min_order_size: '5', tick_size: '0.01', neg_risk: true, last_trade_price: bestAsk.toFixed(2),
});

const ctx = (now: Date): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: now });

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

async function loadBet(betId: string): Promise<ApprovedBet> {
  const [r] = await port.rpc<{ bet_for_execution: Record<string, unknown> | null }>(
    'bet_for_execution', { p_bet_id: betId },
  );
  const b = r!.bet_for_execution!;
  return {
    betId: String(b['betId']), status: String(b['status']), mode: b['mode'] as 'paper' | 'live',
    eventId: String(b['eventId']), eventSlug: String(b['eventSlug']), citySlug: String(b['citySlug']),
    label: String(b['label']), tokenYes: String(b['tokenYes']),
    feeRate: Number(b['feeRate']), minOrderSize: Number(b['minOrderSize']),
    tickSize: b['tickSize'] === null ? null : Number(b['tickSize']),
    execAsk: Number(b['execAsk']), recShares: Number(b['recShares']),
    recStakeUsd: Number(b['recStakeUsd']), recommendedAt: String(b['recommendedAt']),
    notes: b['notes'] as string | null,
  };
}

async function fillRpc(betId: string, price: number, shares: number): Promise<FillRpcResult> {
  const [r] = await port.rpc<{ fill_bet_with_caps: FillRpcResult }>('fill_bet_with_caps', {
    p_bet_id: betId, p_price: price, p_shares: shares,
  });
  return r!.fill_bet_with_caps;
}

const paperExec = (fetchBook: (t: string) => Promise<unknown>) =>
  new PaperExecutor({
    db: port, fetchBook,
    cfg: { paperSlippage: 0.01, paperBookMaxAgeMin: 5 },
    now: () => new Date(),
  });

async function resetBets(): Promise<void> {
  await db.exec(`delete from bankroll_ledger where bet_id is not null; delete from bets;`);
}

const bankroll = async (mode = 'paper'): Promise<number> =>
  Number(
    (await rows<{ s: string }>(
      db, `select coalesce(sum(amount_usd), 0) s from bankroll_ledger where mode = $1`, [mode],
    ))[0]!.s,
  );

const setConfig = (key: string, value: string) =>
  port.rpc('set_config_value', { p_key: key, p_value: value });

const betRow = async (betId: string) =>
  (await rows<{
    status: string; mode: string; executed_price: string | null; executed_fee: string | null;
    executed_size_usd: string | null; executed_shares: string | null; executed_at: string | null;
  }>(db, `select status, mode, executed_price, executed_fee, executed_size_usd, executed_shares, executed_at from bets where id = $1`, [betId]))[0]!;

const stakeEntries = async (betId: string) =>
  rows<{ amount_usd: string; mode: string }>(
    db, `select amount_usd, mode from bankroll_ledger where bet_id = $1 and entry_type = 'stake'`, [betId],
  );

beforeAll(async () => {
  process.env['CRON_SECRET'] = SECRET;
  db = await freshDb();
  port = pglitePort(db);

  // Ingest the REAL Seoul + London jun-11 events through discovery (fixtures
  // are ground truth for shapes/ladders).
  await discoverMarkets(ctx(new Date('2026-06-11T02:10:00Z')), {
    fetchPage: async (offset) =>
      offset === 0
        ? [fixtureEvent('gamma-event-temperature-seoul-jun11.json'), fixtureEvent('gamma-event-temperature-london-jun11.json')]
        : [],
    notify: async () => true,
    todayUtcISO: '2026-06-11',
  });

  const evs = await rows<{ id: string; slug: string }>(db, `select id, slug from market_events order by slug`);
  const seoulEv = evs.find((e) => e.slug.includes('seoul'))!;
  const londonEv = evs.find((e) => e.slug.includes('london'))!;

  const dist = async (eventId: string): Promise<string> =>
    (await db.query<{ id: string }>(
      `insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs)
       values ($1::text::uuid, 'house_gaussian', 0, false, now(), 'dist-' || $1::text, array[1]::numeric[]) returning id`,
      [eventId],
    )).rows[0]!.id;

  const seoulBuckets = await rows<{ id: string; label: string; token_yes: string }>(
    db, `select id, label, token_yes from market_buckets where event_id = $1 order by bucket_idx`, [seoulEv.id],
  );
  const londonBuckets = await rows<{ id: string }>(
    db, `select id from market_buckets where event_id = $1 order by bucket_idx`, [londonEv.id],
  );
  expect(seoulBuckets.length).toBeGreaterThan(0);
  expect(londonBuckets.length).toBeGreaterThan(0);

  const b22 = seoulBuckets.find((b) => b.label === '22°C')!;
  const b23 = seoulBuckets.find((b) => b.label === '23°C')!;
  seoul = { id: seoulEv.id, distId: await dist(seoulEv.id), bucket22: b22.id, bucket23: b23.id, token22: b22.token_yes };
  london = { id: londonEv.id, distId: await dist(londonEv.id), bucket: londonBuckets[5]!.id };
});

afterAll(async () => {
  delete process.env['CRON_SECRET'];
  await db.close();
});

describe('PaperExecutor + fill_bet_with_caps (§6.20, W9/W17)', () => {
  it('fills at the WORSE of stored vs live walked ask + 1¢, re-floored to the per-trade cap; ledger stake entry written once', async () => {
    await resetBets();
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);

    // live walk 0.30 worse than stored 0.27 → 0.31; 74×0.31 > 2% cap → 64 shares
    const fill = await paperExec(async () => rawBook(0.30)).place(await loadBet(betId));
    expect(fill).toEqual({ price: 0.31, shares: 64, feeUsd: 0.6845, mode: 'paper' });

    const row = await betRow(betId);
    expect(row.status).toBe('filled');
    expect(Number(row.executed_price)).toBe(0.31);
    expect(Number(row.executed_shares)).toBe(64);
    expect(Number(row.executed_size_usd)).toBe(19.84);
    expect(Number(row.executed_fee)).toBe(0.6845);
    expect(row.executed_at).not.toBeNull();

    const entries = await stakeEntries(betId);
    expect(entries).toHaveLength(1);
    expect(Number(entries[0]!.amount_usd)).toBe(-20.52); // −(19.84 + 0.6845) rounded
    expect(await bankroll()).toBeCloseTo(979.48, 2);
  });

  it('stored ask worse than live → pessimism keeps the stored price (W9)', async () => {
    await resetBets();
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);
    const fill = await paperExec(async () => rawBook(0.20)).place(await loadBet(betId));
    expect(fill).toEqual({ price: 0.28, shares: 71, feeUsd: 0.7157, mode: 'paper' });
  });

  it('live book unavailable + stored book fresh → fills on the stored book', async () => {
    await resetBets();
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);
    const fill = await paperExec(async () => { throw new Error('clob down'); }).place(await loadBet(betId));
    expect(fill.price).toBe(0.28);
    expect(fill.shares).toBe(71);
  });

  it('live book unavailable + stored book > 5 min old → FillRejected stale_book, bet untouched', async () => {
    await resetBets();
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);
    await db.query(`update bets set recommended_at = now() - interval '10 minutes' where id = $1`, [betId]);

    await expect(
      paperExec(async () => { throw new Error('clob down'); }).place(await loadBet(betId)),
    ).rejects.toMatchObject({ reason: 'stale_book' });

    expect((await betRow(betId)).status).toBe('recommended');
    expect(await stakeEntries(betId)).toHaveLength(0);
  });

  it('ADR-09 CAS: expired rec refuses to fill; a filled bet refuses a second fill; ledger stays single', async () => {
    await resetBets();
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);

    await port.rpc('expire_recommendation', { p_bet_id: betId, p_reason: 'edge_collapsed' });
    expect(await fillRpc(betId, 0.28, 71)).toMatchObject({ outcome: 'bad_status', status: 'expired' });

    const betId2 = await makeRec(seoul.id, seoul.bucket23, seoul.distId, 60, 0.3);
    expect((await fillRpc(betId2, 0.3, 60)).outcome).toBe('filled');
    expect(await fillRpc(betId2, 0.3, 60)).toMatchObject({ outcome: 'bad_status', status: 'filled' });
    expect(await stakeEntries(betId2)).toHaveLength(1);

    expect((await fillRpc('00000000-0000-0000-0000-0000000000aa', 0.3, 60)).outcome).toBe('not_found');
  });

  it('caps breach at fill time rejects with the cap named (ERR_CAPS basis)', async () => {
    await resetBets();
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);
    await setConfig('perEventCapPct', '0.001');
    try {
      const out = await fillRpc(betId, 0.28, 71);
      expect(out.outcome).toBe('caps');
      expect(out.details!.some((d) => d.includes('per-event cap'))).toBe(true);
      expect((await betRow(betId)).status).toBe('recommended');
    } finally {
      await setConfig('perEventCapPct', '0.05');
    }
  });

  it('W17 serialize-effect: the second of two approvals sees the first fill in its re-derived exposure', async () => {
    await resetBets();
    await setConfig('dailyCapPct', '0.03'); // day cap $30 on the $1,000 bankroll
    try {
      const a = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 60, 0.3); // $18
      const b = await makeRec(london.id, london.bucket, london.distId, 40, 0.3); // $12 — jointly AT the cap

      // A fills: dayOpen = B's open rec ($12) → headroom exactly $18.
      expect((await fillRpc(a, 0.3, 60)).outcome).toBe('filled');

      // B at a worse price ($14): dayOpen now = A's FILL ($18) + its own exclusion
      // → headroom 0.03×981.37 − 18 ≈ 11.44 < 14 → daily cap blocks the joint breach.
      const out = await fillRpc(b, 0.35, 40);
      expect(out.outcome).toBe('caps');
      expect(out.details!.some((d) => d.includes('daily cap'))).toBe(true);
      expect(Number(out.caps!.dayHeadroom)).toBeCloseTo(11.4411, 3);
    } finally {
      await setConfig('dailyCapPct', '0.15');
    }
  });
});

describe('TS↔SQL cap-ladder parity (§6.20)', () => {
  it('applyRiskCaps and the RPC derive identical cap values; the TS plan fills, one share more rejects', async () => {
    await resetBets();
    // State: one filled bet ($9 + $0.315 fee) shifts bankroll and exposure.
    const pre = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 30, 0.3);
    expect((await fillRpc(pre, 0.3, 30)).outcome).toBe('filled');

    const bank = await bankroll(); // 990.68
    const ctx9 = { bankrollUsd: bank, eventOpenUsd: 9, clusterOpenUsd: 9, dayOpenUsd: 9 };
    const appCfg = parseConfigRows(await port.getConfigRows());
    const [plan] = applyRiskCaps(
      [{ bucketIdx: 0, frac: 0.05, price: 0.28, orderMinSize: 5 }], ctx9, appCfg,
    );
    // per-trade clamp binds: 0.02×990.68 = 19.8136 → 70 shares @ 0.28 = $19.60
    expect(plan!.shares).toBe(70);
    expect(plan!.stakeUsd).toBeCloseTo(19.6, 6);

    const betId = await makeRec(seoul.id, seoul.bucket23, seoul.distId, 74, 0.27);

    // One share above the TS plan crosses the binding cap → rejected, and the
    // RPC's re-derived ladder matches the TS-side values to the cent.
    const over = await fillRpc(betId, 0.28, 71);
    expect(over.outcome).toBe('caps');
    expect(over.details!.some((d) => d.includes('per-trade cap'))).toBe(true);
    const caps = over.caps!;
    expect(Number(caps.bankroll)).toBeCloseTo(bank, 4);
    expect(Number(caps.perTradeCap)).toBeCloseTo(appCfg.perTradeCapPct * bank, 4);
    expect(Number(caps.eventHeadroom)).toBeCloseTo(appCfg.perEventCapPct * bank - ctx9.eventOpenUsd, 4);
    expect(Number(caps.clusterHeadroom)).toBeCloseTo(appCfg.clusterCapPct * bank - ctx9.clusterOpenUsd, 4);
    expect(Number(caps.dayHeadroom)).toBeCloseTo(appCfg.dailyCapPct * bank - ctx9.dayOpenUsd, 4);

    // The TS plan itself fills unchanged — applyRiskCaps output never breaches the RPC.
    const ok = await fillRpc(betId, 0.28, plan!.shares);
    expect(ok.outcome).toBe('filled');
    expect(Number(ok.stakeUsd)).toBeCloseTo(plan!.stakeUsd, 2);
  });
});

describe('execute-bet (§6.20a, §8.1 contract)', () => {
  const alerts: Alert[] = [];
  const req = (body: unknown, secret = SECRET): Request =>
    new Request('http://local/functions/v1/execute-bet', {
      method: 'POST',
      headers: { 'x-cron-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const hdeps = (over: Partial<ExecuteBetDeps> = {}): ExecuteBetDeps => ({
    db: port,
    fetchBook: async () => rawBook(0.30),
    fetchGeoblock: async () => 'Blocked: US, UK, France, Germany',
    getEnvVar: () => undefined,
    notify: async (a) => (alerts.push(a as Alert), true),
    now: () => new Date(),
    ...over,
  });

  let r1 = ''; // seoul 22°C paper rec
  let r2 = ''; // seoul 23°C paper rec

  it('401 on bad secret; 400 on missing betId; 404 on unknown bet', async () => {
    await resetBets();
    r1 = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27);

    const unauth = await executeBet(req({ betId: r1 }, 'wrong'), hdeps());
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toEqual({ error: 'ERR_CRON_AUTH' });

    expect((await executeBet(req({}), hdeps())).status).toBe(400);

    const missing = await executeBet(req({ betId: '00000000-0000-0000-0000-0000000000aa' }), hdeps());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'ERR_NOT_FOUND' });
  });

  it('200 paper fill with the §8.1 shape; second place → 409 ERR_BAD_STATUS', async () => {
    const res = await executeBet(req({ betId: r1 }), hdeps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      fill: { price: 0.31, shares: 64, feeUsd: 0.6845, mode: 'paper' },
    });

    const again = await executeBet(req({ betId: r1, action: 'place' }), hdeps());
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'ERR_BAD_STATUS', status: 'filled' });
  });

  it('422 ERR_CAPS when the ladder rejects at fill time', async () => {
    r2 = await makeRec(seoul.id, seoul.bucket23, seoul.distId, 74, 0.27);
    await setConfig('perEventCapPct', '0.001');
    try {
      const res = await executeBet(req({ betId: r2 }), hdeps());
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; details: string[] };
      expect(body.error).toBe('ERR_CAPS');
      expect(body.details.some((d) => d.includes('per-event cap'))).toBe(true);
    } finally {
      await setConfig('perEventCapPct', '0.05');
    }
  });

  it('422 ERR_STALE_BOOK when the stored book aged out and the live book is unreachable', async () => {
    await db.query(`update bets set recommended_at = now() - interval '10 minutes' where id = $1`, [r2]);
    const res = await executeBet(
      req({ betId: r2 }),
      hdeps({ fetchBook: async () => { throw new Error('clob down'); } }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('ERR_STALE_BOOK');
    expect((await betRow(r2)).status).toBe('recommended');
  });

  it("cancel is a paper no-op via the chokepoint: 200 {canceled}, state untouched", async () => {
    const res = await executeBet(req({ betId: r2, action: 'cancel' }), hdeps());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ canceled: true, mode: 'paper' });
    expect((await betRow(r2)).status).toBe('recommended');
  });

  it('409 mode mismatch: a live-sized rec cannot fill while config is paper', async () => {
    const r3 = await makeRec(london.id, london.bucket, london.distId, 40, 0.3, 'live');
    const res = await executeBet(req({ betId: r3 }), hdeps());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ERR_BAD_STATUS', status: 'mode:live' });
  });

  it('C1: live-mode gate failure returns 503 with reasons verbatim and NEVER paper-fills', async () => {
    await setConfig('tradingMode', 'live');
    try {
      const before = await stakeEntries(r2);
      const res = await executeBet(req({ betId: r2 }), hdeps());
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; reasons: string[] };
      expect(body.error).toBe('ERR_GATE_FAILED');
      expect(body.reasons.length).toBeGreaterThan(0);
      expect((await betRow(r2)).status).toBe('recommended'); // no silent downgrade
      expect(await stakeEntries(r2)).toEqual(before);
    } finally {
      await setConfig('tradingMode', 'paper');
    }
  });
});

describe('goLiveGate (§6.20, C5) — every condition flips the verdict independently', () => {
  const NOW = new Date('2026-06-11T12:00:00Z');
  const envWithKey = (): string => 'mock-wallet-key-never-real';
  const gdeps = (over: Partial<Parameters<typeof goLiveGate>[2]> = {}) => ({
    citySlug: 'seoul',
    getEnvVar: envWithKey,
    fetchGeoblock: async () => 'Blocked: US, UK, France, Germany, Italy, Netherlands, Belgium',
    now: NOW,
    ...over,
  });
  const run = async (over: Partial<Parameters<typeof goLiveGate>[2]> = {}) =>
    goLiveGate(port, parseConfigRows(await port.getConfigRows()), gdeps(over));

  beforeAll(async () => {
    // 61 graded out-of-sample days with scored champion rows.
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
      values ('00000000-0000-0000-0000-000000000000', 'house_gaussian', -1, '60d', 0.18, 0.20, 0.01, 80),
             ((select id from cities where slug = 'seoul'), 'house_gaussian', 0, '60d', 0.19, 0.20, null, 20),
             ((select id from cities where slug = 'seoul'), 'house_gaussian', 1, '60d', 0.19, 0.20, null, 15);
    `);
    await setConfig('tradingMode', 'live');
    await setConfig('kycAttestedAt', '2026-06-01');
    await setConfig('ledgerReconciledAt', '2026-06-01');
  });

  it('passes with every C5 condition green', async () => {
    expect(await run()).toEqual({ pass: true, reasons: [] });
  });

  it('env key absent → exactly that reason', async () => {
    const res = await run({ getEnvVar: () => undefined });
    expect(res.pass).toBe(false);
    expect(res.reasons).toHaveLength(1);
    expect(res.reasons[0]).toContain('missing from execute-bet function secrets');
  });

  it("tradingMode 'paper' → exactly that reason", async () => {
    await setConfig('tradingMode', 'paper');
    try {
      const res = await run();
      expect(res.reasons).toEqual([`tradingMode is 'paper' (config) — not 'live'`]);
    } finally {
      await setConfig('tradingMode', 'live');
    }
  });

  it('pooled bootstrap p ≥ 0.05 → fails (C5: point estimate alone is passable by noise)', async () => {
    await db.query(`update calibration_scores set bootstrap_p = 0.07 where lead_days = -1`);
    try {
      const res = await run();
      expect(res.reasons).toEqual(['pooled bootstrap p 0.07 not < 0.05']);
    } finally {
      await db.query(`update calibration_scores set bootstrap_p = 0.01 where lead_days = -1`);
    }
  });

  it('pooled point estimate > 0.95× market → fails', async () => {
    await db.query(`update calibration_scores set brier = 0.195 where lead_days = -1`);
    try {
      const res = await run();
      expect(res.reasons).toHaveLength(1);
      expect(res.reasons[0]).toContain('pooled 60d Brier 0.195 not ≤ 0.95× market');
    } finally {
      await db.query(`update calibration_scores set brier = 0.18 where lead_days = -1`);
    }
  });

  it('pooled row missing entirely → fails', async () => {
    await db.query(`delete from calibration_scores where lead_days = -1`);
    try {
      const res = await run();
      expect(res.reasons.some((r) => r.includes('pooled 60d calibration row missing'))).toBe(true);
      expect(res.reasons.some((r) => r.includes('bootstrap'))).toBe(false);
    } finally {
      await db.exec(`insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market, bootstrap_p, n_events)
        values ('00000000-0000-0000-0000-000000000000', 'house_gaussian', -1, '60d', 0.18, 0.20, 0.01, 80)`);
    }
  });

  it('per-city n < 30 → fails (no enabling 5 lucky cities)', async () => {
    await db.query(`update calibration_scores set n_events = 5 where lead_days = 0 and window_tag = '60d' and city_id <> '00000000-0000-0000-0000-000000000000'`);
    try {
      const res = await run();
      expect(res.reasons).toEqual(['city seoul: only 20 scored events in 60d (need ≥30)']);
    } finally {
      await db.query(`update calibration_scores set n_events = 20 where lead_days = 0 and window_tag = '60d' and city_id <> '00000000-0000-0000-0000-000000000000'`);
    }
  });

  it('per-city estimate > 1.0× market → fails', async () => {
    await db.query(`update calibration_scores set brier = 0.21 where lead_days in (0, 1) and city_id <> '00000000-0000-0000-0000-000000000000'`);
    try {
      const res = await run();
      expect(res.reasons).toHaveLength(1);
      expect(res.reasons[0]).toContain('city seoul: 60d Brier 0.21 not ≤ 1.0× market');
    } finally {
      await db.query(`update calibration_scores set brier = 0.19 where lead_days in (0, 1) and city_id <> '00000000-0000-0000-0000-000000000000'`);
    }
  });

  it('an active halt → fails with the halt key', async () => {
    await port.rpc('apply_halt', { p_scope: 'global', p_reason: 'gate test' });
    try {
      const res = await run();
      expect(res.reasons).toEqual(['halt active: halt:global']);
    } finally {
      await db.query(`delete from config where key = 'halt:global'`);
    }
  });

  it('Sweden on the geoblock list → fails; unreachable list fails CLOSED', async () => {
    const sweden = await run({ fetchGeoblock: async () => 'Blocked: US, UK, Sweden, France' });
    expect(sweden.reasons).toEqual(['geoblock: Sweden appears on the Polymarket blocked list']);

    const down = await run({ fetchGeoblock: async () => { throw new Error('503'); } });
    expect(down.reasons).toEqual(['geoblock list unreachable — failing closed']);
  });

  it('KYC attestation from a previous quarter → fails', async () => {
    await setConfig('kycAttestedAt', '2026-02-15');
    try {
      const res = await run();
      expect(res.reasons).toHaveLength(1);
      expect(res.reasons[0]).toContain('KYC');
    } finally {
      await setConfig('kycAttestedAt', '2026-06-01');
    }
  });

  it('ledger not reconciled within 35 days → fails', async () => {
    await setConfig('ledgerReconciledAt', '2026-04-01');
    try {
      const res = await run();
      expect(res.reasons).toHaveLength(1);
      expect(res.reasons[0]).toContain('not reconciled');
    } finally {
      await setConfig('ledgerReconciledAt', '2026-06-01');
    }
  });

  it('fewer than 60 distinct out-of-sample days → fails', async () => {
    await db.query(`delete from bucket_probabilities where event_id in (select id from market_events where slug in ('gate-ev-1', 'gate-ev-2'))`);
    try {
      const res = await run();
      expect(res.reasons).toEqual(['only 59 distinct out-of-sample days scored (need ≥60)']);
    } finally {
      await db.exec(`insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, brier)
        select id, 'house_gaussian', 1, false, now(), 'gate-' || slug, array[1]::numeric[], 0.10
        from market_events where slug in ('gate-ev-1', 'gate-ev-2')`);
    }
  });
});

describe('live E2E through the gate (fully mocked clob — trading stays paper at rest)', () => {
  it('gate passes → LiveExecutor (mock) places GTC at the exec ask and the fill records mode live', async () => {
    await resetBets();
    await db.exec(`insert into bankroll_ledger (entry_type, amount_usd, mode) values ('init', 1000, 'live')`);
    const betId = await makeRec(seoul.id, seoul.bucket22, seoul.distId, 74, 0.27, 'live');

    const client: ClobClientish = {
      getTickSize: async () => '0.01',
      createOrder: async (args, opts) => ({ args, opts }),
      postOrder: async () => ({ orderID: '0xE2E', success: true }),
      getOrder: async () => ({ status: 'matched', price: '0.27', size_matched: '74' }),
      cancelOrder: async () => ({}),
    };
    const res = await executeBet(
      new Request('http://local/functions/v1/execute-bet', {
        method: 'POST',
        headers: { 'x-cron-secret': SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ betId }),
      }),
      {
        db: port,
        fetchBook: async () => rawBook(0.30),
        fetchGeoblock: async () => 'Blocked: US, UK, France',
        getEnvVar: () => 'mock-wallet-key-never-real',
        notify: async () => true,
        now: () => new Date('2026-06-11T12:00:00Z'),
        liveClient: async () => client,
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ fill: { price: 0.27, shares: 74, feeUsd: 0.7293, mode: 'live' } });

    const row = await betRow(betId);
    expect(row.status).toBe('filled');
    expect(row.mode).toBe('live');
    const entries = await stakeEntries(betId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.mode).toBe('live');
    expect(Number(entries[0]!.amount_usd)).toBe(-20.71); // −(19.98 + 0.7293) rounded

    // The §15 invariant the whole build rests on: config returns to paper.
    await setConfig('tradingMode', 'paper');
    const mode = await rows<{ value: string }>(db, `select value from config where key = 'tradingMode'`);
    expect(mode[0]!.value).toBe('paper');
  });
});
