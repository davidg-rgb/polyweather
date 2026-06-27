> Research input for the opening-convergence bracket bot — consumed by ARCHITECTURE-OPENING-CONVERGENCE.md. Additive reference; do not block the architect on it.

# Polymarket CLOB — Bracket-Execution Mechanics (implementation reference)

> Compiled 2026-06-27 from the live Polymarket developer docs (docs.polymarket.com), the official @polymarket/clob-client-v2 / py-clob-client-v2 SDKs, the Polymarket agent-skills repo, and Help-Center articles. Cross-checked against the project's own live-verified research/REPORT-polymarket-api.md (2026-06-10) and MAKER-REBATE-HANDOFF.md. Every numeric/endpoint claim is cited inline. Inferences are tagged UNVERIFIED.

---

## 0. HEADLINE: the CLOB went to V2 on 2026-04-28 — the §9R "clob-client v5.x" assumption is STALE

This is the single most build-critical finding and it reframes everything below.

- Polymarket cut over to CLOB V2 (new CTF Exchange contracts + new pUSD collateral) on 2026-04-28 ~11:00 UTC. The migration wiped all open orders and there is no backward compatibility: "V1 SDKs and orders do not work against V2." [v2-migration]
- The bracket bot MUST use @polymarket/clob-client-v2 (latest 1.0.6) — NOT @polymarket/clob-client v5.x. I verified both on npm: @polymarket/clob-client latest = 5.8.1 (the V1 line — still published, hence the project's 2026-06-10 report saw it and called it "actively maintained"), and @polymarket/clob-client-v2 latest = 1.0.6. Python: use py-clob-client-v2 (legacy py-clob-client deprecated post-2026-04-22). [npm; v2-migration; cheatsheet]
- The project does not currently depend on any clob-client package (grep of all package.json -> no match), so this is greenfield — pin clob-client-v2 from the start.

### V2 order struct (EIP-712 signed) — what changed
| | V1 | V2 |
|---|---|---|
| Signed fields | salt, maker, signer, taker, tokenId, makerAmount, takerAmount, expiration, nonce, feeRateBps, side, signatureType | salt, maker, signer, tokenId, makerAmount, takerAmount, side, signatureType, timestamp, metadata, builder |
| Removed | — | nonce, expiration, feeRateBps, taker |
| Added | — | timestamp (ms, replaces nonce for uniqueness), metadata (bytes32), builder (bytes32) |
| Exchange EIP-712 domain | version "1" | version "2", verifyingContract = 0xE111180000d2663C0091e4f400237545B87B996B |
| NegRisk Exchange (weather is negRisk!) | — | 0xe2222d279d744050d28e00520010520000310F59 |

[cheatsheet; v2-migration]. ClobAuth domain (API-key derivation) stays version "1" — unchanged.

Three consequences the architect must bake in:
1. Fees left the signed order. "Fees are determined by the protocol at match time, not embedded in your signed order. Remove manual fee-calculation logic." Query market params via the new unified call getClobMarketInfo(conditionId). [v2-migration]
2. expiration left the signed struct but still rides the wire. The migration doc: "expiration remains in the POST /order wire body for GTD/order-expiry handling, but is not part of the EIP-712 signed struct." So GTD still works (the bot's time-stop is safe) — see §1. [v2-migration]
3. Collateral is now pUSD (ERC-20 on Polygon, 1:1 USDC-backed), not USDC.e. The bot's on-chain approvals must target the V2 Exchange + NegRisk Exchange contracts and the pUSD token, not the old ones. [help/14762452]

---

## 1. ORDER TYPES — GTC / GTD / FOK / FAK

All four survive into V2. Definitions are verbatim from the create-order doc: [create-order]

| Type | Behavior (verbatim) | Class |
|---|---|---|
| GTC Good-Til-Cancelled | "rests on the book until filled or cancelled" — default for limit orders | maker / resting |
| GTD Good-Til-Date | "active until a specified expiration time" — auto-expires at a timestamp | maker / resting |
| FOK Fill-Or-Kill | "must fill immediately and entirely, or cancel" — all-or-nothing | taker / immediate |
| FAK Fill-And-Kill | "fills what's available immediately, cancels the rest" — partial allowed | taker / immediate |

Create/post params (SDK createAndPostOrder(orderArgs, options, orderType)): [create-order; order-patterns]
- tokenID — the YES/NO ERC-1155 token id (the ~77-digit clobTokenIds[i], NOT conditionId).
- price — limit price; must conform to the market tick size (§2) or the order is rejected.
- size — shares (limit orders). For market orders use amount: BUY = dollars to spend, SELL = shares. For market orders price is the "worst-price limit (slippage protection), not target execution price."
- side — Side.BUY / Side.SELL.
- orderType — OrderType.GTC | GTD | FOK | FAK.
- options.tickSize — "0.1" | "0.01" | "0.001" | "0.0001" (pass the market's; §2).
- options.negRisk — true for every weather market (they are negRisk winner-take-all; omitting/wrong-valuing this gets the order rejected — confirmed in the project's prior report).
- expiration (GTD only) — UTC seconds. The 60s security buffer is SERVER-enforced and the SDK does NOT add it (CONFIRMED §9.3: `buildOrderCreationArgs.js` is pure pass-through). For an effective lifetime of N seconds the caller must set expiration = floor(Date.now()/1000) + 60 + N explicitly; a GTD with expiration 0 is server-rejected. [create-order; order-patterns; §9.3]
- options.builderCode / builder (optional) — fee-attribution; ignore unless joining the builder program.
- post_only (optional, GTC/GTD only, 3rd positional bool on postOrder) — "Guarantee maker status. If order would cross the spread, it's rejected." [order-patterns]

V2 SDK shapes (@polymarket/clob-client-v2, viem-based): [clob-client-v2 README]
```ts
const client = new ClobClient({ host, chain: Chain.POLYGON, signer: walletClient, creds, throwOnError: true });
await client.createAndPostOrder({ tokenID, price: 0.40, size: 100, side: Side.BUY },
                                { tickSize: "0.01", negRisk: true }, OrderType.GTC);
await client.createAndPostMarketOrder(...);   // FOK/FAK helper
```
Note: the V2 constructor is an options object (was positional); chainId->chain; tickSizeTtlMs removed; throwOnError:true raises ApiError{message,status,data}. [v2-migration]

### Recommendation for the bracket engine
- (a) Maker resting entry -> GTC with post_only. CONFIRMED native (§9.2): post_only is the 4th positional arg — `createAndPostOrder(userOrder, options, OrderType.GTC, true)` (`dist/client.d.ts:125`), GTC/GTD-only (rejects on FOK/FAK). It guarantees you never cross and pay taker fees on entry (the bot's edge depends on free maker entry, §7). No local bestAsk-guard fallback needed. If you want the entry to self-cancel if unfilled by a deadline, use GTD instead (entry-side time-stop for free) — but you set its expiration with the caller-owned +60s buffer (§9.3).
- (b) Taker exit when a bracket fires -> FAK (marketable limit) with a worst-price limit. FAK takes whatever depth exists and cancels the remainder — it will not hang a resting order, and it tolerates thin books (FOK would kill the entire exit if full size isn't available at once, which is the wrong behavior for a stop-loss/time-stop in a thin weather book). Set the price slippage guard a few ticks through the bid for SL/time-stop urgency.
- TP nuance worth exploiting: a take-profit can instead be a resting GTC SELL (maker, $0 fee + rebate-eligible) parked at the profit target — free to exit if it fills. Keep SL and time-stop as FAK takers (guaranteed-ish exit, pays fee). This makes the only fee-paying leg the loss/forced exits, which is exactly where you want to spend fees.

---

## 2. TICK SIZE & MIN ORDER SIZE

- Tick sizes are one of 0.1 / 0.01 / 0.001 / 0.0001 and vary per bucket within one event — the project's live data showed NYC mid-buckets at 0.01 and tail buckets at 0.001. Never hardcode; read per-token. [create-order; project REPORT-polymarket-api §2]
- Fetch tick size: client.getTickSize(tokenID) (TS) / client.get_tick_size(token_id) (py); also present on the V1 /book response (tick_size) and in getClobMarketInfo() (V2, minimum_tick_size). [order-patterns; v2-migration]
- Rounding rule: prices must align exactly to the tick; an off-tick price is rejected (not silently rounded). Round your computed bid/ask to the token's tick before signing.
- Min order size: "Minimum order size exists but varies by market." Live weather data showed orderMinSize = 5 shares (minimum_order_size: "5" on /book) and a separate rewardsMinSize = 50 (reward-eligibility threshold, not an order floor). [create-order; project REPORT-polymarket-api §2,§4]. UNVERIFIED (post-V2): exact V2 minimums per weather market — re-confirm via getClobMarketInfo(conditionId) -> minimum_order_size / minimum_tick_size before sizing. Polymarket also commonly enforces a $1 minimum notional; treat max(5 shares, $1) as the safe floor until measured.
- Max order size = balance - sum(openOrderSize - filledAmount). [create-order]
- Violating min-size or tick -> order rejected with an ApiError (in V2, surfaced via throwOnError). Validate locally first to avoid burning rate-limit budget on rejects.

---

## 3. CANCEL / REPLACE

Endpoints (all L2-authenticated, off-chain, gasless, processed instantly): [cancel; order-patterns]

| Scope | REST | TS SDK | py SDK |
|---|---|---|---|
| Single | DELETE /order body {"orderID":"0x…"} | cancelOrder("0x…") | cancel("0x…") |
| Multiple | DELETE /orders body ["0x…","0x…"] | cancelOrders([...]) | cancel_orders([...]) |
| All | DELETE /cancel-all (no body) | cancelAll() | cancel_all() |
| By market | DELETE /cancel-market-orders body {"market":"0xcondId","asset_id":"tokenId"} (both optional) | cancelMarketOrders({market, asset_id}) | cancel_market_orders(...) |

- Response: { canceled: [orderIds], not_canceled: { orderId: reason } } — always check not_canceled (a cancel can race a fill and fail). [cancel]
- NO atomic replace/amend exists. Moving a resting maker bid = cancel-then-repost. (No amend endpoint in the docs, the agent-skills patterns, or the clob-client-v2@1.0.6 method list. UNVERIFIED only in the sense of "absence of evidence" — confirm by grepping the V2 SDK for modifyOrder/amend; none expected.)
- Race implication (design-critical): between cancel and the re-post, your bid is off the book — you can be jumped in the queue or miss a fill. Worse, the cancel may fail because the order just filled (not_canceled), so a naive "cancel->repost new price" can double your position if you assume the cancel succeeded. The reprice loop MUST: (1) issue cancel, (2) read canceled vs not_canceled, (3) only repost the unfilled remainder computed from the latest size_matched (§4), (4) reconcile against open-orders before assuming state. Keep reprices infrequent — the weather books are thin and re-quoting churns queue priority.
- auto-cancel-on-disconnect: maintain a heartbeat every 5 s; "if a valid heartbeat is not received within 10 s (with up to a 5-s buffer), all your open orders are cancelled." Relevant if you hold resting maker entries — a flaky bot loses its book. [order-patterns]

---

## 4. PARTIAL FILLS — status fields, polling vs websocket

User websocket channel (the right tool for fill events): [user-channel; agent-skills/websocket]
- URL: wss://ws-subscriptions-clob.polymarket.com/ws/user (docs also show …/ws with "type":"user" in the subscribe body — use the documented /ws/user + auth body).
- Subscribe/auth body (L2 creds): { "auth": { "apiKey", "secret", "passphrase" }, "markets": ["0xcondId", …], "type": "user" }. markets is optional — omit to receive all markets. Server-only (never ship creds client-side).
- Two event categories:
  - order lifecycle — type in {PLACEMENT, UPDATE, CANCELLATION}. Fields: id (order id), asset_id, market, owner, side, price, original_size, size_matched, outcome, timestamp. Partial fills arrive as UPDATE events; size_matched is the cumulative matched qty against original_size.
  - trade lifecycle — status transitions MATCHED -> MINED -> CONFIRMED (terminal), with RETRYING and FAILED (terminal) branches. Fields: id, asset_id, market, side, size, price, status, outcome, taker_order_id, and a maker_orders[] array (order_id, matched_amount, price, outcome, owner) naming the matched counterparties.

Polling fallback / reconciliation source of truth (§5): getOpenOrders() and getOrder(id) expose the same original_size / size_matched / status. Treat the websocket as the low-latency feed and a periodic getOpenOrders() sweep as the authoritative reconcile — a fill is only "real" once trade.status = CONFIRMED (MATCHED can still go RETRYING/FAILED).

Design-critical consequences for the bracket engine:
- Entry GTC can partially fill. Brackets (TP/SL/time-stop) must be armed against the actual cumulative size_matched, not the requested size. Re-arm/resize on every UPDATE.
- Exit FAK can partially fill (takes available depth, kills the rest). After an exit fires, re-check the position — leftover inventory needs the exit re-fired until flat. Do not assume one FAK flattens the position in a thin book.
- A CANCELLATION event (or not_canceled on a cancel) that races a trade means your local position changed — always recompute from size_matched + confirmed trades.

---

## 5. IDEMPOTENCY, OPEN-ORDER & POSITION RECONCILIATION

There is no server-side client-order-id / idempotency key. Uniqueness of a signed order comes from its salt (random uint256) plus, in V2, the timestamp (ms) field — both are generated by the SDK at sign time, so two retries of "the same" intent produce two different, both-valid orders unless you dedup yourself. The returned orderID is a server-side hash you learn after posting, so you can't pre-compute it to guard a retry. [cheatsheet; v2-migration]

=> The bot must own its idempotency + crash-safety:
1. Persist every intended order with a local UUID + state (PENDING_POST -> POSTED(orderID) -> FILLED/CANCELLED) before calling createAndPostOrder. On any retry, check local state + live open-orders before re-posting.
2. On startup, reconcile before posting anything:
   - Open orders: client.getOpenOrders({market?, asset_id?}) (py get_orders(OpenOrderParams())), L2 -> REST GET /orders. Response fields: id, status, market, asset_id, side, original_size, size_matched, price, outcome, order_type, maker_address, owner, expiration, associate_trades, created_at. Statuses: live | matched | delayed | unmatched. [orders-overview]
   - Single order: client.getOrder("0x…") (same fields). [orders-overview]
   - Positions (inventory truth): GET https://data-api.polymarket.com/positions?user={proxyWallet} -> {asset, conditionId, size, avgPrice, curPrice, currentValue, cashPnl, percentPnl, redeemable, mergeable, negativeRisk, oppositeAsset, outcome, …}; plus /closed-positions. (Live-verified in the project's prior report.) [project REPORT-polymarket-api §"data-api"]
3. Rebuild each open bracket from (open orders + confirmed trades + positions), then resume.

UNVERIFIED: whether the V2 user-websocket subscribe requires anything beyond the same L2 creds — assume identical {apiKey,secret,passphrase} (no V2-specific change documented). Confirm by connecting once and observing the ack.

---

## 6. RATE LIMITS (documented)

Over-limit requests are throttled/queued by Cloudflare, not rejected — but design to the ceilings. [rate-limits; project REPORT-polymarket-api §5]

Trading (per IP/key):
| Endpoint | Burst | Sustained |
|---|---|---|
| POST /order | 5,000 / 10 s | 120,000 / 10 min (~200/s) |
| DELETE /order | 5,000 / 10 s | 120,000 / 10 min |
| POST /orders (batch <=15) | 2,000 / 10 s | 21,000 / 10 min |
| DELETE /orders | 2,000 / 10 s | 15,000 / 10 min |
| DELETE /cancel-all | 250 / 10 s | 6,000 / 10 min |

Market data: /book 1,500/10s · /books (batch) 500/10s · /price 1,500/10s · /midpoint(s) 1,500/10s · /prices-history 1,000/10s. Gamma (discovery): /events 500/10s, general 4,000/10s. [rate-limits]

For a bot watching ~46 stations × ~11 buckets, batch reads (/books) and a few-second poll sit at a rounding error of budget (the project already polls every 5 min). Reads are never the binding constraint — order churn (cancel/repost loops) is the only place you could approach a limit, and 200 orders/s sustained is ample.

---

## 7. FEES & MAKER REBATES (CONFIRMED CURRENT — and a correction)

Current schedule (exchange-wide as of 2026-04-03, per-category fees expanded 2026-03-30): [trading/fees; help/13364471; project REPORT-polymarket-api §5]

- Formula (verbatim): fee = C × feeRate × p × (1 − p), C = shares, p = price, in USDC/pUSD. Symmetric around 50c; max dollar fee at p=0.50, ->0 near 0.01/0.99.
- Weather feeRate = 0.05 (taker). (Table: Crypto 0.07 · Sports 0.03 · Finance/Politics/Tech/Mentions 0.04 · Economics/Culture/Weather/Other 0.05 · Geopolitics 0.) Confirms the project's "weather_fees 5%" finding.
- Makers are NEVER charged a fee. "Only takers pay fees." A maker fill = $0 fee. (This is the certain, bankable part of the bot's edge.)
- Maker rebate = 25% for weather (20% crypto). Correction to the project's "5%/25%" shorthand: the 25% is NOT a guaranteed per-fill 25%-of-taker-fee credit. Per the Maker-Rebates help article it is a daily, pro-rata pool redistribution, "at the sole discretion of Polymarket and may change over time," paid daily in USDC, $1 minimum accrued to pay out, and split fee-curve-weighted by "the share of liquidity you provided that actually got taken" — your_fee_equivalent / total_fee_equivalent × rebate_pool per market. No volume tiers. [help/13364471]
  => For the edge math: bank only the $0 maker fee on entry as certain. Treat the ~25% rebate as probable upside, not a deterministic per-fill credit. (The project's §12 sim that modeled rebateRate:0.25 as a fixed per-fill amount slightly overstates realized maker economics — MAKER-REBATE-HANDOFF.md §3a's "+~6pp swing" is a ceiling, not a guarantee.)
- Net per leg for THIS bot:
  - Entry (maker, post_only GTC): fee $0; rebate = variable daily upside.
  - Exit (taker, FAK): pays C × 0.05 × p_exit × (1−p_exit). Worked: exit 100 sh at p=0.50 -> $1.25 on $50 notional = 2.5%; at p=0.34 -> $1.12 on $34 = 3.3%; at p=0.15 -> $0.64 on $15 = 4.25%. The take-profit threshold must clear the exit taker fee + spread, and because the bot enters cheap (center bucket, low p) and exits richer, the fee is modest-but-real. Making TP a resting maker SELL (§1) removes the fee on winning exits and leaves it only on SL/time-stop.
- Fees are applied by the protocol at match time — you do NOT put fee fields in V2 orders. Gas: CLOB trading is off-chain-signed/relayer-settled — assume $0 direct gas for post/cancel/match; gas only on deposit/withdraw/redeem. [v2-migration; project report §5]

---

## 8. AUTH RECAP (one paragraph)

L1 = wallet (private key) EIP-712 signature over the ClobAuth domain (version "1", unchanged in V2); used once to create/derive API creds via client.createOrDeriveApiKey() -> {key, secret, passphrase} (REST POST /auth/api-key). L2 = HMAC-SHA256 using those creds (headers POLY_ADDRESS, POLY_API_KEY, POLY_PASSPHRASE, POLY_SIGNATURE, POLY_TIMESTAMP); required for all order post/cancel, open-orders, single-order, balances, and the user websocket. Market-data reads (/book, /price, …) and Gamma discovery need no auth. Signature types: 0 EOA · 1 POLY_PROXY (email/Magic) · 2 GNOSIS_SAFE · 3 POLY_1271. The order itself is separately EIP-712-signed over the V2 Exchange domain (version "2", contract 0xE111…996B; NegRisk 0xe222…0F59) — this is the part the V1 SDK gets wrong, which is why V2 SDK is mandatory (§0). [authentication; cheatsheet; v2-migration]

---

## 9. Verification ledger — RESOLVED 2026-06-27 against published @polymarket/clob-client-v2@1.0.6

Verified by `npm pack`-ing clob-client-v2@1.0.6 (into scratchpad, not the repo) and reading its `dist/*.d.ts`/`.js`, the canonical docs Contracts page, and a live CLOB probe today. Citations are file:line in the extracted package.

1. **clob-client-v2 mandatory — ✅ RESOLVED.** docs.polymarket.com/v2-migration: "Legacy V1 SDKs and V1-signed orders are no longer supported on production." Use `@polymarket/clob-client-v2` (1.0.6) / `py-clob-client-v2`.
2. **post_only — ✅ RESOLVED, native.** Positional boolean, NOT an options field: `createAndPostOrder(userOrder, options?, orderType?, postOnly?: boolean, deferExec?: boolean)` (`dist/client.d.ts:125`); also on `postOrder`/`postOrders` (`:129-130`). Runtime guard rejects post_only on FOK/FAK (`dist/client.js:531`) → GTC/GTD only. Wire field `readonly postOnly: boolean` (`dist/types/ordersV2.d.ts:33`). Maker entry call: `createAndPostOrder({tokenID,price,size,side:Side.BUY},{tickSize:"0.01",negRisk:true},OrderType.GTC,true)`. **No bestAsk-guard fallback needed.**
3. **V2 GTD — ✅ RESOLVED, with a build gotcha.** `expiration` is a top-level `UserOrderV2` field (unix seconds, default 0 = none; `dist/types/ordersV2.d.ts:61-63`), carried to the wire as `readonly expiration: string` (`:25`). **GOTCHA: the SDK does NOT add the 60s buffer** — `buildOrderCreationArgs.js:24,38` is pure pass-through, no `+60`, no validation. The 60s threshold is server-enforced, so the BOT must compute `expiration = floor(Date.now()/1000) + 60 + N` itself and set it explicitly (GTD with expiration 0 is server-rejected; the SDK won't catch it). Time-stop viable; **caller owns the buffer math.**
4. **No amend/replace — ✅ CONFIRMED.** Grep of `dist/client.d.ts` for `amend|modify|replace|editOrder|updateOrder` → none. Mutating surface = createAndPostOrder/createAndPostMarketOrder/postOrder/postOrders + cancelOrder/cancelOrders/cancelAll/cancelMarketOrders. **Cancel-then-repost (remainder-only) is the only reprice path.**
5. **V2 min size / tick — ✅ RESOLVED (live today).** Probe of `highest-temperature-in-nyc-on-june-27-2026`: CLOB `/book` → `min_order_size:"5"`, `tick_size:"0.01"`, `neg_risk:true`; `/markets/{cond}` → `minimum_order_size:5`, `minimum_tick_size:0.01`; Gamma → `orderMinSize:"5"`, tick 0.01 mid / 0.001 tails (per-bucket). SDK: `getClobMarketInfo(conditionID)` → `MarketDetails{mos?,mts,fd?,r,nr?}` (`dist/client.d.ts:74`; `dist/types/clob.d.ts:253-271`). **Safe floor = max(5 sh, $1), tick 0.01 mid / 0.001 tails — unchanged on V2.**
6. **Realized maker rebate magnitude — ⚠ STILL OPEN (inherently).** Daily pro-rata discretionary pool — unknowable ex-ante. Measure actual daily USDC payouts after live maker fills; do NOT bank it in the entry edge (§7).
7. **User-websocket V2 auth parity — ⚠ STILL OPEN (low risk).** Assume identical L2 creds; no V2-specific change documented. Confirm on first connect (observe the ack).
8. **pUSD approval flow — ✅ RESOLVED.** Don't hardcode — `getContractConfig(137)` ships them (`dist/config.js:11-22`): exchangeV2 `0xE111180000d2663C0091e4f400237545B87B996B`, negRiskExchangeV2 `0xe2222d279d744050d28e00520010520000310F59`, collateral/pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (6 decimals; docs Contracts page labels it "pUSD — CollateralToken (proxy)"), conditionalTokens `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`, negRiskAdapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`. Approve via the helper, not raw approve(): `updateBalanceAllowance({asset_type: AssetType.COLLATERAL})` before buying; `updateBalanceAllowance({asset_type: AssetType.CONDITIONAL, token_id})` before selling a bucket (`dist/client.d.ts:121-122`; `dist/types/clob.d.ts:182-189`). The pUSD address coincides with Ethereum's legacy SAI address but two Polymarket sources agree for Polygon — using `getContractConfig().collateral` sidesteps it.

**Net:** nothing contradicts the §9R locked params beyond "V2 SDK mandatory" (already flagged). post_only entry, GTD time-stop, pUSD approvals, and the 5-share min are all confirmed-viable. The one NEW implementation note for the architect: **the caller must own the 60-second GTD expiration buffer** (item 3). Startup-reconcile (§5) is fully supported as written: `getOpenOrders`, `getOrder`, `getMarketTradesEvents`, `deriveApiKey` all present in `dist/client.d.ts`.

---

## Sources
- Create Order — https://docs.polymarket.com/developers/CLOB/orders/create-order
- Orders overview (open/single order, statuses) — https://docs.polymarket.com/developers/CLOB/orders/orders
- Cancel Order — https://docs.polymarket.com/trading/orders/cancel
- User WebSocket channel — https://docs.polymarket.com/market-data/websocket/user-channel
- Rate limits — https://docs.polymarket.com/api-reference/rate-limits
- Fees — https://docs.polymarket.com/trading/fees
- Maker Rebates Program — https://help.polymarket.com/en/articles/13364471-maker-rebates-program
- CLOB V2 migration — https://docs.polymarket.com/v2-migration
- Exchange upgrade (pUSD, Apr 28 2026) — https://help.polymarket.com/en/articles/14762452-polymarket-exchange-upgrade-april-28-2026
- Authentication — https://docs.polymarket.com/developers/CLOB/authentication
- Polymarket agent-skills (order-patterns, websocket) — https://github.com/Polymarket/agent-skills
- @polymarket/clob-client-v2 — https://github.com/Polymarket/clob-client-v2 · npm 1.0.6
- @polymarket/clob-client (V1) — npm 5.8.1 (latest dist-tag)
- Polymarket cheatsheet (struct/EIP-712/V1->V2/contracts) — https://github.com/cengizmandros/polymarket-cheatsheet
- Project cross-checks — research/REPORT-polymarket-api.md (2026-06-10), MAKER-REBATE-HANDOFF.md
