-- 0008_rls.sql — deny-by-default row-level security (ADR-13, §11.5).
-- Single allow-listed operator email (config key 'operatorEmail', seeded in 0010)
-- may READ everything; ALL writes go through the service role (Edge Functions +
-- local scripts), which bypasses RLS. anon sees nothing.

-- SECURITY DEFINER so the check can read config regardless of the caller's
-- own RLS visibility (the config table is itself RLS-protected).
create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.config
    where key = 'operatorEmail'
      and value = coalesce(auth.jwt() ->> 'email', '')
  );
$$;

-- Mirror Supabase's default schema grants so local test harnesses behave like
-- hosted Supabase (where these grants already exist). RLS does the denying.
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated;
grant all on all tables in schema public to service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'clusters', 'cities', 'stations', 'city_stations', 'models',
    'forecast_snapshots', 'ensemble_snapshots', 'observations',
    'intraday_max', 'nowcast_lift',
    'market_events', 'market_buckets', 'market_snapshots',
    'bucket_probabilities', 'model_stats', 'model_stats_history',
    'calibration_scores', 'edge_evaluations',
    'bets', 'bankroll_ledger',
    'job_runs', 'job_locks', 'alerts_log',
    'config', 'config_audit', 'backfill_progress'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists operator_read on public.%I', t);
    execute format(
      'create policy operator_read on public.%I for select to authenticated using (public.is_operator())',
      t
    );
  end loop;
end;
$$;
