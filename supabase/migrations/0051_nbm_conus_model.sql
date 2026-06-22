-- 0051_nbm_conus_model.sql — register the NBM (National Blend of Models) CONUS model
-- (WALLET-RECON-HANDOFF.md §6 Build #3 US sub-lever; §7 feasibility item 2).
--
-- nbm_conus is Open-Meteo's NOAA National Blend of Models, CONUS-only, 2.5 km, ~11-day
-- lead — already a calibrated multi-model blend and the closest free analog to NWS MOS.
-- It is the one lever that breaks the INPUT ceiling on US stations (vs re-tuning under it).
-- PRIOR IS LOW (WO-L3-b found residual R² = 0.6% on existing inputs); registered so a US
-- A/B (ΔTmax-MAE, Δbucket-Brier on US stations only) can be run via
-- `scripts/backfill-forecasts.ts --models nbm_conus --stations KORD,KSEA,KSFO,...`.
--
-- enabled = FALSE deliberately: this registers the model row (satisfying forecast_snapshots.model
-- FK → models(slug)) so a US A/B backfill can write nbm_conus rows via
-- `scripts/backfill-forecasts.ts --models nbm_conus --stations …` (which passes --models
-- explicitly), WITHOUT adding nbm_conus to list_enabled_models — so the live snapshot-forecasts
-- cron does NOT start requesting a CONUS-only model for all ~46 (mostly non-US) stations. To run
-- nbm_conus as a live ingested model later, flip enabled→true AND confirm parseMultiModelDaily
-- tolerates the per-model absence on non-US stations first.
-- DEFERRED + UNAPPLIED: orchestrator-reserved 0051 slot. The Build #3 verdict is that the
-- day-before market is EFFICIENT, so this is staged for the secondary US input A/B only — never
-- a live-trading path. The day-before study read existing forecast_snapshots; this row is only
-- needed if/when the operator chooses to run the (low-prior, R²=0.6%) US sub-lever A/B.

-- NOTE: the LIVE-VERIFIED Open-Meteo slug is `ncep_nbm_conus` — the bare `nbm_conus` is rejected with
-- HTTP 400 ("Cannot initialize MultiDomains from invalid String value"). The model is registered under the
-- real slug so `scripts/backfill-forecasts.ts --models ncep_nbm_conus` actually fetches data.
insert into public.models (slug, display_name, provider, horizon_days, archive_start, enabled, is_ensemble, notes) values
  ('ncep_nbm_conus', 'NOAA NBM (CONUS)', 'NOAA', 11, '2024-01-21', false, false,
   'CONUS-only 2.5km National Blend of Models; US sub-lever for the day-before bucket study (Build #3), registered for A/B backfill only (enabled=false — not in live ingestion). Non-US stations return no data.')
on conflict (slug) do nothing;
