-- 0089_depth_capture_v2.sql — the DEPTH-CAPTURE V2 REDESIGN (supersedes the applied 0087 design).
--
-- WHY v2. The v1 executable-depth layer (0087) shipped + was live-verified — it FAILED (the single 800-row
-- record_depth_captures write times out under load → 0 rows, reported ok) and a 5-agent adversarial review found
-- 12 confirmed defects. Root causes, two structural: (a) it wrote into SHARED market_snapshots → ~230k rows/day of
-- bloat + shadowed the dashboard's latest-snapshot book_top3 reads; (b) it re-anchored hoursSinceListing to
-- first_seen (ingestion time) instead of the TRUE Gamma listing time → the flat-open gate became near-tautological.
-- Full spec: docs/ops/DEPTH-CAPTURE-V2-HANDOFF.md; findings: docs/ops/depth-capture-review-findings.json.
--
-- WHAT v2 DOES (money-path-SAFE — poll-markets untouched; analytics-only; rail DORMANT):
--   0. Drop the v1 objects (market_snapshots.depth + its index + record_depth_captures + depth_capture_targets).
--   1. Dedicated `market_depth` table (§4.1 — kills the bloat + the shadowing): computed exec prices as REAL
--      columns (not a jsonb blob) so the panel RPC reads them directly and PGlite round-trips assert them.
--   2. record_market_depth — delta-fed, chunk-friendly, statement_timeout'd write (§4.6 — kills the v1 timeout).
--   3. market_depth_targets — the near-dated live buckets to walk, each carrying its LAST depth row for the
--      handler's delta/heartbeat gate + a pre-cap candidate count so a p_limit truncation is OBSERVABLE (§4.2).
--   4. depth_capture_deadman_check — a depth-staleness alarm (like capture_deadman_check) — kills the silent stall.
--   5. market_events.gamma_created_at + upsert_event rewritten to thread the TRUE Gamma createdAt (§4.3 — kills the
--      listing-anchor break). Discovery/liveness only — NOT the money-critical edge path.
--   6. Re-arm the depth-capture */5 cron (0087 unscheduled it) + the depth-capture-deadman */10 SQL cron + a daily
--      market-depth retention prune (>35d — the panel reads only 21d; keeps the delta-fed table bounded).
--
-- STAGED CUTOVER stays safe: the panel keeps reading opening_captures until real depth accrues — the guard lives in
-- 0088's rewritten google_paper_inputs (a technical count-guard, not a prose caveat — kills finding J), so applying
-- 0089 + 0088 together is HARMLESS (the panel auto-switches source only once market_depth crosses the threshold).

-- === 0. drop the v1 (0087) depth design ================================================================
-- Removes the applied market_snapshots.depth column (+ its partial index) and the ~61 synthetic manual-test rows'
-- depth payloads, plus the v1 write/read RPCs. Idempotent; the market_snapshots rows themselves stay as harmless
-- top-of-book (poll-markets supersedes them on its next tick).
drop index    if exists public.market_snapshots_depth_idx;
alter table   public.market_snapshots drop column if exists depth;
drop function if exists public.record_depth_captures(jsonb, timestamptz);
drop function if exists public.depth_capture_targets(int, int);

-- === 1. the dedicated market_depth table ==============================================================
-- One row per (bucket, tick) that the depth-capture walk decided to WRITE (delta-fed — not every bucket every
-- tick). Exec prices are REAL numeric columns so google_paper_inputs (0088) reads them directly + the PGlite
-- round-trip test asserts them. RLS on; service-role write; operator read only via the panel RPC.
create table if not exists public.market_depth (
  id                 bigint generated always as identity primary key,
  bucket_id          uuid        not null references public.market_buckets(id),
  captured_at        timestamptz not null,
  best_bid           numeric,
  best_ask           numeric,
  mid                numeric,
  spread             numeric,
  exec_ask           numeric,   -- executable avg ask for the panel's replay size (the < askMax entry gate)
  exec_bid           numeric,   -- executable avg bid for the held size (the absolute TP/SL exit mark)
  depth_usd          numeric,   -- buyable $ within +10% of best ask (carried for future modelling; panel ignores)
  sellback_depth_usd numeric,   -- sellable $ within −10% of best bid (the symmetric exit-side depth)
  sellback_usd       numeric,   -- $ recoverable selling top-of-book into the bid
  unique (bucket_id, captured_at)
);

comment on table public.market_depth is
  'Computed executable CLOB depth per walked bucket (the depth-capture Edge tick, every 5 min, delta-fed): '
  'exec_ask/exec_bid + top-of-book + round-trip depth. Powers the repointed google_paper_inputs (0088) — the '
  'executable-price source WITHOUT opening_captures. Analytics-only; money-path (poll-markets) untouched. 0089.';

-- (bucket, captured_at desc) serves market_depth_targets'' last-row lateral + google_paper_inputs'' per-bucket
-- scan; a captured_at index serves the panel'' window scan + the deadman'' max(captured_at).
create index if not exists market_depth_bucket_captured_idx on public.market_depth (bucket_id, captured_at desc);
create index if not exists market_depth_captured_idx        on public.market_depth (captured_at);

-- RLS on (ADR-13): written only by record_market_depth (security definer); no read policy => anon/authenticated
-- get nothing by direct query. Read via google_paper_inputs (service-role) only.
alter table public.market_depth enable row level security;

-- === 2. record_market_depth — the depth-capture tick's write (service-role) ============================
-- The handler already delta-dedupes (only meaningfully-moved / heartbeat rows arrive) and chunks the call
-- (≤200 rows/statement), so this is a straight idempotent insert. `set statement_timeout` is the Postgres-level
-- backstop that v1's unbounded 800-row upsert lacked. Idempotent on (bucket_id, captured_at) — a re-fired tick
-- (same captured_at) just refreshes the row. jsonb keys match the handler's DepthRow name-for-name (finding I-2).
create or replace function public.record_market_depth(p_rows jsonb, p_captured_at timestamptz)
returns int
language plpgsql
security definer
set search_path = public
set statement_timeout = '20s'
as $$
declare v_n int;
begin
  insert into market_depth (
    bucket_id, captured_at, best_bid, best_ask, mid, spread,
    exec_ask, exec_bid, depth_usd, sellback_depth_usd, sellback_usd)
  select r.bucket_id, p_captured_at, r.best_bid, r.best_ask, r.mid, r.spread,
         r.exec_ask, r.exec_bid, r.depth_usd, r.sellback_depth_usd, r.sellback_usd
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    bucket_id uuid, best_bid numeric, best_ask numeric, mid numeric, spread numeric,
    exec_ask numeric, exec_bid numeric, depth_usd numeric, sellback_depth_usd numeric, sellback_usd numeric)
  where r.bucket_id is not null
  on conflict (bucket_id, captured_at) do update set
    best_bid           = excluded.best_bid,
    best_ask           = excluded.best_ask,
    mid                = excluded.mid,
    spread             = excluded.spread,
    exec_ask           = excluded.exec_ask,
    exec_bid           = excluded.exec_bid,
    depth_usd          = excluded.depth_usd,
    sellback_depth_usd = excluded.sellback_depth_usd,
    sellback_usd       = excluded.sellback_usd;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.record_market_depth(jsonb, timestamptz) from public, anon, authenticated;
grant  execute on function public.record_market_depth(jsonb, timestamptz) to service_role;

-- === 3. market_depth_targets — the near-dated live buckets to walk (service-role read) =================
-- The DB-read seam that replaces a Gamma re-poll: walk exactly the buckets discover/poll already ingested (so
-- bucket_id is guaranteed) that are near-dated + live. Each row carries the bucket's LAST market_depth row (via a
-- cheap index-only lateral) so the handler's delta/heartbeat gate needs no extra round-trip, and a
-- `total_candidates` window-count (computed over the full WHERE set BEFORE the limit) so a p_limit truncation is
-- observable — the handler logs a cap-hit when total_candidates > returned rows (finding C). Freshest events first.
create or replace function public.market_depth_targets(
  p_max_lead int default 2,
  p_limit    int default 800
)
returns table (
  bucket_id        uuid,
  token_yes        text,
  event_id         uuid,
  city_slug        text,
  target_date      date,
  first_seen       timestamptz,
  last_exec_ask    numeric,
  last_exec_bid    numeric,
  last_captured_at timestamptz,
  total_candidates bigint
)
language sql
security definer
set search_path = public
as $$
  select mb.id, mb.token_yes, me.id, c.slug, me.target_date, me.first_seen,
         last.exec_ask, last.exec_bid, last.captured_at,
         count(*) over () as total_candidates
  from public.market_events me
  join public.market_buckets mb on mb.event_id = me.id
  join public.cities c on c.id = me.city_id
  left join lateral (
    select md.exec_ask, md.exec_bid, md.captured_at
    from public.market_depth md
    where md.bucket_id = mb.id
    order by md.captured_at desc
    limit 1
  ) last on true
  where me.kind = 'highest'
    and me.accepting_orders = true
    and coalesce(me.closed, false) = false
    and coalesce(me.ladder_ok, true) = true
    and mb.token_yes is not null
    -- near-dated: from yesterday (still-resolving) through p_max_lead days ahead (station-local slack via +1d).
    and me.target_date between (now() at time zone 'utc')::date - 1
                           and (now() at time zone 'utc')::date + (greatest(p_max_lead, 0) + 1)
  order by me.first_seen desc nulls last, me.id, mb.bucket_idx
  limit greatest(p_limit, 1);
$$;

revoke all on function public.market_depth_targets(int, int) from public, anon, authenticated;
grant  execute on function public.market_depth_targets(int, int) to service_role;

-- === 4. depth_capture_deadman_check — a depth-staleness alarm (§4.6 — kills the silent stall) ==========
-- Like capture_deadman_check (0066): if market_depth has started accruing but its newest row is older than
-- bot.depthStaleMin, page CRITICAL. THRESHOLD (default 70 min) must SIT ABOVE the handler's write HEARTBEAT
-- (handler.ts HEARTBEAT_MS = 30 min): the layer is DELTA-FED, so a healthy fn writes an UNCHANGED bucket only every
-- 30 min — a threshold below that (v1 review R1-F1: the initial 20 min) false-pages CRITICAL on a healthy quiet
-- window (a synchronized longshot cohort that hasn't moved ≥ DEPTH_DELTA). 70 min = >2 heartbeat cycles + tick/skip
-- slack, so only a genuine stall (fn dead → no writes at all) fires. Keep this comfortably above HEARTBEAT_MS if you
-- retune either. Arms only once rows exist (v_latest not null) so a fresh deploy (fn not yet live) does not
-- false-page. Uses max(captured_at) (index-backed) — no unbounded count(*) scan (R1-F3). jsonb OBJECT return
-- (port-invariant tripwire safe).
create or replace function public.depth_capture_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest    timestamptz;
  v_stale_min numeric := coalesce((select value::numeric from config where key = 'bot.depthStaleMin'), 70);
  v_age_min   numeric;
  v_bucket    int     := floor(extract(epoch from now()) / 1800)::int;  -- 30-min dedupe
  v_alarmed   boolean := false;
begin
  select max(captured_at) into v_latest from public.market_depth;  -- index-backed; no full-table count(*)
  if v_latest is not null then
    v_age_min := extract(epoch from (now() - v_latest)) / 60;
    if v_age_min > v_stale_min then
      v_alarmed := true;
      perform public.claim_alert('DEPTH_CAPTURE_DEADMAN', 'CRITICAL', 'depth-capture-deadman:stale:' || v_bucket,
        'depth-capture is STALE',
        'newest market_depth row is ' || round(v_age_min, 1) || ' min old (> ' || v_stale_min ||
        ' min threshold). The executable-depth layer feeding the repointed Google panel has stopped accruing — '
        || 'check the depth-capture cron + edge fn (a write statement-timeout, CLOB rate-limiting, or a killed '
        || 'isolate). The panel silently degrades to null execAsk/execBid without it.');
    end if;
  end if;
  return jsonb_build_object(
    'alarmed', v_alarmed, 'latest', v_latest, 'ageMin', v_age_min, 'staleMin', v_stale_min);
end;
$$;

revoke all on function public.depth_capture_deadman_check() from public, anon, authenticated;
grant  execute on function public.depth_capture_deadman_check() to service_role;

-- === 5. gamma_created_at + upsert_event rewrite (§4.3 — kills the listing-anchor break) ================
-- market_events had NO Gamma createdAt column (only first_seen = ingestion time). Add it, and thread the parsed
-- Gamma createdAt through upsert_event so google_paper_inputs (0088) can anchor hoursSinceListing to the TRUE
-- listing time. Backfill is impossible for pre-0089 rows (accept forward-only — the panel is a forward seed).
alter table public.market_events add column if not exists gamma_created_at timestamptz;

comment on column public.market_events.gamma_created_at is
  'The event''s TRUE Gamma listing time (raw createdAt), threaded by discover-markets → upsert_event. The listing '
  'anchor for the repointed google_paper_inputs (hoursSinceListing = captured_at − gamma_created_at). NULL for rows '
  'discovered before 0089 (forward-only). NOT first_seen (ingestion time). 0089.';

-- adding a 14th parameter would create an OVERLOAD (leaving the 0012 13-arg version → an ambiguous-function call),
-- so drop the old signature first, then recreate with p_gamma_created_at (default null — the parse-failure caller
-- in discover-markets omits it). Body is byte-identical to 0012 EXCEPT the new column (coalesce-keeps the first
-- non-null: a Gamma createdAt is immutable per event, and old rows populate on their first post-0089 re-discovery).
-- NOT the money path — market_events discovery/liveness only.
drop function if exists public.upsert_event(
  text, text, text, uuid, text, date, text, text, boolean, numeric, numeric, boolean, text[]);

create or replace function public.upsert_event(
  p_poly_event_id text, p_slug text, p_kind text, p_city_id uuid, p_icao text,
  p_target_date date, p_unit text, p_neg_risk_market_id text, p_accepting boolean,
  p_volume24h numeric, p_liquidity numeric, p_ladder_ok boolean, p_ladder_problems text[],
  p_gamma_created_at timestamptz default null
)
returns table (event_id uuid, is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_new boolean;
begin
  begin
    insert into market_events (poly_event_id, slug, kind, city_id, icao_at_creation, target_date, unit,
                               neg_risk_market_id, accepting_orders, volume24h, liquidity,
                               ladder_ok, ladder_problems, gamma_created_at, first_seen, last_seen)
    values (p_poly_event_id, p_slug, p_kind, p_city_id, p_icao, p_target_date, p_unit,
            p_neg_risk_market_id, p_accepting, p_volume24h, p_liquidity,
            p_ladder_ok, p_ladder_problems, p_gamma_created_at, now(), now())
    on conflict (poly_event_id) do update
      set accepting_orders = excluded.accepting_orders,
          volume24h = excluded.volume24h,
          liquidity = excluded.liquidity,
          ladder_ok = excluded.ladder_ok,
          ladder_problems = excluded.ladder_problems,
          gamma_created_at = coalesce(market_events.gamma_created_at, excluded.gamma_created_at),
          last_seen = now(),
          closed = false
    returning market_events.id, (xmax = 0) into v_id, v_new;
  exception when unique_violation then
    -- recreated event: same (city, date, kind), new poly ids
    update market_events me
       set poly_event_id = p_poly_event_id, slug = p_slug,
           accepting_orders = p_accepting, volume24h = p_volume24h,
           liquidity = p_liquidity, ladder_ok = p_ladder_ok,
           ladder_problems = p_ladder_problems,
           gamma_created_at = coalesce(me.gamma_created_at, p_gamma_created_at),
           last_seen = now(), closed = false
     where me.city_id = p_city_id and me.target_date = p_target_date and me.kind = p_kind
    returning me.id into v_id;
    v_new := false;
  end;
  return query select v_id, v_new;
end;
$$;

revoke all on function public.upsert_event(
  text, text, text, uuid, text, date, text, text, boolean, numeric, numeric, boolean, text[], timestamptz)
  from public, anon, authenticated;
grant  execute on function public.upsert_event(
  text, text, text, uuid, text, date, text, text, boolean, numeric, numeric, boolean, text[], timestamptz)
  to service_role;

-- === 6. crons: re-arm depth-capture (*/5) + the depth-staleness deadman (*/10) + a daily retention prune ===
-- Same Vault-secret pattern as 0066/0086. 0087 registered `depth-capture` then unscheduled it; re-schedule it
-- here (cron.schedule upserts by name — no duplicate). The deadman + prune are pure-SQL crons (like the 0066
-- deadmen/prunes). The operator deploys the depth-capture edge fn alongside applying this migration (until then the
-- cron POST 404s harmlessly and market_depth stays empty, so the deadman correctly stays silent).
--
-- RETENTION (R1-F3): market_depth is delta-fed but still grows unbounded (~15k–90k rows/day at the 30-min
-- heartbeat × the near-dated bucket universe) and google_paper_inputs only ever reads the trailing 21 days, while
-- the sibling capture table opening_captures (0066) has a 90-day prune and v1's depth lived on the DOWNSAMPLED
-- market_snapshots. Prune > 35 days (comfortable margin over the 21-day window) so the table can't balloon on the
-- documented-saturated Micro instance.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping depth-capture v2 registration';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/depth-capture',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('depth-capture', '*/5 * * * *', edge_command);
  perform cron.schedule('depth-capture-deadman', '*/10 * * * *', 'select public.depth_capture_deadman_check();');
  perform cron.schedule('market-depth-prune', '40 3 * * *',
    $prune$delete from public.market_depth where captured_at < now() - interval '35 days';$prune$);
end;
$$;
