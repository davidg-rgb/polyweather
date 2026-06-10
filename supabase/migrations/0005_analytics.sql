-- 0005_analytics.sql — bucket_probabilities, model_stats (+history),
-- calibration_scores, edge_evaluations (ARCHITECTURE.md §7.12–§7.14, §7.21).

-- One row per distribution (probs array aligned to bucket_idx), not per bucket — 11× fewer rows.
create table if not exists public.bucket_probabilities (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.market_events(id),
  source           text not null,                              -- 'house_gaussian'|'house_ensemble'|'market_consensus'+
  lead_days        smallint,
  nowcast          boolean not null default false,
  made_at          timestamptz not null,
  inputs_hash      text not null,
  probs            numeric(8,6)[] not null,                    -- aligned to bucket_idx
  mu_native        numeric(6,2),
  sigma_native     numeric(5,2),
  stats_version    int,
  -- gradeEvent appends each lead this row is the ADR-16 cutoff row for
  -- (one quiet-market row can carry both leads — W18).
  scored_for_leads smallint[] not null default '{}',
  brier            numeric(8,6),                               -- filled at grading
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists bucket_probabilities_natural_key
  on public.bucket_probabilities (event_id, source, inputs_hash);
create index if not exists bucket_probabilities_event_source_time_idx
  on public.bucket_probabilities (event_id, source, made_at desc);

create or replace trigger trg_bucket_probabilities_updated_at
  before update on public.bucket_probabilities
  for each row execute function public.set_updated_at();

-- 10Z and 22Z snapshots at the same lead carry 12h different information age and
-- are NEVER pooled (W3) — snapshot_slot is part of the PK.
create table if not exists public.model_stats (
  icao             text not null references public.stations(icao),
  model            text not null references public.models(slug),
  lead_days        smallint not null,
  snapshot_slot    text not null check (snapshot_slot in ('10Z', '22Z')),
  bias_c           numeric(5,2),
  residual_sigma_c numeric(5,2),
  n_residuals      int,
  mse              numeric(8,4),
  weight           numeric(6,5),
  stats_version    int,
  window_days      smallint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (icao, model, lead_days, snapshot_slot)
);

create or replace trigger trg_model_stats_updated_at
  before update on public.model_stats
  for each row execute function public.set_updated_at();

-- Same shape + stats_version in the PK — written on every stats_version increment (§7.13).
create table if not exists public.model_stats_history (
  icao             text not null references public.stations(icao),
  model            text not null references public.models(slug),
  lead_days        smallint not null,
  snapshot_slot    text not null check (snapshot_slot in ('10Z', '22Z')),
  bias_c           numeric(5,2),
  residual_sigma_c numeric(5,2),
  n_residuals      int,
  mse              numeric(8,4),
  weight           numeric(6,5),
  stats_version    int not null,
  window_days      smallint,
  created_at       timestamptz not null default now(),
  primary key (icao, model, lead_days, snapshot_slot, stats_version)
);

-- city_id has NO FK: the reserved zero-UUID row holds the POOLED 60d statistics
-- (incl. bootstrap_p) that goLiveGate reads (§7.14).
create table if not exists public.calibration_scores (
  city_id      uuid not null,
  source       text not null,
  lead_days    smallint not null,
  window_tag   text not null check (window_tag in ('30d', '60d', '90d', 'backtest', 'nowcast')),
  brier        numeric(8,6),
  brier_market numeric(8,6),
  bootstrap_p  numeric(8,6),                                   -- pooled rows only
  ece          numeric(8,6),
  sharpness    numeric(8,6),
  reliability  jsonb,
  n_events     int,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (city_id, source, lead_days, window_tag)
);

create or replace trigger trg_calibration_scores_updated_at
  before update on public.calibration_scores
  for each row execute function public.set_updated_at();

-- F-038: hourly edge persistence — makes "why didn't we bet on yesterday's
-- winner" answerable from stored data (W14). Retention 30 days.
create table if not exists public.edge_evaluations (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.market_events(id),
  bucket_idx    smallint not null,
  captured_hour timestamptz not null,                          -- hour-truncated
  q             numeric(8,6),
  exec_ask      numeric(8,6),
  edge          numeric(8,6),
  min_edge      numeric(8,6),
  pass          boolean,
  reasons       text[],
  created_at    timestamptz not null default now()
);

create unique index if not exists edge_evaluations_natural_key
  on public.edge_evaluations (event_id, bucket_idx, captured_hour);
