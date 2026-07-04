# LIVE-RAIL night handoff — 2026-07-05 ~01:50Z (operator asleep; session /clear'd after this)

> **What this is:** the canonical brief source for the v9 night loop (`FASTTRACK-PLAN.md` §"The autonomous
> /loop prompt — v9"). The prior session's background agents DIED at /clear — everything needed to recover
> or re-dispatch them is IN THIS FILE. Boundary (unchanged, non-negotiable): **no capital, no keys, nothing
> live, 0082 stays DARK (apply is operator-gated), TRADE_MODE default never-live, never read `.env.local`,
> the daemon/smoke are BUILT not RUN, no new signal hunts.**

## Board as of the handoff

- `main == origin @ d071c62` — suite **155 files / 2479 tests green**, typecheck clean.
- **MERGED tonight (operator-authorized LIVE-RAIL slate, cycle log C45–C46):**
  - **T3** `742018d` — migration `0082_trading_activation.sql` **STAGED DARK** (trade_config + audit +
    trade_gate_override [expires_at ≤ 14d] + live_orders/live_fills + **7** `bot_order_*` RPCs +
    `trade_live_preflight()` interlock + shared `trade_today_realized_loss()` + `dash_trading()`).
    3 lens rounds → MERGE-CLEAN. 76 twin tests.
  - **T1** `c27e531` + seam fix `38a3148` — `packages/trading`: MakerExecutor (maker entry/TP,
    taker FAK SL/time-stop, cancel/reprice, partial fills), order-intent/order-ledger modules,
    dry-run writes mode-scoped ledger rows, `reconcileOpenOrders()` **STARTUP-ONLY** sweep,
    redaction, fail-loud parsers. 3 lens rounds (1 CRITICAL + 1 HIGH found → closed) → MERGE-CLEAN.
    107 trading tests.
- **Operator state:** `.env.local` populated (POLY_PRIVATE_KEY / POLY_FUNDER_ADDRESS / POLY_SIGNATURE_TYPE);
  wallet funded within the §9R envelope. He runs the smoke test in the morning.
- **Gate (last read 21:36Z snap 212):** INSUFFICIENT — 73 mkts / 34 cities / **6 of 7 days** (net −$160.05,
  makerFillRate 0.082, rebate $0, n_open 0). Day 7 = the FIRST 07-05-targeted position settling.
- **0081 thread:** gap-fill done+verified (C45). Remaining: the **07-05 10:00Z** `city-paper-trade` tick must
  show `stats.cities:4, placed>0` (cron-slot proof; then houston °F graded-day confirmation per C37).

## T2 recovery (cycle 1 of the night loop)

The prior session dispatched **t2-daemon** on branch `worktree-agent-acc5ba897c3517d45`
(worktree `.claude/worktrees/agent-acc5ba897c3517d45`), brief below. The /clear killed the agent mid-build.

1. `git log main..worktree-agent-acc5ba897c3517d45 --oneline` + inspect the worktree for the four
   deliverables (`scripts/trade-bot.ts`, `scripts/trade-smoke.ts`, decision-spine tests,
   `docs/ops/TRADING-ACTIVATION.md`).
2. **Complete-looking** (all four present, committed, suite green in the worktree) → treat as delivered:
   dispatch **t2-lens** (below) on the diff vs main.
3. **Incomplete or absent** → delete/ignore the stale worktree and **re-dispatch T2 fresh** (opus,
   worktree isolation, background) with the brief below **VERBATIM** (update only the base commit).

### T2 brief (verbatim; base main @ d071c62)

MISSION: build the live maker-exit trading DAEMON (`scripts/trade-bot.ts`) + the operator SMOKE script (`scripts/trade-smoke.ts`). The daemon runs LOCALLY on the operator's box (key in .env.local — you NEVER read that file's contents; reference env var NAMES only), drives the T1 MakerExecutor, and is governed by the T3 activation console. Default posture everywhere: dry-run; only TRADE_MODE=live + a passing trade_live_preflight() reaches a real post.

READ FIRST (all on your branch already): `packages/trading/src/` — types.ts (the port surface), live.ts (MakerExecutor + createClobClient seam + §15 invariant), order-ledger.ts (the 7-RPC contract header incl. startup-only reconcile + staleness + raise semantics), order-intent.ts (intent keys, redactText), tradeConfig.ts (loadTradeConfig/preflightLive/STAKE_CEILING_USD), gate.ts; `supabase/migrations/0082_trading_activation.sql` (Section-9 state machine table + preflight checks payload incl. lossWindowStart/openExposureUsd/perMarketExposureUsd); `MAKER-EXIT-SIM.md` (THE strategy source of truth — tuned config tp 0.12 / sl 0.20 / tstop 18h / chw 0 / maxEntryPrice 0.30 / depthFloorUsd 150 / makerWindow 30) and `packages/core/src/sim/opening-maker-exit-replay.ts` (the replay twin — REUSE its pure decision functions from core wherever importable rather than forking logic; where the live path must differ, document why); the seed path: consensusSource 'calibrated' (per POST-FABLE-HANDOFF steady-state + CONVERGENCE-TUNING 73.9% selector result); `OPENING-CONVERGENCE-HANDOFF.md` §9R (caps) + `GO-LIVE-CHECKLIST-OPENING.md` (operator-physical steps — your smoke script feeds its §); `packages/io/src/slack.ts` (alert idiom — note prod Slack is paused except WHALE_TRADE + deadman kinds; your alerts must use a kind that pages, or log CRITICAL locally + write a deadman-visible row — follow what the maker-exit paper loop's bot_deadman does in migration 0073).

DELIVERABLES:
1. `scripts/trade-bot.ts` — the daemon loop. STARTUP: resolveTradeMode (off → log + exit 0); loadTradeConfig via service creds (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env, the repo's script idiom); `danglingEnvelopeReady` boot probe (WARN once on false); `reconcileOpenOrders()` — STARTUP ONLY, never mid-run (contract in order-ledger.ts; runbook note: a crash+restart <5 min leaves a fresh dangling intent unadjudicated until it ages — safe, key stays reserved). MAIN LOOP per tick (configurable interval, default sensible for makerWindow 30): candidate discovery from the live Polymarket universe using the same event/market selection semantics as the replay twin (city allowlist from trade_config honored); ENTRY per the tuned config (first enterable tick semantics, maxEntryPrice 0.30, depthFloorUsd 150, calibrated seed for bucket selection); after entry fill → rest the maker TP (tp 0.12 above entry per the strategy's definition — read the replay for exact semantics), arm taker SL (0.20) and the resolvesAt−18h time-stop; makerWindow-driven reprice via executor.reprice. EVERY live placement: preflightLive() first (per-placement, gate.ts idiom) + runner-side per-market ($40) and total-concurrent ($100) cap enforcement from the preflight checks payload + stake from config (default $10). record_* raises → catch-and-alert (the ledgerWriteOrAlert pattern — never suppress, never free). Heartbeat: a periodic structured-log line + whatever cheap row the 0073 deadman idiom expects for a bot heartbeat — if a new DB surface would be required, do NOT create it; log-only and FLAG it in your report. RESTART-SAFE: all position/order state from the ledger + venue, never memory-only. Graceful shutdown (SIGINT): do NOT cancel resting orders (maker orders are the strategy); log open state loudly.
2. `scripts/trade-smoke.ts` — the operator's credential smoke, ALWAYS safe by default: step 1 derive CLOB API creds from POLY_PRIVATE_KEY (via the createClobClient seam; NEVER print key material — print only 'derived OK' + the api key uuid prefix), step 2 verify funder/signature-type (an authenticated read — e.g. open orders or balance-allowance endpoint — reporting 'funder recognized' or the venue error REDACTED), step 3 dry-run order build for a real current market (print the exact would-be payload, redacted). A `--live-smoke` flag (default OFF) additionally places ONE 1-share maker order far from the market (e.g. 2¢ on a cheap bucket) and cancels it immediately, printing both acks — document in the header that this flag is operator-run only and costs nothing but proves the write path. The script must refuse --live-smoke unless TRADE_MODE=live AND trade_live_preflight passes OR an explicit --i-know-no-preflight escape is given WITH a warning (smoke precedes gate PASS by design — document that this bypasses the gate for a 1-share cancel-immediately probe only).
3. Tests: the daemon's decision spine as pure functions (tick → intents) unit-tested against fake executor/ledger/preflight/book fixtures — entry gating (maxEntry/depth/allowlist/caps/preflight-block), TP/SL/time-stop arming and firing, reprice window, restart resume (ledger rows → resumed state), off/dry-run never posting, record_*-raise routing. NO network in tests. Suite + typecheck green.
4. `docs/ops/TRADING-ACTIVATION.md` — the operator runbook: the three env vars (names only), mode ladder off→dry-run→live, what each cap does, the preflight interlock + override (14d cap), the smoke procedure, daily-loss kill semantics (realized-at-sell, UTC window), the two ops notes (staleness×restart interaction; orderId-bearing stuck rows need manual ops — how to inspect via dash_trading/live_orders), incident playbook (kill = set mode off via trade_config_set; resting orders then need manual cancel — give the SQL/steps), and the §9R boundary restated (operator funds/keys/first-N review; Claude never trades).

HARD CONSTRAINTS: no new runtime deps; no migrations/DDL (0082 is FINAL — if you need another surface, FLAG it, do not build it); never touch any live DB or venue from THIS build (tests are fixture-only; the smoke script is built but NOT run); §15 stays intact (client/key only via live.ts); never echo secrets; the daemon must be inert (clean exit) when TRADE_MODE is unset. Commit to your worktree branch.

REPORT: file inventory + LOC, the tick state machine (one table: state × event → action), how much replay logic you reused vs forked (with why), the heartbeat/deadman decision, any flagged gaps, test count, suite/typecheck status.

### t2-lens brief (adversarial review; fresh opus agent, background)

Review the T2 worktree diff vs main. This code decides when REAL ORDERS get placed. Priorities:
(1) NO path reaches a venue post without mode='live' AND a passing preflight — walk every call chain into
MakerExecutor.place/placeTaker; (2) runner-side cap enforcement per placement (per-market $40 / total $100 /
stake ≤ config ≤ $25) — construct a sequence that overshoots a cap (concurrent intents same tick?);
(3) restart-resume correctness — ledger rows → resumed positions/orders with no double-arming of TP/SL and no
re-entry on an open position; (4) reconcile is STARTUP-ONLY and the boot probe WARNs on absent RPC;
(5) smoke script safety — default path keyless-safe (no order posted), --live-smoke guards, no secret echo
anywhere (run the §15 invariants + grep the diff); (6) decision-spine fidelity vs the replay twin (entry/TP/
SL/time-stop semantics match MAKER-EXIT-SIM.md's tuned config — flag ANY divergence not documented);
(7) tests actually falsify (delete-the-guard thought experiments). Report findings ranked w/ file:line +
scenario; verdict MERGE-CLEAN or FINDINGS. Protocol below governs rounds.

## Integration protocol (proven tonight; reuse verbatim)

lens → adjudicate (fix real, waive cosmetic with stated reason) → amendment on the same branch →
delta re-lens (scoped) → **stop on MERGE-CLEAN** (cap ~3 rounds; if not converging, HOLD the merge and leave
the branch + a cycle-log note for the operator) → merge to main (resolve barrel conflicts by keeping all
exports; **suite + typecheck green on the merged tree**; push) → cycle tick in FASTTRACK-PLAN.md.

## T4 / T5 / T6 briefs (dispatch after T2 merges; T4+T5 parallel opus worktrees, lens each)

- **T4 — `/trading` dashboard:** new page in `apps/web` off `dash_trading()` (RPC-only, the /maker-exit
  idiom; NOTE the RPC is operator-guarded — same auth path as /maker-exit): mode + caps + preflight state
  (incl. override w/ expiry), today's realized loss vs kill, open orders/positions from the checks payload,
  order/fill log, dryRun counts. Terminal-glass idiom, shared DashNav. **The page must render an explicit
  "0082 NOT APPLIED" empty-state** (RPC absent → graceful). Tests per the existing page-test idiom.
- **T5 — shadow-diff harness (BUILD-ONLY tonight):** `scripts/research/trade-shadow-diff.ts` — reads the
  dry-run bot's ledger rows (mode='dry-run') + the maker-exit paper loop's replay decisions over the same
  window and diffs them (entry chosen y/n, bucket, price, exit kind, timing) → a divergence report (table +
  summary stats). Pure read-only analytics; **cannot RUN until 0082 is applied and the daemon has dry-run
  rows — build + fixture-test only.** Divergences are the bugs the shadow week exists to find.
- **T6 — docs wind-down (orchestrator-inline at slate end):** CLAUDE.md pivot-block ↳ UPDATE line (LIVE-RAIL
  built, 0082 dark, boundary intact, gate unchanged) + BUILD-STATE addendum + POST-FABLE "what changed" line.

## Seam contracts (final — do not re-negotiate)

- 7 RPCs: `bot_order_by_intent(p_intent_key, p_mode)` · `bot_order_reserve_intent(p_mode, p_intent_key,
  p_client_order_id, p_market_id, p_token_id, p_side, p_purpose, p_order_type, p_price, p_size, p_trade_date)`
  → 'reserved'|'exists' · `bot_order_list_dangling(p_mode, p_older_than_min DEFAULT 5)` → `{rows:[...]}` ·
  `bot_order_record_placed/fill/canceled/failed(p_client_order_id, …)`. ALL record_* RAISE on unknown
  client_order_id; terminal-row echoes silent; fill-on-intent promotes; `p_size_matched` CUMULATIVE;
  single-L `canceled`; venue `expired` folds into canceled; `record_canceled` preserves size_matched.
- `TradeMode` canonical in `packages/trading/src/types.ts` (tradeConfig re-exports it — keep it that way).
- Reconcile: STARTUP-ONLY; ambiguity/evidence-failure HOLDS; only no-open-order + no-trade frees.
- Daily-loss kill: realized-P&L-at-sell, UTC window, shared `trade_today_realized_loss()` — both consumers.

## Operator morning items (the wind-down summary must END with these)

1. **Apply 0082** (one MCP `apply_migration` + the §-verify SQL in the migration header) — unlocks the
   dry-run ledger, `/trading` data, and the shadow harness. Operator-gated; NOT pre-authorized.
2. **Run `scripts/trade-smoke.ts`** (keyless-safe by default) — proves creds/funder/signature-type.
   Optionally `--live-smoke` for the 1-share place+cancel write-path proof.
3. **Start the dry-run daemon** (`TRADE_MODE=dry-run pnpm tsx scripts/trade-bot.ts`) after 0082 — begins the
   shadow week that T5 measures. No capital exposure in dry-run.
4. **Gate label** (~07-05): KILL → already recorded by the loop (pre-authorized). **PASS → the §9R
   capital-scope decision — the ONLY capital decision, operator-physical.**
5. Optional: convergence cron offset `2,17,32,47 * * * *` (staged recommendation, still open).
