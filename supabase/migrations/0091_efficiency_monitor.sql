-- 0091_efficiency_monitor.sql — the forward EFFICIENCY-MONITOR paper loop (operator-requested 2026-07-09).
--
-- WHAT THIS MEASURES. A forward paper loop that trades the two most-recent falsified findings on real,
-- forward, day-before executable prices and lets the frozen §9R-E gate adjudicate them OVER TIME:
--   S1 · regime + forecast cheap-subset (forward-confirms KILL-GATE 2 + C24 — the Q4 high-disagreement
--        cell is the only finding with a positive point estimate, +1.16pp, so it is tracked separately)
--   S2 · ladder-geometry troughs on the day-before ask ladder (forward-confirms C23-T2/T3)
-- It is a CONFIRMATION instrument, NOT a profit engine: every backtest (C19–C24) says the market is
-- efficient, so the honest expectation is that both strategies wash or bleed. Its one high-value outcome
-- is the small chance a signal holds FORWARD against expectation — the only thing that could reopen
-- trading under the project's standing rule (FINDINGS.md). NO CAPITAL, EVER; the rail stays DORMANT.
--
-- THE DESIGN. The scorer re-DERIVES the whole panel from immutable resolved tables each run (no mutable
-- bet state, no look-ahead: only resolved markets + finalized obs + the day-before ask that was actually
-- captured), so a snapshot is an idempotent recomputation. The driver (scripts/research/
-- efficiency-monitor-run.ts --record, run daily by the operator's scheduler, OR a future thin Edge tick)
-- computes via the PURE core scorer core/sim/efficiency-monitor.ts and records ONE snapshot here.
--
-- This migration adds: the efficiency_monitor_panel snapshot table + record_efficiency_monitor
-- (service-role insert + retention) + dash_efficiency_monitor (operator read: latest view + a compact
-- trend series). Read-only against the DB inputs; no external API, no packages/trading.

-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 1 · the snapshot table
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.efficiency_monitor_panel (
  id          bigint generated always as identity primary key,
  captured_at timestamptz not null default now(),
  as_of_date  date        not null,   -- the TEST window's end (the last resolved target_date scored)
  view        jsonb       not null    -- the full MonitorReport + window metadata (see efficiency-monitor-run.ts)
);
create index if not exists efficiency_monitor_panel_captured_idx on public.efficiency_monitor_panel (captured_at desc);

comment on table public.efficiency_monitor_panel is
  'Forward efficiency-monitor paper snapshots: S1 regime+forecast cheap-subset (KILL-GATE 2 + C24) and S2 '
  'ladder-geometry troughs (C23), each adjudicated by the frozen §9R-E gate, re-derived from resolved tables '
  'each run. Analytics-only, no capital; the rail stays DORMANT (FINDINGS.md). Driver: efficiency-monitor-run.ts.';

-- RLS on (ADR-13): written only by record_efficiency_monitor (security definer); read only via dash_efficiency_monitor.
alter table public.efficiency_monitor_panel enable row level security;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 2 · record_efficiency_monitor — service-role insert + retention
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.record_efficiency_monitor(p_as_of date, p_view jsonb)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_id bigint;
begin
  insert into public.efficiency_monitor_panel (captured_at, as_of_date, view)
  values (now(), p_as_of, coalesce(p_view, '{}'::jsonb))
  returning id into v_id;
  -- keep the table small: retain the latest 400 snapshots (>1yr at a daily cadence).
  delete from public.efficiency_monitor_panel
   where id < (select min(id) from (select id from public.efficiency_monitor_panel order by id desc limit 400) k);
  return v_id;
end;
$$;

revoke all on function public.record_efficiency_monitor(date, jsonb) from public, anon, authenticated;
grant  execute on function public.record_efficiency_monitor(date, jsonb) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════════════
-- SECTION 3 · dash_efficiency_monitor — operator read of the LATEST snapshot + a compact trend series
-- ════════════════════════════════════════════════════════════════════════════════════════════════════
create or replace function public.dash_efficiency_monitor()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb;
begin
  perform public.operator_guard();
  select jsonb_build_object(
    'generatedAt', latest.captured_at,
    'asOf',        latest.as_of_date,
    'view',        latest.view,
    -- a compact trend: how each strategy's §9R-E gate + Q4 edge evolved as data accrued (oldest→newest).
    'history', (
      select coalesce(jsonb_agg(pt order by pt->>'capturedAt'), '[]'::jsonb)
      from (
        select jsonb_build_object(
          'capturedAt', p.captured_at,
          'asOf',       p.as_of_date,
          's1Label',    p.view#>>'{s1,verdict,label}',
          's1N',       (p.view#>>'{s1,verdict,nMarkets}')::numeric,
          's1CiLow',   (p.view#>>'{s1,verdict,ciLow}')::numeric,
          's1CiHigh',  (p.view#>>'{s1,verdict,ciHigh}')::numeric,
          's1Q4Edge',  (p.view#>>'{s1,q4DayClustered,mean}')::numeric,
          's1Q4CiLow', (p.view#>>'{s1,q4DayClustered,lo}')::numeric,
          's1Q4CiHigh',(p.view#>>'{s1,q4DayClustered,hi}')::numeric,
          's1Q4Days',  (p.view#>>'{s1,q4DistinctWeatherDays}')::numeric,
          's2Label',    p.view#>>'{s2,verdict,label}',
          's2N',       (p.view#>>'{s2,verdict,nMarkets}')::numeric
        ) as pt
        from public.efficiency_monitor_panel p
        order by p.captured_at desc
        limit 180
      ) k
    )
  )
  into v
  from public.efficiency_monitor_panel latest
  order by latest.captured_at desc
  limit 1;
  return coalesce(v, jsonb_build_object('generatedAt', null, 'asOf', null, 'view', null, 'history', '[]'::jsonb));
end;
$$;

revoke all on function public.dash_efficiency_monitor() from public, anon, authenticated;
grant  execute on function public.dash_efficiency_monitor() to authenticated, service_role;
