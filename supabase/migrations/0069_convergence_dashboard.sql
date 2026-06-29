-- 0069_convergence_dashboard.sql — /convergence overview page: the opening-convergence forward-paper feed.
--
-- The /convergence page surfaces the live 12th-signal paper test: the bot's logged potential ENTRIES, their
-- EXITS, per-day chances, the take-profit TUNING sweep, the §9R-E gate progress, and a FICTIVE money tracker.
--
-- WHY A SNAPSHOT (not a live RPC). The bracket-replay engine needs the per-tick capture series (no look-ahead
-- exit walk) over a WIDE window (the §9R-E gate needs ≥40 markets / ≥7 days) — far too heavy to return on every
-- page load. A 15-min Edge tick (`convergence-panel`) pulls the raw inputs PER CITY (the whole-allowlist build
-- exceeds the 8s PostgREST cap), runs `buildConvergenceView` (core/sim/opening-convergence-view — the SAME engine
-- the bracket-score scorer uses, on the §9R-locked BOT_DEFAULTS / 10-city tradable allowlist), and stores the
-- small (tens-of-KB) view jsonb. The page reads only the snapshot. NOT trading — read-only; rail paper/DORMANT.
--
-- The inputs RPC DOWNSAMPLES to ~every 3rd capture (~6-min resolution) so the Edge isolate can pull + replay
-- comfortably; the full-fidelity number stays the `opening-bracket-score` scorer (the dashboard is the legible
-- forward view, not the authoritative gate). Four objects + one cron:
--   1. convergence_panel — snapshot table (one row per Edge tick; the page reads the latest).
--   2. record_convergence_panel(p_view) — service-role insert of one computed view.
--   3. convergence_capture_inputs(p_days, p_cities) — service-role read of the RAW (downsampled, trimmed-bucket)
--      fresh-allowlist capture series + the venue resolution map. NOT operator-exposed.
--   4. dash_convergence() — operator read RPC returning the LATEST snapshot view (security definer + guard).
--   5. pg_cron 'convergence-panel' every 15 min.

-- the prior raw-returning signature (superseded by the snapshot design) — drop so the new no-arg fn is clean.
drop function if exists public.dash_convergence(int, text[]);

-- === 1. snapshot table ================================================================================
create table if not exists public.convergence_panel (
  id          bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  view        jsonb       not null
);
create index if not exists convergence_panel_captured_idx on public.convergence_panel (captured_at desc);

comment on table public.convergence_panel is
  'Opening-convergence forward-paper view snapshots (convergence-panel Edge tick, every 15 min). Analytics-only; bot rail paper/DORMANT (FINDINGS.md 12th signal).';

-- RLS on (ADR-13): written only by record_convergence_panel (security definer); no read policy =>
-- anon/authenticated get nothing by direct query. Read via dash_convergence only.
alter table public.convergence_panel enable row level security;

-- === 2. record_convergence_panel — insert one computed view (service-role; the Edge tick's write) =====
create or replace function public.record_convergence_panel(p_view jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.convergence_panel (captured_at, view)
  values (now(), coalesce(p_view, '{}'::jsonb))
  returning id into v_id;
  -- keep the table small: retain the latest 200 snapshots (~2 days at 15-min cadence).
  delete from public.convergence_panel
   where id < (select min(id) from (select id from public.convergence_panel order by id desc limit 200) k);
  return v_id;
end;
$$;

revoke all on function public.record_convergence_panel(jsonb) from public, anon, authenticated;
grant  execute on function public.record_convergence_panel(jsonb) to service_role;

-- === 3. convergence_capture_inputs — the RAW fresh-allowlist inputs the Edge engine consumes (service) ==
-- Mirrors the harness loadEvents shape (camelCase, core's RawCaptureRow) + the resolution map (RawResolution).
-- The row-level scalars (createdAtGamma/resolvesAt/peakMid/isFlatOpen/houseSeeded/evVol24h/negRisk) are emitted
-- for RawCaptureRow shape-parity even though buildEvents/captureOf discard them — intentional, keeps the RPC
-- payload == the harness query shape. Buckets are TRIMMED to the 7 fields the replay reads; ticks are DOWNSAMPLED
-- to ~every 3rd (+ the last) so the per-city build stays well under the 8s API cap. `set statement_timeout` is a
-- FUNCTION attribute — applied at a new GUC nest level and auto-restored on function exit, unlike a body SET LOCAL
-- which would persist to end-of-transaction (the 40s here is the Postgres-level backstop; the gateway cap is
-- handled by the Edge handler paging per-city).
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
      -- bestAsk, execBid (label is display-only). These are every bucket field selectEntries/replayEvent read on
      -- the requireFlatOpen:false route (isFlatOpen — the only `mid` reader — is skipped); dropping any one would
      -- silently diverge the dashboard from the full-fidelity scorer.
      (select jsonb_agg(jsonb_build_object(
         'idx', b->'idx', 'label', b->'label', 'bestAsk', b->'bestAsk', 'execAsk', b->'execAsk',
         'execBid', b->'execBid', 'depthUsd', b->'depthUsd', 'houseProb', b->'houseProb')
       order by (b->>'idx')::int)
       from jsonb_array_elements(s.buckets) b)   as "buckets"
    from ranked s
    -- rn=1 (the earliest tick = min hours_since_listing, since it is monotone in captured_at) MUST stay retained
    -- so buildEvents' TS FRESH re-filter (min<1) still matches the `fresh` CTE's having-min<1; `rn % 3 = 1`
    -- always keeps it, and `rn = s.cnt` always keeps the last tick (needed so the time-stop/settle can fire).
    where s.rn % 3 = 1 or s.rn = s.cnt
    -- NB this ORDER BY does NOT propagate into the outer jsonb_agg (no in-aggregate ORDER BY there); array order
    -- is intentionally unspecified — both consumers (buildEvents, the resolution Map) re-group/re-sort by key.
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

-- === 4. dash_convergence — operator read of the LATEST snapshot view (security definer, jsonb OBJECT) ===
create or replace function public.dash_convergence()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object('generatedAt', cp.captured_at, 'view', cp.view)
  into v
  from public.convergence_panel cp
  order by cp.captured_at desc
  limit 1;
  return coalesce(v, jsonb_build_object('generatedAt', null, 'view', null));
end;
$$;

revoke all on function public.dash_convergence() from public, anon, authenticated;
grant  execute on function public.dash_convergence() to authenticated, service_role;

-- === 5. cron: 15-min convergence-panel tick =========================================================
-- Every 15 min — the paper panel moves slowly. Vault-secret pattern identical to 0059. The Edge fn ACKs fast
-- (202) and runs in waitUntil, so the 4500ms http timeout is the project convention. idempotent. PGlite skips.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping convergence-panel registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/convergence-panel',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('convergence-panel', '*/15 * * * *', edge_command);
end;
$$;
