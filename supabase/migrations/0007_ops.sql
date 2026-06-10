-- 0007_ops.sql — job_runs, job_locks, alerts_log, config, config_audit,
-- backfill_progress (ARCHITECTURE.md §7.17–§7.20).

-- The idempotency backbone (ADR-12); takeover bumps attempt via CAS on the
-- same row (W16) — the unique key forbids a second row for the same period.
create table if not exists public.job_runs (
  id          uuid primary key default gen_random_uuid(),
  job         text not null,
  period_key  text not null,
  status      text not null check (status in ('running', 'ok', 'failed')),
  attempt     int not null default 1,
  stats       jsonb,
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  duration_ms int,
  created_at  timestamptz not null default now()
);

create unique index if not exists job_runs_natural_key
  on public.job_runs (job, period_key);
create index if not exists job_runs_job_started_idx
  on public.job_runs (job, started_at desc);

-- C8: lease rows claimed by single CAS UPDATE — pool-safe over PostgREST where
-- session-scoped pg advisory locks are not; auto-expires on isolate death.
create table if not exists public.job_locks (
  job        text primary key,
  holder     text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- v1 lease row; seeded expired so the first poll-markets run can claim it.
insert into public.job_locks (job, holder, expires_at)
values ('poll-markets', null, now())
on conflict (job) do nothing;

create table if not exists public.alerts_log (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  severity   text not null,
  dedupe_key text,
  title      text,
  body       text,
  sent       boolean not null default false,
  created_at timestamptz not null default now()
);

-- Unique (dedupe_key, day) where dedupe_key not null (§7.18). The cast goes
-- through UTC because timestamptz::date directly is not immutable.
create unique index if not exists alerts_log_dedupe_per_day_key
  on public.alerts_log (dedupe_key, (((created_at at time zone 'utc'))::date))
  where dedupe_key is not null;

-- Halts live here as keys halt:global, halt:city:{slug}, halt:city_lead:{slug}:{lead}
-- with reason JSON values (§7.19). Env is for secrets and wiring; tunables live here.
create table if not exists public.config (
  key        text primary key,
  value      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace trigger trg_config_updated_at
  before update on public.config
  for each row execute function public.set_updated_at();

create table if not exists public.config_audit (
  id         uuid primary key default gen_random_uuid(),
  key        text not null,
  old_value  text,
  new_value  text,
  actor      text not null check (actor in ('admin-ui', 'system')),
  created_at timestamptz not null default now()
);

create table if not exists public.backfill_progress (
  script              text not null,
  scope               text not null,                           -- station/model
  cursor              date,
  status              text,
  weighted_calls_used numeric,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (script, scope)
);

create or replace trigger trg_backfill_progress_updated_at
  before update on public.backfill_progress
  for each row execute function public.set_updated_at();
