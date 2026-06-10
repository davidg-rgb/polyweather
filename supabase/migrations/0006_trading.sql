-- 0006_trading.sql — bets, bankroll_ledger + the bankroll_balance and
-- edge_decile_stats views (ARCHITECTURE.md §7.15–§7.16).

create table if not exists public.bets (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.market_events(id),
  bucket_id         uuid not null references public.market_buckets(id),
  side              text not null default 'YES' check (side in ('YES', 'NO')),
  status            text not null check (status in
                      ('recommended', 'expired', 'skipped', 'filled',
                       'execution_failed', 'resolved_win', 'resolved_lose')),
  mode              text not null default 'paper' check (mode in ('paper', 'live')),
  our_q             numeric(8,6) not null,
  best_ask          numeric(8,6) not null,
  exec_ask          numeric(8,6) not null,
  edge              numeric(8,6) not null,
  min_edge          numeric(8,6) not null,
  fee_per_share     numeric(8,6) not null,
  kelly_raw         numeric(8,6) not null,
  kelly_frac        numeric(8,6) not null,
  capped_frac       numeric(8,6) not null,
  rec_stake_usd     numeric(10,2) not null,
  rec_shares        numeric(12,2) not null,
  audit             jsonb not null,                            -- full input vector (ADR-09)
  -- ON DELETE SET NULL: the downsample cron may prune unscored distribution rows;
  -- the bet's audit jsonb preserves the full input vector regardless (ADR-09).
  dist_row_id       uuid references public.bucket_probabilities(id) on delete set null,
  recommended_at    timestamptz,
  expires_reason    text,
  approved_at       timestamptz,
  executed_price    numeric(8,6),
  executed_fee      numeric(10,4),
  executed_size_usd numeric(10,2),
  executed_shares   numeric(12,2),
  executed_at       timestamptz,
  pnl_usd           numeric(10,2),                             -- null until resolved
  resolution_native smallint,                                  -- actual temp at grading
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One open recommendation per (bucket, side) (§7.15).
create unique index if not exists bets_open_recommendation_key
  on public.bets (bucket_id, side)
  where status = 'recommended';
create index if not exists bets_status_idx on public.bets (status);
create index if not exists bets_event_idx on public.bets (event_id);

create or replace trigger trg_bets_updated_at
  before update on public.bets
  for each row execute function public.set_updated_at();

-- No stored running balance (W10: concurrent gradeEvent calls would
-- read-modify-write-corrupt it); balances come from the bankroll_balance VIEW.
create table if not exists public.bankroll_ledger (
  id         uuid primary key default gen_random_uuid(),
  bet_id     uuid references public.bets(id),
  entry_type text not null check (entry_type in
               ('init', 'stake', 'payout', 'fee_adjust', 'withdrawal', 'manual')),
  amount_usd numeric(12,2) not null,
  mode       text not null check (mode in ('paper', 'live')),
  created_at timestamptz not null default now()
);

-- Refund/double-grade impossible — per-mutation idempotency (§7.16).
create unique index if not exists bankroll_ledger_bet_entry_key
  on public.bankroll_ledger (bet_id, entry_type)
  where bet_id is not null;

-- Window SUM ordered by (created_at, id), partitioned per mode (§7.16).
create or replace view public.bankroll_balance
  with (security_invoker = true) as
select
  id,
  bet_id,
  entry_type,
  amount_usd,
  mode,
  created_at,
  sum(amount_usd) over (partition by mode order by created_at, id) as balance_usd
from public.bankroll_ledger;

-- §7.15a — the adverse-selection tracker (§11.4/R-13). Read-time aggregate, no storage.
create or replace view public.edge_decile_stats
  with (security_invoker = true) as
select
  width_bucket(edge, 0, 0.5, 10) as decile,
  mode,
  count(*)::int                                            as n,
  avg(case when status = 'resolved_win' then 1.0 else 0.0 end) as hit_rate,
  avg(edge)                                                as avg_edge,
  avg(our_q)                                               as avg_q,
  sum(pnl_usd)                                             as pnl_sum
from public.bets
where status in ('resolved_win', 'resolved_lose')
group by 1, 2;
