-- 0012_discovery_rpcs.sql — discover-markets mutations as SQL functions
-- (ARCHITECTURE.md §6.13, ADR-03). Same single-implementation principle as
-- 0011: PostgREST rpc() in production, PGlite in tests.

-- City + current-station snapshot for an incoming event's slug.
create or replace function public.get_city_state(p_slug text)
returns table (city_id uuid, tz text, unit text, betting_enabled boolean, current_icao text)
language sql
security definer
set search_path = public
as $$
  select c.id, c.tz, c.unit, c.betting_enabled, cs.icao
  from cities c
  left join city_stations cs on cs.city_id = c.id and cs.valid_to is null
  where c.slug = p_slug;
$$;

-- Upsert by slug. New city ⇒ betting_enabled=false (§6.13); existing ⇒ touch last_seen.
create or replace function public.upsert_city(
  p_slug text, p_display_name text, p_country_code text,
  p_unit text, p_tz text, p_region text
)
returns table (city_id uuid, is_new boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_new boolean;
begin
  insert into cities (slug, display_name, country_code, unit, tz, region, betting_enabled, first_seen, last_seen)
  values (p_slug, p_display_name, p_country_code, p_unit, p_tz, p_region, false, now(), now())
  on conflict (slug) do update set last_seen = now()
  returning cities.id, (xmax = 0) into v_id, v_new;
  return query select v_id, v_new;
end;
$$;

-- Provisional station row when the ICAO is brand-new (lat/lon null until
-- seed-stations/manual entry — satisfies the FK without a circular
-- wait-for-operator bootstrap, §6.13).
create or replace function public.ensure_station(p_icao text, p_country_code text, p_tz text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created boolean;
begin
  insert into stations (icao, country_code, tz, source)
  values (p_icao, p_country_code, p_tz, 'manual')
  on conflict (icao) do nothing
  returning true into v_created;
  return coalesce(v_created, false);
end;
$$;

-- ADR-03 temporal mapping: 'unchanged' | 'new' (first station for the city) |
-- 'changed' (close old row, insert unverified new one, SUSPEND betting —
-- caller raises the CRITICAL STATION_CHANGE alert).
create or replace function public.swap_station(
  p_city_id uuid, p_icao text, p_wu_cc text, p_source_url text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current text;
begin
  select cs.icao into v_current
  from city_stations cs
  where cs.city_id = p_city_id and cs.valid_to is null;

  if v_current = p_icao then
    return 'unchanged';
  end if;

  if v_current is null then
    insert into city_stations (city_id, icao, wu_country_code, valid_from, verified, source_url)
    values (p_city_id, p_icao, p_wu_cc, now(), false, p_source_url);
    return 'new';
  end if;

  update city_stations set valid_to = now()
  where city_id = p_city_id and valid_to is null;
  insert into city_stations (city_id, icao, wu_country_code, valid_from, verified, source_url)
  values (p_city_id, p_icao, p_wu_cc, now(), false, p_source_url);
  update cities set betting_enabled = false where id = p_city_id;
  return 'changed';
end;
$$;

-- Upsert by poly_event_id; a (city, target_date, kind) collision with a
-- DIFFERENT poly id means Polymarket recreated the event — adopt the new ids
-- on the existing row.
create or replace function public.upsert_event(
  p_poly_event_id text, p_slug text, p_kind text, p_city_id uuid, p_icao text,
  p_target_date date, p_unit text, p_neg_risk_market_id text, p_accepting boolean,
  p_volume24h numeric, p_liquidity numeric, p_ladder_ok boolean, p_ladder_problems text[]
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
                               ladder_ok, ladder_problems, first_seen, last_seen)
    values (p_poly_event_id, p_slug, p_kind, p_city_id, p_icao, p_target_date, p_unit,
            p_neg_risk_market_id, p_accepting, p_volume24h, p_liquidity,
            p_ladder_ok, p_ladder_problems, now(), now())
    on conflict (poly_event_id) do update
      set accepting_orders = excluded.accepting_orders,
          volume24h = excluded.volume24h,
          liquidity = excluded.liquidity,
          ladder_ok = excluded.ladder_ok,
          ladder_problems = excluded.ladder_problems,
          last_seen = now(),
          closed = false
    returning market_events.id, (xmax = 0) into v_id, v_new;
  exception when unique_violation then
    -- recreated event: same (city, date, kind), new poly ids
    update market_events me
       set poly_event_id = p_poly_event_id, slug = p_slug,
           accepting_orders = p_accepting, volume24h = p_volume24h,
           liquidity = p_liquidity, ladder_ok = p_ladder_ok,
           ladder_problems = p_ladder_problems, last_seen = now(), closed = false
     where me.city_id = p_city_id and me.target_date = p_target_date and me.kind = p_kind
    returning me.id into v_id;
    v_new := false;
  end;
  return query select v_id, v_new;
end;
$$;

create or replace function public.upsert_bucket(
  p_event_id uuid, p_bucket_idx smallint, p_label text,
  p_low smallint, p_high smallint, p_poly_market_id text, p_condition_id text,
  p_token_yes text, p_token_no text, p_tick numeric, p_min_order numeric, p_fee_rate numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into market_buckets (event_id, bucket_idx, label, low_native, high_native, poly_market_id,
                              condition_id, token_yes, token_no, tick_size, min_order_size, fee_rate)
  values (p_event_id, p_bucket_idx, p_label, p_low, p_high, p_poly_market_id,
          p_condition_id, p_token_yes, p_token_no, p_tick, p_min_order, p_fee_rate)
  on conflict (event_id, bucket_idx) do update
    set label = excluded.label, low_native = excluded.low_native, high_native = excluded.high_native,
        poly_market_id = excluded.poly_market_id, condition_id = excluded.condition_id,
        token_yes = excluded.token_yes, token_no = excluded.token_no,
        tick_size = excluded.tick_size, min_order_size = excluded.min_order_size,
        fee_rate = excluded.fee_rate
  returning market_buckets.id into v_id;
  return v_id;
end;
$$;

-- Close events Gamma stopped returning once they are 2+ days past target (§6.13).
create or replace function public.close_stale_events(p_seen_poly_ids text[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  update market_events me
     set closed = true
   where me.closed = false
     and me.target_date < current_date - 2
     and not (me.poly_event_id = any(p_seen_poly_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
