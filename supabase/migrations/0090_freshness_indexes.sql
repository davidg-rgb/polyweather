-- 0090_freshness_indexes.sql — kill the data_freshness statement-timeout (loop C16, 2026-07-08).
--
-- THE INCIDENT (found via a live health probe): job_runs showed ~53 failures/24h, STEADY ~3–4/hr across ALL
-- hours (NOT a peak-only saturation spike): health-monitor's `data_freshness` RPC failing ~80% of its */30 ticks
-- and poll-markets' `upsert_market_snapshots` ~5% of its */5 ticks, both with `canceling statement due to
-- statement timeout`.
--
-- ROOT CAUSE. `data_freshness` (0020) computes `max(captured_at)` over BOTH market_snapshots (~346 MB, the hot
-- poll-markets table) AND forecast_snapshots — but NEITHER table has a captured_at-LEADING index:
--   • market_snapshots  → (bucket_id, captured_at) + (bucket_id, captured_at desc)   [both lead with bucket_id]
--   • forecast_snapshots → (icao,model,target_date,lead_days,snapshot_slot) + (icao,target_date) + (model,
--                           target_date) + (target_date,lead_days)                    [none lead with captured_at]
-- Postgres has no loose/skip index scan, so a global `max(captured_at)` over a bucket_id-leading index CANNOT be
-- index-answered → it FULL-SEQ-SCANS the whole table every */30 tick, exceeding the default statement_timeout;
-- and that repeated 346 MB scan contends on the Micro with poll-markets' concurrent upserts to the SAME table
-- (the ~5% money-path timeouts are collateral of the same load). A single captured_at-leading btree turns each
-- max() into an instant `ORDER BY captured_at DESC LIMIT 1` index fetch and SHEDS the scan load entirely.
--
-- ⚠ PROD DEPLOY — MONEY-PATH SAFETY (do NOT skip). market_snapshots is large + hot (poll-markets writes it */5).
-- A plain `CREATE INDEX` takes a SHARE lock that BLOCKS writes for the whole build → a money-path stall. So on
-- PROD, BUILD THESE CONCURRENTLY OUT-OF-BAND FIRST (lock-free; run OFF-PEAK; CONCURRENTLY cannot run inside a
-- migration's transaction, which is why they are not `create index concurrently` here):
--     create index concurrently if not exists market_snapshots_captured_idx  on public.market_snapshots  (captured_at desc);
--     create index concurrently if not exists forecast_snapshots_captured_idx on public.forecast_snapshots (captured_at desc);
-- THEN apply this migration — the `if not exists` guards make the plain creates below no-op on prod. On a FRESH
-- or empty DB (the test harness, a db-reset) the plain creates are instant (no rows to scan), so this migration
-- is the durable schema record for those environments. ROLLBACK: `drop index` both (data_freshness reverts to a
-- seq scan — no data/behaviour change, only speed).
--
-- Purely ADDITIVE: two indexes, no table/column/function/cron change. The money path (poll-markets consensus →
-- edges → recommendations) is untouched.

create index if not exists market_snapshots_captured_idx
  on public.market_snapshots (captured_at desc);

create index if not exists forecast_snapshots_captured_idx
  on public.forecast_snapshots (captured_at desc);
