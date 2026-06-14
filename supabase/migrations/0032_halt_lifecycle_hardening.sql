-- 0032_halt_lifecycle_hardening.sql — halt-lifecycle correctness + security hardening
-- (code-review FIX 1/2/3/9). CREATE OR REPLACE of two existing RPCs + revokes/grants + one index.
--
-- THE BUGS THIS CLOSES
-- FIX 1 (recovery clears the WRONG halt): 0030's clear_system_halt('global') deletes ANY
--   live halt:global whose LAST config_audit writer is 'system'. But run-calibration's
--   calibration-drift auto-halt (0021/handler.ts) and any future P&L/drawdown breaker halt
--   ALSO write actor='system'. health-monitor's recovery branch only checks FORECAST freshness,
--   so the moment forecasts go fresh it would auto-clear a STILL-VALID calibration-drift / risk
--   halt. Fix: clear_system_halt now takes p_reason_prefixes text[] and clears only when the
--   live halt's stored reason STARTS WITH one of them. health-monitor passes ONLY the dead-man
--   forecast/price prefixes (packages/core risk.ts DEAD_MAN_*_REASON_PREFIX), so a drift/P&L
--   halt — whose reason carries no such prefix — is never auto-resumed.
-- FIX 2 (system halt clobbers an operator halt): apply_halt unconditionally upserts the row and
--   re-audits actor='system', even when an operator (admin-ui) halt is already live. That flips
--   the last-writer to 'system' → clear_system_halt would then delete the operator's deliberate
--   halt. Fix: apply_halt is a NO-OP when the last config_audit writer for the key is 'admin-ui'
--   (the system is already halted; leave the operator's authorship and reason intact).
-- FIX 3 (security): these SECURITY DEFINER RPCs had no guard and no revoke → EXECUTE defaults to
--   PUBLIC → anon-callable via PostgREST. They are service-role-internal (the operator path uses
--   operator_halt/operator_resume which self-guard via operator_guard). Revoke from
--   public/anon/authenticated, grant only to service_role (the role the edge functions use —
--   SUPABASE_SERVICE_ROLE_KEY, functions/_shared/db.ts). Mirror of the 0023 idiom.
-- FIX 9 (perf): index config_audit (key, created_at desc) — the last-writer lookup both RPCs run.

-- --- FIX 9: last-writer lookup index ------------------------------------------------------------
create index if not exists config_audit_key_created_idx
  on public.config_audit (key, created_at desc);

-- --- FIX 2: operator-aware system halt ---------------------------------------------------------
-- If an operator halt for this key is currently live (last writer 'admin-ui'), the system is
-- already halted by a deliberate human action — do nothing, preserving the operator's reason and
-- authorship. Otherwise behave exactly as 0013: upsert the reason + audit actor='system'.
-- Idempotent (a repeated system apply just rewrites the same system reason).
create or replace function public.apply_halt(p_scope text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key        text := 'halt:' || p_scope;
  v_old        text;
  v_last_actor text;
begin
  select value into v_old from config where key = v_key;

  -- Leave a live OPERATOR halt untouched (FIX 2): do not overwrite its reason and do not flip the
  -- last-writer to 'system' (which would make clear_system_halt eligible to delete it).
  if v_old is not null then
    select actor into v_last_actor
    from config_audit
    where key = v_key
    order by created_at desc, id desc
    limit 1;
    if v_last_actor = 'admin-ui' then
      return;  -- already halted by the operator; the breaker need add nothing
    end if;
  end if;

  insert into config (key, value)
  values (v_key, jsonb_build_object('reason', p_reason, 'at', now())::text)
  on conflict (key) do update set value = excluded.value;
  insert into config_audit (key, old_value, new_value, actor)
  values (v_key, v_old, p_reason, 'system');
end;
$$;

-- --- FIX 1: reason-aware system auto-recovery --------------------------------------------------
-- Deletes a breaker-applied halt + audits (actor 'system-recover'). Returns true ONLY when:
--   (a) the halt currently exists,
--   (b) the LAST config_audit writer for the key is 'system' (never an operator 'admin-ui' halt,
--       never a prior 'system-recover'), AND
--   (c) the live halt's stored reason STARTS WITH one of p_reason_prefixes.
-- The stored config value is jsonb_build_object('reason', …, 'at', …)::text (apply_halt /
-- operator_halt), so the reason is extracted as v_old::jsonb ->> 'reason'. The starts-with check
-- makes recovery reason-scoped: health-monitor passes only the dead-man forecast/price prefixes,
-- so a calibration-drift / P&L / drawdown system halt (no dead-man prefix) is NEVER auto-cleared.
create or replace function public.clear_system_halt(p_scope text, p_reason_prefixes text[])
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key        text := 'halt:' || p_scope;
  v_old        text;
  v_last_actor text;
  v_reason     text;
  v_prefix     text;
  v_match      boolean := false;
begin
  -- (a) The halt must currently exist.
  select value into v_old from config where key = v_key;
  if v_old is null then return false; end if;

  -- (b) The last writer must be the system (breaker-applied), NEVER the operator.
  select actor into v_last_actor
  from config_audit
  where key = v_key
  order by created_at desc, id desc
  limit 1;
  if v_last_actor is distinct from 'system' then return false; end if;

  -- (c) The live halt's reason must START WITH one of the allowed prefixes (reason-scoped clear).
  --     Defensive: a malformed (non-JSON) value or a value without a 'reason' yields null → no match.
  begin
    v_reason := v_old::jsonb ->> 'reason';
  exception when others then
    v_reason := null;
  end;
  if v_reason is null then return false; end if;
  foreach v_prefix in array p_reason_prefixes loop
    if left(v_reason, length(v_prefix)) = v_prefix then
      v_match := true;
      exit;
    end if;
  end loop;
  if not v_match then return false; end if;

  delete from config where key = v_key;
  insert into config_audit (key, old_value, new_value, actor)
  values (v_key, v_old, 'auto-recovered', 'system-recover');
  return true;
end;
$$;

-- The 0030 single-arg signature is now superseded. Drop it so get/PostgREST resolve to the new
-- 2-arg form unambiguously (a leftover 1-arg overload would let an unscoped clear sneak through).
drop function if exists public.clear_system_halt(text);

-- --- FIX 3: lock down both halt RPCs (service-role-internal; mirror 0023) ----------------------
revoke all on function public.apply_halt(text, text) from public, anon, authenticated;
grant execute on function public.apply_halt(text, text) to service_role;

revoke all on function public.clear_system_halt(text, text[]) from public, anon, authenticated;
grant execute on function public.clear_system_halt(text, text[]) to service_role;
