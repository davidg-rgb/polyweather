# Opening-Convergence Bot — Architecture Blueprint

> Generated from: `OPENING-CONVERGENCE-HANDOFF.md` (esp. §5 scope, §6 reuse, §7 risk, §8 boundary, §9R locked parameters)
> Date: 2026-06-27
> Status: **BUILD-READY** (Phase-9 Full self-review converged 3→1→0 CRITICAL; then a 4-lens agent-team loop hardened it over 10 rounds — 28+21+18+19+9+14+16+13+10+14 validated findings, all resolved at their homes; see `REVIEW-opening-convergence.md` + §17 first…tenth pass). **The loop is ASYMPTOTIC — REAL did not converge (…13→10→14; round 10 re-surfaced 2 CRITICAL incl. 1 new). RECOMMENDATION: STOP the review loop and BUILD** — the residual is the class implementation + tests surface concretely + cheaply; the build is paper-first with hard downstream gates (Phase-0.5 spike, Phase-5 paper PASS, first-N review). Gated on the Phase-0.5 signal-availability spike before any execution, and the Phase-5 paper PASS before any capital.
> Output note: this is a **module blueprint on a mature codebase**, deliberately NOT the 200 KB system
> `ARCHITECTURE.md`. It blueprints ONE scoped rail reactivation (opening convergence) and nothing else; the
> other eleven falsified signals stay dead (`FINDINGS.md`).

---

## Table of Contents

1. Executive Summary
2. Requirements Analysis
3. Architecture Decision Records
4. Tech Stack
5. Project Structure
6. Module & Function Definitions
7. Data Models
8. Interface Contracts
9. Data Flow Diagrams
10. Dependency Map
11. Cross-Cutting Concerns
12. Extensibility Guide
13. Risk Register
14. Implementation Roadmap
15. Build Verification Checklist
16. Research-Driven Corrections (CLOB V2 + capture cadence) — **read before building §6.3 + §6.10**
17. Team-Review Remediations (10 passes — 28/21/18/19/9/14/16/13/10/14 validated findings) — **authoritative; read with §6/§7/§8**

---

## 1. Executive Summary

An **autonomous buy/sell bracket bot** that captures freshly-listed Polymarket daily-Tmax weather markets at
their **flat open** (every °C bucket ~10–12% because the book is uninformed), buys the buckets our
`house_gaussian` forecast says are the center while they are cheap, and **sells them back into the
convergence** via bracket orders (take-profit / stop-loss / hard time-stop) — capturing the re-rating, not
needing to hit the exact temperature.

This reopens the trading rail for **one** scoped, tested lever — the only signal in twelve that survived its
cheap kill gate (`OPENING-CONVERGENCE-HANDOFF.md` §3). The decisive unmeasured number — **flat-open depth +
net-of-cost edge at executable depth** — can only be measured forward, by capturing markets *at listing*. So
**the build is also the experiment**: the keyless capture layer is the forward harness, and the bot runs
**paper-first** until a frozen, pre-registered net-profit gate clears (§9-E / ADR-OC-10).

The system has three runtimes, deliberately separated:

| Layer | Runtime | Holds key? | Cadence | Mirrors |
|-------|---------|-----------|---------|---------|
| **Capture** (`opening-capture` edge fn) | Supabase Deno edge + pg_cron | No (keyless) | **~2–3 min first-seen poll** (§16-D — window is ≤~1h) | `cross-venue-capture` |
| **Execution** (`opening-bot` loop) | Node process on a small **VPS**, always-on | **Yes** (`POLY_PRIVATE_KEY`, signer only) | continuous tick (~30 s) | new (bracket loop) — reuses `trading` boundary + `live.ts` signer construction |
| **Monitoring** (`/bot` page) | Next.js RSC on Vercel | No | on request | `/data` |

**The load-bearing unknown is whether the signal even exists in the window.** On the current forecast
cadence (`snapshot-forecasts`/`build-distributions` run 2×/day; `discover-markets` 5×/day), a freshly-listed
market usually has **no `house_gaussian` distribution while it is still flat-open** — so the naive "buy the
center our forecast says is cheap, at the flat open" cannot fire as-is. The build resolves this two ways
(ADR-OC-14): capture **seeds the distribution on-demand** for the scoped liquid-city universe (snapshot the
station's forecast now → build the dist for that event), and **Phase 0.5 is a hard go/no-go spike** that
proves a *usable* `house_gaussian` coincides with a *still-flat* book before any execution layer is built. If
it doesn't, this signal KILLs cheaply in the spike — the same discipline that closed the other eleven.

**Safety is the dominant axis, not features.** Bugs spend real money, so the architecture foregrounds:
paper-default, hard exposure caps re-checked atomically under a Postgres lock at fill time, a daily-loss kill
switch + `bot_enabled` flag checked every tick, idempotent order placement (never double-fill on
retry/restart), reconcile-from-DB-and-venue on startup, a dedicated tiny wallet, and a key boundary where
**Claude never places a trade, never handles the key** — the operator funds the wallet, holds the key in
`.env.local`, and authorizes runs (§8, ADR-OC-11).

**Scale of the build:** 8 new modules of orchestration (entry scanner, bracket engine,
position manager, Node signer, risk guard, loop driver, the first-N approval gate (§6.8), the startup reconcile (§6.12) — the capture handler is the keyless edge fn, counted below), 1 pure core sim module (signal + frozen gate), 1
keyless edge fn (capture + on-demand signal seed), 1 migration (`0066`: **9 tables** — `opening_captures`,
`bot_positions`, `bot_orders`, `bot_loop_lease`, `bot_gate_snapshot`, `bot_tick_log` (F19 liveness),
`bot_bankroll` (F14 live caps source), `bot_daily_kill` (F32 latched daily-loss stop), `bot_circuit_state` (F11
persisted breaker counter) — + lifecycle/caps RPCs + dash RPC + the capture + deadman crons), 1 dashboard page, 3 scripts
(paper backtest + forward driver + the Phase-0.5 go/no-go spike `opening-spike.ts` — F15-r9). Paper mode is fully functional with zero key and zero real money.

---

## 2. Requirements Analysis

### 2.1 Core Features

Decomposed from `OPENING-CONVERGENCE-HANDOFF.md` §5 (functional scope) + §9R (locked parameters).

- **F-OC-01 · Capture freshly-listed markets at/near listing, seeding our forecast on-demand.** Forward,
  keyless, on a cron: snapshot each open near-dated Polymarket temperature ladder's full bucket distribution +
  **true CLOB depth** (walked, not the vol proxy) + listing age + flat-open flag, append-only into
  `opening_captures`. Because `house_gaussian` is usually absent while a market is still flat-open (the
  forecast cadence is 2×/day), for a flat-open event in the **scoped liquid-city universe** the capture
  **ensures the event is discovered and seeds a current `house_gaussian` on-demand** (snapshot the station's
  forecast now → `buildDistributionForEvent`) before reading it onto the row. A capture whose signal cannot be
  seeded stores `houseProb=null` (logged, not entered). *(Handoff §5-A; ADR-OC-14)*
- **F-OC-02 · Flat-open detection.** Flag a capture as a flat-open candidate when `peak bucket mid ≤ 18%`
  AND it is `within ~1h of listing` (§16-D — the real flat-open window is ≤~1h, superseding §9R-B's ~6h). *(§9R-B / §16-D)*
- **F-OC-03 · Entry selection.** For a flat-open market, select `house_gaussian` **mode ± 1** (3 buckets)
  where the executable ask is **below our model prob by a margin**, never above a **20%** hard cap; size each
  per the per-position cap. *(§9R-B)*
- **F-OC-04 · Maker-first entry with taker fallback.** Rest a GTC limit near mid (cheaper + maker rebate); if
  unfilled within a window, cancel and take. *(§9R-B)*
- **F-OC-05 · Bracket exit engine.** Per open position: take-profit when `mark ≥ entry + 25pp OR ≥ model
  prob`; stop-loss when `mark ≤ entry − 12pp`; **hard time-stop: flatten by lead-0 local noon**, never hold
  into resolution. Taker exit when a bracket fires. *(§9R-C)*
- **F-OC-06 · Idempotent order placement.** No double-fills on retry/restart: a DB intent ledger
  (`client_order_id` dedupes our own rows), placement **never auto-retried**, and a **tight place→record
  critical section** so the crash window is minimal. The CLOB exposes no client-order-id (C3/ADR-OC-5), so
  venue reconcile is **heuristic** (token + side + price + size + time-window), not by our id. *(Handoff §5-C)*
- **F-OC-07 · Reconcile open state on startup.** On boot, rebuild in-flight positions/orders from the DB
  (source of truth) and the live CLOB (open orders + held positions) via heuristic matching, never from memory.
  *(Handoff §5-C)*
- **F-OC-14 · Partial-fill handling.** A partially-filled entry arms brackets on the **filled** portion, sizes
  the exit to the **actually-held** shares, and on a maker window-expiry keeps the filled partial (arms it) +
  cancels the remainder; the entry price is the size-weighted blend of any maker-partial + taker-remainder.
  *(Handoff §5-C — explicit "partial-fill handling")*
- **F-OC-08 · Risk controls.** Per-position / per-market / total-concurrent exposure caps ($10–25 / $40 /
  $100), re-checked atomically at fill; a **daily-loss kill switch** (−$30 or −25% of bankroll); paper /
  dry-run default; an **instant manual kill** (`bot_enabled` flag) checked every tick; a full audit ledger of
  every intent + fill. *(§9R-A / §9R-D / Handoff §5-D)*
- **F-OC-09 · Paper / dry-run mode (default).** A deterministic pessimistic paper executor (no key, no money)
  that measures flat-open depth + net edge forward — the experiment. *(§9R-F / Handoff §7-2)*
- **F-OC-10 · Net-profit validation gate.** A frozen, pre-registered verdict: paper → real only when net
  positive after fees + measured slippage over **≥40 markets** with the clustered 95% CI **excluding 0**, AND
  a zero-skill Monte-Carlo passes <5% of the time. *(§9R-E)*
- **F-OC-11 · Monitoring dashboard.** A `/bot` page (operator-only): live positions, fills, realized +
  unrealized PnL net-of-fees, per-market outcomes, the running paper-gate verdict; alerts via the existing
  Slack alarm. *(Handoff §5-E)*
- **F-OC-12 · First-N human approval.** Fully autonomous within caps, but the **first ~10 real trades** are
  proposed for one-click operator approval before placement; then flip to full auto. *(§9R-D)*
- **F-OC-13 · Account connection boundary.** A dedicated, separately-funded Polymarket wallet; the signing key
  is supplied via env/secret at runtime, read only by the signer, never surfaced. *(§8 / §9R-F)*

### 2.2 User Roles & Journeys

There is exactly **one human role: the Operator** (David). No multi-tenant surface.

- **J-1 · Operator funds + connects the wallet.** Creates a dedicated Polymarket wallet, funds it small
  ($100–200), places `POLY_PRIVATE_KEY` into `.env.local` on the VPS. *(F-OC-13)*
- **J-2 · Operator runs paper-first.** Starts `opening-bot --mode paper`; capture cron fills the panel; the
  bot paper-trades; the operator watches `/bot` until the gate (F-OC-10) reads PASS over ≥40 markets / ≥2
  weeks. *(F-OC-09 → F-OC-10)*
- **J-3 · Operator flips to small-real with approval.** Sets `tradingMode=live` + `bot_enabled=true`; the
  bot proposes the first ~10 real trades; the operator one-clicks each on `/bot` (or Slack); then full auto.
  *(F-OC-12)*
- **J-4 · Operator monitors + can instant-kill.** Watches `/bot`; flips `bot_enabled=false` (or the Slack
  pause) to halt all placement within one tick. *(F-OC-08, F-OC-11)*
- **J-5 · Operator scales (or kills).** If +EV holds ≥2 weeks live small-scale, raises caps; else KILL and
  the rail returns DORMANT. *(§9R-E)*

The **bot itself** is the autonomous actor inside the caps (J-machine): tick → kill-check → scan → place →
manage brackets → reconcile → alert.

### 2.3 Constraints

- **C-1 · Real-money autonomy.** A bug spends money. Every placement path must be idempotent, capped, and
  reversible to a halt within one tick.
- **C-2 · The edge is unproven at the load-bearing state** (flat-open depth). Paper-first is mandatory; no
  capital until F-OC-10 clears. *(Handoff §7-2)*
- **C-3 · Forecast dependence at our worst horizon** (lead 1–2 within-1° = 69% vs market 82%). The signal
  must be robust to being wrong on the exact bucket → center ± 1 + sell-into-convergence, not hold. *(§7-5)*
- **C-4 · Adverse selection on exit** (`WALLET-RECON-HANDOFF.md` §12 — resting cheap and getting picked off).
  The maker/taker choice + bracket logic must be designed against it. *(§7-3)*
- **C-5 · Runtime split.** Capture is keyless (edge/cron); execution holds a key + a stateful loop → a
  persistent VPS Node process, not a stateless edge fn. *(§7-4)*
- **C-6 · `target_date` is station-local, not UTC.** The time-stop "lead-0 local noon" must resolve in the
  station's timezone. The Gamma parser already returns a station-local `targetDate`; the bot must NOT treat it
  as UTC midnight. *(LEARNINGS 2026-06-22 — `0004_markets.sql:11` is station-local)*
- **C-7 · Reachability.** Gamma/CLOB are reachable from Sweden / a EU VPS (no 403 — the 403 was a *cloud
  edge* run only, `OPENING-CONVERGENCE-HANDOFF.md` §6). Capture runs on Supabase edge (already proven via
  `cross-venue-capture`); execution runs on the VPS.
- **C-8 · Reuse, don't rebuild** (Handoff §6): the Gamma/CLOB parsers, `executableAsk`, the fee curve, the
  `TradeExecutor` boundary, the Node signer construction from `trading/live.ts`, the Slack plumbing, the
  `runJob`/`claim_job_run` cron idiom, the migration+RPC+cron pattern, and `/data`'s dashboard idiom.

### 2.4 Integrations

- **Polymarket Gamma API** (`gamma-api.polymarket.com`, tag `104596`) — event/market metadata, bestBid/Ask,
  `feeSchedule` (rate/takerOnly/rebateRate), `negRiskMarketID`. Parsed by `parseGammaEvent` (§6 reuse).
- **Polymarket CLOB** (`clob.polymarket.com`) — `/book` (true depth), `/prices-history` (mark series),
  order placement/cancel/status via **`@polymarket/clob-client-v2`** (signer — CLOB V2, §16-A).
- **Polymarket Data API** (`data-api.polymarket.com`) — `/positions` (reconcile held shares),
  `/trades`/`/activity` (fills). Parsed by `packages/io/polymarket-wallet.ts` (reuse).
- **`house_gaussian` forecast distribution** — read from `bucket_probabilities` (source `house_gaussian`),
  produced by `snapshot-forecasts` → `build-distributions`. **Reality (C1, verified):** this runs only 2×/day
  and writes a row only once forecasts exist for a *discovered* event with a mapped station — so a market is
  usually still flat-open with **no** `house_gaussian` yet. The bot therefore **seeds it on-demand** for the
  scoped liquid-city universe (the stations are mapped and Open-Meteo is fetchable any time) — see ADR-OC-14.
  This is the bot's entry-signal input and the build's first proving question (Phase 0.5).
- **Supabase** (`lenysiqxihsmxljvyybt`, eu-north-1) — Postgres (state of record), edge fn (capture), pg_cron.
- **Slack** — alerts + the global pause gate (reuse `whale-watch` plumbing + `_shared/slack notifySlack`).
- **Vercel** — the `/bot` dashboard.

### 2.5 Open Questions / Resolved Ambiguities

All §9 clusters were resolved into §9R (operator-confirmed 2026-06-27). The architect-level ambiguities
that remained, and their resolutions (see the matching ADR):

- **OQ-1 (→ ADR-OC-1): Where does the bracket orchestrator live** — extend the Deno-targeted `packages/trading`
  or a new Node package? **Resolved: new `packages/bot`** (Node runtime; `trading` stays Deno-edge-shaped, its
  boundary types are reused).
- **OQ-2 (→ ADR-OC-5): Idempotency mechanism** for placement under retry/restart. **Resolved: DB intent ledger
  + client-minted order id + never-auto-retry + venue reconcile** (mirrors `live.ts` never-retry + adds the
  pre-placement intent row).
- **OQ-3 (→ ADR-OC-4): Position state of record** — memory or DB? **Resolved: DB (`bot_positions`) is the
  source of truth**; the loop is stateless across restarts; CAS state transitions.
- **OQ-4 (→ ADR-OC-12): Time-stop timezone.** **Resolved: station-local via `localHourInstant(tz, targetDate, noon)`**
  (the bracket time-stop instant — F5-r8; `localDayWindow` is only for a genuine day-window), never UTC (C-6).
- **OQ-5 (→ ADR-OC-10): The net-profit gate's significance test.** **Resolved: clustered-by-market t-CI
  excluding 0 + a zero-skill Monte-Carlo (<5%)** — mirrors `crossVenueVerdict` + the LEARNINGS statistical-gate
  rule.
- **OQ-6 (→ ADR-OC-6): Maker-fill model in paper.** **Resolved: a position fills maker only if the live book's
  best ask trades through the resting limit in a later capture tick** (a conservative, adverse-selection-aware
  proxy — never assume a maker fill).
- **OQ-7 (→ ADR-OC-8): Two loop instances.** Could the operator start the bot twice? **Resolved: a DB
  singleton lease** (`bot_loop_lease`, CAS with expiry) so a second instance refuses to place; **plus** a
  self-chaining tick (no in-process overlap) and a partial-unique open-position constraint (W2).
- **OQ-8 (→ ADR-OC-14): Is the forecast signal available while the market is still flat-open?** The decisive
  unknown (C1). **Resolved: no, not on the stock cadence — so capture seeds it on-demand for the scoped
  universe, AND Phase 0.5 is a hard go/no-go spike** that measures whether a usable `house_gaussian` coincides
  with a still-flat book + cheap center depth, before any execution is built.
- **OQ-9 (→ ADR-OC-13): The flat-open vs approval race.** A pre-placement human approval would let the cheap
  entry converge away before the click (W5). **Resolved: pre-authorize the strategy/params up front; the
  first-N is a fast POST-fill review (place within caps, surface, halt-able)** — the flat-open entry is never
  delayed by approval latency.

---

## 3. Architecture Decision Records

**ADR-OC-1 — New `packages/bot` Node orchestrator (not an extension of `packages/trading`).**
*Decision:* the bracket loop, position manager, Node signer, entry scanner, and risk guard live in a new
`packages/bot` targeting the Node runtime.
*Alternatives:* (a) extend `packages/trading` — rejected: `trading/live.ts` is shaped for the **Deno edge
runtime** (its `createClobClient` uses non-literal dynamic `npm:` specifiers resolved by Deno at run time,
invisible to Node); a persistent Node VPS loop is a different runtime with a different client-construction
path, and folding it in would pollute the Deno package. (b) a `scripts/` driver only — rejected: the bracket
engine + position manager + signer warrant unit-tested modules, not a script.
*Why:* clean runtime separation; `packages/trading`'s **boundary types** (`TradeExecutor`, `FillResult`,
`ApprovedBet` shape) and its **never-auto-retry** discipline are reused conceptually. **⚠ CORRECTED by §16-A:
the Node signer is NET-NEW on `@polymarket/clob-client-v2@1.0.6` (viem), NOT a mirror of `createClobClient()` —
`trading/live.ts` is the V1 line (`@polymarket/clob-client@4` + ethers) which no longer trades on CLOB V2 (cut
over 2026-04-28).** It reads the same `POLY_PRIVATE_KEY`/`POLY_SIGNATURE_TYPE`/`POLY_FUNDER_ADDRESS` env, but
the SDK/collateral(pUSD)/contracts/approvals are V2. *Consequence:* the bot depends on `@weather-edge/core` +
`@weather-edge/io` + (optionally) `@weather-edge/trading` types; it is the only package that imports
`@polymarket/clob-client-v2` for Node.

**ADR-OC-2 — Capture stays keyless on Supabase edge/cron; execution is the only key-holder.**
*Decision (cadence CORRECTED by §16-D — a ~2–3 min first-seen poll, NOT `*/10`):* the capture layer is a new Deno edge fn `opening-capture`, structurally a clone
of `cross-venue-capture` (read-only Gamma/CLOB walk → `record_opening_captures` RPC → append-only table).
*Alternatives:* fold capture into the VPS loop — rejected: capture needs no key and benefits from Supabase's
already-proven cron + `claim_job_run` idempotency + 24/7 uptime independent of the VPS; and it must run even
while the bot is paper/halted (the forward experiment).
*Why:* the capture table is the **shared contract** between the keyless harness and the key-holding executor;
it decouples "measure the edge" from "trade the edge." *Consequence:* two independent loops; the bot's entry
scanner reads `opening_captures`, never re-walks the universe itself.

**ADR-OC-3 — Signal + frozen gate are a pure `core/sim/opening-convergence.ts` module (no `trading` import).**
*Decision:* flat-open detection, entry selection, the bracket decision function, the paper-fill model, and the
frozen net-profit verdict are pure + total functions in `packages/core/src/sim/opening-convergence.ts`,
mirroring `cross-venue-arb.ts`.
*Why:* keeps the analytics/decision logic unit-testable with no network and no key, and lets the **same**
functions drive the paper backtest, the forward paper loop, AND the live loop — one source of truth for "what
would we do." *Consequence:* `packages/bot` (impure wiring) and the capture handler and the scripts all import
these pure functions; the live rail's behaviour is a thin shell over tested pure logic.

**ADR-OC-4 — `bot_positions` is the position state of record; the loop is stateless across restarts.**
*Decision:* every position's lifecycle (intent → maker-resting → filled → bracket-armed → exiting → closed) is
a row in `bot_positions` with an explicit `state` column; state transitions are **CAS** (`UPDATE … WHERE
state = <expected>`), never a TS-side read-modify-write.
*Alternatives:* in-memory position map — rejected: a VPS restart mid-position would orphan it (the 2026-06-01
"reconcile from persisted state" lesson; the imagined memory recovery is false). *Why:* survives restart;
makes reconcile (F-OC-07) a DB read + a venue cross-check; a CAS transition is the idempotency primitive for
the bracket lifecycle. *Consequence:* the bracket engine is pure (computes the *desired* action); the position
manager applies it via CAS so two ticks can't double-act on one position.

**ADR-OC-5 — Idempotent placement: a pre-placement intent ledger + never-auto-retry + a tight critical section; venue reconcile is HEURISTIC (the CLOB has no client-order-id).**
*Decision:* before any `placeOrder`, the manager writes a `bot_orders` row with a **client-minted UUID**
(`client_order_id`, UNIQUE) and `status='intent'`, places, then immediately records the returned `orderID`
(the place→record critical section is kept minimal). Placement is **never automatically retried** on error
(inherits `live.ts:136-150` — position→failed + CRITICAL, no silent double).
*Correction (C3/F27, verified `research/REPORT-clob-bracket-execution.md` §0+§5):* the V2 signed order DOES carry
a `metadata` (bytes32) field, but it is **NOT a server-queryable idempotency key** — `getOpenOrders`/`getOrder`
don't echo it, and uniqueness is `salt`+`timestamp` minted at sign time; the order's only server-side identity
is the `orderID` returned *after* posting. So `client_order_id` **dedupes our own DB rows only; no client-order-id
round-trips through the venue.** On restart, reconcile therefore matches resting venue orders to `intent`/`placed`
rows **heuristically** by `(tokenId+side exact, price within 1 tick, size within minOrderSize, recency window)` — explicitly fuzzy.
*Alternatives:* trust the venue to echo our id — rejected: it cannot (verified). *Why:* a crash between
"decided to place" and "recorded the orderID" must not re-place on reboot; the intent row + heuristic match +
never-retry bound the exposure. *Consequence:* a `placed`-but-no-`clob_order_id` row is a heuristic-reconcile
target, not a re-place; the residual risk (a placed order we cannot positively match) is surfaced as a
reconcile WARNING for the operator, never silently re-placed.

**ADR-OC-6 — Maker entry with taker fallback; conservative maker-fill model in paper.**
*Decision:* entry rests a GTC limit at `min(mode-bucket best ask − 1 tick, our model prob − margin)` (cheaper +
**$0 maker fee**, and rebate-eligible); if unfilled within `makerFillWindowMin`, cancel and take the ask ONLY if the LIVE ask still clears the entry gate `liveAsk ≤ min(cfg.maxEntryPrice, modelProb − entryEdgeMargin)` (F8-r10 — by window-end the flat-open book is CONVERGING (the thesis), and a resting BUY is left unfilled precisely when the book runs UP, so the clock-only take would systematically buy the risen ask ABOVE the operator-locked 20% cap; re-gate against the live ask AND set the taker FAK's worst-price limit = that cap so it fills 0 rather than buying above cap; skip reason 'converged_no_take'). In
**paper**, a resting maker limit is deemed filled only if a *later* capture tick shows the live best ask ≤ the
resting price (the book traded through it) — never assumed.
*Why:* maker entry banks the **$0 maker fee** with certainty + the lower entry price — that is the certain
margin; the `weather_fees` 25% rebate is **probable upside from a daily discretionary pro-rata pool the gate
measures, never assumes** (refined by §16-C / I-10 — NOT a per-fill 25% credit). `WALLET-RECON` §12 proved
resting cheap is adversely selected — so paper must *measure* the real fill rate, not grant it. *Consequence:*
the paper executor's maker path is pessimistic-by-construction; the live executor's maker path cancels+takes
on the window, bounding adverse selection.

**ADR-OC-7 — Brackets: TP +25pp-or-model / SL (−12pp OR relative) / hard station-local-noon time-stop; taker exit.**
*Decision:* the locked §9R-C parameters, in a pure `bracketDecision(position, mark, nowUtc, tz, cfg)`. The
time-stop is computed in **station-local** time via `localHourInstant(tz, targetDate, noon)` (DST-correct —
F11/§17-F11, NOT `startUtc+12h`), flattening by local noon of lead-0. Bracket fires → taker (FAK) exit
(certainty > spread saved); TP MAY instead rest as a free maker SELL (§16-C). **SL is the TERNARY `(entry−12pp >
0) ? entry−12pp : entry×(1−slFrac)`** — the §9R-C-locked −12pp absolute stop WHEREVER it is positive (entry >
0.12), falling to the relative floor (entry×(1−slFrac)) ONLY for the cheapest band where −12pp is inert; **NOT a
`max(...)`**, which would take the tighter relative stop for the ENTIRE (0.12, 0.20] universe and silently
override the operator-locked −12pp (the bug §6.1 names — F1-corrected; F13/§17-F13).
A market that resolves while still held is settled via `resolveHeldPosition` (F4/§17-F4), not left stuck.
*Why:* every loser ends at 0 — the gain exists only on a mid-life exit; the time-stop is the mandatory backstop
(Handoff §3, §9R-C). *Consequence:* a position is never held into resolution UN-accounted; a missed time-stop is
a CRITICAL (best-effort given venue uptime — I-9) and the resolution path books it if it slips.

**ADR-OC-8 — Absolute-$ exposure caps re-checked atomically at fill; a daily-loss kill that includes open MTM + `bot_enabled` flag + a loop lease.**
*Decision:* a `bot_fill_with_caps` RPC (mirroring the existing `fill_bet_with_caps`, `0019:30-118`, which uses
the **transaction-scoped** `pg_advisory_xact_lock` — pool-safe, verified) re-derives the bot's bankroll +
per-position/per-market/total-concurrent headroom and records the fill only if every cap holds — a TS-side
pre-check outside the lock would re-open the TOCTOU (W17).
*Cap units + bankroll source (I-11):* the bot uses **absolute-dollar** caps ($10–25 / $40 / $100 per §9R-A),
NOT the existing `%-of-bankroll` model; its "bankroll" is the **bot's own tracked balance** — paper: a config
`bot.paperBankrollUsd` minus open+realized; live: the **exposure/caps** denominator is **total EQUITY = free pUSD (`Signer.getCollateralBalance()`,
§16-A — V2 collateral is pUSD) + Σ marked held-position value**, while the **`killLossPct` daily-loss threshold is
PINNED to the day-start `bot.bankrollBaseUsd` snapshot** (a fixed $ for the day — NOT floating equity, which
shrinks as you lose → a moving target; F17/§17-F9b) — neither uses the floating free-cash balance (which shrinks
as entries spend into tokens → a premature kill — §17-F9b). Read at startup + periodically into `bot_bankroll` (free/held/equity/base) — **separate from
`bankroll_ledger`** (which serves the dormant `bets` rail). (`free_pusd` is ALSO the separate F38 free-cash
spend-ceiling input — a buy is gated on free pUSD covering cost+fee+reserve, distinct from this equity caps
denominator.)
*Daily-loss kill (W3/W3b/F32/F37):* `entryGate` calls `bot_should_run`, which checks `bot_enabled`, the
Slack-pause halt key, and **today's realized loss PLUS the mark-to-market unrealized loss of SHARE-HOLDING
positions** (entry_shares>0 — unfilled 'intent'/'maker_resting' rows hold zero shares and contribute 0, NOT a
phantom worst-case that would self-wedge the kill while maker entries merely rest — F37) vs the −$30/−25%
threshold — so a book full of underwater-but-unexited positions trips the breaker. Each held position's
unrealized contribution is FLOORED at 0 (`max(0, cost − mark)`) so a concurrent WINNER's positive MTM can never
mask already-booked realized losses (F32). The MTM is marked from the **loop's fresh per-position `/book` marks**
(gathered each tick in `manageBrackets`/`decideForPosition`), NOT the `opening_captures` table — which is
universe-wide (it does NOT cut off at flat-open: §6.10 step 2 captures every near-dated in-universe event for its
full life), but LAGS ~2–3 min and can stop emitting for a held market that drops below the vol floor mid-hold
(F7); a mark older than `markMaxAgeMin` falls back to a **conservative worst-case** so staleness can only
over-state drawdown, never hide it. **Once breached for the trading day the kill LATCHES** in `bot_daily_kill`
(boundary = `bot.killDayTz`) — it does NOT un-trip on intraday MTM recovery (F32), preserving §9R-D's "down for
the day = done". **The kill (and the manual `bot_enabled`/Slack pause) gates ONLY new-entry
placement — NEVER exits/management** (Pass-3 W3b-ordering fix): freezing exits would strand underwater
positions into resolution (the very R-4 loss the kill prevents) and a reboot-while-holding would self-wedge.
`manageBrackets` (marks + brackets + time-stop + flatten) runs every tick unconditionally; only the
`bot_loop_lease` CAS (single-instance) can abort a whole tick.
*Why:* caps + kill must be **atomic with the fill**, not advisory; the kill must see drawdown, not just
realized; the lease prevents two loops. *Consequence:* placement is gated — pre-tick (`bot_should_run` incl.
MTM + lease), pre-place (cap headroom estimate), at-fill (the RPC, authoritative).

**ADR-OC-9 — Paper mode is the default and the forward experiment.**
*Decision:* `tradingMode` defaults to `paper`; the paper executor produces deterministic pessimistic fills
(worse of stored/live walked ask + `paperSlippage`, mirroring `PaperExecutor`) and writes the same
`bot_positions`/`bot_orders` rows with `mode='paper'`. *Why:* the build IS the experiment — paper measures
flat-open depth + net edge forward before any capital (C-2). *Consequence:* the entire pipeline (scan →
place → brackets → close → PnL → gate) runs end-to-end with no key and no money; live mode swaps only the
signer.

**ADR-OC-10 — A frozen, pre-registered net-profit gate: city-clustered CI-excl-0 + a zero-skill Monte-Carlo.**
*Decision:* `openingVerdict(panel, opts)` returns PASS only if, over **≥40 closed paper markets** (the §9R-A
volume bar) spanning **≥ MIN distinct cities and dates**, the **city-clustered** mean net P&L per market (after
fees + measured slippage) has a 95% t-CI **excluding 0**, the win-fraction clears a floor, AND a zero-skill
Monte-Carlo (shuffle which buckets we entered) passes the same bar <5% of the time.
*Two distinct sample sizes (I-8):* the **≥40-markets** bar is the data-sufficiency floor; the **CI's effective
df is the number of CITIES (≈6–10)** because rows are clustered by city (same as `crossVenueVerdict`) — both
are reported, and the gate states them separately so a "40 markets" reading is never mistaken for the t-test's N.
*Provenance (I-7, corrected):* the **city-clustered t-CI** mirrors `crossVenueVerdict`
(`cross-venue-arb.ts:609-675`) — which is clustered-CI **only, with no Monte-Carlo**. The **zero-skill MC** is
the separate LEARNINGS statistical-gate standard (2026-06-10/22 — a point threshold passes on noise ~30% of
the time), added here to make this gate *stricter* than `crossVenueVerdict`, not a copy of it.
*Why:* this is the one reopened rail — the gate must be at least as strict as every kill gate that closed the
other eleven. *Consequence:* `/bot` shows the live verdict; real money is blocked until PASS. The maker-rebate
credit (I-10) is a **measured** input to the net P&L, never an assumed credit — REC-8/`MAKER-REBATE-HANDOFF`
never confirmed it pays net on weather, so the gate must earn it from realized fills.
*Few-cluster caveat (F28/§17-F28):* a naive `t(#cities−1)` CI under-covers at C≈6–10 (narrow CI → easier false
PASS); for C<~15 use a wild-cluster bootstrap (or CR2 + Satterthwaite df) or a cluster-PRESERVING permutation MC
as the binding calibration, and the verdict reason states a marginal `ciLow>0` at 6 cities is not a true 95%
guarantee. Same fix applies to the shared `crossVenueVerdict`.

**ADR-OC-11 — Key boundary: `POLY_PRIVATE_KEY` lives only in the signer, read at runtime, never surfaced.**
*Decision:* the Node signer (`NodeClobSigner`) is the ONLY module that reads `POLY_PRIVATE_KEY`
(`.env.local`, guard-secrets hook). It is never logged, echoed, committed, or returned. A §15 grep invariant
forbids the key name and `@polymarket/clob-client-v2` outside the signer file. Claude builds the software; the
operator funds + holds the key + authorizes runs; the bot the operator runs signs.
*Why:* §8 non-negotiable. *Consequence:* every other module receives a narrow `Signer` port (place/cancel/
status/openOrders), never the key; paper mode injects a `PaperSigner` that needs no key.

**ADR-OC-12 — All resolution/time-stop math is station-local, keyed on the city's real IANA tz NAME (not an offset).**
*Decision:* the capture row stores the station's **IANA tz name** (e.g. `Australia/Sydney`), read from the
existing **`cities.tz`** column the rest of the system uses (`discover-markets/handler.ts:93-100,139`); the
bracket time-stop passes that **name** to `localHourInstant(tz, targetDate, noon)` (F5-r8/F11 — DST-correct, NOT `localDayWindow(...).startUtc + 12h`, which flattens ~12h early off local MIDNIGHT; matches §6.1/§7/§17-F11). `hours_since_listing` is a tz-independent duration (`now − created_at_gamma`), not a day-window computation.
*Correction (C2, verified):* `localHourInstant` (and `localDayWindow`) route through the module-private `assertTimezone` (`time.ts:16-24,45-56`) which **throws on
anything but a valid IANA name** — so a bare offset (`2.0`) is type- and DST-wrong. And `parseGammaEvent` only
sets `derivedTzOffset` when `!knownTz` (`gamma.ts:293-295`), i.e. **never for the known liquid cities** we
target. So the offset is the wrong source on both counts; `cities.tz` is the right one.
*Second correction (C2b, verified):* `cities.tz` is IANA-typed (`0002_reference.sql:21`) but auto-discovered
cities are populated as `etcZoneForOffset(offset)` = a fixed-offset **`Etc/GMT±N` zone with NO DST**
(`risk.ts:169-172`; e.g. Amsterdam is stored `Etc/GMT-2`, `amsterdam-truth-backfill.ts:31`). `assertTimezone`
**accepts** `Etc/*` (Intl-valid), so a no-DST zone would sail through and `localDayWindow` would compute a
DST-wrong (≤1h) noon. So the fail-closed guard must **explicitly reject `Etc/`-prefixed zones** (require a real
DST-aware IANA name), AND the §9R liquid cities' `cities.tz` must be corrected to real IANA names (a Phase-0
data step) before any live time-stop.
*Why:* C-6 — `target_date` is station-local; a UTC/offset-derived noon flattens Sydney ~11h early / US-west
~8h late, and an `Etc/*` zone still DST-skews by ≤1h (the 2026-06-22 trap, attenuated). *Consequence:* a
position whose `cities.tz` is absent OR `Etc/*` is **not entered** (fail closed), surfaced as a `no_tz` skip;
`tz_offset_hours` is dropped from the model.

**ADR-OC-13 — Strategy pre-authorized up front; the first-N real trades are a fast POST-fill review (not a pre-placement gate).**
*Decision:* the operator pre-authorizes the **strategy + parameters** once (sets `tradingMode=live` +
`bot_enabled=true`); the bot then **places the first ~10 live entries immediately within caps** and surfaces
each filled position for **post-fill review** (Slack ACTION + `/bot` row) with a one-click **halt/flatten**;
after N, review is off.
*Correction (W5):* a *pre-placement* approval (the prior design) would let the flat-open book converge away in
the minutes before the operator clicks — destroying the very edge being approved. Human eyes on the first live
fills (§9R-D) are preserved by reviewing *after* the (capped, tiny) fill, with an instant flatten, rather than
*before* placement. *Why:* the edge lives in the flat-open window; approval latency cannot sit inside it.
*Throttle (W5b, corrected — F12/§17-F41):* during the first-N, `placeEntries` does not open entry k+1 until
entry k's fill has been **SURFACED** (Slack ACTION raised + `realTradesApproved` bumped) — bounding the burst so
each early live fill is ANNOUNCED one-at-a-time (without this, all ~10 could fill within a tick or two before the
first Slack). **It does NOT block on operator ACKNOWLEDGMENT** — there is deliberately no such gate (W5:
approval latency cannot sit in the flat-open edge window; bot_positions carries no `reviewed` column and the
operator's only controls are flatten/disable, by design). So this is an auto-advancing post-fill NOTIFICATION
throttle, not a human-eyeball checkpoint; blast radius across the un-acknowledged window is bound by the
per-position/per-market/total caps + the latched daily-loss kill, not by a review gate. *Consequence:* paper mode never reviews; the first-N counter is per-bankroll in `config`; the
`bot_enabled` flag + per-fill Slack + flatten action are the operator's controls during the review window. (The
risk caps + daily-loss kill bound the blast radius even if the throttle is relaxed.)

**ADR-OC-14 — Signal availability is the load-bearing unknown: capture seeds `house_gaussian` on-demand, and a Phase-0.5 spike is a hard go/no-go before any execution is built.**
*Decision:* (1) the `opening-capture` fn, on finding a flat-open event in the **scoped liquid-city universe**,
**ensures the event is discovered and seeds a current `house_gaussian` on-demand** — snapshot the station's
Open-Meteo forecast now → `buildDistributionForEvent` for that single event — then reads it onto the capture
row. (2) **Phase 0.5 is a hard go/no-go spike** that, over real captured data, answers: *at the moment a
usable `house_gaussian` first exists for a market, is the book still flat-open (peak ≤ 18%) AND is there cheap
center depth?* If the answer is mostly no, the signal is structurally unexecutable → **KILL the lever in the
spike, cheaply**, before Phases 2–6.
*Correction (C1, verified `_shared/distributions.ts:82,157,177` + `0009_cron.sql:159-162`):* the prior
"discovery tail-seeds the dist within seconds" claim is FALSE — `house_gaussian` is written only when
forecasts exist for a discovered, station-mapped event, and forecasts run 2×/day; a fresh flat-open market has
none. On-demand seeding is feasible **specifically because** the scoped universe is the §9R "6–10 most-liquid
cities," whose stations are already mapped and whose Open-Meteo forecasts are fetchable any time.
*Alternatives:* (a) assume the stock cadence suffices — rejected (verified false). (b) widen to all cities —
rejected: on-demand seeding needs a mapped station, which brand-new cities lack. *Why:* the entry signal must
exist *inside* the flat-open window or the thesis is dead; proving that is cheaper than building execution on
a starved pipeline. *Consequence:* Phase 0 (capture) and Phase 0.5 (the spike) gate the whole build; Phase 0's
DoD becomes "captures carry a seeded `houseProb` for a non-trivial fraction of flat-open events," not merely
"rows accrue."

---

## 4. Tech Stack

| Concern | Choice | Justification |
|---|---|---|
| Language | TypeScript (strict, `noUncheckedIndexedAccess`) | Matches the monorepo; pure modules stay unit-testable. |
| Pure logic | `packages/core` (no I/O) | Existing seam; `sim/opening-convergence.ts` mirrors `sim/cross-venue-arb.ts`. |
| Orchestrator | **new `packages/bot`** (Node 22) | ADR-OC-1: persistent VPS loop + Node signer. |
| Capture | Supabase Edge (Deno) + pg_cron | ADR-OC-2: clone of `cross-venue-capture`. |
| State of record | Supabase Postgres | ADR-OC-4/5/8: positions/orders/caps/kill, CAS + advisory-lock RPCs. |
| Signing | **`@polymarket/clob-client-v2@1.0.6` + `viem` (Node)** | §16-A (CORRECTED): CLOB V2 since 2026-04-28; V1 (`live.ts`) no longer trades. pUSD collateral + V2 contracts. |
| HTTP | `packages/io` `fetchJson` (timeout/retry) | Reuse; the same injected client serves capture + bot + scripts. |
| Alerts | `_shared/slack notifySlack` (DB-deduped) + `io/slack` (CLI) | Reuse `whale-watch` plumbing. |
| Dashboard | Next.js RSC (Vercel) + `dash_bot` jsonb RPC | ADR-OC mirrors `/data`. |
| Tests | Vitest + PGlite twin (`@electric-sql/pglite`) | Same SQL exercised end-to-end (the house idiom). |
| Runtime host (exec) | small EU VPS, always-on | §9R-D / C-5: uptime for the bracket loop. |

New deps: **`@polymarket/clob-client-v2@1.0.6` + `viem`** (§16-A — CLOB V2; the V1 `@polymarket/clob-client`+ethers
that `trading/live.ts` uses no longer trades on production). Per the standing rule, no external API is added
without a free-API-catalog check; none is needed — all endpoints are existing Polymarket surfaces.

---

## 5. Project Structure

```
packages/
  core/src/
    sim/
      opening-convergence.ts        # NEW · pure signal + bracket decision + paper fill + frozen gate (mirrors cross-venue-arb.ts)
      opening-convergence.test.ts   # NEW · unit tests (no network, no key)
  bot/                              # NEW PACKAGE · Node-runtime orchestrator (ADR-OC-1)
    package.json                    # @weather-edge/bot · deps: core, io, trading(types), @polymarket/clob-client-v2, viem (§16-A: V2, NOT V1+ethers)
    src/
      index.ts                      # barrel
      types.ts                      # BotConfig, OpenPosition, OrderIntent, Signer port, BotDeps
      signer.ts                     # NodeClobSigner (ONLY reader of POLY_PRIVATE_KEY) + PaperSigner (ADR-OC-9/11)
      db.ts                         # BotDb port + supabase-js service client factory (Node) — mirrors _shared/db.ts
      entry-scanner.ts              # reads opening_captures + house_gaussian → EntryCandidate[] (impure wiring over pure selectEntries)
      bracket-engine.ts             # thin impure shell over pure bracketDecision: fetch mark, decide, return action
      position-manager.ts           # CAS lifecycle: open → place via Signer → record fill → arm brackets → exit → close
      risk-guard.ts                 # bot_should_run + lease + caps headroom; the kill chokepoint
      approval.ts                   # first-N human-approve gate (ADR-OC-13)
      loop.ts                       # BotLoop.tick(): kill-check → scan → place → manage → reconcile → alert
      reconcile.ts                  # startup: rebuild open state from DB + venue (F-OC-07)
    test/                           # vitest + PGlite twin + mock Signer
  trading/                          # REUSED (boundary types, never-retry discipline) — unchanged
  io/src/polymarket-wallet.ts       # REUSED (positions/trades parsers for reconcile)

supabase/
  functions/
    opening-capture/                # NEW edge fn (keyless) — clone of cross-venue-capture
      index.ts                      # Deno entry: runJob('opening-capture', periodKey, …)
      handler.ts                    # capture logic (enumerate → walk depth → seed house_gaussian on-demand → read → record)
      pure.ts                       # pure row-builders (testable)
      handler.test.ts
    _shared/                        # REUSED (db.ts, runJob.ts, slack.ts, distributions.ts, polymarket-wallet.ts)
  migrations/
    0066_opening_convergence.sql    # NEW · 9 tables (+bot_tick_log F19, +bot_bankroll F14, +bot_daily_kill F32, +bot_circuit_state F11) + lifecycle/caps/seed/resolve/dash RPCs + capture+deadman crons + grants + the bot CRITICAL-kinds Slack-allowlist append (F4-r8 — so safety alarms survive the global pause)

apps/web/src/
  app/(dash)/bot/page.tsx           # NEW · /bot monitoring page (mirrors /data)
  app/(dash)/bot/actions.ts         # NEW · approve/kill server actions (operator-gated)
  lib/loaders.ts                    # +getBotView(db) (mirrors getDataAccuracy)
  components/                       # REUSED (BarChart, LineChart) + maybe PositionTable.tsx (NEW, small)

scripts/
  research/opening-convergence-probe.ts   # EXISTS (the cheap gate; the capture generalizes it)
  research/opening-spike.ts               # NEW (F11-r8) · Phase-0.5 go/no-go artifact: per event, first-seeded house_gaussian capture → still-flat? cheap center depth? → GO fraction
  bot/opening-paper-backtest.ts           # NEW · replay opening_captures → paper P&L → openingVerdict
  bot/opening-bot.ts                      # NEW · the forward loop driver (paper default; --mode live gated)

GO-LIVE-CHECKLIST-OPENING.md              # NEW (root, beside RUNBOOK.md) · the paper→real→scale operator runbook (F39/F33/F30/F21/F22)
```

---

## 6. Module & Function Definitions

> Notation: language-agnostic pseudotypes (`Optional<T>`, `Result`, `Promise<T>`). "Called by" / "Calls" form
> the dependency web (§10) and must be mutually consistent. References to **existing** symbols
> (`executableAsk`, `parseGammaEvent`, `localDayWindow`, `notifySlack`, `runJob`, `fill_bet_with_caps`, …) are
> reuse, not redefinitions — they are not orphans.

### 6.1 `core/sim/opening-convergence.ts` (NEW · pure signal + brackets + gate)

**Purpose:** the entire decision logic of the bot as pure, total, network-free functions — flat-open
detection, entry selection, the bracket decision, the paper-fill model, and the frozen net-profit verdict.
Mirrors `cross-venue-arb.ts` (pure + total; junk → null/zeroed, never throw). Imports only `../fees.ts` and
`../time.ts`; **never** `packages/trading` or any I/O.

```
isFlatOpen(cap: OpeningCapture, cfg: OpeningCfg): { flat: Boolean; peakMid: Number; hoursSinceListing: Number; reasons: List<String> }
  Purpose: decide whether a capture is in the uninformed flat-open window (F-OC-02).
  Params:
    - cap: one captured snapshot (bucket mids + listing time + tz).
    - cfg: { peakMidMax=0.18, listingMaxHours≈1 (§16-D — the real flat-open window is ≤~1h, NOT the §9R-B ~6h; the peak≤18% threshold does the real work), … }.
  Returns: flat=true iff peakMid ≤ cfg.peakMidMax AND hoursSinceListing ≤ cfg.listingMaxHours; reasons[] lists every failed test.
  Side effects: none (pure).
  Error cases: missing/empty buckets or unresolvable listing time ⇒ flat:false with a reason (never throws).
  Called by: selectEntries (6.1), opening-capture handler (6.10), entry-scanner (6.5), opening-paper-backtest (6.13a).
  Calls: (local helper) peakMidOf.

selectEntries(cap: OpeningCapture, cfg: OpeningCfg): List<EntryCandidate>
  Purpose: pick the buckets to buy at the flat open (F-OC-03).
  Params:
    - cap: the capture row — each cap.buckets[i] carries { idx, label, loF/hiF range, mid, execAsk, depthUsd, houseProb, tokenYes, conditionId }, where houseProb was aligned to THIS bucket BY LABEL/RANGE IDENTITY at capture time (W6 — NOT positional probs[i] cross-indexing; modeIdx = argmax of houseProb over the buckets). cap also carries city + evVol24h.
    - cfg: { cities: List<String> (the §9R 6–10 allowlist), minVol24hUsd (≈7000), centerHalfWidth=1, entryEdgeMargin, maxEntryPrice=0.20, perPositionUsd, depthFloorUsd, … }.
  Returns: [] unless cap.city ∈ cfg.cities AND cap.evVol24h ≥ cfg.minVol24hUsd AND isFlatOpen(cap).flat AND `localHourInstant(cap.tz, cap.targetDate, cfg.timeStopLocalHour) − now ≥ cfg.minHoldRunwayMin` (F7-r10 — the MINIMUM-RUNWAY guard: a lead-0 same-day market in a far-east tz can be freshly-listed/flat yet ALREADY past local noon → entered then immediately time-stop-flattened at a deterministic spread+fee loss for ~zero hold, polluting the §9R-E gate panel; skip reason 'past_or_near_timestop') (the §9R-B universe + flat-open gate, I-13). Then for each bucket i in [modeIdx−1 .. modeIdx+1] with a non-null houseProb: a candidate IFF execAsk ≤ min(maxEntryPrice, houseProb − entryEdgeMargin) AND depthUsd ≥ depthFloorUsd; each carries { bucketIdx, label, tokenYes, conditionId, execAsk, modelProb=houseProb, edge=modelProb−execAsk, makerLimit, targetShares, targetUsd, reasons } (F2-r8 — `conditionId` threaded onto the candidate + OpenPosition for the redeem/resolve key).
  Side effects: none.
  Error cases: any bucket with houseProb=null (unseeded) is skipped with reason 'no_house_prob'; no two-sided quote ⇒ skipped; never throws.
  Called by: entry-scanner (6.5), opening-paper-backtest (6.13a).
  Calls: isFlatOpen (6.1), takerFeePerShare (core/fees.ts, reuse). (Depth was walked at capture; selectEntries reads cap.buckets[i].depthUsd — no re-walk.)

bracketDecision(pos: OpenPosition, mark: Number, nowUtc: DateTime, tz: String, cfg: OpeningCfg): BracketAction
  Purpose: the pure exit decision for one armed position (F-OC-05, §9R-C).
  Params:
    - pos: { entryPrice, modelProb, tokenYes, targetDate, side='BUY-YES', makerRestingSince?, state }.
    - mark: the BID-SIDE realizable (sellback) mark for the held size (caller supplies via executableBid — F1; a long-YES exit sells into the bid, so this is the price you can actually exit at; null-safe).
    - nowUtc, tz: tz is the city's real IANA NAME (e.g. 'Australia/Sydney', from cities.tz — C2/ADR-OC-12), NOT an offset.
    - cfg: { tpDeltaPp=0.25, tpAtModelProb=true, slDeltaPp=0.12, slFrac=0.5, timeStopLocalHour=12, makerFillWindowMin, … }.
  Returns: a discriminated BracketAction:
    'hold' | { kind:'take_profit', reason } | { kind:'stop_loss', reason } | { kind:'time_stop', reason } | { kind:'cancel_maker_take', reason } (entry maker window elapsed).
  Logic: take_profit if mark ≥ entryPrice + tpDeltaPp OR mark ≥ modelProb.
    stop_loss if mark ≤ slStop, where slStop = (entryPrice − slDeltaPp > 0) ? entryPrice − slDeltaPp : entryPrice × (1 − slFrac) — i.e. use the locked absolute −12pp stop WHENEVER it is positive, and fall to the relative floor (entry×(1−slFrac), default 50% drawdown) ONLY for entries ≤ slDeltaPp where the absolute stop is non-positive and inert (F13-corrected — a naive max() would take the TIGHTER threshold for the ENTIRE ≤0.24 universe, silently overriding the §9R-C-locked −12pp; this branch keeps −12pp for entry > 0.12 and only adds a real stop for the cheapest band). §16-D's qualifying opens were 7–12% (the inert band).
    time_stop if nowUtc ≥ localHourInstant(tz, targetDate, timeStopLocalHour) — computed DIRECTLY as the UTC instant of local wall-clock noon via TZDate(y, m−1, d, timeStopLocalHour, 0,0,0, tz).getTime() (the codebase idiom, time.ts:48), NOT localDayWindow(...).startUtc + 12h (F11 — adding a fixed 12h to local MIDNIGHT is DST-wrong by ±1h on the ~2 transition days/yr, the exact skew the IANA discipline removed).
    cancel_maker_take if state='maker_resting' AND now − makerRestingSince ≥ makerFillWindowMin.
  Side effects: none.
  Error cases: a tz that fails assertTimezone (non-IANA) is caught and ⇒ time_stop returned conservatively (fail toward flatten) with a reason — but such positions are NOT entered in the first place (ADR-OC-12 fail-closed), so this is a defensive backstop.
  Called by: bracket-engine (6.4), opening-paper-backtest (6.13a).
  Calls: localHourInstant (NEW core/time.ts helper — `(tz, dateISO, hour) => new Date(new TZDate(y,m−1,d,hour,0,0,0,tz).getTime())`, DST-correct by the same mechanism localDayWindow's startUtc uses, time.ts:48; F11). The tz validity guard is INTERNAL to localHourInstant (F8 — `assertTimezone` is module-private in time.ts, not exported; do NOT claim it as a reuse import — localHourInstant throws InvalidTimezone itself, which bracketDecision catches → conservative time_stop).

paperFill(candidate: EntryCandidate, storedAsk: Number, liveWalkedAsk: Optional<Number>, cfg: OpeningCfg, isMaker: Boolean): Optional<PaperFill>
  Purpose: deterministic pessimistic paper fill (F-OC-09, ADR-OC-6/9) — the maker/taker twin of PaperExecutor.
  Params:
    - storedAsk: execAsk at decision time; liveWalkedAsk: re-walked at fill time (null if book gone).
    - isMaker: maker resting (fills only if liveWalkedAsk ≤ makerLimit) vs taker (fills at worse-of + slippage).
  Returns: { price, shares, feeUsd, mode:'paper', isMaker } or null when a maker limit was not traded through (no fill this tick).
  Side effects: none.
  Error cases: both asks unusable + stored book stale beyond paperBookMaxAgeMin ⇒ null (treated as no-fill, not a throw).
  Called by: position-manager (6.6, paper mode), createPaperSigner (6.3), opening-paper-backtest (6.13a).
  Calls: takerFeePerShare (core/fees.ts, reuse).

openingVerdict(panel: List<OpeningMarketResult>, opts?: VerdictOpts): OpeningVerdict
  Purpose: the frozen, pre-registered net-profit gate (F-OC-10, §9R-E, ADR-OC-10). Mirrors crossVenueVerdict.
  Params:
    - panel: one row per CLOSED paper market: { city, targetDate, netPnlUsd, stakeUsd, netReturn, executed:Boolean }.
    - opts: { minMarkets=40, minCities, minDistinctDays, minWinFrac, … }.
  Returns: { label:'PASS'|'KILL'|'INSUFFICIENT_DATA', nMarkets, nCities, nDistinctDays, winFrac, meanNetReturn, ciLow, ciHigh, zeroSkillPassRate, reason }.
  Logic: INSUFFICIENT until ≥minMarkets across ≥minCities / ≥minDistinctDays; else PASS iff winFrac ≥ minWinFrac AND the per-CITY-clustered mean netReturn 95% t-CI excludes 0 (ciLow>0) AND zeroSkillPassRate < 0.05; else KILL.
  Side effects: none.
  Error cases: empty/degenerate panel ⇒ INSUFFICIENT.
  Called by: opening-paper-backtest (6.13a) + loop alert summary (6.7); the result is PERSISTED to bot_gate_snapshot (§7) and dash_bot READS that snapshot — dash_bot does NOT call openingVerdict (I-5/I-7, the §8.2 note).
  Calls: tCrit (local, copied from cross-venue-arb idiom), zeroSkillPassRate (6.1).

zeroSkillPassRate(panel: List<OpeningMarketResult>, trials: Number, seedSalt: Number): Number
  Purpose: how often a no-skill bucket pick clears the same CI bar (the LEARNINGS statistical-gate guard).
  Params: trials (default 1000); seedSalt to vary the deterministic shuffle (no Math.random — index-seeded LCG).
  Returns: fraction of shuffled panels whose clustered CI excludes 0 (the bar PASS must beat by being <0.05).
  Side effects: none. Error cases: <2 cities ⇒ 1 (cannot clear; fail closed).
  Called by: openingVerdict (6.1). Calls: (local) seededShuffle, tCrit.
```

Exported types: `OpeningCapture`, `HouseDist`, `OpeningCfg`, `EntryCandidate`, `OpenPosition` (the pure
subset), `BracketAction`, `PaperFill`, `OpeningMarketResult`, `OpeningVerdict`. (`OpenPosition` here is the
decision-relevant subset; the persisted shape lives in §7.)

### 6.2 `bot/types.ts` (NEW)

**Purpose:** the boundary types for the Node orchestrator — config, the persisted position/order shapes, the
`Signer` port, and the `BotDeps` injection bag. The `Signer` port is the narrow slice of
`@polymarket/clob-client-v2` the manager touches (the V2 analog of `ClobClientish` in `trading/live.ts`) so paper + live +
tests all satisfy it.

```
interface Signer {
  readonly mode: 'paper' | 'live'
  getTickSize(tokenId: String): Promise<Number>
  // orderType: 'GTC' for the resting maker entry; 'FAK' (fill-and-kill = IOC: take available depth at a marketable/crossing price, kill the rest — do NOT rest) for the taker entry-fallback + the taker exit. NEVER 'FOK' (fill-OR-kill cancels ENTIRELY if depth<size → FAILs to flatten on a thin book, holding into resolution — W1/W1b/R-4). 'FAK' takes whatever depth exists; a FULL flatten comes from applyExit's retry-until-flat loop, NOT one order. The real lib's order types (GTC/GTD/FOK/FAK) are SDK-VERIFIED (§16-B / REPORT §9); Phase-6 is install/integration, not order-type verification (F6).
  // placeOrder status may be 'rejected' (e.g. a post_only GTC that would CROSS on a moved book — expected, F29). NOTE (F15-r8): the V2 SDK uses throwOnError:true (REPORT §9), so a would-cross surfaces as an ApiError THROW at the SDK boundary — `createNodeClobSigner` CATCHES + CLASSIFIES: would-cross (the post_only-cross 4xx code) → {status:'rejected'} (F29); a definitive 4xx/no-orderID → re-throw → 'failed' (F40 definitive); a no-response/5xx/network → ambiguous throw (F40). The manager thus sees a normalized {status:'rejected'} (→ position 'rejected' + same-tick taker fallback, not 'failed'+CRITICAL), never the raw throw; pin the would-cross error signature at Phase-6 install.
  placeOrder(args: { tokenId, price, size, side:'BUY'|'SELL', negRisk, orderType:'GTC'|'FAK', postOnly?: Boolean }): Promise<{ clobOrderId?: String, status: 'matched'|'resting'|'rejected'|String, matchedShares: Number, avgPrice?: Number }>
  cancelOrder(clobOrderId: String): Promise<void>
  getOrder(clobOrderId: String): Promise<{ status: String, price?: Number, matchedShares: Number }>
  openOrders(): Promise<List<{ clobOrderId: String, tokenId: String, price: Number, size: Number, side: String }>>
  getHeldShares(tokenId: String, conditionId: String): Promise<{ shares: Number, avgPrice?: Number, redeemable: Boolean }>   // F3-r8: the MODE-AWARE holdings read EVERY exit/close/settle path needs (it must NOT be the raw io `fetchPositions`, which is VENUE-BY-WALLET-ADDRESS). live = wraps `fetchPositions` (filter the WalletPosition rows for this token → shares/avgPrice/redeemable). paper = derives SYNTHETIC holdings from the bot's OWN ledger — the NET `Σ(matched_shares WHERE intent IN ('entry_maker','entry_taker')) − Σ(matched_shares WHERE intent='exit_taker')` computed directly from deps.db (F3-r10: NOT "the bot_fill_with_caps SUM" — that RPC sums ONLY entry rows by §17-F47 design; this is a distinct net-holdings read), `redeemable` synthesized from the persisted resolves_at/closed + win outcome. WITHOUT this, keyless paper's `fetchPositions(<no funder address>)` returns 0 for every synthetic position → applyExit sizes the FAK to 0 (NO exit ever booked) + the WIN pre-redeem guard sees balance 0 → winners book $0 → the Phase-5 net-PnL gate (the go/no-go for real capital) is corrupted. Every manager venue-held read routes through THIS.
  getCollateralBalance(): Promise<Number>   // F14: live = pUSD ERC20 balanceOf the funder via viem (getContractConfig(137).collateral); paper = bot.paperBankrollUsd. Sources the live caps "bankroll" (ingested to bot_bankroll — §17-F14).
  getGasBalance(): Promise<Number>   // F10/§17-F14b: live = NATIVE POL balance via viem publicClient.getBalance({address: funder}) (NOT ERC20 balanceOf — POL is Polygon's native gas token); paper = a large constant. Sources the POL-low alarm (ingested to bot_bankroll.pol_balance; boot/periodic read Slack-CRITICALs below bot.minPolGas — without POL the on-chain redeem (F14c) + approval bootstrap (F33) silently can't run).
  redeem(conditionId: String, tokenId: String, negRisk: Boolean): Promise<{ pUsd: Number }>   // F4: live = on-chain redeem of a resolved winning token → pUSD; BRANCH on negRisk (F3/§17-F14c): weather markets are negRisk winner-take-all → redeem via the NegRiskAdapter, NOT plain CTF redeemPositions (which reverts on a negRisk position); plain CTF redeem only for any non-negRisk position. The `negRisk` arg is sourced from the PERSISTED `bot_positions.neg_risk` (set at entry from parseGammaEvent's negRiskMarketId — F2/F5), with the F36-extended fetchPositions `negativeRisk` as a reconcile-from-venue fallback; **FAIL-CLOSED: when negRisk is absent/undefined, default to the NegRiskAdapter path (the weather DEFAULT), NEVER the reverting plain-CTF redeem.** Returns the ACTUAL settled pUSD (used by bot_resolve_position — F14: book real terminal value, never a hard-coded $1, so a void/50-50 settles correctly). paper = book held×(resolved outcome price). The held-into-resolution accounting path (§17-F4/F14c/F36).
  heartbeat(): Promise<void>   // F2: no-op on the REST order path (resting GTC survives without a session); a 5s ping ONLY if the optional user-websocket fill-feed is open (§16-F — the canonical F2 resolution).
  bootstrapApprovals(): Promise<void>   // F33/F4/F8: ONE-TIME on-chain approvals to a THREE-contract set — the V2 CTF Exchange + the NegRisk Exchange (trade-time) AND the **NegRiskAdapter** (the distinct redeem contract §17-F14c routes the weather winner-take-all redeem through — F8: approving only the two Exchanges leaves the first live winning redeem reverting = R-16 stranding). **pUSD ERC20 `approve()` on the two TRADE-TIME Exchanges ONLY (they pull pUSD on a BUY); CTF `setApprovalForAll()` on ALL THREE** (both Exchanges for trade + the NegRiskAdapter so redeem can BURN your CTF — the adapter never SPENDS pUSD, it pays it OUT, so a pUSD approve to it is unnecessary gas — F16-r8), idempotent via a viem allowance/isApprovedForAll READ (skip if already max). Pin the adapter from `getContractConfig(137).negRiskAdapter` (NOT the NegRisk Exchange). Called once at the §14 Phase-6 go-live gate (§6.13b --bootstrap), never by the manager. paper = no-op.
  ensureConditionalApproval(tokenId: String): Promise<void>   // F4: idempotent at the →'armed' transition (manageFill) — (a) the on-chain CONDITIONAL setApprovalForAll is global-per-contract (covered by bootstrapApprovals, this re-checks) AND (b) the PER-TOKEN server-side `updateBalanceAllowance({CONDITIONAL, token_id})` cache refresh §16-A requires "before a sell", so the FIRST SL/time-stop FAK flatten of THIS token (the R-4 path) isn't the place it's first hit. OUTSIDE the time-critical applyExit. paper = no-op.
  // clockSanityCheck is NOT a Signer method (F7-r9 — it needs BotDeps.db, which the live signer has not; §6.3's createNodeClobSigner method list omits it). It is a DRIVER function — see the note below the interfaces.
}
// CLOB V2 — RESOLVED (§16-A/B, research/REPORT-clob-bracket-execution.md §9, SDK-verified against clob-client-v2@1.0.6): maker entry = GTC with post_only=true (4th positional bool of createAndPostOrder; never crosses → free maker); taker exit = FAK (takes available depth, kills rest — correct for thin books; NOT FOK). GTD exists in the SDK but the entry-side GTD time-stop is OUT OF SCOPE for this build (F17/§17-F17c) — the entry time-stop IS the makerFillWindowMin cancel and the hard time-stop is a FAK taker; the placeOrder union is therefore 'GTC'|'FAK' only (no GTD arg). getOpenOrders()/getOrder() exist (reconcile OK). NO clientOrderId on the order — uniqueness is salt+timestamp at sign time (C3). The 25% weather maker rebate is a DAILY DISCRETIONARY POOL, not a per-fill credit (bank only the $0 maker fee).
interface BotDeps { db: BotDb; signer: Signer; fetchJson: FetchJsonLike; notify: (a: TradeAlert)=>Promise<Boolean>; now: ()=>Date; cfg: BotConfig }
// clockSanityCheck(deps: BotDeps): Promise<{ ok: Boolean, driftSec: Number }> — DRIVER function (F7-r9/F17/F10, NOT on the Signer port): drift = local now() vs Supabase `select extract(epoch from now())` via BotDeps.db; the V2 SDK exposes NO server-time method (REPORT §9), so the 'CLOB server time' comparand is dropped (at most the HTTP Date header). On |drift| > bot.maxClockDriftSec the driver halts PLACEMENT but EXITS (incl. the clock-only local-noon time-stop) keep running best-effort + a CRITICAL pages NTP re-sync (§6.7 exits-never-gated; R-4). paper = ok (driver short-circuits).
```
  Called by: every bot module (consumes these types).
  Calls: imports FillResult/TradeAlert shapes from @weather-edge/trading (reuse), FetchJsonLike from @weather-edge/io.

### 6.3 `bot/signer.ts` (NEW · the ONLY key reader — ADR-OC-11)

**Purpose:** construct the Node Polymarket CLOB client (live) or a deterministic paper signer. **⚠ §16-A: the
live path is NET-NEW on `@polymarket/clob-client-v2@1.0.6` (viem) — it does NOT mirror `trading/live.ts`'s V1
`createClobClient` (which no longer trades on CLOB V2).** It reuses the same env
(`POLY_PRIVATE_KEY`/`POLY_SIGNATURE_TYPE`/`POLY_FUNDER_ADDRESS`, same `createOrDeriveApiKey` bootstrap) but on
the V2 SDK (viem `walletClient`) with **plain Node imports**.

```
createNodeClobSigner(): Promise<Signer>
  Purpose: build the live signer; the ONLY place POLY_PRIVATE_KEY is read (process.env, never logged).
  Returns: a Signer (mode='live') wrapping a V2 ClobClient (chain POLYGON, creds via createOrDeriveApiKey). Maps the Signer port onto clob-client-v2 (§16-A/B): maker entry→createAndPostOrder(…,GTC, post_only=true); taker exit→createAndPostMarketOrder/FAK; openOrders→getOpenOrders; pUSD approvals via updateBalanceAllowance + getContractConfig(137).
  Side effects: reads process.env.POLY_PRIVATE_KEY / POLY_SIGNATURE_TYPE / POLY_FUNDER_ADDRESS; constructs a viem walletClient + `@polymarket/clob-client-v2@1.0.6` ClobClient (PLAIN Node imports — a Phase-6 dep; NOT installed today; SDK surface verified in research/REPORT-clob-bracket-execution.md §9 — §16-A/B).
  Error cases: missing key ⇒ ExecutionError('ERR_NO_KEY') (reuse core errors); never echoes the key in the message.
  Called by: opening-bot.ts (6.13b) when --mode live (Phase 6). Calls: viem walletClient; clob-client-v2 ClobClient.createOrDeriveApiKey / createAndPostOrder(GTC,post_only) / createAndPostMarketOrder(FAK) / getOpenOrders / getOrder / cancelOrder / updateBalanceAllowance / getContractConfig(137) (§16-A, npm, Node). NOTE (F14 — the live-bankroll/viem-composed-port finding, NOT F18 the breaker): `getCollateralBalance` is NOT a ClobClient SDK method (the REPORT §9 verified-methods list does not include it) — it is a Signer-PORT method the signer COMPOSES from viem: a pUSD ERC20 `balanceOf(funder)` against `getContractConfig(137).collateral` (per §6.2 / §17-F14). Same for `redeem` (viem CTF/NegRiskAdapter call, §17-F14c), `getGasBalance` (viem native POL balance, F10), and the **one-time `bootstrapApprovals()`** (F33 — viem `approve()` to the two trade-time Exchanges + `setApprovalForAll` to ALL THREE (F16-r8 — the NegRiskAdapter needs only setApprovalForAll for redeem, never a pUSD approve): the V2 CTF Exchange, the NegRisk Exchange, AND the **NegRiskAdapter** redeem contract `getContractConfig(137).negRiskAdapter` — F8: approving only the two Exchanges leaves the first live winning redeem reverting, R-16), with a viem allowance/isApprovedForAll READ for the "skip if already max" idempotency check) — all viem-composed signer methods, not SDK calls. `bootstrapApprovals()` is called once at the §14 Phase-6 go-live gate (before `tradingMode=live`), not by the manager.

createPaperSigner(deps: { fetchBook, db, cfg, now }): Signer
  Purpose: a Signer (mode='paper') that needs no key — placeOrder routes to paperFill (6.1) against the live book; cancel/getOrder are bookkeeping no-ops on resting paper orders; **getHeldShares (F3-r8) derives SYNTHETIC holdings from the bot's own bot_orders ledger via `deps.db` (the entry-SUM minus exit-SUM bot_fill_with_caps already computes), NOT the real venue — so paper exits size correctly + winners book held×$1 (raw `fetchPositions` would return 0 for the keyless paper wallet and silently break every exit/settle path).**
  Returns: Signer where placeOrder returns a synthetic fill (or a 'resting' status for an unfilled maker limit).
  Side effects: fetches the live CLOB book to walk the pessimistic fill price; no order is ever sent.
  Called by: opening-bot.ts (6.13b) default (the forward paper loop). Calls: paperFill (6.1), normalizeBook (core, reuse), executableAsk (BUY/entry sim) + executableBid (NEW, SELL/exit sim — F1), normalizeBook, deps.db (the synthetic entry-minus-exit SUM for getHeldShares — F3-r8). (The offline backtest 6.13a calls paperFill directly, not via a signer — I-4.)
```
  §15 grep invariant: `POLY_PRIVATE_KEY` and `@polymarket/clob-client-v2` appear in NO file but signer.ts.

### 6.4 `bot/bracket-engine.ts` (NEW)

**Purpose:** the impure shell over the pure `bracketDecision` (6.1): fetch the current mark for an armed
position, call the pure decision, and return the action for the manager to apply. Holds no state.

```
decideForPosition(pos: OpenPosition, deps: BotDeps): Promise<BracketAction>
  Purpose: get the live mark and compute the bracket action for one position (F-OC-05).
  Returns: a BracketAction (hold / take_profit / stop_loss / time_stop / cancel_maker_take).
  Mark side (F1, CRITICAL): a long-YES position EXITS by SELLING into the BID, so the realizable exit mark is the BID side — use the NEW core helper `executableBid(book, heldShares)` (mirrors executableAsk but walks book.bids best-first → realizable avg SELL price), NOT `executableAsk` (the BUY side, which overstates exit value → TP fires early at an unrealizable price, SL fires late, MTM under-counts loss — all UNSAFE). `executableBid` promotes the bid-walk the capture already does inline (sellbackUsd) into a shared core function. DEPTH-SHORTFALL (F2, CRITICAL): when realizable bid depth < heldShares (the NORM on the thin flat-open book the bot deliberately enters), `executableBid` returns BOTH the fillable-slice avg AND `fillableShares`. A bracket decision REQUIRES `fillableShares ≥ heldShares` before honoring a TP/SL mark — else `hold` (a TP at a price only a fraction of the position can realize is unrealizable; an SL likewise). The KILL MTM (§8.2 bot_should_run) instead values the UNFILLABLE remainder CONSERVATIVELY (last-trade or 0) so a shallow bid can only OVER-state drawdown, and treats a held position whose realizable bid depth < held size as NOT fresh-marked (a conservative fill-in EXCLUDED from the §17-F32b CONFIRMED latch sum — only a FULL-size realizable bid mark may PERSIST the latch). This closes the fetch-SUCCESS-with-thin-bids hole that §17-F32b Guard 1 leaves open for /book FETCH-FAILURES.
  Side effects: one CLOB /book fetch (read-only) to compute the BID-side mark; none on failure (returns 'hold' with a logged warning unless the time-stop independently fires — the time-stop never depends on the book).
  Error cases: book unreachable ⇒ still evaluate the time-stop (clock-only); other brackets hold until a mark is available.
  Called by: loop.manageBrackets (6.7). Calls: bracketDecision (6.1), normalizeBook + executableBid (NEW core/edge.ts, F1 — NOT executableAsk), fetchJson (io, reuse).
```

### 6.5 `bot/entry-scanner.ts` (NEW)

**Purpose:** the impure wiring that turns the latest `opening_captures` rows + the matching `house_gaussian`
distributions into `EntryCandidate[]` for the loop. The decision is pure (`selectEntries`); the scanner only
reads the DB and joins.

```
scanEntries(deps: BotDeps, openPositions: List<OpenPosition>): Promise<List<EntryCandidate>>
  Purpose: find flat-open entry candidates this tick (F-OC-02/03).
  Returns: candidates from the freshest capture per event (houseProb already aligned per-bucket at capture, W6) that clear selectEntries, EXCLUDING any (event, bucket) we already hold or already exited today — deduped against the openPositions set the loop loads + a closed-today read + a recently-'failed'/'rejected' (event,bucket) within the reconcile window (F6-r9 — a 'failed' position may still hold a real venue fill reconcile hasn't adopted yet; re-opening on it would put two of our positions on one `token_yes`, which the per-token getHeldShares can't attribute).
  Side effects: reads opening_captures (latest per event) via bot_latest_captures; the held/closed dedupe uses the loop-loaded openPositions (from bot_open_positions) + a closed-today flag the same RPC returns — so no separate bot_open_or_closed_today RPC is needed (I-2).
  Error cases: a capture with all houseProb=null (unseeded — C1) ⇒ that event yields no candidates with reason 'no_house_prob' (logged, not fatal).
  Called by: loop.placeEntries (6.7 helper) — which passes the openPositions the loop already loaded. Calls: bot_latest_captures RPC (§8.2), selectEntries (6.1).
```

### 6.6 `bot/position-manager.ts` (NEW · CAS lifecycle — ADR-OC-4/5)

**Purpose:** apply a desired action to a position by transitioning its `bot_positions` row via CAS and driving
the `Signer` — the single place that writes the position/order ledger. Idempotent by construction.

```
openPosition(c: EntryCandidate, deps: BotDeps): Promise<Optional<PositionId>>
  Purpose: begin a position (F-OC-03/04). Writes a bot_positions row (state 'intent') + a bot_orders intent row with a client-minted UUID (DB-dedup only — C3), THEN places (maker GTC near mid) via Signer, records the result; if live & under the first-N, runs postFillReview AFTER the fill (W5 — never delays placement).
  Returns: the new positionId, or null if a cap/kill/lease gate blocks it pre-place.
  Side effects: bot_open_position RPC (caps headroom estimate + insert) → Signer.placeOrder → bot_record_order_result → (live, under N) postFillReview. NEVER auto-retries placement (inherits live.ts:136-150).
  Error cases: a placement THROW is AMBIGUITY-CLASSIFIED (F40/§17-F40 — the CLOB has no client-order-id to confirm, C3): a **definitive server-confirmed reject** (an error body with no orderID / explicit rejection) ⇒ position→'failed' + CRITICAL (the order provably did not land); an **AMBIGUOUS throw** (timeout / dropped response / network error — the order MAY have landed) ⇒ leave the position NON-TERMINAL in 'intent' WITH its `bot_orders` intent row (NOT 'failed' + never auto-retry placement), so the boot/periodic ENTRY-ADOPT reconcile arm (§6.6 reconcilePosition) can adopt a phantom fill — marking it terminal 'failed' would drop it from BOTH the open set AND the ENTRY-ADOPT scan (which covers 'intent'/'placed'/taker-FAK, not 'failed'), letting a landed order's held YES ride into resolution unmanaged. Raise a WARNING (not CRITICAL — it may be a non-event), surface it on /bot, AND call `bot_record_ambiguous` to INCREMENT the breaker's brownout dimension (F1/F44 — N consecutive ambiguous throws = a down/timing-out venue → trips circuit_break, the one writer that makes the round-5 ambiguous dimension actually fire). A placeOrder status='rejected' (a post_only GTC that would CROSS on a moved book — EXPECTED, not a failure — F29) ⇒ keep the position in an OPEN state and attempt same-tick recovery FIRST (reprice one tick lower as post_only OR fall to the capped taker FAK within caps); only set position→'rejected' (+ order status 'rejected', logged INFO not CRITICAL) AFTER recovery is exhausted with no fill (F29 — marking terminal-'rejected' before recovery would drop the row from the open set and strand a recovery fill). A transient cross thus doesn't cost the ≤1h window. Cap breach at the atomic fill RPC ⇒ recorded up to headroom (you cannot un-buy a real fill).
  Called by: loop.placeEntries (6.7). Calls: risk-guard.capsHeadroom (6.9), Signer.placeOrder, bot_open_position + bot_record_order_result + bot_record_ambiguous (F1, on an ambiguous throw) RPCs, approval.postFillReview (6.8, live first-N).

manageFill(pos: OpenPosition, deps: BotDeps): Promise<Void>
  Purpose: poll a resting/placed entry order, record the CUMULATIVE fill atomically through caps, and arm brackets — handling multi-tick PARTIAL fills idempotently (F-OC-04/08/14, W4/W4b).
  Side effects: Signer.getOrder → persist EACH order's terminal {size_matched, avg_price, fee} onto ITS OWN bot_orders row (idempotent per clob_order_id), then bot_fill_with_caps(positionId) DERIVES the position cumulative by SUMMING matched_shares across ALL of that position's bot_orders rows (F10 — NOT a single caller-supplied 'cumulative', which loses a maker-partial when a taker-remainder order is later polled) → re-blends entry_price (share-weighted) + sums fees + resizes brackets + CAS 'maker_resting'|'armed'→'armed'. A re-poll of any one order is a true no-op (its row upserts, the SUM is invariant). If still (partly) resting past the maker window: cancel the UNFILLED remainder, RE-getOrder for the cancel-race terminal count (TOCTOU — W4b), keep any filled partial armed; if zero filled, optionally re-place as taker ONLY when the LIVE ask still clears `min(maxEntryPrice, modelProb − entryEdgeMargin)` (F8-r10 — never buy above the 20% cap on a converged book; FAK limit = that cap; else skip 'converged_no_take') — a 2nd bot_orders row whose SUM blends maker-partial + taker-remainder (F-OC-14).
  Error cases (F2, CRITICAL-corrected): caps breached at fill ⇒ record the FULL venue-confirmed cumulative (you HOLD every matched share — a maker GTC already executed on-venue; exit accounting MUST reflect true holdings or applyExit under-flattens and the excess rides into resolution, R-4) → bot_fill_with_caps returns outcome:'caps_exceeded_held', which drives the SEPARATE auto-clearing `over_cap_halt` latch (gates placeEntries only, clears when the position flattens), firing the CRITICAL ONCE on the over_cap TRANSITION (the `bot_positions.over_cap` dedupe flag — §7/§8.2) — NOT the §17-F18 `consecutive_failures` systemic breaker (round-8 F1: routing benign self-correcting over-cap inventory into the systemic breaker false-trips it + spams CRITICAL within maxConsecutiveFailures ticks; canonical at §8.2 bot_fill_with_caps + §7 over_cap + §17-F42 + round-7-F1 — manageFill is the FOURTH producer site, omitted from the round-7-F1 enumeration). Caps throttle PLACEMENT size (capsHeadroom, pre-place), NEVER silently drop already-held shares from the exit math. Never 'rejected' after a real fill (you cannot un-buy).
  Called by: loop.manageBrackets (6.7). Calls: Signer.getOrder/cancelOrder/placeOrder, Signer.ensureConditionalApproval (live, at the →'armed' transition — idempotent re-ensure OUTSIDE the time-critical applyExit, no-op in paper; the primary on-chain CONDITIONAL approval is the F33 pre-go-live bootstrap, this is redundant insurance), bot_fill_with_caps RPC, paperFill (paper mode).

applyExit(pos: OpenPosition, action: BracketAction, deps: BotDeps): Promise<Void>
  Purpose: execute a fired bracket — taker exit (sell the held YES shares) and close the position (F-OC-05).
  Side effects: CAS position 'armed'→'exiting' (so a concurrent tick won't double-exit — this is the 'exiting' writer); FIRST cancel any still-resting ENTRY order for the position (F11 — a bracket can fire before the maker window elapses; an un-cancelled resting entry could fill into a position we're flattening), then RE-getOrder the cancelled entry for a CANCEL-RACE STRAGGLER (F7-r8 — mirroring cancelRestingEntries/resumeExit; a within-window partial-maker remainder that filled during the cancel must be BOOKED FIRST via the ENTRY-ADOPT path (synthetic 'matched' entry row + bot_fill_with_caps) so entry_shares == actual held BEFORE the FAK — else SUM(exit_taker)=held > entry_shares wedges bot_close_position's SUM≈entry gate AND the cost basis under-counts → realized PnL over-stated, biasing the Phase-5 gate optimistic), then RE-read the live venue holding via `Signer.getHeldShares` (F3-r8 — mode-aware: live wraps fetchPositions, paper returns the synthetic ledger) and size the exit to ACTUAL held shares (F2 — not the possibly-under-recorded entry_shares); Signer.placeOrder(SELL, size=heldShares, orderType='FAK'|'IOC' marketable — take available depth, do NOT rest; NEVER FOK which cancels on thin depth and fails to flatten — W1/W1b/R-4); on a partial exit, RETRY the remainder aggressively until flat (one order is not a guaranteed full flatten — W1b). → persist each exit_taker row via bot_record_exit_order (F3-r10) FIRST, THEN bot_close_position RPC (SUM-derives the exit_taker rows, realized PnL net-of-fees, corroborated CAS 'exiting'→'closed'). The on-chain CONDITIONAL (CTF setApprovalForAll) sell-side allowance is ensured idempotently AT ARM TIME (§17-F33), NOT here — so this time-critical R-4 flatten never blocks on a first-time approval txn.
  Error cases: exit placement fails or cannot fully flatten ⇒ position→'exit_failed' + CRITICAL + retry loop (a position we could not flatten before resolution is the worst case — loudest alert; the time-stop is a best-effort backstop, NOT a guarantee given venue uptime — I-9). DUST FLOOR (F34/§17-F34, DUAL test — F7): the venue minimum is `max(5 shares, $1 notional)` (REPORT §2), so STOP the FAK retry loop when `residualShares < bot.minOrderSizeShares` OR `residualShares × currentBid < bot.minOrderNotionalUsd` (~$1) — at the bot's deliberately-cheap exit prices (≤12% entries, lower SL exits) an 8-share residual at $0.05 is 8 ≥ 5 shares yet $0.40 < $1, so the share-only gate would miss it and the venue would reject every FAK. Either condition ⇒ un-sellable: mark the position `exit_reason='dust_residual'` AND set a `dust_parked` flag (F7/§17-F34b — dust is usually detected MID-LIFE while the market still trades, so resolveHeldPosition is a no-op then; without the flag manageBrackets re-routes 'exiting'→resumeExit→re-detect-dust→resolveHeldPosition-no-op EVERY tick, with a per-tick alert + fetchPositions read — the exact churn/false-alarm F34 aimed to kill, only the CRITICAL removed). A `dust_parked` position is SKIPPED by manageBrackets (no per-tick FAK/alert/work) until `resolves_at < now` flips it to resolveHeldPosition. Hand the residual to resolveHeldPosition (book terminal value at settlement; redeemPositions works on any token amount) — do NOT escalate to 'exit_failed'+CRITICAL (capital is never lost on un-flattenable dust; the harm would be a permanent false alarm + per-tick FAK/cancel churn against the ~200/s budget + a spurious §17-F18 breaker trip on economically-trivial dust).
  Called by: loop.manageBrackets (6.7). Calls: Signer.cancelOrder/getOrder (F11 entry-cancel + F7-r8 cancel-race re-poll), Signer.getHeldShares (F3-r8), bot_fill_with_caps RPC (F7-r8 straggler ENTRY-ADOPT), Signer.placeOrder, bot_record_exit_order RPC (F3-r10 — persist the exit_taker row FIRST), bot_close_position RPC (SUM-derives + CAS), notifySlack.

resolveHeldPosition(pos: OpenPosition, venuePositions, deps: BotDeps): Promise<Void>
  Purpose: the MARKET-RESOLUTION accounting path (F4) — close out a position whose market settled while still held (the I-9/R-4 conceded case: the time-stop is best-effort, so a position CAN reach settlement). Without this a held position is stuck in 'exiting'/'exit_failed' forever (retrying a vanished book) and winnings are stranded as conditional tokens.
  Side effects: detect resolution each tick/reconcile (F6/§17-F36b — `redeemable=true` alone fires ONLY for WINNERS, NOT a sufficient trigger): a held position is RESOLVED when `redeemable=true` (winner) OR the PERSISTED `resolves_at < now` AND the market is closed — the LOSER and VOID cases, which never set redeemable. CORRECT SOURCING (F6): the market `closed` flag lives on the gamma EVENT/market payload, NOT on the /positions `WalletPosition` row — so resolveHeldPosition reads it via `resolveMarketsMeta` (gamma /markets, polymarket-wallet.ts:522), extending `MarketMeta` with `closed` + the settled price; the only valid /positions `WalletPosition` parser extensions are `mergeable` + `negativeRisk` (F14c). And `resolves_at` (the Gamma endDate, captured at entry — see §7) must trigger resolution EVEN WHEN THE LIVE /positions ROW IS ABSENT (a transient hiccup, or the venue filtering a zero-value loser), else a dropped row wedges the position in exit_failed retrying a vanished book forever; book terminal value via the markets-meta lookup keyed on the PERSISTED `bot_positions.condition_id` (F2-r8 — the venue-independent redeem/resolve key, since the WalletPosition row that would otherwise carry conditionId is exactly what's absent here). THREE settlement branches (F36/§17-F36 — NOT just binary WIN/LOSS): (1) WIN → Signer.redeem(conditionId, tokenYes, negRisk) → the ACTUAL settled pUSD (live; paper = book held×$1) and CAS →'resolved' booking realized PnL; (2) LOSS → closed-at-0 →'resolved'; (3) VOID / 50-50 / UMA-disputed / refunded → book held×(actual resolved outcome price) — the real settled pUSD that Signer.redeem returns (live) or held×(resolution price, e.g. $0.50 for an ambiguous 50-50 / stake-back for a refund) (paper), NOT a forced $1/$0 (which would over/under-state realized PnL and pollute the daily-loss MTM + the F-OC-10 gate). Detect the void/50-50/refund case SOLELY from the market's resolved `outcomePrices` (~[0.5,0.5]) / UMA resolution status carried on the **MarketMeta extension** (gamma /markets via `resolveMarketsMeta` — F7: NOT from a /positions row; `mergeable` is a pre-resolution INVENTORY attribute orthogonal to whether the market voided, so wiring it for void-detection mis-classifies settlements; `mergeable`+`negativeRisk` stay pure inventory extensions). A no-book resolved market is treated as RESOLVED (not the conservative-worst-case mark) so the daily-loss MTM isn't distorted. Void/ambiguous-resolved markets are EXCLUDED from the openingVerdict / F-OC-10 gate panel (executed:false flag — executed-but-void is not a skill outcome; with a ~40-market sample one mis-booking is amplified). Paper-first scope: if the on-chain redeem is deferred, flag the position for a GO-LIVE manual pUSD sweep but still book the terminal value.
  Error cases — REDEEM IDEMPOTENCY (F9/§17-F46, the redeem-leg analog of F40): an on-chain redeem tx that LANDS while its response is lost would, next tick, re-call Signer.redeem → REVERT (already redeemed) → never reach 'resolved' and re-attempt forever. So: (1) PRE-REDEEM GUARD — the WIN branch requires `redeemable=true` AND a positive token balance — for the REDEEM-IDEMPOTENCY guard specifically (LIVE) read the TRUE on-chain ERC-1155 `balanceOf(funder, tokenYesId)` via the signer's viem client (`getContractConfig(137)` CTF address), NOT the data-api-indexer-backed `Signer.getHeldShares` (F9-r9 — getHeldShares live wraps `fetchPositions` = the Polymarket Data API indexer, which LAGS the chain seconds-to-minutes; in exactly the lost-redeem-response window the guard exists for, the stale indexer still reports held+redeemable → the guard passes → re-redeem → on-chain REVERT churn each tick until the indexer catches up); paper uses the synthetic-held>0 (mode-aware getHeldShares is correct for paper); if redeemable is already false / the balance is gone, treat the token as ALREADY REDEEMED → skip to reconciliation (do NOT re-redeem, and do NOT mis-book a now-redeemable=false winner as a LOSS). (2) AMBIGUOUS THROW — a redeem throw with the token still held ⇒ leave the position NON-TERMINAL + WARNING (do NOT auto-re-redeem blindly). (3) RECONCILE — for a WINNER the payout is deterministic ($1/share), so book realized PnL as the COMBINED legs (F1-r10): `SUM(exit_taker proceeds net fees) + residual_held×$1 − gross_entry_cost − entry_fees` (SUM-derive the exit_taker rows as bot_close_position does — a partially-exited winner's sold proceeds must be credited, not dropped); do NOT cross-check against the WHOLE-WALLET `getCollateralBalance` delta (F17 — it moves with every concurrent fill/redeem across all positions and would false-alarm). If a reality-check is wanted, verify THIS position's conditional-token balance went to zero (per-token fetchPositions, the pre-redeem guard already reads it) or the redeem-tx receipt amount — never the wallet aggregate.
  Called by: loop.manageBrackets (6.7) + reconcilePosition (6.6, at boot). Calls: fetchPositions + resolveMarketsMeta (reuse — the closed/settled source, F6), Signer.redeem, bot_resolve_position RPC, notifySlack.

resumeExit(pos: OpenPosition, deps: BotDeps): Promise<Void>
  Purpose: the PER-TICK exit-resume for a position already in 'exiting'/'exit_failed' (§17-F43 — lifts the §17-F20 boot-only resume into manageBrackets so a watchdog-aborted-mid-exit flattens WITHOUT needing a reboot).
  Side effects: FIRST cancel any still-resting ENTRY order for the position (F10 — mirrors applyExit's F11 first-cancel; an operator flatten of an UNFILLED 'intent'/'maker_resting' position routes HERE via bot_flatten_position→'exiting', and without the cancel the resting entry stays live, fills, and arms the very exposure the flatten meant to kill — then dumps it at a taker loss; reuse the cancel-race re-getOrder TOCTOU; for a position LACKING a known clob_order_id (the F40 ambiguous-'intent' subset — the throw never returned a venue id), ALSO do a `Signer.openOrders` heuristic-match sweep (tokenId+side exact, price within 1 tick, size within minOrderSize, recency — the cancelRestingEntries F6 hole-b arm resumeExit was missing, F5-r9) and cancel the matched phantom entry, else it survives the flatten and fills post-cancel; route any straggler fill to the held flatten below; if nothing was ever held and the entry is cancelled, bot_close_position closes the position flat — 0 held is NOT dust); then re-read the live venue-held shares via `Signer.getHeldShares` (F3-r8 — mode-aware; raw fetchPositions returns 0 in paper); record any executed-but-unrecorded partial via bot_close_position's accumulate path; then re-issue a marketable FAK on the residual WITHOUT re-CASing 'armed'→'exiting' (the position is ALREADY 'exiting'/'exit_failed' — a CAS-free continuation, which is why this is a distinct function and NOT applyExit, whose first action is the 'armed'→'exiting' CAS that would fail here). A residual below `bot.minOrderSizeShares` OR notional below `bot.minOrderNotionalUsd` (the DUAL venue floor — F34/F7) routes to resolveHeldPosition as `dust_residual` rather than an endless FAK retry; if the re-read shows the market resolved (redeemable / endDate<now+closed — F9), hand off to resolveHeldPosition instead of a FAK. A stuck 'exiting' alerts per-tick.
  Error cases: cannot flatten ⇒ stays 'exit_failed' + CRITICAL + retry next tick (loudest alert; best-effort vs venue uptime — I-9).
  Concurrency (F4/§17-F48): the exit path is NOT covered by the entry-side DB double-execution guards (UNIQUE client_order_id can't collide DISTINCT exit FAK ids; the only exit CAS is applyExit's one-shot 'armed'→'exiting'). A watchdog-aborted in-flight FAK (the JS watchdog can't cancel the await — §17-F12) would let the NEXT tick's resumeExit place a SECOND concurrent FAK on the same residual (racing/duplicate orders, spurious exit_failed, rate-budget churn). GUARD: a per-position `exit_in_flight_until` timestamp **committed to the DB BEFORE the awaited FAK is issued** (set-marker→then-place, ~a few× the expected round-trip — mirroring the ADR-OC-5 entry-side write-intent-THEN-place critical section; the natural place-then-set order leaves the watchdog-abort window UNGUARDED, since a JS timeout can't cancel the in-flight await — §17-F12 — so no marker persists and the next tick double-FAKs — F9); resumeExit SKIPS a position whose exit is in-flight-and-unconfirmed until the marker expires or getOrder confirms terminal — so at most one exit FAK is outstanding per position. The SAME set-marker-before-place ordering applies in **applyExit** (its first FAK, after the 'armed'→'exiting' CAS, equally needs the marker before the await). (Correct the §17-F12 claim that double-EXECUTION is fully DB-prevented — it holds for entries; the exit path needs this marker.)
  Called by: loop.manageBrackets (6.7). Calls: Signer.getHeldShares (F3-r8/F2-r9 — mode-aware; replaces the stale 'fetchPositions' edge, the body re-reads getHeldShares), Signer.cancelOrder/getOrder + Signer.openOrders (F10 cancel a still-resting entry + F5-r9 the ambiguous-'intent' id-less sweep), Signer.placeOrder(FAK), bot_record_exit_order RPC (F3-r10 — persist the exit_taker row FIRST), bot_close_position RPC, resolveHeldPosition (6.6), notifySlack.

reconcilePosition(pos: OpenPosition, venueOrders, venuePositions, deps: BotDeps): Promise<Void>
  Purpose: on startup, reconcile a DB position against the venue (F-OC-07).
  Side effects: matches HEURISTICALLY by tokenId+side EXACT, price within 1 tick, size within minOrderSize, within a recency window (C3b tolerances) + held shares — the CLOB carries NO client_order_id (C3), so we match fuzzily; repairs the state (an order-status 'intent'/'placed' row with a matching resting venue order → position 'maker_resting' with the discovered clob_order_id; a 'placed' order with no matchable venue order AND no held shares → position 'failed'; held shares UNATTRIBUTABLE to any DB position (or exceeding it) → a 'reconcile WARNING' for the operator, never auto-traded — but held shares that DO match an open DB position are ADOPTED via the ENTRY-ADOPT arm above, not warned). **ENTRY-ADOPT arm (F2, CRITICAL): a position in 'intent'/'placed' or the taker-FAK fallback (clob_order_id=null) — OR a RECENTLY-'failed' position from an ambiguous-throw (bounded by created_at within the reconcile window — F40) — whose entry FILLED during the crash window — held venue shares (token+side, size within minOrderSize tolerance) attributable to THIS DB position → PROMOTE to 'armed' by booking the discovered fill: FIRST UPSERT a synthetic `bot_orders` row (status 'matched', `matched_shares` = venue-held shares, `avg_price` = fetchPositions avgPrice, a DETERMINISTIC `client_order_id` derived from the position id so the upsert is idempotent — F5: `bot_fill_with_caps(p_position_id)` takes NO size arg, it DERIVES the cumulative by SUMMING `matched_shares` across the position's order rows, so the adopted size must land on a row first or the SUM stays 0 → entry_shares=0 while CAS'd 'armed', hiding the holding from the F37 MTM kill), THEN call `bot_fill_with_caps(positionId)` (accumulate path) + compute brackets — do NOT leave it as a passive WARNING (else the held YES rides into resolution unmanaged, R-4). A recently-'failed' position with a MATCHING venue holding is adopted-then-managed; with no holding it stays 'failed' (the order provably didn't land). ('maker_resting' carries a clob_order_id so manageFill→getOrder recovers it post-reconcile; the genuinely-stranded states are 'intent'/'placed'/taker-FAK/ambiguous-'failed'.)** **EXIT-RESUME arm (F20): a position already in 'exiting' (a crash mid-FAK-retry) — EXCEPT a `dust_parked` position (F11: it lives in 'exiting' but must NOT be re-FAK'd; a reboot would otherwise re-issue a doomed FAK on sub-min dust every restart — skip it here exactly as manageBrackets does, leaving it for resolveHeldPosition at resolves_at) — → re-read venue held shares, record any executed-but-unrecorded partial via bot_close_position (the F2 SUM-derive path), and immediately re-enter **resumeExit** (the CAS-free continuation — NOT applyExit, whose first-action 'armed'→'exiting' CAS no-ops on an already-'exiting' position and would silently skip the flatten; identical to the manageBrackets per-tick path §6.7 — F4) on the residual.** PRIORITIZE 'exiting' + near-time-stop positions AHEAD of entry repair, and resolved-but-held ahead of both, so reboot flattens/settles before resolution; a stranded 'exiting' eventually escalates to exit_failed+CRITICAL, never sits silently.
  Called by: reconcile.run (6.12a). Calls: Signer.getHeldShares (F3-r8/F2-r9 — mode-aware per DB position, so a PAPER restart reconciles against the synthetic ledger not venue-0) + Signer.openOrders/fetchPositions for the live-only unattributable-holding sweep, bot_repair_position RPC, bot_fill_with_caps RPC (ENTRY-ADOPT accumulate — F13), bot_close_position RPC (the executed-but-unrecorded exit partial — F13), resumeExit (6.6, the CAS-free EXIT-RESUME continuation — F4/F13), resolveHeldPosition (F4), notifySlack (the unmatched-holding warning).
```

### 6.7 `bot/loop.ts` (NEW · the orchestrator)

**Purpose:** one tick of the autonomous loop. Order matters (Pass-3 W3b-ordering fix): **lease first** (the only
whole-tick abort) → **manage existing positions / exits ALWAYS** (gathering the fresh marks) → **then the
entry gate** → place new entries only if the gate passes. The kill never freezes exits — it stops new risk, not
the management of open risk.

```
tick(deps: BotDeps): Promise<TickStats>
  Purpose: one full cycle. CRITICAL ORDERING (Pass-3 W3b-ordering fix): management/EXITS are NEVER frozen by the kill — only NEW-ENTRY placement is gated. A kill or a manual pause that froze exits would strand underwater positions into resolution (the R-4 worst case the kill EXISTS to prevent), and a reboot-while-holding would self-wedge.
  Steps:
    1. acquireLease — bot_loop_lease CAS ONLY. If the lease is lost (another instance owns it) → abort the WHOLE tick (don't double-manage). Nothing else aborts the tick.
    2. const open = await loadOpenPositions(deps).
    3. await manageBrackets(open, deps)   // ALWAYS — gather fresh per-position marks + fire brackets/exits/time-stops. Exits are never gated by the kill. (This also refreshes the marks the kill reads next tick.)
    4. const gate = await risk-guard.entryGate(deps, freshMarks)  // bot_enabled + slack-pause halt + daily-loss (realized + fresh open MTM). Gates ONLY step 5.
    5. if (gate.ok) await placeEntries(open, deps)   // new entries only when the entry gate passes; else skip placing (existing positions were still managed in step 3).
       ELSE (gate closed — F8/§17-F45): await cancelRestingEntries(open, deps) — INCLUDING on `over_cap_halt` (F13-r10, INTENDED: a resting entry that fills while OVER the total cap deepens the breach, so pulling standing entry risk on over-cap is risk-conservative + consistent with "don't add exposure while over cap"; the queue-priority cost is accepted) — a kill/latch gates PLACEMENT but does NOT cancel orders already RESTING, so a pre-kill maker ENTRY still live on the venue would fill and arm fresh share-holding exposure AFTER "down for the day, done". Cancelling a resting ENTRY is neither placement nor exit/management, so it does NOT violate "never freeze management": cancel all 'intent'/'maker_resting' resting entry orders (Signer.cancelOrder), reuse manageFill's cancel-race TOCTOU (re-getOrder for any straggler that filled between latch and cancel), and route any straggler fill straight to applyExit (flatten) rather than arming it. Held positions keep being bracket-managed in step 3.
    6. compute the running openingVerdict over `bot_closed_market_panel` (F2-r10 — the FORWARD panel of ACTUAL closed paper fills, NOT the backtest capture replay) + persist it to bot_gate_snapshot stamped source='forward'; write a bot_tick_log row (F19 liveness/forensics — asOf, counts, gate.reason); emit TickStats; on a surfacing state change → notifySlack.
  Note: the operator's "instant kill" (bot_enabled=false / Slack pause) stops opening NEW risk; it does NOT abandon open positions unmanaged. To force-close, the operator uses flatten (bot_flatten_position, per position or all) — a deliberate, separate action.
  Returns: { ran, placed, filled, exited, entriesGated?, killReason? }.
  Side effects: all DB + Signer effects flow through the managers (this fn orchestrates, doesn't touch the venue directly).
  Error cases: any single position error is caught + logged + alerted; the tick continues (one bad market never halts the loop).
  Called by: opening-bot.ts run loop (6.13b). Calls: risk-guard.acquireLease + entryGate (6.9), loadOpenPositions + manageBrackets + placeEntries (6.7 helpers below), openingVerdict (6.1, over bot_closed_market_panel — F2-r10), bot_record_gate_snapshot + bot_record_tick (F19) RPCs.

loadOpenPositions(deps: BotDeps): Promise<List<OpenPosition>>          # 6.7 helper
  Purpose: load the non-terminal position set for this tick (the open-set index).
  Side effects: bot_open_positions RPC (returns open positions + a closed-today flag per (event,bucket) for the scan dedupe).
  Called by: tick (6.7). Calls: bot_open_positions RPC (§8.2).

manageBrackets(open: List<OpenPosition>, deps: BotDeps): Promise<Map<PositionId, {mark, asOf}>>  # 6.7 helper
  Purpose: drive each open position one step (F-OC-05) AND return the fresh per-position marks gathered (which entryGate then reads for the MTM kill — W3b; the mark source is decideForPosition's /book fetch, not the capture table).
  Side effects: per position, do the per-position `Signer.getHeldShares` read up front (F3-r8 — mode-aware: live wraps fetchPositions, paper returns the bot's synthetic ledger holdings; raw fetchPositions returns 0 in paper) and branch RESOLUTION-FIRST (F6/§17-F6b — matching the §17-F20 reconcile-path priority; a resolved-but-exit_failed position must SETTLE, not re-issue a doomed FAK against a vanished book): (1) market resolved (redeemable OR endDate<now+closed — F9) → resolveHeldPosition (settle/book — F4) REGARDLESS of state; (2) else state 'exiting'/'exit_failed' WITHOUT the `dust_parked` flag → resumeExit (re-read venue-held shares, re-issue FAK on the residual — a CAS-free continuation, so a watchdog-aborted-mid-exit WITHOUT a reboot still flattens; lifts the F20 boot-only resume into the per-tick path; a residual below `bot.minOrderSizeShares` OR below `bot.minOrderNotionalUsd` routes to resolveHeldPosition as `dust_residual` + `dust_parked`, NOT an endless FAK retry — F34/F7); a `dust_parked` position is SKIPPED here (no per-tick work/alert) until `resolves_at < now` → resolveHeldPosition; (3) else — the CATCH-ALL for the remaining open states 'intent'/'maker_resting'/'armed' (NOT an 'armed'-only filter; this is a chained else, and the open set minus resolved/exiting/exit_failed/dust_parked is exactly these three) → manageFill FIRST (polls a resting entry, books the venue fill, runs the maker-window `cancel_maker_take`, CAS 'maker_resting'→'armed' — this is the ONLY path that advances a resting maker entry, so it must run for 'intent'/'maker_resting' too, not just 'armed') then decideForPosition (fetches the BID-side mark — F1) → applyExit if a bracket fired. Runs EVERY tick regardless of the entry kill (Pass-3 W3b-ordering — exits/settlement never frozen). A stuck 'exiting' alerts per-tick (not boot-only).
  Returns: the freshMarks map (one {mark, asOf} per still-open position).
  Called by: tick (6.7) step 3. Calls: Signer.getHeldShares (F2-r9 — the per-position up-front mode-aware held read), resolveHeldPosition + manageFill + applyExit + resumeExit (6.6), decideForPosition (6.4), bot_record_tick is written by tick step 6 (not here).

placeEntries(open: List<OpenPosition>, deps: BotDeps): Promise<Void>    # 6.7 helper
  Purpose: scan + place new entries within caps/approval (F-OC-03).
  Side effects: scanEntries(deps, open) → per candidate openPosition, opened SEQUENTIALLY. THROTTLE (W5b/§17-F41/ADR-OC-13 — F10-r10, the ENFORCEMENT site, since postFillReview/openPosition are per-position and can't gate the loop): during the live first-N (realTradesApproved < firstNApprove), AWAIT each openPosition (whose postFillReview SURFACES the fill — Slack ACTION + realTradesApproved bump) before opening the next candidate — do NOT parallelize the loop (a Promise.all would fire all ~10 live entries in one burst, defeating the burst-bound); it does NOT block on operator acknowledgment (W5). Paper / post-first-N: no throttle.
  Called by: tick (6.7). Calls: scanEntries (6.5), openPosition (6.6).

cancelRestingEntries(open: List<OpenPosition>, deps: BotDeps): Promise<Void>   # 6.7 helper (F8/§17-F45)
  Purpose: on a closed entry gate (kill / daily-loss latch / Slack pause), PULL standing entry risk — cancel resting ENTRY orders so a pre-kill maker entry can't fill and arm fresh exposure after "done for the day".
  Side effects: for each position in 'intent'/'maker_resting' with a known resting entry order, Signer.cancelOrder; re-getOrder for the cancel-race terminal count (W4b TOCTOU). A straggler that filled between latch and cancel is BOOKED FIRST (F6 — it is NOT 'armed', and applyExit's first action is the 'armed'→'exiting' CAS which would no-op on a 'maker_resting'/'intent' straggler): upsert a synthetic 'matched' bot_orders row + bot_fill_with_caps → CAS to 'armed' (the ENTRY-ADOPT path, so entry_shares>0 and the F37 kill sees it), THEN applyExit (which re-reads Signer.getHeldShares to size the flatten — F2-r9, mode-aware). ALSO (F6, hole b): an F40 ambiguous-'intent' position has NO clob_order_id but MAY be resting on the venue → do a `Signer.openOrders` sweep and cancel heuristically-matched entry orders (the reconcilePosition fuzzy match: tokenId+side exact, price within 1 tick, size within minOrderSize, recency) for open positions lacking a known id, so the kill actually pulls the phantom. Leaves held-position bracket management (step 3) untouched.
  Called by: tick (6.7) when entryGate returns ok=false. Calls: Signer.cancelOrder/getOrder, Signer.openOrders (F6 hole-b ambiguous-'intent' sweep — F14-r9), bot_fill_with_caps RPC (F6 ENTRY-ADOPT straggler booking — F14-r9), applyExit (6.6).
```

### 6.8 `bot/approval.ts` (NEW · ADR-OC-13)

```
postFillReview(pos: OpenPosition, deps: BotDeps): Promise<Void>
  Purpose: the first-N-real-trades POST-fill review (W5/ADR-OC-13). Paper ⇒ no-op. Live & realTradesApproved ≥ firstNApprove ⇒ no-op. Live & under N: AFTER the (capped, tiny) fill is recorded, raise a Slack ACTION + a /bot row with a one-click halt/flatten, and increment the realTradesApproved counter.
  Note: the entry is NEVER delayed for approval (the flat-open edge cannot wait for a human click — W5). The operator's control during the review window is the bot_enabled flag + a per-position flatten action, not a pre-placement gate.
  Called by: position-manager.openPosition (6.6, after a live fill). Calls: bot_bump_reviewed RPC, notifySlack.
```
  The operator's review action is `bot_flatten_position` (§8.2), surfaced by the `/bot` page action (6.11a) —
  it CAS-marks the position 'exiting' (DB-only; the Vercel/SQL path cannot hold the Signer — F9); the VPS loop
  flattens it on its NEXT tick via `manageBrackets→resumeExit` (the only key-holder). There is no `pending_approval` parked state (it would let the edge
  converge away); the risk caps + daily-loss kill bound the blast radius of the first auto-placed live fills.

### 6.9 `bot/risk-guard.ts` (NEW · the kill chokepoint — ADR-OC-8)

```
acquireLease(deps: BotDeps): Promise<{ ok: Boolean, reason?: String }>
  Purpose: the per-tick SINGLE-INSTANCE guard — the ONLY thing that can abort a whole tick (Pass-3 W3b-ordering fix; management must never be frozen by the kill).
  Side effects: bot_loop_lease CAS (this instance owns/took an expired lease for leaseTtlSec).
  Returns: ok=false reason 'lease_lost' → the loop skips the WHOLE tick (another instance is managing). Nothing else aborts a tick.
  Called by: loop.tick (6.7) step 1. Calls: bot_loop_lease RPC.

entryGate(deps: BotDeps, freshMarks: Map<PositionId, {mark, asOf}>): Promise<{ ok: Boolean, reason?: String }>
  Purpose: the NEW-ENTRY gate (F-OC-08) — gates ONLY placeEntries, NEVER exits/management.
  Side effects: bot_should_run(p_open_marks) RPC — reads bot_enabled (the operator kill — F4-r10: NOT the global `alerts_slack_paused`, which stays alert-suppression-only) and today's realized loss PLUS the open-position MTM unrealized loss. bot_should_run DERIVES the open set AUTHORITATIVELY from bot_positions (NOT the caller-supplied map). The MTM is SCOPED TO SHARE-HOLDING positions only — `entry_shares > 0` (states 'armed'/'exiting'/'exit_failed') — F37/§17-F37: unfilled 'intent'/'maker_resting' rows hold ZERO shares (entry_shares null-until-filled) and contribute 0, NOT a phantom worst-case loss (else three resting $20 entries register $60 of fake drawdown and self-wedge the −$30 kill whenever a couple maker entries rest). For a HELD position it applies the BID-side fresh mark (F1) where present, else the CONSERVATIVE worst-case (bucket worthless) to any HELD position MISSING a fresh mark — including one whose /book fetch FAILED this tick and is ABSENT from freshMarks (the F10-fetch-failed case — trusting only the supplied map would silently exclude unmarked underwater HELD positions and hide drawdown). Staleness/absence can thus only OVER-state drawdown of held risk, never hide it; zero-share rows never inflate it.
  Returns: ok=false reason (disabled / daily_loss_kill / circuit_break / over_cap_halt — F1/F4-r10: no `halted`, the global-slack-pause halt was dropped) → placeEntries is SKIPPED this tick (existing positions were still managed). No self-wedge: a kill blocks new risk while brackets/exits keep flattening. (`insufficient_balance` is NOT an entryGate reason — it is raised downstream by capsHeadroom/bot_open_position as a per-candidate `skip:wallet_deployed`, F38; entryGate only calls bot_should_run.)
  Called by: loop.tick (6.7) step 4. Calls: bot_should_run RPC.
  Circuit breaker (F18): bot_should_run ALSO trips on a SYSTEMIC failure the daily-loss number can't see → set bot_enabled=false + one CRITICAL Slack. **The counters are PERSISTED in `bot_circuit_state(mode, consecutive_failures, consecutive_ambiguous)` (F11/§17-F42 — NOT process memory: a crash/OOM-loop is exactly the churn F18 catches, and an in-memory counter would reset on every restart; the stateless service-role bot_should_run cannot read a TS-process counter).** TWO trip dimensions (F3/§17-F44): (a) `consecutive_failures ≥ bot.maxConsecutiveFailures` — definitive placement REJECTS (incremented by `bot_record_order_result` on a 'failed' write ONLY — NOT `bot_fill_with_caps` on `caps_exceeded_held`, which drives the SEPARATE auto-clearing `over_cap_halt` latch per §8.2/F3, never this systemic breaker — F1); (b) `consecutive_ambiguous ≥ bot.maxConsecutiveAmbiguous` (a small tunable, ~3–5) — consecutive AMBIGUOUS/timeout throws (incremented by openPosition's F40 ambiguous branch), which is THE common broken-venue mode (a CLOB brownout produces timeouts, not explicit rejects — without this dimension the breaker never trips during a down-venue brownout while phantom 'intent's accumulate, F3). Both reset to 0 on any successful placement; transient ERR_RATE_LIMITED/ERR_INSUFFICIENT_BALANCE never increment either. This stops the loop churning into a broken venue (malformed data / auth / clock OR down/unreachable) rather than retrying every tick. **OPERATOR RESET (F2/§17-F43b): the trip is fail-closed with NO auto-clear (unlike `bot_daily_kill`'s day-boundary), so re-enabling needs a deliberate reset** — `setBotEnabled(true)` ATOMICALLY zeroes both counters + clears `tripped_at` (the human acknowledgment), so the next tick doesn't immediately re-trip; without this the rail is permanently wedged (entries disabled, counter never resets because placement is gated) recoverable only by direct SQL. Gates entries only (exits/flatten still run).

capsHeadroom(c: EntryCandidate, deps: BotDeps): Promise<{ ok: Boolean, sizedUsd: Number, reason?: String }>
  Purpose: a PRE-place sizing estimate (advisory) so we don't place obviously-over-cap; the authoritative re-check is at-fill in bot_fill_with_caps (W17 — never trust a pre-read outside the lock). Uses the bot's OWN tracked bankroll + absolute-$ caps (I-11), not %-of-bankroll.
  Free-cash ceiling (F38/§17-F38): a BUY is ALSO gated on `bot_bankroll.free_pusd ≥ entry cost + fee + a small gas/buffer reserve` — a ceiling DISTINCT from the EQUITY-based exposure cap (the §17-F9b equity denominator stays for the KILL; it must not double as the spendable-cash check, since held value can't fund a buy). Without it, at the cap edge the at-fill RPC passes while the live placeOrder rejects for insufficient pUSD → a 'failed' placement that would spuriously trip the §17-F18 breaker (conflating "wallet fully deployed" with "venue broken"). An insufficient-balance rejection is classified `skip:wallet_deployed` (logged, NOT CRITICAL), returns reason 'insufficient_balance', and does NOT increment the consecutive-failure counter.
  Called by: position-manager.openPosition (6.6). Calls: bot_exposure RPC (§8.2 — returns bot bankroll incl. free_pusd + current per-position/per-market/total exposure).
```

### 6.10 `supabase/functions/opening-capture/handler.ts` (NEW · keyless — clone of cross-venue-capture)

**Purpose:** each tick (**~2–3 min first-seen poll — §16-D, the flat-open window is ≤~1h**): enumerate open near-dated Polymarket temperature ladders, keep the
ones near listing, walk the **true CLOB depth** per core bucket, read our `house_gaussian` distribution for
the event, build one `opening_captures` row per event, and record them via a service-role RPC. Read-only
against Polymarket; no key, no `packages/trading`, rail-DORMANT-safe.

```
openingCapture(ctx: JobCtx, deps: { now, fetchJson }): Promise<JobStats>
  Purpose: forward capture of flat-open candidates + their depth + our (on-demand-seeded) distribution (F-OC-01).
  Steps:
    1. fetchOpenEvents (page Gamma tag 104596, parseGammaEvent, skip parse failures) — mirrors cross-venue-capture.
    2. select near-dated (lead 0..2) 'highest' events accepting orders, RESTRICTED to the scoped city universe (cfg.bot.cities) with evVol24h ≥ cfg.bot.minVol24hUsd (I-13).
    3. for each, walk the true CLOB /book of the core buckets → per-bucket {bestAsk, buyableWithinBandUsd, bestBid, sellbackUsd} (the executableAsk/bindingExecutable depth-walk pattern).
    4. SIGNAL SEED (C1/C1b/ADR-OC-14) — a TS helper seedHouseDist(ev) (§6.10c), NOT a plpgsql RPC (C1b: buildDistributionForEvent is TS and the OM snapshot is an outbound fetch — neither is possible in SQL). It mirrors the discover-markets TS seam: upsert/discover the event → if no FRESH dist (made_at within freshnessMin), snapshot THIS station's Open-Meteo forecast now (reuse snapshot-forecasts logic) via upsert_forecast_rows, then buildDistributionForEvent → upsert_distribution; finally read the latest house_gaussian back. Skips when the station is unmapped (houseProb null).
    5. align each bucket's houseProb to the LIVE bucket BY LABEL/RANGE IDENTITY (W6/W6b — the dist is a bare probs[] aligned to bucket_idx with NO labels (0005_analytics.sql); the seed read JOINS probs[idx]→market_buckets to attach each label/range, then matches to the live Gamma bucket label/range — NOT positional probs[i]); compute modeIdx = argmax over the LIVE-aligned houseProb (drop any dist-space modeIdx — W6b); resolve the IANA tz NAME from cities.tz, REJECTING Etc/* zones as no_tz (C2b).
    6. buildOpeningCaptureRow → { eventId, citySlug, targetDate, tzName, createdAt (Gamma TRUE listing time — see the surfacing note), hoursSinceListing (anchored on createdAt, NOT first-sighting — listing-anchor fix), peakMid, isFlatOpen, houseSeeded, negRisk (parseGammaEvent.negRiskMarketId != null — F2/F5, REQUIRED for placement + redeem), resolvesAt (Gamma endDate — F6), buckets:[{idx,label,loF,hiF,mid,bestAsk,depthUsd,bestBid,sellbackUsd,houseProb,tokenYes,tokenNo,conditionId}] (F2-r8 — carry parseGammaEvent's ParsedBucket venue ids: placement needs `tokenYes`, redeem/resolve need the venue-independent `conditionId`), evVol24h } (houseProb null where unseeded).
  Surfacing note (Pass-3 listing-anchor): `parseGammaEvent`/`ParsedEvent` do NOT currently carry `createdAt` (verified — `gamma.ts` has no such field). A Phase-0 task must surface it: either extend `RawGammaEvent` + its zod schema + `ParsedEvent` with `createdAt?: string`, OR read `raw.createdAt` off the raw payload in the handler's enumerate loop (the raw event is in hand there). Without this, `hours_since_listing` has no true-listing source and the ≤~1h flat-open gate (§16-D) falls back to first-sighting (biased low).
    7. record_opening_captures(p_rows) (service-role RPC).
  Returns: { asOf, events, nearDated, flatOpen, seeded, captured, inserted }.
  Side effects: read-only Gamma/CLOB; seedHouseDist may write a forecast snapshot + a bucket_probabilities row (via existing write RPCs); one service-role insert RPC. Best-effort: a venue/seed outage shrinks the panel (houseProb null), never fails the job.
  Error cases: parse failures skipped; a book fetch failure ⇒ that bucket depth 0; a seed failure ⇒ houseProb null (logged), the row is still captured (flat-open depth is measured regardless — the experiment).
  Called by: opening-capture/index.ts (6.10a). Calls: parseGammaEvent + normalizeBook (core, reuse), buildOpeningCaptureRow (pure.ts, 6.10b — which calls isFlatOpen), seedHouseDist (6.10c), record_opening_captures RPC, runJob ctx.log.
```

**6.10a `opening-capture/index.ts`** — Deno entry; `periodKey = 'opening-capture:{date}T{hh}:{mmSlot}'` (a ~2–3 min slot — §16-D);
`runJob('opening-capture', periodKey, req, (ctx)=>openingCapture(ctx, {now, fetchJson}), { db })`. Mirrors
`cross-venue-capture/index.ts` verbatim except the name + the ~2–3 min slot (§16-D). *Calls:* `getServiceDb`, `runJob`,
`openingCapture`.

**6.10b `opening-capture/pure.ts`** — `buildOpeningCaptureRow(...)` + helpers (pure, tested): assemble the
camelCase row the recorder RPC unpacks; `isFlatOpen` reused from core. *Called by:* handler (6.10).

**6.10c `opening-capture/seed.ts`** — `seedHouseDist(ev, deps)` (NEW TS helper, C1b/ADR-OC-14). The on-demand
forecast→dist orchestration, in TS (NOT plpgsql), mirroring the `discover-markets` seam
(`discover-markets/index.ts:34-35` injects `buildDistributionForEvent` as the TS `seedDistribution` dep, used
at `handler.ts:204`). Steps: (1)
discover/upsert the event so it has an `event_id` AND resolve `city_id`+`icao` for the `upsert_event` call
(`0012_discovery_rpcs.sql` requires `p_city_id uuid` + `p_icao`); **(1b) UPSERT THE WALKED LADDER INTO
`market_buckets` via `upsert_bucket` per parsed bucket — MANDATORY (F9): `buildDistributionForEvent`
short-circuits and writes NOTHING when `market_buckets` is empty (`distributions.ts:82` requires buckets +
icao + ladderOk; `get_build_inputs` sources buckets ONLY from `market_buckets`, `0033:38`). The discover seam
seeds BEFORE its own `upsert_bucket` loop and only `if is_new`, so a naive copy no-ops on a brand-new event →
`houseProb` null for ~every flat-open market → Phase-0.5 false NO-GO. The handler already holds
`parsed.buckets` from `parseGammaEvent`, so the upsert is data-in-hand.**; (2) if the latest
`house_gaussian.made_at` is older than `cfg.seedFreshnessMin` (or absent), snapshot THIS one station's
Open-Meteo forecast now — reuse the `snapshot-forecasts` fetch+parse logic (`snapshot-forecasts/handler.ts:68-98`:
`fetchJson(forecastUrl(station))` → `parseMultiModelDaily` → `upsert_forecast_rows`), then call the existing
TS `buildDistributionForEvent` (`_shared/distributions.ts:69`) → `upsert_distribution`; (3) read the latest
`house_gaussian` joined to `market_buckets` for per-bucket labels (W6b); **(3c) SHARED-TABLE ISOLATION (F16-r9): the on-demand seed writes the SAME `bucket_probabilities`/`forecast_rows` tables the 2×/day production pipeline writes AND the existing analytics consumers read (`/data` `dash_data` migration 0065 takes the freshest `house_gaussian` per (event,lead); run-calibration/model_stats; /amsterdam). An extra bot-cadence snapshot for a SCOPED city becomes the scored champion argmax there while non-scoped cities keep the 2×/day snapshot → the house-vs-market accuracy gap on scoped cities is no longer apples-to-apples. RESOLUTION: TAG bot-seeded distributions/forecast rows (a `seed_origin`/`seeded` flag or a `house_gaussian_seed` source suffix) and EXCLUDE them from `dash_data`, run-calibration's residual set, /amsterdam, and the dormant bets reader — the entry-scanner's `latest_house_dist` reads the seed source, the analytics readers exclude it. MECHANISM (F11-r10): `buildDistributionForEvent` hard-codes `write('house_gaussian')` with NO tag hook, so add an OPTIONAL `p_seeded` boolean to `buildDistributionForEvent` + `upsert_distribution` defaulting to current behavior (keeps build-distributions/discover-markets/metar-nowcast byte-identical, NO ripple) + a nullable `seeded` column on `bucket_probabilities`/`forecast_rows` in 0066; add `AND NOT seeded` to dash_data (0065), run-calibration's residual set, /amsterdam, the bets reader. SEQUENCING (F11-r10): LIFT these four consumer-exclusions + the tag column INTO the Phase-0 roadmap DoD (not just §15), so the seed never reaches prod ahead of its exclusions; + a §15 regression test that a bot-seed does NOT move dash_data's argmax/Brier for a scoped city.** **(3b) SEED-QUALITY GATE (F15/§17-F15):
a fresh dist can be degenerate even when it EXISTS** — a sparse model set (some models 404'd that tick), an OM
outlier, or an under-calibrated lead. Before the seed may drive entries, require a **minimum number of
contributing models** (`cfg.seedMinModels`), a **dispersion/mode-confidence bound** (the mode bucket prob not
implausibly spiked/flat), AND **`model_stats` calibration coverage for that station+lead**. If ANY check fails,
return `houseProb=null` (capture the depth, do NOT enter) — existence is necessary but not sufficient, and
selectEntries treats any non-null houseProb as enterable, so the gate MUST live here / in selectEntries.
*Inputs:* station lat/lon (from
`stations`), `city_id`+`icao`, the enabled model list, `omForecastBase` + the OM key (edge secrets). *Returns:*
`{ seeded, probsByBucketLabel, quality }` (quality = the F15 gate result + reason) or `{ seeded:false }` when the station is unmapped / OM unavailable / the quality gate failed. *Called
by:* handler (6.10). *Calls:* `buildDistributionForEvent` + the `snapshot-forecasts` fetch logic +
`parseMultiModelDaily` (reuse), `upsert_event` / `upsert_bucket` / `upsert_forecast_rows` /
`upsert_distribution` / `latest_house_dist` (write/read only — all the compute is TS). *Burst bound (F16):*
the seed is heavy (per-event OM snapshot + dist build); the handler must (a) run the depth-walk + the
`record_opening_captures` insert FIRST (the load-bearing flat-open measurement always completes, even if
seeding is slow), (b) cap seed concurrency (~3–4 in-flight) with a per-invocation seed time-budget that, once
exceeded, records remaining rows `houseProb=null` rather than timing out the edge wall-clock, and (c) dedupe
the OM fetch per station within one invocation (leads 0/1/2 of one city share one forecast — ~3× fewer
fetches). `seedFreshnessMin` is the steady-state guard, NOT the rollover-burst guard.

### 6.11 `apps/web/src/app/(dash)/bot/page.tsx` (NEW · mirrors /data)

**Purpose:** the operator monitoring surface (F-OC-11). Server component, `force-dynamic`, behind the
`(dash)` `requireOperator()` gate; one `getBotView(serverDb())` call → render with `.ams-dash`.

```
BotPage(): Promise<ReactElement>
  Purpose: render live positions, fills, realized+unrealized PnL net-of-fees, per-market outcomes, and the running paper-gate verdict.
  Side effects: await getBotView(await serverDb()) → one dash_bot RPC.
  Called by: Next.js router. Calls: getBotView (loaders.ts, 6.11c), serverDb (lib/supabase.ts, reuse), BarChart/LineChart (reuse), PositionTable (6.11b).
```
**6.11a `bot/actions.ts`** — server actions `flattenPosition(id)` / `setBotEnabled(bool)` (operator-gated;
call `bot_flatten_position` / `bot_set_enabled(bool)` RPCs — the latter atomically clears the F42 breaker
counters on re-enable, F2; a `/bot` "circuit tripped — reset" surfaces it when `bot_circuit_state` shows a trip).
*Called by:* the page's flatten/kill/reset buttons (the post-fill-review controls, W5/ADR-OC-13). **6.11b `PositionTable.tsx`** — a small RSC table
(NEW). **6.11c `loaders.ts +getBotView(db)`** — `one<BotPayload>(db, 'dash_bot', {})` then shape to the view
model (mirrors `getDataAccuracy`).

### 6.12 `bot/reconcile.ts` + `bot/db.ts` (NEW)

```
run(deps: BotDeps): Promise<{ repaired: Number }>          # reconcile.ts (F-OC-07)
  Purpose: on startup, rebuild open state — load DB open positions + venue open orders + held positions, repair each.
  Called by: opening-bot.ts boot (6.13b) — UNDER the lease (F4-r9: acquire bot_loop_lease BEFORE reconcile, so a double-start's 2nd instance can't reconcile-and-place lease-less). Calls: Signer.getHeldShares (F2-r9 mode-aware per DB position) + Signer.openOrders/fetchPositions (live-only unattributable-holding sweep), reconcilePosition (6.6).

makeBotDb(): BotDb                                          # db.ts (mirrors _shared/db.ts supabasePort)
  Purpose: the service-role Node Supabase client wrapped as a BotDb port { rpc, getConfigRows } for the loop.
  Side effects: reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (Node env).
  Called by: opening-bot.ts (6.13b). Calls: createClient (@supabase/supabase-js, Node).
```

### 6.13 Scripts

**6.13a `scripts/bot/opening-paper-backtest.ts`** — replay accumulated captures through `selectEntries` →
`paperFill` → `bracketDecision` driven off the captured **BID/sellback** series (F1/F4 — the exit decision AND
the exit FILL use the captured `bestBid`/`sellbackUsd`, NOT the mid or ask, minus taker fee + slippage; booking
exits at the mid would false-PASS the money-gate by the exact executable-depth optimism that killed the other
eleven signals) → per-market NET-of-cost realizable P&L →
`openingVerdict` → `bot_record_gate_snapshot`. Prints the running gate. *Calls:* the pure 6.1 functions; reads
the full series via `bot_capture_series` (§8.2 — NOT `bot_latest_captures`, which is freshest-per-event only).
No key, no placement.
*DoD — continuous mark series (F7/§17-F35b):* the backtest DEPENDS on capture emitting for an entered market's
FULL life (capture is universe-wide near-dated, NOT flat-open-gated — §6.10 step 2; ADR-OC-8's W3b note is
corrected accordingly). But §6.10 step-2's `evVol24h ≥ minVol24hUsd` filter means a held market that drops
below the vol floor mid-hold STOPS being captured, truncating `bot_capture_series`. Required behavior: assert
each entered market has a continuous mark series through the time-stop; on a mid-hold truncation, do NOT
silently model only the time-stop terminal (that would systematically bias the gate toward no-TP/SL outcomes) —
instead CARRY the last good bid forward as a conservative worst-case mark, OR exclude+flag the market from the
panel. Never let a gap read as "held to time-stop."

**6.13b `scripts/bot/opening-bot.ts`** — the forward driver. `--mode paper` (default) builds a `PaperSigner`;
`--mode live` requires `tradingMode='live'` (and **`--mode paper` requires `tradingMode='paper'`** — F22: a SYMMETRIC boot assertion, refuse to start on mismatch, so the loop's stamped `bot_tick_log.mode` and `bot_deadman_check`'s `tradingMode`-keyed partition can NEVER diverge — e.g. a leftover `tradingMode='live'` after a failed smoke-test fallback to `--mode paper` surfaces immediately instead of as silent deadman misdirection) + `bot_enabled=true` and builds `createNodeClobSigner`. Boots: **acquire `bot_loop_lease` FIRST (F4-r9 — reconcile.run can PLACE (EXIT-RESUME→resumeExit FAK) and redeem, yet runs BEFORE the tick loop's step-1 lease; on an operator double-start two instances would otherwise reconcile-and-FAK concurrently with NO lease held, and `exit_in_flight_until` is a per-process timestamp not a cross-process CAS — so take the lease before reconcile, skip reconcile entirely on `lease_lost`, and keep it through the first tick via `leaseTtlSec > tickWatchdogSec + margin`), then**
`reconcile.run` → then a **self-chaining loop**: `await tick()` wrapped in a wall-clock timeout (`tickWatchdogSec`
— so a hung await can't freeze the loop/kill-check), THEN `setTimeout(next, tickIntervalSec)` — NOT `setInterval`
(W2b). The self-chain prevents overlap on the HAPPY path; a fired watchdog may leave an in-flight DB/Signer call
running (a JS timeout cannot cancel it — F12), so **double-EXECUTION is prevented at the DB layer (CAS, the
partial-unique open constraint, UNIQUE client_order_id, atomic `bot_fill_with_caps`), NOT by JS timing**; the
watchdog also sets a "tick aborted" flag the in-flight ops check before any `placeOrder`, and `leaseTtlSec` >
`tickWatchdogSec` + margin (F12) so a stolen lease can't co-place. Also re-runs `reconcile.run`
**PERIODICALLY** (every `reconcileEveryTicks`, not boot-only — F3/§17-F44), so the ENTRY-ADOPT arm adopts +
bracket-manages phantom `intent` fills DURING a running brownout instead of leaving them unmanaged until the next
reboot or resolution (the §6.6 "boot/periodic" phrasing now has a periodic driver). Runs an independent 5s
`Signer.heartbeat()` ONLY if the optional user-websocket fill-feed is open (§16-F) + writes `bot_set_bankroll`
(free/held/base + POL, F10) at boot + periodically (F14) + a startup/periodic `clockSanityCheck` (F10/F21).
`--once` runs a single tick (cron-friendly). Live boot is GATED on `bootstrapApprovals()` + the §17-F17 smoke
test passing (F11 — `--bootstrap`/`--smoke-test` flags; live refuses to tick until both pass). *Calls:*
`makeBotDb` (6.12), `createPaperSigner`/`createNodeClobSigner` (6.3), `reconcile.run` (6.12), `loop.tick` (6.7),
`Signer.bootstrapApprovals` (live boot, F11).

**6.13c `scripts/research/opening-spike.ts`** (F11-r8) — the **Phase-0.5 go/no-go spike**, the decisive kill gate
that authorizes Phases 2–6 (it had a DoD but no artifact — every other phase names a concrete module + test). Over
≥1 week of Phase-0 `opening_captures`: per `event_id`, select the FIRST capture with `house_seeded=true` / non-null
`houseProb`, run `isFlatOpen` (6.1) on it, read the center (mode±1) bucket `depthUsd`, and emit the **GO fraction**
= share of events that are STILL flat-open (peakMid ≤ 0.18) AND carry center depth ≥ the §9R depth floor at
first-house-dist. *DoD:* a one-page verdict + a numeric bar — **GO iff that fraction ≥ `bot.spikeGoFrac` (e.g. 0.5)
over ≥1-week events; else KILL the lever (update `FINDINGS.md`)**, replacing the prose "mostly NO". Reads via
`bot_capture_series` (filter first-seeded per event in TS) — no new RPC. *Calls:* `bot_capture_series` (§8.2),
`isFlatOpen` (6.1).

---

## 7. Data Models

Migration `0066_opening_convergence.sql`. RLS-on; service-role writes, operator reads via `dash_bot`. All
timestamps `timestamptz`; money `numeric`.

**Entity: `opening_captures`** (append-only; written by the keyless edge fn)

| Field | Type | Constraints |
|---|---|---|
| id | bigint identity | PK |
| captured_at | timestamptz | not null |
| event_id | uuid | FK → market_events (nullable if pre-discovery) |
| city | text | not null |
| target_date | date | not null (**station-local**, C-6) |
| tz_name | text | not null — the city's IANA tz NAME from `cities.tz`, REJECTING `Etc/*` (C2/C2b/ADR-OC-12), e.g. 'Australia/Sydney' |
| created_at_gamma | timestamptz | the event's TRUE listing time from the raw Gamma `/events` `createdAt` field — surfaced through `RawGammaEvent` (zod) + `ParsedEvent` per the Phase-0 listing-anchor task (NOT `polymarket-wallet.ts` `MarketMeta.createdAt`, a per-market io field — F26); the flat-open window anchor |
| listing_detected_at | timestamptz | first tick we saw the event (diagnostic only) |
| resolves_at | timestamptz | the Gamma event `endDate` (F6) — carried capture→entry onto `bot_positions.resolves_at` as the venue-independent resolution clock |
| hours_since_listing | numeric(6,2) | now − `created_at_gamma` (NOT first-sighting — the listing-anchor fix; first-sighting biases the ≤~1h gate downward) |
| peak_mid | numeric(6,4) | max bucket mid (flat-open input) |
| is_flat_open | boolean | not null default false (peak ≤ 0.18 ∧ ≤~1h — §16-D, NOT 6h) |
| house_seeded | boolean | not null default false — was a fresh house_gaussian available/seeded (C1 diagnostic) |
| buckets | jsonb | `[{idx,label,loF,hiF,mid,bestAsk,depthUsd,bestBid,sellbackUsd,houseProb,tokenYes,tokenNo,conditionId}]` — houseProb aligned BY LABEL/RANGE IDENTITY (W6), null if unseeded; `tokenYes`/`tokenNo`/`conditionId` from parseGammaEvent's ParsedBucket (F2-r8 — placement needs `tokenYes`; redeem/`resolveMarketsMeta` need the venue-independent `conditionId`) |
| ev_vol24h | numeric(14,2) | event 24h volume (the §9R $7k+ filter input) |
| neg_risk | boolean | not null default true — from `parseGammaEvent.negRiskMarketId != null` (F2/F5); flows capture→scanEntries→openPosition so placement passes the required `negRisk` and the position persists it for redeem |

Indexes: `(event_id, captured_at desc)`; `(is_flat_open, captured_at desc) where is_flat_open`;
`(city, target_date, captured_at desc)`.
**Retention (F15-r10):** both append-only tables (opening_captures, bot_tick_log) get a 0066 pg_cron prune on a continuously-running rail — `DELETE FROM opening_captures WHERE captured_at < now() − interval '90 days'` (gate-relevant window) + `DELETE FROM bot_tick_log WHERE as_of < now() − interval '30 days'` (liveness/forensics; the deadman only needs max(as_of)); for open-ended Phase-7 prefer monthly range-partition + DROP. Index-backed max() reads don't slow, but disk/bloat is unbounded without this.
Common queries: latest capture per event (entry scan); the flat-open series per event (paper backtest mark
path).

**Entity: `bot_positions`** (the lifecycle state of record — ADR-OC-4)

| Field | Type | Constraints |
|---|---|---|
| id | uuid | PK default gen_random_uuid() |
| mode | text | not null check in ('paper','live') |
| event_id | uuid | FK → market_events |
| city | text | not null |
| target_date | date | not null |
| tz_name | text | not null — IANA tz NAME (time-stop, C2); fail-closed: not entered without it |
| bucket_idx | int | not null |
| bucket_label | text | not null — the bucket's label/range, for identity alignment (W6) |
| token_yes | text | not null |
| condition_id | text | not null — the venue market `conditionId` (F2-r8), persisted at entry from EntryCandidate (sourced from parseGammaEvent's ParsedBucket); the venue-INDEPENDENT key for `resolveMarketsMeta(conditionId[])` + `Signer.redeem(conditionId,…)` so the §17-F4/F36b absent-/positions-row settlement path has a source when the live WalletPosition row is gone — mirrors how `neg_risk`/`resolves_at` are persisted |
| neg_risk | boolean | not null default true — negRisk flag (F2/F5), set at entry from `parseGammaEvent.negRiskMarketId != null`; weather is negRisk winner-take-all so the default is true. Passed to `placeOrder.negRisk` (REQUIRED — a wrong value gets the order rejected, REPORT §1) AND to `Signer.redeem.negRisk` (NegRiskAdapter branch, F14c); survives a reconcile-from-DB boot where the venue parser is the only other source |
| state | text | not null check in ('intent','maker_resting','armed','exiting','closed','resolved','rejected','failed','exit_failed') — 'resolved' = market settled while still held (F4, §17-F4 books terminal value); 'rejected' = a post_only would-cross rejection (F29, expected, not CRITICAL); no 'pending_approval' (W5) |
| model_prob | numeric(6,4) | our house_gaussian prob at entry |
| entry_price | numeric(8,6) | filled entry (null until filled) |
| entry_shares | numeric(14,4) | filled shares |
| entry_fee_usd | numeric(12,6) | |
| maker_resting_since | timestamptz | for the maker window |
| tp_price / sl_price | numeric(8,6) | armed bracket thresholds (entry+25pp / entry−12pp; tp also ≥ model_prob) |
| time_stop_at | timestamptz | `localHourInstant(tz, target_date, noon)` UTC instant — DST-correct (F11), NOT startUtc+12h |
| resolves_at | timestamptz | the Gamma event `endDate` (F6), captured at entry — the venue-INDEPENDENT resolution clock so `resolveHeldPosition` settles a resolved position even when the live /positions row is absent (a dropped row otherwise wedges it in exit_failed); distinct from `time_stop_at`, which fires earlier (local noon, before resolution) |
| exit_in_flight_until | timestamptz | F4/F9 — committed BEFORE the awaited exit FAK (~a few× round-trip; set-marker→then-place, else the watchdog-abort window is unguarded — §17-F12); resumeExit/applyExit skip a position whose exit is in-flight-and-unconfirmed, so ≤1 exit FAK outstanding per position (the exit-path double-FAK guard) |
| over_cap | boolean | not null default false | F3 — the over-cap-inventory dedupe: the `caps_exceeded_held` CRITICAL fires ONCE on the transition into over-cap, not per tick; drives the auto-clearing `over_cap_halt` (gates placeEntries, NOT the broken-venue breaker) |
| exit_price | numeric(8,6) | |
| realized_pnl_usd | numeric(12,6) | net of fees (filled at close) |
| exit_reason | text | take_profit / stop_loss / time_stop / … |
| created_at / updated_at | timestamptz | not null |

Indexes: `(state) where state not in ('closed','resolved','rejected','failed')` (the hot "open" set — note `exit_failed` stays "open" so it keeps being retried/reconciled);
`(mode, target_date)` (PnL/gate); `(mode, state, updated_at)` (the daily-loss "today realized" sum — I-12).
**Partial-UNIQUE (W2 + F20):** `unique(event_id, bucket_idx) where state in ('intent','maker_resting','armed','exiting','exit_failed')` — includes `exit_failed` (an OPEN, share-HOLDING state per the open-set index), so the DB double-open belt persists through the could-not-flatten window where you least want a second position opened. **F6-r9: a 'failed'/'rejected' position that MAY hold a real venue fill (the ENTRY-ADOPT premise — a mis-classified definitive reject that actually landed, or a late fill, within the reconcile window) must ALSO keep occupying the bucket until reconcile confirms it 0-held — else freeing the slot lets a second position B re-open on the same (event,bucket)/`token_yes`, and `getHeldShares(token)` (per-token, NOT per-position) then returns the COMBINED size → mis-sized flatten + an unsatisfiable 'closed' corroboration. scanEntries ALSO dedupes against a recently-'failed'/'rejected' (event,bucket) within the reconcile window, and the ENTRY-ADOPT 'failed'→'armed' promote on a partial-unique conflict WARNs + leaves for manual reconcile rather than throwing.**
— prevents two overlapping ticks (or a double-scan) from opening the same bucket twice at the DB level (belt
to the self-chaining-tick + lease braces).
Relationships: `bot_positions 1:N bot_orders` (via `position_id`).

**Entity: `bot_orders`** (the idempotency intent ledger — ADR-OC-5)

| Field | Type | Constraints |
|---|---|---|
| id | bigint identity | PK |
| position_id | uuid | FK → bot_positions, not null |
| client_order_id | uuid | **UNIQUE not null** (the idempotency key) |
| side | text | check in ('BUY','SELL') |
| intent | text | check in ('entry_maker','entry_taker','exit_taker') |
| limit_price | numeric(8,6) | |
| size_shares | numeric(14,4) | |
| status | text | check in ('intent','placed','resting','matched','cancelled','rejected','failed') — 'rejected' = a post_only would-cross venue rejection (F29; distinct from 'failed' = a placement throw) |
| clob_order_id | text | from the venue (null until placed) |
| matched_shares | numeric(14,4) | |
| avg_price | numeric(8,6) | |
| fee_usd | numeric(12,6) | |
| created_at / updated_at | timestamptz | |

Index: `unique(client_order_id)`; `(position_id, created_at)`; `(status) where status in ('intent','placed','resting')` (reconcile set).

**Entity: `bot_gate_snapshot`** (the persisted net-profit verdict — ADR-OC-10, I-3)

| Field | Type | Constraints |
|---|---|---|
| id | bigint identity | PK |
| computed_at | timestamptz | not null |
| mode | text | not null ('paper'/'live') |
| source | text | not null check in ('backtest','forward') — F2-r10: the §0/GO-LIVE capital gate + dash_bot read ONLY source='forward'; the Phase-3 backtest writes 'backtest' (dev visibility only) so an optimistic replay PASS can NEVER authorize real capital while the forward run is still INSUFFICIENT |
| label | text | not null ('PASS'/'KILL'/'INSUFFICIENT_DATA') |
| n_markets / n_cities / n_distinct_days | int | the data-sufficiency counts |
| win_frac / mean_net_return / ci_low / ci_high / zero_skill_pass_rate | numeric | the verdict numbers |
| reason | text | the human-readable verdict line |

Index: `(mode, source, computed_at desc)` (dash + the go-live gate read the latest source='forward' — F2-r10). Written by `bot_record_gate_snapshot` (the loop summary stamps source='forward'; the paper backtest stamps source='backtest'); read by `dash_bot`.

**Entity: `bot_loop_lease`** — single-row (`owner uuid, expires_at timestamptz`) CAS lease (ADR-OC-8/W2).

**Entity: `bot_daily_kill`** (the LATCHED daily-loss stop — F32/§17-F32) — `(mode text primary key, kill_date
date not null, killed_at timestamptz not null, reason text)`. On the FIRST daily-loss breach for a trading day,
`bot_should_run` upserts this row; thereafter it returns `daily_loss_kill` for the rest of that `kill_date`
**regardless of MTM recovery** (an un-latched per-tick recompute can UN-trip — a recovered underwater position,
or a winner's positive MTM masking booked realized losses — defeating the "once down for the day, done"
semantics of §9R-D). **Two guards keep the latch from self-wedging (F3/§17-F32b):** (1) the breach that UPSERTs
the row must be CONFIRMED by FRESH marks + realized loss — a breach driven by CONSERVATIVE worst-case marks
(stale / `/book`-fetch-failed held positions) drives a SOFT, self-clearing same-tick halt of placeEntries but
NEVER the persisted latch (else a single transient CLOB `/book` outage marks the whole held set worthless,
breaches Σ(held cost), and latches the bot dead for the day on a non-event — silent, since the loop keeps ticking
so the deadmen never fire and a reboot doesn't clear the row). (2) the predicate is PINNED: `bot_should_run`
returns `daily_loss_kill` IFF `kill_date = current_date in bot.killDayTz`; a row with `kill_date < today` is
IGNORED and OVERWRITTEN on the next breach (there is no separate clearing writer — the date column exists exactly
for this; gating on row EXISTENCE would wedge all future days after the first-ever breach). The "trading day"
boundary is a single operator IANA tz (`bot.killDayTz`), since station-local trading spans global UTC days. On
latch, fire ONE Slack notify (so the silent stall stops being eyeball-only). Exits/management/brackets continue
unchanged (the latch gates ONLY placeEntries).

**Config keys** (existing `config` table, parsed via `parseConfigRows`): `tradingMode` (paper|live — reused),
`bot_enabled` (NEW; '1'/'0'), `bot.cities` (the §9R 6–10-city allowlist — I-13), `bot.minVol24hUsd` (≈7000 —
I-13), `bot.paperBankrollUsd` (the paper bankroll source — I-11), `bot.perPositionUsd`, `bot.perMarketUsd`,
`bot.totalConcurrentUsd` (absolute-$ caps — I-11), `bot.killLossUsd`, `bot.killLossPct`, `bot.firstNApprove`,
`bot.realTradesApproved`, `bot.peakMidMax`, `bot.listingMaxHours`, `bot.centerHalfWidth` (I-6),
`bot.entryEdgeMargin`, `bot.maxEntryPrice`, `bot.depthFloorUsd`, `bot.tpDeltaPp`, `bot.tpAtModelProb` (I-6),
`bot.slDeltaPp`, `bot.timeStopLocalHour`, `bot.makerFillWindowMin`, `bot.paperSlippage`,
`bot.paperBookMaxAgeMin`, `bot.tickIntervalSec`, `bot.tickWatchdogSec` (W2b; **invariant: `bot.leaseTtlSec` >
`bot.tickWatchdogSec` + margin — F12**), `bot.leaseTtlSec`, `bot.reconcileWatchdogSec` (the wall-clock bound on reconcile.run; the lease invariant uses max(this, tickWatchdogSec) — F9-r10), `bot.markMaxAgeMin` (W3b MTM staleness),
`bot.seedFreshnessMin` (6.10c), `bot.slFrac` (relative-stop floor — F13), `bot.maxConsecutiveFailures` (circuit
breaker, definitive-reject dimension — F18), `bot.maxConsecutiveAmbiguous` (circuit breaker, timeout/brownout
dimension ~3–5 — F3), `bot.reconcileEveryTicks` (periodic ENTRY-ADOPT/reconcile cadence, not boot-only — F3),
`bot.maxClockDriftSec` (clock-sanity placement-halt threshold — F10/F21), `bot.paperBankrollUsd` already above; `bot.bankrollBaseUsd` (operator-set equity-base snapshot —
the alternative caps/kill denominator per ADR-OC-8 / §17-F9b; feeds `bot_bankroll.base_usd` — F16),
`bot.minOrderSizeShares` (the venue min-lot exit-dust floor, shares — F34), `bot.minOrderNotionalUsd` (the
venue min NOTIONAL exit-dust floor ~$1 — the DUAL test with minOrderSizeShares, F7), `bot.killDayTz` (the single
operator IANA tz defining the daily-loss "trading day" boundary for the latched kill — F32), `bot.seedMinModels`
(seed-quality gate min contributing models — F15), `bot.captureSeededFracMin` (the producer-deadman seeded-fraction floor, e.g. 0.25 — F21) + `bot.captureSeededFracWindow` (its rolling window, e.g. the last 50 is_flat_open captures — F21), `bot.spikeGoFrac` (the Phase-0.5 GO threshold — fraction of ≥1-week events still-flat-open with cheap center depth at first house_gaussian, e.g. 0.5 — F11-r8), `bot.killLatchPersistTicks` (consecutive confirm-window ticks a conservative-mark drawdown must persist before it can latch the daily kill — distinguishes a transient thin bid from a sustained underwater book, e.g. 3 — F1-r9), `bot.minHoldRunwayMin` (minimum minutes from now to the local-noon time-stop for an entry to be allowed — skips after-noon-listed lead-0 markets that would flatten immediately, e.g. 30–45 — F7-r10), `bot.freeCashReserveUsd` (gas/buffer reserve subtracted from
free pUSD in the spend ceiling — F38), `bot.minPolGas` (native-POL floor for the redeem/approval-cost alarm —
F10), `championSource` (the forecast source, reused),
`bot.gate.minMarkets`/`minCities`/`minDistinctDays`/`minWinFrac`.

---

## 8. Interface Contracts

### 8.1 External (HTTP) — the keyless capture edge fn

```
POST /functions/v1/opening-capture
  Purpose: one capture tick (F-OC-01). Triggered by pg_cron ~every 2–3 min, first-seen poll (§16-D; Vault cron_secret).
  Auth: x-cron-secret header (requireCronAuth) — same as every job.
  Request: Body { periodKey?: String }  (manual retrigger override; else derived slot key)
  Response:
    202: { accepted: true, runId, attempt, decision }   (claim_job_run accepted; work continues via waitUntil)
    409: { code:'ERR_ALREADY_RAN', decision }            (period already claimed)
    401: { code:'ERR_AUTH' }                             (bad/missing cron secret)
  Maps to: openingCapture handler (6.10) via runJob (reuse).
```

The bot loop has **no inbound HTTP** — it is an outbound-only VPS process. Operator control is via the `/bot`
page server actions (8.2 RPCs), not an API the bot serves.

### 8.2 Internal Module Contracts (Postgres RPCs — migration 0066)

All `security definer, set search_path = public`; service-role-only for writers, `operator_guard()` for the
dash reader (the 0034 grants contract). Caps/kill RPCs run under `pg_advisory_xact_lock` (the 0019 idiom).

```
record_opening_captures(p_rows jsonb) RETURNS int                       [service_role]
  Purpose: bulk-insert one tick's capture rows (mirror record_cross_venue_captures). Append-only.
  Maps to: opening-capture handler (6.10).

latest_house_dist(p_event_id uuid) RETURNS jsonb                         [service_role]
  Purpose: read the latest house_gaussian for an event JOINED to market_buckets for per-bucket {label, loF, hiF, prob} (W6b — the bare probs[] carries no labels). The READ half of the TS seedHouseDist (6.10c). (The forecast snapshot + dist BUILD are TS, not SQL — C1b; they reuse the existing upsert_forecast_rows / upsert_distribution / discover-upsert write RPCs + the TS buildDistributionForEvent.)
  Maps to: seedHouseDist (6.10c).

bot_latest_captures(p_max_age_min int) RETURNS jsonb                     [service_role]
  Purpose: the freshest capture per still-open event within the age window (entry scan input); houseProb already aligned per bucket.
  Maps to: entry-scanner.scanEntries (6.5).

bot_capture_series(p_days int) RETURNS jsonb                             [service_role]
  Purpose: the FULL ordered capture series per (event, bucket) over a lookback window — the flat-open capture + every later tick's mid — i.e. the mark path the offline paper backtest replays (the freshest-per-event bot_latest_captures cannot supply a series — INFO). Append-only reads.
  Maps to: opening-paper-backtest (6.13a).

bot_open_positions() RETURNS jsonb                                       [service_role]
  Purpose: the non-terminal position set + a per-(event,bucket) closed-today flag (the loop's open-set load + the scan dedupe — I-1/I-2).
  Maps to: loop.loadOpenPositions (6.7); consumed by scanEntries (6.5) for dedupe.

bot_exposure() RETURNS jsonb                                            [service_role]
  Purpose: the bot's OWN bankroll + current per-position/per-market/total exposure (absolute-$, I-11) — the advisory pre-place headroom estimate.
  Maps to: risk-guard.capsHeadroom (6.9).

bot_open_position(p_args jsonb) RETURNS jsonb                            [service_role]
  Purpose: pre-place gate + insert — re-check absolute-$ caps headroom AND the F38 free-cash ceiling (`bot_bankroll.free_pusd ≥ entry cost + fee + bot.freeCashReserveUsd` — distinct from the equity-based EXPOSURE cap, since held value can't fund a buy), then insert a bot_positions row ('intent') + the entry bot_orders intent row (client_order_id, DB-dedup only — C3). Returns {positionId, clientOrderId} or {rejected, reason:'caps'|'insufficient_balance'} — an 'insufficient_balance' rejection is a logged `skip:wallet_deployed`, NOT a failure that trips the §17-F18 breaker (F38). This is the binding pre-place cash CEILING (final vs the advisory capsHeadroom because the at-fill RPC can't un-buy) — but NOT strictly authoritative against the live wallet (F16): `free_pusd` is a boot/periodic snapshot, NOT reserved per insert, so concurrent same-refresh-interval entries can collectively exceed it; the venue `ERR_INSUFFICIENT_BALANCE` → `skip:wallet_deployed` is the true backstop (and the absolute-$ total-exposure cap independently bounds it whenever free_pusd ≥ that cap). Runs under advisory lock.
  Maps to: position-manager.openPosition (6.6).

bot_record_order_result(p_order jsonb) RETURNS void                     [service_role]
  Purpose: write the venue result onto a bot_orders row (clob_order_id; order STATUS 'placed'|'resting'|'matched'|'failed'; matched/avg/fee) + CAS the POSITION state intent→'maker_resting' (note: 'placed'/'resting' are bot_orders.status values, NOT bot_positions.state — INT-W2). Idempotent on client_order_id. F11/F1: a successful placement ('placed'/'resting'/'matched') RESETS BOTH `bot_circuit_state.consecutive_failures` AND `consecutive_ambiguous` to 0 + clears `tripped_at`; a 'failed' write (definitive reject, F40) INCREMENTS `consecutive_failures` — the persisted F18 breaker counter (a transient ERR_RATE_LIMITED / ERR_INSUFFICIENT_BALANCE does NOT increment). The AMBIGUOUS-throw dimension has its own writer `bot_record_ambiguous` (below). The EXIT FAK has its own writer `bot_record_exit_order` (F3-r10 — NOT this RPC: bot_record_order_result CAS's the position intent→'maker_resting', entry semantics wrong for an 'exiting' position, and would reset the entry breaker on an exit fill).
  Maps to: position-manager.openPosition (6.6).

bot_record_exit_order(p_order jsonb) RETURNS void                       [service_role]
  Purpose: F3-r10 — the EXIT analog of bot_record_order_result, the writer bot_close_position's SUM-derive depends on (after §17-F47 stripped the accumulate path, NO roster RPC wrote the exit_taker rows it SUMs — a builder would reuse bot_record_order_result and silently write entry-intent rows → SUM(exit_taker)=0 → R-16 stranding / winners booked $0). Upserts an `intent='exit_taker'` bot_orders row by deterministic client_order_id (idempotent) with the confirmed matched_shares/avg/fee — NO entry-CAS, NO consecutive_failures/ambiguous breaker mutation (an exit FAK must not touch the entry-placement breaker). Runs BEFORE bot_close_position SUM-derives.
  Maps to: position-manager.applyExit/resumeExit/reconcilePosition (6.6).

bot_record_ambiguous(p_mode text) RETURNS jsonb                         [service_role]
  Purpose: F1/F44 — the WRITER for the brownout/timeout breaker dimension (round-5 F44 spec'd the column but left it unwired). openPosition's F40 ambiguous-throw branch calls this to INCREMENT `bot_circuit_state.consecutive_ambiguous`; trips (sets bot_enabled=false + `tripped_at`=now() + one CRITICAL) at `bot.maxConsecutiveAmbiguous`. Reset to 0 by `bot_record_order_result` on any successful placement (above). Without this RPC a CLOB brownout (timeouts → 'intent', no 'failed' write) never trips the breaker.
  Maps to: position-manager.openPosition (6.6, F40 branch).

bot_fill_with_caps(p_position_id uuid) RETURNS jsonb                    [service_role]
  Purpose: the ATOMIC, IDEMPOTENT, ACCUMULATING fill (W4b/F10) — under TRANSACTION-scoped pg_advisory_xact_lock (pool-safe, 0019:30-35,70): re-derive absolute-$ headroom (I-11); DERIVE the position cumulative by SUMMING matched_shares across this position's ENTRY bot_orders rows (`WHERE intent IN ('entry_maker','entry_taker')` — F2: exit_taker rows now live on the same position_id and MUST be excluded from entry_shares; the caller has already persisted each order's terminal size_matched/avg/fee onto its own row — F10, so the SUM correctly blends a maker-partial + a taker-remainder and a re-poll of any one order is a true no-op; does NOT trust a single caller-supplied 'cumulative' which would drop the maker-partial); set entry_shares = the FULL SUM (every venue-matched share — F2: NOT truncated to headroom; you hold them), entry_price = share-weighted blend, entry_fee_usd = SUM of fees, recompute tp/sl, CAS position INTO 'armed' from 'maker_resting' OR 'armed' (successive partials accumulate, NOT bad_state). If the full holding EXCEEDS caps headroom ⇒ still record it in full (never drop held shares) and return outcome:'caps_exceeded_held'. **F3: this is a SEPARATE, AUTO-CLEARING `over_cap_halt` latch (a distinct bot_should_run reason that gates placeEntries and clears when the position flattens) — it does NOT route into the broken-venue `consecutive_failures` breaker.** A static over-cap holding (reachable when concurrent maker GTCs fill past the total cap, which manageFill tolerates) is re-derived as caps_exceeded_held every tick by manageFill's re-poll; routing that into consecutive_failures would false-trip the SYSTEMIC breaker + spam CRITICAL within maxConsecutiveFailures ticks on benign self-correcting inventory. The CRITICAL fires ONCE on the TRANSITION into over-cap (an over_cap flag on the position dedupes), not per tick. Relatedly, manageFill SHORT-CIRCUITS — it only calls bot_fill_with_caps when getOrder reveals NEW matched shares, not on a static already-fully-recorded 'armed' holding. Returns {outcome:'filled'|'partial'|'caps_exceeded_held'|'bad_state', cumulativeShares, caps?, details?}.
  Maps to: position-manager.manageFill (6.6).

bot_close_position(p_position_id uuid) RETURNS void                     [service_role]
  Purpose: record the exit — SYMMETRIC TO §17-F10 (F2/§17-F47 — the caller-supplied `p_exit` accumulate was the pre-F10 anti-pattern that can drop/double-count under multi-tick partial flatten + the F4 concurrent-exit race; a double-count makes the RPC believe the position is flat and CAS 'exiting'→'closed' — a TERMINAL state excluded from the open set + reconcile + resolveHeldPosition, so a real residual is stranded forever = R-16). DERIVES cumulative exit = `SUM(matched_shares WHERE intent='exit_taker')` across the position's `bot_orders` rows — the caller persists EACH exit FAK's CONFIRMED matched_shares/avg/fee onto its OWN exit_taker row with a deterministic client_order_id FIRST (mirroring manageFill's entry write), so a re-record/re-poll is a true no-op. Blends exit_price (share-weighted) + sums fees. **'Fully flat' (the 'exiting'→'closed' CAS) requires CORROBORATION (F7 — a FRESH venue-held==0 ALONE is unsafe: F36b proves the live /positions row drops transiently, so a spurious 0 would terminalize a still-held residual out of the open set + reconcile + resolveHeldPosition = R-16 stranding, the exact failure this gate exists to prevent): CAS 'exiting'→'closed' IFF a FRESH venue-held==0 re-read (via `Signer.getHeldShares` — F3-r8, mode-aware) AND `SUM(matched_shares WHERE intent='exit_taker') ≈ entry_shares` (within the dust tolerance) — REGARDLESS of `resolves_at` (F9-r8: a confirmed full flatten holds 0 tokens, nothing left to settle/redeem; requiring `resolves_at` in the future would route a late-but-COMPLETE flatten — a noon time-stop on a same-day-resolving market — to resolveHeldPosition, whose WIN guard then reads held 0 → 'already redeemed → skip' → books held×price=0, mis-recording a real exit recovery as a full loss + polluting the daily-loss MTM + the F-OC-10 gate). ONLY a genuine exit SHORTFALL (SUM < entry_shares — the dropped-row/R-16 signature) routes to `resolveHeldPosition` (settle/book terminal value); a venue-held==0 with SUM ≈ entry_shares is terminal 'closed' with realized PnL already derived from the exit_taker rows. The arithmetic is now a NECESSARY-but-not-sufficient condition gated BEHIND the venue read, so it does NOT reintroduce the §17-F47 double-count (a real residual still shows as nonzero venue-held).** Books only CONFIRMED fills (a later-failed leg never prematurely closes). realized_pnl_usd net of all fees; exit_reason.
  Maps to: position-manager.applyExit (6.6).

bot_repair_position(p_position_id uuid, p_repair jsonb) RETURNS void    [service_role]
  Purpose: reconcile-time state repair (F-OC-07).
  Maps to: position-manager.reconcilePosition (6.6).

bot_resolve_position(p_position_id uuid, p_settled jsonb) RETURNS void  [service_role]
  Purpose: F4/F36 — book a market-resolved held position to its ACTUAL terminal value + CAS →'resolved'. realized_pnl_usd COMBINES BOTH legs (F1-r10 — a partially-exited-then-resolved position must CREDIT its already-sold proceeds, not just the residual: `realized = SUM(matched_shares×avg_price WHERE intent='exit_taker', net of exit fees) + residual_terminal_value − gross_entry_cost − entry_fee_usd`; the caller SUM-derives the exit_taker rows exactly as bot_close_position does, then adds the residual terminal — without it the bulk-sold leg's proceeds are dropped and the F-OC-10 gate is mis-booked). The RESIDUAL terminal value is the three branches (F36/§17-F36, NOT binary $1/$0): WIN → residual_held×$1 − redeem cost (live: the real pUSD Signer.redeem returns); LOSS → 0; VOID/50-50/UMA-disputed/refunded → residual_held×(actual resolved outcome price) — the caller passes the realized settled value in p_settled (NEVER a forced $1/$0, which would mis-state realized PnL → distort the daily-loss MTM + the F-OC-10 gate). p_settled also carries an `is_void` flag so dash_bot/openingVerdict can EXCLUDE void markets from the gate panel (executed-but-void ≠ a skill outcome). Idempotent. The held-into-resolution accounting path the I-9/R-4 concession requires.
  Maps to: position-manager.resolveHeldPosition (6.6).

bot_record_tick(p_tick jsonb) RETURNS void                             [service_role]
  Purpose: F19 — persist one bot_tick_log row per tick (asOf, mode, ran/placed/filled/exited counts, gate.reason/killReason) — the loop's liveness + forensic trail (the runJob/job_runs analog the keyless capture has but the VPS loop lacked). Drives "last tick age" on /bot + the external deadman.
  Maps to: loop.tick (6.7).

bot_set_bankroll(p_mode text, p_free numeric, p_held numeric, p_base numeric, p_pol numeric) RETURNS void   [service_role]
  Purpose: F14/F9b/F10 — write the live EQUITY components + native POL into bot_bankroll (free_pusd=p_free from Signer.getCollateralBalance which is free-only; held_value_usd=p_held=Σ marked held-position value computed by the caller; equity_usd=free+held; base_usd=p_base operator snapshot; pol_balance=p_pol from Signer.getGasBalance — F10). bot_exposure/bot_fill_with_caps use EQUITY or base as the caps denominator, NOT floating free-cash (§17-F9b); free_pusd is the separate F38 spend-ceiling input; the boot/periodic caller Slack-CRITICALs when pol_balance < bot.minPolGas (F10). Called at startup + periodically.
  Maps to: opening-bot.ts boot + loop (6.13b).

bot_deadman_check() RETURNS jsonb                                       [service_role]
  Purpose: F19/F13 — a pg_cron-invoked check that Slack-CRITICALs if max(bot_tick_log.asOf) for the ACTIVE FORWARD-RUN mode (read from `tradingMode` config — PAPER during Phase 5, live at go-live; NOT hard-filtered to live) is staler than ~2–3× tickIntervalSec; ALSO alarms on a stale `bot_gate_snapshot.computed_at` for that mode (the direct signal the experiment has stopped advancing). F13: the gate-clinching ≥2-week/≥40-market Phase-5 run is PAPER, so a live-only deadman would let a dead paper loop silently stall the gate clock (capture_deadman_check stays green — capture keeps producing — but nothing consumes). The bot_tick_log.mode column is already written per tick, so this is a WHERE-clause change. Reuses the cron + Slack infra.
  Maps to: a new pg_cron job (migration 0066) + notifySlack.

capture_deadman_check() RETURNS jsonb                                   [service_role]
  Purpose: F35/§17-F35 — the PRODUCER-side deadman bot_deadman_check (a consumer-side check) does NOT cover. Slack-CRITICALs if (a) max(opening_captures.captured_at) (or the latest opening-capture job_runs row) is staler than ~2–3 poll intervals (≈6–9 min at the §16-D 2–3 min cadence), OR (b) the seeded-fraction COLLAPSES — the seeded fraction over the last `bot.captureSeededFracWindow` is_flat_open captures (`COUNT(houseProb IS NOT NULL)/COUNT(*)` via the `house_seeded` boolean) drops below `bot.captureSeededFracMin` (~0.25) — F21: parameterized so the alarm carries an operator-tunable false-positive knob, not an invented constant. Both are needed because DF-1 makes BOTH a Gamma fetch failure AND a seed failure non-fatal/silent (houseProb null / smaller panel, never a failed job), so a plain row-count/job-success check is insufficient: if the cron breaks or the seed path silently fails, opening_captures stops accruing USABLE rows, the bot scans empty and never trades, and the ≥2-week/≥40-market Phase-5 clock STALLS with no alarm — camouflaged by the expected ~62% no-entry rate. Guards the load-bearing forward experiment + the bot's only entry-data source.
  Maps to: a 2nd pg_cron job (migration 0066) + notifySlack.

bot_should_run(p_open_marks jsonb) RETURNS jsonb                        [service_role]
  Purpose: the per-tick NEW-ENTRY gate — {ok, reason?} from bot_enabled (the operator instant-kill — F4-r10: the bot does NOT read the global `alerts_slack_paused` as a halt, since that flag is TRUE on prod for whale-noise control (allowlist=WHALE_TRADE) so reading it would either stall the bot forever OR force un-pausing every whale-watch alert; `alerts_slack_paused` does ONLY 0055 alert-suppression, never placement-gating; the operator kill is bot_enabled=false + per-position flatten) and today's realized loss (WINDOWED in `bot.killDayTz` — F8-r8: the SAME day boundary as the latch's `kill_date`, NOT the server-tz/UTC `current_date`; sum realized_pnl_usd over ALL rows with any booked realized this killDayTz — closed/resolved AND the partial-exit SOLD-leg realized on 'exiting'/'exit_failed'/dust_parked rows (F1-r10: partial-exit realized is booked INCREMENTALLY at each confirmed exit_taker fill, not only at terminal close; without it the sold-at-loss leg of a partial-exit-into-dust position — the NORM on thin inventory, since F3-r9 nets the sold shares OUT of unrealized — contributes 0 realized AND ~0 MTM, so the kill is blind to it all day and §9R-D 'down for the day = done' silently fails) — whose `(updated_at AT TIME ZONE bot.killDayTz)::date = current_date in killDayTz`, since station-local trading spans UTC days and an unpinned window would under-count → fail-to-latch, or count a prior killDayTz-day loss → false-latch on a different day than kill_date) PLUS open-position MTM unrealized loss (marked from the caller-supplied fresh per-position marks; a mark older than markMaxAgeMin → conservative worst-case — W3b, NOT the lagging opening_captures table) vs `killLossUsd` OR `killLossPct × bot.bankrollBaseUsd` (the day-start FIXED base, NOT floating equity — F17), live mode. Gates ONLY placeEntries, never exits.
  MTM scope (F37/§17-F37): the unrealized sum covers ONLY share-holding positions (entry_shares>0 — 'armed'/'exiting'/'exit_failed'); unfilled 'intent'/'maker_resting' rows hold zero shares and contribute 0 (never a phantom worst-case loss that would self-wedge the kill while maker entries merely rest). EACH held position's unrealized contribution is FLOORED at 0 — `max(0, cost − mark)` — computed on the RESIDUAL held quantity `qty = entry_shares − SUM(matched_shares WHERE intent='exit_taker')`, NOT gross entry_shares (F3-r9: a partially-exited position — esp. a `dust_parked` residual lingering until resolves_at — would otherwise count the GROSS original cost while the already-sold portion's recovery is booked NOWHERE until the terminal 'closed' CAS, double-counting sold shares as still-at-risk → a few near-flat positions wedge placeEntries for the day, re-introducing the phantom drawdown F37 set out to kill via the partial-exit door F37 never closed; a `dust_parked` residual is valued at its residual quantity, not gross) — so a concurrent WINNER's positive MTM can never mask already-booked realized losses (the design's stated "staleness can only over-state drawdown, never hide it" must also hold across position netting — F32). DEPTH-SHORTFALL MARK (F2): a held position whose fresh BID-side mark is realizable only over `fillableShares < heldShares` (thin flat-open book) is marked CONSERVATIVELY — the fillable slice at its realizable price, the unfillable remainder at last-trade-or-0 — and is treated as NOT fresh-marked for the §17-F32b CONFIRMED latch sum (it drives the SOFT same-tick halt, never the persisted latch). So a thin bid can only OVER-state drawdown (never silently HIDE it), and a transient depth shortfall can never LATCH the day's kill dead. **SUSTAINED-BREACH LATCH (F1-r9): the conservative-mark EXCLUSION from the CONFIRMED latch sum is scoped to TRANSIENT shortfalls ONLY — because a thin bid is the structural NORM for this inventory (§6.4), permanently excluding it would mean unrealized drawdown NEVER persists the latch and ADR-OC-8's "a book of underwater-but-unexited positions trips the breaker" would not hold. So a held position's CONSERVATIVE drawdown MAY persist the latch once it has stayed breached for `bot.killLatchPersistTicks` CONSECUTIVE confirm-window ticks (a per-position counter, reset on any fresh-marked or non-breaching tick); a one-tick /book outage or transient thin bid still cannot latch, but a SUSTAINED underwater thin-book drawdown does. The realized-loss-only latch path is unchanged.**
  LATCH (F32/§17-F32, two anti-self-wedge guards — F3/§17-F32b): on the FIRST breach for the trading day, UPSERT bot_daily_kill(mode, kill_date) and return `daily_loss_kill` for the rest of that kill_date REGARDLESS of later MTM recovery. GUARD 1 — bot_should_run computes TWO drawdown sums (F16): the FULL sum (realized + fresh-marked-held + conservative-worst-case fill-ins for unmarked held) drives the SOFT same-tick entry halt; the CONFIRMED sum (realized loss + ONLY fresh-marked-held, conservative fill-ins EXCLUDED) is what must breach to PERSIST the latch. So a transient `/book` outage (held set worst-cased) trips only the soft halt, never the latch; a realized-loss-only breach latches on the first tick its CONFIRMED sum clears the threshold (realized loss is permanent, so it latches the next clean tick regardless). A breach driven solely by conservative marks never latches. GUARD 2 — the read predicate is `daily_loss_kill` IFF `bot_daily_kill.kill_date = current_date in bot.killDayTz`; a row with kill_date < today is ignored + overwritten on the next breach (no separate clearing writer; gating on row EXISTENCE would wedge all future days). Fire one Slack notify on latch. Exits/management never gated.
  Also returns `insufficient_balance` is surfaced by capsHeadroom/openPosition (F38), not here; this RPC's reasons are disabled/daily_loss_kill/circuit_break/over_cap_halt (F4-r10 — dropped `halted`: the global-slack-pause read is removed; the operator kill is `disabled` via bot_enabled=false). `over_cap_halt` (F1/F3 — the CONSUMER of `bot_fill_with_caps`'s `caps_exceeded_held` latch, which routes NOWHERE near the `consecutive_failures` breaker) reports IFF an over-cap holding is still open — `EXISTS bot_positions WHERE mode=p_mode AND over_cap=true AND state IN ('armed','exiting','exit_failed')` — gating ONLY placeEntries while over-cap inventory is held, and AUTO-CLEARING when that position flattens (over_cap reset / state terminalizes), with no separate clearing writer. `circuit_break` reads the PERSISTED `bot_circuit_state` and trips when EITHER `consecutive_failures ≥ bot.maxConsecutiveFailures` OR `consecutive_ambiguous ≥ bot.maxConsecutiveAmbiguous` (F11/F3/§17-F42/F44 — NOT a process-memory counter; the ambiguous dimension catches a CLOB brownout that produces timeouts not rejects). On the trip it SETS `bot_circuit_state.tripped_at = now()` alongside bot_enabled=false + one CRITICAL (F1 — without the setter the reset UX can't distinguish a breaker trip from a plain operator-disable), and it REPORTS reason `circuit_break` (not `disabled`) WHILE `tripped_at IS NOT NULL`. It DOES NOT auto-clear — `setBotEnabled(true)` (operator) atomically zeroes both counters + `tripped_at` to re-enable (F2/§17-F43b).
  Maps to: risk-guard.entryGate (6.9). Writes bot_daily_kill (latch).

bot_loop_lease(p_owner uuid, p_ttl_sec int) RETURNS boolean            [service_role]
  Purpose: CAS single-instance lease — true iff this owner holds/took an expired lease (ADR-OC-8). leaseTtlSec MUST be > max(reconcileWatchdogSec, tickWatchdogSec) + margin (F12/F9-r10 — reconcile.run iterates every open position with live venue round-trips and is UNBOUNDED by tickWatchdogSec; if it exceeds leaseTtlSec the boot lease lapses mid-reconcile and a double-started 2nd instance reconcile-FAKs concurrently, re-opening the lease-less race F4-r9 closed — so reconcile.run ALSO re-CAS's the lease before each position's FAK/redeem and ABORTS on lease_lost) so neither an under-budget tick NOR a long reconcile can lose its lease to a second process mid-run.
  Maps to: risk-guard.acquireLease (6.9).

bot_bump_reviewed() RETURNS jsonb / bot_flatten_position(p_id uuid) RETURNS void   [service_role / operator_guard]
  Purpose: increment realTradesApproved after a first-N live fill is surfaced (post-fill review, W5); operator one-click FLATTEN of any position. **F9/F10: `bot_flatten_position` only MUTATES DB state — CAS 'armed'→'exiting' (for a held position) OR CAS an unfilled 'intent'/'maker_resting' → 'exiting' as well (F10 — so the next-tick `manageBrackets→resumeExit` picks BOTH up; resumeExit's FIRST step cancels the still-resting entry order, then flattens any held residual — the entry-cancel-then-flatten consumer that was previously NAMED here but UNWIRED, since resumeExit historically only flattened held shares) — it does NOT and CANNOT call applyExit (that needs the VPS Signer; ADR-OC-11/§15 grep invariant confine all order placement to bot/signer.ts).** The VPS loop's next-tick `manageBrackets→resumeExit` performs the actual entry-cancel + FAK flatten (the only process holding the Signer) — so the flatten is NEXT-TICK (≤ one tick interval), not "immediate". NO pre-placement approval (W5/ADR-OC-13).
  Maps to: approval.postFillReview (6.8) / bot/actions.flattenPosition (6.11a).

bot_set_enabled(p_enabled boolean) RETURNS void                        [operator_guard]
  Purpose: F2/§17-F43b — the operator enable/disable, the ONLY surfaced breaker-reset path. On p_enabled=true, ATOMICALLY set config bot_enabled='1' AND zero `bot_circuit_state.consecutive_failures`+`consecutive_ambiguous`+`tripped_at` in one write (the human acknowledgment of re-enable) — otherwise a tripped breaker re-trips on the very next tick and the rail is wedged recoverable only by direct SQL. On p_enabled=false, just set bot_enabled='0'. Replaces a bare set_config('bot_enabled',…) for the re-enable path.
  Maps to: bot/actions.setBotEnabled (6.11a).

bot_closed_market_panel(p_mode text, p_days int) RETURNS jsonb         [service_role]
  Purpose: F2-r10 — the FORWARD verdict's panel source (the offline backtest replays `bot_capture_series`; the live loop needs ACTUAL paper fills, which had NO producing RPC). Reads CLOSED/RESOLVED bot_positions for p_mode + aggregates the up-to-3 mode±1 bucket positions per (event/city, target_date) into ONE `OpeningMarketResult` row { city, targetDate, netPnlUsd=Σ realized_pnl_usd, stakeUsd=Σ entry cost, netReturn, executed=any leg filled }, EXCLUDING is_void markets (executed-but-void ≠ a skill outcome). Feeds the loop's openingVerdict — distinct from the backtest's capture replay.
  Maps to: loop.tick (6.7, the forward verdict summary).

bot_record_gate_snapshot(p_snapshot jsonb) RETURNS void                 [service_role]
  Purpose: persist the latest openingVerdict (ADR-OC-10, I-3) — written by the loop summary (STAMPS source='forward' — F2-r10) + the paper backtest (STAMPS source='backtest'); read by dash_bot (source='forward' only).
  Maps to: loop.tick (6.7), opening-paper-backtest (6.13a).

dash_bot() RETURNS jsonb                                                [operator_guard]
  Purpose: the monitoring payload — open positions, recent fills, realized+unrealized PnL net-of-fees, per-market outcomes, today's loss vs the kill, the first-N review queue, and the latest bot_gate_snapshot verdict of **source='forward'** (READ from the snapshot, NOT recomputed — I-5/I-7; F2-r10: the §0/GO-LIVE capital gate reads ONLY the forward verdict, so a Phase-3 backtest PASS can never authorize real money).
  Returns: a jsonb OBJECT (never a top-level array — the 0044 trap).
  Maps to: getBotView (6.11c) → BotPage (6.11).
```

> Note on `openingVerdict` in `dash_bot`: the verdict math (clustered CI + zero-skill MC) is non-trivial SQL.
> Decision (ADR-OC-10): the **canonical** verdict is the TS `openingVerdict` (6.1), computed by the paper
> backtest + the loop summary and **persisted** to a small `bot_gate_snapshot` row (one per run); `dash_bot`
> reads that snapshot rather than re-deriving the MC in plpgsql. This keeps one source of truth for the gate
> and avoids a SQL/TS parity risk.

---

## 9. Data Flow Diagrams

**DF-1 · Capture (keyless, ~every 2–3 min FIRST-SEEN poll — §16-D) — F-OC-01**
```
pg_cron → POST /opening-capture (x-cron-secret)
  → runJob.claim_job_run (idempotent) → 202
  → openingCapture(ctx): fetchOpenEvents (Gamma) → near-dated 'highest' events, RESTRICTED to bot.cities ∧ evVol24h≥minVol24hUsd
     → per event: walk CLOB /book core buckets (executableAsk depth)
                  + seedHouseDist [TS helper, 6.10c] (discover + snapshot forecast now + buildDistributionForEvent → upsert/read) → houseProb (or null)  [C1/C1b/ADR-OC-14]
     → buildOpeningCaptureRow (peakMid, isFlatOpen, tz_name from cities.tz, per-bucket depth + identity-aligned houseProb)
  → record_opening_captures(rows) → opening_captures (append-only)
  Error branch: Gamma/CLOB/seed fails → log non-fatal, houseProb null / smaller panel this tick (never a failed job).
```

**DF-2 · Entry (the bot tick, paper or live) — F-OC-02/03/04**
```
loop.tick → acquireLease (bot_loop_lease)     [ONLY a lost lease aborts the whole tick — W3b-ordering]
  → loadOpenPositions (bot_open_positions) → manageBrackets (DF-3, ALWAYS — also gathers fresh marks)
  → entryGate (bot_should_run incl. fresh open MTM)     [gates ONLY placeEntries; a kill skips new entries, NOT exits]
  → if gate.ok → placeEntries:
       scanEntries(deps, open): bot_latest_captures → selectEntries (city∈allowlist, vol≥floor, flat-open, mode±1, ask<modelProb−margin, ≤0.20; houseProb per-bucket) − dedupe vs open/closed-today
  → per candidate: openPosition
       → bot_open_position (caps headroom + insert intent rows, client_order_id [DB-dedup only])
       → Signer.placeOrder (maker GTC near mid)  [paper: PaperSigner pessimistic fill]
       → bot_record_order_result (→ maker_resting)
       → (live & under first-N) postFillReview AFTER the fill: Slack ACTION + /bot flatten button (W5 — never delays the entry)
  Error branch: placement throws → position 'failed' + CRITICAL Slack; NEVER auto-retry.
```

**DF-3 · Manage + exit (per open position each tick — ALWAYS, never gated by the kill) — F-OC-04/05/08/14**
```
loop.manageBrackets → per open position (returns the fresh marks the entryGate then reads):
  manageFill: Signer.getOrder → matchedShares>0 (FULL or PARTIAL)? bot_fill_with_caps (ATOMIC absolute-$ caps + → armed; blends entry_price; sizes exit to held shares; computes tp/sl/time_stop)   [W4]
              still (partly) resting past makerFillWindow? cancel UNFILLED remainder; keep any filled partial armed
  decideForPosition: fetch mark (CLOB book) → bracketDecision(entry, mark, now, IANA-tz, cfg)
       hold | take_profit (mark ≥ entry+25pp OR ≥ modelProb) | stop_loss (mark ≤ ((entry−12pp>0) ? entry−12pp : entry×(1−slFrac)) — the ternary, NOT max() — F13/F1) | time_stop (now ≥ localHourInstant(tz,date,noon) — DST-correct F11) | cancel_maker_take (maker window elapsed — F14-r10: the 5th BracketAction variant, consumed by manageFill's maker-window cancel, NOT applyExit)
  applyExit (on fire): Signer.placeOrder(SELL, size=held, FAK — NOT FOK) → retry until flat → bot_close_position (realized PnL net-of-fees, → closed)   [W1]
  Error branch: exit can't fully flatten → 'exit_failed' + CRITICAL + aggressive retry (could-not-flatten = loudest).
  Time-stop: bracketDecision fires clock-only (independent of book) — but applyExit still needs the venue at noon, so the backstop is best-effort + loudest-alert, NOT an absolute guarantee (I-9).
```

**DF-4 · Startup reconcile — F-OC-07**
```
opening-bot boot → reconcile.run:
  load bot_positions (open set) + Signer.getHeldShares (F14-r10/F2-r9 — mode-aware per DB position; raw fetchPositions returns 0 for the keyless paper wallet) + Signer.openOrders/fetchPositions (live-only unattributable-holding sweep)
  → per position reconcilePosition: HEURISTIC match by (token,side,price≈,size≈,time-window) + held shares (NO client_order_id on the venue — C3) → bot_repair_position
  → an unmatched venue holding → operator WARNING, never auto-traded
  → only then start the tick interval (never trade before reconcile completes).
```

**DF-5 · Monitoring + control — F-OC-11/12**
```
Operator → /bot (requireOperator) → getBotView → dash_bot → {positions, fills, PnL net, gate verdict (from bot_gate_snapshot), first-N review queue}
Operator flatten (first-N review or any time) → actions.flattenPosition → bot_flatten_position (CAS → 'exiting', DB-only — F9) → next-tick manageBrackets → resumeExit (cancels any still-resting entry FIRST, then FAK-flattens the held residual — F10; the VPS Signer-holder, never the Vercel/SQL path)
Operator kill → actions.setBotEnabled(false) → bot_should_run returns ok:false (reason 'disabled') → next tick halts placement (F4-r10: the bot kill is `bot_enabled`, decoupled from the global `alerts_slack_paused` whale-noise gate)
```

**DF-6 · Paper backtest (offline) — F-OC-10**
```
opening-paper-backtest → read opening_captures (per event: flat-open capture + later mark series)
  → selectEntries → paperFill (maker traded-through? / taker worse-of+slippage) → bracketDecision over the series → per-market net PnL
  → openingVerdict (clustered CI excl 0 + zero-skill MC <5%) → PASS/KILL/INSUFFICIENT → persist bot_gate_snapshot
```

---

## 10. Dependency Map

### 10.1 Internal (module → module)
```
loop.tick ─┬─ risk-guard.acquireLease ── (RPC) bot_loop_lease ; risk-guard.entryGate ── (RPC) bot_should_run (incl. open MTM)
           ├─ loadOpenPositions ── (RPC) bot_open_positions
           ├─ placeEntries ── entry-scanner.scanEntries ── (RPC) bot_latest_captures ── core: selectEntries (→isFlatOpen)
           │                  └─ position-manager.openPosition ─┬─ risk-guard.capsHeadroom ── (RPC) bot_exposure
           │                                                    ├─ Signer.placeOrder
           │                                                    ├─ (RPC) bot_open_position, bot_record_order_result
           │                                                    └─ approval.postFillReview (live first-N) ── (RPC) bot_bump_reviewed ── notifySlack
           ├─ manageBrackets ─┬─ position-manager.resolveHeldPosition (RESOLUTION-FIRST, F6b) ── Signer.redeem(negRisk) ── (RPC) bot_resolve_position
           │                  ├─ position-manager.resumeExit (exiting/exit_failed, §17-F43) ── Signer.placeOrder(FAK) ── (RPC) bot_close_position
           │                  ├─ position-manager.manageFill ── Signer.getOrder/cancelOrder/placeOrder ── (RPC) bot_fill_with_caps ── core: paperFill (paper)
           │                  ├─ bracket-engine.decideForPosition ── core: executableBid (NEW) + bracketDecision ── core: localHourInstant (NEW)
           │                  └─ position-manager.applyExit ── Signer.placeOrder(FAK) ── (RPC) bot_close_position ── notifySlack (reuse)
           └─ (RPC) bot_record_gate_snapshot ── core: openingVerdict ; (RPC) bot_record_tick (F19 liveness)
reconcile.run [UNDER the lease — F4-r9] ── position-manager.reconcilePosition ── Signer.getHeldShares (F2-r9 mode-aware) + Signer.openOrders/fetchPositions (live-only unattributable sweep) ── (RPC) bot_repair_position / bot_fill_with_caps (ENTRY-ADOPT) / bot_close_position ── resumeExit + resolveHeldPosition (F4/F13) ── notifySlack
opening-bot.ts ── makeBotDb, createPaperSigner|createNodeClobSigner, reconcile.run, loop.tick
opening-capture.handler ── core: parseGammaEvent, normalizeBook, executableAsk (reuse) ── pure.buildOpeningCaptureRow(→isFlatOpen) ── seedHouseDist[TS,6.10c] (reuse buildDistributionForEvent + snapshot-forecasts; RPCs upsert_forecast_rows/upsert_distribution/latest_house_dist) ── (RPC) record_opening_captures
BotPage ── getBotView ── (RPC) dash_bot ── (reuse) serverDb, requireOperator ; actions.flattenPosition/setBotEnabled ── (RPC) bot_flatten_position
core/sim/opening-convergence: selectEntries→isFlatOpen; openingVerdict→zeroSkillPassRate; bracketDecision→localHourInstant(NEW core/time.ts, F11); decideForPosition→executableBid(NEW core/edge.ts, F1)
```

### 10.2 External (packages / services)
- `@weather-edge/core` — `parseGammaEvent`, `normalizeBook`, `executableAsk` + `executableBid` (NEW, core/edge.ts, F1),
  `takerFeePerShare`, `localDayWindow` + `localHourInstant` (NEW, core/time.ts, F11), errors; the new `sim/opening-convergence`.
- `@weather-edge/io` — `fetchJson`, `fetchPositions`/`parseTrades` (reconcile), `slackPost`.
- `@weather-edge/trading` — **types only** (`FillResult`, `TradeAlert`, `ApprovedBet` shape) + the never-retry
  discipline; not its Deno executors.
- **`@polymarket/clob-client-v2@1.0.6` + `viem`** — Node, **only** in `bot/signer.ts` (CLOB V2, §16-A; NOT the V1 `clob-client@4`+ethers that `live.ts` uses).
- `@supabase/supabase-js@2` — Node service client in `bot/db.ts`; Deno (`npm:`) in the edge fn.
- Supabase Postgres + pg_cron; Slack webhook; Vercel (the page).

---

## 11. Cross-Cutting Concerns

### 11.1 Error Taxonomy
Reuse `packages/core/errors.ts` (`AppError` base; `ConfigError`, `AuthError`, `ClobShapeError`,
`GammaShapeError`, `ExecutionError`, `FillRejected`). New bot-specific cases reuse these:

```
ExecutionError('ERR_NO_KEY')        — signer: POLY_PRIVATE_KEY missing (never echoes the key)
ExecutionError('ERR_CLOB_POST')     — placement returned no orderID
ExecutionError('ERR_EXIT_FAILED')   — could-not-flatten a position (the worst case; CRITICAL)
ExecutionError('ERR_INSUFFICIENT_BALANCE') — placeOrder rejected for insufficient free pUSD (wallet fully deployed) — TRANSIENT/non-systemic: logged as skip:wallet_deployed, does NOT increment the §17-F18 breaker (F38/§17-F38; mirrors ERR_RATE_LIMITED)
ExecutionError('ERR_RATE_LIMITED')  — 429/throttle on the cancel→repost loop — RETRYABLE (backoff+jitter); does NOT count toward the §17-F18 breaker (§17-F17b)
FillRejected('caps', …)             — bot_fill_with_caps breached a cap at fill time (CAS-safe, not a throw upstream)
FillRejected('bad_state', …)        — CAS expected-state mismatch (a concurrent tick already acted) → no-op, not an error
ConfigError                         — missing SUPABASE_*/config; fail loud
'skip:<reason>'                     — a non-error candidate skip (no_house_dist, no_tz, peak_too_high, ask_above_cap, wallet_deployed) → logged, never alerted
```
Severity → Slack: `CRITICAL` for execution/exit/job failures (paged); `ACTION` for first-N approval requests;
`WARN` for a degraded capture tick; `INFO` for a state summary. A bracket `time_stop` that could NOT flatten
is the loudest alert in the system.

**Slack alert KINDS + the global-pause interaction (F4-r8, CRITICAL).** `notifySlack` delegates to `claim_alert`
(0055), which SUPPRESSES alerts **BY KIND** when `alerts_slack_paused='true'` — every kind NOT in
`alerts_slack_allow_kinds` is dropped AND not recorded for resend (the 0055 migration's own warning: it "silences
CRITICAL job-failure alerts too"). Prod is CURRENTLY paused with the allowlist = `WHALE_TRADE` only, so the bot's
load-bearing safety alarms would be SILENTLY muted on live-prod config — including the two deadmen (whose entire
purpose is to page when the loop/capture is dead, the only catch for a silently-stalled Phase-5 clock). The bot
defines its own CRITICAL kinds — `BOT_DEADMAN`, `CAPTURE_DEADMAN`, `EXIT_FAILED`, `CIRCUIT_BREAK`, `POL_LOW`,
`DAILY_KILL` — and **migration 0066 idempotently APPENDS them to `alerts_slack_allow_kinds`** (a guarded `LIKE`
so a re-run doesn't double-append; NOT a blanket severity bypass, which would re-introduce the noise the operator
deliberately paused). §15 + GO-LIVE gate a test CRITICAL of each firing while `alerts_slack_paused='true'` BEFORE
the Phase-5 paper deadman is relied on.

### 11.2 Environment & Configuration

| Variable | Required | Where | Description |
|---|---|---|---|
| `POLY_PRIVATE_KEY` | live only | VPS `.env.local` | signer key — **only** read in `bot/signer.ts`; never logged/committed (ADR-OC-11) |
| `POLY_SIGNATURE_TYPE` | no | VPS | 0/1/2 sig type (mirrors live.ts) |
| `POLY_FUNDER_ADDRESS` | no | VPS | proxy/funder address (mirrors live.ts) |
| `SUPABASE_URL` | yes | VPS + edge | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | VPS + edge | service role (writers) |
| `CRON_SECRET` | yes | edge + Vault | `x-cron-secret` (capture cron) |
| `SLACK_WEBHOOK_URL` | yes | edge + VPS | alerts (reuse) |
| `OPERATOR_EMAIL` | yes | Vercel | the `/bot` auth gate (reuse) |
| config table | — | DB | `bot_enabled`, `tradingMode`, all `bot.*` tunables (§7) |

The guard-secrets hook protects `.env.local`. Paper mode needs **no** `POLY_*` secret at all (PaperSigner).
**Ops (F21/§17-F21):** the always-on VPS MUST run NTP (systemd-timesyncd/chrony) — the local-noon time-stop
depends on accurate wall-clock (the GTD +60s buffer is moot — the entry-side GTD time-stop is out of scope,
F17/§17-F17c); a startup + periodic clock-sanity check (local `now()` vs
Supabase `now()` via the db port (the CLOB SDK exposes no server-time endpoint, F17-r8) halts PLACEMENT (not exits) on excess drift AND fires a CRITICAL Slack so the operator re-syncs NTP — the clock-only local-noon time-stop is itself an EXIT, so it keeps running best-effort on the (NTP-bounded sub-second) drift rather than freezing; placement-halt guards against opening new risk on a bad clock, NOT the time-stop itself, which is best-effort under drift (F12). **Secrets (F30/§17-F30):**
`GO-LIVE-CHECKLIST-OPENING.md` must carry a rotation + incident runbook — a leaked `POLY_PRIVATE_KEY` over a
funded wallet requires an immediate fund-DRAIN to a cold address, not just credential re-issue.

### 11.3 Naming Conventions
Follow the codebase: files `kebab-case.ts`; functions `camelCase` verb-first; DB tables/columns `snake_case`
plural tables; RPCs `bot_*` (writers) / `dash_bot` (reader) / `record_*` (bulk insert); migrations
`NNNN_snake_case.sql`; types `PascalCase` no `I` prefix; config keys `bot.<area><Camel>`; jsonb row fields
**camelCase** (the recorder RPC maps camelCase→snake_case, mirroring `record_cross_venue_captures`).

---

## 12. Extensibility Guide

- **A new city / wider universe:** add it to the capture's overlap/eligibility filter; no schema change
  (the capture is event-driven). The §9R "6–10 liquid cities first" is a config list (`bot.cities`).
- **A different forecast champion** (`house_ensemble`): the capture's `seedHouseDist` (6.10c) reads
  `championSource` from config when seeding/reading the dist; `selectEntries` is source-agnostic (it reads
  whatever `houseProb` the capture aligned).
- **A maker-exit variant** (the §9R alternative we did NOT pick): add a `BracketAction` variant
  `maker_exit_then_taker`; `applyExit` already branches on action kind — one new arm, no manager rewrite.
- **A new bracket rule** (e.g. trailing stop): extend the pure `bracketDecision` + its config; the engine/manager
  are unchanged (they apply whatever action the pure fn returns) — the "add a feature without touching existing
  code" seam is `BracketAction`.
- **Scaling to a second strategy** (some future signal): the `Signer` port + `bot_positions`/`bot_orders`
  ledger + caps RPC are strategy-agnostic; a new scanner emitting `EntryCandidate`s reuses the whole execution
  spine.

---

## 13. Risk Register

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-1 | A bug double-places / over-spends | Med | High | Intent ledger + UNIQUE client_order_id (DB dedup) + never-auto-retry + tight place→record + atomic `bot_fill_with_caps` + caps + daily-loss kill (ADR-OC-5/8); + partial-unique `(event_id,bucket_idx)` (W2) |
| **R-13** | **The forecast signal (`house_gaussian`) isn't available while the market is still flat-open** | **High (verified C1)** | **High (kills the thesis)** | **Capture seeds the dist on-demand for the scoped universe; Phase 0.5 is a hard go/no-go spike BEFORE any execution is built (ADR-OC-14)** |
| R-2 | The edge is a flat-open-depth mirage | High (unproven) | Med (paper only) | Paper-first; the capture IS the forward depth measurement; F-OC-10 gate blocks capital (ADR-OC-9/10) |
| R-3 | Adverse selection on the maker entry/exit (§12) | Med | Med | Maker window → taker fallback; paper maker-fill only on traded-through; **relative SL (the −12pp absolute is inert below entry 0.12 — F13/§17-F13)**; rebate MEASURED not assumed (ADR-OC-6/7/10, I-10) |
| R-4 | Could-not-flatten before resolution (loser→0) | Low | High | Clock-only time-stop decision + `FAK` (not FOK — W1) + aggressive retry + `exit_failed` CRITICAL. Best-effort backstop, NOT an absolute guarantee given venue uptime (I-9) (ADR-OC-7) |
| R-5 | Two loop instances OR overlapping in-process ticks race | Low | High | `bot_loop_lease` CAS singleton + invariant `leaseTtlSec > tickWatchdogSec + margin` (F12); self-chaining `setTimeout`. Double-EXECUTION is prevented at the **DB layer** (CAS transitions, partial-unique open constraint, UNIQUE client_order_id, atomic `bot_fill_with_caps`), NOT by JS timing — a fired watchdog may leave an in-flight call running (F12/§17-F12) (ADR-OC-8, W2) |
| R-6 | VPS restart mid-position orphans state | Med | Med | DB is source of truth; HEURISTIC reconcile-from-DB+venue before the first tick (no venue client-order-id — C3) (ADR-OC-4, F-OC-07) |
| R-7 | Station-local / DST time-stop error | Med | High | All time math via `localHourInstant(IANA-name, date, noon)` (the time-stop instant — F5-r8/F11, NOT `localDayWindow.startUtc+12h`) read from `cities.tz` (NOT an offset — C2); no-tz ⇒ not entered (ADR-OC-12, C-6) |
| R-8 | Key leakage | Low | Critical | Single-reader signer; §15 grep invariant; guard-secrets; paper needs no key (ADR-OC-11); **+ a rotation/incident runbook — leaked key over a funded wallet ⇒ instant halt + DRAIN to cold (F30/§17-F30)** |
| R-9 | Gamma/CLOB shape drift breaks the parser | Low | Med | Reuse the fixture-verified `parseGammaEvent`/`normalizeBook` (throw → ClobShapeError alert, never a guess) |
| R-10 | Open unrealized losses don't trip the daily kill / the kill UN-trips intraday | Med | Med | `bot_should_run` includes open-position MTM (held-only, entry_shares>0 — F37), each contribution floored at 0 so a winner can't mask realized losses, and the breach is LATCHED for the trading day in `bot_daily_kill` so MTM recovery can't un-trip it (W3, F32, ADR-OC-8) |
| R-11 | Net-profit gate passes on noise | Med | Med | City-clustered CI excl 0 + zero-skill MC <5% (ADR-OC-10) — stricter than `crossVenueVerdict` (I-7) |
| R-14 | Bucket desync (ladder change) → buy the wrong bucket | Low | High | Align `houseProb` to buckets BY LABEL/RANGE IDENTITY at capture, not positional `probs[i]` (W6) |
| R-15 | Flat-open edge converges away during operator approval | Med | High | First-N is POST-fill review (not pre-placement); the entry is never delayed for a click (W5, ADR-OC-13) |
| R-12 | Slack/alert outage hides a problem | Low | Med | `slackPost` never throws; `/bot` is the independent eyeball; the kill is a DB flag, not Slack-dependent |
| R-16 | Held position rides into market resolution (winnings stranded / loser stuck / void mis-booked) | Low | High | `resolveHeldPosition` + `bot_resolve_position` book ACTUAL terminal value (WIN/LOSS/VOID — F36, not forced $1/$0) + redeem the winner via the negRisk-correct path (NegRiskAdapter for weather, F14c — plain CTF redeem reverts on a negRisk position); `'resolved'` state; voids excluded from the gate (F4/F36/§17-F4) |
| R-20 | The capture pipeline silently dies → bot scans empty, never trades, Phase-5 clock stalls with no alarm | Med | High (stalls the experiment) | `capture_deadman_check` pg_cron: staleness on `max(opening_captures.captured_at)` + a seeded-fraction-collapse alert (both Gamma-fetch and seed failures are non-fatal/silent — F35/§17-F35) |
| R-17 | The loop churns into a broken venue — definitive rejects (auth/malformed/clock) OR timeouts (CLOB down/unreachable, the common mode) | Med | Med (operational) | Two-dimension circuit breaker on PERSISTED `bot_circuit_state` — `consecutive_failures` (rejects) AND `consecutive_ambiguous` (timeouts/brownout, F3) → `bot_enabled=false` + CRITICAL; periodic reconcile adopts phantom brownout fills; operator-reset via `bot_set_enabled(true)` clears it (F2/F3/F18/§17-F18/F42/F44) |
| R-18 | The VPS loop dies silently while holding positions (no self-alert) | Low | High | `bot_tick_log` per-tick liveness + an EXTERNAL `bot_deadman_check` pg_cron Slack-page (survives the process being dead) (F19/§17-F19) |
| R-19 | Net-profit gate false-PASSes on few-cluster CI under-coverage | Med | High (money gate) | Wild-cluster bootstrap / cluster-preserving MC for C<~15; reason-string caveat (F28/§17-F28) |

---

## 14. Implementation Roadmap

Each phase is independently testable; no phase leaves the system broken. Paper has zero key/zero money
through Phase 5.

**Phase 0 — Capture (keyless) + on-demand seed + schema.** Build migration `0066` (the 9 tables incl. `bot_circuit_state` (F11/F42) +
`record_opening_captures` + `latest_house_dist` + the reused upsert RPCs + grants + **the bot CRITICAL-kinds Slack-allowlist append, F4-r8**), the `opening-capture` edge fn (with the TS `seedHouseDist` helper incl. the F15 seed-QUALITY gate, clone
`cross-venue-capture`, restricted to `bot.cities` + the vol floor, with the on-demand seed that ALSO upserts the walked ladder into market_buckets — F9, §17), its capture cron, AND the `capture_deadman_check` pg_cron (F35 — capture-staleness + seeded-fraction-collapse Slack-CRITICAL; the producer-side deadman, since the bot scans empty and the Phase-5 clock stalls silently if capture dies), AND the `bot_deadman_check` pg_cron (F19/F13 — MODE-AWARE: it reads the `tradingMode`-active partition so the Phase-5 PAPER loop's liveness is alarmed, not just live; **BOTH deadmen are migration-0066 Phase-0 objects, NOT Phase-6 — F5: they must be active for the ≥2-week/≥40-market Phase-5 forward run, which runs before Phase 6**).
*DoD (amended, ADR-OC-14):* `opening_captures` accrues real rows on prod on a **~2–3 min first-seen poll (§16-D)** **AND a non-trivial
fraction of flat-open captures carry a seeded `houseProb` (not null)** — merely "rows accrue" is NOT enough;
PGlite test green; no key, no positions. **Also (C2b): correct the §9R liquid cities' `cities.tz` to real
DST-aware IANA names** (they default to no-DST `Etc/GMT±N`), wire the `Etc/*`-rejection in the tz read, **and
surface Gamma `createdAt`** through `parseGammaEvent`/`ParsedEvent` (or read it off the raw payload) so
`hours_since_listing` anchors on true listing time (the listing-anchor fix).

**Phase 0.5 — SIGNAL-AVAILABILITY GO/NO-GO SPIKE (gates everything; C1/R-13).** Over ≥1 week of real Phase-0
captures, measure: when a usable `house_gaussian` first exists for a market, **is the book still flat-open
(peak ≤ 18%) and is there cheap center depth?** *DoD:* the **`scripts/research/opening-spike.ts` artifact (§6.13c, F11-r8)** emits a one-page verdict + a numeric GO fraction. **GO iff ≥ `bot.spikeGoFrac` (e.g. 0.5) of ≥1-week events are still-flat-open with cheap center depth at first house_gaussian; else KILL the lever
here, cheaply, before Phases 2–6** (update `FINDINGS.md`); if GO → proceed. This is the cheapest possible
falsification of the thesis. Depends on: 0 (+ partial Phase 1 for `isFlatOpen`).

**Phase 1 — Pure decision core.** `core/sim/opening-convergence.ts` (isFlatOpen, selectEntries,
bracketDecision, paperFill, openingVerdict, zeroSkillPassRate) + full unit tests (mirror
`cross-venue-arb.test.ts`). *DoD:* `pnpm test` green; a zero-skill MC test (<5% of 1000 trials pass); a
station-local time-stop test (Sydney/US-west DST skew, IANA names); a bucket-identity-alignment test (W6).
Depends on: nothing (pure). Can run ∥ Phase 0.

**Phase 2 — Paper executor + position ledger + the loop (paper). GATED on Phase 0.5 = GO.** `packages/bot`:
types, `db.ts`, `PaperSigner`, position-manager (incl. partial-fill path — W4), bracket-engine, entry-scanner,
risk-guard (MTM kill — W3), approval (post-fill review — W5), loop (self-chaining tick — W2), reconcile +
`bot_*` lifecycle/caps RPCs (paper path) in `0066`. *DoD:* `opening-bot --mode paper --once` opens → fills
(pessimistic, incl. a partial) → arms → exits end-to-end against captured data; PGlite twin exercises every
RPC; caps + MTM-kill + lease + partial-unique + CAS tested. Depends on: 0, 0.5 (GO), 1.

**Phase 3 — Paper backtest + the gate.** `opening-paper-backtest.ts` + `bot_gate_snapshot` persistence.
*DoD:* replays `opening_captures` → per-market net P&L → `openingVerdict`; prints PASS/KILL/INSUFFICIENT.
Depends on: 0, 1, 2.

**Phase 4 — Dashboard.** `/bot` page + `getBotView` + `dash_bot` + actions (flatten/kill) + `PositionTable`.
*DoD:* renders positions/fills/PnL/verdict logged-in on prod; flatten + kill actions work. Depends on: 2, 3.

**Phase 5 — Forward paper run.** Operator runs `opening-bot --mode paper` on the VPS continuously; watch
`/bot`. *DoD:* ≥2 weeks AND ≥40 closed paper markets accrued; the gate renders a real verdict (§9R-E). Depends
on: 0–4. **No code — the experiment runs.**

**Phase 6 — Live signer + the live path (GATED on Phase 5 PASS).** Add the **`@polymarket/clob-client-v2@1.0.6`
+ `viem`** Node deps (§16-A — CLOB V2, NOT the V1 `clob-client@4`; the SDK surface — post_only GTC, FAK, GTD
+60s buffer, getOpenOrders, pUSD `updateBalanceAllowance` — is already verified in
`research/REPORT-clob-bracket-execution.md` §9); build `createNodeClobSigner` + the live manager branch + the
first-N post-fill review + the resolution/redeem path (F4 — with the negRisk-correct redeem via the
NegRiskAdapter for weather, F14c) + `Signer.getCollateralBalance`→`bot_bankroll` (F14)
+ `GO-LIVE-CHECKLIST-OPENING.md` (incl. the F30 rotation/incident
runbook + the F21 NTP requirement + the F39 deposit/onboarding + profit-sweep procedures + the F22 supervisor). **A one-time
GAS-FUNDED ON-CHAIN APPROVAL BOOTSTRAP gated BEFORE `tradingMode=live` (F33/§17-F33):** pUSD ERC20 `approve` to the two trade-time Exchanges +
CTF `setApprovalForAll` to all THREE (F16-r8 — the NegRiskAdapter is redeem-only: setApprovalForAll yes, pUSD approve no) — the V2 CTF Exchange, the NegRisk Exchange, AND the **NegRiskAdapter** (the distinct redeem contract, pinned from `getContractConfig(137).negRiskAdapter` — F8: approving only the two Exchanges leaves the first live winning redeem reverting = R-16 stranding), via viem, idempotent (skip if
already max) — `updateBalanceAllowance` is only a server-side cache refresh ON TOP of these on-chain txns, not a
replacement (F33; the first live SELL exercises the CONDITIONAL allowance — the R-4 path — so it must be set
before, not discovered at, the first time-stop flatten). Fold the approval + redeem POL gas into the §17-F14b
buffer. **Before first-N: a zero-cost live-signer SMOKE TEST (F17/§17-F17)** — createOrDeriveApiKey +
getOpenOrders round-trip, an `updateBalanceAllowance` dry call for COLLATERAL **and** CONDITIONAL, and a 1-share
post_only GTC (≥ max(5 shares, $1 notional) — the venue floor, F12-r10; a 1-share order can't rest) placed far from market **with no websocket session, left resting >2 min, confirmed still `live`
via getOpenOrders (proves order-survival-without-session — closes F2/§16-F), THEN cancelled** — gate
`tradingMode=live` on it passing. *DoD:* operator
funds the dedicated wallet, sets `tradingMode=live` + `bot_enabled=true`; the smoke test passes; the first ~10
fills are placed within caps + surfaced for post-fill review with a working flatten **AND each logs paper-predicted
vs realized fill (F31 calibration)**; heuristic reconcile + the resolution path verified against the live venue;
a kill halts placement within one tick (exits keep running). Depends on: 5 PASS.

**Phase 7 — Scale or kill.** Raise caps only if live-realized net edge holds ≥2 weeks AND **tracks the paper
model within tolerance (F31 — not merely aggregate +EV)**; else KILL → rail DORMANT + update `FINDINGS.md`.
Depends on: 6.

Parallelizable: Phase 1 ∥ Phase 0; Phase 4 ∥ Phase 3. **Hard gates: Phase 0.5 (signal availability) blocks
Phases 2–6; Phase 5 PASS blocks Phase 6.**

---

## 15. Build Verification Checklist

### Phase 0.5 — signal-availability spike (C1/R-13, gates Phases 2–6)
- [ ] Over ≥1wk of real captures: when a usable `house_gaussian` first exists, is the book still flat-open (peak≤18%) with cheap center depth? → GO/NO-GO verdict; NO-GO ⇒ KILL the lever here

### Module: core/sim/opening-convergence (6.1)
- [ ] `isFlatOpen` — peak ≤ 0.18 ∧ ≤~1h gate (§16-D, listingMaxHours≈1, NOT 6h); reasons[] on every failure; total on junk
- [ ] `selectEntries` — city∈allowlist ∧ vol≥floor (I-13); mode±1; ask ≤ min(0.20, modelProb−margin); depth floor; per-bucket `houseProb` (identity-aligned, W6); skip `no_house_prob`
- [ ] `bracketDecision` — TP (entry+25pp OR ≥modelProb) / SL (−12pp) / time_stop (station-local noon via IANA name) / cancel_maker_take
- [ ] `bracketDecision` — station-local time-stop verified for an APAC and a US-west city with DST IANA names (C-6 / R-7); a non-IANA tz ⇒ caught + conservative time_stop
- [ ] `paperFill` — maker fills only on traded-through; taker worse-of+slippage; null on stale+gone (ADR-OC-6)
- [ ] `openingVerdict` — INSUFFICIENT < minMarkets/minCities/minDistinctDays; PASS needs winFrac ∧ ciLow>0 (city-clustered, N=#cities) ∧ MC<5%; else KILL; maker rebate is a MEASURED input (I-10)
- [ ] `zeroSkillPassRate` — deterministic (index-seeded, no Math.random); <2 cities ⇒ 1
- [ ] No import of `packages/trading` or any I/O (pure, total) — grep invariant

### Module: bot/signer (6.3)
- [ ] `createNodeClobSigner` — reads POLY_PRIVATE_KEY; ERR_NO_KEY without echoing the key
- [ ] `createPaperSigner` — needs no key; routes to paperFill; no order ever sent
- [ ] **GREP INVARIANT:** `POLY_PRIVATE_KEY` and `@polymarket/clob-client-v2` appear in NO file but signer.ts (ADR-OC-11 / R-8)

### Module: bot/position-manager (6.6)
- [ ] `openPosition` — intent rows + client_order_id (DB-dedup only, C3) BEFORE placement; never auto-retries; failed→CRITICAL; live first-N → postFillReview AFTER the fill (W5)
- [ ] `manageFill` — multi-tick PARTIAL fills ACCUMULATE idempotently (pass cumulative size_matched; CAS maker_resting|armed→armed; re-getOrder after cancel for the TOCTOU terminal count — W4/W4b); fill recorded only through `bot_fill_with_caps`
- [ ] `applyExit` — `FAK` exit (NOT FOK — W1); retry until flat; bot_close_position records net-of-fee realized PnL; can't-flatten → exit_failed CRITICAL (R-4); a sub-`minOrderSizeShares` residual routes to resolveHeldPosition as `dust_residual` (NOT exit_failed/CRITICAL — F34); CONDITIONAL approval ensured at arm time, not in the exit (F33)
- [ ] `resolveHeldPosition` — THREE settlement branches WIN/LOSS/VOID (F36 — actual settled value, not forced $1/$0); negRisk redeem via NegRiskAdapter for weather (F14c); voids EXCLUDED from the gate panel; a sub-min `dust_residual` books terminal value here
- [ ] `reconcilePosition` — HEURISTIC match (token,side,price≈,size≈,window) + held shares (NO venue client_order_id — C3); unmatched holding → operator WARNING (R-6)
- [ ] every state change is a CAS (UPDATE … WHERE state = expected) — a concurrent tick is a no-op, not a double-act (R-5)

### Module: bot/loop + risk-guard + approval (6.7/6.9/6.8)
- [ ] `tick` ORDER (Pass-3 W3b-ordering): lease (only whole-tick abort) → manageBrackets ALWAYS (exits never frozen) → entryGate → place. A daily-loss kill / `bot_enabled`=false skips NEW entries only, never exits; verify a reboot-while-holding does NOT self-wedge (marks bootstrap; flatten proceeds)
- [ ] loop uses self-chaining `setTimeout` (await tick → schedule next) + a per-tick wall-clock watchdog — NO in-process overlap, no hung-tick freeze (W2/W2b)
- [ ] one position's error never halts the tick (caught + alerted)
- [ ] `acquireLease` (only whole-tick abort) + `entryGate` (bot_enabled + slack-pause + (realized + open MTM from the loop's FRESH per-position marks, max-age→conservative — W3/W3b) loss vs killLossUsd/killLossPct) — split per Pass-3; entryGate gates only placeEntries
- [ ] daily-loss kill is LATCHED for the trading day in `bot_daily_kill` (no intraday un-trip), MTM scoped to held positions (entry_shares>0 — unfilled intent/maker_resting contribute 0), each unrealized contribution floored at `max(0, cost−mark)` so a winner can't mask realized losses; day boundary = `bot.killDayTz` (F32/F37)
- [ ] `capsHeadroom`/`bot_open_position` — a BUY is gated on `free_pusd ≥ cost+fee+freeCashReserveUsd` (distinct from the equity exposure cap); an insufficient-balance rejection is `skip:wallet_deployed`, NOT a breaker-tripping failure (F38)
- [ ] `approval.postFillReview` — paper ⇒ no-op; live under firstN ⇒ Slack ACTION + /bot flatten AFTER the fill; ≤1 unreviewed live position at a time (W5b); never a pre-placement gate (W5)

### Module: opening-capture (6.10) — keyless
- [ ] enumerates Gamma tag 104596, near-dated 'highest', RESTRICTED to bot.cities ∧ vol floor; parse failures skipped (mirror cross-venue-capture)
- [ ] walks TRUE CLOB /book depth per core bucket (not the vol proxy); book-fetch failure ⇒ depth 0
- [ ] seeds house_gaussian on-demand via the TS `seedHouseDist` helper (6.10c — NOT a plpgsql RPC, C1b; reuses buildDistributionForEvent + snapshot-forecasts logic); houseProb aligned by market_buckets-label identity (W6/W6b), null if unseeded; tz_name from cities.tz rejecting Etc/* (C2/C2b); hours_since_listing anchored on Gamma createdAt; writes via record_opening_captures
- [ ] SEED-QUALITY gate (F15): min contributing models + dispersion/mode-confidence bound + model_stats calibration coverage; any failure ⇒ houseProb=null (capture depth, don't enter) — existence alone is not enterable
- [ ] best-effort: a venue/seed outage shrinks the panel / null houseProb, never fails the job; no key, no packages/trading
- [ ] `capture_deadman_check` pg_cron (F35): Slack-CRITICAL on capture staleness (max captured_at) OR seeded-fraction collapse — guards against silent producer death stalling the Phase-5 clock

### API / RPCs (§8)
- [ ] `POST /opening-capture` — 202 accept / 409 already-ran / 401 bad-secret (runJob, reuse)
- [ ] `record_opening_captures(jsonb)` — service_role only; camelCase→column mapping (mirror 0062 §3)
- [ ] `seedHouseDist` (TS helper, 6.10c — C1b: NOT plpgsql) — discover-upsert + single-station OM snapshot + buildDistributionForEvent + `latest_house_dist` read (joined to market_buckets for labels); {seeded:false} when station unmapped; `seedFreshnessMin` skips re-snapshotting
- [ ] `bot_fill_with_caps` — TRANSACTION-scoped pg_advisory_xact_lock (pool-safe); absolute-$ caps; IDEMPOTENT ACCUMULATE on cumulative size_matched; CAS maker_resting|armed→armed (W4b); mirrors fill_bet_with_caps
- [ ] `bot_should_run(p_open_marks)` (caller-supplied fresh marks, W3b) / `bot_loop_lease` — kill gate + singleton lease; daily-loss kill LATCHES via `bot_daily_kill` (no intraday un-trip — F32), MTM held-only + floored at 0 (F37)
- [ ] `bot_open_positions` / `bot_exposure` / `bot_record_gate_snapshot` / `bot_capture_series` (backtest series read) / `latest_house_dist` defined and consumed
- [ ] `bot_open_position` (free-cash spend ceiling + insufficient_balance skip — F38) / `bot_record_order_result` / `bot_record_ambiguous` (brownout breaker dimension, wired into openPosition's F40 branch, reset on success — F44) / `bot_close_position` (SUM-derives exit_taker + corroborated venue-flat — F47/F7) / `bot_repair_position` — CAS / DB-idempotent
- [ ] `bot_resolve_position` — books ACTUAL terminal value, WIN/LOSS/VOID branches (F36, not forced $1/$0), voids flagged for gate exclusion
- [ ] `capture_deadman_check` (F35) pg_cron defined + wired to notifySlack (producer-side staleness + seeded-fraction collapse)
- [ ] bot CRITICAL alert KINDS (BOT_DEADMAN/CAPTURE_DEADMAN/EXIT_FAILED/CIRCUIT_BREAK/POL_LOW/DAILY_KILL) appended to `alerts_slack_allow_kinds` by 0066 so they survive the global Slack pause; a test CRITICAL of each fires while `alerts_slack_paused='true'` (F4-r8)
- [ ] `bot_bump_reviewed` / `bot_flatten_position` (post-fill review; operator flatten) — NO pre-placement approval RPC (W5)
- [ ] `dash_bot()` — operator_guard; returns a jsonb OBJECT (not a top-level array — the 0044 trap); READS bot_gate_snapshot for the verdict (I-5/I-7)
- [ ] grants: writers service_role only; dash_bot authenticated+operator_guard; `record_*` service_role (0034 contract)

### Data Models (§7) — 9 tables (bot_tick_log F19, bot_bankroll F14, bot_circuit_state F11 defined in §17; bot_daily_kill F32 defined in §7)
- [ ] `opening_captures` — append-only; `tz_name` real-IANA (Etc/* rejected — C2/C2b); `created_at_gamma` (Gamma `createdAt` SURFACED through parseGammaEvent/ParsedEvent — Phase-0 task) anchors `hours_since_listing` (listing-anchor fix); `house_seeded`; houseProb identity-aligned (W6); indexes (event,captured), (flat_open), (city,date)
- [ ] `bot_positions` — state CHECK enum incl. 'resolved' (F4) + 'rejected' (F29), NO pending_approval; time_stop_at = localHourInstant(IANA tz,date,noon) DST-correct (F11); open-set excludes 'resolved'; (mode,state,updated_at) daily-loss + **partial-UNIQUE(event_id,bucket_idx) on open states** (W2/I-12) indexes
- [ ] `bot_tick_log` (F19) + `bot_bankroll` (F14, incl. `pol_balance` F10) + `bot_circuit_state` (F11) defined (§17); `bot_daily_kill` (F32) defined (§7); `bot_positions.neg_risk` (F2/F5) + **`condition_id` + `token_yes` NOT-NULL persisted from EntryCandidate for the redeem/resolve key (F2-r8)** + `bot_orders.status` incl. 'rejected'/'failed' (F29/F40)
- [ ] §17 design gaps wired: resolveHeldPosition+bot_resolve_position (F4); seedHouseDist upserts market_buckets (F9); bot_fill_with_caps SUMS across orders (F10); localHourInstant DST helper + transition-day test (F11); leaseTtlSec>tickWatchdogSec invariant + DB-layer overlap guard (F12); relative SL (F13); getCollateralBalance→bot_bankroll (F14); **POL gas for redeem (F14b); negRisk-correct redeem via NegRiskAdapter (F14c)**; **seed QUALITY gate → houseProb null (F15)**; seed burst cap (F16); live-signer smoke test incl. resting-order-survival check (F17/§16-F); **rate-limit/429 retryable, not breaker (F17b)**; consecutive-failure breaker (F18); bot_tick_log+deadman cron (F19); 'exiting' reconcile arm (F20); NTP+clock-sanity (F21); **structured logger + supervisor/reconcile-on-boot (F22)**; few-cluster CI (F28); post_only cross-reject→'rejected'+taker fallback (F29); rotation/incident runbook (F30); paper↔live calibration (F31); **LATCHED daily-loss kill + bot_daily_kill + floor-at-0 (F32); on-chain approval bootstrap before live (F33); exit dust floor → resolveHeldPosition (F34); capture_deadman_check (F35); void/refund settlement branch + gate exclusion (F36); MTM scoped to held positions (F37); free-cash spend ceiling + insufficient_balance skip (F38)**; **SL is the TERNARY not max() across §6.1/ADR-OC-7/DF-3/§17-F13 (F1); ambiguous-placement-throw → non-terminal + ENTRY-ADOPT (F40); honest surfacing-throttle prose, no human-ack gate (F41); persisted breaker counter bot_circuit_state (F42); latch anti-self-wedge guards — fresh-mark-confirm + kill_date predicate (F32b); loser/void resolution detection via endDate<now (F36b); manageBrackets resolution-FIRST ordering (F6b); dual share/notional dust floor (F7); POL-gas surface getGasBalance + pol_balance + minPolGas (F10); persisted neg_risk on bot_positions + fail-closed redeem (F2/F5); resumeExit function defined (§17-F43)**; **breaker operator-reset via bot_set_enabled (F2/§17-F43b); breaker brownout/ambiguous dimension + periodic reconcile (F3/§17-F44); resolution closed-flag re-sourced to MarketMeta + persisted resolves_at (F6); kill cancels resting entries (F8/§17-F45); redeem idempotency (F9/§17-F46); killLossPct pinned to bankrollBaseUsd (F17); dust_parked mid-life no-churn (F7/§17-F34b); clockSanityCheck placement-halt home (F10/F21); bootstrapApprovals + smoke-test live-boot gate (F11); ENTRY-ADOPT writes a bot_orders row before bot_fill_with_caps (F5); §17-F14/F43 dedup + F9→F36b + §10.2 exports (F12/F13/F14)**; **(round-7, propagating round-6) bot_close_position SUM-derives exit_taker rows + gates 'closed' on a fresh venue-held==0 CORROBORATED by the exit-shortfall + resolves_at checks (§17-F47/F7); exit_in_flight_until ≤1 outstanding exit FAK, committed BEFORE the await, in resumeExit AND applyExit (§17-F48/F9); caps_exceeded_held → auto-clearing over_cap_halt latch WIRED into the bot_should_run reason set, NOT the consecutive_failures breaker (§17-F44/F1/F3); bootstrapApprovals THREE-contract set incl. the NegRiskAdapter on EVERY surface — §6.2/§6.3/§14/§15/GO-LIVE (F8/F3); bot_deadman_check MODE-AWARE + BOTH deadmen built in Phase 0 for the Phase-5 paper run (F13/F5); bot_record_ambiguous RPC wires the brownout breaker dimension (§17-F44); reconcile EXIT-RESUME → resumeExit not applyExit (F4); operator flatten of an UNFILLED position cancels the resting entry via resumeExit (F10); clock-drift halts placement but keeps exits best-effort + CRITICAL (F12); executableBid depth-shortfall mark pinned conservative for the kill, fillable≥held for brackets (F2)**; **(round-8) mode-aware `getHeldShares` Signer-port read (live=fetchPositions filter, paper=ledger entry−exit SUM) — every manager venue-held read routes through it INCL. reconcile + a paper-exit/winner-booking test (F3-r8/F2-r9); `bot_positions.condition_id` + `token_yes` NOT-NULL persisted from EntryCandidate, carried on the capture buckets jsonb (tokenYes/tokenNo/conditionId), with a redeem-key-present test for the absent-/positions-row path (F2-r8); manageFill at-fill caps-breach routes to `over_cap_halt`, NOT the consecutive_failures breaker — the FOURTH producer site (F1-r8); Slack CRITICAL kinds allowlisted vs the global pause (F4-r8)**; **(round-9) sustained-conservative-breach (`killLatchPersistTicks`) MTM latch + MTM netted on residual `entry_shares − Σexit_taker` (F1-r9/F3-r9); reconcile UNDER the lease + resumeExit openOrders sweep for ambiguous-'intent' (F4-r9/F5-r9); redeem-idempotency guard reads on-chain ERC-1155 balanceOf not the indexer (F9-r9); clockSanityCheck is a DRIVER fn not a Signer method (F7-r9); bot-seeded house_gaussian/forecast snapshots TAGGED + excluded from dash_data/calibration/amsterdam/bets (F16-r9); 'failed'-with-holding keeps its bucket slot (F6-r9)**
- [ ] `bot_orders` — UNIQUE(client_order_id) (DB dedup only); reconcile-set index
- [ ] `bot_gate_snapshot` — defined with verdict columns; `(mode,computed_at desc)` index; written by bot_record_gate_snapshot
- [ ] `bot_loop_lease` — single-row CAS lease

### Data Flows (§9)
- [ ] DF-1 capture happy path + seed + venue/seed-outage branch
- [ ] DF-2 entry: kill-gate-first (incl. MTM); flat-open+universe select; maker place; post-fill review (live first-N); never-retry branch
- [ ] DF-3 manage/exit: atomic+partial fill; bracket fire → FAK exit + retry; clock-only decision but venue-dependent flatten; exit_failed branch
- [ ] DF-4 heuristic reconcile before first tick; unmatched holding warning
- [ ] DF-5 operator flatten + kill within one tick
- [ ] DF-6 paper backtest → verdict → snapshot

### Boundary & safety (§8 handoff / §11)
- [ ] Paper mode runs the FULL pipeline with no POLY_* secret
- [ ] No module logs/echoes/commits the key; `.env.local` guard-secrets respected
- [ ] Real money blocked until Phase 0.5 = GO AND `openingVerdict` = PASS
- [ ] Phase-0.5 spike artifact `scripts/research/opening-spike.ts` (§6.13c, F11-r8) EXISTS with a numeric GO/NO-GO bar (`bot.spikeGoFrac`) + an isFlatOpen unit test — the gate that authorizes Phases 2–6 is a concrete artifact, not prose
- [ ] `GO-LIVE-CHECKLIST-OPENING.md` EXISTS and carries all six load-bearing sections before any go-live (F21): DEPOSIT/ONBOARDING (incl. the concrete USDC→pUSD acquisition under V2), APPROVAL BOOTSTRAP to the THREE-contract set incl. the NegRiskAdapter (F33/F8), NTP/clock (F21), SUPERVISOR/reconcile-on-boot (F22), ROTATION/INCIDENT-DRAIN (F30), ROUTINE PROFIT-SWEEP/WITHDRAWAL (F39)
- [ ] `CLAUDE.md` header / `FINDINGS.md` (live-candidate row) / `BUILD-STATE.md` updated to record the scoped rail reactivation (Handoff §1/§8)

### §16 research-driven corrections (CLOB V2 + capture cadence) — see §16
- [ ] Signer is NET-NEW on `@polymarket/clob-client-v2@1.0.6` (viem), NOT a mirror of `live.ts` V1 (§16-A)
- [ ] Maker entry = post_only GTC (4th positional bool); taker exit = FAK; SL/time-stop FAK, TP optionally resting maker SELL (§16-B/C)
- [ ] Entry-side GTD time-stop is OUT OF SCOPE (F17/§17-F17c) — the placeOrder union is 'GTC'|'FAK' only; entry time-stop = makerFillWindowMin cancel, hard time-stop = FAK taker (no GTD/+60s-buffer path to build)
- [ ] pUSD collateral + V2 contracts via `getContractConfig(137)` + `updateBalanceAllowance` before buy/sell (§16-A)
- [ ] Capture is a FIRST-SEEN snapshotter on a ~2–3 min poll (NOT */10); the flat-open window is ≤~1h, often <1 candle (§16-D)
- [ ] `listingMaxHours` ≈ 1 anchored on `created_at_gamma` (Gamma true listing time; first-seen only the fallback), NOT 6 (§16-D/F20); a Phase-0 probe confirms Gamma `/events` returns `createdAt` for a live weather event (else demote to first-seen); Phase-5 expects ~100+ listings for 40 entries (§16-E)
- [ ] resting `post_only` GTC survival-without-session is an UNVERIFIED assumption (F2 OPEN) — the §17-F17 smoke test leaves an order resting >2 min sessionless + confirms `live` before banking maker-first; the 5s `heartbeat` is ONLY for the optional WS fill-feed, NOT a prerequisite for resting orders (§16-F)
```

---

## 16. Research-Driven Corrections (2026-06-27, post-review — AUTHORITATIVE over earlier text where they conflict)

Two operator research artifacts produced in parallel with this blueprint resolve open items and correct two
assumptions. Both are now build-binding. Sources: **`research/REPORT-clob-bracket-execution.md`** (CLOB V2,
SDK-verified against `@polymarket/clob-client-v2@1.0.6`) and **`research/FLAT-OPEN-WINDOW-2026-06-27.md`** (the
window-duration probe + `scripts/research/flat-open-window.ts`).

**§16-A — CLOB V2 is mandatory; the signer is NET-NEW, not a mirror of `live.ts`.** Polymarket cut over to
**CLOB V2 on 2026-04-28** (new CTF Exchange `0xE111180000d2663C0091e4f400237545B87B996B`, NegRisk Exchange
`0xe2222d279d744050d28e00520010520000310F59`, **pUSD** collateral `0xC011…E82DFB`); **V1 SDKs/orders no longer
work on production.** So `createNodeClobSigner` (§6.3) must build on **`@polymarket/clob-client-v2@1.0.6`**
(viem `walletClient`, NOT ethers@5; options-object constructor; `throwOnError:true`) — it does **not** mirror
`trading/live.ts`'s `@polymarket/clob-client@4` (the V1 line). The V2 signed-order struct dropped
`nonce/expiration/feeRateBps/feeRate` and **fees are set by the protocol at match time** (remove any
fee-in-order logic). Approvals: `getContractConfig(137)` ships the V2 addresses + pUSD;
`updateBalanceAllowance({asset_type: COLLATERAL})` before a buy, `({asset_type: CONDITIONAL, token_id})` before
a sell. **Correction (F10/§17-F33): `updateBalanceAllowance` is a gasless server-side balance/allowance CACHE
REFRESH layered ON TOP of a REQUIRED one-time on-chain `approve()` (pUSD ERC20) + `setApprovalForAll` (CTF
CONDITIONAL) to the V2 CTF Exchange AND the NegRisk Exchange — it is NOT a replacement for them** (the earlier
"never raw `approve()`" wording was wrong: a brand-new dedicated wallet has no approvals, and the first live SELL
hits the CONDITIONAL allowance — the R-4 path — so the on-chain bootstrap must run before `tradingMode=live`,
gated on GO-LIVE-CHECKLIST-OPENING.md; gas = POL). `createOrDeriveApiKey()` and the L1/L2 auth are unchanged
(ClobAuth domain still version "1"). **pUSD acquisition (F21):** the operator obtains pUSD collateral by
depositing USDC into the Polymarket proxy wallet, which the venue holds/wraps as the V2 pUSD collateral
(`0xC011…E82DFB`); the concrete step-by-step (proxy-wallet creation + ToS + USDC→pUSD + POL-gas top-up +
post-fund `getCollateralBalance` verify) lives in `GO-LIVE-CHECKLIST-OPENING.md` §1, but the load-bearing fact —
pUSD is acquired via a USDC deposit to the proxy wallet, not a separate swap the bot performs — is stated here so
it isn't solely captive in that doc. *This supersedes ADR-OC-1's "Node signer mirrors `createClobClient`" and the §4/§10
`@polymarket/clob-client@4 + ethers@5` lines.*

**§16-B — Order types CONFIRMED against the V2 SDK (resolves the §6.2 W1 go-live hedge).** GTC/GTD/FOK/FAK all
exist in V2. **Maker resting entry = GTC with `post_only`** (the 4th positional bool of
`createAndPostOrder(order, options, OrderType.GTC, true)`; GTC/GTD-only; rejects if it would cross) — guarantees
free maker status, **no local bestAsk-guard needed**. **Taker exit = FAK** (fills available depth, kills the
rest — correct for a thin book; FOK would wrongly kill the whole exit) with a worst-price slippage limit a few
ticks through the bid. GTD exists in the SDK (and if ever used the **SDK does NOT add the 60s server
buffer — the caller must set `expiration = floor(now/1000) + 60 + N` itself**; a GTD with expiration 0 is
rejected), **but the entry-side GTD time-stop is OUT OF SCOPE for this build (F17/§17-F17c):** the entry
time-stop IS the `makerFillWindowMin` cancel and the hard time-stop is a FAK taker, so `placeOrder` admits only
'GTC'|'FAK' (no GTD path to build, verify, or NTP-gate). `getOpenOrders()`/`getOrder()` exist (resolves the
reconcile-API hedge). *This confirms §6.2's FAK choice and removes the "unverified" caveat — cite the report.*

**§16-C — Exit refinement: TP as a free resting maker SELL (operator-confirm).** §9R-C locked "taker exit on
bracket fire." The research shows a strictly-cheaper option: make the **take-profit a resting GTC maker SELL**
($0 maker fee, rebate-eligible) parked at the profit target, and keep only **SL + time-stop as FAK takers**
(certainty of exit). Then the only fee-paying legs are the forced/loss exits — exactly where you want to spend
fees. This is the `maker_exit_then_taker` `BracketAction` variant §12 anticipated. **Recommended; surfaced for operator
confirmation** (it refines, not contradicts, §9R-C's certainty-first intent — SL/time-stop stay taker). The
maker rebate itself (I-10) is CONFIRMED a **daily discretionary pro-rata pool, not a per-fill 25% credit** —
bank only the $0 maker fee as certain; the rebate is probable upside the gate measures, never assumed.

**§16-D — The flat-open window is ≤~1h (often <1 candle) and present in only ~3/8 listings; capture must be a
FIRST-SEEN minute-poll.** The window probe (8 markets): only **3/8 opened ≤18%** (madrid 12%, guangzhou 7%, KL
11%) and the peak crossed 18% within **0–1h**; 5/8 were already converged at the first hourly candle. So **§9R-B's
"within ~6h of listing" is far too generous — the real window is ≤1h.** Consequences that supersede the earlier
capture spec: (1) the capture cron must be a **~2–3 min first-seen poll** of new Gamma listings (snapshot the
full book + seed the forecast the instant a market appears) — **NOT the `*/10` mirror of `cross-venue-capture`**;
a 10-min sweep risks missing the window entirely. (2) `bot.listingMaxHours` ≈ **1**, not 6, computed as
`now − created_at_gamma` (the Pass-3 listing-anchor numerator — Gamma's true listing time; at a ~2–3 min
first-seen poll, `created_at_gamma ≈ first-seen`, so the two clocks agree to within the poll interval and the
created_at_gamma anchor + the Phase-0 surfacing task stand). (3) The peak≤18% threshold + first-seen capture
do the real work; the time bound is nearly moot. *(Caveat:
`/prices-history` is hourly, so it under-resolves the true sub-hour open — which makes the minute-cadence
requirement STRONGER, and is precisely what the live capture layer + Phase-0.5 spike measure: first-seen →
minute-by-minute peak decay + whether the <1h open carries fillable depth.)*

**§16-E — Entries are rarer → Phase-5 takes more calendar time.** At ~3/8 (~38%) of listings presenting a cheap
open, the bot must scan **~100+ listings to accumulate the 40 paper entries** the §9R-E gate needs. A timeline
input, not a kill — Phase 5's "≥2 weeks AND ≥40 markets" may run longer than 2 weeks; the gate's market-count
is the binding criterion.

**§16-F — Operational: order-survival vs the heartbeat (design assumption — technically sound, SOURCE-UNVERIFIED; F2 stays OPEN until the Phase-6 smoke test).** Auto-cancel-on-disconnect is read as a
**user-websocket-session** feature: it cancels open orders if a connected WS session stops heart-beating within
~10s. **The bot's order path is REST** (`createAndPostOrder`/`cancelOrder` — stateless requests), so a
**resting `post_only` GTC is EXPECTED to survive without any persistent session** — the maker-resting path
*should* not be auto-cancelled and *should* not collapse to taker. **This is technically sound (a stateless REST
GTC has no session to drop) but it is an INFERENCE, not a venue-verified fact** — the cited report frames
auto-cancel-on-disconnect *in relation to* whoever holds resting maker entries and its §9 ledger never
adjudicated order-survival-without-session. The whole edge depends on free maker entries RESTING, so do NOT bank
it as closed: **F2 stays OPEN until the §17-F17 Phase-6 smoke test leaves a `post_only` GTC resting >2 min with
NO websocket session and confirms via `getOpenOrders()` it is still `live`.** The **user-websocket is OPTIONAL**, used only as a low-latency
**fill feed** (cumulative `size_matched` on UPDATE events); the authoritative fill/reconcile source is the REST
`Signer.getOrder` + a periodic `getOpenOrders()` sweep (the specced path). **IF** the operator enables the WS
fill feed, a dedicated 5s heartbeat + reconnect/backoff component keeps THAT session alive (`Signer.heartbeat()`
— live=ping when the WS is open, paper/REST-only=no-op); it is a Phase-6 add gated to the WS path, NOT a
prerequisite for resting orders. A fill is "real" only at trade `status=CONFIRMED` (MATCHED can still go
RETRYING/FAILED). Rate limits are non-binding (POST/DELETE order ~200/s sustained; reads far above the bot's
needs) — only a cancel/repost churn loop could approach them; keep reprices infrequent (thin books churn queue
priority).

---

## 17. Round-2 Review Remediations (2026-06-27, multi-agent team review — AUTHORITATIVE over earlier text where they conflict)

A 4-lens agent team (integrity / adversarial-source / logic-races / completeness) reviewed the §16-corrected
blueprint, consolidated, and adversarially **validated** every finding against real source (`REVIEW-opening-convergence.md`
Round 2). 28 validated; the drift items were patched in place; the design gaps below are specified here as the
authoritative home (with body hooks already placed in §6/§7/§8). Order ≈ severity.

**§17-F4 — Market-resolution accounting (held-into-resolution path).** The time-stop is best-effort (I-9/R-4), so
a position CAN reach settlement; there was no path to book it. Added: `resolveHeldPosition` (§6.6) +
`bot_resolve_position` RPC (§8.2) + the `'resolved'` position state (§7). Each tick + reconcile, detect
resolution via `redeemable=true` (winner, `polymarket-wallet.ts:57`) OR persisted `resolves_at < now` with `closed`
re-sourced via `resolveMarketsMeta` (F6/F7 — `:57` carries only `redeemable`, there is NO closed field on the
/positions parser);
WIN → `Signer.redeem(conditionId, tokenYes, negRisk)` (live, negRisk-correct redeem → the ACTUAL pUSD, F14c) or
book held×$1 (paper) → `'resolved'`;
LOSS → closed-at-0 → `'resolved'`; **VOID/50-50/UMA-disputed/refunded → held×(actual resolved outcome price), NOT
a forced $1/$0 (F36/§17-F36)** — and EXCLUDED from the F-OC-10 gate panel (executed-but-void ≠ a skill outcome).
A no-book resolved market is treated as resolved (not the conservative-worst-case
mark) so the daily-loss MTM + the ADR-OC-10 net-PnL gate stay accurate. Paper-first scope: the on-chain redeem
may be a GO-LIVE manual pUSD sweep, but the terminal value is always booked so a position never retries a
vanished book forever.

**§17-F9 — seedHouseDist MUST upsert `market_buckets`.** Specified in §6.10c: `buildDistributionForEvent`
short-circuits writing nothing unless `market_buckets` rows exist (`distributions.ts:82`, `get_build_inputs`
`0033:38`); the discover seam seeds before its own bucket upsert and only `if is_new`, so a naive copy no-ops on
a brand-new event → `houseProb` null for ~every flat-open market → Phase-0.5 false NO-GO. seedHouseDist upserts
the walked ladder (`upsert_bucket` per parsed bucket — data already in hand) + resolves `city_id`/`icao` for
`upsert_event`, BEFORE `buildDistributionForEvent`. This is a Phase-0 DoD gate.

**§17-F10 — fill accumulation sums across the position's orders.** `bot_fill_with_caps(p_position_id)` now
DERIVES the cumulative by SUMMING `matched_shares` across all of the position's `bot_orders` rows (each order's
terminal fill persisted on its own row), NOT a single caller-supplied "cumulative" — so a maker-partial +
taker-remainder blend correctly (F-OC-14) and a re-poll of any one order is a true no-op (§8.2 / §6.6 manageFill).

**§17-F11 — DST-correct local-noon time-stop.** `localNoon` is computed DIRECTLY as the UTC instant of local
wall-clock noon via a NEW `core/time.ts` helper `localHourInstant(tz, dateISO, hour) => new Date(new TZDate(y,
m−1, d, hour, 0,0,0, tz).getTime())` (the same mechanism `localDayWindow.startUtc` uses, `time.ts:48`), NOT
`startUtc + 12h` (which is ±1h wrong on the ~2 DST-transition days/yr). The §15 DST test must exercise a
spring-forward AND a fall-back transition DAY for the noon instant (§6.1).

**§17-F12 — Loop concurrency invariant + honest watchdog claim.** Config invariant **`bot.leaseTtlSec` >
`bot.tickWatchdogSec` + margin** (rejected at boot) so an under-budget tick can't lose its lease to a second
process mid-run (added to §7 config keys + §8.2 bot_loop_lease). The self-chaining `setTimeout` prevents overlap
on the happy path, BUT a JS wall-clock watchdog does NOT cancel an in-flight DB/Signer call — so the "no
overlap" guarantee is corrected: **double-EXECUTION is prevented at the DB layer (CAS state transitions, the
partial-unique `(event_id,bucket_idx)` open constraint, `UNIQUE client_order_id`, the atomic `bot_fill_with_caps`),
NOT by JS timing** (§6.13b / ADR-OC-8 / R-5). Defense-in-depth: the watchdog sets a "tick aborted" flag the
in-flight ops check before any `placeOrder`.

**§17-F13 — Relative stop for cheap entries (the TERNARY, NOT max — F1-corrected).** The absolute −12pp SL is
INERT for entry ≤ 0.12 — the entire target band (§16-D's qualifying opens were 7–12%). `bracketDecision` SL fires
at the **TERNARY `mark ≤ ((entryPrice − slDeltaPp > 0) ? entryPrice − slDeltaPp : entryPrice × (1 − slFrac))`**
(default `slFrac`=0.5): the §9R-C-locked −12pp absolute stop WHEREVER it is positive (entry > 0.12), falling to
the relative floor ONLY for entry ≤ 0.12 where −12pp is non-positive (e.g. a 12% entry → −12pp is inert → stops
at 6%; an 18% entry → stops at 6% via the absolute −12pp). **NOT `max(entryPrice − slDeltaPp, entryPrice × (1 −
slFrac))`** — F1: a `max()` takes the TIGHTER relative stop for the ENTIRE (0.12, 0.20] band (e.g. 18% entry →
max picks 9% over 6%), silently overriding the operator-locked −12pp for every achievable entry above 12%
(selectEntries permits `maxEntryPrice`=0.20). The ternary and max() coincide only for entry ≤ 0.12 or ≥ 0.24, so
the distinction is load-bearing across the whole achievable band. (§6.1; §9R-C locked −12pp — the relative floor
is an additive refinement for the inert band, surfaced for operator confirm; ADR-OC-7 / DF-3 / R-3 corrected to
the ternary accordingly.)

**§17-F14 — Live bankroll source.** `Signer.getCollateralBalance()` (live = pUSD ERC20 `balanceOf` the funder
via viem + `getContractConfig(137).collateral`; paper = `bot.paperBankrollUsd`) → written to a NEW **`bot_bankroll`**
table (the equity schema in the §17 data-models block: free/held/equity/base — F1, NOT a single `balance_usd`)
by `bot_set_bankroll` at startup + periodically; `bot_exposure` / `bot_fill_with_caps` read **equity or base** as
the live caps denominator (F9b). ADR-OC-8's "USDC" is corrected to **pUSD** (§16-A).
Without this the live caps had no bankroll source (ADR-OC-9's "live swaps only the signer" also needs this
balance→DB path).

**§17-F17 — Live-signer smoke test (Phase-6, before first-N).** A zero-cost dress rehearsal gated ahead of any
real fill: (1) `createOrDeriveApiKey` + `getOpenOrders`/`getOrder` round-trip (proves L1/L2 auth + the reconcile
read); (2) `updateBalanceAllowance` dry call for BOTH `COLLATERAL` and `CONDITIONAL` (the sell-side allowance is
otherwise first hit on a real SL/time-stop exit — the R-4 path); (3) a `post_only` GTC sized ≥ `max(5 shares, $1 notional)` — the venue floor (REPORT §2; a 1-share/sub-$1 order is REJECTED at min-size and can NEVER rest, so the survival test couldn't run — F12-r10) — e.g. 5 shares at ≥$0.21, placed FAR from
market (cannot fill), left resting >2 min, confirmed still `live`, then `cancelOrder`. Gate `tradingMode=live`/first-N on it passing. Added to §14
Phase 6 DoD + `GO-LIVE-CHECKLIST-OPENING.md`.

**§17-F18 — Systemic circuit-breaker.** N consecutive placement FAILURES (which cost no capital → invisible to
the daily-loss kill) → `bot_should_run` trips `circuit_break`, sets `bot_enabled=false` + one CRITICAL Slack;
counter resets on any successful placement; threshold `bot.maxConsecutiveFailures` (§6.9). Stops the loop
churning into a broken venue (malformed data / auth / clock). New Risk Register row.

**§17-F19 — VPS loop liveness + deadman + audit trail.** NEW **`bot_tick_log`** table (`asOf`, `mode`,
`ran/placed/filled/exited` counts, `gate_reason`/`kill_reason`) written each tick by `bot_record_tick` (the
runJob/`job_runs` analog the keyless capture has but the VPS loop lacked) — a forensic trail + a "last tick age"
liveness timestamp surfaced on `/bot`. An EXTERNAL `bot_deadman_check` pg_cron Slack-CRITICALs if `max(bot_tick_log.asOf)`
(live mode) is staler than ~2–3× `tickIntervalSec` — the one alert that survives the VPS process itself being
dead (the silent-death-while-holding case, R-4). New Risk Register row.

**§17-F20 — Crash-mid-exit recovery.** `reconcilePosition` gains an `'exiting'`-state arm: re-read venue held
shares, record any executed-but-unrecorded partial via `bot_close_position`'s accumulate path, and immediately
re-enter `resumeExit` (CAS-free — NOT `applyExit`, whose 'armed'→'exiting' CAS no-ops on an already-'exiting' residual; F4) on the residual; PRIORITIZE `'exiting'` + near-time-stop (and resolved-but-held) positions
ahead of entry repair so reboot flattens/settles before resolution (§6.6).

**§17-F21 — Clock-sync (ops).** The always-on VPS MUST run NTP (systemd-timesyncd/chrony) — the local-noon
time-stop (an EXIT) depends on accurate wall-clock. A cheap startup + periodic clock-sanity check
(local `now()` vs Supabase server `now()` via the db port; no CLOB server-time endpoint exists — F17-r8) halts PLACEMENT to stop opening new risk on a bad
clock AND fires a CRITICAL to re-sync NTP — but EXITS (incl. the clock-only time-stop) keep running best-effort
(freezing them, holding unmanaged into resolution, is strictly worse than a mistimed time-stop — R-4); so
placement-halt alone does NOT protect the time-stop, which is best-effort under drift (F12). Added to `GO-LIVE-CHECKLIST-OPENING.md` + §11.2.

**§17-F28 — Few-cluster CI under-coverage (the money gate).** PASS clusters by city with effective df = #cities
(≈6–10); a naive `t(G−1)` interval under-covers (narrow CI → easier false PASS). For C < ~15 clusters, replace
the parametric interval with a **wild-cluster (Rademacher) bootstrap** (or CR2 + Satterthwaite df), OR make the
zero-skill MC the BINDING calibration as a **cluster-PRESERVING permutation** of the full PASS criterion
(winFrac floor AND ciLow>0); a row-level shuffle ignoring city structure is itself anti-conservative. At minimum
the `openingVerdict` reason string states that a marginal `ciLow>0` at 6 cities is NOT a true 95% guarantee.
Apply to the shared `crossVenueVerdict` too (§6.1 / ADR-OC-10).

**§17-F29 — post_only would-cross handling.** A `post_only` GTC that would cross returns status `'rejected'`
(expected on a moved thin book, NOT a throw): `openPosition` maps it to position `'rejected'` (§7 enum) + order
status `'rejected'`, logs INFO (not CRITICAL 'failed'), and recovers same-tick (reprice one tick lower as
post_only OR fall to the capped taker FAK) so a transient cross doesn't cost the ≤1h window (§6.2/§6.6). This
also gives the previously-orphan `'rejected'` state a real writer (F23).

**§17-F30 — Secrets rotation + incident runbook.** `GO-LIVE-CHECKLIST-OPENING.md` MUST include a rotation +
incident section (mandated from R-8 / the Phase-6 DoD so it can't be dropped). The load-bearing detail: a leaked
`POLY_PRIVATE_KEY` guards a FUNDED wallet, so the emergency runbook is **instant `bot_enabled=false` → DRAIN the
dedicated wallet's pUSD + positions to a cold address (re-issuing CLOB creds is insufficient — funds must move)
→ new wallet/key → re-derive CLOB V2 creds**, plus routine rotation of `SUPABASE_SERVICE_ROLE_KEY` / `CRON_SECRET`
/ `SLACK_WEBHOOK_URL`. (The project already has a prior key-exposure precedent.)

**§17-F31 — Paper↔live fill-model calibration (Phase 6).** The gate runs on MODELED paper fills (pessimistic on
price, but the maker fill-RATE is the optimistic risk — paper counts a fill on any traded-through; live maker
fills are queue-priority gated). For each first-N live fill, persist the paper model's predicted fill
(fill-yes/no, price, slippage) alongside the realized fill, compute the divergence, surface it on `/bot`, and
gate relaxing the first-N throttle + any Phase-7 cap raise on live-realized net edge tracking within a tolerance
of the paper prediction — not merely aggregate +EV (§6.8 / §14 Phase 6/7).

### §17 new data models (the F-additions to §7)
- **`bot_tick_log`** (F19): `id bigint identity`, `as_of timestamptz`, `mode text`, `ran bool`, `placed int`,
  `filled int`, `exited int`, `gate_reason text`, `kill_reason text`. Index `(mode, as_of desc)`. Written by
  `bot_record_tick`; read by `dash_bot` ("last tick age") + `bot_deadman_check`.
- **`bot_bankroll`** (F14/F9b/F10): `mode text primary key`, `free_pusd numeric`, `held_value_usd numeric`,
  `equity_usd numeric` (= free + held), `base_usd numeric` (operator-set starting snapshot), `pol_balance numeric`
  (native POL gas — F10), `updated_at timestamptz`. Written by `bot_set_bankroll`; read by `bot_exposure` /
  `bot_fill_with_caps` (equity/base = caps denominator; `free_pusd` = the F38 spend-ceiling input; `pol_balance` <
  `bot.minPolGas` → Slack-CRITICAL).
- **`bot_daily_kill`** (F32) — schema + latching/guard semantics defined authoritatively at **§7** (this is the
  one F32 table also homed in §7); surfaced here as the F32 addition.
- **`bot_circuit_state`** (F11/§17-F42/F44): `mode text primary key`, `consecutive_failures int not null default
  0`, `consecutive_ambiguous int not null default 0` (F3 — the brownout/timeout dimension), `tripped_at
  timestamptz`, `updated_at timestamptz`. The PERSISTED F18 breaker counters (a process-memory counter would
  reset on the very crash-loop F18 catches). `consecutive_failures` incremented by `bot_record_order_result` on a
  'failed' write ONLY (F1 — `caps_exceeded_held` drives the SEPARATE auto-clearing `over_cap_halt` latch §8.2/F3, NOT this systemic breaker); `consecutive_ambiguous` incremented by
  openPosition's F40 ambiguous-throw branch; BOTH reset to 0 on any successful placement AND atomically cleared by
  `bot_set_enabled(true)` (the F2 operator-reset — no auto-clear). Read by `bot_should_run` (`failures ≥
  maxConsecutiveFailures` OR `ambiguous ≥ maxConsecutiveAmbiguous` → `circuit_break`). Transient ERR_RATE_LIMITED
  / ERR_INSUFFICIENT_BALANCE never increment.

## §17 (round-2 review remediations — second pass)

A second team review of the §17-corrected blueprint surfaced deeper logic bugs (exit-mark side, headroom-drop,
exit-resume) — fixed at their function homes above (F1–F4, F8, F10–F13, F21) — plus these cross-cutting items,
authoritative here:

**§17-F16 — Seed burst bound.** (Header restored — `§15` cites it.) The on-demand seed fan-out at the daily
ladder rollover is bounded: walk + insert the depth rows FIRST, cap seed concurrency (~3–4 in-flight) with a
per-invocation seed time budget (over-budget → record remaining rows `houseProb=null`, never time out the edge
wall-clock), and dedupe the OM fetch per station (leads 0/1/2 share one forecast). Spec'd in §6.10c.

**§17-F9b — Bankroll denominator = EQUITY or a fixed base, not floating free-cash.** *(Renumbered from a
first-pass-colliding "§17-F9" — F4 ID hygiene; the first-pass §17-F9 = seedHouseDist→market_buckets, distinct.)*
`getCollateralBalance()`
returns FREE pUSD, which SHRINKS as entries spend pUSD into conditional tokens (the position value is then
uncounted) → a `−25%-of-bankroll` kill would fire prematurely mid-entry-cycle for a non-loss reason. **Two
DISTINCT denominators (F17/§17-F9b-corrected):** (1) the **exposure/caps** bankroll reference uses **total equity
= free pUSD + Σ marked held-position value** (never floating free-cash); (2) the **`killLossPct` daily-loss
threshold is PINNED to the day-start `bot.bankrollBaseUsd` snapshot — a FIXED dollar number for the trading day,
NEVER live equity.** Live equity is itself a floating denominator that falls as held positions go underwater, so
`killLossPct × equity` would be a moving target that shrinks exactly as you lose (self-reinforcing; it also lets a
concurrent winner inflate the denominator and defeat the kill F32 guarantees) — the day's loss must be measured
vs the day-start base, matching this section's own clause. `bot_bankroll` stores all (free / held / equity /
base) so caps use equity and the kill uses base.

**§17-F14b — Gas (POL) for redeem + approvals.** CLOB trade post/cancel/match are gasless (relayer-settled), but
the held-into-resolution REDEEM + the F33 one-time approval bootstrap + deposit/withdraw need **POL gas**. Add a
POL buffer to fund (J-1 + `GO-LIVE-CHECKLIST`); the boot/periodic bankroll read also reads POL and Slack-CRITICALs
below a redeem/approval-cost floor.

**§17-F14c — Redeem mechanism BRANCHES on negRisk (corrects F14b's "direct CTF redeemPositions").** Weather
markets are **negRisk winner-take-all** (`research/REPORT-clob-bracket-execution.md` — "weather is negRisk!"), and
a negRisk outcome token does **NOT** redeem through plain Gnosis CTF `redeemPositions` — that call REVERTS on a
negRisk position, stranding settled winnings on-chain (the exact R-16 failure F4 exists to prevent). `Signer.redeem`
must branch on the position's `negativeRisk` flag (already surfaced by `fetchPositions`): negRisk (the weather
DEFAULT) → the **NegRiskAdapter** redeem; plain CTF `redeemPositions` only for any non-negRisk position. Pin the
actual **NegRiskAdapter** contract address (NOT the NegRisk *Exchange* `0xe222…310F59`, which is the order-matching
venue cited for trade approvals in §16-A — a different contract) and verify it against the live SDK's
`getContractConfig(137)` / V2 contract list before building. Add a negRisk-redeem verification to the GO-LIVE
checklist's first resolved-position. WARNING-severity: F4 scopes the on-chain redeem paper-first + always books
terminal value, and a wrong-contract redeem REVERTS (winnings uncollected, not lost/mis-paid) — so this lands
before the live automated redeem is implemented, not an active money-loss bug today.

**§17-F15 — Seed QUALITY gate (not just existence).** A single fresh OM snapshot can yield a degenerate/low-
confidence `house_gaussian` (a sparse model set if some models 404 that tick, an OM outlier, an under-calibrated
lead). Before a seeded dist can drive entries, require a minimum number of contributing models + a
dispersion/mode-confidence bound + `model_stats` calibration coverage for that station+lead; if any fail, treat
it as `houseProb=null` (capture the depth, don't enter). (`selectEntries`/`seedHouseDist`.)

**§17-F17b — Rate-limit / 429 policy.** *(Renumbered from a first-pass-colliding "§17-F17" — F4 ID hygiene; the
first-pass §17-F17 = the live-signer smoke test, distinct.)* The cancel→repost remainder loop is the one place
that can approach the
~200/s order budget. Add to the Signer: a minimum reprice interval per token, exponential backoff + jitter on a
429/throttle, and a distinct **retryable `ERR_RATE_LIMITED`** in the §11.1 error taxonomy that does NOT count
toward the §17-F18 consecutive-failure breaker (a throttle is transient, not a systemic failure).

**§17-F22 — Process-level observability for the VPS loop.** `bot_tick_log` is written at tick END, so a crash/
OOM/hang BEFORE the row leaves no diagnostic. Add: a structured JSON logger (level-tagged, **key-redacted by
construction**, stdout + rotated file), a process supervisor (systemd/pm2) with auto-restart that re-runs
`reconcile` on boot, and both in `GO-LIVE-CHECKLIST`. The `bot_deadman_check` (F19) remains the external
last-resort alert.

## §17 (round-3 review remediations — third pass, AUTHORITATIVE)

A third 4-lens agent team review (integrity / adversarial-source / logic-races / completeness) of the
§17-second-pass blueprint surfaced **18 validated findings** (`REVIEW-opening-convergence.md` Round 3) — 2 fixed
inline last session (the `bot_bankroll` 3-schema reconcile + the reconcile entry-ADOPT arm), the remaining 16
applied here at their function homes (§6/§7/§8/§11/§13/§14/§15/§16) and recorded below. Order ≈ severity. The
ID-hygiene + cross-ref items (F4/F5/F6/F7/F16/F18 in the round-3 list) were applied in place: the second-pass
`§17-F9`→**§17-F9b** and `§17-F17`→**§17-F17b** renames (collisions with the first-pass F9/F17), the §15 wiring
of F14b/F15/F22, the §16-F "RESOLVED→source-unverified" demotion, the ADR-OC-8 capture-emission reword, the §7
`bot.bankrollBaseUsd` config key, and the §6.3 `getCollateralBalance`-is-not-an-SDK-method correction.

**§17-F32 — LATCHED daily-loss kill (the un-trip defeat).** The daily-loss kill was a per-tick LIVE RECOMPUTE
(realized + fluctuating MTM vs −$30/−25%) with no latch, so it could UN-trip the same day: an underwater
position recovering, OR a winner's positive MTM netting already-realized losses back above threshold, re-arms
entries after the "non-negotiable" stop was hit (Handoff §5-D). Fix: on first breach for the trading day, UPSERT
`bot_daily_kill(mode, kill_date)` and have `bot_should_run` return `daily_loss_kill` for the rest of that day
regardless of MTM recovery; the "day" boundary is a single operator IANA tz (`bot.killDayTz`, since station-local
trading spans UTC days). Additionally FLOOR each open position's unrealized contribution at 0 (`max(0, cost −
mark)`) so a concurrent winner can never mask booked realized losses even on the evaluation tick. Exits/management
unchanged. (§8.2 bot_should_run, §7 bot_daily_kill, ADR-OC-8, R-10.)

**§17-F33 — One-time gas-funded ON-CHAIN approval bootstrap (no specified REAL approval-setup).** §16-A specified
approvals only as `updateBalanceAllowance` (a gasless server cache refresh) and §17-F17 only DRY-calls it — but a
new dedicated wallet needs a REAL on-chain `approve()` (pUSD ERC20) + `setApprovalForAll` (CTF CONDITIONAL) to the
V2 CTF Exchange AND the NegRisk Exchange, gas = POL, set BEFORE the first live buy/sell. The first live SELL is
often a time-critical SL/time-stop flatten (R-4), so a missing CONDITIONAL allowance would fail the flatten. Fix:
a one-time gas-funded approval bootstrap gated BEFORE `tradingMode=live` (GO-LIVE-CHECKLIST + §14 Phase 6),
idempotent (skip if already max); fold the gas into the §17-F14b POL buffer; the signer ensures the CONDITIONAL
allowance idempotently AT ARM TIME (outside the time-critical `applyExit`). Corrects §16-A's "never raw approve()"
wording. **PROXY-AWARE (F6-r10, HARD pre-live gate): the funder is a Polymarket PROXY wallet (sigType 1 POLY_PROXY / 2 GNOSIS_SAFE — it holds the pUSD AND the CTF tokens), so a DIRECT EOA `approve()`/`setApprovalForAll` sets the EOA's allowance, NOT the proxy's → the Exchanges pull pUSD / move CTF from the PROXY → the first live BUY and the first live SELL (the R-4 flatten) REVERT for missing allowance. Branch on `POLY_SIGNATURE_TYPE`: sigType 0 (EOA) keeps the direct viem write; sigType {1,2} routes the approval through the proxy's exec (POLY_PROXY exec / Safe execTransaction) so the PROXY's allowance is set — OR, if Polymarket onboarding pre-approves the proxy at the USDC→pUSD deposit (as V1 `live.ts` assumed), DROP the on-chain bootstrap for proxy mode and VERIFY the pre-existing proxy allowance instead. This is the one on-chain leg REPORT §9 did NOT verify — verify against a live proxy + getContractConfig(137) which address the V2 contracts read allowances on BEFORE building, and add a proxy-vs-EOA isApprovedForAll assertion to the §17-F17 smoke test. Also point `getGasBalance` at the gas-paying EOA, not the funder proxy.** (§16-A, §6.6 applyExit, §14 Phase 6, R-8 path.)

**§17-F34 — Exit dust floor (sub-minimum residual).** After partial FAK fills the leftover can fall below the
venue min order size (~5 shares / $1), which cannot be placed as a sell — "retry until flat" then NEVER reaches
flat, churning FAK attempts every tick (burning the ~200/s budget) and escalating to `exit_failed` + CRITICAL on
un-flattenable dust (a permanent false alarm, possibly tripping the F18 breaker on economically-trivial dust).
Fix: when the live-read residual < `bot.minOrderSizeShares`, STOP the retry loop, mark `exit_reason='dust_residual'`,
and hand it to `resolveHeldPosition` (book terminal value at settlement; redeem works on any token amount) — NOT
`exit_failed`/CRITICAL. Capital is never lost. (§6.6 applyExit / §6.7 resumeExit, §7 config.)

**§17-F35 — Producer-side capture deadman (`capture_deadman_check`).** `bot_deadman_check` (F19) watches the
CONSUMER (the VPS loop / `bot_tick_log`), not the PRODUCER everything depends on. If the capture cron breaks,
Gamma 403s, or seeding silently fails, `opening_captures` stops accruing USABLE rows: the bot scans empty and
never trades, and the ≥2-week / ≥40-market Phase-5 clock STALLS with no alarm — camouflaged by the expected ~62%
no-entry rate, and fail-silent BY DESIGN (DF-1 swallows Gamma/seed failures as non-fatal). Fix: a `capture_deadman_check`
pg_cron (migration 0066) that Slack-CRITICALs on (a) `max(opening_captures.captured_at)` staler than ~2–3 poll
intervals AND (b) a seeded-fraction collapse toward ~0 (a plain row/job-success check is insufficient since both
failure modes are silent). (§8.2, §14 Phase 0, R-20.)

**§17-F36 — Void/refund/UMA-dispute settlement branch.** `resolveHeldPosition`/`bot_resolve_position` modeled only
binary WIN ($1) / LOSS ($0). Polymarket markets can be VOIDED / UMA-disputed / resolve 50-50 / refund — a held leg
of an ambiguous resolution is redeemable at ~$0.50, not $1, so the binary classifier 2×-over-states realized PnL,
which flows into the daily-loss MTM and the F-OC-10 net-PnL gate (amplified at the ~40-market sample). Fix: a
THIRD branch booking the ACTUAL settled value (the real pUSD `Signer.redeem` returns live / held×resolution-price
in paper, never forced $1/$0), detected from an extended `WalletPosition` parser (`mergeable` / the market's
resolution price — `polymarket-wallet.ts:42-66` drops both today), and EXCLUDE void/ambiguous markets from the
openingVerdict panel (executed-but-void ≠ a skill outcome). (§6.6, §8.2, §17-F4, R-16.)

**§17-F37 — Daily-loss MTM scoped to share-holding positions.** `bot_should_run` applied the conservative
worst-case (bucket worthless) to ANY open position missing a fresh mark — but the open set includes
'intent'/'maker_resting' rows that hold ZERO shares (entry_shares null-until-filled) and never enter `freshMarks`
(manageBrackets only marks held positions). So three resting $20 entries register $60 of PHANTOM drawdown and
self-wedge the −$30 kill whenever a couple maker entries rest (safe-direction, but an operational dead-end). Fix:
scope BOTH the fresh-mark and the conservative-worst-case MTM to positions with `entry_shares > 0`
('armed'/'exiting'/'exit_failed'); unfilled 'intent'/'maker_resting' contribute 0; keep the conservative
worst-case only for HELD-but-unmarked positions (the F10 /book-failed case). Mirrors §17-F4's state-scoping
precedent. (§6.9 entryGate, §8.2 bot_should_run, ADR-OC-8.)

**§17-F38 — Free-cash spend ceiling (equity denominator ≠ spendable cash).** The caps denominator is EQUITY
(free pUSD + Σ marked held value), chosen to AVOID a premature kill (§17-F9b) — but held value can't fund a buy,
so at the cap edge the at-fill RPC passes while live `placeOrder` rejects for insufficient pUSD → a 'failed'
placement that (per F18) trips the consecutive-failure breaker, conflating "wallet fully deployed" with "venue
broken." Fix: gate a new BUY on `bot_bankroll.free_pusd ≥ cost + fee + bot.freeCashReserveUsd` — a ceiling
DISTINCT from the equity exposure cap — authoritatively at `bot_open_position` (pre-place; a fill is
post-execution and can't un-buy) + advisory at `capsHeadroom`; and add `ERR_INSUFFICIENT_BALANCE` to the §11.1
taxonomy as a `skip:wallet_deployed` that does NOT count toward the F18 breaker (mirrors §17-F17b's
`ERR_RATE_LIMITED` carve-out). (§6.9, §8.2 bot_open_position, §11.1.)

**§17-F39 — Funds lifecycle (deposit/onboarding + routine profit-sweep).** J-1 hand-waves funding ("funds it
small, places `POLY_PRIVATE_KEY`") and §17-F30 covers only an EMERGENCY drain — there is no ROUTINE path for (a)
the initial deposit mechanics (Polymarket proxy-wallet creation + ToS, the USDC→pUSD collateral acquisition under
V2 — §16-A made pUSD load-bearing yet never said how the operator gets it, POL-gas top-up, a post-fund
`getCollateralBalance` verify) or (b) a routine WITHDRAWAL/profit-sweep (redeem only converts winning tokens to
pUSD that then SITS in the wallet — the system's stated goal is net profitability, so a realize-profits step is
load-bearing). Fix: two sections in `GO-LIVE-CHECKLIST-OPENING.md` — DEPOSIT/ONBOARDING and ROUTINE
PROFIT-SWEEP/WITHDRAWAL (own POL-gas budget, distinct from the F30 emergency drain). Not a code bug — gates
go-live, not the build. (GO-LIVE-CHECKLIST-OPENING.md; J-1; §16-A.)

**§17-F17c — Entry-side GTD time-stop OUT OF SCOPE.** `Signer.placeOrder`'s order-type union is `'GTC'|'FAK'`,
which cannot express the optional entry-side GTD time-stop §16-B/§15/§17-F21 referenced (with its caller-owned
+60s buffer). Resolution: mark the GTD entry time-stop out of scope (the entry time-stop IS the `makerFillWindowMin`
cancel; the hard time-stop is a FAK taker), drop the §15 GTD checklist item, and strike "the GTD +60s buffer" from
§17-F21/§11.2 (keep local-noon as the sole wall-clock dependency). GTD remains an SDK-verified type, just unused.
(§16-B, §6.2, §15, §11.2.)

### §17 third-pass false positives (validated NOT real — recorded so they aren't re-raised)
- **No anomalous-FILL circuit breaker (claimed gap):** FALSE — every order placed is a venue-enforced limit
  (post_only GTC can't fill above its limit; FAK taker carries a worst-price slippage limit a few ticks through
  the bid, §16-B), so a fill cannot occur far through the book; capital is bounded by `perPositionUsd` + the
  atomic caps + the equity kill. No software price-sanity bound is needed on a venue-limit order.
- **Slack "one-click" overstates the reused infra (claimed):** FALSE — `ACTION` is a Slack SEVERITY tier, not an
  interactive button; the genuine one-click halt/flatten is the `/bot` page server action (`bot_flatten_position`),
  exactly as §6.8/§8.1 already state (`/bot` row + flatten button); the Slack ACTION is only the alert. No
  inbound-Slack interactivity is claimed or needed.

### Convergence note (round 3 → applied)
Round 3 yielded 18 validated (vs 21 round-2, 28 round-1) with severity trending down — the canonical sub-1.0
convergence; the round-3 findings are localized accounting/ops gaps + spec-placement drift, not fresh
design holes. All 16 remaining are now applied at their homes. **A focused round-4 delta sweep (re-read the fixed
doc) is the right next cost call** — the build-critical machinery (kill latch, settlement, approvals, exit dust,
MTM scope, free-cash, capture liveness) is now substantially hardened; the tail is expected to be INFO-only.

## §17 (round-4 review remediations — fourth pass, AUTHORITATIVE)

A fourth team-review round (re-read the round-3-fixed doc) surfaced **19 validated findings** (17 returned +
2 recovered from failed validators; 1 UNCERTAIN→INFO, 1 FALSE_POSITIVE). Most were the predicted "each fix adds
surface" consequences of the round-3 edits; the only genuinely-NEW CRITICAL (F1) was a PRE-EXISTING SL-formula
contradiction the prior passes missed. All 19 applied at their homes; the new §17 IDs below.

**§17-F1 — SL is the TERNARY, not `max()` (CRITICAL, pre-existing).** §6.1 correctly used the ternary
`(entry−12pp>0) ? entry−12pp : entry×(1−slFrac)` and explicitly rejected `max()`, but ADR-OC-7, DF-3, and the
"authoritative" §17-F13 all wrote the rejected `max()` — which takes the TIGHTER relative stop for the entire
(0.12, 0.20] achievable band (selectEntries permits maxEntryPrice=0.20), silently overriding the §9R-C-locked
−12pp for every entry above 12%. Unified all four sites to the ternary. (§6.1, ADR-OC-7, DF-3, §17-F13.)

**§17-F32b — Latch anti-self-wedge guards (CRITICAL).** The F32 latch could self-wedge two silent ways: (1)
within-day, a single transient `/book` outage marks the whole held set conservative-worst-case (worthless) →
breaches Σ(held cost) → LATCHES dead for the day on a non-event (the loop keeps ticking so deadmen never fire,
reboot doesn't clear it); (2) across-day, with no clearing writer and an unpinned date predicate, gating on row
EXISTENCE wedges all future days after the first breach. Fix: only a FRESH-mark + realized-loss-confirmed breach
persists the latch (conservative-mark breaches drive a soft same-tick halt only); pin the read predicate to
`kill_date = current_date in bot.killDayTz` (stale row ignored + overwritten); one Slack notify on latch. (§7
bot_daily_kill, §8.2 bot_should_run.)

**§17-F14c (extended) / F2 — negRisk source is PERSISTED, fail-closed (WARNING).** F14c wrongly claimed the
`negativeRisk` flag is "already surfaced by fetchPositions" — the `WalletPosition` parser (polymarket-wallet.ts:42-66)
has no such field; negRisk lives only on `MarketMeta`. And negRisk is load-bearing on EVERY placement (a wrong
value → order rejected — REPORT §1), not just redeem. Fix: persist `neg_risk` on `bot_positions` + `opening_captures`
(from `parseGammaEvent.negRiskMarketId`, default true for the weather-only universe — F5), pass it to both
`placeOrder.negRisk` and `Signer.redeem.negRisk`; extend the F36 parser with `negativeRisk` as a reconcile-from-venue
fallback; `Signer.redeem` FAILS-CLOSED to the NegRiskAdapter when the flag is absent (never the reverting plain CTF).
(§6.2, §6.6, §6.10, §7, §17-F14c.)

**§17-F36b — Loser/void resolution detection (WARNING).** F36's `redeemable=true` trigger fires ONLY for WINNERS;
a held LOSER at resolution is not redeemable and the parser has no closed/UMA field, so a missed-time-stop loser
would sit in armed/exit_failed retrying a vanished book forever, and the paper backtest can't detect a void
offline. Fix: detect resolution as `redeemable` OR (`endDate < now` AND market closed/not-tradable); extend the
F36 parser with the closed flag + settled price (`curPrice`/markets-meta UMA lookup); for the paper gate, detect
voids via a markets-meta lookup at backtest time OR state voids are unobservable in paper + quantify the bias.
(§6.6 resolveHeldPosition, §6.13a, §17-F36.)

**§17-F6b — manageBrackets is RESOLUTION-FIRST (WARNING).** The round-3 per-tick `resumeExit` was evaluated
BEFORE the resolved-market branch, so a position that went exit_failed/exiting and THEN resolved matched
resumeExit first and never settled per-tick (doomed FAK against a vanished book until the next reboot). Fix:
do the per-position fetchPositions read up front and route any resolved position to `resolveHeldPosition` FIRST,
regardless of state (mirrors the §17-F20 reconcile-path priority). (§6.7.)

**§17-F40 — Ambiguous placement throw is NON-TERMINAL (WARNING).** `openPosition` marked every placement throw
terminal 'failed' — but a timeout/dropped-response throw is AMBIGUOUS (the order may have landed; no client-order-id
to confirm, C3), and 'failed' drops the row from BOTH the open set AND the ENTRY-ADOPT reconcile arm, letting a
landed order's held YES ride into resolution unmanaged. Fix: classify a definitive server-confirmed reject →
'failed'; an ambiguous throw → leave NON-TERMINAL in 'intent' (with its intent order row, never auto-retry) so
ENTRY-ADOPT can adopt a phantom fill; ENTRY-ADOPT also scans recently-'failed' positions for matching holdings.
(§6.6 openPosition + reconcilePosition.)

**§17-F41 — Honest first-N surfacing-throttle (WARNING).** W5b claimed "the operator genuinely eyeballs trade #1
before #2 fills" — unimplementable (no `reviewed` column; postFillReview auto-bumps `realTradesApproved` on
SURFACING, not on human action) AND it would contradict W5's core decision (approval latency cannot sit in the
flat-open edge window). Fix: corrected the prose to the real mechanism — the throttle blocks entry k+1 until
entry k's fill is SURFACED (Slack + counter bump), one-at-a-time, but does NOT block on operator acknowledgment;
blast radius is bound by caps + the latched kill, not a human review gate. (§6.8, ADR-OC-13.)

**§17-F42 — Persisted breaker counter `bot_circuit_state` (WARNING).** The F18 consecutive-failure counter had
no storage home; a process-memory counter resets on the very crash/OOM-loop F18 exists to catch, and the stateless
`bot_should_run` RPC can't read a TS-process counter. Fix: new `bot_circuit_state(mode, consecutive_failures, …)`
table, incremented by `bot_record_order_result` (failed) ONLY (F1 — `caps_exceeded_held` drives the separate `over_cap_halt` latch, not this breaker), reset on
success, read by `bot_should_run`. (§7/§17 data models, §6.9, §8.2.)

**§17-F35b — Backtest continuous mark series (mid-hold vol-floor truncation, WARNING).** A held market that drops
below the §6.10-step-2 vol floor mid-hold stops being captured, truncating `bot_capture_series`. Required behavior:
assert each entered market has a continuous mark series through the time-stop; on truncation, carry the last good
bid forward as a conservative worst-case OR exclude+flag — never let a gap read as "held to time-stop" (it would
bias the money gate toward no-TP/SL outcomes). (§6.13a DoD; the §6.13a citation `(F7/§17-F35b)` resolves here.)

**§17-F10b — POL-gas surface (WARNING).** §17-F14b mandated a POL-low alarm with no code surface. Fix: added
`Signer.getGasBalance()` (viem native POL balance), a `pol_balance` column on `bot_bankroll` + a `p_pol` arg on
`bot_set_bankroll`, config `bot.minPolGas`, and a boot/periodic Slack-CRITICAL below the floor. (§6.2, §8.2, §7,
§17 bot_bankroll.)

**§17-F7b — Dual share/notional dust floor (WARNING).** The venue minimum is `max(5 shares, $1 notional)`; the
F34 dust floor tested shares only, so an 8-share residual at $0.05 ($0.40) is not-dust yet venue-rejected every
tick. Fix: the dust floor is now `residualShares < bot.minOrderSizeShares OR residualShares×bid < bot.minOrderNotionalUsd`.
(§6.6 applyExit, §6.7 resumeExit, §7 config.)

**§17-F43 — `resumeExit` is now a defined §6.6 function** (F12 renumber — was mislabeled "§17-F14 (def)",
colliding with §17-F14 = live bankroll source; resumeExit was referenced everywhere, defined nowhere; a CAS-free
per-tick exit continuation distinct from applyExit). **§10.1 now carries the manageBrackets→resumeExit /
→resolveHeldPosition edges.** Plus the INFO hygiene applied in place: F13 (insufficient_balance struck from
entryGate Returns), F15 (localNoonUtc→localHourInstant @ §6.1), F16 (F12-corrected→F13-corrected @ §6.1), F19
(bot_daily_kill single-homed to §7), F20 (partial-UNIQUE includes exit_failed), F21 (§15 GO-LIVE existence gate +
in-blueprint pUSD-acquisition sentence), and F4 (FALSE_POSITIVE — the approval safety is already in the
pre-go-live bootstrap; tightened the bootstrap's viem home + arm-time traceability). NOTE on the bare-"F2"
collision (documented, NOT auto-rewritten — round-5 F12): bare "F2" still denotes THREE things in §6.6 (the
held-shares/entry-adopt accounting @ §6.6, order-survival @ §16-F, negRisk @ §17-F14c). Each reads correctly in
local context; a blanket find/replace would corrupt the order-survival refs, so the disambiguation is recorded
here rather than mechanically applied — read §6.6's "F2" as the entry-adopt/held-shares accounting (akin to
§17-F10/F4), §16-F's "F2" as order-survival, §17-F14c's "F2" as negRisk.

### §17 round-4 false positive (validated NOT real)
- **F4 — "approval bootstrap port methods missing → flatten reverts → money lost":** FALSE — the one-time on-chain
  `approve` + `setApprovalForAll` (both exchanges) is mandated BEFORE `tradingMode=live` (§14 Phase 6 / §16-A /
  §17-F33), gated on GO-LIVE-CHECKLIST-OPENING.md, so the first FAK flatten cannot revert for a missing approval;
  the arm-time re-ensure is redundant insurance. Tightened to INFO: gave `bootstrapApprovals()` a concrete
  viem-composed home (§6.3) and wired the arm-time ensure into manageFill's Calls.

### Convergence note (round 4 → applied)
28 → 21 → 18 → 19 validated REAL across four rounds; the round-4 count held flat (not down) because the round-3
fixes ADDED surface (latch, settlement branches, approvals, dust floor) and the lens found the edge cases each
introduced — but only ONE new CRITICAL (F1, pre-existing) and zero new fundamental design holes; the rest are
localized accounting/wiring/hygiene. **~70 validated findings resolved across the full review campaign** (Phase-9
3-pass + 4 team rounds). The doc is materially more build-ready than at round-3 close. **Recommended: one more
round-5 delta sweep** (the round-4 fixes again add surface — bot_circuit_state, neg_risk persistence, resumeExit
def, the ternary unification — worth one adversarial pass) until the tail is unambiguously INFO-only, then STOP:
literal-0 is an asymptote on a ~2,000-line real-money autonomous-bot blueprint, and the build-critical machinery
is now hardened on every axis the lens has probed.

## §17 (round-5 review remediations — fifth pass, AUTHORITATIVE)

Round 5 (re-read the round-4-fixed doc) returned **9 REAL / 6 UNCERTAIN / 4 FALSE_POSITIVE — and ZERO CRITICAL**
(REAL: 28→21→18→19→**9**, the convergence finally bending down hard). All 9 REAL + the 6 UNCERTAIN (validator
retry-cap failures; the `.catch` preserved their text, and they self-validate against source) were applied; almost
all were consequences of the round-4 fixes (the F42 breaker, F40 ambiguous-throw, F36b detection). New §17 IDs:

**§17-F43b — Circuit-breaker operator reset (F2).** The F42 breaker was a one-way latch with no surfaced reset:
on trip it sets bot_enabled=false, but the counter resets ONLY on a successful placement — which is gated by the
breaker → never resets → rail permanently wedged, recoverable only by direct SQL (`setBotEnabled(true)` alone
re-trips next tick). Fix: `bot_set_enabled(true)` (operator_guard) ATOMICALLY zeroes both counters + `tripped_at`
as the human acknowledgment of re-enable; a `/bot` "circuit tripped — reset" surfaces it. (§6.9, §8.2, §6.11a.)

**§17-F44 — Breaker brownout/timeout dimension + periodic reconcile (F3).** The F18 breaker incremented ONLY on a
definitive 'failed' write — but the COMMON broken-venue mode (CLOB down/unreachable) manifests as TIMEOUTS, which
F40 classifies AMBIGUOUS → 'intent', no 'failed', no increment → the breaker never trips during a brownout while
phantom 'intent's (possibly filled, bracket-UNMANAGED) accumulate, and ENTRY-ADOPT was boot-only. Fix: a
`consecutive_ambiguous` counter on `bot_circuit_state` (incremented by openPosition's ambiguous branch, trip at
`bot.maxConsecutiveAmbiguous`); promote reconcile/ENTRY-ADOPT to PERIODIC (`bot.reconcileEveryTicks`) so phantom
fills are adopted+managed during a running brownout, not left until reboot. (§6.9, §8.2, §7, §6.13b, R-17.)

**§17-F36b (extended) / F6 — Resolution detection re-sourced + persisted clock (F6).** The `closed`/resolution
flag lives on the gamma EVENT/market payload (read via `resolveMarketsMeta`), NOT on the /positions
`WalletPosition` row (whose only valid extensions are `mergeable`+`negativeRisk`); and a dropped venue row (or a
venue filtering a zero-value loser) left a resolved position wedged in exit_failed. Fix: re-source `closed` via
MarketMeta; persist the Gamma `endDate` as `bot_positions.resolves_at` (carried capture→entry) so
`resolveHeldPosition` settles on `resolves_at < now` EVEN WHEN the live /positions row is absent. (§6.6, §6.10, §7.)

**§17-F45 — Kill cancels resting entries (F8).** A daily-loss latch / manual kill gated PLACEMENT but cancelled
nothing already resting, so a pre-kill maker ENTRY could still fill and arm fresh exposure after "down for the
day, done". Fix: `cancelRestingEntries` (a §6.7 helper run on a closed gate) cancels all 'intent'/'maker_resting'
resting entry orders + routes any cancel-race straggler fill straight to flatten — neither placement nor
exit-management, so it doesn't violate "never freeze management". (§6.7, ADR-OC-8.) PRECISION (F6, round-7): cancelRestingEntries flattens only STILL-RESTING entry orders + the post-latch cancel-race straggler; a maker entry that manageFill already DISCOVERED + armed in step 3 BEFORE this tick's gate evaluation (step 4) is, by design, booked-and-bracket-managed like any existing position (the kill MANAGES, doesn't ABANDON, open risk — §6.7) — so a daily-loss kill caps the day at threshold + at most one in-flight fill, not exactly threshold. Intended, not a hole.

**§17-F46 — Redeem idempotency (F9).** No F40-equivalent for the redeem leg: an on-chain redeem tx that lands
while its response is lost would re-redeem → REVERT (already redeemed) → never reach 'resolved', looping, or
mis-book PnL. Fix: pre-redeem guard (require `redeemable=true` + a positive on-chain balance, else treat as
already-redeemed → reconcile); ambiguous-throw → leave NON-TERMINAL + WARNING; book WIN PnL as held×$1 − entry_cost (deterministic payout), reality-check via THIS position's conditional-token balance going to zero (the pre-redeem guard already reads it) or the redeem-tx receipt — **NEVER the whole-wallet `getCollateralBalance` delta** (F6-r8 / round-6-F17-corrected: the aggregate moves with every concurrent fill/redeem across all positions → false-alarms; superseded by §6.6 "never the wallet aggregate"). (§6.6.)

**§17-F34b — Dust parked mid-life (F7).** A `dust_residual` handed to `resolveHeldPosition` is a no-op while the
market still trades (dust is usually detected mid-life), so the position churned 'exiting'→resumeExit→no-op every
tick with a per-tick alert (the churn F34 aimed to kill, only the CRITICAL removed). Fix: a `dust_parked` marker
(exit_reason='dust_residual') that manageBrackets SKIPS until `resolves_at < now` → resolveHeldPosition. (§6.6, §6.7.)

**§17-F9b (corrected) / F17 — `killLossPct` pinned to the day-start base.** Live equity is a floating denominator
that falls as positions go underwater, so `killLossPct × equity` is a moving target that shrinks as you lose (and
a winner inflates it, defeating the F32 kill). Fix: the EXPOSURE caps use equity; the `killLossPct` daily-loss
THRESHOLD is pinned to the day-start `bot.bankrollBaseUsd` (a fixed $ for the day). (ADR-OC-8, §17-F9b, §8.2.)

**Plus the round-5 completeness/integrity items:** F4 — declared `bootstrapApprovals`/`ensureConditionalApproval`/
`clockSanityCheck` on the §6.2 Signer port (round-4 wired the call but never declared the method) + the per-token
sell-side `updateBalanceAllowance` cache refresh; F5 — ENTRY-ADOPT writes a synthetic `bot_orders` 'matched' row
BEFORE `bot_fill_with_caps` (which takes only a position_id and SUMS order rows — no size arg, else entry_shares=0
hides the holding); F10 — `clockSanityCheck` is a DRIVER function using BotDeps.db (F7-r9 — NOT a Signer port method; the live signer has no db) + `bot.maxClockDriftSec` + the
driver placement-halt (F21's clock-sanity had no code home); F11 — `bootstrapApprovals()` + the smoke test are
`--bootstrap`/`--smoke-test` live-boot gates in §6.13b (were checklist-prose only); F16 — F32b's Guard 1
specified as TWO drawdown sums (FULL drives the soft halt, CONFIRMED drives the latch); F13 — §14 Phase 0 "8
tables"→"9"; F14 — §10.2 lists `localHourInstant`+`executableBid`; F12 — `§17-F14`(def)→**§17-F43** dedup, the
resolution-detection `F9`→`F36b` re-tag, and the bare-`F2` collision documented (not mechanically rewritten — a
blanket replace would corrupt the order-survival refs); F1 — `manageBrackets` branch (3) clarified as the
intent/maker_resting/armed catch-all (not an 'armed'-only filter — the round-4 prose invited that misread).

### §17 round-5 false positives (validated NOT real — recorded)
- **manageBrackets has no maker_resting branch (claimed CRITICAL):** FALSE — branch (3) is a chained-else
  catch-all (intent/maker_resting/armed), 'armed' was a descriptive label; clarified the prose so the misread
  can't recur. **MTM mark not net-of-exit-fee:** FALSE — the "over-state only" invariant is scoped to
  staleness/netting, not fees; the gross bid mark doesn't contradict it. **dual polymarket-wallet twins:** FALSE —
  the seam invariant is for renames/drop-rules; additive Node-side reconcile fields (negativeRisk/mergeable/closed)
  are pre-authorized, no twin parity obligation. **seedMinModels has no source:** FALSE — `parseMultiModelDaily`
  returns the model list in-hand at seed time.

### Convergence note (round 5 → applied)
28 → 21 → 18 → 19 → **9** validated REAL across five rounds, **zero CRITICAL in round 5** — the convergence has
clearly bent down. The 9 REAL were all WARNING/INFO and almost entirely the edge cases the round-4 fixes
introduced (breaker, ambiguous-throw, detection), now closed. **~90 validated findings resolved across the
campaign** (Phase-9 3-pass + 5 team rounds). **Recommendation: a round-6 confirmation sweep, then STOP at
INFO-only.** The round-5 fixes add modest surface (bot_set_enabled, consecutive_ambiguous, resolves_at,
cancelRestingEntries, the Signer port additions), but no design axis remains unprobed; literal-0 is an asymptote
and the build-critical machinery (kill latch + reset, two-dimension breaker, settlement detection + redeem
idempotency, entry-pull-on-kill, dust parking, the pinned kill threshold) is hardened. If round 6 is INFO-only,
the doc is BUILD-READY and the loop should close.

## §17 (round-6 review remediations — sixth pass, AUTHORITATIVE) + LOOP CLOSED

Round 6 (re-read the round-5-fixed doc) returned **14 REAL / 2 UNCERTAIN / 4 FALSE_POSITIVE — REAL bounced UP
9→14 with 2 CRITICAL, NOT down.** The asymptote is real: the round-5 fixes added surface (breaker counters,
cancelRestingEntries, resolves_at, the SUM-derive seams) and the lens found the wiring gaps each introduced. All
14 REAL + the 2 UNCERTAIN applied; the 4 FALSE_POSITIVE refuted. New IDs:

**§17-F47 / F2 (CRITICAL) — `bot_close_position` made symmetric to F10.** The exit RPC still took a caller-supplied
`p_exit` accumulate → a double-count believes the position flat → CAS 'exiting'→'closed' (terminal, out of the
open set + reconcile + resolveHeldPosition) → real residual stranded forever (R-16). Fix: SUM-derive
`matched_shares WHERE intent='exit_taker'`; gate 'fully flat' on a FRESH venue-held==0 re-read, not arithmetic;
book only CONFIRMED fills. `bot_fill_with_caps` now SUMs only entry-intent rows.

**§17-F44 (completed) / F1 (CRITICAL) — the round-5 breaker was spec'd but UNWIRED.** `consecutive_ambiguous` had
no writer; the success-reset zeroed only `consecutive_failures`; `tripped_at` was never SET. Fix: a new
`bot_record_ambiguous` RPC wired into openPosition's F40 branch; the success write zeroes BOTH counters + clears
tripped_at; `bot_should_run` SETS tripped_at on the trip and reports `circuit_break` (not `disabled`) while it IS
NOT NULL.

**§17-F48 / F4 (WARNING) — exit-path double-execution guard.** The entry-side DB guards don't cover the exit path
— a watchdog-aborted mid-FAK lets the next tick place a second concurrent FAK. Fix: an `exit_in_flight_until`
marker resumeExit (and applyExit) respect, **committed BEFORE the awaited FAK** (F9 — set-marker→then-place; place-then-set leaves the watchdog-abort window unguarded) (≤1 outstanding exit FAK per position); corrected the §17-F12 claim for the exit leg.

**Round-6 WARNING/INFO fixes:** F3 — `caps_exceeded_held` decoupled from the broken-venue breaker (an
auto-clearing `over_cap_halt` + `over_cap` transition-dedupe flag + manageFill short-circuit) so static over-cap
inventory can't false-trip/spam CRITICAL; F6 — `cancelRestingEntries` books a straggler BEFORE flatten + sweeps
`Signer.openOrders` for ambiguous-'intent' phantoms; F7 — void routed SOLELY through MarketMeta outcomePrices/UMA
(`mergeable` is inventory); F8 — `bootstrapApprovals` extended to a THREE-contract set incl. the **NegRiskAdapter**
(redeem contract — else the first live winning redeem reverts); F9 — `bot_flatten_position` CAS-marks 'exiting'
(DB-only), VPS loop flattens next-tick (key boundary; "immediate" was false); F11 — dust_parked skipped in the
boot-reconcile arm too; F13 — `bot_deadman_check` made MODE-AWARE (Phase-5 paper loop death was un-alarmed); F16 —
`bot_open_position` softened from "AUTHORITATIVE" (free_pusd unreserved snapshot); F17 — redeem reconcile uses the
per-token balance-to-zero, not the false-alarming whole-wallet pUSD delta; F14/F15/F18/F19 — hygiene.

### §17 round-6 false positives (refuted)
- `bot_fill_with_caps` SUM folds exit shares (refuted — exit rows imply state ≥ exiting; the F2 fix made the
  intent-qualification explicit anyway). dust_parked strands a winner (refuted — branch (1) fires on `redeemable`
  regardless of state). endDate-but-not-closed limbo (refuted — the documented loudest-alert worst case).
  paper-void OR unbuildable (refuted — the LIVE path is pinned via F36b; the paper OR is a measured-bias note).

## §17 (round-7 review remediations — seventh pass)

A seventh 4-lens agent-team round (integrity / adversarial-source / logic-races / completeness → consolidate →
per-finding adversarial validation against real source; workflow `arch-review-validate-wf_99e2d4a3-543.js`).
**27 raw → 22 consolidated → 16 REAL / 1 UNCERTAIN / 5 FALSE_POSITIVE.** REAL ticked 14 → **16** with 3 CRITICAL —
but ALL THREE CRITICALs were HALF-PROPAGATED round-6 edits, not new design holes (the asymptote: each fix round
adds surface and the lens finds the wiring it introduced). All 16 REAL applied at their function homes + here.

**CRITICALs (all round-6 propagation gaps):**
- **F1 — `caps_exceeded_held` decoupling half-propagated.** Round-6 F3 moved `caps_exceeded_held` OUT of the
  systemic `consecutive_failures` breaker into a separate auto-clearing `over_cap_halt` latch, but THREE producer
  sites (§6.9 entryGate, §17-F42 model bullet, §17-F42 narrative) still routed it into the breaker (a builder
  copying from the §17-F42 model re-introduces the exact CRITICAL regression F3 removed), AND the `over_cap_halt`
  reason was never wired into the CONSUMER (`bot_should_run` reason set / `entryGate` Returns) → the soft
  placement-halt silently never fired. Fixed both halves: struck the stale increments + wired `over_cap_halt`
  with an `EXISTS … over_cap=true AND state IN (open share-holding set)` auto-clearing read predicate.
- **F2 — `executableBid` depth-shortfall mark unspecified.** On the thin flat-open book the bot deliberately
  enters, realizable bid depth < held size is the NORM, yet neither the bracket mark nor the kill MTM pinned how
  a bid-depth shortfall collapses to a scalar — both naive readings unsafe (optimistic hides drawdown + fires TP
  unrealizably; pessimistic over-states drawdown as FRESH and latches the day's kill dead on a transient thin
  bid). Pinned: kill MTM values the unfillable remainder conservatively + treats sub-depth as NOT fresh-marked
  (excluded from the §17-F32b CONFIRMED latch sum); a bracket requires `fillableShares ≥ heldShares` else `hold`.
  Closes the fetch-SUCCESS-with-thin-bids hole §17-F32b Guard 1 left open for /book FETCH-FAILURES.
- **F3 — three-contract approval bootstrap not propagated.** Round-6 F8 extended `bootstrapApprovals` to the
  THREE-contract set (incl. the **NegRiskAdapter** redeem contract — else the first live winning redeem reverts,
  R-16), but only §6.2 was updated; the operator-facing GO-LIVE-CHECKLIST §2, §14 Phase 6, §15 go-live gate, and
  §6.3 all still listed only the TWO trade-time Exchanges. Propagated the NegRiskAdapter to all five surfaces.

**WARNINGs:** F4 — boot reconcile EXIT-RESUME re-entered `applyExit` (whose 'armed'→'exiting' CAS no-ops on an
already-'exiting' position → silent non-flatten); → `resumeExit` (CAS-free), matching the per-tick path. F5 —
the deadman crons were double-listed in Phase 6 though they're migration-0066 Phase-0 objects, leaving the
≥2-week Phase-5 PAPER run with no loop-liveness alarm; moved to Phase 0 + made `bot_deadman_check` mode-aware
active for Phase 5. F7 — `bot_close_position` gated 'closed' SOLELY on a fresh venue-held==0, but §17-F36b proves
the /positions row drops transiently → a spurious 0 strands a real residual (R-16); now CORROBORATED by
exit-shortfall + `resolves_at` (a venue-0 with a SUM-shortfall routes to settle, never terminal 'closed'). F9 —
`exit_in_flight_until` ordering unpinned; the natural place-then-set leaves the watchdog-abort window unguarded →
double-FAK; pinned set-marker-BEFORE-the-await in `resumeExit` AND `applyExit`. F10 — `bot_flatten_position`
"entry-cancel-then-flatten" for an UNFILLED position had no consumer (resumeExit only flattened held shares);
wired the resting-entry cancel into resumeExit's first step + CAS unfilled→'exiting' + fixed the DF-5
flatten→applyExit drift. F11 — the §15 DoD checklist was stale at round-5 IDs (the round-6 CRITICALs F47/F48 +
F3/F8/F13/F44 ungated); appended the round-6/7 lines + added `bot_record_ambiguous` to the RPC checklist. F12 —
`clockSanityCheck`'s rationale was backwards (it halts PLACEMENT but its justification is the time-stop EXIT
needs the clock); fixed to keep exits best-effort + CRITICAL-page on drift, placement-halt only stops new risk.

**INFO:** F13 (reconcilePosition Calls list + §10.1 map missing bot_fill_with_caps/bot_close_position/resumeExit);
F15 (stray duplicate `Maps to` on bot_record_ambiguous → moved to bot_record_order_result); F17 (Exec-Summary
"6 modules" → 8: + approval + reconcile); F18 (`§17-F14` bankroll-denominator cite `(F9)` → `(F9b)`); F21
(capture-deadman seeded-fraction alarm parameterized — `bot.captureSeededFracMin`/`captureSeededFracWindow`);
F22 (boot assertion `--mode == tradingMode` so the loop-stamped mode and the deadman's tradingMode partition
can't diverge).

**UNCERTAIN → prose-precision (F6):** the kill-tick step-3 `manageFill` arms a venue-executed maker fill BEFORE
step-4's gate, so a daily-loss kill caps the day at threshold + at most one in-flight fill (not exactly
threshold). The validator confirmed this is INTENDED (the kill manages, doesn't abandon, open risk) — tightened
the §17-F45 prose to stop overclaiming the "no fresh exposure survives a kill" invariant; no behavior change.

### §17 round-7 false positives (refuted — do not re-raise)
- **F8** — count unfilled 'intent'/'maker_resting' INTENDED notional toward the exposure cap (refuted — would
  contradict the deliberate §17-F37 zero-share design and self-wedge the normal resting-maker mode; the brownout
  phantom is independently bounded by the consecutive_ambiguous breaker + the auto-clearing over_cap_halt).
- **F14** — §10.1 map missing tick→cancelRestingEntries / openPosition→bot_record_ambiguous edges (refuted —
  §10.1 is a curated summary that already elides several §6 Calls edges; both behaviors are fully specified in
  §6/§8/§17).
- **F16** — `dust_parked` ambiguous stored-column-vs-predicate (refuted — §17-F34b authoritatively defines it as
  the derived predicate `exit_reason='dust_residual'` within 'exiting'/'exit_failed', computable from existing
  columns; adding a column would create a second source of truth).
- **F19** — free-cash ceiling over-counts by resting-order reservations (refuted — `free_pusd` is explicitly
  non-authoritative; the venue `ERR_INSUFFICIENT_BALANCE → skip:wallet_deployed` backstop is cause-AGNOSTIC, so
  it catches a resting-reservation shortfall identically; benign missed-entry, no capital risk, no breaker trip).
- **F20** — polymarket-wallet.ts twin-parity for the additive `negativeRisk` reconcile field (refuted — the seam
  header's parity rule is scoped to field RENAMES + DROP-rules; an additive Node-only field is neither, and §17
  round-5 already pre-authorized `negativeRisk`/`mergeable`/`closed`).

### Convergence note (round 7 → applied) — operator re-opened the loop for more rounds
REAL across seven rounds: 28 → 21 → 18 → 19 → 9 → 14 → **16** (NOT monotone). Every round-7 CRITICAL (F1/F2/F3)
was a HALF-PROPAGATED round-6 edit, not a new design hole. The operator re-opened the loop ("push this a couple
more rounds to make the architecture file perfect before we build"), superseding the round-6 "loop closed"
decision. Round 8 re-ran the saved workflow over the round-7-fixed doc (below).

## §17 (round-8 review remediations — eighth pass)

An eighth 4-lens agent-team round over the round-7-fixed doc. **19 raw → 18 consolidated → 13 REAL / 0 UNCERTAIN /
5 FALSE_POSITIVE.** REAL ticked 16 → **13** with 4 CRITICAL — but the TEXTURE changed: TWO of the four (F2, F3)
are GENUINELY-NEW design holes no prior round caught (not propagation drift), so the lens is still finding
substance. All 13 REAL applied.

**CRITICALs:**
- **F1 (propagation) — a FOURTH stale `caps_exceeded_held`→breaker site.** manageFill's at-fill caps-breach error
  case still routed into the §17-F18 systemic breaker (round-7 F1 fixed only three sites + warned a copy
  re-introduces the regression). Routed to the `over_cap_halt` latch + once-on-transition CRITICAL; manageFill
  recorded as the fourth producer site.
- **F2 (NEW HOLE) — per-bucket venue identifiers dropped from the persisted schema.** `tokenYes`/`tokenNo`/
  `conditionId` from parseGammaEvent's ParsedBucket were never carried onto the capture buckets jsonb, threaded
  through selectEntries→EntryCandidate, or persisted on bot_positions — yet placement needs `tokenId` and
  redeem/`resolveMarketsMeta` need `conditionId` (exactly the F36b absent-row settlement path). `neg_risk` was
  meticulously threaded; the other two args of `redeem(conditionId, tokenYes, negRisk)` got none. Added them to
  the buckets jsonb + selectEntries input/output + a new `bot_positions.condition_id` column. Unaddressed across
  all 7 prior rounds.
- **F3 (NEW HOLE) — the Signer port has no holdings read; paper mode silently can't exit.** Every exit/close/
  settle path reads `fetchPositions` (venue-by-wallet-address), but it is not a Signer port method and
  createPaperSigner stubs nothing — so keyless paper reads 0 held → applyExit sizes the FAK to 0 (no exit ever
  books), winners book $0, and the Phase-5 net-PnL gate (the go/no-go for real capital) is corrupted. Added a
  mode-aware `getHeldShares(tokenId, conditionId)` to the port — live wraps fetchPositions, paper derives the
  synthetic entry-minus-exit SUM from the bot's own ledger — and routed every manager venue-held read through it.
- **F4 (NEW HOLE) — the bot reuses `notifySlack`, which the global pause SUPPRESSES by-kind.** `claim_alert`
  (0055) drops every kind not in `alerts_slack_allow_kinds` when paused (prod IS paused, WHALE_TRADE-only) AND
  doesn't record it for resend — so the two deadmen, exit_failed, the breaker, POL-low, and the daily kill would
  all be SILENTLY muted on live-prod config. Named the bot's CRITICAL kinds, made 0066 idempotently append them
  to the allowlist, and gated a paused-Slack test CRITICAL in §15 + GO-LIVE before the Phase-5 deadman is relied on.

**WARNINGs:** F5 — ADR-OC-12/OQ-4/R-7 still named `localDayWindow` for the time-stop (canonical is
`localHourInstant`; the §17-F43 rename only hit §6.1 — the same half-propagation F1 caught for the SL ternary);
unified to localHourInstant. F6 — §17-F46's redeem-idempotency log entry instructed booking against the
whole-wallet `getCollateralBalance` delta, which §6.6/round-6-F17 explicitly forbid; struck + tagged corrected.
F7 — applyExit's F11 entry-cancel didn't book a cancel-race straggler (unlike resumeExit/cancelRestingEntries) →
cost-basis under-count + a SUM(exit)>entry wedge; mirrored the ENTRY-ADOPT booking. F8 — the daily-loss "today's
realized loss" window wasn't pinned to `killDayTz` (the latch is) → cross-UTC-day desync (under-/false-latch);
pinned it. F9 — bot_close_position required `resolves_at` in the future even for a confirmed full flatten → a
late-but-complete exit was mis-booked as a held=0 loss; close on venue-0 AND SUM≈entry REGARDLESS of resolves_at
(an over-broad add-on from my own round-7 F7). F11 — Phase 0.5 (the decisive gate that authorizes Phases 2–6) had
a DoD but NO artifact; added `scripts/research/opening-spike.ts` (§6.13c) + a numeric `bot.spikeGoFrac` bar + a §15 gate.

**INFO:** F15 (post_only would-cross surfaces as a throwOnError THROW, not a returned status — specified the
signer's catch+classify); F16 (the three-contract approval over-spec'd a pUSD approve on the redeem-only
NegRiskAdapter — scoped pUSD approve to the two Exchanges, setApprovalForAll to all three; refines round-7 F3);
F17 (clockSanityCheck's 'CLOB server time' comparand has no SDK source — pinned to Supabase `now()` via the db
port, driver-run).

### §17 round-8 false positives (refuted — do not re-raise)
- **F10** — bot.* config keys carry no defaults / 0066 must seed them (refuted — the codebase resolves config in
  CODE via zod `.default()` + parseConfigRows merges DB overrides; the migration seed is a MIRROR + equality
  test, never the bootability source; the leaseTtlSec>tickWatchdogSec invariant is already a §15/F12 gate).
- **F12** — no autonomous terminal close for a never-filled maker entry (refuted — manageBrackets branch (1)
  routes a resolved market to resolveHeldPosition REGARDLESS of state at `resolves_at`, which CAS's the 0-share
  row to 'resolved', releasing the partial-unique slot; harm is only a per-tick poll until endDate, INFO at most).
- **F13** — no degraded-mode spec for a Supabase control-plane outage (refuted — the F19 external deadman alarms
  on stale bot_tick_log/gate_snapshot, exactly the outage symptom; reconcile-on-boot + the EXIT-RESUME arm resume
  frozen exits on recovery; an in-memory venue-only fallback would violate DB-as-source-of-truth).
- **F14** — §17-F36's round-2 'mergeable' void-detection clause is stale (refuted — superseded by §17-F36b /
  round-6 F7 / §6.6 under the doc's explicit 'AUTHORITATIVE over earlier text' + 'document, don't rewrite'
  convention; only an optional belt-and-suspenders annotation).
- **F18** — the seeded-fraction window (last 50 is_flat_open) may never fill (refuted — captures are PER-TICK,
  not per-listing, so each flat-opening market yields many is_flat_open rows; the window fills early, and a
  LIMIT-50 COUNT computes over whatever exists even before 50). [validates the round-7 F21 fix.]

### Convergence note (round 8 → applied)
REAL across eight rounds: 28 → 21 → 18 → 19 → 9 → 14 → 16 → **13**. Two of the four round-8 CRITICALs (F2 missing
venue ids, F3 no paper holdings read) were GENUINELY-NEW design holes the prior seven rounds never surfaced, so
round 9 was warranted. Round 9 ran (below).

## §17 (round-9 review remediations — ninth pass)

A ninth 4-lens agent-team round over the round-8-fixed doc. **18 raw → 16 consolidated → 10 REAL / 2 UNCERTAIN /
4 FALSE_POSITIVE.** **ZERO CRITICAL survived validation** (the one CRITICAL-tagged finding, F1, was DOWNGRADED to
WARNING) — and crucially, **zero genuinely-new design holes**: every finding is either (a) finishing the round-8
`getHeldShares` propagation, (b) a second-order effect of the round-7 depth-shortfall mark, (c) a half-propagated
prior fix, or (d) a bounded pre-existing edge needing an operator error. The propagation/wiring-precision tail. All
10 REAL + the 2 source-consistent UNCERTAIN applied.

**WARNINGs (mostly round-7/8-fix wiring):**
- **F1 (CRITICAL→WARNING) — the round-7 depth-shortfall mark vs the latched MTM kill.** The conservative-mark
  EXCLUSION from the CONFIRMED latch sum was justified by TRANSIENCE, but a thin bid is the structural NORM for
  this inventory — so sub-depth underwater drawdown could never PERSIST the latch (defeating ADR-OC-8's MTM kill
  for the bot's actual inventory). Added a `killLatchPersistTicks` K-consecutive-tick rule: a SUSTAINED
  conservative breach latches; a transient one still only soft-halts.
- **F2 — round-8 F3 `getHeldShares` propagation incomplete.** The boot/periodic RECONCILE path still read raw
  `fetchPositions` (→ 0 in keyless paper → paper restart-recovery silently broken), plus 3 stale Calls edges
  (resumeExit/manageBrackets/cancelRestingEntries). Routed reconcile through the mode-aware read + fixed the edges.
- **F4 — `reconcile.run` runs at boot BEFORE the lease.** reconcile can PLACE (EXIT-RESUME FAK) + redeem, and
  `exit_in_flight_until` is a per-process timestamp not a cross-process CAS → an operator double-start
  reconcile-FAKs concurrently lease-less. Acquire the lease BEFORE reconcile (boot + periodic).
- **F5 — `resumeExit`'s entry-cancel is by-id only.** An F40 ambiguous-'intent' phantom (no clob_order_id) isn't
  swept (cancelRestingEntries has the openOrders sweep; resumeExit, its sibling, didn't) → survives an operator
  flatten + fills post-cancel. Ported the openOrders heuristic sweep into resumeExit.
- **F7 — `clockSanityCheck` still declared INSIDE `interface Signer`** though round-8 F17 made it driver-run (the live
  signer has no db). Moved it to a driver function + fixed the round-5 F10 wording + the stale GO-LIVE comparand (F17-r10: the §17- prefix denotes the unrelated smoke-test/fill-accumulation remediations; these are round-local F-ids).
- **F9 — the redeem pre-guard called `getHeldShares` an "on-chain balance"** but it wraps the Data API indexer,
  which LAGS the chain in exactly the lost-redeem-response window the guard exists for → re-redeem REVERT churn.
  Switched the redeem-idempotency guard specifically to a true on-chain ERC-1155 balanceOf via viem.
- **F10 — the §15 DoD checklist was stale at round-7** (round-8's F1/F2/F3 ungated). Appended round-8 + round-9
  gates + the `condition_id`/`token_yes` schema gate.
- **F3 (UNCERTAIN, self-validated) — the held MTM didn't NET sold shares.** A partial-exit/dust_parked position
  counted GROSS original cost while the sold portion's recovery was unbooked until terminal 'closed' → phantom
  drawdown wedges entries (the F37 self-wedge via the partial-exit door). MTM now nets `entry_shares − Σexit_taker`.
- **F6 (UNCERTAIN, self-validated) — per-token attribution.** `getHeldShares(token)` can't split two of the bot's
  OWN positions on one `token_yes`; a 'failed'-with-holding frees the bucket slot → re-open → combined holding.
  Keep a 'failed'-with-possible-holding in the partial-unique/dedupe window until reconcile confirms it 0-held.

**INFO:** F14 (cancelRestingEntries Calls list missing openOrders + bot_fill_with_caps), F15 (§1 "2 scripts" → 3,
+ opening-spike.ts), F16 (the on-demand seed writes the SAME shared tables `/data` dash_data + run-calibration
read → tag bot-seeded snapshots + exclude them from the analytics consumers).

### §17 round-9 false positives (refuted — do not re-raise)
- **F8** — `updateBalanceAllowance` is gasful and makes the F33 viem bootstrap redundant (refuted — in both SDKs
  it is an L2-authed server-cache refresh that broadcasts NO tx; §16-A's reading is correct, the report's item-8
  wording is the imprecise side; a fresh wallet still needs the on-chain approvals F33 sets — no race).
- **F11** — the lease invariant should add `tickIntervalSec` (refuted — acquireLease (step 1) gates placeEntries
  (step 5) within the SAME tick, so a lapsed-then-reclaimed lease is a clean singleton HANDOFF, never two
  concurrent placers; the only co-place window is the watchdog-fired in-flight call, covered by the DB layer).
- **F12** — the `Signer.redeem(conditionId, tokenId, negRisk)` signature isn't build-ready (refuted — the redeem
  leg is explicitly out of build-ready scope: viem-composed, "verify against getContractConfig(137) before
  building", paper-first with a manual-sweep fallback; GO-LIVE §4 already gates the ABI pin).
- **F13** — `RawGammaMarket` omits `closed` so the void/loser branch can't read it (refuted — a TYPE confusion:
  the /markets path is parseMarketsMeta→RawGammaMeta→MarketMeta, not RawGammaMarket; §17-F36b already mandates
  extending MarketMeta with closed + settled price, and round-5 pre-authorized it as an additive field).

### Convergence note (round 9 → applied)
REAL across nine rounds: 28 → 21 → 18 → 19 → 9 → 14 → 16 → 13 → **10**. Round 9 LOOKED like convergence (0
surviving CRITICAL, 0 new holes), so round 10 ran as a confirming pass. Round 10 ran (below) — and broke that read.

## §17 (round-10 review remediations — tenth pass)

A tenth 4-lens agent-team round over the round-9-fixed doc. **23 raw → 17 consolidated → 14 REAL / 1 UNCERTAIN /
2 FALSE_POSITIVE.** REAL bounced 10 → **14** with **2 CRITICAL** — round 9's "clean" look was a FLUCTUATION, not
convergence. Two CRITICALs + several WARNINGs are genuinely-NEW substantive holes the prior 9 rounds never
surfaced; two are second-order effects of my own round-9 fixes. All 14 REAL + the F13 decision applied.

**CRITICALs:**
- **F1 — the OTHER horn of round-9 F3.** F3-r9 netted sold shares OUT of the held MTM (fixing over-statement),
  but the sold-at-loss leg of a partial-exit-into-dust position (the NORM on thin inventory) is then booked
  NOWHERE until terminal close → invisible to the daily kill all day → §9R-D 'down for the day' silently fails;
  and bot_resolve_position booked only the residual, dropping the sold proceeds from the F-OC-10 gate. Now CREDIT
  the sold proceeds in BOTH the kill realized sum (book partial-exit realized incrementally) AND resolution.
- **F2 (NEW) — the GO-LIVE gate's data path was unsound.** No RPC produced the FORWARD verdict panel (the loop's
  openingVerdict had no input — only the offline backtest's capture replay existed), AND bot_gate_snapshot had no
  backtest/forward provenance split (both write mode='paper') → an operator could fund real money off a backtest
  PASS while the forward run is still INSUFFICIENT. Added `bot_closed_market_panel` (aggregates closed paper fills)
  + a `source` column read forward-only by the capital gate.

**WARNINGs:** F3 (the exit_taker row WRITER was unwired — bot_close_position SUMs rows no RPC writes; added
`bot_record_exit_order`), F4 (the bot reused the GLOBAL `alerts_slack_paused` as its kill, but prod has it TRUE
for whale-noise → bot never places OR un-mutes everything; decoupled to `bot_enabled`), F6 (proxy-vs-EOA approvals
— the funder is a Polymarket PROXY but bootstrapApprovals specs direct EOA viem → first BUY/SELL reverts;
proxy-aware routing), F7 (no minimum-runway-to-time-stop guard → after-noon-listed lead-0 markets flatten
immediately at a loss; added minHoldRunwayMin), F8 (the maker→taker fallback had no entry-price re-gate → a
converged ask above the 20% cap gets taken; re-gate + FAK limit=cap), F9 (the OTHER horn of round-9 F4 — the lease
invariant bounds only one tick, not reconcile duration → lease lapses mid-reconcile; re-CAS during reconcile +
reconcileWatchdogSec), F10 (the first-N throttle was homed to functions that can't enforce it; moved to
placeEntries), F11 (the round-9 seed-tag-and-exclude was named but not buildable as clean reuse nor sequenced;
pinned the p_seeded mechanism + lifted the exclusions into the Phase-0 DoD), F12 (the live-signer smoke test specs
a 1-share order but the venue min is max(5sh,$1) → it can never rest → the survival test couldn't run; sized to
the floor).

**INFO:** F14 (DF-3 dropped cancel_maker_take + DF-4 still showed raw fetchPositions — synced), F15 (no retention
policy for the two append-only tables — added a 0066 prune), F17 (round-9 F7 narrative misapplied §17- prefixes —
corrected to round-local ids).

**UNCERTAIN → decision (F13):** tick step-5 dispatches cancelRestingEntries on benign over_cap_halt too; resolved
as INTENDED (a resting entry filling while over-cap deepens the breach, so pulling it is risk-conservative).

### §17 round-10 false positives (refuted — do not re-raise)
- **F5** — cancelRestingEntries stale-snapshot double-count/leak (refuted — §17-F45's round-7 PRECISION paragraph
  already adjudicates this exact step-3-armed vs step-5-cancel interaction as "Intended, not a hole").
- **F16** — pUSD→USDC off-ramp missing from GO-LIVE §6 (refuted — §6 is operator-level symmetric to §1's on-ramp,
  §17-F39 already resolved the realize-profits path, and the sweep-gas reserve is already in §6:73).

### Convergence note (round 10 → applied) — the loop is ASYMPTOTIC; recommend STOP + BUILD
REAL across ten rounds: 28 → 21 → 18 → 19 → 9 → 14 → 16 → 13 → 10 → **14**. **~160 validated findings resolved**
(Phase-9 3-pass + 10 team rounds). **The honest verdict: this loop does NOT converge to zero, and round 9's clean
pass was noise, not the asymptote.** Round 10 re-surfaced 2 CRITICALs — one a second-order effect of my own round-9
fix (F1←F3-r9), one a genuinely-new pre-existing hole (F2 gate plumbing) — plus several new substantive WARNINGs.
The REAL trajectory across rounds 5→10 (9→14→16→13→10→14) is a STATIONARY ASYMPTOTE, exactly as the round-6 note
predicted: a ~2,500-line real-money autonomous-bot blueprint under a 4-lens adversarial team yields real findings
indefinitely, because each fix adds surface and the lens has effectively unbounded depth on a money-safety-critical
spec. **RECOMMENDATION: STOP the review loop and BUILD.** The blueprint is extraordinarily hardened; the residual
is overwhelmingly the class a BUILD + its tests surface CONCRETELY and CHEAPLY — a builder writing applyExit hits
the missing exit-row writer in minute one (F3); the proxy-approval (F6) and redeem-ABI (round-9 F12) are already
gated "verify against the live SDK before building"; the smoke-test size (F12) fails on first run; the gate-panel
RPC (F2) is a Phase-3 deliverable. These need a compiler and a test, not another blueprint round. The build is
paper-first with hard downstream gates (Phase-0.5 spike, Phase-5 paper PASS, first-N review), so safety does not
hinge on the blueprint being literally perfect. **Per the operator's anti-cathedral standing guidance, the marginal
blueprint round is now lower-value than starting Phase 0.**
