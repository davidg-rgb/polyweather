# CITY-SIM — the multi-city paper-trade (the Amsterdam sim, generalized)

> **What it is.** The [Amsterdam paper-trade](AMSTERDAM-SIM.md) for **N operator-chosen cities** — a live,
> falsifiable score of our daily-high nowcast against the real Polymarket market. Every day, for each active
> city, we place a fixed-stake (**$10**) YES bet on our model's predicted whole-°C bucket at several intraday
> **lock hours (arms)**, record the **in-lock-hour market odds**, and once the day resolves to the station's
> daily high we log **win/loss + net P&L**. The arms race; the dashboard shows whose cumulative sum is
> highest, per city. **Goal (operator, 2026-06-29): MEASURE whether a systematic everyday bet on our forecast
> nets a profit** — by the end of a long-running test.
>
> **It is NOT trading.** The live-trading thesis is closed (`FINDINGS.md`; the market is efficient). This is
> the analytics-pivot deliverable — model-vs-market insight made tangible. The trading machinery
> (`packages/trading`, `bets`, the opening-convergence bot) is untouched.

## 1. The cities — and why these two

The operator asked for "the two markets where we have the best odds of success." The selection is **data-driven**
(session 2026-06-29), from the system's own calibration record (`calibration_scores`, lead-0, 30-day window —
lower Brier = more accurate; positive edge = we beat the market's Brier) and the intraday peak-timing
(`intraday_advances`):

| City | ICAO | Our Brier | Edge vs market | Peak hour (local) | Arms raced |
|---|---|---|---|---|---|
| **Singapore** | WSSS | 0.642 | **+0.027** (we edge it) | ~12:30 | 10 / 11 / 12 / 13 / 14 / 15 |
| **Karachi**   | OPKC | **0.619** (2nd-most accurate) | −0.045 (market sharper) | ~12:24 | 10 / 11 / 12 / 13 / 14 / 15 |

Both are among the most forecast-accurate **°C** cities with a **liquid** Polymarket daily-high market (≈16k
order-book snapshots / 14 days each — verified). Both are **tropical, early-peaking** stations: the running-max
floor is locked by ~13:00 local, so unlike Amsterdam (peak ~13:45, arms 13–16) they race the **morning-through-
mid-afternoon** window — bracketing the real peak on **both sides** so the entry-time watcher (§6) can find the
optimum from data, not a guess. (They originally raced only 11–14; the race was widened to **10–15** in migration
`0071` once the watcher made "which hour is actually best" answerable — see §6.)

> **Honest caveat.** Under the efficiency prior the curves are expected to hug $0 net of fees. Singapore is the
> stronger net-profit shot (we edge the market's Brier); **Karachi is the most *accurate* but the market reads
> it slightly better than we do**, so net profit there is the longer shot. The whole point is to *measure* it.
> A third city (Madrid was the data's net-profit standout — Brier 0.467, edge +0.13, late-peaking → arms 14–17)
> is a one-row add (see §4) if the operator wants it.

## 2. Architecture (one engine, N cities by config)

This is a **new parallel system** that leaves the Amsterdam sim (`0039`–`0052`, KNMI-truth + 20-yr climatology
— EHAM-only) untouched. The P&L math + place/grade **decisions** still live once in
`packages/core/src/sim/amsterdam.ts` (`planPlacements`/`planSettlements` — already city-agnostic; this work
added only a configurable `forecastMaxHour` to `nowcastBasisC`/`PlaceInputs`, default 14 so Amsterdam is
unchanged).

```
packages/core/src/sim/amsterdam.ts          the ENGINE (shared with Amsterdam). nowcastBasisC now takes a
                                            per-city forecastMaxHour (the latest arm the forecast lift helps).

supabase/migrations/0070_city_paper_sim.sql
  city_sim_config            which cities run: (city_id, slug, icao, tz, arm_hours[], forecast_max_hour,
                             stake_usd, active). Operator-editable — a new city is one INSERT, no deploy.
  city_paper_bets            one row per (city_id, target_date, arm_hour); unit-general (native °C/°F).
  city_sim_active_configs    the live city list (Edge tick + seed read it).
  city_sim_place_inputs(city, target, now)  reconstructs each due arm: running-max floor (→ native unit) +
                             in-lock-hour ask (the 0048 guard) + bias-corrected lead-1 forecast (the 0041
                             trailing-30 debias) — all per-city via cfg.tz/icao/unit/arm_hours.
  city_sim_record / _grade_inputs / _settle   idempotent place / grade (all cities) / settle.
  dash_city_sim              the operator read (operator_guard + authenticated): per-city head-to-head.
  cron 'city-paper-trade' @ 10:00 UTC

supabase/functions/city-paper-trade   the daily cron tick (loop active cities → place; then one global grade).
scripts/city-sim.ts                   backfill history + grade + print per-city decision table + leaderboard.
apps/web /paper-trade                 the surface: per-city standings, arm leaderboard (hit/edge/EV CIs),
                                      cumulative-P&L EquityChart, latest call, bet log.
```

**Faithfulness (no look-ahead).** Identical to Amsterdam: each arm's running max (`intraday_advances`, by
city-local hour) and odds (`market_snapshots`, timestamped) are *persisted*, and the ask is bound to the
**lock hour window** `[H:00, H+1:00)` in `cfg.tz` — so a bet reconstructed by the 10:00-UTC cron records
exactly the quote a live order at hour H would have hit. The integration test proves the in-hour guard
(a pre-hour / after-hour quote is never forward-filled).

**No KNMI floor-truth lens.** That feed is Amsterdam-only. Market-resolution accuracy (vs
`observations.tmax_wu_native`) is what drives the P&L and answers the net-profit question — that is all this
needs.

## 3. Operate it

```bash
pnpm test         # engine + the full city_sim place→grade→dash integration (supabase/tests/city-sim.test.ts)
pnpm typecheck

# Seed history + see the per-city decision table + leaderboard (idempotent — extends history forward):
pnpm tsx scripts/city-sim.ts                      # all active cities
pnpm tsx scripts/city-sim.ts --city singapore     # one city
pnpm tsx scripts/city-sim.ts --analyze-only       # print only, no writes
pnpm tsx scripts/city-sim.ts --from 2026-05-01 --to 2026-06-29
```

**Go-live (operator/MCP-gated):**
1. Apply `0070_city_paper_sim.sql` **then `0071_convergence_split_and_entry_watch.sql`** to prod
   (`apply_migration` MCP, or `npx supabase db push`). 0071 widens WSSS/OPKC to arms {10..15} (§6) and seeds
   the `bot.consensusSource` ops mirror (§7) — both config/seed-data only, no schema change.
2. Deploy the Edge Function: `npx supabase functions deploy city-paper-trade --use-api --no-verify-jwt`
   (self-authenticates via `x-cron-secret`, like every other job).
3. Seed the curve: `pnpm tsx scripts/city-sim.ts` (then the 10:00-UTC cron carries it forward). With 0071's
   wider arms applied first, this backfills {10,15} history too, so the watcher (§6) has signal on day one.

**Turn it off / pause a city:** `update city_sim_config set active=false where slug='karachi';` (data + dashboard
stay; no new bets). Full stop: `select cron.unschedule('city-paper-trade');`.

## 4. Add a city

One INSERT — pick arm hours that bracket the city's intraday peak (query `intraday_advances` for the
peak-hour distribution first; tropical ≈ 11–14, mid-latitude summer ≈ 13–16, hot/dry late-peakers like Madrid
≈ 14–17), and set `forecast_max_hour` to the latest arm at/below the peak:

```sql
insert into city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active)
select id, 'madrid', 'LEMD', 'Europe/Madrid', array[14,15,16,17]::smallint[], 16, 10, true
from cities where slug = 'madrid';
```

Then `pnpm tsx scripts/city-sim.ts --city madrid` to backfill. **If the new city is later-peaking than the
current cities, move the cron later** than 10:00 UTC (it must fire after every active city's last arm has
passed — e.g. Madrid's 17:00 CEST = 15:00 UTC).

## 5. Honest caveats

- **Efficiency prior.** Expect the curves to hug $0 (minus fees). A sustained climb on any arm is the signal —
  and the hook for evolving the predictor (improve the nowcast, watch this scoreboard move).
- **Fees.** P&L is net of the Polymarket taker fee (stored per bet) — the total is honest, not gross.
- **°C only, today.** The RPC converts the °C running-max/forecast to the city's native unit, so a °F (US)
  city is *correct* if added — but the chosen cities are °C, and the °F path is unexercised on live data.
- **Cron timing is shared.** One 10:00-UTC daily run serves all cities; a later-peaking city needs the
  schedule moved (§4). Tropical early-peakers are well inside the window.

## 6. The entry-time watcher (continuous best-hour finder)

The arm hours were a **pre-data guess** (tropical peak ≈ 12:30 → race around it). The watcher replaces the guess
with a **continuously-updated, data-driven answer**: given each arm's graded ledger it ranks the arms and
recommends the optimal entry hour, recomputed every page load as the fictive-money record grows.

- **Engine:** `packages/core/src/sim/entry-watch.ts` — pure + total (`recommendEntryHour`). It ranks arms by the
  **95% lower bound of the edge** (`edgeCiLo`, where edge = mean(`won − ask`), via `armEdgeStats`), **not** the
  point estimate. Ranking on the lower bound **is the shrinkage**: a thin arm with a lucky +edge has a wide CI
  and a low bound, so it cannot out-rank a deep arm with a smaller-but-tight edge. No separate prior needed — the
  same discipline the §9R-E gate and the dashboard CIs already use.
- **Confidence ladder** (honest about how much to trust the pick):
  - `insufficient` — no arm has ≥ `minGraded` (default **10**) graded bets yet. Surfaces the best point-estimate
    *hint* but says "keep racing."
  - `provisional` — eligible arms exist but the leader isn't yet **credible** (`edgeCiLo > 0`) **and separated**
    (its lower bound beats every other eligible arm's point edge). The best available, not yet a promotion.
  - `sufficient` — credible **and** separated. The cue that an hour has earned promotion.
- **It recommends, it does NOT prune.** While the sim runs on fictive money the right move is to keep racing
  *every* arm (free data) and surface the evolving verdict — never silently drop an arm and lose the comparison.
  The operator narrows the race when `sufficient`; until then all arms keep gathering.
- **Surface:** `/paper-trade` shows, per city, a **"Best entry-time"** tile (recommended hour + confidence
  badge), an **entry-time-watcher verdict** banner (the one-line rationale), and marks the recommended arm in the
  leaderboard with a **⭐** — distinct from the **🥇** P&L leader (max cumulative $, which is noisier). The two
  often disagree early; trust the ⭐.
- **Widened race (migration `0071`):** WSSS/OPKC now race **{10,11,12,13,14,15}** (was 11–14). The watcher can
  only learn about hours we actually bet at, so the day is now bracketed on both sides of the peak. The new arms
  (10, 15) read `insufficient` until they accumulate; a `scripts/city-sim.ts` backfill re-run fills their history
  from persisted intraday/snapshots.

## 7. The convergence/accuracy forecast split (sibling change)

Same operator session (2026-06-29), opposite system. The paper-trade and the **opening-convergence bot** want
*different* forecasts, because they bet on different things:

- **Paper-trade / Amsterdam** bets and **holds to resolution**, scored on the *actual* high → wants the most
  **accurate** forecast: every bias correction, the calibrated center. **Unchanged.**
- **Opening-convergence** buys cheap at the flat open and **sells into the convergence before resolution** → it
  bets on **what the crowd will believe**, i.e. the consensus the marginal trader's weather app shows. A −1°C
  "truth" correction that *wins* the paper-trade *loses* the convergence (it moves us off the crowd's Schelling
  point). So the bot's house seed now centers on the **RAW cross-model consensus** (drop the per-model
  `model_stats` bias; keep weights + sigma), governed by `BotConfig.consensusSource` (default `ensemble_raw`;
  `calibrated` restores the old center; `wunderground` is reserved for the resolution-source anchor).

Implementation: `buildDistributionForEvent`'s new `biasCorrect` flag (default true → byte-identical for every
existing caller), forwarded by `opening-capture/seed.ts` per `consensusSource` (`seedBiasCorrect`). A `'raw'` hash
tag keeps the raw and calibrated dists from colliding for a city that is both bot-seeded and production-scored.
Ops mirror seeded in migration `0071` (`bot.consensusSource`). See `ARCHITECTURE-OPENING-CONVERGENCE.md` F-OC-01.

Companion docs: `AMSTERDAM-SIM.md` (the reference single-city build), `FINDINGS.md` (why trading is closed),
`ARCHITECTURE-OPENING-CONVERGENCE.md` (the convergence bot), `BUILD-STATE.md`, `RUNBOOK.md`.
