# Pricing-bucket data — the exhaustive close (C23)

**Operator ask (2026-07-09):** *"Evaluate every option available, leave no stone unturned"* on the
Polymarket pricing-bucket data. This is the completeness sweep after C19 (calibration), C20 (winner
neighbourhood), C21 (round-trip scalp) and **C22 (the sufficient-statistic proof: price already
contains every single-bucket path/level/order-book feature)**.

## Verdict — the pricing-bucket-data surface is CLOSED. No new edge.

C22 proved price is a sufficient statistic on **one bucket's** level, path-shape and order book. This
sweep tests the axes that single-bucket frame could not have covered, plus the two documented gaps.
**Every one comes back null.** Forecast-free, on 26,176 liquid ladder snapshots / 45 cities / ~522
days (the 238M-row enriched archive) and the real `opening_captures` order book:

| Test | New? | Result | Number (with CI) |
|---|---|---|---|
| **T1** high-price-band (55–95¢) calibration | **new** (C19 scoped 5–55¢) | **calibrated** | every event-clustered gap CI brackets 0; small persistent negative tax |
| **T2** cross-bucket **ladder geometry** (unimodality-violation fade) | **new — the flagship** | **KILL frictionless** | edge **+2.95pp [−1.54, +7.44]** (straddles 0); winFrac 0.169 (<0.5); city ciLow **−3.3%**; day ciLow −2.1%; zsMC 0.016 |
| **T3** real-book flip of T2 on `opening_captures` | **new** | **dead, negative** | real-ask edge **−8.72pp [−11.27, −6.17]** (interval fully negative); depth p50 **$4.33**, only 18.5% ≥$20 |
| **T4** whole-ladder sharpness / modal calibration over life | **new** | **calibrated** | modal gap ≈0 every life-decile; entropy 1.49→0.09 nats monotone |

The one apparent positive — a frictionless "PASS" on **spike-fade** (+16.1%) — is the *modal favorite*
of every unimodal ladder (5,350 of them). That is **fade-the-favorite / favorite-longshot bias ≡ C20 +
C22**, a stale-mid artifact that dies crossing the real NO spread + fee. Reported here as the honest
trap it is, not a signal.

**Price is a sufficient statistic on the cross-bucket axis too.** Twelve signals dead; this closes the
last unexamined corner of the price data itself.

---

## The complete option matrix — every axis, its status, its citation

This is the "leave no stone unturned" ledger. Every way you can slice a bucket-ladder price series,
mapped to whether it was tested and where it died. **Everything that conditions on a single bucket is
closed by C19–C22; everything cross-bucket / cross-time / cross-venue is closed below or already dead.**

### A. Single-bucket **level** (price → outcome calibration)
| Slice | Status | Where |
|---|---|---|
| 5–55¢ tradable band | **DEAD** — calibrated, consistent negative gap (13.5¢→10.8%, 45¢→39.8%) | C19 |
| **55–95¢ high band** | **DEAD (new, T1)** — calibrated, event-clustered gap CI brackets 0 at every bin | this doc |
| cheap-longshot overpricing (fade) | **DEAD** — real +EV frictionless, flips −9.75% on the real $2-depth book | C22 |

### B. Single-bucket **path / time-series**
| Slice | Status | Where |
|---|---|---|
| momentum 1/3/6h, accel, drawdown, run-up, dwell, oscillation, hrs-since-peak | **DEAD** — every price-controlled lift ±0.3–1.9pp, group EV negative | C22 |
| peak→dip→recover round-trip scalp | **DEAD** — martingale, hit 54.5% = null 56%, taker −21% | C21 |
| buy-the-lifetime-dip | **DEAD** — survivorship; at the dip the winner is indistinguishable from the loser | C19 |

### C. Single-bucket **order book** (bid/ask/depth/imbalance)
| Slice | Status | Where |
|---|---|---|
| imbalance / spread / depth on `opening_captures` | **DEAD** — imbalance +3.3pp CI [−0.4,+7.0] straddles 0; no residual beyond mid | C22 |
| order-placement (resting-order) stream | **IMPOSSIBLE** — public book is anonymous; only fills are attributed | SIGNAL-BACKLOG #7 |

### D. **Cross-bucket ladder vector** at one instant (the simplex geometry) — *the genuinely new axis*
| Slice | Status | Where |
|---|---|---|
| sum-to-1 (overround / complete-set) | **DEAD** — inconsistent ~16% but taker fee > mispricing; live 0/107 | COMPLETE-SET-ARB |
| **unimodality / interior-trough fade (bimodal ladder)** | **DEAD (new, T2/T3)** — KILL frictionless, −8.72pp real book | this doc |
| **butterfly (buy trough, sell shoulders)** | subsumed by T2 — the trough is the anomaly; it isn't underpriced | this doc |
| interior-spike (fade the mode) | **DEAD** — ≡ favorite-longshot / C20 NO-fade (winner 81.7% at 70–85¢) | C20, this doc |

### E. **Whole-ladder time-structure** (life-fraction)
| Slice | Status | Where |
|---|---|---|
| winners bottom ~15% into life | **DEAD** — descriptive hindsight, not point-in-time actionable | C19 |
| **sharpness / entropy / modal calibration over life** | **DEAD (new, T4)** — modal gap ≈0 all deciles; market sharpens efficiently | this doc |

### F. **Cross-ladder / cross-city / cross-day / cross-venue**
| Slice | Status | Where |
|---|---|---|
| cross-horizon day+1/day+2 propagation lag | **DEAD** — well-powered null +0.80pp [−1.74,+3.34] | SIGNAL-BACKLOG #6 |
| cross-venue (Kalshi↔Polymarket) relative value | **DEAD** — capacity wall, 1–10 contracts true depth | CROSS-VENUE-SPIKE |
| conditional efficiency by disagreement regime | **UNPROVEN-DEAD** — Q4 PASS revoked, INSUFFICIENT at day grain (3 wx-days); needs ≥10 Q4-days | SIGNAL-BACKLOG #3 |
| per-city / per-hour heterogeneity | thin — analytics selection only; live paper loop confirms | SIGNAL-BACKLOG #12 |

**Everything forecast-conditioned** (our-forecast-vs-price) is a separate, already-closed family:
KILL-GATE 2 pooled (+0.46pp, straddles 0), the forecast-anchored realizability (−1.42%/fee, C20), the
convergence/maker-exit plays (12th signal, forward KILL). This sweep is deliberately **forecast-free**
— a pure test of the price vector — so it does not re-run that family.

---

## The four tests, in detail

Engine: `scripts/research/pricing-bucket-exhaustive.py` (selftested — temperature parser, geometry
detector, gate wiring all known-answer checked). Gate + estimators are the `analytics.py` port of the
frozen §9R-E gate (`opening_verdict`), reproduced bit-for-bit across two independent full runs.

**Temperature axis, not `bucket_idx` (trap #7 avoided).** The enriched archive stores buckets in **raw
Gamma order** — e.g. london event 17016 has idx 4 = "35°F or lower" (the coldest). Unimodality is only
meaningful on the *temperature* axis, so every ladder is sorted by a temperature key parsed from the
`label` (the first integer is a monotone sort key across `35°F or lower` / `36-37°F` / `46°F or higher`
/ signed °C). The positional index is never trusted.

### T1 — High-price-band (55–95¢) calibration *(the C19 gap)*
Point-in-time, forecast-free. Win-rate vs price per 5¢ bin; event-clustered gap CI (one obs per
event-in-bin, mean±z over events); tick-weighted point for C19 continuity.

| bin | n_events | winrate (ev-clustered) | **gap [95% CI]** |
|---|---|---|---|
| 0.55 | 964 | 0.514 | **−3.6pp [−6.7, −0.6]** |
| 0.60 | 596 | 0.573 | −2.7pp [−6.6, +1.2] |
| 0.65 | 516 | 0.619 | −3.1pp [−7.2, +1.1] |
| 0.70 | 359 | 0.693 | −0.7pp [−5.4, +4.0] |
| 0.75 | 372 | 0.764 | +1.4pp [−2.9, +5.7] |
| 0.80 | 303 | 0.792 | −0.8pp [−5.3, +3.8] |
| 0.85 | 291 | 0.857 | +0.7pp [−3.3, +4.7] |
| 0.90 | 377 | 0.924 | +2.4pp [−0.3, +5.1] |
| 0.95 | 572 | 0.943 | −0.7pp [−2.6, +1.2] |

The expensive side is **calibrated** — a tiny negative tax at 0.55–0.65 fading to ~0 higher up; every
CI brackets 0 except 0.55 (which is *negative*, i.e. overpriced, the wrong way to trade). After the 5%
taker fee + spread every bin is −EV, exactly as the 5–55¢ band. The low band re-confirms the
cheap-longshot overpricing (−1.3pp to −3.7pp, CIs exclude 0 on the negative side). **No exploitable
bias anywhere in the price range.** (`pbx-mid-result.json` → `T1_high_band_calibration`.)

### T2 — Cross-bucket ladder geometry (the flagship new angle)
A daily-Tmax distribution is physically **single-peaked**, so an *interior strict local minimum* in the
temperature-ordered price ladder (a bucket >2¢ below both material neighbours) is a pricing
inconsistency — a bimodal ladder the market shouldn't rationally price. Buy that trough bucket
(forecast-free), grade `won − p` through the frozen gate.

- Interior troughs are **rare**: 297 of 26,176 liquid snapshots (**1.1%**) → **248 unique trough-buys**
  (deepest snapshot per event-bucket; deepest-selection is *generous* to the signal).
- **Frictionless:** winFrac **0.169** (fails the ≥0.5 bar outright — trough buckets are cheap longshots,
  avgAsk 14¢), edge **+2.95pp [−1.54, +7.44]** (straddles 0), city-clustered mean +1.77% **ciLow −3.34%**,
  day-clustered **ciLow −2.08%**, zsMC 0.016. → **KILL.**
- **Fee-only:** mean +1.19%, ciLow −3.92%. → **KILL.**

The mild positive point estimate is just the cheap-longshot noise; it evaporates under proper clustering
and after fees. **The market's ladder geometry is internally consistent — its rare bimodal blips carry no
fadeable underpricing.**

### T3 — The real-book flip *(trap #1/#8 — where every prior mid signal died)*
Detect troughs directly on the **real `opening_captures` ask ladder** (`bestAsk` per bucket), grade at
the real ask + taker fee against the resolved winner, require executable `depthUsd`.

| | edge (won − real ask − fee) | hit @ avgAsk | n |
|---|---|---|---|
| all real-book troughs | **−8.72pp [−11.27, −6.17]** | 3.4% @ 12.2¢ | 233 / 44 cities |
| exec-depth-gated (≥$20) | **−17.4pp [−24.2, −10.6]** | 4.7% @ 22.1¢ | 43 / 26 cities |

The frictionless mid trough (+2.95pp point) **flips to −8.72pp with the CI fully below zero** on the real
book — the identical sign-flip that killed the C22 fade cohort (+3.39%→−9.75%) and the maker-exit
(+6.7%→−12.6%). Trough-bucket `depthUsd` is **p50 $4.33, p10 $0.26**; only **18.5%** clear a $20 probe —
the trough is the thin, unloved bucket, exactly where depth is worst. The depth-gated subset is *worse*
(the deep troughs are the ones the market has actively priced). The gate reads INSUFFICIENT only because
the raw-book archive is a narrow resolved window (6 distinct days); the **edge sign is decisive and
negative**, consistent with the frictionless KILL. (`pbx-realbook-result.json`.)

### T4 — Whole-ladder sharpness / modal calibration over life
Does the market's whole-distribution confidence calibrate as the day resolves, or is there a fadeable
mis-sharpening independent of any forecast?

| life-decile | n | modal win-rate | mean modal price | **modal gap** | entropy (nats) |
|---|---|---|---|---|---|
| 0 (fresh) | 999 | 0.436 | 0.410 | +2.7pp | 1.49 |
| 3 | 2393 | 0.445 | 0.439 | +0.6pp | 1.38 |
| 6 | 2732 | 0.499 | 0.506 | −0.7pp | 1.19 |
| 7 | 2985 | 0.552 | 0.573 | −2.0pp | 1.02 |
| 8 | 3515 | 0.811 | 0.818 | −0.7pp | 0.46 |
| 9 (resolve) | 4651 | 0.961 | 0.973 | −1.2pp | 0.09 |

The modal (favorite) bucket is calibrated at every stage of life (gap ≈0, slightly overpriced late =
favorite-longshot again), and ladder entropy declines monotonically 1.49→0.09 nats — **the market
sharpens its whole distribution efficiently as the running max is observed.** No fadeable mis-sharpening.

---

## Traps ruled out (the pre-belief checklist)

- **Real book vs synthetic (#1/#8):** T2 is a KILL on the mid *already*; T3 re-prices on the actual
  observed `bestAsk` + `depthUsd`. The frictionless→real flip (−8.72pp) is measured, not assumed.
- **Executable depth (#8):** depth walked per trough; p50 $4.33; only 18.5% clear $20; depth-gated subset
  reported separately (−17.4pp).
- **Round-trip costs (#3):** taker fee `rate·p·(1−p)` on both the frictionless and real-book legs.
- **Clustered on the right unit (#10):** city-clustered t-CI + opt-in **day-block** on every gate; the
  calibration CIs cluster by event (one obs per event-in-bin), not per-tick — dwell pseudo-replication
  neutralised (the tick-weighted point is reported separately, labelled as opportunity-weighted).
- **Right estimator (#11):** Wilson for the modal win-rate, mean±z for the `won−p` gap, seeded bootstrap
  for EV/$1 — via `arm_edge_stats`.
- **Zero-skill null (#10/#11):** sign-flip MC on T2 (0.016).
- **Attribution (#12):** the "spike-fade PASS" is correctly attributed to favorite-longshot bias (≡ the
  modal bucket), **not** a geometry edge — the whole reason it is reported as a trap, not a signal.
- **Index-space (#7):** temperature axis parsed from the label; `bucket_idx` (raw Gamma order) never
  trusted.

## What this closes — and what it does not

**Closes:** the last unexamined corner of the *price data itself* — the cross-bucket ladder geometry,
the high-price band, and the whole-ladder sharpness evolution. Combined with C19–C22, **price is a
sufficient statistic across level, path, order book, AND the cross-bucket vector.** There is no
single-bucket or cross-bucket, forecast-free, pricing-only signal left to test on this data. Any future
"new angle" on the bucket prices alone is a re-skin of a dead test.

**Does not touch (out of scope by construction — genuinely different information, not new price slices):**
- Forecast-conditioned regime efficiency (SIGNAL-BACKLOG #3) — *unproven-dead*, re-opens only with ≥10
  distinct high-disagreement weather-days in a TEST period. Needs the NWP forecast, not the price data.
- Any signal requiring data the public surface doesn't expose (order-placement stream, #7 — impossible).
- New instruments (precip/wind, #9 — liquidity-KILL) — a different market, not a new price slice.

The live forward paper instruments (`/maker-exit`, `/paper-trade`, `/amsterdam`, `/efficiency`, `/data`)
keep running as analytics regardless. The trading rail stays **DORMANT**; no capital implication; the
boundary holds (Claude never trades, never touches credentials).

---

## Reproduce

```bash
cd "D:/Second Brain/03 Projects/Polyweather"
python scripts/research/pricing-bucket-exhaustive.py selftest      # known-answer core checks
python scripts/research/pricing-bucket-exhaustive.py partition     # 238M rows -> per-city lean parquet (~30s)
python scripts/research/pricing-bucket-exhaustive.py run           # T1/T2/T4 mid-archive sweep (~6min, reproducible)
python scripts/research/pricing-bucket-exhaustive.py realbook      # T3 real-book flip on opening_captures (~30s)
```
Artifacts (local, `scripts/research/out/`): `pbx-mid-result.json`, `pbx-realbook-result.json`,
`pbx-trough-trades.json`, `pbx-winner-lookup.json`.

_Analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
