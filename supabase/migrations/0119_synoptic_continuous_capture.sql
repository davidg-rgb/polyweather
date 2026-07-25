-- 0119_synoptic_continuous_capture.sql — the obs↔price research corpus widening (2026-07-25).
--
-- Operator-directed: log the 5-min Synoptic obs for EVERY active Polymarket-city
-- station AROUND THE CLOCK (the handler now polls list_active_stations() instead
-- of the open-event daytime nowcast set — the API's tier serves the US subset,
-- currently 11 cities), and KEEP the corpus: retention 14d → 90d. The goal is a
-- minute-grain obs↔price join (does fresh obs data lead Polymarket price moves,
-- and by what lag) — the 14-day trial window is the capture opportunity.
--
-- Size at 90d: ~11 stations × 288 obs/day × 90d ≈ 285k slim rows (≈ tens of MB) —
-- inside the storage-tiering hot-window policy; the long-term home is the local
-- archive (scripts/research/out/synoptic-obs-archive/, pulled by the history
-- puller before any prune bites).
--
-- Rollback: re-apply 0118's synoptic_obs_log (14d).

create or replace function public.synoptic_obs_log(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer := 0;
begin
  insert into synoptic_obs (icao, obs_at, temp_tenths_c)
  select r->>'icao', (r->>'obs_at')::timestamptz, (r->>'temp_tenths_c')::numeric
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where r->>'icao' is not null
  on conflict (icao, obs_at) do nothing;
  get diagnostics n = row_count;

  -- 90-day hot window (0119; was 14d in 0118) — the research corpus must outlive
  -- the trial. The obs_at index serves the range delete.
  delete from synoptic_obs where obs_at < now() - interval '90 days';
  return n;
end;
$$;
