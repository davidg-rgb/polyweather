-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0093 · trade_config_set — city_allowlist VALIDATION + NORMALIZATION (operator-requested 2026-07-11)
--
-- WHY: the /trading console's allowlist was a free-text comma list; a typo'd or wrong-case slug is stored
-- verbatim and then silently matches NO city — the allowlist looks set but does not restrict (or restricts
-- everything out). The value constraint belongs in the DB (the 0082 §6 idiom: routes TYPE-validate, VALUE
-- constraints RAISE here and surface verbatim in the UI).
--
-- WHAT (function body otherwise byte-identical to 0082 §6):
--   1. p_city_allowlist is NORMALIZED: lower(trim(s)), empties dropped, de-duplicated (sorted for stability).
--   2. Every normalized slug must exist in public.cities.slug — unknown slugs RAISE, listing the offenders.
--   3. An allowlist that normalizes to EMPTY raises — '{}' would silently allow NOTHING; "all cities" is
--      expressed via p_clear_city_allowlist (the route's clearCityAllowlist flag), never an empty array.
-- Grants/ACLs are preserved by create-or-replace (same signature); re-stated below for explicitness.
--
-- Rollback: re-run the 0082 §6 definition (supabase/migrations/0082_trading_activation.sql lines 405–457).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.trade_config_set(
  p_mode                     text    default null,
  p_stake_per_buy_usd        numeric default null,
  p_per_position_cap_usd     numeric default null,
  p_per_market_cap_usd       numeric default null,
  p_total_concurrent_cap_usd numeric default null,
  p_daily_loss_kill_usd      numeric default null,
  p_daily_loss_kill_frac     numeric default null,
  p_city_allowlist           text[]  default null,
  p_active_until             date    default null,
  p_clear_city_allowlist     boolean default false,
  p_clear_active_until       boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_allowlist text[];
  v_unknown   text[];
begin
  perform public.operator_guard();

  -- F5: reject a run window more than 60 days out.
  if p_active_until is not null and p_active_until > current_date + 60 then
    raise exception 'trade_config_set: active_until % is more than 60 days out (max %)',
      p_active_until, current_date + 60;
  end if;

  -- 0093: normalize + validate the allowlist BEFORE it can be stored.
  if p_city_allowlist is not null then
    select array_agg(distinct s order by s) into v_allowlist
    from (select lower(trim(x)) as s from unnest(p_city_allowlist) x) t
    where s <> '';

    if v_allowlist is null then
      raise exception 'trade_config_set: city_allowlist normalized to empty — an empty allowlist would allow NO city; use p_clear_city_allowlist (all cities) instead';
    end if;

    select array_agg(s order by s) into v_unknown
    from unnest(v_allowlist) s
    where not exists (select 1 from public.cities c where c.slug = s);

    if v_unknown is not null then
      raise exception 'trade_config_set: unknown city slug(s): % — allowlist entries must match cities.slug exactly', array_to_string(v_unknown, ', ');
    end if;
  end if;

  update public.trade_config set
    mode                     = coalesce(p_mode, mode),
    stake_per_buy_usd        = coalesce(p_stake_per_buy_usd, stake_per_buy_usd),
    per_position_cap_usd     = coalesce(p_per_position_cap_usd, per_position_cap_usd),
    per_market_cap_usd       = coalesce(p_per_market_cap_usd, per_market_cap_usd),
    total_concurrent_cap_usd = coalesce(p_total_concurrent_cap_usd, total_concurrent_cap_usd),
    daily_loss_kill_usd      = coalesce(p_daily_loss_kill_usd, daily_loss_kill_usd),
    daily_loss_kill_frac     = coalesce(p_daily_loss_kill_frac, daily_loss_kill_frac),
    city_allowlist           = case when p_clear_city_allowlist then null
                                    else coalesce(v_allowlist, city_allowlist) end,
    active_until             = case when p_clear_active_until then null
                                    else coalesce(p_active_until, active_until) end
  where id = 1;

  select jsonb_build_object('config', to_jsonb(t)) into v from public.trade_config t where t.id = 1;
  return v;
end;
$$;

revoke all on function public.trade_config_set(
  text, numeric, numeric, numeric, numeric, numeric, numeric, text[], date, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.trade_config_set(
  text, numeric, numeric, numeric, numeric, numeric, numeric, text[], date, boolean, boolean
) to service_role, authenticated;
