-- 0054_market_fee_reward_config — REC-3 (MAKER-REBATE-HANDOFF.md §4 / REC-3).
-- Capture the FULL per-market fee + reward config the Gamma event already carries, so downstream EV
-- (maker-spray / m6 / m7 / badatmath-replica) can use LIVE per-market values instead of the hardcoded
-- 0.05 fee / assumed 0.25 rebate. The Gamma market exposes: feeSchedule {rate, takerOnly, rebateRate},
-- feeType ('weather_fees'), holdingRewardsEnabled, rewardsMaxSpread, rewardsMinSize (fixture-verified
-- research/gamma-event-temperature-nyc-jun11.json). The funded reward RATES (rewards.rates) live on the
-- CLOB /sampling-markets endpoint, NOT the Gamma event — that is REC-4's monitor, not this migration.
-- Additive only: new nullable columns + extended upsert_bucket. No backfill (existing rows stay null →
-- downstream readers fall back to the conservative hardcoded defaults; a discover re-run populates them).

alter table public.market_buckets
  add column if not exists fee_taker_only         boolean,          -- feeSchedule.takerOnly (makers pay no fee)
  add column if not exists fee_rebate_rate        numeric(6,4),     -- feeSchedule.rebateRate (maker rebate share, e.g. 0.25)
  add column if not exists fee_type               text,            -- feeType (e.g. 'weather_fees')
  add column if not exists reward_max_spread      numeric(8,4),     -- rewardsMaxSpread (liquidity-reward scaffolding)
  add column if not exists reward_min_size        numeric(10,2),    -- rewardsMinSize
  add column if not exists holding_rewards_enabled boolean;          -- holdingRewardsEnabled

comment on column public.market_buckets.fee_rebate_rate is
  'feeSchedule.rebateRate — maker rebate as a share of the taker fee (weather_fees: 0.25). REC-3.';

-- Extend upsert_bucket with the new fields. The previous 12-arg overload must be DROPPED first: adding
-- params with defaults via `create or replace` would leave TWO overloads, and a 12-arg call would match
-- both ("function is not unique"). Dropping the old signature leaves a single 18-param function (6
-- defaulted) that resolves both legacy 12-arg positional calls and the new 18-named calls unambiguously.
drop function if exists public.upsert_bucket(
  uuid, smallint, text, smallint, smallint, text, text, text, text, numeric, numeric, numeric
);

create or replace function public.upsert_bucket(
  p_event_id uuid, p_bucket_idx smallint, p_label text,
  p_low smallint, p_high smallint, p_poly_market_id text, p_condition_id text,
  p_token_yes text, p_token_no text, p_tick numeric, p_min_order numeric, p_fee_rate numeric,
  p_fee_taker_only boolean default null, p_fee_rebate_rate numeric default null,
  p_fee_type text default null, p_reward_max_spread numeric default null,
  p_reward_min_size numeric default null, p_holding_rewards_enabled boolean default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, poly_market_id,
                              condition_id, token_yes, token_no, tick_size, min_order_size, fee_rate,
                              fee_taker_only, fee_rebate_rate, fee_type, reward_max_spread,
                              reward_min_size, holding_rewards_enabled)
  values (p_event_id, p_bucket_idx, p_label, p_low, p_high, p_poly_market_id,
          p_condition_id, p_token_yes, p_token_no, p_tick, p_min_order, p_fee_rate,
          p_fee_taker_only, p_fee_rebate_rate, p_fee_type, p_reward_max_spread,
          p_reward_min_size, p_holding_rewards_enabled)
  on conflict (event_id, bucket_idx) do update
    set label = excluded.label, low_native = excluded.low_native, high_native = excluded.high_native,
        poly_market_id = excluded.poly_market_id, condition_id = excluded.condition_id,
        token_yes = excluded.token_yes, token_no = excluded.token_no,
        tick_size = excluded.tick_size, min_order_size = excluded.min_order_size,
        fee_rate = excluded.fee_rate,
        fee_taker_only = excluded.fee_taker_only, fee_rebate_rate = excluded.fee_rebate_rate,
        fee_type = excluded.fee_type, reward_max_spread = excluded.reward_max_spread,
        reward_min_size = excluded.reward_min_size, holding_rewards_enabled = excluded.holding_rewards_enabled
  returning market_buckets.id into v_id;
  return v_id;
end;
$$;
