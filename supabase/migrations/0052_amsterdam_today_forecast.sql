-- 0052_amsterdam_today_forecast.sql — surface TODAY's predicted high from the FRESHEST same-day forecast.
--
-- Operator report (2026-06-23): the /amsterdam "Predicted high" tile read the forecast carried on the
-- LATEST PLACED BET (latest.byHour[*].forecastC). Today's four arms aren't placed until the afternoon lock
-- hours (13/14/15/16 local), so all morning the tile showed YESTERDAY's number and only flipped once the
-- day's first bet landed (~the afternoon Edge tick). The operator wants it to switch in the MORNING of the
-- day and stay as fresh as possible.
--
-- The fix mirrors the 0046 `tomorrow` block, but for TODAY and against the FRESHEST capture: forecast_snapshots
-- carries a same-day view (lead_days 0) — the previous night's 22Z run, then this morning's 10Z run as it lands
-- (~12:15 local). We take the batch with the latest captured_at for target_date = today (its cross-model mean
-- is the most recent NWP view of today's high), debias it by that lead's trailing-30 residual (the verbatim
-- amsterdam_sim_place_inputs / migration 0041 correction, >= 20 pairs to trust; DISPLAY falls back to the raw
-- forecast so a number always shows), wuRound to the whole-°C bucket, and price it against today's live ladder.
-- Because the page is force-dynamic, every request re-runs this — so the tile is always the current prediction.
--
-- This redefines the WHOLE 0049 dash_amsterdam_sim() body VERBATIM (create-or-replace; the 0046 tomorrow/
-- liveRunMax + 0049 sharps blocks are preserved exactly) and ADDS one top-level block: `today`. Everything
-- else is unchanged. Signature unchanged (operator-authenticated read). No table changes.

create or replace function public.dash_amsterdam_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_today    date    := (now() at time zone 'Etc/GMT-2')::date;
  v_tmrw     date    := (now() at time zone 'Etc/GMT-2')::date + 1;
  v_t_event  uuid;
  v_t_raw    numeric;   -- cross-model lead-1 mean for tomorrow (°C), uncorrected
  v_t_nmod   int;       -- DISTINCT models behind the mean (0047 — was count(*) captures in 0046)
  v_t_bias   numeric;   -- trailing-30 mean(actual − forecast) residual
  v_t_bias_n int;       -- pairs behind the bias (<= 30)
  v_t_fc     numeric;   -- displayed forecast: corrected when >= 20 pairs, else raw
  v_t_corr   boolean;   -- whether the bias correction was applied
  v_t_pred   int;       -- wuRound(v_t_fc) — the whole-°C call
  v_t_bid    uuid;      -- ladder bucket id containing v_t_pred (tomorrow's market)
  v_t_label  text;      -- that bucket's label
  v_t_ask    numeric;   -- latest best_ask on that bucket
  v_tomorrow jsonb;
  v_live     jsonb;
  -- today (0052) — freshest same-day forecast scratch
  v_d_cap    timestamptz; -- the latest capture instant for target_date = today (the freshest batch)
  v_d_lead   int;       -- that capture's lead (0 same-day, 1 if no lead-0 yet)
  v_d_raw    numeric;    -- cross-model mean of the freshest batch (°C), uncorrected
  v_d_nmod   int;        -- DISTINCT models behind that mean
  v_d_bias   numeric;    -- trailing-30 mean(actual − forecast) residual for that lead
  v_d_bias_n int;        -- pairs behind the residual (<= 30)
  v_d_fc     numeric;    -- displayed forecast: corrected when >= 20 pairs, else raw
  v_d_corr   boolean;    -- whether the correction was applied
  v_d_pred   int;        -- wuRound(v_d_fc) — today's whole-°C call
  v_d_event  uuid;       -- today's Amsterdam market event
  v_d_bid    uuid;       -- ladder bucket id containing v_d_pred (today's market)
  v_d_label  text;       -- that bucket's label
  v_d_ask    numeric;    -- latest best_ask on that bucket
  v_today_o  jsonb;
  -- sharps (0049)
  v_s_addr   text := '0x8fbd7cf5f806f563080864694415829f7229a959';  -- the seeded #1 WEATHER sharp
  v_s_asof   date;
  v_s_focus  date;      -- the target_date we compare on (soonest upcoming the sharp holds)
  v_s_event  uuid;
  v_s_bidx   smallint;  -- their highest-conviction (max-size) YES bucket
  v_s_label  text;
  v_o_bidx   smallint;  -- our house_ensemble argmax bucket
  v_o_label  text;
  v_m_bidx   smallint;  -- the market's max-mid bucket
  v_m_label  text;
  v_s_rank   smallint;
  v_s_pnl    numeric;
  v_sharps   jsonb;
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
    'betsByArm', (
      select coalesce(jsonb_object_agg(arm_hour::text, series), '{}'::jsonb) from (
        select arm_hour, jsonb_agg(jsonb_build_object('won', won, 'ask', ask) order by target_date) as series
        from b where status <> 'pending'
        group by arm_hour
      ) s
    ),
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

  -- ── tomorrow's prediction (0046) — nModels now DISTINCT models (0047) ────────────────────────────────
  select avg(fs.tmax_c), count(distinct fs.model)
    into v_t_raw, v_t_nmod
  from public.forecast_snapshots fs
  where fs.icao = 'EHAM' and fs.target_date = v_tmrw and fs.lead_days = 1;

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
      and o.date_local < v_tmrw
    order by o.date_local desc
    limit 30
  )
  select avg(resid), count(*) into v_t_bias, v_t_bias_n from pairs;

  v_t_corr := (v_t_raw is not null and coalesce(v_t_bias_n, 0) >= 20);
  v_t_fc   := case when v_t_raw is null then null
                   when v_t_corr then v_t_raw + coalesce(v_t_bias, 0)
                   else v_t_raw end;
  v_t_pred := case when v_t_fc is null then null else round(v_t_fc)::int end;   -- wuRound (half away from 0, +°C)

  select me.id into v_t_event
  from public.market_events me
  join public.cities c on c.id = me.city_id
  where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = v_tmrw
  order by me.created_at desc
  limit 1;

  if v_t_event is not null and v_t_pred is not null then
    select mb.id, mb.label into v_t_bid, v_t_label
    from public.market_buckets mb
    where mb.event_id = v_t_event
      and (mb.low_native  is null or v_t_pred >= mb.low_native)
      and (mb.high_native is null or v_t_pred <= mb.high_native)
    order by mb.bucket_idx
    limit 1;

    if v_t_bid is not null then
      select ms.best_ask into v_t_ask
      from public.market_snapshots ms
      where ms.bucket_id = v_t_bid and ms.best_ask is not null
      order by ms.captured_at desc
      limit 1;
    end if;
  end if;

  v_tomorrow := jsonb_build_object(
    'targetDate',    v_tmrw,
    'hasMarket',     (v_t_event is not null),
    'nModels',       v_t_nmod,
    'rawForecastC',  v_t_raw,
    'biasC',         v_t_bias,
    'biasN',         coalesce(v_t_bias_n, 0),
    'biasCorrected', v_t_corr,
    'forecastC',     v_t_fc,
    'predictedC',    v_t_pred,
    'label',         v_t_label,
    'ask',           v_t_ask
  );

  -- ── today's prediction (0052) — the freshest same-day forecast, debiased on the matched lead ─────────
  -- The freshest batch = the rows whose captured_at is the latest for target_date = today (a single
  -- (lead, slot) run, since captured_at uniquely identifies a capture). lead 0 when the same-day run has
  -- landed; lead 1 from the night before until it does. The page re-runs this on every request, so the
  -- headline tracks the most recent NWP view all day.
  select max(fs.captured_at) into v_d_cap
  from public.forecast_snapshots fs
  where fs.icao = 'EHAM' and fs.target_date = v_today;

  if v_d_cap is not null then
    select fs.lead_days, avg(fs.tmax_c), count(distinct fs.model)
      into v_d_lead, v_d_raw, v_d_nmod
    from public.forecast_snapshots fs
    where fs.icao = 'EHAM' and fs.target_date = v_today and fs.captured_at = v_d_cap
    group by fs.lead_days;

    -- trailing-30 residual for the chosen lead (mirrors the lead-1 debias in amsterdam_sim_place_inputs /
    -- migration 0041; the only difference is the lead is the freshest available, not pinned to 1).
    with fcd as (
      select fs.target_date, avg(fs.tmax_c) as fc
      from public.forecast_snapshots fs
      where fs.icao = 'EHAM' and fs.lead_days = v_d_lead
      group by fs.target_date
    ),
    pairs as (
      select (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end) - fcd.fc as resid
      from public.observations o
      join fcd on fcd.target_date = o.date_local
      where o.icao = 'EHAM' and o.finalized_at is not null and o.tmax_wu_native is not null
        and o.date_local < v_today
      order by o.date_local desc
      limit 30
    )
    select avg(resid), count(*) into v_d_bias, v_d_bias_n from pairs;

    v_d_corr := (v_d_raw is not null and coalesce(v_d_bias_n, 0) >= 20);
    v_d_fc   := case when v_d_raw is null then null
                     when v_d_corr then v_d_raw + coalesce(v_d_bias, 0)
                     else v_d_raw end;
    v_d_pred := case when v_d_fc is null then null else round(v_d_fc)::int end;   -- wuRound (half away from 0, +°C)

    select me.id into v_d_event
    from public.market_events me
    join public.cities c on c.id = me.city_id
    where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = v_today
    order by me.created_at desc
    limit 1;

    if v_d_event is not null and v_d_pred is not null then
      select mb.id, mb.label into v_d_bid, v_d_label
      from public.market_buckets mb
      where mb.event_id = v_d_event
        and (mb.low_native  is null or v_d_pred >= mb.low_native)
        and (mb.high_native is null or v_d_pred <= mb.high_native)
      order by mb.bucket_idx
      limit 1;

      if v_d_bid is not null then
        select ms.best_ask into v_d_ask
        from public.market_snapshots ms
        where ms.bucket_id = v_d_bid and ms.best_ask is not null
        order by ms.captured_at desc
        limit 1;
      end if;
    end if;
  end if;

  v_today_o := jsonb_build_object(
    'targetDate',    v_today,
    'hasMarket',     (v_d_event is not null),
    'lead',          v_d_lead,
    'capturedAt',    v_d_cap,
    'nModels',       v_d_nmod,
    'rawForecastC',  v_d_raw,
    'biasC',         v_d_bias,
    'biasN',         coalesce(v_d_bias_n, 0),
    'biasCorrected', v_d_corr,
    'forecastC',     v_d_fc,
    'predictedC',    v_d_pred,
    'label',         v_d_label,
    'ask',           v_d_ask
  );

  -- ── live running max as of now (0046) ────────────────────────────────────────────────────────────────
  select jsonb_build_object(
    'date',       im.date_local,
    'maxTenthsC', im.max_tenths_c,
    'maxNative',  im.max_native,
    'nObs',       im.n_obs,
    'lastObsAt',  im.last_obs_at
  ) into v_live
  from public.intraday_max im
  where im.icao = 'EHAM' and im.date_local = v_today;

  -- ── sharp-wallet disagreement (0049) ─────────────────────────────────────────────────────────────────
  select max(as_of_date) into v_s_asof
  from public.wallet_positions_daily
  where address = v_s_addr and city_slug = 'amsterdam';

  if v_s_asof is not null then
    select min(target_date) into v_s_focus
    from public.wallet_positions_daily
    where address = v_s_addr and city_slug = 'amsterdam' and as_of_date = v_s_asof
      and target_date is not null and target_date >= v_today;
    if v_s_focus is null then
      select max(target_date) into v_s_focus
      from public.wallet_positions_daily
      where address = v_s_addr and city_slug = 'amsterdam' and as_of_date = v_s_asof
        and target_date is not null;
    end if;
  end if;

  if v_s_focus is not null then
    select bucket_idx into v_s_bidx
    from public.wallet_positions_daily
    where address = v_s_addr and city_slug = 'amsterdam' and as_of_date = v_s_asof
      and target_date = v_s_focus and outcome = 'Yes' and bucket_idx is not null
    order by size_shares desc
    limit 1;

    select me.id into v_s_event
    from public.market_events me
    join public.cities c on c.id = me.city_id
    where c.slug = 'amsterdam' and me.kind = 'highest' and me.target_date = v_s_focus
    order by me.created_at desc
    limit 1;

    if v_s_event is not null then
      select (array_position(bp.probs, (select max(x) from unnest(bp.probs) x)) - 1)::smallint
        into v_o_bidx
      from public.bucket_probabilities bp
      where bp.event_id = v_s_event and bp.source = 'house_ensemble'
      order by bp.made_at desc
      limit 1;

      select mb.bucket_idx into v_m_bidx
      from public.market_buckets mb
      join lateral (
        select ms.mid, ms.best_bid, ms.best_ask
        from public.market_snapshots ms
        where ms.bucket_id = mb.id
        order by ms.captured_at desc
        limit 1
      ) s on true
      where mb.event_id = v_s_event
      order by coalesce(s.mid, (s.best_bid + s.best_ask) / 2, s.best_ask) desc nulls last, mb.bucket_idx
      limit 1;

      select label into v_s_label from public.market_buckets where event_id = v_s_event and bucket_idx = v_s_bidx;
      select label into v_o_label from public.market_buckets where event_id = v_s_event and bucket_idx = v_o_bidx;
      select label into v_m_label from public.market_buckets where event_id = v_s_event and bucket_idx = v_m_bidx;
    end if;
  end if;

  select rank, pnl_usd into v_s_rank, v_s_pnl
  from public.wallet_leaderboard_snapshots
  where address = v_s_addr
  order by captured_at desc, time_period
  limit 1;

  v_sharps := jsonb_build_object(
    'hasSharp',    (v_s_focus is not null),
    'address',     v_s_addr,
    'label',       (select label from public.tracked_wallets where address = v_s_addr),
    'asOfDate',    v_s_asof,
    'targetDate',  v_s_focus,
    'rank',        v_s_rank,
    'pnlUsd',      v_s_pnl,
    'sharpBucketIdx',  v_s_bidx, 'sharpLabel',  v_s_label,
    'ourBucketIdx',    v_o_bidx, 'ourLabel',    v_o_label,
    'marketBucketIdx', v_m_bidx, 'marketLabel', v_m_label,
    'disagreement', (
      select count(distinct x) from unnest(array[v_s_bidx, v_o_bidx, v_m_bidx]) x where x is not null
    ),
    'signedDeltaIdx', case when v_s_bidx is not null and v_o_bidx is not null then v_s_bidx - v_o_bidx end,
    'positions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'targetDate', target_date, 'bucketIdx', bucket_idx, 'outcome', outcome,
        'sizeShares', size_shares, 'avgPrice', avg_price, 'curValueUsd', cur_value_usd, 'title', title
      ) order by target_date, bucket_idx), '[]'::jsonb)
      from public.wallet_positions_daily
      where address = v_s_addr and city_slug = 'amsterdam' and as_of_date = v_s_asof
    )
  );

  v := v || jsonb_build_object(
    'tomorrow', v_tomorrow, 'today', v_today_o, 'liveRunMax', v_live, 'sharps', v_sharps
  );

  return v;
end;
$$;

-- create-or-replace preserves grants; re-assert the post-0034 contract explicitly.
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;
