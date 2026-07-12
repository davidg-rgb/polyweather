-- 0100_buy_table_cycle_ranges.sql — incremental live-cycle lo/hi aggregates (the permanent 0099 follow-through).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: 0099 restored the console by moving the liveCycles scan into its own fail-soft RPC, but the read is
-- still an on-demand scan over every live cycle's opening_captures rows — 1,299 TOASTed ~15-bucket jsonbs
-- even city-restricted, measured 2.3–7.0s across runs on the saturated Micro (pure detoast/IO variance,
-- plan verified correct: city filter first, index-driven). That flirts with the caller's 8s
-- statement_timeout at peak — the exact class that took the console down (0099 header) and data_freshness
-- before it (C16/0090). The permanent shape: pay O(new rows) at CAPTURE-WRITE time, O(1) at read.
--
-- WHAT:
--   1. buy_table_cycle_ranges — one row per (city, target_date) cycle: running min/max of the LANE'S GATE
--      PRICE (the per-tick predicted-bucket ask — the exact selectBuyTableCandidates pick, 0098/0099
--      semantics), + n_ticks + first/last capture time + the latest seen resolves_at. RLS enabled, no
--      policies (definer-only access, the 0066 idiom). Tiny forever (~45 cities × dates).
--   2. buy_table_cycle_ranges_ingest() + an AFTER INSERT ... FOR EACH STATEMENT trigger (transition table)
--      on opening_captures: folds ONLY the newly-inserted rows into the aggregates (≤ ~45 rows / 5-min tick
--      — negligible). The ENTIRE body is exception-swallowed: the aggregates are display-only, and a broken
--      trigger must NEVER fail the capture writer (the live lane's data source).
--   3. One-time BACKFILL of the currently-displayable window (target_date ≥ current_date − 2) from the
--      existing capture stream — runs once as the migration role (no 8s budget), so the columns carry each
--      live cycle's full history from the moment this applies. Idempotent via ON CONFLICT fold (re-applying
--      on a fresh chain inserts nothing; re-applying on prod would double n_ticks, hence the drop below).
--      A capture tick committing in the trigger-visible/backfill-invisible sliver can be missed once
--      (~one tick of one cycle, display-only min/max — accepted; noted here).
--   4. buy_table_live_cycles() re-stated to READ THE TABLE: target_date ≥ current_date − 2, still trading
--      (max_resolves_at > now()), and not resolved (no market_events winner for that city+date). The
--      panel-city restriction is DROPPED — the read is trivially cheap now, so it returns every live cycle
--      and the panel renders what its rows can show. Envelope { cycles: [...] } unchanged (0081 tripwire).
--
-- Grants: RPC unchanged (service_role + authenticated, self-guards). No cron change (count stays 35).
-- Idempotent-safe: table create-if-not-exists; the backfill TRUNCATEs first (the table is a pure derivation
-- of opening_captures — rebuilding it is always safe).
--
-- Rollback: drop trigger buy_table_cycle_ranges_trg on public.opening_captures;
--           drop function public.buy_table_cycle_ranges_ingest();
--           drop table public.buy_table_cycle_ranges;
--           re-apply 0099 §2 (the scan-based buy_table_live_cycles body).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · the aggregate table
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.buy_table_cycle_ranges (
  city            text        not null,   -- lower(trim(opening_captures.city)) — the capture stream's slug
  target_date     date        not null,   -- station-local cycle date (C-6)
  min_ask         numeric     not null,   -- running min of the per-tick gate price (predicted-bucket ask)
  max_ask         numeric     not null,   -- running max
  n_ticks         bigint      not null,   -- capture ticks that carried a usable gate price
  first_at        timestamptz not null,   -- coverage window start…
  last_at         timestamptz not null,   -- …and end (the panel tooltip's honesty about partial coverage)
  max_resolves_at timestamptz,            -- latest seen resolution clock — the read-side liveness input
  updated_at      timestamptz not null default now(),
  primary key (city, target_date)
);
comment on table public.buy_table_cycle_ranges is
  'Running per-(city, target_date) min/max of the BUY-TABLE lane gate price (predicted-bucket ask), folded '
  'incrementally by the opening_captures insert trigger. Pure derivation of opening_captures — safe to '
  'rebuild any time. Display-only: feeds buy_table_live_cycles() for the /trading lo/hi columns. 0100.';
alter table public.buy_table_cycle_ranges enable row level security;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · the ingest trigger — fold new capture rows into the running aggregates (never break the writer)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_cycle_ranges_ingest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The WHOLE body is exception-swallowed: these aggregates are display-only, and the capture writer is the
  -- live lane's data source — a broken fold must never fail the INSERT that feeds the bot.
  begin
    insert into public.buy_table_cycle_ranges as t
      (city, target_date, min_ask, max_ask, n_ticks, first_at, last_at, max_resolves_at)
    select lower(trim(n.city)), n.target_date,
           min(pb.ask), max(pb.ask), count(*),
           min(n.captured_at), max(n.captured_at), max(n.resolves_at)
    from new_rows n
    cross join lateral (
      -- the tick's pick (0098/0099 semantics — the exact selectBuyTableCandidates mirror): argmax houseProb
      -- among identity-complete buckets; ITS execAsk→bestAsk or nothing (never the next-best bucket's).
      select case when jsonb_typeof(b.value->'execAsk') = 'number' then (b.value->>'execAsk')::numeric
                  when jsonb_typeof(b.value->'bestAsk') = 'number' then (b.value->>'bestAsk')::numeric
             end as ask
      from jsonb_array_elements(n.buckets) b
      where jsonb_typeof(b.value->'houseProb') = 'number'
        and coalesce(b.value->>'conditionId', '') <> ''
        and coalesce(b.value->>'tokenYes', '')    <> ''
      order by (b.value->>'houseProb')::numeric desc
      limit 1
    ) pb
    where n.city is not null and n.target_date is not null
      and n.buckets is not null and jsonb_typeof(n.buckets) = 'array'
      and pb.ask is not null and pb.ask > 0 and pb.ask <= 1
      and coalesce(lower(trim(n.city)), '') <> ''
    group by lower(trim(n.city)), n.target_date
    on conflict (city, target_date) do update set
      min_ask         = least(t.min_ask, excluded.min_ask),
      max_ask         = greatest(t.max_ask, excluded.max_ask),
      n_ticks         = t.n_ticks + excluded.n_ticks,
      first_at        = least(t.first_at, excluded.first_at),
      last_at         = greatest(t.last_at, excluded.last_at),
      max_resolves_at = greatest(t.max_resolves_at, excluded.max_resolves_at),
      updated_at      = now();
  exception when others then
    null; -- swallow — see the header contract
  end;
  return null;
end;
$$;

drop trigger if exists buy_table_cycle_ranges_trg on public.opening_captures;
create trigger buy_table_cycle_ranges_trg
  after insert on public.opening_captures
  referencing new table as new_rows
  for each statement
  execute function public.buy_table_cycle_ranges_ingest();

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · one-time backfill of the displayable window (rebuild-safe: pure derivation, truncate first)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
truncate table public.buy_table_cycle_ranges;
insert into public.buy_table_cycle_ranges
  (city, target_date, min_ask, max_ask, n_ticks, first_at, last_at, max_resolves_at)
select lower(trim(oc.city)), oc.target_date,
       min(pb.ask), max(pb.ask), count(*),
       min(oc.captured_at), max(oc.captured_at), max(oc.resolves_at)
from public.opening_captures oc
cross join lateral (
  select case when jsonb_typeof(b.value->'execAsk') = 'number' then (b.value->>'execAsk')::numeric
              when jsonb_typeof(b.value->'bestAsk') = 'number' then (b.value->>'bestAsk')::numeric
         end as ask
  from jsonb_array_elements(oc.buckets) b
  where jsonb_typeof(b.value->'houseProb') = 'number'
    and coalesce(b.value->>'conditionId', '') <> ''
    and coalesce(b.value->>'tokenYes', '')    <> ''
  order by (b.value->>'houseProb')::numeric desc
  limit 1
) pb
where oc.target_date >= current_date - 2
  and oc.city is not null and coalesce(lower(trim(oc.city)), '') <> ''
  and oc.buckets is not null and jsonb_typeof(oc.buckets) = 'array'
  and pb.ask is not null and pb.ask > 0 and pb.ask <= 1
group by lower(trim(oc.city)), oc.target_date
on conflict (city, target_date) do nothing;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · buy_table_live_cycles() — re-stated to the O(1) table read (envelope byte-identical to 0099)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_live_cycles()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  -- LIVE = recent cycle date, still trading (the latest seen resolution clock in the future), and no
  -- market_events winner recorded for that city+date (the 0098 liveness definition, now over the tiny
  -- pre-aggregated table — no capture scan at read time, ever).
  select jsonb_build_object('cycles', coalesce(jsonb_agg(jsonb_build_object(
    'city',       r.city,
    'targetDate', r.target_date,
    'minAsk',     r.min_ask,
    'maxAsk',     r.max_ask,
    'nTicks',     r.n_ticks,
    'firstAt',    r.first_at,
    'lastAt',     r.last_at
  ) order by r.city, r.target_date), '[]'::jsonb))
  into v
  from public.buy_table_cycle_ranges r
  where r.target_date >= current_date - 2
    and r.max_resolves_at > now()
    and not exists (
      select 1
      from public.market_events e
      join public.cities c on c.id = e.city_id
      where c.slug = r.city
        and e.target_date = r.target_date
        and coalesce(e.poly_resolved_winner_idx, e.winning_bucket_idx) is not null
    );

  return v;
end;
$$;

revoke all on function public.buy_table_live_cycles() from public, anon, authenticated;
grant  execute on function public.buy_table_live_cycles() to service_role, authenticated;
