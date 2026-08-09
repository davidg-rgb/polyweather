-- 0123_buy_table_cheap_early_lane.sql — re-point the live buy-table lane at the CHEAP-EARLY cell and
-- resurrect the paper benchmark that scores it (operator-directed continuous operation, 2026-08-09).
--
-- WHY. The 2026-08-02 free-tier migration unscheduled the purchase structure: BOTH `buy-table-tick` (the
-- 00–10Z fast lane from 0114) and `cheap-early-panel` (the hourly :47 paper loop from 0117) are absent from
-- cron.job as of this migration, and `buy_table.tick_enabled` was set false. The lane has therefore been
-- dark since 2026-07-30 and the paper panel's last capture is 2026-08-02T12:47Z. This migration re-registers
-- both, on the profile the 2026-08-09 badatmath re-review isolated (WALLET-RECON-HANDOFF.md §16): entries in
-- the [0.20,0.33] ask band at 24–36h lead — the band that carries the sharp's engine, and the one cell our
-- own measurements have not shown negative.
--
-- WHAT CHANGES (cron only — no table, no RPC, no policy):
--   1. `buy-table-tick` → ALL-DAY every 5 minutes. The 24–36h entry window is a 12-hour opportunity per
--      market, so the lane must be awake outside the old 00–10Z slot or it simply never sees the dip.
--   2. `buy-table-tick-fast` → removed if present. The window split it existed for is gone; one uniform
--      lane replaces both (a leftover fast lane would double-fire 00–09Z).
--   3. `cheap-early-panel` → 4×/day (was hourly :47). The paper loop is the benchmark the live lane is
--      scored against; 4×/day is enough to accrue gate n at the widened breadth without paying the hourly
--      compute the free-tier cut was made to avoid.
--
-- MINUTE-STAGGER LAW (C15/`cron-minute-lane-stagger`): never :00/:15/:30/:45 — same-second quarter pileups
-- caused statement timeouts on the shared instance. The 5-minute cadence is therefore offset by one minute
-- (1,6,11,…,56), which also keeps it off every existing hourly lane: health-monitor :07, discover :10,
-- poll-markets :12/:42, fetch-actuals :20, google-paper-panel :24, metar-nowcast :04/:34, opening-capture
-- :03/:23/:43. cheap-early-panel takes :38, unused by any job.
--
-- ⚠ CRON BUDGET (read before applying). The free-tier trim took the project 30 → 17 jobs and ~7,750 → ~1,750
-- runs/week; the binding constraint was COMPUTE on the Nano instance, not a job-count ceiling (pg_cron
-- enforces no such cap). This migration takes 17 → 19 jobs and, far more significantly, ~1,799 → ~3,843
-- runs/week — it MORE THAN DOUBLES the scheduled load the free-tier migration was built to fit:
--     buy-table-tick    288 runs/day (12/h × 24) = 2,016/week   ← the whole of the increase
--     cheap-early-panel   4 runs/day             =    28/week
-- If instance pressure returns, the cadence is the lever: `1,11,21,31,41,51 * * * *` (10-min, halves it) or
-- `1,16,31,46 * * * *`-style quarter-hours are still ample for a 12-hour entry window. Cadence does NOT
-- raise exposure — the one-entry-per-market-ever gate plus `buy_table.max_buys_per_day` (0123 handler) bound
-- that independently.
--
-- CONFIG IS NOT HERE. The operational state that arms this profile (leadWindowH, priceCap, ask_floor,
-- max_buys_per_day, city_allowlist, tick_enabled, the trade_gate_override row) is applied SEPARATELY by the
-- operator — it is state, not schema, and must stay revertible without a migration.
--
-- Rollback: select cron.unschedule('buy-table-tick'); select cron.unschedule('cheap-early-panel');
--           -- then restore the 0114 split if desired:
--           perform cron.schedule('buy-table-tick', '3,13,23,33,43,53 10-23 * * *', <0114 §3 command>);
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  tick_command text;
  panel_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available (PGlite) — skipping 0123 cron registration';
    return;
  end if;

  -- byte-identical to the 0114/0108 command, INCLUDING the eu-west-1 REGION PIN (C44: default egress
  -- geolocates DE and Polymarket 403-blocks its ORDER endpoint there). Only the schedule changes.
  tick_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/buy-table-tick',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
    'x-region', 'eu-west-1'
  ),
  body := jsonb_build_object('periodKey', 'buy-table-tick:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI')),
  timeout_milliseconds := 10000
)$cmd$;

  -- byte-identical to the 0117 §6 command (no region pin — the panel is a keyless read).
  panel_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/cheap-early-panel',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  -- the 0114 window split is retired: drop the fast lane so it cannot double-fire 00–09Z alongside the
  -- all-day schedule below. Guarded — cron.unschedule() raises if the job is absent, and it IS absent on
  -- prod today (unscheduled 2026-08-02), so this is a no-op there and a real removal on any replica.
  -- NB: the PGlite test harness stubs cron.schedule + cron.job but NOT cron.unschedule, so the guard above
  -- does not shield this call — probe the function itself as well (the to_regprocedure idiom, per-call).
  if to_regprocedure('cron.unschedule(text)') is not null
     and exists (select 1 from cron.job where jobname = 'buy-table-tick-fast') then
    perform cron.unschedule('buy-table-tick-fast');
  end if;

  -- cron.schedule upserts by name — idempotent re-apply, and it re-creates both jobs the free-tier cut
  -- removed. Every 5 minutes, all day, off the forbidden quarters and off every existing lane's minute.
  perform cron.schedule('buy-table-tick', '1,6,11,16,21,26,31,36,41,46,51,56 * * * *', tick_command);
  perform cron.schedule('cheap-early-panel', '38 1,7,13,19 * * *', panel_command);
end;
$$;
