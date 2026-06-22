-- 0050_wallet_forensics_persist.sql — persist a wallet's reconstructed realized-PnL forensics.
--
-- WALLET-RECON-HANDOFF.md Build #2 (the skill-vs-survivorship gate). scripts/wallet-forensics.ts
-- reconstructs a Polymarket wallet's TRUE realized performance from public /activity fills (FIFO per
-- (conditionId,outcome), in @weather-edge/core sim/wallet-forensics.ts) and reconciles it against the
-- user-pnl-api ground-truth curve. This migration gives `--persist` a home: the reconstructed daily curve
-- and the per-bet calibration rows, so a forensic run is durable (re-runnable, diff-able over time to watch
-- whether the edge persists or decays — §8 item 6). This is ANALYTICS persistence, NOT trading and not a
-- copy-trade (the live-trading thesis stays closed per FORECASTING-RD.md; packages/trading stays dormant).
--
-- Idempotent: the record RPC upserts by natural key so the daily Edge/manual re-run is byte-stable. RLS /
-- grants mirror amsterdam_truth (0043) and the 0049 tracker: operator reads; service-role writes; anon
-- nothing. The single record RPC is service-role-only (post-0034 contract). references tracked_wallets
-- (0049) so a persisted wallet is a tracked wallet.
--
-- NOTE: this migration is created but NOT applied by the build lane (the orchestrator applies it). PGlite
-- has no cron — there is no cron here, so the test harness applies it cleanly.

-- --- table: the reconstructed daily realized-PnL curve (the user-pnl-api analog) ---------------------
create table if not exists public.wallet_pnl_daily (
  address      text not null references public.tracked_wallets(address),
  day          date not null,                                  -- UTC day of the settling fill
  realized_usd numeric(16,4) not null,                         -- realized P&L booked that day
  cum_usd      numeric(18,4) not null,                         -- cumulative realized P&L through that day
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (address, day)
);

comment on table public.wallet_pnl_daily is
  'Reconstructed cumulative realized-PnL curve for a tracked wallet (FIFO over /activity fills, core/sim/'
  'wallet-forensics.ts). The deterministic analog of user-pnl-api; the reconciliation gate compares the '
  'final cum_usd to the ground-truth curve. Written by scripts/wallet-forensics.ts --persist.';

create or replace trigger trg_wallet_pnl_daily_updated_at
  before update on public.wallet_pnl_daily
  for each row execute function public.set_updated_at();

create index if not exists wallet_pnl_daily_day_idx on public.wallet_pnl_daily (day);

-- --- table: per-bet calibration rows (the revealed bets reduced to {entryPrice, won, realized}) ------
create table if not exists public.wallet_bet_calibration (
  id           uuid primary key default gen_random_uuid(),
  address      text not null references public.tracked_wallets(address),
  condition_id text not null,                                  -- the per-bucket market condition id
  outcome      text not null,                                  -- 'Yes' | 'No' (the leg)
  entry_price  numeric(8,6) not null,                          -- volume-weighted BUY price = implied prob
  won          boolean not null,                               -- settled in the money
  realized_usd numeric(16,4) not null,
  staked_usd   numeric(16,4) not null,
  city_slug    text,
  target_date  date,
  region       text,                                           -- 'US' | 'INTL' | null
  recorded_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (address, condition_id, outcome)
);

comment on table public.wallet_bet_calibration is
  'Per-bet realized outcomes for a tracked wallet ({entryPrice, won, realizedUsd} = a GradedBet) — the '
  'calibration / ROI-by-entry-bucket / attribution input. entry_price is the implied probability the wallet '
  'paid; won is whether the position settled in the money. Written by scripts/wallet-forensics.ts --persist.';

create or replace trigger trg_wallet_bet_calibration_updated_at
  before update on public.wallet_bet_calibration
  for each row execute function public.set_updated_at();

create index if not exists wallet_bet_calibration_addr_idx on public.wallet_bet_calibration (address);
create index if not exists wallet_bet_calibration_entry_idx on public.wallet_bet_calibration (entry_price);
create index if not exists wallet_bet_calibration_city_target_idx
  on public.wallet_bet_calibration (city_slug, target_date);

-- --- RLS (mirror 0043 / 0049: operator reads; service-role writes; anon nothing) --------------------
alter table public.wallet_pnl_daily enable row level security;
drop policy if exists operator_read on public.wallet_pnl_daily;
create policy operator_read on public.wallet_pnl_daily
  for select to authenticated using (public.is_operator());
grant select on public.wallet_pnl_daily to anon, authenticated;
grant all on public.wallet_pnl_daily to service_role;

alter table public.wallet_bet_calibration enable row level security;
drop policy if exists operator_read on public.wallet_bet_calibration;
create policy operator_read on public.wallet_bet_calibration
  for select to authenticated using (public.is_operator());
grant select on public.wallet_bet_calibration to anon, authenticated;
grant all on public.wallet_bet_calibration to service_role;

-- --- record RPC (idempotent) ------------------------------------------------------------------------
-- Persists a forensic run: ensures the wallet exists, replaces the daily curve (upsert by (address,day)),
-- and upserts the per-bet calibration rows (by (address,condition_id,outcome)). Returns the row counts.
-- p_daily: [{date, realizedUsd, cumUsd}]; p_bets: [{conditionId, outcome, entryPrice, won, realizedUsd,
-- stakedUsd, citySlug, targetDate, region}]. Both arrays are passed as jsonb (postgres-js encodes the JS
-- array directly — NOT JSON.stringify, which double-encodes into a jsonb scalar; the 0049 idiom).
create or replace function public.wallet_forensics_record(
  p_address text,
  p_daily   jsonb,
  p_bets    jsonb
)
returns table (daily int, cal int)
language plpgsql
security definer
set search_path = public
as $$
declare v_daily int := 0; v_cal int := 0;
begin
  insert into public.tracked_wallets (address, label, source)
  values (p_address, p_address, 'manual')
  on conflict (address) do nothing;

  insert into public.wallet_pnl_daily (address, day, realized_usd, cum_usd)
  select p_address, (r->>'date')::date, (r->>'realizedUsd')::numeric, (r->>'cumUsd')::numeric
  from jsonb_array_elements(coalesce(p_daily, '[]'::jsonb)) r
  on conflict (address, day) do update set
    realized_usd = excluded.realized_usd,
    cum_usd      = excluded.cum_usd;
  get diagnostics v_daily = row_count;

  insert into public.wallet_bet_calibration
    (address, condition_id, outcome, entry_price, won, realized_usd, staked_usd, city_slug, target_date, region)
  select
    p_address, r->>'conditionId', r->>'outcome', (r->>'entryPrice')::numeric,
    (r->>'won')::boolean, (r->>'realizedUsd')::numeric, (r->>'stakedUsd')::numeric,
    nullif(r->>'citySlug', ''), nullif(r->>'targetDate', '')::date, nullif(r->>'region', '')
  from jsonb_array_elements(coalesce(p_bets, '[]'::jsonb)) r
  on conflict (address, condition_id, outcome) do update set
    entry_price  = excluded.entry_price,
    won          = excluded.won,
    realized_usd = excluded.realized_usd,
    staked_usd   = excluded.staked_usd,
    city_slug    = excluded.city_slug,
    target_date  = excluded.target_date,
    region       = excluded.region,
    recorded_at  = now();
  get diagnostics v_cal = row_count;

  daily := v_daily; cal := v_cal; return next;
end;
$$;

-- --- grants (post-0034 contract): record RPC is service-role only ------------------------------------
revoke all on function public.wallet_forensics_record(text, jsonb, jsonb) from public, anon, authenticated;
grant  execute on function public.wallet_forensics_record(text, jsonb, jsonb) to service_role;
