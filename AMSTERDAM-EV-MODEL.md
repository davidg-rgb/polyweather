# AMSTERDAM-EV-MODEL — handoff: best-buy-timing model (5-min odds × prediction skill)

> **Status: BOTH DELIVERABLES BUILT (2026-06-17).** Code is local, suite green (743), typecheck 0, web build
> green. The only remaining steps are the operator-gated go-live for Deliverable 1 (apply migration `0042` to
> hosted + push → Vercel — read-only RPC, no redeploy) and the standing P4 calibCursor drain (separate). See
> the SESSION UPDATE block below for exactly what shipped and the decisions resolved.
>
> Original two deliverables, in order:
> 1. **NEAR-TERM (≈1 session):** an **EV-with-confidence-interval + hit−ask-gap-by-arm** panel on `/amsterdam`,
>    so the best-buy sweet spot reveals itself with honest uncertainty as `n` grows.
> 2. **BIGGER (research + build):** a **continuous-time best-buy model** — track every 5-min odds point,
>    backtrack Polymarket odds as far as they retain, measure each against our predicted temperature at the
>    *same* timeslot, and pinpoint the buy position with the most long-term upside.
>
> Read `AMSTERDAM-SIM.md` first (the live sim + the forecast-aware nowcast). This doc is the next step.

---

## SESSION UPDATE — 2026-06-17 (both deliverables built)

**Deliverable 1 — EV/edge CI panel: DONE (code).**
- **Core stats seam** `packages/core/src/sim/stats.ts` (17 unit tests): `wilsonInterval` (small-n-safe hit-rate
  CI), `meanConfidenceInterval` (paired hit−ask gap, mean ± 1.96·SE), `bootstrapMeanCi` (heavy-tailed EV/$1,
  seeded percentile bootstrap reusing `mulberry32`), and `armEdgeStats((won,ask)[])` — the one place the three
  estimators are wired to data, so the loader AND the best-buy backtest score identically.
- **Migration `0042_amsterdam_edge_ci.sql`** — create-or-replace `dash_amsterdam_sim` adding a `betsByArm`
  payload (graded `(won, ask)` per arm). Read-only, additive, no new surface. Added to `migrations.test.ts`.
- **Loader** `getAmsterdamSim` computes the per-arm CI bundle in TS from `betsByArm` via `armEdgeStats`
  (degrades to NaN CIs if the payload is absent — the page can deploy ahead of the RPC). 5 new loader tests.
- **Page** `/amsterdam` "Best time of day" table now shows hit (Wilson CI), edge ± CI (the headline), EV/$1 ±
  CI, each colour-coded by whether its CI **clears zero** (✚ real edge / straddles 0 = efficient null); arms
  with `nGraded < 10` are greyed "too few to call".
- **Pending (operator-gated):** apply `0042` to hosted (MCP `apply_migration`) → push → Vercel. No Edge redeploy.

**Deliverable 2 — best-buy curve: DONE.** `scripts/amsterdam-best-buy.ts` sweeps a 5-min buy-time grid, scoring
`edge(t)`/`EV(t)` with CIs and `n(t)` over all resolved days, reusing the engine seam (`nowcastBasisC` +
`predictedBucketIdx`) and `armEdgeStats`. **No look-ahead, faithful to the live arms:** running max through the
last *completed* local hour `h_eff = hour(t)−1`, ask forward-filled `≤ t` — which makes **live arm `h` ≡ grid
point `(h+1):00`** (the arm locks odds at end-of-hour `h`), so the 4 arms are the model's *pre-registered*
reference points. `t*` is reported only among `n ≥ --min-n` points, with a loud multiple-comparisons caveat.

**Odds-backtrack depth — RESOLVED (probed live, first-move #2):**
- Polymarket `/prices-history` is a **dead end** for deepening the backtrack: each daily temperature token
  retains only **~2–3 days** around its target, **0 points** for events older than ~5 weeks, at a coarsest
  **10-min fidelity** (`fidelity=1`/`=5` both collapse to 10-min; `interval=1m` → HTTP 400).
- **Our own `market_snapshots` archive is the deepest + finest source** (2026-05-14→present, ~5-min,
  delta-deduped). So **there is no deeper odds to fetch** — the §2.4 deep-backfill idea is moot.
- **Sharper finding than expected:** `best_ask` (the *executable* price) only exists **since ~2026-06-12** — older
  snapshots stored `mid` only. So the *faithful* (best_ask) curve is **~5 resolved days**; a `--price mid` mode
  (`coalesce(best_ask, mid)`) extends it to **~14 days** but `mid < ask` ⇒ its edge is an **optimistic, non-
  executable upper bound** (it shows a fat universal edge precisely *because* mid understates cost — a clean
  illustration of why the executable-ask curve, where edge erodes toward 0 as certainty rises, is the real test).

**Decisions resolved (the §5 open questions):**
- *Backfill deeper odds into a table, or query on the fly?* → **Neither/moot.** No deeper odds exist; the script
  reads `market_snapshots` directly. Nothing to backfill.
- *Multiple-comparisons when picking `t*`?* → Handled: `t*` gated to `n ≥ min-n`, the 4 live arms are the
  pre-registered hypotheses (the scan is exploratory), and the output prints the caveat + how many points clear 0.
- *Hourly vs half-hourly prediction (30-min METAR ingestion)?* → **Stay hourly for now (recommended).** The
  faithful curve shows the edge is monotone-decreasing across the *hours* (the market re-prices our accuracy),
  and the within-hour 5-min variation is an **ask** effect, not a prediction effect — a finer (half-hourly)
  prediction only matters if `t*` lands on an hour boundary with a suspected sub-hour edge. It doesn't yet
  (n too small to call). Revisit after ~30 dense days if a boundary effect appears.

**First read on the data we have (thin — do not over-read):** on the faithful best_ask curve (n=5), edge is
strongly positive early (14:00 ≈ +0.56 [+0.45,+0.68]) and **erodes to ~0 by 16:00–17:00** as the market prices
in our rising certainty — the WO-5 efficiency signature, now visible *with its CI*. `t*` is **not called** (every
point has n < 10). The live `/amsterdam` panel is the accruing version; firm read at ~30 dense days (~mid-July).

---

## 0. Entry context — where things stand (so a cold session can start)

- **The product is analytics, not trading** (CLAUDE.md pivot; WO-5 says the market is efficient). The goal of
  this model is **model-vs-market insight**: *if* our forecast-aware nowcast beats the market's price on our
  bucket at some buy-time, the EV curve shows it; if not, we've measured efficiency precisely. Either is a result.
- **Live now:** the Amsterdam paper-trade sim (`AMSTERDAM-SIM.md`) races `$10/day` at **13/14/15/16 local**,
  forecast-aware (migrations 0040+0041). Prediction = `wuRound(max(runningMax, biasCorrectedForecast))` at arms
  ≤14, else the pure running-max floor. Bias = trailing-30-day mean(actual−forecast), ≥20 pairs.
  Engine seam: `nowcastBasisC` in `packages/core/src/sim/amsterdam.ts`.
- **The open question this model answers:** *what is the single best moment of the day to buy* — the sweet spot
  between **odds** (cheap early, priced to ~1 late) and **our prediction success rate** (low early, ~certain late)?
  The 4 hourly arms *bracket* it; this model finds it on the 5-min grid.
- **Why we're waiting for data:** the accuracy curve is robust (~180 days) but the **dense 5-min odds history is
  only ~1 week deep** (since ~June 12). Realized-PnL is too high-variance to decide; the **hit−ask gap** (paired,
  low variance) is the metric. First read ~June 30 (14 graded days); firm ~mid-July (~30 dense days).

---

## 1. Data inventory (exact — what to query)

| Signal | Table / source | Cadence / depth | Notes |
|---|---|---|---|
| **Market odds (ask)** | `market_snapshots` (`bucket_id`, `best_ask`, `captured_at`) | **~5-min** since ~2026-06-12; sparse back to **2026-05-14**; 9,189 rows / 35 days as of 2026-06-17 | delta-deduped; join via `market_buckets.event_id` → Amsterdam `market_events` |
| **Deeper odds backtrack** | Polymarket CLOB `GET /prices-history?market={token}&interval=…` | as far as Polymarket retains; fidelity varies by range | **Parser already exists:** `parsePricesHistory` in `packages/core/src/polymarket/clob.ts` → `{history:[{t,p}]}` ascending. Used by `scripts/backfill-market-history.ts` (§6.22). `market_buckets.token_yes` is the token. |
| **Running max (our floor)** | `intraday_advances` (`icao='EHAM'`, `date_local`, `local_hour`, `max_tenths_c` [°C]) | **hourly** | THE timing constraint — our predicted bucket only refreshes hourly (see §2.3) |
| **Pre-day forecast** | `forecast_snapshots` (`icao`, `target_date`, `lead_days=1`, `tmax_c`) | per model, ~2×/day | cross-model mean = the raw lead-1 forecast |
| **Truth** | `observations` (`icao='EHAM'`, `date_local`, `tmax_wu_native`, `finalized_at`) | finalized ~1–2 days after | the WU daily high the market resolves to; EHAM unit='C' |
| **Resolved winner** | `market_events.winning_bucket_idx` | per event | the bucket that won |

**Bias-corrected forecast (the prediction input), replicated in SQL** (see migration 0041 `amsterdam_sim_place_inputs`):
`forecast = mean(lead-1 tmax_c for the day) + mean(actual − lead-1 forecast over the trailing 30 finalized days < target)`,
gated to ≥20 pairs. Constants `AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS=30` / `_MIN_PAIRS=20` live in the engine and are
mirrored in the RPC + `scripts/amsterdam-nowcast-backtest.ts`. **Keep all three in lockstep.**

---

## 2. Deliverable 2 — the best-buy-timing model (the vision)

> Written first because it frames Deliverable 1. The user's words: *"track each of these [5-min] odds points and
> isolate when the best time to buy would be based on our prediction success rate and the 5-min odds. Backtrack
> Polymarket odds as far as we can, measure it towards our predicted temperatures at the same timeslots, and
> pinpoint the best buying position for most long-term upside."*

### 2.1 The objective
For a fine **buy-time grid** `t` (5-min steps across, say, 09:00→18:00 local), estimate over all available days:
- `hit(t)` = P(our predicted bucket at `t` == winning bucket),
- `ask(t)` = market ask on our predicted bucket at `t`,
- `edge(t) = hit(t) − ask(t)` (the low-variance signal), and `EV(t) = hit(t)/ask(t) − 1` (the payout-weighted signal),
each **with a confidence interval**. Then **`t* = argmax`** of a chosen objective (edge, EV, or a risk-adjusted /
fee-net variant). Study the *shape*: is there a window where our skill leads the market's pricing (a real edge), or
does `edge(t)→0` everywhere (efficiency confirmed)?

### 2.2 The per-day construction (walk-forward, no look-ahead)
For each resolved day `d` and each grid time `t`:
1. **Our prediction** `pred(d,t)` = `wuRound(max(runningMax(d, ≤hour(t)), biasCorrectedForecast(d)))` for `hour(t) ≤ 14`,
   else `wuRound(runningMax(d, ≤hour(t)))`. The bias uses only days `< d` (trailing-30). **Reuse `nowcastBasisC`.**
2. **The ask path** `ask(d,t)` = best_ask on the bucket `pred(d,t)` from the latest snapshot with `captured_at ≤ t`
   (forward-fill; the existing `amsterdam_sim_place_inputs` "asof" logic is the template — never read an ask after `t`).
3. **Outcome** `won(d,t)` = `pred(d,t) == winning_bucket_idx`.
Then aggregate across days at each `t`.

### 2.3 The hard part — two clocks (READ THIS)
- **Odds = 5-min; our prediction refreshes only hourly** (running max is hourly in `intraday_advances`). So *within*
  an hour the predicted bucket is **constant** and only the ask drifts. The 5-min value is therefore about **catching
  the ask before the market re-prices toward certainty** — not about a finer prediction. Across the day the predicted
  bucket **steps up hourly**. So `t*` decomposes into *(which hour)* × *(which 5-min tick within it)*.
- **Finer prediction is possible but needs a build:** EHAM (Schiphol) issues **METAR every 30 min**, so a half-hourly
  running max is obtainable by ingesting the 30-min METARs into a finer `intraday_advances`. **Decision for next
  session:** is hourly enough to find `t*`, or do we want half-hourly prediction? (Recommend: prove the hourly shape
  first; add half-hourly only if `t*` sits on an hour boundary and we suspect a sub-hour edge.)

### 2.4 Backtracking odds as far as possible
- Our `market_snapshots` archive: dense 5-min since ~June 12, sparse to May 14. To go deeper, pull Polymarket's own
  history per bucket token via `parsePricesHistory` (`GET /prices-history?market={token_yes}&interval=…`). The
  `interval`/fidelity param trades depth for resolution — fetch the finest fidelity Polymarket allows per range.
- **Reuse, don't reinvent:** `scripts/backfill-market-history.ts` (§6.22) already reconstructs daily snapshots from
  `/prices-history` (with a post-cutoff doctoring guard — see its test). Extend/mirror it to populate a fine
  odds-path table, or query the history on the fly. Reconcile/dedup against `market_snapshots` (prefer our captured
  ask where both exist; the §6.22 C2 sentinel logic is the precedent for cutoff handling).
- **Caveat:** Polymarket's per-token history depth for *temperature* markets may be short (these markets are daily and
  short-lived). Confirm retained depth early — it may cap the backtrack near our own archive (~5 weeks). Document what
  you find.

### 2.5 Output
- A reproducible script `scripts/amsterdam-best-buy.ts` (mirror `amsterdam-nowcast-backtest.ts` idiom): prints the
  `edge(t)`/`EV(t)` curve over the grid with CIs and `n` per `t`, and `t*` per objective.
- Optionally a dashboard curve on `/amsterdam` once stable (EV/edge vs time-of-day, with a CI band).

### 2.6 Risks / open questions to resolve next session
- **Efficiency null:** edge may be ~0 at every `t` (WO-5). That's still a publishable analytics result — don't force a
  positive finding. Report CIs honestly.
- **Thin data:** the dense 5-min window is ~1 week; the model is exploratory until ~30+ dense days. State `n(t)` everywhere.
- **Multiple-comparisons:** scanning many `t` and picking the max `edge(t)` inflates significance. Use a holdout / a
  single pre-registered objective, or correct for the scan (the model lens, not just code).
- **Single-station, single-season** (spring/summer, forecast record starts 2026-03-20). No winter data. A-11
  (negative-temp `wuRound`) and the °F→°C path remain unexercised for EHAM.

---

## 3. Deliverable 1 — EV-with-confidence-interval panel (near-term, do this first)

A small, shippable step that also produces the CI math the big model reuses. Surface **per arm** on `/amsterdam`:

| Column | Definition | CI method |
|---|---|---|
| hit rate | wins / n_graded | **Wilson 95%** (small-n safe) |
| avg ask | mean recorded ask | — |
| **edge = hit − ask** | mean over graded bets of `(won::int − ask)` | mean ± `1.96·se` (paired, low variance — the headline) |
| **EV/$1** | mean over graded bets of `(won ? 1/ask−1 : −1)` | **bootstrap 95%** (heavy-tailed; analytic se is unreliable at low ask) |
| n_graded | count | the credibility gate — show it |

**Build (mirror the existing 0038/0040 idioms):**
1. Extend `dash_amsterdam_sim` (a new migration `0042`, create-or-replace) to return per-arm `edge`, `edgeCiLo/Hi`,
   `evCiLo/Hi`, `hitCiLo/Hi`, and `nGraded`. Wilson is closed-form in SQL; for the EV bootstrap, either compute an
   analytic se in SQL (acceptable v1) or do the bootstrap in the loader (TS) — **recommend TS in `getAmsterdamSim`**
   to keep the RPC simple. The hit−ask gap CI is closed-form (mean ± 1.96·se of `won−ask`), do it in SQL.
2. Loader `getAmsterdamSim` (`apps/web/src/lib/loaders.ts`): add the CI fields to `ArmStanding`; if doing the EV
   bootstrap in TS, compute it from the per-bet `(won, ask)` rows (add a small `betsByArm` payload to the RPC).
3. Page `apps/web/src/app/(dash)/amsterdam/page.tsx`: in the "Best time of day" evidence table, render `edge ± ci`
   and `EV ± ci` with `n`. Grey out / annotate arms with `n_graded < ~10` ("too few to call").
4. Tests: engine helper for Wilson + the gap-CI (pure fn in core, unit-tested); a loader test on a seeded payload;
   migration test for `0042` (add to the ordered list in `supabase/tests/migrations.test.ts`).
5. Apply `0042` to hosted (MCP `apply_migration`), redeploy nothing (read-only RPC), push → Vercel.

**Definition of done:** `/amsterdam` shows, per arm, the edge and EV each with a 95% CI and `n`, so "is any arm's
edge clearly off zero yet?" is answerable at a glance. This is the dashboard version of the June-30 checkpoint.

---

## 4. Methodology guardrails (carry into both deliverables)

- **No look-ahead, ever.** Bias from days `< target`; ask from snapshots `≤ buy-time`; never the resolved actual or a
  future ask. The current RPC + backtest already enforce this — match them.
- **Edge (hit − ask) is the primary metric**, not realized PnL. Single-bet PnL variance is enormous (a 0.2-odds win is
  +$40, a loss −$10) → PnL needs hundreds of days to separate edge from zero; the paired gap needs tens.
- **Significance:** McNemar exact for paired hit-rate deltas (already in the backtest); Wilson for proportions;
  bootstrap for EV. Report `p` and `n`, never a bare "+Xpp."
- **Don't overstate the sample:** the lift was measured on **69 walk-forward test days** (of ~180 finalized), dense
  odds ~1 week. Say so.
- **Reuse the seam:** all prediction logic flows through `nowcastBasisC`; all P&L through `gradeSimBet`. Don't fork them.

---

## 5. First moves for next session (ordered)

1. **Re-read** `AMSTERDAM-SIM.md` §"Predictor upgrade" + this doc. Run `pnpm tsx scripts/amsterdam-nowcast-backtest.ts`
   to re-confirm the current numbers (don't trust stale literals).
2. **Confirm odds-backtrack depth:** call Polymarket `/prices-history` for one EHAM bucket token (via the clob client /
   `parsePricesHistory`) and see how far back + what fidelity it returns. This decides whether the big model has
   weeks or months of odds. **Document the finding.**
3. **Build Deliverable 1** (EV/edge CI panel) end-to-end (migration 0042 → loader → page → tests → apply → push). Small,
   high-value, produces the CI math the model reuses.
4. **Prototype Deliverable 2** as `scripts/amsterdam-best-buy.ts`: the `edge(t)`/`EV(t)` curve over the 5-min grid on
   the data we have, with `n(t)` and CIs. Expect thin/noisy — the point is the harness, not a verdict yet.
5. **Decide** (with the operator): hourly vs half-hourly prediction (the 30-min METAR ingestion); how to handle
   multiple-comparisons when picking `t*`; whether to backfill deeper odds into a table or query on the fly.

### Checkpoints on the live data (no build needed)
- **~June 30** (14 graded days): first look at per-arm edge ± CI — is anything off zero?
- **~mid-July** (~30 dense-odds days): firm enough to name a primary buy-time / arm.

### Posture (unchanged)
All four arms stay live and forecast-aware. **No gate narrowing, no re-seed** — keep options open until the data
decides. The 13:00 arm is the high-leverage edge candidate (if forecast skill beats the ask); 15:00 is the
confidence sweet spot. Let the EV curve adjudicate.

---

**Companion docs:** `AMSTERDAM-SIM.md` (the live sim + nowcast), `AMSTERDAM-BUILDOUT.md` (the accuracy finding),
`FORECASTING-RD.md` (WO-5, why trading is closed), `BUILD-STATE.md`, `RUNBOOK.md`. Key code: `nowcastBasisC` +
`gradeSimBet` (`packages/core/src/sim/amsterdam.ts`); `parsePricesHistory` (`packages/core/src/polymarket/clob.ts`);
`scripts/amsterdam-nowcast-backtest.ts` + `scripts/backfill-market-history.ts` (idioms to mirror).
