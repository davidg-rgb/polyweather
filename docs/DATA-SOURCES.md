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
- `GET clob.polymarket.com/prices-history?market=…&interval=max&fidelity=10`
  → `{history: [{t: epoch_seconds, p}]}` (`parsePricesHistory`). Old markets
  may serve an empty history. `fidelity` is the resolution in MINUTES (min 1);
  `p` is a **single price (implied prob) per bucket — NO bid/ask or depth**. Rate
  limits: book 1500/10s, prices-history 1000/10s.

### Historical reconstruction (`scripts/backfill-market-history.ts`)
- Enumerate via Gamma `events?tag_id=104596&closed=true` (paginate). Each closed
  event → 11 bucket YES tokens → `prices-history?interval=max`.
- **How far back (VERIFIED live 2026-06-30):** the `closed=true` list floors at
  **~2025-12-30** (atlanta/dallas/nyc the earliest, via `order=endDate&ascending=true`;
  51 cities, the original 8 at Dec-2025, the rest added Feb–Apr 2026). Gamma **422s past
  offset ~2100** (a hard pagination-depth cap), so page ASCENDING (offset 0 = the floor).
  `--earliest-scan` does exactly this — ascending pages, caps gracefully, prints
  earliest/latest/count PER CITY + a caveat when the cap is hit. (Because the ascending
  sweep is cut at the offset cap, the `latest`/`count` columns are truncated at the cap,
  not the true latest — only `earliest`, the floor, is authoritative.)
- **Deeper history via `series_id` (VERIFIED live 2026-06-30):** Gamma `archived`s
  events older than the closed-list window OUT of the `closed=true` list, but the per-city
  series reaches them: `GET /series?slug={city}-daily-weather` → `{id}` (e.g. london→10006,
  nyc→10005, atlanta→10739), then `GET /events?series_id={id}&order=endDate&ascending=true`
  paginates the FULL history with **no archival wall** — London goes back to **2025-01-22**
  (~2.5× the closed-list depth). Two structural caveats on the old events: they carry **7
  buckets, not 11**, and **yearless slugs** (`highest-temperature-in-london-on-jan-22`) —
  the latter is rejected by the ingestion's year-anchored city regex, so reaching this depth
  needs a relaxed regex + a `series_id` enumeration source (the date-window params
  `end_date_min/max` are a dead end — return n=0). The bucket-count is already variable in
  ingestion. NOTE: pre-system dates have NO historical forecasts, so the forecast-vs-market
  backtest can't run on them; the value is the standalone implied-prob archive (convergence
  / efficiency study of the price path).
- **Granularity:** daily-temp markets live ~2–3 days, so `interval=max` at
  `fidelity=1` reconstructs the full minute path per bucket. Default backfill keeps
  only the daily last-point + the lead-1/0 consensus cutoffs (C2 no-look-ahead);
  `--full-series [--fidelity N]` persists the COMPLETE per-bucket series →
  `market_price_history` (0072) — a dedicated APPEND-ONLY archive, NOT
  `market_snapshots` (which `ops_downsample` thins to 1/day past 30 days). Note:
  point density = trading activity (thin markets / tails are sparse), and `p` is a
  single price, not executable odds — true bid/ask/depth exists only in the forward
  live captures (`market_snapshots` poll / `opening_captures`).

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
