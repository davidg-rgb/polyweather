# Weather Edge — Polymarket Temperature Betting System

> **One-line:** Build a probabilistic temperature forecaster that's better calibrated than the Polymarket consensus, compute per-bucket edge against live market prices, and stake fractional-Kelly positions when edge clears the fees-plus-uncertainty threshold. Profitable on expectation across hundreds of bets, not on any single one.

---

## 1. Core premise & honest framing

Polymarket runs daily "Highest temperature in {City} on {Date}?" markets resolving on Wunderground airport-station data. Each market is a discrete distribution over ~11 temperature buckets in whole degrees. Bucket prices sum to ~$1 and are the crowd-implied probability.

**The trade:** for each bucket *b*, compute

```
edge(b) = our_probability(b) − market_ask_price(b)
```

When `edge(b)` exceeds a threshold that covers fees, slippage, and model uncertainty, buy YES shares of bucket *b* with size determined by fractional Kelly. Over hundreds of independent (city × date) trades the positive expectancy compounds; on any single trade it's pure variance.

**What this is NOT:**
- A way to "know tomorrow's weather." Weather is irreducibly uncertain — that's *why* a market exists.
- A guaranteed-profit system. Edge can be negative for weeks. Drawdowns are large.
- A solo edge. Sophisticated bots already trade these markets. We're competing for residual mispricing, not picking up free money.

**What this IS:** a disciplined application of better-calibrated probabilities than the median trader. Sustainable if and only if our calibration is genuinely better and our risk management stops us from blowing up during the inevitable cold streaks.

---

## 2. Cities, resolution stations & timezone

Polymarket markets resolve on a specific airport station, *not* the city centre. Match every forecast query to the same coordinates.

| City      | Resolution station (Wunderground)     | ICAO  | Lat       | Lon        | TZ              |
|-----------|----------------------------------------|-------|-----------|------------|------------------|
| Seoul     | Incheon Intl                           | RKSI  | 37.4602   | 126.4407   | Asia/Seoul       |
| Hong Kong | Hong Kong Intl                         | VHHH  | 22.3080   | 113.9185   | Asia/Hong_Kong   |
| Chicago   | O'Hare Intl (verify per market)        | KORD  | 41.9742   | -87.9073   | America/Chicago  |
| Beijing   | Beijing Capital Intl (verify)          | ZBAA  | 40.0801   | 116.5846   | Asia/Shanghai    |
| London    | Heathrow (verify; sometimes London City)| EGLL  | 51.4700   | -0.4543    | Europe/London    |
| Tokyo     | Tokyo Haneda (verify; sometimes Narita)| RJTT  | 35.5494   | 139.7798   | Asia/Tokyo       |
| Shanghai  | Pudong or Hongqiao (verify)            | ZSPD  | 31.1443   | 121.8083   | Asia/Shanghai    |
| Paris     | Le Bourget or CDG (verify)             | LFPB  | 48.9694   | 2.4414     | Europe/Paris     |

> **Critical:** verify the resolution station from each market's rules *every single time before betting*. Per the polymarketweather.com strategy notes, coordinate mismatch — querying the forecast for the wrong station — is the single most common cause of unexpected losses in this category.

The market resolves to **daily maximum** temperature in whole degrees, °C for most cities, °F for US cities. Always store both units.

---

## 3. The math (read carefully)

### 3.1 From point forecasts to a probability distribution

The v1 spec's bias-corrected ensemble produces a *point* temperature. For betting we need a distribution `P(T = b)` over each Polymarket bucket *b*.

**Method 1 — Gaussian fit (start here).** Treat the N corrected model forecasts as samples. Compute mean μ and variance σ². For each bucket *b* (width 1°C centred at *b*):

```
P(T = b) ≈ Φ((b + 0.5 − μ) / σ) − Φ((b − 0.5 − μ) / σ)
```

where Φ is the standard normal CDF. σ should not be the sample std-dev of the ensemble — it's too narrow. Set σ from the historical residual error of the ensemble at this lead time, computed from the verification table in v1. Underdispersion is the most common calibration failure.

**Method 2 — Empirical / KDE.** Bootstrap: draw N corrected forecasts plus residuals from the same (city, lead, season) cluster, build the empirical CDF, integrate over each bucket. Heavier-tailed and usually better-calibrated than Gaussian when you have enough history.

**Method 3 — Quantile regression / isotonic recalibration.** Train a model that maps raw ensemble statistics to bucket probabilities directly, fit to historical (forecast, outcome) pairs. Best in theory; needs more data.

Whatever method, **the output is a vector of probabilities over the same buckets Polymarket exposes**. Round / re-bin to match exactly.

### 3.2 Edge per bucket

For each bucket *b* with our probability *q*ᵦ and best market ask price *p*ᵦ:

```
edge(b) = q_b − p_b
```

This is the *additive* edge, in probability points. A 0.08 edge means we think the bucket is 8 percentage points more likely than the market does.

### 3.3 Expected value

Buying one YES share at price *p* pays $1 if the bucket hits, $0 otherwise.

```
EV per share = q × (1 − p) + (1 − q) × (−p) = q − p
EV per $ staked = (q − p) / p
```

So if *q* = 0.30 and *p* = 0.20, EV per share = 0.10, EV per dollar staked = 50%. Sounds huge — but only if the 0.30 estimate is honest. Over-confident forecasts will print fake +EV every day and slowly lose money.

### 3.4 Position sizing — fractional Kelly

For a binary bet at price *p* with true win probability *q*, the Kelly-optimal stake as a fraction of bankroll is:

```
f* = (q − p) / (1 − p)
```

**Never use full Kelly with estimated probabilities.** Use a fraction *k* ∈ [0.10, 0.25] (typical: 0.25, "quarter Kelly"). The smaller *k*, the more robust to estimation error in *q*.

```
stake = k × f* × bankroll
```

Hard-cap stake at e.g. 2% of bankroll per trade regardless of what Kelly says. Add a per-city correlated-exposure cap (sum of stakes on related cities ≤ 5% of bankroll) — a European heatwave moves London and Paris together.

### 3.5 Trade threshold

Don't trade marginal edges. Require:

```
edge(b) ≥ taker_fee + slippage_estimate + uncertainty_margin
```

For Polymarket temperature markets, taker fees are typically ~2%, slippage on small orders ~1%, model uncertainty buffer ~5%. **Practical minimum edge ≈ 8 percentage points.** Anything below that, skip.

---

## 4. Data sources

### 4.1 Forecast inputs (same as v1)

Open-Meteo Previous Runs + Forecast APIs for Tier-1 national models: ECMWF IFS, NOAA GFS, DWD ICON, JMA GSM, KMA GDPS, CMA GRAPES, Météo-France ARPEGE / AROME, UKMO. Plus optional commercial APIs once forward-collected long enough to compete.

### 4.2 Market data — Polymarket

- **Gamma REST API** (`https://gamma-api.polymarket.com`) — no auth, JSON. Use for market discovery, full market metadata, daily polling.
  - List markets: `GET /events?tag_id={temperature_tag}&active=true&closed=false`
  - By slug: `GET /markets/slug/highest-temperature-in-{city}-on-{date}`
- **CLOB API** (`https://clob.polymarket.com`) — for order book depth + posting orders. Requires API key derived from wallet.
- **CLOB WebSocket** — real-time price stream. Use only after Gamma polling proves insufficient.

### 4.3 Truth source — Wunderground

**This is the source that resolves the bets, so it must be canonical.** Pull each station's daily high via Wunderground's public history page (`/history/daily/{country}/{city}/{ICAO}`). Their API is gated; for low volume scraping is acceptable, otherwise pay for the API.

Store ERA5 (Open-Meteo Archive) *alongside* Wunderground as a secondary truth — useful for calibration cross-checks and for periods Wunderground is unavailable, but **bets are always graded against Wunderground**.

---

## 5. Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Schedulers (Vercel Cron / Supabase Edge Functions)               │
│  • Daily 06:00 UTC → forecast snapshots from all weather models   │
│  • Every 5 min during active markets → poll Gamma API for prices  │
│  • Daily 03:00 UTC → Wunderground actuals for yesterday           │
│  • Daily 04:00 UTC → calibration refresh + correction retraining  │
│  • Continuous → edge monitor on open positions                    │
└───────────────────────────────────────────────────────────────────┘
              │                  │                  │
              ▼                  ▼                  ▼
     ┌────────────────┐  ┌──────────────┐  ┌──────────────┐
     │   Open-Meteo   │  │  Polymarket  │  │ Wunderground │
     │ models + ERA5  │  │ Gamma / CLOB │  │  (truth)     │
     └────────┬───────┘  └──────┬───────┘  └──────┬───────┘
              │                 │                 │
              ▼                 ▼                 ▼
     ┌───────────────────────────────────────────────────────┐
     │             Supabase Postgres                         │
     │  forecasts │ distributions │ market_snapshots │       │
     │  observations │ bets │ pnl │ calibration_scores │ …   │
     └───────────────────────────────────────────────────────┘
              │                       │
              ▼                       ▼
     ┌───────────────────┐   ┌─────────────────────────┐
     │  Edge calculator  │   │  Next.js dashboard      │
     │  + position sizer │   │  • Live bet recs        │
     │  + risk checks    │   │  • Calibration view     │
     │                   │   │  • P&L + bankroll       │
     └─────────┬─────────┘   └─────────────────────────┘
               │
               ▼
     ┌──────────────────────────────┐
     │  Trade executor (phased)     │
     │  • Phase A: manual approval  │
     │  • Phase B: semi-auto        │
     │  • Phase C: fully automated  │
     └──────────────────────────────┘
```

---

## 6. Data model (additions to v1)

### `bucket_probabilities`
Our calibrated distribution per (city, target_date, lead, source).

```sql
id              uuid PK
city_id         uuid FK
target_date     date
lead_days       smallint
source          text       -- 'house_ensemble' | 'ecmwf_only' | 'market_consensus'
made_at         timestamptz
bucket_lower    real       -- e.g. 23.5
bucket_upper    real       -- e.g. 24.5
bucket_label    text       -- '24°C'
probability     real
UNIQUE (city_id, target_date, lead_days, source, made_at, bucket_label)
```

### `market_snapshots`
Live Polymarket order book snapshots.

```sql
id              uuid PK
city_id         uuid FK
target_date     date
poly_event_slug text
poly_market_id  text
poly_token_id   text
bucket_label    text
best_bid        real
best_ask        real
last_trade      real
mid             real
volume_24h      real
spread          real
captured_at     timestamptz
```

### `bets`
Recommended and executed bets.

```sql
id              uuid PK
city_id         uuid FK
target_date     date
bucket_label    text
side            text       -- 'YES' | 'NO'
our_probability real
market_price    real
edge            real
ev_per_share    real
kelly_full      real
kelly_used      real       -- after fractional adjustment + caps
recommended_size_usd  real
executed_size_usd     real NULL
executed_price        real NULL
executed_at           timestamptz NULL
status          text       -- 'recommended' | 'open' | 'filled' | 'resolved_win' | 'resolved_lose' | 'skipped'
resolution_temp real NULL
pnl_usd         real NULL
notes           text
```

### `calibration_scores`
Rolling Brier scores and reliability per (city, lead, source, window).

```sql
city_id, source, lead_days, window_days,
brier_score, ece (expected calibration error),
reliability_buckets jsonb,    -- binned reliability diagram
sharpness real,                -- mean uncertainty of forecasts
n_forecasts int,
updated_at timestamptz
```

---

## 7. Forecast engine — producing distributions

Layered on top of v1's bias-correction infrastructure. The output type changes from a point estimate to a discrete distribution over the Polymarket bucket grid for that city's market.

1. Run v1's bias-corrected ensemble for the target date — gives N point forecasts (one per model and per correction variant).
2. Compute ensemble mean μ, but use **historical residual std-dev** σ_hist for the city × lead × season cluster as the spread, not the in-ensemble spread.
3. Build `P(T = b)` via the chosen distribution method (§3.1). Start with Gaussian, upgrade to KDE once you have ≥ 120 verified forecasts per (city, lead).
4. Store in `bucket_probabilities` with `source = 'house_ensemble'`.
5. Also store the market's implied distribution as `source = 'market_consensus'` — derived from current Polymarket prices, normalised to sum to 1.

---

## 8. Edge calculator

Runs whenever a new market snapshot arrives. For each open Polymarket market matching one of our cities:

1. Look up our latest `bucket_probabilities` for (city, target_date) with `source = 'house_ensemble'`.
2. Look up the latest `market_snapshots` per bucket.
3. For each bucket *b*:
   - Compute `edge = q_b − ask_b`.
   - Skip if `edge < min_edge_threshold` (default 0.08).
   - Skip if `volume_24h < min_volume` (default $5,000) — illiquid markets have unreliable prices.
   - Skip if `spread > max_spread` (default 0.05) — wide spreads imply slippage.
4. For remaining buckets, compute Kelly fraction, apply fractional Kelly (default k = 0.25), apply caps:
   - Per-trade cap: max 2% of bankroll
   - Per-city cap: max 5% of bankroll across all buckets for that city/date
   - Correlated cap: max 8% across geographically clustered cities (e.g. London + Paris on same date)
5. Write a row to `bets` with `status = 'recommended'`. Notify the dashboard / Telegram / whatever.

---

## 9. Calibration & validation

This is the most important section. Without ongoing calibration validation, the system silently turns into a money pump for the opposite direction.

### 9.1 Brier score

For a probabilistic prediction with bucket probabilities `q_1 ... q_K` and one-hot outcome `o_1 ... o_K`:

```
Brier = Σ (q_i − o_i)²
```

Lower is better. 0 is perfect. Random is ~0.5 / K. Track rolling 30-day Brier per (city, lead, source). The market's own prices form the benchmark — if our `house_ensemble` Brier doesn't beat `market_consensus` Brier on out-of-sample data, **we have no edge and must not bet**.

### 9.2 Expected Calibration Error (ECE)

Bin predictions by predicted probability (e.g. 10 bins from 0.0–1.0). In each bin compare mean predicted probability to empirical hit rate. ECE is the weighted average gap. < 0.05 is acceptable, < 0.02 is excellent.

### 9.3 Reliability diagrams

Plot predicted vs empirical probability for each bin. A well-calibrated forecaster lies on the y = x line. Underconfident → above, overconfident → below. Display per (city, lead) on the dashboard.

### 9.4 Hard rule: no betting without calibration evidence

A new forecast variant (new model, new correction method, new distribution scheme) must complete ≥ 60 days of *out-of-sample* paper trading and achieve Brier < market_consensus Brier by at least 5% before it's promoted to a live betting source. The champion/challenger framework from v1 applies but with Brier (not MAE) as the metric.

---

## 10. Risk management

| Layer | Rule |
|-------|------|
| Per-trade | ≤ 2% of bankroll, regardless of Kelly |
| Per-city per-day | ≤ 5% of bankroll across all buckets |
| Correlated cluster | ≤ 8% (e.g. London + Paris in same heatwave; Beijing + Shanghai) |
| Daily total exposure | ≤ 15% of bankroll |
| Consecutive-loss circuit breaker | Pause a (city, lead) signal after 8 consecutive losing trades |
| Drawdown stop | Halt all betting at 25% peak-to-trough bankroll drawdown; manual review |
| New-signal warm-up | New forecast source paper-trades 60+ days before live use |
| Withdrawal discipline | Sweep profits to off-platform wallet at fixed schedule (e.g. monthly) |

Don't override these limits in the heat of a "great opportunity." That's how good edges become bad bankrolls.

---

## 11. Polymarket integration specifics

### 11.1 Reading (no auth)
- `GET https://gamma-api.polymarket.com/events?tag_id=…` discovers markets.
- `GET https://gamma-api.polymarket.com/markets/slug/{slug}` fetches one market with `outcomes`, `outcomePrices`, `clobTokenIds`, `bestBid`, `bestAsk`, `volume24hr`.
- Polling cadence: 1–5 min on active markets is plenty for short-lead bets. WebSocket only if you start scalping intraday moves.

### 11.2 Trading (requires setup)
- Deposit wallet — Polymarket recommends this for new API users.
- USDC on Polygon as collateral.
- Derive API key from wallet via `GET /auth/derive-api-key` on the CLOB.
- Place limit orders only (no market orders on Polymarket). Use the SDK (`@polymarket/clob-client` for TypeScript, official Python SDK).
- Maker rebates if your order rests on the book — meaningful when scaling. Taker orders pay ~2% fee on temperature markets.
- Negative-risk markets: temperature buckets in a "winner-takes-all" group are usually negRisk — collateral efficiency matters. Read the negRisk docs.
- Geo: Polymarket is geoblocked in the US, Sweden is fine for trading on `polymarket.com`. KYC threshold varies; check current rules.

### 11.3 Slippage modelling
Don't compute EV using only `bestAsk`. Walk the order book: estimate fill price for the intended stake. The Gamma response includes `bestBid`/`bestAsk` but for depth you need CLOB `GET /book/{token_id}`. Practical heuristic for v1: only trade buckets where `volume_24h > $5k` and assume +0.5–1.0¢ slippage on top of `bestAsk`. Refine later.

### 11.4 Resolution risk
- UMA optimistic oracle — disputes possible. Rare on temperature but plan for it.
- Wunderground data revisions — markets ignore revisions, so should our paper-trade verification.
- Always reconcile our `bets` rows against actual on-chain settlements after each market resolves.

---

## 12. Frontend (Next.js)

### Pages
- `/` — bankroll, today's open positions, P&L sparklines, recommended bets queue.
- `/bets/[id]` — full detail: our distribution, market distribution, edge per bucket, Kelly math, history.
- `/city/[slug]` — accuracy heatmap (v1), live Polymarket market with our overlay, bet history for this city.
- `/calibration` — Brier trends, reliability diagrams, ECE per (city, lead). Champion/challenger log.
- `/admin` — manual bet entry, override caps (with audit), force retrain, halt switch.

### Key visual: edge view
A side-by-side bar chart per market: market price per bucket vs our probability per bucket. Edge highlighted on bars where it clears threshold. One screen tells you the whole opportunity.

### Approval flow
Phase A: every recommended bet shows a "Stake $X (Kelly says $Y)" confirm button. Manual. Phase B: auto-execute below per-trade cap, manual above. Phase C: fully automated within bankroll caps. Never skip Phase A.

---

## 13. Phased roadmap

### Phase 0 — Setup (1 evening)
- [ ] Supabase schema migrated from v1 + new tables
- [ ] Verify Polymarket markets exist for all 8 cities (some may be intermittent; document the airport station for each)
- [ ] Confirm Wunderground accessibility for each ICAO

### Phase 1 — Calibrated forecaster (2 weekends)
- [ ] Reuse v1 bias-correction pipeline
- [ ] Add Gaussian-distribution synthesis with empirical σ
- [ ] Backfill `bucket_probabilities` for the last 12 months
- [ ] Score against historical actuals → first Brier numbers per (city, lead)

### Phase 2 — Market integration (1 weekend)
- [ ] Gamma API poller for the 8 cities, every 5 min
- [ ] Store full bucket price ladder in `market_snapshots`
- [ ] Build `source = 'market_consensus'` distribution from prices
- [ ] Compare Brier of `house_ensemble` vs `market_consensus` historically

### Phase 3 — Paper trading (60+ days, non-negotiable)
- [ ] Edge calculator running on live markets
- [ ] All recommended bets logged to `bets` with `status = 'recommended'` only, no execution
- [ ] Track simulated P&L vs realised market resolutions
- [ ] After 60 days: if house Brier doesn't beat market Brier consistently, stop. Iterate forecast engine. Don't go live.

### Phase 4 — Live trading, small (after Phase 3 passes)
- [ ] Wallet setup, USDC funded
- [ ] CLOB client integrated
- [ ] Phase A manual-approval UI
- [ ] Per-trade cap = $20 regardless of Kelly. Hard ceiling for the first month.
- [ ] Run 30+ days. Reconcile every settlement.

### Phase 5 — Scale (after Phase 4 shows realised edge)
- [ ] Raise per-trade cap incrementally
- [ ] Phase B semi-auto
- [ ] Add KDE distribution method
- [ ] Order book depth modelling
- [ ] Maker order placement for fee rebates

### Phase 6 — Sustain
- [ ] Continuous calibration monitoring with alerts
- [ ] Champion/challenger across distribution methods
- [ ] Capacity testing — edge erodes with stake size; find the curve
- [ ] Diversify across more cities once 8 are saturated

---

## 14. Reality checks before scaling

**Edge erodes.** Other people read the same APIs and run the same ensembles. The 8% edge of today is the 4% edge of next year. Plan for shrinking returns.

**Variance is brutal.** Even a 65% bet loses 35% of the time. A 10-bet losing streak at 60% true probability happens roughly once per 1,000 streaks of length 10 — meaning in a year of daily trading it will absolutely happen to you. Bankroll size and Kelly fraction must accommodate this. The polymarketweather.com strategy notes recommend operating across 10–30 city/date combinations simultaneously for diversification, and treating profitability as a portfolio property visible only over hundreds of bets.

**Fees are not trivial.** A 2% taker fee on a 50¢ ask is 4% of your stake. If your average edge is 8%, fees eat half. Maker rebates matter — design toward resting orders once you have volume.

**Calibration drift is silent.** Models that worked great in Q1 may misfire in Q2 if a regime shifts (heatwave, monsoon onset, El Niño phase). The calibration dashboard is the early warning system. Look at it daily.

**Regulatory & tax.** Trading on Polymarket from Sweden: legal for individuals; gains are taxable as capital income (kapitalinkomst). Track every trade for Skatteverket. Polymarket is not licensed in Sweden — if rules change, the system needs a plan B (Kalshi, Manifold, etc., though their weather coverage is limited).

**Resolution station ≠ city centre.** The single most expensive mistake is forecasting the wrong location. Verify the station per market, per bet, every time. The strategy notes emphasise: coordinate mismatch is the #1 cause of unexpected losses in this category.

**This is gambling with statistical edge.** Treat it as such. Don't stake what you can't lose. Don't size up after wins or down after losses (except as the system rules say). Don't override the limits.

---

## 15. Math reference card

```
q_b   = our probability for bucket b
p_b   = market ask price for bucket b
edge  = q_b − p_b                           # additive, in probability points
EV/$  = (q_b − p_b) / p_b                   # for size scaling intuition
Kelly = (q_b − p_b) / (1 − p_b)             # full Kelly fraction
stake = min( k_kelly × Kelly × bankroll,
             per_trade_cap × bankroll )
trade if edge ≥ fee + slippage + margin     # default 0.08

Brier(forecast, outcome) = Σ (q_i − o_i)²   # one-hot outcome, lower is better
ECE = Σ |bin_predicted − bin_empirical| × bin_weight
```

If at any point you cannot derive your stake from these formulas using stored values, **don't place the trade**.

---

## 16. What changed vs v1 spec

| Area | v1 | v2 |
|---|---|---|
| Goal | Benchmark forecast providers | Profitable Polymarket betting |
| Output type | Point forecast (single °C) | Bucket probability distribution |
| Primary metric | MAE / RMSE | Brier score, ECE |
| Champion criterion | Lowest MAE per (city, lead) | Lowest Brier vs market consensus |
| Truth source | ERA5 (canonical) | Wunderground (canonical), ERA5 (secondary) |
| New components | — | Market snapshotter, edge calculator, position sizer, trade executor, calibration monitor, P&L tracker |
| Polymarket | Mentioned briefly | Core data source + sole trade venue |
| Risk management | — | Multi-layer caps, circuit breakers, drawdown stops |

The v1 bias-correction infrastructure remains the engine. v2 wraps it in the distribution layer, the market layer, and the trading layer.
