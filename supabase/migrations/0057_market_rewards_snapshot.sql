-- 0057_market_rewards_snapshot.sql — REC-8/REC-9 Phase A: persist the liquidity-reward + near-mid book-depth
-- time-series in the cloud (the Edge-fn twin of the local scripts/reward-snapshot.ts logger). REWARD-FARMING-HANDOFF §11.
--
-- WHY THIS TABLE NOW. The REC-8 first-pass measured the competition denominator from ONE instantaneous order-book
-- snapshot — the load-bearing weakness of its PASS. The local logger appends a JSONL series so the denominator can
-- become TIME-INTEGRATED; moving that logger to a Supabase Edge Function + pg_cron (runs 24/7, no PC) means there is
-- no local file to append to, so the series MUST land in a table. (Deliberately deferred while the destination was a
-- local file — the anti-cathedral call; choosing the online schedule is exactly the trigger that justifies it.)
--
-- The reward-snapshot Edge tick pulls the live CLOB /sampling-markets + /books (public, keyless), reduces each funded
-- weather market to its near-mid depth via core/polymarket/rewards.reduceBookDepth (shared with the local logger), and
-- bulk-inserts here via record_reward_snapshots. Read-only against Polymarket; the live trading rail stays DORMANT
-- (no packages/trading, no orders — this is analytics data capture only). Re-run the first-pass over the series for an
-- honest, time-integrated competition estimate; graduate to a /dashboard panel if the REC-9 probe CONFIRMS.

-- === 1. the time-series table ================================================================================
create table if not exists public.market_rewards (
  id                bigint generated always as identity primary key,
  captured_at       timestamptz not null,
  condition_id      text        not null,
  slug              text,
  daily_pool_usd    numeric,
  min_size          numeric,
  max_spread_cents  numeric,
  mid               numeric,
  best_bid          numeric,
  best_ask          numeric,
  bid_depth_shares  numeric,
  ask_depth_shares  numeric,
  bid_depth_usd     numeric,
  ask_depth_usd     numeric
);
-- series-by-market and latest-capture access paths.
create index if not exists market_rewards_cond_captured_idx on public.market_rewards (condition_id, captured_at desc);
create index if not exists market_rewards_captured_idx      on public.market_rewards (captured_at desc);

comment on table public.market_rewards is
  'REC-8/9 Phase A: per-capture funded-weather liquidity-reward rate + near-mid book depth time-series (Edge tick reward-snapshot every 20 min). Analytics-only; rail DORMANT.';

-- RLS on (ADR-13): written only by the security-definer record_reward_snapshots (bypasses RLS); no policy ⇒
-- anon/authenticated get nothing by direct query (service-role-internal analytics, like the post-0034 contract).
alter table public.market_rewards enable row level security;

-- === 2. record_reward_snapshots — bulk insert one capture's rows (service-role; the Edge tick's only write) ====
-- Takes a jsonb ARRAY of camelCase rows (the RewardSnapshotRow shape). Returns the row count. Insert-only (the
-- series is append-only — every capture is a new sample); no upsert, no dedup (distinct captured_at per run).
create or replace function public.record_reward_snapshots(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.market_rewards
    (captured_at, condition_id, slug, daily_pool_usd, min_size, max_spread_cents,
     mid, best_bid, best_ask, bid_depth_shares, ask_depth_shares, bid_depth_usd, ask_depth_usd)
  select
    (r->>'capturedUtc')::timestamptz,
    coalesce(r->>'conditionId', ''),
    r->>'slug',
    (r->>'dailyPoolUsd')::numeric,
    (r->>'minSize')::numeric,
    (r->>'maxSpreadCents')::numeric,
    nullif(r->>'mid', '')::numeric,
    nullif(r->>'bestBid', '')::numeric,
    nullif(r->>'bestAsk', '')::numeric,
    (r->>'bidDepthShares')::numeric,
    (r->>'askDepthShares')::numeric,
    (r->>'bidDepthUsd')::numeric,
    (r->>'askDepthUsd')::numeric
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- === 3. cron: the reward-snapshot tick (every 20 min — builds the time-integrated denominator) ================
-- Same Vault-secret pattern as 0009/0026/0039/0049/0055/0056; idempotent (cron.schedule upserts by jobname). PGlite
-- has no real cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping reward-snapshot registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/reward-snapshot',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('reward-snapshot', '*/20 * * * *', edge_command);
end;
$$;

-- === 4. grants (post-0034 contract) ==========================================================================
-- record_reward_snapshots is service-role-internal (the Edge tick): revoke from public/anon/authenticated.
revoke all on function public.record_reward_snapshots(jsonb) from public, anon, authenticated;
grant  execute on function public.record_reward_snapshots(jsonb) to service_role;
