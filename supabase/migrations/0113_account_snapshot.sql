-- 0113_account_snapshot.sql — the /trading account-funds overview: venue cash + positions value, snapshotted.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════
-- WHY (operator-directed 2026-07-19): the /trading console shows exposure/P&L from OUR ledger but nothing
-- about the ACCOUNT — how much money is on the venue (cash) and what the venue itself marks the held
-- positions at. The wallet ADDRESS lives only in the Edge secret POLY_FUNDER_ADDRESS (never in this repo),
-- so the read belongs in an edge fn (`account-snapshot`): venue cash via the CLOB balance endpoint (the
-- same credentialed client the buy-table tick already builds — keys never leave the fn), positions value
-- via the PUBLIC data-api. This migration is the storage + read side.
--
-- WHAT:
--   1. account_snapshot — a SINGLE-ROW table (id=1 CHECK) the fn upserts every fire: cash_usd (null when
--      the credentialed read is unavailable — fail-soft), positions_value_usd + n_positions (public
--      data-api marks), captured_at, note (why a field is null, verbatim).
--   2. account_funds() — the fail-soft read RPC for /trading (SEPARATE from dash_trading — the 0099 law:
--      console-critical RPCs stay decoupled from enrichment reads; the loader merges via allSettled).
--      Returns a jsonb OBJECT (0081 tripwire): { cashUsd, positionsValueUsd, nPositions, capturedAt, note }
--      — all-null keys when no snapshot exists yet (the page renders its staged-dark note).
--   3. cron `account-snapshot` at 9,39 * * * * — off the contended quarter-hours (C15 law) and off every
--      existing lane (poll 12/27/42/57 · metar 4/34 · whale 2/32 · google :24). Until the fn is deployed
--      the POST 404s harmlessly (the 0095 precedent). Cron count 35 → 36.
--
-- Boundary: the fn reads env the EDGE runtime already holds; nothing here stores an address or key.
-- Rollback: drop function public.account_funds(); drop table public.account_snapshot;
--           select cron.unschedule('account-snapshot');
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════

create table if not exists public.account_snapshot (
  id                  int primary key default 1 check (id = 1),
  cash_usd            numeric(14,6),
  positions_value_usd numeric(14,6),
  n_positions         int,
  captured_at         timestamptz not null default now(),
  note                text
);
comment on table public.account_snapshot is
  'Single-row venue account snapshot for /trading: CLOB collateral cash (null = credentialed read '
  'unavailable this fire) + public data-api positions value. Upserted by the account-snapshot edge fn.';
alter table public.account_snapshot enable row level security;

create or replace function public.account_funds()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'cashUsd',           s.cash_usd,
    'positionsValueUsd', s.positions_value_usd,
    'nPositions',        s.n_positions,
    'capturedAt',        s.captured_at,
    'note',              s.note
  ) into v
  from public.account_snapshot s
  where s.id = 1;
  return coalesce(v, jsonb_build_object(
    'cashUsd', null, 'positionsValueUsd', null, 'nPositions', null, 'capturedAt', null,
    'note', 'no snapshot yet — deploy + first fire of the account-snapshot edge fn pending'
  ));
end;
$$;

revoke all on function public.account_funds() from public, anon, authenticated;
grant  execute on function public.account_funds() to service_role, authenticated;

-- the fn's write path (DbPort is rpc-only by design — no raw table writes from edge fns).
create or replace function public.account_snapshot_upsert(
  p_cash_usd numeric, p_positions_value_usd numeric, p_n_positions int, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.account_snapshot (id, cash_usd, positions_value_usd, n_positions, captured_at, note)
  values (1, p_cash_usd, p_positions_value_usd, p_n_positions, now(), p_note)
  on conflict (id) do update set
    cash_usd = excluded.cash_usd,
    positions_value_usd = excluded.positions_value_usd,
    n_positions = excluded.n_positions,
    captured_at = excluded.captured_at,
    note = excluded.note;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.account_snapshot_upsert(numeric, numeric, int, text) from public, anon, authenticated;
grant  execute on function public.account_snapshot_upsert(numeric, numeric, int, text) to service_role;

-- cron — the 0095 Vault-secret POST idiom (W11: secrets from Vault, 4.5s timeout); 9,39 avoids every
-- contended/occupied minute lane (C15). Cron count 35 → 36.
do $$
declare edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping account-snapshot registration';
    return;
  end if;
  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/account-snapshot',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  body := '{}'::jsonb,
  timeout_milliseconds := 4500
)$cmd$;
  perform cron.schedule('account-snapshot', '9,39 * * * *', edge_command);
end;
$$;
