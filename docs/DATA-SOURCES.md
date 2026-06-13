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
  may serve an empty history. Rate limits: book 1500/10s, prices-history 1000/10s.

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

- **WeatherAPI.com** — `GET api.weatherapi.com/v1/forecast.json?key=…&q={lat},{lon}&days=3`
  → `forecast.forecastday[].day.maxtemp_c` (daily max already in the location's
  local tz). Free tier: 3-day forecast, 1M calls/mo. Key = `WEATHERAPI_API_KEY`.
- **OpenWeatherMap** — `GET api.openweathermap.org/data/2.5/forecast?lat=…&lon=…&appid=…&units=metric`
  → `list[].main.temp_max` at 3-hourly steps (UTC `dt`); aggregate to a LOCAL-day
  max per station tz. Free tier: 5-day/3-hour. Key = `OPENWEATHERMAP_API_KEY`.
  New keys take ~1–2 h to activate (401 "Invalid API key" until then).
- **PENDING live fixtures (parser-gated):** both keys returned 401 at capture
  time (well-formed but provider-rejected → activation lag). Per the
  fixtures-are-ground-truth rule, `core/weather/weatherapi.ts` +
  `openweathermap.ts` + the `snapshot-source-forecasts` job are built once
  `scripts/_capture-aux` (keys never printed) records real responses. The
  storage + comparison rails (`source_forecasts`, `source_accuracy`,
  `check-source-accuracy`) are done and tested and already rank the Open-Meteo
  sources.

## Slack (alerts, ADR-11)

- Incoming webhook; delivery counted ONLY on HTTP 2xx; a failed post never
  consumes the dedupe key; health-monitor re-sends unsent rows; BET_REC also
  records `bets.audit.slack_delivered`.
