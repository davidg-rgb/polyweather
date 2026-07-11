-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 0094 · dash_city_live() — ALL-CITIES allowlist options (operator-reported 2026-07-11)
--
-- WHY: 0093 replaced the /trading free-text allowlist with a checkbox picker, but the picker's options came
-- from dash_city_live().arms — the ENROLLED paper-race cities only (4 rows) — while trade_config_set validates
-- against the FULL public.cities.slug domain (45 rows). The UI was strictly narrower than the DB: the operator
-- could no longer add any non-enrolled city to the buying allowlist at all.
--
-- WHAT (function body otherwise byte-identical to 0085 §12): dash_city_live() gains one key,
--   'allCities' — every public.cities row as { slug, displayName, enrolled } (enrolled = has a city_live_arms
--   row), ordered by slug. This IS the valid domain of trade_config_set's p_city_allowlist, so the picker and
--   the DB validation can never disagree again. Grants/ACLs preserved by create-or-replace (same signature);
--   re-stated below for explicitness.
--
-- Rollback: re-run the 0085 §12 definition (supabase/migrations/0085_city_live.sql lines 594–662).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════

create or replace function public.dash_city_live()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  select jsonb_build_object(
    'generatedAt', now(),
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'cityId',            a.city_id,
        'slug',              c.slug,
        'displayName',       c.display_name,
        'icao',              cfg.icao,
        'unit',              c.unit,
        'enabled',           a.enabled,
        'stakeUsd',          a.stake_usd,
        'entryHourOverride', a.entry_hour_override,
        'promotedStatus',    a.promoted_status,
        'enabledAt',         a.enabled_at,
        'updatedAt',         a.updated_at
      ) order by c.slug), '[]'::jsonb)
      from public.city_live_arms a
      join public.cities c on c.id = a.city_id
      left join public.city_sim_config cfg on cfg.city_id = a.city_id
    ),
    'allCities', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'slug',        c.slug,
        'displayName', c.display_name,
        'enrolled',    exists (select 1 from public.city_live_arms a where a.city_id = c.id)
      ) order by c.slug), '[]'::jsonb)
      from public.cities c
    ),
    'board', (
      select view from public.city_promotion_board order by captured_at desc, id desc limit 1
    ),
    'twin', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'cityId',         t.city_id,
        'slug',           c.slug,
        'displayName',    c.display_name,
        'nPlacements',    t.n_placements,
        'twinFilledFrac', case when t.n_placements > 0 then round(t.n_filled::numeric / t.n_placements, 4) end,
        'takerPnlUsd',    coalesce(t.taker_pnl, 0),
        'makerTwinPnlUsd', coalesce(t.maker_pnl, 0)
      ) order by c.slug), '[]'::jsonb)
      from (
        -- ONE population: taker P&L is summed over exactly the placements that HAVE a twin
        -- (join on the twin keys), so the taker-vs-maker differential is apples-to-apples.
        -- An 'unfilled' twin contributes maker 0 while its taker leg counts — that IS the
        -- fill-rate cost the comparison exists to measure. (Review MEDIUM, 2026-07-06.)
        select mt.city_id,
               count(*)                                          as n_placements,
               count(*) filter (where mt.filled)                 as n_filled,
               coalesce(sum(mt.pnl_usd) filter (where mt.status in ('won', 'lost')), 0)   as maker_pnl,
               coalesce(sum(b.pnl_usd)  filter (where b.status <> 'pending'), 0)          as taker_pnl
        from public.city_maker_twin mt
        join public.city_paper_bets b
          on b.city_id = mt.city_id and b.target_date = mt.target_date and b.arm_hour = mt.arm_hour
        group by mt.city_id
      ) t
      join public.cities c on c.id = t.city_id
    )
  ) into v;

  return v;
end;
$$;

revoke all on function public.dash_city_live() from public, anon, authenticated;
grant  execute on function public.dash_city_live() to service_role, authenticated;
