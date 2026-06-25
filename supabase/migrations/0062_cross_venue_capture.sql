-- 0062_cross_venue_capture.sql — the forward panel capture for the CROSS-VENUE (Kalshi ↔ Polymarket)
-- relative-value measurement (10th-signal candidate, CROSS-VENUE-SPIKE.md).
--
-- THE QUESTION: the same US city's daily high trades on BOTH Polymarket (Wunderground-resolved, EVEN-
-- start 2°F bins) and Kalshi (NWS-CLI-resolved, ODD-start 2°F bins). Do the two venues price it
-- differently enough to clear the combined fee + the 1°F bin-offset stub + the CLI-vs-WU basis? There
-- is no historical Kalshi book to backtest, so the measurement is FORWARD: capture both venues' books
-- for the 6 overlapping cities (NYC, LA, Chicago, Miami, Austin, Denver) every 30 min and accumulate a
-- matched city-day panel. The engine (core/sim/cross-venue-arb.ts) computes the executable, basis-
-- adjusted edge per snapshot; the frozen gate (scripts/research/cross-venue-arb-scan.ts) renders the
-- verdict after ~1 week:
--   PASS = ≥10% of real-depth city-days net-positive AND pooled mean-edge 95% CI excludes 0 → executor.
--   KILL = the 10th falsified signal — structurally walled like the complete-set arb. Rail DORMANT.
--
-- This migration adds: (1) the cross_venue_captures append-only table, (2) dash_cross_venue operator
-- read RPC (jsonb OBJECT — the 0044 trap), (3) record_cross_venue_captures bulk recorder, (4) the
-- cross-venue-capture Edge cron (every 30 min). Analytics data capture only; no packages/trading.

-- === 1. append-only capture table ===========================================================================
create table if not exists public.cross_venue_captures (
  id              bigint generated always as identity primary key,
  captured_at     timestamptz not null,
  city            text        not null,   -- 'nyc' | 'los-angeles' | 'chicago' | 'miami' | 'austin' | 'denver'
  target_date     date        not null,   -- the local day whose high both venues resolve
  poly_n_buckets  int,                    -- Polymarket ladder legs seen
  kalshi_n_buckets int,                   -- Kalshi ladder legs seen
  poly_mean_f     numeric(6,3),           -- implied mean high (°F), Polymarket (WU)
  kalshi_mean_f   numeric(6,3),           -- implied mean high (°F), Kalshi (CLI)
  mean_diff_f     numeric(6,3),           -- poly_mean − kalshi_mean (>0 ⇒ Polymarket prices it hotter)
  max_abs_gap     numeric(6,4),           -- KS-style max |survival gap| across thresholds
  max_gap_at_f    numeric(6,2),           -- threshold (°F) of the max survival gap
  best_net_edge   numeric(8,5),           -- best executable basis-adjusted edge per $1 of threshold
  edge_at_f       numeric(6,2),           -- threshold (°F) of the best edge
  direction       text,                   -- 'buyPolySellKalshi' | 'buyKalshiSellPoly' | 'none'
  cashflow        numeric(8,5),           -- immediate cashflow component of the best edge
  exp_payoff      numeric(8,5),           -- expected-resolution-payoff component (consensus-valued)
  limit_depth     numeric(12,2),          -- limiting top-of-book size / OI proxy at the best edge
  has_real_depth  boolean     not null default false, -- limit_depth ≥ MIN_DEPTH_SHARES (the gate filter)
  net_positive    boolean     not null default false  -- best_net_edge > 0
);

create index if not exists xvenue_captured_idx    on public.cross_venue_captures (captured_at desc);
create index if not exists xvenue_city_date_idx   on public.cross_venue_captures (city, target_date, captured_at desc);
create index if not exists xvenue_netpos_idx      on public.cross_venue_captures (net_positive, captured_at desc) where net_positive;

comment on table public.cross_venue_captures is
  'Forward matched-panel capture for the cross-venue (Kalshi↔Polymarket) RV measurement (10th signal, '
  'CROSS-VENUE-SPIKE.md). Append-only 30-min ticks of both venues'' implied distributions + the '
  'executable basis-adjusted edge for the 6 overlapping US cities. Analytics only; rail DORMANT.';

-- RLS on (post-0034 contract): written only by service-role (Edge tick); operator reads via dash RPC.
alter table public.cross_venue_captures enable row level security;

-- === 2. dash_cross_venue — operator read RPC ================================================================
-- Returns a jsonb OBJECT (never a top-level array — the 0044 trap). Requires operator_guard.
-- The "real-depth city-day" panel = one row per (city, target_date) = the LATEST capture of each, so a
-- day is counted once (not once per 30-min tick), matching the frozen gate's denominator. p_days: look-
-- back window (default 14, min 1).
create or replace function public.dash_cross_venue(p_days int default 14)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v jsonb;
  v_since timestamptz;
begin
  perform public.operator_guard();
  v_since := now() - make_interval(days => greatest(coalesce(p_days, 14), 1));

  with latest as (
    select distinct on (city, target_date) *
    from cross_venue_captures
    where captured_at >= v_since
    order by city, target_date, captured_at desc
  ),
  depth as (select * from latest where has_real_depth)
  select jsonb_build_object(
    'generatedAt',    now(),
    'windowDays',     coalesce(p_days, 14),
    'captures',       (select count(*) from cross_venue_captures where captured_at >= v_since),
    'distinctCities', (select count(distinct city) from latest),
    'matchedDays',    (select count(*) from latest),
    'realDepthDays',  (select count(*) from depth),
    'netPositiveDepthDays', (select count(*) from depth where net_positive),
    'winFrac',        (select case when count(*) > 0 then round((count(*) filter (where net_positive))::numeric / count(*), 4) else null end from depth),
    'meanNetEdge',    (select round(avg(best_net_edge), 5) from depth),
    'bestEdgeSeen',   (select max(best_net_edge) from latest),
    'meanAbsGap',     (select round(avg(max_abs_gap), 4) from latest),
    'meanDiffF',      (select round(avg(mean_diff_f), 3) from latest),
    'perCity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'city',           city,
        'days',           count(*),
        'realDepthDays',  count(*) filter (where has_real_depth),
        'netPosDays',     count(*) filter (where has_real_depth and net_positive),
        'meanDiffF',      round(avg(mean_diff_f), 3),
        'meanAbsGap',     round(avg(max_abs_gap), 4),
        'bestEdge',       max(best_net_edge)
      ) order by city)
      from latest group by city
    ), '[]'::jsonb),
    'recentCaptures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',  captured_at,
        'city',        city,
        'targetDate',  target_date,
        'meanDiffF',   mean_diff_f,
        'maxAbsGap',   max_abs_gap,
        'bestNetEdge', best_net_edge,
        'edgeAtF',     edge_at_f,
        'direction',   direction,
        'limitDepth',  limit_depth,
        'hasRealDepth',has_real_depth,
        'netPositive', net_positive
      ) order by captured_at desc)
      from (select * from cross_venue_captures where captured_at >= v_since order by captured_at desc limit 60) q
    ), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

-- === 3. record_cross_venue_captures — bulk insert one tick's rows (service-role only) =======================
-- Takes a jsonb ARRAY of camelCase rows. Returns the row count. Append-only (each tick is a sample).
-- Mirror of record_complete_set_depth_captures (0060) / record_reward_snapshots (0057).
create or replace function public.record_cross_venue_captures(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.cross_venue_captures
    (captured_at, city, target_date, poly_n_buckets, kalshi_n_buckets,
     poly_mean_f, kalshi_mean_f, mean_diff_f, max_abs_gap, max_gap_at_f,
     best_net_edge, edge_at_f, direction, cashflow, exp_payoff,
     limit_depth, has_real_depth, net_positive)
  select
    (r->>'capturedAt')::timestamptz,
    coalesce(r->>'city', ''),
    (r->>'targetDate')::date,
    nullif(r->>'polyNBuckets',  '')::int,
    nullif(r->>'kalshiNBuckets','')::int,
    nullif(r->>'polyMeanF',     '')::numeric,
    nullif(r->>'kalshiMeanF',   '')::numeric,
    nullif(r->>'meanDiffF',     '')::numeric,
    nullif(r->>'maxAbsGap',     '')::numeric,
    nullif(r->>'maxGapAtF',     '')::numeric,
    nullif(r->>'bestNetEdge',   '')::numeric,
    nullif(r->>'edgeAtF',       '')::numeric,
    coalesce(r->>'direction', 'none'),
    nullif(r->>'cashflow',      '')::numeric,
    nullif(r->>'expPayoff',     '')::numeric,
    nullif(r->>'limitDepth',    '')::numeric,
    coalesce((r->>'hasRealDepth')::boolean, false),
    coalesce((r->>'netPositive')::boolean, false)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- === 4. grants (post-0034 contract) =========================================================================
revoke all on function public.dash_cross_venue(int)                   from public, anon, authenticated;
grant  execute on function public.dash_cross_venue(int)               to authenticated, service_role;

revoke all on function public.record_cross_venue_captures(jsonb)      from public, anon, authenticated;
grant  execute on function public.record_cross_venue_captures(jsonb)  to service_role;

grant all    on public.cross_venue_captures to service_role;
grant select on public.cross_venue_captures to authenticated;

-- === 5. cron: every 30 min — cross-venue-capture ============================================================
-- Same Vault-secret pattern as 0060/0057/0056/0055/0049/0039/0026/0009. Idempotent (cron.schedule upserts).
-- PGlite has no real cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping cross-venue-capture registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/cross-venue-capture',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('cross-venue-capture', '*/30 * * * *', edge_command);
end;
$$;
