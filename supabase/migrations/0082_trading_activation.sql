-- 0082_trading_activation.sql — the TRADING ACTIVATION + RISK CONSOLE, staged DARK.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- STAGED-DARK: this migration is WRITTEN but NOT applied to any database. It creates the config surface, the
-- risk caps, the order/fill ledger, the operator-guarded write path, the read dashboard, the live-mode
-- INTERLOCK, and the T1 order-ledger RPC contract for the opening-convergence bot's eventual autonomous
-- buy/sell rail (CLAUDE.md scoped exception, OPENING-CONVERGENCE-HANDOFF.md §9R). Seeded with mode='off' —
-- nothing here places a trade or touches a key. The runner (T1's lane) writes live_orders/live_fills through
-- the six bot_order_* RPCs and calls trade_live_preflight() before ever entering live mode. NO CAPITAL until a
-- frozen paper PASS: the interlock encodes that gate in SQL.
--
-- TABLE-SHAPE CHOICE (single-row typed table, NOT the key/value `config` idiom) — justified:
--   1. The §9R HARD CEILING (stake_per_buy_usd ≤ 25 AND per_position_cap_usd ≤ 25) MUST be a CHECK constraint —
--      "the §9R ceiling is code, not config". A key/value text table (`config`) cannot express a cross-column
--      CHECK; each row is independent and untyped. A single-row typed table can.
--   2. trade_config_audit captures the WHOLE-config old/new as jsonb per change via a row trigger — natural for
--      one typed row (to_jsonb(OLD)/to_jsonb(NEW)); the existing config_audit is per-key old/new TEXT, a poorer
--      fit for "old/new jsonb".
--   3. active_until (date day-cap, the 0075 idiom) and city_allowlist (nullable text[] = all) are TYPED columns,
--      not stringly-typed config values.
--   The singleton is enforced by `id smallint primary key default 1 check (id = 1)` — the repo already uses
--   single-row/enumerated-key control tables (bot_bankroll keyed by mode, whale_settings).
--
-- 0081 TRIPWIRE COMPLIANCE (CITY-SIM-PLACEMENT-FIX §5): every public no-arg RETURNS-jsonb function here
-- (trade_config_get, trade_live_preflight, dash_trading, trade_gate_override_clear) returns a jsonb OBJECT
-- envelope — NEVER a top-level jsonb array — so supabasePort never misreads it as a RETURNS TABLE row set.
-- migrations.test.ts's tripwire enumerates them all and asserts object/scalar, never array.
--
-- LIVE GATE = FORWARD PAPER, NOT BACKTEST (intentional scoping, flagged): the preflight's gate branch reads the
-- latest bot_gate_snapshot with mode='paper' AND source='forward'. source='forward' is deliberate —
-- bot_gate_snapshot.source's own CHECK comment is "the capital gate reads forward only (F2-r10)", and a backtest
-- PASS must never unlock capital. A test proves a source='backtest' PASS does NOT satisfy the interlock.
--
-- THE T1 ORDER-LEDGER CONTRACT (packages/trading order-ledger.ts, T1 commit 683e7ff): the seven bot_order_*
-- RPCs below implement the `OrderLedger` port + the reconcile sweep over live_orders/live_fills (T1's doc
-- calls the table `bot_orders`; the RPC names abstract the table away). Lifecycle: intent → placed → partial → filled, with canceled/failed
-- TERMINAL. The load-bearing idempotency guarantee (F4) is the PARTIAL-UNIQUE index
--   unique (mode, intent_key) WHERE status NOT IN ('canceled','failed')
-- — bot_order_reserve_intent is a CONDITIONAL insert against it ('reserved' | 'exists'): a retry or a
-- concurrent placer with the same (mode, intent) gets 'exists', NEVER a second live order. A canceled/failed
-- intent FREES its key (re-reservable — the reprice path); dry-run and live are DISTINCT intents by
-- construction (mode is part of the key). The venue's 'expired' order outcome FOLDS INTO 'canceled' (terminal,
-- frees the key) — there is deliberately no separate 'expired' status (F9).
--
-- DRY-RUN ROWS ARE RECORDED (design decision settled with T1): dry-run intents land in live_orders with
-- mode='dry-run' (T1's dry-run branch writes the ledger; the shadow-diff harness reads them there). Therefore
-- EVERY cap/loss/exposure figure in trade_live_preflight() and dash_trading() filters mode='live' — dry-run
-- rows never count toward caps, losses, or concurrent exposure.
--
-- THE RUNNER'S PER-PLACEMENT CAP CONTRACT (F2): trade_live_preflight().checks carries today's realized LIVE
-- loss plus the current open LIVE buy-side exposure (total + per-market, over status intent/placed/partial —
-- an unfilled reservation is committed capital) so the runner enforces, from ONE call per placement:
--   • per-market:        checks.perMarketExposureUsd[marketId] + stake ≤ per_market_cap_usd
--   • total-concurrent:  checks.openExposureUsd + stake ≤ total_concurrent_cap_usd
-- The DAILY-LOSS KILL blocks the preflight itself when today's realized live loss ≥ daily_loss_kill_usd OR
-- ≥ daily_loss_kill_frac × total_concurrent_cap_usd — the FRACTION'S BASIS IS total_concurrent_cap_usd (the
-- bot's deployable-bankroll ceiling; this surface has no separate bot-bankroll config, so the concurrent cap is
-- the honest denominator).
--
-- THE DAILY-LOSS DEFINITION (N1 — REALIZED P&L ATTRIBUTED AT SELL TIME; one shared implementation): the naive
-- within-day net-fill-cashflow measure (buys+fees−sells over today's fills, clamped) has two proven failure
-- modes — a cross-midnight losing round-trip is NEVER captured in any single day (the buy lands in D, the sell
-- in D+1, and D+1's clamp hides it), and an ordinary buy-heavy healthy day counts its full open cost as
-- "loss". The definition is therefore REALIZED P&L at SELL time: a position is (mode, market_id, token_id);
-- BUY fills accumulate cost (exact marginal notionals — N2 below); each SELL fill realizes
--   realized_delta = its proceeds − (average cost basis at that fill's time × size sold) − its attributed fee
-- and  todayLossUsd = greatest(0, −Σ realized_delta over SELL fills with filled_at ≥ date_trunc('day', now()))
--                     + buy-side fees paid inside the window.
-- The window start (UTC midnight) is surfaced verbatim as checks.lossWindowStart. EXACT for the strategy's
-- one-entry-one-exit shape; APPROXIMATION for re-buys: the basis is the lifetime average cost over ALL prior
-- BUY fills of the position, so a re-entry after a full close averages across the closed lots too (it never
-- hides a realized loss, it can only smear it between lots). ONE shared implementation —
-- public.trade_today_realized_loss() (SECTION 4.5) — is THE definition for BOTH consumers:
-- trade_live_preflight §5 AND dash_trading.today.lossUsd call it; neither carries its own expression.
-- openExposureUsd is untouched: it stays cost-basis-of-open (price × size over open BUY rows).
--
-- FILL-CASH EXACTNESS (N2): live_fills carries fill_notional = the MARGINAL notional of each delta,
--   marginal = (p_avg_price × p_size_matched) − (prev_avg × prev_size),
-- so Σ fill_notional over a position's fills IS the true cash, bit-exact in numeric. fill_price =
-- round(marginal/delta, 6) is stored for display only — marginal/delta is a non-terminating decimal in general
-- (the lens's own example: 0.98/3), so NO finite-precision fill_price can make Σ(fill_price × fill_size)
-- exact; every money aggregation here reads fill_notional, never fill_price × fill_size.
--
-- AUDIT NOTE (F7): trade_config_audit.changed_by records the EFFECTIVE ROLE at write time (current_user — e.g.
-- 'service_role' for direct writes, the definer-function owner for operator RPC writes), not a person.
-- Single-operator project.
--
-- No cron, no edge fn: this is schema + RPCs only (cron count stays 29). RLS/grants mirror the 0070 idiom.

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · trade_config — the single-row risk/mode control surface (seeded DARK: mode='off')
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.trade_config (
  id                       smallint primary key default 1 check (id = 1),            -- singleton guard
  mode                     text not null default 'off' check (mode in ('off', 'dry-run', 'live')),
  stake_per_buy_usd        numeric(10,2) not null default 10,
  per_position_cap_usd     numeric(10,2) not null default 25,
  per_market_cap_usd       numeric(10,2) not null default 40,
  total_concurrent_cap_usd numeric(10,2) not null default 100,
  daily_loss_kill_usd      numeric(10,2) not null default 30,
  daily_loss_kill_frac     numeric(5,4)  not null default 0.25,
  city_allowlist           text[],                                                   -- null = all cities enrolled
  active_until             date,                                                     -- 0075 day-cap; null = run window off
  updated_at               timestamptz not null default now(),
  -- §9R HARD CEILING — code, not config: the per-buy stake and per-position cap can NEVER exceed $25, whatever
  -- an operator types. This is the structural spend guardrail that outranks every config value.
  constraint trade_config_ceiling check (stake_per_buy_usd <= 25 and per_position_cap_usd <= 25),
  -- sanity floors: positive money everywhere, ordered caps, a probability-shaped kill fraction.
  constraint trade_config_positive check (
    stake_per_buy_usd > 0 and per_position_cap_usd > 0 and per_market_cap_usd > 0
    and total_concurrent_cap_usd > 0 and daily_loss_kill_usd > 0
  ),
  constraint trade_config_frac check (daily_loss_kill_frac >= 0 and daily_loss_kill_frac <= 1)
);

create or replace trigger trg_trade_config_updated_at
  before update on public.trade_config
  for each row execute function public.set_updated_at();

-- NB: the singleton is seeded in SECTION 2, AFTER the audit trigger exists, so the row's BIRTH is audited too.

alter table public.trade_config enable row level security;
drop policy if exists operator_read on public.trade_config;
create policy operator_read on public.trade_config
  for select to authenticated using (public.is_operator());
grant select on public.trade_config to anon, authenticated;
grant all    on public.trade_config to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · trade_config_audit — append-only whole-config change trail (old/new jsonb via trigger)
-- APPEND-ONLY IS ENFORCED (F6): UPDATE/DELETE are granted to NO role — service_role holds SELECT + INSERT only
-- (INSERT is required for the trigger path when service_role writes trade_config directly; the trigger runs as
-- the invoking role). changed_by = the effective role, not a person (F7 header note above).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.trade_config_audit (
  id         bigint generated always as identity primary key,
  old_value  jsonb,                                            -- null on the seed INSERT
  new_value  jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by text not null default current_user
);
create index if not exists trade_config_audit_changed_idx on public.trade_config_audit (changed_at desc);

-- The trigger runs as the writer's effective role (SECURITY INVOKER) so changed_by reflects who wrote:
-- service_role for a direct write, the operator-guarded definer's owner for a trade_config_set() write.
create or replace function public.trade_config_audit_capture()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.trade_config_audit (old_value, new_value, changed_by)
  values (
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    current_user
  );
  return new;
end;
$$;

create or replace trigger trg_trade_config_audit
  after insert or update on public.trade_config
  for each row execute function public.trade_config_audit_capture();

-- seed the singleton DARK (mode 'off', defaults), NOW that the audit trigger exists so the INSERT is captured
-- (old_value null, new_value the born row). on conflict → idempotent under the migrations double-apply test.
insert into public.trade_config (id) values (1) on conflict (id) do nothing;

alter table public.trade_config_audit enable row level security;
drop policy if exists operator_read on public.trade_config_audit;
create policy operator_read on public.trade_config_audit
  for select to authenticated using (public.is_operator());
grant select on public.trade_config_audit to anon, authenticated;
-- F6: append-only enforced by grants — SELECT + INSERT only, even for service_role. No role holds UPDATE/DELETE.
revoke all on public.trade_config_audit from service_role;
grant select, insert on public.trade_config_audit to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · trade_gate_override — the explicit, EXPIRING operator escape hatch for the live interlock (F1)
-- An override satisfies the interlock's gate branch ONLY while expires_at > now(). expires_at is NOT NULL with
-- NO default — the writer must consciously choose how long the override lives. Rows are never deleted:
-- trade_gate_override_clear() expires active rows in place (expires_at = now()), keeping the audit trail.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.trade_gate_override (
  id         bigint generated always as identity primary key,
  reason     text not null,
  note       text,                                             -- optional scope note (which market/window/why)
  expires_at timestamptz not null,                             -- NO default: the writer must choose (F1)
  created_at timestamptz not null default now(),
  created_by text not null default current_user
);
create index if not exists trade_gate_override_created_idx on public.trade_gate_override (created_at desc);

alter table public.trade_gate_override enable row level security;
drop policy if exists operator_read on public.trade_gate_override;
create policy operator_read on public.trade_gate_override
  for select to authenticated using (public.is_operator());
grant select on public.trade_gate_override to anon, authenticated;
grant all    on public.trade_gate_override to service_role;

-- F1: the guarded override write — SECURITY DEFINER + operator_guard, same idiom as trade_config_set.
-- Rejects a non-future expiry (an already-expired override is a no-op wearing a reason) AND caps the horizon
-- at 14 days (F1-residual): a gate bypass is short-lived by construction — a longer one is a standing policy
-- change, which belongs to the gate itself, not an override row.
create or replace function public.trade_gate_override_set(p_reason text, p_expires_at timestamptz, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'trade_gate_override_set: reason must be non-empty';
  end if;
  if p_expires_at is null or p_expires_at <= now() then
    raise exception 'trade_gate_override_set: expires_at must be in the future';
  end if;
  if p_expires_at > now() + interval '14 days' then
    raise exception 'trade_gate_override_set: expires_at more than 14 days out — an override is short-lived by construction';
  end if;
  insert into public.trade_gate_override (reason, note, expires_at)
  values (p_reason, p_note, p_expires_at)
  returning jsonb_build_object('override', to_jsonb(trade_gate_override.*)) into v;
  return v;
end;
$$;

-- F1: the guarded clear — expires every ACTIVE override in place (audit trail kept). Object envelope.
create or replace function public.trade_gate_override_clear()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  perform public.operator_guard();
  update public.trade_gate_override set expires_at = now() where expires_at > now();
  get diagnostics v_n = row_count;
  return jsonb_build_object('cleared', v_n);
end;
$$;

revoke all on function public.trade_gate_override_set(text, timestamptz, text) from public, anon, authenticated;
grant  execute on function public.trade_gate_override_set(text, timestamptz, text) to service_role, authenticated;
revoke all on function public.trade_gate_override_clear() from public, anon, authenticated;
grant  execute on function public.trade_gate_override_clear() to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · live_orders + live_fills — the order-intent / fill ledger behind the bot_order_* RPCs
-- Status lifecycle (F9, aligned with T1's OrderLedgerStatus verbatim): intent → placed → partial → filled;
-- canceled / failed TERMINAL (single-L 'canceled'; the venue's 'expired' outcome folds into 'canceled').
-- side/purpose/order_type spellings are T1's exact enums (BUY/SELL; entry/take_profit/stop_loss/time_stop;
-- GTC/GTD/FOK/FAK). mode ∈ (dry-run, live): an order row never exists at mode 'off' (the rail does nothing).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.live_orders (
  id              uuid primary key default gen_random_uuid(),
  intent_key      text not null,                                 -- idempotency key (unique per mode over OPEN rows)
  client_order_id text not null,                                 -- client-generated id echoed to the venue
  order_id        text,                                          -- the VENUE orderID — null until record_placed
  market_id       text not null,                                 -- poly market / condition id
  token_id        text not null,                                 -- the traded token (yes/no)
  side            text not null check (side in ('BUY', 'SELL')),
  purpose         text not null check (purpose in ('entry', 'take_profit', 'stop_loss', 'time_stop')),
  order_type      text not null check (order_type in ('GTC', 'GTD', 'FOK', 'FAK')),
  price           numeric(8,6)  not null,                        -- limit price (0..1 share price)
  size            numeric(14,4) not null,                        -- shares requested
  size_matched    numeric(14,4) not null default 0,              -- CUMULATIVE shares filled (record_fill)
  avg_price       numeric(8,6),                                  -- cumulative average fill price (record_fill)
  trade_date      date not null,                                 -- the market's resolution day (intent-key component)
  mode            text not null check (mode in ('dry-run', 'live')),  -- posture AT placement (dry-run rows ARE recorded)
  status          text not null default 'intent'
                    check (status in ('intent', 'placed', 'partial', 'filled', 'canceled', 'failed')),
  reason          text,                                          -- failure detail (record_failed)
  created_at      timestamptz not null default now(),
  placed_at       timestamptz,
  updated_at      timestamptz not null default now()
);

-- F4 — THE load-bearing reserve guarantee: at most ONE OPEN (non-terminal) row per (mode, intent_key).
-- canceled/failed rows fall out of the index → the key is re-reservable (the reprice path); dry-run and live
-- are distinct intents by construction (mode is in the key).
create unique index if not exists live_orders_intent_open_key
  on public.live_orders (mode, intent_key)
  where status not in ('canceled', 'failed');

-- One OPEN row per client_order_id — the record_* lookups key on it; terminal rows free the id too.
create unique index if not exists live_orders_client_open_key
  on public.live_orders (client_order_id)
  where status not in ('canceled', 'failed');

create index if not exists live_orders_status_idx on public.live_orders (status, created_at desc);
create index if not exists live_orders_market_idx on public.live_orders (market_id);

create or replace trigger trg_live_orders_updated_at
  before update on public.live_orders
  for each row execute function public.set_updated_at();

create table if not exists public.live_fills (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.live_orders(id),
  fill_price    numeric(8,6)  not null,                          -- DISPLAY: round(marginal/delta, 6) — see N2 header
  fill_size     numeric(14,4) not null,                          -- the DELTA matched since the previous record_fill
  fill_notional numeric(14,6) not null,                          -- N2: the EXACT marginal cash of this delta — Σ = true cash
  fee_usd       numeric(10,4) not null default 0,                -- 0 via record_fill (maker $0 fee); taker fees land here later
  filled_at     timestamptz   not null default now(),
  created_at    timestamptz   not null default now()
);
create index if not exists live_fills_order_idx  on public.live_fills (order_id);
create index if not exists live_fills_filled_idx on public.live_fills (filled_at desc);

alter table public.live_orders enable row level security;
drop policy if exists operator_read on public.live_orders;
create policy operator_read on public.live_orders
  for select to authenticated using (public.is_operator());
grant select on public.live_orders to anon, authenticated;
grant all    on public.live_orders to service_role;

alter table public.live_fills enable row level security;
drop policy if exists operator_read on public.live_fills;
create policy operator_read on public.live_fills
  for select to authenticated using (public.is_operator());
grant select on public.live_fills to anon, authenticated;
grant all    on public.live_fills to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4.5 · trade_today_realized_loss() — the ONE shared daily-loss implementation (N1)
-- The definition in the header, verbatim: realized P&L attributed at SELL time over LIVE fills; loss window =
-- SELL fills with filled_at ≥ date_trunc('day', now()) (UTC midnight), plus buy-side fees paid in the window.
-- Basis = lifetime average cost of the position's BUY fills up to the sell's fill time (exact marginal
-- notionals — N2). BOTH consumers call this; there is deliberately no second expression anywhere.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_today_realized_loss()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  with buys as (
    select o.market_id, o.token_id, f.fill_notional, f.fill_size, f.fee_usd, f.filled_at
    from public.live_fills f
    join public.live_orders o on o.id = f.order_id
    where o.mode = 'live' and o.side = 'BUY'
  ),
  today_sells as (
    select o.market_id, o.token_id, f.fill_notional, f.fill_size, f.fee_usd, f.filled_at
    from public.live_fills f
    join public.live_orders o on o.id = f.order_id
    where o.mode = 'live' and o.side = 'SELL'
      and f.filled_at >= date_trunc('day', now())
  ),
  realized as (
    -- per SELL fill: proceeds − (avg cost basis at that time × size sold) − its attributed fee.
    -- A naked sell (no prior buys — outside the strategy shape) gets basis 0: pure proceeds, never a
    -- fabricated loss.
    select s.fill_notional
           - coalesce((
               select sum(b.fill_notional) / nullif(sum(b.fill_size), 0)
               from buys b
               where b.market_id = s.market_id and b.token_id = s.token_id
                 and b.filled_at <= s.filled_at
             ), 0) * s.fill_size
           - s.fee_usd as delta
    from today_sells s
  )
  select greatest(0, -coalesce((select sum(delta) from realized), 0))
       + coalesce((select sum(fee_usd) from buys where filled_at >= date_trunc('day', now())), 0);
$$;

revoke all on function public.trade_today_realized_loss() from public, anon, authenticated;
grant  execute on function public.trade_today_realized_loss() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · trade_config_get() — the runner-facing service-role read (object envelope, tripwire-compliant)
-- The runner (service_role, no operator jwt) cannot pass operator_guard, so dash_trading() is NOT reachable from
-- the tick — this is its plain config read. Returns { config: {…} } (object, never a top-level array).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_config_get()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('config', (select to_jsonb(t) from public.trade_config t where t.id = 1));
$$;

revoke all on function public.trade_config_get() from public, anon, authenticated;
grant  execute on function public.trade_config_get() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · trade_config_set(...) — the operator-guarded config write (self-guards, like every operator_* RPC)
-- Nullable params: a null leaves the column unchanged. city_allowlist / active_until are nullable columns whose
-- "clear to null" needs an explicit flag (a null param can't disambiguate "leave" from "clear"). The mode enum,
-- §9R ceiling, positivity + fraction CHECKs are all enforced by the table — an out-of-range write RAISES.
-- F5: active_until is capped at 60 days out — a longer run window is a config typo, not a plan.
-- Returns { config: {…} } (object envelope). Audited automatically by trg_trade_config_audit.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_config_set(
  p_mode                     text    default null,
  p_stake_per_buy_usd        numeric default null,
  p_per_position_cap_usd     numeric default null,
  p_per_market_cap_usd       numeric default null,
  p_total_concurrent_cap_usd numeric default null,
  p_daily_loss_kill_usd      numeric default null,
  p_daily_loss_kill_frac     numeric default null,
  p_city_allowlist           text[]  default null,
  p_active_until             date    default null,
  p_clear_city_allowlist     boolean default false,
  p_clear_active_until       boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  -- F5: reject a run window more than 60 days out.
  if p_active_until is not null and p_active_until > current_date + 60 then
    raise exception 'trade_config_set: active_until % is more than 60 days out (max %)',
      p_active_until, current_date + 60;
  end if;

  update public.trade_config set
    mode                     = coalesce(p_mode, mode),
    stake_per_buy_usd        = coalesce(p_stake_per_buy_usd, stake_per_buy_usd),
    per_position_cap_usd     = coalesce(p_per_position_cap_usd, per_position_cap_usd),
    per_market_cap_usd       = coalesce(p_per_market_cap_usd, per_market_cap_usd),
    total_concurrent_cap_usd = coalesce(p_total_concurrent_cap_usd, total_concurrent_cap_usd),
    daily_loss_kill_usd      = coalesce(p_daily_loss_kill_usd, daily_loss_kill_usd),
    daily_loss_kill_frac     = coalesce(p_daily_loss_kill_frac, daily_loss_kill_frac),
    city_allowlist           = case when p_clear_city_allowlist then null
                                    else coalesce(p_city_allowlist, city_allowlist) end,
    active_until             = case when p_clear_active_until then null
                                    else coalesce(p_active_until, active_until) end
  where id = 1;

  select jsonb_build_object('config', to_jsonb(t)) into v from public.trade_config t where t.id = 1;
  return v;
end;
$$;

revoke all on function public.trade_config_set(
  text, numeric, numeric, numeric, numeric, numeric, numeric, text[], date, boolean, boolean
) from public, anon, authenticated;
grant execute on function public.trade_config_set(
  text, numeric, numeric, numeric, numeric, numeric, numeric, text[], date, boolean, boolean
) to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 7 · trade_live_preflight() — the LIVE-MODE INTERLOCK (the runner calls this before entering live mode)
-- Returns { ok, reasons[], checks{} } — ok only when EVERY blocking condition clears (checklist semantics, like
-- goLiveGate: all reasons collected, never short-circuited). NOT operator_guarded — the service-role runner must
-- call it; it is a pure read. Blocking conditions:
--   (1) trade_config.mode = 'live'
--   (2) active_until set AND >= current_date (the run-window day-cap has not expired)
--   (3) stake_per_buy_usd <= per_position_cap_usd
--   (4) gate: the latest mode='paper' source='forward' bot_gate_snapshot has label='PASS'  OR  an ACTIVE
--       (expires_at > now()) trade_gate_override row exists (F1)
--   (5) F2/N1 daily-loss kill: today's realized LIVE loss (trade_today_realized_loss(), the SHARED N1
--       definition — realized P&L at SELL time + buy fees, window = UTC midnight) < daily_loss_kill_usd AND
--       < daily_loss_kill_frac × total_concurrent_cap_usd (the documented basis — see header)
-- checks additionally carries the open LIVE buy-side exposure (total + per-market) for the runner's
-- per-placement cap enforcement (the F2 contract in the header) and lossWindowStart (the N1 window start,
-- named explicitly). ALL money figures filter mode='live': dry-run rows are recorded but never count.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_live_preflight()
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
  v_open_expo        numeric;
  v_per_market       jsonb;
begin
  select * into v_cfg from public.trade_config where id = 1;
  if not found then
    return jsonb_build_object(
      'ok', false,
      'reasons', jsonb_build_array('trade_config singleton row missing'),
      'checks', jsonb_build_object()
    );
  end if;

  -- (1) mode must be live
  if v_cfg.mode is distinct from 'live' then
    v_reasons := v_reasons || format('mode is %L — not ''live''', v_cfg.mode);
  end if;

  -- (2) run-window day-cap (0075 idiom). Bare string literals are cast ::text so `text[] || …` resolves to
  -- array-append (anyarray || anyelement), not the ambiguous anyarray || anyarray (which parses the string as
  -- an array literal → "malformed array literal"). The format() reasons already yield text, so they are safe.
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

  -- (4a) the FORWARD paper gate of record (source='forward' — a backtest PASS must NOT unlock capital).
  -- id desc tiebreak (F8): same-timestamp snapshots resolve to the later insert, deterministically.
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

  -- (5) F2/N1 daily-loss kill — the SHARED realized-at-sell-time definition (SECTION 4.5; dry-run never counts).
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

  -- open LIVE buy-side exposure — total + per-market (reported, not blocking: the runner enforces the caps
  -- per placement from these; see the F2 contract in the header). intent/placed/partial all commit capital.
  select coalesce(sum(price * size), 0) into v_open_expo
  from public.live_orders
  where mode = 'live' and side = 'BUY' and status in ('intent', 'placed', 'partial');

  select coalesce(jsonb_object_agg(market_id, expo), '{}'::jsonb) into v_per_market
  from (
    select market_id, sum(price * size) as expo
    from public.live_orders
    where mode = 'live' and side = 'BUY' and status in ('intent', 'placed', 'partial')
    group by market_id
  ) m;

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

revoke all on function public.trade_live_preflight() from public, anon, authenticated;
grant  execute on function public.trade_live_preflight() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 8 · dash_trading() — the read-only /trading console (operator-guarded, object envelope)
-- config + interlock verdict + open LIVE orders + today's LIVE spend/loss (dry-run rows never count toward any
-- money figure — addendum) + a cheap dryRun counts section + the recent audit trail. tripwire-compliant.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_trading()
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
    'config',    (select to_jsonb(t) from public.trade_config t where t.id = 1),
    'preflight', public.trade_live_preflight(),
    'openOrders', (
      select coalesce(jsonb_agg(to_jsonb(o) order by o.created_at desc), '[]'::jsonb)
      from public.live_orders o
      where o.mode = 'live' and o.status in ('intent', 'placed', 'partial')
    ),
    'openExposureUsd', (
      select coalesce(sum(o.price * o.size), 0)
      from public.live_orders o
      where o.mode = 'live' and o.side = 'BUY' and o.status in ('intent', 'placed', 'partial')
    ),
    'today', (
      -- today's LIVE cash flow from fills (informational: buys deploy capital, sells return it, fees cost),
      -- all on N2 exact notionals. lossUsd is NOT derived from this cashflow — it is THE shared N1
      -- realized-at-sell-time definition (trade_today_realized_loss), identical to preflight §5 by construction.
      select jsonb_build_object(
        'buyUsd',  coalesce(sum(f.fill_notional) filter (where o.side = 'BUY'),  0),
        'sellUsd', coalesce(sum(f.fill_notional) filter (where o.side = 'SELL'), 0),
        'feeUsd',  coalesce(sum(f.fee_usd), 0),
        'netUsd',  coalesce(sum(f.fill_notional) filter (where o.side = 'SELL'), 0)
                 - coalesce(sum(f.fill_notional) filter (where o.side = 'BUY'),  0)
                 - coalesce(sum(f.fee_usd), 0),
        'lossUsd', public.trade_today_realized_loss(),
        'lossWindowStart', date_trunc('day', now()),
        'nFills',  count(f.id)
      )
      from public.live_fills f
      join public.live_orders o on o.id = f.order_id
      where o.mode = 'live' and f.filled_at >= date_trunc('day', now())
    ),
    'dryRun', (
      -- cheap shadow-rail counts only (the shadow-diff harness reads the rows themselves).
      select jsonb_build_object(
        'openOrders', count(*) filter (where status in ('intent', 'placed', 'partial')),
        'total',      count(*)
      )
      from public.live_orders where mode = 'dry-run'
    ),
    'recentAudit', (
      select coalesce(jsonb_agg(to_jsonb(a) order by a.changed_at desc), '[]'::jsonb)
      from (
        select * from public.trade_config_audit order by changed_at desc limit 20
      ) a
    ),
    'generatedAt', now()
  ) into v;

  return v;
end;
$$;

revoke all on function public.dash_trading() from public, anon, authenticated;
grant  execute on function public.dash_trading() to service_role, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 9 · the seven bot_order_* RPCs — the T1 OrderLedger contract + the reconcile sweep (service-role
-- ONLY; the runner is the sole caller). Args are T1's documented contract verbatim EXCEPT by_intent +
-- reserve_intent take an explicit p_mode (F4 — dry-run and live are distinct intents); T1's rpcOrderLedger
-- binding adds the mode arg (flagged in the lane report — the RPC side is the schema truth).
-- bot_order_list_dangling is the seventh (coordinator addendum): T1's reconcile sweep reads it.
--
-- CLIENT_ORDER_ID CONTRACT (N5): client_order_id must be GLOBALLY UNIQUE and NEVER REUSED (T1 generates a
-- fresh id per attempt). A collision on its partial-unique index RAISES unique_violation and is deliberately
-- NOT mapped to 'exists' — only the (mode, intent_key) index carries reserve semantics; a client-id collision
-- is a caller bug, not a benign retry.
--
-- THE STATE MACHINE (N3/N6):
--   reserve_intent   : no open (mode,key) row → insert 'intent' ⇒ 'reserved'   | open row exists ⇒ 'exists'
--   record_placed    : intent → placed (stamps order_id + placed_at). LATE arrival on placed/partial/filled
--                      (N6: an instant FOK fill can beat it): stamps order_id if unset, NEVER regresses
--                      status. Terminal/unknown: no-op.
--   record_fill      : intent|placed|partial → p_status (partial|filled). N6: fills on 'intent' PROMOTE
--                      directly (the fill beat record_placed). Δ = p_size_matched − size_matched:
--                        Δ > 0 ⇒ cumulative update + one live_fills row (N2 marginal notional);
--                        Δ = 0 ⇒ idempotent status echo, no fill row;
--                        Δ < 0 ⇒ FULL no-op (N4 — size_matched is strictly monotonic; a shrinking venue echo
--                                is anomalous and must not regress the ledger).
--                      Row exists but TERMINAL ⇒ SILENT no-op (duplicate echo; at-least-once delivery is
--                      benign). NO row at all for the id ⇒ RAISE (N3 — an unknown-id echo is a reconcile bug;
--                      the runner catches + alerts; it must never be swallowed).
--   record_canceled  : intent|placed|partial → canceled (terminal; frees the key; venue 'expired' folds here).
--                      size_matched and avg_price are PRESERVED — T1's reprice partial-accounting reads them
--                      after the cancel transition. filled is immutable — no-op.
--   record_failed    : intent|placed|partial → failed + reason (terminal; frees the key; never retried under
--                      the same client_order_id).
--   list_dangling    : the reconcile sweep's read — every (p_mode, status='intent', order_id IS NULL) row,
--                      i.e. intents whose post outcome was never recorded (a crash inside the post→record
--                      critical section). Returns { rows: [...] } — an OBJECT envelope even though the fn has
--                      args: the money path gets NO exceptions to the trap-proof post-0081 shape.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- findByIntentKey: the single OPEN (non-terminal) row for (mode, key), or SQL null. The partial-unique index
-- guarantees ≤ 1 such row. Snake_case jsonb — T1's mapLedgerRow maps it to the camelCase OrderLedgerRow.
create or replace function public.bot_order_by_intent(p_intent_key text, p_mode text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(o)
  from public.live_orders o
  where o.intent_key = p_intent_key
    and o.mode = p_mode
    and o.status not in ('canceled', 'failed')
  limit 1;
$$;

-- reserveIntent: CONDITIONAL insert against the partial-unique index → 'reserved' | 'exists'. A retry or a
-- concurrent placer with the same (mode, intent) gets 'exists', never a second live order ("reserved" vs
-- "exists" semantics per the T1 doc). A canceled/failed key re-reserves cleanly (new row).
create or replace function public.bot_order_reserve_intent(
  p_mode text, p_intent_key text, p_client_order_id text, p_market_id text, p_token_id text,
  p_side text, p_purpose text, p_order_type text, p_price numeric, p_size numeric, p_trade_date date
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.live_orders
    (mode, intent_key, client_order_id, market_id, token_id, side, purpose, order_type, price, size, trade_date)
  values
    (p_mode, p_intent_key, p_client_order_id, p_market_id, p_token_id, p_side, p_purpose, p_order_type,
     p_price, p_size, p_trade_date)
  on conflict (mode, intent_key) where status not in ('canceled', 'failed') do nothing
  returning id into v_id;
  return case when v_id is null then 'exists' else 'reserved' end;
end;
$$;

-- recordPlaced: intent → placed, stamps the venue orderID (the post→record critical section, ADR-OC-5).
-- N6: it may arrive LATE — an instant FOK fill can promote the row past 'placed' first — so on a
-- placed/partial/filled row it stamps order_id (first writer wins) and placed_at without regressing status.
create or replace function public.bot_order_record_placed(p_client_order_id text, p_order_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.live_orders
     set order_id  = coalesce(order_id, p_order_id),
         placed_at = coalesce(placed_at, now()),
         status    = case when status = 'intent' then 'placed' else status end
   where client_order_id = p_client_order_id
     and status in ('intent', 'placed', 'partial', 'filled');
end;
$$;

-- recordFill: intent|placed|partial → partial | filled (N6: a fill on 'intent' promotes directly — an instant
-- FOK fill can beat record_placed). p_size_matched is CUMULATIVE (mirrors the venue's size_matched); the
-- positive DELTA is appended to live_fills carrying the EXACT marginal notional (N2):
--   marginal = (p_avg_price × p_size_matched) − (prev_avg × prev_size); fill_price = round(marginal/Δ, 6).
-- Δ = 0 ⇒ idempotent echo (status update only, no fill row). Δ < 0 ⇒ FULL no-op (N4: size_matched is strictly
-- monotonic — a shrinking echo never regresses the ledger). Row exists but terminal ⇒ SILENT no-op (duplicate
-- echo). NO row for the id ⇒ RAISE (N3 — a reconcile bug the runner must see, never swallowed).
-- fee_usd stays 0 on this path (the maker rail is $0-fee).
create or replace function public.bot_order_record_fill(
  p_client_order_id text, p_size_matched numeric, p_avg_price numeric, p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row      public.live_orders;
  v_delta    numeric;
  v_marginal numeric;
begin
  if p_status not in ('filled', 'partial') then
    raise exception 'bot_order_record_fill: p_status must be filled|partial, got %', p_status;
  end if;
  -- N3: split the silent no-op — an id with NO row at all is a reconcile bug and must raise.
  if not exists (select 1 from public.live_orders where client_order_id = p_client_order_id) then
    raise exception 'bot_order_record_fill: unknown client_order_id % — no ledger row (reconcile bug)',
      p_client_order_id;
  end if;
  select * into v_row from public.live_orders
   where client_order_id = p_client_order_id and status in ('intent', 'placed', 'partial')
   limit 1;
  if not found then
    return;  -- the row is TERMINAL (or filled) — a duplicate venue echo; at-least-once delivery is benign
  end if;
  v_delta := p_size_matched - coalesce(v_row.size_matched, 0);
  if v_delta < 0 then
    return;  -- N4: cumulative size_matched is strictly monotonic — ignore a shrinking echo wholesale
  end if;
  update public.live_orders
     set size_matched = p_size_matched, avg_price = p_avg_price, status = p_status
   where id = v_row.id;
  if v_delta > 0 then
    -- N2: the marginal notional is the exact cash of this delta; fill_price is display-only.
    v_marginal := (p_avg_price * p_size_matched)
                - (coalesce(v_row.avg_price, 0) * coalesce(v_row.size_matched, 0));
    insert into public.live_fills (order_id, fill_price, fill_size, fill_notional)
    values (v_row.id, round(v_marginal / v_delta, 6), v_delta, v_marginal);
  end if;
end;
$$;

-- recordCanceled: any OPEN pre-filled state → canceled (TERMINAL; frees the intent key). The venue's
-- 'expired' outcome is recorded through THIS path (F9 — expired folds into canceled). A filled order is
-- immutable — cancel on 'filled' is a no-op. size_matched/avg_price are DELIBERATELY untouched: a canceled
-- partial keeps its fill accounting (T1's reprice partial-accounting reads it after the cancel transition).
create or replace function public.bot_order_record_canceled(p_client_order_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.live_orders
     set status = 'canceled'
   where client_order_id = p_client_order_id and status in ('intent', 'placed', 'partial');
end;
$$;

-- recordFailed: any OPEN pre-filled state → failed (TERMINAL; frees the intent key; never retried under the
-- same client_order_id). The error lands in `reason`.
create or replace function public.bot_order_record_failed(p_client_order_id text, p_error text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.live_orders
     set status = 'failed', reason = p_error
   where client_order_id = p_client_order_id and status in ('intent', 'placed', 'partial');
end;
$$;

-- listDangling: the reconcile sweep — intents whose post outcome was never recorded (order_id still null),
-- i.e. a crash inside the post→record_placed critical section left the ledger not knowing whether the venue
-- holds a live order. Mode-scoped (F4). Returns { rows: [...] } (OBJECT envelope — the post-0081 idiom; the
-- money path gets no exceptions even on an args-taking fn), each row the same to_jsonb(live_orders) shape as
-- bot_order_by_intent.
create or replace function public.bot_order_list_dangling(p_mode text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(o) order by o.created_at asc), '[]'::jsonb))
  from public.live_orders o
  where o.mode = p_mode
    and o.status = 'intent'
    and o.order_id is null;
$$;

-- grants: the runner (service_role) is the SOLE caller of the ledger RPCs.
revoke all on function public.bot_order_by_intent(text, text) from public, anon, authenticated;
grant  execute on function public.bot_order_by_intent(text, text) to service_role;
revoke all on function public.bot_order_reserve_intent(text, text, text, text, text, text, text, text, numeric, numeric, date)
  from public, anon, authenticated;
grant  execute on function public.bot_order_reserve_intent(text, text, text, text, text, text, text, text, numeric, numeric, date)
  to service_role;
revoke all on function public.bot_order_record_placed(text, text) from public, anon, authenticated;
grant  execute on function public.bot_order_record_placed(text, text) to service_role;
revoke all on function public.bot_order_record_fill(text, numeric, numeric, text) from public, anon, authenticated;
grant  execute on function public.bot_order_record_fill(text, numeric, numeric, text) to service_role;
revoke all on function public.bot_order_record_canceled(text) from public, anon, authenticated;
grant  execute on function public.bot_order_record_canceled(text) to service_role;
revoke all on function public.bot_order_record_failed(text, text) from public, anon, authenticated;
grant  execute on function public.bot_order_record_failed(text, text) to service_role;
revoke all on function public.bot_order_list_dangling(text) from public, anon, authenticated;
grant  execute on function public.bot_order_list_dangling(text) to service_role;
