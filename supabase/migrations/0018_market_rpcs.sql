-- 0018_market_rpcs.sql — poll-markets surface (ARCHITECTURE.md §6.17, §7.17a C8,
-- ADR-08/09, F-038, ADR-17).

-- (C8) Lease claim: ONE CAS UPDATE on the seeded job_locks row. No row updated
-- ⇒ an unexpired holder is running ⇒ the caller exits 'overlapped'. The lease
-- auto-expires at the wall limit, so a dead isolate can never wedge the job.
create or replace function public.claim_poll_lease(p_holder text, p_wall_sec int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  update job_locks
     set holder = p_holder, expires_at = now() + make_interval(secs => p_wall_sec)
   where job = 'poll-markets' and expires_at < now()
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

-- Release = expire now, guarded by holder: a zombie's late release can never
-- unlock an active holder (its holder id no longer matches).
create or replace function public.release_poll_lease(p_holder text)
returns void
language sql
security definer
set search_path = public
as $$
  update job_locks set expires_at = now()
   where job = 'poll-markets' and holder = p_holder and expires_at > now();
$$;

-- Polling context for KNOWN events in one round trip, keyed by poly_event_id:
-- city/tz/halt inputs, per-bucket last snapshot (delta-dedupe + heartbeat),
-- open recommendation, and the latest champion-source distribution.
create or replace function public.poll_known_events(p_poly_ids text[], p_champion text)
returns table (poly_event_id text, ctx jsonb)
language sql
security definer
set search_path = public
as $$
  select me.poly_event_id::text, jsonb_build_object(
    'eventId', me.id, 'slug', me.slug, 'targetDate', me.target_date, 'unit', me.unit,
    'ladderOk', me.ladder_ok, 'closed', me.closed, 'graded', me.winning_bucket_idx is not null,
    'citySlug', c.slug, 'tz', c.tz, 'region', c.region, 'bettingEnabled', c.betting_enabled,
    'verified', coalesce(cs.verified, false),
    'buckets', (
      select jsonb_agg(jsonb_build_object(
        'bucketId', b.id, 'idx', b.bucket_idx, 'polyMarketId', b.poly_market_id,
        'label', b.label, 'low', b.low_native, 'high', b.high_native,
        'feeRate', b.fee_rate, 'minOrderSize', b.min_order_size, 'tokenYes', b.token_yes,
        'lastMid', ls.mid, 'lastCapturedAt', ls.captured_at,
        'openRec', (
          select jsonb_build_object('betId', bt.id, 'execAsk', bt.exec_ask, 'recStakeUsd', bt.rec_stake_usd)
          from bets bt where bt.bucket_id = b.id and bt.side = 'YES' and bt.status = 'recommended'
        )
      ) order by b.bucket_idx)
      from market_buckets b
      left join lateral (
        select ms.mid, ms.captured_at from market_snapshots ms
        where ms.bucket_id = b.id order by ms.captured_at desc limit 1
      ) ls on true
      where b.event_id = me.id
    ),
    'champion', (
      select jsonb_build_object('id', bp.id, 'probs', bp.probs, 'mu', bp.mu_native,
                                'sigma', bp.sigma_native, 'statsVersion', bp.stats_version,
                                'madeAt', bp.made_at, 'nowcast', bp.nowcast)
      from bucket_probabilities bp
      where bp.event_id = me.id and bp.source = p_champion
      order by bp.made_at desc limit 1
    )
  )
  from market_events me
  join cities c on c.id = me.city_id
  left join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where me.poly_event_id = any(p_poly_ids);
$$;

-- Batch snapshot insert. The delta/heartbeat WRITE DECISION is the caller's
-- (it holds last_mid/last_captured_at); unique (bucket_id, captured_at) is the
-- §7.11 backstop against double inserts. captured_at is the tick instant the
-- caller observed the prices at — one instant per tick.
create or replace function public.upsert_market_snapshots(p_rows jsonb, p_captured_at timestamptz)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into market_snapshots (bucket_id, best_bid, best_ask, mid, spread, last_trade, captured_at)
  select r.bucket_id, r.best_bid, r.best_ask, r.mid, r.spread, r.last_trade, p_captured_at
  from jsonb_to_recordset(p_rows) as r(
    bucket_id uuid, best_bid numeric, best_ask numeric, mid numeric, spread numeric, last_trade numeric)
  on conflict (bucket_id, captured_at) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Liveness refresh on every poll tick (step 1).
create or replace function public.refresh_event_liveness(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update market_events me
     set accepting_orders = r.accepting, volume24h = r.volume24h,
         liquidity = r.liquidity, last_seen = now()
  from jsonb_to_recordset(p_rows) as r(
    poly_event_id text, accepting boolean, volume24h numeric, liquidity numeric)
  where me.poly_event_id = r.poly_event_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Step 3: book top-3 levels attach to the bucket's LATEST snapshot row.
create or replace function public.attach_book_to_snapshot(p_bucket_id uuid, p_book jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  update market_snapshots set book_top3 = p_book
   where id = (select id from market_snapshots
               where bucket_id = p_bucket_id order by captured_at desc limit 1);
$$;

-- Open exposure (recommended + filled) feeding exposureSummary/applyRiskCaps.
create or replace function public.open_bets_exposure()
returns table (event_id uuid, city_slug text, region text, target_date date, stake_usd numeric)
language sql
security definer
set search_path = public
as $$
  select bt.event_id, c.slug::text, c.region::text, me.target_date,
         case when bt.status = 'filled' then coalesce(bt.executed_size_usd, bt.rec_stake_usd)
              else bt.rec_stake_usd end
  from bets bt
  join market_events me on me.id = bt.event_id
  join cities c on c.id = me.city_id
  where bt.status in ('recommended', 'filled');
$$;

create or replace function public.current_bankroll(p_mode text)
returns numeric
language sql
security definer
set search_path = public
as $$
  select coalesce(sum(amount_usd), 0) from bankroll_ledger where mode = p_mode;
$$;

-- ADR-09: recommendation upsert on the partial-unique open key. was_insert
-- distinguishes new (Slack ACTION) from refresh (re-notify only on ≥20% stake move).
create or replace function public.upsert_recommendation(
  p_event_id uuid, p_bucket_id uuid, p_mode text,
  p_our_q numeric, p_best_ask numeric, p_exec_ask numeric, p_edge numeric, p_min_edge numeric,
  p_fee_per_share numeric, p_kelly_raw numeric, p_kelly_frac numeric, p_capped_frac numeric,
  p_stake numeric, p_shares numeric, p_audit jsonb, p_dist_row_id uuid
)
returns table (bet_id uuid, was_insert boolean)
language sql
security definer
set search_path = public
as $$
  insert into bets (event_id, bucket_id, side, status, mode, our_q, best_ask, exec_ask,
                    edge, min_edge, fee_per_share, kelly_raw, kelly_frac, capped_frac,
                    rec_stake_usd, rec_shares, audit, dist_row_id, recommended_at)
  values (p_event_id, p_bucket_id, 'YES', 'recommended', p_mode, p_our_q, p_best_ask, p_exec_ask,
          p_edge, p_min_edge, p_fee_per_share, p_kelly_raw, p_kelly_frac, p_capped_frac,
          p_stake, p_shares, p_audit, p_dist_row_id, now())
  on conflict (bucket_id, side) where status = 'recommended'
  do update set our_q = excluded.our_q, best_ask = excluded.best_ask, exec_ask = excluded.exec_ask,
                edge = excluded.edge, min_edge = excluded.min_edge,
                fee_per_share = excluded.fee_per_share, kelly_raw = excluded.kelly_raw,
                kelly_frac = excluded.kelly_frac, capped_frac = excluded.capped_frac,
                rec_stake_usd = excluded.rec_stake_usd, rec_shares = excluded.rec_shares,
                audit = excluded.audit, dist_row_id = excluded.dist_row_id, recommended_at = now()
  returning id, (xmax = 0);
$$;

-- ADR-09 CAS: a concurrent approval wins cleanly — this returns false.
create or replace function public.expire_recommendation(p_bet_id uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done boolean;
begin
  update bets set status = 'expired', expires_reason = p_reason
   where id = p_bet_id and status = 'recommended'
  returning true into v_done;
  return coalesce(v_done, false);
end;
$$;

-- F-038: hourly persistence of ALL edge rows (passing AND failing, with reasons).
create or replace function public.persist_edge_evaluations(p_rows jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  insert into edge_evaluations (event_id, bucket_idx, captured_hour, q, exec_ask, edge, min_edge, pass, reasons)
  select r.event_id, r.bucket_idx, r.captured_hour, r.q, r.exec_ask, r.edge, r.min_edge, r.pass, r.reasons
  from jsonb_to_recordset(p_rows) as r(
    event_id uuid, bucket_idx smallint, captured_hour timestamptz,
    q numeric, exec_ask numeric, edge numeric, min_edge numeric, pass boolean, reasons text[])
  on conflict (event_id, bucket_idx, captured_hour) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ADR-17 position watch: filled open bets vs the CURRENT champion q for their bucket.
create or replace function public.position_watch(p_champion text)
returns table (bet_id uuid, slug text, label text, entry_q numeric, current_q numeric)
language sql
security definer
set search_path = public
as $$
  select bt.id, me.slug::text, b.label::text, bt.our_q, (bp.probs)[b.bucket_idx + 1]
  from bets bt
  join market_buckets b on b.id = bt.bucket_id
  join market_events me on me.id = bt.event_id
  join lateral (
    select probs from bucket_probabilities p
    where p.event_id = bt.event_id and p.source = p_champion
    order by p.made_at desc limit 1
  ) bp on true
  where bt.status = 'filled' and me.winning_bucket_idx is null;
$$;
