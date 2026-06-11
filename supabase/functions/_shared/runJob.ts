/**
 * functions/_shared/runJob — the universal job wrapper (ARCHITECTURE.md §6.12,
 * ADR-02, ADR-12, W16).
 *
 * Sequence: requireCronAuth → claim the period (claim_job_run RPC: insert,
 * 409 on ok/young-running, CAS takeover of stale/failed rows) → respond 202
 * immediately → continue via waitUntil: handler → complete_job_run (the
 * attempt guard makes late isolates no-ops) → on throw: job_runs 'failed' +
 * Slack CRITICAL (never rethrows). pg_net's ~5s timeout only ever sees the
 * fast 202/409/401 paths.
 */
import { AuthError, parseConfigRows, type AppConfig } from '../../../packages/core/src/index.ts';
import { requireCronAuth } from './auth.ts';
import type { DbPort } from './db.ts';
import { notifySlack } from './slack.ts';

export interface JobCtx {
  db: DbPort;
  config: AppConfig;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  startedAt: Date;
}

export type JobStats = Record<string, unknown>;

export interface RunJobDeps {
  db: DbPort;
  /** EdgeRuntime.waitUntil in production; tests capture the promise. */
  waitUntil?: (work: Promise<void>) => void;
}

interface ClaimRow {
  decision: 'claimed' | 'already_ran' | 'running_young' | 'taken_over' | 'lost_race';
  run_id: string | null;
  run_attempt: number | null;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const defaultWaitUntil = (work: Promise<void>): void => {
  const er = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<void>): void } }).EdgeRuntime;
  if (er) {
    er.waitUntil(work);
  } else {
    void work;
  }
};

export async function runJob(
  name: string,
  periodKey: string,
  req: Request,
  handler: (ctx: JobCtx) => Promise<JobStats>,
  deps: RunJobDeps,
): Promise<Response> {
  try {
    requireCronAuth(req);
  } catch (e) {
    if (e instanceof AuthError) return json(401, { code: 'ERR_AUTH' });
    throw e; // ConfigError on missing CRON_SECRET: fail loudly, not as a clean 401
  }

  // §8.1: Body { periodKey? } — a caller-supplied key (admin trigger-job uses
  // ':manual:{ts}' suffixes, §6.21) overrides the entry's derived slot key so
  // manual retriggers never collide with the period already run.
  try {
    const body = (await req.clone().json()) as { periodKey?: unknown };
    if (typeof body?.periodKey === 'string' && body.periodKey.length > 0) {
      periodKey = body.periodKey;
    }
  } catch {
    // no/invalid body — keep the derived key
  }

  const db = deps.db;
  const config = parseConfigRows(await db.getConfigRows());

  const claims = await db.rpc<ClaimRow>('claim_job_run', {
    p_job: name,
    p_period_key: periodKey,
    p_wall_limit_sec: config.jobWallLimitSec,
  });
  const claim = claims[0];
  if (!claim || claim.decision === 'already_ran' || claim.decision === 'running_young' || claim.decision === 'lost_race') {
    return json(409, { code: 'ERR_ALREADY_RAN', decision: claim?.decision ?? 'unknown' });
  }

  const startedAt = new Date();
  const runId = claim.run_id!;
  const attempt = claim.run_attempt!;
  const log = (msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ job: name, periodKey, msg, ...extra }));

  const work = (async () => {
    try {
      const stats = await handler({ db, config, log, startedAt });
      await db.rpc('complete_job_run', {
        p_run_id: runId,
        p_attempt: attempt,
        p_status: 'ok',
        p_stats: stats,
        p_error: null,
        p_duration_ms: Date.now() - startedAt.getTime(),
      });
    } catch (e) {
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      try {
        await db.rpc('complete_job_run', {
          p_run_id: runId,
          p_attempt: attempt,
          p_status: 'failed',
          p_stats: null,
          p_error: message,
          p_duration_ms: Date.now() - startedAt.getTime(),
        });
        await notifySlack(db, {
          kind: 'JOB_FAIL',
          severity: 'CRITICAL',
          title: `${name} failed`,
          body: `period \`${periodKey}\` attempt ${attempt}\n${message}`,
          dedupeKey: `job-fail:${name}:${periodKey}`,
        });
      } catch (inner) {
        console.error(JSON.stringify({ job: name, msg: 'failure handling failed', error: String(inner) }));
      }
    }
  })();

  (deps.waitUntil ?? defaultWaitUntil)(work);
  return json(202, { accepted: true, runId, attempt, decision: claim.decision });
}
