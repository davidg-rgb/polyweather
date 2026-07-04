-- 0079_maker_exit_assumptions_history.sql — the /maker-exit "assumptions over time" read (gate-day instrumentation).
--
-- WHY. dash_maker_exit() (0073 §5) returns only the LATEST maker_exit_panel snapshot — a single point-in-time read
-- of the three measured assumptions (makerFillRate #1 / realizedRebateUsd #2 / days #3) + the v2 "WHY zero" pool-
-- context fields. The gate-day question the operator actually asks is a TREND one: is the realized maker-fill rate
-- (#1, the §12 adverse-selection read) drifting toward the 0.30 warning where the edge inverts, or holding near the
-- 0.49 backtest reference as forward days accrue (MAKER-EXIT-SIM.md §"hyper-sensitive to the realized maker-fill
-- rate")? The data already exists — record_maker_exit_panel (0073 §2) retains the latest 200 snapshots (~2 days at
-- the */15 cadence), each carrying `view->'assumptions'` — but there is no read path that returns MORE than the
-- newest one. This migration adds exactly that read, and nothing else.
--
-- WHAT. A single SECURITY DEFINER + operator_guard read `dash_maker_exit_history(p_limit)` that returns the last
-- p_limit snapshots' assumption scalars as an ASCENDING (oldest→newest) time series, so the /maker-exit page can
-- draw small-multiple sparklines above tile #4 (the fill-rate line annotated with the 0.30 warning + 0.49 backtest
-- reference lines). Read-only, additive, analytics-only — NO new table, NO cron, NO write path, NO change to
-- dash_maker_exit or the §9R-E gate math; the bot rail stays paper/DORMANT (FINDINGS.md, the 12th signal). Mirrors
-- the 0073 dash_maker_exit idiom (operator_guard → jsonb object → grant to authenticated + service_role).
--
-- HONEST NULLS (load-bearing). The assumption scalars are computed in core/sim/opening-maker-exit-view and stored
-- through db.rpc's JSON serialization, so a value that is NaN in the view (makerFillRate / qualifyingTickFrac /
-- the WHY fractions with a zero denominator — REWARD-INSTR-ROLLOUT.md's "NaN when the denominator is 0") lands in
-- `view->'assumptions'` as JSON null. This RPC extracts every scalar as a RAW jsonb value (`a->'makerFillRate'`,
-- NOT `a->>'...'::numeric`) so a null snapshot round-trips as a null point — the page's sparkline breaks the line
-- there and never fabricates a zero. Do NOT coerce these through ::numeric; that would turn an honest gap into 0.

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- dash_maker_exit_history — the last p_limit snapshots' assumption scalars, oldest→newest (operator-guarded).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_maker_exit_history(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v       jsonb;
  -- clamp: at least 1, at most the record_maker_exit_panel retention ceiling (200 rows ≈ 2 days @ */15). A caller
  -- asking for more than exists simply gets everything retained; 500 is a defensive hard cap on the scan.
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  perform public.operator_guard();
  with recent as (
    -- newest v_limit rows first (index-friendly: maker_exit_panel_captured_idx is captured_at desc) …
    select mep.captured_at, mep.view->'assumptions' as a
    from public.maker_exit_panel mep
    order by mep.captured_at desc
    limit v_limit
  ),
  ordered as (
    -- … then re-order ascending so the emitted series reads left→right on the sparkline.
    select captured_at, a from recent order by captured_at asc
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'n',           (select count(*) from ordered),
    'points', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',                o.captured_at,
        -- #1 maker-fill rate (§12 adverse selection) + its fill latency
        'makerFillRate',             o.a->'makerFillRate',
        'meanMakerFillLatencyTicks', o.a->'meanMakerFillLatencyTicks',
        -- #2 realized rebate ($) + the tier applied
        'realizedRebateUsd',         o.a->'realizedRebateUsd',
        'rebateRateUsed',            o.a->'rebateRateUsed',
        -- observed round-trip cost the maker exit recovers (context for the rebate line)
        'meanObservedEntrySpread',   o.a->'meanObservedEntrySpread',
        'meanObservedExitSpread',    o.a->'meanObservedExitSpread',
        -- #4 reward-qualifying tick frac + its raw numerator/denominator (sample size)
        'qualifyingTickFrac',        o.a->'qualifyingTickFrac',
        'nQualifyingRestingTicks',   o.a->'nQualifyingRestingTicks',
        'nRestingTicks',             o.a->'nRestingTicks',
        -- #4b v2 "WHY zero" pool-context extension
        'meanDistFromMidPp',         o.a->'meanDistFromMidPp',
        'fracWithinAdvertisedBand',  o.a->'fracWithinAdvertisedBand',
        'fracFailsMinSize',          o.a->'fracFailsMinSize',
        'dominantDisqualifier',      o.a->'dominantDisqualifier',
        -- #3 temporal extent (the CI narrows as these grow)
        'nMarkets',                  o.a->'nMarkets',
        'nCities',                   o.a->'nCities',
        'nDistinctDays',             o.a->'nDistinctDays'
      ) order by o.captured_at asc)
      from ordered o
    ), '[]'::jsonb)
  ) into v;
  return coalesce(v, jsonb_build_object('generatedAt', now(), 'n', 0, 'points', '[]'::jsonb));
end;
$$;

revoke all on function public.dash_maker_exit_history(int) from public, anon, authenticated;
grant  execute on function public.dash_maker_exit_history(int) to authenticated, service_role;
