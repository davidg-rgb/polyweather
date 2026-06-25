-- 0060_complete_set_depth_capture.sql — Move 1 (forward depth-capture) + Move 3 (fee-structure
-- reopening monitor) for the complete-set arbitrage (8th signal, COMPLETE-SET-ARB.md).
--
-- THE BINDING UNKNOWN: the 161 fee-clearing instants in the historical scan all live in freshly-
-- opened thin-book windows (lead ~2 d, age < 2 h) where `book_top3` was NULL in market_snapshots
-- (the poller only attaches depth to ≤15 candidate ladders/cycle; thin early markets are not
-- candidates). We saw the SIGNAL but not the CAPACITY. This migration:
--
--   1. Adds the `complete_set_depth_captures` append-only table — one row per ladder per 30-min
--      tick, capturing full CLOB book depth for every open ladder with lead≤2d AND age<2h.
--   2. Registers the `arb-depth-capture` Edge Function cron (every 30 min).
--   3. Provides `dash_complete_set_depth` operator read RPC (jsonb OBJECT, operator_guard).
--
-- After ~7 days of captures, re-run the depth verdict:
--   IF exec_sets > 0 on any persistent clear: MARGINAL → PASS candidate → design the executor.
--   IF exec_sets always 0 (min-order-size wall): capacity ≈ pennies → fully closed.
--
-- The trading rail stays DORMANT. Analytics data capture only; no packages/trading, no orders.

-- === 1. append-only capture table ===========================================================================
create table if not exists public.complete_set_depth_captures (
  id              bigint generated always as identity primary key,
  captured_at     timestamptz not null,
  event_slug      text        not null,   -- e.g. 'highest-temperature-in-wuhan-...'
  lead_days       numeric(5,2),           -- days until market close at capture time
  age_hours       numeric(5,2),           -- hours since the event was first opened
  n_buckets       int,                    -- number of ladder legs
  sum_best_ask    numeric(8,6),           -- Σ top-of-book ask (the raw underround signal)
  under_net       numeric(8,6),           -- net underround after per-leg taker fee
  exec_sets       int         not null default 0,  -- profitable whole sets (0 = depth wall)
  exec_cost_usd   numeric(10,4),
  exec_profit_usd numeric(10,4),
  per_leg_depth   jsonb,                  -- [{price, topSize, totalSize}] ordered by bucket_idx
  raw_underround  boolean     not null,   -- sum_best_ask < 1 (pre-fee)
  fee_cleared     boolean     not null    -- under_net > 0 (post-fee)
);

create index if not exists csdepth_captured_idx      on public.complete_set_depth_captures (captured_at desc);
create index if not exists csdepth_slug_captured_idx on public.complete_set_depth_captures (event_slug, captured_at desc);
create index if not exists csdepth_fee_cleared_idx   on public.complete_set_depth_captures (fee_cleared, captured_at desc) where fee_cleared;

comment on table public.complete_set_depth_captures is
  'Move 1: forward depth-capture for the complete-set arbitrage (8th signal). Append-only 30-min ticks of '
  'full-CLOB depth for fresh open ladders (lead≤2d, age<2h) — resolves the binding unknown: are the '
  'fee-clearing thin-book windows executable at size? Analytics only; rail DORMANT.';

-- RLS on (post-0034 contract): written only by service-role (Edge tick); operator reads via dash RPC.
alter table public.complete_set_depth_captures enable row level security;

-- === 2. dash_complete_set_depth — operator read RPC =========================================================
-- Returns a jsonb OBJECT (never a top-level array — the 0044 trap). Requires operator_guard.
-- p_days: look-back window in days (default 14, max 60).
create or replace function public.dash_complete_set_depth(p_days int default 14)
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

  select jsonb_build_object(
    'generatedAt',   now(),
    'windowDays',    coalesce(p_days, 14),
    'captures',      (select count(*) from complete_set_depth_captures where captured_at >= v_since),
    'distinctEvents',(select count(distinct event_slug) from complete_set_depth_captures where captured_at >= v_since),
    'rawUndround',   (select count(*) from complete_set_depth_captures where captured_at >= v_since and raw_underround),
    'feeCleared',    (select count(*) from complete_set_depth_captures where captured_at >= v_since and fee_cleared),
    'anyExecSets',   (select count(*) from complete_set_depth_captures where captured_at >= v_since and exec_sets > 0),
    'bestExecProfit',(select max(exec_profit_usd) from complete_set_depth_captures where captured_at >= v_since and exec_sets > 0),
    'feeClearedEvents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'slug',          event_slug,
        'captures',      count(*),
        'feeCleared',    sum(case when fee_cleared then 1 else 0 end),
        'maxExecSets',   max(exec_sets),
        'maxExecProfit', max(exec_profit_usd),
        'firstSeen',     min(captured_at),
        'lastSeen',      max(captured_at)
      ) order by sum(case when fee_cleared then 1 else 0 end) desc)
      from complete_set_depth_captures
      where captured_at >= v_since
      group by event_slug
      having sum(case when fee_cleared then 1 else 0 end) > 0
    ), '[]'::jsonb),
    'recentCaptures', coalesce((
      select jsonb_agg(jsonb_build_object(
        'capturedAt',   captured_at,
        'slug',         event_slug,
        'leadDays',     lead_days,
        'ageHours',     age_hours,
        'sumBestAsk',   sum_best_ask,
        'underNet',     under_net,
        'execSets',     exec_sets,
        'execProfit',   exec_profit_usd,
        'feeCleared',   fee_cleared
      ) order by captured_at desc)
      from (
        select * from complete_set_depth_captures
        where captured_at >= v_since
        order by captured_at desc limit 100
      ) q
    ), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

-- === 3. record_complete_set_depth_captures — bulk insert one tick's rows (service-role only) ====
-- Takes a jsonb ARRAY of camelCase rows. Returns the row count. Append-only; no upsert/dedup
-- (each 30-min tick is a distinct sample). Mirror of record_reward_snapshots (0057).
create or replace function public.record_complete_set_depth_captures(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.complete_set_depth_captures
    (captured_at, event_slug, lead_days, age_hours, n_buckets,
     sum_best_ask, under_net, exec_sets, exec_cost_usd, exec_profit_usd,
     per_leg_depth, raw_underround, fee_cleared)
  select
    (r->>'capturedAt')::timestamptz,
    coalesce(r->>'eventSlug', ''),
    nullif(r->>'leadDays',     '')::numeric,
    nullif(r->>'ageHours',     '')::numeric,
    (r->>'nBuckets')::int,
    nullif(r->>'sumBestAsk',   '')::numeric,
    nullif(r->>'underNet',     '')::numeric,
    coalesce((r->>'execSets')::int, 0),
    nullif(r->>'execCostUsd',  '')::numeric,
    nullif(r->>'execProfitUsd','')::numeric,
    coalesce(r->'perLegDepth', '[]'::jsonb),
    (r->>'rawUnderround')::boolean,
    (r->>'feeCleared')::boolean
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- === 4. grants (post-0034 contract) =========================================================================
revoke all on function public.dash_complete_set_depth(int)                    from public, anon, authenticated;
grant  execute on function public.dash_complete_set_depth(int)                to authenticated, service_role;

revoke all on function public.record_complete_set_depth_captures(jsonb)       from public, anon, authenticated;
grant  execute on function public.record_complete_set_depth_captures(jsonb)   to service_role;

grant all    on public.complete_set_depth_captures to service_role;
grant select on public.complete_set_depth_captures to authenticated;

-- === 4. cron: every 30 min — arb-depth-capture (thin fresh-book capture + reopening monitor) ==============
-- Same Vault-secret pattern as 0009/0026/0039/0049/0055/0056/0057. Idempotent (cron.schedule upserts).
-- PGlite has no real cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping arb-depth-capture registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/arb-depth-capture',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('arb-depth-capture', '*/30 * * * *', edge_command);
end;
$$;
