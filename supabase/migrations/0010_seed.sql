-- 0010_seed.sql — clusters, models, config defaults, paper-bankroll init
-- (ARCHITECTURE.md §7.4 seed, §6.11 defaults, §7.16 init row, §6.8 clusterOf).
-- All seeds are idempotent (ON CONFLICT DO NOTHING / guarded insert) so a
-- re-push onto an existing database never clobbers operator-tuned values.

-- §6.8 clusterOf — the 12 correlated-exposure cluster keys.
insert into public.clusters (region) values
  ('europe-west'), ('europe-east'), ('east-asia'), ('south-asia'),
  ('southeast-asia'), ('mideast'), ('africa'), ('na-east'),
  ('na-central'), ('na-west'), ('latam'), ('oceania')
on conflict (region) do nothing;

-- §7.4 models seed. Horizons + Previous-Runs archive starts are live-verified
-- values from research/REPORT-weather-data.md (2026-06). KMA/ecmwf_ifs04/gfs025
-- are seeded DISABLED — verified traps: the Forecast API accepts them but
-- returns zero data.
insert into public.models (slug, display_name, provider, horizon_days, archive_start, enabled, is_ensemble, notes) values
  ('ecmwf_ifs025',          'ECMWF IFS 0.25°',              'ECMWF',         15, '2024-02-06', true,  false, null),
  ('gfs_seamless',          'NOAA GFS (seamless)',          'NOAA',          16, '2021-03-26', true,  false, 'longest horizon'),
  ('icon_seamless',         'DWD ICON (seamless)',          'DWD',            7, '2024-01-21', true,  false, null),
  ('jma_seamless',          'JMA GSM (seamless)',           'JMA',           10, '2021-01-01', true,  false, null),
  ('gem_seamless',          'ECCC GEM (seamless)',          'ECCC',           9, '2024-01-21', true,  false, null),
  ('meteofrance_seamless',  'Météo-France ARPEGE (seamless)','Météo-France',  4, '2024-01-21', true,  false, null),
  ('ukmo_seamless',         'UKMO (seamless)',              'UK Met Office',  6, '2024-08-08', true,  false, null),
  ('cma_grapes_global',     'CMA GRAPES Global',            'CMA',            4, '2024-01-21', true,  false, 'short horizon'),
  ('best_match',            'Open-Meteo best match',        'Open-Meteo',    15, null,         true,  false, 'blended pick; Previous-Runs archive not verified for this composite'),
  ('ecmwf_ifs025_ens',      'ECMWF IFS 0.25° Ensemble',     'ECMWF',         14, null,         true,  true,  'Ensemble API models=ecmwf_ifs025; 50 members + control (~351h)'),
  ('gfs05_ens',             'NOAA GEFS 0.5° Ensemble',      'NOAA',          16, null,         true,  true,  'Ensemble API models=gfs05; 30 members + control (~384h)'),
  ('kma_seamless',          'KMA GDPS (seamless)',          'KMA',            0, null,         false, false, 'TRAP: accepted by Forecast API but returns NO data at any station (verified 2026-06); archive stale (ends 2025-04-12)'),
  ('ecmwf_ifs04',           'ECMWF IFS 0.4° (deprecated)',  'ECMWF',          0, null,         false, false, 'TRAP: deprecated/frozen — archive ends 2025-02-25; use ecmwf_ifs025'),
  ('gfs025',                'NOAA GFS 0.25° (direct)',      'NOAA',           0, null,         false, false, 'TRAP: accepted but empty in Forecast API; use gfs_seamless')
on conflict (slug) do nothing;

-- §6.11 config defaults — every tunable, seeded explicitly so /admin shows the
-- full surface. parseConfigRows() merges these DB rows over the same code
-- defaults; env is for secrets and wiring only (§11.2).
insert into public.config (key, value) values
  ('bankrollUsd',            '1000'),
  ('kellyFraction',          '0.25'),
  ('perTradeCapPct',         '0.02'),
  ('perEventCapPct',         '0.05'),
  ('clusterCapPct',          '0.08'),
  ('dailyCapPct',            '0.15'),
  ('uncertaintyMargin',      '0.05'),
  ('spreadBufferMin',        '0.01'),
  ('minEventVolumeUsd',      '2000'),
  ('maxSpread',              '0.05'),
  ('minHoursBeforeClose',    '2'),
  ('maxLeadDays',            '7'),
  ('probeStakeUsd',          '20'),
  ('minStakeUsd',            '5'),
  ('paperSlippage',          '0.01'),
  ('paperBookMaxAgeMin',     '5'),
  ('biasAlpha',              '0.15'),
  ('sigmaWindowDays',        '30'),
  ('sigmaMinN',              '8'),
  ('sigmaFloorC',            '0.45'),
  ('priorSigmaByLead',       '[1.6,1.9,2.3,2.7,3.1,3.5,3.9,4.3]'),
  ('breakerConsecLosses',    '8'),
  ('breakerDailyLossPct',    '0.05'),
  ('breakerDrawdownPct',     '0.25'),
  ('breakerBrier',           '0.30'),
  ('staleForecastHaltH',     '30'),
  ('stalePriceHaltMin',      '30'),
  ('championSource',         'house_gaussian'),
  ('autoApproveMaxStakeUsd', '0'),
  ('jobWallLimitSec',        '150'),
  ('tradingMode',            'paper'),
  ('operatorEmail',          'david.geborek@gmail.com')
on conflict (key) do nothing;

-- §7.16: ledger seeded with init $1,000 paper. Guarded (the partial unique key
-- only covers rows with bet_id, so ON CONFLICT cannot protect this insert).
insert into public.bankroll_ledger (bet_id, entry_type, amount_usd, mode)
select null, 'init', 1000.00, 'paper'
where not exists (
  select 1 from public.bankroll_ledger where entry_type = 'init' and mode = 'paper'
);
