-- 0030_clear_system_halt.sql — dead-man halt AUTO-RECOVERY (BLUEPRINT §6.A C3 / §7.3, R-A6).
--
-- Problem (corrects DATA-LAYER-REVIEW.md:88): the dead-man halt does NOT auto-clear.
-- health-monitor's apply path (handler.ts §4) re-runs evaluateBreakers each pass and calls
-- apply_halt AGAIN while stale (0013:224, idempotent overwrite, actor='system'); there is NO
-- delete-on-recovery branch. Once forecasts go fresh, health-monitor merely STOPS re-applying
-- the halt — the existing config['halt:global'] row PERSISTS and poll-markets halted()
-- (handler.ts:186-189) keeps returning true for every event until an operator clears it.
-- Before this, the ONLY removal path was operator_resume('halt:global') (0021:66, manual, /admin).
--
-- This adds clear_system_halt(scope) — symmetrical to apply_halt — which DELETEs
-- config['halt:'||scope] ONLY WHEN config_audit shows the LAST writer of that halt was 'system'
-- (a breaker-applied halt), and audits the deletion with actor='system-recover'. It NEVER deletes
-- an operator-authored halt (operator_halt / a manual operator_update_config write the audit trail
-- with actor='admin-ui'). The health-monitor recovery branch (handler.ts §4b) calls it ONLY when
-- forecast freshness is CURRENTLY below the staleForecastHaltH threshold (info-time-matched), so a
-- still-stale pipeline is never auto-resumed (R-A6).
--
-- Every config['halt:*'] reader is unchanged: poll-markets halted() (handler.ts:186-189),
-- dash_admin_state halts aggregate, go_live_gate_inputs (OUT OF SCOPE trading gate),
-- operator_resume / operator_halt (0021).

-- The system recovery actor needs a config_audit slot. The 0007 CHECK allowed only
-- ('admin-ui','system'); widen it to admit 'system-recover' (the auto-recovery writer).
-- Idempotent: drop the named/old constraint if present, then re-add the widened one.
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.config_audit'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%actor%';
  if v_name is not null then
    execute format('alter table public.config_audit drop constraint %I', v_name);
  end if;
  alter table public.config_audit
    add constraint config_audit_actor_check
    check (actor in ('admin-ui', 'system', 'system-recover'));
end $$;

-- System auto-recovery: delete a breaker-applied halt + audit (actor 'system-recover').
-- Returns true only when a SYSTEM-authored halt existed and was removed; false when no
-- halt exists OR the last writer was the operator (refuses to undo a deliberate operator halt).
create or replace function public.clear_system_halt(p_scope text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key        text := 'halt:' || p_scope;
  v_old        text;
  v_last_actor text;
begin
  -- The halt must currently exist.
  select value into v_old from config where key = v_key;
  if v_old is null then return false; end if;

  -- The last writer of this halt key must be the system (breaker-applied), NEVER the operator.
  -- apply_halt audits actor='system'; operator_halt / operator_update_config audit 'admin-ui';
  -- a prior auto-recovery audits 'system-recover'. Only a 'system' last-write is auto-clearable.
  select actor into v_last_actor
  from config_audit
  where key = v_key
  order by created_at desc, id desc
  limit 1;
  if v_last_actor is distinct from 'system' then return false; end if;

  delete from config where key = v_key;
  insert into config_audit (key, old_value, new_value, actor)
  values (v_key, v_old, 'auto-recovered', 'system-recover');
  return true;
end;
$$;
