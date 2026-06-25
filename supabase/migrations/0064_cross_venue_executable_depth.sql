-- 0064_cross_venue_executable_depth.sql — the TRUE both-venue executable-depth gate for the cross-venue
-- (Kalshi ↔ Polymarket) measurement (10th signal, CROSS-VENUE-SPIKE.md).
--
-- WHY. The 0062/0063 gate scored the quoted edge against a 24h-volume / open-interest PROXY for "real
-- depth". The live both-venue verification (scripts/research/cross-venue-verify.ts) proved that proxy
-- overstates EXECUTABLE capacity by 1–3 orders of magnitude: every net-positive city-day quotes a real
-- price gap (NYC +0.26, Miami +0.23) but the cumulative YES≥k synthetic fills at only 1–10 contracts/
-- shares on its thin legs (the binding leg is min over both order books — both must fill to be hedged).
-- So the frozen winFrac gate would have FALSE-PASSED on a quoted-but-unexecutable mirage. This migration
-- makes a WIN require true executability:
--
--   * exec_size      — the binding (min) resting size walked on BOTH order books at the best position's
--                      legs (handler STEP 3.5); NULL for efficient (≤0-edge) rows that skip the walk.
--   * is_executable  — exec_size ≥ MIN_EXEC_SIZE (=25 ≈ a token $25 position). A net-positive row counts
--                      as a real WIN only if this is true.
--
-- DESIGN NOTE (deliberate): `has_real_depth` STAYS the 24h-vol/OI proxy and remains the DENOMINATOR
-- (a liquid market exists). Executability gates the NUMERATOR, not the denominator — if has_real_depth
-- itself required executability, the denominator would collapse to 0 and the verdict would deadlock at
-- INSUFFICIENT_DATA forever, never rendering the (correct) KILL. winFrac = executable-wins / liquid-days.
-- CREATE OR REPLACE preserves the 0062 grants. Idempotent (add-column IF NOT EXISTS).

-- === 1. columns ============================================================================================
alter table public.cross_venue_captures add column if not exists exec_size     numeric(12,2);
alter table public.cross_venue_captures add column if not exists is_executable boolean not null default false;

comment on column public.cross_venue_captures.exec_size is
  'TRUE binding (min) executable size across the best position''s legs, walked on BOTH order books '
  '(Kalshi /orderbook + Polymarket CLOB /book). NULL for efficient rows that skip the walk. The capacity '
  'wall: net-positive days observed at 1–10 vs MIN_EXEC_SIZE=25 (CROSS-VENUE-SPIKE.md).';
comment on column public.cross_venue_captures.is_executable is
  'exec_size ≥ MIN_EXEC_SIZE — a net-positive row is a real WIN only when this is true (not a quoted '
  'top-of-book mirage). Gates the winFrac NUMERATOR; has_real_depth (the 24h-vol/OI proxy) stays the denominator.';

-- === 2. record_cross_venue_captures — now carries execSize + isExecutable ===================================
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
     limit_depth, has_real_depth, net_positive, exec_size, is_executable)
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
    coalesce((r->>'netPositive')::boolean, false),
    nullif(r->>'execSize',      '')::numeric,
    coalesce((r->>'isExecutable')::boolean, false)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- === 3. dash_cross_venue — winFrac now over EXECUTABLE wins; surface the quoted-vs-executable split =========
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
    -- QUOTED net-positive (proxy depth) vs the real EXECUTABLE wins (both order books walked):
    'netPositiveDepthDays', (select count(*) from depth where net_positive),                  -- quoted
    'executableWinDays',    (select count(*) from depth where net_positive and is_executable),-- real WINS
    -- winFrac is over EXECUTABLE wins — a quoted edge on a 1-contract book is not a win (capacity wall).
    'winFrac',        (select case when count(*) > 0 then round((count(*) filter (where net_positive and is_executable))::numeric / count(*), 4) else null end from depth),
    'meanNetEdge',    (select round(avg(best_net_edge), 5) from depth),
    'bestEdgeSeen',   (select max(best_net_edge) from depth),
    'maxExecSize',    (select max(exec_size) from depth where net_positive),  -- the capacity wall, in units
    'meanAbsGap',     (select round(avg(max_abs_gap), 4) from latest),
    'meanDiffF',      (select round(avg(mean_diff_f), 3) from latest),
    'perCity', coalesce((
      select jsonb_agg(jsonb_build_object(
        'city',           pc.city,
        'days',           pc.days,
        'realDepthDays',  pc.real_depth_days,
        'netPosDays',     pc.net_pos_days,         -- quoted net-positive
        'execWinDays',    pc.exec_win_days,        -- real executable wins
        'maxExecSize',    pc.max_exec_size,
        'meanDiffF',      pc.mean_diff,
        'meanAbsGap',     pc.mean_gap,
        'bestEdge',       pc.best_edge
      ) order by pc.city)
      from (
        select city,
               count(*)                                                       as days,
               count(*) filter (where has_real_depth)                         as real_depth_days,
               count(*) filter (where has_real_depth and net_positive)        as net_pos_days,
               count(*) filter (where has_real_depth and net_positive and is_executable) as exec_win_days,
               max(exec_size) filter (where net_positive)                     as max_exec_size,
               round(avg(mean_diff_f), 3)                                     as mean_diff,
               round(avg(max_abs_gap), 4)                                     as mean_gap,
               max(best_net_edge) filter (where has_real_depth)               as best_edge
        from latest group by city
      ) pc
    ), '[]'::jsonb),
    'recentCaptures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',   captured_at,
        'city',         city,
        'targetDate',   target_date,
        'meanDiffF',    mean_diff_f,
        'maxAbsGap',    max_abs_gap,
        'bestNetEdge',  best_net_edge,
        'edgeAtF',      edge_at_f,
        'direction',    direction,
        'limitDepth',   limit_depth,
        'execSize',     exec_size,
        'isExecutable', is_executable,
        'hasRealDepth', has_real_depth,
        'netPositive',  net_positive
      ) order by captured_at desc)
      from (select * from cross_venue_captures where captured_at >= v_since order by captured_at desc limit 60) q
    ), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;
