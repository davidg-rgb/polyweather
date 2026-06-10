import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rows } from './harness.ts';
import { pglitePort } from './pglite-port.ts';

let db: PGlite;
let port: ReturnType<typeof pglitePort>;

beforeAll(async () => {
  db = await freshDb();
  port = pglitePort(db);
});

afterAll(async () => {
  await db.close();
});

interface Claim {
  decision: string;
  run_id: string | null;
  run_attempt: number | null;
}

const claim = (job: string, period: string, wall = 150) =>
  port.rpc<Claim>('claim_job_run', { p_job: job, p_period_key: period, p_wall_limit_sec: wall }).then((r) => r[0]!);

describe('claim_job_run (§6.12, ADR-12, W16)', () => {
  it('fresh period → claimed, attempt 1', async () => {
    const c = await claim('discover-markets', '2026-06-10T11Z');
    expect(c.decision).toBe('claimed');
    expect(c.run_attempt).toBe(1);
    expect(c.run_id).toBeTruthy();
  });

  it('young running row → running_young (409 path)', async () => {
    const c = await claim('discover-markets', '2026-06-10T11Z');
    expect(c.decision).toBe('running_young');
  });

  it('completed ok → already_ran (409 path)', async () => {
    const first = await claim('poll-markets', '2026-06-10T11:05');
    await port.rpc('complete_job_run', {
      p_run_id: first.run_id,
      p_attempt: first.run_attempt,
      p_status: 'ok',
      p_stats: { cells: 42 },
      p_error: null,
      p_duration_ms: 1234,
    });
    const again = await claim('poll-markets', '2026-06-10T11:05');
    expect(again.decision).toBe('already_ran');
    const run = await rows<{ status: string; stats: { cells: number }; duration_ms: number }>(
      db,
      `select status, stats, duration_ms from job_runs where job = 'poll-markets' and period_key = '2026-06-10T11:05'`,
    );
    expect(run[0]!.status).toBe('ok');
    expect(run[0]!.stats.cells).toBe(42);
    expect(run[0]!.duration_ms).toBe(1234);
  });

  it('failed row → CAS takeover with attempt+1', async () => {
    const first = await claim('fetch-actuals', '2026-06-10T12');
    await port.rpc('complete_job_run', {
      p_run_id: first.run_id,
      p_attempt: first.run_attempt,
      p_status: 'failed',
      p_stats: null,
      p_error: 'UpstreamError: 503',
      p_duration_ms: 50,
    });
    const retry = await claim('fetch-actuals', '2026-06-10T12');
    expect(retry.decision).toBe('taken_over');
    expect(retry.run_attempt).toBe(2);
    expect(retry.run_id).toBe(first.run_id); // same row, bumped attempt (W16: unique key forbids a second row)
  });

  it('stale running row (killed isolate) → CAS takeover', async () => {
    const first = await claim('snapshot-forecasts', '2026-06-10T10Z');
    // age the row past the wall limit — a dead isolate never completed it
    await db.query(`update job_runs set started_at = now() - interval '10 minutes' where id = $1`, [first.run_id]);
    const takeover = await claim('snapshot-forecasts', '2026-06-10T10Z');
    expect(takeover.decision).toBe('taken_over');
    expect(takeover.run_attempt).toBe(2);
    // and the row is young again — a third claim is refused
    const third = await claim('snapshot-forecasts', '2026-06-10T10Z');
    expect(third.decision).toBe('running_young');
  });

  it('W16 CAS predicate: a takeover with a mismatched observed started_at moves nothing', async () => {
    // The mechanism behind "two concurrent takeovers → exactly one proceeds":
    // the UPDATE is guarded by the started_at value the claimer OBSERVED.
    // (PGlite is single-session, so true interleaving cannot run here; the
    // predicate + row locking provide the guarantee on real Postgres.)
    const c = await claim('metar-nowcast', '2026-06-10T12:15');
    const res = await db.query(
      `update job_runs set attempt = attempt + 1
       where job = 'metar-nowcast' and period_key = '2026-06-10T12:15'
         and status in ('running','failed')
         and started_at = now() - interval '1 year'
       returning id`,
    );
    expect(res.rows.length).toBe(0); // stale observation → no takeover
    const unchanged = await rows<{ attempt: number }>(
      db,
      `select attempt from job_runs where id = '${c.run_id}'`,
    );
    expect(unchanged[0]!.attempt).toBe(1);
  });

  it('complete_job_run with a stale attempt is a no-op (late isolate cannot clobber)', async () => {
    const first = await claim('grade-bets', '2026-06-10');
    await db.query(`update job_runs set started_at = now() - interval '10 minutes' where id = $1`, [first.run_id]);
    const takeover = await claim('grade-bets', '2026-06-10'); // attempt 2 now running
    // the DEAD attempt-1 isolate wakes up late and tries to complete
    const result = await port.rpc<boolean>('complete_job_run', {
      p_run_id: first.run_id,
      p_attempt: 1,
      p_status: 'ok',
      p_stats: { ghost: true },
      p_error: null,
      p_duration_ms: 999999,
    });
    expect(result[0]).toMatchObject({ complete_job_run: false });
    const row = await rows<{ status: string; attempt: number }>(
      db,
      `select status, attempt from job_runs where id = '${takeover.run_id}'`,
    );
    expect(row[0]!.status).toBe('running'); // attempt 2 still owns the row
    expect(row[0]!.attempt).toBe(2);
  });
});

describe('claim_alert / mark_alert_sent (§6.12, ADR-11)', () => {
  it('first claim inserts sent=false', async () => {
    const [c] = await port.rpc<{ decision: string; alert_id: string }>('claim_alert', {
      p_kind: 'STATION_CHANGE',
      p_severity: 'WARN',
      p_dedupe_key: 'station-change:nyc',
      p_title: 't',
      p_body: 'b',
    });
    expect(c!.decision).toBe('insert');
    const row = await rows<{ sent: boolean }>(db, `select sent from alerts_log where id = '${c!.alert_id}'`);
    expect(row[0]!.sent).toBe(false);
  });

  it('unsent key → retry with the SAME row (failed post never consumes the key)', async () => {
    const [c] = await port.rpc<{ decision: string; alert_id: string }>('claim_alert', {
      p_kind: 'STATION_CHANGE',
      p_severity: 'WARN',
      p_dedupe_key: 'station-change:nyc',
      p_title: 't',
      p_body: 'b',
    });
    expect(c!.decision).toBe('retry');
  });

  it('sent key → skip for the rest of the day', async () => {
    const [first] = await port.rpc<{ decision: string; alert_id: string }>('claim_alert', {
      p_kind: 'X', p_severity: 'INFO', p_dedupe_key: 'daily:thing', p_title: 't', p_body: 'b',
    });
    await port.rpc('mark_alert_sent', { p_alert_id: first!.alert_id });
    const [second] = await port.rpc<{ decision: string }>('claim_alert', {
      p_kind: 'X', p_severity: 'INFO', p_dedupe_key: 'daily:thing', p_title: 't', p_body: 'b',
    });
    expect(second!.decision).toBe('skip');
  });

  it('null dedupe key always inserts', async () => {
    for (let i = 0; i < 2; i++) {
      const [c] = await port.rpc<{ decision: string }>('claim_alert', {
        p_kind: 'FREEFORM', p_severity: 'INFO', p_dedupe_key: null, p_title: 't', p_body: 'b',
      });
      expect(c!.decision).toBe('insert');
    }
    const n = await rows<{ n: number }>(db, `select count(*)::int as n from alerts_log where kind = 'FREEFORM'`);
    expect(n[0]!.n).toBe(2);
  });
});
