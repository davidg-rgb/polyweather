# CITY-ORACLE-BUILDOUT-HANDOFF — builds 1→2→3 on the resolution-oracle data layer

> **For a fresh context window (operator-directed 2026-07-25: "prepare handoff, /clear, build 1>2>3").**
> Self-contained: read this + the two reference docs and build. **This is ANALYTICS-PRODUCT work — no
> trading, no new signal tests, no §13 reopen.** The twelve-signal verdict stands (`FINDINGS.md`); the
> kill-fade died at deep-history scale the same day this was written (`OBS-TRANSMISSION.md` §Pass 3);
> price-only angles are closed. Do NOT let any of these builds drift into edge-hunting.

## Context in three sentences

On 2026-07-25 the resolution oracle was decoded and validated: Polymarket temp markets resolve on WU's
Daily Observations table, which is a bit-for-bit re-render of the disseminated **METAR/SPECI stream**
(`docs/DATA-SOURCES.md` §resolution-oracle — the rendering rule, day boundary, revision rule; validated
**66/66** on July US days and **96.2%** over 2,161 deep-history events via `oracle-replica-validation.py`
and `metar-kill-replay.py`). That gives us free, permanent access to the **historical resolution-state
path** for all 45 cities (IEM `asos.py`, decades deep). These three builds convert that into product
value.

## Data assets already on disk (do not re-pull blindly)

| Asset | Where | State |
|---|---|---|
| IEM METAR/SPECI archive | `scripts/research/out/iem-asos-archive/{ICAO}.ndjson` | 45 stations × 90d (2026-04-26..07-25), 109,954 rows; rows = `[valid_utc "YYYY-MM-DD HH:MM", tmpf, tmpc]`, report_type 3+4 only, merge-idempotent |
| Backfill tool | `scripts/research/iem-backfill.py` | `--days N` / `--start --end`; one ranged request per station, 1.5s sleep |
| City→station map | `scripts/research/city-map.json` | slug → [icao, tz, unit, cc, us_state]; DB export 2026-07-25, matches live `city_stations` |
| Replay/validation tools | `metar-kill-replay.py`, `oracle-replica-validation.py` | rendering + kill logic to copy (wu_round, `rendered()`, local-day bucketing) |
| Synoptic 5-min corpus | `out/synoptic-obs-archive/` + `synoptic_obs` table | US-only, 07-19→~08-08 (trial dies then); leading-indicator grade ONLY |
| Price archive | `out/market-history/{city}/` | 522d trade prints; mid-basis (trap #1/#8), freshness-filter mandatory |

**The law (memorize):** only METAR/SPECI-grade data is resolution-grade. 5-min obs overshoot the
table max on ~42% of days. IEM archives *corrected* METARs (live-publication stream is not
reconstructible — a look-ahead channel for anything sub-hour; irrelevant for daily climatology).
METAR valid-time precedes publication by 2–6 min. Rendering: °F = `wu_round(tmpf)`; °C =
`wu_round(tmpc)` (fallback `(tmpf−32)×5/9`). Divergence hotspots: shenzhen (16), seoul (7) — IEM≠WU.

---

## BUILD 1 — per-city floor-formation climatology + best-time panel (the flagship)

**What:** generalize the Amsterdam peak-hour model (`AMSTERDAM-SIM.md` §6) to all 45 cities from
multi-year IEM history: per city × month-of-year, when is the daily max effectively decided?

**Steps:**
1. Extend the backfill window: `python scripts/research/iem-backfill.py --start 2021-01-01 --end 2026-07-25`
   — but do it **per-year per-station** (edit or wrap: one request per station-year, keep the 1.5s
   sleep; ~250 requests, ~10 min). Some intl stations will be thin/gappy in early years — record
   per-station coverage, don't fail on gaps. Disk estimate ≲ 1 GB NDJSON (gitignored `out/`).
2. Climatology computation (new `scripts/research/city-climatology.py` or `.ts` mirroring
   `scripts/research/amsterdam-peak-hour.ts`): per city × month, from each local day's rendered-row
   series compute the **floor-confidence curve** — P(running max at local hour h == the day's final
   max) for h in 0..23 — plus the median/p10/p90 "decided hour". Amsterdam's asset
   (`packages/core/src/sim/amsterdam-climatology.ts`, regenerated via `--emit`) is the exact shape
   precedent: **committed static TS asset, NO migration, computed server-side.**
3. Emit `packages/core/src/sim/city-climatology.ts` (45 cities × 12 months; keep it small — the
   hourly curve as compact arrays). Pure functions + tests (pin a couple of hand-checked city-months).
4. Surface: extend the `/cities` page with a per-city "when is the day decided" strip (or a
   `/climatology` view) — follow the `/amsterdam` PeakHourChart component precedent. Server-side
   compute from the static asset; no DB change, no cron.

**Acceptance:** asset committed + regenerable by one command; ≥3 years coverage for ≥40 cities
(report the thin ones); page renders for all cities; suite + typecheck green.

## BUILD 2 — WU-independent truth cross-check + per-city resolution-risk metric

**What:** grade the replica against our stored WU truth and make "resolution trustworthiness" a
per-city number.

**Steps:**
1. Locate the stored truth: the `obs` table (finalized WU daily maxes, `wuDailyMax`, provenance
   per §7.7 — check `docs/DATA-SOURCES.md` + `packages/core/src/weather/wu.ts`). Pull 90d per city.
2. New `scripts/research/truth-replica-crosscheck.py`: per city-day, replica max (from
   `out/iem-asos-archive/`, the `metar-kill-replay.py` rendering) vs stored WU value → per-city
   match rate, off-by distribution, direction. Expect ≈100% US/EU; quantify shenzhen/seoul.
3. The metric: **resolution-risk = 1 − match rate** (90d rolling). Record per city in the handoff
   doc output + a compact committed JSON (`scripts/research/out/` for the panel; if surfacing on a
   dashboard, follow the write-time-fold law — no heavy jsonb at read time).
4. Surface (small): a column on `/cities` or a `/data` note ("resolution replica agreement: N%").
   **Do NOT change the grading path** — ADR-04: WU integers are never re-derived in grading. Any
   promotion of the replica into actual grading (e.g. as the IEM-daily fallback replacement) is a
   design change: write the proposal in the doc, leave it operator-gated.

**Acceptance:** per-city 90d agreement table produced + committed in a doc/JSON; divergence hotspots
quantified with direction (who reads higher); dashboards optionally updated; grading untouched.

## BUILD 3 — intraday convergence scoring (ours vs market, hour by hour)

**What:** with the resolution path known, score WHEN forecasts lock in: hour-by-hour Brier of our
distribution vs the eventual winner, against the market's hour-by-hour implied Brier.

**Steps:**
0. **Data check first** (this build's risk): intraday distribution history. `forecast_snapshots` /
   `bucket_probabilities` hold 10Z/22Z builds (live since ~06-13) + nowcast rebuilds — verify what
   per-hour granularity actually exists and for what window (see the regime-conditional-efficiency
   memory: backfill slot is frozen 06-15; live 10Z/22Z are the operational slots). If intraday
   nowcast history is thin, scope to: our 10Z/22Z builds scored at their build times + the floor's
   evolution from the IEM path, vs the market's hourly mid (freshness-filtered, ghost-quote law).
1. `scripts/research/intraday-convergence.py`: per city-day (start with the ~45d live-slot window),
   at each hour h: our latest-available distribution's Brier vs winner; market's Brier from
   normalized bucket mids (mid-basis caveat printed); the floor-certainty baseline (probability
   implied by the running max alone — buckets under the floor are 0). Output: per-city convergence
   curves — "our lock-in hour" vs "market lock-in hour" vs "floor lock-in hour".
2. Surface: this is the analytics money-shot for `/data` — an "intraday convergence" section
   (ours-vs-market by hour). Follow `/data`'s RPC pattern (`DATA.md`, migration 0065 precedent) —
   but ship the research read FIRST as a committed doc; the dashboard fold is a second step and can
   be deferred if the Micro budget is tight (pg_cron minute-lane + write-time-fold laws apply).

**Acceptance:** the research read exists as a doc with per-city curves + the three lock-in hours;
honest data-window statement; dashboard fold either shipped or explicitly deferred with reason.

## Stretch (only if 1–3 land clean): resolution-noise smearing test

Pre-registered forecast test (the ONE legitimate new lever from this data): add a per-city
resolution-noise term (from Build 2's divergence rates) to bucketization for high-divergence cities;
OOS Brier must improve there and not degrade elsewhere. Pre-register cutoffs before running;
day-clustered CI; this is a FORECAST-quality test, not a trading test.

## Standing guards (all of them apply)

Suite (`pnpm test`) + `pnpm typecheck` green after every change · unsigned label regex + slug-day
trap (`targetDate` = resolution day) · ghost-quote freshness filter on any price read · mid-basis
verdicts capped (law) · day-clustered CIs, constant-outcome flag · storage discipline (bulk stays
LOCAL in gitignored `out/`; DB gets only what live pages need; write-time folds for heavy jsonb;
minute-lane check against LIVE `cron.job` for any new cron) · boundary: no trading, no credentials,
live lane untouched (mode live, override → 07-31, allowlist is the operator's).

## Rota context for the fresh session (don't lose these)

- **Loop:** branch `loop/2026-07-10-edge-watch`; wakeups were DISARMED for this /clear — after the
  build (or between builds), run the v18 Cycle rota (`docs/ops/EDGE-WATCH-LOOP.md`) and re-arm
  self-paced wakeups (quiet ~60 min).
- **Daily while the Synoptic trial lives (ends ~08-08):** `pnpm tsx scripts/research/synoptic-history-pull.ts`
  (idempotent, ~6 req) — rota 6b.
- **08-06:** OBS-TRANSMISSION re-adjudication on the corrected design — prior firmly negative
  (§Pass 3); it needs ≥40 real-book trades + wholly-positive clustered CI to be surfaced at all.
- **Operator's one live click:** gate-override renewal expires **07-31 00:00Z** (re-surface from ~07-28).
