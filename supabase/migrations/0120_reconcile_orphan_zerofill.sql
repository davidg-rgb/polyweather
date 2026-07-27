-- 0120 · reconcile the ORPHAN ZERO-FILL class (build-queue item ④, operator-directed 2026-07-26)
--
-- THE GAP (2 live occurrences: 2026-07-23 04:18Z, 2026-07-24 07:48Z — money-safe, both markets resolved):
-- when the placement fill-poll THROWS after postOrder succeeded (net/timeout inside postAndRecord), the
-- row is left status='placed' + order_id set + size_matched=0. The inline F1 zero-fill adjudication
-- (buy-table-tick handler) acts on the SAME-tick poll result only, so it is skipped — and the reconcile
-- sweep never re-examines the row because bot_order_list_dangling (0082) lists ONLY status='intent' AND
-- order_id IS NULL. Result: a permanent orphan 'placed' row that BLOCKS re-entry into that market (the
-- needs-reconcile classes always block retry) for the rest of its window. Conservative-safe (over-blocks,
-- never double-places) but lossy: it silently retires a market from the lane.
--
-- THE FIX: widen the dangling candidate set with the orphan class —
--     status='placed' AND order_id IS NOT NULL AND size_matched = 0
-- under the same ≥p_older_than_min age floor (N9). The EXECUTOR (packages/trading live.ts, same change
-- set) branches on order_id: a row carrying a venue id gets DIRECT evidence — getOrder(order_id) + this
-- order's own taker trade records — instead of the heuristic open-orders/trades match. Venue fills found
-- ⇒ record_fill with venue truth (the 07-19 fill-price-truth idiom); a dead zero-fill FAK/FOK ⇒
-- record_canceled (the F1 outcome — a kill-type order cannot rest, so dead+0 is proven); a GTC/GTD row
-- frees only on a known-dead venue status; a still-open resting order is left untouched; anything
-- ambiguous stays held. size_matched = 0 is load-bearing: a 'partial' row is recorded terminal fill
-- state, never dangling.
--
-- ROLLBACK: re-run the 0082 definition (the intent-only WHERE) of bot_order_list_dangling.

create or replace function public.bot_order_list_dangling(p_mode text, p_older_than_min integer default 5)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(o) order by o.created_at asc), '[]'::jsonb))
  from public.live_orders o
  where o.mode = p_mode
    and o.created_at < now() - (coalesce(p_older_than_min, 5) * interval '1 minute')
    and (
      -- 0082: a crash inside the post→record_placed critical section — venue state unknown, no id.
      (o.status = 'intent' and o.order_id is null)
      -- 0120: the orphan zero-fill class — posted (id known) but the fill-poll crashed before the
      -- same-tick adjudication; direct venue evidence by order id decides fill/cancel.
      or (o.status = 'placed' and o.order_id is not null and o.size_matched = 0)
    );
$$;

revoke all on function public.bot_order_list_dangling(text, integer) from public, anon, authenticated;
grant  execute on function public.bot_order_list_dangling(text, integer) to service_role;
