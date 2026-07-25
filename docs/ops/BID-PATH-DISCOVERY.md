# BID-PATH-DISCOVERY — did we miss a bidding pattern? (2026-07-25)

> **VERDICT: NO. Across the entire historic price-path panel — 238,311,600 rows / 45 cities / 522 target
> dates — the market's implied-probability price is an efficient martingale.** Its current LEVEL is a
> sufficient statistic (the path SHAPE adds no out-of-sample predictive power), its only calibration
> bias (favorite-longshot) sits INSIDE the taker spread, and the one seductive "short-horizon
> mispricing" that showed up is a **ghost-price staleness artifact** — quotes ~23 h stale that you could
> never trade. No new identifiable bidding pattern; nothing promotable to a test. This is a fresh,
> from-scratch **discovery** pass (unsupervised path-shape lift, not a re-run of a named hypothesis), and
> it lands exactly where the 12 killed signals did. Read-only throughout; no trade, no book touched.

Operator ask (2026-07-25): *"rerun the analysis of all historic bidding patterns we have data on … learn
if there is any identifiable bidding pattern that we missed."*

Engine: `scripts/research/bid-path-discovery.py` (committed). Artifacts: `scripts/research/out/bid-path-{lift,calib,calib-fresh}.json`,
`bid-path-features.parquet` (374,617 feature rows). Stats via the skill's `analytics.py` (selftest PASS).

---

## 1 · What "all historic bidding data" actually is (two very different surfaces)

| Surface | What it is | Size | Prior coverage |
|---|---|---|---|
| **`market-history-flat-enriched.parquet`** | full-lifecycle **implied-probability price path** (`p` per bucket over time). **NO bid/ask** — this is the mid/last price. | **238M rows / 45 cities / 522 dates** | the big, under-mined canvas — this run |
| **`opening-captures-archive/`** | the **only raw bid/ask/depth** archive — but only the **opening** window of freshly-listed markets | 475 events | exhaustively worked by the 12 signals + the 07-24 convergence-capture run |

So "all historic bidding" = the 238M-row **price-path** panel (mid), plus a small opening-window **bid/ask**
archive that is already fully falsified. This run attacks the big one head-on with a discovery method, and
re-confirms the bid/ask side is closed (§6).

## 2 · The method (discovery, not another named-hypothesis re-run)

The 12 kills each tested ONE pre-stated bet. This asks the prior question unsupervised: **does the SHAPE of a
bucket's price path predict its resolution beyond the current price LEVEL?** If the price is efficient
(a martingale), `E[win | whole path so far] = p_now` and no path feature adds out-of-sample lift.

For every `(event, bucket)` at fixed times-to-resolution τ ∈ {24,12,6,3,2,1} h, extract `p_now` plus 8 path
features (momentum at 1/3/6 h, draw-from-max/min, 6 h volatility, age, tick-count) with **no look-ahead**
(features read `ticks[0..τ]` only). Then, **train/test split BY DATE** (winner's-curse-aware): compare an
out-of-sample logistic on `logit(p_now)` alone vs `logit(p_now) + path features`. ΔAUC / Δlog-loss ≈ 0 ⇒ the
level is a sufficient statistic ⇒ no missed path pattern.

## 3 · Result 1 — the price path carries NO information beyond its current level

Out-of-sample (split 2026-03-20; n_train 14,312 / n_test 42,363), path features add nothing at the powered
horizons and are unstable-noise at the sparse ones:

| τ | n_test | AUC (price only) | **ΔAUC (+path)** | read |
|---|---|---|---|---|
| 24 h | 22,868 | 0.812 | **+0.0010** | null (well-powered) |
| 12 h | 12,866 | 0.897 | **−0.0004** | null (well-powered) |
| 6 h | 2,265 | 0.906 | +0.0054 | noise |
| 3 h | 1,615 | 0.837 | +0.029 | noise (see §5) |
| 2 h | 1,478 | 0.832 | +0.0052 | noise |
| 1 h | 1,271 | 0.796 | +0.014 | degenerate fit |

The raw price is **already well-calibrated** (log-loss of raw `p_now` ≈ recalibrated) and strongly predictive
(AUC 0.80–0.91); the full path shape cannot beat it out-of-sample. **The current price is a sufficient
statistic** — the martingale property, now measured on 522 dates via a discovery method rather than assumed.
This independently re-confirms `nonprice-fingerprint-kill` ("price is a sufficient statistic") on the full panel.

## 4 · Result 2 — the only calibration bias sits INSIDE the taker spread

Well-powered horizons (24 h / 12 h), realized win rate vs price by band, with a taker round-trip read (pay
`ask ≈ p + 2.3¢` half-spread — the measured cheap-bucket half-spread from CONVERGENCE-CAPTURE §4 — fee both legs):

- **Cheap buckets are mildly OVER-priced** (favorite-longshot): 24 h price 0.17 → win 0.14 (−3 pp); 0.25 → 0.22.
- **Favorites are mildly UNDER-priced**: 24 h 0.5–0.7 → +1.2 pp, 0.7–1.0 → +1.2 pp; 12 h 0.7–1.0 → +2.2 pp.
- **Every single band's taker EV is NEGATIVE.** Even the favorite bands where win > price (+1–2 pp), the gain
  is smaller than the spread you cross (e.g. 12 h 0.7–1.0: gap +2.2 pp, EV/contract **−0.4¢**).

The favorite-longshot bias is real and consistent, and it is **a maker edge, not a taker edge** — the exact
shape the 07-24 convergence-capture NO-side test found (±2.5¢ bias, cancelled by the 2.3¢ half-spread). Nothing
here a taker can monetise.

## 5 · Result 3 — the one seductive signal is a GHOST-PRICE artifact (and its kill)

A naïve calibration at short horizons screamed a huge mispricing: at 3 h-to-close, mid-band buckets (price
0.3–0.5) won only ~14 % (a **−27 pp** "overpricing"), and a path-lift pocket lit up (3 h cheap ΔAUC up to +0.16).
**Both are a censoring artifact, proven by staleness:**

| 3 h horizon, price band | n | win | gap | **median staleness of the "current" price** |
|---|---|---|---|---|
| 0.15–0.30 | 373 | 0.075 | −0.152 | **22.9 h** |
| 0.30–0.50 | 335 | 0.137 | −0.276 | **23.0 h** |
| 0.70–1.00 (winners) | 214 | 0.850 | −0.076 | 0.01 h |
| 0.00–0.05 (clear losers) | 789 | 0.015 | −0.003 | 23.1 h* |

The mid-band "0.41 at 3 h-to-close" is on average a **23-hour-old quote** — an illiquid losing bucket that
stopped being quoted ~a day before resolution and never re-priced down. You could never sell at 0.41; the
market isn't showing 0.41. The winners/clear-losers keep ticking (stale ≈ 0.01 h), which is why the artifact
is confined to the mid band and vanishes at the 24 h horizon (there, `stale_p90` = 0.02 h — everything fresh).

**The 3 h path-lift pocket is the same artifact, and it dies:** on a live-price filter (stale < 0.5 h) it
appears ONLY at the two most extreme late-date splits (n=0 test rows at splits 0.5/0.6/0.7/0.75) — one time
window's overfit — over a cell whose base win rate is **7.7 %** (near-certain losers). An AUC lift that
re-ranks near-certain losers is not an edge, and the calibration already shows 3 h cheap taker-EV is negative.
Below the §9R-E sufficiency + stability bar; **KILL**.

## 6 · What this does and does not cover

- **Covered (new, comprehensive):** every price-path/level/shape/momentum/mean-reversion/volatility/calibration
  pattern in the mid-price, across all 522 dates, out-of-sample. All null or artifact.
- **The raw bid/ask ORDER BOOK** (spread/depth/imbalance dynamics) exists only in `opening-captures` (475
  events, opening window) and is **already exhaustively falsified**: convergence selection (14/14 KILL 07-24),
  NO-side (powered NULL), hold (KILL), maker-exit (live KILL), bracket (KILL), non-price winner-fingerprint
  (KILL), fluctuation-taker (KILL). This run does not re-open them; it re-confirms the mid-price they sit on
  is efficient.
- **Not measurable from any archive:** the live bid/ask **3 h-to-resolution** book. Even if the §5 mid-band
  effect were real (it isn't — it's stale), there is no executable-book archive at that horizon to price it,
  so it could only ever be a forward-capture question, and the honest prior (staleness + efficiency) says don't.

## 7 · Traps ruled out (`references/traps.md`)

| Trap | How handled |
|---|---|
| #1 synthetic vs real book | mid-price is the market's OWN implied prob, not a constructed book; the executable read is flagged mid-basis and the bid/ask side is deferred to the (exhausted) opening-captures archive |
| #6 in-sample overfit | every headline is out-of-sample, split BY DATE; the only positive (3 h pocket) is shown to be one-window overfit |
| #8 proxy depth | tradability read is explicit taker round-trip (spread + fee both legs), not a volume proxy; no WIN claimed |
| #10 pseudo-replication | the 3 h pocket's 469 rows = 203 city-days over one window; flagged under-powered, not counted as n=469 |
| #11 wrong estimator | Wilson on win-rate bands, AUC/log-loss for ranking, **AUC-lift ≠ EV** stated explicitly |
| **Staleness / censoring (the new catch)** | added `stale_h`; proved the short-horizon "mispricing" is a 23 h ghost price; re-ran every short-horizon read on live prices only |

## 8 · Carry-forward

- **No arm earns a test.** The market mid-price is efficient across all history; no bidding pattern was missed.
  Signal count unchanged: 12 dead, none reopened, no scoped exception pending.
- **The one durable methodological catch — staleness — is worth keeping:** any future price-path analysis over
  `market_price_history` MUST filter on quote freshness at the horizon, or illiquid mid-band buckets inject a
  ~23 h ghost-price bias that fabricates a huge (untradeable) "mispricing." Added to the traps the next session
  should apply.
- Tooling is reusable: `bid-path-discovery.py` (extract → analyze → calib, staleness-aware) runs the whole
  sweep from the local Parquet in ~8 min, no DB load.

## 9 · Reproduce

```bash
A=scripts/research/bid-path-discovery.py
python $A extract                                   # 45-city feature panel → out/bid-path-features.parquet
python $A analyze --split-frac 0.8 --per-city       # OOS path-shape lift (Result 1) → out/bid-path-lift.json
python $A calib                                     # calibration + taker EV (Result 2) → out/bid-path-calib.json
python $A calib --max-stale 0.5                     # live-price control (Result 3) → out/bid-path-calib-fresh.json
python $A analyze --cheap --max-stale 0.5 --split-frac 0.8   # the 3h pocket kill
```
