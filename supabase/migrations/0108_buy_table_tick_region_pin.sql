-- 0108_buy_table_tick_region_pin.sql — pin the buy-table-tick Edge invocation to eu-west-1 (C44 root cause).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY: every live entry post ever attempted (07-12 shanghai; C44 07-18 00:03–00:53Z — 6 attempts across two
-- markets) failed deterministically at the venue-transport layer with $0 moved. Root cause PROVEN by a
-- keyless probe (supabase/functions/clob-egress-probe, invoked over the cron's own pg_net path): the Edge
-- runtime's default egress is an AWS IP Cloudflare geolocates as **DE (Frankfurt)** — and Polymarket
-- geoblocks its ORDER endpoint per-region: GET /time → 200, POST /order → 403
-- {"error":"Trading restricted in your region…"}. Germany is on Polymarket's restricted list; market-data
-- GETs are exempt — exactly why every read worked while every post "threw shapeless" (the Cloudflare-level
-- rejection, the C44 HIGH-A class). The C44 leading hypothesis (missing POLY_SIGNATURE_TYPE /
-- POLY_FUNDER_ADDRESS Edge secrets) is DISPROVEN: both are set since 2026-07-11 14:55Z (secrets list, names
-- only).
--
-- FIX: Supabase honors an `x-region` request header to pin the execution region. Probe results:
--   eu-west-1 (Dublin, IE)  → POST /order 401 {"error":"missing address header"}  ← the CLOB API itself:
--                              REACHABLE (the 401 is just our keyless probe carrying no auth) ✅
--   eu-central-1 (DE)       → 403 region-blocked ❌ (the failing default)
--   ap-southeast-2 (AU)     → 403 region-blocked ❌
-- So: add 'x-region: eu-west-1' to the tick cron's headers. One header — the interlock, override, bounded
-- attempts (3/market), stake caps and every other guard are UNTOUCHED.
--
-- ALSO codified here: the schedule moves from 0095's '*/10 * * * *' to the C15 compute-shed minute lane
-- '3,13,23,33,43,53 * * * *' that prod has run since 07-12 (quarter-hour minutes are contended on Micro —
-- the C15 finding; */10 would land on :00/:30). This folds the live ops state into the migration lineage so
-- a fresh replay reproduces prod.
--
-- Rollback: re-run this block without the 'x-region' line (and/or 0095 §6 for the original schedule).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

do $$
declare
  edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice '0108: cron.schedule not available — skipping (test environment without a stub?)';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/buy-table-tick',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
    'x-region', 'eu-west-1'
  ),
  body := jsonb_build_object('periodKey', 'buy-table-tick:' || to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI')),
  timeout_milliseconds := 10000
)$cmd$;

  -- cron.schedule upserts by jobname — jobid and history are preserved.
  perform cron.schedule('buy-table-tick', '3,13,23,33,43,53 * * * *', edge_command);
end;
$$;
