# Opening-convergence probe — re-run 2026-06-27 06:33 UTC (additive evidence)

> Captured while the `architect` skill builds `ARCHITECTURE-OPENING-CONVERGENCE.md` in parallel.
> Additive only — does NOT modify the handoff, FINDINGS, BUILD-STATE, or the architecture file.
> Re-run: `pnpm tsx scripts/research/opening-convergence-probe.ts --live 10 --hist 6`. Read-only, keyless.

Widened to 10 live candidates (vs 4 last session). Five build-relevant findings:

## 1. Flat open STILL uncaught — and that's the architectural verdict, not bad luck
The flattest live market in the snapshot was **chengdu peak 26%** (lead 1.7d). Every next-day
(2026-06-28) market is already **peak 26–34%** at lead 1.7d. **None ≤18%** → the §9R entry rule
(peak mid ≤18% AND ask ≤20% AND ≤6h of listing) **would not have fired on a single market here.**
Confirms the handoff §3: the genuine 10–12% flat open (David's Paris 6:10 AM observation) is a
**first-hours-after-listing** window that ad-hoc probing structurally cannot catch — by the time we
sample, the freshest daily markets have already converged to ~26%+.
→ **Architect input:** the capture cron must (a) run frequently enough to catch listing (≤15–30 min),
and (b) track per-market **first-seen timestamp** so it snapshots the true open, not a mid-life state.
The capture layer is the ONLY way to measure flat-open depth + net edge. The build IS the experiment.

## 2. Depth at lead 1.7d is comfortably above the planned caps (capacity NOT the killer)
Center-bucket buyable $ within +10% of best ask, flattest leaders:
- chengdu 29/28/30°C = **$293 / $323 / $190**
- taipei 31/30°C = **$649 / $422**
- mexico-city 23/24/22°C = **$647 / $540 / $316**
- jeddah 39/37/38°C = **$351 / $283 / $203** · helsinki = **$347 / $333 / $286** · guangzhou 32°C = **$408**

All ≫ the §9R caps ($10–25/position, $40/market). So **if the genuine flat open proves too thin, a
"near-open" fallback entry at lead 1–2 has ample capacity** — but see #4: at lead 1.7d the centers are
already 24–34%, above the hard-max-20% buy rule, so that fallback needs an explicit rule change to use.

## 3. Touch is thin, band is deep → direct input to the maker/taker fork (§9R-B)
Repeated pattern: tiny size at the touch, large size resting slightly higher.
e.g. taipei 31°C **$1.6 touch / $649 band**; mexico-city 23°C **$19 touch / $647 band**.
→ **Maker resting entry is viable** (you join the deep band cheaply) but fills are not instant; **taker
entry pays the walk up to +10%.** The bracket engine's fill model must walk the band, never trust the
touch quote (inherit `cross-venue-verify.ts`).

## 4. Survivorship sharpened: hard-max-20% misses ~half the winners
Winners that opened ≤20%: **3 / 6**. Half the eventual winners opened ABOVE 20% (panama 30°C @20%,
dallas 94-95°F @26%, ankara 29°C @25%, miami 90-91°F @36%). So the §9R "never buy above 20%" rule means
the strategy is **not** "buy winners cheap" — it's "buy cheap center buckets that **re-rate up**, and
**exit on the TP bracket mid-life** regardless of final outcome." The median 75pp convergence is
monetized by the bracket, not by holding to resolution. The architect should frame position expectancy
as **TP-driven mid-life exits**, with the winner-held-to-100% case as upside, not the base case.

## 5. Convergence + data accuracy RECONFIRMED (n=6 resolved, all 2026-06-26)
6/6 winners ran open→**100%**; median buy-open→pre-resolution sell-back **75pp** (min 60, max 92) —
consistent with last session's 79pp. Losers near the mode **also spiked sellably**: panama 31°C 28→54,
amsterdam 37°C 14→49, ankara 30°C 35→47, dallas 92-93°F 14→37, cape-town 20°C 17→39, miami 92-93°F
43→61. All loser series are **real** (33–58 pts >1%) — the "0 throughout" front-end artifact does not
recur. Data is measurable.

## Net for the build
Thesis intact and re-confirmed on convergence + depth-above-caps + data accuracy. The one number that
decides net profit — **flat-open depth + net-of-cost edge at the listing window** — remains unmeasured
and is **unmeasurable except by the forward capture layer.** Two design tensions to foreground:
(a) the entry rule (peak≤18%/ask≤20%) only fires in a window we haven't yet sampled — the capture layer
must prove that window even exists at fillable depth; (b) hard-max-20% + winner-opens->20%-half-the-time
means expectancy rides on mid-life re-rating exits, so the **bracket/time-stop logic is the load-bearing
component**, not bucket-picking accuracy.
