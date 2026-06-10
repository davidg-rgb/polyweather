/**
 * PGlite migration-test harness.
 *
 * Runs the real migration chain against an embedded Postgres (PGlite) with the
 * Supabase-environment pieces stubbed: the anon/authenticated/service_role
 * roles, auth.jwt(), a cron schema whose cron.schedule() records into a
 * cron.job table (so W11 "no literal secret in cron.job" is testable), and an
 * empty vault.decrypted_secrets table.
 *
 * This verifies migration validity, keys, seeds, RLS, and retention logic.
 * The full `supabase db reset` against the real Supabase stack is a separate
 * operator-environment verification (BUILD-STATE.md) — pg_cron/pg_net/Vault
 * behave for real only there.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface Migration {
  name: string;
  sql: string;
}

export function migrationFiles(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));
}

const SUPABASE_STUBS = /* sql */ `
-- Roles (exist natively on hosted Supabase).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

-- auth.jwt() — mirrors Supabase: reads the request.jwt.claims GUC.
create schema if not exists auth;
create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- cron stub — cron.schedule() upserts by jobname into cron.job, like pg_cron.
create schema if not exists cron;
create table if not exists cron.job (
  jobid    bigint generated always as identity primary key,
  jobname  text unique,
  schedule text,
  command  text
);
create or replace function cron.schedule(p_jobname text, p_schedule text, p_command text)
returns bigint
language plpgsql as $$
declare
  jid bigint;
begin
  insert into cron.job (jobname, schedule, command)
  values (p_jobname, p_schedule, p_command)
  on conflict (jobname) do update
    set schedule = excluded.schedule, command = excluded.command
  returning jobid into jid;
  return jid;
end $$;

-- Vault stub — referenced only inside cron command strings at run time.
create schema if not exists vault;
create table if not exists vault.decrypted_secrets (
  name             text primary key,
  decrypted_secret text
);
`;

/** Boot a fresh PGlite, install Supabase stubs, apply the full migration chain. */
export async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const m of migrationFiles()) {
    try {
      await db.exec(m.sql);
    } catch (err) {
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`);
    }
  }
  return db;
}

/** Convenience: run a query and return rows. */
export async function rows<T = Record<string, unknown>>(
  db: PGlite,
  sql: string,
  params?: unknown[],
): Promise<T[]> {
  const res = await db.query<T>(sql, params);
  return res.rows;
}

/** True if a unique index with exactly these key columns exists on the table. */
export async function hasUniqueIndex(
  db: PGlite,
  table: string,
  columns: string[],
  opts: { partial?: boolean } = {},
): Promise<boolean> {
  const found = await rows<{ cols: string[]; ispartial: boolean }>(
    db,
    `
    select array_agg(a.attname order by k.ord) as cols,
           (i.indpred is not null) as ispartial
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral unnest(i.indkey) with ordinality as k(attnum, ord)
    left join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    where n.nspname = 'public'
      and c.relname = $1
      and i.indisunique
    group by i.indexrelid, i.indpred
    `,
    [table],
  );
  return found.some(
    (idx) =>
      idx.cols.length === columns.length &&
      columns.every((c, j) => idx.cols[j] === c) &&
      (opts.partial === undefined || idx.ispartial === opts.partial),
  );
}

/** Run fn as the given role with optional JWT claims, then restore superuser. */
export async function asRole<T>(
  db: PGlite,
  role: 'anon' | 'authenticated' | 'service_role',
  claims: Record<string, unknown> | null,
  fn: () => Promise<T>,
): Promise<T> {
  await db.exec(
    `select set_config('request.jwt.claims', '${claims ? JSON.stringify(claims) : ''}', false)`,
  );
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.exec(`select set_config('request.jwt.claims', '', false)`);
  }
}
