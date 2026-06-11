-- 0020_support_rpcs.sql — the §6.19 support jobs: grade-bets sweep,
-- daily-digest, health-monitor (ARCHITECTURE.md §6.19, ADR-11/12, F-033/F-036, W7).

-- Sweep targets: every ungraded event whose target day has started or passed.
-- The precise "local midnight + 3h" gate is applied caller-side via
-- core/time localDayWindow (the tz is returned for exactly that).
create or replace function public.sweep_grading_targets()
returns table (event_id uuid, ctx jsonb)
language sql
security definer
set search_path = public
as $$
  select me.id, jsonb_build_object(
    'slug', me.slug, 'targetDate', me.target_date, 'tz', c.tz,
    'hasTruth', exists (
      select 1 from observations o
      where o.icao = coalesce(cs.icao, me.icao_at_creation)
        and o.date_local = me.target_date
        and o.tmax_wu_native is not null
        and o.finalized_at is not null
    ),
    'marketResolved', me.poly_resolved_winner_idx is not null
      or exists (select 1 from market_buckets b
                 where b.event_id = me.id and b.resolved_outcome = 'win')
  )
  from market_events me
  join cities c on c.id = me.city_id
  left join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where me.winning_bucket_idx is null
    and me.target_date <= (now() at time zone 'utc')::date;
$$;

-- F-033 live reconciliation basis: open live fills with their YES token —
-- diffed against the data-api /positions payload.
create or replace function public.live_bets_for_reconciliation()
returns table (bet jsonb)
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'betId', bt.id, 'status', bt.status, 'tokenYes', b.token_yes,
    'executedShares', bt.executed_shares, 'executedPrice', bt.executed_price,
    'eventSlug', me.slug, 'label', b.label
  )
  from bets bt
  join market_buckets b on b.id = bt.bucket_id
  join market_events me on me.id = bt.event_id
  where bt.mode = 'live' and bt.status = 'filled';
$$;

-- Every §6.19 digest section in one round trip.
create or replace function public.digest_data(p_mode text, p_champion text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'bankroll', (select coalesce(sum(amount_usd), 0) from bankroll_ledger where mode = p_mode),
    'bankrollPrev', (select coalesce(sum(amount_usd), 0) from bankroll_ledger
                     where mode = p_mode and created_at < now() - interval '24 hours'),
    'resolutions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'slug', me.slug, 'city', c.display_name, 'unit', me.unit,
        'resolutionNative', (select bt.resolution_native from bets bt
                             where bt.event_id = me.id and bt.resolution_native is not null limit 1),
        'winnerLabel', (select b.label from market_buckets b
                        where b.event_id = me.id and b.bucket_idx = me.winning_bucket_idx),
        'ourQ', (select (bp.probs)[me.winning_bucket_idx + 1] from bucket_probabilities bp
                 where bp.event_id = me.id and bp.source = p_champion
                 order by bp.made_at desc limit 1),
        'marketP', (select (bp.probs)[me.winning_bucket_idx + 1] from bucket_probabilities bp
                    where bp.event_id = me.id and bp.source = 'market_consensus'
                    order by bp.made_at desc limit 1),
        'bets', (select coalesce(jsonb_agg(jsonb_build_object(
                   'status', bt.status, 'pnl', bt.pnl_usd, 'stake', bt.executed_size_usd)), '[]'::jsonb)
                 from bets bt where bt.event_id = me.id
                   and bt.status in ('resolved_win', 'resolved_lose') and bt.mode = p_mode)
      ) order by me.slug), '[]'::jsonb)
      from market_events me
      join cities c on c.id = me.city_id
      where me.winning_bucket_idx is not null and me.resolved_at > now() - interval '24 hours'
    ),
    'openRecs', (
      select jsonb_build_object('n', count(*), 'totalStake', coalesce(sum(rec_stake_usd), 0))
      from bets where status = 'recommended'
    ),
    'brierByCity', (
      select coalesce(jsonb_agg(row order by (row->>'diff')::numeric), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'city', c.slug,
          'house', round(sum(cs.brier * cs.n_events) filter (where cs.source = p_champion)
                   / nullif(sum(cs.n_events) filter (where cs.source = p_champion), 0), 4),
          'market', round(sum(cs.brier * cs.n_events) filter (where cs.source = 'market_consensus')
                    / nullif(sum(cs.n_events) filter (where cs.source = 'market_consensus'), 0), 4),
          'n', sum(cs.n_events) filter (where cs.source = p_champion),
          'diff', round(coalesce(sum(cs.brier * cs.n_events) filter (where cs.source = p_champion)
                   / nullif(sum(cs.n_events) filter (where cs.source = p_champion), 0), 0)
                  - coalesce(sum(cs.brier * cs.n_events) filter (where cs.source = 'market_consensus')
                   / nullif(sum(cs.n_events) filter (where cs.source = 'market_consensus'), 0), 0), 4)
        ) as row
        from calibration_scores cs
        join cities c on c.id = cs.city_id
        where cs.window_tag = '30d' and cs.source in (p_champion, 'market_consensus')
        group by c.slug
        having sum(cs.n_events) filter (where cs.source = p_champion) is not null
      ) ranked
    ),
    'edgeDeciles', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'decile', decile, 'n', n, 'hitRate', round(hit_rate, 3),
        'avgEdge', round(avg_edge, 4), 'pnl', pnl_sum) order by decile), '[]'::jsonb)
      from edge_decile_stats where mode = p_mode
    ),
    'halts', (
      select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      from config where key like 'halt:%'
    ),
    'jobs24h', (
      select jsonb_build_object(
        'ok', count(*) filter (where status = 'ok'),
        'failed', count(*) filter (where status = 'failed'))
      from job_runs where started_at > now() - interval '24 hours'
    )
  );
$$;

-- Per-job freshness for the W7 staleness matrix: latest success + the latest
-- still-running start ('running' counts as fresh only while younger than the
-- wall limit — the caller applies that rule).
create or replace function public.job_freshness()
returns table (job text, last_ok timestamptz, running_started timestamptz)
language sql
security definer
set search_path = public
as $$
  select j.job,
         max(j.finished_at) filter (where j.status = 'ok'),
         max(j.started_at) filter (where j.status = 'running')
  from job_runs j
  group by j.job;
$$;

-- ADR-12 reaper: runs stuck 'running' past the wall limit flip to 'failed' —
-- the (job, period_key) row becomes CAS-takeover-able again.
create or replace function public.reap_stale_runs(p_wall_sec int)
returns table (job text, period_key text)
language sql
security definer
set search_path = public
as $$
  update job_runs
     set status = 'failed',
         error = 'reaped by health-monitor: exceeded wall limit (ADR-12)',
         finished_at = now()
   where status = 'running'
     and started_at < now() - make_interval(secs => p_wall_sec)
  returning job, period_key;
$$;

-- ADR-11 resend sweep basis: unsent alerts old enough that the original post
-- has definitively failed (not merely in flight).
create or replace function public.list_unsent_alerts(p_older_min int)
returns table (id uuid, kind text, severity text, title text, body text)
language sql
security definer
set search_path = public
as $$
  select a.id, a.kind, a.severity, a.title, a.body
  from alerts_log a
  where a.sent = false
    and a.created_at < now() - make_interval(mins => p_older_min)
  order by a.created_at
  limit 20;
$$;

-- Dead-man inputs + tomorrow-events sanity in one round trip.
create or replace function public.data_freshness(p_tomorrow date)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'newestForecastAt', (select max(captured_at) from forecast_snapshots),
    'newestSnapshotAt', (select max(captured_at) from market_snapshots),
    'activeCities', (select count(*) from cities where betting_enabled),
    'tomorrowEventCities', (
      select count(distinct me.city_id) from market_events me
      join cities c on c.id = me.city_id and c.betting_enabled
      where me.target_date = p_tomorrow and not me.closed
    )
  );
$$;
