-- 0023_bet_delivery.sql — §6.12: "BET_REC additionally records delivery
-- status in bets.audit.slack_delivered" — the J-2 approve loop's paper trail
-- for whether the operator was actually pinged about a recommendation.

create or replace function public.note_bet_slack_delivery(p_bet_id uuid, p_delivered boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.bets
     set audit = coalesce(audit, '{}'::jsonb) || jsonb_build_object('slack_delivered', p_delivered)
   where id = p_bet_id;
$$;

revoke all on function public.note_bet_slack_delivery(uuid, boolean) from public, anon, authenticated;
