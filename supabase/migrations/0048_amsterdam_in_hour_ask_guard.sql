-- 0048_amsterdam_in_hour_ask_guard.sql — only record an ask that was QUOTED IN THE LOCK HOUR.
--
-- Data-integrity fix (operator audit, 2026-06-21). amsterdam_sim_place_inputs reconstructed each arm's
-- ask as the latest market_snapshots.best_ask with `captured_at < asof` (asof = end of the lock hour) —
-- an UNBOUNDED backward forward-fill. On thin early days that reaches back to a quote captured BEFORE the
-- lock hour (or, in the worst seed cases, a value that no in-hour quote ever carried), so the dashboard
-- showed odds that were never quoted "at the specific time" the arm locks. The audit found 6 of the first
-- 8 bets (2026-06-12 / 06-13) carrying an ask that matches NO snapshot on the bet's bucket at any time, and
-- the real in-lock-hour quote differing materially (e.g. 06-13 13:00 recorded 0.39 vs real 0.49 — a winning
-- bet that inflated the 13:00 leaderboard).
--
-- The fix bounds the forward-fill to the lock hour itself: the ask must be the latest quote with
-- `captured_at >= lockstart AND captured_at < asof`, where lockstart = the arm hour and asof = the next
-- hour (both at Etc/GMT-2). No in-hour quote → the bucket's ask is null → placeSimBet returns null →
-- planPlacements SKIPS the arm (a no-bet day, never a phantom). This is the "validated odds at the specific
-- time" contract. Everything else is the 0041 body VERBATIM (bias-corrected forecast lift, due-gate,
-- runmax reconstruction); only the ask subquery's lower time bound is added. Signature unchanged
-- (service_role read); no table changes. The same RPC feeds BOTH the live Edge tick and the backfill
-- script, so the live and historical placements share this one guard.

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
  v_raw_fc   numeric;
  v_bias     numeric;
  v_bias_n   int;
  v_forecast numeric;
begin
  select me.id into v_event_id
  from public.market_events me
  join public.cities c on c.id = me.city_id
  where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = p_target
  order by me.created_at desc
  limit 1;
  if v_event_id is null then
    return null;
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

  -- Bias-corrected lead-1 forecast of the day's high (°C). Both pieces are known before the day starts.
  select avg(fs.tmax_c) into v_raw_fc
  from public.forecast_snapshots fs
  where fs.icao = 'EHAM' and fs.target_date = p_target and fs.lead_days = 1;

  with fc1 as (
    select fs.target_date, avg(fs.tmax_c) as fc
    from public.forecast_snapshots fs
    where fs.icao = 'EHAM' and fs.lead_days = 1
    group by fs.target_date
  ),
  pairs as (
    select (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end) - fc1.fc as resid
    from public.observations o
    join fc1 on fc1.target_date = o.date_local
    where o.icao = 'EHAM' and o.finalized_at is not null and o.tmax_wu_native is not null
      and o.date_local < p_target
    order by o.date_local desc
    limit 30   -- AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS (mirror core/sim/amsterdam.ts)
  )
  select avg(resid), count(*) into v_bias, v_bias_n from pairs;

  v_forecast := case when v_raw_fc is not null and coalesce(v_bias_n, 0) >= 20   -- AMSTERDAM_SIM_DEBIAS_MIN_PAIRS
                     then v_raw_fc + coalesce(v_bias, 0) end;

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
      -- 0048: the lock hour window [lockstart, asof) — the ask must be QUOTED inside it (no cross-hour fill).
      (p_target::timestamp + make_interval(hours => due.h))     at time zone 'Etc/GMT-2' as lockstart,
      (p_target::timestamp + make_interval(hours => due.h + 1)) at time zone 'Etc/GMT-2' as asof
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
    'targetDate', p_target,
    'eventId',    v_event_id,
    'feeRate',    v_fee,
    'ladder',     v_ladder,
    'labels',     v_labels,
    'forecastC',  v_forecast,
    'arms',       coalesce(v_arms, '[]'::jsonb)
  );
end;
$$;

-- create-or-replace preserves grants; re-assert the post-0034 contract (service_role only).
revoke all on function public.amsterdam_sim_place_inputs(date, timestamptz) from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_place_inputs(date, timestamptz) to service_role;
