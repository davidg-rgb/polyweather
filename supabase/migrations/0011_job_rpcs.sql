-- 0011_job_rpcs.sql — race-critical job/alert mutations as SQL functions
-- (ARCHITECTURE.md §6.12, ADR-11, ADR-12, W16).
--
-- These live in SQL so the W16 claim/takeover CAS and the ADR-11 alert-dedupe
-- semantics are ONE implementation: Edge Functions call them via PostgREST
-- rpc(), and the PGlite test suite exercises the very same functions.

-- ---------------------------------------------------------------------------
-- claim_job_run — the §6.12 runJob claim sequence:
--   insert (job, period_key) → 'claimed'
--   conflict with status='ok' → 'already_ran' (409)
--   conflict with young 'running' (< wall limit) → 'running_young' (409)
--   stale 'running' or 'failed' → CAS takeover: attempt+1 guarded by the
--     OBSERVED started_at (W16 — two concurrent takeovers: row locking makes
--     the second UPDATE re-evaluate its WHERE after the first commits, the
--     started_at predicate no longer matches, exactly one proceeds)
--   CAS returned no row → 'lost_race' (409)
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- complete_job_run — finishes a run. The attempt guard makes a LATE isolate
-- (whose row was taken over) a harmless no-op instead of clobbering the new
-- attempt's row.
-- ---------------------------------------------------------------------------
create or replace function public.complete_job_run(
  p_run_id uuid,
  p_attempt int,
  p_status text,
  p_stats jsonb,
  p_error text,
  p_duration_ms int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done boolean;
begin
  update job_runs jr
     set status = p_status,
         stats = p_stats,
         error = p_error,
         finished_at = now(),
         duration_ms = p_duration_ms
   where jr.id = p_run_id
     and jr.attempt = p_attempt
     and jr.status = 'running'
  returning true into v_done;
  return coalesce(v_done, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_alert — ADR-11 dedupe-then-post:
--   no dedupe key → plain insert ('insert')
--   key free today → insert sent=false ('insert')
--   key taken, sent=true → 'skip' (the alert already went out today)
--   key taken, sent=false → 'retry' (a failed post never consumes the key)
-- ---------------------------------------------------------------------------
create or replace function public.claim_alert(
  p_kind text,
  p_severity text,
  p_dedupe_key text,
  p_title text,
  p_body text
)
returns table (decision text, alert_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_sent boolean;
begin
  if p_dedupe_key is null then
    insert into alerts_log (kind, severity, dedupe_key, title, body, sent)
    values (p_kind, p_severity, null, p_title, p_body, false)
    returning alerts_log.id into v_id;
    return query select 'insert'::text, v_id;
    return;
  end if;

  begin
    insert into alerts_log (kind, severity, dedupe_key, title, body, sent)
    values (p_kind, p_severity, p_dedupe_key, p_title, p_body, false)
    returning alerts_log.id into v_id;
    return query select 'insert'::text, v_id;
    return;
  exception when unique_violation then
    select al.id, al.sent into v_id, v_sent
    from alerts_log al
    where al.dedupe_key = p_dedupe_key
      and ((al.created_at at time zone 'utc')::date) = ((now() at time zone 'utc')::date);
    if v_sent then
      return query select 'skip'::text, v_id;
    else
      return query select 'retry'::text, v_id;
    end if;
    return;
  end;
end;
$$;

-- Flip sent=true — called ONLY after a 2xx webhook response (ADR-11).
create or replace function public.mark_alert_sent(p_alert_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update alerts_log set sent = true where id = p_alert_id;
$$;
