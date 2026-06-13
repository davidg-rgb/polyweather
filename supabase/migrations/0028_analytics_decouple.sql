-- 0028_analytics_decouple.sql — decouple the HOUSE BUILD from the trading verified gate
-- (DATA-LAYER-REVIEW #1/#4, ADR-18, BLUEPRINT §6.B HD-1/DF-1).
--
-- The build writes bucket_probabilities (pure analytics — house_gaussian / house_ensemble);
-- it NEVER places a bet. `city_stations.verified` and `cities.betting_enabled` continue to
-- gate ONLY the bet/candidate path (poll-markets/handler.ts:302-305 `bettable`,
-- edge.ts:99 `station_unverified` — LEFT UNCHANGED by this migration).
--
-- Root cause this fixes: the `and cs.verified = true` inner-join conjunct (was 0016:12)
-- zeroed list_buildable_events() live (0/45 active stations are operator-verified), so
-- build-distributions iterated over nothing and `house_gaussian` never built — the dead
-- decision layer. Dropping that one conjunct yields ~100 buildable events across 44 ICAOs.
--
-- DO NOT re-add `verified` / `betting_enabled` to this RPC (R-A9 adversarial re-coupling):
-- it would re-couple analytics to the trading gate and re-zero the house build. The
-- city_stations join STAYS (minus verified) so list_buildable_events and get_build_inputs
-- agree on the buildable set — an event whose city has no CURRENT mapping has no ICAO to
-- fetch forecasts for and could never build anyway.
create or replace function public.list_buildable_events()
returns table (event_id uuid)
language sql security definer set search_path = public
as $$
  select me.id
  from market_events me
  join city_stations cs on cs.city_id = me.city_id and cs.valid_to is null
  where me.closed = false and me.winning_bucket_idx is null and me.ladder_ok = true;
$$;
