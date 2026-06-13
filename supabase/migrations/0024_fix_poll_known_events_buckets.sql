-- 0024 — fix poll_known_events: buckets must be a JSON ARRAY, never null.
--
-- BUG (found live, 2026-06-13): poll-markets failed every 5-min tick with
--   TypeError: evCtx.buckets is not iterable
-- for 24h+ (288/288 runs failed). Root cause: the 'buckets' sub-select used
-- bare jsonb_agg(...), and jsonb_agg returns NULL — not '[]' — over ZERO rows.
-- Flagged events (a known city whose Polymarket ladder fails validateLadder:
-- discovery stores them ladder_ok=false with ZERO market_buckets rows — the
-- three Lucknow Jun-13/14/15 events) therefore came back with ctx.buckets = null.
-- parseGammaEvent still SUCCEEDS on their raw (ladderProblems are attached, not
-- thrown), so the handler reached `for (const bucket of evCtx.buckets)` and a
-- single bucketless event aborted the entire tick for all ~135 live events.
--
-- The EventCtx.buckets contract is `BucketCtx[]` (non-optional); the RPC must
-- honor it. coalesce(..., '[]'::jsonb) restores the array-always contract and
-- protects all four `.buckets` iteration sites in the handler at once. The
-- handler also now skips zero-bucket events (defense + no degenerate consensus
-- row), but this SQL alone stops the crash live — no function redeploy needed.
--
-- Only the buckets sub-select changed vs 0018; everything else is verbatim.
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
    'buckets', coalesce((
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
    ), '[]'::jsonb),
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
