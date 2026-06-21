-- 0044_amsterdam_inputs_wrap.sql — restore the PostgREST port invariant for the two Amsterdam input RPCs.
--
-- BUG (live since 0039/0043, found 2026-06-21). amsterdam_sim_grade_inputs() and amsterdam_sim_truth_inputs()
-- each returned a TOP-LEVEL jsonb ARRAY (`coalesce(jsonb_agg(...), '[]')` straight into the return value). The
-- Edge service-role port (functions/_shared/db.ts supabasePort, mirrored by apps/web port.ts) normalizes a
-- PostgREST result by SHAPE: an array is assumed to be a RETURNS TABLE row set and passed through unchanged;
-- only a bare object/scalar is wrapped as `[{ [fn]: value }]`. supabase-js `.rpc()` returns the BARE jsonb for
-- a scalar function, so these two returned a bare array → the port passed it through → the handler's
-- `rows[0]?.<fn>` was undefined → `pending = []`. Result: the daily amsterdam-paper-trade tick SILENTLY graded
-- 0 bets and filled 0 floor-truth rows EVERY day (19 bets stuck `pending`, 2026-06-16 → 06-20; truth frozen),
-- while reporting status `ok`.
--
-- Why it shipped green: the PGlite test twin (supabase/tests/pglite-port.ts) runs `select * from fn()`, which
-- wraps EITHER shape (array or object) into one row → the integration test saw the correct `[{fn: value}]`
-- shape and passed. Prod (bare value) and the twin (always-wrapped) diverge precisely on top-level arrays.
-- migrations.test.ts forbids set-returning (SETOF) RPCs, but not the corollary "no top-level-array jsonb
-- return" — these two slipped through it.
--
-- FIX: wrap both returns in an object `{ "rows": [...] }`, so they comply with the documented invariant ("bare
-- jsonb fns return objects/scalars, never top-level arrays"). Pure ENVELOPE change — the inner aggregate is
-- byte-identical to 0039 / 0043. The four consumers read `.rows` in lockstep:
--   • supabase/functions/amsterdam-paper-trade/handler.ts   (the daily Edge tick — the one that was broken)
--   • scripts/amsterdam-sim.ts                              (seed/grade backfill)
--   • scripts/amsterdam-truth-backfill.ts                   (KNMI truth backfill)
--   • (the PGlite twin needs no change — `select * from fn()` wraps the object the same as before)
-- A jsonb_typeof='object' guard (amsterdam-sim.test.ts) + port-contract tests (db.test.ts) lock this so the
-- shape can never silently regress. service_role-only grants reasserted (create-or-replace preserves them).

-- --- grade inputs: now returns { rows: GradeInputRow[] } ---------------------------------------------
create or replace function public.amsterdam_sim_grade_inputs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'betId',        b.id,
      'bucketIdx',    b.bucket_idx,
      'ask',          b.ask,
      'shares',       b.shares,
      'stakeUsd',     b.stake_usd,
      'feeRate',      b.fee_rate,
      'winnerIdx',    w.winner_idx,
      'actualNativeC', o.tmax_wu_native
    ) order by b.target_date, b.arm_hour
  ), '[]'::jsonb) into v
  from public.amsterdam_paper_bets b
  join public.observations o
    on o.icao = 'EHAM' and o.date_local = b.target_date and o.finalized_at is not null
  join lateral (
    select mb.bucket_idx as winner_idx
    from public.market_buckets mb
    where mb.event_id = b.event_id
      and (mb.low_native  is null or o.tmax_wu_native >= mb.low_native)
      and (mb.high_native is null or o.tmax_wu_native <= mb.high_native)
    limit 1
  ) w on true
  where b.status = 'pending';
  return jsonb_build_object('rows', v);
end;
$$;

-- --- truth inputs: now returns { rows: TruthInputRow[] } ---------------------------------------------
create or replace function public.amsterdam_sim_truth_inputs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'betId',            b.id,
      'armHour',          b.arm_hour,
      'predictedNativeC', b.predicted_native_c,
      'runMaxC',          b.running_max_c,
      'forecastC',        b.forecast_c,
      'actualDecimalC',   t.tx_tenths_c
    ) order by b.target_date, b.arm_hour
  ), '[]'::jsonb) into v
  from public.amsterdam_paper_bets b
  join public.amsterdam_truth t on t.date_local = b.target_date
  where b.actual_decimal_c is distinct from t.tx_tenths_c;  -- needs (re)compute: null or KNMI revised
  return jsonb_build_object('rows', v);
end;
$$;

-- --- grants (post-0034 contract) — service_role only; re-assert explicitly. --------------------------
revoke all on function public.amsterdam_sim_grade_inputs() from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_grade_inputs() to service_role;
revoke all on function public.amsterdam_sim_truth_inputs() from public, anon, authenticated;
grant  execute on function public.amsterdam_sim_truth_inputs() to service_role;
