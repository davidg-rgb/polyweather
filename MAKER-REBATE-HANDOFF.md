# MAKER-REBATE-HANDOFF — reopening the maker path via Polymarket's built-in rebate

> **Authored 2026-06-23.** The next-session execution package for the thread that REOPENED the
> (previously-closed) maker angle. Operator reframed the goal: **net profit vs the Polymarket weather
> markets by ANY mechanism — including stacked-odds / low-win-rate / microstructure — not just
> "our forecast beats the market."** Under that lens we found Polymarket's built-in **maker rebate** is
> live on weather, corrected a mis-specified fee model in the §12 sim, and proved a **+EV ceiling** on
> badatmath's revealed picks. The rail stays **DORMANT** — the ceiling is *his* edge, not yet *ours*.
>
> Read first: this doc. Then `WALLET-RECON-HANDOFF.md` §11/§12/§15, `FINDINGS.md`, and
> `packages/core/src/sim/maker-spray.ts` + `scripts/research/m6-selection-mirror.ts`.
>
> **UPDATE 2026-06-23 — REC-1 RAN. Verdict `INSUFFICIENT_DATA`, leaning NOT-LEARNABLE (§8 below).** The
> decisive maker-path test was built (`SELECTOR-LEARNABILITY.md`, `core/sim/selector-learn.ts`,
> `scripts/research/m7-selector-learnability.ts`, +27 tests). A learned 6-feature selector's in-sample
> ceiling (+10.6pp) **collapses out-of-sample to −5.7pp** (cluster-t −9.7pp) — overfitting, same wall as
> §12, larger model. But the binding blocker is that the cheap-eligible book lives on only **4 independent
> weather-days** (Jun 12–15) < MIN_CLUSTERS 8, so the result is data-limited, not a clean kill. **Rail stays
> DORMANT.** Re-run the harness when book density grows (REC-3/REC-4 → more days).
>
> **UPDATE 2026-06-24 — REC-3 + REC-4 BUILT, and REC-4 FIRED A MAJOR TRIGGER (§9 below).** The reward/fee
> config is now ingested (REC-3), and the liquidity-rewards monitor (REC-4) was run live — it found that
> **Polymarket has TURNED ON funded liquidity rewards on weather markets** (395/396 temperature markets in
> the funded pool, real USDC daily rates, e.g. Madrid 226/day). This **reverses §0's "Liquidity Rewards
> DEAD on weather"** and is the exact *genuinely-out-of-market information* that `FINDINGS.md` named as the
> condition to reopen. **Liquidity-rewards farming is FORECAST-FREE and SELECTION-FREE** (paid for resting
> near mid regardless of fill/outcome) — orthogonal to every falsified outcome-prediction signal. **This
> warrants a NEW work order (reward-farming economics) — operator decision.** The trading rail per se stays
> dormant pending that analysis.

- **Branch:** `feat/maker-rebate-economics` (off `main`). **Commits:** `d746316` (rebate economics),
  `19b02a5` (m6 selection-mirror), + this doc. **State:** typecheck 0, full suite **1167 green**.
  Read-only research; nothing ships to prod; `packages/trading` never imported.
- **Posture:** live rail **DORMANT**. It re-opens ONLY if a **capturable** selector proves out-of-sample
  (REC-1 PASS) AND execution is viable (REC-2). `FINDINGS.md`'s closed-thesis framing still holds operationally.

---

## 0. TL;DR

1. **Liquidity Rewards (rest-near-mid, paid regardless of fill): DEAD on weather.** `rewards.rates=null`
   on our captured universe; Polymarket's live rewarded-markets list (`/sampling-markets`) has **zero**
   weather markets (funded pools are politics/crypto/sports, 10–20 USDC/day). Nothing to optimise toward.
2. **Maker Rebate (fee-share on fills): LIVE on weather.** `feeType=weather_fees` → **5% taker fee,
   `takerOnly:true`, 25% maker rebate**. badatmath earns this on every filled bid; our §12 sim never modelled it.
3. **§12's maker-spray FAIL used a wrong fee model** — it charged the maker the taker fee (which
   `takerOnly:true` says makers don't pay) and zeroed the rebate. **Corrected** (additive `rebateRate`
   model, `d746316`): the rebate is real & material (**+~6pp** swing) but does NOT open our-forecast
   selection — won−restPx stays **−1.7pp (sig. negative)**. §12 holds; the wall is now cleanly **SELECTION**.
4. **m6 selection-mirror (`19b02a5`): the CEILING HOLDS.** Resting on badatmath's revealed engine-band
   picks [0.10,0.25) with the rebate: selection edge **+3.92pp [2.11,5.73]**, realistic maker EV/$1
   **+26.1% [14.4,37.9]**, zero-skill 1.9%. **First +EV configuration in the whole investigation.**
5. **BUT it's HIS edge, not ours.** Two walls: (a) **selection** — our forecast picks the wrong cheap
   buckets (§12, −1.7pp); (b) **latency** — we only see his picks AFTER he fills (§11). The +26% is
   unreachable until we can pick the buckets *independently, out-of-sample*.
6. **Decisive next test (REC-1): is his selection LEARNABLE?** Train a selector on pre-resolution
   features, test walk-forward. PASS → a real capturable edge candidate. FAIL → the edge is his alone, close it.

---

## 1. The reframe (why the maker angle reopened)

The earlier verdict (`FINDINGS.md`) closed the **forecast** thesis: the market is efficient w.r.t. every
signal we can forecast. The operator's clarified goal is broader — **any net-positive mechanism**, explicitly
including "profit hiding in stacked odds + low win rate" (badatmath's shape). That is NOT contradicted by
`FINDINGS.md`: the forecast axis stays closed; this thread probes the **microstructure / rebate** axis, which
the investigation had only touched (§12 maker-spray, under a wrong fee model).

---

## 2. The reward & fee system (the data reference)

Two **separate** Polymarket programs (docs: [liquidity-rewards](https://docs.polymarket.com/market-makers/liquidity-rewards),
[maker-rebates](https://help.polymarket.com/en/articles/13364471-maker-rebates-program)):

| Program | What it pays | On weather? |
|---|---|---|
| **Liquidity Rewards** | resting orders **near mid**, paid daily regardless of fill (scored on closeness-to-mid, time-live, size/depth, two-sidedness; `<0.10`/`>0.90` mids need double-sided) | **NO** — `rewards.rates=null`, not in the funded pool (live-confirmed via `/sampling-markets`) |
| **Maker Rebates** | 25% of the taker fee, on fills | **YES** — `weather_fees` |

**Per-market config (live, on our universe — `research/clob-market-nyc-94-95f.json`, `gamma-event-temperature-nyc-jun11.json`):**
```
rewards = { rates: null, min_size: 50, max_spread: 4.5 }   ← reward SCAFFOLDING, unfunded
holdingRewardsEnabled = false
feeType = weather_fees
feeSchedule = { rate: 0.05, takerOnly: true, rebateRate: 0.25, exponent: 1 }   ← the LIVE rebate
```
- `takerFeePerShare(p, rate) = rate·p·(1−p)` (`packages/core/src/fees.ts`). At p≈0.15 the taker fee ≈ 4–5% of
  stake; the maker rebate ≈ 25% of that ≈ **~1pp of stake per filled position**.
- **We do NOT ingest any of this today** — `poll-markets`/`market_snapshots` carry no `rewards`/`feeSchedule`
  fields (the only "reward" in our backend is wallet-forensics). REC-3 fixes that.

**Rate limits ("how often can we read odds"):** `/books` 50/10s (300/10s website tier), `/price` 100/10s,
`/markets` 50/10s (Cloudflare-throttled, queues over-limit). We poll every **5 min** (`0009_cron.sql:163`),
≤15 books/cycle (`MAX_BOOKS_PER_CYCLE`, self-imposed). **Read speed was never the binding constraint** — we use
a rounding error of the budget and could go near-real-time per market trivially.

---

## 3. What we measured this session (the arc)

### 3a. maker-spray, corrected fee model (`d746316` — full §12 scope, walk-forward)
| `--select forecast` | fee-net EV/$1 | won−restPx (robust, rebate-independent) |
|---|--:|--:|
| conservative (rebate 0) | −4.37% [−78,+102] | −1.69% [−3.13,−0.26] |
| **realistic (rebateRate 0.25)** | **+1.57%** [−73,+108] | −1.69% (same) |

`--select all`: −38.42% → −32.46%; won−restPx −1.52% [−2.56,−0.48]. Adverse selection confirmed every arm.
**Reading:** the rebate is real (+~6pp on point EV) but the heavy-tailed EV CI is uninformative, and the robust
won−restPx is significantly negative. **Our-forecast (and indiscriminate) selection does not clear zero even with
the rebate.** §12 holds; the failure is SELECTION, not fees.

### 3b. m6 selection-mirror — his revealed picks + rebate (`19b02a5`)
Engine band [0.10,0.25), n=1876, win 20.36%:
- **selection edge won−price +3.92pp, CI [2.11, 5.73]** (clears 0; calibration-null P=1.9% < 5%)
- **realistic maker EV/$1 +26.1%, CI [14.4, 37.9]** (conservative/no-rebate +20.9%; rebate +5.2pp)
- by lead: 48–72h +5.5pp / +33.7% (best), 24–48h +4.0pp / +26%, <24h +2.0pp / +17% (CI straddles 0)
- the <0.10 dead zones (he avoids) are EV-negative — confirms the §15 engine floor of 0.10

**The CEILING (assumes we capture his exact fills; queue competition ignored) is +EV and significant.** But it
is essentially badatmath's OWN edge re-expressed with the rebate. The difference vs §12 is entirely **which** cheap
buckets: his picks +3.9pp, our-forecast picks −1.7pp, indiscriminate −1.5pp (all rest cheap, below market).

### 3c. Buying-pattern (side question): chunk vs spread → **SPREAD over hours, micro-burst execution**
From his 64,934 BUY fills (12,402 positions, 8,410 multi-fill):
- **Position accumulation is SPREAD across hours:** per-position fill span **median ~9.2h (549 min), p90 42h,
  max 63.6h**; consecutive inter-fill gap median **435s (~7 min)**, only 32% within 60s, 26% **over 1h** apart.
  Only **8.8%** of multi-fill positions are a single <60s burst.
- **Execution is micro-bursty:** 82.3% of fills land in a wall-clock minute holding ≥2 of his fills (max **64/min**,
  mean 2.59) — i.e. each top-up is split into small same-minute clips.
- **Interpretation:** he is NOT a one-shot chunk buyer. He builds each position over **many hours / up to ~2.6 days**,
  topping up repeatedly (consistent with **resting/replenishing maker bids reacting to the evolving book** — i.e.
  real-time-odds-aware), executed in same-minute clip bursts. Reinforces §11/§15: a patient maker-resting grind, which
  is *why it's hard to copy* (you'd have to rest alongside him for hours, splitting his fills). Caveat: timestamps alone
  can't fully separate "passive resting that fills over time" from "active re-quoting on odds" — both look spread-out.

---

## 4. ALL recommendations (prioritised)

### REC-1 — **DECISIVE NEXT TEST: is badatmath's selection LEARNABLE?** (the live lever)
Build a walk-forward test: train a **selector** that picks which cheap (0.10–0.25) buckets to rest on, from features
available **before resolution** — market microstructure (book imbalance, spread, recent price drift, time-to-resolution),
our EMOS calibrated prob, climatology, multi-lead forecast revision — and score the resulting maker EV (with the
`weather_fees` rebate) **out-of-sample**. The question: can WE independently reproduce ~+3.9pp selection edge that m6
showed is achievable on his picks?
- **Reuse:** the m6 EV layer (`mirrorStats` / `makerNetEvPerDollar`), the maker-spray fill model + `market_snapshots`
  loaders, the db1/EMOS spine.
- **Pre-register (WO-5 discipline, BEFORE running):** kill-criterion = OOS selection-edge CI lower bound > 0 **after**
  the rebate, AND zero-skill (calibration-null) P(PASS) < 5%, AND verdict stable across the walk-forward folds.
- **Pitfalls to lock down:** do NOT train and test on the same picks; do NOT leak post-entry book info into features;
  guard against feature-dredging (pre-register the feature set, FDR-correct if sweeping); his picks may encode tacit
  skill not in our features (then it won't learn — that's a valid NO).
- **Honest prior: guarded.** Our forecast already failed at selection (§12). But a selector trained on microstructure +
  his revealed behaviour is a *different, untested* approach. This is the one unrun lever that could turn the +EV ceiling
  into a capturable edge.

### REC-2 — Execution realism (GATED on REC-1 PASS)
Even a winning selector is untradeable if we can't capture the fills. Model: (a) **queue competition** — we'd rest in the
same thin books as badatmath + other makers and fill on the residual (adversely selected); (b) **lagged visibility** — his
picks are only visible post-fill (§11), so any "copy" is structurally late. Estimate our realistic **fill share** and re-run
the EV at that share. Without this, a passing selector is a ceiling, not a P&L.

### REC-3 — Ingest the reward/fee config (infra, do alongside REC-1)
Capture `feeSchedule` (`rate`, `takerOnly`, `rebateRate`) + `rewards` (`min_size`, `max_spread`, `rates`) per market into
`poll-markets`/`market_snapshots`, so selection/EV uses **live per-market** values instead of the hardcoded 0.05 / assumed
0.25. Small, additive; makes every downstream EV honest and future-proofs REC-4.

### REC-4 — Liquidity-rewards monitor (cheap, high option value)
Weather isn't in the funded reward pool **today**, but if Polymarket turns it on, "rest-near-mid, paid regardless of fill"
becomes a real **forecast-free** income path (no selection needed). A periodic `/sampling-markets` check for any weather/
temperature market (and a non-null `rewards.rates` on our universe) flags the moment it opens. Low effort; would change the
whole calculus if it fires.

### REC-5 — Doc hygiene (when the picture is complete, NOT before)
Update `FINDINGS.md` / `WALLET-RECON-HANDOFF.md` §12 with: (a) the fee-model correction (the conservative model overstated
the maker loss); (b) the m6 ceiling (+26% on his picks); (c) the precise framing "wall = selection; ceiling = +EV but his."
Do **not** rewrite the closed-thesis framing prematurely — the rail stays dormant until REC-1+REC-2 prove a capturable edge.

### REC-6 — The honest kill (a real, likely outcome)
If REC-1 fails out-of-sample, the edge is confirmed **his alone** (selection skill we can't reproduce + latency we can't
beat). Record it as the next falsified angle, `FINDINGS.md` gets the entry, rail stays dormant. Do **not** sink unbounded
effort chasing a selector that won't generalise — the prior says this is a likely end state.

### REC-7 — (Optional, off-universe) farm the FUNDED reward markets
Liquidity-rewards farming is real money on the **rewarded** universe (politics/crypto/sports, $5M+/mo) — a forecast-free
maker business. But it's **off weather**, a different project, and crowded (public guides exist). Out of scope unless the
operator wants to pivot universe; flagged for completeness.

---

## 5. Reproduce (commands)

```bash
# m6 selection-mirror (the +EV ceiling) — reads the §15 forensic CSV, no DB:
pnpm tsx scripts/research/m6-selection-mirror.ts
#   knobs: --lo 0.10 --cheap-max 0.25 --rebate-rate 0.25 --fee-rate 0.05 --mc-iters 1000 --json

# maker-spray, corrected economics (needs DB):
pnpm tsx scripts/research/maker-spray-feasibility.ts --select forecast --rebate-rate 0.25
pnpm tsx scripts/research/maker-spray-feasibility.ts --select forecast --rebate-rate 0     # conservative baseline

# the §15 forensic purchase map (regenerates the CSV m6 reads; cache-first, ~no network):
pnpm tsx scripts/research/badatmath-purchase-map.ts

# reward/fee config on a live weather market (GO/NO-GO): inspect rewards.rates / feeSchedule via
#   Gamma (gamma-api.polymarket.com) or the rewarded-markets list (clob.polymarket.com/sampling-markets).

pnpm typecheck && pnpm test    # 0 errors, 1167 green at handoff
```

---

## 8. REC-1 RESULT — is badatmath's selection learnable OOS? (run 2026-06-23)

Full pre-registration + numbers: **`SELECTOR-LEARNABILITY.md`** (§8 frozen criterion, §10 result). Engine
`packages/core/src/sim/selector-learn.ts` (+`test/selector-learn.test.ts`, 27 tests), spine
`scripts/research/m7-selector-learnability.ts`. Reproduce: `pnpm tsx scripts/research/m7-selector-learnability.ts`.

**Design (the honest small-sample walk-forward).** Train an L2 logistic selector on a frozen 6-feature
pre-entry set (`calibratedP, restPx, edgeP, spread, restVsMid, drift` — all ≤ entry, no leakage), pick cheap
[0.10,0.25) buckets where `pWin > restPx`, score the selection edge (won−restPx) **leave-one-weather-day-out**
with a **cluster-mean t-interval** (the §0a calibration: a percentile cluster bootstrap was anti-conservative
at few clusters; the t-interval controls H0 FPR ≈0% while keeping power). Universe assembled by REUSING the §12
maker-spray loaders + `makerEntry`.

**Verdict: `INSUFFICIENT_DATA`, leaning NOT-LEARNABLE.**
- In-sample ceiling (optimistic): selection edge **+10.6pp** (cluster-t +13.6pp). OOS (honest): **−5.7pp**
  (cluster-t **−9.66pp [−27.56, +8.24]**). The selector overfits in-sample and **does not generalise OOS**.
- Universe = **202 cheap-band picks over 4 weather-days** (Jun 12/13/14/15). 4 < MIN_CLUSTERS 8 → the
  data-sufficiency gate fires: you cannot validate a learned selector on 4 independent weather-days (outcomes
  within a day are cross-sectionally correlated — the effective independent n is ~4). Zero-skill null quiet (2.0%).
- **This is a book-DENSITY blocker, not a modelling gap.** The fix is more days (REC-3 ingest + REC-4 monitor),
  then re-run this exact harness. If OOS stays negative as days accumulate → REC-6 (the honest kill). The live
  rail stays **DORMANT** (no `tradingMode` flip, `packages/trading` never imported).

**What's now unblocked / next:** REC-3 (ingest `feeSchedule`/`rewards` per market) and REC-4 (liquidity-rewards
monitor) are the highest-value next steps — they grow the book-density base REC-1 needs AND are cheap/additive.
REC-2 (execution realism) stays GATED on a REC-1 PASS (not reached). REC-5 doc hygiene + REC-7 (off-universe
reward farming) unchanged.

## 9. REC-3 + REC-4 BUILT (2026-06-24) — and REC-4 reversed the §2 reward finding

**REC-3 — per-market fee + reward config ingest (DONE, deploy-gated).** The Gamma event already carries
the full `feeSchedule {rate, takerOnly, rebateRate}`, `feeType`, `rewardsMaxSpread/MinSize`,
`holdingRewardsEnabled` per market (fixture-verified). Extended `core/polymarket/gamma.ts` to parse them,
migration `0054` adds the `market_buckets` columns + extends `upsert_bucket` (drops the 12-arg overload,
recreates with 6 defaulted params — the "function is not unique" trap), and `discover-markets` now passes
them. +tests (`polymarket.test.ts`, migrations list). Existing rows stay null until a discover re-run; the
downstream sims keep their conservative 0.05/0.25 fallback until then (frozen results unchanged). Deploy +
the one-line `loadEvents` read-path: RUNBOOK "REC-3 fee/reward config ingest".

**REC-4 — liquidity-rewards monitor (DONE) → MAJOR TRIGGER.** Pure detector `core/polymarket/rewards.ts`
(`scanWeatherRewards`) + live script `scripts/reward-monitor.ts` paginate the CLOB `/sampling-markets`
funded pool. **Run 2026-06-24: 395/396 temperature markets are FUNDED** — real USDC daily rates (Madrid
226/day, Ankara 124/day, Helsinki 66/day, …), min_size 50, max_spread 4.5¢, all active/accepting.
Independently re-verified against the raw API. **This REVERSES §0/§2 "Liquidity Rewards DEAD on weather."**

**What it means (and doesn't).** Liquidity rewards pay for **resting orders near mid, regardless of fill or
outcome** — a **forecast-free, selection-free** income path, orthogonal to every falsified signal (those
were all outcome-prediction / bucket-selection). It does NOT contradict the efficiency verdict; it's a
market-making mechanism that simply did not exist on this universe until now. The §2 reasoning ("nothing to
optimise toward") is obsolete as of today.

**The honest caveat (why this is a work order, not a green light).** The advertised `rewards_daily_rate` is
a per-market POOL split among qualifying makers by Polymarket's scoring formula (closeness-to-mid × size ×
time-live × two-sidedness; `<0.10`/`>0.90` mids need double-sided). Realized earnings = YOUR share of that
pool, net of inventory + adverse-selection risk on any fills. So the next step is an **economics analysis**:
model the reward-share vs. capital-at-risk + fill/inventory cost across the weather universe, decide whether
net-of-risk yield clears a bar worth pursuing. That is a genuinely new direction (a market-making pivot, not
a forecast/taker edge) and an **operator decision** — `FINDINGS.md` named exactly this as the reopening clause.

### Recommended next work order (REC-8, NEW) — reward-farming economics
Quantify forecast-free liquidity-reward yield on the weather universe: (a) ingest `/sampling-markets` reward
rates per condition (extend REC-3 / a new `market_rewards` snapshot); (b) model per-market maker reward
share = f(our resting size, pool size, max_spread, time-live) under the published scoring formula; (c) net
out inventory + adverse-selection cost on fills (reuse the §12 fill model); (d) pre-register a yield bar +
kill-criterion (WO-5). This is the first genuinely-forecast-INDEPENDENT money path the investigation has
surfaced; it deserves its own spec before any capital. The live trading rail stays DORMANT until it clears.

## 6. Guardrails (unchanged)

- **Live rail DORMANT** until a capturable selector proves out-of-sample (REC-1 PASS + REC-2 viable). No `tradingMode`
  flip, no `execute-bet`, no `packages/trading` import in research.
- **WO-5 discipline:** pre-register every kill-criterion BEFORE seeing the number; report zero-skill / calibration-null
  false-positive rates; prefer the robust low-variance metric (won−restPx) over the heavy-tailed EV for the gate.
- **Read-only**, analytics posture. This is the analytics product per the 2026-06-15 pivot, now probing the one
  microstructure crack the forecast-axis closure didn't cover.

---

## 7. Git state at hand-off

```
branch feat/maker-rebate-economics  (off main)
  19b02a5  feat(research): m6 selection-mirror …
  d746316  feat(maker-spray): model the real weather_fees maker rebate …
  (+ this MAKER-REBATE-HANDOFF.md)
typecheck 0 · suite 1167 green · working tree clean after the handoff commit
```
**Open decision for the next run:** PR `feat/maker-rebate-economics` → `main` (all read-only research + the
corrected fee model; no prod/rail change) so the loop reads it from `main` — or keep iterating on the branch.
Then START REC-1.
