# External-Agent Crosscheck — "Polymarket Weather Edge: Strategic Improvements & Latency Optimization"

> Research-only doc. **No code, config, or other file in this repo was touched to produce this.** Written
> 2026-07-03 while a separate agent works the FASTTRACK sprint (`FASTTRACK-PLAN.md`) in parallel — this
> crosschecks a third-party AI agent's recommendations against what's actually in `FINDINGS.md`,
> `WALLET-RECON-HANDOFF.md`, `FORECASTING-RD.md`, `MAKER-EXIT-SIM.md`, `SIGNAL-BACKLOG.md`, and the live
> codebase, so nobody re-does work that's already done or re-opens a lever that's already measured dead.

## Framing, up front

The external report reads as **generic best-practice guidance for an early-stage Polymarket weather bot** —
it has no visible awareness of this project's own R&D archive (18 falsified signals, a live forward-gated
paper loop, ~30 commits of adversarial multi-agent review). Its three sections retrace ground this project
already covered, in this order of overlap:

- **Section 1 (Execution & Market Mechanics):** ~90% already built or already tested-and-killed with hard
  numbers. The "shift to maker" recommendation isn't a suggestion here — it's the entire arc of the last two
  weeks of work, and the report is silent on the one thing that actually matters about it (adverse selection).
- **Section 2 (Probabilistic Modeling):** ~80% already built or already tested-and-killed. "Active hedging"
  literally describes the system's one surviving lever (maker-exit) as if it were a novel idea.
- **Section 3 (Raw GRIB/AWS latency):** the one genuinely fresh angle — but it's already triaged in
  `SIGNAL-BACKLOG.md` (item 10) at a correctly low priority, for reasons the external report doesn't
  address (model computation time is a universal floor, not an Open-Meteo-specific handicap).

Bottom line: **nothing in the external report should change current priorities.** One item (nonlinear
post-processing) is a legitimately unexplored gap worth a cheap flag; everything else is either done,
answered, or already correctly deprioritized.

---

## Section 1 — Execution & Market Mechanics

### 1.1 "Shift to Maker Strategy" — ALREADY the central finding of the whole program, not a suggestion

The external report frames this as a fix nobody's tried: rest limit orders instead of crossing the spread.
This project's entire arc from `WALLET-RECON-HANDOFF.md` §12 onward **is** the maker-vs-taker question, run
to exhaustion:

- **Naive maker (rest your own cheap bid on your forecast) — tested, KILLED.** `WALLET-RECON-HANDOFF.md`
  §12 (maker-spray): −1.46pp CI[−2.51,−0.41] (all) / −1.73pp CI[−3.16,−0.30] (forecast); both exclude 0.
  **Mechanism: adverse selection** — the book only touches your resting bid on the days you're wrong. The
  external report never mentions this failure mode; it treats "become a maker" as if resting an order were
  automatically +EV. It isn't. This project measured exactly why not, with a CI.
- **Directional maker EXIT (already holding correctly-selected inventory, maker-only exit) — the one
  positive-EV config in 12 signals.** `MAKER-EXIT-SIM.md`: flips the identical strategy from taker's −3.0%
  to +6.7%/+$515, CI [+0.3%, +12.0%] on the corrected 819-event/45-city/20-day panel (PASSES the frozen
  §9R-E backtest gate). This is precisely the mechanism the external report gestures at ("place resting
  limit orders... to capture the spread and earn maker rebates") but the report doesn't know the mechanism
  only works because entry is **directional and information-informed**, not blind two-sided quoting — blind
  two-sided maker quoting was separately tested and also killed (`REWARD-INVENTORY-BACKTEST.md`: −41%/day,
  measured fill+inventory cost ≈8× the reward income).
- **Status right now (2026-07-03):** this exact lever is live, under a forward-gated paper loop
  (`/maker-exit`, `MAKER-EXIT-PAPER-LOOP-HANDOFF.md`), the gate of record, no capital until it PASSes
  forward. The external report's recommendation is not just already implemented — it's the single thing
  the whole system is currently measuring.

**Verdict: not new. Already built, already the live gate. The report's version is missing the adverse-selection
mechanism that makes naive "just be a maker" wrong 11/12 times and this variant right once.**

### 1.2 "WebSocket Order Book Tracking" — considered, deliberately NOT built as the primary path, for a documented reason

The report asserts 5-minute REST polling is "too slow" and recommends a CLOB websocket. Checking actual
cadence and the actual design decision:

- **Cadence is already far faster than the report assumes.** `poll-markets` (the original, pre-opening-bot
  poller) runs `*/5 * * * *` (`supabase/migrations/0009_cron.sql:163`) — that's the *legacy* baseline the
  report is implicitly critiquing. The live opening-convergence capture layer runs **`*/2 * * * *`**
  (`0066_opening_convergence.sql:791`, currently throttled to `*/10` mid-incident per `BUILD-STATE.md`),
  and the bot's own tick loop defaults to **`tickIntervalSec: 30`** (`opening-convergence.ts:799`,
  `0066_opening_convergence.sql:685`) — a 30-second REST tick, not 5 minutes.
- **The websocket question was explicitly researched and architected, not overlooked.**
  `research/REPORT-clob-bracket-execution.md` §4 documents the user-fill websocket
  (`wss://ws-subscriptions-clob.polymarket.com/ws/user`) and the decision: REST is the **authoritative**
  order/fill path (`getOpenOrders`/`getOrder` polling); the websocket is explicitly **OPTIONAL**, used only
  as a low-latency fill-notification feed. `ARCHITECTURE-OPENING-CONVERGENCE.md` §16-F: "the bot's order
  path is REST... a resting `post_only` GTC is EXPECTED to survive without any persistent session" — this
  matters because Polymarket's auto-cancel-on-disconnect only fires for an *open websocket session that stops
  heartbeating*; a bot that never opens one has nothing to disconnect. The architecture keeps a stateless REST
  order path as the reliability-critical spine and treats the websocket purely as a nice-to-have latency
  shave on fill detection — a considered tradeoff, not a gap.
- **Why it doesn't matter here specifically:** the surviving lever is a **maker-exit** — it rests orders and
  deliberately does *not* react to every tick (`REPORT-clob-bracket-execution.md` §3: "Keep reprices
  infrequent — the weather books are thin and re-quoting churns queue priority"). A strategy built around
  resting orders and infrequent repricing has a much weaker case for websocket-grade reaction speed than a
  strategy built around chasing fast-moving taker opportunities (which this project also tested — see §1.3
  below and `FLUCTUATION-TAKER.md` — and killed).

**Verdict: not a gap. Cadence is already 2–10× faster than what the report assumes exists, and the
websocket-vs-REST tradeoff was made deliberately with a documented rationale, not by default.**

### 1.3 "NegRisk Collateral Optimization" — ALREADY BUILT, verbatim to the cited literature

The report recommends Kelly sizing "natively model the CTF... share collateral across multiple buckets." This
is not a recommendation for future work — it's the sizing algorithm already in the codebase:

- `packages/core/src/kelly.ts` `jointKellyStakes()` implements exactly the joint state-price Kelly algorithm
  for mutually-exclusive negRisk buckets: sort by `q/p` (calibrated prob / effective price) descending,
  greedily include while `ratio > c`, `c = (1 − Σq_included)/(1 − Σp_included)` recomputed per inclusion,
  stakes `f_i = q_i − c·p_i`. This is the identical construction `research/REPORT-strategy-prior-art.md` §6(d)
  cites from the literature (arXiv 2603.13581, Whelan): "sort by p_i/q_i, include outcomes with p_i/q_i > c
  via one-pass greedy, bet x_i = (p_i − c·q_i)₊." Not an approximation of the paper — the same algorithm.
- `applyKellyFraction()` (fractional Kelly, default 0.25) and `applyRiskCaps()` (per-trade/event/cluster/day
  caps, whole-share flooring against `orderMinSize`, capped-and-logged) sit downstream of it.
- `research/REPORT-clob-bracket-execution.md` §0 confirms negRisk is live infrastructure-wise too: every
  weather event is a NegRisk market (`options.negRisk: true` required on every order or it's rejected), and
  §9 verifies the V2 negRiskExchange contract address against the live SDK.

**Verdict: done, not a gap. Built at initial architecture time (§6.8), verified against the exact academic
source the report would point to.**

---

## Section 2 — Advanced Probabilistic Modeling

### 2.1 "EMOS / ML Post-Processing" — EMOS is the existing core; linear MOS was tried and killed; nonlinear ML was never tried — the one legitimately open gap in this whole report

- **EMOS is not a suggestion — it's what `packages/core/src/calibration/emos.ts` already is.** Decaying-average
  bias correction (`updateBias`, α default 0.15), per-station/per-model/per-lead fitted σ with a prior-σ
  fallback ladder (`fitSigma`, min-N 8), inverse-MSE model blend weights (`computeModelWeights`) — this is
  textbook EMOS/NGR (Gneiting et al. 2005), the exact standard `research/REPORT-strategy-prior-art.md` §6(a)
  cites, already running in production and feeding every calibrated forecast in the system.
- **The specific "train XGBoost on raw ensemble members" idea was tried in its linear form and REJECTED with
  a number.** `FORECASTING-RD.md` lever 1 — "Regression MOS (slope+intercept per-model correction)" — result
  **−3.32% (worse)**: helps weak models, hurts strong ones the blend already down-weights; net negative.
  Lever 3 — "Residual-structure: can any feature explain the error?" — **R² = 0.60%**, strongest single
  feature (ensemble disagreement) `|corr| = 0.07`. That second result is the load-bearing one for judging an
  XGBoost proposal: an exhaustive linear feature search across the *same inputs* an XGBoost model would
  train on found almost no exploitable residual structure. `DF5-FINDINGS.md` independently confirms the
  deficit is a **point-forecast aim problem** (p(realized winner) house 0.344 vs market 0.373), not a
  calibration-width problem, and explicitly lists "better post-processing of the ensemble mean — MOS /
  quantile-mapping per station" as an untried, larger-effort R&D direction, not yet closed off.
- **Honest gap:** nonlinear ML post-processing (gradient-boosted trees, distributional regression) was never
  actually built and run — only its linear cousin (regression MOS) and a linear correlation residual search
  were. The low R² makes the prior for a nonlinear model finding meaningfully more signal weak, but it isn't
  formally zero — this is the one item in the whole external report that isn't already answered by an exact
  test. It would be cheap to check (same archived data, no new capture) and belongs at the same "Tier 1,
  read-only, low-to-medium prior" level as `SIGNAL-BACKLOG.md` items 2–4, not as an urgent pivot.

**Verdict: EMOS done; linear MOS killed with a number; nonlinear ML genuinely untested but low-prior given
the R²=0.60% residual-structure finding. Worth a cheap flag, not a rebuild.**

### 2.2 "Nowcasting via METAR" — tested explicitly (WO-4), and killed with the sharpest number in the whole program

The report's pitch — build a short-term autoregressive METAR model to "scalp mispricings intraday while
slower bots rely on stale macro data" — is **exactly WO-4**, already built (`packages/core/src/weather/metar.ts`,
`metar-nowcast` edge function, `*/15 * * * *` cron) and already measured against the market, not just against
the forecast:

- The running-max + climatological-lift nowcast **does** beat the NWP blend badly (h15: NWP 1.18°C →
  nowcast 0.65°C, +45%) — that's the report's premise, confirmed.
- But against the **market**, not the forecast, by early afternoon the market is *already better than the
  nowcast and essentially at the oracle ceiling*: h15 market RMSE 0.40 vs nowcast 0.65 vs oracle-min 0.43.
  "Arriving at h15 with a 0.65°C estimate to trade a 0.40°C market makes you the sucker, not the sharp."
  (`FINDINGS.md` Arc 1, `FORECASTING-RD.md` WO-4.)
- WO-5 goes one step further and asks the report's implicit follow-on question — is there a *latency* window
  even after a fresh METAR print, before the market reprices? **No**: realizable (bid) dead mass on
  logically-dead buckets is median 0.0000 across 756 station-days/18k polls; only 1.39% of polls clear the fee
  even gross; no decay pattern (would indicate a repricing lag; there isn't one). "The market is efficient
  w.r.t. the hard running-max floor."

**Verdict: not a gap, it's a specifically-named, specifically-measured KILL** — one of the sharper numbers in
the whole document (market RMSE beats a nowcast method the report proposes as the edge, at the exact hour the
report says to trade it).

### 2.3 "Active Hedging" — this is literally the live surviving lever, described from scratch

"Do not default to hold-to-resolution... if a purchased share's value doubles and your model agrees with the
new price, sell to lock in EV and recycle capital" — this is a plain-English description of the maker-exit
mechanism currently under forward test:

- `packages/core/src/sim/opening-maker-exit-replay.ts`: enter directionally, then manage the position
  actively via take-profit (resting maker sell at `entry + tpDeltaPp`), stop-loss (taker), and a hard
  time-stop — the opposite of hold-to-resolution.
- The project's own history shows *why* "active hedging" isn't a free upgrade you bolt on: the naive
  hold-to-resolution variant (bracket-exit taker) was tested and reduces to the day-before forecast-vs-market
  bet, already killed 7× (`OPENING-CONVERGENCE-HANDOFF.md`). The version that works had to specifically be
  maker-only on the exit leg to dodge the taker round-trip spread (`CONVERGENCE-TUNING.md`: the raw
  convergence price-path edge is real, +8.2% frictionless, but a taker who tries to "actively hedge" by
  crossing the spread to sell early loses it — breakeven at ×0.70 of the real spread). Naive active
  management as a taker is *worse* than hold-to-resolution here, not better; only the maker-exit variant
  clears the bar.

**Verdict: this is the live gate of record, not a suggestion. The report is unaware it's describing the exact
mechanism already under forward paper test.**

---

## Section 3 — Bypassing Aggregator Latency (the one genuinely new angle)

This is the only section that isn't substantially pre-answered. Worth taking seriously on its own terms.

### What the report gets right
Open-Meteo is confirmed as the project's real data backbone (`docs/DATA-SOURCES.md`), and raw GRIB2 ingestion
from AWS S3 (`noaa-gfs-bdp-pds`, `ecmwf-forecasts`) / NOAA NOMADS / the `ecmwf-opendata` package is a real,
correctly-described alternative data path that this project has never built or benchmarked against.

### What the report gets wrong or overstates
- **The "15–60 minute delay vs institutional bots" framing conflates two different lags.** Model
  *computation* time — the gap between a model's nominal init time (00Z/12Z/etc.) and when its output exists
  at all — is a **universal floor that applies to every consumer**, including a bot parsing raw GRIB2 off
  AWS S3 the second it lands. `research/REPORT-weather-data.md` §6 measured this directly per model:
  DWD ICON ~4.2h, GEFS ~5–6h, GFS ~7.5h, **ECMWF IFS ~7.9h**, UKMO ~8.7h, JMA ~9.6h, GEM ~16h after their
  respective init times. Nobody — not this project, not a raw-GRIB bot, not Polymarket's fastest sharp —
  gets ECMWF's 00Z run before ~08:00Z, because ECMWF hasn't finished computing it before then. The report's
  "institutional bots parse raw data straight from the supercomputers" framing implies a compute-time
  advantage that doesn't exist for a downstream consumer; the actual edge from raw GRIB (if any) is a
  narrower **distribution-mirror lag**, not the ~4–16h compute lag.
- **Open-Meteo's own distribution lag is measured, and it's small.** The same report notes: "data is
  eventually consistent across servers — wait +10 min after update for the freshest run." That's a ~10-minute
  mirror lag from Open-Meteo's own ingestion of the model's output, not 15–60 minutes, and it's dwarfed by the
  4–16h model-compute floor above. A raw-GRIB pipeline would only close that ~10-minute gap, not the multi-hour
  one the report's narrative implies it closes.
- **The project already measured the market's reaction speed to fresh information, twice, and both times the
  market won.** WO-4 (§2.2 above): by early afternoon the market is already at the oracle ceiling for the
  *fastest-updating* information channel that exists (live METAR observations, refreshed every ~15–30 min,
  faster than any model cycle). WO-5: no measurable repricing lag after a fresh print even at 1.39%-clears-fee
  resolution. Both results predate and directly bear on the report's specific hypothesis (does the market lag
  a *model-run revision* the way it doesn't lag a *METAR print*) — the honest prior, stated candidly, is that
  this generalizes the same way, but it hasn't been directly tested.

### Where this actually sits in project priorities
`SIGNAL-BACKLOG.md` item 10, **"Model-update-shock latency,"** already exists and is precisely this
hypothesis — "does the market lag a large single-run forecast revision by an exploitable window" — pre-scoped,
pre-gated (must clear the real taker round-trip cost), and explicitly tiered **Tier 3, low prior, "do this
last, and only if items 1–6 are exhausted"** — for exactly the reason above: it's the same "is the market slow
to react to new information" family WO-4/WO-5 already tested twice and the market won both times.

**The report's proposed engineering cost is large and mis-scoped for that prior.** Binary GRIB2 parsing
(`xarray`/`cfgrib`/`wgrib2`), spatial interpolation from a global grid to 46 airport points, and an AWS
pipeline are a multi-week infrastructure build to test a hypothesis two independent, already-completed
measurements predict will die the same way. If it's tested at all, it should be tested the way item 10 is
already scoped: cheap, off already-ingested model-run-history data, comparing the market's price-reaction speed
to the blend's own model-run history — no GRIB parsing required to get a first answer on whether there's
anything there before building the expensive plumbing.

**Verdict: real gap, correctly triaged already. The report's proposed order of operations (build the
expensive pipeline first) inverts the project's own discipline (cheap gate first, expensive build only if the
gate clears) — every other lever in this program's history was killed cheap before anything expensive got
built, and this is the one item where the report would have you build expensive first.**

---

## What, if anything, changes

Nothing changes about current priorities. For the record, here's the one-line disposition of every claim:

| External-agent claim | Disposition |
|---|---|
| Shift to maker strategy | **Already the live gate of record** (`/maker-exit`); naive-maker adverse selection already measured and is why the naive version of this recommendation is wrong |
| WebSocket order-book tracking | **Not needed as primary** — REST already runs 30s/2–10min cadence; WS deliberately scoped as optional fill-latency-only, documented tradeoff |
| NegRisk Kelly sizing | **Already built** (`kelly.ts::jointKellyStakes`), matches the cited academic construction exactly |
| EMOS / ML post-processing | **EMOS already core**; linear MOS killed (−3.32%); nonlinear ML untested but low-prior (R²=0.60% on the same residual) — the one legitimate small gap |
| METAR nowcasting | **Tested and killed** (WO-4) — the market beats the exact nowcast method proposed, at the hour proposed |
| Active hedging | **Already the live lever's core mechanism** (maker-exit TP/SL/time-stop); naive taker-side active management already tested worse than hold |
| Raw GRIB / AWS S3 latency arb | **Real gap, already triaged** (`SIGNAL-BACKLOG.md` item 10, Tier 3/low-prior/last); report overstates the achievable latency win and inverts the project's cheap-gate-first discipline |

If the operator wants to act on anything from this crosscheck, the only two candidates are: (1) a cheap
nonlinear-ML residual-structure check reusing the existing archived data (no new capture, no capital, same
tier as `SIGNAL-BACKLOG.md` items 2–4), and (2) leaving item 10 exactly where it already sits. Neither is
urgent, and neither should interrupt the FASTTRACK sprint or the live forward paper-loop gate currently in
flight.
