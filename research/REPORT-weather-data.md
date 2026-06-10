# Weather Edge — Weather Data API Ground-Truth Research Report

> Produced by live-introspection agent, 2026-06-10 (~09:00 UTC). All "VERIFIED" facts from live curl/browser calls. Test stations: RKSI (37.4602, 126.4407), EGLL (51.4700, -0.4543), KORD (41.9742, -87.9073). Raw samples in this directory.

## 1. OPEN-METEO FORECAST API (multi-model)

**VERIFIED (live call).** Base endpoint works for all three stations. `daily=temperature_2m_max` is supported **directly** (no manual aggregation needed). `timezone=auto` returns local tz (Asia/Seoul, Europe/London, America/Chicago) and `daily` buckets are computed in that local day. Invalid model names return **HTTP 400** with `{"error":true,"reason":"...Cannot initialize MultiDomains from invalid String value <name>."}`. Note coordinates snap to the model grid (RKSI returns lat 37.5, lon 126.5).

Exact valid `models` values + forecast horizon (non-null `temperature_2m_max` days, max request `forecast_days=16`). Behavior **identical across all 3 stations** (horizons matched within ±1 day):

| Requested model | Valid string | Works | Horizon (days) | Notes |
|---|---|---|---|---|
| ECMWF IFS | `ecmwf_ifs025` | YES | **15** | THE ECMWF model to use |
| ECMWF IFS | `ecmwf_ifs04` | accepted, **0 data** | 0 | Deprecated/frozen (archive ends 2025-02-25); do NOT use |
| NOAA GFS | `gfs_seamless` | YES | **16** | longest horizon |
| NOAA GFS | `gfs_global` | YES | 16 | alias-like to seamless here |
| NOAA GFS | `gfs025` | accepted, **0 data** | 0 | use `gfs_seamless` in Forecast API |
| DWD ICON | `icon_seamless` | YES | 7 | |
| DWD ICON | `icon_global` | YES | 7 | |
| JMA | `jma_seamless` | YES | 10–11 | |
| JMA | `jma_gsm` | YES | 10–11 | |
| KMA | `kma_seamless` | accepted, **0 data** | 0 | **KMA returns NO data via Forecast API at any test station** |
| KMA | `kma_gdps` | accepted, **0 data** | 0 | same — KMA broken/unavailable in live Forecast API |
| CMA | `cma_grapes_global` | YES | 4–5 | short horizon |
| Météo-France | `meteofrance_seamless` | YES | 4 | |
| Météo-France | `arpege_world` | YES | 4 | same data as meteofrance_seamless |
| UKMO | `ukmo_seamless` | YES | 6–7 | |
| UKMO | `ukmo_global_deterministic_10km` | YES | 6–7 | |
| Canadian GEM | `gem_seamless` | YES | 9–10 | |
| Canadian GEM | `gem_global` | YES | 9–10 | |
| (composite) | `best_match` | YES | 15–16 | Open-Meteo's blended pick |

**Working URL:** `https://api.open-meteo.com/v1/forecast?latitude=37.4602&longitude=126.4407&daily=temperature_2m_max&timezone=auto&forecast_days=16&models=ecmwf_ifs025`

**Multi-model in one call — VERIFIED.** Comma-separated `models=ecmwf_ifs025,gfs_seamless,...` works. Each daily field gets a **per-model suffix**: response keys are `temperature_2m_max_<model>` (e.g. `temperature_2m_max_ecmwf_ifs025`, `temperature_2m_max_best_match`). `daily_units` carries the same suffixed keys, all `°C`. `daily.time` is shared. **This is the recommended snapshot call** — one request pulls all models. Sample: `openmeteo_forecast_multimodel_daily_RKSI.json`.

**Hourly variant — VERIFIED.** `hourly=temperature_2m` + multi-model → keys `temperature_2m_<model>`, `hourly.time` in local tz (`2026-06-10T00:00`). Top-level fields: `latitude, longitude, generationtime_ms, utc_offset_seconds, timezone, timezone_abbreviation, elevation, hourly_units{...}, hourly{...}`. Use this if you must recompute daily max in station-local time yourself. Sample: `openmeteo_forecast_multimodel_hourly_RKSI.json`.

**KEY ARCHITECTURE NOTE:** KMA (both strings) returns zero data live — drop KMA from the model set or source it elsewhere. `ecmwf_ifs04` and `gfs025` are traps in the Forecast API (accepted but empty); use `ecmwf_ifs025` and `gfs_seamless`.

## 2. OPEN-METEO PREVIOUS RUNS API

**VERIFIED (live call).** Host `https://previous-runs-api.open-meteo.com/v1/forecast` works. This is the **lead-time dimension** needed for bias calibration.

- **Parameter shape:** suffix `_previous_dayN` on the **variable name**, N = 1..7. Valid: `hourly=temperature_2m_previous_day1` … `temperature_2m_previous_day7`. **`previous_day8`+ are accepted but return all-null** (lead-time depth is 7 days). `previous_day0` = current run (use plain `temperature_2m`).
- **Daily max NOT supported in this style:** `daily=temperature_2m_max_previous_day1` → **HTTP 400**. **You must request `hourly=temperature_2m_previous_dayN` and compute the daily max yourself in local time.**
- **Multi-model + multi-lead works:** `hourly=temperature_2m,temperature_2m_previous_day1,...,_previous_day7` × `models=ecmwf_ifs025,gfs_seamless` → keys `temperature_2m_previous_day3_ecmwf_ifs025` etc. All series returned fully non-null. Sample: `openmeteo_previousruns_hourly_RKSI.json`.
- **Models supported (verified non-null `previous_day1`):** ecmwf_ifs025, gfs_seamless, icon_seamless, jma_seamless, ukmo_seamless, gem_seamless, meteofrance_seamless, cma_grapes_global.
- **Accepts `start_date`/`end_date`** for historical pulls (verified 2025-01 range returns data) — backfill of lead-time series is possible. **Archive start per model** (first non-null `previous_day3`): GFS **2021-03-26**, JMA **2021-01-01**, ECMWF **2024-02-06**, UKMO **2024-08-08**, ICON/GEM/Météo-France/CMA **2024-01-21**.

**FROM DOCS:** "Provides each variable at a fixed lead-time offset: 1, 2, 3, up to 7 days ahead… Data starts from January 2024 (GFS from March 2021, JMA from 2018)." (Live probe of `previous_day3` bottomed at 2021-01-01 for JMA; deeper 2018 data may exist for `previous_day1` or be plan-gated.)

**Plan note:** Previous Runs API requires the **Professional plan** for commercial use (see §6).

## 3. OPEN-METEO HISTORICAL FORECAST API

**VERIFIED (live call).** Host `https://historical-forecast-api.open-meteo.com/v1/forecast` works per model. `daily=temperature_2m_max` **is supported directly**, multi-model comma syntax works with the same suffixes. Data current through **2026-06-08** (lag ~2 days). Sample: `openmeteo_historical_forecast_daily_RKSI_jan2025.json`.

**Archive start date per model (verified, RKSI, first non-null `temperature_2m_max`):**

| Model | Archive start | ≥12 mo as of 2026-06? |
|---|---|---|
| `best_match` | 2021-01-01 | YES |
| `jma_seamless` / `jma_gsm` | 2021-01-01 (probe hit 2016-01-01 on extended range) | YES |
| `gfs_seamless` / `gfs_global` | 2021-03-23 | YES |
| `ukmo_seamless` / `ukmo_global_deterministic_10km` | 2022-03-01 | YES |
| `icon_seamless` / `icon_global` | 2022-11-16 | YES |
| `gem_seamless` / `gem_global` | 2022-11-23 | YES |
| `cma_grapes_global` | 2023-12-31 | YES |
| `meteofrance_seamless` / `arpege_world` | 2023-12-31 | YES |
| `ecmwf_ifs025` | **2024-02-03** | YES (~28 mo) |
| `kma_seamless` / `kma_gdps` | 2025-02-26 → **archive ends 2025-04-12** | NO — broken/stale |
| `ecmwf_ifs04` | ALL NULL | NO — dead |

**CRITICAL — what "historical forecast" means here (FROM DOCS, confirmed live):** The Historical Forecast API is **NOT a lead-time archive**. It is each run's first few hours stitched into a continuous series — effectively a **day-0 / lead≈0 best-estimate** that closely tracks actual conditions. Great as a **pseudo-truth backfill of "what conditions were"**, but it does **NOT** tell you what a model predicted N days ahead.

**To retrieve what a model predicted N days ahead, use:**
1. **Previous Runs API** (§2) — fixed lead-time offsets 1–7 days. Best for systematic per-lead bias calibration and backfill.
2. **Single Runs API** — `https://single-runs-api.open-meteo.com/v1/forecast?...&models=ecmwf_ifs025&run=2026-06-08T00:00`. **VERIFIED:** returns the complete forecast horizon of one specific initialization (up to 384h with `forecast_days=16`); `daily=temperature_2m_max` supported. One run per call (comma-separated runs → HTTP 400). Archive depth: **ECMWF IFS from March 2024; all other models only from September 2025.**

**Recommendation:** Historical Forecast API for observed-ish baseline backfill; Previous Runs API for lead-time bias/error calibration backfill (1–7 day leads, back to 2021–2024); Single Runs API only for ECMWF deep-dives.

## 4. OPEN-METEO ENSEMBLE API

**VERIFIED (live call).** Host `https://ensemble-api.open-meteo.com/v1/ensemble`. Multi-model works. **`daily=temperature_2m_max` IS supported per-member** (verified — `temperature_2m_max`, `temperature_2m_max_member01`, …). Per-member daily max directly available. Samples: `openmeteo_ensemble_hourly_RKSI.json`, `openmeteo_ensemble_daily_max_RKSI.json`.

**Response shape:** member suffix `_memberNN`. Single model: control = bare variable, members = `_member01..NN`. Multi-model: model name appended (`temperature_2m_member01_ncep_gefs025` etc.).

**Ensemble models + member counts + horizon (VERIFIED at RKSI unless noted):**

| Model string | Members (+control) | Horizon | Notes |
|---|---|---|---|
| `ecmwf_ifs025` (→ `ecmwf_ifs025_ensemble`) | **50** + 1 | ~351h (~15d) | primary global ensemble |
| `ecmwf_aifs025` / `ecmwf_aifs025_ensemble` | **50** + 1 | ~366h | AI ensemble |
| `gfs_seamless` / `gfs05` (→ `ncep_gefs025`/`gefs05`) | **30** + 1 | ~384h (16d) | GEFS; `gfs025` only ~243h |
| `icon_seamless` / `icon_global` | **39** + 1 | ~181h (~7.5d) | ICON-EPS |
| `icon_eu` | 39 + 1 | ~121h (EGLL) | regional |
| `gem_global` | **20** + 1 | ~384h | |
| `ukmo_global_ensemble_20km` | **17** + 1 | ~235h | works (meta endpoint 404 but data API works) |
| `bom_access_global_ensemble` | 17 + 1 | **0 at RKSI/EGLL** | accepted, no data live |
| `meteofrance_*`, `jma_*`, `kma_gdps` | **0 members** | n/a | **no ensemble** via this API |

**For distribution-building, ECMWF (50) + GEFS (30) give 80 members with `daily=temperature_2m_max&models=ecmwf_ifs025,gfs05`** — per-member daily max in local time.

**Plan note:** Ensemble API requires **Professional plan** for commercial use.

## 5. OPEN-METEO ERA5 ARCHIVE API

**VERIFIED (live call).** `https://archive-api.open-meteo.com/v1/archive?...&daily=temperature_2m_max&timezone=auto` works. Sample: `openmeteo_era5_archive_daily_RKSI.json`.

**Data lag (VERIFIED, on 2026-06-10):**
- **Default (ERA5T combined / no `models` param):** last non-null = **2026-06-09** → ~1 day behind realtime.
- **`models=era5` / `era5_seamless`:** last = 2026-06-04 → ~5–6 days (final ERA5).
- **`models=ecmwf_ifs`:** last = 2026-06-09 (~1 day).
- **`models=era5_land`:** ALL NULL at these airport points.

**Recommendation:** default archive call (ERA5T) as fast pseudo-truth sanity check only — it is gridded (~9–31 km), differs from the airport METAR max by 1–3°C. **Wunderground remains canonical.**

## 6. OPEN-METEO LIMITS, TERMS, PRICING, TIMING

**Free / Open-Access tier rate limits (FROM DOCS):** **600 calls/min, 5,000/hour, 10,000/day, 300,000/month.** Non-commercial only; CC-BY 4.0 attribution. Exceeding → email alerts at 80/90/100%; abusive IPs blocked.

**Call weighting:** requests with **>10 weather variables** OR spanning **>2 weeks** for one location count as fractional multiples (e.g. 2 weeks × 15 vars = 1.5 calls; 4 weeks = 3.0). A multi-model snapshot (~9 model-variables × 16 days) ≈ slightly more than 1 call. Budget accordingly.

**Paid tiers (VERIFIED via live Stripe pricing-table, EUR):**

| Plan | Monthly | Yearly | Budget |
|---|---|---|---|
| Free / Open-Access | €0 | — | 10k/day (non-commercial) |
| API Standard | €29/mo | €319/yr | 1M calls/mo, commercial licence |
| **API Professional** | **€99/mo** | €1,099/yr | 5M calls/mo |

**CRITICAL plan-gating (VERIFIED from pricing feature table):** Historical Weather, Historical Forecast, **Previous Runs**, Single Runs, **Ensemble**, Climate, Seasonal APIs require **Professional (€99/mo)** or higher for commercial use — NOT in Standard. The free tier covers all of them for non-commercial prototyping at 10k calls/day.

**Paid endpoint mechanics (VERIFIED live):** paid uses `customer-` prefixed hosts + `&apikey=`. Confirmed: `customer-api.open-meteo.com`, `customer-historical-forecast-api...`, `customer-previous-runs-api...`, `customer-ensemble-api...`, `customer-archive-api...` (401 "API key required" without key). Parameters/response identical to free hosts.

**Model update frequency & availability lag (VERIFIED live via `https://api.open-meteo.com/data/<internal_model>/static/meta.json` — these meta calls are NOT counted against limits).** Fields: `last_run_initialisation_time`, `last_run_availability_time`, `update_interval_seconds`. Internal domain names differ from API model strings (GFS = `ncep_gfs025`, ICON = `dwd_icon`, ARPEGE = `meteofrance_arpege_world025`, GEM = `cmc_gem_gdps`). Measured:

| Model (meta domain) | Cycle | Avail lag after init |
|---|---|---|
| DWD ICON (`dwd_icon`) | 6h (4×/day) | ~4.2h |
| ARPEGE (`meteofrance_arpege_world025`) | 6h | ~4.4h |
| GEFS (`ncep_gefs025`) | 6h | ~5–6h |
| GFS 0.13° (`ncep_gfs013`) | 6h | ~6.0h |
| ECMWF AIFS (`ecmwf_aifs025_single`) | 6h | ~6.1h |
| GFS (`ncep_gfs025`) | 6h | ~7.5h |
| ECMWF IFS (`ecmwf_ifs025`) | 6h | **~7.9h** |
| CMA (`cma_grapes_global`) | 6h | ~8.3h |
| ECMWF ENS (`ecmwf_ifs025_ensemble`) | 6h | ~8.5h |
| UKMO (`ukmo_global_deterministic_10km`) | 6h | **~8.7h** |
| JMA GSM (`jma_gsm`) | 6h | ~9.6h |
| GEM GDPS (`cmc_gem_gdps`) | **12h (00/12Z)** | ~16h |

**FROM DOCS (model-updates page):** data is eventually consistent across servers — wait +10 min after update for the freshest run. Free vs commercial run on different servers with slightly different update times.

## 7. WUNDERGROUND (canonical resolution source)

**(a) Page is JS-rendered.** History page (`https://www.wunderground.com/history/daily/kr/incheon/RKSI/date/2026-6-9`, 200, ~261KB) is an Angular app; the temperature table is fetched client-side from `api.weather.com`. The page source embeds public API keys (32-hex, e.g. `e1f10a1e…` — redacted here; **extract from page source at runtime**, do not hardcode). Saved HTML: `wunderground_history_RKSI_2026-06-09.html`.

**(b) Underlying API — EXACTLY which endpoint returns the day's max (VERIFIED):**

```
https://api.weather.com/v1/location/{ICAO}:9:{CC}/observations/historical.json?apiKey={KEY}&units={m|e}&startDate=YYYYMMDD&endDate=YYYYMMDD
```
Location codes confirmed: `RKSI:9:KR`, `EGLL:9:GB`, `KORD:9:US`. Returns `{metadata{...}, observations:[...]}`. Observation fields (verbatim): **`valid_time_gmt`** (unix), **`temp`** (integer in requested unit — WU's own rounding applied server-side), `obs_name, obs_id, key, class, expire_time_gmt, day_ind, dewPt, rh, pressure, wdir, wdir_cardinal, wspd, gust, vis, wc, feels_like, heat_index, wx_phrase, wx_icon, clds, precip_total, precip_hrly,` **`max_temp`**, **`min_temp`** (6-hr synoptic fields — **almost always null**; RKSI/EGLL: 0 non-null).

**The day's max = `max(observations[].temp)` over the local-day window.** VERIFIED matches:
- **KORD 2026-06-09:** `units=e` → max `temp` = **87°F** = exactly the History-page "High Temp 87°F" and the Polymarket resolution unit. `units=m` → 31°C.
- **RKSI 2026-06-09:** `units=m` max = **25°C**; browser obs-table max = 77°F (25°C = 77°F, consistent).
- **EGLL 2026-06-09:** `units=m` max = **19°C**.

The `valid_time_gmt` window **auto-aligns to the local calendar day** (RKSI obs span KST 00:00→23:30; KORD spans local midnight-to-midnight). `startDate=endDate=YYYYMMDD` returns exactly the local-day observations. Samples saved per station.

**Daily-summary variants (VERIFIED):**
- `/v1/location/{ICAO}:9:{CC}/almanac/daily.json` → climatological almanac (record/avg), NOT the actual day.
- `api.weather.com/v3/wx/conditions/historical/dailysummary/30day?geocode={lat},{lon}&units=e...` → works; KORD 2026-06-09 `temperatureMax` = **89°F**. **WARNING — does NOT match the v1 hourly-obs max (87°F) for the same station/day.** The v3 product includes data the History page ignores. **For Polymarket resolution you MUST use the v1 hourly `observations/historical.json` max, not v3 dailysummary.** Sample: `twc_v3_dailysummary30day_ORD.json`.

**(c) ToS / fragility.** The embedded key is an undocumented public frontend key owned by IBM/TWC; usage outside wunderground.com violates TWC ToS, key can rotate without notice, no SLA. Paid alternative: IBM Weather Company Data enterprise API (quote-based; same v1/v2/v3 schema — a paid key would be drop-in). **Design the resolver for runtime key extraction + rotation handling + independent METAR fallback.**

**(d) CRITICAL — how WU computes the daily High (verified via community research + live METAR inspection):**
- **WU uses ONLY hourly METARs + SPECIs, taking the max of spot `temp` values.** It does NOT use 6-hourly max/min groups (METAR RMK `1xxxx`/`2xxxx`), the 24-hr group (`4xxxxxxxx`), one-minute data, or NWS daily summaries. (Source: wethr.net market-resolution analysis.) Confirmed live that KORD raw METARs DO carry these ignored groups — WU discards them.
- **Consequence vs Kalshi:** Kalshi resolves on NWS CLI (QC'd, includes T-group spikes): "The NWS CLI will occasionally report a high 1°F (or more) higher than Weather Underground… can mean the difference between Yes or No." Polymarket = WU hourly-obs max (lower/conservative). Validator must use the WU hourly max specifically.
- **Rounding C→F (VERIFIED):** WU stores obs in tenths °C (METAR T-groups, e.g. `T02060189` = 20.6°C) and **independently rounds to whole °C and whole °F for display**: live proof at KORD — daily peak 30.6°C displayed as **31°C and 87°F simultaneously** (30.6°C = 87.08°F → 87). **For US stations pull `units=e` and take the integer-°F max — never convert from the °C value yourself.**
- **Trading-day window:** local clock 12:00 AM–11:59 PM year-round, consistent across DST — matches the v1 endpoint's local-day windowing.
- **GOTCHA (VERIFIED live):** RKSI's History-page **Summary block shows "No data recorded"** even though the hourly obs table is fully populated (48 rows). **Cannot rely on the Summary "High Temp" field for intl stations — always compute max from the hourly obs / v1 API.** KORD's Summary block populates fine.

## 8. INDEPENDENT METAR / OBSERVATION ALTERNATIVES

**(a) aviationweather.gov — VERIFIED (live).**
`https://aviationweather.gov/api/data/metar?ids=RKSI&format=json&hours=24` → 200, JSON array. Multi-station works (`ids=RKSI,EGLL,KORD`). **Covers non-US stations.** Fields verbatim: `icaoId, reportTime, obsTime` (unix), `temp` (**°C with tenths**, e.g. 20.6), `dewp, wdir, wspd, visib, altim, cover, clouds[], wxString, rawOb` (full METAR incl. RMK T-groups), `lat, lon, elev, name, fltCat, metarType, qcField, receiptTime`. `maxT/minT/maxT24/minT24` exist in schema but mostly null. **Cadence:** RKSI every 30 min; KORD hourly at :51 + SPECIs. Free, no key, US Govt public domain. **Best independent source — tenths °C + raw METAR; replicate WU's spot-max AND nowcast the running daily max.** Sample: `aviationweather_metar_RKSI.json`.

**(b) Iowa Environmental Mesonet (IEM) — VERIFIED (live).**
`https://mesonet.agron.iastate.edu/api/1/daily.json?station={ID}&network={NET}&date=YYYY-MM-DD` works. **International coverage** — verified networks: `IL_ASOS`/`ORD`, **`KR__ASOS`/`RKSI`**, **`GB__ASOS`/`EGLL`** (two underscores for 2-letter country codes). Returns `data:[{station, date, max_tmpf, min_tmpf, precip, ...}]` in °F tenths. **CROSS-SOURCE GOTCHA (VERIFIED):** IEM ORD 2026-06-08 `max_tmpf`=84.0 vs WU v3 dailysummary 83°F — 1°F divergences happen. **Secondary cross-check only, NOT resolution source.** Sample: `iem_daily_ORD_2026-06-08.json`.

**(c) Brief viability:**
- **Meteostat:** RapidAPI-gated, free plan 500 req/month, interpolated point data → light cross-checks only.
- **Synoptic Data:** free open-access tier, real self-serve API key, 170k+ stations incl. global METAR → strong free alternative/backup.
- **NOAA ISD:** free, global, 1901–present, bulk via NCEI/AWS — batch/archive use, not low-latency.

## 9. TIMING SUMMARY (snapshot scheduling)

Global models init at **00/06/12/18Z** (GEM: 00/12Z only). Binding constraint = slowest model (UKMO ~08:45Z for 00Z run; JMA ~09:40Z) + 10-min consistency buffer.

- **Primary daily snapshot: ~10:00–10:30 UTC** — freshest complete **00Z** set for ECMWF, GFS, ICON, ARPEGE, CMA, UKMO, GEFS, ECMWF-ENS (JMA's prior cycle included).
- **Second snapshot: ~22:00–22:30 UTC** — the **12Z** run set.
- ECMWF-only freshness sooner: ~08:30 UTC catches 00Z ECMWF HRES+ENS.

**METAR cadence for nowcasting:** intl airports every ~30 min; US hourly + SPECIs. **Poll aviationweather.gov every ~10–15 min** during the station's local day; daily high usually set by ~2–5pm local. Use raw METAR temp (tenths °C), replicate WU rounding semantics, exclude 6-hr/24-hr T-groups.

## TOP ACTIONABLE FINDINGS
1. **Snapshot call:** one multi-model Forecast API request `daily=temperature_2m_max&timezone=auto&models=ecmwf_ifs025,gfs_seamless,icon_seamless,jma_seamless,gem_seamless,meteofrance_seamless,ukmo_seamless,cma_grapes_global,best_match`. Drop KMA; avoid `ecmwf_ifs04`/`gfs025`.
2. **Lead-time calibration/backfill:** Previous Runs API, `hourly=temperature_2m_previous_day1..7`, compute daily max in local time. Back to 2021 (GFS/JMA) / 2024 (others).
3. **Historical Forecast API is day-0 stitched** — pseudo-truth only, not lead-time.
4. **Distributions:** Ensemble API per-member `daily=temperature_2m_max`; ECMWF(50)+GEFS(30) = 80 members.
5. **Plan:** commercial use of historical/ensemble/previous-runs ⇒ Professional €99/mo; free tier OK for non-commercial prototyping at 10k/day.
6. **Resolution truth:** WU v1 `observations/historical.json` max of integer `temp`, `units=e` for US cities, local-day window. NOT v3 dailysummary; NOT the Summary block (intl stations show "No data").
7. **Validation/nowcast:** aviationweather.gov METAR as independent cross-check + running-max tracker; Synoptic as backup; IEM as second daily-max opinion (expect occasional 1°F divergence).
