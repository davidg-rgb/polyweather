-- 0092_slack_rework.sql — the Slack notification rework (operator ask 2026-07-10: "way too much spam and
-- no value — pause everything, identify where the biggest notification value could be, rework what gets
-- sent and when").
--
-- WHAT WAS WRONG (measured, alerts_log 14d): WHALE_TRADE pushed ~42/day (587/14d; 100 on 07-10 alone) —
-- the 06-24 whale-insider scan found NO actionable signature at the $100k floor, so these were pure noise.
-- The deadmen (CAPTURE/BOT_DEADMAN) produced ~230 messages for ONE incident (07-02→07-07 Micro saturation)
-- because their dedupe bucket was floor(epoch/1800) — a 30-MINUTE bucket that re-pages a standing outage
-- every half hour. Meanwhile the ONE high-value message — the daily-digest (edge fn `daily-digest`, 07:00Z,
-- kind DAILY_DIGEST) — was SILENTLY suppressed the whole time: the 0055 pause gate was ON and DAILY_DIGEST
-- was never in the allowlist. Exactly inverted value.
--
-- THE REWORK (operator decisions 2026-07-10, AskUserQuestion):
--   1. WHALE_TRADE per-print pushes RETIRED (digest-only). whale-watch keeps RECORDING whale_trades — the
--      tripwire-② big-print observability is data, not notifications.
--   2. The daily digest becomes the backbone (one message/day) and gains the post-pivot forward
--      instruments: efficiency-monitor S1/S2 verdicts · the city paper ledger · a whales-24h summary.
--   3. Deadmen dedupe at ONE alert PER KIND PER UTC DAY (worst case 2-3/day in a multi-instrument
--      incident, vs 48/day measured).
-- Routing stays the 0055 mechanism: alerts_slack_paused='true' + the allowlist IS the routing table.
-- Interim state (already applied live 2026-07-10 ~13:00Z): allowlist='' → full silence until this applies.
--
-- Sections: 1. digest_data v2 (adds monitor/cityLedger/whales24h keys — ADDITIVE, the deployed handler
-- ignores unknown keys until its redeploy) · 2/3. day-bucket deadmen (0066/0073 bodies re-stated verbatim,
-- ONLY v_bucket changes) · 4. whale_pending_alerts suppression-aware + 48h recency floor (kills the
-- unbounded pending-queue churn under permanent WHALE_TRADE suppression, and caps the backlog flood if the
-- kind is ever re-allowlisted) · 5. the allowlist reroute (hard-set: WHALE_TRADE OUT, DAILY_DIGEST IN;
-- includes the 0089 depth kinds so this is order-independent with the staged 0089 — its append-if-missing
-- no-ops when 0089 applies after this on prod, and this hard-set lands last on a fresh DB).
--
-- Deploy: apply this migration + redeploy the `daily-digest` edge fn (handler gains the three sections).
-- Rollback: update config set value='WHALE_TRADE,BOT_DEADMAN,CAPTURE_DEADMAN,EXIT_FAILED,CIRCUIT_BREAK,POL_LOW,DAILY_KILL'
--           where key='alerts_slack_allow_kinds';  (the pre-2026-07-10 routing)

-- === 1. digest_data — §6.19 digest sections in one round trip, NOW INCLUDING the post-pivot forward
-- instruments. 0020 body re-stated; three keys ADDED (monitor, cityLedger, whales24h). The
-- efficiency_monitor_panel.view column is DOUBLE-ENCODED on prod (the 0091 record RPC received the view as
-- a JSON string) — normalize with jsonb_typeof so both encodings read identically (the same trap the
-- /monitor dash loader handles).
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
    ),
    -- ── 0092 additions: the post-pivot forward instruments ────────────────────────────────────────────
    'monitor', (
      select jsonb_build_object(
        'asOf', p.as_of_date, 'capturedAt', p.captured_at,
        's1', jsonb_build_object(
          'label',          p.v->'s1'->'verdict'->>'label',
          'nMarkets',       (p.v->'s1'->'verdict'->>'nMarkets')::int,
          'nCities',        (p.v->'s1'->'verdict'->>'nCities')::int,
          'nDistinctDays',  (p.v->'s1'->'verdict'->>'nDistinctDays')::int,
          'meanNetReturn',  (p.v->'s1'->'verdict'->>'meanNetReturn')::numeric,
          'ciLow',          (p.v->'s1'->'verdict'->>'ciLow')::numeric,
          'ciHigh',         (p.v->'s1'->'verdict'->>'ciHigh')::numeric),
        's2', jsonb_build_object(
          'label',    p.v->'s2'->'verdict'->>'label',
          'nMarkets', (p.v->'s2'->'verdict'->>'nMarkets')::int)
      )
      from (
        select as_of_date, captured_at,
               case when jsonb_typeof(view) = 'string' then (view #>> '{}')::jsonb else view end as v
        from efficiency_monitor_panel order by captured_at desc limit 1
      ) p
    ),
    'cityLedger', jsonb_build_object(
      'graded24h', (select jsonb_build_object(
                      'n', count(*),
                      'won', count(*) filter (where status = 'won'),
                      'pnl', coalesce(sum(pnl_usd), 0))
                    from city_paper_bets where graded_at > now() - interval '24 hours'),
      'placedToday', (select coalesce(jsonb_agg(jsonb_build_object(
                        'icao', icao, 'arm', arm_hour, 'ask', ask) order by icao), '[]'::jsonb)
                      from city_paper_bets where target_date = (now() at time zone 'utc')::date),
      'lifetime', (select jsonb_build_object(
                     'n', count(*),
                     'pnl', coalesce(sum(pnl_usd), 0))
                   from city_paper_bets where status in ('won', 'lost'))
    ),
    'whales24h', jsonb_build_object(
      'n', (select count(*) from whale_trades where traded_at > now() - interval '24 hours'),
      'top', (select coalesce(jsonb_agg(t.o order by (t.o->>'notional')::numeric desc), '[]'::jsonb)
              from (
                select jsonb_build_object('title', title, 'notional', notional_usd,
                                          'side', side, 'slug', event_slug) as o
                from whale_trades where traded_at > now() - interval '24 hours'
                order by notional_usd desc limit 3
              ) t)
    )
  );
$$;

-- === 2. capture_deadman_check — 0066 body re-stated VERBATIM with ONE change: v_bucket is the UTC DAY,
-- not a 30-min epoch bucket. A standing outage now pages once per sub-check per day (the operator decision:
-- "max 1/day per kind"), instead of every 30 minutes (the measured 07-02→07-07 spam). claim_alert's
-- same-utc-day dedupe-retry window composes exactly with a day-keyed dedupe key.
create or replace function public.capture_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_latest      timestamptz;
  v_stale_min   numeric := coalesce((select value::numeric from config where key = 'bot.captureStaleMin'), 9);
  v_age_min     numeric;
  v_window      int     := coalesce((select value::int from config where key = 'bot.captureSeededFracWindow'), 50);
  v_frac_min    numeric := coalesce((select value::numeric from config where key = 'bot.captureSeededFracMin'), 0.25);
  v_n           int;
  v_seeded_frac numeric;
  -- (3) the flat-open-window-never-sampled guard (CAP-1/CAP-2). p_lead/vol filter could exclude the OPEN entirely.
  v_warmup_days numeric := coalesce((select value::numeric from config where key = 'bot.captureFlatOpenWarmupDays'), 3);
  v_span_days   numeric;
  v_flat_recent int;
  v_noflat      boolean := false;
  v_alarmed     boolean := false;
  v_bucket      text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');  -- 0092: one page per day, was 30-min
begin
  select max(captured_at) into v_latest from public.opening_captures;
  if v_latest is not null then
    v_age_min := extract(epoch from (now() - v_latest)) / 60;
    if v_age_min > v_stale_min then
      v_alarmed := true;
      perform public.claim_alert('CAPTURE_DEADMAN', 'CRITICAL', 'capture-deadman:stale:' || v_bucket,
        'opening-capture is STALE',
        'newest opening_captures row is ' || round(v_age_min, 1) || ' min old (> ' || v_stale_min ||
        ' min threshold). The flat-open forward experiment has stopped producing — the bot scans empty and '
        || 'the Phase-5 clock stalls silently. Check the opening-capture cron + edge fn.');
    end if;

    -- seeded-fraction collapse over the last N is_flat_open captures (the seed path silently failing).
    select count(*), avg((house_seeded)::int)
      into v_n, v_seeded_frac
    from (
      select house_seeded from public.opening_captures
      where is_flat_open order by captured_at desc limit v_window
    ) q;
    if v_n >= v_window and v_seeded_frac < v_frac_min then
      v_alarmed := true;
      perform public.claim_alert('CAPTURE_DEADMAN', 'CRITICAL', 'capture-deadman:seedfrac:' || v_bucket,
        'opening-capture SEEDED FRACTION collapsed',
        'only ' || round(v_seeded_frac * 100, 1) || '% of the last ' || v_window || ' flat-open captures carry a '
        || 'seeded houseProb (< ' || round(v_frac_min * 100, 1) || '% floor). The on-demand seed path is failing '
        || '— captures accrue but are unusable, stalling the experiment. Check seedHouseDist / Open-Meteo / model_stats.');
    end if;

    -- (3) the flat-open window is NEVER sampled (CAP-1/CAP-2). Capture is HEALTHY (newest row fresh — the
    -- v_age_min<=v_stale_min guard) yet over a multi-day span ZERO captures were is_flat_open: the universe
    -- filter is excluding the OPEN the Phase-0.5 spike must measure, so its verdict would be a FALSE NO-GO.
    -- This is the exact silent corruption the seeded-fraction check above MISSES (its v_n>=v_window guard is
    -- skipped when there are no flat-open rows at all). Warmup-gated by span so it can't fire on day one; a
    -- stalled/empty table trips staleness, not this. Tune via config bot.captureFlatOpenWarmupDays (default 3).
    if v_age_min <= v_stale_min then
      select count(*) filter (where is_flat_open),
             extract(epoch from (now() - min(captured_at))) / 86400
        into v_flat_recent, v_span_days
      from public.opening_captures;
      if v_span_days >= v_warmup_days and coalesce(v_flat_recent, 0) = 0 then
        v_noflat := true;
        v_alarmed := true;
        perform public.claim_alert('CAPTURE_DEADMAN', 'CRITICAL', 'capture-deadman:noflat:' || v_bucket,
          'opening-capture NEVER samples the flat-open window',
          'capture is healthy (newest row ' || round(v_age_min, 1) || ' min old) but over a ' || round(v_span_days, 1) ||
          '-day span ZERO captures were is_flat_open (peak ≤ peakMidMax within listingMaxHours of listing). The capture '
          || 'universe filter is excluding the flat OPEN the Phase-0.5 spike must measure — its verdict would be a false '
          || 'NO-GO. Check the opening-capture universe (the lead/vol filter vs the fresh-listing bypass).');
      end if;
    end if;
  end if;

  return jsonb_build_object('checkedAt', now(), 'latestCaptureAt', v_latest, 'ageMin', v_age_min,
                            'flatOpenWindow', v_n, 'seededFrac', v_seeded_frac, 'noFlatOpen', v_noflat,
                            'alarmed', v_alarmed);
end;
$$;

revoke all on function public.capture_deadman_check() from public, anon, authenticated;
grant  execute on function public.capture_deadman_check() to service_role;

-- === 3. bot_deadman_check — 0073 body re-stated VERBATIM with the same single change (day bucket).
create or replace function public.bot_deadman_check()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode        text    := coalesce((select value from config where key = 'tradingMode'), 'paper');
  v_tick_int    numeric := coalesce((select value::numeric from config where key = 'bot.tickIntervalSec'), 30);
  -- cadence-aware AND MODE-SCOPED: a 'bot.tickStaleMin.<mode>' override (minutes) relaxes the 3×-tick-interval
  -- default ONLY for that mode, so the periodic paper re-replay loop (*/15) gets a 45-min floor while a future
  -- live 30s-tick bot keeps its tight ~3-min deadman. Absent ⇒ the original behavior, live bot TRULY unchanged.
  v_thresh_min  numeric := coalesce((select value::numeric from config where key = 'bot.tickStaleMin.' || v_mode), (v_tick_int * 3) / 60);
  v_gate_stale_min numeric := coalesce((select value::numeric from config where key = 'bot.gateStaleMin'), 180);
  v_last_tick   timestamptz;
  v_tick_age    numeric;
  v_last_gate   timestamptz;
  v_gate_age    numeric;
  v_alarmed     boolean := false;
  v_bucket      text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');  -- 0092: one page per day, was 30-min
begin
  select max(as_of) into v_last_tick from public.bot_tick_log where mode = v_mode;
  if v_last_tick is not null then
    v_tick_age := extract(epoch from (now() - v_last_tick)) / 60;
    if v_tick_age > greatest(v_thresh_min, 3) then
      v_alarmed := true;
      perform public.claim_alert('BOT_DEADMAN', 'CRITICAL', 'bot-deadman:tick:' || v_mode || ':' || v_bucket,
        'opening-bot loop (' || v_mode || ') is STALE',
        'newest bot_tick_log row is ' || round(v_tick_age, 1) || ' min old (> ' || round(greatest(v_thresh_min, 3), 1) ||
        ' min). The forward run has stopped ticking — open positions are unmanaged + the gate clock stalls. '
        || 'Check the maker-exit-panel cron + edge fn (or the live opening-bot process + the lease).');
    end if;

    -- the gate-snapshot clock (the direct "experiment stopped advancing" signal).
    select max(computed_at) into v_last_gate from public.bot_gate_snapshot where mode = v_mode and source = 'forward';
    if v_last_gate is not null then
      v_gate_age := extract(epoch from (now() - v_last_gate)) / 60;
      if v_gate_age > v_gate_stale_min then
        v_alarmed := true;
        perform public.claim_alert('BOT_DEADMAN', 'CRITICAL', 'bot-deadman:gate:' || v_mode || ':' || v_bucket,
          'opening-bot forward gate (' || v_mode || ') is STALE',
          'newest forward bot_gate_snapshot is ' || round(v_gate_age, 1) || ' min old — the net-profit verdict '
          || 'has stopped advancing while the loop appears alive. Investigate the loop summary path.');
      end if;
    end if;
  end if;

  return jsonb_build_object('checkedAt', now(), 'mode', v_mode, 'lastTickAt', v_last_tick, 'tickAgeMin', v_tick_age,
                            'lastGateAt', v_last_gate, 'gateAgeMin', v_gate_age, 'alarmed', v_alarmed);
end;
$$;

revoke all on function public.bot_deadman_check() from public, anon, authenticated;
grant  execute on function public.bot_deadman_check() to service_role;

-- === 4. whale_pending_alerts — 0055 body re-stated with TWO changes for the digest-only whale era:
--   (a) SUPPRESSION-AWARE: while WHALE_TRADE is suppressed by the 0055 gate the queue reads EMPTY —
--       otherwise every 10-min tick re-claims (→ 'skip') the same growing pending set forever: unbounded
--       queue + linear per-tick churn under a PERMANENT suppression (the pre-0092 design assumed the pause
--       was temporary).
--   (b) a 48h RECENCY FLOOR: if the kind is ever re-allowlisted, only recent prints alert — a month-old
--       whale is stale news, and without the floor the accumulated backlog would flood 25/tick for days.
-- Recording is UNTOUCHED: whale_trades keeps accruing every ≥$100k print either way (tripwire-② data).
create or replace function public.whale_pending_alerts(p_limit int default 50)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select case
    when public.slack_alert_suppressed('WHALE_TRADE') then jsonb_build_object('rows', '[]'::jsonb)
    else (
      select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
        'tradeKey',    trade_key,
        'txHash',      transaction_hash,
        'proxyWallet', proxy_wallet,
        'trader',      coalesce(nullif(trader_name, ''), proxy_wallet),
        'side',        side,
        'outcome',     outcome,
        'title',       title,
        'sizeShares',  size_shares,
        'price',       price,
        'notionalUsd', notional_usd,
        'link',        link,
        'tradedAt',    traded_at
      ) order by traded_at), '[]'::jsonb))
      from (
        select * from public.whale_trades
        where alerted = false and traded_at > now() - interval '48 hours'
        order by traded_at limit greatest(coalesce(p_limit, 50), 1)
      ) q
    )
  end;
$$;

revoke all on function public.whale_pending_alerts(int) from public, anon, authenticated;
grant  execute on function public.whale_pending_alerts(int) to service_role;

-- === 5. the allowlist reroute — HARD-SET (deliberate, not append: WHALE_TRADE is REMOVED by operator
-- decision 2026-07-10). DAILY_DIGEST is the backbone; deadmen (now 1/day) + the dormant rail guards stay
-- armed; the 0089 depth kinds are included pre-emptively so this migration is order-independent with the
-- staged 0089 (its append-if-missing no-ops when it applies after this). alerts_slack_paused stays wherever
-- ops set it — on prod 'true', which with this allowlist IS the routing table.
-- AMENDED 2026-07-12 (pre-apply): the five buy-table live-lane kinds (0095, launched 2026-07-11 — AFTER this
-- migration was staged) are unioned in — without them this hard-set would silence the live lane's CRITICALs.
insert into public.config (key, value) values
  ('alerts_slack_allow_kinds', 'DAILY_DIGEST,BOT_DEADMAN,CAPTURE_DEADMAN,DEPTH_CAPTURE_DEADMAN,DEPTH_CAPTURE_PARTIAL_WRITE,EXIT_FAILED,CIRCUIT_BREAK,POL_LOW,DAILY_KILL,BUY_TABLE_DEADMAN,BUY_TABLE_DEGRADED,BUY_TABLE_POST_FAILED,ORDER_FAIL,ORDER_NEEDS_RECONCILE')
on conflict (key) do update set value = excluded.value;
