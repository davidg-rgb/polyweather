/**
 * scripts/ops/archive-retention — table-driven local archive→prune retention (STORAGE-TIERING.md).
 *
 * The storage-tiering rule: Supabase holds only the HOT WINDOW each live reader needs; the full history lives in
 * local gzipped NDJSON shards for training/testing/backtesting. For each configured table this:
 *   1. ARCHIVES every COMPLETED UTC day of rows (a day strictly before "today" — so it never races a live
 *      writer) to `scripts/research/out/<table>-archive/part-YYYY-MM-DD.ndjson.gz`, losslessly via `to_jsonb(t.*)`.
 *   2. VERIFIES each archived day (shard rowcount == live rowcount for that day) — the prune's pre-flight.
 *   3. PRUNES rows older than the table's hot window from Supabase, GATED on the day being a verified shard
 *      (no archive, no delete), in date-keyed batches.
 *
 * DRY-RUN BY DEFAULT (prints the plan + byte estimates). `--execute` writes shards + verifies (NON-destructive,
 * reclaims nothing). `--execute --prune` additionally deletes the verified cold tail; a VACUUM reminder is
 * printed (deleted heap/TOAST space is only returned to the OS after a vacuum).
 *
 * Why a LOCAL script, not a pg_cron: the archive is the operator's local disk, which a Supabase cron cannot
 * write — a blind cron prune would delete rows that were never archived. Tables with NO training value
 * (edge_evaluations) are pruned by the pg_cron `ops_downsample` instead (migration 0116); tables whose history
 * we KEEP for training/testing are archive-gated here. `opening_captures` has its OWN specialized
 * resolution-based tool (dump-/prune-opening-captures.ts) — run that for the raw order book, not this.
 *
 * Run: pnpm tsx scripts/ops/archive-retention.ts                            # dry-run: plan only
 *      pnpm tsx scripts/ops/archive-retention.ts --execute                  # archive completed days + verify
 *      pnpm tsx scripts/ops/archive-retention.ts --execute --prune          # + delete the verified cold tail
 *      pnpm tsx scripts/ops/archive-retention.ts --table market_rewards --execute --prune
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';

const OUT_BASE = join(dirname(fileURLToPath(import.meta.url)), '..', 'research', 'out');

/** rows per delete statement — keeps each prune statement small and index-driven. */
export const PRUNE_BATCH_ROWS = 5000;
/** guards identifier interpolation: config table/column names must be plain lowercase identifiers. */
const IDENT = /^[a-z_][a-z0-9_]*$/;

export interface RetentionConfig {
  /** table to archive+prune (identifier, not user input). */
  table: string;
  /** the timestamptz column defining a row's day + age. */
  tsColumn: string;
  /** keep rows newer than this many days in Supabase; older days are archived then pruned. */
  hotWindowDays: number;
  /** why this window is safe — the deepest live reader need. */
  note: string;
}

/**
 * The keep-the-bulk-local tables. edge_evaluations is deliberately ABSENT — it has no training value (no
 * research reader; live /events wants only the latest ~44 rows/event), so it is pruned by the pg_cron
 * (0116, 30→7d), not archived. opening_captures is ABSENT — its raw book uses the specialized dump/prune.
 */
export const RETENTION: RetentionConfig[] = [
  {
    table: 'market_rewards',
    tsColumn: 'captured_at',
    hotWindowDays: 14,
    note: 'reward signal CLOSED (last write 2026-07-06); /rewards page reads ≤7d — 14d keeps margin',
  },
  {
    table: 'model_stats_history',
    tsColumn: 'created_at',
    hotWindowDays: 7,
    note: 'calibration audit log; no live or research reader — 7d on free tier (was 30d)',
  },
  // ── FREE-TIER WINDOWS (2026-08-02, FREE-TIER-MIGRATION.md) ────────────────────────────────────────────
  // The 500 MB ceiling forces the hot window down to what LIVE readers need; every pruned row is archived
  // locally first (verify-gated), so the statistics record is COMPLETE on disk — only the server copy shrinks.
  {
    table: 'market_snapshots',
    tsColumn: 'captured_at',
    hotWindowDays: 3,
    note: 'top-of-book history; live readers (/events, panels) want days not months — full path archive also lives in market-history-flat.parquet',
  },
  {
    table: 'bucket_probabilities',
    tsColumn: 'made_at',
    hotWindowDays: 7,
    note: 'house distributions; panels replay open events (≤3d life) — 7d is 2× the deepest live need',
  },
  {
    table: 'forecast_snapshots',
    tsColumn: 'captured_at',
    hotWindowDays: 25,
    note: 'THE forecasting panel. Calibration reads residuals via model_stats (kept warm); 25d covers the longest lead (16d) plus grading lag with margin. Full history archived locally for training.',
  },
  {
    table: 'job_runs',
    tsColumn: 'started_at',
    hotWindowDays: 7,
    note: 'ops log; deadman checks read the last few runs — 7d is generous',
  },
  // ── CLOSED-SIGNAL TABLES ──────────────────────────────────────────────────────────────────────────────
  // Their producing job is unscheduled (2026-08-02) so these are static datasets, not growing ones. They are
  // archived in full and reduced to a 1-day stub on the server: the verdicts are written up in the canonical
  // docs, and the raw record lives on disk. Re-import from the shards if a signal is ever reopened.
  {
    table: 'complete_set_depth_captures',
    tsColumn: 'captured_at',
    hotWindowDays: 1,
    note: 'complete-set arb — KILLED (fee wall); capture job unscheduled',
  },
  {
    table: 'convergence_panel',
    tsColumn: 'captured_at',
    hotWindowDays: 1,
    note: 'opening-convergence forward panel — signal CLOSED 2026-07-07',
  },
  {
    table: 'maker_exit_panel',
    tsColumn: 'captured_at',
    hotWindowDays: 1,
    note: 'maker-exit forward panel — gate rendered KILL 2026-07-07',
  },
  {
    table: 'whale_trades',
    tsColumn: 'traded_at',
    hotWindowDays: 1,
    note: 'whale alarm — no insider signature found; whale-watch unscheduled',
  },
  {
    table: 'wallet_positions_daily',
    tsColumn: 'created_at',
    hotWindowDays: 1,
    note: 'sharp-wallet recon — all 5 angles falsified',
  },
  {
    table: 'wallet_bet_calibration',
    tsColumn: 'recorded_at',
    hotWindowDays: 1,
    note: 'sharp-wallet recon — all 5 angles falsified',
  },
  {
    table: 'synoptic_obs',
    tsColumn: 'obs_at',
    hotWindowDays: 1,
    note: 'US 5-min obs — capture-only lane, unscheduled 2026-08-02 (trial would have ended ~08-08)',
  },
];

/** One archived UTC day: shard file + its row/byte counts, plus verify/prune state. */
export interface DayShard {
  day: string; // YYYY-MM-DD (UTC)
  file: string;
  rows: number;
  bytesGz: number;
  verified: boolean;
  pruned: boolean;
}

export interface ArchiveManifest {
  table: string;
  tsColumn: string;
  updatedAt: string;
  /** archived days, keyed by YYYY-MM-DD. */
  days: Record<string, DayShard>;
}

const assertIdent = (s: string): string => {
  if (!IDENT.test(s)) throw new Error(`unsafe identifier ${JSON.stringify(s)} — expected a plain [a-z_][a-z0-9_]* name`);
  return s;
};

export const archiveDir = (table: string, base = OUT_BASE): string => join(base, `${table}-archive`);
const manifestPath = (dir: string): string => join(dir, '_manifest.json');
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export function readArchiveManifest(dir: string): ArchiveManifest | null {
  const p = manifestPath(dir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as ArchiveManifest) : null;
}

/** Atomic manifest write (temp + rename) so a crash mid-write never corrupts it. */
function writeArchiveManifest(dir: string, m: ArchiveManifest): void {
  const tmp = `${manifestPath(dir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, manifestPath(dir));
}

export interface DayCount {
  day: string;
  rows: number;
}

/**
 * Live row counts per COMPLETED UTC day (day strictly < today's UTC date, so never racing an in-flight writer).
 * Only days with rows are returned, oldest first.
 */
export async function liveCompletedDays(
  db: ScriptDb,
  cfg: RetentionConfig,
  now: Date,
): Promise<DayCount[]> {
  const ts = assertIdent(cfg.tsColumn);
  const tbl = assertIdent(cfg.table);
  const rows = await db.query<{ day: string; rows: string }>(
    `select to_char((${ts} at time zone 'UTC')::date, 'YYYY-MM-DD') as day, count(*)::text as rows
       from public.${tbl}
      where (${ts} at time zone 'UTC')::date < $1::date
      group by 1
      order by 1`,
    [utcDay(now)],
  );
  return rows.map((r) => ({ day: r.day, rows: Number(r.rows) }));
}

/** Read one completed day's rows losslessly (to_jsonb owns the type→JSON mapping) and gzip them as an NDJSON shard. */
export async function archiveDay(db: ScriptDb, cfg: RetentionConfig, day: string, dir: string): Promise<DayShard> {
  const ts = assertIdent(cfg.tsColumn);
  const tbl = assertIdent(cfg.table);
  const rows = await db.query<{ row: Record<string, unknown> }>(
    `select to_jsonb(t.*) as row
       from public.${tbl} t
      where (${ts} at time zone 'UTC')::date = $1::date
      order by ${ts}`,
    [day],
  );
  const body = rows.map((r) => JSON.stringify(r.row)).join('\n') + (rows.length ? '\n' : '');
  const gz = gzipSync(Buffer.from(body, 'utf8'));
  const file = `part-${day}.ndjson.gz`;
  const tmp = join(dir, `${file}.tmp`);
  writeFileSync(tmp, gz);
  renameSync(tmp, join(dir, file));
  return { day, file, rows: rows.length, bytesGz: gz.length, verified: false, pruned: false };
}

/** Live count for a single day — the verify + prune-preflight primitive. */
export async function liveDayCount(db: ScriptDb, cfg: RetentionConfig, day: string): Promise<number> {
  const ts = assertIdent(cfg.tsColumn);
  const tbl = assertIdent(cfg.table);
  const r = await db.query<{ n: string }>(
    `select count(*)::text as n from public.${tbl} where (${ts} at time zone 'UTC')::date = $1::date`,
    [day],
  );
  return Number(r[0]?.n ?? 0);
}

/**
 * Archive every completed day not already archived, then (re)verify each non-pruned archived day against the
 * live table. Returns the updated manifest. NON-DESTRUCTIVE.
 */
export async function archiveAndVerify(
  db: ScriptDb,
  cfg: RetentionConfig,
  dir: string,
  now: Date,
  log: (m: string) => void = () => {},
): Promise<ArchiveManifest> {
  mkdirSync(dir, { recursive: true });
  const manifest: ArchiveManifest =
    readArchiveManifest(dir) ?? { table: cfg.table, tsColumn: cfg.tsColumn, updatedAt: now.toISOString(), days: {} };

  const completed = await liveCompletedDays(db, cfg, now);
  const liveByDay = new Map(completed.map((c) => [c.day, c.rows]));

  // (re)archive: a day absent from the manifest, OR a non-pruned archived day whose LIVE count has GROWN (a late
  // row landed in that past day) so its shard is now missing rows — re-snapshot it. This SELF-HEALS drift instead
  // of leaving the day permanently unverified (which would wedge the whole table's prune). A day whose live count
  // shrank is left as-is: the archive is then a superset of live, which still covers every live row.
  for (const { day, rows } of completed) {
    const d = manifest.days[day];
    if (d?.pruned) continue; // pruned days are immutable
    if (!d || rows > d.rows) {
      const shard = await archiveDay(db, cfg, day, dir);
      manifest.days[day] = shard;
      log(`  ${d ? 're-archived (drift)' : 'archived'} ${day}: ${shard.rows} rows · ${(shard.bytesGz / 1024).toFixed(0)} KB gz`);
    }
  }

  // verify each non-pruned archived day: COVERED iff the archive holds ≥ its live rows (archive ⊇ live ⇒ every
  // live row is archived ⇒ safe to prune). After the re-archive above this holds for every drift-up day.
  for (const day of Object.keys(manifest.days).sort()) {
    const d = manifest.days[day]!;
    if (d.pruned) continue;
    const live = liveByDay.get(day) ?? (await liveDayCount(db, cfg, day));
    d.verified = d.rows >= live;
    if (!d.verified) log(`  ⚠ verify UNCOVERED ${day}: shard ${d.rows} < live ${live} — will NOT prune this day`);
  }

  manifest.updatedAt = now.toISOString();
  writeArchiveManifest(dir, manifest);
  return manifest;
}

export interface PrunePlan {
  cutoffDay: string;
  /** days eligible to prune (archived + verified + older than the hot window). */
  prunable: DayShard[];
  /** days older than the window that are NOT safe to prune (missing/unverified archive). */
  blocked: { day: string; reason: string }[];
}

/** Which archived days may be deleted: strictly older than the hot-window cutoff AND verified. */
export function planPrune(manifest: ArchiveManifest, cfg: RetentionConfig, now: Date): PrunePlan {
  const cutoff = new Date(now.getTime() - cfg.hotWindowDays * 86_400_000);
  const cutoffDay = utcDay(cutoff);
  const prunable: DayShard[] = [];
  const blocked: { day: string; reason: string }[] = [];
  for (const day of Object.keys(manifest.days).sort()) {
    if (day >= cutoffDay) continue; // inside the hot window — keep
    const d = manifest.days[day]!;
    if (d.pruned) continue; // already gone
    if (d.verified) prunable.push(d);
    else blocked.push({ day, reason: 'archive unverified (shard≠live)' });
  }
  return { cutoffDay, prunable, blocked };
}

/**
 * Delete the verified cold tail day-by-day in ≤batchRows statements, marking each day `pruned` in the manifest.
 * Refuses if any older-than-window day is blocked (no archive, no delete).
 */
export async function executePrune(
  db: ScriptDb,
  cfg: RetentionConfig,
  dir: string,
  manifest: ArchiveManifest,
  plan: PrunePlan,
  batchRows = PRUNE_BATCH_ROWS,
  log: (m: string) => void = () => {},
): Promise<number> {
  if (plan.blocked.length > 0) {
    throw new Error(
      `executePrune refused for ${cfg.table}: ${plan.blocked.length} cold day(s) not safely archived — no archive, no delete`,
    );
  }
  const ts = assertIdent(cfg.tsColumn);
  const tbl = assertIdent(cfg.table);
  let total = 0;
  for (const d of plan.prunable) {
    let dayDeleted = 0;
    for (;;) {
      const del = await db.query<{ n: string }>(
        `with victims as (
           select ctid from public.${tbl}
            where (${ts} at time zone 'UTC')::date = $1::date
            limit $2
         )
         delete from public.${tbl} t using victims v where t.ctid = v.ctid
         returning 1 as n`,
        [d.day, batchRows],
      );
      total += del.length;
      dayDeleted += del.length;
      if (del.length < batchRows) break;
    }
    manifest.days[d.day] = { ...d, pruned: true };
    writeArchiveManifest(dir, manifest);
    log(`  pruned ${d.day}: ${dayDeleted} rows deleted`);
  }
  return total;
}

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function runTable(
  db: ScriptDb,
  cfg: RetentionConfig,
  opts: { execute: boolean; prune: boolean; base: string; now: Date },
): Promise<void> {
  const dir = archiveDir(cfg.table, opts.base);
  console.log(`\n=== ${cfg.table} — hot window ${cfg.hotWindowDays}d ===`);
  console.log(`  ${cfg.note}`);

  if (!opts.execute) {
    // dry-run: report what WOULD archive + prune without writing anything.
    const completed = await liveCompletedDays(db, cfg, opts.now);
    const existing = readArchiveManifest(dir);
    // mirror archiveAndVerify's (re)archive predicate exactly: a day is (re)archived iff it is absent, or a
    // non-pruned day whose live count grew (drift-up). Already-archived unpruned days are NOT counted.
    const toArchive = completed.filter((c) => {
      const d = existing?.days[c.day];
      return !d || (!d.pruned && c.rows > d.rows);
    });
    const cutoffDay = utcDay(new Date(opts.now.getTime() - cfg.hotWindowDays * 86_400_000));
    const coldRows = completed.filter((c) => c.day < cutoffDay).reduce((s, c) => s + c.rows, 0);
    console.log(`  DRY-RUN: ${completed.length} completed day(s) on the server (${toArchive.length} to (re)archive);`);
    console.log(`           ~${coldRows} rows older than ${cutoffDay} would be archived+pruned. Re-run with --execute.`);
    return;
  }

  const manifest = await archiveAndVerify(db, cfg, dir, opts.now, (m) => console.log(m));
  const archivedRows = Object.values(manifest.days).reduce((s, d) => s + d.rows, 0);
  const archivedGz = Object.values(manifest.days).reduce((s, d) => s + d.bytesGz, 0);
  console.log(`  archive: ${Object.keys(manifest.days).length} day-shards · ${archivedRows} rows · ${mb(archivedGz)} gz on disk.`);

  const plan = planPrune(manifest, cfg, opts.now);
  if (plan.blocked.length > 0) {
    console.log(`  ⛔ ${plan.blocked.length} cold day(s) NOT safely archived — skipping their prune:`);
    for (const b of plan.blocked) console.log(`     ${b.day}: ${b.reason}`);
  }
  if (!opts.prune) {
    console.log(`  ${plan.prunable.length} verified day(s) are prune-eligible (older than ${plan.cutoffDay}). Add --prune to delete them.`);
    return;
  }
  const deleted = await executePrune(db, cfg, dir, manifest, plan, PRUNE_BATCH_ROWS, (m) => console.log(m));
  console.log(`  PRUNED ${deleted} rows across ${plan.prunable.length} day(s).`);
  if (deleted > 0) console.log(`  NOW RUN (operator, quiet window): VACUUM (ANALYZE) public.${cfg.table};`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      execute: { type: 'boolean', default: false },
      prune: { type: 'boolean', default: false },
      table: { type: 'string' },
      'out-dir': { type: 'string' },
    },
  });
  loadEnv();
  const base = values['out-dir'] ?? OUT_BASE;
  const now = new Date();
  const configs = values.table ? RETENTION.filter((c) => c.table === values.table) : RETENTION;
  if (configs.length === 0) throw new Error(`no retention config for table ${JSON.stringify(values.table)} (known: ${RETENTION.map((c) => c.table).join(', ')})`);
  if (values.prune && !values.execute) throw new Error('--prune requires --execute (archive+verify must run before any delete)');

  console.log(`archive-retention — ${values.execute ? (values.prune ? 'ARCHIVE + PRUNE' : 'ARCHIVE (no delete)') : 'DRY-RUN'} · ${configs.length} table(s)`);
  const db = makeScriptDb();
  try {
    for (const cfg of configs) await runTable(db, cfg, { execute: values.execute, prune: values.prune, base, now });
  } finally {
    await db.end();
  }
  console.log('\nopening_captures raw book → use the specialized dump-/prune-opening-captures.ts (resolution-based).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
