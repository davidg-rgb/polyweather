-- 0033_get_build_inputs_ra3_guard.sql — structural R-A3 peek-safety + live-over-backfill tie-break
-- (code-review FIX 5/6). CREATE OR REPLACE of the 2-arg get_build_inputs(uuid, boolean) from 0031.
--
-- FIX 5 (enforce R-A3 in SQL, not just in a doc-comment): 0031 made p_allow_backfill=true include
--   backfill-slot rows, with the information-time safety living ONLY in distributions.ts prose ("pass
--   true only for target_date >= today"). Nothing stopped a caller from passing true on a PAST target
--   and silently peeking — backfill rows carry captured_at = the recent backfill RUN instant, not the
--   historical issue time, so feeding them into a build dated to a resolved day corrupts ADR-16
--   time-matching (the ADR-16 peek). This makes the guard STRUCTURAL: backfill rows are admitted only
--   when `p_allow_backfill AND me.target_date >= current_date`. A past target can NEVER pull backfill
--   rows even with the flag true. Applied to BOTH the forecasts and ensembles sub-selects.
--   The default-false path is BIT-IDENTICAL to 0031/0016 (the new conjunct collapses: when
--   p_allow_backfill is false the whole `(p_allow_backfill and …)` term is false → the `or
--   snapshot_slot <> 'backfill'` exclusion stands exactly as before).
--
-- FIX 6 (prefer LIVE over backfill on a tie): the `distinct on (model)` previously ordered only by
--   captured_at desc, so when both a live row and a (more-recently-run) backfill row exist for the
--   same model/target — possible only on a today/future target under allowBackfill=true — the backfill
--   row could win purely because its run instant is newer. Add `(snapshot_slot = 'backfill')` as the
--   FIRST tiebreak after model: false sorts before true, so a live row is always preferred; captured_at
--   desc still breaks ties within the same slot class. Applied to forecasts and ensembles.
--
-- IMPLEMENTATION NOTE: the 2-arg signature get_build_inputs(uuid, boolean) already exists (0031), so a
-- plain CREATE OR REPLACE on the SAME signature suffices — no drop (unlike 0031, which had to drop the
-- 0016 1-arg form to avoid an ambiguous overload). Idempotent across a full-chain re-apply.

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
          -- W19 gated by DF-2: default keeps the exclusion. FIX 5 R-A3: backfill admitted ONLY for a
          -- present/future target (never a PAST target_date, even with the flag true → no ADR-16 peek).
          and ((p_allow_backfill and me.target_date >= current_date) or fs.snapshot_slot <> 'backfill')
        -- FIX 6: prefer a LIVE row over a (possibly newer-run) backfill row on a tie (false < true).
        order by fs.model, (fs.snapshot_slot = 'backfill'), fs.captured_at desc
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
          and ((p_allow_backfill and me.target_date >= current_date) or es.snapshot_slot <> 'backfill')   -- FIX 5 R-A3
        order by es.model, (es.snapshot_slot = 'backfill'), es.captured_at desc                            -- FIX 6 live-over-backfill
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
