-- 0016_distribution_rpcs.sql — build-distributions surface (ARCHITECTURE.md §6.16, W3, W19).

-- Open, gradable, VERIFIED-station, ladder-ok events — the buildable set.
create or replace function public.list_buildable_events()
returns table (event_id uuid)
language sql
security definer
set search_path = public
as $$
  select me.id
  from market_events me
  join city_stations cs on cs.city_id = me.city_id and cs.valid_to is null and cs.verified = true
  where me.closed = false and me.winning_bucket_idx is null and me.ladder_ok = true;
$$;

-- Everything one build needs in a single round trip. Latest forecast row per
-- model EXCLUDES 'backfill' slots (W19: backfill never feeds live builds).
create or replace function public.get_build_inputs(p_event_id uuid)
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
          and fs.snapshot_slot <> 'backfill'
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
        where es.icao = cs.icao and es.target_date = me.target_date and es.snapshot_slot <> 'backfill'
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

-- Idempotent write: unchanged inputs_hash ⇒ no new row (§7.12 natural key).
create or replace function public.upsert_distribution(
  p_event_id uuid, p_source text, p_lead smallint, p_nowcast boolean,
  p_inputs_hash text, p_probs numeric[], p_mu numeric, p_sigma numeric, p_stats_version int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted boolean;
begin
  insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, mu_native, sigma_native, stats_version)
  values (p_event_id, p_source, p_lead, p_nowcast, now(), p_inputs_hash, p_probs, p_mu, p_sigma, p_stats_version)
  on conflict (event_id, source, inputs_hash) do nothing
  returning true into v_inserted;
  return coalesce(v_inserted, false);
end;
$$;
