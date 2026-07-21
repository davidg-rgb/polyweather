/**
 * scripts/ops/dump-opening-captures — full local archive of the `opening_captures` order book (C95, FASTTRACK-PLAN).
 *
 * opening_captures (prod, ~1.37 GB: 51 MB heap + ~1.27 GB `buckets` jsonb TOAST, ~283k rows) is the raw
 * ORDER-BOOK capture — bid/ask/depth per bucket, every ~10 min — for the now-CLOSED 12th signal (opening-convergence /
 * maker-exit). The on-disk price-PATH archive (scripts/research/out/market-history) covers the sims, but it is
 * single-implied-prob-per-bucket: NO bid/ask. This dumps the ONE thing not archived — the raw book — so the
 * operator can then prune the prod table (prune-opening-captures.ts) without losing the bid/ask forever, and a
 * local real-book sweep stays possible offline.
 *
 * A single full-table read STATEMENT-TIMEOUTs (57014) under the Micro instance's contention — that IS the wall
 * that blocked every sweep (C91/C94). So this reads in PK-keyed (bigint `id`) keyset batches: each batch is an
 * index-driven scan that detoasts only its own slice of `buckets` (a few MB), completing well inside the
 * statement timeout. Rows are serialized losslessly via `to_jsonb(oc.*)` (Postgres owns the type→JSON mapping:
 * full-precision timestamps, native jsonb `buckets`) and streamed to gzipped NDJSON shards under
 * scripts/research/out/opening-captures-archive/, one shard per batch. A `_manifest.json` (atomic temp+rename)
 * records the keyset cursor + rows-written + per-shard row/id spans, so the dump is IDEMPOTENT and RESUMABLE:
 * a killed or timed-out run re-run picks up from the last fully-written shard. On a statement timeout the batch
 * size ADAPTIVELY halves (down to a floor) and retries, so contention slows the dump but never breaks it.
 *
 * READ-ONLY / non-destructive — this never deletes. The prune (prune-opening-captures.ts --execute) is the
 * separate, archive-gated destructive step that runs AFTER this dump is verified.
 *
 * INCREMENTAL (the retention loop's cheap daily path — no --force re-dump): `--incremental` continues from the
 * manifest's lastId even when the dump is `done`, appending ONLY the new rows (id > lastId) as fresh shards.
 * The archive is APPEND-ONLY: it is never overwritten and, after a prune, is a SUPERSET of the live table (it
 * keeps the pruned rows — that is the point). So the exact-match --verify no longer applies; --incremental
 * self-checks with `verifyCoverage` (every live row in the archived id-prefix is archived — holds by the
 * monotonic append-only ids) and stamps the manifest verified. The prune's per-event gate (candidate maxId ≤
 * lastId) is what actually authorises a delete.
 *
 * Run: pnpm tsx scripts/ops/dump-opening-captures.ts                 # dump (resumes if a manifest exists)
 *      pnpm tsx scripts/ops/dump-opening-captures.ts --incremental   # append new rows to a done archive + coverage-verify (retention loop)
 *      pnpm tsx scripts/ops/dump-opening-captures.ts --verify        # exact cross-check (full-snapshot archives only)
 *      pnpm tsx scripts/ops/dump-opening-captures.ts --verify-coverage # live ⊆ archive check (append-only archives)
 *      pnpm tsx scripts/ops/dump-opening-captures.ts --batch 2000    # override the initial batch size
 *      pnpm tsx scripts/ops/dump-opening-captures.ts --max-batches 3 # trial run (first N batches, then stop)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';

export const OUT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'research', 'out', 'opening-captures-archive',
);

/** initial rows per keyset batch — index-driven, detoasts only this slice; halves on statement timeout. */
export const BATCH_ROWS = 1500;
/** floor the adaptive shrink stops at — below this a timeout is a genuine failure, not just contention. */
export const MIN_BATCH_ROWS = 250;
/** backoff before a post-timeout retry — lets the pooler drain the cancelled query so the next read is clean. */
export const RETRY_BACKOFF_MS = 1500;
/** consecutive fetch failures (timeout at the floor, or a malformed result) before giving up (resume continues). */
export const MAX_FETCH_FAILURES = 4;
/** Postgres SQLSTATE for `canceling statement due to statement timeout`. */
const STATEMENT_TIMEOUT = '57014';

export interface ShardMeta {
  seq: number;
  file: string;
  rows: number;
  firstId: string;
  lastId: string;
  bytesGz: number;
}

export interface DumpManifest {
  table: string;
  startedAt: string;
  updatedAt: string;
  /** keyset cursor: the last `id` fully written (string bigint), or null before the first batch. */
  lastId: string | null;
  rowsWritten: number;
  /** distinct event_id values seen so far — the count(distinct event_id) cross-check, accumulated for free. */
  distinctEvents: number;
  shards: ShardMeta[];
  done: boolean;
  /** set by a passing `--verify` run (manifest rows/events == live table) — the prune's dump pre-flight requires it. */
  verified?: boolean;
  verifiedAt?: string;
}

export interface DumpOpts {
  outDir?: string;
  batchRows?: number;
  minBatchRows?: number;
  /** stop after this many NEW batches this run (trial runs); undefined = run to completion. */
  maxBatches?: number;
  /** re-dump from scratch even if a completed manifest exists. */
  force?: boolean;
  /** append new rows (id > lastId) to a COMPLETED archive instead of stopping — the retention loop's cheap path. */
  incremental?: boolean;
  log?: (msg: string) => void;
}

interface BatchRow {
  cursor_id: string;
  event_id: string | null;
  row: Record<string, unknown>;
}

const pad6 = (n: number): string => String(n).padStart(6, '0');
const isStatementTimeout = (e: unknown): boolean =>
  typeof (e as { code?: unknown } | null)?.code === 'string' && (e as { code: string }).code === STATEMENT_TIMEOUT;

const manifestPath = (outDir: string): string => join(outDir, '_manifest.json');
const eventsPath = (outDir: string): string => join(outDir, '_events.json');

export function readManifest(outDir: string): DumpManifest | null {
  const p = manifestPath(outDir);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8')) as DumpManifest;
}

/**
 * The set of distinct (non-null) event_ids present in the dump — the prune's dump pre-flight index
 * ("no dumped row for this event, no delete"). Prefers the `_events.json` sidecar (written at completion);
 * falls back to scanning the shards when it is absent.
 */
export function readDumpedEventIds(outDir: string): Set<string> {
  if (existsSync(eventsPath(outDir))) {
    return new Set(JSON.parse(readFileSync(eventsPath(outDir), 'utf8')) as string[]);
  }
  const manifest = readManifest(outDir);
  const events = new Set<string>();
  for (const s of manifest?.shards ?? []) {
    for (const ln of gunzipShard(outDir, s.file).toString('utf8').split('\n')) {
      if (!ln) continue;
      const ev = (JSON.parse(ln) as { event_id?: string | null }).event_id;
      if (ev) events.add(ev);
    }
  }
  return events;
}

/** Atomic manifest write (temp + rename) so a crash mid-write never corrupts the cursor. */
function writeManifest(outDir: string, m: DumpManifest): void {
  const tmp = `${manifestPath(outDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, manifestPath(outDir));
}

function freshManifest(now: Date): DumpManifest {
  return {
    table: 'public.opening_captures',
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastId: null,
    rowsWritten: 0,
    distinctEvents: 0,
    shards: [],
    done: false,
  };
}

/**
 * One keyset batch: rows with id > cursor (or from the start when cursor is null), ordered by the bigint PK,
 * capped at `limit`. `to_jsonb(oc.*)` carries EVERY column (incl. the `buckets` bid/ask + the 0083 identity
 * cols) in Postgres's canonical JSON form; `id::text` is pulled separately as the loss-free keyset cursor.
 */
export async function fetchBatch(db: ScriptDb, cursor: string | null, limit: number): Promise<BatchRow[]> {
  return db.query<BatchRow>(
    `select oc.id::text                as cursor_id,
            oc.event_id::text          as event_id,
            to_jsonb(oc.*)             as row
       from public.opening_captures oc
      where ($1::bigint is null or oc.id > $1::bigint)
      order by oc.id
      limit $2::int`,
    [cursor, limit],
  );
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A returned batch is malformed when a row is missing its keyset cursor — the post-cancel dirty-connection case. */
const isMalformed = (rows: BatchRow[]): boolean => rows.length > 0 && (rows[0] == null || rows[0].cursor_id == null);

/**
 * Fetch one batch, adapting to contention. A statement timeout (57014) halves the batch (down to minBatch) and
 * retries the SAME cursor after a backoff; a malformed result — which postgres-js can return when the next read
 * reuses a connection still draining a just-cancelled query — also backs off and retries. Returns the rows AND
 * the (possibly shrunk) batch size to carry forward. Gives up after MAX_FETCH_FAILURES consecutive failures so a
 * genuinely wedged DB surfaces as an error (the resumable manifest lets a re-run continue from the last shard).
 */
export async function fetchBatchAdaptive(
  db: ScriptDb,
  cursor: string | null,
  batch: number,
  minBatch: number,
  log: (m: string) => void = () => {},
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<{ rows: BatchRow[]; batch: number }> {
  let failures = 0;
  for (;;) {
    let rows: BatchRow[] | null = null;
    try {
      rows = await fetchBatch(db, cursor, batch);
    } catch (e) {
      if (!isStatementTimeout(e)) throw e;
      failures += 1;
      const next = Math.max(minBatch, Math.floor(batch / 2));
      if (batch <= minBatch && failures >= MAX_FETCH_FAILURES) throw e; // wedged at the floor — let resume take over
      log(`statement timeout at batch=${batch} (cursor ${cursor}) — shrinking to ${next}, backing off ${RETRY_BACKOFF_MS}ms`);
      batch = next;
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    if (isMalformed(rows)) {
      failures += 1;
      if (failures >= MAX_FETCH_FAILURES) throw new Error(`repeated malformed batch results at cursor ${cursor} — aborting (re-run to resume)`);
      log(`malformed batch result at cursor ${cursor} (post-cancel drain) — backing off ${RETRY_BACKOFF_MS}ms and retrying`);
      await sleep(RETRY_BACKOFF_MS);
      continue;
    }
    return { rows, batch };
  }
}

/** Gzip a batch of rows as NDJSON and write it as one shard (temp + rename); returns the shard metadata. */
function writeShard(outDir: string, seq: number, rows: BatchRow[]): ShardMeta {
  const body = rows.map((r) => JSON.stringify(r.row)).join('\n') + '\n';
  const gz = gzipSync(Buffer.from(body, 'utf8'));
  const file = `part-${pad6(seq)}.ndjson.gz`;
  const tmp = join(outDir, `${file}.tmp`);
  writeFileSync(tmp, gz);
  renameSync(tmp, join(outDir, file));
  return { seq, file, rows: rows.length, firstId: rows[0]!.cursor_id, lastId: rows[rows.length - 1]!.cursor_id, bytesGz: gz.length };
}

/**
 * Dump the whole table in keyset batches, resuming from the manifest if present. Returns the final manifest.
 * Adaptive: a statement timeout halves the batch size (down to minBatchRows) and retries the SAME cursor, so
 * the dump slows under contention but does not break. Distinct event_ids are accumulated in memory for the
 * count(distinct event_id) cross-check (there are only a few thousand distinct events across the 283k rows).
 */
export async function dumpTable(db: ScriptDb, opts: DumpOpts = {}): Promise<DumpManifest> {
  const outDir = opts.outDir ?? OUT_ROOT;
  const startBatch = opts.batchRows ?? BATCH_ROWS;
  const minBatch = opts.minBatchRows ?? MIN_BATCH_ROWS;
  const log = opts.log ?? (() => {});
  mkdirSync(outDir, { recursive: true });

  const existing = opts.force ? null : readManifest(outDir);
  const manifest = existing ?? freshManifest(new Date());
  if (existing?.done && !opts.incremental) {
    log(`already complete: ${manifest.rowsWritten} rows in ${manifest.shards.length} shards (use --force to re-dump, --incremental to append new rows).`);
    return manifest;
  }

  // rebuild the distinct-event set so the resumed/appended run keeps an accurate count — prefer the
  // _events.json sidecar (instant; written at each completion), else scan the shards on disk.
  const events = new Set<string>();
  if (existing) {
    if (existsSync(eventsPath(outDir))) {
      for (const ev of JSON.parse(readFileSync(eventsPath(outDir), 'utf8')) as string[]) events.add(ev);
    } else {
      for (const s of existing.shards) {
        for (const ln of gunzipShard(outDir, s.file).toString('utf8').split('\n').filter(Boolean)) {
          const ev = (JSON.parse(ln) as { event_id?: string | null }).event_id;
          if (ev) events.add(ev);
        }
      }
    }
    manifest.done = false; // re-open for append/resume; the loop re-sets done when new rows are exhausted
    log(`${opts.incremental ? 'incremental append' : 'resuming'} from id > ${manifest.lastId} · ${manifest.rowsWritten} rows / ${events.size} events on disk.`);
  }

  let batch = startBatch;
  let newBatches = 0;
  for (;;) {
    if (opts.maxBatches !== undefined && newBatches >= opts.maxBatches) {
      log(`--max-batches ${opts.maxBatches} reached — stopping (not complete; re-run to continue).`);
      return manifest;
    }
    const fetched = await fetchBatchAdaptive(db, manifest.lastId, batch, minBatch, log);
    const rows = fetched.rows;
    batch = fetched.batch; // carry a shrunk batch forward — contention rarely eases mid-run
    if (rows.length === 0) break;

    const seq = manifest.shards.length + 1;
    const shard = writeShard(outDir, seq, rows);
    for (const r of rows) if (r.event_id) events.add(r.event_id);

    manifest.shards.push(shard);
    manifest.rowsWritten += rows.length;
    manifest.lastId = shard.lastId;
    manifest.distinctEvents = events.size;
    manifest.updatedAt = new Date().toISOString();
    writeManifest(outDir, manifest);
    newBatches += 1;
    log(`shard ${pad6(seq)}: ${rows.length} rows (id ${shard.firstId}..${shard.lastId}) · ${(shard.bytesGz / 1024).toFixed(0)} KB gz · total ${manifest.rowsWritten} rows / ${events.size} events`);

    if (rows.length < batch) break; // final partial batch
  }

  manifest.done = true;
  manifest.updatedAt = new Date().toISOString();
  writeManifest(outDir, manifest);
  // sidecar of the distinct event_ids — the prune's dump pre-flight index (instant to load, no shard scan).
  writeFileSync(eventsPath(outDir), JSON.stringify([...events].sort(), null, 0));
  log(`DONE: ${manifest.rowsWritten} rows · ${manifest.distinctEvents} distinct events · ${manifest.shards.length} shards.`);
  return manifest;
}

/** Read a shard's rows back (resume rebuilds the distinct-event set; the verify test reads shards directly). */
function gunzipShard(outDir: string, file: string): Buffer {
  return gunzipSync(readFileSync(join(outDir, file)));
}

export interface VerifyResult {
  manifestRows: number;
  manifestEvents: number;
  dbRows: number;
  dbEvents: number;
  rowsMatch: boolean;
  eventsMatch: boolean;
}

/**
 * Independent cross-check: re-walk the PK index selecting ONLY id + event_id (no `buckets` → no detoast → cheap,
 * survives the same contention that times out a full count(*)), and compare the live row/event counts to the
 * manifest. This is the C95 "verify dumped rowcount == count(*), count(distinct event_id)" step done in a way
 * that actually completes on the contended instance.
 */
export async function verifyDump(db: ScriptDb, outDir: string, batchRows = BATCH_ROWS): Promise<VerifyResult> {
  const manifest = readManifest(outDir);
  if (!manifest) throw new Error(`no manifest at ${outDir} — run the dump first`);
  const events = new Set<string>();
  let dbRows = 0;
  let cursor: string | null = null;
  let batch = batchRows;
  for (;;) {
    let rows: { cursor_id: string; event_id: string | null }[];
    try {
      rows = await db.query<{ cursor_id: string; event_id: string | null }>(
        `select oc.id::text as cursor_id, oc.event_id::text as event_id
           from public.opening_captures oc
          where ($1::bigint is null or oc.id > $1::bigint)
          order by oc.id limit $2::int`,
        [cursor, batch],
      );
    } catch (e) {
      if (isStatementTimeout(e) && batch > MIN_BATCH_ROWS) { batch = Math.max(MIN_BATCH_ROWS, Math.floor(batch / 2)); continue; }
      throw e;
    }
    if (rows.length === 0) break;
    dbRows += rows.length;
    for (const r of rows) if (r.event_id) events.add(r.event_id);
    cursor = rows[rows.length - 1]!.cursor_id;
    if (rows.length < batch) break;
  }
  return {
    manifestRows: manifest.rowsWritten,
    manifestEvents: manifest.distinctEvents,
    dbRows,
    dbEvents: events.size,
    rowsMatch: manifest.rowsWritten === dbRows,
    eventsMatch: manifest.distinctEvents === events.size,
  };
}

export interface CoverageResult {
  liveRows: number;
  /** live rows with id ≤ the archive's lastId — the id-prefix the archive is responsible for. */
  liveInPrefix: number;
  /** total rows archived (a SUPERSET of live once prunes have run — includes deleted rows). */
  archivedRows: number;
  maxLiveId: string;
  lastId: string | null;
  /** every live row in the archived id-prefix is archived. Holds by monotonic append-only ids; sanity-checked. */
  covered: boolean;
}

/**
 * Coverage check for an APPEND-ONLY (incremental) archive. After a prune the archive is a SUPERSET of the live
 * table, so verifyDump's exact match no longer holds. opening_captures ids are monotonic and rows append-only,
 * so every live row with id ≤ manifest.lastId was read (and archived) when its id-range was dumped. This
 * sanity-checks the invariant — the count of live rows in the archived prefix must not exceed the rows archived
 * (a superset). The per-EVENT coverage that authorises a delete (candidate maxId ≤ lastId) lives in the prune.
 */
export async function verifyCoverage(db: ScriptDb, outDir: string): Promise<CoverageResult> {
  const manifest = readManifest(outDir);
  if (!manifest) throw new Error(`no manifest at ${outDir} — run the dump first`);
  const lastId = manifest.lastId ?? '0';
  const [row] = await db.query<{ max_id: string; live: string; in_prefix: string }>(
    `select coalesce(max(id),0)::text                              as max_id,
            count(*)::text                                         as live,
            count(*) filter (where id <= $1::bigint)::text         as in_prefix
       from public.opening_captures`,
    [lastId],
  );
  const liveInPrefix = Number(row?.in_prefix ?? 0);
  return {
    liveRows: Number(row?.live ?? 0),
    liveInPrefix,
    archivedRows: manifest.rowsWritten,
    maxLiveId: row?.max_id ?? '0',
    lastId: manifest.lastId,
    covered: liveInPrefix <= manifest.rowsWritten,
  };
}

/** Stamp the manifest verified (shared by the exact-verify and coverage-verify paths). */
export function stampVerified(outDir: string, now = new Date()): void {
  const m = readManifest(outDir);
  if (!m) throw new Error(`no manifest at ${outDir}`);
  writeManifest(outDir, { ...m, verified: true, verifiedAt: now.toISOString() });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      verify: { type: 'boolean', default: false },
      'verify-coverage': { type: 'boolean', default: false },
      incremental: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      batch: { type: 'string' },
      'max-batches': { type: 'string' },
      dir: { type: 'string' },
    },
  });
  loadEnv();
  const outDir = values.dir ?? OUT_ROOT;
  const db = makeScriptDb();
  const reportCoverage = (c: Awaited<ReturnType<typeof verifyCoverage>>): boolean => {
    console.log('coverage (append-only archive) vs live table:');
    console.log(`  live rows       : ${c.liveRows}  (max id ${c.maxLiveId})`);
    console.log(`  live in prefix  : ${c.liveInPrefix}  (id ≤ archive lastId ${c.lastId})`);
    console.log(`  archived rows   : ${c.archivedRows}  (superset — includes pruned rows)`);
    console.log(`  → ${c.covered ? '✅ covered (every archived-prefix live row is in the archive)' : '❌ NOT covered'}`);
    return c.covered;
  };
  try {
    if (values['verify-coverage']) {
      if (reportCoverage(await verifyCoverage(db, outDir))) {
        stampVerified(outDir);
        console.log('  → stamped manifest.verified = true (prune dump pre-flight unlocked).');
      } else process.exitCode = 1;
      return;
    }
    if (values.verify) {
      const v = await verifyDump(db, outDir);
      console.log('verify opening_captures dump vs live table:');
      console.log(`  rows   : manifest ${v.manifestRows}  live ${v.dbRows}  ${v.rowsMatch ? '✅ match' : '❌ MISMATCH'}`);
      console.log(`  events : manifest ${v.manifestEvents}  live ${v.dbEvents}  ${v.eventsMatch ? '✅ match' : '❌ MISMATCH'}`);
      if (v.rowsMatch && v.eventsMatch) {
        stampVerified(outDir);
        console.log('  → stamped manifest.verified = true (prune dump pre-flight is now unlocked).');
      } else {
        process.exitCode = 1;
      }
      return;
    }
    await dumpTable(db, {
      outDir,
      force: values.force,
      incremental: values.incremental,
      batchRows: values.batch ? Number(values.batch) : undefined,
      maxBatches: values['max-batches'] ? Number(values['max-batches']) : undefined,
      log: console.log,
    });
    if (values.incremental) {
      // append-only archives self-verify via coverage (not exact match) and stamp the manifest.
      if (reportCoverage(await verifyCoverage(db, outDir))) {
        stampVerified(outDir);
        console.log('  → incremental append complete + coverage-verified; manifest.verified = true.');
      } else process.exitCode = 1;
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
