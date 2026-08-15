-- 0129_cheap_early_variant_ledger.sql — persist the cheap-early forward run's REALIZED entries so n accrues
-- forever, independent of the capture retention window.
--
-- WHY. The cheap-early panel (0117) + its pre-registered variant sweep (0127/0128) RE-REPLAY `opening_captures`
-- on every tick: the scored sample is whatever captures are still in the database, and nothing else. That was
-- fine at 21 days of retention. It is not fine on the Supabase FREE TIER, where `opening_captures` costs
-- ~18–30 MB/day and scripts/ops/free-tier-sweep.ts prunes it at resolved+1 day (OC_RESOLVED_AGE_DAYS=1) — the
-- panel would silently collapse to a ~1-day sample and the §9R-E gate would never accrue toward a verdict again,
-- while still LOOKING like a running forward loop. A forward test whose n resets nightly is not a forward test.
--
-- WHAT. A small append-mostly ledger of the REALIZED (graded) entries, one row per (variant, city, target_date)
-- — the natural market key, since a city lists exactly one temperature event per target date. The Edge tick
-- reads it before building the view (the view merges ledger ∪ replay, the ledger row winning on a collision) and
-- writes back every realized entry afterwards. The write is an idempotent upsert, so a re-run, a retry, or a
-- re-replay of a market still in the capture window all converge to the same row.
--
-- BOUNDARY (unchanged, load-bearing). This is MEASUREMENT ONLY — paper, no capital path. No trading function
-- reads this table; `trade_live_preflight` is untouched. The one intended consequence is that the CANONICAL
-- variant's gate-of-record (`bot_gate_snapshot`, source='forward-cheap-early') is now computed over the accrued
-- ledger rather than the surviving-captures window — i.e. the gate can finally reach its §9R-E floor honestly.
-- A GO still needs a frozen PASS across ≥2 non-overlapping windows + an explicit operator decision.
--
-- COST. One row per graded entry per variant: 6 variants x a handful of entries/day = tens of rows/day, a few
-- hundred bytes each. The table is never pruned (that is the point) and is still orders of magnitude smaller
-- than one day of the captures it replaces.
--
-- SEED (one-time, idempotent). The forward run already has entries logged inside the LATEST `cheap_early_panel`
-- snapshot's compact per-variant `entries` arrays. Those are copied in here BEFORE the prune can reach the
-- captures behind them, so nothing measured so far is lost. Guarded on an empty table, so re-applying the
-- migration seeds nothing.
--
-- Idempotent throughout (create if not exists / create or replace / on conflict do nothing); PGlite-testable.
--
-- Rollback: drop function public.cheap_early_variant_ledger_read(date);
--           drop function public.record_cheap_early_variant_entries(jsonb);
--           drop table public.cheap_early_variant_ledger;
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── SECTION 1 · the ledger table ────────────────────────────────────────────────────────────────────
-- Key = (variant_id, city, target_date). No FK to market_events: the whole point is to OUTLIVE the rows the
-- entry was derived from. `won` + `net_return` are NOT NULL — an open/ungraded entry is never persisted here
-- (it is still replayed live each tick), so every row in this table is a settled fact.
create table if not exists public.cheap_early_variant_ledger (
  variant_id        text        not null,
  city              text        not null,
  target_date       date        not null,
  label             text,                      -- the bucket label bought (the temperature the bet opened on)
  entry_ask         numeric,                   -- the taker ask paid
  entry_captured_at timestamptz,               -- the entry tick's capture time, when the source carried one
  hours_to_close    numeric,                   -- hours-to-close at entry (where in the window we fired)
  depth_usd         numeric,                   -- the pick's executable depth at entry (the capacity read)
  won               boolean     not null,      -- graded: pick temperature == winning temperature
  net_return        numeric     not null,      -- realized net per $1 staked (CheapEarlyTrade.netReturn)
  stake_usd         numeric,                   -- the paper stake this entry was scored at
  engine_version    text,                      -- CHEAP_EARLY_ENGINE_VERSION at write time (semantics tag)
  first_seen_at     timestamptz default now(),
  updated_at        timestamptz default now(),
  primary key (variant_id, city, target_date)
);

create index if not exists cheap_early_variant_ledger_variant_date_idx
  on public.cheap_early_variant_ledger (variant_id, target_date desc);

comment on table public.cheap_early_variant_ledger is
  '0129: the PERSISTED realized entries of the forward cheap-early paper run, one row per (variant, city, '
  'target_date). Exists because opening_captures is pruned at resolved+1d on the free tier — the panel re-replays '
  'captures, so without this the forward n resets to ~1 day and the §9R-E gate can never accrue. MEASUREMENT '
  'ONLY: paper P&L, no capital path, no trading function reads it.';

-- RLS on (ADR-13): service-role only — written by record_cheap_early_variant_entries, read by
-- cheap_early_variant_ledger_read, both security definer. No policies: no browser session ever touches it.
alter table public.cheap_early_variant_ledger enable row level security;

-- ── SECTION 2 · record_cheap_early_variant_entries — the idempotent upsert ───────────────────────────
-- Takes the compact per-entry shape the view already carries (city/targetDate/label/ask/won/net + the optional
-- diagnostics) plus variantId + engineVersion. Rows missing a key part, a grade, or a net return are DROPPED
-- rather than stored half-formed — an open entry must never land here.
--
-- The update leg fires ONLY when the grade or the scoring actually changed (a regrade), so a steady-state tick
-- that re-sends the same 200 realized rows writes 0 rows and returns 0. Returns the number of rows written.
create or replace function public.record_cheap_early_variant_entries(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
set statement_timeout to '20s'
as $$
declare v_n int := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  with src as (
    select
      nullif(r->>'variantId', '')                as variant_id,
      nullif(r->>'city', '')                     as city,
      nullif(r->>'targetDate', '')::date         as target_date,
      nullif(r->>'label', '')                    as label,
      nullif(r->>'ask', '')::numeric             as entry_ask,
      nullif(r->>'capturedAt', '')::timestamptz  as entry_captured_at,
      nullif(r->>'hoursToClose', '')::numeric    as hours_to_close,
      nullif(r->>'depthUsd', '')::numeric        as depth_usd,
      (r->>'won')::boolean                       as won,
      nullif(r->>'net', '')::numeric             as net_return,
      nullif(r->>'stakeUsd', '')::numeric        as stake_usd,
      nullif(r->>'engineVersion', '')            as engine_version
    from jsonb_array_elements(p_rows) r
  ), ok as (
    -- last-wins de-dup WITHIN the batch: ON CONFLICT DO UPDATE cannot touch the same row twice in one statement.
    select distinct on (variant_id, city, target_date) *
      from src
     where variant_id is not null
       and city is not null
       and target_date is not null
       and won is not null
       and net_return is not null
     order by variant_id, city, target_date
  ), ins as (
    insert into public.cheap_early_variant_ledger as l
      (variant_id, city, target_date, label, entry_ask, entry_captured_at, hours_to_close, depth_usd,
       won, net_return, stake_usd, engine_version)
    select variant_id, city, target_date, label, entry_ask, entry_captured_at, hours_to_close, depth_usd,
           won, net_return, stake_usd, engine_version
      from ok
    on conflict (variant_id, city, target_date) do update
      set won        = excluded.won,
          net_return = excluded.net_return,
          label      = coalesce(excluded.label, l.label),
          updated_at = now()
      where l.won        is distinct from excluded.won
         or l.net_return is distinct from excluded.net_return
         or l.label      is distinct from coalesce(excluded.label, l.label)
    returning 1
  )
  select count(*) into v_n from ins;

  return coalesce(v_n, 0);
end;
$$;

revoke all on function public.record_cheap_early_variant_entries(jsonb) from public, anon, authenticated;
grant  execute on function public.record_cheap_early_variant_entries(jsonb) to service_role;

comment on function public.record_cheap_early_variant_entries(jsonb) is
  '0129: idempotent upsert of the cheap-early forward run''s REALIZED entries (one row per variant/city/'
  'target_date). Open entries and malformed rows are dropped. Returns the number of rows actually written — a '
  'steady-state tick re-sending unchanged rows writes 0. Service-role only; measurement, no capital path.';

-- ── SECTION 3 · cheap_early_variant_ledger_read — the panel's read ───────────────────────────────────
-- {variantId: [{city,targetDate,label,ask,capturedAt,hoursToClose,depthUsd,won,net,stakeUsd}]}. p_since bounds
-- the window by target date (null = the whole accrued record, which is what the panel wants).
create or replace function public.cheap_early_variant_ledger_read(p_since date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
set statement_timeout to '20s'
as $$
declare v jsonb;
begin
  select coalesce(jsonb_object_agg(g.variant_id, g.entries), '{}'::jsonb)
    into v
    from (
      select l.variant_id,
             jsonb_agg(
               jsonb_build_object(
                 'city',         l.city,
                 'targetDate',   l.target_date,
                 'label',        l.label,
                 'ask',          l.entry_ask,
                 'capturedAt',   l.entry_captured_at,
                 'hoursToClose', l.hours_to_close,
                 'depthUsd',     l.depth_usd,
                 'won',          l.won,
                 'net',          l.net_return,
                 'stakeUsd',     l.stake_usd
               )
               order by l.target_date, l.city
             ) as entries
        from public.cheap_early_variant_ledger l
       where p_since is null or l.target_date >= p_since
       group by l.variant_id
    ) g;
  return coalesce(v, '{}'::jsonb);
end;
$$;

revoke all on function public.cheap_early_variant_ledger_read(date) from public, anon, authenticated;
grant  execute on function public.cheap_early_variant_ledger_read(date) to service_role;

comment on function public.cheap_early_variant_ledger_read(date) is
  '0129: variantId -> its persisted realized cheap-early entries, the shape buildCheapEarlyView merges into each '
  'variant''s replayed panel. Service-role only.';

-- ── SECTION 4 · SEED (one-time) from the LATEST cheap_early_panel snapshot ───────────────────────────
-- The forward run's entries so far live in that snapshot's per-variant compact `entries` arrays:
--   {city, date, label, ask, won, net}  (+ htc/depth from this same deploy onward)
-- Mapping: city->city · date->target_date · label->label · ask->entry_ask · won->won · net->net_return ·
--          htc->hours_to_close · depth->depth_usd · view.stakeUsd->stake_usd ·
--          view.variantsCommon.engineVersion->engine_version · entry_captured_at stays NULL (the compact entry
--          never carried a capture time).
-- REALIZED is `won is not null` — the compact entry carries won:null for an open position and a boolean once
-- graded (core/sim/cheap-early-entry-replay.ts: the open branch returns won:null, the graded branch a boolean).
-- Guarded on an empty table + wrapped so a malformed snapshot can never fail the migration.
do $$
declare
  v_view jsonb;
  v_n    int := 0;
begin
  if exists (select 1 from public.cheap_early_variant_ledger limit 1) then
    raise notice '0129: cheap_early_variant_ledger already populated — seed skipped';
    return;
  end if;

  select cep.view into v_view
    from public.cheap_early_panel cep
   order by cep.captured_at desc, cep.id desc
   limit 1;

  if v_view is null then
    raise notice '0129: no cheap_early_panel snapshot to seed from — the ledger starts empty (the next tick fills it)';
    return;
  end if;

  begin
    insert into public.cheap_early_variant_ledger
      (variant_id, city, target_date, label, entry_ask, hours_to_close, depth_usd, won, net_return,
       stake_usd, engine_version)
    select distinct on (v->>'id', e->>'city', (e->>'date')::date)
           v->>'id',
           e->>'city',
           (e->>'date')::date,
           nullif(e->>'label', ''),
           nullif(e->>'ask', '')::numeric,
           nullif(e->>'htc', '')::numeric,
           nullif(e->>'depth', '')::numeric,
           (e->>'won')::boolean,
           nullif(e->>'net', '')::numeric,
           nullif(v_view->>'stakeUsd', '')::numeric,
           nullif(v_view->'variantsCommon'->>'engineVersion', '')
      from jsonb_array_elements(
             case when jsonb_typeof(v_view->'variants') = 'array' then v_view->'variants' else '[]'::jsonb end
           ) v
      cross join lateral jsonb_array_elements(
             case when jsonb_typeof(v->'entries') = 'array' then v->'entries' else '[]'::jsonb end
           ) e
     where nullif(v->>'id', '') is not null
       and nullif(e->>'city', '') is not null
       and nullif(e->>'date', '') is not null
       and (e->>'won') is not null   -- REALIZED only (an open entry carries won:null)
       and nullif(e->>'net', '') is not null
     order by v->>'id', e->>'city', (e->>'date')::date
    on conflict (variant_id, city, target_date) do nothing;

    get diagnostics v_n = row_count;
    raise notice '0129: seeded % realized entries from the latest cheap_early_panel snapshot', v_n;
  exception when others then
    raise notice '0129: seed from cheap_early_panel skipped (unreadable snapshot: %) — the ledger starts empty', sqlerrm;
  end;
end;
$$;
