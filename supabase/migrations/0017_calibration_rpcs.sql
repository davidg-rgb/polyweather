-- 0017_calibration_rpcs.sql — run-calibration surface (ARCHITECTURE.md §6.18,
-- §7.8a, §7.13, §7.14, W3, W19, C7).

-- The 'blend' pseudo-model: §6.16 reads residual σ for (station, 'blend',
-- lead, slot) from model_stats; run-calibration writes it. It is a stats
-- key, never an API model — enabled=false keeps it out of every snapshot job.
insert into public.models (slug, display_name, provider, horizon_days, archive_start, enabled, is_ensemble, notes)
values ('blend', 'House blend (pseudo-model)', 'house', 0, null, false, false,
        'σ of the weighted EMOS-corrected multi-model blend per (station, lead, slot) — written by run-calibration, read by build-distributions')
on conflict (slug) do nothing;

-- Per-hour running-max history (ADDITIVE — see BUILD-STATE Deviations): the
-- §7.8a weekly nowcast_lift rebuild needs running-max-at-hour samples, which
-- no §7 table retains (intraday_max keeps only the day's final state). Written
-- by upsert_intraday on every ADVANCE; ~5–15 rows/station/day. Pruned > 180
-- days inside rebuild_nowcast_lift (weekly — no extra cron rule needed).
create table if not exists public.intraday_advances (
  icao         text not null references public.stations(icao),
  date_local   date not null,
  local_hour   smallint not null check (local_hour between 0 and 23),
  max_tenths_c numeric(4,1) not null,
  created_at   timestamptz not null default now(),
  primary key (icao, date_local, local_hour)
);

alter table public.intraday_advances enable row level security;
drop policy if exists operator_read on public.intraday_advances;
create policy operator_read on public.intraday_advances
  for select to authenticated using (public.is_operator());
grant select on public.intraday_advances to anon, authenticated;
grant all on public.intraday_advances to service_role;

-- upsert_intraday gains p_local_hour (station-local hour of this poll,
-- computed by the caller via core localHour) so advances can be logged with
-- the hour they were observed at. Old 5-arg signature dropped — PostgREST
-- resolves by name and an overload would be ambiguous.
drop function if exists public.upsert_intraday(text, date, numeric, smallint, smallint);

create or replace function public.upsert_intraday(
  p_icao text, p_date date, p_max_tenths numeric, p_max_native smallint, p_n_obs smallint,
  p_local_hour smallint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advanced boolean := false;
begin
  insert into intraday_max (icao, date_local, max_tenths_c, max_native, n_obs, last_obs_at)
  values (p_icao, p_date, p_max_tenths, p_max_native, p_n_obs, now())
  on conflict (icao, date_local) do update
    set max_tenths_c = excluded.max_tenths_c, max_native = excluded.max_native,
        n_obs = excluded.n_obs, last_obs_at = now()
    where intraday_max.max_tenths_c is null or excluded.max_tenths_c > intraday_max.max_tenths_c
  returning true into v_advanced;

  if coalesce(v_advanced, false) then
    insert into intraday_advances (icao, date_local, local_hour, max_tenths_c)
    values (p_icao, p_date, p_local_hour, p_max_tenths)
    on conflict (icao, date_local, local_hour) do update
      set max_tenths_c = greatest(intraday_advances.max_tenths_c, excluded.max_tenths_c);
  end if;

  return coalesce(v_advanced, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Residual pipeline (§6.18 steps 1–2)
-- ---------------------------------------------------------------------------

-- Cursor bound: the max finalized_at among the next p_max_obs unprocessed
-- observations. Cutting at a finalized_at BOUNDARY (not a row count) means
-- same-instant ties are never split across runs; observations with no
-- forecast pairs still advance the cursor. Null ⇒ nothing new.
create or replace function public.calib_cursor_bound(p_since timestamptz, p_max_obs int)
returns timestamptz
language sql
security definer
set search_path = public
as $$
  select max(x.finalized_at)
  from (
    select o.finalized_at
    from observations o
    where o.finalized_at is not null and o.tmax_wu_native is not null
      and (p_since is null or o.finalized_at > p_since)
    order by o.finalized_at
    limit p_max_obs
  ) x;
$$;

-- New (forecast, observation) pairs for the bias fold, grouped per station as
-- jsonb (PostgREST max-rows safe). error_c = raw forecast − observed °C
-- (observed via EXACT °F→°C conversion — diagnostics only, grading never
-- converts). 'backfill'/'gapfill' rows seed BOTH slots (W19); errors are
-- date-ordered so the decaying-average fold is chronological.
create or replace function public.calib_new_pairs(p_since timestamptz, p_until timestamptz)
returns table (icao text, groups jsonb)
language sql
security definer
set search_path = public
as $$
  with pairs as (
    select fs.icao as picao, fs.model, fs.lead_days, slot.s as slot,
           (fs.snapshot_slot in ('backfill', 'gapfill')) as is_seed,
           (fs.tmax_c - case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                             else o.tmax_wu_native end) as error_c,
           o.date_local
    from observations o
    join forecast_snapshots fs
      on fs.icao = o.icao and fs.target_date = o.date_local and fs.lead_days between 0 and 7
    cross join lateral unnest(
      case when fs.snapshot_slot in ('backfill', 'gapfill') then array['10Z', '22Z']
           else array[fs.snapshot_slot] end) as slot(s)
    where o.finalized_at is not null and o.tmax_wu_native is not null
      and (p_since is null or o.finalized_at > p_since)
      and o.finalized_at <= p_until
  ),
  grp as (
    select picao, model, lead_days, slot,
           jsonb_agg(jsonb_build_array(date_local, round(error_c::numeric, 4), is_seed)
                     order by date_local) as errors
    from pairs
    group by picao, model, lead_days, slot
  )
  select g.picao::text,
         jsonb_agg(jsonb_build_object('model', g.model, 'lead', g.lead_days, 'slot', g.slot, 'errors', g.errors))
  from grp g
  group by g.picao;
$$;

-- Current bias per (model, lead, slot) for the stations being refit — the
-- fold's starting points. jsonb per station (max-rows safe).
create or replace function public.calib_current_bias(p_icaos text[])
returns table (icao text, biases jsonb)
language sql
security definer
set search_path = public
as $$
  select ms.icao::text,
         jsonb_agg(jsonb_build_object('model', ms.model, 'lead', ms.lead_days,
                                      'slot', ms.snapshot_slot, 'bias', ms.bias_c))
  from model_stats ms
  where ms.icao = any(p_icaos) and ms.bias_c is not null
  group by ms.icao;
$$;

-- Rolling-window errors for σ/MSE/weights: window = (p_today − p_window_days,
-- p_today] over observation date_local. Same pair shape as calib_new_pairs.
create or replace function public.calib_window_errors(p_window_days int, p_icaos text[], p_today date)
returns table (icao text, groups jsonb)
language sql
security definer
set search_path = public
as $$
  with pairs as (
    select fs.icao as picao, fs.model, fs.lead_days, slot.s as slot,
           (fs.snapshot_slot in ('backfill', 'gapfill')) as is_seed,
           (fs.tmax_c - case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                             else o.tmax_wu_native end) as error_c,
           o.date_local
    from observations o
    join forecast_snapshots fs
      on fs.icao = o.icao and fs.target_date = o.date_local and fs.lead_days between 0 and 7
    cross join lateral unnest(
      case when fs.snapshot_slot in ('backfill', 'gapfill') then array['10Z', '22Z']
           else array[fs.snapshot_slot] end) as slot(s)
    where o.finalized_at is not null and o.tmax_wu_native is not null
      and o.icao = any(p_icaos)
      and o.date_local > p_today - p_window_days and o.date_local <= p_today
  ),
  grp as (
    select picao, model, lead_days, slot,
           jsonb_agg(jsonb_build_array(date_local, round(error_c::numeric, 4), is_seed)
                     order by date_local) as errors
    from pairs
    group by picao, model, lead_days, slot
  )
  select g.picao::text,
         jsonb_agg(jsonb_build_object('model', g.model, 'lead', g.lead_days, 'slot', g.slot, 'errors', g.errors))
  from grp g
  group by g.picao;
$$;

-- Versioned batch upsert: stats_version increments ONCE per run (global max+1);
-- every upserted row is also appended to model_stats_history (§7.13).
create or replace function public.upsert_model_stats(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version int;
begin
  select coalesce(max(stats_version), 0) + 1 into v_version from model_stats;

  insert into model_stats (icao, model, lead_days, snapshot_slot, bias_c, residual_sigma_c,
                           n_residuals, mse, weight, stats_version, window_days)
  select r.icao, r.model, r.lead, r.slot, r.bias, r.sigma, r.n, r.mse, r.weight, v_version, r."window"
  from jsonb_to_recordset(p_rows) as r(
    icao text, model text, lead smallint, slot text, bias numeric, sigma numeric,
    n int, mse numeric, weight numeric, "window" smallint)
  on conflict (icao, model, lead_days, snapshot_slot) do update
    set bias_c = excluded.bias_c, residual_sigma_c = excluded.residual_sigma_c,
        n_residuals = excluded.n_residuals, mse = excluded.mse, weight = excluded.weight,
        stats_version = excluded.stats_version, window_days = excluded.window_days;

  insert into model_stats_history (icao, model, lead_days, snapshot_slot, bias_c, residual_sigma_c,
                                   n_residuals, mse, weight, stats_version, window_days)
  select r.icao, r.model, r.lead, r.slot, r.bias, r.sigma, r.n, r.mse, r.weight, v_version, r."window"
  from jsonb_to_recordset(p_rows) as r(
    icao text, model text, lead smallint, slot text, bias numeric, sigma numeric,
    n int, mse numeric, weight numeric, "window" smallint);

  return v_version;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scoring surface (§6.18 steps 3–5)
-- ---------------------------------------------------------------------------

-- ADR-16 time-matched scored rows (scored_for_leads ⊇ lead, set only by
-- gradeEvent) for resolved events in (p_today − p_days, p_today], grouped per
-- city as jsonb. The lead is unnested so one quiet-market row carrying both
-- leads (W18) contributes a sample to each.
create or replace function public.calib_scored_rows(p_days int, p_today date)
returns table (city_id uuid, city_slug text, scored jsonb)
language sql
security definer
set search_path = public
as $$
  with sr as (
    select me.city_id as cid, c.slug, me.id as event_id, me.target_date, bp.source, l.ld,
           bp.probs, bp.brier, me.winning_bucket_idx
    from bucket_probabilities bp
    join market_events me on me.id = bp.event_id
    join cities c on c.id = me.city_id
    cross join lateral unnest(bp.scored_for_leads) as l(ld)
    where me.winning_bucket_idx is not null
      and bp.nowcast = false
      and me.target_date > p_today - p_days and me.target_date <= p_today
  )
  select sr.cid, sr.slug::text,
         jsonb_agg(jsonb_build_object('event', sr.event_id, 'date', sr.target_date,
                                      'source', sr.source, 'lead', sr.ld, 'probs', sr.probs,
                                      'brier', sr.brier, 'winner', sr.winning_bucket_idx))
  from sr
  group by sr.cid, sr.slug;
$$;

-- Batch upsert on the §7.14 PK. The reserved zero-UUID city row carries the
-- POOLED statistics incl. bootstrap_p that goLiveGate reads; its lead_days is
-- the −1 sentinel (pooled across leads {0,1} — the PK needs a value).
create or replace function public.upsert_calibration_scores(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  insert into calibration_scores (city_id, source, lead_days, window_tag, brier, brier_market,
                                  bootstrap_p, ece, sharpness, reliability, n_events)
  select r.city, r.source, r.lead, r."window", r.brier, r.brier_market,
         r.bootstrap_p, r.ece, r.sharpness, r.reliability, r.n
  from jsonb_to_recordset(p_rows) as r(
    city uuid, source text, lead smallint, "window" text, brier numeric, brier_market numeric,
    bootstrap_p numeric, ece numeric, sharpness numeric, reliability jsonb, n int)
  on conflict (city_id, source, lead_days, window_tag) do update
    set brier = excluded.brier, brier_market = excluded.brier_market,
        bootstrap_p = excluded.bootstrap_p, ece = excluded.ece,
        sharpness = excluded.sharpness, reliability = excluded.reliability,
        n_events = excluded.n_events;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Weekly nowcast_lift rebuild (§6.18 step 7, §7.8a)
-- ---------------------------------------------------------------------------

-- Empirical remaining-lift quantiles per (station, local_hour) from the
-- advances log: for each completed local day (date_local ≤ p_today − 2 is
-- over in EVERY timezone), running-max-at-hour-h = max advance with
-- local_hour ≤ h; lift = final max − running max. Only hours with
-- n ≥ p_min_n days are written — thin live history never clobbers
-- backfill-seeded rows. Also prunes advances > 180 days (weekly, in-place —
-- no extra downsample rule).
create or replace function public.rebuild_nowcast_lift(p_min_n int, p_today date)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  delete from intraday_advances where date_local < p_today - 180;

  with done_days as (
    select a.icao, a.date_local, max(a.max_tenths_c) as final_max
    from intraday_advances a
    where a.date_local <= p_today - 2
    group by a.icao, a.date_local
  ),
  hourly as (
    select d.icao, d.date_local, h.h as local_hour,
           d.final_max - max(a.max_tenths_c) as lift
    from done_days d
    cross join generate_series(0, 23) as h(h)
    join intraday_advances a
      on a.icao = d.icao and a.date_local = d.date_local and a.local_hour <= h.h
    group by d.icao, d.date_local, h.h, d.final_max
  ),
  q as (
    select icao, local_hour,
           percentile_cont(0.5) within group (order by lift) as p50,
           percentile_cont(0.9) within group (order by lift) as p90,
           count(*)::int as n
    from hourly
    group by icao, local_hour
    having count(*) >= p_min_n
  )
  insert into nowcast_lift (icao, local_hour, p50_remaining, p90_remaining, n)
  select icao, local_hour, round(p50::numeric, 1), round(p90::numeric, 1), n
  from q
  on conflict (icao, local_hour) do update
    set p50_remaining = excluded.p50_remaining, p90_remaining = excluded.p90_remaining,
        n = excluded.n;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
