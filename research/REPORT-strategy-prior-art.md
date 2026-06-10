# Weather Edge — Prior Art, Market Mechanics & Operational Strategy Research Report

> Produced by web-research agent, 2026-06-10. Every claim carries a source URL and confidence tag [HIGH/MED/LOW]. Spec-contradiction flags marked **[SPEC FLAG]**.

## 1. POLYMARKETWEATHER.COM

**What it is:** A commercial product site selling access to "WeatherCaster," an automated Polymarket weather trading bot, with a substantive SEO blog (April 2026 posts). Not a community dashboard — a vendor. Claims are internally consistent and cross-check well against primary sources, but uncited figures are [MED] at best. https://polymarketweather.com/

**Product/engine parameters disclosed** [HIGH for "what the site says"]:
- 4-model ensemble: ECMWF IFS (weight 0.35), GEFS 31-member (0.25), UKMO (0.20), NWS hourly obs (0.20), all via free APIs (Open-Meteo, api.weather.gov, NOAA NCEI for 10-year base rates).
- Each deterministic forecast treated as Gaussian; σ scaled by horizon: 0.8°F at 6h → 5.5°F at 10 days; GEFS contributes member-vote fractions; blend Bayesian-adjusted with NCEI climatology; outliers >1.5σ from ensemble mean down-weighted 50%.
- Trade trigger: edge ≥ 8% AND z-score ≥ 1.5. Sizing: 15% fractional Kelly, capped at 5% of bankroll and $100/trade. Skip if spread > $0.03, market resolving < 2h, or > 20 open positions. Circuit breaker: halt at −10% daily P&L.
- Scan interval 2 min (WebSocket + REST). Gamma poll every 5 min.
- Self-calibration: per-city/per-horizon Brier tracking, weekly ensemble-weight refresh, soft-disable underperforming cities. **Target: Brier < 0.15 per city ("below 0.15 is where this strategy is profitable after fees and slippage"; 0.20 = skilled, 0.25 = random).**

**The two claims our spec references — both verified verbatim:**
1. **"Coordinate mismatch — pulling forecast data for the wrong station — is the single most common cause of unexpected losses in this category."** Also: "city-centre coordinates introduce 3–8°F error on 1–2°F bucket markets." [HIGH]
2. **"Top Polymarket weather traders operate across 10–30+ city/date combinations simultaneously."** Rationale: ~200 independent trades minimum for statistical confidence in an 8% edge. [HIGH]

**Station-mapping published on the site** [MED-HIGH, partially verified against live markets]: NY=KLGA (not JFK/Newark); Paris=LFPB (not CDG); London=EGLC or EGLL — verify per market; Tokyo=Haneda or Narita — verify per market; LA=LAX or KBUR — verify per market. Plus: "markets for the same city don't always resolve at the same station, and **Polymarket has occasionally changed the resolution station mid-cycle**" [MED, high-consequence — parse per-market rules, never per-city constants].

**Strategy blog highlights** [HIGH as site claims]:
- Four structural edges: (1) model-update lag — 30–60 min windows on majors in 2024, **compressed to 5–15 min in 2026; hours on secondary cities** (Buenos Aires, Cape Town, Atlanta); (2) airport-vs-city discrepancy (KLGA 3–5°F cooler than Midtown on sea-breeze days; LFPB 2–3°C cooler than Paris core under anticyclones); (3) calibration edge (ensemble spread + station bias correction + dispersion inflation); (4) behavioral (recency anchoring, favorite-longshot, news herding peaking 12–24h after models adjusted).
- Why 8% min edge: 2–4¢ spreads cost 1–2%; ensemble sampling error ≈ ±7–8pp at 95% CI on mid-probabilities; competition takes 3% edges first. **5% workable only with validated Brier ≤ 0.15.**
- Liquidity filter in their example: "**market has ≥ $10,000 in total volume**". **[SPEC FLAG: spec's $5k filter is looser; <$1k-volume markets show 5–10¢ spreads]**
- Stop rules: −5%/day, rolling 30-day Brier > 0.30, 8 consecutive losses per city/lead pair, 30% max drawdown.
- Paper-trade 30–60 days, 100+ positions, then go live at 10–20% size; reassess at 200–300 live trades.

**Bot blog** — architecture notes: 9-step core loop; WebSocket `wss://ws-subscriptions-clob.polymarket.com/ws/market`; EMOS/BMA post-processing "improves calibration 20–40% by Brier skill vs raw ensembles, needs 30–90 days history"; **station bias correction: `bias_t = α(forecast−observed) + (1−α)bias_{t−1}`, α=0.1–0.3, vs Wunderground-finalized highs**; raw-ensemble underdispersion fix: ×1.15 spread multiplier; Polymarket matching engine reportedly on **AWS eu-west-2 (London)** [MED, single source] — Sweden-based operator is latency-adjacent; dead-man switch: halt if APIs unreachable >15 min, daily loss >5%, rolling Brier >0.35.

## 2. TRADER WRITEUPS & OPERATIONAL LESSONS

### (a) Forecast sources sharps actually use
- **Europe:** ECMWF IFS dominant; "ECMWF 12 UTC primary is the highest-impact for European markets," available ~18:00–18:30 UTC; Hans323's documented latency-arb correlated London/Paris prices with ECMWF shifts. [HIGH] (polymarketweather blog; insurancejournal.com 2026-04-15)
- **US final-day:** HRRR hourly cycle "highest-impact for US final-day markets"; NBM/NAM for 24h calibration (2–3°F typical day-1 error). [HIGH]
- **Model-consensus rule (retail-sharp):** require 3+ models (GFS, ECMWF, ICON, CMC) to agree. [MED] (medium.com mountain-movers)
- **Asia:** PolyWeather (GitHub) blends Open-Meteo (GFS+ECMWF) with **JMA AMeDAS, KMA, HKO, plus METAR/TAF for final-24h** — "Asian market emphasis matching where Polymarket weather volume is concentrated." [MED-HIGH]
- **Delivery layer:** Open-Meteo free APIs are the de facto bot standard; direct GRIB from NOMADS/ECMWF only for true latency arb. [HIGH]
- **Proprietary tier:** Jua (Swiss AI-weather startup) trades max-temp contracts with own model; WindBorne staff trade with company models. [HIGH] (Insurance Journal)

### (b) Intraday dynamics — the market-day lifecycle
[HIGH for lifecycle as documented; MED that it generalizes]
- **5–7 days out:** market opens, wide/sparse. **2–4 days:** liquidity builds, algos position. **24–48h:** "market comes alive," short-range models dominate. **Final 12h: most of the volume and largest moves; real-time METARs from the resolution station now visible.** **After ~2pm local:** daily max at mid-latitude stations typically occurs 2–5pm local; losing buckets collapse — the "running max nowcast" regime.
- Nuance: **"Intra-day METAR observations during the day aren't sufficient — the market waits for the final daily record"** (WU finalization), so near-certain buckets still trade below $1 between physical lock-in and resolution. Counter-warning: "Chasing the final-hour spike — entering at $0.85 on a 90% bucket leaves almost no upside and meaningful downside on a boundary reading."
- No public fine-grained intraday dataset found — validate the running-max pattern empirically during paper trading. [MED]

### (c) Settlement gotchas
- **Resolution source confirmed from live markets:** Wunderground station history page, whole degrees, final at "first datapoint of the following date." **[SPEC CONFIRMED]**
- **Truncation, not rounding** (per polymarketweather): 23.4°C resolves to the 23°C bucket. [MED — single source; CONFLICTS with live WU verification showing 30.6°C displayed as 31°C (rounded). Resolve empirically: log both the tenths-METAR max and WU's displayed integer during paper phase; the WU displayed integer is what resolves.]
- **Units by region:** US whole-°F buckets (2°F wide); Europe/Asia 1°C buckets (≈1.8× wider in °F terms — changes per-bucket distribution mass). [HIGH]
- **WU vs NWS CLI divergence:** WU uses only hourly METARs + SPECIs, missing 6-hour highs and 1-min data → NWS CLI occasionally 1°F+ higher. "Even a 1°F difference can flip a contract." DST: WU uses local clock midnight–midnight year-round. Polymarket settles on WU → build ground truth from WU's hourly METAR view. [HIGH] (wethr.net/market-resolution)
- **Station swaps:** same-city markets resolve at different stations across time; parse each market's description. [MED-HIGH]
- **Oracle:** UMA Optimistic Oracle; 2025 "MOOV2" migration restricted proposals to ~37 vetted addresses, reducing griefing. Temperature markets almost never disputed; close→payout typically fast. [MED]

### (d) Liquidity & microstructure observed
- **Live datapoint (mid-day 2026-06-10): London daily-high event = $65,094 volume, $37,100 liquidity; per-bucket volumes $253–$12,066** (modal buckets ~$5–12k). [HIGH]
- Aggregates: ~20 active daily city markets at a time historically; weather ≈ small % of platform volume; one guide claims "$300–400k single-market days" — inconsistent with live data; treat as outliers. [LOW-MED]
- Spreads: 2–4¢ liquid, 5–10¢ when volume <$1k; highest-volume cities: NYC, London, Shanghai, Tokyo. [MED-HIGH]
- Capacity: Jua CEO says volume "still too low" for a fund; inferred practical capacity ≈ $500k–$2M/yr profit before liquidity binds. [LOW-MED]
- Maker vs taker: makers pay zero fees, earn 20–25% taker-fee rebates + separate liquidity-rewards program. NegRisk enables laddering and occasional sum-of-YES < $1.00 arb on thin internationals. [HIGH]

### (e) Competition — who's on the other side
Weather leaderboard (early 2026, cumulative net P&L) [MED-HIGH]:
gopfan2 $343k+ · aenews2 $277k+ · ColdMath $120k+ · gopfan $118k+ · bama124 $87k+ · Hans323 $81k+ · Handsanitizer23 $71k+ · automatedAItradingbot $65k+ · WeatherTraderBot $57k+; dozens more at $10–50k.
- **ColdMath**: algorithmic barbell — many small tail buys (5–15¢) + occasional central-bucket conviction; $50–150/bucket; concentrated in low-bot-saturation cities (Buenos Aires, Cape Town, Dallas, Atlanta). [MED]
- **gopfan2**: "buy YES < $0.15, buy NO > $0.45, ~$1/position, repeat 10,000+ times" — reverse favorite-longshot harvesting. [MED]
- **Hans323**: German law student; semi-manual ECMWF/GFS release latency arb with pre-staged orders, London/Paris focus. [HIGH] (Insurance Journal 2026-04-15)
- **Institutional:** Jua; WindBorne staff; Atte/"1-800-LIQUIDITY" (Finnish dev, ~$33k since Oct 2025). [HIGH]
- Copy-trade flow adds reflexivity: official COPYCAT feature; PolyCop Telegram mirror. [MED]
- **Correction: "gabagool" is NOT a weather trader** — gabagool22 is a 15-min crypto-arb bot. Weather sharps to study: ColdMath, gopfan2, Hans323, aenews2. [HIGH]

## 3. POLYMARKET FEES & MICROSTRUCTURE (as of 2026-06-10)

**Headline: the 0%-fee era is over. Taker fees went live on nearly all categories March 30, 2026, including Weather.** [HIGH — official docs + 3 news sources]
- Timeline: piloted on 15-min crypto; **March 30, 2026** comprehensive rollout; **March 31, 2026** emergency fix switching to **share-based** calculation after absurd fees on low-priced shares "particularly weather and economics."
- **Formula (official):** `fee = shares × price × feeRate × (price × (1 − price))^exponent / price` → operative per-share form: `fee = shares × feeRate × p × (1−p)`, exponent 1; peaks at 50¢, decays quadratically toward extremes, symmetric.
- **Weather feeRate = 0.05 → peak effective taker fee ≈ 1.25% of premium at p=0.50**, ≈0.45% at p=0.10/0.90, ≈0.24% at p=0.05. **[SPEC FLAG — FAVORABLE: spec's flat ~2% taker fee is wrong in shape and too high. Spread (2–4¢) dominates fees as the real transaction cost. Min-edge must be a function of price.]**
- **Sell orders: no taker fees** per Help Center [MED — verify in API before coding]. Min fee 0.0001 pUSD.
- **Maker rebates:** makers pay nothing, receive **20–25% of collected taker fees** daily. [HIGH]
- **Liquidity rewards program** (separate): daily payouts to resting orders within max spread (typically 3¢ of midpoint; both sides if midpoint <$0.10), min size per market. Resting limit entries can be reward-eligible. [HIGH]
- **Tick size:** 0.01 standard; **0.001 when price >0.96 or <0.04** (per-market metadata exposes current tick; stale caches cause "invalid price" bugs). Min order ~5 shares. [HIGH for tick regime]
- **Gas:** CLOB orders are off-chain EIP-712 — effectively gasless; Polygon settlement <$0.01, often relayer-subsidized. [HIGH]
- Fees pushed Polymarket past $1M/day revenue — likely permanent, may be tuned; **re-verify weather feeRate at build time and before go-live.** [HIGH]

## 4. SWEDEN / EU LEGAL & ACCESS STATUS (June 2026)

- **Sweden: accessible.** Consistently absent from Polymarket's restriction list; no Spelinspektionen enforcement; "the question has not been legally tested." No Swedish licence → no consumer protection. Net: **legal grey zone, no user-level prohibition.** [MED-HIGH]
- **EU enforcement country-by-country:** actions in France, Belgium, Netherlands, Portugal (+ Poland, Hungary, Romania per one tracker); Spain ordered blocks May 2026; UK restricted. Lists rot quickly. [MED]
- **MiCA — live risk: transitional period ends July 1, 2026.** Commentary warns the deadline "could force crypto-native platforms to geo-block EU users entirely." **Treat "Polymarket geo-blocks Sweden in H2 2026" as a material scenario; paper trading (public data only) is unaffected.** [MED]
- **KYC (2026):** none for non-US users on core platform; AML triggers on large/rapid flows; KYC at fiat on-ramp. Direction of travel: more verification. [MED-HIGH]
- **US re-entry context:** QCEX acquisition, CFTC approval Nov 2025, US relaunch Dec 2025 on a separate regulated platform; international polymarket.com unchanged for now. [HIGH]
- **Swedish tax (flag for accountant):** NOT tax-free gambling wins (no EEA licence → spelvinst exemption inapplicable); USDC/positions = "övriga tillgångar" (kap. 52 IL) → **30% kapitalvinstskatt**, K4 section D, genomsnittsmetoden for the USDC pool, every close = disposal; only 70% of losses deductible; systematic high-frequency trading could be reclassified as näringsverksamhet; DAC8/CARF reporting from 2026. [MED — accountant must confirm]

## 5. GITHUB PRIOR ART

| Repo | Stars | Lang | Pushed | Notes |
|---|---|---|---|---|
| suislanchez/polymarket-kalshi-weather-bot | 432 | Python | 2026-03 | Cross-platform Kalshi+Polymarket; GEFS member counting; 0.15 Kelly; React dashboard. Borrow: cross-platform edge comparison, calibration loop. |
| alteregoeth-ai/weatherbot | 324 | Python | 2026-03 | Kelly + EV filter + **paper mode**; explicit station coordinates. Borrow: paper-trading mode design. |
| GuillermoEguilaz/Polymarket-Weather-Bot | 240 | TS | 2026-04 | TS bot system (less documented). |
| yangyuan-zhen/PolyWeather | 110 | Python | **2026-06-10 (active)** | Most complete forecast stack: METAR/TAF + Open-Meteo + JMA AMeDAS/KMA/HKO; station-level bias suppression; Asia emphasis. Borrow: Asian station mappings, TAF integration. |
| RiekertQuant/polymarket-weather-bot-poc | 21 | Python | 2026-06-10 | Paper-trading POC, active. |
| MihirM9/polymarket-weather-bot | n/a | Python | 2026-05 | NWS/OWM ensemble, Gaussian bucket probs, "9-layer risk controls" — useful risk checklist. |

**SDKs:** @polymarket/clob-client (TS) **v5.8.1**, actively maintained [HIGH]. py-clob-client v0.34.6 active. Polymarket/agents repo (3.6k stars) **ARCHIVED** — patterns only. New unified TS+Python SDK in beta. Typed community Gamma clients: 0xJord4n/polymarket-gamma, HuakunShen/polymarket-kit.
Gamma quirk: `events?tag_slug=weather` misses daily temperature events — use numeric tag_id (verified: 104596). [HIGH]

## 6. FORECASTING METHODS (practical literature)

**(a) EMOS/NGR — the standard.** Gneiting et al. 2005 (MWR 133:1098): Gaussian predictive distribution, μ = a₀+a₁x̄ (affine in ensemble mean or member-wise weights), σ from spread (σ² = b+c·s²), fitted by **minimum-CRPS** on a **rolling window — 30 days canonical** (studies range 25–110), **per-station, per-lead**. **[SPEC CONFIRMED: rolling window per-station per-lead is standard practice.]** [HIGH] Practitioner: EMOS/BMA improves Brier skill 20–40% over raw ensembles; needs 30–90 days history; decaying-average bias α=0.1–0.3. [MED]

**(b) Alternatives:** QRF, EMOS-GB, distributional forests, NGBoost, neural distributional regression (Rasp & Lerch 2018) — minor gains over EMOS given long histories; MOS random forests "always at least as good as EMOS, more robust." Isotonic regression = standard distribution-free recalibration layer. **Practical: EMOS first; ML variants after months of history.** [HIGH]

**(c) Realistic skill:** ForecastWatch: US day-1 high-temp forecasts average <±3°F (≈1.7°C) error; only ~15.7% "perfect" (<1°F); coastal/marine-moderated stations best. Rule of thumb σ: 2–3°F at 24h, 3–4°F at 48h, 4–6°F at 72h. **Spec's 1.2–1.8°C day-1 MAE plausible at well-behaved airports but optimistic globally — budget 1.5–2.0°C.** [MED] Market-consensus Brier for weather specifically: not published; practitioner benchmark **own Brier <0.15/city = profitable after fees/slippage.** [MED]

**(d) Kelly for simultaneous mutually-exclusive buckets (negRisk):** naive per-bucket Kelly is wrong (ignores cross-hedging, over-allocates). Correct: maximize E[log wealth] jointly — convex; optimum can include negative-individual-EV hedges (Whelan, karlwhelan.com/Papers/BER.pdf). Closed-form treatment (arXiv 2603.13581, Mar 2026): with our probs p_i and state prices q_i, cash acts as implicit stake on every outcome; **sort by p_i/q_i, include outcomes with p_i/q_i > c via one-pass greedy, bet x_i = (p_i − c·q_i)₊** where c solves the budget identity. Then scale by Kelly fraction. [HIGH]

**(e) NWS NBM as free US baseline:** calibrated multi-model blend, hourly cycles to 264h; per-station MaxT via **NBM text products (NBH/NBS/NBE) at weather.gov/mdl/nbm_text**, bulk via NOMADS/AWS (registry.opendata.aws/noaa-nbm). api.weather.gov = NBM-informed official forecast, free, no key. [HIGH]

## 7. SCHEDULING / INFRA (2026 limits)

- **Vercel cron (Hobby):** up to 100 crons/project BUT **once-per-day granularity only** — */5 expressions fail deployment; invocation timing best-effort. **Cannot do 5-minute polling on Hobby.** Pro = 1-min frequency + function-duration costs. [HIGH]
- **Supabase pg_cron + Edge Functions (free tier):** pg_cron minute-level (sub-minute in newer versions) at no extra cost; blessed pattern = pg_cron + pg_net invoking Edge Functions. Limits: **500k invocations/mo free; 150s wall-clock max (Free), 2s CPU time, 256MB; pg_net default ~5s request timeout** (fire-and-forget; don't await long work from the cron call). 5-min poller ≈ 8,640 invocations/mo — trivially fine. **Best free fit.** [HIGH]
- **GitHub Actions schedules:** min 5-min interval, **best-effort with routine multi-minute delays, dropped runs under load, disabled after 60 days repo inactivity** — acceptable for non-critical dailies, not the primary poller. [HIGH]
- Competitive bots colocate near the matching engine, reportedly AWS eu-west-2 (London) [MED] — a Sweden/EU node is latency-adjacent.

## SPEC CONTRADICTION / REVISION SUMMARY

1. **~2% flat taker fee → REVISE (favorable):** dynamic `0.05·p·(1−p)` per share, taker-only, 0% maker + rebates; spread dominates. Min-edge becomes price-dependent.
2. **$5k min-volume filter → tighten/justify:** reference example uses ≥$10k event volume; prefer per-bucket book-depth checks.
3. **8-city hardcoded list → dynamic:** 49 cities live June 2026; roster rotates without announcement; discover via Gamma tag_id=104596.
4. **Wunderground resolution → CONFIRMED** + gotchas: WU-vs-CLI divergence, per-market station variation incl. mid-cycle changes, whole-degree display semantics.
5. **"Coordinate mismatch #1 loss cause" and "10–30 combos" → verified verbatim.**
6. **New risk: MiCA transitional period ends 2026-07-01** — material EU geo-block scenario; paper phase immune.
7. **"gabagool" correction** — study ColdMath, gopfan2, Hans323 instead.
8. **Kelly: joint multinomial optimization per negRisk event** (greedy state-price algorithm), not naive per-bucket.
