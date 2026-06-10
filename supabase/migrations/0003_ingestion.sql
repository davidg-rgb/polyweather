-- 0003_ingestion.sql — forecast_snapshots, ensemble_snapshots, observations,
-- intraday_max, nowcast_lift (ARCHITECTURE.md §7.5–§7.8a).

create table if not exists public.forecast_snapshots (
  id            uuid primary key default gen_random_uuid(),
  icao          text not null references public.stations(icao),
  model         text not null references public.models(slug),
  target_date   date not null,                                 -- station-local
  lead_days     smallint not null check (lead_days between 0 and 16),
  tmax_c        numeric(5,2) not null,
  snapshot_slot text not null check (snapshot_slot in ('10Z', '22Z', 'backfill', 'gapfill')),
  source        text not null check (source in ('forecast_api', 'previous_runs', 'backfill_prev_runs')),
  captured_at   timestamptz not null,
  created_at    timestamptz not null default now()
);

-- The 5-col natural key (§7.5).
create unique index if not exists forecast_snapshots_natural_key
  on public.forecast_snapshots (icao, model, target_date, lead_days, snapshot_slot);
create index if not exists forecast_snapshots_icao_target_idx
  on public.forecast_snapshots (icao, target_date);
create index if not exists forecast_snapshots_model_target_idx
  on public.forecast_snapshots (model, target_date);
create index if not exists forecast_snapshots_target_lead_idx
  on public.forecast_snapshots (target_date, lead_days);

-- Member arrays (~51 numerics) keep row counts ~10× lower than per-member rows (§7.6).
create table if not exists public.ensemble_snapshots (
  id            uuid primary key default gen_random_uuid(),
  icao          text not null references public.stations(icao),
  model         text not null references public.models(slug),
  target_date   date not null,
  lead_days     smallint not null check (lead_days between 0 and 16),
  snapshot_slot text not null check (snapshot_slot in ('10Z', '22Z', 'backfill', 'gapfill')),
  members_c     numeric(5,2)[] not null,
  n_members     smallint,
  captured_at   timestamptz not null,
  created_at    timestamptz not null default now()
);

create unique index if not exists ensemble_snapshots_natural_key
  on public.ensemble_snapshots (icao, model, target_date, snapshot_slot);

create table if not exists public.observations (
  id                   uuid primary key default gen_random_uuid(),
  icao                 text not null references public.stations(icao),
  date_local           date not null,
  tmax_wu_native       smallint,                               -- null until fetched — THE grading value
  unit                 text not null check (unit in ('F', 'C')),
  n_obs                smallint,                               -- WU observation count
  tmax_metar_tenths_c  numeric(4,1),                           -- METAR replica max
  tmax_metar_native    smallint,                               -- metarMaxToNative result
  tmax_iem_f           numeric(4,1),                           -- IEM second opinion
  tmax_era5_c          numeric(4,1),                           -- gridded sanity
  provenance           text check (provenance in ('wu', 'iem_fallback')),
  provisional          boolean not null default true,
  finalized_at         timestamptz,                            -- null until next-day datapoint confirmed
  divergence_flags     text[],                                 -- e.g. {'metar+1','iem-2'}
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index if not exists observations_natural_key
  on public.observations (icao, date_local);

create or replace trigger trg_observations_updated_at
  before update on public.observations
  for each row execute function public.set_updated_at();

-- Written by metar-nowcast; read by §6.16 nowcast + dashboard badge. Pruned > 14 days.
create table if not exists public.intraday_max (
  icao         text not null references public.stations(icao),
  date_local   date not null,
  max_tenths_c numeric(4,1),
  max_native   smallint,
  n_obs        smallint,
  last_obs_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (icao, date_local)
);

create or replace trigger trg_intraday_max_updated_at
  before update on public.intraday_max
  for each row execute function public.set_updated_at();

-- ADR-15 "remaining lift": °C still to come over the rest of the local day,
-- empirical quantiles. Missing row ⇒ truncation-only nowcast (§7.8a).
create table if not exists public.nowcast_lift (
  icao          text not null references public.stations(icao),
  local_hour    smallint not null check (local_hour between 0 and 23),
  p50_remaining numeric(4,1),
  p90_remaining numeric(4,1),
  n             int,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (icao, local_hour)
);

create or replace trigger trg_nowcast_lift_updated_at
  before update on public.nowcast_lift
  for each row execute function public.set_updated_at();
