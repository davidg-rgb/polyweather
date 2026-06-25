-- 0063_cross_venue_dash_realdepth.sql — code-review fix (rank 8) for the cross-venue dash (0062).
--
-- dash_cross_venue's gate aggregates (realDepthDays / netPositiveDepthDays / winFrac / meanNetEdge) read
-- `from depth` (has_real_depth rows), but the two HEADLINE maxes — bestEdgeSeen and per-city bestEdge —
-- maxed over ALL latest rows, surfacing a large edge from a thin/illiquid snapshot that contributes
-- NOTHING to the verdict (the same non-executable-phantom class TAIL_SPREAD_F / NEUTRAL_BASIS were built
-- to avoid). Scope both headlines to real-depth rows. Display-only; the verdict is unaffected. CREATE OR
-- REPLACE preserves the 0062 grants. Idempotent.

create or replace function public.dash_cross_venue(p_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_since timestamptz;
begin
  perform public.operator_guard();
  v_since := now() - make_interval(days => greatest(coalesce(p_days, 14), 1));

  with latest as (
    select distinct on (city, target_date) *
    from cross_venue_captures
    where captured_at >= v_since
    order by city, target_date, captured_at desc
  ),
  depth as (select * from latest where has_real_depth)
  select jsonb_build_object(
    'generatedAt',    now(),
    'windowDays',     coalesce(p_days, 14),
    'captures',       (select count(*) from cross_venue_captures where captured_at >= v_since),
    'distinctCities', (select count(distinct city) from latest),
    'matchedDays',    (select count(*) from latest),
    'realDepthDays',  (select count(*) from depth),
    'netPositiveDepthDays', (select count(*) from depth where net_positive),
    'winFrac',        (select case when count(*) > 0 then round((count(*) filter (where net_positive))::numeric / count(*), 4) else null end from depth),
    'meanNetEdge',    (select round(avg(best_net_edge), 5) from depth),
    'bestEdgeSeen',   (select max(best_net_edge) from depth),   -- rank 8: real-depth rows only
    'meanAbsGap',     (select round(avg(max_abs_gap), 4) from latest),
    'meanDiffF',      (select round(avg(mean_diff_f), 3) from latest),
    -- per-city aggregates computed in a subquery THEN jsonb_agg'd (aggregates cannot nest inside
    -- jsonb_agg over a GROUP BY — a latent bug in 0062's perCity that no test exercised; fixed here).
    'perCity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'city',           pc.city,
        'days',           pc.days,
        'realDepthDays',  pc.real_depth_days,
        'netPosDays',     pc.net_pos_days,
        'meanDiffF',      pc.mean_diff,
        'meanAbsGap',     pc.mean_gap,
        'bestEdge',       pc.best_edge  -- rank 8: real-depth rows only
      ) order by pc.city)
      from (
        select city,
               count(*)                                                    as days,
               count(*) filter (where has_real_depth)                      as real_depth_days,
               count(*) filter (where has_real_depth and net_positive)     as net_pos_days,
               round(avg(mean_diff_f), 3)                                  as mean_diff,
               round(avg(max_abs_gap), 4)                                  as mean_gap,
               max(best_net_edge) filter (where has_real_depth)            as best_edge
        from latest group by city
      ) pc
    ), '[]'::jsonb),
    'recentCaptures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',  captured_at,
        'city',        city,
        'targetDate',  target_date,
        'meanDiffF',   mean_diff_f,
        'maxAbsGap',   max_abs_gap,
        'bestNetEdge', best_net_edge,
        'edgeAtF',     edge_at_f,
        'direction',   direction,
        'limitDepth',  limit_depth,
        'hasRealDepth',has_real_depth,
        'netPositive', net_positive
      ) order by captured_at desc)
      from (select * from cross_venue_captures where captured_at >= v_since order by captured_at desc limit 60) q
    ), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
