-- 0019_trading_rpcs.sql — the §6.20 executor boundary: fill_bet_with_caps
-- (W5/W17), bet_for_execution, go_live_gate_inputs (C5), live-path recorders
-- (ARCHITECTURE.md §6.20, §6.20a, §7.15–§7.16).

-- Everything execute-bet needs to load a bet in one round trip. NULL (no row)
-- when the id is unknown — the 404 path.
create or replace function public.bet_for_execution(p_bet_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'betId', bt.id, 'status', bt.status, 'mode', bt.mode,
    'eventId', bt.event_id, 'eventSlug', me.slug, 'citySlug', c.slug,
    'label', b.label, 'tokenYes', b.token_yes,
    'feeRate', coalesce(b.fee_rate, 0.05),
    'minOrderSize', coalesce(b.min_order_size, 5),
    'tickSize', b.tick_size,
    'execAsk', bt.exec_ask, 'recShares', bt.rec_shares, 'recStakeUsd', bt.rec_stake_usd,
    'recommendedAt', bt.recommended_at, 'notes', bt.notes
  )
  from bets bt
  join market_buckets b on b.id = bt.bucket_id
  join market_events me on me.id = bt.event_id
  join cities c on c.id = me.city_id
  where bt.id = p_bet_id;
$$;

-- THE fill chokepoint (§6.20). One plpgsql function = one transaction, guarded
-- by pg_advisory_xact_lock(hashtext('bankroll')) — transaction-scoped, hence
-- pool-safe over PostgREST. Re-derives bankroll + open exposure and re-applies
-- the FULL §6.8 cap ladder (per-trade → event → cluster → daily) from in-DB
-- inputs ONLY (open bets, config, cities.region, ledger; price/shares are
-- parameters) — a TS-side check outside this lock would re-open the W17 TOCTOU.
-- Two concurrent approvals of DIFFERENT bets serialize here and the second
-- sees the first's exposure (its ledger 'stake' entry shrinks the bankroll and
-- its bets row joins the open-exposure scan).
-- Returns jsonb (caps included on EVERY outcome for the TS↔SQL parity test):
--   {outcome:'filled', price, shares, feeUsd, stakeUsd, caps}
--   {outcome:'caps', details: text[], caps}
--   {outcome:'bad_status', status} | {outcome:'not_found'}
create or replace function public.fill_bet_with_caps(p_bet_id uuid, p_price numeric, p_shares numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bet record;
  v_per_trade_pct numeric;
  v_event_pct numeric;
  v_cluster_pct numeric;
  v_day_pct numeric;
  v_min_stake numeric;
  v_bankroll numeric;
  v_event_open numeric;
  v_cluster_open numeric;
  v_day_open numeric;
  v_per_trade_cap numeric;
  v_event_headroom numeric;
  v_cluster_headroom numeric;
  v_day_headroom numeric;
  v_stake numeric;
  v_fee numeric;
  v_details text[] := '{}';
  v_caps jsonb;
  v_filled boolean;
begin
  perform pg_advisory_xact_lock(hashtext('bankroll'));

  select bt.id, bt.status, bt.mode, bt.event_id, me.target_date, c.region,
         coalesce(b.fee_rate, 0.05) as fee_rate,
         coalesce(b.min_order_size, 5) as min_order_size
    into v_bet
    from bets bt
    join market_buckets b on b.id = bt.bucket_id
    join market_events me on me.id = bt.event_id
    join cities c on c.id = me.city_id
   where bt.id = p_bet_id;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_bet.status <> 'recommended' then
    return jsonb_build_object('outcome', 'bad_status', 'status', v_bet.status);
  end if;

  -- Cap ladder inputs (coalesce defaults mirror §6.11/ConfigSchema verbatim;
  -- the 0010 seed populates every key, so these only protect odd test states).
  v_per_trade_pct := coalesce((select value::numeric from config where key = 'perTradeCapPct'), 0.02);
  v_event_pct     := coalesce((select value::numeric from config where key = 'perEventCapPct'), 0.05);
  v_cluster_pct   := coalesce((select value::numeric from config where key = 'clusterCapPct'), 0.08);
  v_day_pct       := coalesce((select value::numeric from config where key = 'dailyCapPct'), 0.15);
  v_min_stake     := coalesce((select value::numeric from config where key = 'minStakeUsd'), 5);

  v_bankroll := coalesce((select sum(amount_usd) from bankroll_ledger where mode = v_bet.mode), 0);

  -- Open exposure EXCLUDING the bet being granted (it is the candidate) —
  -- the same recommended+filled basis as open_bets_exposure (0018).
  select coalesce(sum(x.stake) filter (where x.event_id = v_bet.event_id), 0),
         coalesce(sum(x.stake) filter (where x.region = v_bet.region), 0),
         coalesce(sum(x.stake) filter (where x.target_date = v_bet.target_date), 0)
    into v_event_open, v_cluster_open, v_day_open
    from (
      select bt2.event_id, c2.region, me2.target_date,
             case when bt2.status = 'filled'
                  then coalesce(bt2.executed_size_usd, bt2.rec_stake_usd)
                  else bt2.rec_stake_usd end as stake
        from bets bt2
        join market_events me2 on me2.id = bt2.event_id
        join cities c2 on c2.id = me2.city_id
       where bt2.status in ('recommended', 'filled') and bt2.id <> p_bet_id
    ) x;

  v_per_trade_cap    := v_per_trade_pct * v_bankroll;
  v_event_headroom   := v_event_pct   * v_bankroll - v_event_open;
  v_cluster_headroom := v_cluster_pct * v_bankroll - v_cluster_open;
  v_day_headroom     := v_day_pct     * v_bankroll - v_day_open;
  v_stake            := p_price * p_shares;

  v_caps := jsonb_build_object(
    'bankroll', v_bankroll, 'perTradeCap', v_per_trade_cap,
    'eventOpen', v_event_open, 'eventHeadroom', v_event_headroom,
    'clusterOpen', v_cluster_open, 'clusterHeadroom', v_cluster_headroom,
    'dayOpen', v_day_open, 'dayHeadroom', v_day_headroom);

  -- §6.8 ladder order, plus the structural guards applyRiskCaps enforces by
  -- construction (whole shares, orderMinSize, minStakeUsd). At fill time a
  -- breach REJECTS (FillRejected('caps')) rather than resizes — §6.20.
  if p_price <= 0 or p_shares <= 0 then
    v_details := v_details || ('invalid fill: price ' || p_price || ' × shares ' || p_shares);
  end if;
  if p_shares <> floor(p_shares) then
    v_details := v_details || ('shares must be whole: ' || p_shares);
  end if;
  if p_shares < v_bet.min_order_size then
    v_details := v_details || ('shares ' || p_shares || ' < orderMinSize ' || v_bet.min_order_size);
  end if;
  if v_stake < v_min_stake then
    v_details := v_details || ('stake ' || round(v_stake, 2) || ' < minStakeUsd ' || v_min_stake);
  end if;
  if v_stake > v_per_trade_cap then
    v_details := v_details || ('per-trade cap: ' || round(v_stake, 2) || ' > ' || round(v_per_trade_cap, 2));
  end if;
  if v_stake > v_event_headroom then
    v_details := v_details || ('per-event cap: ' || round(v_stake, 2) || ' > headroom ' || round(v_event_headroom, 2));
  end if;
  if v_stake > v_cluster_headroom then
    v_details := v_details || ('cluster cap: ' || round(v_stake, 2) || ' > headroom ' || round(v_cluster_headroom, 2));
  end if;
  if v_stake > v_day_headroom then
    v_details := v_details || ('daily cap: ' || round(v_stake, 2) || ' > headroom ' || round(v_day_headroom, 2));
  end if;

  if array_length(v_details, 1) is not null then
    return jsonb_build_object('outcome', 'caps', 'details', to_jsonb(v_details), 'caps', v_caps);
  end if;

  v_fee := round(v_bet.fee_rate * p_price * (1 - p_price) * p_shares, 4);

  -- ADR-09 CAS: the advisory lock serializes fills, but expiry/skip do not take
  -- it — the conditional UPDATE is what makes the loser of an approve-vs-expire
  -- race exit cleanly.
  update bets
     set status = 'filled', approved_at = now(),
         executed_price = p_price, executed_fee = v_fee,
         executed_size_usd = round(v_stake, 2), executed_shares = p_shares,
         executed_at = now()
   where id = p_bet_id and status = 'recommended'
  returning true into v_filled;
  if v_filled is not true then
    return jsonb_build_object('outcome', 'bad_status',
                              'status', (select status from bets where id = p_bet_id));
  end if;

  -- §7.16 stake outflow −(stake + fee), once per bet: the partial unique
  -- (bet_id, entry_type) makes a double-spend impossible. Sign convention
  -- matches settle_bets' payout (+shares on win): net = pnl.
  insert into bankroll_ledger (bet_id, entry_type, amount_usd, mode)
  values (p_bet_id, 'stake', -round(v_stake + v_fee, 2), v_bet.mode)
  on conflict (bet_id, entry_type) where bet_id is not null do nothing;

  return jsonb_build_object('outcome', 'filled', 'price', p_price, 'shares', p_shares,
                            'feeUsd', v_fee, 'stakeUsd', round(v_stake, 2), 'caps', v_caps);
end;
$$;

-- goLiveGate inputs (C5) in one round trip. The pooled row is run-calibration's
-- zero-UUID/lead −1/'60d' sentinel; the per-city estimate is the n-weighted
-- mean over that city's 60d champion rows at leads {0,1}; distinctDays counts
-- out-of-sample days = graded events with a scored champion distribution.
create or replace function public.go_live_gate_inputs(p_champion text, p_city_slug text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'distinctDays', (
      select count(distinct me.target_date)
      from market_events me
      where me.winning_bucket_idx is not null
        and exists (select 1 from bucket_probabilities bp
                    where bp.event_id = me.id and bp.source = p_champion and bp.brier is not null)
    ),
    'pooled', (
      select jsonb_build_object('brier', cs.brier, 'brierMarket', cs.brier_market,
                                'bootstrapP', cs.bootstrap_p, 'n', cs.n_events)
      from calibration_scores cs
      where cs.city_id = '00000000-0000-0000-0000-000000000000'::uuid
        and cs.source = p_champion and cs.lead_days = -1 and cs.window_tag = '60d'
    ),
    'city', case when p_city_slug is null then null else (
      select jsonb_build_object(
        'n', coalesce(sum(cs.n_events), 0),
        'brier', sum(cs.brier * cs.n_events) filter (where cs.brier is not null)
                 / nullif(sum(cs.n_events) filter (where cs.brier is not null), 0),
        'brierMarket', sum(cs.brier_market * cs.n_events) filter (where cs.brier_market is not null)
                       / nullif(sum(cs.n_events) filter (where cs.brier_market is not null), 0))
      from calibration_scores cs
      join cities c on c.id = cs.city_id
      where c.slug = p_city_slug and cs.source = p_champion
        and cs.window_tag = '60d' and cs.lead_days in (0, 1)
    ) end,
    'halts', (
      select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
      from config
      where key = 'halt:global'
         or (p_city_slug is not null and key = 'halt:city:' || p_city_slug)
    ),
    'kycAttestedAt', (select value from config where key = 'kycAttestedAt'),
    'ledgerReconciledAt', (select value from config where key = 'ledgerReconciledAt')
  );
$$;

-- Live error path (§6.20): clob failure ⇒ 'execution_failed', NEVER auto-retried.
create or replace function public.set_bet_execution_failed(p_bet_id uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done boolean;
begin
  update bets set status = 'execution_failed', notes = p_error
   where id = p_bet_id and status in ('recommended', 'filled')
  returning true into v_done;
  return coalesce(v_done, false);
end;
$$;

-- Live resting state (§6.20): GTC posted but unmatched — the order id is kept
-- on the bet so poll-markets' expiry can pull it via execute-bet {action:'cancel'}.
create or replace function public.note_resting_order(p_bet_id uuid, p_order_id text)
returns void
language sql
security definer
set search_path = public
as $$
  update bets set notes = 'resting:' || p_order_id
   where id = p_bet_id and status = 'recommended';
$$;
