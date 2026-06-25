# Polyweather — FINDINGS

> **The canonical R&D record.** One question drove this entire project: *is there a tradable edge
> in daily-Tmax weather prediction markets that this system can see?* This document is the answer,
> with the load-bearing numbers and the arc that produced them. It is the top layer — every claim
> links down to the deep doc that proves it.
>
> Authored 2026-06-23 · scope: personal R&D record · status: **investigation CLOSED** (analytics product retained).

---

## Bottom line, up front

**No. The market is efficient with respect to every signal this system can see.** Not approximately —
on every distinct lever we could test, the measured edge was zero-or-negative with the confidence
interval excluding a tradable margin. The one edge that demonstrably exists in this universe (an
external sharp's, +$25.4k) is **pure microstructure** — resting cheap maker bids, collecting the
rebate, across enormous breadth — and is **non-followable and non-replicable** from where we sit.

| Signal tested | Can we beat the market with it? | Verdict |
|---|---|---|
| Multi-day NWP blend (4 levers) | No — at its point-skill ceiling | FORECASTING-RD §1, WO-3, L3-b |
| Intraday nowcast (running-max + lift) | No — market already at the oracle ceiling | FORECASTING-RD WO-4 |
| Running-max "dead bucket" latency | No — no realizable dead mass, no decay | FORECASTING-RD WO-5 |
| Our forecast vs the day-before market | No — market is the sharper forecaster | WALLET-RECON §10 (KILL-GATE 2) |
| Copy-trading the #1 sharp's fills | No — taker-follower loses −6.05pp | WALLET-RECON §11 |
| Resting our own cheap bids (maker-spray) | No — adverse selection, −1.5 to −1.7pp | WALLET-RECON §12 |
| Stacking the sharp's picks onto the market | No — subtracts skill (−1.2 to −1.7pp) | WALLET-RECON §14 (Move 5) |
| Learning the sharp's maker selection (REC-1) | Un-answerable today (data-limited); a learned selector overfits — OOS edge −5.7pp | SELECTOR-LEARNABILITY §10 |
| Forecast-free reward farming (two-sided MM) | No — measured fill cost ~−47%/day ≈ 8× the ~6%/day reward | REWARD-INVENTORY-BACKTEST §4 (REC-10) |
| Complete-set structural arb (forecast-free) | No — fee-walled; raw book inconsistent ~16% of the time but the `takerOnly` fee > the residual mispricing (0.37%/0.06% of instants clear; live 0/107) | COMPLETE-SET-ARB.md (the 8th signal) |
| Copy-trading the top **SPORTS** sharps (adjacent, off-weather) | No — volume machines' edge regresses to ≈0 (follower negative at every lag×spread); high-ROI specialists' "100% win / PASS" is survivorship + a non-executable book-sweep mark | SPORTS-TRADERS.md (the 9th signal) |
| Cross-venue RV: same day on Kalshi (NWS-CLI) vs Polymarket (Wunderground) | **Measuring (2026-06-25→)** — forward gated paper panel, both venues reachable from Sweden; day-1 NYC agrees to ~1¢, strong prior it walls on the 1°F bin-offset + dual-source basis (like the 8th) | CROSS-VENUE-SPIKE.md (the 10th signal) |

**On REC-1 (the one un-run maker lever, tested 2026-06-23).** After the maker-rebate reframe (net profit by
*any* mechanism), the last distinct lever was: can WE *learn* which cheap buckets to rest on (vs. mirroring the
sharp's revealed picks, which needs his fills)? A pre-registered L2 logistic selector over 6 leakage-free
pre-entry features, scored leave-one-weather-day-out with a cluster-mean t-interval, was built and run. Result:
the in-sample ceiling (+10.6pp) **collapses out-of-sample to −5.7pp** (overfitting — the same selection wall as
§12, now with a larger model). But the binding fact is the cheap-eligible book lives on only **4 independent
weather-days**, far below the validation floor → **`INSUFFICIENT_DATA`**. The lever is un-answerable on today's
data (a book-density limit, not a modelling gap); the same harness re-runs decisively once density grows. The
direction of the available signal is negative. The rail stays DORMANT; the closed-thesis framing is unchanged.

**Consequence (operator decision 2026-06-15): the live-trading thesis is CLOSED.** The product is the
**analytics instrument** — a calibrated forecast, a scored model-vs-market history, and a measured,
defensible *proof of market efficiency*. The trading machinery (`packages/trading`, the `bets`
surface, the gated live rail) stays built but DORMANT. Do not reopen taker-edge work without
genuinely out-of-market information.

> **⚡ MATERIAL UPDATE 2026-06-24 — the reopening condition just triggered (NOT a taker edge).** The REC-4
> monitor (`scripts/reward-monitor.ts`) found that **Polymarket has turned on FUNDED liquidity rewards on
> weather markets**: 395/396 temperature markets are in the CLOB `/sampling-markets` funded pool, paying
> real USDC daily rates (Madrid 226/day, Ankara 124/day, Helsinki 66/day; min_size 50, max_spread 4.5¢).
> This **reverses** the earlier "Liquidity Rewards DEAD on weather" finding. Liquidity rewards are
> **forecast-free and selection-free** — you are paid for *resting orders near mid regardless of fill or
> outcome* — so this is **orthogonal to every falsified signal above** (all of which were about predicting
> the outcome or picking the bucket). It does NOT contradict the efficiency verdict; it is a different,
> market-making income mechanism that did not exist on this universe until now. **Caveat:** the daily rate
> is a per-market POOL split among qualifying makers by a scoring formula — realized earnings = your share,
> net of inventory / adverse-selection risk on fills; it needs its own economics analysis before any
> capital. **This is the genuinely-out-of-market information the reopening clause named — it warrants a new
> work order (reward-farming economics), an operator decision.** Detail: `MAKER-REBATE-HANDOFF.md` §9.
>
> **↳ RESOLVED 2026-06-24 — the reopening is CLOSED again (net-negative, measured). REC-10
> (`REWARD-INVENTORY-BACKTEST.md`).** The REC-8 first-pass's +$28/market PASS rode on a *guessed*
> adverse-selection cost (`τ`=5%). REC-10 **measured** it: an event-driven two-sided maker simulation over
> the real `market_snapshots` book series of resolved weather buckets, inventory carried to the real
> outcome. The measured fill+inventory cost is **−47%/day in the mid-range markets that carry 93% of the
> pool** (−8%/day even in the gentlest cheap regime), ~**8× the ~6%/day reward income** and ~10× the guessed
> τ. **Net −41%/day; 95% of mid buckets lose money on fills; negative at every realistic competition level.**
> The "free" reward is not free — resting near mid on a binary that resolves to 0/1 the same day forces you
> to hold adversely-selected inventory through convergence (the §12 / replica wall, two-sided). Capturing it
> net-positive needs active inventory management = the forecasting/latency skill already shown efficiently
> priced. **The forecast-free thesis FAILS; the live rail stays DORMANT.** (Directional — the dense book
> history is 2 weather-days; the margin is far beyond what more days could overturn. Re-run when the
> Phase-A cron accumulates ≥8 dense days.) **Consequence: there is no currently-known net-positive path;
> the closed-thesis framing of this document is restored, now including the reward lever.**
>
> **↳ NEW 2026-06-24 — the last ORTHOGONAL mechanism tested and closed: structural complete-set
> arbitrage (the 8th signal, `COMPLETE-SET-ARB.md`).** Every signal above asks *"is our forecast better
> than the market?"*; this asks the orthogonal *"is the market consistent with **itself**?"* — a
> forecast-free accounting identity (a negRisk ladder has exactly one \$1 winner, so a complete YES set
> is worth exactly \$1 / a complete NO set exactly \$(N−1)). It dies to a **different wall than
> efficiency: the fee wall.** Measured over the full resolved-ladder universe (827 events / 674k
> snapshots, ≤30-min contemporaneity gate to kill the stale-quote trap) + a live probe of every open
> ladder: the RAW book IS internally inconsistent (Σask<1 on **4.0%** of instants, Σbid>1 on **11.8%**),
> but the per-leg `takerOnly` taker fee (~2–4%/ladder) is **larger than the residual mispricing** — only
> **0.37% / 0.06%** of instants clear, and the survivors are freshly-opened-thin-book windows where
> depth ≈ min-order-size (capacity ≈ pennies). Live: **0/107** open ladders clear. The maker route that
> would dodge the taker fee re-opens the adverse-selection wall already falsified 7×. **MARGINAL →
> closed: no net-positive structural path.** Reopens only if Polymarket drops/restructures the weather
> fee (mechanical trigger: `complete-set-arb-live.ts` shows a non-zero UNDER/OVER count) or a forward
> depth-capture proves the thin-open window is executable at size. Rail stays DORMANT.
>
> **↳ NEW 2026-06-25 — the 10th signal, the first genuinely-EXECUTABLE orthogonal lever, now under live
> measurement: CROSS-VENUE relative value (Kalshi ↔ Polymarket).** Every signal above died on either
> "the market is efficient" or "the edge is unreachable from where we sit." This one is reachable —
> **Kalshi went global (Sweden supported) and Polymarket is not geo-blocked in Sweden** — and forecast-
> free: the *same US city's daily high* trades on both venues, so a cross-venue price gap is harvestable
> with zero forecast skill. It is **not a clean arb**, for two structural reasons measured by the engine:
> a **1°F bin offset** (Polymarket even-start vs Kalshi odd-start bins never share a clean threshold) and
> a **dual resolution source** (Kalshi = NWS CLI, ≥ Polymarket's Wunderground). Both are the prime
> suspects for a fee/offset/basis wall — the same shape as the 8th signal. A pre-registered, operator-
> ratified **gated paper panel is LIVE** (migration 0062 + `cross-venue-capture` cron over 6 overlapping
> cities; no capital, rail DORMANT); the day-1 NYC read shows the two venues **agree on the modal high to
> ~1¢**, so the strong prior is **KILL**. Frozen gate: positive expectancy on ≥10% of real-depth city-
> days with a pooled 95% CI excluding 0, else the 10th falsified signal. Verdict after ~1 week:
> `dash_cross_venue(7)` / `scripts/research/cross-venue-arb-scan.ts`. Full record: **CROSS-VENUE-SPIKE.md**.

---

## The question, precisely

The markets are Polymarket "highest temperature" ladders: for ~46 global airport stations, each day,
which bucket will the official daily Tmax land in? The system predicts that bucket from a calibrated
multi-model NWP ensemble, prices it against the live order book, and was originally built to **take**
the resulting edge.

The whole R&D program is the systematic falsification of "we have an edge." It ran in two arcs:

1. **The forecasting arc** — does *our own forecast* beat the market? (`FORECASTING-RD.md`)
2. **The wallet-recon arc** — a verifiably-profitable sharp exists on our exact markets; can we
   learn or copy *whatever they do*? (`WALLET-RECON-HANDOFF.md`)

Both arcs ended at the same wall.

---

## Arc 1 — the forecasting levers (FORECASTING-RD.md)

The instrument is an offline, read-only, controlled walk-forward A/B (`scripts/research/mos-pointskill.ts`)
over the full backfill — 45 stations, ~8,775 blended build-days, scored on **point error in °C**
(|μ − obs|, the direct proxy for aim) so a μ-aim gain must show on large-n out-of-sample data, not
on the small overfit-prone 30-day market window.

**Baseline (the number to beat):** the live inverse-MSE blend posts **1.33°C lead-1 RMSE** (1.57°C
overall) and beats the best single model (`icon_seamless` 1.46°C). The blend works — so the
comparison is trustworthy. But against buckets ~0.5–1°C wide, a 1.3–1.6°C aim error means μ is
routinely 1–2 buckets off. That is the deficit every lever tried to close.

**Four independent levers, four rejections — the blend is at its point-skill ceiling:**

| # | Lever | Result | Why it failed |
|---|---|---|---|
| 1 | **Regression MOS** (slope+intercept per-model correction) | **−3.32%** (worse) | Helps weak models, hurts strong ones — but the blend already down-weights the weak ones. Net negative. |
| 2 | **Recency / concentration reweighting** | **−0.01%** (neutral) | The model skill ranking is *stable* over the window; recency adds variance, not signal. |
| 3 | **Residual-structure** (can any feature explain the error?) | R² = **0.60%** | The blend residual is effectively irreducible NWP error. Strongest single feature (disagreement) |corr| = 0.07. |
| 4 | **Regime-conditional weighting** (by season / disagreement) | **−0.05% / −0.02%** (neutral) | Skill ranking is regime-stable too. Conditioning weights on regime doesn't move μ-aim. |

The two cheap levers (post-process the correction, reweight the blend) are exhausted; the two
structural ones (residual features, regime weighting) confirm it from independent angles. **The
inverse-MSE intercept-corrected blend sits at the point-skill ceiling of these inputs.** A better
*input* (a stronger deterministic source, microclimate sensing) could break the ceiling — but that's
breaking out of the inputs, not tuning within them.

**WO-4 — the intraday nowcast — the one signal that beats our own forecast, but not the market.**
The same-day running-max + climatological lift *nearly halves* point error vs the NWP blend by
mid-afternoon (h15: NWP **1.18°C → nowcast 0.65°C**, +45%; the walk-forward "gate" variant +29%).
That looked like the real edge — until the adversarial review built the missing comparison from
234k order-book mids:

| local hour | **market RMSE** | nowcast RMSE | NWP RMSE | oracle-min |
|---|---|---|---|---|
| 13 | **0.68** | 1.16 | 1.18 | 0.68 |
| 14 | **0.56** | 0.90 | 1.23 | 0.55 |
| 15 | **0.40** | 0.65 | 1.18 | 0.43 |

By early afternoon **the market is more accurate than our nowcast and is essentially at the oracle
ceiling** — it has already priced the same running-max METARs its participants observe too. Arriving
at h15 with a 0.65°C estimate to trade a 0.40°C market makes you the sucker, not the sharp. WO-4's
*methodology* is sound (no leakage); its *trading framing* is falsified.

**WO-5 — the last place an edge could hide: market staleness.** A "highest" market resolves on the
bucket containing the daily max, which is always ≥ any individual METAR running max. So the instant a
running max M prints, every bucket entirely below M is **logically dead — fair price 0**. Any price
there is a provable mispricing. Over 756 station-days / 18k polls, conditioned on minutes since the
print:

- **Realizable (bid) dead mass: median 0.0000** — the market gives you nothing to sell into on
  dead buckets. Only **1.39%** of polls clear the fee on the bid.
- **No decay.** The residual ~1.3¢ of *gross* dead mass is flat across all time-since-print bins — it
  is illiquid leftover-quote noise, not a repricing lag. A latency edge would be fresh-elevated-then-
  decaying; it isn't.

**VERDICT: the market is efficient w.r.t. the hard running-max floor** at our observable resolution
(~1h print / ~10min snapshot). Any surviving edge lives in the sub-10-min window after a print —
below this data's resolution *and* below our 5-min live reaction latency — and even there carries no
bid. **Trading thesis CLOSED (2026-06-15).**

---

## Arc 2 — the sharp wallet (WALLET-RECON-HANDOFF.md)

A Polymarket wallet, handle **"badatmath."**, trades our *exact* universe and went from flat to
**+$25,407 realized** with a sharp regime change in mid-May 2026 — **#1 on the WEATHER leaderboard**,
~$1.45M lifetime volume, ~1.8% ROI-on-volume (a thin-margin, high-volume grinder). Everything is
visible through Polymarket's public, keyless APIs. If anyone has the edge, they do. So: can we learn
it, copy it, or replicate it? **Five distinct angles, all falsified.**

**KILL-GATE 1 — is the edge even real? PASS (it's real, not survivorship).** Reconstructing realized
PnL from the public `/activity` cash-flow identity: official **+$25,445** (independently verified),
**40.6% win rate net of 5,436 losers**, `<0.25` price ROI **+22.8%** vs `[0.45,0.75)` −1.0%, Brier
0.350 vs 0.500 (p=0.000). The edge is calibration + timing: buy the eventually-correct bucket *cheap*
(<0.25) the day before, globally, at huge volume. Real edge — now, can we have it?

| Angle | What we tested | Result | CI / significance |
|---|---|---|---|
| **1 — Forecast beats market** (KILL-GATE 2) | Our EMOS forecast vs the day-before ask | **FAIL — market efficient** | edge **+0.46pp, CI [−0.92, +1.83]** (straddles 0); **0/44 stations** clear zero; our Brier 0.740/0.756 **worse** than market 0.715 |
| **2 — Day-before gate** | Same measurement, as a go-live gate condition | **FAIL** | the day-before market is the sharper forecaster, not us |
| **3 — Copy-trade the fills** (§11) | Mirror badatmath's revealed fills as a taker | **FAIL** | taker-follower **−6.05pp** vs the sharp's +1.34pp; robust to lag/staleness/price-cut |
| **4 — Maker-spray** (§12) | Rest *our own* cheap bids below the ask on our forecast | **FAIL — adverse selection** | maker edge **−1.46pp CI[−2.51,−0.41]** (all) / **−1.73pp CI[−3.16,−0.30]** (forecast); both exclude 0 |
| **5 — Sharp-as-forecaster** (Move 5, §14) | Stack the sharp's revealed distribution onto the market | **FAIL — value-negative** | improvement **−1.74pp/−1.20pp**, CI excludes 0; zero-skill P(PASS)=0.0% |

Plus the diagnostic that explains *why* (§13, M1 tail-calibration): do the sharp's revealed cheap
picks beat our EMOS tail? **AMBIGUOUS** — gap +2.37pp/+2.76pp (lead 1/2), below the pre-registered
+3pp bar. Our tail is ≈ calibrated to the sharp; the market is sharper than both. → analytics input,
no forecast-lever reopen.

**The forensic map (§15) — what the edge actually is.** Every badatmath buy 2026-05-23→06-21 mapped
and scored: 53,764 fills → 8,780 positions, ~97% resolved via Gamma, net hold-to-resolution **+$22.4k**
(reconciles to the public curve within ~8%), 41.1% win rate. The engine is **cheap-Yes 0.10–0.25**
(0.05–0.10 is a −22% dead zone), entered **24–72h before resolution** (<24h day-of is break-even).
The edge is a **maker** edge — resting cheap bids ~7pp below the ask, collecting the rebate and
breadth — with no post-fill drift to ride. That is *structurally* non-followable as a taker.

---

## The final, concrete confirmation — the badatmath replica (BADATMATH-REPLICA.md)

To make the abstract "non-replicable" tangible, we recreated the sharp's §15 buying model as a
fictional, no-money paper-trial and tracked it three ways. The 180-position seed backtest:

| Curve | what it is | ROI | win% | 95% CI |
|---|---|--:|--:|--:|
| 🟢 **maker-ideal** | his cheap price, assume filled | **+19.3%** | 19.4% | [−16%, +55%] |
| 🟡 **maker-realistic** | rest the bid, fill only if the book touches it | **−13.4%** | 13.7% | [−47%, +21%] |
| 🔴 **taker** | cross to the ask (what copying him costs) | **+3.9%** | 19.4% | [−27%, +35%] |

- **Spread tax** (ideal → taker): **15.4pp**. **Adverse-selection tax** (ideal → realistic): **32.8pp**.
- The adverse-selection tax *dwarfs* the spread tax — the §12 finding made visible in a P&L: when you
  rest a cheap bid, the book only touches it on the days you're wrong. That is the entire reason the
  sharp's edge doesn't transfer.
- **Honest caveat:** at n=180 all three CIs straddle 0. The durable finding is the *structure*
  (adverse-sel ≫ spread), not the absolute ROI. A live forward paper-trial runs daily to accumulate
  out-of-sample positions; it needs time, not more code.

---

## What this leaves

**The one genuinely-distinct unrun lever** is Move 4 — intraday running-max *physics* (a sharper
same-day model than WO-4's lift). Its prior is **low** and it overlaps the already-closed WO-5. It is
not worth building for edge; only for bulletproof closure of the writeup. Turning it would be the
avoidance pattern — one more stone to feel "complete" when the conclusion is already firm across seven
independent measurements.

**Everything else points one way:** the market is efficient to NWP forecasts, to intraday signal, to
the hard running-max floor, to our day-before forecast, and even to the *revealed picks of the #1
sharp on the board*. The only edge that exists is microstructure the crowd is already harvesting at a
scale and latency we can't match.

---

## What's actually valuable — the analytics instrument

The pivot isn't a consolation prize; it's the honest read of what got built. As a measurement
instrument the system is strong, and *that* is the product:

- **A calibrated forecast** — a multi-model NWP ensemble at its point-skill ceiling (1.33°C lead-1,
  beats every single member), with per-station/per-model bias correction that works (residual means ≈0).
- **A scored model-vs-market history** — information-time-matched, symmetric-source Brier scoring; the
  measurement that *proved* the market is the sharper forecaster.
- **A market-efficiency proof** — the day-before efficiency study (KILL-GATE 2), the dead-mass latency
  study (WO-5), and the five-angle wallet falsification together are a defensible, reproducible
  demonstration that this market is efficient. That is a genuine, publishable finding, not a null
  result to bury.
- **The sharp benchmark** — `sharp-wallet-track` (Build #1, LIVE since 2026-06-22, daily cron) ingests
  badatmath + the WEATHER leaderboard as a free, independent third forecaster.
- **The Amsterdam paper-trade + truth-accuracy lens** — `/amsterdam`, the floor "truth accuracy" vs
  KNMI, and the peak-hour best-time-to-bet model (`AMSTERDAM-SIM.md`).
- **The replica forward trial** — `/replica`, three-curve P&L, running daily (`BADATMATH-REPLICA.md`).
- **The analytics infrastructure** — the decouple-from-the-trading-gate buildout
  (`BLUEPRINT-analytics-buildout.md`, Phase 1 + 2a shipped) that frees house-model builds and the
  model-vs-market audit to compute for every open event.

---

## Where each finding lives

| Finding | Document | Section |
|---|---|---|
| Calibration vs skill — the lever is skill | `DF5-FINDINGS.md` | — |
| 4 NWP-blend levers rejected | `FORECASTING-RD.md` | §1, Round 2 (WO-3, L3-b) |
| Intraday nowcast beats us, not the market | `FORECASTING-RD.md` | WO-4 + Round-2 review |
| Market efficient w.r.t. running-max floor | `FORECASTING-RD.md` | WO-5 |
| Sharp wallet identity, forensics, edge mechanism | `WALLET-RECON-HANDOFF.md` | §1–§2, §10, §15 |
| Day-before market efficiency (KILL-GATE 2) | `WALLET-RECON-HANDOFF.md` | §10 |
| Copy-trade / maker-spray / sharp-as-forecaster falsified | `WALLET-RECON-HANDOFF.md` | §11, §12, §14 |
| Tail-calibration diagnosis (ambiguous) | `WALLET-RECON-HANDOFF.md` | §13 |
| Maker-rebate economics + selection ceiling | `MAKER-REBATE-HANDOFF.md` | §3, §8 |
| Selector-learnability (REC-1) — data-limited, OOS overfit | `SELECTOR-LEARNABILITY.md` | §8, §10 |
| Three-curve replica P&L | `BADATMATH-REPLICA.md` | — |
| Analytics infrastructure buildout | `BLUEPRINT-analytics-buildout.md` | — |
| Amsterdam analytics deliverable | `AMSTERDAM-SIM.md` | — |
| Live status + operator TODO | `BUILD-STATE.md` | Active Phase |

---

_This is an analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
