/**
 * dump-opening-captures against PGlite (the real migration chain) + a temp output dir.
 *
 * Pins the properties the C95 order-book archive stands on: (1) a keyset dump reads EVERY row exactly once and
 * writes gzipped NDJSON shards whose union is the whole table (rowsWritten == count(*), distinctEvents ==
 * count(distinct event_id)); (2) the raw bid/ask survives — a shard line's `buckets` carries the per-bucket
 * bestBid/bestAsk losslessly; (3) the dump is RESUMABLE — a partial run (maxBatches) leaves done=false with a
 * cursor, and a re-run completes coverage with NO double-counting; (4) verifyDump's index-only re-walk agrees
 * with the manifest.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from '../../supabase/tests/harness.ts';
import { toPgliteParam } from '../lib/pglite-param.ts';
import type { ScriptDb } from '../lib/script-db.ts';
import { dumpTable, fetchBatchAdaptive, MIN_BATCH_ROWS, readArchivedEventCounts, readManifest, stampVerified, verifyCoverage, verifyDump } from './dump-opening-captures.ts';

let db: PGlite;
let sdb: ScriptDb;
let outDir: string;

const TOTAL_A = 7;
const TOTAL_B = 5;

async function seedEvent(slug: string): Promise<string> {
  await db.query(
    `insert into cities (slug, display_name, country_code, unit, tz, region, first_seen, last_seen)
     values ($1, $1, 'NL', 'C', 'Europe/Amsterdam', 'europe-west', now(), now()) on conflict (slug) do nothing`,
    [slug],
  );
  const ev = await db.query<{ id: string }>(
    `insert into market_events (poly_event_id, slug, city_id, target_date, unit, ladder_ok)
     select 'pe-' || $1, 'ev-' || $1, id, current_date - 30, 'C', true from cities where slug = $1 returning id`,
    [slug],
  );
  return ev.rows[0]!.id;
}

/** Seed n captures whose `buckets` jsonb carries a real bestBid/bestAsk per bucket (the thing not in the price-path archive). */
async function seedCaptures(eventId: string, slug: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into opening_captures
         (captured_at, event_id, city, target_date, tz_name, hours_since_listing, peak_mid, is_flat_open,
          house_seeded, buckets, ev_vol24h, neg_risk)
       values (now() - make_interval(days => 28) + make_interval(mins => $3::int * 10), $1, $2, current_date - 30,
          'Europe/Amsterdam', 0.5, 0.12, true, true,
          $4::jsonb, 9000, true)`,
      [eventId, slug, i, [{ idx: 0, bestBid: 0.09 + i / 100, bestAsk: 0.16 + i / 100 }]],
    );
  }
}

beforeAll(async () => {
  db = await freshDb();
  sdb = {
    query: async <T,>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await db.query<T>(sql, params.map(toPgliteParam))).rows,
    end: async () => {},
  };
  outDir = mkdtempSync(join(tmpdir(), 'oc-dump-'));
  const a = await seedEvent('dump-a');
  const b = await seedEvent('dump-b');
  await seedCaptures(a, 'dump-a', TOTAL_A);
  await seedCaptures(b, 'dump-b', TOTAL_B);
});

afterAll(async () => {
  await db?.close();
  rmSync(outDir, { recursive: true, force: true });
});

function shardLines(dir: string): Record<string, unknown>[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson.gz'))
    .sort()
    .flatMap((f) => gunzipSync(readFileSync(join(dir, f))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
}

describe('dump-opening-captures — keyset coverage / bid-ask fidelity / resume / verify', () => {
  it('dumps every row exactly once across shards, with distinct-event accounting', async () => {
    const m = await dumpTable(sdb, { outDir, batchRows: 3 }); // batch 3 forces 12 → multiple shards
    expect(m.done).toBe(true);
    expect(m.rowsWritten).toBe(TOTAL_A + TOTAL_B);
    expect(m.distinctEvents).toBe(2);
    expect(m.shards.length).toBeGreaterThan(1); // 12 rows / batch 3 ⇒ ≥4 shards

    const lines = shardLines(outDir);
    expect(lines.length).toBe(TOTAL_A + TOTAL_B);
    const ids = lines.map((r) => String(r['id']));
    expect(new Set(ids).size).toBe(ids.length); // no row written twice
  });

  it('preserves the raw bestBid/bestAsk inside each capture (the archive-gap payload)', () => {
    const lines = shardLines(outDir);
    for (const row of lines) {
      const buckets = row['buckets'] as { idx: number; bestBid: number; bestAsk: number }[];
      expect(Array.isArray(buckets)).toBe(true);
      expect(typeof buckets[0]!.bestBid).toBe('number');
      expect(typeof buckets[0]!.bestAsk).toBe('number');
      expect(buckets[0]!.bestAsk).toBeGreaterThan(buckets[0]!.bestBid);
    }
  });

  it('verifyDump agrees with the manifest (rows + distinct events)', async () => {
    const v = await verifyDump(sdb, outDir, 4);
    expect(v.rowsMatch).toBe(true);
    expect(v.eventsMatch).toBe(true);
    expect(v.dbRows).toBe(TOTAL_A + TOTAL_B);
    expect(v.dbEvents).toBe(2);
  });

  it('is resumable — a partial run leaves a cursor, a re-run completes with no double-count', async () => {
    const resumeDir = mkdtempSync(join(tmpdir(), 'oc-dump-resume-'));
    try {
      const partial = await dumpTable(sdb, { outDir: resumeDir, batchRows: 3, maxBatches: 1 });
      expect(partial.done).toBe(false);
      expect(partial.rowsWritten).toBe(3); // exactly one batch
      expect(partial.lastId).not.toBeNull();

      const finished = await dumpTable(sdb, { outDir: resumeDir, batchRows: 3 }); // resumes from the manifest cursor
      expect(finished.done).toBe(true);
      expect(finished.rowsWritten).toBe(TOTAL_A + TOTAL_B); // completed, not doubled
      expect(finished.distinctEvents).toBe(2);

      const lines = shardLines(resumeDir);
      expect(lines.length).toBe(TOTAL_A + TOTAL_B);
      expect(new Set(lines.map((r) => String(r['id']))).size).toBe(TOTAL_A + TOTAL_B);
      expect(readManifest(resumeDir)!.done).toBe(true);
    } finally {
      rmSync(resumeDir, { recursive: true, force: true });
    }
  });

  it('fetchBatchAdaptive shrinks on statement timeout, retries a malformed (post-cancel) result, and recovers', async () => {
    const good = [{ cursor_id: '42', event_id: 'e1', row: { id: 42 } }];
    const script: (() => unknown)[] = [
      () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); },
      () => [{ row: { id: 1 } }], // malformed: missing cursor_id (the post-cancel dirty-connection case)
      () => good,
    ];
    let calls = 0;
    const fakeDb: ScriptDb = {
      query: async <T,>(): Promise<T[]> => script[calls++]!() as T[],
      end: async () => {},
    };
    const slept: number[] = [];
    const res = await fetchBatchAdaptive(fakeDb, null, 1000, MIN_BATCH_ROWS, () => {}, async (ms) => { slept.push(ms); });
    expect(res.rows).toEqual(good);
    expect(res.batch).toBe(500); // halved once by the timeout
    expect(calls).toBe(3); // timeout → malformed → good
    expect(slept.length).toBe(2); // one backoff per retry
  });

  it('fetchBatchAdaptive gives up after repeated failures at the floor (surfaces for resume)', async () => {
    const alwaysTimeout: ScriptDb = {
      query: async <T,>(): Promise<T[]> => { throw Object.assign(new Error('timeout'), { code: '57014' }); },
      end: async () => {},
    };
    await expect(fetchBatchAdaptive(alwaysTimeout, null, MIN_BATCH_ROWS, MIN_BATCH_ROWS, () => {}, async () => {})).rejects.toThrow();
  });

  it('a completed manifest is idempotent — a re-run without --force writes nothing new', async () => {
    const before = readManifest(outDir)!;
    const again = await dumpTable(sdb, { outDir, batchRows: 3 });
    expect(again.rowsWritten).toBe(before.rowsWritten);
    expect(again.shards.length).toBe(before.shards.length);
  });
});

describe('dump-opening-captures — incremental append + coverage verify (retention loop)', () => {
  it('appends ONLY new rows to a completed archive; a plain re-run stays a no-op', async () => {
    const incDir = mkdtempSync(join(tmpdir(), 'oc-dump-inc-'));
    try {
      const full = await dumpTable(sdb, { outDir: incDir, batchRows: 100 });
      expect(full.done).toBe(true);
      const base = full.rowsWritten; // whole-table snapshot

      // new captures land (higher ids) AFTER the archive was marked done.
      const ev = await seedEvent('dump-inc');
      await seedCaptures(ev, 'dump-inc', 4);

      // without --incremental a done manifest is a no-op (the append is opt-in).
      expect((await dumpTable(sdb, { outDir: incDir, batchRows: 100 })).rowsWritten).toBe(base);

      // --incremental appends exactly the 4 new rows — no --force, no re-dump, no double-count.
      const inc = await dumpTable(sdb, { outDir: incDir, batchRows: 100, incremental: true });
      expect(inc.done).toBe(true);
      expect(inc.rowsWritten).toBe(base + 4);
      expect(inc.distinctEvents).toBe(full.distinctEvents + 1);

      const lines = shardLines(incDir);
      expect(lines.length).toBe(base + 4);
      expect(new Set(lines.map((r) => String(r['id']))).size).toBe(base + 4);

      const cov = await verifyCoverage(sdb, incDir);
      expect(cov.covered).toBe(true);
      expect(cov.liveRows).toBe(base + 4);
      expect(cov.archivedRows).toBe(base + 4); // equal before any prune
    } finally {
      rmSync(incDir, { recursive: true, force: true });
    }
  });

  it('coverage holds when the archive is a SUPERSET of live (post-prune); a row beyond lastId is the gate case', async () => {
    const supDir = mkdtempSync(join(tmpdir(), 'oc-dump-sup-'));
    try {
      const ev = await seedEvent('dump-sup');
      await seedCaptures(ev, 'dump-sup', 5);
      const full = await dumpTable(sdb, { outDir: supDir, batchRows: 100 });
      const lastId = full.lastId!;

      // simulate a prune: delete this event's rows from LIVE. The archive keeps them → superset.
      await sdb.query(`delete from opening_captures where event_id = $1`, [ev]);
      const cov = await verifyCoverage(sdb, supDir);
      expect(cov.covered).toBe(true); // liveInPrefix (fewer) ≤ archivedRows (superset)
      expect(cov.archivedRows).toBeGreaterThan(cov.liveInPrefix);

      // a NEW capture (id > lastId) is beyond the archived prefix — the per-event gate in the prune catches this.
      await seedCaptures(ev, 'dump-sup', 1);
      const cov2 = await verifyCoverage(sdb, supDir);
      expect(BigInt(cov2.maxLiveId) > BigInt(lastId)).toBe(true);
      expect(cov2.liveInPrefix).toBe(cov.liveInPrefix); // the new row is OUTSIDE the prefix, so prefix coverage is unchanged
    } finally {
      rmSync(supDir, { recursive: true, force: true });
    }
  });

  it('readArchivedEventCounts reports per-event archived row counts (the row-level prune gate), sidecar == shard scan', async () => {
    const cntDir = mkdtempSync(join(tmpdir(), 'oc-dump-cnt-'));
    try {
      const ev = await seedEvent('dump-cnt');
      await seedCaptures(ev, 'dump-cnt', 6);
      await dumpTable(sdb, { outDir: cntDir, batchRows: 100 });

      const counts = readArchivedEventCounts(cntDir);
      expect(counts.get(ev)).toBe(6); // exactly this event's archived rows

      // the _event_counts.json sidecar (written at completion) must equal a from-scratch shard recount.
      const viaSidecar = readArchivedEventCounts(cntDir);
      rmSync(join(cntDir, '_event_counts.json'));
      const viaScan = readArchivedEventCounts(cntDir); // falls back to scanning shards
      expect([...viaScan.entries()].sort()).toEqual([...viaSidecar.entries()].sort());

      // an incremental append updates the count (no re-dump, no double-count).
      await seedCaptures(ev, 'dump-cnt', 2);
      await dumpTable(sdb, { outDir: cntDir, batchRows: 100, incremental: true });
      expect(readArchivedEventCounts(cntDir).get(ev)).toBe(8);
    } finally {
      rmSync(cntDir, { recursive: true, force: true });
    }
  });

  it('an incremental re-open CLEARS a stale verified stamp (a killed append must not advertise verified=true)', async () => {
    const vDir = mkdtempSync(join(tmpdir(), 'oc-dump-ver-'));
    try {
      await dumpTable(sdb, { outDir: vDir, batchRows: 100 });
      stampVerified(vDir); // pretend a prior coverage-verify stamped it
      expect(readManifest(vDir)!.verified).toBe(true);

      const ev = await seedEvent('dump-ver');
      await seedCaptures(ev, 'dump-ver', 3);
      await dumpTable(sdb, { outDir: vDir, batchRows: 100, incremental: true }); // re-opens + appends the tail
      // dumpTable itself must NOT leave verified=true — the appended tail is unverified until main() re-checks.
      expect(readManifest(vDir)!.verified).toBe(false);
      expect(readManifest(vDir)!.verifiedAt).toBeUndefined();
    } finally {
      rmSync(vDir, { recursive: true, force: true });
    }
  });
});
