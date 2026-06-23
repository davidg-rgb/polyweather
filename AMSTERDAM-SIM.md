# AMSTERDAM-SIM — the $10/day paper-trade head-to-head

> **What it is.** A live, falsifiable score of our Amsterdam nowcast against the real Polymarket
> market. Every day we place **$10 of fictitious money** on our model's predicted whole-°C bucket for
> EHAM at **four intraday lock hours — 13:00 / 14:00 / 15:00 / 16:00 local** — under identical rules,
> record the **market odds at placement**, and once the day resolves to the Wunderground Schiphol high
> we log **win/loss + net P&L**. The four arms race; the dashboard shows whose cumulative sum is
> highest. The operator's question — *"which hour is the best time to bet, after ~14 days?"* — answers
> itself from the data.
>
> **It is NOT trading.** The live-trading thesis is closed (`FORECASTING-RD.md` WO-5; market efficient).
> This is the analytics-pivot deliverable: **model-vs-market insight value made tangible**. The trading
> machinery (`packages/trading`, `bets`) stays dormant and untouched.

---

## 1. The finding — best time of day

From 14 resolved Amsterdam events with intraday coverage (the exact-bucket hit rate is robust over 182
days; the odds column is dense on only ~4 days so far — the live sim is what accrues `n`):

| Lock hour (local) | exact-bucket hit | market ask on our bucket | read |
|---|---|---|---|
| 13:00 | 50% | ~0.26 | coin-flip on fat odds (~3.8× if right) |
| 14:00 | 64% | ~0.52 | some accuracy, real odds |
| **15:00** | **86%** | **~0.82** | **confident sweet spot** — still a real payout |
| 16:00 | 100% | ~0.98 | near-certain, but the market has priced it (~no payout) |
| 19:00 | 100% | ~0.999 | pointless to bet |

**The structural truth:** the market re-prices our predicted bucket in lockstep with our accuracy — its
ask ≈ our hit rate at every hour (the WO-5 efficiency result, seen again). So the later you wait the
surer you are *and* the less the odds pay; expected value is ~0 at every hour before fees. **15:00 is the
headline operating point** (high confidence, odds still < 1), but the whole point of racing all four
arms forward is to *measure* whether any hour drifts positive — if the curve climbs, we found an edge;
if it hugs $0 (or bleeds via fees), we confirmed efficiency. Either outcome is a result, visualised.

### Predictor upgrade — forecast-aware nowcast (2026-06-17, migrations 0040 + 0041)

The running max is a hard **floor** on the day's high (it can only finish ≥ what's already happened),
but early in the day it under-predicts the peak. So at the **early arms (≤ 14:00)** we now lift the floor
to our own **lead-1 NWP forecast, corrected for its trailing observed bias** —
`basis = max(runningMax, forecast)` → `wuRound`. Late arms (15:00/16:00) keep the pure floor (already
86%/92% exact on the ~180-day raw curve; the forecast only adds noise there). The bias correction is the
mean (actual − forecast) over the **trailing 30 finalized days before the target** (walk-forward, no
look-ahead — the same lead-1 bias `dash_station_predictions` measures; a *trailing* window, not an
all-history mean, because Amsterdam's bias drifts seasonally ≈+0.4 °C spring → +0.83 °C June); **< 20
prior pairs ⇒ no correction**, fall back to the floor. Constants `AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS` /
`_MIN_PAIRS` live in `core/sim/amsterdam.ts` and are mirrored in the `0041` RPC + the backtest.

A **walk-forward backtest** (`scripts/amsterdam-nowcast-backtest.ts`) over **69 post-warmup test days**
(of ~180 finalized EHAM days; only 89 have a lead-1 forecast) measured, with a **McNemar exact test** on
the discordant flips:

| Arm | exact-hit | MAE | within-1°C | significance |
|---|---|---|---|---|
| 13:00 | 42% → **62%** (+20pp) | 0.81 → **0.41** (−50%) | 81% → **97%** | McNemar p = **0.024** ✓ |
| 14:00 | 57% → **65%** (+9pp) | 0.49 → **0.38** | 94% → **97%** | p = 0.33 (directional, not significant) |
| 15:00 / 16:00 | unchanged (hour-gated) | | | n/a |

**Honest read:** 13:00 is a *significant* improvement (n=69, p=0.024) but the evidence is **single-station
(EHAM) and single-season (spring/summer — the forecast record starts 2026-03-20, no autumn/winter data)**;
14:00 is **directional only**. Re-run the backtest and quote what it prints — don't trust a stale literal.
The negative-temperature `wuRound` path (assumption A-11) and the °F→°C branch are **unexercised** on this
dataset; revisit after cold-season pairs accrue.

Under WO-5 efficiency this sharpens **forecast skill** (the analytics deliverable), not necessarily PnL —
the market re-prices the better bucket in lockstep. It makes the model-vs-market scoreboard a fair fight.
The seam is `nowcastBasisC` in `core/sim/amsterdam.ts`; `forecastC = null` reproduces the original floor.

> **Live-leaderboard caveat (mixed regime).** Migrations 0040/0041 change only **future** placements —
> `amsterdam_sim_record` is `on conflict … do nothing`, so the ~5 bets/arm placed pre-0040 keep their old
> pure-floor prediction (`forecast_c = NULL`) and are **not** re-predicted. Because the lift is gated to
> ≤ 14:00, the **13:00/14:00** equity curves splice floor-only history with forecast-aware future, while
> 15:00/16:00 stay pure-floor throughout. It self-heals over ~2 weeks; until then the 13/14 arms are not a
> clean like-for-like vs 15/16. Pre-0040 rows are identifiable by `forecast_c IS NULL`. To make history
> consistent, delete the affected days and re-seed (`nowcastBasisC` reconstructs the call from stored
> runMax + forecast).

## 2. Architecture (one engine, two drivers, one surface)

```
packages/core/src/sim/amsterdam.ts   ← the ENGINE (pure, 20 tests). Single source of truth for:
  predictedNativeC / predictedBucketIdx   wuRound(runningMax) → ladder bucket (= how the market resolves)
  placeSimBet / gradeSimBet               stake/ask → shares ; win→shares·(1−ask), loss→−stake, net of fee
  planPlacements / planSettlements        the place/grade DECISIONS the two drivers share
  AMSTERDAM_SIM_ARM_HOURS = [13,14,15,16] · PRIMARY = 15 · COMPARE_DAYS = 14 · STAKE = $10

supabase/migrations/0039_amsterdam_paper_sim.sql
  amsterdam_paper_bets        one row per (target_date, arm_hour); RLS like every table
  amsterdam_sim_place_inputs  reconstructs each due arm from intraday_advances + market_snapshots
  amsterdam_sim_record        idempotent insert (ON CONFLICT DO NOTHING — odds lock at first placement)
  amsterdam_sim_grade_inputs  pending bets whose EHAM obs finalized + the winner bucket
  amsterdam_sim_settle        writes won/pnl/fee
  dash_amsterdam_sim          the operator read (operator_guard + authenticated)
  cron 'amsterdam-paper-trade' @ 15:30 UTC (= 17:30 local)

supabase/migrations/0043_amsterdam_truth_floor_accuracy.sql   floor "truth accuracy" (see §4)
  amsterdam_truth             the decimal (0.1°C) real daily high from KNMI (Schiphol 240, var TX)
  amsterdam_paper_bets        + actual_decimal_c / truth_won / signed_error_c columns
  amsterdam_truth_upsert      idempotent KNMI writer (backfill + the daily tick share it)
  amsterdam_sim_truth_inputs  bets whose day now has a decimal actual (the engine recomputes)
  amsterdam_sim_truth_record  writes truth_won + signed_error_c (independent of market grading)
  dash_amsterdam_sim          + truth panel (per-arm floor-hit/MAE/bias) + truthByArm
supabase/migrations/0044_amsterdam_inputs_wrap.sql   GRADE/TRUTH-FILL BUG FIX (2026-06-21)
  amsterdam_sim_grade_inputs / amsterdam_sim_truth_inputs now return { rows: [...] }, NOT a top-level
  jsonb array. A bare array is misread by the Edge supabasePort (functions/_shared/db.ts) as a RETURNS
  TABLE row set and passed through unwrapped, so the handler's rows[0]?.<fn> was undefined → the daily
  tick SILENTLY graded 0 bets + filled 0 truth for ~5 days (19 bets stuck pending; reported status ok).
  The PGlite twin wraps every shape via `select * from fn()`, so the integration test masked it. All four
  callers (Edge handler + both scripts) read .rows; db.test.ts + amsterdam-sim.test.ts lock the shape.
supabase/functions/_shared/knmi.ts   the KNMI daggegevens client (shared by the Edge fn + the script)

DRIVER 1 — supabase/functions/amsterdam-paper-trade   the daily cron tick (place + grade + KNMI truth fill)
DRIVER 2 — scripts/amsterdam-sim.ts                   backfill history + print the decision table + leaderboard
DRIVER 3 — scripts/amsterdam-truth-backfill.ts        backfill ~880 KNMI days + fill floor-truth + report

SURFACE  — apps/web /amsterdam   leaderboard cards · cumulative-P&L EquityChart (4 lines) · evidence
           table · FLOOR-TRUTH panel · latest call · bet log.  Loader getAmsterdamSim degrades to null if
           the RPC is absent (truth fields degrade to "—" if migration 0043 is not yet applied).
```

**Why a daily reconstruction is faithful, not look-ahead:** both the running max (`intraday_advances`,
by local hour) and the odds (`market_snapshots`, timestamped, delta-deduped) are *persisted*. An arm's
bet at hour H is built strictly from data with `local_hour ≤ H` and snapshots `captured_at < end-of-H`,
so a bet placed by the 15:30-UTC cron records exactly the odds a live order at hour H would have seen.
The integration test proves this (the forward-fill ignores a poison snapshot printed after the arm hour).

## 3. Operate it

```bash
# Tests (all green): engine + the full place→grade→dash integration + forecast-lift + null-gate
pnpm test            # 721 passing
pnpm typecheck

# Re-run the backtest and quote what it PRINTS (don't trust a stale literal):
pnpm tsx scripts/amsterdam-nowcast-backtest.ts    # per-arm hit/MAE/within-1 + McNemar p

# Best-buy curve (AMSTERDAM-EV-MODEL.md Deliverable 2): edge(t)/EV(t) over the 5-min buy-time grid with CIs.
# Faithful best_ask curve is ~5 days (best_ask only exists since ~June 12); --price mid extends to ~14 days
# (optimistic, non-executable). The live arm h is grid point (h+1):00.
pnpm tsx scripts/amsterdam-best-buy.ts                       # faithful (executable best_ask)
pnpm tsx scripts/amsterdam-best-buy.ts --price mid          # extended mid-history (optimistic upper bound)

# Seed history + see the decision table and leaderboard (idempotent on the unique (date,arm) key — it
# extends history forward; it does NOT re-predict already-placed bets, see the mixed-regime caveat above)
pnpm tsx scripts/amsterdam-sim.ts                 # seed all simulable days + grade + print
pnpm tsx scripts/amsterdam-sim.ts --analyze-only  # print only, no writes
pnpm tsx scripts/amsterdam-sim.ts --from 2026-05-01 --to 2026-06-15

# Floor "truth accuracy" (§4): backfill the KNMI decimal high (~880 days) + fill truth on every bet, then
# print per-arm market-hit vs floor-hit + decimal MAE/bias. Idempotent (the daily tick also refreshes it).
pnpm tsx scripts/amsterdam-truth-backfill.ts                  # fetch KNMI + fill + report
pnpm tsx scripts/amsterdam-truth-backfill.ts --analyze-only  # report only, no fetch/writes
```

**Go-live (operator-gated — hosted DDL/deploys need per-action authorization):**

1. **Apply the migrations** `0039_amsterdam_paper_sim.sql`, then `0040_amsterdam_forecast_nowcast.sql`
   (adds `forecast_c` + rewrites place_inputs/record/dash), then `0041_amsterdam_nowcast_trailing_bias.sql`
   (trailing-window bias) to hosted — **all three are required** for the forecast-aware behaviour
   (`npx supabase db push`, the SQL editor, or authorize the MCP `apply_migration`).
2. **Deploy the Edge Function:**
   `npx supabase functions deploy amsterdam-paper-trade --use-api --no-verify-jwt`
   (the function self-authenticates via `x-cron-secret`, mirroring every other job). Required so the
   bundled `planPlacements` is the forecast-aware one; the bias correction itself lives in the 0040/0041 RPC.
3. **Seed the curve:** `pnpm tsx scripts/amsterdam-sim.ts` (then the 15:30-UTC cron carries it forward).
4. **Floor truth accuracy (§4):** apply `0043_amsterdam_truth_floor_accuracy.sql`, **redeploy** the Edge Function
   (the bundled handler now also fetches KNMI + fills truth each tick), then run
   `pnpm tsx scripts/amsterdam-truth-backfill.ts` to backfill ~880 KNMI days + fill truth on every bet.
   (The Edge Function's truth phase is best-effort — it never breaks the place/grade tick — so deploying it
   ahead of the migration is safe; truth just stays empty until 0043 lands + the backfill runs.)

After that the `/amsterdam` page is live and self-updating. **To turn it off:** `select
cron.unschedule('amsterdam-paper-trade');` — the data and dashboard stay; no new bets are placed.

## 4. Floor "truth accuracy" — vs the real high (KNMI, migration 0043)

The leaderboard scores the **market**: did our whole-°C bucket match how Polymarket resolved — to
Wunderground's *rounded integer* Schiphol high, bucketed on the ladder? That is the number that drives the
paper-trade P&L, and it stays its own number. But WU reports a rounded integer and some buckets are wider
than 1° at the tails, so market `won` is a noisy proxy for forecast skill. The operator directive (2026-06-17)
adds a second, cleaner lens scored against the **real** station high:

```
truth_won      = predicted_native_c == floor(actual_decimal_c)            ← the floor-truth hit
signed_error_c = nowcastBasisC(running_max, arm_hour, forecast_c) − actual_decimal_c   ← decimals, signed
```

- **Source — KNMI, not WU.** `actual_decimal_c` is the day's max at **0.1°C** from the Dutch met office's free
  daggegevens API (station **240 = Schiphol/EHAM**, variable **TX**; no auth, no key). Verified
  **2024-01-01 → with 897 consecutive days, zero gaps, zero nulls**. It lands ~1–2 days after the day (same as
  WU finalization). CheckWX was ruled out (whole-degree, no history); NOAA ISD SYNOP (062400) was the
  fallback, unneeded since KNMI is cleaner (official daily max, decimal, gap-free).
- **A new reference table** `amsterdam_truth (date_local, tx_tenths_c, source)` holds the decimal high
  independently of whether we have an `observations` row, so the full ~880-day history is available to the
  backtest, not just the dates we placed bets. Backfilled by `scripts/amsterdam-truth-backfill.ts`; refreshed
  for the last ~6 days each cron tick by the Edge Function (best-effort — a KNMI hiccup never breaks the tick).
- **Truth is independent of market grading.** A bet's `truth_won`/`signed_error_c` are filled by a separate
  pass (`amsterdam_sim_truth_inputs → core planTruth → amsterdam_sim_truth_record`) the moment KNMI has the
  day — whether or not the market bet has graded. So "market accuracy stays its own number" is literal.
- **The deliberate round-vs-floor asymmetry.** We *predict* with `wuRound` (round-half-up, the market grain)
  but *score truth* with `floor` — so a true high of e.g. 22.5 (we'd bet 23, floor is 22) counts as a truth
  miss by design. That is the operator's exact spec: it measures whether our market-bet integer matched the
  true *floor* integer. `MAE = mean|signed_error|` and `bias = mean signed_error` (positive = ran hot) are the
  continuous skill numbers at 0.1° resolution, unaffected by either rounding.
- **Where it shows.** `/amsterdam` gains a **Floor truth accuracy** panel (per-arm floor-hit rate with a Wilson
  CI, decimal MAE, signed bias with a CI — the same one-place `core/sim/stats` idiom as the edge CIs), and the
  bet log + latest call gain `real high` / `err` / `truth ✓·✗` columns. `scripts/amsterdam-nowcast-backtest.ts`
  prints a second table — baseline vs forecast-lifted **floor-hit + decimal MAE** over the KNMI-truth days.

## 5. Honest caveats

- **Odds history is thin (~4 dense days).** The decision table's EV column is noisy until the live sim
  accrues `n`; the 182-day *accuracy* curve is robust, the *odds* side is what the race measures forward.
- **Efficiency prior.** Expect the curves to hug $0 (minus fees). A sustained climb on any arm is the
  signal worth chasing — and the hook for "continuously evolve the underlying prediction system": improve
  the nowcast, and this is the scoreboard that proves it moved.
- **Fees.** P&L is net of the Polymarket taker fee (`rate·p·(1−p)` per share, stored per bet) so the
  total is honest, not gross.
- **Truth timing.** A bet grades only once `observations.finalized_at` is set for EHAM that date
  (~1–2 days), matching the market's own resolution-revision window.
- **Best-time model is a decision aid, not a calibrated probability** (see §6) — it assumes the floor-break
  and given-floor-error failure modes are independent, and the given-floor skill prior is a fixed constant
  until enough graded bets refine it.

## 6. Best time to bet — the peak-hour climatology model (2026-06-17, asset + `/amsterdam` 0044)

The "best time of day" question has two independent answers, and this model fuses them into a single
recommended lock hour. The hero `/amsterdam` chart + the "accuracy × peak hour" table are its surface.

**The two halves.**
1. **Peak-hour floor confidence** (structural). The running max is a hard floor on the day's high, so a bet
   only loses to *further warming* if the day climbs past our bucket after we lock. How likely that is, by
   local hour, is a pure climatology question — answered from **20 years of KNMI Schiphol hourly temperature**
   (station 240, var `T`, 1.5 m, 0.1 °C; the free no-auth `uurgegevens` endpoint, the same provider as the
   §4 truth feed). Converted to Europe/Amsterdam local time, one peak-hour per local calendar day (the day
   the market resolves over), 7 306 complete days. The decision-relevant cut is **forward upside** =
   `max(0, max(temp after h) − running max through h)` — how much the floor can *still* rise. We store, per
   month and local hour, `peakedPct` (P max already reached), `leUpside05` = P(remaining ≤ 0.5 °C) (the
   "floor confidence" — for a ~1 °C bucket, the floor is essentially locked), and the mean / p90 upside.
   Hot days peak ~1 h later, so each warm month also carries a **≥25 °C sub-climatology**; the model uses it
   when the day's forecast is hot. Findings: in June the median peak is **16:00 local** (17:00 on hot days);
   floor confidence climbs 13:00 → 16:00 as 34 % → 50 % → 70 % → 84 % (hot days lag: 15 % → 26 % → 56 % → 81 %).
2. **Prediction accuracy** (empirical). Given the floor, is our whole-°C call right? The graded paper bets'
   hit rate at each lock hour. Small-sample early, so it is **shrunk toward a structural prior** = floor
   confidence × a baseline given-floor skill (`AMSTERDAM_MODEL_SKILL_PRIOR = 0.85`, anchored to the §1
   backtest): `blended = (n·empirical + k·prior)/(n+k)`, `k = 10`. Early on the recommendation leans on the
   climatology; it tightens to the measured rate as bets accrue.

**The fusion → recommendation.** `predictiveConfidence(h)` is that blended win probability. The recommended
hour maximises **`predictiveConfidence(h) / ask(h) − 1`** (blended EV) among hours whose floor is credibly
locked (`floorConfidence ≥ 0.5`) — trading floor-certainty (rises with h) against odds value (the market
prices the floor in as the day resolves, so `ask → 1` and EV → 0 late). With no live odds it falls back to
the earliest structurally-safe hour (`floorConfidence ≥ 0.8`); for a typical June day this is **16:00** (floor
confidence 84% at 16:00 vs 70% at 15:00 — the first hour clearing 0.8). The structural fallback is deliberately
one hour stricter than §1's empirical 15:00 sweet spot: when live odds exist the EV-aware path lands on **15:00**
(it trades a little floor-certainty for the better-priced 15:00 ask), but with no odds to weigh it errs to the
more floor-certain hour. Note also that the EV-eligibility gate (`floorConfidence ≥ 0.5`) excludes June 14:00
by design — its floor confidence is 0.497 (a coin-flip), so 14:00 is never recommended even though the table
rounds it to "50%". It is a transparent decision aid (P(win) ≈ P(floor locked) × P(call right), assumed
independent), **not** a calibrated probability.

**Where it lives.** `core/sim/amsterdam-besttime.ts` (pure model, `recommendBestTime`), the committed asset
`core/sim/amsterdam-climatology.ts` (generated, do not hand-edit), the loader (`getAmsterdamSim` →
`bestTime` + `peakHourChart`), and the page (`components/PeakHourChart.tsx` + the bento/tiles/table). Tests:
`packages/core/test/{amsterdam-climatology,sim-amsterdam-besttime}.test.ts`, `apps/web/test/amsterdam-loader.test.ts`.

**Regenerate the climatology** (only when extending the year range / refreshing the normal):
```bash
# Explore the distribution + decision tables (prints; --csv dumps per-day peaks):
pnpm tsx scripts/research/amsterdam-peak-hour.ts --from 2006 --to 2025 [--csv]
# Regenerate the committed asset consumed by the model + UI:
pnpm tsx scripts/research/amsterdam-peak-hour.ts --from 2006 --to 2025 --emit packages/core/src/sim/amsterdam-climatology.ts
```

Companion docs: `AMSTERDAM-BUILDOUT.md` (the accuracy finding that seeded this), `FORECASTING-RD.md`
(why trading is closed), `BUILD-STATE.md`, `RUNBOOK.md`.

## 7. The "cold bias" — investigated, predictor left UNCHANGED (2026-06-21)

**Symptom.** Through the June 2026 warm spell the live paper bets ran ~1.1–1.4 °C **cold** (the floor-truth
panel's signed error went negative at every arm; 15:00 hit only ~44% over ~9 graded days). The question: is
the late-arm nowcast systematically under-predicting in a way we can fix?

**What we found (the honest, evidence-backed answer): NO — the predictor is at its integer-skill ceiling at
the late arms, and "fixing" the cold bias demonstrably makes the bet WORSE.** No engine change shipped.

**The analysis (`scripts/research/amsterdam-coldbias.ts`, walk-forward, KNMI 0.1 °C truth):**
- The full 69-day backtest is healthy — 15:00 **82.6%** exact, 16:00 **92.8%**. The cold spell was a recent
  warm-day patch, not the system's general behaviour. The bias is a **continuous mis-centring**: the
  running-max floor sits ~0.4–0.6 °C below the eventual high because the day is still warming.
- Candidate fixes were baked off. Lifting the floor by the bias-corrected **forecast** at 15/16 (C1) or by
  the climatology upside at the **early** arms (C3/C5) significantly **hurts** the proven arms (McNemar
  p<0.05). The only candidate that looked good was **C7** — add the *all-day* climatology expected
  remaining-upside at 15/16: on the 69 live days it showed **zero integer flips** (P&L-neutral) while cutting
  the late-arm decimal MAE −34%/−20% and the cold bias to ~⅓. It looked like a free calibration win.

**Why C7 was REJECTED — the 20-year validation (`amsterdam-peak-hour.ts --validate-lift`, 7 306 days):** the
"zero flips" was a small-sample accident. On 20 years the identical lift **degrades integer exact-hit in every
single month** (Δexact **−3 to −16 pp**; flips overwhelmingly losses — e.g. Dec 15:00 **13 gained / 110 lost**,
Jun 15:00 83/139). The mechanism: remaining warming after 15/16 is **right-skewed near zero**, so the
running-max floor is a biased-*low* **continuous** estimator but the **better integer** estimator —
`wuRound(floor)` already lands on the high's whole degree, and adding the *mean* upside (inflated by the right
tail) overshoots. The mean minimises signed bias but is the wrong statistic for the rounded bet.

**Conclusion & the only real lever.** The cold bias is an **inherent right-skew artifact, not a fixable
predictor error**; the floor (+ the existing forecast lift at 13/14) is already the optimal integer call at
every arm. The hot-day 15:00 miss is **irreducible** — the day genuinely hasn't peaked (≈56% floor confidence
on hot June days). The lever that *does* help the cold-spell losses is the **decision layer**: bet later
(16:00+) on hot days — which the best-time model already does (§6: the ≥25 °C sub-climatology lowers 15:00's
floor confidence to 0.56 vs 16:00's 0.81, and the no-odds fallback recommends the first hour ≥0.8 → 16:00).

**What shipped:** the two reusable R&D harnesses (`amsterdam-coldbias.ts` bake-off; `amsterdam-peak-hour.ts
--validate-lift` 20-yr check) and this finding. **The engine is unchanged** — `nowcastBasisC` stays pure
floor at 15/16. A 4-lens adversarial panel + the 20-yr validation caught a change that would have silently
degraded market accuracy 3–16 pp; the negative result is the deliverable.

## 8. Tomorrow's prediction + live running max + decision-strip redesign (2026-06-21, migrations 0046/0047)

Operator UI/UX review of `/amsterdam`: the page answered "best time to bet / who's winning / history" but
not the two most glanceable operational facts — **what we predict for tomorrow** and the **running-max floor
right now**. Every figure was first cross-checked against prod (all matched). What shipped:

- **Decision strip** (top of page): today's predicted high, live running max (as-of), tomorrow's prediction,
  overall prediction rate, provisional leader. Plus a model-rec-vs-realised-leader reconciliation note and a
  neutral leaderboard banner. Arm colours recoloured to a categorical ramp (amber/sky/violet/magenta) so
  green/red mean P&L sign only; equity lines gain dash patterns + de-collided last-point labels (colour-blind
  safe); wide tables get mobile scroll wrappers; verification depth folds into `<details>`.
- **Migration 0046** (`dash_amsterdam_sim`, whole 0043 body re-stated + two blocks): `tomorrow` =
  bias-corrected cross-model lead-1 forecast from `forecast_snapshots` (verbatim mirror of
  `amsterdam_sim_place_inputs` 0041 trailing-30 debias; **display falls back to the RAW forecast when <20
  pairs**, flagged `biasCorrected:false`) → `wuRound` bucket → live ladder ask; `liveRunMax` = `intraday_max`
  (METAR floor + `last_obs_at`). The web port is RLS-scoped/RPC-only, so these had to come from the RPC.
- **`overall` accuracy** is pooled in the loader (TS) from the full-population arm aggregates (NOT betLog,
  which the RPC caps at 120); floor-truth pools over the same `armTruthStats` population as the per-arm cards.
- **Migration 0047** (code-review follow-up): `tomorrow.nModels` counts `distinct model`, not captures.

**Honesty caveats (from the multi-agent code review):** the "Running max now" sub is labelled "max last rose
~HH:mm" because `intraday_max.last_obs_at`/`n_obs` freeze when the max last advanced (0015 upsert), not at the
latest observation. The overall-rate sub reads "across 4 lock hours · N days" — the 4 arms bet the same day's
outcome (correlated), so it is not N×4 independent bets. The Amsterdam date math stays fixed `Etc/GMT-2`
(summer-only sim); a winter/DST switch to `Europe/Amsterdam` must be done across 0041+0046+0047+the city tz in
lockstep, not piecemeal.

## 9. In-lock-hour odds guard + data re-derivation (2026-06-22, migration 0048)

Operator data-integrity audit of the paper-sim. Two defects surfaced, both rooted in the same cause — the
universe was seeded **retrospectively** on 2026-06-16 from feeds that were still mid-backfill:

- **Odds (the real defect).** `amsterdam_sim_place_inputs` reconstructed each arm's ask as the latest
  `market_snapshots.best_ask` with `captured_at < asof` (asof = end of the lock hour) — an **unbounded**
  backward forward-fill. On the two thinnest early days (06-12 / 06-13) this reached back past the lock hour;
  **6 of those 8 bets carried an ask matching no snapshot on the bet's bucket at any time**, and the real
  in-lock-hour quote differed materially (06-13 13:00 recorded **0.39** vs real **0.49** — a winning bet that
  inflated the 13:00 leaderboard). Verified across all 40 bets: every bet from 06-14 on already matched a real
  in-hour quote (staleness ≤ 1h); only 06-12/06-13 were corrupt.
- **Fix — migration 0048.** Bound the forward-fill to the lock hour itself: the ask must be the latest quote
  with `captured_at >= lockstart AND captured_at < asof`. No in-hour quote → the bucket ask is null →
  `planPlacements` skips the arm (a no-bet, never a phantom price). This is the "validated odds at the specific
  time" contract; it governs BOTH the live Edge tick and the backfill (one RPC). Tested directly
  (`amsterdam-sim.test.ts` guard case: a pre-hour quote is NOT forward-filled — only the in-hour arm places).
  The script's Table A analysis query got the same bound.
- **Re-derivation.** With 0048 applied to prod, the 06-12/06-13/06-15 bets were deleted (full-table backup
  first) and re-placed through the guarded RPC + re-graded + KNMI-truth-refilled. **Operator decision (full
  walk-forward):** score every day with the predictor's current feeds (genuine lead-1 forecasts +
  the observed running-max floors), consistent with how the live predictor runs — rather than freezing the
  early days at their seed-time `forecast_c = null` state. This re-activates the forecast lift on 06-15 (floors
  + lift → 13/14/15 flip from losses to wins) and lifts the leaderboard (13:00 +$21.16 → **+$44.70**; hit rate
  44% → 56% on the early arms). **Provenance honesty:** the forecast feed itself was backfilled (rows written
  06-13→06-16, though each carries a genuine lead-1 `captured_at`), so the pre-~06-17 period is a
  *reconstruction*, not a live record — the consistency framing is the chosen interpretation, documented here.
  **Post-state verified: 40/40 bets trace to a real in-lock-hour quote** (0 unvalidated); truth complete except
  06-20 (KNMI lag, fills on the daily tick). No deploy needed — `dash_amsterdam_sim` reads the table live.

## 10. "Predicted high" → today's freshest forecast (2026-06-23, migration 0052)

Operator report: the decision-strip **"Predicted high"** tile read the forecast carried on the **latest placed
bet** (`latest.byHour[*].forecastC`). Today's four arms aren't placed until the afternoon lock hours, so all
morning the tile showed **yesterday's** number and only flipped once the day's first bet landed (~the afternoon
Edge tick). The ask was to switch it in the **morning** of the day and keep it as fresh as possible.

- **Fix — migration 0052.** `dash_amsterdam_sim` gains a `today` block (mirrors the 0046 `tomorrow` block, but
  for today and against the **freshest** capture): take the `forecast_snapshots` batch with the **latest
  `captured_at`** for `target_date = today` (its cross-model mean is the most recent NWP view — the previous
  night's **lead-0** 22Z run, then this morning's lead-0 10Z run as it lands ~12:15 local), debias it by **that
  lead's** trailing-30 residual (the verbatim 0041 correction; ≥20 pairs to trust, else display the raw), wuRound
  to the bucket, price against today's ladder. Whole 0049 body re-stated (create-or-replace); additive `today`
  key; unchanged signature. Lead 0 exists in the feed (verified: 9 models, captured night-before + same-morning).
- **Loader/page.** `getReplicaSim`'s sibling `getAmsterdamSim` surfaces `today` (`TodayView`) and the page's tile
  prefers `today.forecastC`/`predictedC` over the bet-carried forecast (then the running-max floor), shows the
  freshness stamp ("as of HH:mm" from `capturedAt`), and dates the tile to *today*. The fresh `today.forecastC`
  also drives the hot-day climatology selection (so the best-time rec switches in the morning too). Because the
  page is `force-dynamic`, every request re-runs the RPC → always the current prediction.
- **Verified.** Applied to prod 2026-06-23; live computation for 2026-06-23 = lead-0 raw 28.76°C + 0.53 debias →
  **29.28°C → 29°** (vs the stale latest-bet value it replaced). Loader + RPC tests added
  (`amsterdam-loader.test.ts`, `amsterdam-sim.test.ts`); 1,157 tests green. Backward-compatible: the pre-deploy
  page ignores the new `today` key.
