/**
 * scripts/ops/free-tier-sweep — the ONE weekly local command that keeps Supabase under the free-tier
 * 500 MB ceiling (FREE-TIER-MIGRATION.md).
 *
 * WHY THIS EXISTS: on the free tier the database is capped at 500 MB, and an over-limit project is put into
 * READ-ONLY mode — which would silently stop every capture job, i.e. lose exactly the forward statistics this
 * project exists to accumulate. Capture must stay in the cloud (it is time-critical and must run when the
 * laptop is off), but STORAGE moves local: Supabase keeps only the hot window each live reader needs, and the
 * complete history lives in local gzipped NDJSON shards. That split only holds if the archive→prune sweep
 * actually runs on a cadence — hence one command instead of four remembered ones.
 *
 * Steady-state arithmetic (2026-08-02 cadences): the surviving capture jobs add roughly 100–120 MB/week.
 * With the configured hot windows the server settles near ~280–350 MB. Skipping the sweep for ~2 weeks is
 * what puts the project at the ceiling — the printed headroom line is the early warning.
 *
 * WHAT IT RUNS (in order, each step gated on the previous one's archive being verified — no archive, no delete):
 *   1. dump-opening-captures --incremental   → append new raw-book rows to the local archive + verify coverage
 *   2. prune-opening-captures --preflight dump --resolved-age-days N --execute → drop archived resolved ticks
 *   3. archive-retention --execute --prune   → archive completed days then prune the verified cold tail
 *   4. VACUUM (ANALYZE) the pruned tables    → makes the freed space reusable, refreshes the planner
 *   5. report pg_database_size + headroom vs the 500 MB ceiling
 *
 * VACUUM vs VACUUM FULL: this runs plain VACUUM, which makes space REUSABLE by Postgres but does not return
 * it to the OS — correct for a weekly sweep (no exclusive lock, no double-disk transient). A one-time
 * VACUUM FULL is what actually shrinks the files; run that manually (--full) after a large backlog prune,
 * never while capture jobs are mid-write.
 *
 * DRY-RUN BY DEFAULT: prints each step's plan without deleting. `--execute` performs the prunes.
 *
 * Run: pnpm tsx scripts/ops/free-tier-sweep.ts                 # dry-run: show the whole plan
 *      pnpm tsx scripts/ops/free-tier-sweep.ts --execute       # the weekly sweep
 *      pnpm tsx scripts/ops/free-tier-sweep.ts --execute --full # + VACUUM FULL (one-time reclaim; locks tables)
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
/** free-tier hard ceiling; an over-limit project goes READ-ONLY (capture stops). */
export const FREE_TIER_LIMIT_MB = 500;
/** warn below this much remaining headroom — roughly one week of capture growth. */
export const HEADROOM_WARN_MB = 120;
/** resolved-event age past which archived raw-book ticks are dropped (the panel replays open events only). */
export const OC_RESOLVED_AGE_DAYS = 1;
/** tables the sweep vacuums (the ones archive-retention + the raw-book prune delete from). */
export const SWEPT_TABLES = [
  'opening_captures', 'market_snapshots', 'bucket_probabilities',
  'forecast_snapshots', 'job_runs', 'model_stats_history', 'market_rewards',
];

const run = (label: string, args: string[]): boolean => {
  console.log(`\n──────── ${label} ────────`);
  const r = spawnSync('pnpm', ['tsx', ...args], { stdio: 'inherit', shell: true, cwd: join(SCRIPTS, '..', '..') });
  if (r.status !== 0) console.error(`✗ ${label} exited ${r.status ?? 'null'} — later steps still run (each is independently archive-gated)`);
  return r.status === 0;
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { execute: { type: 'boolean' }, full: { type: 'boolean' } } });
  const execute = values.execute === true;
  const full = values.full === true;
  console.log(execute ? '=== FREE-TIER SWEEP — EXECUTE ===' : '=== FREE-TIER SWEEP — DRY-RUN (pass --execute) ===');

  loadEnv();
  const db = makeScriptDb();
  const before = await db.query<{ mb: number }>(
    `select round(pg_database_size(current_database())/1048576.0, 1) as mb`,
  );
  console.log(`database before: ${before[0]?.mb} MB / ${FREE_TIER_LIMIT_MB} MB ceiling`);

  run('1/5 raw-book archive (incremental)', ['scripts/ops/dump-opening-captures.ts', '--incremental']);

  const ocArgs = ['scripts/ops/prune-opening-captures.ts', '--preflight', 'dump',
                  '--resolved-age-days', String(OC_RESOLVED_AGE_DAYS)];
  run('2/5 raw-book prune (dump-gated)', execute ? [...ocArgs, '--execute'] : ocArgs);

  const arArgs = ['scripts/ops/archive-retention.ts', '--execute'];
  run('3/5 table archive + cold-tail prune', execute ? [...arArgs, '--prune'] : arArgs);

  if (execute) {
    console.log(`\n──────── 4/5 ${full ? 'VACUUM FULL' : 'VACUUM ANALYZE'} ────────`);
    for (const t of SWEPT_TABLES) {
      if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue; // identifier guard (constant list, belt-and-braces)
      process.stdout.write(`  ${t} … `);
      const t0 = Date.now();
      try {
        await db.query(full ? `vacuum full analyze public.${t}` : `vacuum analyze public.${t}`);
        console.log(`done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      } catch (e) {
        console.log(`FAILED: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  } else {
    console.log(`\n──────── 4/5 VACUUM — skipped in dry-run ────────`);
  }

  console.log(`\n──────── 5/5 result ────────`);
  const after = await db.query<{ mb: number }>(
    `select round(pg_database_size(current_database())/1048576.0, 1) as mb`,
  );
  const mb = Number(after[0]?.mb ?? 0);
  const headroom = FREE_TIER_LIMIT_MB - mb;
  console.log(`database after : ${mb} MB / ${FREE_TIER_LIMIT_MB} MB  (headroom ${headroom.toFixed(1)} MB)`);
  if (!execute) console.log('DRY-RUN — nothing was deleted. Re-run with --execute.');
  else if (headroom < 0) console.log('🚨 OVER THE FREE-TIER CEILING — the project can be forced READ-ONLY (capture stops). Run with --full, or tighten RETENTION windows in archive-retention.ts.');
  else if (headroom < HEADROOM_WARN_MB) console.log(`⚠ headroom under ${HEADROOM_WARN_MB} MB (≈one week of capture). Run --full or tighten the RETENTION hot windows.`);
  else console.log('✅ healthy headroom.');

  await db.end();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
