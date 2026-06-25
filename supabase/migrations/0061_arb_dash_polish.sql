-- 0061_arb_dash_polish.sql — code-review polish for the 0060 arb depth-capture surface (NITs).
--
--   #7: drop the dead `grant select ... to authenticated` on complete_set_depth_captures. The table is
--       RLS-on with NO read policy, so the grant returns zero rows regardless — a no-op that deviates
--       from the 0057/0059 RLS-only-via-RPC pattern. Reads stay via the security-definer RPC.
--   #8: clamp dash_complete_set_depth's p_days to [1,60] (the header advertised a 60-day max the body
--       never enforced) and report the CLAMPED windowDays. Operator-only RPC; same signature (no 0054
--       overload). Mirrors 0058's dash_market_rewards clamp idiom.

-- #7 — remove the dead table grant (RLS already blocks reads; revoke is the safe, exact inverse).
revoke select on public.complete_set_depth_captures from authenticated;

-- #8 — re-create with a single clamped window used for BOTH the filter and the reported windowDays.
create or replace function public.dash_complete_set_depth(p_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_days  int         := least(greatest(coalesce(p_days, 14), 1), 60);
  v_since timestamptz := now() - make_interval(days => v_days);
begin
  perform public.operator_guard();

  select jsonb_build_object(
    'generatedAt',   now(),
    'windowDays',    v_days,
    'captures',      (select count(*) from complete_set_depth_captures where captured_at >= v_since),
    'distinctEvents',(select count(distinct event_slug) from complete_set_depth_captures where captured_at >= v_since),
    'rawUndround',   (select count(*) from complete_set_depth_captures where captured_at >= v_since and raw_underround),
    'feeCleared',    (select count(*) from complete_set_depth_captures where captured_at >= v_since and fee_cleared),
    'anyExecSets',   (select count(*) from complete_set_depth_captures where captured_at >= v_since and exec_sets > 0),
    'bestExecProfit',(select max(exec_profit_usd) from complete_set_depth_captures where captured_at >= v_since and exec_sets > 0),
    'feeClearedEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug',          event_slug,
        'captures',      count(*),
        'feeCleared',    sum(case when fee_cleared then 1 else 0 end),
        'maxExecSets',   max(exec_sets),
        'maxExecProfit', max(exec_profit_usd),
        'firstSeen',     min(captured_at),
        'lastSeen',      max(captured_at)
      ) order by sum(case when fee_cleared then 1 else 0 end) desc)
      from complete_set_depth_captures
      where captured_at >= v_since
      group by event_slug
      having sum(case when fee_cleared then 1 else 0 end) > 0
    ), '[]'::jsonb),
    'recentCaptures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',   captured_at,
        'slug',         event_slug,
        'leadDays',     lead_days,
        'ageHours',     age_hours,
        'sumBestAsk',   sum_best_ask,
        'underNet',     under_net,
        'execSets',     exec_sets,
        'execProfit',   exec_profit_usd,
        'feeCleared',   fee_cleared
      ) order by captured_at desc)
      from (
        select * from complete_set_depth_captures
        where captured_at >= v_since
        order by captured_at desc limit 100
      ) q
    ), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

-- grants unchanged (post-0034 contract): operator-readable via the RPC only.
revoke all on function public.dash_complete_set_depth(int) from public, anon, authenticated;
grant  execute on function public.dash_complete_set_depth(int) to authenticated, service_role;
