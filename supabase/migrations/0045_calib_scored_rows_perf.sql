-- 0045_calib_scored_rows_perf.sql — calib_scored_rows access-path fix
-- (ARCHITECTURE.md §6.18 step 3).
--
-- Found live (2026-06-21): run-calibration's daily cron FAILED at step (3)
-- SCORES with `rpc calib_scored_rows failed: canceling statement due to
-- statement timeout`, freezing calibration_scores at 2026-06-19 while the
-- residual cursor (steps 1–2) kept advancing to today — so each run folded
-- residuals, advanced calibCursor, then died on the scores RPC. Clean/partial:
-- nothing was corrupted, scores simply stopped refreshing.
--
-- Root cause (EXPLAIN ANALYZE on hosted, 120,960-row bucket_probabilities):
-- the query joins market_events (682 resolved in the 90d window) to
-- bucket_probabilities on event_id and pulls EVERY non-nowcast row per event
-- (~134/event) → a 91,249-row inner result, dragging each row's probs
-- numeric[] array along, THEN `unnest(scored_for_leads)` discards 98% of them,
-- leaving ~1,914. The genuinely selective predicate is `scored_for_leads <>
-- '{}'` (1,914 of 120,960 = 1.6%) — but no index carried it, and `nowcast =
-- false` removes only ~5k, so the planner had no cheap path. 3.7s warm in the
-- admin role; over the PostgREST RPC role's default ~8s statement_timeout on a
-- colder edge connection it tips over. (0027 added 60s headroom to
-- calib_new_pairs/calib_window_errors but NOT this third aggregation.)
--
-- Fix (two parts):
--   (1) Partial index keyed on event_id over ONLY the scored, non-nowcast
--       rows. The nested-loop now probes ~3 rows/event instead of ~134 and
--       fetches the probs arrays for ~1,914 rows instead of 91,249. The job
--       scales with the number of SCORED rows (~3/event/day), not with the
--       ever-growing bucket_probabilities table. The partial predicate covers
--       <2% of the table, so the build is sub-second (a brief write lock on a
--       table written only at snapshot times — acceptable, and CONCURRENTLY is
--       neither transaction- nor PGlite-test-safe).
--   (2) calib_scored_rows: add the explicit `scored_for_leads <> '{}'` WHERE
--       predicate so the planner is allowed to use the partial index — a
--       SEMANTIC no-op, because the inner `cross join lateral unnest` already
--       drops empty-array rows to zero output. Plus `set statement_timeout =
--       '60s'` defensive headroom, mirroring 0027's pattern for the two sibling
--       aggregations. The body is otherwise VERBATIM from 0017.

create index if not exists bucket_probabilities_scored_idx
  on public.bucket_probabilities (event_id)
  where scored_for_leads <> '{}'::smallint[] and nowcast = false;

create or replace function public.calib_scored_rows(p_days int, p_today date)
returns table (city_id uuid, city_slug text, scored jsonb)
language sql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with sr as (
    select me.city_id as cid, c.slug, me.id as event_id, me.target_date, bp.source, l.ld,
           bp.probs, bp.brier, me.winning_bucket_idx
    from bucket_probabilities bp
    join market_events me on me.id = bp.event_id
    join cities c on c.id = me.city_id
    cross join lateral unnest(bp.scored_for_leads) as l(ld)
    where me.winning_bucket_idx is not null
      and bp.nowcast = false
      and bp.scored_for_leads <> '{}'::smallint[]
      and me.target_date > p_today - p_days and me.target_date <= p_today
  )
  select sr.cid, sr.slug::text,
         jsonb_agg(jsonb_build_object('event', sr.event_id, 'date', sr.target_date,
                                      'source', sr.source, 'lead', sr.ld, 'probs', sr.probs,
                                      'brier', sr.brier, 'winner', sr.winning_bucket_idx))
  from sr
  group by sr.cid, sr.slug;
$$;
