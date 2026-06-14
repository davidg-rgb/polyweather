-- 0031_get_build_inputs_allow_backfill.sql — opt-in backfill inclusion for the house build
-- (BLUEPRINT §6.B DF-2 / §7.1, R-A3). Backward-compatible: the default path is BIT-IDENTICAL
-- to 0016's get_build_inputs(uuid).
--
-- The forecasts/ensembles sub-selects keep `snapshot_slot <> 'backfill'` (W19) UNLESS
-- p_allow_backfill = true. The live build path passes no flag → false → the backfill exclusion
-- stays → no behavior change. Only an analytics caller (seeding present/future open events, or the
-- offline scorer) ever passes true.
--
-- R-A3 INFORMATION-TIME GUARD: backfill rows carry captured_at = the backfill RUN instant (recent),
-- NOT the historical forecast issue time. Including them in a build dated to a PAST target_date
-- produces a distribution from information the model could not have had → it CORRUPTS ADR-16
-- time-matching and makes any subsequent score_distributions grade a peeked distribution.
-- THEREFORE p_allow_backfill=true is valid ONLY for target_date >= today (seeding open events) OR
-- the offline scorer (DF-5). NO live caller is wired to pass true (build-distributions /
-- discover-markets / metar-nowcast all keep the default-false live path — see distributions.ts).
--
-- IMPLEMENTATION NOTE: a defaulted param added via CREATE OR REPLACE would create a SECOND overload
-- alongside 0016's get_build_inputs(uuid), making get_build_inputs(uuid) ambiguous ("not unique").
-- Drop the 1-arg signature first, then create the 2-arg form with the default — yields exactly one
-- function callable as both get_build_inputs(uuid) and get_build_inputs(uuid, boolean). Idempotent
-- across a full-chain re-apply (0016 re-creates the 1-arg, this drops it again).
drop function if exists public.get_build_inputs(uuid);

create or replace function public.get_build_inputs(p_event_id uuid,
                                                   p_allow_backfill boolean default false)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'event', jsonb_build_object('id', me.id, 'slug', me.slug, 'targetDate', me.target_date, 'unit', me.unit, 'ladderOk', me.ladder_ok),
    'city', jsonb_build_object('slug', c.slug, 'tz', c.tz),
    'icao', cs.icao,
    'buckets', (
      select jsonb_agg(jsonb_build_object('idx', b.bucket_idx, 'low', b.low_native, 'high', b.high_native) order by b.bucket_idx)
      from market_buckets b where b.event_id = me.id
    ),
    'forecasts', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', f.id, 'model', f.model, 'tmaxC', f.tmax_c, 'slot', f.snapshot_slot, 'capturedAt', f.captured_at)), '[]'::jsonb)
      from (
        select distinct on (fs.model) fs.id, fs.model, fs.tmax_c, fs.snapshot_slot, fs.captured_at
        from forecast_snapshots fs
        join models m on m.slug = fs.model and m.enabled and not m.is_ensemble
        where fs.icao = cs.icao and fs.target_date = me.target_date
          and (p_allow_backfill or fs.snapshot_slot <> 'backfill')   -- W19 gated by DF-2 (default keeps the exclusion)
        order by fs.model, fs.captured_at desc
      ) f
    ),
    'stats', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'model', ms.model, 'lead', ms.lead_days, 'slot', ms.snapshot_slot,
        'bias', ms.bias_c, 'sigma', ms.residual_sigma_c, 'weight', ms.weight, 'version', ms.stats_version)), '[]'::jsonb)
      from model_stats ms where ms.icao = cs.icao
    ),
    'ensembles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'model', e.model, 'members', e.members_c, 'n', e.n_members)), '[]'::jsonb)
      from (
        select distinct on (es.model) es.id, es.model, es.members_c, es.n_members
        from ensemble_snapshots es
        where es.icao = cs.icao and es.target_date = me.target_date
          and (p_allow_backfill or es.snapshot_slot <> 'backfill')   -- W19 gated by DF-2 (default keeps the exclusion)
        order by es.model, es.captured_at desc
      ) e
    ),
    'intraday', (
      select jsonb_build_object('maxTenthsC', im.max_tenths_c, 'maxNative', im.max_native)
      from intraday_max im where im.icao = cs.icao and im.date_local = me.target_date
    ),
    'lift', (
      select coalesce(jsonb_agg(jsonb_build_object('hour', nl.local_hour, 'p50', nl.p50_remaining, 'p90', nl.p90_remaining)), '[]'::jsonb)
      from nowcast_lift nl where nl.icao = cs.icao
    )
  )
  from market_events me
  join cities c on c.id = me.city_id
  join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where me.id = p_event_id;
$$;
