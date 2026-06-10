# Polymarket Weather Markets — API Ground-Truth Research Report

> Produced by live-introspection agent, 2026-06-10 ~09:00 UTC. All "VERIFIED (live call)" facts come from HTTP calls executed that day; raw samples saved in this directory.

## 1. MARKET DISCOVERY

### VERIFIED (live call)

**The recommended discovery call** (returned exactly the full set of temperature markets, nothing else):

```
GET https://gamma-api.polymarket.com/events?tag_id=104596&active=true&closed=false&limit=100&offset=0
GET https://gamma-api.polymarket.com/events?tag_id=104596&active=true&closed=false&limit=100&offset=100
```
- Tag `104596` = label "Highest temperature", slug `highest-temperature` (from `GET /tags/slug/highest-temperature`, 200).
- Returned 100 + 36 = **136 events, all of them `highest-temperature-in-*`** (zero false positives).
- `limit` is **capped at 100** (requesting `limit=200` returned 100). Paginate with `offset` until a short page.
- Response is a bare JSON **array** of event objects (no envelope).

Other tag IDs verified via `GET /tags/slug/{slug}` (all 200):

| slug | id | contents |
|---|---|---|
| `weather` | `84` | 207 active events: all temperature markets + earthquakes, meteors, flu, etc. |
| `daily-temperature` | `103040` | highest + lowest temperature events |
| `highest-temperature` | `104596` | **exactly the target universe** |
| `temperature` | `104615` | exists but **0 events — dead tag, do not use** |

- `related_tags=true` accepted (200) but unnecessary.
- `GET /public-search?q=highest%20temperature` → 200. Shape: `{ "events": [...], "pagination": { "hasMore": true, "totalResults": 5788 } }`. Supports `limit_per_type` and `page` params. Searches all of Polymarket; OK for ad-hoc, inferior to the tag query for a daily job.
- **Slug pattern (2026): `highest-temperature-in-{city}-on-{month}-{day}-{year}`**, e.g. `highest-temperature-in-nyc-on-june-11-2026`. `GET /events?slug=...` → array with 1 event. **Trap, verified:** the same slug *without* `-2026` returns the **stale 2025 event** (`highest-temperature-in-london-on-june-11` → `endDate 2025-06-11`, closed). Never guess slugs without the year.
- **Series discovery works:** events carry `seriesSlug` (e.g. `"nyc-daily-weather"`). `GET /series?slug=nyc-daily-weather` → `{ id: "10005", seriesType: "single", recurrence: "daily", events: [...] }` with a rolling events list (incl. resolved June 1–9 and legacy no-year slugs). Per-city series exist, but the tag query is simpler for global discovery.
- **Data-quality caveat, verified:** `active=true&closed=false` includes zombie events — `highest-temperature-in-jinan-on-may-20-2026` is still active/unclosed with `acceptingOrders: null`, `bestBid 0 / bestAsk 1`. **Filter `endDate >= today` in the discovery job.**

**Complete city list with active markets right now (49 cities, June 10 + June 11 rosters identical):**
amsterdam, ankara, atlanta, austin, beijing, buenos-aires, busan, cape-town, chengdu, chicago, chongqing, dallas, denver, guangzhou, helsinki, hong-kong, houston, istanbul, jeddah, karachi, kuala-lumpur, london, los-angeles, lucknow, madrid, manila, mexico-city, miami, milan, moscow, munich, **nyc** (not new-york-city), panama-city, paris, qingdao, san-francisco, sao-paulo, seattle, seoul, shanghai, shenzhen, singapore, taipei, tel-aviv, tokyo, toronto, warsaw, wellington, wuhan.
(jinan and zhengzhou appear only as stale May events — apparently discontinued.)

**Bonus, verified:** `lowest-temperature-in-{city}` markets exist for 8 cities: hong-kong, london, miami, nyc, paris, seoul, shanghai, tokyo (tag `103040` covers both).

## 2. MARKET STRUCTURE

### VERIFIED (live call)

Event = one city-date; `event.markets[]` = one binary Yes/No market per temperature bucket. All four cities inspected have **11 buckets** (9 interior + 2 tails).

| City | Units | Bucket width | Tails (Jun 11) | Station (resolutionSource) |
|---|---|---|---|---|
| NYC | °F | **2°F** | `87°F or below` / `106°F or higher` | `https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA` (LaGuardia) |
| London | °C | **1°C** | `9°C or below` / `19°C or higher` | `.../gb/london/EGLC` (London City Airport) |
| Seoul | °C | 1°C | `17°C or below` / `27°C or higher` | `.../kr/incheon/RKSI` (**Incheon Intl — not in Seoul proper**) |
| Paris | °C | 1°C | `14°C or below` / `24°C or higher` | `.../fr/bonneuil-en-france/LFPB` (**Le Bourget — switched from CDG/LFPG after April 2026 tampering**) |

US cities use °F/2° buckets; non-US use °C/1° buckets. Tail label formats: `{X}°F or below`, `{Y}°F or higher` (also seen: `90°F or higher` on the resolved Jun 9 event — bucket count/edges shift daily with the forecast).

**Event-level fields** (exact names): `id, ticker, slug, title, description, startDate, creationDate, endDate, createdAt, updatedAt, closedTime` (closed events only)`, active, closed, archived, restricted` (=true!)`, liquidity` (number)`, volume, volume24hr, volume1wk, volume1mo, volume1yr, openInterest, competitive, negRisk` (=true)`, negRiskMarketID, negRiskAugmented` (=false)`, enableOrderBook, enableNegRisk, seriesSlug, series, tags[], markets[], commentCount, eventDate, startTime, resolutionSource` (empty at event level)`, showAllOutcomes, showMarketImages`.

**Market-level fields** (per bucket; exact names): `id, question, conditionId, questionID, slug, groupItemTitle` (bucket label)`, groupItemThreshold, description, resolutionSource` (Wunderground URL)`, endDate, endDateIso, startDate, startDateIso, outcomes, outcomePrices, clobTokenIds, bestBid, bestAsk, spread, lastTradePrice, oneHourPriceChange, volume, volumeNum, volume24hr, liquidity, liquidityNum, orderPriceMinTickSize, orderMinSize` (=5)`, negRisk, negRiskMarketID, negRiskRequestID, negRiskOther, feesEnabled` (=true)`, feeType` (="weather_fees")`, feeSchedule` (object)`, makerBaseFee` (=1000)`, takerBaseFee` (=1000)`, umaBond` (="500")`, umaReward` (="2")`, customLiveness, umaResolutionStatuses, resolvedBy, acceptingOrders, acceptingOrdersTimestamp, gameStartTime, rewardsMinSize` (=50)`, rewardsMaxSpread` (=4.5)`, rfqEnabled, holdingRewardsEnabled, secondsDelay` (=0)`, marketMakerAddress` (="")`, active, closed, archived, restricted, approved, ready, funded, cyom, competitive, submitted_by`.

**Schema-critical quirks (verified):**
- `outcomes`, `outcomePrices`, `clobTokenIds`, `umaResolutionStatuses` are **JSON-encoded STRINGS**, not arrays: `"[\"Yes\", \"No\"]"`, `"[\"0.34\", \"0.66\"]"`. Parse twice. `clobTokenIds[0]` = YES token, `[1]` = NO token (token ids are ~77-digit decimal strings — store as TEXT).
- `orderPriceMinTickSize` **varies per bucket within one event**: NYC Jun 11 has both `0.01` (mid buckets) and `0.001` (tail buckets). Seoul/London buckets: `0.001`. **Read per-market, never hardcode.**
- `feeSchedule` object: `{ "exponent": 1, "rate": 0.05, "takerOnly": true, "rebateRate": 0.25 }` — identical on NYC/Seoul/London/Paris.
- `customLiveness` varies: NYC = 900 s, Seoul/London = 1800 s.
- `questionID` = `negRiskMarketID` with the last byte replaced by the bucket index (e.g. `...c12c00` → `...c12c04` for bucket #4).
- Sample live prices (NYC Jun 11, ~09:00 UTC): `94-95°F` bestBid 0.33 / bestAsk 0.35, `92-93°F` 0.33/0.34, tails at 0.001–0.004. Event `liquidity` ≈ $33.8k, `volume24hr` ≈ $6.3k — thin markets.

**Resolution description VERBATIM (NYC Jun 11; same template everywhere, parameterized by station/units/date):**

> "This market will resolve to the temperature range that contains the highest temperature recorded at the LaGuardia Airport Station in degrees Fahrenheit on 11 Jun '26.\n\nThe resolution source for this market will be information from Wunderground, specifically the highest temperature recorded for all times on this day for the LaGuardia Airport Station, available here: https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA.\n\nTo toggle between Fahrenheit and Celsius, click the gear icon next to the search bar and switch the Temperature setting between °F and °C.\n\nThis market can not resolve until the first data point for the following date has been published on the resolution source.\n\nThe resolution source for this market measures temperatures to whole degrees Fahrenheit (eg, 21°F). Thus, this is the level of precision that will be used when resolving the market.\n\nRevisions to temperatures recorded within this market's timeframe will be considered until the first datapoint for the following date has been published, after which any alterations will not be considered."

Rounding/tie rule: source reports **whole degrees**; buckets are inclusive ranges of whole degrees, so no tie ambiguity (e.g. 93°F → `92-93°F`).

## 3. MARKET TIMING

### VERIFIED (live call) — from `createdAt` of all 136 active events
Creation runs on a fixed UTC schedule, staggered by region, ~2 calendar days ahead:
- **~04:01–04:04 UTC**: APAC cities created for target date T+2 (June 12 markets created June 10 04:0x).
- **~05:01–05:04 UTC**: Europe/MEA/Africa cities for T+2 (London/Paris Jun 12 created Jun 10 05:01).
- **~02:01 UTC (next UTC day)**: Americas cities for T+1 (NYC Jun 11 created Jun 10 02:01 UTC = Jun 9 22:01 EDT — still ~2 local days ahead).

So at any time: **today + tomorrow exist for all 49 cities**; T+2 exists for APAC after ~04:05 UTC and EMEA after ~05:05 UTC; Americas T+2 appears at ~02:05 UTC. A discovery job at **05:10 UTC daily** catches everything new.
- `endDate` is always `T12:00:00Z` on the target date — **nominal only, not the trading close** (CLOB `end_date_iso` even says `T00:00:00Z`). Markets keep `acceptingOrders: true` through the whole target day until resolution.
- `gameStartTime` = **local midnight that begins the target day**, in UTC: NYC Jun 11 → `2026-06-11 04:00:00+00` (00:00 EDT); Seoul Jun 11 → `2026-06-10 15:00:00+00` (00:00 KST). Useful as a per-city timezone anchor.
- Resolution timing: NYC June 9 event `closedTime: 2026-06-10T05:30:49Z` = **01:30 EDT, ~1.5 h after local midnight** (next-day datapoint publish → UMA proposal → 900 s liveness → close). All 11 buckets closed 05:28–05:30 UTC; winning bucket `80-81°F` → `outcomePrices "[\"1\", \"0\"]"`.

## 4. CLOB PUBLIC DATA
All endpoints tested with the NYC `94-95°F` YES token (`token_id=61638227082964537649662368411687439511942921458548889466240160277608387937107`) and `condition_id=0x84be0dbd38c2ce4d6d83a2e54fe40cbb74dddeb097344d284dfef6ddb578f91c`. **All 200 without auth.**

### VERIFIED (live call)
- `GET https://clob.polymarket.com/book?token_id={id}` → `{ market, asset_id, timestamp` (ms string)`, hash, bids: [{price, size}], asks: [{price, size}], min_order_size: "5", tick_size: "0.01", neg_risk: true }`. All numbers are strings. **Ordering: bids ascending / asks descending — best quote is the LAST element of each array.** Sample: 21 bid levels, 40 ask levels.
- `GET /price?token_id={id}&side=buy` → `{"price":"0.33"}`; `&side=sell` → `{"price":"0.36"}`. **Observed semantics: `side=buy` = best bid (buy side of book), `side=sell` = best ask.**
- `GET /midpoint?token_id={id}` → `{"mid":"0.345"}`.
- `GET /spread?token_id={id}` → `{"spread":"0.03"}` (exists, works).
- `GET /markets/{condition_id}` → full market, **no auth**. Snake_case fields: `enable_order_book, active, closed, accepting_orders, minimum_order_size: 5, minimum_tick_size: 0.01, condition_id, question_id, question, description, market_slug, end_date_iso, game_start_time, seconds_delay, fpmm: "", maker_base_fee: 1000, taker_base_fee: 1000, neg_risk: true, neg_risk_market_id, neg_risk_request_id, rewards: {rates, min_size: 50, max_spread: 4.5}, is_50_50_outcome, tokens: [{token_id, outcome, price, winner}], tags`. CLOB tags include `"Daily Temperature"` and `"Highest temperature"`.
- `GET /prices-history?market={token_id}&interval=1d&fidelity=10` → `{ history: [{t: epoch_seconds, p: price}] }` (41 points) — useful for backfilling intraday price paths.
- **No rate-limit headers** in responses (Cloudflare-fronted; `cf-cache-status: DYNAMIC`). Limits are documented, not advertised per-response.

## 5. DOCS RESEARCH (docs.polymarket.com)

### FROM DOCS — Fees (cross-checked against live market objects)
- Source: `https://docs.polymarket.com/trading/fees.md`. **Weather is a fee-charging category in 2026.**
- Category table: Crypto 0.07, Sports 0.03, Finance/Politics 0.04, **Economics/Culture/Weather/Other/Mentions/Tech 0.05**, Geopolitics 0. Maker fee 0 everywhere; maker rebate 25% (20% crypto). **"Makers are never charged fees. Only takers pay fees."**
- **Formula (verbatim): `fee = C × feeRate × p × (1 - p)`** in USDC, C = shares, p = price; symmetric around 50¢. "Fees are calculated and applied at match time by the protocol — you do not need to include fee information in your orders."
- Worked example for the blueprint: take 100 shares of YES at p=0.34 → fee = 100 × 0.05 × 0.34 × 0.66 = **$1.12 ≈ 3.3% of the $34 notional**. This materially raises the edge threshold for taker entries; resting maker orders pay nothing and earn 25% rebates.
- Live confirmation: every weather market has `feesEnabled: true, feeType: "weather_fees", feeSchedule: {rate: 0.05, exponent: 1, takerOnly: true, rebateRate: 0.25}`. (Raw `maker_base_fee/taker_base_fee = 1000` is a legacy field — the operative source of truth is `feeSchedule` / the docs table; there is also `GET /api-reference/market-data/get-fee-rate`.)
- Gas/relayer: orders are off-chain signed; settlement is relayer-mediated (relayer `/submit` rate limit exists). **UNVERIFIED: exact gas economics — docs fees page doesn't state them; assume $0 direct gas for CLOB trading, gas only for deposits/withdrawals/redemptions.**

### FROM DOCS — Rate limits (`/api-reference/rate-limits.md`)
- Gamma: general 4,000 req/10s; `/events` 500/10s; `/markets` 300/10s; `/tags` 200/10s; `/public-search` 350/10s.
- Data API: general 1,000/10s; `/trades` 200/10s; `/positions` 150/10s; `/closed-positions` 150/10s.
- CLOB market data: `/book` 1,500/10s; `/books` 500/10s; `/price` 1,500/10s; `/prices` 500/10s; `/midpoint(s)` 1,500/500 per 10s; `/prices-history` 1,000/10s.
- CLOB trading: `POST /order` 5,000/10s burst, 120,000/10min sustained; `POST /orders` 2,000/10s; `DELETE /cancel-all` 250/10s. Relayer `/submit` 25/min.
- Enforcement: Cloudflare throttling (delayed, not rejected), sliding windows. Plenty of headroom for polling 49 cities × 11 buckets via `/book` every few seconds; batched `/books` exists.

### FROM DOCS — Trading auth & SDK
- L1 = EIP-712 wallet signature; headers `POLY_ADDRESS, POLY_SIGNATURE, POLY_TIMESTAMP, POLY_NONCE`; used to create/derive API creds (`POST https://clob.polymarket.com/auth/api-key` or `client.createOrDeriveApiKey()` → `{key, secret, passphrase}`).
- L2 = HMAC-SHA256; headers `POLY_ADDRESS, POLY_API_KEY, POLY_PASSPHRASE, POLY_SIGNATURE, POLY_TIMESTAMP`; required for order post/cancel/open-orders/balances.
- Signature types: `0` EOA, `1` POLY_PROXY (email/Magic), `2` GNOSIS_SAFE, `3` POLY_1271.
- **VERIFIED (live npm):** `@polymarket/clob-client` latest = **5.8.1**, last published 2026-06-02 — actively maintained.
- Order types: limit **GTC, GTD** (expiration needs ~60 s buffer); "market" orders are **FOK/FAK** helpers (`createMarketOrder`/`createAndPostMarketOrder`; BUY sized in dollars, SELL in shares). No true market order. Tick sizes 0.1/0.01/0.001/0.0001; **orders must pass `negRisk: true` in options for these markets** or they're rejected.

### FROM DOCS — negRisk mechanics (`/advanced/neg-risk.md`)
- Temperature events are winner-take-all multi-outcome (`negRisk: true`, shared `negRiskMarketID`). The **NegRiskAdapter** converts **1 NO share in bucket i → 1 YES share in every other bucket** atomically — betting against one bucket ≡ betting on all others; this is the collateral-efficiency mechanism when holding multiple buckets / NO positions. `negRiskAugmented: false` on these events (fixed outcome set at creation; no placeholder buckets). Adapter/exchange contract addresses live in the docs Contracts section.

### FROM DOCS + VERIFIED — data-api.polymarket.com
- **VERIFIED live:** `GET https://data-api.polymarket.com/trades?market={conditionId}&limit=3` → array: `{proxyWallet, side: BUY|SELL, asset, conditionId, size, price, timestamp` (epoch s)`, transactionHash, title, outcome, eventSlug, ...}`.
- **VERIFIED live:** `GET /positions?user={proxyWallet}` → array with exact fields: `proxyWallet, asset, conditionId, size, avgPrice, initialValue, currentValue, cashPnl, percentPnl, totalBought, realizedPnl, percentRealizedPnl, curPrice, redeemable, mergeable, negativeRisk, oppositeAsset, oppositeOutcome, outcome, outcomeIndex, title, slug, eventId, eventSlug, endDate, icon`. Perfect for paper-vs-live P&L reconciliation later.
- From docs: `/closed-positions` and a User PNL API also exist.

### FROM DOCS — Geo-restrictions (`/api-reference/geoblock.md`)
- 33 fully blocked countries incl. **US, UK, France, Germany, Italy, Netherlands, Belgium** (most of Western Europe); Poland, Singapore, Thailand, Taiwan close-only; Japan frontend-only block (API open); Ontario + Crimea/Donetsk/Luhansk regional blocks. "Orders submitted from blocked regions will be rejected."
- **Sweden is NOT on the blocked list per current docs.** No KYC threshold documented for standard API trading (KYC/KYB mentioned only for `eu-west-2` co-location access).
- **UNVERIFIED/UNCERTAIN:** EU regulatory posture is in flux (multiple EU states added over 2025-2026); re-verify Sweden's status against the live geoblock list immediately before enabling live trading — paper trading is unaffected.

## 6. RESOLUTION MECHANICS

### VERIFIED (live call)
- Resolver: **UMA CTF adapter**, `resolvedBy: 0x69c47De9D4D3Dad79590d61b9e05918E03775f24` on every market; `umaResolutionStatuses` transitions `"[]"` → `"[\"proposed\"]"` (still "proposed" after close — terminal disputes would append).
- Weather markets override UMA defaults: **`umaBond: "500"` (USDC), `umaReward: "2"`, `customLiveness: 900 s (NYC) / 1800 s (Seoul, London)`** — i.e. a 15–30 min challenge window instead of the standard 2 h.
- Observed end-to-end latency: target day ends at local midnight → first next-day datapoint on Wunderground → proposal → liveness → **`closedTime` ~01:30 local (1.5 h after midnight)** for NYC June 9.
- Markets cannot resolve before the following date's first datapoint is published; post-finalization revisions ignored (verbatim rules in §2).

### FROM DOCS (`/concepts/resolution.md`)
- General flow: propose (bond) → challenge window → if disputed twice, escalate to UMA DVM token-holder vote (~48 h voting; 4–6 days worst case). Default bond $750 / 2 h liveness — weather uses the smaller/faster custom values above. Winning bondholder gets stake back + half the loser's bond.

### VERIFIED (news search) — the April 2026 Paris incident
Real, well-documented manipulation: bettors physically heated the Météo France sensor at Paris-CDG (LFPG) on April 6 and 15, 2026 (≈3°C artificial spike; ~$34k total winnings; Météo France filed a criminal complaint). **Polymarket did not refund the resolved markets but switched the Paris station — live-verified: Paris markets now resolve via Le Bourget (`.../fr/bonneuil-en-france/LFPB`).**
Architectural consequence: **`resolutionSource` is mutable per city over time — the pipeline must re-read the station URL from each day's event JSON and key calibration history by station, not by city.**
Sources: Euronews, NPR, CoinDesk, Blockhead, Yahoo Finance, fibo-crypto, Jezebel, CBC (April 2026).

## Top blueprint-impacting facts (one-line recap)
1. Discovery = Gamma `events?tag_id=104596&active=true&closed=false` paginated by 100, filter `endDate >= today`; 49 cities live, created T+2 (APAC 04:00, EMEA 05:00, Americas 02:00 UTC).
2. **Weather markets charge a 5% taker fee** (`fee = shares × 0.05 × p × (1-p)`, taker-only, 25% maker rebate) — maker-style entries are strongly favored; this must be inside the edge/Kelly math.
3. `outcomes/outcomePrices/clobTokenIds` are stringified JSON; tick size varies per bucket (0.01 vs 0.001); `orderMinSize` 5 shares; all negRisk winner-take-all groups.
4. Resolution = Wunderground station daily-history page (whole degrees), UMA-proposed with $500 bond and 15–30 min liveness, closing ~1.5 h after local midnight; stations can and do change (Paris → LFPB), so re-read `resolutionSource` daily and calibrate per station.
