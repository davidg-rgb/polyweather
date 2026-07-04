-- 0082_trading_activation.sql — the TRADING ACTIVATION + RISK CONSOLE, staged DARK.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- STAGED-DARK: this migration is WRITTEN but NOT applied to any database. It creates the config surface, the
-- risk caps, the order/fill ledger, the operator-guarded write path, the read dashboard, and the live-mode
-- INTERLOCK for the opening-convergence bot's eventual autonomous buy/sell rail (CLAUDE.md scoped exception,
-- OPENING-CONVERGENCE-HANDOFF.md §9R). Seeded with mode='off' — nothing here places a trade or touches a key.
-- The runner (T1's lane) writes live_orders/live_fills and calls trade_live_preflight() before ever entering
-- live mode. NO CAPITAL until a frozen paper PASS: the interlock encodes that gate in SQL.
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
-- (trade_config_get, trade_live_preflight, dash_trading) returns a jsonb OBJECT envelope ({config:…}/{rows:…}/
-- {ok,reasons,checks,…}) — NEVER a top-level jsonb array — so supabasePort never misreads it as a RETURNS TABLE
-- row set. migrations.test.ts's tripwire enumerates all three and asserts object/scalar, never array.
--
-- LIVE GATE = FORWARD PAPER, NOT BACKTEST (intentional scoping, flagged): the preflight's gate branch reads the
-- latest bot_gate_snapshot with mode='paper' AND source='forward'. The mission text names only mode='paper';
-- source='forward' is added deliberately — bot_gate_snapshot.source's own CHECK comment is "the capital gate
-- reads forward only (F2-r10)", and a backtest PASS must never unlock capital. A test proves a source='backtest'
-- PASS does NOT satisfy the interlock.
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
-- service_role for a direct write, the operator-guarded definer for a trade_config_set() write. Every legal
-- write path can insert (service_role via the grant below; the definer as table owner). Append-only: no update/
-- delete is ever granted — the only write is this trigger.
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
grant all    on public.trade_config_audit to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · trade_gate_override — the explicit operator escape hatch for the live interlock (append-only)
-- Any row present satisfies the interlock's gate branch (the mission's "an explicit override row exists").
-- reason NOT NULL forces a written justification; created_at orders them; the newest reason surfaces on /trading.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.trade_gate_override (
  id         bigint generated always as identity primary key,
  reason     text not null,
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

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · live_orders + live_fills — the order-intent / fill ledger the runner writes (T1's lane owns writes)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.live_orders (
  id              uuid primary key default gen_random_uuid(),
  intent_key      text not null unique,                          -- THE idempotency backstop: one order per intent
  client_order_id text,                                          -- client-generated id echoed to the venue
  event_id        uuid references public.market_events(id),
  market_id       text,                                          -- poly_market_id / condition id
  token_id        text,                                          -- the traded token (yes/no)
  side            text not null check (side in ('buy', 'sell')),
  purpose         text not null check (purpose in ('entry', 'tp', 'sl', 'timestop')),
  price           numeric(8,6) not null,                         -- limit price (0..1 share price)
  size            numeric(14,4) not null,                        -- shares
  mode            text not null check (mode in ('off', 'dry-run', 'live')),  -- trade_config.mode AT placement
  status          text not null default 'intent'
                    check (status in ('intent', 'submitted', 'open', 'partial', 'filled',
                                      'cancelled', 'rejected', 'failed')),
  reason          text,                                          -- rejection / failure detail
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists live_orders_status_idx on public.live_orders (status, created_at desc);
create index if not exists live_orders_event_idx  on public.live_orders (event_id);

create or replace trigger trg_live_orders_updated_at
  before update on public.live_orders
  for each row execute function public.set_updated_at();

create table if not exists public.live_fills (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.live_orders(id),
  fill_price numeric(8,6)  not null,
  fill_size  numeric(14,4) not null,
  fee_usd    numeric(10,4) not null default 0,
  filled_at  timestamptz   not null default now(),
  created_at timestamptz   not null default now()
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
--   (4) gate: the latest mode='paper' source='forward' bot_gate_snapshot has label='PASS'  OR  a
--       trade_gate_override row exists.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_live_preflight()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg             public.trade_config;
  v_reasons         text[] := '{}';
  v_gate_pass       boolean;
  v_override_reason text;
  v_override        boolean;
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

  -- (4a) the FORWARD paper gate of record (source='forward' — a backtest PASS must NOT unlock capital)
  select (label = 'PASS') into v_gate_pass
  from public.bot_gate_snapshot
  where mode = 'paper' and source = 'forward'
  order by computed_at desc
  limit 1;
  v_gate_pass := coalesce(v_gate_pass, false);

  -- (4b) OR an explicit operator override row
  select reason into v_override_reason
  from public.trade_gate_override
  order by created_at desc
  limit 1;
  v_override := v_override_reason is not null;

  if not v_gate_pass and not v_override then
    v_reasons := v_reasons ||
      'no PASS forward paper gate (bot_gate_snapshot mode=paper/source=forward) and no trade_gate_override row'::text;
  end if;

  return jsonb_build_object(
    'ok', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'checks', jsonb_build_object(
      'mode',              v_cfg.mode,
      'activeUntil',       v_cfg.active_until,
      'stakePerBuyUsd',    v_cfg.stake_per_buy_usd,
      'perPositionCapUsd', v_cfg.per_position_cap_usd,
      'gatePass',          v_gate_pass,
      'override',          v_override,
      'overrideReason',    v_override_reason
    )
  );
end;
$$;

revoke all on function public.trade_live_preflight() from public, anon, authenticated;
grant  execute on function public.trade_live_preflight() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 8 · dash_trading() — the read-only /trading console (operator-guarded, object envelope)
-- config + interlock verdict + open orders + today's spend/loss. tripwire-compliant (no-arg → object).
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
      where o.status in ('intent', 'submitted', 'open', 'partial')
    ),
    'openExposureUsd', (
      select coalesce(sum(o.price * o.size), 0)
      from public.live_orders o
      where o.status in ('submitted', 'open', 'partial')
    ),
    'today', (
      -- today's realized cash flow from fills: buys deploy capital, sells return it, fees always cost.
      select jsonb_build_object(
        'buyUsd',  coalesce(sum(f.fill_price * f.fill_size) filter (where o.side = 'buy'),  0),
        'sellUsd', coalesce(sum(f.fill_price * f.fill_size) filter (where o.side = 'sell'), 0),
        'feeUsd',  coalesce(sum(f.fee_usd), 0),
        'netUsd',  coalesce(sum(f.fill_price * f.fill_size) filter (where o.side = 'sell'), 0)
                 - coalesce(sum(f.fill_price * f.fill_size) filter (where o.side = 'buy'),  0)
                 - coalesce(sum(f.fee_usd), 0),
        'lossUsd', greatest(0,
                     coalesce(sum(f.fill_price * f.fill_size) filter (where o.side = 'buy'),  0)
                   + coalesce(sum(f.fee_usd), 0)
                   - coalesce(sum(f.fill_price * f.fill_size) filter (where o.side = 'sell'), 0)),
        'nFills',  count(f.id)
      )
      from public.live_fills f
      join public.live_orders o on o.id = f.order_id
      where f.filled_at >= date_trunc('day', now())
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
