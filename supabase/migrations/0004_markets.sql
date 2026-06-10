-- 0004_markets.sql — market_events, market_buckets, market_snapshots
-- (ARCHITECTURE.md §7.9–§7.11).

create table if not exists public.market_events (
  id                       uuid primary key default gen_random_uuid(),
  poly_event_id            text unique not null,
  slug                     text unique not null,
  kind                     text not null default 'highest' check (kind in ('highest', 'lowest')),
  city_id                  uuid not null references public.cities(id),
  icao_at_creation         text references public.stations(icao),  -- parsed station
  target_date              date not null,                          -- station-local
  unit                     text not null check (unit in ('F', 'C')),
  neg_risk_market_id       text,
  accepting_orders         boolean,
  volume24h                numeric(14,2),                          -- refreshed by poll
  liquidity                numeric(14,2),
  ladder_ok                boolean not null,                       -- validateLadder verdict
  ladder_problems          text[],
  winning_bucket_idx       smallint,                               -- null until graded
  poly_resolved_winner_idx smallint,                               -- from outcomePrices when closed
  grading_mismatch         boolean not null default false,         -- CRITICAL flag
  resolved_at              timestamptz,
  closed                   boolean not null default false,
  first_seen               timestamptz,
  last_seen                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists market_events_natural_key
  on public.market_events (city_id, target_date, kind);
create index if not exists market_events_open_idx
  on public.market_events (target_date) where not closed;
create index if not exists market_events_ungraded_idx
  on public.market_events (resolved_at) where winning_bucket_idx is null;

create or replace trigger trg_market_events_updated_at
  before update on public.market_events
  for each row execute function public.set_updated_at();

create table if not exists public.market_buckets (
  id               uuid primary key default gen_random_uuid(),
  event_id         uuid not null references public.market_events(id),
  bucket_idx       smallint not null,                          -- ladder position 0..n−1
  label            text not null,
  low_native       smallint,                                   -- null = open tail
  high_native      smallint,                                   -- null = open tail
  poly_market_id   text unique,
  condition_id     text not null,
  token_yes        text not null,                              -- 77-digit decimal strings
  token_no         text not null,
  tick_size        numeric(6,4),                               -- per-bucket (0.01 / 0.001 verified)
  min_order_size   numeric(8,2),
  fee_rate         numeric(5,4),                               -- from feeSchedule.rate
  resolved_outcome text check (resolved_outcome in ('win', 'lose')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists market_buckets_natural_key
  on public.market_buckets (event_id, bucket_idx);

create or replace trigger trg_market_buckets_updated_at
  before update on public.market_buckets
  for each row execute function public.set_updated_at();

-- Delta-deduped price snapshots (§7.11). The real overlap guard is poll-markets'
-- job_locks lease (ADR-12/C8); the unique key is the backstop against double-inserts.
create table if not exists public.market_snapshots (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   uuid not null references public.market_buckets(id),
  best_bid    numeric(8,6),
  best_ask    numeric(8,6),
  mid         numeric(8,6),
  spread      numeric(8,6),
  last_trade  numeric(8,6),
  book_top3   jsonb,                                           -- {bids:[{p,s}×3], asks:[…]} when fetched
  captured_at timestamptz not null,
  created_at  timestamptz not null default now()
);

create unique index if not exists market_snapshots_natural_key
  on public.market_snapshots (bucket_id, captured_at);
create index if not exists market_snapshots_bucket_time_idx
  on public.market_snapshots (bucket_id, captured_at desc);
