-- 0059_sharps_dashboard.sql — /sharps analytics page: SPORTS-leaderboard roster + per-trader fingerprints.
--
-- Surfaces the SPORTS-TRADERS.md study as a live operator page: named roster of the top Polymarket sports
-- traders + per-trader style fingerprints (volume-machine vs high-roi-specialist archetypes, entry-odds
-- histogram, sweep/burst %, mid-odds fraction, sub-sport mix, VWAP). The copy-trade rail stays DORMANT
-- (9th falsified signal, FINDINGS.md); this is the INSIGHT product, not a trade signal.
--
-- Three components:
--   1. sports_sharps table — snapshot-series (one row per captured_at × wallet) of the SPORTS leaderboard
--      roster + lightweight fingerprints. RLS ON, no read policy (read-only via the security-definer RPC,
--      matching the 0057 pattern). Service-role insert via record_sports_sharps.
--   2. dash_sharps(p_limit) — read RPC returning a jsonb OBJECT (NOT a bare array — the 0044 trap) with
--      the latest capture's roster + headline meta. security definer, operator_guard, authenticated+service_role.
--      NEW function name — never re-signature an existing function (0054 overload trap).
--   3. pg_cron daily job 'sharps-snapshot' — calls the sharps-snapshot Edge fn at 02:00 UTC (daily is right:
--      the leaderboard and fingerprints move slowly). Reads secrets from vault (W11 assertion).

-- === 1. snapshot table ================================================================================
create table if not exists public.sports_sharps (
  id              bigint generated always as identity primary key,
  captured_at     timestamptz not null,
  wallet          text        not null,
  trader_name     text,
  rank            int,
  pnl_all_usd     numeric,
  vol_all_usd     numeric,
  roi_proxy       numeric,
  archetype       text,        -- 'volume-machine' | 'high-roi-specialist'
  n_fills         int,
  sweep_fraction  numeric,
  mid_odds_fraction numeric,
  vwap_entry      numeric,
  sports_mix      jsonb,       -- { soccer: 0.98, basketball: 0.02, ... }
  odds_histogram  jsonb        -- [ { label, lo, hi, count, notionalUsd }, ... ]
);

create index if not exists sports_sharps_captured_wallet_idx
  on public.sports_sharps (captured_at desc, wallet);
create index if not exists sports_sharps_captured_idx
  on public.sports_sharps (captured_at desc);

comment on table public.sports_sharps is
  'SPORTS-leaderboard roster snapshots + per-trader fingerprints (sharps-snapshot Edge tick, daily). Analytics-only; copy-trade rail DORMANT (SPORTS-TRADERS.md §3–4).';

-- RLS on (ADR-13): written only by record_sports_sharps (security definer); no read policy =>
-- anon/authenticated get nothing by direct query. Read via dash_sharps only.
alter table public.sports_sharps enable row level security;

-- === 2. record_sports_sharps — bulk insert one capture's rows (service-role; the Edge tick's write) ====
create or replace function public.record_sports_sharps(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  insert into public.sports_sharps
    (captured_at, wallet, trader_name, rank, pnl_all_usd, vol_all_usd, roi_proxy, archetype,
     n_fills, sweep_fraction, mid_odds_fraction, vwap_entry, sports_mix, odds_histogram)
  select
    (r->>'capturedAt')::timestamptz,
    r->>'wallet',
    r->>'traderName',
    (r->>'rank')::int,
    (r->>'pnlAllUsd')::numeric,
    (r->>'volAllUsd')::numeric,
    (r->>'roiProxy')::numeric,
    r->>'archetype',
    (r->>'nFills')::int,
    (r->>'sweepFraction')::numeric,
    (r->>'midOddsFraction')::numeric,
    (r->>'vwapEntry')::numeric,
    (r->>'sportsMix')::jsonb,
    (r->>'oddsHistogram')::jsonb
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- service-role only (the Edge tick's write path)
revoke all on function public.record_sports_sharps(jsonb) from public, anon, authenticated;
grant  execute on function public.record_sports_sharps(jsonb) to service_role;

-- === 3. dash_sharps — operator read RPC (security definer, jsonb OBJECT, NEW name) ==================
create or replace function public.dash_sharps(p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v           jsonb;
  v_limit     int         := greatest(coalesce(p_limit, 20), 1);
  v_latest    timestamptz;
begin
  perform public.operator_guard();

  select max(captured_at) into v_latest from public.sports_sharps;

  select jsonb_build_object(
    -- latest capture meta
    'latest', jsonb_build_object(
      'capturedAt', v_latest,
      'nTraders',   (select count(*) from public.sports_sharps where captured_at = v_latest)
    ),
    -- roster: top traders in the latest capture, ordered by pnl_all_usd desc
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object(
        'rank',             s.rank,
        'wallet',           s.wallet,
        'trader',           coalesce(s.trader_name, s.wallet),
        'pnlAllUsd',        s.pnl_all_usd,
        'volAllUsd',        s.vol_all_usd,
        'roiProxy',         s.roi_proxy,
        'archetype',        s.archetype,
        'nFills',           s.n_fills,
        'sweepFraction',    s.sweep_fraction,
        'midOddsFraction',  s.mid_odds_fraction,
        'vwapEntry',        s.vwap_entry,
        'sportsMix',        s.sports_mix,
        'oddsHistogram',    s.odds_histogram
      ) order by coalesce(s.pnl_all_usd, 0) desc)
      from (
        select * from public.sports_sharps
        where captured_at = v_latest
        order by coalesce(pnl_all_usd, 0) desc
        limit v_limit
      ) s
    ), '[]'::jsonb)
  ) into v;

  return v;
end;
$$;

-- operator-readable dashboard surface (post-0034 contract)
revoke all on function public.dash_sharps(int) from public, anon, authenticated;
grant  execute on function public.dash_sharps(int) to authenticated, service_role;

-- === 4. cron: daily sharps-snapshot tick ==========================================================
-- Daily at 02:00 UTC — leaderboard + fingerprints move slowly, daily is the right cadence.
-- Vault-secret pattern identical to 0057 (W11 assertion: reads project_url + cron_secret from vault).
-- idempotent (cron.schedule upserts by jobname). PGlite skips cron registration.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping sharps-snapshot registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/sharps-snapshot',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('sharps-snapshot', '0 2 * * *', edge_command);
end;
$$;
