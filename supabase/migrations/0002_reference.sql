-- 0002_reference.sql — reference data: clusters, cities, stations, city_stations, models
-- (ARCHITECTURE.md §7.1–§7.4, §6.8 clusterOf).

-- Shared updated_at trigger (convention §7: updatable tables carry updated_at).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- The 12 correlated-exposure cluster keys (§6.8 clusterOf). Seeded in 0010.
create table if not exists public.clusters (
  region     text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.cities (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null,                        -- Polymarket slug ('nyc')
  display_name    text not null,
  country_code    varchar(2) not null,
  unit            text not null check (unit in ('F', 'C')),
  tz              text not null,                               -- IANA, from station
  region          text not null references public.clusters(region),
  betting_enabled boolean not null default false,
  first_seen      timestamptz not null,
  last_seen       timestamptz not null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create or replace trigger trg_cities_updated_at
  before update on public.cities
  for each row execute function public.set_updated_at();

create table if not exists public.stations (
  icao         varchar(4) primary key,
  name         text,
  -- nullable: discover-markets inserts PROVISIONAL rows (tz from the derived
  -- gameStartTime offset) before seed-stations fills coordinates (§6.13)
  lat          numeric(8,5),
  lon          numeric(8,5),
  elevation_m  numeric,
  country_code varchar(2) not null,
  tz           text not null,
  source       text not null default 'ourairports' check (source in ('ourairports', 'manual')),
  created_at   timestamptz not null default now()
);

-- Temporal city↔station mapping (ADR-03): history preserved, one current row per city.
create table if not exists public.city_stations (
  id              uuid primary key default gen_random_uuid(),
  city_id         uuid not null references public.cities(id),
  icao            text not null references public.stations(icao),
  wu_country_code varchar(2) not null,                         -- the {CC} in WU location codes
  valid_from      timestamptz not null,
  valid_to        timestamptz,                                 -- null = current
  verified        boolean not null default false,
  source_url      text,                                        -- the resolutionSource it was parsed from
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists city_stations_one_current
  on public.city_stations (city_id)
  where valid_to is null;

create or replace trigger trg_city_stations_updated_at
  before update on public.city_stations
  for each row execute function public.set_updated_at();

create table if not exists public.models (
  slug          text primary key,                              -- Open-Meteo string ('ecmwf_ifs025')
  display_name  text,
  provider      text,
  horizon_days  smallint,                                      -- observed horizon
  archive_start date,                                          -- Previous-Runs archive start
  enabled       boolean not null default true,
  is_ensemble   boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create or replace trigger trg_models_updated_at
  before update on public.models
  for each row execute function public.set_updated_at();
