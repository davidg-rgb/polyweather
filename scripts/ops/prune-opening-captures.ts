/**
 * scripts/ops/prune-opening-captures — retention prune for the `opening_captures` TOAST (WS-1, FASTTRACK-PLAN).
 *
 * opening_captures is 46 MB heap + ~1.2 GB TOAST (the `buckets` jsonb), and the 0066 cron prune only clears
 * rows older than 90 days — far behind the 21-day panel window, so resolved events' tick series sit in TOAST
 * ~69 days after any reader needs them. This prunes capture ticks for events RESOLVED ≥ 25 days ago
 * (> PANEL_DAYS 21, with margin; the on-disk price-history archive is the permanent record), with a MANDATORY
 * archive pre-flight: every prune-candidate event must exist in the local archive index (indexArchive over
 * scripts/research/out/market-history — filenames are {date}__{polyEventId}.json). No archive file, no delete.
 *
 * DRY-RUN BY DEFAULT: prints per-event candidate counts + a stored-bytes estimate (pg_column_size on the
 * TOASTed `buckets` — the compressed on-disk payload, no detoast) and exits. `--execute` re-runs the
 * pre-flight, REFUSES if any candidate is un-archived, then deletes in PK-keyed batches (≤5000 rows per
 * statement, so no single statement runs long). Operator-gated + DB-heavy: run OFF the :35 maker-exit-panel
 * tick window, and follow with VACUUM ANALYZE (printed as a reminder — the deleted TOAST space is only
 * reusable after a vacuum, and the collector shows autovacuum has not kept up post-incident).
 *
 * Run: pnpm tsx scripts/ops/prune-opening-captures.ts             # dry-run (default; read-only)
 *      pnpm tsx scripts/ops/prune-opening-captures.ts --execute   # delete (archive pre-flight enforced)
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';
import { indexArchive } from '../research/tune-convergence.ts';

const ARCHIVE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'research', 'out', 'market-history');

/** > PANEL_DAYS (21) with margin — no reader needs a resolved event's ticks this long after resolution. */
export const RESOLVED_AGE_DAYS = 25;
/** rows per delete statement — keeps each statement small, index-driven, and quick to yield. */
export const BATCH_ROWS = 5000;

export interface PruneCandidate {
  /** market_events.id (= opening_captures.event_id). */
  eventId: string;
  /** the archive filename key ({date}__{polyEventId}.json) — null means structurally un-archivable. */
  polyEventId: string | null;
  city: string;
  targetDate: string;
  resolvedAt: string;
  nRows: number;
  /** Σ pg_column_size(buckets) — the stored (compressed) TOAST payload, measured without detoasting. */
  bytesEst: number;
}

/** Candidate events: RESOLVED (winner known) ≥ `resolvedAgeDays` ago, still carrying capture ticks. */
export async function findCandidates(db: ScriptDb, resolvedAgeDays = RESOLVED_AGE_DAYS): Promise<PruneCandidate[]> {
  return db.query<PruneCandidate>(
    `select oc.event_id::text                                     as "eventId",
            me.poly_event_id                                      as "polyEventId",
            min(oc.city)                                          as "city",
            me.target_date::text                                  as "targetDate",
            me.resolved_at::text                                  as "resolvedAt",
            count(*)::int                                         as "nRows",
            coalesce(sum(pg_column_size(oc.buckets)), 0)::float8  as "bytesEst"
       from public.opening_captures oc
       join public.market_events me on me.id = oc.event_id
      where me.resolved_at is not null
        and me.resolved_at < now() - make_interval(days => $1::int)
        and coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is not null
      group by oc.event_id, me.poly_event_id, me.target_date, me.resolved_at
      order by me.resolved_at`,
    [resolvedAgeDays],
  );
}

/** MANDATORY pre-flight: every candidate's full price path must be archived locally. No archive file, no delete. */
export function preflightArchive(
  candidates: PruneCandidate[],
  archiveIdx: Map<string, string>,
): { ok: boolean; missing: PruneCandidate[] } {
  const missing = candidates.filter((c) => !c.polyEventId || !archiveIdx.has(c.polyEventId));
  return { ok: missing.length === 0, missing };
}

/**
 * Batched PK-keyed delete (≤ batchRows per statement); returns total rows deleted.
 * The archive pre-flight is a REQUIRED argument and is re-checked STRUCTURALLY here — a direct caller cannot
 * reach the delete path without a passing pre-flight over these exact candidates (no archive file, no delete).
 */
export async function executePrune(
  db: ScriptDb,
  candidates: PruneCandidate[],
  preflight: { ok: boolean; missing: PruneCandidate[] },
  batchRows = BATCH_ROWS,
): Promise<number> {
  if (!preflight.ok) {
    throw new Error(
      `executePrune refused: archive pre-flight did not pass (${preflight.missing.length} candidate(s) un-archived) — no archive file, no delete`,
    );
  }
  const eventIds = candidates.map((c) => c.eventId);
  if (eventIds.length === 0) return 0;
  let total = 0;
  for (;;) {
    const del = await db.query<{ id: string }>(
      `delete from public.opening_captures
        where id in (select id from public.opening_captures where event_id = any($1::uuid[]) limit $2)
        returning id`,
      [eventIds, batchRows],
    );
    total += del.length;
    if (del.length < batchRows) return total;
  }
}

const mb = (bytes: number): string => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { execute: { type: 'boolean', default: false } } });
  loadEnv();
  const archiveIdx = indexArchive(ARCHIVE_ROOT);
  const db = makeScriptDb();
  try {
    const candidates = await findCandidates(db);
    const totRows = candidates.reduce((s, c) => s + Number(c.nRows), 0);
    const totBytes = candidates.reduce((s, c) => s + Number(c.bytesEst), 0);

    console.log(`prune-opening-captures — events resolved ≥ ${RESOLVED_AGE_DAYS} days ago still carrying ticks:`);
    for (const c of candidates) {
      console.log(
        `  ${c.targetDate}  ${c.city.padEnd(14)} resolved ${c.resolvedAt}  ${String(c.nRows).padStart(5)} rows  ` +
          `${mb(Number(c.bytesEst)).padStart(9)}  ${c.polyEventId ?? '(no poly_event_id)'}`,
      );
    }
    console.log(`TOTAL: ${candidates.length} events · ${totRows} capture rows · ~${mb(totBytes)} stored buckets payload`);

    const pre = preflightArchive(candidates, archiveIdx);
    if (!pre.ok) {
      console.log(`\n⛔ PRE-FLIGHT FAIL — ${pre.missing.length} candidate(s) NOT in the local archive (${ARCHIVE_ROOT}):`);
      for (const c of pre.missing) console.log(`  MISSING ${c.targetDate} ${c.city} ${c.polyEventId ?? '(no poly_event_id)'}`);
      console.log('No archive file, no delete. Re-pull the archive (backfill-market-history --full-series) and re-run.');
      if (values.execute) process.exitCode = 1;
      return;
    }
    console.log(`✅ pre-flight: all ${candidates.length} candidate events present in the local archive.`);

    if (!values.execute) {
      console.log('\nDRY-RUN (default) — nothing deleted. Re-run with --execute to delete.');
      console.log('Schedule OFF the :35 maker-exit-panel tick window (RUNBOOK / FASTTRACK hard rule 1).');
      return;
    }

    const deleted = await executePrune(db, candidates, pre);
    console.log(`\ndeleted ${deleted} opening_captures rows across ${candidates.length} events.`);
    console.log('NOW RUN (operator, quiet window — returns the TOAST space to reuse + refreshes planner stats):');
    console.log('  VACUUM ANALYZE public.opening_captures;');
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
