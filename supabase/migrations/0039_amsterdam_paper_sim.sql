-- 0039_amsterdam_paper_sim.sql — the Amsterdam paper-trade simulation (analytics pivot).
--
-- The operator directive (2026-06-16): focus on ONE accurate city (Amsterdam/EHAM), find the best
-- intraday hour to bet, then RACE $10/day of fictitious money at 13/14/15/16 local under identical
-- rules and see which hour gains the most after ~14 days — a live, falsifiable score of our nowcast
-- against a real market. NOT live trading (the trading thesis stays closed, packages/trading dormant):
-- this is the model-vs-market insight value made tangible. Bucketing is whole-°C, exactly how the
-- Polymarket Amsterdam market resolves (to the WU EHAM daily high). The P&L math + place/grade
-- DECISIONS live once in @weather-edge/core (sim/amsterdam.ts, planPlacements/planSettlements); these
-- RPCs are thin data-access the edge function (amsterdam-paper-trade) and the backfill script share.
--
-- Surface: ONE operator-facing read RPC (dash_amsterdam_sim → apps/web /amsterdam) on `authenticated`
-- (added to migrations.test.ts WEB_AUTHENTICATED); the four internal place/grade RPCs are
-- service_role-only (post-0034 idiom: revoke from public/anon/authenticated, grant service_role).

-- --- table -------------------------------------------------------------------------------------------
create table if not exists public.amsterdam_paper_bets (
  id                 uuid primary key default gen_random_uuid(),
  target_date        date     not null,                         -- the day the market resolves (station-local)
  arm_hour           smallint not null,                         -- the lock hour (local Etc/GMT-2): 13/14/15/16
  event_id           uuid references public.market_events(id),
  predicted_native_c smallint not null,                         -- wuRound(running max known by arm_hour)
  bucket_idx         smallint not null,                         -- ladder bucket the prediction lands in
  label              text,                                      -- e.g. '22°C'
  ask                numeric(8,6) not null,                     -- recorded odds (price/share) at placement
  stake_usd          numeric(10,2) not null default 10,
  shares             numeric(14,4) not null,                    -- stake / ask
  fee_rate           numeric(5,4) not null default 0,
  running_max_c      numeric(5,2),                              -- the running max that drove the call
  status             text not null default 'pending'
                       check (status in ('pending', 'won', 'lost')),
  actual_native_c    smallint,                                  -- finalized actual, whole °C (null until graded)
  winner_idx         smallint,
  won                boolean,
  fee_usd            numeric(10,4),
  pnl_usd            numeric(10,4),                             -- net of fee; null until graded
  placed_at          timestamptz not null default now(),
  graded_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- One bet per (day, arm) — the idempotency backstop; record() ON CONFLICT DO NOTHING locks odds at
-- first placement so a re-run never re-prices a bet already on the board.
create unique index if not exists amsterdam_paper_bets_arm_key
  on public.amsterdam_paper_bets (target_date, arm_hour);
create index if not exists amsterdam_paper_bets_status_idx
  on public.amsterdam_paper_bets (status) where status = 'pending';
create index if not exists amsterdam_paper_bets_date_idx
  on public.amsterdam_paper_bets (target_date);

create or replace trigger trg_amsterdam_paper_bets_updated_at
  before update on public.amsterdam_paper_bets
  for each row execute function public.set_updated_at();

-- RLS: mirror every other table (operator reads; service-role writes; anon nothing).
alter table public.amsterdam_paper_bets enable row level security;
drop policy if exists operator_read on public.amsterdam_paper_bets;
create policy operator_read on public.amsterdam_paper_bets
  for select to authenticated using (public.is_operator());
grant select on public.amsterdam_paper_bets to anon, authenticated;
grant all on public.amsterdam_paper_bets to service_role;

-- --- place inputs ------------------------------------------------------------------------------------
-- For the target day's Amsterdam 'highest' event, return the ladder + per-arm reconstructed state:
-- the running max known by hour H and the forward-filled best_ask per bucket as of the end of hour H
-- (snapshots are delta-deduped, so the latest ≤ asof is the live quote). An arm is included only when
-- it is "due" (a past day, or today with H ≤ the current local hour) and not already placed. The engine
-- (planPlacements) picks the ask on OUR predicted bucket and builds the bet — so the odds a placement
-- records are exactly what a live order at hour H would have seen (no look-ahead).
create or replace function public.amsterdam_sim_place_inputs(
  p_target date,
  p_now    timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_fee      numeric;
  v_today    date := (p_now at time zone 'Etc/GMT-2')::date;
  v_now_hour int  := extract(hour from (p_now at time zone 'Etc/GMT-2'))::int;
  v_ladder   jsonb;
  v_labels   jsonb;
  v_arms     jsonb;
begin
  select me.id into v_event_id
  from public.market_events me
  join public.cities c on c.id = me.city_id
  where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = p_target
  order by me.created_at desc
  limit 1;
  if v_event_id is null then
    return null;  -- no Amsterdam market for that day (e.g. before discovery, or a gap)
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

  with due as (
    select h from unnest(array[13, 14, 15, 16]) h
    where (p_target < v_today or (p_target = v_today and h <= v_now_hour))
      and not exists (
        select 1 from public.amsterdam_paper_bets b
        where b.target_date = p_target and b.arm_hour = h
      )
  ),
  rm as (
    select due.h,
      (select max(ia.max_tenths_c) from public.intraday_advances ia
       where ia.icao = 'EHAM' and ia.date_local = p_target and ia.local_hour <= due.h) as runmax,
      (p_target::timestamp + make_interval(hours => due.h + 1)) at time zone 'Etc/GMT-2' as asof
    from due
  ),
  armed as (
    select rm.h, rm.runmax,
      (select jsonb_agg(jsonb_build_object('bucketIdx', mb.bucket_idx, 'ask',
                (select ms.best_ask from public.market_snapshots ms
                 where ms.bucket_id = mb.id and ms.captured_at < rm.asof and ms.best_ask is not null
                 order by ms.captured_at desc limit 1))
              order by mb.bucket_idx)
       from public.market_buckets mb where mb.event_id = v_event_id) as asks
    from rm
    where rm.runmax is not null
  )
  select jsonb_agg(jsonb_build_object('hour', h, 'runMaxC', runmax, 'asks', asks) order by h)
  into v_arms from armed;

  return jsonb_build_object(
    'targetDate', p_target,
    'eventId',    v_event_id,
    'feeRate',    v_fee,
    'ladder',     v_ladder,
    'labels',     v_labels,
    'arms',       coalesce(v_arms, '[]'::jsonb)
  );
end;
$$;

-- --- record placements (idempotent) ------------------------------------------------------------------
-- p_rows: the PlacementRow[] from planPlacements. ON CONFLICT DO NOTHING — first placement wins.
create or replace function public.amsterdam_sim_record(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.amsterdam_paper_bets
    (target_date, arm_hour, event_id, predicted_native_c, bucket_idx, label,
     ask, stake_usd, shares, fee_rate, running_max_c, placed_at)
  select
    (r->>'targetDate')::date, (r->>'armHour')::smallint, (r->>'eventId')::uuid,
    (r->>'predictedNativeC')::smallint, (r->>'bucketIdx')::smallint, r->>'label',
    (r->>'ask')::numeric, (r->>'stakeUsd')::numeric, (r->>'shares')::numeric,
    (r->>'feeRate')::numeric, (r->>'runMaxC')::numeric,
    coalesce((r->>'placedAt')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (target_date, arm_hour) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- grade inputs ------------------------------------------------------------------------------------
-- Pending bets whose EHAM observation has finalized: each carries its stored placement fields plus the
-- now-known winner bucket (integer containment of the finalized actual in the event ladder) and the
-- actual °C. The engine (planSettlements) computes won/pnl from these — one source of truth.
create or replace function public.amsterdam_sim_grade_inputs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select coalesce(jsonb_agg(
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
  ), '[]'::jsonb) into v
  from public.amsterdam_paper_bets b
  join public.observations o
    on o.icao = 'EHAM' and o.date_local = b.target_date and o.finalized_at is not null
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

-- --- settle (idempotent) -----------------------------------------------------------------------------
-- p_settlements: the SettlementRow[] from planSettlements. Only flips rows still pending.
create or replace function public.amsterdam_sim_settle(p_settlements jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0; r jsonb;
begin
  for r in select jsonb_array_elements(coalesce(p_settlements, '[]'::jsonb)) loop
    update public.amsterdam_paper_bets b set
      status          = case when (r->>'won')::boolean then 'won' else 'lost' end,
      won             = (r->>'won')::boolean,
      pnl_usd         = (r->>'pnlUsd')::numeric,
      fee_usd         = (r->>'feeUsd')::numeric,
      winner_idx      = (r->>'winnerIdx')::smallint,
      actual_native_c = (r->>'actualNativeC')::smallint,
      graded_at       = now()
    where b.id = (r->>'betId')::uuid and b.status = 'pending';
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

-- --- dashboard read ----------------------------------------------------------------------------------
-- ONE jsonb object for apps/web /amsterdam: the head-to-head of the 13/14/15/16 arms (each $10/day),
-- per-arm running totals + leaderboard, the equity curve per arm, the bet log, and the latest day's
-- standing prediction. operator_guard()-gated on top of the `authenticated` grant.
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
  -- per-arm cumulative equity, ordered by day
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
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'hour', arm_hour,
        'nBets', n_bets, 'nGraded', n_graded, 'nPending', n_pending, 'nWon', n_won,
        'staked', staked_graded, 'pnl', pnl,
        'roi', case when coalesce(staked_graded, 0) > 0 then pnl / staked_graded end,
        'hitRate', hit_rate, 'avgAsk', avg_ask, 'pnlAtCompare', pnl_at_compare
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
    'betLog', (
      select coalesce(jsonb_agg(row order by d desc, h desc), '[]'::jsonb) from (
        select target_date as d, arm_hour as h, jsonb_build_object(
          'date', target_date, 'hour', arm_hour, 'predictedC', predicted_native_c, 'label', label,
          'ask', ask, 'runMaxC', running_max_c, 'status', status, 'won', won,
          'pnl', pnl_usd, 'actualC', actual_native_c
        ) as row
        from b order by target_date desc, arm_hour desc limit 120
      ) lg
    ),
    'latest', (
      select jsonb_build_object(
        'date', (select d from latest_day),
        'byHour', coalesce(jsonb_object_agg(arm_hour::text, jsonb_build_object(
          'predictedC', predicted_native_c, 'label', label, 'ask', ask, 'status', status,
          'won', won, 'pnl', pnl_usd, 'actualC', actual_native_c, 'runMaxC', running_max_c
        )), '{}'::jsonb)
      )
      from b where target_date = (select d from latest_day)
    )
  ) into v;

  return v;
end;
$$;

-- --- grants (post-0034 contract) ---------------------------------------------------------------------
-- Internal place/grade RPCs: service_role only (Edge Function + script via service role).
revoke all on function public.amsterdam_sim_place_inputs(date, timestamptz) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_place_inputs(date, timestamptz) to service_role;
revoke all on function public.amsterdam_sim_record(jsonb) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_record(jsonb) to service_role;
revoke all on function public.amsterdam_sim_grade_inputs() from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_grade_inputs() to service_role;
revoke all on function public.amsterdam_sim_settle(jsonb) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_settle(jsonb) to service_role;

-- Dashboard read: service_role (unused by Edge) + the operator's authenticated session.
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;

-- --- cron: daily place + grade -----------------------------------------------------------------------
-- 15:30 UTC = 17:30 local (Etc/GMT-2): every arm hour (13–16 local = 11–14 UTC) has passed, so all four
-- arms reconstruct from persisted intraday + snapshots, and yesterday's pending bets grade once their
-- observation finalizes. Same Vault-secret pattern as 0009/0026; idempotent (cron.schedule upserts by
-- jobname). PGlite has no cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping amsterdam-paper-trade registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/amsterdam-paper-trade',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('amsterdam-paper-trade', '30 15 * * *', edge_command);
end;
$$;
