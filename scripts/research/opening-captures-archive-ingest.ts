/**
 * scripts/research/opening-captures-archive-ingest — the ON-DISK ARCHIVE loader for the opening-convergence
 * capture series (the archive twin of opening-bracket-score's `loadEvents`, which reads the live DB table).
 *
 * WHY THIS EXISTS. `public.opening_captures` is pruned to a ~2-day hot window by the storage tiering
 * (STORAGE-TIERING.md), so the live query can only ever see ~2 days of book. The FULL history — the only
 * historical bid/ask archive this project has — lives on disk as gzipped NDJSON shards at
 * `scripts/research/out/opening-captures-archive/` (835 distinct events / ~312k tick rows / ~548 MB gz,
 * dumped 2026-07-21 before the prune). Any powered convergence backtest MUST read the archive, not the table.
 *
 * TWO SHAPE GAPS the loader closes (both verified against the real shards, 2026-07-24):
 *   1. Archive rows are **snake_case** (`event_id`, `tz_name`, `hours_since_listing`, …) — the DB harness query
 *      aliases those to camelCase in SQL. `mapArchiveRow` does that mapping here instead, producing the exact
 *      `RawCaptureRow` shape `buildEvents` already consumes (ONE tested grouping path, shared with the live
 *      scorer + the /convergence dashboard loader).
 *   2. `buckets` is already a JS array of camelCase objects (`execAsk`, `houseProb`, …) — passed through
 *      verbatim to `mapBucket`. NOTE: the earliest shards predate the exit-side capture columns, so a bucket may
 *      simply LACK `execBid` / `sellbackDepthUsd` / `mid`; mapBucket's numOrNull/num0 already coalesce those to
 *      null/0, which the replay engine reads as "no realizable exit mark" (hold), never as a 0¢ bid.
 *
 * RESOLUTION (`winnerIdx`) is NOT in the archive — it comes from `public.market_events`
 * (`poly_resolved_winner_idx ?? winning_bucket_idx`), which is NOT pruned. Coverage is REPORTED, never assumed:
 * not every archived event has a `market_events` row (the buy-table live universe is absent from it), and a
 * silent drop would bias the panel toward whichever population happens to be resolvable.
 *
 * Read-only + keyless apart from the resolution join (one chunked `id = any($1::uuid[])` SELECT). Writes
 * nothing, places nothing, never imports packages/trading.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import type { ScriptDb } from '../lib/script-db.ts';
import {
  buildEvents,
  type RawBucket,
  type RawCaptureRow,
  type Resolution,
} from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { loadResolutionMap } from './opening-bracket-score.ts';

export const ARCHIVE_DIR = 'scripts/research/out/opening-captures-archive';
/** the older 2026-07-07 dump — identical row/bucket shapes, contributes genuine pre-07-06 events the primary lacks. */
export const ARCHIVE_DIR_C96 = 'scripts/research/out/opening-captures-archive-c96-20260707';
/** default merge order: the primary archive WINS every event_id collision; c96 only adds what the primary lacks. */
export const DEFAULT_ARCHIVE_DIRS = [ARCHIVE_DIR, ARCHIVE_DIR_C96];
/** `id = any($1::uuid[])` batch size for the market_events resolution join. */
export const RESOLUTION_CHUNK = 500;

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const numOrNull = (v: unknown): number | null => (fin(v) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** One raw archive NDJSON line (the `opening_captures` row as pg_dump-style JSON — snake_case, camelCase buckets). */
export interface ArchiveRow {
  id?: unknown;
  city?: unknown;
  buckets?: unknown;
  tz_name?: unknown;
  event_id?: unknown;
  neg_risk?: unknown;
  peak_mid?: unknown;
  ev_vol24h?: unknown;
  captured_at?: unknown;
  resolves_at?: unknown;
  target_date?: unknown;
  house_seeded?: unknown;
  is_flat_open?: unknown;
  created_at_gamma?: unknown;
  hours_since_listing?: unknown;
  listing_detected_at?: unknown;
}

/** The `_manifest.json` shard index written by the dump job. */
export interface ArchiveManifest {
  table?: string;
  rowsWritten?: number;
  distinctEvents?: number;
  shards?: { seq?: number; file?: string; rows?: number }[];
}

/**
 * Map ONE snake_case archive row → the camelCase `RawCaptureRow` the core ingest consumes. Pure + total (junk →
 * nulls, never throws). `buckets` passes through as-is (already camelCase); a non-array becomes null so
 * buildEvents' `Array.isArray` guard yields an empty tick rather than a crash.
 */
export function mapArchiveRow(raw: ArchiveRow): RawCaptureRow {
  return {
    eventId: raw.event_id == null ? null : String(raw.event_id),
    capturedAt: String(raw.captured_at ?? ''),
    city: strOrNull(raw.city),
    targetDate: strOrNull(raw.target_date),
    tzName: strOrNull(raw.tz_name),
    createdAtGamma: strOrNull(raw.created_at_gamma),
    resolvesAt: strOrNull(raw.resolves_at),
    hoursSinceListing: numOrNull(raw.hours_since_listing),
    peakMid: numOrNull(raw.peak_mid),
    isFlatOpen: raw.is_flat_open == null ? null : raw.is_flat_open === true,
    houseSeeded: raw.house_seeded == null ? null : raw.house_seeded === true,
    buckets: Array.isArray(raw.buckets) ? (raw.buckets as RawBucket[]) : null,
    evVol24h: numOrNull(raw.ev_vol24h),
    negRisk: raw.neg_risk == null ? null : raw.neg_risk === true,
  };
}

/** Every drop the loader made, so a shrunken panel is never a silent one. */
export interface ArchiveLoadStats {
  shardsRead: number;
  rowsRead: number;
  /** rows with `event_id = null` (unlinked captures — cannot be grouped or resolved). */
  rowsDroppedNullEventId: number;
  /** rows dropped by the optional city filter. */
  rowsDroppedCityFilter: number;
  rowsKept: number;
  /** the archive dirs read, in PRECEDENCE order (dirs[0] wins an event_id collision). */
  dirsRead: string[];
  /** rows dropped because an EARLIER dir already owns that event_id (the de-dup, not a data loss). */
  rowsDroppedDuplicateEvent: number;
  /** distinct events each dir contributed AFTER de-dup — so "+N events for free" is auditable, not asserted. */
  eventsPerDir: { dir: string; events: number }[];
  /** distinct event ids surviving the null/city drops — the archive population this run considers. */
  archiveEvents: number;
  /** …of which had a `market_events` resolution row. */
  eventsWithResolution: number;
  /** …of which did NOT (they replay, but a still-open position marks to last bid instead of settling). */
  eventsWithoutResolution: number;
  /** events buildEvents KEPT after its FRESH-universe filter (min hours_since_listing < 1). */
  eventsAfterFreshFilter: number;
  /** archiveEvents − eventsAfterFreshFilter (the fresh-listing gate's own drop). */
  eventsDroppedNotFresh: number;
  ticks: number;
  cities: string[];
}

export interface ArchiveLoad {
  events: EventReplayInput[];
  stats: ArchiveLoadStats;
}

export interface LoadArchiveOpts {
  /** the archive directory (defaults to ARCHIVE_DIR, relative to cwd). Ignored when `dirs` is given. */
  dir?: string;
  /**
   * SEVERAL archives merged into one panel, in PRECEDENCE order — dirs[0] owns an event_id collision and every
   * later dir's rows for that event are dropped whole (never interleaved: two independent dumps of the same
   * series would otherwise double-count ticks and corrupt the tick ordering the no-look-ahead walk depends on).
   * Used to merge the primary archive with the older c96-20260707 dump, which contributes genuine pre-07-06
   * events the primary never captured.
   */
  dirs?: string[];
  /** optional city allowlist (undefined/empty = every city in the archive). */
  cities?: string[];
  /** read only the first N shards — SMOKE RUNS ONLY (see the truncation warning on readArchiveRows). */
  maxShards?: number;
  /** the resolution join; omit for a pure disk read with no resolutions (every event unresolved). */
  db?: ScriptDb;
  /** progress sink (defaults to silent). */
  onProgress?: (msg: string) => void;
}

/** the shard file list from `_manifest.json` (falls back to nothing if the manifest is missing/!readable). */
export function readManifest(dir: string): ArchiveManifest {
  const path = join(dir, '_manifest.json');
  if (!existsSync(path)) throw new Error(`archive manifest not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8')) as ArchiveManifest;
}

/**
 * Stream every shard's NDJSON lines, mapping + filtering as we go (one gunzip stream at a time, so peak memory
 * is the KEPT rows, not the whole 548 MB archive).
 *
 * ⚠ `maxShards` TRUNCATES CHRONOLOGICALLY. Shards are ordered by the source table's `id` (insertion order), so
 * the first N shards are the EARLIEST rows globally — an event straddling the cut keeps only its early ticks.
 * That is fine for a pipeline smoke test and INVALID for a verdict (a truncated series cannot take profit or
 * settle). Any scored run must read every shard.
 */
export async function readArchiveRows(
  dir: string,
  opts: { cities?: string[]; maxShards?: number; onProgress?: (m: string) => void } = {},
): Promise<{ rows: RawCaptureRow[]; stats: Pick<ArchiveLoadStats, 'shardsRead' | 'rowsRead' | 'rowsDroppedNullEventId' | 'rowsDroppedCityFilter' | 'rowsKept'> }> {
  const manifest = readManifest(dir);
  const allow = new Set((opts.cities ?? []).filter((c) => typeof c === 'string' && c.length > 0));
  const files = (manifest.shards ?? [])
    .map((s) => String(s?.file ?? ''))
    .filter((f) => f.length > 0)
    .slice(0, opts.maxShards != null && opts.maxShards > 0 ? Math.floor(opts.maxShards) : undefined);

  const rows: RawCaptureRow[] = [];
  let rowsRead = 0;
  let rowsDroppedNullEventId = 0;
  let rowsDroppedCityFilter = 0;
  let shardsRead = 0;

  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      rowsRead++;
      let raw: ArchiveRow;
      try {
        raw = JSON.parse(line) as ArchiveRow;
      } catch {
        continue; // a torn line is a dropped tick, never a crashed run
      }
      if (raw.event_id == null) {
        rowsDroppedNullEventId++;
        continue;
      }
      if (allow.size > 0 && !allow.has(String(raw.city ?? ''))) {
        rowsDroppedCityFilter++;
        continue;
      }
      rows.push(mapArchiveRow(raw));
    }
    shardsRead++;
    if (shardsRead % 25 === 0) opts.onProgress?.(`  …${shardsRead}/${files.length} shards · ${rows.length} rows kept`);
  }

  return { rows, stats: { shardsRead, rowsRead, rowsDroppedNullEventId, rowsDroppedCityFilter, rowsKept: rows.length } };
}

/** Chunked `market_events` resolution join (reuses the live scorer's loadResolutionMap verbatim — ONE query shape). */
export async function loadResolutions(db: ScriptDb, ids: string[]): Promise<Map<string, Resolution>> {
  const out = new Map<string, Resolution>();
  for (let i = 0; i < ids.length; i += RESOLUTION_CHUNK) {
    const chunk = ids.slice(i, i + RESOLUTION_CHUNK);
    const m = await loadResolutionMap(db, chunk);
    for (const [k, v] of m) out.set(k, v);
  }
  return out;
}

/** The full archive → `EventReplayInput[]` pipeline + the explicit coverage accounting. */
export async function loadArchiveEvents(opts: LoadArchiveOpts = {}): Promise<ArchiveLoad> {
  const dirs = (opts.dirs?.length ? opts.dirs : [opts.dir ?? ARCHIVE_DIR]).filter((d) => existsSync(d));
  if (dirs.length === 0) throw new Error(`no readable archive dir among: ${(opts.dirs ?? [opts.dir ?? ARCHIVE_DIR]).join(', ')}`);

  // read in PRECEDENCE order; the first dir to contribute an event_id OWNS it (later dirs' rows for that event
  // are dropped whole — see the `dirs` doc comment on why interleaving two dumps of one series is unsafe).
  const rows: RawCaptureRow[] = [];
  const owned = new Set<string>();
  const eventsPerDir: { dir: string; events: number }[] = [];
  const rowStats = { shardsRead: 0, rowsRead: 0, rowsDroppedNullEventId: 0, rowsDroppedCityFilter: 0, rowsKept: 0 };
  let rowsDroppedDuplicateEvent = 0;
  for (const dir of dirs) {
    opts.onProgress?.(`  reading ${dir}…`);
    const r = await readArchiveRows(dir, { cities: opts.cities, maxShards: opts.maxShards, onProgress: opts.onProgress });
    const fresh = new Set<string>();
    for (const row of r.rows) {
      const id = row.eventId;
      if (id == null) continue;
      if (owned.has(id)) { rowsDroppedDuplicateEvent++; continue; }
      fresh.add(id);
      rows.push(row);
    }
    for (const id of fresh) owned.add(id);
    eventsPerDir.push({ dir, events: fresh.size });
    rowStats.shardsRead += r.stats.shardsRead;
    rowStats.rowsRead += r.stats.rowsRead;
    rowStats.rowsDroppedNullEventId += r.stats.rowsDroppedNullEventId;
    rowStats.rowsDroppedCityFilter += r.stats.rowsDroppedCityFilter;
  }
  rowStats.rowsKept = rows.length;

  const ids = [...new Set(rows.map((r) => r.eventId).filter((v): v is string => !!v))];
  const resMap = opts.db ? await loadResolutions(opts.db, ids) : new Map<string, Resolution>();
  const eventsWithResolution = ids.filter((id) => resMap.has(id)).length;

  const events = buildEvents(rows, resMap);
  return {
    events,
    stats: {
      ...rowStats,
      dirsRead: dirs,
      rowsDroppedDuplicateEvent,
      eventsPerDir,
      archiveEvents: ids.length,
      eventsWithResolution,
      eventsWithoutResolution: ids.length - eventsWithResolution,
      eventsAfterFreshFilter: events.length,
      eventsDroppedNotFresh: ids.length - events.length,
      ticks: events.reduce((a, e) => a + e.ticks.length, 0),
      cities: [...new Set(events.map((e) => e.city))].sort(),
    },
  };
}
