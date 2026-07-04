-- 0081_city_sim_active_configs_rows_wrap.sql — restore the PostgREST port invariant for the multi-city
-- paper-trade's active-config read. THE SAME 0044 TOP-LEVEL-ARRAY TRAP, a second instance.
--
-- BUG (live since 0070, verified in prod 2026-07-03/07-04). city_sim_active_configs() returned a TOP-LEVEL
-- jsonb ARRAY (`coalesce(jsonb_agg(...), '[]')` straight into the return value). The Edge service-role port
-- (functions/_shared/db.ts supabasePort, mirrored by apps/web port.ts) normalizes a PostgREST result by
-- SHAPE: an array is assumed to be a RETURNS TABLE row set and passed through UNCHANGED; only a bare
-- object/scalar is wrapped as `[{ [fn]: value }]`. supabase-js `.rpc()` returns the BARE jsonb for a scalar
-- function, so this returned a bare array → the port passed it through → the handler's
-- `cfgRows[0]?.city_sim_active_configs` was undefined → `configs = []` → the daily city-paper-trade tick
-- placed 0 bets EVERY day (job_runs.stats `cities:0, placed:0` on the 07-03 and 07-04 10:00Z ticks) while
-- reporting status `ok`. The GRADE half worked only because city_sim_grade_inputs() was already wrapped in
-- `{ rows: [...] }` (the 0044 workaround, handler.ts). All existing city_paper_bets trace to the manual
-- backfill scripts, never to a cron placement.
--
-- Why it shipped green: the PGlite test twin (supabase/tests/pglite-port.ts) runs `select * from fn()`,
-- which wraps EITHER shape (array or object) into one row → the integration test saw the correct
-- `[{fn: value}]` shape and passed. Prod (bare value) and the twin (always-wrapped) diverge precisely on
-- top-level arrays. migrations.test.ts forbade set-returning (SETOF) RPCs but not the corollary "no
-- top-level-array jsonb return" — this slipped through it exactly as 0044's two RPCs did. The 0081 tripwire
-- (migrations.test.ts) now enumerates every no-arg RETURNS-jsonb fn and forbids a top-level array, so the
-- CLASS can never silently regress again.
--
-- FIX: wrap the return in an object `{ "rows": [...] }`, complying with the documented invariant ("bare
-- jsonb fns return objects/scalars, never top-level arrays"). Pure ENVELOPE change — the inner aggregate
-- (and the 0075 active_until run-window gate) is byte-identical to 0075. The consumers read `.rows`:
--   • supabase/functions/city-paper-trade/handler.ts  (the daily Edge tick — the one that was broken; the
--     fixed handler reads all three shapes tolerantly, so it is safe against BOTH the old and the new RPC
--     regardless of the apply/redeploy order)
--   • scripts/city-sim.ts                              (seed/grade backfill — reads the whole jsonb value
--     via `select fn() as v`, so it unwraps `.rows` tolerantly too)
-- A jsonb_typeof='object' guard + the top-level-array tripwire (both in migrations.test.ts) lock the shape.
-- service_role-only grants reasserted (create-or-replace preserves them; re-stated per the 0046/0047 idiom).

create or replace function public.city_sim_active_configs()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
    'cityId', cfg.city_id, 'slug', cfg.slug, 'icao', cfg.icao, 'tz', cfg.tz,
    'armHours', cfg.arm_hours, 'forecastMaxHour', cfg.forecast_max_hour,
    'stakeUsd', cfg.stake_usd, 'unit', c.unit, 'displayName', c.display_name
  ) order by cfg.slug), '[]'::jsonb))
  from public.city_sim_config cfg
  join public.cities c on c.id = cfg.city_id
  where cfg.active
    and (cfg.active_until is null or current_date <= cfg.active_until);
$$;

-- grants (post-0034 contract) — service_role only; re-assert explicitly (0046/0047 re-body idiom).
revoke all on function public.city_sim_active_configs() from public, anon, authenticated;
grant  execute on function public.city_sim_active_configs() to service_role;
