-- 0105_google_cache_write_unwrap — HOTFIX 2 for the 0103 cache write (loop C37, 2026-07-17).
--
-- google_replay_cache_write's type guard returned 0 whenever the driver delivered p_rows as a
-- DOUBLE-ENCODED jsonb STRING (jsonb_typeof = 'string', not 'array') — the postgres-js/DbPort param
-- path does exactly that (the project's known double-encoded-panel trap, ADR: record_google_paper's
-- readers already decode the same way). The local warm run built every unit and wrote NOTHING (n=0
-- ×45 cities). Fix: unwrap a string-encoded payload once before the guard; a genuine non-array still
-- returns 0.
--
-- ROLLBACK: re-apply 0103's google_replay_cache_write body.

create or replace function public.google_replay_cache_write(p_cache_key text, p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '40s'
as $$
declare
  n      integer := 0;
  v_rows jsonb   := p_rows;
begin
  if p_cache_key is null or v_rows is null then
    return 0;
  end if;
  -- the double-encoding unwrap: a string-typed payload is a JSON document serialized once too often.
  if jsonb_typeof(v_rows) = 'string' then
    begin
      v_rows := (v_rows #>> '{}')::jsonb;
    exception when others then
      return 0;
    end;
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    return 0;
  end if;
  insert into public.google_replay_cache (event_id, cache_key, replay)
  select r->>'eventId', p_cache_key, r
    from jsonb_array_elements(v_rows) r
   where coalesce(r->>'eventId', '') <> ''
  on conflict (event_id, cache_key) do update
    set replay = excluded.replay, updated_at = now();
  get diagnostics n = row_count;
  delete from public.google_replay_cache
   where updated_at < now() - interval '35 days'
      or (cache_key <> p_cache_key and updated_at < now() - interval '7 days');
  return n;
end;
$$;

revoke all on function public.google_replay_cache_write(text, jsonb) from public, anon, authenticated;
grant  execute on function public.google_replay_cache_write(text, jsonb) to service_role;
