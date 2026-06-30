-- 0073_maker_exit_paper_loop.sql — the forward MAKER-EXIT paper loop (MAKER-EXIT-PAPER-LOOP-HANDOFF.md).
--
-- THE THESIS BEING MEASURED. MAKER-EXIT-SIM.md found the maker exit FLIPS the convergence edge positive
-- (−3.0% taker → +1.8%/+5.1%/+$313 maker) — the first +EV config in twelve signals — but the §9R-E gate KILLs
-- on a 17-day clustered CI whose lower bound sits just below 0. That result rests on THREE assumptions a
-- backtest cannot resolve: (1) a resting maker SELL fills when a later bid reaches the limit (the real fill
-- rate / §12 adverse selection), (2) the maker rebate tier, (3) only 17 days of extent. This loop MEASURES all
-- three FORWARD on the real `opening_captures` book and lets the frozen §9R-E gate adjudicate — no capital,
-- ever, until a frozen paper PASS + an explicit operator decision (the boundary §8: Claude builds; the operator
-- funds + holds the signing key; Claude never trades).
--
-- THE DESIGN (analytics-pivot consistent). The loop is the maker-exit twin of convergence-panel (0069): a
-- 15-min Edge tick pulls the fresh-allowlist capture series PER CITY (convergence_capture_inputs), runs the PURE
-- maker-exit replay view (core/sim/opening-maker-exit-view → replayMakerExitPanel), and stores the small view.
-- It REUSES the existing capture stream + replay engine wholesale (no new fetcher, no live-execution state
-- machine — that is the deferred post-PASS live step). The §9R-E verdict is ALSO persisted to bot_gate_snapshot
-- (source='forward') so bot_deadman_check watches it. Read-only against the DB inputs; no external API, no
-- packages/trading — the bot rail stays paper/DORMANT (FINDINGS.md, the 12th signal).
--
-- This migration adds: (1) bestBid to the shared convergence_capture_inputs bucket trim (the maker-exit spread
-- diagnostic reads it); (2) the maker_exit_panel snapshot table + record/read RPCs; (3) additive maker-exit
-- aggregate columns on bot_gate_snapshot + a service-role insert RPC; (4) a bot_tick_log insert RPC; (5) the
-- dash_maker_exit operator read; (6) a cadence-aware bot_deadman tick threshold (bot.tickStaleMin) so the
-- periodic loop's forensic tick log does not false-alarm; (7) the maker-exit-panel cron.

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · share the sell-side `bestBid` into convergence_capture_inputs (additive bucket field)
-- The maker-exit replay's observed-spread diagnostic (observedEntrySpread/observedExitSpread = bestAsk − bestBid)
-- reads bestBid; the trimmed bucket in 0069 omitted it (the taker bracket view never needed it). Adding it is
-- purely additive — the bracket replay ignores it. Everything else is byte-identical to the 0069 definition.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.convergence_capture_inputs(
  p_days   int    default 21,
  p_cities text[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '40s'
as $$
declare
  v        jsonb;
  v_days   int    := greatest(coalesce(p_days, 21), 1);
  v_cities text[] := coalesce(p_cities, array[]::text[]);
begin
  with fresh as (
    select event_id
      from public.opening_captures
     where captured_at > now() - (v_days || ' days')::interval
       and event_id is not null
       and city = any(v_cities)
     group by event_id
    having min(hours_since_listing) < 1
  ),
  ranked as (
    select oc.*,
           row_number() over (partition by oc.event_id order by oc.captured_at) as rn,
           count(*)     over (partition by oc.event_id)                          as cnt
    from public.opening_captures oc
    join fresh f on f.event_id = oc.event_id
    where oc.captured_at > now() - (v_days || ' days')::interval
  ),
  caps as (
    -- downsample to ~every 3rd tick (≈6-min) + always the last tick; the replay is robust to ~6-min granularity.
    select
      s.event_id::text                 as "eventId",
      s.captured_at::text              as "capturedAt",
      s.city                           as "city",
      s.target_date::text              as "targetDate",
      s.tz_name                        as "tzName",
      s.created_at_gamma::text         as "createdAtGamma",
      s.resolves_at::text              as "resolvesAt",
      s.hours_since_listing::float8    as "hoursSinceListing",
      s.peak_mid::float8               as "peakMid",
      s.is_flat_open                   as "isFlatOpen",
      s.house_seeded                   as "houseSeeded",
      s.ev_vol24h::float8              as "evVol24h",
      s.neg_risk                       as "negRisk",
      -- DECISION-read fields (a future trim edit MUST keep all of these): idx, houseProb, execAsk, depthUsd,
      -- bestAsk, execBid (label is display-only). bestBid is the MAKER-EXIT spread diagnostic (0073) — added so
      -- observedEntry/ExitSpread (bestAsk − bestBid) is populated; the taker bracket replay ignores it.
      (select jsonb_agg(jsonb_build_object(
         'idx', b->'idx', 'label', b->'label', 'bestAsk', b->'bestAsk', 'execAsk', b->'execAsk',
         'execBid', b->'execBid', 'bestBid', b->'bestBid', 'depthUsd', b->'depthUsd', 'houseProb', b->'houseProb')
       order by (b->>'idx')::int)
       from jsonb_array_elements(s.buckets) b)   as "buckets"
    from ranked s
    where s.rn % 3 = 1 or s.rn = s.cnt
    order by s.event_id, s.captured_at
  ),
  res as (
    select
      me.id::text as "id",
      coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx)::int as "winnerIdx",
      (me.grading_mismatch = true)                                       as "gradingMismatch"
    from public.market_events me
    where me.id in (select event_id from fresh)
  )
  select jsonb_build_object(
    'captures',    coalesce((select jsonb_agg(to_jsonb(caps)) from caps), '[]'::jsonb),
    'resolutions', coalesce((select jsonb_agg(to_jsonb(res)) from res), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

revoke all on function public.convergence_capture_inputs(int, text[]) from public, anon, authenticated;
grant  execute on function public.convergence_capture_inputs(int, text[]) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · maker_exit_panel — the forward-paper view snapshot (mirror convergence_panel / 0069)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.maker_exit_panel (
  id          bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  view        jsonb       not null
);
create index if not exists maker_exit_panel_captured_idx on public.maker_exit_panel (captured_at desc);

comment on table public.maker_exit_panel is
  'Forward maker-exit paper view snapshots (maker-exit-panel Edge tick, every 15 min): entries + the three '
  'measured assumptions (maker-fill rate, realized rebate, days) + the §9R-E gate. Analytics-only; the bot rail '
  'stays paper/DORMANT until a frozen paper PASS + an operator decision (MAKER-EXIT-PAPER-LOOP-HANDOFF.md).';

-- RLS on (ADR-13): written only by record_maker_exit_panel (security definer); read only via dash_maker_exit.
alter table public.maker_exit_panel enable row level security;

create or replace function public.record_maker_exit_panel(p_view jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.maker_exit_panel (captured_at, view)
  values (now(), coalesce(p_view, '{}'::jsonb))
  returning id into v_id;
  -- keep the table small: retain the latest 200 snapshots (~2 days at 15-min cadence).
  delete from public.maker_exit_panel
   where id < (select min(id) from (select id from public.maker_exit_panel order by id desc limit 200) k);
  return v_id;
end;
$$;

revoke all on function public.record_maker_exit_panel(jsonb) from public, anon, authenticated;
grant  execute on function public.record_maker_exit_panel(jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · bot_gate_snapshot — additive maker-exit aggregate columns + a service-role insert RPC
-- The forward §9R-E verdict is persisted here (source='forward') so bot_deadman_check watches the gate clock
-- AND the project keeps ONE gate-of-record across the taker + maker-exit variants. Columns are nullable/additive.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.bot_gate_snapshot add column if not exists maker_exit_frac     numeric; -- assumption #1 (maker-fill rate)
alter table public.bot_gate_snapshot add column if not exists realized_rebate_usd numeric; -- assumption #2 (realized rebate $)
alter table public.bot_gate_snapshot add column if not exists total_net_usd       numeric; -- paper net P&L over realized trades
alter table public.bot_gate_snapshot add column if not exists n_open              int;     -- still-open (mtm) paper positions

create or replace function public.record_bot_gate_snapshot(p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.bot_gate_snapshot
    (computed_at, mode, source, label, n_markets, n_cities, n_distinct_days, win_frac, mean_net_return,
     ci_low, ci_high, zero_skill_pass_rate, reason, maker_exit_frac, realized_rebate_usd, total_net_usd, n_open)
  values (
    now(),
    coalesce(p_payload->>'mode', 'paper'),
    coalesce(p_payload->>'source', 'forward'),
    coalesce(p_payload->>'label', 'INSUFFICIENT_DATA'),
    nullif(p_payload->>'nMarkets', '')::int,
    nullif(p_payload->>'nCities', '')::int,
    nullif(p_payload->>'nDistinctDays', '')::int,
    nullif(p_payload->>'winFrac', '')::numeric,
    nullif(p_payload->>'meanNetReturn', '')::numeric,
    nullif(p_payload->>'ciLow', '')::numeric,
    nullif(p_payload->>'ciHigh', '')::numeric,
    nullif(p_payload->>'zeroSkillPassRate', '')::numeric,
    p_payload->>'reason',
    nullif(p_payload->>'makerExitFrac', '')::numeric,
    nullif(p_payload->>'realizedRebateUsd', '')::numeric,
    nullif(p_payload->>'totalNetUsd', '')::numeric,
    nullif(p_payload->>'nOpen', '')::int
  )
  returning id into v_id;
  -- NO prune: the snapshot history is intentionally kept (the operator reads the §9R-E verdict EVOLVING — the
  -- clustered CI narrowing as forward days accrue). At 96 rows/day of scalar columns it stays tiny for months.
  return v_id;
end;
$$;

revoke all on function public.record_bot_gate_snapshot(jsonb) from public, anon, authenticated;
grant  execute on function public.record_bot_gate_snapshot(jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · bot_tick_log insert RPC (the loop liveness/forensics trail — F19; read by bot_deadman + /maker-exit)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.record_bot_tick(p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.bot_tick_log (as_of, mode, ran, placed, filled, exited, gate_reason, kill_reason)
  values (
    now(),
    coalesce(p_payload->>'mode', 'paper'),
    coalesce((p_payload->>'ran')::boolean, true),
    nullif(p_payload->>'placed', '')::int,
    nullif(p_payload->>'filled', '')::int,
    nullif(p_payload->>'exited', '')::int,
    p_payload->>'gateReason',
    p_payload->>'killReason'
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_bot_tick(jsonb) from public, anon, authenticated;
grant  execute on function public.record_bot_tick(jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · dash_maker_exit — operator read of the LATEST snapshot view (security definer + operator_guard)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_maker_exit()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'generatedAt', mep.captured_at,
    'view',        mep.view,
    -- the latest persisted forward §9R-E verdict (the gate-of-record the bot_deadman watches), for the page header.
    'gateSnapshot', (
      select jsonb_build_object(
        'computedAt', g.computed_at, 'label', g.label, 'nMarkets', g.n_markets, 'nCities', g.n_cities,
        'nDistinctDays', g.n_distinct_days, 'winFrac', g.win_frac, 'meanNetReturn', g.mean_net_return,
        'ciLow', g.ci_low, 'ciHigh', g.ci_high, 'zeroSkillPassRate', g.zero_skill_pass_rate,
        'makerExitFrac', g.maker_exit_frac, 'realizedRebateUsd', g.realized_rebate_usd,
        'totalNetUsd', g.total_net_usd, 'nOpen', g.n_open, 'reason', g.reason)
      from public.bot_gate_snapshot g
      where g.mode = 'paper' and g.source = 'forward'
      order by g.computed_at desc limit 1
    )
  )
  into v
  from public.maker_exit_panel mep
  order by mep.captured_at desc
  limit 1;
  return coalesce(v, jsonb_build_object('generatedAt', null, 'view', null, 'gateSnapshot', null));
end;
$$;

revoke all on function public.dash_maker_exit() from public, anon, authenticated;
grant  execute on function public.dash_maker_exit() to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · bot_deadman_check — make the tick-staleness threshold cadence-aware (bot.tickStaleMin)
-- The maker-exit paper loop ticks every 15 min (a periodic re-replay, NOT the 30s live tick the original
-- threshold (3× tickIntervalSec ⇒ 3 min) assumed) — so its forensic bot_tick_log rows would false-alarm. Read
-- an optional bot.tickStaleMin override (minutes); default preserves the original (3× tick interval) behavior so
-- the future live bot is UNCHANGED. The gate-snapshot staleness branch (bot.gateStaleMin, 180m) is unchanged.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.bot_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode        text    := coalesce((select value from config where key = 'tradingMode'), 'paper');
  v_tick_int    numeric := coalesce((select value::numeric from config where key = 'bot.tickIntervalSec'), 30);
  -- cadence-aware: an explicit bot.tickStaleMin (minutes) overrides the 3×-tick-interval default (0073) so a
  -- periodic re-replay loop's tick log does not false-alarm; absent ⇒ the original behavior, live bot unchanged.
  v_thresh_min  numeric := coalesce((select value::numeric from config where key = 'bot.tickStaleMin'), (v_tick_int * 3) / 60);
  v_gate_stale_min numeric := coalesce((select value::numeric from config where key = 'bot.gateStaleMin'), 180);
  v_last_tick   timestamptz;
  v_tick_age    numeric;
  v_last_gate   timestamptz;
  v_gate_age    numeric;
  v_alarmed     boolean := false;
  v_bucket      int := floor(extract(epoch from now()) / 1800)::int;
begin
  select max(as_of) into v_last_tick from public.bot_tick_log where mode = v_mode;
  if v_last_tick is not null then
    v_tick_age := extract(epoch from (now() - v_last_tick)) / 60;
    if v_tick_age > greatest(v_thresh_min, 3) then
      v_alarmed := true;
      perform public.claim_alert('BOT_DEADMAN', 'CRITICAL', 'bot-deadman:tick:' || v_mode || ':' || v_bucket,
        'opening-bot loop (' || v_mode || ') is STALE',
        'newest bot_tick_log row is ' || round(v_tick_age, 1) || ' min old (> ' || round(greatest(v_thresh_min, 3), 1) ||
        ' min). The forward run has stopped ticking — open positions are unmanaged + the gate clock stalls. '
        || 'Check the maker-exit-panel cron + edge fn (or the live opening-bot process + the lease).');
    end if;

    -- the gate-snapshot clock (the direct "experiment stopped advancing" signal).
    select max(computed_at) into v_last_gate from public.bot_gate_snapshot where mode = v_mode and source = 'forward';
    if v_last_gate is not null then
      v_gate_age := extract(epoch from (now() - v_last_gate)) / 60;
      if v_gate_age > v_gate_stale_min then
        v_alarmed := true;
        perform public.claim_alert('BOT_DEADMAN', 'CRITICAL', 'bot-deadman:gate:' || v_mode || ':' || v_bucket,
          'opening-bot forward gate (' || v_mode || ') is STALE',
          'newest forward bot_gate_snapshot is ' || round(v_gate_age, 1) || ' min old — the net-profit verdict '
          || 'has stopped advancing while the loop appears alive. Investigate the loop summary path.');
      end if;
    end if;
  end if;

  return jsonb_build_object('checkedAt', now(), 'mode', v_mode, 'lastTickAt', v_last_tick, 'tickAgeMin', v_tick_age,
                            'lastGateAt', v_last_gate, 'gateAgeMin', v_gate_age, 'alarmed', v_alarmed);
end;
$$;

revoke all on function public.bot_deadman_check() from public, anon, authenticated;
grant  execute on function public.bot_deadman_check() to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 7 · config — the maker-exit tick-staleness override (additive; not in the 0066 BOT_DEFAULTS mirror,
-- so the F10-r8-FP equality test is unaffected; the tuned maker-exit entry/exit params live in CODE
-- (MAKER_EXIT_TUNED) so the loop never mutates the shared bot.* keys opening-capture + convergence-panel read).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.config (key, value) values
  ('bot.tickStaleMin', '45')   -- 3× the 15-min maker-exit-panel cadence (the periodic re-replay loop's tick floor)
on conflict (key) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 8 · cron: 15-min maker-exit-panel tick (same Vault-secret pattern as 0069's convergence-panel).
-- The Edge fn ACKs fast (202) + runs in waitUntil, so the 4500ms http timeout is the project convention.
-- idempotent; PGlite skips via the guard. The operator deploys the maker-exit-panel edge fn alongside applying
-- this migration (until then the cron POST 404s harmlessly).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping maker-exit-panel registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/maker-exit-panel',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('maker-exit-panel', '*/15 * * * *', edge_command);
end;
$$;
