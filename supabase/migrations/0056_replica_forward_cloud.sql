-- 0056_replica_forward_cloud.sql — move the daily badatmath-replica FORWARD loop off the local PC into a
-- Supabase Edge Function + pg_cron (the amsterdam-paper-trade twin). REPLICA-CLOUD-PORT.md.
--
-- WHAT THIS DOES. The replica forward run (reconcile resolved open positions + place today's live buys, scored
-- maker-ideal / maker-realistic / taker — BADATMATH-REPLICA.md §15) ran as a local Windows Scheduled Task
-- against `out/badatmath-replica-state.json`. Migration 0053 already mirrors the full forward state to Postgres
-- (replica_positions source='forward', replica_runs, the write RPCs + dash_replica_sim), so the DB can BE the
-- source of truth and the loop can run in the cloud. The binding constraint is that the Edge service-role port
-- is RPC-only (functions/_shared/db.ts) — the script's raw-SQL reads (loadCandidates / loadResolutions /
-- reloadAskSeries) must become ONE inputs RPC, the amsterdam *_inputs pattern. That RPC is replica_forward_inputs.
--
-- THE ONE SCHEMA GAP. reconcile replays the bucket book from the fill-window start (entryCapturedTs) to decide
-- the §12 maker-realistic fill, but replica_positions had no column for it (forwardToRow dropped it). This adds
-- replica_positions.entry_captured_ts and persists it through replica_record_positions + dash_replica_sim.
--
-- STILL a paper-trial: no `packages/trading`, no real orders. The live rail stays DORMANT (CLAUDE.md / FINDINGS.md).

-- === 1. the load-bearing schema gap: entry_captured_ts ======================================================
alter table public.replica_positions add column if not exists entry_captured_ts bigint;  -- fill-window start (unix s)

-- === 2. replica_record_positions — read/write entryCapturedTs (signature UNCHANGED → create-or-replace) ======
-- 0053 body RE-STATED VERBATIM with one added jsonb key (entryCapturedTs) in the INSERT column list, the SELECT,
-- and the ON CONFLICT update. The (text, boolean, jsonb) signature is identical, so this REPLACES the function
-- (no "function is not unique" overload, the 0054 trap) and PRESERVES the 0053 grants (re-asserted in §6).
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
     resolution_ts, entry_ts, entry_day_utc, entry_captured_ts, maker_price, taker_price, stake_usd, fee_rate,
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
    (r->>'entryCapturedTs')::bigint,
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
    entry_captured_ts      = excluded.entry_captured_ts,
    maker_price            = excluded.maker_price,
    taker_price            = excluded.taker_price,
    stake_usd              = excluded.stake_usd,
    fee_rate               = excluded.fee_rate,
    bucket_won             = excluded.bucket_won,
    maker_realistic_filled = excluded.maker_realistic_filled,
    status                 = excluded.status,
    placed_at_utc          = excluded.placed_at_utc,
    closed_at_utc          = excluded.closed_at_utc
  -- Resolution is FINAL: never let an upsert downgrade an already-resolved row back to 'open' (the
  -- close-then-reopen guard — a stale/duplicate placement of a resolved natural key is a no-op, not a regression).
  where public.replica_positions.status <> 'resolved';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- === 3. dash_replica_sim — surface entryCapturedTs (keeps the projection complete; signature UNCHANGED) =======
-- 0053 body RE-STATED with entryCapturedTs added to the positions projection. Harmless/additive: the /replica
-- loader scores via the core engine (which ignores the extra key); this just keeps the DB read lossless.
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
        'entryCapturedTs', entry_captured_ts,
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

-- === 4. replica_forward_inputs — the RPC-only reconstruction of the script's raw-SQL reads =====================
-- ONE jsonb OBJECT with the five keys the Edge handler needs to run a forward tick without any raw SQL:
--   run          — the latest forward run's { whitelist, strat } (the playbook), or null when un-seeded.
--   closedCount  — current resolved-forward count (so the run-row totals stay accurate without loading history).
--   open         — the open forward positions (the engine's ForwardPosition shape) to reconcile.
--   resolutions  — { event_id: winning_bucket_idx } for the open positions' events that our DB has resolved.
--   askSeries    — { condition_id: [{capturedAt,bid,ask,mid}] } book for the open positions (the §12 fill replay).
--   candidates   — events (ladder_ok, in [p_place_from,p_place_to], whitelist-narrowed) → buckets → windowed
--                  snapshots, carrying tz/targetDate/unit/winningBucketIdx so the handler computes resolutionTs
--                  via core/time localDayWindow (tz correctness stays in TS, never SQL — the db1 bug).
-- Returns a single OBJECT (never a top-level array — the 0044 supabasePort trap); the handler reads it directly.
create or replace function public.replica_forward_inputs(
  p_now        bigint,  -- deliberately unused in SQL: the live time-gate (resolutionTs > now, entry window) is
                        -- applied in placeBuysPure (TS) to keep tz-correctness out of SQL (the db1 bug). The
                        -- candidate set here is intentionally over-broad (placement-day window) + re-filtered in TS.
  p_place_from date,
  p_place_to   date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_whitelist text[];
  v jsonb;
begin
  -- the active whitelist (latest forward run) narrows the candidate scope, exactly like the script's loadCandidates.
  select whitelist into v_whitelist
  from public.replica_runs where mode = 'forward' order by ran_at desc limit 1;
  -- Lowercase the whitelist so the `lower(c.slug) = any(v_whitelist)` match is symmetric — parity with the
  -- script's loadCandidates, which lowercases its --cities input (a mixed-case slug must still match).
  if v_whitelist is not null then
    select array_agg(lower(x)) into v_whitelist from unnest(v_whitelist) x;
  end if;

  select jsonb_build_object(
    'run', (
      select jsonb_build_object('whitelist', whitelist, 'strat', strat)
      from public.replica_runs where mode = 'forward' order by ran_at desc limit 1
    ),
    'closedCount', (
      select count(*) from public.replica_positions where source = 'forward' and status = 'resolved'
    ),
    -- ALL forward placement keys (open AND resolved) so the handler dedupes placements against open+closed —
    -- parity with the local script's `[...state.open, ...state.closed]`. Without the closed keys, a position
    -- resolved early via Gamma (DB winning_bucket_idx still null, resolutionTs still future) could be re-placed.
    'placedKeys', (
      select coalesce(jsonb_agg(event_id::text || '|' || bucket_idx::text), '[]'::jsonb)
      from public.replica_positions where source = 'forward'
    ),
    'open', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'conditionId', condition_id, 'eventId', event_id, 'citySlug', city_slug, 'region', region,
        'targetDate', target_date, 'bucketIdx', bucket_idx, 'bucketLabel', bucket_label,
        'resolutionTs', resolution_ts, 'entryTs', entry_ts, 'entryDayUtc', entry_day_utc,
        'entryCapturedTs', entry_captured_ts, 'makerPrice', maker_price, 'takerPrice', taker_price,
        'stakeUsd', stake_usd, 'feeRate', fee_rate, 'bucketWon', bucket_won,
        'makerRealisticFilled', maker_realistic_filled, 'placedAtUtc', placed_at_utc, 'closedAtUtc', closed_at_utc
      )), '[]'::jsonb)
      from public.replica_positions where source = 'forward' and status = 'open'
    ),
    'resolutions', (
      select coalesce(jsonb_object_agg(me.id::text, me.winning_bucket_idx), '{}'::jsonb)
      from public.market_events me
      where me.winning_bucket_idx is not null
        and me.id in (
          select distinct event_id from public.replica_positions where source = 'forward' and status = 'open'
        )
    ),
    'askSeries', (
      select coalesce(jsonb_object_agg(cond, series), '{}'::jsonb)
      from (
        select mb.condition_id as cond,
          jsonb_agg(jsonb_build_object(
            'capturedAt', floor(extract(epoch from ms.captured_at))::bigint,
            'bid', ms.best_bid, 'ask', ms.best_ask, 'mid', ms.mid
          ) order by ms.captured_at asc) as series
        from public.market_snapshots ms
        join public.market_buckets mb on mb.id = ms.bucket_id
        where mb.condition_id in (
          select distinct condition_id from public.replica_positions
          where source = 'forward' and status = 'open' and condition_id <> ''
        )
        group by mb.condition_id
      ) q
    ),
    'candidates', (
      select coalesce(jsonb_agg(ev order by ev->>'targetDate', ev->>'citySlug'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'eventId', me.id, 'citySlug', c.slug, 'region', c.region, 'tz', c.tz, 'unit', me.unit,
          'targetDate', me.target_date, 'winningBucketIdx', me.winning_bucket_idx,
          'buckets', (
            select coalesce(jsonb_agg(jsonb_build_object(
              'bucketIdx', mb.bucket_idx, 'low', mb.low_native, 'high', mb.high_native,
              'tickSize', mb.tick_size, 'feeRate', mb.fee_rate, 'conditionId', mb.condition_id,
              'snapshots', (
                select coalesce(jsonb_agg(jsonb_build_object(
                  'capturedAt', floor(extract(epoch from ms.captured_at))::bigint,
                  'bid', ms.best_bid, 'ask', ms.best_ask, 'mid', ms.mid
                ) order by ms.captured_at asc), '[]'::jsonb)
                from public.market_snapshots ms
                where ms.bucket_id = mb.id
                  and ms.captured_at >= (me.target_date::timestamptz - interval '5 days')
                  and ms.captured_at <  (me.target_date::timestamptz + interval '2 days')
              )
            ) order by mb.bucket_idx), '[]'::jsonb)
            from public.market_buckets mb where mb.event_id = me.id
          )
        ) as ev
        from public.market_events me
        join public.cities c on c.id = me.city_id
        where me.ladder_ok
          and me.target_date >= p_place_from and me.target_date <= p_place_to
          and (v_whitelist is null or array_length(v_whitelist, 1) is null or lower(c.slug) = any(v_whitelist))
      ) cands
    )
  ) into v;

  return v;
end;
$$;

-- === 5. cron: the daily forward tick (05:00 UTC = 07:00 local — the local task's hour) =========================
-- Same Vault-secret pattern as 0009/0026/0039/0049/0055; idempotent (cron.schedule upserts by jobname). PGlite
-- has no real cron.schedule → the guard skips registration in the test harness.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping replica-forward registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/replica-forward',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('replica-forward', '0 5 * * *', edge_command);
end;
$$;

-- === 6. grants (post-0034 contract) ===========================================================================
-- replica_forward_inputs is service-role-internal (the Edge tick): revoke from public/anon/authenticated.
revoke all on function public.replica_forward_inputs(bigint, date, date) from public, anon, authenticated;
grant  execute on function public.replica_forward_inputs(bigint, date, date) to service_role;

-- Re-assert the 0053 grants (create-or-replace preserves them; restate for clarity, like 0044).
revoke all on function public.replica_record_positions(text, boolean, jsonb) from public, anon, authenticated;
grant  execute on function public.replica_record_positions(text, boolean, jsonb) to service_role;

revoke all on function public.dash_replica_sim() from public, anon, authenticated;
grant  execute on function public.dash_replica_sim() to service_role;
grant  execute on function public.dash_replica_sim() to authenticated;
