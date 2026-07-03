-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0078 · job_runs janitor — mark THIS job's own dead-isolate 'running' rows 'failed' at claim time
--
-- 2026-07-03 (WS-5, FASTTRACK-PLAN §WS-5 item 2): today's incidents left 4 job_runs rows wedged at
-- status='running' PERMANENTLY — forensic noise that alarms an operator scanning job_runs by eye, with no
-- mechanism that ever clears them. Cause: each cron tick's period_key is a derived wall-clock SLOT (e.g.
-- 'maker-exit-panel:2026-07-03T14:15', unique per (job, period_key) via job_runs_natural_key, 0007). The
-- existing claim_job_run CAS takeover (0011) only re-examines the SAME (job, period_key) row on a LATER
-- claim of that EXACT slot — a dead isolate that died mid-tick and never reached complete_job_run leaves its
-- row 'running' forever, because no FUTURE claim (a different, newer period_key) ever looks at that old row
-- again.
--
-- Fix: at the top of every claim_job_run call, sweep THIS job's OTHER rows (any period_key) that are still
-- 'running' and started more than 30 MINUTES ago → mark 'failed' with a diagnostic error, before the normal
-- claim/CAS logic runs. 30 minutes is a hard, deliberately generous margin: the Supabase Edge isolate
-- wall-clock ceiling is ~400s (~6.7 min) — nothing can still be legitimately executing past that, whatever
-- p_wall_limit_sec (config jobWallLimitSec, default 150s — the much TIGHTER "avoid a concurrent double-claim"
-- window, a different concern) says for THIS job. 30 min is >4x the isolate wall and >12x the default
-- wall-limit, so the sweep can never race a real in-flight run for ANY job on this system.
--
-- Scope + safety:
--   · scoped to `job = p_job` — a claim for job A never touches job B's wedged rows (each job's OWN next
--     claim sweeps its own backlog; a job that never runs again would keep a wedged row, same as today —
--     out of scope, no worse than the status quo).
--   · scoped to `status = 'running'` — an 'ok' row (however old) or an already-'failed' row is never re-touched
--     (the sweep's WHERE simply stops matching once a row flips to 'failed').
--   · if the sweep happens to catch the CURRENT (job, period_key) row being reclaimed (e.g. a manual retrigger
--     of an exact stale slot), it flips 'running'→'failed' before the claim logic runs — the EXISTING
--     stale-'failed' CAS-takeover branch (0011, unchanged) then picks it up normally. One mechanism, no
--     special-casing, and the takeover's row/attempt semantics are untouched.
--   · idempotent — re-running the sweep on an already-'failed' row is a WHERE-no-match no-op.
--
-- No new table/RPC/cron. claim_job_run's signature, return shape, and every existing decision branch
-- ('claimed' / 'already_ran' / 'running_young' / 'taken_over' / 'lost_race') are BYTE-IDENTICAL — this is a
-- pure body addition (one UPDATE) ahead of the untouched original logic. Grants: CREATE OR REPLACE preserves
-- the post-0034 lockdown state, but the project's re-body idiom (0046/0047) is to RE-ASSERT the contract
-- explicitly anyway — the revoke/grant block at the bottom pins claim_job_run to service_role-only (the Edge
-- runJob wrapper is its only caller; the live 0034 invariant test enforces the same outcome).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.claim_job_run(
  p_job text,
  p_period_key text,
  p_wall_limit_sec int
)
returns table (decision text, run_id uuid, run_attempt int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_attempt int;
  v_status text;
  v_started timestamptz;
begin
  -- janitor: this job's own OTHER dead-isolate rows (any period_key), 'running' for >30 min → 'failed'.
  update public.job_runs
     set status      = 'failed',
         error       = 'janitor: isolate died (stale running row)',
         finished_at = now()
   where job = p_job
     and status = 'running'
     and started_at < now() - interval '30 minutes';

  insert into job_runs (job, period_key, status, attempt, started_at)
  values (p_job, p_period_key, 'running', 1, now())
  on conflict (job, period_key) do nothing
  returning job_runs.id, job_runs.attempt into v_id, v_attempt;

  if v_id is not null then
    return query select 'claimed'::text, v_id, v_attempt;
    return;
  end if;

  select jr.id, jr.attempt, jr.status, jr.started_at
    into v_id, v_attempt, v_status, v_started
  from job_runs jr
  where jr.job = p_job and jr.period_key = p_period_key;

  if v_status = 'ok' then
    return query select 'already_ran'::text, v_id, v_attempt;
    return;
  end if;

  if v_status = 'running'
     and v_started is not null
     and v_started > now() - make_interval(secs => p_wall_limit_sec) then
    return query select 'running_young'::text, v_id, v_attempt;
    return;
  end if;

  update job_runs jr
     set status = 'running',
         started_at = now(),
         attempt = jr.attempt + 1,
         finished_at = null,
         error = null
   where jr.job = p_job
     and jr.period_key = p_period_key
     and jr.status in ('running', 'failed')
     and jr.started_at is not distinct from v_started
  returning jr.id, jr.attempt into v_id, v_attempt;

  if v_id is null then
    return query select 'lost_race'::text, null::uuid, null::int;
    return;
  end if;

  return query select 'taken_over'::text, v_id, v_attempt;
end;
$$;

-- create-or-replace preserves grants; re-assert the post-0034 contract explicitly.
revoke all on function public.claim_job_run(text, text, int) from public, anon, authenticated;
grant  execute on function public.claim_job_run(text, text, int) to service_role;
