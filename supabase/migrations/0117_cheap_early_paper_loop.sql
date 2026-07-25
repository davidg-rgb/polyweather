-- 0117_cheap_early_paper_loop.sql — the forward CHEAP-EARLY-ENTRY paper loop (CHEAP-EARLY-ENTRY-FORWARD-HANDOFF.md).
--
-- THE THESIS BEING MEASURED. The operator's 2026-07-25 proposal (docs/ops/CHEAP-EARLY-ENTRY.md): buy our
-- house-pick bucket EARLY — in the [24,36]h-to-close band, NOT the final [2,12]h lost-causes window — capped at a
-- cheap ask that pays ≥3× (0.20–0.33), and HOLD TO RESOLUTION. On the ~1 month of real book we have it is the
-- FIRST cheap-buy variant that survives its cheap gates (timing works; the spread ~0.3c + house-pick depth
-- $130–310 are ample — cost is NOT the wall) but it has NOT been shown +EV (the +1.2pp gap sits inside the
-- round-trip cost; the small real-book cells straddle 0 by ±100%). VERDICT: INSUFFICIENT — not KILL, not GO. It
-- earns a FORWARD PAPER TEST, never capital. This loop scores it forward on the live opening_captures book and
-- lets the frozen §9R-E gate adjudicate as days accrue — no capital until a frozen PASS across ≥2 non-overlapping
-- windows + an explicit operator decision (the standing rule). PAPER ONLY; the bot rail stays DORMANT
-- (FINDINGS.md, the 12th signal). Claude builds the software; the operator funds/keys/authorizes; Claude never
-- trades, never touches credentials.
--
-- THE DESIGN (the maker-exit paper loop's simpler twin — 0073). An HOURLY Edge tick (the panel only changes as
-- events resolve — hourly is plenty) pulls the fresh-allowlist capture series PER CITY (convergence_capture_inputs
-- — the SAME inputs the taker bracket / maker-exit views use; it already carries every field the cheap-early
-- engine reads: idx, label, bestAsk, depthUsd, houseProb, resolvesAt), runs the PURE cheap-early replay view
-- (core/sim/cheap-early-entry-view → replayCheapEarlyPanel), and stores the small view. It REUSES the existing
-- capture stream + engine wholesale (no new fetcher, no live-execution state machine). Read-only against the DB
-- inputs; no external API, no packages/trading.
--
-- ── SAFETY: WHY source='forward-cheap-early' (a DISTINCT source, NOT bare 'forward'). ────────────────────────
-- trade_live_preflight(p_strategy) — the LIVE-MONEY interlock the running buy-table lane calls (0095 §3) — unlocks
-- capital when the latest `bot_gate_snapshot WHERE mode='paper' AND source='forward'` row is label='PASS', with NO
-- strategy filter. Writing this PAPER panel's verdict as source='forward' would therefore create a path where a
-- cheap-early paper PASS unlocks a DIFFERENT strategy's real money. So this loop tags its gate rows with a DISTINCT
-- source that every capital/alarm path (trade_live_preflight, dash_maker_exit, bot_deadman_check) filters OUT by
-- their exact source='forward' match — cheap-early is structurally invisible to all of them. The bot_gate_snapshot
-- source CHECK is extended (additively) to allow the new value; no existing row is invalidated and no live-money
-- function is touched. This deviates from the handoff's literal "source='forward'" precisely to honor its
-- non-negotiable boundary: a paper loop must never be able to unlock capital.
--
-- This migration adds: (1) the extended bot_gate_snapshot source CHECK; (2) the cheap_early_panel snapshot table +
-- record/read RPCs; (3) record_cheap_early_gate (writes the §9R-E verdict with source='forward-cheap-early' pinned);
-- (4) dash_cheap_early (operator read); (5) config seeds (cities widening + the pause + the frozen-param mirror);
-- (6) the hourly cheap-early-panel cron on a clean :47 minute lane.

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · extend the bot_gate_snapshot source CHECK (additive — allow 'forward-cheap-early')
-- Drops whatever CHECK constraint currently governs `source` (auto-named bot_gate_snapshot_source_check in the
-- 0066 base, but looked up defensively) and re-adds it as the SUPERSET. Purely additive: 'backtest' + 'forward'
-- stay valid, so every existing row + the maker-exit-panel writer + any backtest writer are unaffected.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.bot_gate_snapshot'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%source%'
  loop
    execute format('alter table public.bot_gate_snapshot drop constraint %I', c.conname);
  end loop;
  alter table public.bot_gate_snapshot
    add constraint bot_gate_snapshot_source_check
    check (source in ('backtest', 'forward', 'forward-cheap-early'));
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · cheap_early_panel — the forward-paper view snapshot (mirror maker_exit_panel / 0073)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.cheap_early_panel (
  id          bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  view        jsonb       not null
);
create index if not exists cheap_early_panel_captured_idx on public.cheap_early_panel (captured_at desc);

comment on table public.cheap_early_panel is
  'Forward cheap-early-entry paper view snapshots (cheap-early-panel Edge tick, hourly): logged [24,36]h '
  'house-pick entries held to resolution + the measured reads (net-return CI, win rate, spread/depth) + the '
  '§9R-E gate. Analytics-only; the bot rail stays DORMANT until a frozen paper PASS + an operator decision '
  '(CHEAP-EARLY-ENTRY-FORWARD-HANDOFF.md).';

-- RLS on (ADR-13): written only by record_cheap_early_panel (security definer); read only via dash_cheap_early.
alter table public.cheap_early_panel enable row level security;

create or replace function public.record_cheap_early_panel(p_view jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.cheap_early_panel (captured_at, view)
  values (now(), coalesce(p_view, '{}'::jsonb))
  returning id into v_id;
  -- keep the table small: retain the latest 200 snapshots (~8 days at the hourly cadence).
  delete from public.cheap_early_panel
   where id < (select min(id) from (select id from public.cheap_early_panel order by id desc limit 200) k);
  return v_id;
end;
$$;

revoke all on function public.record_cheap_early_panel(jsonb) from public, anon, authenticated;
grant  execute on function public.record_cheap_early_panel(jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · record_cheap_early_gate — persist the forward §9R-E verdict with source='forward-cheap-early' PINNED
-- Mode='paper' + source='forward-cheap-early' are HARDCODED here (never read from the payload) so this loop can
-- NEVER write a source='forward' row that trade_live_preflight would read as a live-capital unlock. The history is
-- kept (never pruned) so the operator watches the clustered CI narrowing over forward days (the §9R-E driver).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.record_cheap_early_gate(p_payload jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.bot_gate_snapshot
    (computed_at, mode, source, label, n_markets, n_cities, n_distinct_days, win_frac, mean_net_return,
     ci_low, ci_high, zero_skill_pass_rate, reason, total_net_usd, n_open)
  values (
    now(),
    'paper',                 -- PINNED — a paper loop, never live
    'forward-cheap-early',   -- PINNED — the distinct source: invisible to trade_live_preflight's source='forward'
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
    nullif(p_payload->>'totalNetUsd', '')::numeric,
    nullif(p_payload->>'nOpen', '')::int
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.record_cheap_early_gate(jsonb) from public, anon, authenticated;
grant  execute on function public.record_cheap_early_gate(jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · dash_cheap_early — operator read of the LATEST snapshot view (security definer + operator_guard)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_cheap_early()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'generatedAt', cep.captured_at,
    'view',        cep.view,
    -- the latest persisted forward §9R-E verdict for THIS loop (source='forward-cheap-early'), for the header.
    'gateSnapshot', (
      select jsonb_build_object(
        'computedAt', g.computed_at, 'label', g.label, 'nMarkets', g.n_markets, 'nCities', g.n_cities,
        'nDistinctDays', g.n_distinct_days, 'winFrac', g.win_frac, 'meanNetReturn', g.mean_net_return,
        'ciLow', g.ci_low, 'ciHigh', g.ci_high, 'zeroSkillPassRate', g.zero_skill_pass_rate,
        'totalNetUsd', g.total_net_usd, 'nOpen', g.n_open, 'reason', g.reason)
      from public.bot_gate_snapshot g
      where g.mode = 'paper' and g.source = 'forward-cheap-early'
      order by g.computed_at desc, g.id desc limit 1
    )
  )
  into v
  from public.cheap_early_panel cep
  order by cep.captured_at desc
  limit 1;
  return coalesce(v, jsonb_build_object('generatedAt', null, 'view', null, 'gateSnapshot', null));
end;
$$;

revoke all on function public.dash_cheap_early() from public, anon, authenticated;
grant  execute on function public.dash_cheap_early() to authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · config — the cheap-early operational knobs. Only `cities` (the allowed widening) + `enabled` (the
-- pause) are READ by the Edge tick; window/ask_band/stake are pinned in CODE (CHEAP_EARLY_DEFAULTS — so the loop
-- never mutates shared bot.* keys) and mirrored here for OPS VISIBILITY only. Not in the 0066 BOT_DEFAULTS mirror,
-- so the F10-r8-FP equality test is unaffected (same pattern as 0073's bot.tickStaleMin.paper).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.config (key, value) values
  ('cheap_early.cities',   '["ankara","helsinki","kuala-lumpur","wellington"]'), -- the frozen 4; widening is the one allowed variation
  ('cheap_early.enabled',  '1'),          -- the pause gate (0 = the Edge tick skips the compute)
  ('cheap_early.window_h', '[24,36]'),    -- MIRROR (authoritative in code): the hours-to-close entry band
  ('cheap_early.ask_band', '[0.20,0.33]'),-- MIRROR: the cheap-ask band (≥3× cap)
  ('cheap_early.stake_usd','20')          -- MIRROR: the paper stake + the executable-depth floor
on conflict (key) do nothing;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · cron: HOURLY cheap-early-panel tick on a CLEAN :47 minute lane (NOT :00/:15/:30/:45 — the Micro
-- pileup gotcha; :47 collides with no existing cron). Same Vault-secret http_post pattern as 0073's maker-exit
-- cron. The Edge fn ACKs fast (202) + runs in waitUntil; the 4500ms http timeout is the project convention.
-- Idempotent; PGlite skips via the guard. The operator deploys the cheap-early-panel edge fn alongside applying
-- this migration (until then the cron POST 404s harmlessly).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping cheap-early-panel registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/cheap-early-panel',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('cheap-early-panel', '47 * * * *', edge_command);
end;
$$;
