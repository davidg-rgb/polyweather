-- 0013_grading_rpcs.sql — gradeEvent's race-critical mutations
-- (ARCHITECTURE.md §6.12, ADR-09, ADR-16, C7, W18).

-- Everything the TS orchestrator needs in one round trip. Null when the event
-- is unknown; observation is null until (tmax present AND finalized).
create or replace function public.get_grading_context(p_event_id uuid)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'event', jsonb_build_object(
      'id', me.id, 'slug', me.slug, 'targetDate', me.target_date, 'unit', me.unit,
      'winningBucketIdx', me.winning_bucket_idx, 'gradingMismatch', me.grading_mismatch
    ),
    'city', jsonb_build_object('slug', c.slug, 'displayName', c.display_name, 'tz', c.tz),
    'icao', coalesce(cs.icao, me.icao_at_creation),
    'observation', (
      select jsonb_build_object('tmaxNative', o.tmax_wu_native, 'nObs', o.n_obs)
      from observations o
      where o.icao = coalesce(cs.icao, me.icao_at_creation)
        and o.date_local = me.target_date
        and o.tmax_wu_native is not null
        and o.finalized_at is not null
    ),
    'buckets', (
      select jsonb_agg(jsonb_build_object(
        'idx', b.bucket_idx, 'label', b.label, 'low', b.low_native, 'high', b.high_native,
        'resolvedOutcome', b.resolved_outcome
      ) order by b.bucket_idx)
      from market_buckets b where b.event_id = me.id
    )
  )
  from market_events me
  join cities c on c.id = me.city_id
  left join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where me.id = p_event_id;
$$;

-- THE winner-claim CAS — concurrent fetch-actuals + sweep produce exactly one
-- grading pass (§6.12). Returns false when another grader already won.
create or replace function public.claim_event_winner(p_event_id uuid, p_winner_idx smallint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claimed boolean;
begin
  update market_events
     set winning_bucket_idx = p_winner_idx, resolved_at = now(), closed = true
   where id = p_event_id and winning_bucket_idx is null
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

create or replace function public.flag_grading_mismatch(p_event_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update market_events set grading_mismatch = true where id = p_event_id;
$$;

-- Settle bets (ADR-09 conditional transitions):
--   filled → resolved_win/resolved_lose with pnl = (win ? sh×(1−price) : −sh×price) − fee
--   recommended → expired (the event is over)
--   winners get ONE 'payout' ledger entry (partial unique key = idempotency)
create or replace function public.settle_bets(p_event_id uuid, p_winner_idx smallint, p_resolution_native smallint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wins int;
  v_losses int;
  v_expired int;
  v_payouts int;
begin
  update bets bt
     set status = case when b.bucket_idx = p_winner_idx then 'resolved_win' else 'resolved_lose' end,
         pnl_usd = round((case when b.bucket_idx = p_winner_idx
                     then bt.executed_shares * (1 - bt.executed_price)
                     else -(bt.executed_shares * bt.executed_price) end
                   - coalesce(bt.executed_fee, 0))::numeric, 2),
         resolution_native = p_resolution_native
    from market_buckets b
   where bt.bucket_id = b.id and bt.event_id = p_event_id and bt.status = 'filled';

  select count(*) filter (where status = 'resolved_win'),
         count(*) filter (where status = 'resolved_lose')
    into v_wins, v_losses
  from bets where event_id = p_event_id;

  update bets
     set status = 'expired', expires_reason = 'event_resolved'
   where event_id = p_event_id and status = 'recommended';
  get diagnostics v_expired = row_count;

  insert into bankroll_ledger (bet_id, entry_type, amount_usd, mode)
  select bt.id, 'payout', round(bt.executed_shares::numeric, 2), bt.mode
    from bets bt
   where bt.event_id = p_event_id and bt.status = 'resolved_win'
  on conflict (bet_id, entry_type) where bet_id is not null do nothing;
  get diagnostics v_payouts = row_count;

  return jsonb_build_object('wins', v_wins, 'losses', v_losses, 'expired', v_expired, 'payouts', v_payouts);
end;
$$;

-- ADR-16 scoring: for each (source, lead ∈ {1, 0}) stamp the time-matched
-- scored row (last made_at ≤ cutoff, nowcast=false) — append guarded by
-- `NOT (scored_for_leads @> ARRAY[lead])` (W18: one quiet-market row can carry
-- both leads; the guard + the winner-claim gate make double-appends impossible).
-- Brier = Σ(qᵢ−oᵢ)² computed in-place; nowcast rows get their Brier filled too
-- (aggregated later under window tag 'nowcast' by run-calibration).
create or replace function public.score_distributions(
  p_event_id uuid, p_winner_idx smallint, p_cutoff_lead0 timestamptz, p_cutoff_lead1 timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source text;
  v_lead smallint;
  v_cutoff timestamptz;
  v_row_id uuid;
  v_appended int := 0;
  v_scored jsonb := '[]'::jsonb;
  v_winner_q jsonb := '{}'::jsonb;
  v_q numeric;
begin
  for v_source in
    select distinct bp.source from bucket_probabilities bp where bp.event_id = p_event_id
  loop
    foreach v_lead in array array[1::smallint, 0::smallint]
    loop
      v_cutoff := case when v_lead = 0 then p_cutoff_lead0 else p_cutoff_lead1 end;

      select bp.id into v_row_id
      from bucket_probabilities bp
      where bp.event_id = p_event_id and bp.source = v_source
        and bp.nowcast = false and bp.made_at <= v_cutoff
      order by bp.made_at desc, bp.id desc
      limit 1;

      if v_row_id is null then
        continue; -- no pre-cutoff row: the pair drops out symmetrically (C7)
      end if;

      update bucket_probabilities bp
         set scored_for_leads = bp.scored_for_leads || v_lead,
             brier = (select sum(p * p) from unnest(bp.probs) p) - 2 * bp.probs[p_winner_idx + 1] + 1
       where bp.id = v_row_id
         and not (bp.scored_for_leads @> array[v_lead]);
      if found then
        v_appended := v_appended + 1;
        v_scored := v_scored || jsonb_build_object('source', v_source, 'lead', v_lead, 'rowId', v_row_id);
      end if;

      if v_lead = 0 then
        select bp.probs[p_winner_idx + 1] into v_q from bucket_probabilities bp where bp.id = v_row_id;
        v_winner_q := v_winner_q || jsonb_build_object(v_source, v_q);
      end if;
    end loop;
  end loop;

  update bucket_probabilities bp
     set brier = (select sum(p * p) from unnest(bp.probs) p) - 2 * bp.probs[p_winner_idx + 1] + 1
   where bp.event_id = p_event_id and bp.nowcast = true and bp.brier is null;

  return jsonb_build_object('appended', v_appended, 'scored', v_scored, 'winnerQ', v_winner_q);
end;
$$;

-- Leading streak of consecutive losses per (city slug, lead) over resolved
-- bets, newest first — feeds evaluateBreakers' consecutive-loss rule (F-027).
-- Lead comes from the bet audit (poll-markets stamps audit.leadDays).
create or replace function public.city_loss_streaks()
returns table (city_slug text, lead text, streak int)
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_key text;
  v_done jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  for rec in
    select c.slug as cslug, coalesce(bt.audit ->> 'leadDays', 'na') as blead, bt.status
    from bets bt
    join market_events me on me.id = bt.event_id
    join cities c on c.id = me.city_id
    where bt.status in ('resolved_win', 'resolved_lose')
    order by bt.executed_at desc nulls last, bt.created_at desc
  loop
    v_key := rec.cslug || '|' || rec.blead;
    if (v_done ? v_key) then
      continue;
    end if;
    if rec.status = 'resolved_lose' then
      v_counts := jsonb_set(v_counts, array[v_key], to_jsonb(coalesce((v_counts ->> v_key)::int, 0) + 1));
    else
      v_done := v_done || jsonb_build_object(v_key, true);
    end if;
  end loop;

  return query
  select split_part(k, '|', 1), split_part(k, '|', 2), (v_counts ->> k)::int
  from jsonb_object_keys(v_counts) k;
end;
$$;

-- System-applied halt: config key + audit row (actor 'system', §7.19).
create or replace function public.apply_halt(p_scope text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  select value into v_old from config where key = 'halt:' || p_scope;
  insert into config (key, value)
  values ('halt:' || p_scope, jsonb_build_object('reason', p_reason, 'at', now())::text)
  on conflict (key) do update set value = excluded.value;
  insert into config_audit (key, old_value, new_value, actor)
  values ('halt:' || p_scope, v_old, p_reason, 'system');
end;
$$;
