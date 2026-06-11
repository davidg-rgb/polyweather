/**
 * §6.22 backfill-market-history against PGlite + the REAL resolved NYC June-9
 * fixture and the REAL interval=max prices-history captures (§15):
 *
 * - winner + ladder reconstruction vs outcomePrices ('80-81°F'),
 * - consensus synthesized AT THE ADR-16 CUTOFFS from pre-cutoff points only,
 *   value-checked against an in-test recompute from the fixtures,
 * - the C2 sentinel BOTH WAYS: doctoring post-cutoff prices changes nothing;
 *   doctoring the last pre-cutoff price changes the row (the mechanism reads
 *   exactly the pre-cutoff region),
 * - the skip path on the original interval=1d capture (all points post-cutoff),
 * - kill-safe resume via backfill_progress (no refetch),
 * - unknown-city events counted and left alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  impliedDistribution,
  parsePricesHistory,
  type PricePoint,
  type RawGammaEvent,
} from '../packages/core/src/index.ts';
import { freshDb, rows } from '../supabase/tests/harness.ts';
import { backfillMarketHistory, dailyLastPoints, lastPreCutoff, SCRIPT } from './backfill-market-history.ts';
import type { Db } from './lib/backfill.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'research');
const fixture = <T,>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const NOW = new Date('2026-06-11T12:00:00Z');
// NYC (America/New_York, EDT) target 2026-06-09: local-day start 04:00Z.
const CUTOFF_L0_MS = Date.parse('2026-06-09T04:00:00Z');
const CUTOFF_L1_MS = Date.parse('2026-06-08T04:00:00Z');

let db: PGlite;
let scriptDb: Db;

const resolvedEvent = (): RawGammaEvent => {
  const raw = fixture<RawGammaEvent | RawGammaEvent[]>('gamma-event-nyc-jun9-resolved.json');
  return structuredClone(Array.isArray(raw) ? raw[0]! : raw);
};

const winnerToken = (): string => {
  const ev = resolvedEvent();
  const win = ev.markets.find((m) => JSON.parse(m.outcomePrices!)[0] === '1')!;
  return (JSON.parse(win.clobTokenIds!) as string[])[0]!;
};

const winnerHistory = (): unknown => fixture('clob-prices-history-max-nyc-jun9-winner-80-81f.json');
const loserHistory = (): unknown => fixture('clob-prices-history-max-nyc-jun9-loser-78-79f.json');

/** Real-capture router: the winner token gets the winner series, all others the loser series. */
const routeHistory = (tokenId: string): unknown =>
  structuredClone(tokenId === winnerToken() ? winnerHistory() : loserHistory());

let fetches = 0;
const deps = (
  page: RawGammaEvent[],
  history: (tokenId: string) => unknown = routeHistory,
) => ({
  db: scriptDb,
  fetchPage: async (offset: number) => (offset === 0 ? page : []),
  fetchPricesHistory: async (tokenId: string) => (fetches++, history(tokenId)),
  log: () => {},
  now: () => NOW,
});

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
  `);
});

afterAll(async () => {
  await db.close();
});

describe('backfill-market-history (§6.22, C2)', () => {
  it('reconstructs the resolved fixture: winner from outcomePrices + cutoff consensus matching an in-test recompute', async () => {
    fetches = 0;
    const stats = await backfillMarketHistory({}, deps([resolvedEvent()]));
    expect(stats).toMatchObject({
      eventsSeen: 1, ingested: 1, winnersRecorded: 1, historyCalls: 11,
      consensusRows: 2, leadsSkippedNoPreCutoff: 0, skippedParse: 0, eventsErrored: 0,
    });
    expect(fetches).toBe(11);

    // winner: '80-81°F' (§15 — cross-checked against outcomePrices)
    const [ev] = await rows<{ id: string; closed: boolean; poly_resolved_winner_idx: number; ladder_ok: boolean }>(
      db, `select id, closed, poly_resolved_winner_idx, ladder_ok from market_events`,
    );
    expect(ev).toMatchObject({ closed: true, ladder_ok: true });
    const buckets = await rows<{ bucket_idx: number; label: string; resolved_outcome: string }>(
      db, `select bucket_idx, label, resolved_outcome from market_buckets order by bucket_idx`,
    );
    expect(buckets).toHaveLength(11);
    expect(buckets[ev!.poly_resolved_winner_idx]!.label).toBe('80-81°F');
    expect(buckets[ev!.poly_resolved_winner_idx]!.resolved_outcome).toBe('win');
    expect(buckets.filter((b) => b.resolved_outcome === 'lose')).toHaveLength(10);

    // consensus vs an independent recompute from the raw fixtures
    const winPts = parsePricesHistory(winnerHistory());
    const losePts = parsePricesHistory(loserHistory());
    for (const [lead, cutoffMs] of [[0, CUTOFF_L0_MS], [1, CUTOFF_L1_MS]] as const) {
      const winMid = lastPreCutoff(winPts, cutoffMs)!;
      const loseMid = lastPreCutoff(losePts, cutoffMs)!;
      const mids = buckets.map((b) => (b.bucket_idx === ev!.poly_resolved_winner_idx ? winMid.p : loseMid.p));
      const expected = impliedDistribution(mids)!;
      const [row] = await rows<{ probs: string[]; made_at: Date }>(
        db,
        `select probs, made_at from bucket_probabilities
         where source = 'market_consensus' and lead_days = $1`,
        [lead],
      );
      expect(row).toBeDefined();
      const stored = row!.probs.map(Number);
      expected.forEach((p, i) => expect(stored[i]!).toBeCloseTo(p, 5));
      // C2: synthesized at a PRE-cutoff timestamp — the newest point actually used
      const madeAt = new Date(row!.made_at).getTime();
      expect(madeAt).toBeLessThanOrEqual(cutoffMs);
      expect(madeAt).toBe(Math.max(winMid.t, loseMid.t) * 1000);
    }

    // daily snapshots: one per UTC day per bucket (Jun 8/9/10 in both captures)
    expect(stats.snapshotRows).toBe(33);
    const winDaily = dailyLastPoints(winPts).find((p) => new Date(p.t * 1000).toISOString().startsWith('2026-06-09'))!;
    const [snap] = await rows<{ mid: string }>(
      db,
      `select ms.mid from market_snapshots ms
       join market_buckets b on b.id = ms.bucket_id
       where b.label = '80-81°F' and ms.captured_at = $1`,
      [new Date(winDaily.t * 1000).toISOString()],
    );
    expect(Number(snap!.mid)).toBeCloseTo(winDaily.p, 6);
  });

  it('C2 sentinel: post-cutoff doctoring changes NOTHING; pre-cutoff doctoring changes the row', async () => {
    const before = await rows(db, `select id from bucket_probabilities where source = 'market_consensus'`);

    // (a) wild post-cutoff prices → identical mids → hash-dedup → zero new rows
    fetches = 0;
    const postDoctored = (tokenId: string): unknown => {
      const h = structuredClone(routeHistory(tokenId)) as { history: { t: number; p: number }[] };
      h.history.push({ t: Math.floor(CUTOFF_L0_MS / 1000) + 600, p: 0.99 });
      return h;
    };
    const a = await backfillMarketHistory({ refetch: true }, deps([resolvedEvent()], postDoctored));
    expect(a.consensusRows).toBe(0);
    expect(await rows(db, `select id from bucket_probabilities where source = 'market_consensus'`)).toHaveLength(
      before.length,
    );

    // (b) shift the winner's LAST pre-cutoff price → the lead-0 row must change
    const winPts = parsePricesHistory(winnerHistory());
    const lastPre = lastPreCutoff(winPts, CUTOFF_L0_MS)!;
    const preDoctored = (tokenId: string): unknown => {
      const h = structuredClone(routeHistory(tokenId)) as { history: { t: number; p: number }[] };
      if (tokenId === winnerToken()) {
        for (const pt of h.history) if (pt.t === lastPre.t) pt.p = Math.min(0.95, lastPre.p + 0.3);
      }
      return h;
    };
    const b = await backfillMarketHistory({ refetch: true }, deps([resolvedEvent()], preDoctored));
    expect(b.consensusRows).toBeGreaterThanOrEqual(1);
  });

  it('original interval=1d capture (all points post-cutoff) → both leads skipped + counted', async () => {
    await db.query(`delete from bucket_probabilities where source = 'market_consensus'`);
    const oneDay = fixture('clob-prices-history.json');
    const stats = await backfillMarketHistory({ refetch: true }, deps([resolvedEvent()], () => structuredClone(oneDay)));
    expect(stats.leadsSkippedNoPreCutoff).toBe(2);
    expect(stats.consensusRows).toBe(0);
    expect(await rows(db, `select id from bucket_probabilities where source = 'market_consensus'`)).toHaveLength(0);
  });

  it('resume: a done event is skipped without refetching prices-history', async () => {
    fetches = 0;
    const stats = await backfillMarketHistory({}, deps([resolvedEvent()]));
    expect(stats).toMatchObject({ ingested: 0, skippedAlreadyDone: 1, historyCalls: 0 });
    expect(fetches).toBe(0);
    const [p] = await rows<{ status: string }>(
      db, `select status from backfill_progress where script = $1`, [SCRIPT],
    );
    expect(p!.status).toBe('done');
  });

  it('unknown-city closed events are counted and nothing is written', async () => {
    const alien = resolvedEvent();
    alien.id = 'alien-1';
    alien.slug = 'highest-temperature-in-atlantis-on-june-9-2026';
    alien.title = 'Highest temperature in Atlantis on June 9?';
    const evCountBefore = (await rows(db, `select id from market_events`)).length;
    const stats = await backfillMarketHistory({}, deps([alien]));
    expect(stats).toMatchObject({ skippedUnknownCity: 1, ingested: 0, historyCalls: 0 });
    expect((await rows(db, `select id from market_events`)).length).toBe(evCountBefore);
  });

  it('open events on a closed page are refused; --from filters by target date', async () => {
    const open = resolvedEvent();
    open.closed = false;
    const s1 = await backfillMarketHistory({}, deps([open]));
    expect(s1).toMatchObject({ skippedNotClosed: 1, ingested: 0 });
    const s2 = await backfillMarketHistory({ from: '2026-06-10', refetch: true }, deps([resolvedEvent()]));
    expect(s2).toMatchObject({ skippedBeforeFrom: 1, ingested: 0 });
  });
});
