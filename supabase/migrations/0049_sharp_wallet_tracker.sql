-- 0049_sharp_wallet_tracker.sql — sharp-wallet & WEATHER-leaderboard benchmark tracker (analytics pivot).
--
-- WALLET-RECON-HANDOFF.md Build #1. An external Polymarket wallet ("badatmath.", 0x8fbd…a959) trades our
-- EXACT universe (daily-Tmax °C-bucket markets, ~45 global airport cities) and is verifiably profitable
-- (#1 on the WEATHER leaderboard; +$25.4k realized, a sharp regime change mid-May 2026). We ingest it +
-- the top-N WEATHER leaderboard daily and surface it on /amsterdam as an INDEPENDENT third forecaster: the
-- signal is DISAGREEMENT (their revealed bucket vs our forecast vs the market mid). This is NOT a
-- copy-trade and does NOT reopen trading (the live-trading thesis stays closed per FORECASTING-RD.md;
-- packages/trading stays dormant) — it is the analytics/insight value (a free, peer-verified benchmark).
--
-- Data plane: Polymarket's public, keyless data API (parsers in _shared/polymarket-wallet.ts). All writes
-- are idempotent (upsert / on-conflict-do-nothing) so the daily Edge tick (sharp-wallet-track) and the
-- manual script (scripts/sharp-wallets.ts) share these RPCs without drift, exactly the 0039 idiom.
--
-- Surface: dash_amsterdam_sim gains an additive `sharps` key (whole 0047 body re-stated, sharps block
-- appended) — stays in WEB_AUTHENTICATED (unchanged signature). The record RPCs are service-role-only
-- (post-0034 contract). New daily cron `sharp-wallet-track` at 16:00 UTC.

-- --- tables ------------------------------------------------------------------------------------------

-- The wallets we benchmark against. Seeded with the #1 sharp; the leaderboard recorder auto-adds the
-- top-N (source='leaderboard'). `enabled` lets the operator mute a wallet without losing its history.
create table if not exists public.tracked_wallets (
  address    text primary key,                                  -- Polygon proxy wallet (lowercase 0x…)
  label      text,                                              -- handle / userName (e.g. 'badatmath.')
  source     text not null default 'manual'
               check (source in ('leaderboard', 'manual')),
  enabled    boolean not null default true,
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace trigger trg_tracked_wallets_updated_at
  before update on public.tracked_wallets
  for each row execute function public.set_updated_at();

-- A daily snapshot of the WEATHER trader leaderboard (one row per rank per pull). Persisting our own pulls
-- keeps us within ToS (no live re-hitting the undocumented host) and lets us watch the sharp's rank/PnL/vol
-- trajectory over time.
create table if not exists public.wallet_leaderboard_snapshots (
  id          uuid primary key default gen_random_uuid(),
  captured_at timestamptz not null,
  time_period text not null,                                    -- 'DAY'|'WEEK'|'MONTH'|'ALL'
  rank        smallint not null,
  address     text not null,
  label       text,
  pnl_usd     numeric(16,2),
  volume_usd  numeric(18,2),
  created_at  timestamptz not null default now()
);

create unique index if not exists wallet_leaderboard_snapshots_natural_key
  on public.wallet_leaderboard_snapshots (captured_at, time_period, rank);
create index if not exists wallet_leaderboard_snapshots_addr_idx
  on public.wallet_leaderboard_snapshots (address, captured_at desc);

-- A daily snapshot of a tracked wallet's OPEN positions (its revealed bets). condition_id joins
-- market_buckets (0004) → event_id + bucket_idx so a position lines up with our ladder; city_slug /
-- target_date are parsed from the event slug (so we can filter to Amsterdam even for markets our universe
-- has not ingested). One row per (day, wallet, market-leg, side).
create table if not exists public.wallet_positions_daily (
  id               uuid primary key default gen_random_uuid(),
  as_of_date       date not null,                               -- the UTC date of the pull
  address          text not null references public.tracked_wallets(address),
  condition_id     text not null,                               -- per-bucket market condition id
  event_id         uuid references public.market_events(id),    -- resolved via condition_id (null if untracked)
  city_slug        text,                                        -- parsed from the event slug
  target_date      date,                                        -- the day the market resolves (station-local)
  bucket_idx       smallint,                                    -- ladder position (null if market untracked)
  outcome          text not null,                               -- 'Yes' | 'No' (the side held)
  size_shares      numeric(18,4) not null,
  avg_price        numeric(8,6),                                -- entry price = implied probability paid
  cur_price        numeric(8,6),
  cur_value_usd    numeric(14,4),
  cash_pnl_usd     numeric(14,4),
  realized_pnl_usd numeric(14,4),
  redeemable       boolean not null default false,
  title            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists wallet_positions_daily_natural_key
  on public.wallet_positions_daily (as_of_date, address, condition_id, outcome);
create index if not exists wallet_positions_daily_city_target_idx
  on public.wallet_positions_daily (city_slug, target_date);

create or replace trigger trg_wallet_positions_daily_updated_at
  before update on public.wallet_positions_daily
  for each row execute function public.set_updated_at();

-- --- seed --------------------------------------------------------------------------------------------
insert into public.tracked_wallets (address, label, source, notes)
values (
  '0x8fbd7cf5f806f563080864694415829f7229a959', 'badatmath.', 'manual',
  '#1 WEATHER leaderboard; verified +$25.4k realized, regime change ~May 14-21 2026; cheap-longshot edge (WALLET-RECON-HANDOFF.md)'
)
on conflict (address) do nothing;

-- --- RLS (mirror every other table: operator reads; service-role writes; anon nothing) ---------------
alter table public.tracked_wallets enable row level security;
drop policy if exists operator_read on public.tracked_wallets;
create policy operator_read on public.tracked_wallets
  for select to authenticated using (public.is_operator());
grant select on public.tracked_wallets to anon, authenticated;
grant all on public.tracked_wallets to service_role;

alter table public.wallet_leaderboard_snapshots enable row level security;
drop policy if exists operator_read on public.wallet_leaderboard_snapshots;
create policy operator_read on public.wallet_leaderboard_snapshots
  for select to authenticated using (public.is_operator());
grant select on public.wallet_leaderboard_snapshots to anon, authenticated;
grant all on public.wallet_leaderboard_snapshots to service_role;

alter table public.wallet_positions_daily enable row level security;
drop policy if exists operator_read on public.wallet_positions_daily;
create policy operator_read on public.wallet_positions_daily
  for select to authenticated using (public.is_operator());
grant select on public.wallet_positions_daily to anon, authenticated;
grant all on public.wallet_positions_daily to service_role;

-- --- record positions (idempotent) -------------------------------------------------------------------
-- p_rows: parsed WalletPosition[] (city/target already parsed TS-side). Ensures the wallet exists, then
-- upserts each leg, resolving event_id + bucket_idx from OUR ladder via condition_id (authoritative — a
-- leg on a market we have not ingested keeps null event_id/bucket_idx). Refreshes value/PnL on re-pull.
create or replace function public.sharp_wallet_record_positions(
  p_address text,
  p_label   text,
  p_as_of   date,
  p_rows    jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.tracked_wallets (address, label, source)
  values (p_address, coalesce(p_label, p_address), 'manual')
  on conflict (address) do nothing;

  insert into public.wallet_positions_daily
    (as_of_date, address, condition_id, event_id, city_slug, target_date, bucket_idx, outcome,
     size_shares, avg_price, cur_price, cur_value_usd, cash_pnl_usd, realized_pnl_usd, redeemable, title)
  select
    p_as_of, p_address, r->>'conditionId',
    mb.event_id, nullif(r->>'citySlug', ''), nullif(r->>'targetDate', '')::date, mb.bucket_idx,
    r->>'outcome',
    (r->>'sizeShares')::numeric, (r->>'avgPrice')::numeric, (r->>'curPrice')::numeric,
    (r->>'curValueUsd')::numeric, (r->>'cashPnlUsd')::numeric, (r->>'realizedPnlUsd')::numeric,
    coalesce((r->>'redeemable')::boolean, false), r->>'title'
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  left join lateral (
    select mb2.event_id, mb2.bucket_idx
    from public.market_buckets mb2
    where mb2.condition_id = r->>'conditionId'
    limit 1
  ) mb on true
  on conflict (as_of_date, address, condition_id, outcome) do update set
    event_id         = excluded.event_id,
    bucket_idx       = excluded.bucket_idx,
    city_slug        = excluded.city_slug,
    target_date      = excluded.target_date,
    size_shares      = excluded.size_shares,
    avg_price        = excluded.avg_price,
    cur_price        = excluded.cur_price,
    cur_value_usd    = excluded.cur_value_usd,
    cash_pnl_usd     = excluded.cash_pnl_usd,
    realized_pnl_usd = excluded.realized_pnl_usd,
    redeemable       = excluded.redeemable,
    title            = excluded.title;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- record leaderboard (idempotent) -----------------------------------------------------------------
-- p_rows: parsed LeaderboardEntry[]. Snapshots the board AND auto-registers each wallet in tracked_wallets
-- (source='leaderboard'), so the top-N flow into the position-ingest set without manual seeding.
create or replace function public.sharp_wallet_record_leaderboard(
  p_captured_at timestamptz,
  p_time_period text,
  p_rows        jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.tracked_wallets (address, label, source)
  select r->>'address', nullif(r->>'label', ''), 'leaderboard'
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where r->>'address' is not null
  on conflict (address) do nothing;

  insert into public.wallet_leaderboard_snapshots
    (captured_at, time_period, rank, address, label, pnl_usd, volume_usd)
  select
    p_captured_at, p_time_period, (r->>'rank')::smallint, r->>'address', nullif(r->>'label', ''),
    (r->>'pnlUsd')::numeric, (r->>'volumeUsd')::numeric
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where r->>'address' is not null
  on conflict (captured_at, time_period, rank) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- dashboard read: dash_amsterdam_sim + the additive `sharps` key ----------------------------------
-- 0047 body VERBATIM (create-or-replace; whole body re-stated as required) with one addition: after the
-- tomorrow/liveRunMax blocks, a `sharps` block surfaces the seeded sharp's revealed Amsterdam bet for the
-- soonest upcoming market and the 3-way disagreement (their bucket vs our house_ensemble argmax vs the
-- market's max-mid bucket). Null-safe: `sharps.hasSharp=false` until the tracker has written a row.
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
  -- latest pull date for the seeded sharp's Amsterdam positions, then the soonest target_date it holds that
  -- is still upcoming (>= today) — the market the disagreement is actionable analytics on.
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
    -- their highest-conviction held bucket: the max-size YES leg (the bucket they back to WIN) with a
    -- resolved ladder index. Falls back to null when only NO legs are held.
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
      -- our forecast: argmax of the latest house_ensemble probs (aligned to bucket_idx, 0-based).
      select (array_position(bp.probs, (select max(x) from unnest(bp.probs) x)) - 1)::smallint
        into v_o_bidx
      from public.bucket_probabilities bp
      where bp.event_id = v_s_event and bp.source = 'house_ensemble'
      order by bp.made_at desc
      limit 1;

      -- the market's modal bucket: highest latest mid (fallback (bid+ask)/2, then best_ask).
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

  -- latest leaderboard standing for the sharp (context for the card; null until the board is snapshotted).
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
    -- distinct non-null calls among {sharp, ours, market}: 1 = full agreement, 3 = three-way split.
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

  v := v || jsonb_build_object('tomorrow', v_tomorrow, 'liveRunMax', v_live, 'sharps', v_sharps);

  return v;
end;
$$;

-- --- grants (post-0034 contract) ---------------------------------------------------------------------
-- Record RPCs: service-role only (Edge Function + script via service role).
revoke all on function public.sharp_wallet_record_positions(text, text, date, jsonb) from public, anon, authenticated;
grant  execute on function public.sharp_wallet_record_positions(text, text, date, jsonb) to service_role;
revoke all on function public.sharp_wallet_record_leaderboard(timestamptz, text, jsonb) from public, anon, authenticated;
grant  execute on function public.sharp_wallet_record_leaderboard(timestamptz, text, jsonb) to service_role;

-- Dashboard read: create-or-replace preserves grants; re-assert the post-0034 contract explicitly.
revoke all on function public.dash_amsterdam_sim() from public, anon, authenticated;
grant  execute on function public.dash_amsterdam_sim() to service_role;
grant  execute on function public.dash_amsterdam_sim() to authenticated;

-- --- cron: daily sharp-wallet ingest -----------------------------------------------------------------
-- 16:00 UTC daily — pulls the WEATHER leaderboard + the tracked wallets' positions and snapshots them.
-- Same Vault-secret pattern as 0009/0026/0039; idempotent (cron.schedule upserts by jobname). PGlite has
-- no cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping sharp-wallet-track registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sharp-wallet-track',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('sharp-wallet-track', '0 16 * * *', edge_command);
end;
$$;
