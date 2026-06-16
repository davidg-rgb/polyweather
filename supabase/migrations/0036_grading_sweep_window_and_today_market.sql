-- 0036_grading_sweep_window_and_today_market.sql
--
-- TWO grading/dashboard correctness fixes surfaced from /city/istanbul.
--
-- FIX 1 — bound the grade-bets safety sweep to a recency window.
--   sweep_grading_targets returned EVERY ungraded past event (winning_bucket_idx is null,
--   target_date <= today) with NO lower bound. After the §6.22 actuals backfill finalized
--   observations for ~2 years of history, hundreds of long-closed historical events suddenly
--   satisfied the sweep's hasTruth test, so grade-bets tried to gradeEvent ~721 events in one
--   run (each = several RPCs + Slack notifies) and blew the Edge wall limit every day since
--   ~2026-06-14 → reaped by health-monitor (ADR-12). The sweep is a safety net for RECENTLY
--   missed inline grading (fetch-actuals grades on finalization, truth lands within ~2 days),
--   NOT a backfill-grader: force-grading months-old closed events (no bets, distributions long
--   gone) is pointless and the perf killer. Add an optional p_since lower bound; grade-bets
--   passes now − 4 days. Param (not a hardcoded now()-interval) so the PGlite suite — which
--   fixtures events at fixed dates and drives the handler with a mocked `now` — stays
--   time-invariant. p_since null preserves the old unbounded behaviour.
--
-- FIX 2 — "Today's market" picks today/nearest, not the oldest unclosed event.
--   dash_city_detail.openEventToday did `order by target_date limit 1` (the EARLIEST unclosed
--   event). When grading lags and past events stay open (exactly the FIX-1 failure), it surfaced
--   a stale 2-day-old market under "Today's market". Reorder to prefer today-or-future, then
--   nearest to today — robust to grading lag, and a single-event city still resolves to that
--   event (keeps the ui-data fixture green).
--
-- 0034 invariant: sweep_grading_targets is service-role-internal (Edge Functions only), so the
-- recreated signature re-ships the post-0034 revoke/grant. dash_city_detail is CREATE OR REPLACE
-- (ACL preserved — it keeps its existing authenticated grant).

-- ── FIX 1 ────────────────────────────────────────────────────────────────────────────────────
-- Signature change (() → (date)) ⇒ drop then recreate; re-apply the lockdown grant.
drop function if exists public.sweep_grading_targets();

create or replace function public.sweep_grading_targets(p_since date default null)
returns table (event_id uuid, ctx jsonb)
language sql
security definer
set search_path = public
as $$
  select me.id, jsonb_build_object(
    'slug', me.slug, 'targetDate', me.target_date, 'tz', c.tz,
    'hasTruth', exists (
      select 1 from observations o
      where o.icao = coalesce(cs.icao, me.icao_at_creation)
        and o.date_local = me.target_date
        and o.tmax_wu_native is not null
        and o.finalized_at is not null
    ),
    'marketResolved', me.poly_resolved_winner_idx is not null
      or exists (select 1 from market_buckets b
                 where b.event_id = me.id and b.resolved_outcome = 'win')
  )
  from market_events me
  join cities c on c.id = me.city_id
  left join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where me.winning_bucket_idx is null
    and me.target_date <= (now() at time zone 'utc')::date
    and (p_since is null or me.target_date >= p_since);
$$;

revoke all on function public.sweep_grading_targets(date) from public, anon, authenticated;
grant execute on function public.sweep_grading_targets(date) to service_role;

-- ── FIX 2 ────────────────────────────────────────────────────────────────────────────────────
create or replace function public.dash_city_detail(p_slug text, p_champion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'city', jsonb_build_object('slug', c.slug, 'name', c.display_name, 'unit', c.unit,
                               'tz', c.tz, 'region', c.region, 'bettingEnabled', c.betting_enabled),
    'openEventToday', (
      select jsonb_build_object('slug', me.slug, 'targetDate', me.target_date)
      from market_events me
      where me.city_id = c.id and not me.closed
      -- today-or-future first, then nearest to today (robust to grading lag — a stale
      -- past event no longer sorts ahead of today's market); deterministic tiebreak.
      order by (me.target_date >= current_date) desc, abs(me.target_date - current_date) asc, me.target_date desc
      limit 1
    ),
    'stationHistory', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', cs.id, 'icao', cs.icao, 'verified', cs.verified,
        'validFrom', cs.valid_from, 'validTo', cs.valid_to) order by cs.valid_from desc), '[]'::jsonb)
      from city_stations cs where cs.city_id = c.id
    ),
    'calibrationHeatmap', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'model', s.model, 'lead', s.lead_days, 'slot', s.snapshot_slot,
        'bias', s.bias_c, 'sigma', s.residual_sigma_c, 'n', s.n_residuals, 'weight', s.weight)), '[]'::jsonb)
      from model_stats s
      join city_stations cs on cs.city_id = c.id and cs.valid_to is null
      where s.icao = cs.icao
    ),
    'brierTrend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'source', cs2.source, 'lead', cs2.lead_days, 'window', cs2.window_tag,
        'brier', cs2.brier, 'brierMarket', cs2.brier_market, 'ece', cs2.ece,
        'sharpness', cs2.sharpness, 'n', cs2.n_events)), '[]'::jsonb)
      from calibration_scores cs2 where cs2.city_id = c.id
    ),
    'betHistory', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'betId', bt.id, 'eventSlug', me.slug, 'label', b.label, 'status', bt.status,
        'stake', bt.rec_stake_usd, 'pnl', bt.pnl_usd, 'recommendedAt', bt.recommended_at
      ) order by bt.recommended_at desc), '[]'::jsonb)
      from bets bt
      join market_events me on me.id = bt.event_id and me.city_id = c.id
      join market_buckets b on b.id = bt.bucket_id
    ),
    'divergenceLog', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', o.date_local, 'flags', o.divergence_flags,
        'wu', o.tmax_wu_native, 'metar', o.tmax_metar_native, 'iemF', o.tmax_iem_f
      ) order by o.date_local desc), '[]'::jsonb)
      from (select * from observations ob
            join city_stations cs3 on cs3.city_id = c.id and cs3.valid_to is null and ob.icao = cs3.icao
            where ob.divergence_flags is not null and array_length(ob.divergence_flags, 1) > 0
            order by ob.date_local desc limit 30) o
    )
  ) into v
  from cities c where c.slug = p_slug;
  return v;
end;
$$;
