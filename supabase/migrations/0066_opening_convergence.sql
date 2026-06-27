-- 0066_opening_convergence.sql — Phase 0 of the OPENING-CONVERGENCE bot (the one scoped trading-rail
-- reactivation; ARCHITECTURE-OPENING-CONVERGENCE.md / PHASE-0-BUILD-HANDOFF.md).
--
-- THE THESIS: freshly-listed daily-Tmax markets open FLAT (~10–12%/bucket — uninformed book) and CONVERGE.
-- Buy our house_gaussian forecast-center buckets cheap at the flat open, sell back into the convergence on
-- bracket orders. The load-bearing unknown — is a usable house_gaussian even available WHILE the book is
-- still flat-open, with cheap depth — is MEASURED FORWARD by the keyless capture layer this migration builds
-- (Phase 0), then a hard Phase-0.5 go/no-go spike GATES everything else. Paper-first; no capital until a
-- frozen net-profit gate PASSes. Phase 0 is fully KEYLESS — no wallet, no money, no POLY_* secret.
--
-- This migration ships the WHOLE schema (9 tables; later phases need it) but Phase 0 only EXERCISES the
-- capture path. It adds:
--   1. seed-isolation `seeded` columns on bucket_probabilities + forecast_snapshots (F16-r9/F11-r10).
--   2. upsert_forecast_rows / upsert_distribution carry `seeded` (the bot on-demand seed tags its rows).
--   3. the FOUR consumer exclusions (dash_data / calib_scored_rows / dash_amsterdam_sim / poll_known_events)
--      that keep a scoped-city bot seed from becoming the scored champion — shipped WITH the seed (F11-r10).
--   4. the §9R liquid cities' cities.tz corrected to real DST-aware IANA names (C2/C2b — they default to
--      no-DST Etc/GMT±N, which DST-skews the local-noon time-stop).
--   5. the 9 bot tables (opening_captures + the 8 lifecycle/risk tables, built now, exercised later).
--   6. the capture/seed read+write RPCs: record_opening_captures, latest_house_dist, bot_latest_captures,
--      bot_capture_series.
--   7. BOTH deadmen (capture_deadman_check producer-side + bot_deadman_check consumer-side, mode-aware) —
--      Phase-0 objects so the Phase-5 PAPER forward run is alarmed, not just live (F35/F19/F13/F5).
--   8. the bot.* config MIRROR (code defaults are authoritative — packages/core opening-convergence
--      BOT_DEFAULTS; the equality is asserted by a test, F10-r8-FP) + the bot CRITICAL Slack-allowlist
--      append (F4-r8 — so the safety alarms survive the global Slack pause that is TRUE on prod).
--   9. grants (post-0034 contract).
--  10. crons: opening-capture (~every 2 min FIRST-SEEN poll — §16-D, the flat-open window is ≤~1h), the two
--      deadmen (every 10 min), and the retention prunes (F15-r10).
--
-- Read-only against Polymarket; no key, no packages/trading. The Phase-2 lifecycle/caps RPCs
-- (bot_fill_with_caps, bot_should_run, bot_open_position, …) land in a POST-GATE migration — Phase 2 is
-- gated on the Phase-0.5 spike = GO, and building them untested+unexercised now is exactly the premature
-- machinery the cheap gate exists to avoid.

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · seed-isolation columns (F16-r9/F11-r10)
-- A bot on-demand-seeded distribution/forecast is TAGGED so it is EXCLUDED from the analytics that score the
-- champion (an extra bot-cadence snapshot for a SCOPED city would otherwise become the argmax there). The
-- columns are nullable+default-false so the ADD is a fast metadata-only change (no table rewrite) and every
-- reader uses coalesce(seeded,false).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
alter table public.bucket_probabilities add column if not exists seeded boolean default false;
alter table public.forecast_snapshots   add column if not exists seeded boolean default false;

comment on column public.bucket_probabilities.seeded is
  'true = an opening-convergence bot on-demand seed (excluded from dash_data/calib_scored_rows/dash_amsterdam_sim/poll_known_events). 0066/F11-r10.';
comment on column public.forecast_snapshots.seeded is
  'true = a bot on-demand forecast snapshot (excluded from calibration). 0066/F11-r10.';

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · the reused write-RPCs carry `seeded`
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- upsert_forecast_rows: single jsonb arg → CREATE OR REPLACE (no signature change). Reads an optional
-- per-row `seeded` (default false); on conflict the latest writer's flag wins, so a production re-snapshot
-- of a row a bot seed wrote flips it back to false (self-healing).
create or replace function public.upsert_forecast_rows(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into forecast_snapshots (icao, model, target_date, lead_days, tmax_c, snapshot_slot, source, captured_at, seeded)
  select r.icao, r.model, r.target_date, r.lead_days, r.tmax_c, r.snapshot_slot, r.source, r.captured_at, coalesce(r.seeded, false)
  from jsonb_to_recordset(p_rows) as r(
    icao text, model text, target_date date, lead_days smallint, tmax_c numeric,
    snapshot_slot text, source text, captured_at timestamptz, seeded boolean
  )
  on conflict (icao, model, target_date, lead_days, snapshot_slot) do update
    set tmax_c = excluded.tmax_c, captured_at = excluded.captured_at, source = excluded.source, seeded = excluded.seeded;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- upsert_distribution: adding p_seeded CHANGES the arg signature → DROP the 9-arg version then CREATE the
-- 10-arg one (an overload would make the existing 9-named-arg callers ambiguous). The default keeps
-- build-distributions / discover-markets / metar-nowcast byte-identical (they don't pass p_seeded).
drop function if exists public.upsert_distribution(uuid, text, smallint, boolean, text, numeric[], numeric, numeric, integer);
create or replace function public.upsert_distribution(
  p_event_id uuid, p_source text, p_lead smallint, p_nowcast boolean,
  p_inputs_hash text, p_probs numeric[], p_mu numeric, p_sigma numeric, p_stats_version int,
  p_seeded boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted boolean;
begin
  insert into bucket_probabilities (event_id, source, lead_days, nowcast, made_at, inputs_hash, probs, mu_native, sigma_native, stats_version, seeded)
  values (p_event_id, p_source, p_lead, p_nowcast, now(), p_inputs_hash, p_probs, p_mu, p_sigma, p_stats_version, coalesce(p_seeded, false))
  on conflict (event_id, source, inputs_hash) do nothing
  returning true into v_inserted;
  return coalesce(v_inserted, false);
end;
$$;

revoke all on function public.upsert_distribution(uuid, text, smallint, boolean, text, numeric[], numeric, numeric, integer, boolean) from public, anon, authenticated;
grant  execute on function public.upsert_distribution(uuid, text, smallint, boolean, text, numeric[], numeric, numeric, integer, boolean) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · consumer exclusions (F11-r10 — ship WITH the seed)
-- Each is patched by reading its LIVE body via pg_get_functiondef and injecting the seeded exclusion — so we
-- never hand-transcribe a 250-line function (and never accidentally revert a later amendment). Idempotent:
-- each guard checks the post-edit signature is absent before patching. The seed writes BOTH house_gaussian
-- AND house_ensemble (distributions.ts), so amsterdam (a scoped city, read via house_ensemble) needs it too.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare src text;
begin
  -- dash_data (0065) — exclude bot seeds from the hg champion, the mc consensus, and the daily Brier set.
  src := pg_get_functiondef('public.dash_data(smallint)'::regprocedure);
  if position('coalesce(bp.seeded' in src) = 0 then
    src := replace(src, 'bp.source = ''house_gaussian'' and bp.nowcast = false',
                        'bp.source = ''house_gaussian'' and bp.nowcast = false and coalesce(bp.seeded, false) = false');
    src := replace(src, 'bp.source = ''market_consensus'' and bp.nowcast = false',
                        'bp.source = ''market_consensus'' and bp.nowcast = false and coalesce(bp.seeded, false) = false');
    src := replace(src, 'and bp.source in (''house_gaussian'', ''market_consensus'')',
                        'and bp.source in (''house_gaussian'', ''market_consensus'') and coalesce(bp.seeded, false) = false');
    execute src;
    raise notice '0066: dash_data patched to exclude bot-seeded distributions';
  end if;

  -- calib_scored_rows (0045) — bot-seeded dists must not be scored into the residual set / model_stats.
  src := pg_get_functiondef('public.calib_scored_rows(integer, date)'::regprocedure);
  if position('coalesce(bp.seeded' in src) = 0 then
    src := replace(src, 'and bp.scored_for_leads <> ''{}''::smallint[]',
                        'and bp.scored_for_leads <> ''{}''::smallint[] and coalesce(bp.seeded, false) = false');
    execute src;
    raise notice '0066: calib_scored_rows patched to exclude bot-seeded distributions';
  end if;

  -- dash_amsterdam_sim (0052) — amsterdam is a scoped city; its house_ensemble "our bucket" read must skip seeds.
  src := pg_get_functiondef('public.dash_amsterdam_sim()'::regprocedure);
  if position('coalesce(bp.seeded' in src) = 0 then
    src := replace(src, 'where bp.event_id = v_s_event and bp.source = ''house_ensemble''',
                        'where bp.event_id = v_s_event and bp.source = ''house_ensemble'' and coalesce(bp.seeded, false) = false');
    execute src;
    raise notice '0066: dash_amsterdam_sim patched to exclude bot-seeded distributions';
  end if;

  -- poll_known_events (0024) — the dormant bets/edge champion read must skip a scoped-event bot seed.
  src := pg_get_functiondef('public.poll_known_events(text[], text)'::regprocedure);
  if position('coalesce(bp.seeded' in src) = 0 then
    src := replace(src, 'where bp.event_id = me.id and bp.source = p_champion',
                        'where bp.event_id = me.id and bp.source = p_champion and coalesce(bp.seeded, false) = false');
    execute src;
    raise notice '0066: poll_known_events patched to exclude bot-seeded distributions';
  end if;
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 4 · cities.tz correction for the §9R liquid universe (C2/C2b / ADR-OC-12)
-- Auto-discovered cities are stored with a no-DST Etc/GMT±N zone (etcZoneForOffset). The bot's local-noon
-- time-stop must be DST-correct, so the scoped liquid cities are corrected to real IANA names. The capture
-- layer's tz read additionally fail-closes on any remaining Etc/* (isDstAwareIana), so a city not listed
-- here is simply never entered until corrected. The LIKE 'Etc/%' guard makes this idempotent + non-clobbering
-- (a manual correction is never overwritten). No-op on a fresh/test DB (cities are discovered, not seeded).
-- (China has no DST so Asia/Shanghai == the stored offset — the rename only un-blocks the Etc/* fail-closed
-- gate; amsterdam/madrid/paris are genuine DST corrections, currently zero-diff in CEST summer.)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
update public.cities set tz = 'Europe/Amsterdam',     updated_at = now() where slug = 'amsterdam'     and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',        updated_at = now() where slug = 'chengdu'       and tz like 'Etc/%';
update public.cities set tz = 'Asia/Manila',          updated_at = now() where slug = 'manila'        and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',        updated_at = now() where slug = 'qingdao'       and tz like 'Etc/%';
update public.cities set tz = 'Europe/Madrid',        updated_at = now() where slug = 'madrid'        and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',        updated_at = now() where slug = 'guangzhou'     and tz like 'Etc/%';
update public.cities set tz = 'Asia/Kuala_Lumpur',    updated_at = now() where slug = 'kuala-lumpur'  and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',        updated_at = now() where slug = 'beijing'       and tz like 'Etc/%';
update public.cities set tz = 'Asia/Shanghai',        updated_at = now() where slug = 'shanghai'      and tz like 'Etc/%';
update public.cities set tz = 'Europe/Paris',         updated_at = now() where slug = 'paris'         and tz like 'Etc/%';

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 5 · the 9 bot tables (built now; Phase 0 exercises only opening_captures)
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- 5.1 opening_captures — append-only, written by the keyless edge fn (the forward measurement harness).
create table if not exists public.opening_captures (
  id                  bigint generated always as identity primary key,
  captured_at         timestamptz not null,
  event_id            uuid references public.market_events(id),  -- nullable if pre-discovery
  city                text not null,
  target_date         date not null,                            -- station-local (C-6)
  tz_name             text not null,                            -- real IANA name (Etc/* rejected — C2/C2b)
  created_at_gamma    timestamptz,                              -- the event's TRUE Gamma listing time (flat-open anchor)
  listing_detected_at timestamptz,                              -- first tick we saw the event (diagnostic)
  resolves_at         timestamptz,                              -- the Gamma event endDate (F6)
  hours_since_listing numeric(6,2),                             -- now − created_at_gamma (listing-anchor fix)
  peak_mid            numeric(6,4),                             -- max bucket mid (flat-open input)
  is_flat_open        boolean not null default false,           -- peak ≤ 0.18 ∧ ≤~1h (§16-D)
  house_seeded        boolean not null default false,           -- was a fresh, quality-passing house_gaussian seeded (C1)
  buckets             jsonb,                                    -- [{idx,label,loF,hiF,mid,bestAsk,depthUsd,bestBid,sellbackUsd,houseProb,tokenYes,tokenNo,conditionId}]
  ev_vol24h           numeric(14,2),                            -- event 24h volume (the §9R $7k+ filter input)
  neg_risk            boolean not null default true             -- parseGammaEvent.negRiskMarketId != null (F2/F5)
);
create index if not exists oc_event_captured_idx on public.opening_captures (event_id, captured_at desc);
create index if not exists oc_flatopen_idx        on public.opening_captures (is_flat_open, captured_at desc) where is_flat_open;
create index if not exists oc_city_date_idx        on public.opening_captures (city, target_date, captured_at desc);
comment on table public.opening_captures is
  'Forward keyless capture of freshly-listed weather markets at the flat open: full bucket distribution + true '
  'CLOB depth + on-demand-seeded house_gaussian + listing age + flat-open flag. The Phase-0 forward harness + '
  'the Phase-0.5 go/no-go input. Append-only. opening-convergence bot, ARCHITECTURE-OPENING-CONVERGENCE.md.';
alter table public.opening_captures enable row level security;

-- 5.2 bot_positions — the lifecycle state of record (ADR-OC-4). Exercised in Phase 2; built now.
create table if not exists public.bot_positions (
  id                  uuid primary key default gen_random_uuid(),
  mode                text not null check (mode in ('paper','live')),
  event_id            uuid references public.market_events(id),
  city                text not null,
  target_date         date not null,
  tz_name             text not null,                            -- real IANA name (time-stop, C2); fail-closed without it
  bucket_idx          int not null,
  bucket_label        text not null,                            -- for identity alignment (W6)
  token_yes           text not null,                            -- venue placement id (F2-r8)
  condition_id        text not null,                            -- venue-INDEPENDENT redeem/resolve key (F2-r8)
  neg_risk            boolean not null default true,            -- NegRiskAdapter branch (F2/F5/F14c); weather default true
  state               text not null check (state in
                        ('intent','maker_resting','armed','exiting','closed','resolved','rejected','failed','exit_failed')),
  model_prob          numeric(6,4),
  entry_price         numeric(8,6),
  entry_shares        numeric(14,4),
  entry_fee_usd       numeric(12,6),
  maker_resting_since timestamptz,
  tp_price            numeric(8,6),
  sl_price            numeric(8,6),
  time_stop_at        timestamptz,                              -- localHourInstant(tz,target_date,noon) — DST-correct (F11)
  resolves_at         timestamptz,                              -- Gamma endDate — venue-independent resolution clock (F6)
  exit_in_flight_until timestamptz,                             -- the exit-path double-FAK guard (F4/F9)
  over_cap            boolean not null default false,           -- caps_exceeded_held dedupe (F3 → over_cap_halt)
  exit_price          numeric(8,6),
  realized_pnl_usd    numeric(12,6),
  exit_reason         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists bp_open_idx   on public.bot_positions (state) where state not in ('closed','resolved','rejected','failed');
create index if not exists bp_mode_date_idx on public.bot_positions (mode, target_date);
create index if not exists bp_mode_state_upd_idx on public.bot_positions (mode, state, updated_at);
-- the DB double-open belt (W2/F20): one open position per (event,bucket); exit_failed stays "open" (share-holding).
create unique index if not exists bp_one_open_per_bucket
  on public.bot_positions (event_id, bucket_idx)
  where state in ('intent','maker_resting','armed','exiting','exit_failed');
alter table public.bot_positions enable row level security;

-- 5.3 bot_orders — the idempotency intent ledger (ADR-OC-5).
create table if not exists public.bot_orders (
  id              bigint generated always as identity primary key,
  position_id     uuid not null references public.bot_positions(id),
  client_order_id uuid unique not null,                          -- the DB-dedup idempotency key (C3 — no venue echo)
  side            text check (side in ('BUY','SELL')),
  intent          text check (intent in ('entry_maker','entry_taker','exit_taker')),
  limit_price     numeric(8,6),
  size_shares     numeric(14,4),
  status          text check (status in ('intent','placed','resting','matched','cancelled','rejected','failed')),
  clob_order_id   text,
  matched_shares  numeric(14,4),
  avg_price       numeric(8,6),
  fee_usd         numeric(12,6),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists bo_position_idx on public.bot_orders (position_id, created_at);
create index if not exists bo_reconcile_idx on public.bot_orders (status) where status in ('intent','placed','resting');
alter table public.bot_orders enable row level security;

-- 5.4 bot_loop_lease — the single-instance CAS lease (ADR-OC-8/W2). One row.
create table if not exists public.bot_loop_lease (
  lease_key  text primary key default 'singleton',
  owner      uuid,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.bot_loop_lease enable row level security;

-- 5.5 bot_gate_snapshot — the persisted net-profit verdict (ADR-OC-10, I-3).
create table if not exists public.bot_gate_snapshot (
  id                  bigint generated always as identity primary key,
  computed_at         timestamptz not null,
  mode                text not null,
  source              text not null check (source in ('backtest','forward')),  -- the capital gate reads forward only (F2-r10)
  label               text not null,
  n_markets           int,
  n_cities            int,
  n_distinct_days     int,
  win_frac            numeric,
  mean_net_return     numeric,
  ci_low              numeric,
  ci_high             numeric,
  zero_skill_pass_rate numeric,
  reason              text
);
create index if not exists bgs_mode_src_idx on public.bot_gate_snapshot (mode, source, computed_at desc);
alter table public.bot_gate_snapshot enable row level security;

-- 5.6 bot_tick_log — the loop liveness/forensics trail (F19); read by the deadman + /bot.
create table if not exists public.bot_tick_log (
  id          bigint generated always as identity primary key,
  as_of       timestamptz not null,
  mode        text,
  ran         boolean,
  placed      int,
  filled      int,
  exited      int,
  gate_reason text,
  kill_reason text
);
create index if not exists btl_mode_asof_idx on public.bot_tick_log (mode, as_of desc);
alter table public.bot_tick_log enable row level security;

-- 5.7 bot_bankroll — the live equity/free-cash/POL components (F14/F9b/F10); caps denominator + spend ceiling.
create table if not exists public.bot_bankroll (
  mode            text primary key,
  free_pusd       numeric,
  held_value_usd  numeric,
  equity_usd      numeric,           -- = free + held (the caps denominator)
  base_usd        numeric,           -- operator day-start snapshot (the killLossPct denominator)
  pol_balance     numeric,           -- native POL gas (F10) — < bot.minPolGas ⇒ alarm
  updated_at      timestamptz not null default now()
);
alter table public.bot_bankroll enable row level security;

-- 5.8 bot_daily_kill — the LATCHED daily-loss stop (F32); once down for the day, done.
create table if not exists public.bot_daily_kill (
  mode      text primary key,
  kill_date date not null,
  killed_at timestamptz not null,
  reason    text
);
alter table public.bot_daily_kill enable row level security;

-- 5.9 bot_circuit_state — the PERSISTED breaker counters (F11/F42/F44; a process-memory counter would reset
-- on the very crash-loop F18 catches). Two dimensions: definitive-reject + brownout/timeout.
create table if not exists public.bot_circuit_state (
  mode                  text primary key,
  consecutive_failures  int not null default 0,
  consecutive_ambiguous int not null default 0,
  tripped_at            timestamptz,
  updated_at            timestamptz not null default now()
);
alter table public.bot_circuit_state enable row level security;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 6 · capture/seed read + write RPCs
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- 6.1 record_opening_captures — bulk-insert one tick's capture rows (mirror record_cross_venue_captures).
create or replace function public.record_opening_captures(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.opening_captures
    (captured_at, event_id, city, target_date, tz_name, created_at_gamma, listing_detected_at, resolves_at,
     hours_since_listing, peak_mid, is_flat_open, house_seeded, buckets, ev_vol24h, neg_risk)
  select
    (r->>'capturedAt')::timestamptz,
    nullif(r->>'eventId', '')::uuid,
    coalesce(r->>'city', ''),
    (r->>'targetDate')::date,
    coalesce(r->>'tzName', ''),
    nullif(r->>'createdAtGamma', '')::timestamptz,
    nullif(r->>'listingDetectedAt', '')::timestamptz,
    nullif(r->>'resolvesAt', '')::timestamptz,
    nullif(r->>'hoursSinceListing', '')::numeric,
    nullif(r->>'peakMid', '')::numeric,
    coalesce((r->>'isFlatOpen')::boolean, false),
    coalesce((r->>'houseSeeded')::boolean, false),
    coalesce(r->'buckets', '[]'::jsonb),
    nullif(r->>'evVol24h', '')::numeric,
    coalesce((r->>'negRisk')::boolean, true)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 6.2 latest_house_dist — the latest non-nowcast house_gaussian for an event, joined to market_buckets for
-- per-bucket labels/ranges (W6b — the bare probs[] carries no labels). The READ half of the TS seedHouseDist.
create or replace function public.latest_house_dist(p_event_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with d as (
    select bp.id, bp.probs, bp.mu_native, bp.sigma_native, bp.lead_days, bp.made_at, bp.nowcast, bp.seeded
    from public.bucket_probabilities bp
    where bp.event_id = p_event_id and bp.source = 'house_gaussian' and bp.nowcast = false
    order by bp.made_at desc
    limit 1
  )
  select case when d.id is null then null else jsonb_build_object(
    'eventId',  p_event_id,
    'source',   'house_gaussian',
    'lead',     d.lead_days,
    'madeAt',   d.made_at,
    'seeded',   coalesce(d.seeded, false),
    'mu',       d.mu_native,
    'sigma',    d.sigma_native,
    'probs',    d.probs,
    'buckets',  coalesce((
      select jsonb_agg(jsonb_build_object(
        'idx', mb.bucket_idx, 'label', mb.label, 'low', mb.low_native, 'high', mb.high_native,
        'prob', case when mb.bucket_idx + 1 <= array_length(d.probs, 1) then d.probs[mb.bucket_idx + 1] else null end
      ) order by mb.bucket_idx)
      from public.market_buckets mb where mb.event_id = p_event_id
    ), '[]'::jsonb)
  ) end
  from d;
$$;

-- 6.3 bot_latest_captures — the freshest capture per still-open event within the age window (entry scan input).
create or replace function public.bot_latest_captures(p_max_age_min int)
returns jsonb
language sql
security definer
set search_path = public
as $$
  with latest as (
    select distinct on (event_id, city, target_date) *
    from public.opening_captures
    where captured_at >= now() - make_interval(mins => greatest(coalesce(p_max_age_min, 30), 1))
    order by event_id, city, target_date, captured_at desc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', event_id, 'capturedAt', captured_at, 'city', city, 'targetDate', target_date,
    'tzName', tz_name, 'createdAtGamma', created_at_gamma, 'resolvesAt', resolves_at,
    'hoursSinceListing', hours_since_listing, 'peakMid', peak_mid, 'isFlatOpen', is_flat_open,
    'houseSeeded', house_seeded, 'buckets', buckets, 'evVol24h', ev_vol24h, 'negRisk', neg_risk
  ) order by captured_at desc), '[]'::jsonb)
  from latest;
$$;

-- 6.4 bot_capture_series — the FULL ordered capture series per (event) over a lookback (the paper-backtest +
-- Phase-0.5 spike mark path; the freshest-per-event read cannot supply a series).
create or replace function public.bot_capture_series(p_days int)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'eventId', event_id, 'capturedAt', captured_at, 'city', city, 'targetDate', target_date,
    'tzName', tz_name, 'createdAtGamma', created_at_gamma, 'resolvesAt', resolves_at,
    'hoursSinceListing', hours_since_listing, 'peakMid', peak_mid, 'isFlatOpen', is_flat_open,
    'houseSeeded', house_seeded, 'buckets', buckets, 'evVol24h', ev_vol24h, 'negRisk', neg_risk
  ) order by event_id, captured_at), '[]'::jsonb)
  from public.opening_captures
  where captured_at >= now() - make_interval(days => greatest(coalesce(p_days, 14), 1));
$$;

-- 6.5 bot_resolve_event_keys — resolve a scoped city slug → {cityId, tz, unit, icao} for the on-demand
-- seed's upsert_event + OM snapshot (the §9R cities are all already-discovered/known; this is a lookup, not
-- a re-discovery). Returns null for an unknown slug ⇒ the seed fails closed (houseProb null).
create or replace function public.bot_resolve_event_keys(p_slug text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case when c.id is null then null else jsonb_build_object(
    'cityId', c.id, 'tz', c.tz, 'unit', c.unit,
    'icao', (select cs.icao from public.city_stations cs where cs.city_id = c.id and cs.valid_to is null limit 1)
  ) end
  from public.cities c where c.slug = p_slug;
$$;

-- 6.6 bot_seed_quality — the F15 seed-QUALITY inputs: # contributing models for (icao, target_date) +
-- whether model_stats calibration coverage exists for the station. The seed AND's these with a dist-shape
-- check (mode-confidence + sigma sanity) before a houseProb is treated as enterable — existence ≠ usable.
create or replace function public.bot_seed_quality(p_icao text, p_target_date date)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'nModels', (select count(distinct model) from public.forecast_snapshots
                where icao = p_icao and target_date = p_target_date),
    'hasStats', exists(select 1 from public.model_stats where icao = p_icao)
  );
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 7 · the two deadmen (Phase-0 objects — F35/F19/F13/F5). Pure-SQL pg_cron functions that record a
-- CRITICAL via claim_alert when the forward experiment silently stalls; health-monitor's resend sweep
-- delivers it (≤ its cadence). The bot CRITICAL kinds are allowlisted below so they survive the global pause.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- 7.1 capture_deadman_check — producer side. Alarms on capture STALENESS or a SEEDED-FRACTION COLLAPSE (both
-- silent under DF-1: a Gamma/seed failure shrinks the panel / nulls houseProb, never a failed job — so a
-- plain row-count/job-success check is insufficient). Only alarms once capture HAS been producing (a null
-- max ⇒ not yet started, no alarm).
create or replace function public.capture_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest      timestamptz;
  v_stale_min   numeric := coalesce((select value::numeric from config where key = 'bot.captureStaleMin'), 9);
  v_age_min     numeric;
  v_window      int     := coalesce((select value::int from config where key = 'bot.captureSeededFracWindow'), 50);
  v_frac_min    numeric := coalesce((select value::numeric from config where key = 'bot.captureSeededFracMin'), 0.25);
  v_n           int;
  v_seeded_frac numeric;
  v_alarmed     boolean := false;
  v_bucket      int := floor(extract(epoch from now()) / 1800)::int;  -- 30-min dedupe
begin
  select max(captured_at) into v_latest from public.opening_captures;
  if v_latest is not null then
    v_age_min := extract(epoch from (now() - v_latest)) / 60;
    if v_age_min > v_stale_min then
      v_alarmed := true;
      perform public.claim_alert('CAPTURE_DEADMAN', 'CRITICAL', 'capture-deadman:stale:' || v_bucket,
        'opening-capture is STALE',
        'newest opening_captures row is ' || round(v_age_min, 1) || ' min old (> ' || v_stale_min ||
        ' min threshold). The flat-open forward experiment has stopped producing — the bot scans empty and '
        || 'the Phase-5 clock stalls silently. Check the opening-capture cron + edge fn.');
    end if;

    -- seeded-fraction collapse over the last N is_flat_open captures (the seed path silently failing).
    select count(*), avg((house_seeded)::int)
      into v_n, v_seeded_frac
    from (
      select house_seeded from public.opening_captures
      where is_flat_open order by captured_at desc limit v_window
    ) q;
    if v_n >= v_window and v_seeded_frac < v_frac_min then
      v_alarmed := true;
      perform public.claim_alert('CAPTURE_DEADMAN', 'CRITICAL', 'capture-deadman:seedfrac:' || v_bucket,
        'opening-capture SEEDED FRACTION collapsed',
        'only ' || round(v_seeded_frac * 100, 1) || '% of the last ' || v_window || ' flat-open captures carry a '
        || 'seeded houseProb (< ' || round(v_frac_min * 100, 1) || '% floor). The on-demand seed path is failing '
        || '— captures accrue but are unusable, stalling the experiment. Check seedHouseDist / Open-Meteo / model_stats.');
    end if;
  end if;

  return jsonb_build_object('checkedAt', now(), 'latestCaptureAt', v_latest, 'ageMin', v_age_min,
                            'flatOpenWindow', v_n, 'seededFrac', v_seeded_frac, 'alarmed', v_alarmed);
end;
$$;

-- 7.2 bot_deadman_check — consumer side, MODE-AWARE (reads the tradingMode-active partition so the Phase-5
-- PAPER loop's liveness alarms too — F13). Alarms on a stale bot_tick_log OR a stale forward gate snapshot.
-- Only meaningful once the bot has ticked at least once (a null max ⇒ the bot isn't running yet, no alarm).
create or replace function public.bot_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode        text    := coalesce((select value from config where key = 'tradingMode'), 'paper');
  v_tick_int    numeric := coalesce((select value::numeric from config where key = 'bot.tickIntervalSec'), 30);
  v_thresh_min  numeric := (v_tick_int * 3) / 60;  -- ~3× the tick interval
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
        || 'Check the VPS opening-bot process + the lease.');
    end if;

    -- the gate-snapshot clock (the direct "experiment stopped advancing" signal).
    select max(computed_at) into v_last_gate from public.bot_gate_snapshot where mode = v_mode and source = 'forward';
    if v_last_gate is not null then
      v_gate_age := extract(epoch from (now() - v_last_gate)) / 60;
      if v_gate_age > 180 then  -- the forward verdict should refresh well within 3h while the loop runs
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

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 8 · config MIRROR (code defaults are authoritative — opening-convergence BOT_DEFAULTS; the equality
-- is asserted by a test, F10-r8-FP) + the bot CRITICAL Slack-allowlist append (F4-r8).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
insert into public.config (key, value) values
  ('bot_enabled',                  '0'),
  ('bot.cities',                   'amsterdam,chengdu,manila,qingdao,madrid,guangzhou,kuala-lumpur,beijing,shanghai,paris'),
  ('bot.minVol24hUsd',             '7000'),
  ('bot.peakMidMax',               '0.18'),
  ('bot.listingMaxHours',          '1'),
  ('bot.centerHalfWidth',          '1'),
  ('bot.entryEdgeMargin',          '0.05'),
  ('bot.maxEntryPrice',            '0.2'),
  ('bot.depthFloorUsd',            '50'),
  ('bot.perPositionUsd',           '20'),
  ('bot.perMarketUsd',             '40'),
  ('bot.totalConcurrentUsd',       '100'),
  ('bot.paperBankrollUsd',         '200'),
  ('bot.bankrollBaseUsd',          '200'),
  ('bot.killLossUsd',              '30'),
  ('bot.killLossPct',              '0.25'),
  ('bot.firstNApprove',            '10'),
  ('bot.realTradesApproved',       '0'),
  ('bot.tpDeltaPp',                '0.25'),
  ('bot.tpAtModelProb',            '1'),
  ('bot.slDeltaPp',                '0.12'),
  ('bot.slFrac',                   '0.5'),
  ('bot.timeStopLocalHour',        '12'),
  ('bot.makerFillWindowMin',       '15'),
  ('bot.minHoldRunwayMin',         '30'),
  ('bot.paperSlippage',            '0.01'),
  ('bot.takerFeeRate',             '0.05'),
  ('bot.paperBookMaxAgeMin',       '5'),
  ('bot.tickIntervalSec',          '30'),
  ('bot.tickWatchdogSec',          '120'),
  ('bot.leaseTtlSec',              '600'),
  ('bot.reconcileWatchdogSec',     '300'),
  ('bot.reconcileEveryTicks',      '20'),
  ('bot.markMaxAgeMin',            '5'),
  ('bot.maxClockDriftSec',         '5'),
  ('bot.maxConsecutiveFailures',   '5'),
  ('bot.maxConsecutiveAmbiguous',  '4'),
  ('bot.seedFreshnessMin',         '180'),
  ('bot.seedMinModels',            '3'),
  ('bot.captureStaleMin',          '9'),
  ('bot.captureSeededFracMin',     '0.25'),
  ('bot.captureSeededFracWindow',  '50'),
  ('bot.minOrderSizeShares',       '5'),
  ('bot.minOrderNotionalUsd',      '1'),
  ('bot.freeCashReserveUsd',       '5'),
  ('bot.minPolGas',                '0.5'),
  ('bot.killDayTz',                'America/New_York'),
  ('bot.killLatchPersistTicks',    '3'),
  ('bot.spikeGoFrac',              '0.5'),
  ('bot.gate.minMarkets',          '40'),
  ('bot.gate.minCities',           '4'),
  ('bot.gate.minDistinctDays',     '7'),
  ('bot.gate.minWinFrac',          '0.5')
on conflict (key) do nothing;

-- Append the bot CRITICAL kinds to alerts_slack_allow_kinds so the safety alarms survive the global Slack
-- pause (TRUE on prod for whale-noise). Idempotent: each kind appended only if not already present.
do $$
declare
  v_kinds text := coalesce((select value from config where key = 'alerts_slack_allow_kinds'), 'WHALE_TRADE');
  v_kind  text;
begin
  foreach v_kind in array array['BOT_DEADMAN','CAPTURE_DEADMAN','EXIT_FAILED','CIRCUIT_BREAK','POL_LOW','DAILY_KILL'] loop
    if position(v_kind in v_kinds) = 0 then
      v_kinds := v_kinds || ',' || v_kind;
    end if;
  end loop;
  insert into config (key, value) values ('alerts_slack_allow_kinds', v_kinds)
    on conflict (key) do update set value = v_kinds, updated_at = now();
end $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 9 · grants (post-0034 contract): writers service_role only; the bot tables readable by service_role
-- (the operator /bot dash arrives in Phase 4). The deadmen are service_role (pg_cron runs them).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
revoke all on function public.record_opening_captures(jsonb) from public, anon, authenticated;
grant  execute on function public.record_opening_captures(jsonb) to service_role;
revoke all on function public.latest_house_dist(uuid) from public, anon, authenticated;
grant  execute on function public.latest_house_dist(uuid) to service_role;
revoke all on function public.bot_latest_captures(int) from public, anon, authenticated;
grant  execute on function public.bot_latest_captures(int) to service_role;
revoke all on function public.bot_capture_series(int) from public, anon, authenticated;
grant  execute on function public.bot_capture_series(int) to service_role;
revoke all on function public.bot_resolve_event_keys(text) from public, anon, authenticated;
grant  execute on function public.bot_resolve_event_keys(text) to service_role;
revoke all on function public.bot_seed_quality(text, date) from public, anon, authenticated;
grant  execute on function public.bot_seed_quality(text, date) to service_role;
revoke all on function public.capture_deadman_check() from public, anon, authenticated;
grant  execute on function public.capture_deadman_check() to service_role;
revoke all on function public.bot_deadman_check() from public, anon, authenticated;
grant  execute on function public.bot_deadman_check() to service_role;
revoke all on function public.upsert_forecast_rows(jsonb) from public, anon, authenticated;
grant  execute on function public.upsert_forecast_rows(jsonb) to service_role;

grant all on public.opening_captures   to service_role;
grant all on public.bot_positions       to service_role;
grant all on public.bot_orders          to service_role;
grant all on public.bot_loop_lease      to service_role;
grant all on public.bot_gate_snapshot   to service_role;
grant all on public.bot_tick_log        to service_role;
grant all on public.bot_bankroll        to service_role;
grant all on public.bot_daily_kill      to service_role;
grant all on public.bot_circuit_state   to service_role;
grant select on public.opening_captures   to authenticated;
grant select on public.bot_positions      to authenticated;
grant select on public.bot_gate_snapshot  to authenticated;
grant select on public.bot_tick_log       to authenticated;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 10 · crons (same Vault-secret pattern as 0062/0055/0009; idempotent; PGlite skips via the guard).
--   opening-capture       — ~every 2 min FIRST-SEEN poll (§16-D: the flat-open window is ≤~1h).
--   capture_deadman_check — every 10 min (SQL, run directly by pg_cron).
--   bot_deadman_check     — every 10 min (SQL).
--   retention prunes      — daily (F15-r10): opening_captures > 90d, bot_tick_log > 30d.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping opening-convergence cron registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/opening-capture',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;
  perform cron.schedule('opening-capture', '*/2 * * * *', edge_command);

  perform cron.schedule('opening-capture-deadman', '*/10 * * * *', 'select public.capture_deadman_check();');
  perform cron.schedule('opening-bot-deadman',     '*/10 * * * *', 'select public.bot_deadman_check();');

  perform cron.schedule('opening-captures-prune', '30 3 * * *',
    $prune$delete from public.opening_captures where captured_at < now() - interval '90 days';$prune$);
  perform cron.schedule('bot-tick-log-prune', '35 3 * * *',
    $prune$delete from public.bot_tick_log where as_of < now() - interval '30 days';$prune$);
end;
$$;
