-- 0118_synoptic_nowcast.sql — the Synoptic Data sub-hourly nowcast lane (DATA-SOURCES.md §Synoptic).
--
-- ① synoptic_obs — slim raw obs log (5-min METAR / HF-ASOS air temps) for
--    sensor-peak-vs-print research + freshness reads; pruned to 14 days in-RPC.
-- ② synoptic_obs_log(jsonb) — idempotent batch insert + prune, one call per tick.
-- ③ cron 'synoptic-nowcast' every 15 min on the 5,19,35,49 minute lane
--    (per the C15 per-fn minute-lane rule, checked against LIVE prod cron
--    2026-07-25: 7,37 = health-monitor, 21,51 = opening-capture, quarters
--    banned — 5,19,35,49 collide with nothing hourly; only the daily 03:35
--    prune + 10:35/22:35 ensembles ever share :35).
--
-- The edge fn feeds the SAME monotonic upsert_intraday advance as metar-nowcast —
-- an added obs source can only TIGHTEN the intraday floor, never loosen it
-- (0111's dead-bucket gate reads the same table; fail-open by monotonicity is
-- unchanged). Open-access tier serves US stations only (probed live 2026-07-25:
-- KORD/KHOU 5-min cadence; EGLL/CYYZ/LTAC "no access") — absent stations no-op,
-- so a tier upgrade lights the intl cities with ZERO code change.
--
-- Rollback: select cron.unschedule('synoptic-nowcast');
--           drop function public.synoptic_obs_log(jsonb);
--           drop table public.synoptic_obs;

create table if not exists public.synoptic_obs (
  icao          text not null references public.stations(icao),
  obs_at        timestamptz not null,
  temp_tenths_c numeric(4,1) not null,
  primary key (icao, obs_at)
);

create index if not exists synoptic_obs_obs_at on public.synoptic_obs (obs_at desc);

alter table public.synoptic_obs enable row level security;
drop policy if exists operator_read on public.synoptic_obs;
create policy operator_read on public.synoptic_obs
  for select to authenticated using (public.is_operator());
grant select on public.synoptic_obs to anon, authenticated;
grant all on public.synoptic_obs to service_role;

create or replace function public.synoptic_obs_log(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  insert into synoptic_obs (icao, obs_at, temp_tenths_c)
  select r->>'icao', (r->>'obs_at')::timestamptz, (r->>'temp_tenths_c')::numeric
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where r->>'icao' is not null
  on conflict (icao, obs_at) do nothing;
  get diagnostics n = row_count;

  -- 14-day retention, in-RPC so the lane is self-contained. Small table
  -- (~40k rows at 14d × ~15 US stations × 5-min); the obs_at index serves
  -- the range delete (data-freshness lesson: never leave a hot-table range
  -- predicate unindexed).
  delete from synoptic_obs where obs_at < now() - interval '14 days';
  return n;
end;
$$;

-- ③ cron — every 15 min, off the shared :00/:15/:30/:45 seconds-pileup minutes.
do $$
declare
  edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping synoptic-nowcast registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/synoptic-nowcast',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('synoptic-nowcast', '5,19,35,49 * * * *', edge_command);
end;
$$;
