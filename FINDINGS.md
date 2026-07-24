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

> **The 12th lever is now closed too — resolved KILL 2026-07-07. The "one live exception" is gone; all twelve
> signals are dead.** Opening convergence (opened 2026-06-27) was the one signal that survived its cheap gate and
> earned a real forward test — the edge would have lived in the *uninformed flat-open window*, the one place this
> system never measured. It is now decided on both fronts. (1) The flat-open **premise was falsified**: the first
> full-universe capture (51,880 snapshots / 147 markets / 45 cities) found **0 of 147** flat at list, and the
> pre-registered Phase-0.5 spike gate returned **NO-GO (0/325 seeded events, Wilson CI [0%, 1%])** — books list
> pre-informed. (2) Its sole surviving form — the **maker-exit variant** (enter at the first enterable tick, take
> profit as a resting maker) — **KILLs on the live forward paper gate**: mean net **−12.6%**, 95% CI
> **[−21.6%, −3.5%]** (the whole interval negative), on **62 markets / 26 cities / 7 distinct days**,
> `makerFillRate` **0.065** vs the backtest's 49.0%. The backtest's marginal PASS (+6.7%) was an artifact of a
> **synthetic `house_gaussian`-centered book that converges to the forecast by construction**; the **real
> Polymarket book is efficient and does not converge to us**, so the resting maker leg that carried the entire
> backtest edge almost never filled live (`MAKER-EXIT-SIM.md` root-cause banner). **No capital was ever risked; the
> rail stays DORMANT with no scoped exception pending.** (Full close: the 2026-07-07 block below the table; re-open
> criteria: `SIGNAL-BACKLOG.md` §13.)

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
| Copy-trading the top **SPORTS** sharps (adjacent, off-weather) | No — volume machines' edge regresses to ≈0 (follower negative at every lag×spread); high-ROI specialists' "100% win / PASS" is survivorship + a non-executable book-sweep mark. **fishalive re-test 2026-06-29 (operator-flagged $9M/new account): the $9M is REAL realized cash (Σredeem $13.28M − Σbuy $4.28M, reconciles to the user-pnl curve at 0.74%) — but it is 100% ONE pre-match bet on ONE game (Spain fails to beat Cape Verde, 2026-06-15; 9¢ "No" + 45¢ −2.5 spread, $4.28M staked, 100% pre-kickoff, 0 wash). The in-play-sweep mechanism was wrong; the lever is MORE dead — n=1, no samplable/copyable edge, wallet dormant since.** | SPORTS-TRADERS.md §9–§10 (the 9th signal) |
| Cross-venue RV: same day on Kalshi (NWS-CLI) vs Polymarket (Wunderground) | **No — CAPACITY-walled** — a real quoted cross-venue price gap exists (6/7 city-days net-positive), but TRUE both-book depth shows the cumulative synthetic fills at only **1–10 contracts** (thin tail legs); winFrac over *executable* wins = **0**. Quoted edge ≠ capturable money; same structural-wall class as the 8th | CROSS-VENUE-SPIKE.md (the 10th signal) |
| **Opening convergence: buy the forecast-center cheap, sell into the convergence on brackets** | **No — KILL, forward-confirmed 2026-07-07 (the twelfth and final signal).** The flat-open premise was falsified (0/147 flat at list; Phase-0.5 spike **NO-GO**, 0/325, Wilson CI [0%,1%]); the sole surviving form — the **maker-exit variant** — backtested a marginal PASS (+6.7%) but that PASS was a **synthetic forecast-centered book converging by construction**. On the **real efficient book** the live forward paper gate KILLs: mean net **−12.6%**, CI **[−21.6%, −3.5%]**, **62 mkts / 26 cities / 7 days**, `makerFillRate` **0.065** vs backtest 49.0%, rebate $0, net −$168 — the resting-maker leg that carried the whole backtest edge almost never fills live. Same market-efficiency wall, now measured on a real book. **Investigation CLOSED — twelve of twelve dead.** | OPENING-CONVERGENCE-HANDOFF.md · MAKER-EXIT-SIM.md · FINDINGS.md 2026-07-07 close (the 12th signal) |

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
> **↳ NEW 2026-06-25 — the 10th signal, the first genuinely-EXECUTABLE orthogonal lever: CROSS-VENUE
> relative value (Kalshi ↔ Polymarket). VERDICT (2026-06-26): KILL — a CAPACITY WALL.** Every signal
> above died on either "the market is efficient" or "the edge is unreachable from where we sit." This one
> is reachable — **Kalshi went global (Sweden supported) and Polymarket is not geo-blocked in Sweden** —
> and forecast-free: the *same US city's daily high* trades on both venues. The gated paper panel went
> LIVE (migration 0062 + `cross-venue-capture` cron over 6 overlapping cities; no capital, rail DORMANT).
>
> The day-1 panel did **not** read as agreement — it showed **6 of 7 real-depth city-days net-positive**
> (NYC +0.26, Miami +0.23 quoted), which on the original 24h-volume/OI depth **proxy** would have driven
> winFrac to **0.857 — a FALSE PASS**. A live both-venue verification (`scripts/research/cross-venue-verify.ts`:
> re-runs the engine against live books AND walks the TRUE order book on **both** venues) found the gap is
> a **real quoted price difference but not capturable money**: constructing the cumulative YES≥k synthetic
> requires the thin TAIL legs, which throttle the whole position to **1–10 contracts/shares** of executable
> touch depth (vs a ~$25 tradable floor) — on **every** net-positive city-day, stable across samples. The
> biggest raw edges are also same-day **running-max latency** (the WO-5 effect), not the forecast thesis.
> The gate was hardened (migration **0064**): a WIN now requires `is_executable` (binding both-book touch
> depth ≥ `MIN_EXEC_SIZE`), not the volume proxy → winFrac collapses to **0/7 → KILL**, the same
> structural-wall destination as the 8th signal (there the wall was the fee; here it is touch depth).
> *Premise corrected:* Kalshi's bin parity is **city-dependent** (NYC odd-start, Miami/LA/Denver
> even-start = same grid as Polymarket — they DO share thresholds), not universally odd as first stated.
> Full record: **CROSS-VENUE-SPIKE.md**; live verdict: `dash_cross_venue(7)` (winFrac over executable wins).
>
> **↳ NEW 2026-06-26 — the four-lane "turn every stone" sweep (B / C1 / C2 / D): ALL KILL, confirmed at
> EXECUTABLE DEPTH. No new signal — these HARDEN signals 8 and 9.** A read-only multi-agent sweep, each lane
> with a pre-registered kill-gate (WO-5 discipline, defined before measuring) and the quoted-vs-executable
> depth lens applied to every candidate, re-interrogated the last open threads. Every lane bottomed out on
> the same wall as the 8th/10th signals: a quoted edge that evaporates the instant you demand it fill at real
> touch depth on every leg.
> - **Lane B — negRisk MINT-AND-SELL (the maker-route dual of the 8th signal).** The textbook overround
>   harvest: mint the complete YES set for exactly $1.00 via the NegRiskAdapter split (no protocol fee) and
>   rest each leg into its bid (maker, $0 fee — both confirmed). Mechanics real; practice walled. 16 live
>   ladders: raw overround on 4/16, max harvest **1.3¢/set**; binding bid depth median **14.84** / min 0.1
>   shares (~half the ladders carry a zero-bid, *uncloseable* leg). Net-positive at executable depth (binding
>   fill ≥ 25 shares) = **0/16, winFrac 0%, 95% CI [0, 0]** — KILL on the pre-registered 10% bar; even the
>   zero-adverse-selection arm clears only 1/16 (6.25%). `scripts/research/lane-b-negrisk-scan.ts`.
> - **Lane D — the 8th signal on the DEPTH axis.** Of the migration-0060 `complete_set_depth_captures` panel
>   (independently re-queried against prod: 486 rows / 73 events / ~19h of `*/30` captures), **0 of the 5
>   fee-cleared instants clear at binding depth ≥ 25** (exec_sets `8/6/5/5/3`; max net **$0.0474**). One thin
>   tail leg caps every set even where modal-bin depth is 20k–75k shares — the identical throttle as the
>   cross-venue capacity wall. The 8th-signal fee wall now holds on **both** the fee and depth axes.
> - **Lane C1 — the SPORTS specialist fingerprint (the 9th signal's mechanism).** The prior "98.6%
>   same-second sweep" was a **120s-window artifact** (repeat adds to the SAME 3 positions); true
>   same-exact-second multi-leg is **2.0% / 14.6% / 13.1%** (mintblade / fishalive / frostrizz). The real
>   pattern is pre-kickoff accumulation at ~0.50 (VWAP 0.49, 96–100% pre-kickoff, 100% FIFA Club World Cup
>   soccer); the only out-performance (100/100/98.1% win vs 45.7/35.3/60.0% implied) is **pure survivorship**
>   on resolved winners — 0 contracts of executable non-latency edge. `scripts/research/lane-c1-fingerprint.ts`.
> - **Lane C2 — being the FAST ACTOR on in-play staleness.** The staleness window closes **<1s** while our
>   reachable reaction latency is **300–1800s** — a 300–1800× gap the wrong way, zero overlap with the gate;
>   the residual at +300s is +0.1–0.5pp and non-executable (the sweeper already ate the liquidity); the 60s
>   public price-fidelity floor cannot even measure a sub-300s window. KILL — only a dedicated sub-second
>   infra build could move it (out of scope, low prior).
>
> **Net: the market is now measured efficient ELEVEN ways** (10 signals + this hardening sweep). No
> reopening; the live rail stays DORMANT. Full sweep close-outs: `COMPLETE-SET-ARB-HANDOFF.md` (B/D) and
> `SPORTS-TRADERS.md` §9 (C1/C2).
>
> **↳ NEW 2026-06-28 — the 12th signal's FLAT-OPEN premise is FALSIFIED by the first full-universe capture; the
> lever pivots to hold-to-resolution (a NEGATIVE-prior re-test, not a found edge).** Phase 0's keyless capture ran
> the §9R universe forward at 45 cities for ~26h (**51,880** snapshots / **147** markets). The load-bearing premise
> — *freshly-listed daily-Tmax markets open flat (~10–12%/bucket) and converge* — does not hold: **0 of 147**
> markets were flat-open at first sight and only **3 of 51,880** captures ever cleared the peak ≤ 0.18 gate.
> Catching the market within ≤1h of its TRUE Gamma listing (45 markets, min age ~0.6 min) does not help — the peak
> bucket is already median **27%** / min **19.5%**, never the ~9–12% a flat book implies; the 11-bucket book lists
> **pre-informed**. Two things the capture confirms are NOT the blocker: the house forecast IS available (**97%** of
> captures seeded — R-13 cleared), and convergence IS real and directional (peak **+16pp** first→last, **117 of 147**
> markets converge up, 58 reach ≥95%). So the signal pivots OFF the dead flat-open buy and ONTO a
> **hold-to-resolution / bracket** variant — watch every market, buy the forecast-center bucket whenever its ask
> dips below the reservation, hold to TP/SL or resolution. That is implementable (**74 of 145** markets presented ≥1
> enterable center dip) — but its entry rule *is* the forecast-vs-market bet this document falsified seven times: at
> the forecast center the market ask (**0.40**) ≈ our own prob (**0.39**), a −1.7pp coin flip, so the dips that fire
> are forecast disagreement, where the market has repeatedly been the sharper forecaster (KILL-GATE 2; §12 adverse
> selection; the 32.8pp replica adverse-sel tax). The only mechanism that could win WITHOUT forecast superiority is
> the bracket exit selling into the convergence re-rating — distinguishable only by the realized held outcome. It is
> now measured forward by `scripts/research/opening-resolution-score.ts` (buy-center-hold, entry-age-swept, net of
> the canonical fee curve, Šidák-penalized); **0 markets are resolved yet** (the panel settles 06-29/30), so the
> verdict lands ~**2026-07-06**. **No capital until the frozen §9R-E net-profit gate PASSes; the rail stays
> DORMANT.** Detail: the 2026-06-28 memory + OPENING-CONVERGENCE-HANDOFF.md.
>
> **↳ NEW 2026-06-28 — the bracket-EXIT screen is BUILT (the 12th signal's SECOND forward test — the variant with a
> NON-forecast win mechanism).** Alongside the hold-to-resolution scorer, a read-only keyless paper *replay* (pure
> engine `packages/core/src/sim/opening-bracket-replay.ts` + harness `scripts/research/opening-bracket-score.ts`,
> doc `docs/OPENING-BRACKET-REPLAY.md`) measures the BRACKET EXIT — buy the forecast-center cheap, then SELL INTO
> THE CONVERGENCE *before* resolution on a fixed take-profit / stop-loss / station-local-noon time-stop, walking the
> captured per-tick book tick by tick (**NO LOOK-AHEAD** — the exit at tick t reads only tick t; a later up-tick
> cannot rescue a stopped-out trade; independently re-audited). This is the ONE variant whose edge does NOT require
> the forecast to be right at settlement — it trades the re-rating, not the outcome. It reuses the live bot's own
> pure fns (selectEntries with a new backward-compatible `requireFlatOpen:false`, bracketDecision, paperFill,
> openingVerdict) and sweeps the take-profit, the pre-registered +25pp as the gate. Full suite **1671 green**.
> FIRST LIVE READ (~26h panel): of 10 fresh §9R events only **2** cleared all gates AND filled → nMarkets 2 / 1
> date → **INSUFFICIENT_DATA by design** (needs ≥40 markets / ≥6 cities / ≥7 days). The 2 we have are
> early-**NEGATIVE** (the fixed rule netted **−23.3%**; even the look-ahead best-sell-back *ceiling* was **−2.5%** —
> the bid never recovered above entry on those two) — directionally consistent with the efficiency prior, but
> n=2/1-day is noise and the §9R-E gate refuses a verdict. Verdict accrues with capture (~**2026-07-06**, the hold
> scorer's horizon). Rail DORMANT; no capital until the frozen §9R-E net-profit gate PASSes.

> **↳ NEW 2026-06-30 — the bracket-exit thesis is TUNED + measured on 708 events (not n=2) → KILL at executable
> spread; the convergence edge is a MAKER edge.** The forward bracket screen was starved (n≈2), so the local
> price-history archive (6 275 events / ~238 M points) was joined to the bot's **real** archived `house_gaussian`
> seed + the true resolution → a **708-event / 45-city / 17-day** resolved panel, run through the SAME pure engine
> (`tune-convergence.ts` + `core/sim/history-replay-ingest.ts`; the mid-only archive's two-sided book is
> SYNTHESIZED from the mid via `CALIBRATED_BOOK`, fit from the live real books, and SWEPT). Across an entry×exit
> grid validated **out-of-sample** (train/test by date), **no threshold set clears the frozen §9R-E gate**: the
> best OOS cell nets **−2.6%** (full panel −3.0%, KILL; the 10-city allowlist cut −5.0%). The decisive number is
> the **spread sweep** — the price-path edge is REAL (**+8.2%** at a frictionless book, PASS) but the **taker
> round-trip spread + fees consume it**: **breakeven at ×0.70 of the real spread**. The convergence-created spread
> is captured by the maker who quotes it, not the taker who crosses it — the **same efficiency wall** as the other
> eleven, now on 708 events. TP/SL/time-stop are not the lever (all KILL; tight stops are worse). **Two new
> findings:** (1) the edge survives only if you recover ≥30% of the spread → a **maker-exit** variant is the one
> open lever, but it must beat the §12 maker-spray **adverse-selection** wall (motivated hypothesis, not a GO);
> (2) for SELECTION, the calibrated `house_gaussian` brackets the winner **73.9%** vs the raw ensemble's **52.8%**
> (chw1) — i.e. the convergence seed should be the calibrated forecast, not `ensemble_raw` (a correction to the
> 2026-06-29 split, for the *selection* objective). Rail stays DORMANT; live config unchanged. **`CONVERGENCE-TUNING.md`.**

> **↳ NEW 2026-06-30 — the MAKER-EXIT redirect is BUILT + SIMULATED → it FLIPS the edge POSITIVE, but still KILLs
> the gate (the first positive-EV config in twelve signals).** The open lever from the line above was built (pure
> no-look-ahead engine `core/sim/opening-maker-exit-replay.ts` — take profit as a MAKER, $0 fee + rebate, fills
> only when a later bid lifts the resting sell; TAKER stop-loss + a hard time-stop at resolvesAt−Nh) + simulated
> over the 708-event panel, with an **agent-team dynamic Workflow** (`tune-maker-exit`: 7 parallel coordinate
> agents/round × ≤3 rounds, stop-on-no-gain) fine-tuning entry/exit to maximize net profit. Result (hand-verified):
> the maker exit **moves the same strategy from the taker's −3.0% to +1.8% (no rebate) / +5.1% / +$313 (with the
> measured weather maker rebate)** — the FIRST positive expectation in the whole program. **But the §9R-E gate
> still KILLs:** the 17-day city-clustered 95% CI is **[−1.6%, +11.5%]** (ciLow just below 0) — positive-EV, not
> yet statistically clear of zero (winFrac 58.8% + zsMC 2.8% both clear; ciLow is the lone miss). Tuned params:
> tp 0.12 / sl 0.20 / tstop 18h / chw 0 / depth $150 / makerWindow 30 (the maker ENTRY also fills at the 30-min
> window, recovering the entry spread). NOT a GO — three assumptions (the maker-fill model, the rebate tier, the
> 17-day extent) resolve only forward; it earns a **live forward test**, not capital. Rail DORMANT. **`MAKER-EXIT-SIM.md`.**

> **↳ NEW 2026-07-03 — TWO adjudications land the same night: the Phase-0.5 gate formally KILLS the flat-open
> entry (NO-GO, 0/325), while the corrected archive flips the maker-exit backtest to a (marginal) PASS.**
> (1) **The Phase-0.5 spike — the pre-registered hard gate on the ORIGINAL thesis — ran on 8 distinct seeded
> target dates (328 events, 12,587 capped captures) and returned NO-GO: 0/325 seeded events (Wilson 95% CI
> [0%, 1%]; bar 50%) were still flat-open with cheap executable center depth when the first usable
> `house_gaussian` existed.** Seed coverage was 99% — R-13 (signal availability) was NOT the blocker; the market
> structure is: books list EMPTY (no quotes at +0.02–0.11h), and by the time quotes populate the peak is already
> >18% (pre-informed, as the 06-28 capture showed on 147 markets — now formalized by the frozen gate at n=325).
> **The original "buy the ≤1h flat open" execution stack (Phases 2–6 as spec'd) is dead and will not be built.**
> (2) The on-disk archive predated the 06-30 canonical-sort fix → re-pulled (1,108 events) + every verdict
> regenerated on the corrected **819-event / 45-city / 20-day** panel: the SAME pinned maker-exit config now
> **PASSES the frozen §9R-E backtest gate** — +6.7% / +$515, CI [+0.3%, +12.0%], winFrac 62.8%, zsMC 3.2%
> (misalignment had been UNDERSTATING the edge; taker side stays KILL). Overnight robustness work: an
> LOCO/LODO jackknife shows the PASS is real but **marginal** (mean +6.1% survives every single exclusion;
> 16/45 city- and 8/20 date-exclusions tip ciLow just under 0), the new OPT-IN day-block tightening in
> `openingVerdict` PASSES with a stronger low bound (day-clustered CI [+2.4%, +12.6%]), and the ledger
> decomposition shows the whole edge is the maker-TP leg (+$1,543 on 187 fills, 100% win, vs −$1,028 taker-exit
> drag) — so everything hinges on the LIVE maker-fill rate (backtest 49.0% vs an early live read of 0.30).
> **Net: the 12th signal's surviving form is exactly ONE thing — the maker-exit variant entering at the first
> ENTERABLE tick (not the flat open), measured by the live forward paper loop (`/maker-exit`, the gate of
> record). Backtest ≠ GO; no capital before a frozen forward paper PASS.** Rail DORMANT; boundary intact.
> **`MAKER-EXIT-SIM.md`** (banner + jackknife + decomposition), **`BUILD-STATE.md`** (overnight log).

> **↳ NEW 2026-07-03 (later) — the FLUCTUATION-TAKER variant (operator-requested) is tested and KILLED
> decisively; the 20-day baseline re-run re-confirms the maker-exit PASS.** (1) The path-signal taker sweep —
> buy dips / ride momentum within the lead-aware forecast-center ±1 key set, exit via bracket/trailing/recenter
> taker rules, calibrated book + real fee curve, frozen gate + day-block tightening + OOS split — returns
> **zero passing cells of 384 even in-sample**; the best cell loses −14.3% TRAIN / −17.6% TEST / −15.8% −$2,002
> FULL (winFrac 23%, top-10 ciHigh all < 0, both signal directions). Mechanism: cheap-bucket fluctuations are
> information plus adverse selection, not mean-reversion, and the double taker round-trip compounds it — the
> §12 wall, fourth confirmation. **No per-minute follow-up; the variant is dead. `FLUCTUATION-TAKER.md`.**
> (2) The pinned maker-exit config re-run on the grown 827-event / 20-day panel: **PASS holds, slightly
> stronger** (+6.9% / +$534, CI [+0.4%, +12.1%]; LOCO flips 16→15/45, LODO 8→7/20; day-block PASS
> [+2.4%, +12.6%]). The 21st day (07-02) joins after post-outage grading catches up. Unchanged: backtest ≠ GO;
> the live forward paper loop is the gate of record.

> **↳ NEW 2026-07-07 — the live forward maker-exit paper gate KILLs; the 12th signal joins the other eleven.
> INVESTIGATION CLOSED — twelve of twelve signals now dead.** The forward gate of record (`/maker-exit`,
> `dash_maker_exit()`, `POST-FABLE-HANDOFF.md`) rendered a settled **KILL** on the last real panel reads: mean net
> **−12.6%**, 95% CI **[−21.6%, −3.5%]** (the *whole* interval negative, not merely ciLow ≤ 0), on **62 markets /
> 26 cities / 7 distinct days** — above the frozen sufficiency floor (≥40 / ≥6 / ≥7). `makerFillRate` **0.065**
> (backtest 49.0% — the fill rate collapsed ~7.5×), `realizedRebateUsd` **$0**, winFrac **0.27**, total net
> **−$168**. The backtest's marginal PASS (+6.7%, CI [+0.3%, +12.0%], `MAKER-EXIT-SIM.md`) did **not** replicate,
> and the mechanism is now proven rather than inferred: the backtest replayed a **SYNTHETIC `house_gaussian`-centered
> book that converges to the forecast by construction** (49% maker fills); the live gate replays the **REAL
> Polymarket book, which is efficient and does not converge to our forecast** (6.5% fills). The one leg that carried
> the entire backtest edge — the resting maker take-profit (+$1,543 on 187 fills at 100% win) — almost never fired
> live, and exits fell to the structurally-negative taker time-stop (−13.4% avg). This is the **same
> market-efficiency wall that killed the other eleven signals, now measured on a real book instead of a synthetic
> one** — there is no bug to fix and no artifact to correct that would "restore" the +6.7% (`MAKER-EXIT-SIM.md`
> root-cause banner, 2026-07-06). Rail **DORMANT**, unchanged from every prior signal. **No capital was ever
> risked** — the entire forward loop ran paper-only (`POST-FABLE-HANDOFF.md` boundary; the operator funds/keys/
> authorizes, Claude never trades). *Recording note:* the durable clean gate-row write was infra-blocked for ~2 days
> by Supabase-Micro saturation at US-evening peak (every panel tick degraded, cErr > 2 → the gate correctly refused
> to auto-write to `bot_gate_snapshot`); with the verdict settled and robust across city/date subsets, the operator
> authorized recording it directly (2026-07-07). Re-open criteria: `SIGNAL-BACKLOG.md` §13.

> **↳ NEW 2026-07-24 — the 12th signal re-tested from a NEW angle at operator request (select the bucket from the
> MARKET's own signal, not our forecast) → KILL on selection, a powered NULL on the inverse, KILL on holding. It
> stays dead; the durable result is the mechanism.** The operator's framing was *"bet what the MARKET will guess the
> max temperature will be, catch the guess cheap early and sell it as it enters higher likelihood"*, plus a
> cross-check: *"a potential negative buying pattern, betting 'no' … or possibly hold to finish."* Three arms, all
> scored on the **real captured order book**, the same gates and the same frozen §9R-E estimators. **(1) Market-signal
> SELECTION into the bracket exit — KILL, 14 of 14 cells** (the frozen 10-city gate universe plus an EXPLORATORY
> 45-city panel; headline pre-registered TP 0.25). Every clustered CI is wholly negative and every winFrac lands
> **8.7–32.7%** against the 0.50 bar. **(2) Betting NO on the selected bucket — a powered NULL**: it straddles zero
> on every powered cell (45-city M0-pure **−0.83¢/share**, city-clustered CI **[−3.77¢, +1.82¢]**, n=754 / 45 cities
> / 23 days; a seeded cluster bootstrap agrees, so the inverted 0.86-to-win-0.14 tail is not what drives the answer).
> **(3) HOLD to resolution — KILL**: **−4.30¢ to −5.57¢/share** across all four 45-city panels, CI excluding zero;
> you pay ~18¢ for a bucket that wins ~13% of the time.
>
> **The mechanism is the durable finding.** The favorite-longshot bias on the cheap bucket is **REAL at +2–3¢/share**
> — and it is **almost exactly cancelled by the 2.2–2.3¢ half-spread a taker must cross** to monetise it, with the
> **0.55–0.58¢** taker fee consuming the residual (45-city pure: +2.08¢ bias − 2.33¢ half-spread − 0.57¢ fee =
> −0.83¢; the same shape holds on the strict and 10-city panels). This is the **identical "maker edge, not a taker
> edge"** conclusion as `CONVERGENCE-TUNING.md`, now measured **independently from the inverse side**: it is the
> tightest efficiency measurement this project has produced — **the market prices the NO side correctly to within
> ±2.5¢ at 95% confidence.**
>
> **The operator's premise is falsified in the direction opposite to the ask: market selection is WORSE than our
> forecast at picking winners, not better.** Pure-cell winFrac **M1 13.8% / M2 15.9% / M4 12.6% / M3 8.7%** against
> **M0 24.5%**; corroborated independently on the unfiltered ladder, where the forecast picks the winner **31.3%** of
> the time vs **M1 21.8% / M2 25.5% / M4 20.9%**. Our forecast has real skill — the market has already priced it.
> **Panel:** two on-disk archives merged (the 835-event primary + the c96 pre-07-06 dump; only **131** events
> overlapped, so it contributed **344 genuinely new events, +41%**) → **1,179 events / 45 cities / 27 dates,
> resolution coverage 100%**. **Depth binds harder than price:** fillable NO size is the thinner YES **bid**-side
> depth (median $49.5) — a **$50** floor removes **55.6%** of the panel, and at **$150** every cell in all 14 runs
> falls under the §9R-E floor. Same capacity wall as the 10th signal. **No arm earns a forward paper test** — a null
> does not earn capital, it earns being written down. Rail stays **DORMANT** with no scoped exception pending;
> read-only run, nothing placed, no credentials read. Full record: **`docs/ops/CONVERGENCE-CAPTURE-RESULTS.md`**;
> re-open criteria unchanged: `SIGNAL-BACKLOG.md` §13.

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

## Reading the verdicts — power discipline + the replication rule (added 2026-07-09)

**Not every KILL is the same kind of dead, and the ledger should say which.** Two grades:

- **Well-powered null (edge EXCLUDED):** the CI is tight enough that a tradable edge is ruled out —
  e.g. the NO-fade family (CI entirely negative, [−24.0, −19.8]), C24 regime-conditional (±2pp over 21
  days), the maker-exit forward gate ([−21.6, −3.5]). These are closed on the merits; re-opening needs a
  *different hypothesis*, not more data.
- **Underpowered wash (edge NOT SHOWN, not excluded):** the point estimate is flat-to-negative but the CI
  is wide — e.g. the °C 20¢-hold ([−26.5, +18.3]), the calibrated-book buy table ([−62.9, +56.8] on 55
  fillable bets). These panels cannot demonstrate an edge AND cannot exclude a modest one; they are killed
  by the falsified-family prior + costs, not by power. If one of these families ever matters again, the
  fix is a bigger forward panel, not a re-run of the same backtest.

When recording a new verdict, state which grade it is (the CI half-width IS the minimum detectable effect —
report it). A wide-CI KILL claiming "the market is efficient" overstates what was measured.

**REPLICATION RULE (pre-registered 2026-07-09):** any future **forward PASS** — on the efficiency monitor
or any other live paper gate — must **persist through a second, non-overlapping accrual window** meeting the
same sufficiency bars (≥40 markets / ≥6 cities / ≥7 days) before it reaches the operator as a capital
question. Rationale: dozens of 5%-level gates have been run and more accrue daily; by arithmetic a false
PASS will eventually occur. One replication window cuts the false-GO odds roughly twenty-fold at the cost of
waiting. This composes with — never replaces — the standing rules: no capital before a frozen forward PASS,
operator decides, Claude never trades. (Mirrored in `EFFICIENCY-MONITOR.md` §the-bar-for-acting.) Related
structural guard, same date: the §9R-E gate now carries a **mid-basis PASS cap** (`VerdictOpts.priceBasis`,
`opening-convergence.ts`) — a mid/synthetic-priced panel can no longer emit a full PASS at all, after three
mid-basis passes flipped negative on the real book (maker-exit, C22 fade, C23 trough).

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
| Signal backlog — untested angles, priority-ordered, pre-registered gates | `SIGNAL-BACKLOG.md` | — |
| Backlog #9 precip/snow/wind markets — **KILL at the liquidity gate** (2026-07-03: temp ladders median $34k/24h; precip/wind are sparse one-offs ≤$802/24h — no universe worth a forecast pipeline) | `SIGNAL-BACKLOG.md` | item 9 |
| Backlog #7 sharp order-arrival signal — **KILL, structurally impossible keyless** (2026-07-03: the public book is anonymous by design; the only wallet-attributed feed is fills/settlements — order-placement data does not exist for us) | `SIGNAL-BACKLOG.md` | item 7 |
| Backlog #11 nonlinear-ML residual post-processing — **KILL** (2026-07-03, pre-registered boosted-stumps design, l3b feature set: corrected TEST MAE WORSE than raw by 0.0159°C, day-clustered CI [−0.0280, −0.0051] excludes 0 on the harmful side; TEST residual R² −6.11% vs the linear +0.60% bound; TRAIN improved/TEST degraded = overfit. The one feature leak (climatology) biases FOR the model — it still lost. Closes the sole open gap from EXTERNAL-AGENT-CROSSCHECK.md; 3rd post-processing kill after linear MOS −3.32%) | `SIGNAL-BACKLOG.md` | item 11 |
| Backlog #10 model-update-shock latency — **INSUFFICIENT_DATA, structural** (2026-07-03: live 10Z/22Z build snapshots exist only from target-date 06-13 → the pre-registered TRAIN half has 0 build-pair deltas, no shock cutoff fittable, 0/221 deltas classifiable; separately `market_snapshots` >30d is downsampled to 4/day — retrospective ask-recovery at 20-min grain is impossible for any older window. Testable only via a forward-designed capture, which the low prior (3 latency-family KILLs) does not justify. Re-open only with ≥30d of accrued 10Z/22Z pairs AND a forward ask-capture plan) | `SIGNAL-BACKLOG.md` | item 10 |
| Backlog #6 cross-horizon information-propagation lag — **KILL, well-powered null** (2026-07-03, pre-registered design: sibling day-N resolution → day-N+1 mispricing vs our last pre-R_N build, entry ≤R_N+2h: n=568 bets/44 cities — bars cleared wide — edge +0.80pp, CI [−1.74,+3.34]; day-clustered [−2.14,+3.61]. The market doesn't lag the sibling-resolution channel; 3rd latency-family confirmation after WO-4/WO-5) | `SIGNAL-BACKLOG.md` | item 6 |
| Backlog #5 multi-bucket basket entry — **KILL** (2026-07-03, amended chw=1 spec after the chw=0 run proved vacuous: basket 2/3 full mean 3.78% vs pinned 6.81%, ciLow −3.23% vs +0.25%; jackknife fragility explodes LOCO 15/45→45/45, LODO 9/21→21/21; the chw=1 single-bucket control shows widening alone already hurts (4.61%, CI [−2.66,+7.49]) and splitting dilutes further — the anticipated dilution-KILL branch. Single-bucket pinned config stays the reference) | `SIGNAL-BACKLOG.md` | item 5 |
| Backlog #2 post-bust reaction pricing — **KILL** (2026-07-03 scan, TEST-half only, pre-registered cutoffs: n=84 bust-triggered bets ≥ the 40 bar, edge +2.91pp but 95% CI [−3.21, +9.03] straddles 0 — a measured null, not INSUFFICIENT_DATA) | `SIGNAL-BACKLOG.md` | item 2 |
| Backlog #3 conditional efficiency by disagreement regime — **NO-PASS: naive gate-PASS REVOKED by hardening; INSUFFICIENT_DATA at the day grain** (2026-07-03: Q4 +7.47pp "CI [+1.06,+13.87] n=104" was per-bet i.i.d. — the 104 bets collapse to 29 station-days on **3 distinct weather-days** → day-clustered CI [−7.86,+23.09]; station-clustered [−0.43,+13.62]; permutation false-PASS rate **17.3%**, P(mean≥obs) 6.85%; hardening script lens-reviewed ZERO DEFECTS + independently reproduced bit-for-bit. Also: Q4 had 29 station-days vs the gate prose's "≥30 station-days" — the strict reading fails the n bar outright. Same failure shape as the cross-venue false-PASS. Point estimate stays positive at every level, so the hypothesis is unproven-dead, not dead: re-open only when the TEST period holds ≥10 distinct Q4-carrying weather-days) | `SIGNAL-BACKLOG.md` | item 3 |
| Backlog #4 extreme-day tail calibration — **KILL, sign-reversed** (2026-07-03: tail gap −1.73pp, CI [−2.77, −0.69], n=281 far-tail bets / 236 extreme days — the market OVERPRICES far tails on extreme days; the behavioral underpricing hypothesis is backwards, consistent with the §12 cheap-longshot family) | `SIGNAL-BACKLOG.md` | item 4 |
| Backlog #12 CITY-SCAN — all-45-city historical city-sim replay — **TWO ENROLLMENT CANDIDATES (analytics selection, no capital): ankara/14h + houston/14h** (2026-07-03, pre-registered TRAIN ≤06-24 selection via the entry-watch shrinkage LB / TEST ≥06-25 confirmation: ankara LB +3.6pp n=11 → TEST +$44.88; houston LB +3.1pp n=11 → TEST +$12.04; munich/16h + buenos-aires/14h fail TEST net, helsinki/15h fails TRAIN LB. **POOLED ROI negative at EVERY entry hour** (−11.4pp @14h → −101.9pp @19h; late-hour collapse partly the locked fixed-bucket bet rule) — the mechanism-A pooled-efficiency prior re-confirmed; surviving heterogeneity is thin and every TEST CI straddles 0 at n=7–8 → the scan SELECTS, the live paper loop CONFIRMS. Two bit-identical independent runs + one adversarial lens; 3 findings adjudicated, none candidate-changing — incl. 296 TRAIN-only frozen-seed look-ahead bets, measured conservative (each touched top-5 cell IMPROVES without them; TEST holdout 100% clean). Enrollment SQL staged in SIGNAL-BACKLOG §12 — operator decision; live refs karachi/singapore/amsterdam do NOT clear the TRAIN bar in this window) | `SIGNAL-BACKLOG.md` | item 12 |
| Backlog #1b reward-stacking on the maker-exit sell leg — **gate-PASS on the 844-event/21-day backtest** (2026-07-03: full-panel ciLow +0.25%→+2.38% at the conservative 0.05 pool-share floor; TRAIN+TEST both independently PASS from share 0.10; reward delta exactly linear in share. CAVEAT: pool share is UNMEASURED — per-market pool $67/day is a derived average of real 06-24 observations ($66–$226 range); one-sided partial credit (Qtwo/3) modeled per 1a. Backtest cannot resolve the share — only a forward/live read can. Does NOT alter the forward gate of record; if anything the live paper loop's income is understated by excluding rewards) | `SIGNAL-BACKLOG.md` | item 1b |
| **12th signal — opening-convergence maker-exit — forward gate KILL, closed 2026-07-07** (live paper gate mean net −12.6%, CI [−21.6%,−3.5%], 62 mkts / 26 cities / 7 days, makerFillRate 0.065 vs backtest 49.0%, rebate $0, net −$168; the backtest +6.7% PASS was a synthetic `house_gaussian` book converging by construction — the real efficient book does not, so the resting-maker leg almost never fills live. Same efficiency wall, real book. No capital risked; recorded via operator override after ~2 days of Micro-saturation blocking the clean write) | `FINDINGS.md` (2026-07-07 close) · `MAKER-EXIT-SIM.md` (root-cause banner) | `SIGNAL-BACKLOG.md` item 13 |
| **Full-history price calibration — the market is calibrated, "buy-the-dip" is a survivorship illusion** (2026-07-09, operator-directed, 238.3M price-obs / 6,146 winning buckets / 45 cities / Jan-25→Jun-26. Winners DO get cheap — median low **12.5¢**, bottoming **~15% into life** (~10h), ~**8** swings ≥5¢, 90% dip <30¢ — but that is conditional-on-winning HINDSIGHT. Point-in-time the price series is **calibrated with a consistently NEGATIVE gap** across the 5–55¢ tradable band: a bucket at 13.5¢ wins 10.8%, at 22.5¢ wins 20.0%, at 45¢ wins 39.8% — you win **2–5¢ LESS than you pay, frictionless**, badly −EV after the 5% taker fee + spread. At the dip moment the future winner is indistinguishable from the future loser (buckets that cratered <5¢ won 2.3%). Re-confirms §12 cheap-longshot + the dead convergence/NO-fade family from the calibration angle; no new edge. Caveat: `p`=implied-prob mid, so the real ask sits a spread above — every buyable number is an optimistic upper bound) | `scripts/research/out/winning-bucket-analysis.md` (+ `winning-bucket-lows.csv` / `price-calibration.csv`, local) | — |
| **Winner ±2 neighborhood + forecast-anchored realizability — the +EV is hindsight, the tradeable version is −1.4%/fee** (2026-07-09, operator-directed. Descriptive spread: winner buys ~12.5¢, passes ~88.5¢ before an endgame that starts at ~83% of life; the colder neighbor (rp−1) is the strongest competitor (high p90 0.84). WITHIN the true winner-centered ±2 neighborhood the point-in-time gap turns slightly POSITIVE (+1–3% frictionless, buy 5–40¢) — but that is the hindsight of drawing the neighborhood around the actual winner. **REALIZABILITY TEST (the operator's theory: our ±1° accuracy should ≈ knowing the winner):** re-anchored the ±2 neighborhood on OUR FORECAST (`pred_bucket_l1`) instead of the winner. Forecast-±2 CONTAINS the winner **90.6%** (±1 74%, exact 33%, ~0.38 bucket cold) — good containment, but the buy-band [5–40¢] hold EV **collapses from the hindsight +2.14%/+1.09%-after-fee to −0.37% frictionless / −1.42% after fee.** Containment isn't the constraint — INSIDE the neighborhood price≈win-prob because the market already priced our forecast in. Exactly why the forecast-centered convergence/maker-exit plays died, now with a number. NO realizable buy/sell rule; NO-fade side dead too (at 70–85¢ a bucket is the winner 81.7%). Open non-price direction: a winner fingerprint from momentum/hold-time/order-flow, not price) | `scripts/research/out/neighborhood-analysis.md` (+ `neighborhood-*.csv`, `forecast-anchored-*.csv`, local) | — |
| **Peak→dip→recover round-trip scalp — KILL, a martingale scalp priced by the level** (2026-07-09, operator-directed. The path-structure sibling of the calibration finding, and the FIRST forward-executable form: buy any bucket that ALREADY traded ≥25¢ and has NOW dipped to 10–15¢ (both observable at entry — NOT the C19 lifetime-min hindsight), sell on recovery to ≥25¢, else hold to resolution. 23,105 round-trips / 45 cities / 523 days. **Part A (curvature by offset):** the peak→dip→recover shape IS strongly offset-dependent — recovery rate winner **99.8%** → ±1 **63.0%** → ±2 **43.9%** → far(≥3) **33.8%** — but the winner's ~100% is TAUTOLOGICAL (a winner that dips to 12¢ must cross 25¢ en route to $1) and unusable: at the 12¢ entry moment a winner-dip is indistinguishable from a far-bucket-dip. **Part B (the trade):** median entry 14¢, empirical hit-rate **54.5%** sits at/below the **martingale null 56.0%** (=entry/sell) — the recovery is not mean-reversion, it is the level being right. Asymmetric payoff (win small-capped 25¢ vs lose the full stake on dip→0) ⇒ **winFrac 54.5% > 0.5 but EV negative** — a naive win-rate test false-passes; the return-CI kills it. §9R-E gate: frictionless +0.89% CI **[−1.31%,+3.09%]** (wash, includes 0); maker-exit ceiling −14.82%; **taker ×1 −21.48% CI [−23.16%,−19.80%]**; breakeven spread NEVER positive (fee-only −6.2%). Re-confirms §12 / the calibration finding from the path-structure angle; no new edge) | `scripts/research/out/WINNER-ROUNDTRIP-ANALYSIS.md` (+ `winner-roundtrip-panel*.csv`, local) | — |
| **Non-price winner-fingerprint hunt — price is a SUFFICIENT STATISTIC; the one +EV was a mid-pricing artifact** (2026-07-09, operator-directed; closes the last open direction from C20/C21. Framed as the sufficient-statistic test: a non-price feature has an edge iff `E[won\|price,feature] ≠ E[won\|price]` beyond cost. Panel = 652,257 instants / 6,273 events / 45 cities / 523 days; 10 features {momentum 1/3/6h, accel, drawdown, run-up, hrs-since-peak, oscillation count, vol, dwell}. **(1)** Every feature's price-controlled lift is a real-but-trivial **±0.3–1.9pp** and — decisively — **every feature-group's frictionless EV (won−p) is NEGATIVE**: no side wins more than its price; momentum micro-structure exists but the market prices it in; best BUY cohort gates **−34%**. **(2)** The only cohort that gated positive on the mid series — fading the most-overpriced "unmoved cheap" buckets (bottom run-up decile) — is the known §12/C19 cheap-longshot overpricing (+3.46% ≈ +2.8pp absolute), and it passed EVERYTHING on the mid (spread ×2, OOS +1.81%, city+day-clustered, zsMC) — then **FLIPPED +3.39%→−9.75%** priced off the REAL bid/ask on the same 3,073 opening_captures events (median bid-side executable depth **$2**, p10 $0: the mid is a stale one-sided mark). Flagship trap #1+#8, same as maker-exit. **(3)** Independent third test on the real order BOOK (imbalance / spread / depth on `opening_captures`): none carries residual info beyond mid (imbalance +3.3pp CI [−0.4,+7.0], all straddle 0); baseline cheap-buy KILLs −80.3%; only `house_gap`=the dead forecast signal shows residual info, and its trade loses. All three (path-shape, price level, order book) add nothing the mid lacks. No non-price fingerprint exists; market efficient; no new edge) | `scripts/research/out/NONPRICE-FINGERPRINT-THESIS.md` + `ORDERFLOW-FINGERPRINT.md` (+ `nonprice-*`/`realbook-fade-*`/`orderflow-*` panels, local) | — |
| **Regime-conditional efficiency RE-OPENED on the live panel + RESOLVED — KILL, well-powered null (C24)** (2026-07-09. The last "unproven-dead" signal — backlog #3, the 2026-07-03 Q4 +7.47pp gate-PASS revoked as INSUFFICIENT because its 104 bets = 3 correlated weather-days. Blocker diagnosed: the pre-registered scan reads `forecast_snapshots snapshot_slot='backfill'`, a one-time reconstruction **frozen 2026-06-15** → re-running reproduces the same 3 days. The live 10Z/22Z operational slots (06-13→present) are the SAME 8 models, mean signed bias **+0.047°C** on overlap (clean transfer). New `conditional-efficiency-live.ts` warms up + fits TRAIN quartile cutpoints on backfill (≤06-15), scores the TEST **entirely on live 10Z** (06-16→07-08): **21 distinct Q4 weather-days** (re-open bar ≥10 now MET, 7× the original 3) → Q4 edge **+1.16pp [−0.41,+2.73]** straddles 0 per-bet, **day-clustered +1.05pp [−1.11,+3.20]** includes 0 (gate FAIL), permutation 2.6%. 22Z robustness identical (22 days, +1.10pp [−0.83,+3.04]). A faint monotone gradient (Q1 −0.67→Q4 +1.16pp) but ~1pp, CI-includes-0, −EV after fee. The +7.47pp was 3-correlated-day noise; well-powered it is ≈+1pp non-significant. **#3 is now dead (well-powered), not merely unproven — the last open residual is closed.** Re-open needs a DIFFERENT hypothesis, not more days. Typecheck clean) | `scripts/research/conditional-efficiency-live.ts` · `SIGNAL-BACKLOG.md` item 3 | — |
| **"$10/day on our predicted bucket" honest P&L (MARKET-PNL) — break-even to a NET LOSS; the naive +13.1% was look-ahead + the dead convergence carry** (2026-07-09, operator-directed. CAUSAL walk-forward forecast (the archive's `pred_c_l1` is hindsight-calibrated — its removal alone cuts win rate 41.4%→34.9% and 24h ROI +13.1%→−1.4%) joined to the 238M-row mid archive at real bet-timings, with a market-favorite control: 1,751 bets / 45 cities / 48 weather-days → **−1.4% at the mid / −5.9% at a 1¢ ask**, day-clustered CI [−10.0%, +6.9%]. The monotone bet-earlier-is-better ramp (+13.8% at 48h → −60.5% at 6h) is the **convergence carry of signal #12**, confirmed by the favorite control carrying the same way — a pricing artifact, not forecast skill. Power grade: **wash leaning negative** (CI includes 0); the KILL stands on the falsified-family prior + costs) | `MARKET-PNL.md` | — |
| **Per-city cheap-entry buy table (BUY-TABLE) — KILL/no-edge at BOTH cost bases; the calibrated book shows the strategy mostly cannot fill** (2026-07-09, operator-directed; the `/paper-trade` record. Legacy mid+1¢: −28.2%/−$977 on 347 bets / 43 cities / 46 days, day-CI [−57.7, +4.3]. Re-scored same day on the CANONICAL calibrated book + taker fee (`cost_model.py` ↔ core `CALIBRATED_BOOK`) with depth-fillability: the population collapses to **55 fillable bets** (cheap-zone walked depth is $4–$24 — a $10 order cannot fill below mid ~0.085) → **−9.2%/−$51, day-CI [−62.9, +56.8]**; every well-populated lead negative; the 6h +141% row is a 3-bet fluke. Power grade: **underpowered wash** — cannot exclude a modest edge, demonstrates none; signal #12 stays dead. Per-city "winners" (16/43 legacy, 6/33 calibrated) are longshot noise) | `BUY-TABLE.md` (+ the committed `city-buy-table-results.ts` record) | — |
| **BREAKEVEN-SKILL — the skill target trading would require, quantified → the forecast-for-trading route is closed by arithmetic** (2026-07-09, project-review deliverable. Per mid band at the deployable 24h entry: taker breakeven needs **+3.7…+5.1pp of win-prob beyond price** (longshot tax + calibrated spread + fee). Our causal forecast carries REAL within-band residual info (+2.7…+6.7pp; 20–30¢ and 40–55¢ CIs exclude 0 — C22's `house_gap`, reproduced) — but it is NOT monetizable: **EV of buying our own bucket at its all-in cost = −2.2%/$1, day-clustered CI [−4.3, −0.2] — entirely negative, well-powered** (10,834 zone rows / 45 cities / 49 days). The naive pooled lift-beats-requirement read (+7.3 vs +4.2pp) is a WITHIN-BAND COMPOSITION artifact (mid\|ours 26.2¢ vs 20.5¢); the naive 48h positive (+2.8%) is a forecast-availability look-ahead (lead-1 doesn't exist at 48h) — honest lead-2 read +1.3% [−0.5,+3.2], a wash in the dead convergence-carry family on a mid-basis panel. **Skill target: ~+2.2pp conditional win-rate where the market disagrees (~+8–9% relative) at unchanged prices — ~10× beyond any tested forecast lever, against a market that is already the sharper forecaster on the same public inputs. ⇒ the ≥12-month forecast backfill is ADJUDICATED: analytics-product investment only, NOT a trading investment.** Power grade: well-powered negative at 24h) | `BREAKEVEN-SKILL.md` (+ `out/breakeven-skill*.json`) | — |
| **Pricing-bucket exhaustive close (C23) — the CROSS-bucket axis is efficient too; price is a sufficient statistic on the ladder vector, not just the single bucket** (2026-07-09, operator-directed "leave no stone unturned". Forecast-free sweep of the axes C22's single-bucket frame could not cover, on 26,176 liquid ladder snapshots / 45 cities / ~522 days + the real `opening_captures` book. **T1 — high band (55–95¢) calibration** (C19 scoped only 5–55¢): calibrated, every event-clustered gap CI brackets 0 (0.55 −3.6pp[−6.7,−0.6] the wrong-way overpricing; rest ≈0), −EV after fee like the cheap band — full price range now closed. **T2 — cross-bucket ladder GEOMETRY** (the flagship: a Tmax dist is physically single-peaked, so an interior price trough = a bimodal ladder the market shouldn't rationally price → buy it forecast-free): troughs are rare (1.1% of snapshots, 248 trades); **KILL frictionless** — winFrac 0.169 (<0.5 outright), edge +2.95pp [−1.54,+7.44] straddles 0, city ciLow −3.3%, day ciLow −2.1%, zsMC 0.016; fee-only ciLow −3.9%. **T3 — real-book flip** (trap #1/#8): the frictionless +2.95pp mid **flips to −8.72pp [−11.27,−6.17]** (interval fully negative) priced off the actual `opening_captures` bestAsk+fee; trough `depthUsd` p50 $4.33/p10 $0.26, only 18.5% clear $20 (depth-gated even worse, −17.4pp) — the same sign-flip that killed C22/maker-exit. **T4 — whole-ladder sharpness**: modal gap ≈0 every life-decile, entropy 1.49→0.09 nats monotone — market sharpens efficiently, no mis-sharpening. The one frictionless "PASS" (spike-fade +16.1%) is the modal favorite of every ladder ≡ favorite-longshot/C20, a stale-mid artifact. Closes the last corner of the price data itself; any future price-only angle is a re-skin. `bucket_idx` is raw-Gamma order — temperature axis parsed from label (trap #7 avoided); two bit-identical runs) | `PRICING-BUCKET-EXHAUSTIVE.md` (+ `pbx-*.json` panels, local) | — |

---

_This is an analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
