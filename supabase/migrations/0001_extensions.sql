-- 0001_extensions.sql — required Postgres extensions (ARCHITECTURE.md §5).
-- Guarded in DO blocks so the schema chain also applies in extension-less test
-- environments (PGlite migration tests stub cron.schedule before 0009 runs).
-- On hosted Supabase both extensions are available and install cleanly.

do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron unavailable here (%) — 0009 registrations need a cron.schedule stub', sqlerrm;
end
$$;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net unavailable here (%) — cron commands referencing net.http_post will not execute', sqlerrm;
end
$$;
