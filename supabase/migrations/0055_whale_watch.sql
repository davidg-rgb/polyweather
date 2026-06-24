-- 0055_whale_watch.sql — Polymarket WHALE-trade watcher + a global Slack-alert PAUSE gate.
--
-- Operator ask (2026-06-24): "set up a signal for unusual high bets — if any one bet above $100,000 is made
-- on anything, notify me", and "put every other Slack notification on pause starting now".
--
-- WHAT THIS IS: a read-only monitor over Polymarket's public, keyless Data API /trades GLOBAL feed (ALL
-- markets, not just our weather universe). It supports a SERVER-SIDE notional floor (filterType=CASH&
-- filterAmount=N → only fills whose USDC notional ≥ N), so each poll returns just the whales. The Edge
-- tick `whale-watch` (every 10 min) records new ≥ whale_min_usd trades here and fires a Slack alert per new
-- one, with the market/side/size/price/trader + a polymarket.com/event/{slug} link. Parsers/fetcher live in
-- _shared/polymarket-wallet.ts (parseTrades/fetchTrades). It is NOT trading and places no orders — the
-- live-trading rail stays DORMANT (CLAUDE.md / FINDINGS.md); this is pure market-microstructure analytics,
-- a sibling of the 0049 sharp-wallet tracker.
--
-- THE PAUSE GATE: a single config-driven chokepoint (slack_alert_suppressed) consulted by BOTH claim_alert
-- (suppress at record time — no resend on resume) and list_unsent_alerts (don't leak queued kinds via the
-- ADR-11 resend sweep). When config alerts_slack_paused='true', every alert kind NOT in the allowlist
-- (alerts_slack_allow_kinds, default 'WHALE_TRADE') is dropped. Default ships OFF (false) — flipping it on is
-- an operational action (RUNBOOK), so a fresh DB behaves exactly as before. ⚠ When paused, this silences
-- CRITICAL job-failure alerts too — re-enable with: update config set value='false' where key='alerts_slack_paused';

-- === 1. config keys (default OFF / behaviour-preserving) =====================================================
insert into public.config (key, value) values
  ('whale_min_usd',            '100000'),       -- single-trade USDC notional floor for an alert
  ('alerts_slack_paused',      'false'),        -- master pause; 'true' suppresses all non-allowlisted kinds
  ('alerts_slack_allow_kinds', 'WHALE_TRADE')   -- comma-separated kinds that survive the pause
on conflict (key) do nothing;

-- === 2. whale_trades — the recorded large trades (one row per taker fill ≥ threshold) =======================
create table if not exists public.whale_trades (
  trade_key        text primary key,                    -- deterministic id: txhash:asset:side:size:price:ts
  transaction_hash text not null,                        -- Polygon tx (links to polygonscan)
  proxy_wallet     text not null,                        -- the trader's Polygon proxy wallet
  trader_name      text,                                 -- handle / pseudonym (null when anonymous)
  asset            text,                                 -- ERC-1155 token id
  condition_id     text,                                 -- market condition id
  outcome          text,                                 -- 'Yes'|'No'|'Under'|… (multi-outcome, raw)
  side             text,                                 -- 'BUY'|'SELL' (taker side)
  size_shares      numeric(24,4) not null,
  price            numeric(10,6) not null,               -- 0..1 implied probability
  notional_usd     numeric(20,2) not null,               -- size × price (the CASH-filter quantity)
  title            text,                                 -- market question
  event_slug       text,                                 -- → polymarket.com/event/{event_slug}
  market_slug      text,                                 -- the specific bucket/leg slug
  link             text,                                 -- the resolved bet permalink
  traded_at        timestamptz not null,                 -- fill time (from the unix `timestamp`)
  alerted          boolean not null default false,       -- flipped true once the Slack post succeeds
  created_at       timestamptz not null default now()
);
create index if not exists whale_trades_traded_at_idx on public.whale_trades (traded_at desc);
create index if not exists whale_trades_notional_idx  on public.whale_trades (notional_usd desc);
create index if not exists whale_trades_pending_idx   on public.whale_trades (alerted) where alerted = false;

-- RLS: operator reads; service-role writes; anon nothing (mirror 0049).
alter table public.whale_trades enable row level security;
drop policy if exists operator_read on public.whale_trades;
create policy operator_read on public.whale_trades
  for select to authenticated using (public.is_operator());
grant select on public.whale_trades to anon, authenticated;
grant all on public.whale_trades to service_role;

-- === 3. the pause chokepoint ================================================================================
-- TRUE when a kind must be suppressed: master pause on AND the kind is not in the allowlist. Total: missing
-- config keys default to not-paused / WHALE_TRADE-only. Security definer so it reads config under RLS.
create or replace function public.slack_alert_suppressed(p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select value from public.config where key = 'alerts_slack_paused'), 'false') = 'true'
     and p_kind not in (
       select trim(x)
       from unnest(string_to_array(
         coalesce((select value from public.config where key = 'alerts_slack_allow_kinds'), 'WHALE_TRADE'),
         ','
       )) as x
     );
$$;
-- Internal helper: only ever called NESTED inside the security-definer claim_alert / list_unsent_alerts
-- (which run as owner), so it needs no anon/authenticated grant — keep it service-role-only (0034 contract).
revoke all on function public.slack_alert_suppressed(text) from public, anon, authenticated;
grant  execute on function public.slack_alert_suppressed(text) to service_role;

-- claim_alert — 0011 body RE-STATED VERBATIM with one addition: a pause guard at the very top. When the kind
-- is suppressed, return 'skip' WITHOUT recording (so it never resends), exactly like an already-sent dupe.
create or replace function public.claim_alert(
  p_kind text,
  p_severity text,
  p_dedupe_key text,
  p_title text,
  p_body text
)
returns table (decision text, alert_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_sent boolean;
begin
  -- 0055 pause gate — drop non-allowlisted kinds while paused (not recorded → no resend on resume).
  if public.slack_alert_suppressed(p_kind) then
    return query select 'skip'::text, null::uuid;
    return;
  end if;

  if p_dedupe_key is null then
    insert into alerts_log (kind, severity, dedupe_key, title, body, sent)
    values (p_kind, p_severity, null, p_title, p_body, false)
    returning alerts_log.id into v_id;
    return query select 'insert'::text, v_id;
    return;
  end if;

  begin
    insert into alerts_log (kind, severity, dedupe_key, title, body, sent)
    values (p_kind, p_severity, p_dedupe_key, p_title, p_body, false)
    returning alerts_log.id into v_id;
    return query select 'insert'::text, v_id;
    return;
  exception when unique_violation then
    select al.id, al.sent into v_id, v_sent
    from alerts_log al
    where al.dedupe_key = p_dedupe_key
      and ((al.created_at at time zone 'utc')::date) = ((now() at time zone 'utc')::date);
    if v_sent then
      return query select 'skip'::text, v_id;
    else
      return query select 'retry'::text, v_id;
    end if;
    return;
  end;
end;
$$;

-- list_unsent_alerts — 0020 body RE-STATED with one addition: skip suppressed kinds so the resend sweep does
-- not leak paused alerts while the pause is on (they resume cleanly once it is flipped off).
create or replace function public.list_unsent_alerts(p_older_min int)
returns table (id uuid, kind text, severity text, title text, body text)
language sql
security definer
set search_path = public
as $$
  select a.id, a.kind, a.severity, a.title, a.body
  from alerts_log a
  where a.sent = false
    and a.created_at < now() - make_interval(mins => p_older_min)
    and not public.slack_alert_suppressed(a.kind)
  order by a.created_at
  limit 20;
$$;

-- === 4. whale ingest + alert-queue RPCs (service-role only) =================================================
-- Idempotent bulk insert keyed by trade_key (deterministic TS-side). Skips trades already seen; returns the
-- count of NEW rows. p_rows: the handler's mapped Trade rows (camelCase keys + tradeKey + link).
create or replace function public.whale_record_trades(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.whale_trades
    (trade_key, transaction_hash, proxy_wallet, trader_name, asset, condition_id, outcome, side,
     size_shares, price, notional_usd, title, event_slug, market_slug, link, traded_at)
  select
    r->>'tradeKey', r->>'transactionHash', r->>'proxyWallet', nullif(r->>'traderName', ''),
    nullif(r->>'asset', ''), nullif(r->>'conditionId', ''), nullif(r->>'outcome', ''), nullif(r->>'side', ''),
    (r->>'sizeShares')::numeric, (r->>'price')::numeric, (r->>'notionalUsd')::numeric,
    nullif(r->>'title', ''), nullif(r->>'eventSlug', ''), nullif(r->>'marketSlug', ''), nullif(r->>'link', ''),
    to_timestamp((r->>'timestamp')::double precision)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  where r->>'tradeKey' is not null and r->>'transactionHash' is not null
  on conflict (trade_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The alert queue: trades not yet successfully Slack-posted, oldest-first (crash-safe at-least-once — a tick
-- that recorded then died re-finds them next run). Capped. Returns a jsonb array (no SETOF — db.ts contract).
create or replace function public.whale_pending_alerts(p_limit int default 50)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'tradeKey',    trade_key,
    'txHash',      transaction_hash,
    'proxyWallet', proxy_wallet,
    'trader',      coalesce(nullif(trader_name, ''), proxy_wallet),
    'side',        side,
    'outcome',     outcome,
    'title',       title,
    'sizeShares',  size_shares,
    'price',       price,
    'notionalUsd', notional_usd,
    'link',        link,
    'tradedAt',    traded_at
  ) order by traded_at), '[]'::jsonb)
  from (
    select * from public.whale_trades where alerted = false
    order by traded_at limit greatest(coalesce(p_limit, 50), 1)
  ) q;
$$;

-- Flip alerted=true for the keys whose Slack post succeeded (ADR-11: success only). Returns rows updated.
-- text[] (not jsonb): both the supabase-js port and the PGlite test port bind a JS string array to text[].
create or replace function public.whale_mark_alerted(p_keys text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  update public.whale_trades
  set alerted = true
  where trade_key = any(coalesce(p_keys, array[]::text[]));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Tunables the handler reads before each poll (DB-tunable threshold, no redeploy).
create or replace function public.whale_settings()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'minUsd', coalesce((select value from public.config where key = 'whale_min_usd'), '100000')::numeric
  );
$$;

-- === 5. operator read (recent whales, for verification / an optional panel) =================================
create or replace function public.dash_whale_watch(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'generatedAt', now(),
    'minUsd',  (select value from public.config where key = 'whale_min_usd')::numeric,
    'paused',  coalesce((select value from public.config where key = 'alerts_slack_paused'), 'false') = 'true',
    'count24h', (select count(*) from public.whale_trades where traded_at >= now() - interval '24 hours'),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tradedAt', traded_at, 'trader', coalesce(nullif(trader_name, ''), proxy_wallet), 'side', side,
        'outcome', outcome, 'title', title, 'notionalUsd', notional_usd, 'price', price,
        'sizeShares', size_shares, 'link', link, 'txHash', transaction_hash
      ) order by traded_at desc)
      from (select * from public.whale_trades order by traded_at desc limit greatest(coalesce(p_limit, 50), 1)) q
    ), '[]'::jsonb)
  ) into v;
  return v;
end;
$$;

-- === 6. grants (post-0034 contract) =========================================================================
revoke all on function public.whale_record_trades(jsonb)  from public, anon, authenticated;
grant  execute on function public.whale_record_trades(jsonb)  to service_role;
revoke all on function public.whale_pending_alerts(int)   from public, anon, authenticated;
grant  execute on function public.whale_pending_alerts(int)   to service_role;
revoke all on function public.whale_mark_alerted(text[]) from public, anon, authenticated;
grant  execute on function public.whale_mark_alerted(text[]) to service_role;
revoke all on function public.whale_settings()            from public, anon, authenticated;
grant  execute on function public.whale_settings()            to service_role;

revoke all on function public.dash_whale_watch(int) from public, anon, authenticated;
grant  execute on function public.dash_whale_watch(int) to authenticated, service_role;

-- === 7. cron: poll the whale feed every 10 minutes ==========================================================
-- Same Vault-secret pattern as 0009/0026/0039/0049; idempotent (cron.schedule upserts by jobname). PGlite has
-- no real cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping whale-watch registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/whale-watch',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('whale-watch', '*/10 * * * *', edge_command);
end;
$$;
