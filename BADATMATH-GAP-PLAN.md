# BADATMATH-GAP-PLAN — closing the gap to the #1 weather sharp

> **What this is.** The council-derived, builder-ready plan for the operator's question: *"isolate the
> gaps between what we've built and badatmath's setup; what can we do to reach the same bidding success?"*
> Authored 2026-06-22 from a `/council` deliberation (two Opus-4.8 chairman passes + three advisor
> lenses: First-Principles, Executor, Expansionist). **Posture: every move here is a cheap, pre-registered,
> kill-gated test on data we already own — WO-5 discipline. Build no harvesting infrastructure, buy no
> data, and re-open no trading thesis until the Move-1 router returns a pre-committed positive.**
>
> Cross-refs: `WALLET-RECON-HANDOFF.md` (the badatmath forensics + §10–§12 the **four** falsified angles),
> `MAKER-SPRAY-SIM.md` (the 4th angle), `FORECASTING-RD.md` (the point-skill ceiling), project memory
> `polymarket-sharp-weather-wallet.md`.

> **⚠️ CORRECTION applied 2026-06-22 (after the council ran on a stale premise).** The council was briefed
> that the 4th angle (maker-spray on our forecast) was *"built but unrun."* It had in fact been **run and
> CLOSED** (`WALLET-RECON-HANDOFF.md` §12, full universe: 45 stations / 721 events): **maker edge −1.46pp
> (indiscriminate) / −1.73pp (forecast-conditioned), 95% CI excludes 0 → FAIL both modes; our forecast as a
> cheap-tail SELECTOR is value-NEGATIVE (using it to pick buckets is worse than not); adverse selection
> confirmed (filled-hit 3.1% ≪ eligible 5.1%); Brier ours > market.** This **directly answers the council's
> Move-1 `M2` arm** (maker-spray on *our* EMOS) with a clean negative. It does **not** kill the plan — it
> sharpens it: the Expansionist predicted exactly this ("you're testing the harvester with a broken
> forecast"). What is now closed: *our-own-raw-EMOS as a maker.* What remains genuinely **unrun and live**:
> (1) **M1** — do badatmath's *picks* resolve more often than *our* EMOS predicts? (the calibration
> *diagnosis*, never measured), (2) **Move 4** — the intraday running-max physics signal (a *different,
> better* forecast), (3) **Moves 5/6** — riding the *sharp's* revealed distribution instead of ours. Move
> statuses below are updated to reflect this.

> **✅ M1 RAN 2026-06-22 — AMBIGUOUS (the router returned).** `WALLET-RECON-HANDOFF.md` §13, full universe
> (45 stn / 721 ev, fork-equality `1.2991°C` byte-match; 64,934 fills → 5,139 cheap-Yes → 1,050 joined to
> EMOS). **M1 gap (won − EMOS_p) on the cheap tail (EMOS_p<0.15): lead-1 +2.37pp CI[−0.18,+4.91], lead-2
> +2.76pp CI[+0.01,+5.52]** — a *whisper* of tail underweighting that **does NOT clear the frozen +3pp PASS
> bar** (CI includes/grazes 0); not the clean <+1pp KILL either → **AMBIGUOUS, stable across leads.** M3:
> ours−market tail Brier is **positive** (market still sharper, corroborates KILL-GATE 2). M4: the realized
> edge is in the **0.08–0.16 band**, *negative* at the extreme cheap — refining §3. **Per the §5 branch
> table → analytics input, NOT a forecast-lever reopen:** no Move 7 (bar uncleared), destination is the
> analytics product (Move 10). Built `core/sim/tail-calibration.ts` (pure + 13 tests) +
> `scripts/research/m1-tail-calibration.ts` (spine). 1064 tests green, read-only, no migration. The
> remaining genuinely-distinct lever is **Move 4** (intraday running-max), which this result doesn't touch
> but which overlaps a closed WO-5 finding (low prior).

---

## 1. The reframe (what's actually true about the gap)

The brief's premise — *"the gap is forecast/calibration superiority"* — is **half right, and the wrong
half is load-bearing.** badatmath's edge is **multiplicative, not either/or**:

> **edge = (tail calibration good enough to survive adverse selection) × (maker microstructure: rest ~7pp
> under the ask + rebate) × (breadth: ~45 cities × ~6 buckets × hundreds of bets/day).**

This kills two tempting-but-wrong conclusions:
- **"Just be a maker, the spread carries you."** No — a resting bid fills only via **adverse selection**
  (you get hit on buckets the market marks *down* = losers; you miss winners whose ask rises away). The
  post-fill mid drifting **−7.38% away** from their pick proves there is no free spread. Only tail
  calibration converts an adversely-selected fill into +$25k.
- **"Just forecast better on points."** No — point skill is at its R²=0.6% ceiling, and the money lives in
  the **tail (<0.25 buckets)**, which we have **never measured separately.**

**The crux — why "we have no edge" is overstated and not yet earned.** Our kill-gate chain only ever
measured the **taker / mid / ask** surface:
- KILL-GATE 2: `calibratedP − ask` → failed.  Brier(ours) vs Brier(**mid**-implied) → we lose.
- Copy-trade as a **taker crossing to the ask** → −6.05pp.

badatmath operates **only** on the **bid / maker / tail** surface (rests ~0.107 on cheap longshots, earns
the rebate). Bid-side pricing on sub-25¢ longshots is set by *who will provide cheap liquidity and
withdraw under inventory pressure* — not by who has the best forecast.

**Updated status (post-§12):** the bid/maker/tail surface has now been measured **for our own raw EMOS
forecast** (the maker-spray run) and it is **efficient/value-negative** — resting below the ask does not
rescue an inferior calibration; adverse selection makes it worse. So the live question is no longer
*"can a maker entry beat the ask?"* (answered: not on our forecast) but the **two diagnostic/forecast
questions the maker-spray run did NOT ask**: *(i) is our tail miscalibrated relative to badatmath's
revealed picks — i.e. is there a fixable forecast, not just a harvesting trick?* (M1, never measured), and
*(ii) is there a genuinely BETTER forecast available — the running-max physics signal, or the sharp's own
revealed distribution — that a maker entry could then harvest?* (Moves 4/5/6). That is where the
decisive, still-free experiments live.

## 2. The decomposition the whole plan routes on (three candidate sources of the gap)

| Case | What it means | Lives if… | Fix |
|---|---|---|---|
| **A — our tail is miscalibrated** | badatmath's cheap buckets resolve *more* often than our EMOS predicts | hyp (a) | kernel dressing / ensemble inflation / σ-tail widening — **no new data**, cheap |
| **B — pure microstructure** | their buckets resolve ≈ EMOS frequency yet they profit | hyp (b) | the maker-spray rail IS the answer; our forecast is already good enough |
| **C — information we lack** | neither A nor B holds | hyp (c)/(d) | the intraday running-max top-up, or paid inputs |

Move 1 (below) is the **free router** that decides which case we're in — and thereby *prices every
downstream move*. Nothing expensive runs until the router returns.

---

## 3. The ranked portfolio (EV per unit effort)

> Ranks are consolidated across both chairman passes. **#1 gates everything.** #2 runs free in parallel.
> #4 is the highest *ceiling*. #10 captures most of the value regardless of any result.

### ★ MOVE 1 — The combined cheap-tail ROUTER test  ·  FREE · ~1 session · **DO FIRST, GATES ALL**

One SQL/notebook table over data already in Postgres. **It must run both arms together** — the bid arm
alone is self-fooling (a positive bid test driven by *our own optimistic tail* loses real money).

> **Post-§12 refocus:** the **M2** half (maker-spray on our EMOS) is already FAIL. The router's remaining
> live value is the **M1 calibration diagnosis** — *do badatmath's revealed cheap picks resolve more often
> than our EMOS predicts?* — which the maker-spray run **never asked** (it used our forecast as the
> selector; it never scored *their* picks against *our* distribution). M1 + M3 + M4 are still unrun, still
> free, and decide whether the gap is a **fixable forecast** (Case A → Move 7), **information we lack**
> (Case C → Move 4), or **rent-collection we can't replicate** (→ Move 10).

**Build it as a new arm on the existing `scripts/research/maker-spray-feasibility.ts` spine** (it already
loads EMOS μ/σ → `gaussianBucketProbs`, `market_events.winning_bucket_idx`, `market_buckets`, and the
`market_snapshots` bid/ask series with the adverse-selection fill model). Add the badatmath-picks join.

**Inputs (all on disk):** badatmath fills (`wallet-forensics` reconstruction → city, target_date,
bucket_idx, entry_price, resolved outcome) · our EMOS_p per city-day-bucket · contemporaneous
market-implied p (`market_snapshots` mid) · achievable maker bid (`market_snapshots.best_bid` series) ·
resolved outcome (`market_events.winning_bucket_idx`).

**FROZEN metrics — commit in a comment block BEFORE querying (do not move):**
- **M1 — our-tail calibration on *their* picks.** On badatmath picks where `EMOS_p(bucket) < 0.15`:
  empirical resolution-freq − EMOS_p. **PASS (tail underweighted, Case A) = ≥ +3pp, pooled lower-95% CI > 0.**
- **M2 — harvestability on *our* forecast.** ✅ **ALREADY ANSWERED — FAIL** (`WALLET-RECON-HANDOFF.md` §12,
  the maker-spray run): on our EMOS cheap buckets, `calibratedP − achievable_bid` via the adverse-selection
  fill model is **−1.46pp/−1.73pp, CI excludes 0**, and our forecast as a selector is value-negative. *Do
  not re-run as-is.* M2's remaining job is purely to be **re-run after a forecast upgrade** (Move 4/5/7) as
  the harvest test — never again on raw EMOS. (Original frozen PASS bar, kept for the re-run: pooled mean ≥
  +1.5pp, lower-95% CI > 0, AND ≥ 20 of 45 stations individually positive.)
- **M3 — tail-local deficit.** `Brier(EMOS) − Brier(market)` restricted to `<0.15` buckets (is the deficit
  tail-specific or everywhere?).
- **M4 — their realized per-bet edge.** badatmath entry-price vs empirical resolution-freq by decile (the
  target we're trying to match).
- **PRE-COMMITTED KILL:** `M1 < +1pp` AND `M2 lower-CI < 0` → our forecast is not the gap *and* the bid
  side isn't harvestable with our forecast → route to Moves 3/4; if those also null → **pivot to the
  analytics product (Move 10); do NOT spawn a new forecast lever.**

### MOVE 2 — ✅ DONE (maker-spray backtest, raw EMOS) — FAILED as expected

`WALLET-RECON-HANDOFF.md` §12. Ran full-universe (45 stations / 721 events): maker edge −1.46pp/−1.73pp
(CI excludes 0), adverse selection confirmed, our forecast value-negative as a cheap-tail selector. The
4th angle is **falsified.** This is the **baseline** against which any calibration-corrected or
better-forecast re-run (Moves 4/5/7) is measured. *Methodology note from the run: the pre-registered EV/$1
CI was heavy-tailed and zero-skill MC showed P(PASS|noise) ≈ 99.7–100% — the conclusion correctly rests on
the low-variance `won−restPx` edge + the AS diagnostic, not EV/$1. Reuse that lesson for all cheap-longshot
re-runs.* **The harvester is built and proven on a broken forecast; the open work is feeding it a better one.**

### MOVE 3 — Late-top-up forensic  ·  FREE · ~½ day · gates Move 4

Bucket badatmath's fills by lead time; measure distinct-bucket overlap between far entries (~43h) and
close-in top-ups. **FROZEN: overlap < 70% ⇒ they are *repricing* on intraday info, not stacking** → names
hypothesis (d) as live and tells you whether Move 4 is worth building *before* you build it.

### MOVE 4 — Intraday running-max conditioned-distribution test  ·  LOW · 2–3 days · gated on Move 3 · **HIGHEST CEILING**

The one hypothesis with **physics**, not statistics, behind it — and almost certainly *what badatmath's
top-up actually is.* Tmax occurs ~14–16h local; by mid-afternoon the observed running-max is a
near-deterministic floor: buckets below it are **dead** (P→0), the live range is physically pinned, and a
thin near-resolution market reprices this **slowly.** We already capture the running-max feed + METAR.
**This is literally "genuinely new out-of-market information" — it satisfies the operator's own re-open clause.**

**Experiment:** for resolved events, reconstruct the running-max series; at T-minus-{6,4,2}h compute a
running-max-conditioned bucket distribution (dead buckets → 0, renormalize). **FROZEN: conditioned Brier
significantly beats the contemporaneous market at the same timestamp on ≥ 30 of 44 stations, pooled 95% CI
excludes 0. KILL if the market already absorbs the running-max (no Brier gap).** Price it as a **cheap
convex option, not a base case** — it has a plausible null (the market is a sharp day-before forecaster).
If it hits, the prize is a **market-beating intraday Tmax signal** that generalizes to Kalshi + energy
desks — worth far more than $25k/yr.

### MOVE 5 — Treat the sharps as FORECASTERS in our ensemble (not traders to copy)  ·  ✅ RAN 2026-06-22 — KILL (value-NEGATIVE)

We falsified *trading* on badatmath's fills (spread tax — a harvesting problem). We never tested
*forecasting* with them. Its revealed cheap-spray is a **+1.34pp-edge distribution handed to us free,
daily, that we currently throw away.** Build a stacked ensemble `[market-implied + EMOS-orthogonal +
sharp-revealed-spray]`, and don't stop at one wallet — weight the **top-5 WEATHER-leaderboard wallets** by
measured calibration into a "smart-money consensus." **FROZEN: stacked OOS Brier significantly beats
market-implied-alone (the thing that already beats us). KILL if the sharp's distribution adds no orthogonal
info over the market.** (Clean offline on resolved events; lagged live — fine for the forecast + analytics
product, a latency problem for live harvest, solved later.)

> **✅ RAN 2026-06-22 — KILL (`WALLET-RECON-HANDOFF.md` §14).** Full universe (45 stn / 721 ev, 174
> sharp-touched events, fork-equality `1.2991°C` byte-match). Walk-forward "smart-money-consensus" stack vs
> the MARKET baseline: **M+S improvement (Brier_market − Brier_stack) = −1.74pp CI[−3.44,−0.04] (lead 1) /
> −1.20pp CI[−2.35,−0.05] (lead 2)** — CI EXCLUDES 0 on the *negative* side: folding the sharp's revealed
> distribution into the market is **value-NEGATIVE**, not merely already-priced. M+E ≈ 0 (re-confirms
> KILL-GATE 2: our EMOS adds nothing over the market); marginal-sharp −1.72/−1.17pp (CI excludes 0);
> zero-skill P(PASS|shuffled)=0.0%. STABLE across leads. **The sharp's cheap longshots mostly LOSE → tilting a
> calibrated market toward them moves mass off the favourite → worse Brier (same mechanism as §12's
> value-negative selector).** The 5th independent angle to confirm the edge is pure microstructure, not a
> superior distribution. Built `core/sim/sharp-ensemble.ts` (pure + 27 tests) +
> `scripts/research/m5-sharp-ensemble.ts` (spine). 1091 tests green, read-only, no migration. Destination
> remains the analytics product (Move 10). The single genuinely-distinct lever still unrun is **Move 4**
> (intraday running-max physics — overlaps closed WO-5, low prior).

### MOVE 6 — Re-run copy-trade as a MAKER, not a taker  ·  LOW · ~1 day

The −6.05pp §11 falsification crossed the spread (7pp tax). Paper-replay **resting at badatmath's fill
level** on its picks (fill model = ask collapses to your level). **FROZEN: maker-follower net edge after
rebate, lower-95% CI > 0 over the same 721-event window.** If positive, you can ride the sharp with the
rail you already built — **no better forecast required.**

### MOVE 7 — Tail-calibration fix → re-run maker-spray  ·  LOW · conditional on Move 1 = Case A

Kernel dressing / ensemble inflation / NGR σ-as-f(ensemble-spread) on the 5th–25th percentile, then re-run
Move 2. The before/after IS the proof. Add a **post-2026-05-20 station-bias term** (the regime break
coincides with badatmath going vertical).

### MOVE 8 — Industrialize breadth: the 45-city panel as the unit of analysis  ·  LOW · mostly built

We've measured edge at N=1 (EHAM, taker, modal) and called it noise. **badatmath's whole strategy IS the
law of large numbers** — a +0.5pp edge invisible at one station is real PnL across 45 cities × hundreds of
bets/day. Reframe the maker-spray module to run the whole panel. This is the harvesting infra for Moves 4/5.

### MOVE 9 — Single-city paid-data probe (ECMWF 51-member ensemble)  ·  $200–500 · 1 day · only after Move 1/7 prove an *inputs* problem

Buy 30 days for the hottest city: does it move the **tail** toward badatmath's picks? **FROZEN: tail-bucket
calibration Δ ≥ 3pp.** Don't buy point skill — zero marginal value here. **Premature until the router says
inputs are the bottleneck.**

### MOVE 10 — The fallback that captures most of the value regardless: the analytics product  ·  the named alternative goal

"The **Nansen/Arkham of weather prediction markets**": we may hold the *only* full forensic reconstruction
(92,921 fills) of the #1 weather trader, a live tracker, and market-efficiency measurement. Needs **no**
market-beating forecast, **compounds as a proprietary dataset**, and **ports to Kalshi's regulated weather
markets** (second venue, same engine). The §11 copy-trade falsification ("the structurally un-followable #1
weather trader") is itself a publishable piece. If the router and running-max both null, this is the honest
goal — and a genuinely good one, not a concession.

**Ignore until the router returns:** ECMWF subscription justification (Move 9), negRisk/ladder arb, and any
talk of firing the live rail — all premature until Move 1 says inputs/microstructure is even the bottleneck.

---

## 4. Guardrails (neutralize BEFORE celebrating any positive)

- **The self-fooling trap (most important):** a positive bid test (M2) driven by *our own optimistic tail*
  is a mirage that loses real money. **M2 is only real if it survives AND M1/M3 show our tail is
  calibrated-or-pessimistic.** Never read M2 alone.
- **Selection in their revealed picks:** scoring badatmath's chosen buckets tells you about *their*
  selection, not whether *you* can act — which is why M1 (their picks) and M2 (our own `<0.15` buckets) are
  both required.
- **Multiple comparisons:** 45 stations × deciles × lead-times invites a spurious win. The station-count
  gate (≥20/45) + frozen thresholds + a zero-skill Monte-Carlo (shuffle `won`, P(PASS) < 5%) are the WO-5
  defense — hold them.
- **Regime fragility (the Contrarian's strongest point):** 94% of badatmath's edge is in **5 weeks** — it
  may be a **closing seasonal window** (late-spring synoptic variability), not durable skill. Before
  building *any* breadth infra, run the regime decomposition (did `<0.20` spreads widen / non-sharp
  "no"-selling surge since ~May 1?). If it's a transient microstructure window, it accrues to any maker
  *now* but can vanish — don't build for an anomaly. Make pre/post-2026-05-20 a **first-class frozen axis**
  of Move 1.
- **Motivated reasoning (the deepest risk):** this whole exercise could be an elaborate way to re-open a
  thesis the operator closed. **The defense is the pre-committed kill in Move 1 — a null routes forward to
  the product (Move 10) and does NOT license a new hope. Commit to that now, before seeing the number.**
- **Data check first:** confirm `market_snapshots` carries a true best-bid (or that the fill model can
  reconstruct an achievable bid from the ask time-series — it already models adverse selection, so it
  likely can). This gates the fidelity of M2.

## 5. The frozen branch table (what each Move-1 result triggers)

| Router result | Meaning | Next |
|---|---|---|
| **M1 ✓ + M2/M3 ✓** | harvestable microstructure on a forecast we already have | strongest case to re-open the gate; build Move 8 (panel) + Move 6 as paper |
| **M1 ✓ + M2 ✗** | genuine tail-forecast gap (Case A) | Move 7 (tail-calibration fix) → re-run Move 2; then Move 9 only if inputs proven |
| **M2 ✗ (their tail ≈ market)** | they're rent-collecting liquidity, not out-forecasting | analytics pivot (Move 10); bury the forecast-superiority thesis |
| **Both null** | no calibration or bid edge | route to Move 3 → Move 4 (intraday running-max); if that nulls too → Move 10 |
| **Edge concentrates post-2026-05-20 AND tracker shows window closing** | transient regime | discount all harvest paths; prioritize Move 10 + the research writeup |

---

## 6. The single next concrete action (hand to builder)

**Run the M1 calibration diagnosis** (M2 and Move 2 are already done = FAIL; M1 is the remaining free,
decisive arm). **Build one table:** for every badatmath fill with entry `< 0.25`, join its bucket to
(a) our EMOS_p for that city-day, (b) the contemporaneous market-implied p, (c) the resolved outcome — then
compute, on the subset where `EMOS_p < 0.15`, **empirical resolution-freq − EMOS_p** (M1), `Brier(EMOS) −
Brier(market)` on `<0.15` (M3), and their entry-price-vs-resolution-freq by decile (M4). **Freeze the M1
thresholds in a comment block before you run it** (M1 PASS = ≥ +3pp, pooled lower-95% CI > 0).

This is a clean extension of the `scripts/research/maker-spray-feasibility.ts` spine — it already loads the
EMOS distribution, ladders, and resolutions; the only new input is the **badatmath fills** join (the
`wallet-forensics` reconstruction — persist it first via `pnpm tsx scripts/wallet-forensics.ts
0x8fbd…a959 --persist` once Polymarket isn't rate-limiting). That one table decides the branch:
**Case A (fixable forecast) → Move 7 · Case C (information) → Moves 3→4 · rent-collection → Move 10.**
**Everything else waits on that result.**

---

## 7. Provenance & confidence caveats

- Source: `/council` (karpathy-style multi-Opus deliberation), 2026-06-22, two runs. Chairman = Opus 4.8
  both times. Advisor lenses received across runs: **First-Principles, Executor, Expansionist** (3 of 5).
- **Both runs degraded** (the `claude` CLI dropped ~2 advisors under parallel spawn on Windows): the
  **Contrarian and Outsider full texts were never received** — the chairman reconstructed those lenses by
  judgment. The strongest possible dissent (*"accept the close; this is motivated reasoning"*) is therefore
  **under-represented** — Guardrail §4 "motivated reasoning" is the explicit counterweight. The panel I read
  was tilted toward action; weight accordingly.
- All three received advisors are **Opus-family variants with shared priors** → their strong convergence
  (the gap is *tail/bid/breadth, not point skill*; *free decisive tests remain unrun*) is **weak
  corroboration, not strong cross-vendor consensus.** The case for running the Move-1 router is endorsed not
  because they agree, but because it is the only proposed action that costs ~$0/1 day yet branches the whole
  roadmap honestly under WO-5 discipline.
