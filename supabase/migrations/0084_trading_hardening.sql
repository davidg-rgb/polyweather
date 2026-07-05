-- 0084_trading_hardening.sql — LIVE-RAIL risk-accounting hardening, STAGED DARK (review findings #7/#17/#18/#19/#21).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- STAGED-DARK: written but NOT applied to any database — pending operator apply, exactly like 0082 was
-- (apply 0082 first; this migration REPLACES functions 0082 defined). Nothing here places a trade or touches
-- a key; every change tightens the honesty of the risk figures the interlock + the /trading console report.
--
-- WHAT (each item traces to a confirmed 2026-07-05 review finding):
--
--   #7  — openExposureUsd excluded FILLED-held positions, so total_concurrent_cap_usd stopped binding the
--         moment an entry filled (deployed capital dropped out of the F2 cap basis while the position was
--         held for up to the 18h time-stop). NEW shared public.trade_open_exposure() =
--             (a) UNFILLED resting entry commitment  — limit price × (size − size_matched) over OPEN live
--                 BUY rows (the filled slice of a partial row is deliberately excluded here, so it is
--                 never double-counted against leg (b)), PLUS
--             (b) FILLED-HELD position cost, net of sold — per (market, token): BUY-fill cash × the
--                 still-held fraction (lifetime-average basis, the same N8-consistent approximation the
--                 N1 loss definition documents). Fills are joined regardless of the order row's status,
--                 so a partial fill preserved on a canceled row (the reprice path) stays counted.
--         trade_live_preflight() and dash_trading() are re-stated to read this ONE implementation (the
--         trade_today_realized_loss idiom: one definition, every consumer). checks-key shape UNCHANGED.
--
--   #17 — live_fills.fee_usd had NO write path (bot_order_record_fill hard-coded the default 0), so the N1
--         daily-loss fee terms were dead code: taker FAK exit fees invisible to the kill.
--         bot_order_record_fill is DROPPED + RECREATED (the 0054 idiom — never overload a record_* fn) with
--         a trailing `p_fee_usd numeric default 0`, written onto the delta's live_fills row
--         (coalesce(p_fee_usd, 0) — a positional NULL from an older caller stays 0, the N9 idiom). The T1
--         binding (packages/trading order-ledger.ts recordFill) passes it; the maker path stays $0.
--
--   #18 — hold-to-resolution losses never entered the ledger (no SELL fill ⇒ invisible to the realized-at-
--         sell N1 definition): a position whose time-stop never filled and whose market resolved against it
--         lost the full stake while todayLossUsd read $0. NEW public.bot_order_record_resolution_loss()
--         books the loss THROUGH the existing N1 machinery: one synthetic, idempotent SELL row (purpose
--         time_stop, price 0, status filled, reason self-describing) + one live_fills row (proceeds $0 for
--         the full residual held size) — trade_today_realized_loss then realizes −basis×held with ZERO new
--         loss-definition code, and trade_open_exposure() (#7) releases the held cost in the same breath.
--         Idempotency = the F4 partial-unique (mode, intent_key) index: intent_key
--         'resolution-loss|market|token' conflicts on the second call → 'already booked', never re-booked.
--
--   #19 — bot_order_record_fill's read-modify-write had no row lock: two concurrent callers (an operator
--         double-start) could both read the stale size_matched, both compute the same positive delta, and
--         both insert a live_fills row — double-counting cash into the daily-loss kill. The recreated fn
--         (#17) takes the row lock (SELECT … FOR UPDATE) before computing the delta, so the N4
--         cumulative-delta idempotency now holds under CONCURRENT retries, not just sequential ones.
--
--   #21 — (read-side support) dash_maker_exit_history points carried no degradation marker, so the
--         /maker-exit trend headline/sparkline silently included partial-view snapshots (e.g. the 07-05
--         1-of-73-cities tick). The RPC is re-stated to ADDITIVELY carry `cityErrors` per point (from the
--         stored view's top-level count the Edge handler already threads); the web trend filters on it +
--         the 40-market gate floor. Older snapshots without the key yield JSON null (treated as unknown).
--
-- 0081 TRIPWIRE COMPLIANCE: both new fns return a jsonb OBJECT envelope (trade_open_exposure → {total,
-- perMarket}; bot_order_record_resolution_loss → {booked, …}) — NEVER a top-level jsonb array; no RETURNS
-- SETOF. Grants/security definer/search_path mirror 0082 exactly and are RE-ASSERTED on every re-stated fn
-- (the 0046/0047 re-body idiom). No table, no cron, no edge fn (cron count stays 29).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · trade_open_exposure() — the ONE shared open-LIVE-buy-side-exposure implementation (#7)
-- Returns { total: numeric, perMarket: { marketId: usd, … } }. Markets whose exposure has fully returned
-- (sold flat / resolution-booked) drop out of perMarket. Dry-run rows never count (mode='live' filter).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.trade_open_exposure()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with parts as (
    -- (a) UNFILLED resting entry commitment: limit price × the unfilled remainder of every OPEN live BUY
    --     row. `greatest(0, …)` guards a venue echo that over-reports size_matched past size.
    select market_id, sum(price * greatest(0, size - coalesce(size_matched, 0))) as expo
    from public.live_orders
    where mode = 'live' and side = 'BUY' and status in ('intent', 'placed', 'partial')
    group by market_id
    union all
    -- (b) FILLED-HELD position cost, net of sold (lifetime-average basis — N8-consistent). Joined on FILLS,
    --     not on order status: a partial fill preserved on a canceled row (reprice) stays deployed capital.
    select market_id, sum(held_cost) as expo
    from (
      select o.market_id,
             greatest(0,
               coalesce(sum(f.fill_notional) filter (where o.side = 'BUY'), 0)
               * (1 - coalesce(sum(f.fill_size) filter (where o.side = 'SELL'), 0)
                      / nullif(coalesce(sum(f.fill_size) filter (where o.side = 'BUY'), 0), 0))
             ) as held_cost
      from public.live_fills f
      join public.live_orders o on o.id = f.order_id
      where o.mode = 'live'
      group by o.market_id, o.token_id
    ) h
    group by market_id
  ),
  by_market as (
    select market_id, sum(expo) as expo
    from parts
    group by market_id
    having sum(expo) > 1e-9
  )
  select jsonb_build_object(
    'total',     coalesce((select sum(expo) from by_market), 0),
    'perMarket', coalesce((select jsonb_object_agg(market_id, expo) from by_market), '{}'::jsonb)
  );
$$;

revoke all on function public.trade_open_exposure() from public, anon, authenticated;
grant  execute on function public.trade_open_exposure() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · trade_live_preflight() — re-stated verbatim from 0082 §7 EXCEPT the exposure block now reads
-- the shared trade_open_exposure() (#7). Same signature/keys/grants; CREATE OR REPLACE preserves the body's
-- documented semantics — see the 0082 header for the full interlock contract.
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
  v_expo             jsonb;
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

  -- open LIVE buy-side exposure — total + per-market (reported, not blocking: the runner enforces the caps
  -- per placement from these; the F2 contract in the 0082 header). 0084 #7: the SHARED trade_open_exposure()
  -- counts unfilled resting commitment PLUS filled-held position cost net of sold — a filled BUY no longer
  -- drops out of the total-concurrent cap basis the moment it fills.
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

revoke all on function public.trade_live_preflight() from public, anon, authenticated;
grant  execute on function public.trade_live_preflight() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · dash_trading() — re-stated verbatim from 0082 §8 EXCEPT openExposureUsd now reads the shared
-- trade_open_exposure() (#7), so the console's headline exposure matches the interlock's cap basis exactly.
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
    -- 0084 #7: the SHARED exposure definition (resting commitment + filled-held cost net of sold).
    'openExposureUsd', (public.trade_open_exposure()->>'total')::numeric,
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
-- SECTION 4 · bot_order_record_fill — DROP + RECREATE (the 0054 idiom: adding a defaulted param to an
-- existing signature via CREATE OR REPLACE would create an ambiguous OVERLOAD, never a replacement).
--   #17: trailing `p_fee_usd numeric default 0` — the venue fee attributed to THIS delta, written onto the
--        delta's live_fills row. coalesce(p_fee_usd, 0): a positional NULL (older caller / the PGlite twin
--        port passing an omitted arg) stays 0 — the N9 idiom. The maker rail keeps passing 0; the taker FAK
--        exit computes it caller-side (feeRateBps × marginal notional — packages/trading order-ledger.ts).
--        A Δ=0 idempotent echo writes NO fill row, so its fee (if any) is dropped by design — the fee must
--        ride the SAME call that carries the delta.
--   #19: SELECT … FOR UPDATE — the read-modify-write is now serialized per row: a concurrent duplicate
--        caller blocks on the lock, re-reads the committed size_matched, computes Δ=0 and no-ops. The N4
--        cumulative-delta idempotency holds under concurrency, not just sequential retries.
-- Everything else (N3/N4/N6/N7 semantics, N2 marginal notionals) is byte-identical to 0082 §9.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
drop function if exists public.bot_order_record_fill(text, numeric, numeric, text);

create or replace function public.bot_order_record_fill(
  p_client_order_id text, p_size_matched numeric, p_avg_price numeric, p_status text,
  p_fee_usd numeric default 0
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
  -- #19: row lock — serialize concurrent record_fill callers on the same order so the delta below is
  -- computed against the COMMITTED size_matched, never a stale snapshot (double-insert double-counts cash).
  select * into v_row from public.live_orders
   where client_order_id = p_client_order_id and status in ('intent', 'placed', 'partial')
   limit 1
   for update;
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
    -- #17: the delta's attributed venue fee lands with it (0 on the maker path).
    v_marginal := (p_avg_price * p_size_matched)
                - (coalesce(v_row.avg_price, 0) * coalesce(v_row.size_matched, 0));
    insert into public.live_fills (order_id, fill_price, fill_size, fill_notional, fee_usd)
    values (v_row.id, round(v_marginal / v_delta, 6), v_delta, v_marginal, coalesce(p_fee_usd, 0));
  end if;
end;
$$;

revoke all on function public.bot_order_record_fill(text, numeric, numeric, text, numeric)
  from public, anon, authenticated;
grant  execute on function public.bot_order_record_fill(text, numeric, numeric, text, numeric)
  to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · bot_order_record_resolution_loss — book a hold-to-resolution FULL-STAKE loss (#18).
-- When a held position's market resolves AGAINST it (tokens expire worthless) no SELL fill ever exists, so
-- the realized-at-sell N1 definition is structurally blind to the worst-case loss shape. This RPC books it
-- THROUGH the existing machinery: one synthetic SELL row (price 0, purpose time_stop — the leg that failed
-- to fill; status filled; self-describing reason) + one live_fills row with proceeds $0 for the residual
-- held size. trade_today_realized_loss then realizes −(avg basis × held) in the resolution day's window,
-- and trade_open_exposure() (#7) releases the held cost.
--
-- IDEMPOTENT by the F4 partial-unique (mode, intent_key) index: intent_key 'resolution-loss|market|token'
-- can hold at most one open row per mode — a second call conflicts → { booked: false, reason: 'already
-- booked' }. No position (no residual held shares) → { booked: false } and NOTHING is written. The daemon
-- hook (T2): after reconstruction, for a position whose market resolved against it with heldSize > 0, call
-- this once — packages/trading order-ledger.ts `recordResolutionLoss(db, …)` is the TS binding.
-- Object envelope (post-0081 idiom — the money path gets no exceptions even on an args-taking fn).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.bot_order_record_resolution_loss(
  p_mode text, p_market_id text, p_token_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bought     numeric;
  v_sold       numeric;
  v_avg        numeric;
  v_held       numeric;
  v_trade_date date;
  v_cid        text;
  v_order_id   uuid;
  v_prev_size  numeric;
begin
  if p_mode not in ('dry-run', 'live') then
    raise exception 'bot_order_record_resolution_loss: p_mode must be dry-run|live, got %', p_mode;
  end if;

  -- residual held = Σ BUY fill deltas − Σ SELL fill deltas over this (mode, market, token)'s fills; basis =
  -- lifetime-average BUY cost (the N8-consistent approximation the N1 definition itself uses).
  select coalesce(sum(f.fill_size)     filter (where o.side = 'BUY'),  0),
         coalesce(sum(f.fill_size)     filter (where o.side = 'SELL'), 0),
         coalesce(sum(f.fill_notional) filter (where o.side = 'BUY'),  0)
           / nullif(coalesce(sum(f.fill_size) filter (where o.side = 'BUY'), 0), 0),
         max(o.trade_date) filter (where o.side = 'BUY')
    into v_bought, v_sold, v_avg, v_trade_date
  from public.live_fills f
  join public.live_orders o on o.id = f.order_id
  where o.mode = p_mode and o.market_id = p_market_id and o.token_id = p_token_id;

  -- ALREADY BOOKED: the synthetic SELL's own fill nets the residual to 0, so re-calls would otherwise fall
  -- into the generic "nothing held" branch — check the marker row FIRST for an honest, distinct verdict.
  select id, size into v_order_id, v_prev_size
  from public.live_orders
  where mode = p_mode
    and intent_key = 'resolution-loss|' || p_market_id || '|' || p_token_id
    and status not in ('canceled', 'failed')
  limit 1;
  if v_order_id is not null then
    return jsonb_build_object('booked', false, 'heldSize', v_prev_size,
                              'lossUsd', round(coalesce(v_avg, 0) * v_prev_size, 6),
                              'reason', 'already booked');
  end if;

  v_held := coalesce(v_bought, 0) - coalesce(v_sold, 0);
  if v_held <= 1e-9 or v_avg is null then
    return jsonb_build_object('booked', false, 'heldSize', greatest(v_held, 0), 'lossUsd', 0,
                              'reason', 'no residual held shares for this (mode, market, token)');
  end if;

  v_cid := 'resolution-loss:' || p_mode || ':' || p_market_id || ':' || p_token_id;
  insert into public.live_orders
    (mode, intent_key, client_order_id, market_id, token_id, side, purpose, order_type,
     price, size, size_matched, avg_price, trade_date, status, reason, placed_at)
  values
    (p_mode, 'resolution-loss|' || p_market_id || '|' || p_token_id, v_cid,
     p_market_id, p_token_id, 'SELL', 'time_stop', 'FAK',
     0, v_held, v_held, 0, coalesce(v_trade_date, current_date), 'filled',
     format('resolution loss: %s held shares expired worthless at resolution (basis $%s)',
            v_held, round(v_avg * v_held, 4)),
     now())
  on conflict (mode, intent_key) where status not in ('canceled', 'failed') do nothing
  returning id into v_order_id;

  if v_order_id is null then
    return jsonb_build_object('booked', false, 'heldSize', v_held,
                              'lossUsd', round(v_avg * v_held, 6), 'reason', 'already booked');
  end if;

  -- proceeds $0 for the full residual — the N1 SELL leg that realizes the loss.
  insert into public.live_fills (order_id, fill_price, fill_size, fill_notional)
  values (v_order_id, 0, v_held, 0);

  return jsonb_build_object('booked', true, 'heldSize', v_held,
                            'lossUsd', round(v_avg * v_held, 6), 'clientOrderId', v_cid);
end;
$$;

revoke all on function public.bot_order_record_resolution_loss(text, text, text)
  from public, anon, authenticated;
grant  execute on function public.bot_order_record_resolution_loss(text, text, text)
  to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · dash_maker_exit_history — re-stated verbatim from 0079 EXCEPT each point ADDITIVELY carries
-- `cityErrors` (#21) from the stored view's top-level per-tick fetch-error count (the Edge handler threads
-- it — a partial tick is "a silent gate undercount"). Snapshots predating the field yield JSON null
-- (unknown, NOT zero). The /maker-exit trend filters degraded points on it + the 40-market gate floor.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_maker_exit_history(p_limit int default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v       jsonb;
  -- clamp: at least 1, at most the record_maker_exit_panel retention ceiling (200 rows ≈ 2 days @ */15). A caller
  -- asking for more than exists simply gets everything retained; 500 is a defensive hard cap on the scan.
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
begin
  perform public.operator_guard();
  with recent as (
    -- newest v_limit rows first (index-friendly: maker_exit_panel_captured_idx is captured_at desc) …
    select mep.captured_at, mep.view->'assumptions' as a, mep.view->'cityErrors' as ce
    from public.maker_exit_panel mep
    order by mep.captured_at desc
    limit v_limit
  ),
  ordered as (
    -- … then re-order ascending so the emitted series reads left→right on the sparkline.
    select captured_at, a, ce from recent order by captured_at asc
  )
  select jsonb_build_object(
    'generatedAt', now(),
    'n',           (select count(*) from ordered),
    'points', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',                o.captured_at,
        -- #1 maker-fill rate (§12 adverse selection) + its fill latency
        'makerFillRate',             o.a->'makerFillRate',
        'meanMakerFillLatencyTicks', o.a->'meanMakerFillLatencyTicks',
        -- #2 realized rebate ($) + the tier applied
        'realizedRebateUsd',         o.a->'realizedRebateUsd',
        'rebateRateUsed',            o.a->'rebateRateUsed',
        -- observed round-trip cost the maker exit recovers (context for the rebate line)
        'meanObservedEntrySpread',   o.a->'meanObservedEntrySpread',
        'meanObservedExitSpread',    o.a->'meanObservedExitSpread',
        -- #4 reward-qualifying tick frac + its raw numerator/denominator (sample size)
        'qualifyingTickFrac',        o.a->'qualifyingTickFrac',
        'nQualifyingRestingTicks',   o.a->'nQualifyingRestingTicks',
        'nRestingTicks',             o.a->'nRestingTicks',
        -- #4b v2 "WHY zero" pool-context extension
        'meanDistFromMidPp',         o.a->'meanDistFromMidPp',
        'fracWithinAdvertisedBand',  o.a->'fracWithinAdvertisedBand',
        'fracFailsMinSize',          o.a->'fracFailsMinSize',
        'dominantDisqualifier',      o.a->'dominantDisqualifier',
        -- #3 temporal extent (the CI narrows as these grow)
        'nMarkets',                  o.a->'nMarkets',
        'nCities',                   o.a->'nCities',
        'nDistinctDays',             o.a->'nDistinctDays',
        -- 0084 #21: the tick's per-city fetch-error count — the degradation marker the trend filters on.
        -- Older snapshots without the key → JSON null (unknown), never fabricated 0.
        'cityErrors',                o.ce
      ) order by o.captured_at asc)
      from ordered o
    ), '[]'::jsonb)
  ) into v;
  return coalesce(v, jsonb_build_object('generatedAt', now(), 'n', 0, 'points', '[]'::jsonb));
end;
$$;

revoke all on function public.dash_maker_exit_history(int) from public, anon, authenticated;
grant  execute on function public.dash_maker_exit_history(int) to authenticated, service_role;
