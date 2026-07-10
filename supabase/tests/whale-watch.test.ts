/**
 * whale-watch + the Slack-alert pause gate (migration 0055).
 *
 * End-to-end against PGlite (the real SQL functions): the Edge handler ingesting a stubbed Polymarket global
 * /trades feed through whale_record_trades → whale_pending_alerts → notifySlack → whale_mark_alerted (with the
 * webhook + global fetch stubbed so delivery succeeds), idempotency on a second tick, the no-op tick, and the
 * config-flag pause gate (claim_alert + list_unsent_alerts suppress non-allowlisted kinds while paused).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { parseConfigRows } from '../../packages/core/src/index.ts';
import type { JobCtx } from '../functions/_shared/runJob.ts';
import { whaleWatch } from '../functions/whale-watch/handler.ts';
import { parseTrades } from '../functions/_shared/polymarket-wallet.ts';
import { asRole, freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

const OPERATOR = { email: 'david.geborek@gmail.com' };
const cfg = parseConfigRows([]);

const RESEARCH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'research');
const tradesFixture = JSON.parse(
  readFileSync(join(RESEARCH, 'dataapi-trades-whales-sample.json'), 'utf8'),
) as unknown;
/** Every fixture row was pulled with filterAmount=100000 → all clear the floor. */
const WHALES = parseTrades(tradesFixture).filter((t) => t.notionalUsd >= 100_000);

/** 0092 gave whale_pending_alerts a 48h recency floor (against SQL now(), which tests can't mock) — re-stamp
 *  the fixture to "just traded" so the e2e delivery path still exercises. Distinct per-row timestamps keep
 *  trade_key (which includes the timestamp) collision-free; counts are timestamp-independent. */
const FRESH_TS = Math.floor(Date.now() / 1000) - 600;
const freshFixture = (tradesFixture as Record<string, unknown>[]).map((r, i) => ({ ...r, timestamp: FRESH_TS - i }));

/** Polymarket stub: the global /trades feed returns the (re-stamped) whale fixture; everything else empty. */
const stub = (url: string): Promise<unknown> =>
  Promise.resolve(url.includes('/trades') ? freshFixture : []);

describe('whale-watch — records the global feed, alerts each new whale, is idempotent', () => {
  let db: PGlite;
  let port: ReturnType<typeof pglitePort>;
  // slackPost's only network call → pretend Slack accepted it (HTTP 2xx); records every (url, init).
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve({ ok: true } as Response));
  let realFetch: typeof globalThis.fetch;
  const NOW = new Date('2026-06-24T12:30:00Z');
  const ctx = (): JobCtx => ({ db: port, config: cfg, log: () => {}, startedAt: NOW });

  beforeAll(async () => {
    db = await freshDb();
    port = pglitePort(db);
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.test/whale';
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.SLACK_WEBHOOK_URL;
    await db?.close();
  });

  it('fetches ≥$100k trades, records them, and posts one Slack alert per new whale (with the bet link)', async () => {
    expect(WHALES.length).toBeGreaterThan(0);
    const stats = await whaleWatch(ctx(), { now: NOW, fetchJson: stub, minUsd: 100_000 });
    expect(stats).toMatchObject({
      fetched: WHALES.length,
      newRecorded: WHALES.length,
      pending: WHALES.length,
      alerted: WHALES.length,
    });

    // every whale persisted and is now marked alerted
    const wt = await rows<{ n: string; pending: string }>(
      db,
      `select count(*) n, count(*) filter (where alerted = false) pending from whale_trades`,
    );
    expect(Number(wt[0]!.n)).toBe(WHALES.length);
    expect(Number(wt[0]!.pending)).toBe(0);

    // notional is stored as size × price; the link is the event permalink
    const top = await rows<{ notional_usd: string; link: string; side: string; title: string }>(
      db,
      `select notional_usd, link, side, title from whale_trades order by notional_usd desc limit 1`,
    );
    expect(Number(top[0]!.notional_usd)).toBeGreaterThanOrEqual(100_000);
    expect(top[0]!.link).toContain('https://polymarket.com/event/');

    // each alert was recorded as WHALE_TRADE and marked sent on the (stubbed) 2xx
    const al = await rows<{ kind: string; sent: boolean; body: string }>(
      db,
      `select kind, sent, body from alerts_log order by created_at`,
    );
    expect(al.length).toBe(WHALES.length);
    expect(al.every((r) => r.kind === 'WHALE_TRADE')).toBe(true);
    expect(al.every((r) => r.sent === true)).toBe(true);
    // the alert body says WHAT was bet + carries the clickable bet link
    expect(al.some((r) => r.body.includes('Notional') && r.body.includes('View the bet on Polymarket'))).toBe(true);

    // the link actually reached Slack (the posted webhook body contains the event permalink)
    const postedBodies = fetchMock.mock.calls.map((c) => String((c[1] as RequestInit)?.body ?? ''));
    expect(postedBodies.some((b) => b.includes('polymarket.com/event/'))).toBe(true);
  });

  it('a second identical tick records nothing new and re-alerts nothing (idempotent by trade_key)', async () => {
    const before = fetchMock.mock.calls.length;
    const stats = await whaleWatch(ctx(), { now: NOW, fetchJson: stub, minUsd: 100_000 });
    expect(stats).toMatchObject({ newRecorded: 0, pending: 0, alerted: 0 });
    const wt = await rows<{ n: string }>(db, `select count(*) n from whale_trades`);
    expect(Number(wt[0]!.n)).toBe(WHALES.length); // unchanged
    expect(fetchMock.mock.calls.length).toBe(before); // no new Slack posts
  });

  it('no fetchJson → a clean no-op tick', async () => {
    const stats = await whaleWatch(ctx(), { now: NOW });
    expect(stats).toMatchObject({ fetched: 0, newRecorded: 0, alerted: 0 });
  });

  it('dash_whale_watch surfaces the recorded whales to the operator', async () => {
    const out = await asRole(db, 'authenticated', OPERATOR, async () => {
      const r = await rows<{ dash_whale_watch: Record<string, unknown> }>(
        db,
        `select public.dash_whale_watch(50) as dash_whale_watch`,
      );
      return r[0]!.dash_whale_watch;
    });
    expect(Number(out.minUsd)).toBe(100_000);
    expect(out.paused).toBe(false);
    expect((out.recent as unknown[]).length).toBe(WHALES.length);
  });

  // Regression guard (migration 0044 trap): a RETURNS jsonb fn must NOT return a top-level array — the live
  // supabasePort misreads that as a TABLE row set and silently zeroes the handler's alert loop (the PGlite
  // test port hides it by wrapping every return in a column). whale_pending_alerts must be `{ rows: [...] }`.
  it('whale_pending_alerts returns a jsonb OBJECT { rows: [...] }, never a top-level array', async () => {
    const r = await rows<{ typ: string; rows_is_array: boolean }>(
      db,
      `select jsonb_typeof(public.whale_pending_alerts(5)) as typ,
              jsonb_typeof(public.whale_pending_alerts(5) -> 'rows') = 'array' as rows_is_array`,
    );
    expect(r[0]!.typ).toBe('object');
    expect(r[0]!.rows_is_array).toBe(true);
  });
});

describe('whale-watch — the Slack-alert pause gate (0055)', () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  const claim = (kind: string, key: string) =>
    rows<{ decision: string; alert_id: string | null }>(
      db,
      `select * from public.claim_alert($1,'CRITICAL',$2,'t','b')`,
      [kind, key],
    );

  it('default (not paused): every kind records normally', async () => {
    expect((await claim('JOB_FAIL', 'k-jobfail-1'))[0]!.decision).toBe('insert');
    expect((await claim('WHALE_TRADE', 'k-whale-1'))[0]!.decision).toBe('insert');
  });

  it('paused: non-allowlisted kinds are skipped (not recorded) — including WHALE_TRADE since the 0092 reroute', async () => {
    await db.query(`update config set value = 'true' where key = 'alerts_slack_paused'`);

    expect((await claim('JOB_FAIL', 'k-jobfail-2'))[0]!.decision).toBe('skip');
    expect((await claim('RESOLUTION', 'k-res-2'))[0]!.decision).toBe('skip');
    // 0092: per-print whale pushes retired (digest-only) — WHALE_TRADE left the allowlist.
    expect((await claim('WHALE_TRADE', 'k-whale-2'))[0]!.decision).toBe('skip');
    // the digest backbone + the incident kinds survive the pause (the 0092 routing).
    expect((await claim('DAILY_DIGEST', 'k-digest-2'))[0]!.decision).toBe('insert');
    expect((await claim('CAPTURE_DEADMAN', 'k-deadman-2'))[0]!.decision).toBe('insert');

    // the skipped kinds were NOT written to alerts_log (no resend later)
    const suppressed = await rows<{ n: string }>(
      db,
      `select count(*) n from alerts_log where dedupe_key in ('k-jobfail-2','k-res-2','k-whale-2')`,
    );
    expect(Number(suppressed[0]!.n)).toBe(0);
  });

  it('the resend sweep (list_unsent_alerts) skips suppressed kinds while paused', async () => {
    // unsent JOB_FAIL + WHALE_TRADE rows that predate the pause must not leak out while paused…
    await db.query(
      `insert into alerts_log (kind, severity, dedupe_key, title, body, sent, created_at)
       values ('JOB_FAIL','CRITICAL','k-old-jobfail','t','b', false, now() - interval '1 hour')`,
    );
    let unsent = await rows<{ kind: string }>(db, `select kind from public.list_unsent_alerts(0)`);
    expect(unsent.some((r) => r.kind === 'JOB_FAIL')).toBe(false);
    expect(unsent.some((r) => r.kind === 'WHALE_TRADE')).toBe(false); // 0092: suppressed like any other
    expect(unsent.some((r) => r.kind === 'DAILY_DIGEST')).toBe(true); // the backbone still delivers

    // …and resumes cleanly once unpaused (k-whale-1 was recorded unpaused in the first test)
    await db.query(`update config set value = 'false' where key = 'alerts_slack_paused'`);
    unsent = await rows<{ kind: string }>(db, `select kind from public.list_unsent_alerts(0)`);
    expect(unsent.some((r) => r.kind === 'JOB_FAIL')).toBe(true);
    expect(unsent.some((r) => r.kind === 'WHALE_TRADE')).toBe(true);
    expect((await claim('JOB_FAIL', 'k-jobfail-3'))[0]!.decision).toBe('insert');
  });
});
