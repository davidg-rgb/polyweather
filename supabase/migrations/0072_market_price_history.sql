-- 0072_market_price_history.sql — full-resolution historical price-per-bucket ARCHIVE.
--
-- The `backfill-market-history --full-series` mode persists the COMPLETE CLOB prices-history series
-- (one price point per bucket per fidelity-minute, the market's whole lifetime) here — the minute/hour
-- odds path the daily-only backfill throws away.
--
-- WHY A DEDICATED TABLE (not market_snapshots): ops_downsample (0009, daily 03:00 UTC) thins
-- market_snapshots to 1/hour after 7 days and 1/day after 30 days. Backfilled history is BY DEFINITION
-- older than 30 days, so writing it into market_snapshots would be crushed to 1/day on the very next
-- downsample run. This table is APPEND-ONLY and is intentionally NOT referenced by ops_downsample — the
-- full minute series is preserved permanently. It is a research/analytics archive (single price per
-- bucket = implied probability), NOT executable odds: prices-history carries no bid/ask or depth, so the
-- forward live captures (market_snapshots / opening_captures) remain the only source of those.

create table if not exists public.market_price_history (
  id           bigint generated always as identity primary key,
  bucket_id    uuid not null references public.market_buckets(id),
  t            timestamptz not null,                       -- the price point time (CLOB prices-history `t`, epoch s)
  p            numeric(8,6) not null,                      -- price = implied probability of this bucket's YES
  fidelity_min smallint,                                   -- the prices-history fidelity (minutes) it was pulled at
  source       text not null default 'clob_prices_history',
  created_at   timestamptz not null default now()
);

-- one point per (bucket, instant) — the idempotency key (re-runs ON CONFLICT DO NOTHING). This same
-- (bucket_id, t) btree also serves the only read pattern: the full per-bucket series in ascending time
-- order. (Unlike market_snapshots — which adds a (bucket_id, captured_at DESC) index for its "latest point"
-- hot path — this is an append-only archive read whole, so no second/desc index is warranted.)
create unique index if not exists market_price_history_natural_key
  on public.market_price_history (bucket_id, t);

-- RLS mirrors every other table (0008): operator-only read; service-role (the script's connection) writes
-- bypass RLS. Required for the "every table has RLS enabled" migration test.
alter table public.market_price_history enable row level security;
drop policy if exists operator_read on public.market_price_history;
create policy operator_read on public.market_price_history
  for select to authenticated using (public.is_operator());
grant select on public.market_price_history to anon, authenticated;
grant all on public.market_price_history to service_role;
