-- 0053_replica_paper_trial.sql — persist the badatmath-replica paper-trial so /replica can render it.
--
-- The badatmath replica (BADATMATH-REPLICA.md; pure engine core/sim/badatmath-replica.ts) is a fictional,
-- no-money paper-trial that mimics the #1 WEATHER sharp's revealed buying model and scores every buy three
-- ways (maker-ideal / maker-realistic / taker — the spread tax + adverse-selection tax). Until now it lived
-- only as local markdown/CSV/JSON written by scripts/research/badatmath-replica*.ts. The operator asked for a
-- VISIBLE web dashboard next to /amsterdam, so this migration gives the trial a home in Postgres that the
-- RLS-scoped web port (RPC-only) can read.
--
-- Two tables: replica_positions (one row per placed position — the LockedBuy the engine scores, plus the
-- forward bookkeeping) and replica_runs (one row per run — the strategy + whitelist + funnel counts, for the
-- header + "last run"). Two service-role write RPCs (replica_record_positions / replica_record_run, the 0049
-- idiom) the LOCAL daily forward task + the backtest --persist call. One operator-gated read RPC
-- (dash_replica_sim) the /replica loader calls; it returns the raw positions + the latest runs, and the
-- loader scores them through the SAME core engine the scripts use (scoreLocked → summarize/dailyLedger/
-- rankCitiesByRoi), so the web view and the scripts can never disagree.
--
-- STILL a paper-trial: no `packages/trading`, no real orders. These tables are the only thing the replica
-- now writes to prod, and only because the operator chose the web surface.

-- --- tables ------------------------------------------------------------------------------------------

-- One placed paper position = one bucket's Yes leg bought under the §15 playbook. Carries every field the
-- pure engine's scoreLocked needs (so the read RPC needs no joins), plus forward bookkeeping (placed/closed
-- timestamps, status). `source` separates the backtest seed from the live forward accrual.
create table if not exists public.replica_positions (
  id                     uuid primary key default gen_random_uuid(),
  source                 text not null check (source in ('backtest', 'forward')),
  condition_id           text not null default '',                 -- per-bucket market condition id (may be '')
  event_id               uuid not null,                            -- market_events.id (not FK — a paper artifact)
  city_slug              text not null,
  region                 text not null default '',
  target_date            date not null,                            -- resolution day (the ledger axis)
  bucket_idx             int  not null,
  bucket_label           text not null default '',
  resolution_ts          bigint not null,                          -- unix seconds (localDayWindow end)
  entry_ts               bigint not null,                          -- unix seconds (resolution − entryLeadHours)
  entry_day_utc          date not null,                            -- bankroll-cap grouping day
  maker_price            numeric(8,6) not null,                    -- rested cheap bid (maker legs transact here)
  taker_price            numeric(8,6) not null,                    -- ask at entry (taker leg)
  stake_usd              numeric(12,4) not null,
  fee_rate               numeric(8,6) not null default 0,
  bucket_won             boolean,                                  -- null = still pending (open forward bet)
  maker_realistic_filled boolean not null default false,          -- §12 ask-touch fill decided at reconcile
  status                 text not null check (status in ('open', 'resolved')),
  placed_at_utc          timestamptz,                              -- forward: when we placed it (null for backtest)
  closed_at_utc          timestamptz,                              -- forward: when we observed resolution
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create unique index if not exists replica_positions_natural_key
  on public.replica_positions (source, event_id, bucket_idx);
create index if not exists replica_positions_source_target_idx
  on public.replica_positions (source, target_date);
create index if not exists replica_positions_city_idx
  on public.replica_positions (source, city_slug);

create or replace trigger trg_replica_positions_updated_at
  before update on public.replica_positions
  for each row execute function public.set_updated_at();

-- One row per run (backtest seed re-runs + each daily forward run): the strategy actually used (for the
-- header), the computed best-cities whitelist, the §15 funnel counts, and the run's open/closed/opened/
-- reconciled tallies. The read RPC surfaces the latest of each mode + a short recent-runs trail.
create table if not exists public.replica_runs (
  id            uuid primary key default gen_random_uuid(),
  mode          text not null check (mode in ('backtest', 'forward')),
  ran_at        timestamptz not null default now(),
  seed_from     date,
  seed_to       date,
  whitelist     text[] not null default '{}',
  strat         jsonb not null,
  n_candidates  int not null default 0,
  n_band        int not null default 0,
  n_selected    int not null default 0,
  n_allocated   int not null default 0,
  n_open        int not null default 0,
  n_closed      int not null default 0,
  n_opened      int not null default 0,
  n_reconciled  int not null default 0,
  created_at    timestamptz not null default now()
);

create index if not exists replica_runs_mode_ranat_idx on public.replica_runs (mode, ran_at desc);

-- --- RLS (operator reads; service-role writes; anon nothing) — mirror 0049 -----------------------------
alter table public.replica_positions enable row level security;
drop policy if exists operator_read on public.replica_positions;
create policy operator_read on public.replica_positions
  for select to authenticated using (public.is_operator());
grant select on public.replica_positions to anon, authenticated;
grant all on public.replica_positions to service_role;

alter table public.replica_runs enable row level security;
drop policy if exists operator_read on public.replica_runs;
create policy operator_read on public.replica_runs
  for select to authenticated using (public.is_operator());
grant select on public.replica_runs to anon, authenticated;
grant all on public.replica_runs to service_role;

-- --- record positions (idempotent) -------------------------------------------------------------------
-- p_rows: the scored/locked positions as jsonb (camelCase keys mirroring core LockedBuy + bookkeeping).
-- When p_replace, the source's rows are wiped first (a clean reseed — the script always sends the full
-- current set, so the table is an exact projection of the run's state). Upsert by the natural key otherwise.
create or replace function public.replica_record_positions(
  p_source  text,
  p_replace boolean,
  p_rows    jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_count int;
begin
  if p_source not in ('backtest', 'forward') then
    raise exception 'replica_record_positions: bad source %', p_source using errcode = 'check_violation';
  end if;

  if coalesce(p_replace, false) then
    delete from public.replica_positions where source = p_source;
  end if;

  insert into public.replica_positions
    (source, condition_id, event_id, city_slug, region, target_date, bucket_idx, bucket_label,
     resolution_ts, entry_ts, entry_day_utc, maker_price, taker_price, stake_usd, fee_rate,
     bucket_won, maker_realistic_filled, status, placed_at_utc, closed_at_utc)
  select
    p_source,
    coalesce(r->>'conditionId', ''),
    (r->>'eventId')::uuid,
    r->>'citySlug',
    coalesce(r->>'region', ''),
    (r->>'targetDate')::date,
    (r->>'bucketIdx')::int,
    coalesce(r->>'bucketLabel', ''),
    (r->>'resolutionTs')::bigint,
    (r->>'entryTs')::bigint,
    (r->>'entryDayUtc')::date,
    (r->>'makerPrice')::numeric,
    (r->>'takerPrice')::numeric,
    (r->>'stakeUsd')::numeric,
    coalesce((r->>'feeRate')::numeric, 0),
    case when r->>'bucketWon' is null then null else (r->>'bucketWon')::boolean end,
    coalesce((r->>'makerRealisticFilled')::boolean, false),
    r->>'status',
    nullif(r->>'placedAtUtc', '')::timestamptz,
    nullif(r->>'closedAtUtc', '')::timestamptz
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) r
  on conflict (source, event_id, bucket_idx) do update set
    condition_id           = excluded.condition_id,
    city_slug              = excluded.city_slug,
    region                 = excluded.region,
    target_date            = excluded.target_date,
    bucket_label           = excluded.bucket_label,
    resolution_ts          = excluded.resolution_ts,
    entry_ts               = excluded.entry_ts,
    entry_day_utc          = excluded.entry_day_utc,
    maker_price            = excluded.maker_price,
    taker_price            = excluded.taker_price,
    stake_usd              = excluded.stake_usd,
    fee_rate               = excluded.fee_rate,
    bucket_won             = excluded.bucket_won,
    maker_realistic_filled = excluded.maker_realistic_filled,
    status                 = excluded.status,
    placed_at_utc          = excluded.placed_at_utc,
    closed_at_utc          = excluded.closed_at_utc;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- --- record run (one row per run) --------------------------------------------------------------------
-- p_payload: { mode, ranAt, seedFrom, seedTo, whitelist[], strat{}, nCandidates, nBand, nSelected,
-- nAllocated, nOpen, nClosed, nOpened, nReconciled }. Appends a run row (history kept for the recent trail).
create or replace function public.replica_record_run(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.replica_runs
    (mode, ran_at, seed_from, seed_to, whitelist, strat,
     n_candidates, n_band, n_selected, n_allocated, n_open, n_closed, n_opened, n_reconciled)
  values (
    p_payload->>'mode',
    coalesce(nullif(p_payload->>'ranAt', '')::timestamptz, now()),
    nullif(p_payload->>'seedFrom', '')::date,
    nullif(p_payload->>'seedTo', '')::date,
    coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p_payload->'whitelist', '[]'::jsonb)) x), '{}'),
    coalesce(p_payload->'strat', '{}'::jsonb),
    coalesce((p_payload->>'nCandidates')::int, 0),
    coalesce((p_payload->>'nBand')::int, 0),
    coalesce((p_payload->>'nSelected')::int, 0),
    coalesce((p_payload->>'nAllocated')::int, 0),
    coalesce((p_payload->>'nOpen')::int, 0),
    coalesce((p_payload->>'nClosed')::int, 0),
    coalesce((p_payload->>'nOpened')::int, 0),
    coalesce((p_payload->>'nReconciled')::int, 0)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- --- dashboard read: dash_replica_sim ----------------------------------------------------------------
-- Returns the raw positions (both sources) + the latest run per mode + a recent-runs trail. The loader
-- scores positions through the core engine, so all roll-ups (three curves, daily ledger, cities) are one
-- source of truth shared with the scripts. Operator-gated (post-0034 contract), RPC-only web read.
create or replace function public.dash_replica_sim()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();

  select jsonb_build_object(
    'positions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'source', source, 'conditionId', condition_id, 'eventId', event_id, 'citySlug', city_slug,
        'region', region, 'targetDate', target_date, 'bucketIdx', bucket_idx, 'bucketLabel', bucket_label,
        'resolutionTs', resolution_ts, 'entryTs', entry_ts, 'entryDayUtc', entry_day_utc,
        'makerPrice', maker_price, 'takerPrice', taker_price, 'stakeUsd', stake_usd, 'feeRate', fee_rate,
        'bucketWon', bucket_won, 'makerRealisticFilled', maker_realistic_filled, 'status', status,
        'placedAtUtc', placed_at_utc, 'closedAtUtc', closed_at_utc
      ) order by target_date, city_slug, bucket_idx), '[]'::jsonb)
      from public.replica_positions
    ),
    'runs', jsonb_build_object(
      'backtest', (
        select jsonb_build_object(
          'mode', mode, 'ranAt', ran_at, 'seedFrom', seed_from, 'seedTo', seed_to, 'whitelist', whitelist,
          'strat', strat, 'nCandidates', n_candidates, 'nBand', n_band, 'nSelected', n_selected,
          'nAllocated', n_allocated, 'nOpen', n_open, 'nClosed', n_closed, 'nOpened', n_opened,
          'nReconciled', n_reconciled
        )
        from public.replica_runs where mode = 'backtest' order by ran_at desc limit 1
      ),
      'forward', (
        select jsonb_build_object(
          'mode', mode, 'ranAt', ran_at, 'seedFrom', seed_from, 'seedTo', seed_to, 'whitelist', whitelist,
          'strat', strat, 'nCandidates', n_candidates, 'nBand', n_band, 'nSelected', n_selected,
          'nAllocated', n_allocated, 'nOpen', n_open, 'nClosed', n_closed, 'nOpened', n_opened,
          'nReconciled', n_reconciled
        )
        from public.replica_runs where mode = 'forward' order by ran_at desc limit 1
      )
    ),
    'recentRuns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'mode', mode, 'ranAt', ran_at, 'nOpen', n_open, 'nClosed', n_closed,
        'nOpened', n_opened, 'nReconciled', n_reconciled
      ) order by ran_at desc), '[]'::jsonb)
      from (select * from public.replica_runs order by ran_at desc limit 12) rr
    )
  ) into v;

  return v;
end;
$$;

-- --- grants (post-0034 contract) ---------------------------------------------------------------------
revoke all on function public.replica_record_positions(text, boolean, jsonb) from public, anon, authenticated;
grant  execute on function public.replica_record_positions(text, boolean, jsonb) to service_role;
revoke all on function public.replica_record_run(jsonb) from public, anon, authenticated;
grant  execute on function public.replica_record_run(jsonb) to service_role;

revoke all on function public.dash_replica_sim() from public, anon, authenticated;
grant  execute on function public.dash_replica_sim() to service_role;
grant  execute on function public.dash_replica_sim() to authenticated;
