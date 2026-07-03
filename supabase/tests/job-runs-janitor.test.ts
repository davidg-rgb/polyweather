/**
 * Migration 0078 (job_runs janitor) — the PGlite twin against the real migration chain.
 *
 * Pins: claim_job_run sweeps THIS job's own 'running' rows older than 30 min (a dead isolate that never
 * reached complete_job_run) to 'failed' with a diagnostic error, on EVERY claim call — not just when the
 * SAME period_key is reclaimed (the 0011 CAS takeover only ever revisits the exact (job, period_key) row
 * being claimed; a wedged OLDER slot is never touched by a later slot's claim, which is exactly how 4 rows
 * stayed wedged 'running' forever in the 2026-07-03 incident). A running row younger than 30 min (well
 * inside the ~400s isolate wall) is left untouched, a stale row belonging to a DIFFERENT job is never
 * touched, an already-'ok' row (however old) is never touched, and the existing claim_job_run decision
 * branches (claimed/already_ran/running_young/taken_over/lost_race) are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

interface Claim {
  decision: string;
  run_id: string | null;
  run_attempt: number | null;
}

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});

afterAll(async () => {
  await db.close();
});

const claim = (job: string, period: string, wall = 150) =>
  port.rpc<Claim>('claim_job_run', { p_job: job, p_period_key: period, p_wall_limit_sec: wall }).then((r) => r[0]!);

const statusOf = async (runId: string): Promise<{ status: string; error: string | null }> =>
  (await rows<{ status: string; error: string | null }>(db, `select status, error from job_runs where id = '${runId}'`))[0]!;

describe('claim_job_run janitor (0078) — dead-isolate stale "running" row cleanup', () => {
  it('a running row >30 min old, from an OLDER period_key of the SAME job, is marked failed', async () => {
    // simulate a dead isolate: an earlier tick claimed a row and never called complete_job_run.
    const dead = await claim('maker-exit-panel', '2026-07-03T10:15');
    await db.query(`update job_runs set started_at = now() - interval '31 minutes' where id = $1`, [dead.run_id]);

    // a LATER tick — a DIFFERENT period_key, the real cron cadence — claims normally; the janitor sweep
    // inside claim_job_run fires as a side effect of ANY claim for this job, not just a re-claim of the
    // exact wedged slot.
    const later = await claim('maker-exit-panel', '2026-07-03T10:30');
    expect(later.decision).toBe('claimed');
    expect(later.run_id).not.toBe(dead.run_id); // a genuinely new row for the new slot, untouched itself

    const swept = await statusOf(dead.run_id!);
    expect(swept.status).toBe('failed');
    expect(swept.error).toBe('janitor: isolate died (stale running row)');
  });

  it('a running row younger than 30 min is left untouched', async () => {
    const fresh = await claim('maker-exit-panel', '2026-07-03T11:00');
    await db.query(`update job_runs set started_at = now() - interval '5 minutes' where id = $1`, [fresh.run_id]);

    // another claim for a DIFFERENT slot of the same job fires the sweep again.
    await claim('maker-exit-panel', '2026-07-03T11:15');

    const row = await statusOf(fresh.run_id!);
    expect(row.status).toBe('running'); // untouched — well inside the ~400s isolate wall's generous margin
  });

  it('a running row exactly at the boundary (29m59s old) is left untouched — the sweep is strictly >30m', async () => {
    const boundary = await claim('maker-exit-panel', '2026-07-03T11:30');
    await db.query(
      `update job_runs set started_at = now() - interval '29 minutes 59 seconds' where id = $1`,
      [boundary.run_id],
    );
    await claim('maker-exit-panel', '2026-07-03T11:45');
    const row = await statusOf(boundary.run_id!);
    expect(row.status).toBe('running');
  });

  it('a stale running row belonging to a DIFFERENT job is never touched', async () => {
    const other = await claim('convergence-panel', '2026-07-03T09:00');
    await db.query(`update job_runs set started_at = now() - interval '45 minutes' where id = $1`, [other.run_id]);

    // a claim for an UNRELATED job must not sweep another job's rows.
    await claim('opening-capture', '2026-07-03T09:05');

    const row = await statusOf(other.run_id!);
    expect(row.status).toBe('running'); // still wedged — cleared by ITS OWN job's next claim, not this one

    // confirm it IS cleared once convergence-panel itself claims again (proves the row was reachable, not
    // permanently excluded by some unrelated bug).
    await claim('convergence-panel', '2026-07-03T09:20');
    const swept = await statusOf(other.run_id!);
    expect(swept.status).toBe('failed');
  });

  it('the swept-then-reclaimed SAME slot still goes through the ordinary CAS takeover (attempt+1, same row, no dup)', async () => {
    // if the janitor happens to sweep THIS SAME (job, period_key) row being reclaimed (a manual retrigger of
    // an exact stale slot), the pre-existing stale-'failed' CAS-takeover branch must pick it up as normal —
    // one mechanism, no duplicate row, no special-casing.
    const first = await claim('maker-exit-panel', '2026-07-03T12:00');
    await db.query(`update job_runs set started_at = now() - interval '31 minutes' where id = $1`, [first.run_id]);
    const retry = await claim('maker-exit-panel', '2026-07-03T12:00'); // SAME period_key — a manual admin retrigger
    expect(retry.decision).toBe('taken_over');
    expect(retry.run_id).toBe(first.run_id);
    expect(retry.run_attempt).toBe(2);

    const count = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from job_runs where job = 'maker-exit-panel' and period_key = '2026-07-03T12:00'`,
    );
    expect(count[0]!.n).toBe(1); // the unique (job, period_key) key holds — no duplicate row from the sweep
  });

  it('a completed ("ok") row, however old, is never marked failed by the sweep', async () => {
    const done = await claim('maker-exit-panel', '2026-07-03T13:00');
    await port.rpc('complete_job_run', {
      p_run_id: done.run_id,
      p_attempt: done.run_attempt,
      p_status: 'ok',
      p_stats: {},
      p_error: null,
      p_duration_ms: 500,
    });
    await db.query(`update job_runs set started_at = now() - interval '2 days' where id = $1`, [done.run_id]);

    await claim('maker-exit-panel', '2026-07-03T13:15'); // fires the sweep again for this job

    const row = await statusOf(done.run_id!);
    expect(row.status).toBe('ok'); // the sweep only ever matches status = 'running'
  });

  it('an already-"failed" row is left as-is by the sweep (idempotent — no error-message clobber)', async () => {
    const failed = await claim('maker-exit-panel', '2026-07-03T14:00');
    await port.rpc('complete_job_run', {
      p_run_id: failed.run_id,
      p_attempt: failed.run_attempt,
      p_status: 'failed',
      p_stats: null,
      p_error: 'UpstreamError: 503',
      p_duration_ms: 50,
    });
    await db.query(`update job_runs set started_at = now() - interval '1 hour' where id = $1`, [failed.run_id]);

    await claim('maker-exit-panel', '2026-07-03T14:15'); // fires the sweep again

    const row = await statusOf(failed.run_id!);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('UpstreamError: 503'); // the sweep does not overwrite a real failure's error message
  });

  it('multiple wedged rows for the same job are ALL swept in one claim call', async () => {
    const d1 = await claim('maker-exit-panel', '2026-07-03T15:00');
    const d2 = await claim('maker-exit-panel', '2026-07-03T15:15');
    const d3 = await claim('maker-exit-panel', '2026-07-03T15:30');
    for (const d of [d1, d2, d3]) {
      await db.query(`update job_runs set started_at = now() - interval '40 minutes' where id = $1`, [d.run_id]);
    }
    await claim('maker-exit-panel', '2026-07-03T15:45');
    for (const d of [d1, d2, d3]) {
      const row = await statusOf(d.run_id!);
      expect(row.status).toBe('failed');
    }
  });
});
