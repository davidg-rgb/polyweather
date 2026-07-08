-- 0087_depth_capture.sql — the CONTINUOUS executable-depth LAYER on market_snapshots (the Google-panel repoint's
-- data foundation; the repoint itself is 0088).
--
-- WHY. The /convergence GOOGLE panel (0086) read its execAsk/execBid from `opening_captures` — a NARROW,
-- aggressively-pruned, separately-cronned table whose writer had silently been unscheduled for ~38h (the
-- 2026-07-07 reclaim). `market_snapshots` is the DURABLE continuous store (55d, every bucket, 98.9% of listings
-- snapshotted within 1h of first_seen) — but poll-markets only walks BOOK DEPTH for the ≤15 edge-CANDIDATE
-- buckets per cycle (the cheap longshot buckets the Google strategy buys fail that screen), so market_snapshots
-- carries only TOP-OF-BOOK for them. Substituting best_ask for the depth-walked execAsk injects +5.85¢ of entry
-- optimism (measured) — it would silently turn the panel into an optimistic top-of-book strategy.
--
-- THE FIX (isolated, money-path-safe). A dedicated read-only `depth-capture` Edge tick (*/5) walks the TRUE CLOB
-- depth of near-dated live 'highest' buckets and writes the COMPUTED depth into a new `market_snapshots.depth`
-- jsonb — WITHOUT touching poll-markets (the core consensus→edges→recommendations money engine).
--
-- STAGED CUTOVER. This migration is JUST the depth LAYER + the capture job — nothing reads `depth` yet, so applying
-- it (+ deploying the edge fn) is HARMLESS: the /convergence Google panel keeps running on its 0086 RPC (the revived
-- `opening_captures`) while `market_snapshots.depth` accrues. The actual REPOINT — rewriting `google_paper_inputs`
-- to read `depth` — is a SEPARATE migration (0088) applied only AFTER parity is verified on real accrued depth. The
-- convergence + maker-exit siblings still need houseProb (the house_gaussian seed), so they STAY on opening_captures.
--
-- Three objects + one cron:
--   1. market_snapshots.depth jsonb (+ a partial index) — the computed executable-depth slice per walked bucket.
--   2. record_depth_captures(p_rows, p_captured_at) — service-role write (idempotent on the natural key; coexists
--      with poll-markets' top-of-book rows, only ADDS depth).
--   3. depth_capture_targets(p_max_lead, p_limit) — service-role read: the near-dated live 'highest' buckets to walk.
--   4. pg_cron 'depth-capture' every 5 min.

-- === 1. the depth column ==============================================================================
alter table public.market_snapshots add column if not exists depth jsonb;

comment on column public.market_snapshots.depth is
  'Computed executable depth for a book-walked bucket (the depth-capture Edge tick): '
  '{execAsk, execBid, depthUsd, sellbackDepthUsd, bestBid, sellbackUsd}. NULL on poll-markets top-of-book rows. '
  'Powers the repointed google_paper_inputs (0088) — execAsk/execBid without opening_captures. 0087.';

-- only the depth-capture rows are a small subset of market_snapshots — a partial index keeps the panel read
-- (and the fresh-event scan) off the 900k+ top-of-book rows.
create index if not exists market_snapshots_depth_idx
  on public.market_snapshots (captured_at desc) where depth is not null;

-- === 2. record_depth_captures — the depth-capture tick's write (service-role) =========================
-- One row per (bucket, tick): top-of-book (from the same walked book) + the computed depth jsonb. Idempotent on
-- the (bucket_id, captured_at) natural key — coexists with any poll-markets row at a different captured_at, and
-- on the rare same-instant collision just ADDS depth (never nulls poll-markets' top-of-book).
create or replace function public.record_depth_captures(p_rows jsonb, p_captured_at timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_n int;
begin
  insert into market_snapshots (bucket_id, best_bid, best_ask, mid, spread, last_trade, depth, captured_at)
  select r.bucket_id, r.best_bid, r.best_ask, r.mid, r.spread, null, r.depth, p_captured_at
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as r(
    bucket_id uuid, best_bid numeric, best_ask numeric, mid numeric, spread numeric, depth jsonb)
  where r.bucket_id is not null
  on conflict (bucket_id, captured_at) do update set
    depth    = excluded.depth,
    best_bid = coalesce(excluded.best_bid, market_snapshots.best_bid),
    best_ask = coalesce(excluded.best_ask, market_snapshots.best_ask),
    mid      = coalesce(excluded.mid,      market_snapshots.mid),
    spread   = coalesce(excluded.spread,   market_snapshots.spread);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.record_depth_captures(jsonb, timestamptz) from public, anon, authenticated;
grant  execute on function public.record_depth_captures(jsonb, timestamptz) to service_role;

-- === 3. depth_capture_targets — the near-dated live buckets to walk (service-role read) ================
-- The DB-read seam that replaces a Gamma re-poll: the depth-capture tick walks exactly the buckets discover/poll
-- already ingested (so bucket_id is guaranteed) that are near-dated + live. Broad universe (NOT city-scoped — the
-- panel filters by city itself). Freshest events first so a per-tick budget prioritizes the flat-open window.
create or replace function public.depth_capture_targets(
  p_max_lead int default 2,
  p_limit    int default 800
)
returns table (
  bucket_id   uuid,
  token_yes   text,
  event_id    uuid,
  city_slug   text,
  target_date date,
  first_seen  timestamptz
)
language sql
security definer
set search_path = public
as $$
  select mb.id, mb.token_yes, me.id, c.slug, me.target_date, me.first_seen
  from public.market_events me
  join public.market_buckets mb on mb.event_id = me.id
  join public.cities c on c.id = me.city_id
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

revoke all on function public.depth_capture_targets(int, int) from public, anon, authenticated;
grant  execute on function public.depth_capture_targets(int, int) to service_role;

-- === 4. cron: 5-min depth-capture tick ===============================================================
-- Same Vault-secret pattern as 0086/0069. The Edge fn ACKs fast (202) and runs the walk in waitUntil; idempotent;
-- PGlite skips via the guard. The operator deploys the depth-capture edge fn alongside applying this migration
-- (until then the cron POST 404s harmlessly).
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping depth-capture registration';
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
end;
$$;
