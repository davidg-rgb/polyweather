-- 0043_amsterdam_truth_floor_accuracy.sql — floor "truth accuracy" vs the true decimal high (KNMI).
--
-- The 0039–0042 sim scores our whole-°C call against the MARKET's resolution: wuRound(WU's reported integer
-- high) bucketed on the ladder — that drives the paper-trade P&L and stays its own number. But WU reports a
-- rounded INTEGER, and the buckets can be wider than 1° at the tails, so the market `won` is a noisy measure
-- of forecast skill. This migration adds a second, cleaner lens (operator directive 2026-06-17): score the
-- call against the integer FLOOR of the REAL station daily high, taken at 0.1°C from KNMI (Schiphol, station
-- 240, variable TX) — and log the continuous signed forecast error at decimal resolution.
--
--   truth_won      := predicted_native_c = floor(actual_decimal_c)      (the operator's exact spec)
--   signed_error_c := nowcastBasisC(running_max, arm_hour, forecast_c) − actual_decimal_c   (decimals)
--
-- The decimal actual lives in a new reference table `amsterdam_truth` (one row per day, backfilled ~880 days
-- by scripts/amsterdam-truth-backfill.ts from the free KNMI daggegevens API — no auth, 0.1°C, verified
-- 2024-01-01→ with zero gaps). Truth is INDEPENDENT of market grading: a bet's truth fields are filled by a
-- separate pass (amsterdam_sim_truth_inputs → planTruth → amsterdam_sim_truth_record) the moment KNMI has the
-- day, whether or not the market bet has graded — so "market accuracy stays its own number". The floor/error
-- DECISION lives once in @weather-edge/core (sim/amsterdam.ts — floorTruthHit/planTruth); these RPCs are thin
-- data-access the Edge Function and the backfill script share. dash_amsterdam_sim gains the truth panel
-- (per-arm floor-hit + decimal MAE/bias) + truth columns in the bet log; signature unchanged (stays in
-- WEB_AUTHENTICATED). The four internal truth RPCs are service_role-only (post-0034 idiom).

-- --- reference table: the decimal daily high (KNMI) ---------------------------------------------------
create table if not exists public.amsterdam_truth (
  date_local  date primary key,                          -- station-local day (Etc/GMT-2)
  tx_tenths_c numeric(4,1) not null,                      -- KNMI Schiphol daily max, native 0.1°C (e.g. 22.5)
  source      text not null default 'knmi-240',           -- provenance (KNMI daggegevens station 240 / var TX)
  fetched_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.amsterdam_truth is
  'Decimal (0.1°C) true daily high for EHAM/Schiphol from KNMI daggegevens (station 240, var TX). The truth '
  'basis for floor "truth accuracy" — distinct from observations.tmax_wu_native (WU''s rounded integer, which '
  'resolves the market). Backfilled by scripts/amsterdam-truth-backfill.ts.';

create or replace trigger trg_amsterdam_truth_updated_at
  before update on public.amsterdam_truth
  for each row execute function public.set_updated_at();

-- RLS: mirror amsterdam_paper_bets (operator reads; service-role writes; anon nothing).
alter table public.amsterdam_truth enable row level security;
drop policy if exists operator_read on public.amsterdam_truth;
create policy operator_read on public.amsterdam_truth
  for select to authenticated using (public.is_operator());
grant select on public.amsterdam_truth to anon, authenticated;
grant all on public.amsterdam_truth to service_role;

-- --- bet columns: the floor-truth outcome + decimal signed error -------------------------------------
alter table public.amsterdam_paper_bets
  add column if not exists actual_decimal_c numeric(4,1),   -- KNMI decimal actual (°C); null until truth lands
  add column if not exists truth_won        boolean,        -- predicted_native_c = floor(actual_decimal_c)
  add column if not exists signed_error_c   numeric(5,2);   -- nowcast basis − actual_decimal_c (signed, decimals)

comment on column public.amsterdam_paper_bets.actual_decimal_c is
  'KNMI Schiphol decimal daily high (°C, 0.1°) for the day — the floor-truth basis; null until amsterdam_truth has the day.';
comment on column public.amsterdam_paper_bets.truth_won is
  'Floor truth accuracy: predicted_native_c = floor(actual_decimal_c). Distinct from `won` (market resolution). Null until truth lands.';
comment on column public.amsterdam_paper_bets.signed_error_c is
  'Signed forecast error (°C, decimals): nowcast basis (running_max lifted by forecast_c at arms <= 14) − actual_decimal_c. Positive = ran hot.';

-- --- truth upsert (idempotent) — the KNMI backfill writer --------------------------------------------
-- p_rows: [{dateLocal, txTenthsC, source?}]. Upsert by day; a later KNMI revision overwrites (re-grading
-- the affected bets happens via the truth_inputs/record pass, which recomputes on any value change).
create or replace function public.amsterdam_truth_upsert(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.amsterdam_truth (date_local, tx_tenths_c, source, fetched_at)
  select (r->>'dateLocal')::date, (r->>'txTenthsC')::numeric,
         coalesce(r->>'source', 'knmi-240'), now()
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (date_local) do update
    set tx_tenths_c = excluded.tx_tenths_c, source = excluded.source, fetched_at = now()
    where amsterdam_truth.tx_tenths_c is distinct from excluded.tx_tenths_c
       or amsterdam_truth.source     is distinct from excluded.source;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- truth inputs ------------------------------------------------------------------------------------
-- Every placed bet whose day now has a KNMI decimal actual AND whose stored truth is stale (null, or the
-- KNMI value changed) — with the pieces the engine (planTruth) needs to recompute floor-truth + signed error.
-- Independent of market status: a bet can get its truth before OR after it grades on the market.
create or replace function public.amsterdam_sim_truth_inputs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'betId',            b.id,
      'armHour',          b.arm_hour,
      'predictedNativeC', b.predicted_native_c,
      'runMaxC',          b.running_max_c,
      'forecastC',        b.forecast_c,
      'actualDecimalC',   t.tx_tenths_c
    ) order by b.target_date, b.arm_hour
  ), '[]'::jsonb) into v
  from public.amsterdam_paper_bets b
  join public.amsterdam_truth t on t.date_local = b.target_date
  where b.actual_decimal_c is distinct from t.tx_tenths_c;  -- needs (re)compute: null or KNMI revised
  return v;
end;
$$;

-- --- truth record (idempotent) -----------------------------------------------------------------------
-- p_rows: the TruthRow[] from planTruth. Writes the floor-truth outcome + signed error onto the bet,
-- regardless of market status (truth is its own number).
create or replace function public.amsterdam_sim_truth_record(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0; r jsonb;
begin
  for r in select jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    update public.amsterdam_paper_bets b set
      actual_decimal_c = (r->>'actualDecimalC')::numeric,
      truth_won        = (r->>'truthWon')::boolean,
      signed_error_c   = (r->>'signedErrorC')::numeric
    where b.id = (r->>'betId')::uuid;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

-- --- dashboard read (0042 body + the floor-truth panel) ----------------------------------------------
-- Adds, per arm: truth floor-hit count + the (truthWon, signedErrorC) rows for the CI (truthByArm), and the
-- decimal actual / signed error / truth outcome in the bet log + latest call. Plus a truthCoverage summary.
-- Everything else is the 0042 body verbatim. Signature unchanged (operator-authenticated read).
create or replace function public.dash_amsterdam_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  with b as (
    select * from public.amsterdam_paper_bets
  ),
  equity as (
    select arm_hour, target_date, status, won, pnl_usd, ask, label, predicted_native_c, actual_native_c,
      sum(coalesce(pnl_usd, 0)) over (partition by arm_hour order by target_date
                                      rows between unbounded preceding and current row) as cum,
      row_number() over (partition by arm_hour, (status <> 'pending') order by target_date) as graded_rank
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
      avg((won)::int) filter (where status <> 'pending') as hit_rate,
      -- floor "truth accuracy" — independent of market status (truth_won is set the moment KNMI lands)
      count(*) filter (where truth_won is not null)  as n_truth,
      count(*) filter (where truth_won is true)      as n_truth_won,
      avg((truth_won)::int) filter (where truth_won is not null) as truth_hit_rate,
      avg(abs(signed_error_c)) filter (where signed_error_c is not null) as mae,
      avg(signed_error_c) filter (where signed_error_c is not null)      as bias,
      coalesce(sum(pnl_usd) filter (
        where status <> 'pending'
          and target_date <= (
            select min(t14) from (
              select target_date as t14 from b b2
              where b2.arm_hour = b.arm_hour and b2.status <> 'pending'
              order by target_date offset 13 limit 1
            ) q
          )
      ), coalesce(sum(pnl_usd) filter (where status <> 'pending'), 0)) as pnl_at_compare
    from b
    group by arm_hour
  ),
  latest_day as (
    select max(target_date) as d from b
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'config', jsonb_build_object('primaryHour', 15, 'armHours', jsonb_build_array(13, 14, 15, 16),
                                 'compareDays', 14, 'stakeUsd', 10),
    'coverage', (
      select jsonb_build_object(
        'firstDate', min(target_date), 'lastDate', max(target_date),
        'nDays', count(distinct target_date),
        'nGradedDays', count(distinct target_date) filter (where status <> 'pending'),
        'nPending', count(*) filter (where status = 'pending')
      ) from b
    ),
    -- floor-truth coverage: how many bets/days carry a KNMI decimal actual, and the reference table's span.
    'truthCoverage', (
      select jsonb_build_object(
        'nBetsWithTruth', count(*) filter (where truth_won is not null),
        'nDaysWithTruth', count(distinct target_date) filter (where actual_decimal_c is not null),
        'tableFirstDate', (select min(date_local) from public.amsterdam_truth),
        'tableLastDate',  (select max(date_local) from public.amsterdam_truth),
        'tableNDays',     (select count(*) from public.amsterdam_truth)
      ) from b
    ),
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', arm_hour,
        'nBets', n_bets, 'nGraded', n_graded, 'nPending', n_pending, 'nWon', n_won,
        'staked', staked_graded, 'pnl', pnl,
        'roi', case when coalesce(staked_graded, 0) > 0 then pnl / staked_graded end,
        'hitRate', hit_rate, 'avgAsk', avg_ask, 'pnlAtCompare', pnl_at_compare,
        'nTruth', n_truth, 'nTruthWon', n_truth_won, 'truthHitRate', truth_hit_rate,
        'mae', mae, 'bias', bias
      ) order by arm_hour), '[]'::jsonb) from arm_stats
    ),
    'leader', (
      select jsonb_build_object('hour', arm_hour, 'pnl', pnl, 'nGraded', n_graded)
      from arm_stats where n_graded > 0 order by pnl desc, arm_hour limit 1
    ),
    'equityByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object(
          'date', target_date, 'pnl', pnl_usd, 'cum', cum, 'status', status
        ) order by target_date) as series
        from equity group by arm_hour
      ) s
    ),
    -- 0042: per-arm graded (won, ask) — the market edge/EV CI input.
    'betsByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object('won', won, 'ask', ask) order by target_date) as series
        from b where status <> 'pending'
        group by arm_hour
      ) s
    ),
    -- 0043: per-arm (truthWon, signedErrorC) — the floor-hit / MAE / bias CI input (armTruthStats).
    'truthByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object('truthWon', truth_won, 'signedErrorC', signed_error_c)
                                   order by target_date) as series
        from b where truth_won is not null
        group by arm_hour
      ) s
    ),
    'betLog', (
      select coalesce(jsonb_agg(row order by d desc, h desc), '[]'::jsonb) from (
        select target_date as d, arm_hour as h, jsonb_build_object(
          'date', target_date, 'hour', arm_hour, 'predictedC', predicted_native_c, 'label', label,
          'ask', ask, 'runMaxC', running_max_c, 'forecastC', forecast_c, 'status', status, 'won', won,
          'pnl', pnl_usd, 'actualC', actual_native_c,
          'actualDecimalC', actual_decimal_c, 'signedErrorC', signed_error_c, 'truthWon', truth_won
        ) as row
        from b order by target_date desc, arm_hour desc limit 120
      ) lg
    ),
    'latest', (
      select jsonb_build_object(
        'date', (select d from latest_day),
        'byHour', coalesce(jsonb_object_agg(arm_hour::text, jsonb_build_object(
          'predictedC', predicted_native_c, 'label', label, 'ask', ask, 'status', status,
          'won', won, 'pnl', pnl_usd, 'actualC', actual_native_c, 'runMaxC', running_max_c,
          'forecastC', forecast_c,
          'actualDecimalC', actual_decimal_c, 'signedErrorC', signed_error_c, 'truthWon', truth_won
        )), '{}'::jsonb)
      )
      from b where target_date = (select d from latest_day)
    )
  ) into v;

  return v;
end;
$$;

-- --- grants (post-0034 contract) ---------------------------------------------------------------------
-- Internal truth RPCs: service_role only (Edge Function + backfill script via service role).
revoke all on function public.amsterdam_truth_upsert(jsonb) from public, anon, authenticated;
grant  execute on function public.amsterdam_truth_upsert(jsonb) to service_role;
revoke all on function public.amsterdam_sim_truth_inputs() from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_truth_inputs() to service_role;
revoke all on function public.amsterdam_sim_truth_record(jsonb) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_truth_record(jsonb) to service_role;

-- Dashboard read: create-or-replace preserves grants, but re-assert the post-0034 contract explicitly.
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;
