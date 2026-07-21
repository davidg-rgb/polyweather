/**
 * prune-opening-captures against PGlite (the real migration chain) + a temp archive dir.
 *
 * Pins the safety properties the WS-1 retention prune stands on: (1) candidate selection is
 * RESOLVED ≥25-days-ago ONLY (unresolved / recently-resolved events never appear); (2) the MANDATORY archive
 * pre-flight — a candidate whose {date}__{polyEventId}.json is absent from the local archive index fails the
 * pre-flight (no archive file, no delete); (3) the guard is STRUCTURAL — executePrune takes the pre-flight
 * result as a required argument and throws with ZERO deletes unless it reports full coverage (the direct-call
 * path cannot bypass main()'s ordering); (4) the batched delete removes exactly the candidates' rows
 * (≤ batchRows per statement) and leaves every other event's ticks untouched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from '../../supabase/tests/harness.ts';
import { toPgliteParam } from '../lib/pglite-param.ts';
import type { ScriptDb } from '../lib/script-db.ts';
import { indexArchive } from '../research/tune-convergence.ts';
import { coverageBeyondArchive, executePrune, findCandidates, preflightArchive, type PruneCandidate } from './prune-opening-captures.ts';

let db: PGlite;
let sdb: ScriptDb;
let archiveDir: string;

/** city + market event; resolvedDaysAgo=null leaves the event unresolved (no winner, no resolved_at). */
async function seedEvent(slug: string, resolvedDaysAgo: number | null): Promise<{ id: string; polyId: string }> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'NL', 'C', 'Europe/Amsterdam', 'europe-west', now(), now()) on conflict (slug) do nothing`,
    [slug],
  );
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok, winning_bucket_idx, resolved_at)
     select 'pe-' || $1, 'ev-' || $1, id, current_date - 30, 'C', true,
            case when $2::int is null then null else 1 end,
            case when $2::int is null then null else now() - make_interval(days => $2::int) end
       from cities where slug = $1 returning id`,
    [slug, resolvedDaysAgo],
  );
  return { id: ev.rows[0]!.id, polyId: `pe-${slug}` };
}

async function seedCaptures(eventId: string, slug: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into opening_captures
         (captured_at, event_id, city, target_date, tz_name, hours_since_listing, peak_mid, is_flat_open,
          house_seeded, buckets, ev_vol24h, neg_risk)
       values (now() - make_interval(days => 28) + make_interval(mins => $3::int * 10), $1, $2, current_date - 30,
          'Europe/Amsterdam', 0.5, 0.12, true, true, '[{"idx":0,"bestAsk":0.16}]'::jsonb, 9000, true)`,
      [eventId, slug, i],
    );
  }
}

let oldEv: { id: string; polyId: string };
let recentEv: { id: string; polyId: string };
let openEv: { id: string; polyId: string };

beforeAll(async () => {
  db = await freshDb();
  sdb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await db.query<T>(sql, params.map(toPgliteParam))).rows,
    end: async () => {},
  };
  archiveDir = mkdtempSync(join(tmpdir(), 'prune-archive-'));

  oldEv = await seedEvent('prune-old', 30); // resolved 30 days ago → candidate
  recentEv = await seedEvent('prune-recent', 5); // resolved 5 days ago → NOT a candidate
  openEv = await seedEvent('prune-open', null); // unresolved → NOT a candidate
  await seedCaptures(oldEv.id, 'prune-old', 7);
  await seedCaptures(recentEv.id, 'prune-recent', 3);
  await seedCaptures(openEv.id, 'prune-open', 2);
});

afterAll(async () => {
  await db?.close();
  rmSync(archiveDir, { recursive: true, force: true });
});

describe('prune-opening-captures — candidates / pre-flight / batched delete', () => {
  it('findCandidates returns ONLY events resolved ≥25 days ago, with row + stored-byte counts', async () => {
    const cands = await findCandidates(sdb);
    expect(cands.map((c) => c.eventId)).toEqual([oldEv.id]);
    const c = cands[0]!;
    expect(c.polyEventId).toBe(oldEv.polyId);
    expect(Number(c.nRows)).toBe(7);
    expect(Number(c.bytesEst)).toBeGreaterThan(0); // pg_column_size over the stored buckets payload
    expect(Number(c.maxId)).toBeGreaterThan(0); // max row id — the coverage gate compares this to the archive lastId
  });

  it('coverageBeyondArchive flags candidates whose rows exceed the archive lastId (the append-only delete gate)', () => {
    const mk = (maxId: string): PruneCandidate =>
      ({ eventId: 'e' + maxId, polyEventId: 'p', city: 'c', targetDate: '', resolvedAt: '', nRows: 1, maxId, bytesEst: 1 });
    const cands = [mk('100'), mk('250'), mk('300')];
    expect(coverageBeyondArchive(cands, '250').map((c) => c.maxId)).toEqual(['300']); // only 300 > 250
    expect(coverageBeyondArchive(cands, '99')).toHaveLength(3); // archive behind all → all beyond
    expect(coverageBeyondArchive(cands, '999')).toHaveLength(0); // archive ahead of all → all covered
    expect(coverageBeyondArchive(cands, null)).toHaveLength(3); // no archive ⇒ nothing covered
  });

  it('preflightArchive FAILS while the archive lacks the candidate, PASSES once the file exists', () => {
    const cands = [
      { eventId: oldEv.id, polyEventId: oldEv.polyId, city: 'prune-old', targetDate: '', resolvedAt: '', nRows: 7, maxId: '1', bytesEst: 1 },
    ];
    // empty archive → missing (no archive file, no delete)
    const before = preflightArchive(cands, indexArchive(archiveDir));
    expect(before.ok).toBe(false);
    expect(before.missing.map((m) => m.polyEventId)).toEqual([oldEv.polyId]);
    // a null polyEventId is structurally un-archivable → always missing
    expect(preflightArchive([{ ...cands[0]!, polyEventId: null }], new Map([['x', 'y']])).ok).toBe(false);

    // write the {date}__{polyEventId}.json the indexer expects → pre-flight passes
    mkdirSync(join(archiveDir, '2026-06-03'), { recursive: true });
    writeFileSync(join(archiveDir, '2026-06-03', `2026-06-03__${oldEv.polyId}.json`), '{}');
    const after = preflightArchive(cands, indexArchive(archiveDir));
    expect(after.ok).toBe(true);
    expect(after.missing).toEqual([]);
  });

  it('executePrune REFUSES structurally without a passing pre-flight — throws, zero rows deleted', async () => {
    const cands = await findCandidates(sdb);
    const failedPre = preflightArchive(cands, new Map()); // empty archive index → not covered
    expect(failedPre.ok).toBe(false);
    // the direct-call path (not main()'s ordering) must hit the guard: no delete without full archive coverage.
    await expect(executePrune(sdb, cands, failedPre, 3)).rejects.toThrow(/pre-flight did not pass/);
    const [n] = await rows<{ n: number }>(db, `select count(*)::int as n from opening_captures`);
    expect(Number(n!.n)).toBe(12); // 7 + 3 + 2 — nothing deleted
  });

  it('dump pre-flight (keyOf=eventId against a Set) gates on the dumped event set, not the price-path archive', async () => {
    const cands = await findCandidates(sdb); // [oldEv]
    const keyOf = (c: { eventId: string }) => c.eventId;
    // event NOT in the dumped set → missing (no dumped rows, no delete)
    expect(preflightArchive(cands, new Set<string>(), keyOf).ok).toBe(false);
    // event present in the dumped set → passes (this is how the aggressive C95 prune clears sub-25-day events)
    const ok = preflightArchive(cands, new Set([oldEv.id]), keyOf);
    expect(ok.ok).toBe(true);
    expect(ok.missing).toEqual([]);
  });

  it('findCandidates honors an aggressive resolved-age override (the recent event becomes a candidate)', async () => {
    // stock 25d → only oldEv; age 1 → oldEv (30d) AND recentEv (5d), but never the unresolved openEv.
    const aggressive = await findCandidates(sdb, 1);
    expect(new Set(aggressive.map((c) => c.eventId))).toEqual(new Set([oldEv.id, recentEv.id]));
    expect(aggressive.map((c) => c.eventId)).not.toContain(openEv.id);
  });

  it('executePrune (passing pre-flight) deletes in ≤batchRows statements and leaves every other event intact', async () => {
    const cands = await findCandidates(sdb);
    const pre = preflightArchive(cands, indexArchive(archiveDir)); // the file written by the pre-flight test
    expect(pre.ok).toBe(true);
    // batchRows 3 forces 7 → 3+3+1 (three delete statements) — the batching path is actually exercised.
    const deleted = await executePrune(sdb, cands, pre, 3);
    expect(deleted).toBe(7);
    const left = await rows<{ event_id: string; n: number }>(
      db,
      `select event_id, count(*)::int as n from opening_captures group by event_id order by event_id`,
    );
    const byEvent = new Map(left.map((r) => [r.event_id, Number(r.n)]));
    expect(byEvent.has(oldEv.id)).toBe(false); // pruned to zero
    expect(byEvent.get(recentEv.id)).toBe(3); // untouched
    expect(byEvent.get(openEv.id)).toBe(2); // untouched
    expect(await executePrune(sdb, [], { ok: true, missing: [] }, 3)).toBe(0); // empty candidate set is a no-op
  });
});
