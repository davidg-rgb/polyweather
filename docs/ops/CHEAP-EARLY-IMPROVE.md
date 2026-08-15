# CHEAP-EARLY-IMPROVE — sweeping the entry cell's improvement levers on the real book (2026-08-15)

> **VERDICT: no lever improves the cell. Five knobs × ~4,000 cells on 689–978 real-book entries over
> 45 cities / 41 days, and the answer is the same one the project has now got thirteen times — the
> market is efficient at this price point.** The two pre-registered cells are both point-negative with
> CIs straddling zero (live rule **−6.9%**, city-CI [−20.0, +6.9], n=689; tested rule **−3.7%**,
> [−18.1, +11.0]). Of the five levers, **four are flat-to-harmful and one is actively destructive**:
> raising the required model-vs-market margin monotonically *worsens* returns (m=0 → −6.9%, m=0.20 →
> −28.2%), and swapping the raw consensus for our **bias-corrected accuracy forecast is the single
> worst change measured anywhere in the sweep** — −30.6%, city-CI **[−64.5, −18.9]**, the whole
> interval negative. The only lever that moves the point estimate the right way is *widening* the
> band ([0.10,0.50] → −4.8%, [0.15,0.40] → −3.9%), and it is still negative. Selecting the top-10
> cells on TRAIN by ciLow and reading them on TEST gives **mean −3.7%**, 5/10 positive, and the #1
> TRAIN cell (+35.5%) collapses to **−44.4%, CI [−91.8, −17.5]** out of sample — traps.md #6, textbook.
> Read-only; nothing traded.

Engines: `scripts/research/cheap-early-export.ts` (read-only DB export) + `scripts/research/cheap-early-improve.py`
(the sweep). Artifact: `scripts/research/out/cheap-early-improve.json`. Prior: `CHEAP-EARLY-ENTRY.md`.

---

## 1 · What was asked, and the panel it was answered on

The live buy-table lane was re-pointed at this cell on 2026-08-09 (`CHEAP-EARLY-ENTRY.md` §7 — the
operator override) and ran 2026-08-09 → 08-15 at **3W / 17L, ≈ −$48**. The question is which knobs, if
any, improve it. Five levers, one entry per event per cell, taker at the observed `bestAsk`, fee =
`takerFeePerShare(ask, 5%)`, hold to resolution, $5 stake must clear `depthUsd ≥ 5` or it is a no-fill:

| lever | levels |
|---|---|
| **A entry timing** | `first_in_window` / `latest_in_window` over [24,36]h · point entries at 12/18/24/27/30/33/36/42/48h |
| **B pick source** | `raw` (argmax `houseProb` — the RAW cross-model consensus, what the live lane buys) · `accuracy` (argmax of the bias-corrected `house_ensemble`, lead-appropriate) · `agree` (both pick the same bucket) |
| **C edge margin** | require `pickProb − ask ≥ m`, m ∈ {0, .05, .10, .15, .20} |
| **D ask band** | [0.20,0.25) [0.25,0.30) [0.30,0.33] **[0.20,0.33] (live)** [0.15,0.40] [0.10,0.50] |
| **E city skill** | `all` / `top20` / `top10` / `hit≥0.35` — as-of rolling 28-day house-pick hit rate per city |

**Panel.** 253,925 real captures inside [12,51]h to close, **1,729 graded events, 45 cities, 41 target
dates (2026-07-05 → 2026-08-15)**, from `opening-captures-archive` — observed Polymarket `bestAsk` /
`bestBid` / `depthUsd`, nothing synthesised. Grading truth = the DB winner's label temperature
(2,024 graded city-days, `grading_mismatch` excluded). Accuracy-pick coverage: **90.4%** of captures
carry a lead-appropriate bias-corrected distribution.

**The probs → temperature alignment rule (established, not assumed).** `buildDistributionForEvent`
(`supabase/functions/_shared/distributions.ts`) builds `probs` over `ladder = inp.buckets.map(…)`, and
`inp.buckets` comes from `get_build_inputs`, which aggregates `market_buckets` **`order by bucket_idx`**
(`0033_get_build_inputs_ra3_guard.sql:39`). `bucket_idx` is contiguous 0..n−1 on **every** event (asserted
in the exporter — 0 violations), therefore **`probs[i]` ↔ `market_buckets.bucket_idx = i`**. The sweep uses
that index only to fetch a *label*, then parses the temperature and joins on temperature — so the archive's
raw-Gamma bucket order can never contaminate the join (traps #7). The `mu/sigma` fallback was **not** needed.
`seeded=false` is enforced: the `seeded=true` rows are the opening-convergence seed built with
`biasCorrect=false`, i.e. the raw consensus already carried as `houseProb` — including them would have made
the `accuracy` arm a copy of `raw`.

---

## 2 · Reconciliation against the 22 REAL live fills — and a hard data limit it exposed

Replaying `first_in_window` / raw / m=0 / [0.20,0.33] over the same city-dates as the live fills:

| denominator | n | bucket match | ask match (±2c) |
|---|---|---|---|
| **all 22 fills (the Directive's bar)** | 22 | **72.7%** | 63.6% |
| coverage-adjusted (fills where the archive has ≥1 capture in [24,36]h) | 17 | **94.1%** | — |
| tick-aligned (replica's capture within ±1h of the live tick, htc ≈ 36) | 8 | **100%** | **100%** |
| among fills the replica fired on at all | 16 | **100%** (16/16) | — |

**72.7% is below the 80% bar, and the cause is fully diagnosed: it is archive coverage, not selection.**
Every single fill the replica could see, it reproduced — same bucket, 16/16. Five of the 22 fills sit on
events with **zero captures anywhere inside [24,36]h** (qingdao 08-11, helsinki 08-11, jeddah 08-14,
cape-town 08-14, manila 08-14) — the replica is blind to them by data, not by model. One more (cape-town
08-13) had captures but they quoted 0.17–0.18 against the live 0.22 fill, i.e. the archive missed the
moment the lane bought. Where the archive *does* observe the tick moment, the replica reproduces the
bucket **and the price** exactly, 8/8.

**The limit this exposes — the 36-hour wall.** The capture stream is not continuous over the market's
life. It is a **listing-moment burst at ~48–56h**, then **nothing at all between 36h and 48h**, then a
continuous stream from **exactly htc = 36h** down to resolution (markets resolve 12:00Z, so the stream
starts 00:00Z the previous day). Consequences that bound everything below:

- `at_36h` and `at_42h` are **structurally empty cells — no data, not "no edge."**
- `at_48h` is n=23 on **2 distinct days** (the listing burst) — reported, not interpretable.
- Only **34%** of events have a capture in [35,36]h; 71% in [33,36]h; 89% anywhere in [24,36]h.

The live lane fires at 00:0xZ ⇒ htc ≈ 36 ⇒ **right on the wall**. So `first_in_window` in this backtest is,
on the majority of events, entering **later and at a different quote than the live lane actually does**.
That is the one place this replica is *not* like-for-like, and it is stated here rather than buried.

---

## 3 · The two pre-registered cells (full sample, unsearched)

| cell | n | cities/days | fire | win% (Wilson) | mean ask | **net/\$1** | city-CI | day-CI |
|---|---|---|---|---|---|---|---|---|
| **live rule** `first_in_window`/raw/m=0/[0.20,0.33]/all | 689 | 45 / 40 | 45% | 26.3% [23.1, 29.7] | 26.9c | **−6.9%** | [−20.0, +6.9] | [−19.1, +9.3] |
| **tested rule** `latest_in_window`/raw/m=0/[0.20,0.33]/all | 689 | 45 / 40 | 45% | 27.1% [24.0, 30.6] | 26.7c | **−3.7%** | [−18.1, +11.0] | [−16.1, +11.6] |

Both point-negative, both CIs straddle zero, and the two rules are statistically indistinguishable from
each other. The **realized live lane** ran 3W/17L (15.0%, Wilson [5.2%, 36.0%]) — worse than the backtest's
26.3% but well inside the Wilson interval on n=20, so the live record is **consistent with** this panel,
not evidence of an additional live-only defect.

### The §9R-E gate cannot label this strategy class — read the CI, not the label

Every cell below reads `KILL` or `INSUFFICIENT_DATA`, and that is **not informative about EV**. The frozen
gate requires `winFrac ≥ 0.5` — the fraction of *bets* with positive P&L. A 27c hold-to-resolution bucket
wins ~27% of the time **even when perfectly fairly priced**, so the bar is structurally unreachable:
**0 of the 1,055 sufficiency-clearing cells clear winFrac**, regardless of profitability. The gate was
frozen for a convergence strategy where most trades close small-positive. For this cell the binding
statistic is the **city-clustered CI on mean net return**, and it is reported for every cell.

---

## 4 · Out-of-sample: pick on TRAIN by ciLow, read TEST unchanged

TRAIN = target_date ≤ 2026-07-26 · TEST ≥ 2026-07-27. Selection is on **TRAIN ciLow**, never the point
estimate (winner's-curse-aware), among cells with ≥20 TRAIN entries / ≥4 TRAIN cities / ≥10 TEST entries.

| # | cell | TRAIN n | TRAIN win / net / city-CI | TEST n | **TEST win / net / city-CI** |
|---|---|---|---|---|---|
| 1 | at_24h/raw/m=.05/[0.30,0.33]/all | 39 | 43.6% / **+35.5%** / [−9.4, +103.7] | 33 | 18.2% / **−44.4%** / **[−91.8, −17.5]** |
| 2 | at_12h/raw/m=0/[0.15,0.40]/all | 450 | 30.9% / +0.2% / [−15.5, +15.4] | 410 | 29.5% / −1.3% / [−13.0, +32.1] |
| 3 | at_12h/raw/m=0/[0.25,0.30)/top20 | 46 | 37.0% / +32.5% / [−18.5, +119.6] | 63 | 31.7% / **+12.1%** / [−44.1, +53.4] |
| 4 | at_12h/raw/m=0/[0.10,0.50]/all | 521 | 31.9% / −3.7% / [−18.6, +8.8] | 474 | 31.0% / −3.9% / [−16.5, +25.8] |
| 5 | at_12h/raw/m=.05/[0.15,0.40]/all | 358 | 29.6% / −0.1% / [−18.6, +16.3] | 312 | 28.8% / +2.3% / [−17.7, +35.8] |
| 6 | latest_in_window/raw/m=0/[0.15,0.40]/all | 488 | 29.3% / −4.0% / [−18.9, +8.8] | 407 | 30.2% / +3.7% / [−15.8, +24.6] |
| 7 | at_12h/raw/m=.05/[0.10,0.50]/hit≥0.35 | 208 | 31.2% / +0.2% / [−19.1, +32.7] | 303 | 29.7% / −1.7% / [−30.7, +25.8] |
| 8 | at_24h/raw/m=0/[0.15,0.40]/all | 314 | 29.9% / +1.4% / [−19.1, +21.8] | 264 | 25.4% / −7.4% / [−33.6, +31.8] |
| 9 | at_12h/raw/m=.05/[0.15,0.40]/hit≥0.35 | 188 | 30.9% / +1.4% / [−19.4, +36.6] | 266 | 28.9% / +1.9% / [−29.2, +28.7] |
| 10 | latest_in_window/raw/m=.05/[0.30,0.33]/all | 84 | 35.7% / +10.9% / [−20.4, +61.9] | 85 | 32.9% / +1.4% / [−54.5, +30.6] |

**Mean TEST net across the ten: −3.7%. 5/10 positive. Range [−44.4%, +12.1%].** One cell's TEST CI
excludes zero — on the *harmful* side (#1). Every other TEST interval straddles zero by tens of points.
The two TRAIN cells with big positive point estimates (#1 +35.5%, #3 +32.5%) are the two smallest panels
(n=39, n=46) and #1 inverts completely out of sample. That is the whole out-of-sample story.

**Zero-skill Monte Carlo:** not run, and the reason is itself the result — **0 of the top-30 TRAIN cells'
splits ever reached PASS candidacy**. `opening_verdict` short-circuits to `INSUFFICIENT_DATA` (thin) or
`KILL` (winFrac / ciLow) before the sign-flip MC, and no cell in the entire 3,960 got past that. The MC
would only have run on a cell that already cleared winFrac ≥ 0.5 + ciLow > 0, and none exists.

**Multiple comparisons, stated plainly — and the asymmetry that makes the verdict more than "no signal."**
11 × 3 × 5 × 6 × 4 = **3,960 cells** were searched (2,962 non-empty; 1,055 clear §9R-E sufficiency on the
full sample). Under a true zero edge you would expect roughly 26 of those 1,055 to show a city-clustered CI
excluding zero on each side by chance. Observed:

| full-sample city-CI, among the 1,055 sufficient cells | expected under H₀ | **observed** |
|---|---|---|
| entirely **positive** (ciLow > 0) | ≈ 26 | **1** |
| entirely **negative** (ciHigh < 0) | ≈ 26 | **183** |

The single positive is `at_33h/raw/m=.05/[0.30,0.33]/top20`, n=42, +39.6%, CI **[+0.4, +123.6]** — a lower
bound of four tenths of one percent, after 3,960 tries. The 183 negatives are not a search artifact: they
cluster on the levers §5 already identified (margin ≥ 0.05, the `accuracy` source, the tighter city filters).
So this is not "we searched hard and found nothing" — it is **"we searched hard and the surface is
significantly negative in 183 places and significantly positive in one."** There is nothing here to pick.

---

## 5 · One lever at a time — everything else pinned to the live rule

Full sample, varying a single dimension with the other four held at `first_in_window`/raw/m=0/[0.20,0.33]/all
(traps #12 — isolate the variable):

| lever | level | fire | n | win% | ask | **net/\$1** | city-CI |
|---|---|---|---|---|---|---|---|
| **timing** | first_in_window (live) | 45% | 689 | 26.3% | 26.9c | −6.9% | [−20.0, +6.9] |
| | latest_in_window | 45% | 689 | 27.1% | 26.7c | −3.7% | [−18.1, +11.0] |
| | at_12h | 38% | 600 | 27.8% | 27.3c | **−1.5%** | [−19.4, +12.9] |
| | at_18h | 35% | 520 | 28.1% | 27.4c | −2.3% | [−21.8, +8.0] |
| | at_24h | 37% | 424 | 26.7% | 26.7c | −5.0% | [−23.8, +13.7] |
| | at_27h | 27% | 279 | 26.2% | 26.1c | −4.3% | [−31.0, +16.9] |
| | at_30h | 27% | 352 | 24.7% | 26.5c | −11.2% | [−35.6, +16.3] |
| | at_33h | 29% | 359 | 25.3% | 26.6c | −10.8% | **[−42.5, −2.8]** |
| | at_36h / at_42h | — | 0 | — | — | — | *no data — the 36h wall (§2)* |
| | at_48h | 40% | 23 | 30.4% | 25.6c | +4.1% | [−81.4, +63.1] *(2 days)* |
| **source** | raw (live) | 45% | 689 | 26.3% | 26.9c | −6.9% | [−20.0, +6.9] |
| | **accuracy** | 11% | 176 | 17.6% | 24.0c | **−30.6%** | **[−64.5, −18.9]** |
| | agree | 3% | 43 | 20.9% | 24.8c | −23.6% | [−84.5, +22.8] |
| **margin** | m=0 (live) | 45% | 689 | 26.3% | 26.9c | −6.9% | [−20.0, +6.9] |
| | m=0.05 | 30% | 469 | 24.9% | 25.8c | −7.6% | [−26.3, +10.1] |
| | m=0.10 | 16% | 250 | 23.2% | 25.4c | −15.7% | [−40.6, +15.2] |
| | m=0.15 | 9% | 133 | 22.6% | 25.1c | −17.1% | [−56.9, +31.2] |
| | m=0.20 | 4% | 69 | 18.8% | 24.4c | **−28.2%** | [−72.5, +59.7] (day-CI [−68.7, **−0.7**]) |
| **band** | [0.20,0.25) | 23% | 352 | 20.5% | 22.3c | −11.7% | [−34.7, +20.5] |
| | [0.25,0.30) | 28% | 431 | 26.9% | 27.1c | −5.2% | [−26.4, +8.6] |
| | [0.30,0.33] | 21% | 324 | 30.6% | 31.5c | −6.0% | [−31.0, +19.0] |
| | [0.20,0.33] (live) | 45% | 689 | 26.3% | 26.9c | −6.9% | [−20.0, +6.9] |
| | [0.15,0.40] | 58% | 895 | 28.7% | 28.4c | **−3.9%** | [−16.4, +5.8] |
| | [0.10,0.50] | 63% | 978 | 29.6% | 29.0c | −4.8% | [−16.4, +5.7] |
| **city filter** | all (live) | 45% | 689 | 26.3% | 26.9c | −6.9% | [−20.0, +6.9] |
| | top20 | 15% | 236 | 28.0% | 27.9c | −5.7% | [−36.7, +16.5] |
| | top10 | 7% | 113 | 24.8% | 28.1c | −18.1% | [−38.7, +37.7] |
| | hit≥0.35 | 28% | 433 | 26.3% | 27.4c | −9.8% | [−27.6, +7.7] |

### The blunt read per lever

**Timing: nothing, and mildly backwards.** Every timing level's CI overlaps every other, so no honest
ranking exists — but the point estimates run the *opposite* way to the operator's "buy earlier" instinct
on this panel: the two latest measurable entries are the best (at_12h −1.5%, at_18h −2.3%) and the two
earliest measurable ones are the worst (at_30h −11.2%, at_33h −10.8%, the latter the only timing level
whose CI excludes zero — on the harmful side). The live rule (~36h) is the worst of the two window ends.
Crucially, **the genuinely-early region the original proposal cared about (36–48h) is unmeasurable** —
zero captures exist there. This lever cannot be resolved further without changing the capture cadence.

**Pick source: raw wins decisively; our own accuracy forecast is the worst change in the sweep.**
Substituting the bias-corrected `house_ensemble` pick for the raw consensus takes the cell from −6.9% to
**−30.6% with a city-clustered CI of [−64.5, −18.9] — the whole interval negative**, on 176 entries over
35 cities and 39 days. Win rate falls 26.3% → 17.6% while the mean ask falls only 26.9c → 24.0c, so this
is not a price effect: the bias-corrected pick is genuinely a *worse* bucket. It also only reconciles
9.1% with the live fills, confirming it is a materially different selector, not a re-labelling. `agree`
(both sources concur) fires on 3% of events and is also negative (−23.6%, n=43). **Do not point this lane
at the accuracy forecast.** This is the one result in the file large enough to act on, and it says
"don't."

**Margin: monotonically destructive.** −6.9% → −7.6% → −15.7% → −17.1% → −28.2% as m goes 0 → 0.20, with
the fire rate collapsing 45% → 4%. Requiring a *larger* model-vs-market disagreement selects precisely the
markets where the model is wrong: the market is well calibrated, so a big `pickProb − ask` gap is mostly
our error, not our edge. m=0.20's day-clustered CI [−68.7, −0.7] excludes zero. There is no filtering
version of this lever that helps; the knob is upside-down.

**Band: the market is calibrated across the whole band; wider is least-bad.** Win rate tracks price almost
exactly — 20.5% at a 22.3c mean ask, 26.9% at 27.1c, 30.6% at 31.5c — which is the fingerprint of a fairly
priced ladder, not a mispriced one. No sub-band is positive. The two *widest* bands are the least negative
and carry by far the tightest intervals ([0.15,0.40] −3.9% [−16.4, +5.8]; [0.10,0.50] −4.8% [−16.4, +5.7])
purely because they buy more markets. Widening is the only lever whose point estimate and CI both improve,
and it is still negative — it buys statistical power, not edge.

**City filter: no carry-forward skill.** A city's rolling 28-day house-pick hit rate does not predict its
next entry's P&L. `top20` (−5.7%) is indistinguishable from `all` (−6.9%); `top10` is *worse* (−18.1%);
`hit≥0.35` is worse (−9.8%). Every interval overlaps `all` by a wide margin, and the tighter the filter
the fewer cities survive (top10 → 19 cities) so the CI widens faster than the mean moves. Note this is the
as-of, no-look-ahead version — grades are counted only from target dates strictly before the entry day, so
it is not a leakage artifact; there is simply no persistence to exploit.

---

## 6 · Which traps were ruled out, and which are still live

**Ruled out:**
- **#1 synthetic vs real book** — every ask, bid and depth is an observed Polymarket quote from
  `opening-captures-archive`. No book is constructed anywhere. Gate calls carry `price_basis='real-book'`.
- **#6 in-sample overfit** — TRAIN/TEST split by resolution date; selection on TRAIN **ciLow**, TEST reported
  unchanged. The #1 TRAIN cell's +35.5% → −44.4% inversion is the trap firing and being caught.
- **#7 archive misalignment** — grading and every pick join on the temperature parsed from the bucket
  **label**; the `probs[i] ↔ bucket_idx = i` rule was verified in the source and asserted in the exporter
  (0 non-contiguous ladders), never assumed.
- **#8 proxy depth** — the $5 stake must clear `depthUsd` (executable depth at the ask), not a volume proxy;
  entries that cannot fill are no-fills, not free wins.
- **#10 pseudo-replication** — the binding CI is **city-clustered** (the frozen §9R-E unit) with a
  **day-clustered bootstrap** beside it; per-bet intervals are never quoted as the headline.
- **#11 wrong estimator** — Wilson for the win proportion, seeded day-cluster bootstrap for the
  heavy-tailed net return per \$1. `clustered_ci_fast` is asserted byte-equal to the frozen
  `analytics.clustered_ci` on every run.
- **#12 attribution** — the §5 table varies exactly one dimension with the other four pinned, so the
  "accuracy forecast is worse" claim is not a cohort artifact.

**Still live, and bounding the read:**
- **Entry-price fidelity (the 36h wall, §2).** On ~66% of events the archive has no quote at the moment the
  live lane fires, so the replica's `first_in_window` entry is later — and in the reconciled sample slightly
  *cheaper* — than the live fill. Direction of the bias is toward *flattering* the backtest, which makes the
  negative result stronger, not weaker; but it means these numbers are not a byte-exact model of the live rail.
- **The 36–48h region is unmeasurable.** Any claim about "buy at listing" remains untested by this work.
- **Multiple comparisons.** ~4,000 cells; treat any single cell's headline as a search result, not a finding.
- **Sample age.** 41 days, one season, 2026-07-05 → 08-15.

---

## 7 · Reproduce

```bash
pnpm tsx scripts/research/cheap-early-export.ts      # read-only DB export (winners/ladders/dists/grades/fills)
python scripts/research/cheap-early-improve.py       # the sweep (~70s cold, ~7s cached); --rebuild to re-parse
```
Artifacts: `scripts/research/out/cheap-early-improve.json` (all 3,960 cells + reconciliation + OOS table +
lever isolation), `cheap-early-{winners,ladders,dists,city-grades,live-fills}.json`, and the
`cheap-early-captures.npz` parse cache. The script exits **3** while the strict 22-fill reconciliation sits
below 80% — deliberately, so the coverage caveat in §2 cannot be read past silently.

Boundary held: read-only SELECTs, no trade, no credentials; writes confined to `scripts/research/out/` and
this doc.

---

## 8 · Forward paper variants (pre-registered 2026-08-15)

The sweep above is a **search**, not a finding: ~3,960 cells, one of which came out positive. The only honest
way to use it is to **pre-register** the handful of cells worth a forward read and then let the forward book
adjudicate them — which is what this section fixes in place. The six variants below are pinned **in code**
(`CHEAP_EARLY_VARIANTS`, `packages/core/src/sim/cheap-early-entry-replay.ts`), scored side by side with the
canonical rule on **every** `cheap-early-panel` tick, off the **same** ingest and the same ticks.

| id | rule | window (h-to-close) | ask band | margin | cities | backtest net/\$1 (city-CI, n) |
|---|---|---|---|---|---|---|
| `canonical` | latest-in-window | [24,36] | [0.20,0.33] | — | all | **−3.7%** [−18.1, +11.0] · n=689 |
| `live-replica` | **first**-in-window (what live did, ~36h) | [24,36] | [0.20,0.33] | — | all | **−6.9%** [−20.0, +6.9] · n=689 |
| `wide-band` | latest-in-window | [24,36] | [0.15,0.40] | — | all | **−0.5%** [−13, +9] · n=895 |
| `wide-band-open` | latest-in-window | [24,36] | [0.10,0.50] | — | all | **+0.4%** [−13, +10] · n=978 |
| `late-12h` | latest-in-window | [12,15] | [0.15,0.40] | — | all | **−0.5%** [−12, +10] · n=860 |
| `survivor` | latest-in-window | [33,36] | [0.30,0.33] | ≥0.05 | top-20 by hit rate (graded ≥8 / 28d) | **+39.6%** [+0.4, +124] · n=42 |

`survivor` is **the one positive cell of 3,960** — exactly the shape a multiple-comparisons artifact takes. It
is registered here to be **killed or confirmed forward**, not because it is believed.

**The decision rule (binding, pre-registered).** The metric is the **city-clustered 95% CI on net per \$1**,
and it only exists once the variant clears the §9R-E sufficiency floor: **n ≥ 40 markets · ≥6 cities · ≥7
distinct days**. Then:

- a variant **IMPROVES** only if its CI **excludes 0** *and* its net exceeds `canonical`'s. A higher point
  estimate with a CI straddling 0 is noise, not an improvement — that is the whole content of §5.
- **DEAD** = n ≥ 40 with the CI **wholly negative**: the pre-registered prune, and the variant stops being
  argued about.
- everything else reads **INSUFFICIENT** and keeps accruing days.

**No capital path.** A variant verdict is measurement only — it is rendered and written nowhere else. The gate
of record (`bot_gate_snapshot`, `source='forward-cheap-early'`) is still written from the **canonical** config
alone, by `record_cheap_early_gate`, so no variant can reach `trade_live_preflight` however it reads. There is
deliberately **no config surface** for editing the set: a variant you can re-tune after seeing the forward
number is not a forward test.

**Where it renders.** `/cheap-early` → *Variants (pre-registered 2026-08-15)*, the table above `Logged
potential entries`, showing forward n / win% / mean ask / net per \$1 / city-CI / verdict beside each
variant's backtest cell and its Δ vs canonical. Also on `/operation` via `dash_operation.variants`.

**Where it lives.** Engine + registry `packages/core/src/sim/cheap-early-entry-replay.ts` · view
`cheap-early-entry-view.ts` (`view.variants`, `view.variantsCommon`) · tick
`supabase/functions/cheap-early-panel/handler.ts` (pulls the **union** [12,36]h window so no variant is
starved) · migration `0127_cheap_early_variants.sql` (`cheap_early_city_hit_rates` — the top-K filter's only
input — and the `variants` key on `dash_operation`).
