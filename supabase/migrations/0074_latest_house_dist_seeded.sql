-- 0074_latest_house_dist_seeded.sql — fix the convergence/accuracy SEED SPLIT being silently defeated.
--
-- THE BUG (code review 2026-06-30). The 2026-06-29 convergence/accuracy split makes the opening-convergence
-- seed build a RAW-consensus house_gaussian (biasCorrect=false, seeded=true, inputs_hash tagged 'raw' so it
-- coexists with any calibrated production row). But the READ half — latest_house_dist (0066 §6.2) — selected
-- the freshest non-nowcast house_gaussian by made_at with NO filter on `seeded`. A §9R bot city is ALSO a
-- production-scored station, so build-distributions routinely writes a CALIBRATED (seeded=false) house_gaussian
-- for the SAME event_id; whenever that calibrated row was newer, latest_house_dist returned IT, and the seed's
-- seedFreshnessMin throttle (opening-capture seed.ts) reused it — so the bot captured the BIAS-CORRECTED center,
-- the exact accuracy lens consensusSource='ensemble_raw' was built to EXCLUDE. The split failed silently and the
-- forward convergence / maker-exit measurement was contaminated.
--
-- THE FIX. latest_house_dist is bot-ONLY (its sole caller is the on-demand seedHouseDist). The seed always reads
-- back ITS OWN dist (which it writes with seeded=true), never a production calibrated one — so restrict the read
-- to seeded rows. Everything else is byte-identical to the 0066 definition (the labelled-buckets join, grants).

create or replace function public.latest_house_dist(p_event_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with d as (
    select bp.id, bp.probs, bp.mu_native, bp.sigma_native, bp.lead_days, bp.made_at, bp.nowcast, bp.seeded
    from public.bucket_probabilities bp
    -- seeded=true ONLY (0074): the seed reads back its OWN raw-consensus dist; a fresher production CALIBRATED
    -- (seeded=false) house_gaussian for the same event must NEVER shadow it (the convergence/accuracy split).
    where bp.event_id = p_event_id and bp.source = 'house_gaussian' and bp.nowcast = false
      and coalesce(bp.seeded, false) = true
    order by bp.made_at desc
    limit 1
  )
  select case when d.id is null then null else jsonb_build_object(
    'eventId',  p_event_id,
    'source',   'house_gaussian',
    'lead',     d.lead_days,
    'madeAt',   d.made_at,
    'seeded',   coalesce(d.seeded, false),
    'mu',       d.mu_native,
    'sigma',    d.sigma_native,
    'probs',    d.probs,
    'buckets',  coalesce((
      select jsonb_agg(jsonb_build_object(
        'idx', mb.bucket_idx, 'label', mb.label, 'low', mb.low_native, 'high', mb.high_native,
        'prob', case when mb.bucket_idx + 1 <= array_length(d.probs, 1) then d.probs[mb.bucket_idx + 1] else null end
      ) order by mb.bucket_idx)
      from public.market_buckets mb where mb.event_id = p_event_id
    ), '[]'::jsonb)
  ) end
  from d;
$$;

revoke all on function public.latest_house_dist(uuid) from public, anon, authenticated;
grant  execute on function public.latest_house_dist(uuid) to service_role;
