# REWARD-FARMING-HANDOFF — REC-8: is forecast-free liquidity-reward farming on weather net-positive?

> **Authored 2026-06-24.** The next-session execution package for **REC-8**, opened by the REC-4 trigger
> (`MAKER-REBATE-HANDOFF.md` §9): on 2026-06-24 the liquidity-rewards monitor found that **Polymarket has
> turned on FUNDED liquidity rewards on weather markets** (395/396 temperature markets in the CLOB
> `/sampling-markets` pool, real USDC daily rates). Liquidity rewards pay for **resting orders near mid
> regardless of fill or outcome** — the first **forecast-free, selection-free** income path this whole
> investigation has surfaced, orthogonal to every falsified signal. REC-8 is the **economics analysis**
> that decides whether it is net-positive *after risk* — and therefore whether it is worth building a
> market-making bot (a much bigger, separate step, gated on a REC-8 PASS).
>
> Read first: this doc, `MAKER-REBATE-HANDOFF.md` §9 + §2 (the reward/fee reference), `FINDINGS.md` (the
> "material update" + the efficiency verdict it does NOT contradict), `WALLET-RECON-HANDOFF.md` §12 +
> `BADATMATH-REPLICA.md` (the adverse-selection tax — the cost side), and the live code:
> `core/polymarket/rewards.ts`, `scripts/reward-monitor.ts`, `core/sim/maker-spray.ts` (the fill model).

- **Branch:** continue on `feat/maker-rebate-economics` (or a fresh `feat/reward-farming` off main after PR #5
  lands). **State at handoff:** typecheck 0, suite **1204 green**. REC-3 ingest + REC-4 monitor committed
  (`bc08cb6`). Live rail **DORMANT**; `packages/trading` not imported by any research.
- **Posture:** analytics/economics study FIRST. REC-8 ships no bot, no live orders, no rail flip. A PASS is
  what *justifies* designing the market-making system; it is not that system.

---

## 0. TL;DR

1. **The opportunity is real and new:** funded liquidity rewards on ~all weather temperature markets, paid for
   *resting near mid regardless of outcome*. Forecast-free. This did not exist on this universe before 2026-06-24.
2. **But "daily_rate" is a POOL, not your income.** Each market's advertised `rewards_daily_rate` (e.g. Madrid
   226/day) is split across all qualifying makers by Polymarket's liquidity-score formula. **Your earnings =
   your score ÷ everyone's score × pool.** The denominator (competing pro-MM liquidity) is the dominant unknown.
3. **Rewards are GROSS; fills are the COST.** Resting near mid means you get filled — adversely (the §12 / replica
   finding: adverse-selection tax ≫ spread tax). REC-8's whole job is **reward income − adverse-selection /
   inventory cost vs a pre-registered bar.** Unlike §12 (one-sided cheap-longshot resting), this is **two-sided
   market-making** near mid — a *different* cost model; do NOT just reuse §12's number, reuse its fill *mechanism*.
4. **Honest prior: guarded.** Shared, formula-scored pools on liquid markets are crowded by professional MMs
   (the REC-7 "crowded" caveat, now on-universe). The realistic reward *share* for a small operator may be tiny;
   the net of adverse selection may be ≤ 0. The deliverable is the measured answer either way (WO-5 discipline).
5. **Two data gaps to fill first** (neither exists today): (a) per-market **reward rates over time**, (b) **book
   depth near mid** (we store only best bid/ask/mid, not size-at-levels — the reward score needs depth).

---

## 1. The question, precisely (and why it is not any prior angle)

Every falsified signal was about **being right** — predicting Tmax (forecast levers), picking the bucket
(KILL-GATE 2, §12 maker-spray, m7 selector), or copying a sharp's outcome bets (§11/§14). **Liquidity rewards
pay you to provide liquidity, not to be right.** You quote two-sided near the mid, the exchange pays you a share
of a daily pool for the quality/size/uptime of those quotes, and your P&L is reward income + realized spread −
adverse selection on fills − inventory mark-to-market. The forecast is irrelevant to the *reward*; it might still
help *manage inventory* (a secondary use, not the thesis). So REC-8 is genuinely orthogonal to FINDINGS' closed
thesis — it is a market-making economics question, opened by a real exchange-side change.

**REC-8 PASS-question:** does a *realistically-achievable* reward share, net of the adverse-selection + inventory
cost of the fills it implies, clear a pre-registered net-yield bar on capital deployed — out-of-sample / forward?

---

## 2. What is now known (the reward program, from the live data + docs)

From the live `/sampling-markets` (REC-4, 2026-06-24) and the Gamma config (REC-3):
- **Funded:** 395/396 temperature markets carry `rewards.rates = [{ asset: USDC 0x2791…, rewards_daily_rate: N }]`,
  `min_size: 50`, `max_spread: 4.5` (¢ from mid). Daily rates observed 3–226 USDC/market/day.
- **Fee side (REC-3, per `market_buckets` once backfilled):** `feeType weather_fees`, `feeSchedule {rate 0.05,
  takerOnly true, rebateRate 0.25}` — makers pay no taker fee and earn the 0.25 rebate on fills (the §12 fix).
  So a maker's fill economics here are *better* than §12's conservative model assumed.
- **The scoring formula (READ THE LIVE DOCS — do not hardcode a stale one):**
  [docs.polymarket.com/market-makers/liquidity-rewards](https://docs.polymarket.com/market-makers/liquidity-rewards).
  The known shape: a per-order score rewarding **closeness to mid** (a spread-utility that decays to 0 at
  `max_spread`), **size**, **time-live**, and **two-sidedness**; mids `<0.10`/`>0.90` require double-sided quotes
  to earn anything (most weather cheap-longshot buckets are `<0.10` — directly relevant). Per epoch, maker
  share = maker qScore ÷ Σ qScore. **Get the exact current formula + epoch length from the docs before modelling.**

---

## 3. The two data gaps to fill FIRST (Phase A)

Neither exists in the DB today; REC-8 cannot be measured without them.

1. **Per-market reward rates over time.** REC-3 captures `rewardsMaxSpread/MinSize` from Gamma but NOT
   `rewards.rates` (that is CLOB `/sampling-markets`-only). Add a small periodic capture: either a
   `market_rewards` snapshot table (condition_id, captured_at, daily_rate, min_size, max_spread, funded) fed by a
   thin job wrapping `scanWeatherRewards`, or extend the REC-4 monitor to persist. Cheap, additive, deploy-gated.
2. **Book depth near mid.** `market_snapshots` stores only `best_bid/ask/mid/last_trade` — the reward score needs
   **size at levels within max_spread** (yours and total). `poll-markets` already fetches full CLOB `/book`s
   (it computes best-quotes from them) but discards depth. Capture the near-mid depth (e.g. total size within
   ±4.5¢ of mid, per side) so the reward-share denominator (competing liquidity) and our hypothetical score are
   estimable. Without this, reward share can only be assumed, not measured — state that limit loudly if you skip it.

---

## 4. The model (Phase B–C) — reward income MINUS the fill cost

**B. Reward income (gross).** Under the live scoring formula, for a hypothetical resting strategy (size S two-sided
within max_spread at chosen offsets), estimate our per-epoch qScore and divide by (our qScore + observed total
competing qScore from book depth) × the market's daily pool. Sum across the weather universe and over the day.
The dominant sensitivity is the **competition denominator** — sweep it (optimistic: we are alone; realistic: pros
dominate; report both, headline the realistic).

**C. The fill cost (the part that can sink it).** Resting near mid WILL fill. Reuse `core/sim/maker-spray.ts`'s
fill model (`simulateFill`, ask-touch from the real `market_snapshots` series) — but **two-sided**: we quote both
a bid below mid and an ask above mid, so model fills on BOTH legs and the resulting inventory. Net the realized
maker fill P&L (with the `weather_fees` rebate, `makerNetEvPerDollar` rebateRate 0.25) + inventory mark-to-market.
The §12/replica adverse-selection tax (filled-hit ≪ all-eligible-hit; replica tax 32.8pp) is the *warning*: fills
land preferentially on the wrong side. **Net = reward income + realized spread + rebate − adverse-selection loss −
inventory risk.** If reward income does not exceed the fill cost at a realistic share, REC-8 fails.

**D. The verdict.** Pre-register (BEFORE running, WO-5) a **net-yield bar on deployed capital** (e.g. net P&L /
capital-at-risk ≥ X% annualised, with the realistic competition denominator, CI lower bound > 0) + a zero-skill /
no-edge null + stability across the competition sweep. PASS → the economics justify *designing* a two-sided MM bot
(a new, separate spec — NOT built here). FAIL → forecast-free farming is uneconomic for us; record it, rail dormant.

---

## 5. Reuse map (do not reinvent)

- `core/polymarket/rewards.ts` (`scanWeatherRewards`, `isWeatherMarket`, `isFunded`) — the funded-pool detector.
- `scripts/reward-monitor.ts` — the live `/sampling-markets` pager (extend it to persist rates for Phase A).
- `core/sim/maker-spray.ts` (`simulateFill`, `makerEntry`, `makerNetEvPerDollar` with rebateRate 0.25) — the
  fill + maker-EV mechanism; generalise to TWO-SIDED for REC-8.
- `core/sim/stats.ts` (`bootstrapMeanCi`, `meanConfidenceInterval`) + `core/sim/selector-learn.ts`
  (`clusterMeanTCi`, the cluster-mean t-interval) — honest CIs; cluster by weather-day if the data stays few-day.
- The maker-spray loaders in `scripts/research/maker-spray-feasibility.ts` (`loadBucketSeries` etc.) for the book
  series; REC-3's `market_buckets` fee/reward columns once a discover re-run / backfill populates them.
- `packages/io/src/http.ts` `fetchJson`; CLOB base `https://clob.polymarket.com`.

---

## 6. Phased plan (each phase a commit; stop + report at each gate)

- **Phase A — data (deploy-gated):** persist reward rates over time + near-mid book depth (§3). Pure parsers +
  a thin job/script + a migration; tests. Without A, B/C are assumptions, not measurements.
- **Phase B — gross reward-income model:** the scoring-formula estimator + the competition-denominator sweep.
- **Phase C — net-of-fill economics:** two-sided fill + inventory cost via the maker-spray mechanism; the net.
- **Phase D — pre-registered verdict:** frozen net-yield bar + null + competition-stability; PASS/FAIL.
- **(Only on PASS) Phase E — a SEPARATE spec** for the two-sided MM bot (continuous quoting, inventory caps,
  cancel/replace, the live rail). Do NOT start E without an explicit operator go — it reactivates real money.

---

## 7. Guardrails

- **Live rail DORMANT.** REC-8 is analysis on captured data. No `tradingMode` flip, no `execute-bet`, no resting
  real orders, no `packages/trading` import in research. A PASS *enables a decision to design* a bot; it is not one.
- **WO-5 discipline:** write the net-yield bar + kill-criterion BEFORE seeing the number; report the competition
  sweep + a no-edge null; prefer a low-variance, honestly-clustered CI (cluster-mean t if days stay few).
- **Honest competition realism:** the headline must use the *realistic* (pros-dominate) reward share, not the
  alone-in-the-market ceiling. Report the ceiling for context, never as the verdict.
- **Crowding prior:** professional liquidity-reward farming is a known, competitive business; a small operator's
  net-of-adverse-selection edge is the open question, and the prior is guarded. Do not sink unbounded effort if
  Phase B's realistic share × the pool is already below the Phase C fill cost — that is an early, valid kill.

---

## 8. Git / build state at hand-off

```
branch feat/maker-rebate-economics (PR #5 → main, open)
  bc08cb6  feat(rec3,rec4): per-market fee/reward ingest + liquidity-rewards monitor — weather rewards FUNDED
  1a3aed7  feat(rec1): selector-learnability → INSUFFICIENT_DATA
  d6653cf  docs(maker-rebate) hand-off …  (+ d746316 §12 rebate, 19b02a5 m6)
typecheck 0 · suite 1204 green · live rail DORMANT
```
**Note for the next session:** a parallel **whale-watcher** feature is in flight on the SAME working tree
(`packages/io/src/polymarket-wallet.ts` + `supabase/functions/_shared/polymarket-wallet.ts` global-trade-feed
additions + `research/dataapi-trades-whales-sample.json`). It is the operator's separate build — **do not commit,
revert, or be alarmed by it.** Stage only REC-8 files explicitly.

**First moves next session:** (1) read the live liquidity-rewards docs for the exact current scoring formula +
epoch; (2) Phase A data capture (reward rates + near-mid depth); (3) pre-register the Phase D bar; then B→C→D.

---

## 9. FIRST-PASS RESULT (run 2026-06-24) — PASS-per-criterion, but NOT actionable; the real test is empirical

**Built (pure + tested + live):** `core/sim/reward-farming.ts` (the docs-verbatim scoring formula —
`spreadScore` S(v,s)=((v−s)/v)², `sideScore` size-weighted, `makerQmin` two-sidedness rule incl. the
strict <0.10 regime + the /c=3.0 single-sided penalty, `rewardShare`, `estimateMarketEconomics`,
`summarizeUniverse`, the frozen `rewardFarmingVerdict`) + `test/reward-farming.test.ts` (28 tests) +
`scripts/research/reward-farming-firstpass.ts` (live `/sampling-markets` + batch `/books` pull → the
universe economics + κ×φ×τ×capital sweep + verdict). 1284 tests green; typecheck 0; nothing shipped;
`packages/trading` never imported; rail DORMANT. Reproduce: `pnpm tsx scripts/research/reward-farming-firstpass.ts`.

**The pre-registered criterion FIRED PASS** (frozen §4.D / module header, before the number was seen):
- 469 funded weather markets, total pool **~$31.4k/day** (live, 2026-06-24).
- REALISTIC corner (κ=1 aggregate-book competition, capital $100/mkt, restOffset 1c, φ=0.5, τ=0.05, rebate 0.25):
  per-market net **mean $28.10 [95% CI $24.25, $32.56], median $12.54, 100% of markets net-positive** →
  PASS (mean>0, CI LB>0, median>0). Net stays positive across **every** sweep corner — even the pessimistic
  adverse-selection tail (τ=0.328, the replica tax) holds **+22%/day**; fills do NOT erase it in the model.

**Why the PASS is NOT actionable (the honest caveat — do not deploy capital on this):** the result is
load-bearing on TWO unverified assumptions, and the magnitude is too good to be a standing forecast-free return:
1. **The advertised `rewards_daily_rate` is assumed paid in full.** A 7.5–29%/day forecast-free yield on a
   public exchange would be the best trade in DeFi; the crowding prior says it can't be a *standing* return.
2. **The decisive diagnostic — the thin-book paradox check:** ~**$420k of maker capital is ALREADY resting
   in-band** across the universe (not a green field). If that existing capital alone split the pool, the
   implied gross yield is **7.48%/day** — STILL implausibly high. Two readings, opposite, unresolved by a snapshot:
   (a) **real-but-ephemeral** — Polymarket turned these pools on *2026-06-24* (REC-4); pros under-arrived, the
   high share is real *now* and decays as capital enters; or (b) **artifact** — the advertised rates overstate
   realized payouts, OR the in-band notional scores far below face (most of it is far-from-mid / sub-min_size /
   one-sided), OR holding inventory through binary resolution costs more than the reduced-form τ models.

**The binding next step is EMPIRICAL, not more modeling (avoid the cathedral).** The single unsure thing —
*"do these pools actually pay what they advertise?"* — is answerable far more cheaply than Phase A→D modeling:
- **REC-9 (recommended): a minimal real-money ground-truth probe.** Rest ONE min-size (50-share) two-sided
  position 1c off mid in 2–3 funded weather markets for 24h; observe the ACTUAL USDC reward paid + the realized
  fills, vs. this model's prediction. ~$50–150 at risk, forecast-free, bounded. It resolves (a) vs (b)
  definitively and is worth more than any further simulation. **It requires flipping the live rail (operator-gated,
  currently DORMANT)** — a tiny, near-mid, no-forecast probe, categorically different from the falsified
  taker/selection bets. Operator decision.
- **Phase A (parallel, no capital):** persist `/sampling-markets` rates + per-minute near-mid book depth over a
  full epoch, so the competition denominator becomes time-integrated (not a snapshot) and the share is measured,
  not assumed. Then re-run this exact harness on real series.

**Lesson logged (WO-5):** the frozen gate's "realistic corner" (κ=1 = *instantaneous* aggregate book) is itself
optimistic — an instantaneous snapshot understates time-integrated competing liquidity. The gate is not moved
(discipline), but the full study MUST make the denominator empirical. Verdict label stands at PASS-per-criterion;
operational recommendation is **PROBE before capital**.

---

## 10. REC-9 PROBE HARNESS + Phase A logger BUILT (2026-06-24) — no capital yet, rail DORMANT

Operator chose "build the REC-9 probe so it can be flipped on + funded ~$50." Built, fully tested, **nothing
placed** (`packages/trading` never imported; no rail flip; the harness only emits an order sheet + scores
operator-entered actuals). 1301 tests green; typecheck 0.

**Pure brain (`core/sim/reward-probe.ts`, +14 tests):**
- `buildProbePlan(inputs, opts)` — picks the top-N funded markets by predicted reward, rests EXACTLY `min_size`
  shares two-sided `offsetCents` inside the mid (minimum qualifying capital), predicts reward/fill/net via the
  tested `estimateMarketEconomics` (new `fixedSizeShares` mode). **Probe-validity gates:** `minHoursToResolution`
  (default 18h — a full reward epoch must lie ahead, NOT a same-day resolver) + a degenerate-mid guard (drop ~0/~1).
- `scoreProbe(plan, actuals)` — the ground-truth decider: mean **reward ratio = actual/predicted**. ≥0.5 & net>0
  → `GROUND_TRUTH_CONFIRMS` (pays as advertised, survives fills → scale up / design the bot); <0.5 →
  `OVER_ADVERTISED` (the first-pass PASS was an artifact; rail dormant); else `INCONCLUSIVE` (fills ate it).

**Driver (`scripts/research/reward-probe.ts`):** `--mode plan` pulls the live universe → writes
`out/reward-probe-plan.json` + a human `out/reward-probe-order-sheet.md`; `--mode reconcile` reads the plan +
`out/reward-probe-actuals.json` → the verdict. **Live plan (2026-06-24):** 3 mid-range markets (Paris/Seoul/HK
lows, mids 0.21–0.46, **33h to resolution**), `min_size` 20 each, **~$59 total capital**, predicted reward
$172/day (the optimistic number the probe TESTS).

**Phase A logger (`scripts/reward-snapshot.ts`, +2 tests):** appends per-run rate + near-mid depth rows to
`out/reward-snapshots.jsonl` (434 markets/run) so the competition denominator becomes time-integrated. Local/file
form (run it ad-hoc); the cloud form is §11.

### Operator runbook — running the ~$59 REC-9 probe (flips the DORMANT rail)
1. `pnpm tsx scripts/research/reward-probe.ts --mode plan` → read `out/reward-probe-order-sheet.md`.
2. Fund ~$59 on Polymarket; for each row rest a **maker BUY @ bidPx** and **maker SELL @ askPx** of `size` shares
   on the market's YES token. Leave them live ~24h. (Strict-two-sided rows need BOTH legs to earn — none in the
   current plan.) Do NOT chase fills; this is a resting-liquidity test.
3. After ~24h, read each market's ACTUAL reward earned (Polymarket portfolio → rewards) and any fills; enter them
   into `out/reward-probe-actuals.json` (a starter template is written on first `reconcile`).
4. `pnpm tsx scripts/research/reward-probe.ts --mode reconcile` → the GROUND_TRUTH verdict. CONFIRM → the full
   Phase A→D study + a two-sided MM bot spec are justified (separate operator go). OVER_ADVERTISED → record the
   finding, rail stays dormant, REC-8 closes as "advertised ≠ paid."
- Parallel, zero-risk: the Phase A denominator series now runs in the CLOUD (§11) — no local scheduling needed.

---

## 11. Phase A logger CLOUD-PORTED (2026-06-24) — Supabase Edge fn + pg_cron, every 20 min (the replica-forward twin)

Operator asked to put the snapshot schedule online (like today's replica-forward port) rather than a local Windows
task. A cloud cron runs 24/7 regardless of the PC — but a cloud function can't append to a local JSONL, so this
**brings forward the `market_rewards` DB table** that §9/§10 deferred. That deferral was right *while* the destination
was a local file (anti-cathedral); choosing the online schedule is exactly the trigger that justifies the table. Built:
- **Migration `0057_market_rewards_snapshot.sql`:** `market_rewards` time-series table (RLS on, service-role-only) +
  `record_reward_snapshots(p_rows jsonb)` insert RPC + the `reward-snapshot` cron `*/20 * * * *` (vault `project_url`
  + `cron_secret`, pglite-guarded). Migrations test: names + cron count **17 → 18**.
- **Edge fn `supabase/functions/reward-snapshot/`** (`index.ts` + `handler.ts`): paginates the live `/sampling-markets`
  + batch `/books`, reduces each funded weather market via the SHARED core `reduceBookDepth` (the local logger now
  uses the same core fn — one depth definition), and bulk-inserts the capture. `runJob`-wrapped (cron-auth + claim +
  best-effort). `config.toml` registers it (`verify_jwt = false`). Analytics-only; `packages/trading` never imported.
- **Shared core (`core/polymarket/rewards.ts`):** new pure `reduceBookDepth` + exported `fundedDailyRate` (+4 tests).

1305 tests green; typecheck 0.

### Operator go-live (deploy-gated, the only remaining step — mirrors the replica-forward go-live)
```
supabase db push                                              # apply 0057 (table + RPC + cron)
supabase functions deploy reward-snapshot --use-api --no-verify-jwt
```
The `*/20` cron self-registers on `db push`; until the fn is deployed it 404s harmlessly. Verify a capture landed:
`select captured_at, count(*), round(sum(daily_pool_usd)) pool from public.market_rewards group by 1 order by 1 desc limit 3;`
No new secrets (Polymarket is public/keyless; reuses the existing `project_url`/`cron_secret` vault entries). After a
few days of captures, re-run the first-pass over the series for a time-integrated competition denominator. Rail DORMANT.
```
PRE-REGISTERED KILL-CRITERION (to FREEZE before any REC-8 run):
  PASS = net P&L / capital-at-risk ≥ <bar>% (annualised), at the REALISTIC competition denominator, 95% CI
         lower bound > 0, stable across the competition sweep, no-edge null < 5%.
  FAIL = realistic-share reward income ≤ the two-sided fill cost (adverse selection + inventory) → uneconomic;
         record as the next finding; rail stays DORMANT. (Likely, per the crowding prior — an honest early kill.)
```
