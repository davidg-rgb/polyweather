# GO-LIVE CHECKLIST — Opening-Convergence Bot

> The paper → real → scale operator runbook for the `opening-bot` rail. **Authoritative home** for the funds
> lifecycle (F39), the on-chain approval bootstrap (F33), the negRisk redeem mechanism (F14c), the POL-gas buffer
> (F14b), clock-sync (F21), the secrets rotation/incident runbook (F30), and the process supervisor (F22).
> Read with `ARCHITECTURE-OPENING-CONVERGENCE.md` (§14 roadmap, §16/§17 corrections) and `OPENING-CONVERGENCE-HANDOFF.md`.
>
> **Boundary (NON-NEGOTIABLE — ADR-OC-11 / §8):** Claude builds the software. **The operator funds the dedicated
> wallet, holds the signing key in `.env.local`, and authorizes runs.** Claude never places a trade, never
> handles `POLY_PRIVATE_KEY`, never touches credentials. Nothing in this checklist is performed by Claude.

---

## 0. Hard gates (do not skip — money is downstream)

The rail is **paper-default**. Real capital is blocked until BOTH:

1. **Phase 0.5 = GO** — the signal-availability spike confirmed a usable `house_gaussian` coincides with a still-flat book (else the lever KILLs cheaply; `ARCHITECTURE` §14 Phase 0.5).
2. **`openingVerdict` = PASS** — ≥40 closed paper markets, city-clustered 95% CI excluding 0, zero-skill MC <5% (`ARCHITECTURE` §9R-E / ADR-OC-10). Read it on `/bot`.

Only then proceed to §1–§5 below. **Order matters: fund → approve (on-chain) → smoke test → first-N → scale.**

---

## 1. Deposit / onboarding (F39) — before the first live order

Done once, by the operator, on a **dedicated, separately-funded** Polymarket wallet (F-OC-13). The bot only ever
sees this wallet's key.

- [ ] **Create the dedicated Polymarket wallet** (proxy-wallet creation + accept Polymarket ToS). Do NOT reuse a personal wallet.
- [ ] **Acquire pUSD collateral under CLOB V2** (§16-A — pUSD is the V2 collateral, `0xC011…E82DFB`): bridge/swap USDC → pUSD on Polygon as the venue requires. Start small ($100–200, §9R-A).
- [ ] **Top up POL gas** (F14b/F33): the wallet needs POL for the one-time approvals (§2) + every on-chain redeem (§4). Fund a buffer above the redeem/approval cost floor; the boot/periodic bankroll read Slack-CRITICALs below it.
- [ ] **Place `POLY_PRIVATE_KEY` in `.env.local` on the VPS** (guard-secrets hook protects it). Never paste it into chat, a commit, or a log. Also set `POLY_SIGNATURE_TYPE` / `POLY_FUNDER_ADDRESS` as needed.
- [ ] **Post-fund verify:** `Signer.getCollateralBalance()` returns the expected free pUSD (a pUSD ERC20 `balanceOf` the funder via `getContractConfig(137).collateral` — NOT an SDK method, F18), and `getContractConfig(137)` returns the V2 addresses + pUSD.

## 2. On-chain approval bootstrap (F33) — one-time, gas-funded, BEFORE `tradingMode=live`

`updateBalanceAllowance` is only a gasless server-side cache refresh — it is **NOT** a substitute for a real
on-chain approval (F33 corrects §16-A's "never raw approve()"). A brand-new wallet has none, and the first live
SELL exercises the CONDITIONAL allowance (the R-4 time-stop flatten), so set these BEFORE going live:

- [ ] **pUSD ERC20 `approve`** to **both** the V2 CTF Exchange (`0xE111…996B`) **and** the NegRisk Exchange (`0xe222…310F59`), via viem from the signer. Idempotent (skip if already max).
- [ ] **CTF `setApprovalForAll`** (CONDITIONAL) to **all three** — the V2 CTF Exchange, the NegRisk Exchange, **AND the NegRiskAdapter** (the redeem contract, pinned from `getContractConfig(137).negRiskAdapter`, NOT the NegRisk Exchange — F8: without `setApprovalForAll(NegRiskAdapter)` the first live winning redeem reverts and winnings strand, R-16). Idempotent.
- [ ] The signer also **ensures the CONDITIONAL approval idempotently at ARM time** (when a position becomes `armed`), outside the time-critical `applyExit`, so a flatten never blocks on a first-time approval.
- [ ] Boot/periodic balance read verifies **all three** approvals (incl. the NegRiskAdapter) + POL headroom; Slack-CRITICAL if unset.

## 3. Live-signer smoke test (F17 / §17-F17) — zero-cost dress rehearsal, gates first-N

- [ ] `createOrDeriveApiKey` + `getOpenOrders`/`getOrder` round-trip (proves L1/L2 auth + the reconcile read).
- [ ] `updateBalanceAllowance` **dry call for BOTH `COLLATERAL` and `CONDITIONAL`** (the sell-side allowance is otherwise first hit on a real SL/time-stop exit — the R-4 path).
- [ ] **Order-survival-without-session check (closes F2 / §16-F):** place a **`post_only` GTC ≥ `max(5 shares, $1 notional)` (the venue floor — a 1-share order is rejected and can't rest, F12-r10; e.g. 5 sh @ ≥$0.21) far from market with NO websocket session**, leave it **resting >2 min**, confirm via `getOpenOrders()` it is **still `live`**, THEN `cancelOrder`. (The 5s `heartbeat` is only for the OPTIONAL WS fill-feed, not a prerequisite for resting orders.)
- [ ] Gate `tradingMode=live` + `bot_enabled=true` on this whole test passing.

## 4. Resolution / redeem verification (F14c) — first resolved position

- [ ] Confirm `Signer.redeem` **branches on the position's `negativeRisk` flag**: weather markets are **negRisk winner-take-all**, so a winner redeems via the **NegRiskAdapter** — plain Gnosis CTF `redeemPositions` **reverts** on a negRisk position and would strand winnings (R-16).
- [ ] **Pin the actual NegRiskAdapter address** (NOT the NegRisk *Exchange* `0xe222…310F59`, a different contract) — verify it against `getContractConfig(137)` / the V2 contract list before relying on automated redeem.
- [ ] Confirm `bot_resolve_position` books the **actual settled pUSD** (WIN/LOSS/**VOID** branches, F36 — never a forced $1/$0), and that void/ambiguous markets are excluded from the `openingVerdict` gate panel.
- [ ] Until the automated redeem is verified, a resolved winner may be a **manual pUSD sweep** — but the terminal value is always booked so a position never retries a vanished book.

## 5. First-N review → full auto → scale (ADR-OC-13 / §14 Phase 6–7)

- [ ] The first ~10 live entries place **immediately within caps** (the flat-open edge can't wait for a click — W5); each fill surfaces a Slack `ACTION` + a `/bot` row with a one-click **halt/flatten** (`bot_flatten_position`). At most **one un-reviewed live position open at a time** (W5b).
- [ ] Each first-N fill logs **paper-predicted vs realized** fill (F31 calibration). Relax the throttle / raise caps only if live-realized net edge **tracks the paper model within tolerance** — not merely aggregate +EV.
- [ ] Verify a kill (`bot_enabled=false`) halts **placement** within one tick (F4-r10: the bot kill is `bot_enabled`, decoupled from the global `alerts_slack_paused` whale-noise gate so the Phase-5 paper run can proceed while prod keeps alerts paused) while **exits/management keep running** (the latched daily-loss kill, F32, also only gates new entries).
- [ ] **Scale or kill (Phase 7):** raise caps only if live-realized net edge holds ≥2 weeks AND tracks paper (F31); else KILL → rail DORMANT + update `FINDINGS.md`.

## 6. Routine profit-sweep / withdrawal (F39)

Distinct from the §7 emergency drain. The system's goal is net profitability, so realize it:

- [ ] On a cadence, move settled pUSD above the working balance OUT of the dedicated wallet to a designated address.
- [ ] Keep a POL-gas reserve for the sweep txns (its own budget, separate from the redeem/approval gas).
- [ ] Re-verify `getCollateralBalance()` + caps denominator after each sweep.

## 7. Secrets rotation + incident runbook (F30 / R-8)

A leaked `POLY_PRIVATE_KEY` guards a **funded** wallet — re-issuing CLOB creds is **insufficient, funds must move**:

- [ ] **Emergency (suspected key exposure):** instant `bot_enabled=false` → **DRAIN** the dedicated wallet's pUSD + positions to a cold address → new wallet/key → re-derive CLOB V2 creds → re-run §1–§3.
- [ ] **Routine rotation:** `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `SLACK_WEBHOOK_URL` on a schedule.
- [ ] (The project has a prior key-exposure precedent — treat any secret that touches a chat/transcript as compromised and rotate.)

## 8. Operations (F21 NTP + F22 supervisor)

- [ ] **NTP** (systemd-timesyncd / chrony) running on the always-on VPS — the local-noon time-stop depends on accurate wall-clock. A startup + periodic clock-sanity check (local `now()` vs Supabase `now()` via the db port — the V2 SDK exposes no server-time endpoint, §17-F17) halts **placement** (not exits) on excess drift.
- [ ] **Process supervisor** (systemd / pm2) with auto-restart that **re-runs `reconcile` on boot** (F22) — never trade before reconcile completes.
- [ ] **Structured JSON logger** (level-tagged, **key-redacted by construction**, stdout + rotated file).
- [ ] **Deadman alerts armed:** `bot_deadman_check` (loop liveness, F19) **and** `capture_deadman_check` (capture-pipeline staleness + seeded-fraction collapse, F35) — both Slack-CRITICAL.
- [ ] **Slack allowlist (F4-r8):** the bot's CRITICAL kinds (BOT_DEADMAN/CAPTURE_DEADMAN/EXIT_FAILED/CIRCUIT_BREAK/POL_LOW/DAILY_KILL) are in `alerts_slack_allow_kinds` (appended by 0066); fire a test CRITICAL of each while `alerts_slack_paused='true'` and confirm it reaches Slack — else the global pause silently mutes every bot safety alarm (the deadmen, exit_failed, the breaker, POL-low, the daily kill).

---

### Gate summary (the one-line order)
**Phase 0.5 GO → ≥40-market paper PASS → fund (§1) → on-chain approvals (§2) → smoke test incl. resting-survival (§3) → first-N post-fill review (§5) → scale-or-kill (Phase 7).** No capital crosses a gate that has not passed.
