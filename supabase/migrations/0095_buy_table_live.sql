-- 0095_buy_table_live.sql — the BUY-TABLE LIVE lane (cloud tick), staged behind the unchanged interlock.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator directive 2026-07-11, explicit): replace the local maker-exit daemon as "the buying function"
-- with a CLOUD (Edge Function + pg_cron) lane implementing the BUY-TABLE model — buy OUR predicted daily-high
-- bucket as a TAKER, only while its executable ask ≤ $0.15, at the C25 sweet-spot lead (≤12h before close),
-- hold to resolution (no exits). The operator KNOWS the measured record is negative (BUY-TABLE.md: KILL —
-- calibrated-book −9.2% ROI, day-CI [−62.9%, +56.8%], an underpowered wash leaning negative) and has
-- explicitly chosen to run it live small. The interlock + override architecture stays intact and gates every
-- placement: a live post still needs TRADE_MODE=live (Edge secret) AND trade_config.mode='live' AND
-- trade_live_preflight('buy-table').ok — which itself needs an open run window and a forward-paper PASS or an
-- ACTIVE (expiring) trade_gate_override row, with the N1 daily-loss kill un-tripped.
--
-- WHAT:
--   1. config defaults      — buy_table.price_cap 0.15 · buy_table.lead_max_h 12 · buy_table.lead_min_h 2
--                             (no entries in the final 2h — the record shows near-close entries are the
--                             worst: 6h ROI −98% on the flat book / a 3-bet fluke on the calibrated one) ·
--                             buy_table.tick_enabled true. Seeded on-conflict-DO-NOTHING so a re-apply never
--                             clobbers an operator edit.
--   2. buy_table_entries    — the lane's ledger read (service-role): EVERY live_orders row (ANY status) with
--                             strategy='buy-table'/side=BUY/purpose=entry for a mode. Feeds BOTH the
--                             one-entry-per-market-EVER gate (a terminal 'failed' row still blocks re-entry —
--                             stricter than the partial-unique index, which frees terminal keys) and the
--                             hold-to-close resolution-loss booking sweep. jsonb OBJECT envelope {rows:[…]}.
--   3. trade_live_preflight(text) — re-stated with a 'buy-table' branch: the SAME checks as the generic
--                             maker-exit branch (mode live · run window · stake ≤ per-position cap · forward
--                             gate PASS or ACTIVE override · N1 daily-loss kill), its checks payload tagged
--                             strategy='buy-table'. The 'city-taker' branch and the maker-exit default are
--                             byte-equivalent to 0085 §13 (the no-arg delegator is untouched).
--   4. buy_table_deadman_check() — day-bucketed (0092 policy: one page per sub-check per UTC day):
--                             (a) job_runs staleness for 'buy-table-tick' (> buy_table.tickStaleMin, default
--                             30 min = 3 missed */10 ticks); (b) the last buy_table.degradedWindow (default 6)
--                             ok-runs ALL degraded (discovery broken while the cron looks alive).
--   5. Slack allowlist      — append (0089 §5.5 token-equality idiom) the kinds that must PUSH through the
--                             prod pause gate: BUY_TABLE_DEADMAN · BUY_TABLE_DEGRADED · BUY_TABLE_POST_FAILED ·
--                             ORDER_FAIL · ORDER_NEEDS_RECONCILE (the executor's live-money CRITICALs — the
--                             local daemon bypassed the DB gate via a raw webhook; the cloud lane cannot).
--                             Everything else in the lane stays structured logs.
--   6. crons                — 'buy-table-tick' every 10 min (http_post; the per-tick periodKey is stamped in
--                             the request BODY at fire time — the §8.1 idiom) + 'buy-table-deadman' every
--                             15 min (pure-SQL, like the 0066/0089 deadmen). Cron count 33 → 35.
--
-- Rollback: select cron.unschedule('buy-table-tick'); select cron.unschedule('buy-table-deadman');
--           drop function public.buy_table_entries(text); drop function public.buy_table_deadman_check();
--           re-apply 0085 §13 to restore the two-branch trade_live_preflight(text); delete from config where
--           key like 'buy_table.%'; (the allowlist kinds can be trimmed by editing alerts_slack_allow_kinds).
--
-- 0081 TRIPWIRE COMPLIANCE: buy_table_entries takes an arg but STILL returns a jsonb OBJECT envelope (the
-- money path gets no exceptions — the bot_order_list_dangling precedent); buy_table_deadman_check() returns a
-- jsonb OBJECT. No set-returning function shapes anywhere. Idempotent-safe like every sibling
-- (create-or-replace / if-not-exists / on-conflict).

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · config defaults — the lane's tunables (operator edits survive a re-apply)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.config (key, value) values
  ('buy_table.price_cap',    '0.15'),
  ('buy_table.lead_max_h',   '12'),
  ('buy_table.lead_min_h',   '2'),
  ('buy_table.tick_enabled', 'true')
on conflict (key) do nothing;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · buy_table_entries(p_mode) — the lane's ledger read (service-role only, OBJECT envelope)
-- ANY-status rows on purpose: the one-entry-per-market-EVER gate must also see terminal 'failed'/'canceled'
-- rows (the partial-unique (mode,intent_key) index frees those keys — re-reservable by design for the
-- maker-exit reprice path — but the BUY-TABLE lane never re-enters or chases). The partial index keeps the
-- scan off the maker-exit/city-taker rows.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create index if not exists live_orders_buy_table_idx
  on public.live_orders (mode, created_at)
  where strategy = 'buy-table';

create or replace function public.buy_table_entries(p_mode text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
    'marketId',    o.market_id,
    'tokenId',     o.token_id,
    'tradeDate',   o.trade_date,
    'intentKey',   o.intent_key,
    'status',      o.status,
    'sizeMatched', o.size_matched,
    'createdAt',   o.created_at
  ) order by o.created_at), '[]'::jsonb))
  from public.live_orders o
  where o.mode = p_mode
    and o.strategy = 'buy-table'
    and o.side = 'BUY'
    and o.purpose = 'entry';
$$;

revoke all on function public.buy_table_entries(text) from public, anon, authenticated;
grant  execute on function public.buy_table_entries(text) to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · trade_live_preflight(p_strategy) — re-stated with the 'buy-table' branch.
--   'city-taker'  → 0085 §13 verbatim (toggle-is-the-authorization; no bot_gate_snapshot read).
--   'buy-table'   → the GENERIC interlock (identical checks to the maker-exit branch: mode live · run window ·
--                   stake ≤ per-position cap · forward-paper PASS OR active override · N1 daily-loss kill),
--                   checks tagged strategy='buy-table'. The operator's chosen unlock for this lane is the
--                   EXPIRING trade_gate_override (≤14d) — the forward paper gate of record is a settled KILL.
--   default       → maker-exit, byte-equivalent to the post-0084/0085 body (the no-arg delegator untouched).
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
  v_checks           jsonb;
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
  -- CITY-TAKER branch (0085 §13 verbatim). Does NOT read bot_gate_snapshot; does NOT check promotion status.
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
  -- GENERIC interlock — the maker-exit checks (byte-equivalent to the post-0084/0085 body), shared with the
  -- 'buy-table' branch: identical blocking conditions, only the returned checks payload differs (the
  -- buy-table lane's is tagged strategy='buy-table'; the maker-exit/no-arg output stays byte-identical —
  -- the 0085 city-live tests pin "no 'strategy' key" on the no-arg delegator).
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

  v_checks := jsonb_build_object(
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
  );
  -- the 0095 branch tag: buy-table returns the GENERIC verdict tagged with its strategy; the maker-exit /
  -- no-arg output stays byte-identical (the 0085 city-live tests pin "no 'strategy' key" on the delegator).
  if p_strategy = 'buy-table' then
    v_checks := jsonb_build_object('strategy', 'buy-table') || v_checks;
  end if;

  return jsonb_build_object(
    'ok', cardinality(v_reasons) = 0,
    'reasons', to_jsonb(v_reasons),
    'checks', v_checks
  );
end;
$$;

revoke all on function public.trade_live_preflight(text) from public, anon, authenticated;
grant  execute on function public.trade_live_preflight(text) to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · buy_table_deadman_check() — day-bucketed (0092 policy: max 1 page per sub-check per UTC day)
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.buy_table_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stale_min  numeric := coalesce((select value::numeric from config where key = 'buy_table.tickStaleMin'), 30);
  v_window     int     := coalesce((select value::int from config where key = 'buy_table.degradedWindow'), 6);
  v_latest     timestamptz;
  v_age_min    numeric;
  v_n          int;
  v_deg        int;
  v_alarmed    boolean := false;
  v_bucket     text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');  -- one page per UTC day (0092 policy)
begin
  -- (1) tick staleness — the cron/fn stopped running (arms only once a run exists; a fresh deploy stays silent).
  select max(started_at) into v_latest from public.job_runs where job = 'buy-table-tick';
  if v_latest is not null then
    v_age_min := extract(epoch from (now() - v_latest)) / 60;
    if v_age_min > v_stale_min then
      v_alarmed := true;
      perform public.claim_alert('BUY_TABLE_DEADMAN', 'CRITICAL', 'buy-table-deadman:stale:' || v_bucket,
        'buy-table-tick is STALE',
        'newest buy-table-tick job_runs row is ' || round(v_age_min, 1) || ' min old (> ' || v_stale_min ||
        ' min threshold ≈ 3 missed */10 ticks). The BUY-TABLE live lane has stopped ticking — no entries are '
        || 'being evaluated and resolution losses are not being booked into the daily-loss kill. Check the '
        || 'buy-table-tick cron + edge fn.');
    end if;

    -- (2) all-degraded — the cron looks alive but EVERY recent ok-run marked itself degraded (discovery /
    -- ledger reads failing): the lane is scanning blind while job_runs stays green. Requires a full window.
    select count(*), count(*) filter (where stats->>'degraded' = 'true')
      into v_n, v_deg
    from (
      select stats from public.job_runs
      where job = 'buy-table-tick' and status = 'ok'
      order by started_at desc limit v_window
    ) q;
    if v_n >= v_window and v_deg = v_n then
      v_alarmed := true;
      perform public.claim_alert('BUY_TABLE_DEADMAN', 'CRITICAL', 'buy-table-deadman:degraded:' || v_bucket,
        'buy-table-tick is DEGRADED every tick',
        'the last ' || v_window || ' completed buy-table-tick runs ALL marked themselves degraded — the '
        || 'discovery read (convergence_capture_inputs) or the lane ledger read (buy_table_entries) is failing '
        || 'while the cron itself looks healthy. No candidates can be evaluated. Check the DB reads / '
        || 'statement timeouts.');
    end if;
  end if;

  return jsonb_build_object('checkedAt', now(), 'latestRunAt', v_latest, 'ageMin', v_age_min,
                            'window', v_window, 'degradedInWindow', v_deg, 'alarmed', v_alarmed);
end;
$$;

revoke all on function public.buy_table_deadman_check() from public, anon, authenticated;
grant  execute on function public.buy_table_deadman_check() to service_role;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · Slack allowlist — the lane's push-worthy kinds must survive the prod global pause (0089 §5.5
-- token-equality append idiom; the 0092 routing stays otherwise untouched). ORDER_FAIL / ORDER_NEEDS_RECONCILE
-- are the T1 executor's live-money CRITICALs: the LOCAL daemon bypassed the DB gate via a raw webhook, but the
-- cloud lane notifies through notifySlack → claim_alert, so without this they would be SILENTLY suppressed.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_kinds text := coalesce((select value from config where key = 'alerts_slack_allow_kinds'), '');
  v_kind  text;
begin
  foreach v_kind in array array['BUY_TABLE_DEADMAN','BUY_TABLE_DEGRADED','BUY_TABLE_POST_FAILED','ORDER_FAIL','ORDER_NEEDS_RECONCILE'] loop
    if not (v_kind = any(string_to_array(v_kinds, ','))) then
      v_kinds := case when v_kinds = '' then v_kind else v_kinds || ',' || v_kind end;
    end if;
  end loop;
  insert into config (key, value) values ('alerts_slack_allow_kinds', v_kinds)
    on conflict (key) do update set value = v_kinds, updated_at = now();
end $$;

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · crons — the */10 edge tick (per-tick periodKey stamped in the BODY at fire time, §8.1) + the
-- */15 pure-SQL deadman. Same Vault-secret pattern as 0066/0089; cron.schedule upserts by name (idempotent).
-- The operator deploys the buy-table-tick edge fn alongside applying this migration — until then the cron
-- POST 404s harmlessly and the deadman stays silent (it arms only once a job_runs row exists).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping buy-table-tick registration';
    return;
  end if;

  -- §8.1: the periodKey is stamped INTO the request body at fire time (now() evaluates per fire), so every
  -- tick claims its own 10-min slot — a retrigger with a custom body periodKey never collides with it.
  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/buy-table-tick',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  body := jsonb_build_object('periodKey', 'buy-table-tick:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI')),
  timeout_milliseconds := 10000
)$cmd$;

  perform cron.schedule('buy-table-tick', '*/10 * * * *', edge_command);
  perform cron.schedule('buy-table-deadman', '*/15 * * * *', 'select public.buy_table_deadman_check();');
end;
$$;
