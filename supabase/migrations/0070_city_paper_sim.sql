-- 0070_city_paper_sim.sql — the GENERALIZED multi-city paper-trade (Amsterdam sim, N cities).
--
-- Operator ask (2026-06-29): "start the running Amsterdam betting logs for two other markets where we have
-- the best odds of success" → Singapore (WSSS) + Karachi (OPKC), the two most forecast-accurate °C cities
-- with a liquid Polymarket daily-high market. Goal: a long-term, systematic $10/day-per-arm paper-trade on
-- our predicted bucket, scored against the real market, to MEASURE whether it nets a profit. NOT trading —
-- the analytics-pivot deliverable (CLAUDE.md), the same machinery as 0039 amsterdam_paper_sim but
-- city-parameterized (one engine, N cities by config row) so a third city is a one-row add, not a migration.
--
-- This is a NEW parallel system that leaves 0039–0052 amsterdam_* untouched (Amsterdam stays the reference
-- with its KNMI-truth + 20-yr climatology assets; those are EHAM-only and not portable). The P&L math +
-- place/grade DECISIONS still live once in @weather-edge/core (sim/amsterdam.ts planPlacements/
-- planSettlements — already city-agnostic; this migration adds only a configurable forecastMaxHour, mirrored
-- in PlaceInputs.forecastMaxHour). These RPCs are thin city-parameterized data access the Edge Function
-- (city-paper-trade) and the backfill script (scripts/city-sim.ts) share.
--
-- KEY DIFFERENCES vs 0039 (data-driven, see the session notes):
--   * Per-city ARM HOURS. Tropical WSSS/OPKC top out by ~12:30 local (Amsterdam peaks ~13:45), so 13/14/15/16
--     would be near-certain (market-priced, no payout). They race 11/12/13/14 — bracketing the real peak.
--   * Per-city FORECAST_MAX_HOUR (the latest arm the lead-1 forecast lift still helps): 12 for the tropical
--     stations (vs Amsterdam's 14), because the floor IS the peak earlier there.
--   * Real IANA tz (Asia/Singapore / Asia/Karachi — both no-DST, so correct year-round; Amsterdam used the
--     Etc/GMT-2 summer hack). All local-hour math (the arm due-gate, the in-lock-hour ask window) uses cfg.tz.
--   * Unit-general: the running max + forecast (both °C) are converted to the city's native unit before
--     bucketing, so a °F city (future) is correct too. WSSS/OPKC are °C, so it's a no-op for them.
--   * NO KNMI floor-truth lens (EHAM-only). Market-resolution accuracy (vs observations.tmax_wu_native) is
--     what drives the P&L and answers the net-profit question — that is all this needs.

-- =====================================================================================================
-- 1. CONFIG TABLE — which cities run, with their station / tz / arm hours (operator-editable, no deploy)
-- =====================================================================================================
create table if not exists public.city_sim_config (
  city_id           uuid primary key references public.cities(id),
  slug              text     not null,                    -- denormalized cities.slug (readability/joins)
  icao              text     not null,                    -- station for intraday_advances/forecast/observations
  tz                text     not null,                    -- IANA tz for local-hour math (e.g. 'Asia/Singapore')
  arm_hours         smallint[] not null,                  -- local lock hours raced as arms, e.g. {11,12,13,14}
  forecast_max_hour smallint not null default 0,          -- lift the floor to the lead-1 forecast at arms <= this
  stake_usd         numeric(10,2) not null default 10,
  active            boolean  not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create or replace trigger trg_city_sim_config_updated_at
  before update on public.city_sim_config
  for each row execute function public.set_updated_at();

alter table public.city_sim_config enable row level security;
drop policy if exists operator_read on public.city_sim_config;
create policy operator_read on public.city_sim_config
  for select to authenticated using (public.is_operator());
grant select on public.city_sim_config to anon, authenticated;
grant all on public.city_sim_config to service_role;

-- Seed the two operator-chosen cities (idempotent). WSSS/OPKC peak ~12:30 local → arms 11–14, lift ≤ 12.
-- A no-op on a fresh/test DB if the cities aren't discovered yet (the insert is gated on cities existing).
insert into public.city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active)
select c.id, c.slug, v.icao, v.tz, v.arm_hours, v.fmh, 10, true
from (values
  ('singapore', 'WSSS', 'Asia/Singapore', array[11,12,13,14]::smallint[], 12::smallint),
  ('karachi',   'OPKC', 'Asia/Karachi',   array[11,12,13,14]::smallint[], 12::smallint)
) as v(slug, icao, tz, arm_hours, fmh)
join public.cities c on c.slug = v.slug
on conflict (city_id) do nothing;

-- =====================================================================================================
-- 2. BETS TABLE — one row per (city, target_date, arm_hour). Mirrors amsterdam_paper_bets + city/icao/unit.
-- =====================================================================================================
create table if not exists public.city_paper_bets (
  id                 uuid primary key default gen_random_uuid(),
  city_id            uuid not null references public.cities(id),
  icao               text not null,
  unit               text not null default 'C',                  -- the city's native unit (C/F) the bet resolves in
  target_date        date not null,                              -- the day the market resolves (station-local)
  arm_hour           smallint not null,                          -- the local lock hour (cfg.tz)
  event_id           uuid references public.market_events(id),
  predicted_native   smallint not null,                          -- wuRound(basis) in native unit (the market grain)
  bucket_idx         smallint not null,                          -- ladder bucket the prediction lands in
  label              text,
  ask                numeric(8,6) not null,                      -- recorded odds (price/share) at placement
  stake_usd          numeric(10,2) not null default 10,
  shares             numeric(14,4) not null,                     -- stake / ask
  fee_rate           numeric(5,4) not null default 0,
  running_max_native numeric(6,2),                               -- the hard running-max floor (native unit)
  forecast_native    numeric(6,2),                               -- the debiased lead-1 forecast (native) if it lifted the call
  status             text not null default 'pending'
                       check (status in ('pending', 'won', 'lost')),
  actual_native      smallint,                                   -- finalized actual, whole native (null until graded)
  winner_idx         smallint,
  won                boolean,
  fee_usd            numeric(10,4),
  pnl_usd            numeric(10,4),                              -- net of fee; null until graded
  placed_at          timestamptz not null default now(),
  graded_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One bet per (city, day, arm) — the idempotency backstop; record() ON CONFLICT DO NOTHING locks odds at
-- first placement so a re-run never re-prices a bet already on the board.
create unique index if not exists city_paper_bets_arm_key
  on public.city_paper_bets (city_id, target_date, arm_hour);
create index if not exists city_paper_bets_status_idx
  on public.city_paper_bets (status) where status = 'pending';
create index if not exists city_paper_bets_city_date_idx
  on public.city_paper_bets (city_id, target_date);

create or replace trigger trg_city_paper_bets_updated_at
  before update on public.city_paper_bets
  for each row execute function public.set_updated_at();

alter table public.city_paper_bets enable row level security;
drop policy if exists operator_read on public.city_paper_bets;
create policy operator_read on public.city_paper_bets
  for select to authenticated using (public.is_operator());
grant select on public.city_paper_bets to anon, authenticated;
grant all on public.city_paper_bets to service_role;

-- =====================================================================================================
-- 3. ACTIVE CONFIGS — the Edge tick + seed read the live city list here (service-role).
-- =====================================================================================================
create or replace function public.city_sim_active_configs()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'cityId', cfg.city_id, 'slug', cfg.slug, 'icao', cfg.icao, 'tz', cfg.tz,
    'armHours', cfg.arm_hours, 'forecastMaxHour', cfg.forecast_max_hour,
    'stakeUsd', cfg.stake_usd, 'unit', c.unit, 'displayName', c.display_name
  ) order by cfg.slug), '[]'::jsonb)
  from public.city_sim_config cfg
  join public.cities c on c.id = cfg.city_id
  where cfg.active;
$$;

-- =====================================================================================================
-- 4. PLACE INPUTS — reconstruct the city's due arms for a day (runmax floor + in-lock-hour ask + lead-1
--    bias-corrected forecast), unit-aware. Port of 0041 (forecast lift) + 0048 (in-lock-hour ask guard),
--    city-parameterized. p_target defaults to the city's local "today".
-- =====================================================================================================
create or replace function public.city_sim_place_inputs(
  p_city_id uuid,
  p_target  date default null,
  p_now     timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_icao     text;
  v_tz       text;
  v_unit     text;
  v_arms_cfg smallint[];
  v_fmh      smallint;
  v_stake    numeric;
  v_event_id uuid;
  v_fee      numeric;
  v_today    date;
  v_now_hour int;
  v_target   date;
  v_ladder   jsonb;
  v_labels   jsonb;
  v_arms     jsonb;
  v_raw_fc   numeric;   -- cross-model lead-1 mean forecast for the target day (°C)
  v_bias     numeric;   -- mean(actual − forecast) over the trailing window of prior finalized pairs (°C)
  v_bias_n   int;
  v_fc_c     numeric;   -- corrected forecast (°C) or null
  v_fc_nat   numeric;   -- the forecast converted to the city's native unit (handed to the engine)
begin
  select cfg.icao, cfg.tz, c.unit, cfg.arm_hours, cfg.forecast_max_hour, cfg.stake_usd
    into v_icao, v_tz, v_unit, v_arms_cfg, v_fmh, v_stake
  from public.city_sim_config cfg
  join public.cities c on c.id = cfg.city_id
  where cfg.city_id = p_city_id;
  if v_icao is null then
    return null;  -- no config for this city
  end if;

  v_today    := (p_now at time zone v_tz)::date;
  v_now_hour := extract(hour from (p_now at time zone v_tz))::int;
  v_target   := coalesce(p_target, v_today);

  select me.id into v_event_id
  from public.market_events me
  where me.city_id = p_city_id and me.kind = 'highest' and me.target_date = v_target
  order by me.created_at desc
  limit 1;
  if v_event_id is null then
    return null;  -- no market for that day
  end if;

  select coalesce(min(fee_rate), 0) into v_fee
  from public.market_buckets where event_id = v_event_id;

  select
    jsonb_agg(jsonb_build_object('bucketIdx', bucket_idx, 'low', low_native, 'high', high_native)
              order by bucket_idx),
    jsonb_object_agg(bucket_idx, label)
  into v_ladder, v_labels
  from public.market_buckets where event_id = v_event_id;
  if v_ladder is null then
    return null;
  end if;

  -- Bias-corrected lead-1 forecast of the day's high (°C). Both pieces are known before the day starts
  -- (no look-ahead): raw = cross-model lead-1 mean; bias = mean residual over the trailing 30 finalized
  -- pairs (tracks seasonal drift). Mirror of AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS(30)/_MIN_PAIRS(20).
  select avg(fs.tmax_c) into v_raw_fc
  from public.forecast_snapshots fs
  where fs.icao = v_icao and fs.target_date = v_target and fs.lead_days = 1;

  with fc1 as (
    select fs.target_date, avg(fs.tmax_c) as fc
    from public.forecast_snapshots fs
    where fs.icao = v_icao and fs.lead_days = 1
    group by fs.target_date
  ),
  pairs as (
    select (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end) - fc1.fc as resid
    from public.observations o
    join fc1 on fc1.target_date = o.date_local
    where o.icao = v_icao and o.finalized_at is not null and o.tmax_wu_native is not null
      and o.date_local < v_target
    order by o.date_local desc
    limit 30
  )
  select avg(resid), count(*) into v_bias, v_bias_n from pairs;

  v_fc_c := case when v_raw_fc is not null and coalesce(v_bias_n, 0) >= 20
                 then v_raw_fc + coalesce(v_bias, 0) end;
  -- The engine bucketizes in the city's NATIVE unit; runmax + forecast are stored °C, so convert.
  v_fc_nat := case when v_fc_c is null then null
                   when v_unit = 'F' then v_fc_c * 9.0 / 5.0 + 32 else v_fc_c end;

  with due as (
    select h from unnest(v_arms_cfg) h
    where (v_target < v_today or (v_target = v_today and h <= v_now_hour))
      and not exists (
        select 1 from public.city_paper_bets b
        where b.city_id = p_city_id and b.target_date = v_target and b.arm_hour = h
      )
  ),
  rm as (
    select due.h,
      -- runmax floor in NATIVE unit (intraday_advances.max_tenths_c is °C).
      (select case when v_unit = 'F' then max(ia.max_tenths_c) * 9.0 / 5.0 + 32 else max(ia.max_tenths_c) end
       from public.intraday_advances ia
       where ia.icao = v_icao and ia.date_local = v_target and ia.local_hour <= due.h) as runmax,
      (v_target::timestamp + make_interval(hours => due.h))     at time zone v_tz as lockstart,
      (v_target::timestamp + make_interval(hours => due.h + 1)) at time zone v_tz as asof
    from due
  ),
  armed as (
    select rm.h, rm.runmax,
      (select jsonb_agg(jsonb_build_object('bucketIdx', mb.bucket_idx, 'ask',
                (select ms.best_ask from public.market_snapshots ms
                 where ms.bucket_id = mb.id
                   and ms.captured_at >= rm.lockstart and ms.captured_at < rm.asof   -- 0048: in-lock-hour only
                   and ms.best_ask is not null
                 order by ms.captured_at desc limit 1))
              order by mb.bucket_idx)
       from public.market_buckets mb where mb.event_id = v_event_id) as asks
    from rm
    where rm.runmax is not null
  )
  select jsonb_agg(jsonb_build_object('hour', h, 'runMaxC', runmax, 'asks', asks) order by h)
  into v_arms from armed;

  return jsonb_build_object(
    'targetDate',      v_target,
    'cityId',          p_city_id,
    'icao',            v_icao,
    'unit',            v_unit,
    'eventId',         v_event_id,
    'feeRate',         v_fee,
    'stakeUsd',        v_stake,
    'forecastMaxHour', v_fmh,
    'ladder',          v_ladder,
    'labels',          v_labels,
    'forecastC',       v_fc_nat,
    'arms',            coalesce(v_arms, '[]'::jsonb)
  );
end;
$$;

-- =====================================================================================================
-- 5. RECORD PLACEMENTS (idempotent) — p_rows = PlacementRow[] from planPlacements. First placement wins.
-- =====================================================================================================
create or replace function public.city_sim_record(p_city_id uuid, p_icao text, p_unit text, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.city_paper_bets
    (city_id, icao, unit, target_date, arm_hour, event_id, predicted_native, bucket_idx, label,
     ask, stake_usd, shares, fee_rate, running_max_native, forecast_native, placed_at)
  select
    p_city_id, p_icao, p_unit,
    (r->>'targetDate')::date, (r->>'armHour')::smallint, (r->>'eventId')::uuid,
    (r->>'predictedNativeC')::smallint, (r->>'bucketIdx')::smallint, r->>'label',
    (r->>'ask')::numeric, (r->>'stakeUsd')::numeric, (r->>'shares')::numeric,
    (r->>'feeRate')::numeric, (r->>'runMaxC')::numeric, (r->>'forecastC')::numeric,
    coalesce((r->>'placedAt')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (city_id, target_date, arm_hour) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- =====================================================================================================
-- 6. GRADE INPUTS — pending bets across ALL cities whose observation (by the bet's icao) has finalized.
--    Returns { rows: GradeInputRow[] } (wrapped — a bare jsonb array is misread by supabasePort as a
--    RETURNS TABLE row set, the 0044 trap; callers read .rows).
-- =====================================================================================================
create or replace function public.city_sim_grade_inputs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select jsonb_build_object('rows', coalesce(jsonb_agg(
    jsonb_build_object(
      'betId',        b.id,
      'bucketIdx',    b.bucket_idx,
      'ask',          b.ask,
      'shares',       b.shares,
      'stakeUsd',     b.stake_usd,
      'feeRate',      b.fee_rate,
      'winnerIdx',    w.winner_idx,
      'actualNativeC', o.tmax_wu_native
    ) order by b.target_date, b.arm_hour
  ), '[]'::jsonb)) into v
  from public.city_paper_bets b
  join public.observations o
    on o.icao = b.icao and o.date_local = b.target_date and o.finalized_at is not null
  join lateral (
    select mb.bucket_idx as winner_idx
    from public.market_buckets mb
    where mb.event_id = b.event_id
      and (mb.low_native  is null or o.tmax_wu_native >= mb.low_native)
      and (mb.high_native is null or o.tmax_wu_native <= mb.high_native)
    limit 1
  ) w on true
  where b.status = 'pending';
  return v;
end;
$$;

-- =====================================================================================================
-- 7. SETTLE (idempotent) — p_settlements = SettlementRow[] from planSettlements. Only flips pending rows.
-- =====================================================================================================
create or replace function public.city_sim_settle(p_settlements jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0; r jsonb;
begin
  for r in select jsonb_array_elements(coalesce(p_settlements, '[]'::jsonb)) loop
    update public.city_paper_bets b set
      status         = case when (r->>'won')::boolean then 'won' else 'lost' end,
      won            = (r->>'won')::boolean,
      pnl_usd        = (r->>'pnlUsd')::numeric,
      fee_usd        = (r->>'feeUsd')::numeric,
      winner_idx     = (r->>'winnerIdx')::smallint,
      actual_native  = (r->>'actualNativeC')::smallint,
      graded_at      = now()
    where b.id = (r->>'betId')::uuid and b.status = 'pending';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

-- =====================================================================================================
-- 8. DASHBOARD READ — one jsonb for apps/web /paper-trade: per active city, the arm head-to-head + equity
--    curves + bet log + latest standing. operator_guard-gated on top of the authenticated grant.
-- =====================================================================================================
create or replace function public.dash_city_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  with cfg as (
    select cfg.city_id, cfg.slug, cfg.icao, cfg.tz, cfg.arm_hours, cfg.forecast_max_hour, cfg.stake_usd,
           c.display_name, c.unit
    from public.city_sim_config cfg
    join public.cities c on c.id = cfg.city_id
    where cfg.active
  ),
  per_city as (
    select cfg.*, (
      with b as (
        select * from public.city_paper_bets where city_id = cfg.city_id
      ),
      equity as (
        select arm_hour, target_date, status, pnl_usd,
          sum(coalesce(pnl_usd, 0)) over (partition by arm_hour order by target_date
            rows between unbounded preceding and current row) as cum
        from b
      ),
      arm_stats as (
        select arm_hour,
          count(*) as n_bets,
          count(*) filter (where status <> 'pending') as n_graded,
          count(*) filter (where status = 'pending')  as n_pending,
          count(*) filter (where status = 'won')       as n_won,
          sum(stake_usd) filter (where status <> 'pending') as staked_graded,
          coalesce(sum(pnl_usd), 0) as pnl,
          avg(ask) as avg_ask,
          avg((won)::int) filter (where status <> 'pending') as hit_rate
        from b group by arm_hour
      )
      select jsonb_build_object(
        'cityId', cfg.city_id, 'slug', cfg.slug, 'displayName', cfg.display_name, 'icao', cfg.icao,
        'unit', cfg.unit, 'tz', cfg.tz, 'armHours', cfg.arm_hours, 'stakeUsd', cfg.stake_usd,
        'coverage', (
          select jsonb_build_object(
            'firstDate', min(target_date), 'lastDate', max(target_date),
            'nDays', count(distinct target_date),
            'nGradedDays', count(distinct target_date) filter (where status <> 'pending'),
            'nPending', count(*) filter (where status = 'pending')
          ) from b
        ),
        'arms', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'hour', arm_hour, 'nBets', n_bets, 'nGraded', n_graded, 'nPending', n_pending, 'nWon', n_won,
            'staked', staked_graded, 'pnl', pnl,
            'roi', case when coalesce(staked_graded, 0) > 0 then pnl / staked_graded end,
            'hitRate', hit_rate, 'avgAsk', avg_ask
          ) order by arm_hour), '[]'::jsonb) from arm_stats
        ),
        'leader', (
          select jsonb_build_object('hour', arm_hour, 'pnl', pnl, 'nGraded', n_graded)
          from arm_stats where n_graded > 0 order by pnl desc, arm_hour limit 1
        ),
        'totals', (
          select jsonb_build_object(
            'pnl', coalesce(sum(pnl_usd), 0),
            'nGraded', count(*) filter (where status <> 'pending'),
            'nWon', count(*) filter (where status = 'won'),
            'staked', coalesce(sum(stake_usd) filter (where status <> 'pending'), 0)
          ) from b
        ),
        'equityByArm', (
          select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
            select arm_hour, jsonb_agg(jsonb_build_object(
              'date', target_date, 'pnl', pnl_usd, 'cum', cum, 'status', status
            ) order by target_date) as series
            from equity group by arm_hour
          ) s
        ),
        'betsByArm', (
          select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
            select arm_hour, jsonb_agg(jsonb_build_object('won', won, 'ask', ask) order by target_date) as series
            from b where status <> 'pending' group by arm_hour
          ) s
        ),
        'betLog', (
          select coalesce(jsonb_agg(row order by d desc, h desc), '[]'::jsonb) from (
            select target_date as d, arm_hour as h, jsonb_build_object(
              'date', target_date, 'hour', arm_hour, 'predictedC', predicted_native, 'label', label,
              'ask', ask, 'runMaxC', running_max_native, 'forecastC', forecast_native,
              'status', status, 'won', won, 'pnl', pnl_usd, 'actualC', actual_native
            ) as row
            from b order by target_date desc, arm_hour desc limit 80
          ) lg
        ),
        'latest', (
          select jsonb_build_object(
            'date', (select max(target_date) from b),
            'byHour', coalesce(jsonb_object_agg(arm_hour::text, jsonb_build_object(
              'predictedC', predicted_native, 'label', label, 'ask', ask, 'status', status,
              'won', won, 'pnl', pnl_usd, 'actualC', actual_native, 'runMaxC', running_max_native
            )), '{}'::jsonb)
          )
          from b where target_date = (select max(target_date) from b)
        )
      )
    ) as city_obj
    from cfg
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'config', jsonb_build_object('stakeUsd', 10, 'compareDays', 14),
    'cities', coalesce((select jsonb_agg(city_obj order by slug) from per_city), '[]'::jsonb),
    'overall', (
      select jsonb_build_object(
        'pnl', coalesce(sum(pnl_usd), 0),
        'nGraded', count(*) filter (where status <> 'pending'),
        'nWon', count(*) filter (where status = 'won')
      )
      from public.city_paper_bets b
      where b.city_id in (select city_id from cfg)
    )
  ) into v;

  return v;
end;
$$;

-- =====================================================================================================
-- 9. GRANTS (post-0034 contract) — internal RPCs service_role only; dash on authenticated + service_role.
-- =====================================================================================================
revoke all on function public.city_sim_active_configs() from public, anon, authenticated;
grant  execute on function public.city_sim_active_configs() to service_role;
revoke all on function public.city_sim_place_inputs(uuid, date, timestamptz) from public, anon, authenticated;
grant  execute on function public.city_sim_place_inputs(uuid, date, timestamptz) to service_role;
revoke all on function public.city_sim_record(uuid, text, text, jsonb) from public, anon, authenticated;
grant  execute on function public.city_sim_record(uuid, text, text, jsonb) to service_role;
revoke all on function public.city_sim_grade_inputs() from public, anon, authenticated;
grant  execute on function public.city_sim_grade_inputs() to service_role;
revoke all on function public.city_sim_settle(jsonb) from public, anon, authenticated;
grant  execute on function public.city_sim_settle(jsonb) to service_role;
revoke all on function public.dash_city_sim() from public, anon, authenticated;
grant  execute on function public.dash_city_sim() to service_role;
grant  execute on function public.dash_city_sim() to authenticated;

-- =====================================================================================================
-- 10. CRON — daily place + grade across all active cities. 10:00 UTC: every active city's last arm (14:00
--     local for WSSS=06:00 UTC / OPKC=09:00 UTC) has passed, so each arm reconstructs from persisted
--     intraday + in-lock-hour snapshots (faithful, no look-ahead), and yesterday's pending bets grade once
--     their observation finalizes. NB: a later-peaking city (e.g. Madrid, last arm 17:00 CEST = 15:00 UTC)
--     would need this moved later. Same Vault-secret pattern as 0039; idempotent (cron.schedule upserts).
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping city-paper-trade registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/city-paper-trade',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('city-paper-trade', '0 10 * * *', edge_command);
end;
$$;
