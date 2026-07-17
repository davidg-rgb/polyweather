-- 0106_city_predictions.sql — the CITIES PREDICTION TABLE data layer (UI-POLISH-HANDOFF.md WS-B).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: the operator asked for one clean headline table — every available city, our prediction for each
-- ACTIVE market day, the historic per-city success rate, and time to close. The success-rate half needs
-- every graded capture-stream event's LAST pre-resolution prediction compared to the resolved winner —
-- an on-request scan of ~2 months × 45 cities of TOASTed ~15-bucket capture jsonbs would flirt with the
-- calling role's 8s statement_timeout (the exact 0098/0099 class). The permanent shape is the 0100
-- precedent: pay O(1 event) at GRADING-WRITE time, O(tiny table) at read.
--
-- WHAT:
--   1. city_prediction_grades — one row per GRADED capture-stream event: the argmax-houseProb bucket of
--      the event's LAST pre-resolution capture (EXACTLY the buy-table selector's pick — the
--      selectBuyTableCandidates / 0100 idiom: identity-complete buckets only, houseProb argmax) vs the
--      resolved winner coalesce(poly_resolved_winner_idx, winning_bucket_idx). Unseeded captures fold as
--      predicted_idx NULL / hit NULL (coverage row exists, excluded from the rate); grading_mismatch
--      events fold with mismatch=true (excluded from the rate). RLS enabled, no policies (definer-only
--      access, the 0066 idiom). Tiny forever (~45 cities × graded days since 2026-06-27).
--   2. city_prediction_grades_fold(p_event_ids) — the ONE canonical fold statement (upsert, recompute-safe:
--      a later poly_resolved flip or mismatch flag re-adjudicates the row).
--   3. Two row-level triggers on market_events calling the fold, EXCEPTION-SWALLOWED (a broken fold must
--      never fail the grader — the 0100 contract):
--        · AFTER INSERT WHEN the row arrives already graded (the backfill-market-history direct-INSERT path);
--        · AFTER UPDATE WHEN the effective winner or grading_mismatch actually TRANSITIONS (claim_event_winner /
--          flag_grading_mismatch / the backfill's direct UPDATE — poll updates of volume/last_seen never fire it).
--   4. One-time BACKFILL over every already-graded event that has captures (runs as the migration role — no
--      8s budget). Idempotent: the fold upserts; the table is a pure derivation of opening_captures ⋈
--      market_events and is always safe to rebuild.
--   5. dash_city_predictions() — the /cities page's ONE operator read (jsonb OBJECT, operator_guard, the
--      dash_data posture): { generatedAt, config, stats:[per-city success rates], rows:[per OPEN market:
--      city, target day, our prediction + house prob, the predicted bucket's ask, resolves_at] }. The OPEN
--      half is cheap by construction: driven from the market_events partial open index, ONE LIMIT-1 lateral
--      per event via oc_event_captured_idx (~50-100 detoasts, no capture scan). `config` carries the live
--      buy-window/price-cap tunables so the page's highlight can never drift from the lane's real config.
--
-- Grants: dash_city_predictions → authenticated + service_role (self-guards via operator_guard, the
-- dash_data posture); the fold fn → service_role only (post-0034 contract). No cron change (count stays 35).
--
-- Rollback: drop trigger city_prediction_grades_ins_trg on public.market_events;
--           drop trigger city_prediction_grades_upd_trg on public.market_events;
--           drop function public.city_prediction_grades_trg();
--           drop function public.city_prediction_grades_fold(uuid[]);
--           drop function public.dash_city_predictions();
--           drop table public.city_prediction_grades;
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · the grades table
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.city_prediction_grades (
  event_id          uuid primary key references public.market_events(id),
  city              text not null,        -- lower(trim(opening_captures.city)) — the capture stream's slug
  target_date       date not null,        -- station-local market day (C-6)
  predicted_idx     int,                  -- argmax-houseProb bucket of the LAST pre-resolution capture; NULL = unseeded
  predicted_label   text,                 -- its ladder label ("31°C", "88-89°F")
  predicted_prob    numeric,              -- its houseProb at that capture
  winner_idx        int not null,         -- coalesce(poly_resolved_winner_idx, winning_bucket_idx) at fold time
  hit               boolean,              -- predicted_idx = winner_idx; NULL when unseeded (excluded from the rate)
  mismatch          boolean not null default false, -- market_events.grading_mismatch at fold time (excluded from the rate)
  graded_capture_at timestamptz,          -- when the graded prediction was captured (audit)
  folded_at         timestamptz not null default now()
);
create index if not exists cpg_city_idx on public.city_prediction_grades (city);
comment on table public.city_prediction_grades is
  'One row per GRADED capture-stream event: the argmax-houseProb prediction of the event''s LAST '
  'pre-resolution opening_captures tick vs the resolved winner. Folded incrementally by the market_events '
  'grading triggers; pure derivation of opening_captures ⋈ market_events — safe to rebuild any time. '
  'Feeds dash_city_predictions() (the /cities page). 0106 / UI-POLISH-HANDOFF.md WS-B.';
alter table public.city_prediction_grades enable row level security;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · the canonical fold (upsert per event — recompute-safe on winner/mismatch transitions)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_prediction_grades_fold(p_event_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  insert into public.city_prediction_grades as t
    (event_id, city, target_date, predicted_idx, predicted_label, predicted_prob,
     winner_idx, hit, mismatch, graded_capture_at)
  select me.id,
         lower(trim(oc.city)),
         oc.target_date,
         pb.idx, pb.label, pb.prob,
         coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)::int,
         case when pb.idx is null then null
              else pb.idx = coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)::int end,
         (me.grading_mismatch = true),
         oc.captured_at
  from public.market_events me
  cross join lateral (
    -- the event's LAST PRE-RESOLUTION capture: a tick stamped after its own resolves_at clock is a
    -- post-close book state (the answer already leaking in) and must never be the graded prediction.
    select oc2.city, oc2.target_date, oc2.captured_at, oc2.buckets
    from public.opening_captures oc2
    where oc2.event_id = me.id
      and (oc2.resolves_at is null or oc2.captured_at <= oc2.resolves_at)
    order by oc2.captured_at desc
    limit 1
  ) oc
  left join lateral (
    -- OUR prediction = the buy-table selector's exact pick (0100 idiom): argmax houseProb among
    -- identity-complete buckets; a shapeless/absent ladder or an unseeded capture folds as NULL.
    select (b.value->>'idx')::int             as idx,
           b.value->>'label'                  as label,
           (b.value->>'houseProb')::numeric   as prob
    from jsonb_array_elements(
           case when jsonb_typeof(oc.buckets) = 'array' then oc.buckets else '[]'::jsonb end) b
    where jsonb_typeof(b.value->'houseProb') = 'number'
      and coalesce(b.value->>'conditionId', '') <> ''
      and coalesce(b.value->>'tokenYes', '')    <> ''
    order by (b.value->>'houseProb')::numeric desc
    limit 1
  ) pb on true
  where me.id = any(p_event_ids)
    and coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is not null
    and oc.city is not null and coalesce(lower(trim(oc.city)), '') <> ''
    and oc.target_date is not null
  on conflict (event_id) do update set
    city              = excluded.city,
    target_date       = excluded.target_date,
    predicted_idx     = excluded.predicted_idx,
    predicted_label   = excluded.predicted_label,
    predicted_prob    = excluded.predicted_prob,
    winner_idx        = excluded.winner_idx,
    hit               = excluded.hit,
    mismatch          = excluded.mismatch,
    graded_capture_at = excluded.graded_capture_at,
    folded_at         = now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.city_prediction_grades_fold(uuid[]) from public, anon, authenticated;
grant  execute on function public.city_prediction_grades_fold(uuid[]) to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · the grading triggers (exception-swallowed — never break the grader)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_prediction_grades_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.city_prediction_grades_fold(array[new.id]);
  exception when others then
    null; -- display-only derivation: a broken fold must never fail claim_event_winner / the backfill (0100 contract)
  end;
  return null;
end;
$$;

-- INSERT path: backfill-market-history inserts historical events already graded.
drop trigger if exists city_prediction_grades_ins_trg on public.market_events;
create trigger city_prediction_grades_ins_trg
  after insert on public.market_events
  for each row
  when (coalesce(new.poly_resolved_winner_idx, new.winning_bucket_idx) is not null)
  execute function public.city_prediction_grades_trg();

-- UPDATE path: fires ONLY when the effective winner or the mismatch flag transitions — the routine
-- poll updates (volume24h / last_seen / accepting_orders) never invoke the fold.
drop trigger if exists city_prediction_grades_upd_trg on public.market_events;
create trigger city_prediction_grades_upd_trg
  after update on public.market_events
  for each row
  when (coalesce(new.poly_resolved_winner_idx, new.winning_bucket_idx) is distinct from
        coalesce(old.poly_resolved_winner_idx, old.winning_bucket_idx)
     or new.grading_mismatch is distinct from old.grading_mismatch)
  execute function public.city_prediction_grades_trg();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · one-time backfill (migration role — no 8s budget; idempotent via the upserting fold)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare v_ids uuid[]; v_n int;
begin
  select array_agg(me.id) into v_ids
  from public.market_events me
  where coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is not null
    and exists (select 1 from public.opening_captures oc where oc.event_id = me.id);
  if v_ids is not null then
    v_n := public.city_prediction_grades_fold(v_ids);
    raise notice '0106: city_prediction_grades backfilled % graded events', v_n;
  end if;
end;
$$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · dash_city_predictions() — the /cities operator read (jsonb OBJECT, dash_data posture)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_city_predictions()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stats jsonb;
  v_rows  jsonb;
  v_cfg   jsonb;
begin
  perform public.operator_guard();

  -- (a) live buy-window/price-cap tunables (buy_table.* config) so the page highlight tracks the lane's
  -- real config. Fail-safe: a malformed hand-edited value falls back to the 0095 defaults, never a throw.
  begin
    v_cfg := jsonb_build_object(
      'leadMinH', coalesce((select value::numeric from public.config where key = 'buy_table.lead_min_h'), 2),
      'leadMaxH', coalesce((select value::numeric from public.config where key = 'buy_table.lead_max_h'), 12),
      'priceCap', coalesce((select value::numeric from public.config where key = 'buy_table.price_cap'), 0.15)
    );
  exception when others then
    v_cfg := jsonb_build_object('leadMinH', 2, 'leadMaxH', 12, 'priceCap', 0.15);
  end;

  -- (b) per-city historic success rate over the folded grades. mismatch rows and unseeded predictions
  -- (hit IS NULL) are excluded from the rate; n is ALWAYS carried so the page can render "62% (n=18)"
  -- and grey out small samples (the entry-watch shrinkage lesson — never a bare small-n percentage).
  select coalesce(jsonb_agg(jsonb_build_object(
           'city',           s.city,
           'displayName',    coalesce(c.display_name, s.city),
           'unit',           c.unit,
           'n',              s.n,
           'hits',           s.hits,
           'rate',           case when s.n > 0 then round(s.hits::numeric / s.n, 4) end,
           'lastGradedDate', s.last_date
         ) order by s.city), '[]'::jsonb)
  into v_stats
  from (
    select g.city,
           count(*) filter (where g.hit is not null) as n,
           count(*) filter (where g.hit)             as hits,
           max(g.target_date)                        as last_date
    from public.city_prediction_grades g
    where not g.mismatch
    group by g.city
  ) s
  left join public.cities c on c.slug = s.city;

  -- (c) one row per OPEN captured market: driven from the market_events partial open index; ONE LIMIT-1
  -- lateral per event via oc_event_captured_idx (never a capture scan — the 0098/0099/0100 law).
  select coalesce(jsonb_agg(jsonb_build_object(
           'city',        lower(trim(oc.city)),
           'displayName', coalesce(c.display_name, lower(trim(oc.city))),
           'unit',        c.unit,
           'targetDate',  oc.target_date,
           'resolvesAt',  oc.resolves_at,
           'capturedAt',  oc.captured_at,
           'predIdx',     pb.idx,
           'predLabel',   pb.label,
           'predProb',    pb.prob,
           'ask',         pb.ask
         ) order by oc.resolves_at, lower(trim(oc.city))), '[]'::jsonb)
  into v_rows
  from public.market_events me
  join public.cities c on c.id = me.city_id
  cross join lateral (
    -- the event's LATEST capture — the page's current view of the market.
    select oc2.city, oc2.target_date, oc2.resolves_at, oc2.captured_at, oc2.buckets
    from public.opening_captures oc2
    where oc2.event_id = me.id
    order by oc2.captured_at desc
    limit 1
  ) oc
  left join lateral (
    -- the SAME pick as the fold + the live lane: argmax houseProb, identity-complete; ITS
    -- execAsk→bestAsk (never the next-best bucket's) — the 0100 gate-price idiom.
    select (b.value->>'idx')::int           as idx,
           b.value->>'label'                as label,
           (b.value->>'houseProb')::numeric as prob,
           case when jsonb_typeof(b.value->'execAsk') = 'number' then (b.value->>'execAsk')::numeric
                when jsonb_typeof(b.value->'bestAsk') = 'number' then (b.value->>'bestAsk')::numeric
           end as ask
    from jsonb_array_elements(
           case when jsonb_typeof(oc.buckets) = 'array' then oc.buckets else '[]'::jsonb end) b
    where jsonb_typeof(b.value->'houseProb') = 'number'
      and coalesce(b.value->>'conditionId', '') <> ''
      and coalesce(b.value->>'tokenYes', '')    <> ''
    order by (b.value->>'houseProb')::numeric desc
    limit 1
  ) pb on true
  where not me.closed
    and coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is null
    and me.target_date >= current_date - 1
    and oc.resolves_at > now();

  return jsonb_build_object(
    'generatedAt', now(),
    'config',      v_cfg,
    'stats',       v_stats,
    'rows',        v_rows
  );
end;
$$;

revoke all on function public.dash_city_predictions() from public, anon, authenticated;
grant  execute on function public.dash_city_predictions() to authenticated, service_role;
