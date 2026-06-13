-- 0027_calib_statement_timeout.sql — statement-timeout headroom for the two
-- heavy calibration aggregations (ARCHITECTURE.md §6.18).
--
-- Found live (2026-06-13): a full-universe backfill catch-up fold made
-- `calib_new_pairs` aggregate ~365k forecast↔observation pairs into a ~21 MB
-- jsonb in ~7.2s, tripping Supabase's default ~8s `statement_timeout` on the
-- PostgREST RPC role — run-calibration failed with "canceling statement due to
-- statement timeout" and folded nothing (the cursor only advances after a
-- successful upsert, so the failure was clean/idempotent). The primary fix is to
-- bound per-run work (run-calibration's MAX_OBS_PER_RUN lowered so each fold's
-- payload stays small and memory-safe on the edge runtime); this migration adds
-- defensive headroom on the two history-spanning aggregations so a single dense
-- station-window can never re-trip the default. Bodies are otherwise VERBATIM
-- from 0017 — only the `set statement_timeout` clause is added.

create or replace function public.calib_new_pairs(p_since timestamptz, p_until timestamptz)
returns table (icao text, groups jsonb)
language sql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with pairs as (
    select fs.icao as picao, fs.model, fs.lead_days, slot.s as slot,
           (fs.snapshot_slot in ('backfill', 'gapfill')) as is_seed,
           (fs.tmax_c - case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                             else o.tmax_wu_native end) as error_c,
           o.date_local
    from observations o
    join forecast_snapshots fs
      on fs.icao = o.icao and fs.target_date = o.date_local and fs.lead_days between 0 and 7
    cross join lateral unnest(
      case when fs.snapshot_slot in ('backfill', 'gapfill') then array['10Z', '22Z']
           else array[fs.snapshot_slot] end) as slot(s)
    where o.finalized_at is not null and o.tmax_wu_native is not null
      and (p_since is null or o.finalized_at > p_since)
      and o.finalized_at <= p_until
  ),
  grp as (
    select picao, model, lead_days, slot,
           jsonb_agg(jsonb_build_array(date_local, round(error_c::numeric, 4), is_seed)
                     order by date_local) as errors
    from pairs
    group by picao, model, lead_days, slot
  )
  select g.picao::text,
         jsonb_agg(jsonb_build_object('model', g.model, 'lead', g.lead_days, 'slot', g.slot, 'errors', g.errors))
  from grp g
  group by g.picao;
$$;

create or replace function public.calib_window_errors(p_window_days int, p_icaos text[], p_today date)
returns table (icao text, groups jsonb)
language sql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
  with pairs as (
    select fs.icao as picao, fs.model, fs.lead_days, slot.s as slot,
           (fs.snapshot_slot in ('backfill', 'gapfill')) as is_seed,
           (fs.tmax_c - case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0
                             else o.tmax_wu_native end) as error_c,
           o.date_local
    from observations o
    join forecast_snapshots fs
      on fs.icao = o.icao and fs.target_date = o.date_local and fs.lead_days between 0 and 7
    cross join lateral unnest(
      case when fs.snapshot_slot in ('backfill', 'gapfill') then array['10Z', '22Z']
           else array[fs.snapshot_slot] end) as slot(s)
    where o.finalized_at is not null and o.tmax_wu_native is not null
      and o.icao = any(p_icaos)
      and o.date_local > p_today - p_window_days and o.date_local <= p_today
  ),
  grp as (
    select picao, model, lead_days, slot,
           jsonb_agg(jsonb_build_array(date_local, round(error_c::numeric, 4), is_seed)
                     order by date_local) as errors
    from pairs
    group by picao, model, lead_days, slot
  )
  select g.picao::text,
         jsonb_agg(jsonb_build_object('model', g.model, 'lead', g.lead_days, 'slot', g.slot, 'errors', g.errors))
  from grp g
  group by g.picao;
$$;
