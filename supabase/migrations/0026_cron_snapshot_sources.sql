-- 0026_cron_snapshot_sources.sql — register the snapshot-sources twice-daily
-- cron job (external comparison-source capture; function
-- supabase/functions/snapshot-sources, table source_forecasts from 0025).
--
-- Same Vault-secret pattern as 0009 (W11): the command reads project_url +
-- cron_secret at run time so no literal secret lands in cron.job. Idempotent —
-- cron.schedule upserts by jobname. Runs at 10:25Z (slot 10Z) and 22:25Z
-- (slot 22Z), just after the Open-Meteo snapshot slots, so a source capture and
-- a model capture for the same day share the same AM/PM cadence.
--
-- Requires the snapshot-sources function deployed AND the source API keys set as
-- Edge Function secrets (OPENWEATHERMAP_API_KEY / WEATHERAPI_API_KEY); with no
-- keys the function records a one-time WARN and writes nothing (handler).
do $$
declare
  edge_command text;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'cron.schedule not available — skipping snapshot-sources registration (test environment without a stub?)';
    return;
  end if;

  edge_command := $cmd$select net.http_post(
  url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/snapshot-sources',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
  ),
  timeout_milliseconds := 4500
)$cmd$;

  perform cron.schedule('snapshot-sources', '25 10,22 * * *', edge_command);
end;
$$;
