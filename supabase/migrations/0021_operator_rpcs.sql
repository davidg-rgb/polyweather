-- 0021_operator_rpcs.sql — the §8.2 operator-API mutation surface.
-- Every operator_* function is SECURITY DEFINER and self-guards with
-- is_operator() (defense-in-depth: the web route also session-checks; the
-- service-role key never ships to Vercel — §11.5). health_check is the one
-- anon-callable probe (R-18).

create or replace function public.operator_guard()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_operator() then
    raise exception 'ERR_FORBIDDEN';
  end if;
end;
$$;

-- §8.2 skip: conditional UPDATE — idempotent by current-state check (ADR-09).
create or replace function public.operator_skip_bet(p_bet_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done boolean;
  v_exists boolean;
begin
  perform public.operator_guard();
  update bets set status = 'skipped', expires_reason = null, notes = p_reason
   where id = p_bet_id and status = 'recommended'
  returning true into v_done;
  if v_done then return 'ok'; end if;
  select exists(select 1 from bets where id = p_bet_id) into v_exists;
  return case when v_exists then 'bad_status' else 'not_found' end;
end;
$$;

-- §8.2 halt: config halt row + audit (actor category 'admin-ui' — §7.19's
-- check allows only admin-ui|system; the single allow-listed operator IS the
-- admin UI, and apply_halt keeps 'system' for breaker-applied halts).
create or replace function public.operator_halt(p_scope text, p_reason text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := 'halt:' || p_scope;
  v_old text;
begin
  perform public.operator_guard();
  select value into v_old from config where key = v_key;
  insert into config (key, value)
  values (v_key, jsonb_build_object('reason', p_reason, 'at', now())::text)
  on conflict (key) do update set value = excluded.value;
  insert into config_audit (key, old_value, new_value, actor)
  values (v_key, v_old, p_reason, 'admin-ui');
  return v_key;
end;
$$;

-- §8.2 resume: lifts a halt; the typed-confirmation check is the route's.
create or replace function public.operator_resume(p_halt_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  perform public.operator_guard();
  if p_halt_key not like 'halt:%' then return false; end if;
  delete from config where key = p_halt_key returning value into v_old;
  if v_old is null then return false; end if;
  insert into config_audit (key, old_value, new_value, actor)
  values (p_halt_key, v_old, 'resumed', 'admin-ui');
  return true;
end;
$$;

-- §8.2 config: upsert each change + audit row (route validates the MERGED
-- result through parseConfigRows BEFORE calling — invalid keys never land).
create or replace function public.operator_update_config(p_changes jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_change record;
  v_old text;
  v_n int := 0;
begin
  perform public.operator_guard();
  for v_change in select * from jsonb_to_recordset(p_changes) as c(key text, value text)
  loop
    select value into v_old from config where key = v_change.key;
    insert into config (key, value) values (v_change.key, v_change.value)
    on conflict (key) do update set value = excluded.value;
    insert into config_audit (key, old_value, new_value, actor)
    values (v_change.key, v_old, v_change.value, 'admin-ui');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- §8.2 verify-station: operator confirms the mapping; betting re-enabled.
create or replace function public.operator_verify_station(p_city_station_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  perform public.operator_guard();
  select id, city_id, valid_to into v_row from city_stations where id = p_city_station_id;
  if v_row.id is null then return 'not_found'; end if;
  if v_row.valid_to is not null then return 'not_current'; end if;
  update city_stations set verified = true where id = p_city_station_id;
  update cities set betting_enabled = true where id = v_row.city_id;
  return 'ok';
end;
$$;

-- §8.2/F-035 manual bet: standard schema, status 'recommended', audit.manual.
-- Returns {outcome:'ok', betId} | {outcome:'not_found'} | {outcome:'open_rec_exists'}.
create or replace function public.operator_manual_bet(
  p_event_slug text, p_bucket_label text, p_side text,
  p_shares numeric, p_price numeric, p_mode text, p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_bucket_id uuid;
  v_bet_id uuid;
begin
  perform public.operator_guard();
  select me.id, b.id into v_event_id, v_bucket_id
  from market_events me
  join market_buckets b on b.event_id = me.id and b.label = p_bucket_label
  where me.slug = p_event_slug;
  if v_bucket_id is null then return jsonb_build_object('outcome', 'not_found'); end if;

  begin
    insert into bets (event_id, bucket_id, side, status, mode, our_q, best_ask, exec_ask,
                      edge, min_edge, fee_per_share, kelly_raw, kelly_frac, capped_frac,
                      rec_stake_usd, rec_shares, audit, recommended_at)
    values (v_event_id, v_bucket_id, p_side, 'recommended', p_mode, 0, p_price, p_price,
            0, 0, 0, 0, 0, 0,
            round(p_price * p_shares, 2), p_shares,
            jsonb_build_object('manual', true, 'by', p_actor), now())
    returning id into v_bet_id;
  exception when unique_violation then
    return jsonb_build_object('outcome', 'open_rec_exists');
  end;
  return jsonb_build_object('outcome', 'ok', 'betId', v_bet_id);
end;
$$;

-- F-035 live external fill: record executed_* verbatim (the order already
-- happened on Polymarket — no caps re-check, no executor).
create or replace function public.operator_record_external_fill(
  p_bet_id uuid, p_price numeric, p_shares numeric
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mode text;
  v_done boolean;
begin
  perform public.operator_guard();
  select mode into v_mode from bets where id = p_bet_id;
  update bets
     set status = 'filled', approved_at = now(),
         executed_price = p_price, executed_size_usd = round(p_price * p_shares, 2),
         executed_shares = p_shares, executed_fee = 0, executed_at = now()
   where id = p_bet_id and status = 'recommended'
  returning true into v_done;
  if v_done is not true then return false; end if;
  insert into bankroll_ledger (bet_id, entry_type, amount_usd, mode)
  values (p_bet_id, 'stake', -round(p_price * p_shares, 2), v_mode)
  on conflict (bet_id, entry_type) where bet_id is not null do nothing;
  return true;
end;
$$;

-- F-019 server re-check inputs: the candidate's out-of-sample day count and
-- its time-matched (event, lead) Brier pairs vs market_consensus over events
-- resolved in the last 60 days. The route computes the point ratio + paired
-- bootstrap from these (pairedBootstrapPValue lives in core).
create or replace function public.promotion_check_rows(p_candidate text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'days', (
      select count(distinct me.target_date)
      from market_events me
      where me.winning_bucket_idx is not null
        and exists (select 1 from bucket_probabilities bp
                    where bp.event_id = me.id and bp.source = p_candidate and bp.brier is not null)
    ),
    'pairs', (
      select coalesce(jsonb_agg(jsonb_build_object('cand', p.cand, 'market', p.market)), '[]'::jsonb)
      from (
        select cand.brier as cand, mkt.brier as market
        from market_events me
        join bucket_probabilities cand
          on cand.event_id = me.id and cand.source = p_candidate and cand.brier is not null
        cross join lateral unnest(cand.scored_for_leads) as cl(lead)
        join bucket_probabilities mkt
          on mkt.event_id = me.id and mkt.source = 'market_consensus' and mkt.brier is not null
         and mkt.scored_for_leads @> array[cl.lead]
        where me.winning_bucket_idx is not null
          and me.resolved_at > now() - interval '60 days'
      ) p
    )
  );
$$;

create or replace function public.operator_set_champion(p_source text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old text;
begin
  perform public.operator_guard();
  select value into v_old from config where key = 'championSource';
  insert into config (key, value) values ('championSource', p_source)
  on conflict (key) do update set value = excluded.value;
  insert into config_audit (key, old_value, new_value, actor)
  values ('championSource', v_old, p_source, 'admin-ui');
end;
$$;

-- §8.2 export (R-16, K4-ready): one row per FILL and one per RESOLUTION in
-- the window, with USD amounts. The route renders CSV.
create or replace function public.operator_export_rows(p_from date, p_to date, p_mode text)
returns table (line jsonb)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.operator_guard();
  return query
  select r.line from (
    select jsonb_build_object(
      'type', 'fill', 'date', bt.executed_at::date, 'event', me.slug, 'bucket', b.label,
      'side', bt.side, 'mode', bt.mode, 'shares', bt.executed_shares,
      'price', bt.executed_price, 'amountUsd', -(bt.executed_size_usd + coalesce(bt.executed_fee, 0)),
      'feeUsd', bt.executed_fee, 'pnlUsd', null
    ) as line, bt.executed_at as at
    from bets bt
    join market_buckets b on b.id = bt.bucket_id
    join market_events me on me.id = bt.event_id
    where bt.executed_at::date between p_from and p_to
      and (p_mode is null or bt.mode = p_mode)
    union all
    select jsonb_build_object(
      'type', 'resolution', 'date', me.resolved_at::date, 'event', me.slug, 'bucket', b.label,
      'side', bt.side, 'mode', bt.mode, 'shares', bt.executed_shares,
      'price', bt.executed_price,
      'amountUsd', case when bt.status = 'resolved_win' then bt.executed_shares else 0 end,
      'feeUsd', null, 'pnlUsd', bt.pnl_usd
    ) as line, me.resolved_at as at
    from bets bt
    join market_buckets b on b.id = bt.bucket_id
    join market_events me on me.id = bt.event_id
    where bt.status in ('resolved_win', 'resolved_lose')
      and me.resolved_at::date between p_from and p_to
      and (p_mode is null or bt.mode = p_mode)
  ) r
  order by r.at;
end;
$$;

-- R-18 uptime probe — anon-callable by design; leaks only a timestamp.
create or replace function public.health_check()
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object('newestJobRun', (select max(finished_at) from job_runs));
$$;
