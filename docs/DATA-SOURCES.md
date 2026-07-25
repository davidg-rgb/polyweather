# DATA-SOURCES — every endpoint, params, quirks (ground truth: research/)

Parsers must match the committed fixtures exactly; `scripts/smoke-live-apis.ts`
re-asserts every shape live (run before deploys; 12/12 PASS 2026-06-11).

## Polymarket Gamma (REST, no auth)

- `GET gamma-api.polymarket.com/events?tag_id=104596&active=true&closed=false&limit=100&offset=N`
  — daily highest-temperature events; paginate until a short page. `closed=true`
  for history. **Quirks:** `outcomes`/`outcomePrices`/`clobTokenIds` are
  JSON-encoded strings INSIDE the JSON (`parseStringArray`); old events have
  yearless slugs (rejected by `targetDateFromEvent` — the 2025-trap fixture);
  zombie events (past endDate or none-accepting + degenerate quotes) filtered
  by `isZombieEvent` (live Jinan case). Station ICAO parsed from the
  resolution-source URL (US two-middle-segment + intl one-segment, W2).
  C6: slug date cross-checked against `gameStartTime` when tz is known.
- **Cloudflare rejects bare library user agents — every CLI sends a UA header.**

## Polymarket CLOB (REST, no auth for market data)

- `GET clob.polymarket.com/book?token_id=…` — **raw bids ascend and asks
  descend: the BEST quote is the LAST element of each array** (live-verified);
  `normalizeBook` reorders best-first. Carries hash, tick_size (0.01 AND 0.001
  observed), min_order_size, neg_risk.
- `GET clob.polymarket.com/prices-history?market=…` → `{history: [{t: epoch_seconds, p}]}`
  (`parsePricesHistory`). **TWO query forms, and the difference is load-bearing (VERIFIED
  live 2026-06-30):** `interval=max&fidelity=N` returns an EMPTY history for markets older
  than ~2 weeks; the explicit `startTs={createdAt}&endTs={endDate}&fidelity=N` form returns
  the FULL series at ANY age. So historical backfill/pulls MUST use startTs/endTs (live polling
  of fresh markets can use interval=max). `fidelity` is the resolution in MINUTES (min 1;
  ~3000 pts/bucket at fidelity=1 over a 2–3-day market life); `p` is a **single price (implied
  prob) per bucket — NO bid/ask or depth**. Rate limits: book 1500/10s, prices-history 1000/10s.

### Historical reconstruction (`scripts/backfill-market-history.ts`)
- Enumerate via Gamma `events?tag_id=104596&closed=true` (paginate). Each closed
  event → its bucket YES tokens (7 old / 11 new) → `prices-history?startTs/endTs`
  over the event's [createdAt, endDate] life (NOT interval=max — empty for old markets).
- **How far back (VERIFIED live 2026-06-30):** the `closed=true` list floors at
  **~2025-12-30** (atlanta/dallas/nyc the earliest, via `order=endDate&ascending=true`;
  51 cities, the original 8 at Dec-2025, the rest added Feb–Apr 2026). Gamma **422s past
  offset ~2100** (a hard pagination-depth cap), so page ASCENDING (offset 0 = the floor).
  `--earliest-scan` does exactly this — ascending pages, caps gracefully, prints
  earliest/latest/count PER CITY + a caveat when the cap is hit. (Because the ascending
  sweep is cut at the offset cap, the `latest`/`count` columns are truncated at the cap,
  not the true latest — only `earliest`, the floor, is authoritative.)
- **Deeper history via `series_id` — `--series-scan` (BUILT + VERIFIED live 2026-06-30):**
  Gamma `archived`s events older than the closed-list window OUT of the `closed=true` list,
  but the per-city series reaches them: `GET /series?slug={city}-daily-weather` → `{id}`
  (e.g. london→10006, nyc→10005, atlanta→10739), then
  `GET /events?series_id={id}&order=endDate&ascending=true` paginates the FULL history with
  **no archival wall** — London/NYC go back to **2025-01-22** (~2.5× the closed-list depth).
  Coverage: **44/45 of our cities resolve** on the `{city}-daily-weather` stem (panama-city →
  `panama-daily-weather`, in `SERIES_SLUG_OVERRIDES`); the date-window params
  `end_date_min/max` are a dead end (n=0). `--series-scan [--city nyc] [--full-series]` runs
  the SAME ingestion per city against its series pages. Two structural quirks of the old
  events, both handled: they carry **7 buckets, not 11** (ingestion is already bucket-count-
  agnostic), and **yearless slugs** (`…-on-jan-22`) — the live parser REJECTS those (the
  stale-event guard), so backfill passes an opt-in `referenceYear` (from `endDate`) to
  `parseGammaEvent`/`targetDateFromEvent`; the live path keeps the strict reject unchanged.
  NOTE: pre-system dates have NO historical forecasts, so the forecast-vs-market backtest
  can't run on them — the value is the standalone implied-prob archive (convergence /
  efficiency study of the price path).
- **Granularity:** daily-temp markets live ~2–3 days, so `startTs/endTs` at
  `fidelity=1` reconstructs the full minute path per bucket (~3000 pts). Default backfill keeps
  only the daily last-point + the lead-1/0 consensus cutoffs (C2 no-look-ahead);
  `--full-series [--fidelity N]` persists the COMPLETE per-bucket series →
  `market_price_history` (0072) — a dedicated APPEND-ONLY archive, NOT
  `market_snapshots` (which `ops_downsample` thins to 1/day past 30 days). Note:
  point density = trading activity (thin markets / tails are sparse), and `p` is a
  single price, not executable odds — true bid/ask/depth exists only in the forward
  live captures (`market_snapshots` poll / `opening_captures`).

### Local research archive + analysis stack (`scripts/research/`, NO DB)
The DB backfill above keeps only thinned points; for convergence / efficiency study of the
FULL minute price path we pull a standalone local archive (gitignored, `scripts/research/out/`):
- `pull-market-history.ts` — per-city `series_id` enumeration → `prices-history?startTs/endTs`
  (the explicit-window form, NOT `interval=max`, which serves EMPTY for markets older than ~2wk —
  verified live 2026-06-30). Writes one JSON per event:
  `out/market-history/{city}/{date}__{eventId}.json` (resumable; skips files already on disk).
  `fidelity` is MINUTES (1 ≈ per-minute, ~3000 pts/bucket over a 2–3-day market life).
- `flatten-market-history.ts` — collapses the per-event JSON into ONE tidy long-format
  `out/market-history-flat.csv.gz` (one row per price point; streaming + backpressure-aware, so
  the ~247M-row full set never lands in RAM). Columns:
  `city,target_date,event_id,end_ts,bucket_idx,label,resolved_outcome,t,p` (`end_ts` = resolution
  epoch → `secs_to_resolution = end_ts − t`; `t` = point epoch s; `p` = implied prob of this
  bucket's YES). UTF-8 (Node default; `label` carries `°F`).
- `csv-to-parquet.py` — converts that csv.gz → Parquet for repeated analysis / model training.
  Parquet wins when ONE large file is read MANY times: columnar (a pass reads only the columns it
  needs), per-column compression + dictionary encoding, and row-group / predicate pushdown
  (`filter city='london'` skips other cities' bytes). A `.csv.gz` must be fully re-decompressed +
  re-parsed every pass. Bounded-memory (streams chunks → `ParquetWriter`); `--partition city`
  writes a Hive dataset (`city=london/…`, auto-detected by DuckDB/Polars/Spark/pyarrow);
  `--p32` stores `p` as float32 (half that column, ML-feature precision).
- **The parquet engine** is `pyarrow` (the backend pandas' `read_parquet`/`to_parquet` require;
  also the Polars/DuckDB interop layer + `pyarrow.dataset` out-of-core reads). Installed on the
  dev box (`pyarrow 24.0.0`, Python 3.13) via `python -m pip install pyarrow`. The TS scripts have
  no parquet dep — conversion + analysis are Python-side, by design.

## Open-Meteo (free tier; paid key switches to `customer-` hosts)

- Forecast: `api.open-meteo.com/v1/forecast?…&daily=temperature_2m_max&timezone=auto&models=…`
  (`parseMultiModelDaily`).
- Previous runs: `previous-runs-api.open-meteo.com/v1/forecast?…&hourly=temperature_2m_previous_dayN…`
  (`parsePreviousRunsHourly`; <20-hourly-point days dropped).
  **THE SUFFIX QUIRK (live-verified):** single-model requests DROP the
  `_{model}` suffix on series keys — the bare key is accepted only when
  exactly one model was requested.
- Ensemble: `ensemble-api.open-meteo.com/v1/ensemble?…` — ONE model per call
  (I2); bare `temperature_2m_max` = control (member 0), `…_memberNN` perturbed.
- ERA5: `archive-api.open-meteo.com/v1/archive?…` (`parseEra5Daily`, cross-check only).
- Model meta: `api.open-meteo.com/data/{DIR}/static/meta.json` →
  `last_run_initialisation_time` (epoch s). **Directories use real-model
  names, not API slugs** (live-verified 2026-06-11): gfs_seamless→ncep_gfs013,
  icon_seamless→dwd_icon, jma_seamless→jma_gsm, gem_seamless→cmc_gem_gdps,
  meteofrance_seamless→meteofrance_arpege_world025,
  ukmo_seamless→ukmo_global_deterministic_10km; ecmwf_ifs025 and
  cma_grapes_global are themselves; best_match has no directory.
- Budget: `requestWeight(vars, days)` accounting; free tier ≈ 10k weighted/day
  (backfills run `--budget 8000` and sleep to UTC midnight).
- TRAP MODELS (seeded disabled): kma_seamless, ecmwf_ifs04, gfs025 — accepted
  by the API but empty/stale.

## Weather Underground (resolution source)

- `api.weather.com/v1/location/{ICAO}:9:{CC}/observations/historical.json?apiKey=…&units=e|m&startDate=…&endDate=…`
  — hourly obs; °F cities use units=e (native integers), others units=m.
- **The API key is the 32-hex public frontend key scraped at runtime from any
  wunderground.com history page** (`extractWuApiKey`; cached in config with
  7d TTL; 401 → forced refresh + one retry; refresh failure → CRITICAL WU_KEY).
- Truth = `wuDailyMax` over the local day (≥6 obs else sparse → IEM fallback).

## aviationweather.gov (intraday METAR replica)

- `GET aviationweather.gov/api/data/metar?ids={ICAO}&format=json&hours=72`
  (`parseMetarJson`) — no deep archive (~3 days), so cross-fill only near now.
  Running max drives the nowcast constraint (`metarRunningMax`, `metarMaxToNative`
  — the live-verified KORD 30.6°C→87°F case).

## Synoptic Data (US sub-hourly nowcast lane — 0118, 2026-07-25)

- `GET api.synopticdata.com/v2/stations/timeseries?stid={ICAO,…}&recent=45&vars=air_temp&units=metric&hfmetars=1&token=…`
  (`parseSynopticTimeseries` → the SAME `MetarOb` shape as `parseMetarJson`, °C with tenths —
  `metarRunningMax`/`metarMaxToNative` reused verbatim). Cadence probed live: **median 5.0 min**
  on KORD/KHOU (the hfmetars 5-min variant; HF-ASOS 1-min restored via Synoptic's new NWS/FAA
  link Jan-2026).
- **Tier (open access, probed 2026-07-25): US stations ONLY** — EGLL/CYYZ/LTAC/WSSS all return
  "no access" (RESPONSE_CODE 2 = a valid EMPTY parse, not an error). A paid tier upgrade lights
  the intl cities with ZERO code change; `stationsReturned` in the tick stats is the gauge
  (currently 10 of ~29 polled).
- **⚠ ACCOUNT REALITY (corrected 2026-07-25): this is a 14-DAY TRIAL, not a free tier.** The
  account was created 2026-07-25 → trial ends **~2026-08-08**. Current synopticdata.com pricing:
  commercial = contact-sales only (no self-serve price); their "Open Access" program is
  US-academic-.edu-only (we don't qualify). The "5,000 req + 5M SU/month free tier" cited at
  build time was a stale docs-page claim — treat it as trial-period budget discipline only
  (the lane spends ≤96 req/day ≈ 1 batched call/tick on the `5,19,35,49` cron).
  **At expiry:** expect 401/RESPONSE_CODE-2 → the tick starts erroring/empty; the play is
  `select cron.unschedule('synoptic-nowcast');` (rollback header in 0118) unless the operator
  has negotiated pricing. Everything else keeps working — metar-nowcast never stopped covering
  all stations at 30-min. The 14 days of 5-min `synoptic_obs` remain a research corpus
  (sensor-peak vs WU-print). Free fallback for freshness: restore metar-nowcast to */15
  (it was shed to 30-min by C15 compute-shed, not by necessity); the truly-5-min US feed has
  no free real-time replacement (IEM 1-min is 18–36h delayed; NWS/aviationweather is
  hourly+SPECI).
- Auth: `SYNOPTIC_PUBLIC_TOKEN` (Edge secret + `.env.local`). The PRIVATE key only manages
  tokens account-side — the lane never uses it. The token is never printed or logged (handler
  redacts thrown errors; `fetchJson` errors carry the hostname only).
- Writes: `upsert_intraday` — the SAME monotonic advance as metar-nowcast, so the 0111
  dead-bucket floor + §6.16 nowcast rebuilds get sub-hourly freshness for free — plus
  `synoptic_obs` raw log (14d in-RPC retention) for sensor-peak-vs-WU-print research.
- Verified live on the first prod tick (2026-07-25 17:57Z): 10 US stations, 76 obs logged,
  **8 intraday maxes advanced, 7 nowcasts rebuilt**. Smoke: `scripts/research/synoptic-smoke.ts`
  (+ `synoptic-probe-intl.ts`); secret sync: `scripts/ops/synoptic-set-secret.ts` (never echoes).

## IEM (Iowa Environmental Mesonet — WU fallback)

- `GET mesonet.agron.iastate.edu/api/1/daily.json?station={ID}&network={NET}&date=…`
  (`parseIemDaily` → max_tmpf). Networks: US = `{ST}_ASOS` (needs us_state),
  international = country conventions (`iemNetworkFor`). Provenance recorded
  as `iem_fallback` (§7.7).

## External comparison sources (WeatherAPI + OpenWeatherMap) — tracked separate

Aggregator forecasts pulled purely to BENCHMARK accuracy vs the Open-Meteo
models; stored in `source_forecasts` (NOT `forecast_snapshots`/`models`), so they
never touch the trading blend or run-calibration. Scored against the same WU/IEM
truth by `source_accuracy()` / `scripts/check-source-accuracy.ts`.

- **OpenWeatherMap — DONE.** `GET api.openweathermap.org/data/2.5/forecast?lat=…&lon=…&appid=…&units=metric`
  → `list[].main.temp_max` at 3-hourly steps (`dt` UTC epoch). `parseOwmDailyMax`
  groups by station-LOCAL day and emits the max, but ONLY for days that sample
  the afternoon peak window (local hour 12–17) so partial first/last days don't
  understate the max. Free tier: 5-day/3-hour. Key = `OPENWEATHERMAP_API_KEY`
  (new keys take ~1–2 h to activate — 401 "Invalid API key" until then). Ground
  truth: `research/openweathermap_forecast_{RKSI,KORD}.json`.
- **WeatherAPI.com — PENDING (key invalid).** `GET api.weatherapi.com/v1/forecast.json?key=…&q={lat},{lon}&days=3`
  → `forecast.forecastday[].day.maxtemp_c` (daily max already in local tz). Free
  tier: 3-day. Key = `WEATHERAPI_API_KEY`. The live key returns 401 code 2006
  "invalid" (account/key not active); per the fixtures-are-ground-truth rule the
  parser + wiring land once `scripts/_capture-aux` (keys never printed) records a
  real response. `liveSources()` in `snapshot-source-forecasts.ts` is the seam —
  one block to add when the key works.
- The storage + comparison rails (`source_forecasts`, `source_accuracy`,
  `scripts/check-source-accuracy.ts`) and the `snapshot-source-forecasts` job are
  done and tested; OpenWeatherMap flows end-to-end. Live seeding waits only on
  migration 0025 being applied to the hosted DB.

## Slack (alerts, ADR-11)

- Incoming webhook; delivery counted ONLY on HTTP 2xx; a failed post never
  consumes the dedupe key; health-monitor re-sends unsent rows; BET_REC also
  records `bets.audit.slack_delivered`.

## Forecast-enriched odds archive (2026-06-30)

The flattened Polymarket-odds archive (`out/market-history-flat.csv.gz`) can be **joined to our weather
predictions** at three horizons — **2 days prior, 1 day prior, day-of**:

- **`build-forecast-lookup.ts`** → `out/forecast-by-event.csv` — per event (keyed by the Gamma `event_id`): the
  predicted Tmax in the market's **native unit** at lead 2 / 1 / 0, two views — `pred_c_l*` (the CALIBRATED house
  blend: Σ weight·(tmax−bias)/Σ weight over the models, `model_stats` latest) and `pred_raw_l*` (the RAW
  multi-model mean — the consumer-app / WU-Google Schelling proxy) — plus `pred_bucket_l*` (the market bucket the
  calibrated prediction lands in). Forecast coverage is the DB-tracked, **≥2026-04-01** subset (~2 134 of 6 275
  events; older/untracked events get blanks).
- **`enrich-market-history.ts`** → `out/market-history-flat-enriched.csv.gz` — broadcasts those columns onto
  **every price-point row** by `event_id` (238 M rows, ~33 % carry a forecast). Re-run `csv-to-parquet.py` (now
  header-driven — handles the extra columns) for the Parquet.
- Predicted temperatures are the **debiased weighted ensemble** ("blend"); the per-city best SINGLE model (vs the
  WU-resolved truth) was `best_match` / `icon_seamless` (see the session notes). Join key is `event_id`, NOT the
  archive's `target_date` column (that is the RESOLUTION date; the forecast uses the DB station-local weather day).
