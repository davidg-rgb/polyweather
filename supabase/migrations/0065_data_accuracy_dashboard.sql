-- 0065_data_accuracy_dashboard.sql — read-only RPC for the /data forecast-accuracy page.
--
-- One operator-gated, security-definer read that answers the operator's question: across all ~46 stations,
-- how accurate is our forecast — at day-of (lead 0), day-before (lead 1) and two-days-out (lead 2) — and which
-- MARKETS (stations) do we forecast best and worst? Plus the forecast-vs-market Brier gap over time.
--
-- "Accuracy" = the champion (house_gaussian) POINT prediction = its most-likely whole-°C bucket (argmax of the
-- probability vector) vs the resolved winning bucket. Two intuitive lenses, both unit-agnostic (1 bucket = 1°
-- in the market's native unit): EXACT (argmax == winner) and WITHIN-1 (|argmax − winner| ≤ 1). The market's
-- own argmax (market_consensus, latest snapshot at that lead) is scored on the SAME matched events so the
-- head-to-head is honest — this is the analytics product the 2026-06-15 pivot named (the trading rail is
-- DORMANT; nothing here trades).
--
-- Payload (one jsonb OBJECT — never a top-level array, the 0044 trap):
--   • meta        — champion, the per-station lead, the bucket-distribution window, station count.
--   • byLead      — the headline: our model vs the market at leads 0/1/2 (exact / within-1 / mean-miss).
--   • byStation   — per-station at the day-before lead (1): n, exact%, within-1%, mean-miss, + the market's
--                   within-1%/mean-miss on the same events. Ranked best→worst by mean-miss (the stable ranker).
--   • brierSeries — DAILY pooled multi-category Brier (house vs market) at the day-before lead, keyed on the
--                   ADR-16 scored_for_leads array (like the rest of the calibration surface — 0017/0045), NOT
--                   the snapshot's own lead_days. Over the house-era window (since house bucket-distributions
--                   began scoring, ~2026-06-14) — the "is our deficit widening or closing" trace. Days with
--                   fewer than 5 scored house events are omitted.
--
-- argmax is computed in SQL via `unnest(probs) with ordinality` (i-1 = 0-based bucket index, matching
-- winning_bucket_idx); ties resolve to the lower index. The market_consensus dedup keeps the LATEST snapshot
-- per (event, lead) — the freshest market view at that horizon. 60s statement_timeout (0027/0045 twin) gives the
-- dedup-over-~150k-market-rows headroom on a cold edge connection. No table, no cron — cron count stays 21.

create or replace function public.dash_data(p_lead smallint default 1)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
declare
  v jsonb;
  v_lead smallint := coalesce(p_lead, 1);
begin
  perform public.operator_guard();

  with hg as (
    -- our champion's freshest distribution per (event, lead): argmax bucket + the resolved winner.
    select distinct on (bp.event_id, bp.lead_days)
      bp.event_id, bp.lead_days, me.city_id, me.winning_bucket_idx as win,
      (select i - 1 from unnest(bp.probs) with ordinality t(p, i) order by p desc, i limit 1) as am
    from public.bucket_probabilities bp
    join public.market_events me on me.id = bp.event_id
    where bp.source = 'house_gaussian' and bp.nowcast = false
      and me.winning_bucket_idx is not null and bp.lead_days between 0 and 2
    order by bp.event_id, bp.lead_days, bp.made_at desc
  ),
  mc as (
    -- the market's freshest consensus per (event, lead): argmax bucket + the resolved winner.
    select distinct on (bp.event_id, bp.lead_days)
      bp.event_id, bp.lead_days, me.winning_bucket_idx as win,
      (select i - 1 from unnest(bp.probs) with ordinality t(p, i) order by p desc, i limit 1) as am
    from public.bucket_probabilities bp
    join public.market_events me on me.id = bp.event_id
    where bp.source = 'market_consensus' and bp.nowcast = false
      and me.winning_bucket_idx is not null and bp.lead_days between 0 and 2
    order by bp.event_id, bp.lead_days, bp.made_at desc
  ),
  matched as (
    -- only events where BOTH our model and the market have a call at that lead → a fair head-to-head.
    select hg.lead_days as lead, hg.city_id,
      (hg.am = hg.win)::int as h_exact, (abs(hg.am - hg.win) <= 1)::int as h_w1, abs(hg.am - hg.win) as h_miss,
      (mc.am = mc.win)::int as m_exact, (abs(mc.am - mc.win) <= 1)::int as m_w1, abs(mc.am - mc.win) as m_miss
    from hg join mc on mc.event_id = hg.event_id and mc.lead_days = hg.lead_days
  ),
  by_lead as (
    select lead, count(*) n, count(distinct city_id) stations,
      avg(h_exact::numeric) he, avg(h_w1::numeric) hw, avg(h_miss::numeric) hm,
      avg(m_exact::numeric) me_, avg(m_w1::numeric) mw, avg(m_miss::numeric) mm
    from matched group by lead
  ),
  by_station as (
    select c.slug city, c.region, count(*) n,
      avg(m.h_exact::numeric) exact, avg(m.h_w1::numeric) w1, avg(m.h_miss::numeric) miss,
      avg(m.m_w1::numeric) mkt_w1, avg(m.m_miss::numeric) mkt_miss
    from matched m join public.cities c on c.id = m.city_id
    where m.lead = v_lead
    group by c.slug, c.region
    having count(*) >= 5
  ),
  brier_day as (
    -- daily pooled multi-category Brier at lead 1, house + market, over scored events; the chart filters to
    -- days the house line exists (nHouse > 0) so the gap is apples-to-apples.
    select me.target_date::text d,
      count(*) filter (where bp.source = 'house_gaussian')    nh,
      avg(bp.brier) filter (where bp.source = 'house_gaussian') bh,
      count(*) filter (where bp.source = 'market_consensus')   nm,
      avg(bp.brier) filter (where bp.source = 'market_consensus') bm
    from public.bucket_probabilities bp
    join public.market_events me on me.id = bp.event_id
    -- ADR-16: brier is set on the single freshest cutoff row per (event, source, lead) regardless of that row's
    -- own lead_days, so the day-before series keys on the scored_for_leads array (the convention everywhere
    -- else: calib_scored_rows 0017, the 0045 partial index), not bp.lead_days.
    cross join lateral unnest(bp.scored_for_leads) as l(ld)
    where bp.brier is not null and bp.nowcast = false and l.ld = 1
      and bp.scored_for_leads <> '{}'::smallint[]   -- lets the 0045 partial index drive the scan
      and bp.source in ('house_gaussian', 'market_consensus')
      and me.winning_bucket_idx is not null
    group by me.target_date
    -- ≥5 house events/day so no thin endpoint (e.g. today, mid-resolution at n=1) spikes the gap line.
    having count(*) filter (where bp.source = 'house_gaussian') >= 5
  ),
  win as (
    select min(me.target_date) first_day, max(me.target_date) last_day, count(distinct me.city_id) n_stations
    from public.bucket_probabilities bp
    join public.market_events me on me.id = bp.event_id
    where bp.source = 'house_gaussian' and bp.nowcast = false and me.winning_bucket_idx is not null
  )
  select jsonb_build_object(
    'meta', jsonb_build_object(
      'champion',    'house_gaussian',
      'leadStation', v_lead,
      'generatedAt', now(),
      'firstDay',    (select first_day from win),
      'lastDay',     (select last_day from win),
      'nStations',   (select n_stations from win)
    ),
    'byLead', coalesce((
      select jsonb_agg(jsonb_build_object(
        'lead', lead, 'n', n, 'stations', stations,
        'houseExact', he, 'houseWithin1', hw, 'houseMiss', hm,
        'marketExact', me_, 'marketWithin1', mw, 'marketMiss', mm
      ) order by lead) from by_lead
    ), '[]'::jsonb),
    'byStation', coalesce((
      select jsonb_agg(jsonb_build_object(
        'city', city, 'region', region, 'n', n,
        'exactPct', exact, 'within1Pct', w1, 'meanMiss', miss,
        'marketWithin1Pct', mkt_w1, 'marketMeanMiss', mkt_miss
      ) order by miss asc) from by_station
    ), '[]'::jsonb),
    'brierSeries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', d, 'nHouse', nh, 'brierHouse', bh, 'nMarket', nm, 'brierMarket', bm
      ) order by d) from brier_day
    ), '[]'::jsonb)
  ) into v;

  return v;
end;
$$;

-- grants (post-0034 contract: operator-readable dashboard surface; the operator's logged-in session passes
-- operator_guard, serverDb calls it as authenticated).
revoke all on function public.dash_data(smallint) from public, anon, authenticated;
grant  execute on function public.dash_data(smallint) to authenticated, service_role;
