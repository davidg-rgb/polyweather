# WALLET-RECON-HANDOFF — Polymarket sharp weather wallet "badatmath."

> **Build hand-off, authored 2026-06-22.** Investigation of an external Polymarket wallet that
> trades Polyweather's *exact* universe (daily-Tmax bucket markets, ~45 global airport cities) and
> went from flat to **+$25.4k realized** with a sharp regime change in mid-May 2026. This doc is the
> next-session execution package: the verified findings, the data/API reference, and three
> implementation-grade builds. **Posture (updated 2026-06-22): the dormant live rail is now an in-scope
> but kill-criterion-GATED end-state** — the order machinery is wired toward activation, but the switch
> only flips if Build #2 proves the edge is real (not survivorship) **AND** Build #3 clears its
> pre-registered kill-criterion **AND** a new day-before-edge gate condition goes green. Nothing here
> lowers the WO-5 bar; it builds the gated path to *act if the edge proves out*. **Finalized product goal
> + the synchronized multi-agent workflow: §9.**

Wallet: `0x8fbd7cf5f806f563080864694415829f7229a959` · handle **"badatmath."** · Polygon proxy wallet.
All data below is from Polymarket's **public, unauthenticated** APIs (recipe in §5). Reproducible.

> **✅ RESOLVED 2026-06-22 — the synchronized §9 workflow ran to completion (branch b).**
> **KILL-GATE 1 = PASS-on-substance** (the badatmath edge is REAL, not survivorship). **KILL-GATE 2 = FAIL —
> the day-before bucket market is EFFICIENT** w.r.t. our EMOS forecast; the live rail stays **DORMANT**. The
> clean day-before-efficiency measurement IS the analytics deliverable. Full record, the numbers, and
> corrections to three premises that turned out stale (the "twice-daily cron", the ±2% reconciliation, the
> "May 14–21" regime week): **§10 (OUTCOME)** at the bottom. §1–§9 below are preserved as authored (pre-run).
>
> **✅ ALSO RESOLVED 2026-06-22 — the COPY-TRADE (fill-mirror) path is CLOSED too (§11).** The last
> replication angle — *mirror badatmath's revealed fills* — was measured for the first time: a taker-follower
> loses (edge **−6.05pp** vs the sharp's +1.34pp; robust to lag/staleness/price-cut). badatmath's edge is a
> **maker** edge (it rests cheap bids ~7pp below the ask; no post-fill drift to ride) and is structurally
> **non-followable**. All three angles are now falsified; the rail stays DORMANT. Full record + the
> reverse-engineered protocol spec: **§11 (bottom)**.

---

## 0. TL;DR

1. **You *can* see everything.** Per-wallet positions, every trade, the full cumulative realized-PnL
   curve, and a `WEATHER` leaderboard are all public and keyless. Recipe in §5.
2. **The wallet is verifiably profitable, and it's a peer on our exact markets.** $25,407 lifetime
   realized PnL (matches the public profile), **#1 on the WEATHER leaderboard this month**, ~$1.45M
   lifetime volume.
3. **There was a real regime change ~May 14–21** (your "around May 20" was right): flat-to-losing for
   4 months (trough **−$625** May 2) → vertical from mid-May (+$1k→+8.6k/week into late June). Not luck;
   not a snapshot artifact.
4. **The edge is *calibration + timing*, not a data secret.** The money is made buying the
   eventually-correct bucket **cheap (<0.25) the day before**, globally, at huge volume. The
   high-probability "No" bets are the *bleed*. My earlier US-mesoscale guess is **not** supported by the
   data — winners are global (KL, Shenzhen, London, Taipei, Paris, Tokyo…), US share is flat ~20%.
5. **Do NOT copy-trade it** (structurally late follower in thin books). **Do** use it as (a) a free
   independent forecast benchmark and (b) a probe of one open question our R&D never tested: *is the
   day-before bucket market beatable with a calibrated next-day forecast?*
6. **The live rail is built, dormant, and now an in-scope GATED end-state.** The order-placement
   machinery (`LiveExecutor`, CLOB L1→L2 auth, `execute-bet` chokepoint, `goLiveGate`, cap ladder) already
   exists and is mock-tested — **going live is gated on a proven edge + a new gate condition, not on
   integration work.** The **live-readiness preflight** (`scripts/check-live-readiness.ts`) ships this
   session and already runs live. Lane spec: **Build #4 (§6)**; finalized goal + workflow: **§9**.

---

## 1. Identity & verified performance

| Metric | Value | Source |
|---|---|---|
| Handle | **badatmath.** | leaderboard / profile |
| Lifetime realized PnL | **$25,407** | `user-pnl-api` (final cum point) |
| WEATHER leaderboard — this month | **rank #1**, PnL $22,806, vol **$1,187,275** | `/v1/leaderboard?category=WEATHER&timePeriod=MONTH` |
| WEATHER leaderboard — all-time | rank #45, PnL $25,930, vol **$1,450,178** | `…&timePeriod=ALL` |
| ROI on volume | **~1.8%** (thin-margin, high-volume grinder) | derived |
| Universe | 100% daily-Tmax bucket markets, ~45 global airport cities | `/activity` (100% weather) |
| Per-trade stake | small & stable, ~$1.3–3.3 median USDC | `/activity` |
| Volume concentration | **~$1.19M of $1.45M lifetime volume is the last month** | leaderboard |

The headline: **94%+ of the lifetime edge was earned in the last ~5 weeks.** Everything before mid-May
was noise around zero.

---

## 2. Forensic timeline — the regime change

### 2a. Cumulative realized-PnL curve (`user-pnl-api`, daily)

```
week-ending   cumPnL      Δ week
2026-01-17   $   -26        -26     ── flat/losing for ~4 months
2026-01-31   $   105       +132
2026-02-21   $  -303       -301
2026-03-14   $  -490       -153
2026-03-21 … 2026-04-18  frozen at -$490  ← DORMANT (no trading ~5 weeks)
2026-04-25   $  -612       -122     ← daily-temp markets re-enter (see 2b)
2026-05-02   $  -625        -13     ← trough
2026-05-09   $  -425       +200     ┐
2026-05-16   $   135       +559     │  INFLECTION (week of May 14–21)
2026-05-23   $ 1,146     +1,012     │
2026-05-30   $ 2,531     +1,385     │
2026-06-06   $ 5,329     +2,798     ├─ vertical
2026-06-13   $11,216     +5,887     │
2026-06-20   $16,848     +5,632     │
2026-06-21   $25,407     +8,558     ┘
```

First day cumulative PnL crosses: **$500 → May 21**, $1k → May 23, $2.5k → May 26, $5k → Jun 6,
$10k → Jun 13, $15k → Jun 18, $20k → Jun 21. Biggest single days: **Jun 18 +$5,590**, Jun 21
+$5,137 & +$3,421, Jun 13 +$1,862, Jun 5 +$1,560.

### 2b. Weekly behavior (what changed)

Sampled ≤4,000 trades/week from `/activity` (US-share, price, side, lead-time, city count):

```
wk-start   $/trd  medPx  %No %Yes  %US cities  notes
Jan–Mar      ~2    0.30–0.52   —    —     —    0     OLD market format (not the °C-bucket structure; unparsed)
2026-04-21  4.17   0.61   95%   4%  19%   46    daily-°C-bucket format APPEARS (category launch)
2026-04-28  0.08   0.01   19%  80%  27%   47    tuning week — ultra-cheap longshot probing
2026-05-05  2.25   0.32   53%  46%  22%   47    ┐
2026-05-12  1.60   0.18   36%  63%  17%   47    │  No → Yes drift begins
2026-05-19  1.77   0.15   29%  70%  21%   46    │  (= the inflection week)
2026-06-02  1.28   0.12   22%  77%  22%   44    │
2026-06-16  1.69   0.18   17%  82%  16%   45    ┘  settles ~80% Yes / cheap longshots
```

**Reads:**
- The °C-bucket markets only entered its book **~Apr 21** — Polymarket launched per-city
  `…-daily-weather` series around April; individual bucket markets are `negRisk`, **created ~2 days
  before resolution** (verified via Gamma: Amsterdam Jun-21 market `createdAt 2026-06-19`).
- After a **mid-Mar→mid-Apr dormancy**, the bot re-engaged on the new markets, **tuned for ~3–4 weeks**
  (slightly negative), then ignited mid-May.
- The one durable behavioral drift across the inflection is **No-heavy → Yes-heavy** (49% No → 80%+
  Yes). US share did **not** jump — so "added US cities" is *not* the cause.

---

## 3. The edge mechanism — where the money actually is

Realized-PnL attribution over the **top-50 settled winners** (`/closed-positions`, sorted by realized
PnL; see caveat):

**By entry price — the decisive cut:**

| Entry price bucket | # winners | realized PnL | staked | ROI |
|---|---|---|---|---|
| **[0.00, 0.10)** | 26 | **$7,453** | $13,081 | 57% |
| **[0.10, 0.25)** | 24 | **$5,130** | $8,658 | 59% |
| [0.25, 0.75) (the "No" bets) | **0** | **$0** | — | — |

> **100% of the profit came from cheap longshots (<0.25). Zero from the 0.45–0.75 "No" spray.**
> The "No" bets are the bleed; the cheap "Yes" on the eventually-correct bucket is the engine. That is
> exactly why the bot drifted from No-heavy to Yes-heavy — it learned where its edge lives.

**By geography — it's global, not US:**

| Group | # | realized PnL | ROI |
|---|---|---|---|
| Non-US / international | 40 | **$10,391** | 57% |
| US | 10 | $2,192 | 63% |

Top winner cities: Kuala Lumpur $1,078, Shenzhen $995, London $875, Taipei $819, Paris $740,
Tokyo $635, Guangzhou $621, Dallas $570, Beijing $525, Houston $488, Ankara $482, Seoul $471,
San Francisco $430, Munich $427.

**Caveat (important):** `/closed-positions` returned only the **top 50** rows (DESC by PnL) → these are
*winners only*, so the 100% win-rate here is selection bias, not a real hit-rate. The authoritative
**lifetime** realized PnL is $25,407 (`user-pnl-api`); true win-rate/ROI-net-of-losers needs the full
fill-and-redemption reconstruction in **Build #2**. The *shape* (profit concentrated in <0.25 entries,
spread globally) is robust regardless.

**Best-supported interpretation of the edge:** a **superior, well-calibrated next-day bucket
probability**, expressed by buying the modal/likely bucket **cheap and early (day-before / day-of)**
before the short-lived day-before market converges — deployed across ~45 cities at very high volume so
a thin per-bet edge compounds. It is **not** a US-data or single-model secret.

---

## 4. What this means for Polyweather (honest read)

- **It does not reopen trading.** WO-5 found the market efficient w.r.t. our signals at/near
  resolution. badatmath's ~1.8% ROI-on-volume, global-grind profile is consistent with a *small* edge
  on the **day-before** market harvested at scale — not a fat mispricing we could take as a slow follower.
- **It hands us a concrete, untested question.** Our Amsterdam sim tests **same-day** entry; badatmath
  makes its money the **day before**. Is the day-before bucket market (thinner, created ~2 days out)
  beatable with our EMOS-calibrated forecast? Our own `FORECASTING-RD.md` left "better inputs / a regime
  we haven't tested" as the one open lever — this is a clean instance of it. **Build #3** tests it with
  a kill-criterion, on data we already have.
- **It is a free, independent benchmark on our exact universe** — the highest-alignment use. **Build #1.**
- **US-mesoscale (HRRR/NBM) is demoted** from "their secret" to "a secondary input lever still worth a
  harness A/B" — the data says their edge is global calibration, not US data. Test it inside Build #3,
  don't headline it.

---

## 5. Data & API reference (verified, reproducible)

All keyless. Rate limits: **1000 req/10s** general, 200/10s `/trades`, 150/10s `/positions`
(Cloudflare, 429 on breach). Pass the proxy wallet as `user`.

| What | Call |
|---|---|
| Portfolio value | `GET data-api.polymarket.com/value?user=<addr>` |
| Open positions | `GET …/positions?user=<addr>&sizeThreshold=0&limit=500&sortBy=CURRENT` (page `offset`) |
| Settled positions | `GET …/closed-positions?user=<addr>&limit=500&sortBy=REALIZEDPNL&sortDirection=DESC` (⚠ caps ~50) |
| Every trade (the buying pattern) | `GET …/activity?user=<addr>&type=TRADE&start=<unix>&end=<unix>&limit=500&offset=…&sortBy=TIMESTAMP&sortDirection=ASC` |
| **Cumulative realized-PnL curve** | `GET user-pnl-api.polymarket.com/user-pnl?user_address=<addr>&interval=all&fidelity=1d` → `[{t,p}]` |
| **WEATHER leaderboard** | `GET data-api.polymarket.com/v1/leaderboard?category=WEATHER&timePeriod=MONTH&orderBy=PNL&limit=50` |
| Market metadata | `GET gamma-api.polymarket.com/markets?slug=…` or `?condition_ids=…` → outcomes, clobTokenIds, negRisk, endDate, createdAt, bestBid/Ask |
| Real-time trades (wallet-blind) | `wss://ws-subscriptions-clob.polymarket.com/ws/market` — no per-wallet push; correlate ticks to `/activity` poll |

**To page full activity past the offset cap:** window by time with `start`/`end` (unix seconds) and
page `offset` within each window. The forensic scripts that produced §2–§3 are simple Python over these
endpoints (urllib + json); re-runnable from `scripts/research/` if persisted.

⚠ `user-pnl-api` and `/v1/leaderboard` are **not in the core docs** (feasibility/stability assessed in §7).

---

## 6. Build specs

All three were authored against the live codebase (real migration numbers, file paths, function
names). **Recommended order: #1 → #2 → #3.** Two reconciliation notes before you start:
- **Migration numbers:** latest applied is `0048`. Build #1 takes **`0049`**; Build #2's persistence
  takes **`0050`** (don't collide).
- **Shared wallet client:** Build #1 (edge-function side, Deno) wants `supabase/functions/_shared/polymarket-wallet.ts`;
  Build #2 (scripts/core side, Node) wants `packages/io/src/polymarket-wallet.ts`. Write the **pure
  parsers once** and copy across the Deno/Node seam (the repo already does this for shared logic) — keep
  one canonical parser, two thin fetch wrappers.

> **✅ BUILD #1 BUILT & TESTED (2026-06-22) — deploy operator-gated.** Migration `0049_sharp_wallet_tracker.sql`
> (3 tables + 2 record RPCs + additive `dash_amsterdam_sim.sharps` + daily cron `sharp-wallet-track`), pure
> parsers/fetch wrappers `supabase/functions/_shared/polymarket-wallet.ts` (field names fixture-verified live —
> `size` not `shares`; leaderboard is `proxyWallet/userName/vol/pnl/rank`-string, NOT `address/label/pnl_usd`),
> Edge `sharp-wallet-track`, manual twin `scripts/sharp-wallets.ts`, loader `SharpsView` + web card
> `SharpDisagreement.tsx`. **871 tests green** (+21), typecheck 0, web build OK. `market_buckets.condition_id`
> confirmed present → direct position→ladder join. **DEPLOY:** `apply_migration 0049` → `deploy_edge_function
> sharp-wallet-track` → first 16:00 UTC cron (or `pnpm tsx scripts/sharp-wallets.ts --leaderboard` to seed now).
> Both blocked this session by the prod-access classifier (needs operator approval); no new secrets required.

### Build #1 — Sharp-wallet & WEATHER-leaderboard benchmark tracker *(ships now; pure analytics)*

Ingest `badatmath.` + top-N WEATHER-leaderboard wallets daily; surface them as an **independent third
forecaster** on `/amsterdam`. Signal = **disagreement** (their bucket vs our forecast vs market mid).

**Migration `0049_sharp_wallet_tracker.sql`** (style mirrors `0039`: snake_case, `set_updated_at`
trigger, RLS `operator_read`, grants to anon/authenticated/service_role). Three tables:
- `tracked_wallets(address pk, label, source check('leaderboard'|'manual'), enabled, notes, …)` — seed `0x8fbd…a959` / `badatmath.`
- `wallet_leaderboard_snapshots(captured_at, time_period, rank, address, label, pnl_usd, volume_usd, unique(captured_at,time_period,rank))`
- `wallet_positions_daily(as_of_date, address fk, condition_id, event_id fk→market_events, city_slug, target_date, bucket_idx, outcome, size_shares, avg_price, cur_value_usd, unique(as_of_date,address,condition_id,outcome))` + index on `(city_slug,target_date)`

**io client** `supabase/functions/_shared/polymarket-wallet.ts` (follows the `knmi.ts` idiom: pure
parsers + thin `FetchJsonLike` wrappers): `parsePositions/parseLeaderboard/parseUserPnl` (pure, `[]` on
junk) + `fetchWalletPositions` (`/positions?sizeThreshold=0.1&limit=500`), `fetchWeatherLeaderboard`
(`/v1/leaderboard?category=WEATHER&timePeriod=MONTH&orderBy=PNL`), `fetchUserPnl`
(`user-pnl?interval=all&fidelity=1d`).

**Scrape** `scripts/sharp-wallets.ts` (manual twin, mirrors `amsterdam-truth-backfill.ts`, `--backfill-pnl`
flag) + Edge Function `sharp-wallet-track` on pg_cron `0 16 * * *` UTC (the `0039` `net.http_post`/vault
`cron_secret`/`runJob` pattern). All writes upsert / `on conflict do nothing` (idempotent). City/target
parsing reuses `parseGammaEvent`/`targetDateFromEvent` in `packages/core/src/polymarket/gamma.ts`;
`condition_id → bucket_idx` via `market_buckets`.

**Surface:** extend the `dash_amsterdam_sim` RPC with a `sharps` key (recreate fn in `0049`, append
key — additive). Join `wallet_positions_daily(city='amsterdam',target_date)` → `market_buckets` → our
forecast (`bucket_probabilities source='house_ensemble'`, latest, argmax) → market mid
(`market_snapshots` latest `(best_bid+best_ask)/2`). Emit `sharpBucket`/`ourBucket`/`marketBucket`,
a 3-way `disagreement` count, and signed `sharpBucket−ourBucket` °C. New web card
`components/SharpDisagreement.tsx` in the `/amsterdam` bento ("What the #1 weather sharp is betting").

**First slice:** migration `0049` + the `_shared` module **with pure-parser tests** + `scripts/sharp-wallets.ts`
writing Amsterdam-only positions for the seeded wallet. No cron/web yet — proves the data path live.
**AC:** `pnpm typecheck && pnpm test` green; parser tests cover empty/malformed payloads; cron writes
idempotent; `dash_amsterdam_sim().sharps` returns the 3-way row; graceful empty state (existing `hasBets` pattern).
**⚠ Flag:** no wallet-API fixture exists in-repo — **drop one live `/positions` response into
`packages/io/test/fixtures/` and verify exact field names** (`size` vs `shares`, `slug` presence) before
finalizing the parser; confirm `market_buckets` has a `condition_id` column (`0004_markets.sql`) for the
direct join, else map via `bucket_probabilities`→`market_events`.

### Build #2 — Wallet-intelligence / realized-PnL ledger *(the skill-vs-survivorship gate)*

For **any** wallet: reconstruct true performance from public data — cumulative/daily realized-PnL,
ROI-on-volume, win-rate (Wilson CI), realized-PnL attribution (city / entry-price bucket / US-vs-intl),
a **regime-change detector**, and **calibration scoring** of revealed bucket bets.

**Inputs:** `/activity` (paged on `offset`) is the reconstruction spine — `TRADE` + `REDEEM` events;
**do not** rely on `/closed-positions` for totals (caps ~50). Cross-check the reconstructed total against
`user-pnl-api` (the ground-truth curve). Batch market metadata via `gamma /markets?condition_ids=…`.

**Module split:** impure fetchers in `packages/io/src/polymarket-wallet.ts`
(`fetchUserPnlSeries/fetchActivity/fetchPositions/fetchWeatherLeaderboard/resolveMarketsMeta`, all via
`fetchJson`); pure analytics in `packages/core/src/sim/wallet-forensics.ts`:
- `reconstructRealizedPnl(fills)` — FIFO per `(conditionId,outcome)`, TRADE+REDEEM → realized P&L, volume, win/loss
- `dailyPnlCurve`, `roiByBucket` (the `<0.25 / 0.45–0.75` cuts), `attribution` (city→country→region), `brierVsOutcomes`
- `regimeChange(series)` — **PELT-lite**: scan breakpoints, fit two OLS slopes, flag where post-slope flips sign or >2× pre (this is the mid-May badatmath inflection). Deterministic, no deps.

**Reuse, don't reimplement:** `brierScore/reliabilityBins/expectedCalibrationError/pairedBootstrapPValue/mulberry32`
from `calibration/scores.ts`; `wilsonInterval/armEdgeStats/GradedBet` from `sim/stats.ts` (a wallet's
realized bets *are* `{won, ask=entryPrice}` — feed them straight in).

**Calibration method:** each revealed buy → implied prob = entry price; truth = did that bucket resolve
(from the wallet's own `REDEEM`, or for Amsterdam join `amsterdam_truth.actual_decimal_c` via
`floorTruthHit` in `sim/amsterdam.ts`). Score `{q=entryPrice, hit}` with Brier/ECE + a
**`pairedBootstrapPValue(marketBrier − walletBrier)`** = the quantitative proof of the cheap-longshot edge.

**Script** `scripts/wallet-forensics.ts <wallet> [--persist] [--json]` (mirrors `amsterdam-truth-backfill.ts`):
prints PnL curve + **reconciliation line (reconstructed total vs user-pnl total — the survivorship gate)**,
by-city, by-price-bucket, behavioral-over-time, regime breakpoints, calibration block. `--persist` →
migration **`0050`** (`wallet_pnl_daily`, `wallet_bet_calibration`; `amsterdam_truth` RLS pattern).
**AC:** reconstructed total reconciles to `user-pnl` within ±2% (fees); badatmath ≈ **+$25,407**,
ROI-on-vol ≈ **1.8%**; `regimeChange` flags **week of May 14–21 2026**; ROI-by-bucket shows **`<0.25`
positive, `0.45–0.75` negative**; pure fns unit-tested (PGlite twin for persistence).
**First slice:** `reconstructRealizedPnl` + `dailyPnlCurve` + `regimeChange` + tests + the script printing
badatmath's curve + reconciliation + breakpoint — **proves it's real, not survivorship, end-to-end.**

### Build #3 — Day-before bucket-market efficiency & calibration study *(the forecast experiment)*

**Posture:** analytics study, not a trading green-light. Our Amsterdam sim only ever tested **same-day**
entry; badatmath earns the **day before**. Question: does our EMOS-calibrated *next-day* cheap modal
bucket, entered day-before, beat the **day-before** market price?

- **H1:** day-before, betting our calibrated cheap bucket (`<0.25`) is +EV vs the day-before ask.
  **H0 (prior, likely):** market ask ≥ our prob day-before too → edge straddles 0.
- **Primary metric:** mean `edge = calibratedP(bucket) − ask` ± CI (the `armEdgeStats` idiom); secondary
  EV/$1 + `Brier(ours) − Brier(market)`. **Pre-registered kill-criterion:** `< +1.5%` / CI straddles 0
  across stations & leads → **REJECTED, day-before market efficient, stop** (WO-5 discipline; don't force a read).
- **Method** (`scripts/research/db1-daybefore-efficiency.ts`, forks `mos-pointskill.ts` loaders — don't
  edit the shared harness): walk-forward EMOS (`correctPoint`+`computeModelWeights`→μ, `fitSigma`→σ) →
  `gaussianBucketProbs(μ,σ,buckets)` → `edge = calibratedP − ask` → simulate badatmath-style entries
  (modal + any `calibratedP>ask & ask<0.25`) via `placeSimBet/gradeSimBet` → score per-arm/station/lead.
  Baseline must reproduce blend RMSE **1.5657°C** or the fork is wrong.
- **US sub-lever (secondary):** add **`nbm_conus`** (preferred — 2.5km, 11-day lead, already a calibrated
  blend) and optionally `hrrr_conus` to `KNOWN_FORECAST_MODELS` (`packages/core/src/weather/openmeteo.ts`)
  + a `models` seed row (`0010_seed.sql`); backfill US stations via `scripts/backfill-forecasts.ts
  --models nbm_conus --stations KORD,KSEA,…`; A/B Δ Tmax-MAE **and** Δ bucket-Brier on US stations only.
  Prior is LOW (L3-b found residual R²=0.6% on existing inputs) but it's the one lever that breaks the
  *input* ceiling rather than re-tuning under it.
- **AC / honest framing:** justifies further work **only** if the day-before edge CI clears zero on the
  cheap-longshot subset across multiple stations + all leads + survives fees + isn't EHAM-only. The
  likely (and still valuable) outcome is a clean **`Brier(ours) − Brier(market) ≈ 0` day-before
  efficiency measurement** — that's the analytics deliverable. Ship nothing to prod regardless of sign.

### Build #4 — Live-integration: the gated order rail + readiness instrumentation *(the path to acting on a proven edge)*

> **✅ Live-readiness preflight BUILT & TESTED (2026-06-22) — runs live.** `scripts/check-live-readiness.ts`
> + `scripts/check-live-readiness.test.ts` (22 parity scenarios pinning it to `goLiveGate` **verbatim** — the
> §15 anti-drift guard, since the CLI cannot import `packages/trading`). Read-only CLI mirror of `goLiveGate`
> + `GO-LIVE-CHECKLIST.md`: queries `go_live_gate_inputs`, fetches the geoblock doc, renders every condition;
> wallet-secret + `tradingMode` shown EXEC-TIME (never false reds). **893 tests green (+22)**, typecheck 0,
> §15 invariants green. **Live readout 2026-06-22:** the gate is **6 blockers out** globally (8 with the
> Amsterdam city rule) — `champion=house_gaussian`, only **9 scored days**, pooled **p=0.998**, pooled Brier
> **0.760 > 0.95×market 0.696** (the house model is currently WORSE than market), `halt:global` active,
> KYC/ledger unset, geoblock clean. Run: `pnpm tsx scripts/check-live-readiness.ts [--city amsterdam]`. No
> deploy, no secrets, no migration — the runnable instrumentation for the whole live track.

**Context — the rail is already built and DORMANT.** `LiveExecutor` (GTC limit BUY, tick-rounded, negRisk,
no auto-retry, resting-cancel), `createClobClient` (CLOB L1→L2 auth via `@polymarket/clob-client`, sigType,
funder), the `execute-bet` chokepoint, `goLiveGate`, the cap ladder (`fill_bet_with_caps`), bankroll ledger,
breakers — **all mock-tested.** Going live is **not an integration problem.** It is gated on (a) a proven edge
(Builds #2/#3) and (b) re-pointing same-day machinery at the day-before strategy + making the gate actually
*measure* that edge. Sub-parts:

**4a. The gate false-green gap (the one place this lane MEETS the forensics lane).** `goLiveGate` validates
SAME-DAY house-champion Brier vs market consensus — it does **not** measure the day-before cheap-longshot
edge, so even a perfect Build #3 result wouldn't register on it today. **Required: a `day-before-edge` input
in `go_live_gate_inputs`** (new migration) carrying Build #3's verdict — `edge = calibratedP − day-before ask`
CI clears 0 on the `<0.25` subset, survives fees, multi-station/multi-lead (the **+1.5% kill-criterion**).
Until wired, a green gate is a *false green* for the new strategy. **Build #3 produces the data; Build #4
builds the socket + extends `goLiveGate` + extends the `check-live-readiness` parity test.**

**4b. SDK verification is §15-constrained (needs an ADR, not a smuggle).** The dormant client
(`@polymarket/clob-client`) may be imported ONLY inside `packages/trading` and only resolves in Deno
(`invariants.test.ts` enforces this tree-wide — it even flags the literal `POLY_PRIVATE_KEY` outside that
boundary). So the **never-run SDK cannot be smoke-tested out-of-band.** **Decision required (ADR):** either
widen the §15 allowlist for a read-only `getTickSize`/`getOrderBook`/`getOrder` verification, or add a
verification mode to `execute-bet`. Re-verify `getOrder`'s response fields (`status`/`price`/`size_matched`,
mock-guessed today) against the live CLOB before the first real order.

**4c. The strategy delta — same-day taker → day-before cheap-longshot maker grind.** *Reusable as-is:*
`execute-bet`, `LiveExecutor` mechanics, SDK auth, cap ladder, ledger, breakers, gate framework. *Changes:*
(1) **champion feed** — `poll-markets` steps 3–6 are DARK today (0 house champions; the code comments it a
no-op until `house_gaussian` rows exist); (2) **day-before cadence** — cron is twice-daily; the markets are
thin, short-lived, created ~2 days out; (3) **maker-resting entry** — rest a bid AT the target cheap price
(<0.25) instead of crossing to the ask (the `§12` Phase-5 enhancement; real code); (4) **auto-approval** —
`autoApproveMaxStakeUsd=0` is manual-every-bet, structurally incompatible with a hundreds-of-bets/day grind;
(5) **sizing regime** — 0.25 Kelly / $1000 / $5-min vs badatmath's ~$1.3–3.3/trade thin-edge profile.
`negRisk:true` hardcoded is correct (bucket markets ARE negRisk).

**AC:** `day-before-edge` migration + `goLiveGate` extension + parity-test extension; SDK-seam ADR; readiness
preflight (✅ done). **Live activation gated on KILL-GATE 2 (Build #3) passing** — if Build #3 rejects, this
lane delivers only the readiness instrumentation and the rail stays dormant.

---

## 7. Feasibility & risks

Verified 2026-06-22 (web + live API calls). These determine what's buildable today vs. needs forward-capture.

**1. Historical day-before bucket prices — PARTIAL (coarse retrospective OK; fine-grain must capture forward).**
`GET clob.polymarket.com/prices-history?market=<clobTokenId>&startTs&endTs&fidelity&interval` is real and
keyless, and **does** return data for resolved markets — but with a confirmed retention floor:
**sub-12h fidelity returns `[]` for resolved markets** (py-clob-client #216/#189; reproduced live). `fidelity=720`
(12h) works. So Build #3's backtest **can** retrospectively recover a day-before price snapshot at ~12h
resolution (enough — you want 1–2 points/day, not intraday), but **cannot** get retrospective hourly
convergence. This matches `AMSTERDAM-EV-MODEL.md`'s earlier "~2–3 days retention" finding. Day-of/intraday
convergence studies **must capture forward** (cron-poll `/prices-history?interval=1h` or Gamma
`bestBid/Ask` on live markets → persist). If 12h proves too thin, the trade-level fallback is the
Goldsky/the-graph subgraph or Bitquery (every on-chain fill, no retention gap). **This is Build #3's
binding constraint — not blocked, but coarse; start the forward-capture cron now so intraday data exists later.**

**2. Open-Meteo HRRR / NBM — FEASIBLE (zero new vendor).** Confirmed slugs on open-meteo.com/en/docs/gfs-api:
**`nbm_conus`** (2.5km, **11-day lead**, already a calibrated blend — the better next-day fit and closest
free analog to NWS MOS) and **`hrrr_conus`** (3km, but only 18h std / 48h at synoptic runs — marginal for
a clean day-before snapshot). Both expose hourly `temperature_2m` and daily `temperature_2m_max`. Add via
the same `&models=` param the ingestion already uses. **Prefer `nbm_conus`** as the US sub-lever; treat
`hrrr_conus` as a short-lead refinement. This is exactly WO-L3-c's "stronger source the global grid misses,"
now with a concrete, free, US-CONUS input.

**3. Endpoint stability — PARTIAL (depend, with a fallback).** `/v1/leaderboard` is now **documented**
(docs.polymarket.com → get-trader-leaderboard-rankings) — low risk. `user-pnl-api…/user-pnl` is
**undocumented-but-widely-used** (it powers the profile chart) — fine to use, but keep the documented
fallback (reconstruct cumulative realized PnL from `/activity`, which Build #2 does anyway). All read
surfaces are auth-free. ToS: stay within published limits, send a UA, **persist your own pulls** rather
than re-hitting their undocumented hosts live — which is what Builds #1/#2 do by design.

---

## 8. Next-session checklist

1. **Build #1 first** (benchmark tracker) — pure analytics, ships now, on-pivot. Track badatmath +
   top-N WEATHER leaderboard daily; surface 3-way disagreement (their bucket vs our forecast vs market).
2. **Build #2** (wallet-intelligence/PnL ledger) — the skill-vs-survivorship gate; reconstructs true
   ROI/win-rate/calibration and a regime-change detector. Run it on badatmath to confirm net edge before
   trusting anything further.
3. **Start the forward-capture cron immediately** (cheap, decouples from #3): poll
   `clob /prices-history?interval=1h` (or Gamma `bestBid/Ask`) on live bucket markets daily and persist —
   so intraday day-before convergence data exists when you run the study. Retrospective is only 12h-coarse.
4. **Build #3** — runnable now at 12h fidelity (not blocked); the day-before calibration study with the
   `nbm_conus` sub-lever. Honor the pre-registered kill-criterion; the likely deliverable is a clean
   efficiency measurement, not an edge.
5. Decide: is a "what the sharps are betting" panel worth a slot on `/amsterdam`, or a new `/signals` page?
6. Re-run the §2/§3 forensic on badatmath in ~2 weeks (via Build #2) — does the edge persist or decay?
   A decaying edge ⇒ the market is absorbing it (efficiency reasserting); a persistent one ⇒ worth the study.

---

## 9. Finalized product goal + the synchronized multi-agent workflow

**Finalized goal (the finished product, one sentence):** one synchronized pipeline that turns the badatmath
discovery into **either** (a) a validated, gate-activated **day-before betting capability**, **or** (b) a
clean, published **day-before-efficiency measurement** proving the market is efficient — the branch chosen by
a **pre-registered kill-criterion, not by hope.** The machinery (benchmark tracker → forensic edge-proof →
day-before forecast study → gated live rail) gets built either way; only the live switch is contingent on the
evidence.

**"Done" = all five, with the live switch kept honest:**

| Component | "Done" means | Build |
|---|---|---|
| Benchmark | sharp tracker live on `/amsterdam`; 3-way disagreement (sharp vs ours vs market) | **#1 ✅ built**, deploy-gated |
| Edge-proof | badatmath reconstructs to **+$25,407 ±2%**, `<0.25` positive *net of losers*, regime break May 14–21 → **real, not survivorship** | **#2** |
| Forecast study | day-before EMOS study run; **kill-criterion adjudicated** (edge clears 0 ⇒ proceed; else publish efficiency, stop) | **#3** |
| Live rail | **IF #3 clears:** `day-before-edge` gate condition green + SDK-seam ADR executed + operator go-live sequence | **#4** |
| Data spine | forward-capture cron running from day 1 (intraday day-before convergence) | **Phase 0** |

**The workflow — phases, hard barriers (KILL-GATES), and parallel lanes.** This supersedes §8's linear list
with a dependency-aware, kill-gated fan-out (this is the dynamic build setup to instantiate next session):

```
PHASE 0 — Foundations (all parallel, no cross-deps)
  ├─ capture-agent : forward-capture cron (clob /prices-history?interval=1h + Gamma bestBid/Ask → persist).
  │                  START FIRST — time-sensitive; retrospective price history is only 12h-coarse.
  ├─ deploy-agent  : ship Build #1 (apply 0049 → deploy sharp-wallet-track → first cron / seed)  [operator-gated]
  ├─ live-agent    : draft the day-before-edge gate-socket SPEC (4a) + the SDK-seam ADR (4b) — design only, no migration grab
  └─ shared        : canonical Deno/Node polymarket-wallet parser (one source of truth, two thin fetch wrappers)

PHASE 1 — Edge reconstruction
  └─ forensics-agent : Build #2 core (reconstructRealizedPnl, dailyPnlCurve, regimeChange) + script → run on badatmath
  ══ KILL-GATE 1 (hard barrier, adversarially verified by a second agent) ══
     PASS = reconstructs to user-pnl ±2%, <0.25 positive / 0.45–0.75 negative, regime break May 14–21
     FAIL = survivorship / no net edge → STOP the live track; deliver benchmark-only. Do NOT enter Phase 2.

PHASE 2 — Day-before forecast study   (only if KILL-GATE 1 passed)
  └─ study-agent : Build #3 walk-forward EMOS day-before (12h-coarse now; finer as forward-capture accrues) + nbm_conus sub-lever
  ══ KILL-GATE 2 (pre-registered, adversarially verified) ══
     PASS = edge CI clears 0 on <0.25 subset, survives fees, multi-station + all leads, not EHAM-only
     FAIL = day-before market efficient → PUBLISH the efficiency measurement; live rail STAYS DORMANT. Done (branch b).

PHASE 3 — Live activation   (only if KILL-GATE 2 passed)
  ├─ live-agent : migration adds day-before-edge → go_live_gate_inputs + goLiveGate extension + extend check-live-readiness parity test
  ├─ live-agent : execute the SDK-seam ADR → read-only smoke → verify getOrder fields live
  ├─ rail-agent : strategy-delta work — champion feed ON, day-before cadence, maker-resting executor (Phase-5), auto-approval, sizing regime
  └─ operator   : GO-LIVE-CHECKLIST — wallet fund + on-chain approvals, 3 POLY_* secrets, rollback drill, $20 month-one cap, first-fill reconciliation
```

**Orchestration rules (parallel-agent hygiene):**
- **Migration-number broker.** `0049` is taken (Build #1). Do NOT pre-bind numbers across parallel agents —
  a single orchestrator broker hands out the next number at file-creation time (reserve *roles*: Build #2
  persist, forward-capture table, Build #4 gate socket). Migration-number collisions are the #1 parallel hazard here.
- **The two kill-gates are hard barriers.** No Phase-N+1 agent starts until the gate is **adversarially
  verified** (a second agent re-runs the reconciliation / re-checks the CI against the pre-registered
  threshold). The criteria are pre-registered — do NOT move them to fit a result (WO-5 discipline).
- **Lane independence (no collisions).** Phase 0 + benchmark + forensics never touch `packages/trading`; the
  live lane never touches `packages/io` / `openmeteo.ts` / `0010_seed.sql` / `dash_amsterdam_sim` / `/amsterdam`.
  The lanes meet at exactly **one contract**: Build #3's verdict → Build #4's gate socket (4a).
- **Default branch is (b).** Per WO-5 + the live readout (house model currently *worse* than market), the
  prior is the efficiency measurement. Phase 3 is the contingent branch, not the expected one — build the rail,
  but don't assume the switch flips.

_Cross-refs: `FORECASTING-RD.md` (closed-trading evidence + open lever), `AMSTERDAM-SIM.md` (the existing
paper-sim this extends), `GO-LIVE-CHECKLIST.md` + `packages/trading/src/gate.ts` (the live gate this lane
instruments), memory `polymarket-sharp-weather-wallet.md`._

---

## 10. OUTCOME — the workflow ran to completion (2026-06-22, branch b)

The §9 synchronized multi-agent workflow was instantiated and run end-to-end (3 workflow phases + a
remediation pass, all adversarially verified). **Result: branch (b) — the day-before market is efficient
w.r.t. our forecast; the live trading rail stays dormant.** The machinery (benchmark → forensic edge-proof →
day-before study → gated live specs) was built either way; only the live switch was contingent, and the
evidence did not flip it. Nothing shipped to a trading path.

### What was built + committed (branch `feat/live-integration-readiness`)
- **Phase 0 (`79b794f`):** `packages/io/src/polymarket-wallet.ts` (canonical Node wallet client: parsers +
  paged `fetchActivity` + `resolveMarketsMeta`); the forward-capture audit (`docs/specs/forward-capture-audit.md`);
  the SDK-seam **ADR-22** + the day-before-edge **gate-socket SPEC** (design-only, Phase-3-gated).
- **Build #2 (`30ab21a`, migration `0050` APPLIED):** `core/sim/wallet-forensics.ts` + `scripts/wallet-forensics.ts`
  (realized-PnL reconstruction from public `/activity` via the conditionId cash-flow identity).
- **Build #3 (`39289f0`):** `scripts/research/db1-daybefore-efficiency.ts` (walk-forward EMOS day-before edge
  vs the `market_snapshots` ask) + the `nbm_conus` registration (migration `0051` STAGED, not applied).
- **Robustness fix (`7e5b968`):** a silent-crawl-truncation guard in `wallet-forensics.ts` (see corrections).
- Migrations `0049` + `0050` are applied to prod; `0051` is staged (unapplied, `enabled=false`). 970 tests green.

### KILL-GATE 1 — the sharp's edge is REAL, not survivorship (PASS-on-substance, operator-adjudicated)
Reconstructed badatmath's full 92,921-fill history. **Decisive anti-survivorship evidence:** win rate **40.6%
net of 5,436 losers** (a survivorship lens would show ~100%); `<0.25` ROI **+22.8%** / `[0.45,0.75)` **−1.0%**
(the cheap-longshot signature, robust to a total-loss counterfactual); wallet Brier **0.350** vs 0.500 baseline
(p=0.000). The official PnL **+$25,445** was verified independently 5×. **It did NOT cleanly pass two
pre-registered criteria** (see corrections), so it was adjudicated **PASS-on-substance** by the operator: the
gate's binding question (real vs survivorship) is decisively answered REAL; the two misses are public-data
precision limits, not survivorship.

### KILL-GATE 2 — the day-before market is EFFICIENT (FAIL → branch b; 3/3 skeptics)
Walk-forward EMOS calibrated next-day bucket probs vs the **day-before** market ask (read from `market_snapshots`,
100% day-before coverage). Over 44 stations / 721 resolved events / ~2 months of market overlap:
- pooled cheap-longshot (`<0.25`) day-before edge = **+0.46pp, 95% CI [−0.92, +1.83]** — straddles 0
- **0 of 44 stations** show a CI-clears-0 positive cheap edge; EHAM is among the *worst* (−6.32pp) → no EHAM-only artifact
- **Brier(ours) is significantly WORSE than the day-before market** on both leads (0.740 / 0.756 vs 0.715;
  p(ours sharper) 0.05 / 0.015) — the market is the sharper day-before forecaster (corroborates WO-5 + the live readout)
- edge is gross; fees only erode it. **Every axis of the +1.5% kill-criterion fails.** REJECTED — efficient.
- fork-correctness confirmed: blend RMSE **1.2991** byte-matches `mos-pointskill` on the same window.

**Interpretation:** badatmath's edge is calibration + timing + scale across ~45 cities — NOT a data secret we
can replicate as a slower follower. We cannot beat the day-before bucket market with our forecast. This closes
the one lever `FORECASTING-RD.md` left open, consistent with WO-5.

### Corrections to premises in §1–§9 (found false/stale during the run — recorded, not edited above)
1. **"Forward-capture cron is needed / the price-poll cron is twice-daily" (§7.1, §8, §9 Phase 0) — FALSE.**
   `poll-markets` already runs **every 5 minutes** and writes bid/ask/mid per bucket to `market_snapshots`,
   with **100% day-before coverage** (1,302/1,302 resolved events, ~50 captures/bucket, 30-min cadence, global).
   No forward-capture pipeline was built; the data spine already existed. (The "twice-daily" was the forecast-
   snapshot cron, conflated with the price-poll cron.) Details: `docs/specs/forward-capture-audit.md`.
2. **"Reconstruction reconciles to user-pnl within ±2%" (§6 Build #2 AC) — NOT reachable from public data.**
   Over the full lifetime, the official curve (+$25,445) sits *between* the trading-only reconstruction
   (−8.5%) and trading+incentives (+5.4%); MERGE ($93.6k of proceeds!) / SPLIT set-netting and open-position
   accounting are not fully reconstructible from `/activity`. Every definition lands within ~3–8.5% of the
   independently-verified official total — enough to prove real-not-survivorship, not enough for ±2%.
3. **"Regime break in the week of May 14–21" (§2, §6, §9) — refined to ~May 5–26.** The endpoint-stable causal
   onset (final trough crossing) is **2026-05-05**; the min-SSE best-fit kink is **2026-05-26**. The abrupt
   flat→vertical regime change is not in dispute; the handoff's predicted week was a rough estimate.
4. **A silent-truncation bug in `wallet-forensics.ts` (found + fixed, `7e5b968`).** A rate-limited crawl could
   terminate early yet report `mode='full'` and persist a partial snapshot as lifetime. Now guarded: the crawl
   cross-checks its earliest fill against the user-pnl span and refuses to `--persist` an incomplete run.

### Operator follow-ups (all NON-BLOCKING — the analytics deliverable is complete)
1. ✅ **DONE (2026-06-22):** Edge `sharp-wallet-track` deployed via the Supabase CLI
   (`npx supabase functions deploy sharp-wallet-track --use-api --no-verify-jwt --project-ref lenysiqxihsmxljvyybt`),
   ACTIVE (`verify_jwt:false`), cron `0 16 * * *` active — **Build #1 now auto-refreshes daily** (was 404-ing harmlessly until the deploy).
2. **Merge `feat/live-integration-readiness` → main** to ship the `/amsterdam` sharp card + this milestone (your call).
3. **Persist badatmath's forensic baseline** (deferred — Polymarket is rate-limiting after this session's heavy
   crawls; the tool now *correctly refuses* to persist a partial). Re-run when the API is healthy:
   `pnpm tsx scripts/wallet-forensics.ts 0x8fbd7cf5f806f563080864694415829f7229a959 --persist` (writes the
   `0050` tables; durable baseline for the §8 "does the edge decay?" re-run in ~2 weeks).
4. **OPTIONAL (low prior, R²=0.6%):** the `nbm_conus` US sub-lever A/B — apply `0051`, then
   `pnpm tsx scripts/backfill-forecasts.ts --models nbm_conus --stations KORD,KSEA,KSFO,KLAX,KLGA,KMIA,KATL,KHOU,KDAL,KAUS --from 2026-04-21 --to 2026-06-21`
   and re-run `db1-daybefore-efficiency.ts --stations …`. Cannot overturn the global efficiency finding.

**The live trading rail stays DORMANT (branch b).** Re-open only on genuinely new out-of-market information.

---

## 11. COPY-TRADE (fill-mirror) feasibility — the last replication path, also CLOSED (2026-06-22)

**The question.** §10 closed the "run badatmath's protocol on OUR forecast" path (KILL-GATE 2: our forecast
is worse than the day-before market). But badatmath BEATS the market — so the one path left to *get as
close to its automated buying protocol as possible* was to **MIRROR its revealed bucket choices**
(copy-trade), riding its forecast for free. The handoff dismissed this as "structurally a late follower in
thin books" (TL;DR §0.5) but **never measured it.** This section measures it, end-to-end, on data we already
have. **Result: copy-trading badatmath is NOT viable — decisively, and robustly across every assumption.**
The "late follower" intuition is now a quantified fact. The live rail stays dormant.

**What was built (committed on `feat/live-integration-readiness`).**
- `packages/core/src/sim/copy-trade.ts` — pure, deterministic fill-mirror analytics (+ `copy-trade.test.ts`,
  18 cases). For each BUY fill joined to its `market_snapshots` book series + resolution: the contemporaneous
  mid (maker/taker character), the post-fill mid drift (price discovery), and a **follower fee-net EV taking
  the ask** (canonical `takerFeeTotal` fee — badatmath earns the maker rebate; a follower does not). Reuses
  `armEdgeStats`/`bootstrapMeanCi`. Pre-registered verdict: `copyTradeVerdict` (follower fee-net EV 95% CI
  must clear 0).
- `scripts/research/copytrade-feasibility.ts` — the impure spine: windowed crawl (with `--cache`), the
  snapshot/resolution DB join, the readout + verdict + protocol-spec.
- `scripts/lib/polymarket-crawl.ts` — the time-windowed full-`/activity` crawler **extracted** from
  `wallet-forensics.ts` (DRY: both tools now share it) and **hardened** against transient 4xx (408/429): a
  rate-limit blip mid-crawl now retries the window with backoff instead of silently truncating (the same
  §10-class truncation the forensics guard exists to catch — a real bug found + fixed here; it had stopped
  the first crawl at Jun-04).

**PRE-REGISTERED kill-criterion (written before the number was seen — WO-5 discipline):** a follower
mirroring badatmath's cheap (<0.25) fills, entering at the **ask** after a realistic detection lag, net of the
5% taker fee, must show a **follower fee-net EV/$1 whose 95% CI clears 0** (primary), corroborated by the
low-variance mean **edge = hit − ask**. CI straddles 0 → late-follower confirmed, market efficient to a
mirror, rail stays dormant.

**The run (full regime, 2026-05-14 → 06-22; 59,664 BUY fills → 10,053 positions; 1,156 cheap+resolved with a
usable follower-entry snapshot):**

| Lens | badatmath (maker, its fill price) | Follower (taker, the ask) |
|---|---|---|
| **edge = hit − ask** (low-variance, the clean read) | **+1.34%** CI [−0.48, +3.15] | **−6.05%** CI [−8.10, −4.00] |
| fee-net EV/$1 (pre-registered; heavy-tailed) | — | **+14.81%** CI **[−38.88, +107.17]** → fails to clear 0 |
| avg entry price | 0.107 (the bid it rests) | 0.181 (the ask it must cross to) |

- **badatmath is a MAKER:** fill price is **−4.76%** below the contemporaneous mid; **65%** of fills are below
  mid. The edge is in resting cheap bids, not crossing spreads.
- **No wave to ride:** post-fill mid drift TOWARD its bucket is **−7.38%** CI [−8.72, −6.04] — the market moves
  *away* from its pick after it buys. Its edge is terminal (the bucket resolves in the money often enough),
  not momentum a follower could front-run.
- **The spread tax kills it:** a taker pays 0.181 where badatmath rested 0.107 — a ~74% markup — for the
  identical 12% hit rate. That ~7.4pp spread tax alone exceeds badatmath's entire ~1.3pp maker edge, flipping
  +1.3pp into **−6.05pp**. Fees only deepen it.
- **Robust across every assumption** (verdict unchanged): fastest follower (lag 0 / 15-min staleness) →
  follower edge −6.16% [−8.80, −3.52]; **cheapest longshots <0.10** (where the raw ROI was *highest*, §3) →
  follower edge **−7.76%** [−9.83, −5.69], fee-net EV **−63.60%** [−80.52, −43.02] (the cheapest bets are the
  *worst* to mirror — the ask sits proportionally furthest above the bid).

**Protocol spec (reverse-engineered — the by-product deliverable; refines §1–§3):**
- **Entry timing:** lead-to-resolution median **43.2h** (~1.8 days; p10 13.9h, p90 151.7h; 43% <36h) — it
  enters near market *creation* (~2 days out) and tops up closer in, NOT a day-before sniper.
- **Sizing:** **$10.80** median per position (p10 $1.54, p90 $44.96) — the §1 "$1.3–3.3" was per *fill*;
  positions aggregate many micro-fills.
- **Breadth:** **6 buckets per city·day** (median; max 16) — it does NOT pick one modal bucket; it **sprays
  the cheap longshots across the plausible range** of the ladder. The edge is the aggregate calibration of
  *which* cheap buckets, harvested as a maker at scale across ~45 cities.

**Conclusion.** badatmath's edge is a **maker edge** — resting cheap bids + the rebate + breadth/calibration —
and is **structurally non-followable**: a taker pays the ask (which the sharp's own bid sits ~7pp below),
there is no post-fill drift to compensate, and the effect is worst exactly where the raw ROI looks best. You
cannot *follow* this protocol; you would have to *be* the maker, resting your own bids in competition with it
in thin books — which a follower cannot win. This closes the last replication path. **All three angles
(forecast-beats-market, day-before-edge, copy-trade-mirror) are now falsified; the live rail stays DORMANT.**
The clean copy-trade-efficiency measurement + the reverse-engineered protocol spec ARE the analytics
deliverable. (Coverage caveat: 1,156 of 4,383 cheap+resolved positions had a takeable post-fill snapshot
within the 30-min `market_snapshots` grid — the realistic "a follower could actually act" subset; the grid is
coarser than a sub-minute lag, surfaced honestly in `copy-trade.ts`.)

### Follow-up: `nbm_conus` US sub-lever A/B — RAN 2026-06-22, no improvement (confirms the low prior)

The §10 optional follow-up #4 was run. **Result: adding the NBM CONUS model to the US blend does NOT improve
forecast skill, and the day-before market stays efficient — the input ceiling holds.** US-station (10 cities,
197 resolved events) walk-forward, with vs without nbm: blended-μ point **RMSE 1.4024 → 1.4092°C (flat/noise)**;
day-before verdict NOT MET either way. (Caveat: not perfectly apples-to-apples — nbm expands forecast coverage,
so the "with" run scores more build-days/events and a different set, which also shifts the market-Brier
denominator; the least-confounded signal, point RMSE, is flat.) Matches the pre-registered R²=0.6% prior; changes
nothing. **Two real bugs fixed along the way** (committed): (1) the registered Open-Meteo slug was wrong —
`nbm_conus` is rejected with HTTP 400; the live-verified slug is **`ncep_nbm_conus`** (fixed in
`openmeteo.ts` `KNOWN_FORECAST_MODELS`, migration `0051`, and the prod `models` row). (2) `backfill-forecasts.ts`
silently dropped an explicit `--models X` request when X was registered-but-disabled (the `enabled` filter ran
first) — now an explicit `--models` honors a disabled-but-registered model, exactly the staged-sub-lever
workflow `0051` documents. The 4,400 scratch backfill rows were deleted afterward (the study ships nothing to
prod); `ncep_nbm_conus` stays registered + `enabled=false`.

---

## 12. MAKER-SPRAY (rest-our-own-bid) feasibility — the 4th and LAST angle, also CLOSED (2026-06-22)

**The question.** §10/§11 closed three angles (forecast-beats-market, day-before-edge, copy-trade-mirror). One
variable was never directly measured: badatmath is a **MAKER** (rests cheap bids ~7pp below the ask). Could WE
run that protocol on OUR EMOS forecast — rest our own cheap bids *below* the ask — and clear zero? KILL-GATE 2
measured the TAKER price (`calibratedP − ask`); this measures the MAKER price (`calibratedP − rested_bid`) with a
fill model that reads the real `market_snapshots` book evolution (the ask collapses to our bid on losers → fill;
rises away on winners → no fill). Built architecture-first (`MAKER-SPRAY-SIM.md` + `docs/specs/maker-spray-*.md`,
Full Phase-9 review → 2-pass convergence) then via a gated subagent workflow. **Result: maker entry on our forecast
is ALSO efficient — decisively, in BOTH a forecast-conditioned and an indiscriminate spray. All four angles
falsified; the rail stays DORMANT.**

**What was built (committed on `feat/live-integration-readiness`).**
- `packages/core/src/sim/maker-spray.ts` — the pure maker twin of `copy-trade.ts`: `restPrice`, the **novel
  ask-touch fill model** `simulateFill` (filled iff `min(best_ask after entry) ≤ restPx` — embeds adverse
  selection from the real book), `makerNetEvPerDollar`, `makerEntry`, `simulateSpray`, `makerSprayVerdict`,
  `crossValidateFillModel`, + a **mandatory zero-skill Monte-Carlo** false-positive guard. 34 tests.
- `scripts/research/maker-spray-feasibility.ts` — the spine: forks the **db1 EMOS spine** + **copytrade's
  snapshot loader**; the **tz-correct `localDayWindow` window** is the binding correctness fix vs db1's
  station-local-`target_date`-as-UTC skew (a real up-to-12h per-city error db1's last-ask read had masked). 21
  tests. 1044 tests green, typecheck 0, read-only, no migration, no `packages/trading` import.
- A **`--select all|forecast`** axis distinguishes the mechanical baseline (rest on every cheap bucket) from the
  real "our-forecast-as-a-maker" test (rest only where `calibratedP > restPx` — the maker analog of db1's
  cheap-longshot rule). This was added after the build's first cut sprayed indiscriminately (our forecast never
  entered the EV path) — the indiscriminate-only result would have under-tested the question.

**The run (full universe: 45 stations · 721 resolved events · 2026-04-21→06-21 · entry-lead 24h · rest-at bid ·
ask-touch; fork-equality db1 `1.2991°C` byte-match — the canonical KILL-GATE 2 anchor):**

| Lens | indiscriminate (`select=all`) | forecast-conditioned (`calibratedP>restPx`) |
|---|---|---|
| cheap-eligible / filled | 2048 / 1990 (97% fill) | 1282 / 1248 (97% fill) |
| **maker edge (won−restPx)** — the robust low-variance metric | **−1.46% CI [−2.20, −0.72]** | **−1.73% CI [−2.66, −0.80]** |
| EV/$1 (pre-registered; heavy-tailed) | −38.18% CI [−71.22, +3.78] | −13.14% CI [−67.65, +50.87] |
| adverse selection (filled-hit ≪ eligible-hit) | 3.1% ≪ 5.1% — **CONFIRMED** | 2.9% ≪ 4.8% — **CONFIRMED** |
| Brier ours vs market-at-entry | 0.0959 vs 0.0890 (ours worse) | 0.0982 vs 0.0885 (ours worse) |
| verdict | **FAIL** | **FAIL** |

**Three reads:**
1. **Both modes FAIL on the robust metric.** The low-variance maker edge (`won − restPx`) is negative with a 95%
   CI that **excludes zero in both modes** — as a maker resting below the ask, our filled bids win ~1.5–1.7pp
   LESS than the price we rested at. Efficient.
2. **Our forecast as a SELECTOR is value-NEGATIVE on the cheap tail.** Forecast-conditioning makes it slightly
   WORSE (−1.73 vs −1.46) and picks buckets that win LESS (4.8% vs 5.1%). Using our forecast to choose cheap
   buckets is *worse than not using it* — a clean corroboration that our calibration is inferior to the market's
   (Brier ours > market in both modes; consistent with KILL-GATE 2).
3. **The adverse-selection trap is real and quantified.** The fill model fills 97% of rested bids, but the filled
   set wins far less than the eligible base rate — the classic maker problem: your cheap bid fills precisely on
   the buckets the market is marking down (losers), while winners' asks rise away and never fill you.

**Methodological note (the build's own guard caught it — honest record).** The pre-registered binding metric was
the fee-net **EV/$1** pooled CI. On cheap longshots that metric is HEAVY-TAILED (a 0.02 bucket that wins pays
+49/$1), so its bootstrap CI is unreliable — the mandatory zero-skill Monte-Carlo reported **P(PASS | shuffled
outcomes) ≈ 99.7–100%**, i.e. the EV/$1 gate would "pass" pure noise almost always. Per WO-5 discipline the
criterion was NOT moved (its lower bound is < 0 → FAIL anyway); the conclusion rests on the **low-variance edge
metric + the AS diagnostic**, which falsify cleanly. Pre-registering EV/$1-CI as binding for cheap-longshot maker
fills was a slight mis-design; the edge metric is the right tool and was reported alongside (it's why the report
prints both, and why W4's zero-skill MC is mandatory).

**Scope honesty.** A small sub-scope (8 stations × 6 weeks) had ZERO cheap-bucket winners → a degenerate −104%
(every cheap bet loses by construction; db1 shows the identical 0% hit there). The full universe is the
informative scope. The 30-min snapshot grid makes the fill model coarse (surfaced in the coverage block).

**Conclusion.** badatmath's maker edge is **NON-REPLICABLE on our forecast**: resting below the ask does not
rescue an inferior calibration — adverse selection makes it worse, and our forecast's cheap-tail selection is
value-negative. **All four replication angles (forecast-beats-market, day-before-edge, copy-trade-mirror,
maker-spray) are now falsified. The live trading rail stays DORMANT** — re-open only on genuinely new
out-of-market information.

---

## 13. M1 TAIL-CALIBRATION DIAGNOSIS — the one router arm never measured (2026-06-22) — AMBIGUOUS

**The question (BADATMATH-GAP-PLAN.md Move 1 / §6 "the single next concrete action").** §10–§12 falsified all
four replication angles — and **every one used OUR forecast as the SELECTOR**. The reverse was never asked: *do
badatmath's REVEALED cheap picks resolve more often than OUR EMOS predicts?* If yes (≥+3pp, CI>0) our **tail** is
underweighted — a *fixable forecast* (Case A → Move 7 recalibration), not just an un-replicable rent. If no
(<+1pp, with M2 already FAIL) the forecast is **not** the gap → the analytics product (Move 10). This is a
DIAGNOSIS, not a trade gate: a PASS routes to a recalibration *experiment* re-tested by the existing maker-spray
sim; it does **not** reopen the live rail. The result feeds the analytics product either way.

**What was built (committed on `feat/live-integration-readiness`).**
- `packages/core/src/sim/tail-calibration.ts` — the pure analytics: `m1TailCalibration` (the BINDING
  low-variance `won − EMOS_p` gap + CI), `m3TailBrier` (tail-local Brier ours vs market), `m4EntryDeciles`
  (their realized edge by entry-price band), `tailCalibrationVerdict` (the §5 branch table), with the FROZEN
  cut + thresholds in a header comment block (WO-5: the §12 heavy-tailed-EV mis-design lesson is honored — the
  binding metric is the low-variance paired gap, never a per-bet EV). **13 tests.**
- `scripts/research/m1-tail-calibration.ts` — the impure spine: reuses `crawlActivity` (the windowed
  `/activity` crawler) + `toPositions` (copytrade) + the maker-spray EMOS spine (`assembleBids` =
  db1-forked walk-forward EMOS) + `forkEqualityRmse` (the correctness anchor). The bridge is
  `market_buckets.condition_id → (event_id, bucket_idx)`. **1064 tests green, typecheck 0, read-only, no
  migration, no `packages/trading` import.** Crawl cached to `scripts/research/out/badatmath-fills.json`.

**The run (full universe: 45 stations · 721 resolved events · 2026-04-21→06-21 · fork-equality `1.2991°C`
byte-match to db1 — the EMOS_p IS the live model). Crawled 64,934 BUY fills → 12,402 positions → 5,139 cheap
(<0.25) YES positions; 1,050 joined to an EMOS forecast (the rest are cities/days outside our 45-station scope
or without a forecast+σ in window).**

| Metric | Lead 1 (24h) | Lead 2 (48h) |
|---|---|---|
| cheap-tail picks (EMOS_p<0.15), n | 479 | 460 |
| empirical resolution freq | 8.98% | 10.22% |
| mean EMOS_p (what our model said) | 6.61% | 7.45% |
| **★ M1 gap (won − EMOS_p)** — the binding metric | **+2.37pp CI [−0.18, +4.91]** | **+2.76pp CI [+0.01, +5.52]** |
| M3 tail Brier (ours − market) | +0.79pp [−0.04, +1.61] | +0.23pp [−0.51, +0.97] |
| verdict | **AMBIGUOUS** | **AMBIGUOUS** (stable across leads ✓) |

**Three reads:**
1. **Our tail is roughly calibrated — NOT a clean Case A.** The gap is a *whisper* of underweighting (+2.4 to
   +2.8pp: their cheap picks resolve slightly more than EMOS predicts) but it **does NOT clear the pre-registered
   +3pp PASS bar**, and lead-1's CI includes 0 (lead-2 grazes +0.01). Per WO-5 the bar is NOT moved → AMBIGUOUS.
   **No Move-7 recalibration is warranted by the frozen criterion.**
2. **The market is still the sharper tail forecaster (M3 corroborates KILL-GATE 2).** `Brier(ours) − Brier(market)`
   on the cheap tail is **positive** (ours worse), tied within CI. Our forecast is not better than the market on
   the tail — exactly KILL-GATE 2's finding, now confirmed on the sharp's own revealed picks.
3. **A whisper of mis-calibration would still not be tradable — and the edge isn't even at the extreme tail.**
   M4 shows badatmath's realized edge lives in the **0.08–0.16 entry band** (+5.7 to +10.4pp), and is *negative*
   at the very cheapest (<0.07) and at 0.19 — refining §3's "cheapest longshots are the engine" to "the
   low-MIDDLE band is." Even a recalibrated tail can't harvest it: §12 already proved adverse selection eats a
   maker entry on our forecast, and the edge sits precisely in the band we'd have to out-rest competing makers in.

**Conclusion.** The M1 router returns **AMBIGUOUS, stable across leads**: our EMOS tail is *approximately*
calibrated to the #1 sharp's revealed picks (a small +2.5pp gap below the Case-A bar), and is *not* sharper than
the market there (M3). Per the frozen §5 branch table this is an **analytics input, not a forecast-lever reopen**
— the destination remains the analytics product (Move 10). **The number is itself the deliverable:** we hold the
only forensic reconstruction of the #1 weather trader, now scored against a calibrated model — and the finding is
that the sharp does *not* materially out-forecast our tail; its edge is microstructure (maker resting + rebate +
breadth across ~45 cities), which §11/§12 already proved structurally non-followable and non-replicable on our
fills. **The live trading rail stays DORMANT.** The remaining genuinely-distinct lever (Move 4, the intraday
running-max physics signal) is unaffected by this result but overlaps a closed WO-5 finding (the market is
efficient w.r.t. the running-max floor) — low prior, not run here.

---

## 14. MOVE 5 — the sharp as a FORECASTER (stacked-ensemble study) — RAN 2026-06-22 — KILL (value-NEGATIVE)

**The question (BADATMATH-GAP-PLAN.md Move 5).** §10–§13 falsified every way to *trade* badatmath — all
harvesting problems, all using OUR forecast as the selector. One Move was never run: the *forecasting* one.
badatmath BEATS the market, and its revealed cheap-spray is a daily distribution we currently throw away — so
**does that distribution carry orthogonal information that, folded into a stacked forecaster, beats the market
distribution we already lose to?** The honest baseline is the **MARKET** (the sharper forecaster per KILL-GATE 2
/ M3), not our EMOS. This is the lowest-regret Move: a PASS upgrades the FORECAST/analytics product (a
"smart-money-consensus" distribution); it does NOT reopen the live rail (the harvest is still adverse-selection
bound, §12). **Result: the sharp's revealed distribution adds NO orthogonal skill — folding it in is
value-NEGATIVE — stable across both leads. The 5th angle is closed; the live rail stays DORMANT.**

**What was built (committed on `feat/live-integration-readiness`).**
- `packages/core/src/sim/sharp-ensemble.ts` — the pure analytics: three per-event forecaster
  distributions (`marketDist` = renormalized asks-at-entry, the baseline; `emosDist` = our walk-forward
  gaussian ladder; `sharpDist` = the **market tilted toward the sharp's cheap revealed stake**,
  `mkt·(1+λ·stakeShare)` renormalized — λ frozen, never zeros the favourite so it is a fair forecaster), a
  convex `blend`, a deterministic simplex-grid `fitWeights`, the **no-lookahead `walkForwardStack`** (weights
  fit on STRICTLY-prior target dates only), paired-Brier `scoreArm`, the **`zeroSkillSharpMc`** false-positive
  guard (shuffle the sharp signal across events, re-fit, P(PASS|noise)), and the frozen `ensembleVerdict`
  (FOUR guards must all clear: the low-variance improvement CI, the paired bootstrap, the zero-skill MC, AND the
  marginal-sharp arm that neutralizes the EMOS confound). **27 tests** (a constructed PASS, KILL, INSUFFICIENT).
- `scripts/research/m5-sharp-ensemble.ts` — the impure spine: reuses the m1/maker-spray data path
  (`crawlActivity`→`toPositions`, the `market_buckets.condition_id` bridge, the db1-forked `assembleBids` EMOS
  ladder, `forkEqualityRmse`); groups the ladder into `EnsembleEvent`s and attaches the sharp's per-bucket
  revealed Yes-leg stake. **1091 tests green, typecheck 0, read-only, no migration, no `packages/trading` import.**

**The run (full universe: 45 stations · 721 resolved events · 2026-04-21→06-21 · leads 1,2 · tiltλ 4 · mc-iters
200 · fork-equality `1.2991°C` byte-match to db1 — the EMOS ladder IS the live model. 174 sharp-touched events
of 473 seen had all three forecasters defined).**

| Arm (vs MARKET baseline) | Lead 1 (24h) | Lead 2 (48h) |
|---|---|---|
| **★ M+S** (binding — does the sharp add over the market?) | **−1.74pp CI [−3.44, −0.04]** p=0.97 | **−1.20pp CI [−2.35, −0.05]** p=0.98 |
| M+E (EMOS control — our forecast vs market) | −0.02pp CI [−0.21, +0.17] | +0.34pp CI [−0.17, +0.85] |
| M+E+S (full smart-money consensus) | −1.74pp CI [−3.45, −0.04] | −0.83pp CI [−2.08, +0.42] |
| marginal sharp (M+E − M+E+S) | −1.72pp CI [−3.41, −0.04] | −1.17pp CI [−2.32, −0.02] |
| zero-skill P(PASS \| shuffled sharp) | **0.0%** (200 iters) | **0.0%** |
| verdict | **KILL_ALREADY_PRICED** | **KILL** (stable ✓) |

**Three reads:**
1. **The sharp's distribution is value-NEGATIVE as a forecaster.** The binding M+S improvement (Brier_market −
   Brier_stack) is **negative with a CI that excludes 0 in both leads** — tilting a calibrated market toward the
   sharp's revealed cheap picks does not just fail to help, it makes the forecast *worse*. The walk-forward fit
   picks up tiny in-sample noise in the sharp signal and pays for it out-of-sample (the honest OOS penalty for a
   useless signal — exactly what walk-forward exists to expose).
2. **WHY it's negative is the same mechanism as §12.** The sharp's cheap longshots mostly **lose** (their tail
   hit rate is ~5–12%, §3/§13). Treating "the sharp bet this cheap bucket" as forecast signal moves mass off the
   favourite (which usually wins) onto longshots (which usually don't). Their edge is the maker rebate + breadth,
   **not a superior probability** — so it carries no forecasting information once you already have the market price.
3. **Clean corroboration of the whole chain.** M+E ≈ 0 re-confirms KILL-GATE 2 (our EMOS adds nothing over the
   market); the zero-skill MC at **0.0%** proves the gate isn't a false-positive machine; the result is stable
   across leads. This is the **5th independent angle** (after forecast-beats-market, day-before-edge,
   copy-trade-mirror, maker-spray) to land on the same finding from a new direction.

**Conclusion.** Treating the #1 weather sharp as a forecaster and stacking its revealed distribution onto the
market **adds no orthogonal skill — it subtracts** — stable across leads, with a clean zero-skill guard. The
sharp's edge is confirmed, from a fifth angle, to be **pure microstructure** (maker resting + rebate + breadth
across ~45 cities), not a superior view of the world the market hasn't priced. The "smart-money-consensus
forecaster" is dominated by the market price; the measurement IS the analytics deliverable (Move 10). **The live
trading rail stays DORMANT** — re-open only on genuinely new out-of-market information. The one remaining
genuinely-distinct lever is **Move 4** (intraday running-max physics), which overlaps the closed WO-5 finding
(low prior, not run).
