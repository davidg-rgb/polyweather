-- 0034_lockdown_internal_rpcs.sql — lock down the whole SECURITY DEFINER RPC layer.
-- Closes the iter-44 OPEN THREAD: the remaining internal RPCs were the same anon-exposed class
-- that 0023 (note_bet_slack_delivery) and 0032 (apply_halt / clear_system_halt) already fixed,
-- one function at a time. This sweeps the rest in one pass.
--
-- THE HOLE -------------------------------------------------------------------------------------
-- Every Postgres function defaults to EXECUTE for PUBLIC, and Supabase's anon/authenticated roles
-- inherit PUBLIC. ~80 of these RPCs are SECURITY DEFINER → they run as the owner and BYPASS RLS.
-- So anyone holding the publishable anon key could POST /rest/v1/rpc/<fn> and drive the internals
-- directly — settle_bets, fill_bet_with_caps, finalize_observation, upsert_forecast_rows,
-- claim_event_winner, complete_job_run, score_distributions, … — writing straight past row-level
-- security. RLS on the tables does NOT help: SECURITY DEFINER is exactly the bypass. The only real
-- gate today is that the operator_* RPCs self-guard via operator_guard()→is_operator(); the
-- service-role-internal writers have no guard at all because they were only ever meant to be called
-- by the Edge Functions over the service-role key.
--
-- THE ONLY LEGITIMATE CALLERS (everything else is closed) --------------------------------------
--   • Edge Functions authenticate as service_role (SUPABASE_SERVICE_ROLE_KEY, functions/_shared/db.ts).
--     service_role is re-granted EXECUTE on EVERY swept function below → the pipeline is untouched.
--   • The Vercel dashboard authenticates as the operator's *session* = the `authenticated` role
--     (anon key + session cookie via @supabase/ssr; apps/web is RLS-scoped, "never the service role",
--     §11.5). It invokes exactly the RPCs in `web_authenticated` — those keep `authenticated`.
--     Sources of that list: apps/web routes.ts + prod.ts (.rpc literals), loaders.ts (dash_* via the
--     one() helper), packages/trading gate.ts goLiveGate (go_live_gate_inputs). The operator_* RPCs
--     additionally self-guard, so even within `authenticated` only the allow-listed operator passes.
--   • anon (no JWT) calls ZERO RPCs except the out-of-band uptime probe GET /api/health, which is
--     declared "NO auth" (routes.ts) and therefore runs as anon → only health_check stays anon.
--
-- MECHANISM ------------------------------------------------------------------------------------
-- A catalog-driven sweep, not a hand-list, so completeness is provable: it cannot miss a function,
-- and it is idempotent (REVOKE/GRANT are no-ops once applied → safe under the db-reset re-run). It
-- skips trigger functions (set_updated_at) and extension-owned functions. New RPCs added by future
-- migrations are NOT covered here — each must ship its own revoke/grant (idiom: revoke all from
-- public, anon, authenticated; grant execute to service_role [, authenticated]). The 0034 invariant
-- test (supabase/tests/migrations.test.ts) fails if any function escapes this contract.

do $$
declare
  r       record;
  v_sig   text;
  -- The operator-session (authenticated) surface — the EXACT set apps/web calls through its
  -- RLS-scoped web client. Keep in sync when the dashboard adds/removes an RPC (the invariant
  -- test enforces both directions: nothing extra exposed, nothing needed over-revoked).
  web_authenticated constant text[] := array[
    -- §6.22 dashboard read RPCs (apps/web loaders.ts → one())
    'dash_today_overview', 'dash_events_list', 'dash_event_detail', 'dash_city_detail',
    'dash_calibration', 'dash_bets_ledger', 'dash_system_health', 'dash_admin_state',
    -- go-live gate readout (packages/trading goLiveGate)
    'go_live_gate_inputs',
    -- operator actions (apps/web routes.ts; each also self-guards via operator_guard→is_operator)
    'operator_halt', 'operator_resume', 'operator_update_config', 'operator_verify_station',
    'operator_set_champion', 'operator_skip_bet', 'operator_manual_bet',
    'operator_record_external_fill', 'operator_export_rows',
    -- bet-approval read + source-promotion read (apps/web routes.ts)
    'bet_for_execution', 'promotion_check_rows',
    -- operator-action alerting (apps/web prod.ts webNotify)
    'claim_alert', 'mark_alert_sent',
    -- the out-of-band uptime probe (also anon, below)
    'health_check'
  ];
  -- The ONLY anon-reachable RPC: GET /api/health is declared NO-auth (routes.ts) → runs as anon.
  web_anon constant text[] := array['health_check'];
  -- RLS-policy helpers: the 0008 operator_read policies are `for select to authenticated using
  -- (public.is_operator())`. A policy expression is evaluated AS THE QUERYING ROLE, not as the
  -- function's definer — so `authenticated` MUST keep EXECUTE on is_operator or every operator-gated
  -- table read raises "permission denied for function is_operator". (Internal RPC callers invoke
  -- is_operator as the SECURITY DEFINER owner, so they are unaffected; only the RLS path needs this.)
  rls_helpers constant text[] := array['is_operator'];
begin
  for r in
    select p.oid, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'                                    -- plain functions (not procs/aggregates)
      and p.prorettype <> 'pg_catalog.trigger'::regtype      -- skip trigger fns (set_updated_at)
      and not exists (                                       -- skip extension-owned functions
        select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    v_sig := format('public.%I(%s)', r.proname, pg_get_function_identity_arguments(r.oid));

    -- Strip the PUBLIC default plus any direct anon/authenticated grant.
    execute 'revoke all on function ' || v_sig || ' from public, anon, authenticated';

    -- Edge Functions (service_role) must always retain EXECUTE — this is the live pipeline.
    execute 'grant execute on function ' || v_sig || ' to service_role';

    -- The operator dashboard keeps exactly its surface; RLS helpers stay callable by the role whose
    -- policies invoke them; anon keeps only the health probe.
    if r.proname = any(web_authenticated) or r.proname = any(rls_helpers) then
      execute 'grant execute on function ' || v_sig || ' to authenticated';
    end if;
    if r.proname = any(web_anon) then
      execute 'grant execute on function ' || v_sig || ' to anon';
    end if;
  end loop;
end $$;
