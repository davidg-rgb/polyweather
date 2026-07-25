# Mirroring Weather Underground for Polymarket Temperature Markets

**Status:** verified empirically 25 Jul 2026
**Conclusion:** WU's resolution pages are a re-render of the raw METAR/SPECI stream.
They are reproducible bit-for-bit from NOAA's free Aviation Weather Center API.
No paid weather API is required or preferable.

---

## 1. TL;DR

| | |
|---|---|
| Primary feed | `https://aviationweather.gov/data/cache/metars.cache.csv.gz` (all world METARs, refreshed 1×/min, no key) |
| Per-station feed | `https://aviationweather.gov/api/data/metar?ids=KHOU,KLGA&format=json&hours=2` |
| US leading indicator | `https://api.weather.gov/stations/{ICAO}/observations` (5-min obs, whole °C, US only, needs `User-Agent`) |
| Backtest / audit | Iowa State IEM ASOS archive (`mesonet.agron.iastate.edu/cgi-bin/request/asos.py`) |
| Measured latency | ~2–6 min from METAR issuance; equal to or faster than WU's own page |
| Cost | $0 |

---

## 2. What Polymarket actually resolves on

Each market resolves to the **highest (or lowest) temperature appearing in the
Daily Observations table of one specific ICAO airport station** on WU, in whole
degrees, bounded by the **station's local calendar day**.

Rules text confirmed via the Gamma API, e.g.:

    GET https://gamma-api.polymarket.com/events?tag_slug=daily-temperature&closed=false&limit=400
    → events[].description contains the exact resolution URL and stated precision

Key facts extracted from the rules:

- Resolution source is a single station page, e.g. `wunderground.com/history/daily/us/tx/houston/KHOU`
- Precision is **whole °F** for US cities, **whole °C** for everything else
- "highest temperature recorded **for all times on this day**" → includes SPECIs, not just hourly METARs
- Markets cannot resolve until the first datapoint of the following day is published
- **Revisions are honoured until that first next-day datapoint**, after which alterations are ignored
- Station choices are frequently *not* the canonical city station: NYC = **KLGA** (not Central Park),
  Houston = **KHOU** (not IAH), Denver = **KBKF** (Buckley SFB), Paris = **LFPB** (Le Bourget),
  London = **EGLC** (City Airport)

---

## 3. The equivalence proof

### 3.1 Row-for-row identity with the METAR stream

KHOU, 23 Jul 2026 — WU's table had **39 rows**; the METAR+SPECI stream had **39 reports**,
matching one-to-one, including all 15 off-hour SPECIs (09:04, 10:20, 13:06, 15:57, 16:10,
16:20, 16:42, 16:43, 17:24, 17:50, 18:22, 18:47, 19:42, 20:21, 20:39 local).

Same test on KLGA 23 Jul (24 rows, no SPECIs) and EGLC 24 Jul (48 rows, half-hourly
`:20`/`:50` reports) — exact match in both cases.

### 3.2 The rounding rule (this is the part everyone gets wrong)

WU does **not** convert the METAR's whole-degree temperature group. It uses the
tenths-precision value from the `Txxxxxxxx` remark group, then rounds once:

```
value_F = round(T_group_tenths_C * 9/5 + 32)
value_C = round(T_group_tenths_C)              # international, where T-group is absent
                                               # → falls back to the whole-degree group
```

Evidence — KHOU 22 Jul 2026, all 26 observations. WU matched `from_tenths` on
**26/26** rows, including 9 rows where the naive whole-degree conversion is wrong:

| Local | METAR groups | tenths °C | from tenths | from whole group | WU showed |
|---|---|---|---|---|---|
| 00:53 | `28/24 … T02830` | 28.3 | **83** | 82 | **83** ✓ |
| 05:53 | `27/24 … T02670` | 26.7 | **80** | 81 | **80** ✓ |
| 08:53 | `29/24 … T02940` | 29.4 | **85** | 84 | **85** ✓ |
| 10:53 | `33/24 … T03330` | 33.3 | **92** | 91 | **92** ✓ |
| 18:53 | `38/24 … T03830` | 38.3 | **101** | 100 | **101** ✓ |
| 22:53 | `31/24 … T03060` | 30.6 | **87** | 88 | **87** ✓ |

Fallback case verified: the KHOU `232250Z` SPECI carries no T-group; WU rendered
`26/26` as **79 °F** = `round(26 × 9/5 + 32)` = `round(78.8)`.

International check (EGLC 24 Jul, no T-groups anywhere): `21 °C → 70 °F`,
`28 °C → 82 °F`, `27 °C → 81 °F` — all `round(c × 9/5 + 32)`. The °C↔°F
round-trip is stable across 20–35 °C, so a °C market equals the METAR whole-degree
group directly.

### 3.3 Daily max = max of the table

- KHOU 22 Jul: WU high `102 °F` = max of obs (16:53 & 17:53). Not the `10383` 6-hourly max group.
- KHOU 23 Jul: WU high `90 °F` = the 00:53 ob.
- KLGA 23 Jul: WU high `27 °C` = the 14:51 ob (27.2 °C).

**Do not use the METAR 6-hour max/min groups (`1xxxx`/`2xxxx`).** WU ignores them, and
they can exceed the observed max.

### 3.4 Day boundary is station-local

EGLC's `00:20` local row is the previous UTC day's `232320Z` report (BST = UTC+1).
KHOU's `00:53` local row is `230553Z` (CDT = UTC−5). Bucket by
`obs_time.astimezone(station_tz).date()`.

### 3.5 Live cross-check

At 17:30 UTC, AWC reported KHOU `temp = 31.7` for the 16:53Z observation.
`round(31.7 × 9/5 + 32) = 89`. WU's page showed `11:53 AM = 89 °F`, daily high `89 °F`. ✓

---

## 4. Source comparison

| Source | Coverage | Precision | Measured latency | Key | Verdict |
|---|---|---|---|---|---|
| **AWC METAR API / cache** | Worldwide, all market stations incl. KBKF | tenths °C (US), whole °C (intl) — identical to WU | ~2–6 min | none | **Primary** |
| api.weather.gov | US only (EGLC, LTFM → 404) | 5-min obs but **whole °C** | 14–19 min | none, needs UA | Leading indicator only |
| IEM ASOS archive | Worldwide ICAO | `tmpf` already matches WU exactly | archive | none | Backtest / audit |
| IEM 1-minute ASOS | US | tenths °F | **~5 days behind** | none | Research only |
| Synoptic Data | Global mesonet, low latency | full | n/a | paid | Optional redundancy |
| The Weather Company (WU's own backend) | — | identical by definition | n/a | enterprise | Unnecessary |
| CheckWX | Worldwide | ⚠ decoded temp uses **whole-degree group** | n/a | free tier 200/day | Only if parsing `raw_text` |
| OpenWeatherMap / Open-Meteo / Tomorrow.io | grid/model | interpolated, not