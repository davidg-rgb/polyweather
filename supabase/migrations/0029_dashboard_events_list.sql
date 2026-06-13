-- 0029_dashboard_events_list.sql — WEB-1 (ADR-21): the /events collection-health
-- landing RPC. One round trip returning every OPEN market_event with
-- collection-health columns so the operator sees at a glance what data has /
-- has not been collected per event. Pure analytics surfacing — reads only,
-- guarded by operator_guard() (the dashboard reads everything; anon sees
-- nothing — ADR-13); it touches NO bet path.
--
-- Mirrors the dash_event_detail idiom (0022): operator_guard() first statement,
-- SECURITY DEFINER, set search_path = public, jsonb_build_object. The
-- per-event health columns are INDEPENDENTLY nullable (live: some events have a
-- last snapshot but no consensus yet, and 0/119 have a house row today).
--
-- Migration number: 0028 is RESERVED for the Phase-3 analytics_decouple
-- migration (list_buildable_events drops cs.verified=true) which is not built in
-- this phase; this file is the Phase-1 surfacing migration, allocated 0029 per
-- BLUEPRINT-analytics-buildout.md §5/§7.2.
create or replace function public.dash_events_list(p_champion text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  with ev as (
    select
      me.id,
      me.slug,
      c.display_name as city,
      c.slug as city_slug,
      me.target_date,
      me.accepting_orders,
      me.ladder_ok,
      me.closed,
      me.volume24h,
      (select count(*) from market_buckets b where b.event_id = me.id) as n_buckets,
      (select max(ms.captured_at)
         from market_snapshots ms
         join market_buckets b on b.id = ms.bucket_id
        where b.event_id = me.id) as last_snapshot_at,
      (select max(bp.made_at)
         from bucket_probabilities bp
        where bp.event_id = me.id and bp.source = 'market_consensus') as last_consensus_at,
      exists (
        select 1 from bucket_probabilities bp
         where bp.event_id = me.id and bp.source <> 'market_consensus'
      ) as has_house
    from market_events me
    join cities c on c.id = me.city_id
    where not me.closed
  )
  select jsonb_build_object(
    'events', coalesce(jsonb_agg(jsonb_build_object(
      'slug', ev.slug, 'city', ev.city, 'citySlug', ev.city_slug, 'targetDate', ev.target_date,
      'acceptingOrders', ev.accepting_orders, 'ladderOk', ev.ladder_ok, 'closed', ev.closed,
      'nBuckets', ev.n_buckets, 'lastSnapshotAt', ev.last_snapshot_at,
      'lastConsensusAt', ev.last_consensus_at, 'hasHouse', ev.has_house, 'volume24h', ev.volume24h
    ) order by ev.target_date, ev.city), '[]'::jsonb),
    'champion', p_champion,
    'counts', jsonb_build_object(
      'open', count(*),
      'withSnapshot', count(*) filter (where ev.last_snapshot_at is not null),
      'withConsensus', count(*) filter (where ev.last_consensus_at is not null),
      'withHouse', count(*) filter (where ev.has_house),
      'withLadder', count(*) filter (where ev.ladder_ok)
    )
  ) into v
  from ev;
  return v;
end;
$$;
