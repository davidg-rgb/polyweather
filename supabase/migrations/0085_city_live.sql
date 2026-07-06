-- 0085_city_live.sql — CITY-LIVE: continuous winner promotion + operator per-city live-testing rail, staged DARK.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- STAGED-DARK: written but NOT applied to any database — pending operator apply, exactly like 0082/0084.
-- Nothing here places a trade or touches a key. It adds:
--   • city_live_arms      — the operator's per-city Live toggle table (envelope: $5/day/city, max 2 enabled),
--                           BOTH SQL-enforced (a stake CHECK + a max-2 constraint trigger) — the §9R
--                           "$25-ceiling-in-SQL" idiom of 0082, applied to CITY-LIVE.md §0's locked envelope.
--   • city_live_audit     — append-only per-field change trail for the toggle table (F6 idiom of 0082).
--   • city_maker_twin     — the longitudinal MAKER-ENTRY PAPER TWIN (no money, ever): for every sim placement
--                           a simulated maker entry at the lock-hour best_bid, fill-detected conservatively,
--                           graded at $0 maker fee — so the taker-vs-maker differential accrues over time.
--   • city_promotion_board — snapshots of the ranked promotion board (Lane P buildCityPromotionBoard output).
--   • live_orders.strategy — the ALTER that lets the city lane's live rows ('city-taker') sit beside the
--                            maker-exit rows in the ONE order ledger (0082 IS applied on prod — the ALTER is safe).
--
-- CITY-LIVE.md §0 LOCKED DECISIONS encoded here:
--   • The toggle is the authorization — promotion status is ADVISORY. trade_live_preflight('city-taker') does
--     NOT gate on PROMOTED status and does NOT read bot_gate_snapshot (operator sovereignty).
--   • $5/day/city + max 2 enabled — CHECK (stake_usd > 0 and <= 5) + the city_live_arms_max2 constraint trigger.
--   • Boundary unchanged — every RPC self-guards (operator_guard for the operator surface; service_role-only for
--     the runner surface). Claude never trades/keys; staged DARK, operator applies + deploys.
--
-- 0081 TRIPWIRE COMPLIANCE: every public no-arg RETURNS-jsonb function here (city_live_arms_get,
-- city_live_runner_inputs, city_sim_bets_for_promotion, dash_city_live) returns a jsonb OBJECT envelope —
-- NEVER a top-level jsonb array — so supabasePort never misreads it as a RETURNS TABLE row set.
--
-- STRATEGY-AWARE PREFLIGHT (CITY-LIVE.md §2): a new trade_live_preflight(p_strategy text) OVERLOAD carries the
-- 'city-taker' interlock branch; the no-arg trade_live_preflight() is re-stated to DELEGATE to
-- trade_live_preflight('maker-exit'), whose branch reproduces the post-0084 body byte-equivalent in behavior
-- (it reads the shared trade_open_exposure() + trade_today_realized_loss(), preserving every 0084 semantic).
--
-- No cron, no edge fn (the city-paper-trade cron + edge fn already exist from 0070; the handler EXTENSION is
-- deployed by the operator). RLS/grants mirror the 0070/0082 idioms. Cron count stays 29.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · city_live_arms — the operator's per-city Live toggle table (envelope SQL-enforced)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.city_live_arms (
  city_id             uuid primary key references public.cities(id),
  enabled             boolean not null default false,
  -- $5/day/city — the CITY-LIVE.md §0 envelope, code not config (the 0082 §9R-ceiling idiom).
  stake_usd           numeric(10,2) not null default 5 check (stake_usd > 0 and stake_usd <= 5),
  entry_hour_override smallint check (entry_hour_override between 0 and 23),
  promoted_status     text,                                   -- advisory cache of the latest board status (informational)
  enabled_at          timestamptz,                            -- when this arm was last flipped ON
  updated_at          timestamptz not null default now()
);

create or replace trigger trg_city_live_arms_updated_at
  before update on public.city_live_arms
  for each row execute function public.set_updated_at();

-- The max-2 hard stop: a CONSTRAINT TRIGGER (after insert/update, per row) that RAISES if more than two arms
-- are enabled — the structural companion to the $5 CHECK, so the $5/day × 2-city envelope is impossible to
-- exceed whatever an operator toggles. city_live_arm_set surfaces this RAISE text verbatim (never catches it).
create or replace function public.city_live_arms_enforce_max2()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (select count(*) from public.city_live_arms where enabled) > 2 then
    raise exception 'city_live_arms_max2: at most 2 cities may be enabled for live trading at once ($5/day/city envelope)';
  end if;
  return null;
end;
$$;

drop trigger if exists city_live_arms_max2 on public.city_live_arms;
create constraint trigger city_live_arms_max2
  after insert or update on public.city_live_arms
  deferrable initially immediate
  for each row execute function public.city_live_arms_enforce_max2();

alter table public.city_live_arms enable row level security;
drop policy if exists operator_read on public.city_live_arms;
create policy operator_read on public.city_live_arms
  for select to authenticated using (public.is_operator());
grant select on public.city_live_arms to anon, authenticated;
grant all    on public.city_live_arms to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · city_live_audit — append-only per-field change trail (F6 idiom: SELECT + INSERT only)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.city_live_audit (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  city_id   uuid,
  field     text,
  old_value text,
  new_value text
);
create index if not exists city_live_audit_at_idx on public.city_live_audit (at desc);

alter table public.city_live_audit enable row level security;
drop policy if exists operator_read on public.city_live_audit;
create policy operator_read on public.city_live_audit
  for select to authenticated using (public.is_operator());
grant select on public.city_live_audit to anon, authenticated;
-- append-only: SELECT + INSERT only, even for service_role. No role holds UPDATE/DELETE (the 0082 F6 idiom).
revoke all on public.city_live_audit from service_role;
grant select, insert on public.city_live_audit to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · city_maker_twin — the longitudinal MAKER-ENTRY PAPER TWIN (no money). 1:1 with a city_paper_bets
-- row by (city_id, target_date, arm_hour): the maker order rests at the lock-hour best_bid; a later ask that
-- falls to the bid fills it (conservative lower bound — snapshots are event-driven); graded at $0 maker fee.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.city_maker_twin (
  id               uuid primary key default gen_random_uuid(),
  city_id          uuid not null references public.cities(id),
  target_date      date not null,
  arm_hour         smallint not null,
  limit_price      numeric(8,6),                              -- the resting maker bid = lock-hour best_bid
  filled           boolean not null default false,
  fill_detected_at timestamptz,
  stake_usd        numeric(10,2),
  shares           numeric(14,4),                             -- stake / limit_price (shares bought if filled)
  status           text not null default 'pending'
                     check (status in ('pending', 'won', 'lost', 'unfilled')),
  pnl_usd          numeric(10,4),
  created_at       timestamptz not null default now(),
  graded_at        timestamptz,
  unique (city_id, target_date, arm_hour)
);
create index if not exists city_maker_twin_status_idx on public.city_maker_twin (status) where status = 'pending';
create index if not exists city_maker_twin_city_date_idx on public.city_maker_twin (city_id, target_date);

alter table public.city_maker_twin enable row level security;
drop policy if exists operator_read on public.city_maker_twin;
create policy operator_read on public.city_maker_twin
  for select to authenticated using (public.is_operator());
grant select on public.city_maker_twin to anon, authenticated;
grant all    on public.city_maker_twin to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · city_promotion_board — snapshots of the ranked promotion board (Lane P engine output)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.city_promotion_board (
  id          bigserial primary key,
  captured_at timestamptz not null default now(),
  view        jsonb
);
create index if not exists city_promotion_board_captured_idx on public.city_promotion_board (captured_at desc);

alter table public.city_promotion_board enable row level security;
drop policy if exists operator_read on public.city_promotion_board;
create policy operator_read on public.city_promotion_board
  for select to authenticated using (public.is_operator());
grant select on public.city_promotion_board to anon, authenticated;
grant all    on public.city_promotion_board to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · live_orders.strategy — the city lane's live rows sit beside maker-exit in the ONE order ledger.
-- 0082 IS applied on prod (verified 2026-07-06: mode='off', 183 rows) — the ALTER is safe; new rows default
-- 'maker-exit' (the existing lane), the city lane writes 'city-taker'.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.live_orders add column if not exists strategy text not null default 'maker-exit';

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5.5 · bot_order_reserve_intent — DROP + RECREATE with a trailing p_strategy (Lane X cross-lane ask).
-- The 0054 idiom: adding a defaulted param via CREATE OR REPLACE would create an ambiguous 11-arg/12-arg
-- OVERLOAD → PostgREST PGRST203 at call time. So DROP the 0082 11-arg signature and recreate as the single
-- 12-arg-with-default fn writing the new live_orders.strategy column. An omitted p_strategy (every existing
-- maker-exit caller, and the PGlite twin's 11-positional call) coalesces to 'maker-exit' — byte-identical
-- behavior; the city lane passes 'city-taker'. Everything else is byte-identical to 0082 §9's reserve_intent
-- (the F4 CONDITIONAL insert against the (mode, intent_key) partial-unique index → 'reserved' | 'exists').
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists public.bot_order_reserve_intent(
  text, text, text, text, text, text, text, text, numeric, numeric, date
);

create or replace function public.bot_order_reserve_intent(
  p_mode text, p_intent_key text, p_client_order_id text, p_market_id text, p_token_id text,
  p_side text, p_purpose text, p_order_type text, p_price numeric, p_size numeric, p_trade_date date,
  p_strategy text default 'maker-exit'
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.live_orders
    (mode, intent_key, client_order_id, market_id, token_id, side, purpose, order_type, price, size,
     trade_date, strategy)
  values
    (p_mode, p_intent_key, p_client_order_id, p_market_id, p_token_id, p_side, p_purpose, p_order_type,
     p_price, p_size, p_trade_date, coalesce(p_strategy, 'maker-exit'))
  on conflict (mode, intent_key) where status not in ('canceled', 'failed') do nothing
  returning id into v_id;
  return case when v_id is null then 'exists' else 'reserved' end;
end;
$$;

revoke all on function public.bot_order_reserve_intent(
  text, text, text, text, text, text, text, text, numeric, numeric, date, text
) from public, anon, authenticated;
grant  execute on function public.bot_order_reserve_intent(
  text, text, text, text, text, text, text, text, numeric, numeric, date, text
) to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · city_live_arms_get() — the operator read of the toggle table (object envelope, tripwire-safe)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_live_arms_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
    'cityId',            a.city_id,
    'slug',              c.slug,
    'displayName',       c.display_name,
    'icao',              cfg.icao,
    'unit',              c.unit,
    'enabled',           a.enabled,
    'stakeUsd',          a.stake_usd,
    'entryHourOverride', a.entry_hour_override,
    'promotedStatus',    a.promoted_status,
    'enabledAt',         a.enabled_at,
    'updatedAt',         a.updated_at
  ) order by c.slug), '[]'::jsonb)) into v
  from public.city_live_arms a
  join public.cities c on c.id = a.city_id
  left join public.city_sim_config cfg on cfg.city_id = a.city_id;
  return v;
end;
$$;

revoke all on function public.city_live_arms_get() from public, anon, authenticated;
grant  execute on function public.city_live_arms_get() to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 7 · city_live_arm_set(...) — the operator-guarded per-city toggle write (self-guards, audits per field)
-- The max-2 constraint trigger provides the hard stop (its RAISE propagates). Returns { row: {…} }.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_live_arm_set(
  p_city_id    uuid,
  p_enabled    boolean,
  p_stake_usd  numeric,
  p_entry_hour smallint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old        public.city_live_arms;
  v_was        boolean;
  v_enabled_at timestamptz;
  v jsonb;
begin
  perform public.operator_guard();

  select * into v_old from public.city_live_arms where city_id = p_city_id;
  v_was := coalesce(v_old.enabled, false);

  -- enabled_at: stamp when flipping ON (and it was not on); clear when flipping OFF; keep otherwise.
  v_enabled_at := case
    when p_enabled and not v_was then now()
    when not p_enabled           then null
    else v_old.enabled_at
  end;

  insert into public.city_live_arms (city_id, enabled, stake_usd, entry_hour_override, enabled_at)
  values (p_city_id, p_enabled, p_stake_usd, p_entry_hour, v_enabled_at)
  on conflict (city_id) do update set
    enabled             = excluded.enabled,
    stake_usd           = excluded.stake_usd,
    entry_hour_override = excluded.entry_hour_override,
    enabled_at          = excluded.enabled_at;

  -- audit per CHANGED field (old row may not exist → old_value null).
  if v_old.city_id is null or v_old.enabled is distinct from p_enabled then
    insert into public.city_live_audit (city_id, field, old_value, new_value)
    values (p_city_id, 'enabled', v_old.enabled::text, p_enabled::text);
  end if;
  if v_old.city_id is null or v_old.stake_usd is distinct from p_stake_usd then
    insert into public.city_live_audit (city_id, field, old_value, new_value)
    values (p_city_id, 'stake_usd', v_old.stake_usd::text, p_stake_usd::text);
  end if;
  if v_old.city_id is null or v_old.entry_hour_override is distinct from p_entry_hour then
    insert into public.city_live_audit (city_id, field, old_value, new_value)
    values (p_city_id, 'entry_hour_override', v_old.entry_hour_override::text, p_entry_hour::text);
  end if;

  select jsonb_build_object('row', to_jsonb(a)) into v from public.city_live_arms a where a.city_id = p_city_id;
  return v;
end;
$$;

revoke all on function public.city_live_arm_set(uuid, boolean, numeric, smallint) from public, anon, authenticated;
grant  execute on function public.city_live_arm_set(uuid, boolean, numeric, smallint) to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 8 · city_live_runner_inputs() — the daemon's read of ENABLED arms (service-role only, object envelope).
-- entryHour = the override if set, else the latest promotion board's recommendedHour for the city (null → the
-- runner skips the city). No promotion/gate check here — the toggle is the authorization (CITY-LIVE.md §0).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_live_runner_inputs()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v          jsonb;
  v_board    jsonb;
begin
  select view->'rows' into v_board
  from public.city_promotion_board
  order by captured_at desc, id desc
  limit 1;

  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
    'cityId',    a.city_id,
    'slug',      c.slug,
    'icao',      cfg.icao,
    'tz',        cfg.tz,
    'unit',      c.unit,
    'enabled',   a.enabled,
    'stakeUsd',  a.stake_usd,
    'entryHour', coalesce(
      a.entry_hour_override,
      (select (r->>'recommendedHour')::smallint
       from jsonb_array_elements(coalesce(v_board, '[]'::jsonb)) r
       where r->>'cityId' = a.city_id::text
       limit 1)
    )
  ) order by c.slug), '[]'::jsonb)) into v
  from public.city_live_arms a
  join public.cities c on c.id = a.city_id
  join public.city_sim_config cfg on cfg.city_id = a.city_id
  where a.enabled;
  return v;
end;
$$;

revoke all on function public.city_live_runner_inputs() from public, anon, authenticated;
grant  execute on function public.city_live_runner_inputs() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 9 · city_sim_bets_for_promotion() — the promotion engine's INPUT (service-role only, object envelope).
-- Per enrolled (active) city: its graded city_paper_bets in the Lane P bet shape + prevStatus from the latest
-- board (for DEMOTED hysteresis). The Edge handler maps this straight to CityPromotionInput.cities.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_sim_bets_for_promotion()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v       jsonb;
  v_board jsonb;
begin
  select view->'rows' into v_board
  from public.city_promotion_board
  order by captured_at desc, id desc
  limit 1;

  select jsonb_build_object('rows', coalesce(jsonb_agg(city_obj order by slug), '[]'::jsonb)) into v
  from (
    select cfg.slug, jsonb_build_object(
      'cityId', cfg.city_id,
      'slug',   cfg.slug,
      'icao',   cfg.icao,
      'unit',   c.unit,
      'prevStatus', (
        select r->>'status'
        from jsonb_array_elements(coalesce(v_board, '[]'::jsonb)) r
        where r->>'cityId' = cfg.city_id::text
        limit 1
      ),
      'bets', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'won',        b.won,
          'ask',        b.ask,
          'targetDate', b.target_date,
          'armHour',    b.arm_hour,
          'pnlUsd',     b.pnl_usd,
          'stakeUsd',   b.stake_usd
        ) order by b.target_date, b.arm_hour), '[]'::jsonb)
        from public.city_paper_bets b
        where b.city_id = cfg.city_id and b.status <> 'pending'
      )
    ) as city_obj
    from public.city_sim_config cfg
    join public.cities c on c.id = cfg.city_id
    where cfg.active
  ) s;
  return v;
end;
$$;

revoke all on function public.city_sim_bets_for_promotion() from public, anon, authenticated;
grant  execute on function public.city_sim_bets_for_promotion() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 10 · city_promotion_record(p_view jsonb) — persist a board snapshot; prune > 90d; refresh the arms'
-- advisory promoted_status cache from the new board. service-role only. Returns the new row id (bigint).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.city_promotion_record(p_view jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.city_promotion_board (view) values (p_view) returning id into v_id;
  delete from public.city_promotion_board where captured_at < now() - interval '90 days';
  -- advisory cache: reflect the latest board's per-city status onto the toggle table (0 rows if no arms yet).
  update public.city_live_arms a set promoted_status = r.status
  from (
    select (e->>'cityId')::uuid as city_id, e->>'status' as status
    from jsonb_array_elements(coalesce(p_view->'rows', '[]'::jsonb)) e
  ) r
  where a.city_id = r.city_id and a.promoted_status is distinct from r.status;
  return v_id;
end;
$$;

revoke all on function public.city_promotion_record(jsonb) from public, anon, authenticated;
grant  execute on function public.city_promotion_record(jsonb) to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 11 · the MAKER-TWIN mechanics — three service-role RPCs the city-paper-trade handler calls (the
-- DbPort is rpc-only, so the twin place/fill-detect/grade steps are SQL helpers). All internal.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- 11.1 place — for each placement row (the SAME PlacementRow[] the taker bet locked), rest a maker twin at the
-- lock-hour best_bid (latest in-window bid, mirroring the 0048 in-lock-hour ask guard). Skip if no bid.
-- Idempotent on (city_id, target_date, arm_hour). Returns the count inserted.
create or replace function public.city_maker_twin_place(p_city_id uuid, p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz    text;
  v_count int;
begin
  select tz into v_tz from public.city_sim_config where city_id = p_city_id;
  if v_tz is null then
    return 0;  -- no config for this city
  end if;

  insert into public.city_maker_twin (city_id, target_date, arm_hour, limit_price, stake_usd, shares)
  select
    p_city_id,
    (r->>'targetDate')::date,
    (r->>'armHour')::smallint,
    bid.best_bid,
    (r->>'stakeUsd')::numeric,
    round((r->>'stakeUsd')::numeric / bid.best_bid, 4)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  cross join lateral (
    -- the lock-hour best_bid on our predicted bucket: latest in-window [lock, asof) bid (0048 idiom, bid side).
    select ms.best_bid
    from public.market_buckets mb
    join public.market_snapshots ms on ms.bucket_id = mb.id
    where mb.event_id = (r->>'eventId')::uuid
      and mb.bucket_idx = (r->>'bucketIdx')::smallint
      and ms.best_bid is not null
      and ms.captured_at >= ((r->>'targetDate')::timestamp + make_interval(hours => (r->>'armHour')::int))     at time zone v_tz
      and ms.captured_at <  ((r->>'targetDate')::timestamp + make_interval(hours => (r->>'armHour')::int + 1)) at time zone v_tz
    order by ms.captured_at desc
    limit 1
  ) bid
  where bid.best_bid is not null and bid.best_bid > 0
  on conflict (city_id, target_date, arm_hour) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.city_maker_twin_place(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.city_maker_twin_place(uuid, jsonb) to service_role;

-- 11.2 detect fills — pending, unfilled twins where a LATER snapshot (captured after the entry lock window)
-- on the bucket dropped its best_ask to ≤ the resting limit. Conservative lower bound (event-driven snapshots).
-- fill_detected_at = the earliest such snapshot. Returns the count filled this tick.
create or replace function public.city_maker_twin_detect_fills()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  update public.city_maker_twin t
  set filled = true, fill_detected_at = sub.fill_at
  from (
    select t2.id, min(ms.captured_at) as fill_at
    from public.city_maker_twin t2
    join public.city_paper_bets b
      on b.city_id = t2.city_id and b.target_date = t2.target_date and b.arm_hour = t2.arm_hour
    join public.city_sim_config cfg on cfg.city_id = t2.city_id
    join public.market_buckets mb on mb.event_id = b.event_id and mb.bucket_idx = b.bucket_idx
    join public.market_snapshots ms on ms.bucket_id = mb.id
    where t2.status = 'pending' and t2.filled = false and t2.limit_price is not null
      and ms.best_ask is not null and ms.best_ask <= t2.limit_price
      and ms.captured_at >= (t2.target_date::timestamp + make_interval(hours => t2.arm_hour + 1)) at time zone cfg.tz
    group by t2.id
  ) sub
  where t.id = sub.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.city_maker_twin_detect_fills() from public, anon, authenticated;
grant  execute on function public.city_maker_twin_detect_fills() to service_role;

-- 11.3 grade — settle twins whose bet's observation finalized: a FILLED twin resolves won/lost at $0 maker fee
-- (won ⇒ shares×(1−limit); lost ⇒ −stake); an UNFILLED twin at resolution → status 'unfilled', pnl 0.
-- Returns the count graded this tick.
create or replace function public.city_maker_twin_grade()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int := 0; v_n int;
begin
  -- FILLED twins whose observation finalized → won/lost.
  with graded as (
    select t.id,
           (b.bucket_idx = w.winner_idx) as won,
           t.shares, t.limit_price, t.stake_usd
    from public.city_maker_twin t
    join public.city_paper_bets b
      on b.city_id = t.city_id and b.target_date = t.target_date and b.arm_hour = t.arm_hour
    join public.observations o
      on o.icao = b.icao and o.date_local = b.target_date and o.finalized_at is not null
    join lateral (
      select mb.bucket_idx as winner_idx
      from public.market_buckets mb
      where mb.event_id = b.event_id
        and (mb.low_native  is null or o.tmax_wu_native >= mb.low_native)
        and (mb.high_native is null or o.tmax_wu_native <= mb.high_native)
      limit 1
    ) w on true
    where t.status = 'pending' and t.filled = true
  )
  update public.city_maker_twin t set
    status    = case when g.won then 'won' else 'lost' end,
    pnl_usd   = case when g.won then round(g.shares * (1 - g.limit_price), 4) else -g.stake_usd end,
    graded_at = now()
  from graded g where t.id = g.id;
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  -- UNFILLED twins whose observation finalized (the market resolved, the maker order never filled) → 'unfilled'.
  with resolved as (
    select t.id
    from public.city_maker_twin t
    join public.city_paper_bets b
      on b.city_id = t.city_id and b.target_date = t.target_date and b.arm_hour = t.arm_hour
    join public.observations o
      on o.icao = b.icao and o.date_local = b.target_date and o.finalized_at is not null
    where t.status = 'pending' and t.filled = false
  )
  update public.city_maker_twin t set status = 'unfilled', pnl_usd = 0, graded_at = now()
  from resolved r where t.id = r.id;
  get diagnostics v_n = row_count; v_count := v_count + v_n;

  return v_count;
end;
$$;

revoke all on function public.city_maker_twin_grade() from public, anon, authenticated;
grant  execute on function public.city_maker_twin_grade() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 12 · dash_city_live() — the /trading winners board + arms table + twin differential (operator read).
-- Object envelope { arms, board, twin } (tripwire-safe). board = the latest board snapshot; twin = per-city
-- taker-vs-maker aggregate (city_paper_bets ⋈ city_maker_twin).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_city_live()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  select jsonb_build_object(
    'generatedAt', now(),
    'arms', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'cityId',            a.city_id,
        'slug',              c.slug,
        'displayName',       c.display_name,
        'icao',              cfg.icao,
        'unit',              c.unit,
        'enabled',           a.enabled,
        'stakeUsd',          a.stake_usd,
        'entryHourOverride', a.entry_hour_override,
        'promotedStatus',    a.promoted_status,
        'enabledAt',         a.enabled_at,
        'updatedAt',         a.updated_at
      ) order by c.slug), '[]'::jsonb)
      from public.city_live_arms a
      join public.cities c on c.id = a.city_id
      left join public.city_sim_config cfg on cfg.city_id = a.city_id
    ),
    'board', (
      select view from public.city_promotion_board order by captured_at desc, id desc limit 1
    ),
    'twin', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'cityId',         t.city_id,
        'slug',           c.slug,
        'displayName',    c.display_name,
        'nPlacements',    t.n_placements,
        'twinFilledFrac', case when t.n_placements > 0 then round(t.n_filled::numeric / t.n_placements, 4) end,
        'takerPnlUsd',    coalesce(tk.taker_pnl, 0),
        'makerTwinPnlUsd', coalesce(t.maker_pnl, 0)
      ) order by c.slug), '[]'::jsonb)
      from (
        select mt.city_id,
               count(*)                                          as n_placements,
               count(*) filter (where mt.filled)                 as n_filled,
               coalesce(sum(mt.pnl_usd) filter (where mt.status in ('won', 'lost')), 0) as maker_pnl
        from public.city_maker_twin mt
        group by mt.city_id
      ) t
      join public.cities c on c.id = t.city_id
      left join lateral (
        select coalesce(sum(b.pnl_usd), 0) as taker_pnl
        from public.city_paper_bets b
        where b.city_id = t.city_id and b.status <> 'pending'
      ) tk on true
    )
  ) into v;

  return v;
end;
$$;

revoke all on function public.dash_city_live() from public, anon, authenticated;
grant  execute on function public.dash_city_live() to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 13 · trade_live_preflight(p_strategy text) — the STRATEGY-AWARE interlock overload.
--   'maker-exit' (and the no-arg delegator) → the post-0084 body, byte-equivalent (shared trade_open_exposure()
--                 + the N1 daily-loss kill + the forward-paper-PASS-or-override gate).
--   'city-taker' → CITY-LIVE.md §2: mode='live', run window not expired, the N1 daily-loss kill, ≥1 enabled
--                 city arm, every enabled stake ≤ 5, ≤ 2 enabled. NO bot_gate_snapshot check, NO promotion
--                 check (advisory by operator decision).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_live_preflight(p_strategy text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg              public.trade_config;
  v_reasons          text[] := '{}';
  v_gate_pass        boolean;
  v_override_reason  text;
  v_override_expires timestamptz;
  v_override         boolean;
  v_today_loss       numeric;
  v_kill_basis       numeric;
  v_expo             jsonb;
  v_open_expo        numeric;
  v_per_market       jsonb;
  v_n_enabled        int;
  v_max_stake        numeric;
begin
  select * into v_cfg from public.trade_config where id = 1;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'reasons', jsonb_build_array('trade_config singleton row missing'),
      'checks', jsonb_build_object()
    );
  end if;

  -- ─────────────────────────────────────────────────────────────────────────────────────────────────────
  -- CITY-TAKER branch (CITY-LIVE.md §2). Does NOT read bot_gate_snapshot; does NOT check promotion status.
  -- ─────────────────────────────────────────────────────────────────────────────────────────────────────
  if p_strategy = 'city-taker' then
    -- (1) mode must be live
    if v_cfg.mode is distinct from 'live' then
      v_reasons := v_reasons || format('mode is %L — not ''live''', v_cfg.mode);
    end if;
    -- (2) run-window day-cap (0075 idiom). Bare literals cast ::text so `text[] || …` is array-append.
    if v_cfg.active_until is null then
      v_reasons := v_reasons || 'active_until not set — the run window is off'::text;
    elsif v_cfg.active_until < current_date then
      v_reasons := v_reasons ||
        format('active_until %s is before today %s — run window expired', v_cfg.active_until, current_date);
    end if;
    -- (3) N1 daily-loss kill (the SHARED realized-at-sell-time definition; dry-run never counts).
    v_today_loss := public.trade_today_realized_loss();
    v_kill_basis := v_cfg.daily_loss_kill_frac * v_cfg.total_concurrent_cap_usd;
    if v_today_loss >= v_cfg.daily_loss_kill_usd then
      v_reasons := v_reasons || format(
        'daily-loss kill: today''s realized live loss $%s >= daily_loss_kill_usd $%s',
        v_today_loss, v_cfg.daily_loss_kill_usd
      );
    end if;
    if v_today_loss >= v_kill_basis then
      v_reasons := v_reasons || format(
        'daily-loss kill: today''s realized live loss $%s >= daily_loss_kill_frac %s x total_concurrent_cap_usd basis $%s',
        v_today_loss, v_cfg.daily_loss_kill_frac, v_kill_basis
      );
    end if;
    -- (4/5/6) the city-arm envelope — ≥1 enabled, every enabled stake ≤ 5, ≤ 2 enabled (defense-in-depth
    -- over the SQL CHECK + max-2 constraint trigger).
    select count(*), coalesce(max(stake_usd), 0) into v_n_enabled, v_max_stake
    from public.city_live_arms where enabled;
    if v_n_enabled = 0 then
      v_reasons := v_reasons || 'no enabled city arm — nothing to trade (toggle a city on /trading)'::text;
    end if;
    if v_max_stake > 5 then
      v_reasons := v_reasons ||
        format('an enabled city arm stake $%s exceeds the $5/city envelope', v_max_stake);
    end if;
    if v_n_enabled > 2 then
      v_reasons := v_reasons || format('%s cities enabled — exceeds the max 2', v_n_enabled);
    end if;

    return jsonb_build_object(
      'ok', cardinality(v_reasons) = 0,
      'reasons', to_jsonb(v_reasons),
      'checks', jsonb_build_object(
        'strategy',                  'city-taker',
        'mode',                      v_cfg.mode,
        'activeUntil',               v_cfg.active_until,
        'todayLossUsd',              v_today_loss,
        'lossWindowStart',           date_trunc('day', now()),
        'dailyLossKillUsd',          v_cfg.daily_loss_kill_usd,
        'dailyLossKillFracBasisUsd', v_kill_basis,
        'nEnabledArms',              v_n_enabled,
        'maxEnabledStakeUsd',        v_max_stake,
        'enabledCities', (
          select coalesce(jsonb_agg(city_id order by city_id), '[]'::jsonb)
          from public.city_live_arms where enabled
        )
      )
    );
  end if;

  -- ─────────────────────────────────────────────────────────────────────────────────────────────────────
  -- MAKER-EXIT branch (default) — byte-equivalent to the post-0084 no-arg body. See 0082/0084 for the contract.
  -- ─────────────────────────────────────────────────────────────────────────────────────────────────────
  -- (1) mode must be live
  if v_cfg.mode is distinct from 'live' then
    v_reasons := v_reasons || format('mode is %L — not ''live''', v_cfg.mode);
  end if;

  -- (2) run-window day-cap (0075 idiom).
  if v_cfg.active_until is null then
    v_reasons := v_reasons || 'active_until not set — the run window is off'::text;
  elsif v_cfg.active_until < current_date then
    v_reasons := v_reasons ||
      format('active_until %s is before today %s — run window expired', v_cfg.active_until, current_date);
  end if;

  -- (3) stake within the per-position cap (the §9R $25 ceiling is a table CHECK; this is the softer ordering)
  if v_cfg.stake_per_buy_usd > v_cfg.per_position_cap_usd then
    v_reasons := v_reasons || format(
      'stake_per_buy_usd %s exceeds per_position_cap_usd %s',
      v_cfg.stake_per_buy_usd, v_cfg.per_position_cap_usd
    );
  end if;

  -- (4a) the FORWARD paper gate of record (source='forward').
  select (label = 'PASS') into v_gate_pass
  from public.bot_gate_snapshot
  where mode = 'paper' and source = 'forward'
  order by computed_at desc, id desc
  limit 1;
  v_gate_pass := coalesce(v_gate_pass, false);

  -- (4b) OR an ACTIVE (unexpired) operator override row (F1)
  select reason, expires_at into v_override_reason, v_override_expires
  from public.trade_gate_override
  where expires_at > now()
  order by created_at desc, id desc
  limit 1;
  v_override := v_override_reason is not null;

  if not v_gate_pass and not v_override then
    v_reasons := v_reasons ||
      'no PASS forward paper gate (bot_gate_snapshot mode=paper/source=forward) and no ACTIVE trade_gate_override row'::text;
  end if;

  -- (5) F2/N1 daily-loss kill — the SHARED realized-at-sell-time definition (0082 §4.5; dry-run never counts).
  v_today_loss := public.trade_today_realized_loss();

  v_kill_basis := v_cfg.daily_loss_kill_frac * v_cfg.total_concurrent_cap_usd;
  if v_today_loss >= v_cfg.daily_loss_kill_usd then
    v_reasons := v_reasons || format(
      'daily-loss kill: today''s realized live loss $%s >= daily_loss_kill_usd $%s',
      v_today_loss, v_cfg.daily_loss_kill_usd
    );
  end if;
  if v_today_loss >= v_kill_basis then
    v_reasons := v_reasons || format(
      'daily-loss kill: today''s realized live loss $%s >= daily_loss_kill_frac %s x total_concurrent_cap_usd basis $%s',
      v_today_loss, v_cfg.daily_loss_kill_frac, v_kill_basis
    );
  end if;

  -- open LIVE buy-side exposure — the SHARED trade_open_exposure() (0084 #7).
  v_expo       := public.trade_open_exposure();
  v_open_expo  := coalesce((v_expo->>'total')::numeric, 0);
  v_per_market := coalesce(v_expo->'perMarket', '{}'::jsonb);

  return jsonb_build_object(
    'ok', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'checks', jsonb_build_object(
      'mode',                      v_cfg.mode,
      'activeUntil',               v_cfg.active_until,
      'stakePerBuyUsd',            v_cfg.stake_per_buy_usd,
      'perPositionCapUsd',         v_cfg.per_position_cap_usd,
      'perMarketCapUsd',           v_cfg.per_market_cap_usd,
      'totalConcurrentCapUsd',     v_cfg.total_concurrent_cap_usd,
      'gatePass',                  v_gate_pass,
      'override',                  v_override,
      'overrideReason',            v_override_reason,
      'overrideExpiresAt',         v_override_expires,
      'todayLossUsd',              v_today_loss,
      'lossWindowStart',           date_trunc('day', now()),
      'dailyLossKillUsd',          v_cfg.daily_loss_kill_usd,
      'dailyLossKillFracBasisUsd', v_kill_basis,
      'openExposureUsd',           v_open_expo,
      'perMarketExposureUsd',      v_per_market
    )
  );
end;
$$;

revoke all on function public.trade_live_preflight(text) from public, anon, authenticated;
grant  execute on function public.trade_live_preflight(text) to service_role;

-- The no-arg fn now DELEGATES to the 'maker-exit' branch (CITY-LIVE.md §2 — "keep the no-arg fn delegating").
-- CREATE OR REPLACE keeps the () signature + jsonb return; every existing no-arg caller (dash_trading,
-- packages/trading preflightLive, the trading-hardening twin) sees the identical result.
create or replace function public.trade_live_preflight()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select public.trade_live_preflight('maker-exit');
$$;

revoke all on function public.trade_live_preflight() from public, anon, authenticated;
grant  execute on function public.trade_live_preflight() to service_role;
