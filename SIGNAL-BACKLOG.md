# Signal Backlog — untested angles, for future implementation

> **Status update 2026-07-03 (later): items 1a, 1b, 5, 7, 9 are BUILT/ANSWERED.** Operator-approved
> engine work (1b reward-accrual + 5 basketSize) landed in `packages/core/src/sim/opening-maker-exit-replay.ts`
> — pure engine changes, tested locally (PGlite/vitest only, **no prod/DB/API contact**), full core
> suite green (42 files / 980 tests), typecheck clean. Items 1a/7/9 were docs/API research questions —
> answered below, no code required. Items 2–4, 6, 8, 10 are still PLANNING ONLY (not built). This
> document was originally written 2026-07-03 after a full re-read of `FINDINGS.md` (18 angles tested,
> 17 killed, 1 marginal survivor under live forward test) so a future session doesn't have to
> re-derive "what haven't we tried" from scratch. **Standing rule for everything still unbuilt: do not
> start work without an explicit operator go-ahead** — new taker/maker-edge work only opens on
> genuinely new information or a deliberate operator decision (see `FINDINGS.md`'s closing section).
>
> **At time of writing:** the live forward maker-exit paper loop (`/maker-exit`) is the active gate
> of record and a separate long-running research agent may be executing tests against this repo —
> the 1b/5 build above was pure local `packages/core` engine code + vitest, never touched prod/DB/
> live APIs, so it did not interfere. Items marked Tier 1 are read-only analysis over already-captured
> historical data and don't touch prod, cron, or capital; they're the safest to pick up next.

> **↳ UPDATE 2026-07-09 (C23) — the PRICING-BUCKET DATA surface is now EXHAUSTIVELY closed, incl. the
> one genuinely-orthogonal slice (cross-bucket ladder geometry).** Operator "leave no stone unturned"
> sweep (`PRICING-BUCKET-EXHAUSTIVE.md`): every axis of the bucket-price data mapped to a kill —
> single-bucket level/path/book (C19–C22) + **new**: high-band 55–95¢ calibration (calibrated, T1),
> **cross-bucket unimodality-violation fade** (KILL frictionless +2.95pp CI[−1.54,+7.44]; **−8.72pp on
> the real book**, T2/T3), whole-ladder sharpness/entropy over life (calibrated, T4). **Price is a
> sufficient statistic on the ladder VECTOR, not just the single bucket** — any future price-only angle
> is a re-skin. The still-open directions are NOT price slices: forecast-conditioned regime efficiency
> (#3, unproven-dead, needs ≥10 Q4 wx-days), impossible order-placement data (#7), new instruments (#9).

## Why these and not others

Every angle FINDINGS.md killed collapses into exactly two mechanisms: **(a)** forecast-conditioned
taker bets die to adverse selection (copy-trade, maker-spray, sharp-stacking, bracket-exit taker,
fluctuation-taker — 4 independent confirmations), or **(b)** forecast-free two-sided market-making
dies to the fee wall or fill/inventory cost (reward farming, complete-set arb, negRisk mint,
cross-venue). The one survivor (maker-exit) works *because* it's neither — a directional,
information-informed entry with a maker-only exit. Every item below was chosen because it is
**mechanistically distinct** from all 18 — it doesn't re-run a falsified test with new labels.

---

## Findings — the pattern across all 18 prior tests, with the numbers

Restated here (not just cross-referenced) so this backlog is self-contained and every priority call
below traces to a real measured figure, not a qualitative impression.

**Mechanism A — forecast-conditioned taker bets die to adverse selection.**

| Signal | Key number | Source |
|---|---|---|
| Copy-trade badatmath's fills | taker-follower **−6.05pp** vs the sharp's own +1.34pp | WALLET-RECON §11 |
| Maker-spray (rest our own cheap bids on our forecast) | **−1.46pp** CI[−2.51,−0.41] (all) / **−1.73pp** CI[−3.16,−0.30] (forecast); both exclude 0 | WALLET-RECON §12 |
| Sharp-as-forecaster stacking | **−1.74pp/−1.20pp**, CI excludes 0; zero-skill P(PASS)=0.0% | WALLET-RECON §14 (Move 5) |
| Bracket-exit taker (12th signal, hold-to-resolution variant) | reduces to the day-before bet, already **−1.7pp** at the forecast center | OPENING-CONVERGENCE-HANDOFF |
| Fluctuation-taker (dip/momentum on the key-bucket set) | **−15.8% / −$2,002 FULL**, 0/384 cells pass even in-sample, top-10 ciHigh < 0 both directions | FLUCTUATION-TAKER.md |
| badatmath replica, taker curve | **+3.9%** vs the maker-ideal +19.3% — a **15.4pp spread tax** just for crossing | BADATMATH-REPLICA.md |

**Mechanism B — forecast-free two-sided market-making dies to the fee wall or fill/inventory cost.**

| Signal | Key number | Source |
|---|---|---|
| Reward farming (two-sided maker quoting both sides) | **−47%/day** measured fill/inventory cost ≈ **8×** the ~6%/day reward income | REWARD-INVENTORY-BACKTEST §4 |
| Complete-set structural arb | taker fee > mispricing; only **0.37%/0.06%** of instants clear, live **0/107** | COMPLETE-SET-ARB.md |
| Cross-venue RV (Kalshi↔Polymarket) | quoted edge real (6/7 city-days net-positive) but executable depth only **1–10 contracts** | CROSS-VENUE-SPIKE.md |
| Lane B — negRisk mint-and-sell (the maker-route dual of complete-set) | **0/16** winFrac at executable depth, 95% CI [0,0] | COMPLETE-SET-ARB-HANDOFF.md |
| Lane D — complete-set on the depth axis | **0/5** fee-cleared instants also clear at binding depth ≥25 | COMPLETE-SET-ARB-HANDOFF.md |

**The one survivor breaks the taxonomy by construction.** Maker-exit is a directional,
information-informed **entry** (sidesteps mechanism B's blind-both-sides problem — you already hold
correctly-selected inventory, you're not quoting into the void) with a **maker-only exit** (sidesteps
mechanism A's taker-crosses-the-spread problem). It measures **+5.1%/+$313** with the rebate
(MAKER-EXIT-SIM.md) vs the taker's −3.0% on the identical strategy — the only tested structure that
dodges both walls at once. Every item in this backlog was screened for that same property (does it
plausibly dodge BOTH mechanisms, not just one) before being listed — that screen is what the
priority order below actually encodes.

---

## Priority order

| # | Angle | Tier | Effort | Touches prod/capital? | Plausibility |
|---|---|---|---|---|---|
| 1a | Reward-eligibility pre-check (does a resting sell even qualify?) | 1 | **Minutes** | No | Gate before 1b |
| 1b | [Reward-stacking on the maker-exit sell leg — full backtest](#1-reward-stacking-on-the-maker-exit-sell-leg) | 1 | Low | No (backtest only) | **High** |
| 2–4 | [Post-bust reaction](#2-post-bust-reaction-pricing) + [conditional efficiency by regime](#3-conditional-efficiency-by-forecast-uncertainty-regime) + [extreme-day tail calibration](#4-extremetail-day-calibration-check) — **run as ONE data-pull, three conditioning splits** (see note below) | 1 | Low | No | Medium-high |
| 5 | [Multi-bucket basket entry](#5-multi-bucket-basket-entry) | 2 | Medium | No | Medium |
| 6 | [Cross-horizon (day+1/day+2) information-propagation lag](#6-cross-horizon-day1day2-information-propagation-lag) | 2 | Medium | No | Medium-low (same forecast-timing family as 5 already-killed mechanism-A tests) |
| 7 | [Sharp order-arrival (not fills) as a leading indicator](#7-sharp-order-arrival-not-fills-as-a-leading-indicator) | 3 | Medium-high | No | Low-medium |
| 8 | [Cross-city portfolio sizing (Kelly / risk-parity)](#8-cross-city-portfolio-sizing-kelly--risk-parity) | 3 | Medium | Only once live capital exists | Low (not a new edge) |
| 9 | [New instrument: precip / snow / wind markets](#9-new-instrument-precip--snow--wind-markets) | 3 | High | No (research phase) | Low-medium |
| 10 | [Model-update-shock latency](#10-model-update-shock-latency) | 3 | Medium | No | Low |

**Build status (2026-07-03, later pass — orchestrator-greenlit local-only work):**
**1a✅ answered · 1b✅ built+tested+wired into sim-maker-exit.ts's CLI (`--reward-pool/--reward-max-spread/--reward-share`)
· 5✅ built+tested+wired (`--basket-size`) · 7✅ answered (KILL) · 9✅ answered (KILL) · 2/3/4✅
pre-registered + analysis script written (`conditional-efficiency-scan.ts`, SQL prepared, NOT executed —
no DB connection opened) · 8/10 remain PLANNING ONLY.** Nothing has touched prod/DB/live APIs except the
one read-only Gamma curl for item 9. Full core suite + scripts suite green, whole-repo typecheck clean
after every change in this pass.

**Sequencing notes (the actual update this pass):**
- **1a before 1b.** Checking whether Polymarket's reward-pool eligibility rule even applies to a
  one-sided resting sell (vs. requiring a live two-sided quote) is a documentation/API read, not a
  backtest — do it first, in minutes, before touching the engine. If it doesn't qualify, 1b is a
  same-day KILL and the backlog moves straight to item 2.
- **2, 3, and 4 all read the same base table** — the day-before price archive + resolved outcomes
  used by KILL-GATE 2 (`WALLET-RECON-HANDOFF.md` §10). They differ only in how the same rows get
  sliced (by prior-day surprise, by ensemble-disagreement quartile, by climatological percentile).
  Pull that dataset once and run all three conditioning splits against it in the same pass rather
  than three separate data pulls.
- **6 is downgraded** from the original pass — on reflection it's still a forecast-timing bet crossed
  as a taker, the same family as 5 of the 6 mechanism-A kills above; it's mechanistically distinct
  enough to be worth a cheap check but shouldn't be expected to survive where copy-trade, maker-spray,
  bracket-exit, and fluctuation-taker did not.

---

## 1. Reward-stacking on the maker-exit sell leg (1a: eligibility pre-check, 1b: full backtest)

> **✅✅ 1b RUN + ADJUDICATED — gate-PASS (2026-07-03 ~18:30, orchestrator).** Run on the 844-event/45-city/
> 21-day cache, pinned config frozen, `--reward-pool 67 --reward-max-spread 4.5`, share swept
> {0.05, 0.10, 0.25, 0.50}: full-panel ciLow **+0.25% → +2.38% / +4.48% / +10.67% / +20.69%**; TRAIN+TEST
> both independently PASS from share 0.10; reward delta exactly linear in share (engine deterministic).
> **The pre-registered gate (ciLow moves materially toward/past 0, all else frozen) is met at every swept
> share including the conservative floor.** Standing caveat: `myPoolShareIfQualifying` is an ASSUMPTION —
> the competition denominator has never been measured; $67/day is a derived per-market average (real range
> $66–$226 observed 06-24). The backtest cannot resolve the share; only a forward/live read can. Recorded
> in `FINDINGS.md`. Possible follow-on (OPERATOR decision, not scheduled): extend the forward paper panel
> to track reward-qualifying ticks so the live loop measures the share assumption directly.

> **✅ 1a ANSWERED, 1b BUILT + TESTED (2026-07-03).**
>
> **1a — the eligibility pre-check found the EXACT docs-verbatim formula already in this codebase**
> (`core/sim/reward-farming.ts`, REC-8): Polymarket scores a resting order by `spreadScore(v,s) =
> ((v−s)/v)²` (closeness to mid) combined via `makerQmin`: in mid ∈ [0.10, 0.90], a ONE-SIDED quote
> (no matching bid) scores `Qtwo/c` (c=3.0 — a real but DISCOUNTED, non-zero credit); in the strict
> mid < 0.10 or > 0.90 regime, a one-sided quote scores **ZERO** (two-sided is mandatory there). The
> maker-exit's resting SELL sits at `entry + tpDeltaPp` (≈ entry+0.12 in the tuned config), which for
> realistic cheap entries clears 0.10 in all but the most negligible near-zero-entry edge cases — so
> the resting TP typically lands in the **partial-credit [0.10,0.90] zone, not the zero zone**. Verdict:
> **PARTIALLY ELIGIBLE, not a gate-fail** — proceed to 1b, but do NOT assume full two-sided credit.
>
> **1b — built the reward-accrual term** (`MakerExitCfg.rewardCfg`, optional/unset=0 accrual, byte-
> identical to every existing caller) directly reusing `makerQmin`/`sideScore` from `reward-farming.ts`
> (no new formula). Per resting-tick, eligibility is evaluated on the PRIOR tick's mid (no look-ahead);
> the dollar magnitude uses a SWEPT `myPoolShareIfQualifying` assumption (default-0 conservative floor,
> mirroring the existing `makerRebateRate` precedent — the competition denominator is still the
> dominant unknown per `reward-farming.ts`'s own comment, this does not reconstruct a live competitor
> book). New field `MakerExitTrade.rewardUsd`, additive to `netPnlUsd`. 9 new tests (pure-formula edge
> cases + end-to-end accrual + additivity to netPnlUsd), all passing; full 980-test core suite green,
> typecheck clean. **Not yet run against the real panel cache or wired into `sim-maker-exit.ts`'s CLI
> sweep** — that's the natural next step once an operator wants the backtest re-run with reward income
> included.

**Question.** The maker-exit's resting take-profit order already earns the maker fee rebate
(measured: +5.1%/+$313 vs the taker's −3.0%). Polymarket separately runs a funded liquidity-reward
pool on weather markets (REC-3/4: 395/396 temp markets funded, real USDC/day). REC-10 found reward
farming net-negative — but only for a **naked two-sided** maker quoting both sides blind. The
maker-exit's sell leg is different: it rests *after* an information-informed, already-owned
directional position, so it never eats the buy-side adverse selection that killed REC-10. Does that
resting sell order also qualify for the reward pool, and if so, does adding that income to the
already-marginal maker-exit backtest tighten the CI (push ciLow further from 0, or shrink the number
of forward-paper days needed for a clean PASS)?

**Why distinct.** Not a re-test of REC-10 (that was two-sided; this is one-sided with inventory
already correctly selected) and not a re-test of the maker rebate (that's the taker-fee-schedule
rebate, a different Polymarket mechanism than the reward-pool USDC payout).

**Reuse.** `market_rewards` table + scoring logic from REC-3/4 (`scripts/reward-monitor.ts`,
`core/polymarket/rewards.ts`); the maker-exit engine `core/sim/opening-maker-exit-replay.ts`; the
already-built 819-event/45-city/20-day panel cache from `sim-maker-exit.ts --build-cache`.

**Build plan.** **(1a)** Confirm reward-pool eligibility rules for a resting sell order specifically
(spread-from-mid band, min size) against the recorded `market_rewards` schema — minutes, no code.
**(1b, gated on 1a returning "eligible"):** (2) Add a reward-accrual term to the maker-exit engine —
income accrues per tick the TP order rests within the qualifying band, pro-rated by the pool's
scoring formula (same formula REC-8's plan/reconcile harness already implements — reuse, don't
reinvent). (3) Re-run the pinned §9R-E config with and without reward income; compare CI
width/position.

**Pre-registered gate.** PASS iff adding reward income moves ciLow measurably closer to (or past) 0
on the same 819-event panel, without changing any other assumption. If reward eligibility doesn't
apply to one-sided resting sells (a real possibility — check the eligibility rule before building
anything), this is a fast, cheap KILL.

**Effort.** Low — no new capture, no new statistical framework, additive term on an existing engine.

---

## 2. Post-bust reaction pricing

> **❌ RUN + ADJUDICATED — KILL (2026-07-03 ~18:45, orchestrator).** First real execution of the staged scan
> (`--from 2026-04-21 --to 2026-06-21 --split-date 2026-05-27 --leads 1,2`, 2 520 station-day decision
> points, TEST half only): 202 bust-triggered test days → n=84 graded bets (≥40 bar met), edge **+2.91pp,
> 95% CI [−3.21, +9.03] — straddles 0** → the pre-registered gate (positive CI excluding 0) fails. A
> measured null. Recorded in `FINDINGS.md`.

> **✅ PRE-REGISTERED + SQL PREPARED, NOT EXECUTED (2026-07-03, later pass).** Definitions locked BEFORE
> any query runs, per this project's own OOS discipline (train/test split, never fit-and-score on the
> same days):
> - **Bust, precisely:** for station S on day N, `bust_N = |obs(N) − mu_N|` where `mu_N` is the SAME
>   walk-forward EMOS blended μ (`EmosStation.blendedMu`, lead 1) already computed BEFORE that day's
>   truth is folded — i.e. the forecast as it stood at decision time, never a look-ahead-corrected
>   value.
> - **Cutoff, pre-registered:** the P75 of `|bust|` PER STATION, fit on the TRAIN half of the window
>   only (date-split, same `splitByDate`-style 60/40 convention `sim-maker-exit.ts --split` already
>   uses) — the TEST half is scored against a cutoff it never influenced.
> - **The test:** for each TEST-period bust day N (`bust_N ≥` the station's train-fit P75), pull city
>   S's day-before ask for event N+1 (the exact `asksByEvent` query `db1-daybefore-efficiency.ts` already
>   runs) and compute the SAME edge metric KILL-GATE 2 uses (`calibratedP − ask`, cheap `<0.25` subset)
>   for that next-day event, scored with `armEdgeStats`.
> - **Pre-registered gate:** PASS iff ≥40 bust-triggered events, ≥6 cities, edge 95% CI excludes 0 on
>   the positive side, scored ONLY on the TEST half.
>
> Implementation: `scripts/research/conditional-efficiency-scan.ts` (shared with items 3–4 below — one
> data pull, three conditioning splits, per the sequencing note). **Not run** — no DB connection was
> opened this session.

**Question.** When yesterday's forecast (ours or the market's) missed badly — the realized Tmax
landed far from both — does today's *freshly listed* ladder for the same city show a systematic
over- or under-reaction (anchoring on yesterday's surprise, or conversely over-correcting away from
it), distinguishable from our own forecast's fair value? This is a **fresh-listing mispricing**
question, not a day-before-the-same-event question (already killed 7× as KILL-GATE 2).

**Why distinct.** KILL-GATE 2 and its five angles all test "does our forecast beat the market's price
on THIS event." This tests whether a **large realized surprise on event N** predicts a mispricing in
the **unrelated fresh listing for event N+1** (same city, next day) — a behavioral/anchoring
question, not a forecast-skill question.

**Reuse.** Fully covered by existing archived data — resolved outcomes + archived fresh-listing
prices already sit in the historical price/resolution tables used by `WALLET-RECON-HANDOFF.md` and
`CONVERGENCE-TUNING.md`'s history-replay ingest. No new capture campaign needed.

**Build plan.** (1) Define "bust" (e.g., |realized − forecast median| in the top quartile per
station, or |realized − prior day-before market implied| — pick one, pre-register it). (2) For each
bust day, pull the SAME city's next-day fresh-listing price at first quote and compare its implied
distribution to our calibrated forecast for that next day. (3) Split by bust direction (hot surprise
vs cold surprise) to check for a directional anchor.

**Pre-registered gate.** Same discipline as every other signal: ≥40 bust events, ≥6 cities, CI on
the mispricing excludes 0, walk-forward (not the same window used to define "bust").

**Effort.** Low — a new query + analysis script, no new engine.

---

## 3. Conditional efficiency by forecast-uncertainty regime

> **✅ RE-OPENED ON THE LIVE PANEL + RESOLVED — KILL, well-powered null (2026-07-09, C24).** The re-open
> criterion (**≥10 distinct Q4 weather-days in a TEST period**) is now **MET** — but the signal dies. The
> 2026-07-03 blocker was that the pre-registered scan reads `forecast_snapshots snapshot_slot='backfill'`, a
> one-time reconstruction **frozen at 2026-06-15**; re-running it reproduces the same 3 Q4 days. The live
> `10Z`/`22Z` operational slots (06-13→present) are the SAME 8 models with mean signed bias **+0.047°C** on
> their overlap (≈0 — clean transfer, trap #12 cleared). New script `conditional-efficiency-live.ts` warms
> up + fits TRAIN quartile cutpoints on `backfill` (≤06-15) and scores the TEST **entirely on the live 10Z
> panel** (06-16→07-08). Result: **21 distinct Q4 weather-days** (7× the original 3), Q4 per-bet edge
> **+1.16pp [−0.41,+2.73]** (straddles 0 even i.i.d.), **day-clustered +1.05pp [−1.11,+3.20]** (includes 0 →
> gate FAIL), station-clustered +2.73pp [−1.54,+6.99], permutation false-pass 2.6%. **22Z robustness:** 22
> Q4 days, day-clustered +1.10pp [−0.83,+3.04] — same KILL. There is a faint monotone gradient (Q1 −0.67 →
> Q4 +1.16pp: higher disagreement → very slightly larger edge) but it is ~1pp, CI-includes-0 at every
> clustering level, and −EV after the taker fee + spread. The 2026-07-03 +7.47pp was noise from 3 correlated
> days; with 7× the independent power it collapses to ≈+1pp non-significant. **Item #3 is now dead
> (well-powered), not merely unproven.** Typecheck clean; both live slots agree. Re-open would now require a
> DIFFERENT hypothesis, not more days. `scripts/research/conditional-efficiency-live.ts`, FINDINGS.md C24 row.
>
> **⚡ RUN + ADJUDICATED — gate-PASS, PROVISIONAL (2026-07-03 ~18:45, orchestrator).** Same run as item 2:
> TEST-half quartiles Q1 −0.04pp [−4.17,+4.09] n=123 · Q2 +4.59pp [−0.80,+9.98] n=95 · Q3 +2.63pp
> [−2.20,+7.46] n=122 · **Q4 +7.47pp [+1.06,+13.87] n=104** — the pre-registered pass cell is met
> (Q4 CI excludes 0 positive, n≥30) and Q1–Q3 replicate the pooled null as required. **PROVISIONAL until a
> hardening pass survives:** (a) cluster-robust CI by weather-day and by station (the reported CI's
> clustering is unverified — per-bet CIs overstate independence), (b) zero-skill permutation of quartile
> labels (the zsp discipline every §9R-E verdict uses). Dispatched as `item3-hardening` per the day-0
> pattern that caught the cross-venue false-PASS. If the PASS survives hardening, what to DO with it is an
> OPERATOR decision (FINDINGS' closing rule: it would constitute genuinely new measured information).
>
> **⚪ HARDENING COMPLETE — PASS REVOKED, final NO-PASS / INSUFFICIENT_DATA at the day grain (2026-07-03
> ~19:30, orchestrator; hardening script lens-reviewed ZERO DEFECTS + reproduced bit-for-bit by an
> independent agent).** The naive CI was per-bet i.i.d. (`stats.ts:195`); Q4's 104 bets = 29 station-days
> on **3 distinct weather-days** (high-disagreement days are synoptic — they hit many stations at once,
> which is exactly why per-bet independence fails here): day-clustered CI **[−7.86, +23.09]** (k=3, t=4.3),
> station-clustered **[−0.43, +13.62]** (k=21), permutation (2000 iters, seed 20260703) false-PASS rate
> **17.3 %**, P(mean ≥ +7.47pp) 6.85 %. Additional gate-prose note: the pre-registered "≥30 station-days"
> bar was de-facto applied as bet count; Q4's true station-day count (29) fails the strict reading
> outright. **The hypothesis is unproven, not disproven** — the point estimate is positive at every
> clustering level; days are the scarce resource (same lesson as the maker-exit LODO fragility). Re-open
> criterion: ≥10 distinct Q4-carrying weather-days in a TEST period. Recorded in `FINDINGS.md`.

> **✅ PRE-REGISTERED + SQL PREPARED, NOT EXECUTED (2026-07-03, later pass).**
> - **Disagreement metric:** reused VERBATIM from `l3b-residual-structure.ts` (population stddev of
>   bias-corrected per-model points around their mean) — not re-derived. Added as a new public method
>   `EmosStation.disagreement(points, lead)` in `db1-daybefore-efficiency.ts` (additive, tested, zero
>   change to any existing method — the 18-test suite there still passes byte-identical).
> - **Cutpoints, pre-registered:** quartile boundaries (P25/P50/P75) of disagreement, fit PER STATION on
>   the TRAIN half only (same split as item 2) — classification into quartiles 1–4 on the TEST half uses
>   cutpoints it never saw.
> - **The test:** re-run KILL-GATE 2's exact edge metric (`calibratedP − day-before ask`, cheap subset),
>   split by which TRAIN-fit disagreement quartile the TEST day falls into.
> - **Pre-registered gate:** PASS iff the TOP quartile (disagreement Q4) shows edge 95% CI excluding 0 on
>   the positive side, ≥30 station-days in that quartile, TEST half only. Every other quartile is
>   expected to replicate the existing pooled null (a mismatch there would itself be a flag to
>   investigate, not a pass condition).
>
> Implementation: `scripts/research/conditional-efficiency-scan.ts` (shared script — see item 2). **Not
> run.**

**Question.** KILL-GATE 2 measured our-forecast-vs-market efficiency **pooled across all days**
(edge +0.46pp, CI straddles 0). Efficiency could still be regime-dependent: on high-ensemble-spread
days (genuine forecast uncertainty — a front passage, a convective outlook) does the crowd
under-react (anchor on climatology) while the model ensemble correctly widens? Split the same
KILL-GATE 2 measurement by ensemble disagreement quartile instead of pooling.

**Why distinct.** FORECASTING-RD's regime-conditional test (#4 in that table) asked whether **our
forecast's own accuracy** varies by regime (neutral, −0.05%/−0.02%). This asks whether **market
efficiency vs. our forecast** varies by regime — a different dependent variable, never conditioned
this way.

**Reuse.** The exact KILL-GATE 2 dataset and scoring code (`WALLET-RECON-HANDOFF.md` §10), plus the
ensemble disagreement feature already computed for FORECASTING-RD's residual-structure test.

**Build plan.** Re-run KILL-GATE 2's scorer with a disagreement-quartile split (pre-register the
quartile cutpoints on a held-out period, not in-sample). Report edge + CI per quartile.

**Pre-registered gate.** PASS iff the top disagreement quartile shows edge CI excluding 0 on the
positive side, on walk-forward data, holding at ≥30 station-days in that quartile. Every other
quartile is expected to replicate the existing null.

**Effort.** Low — re-slice existing output, no new capture or engine.

---

## 4. Extreme/tail-day calibration check

> **❌ RUN + ADJUDICATED — KILL, SIGN-REVERSED (2026-07-03 ~18:45, orchestrator).** Same run as item 2:
> 236 extreme TEST days → n=281 far-tail bets, realized-vs-ask gap **−1.73pp, CI [−2.77, −0.69]** —
> excludes 0 on the NEGATIVE side. The market **overprices** far tails on extreme days; the behavioral
> underpricing hypothesis is backwards (another cheap-longshots-lose confirmation, §12 family). Recorded
> in `FINDINGS.md`.

> **✅ PRE-REGISTERED + SQL PREPARED, NOT EXECUTED (2026-07-03, later pass).**
> - **Extreme day, precisely:** for station S, day N is extreme iff `obs(N)` sits at or beyond the P5 or
>   P95 of S's OWN climatology (native units, from the `observations` table — no external climatology
>   source needed, self-referential per station).
> - **Cutpoints, pre-registered:** P5/P95 fit PER STATION on the TRAIN half only (same split as items
>   2–3) — the TEST half's extreme-day flags never influenced their own cutoff.
> - **The test:** on TEST-period extreme days only, isolate FAR-TAIL buckets (≥2 buckets from that day's
>   calibratedP mode — a bucket the forecast treats as a longshot) and compare their day-before ask
>   (market-implied probability) to their realized win rate, scored with `armEdgeStats` (the same
>   edge-CI framework KILL-GATE 2 uses, applied to a `won`/`ask` pair per far-tail bucket instead of the
>   cheap-longshot subset).
> - **Pre-registered gate:** PASS iff ≥30 station-days classified extreme, CI on the tail-calibration gap
>   (realized win rate − ask) excludes 0 on the positive side (the market underprices the tail specifically
>   on genuinely extreme days). Given extreme days are rare by construction, `INSUFFICIENT_DATA` is an
>   honest, expected possible outcome here, same as REC-1's own data-density wall.
>
> Implementation: `scripts/research/conditional-efficiency-scan.ts` (shared script — see item 2). **Not
> run.**

**Question.** Isolate days where the realized Tmax sits in the station's climatological top/bottom
5%. Is the tail bucket's day-before market price systematically below its eventual realized
frequency specifically on these extreme days (a well-documented behavioral pattern — retail-heavy
markets under-price genuine tail events, anchoring on the "normal" range)?

**Why distinct.** KILL-GATE 2's Brier scoring is computed over the whole distribution, pooled across
all days — a small tail-calibration gap on rare extreme days would be invisible in an aggregate
Brier/edge number. This isolates exactly the subset where a behavioral mispricing is most plausible.

**Reuse.** Same day-before price archive as KILL-GATE 2; station climatology already exists (used
for the Amsterdam/city peak-hour models).

**Build plan.** (1) Pre-register the climatological percentile cutoff (top/bottom 5%) per station on
a period disjoint from the test window. (2) For each qualifying day, compare the day-before tail
bucket's price to the realized outcome (hit/miss), aggregate into a calibration curve just for this
subset.

**Pre-registered gate.** PASS iff the tail-bucket's realized win rate at entry price <0.15 is
measurably above the price-implied probability, CI excluding 0, at ≥30 station-days (extreme days
are rare by construction — this may hit `INSUFFICIENT_DATA` first, same honest outcome as REC-1).

**Effort.** Low — a filter + calibration-curve script over existing data.

---

## 5. Multi-bucket basket entry

> **⚠ FIRST MEASUREMENT VACUOUS + AMENDED SPEC PRE-REGISTERED (2026-07-03 ~18:30, orchestrator, BEFORE
> re-measurement).** Run under the pinned config, basket 2/3 came back **byte-identical** to basket 1:
> with `--chw 0` the candidate filter (`opening-convergence.ts:453`, `|idx − modeIdx| > centerHalfWidth`)
> admits ONLY the mode bucket, so `findBasketEntry` always sees one candidate and the basket engine
> degenerates to the single-bucket path. The gate was therefore never tested — NOT a KILL. Also found:
> `jackknife-maker-exit.ts` has no basket wiring (hardcoded params, always calls `replayMakerExitPanel`).
> **Amended spec, locked now:** basket sizes 2/3 run with `--chw 1` (mode ±1 → up to 3 candidates — the
> item's original "top-N by probability mass" intent requires a candidate set wider than 1 by construction);
> the comparison reference REMAINS the pinned chw=0 single-bucket baseline (LOCO 15/45, LODO 9/21);
> gate UNCHANGED: PASS iff jackknife fragility drops (fewer LOCO/LODO flips) without the point estimate
> moving materially negative. Wiring change required (add CLI args + basket dispatch + --out path to the
> jackknife harness — a committed, clean analysis script, not part of this file's author-agent's
> uncommitted work) — one review lens before adjudication.
>
> **❌ RE-RUN + ADJUDICATED — KILL (2026-07-03 ~19:05, orchestrator).** Basket 2/3 @ chw=1 (byte-identical
> to each other; the mode±1 candidate set caps the effective basket): full mean **3.78%** vs pinned 6.81%,
> ciLow **−3.23%** vs +0.25%, n 451; jackknife **LOCO 45/45, LODO 21/21 flips** vs baseline 15/45 + 9/21 —
> both gate prongs fail. Diagnostic control (chw=1, basket=1): 4.61% [−2.66,+7.49] — the chw widening alone
> is harmful (re-confirms the chw=0 tuning) and basket-splitting dilutes further. The dilution-KILL branch
> the original gate pre-named. Single-bucket pinned config remains the reference. Note: the planned review
> lens on the harness diff was WAIVED as non-load-bearing — the verdict is decided by the sim prong through
> the unmodified engine path; the harness numbers only corroborate (CIs match the sim to 4 decimals).
> `jackknife-maker-exit.ts` now carries the orchestrator-side CLI extension (uncommitted, default behavior
> byte-identical, typecheck clean). Recorded in `FINDINGS.md`.

> **✅ BUILT + TESTED (2026-07-03).** Added `replayMakerExitEventBasket` + `replayMakerExitPanelBasket`
> (new sibling functions in `opening-maker-exit-replay.ts` — `replayMakerExitEvent`/`replayMakerExitPanel`
> are UNTOUCHED and stay byte-identical regardless of whether `cfg.basketSize` is set, verified by the
> pre-existing 33-test suite passing unchanged before AND after). Splits `cfg.perPositionUsd`
> probability-weighted (normalized `modelProb`) across the top-`basketSize` candidates by modelProb
> (mode ± centerHalfWidth, same gates as the single-bucket path); each leg fills and exits
> independently via the SAME tested per-leg lifecycle (`runMakerExitLeg`, extracted from
> `replayMakerExitEvent` by a verified-behavior-preserving refactor — confirmed via the existing test
> suite passing unchanged before/after the extraction). A leg that never fills, or hits its own
> `no_runway` guard, is dropped — the other legs still realize independently. 7 new tests (degenerate
> basketSize:1 matches `replayMakerExitEvent` exactly; a hand-verified 2-leg probability-weighted P&L;
> requesting more legs than qualify caps rather than pads; a non-filling leg is dropped; totality;
> panel-level ledger/verdict). Full core suite (980 tests, 42 files) + whole-repo typecheck both clean.
> **Not yet run against the real panel cache** to see whether it actually tightens the maker-exit
> backtest's fragile jackknife CI — that measurement is the natural next step, not yet done here.

**Question.** Every prior test — including the live maker-exit survivor — enters a **single** bucket
(the forecast center). Does entering a small basket (top-2 or top-3 buckets by calibrated
probability mass) reduce variance enough to matter, given the maker-exit backtest's CI is currently
fragile (16/45 city-exclusions and 8/20 date-exclusions tip ciLow just under 0 in the jackknife)?

**Why distinct.** This does not claim new edge — it's a **variance-reduction** refinement to the one
mechanism that already works, not a new signal. Nothing in FINDINGS.md tested basket vs. single-bucket
entry.

**Reuse.** `opening-maker-exit-replay.ts` engine, same panel cache; needs a new engine option
(`basketSize` or similar) rather than a new engine.

**Build plan.** (1) Add a basket-entry option to the maker-exit engine — split entry stake across
the top-N buckets by calibrated probability, weighted by that probability. (2) Re-run the pinned
config at basket sizes 1 (baseline), 2, 3. (3) Compare CI width and jackknife fragility, not just
mean edge — the question is robustness, not point estimate.

**Pre-registered gate.** PASS iff basket size N reduces jackknife fragility (fewer city/date
exclusions tip ciLow<0) without moving the point estimate materially negative. If basket entry
merely dilutes the edge toward 0 (likely, since off-center buckets have worse hit rate), that's a
clean KILL of this refinement — the single-bucket config stays the reference.

**Effort.** Medium — new engine option + full re-sweep + jackknife re-run.

---

## 6. Cross-horizon (day+1/day+2) information-propagation lag

> **📌 PRE-REGISTERED (2026-07-03 ~18:55, orchestrator — locked BEFORE any measurement).**
> - **Information event:** day-N sibling market resolution at `R_N` (archive `resolvedAt`), city-day pairs
>   where the day-N+1 market has ≥2 h of price history after `R_N`.
> - **Signal (no look-ahead):** our day-N+1 calibrated distribution as of the LAST pipeline build strictly
>   BEFORE `R_N`; mispricing `m = calibratedP − ask` read at the FIRST captured tick ≥ `R_N`+20 min
>   (the achievable detection latency at capture cadence).
> - **Entry rule:** taker buy of the max-`m` bucket iff `m ≥ +5pp` and ask ≤ 0.60, entry window capped at
>   `R_N`+2 h (no qualifying tick in 2 h → no bet: a transient window exists early or not at all). Hold to
>   resolution.
> - **Gate:** PASS iff n ≥ 40 pairs, ≥ 6 cities, per-bet edge 95 % CI excludes 0 on the positive side
>   (day-clustered CI reported alongside as a sanity read). Honest prior: KILL (taker-crossed
>   forecast-timing family). If the archived/DB data cannot support this exact design (e.g. no pre-`R_N`
>   day-N+1 forecast snapshot recoverable), the outcome is INSUFFICIENT_DATA — the design is not to be
>   improvised around.
>
> **❌ RUN + ADJUDICATED — KILL, well-powered null (2026-07-03 ~19:50, orchestrator).** 902 sibling pairs
> (04-21→06-29, 45 cities; 224 lost to the `bucket_probabilities` 30-day retention prune — 75.2 %
> recoverable, a time-composition not outcome-conditioned loss): **n=568 bets / 44 cities** (bars 40/6
> cleared wide), edge **+0.80pp, CI [−1.74, +3.34]**; day-clustered (17 clusters) **+0.74pp
> [−2.14, +3.61]** — both snug around 0. No exploitable lag on the sibling-resolution channel; 3rd
> latency-family confirmation (WO-4, WO-5, now cross-horizon). Implementation
> `scripts/research/item6-crosshorizon.ts` (untracked). Lens waived — prior-consistent null, no behavior
> change. Recorded in `FINDINGS.md`.

**Question.** For the same city, day+1 and day+2 Tmax forecasts derive from the same NWP
initialization — their forecast errors are correlated. When day+1 resolves (or its intraday
running-max nowcast sharpens), does the market efficiently update day+2's price, or does it lag
relative to how fast our forecast pipeline could re-price day+2?

**Why distinct.** WO-4 showed the market is at the oracle ceiling for the **same-day** running-max.
This asks about **cross-contract** propagation — whether the market treats each day's ladder as
independent (under-updating the out-day) or properly correlates them. Never tested; requires joining
two different markets' price histories for the same city, which no prior signal did.

**Reuse.** Needs a new join across adjacent-day markets in the archived price-history tables (the
same tables `CONVERGENCE-TUNING.md`'s history-replay ingest reads) plus the forecast-error
correlation already implicit in the NWP blend.

**Build plan.** (1) For each city-day pair (day N resolves, day N+1 still open), measure day N+1's
market price movement in the hours immediately after day N's resolution/late-nowcast, vs. what our
forecast pipeline's own day N+1 update implies. (2) Compare update magnitude and lag.

**Pre-registered gate.** PASS iff the market's day+1 update lags our forecast's implied update by an
economically exploitable window (must clear the same taker-fee/spread hurdle as every other signal —
expect this to die the same way copy-trade and maker-spray did, since it's still a forecast-timing
bet crossed as a taker). Pre-register the lag-window threshold before measuring.

**Effort.** Medium — new cross-market join, new analysis, reuses existing forecast pipeline.

---

## 7. Sharp order-arrival (not fills) as a leading indicator

> **✅ KILL / DATA UNAVAILABLE, confirmed (2026-07-03).** Checked the repo's own migrations
> (`supabase/migrations/0004_markets.sql`): `market_snapshots` carries only `best_bid, best_ask, mid,
> spread, last_trade, book_top3` (an ANONYMOUS top-3-levels book snapshot, periodic/delta-deduped) —
> no wallet attribution, no order-placement/cancellation event log. Cross-checked against
> `packages/io/src/polymarket-wallet.ts` (the WALLET-RECON data spine): the ONLY wallet-attributed feed
> this project (or Polymarket's public API surface) exposes is `/activity` — **fills and
> settlements only** (`TRADE`/`REDEEM`/`MERGE`/`SPLIT` rows with `size, price, side`), never a
> resting-order-placement stream. This is not just "we haven't captured it" — Polymarket's public book
> is anonymous by design; only YOUR OWN orders are wallet-attributed to you via authenticated
> endpoints this project deliberately doesn't use (keyless/public-API-only, per the project's
> boundary). **INSUFFICIENT_DATA is actually IMPOSSIBLE_DATA from the public surface** — do not
> re-open this without a fundamentally different data source (which would mean privileged/
> authenticated access this project's boundary rules out). No code changed; grep-only research.

**Question.** WALLET-RECON tested copying badatmath's **fills** (executed trades) — killed,
−6.05pp, too slow. Untested: does the **placement** of a large sharp's new resting order (before it
fills, if ever) carry a fresh, fast-decaying information signal distinct from the fill itself — i.e.,
is the order itself informative even to someone who can't compete for the same fill?

**Why distinct.** Copy-trading fills requires beating the sharp to the same liquidity (structurally
impossible, per WALLET-RECON §11). This would use the mere existence of a fresh large resting order
at a new price level as a signal to act on *elsewhere in the book* (e.g., join the queue behind it,
or take a directional view without needing that exact fill) — a different competitive dynamic.

**Reuse.** Needs order-book **level history** (not just trade fills) for the sharp's wallet — check
whether `market_snapshots` (used by the complete-set-arb and cross-venue work) captures resting-order
placement/cancellation at sufficient resolution, or whether this needs new capture infrastructure
entirely (in which case the effort tier goes up, not down).

**Build plan.** (1) Data-availability check FIRST — do we have historical order-placement timestamps
at the wallet level, or only fills? If only fills, this is `INSUFFICIENT_DATA` immediately and should
not proceed to a build. (2) If available: define "fresh large order" (size/price-level threshold),
measure subsequent price drift over a short window, net of the fee/spread a taker would pay to act on
it.

**Pre-registered gate.** Same discipline as every prior signal — CI must clear the real taker
round-trip cost, not just show a raw drift. Given every other angle on this sharp's information
content has died to the same wall (§12 adverse selection, non-followable), the honest prior here is
low; this is worth a cheap data-availability check before any engine work.

**Effort.** Medium-high, contingent entirely on data availability — check before committing to a build.

---

## 8. Cross-city portfolio sizing (Kelly / risk-parity)

**Question.** Every backtest so far uses flat position sizing (fixed $ per bucket/city). Once/if the
maker-exit forward loop PASSes and real capital is authorized, does weighting stakes across the
45-city panel by inverse-variance or a Kelly fraction improve realized risk-adjusted return, given the
known per-city heterogeneity (Amsterdam is "the worst selector in the universe" at 52% vs. Karachi/LA
at ≥95%)?

**Why distinct.** This is **not a new edge** — it doesn't change any KILL to a PASS. It's a capital
allocation question that only matters after a PASS authorizes real money. Listed for completeness,
not urgency.

**Reuse.** Per-city hit-rate data already measured (the 2026-07-03 per-city source-accuracy sweep,
~2,100 events); maker-exit ledger decomposition already exists.

**Build plan.** Defer until the forward paper loop actually PASSes. At that point: backtest flat vs.
inverse-variance vs. Kelly-fraction sizing on the existing panel, compare Sharpe/drawdown, not mean
return.

**Pre-registered gate.** N/A until triggered by a PASS — this is a refinement to execute, not a
signal to falsify.

**Effort.** Medium, but **explicitly gated on item priority — do not build before the forward loop
resolves.**

---

## 9. New instrument: precip / snow / wind markets

> **✅ KILL, confirmed live (2026-07-03).** Queried Polymarket's public Gamma API directly (keyless,
> read-only — `gamma-api.polymarket.com/events`, the "Weather" tag id=84, plus `public-search` keyword
> sweeps for rainfall/snow/wind). Findings: the 64 active temperature-ladder events (this project's
> existing universe, tag_id=104596) have **median 24h volume $34,272**, with 58/64 (91%) clearing the
> $7k liquidity floor this project already uses as a hard entry requirement. By contrast, precip/wind
> markets are **sparse, one-off, seasonal events** (e.g. "where will it rain on the 4th of July",
> "highest Washington wind speed in July") — not a recurring daily ladder across stations — with 24h
> volume in the hundreds to low thousands (the one active wind market: **$802/24h**, well under the
> $7k floor; a keyword sweep for "rainfall" found no active recurring product at all). **The
> liquidity floor gate KILLs immediately, exactly as pre-registered** — no forecast pipeline is worth
> building for this. No code changed; this was a research-only check (one Bash/curl session against
> Polymarket's public API, no DB/repo contact).

**Question.** Everything tested is Tmax ladders. Does Polymarket carry liquid precipitation/snow/wind
markets, and if so, is that market less efficient than the heavily-arbitraged temperature ladders
(thinner sharp coverage, less mature crowd)?

**Why distinct.** A wholly different instrument class — the existing NWP ensemble and its calibration
history is Tmax-specific; precip/wind forecasting is a different, generally harder-to-calibrate skill
(precip is a probability-of-event forecast, not a continuous-variable point forecast) with no
existing model infrastructure here.

**Build plan (research phase only — do not build a forecast pipeline before this clears).**
(1) Check Polymarket's weather category for precip/snow/wind ladder markets and their real 24h volume
— is there enough liquidity to matter at all? (2) If liquid markets exist, assess whether a
calibrated forecast is even buildable from existing free data sources (the vault's public-APIs
directory — check before assuming a paid source is needed) at comparable skill to the Tmax ensemble.
(3) Only past both gates does a forecast pipeline become worth building.

**Pre-registered gate.** KILL immediately if 24h volume across precip/wind markets doesn't clear a
liquidity floor comparable to what made the Tmax universe worth building (check first, before any
forecast work).

**Effort.** High if it clears the liquidity gate (new forecast pipeline from scratch); low if it
doesn't (a volume check kills it in an afternoon).

---

## 10. Model-update-shock latency

> **📌 PRE-REGISTERED (2026-07-03 ~19:15, orchestrator — locked BEFORE any measurement).**
> - **Shock event:** for station S / target day D at pipeline build B_k (the 2×/day distribution builds),
>   `Δ_k = |blendedMu(B_k) − blendedMu(B_{k−1})|` at matching lead; a shock iff `Δ_k ≥` the per-station
>   P90 of Δ fit on the TRAIN half only (same 2026-04-21→06-21 window / 05-27 split as items 2–4).
> - **Signal (no look-ahead):** post-B_k calibratedP vs the first snapshot ask ≥ B_k+20 min;
>   `m = calibratedP − ask`.
> - **Entry rule:** taker buy of the max-`m` bucket iff `m ≥ +5pp` and ask ≤ 0.60, entry window capped at
>   B_k+2 h; hold to resolution. TEST half only.
> - **Gate:** PASS iff n ≥ 40 shock-bets, ≥ 6 cities, per-bet edge 95 % CI excludes 0 positive
>   (day-clustered CI reported alongside). Honest prior: KILL (WO-4/WO-5 both showed the market matches or
>   beats our reaction speed). If intraday post-build asks aren't recoverable at this resolution from
>   `market_snapshots`/archive, the outcome is INSUFFICIENT_DATA — do not improvise a different design.
>
> **⚪ RUN + ADJUDICATED — INSUFFICIENT_DATA, structural (2026-07-03 ~19:20, orchestrator).** The live
> 10Z/22Z 2×/day snapshot pipeline's rows begin at target-date **2026-06-13** — 17 days AFTER the
> pre-registered split (05-27) — so TRAIN holds **0** build-pair deltas (221 scoreable deltas, all TEST by
> construction), no per-station P90 is fittable, 0 shocks detectable. Compounding: `ops_downsample()`
> thins `market_snapshots` >30 d to 4/day — the 20-min/2-h ask-recovery is unrecoverable for ANY
> retrospective window old enough to have a proper split. Verdict: the item is only testable with a
> forward-designed capture; the low prior (WO-4, WO-5, item 6 — three latency-family nulls) does not
> justify building one. CLOSED as INSUFFICIENT_DATA; re-open requires ≥30 d accrued 10Z/22Z pairs + a
> forward ask-capture design. Implementation `scripts/research/item10-shock-latency.ts` (untracked).
> Recorded in `FINDINGS.md`.

**Question.** When a major NWP model run (00Z/12Z GFS/ECMWF) revises sharply — a front's timing or a
storm track shifts materially between runs — does the market lag the revision by an exploitable
window, distinct from WO-4's same-day running-max nowcast and WO-5's dead-bucket floor?

**Why distinct.** WO-4/WO-5 are about the market's reaction to **observed conditions** (the running
max). This is about reaction to a **new forecast input** (a model-run revision) before any
observation confirms it — a different information channel, though the same "is the market slow to
react to X" family.

**Reuse.** The blend's own model-run history (already ingested for the ensemble); day-before price
archive.

**Build plan.** (1) Identify historical cases of a large single-run forecast revision (top-percentile
Δ in the blend's center between consecutive runs for the same station-day). (2) Measure the market's
price reaction speed after each revision vs. our own pipeline's reaction speed.

**Pre-registered gate.** Same as every latency-family test — must clear the real taker round-trip
cost, and given WO-4/WO-5 already showed the market matches or beats our own same-day reaction speed,
the honest prior is this replicates that result at the model-run timescale too. Cheap to check, not
expected to survive.

**Effort.** Medium, low prior — do this last, and only if items 1–6 are exhausted.

---

## 11. Nonlinear-ML residual post-processing (added 2026-07-03 from EXTERNAL-AGENT-CROSSCHECK.md)

> **📌 PRE-REGISTERED (2026-07-03 ~19:25, orchestrator — locked BEFORE any measurement).** The one open
> gap the external-report crosscheck identified: linear MOS was killed (−3.32 %) and the linear residual
> search found R²=0.60 %, but a NONLINEAR post-processor was never run. Analytics-side (forecast skill),
> not a trading lever.
> - **Model, fixed in advance:** hand-rolled gradient-boosted stumps (pure TS, no new deps), deterministic
>   seed, fixed hyperparams (300 rounds · learning rate 0.1 · depth ≤ 2, chosen NOW, no tuning on TEST).
> - **Features:** the SAME leakage-free pre-decision feature set `l3b-residual-structure.ts` used
>   (ensemble disagreement, per-model deviations, lead, station identity, climatology anomaly) — no new
>   features invented mid-run.
> - **Target:** the walk-forward blend residual (obs − blendedMu), lead 1–2; window 04-21→06-21, split
>   05-27, TRAIN fit / TEST score only.
> - **Gate:** PASS iff the corrected forecast (blendedMu + predicted residual) beats the raw blend's TEST
>   MAE with a day-clustered bootstrap 95 % CI on the MAE delta excluding 0, over ≥30 TEST days and
>   ≥30 stations. Honest prior: low (the linear R² bound). INSUFFICIENT_DATA honest if coverage falls
>   short.
>
> **❌ RUN + ADJUDICATED — KILL (2026-07-03 ~19:45, orchestrator).** TRAIN n=3240/36 d: raw MAE 1.0123 →
> corrected 0.9291 °C (it fits TRAIN). TEST n=1800/20 d/45 stations: raw **0.9109** → corrected
> **0.9268 °C** — the correction is significantly HARMFUL (delta −0.0159 °C, day-clustered bootstrap CI
> **[−0.0280, −0.0051]**, seed 42/2000 resamples); TEST residual R² **−6.11 %** (linear in-sample bound
> was +0.60 %). Coverage note: 20 TEST days < the 30-day bar, but a harmful-side CI excluding 0 is not an
> INSUFFICIENT_DATA outcome; and the one soft leak (l3b's full-window climatology feature, disclosed by
> the runner) biases toward the model — it lost anyway. GBM implementation passed known-answer self-tests
> (step-function fit + noise-null). Implementation `scripts/research/item11-nonlinear-residual.ts`
> (untracked). Lens waived — prior-consistent negative, no behavior change. The external report's sole
> open gap is now CLOSED. Recorded in `FINDINGS.md`.

## 12. CITY-SCAN — historical city-sim replay across all 45 cities (operator-requested 2026-07-03 evening)

> **📌 PRE-REGISTERED (2026-07-03 ~21:10 local, orchestrator — locked BEFORE any measurement).** Analytics
> SELECTION study, not a capital gate: replay the city-sim $10/day predicted-bucket taker bet historically
> across every city × entry hour, to (a) shortlist "another Karachi" candidates for live paper-trade
> enrollment and (b) map the entry-hour pattern for future (paper) automation. Honest prior: mechanism-A
> pooled efficiency (KILL-GATE 2 + 5 confirmations) says the POOLED result should be ≈0; the question is
> per-city/per-hour heterogeneity, which only live forward data can confirm (Karachi precedent).
> - **Data:** local maker-exit cache (844 ev / 45 c / 21 d tick series, real asks) + `bucket_probabilities`
>   (latest house calibrated build strictly ≤ bet tick — no look-ahead); resolved winners from the cache.
> - **Bet rule (mirrors the live city-sim):** at the first captured tick ≥ hour H local (H ∈ {9..19},
>   city tz), buy $10 of the forecast-mode bucket at the real ask (city-sim ask/fee conventions reused
>   from the existing engine code, not re-derived), hold to resolution.
> - **Multiplicity control (THE point):** date split TRAIN = target days ≤ 2026-06-24, TEST = ≥ 06-25.
>   Selection ONLY on TRAIN: rank city×arm cells by the entry-watch shrinkage lower bound (reuse
>   `core/sim/entry-watch.ts`'s LB verbatim). Confirmation ONLY on TEST for the top-5 TRAIN cells:
>   net PnL + day-clustered CI. **Candidate bar: TRAIN LB > 0 AND TEST net > 0.** Everything else is
>   descriptive.
> - **Pattern read (descriptive, pooled):** ROI-by-local-hour curve with day-clustered CI (all cities),
>   win-rate vs payout decomposition by hour (the floor-lock tradeoff), entry-ask distribution win/loss.
> - **Output handling:** candidates → operator decision to enroll in `city_sim_config` (LIVE PAPER
>   measurement, the Karachi path). NO capital implication; the §9R boundary unchanged. INSUFFICIENT-style
>   humility mandatory: ~13/8 TRAIN/TEST days → wide CIs; the scan SELECTS, the live loop CONFIRMS.

> **✅ VERDICT (2026-07-03 ~21:55 local / 19:55Z — orchestrator adjudication vs the locked bars above): TWO
> ENROLLMENT CANDIDATES — ankara/14h + houston/14h. Pooled result NEGATIVE at every entry hour — the
> mechanism-A pooled-efficiency prior is re-confirmed; what survives is thin per-city heterogeneity.
> Analytics SELECTION only, NO capital implication; enrollment into `city_sim_config` is an OPERATOR decision.**
>
> - **Run record:** `scripts/research/city-scan.ts` on the 844-event / 45-city / 21-day maker-exit cache ⋈ ONE
>   10,909-row `bucket_probabilities` pull (point-in-time non-seeded house_gaussian, strictly-before recovery);
>   9,284 cells = 7,262 bets + 2,022 skips (ask>0.95: 1,851 · resolved: 131 · no-tick: 40); 95.9 % of bets used a
>   genuine pre-entry DB build. Executed **twice independently, bit-identical**, + one adversarial review lens;
>   whole-repo typecheck clean both runs.
> - **The locked bar (TRAIN LB>0 AND TEST net>0 among the top-5 TRAIN cells):**
>   **ankara/14h** — TRAIN LB +3.6 pp (n=11) → TEST **+$44.88** (75.0 % win, day-clustered CI [−28.1, +64.4] pp);
>   **houston/14h** — TRAIN LB +3.1 pp (n=11) → TEST **+$12.04** (85.7 %, [−25.6, +47.4] pp).
>   Failed: munich/16h (TEST −$30.86), buenos-aires/14h (TEST −$6.77), helsinki/15h (TRAIN LB −0.1 pp).
>   **Every TEST CI straddles 0 at n=7–8** — per the pre-registration's own humility clause, the scan SELECTS,
>   the live paper loop CONFIRMS.
> - **Pooled (descriptive):** ROI negative at every arm hour (best −11.4 pp @14h → −101.9 pp @19h; the 16h–19h
>   collapse is largely the locked bet rule — a FIXED forecast-mode bucket, not the live sim's floor-lifted
>   temperature — spec-compliant artifact, flagged). Winners' mean entry ask 0.539 vs losers' 0.241; higher
>   forecast confidence → monotonically better ROI, never pooled-positive. Notably the three live/known
>   references (karachi, singapore, amsterdam) do NOT clear TRAIN LB>0 in this window.
> - **Review record (2 runs + 1 lens; 3 findings, all adjudicated, none change the candidate set):**
>   (1) `rankTrainCells` lacks entry-watch's own `minGraded=10` eligibility floor — a LATENT defect (an n=1 cell
>   gets a degenerate zero-width CI and could top the ranking); **non-binding here** — all top-5 cells n=10–11,
>   `eligible:true`. Harden before any re-use.
>   (2) `MAX_ENTRY_ASK 0.95` is NOT in the live city-sim path (live only requires a non-null ask) — a deviation
>   from the "mirrors live" docstring; binds almost entirely at late arms (3 skips @9h → 500 @19h); candidate
>   cells nearly untouched (2/0/1/0/1 skips total).
>   (3) **The frozen-seed fallback is look-ahead BY CONSTRUCTION** — fallback fires ⇔ no build precedes the entry
>   tick, and the frozen seed IS the event's first-ever build ⇒ every fallback bet used a forecast made after bet
>   time. Empirically CONFIRMED 296/296 (zero `latestBuildBefore` anomalies; retention can't have truncated the
>   window). **Scope measured: 100 % TRAIN-confined (TEST: ZERO fallback bets — the holdout is clean);** ≤1 bet
>   per cell; 3 of the top-5 cells touched (munich/16h, houston/14h, buenos-aires/14h) and in each the removed
>   bet was a LOSER — TRAIN LB rises without it (munich +6.9→+9.3, houston +3.1→+4.5, b-aires +2.7→+4.2 pp);
>   ankara + helsinki untouched. **Candidate set insensitive.** Residual: a fully fallback-free re-RANKING could
>   in principle alter marginal top-5 membership; deliberately NOT re-run post-hoc (selection-drift discipline).
> - **Staged enrollment (OPERATOR DECISION — mirrors the 0070 seed idiom + 0075 day-cap; do NOT apply without
>   deciding). Note: houston would be the FIRST °F city in the sim (0070's bucketing is unit-agnostic by design —
>   watch its first graded day); `forecast_max_hour` 14 = the scan's best arm, adjustable.**
>   ```sql
>   insert into public.city_sim_config (city_id, slug, icao, tz, arm_hours, forecast_max_hour, stake_usd, active, active_until)
>   select c.id, c.slug, v.icao, v.tz, v.arm_hours, v.fmh, 10, true, date '2026-07-31'
>   from (values
>     ('ankara',  'LTAC', 'Europe/Istanbul', array[11,12,13,14,15,16]::smallint[], 14::smallint),
>     ('houston', 'KHOU', 'America/Chicago', array[11,12,13,14,15,16]::smallint[], 14::smallint)
>   ) as v(slug, icao, tz, arm_hours, fmh)
>   join public.cities c on c.slug = v.slug
>   on conflict (city_id) do nothing;
>   -- verify: select slug, icao, arm_hours, forecast_max_hour, active, active_until from city_sim_config order by slug;
>   -- then seed/backfill: pnpm tsx scripts/city-sim.ts   (run OFF the :35–:42 window)
>   -- rollback: delete from public.city_sim_config where slug in ('ankara','houston');
>   ```
> - Recorded: FINDINGS.md backlog row (item 12) + FASTTRACK cycle ticks C15–C20. Re-open criteria: none needed —
>   the item is CLOSED as a selection study; the live paper loop is the confirmation instrument.
> - **↳ ENROLLMENT EXECUTED 2026-07-03 ~22:15 local (operator blanket approval given in-session):** the staged SQL
>   above applied verbatim (verified: 4 active `city_sim_config` rows) + `pnpm tsx scripts/city-sim.ts` backfill —
>   ankara 126 bets/121 graded, houston 125/120, both 06-12→07-03, same shape as karachi/singapore. The daily
>   10:00Z `city-paper-trade` cron picks the new cities up automatically. **Confirmation-clock rule (single-writer
>   record): the backfilled window overlaps the scan's own TRAIN/TEST data — it is IN-SAMPLE for the two
>   candidates. Candidate CONFIRMATION reads use `target_date ≥ 2026-07-04` ONLY.** Houston is the sim's first
>   °F city — 0070's bucketing is unit-agnostic by design; its first forward graded day should be explicitly
>   checked (the v5 loop carries this).

> - **Data appendix (added 2026-07-04 ~00:30 local — the full pooled tables from the two bit-identical
>   independent runs, previously only summarized above; source: the runner reports recorded in FASTTRACK
>   C16/C17. These are the LEGACY-mode numbers, i.e. exactly the recorded verdict's data.)**
>
>   Pooled arm-hour curve (all 45 cities, TRAIN+TEST, descriptive):
>
>   | arm | n | net | ROI | winRate | meanAsk | day-clustered ROI CI |
>   |---|---|---|---|---|---|---|
>   | 9h | 828 | −$1147.82 | −13.9pp | 36.5% | 0.386 | [−23.8, +4.7] |
>   | 10h | 828 | −$1125.98 | −13.6pp | 37.0% | 0.389 | [−23.4, +8.3] |
>   | 11h | 822 | −$1065.90 | −13.0pp | 37.3% | 0.389 | [−23.9, −1.5] |
>   | 12h | 815 | −$1299.13 | −15.9pp | 38.0% | 0.399 | [−26.0, −4.6] |
>   | 13h | 802 | −$1116.98 | −13.9pp | 38.5% | 0.394 | [−26.3, −1.6] |
>   | 14h | 742 | −$843.89 | −11.4pp | 38.8% | 0.381 | [−24.5, +4.5] |
>   | 15h | 672 | −$1713.85 | −25.5pp | 35.1% | 0.339 | [−45.5, +0.8] |
>   | 16h | 557 | −$2513.81 | −45.1pp | 29.4% | 0.294 | [−54.3, −33.7] |
>   | 17h | 470 | −$3228.25 | −68.7pp | 19.1% | 0.221 | [−79.1, −55.6] |
>   | 18h | 399 | −$3653.32 | −91.6pp | 8.5% | 0.132 | [−96.2, −87.7] |
>   | 19h | 327 | −$3333.21 | −101.9pp | 1.5% | 0.062 | [−104.6, −99.8] |
>
>   Confidence terciles (mode-bucket probability of the distribution actually used):
>
>   | tercile | confRange | n | net | ROI | winRate |
>   |---|---|---|---|---|---|
>   | low | [0.169, 0.382] | 2,424 | −$9,177.01 | −37.9pp | 25.5% |
>   | mid | [0.382, 0.497] | 2,419 | −$6,487.46 | −26.8pp | 31.3% |
>   | high | [0.498, 1.000] | 2,419 | −$5,377.66 | −22.2pp | 40.4% |
>
>   Winner/loser entry ask (pooled): winners mean 0.539 (n = 2,351) vs losers mean 0.241 (n = 4,911).
>
>   Top-5 TRAIN cells, complete per-cell record (TRAIN n / net / LB → TEST n / net / winRate / day-clustered CI):
>
>   | cell | TRAIN n | TRAIN net | TRAIN LB | TEST n | TEST net | TEST win | TEST day-CI (pp) |
>   |---|---|---|---|---|---|---|---|
>   | munich/16h | 10 | +$42.24 | +6.9pp | 8 | −$30.86 | 50.0% | [−32.4, +23.6] |
>   | ankara/14h | 11 | +$78.82 | +3.6pp | 8 | +$44.88 | 75.0% | [−28.1, +64.4] |
>   | houston/14h | 11 | +$29.32 | +3.1pp | 7 | +$12.04 | 85.7% | [−25.6, +47.4] |
>   | buenos-aires/14h | 10 | +$13.25 | +2.7pp | 8 | −$6.77 | 62.5% | [−9.4, +37.9] |
>   | helsinki/15h | 11 | +$88.00 | −0.1pp | 7 | +$44.23 | 57.1% | [−16.0, +59.6] |

## 13. Maker-exit forward gate — CLOSED 2026-07-07, KILL (the 12th and final signal)

The 12th signal's sole surviving form — the opening-convergence **maker-exit variant** (enter at the first
enterable tick, not the falsified flat open; take profit as a resting maker) — reached its verdict on the **live
forward paper gate** (`/maker-exit`, `dash_maker_exit()`, the gate of record). Settled **KILL**: 62 markets /
26 cities / 7 distinct days (above the frozen ≥40/≥6/≥7 sufficiency floor); mean net **−12.6%**, 95% CI
**[−21.6%, −3.5%]** (the whole interval negative); `makerFillRate` **0.065** vs the backtest's 49.0%;
`realizedRebateUsd` **$0**; winFrac **0.27**; total net **−$168**.

The backtest's marginal PASS (+6.7%, CI [+0.3%, +12.0%], `MAKER-EXIT-SIM.md`) did NOT replicate — and the
mechanism is proven, not inferred (`MAKER-EXIT-SIM.md` root-cause banner, 2026-07-06): the backtest replayed a
**synthetic `house_gaussian`-centered book that converges to the forecast by construction** (49% maker fills); the
live gate replays the **real Polymarket book, which is efficient and does not converge to our forecast** (6.5%
fills). The resting maker take-profit — the leg that carried the entire backtest edge (+$1,543 on 187 fills at
100% win) — almost never fired live, and exits fell to the structurally-negative taker time-stop (−13.4% avg).
Same market-efficiency wall as the other eleven signals, now measured on a real book. No capital was ever risked;
recorded via operator override (2026-07-07) after ~2 days of Supabase-Micro saturation blocked the durable clean
gate-row write.

**Re-open requires a measured, understood mechanism change to the maker-fill rate** (not a lucky window) that
plausibly moves realized fills back toward the 40–49% band the backtest needed — e.g. a documented queue-position
or depth-provisioning change — because the backtest edge existed even at rebate 0, so **fill-rate restoration is
the necessary condition**. A materially higher realized rebate or `qualifyingTickFrac` (both read 0 through the
entire forward window) strengthen the case but cannot substitute for it. **Do NOT re-open on a backtest re-tune
alone** — the live gate is definitionally the higher bar, and a backtest tune was exactly what produced the
synthetic-book false-positive this KILL corrects.

## What NOT to do

Don't build items 5–10 before items 1–4 resolve — 1–4 are all read-only analysis over data that
already exists, cost almost nothing, and directly inform whether there's anything left worth deeper
engineering effort. Don't build item 8 at all until a PASS actually authorizes capital. Don't treat
this list as a mandate to keep hunting signals instead of letting the live forward paper loop —
already running, already the actual gate — accrue the data it needs for free.
