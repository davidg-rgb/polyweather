# REWARD-INVENTORY-BACKTEST — REC-10: is forecast-free liquidity-reward farming actually net-positive?

> **Authored 2026-06-24.** The decisive follow-up to the REC-8 first-pass (`REWARD-FARMING-HANDOFF.md`).
> The first-pass returned a PASS-per-criterion (+$28/market) but flagged it **NOT actionable**, because
> the whole verdict rode on a **guessed** adverse-selection/inventory parameter `τ` (a tax per $ filled,
> default 5%). This work **replaces the guess with a measurement**: an event-driven simulation of a
> two-sided maker quote over the **real** `market_snapshots` best-bid/ask series of **resolved** weather
> buckets, carrying the resulting inventory to the **real** win/lose outcome. **Fictive capital, real odds.**
>
> **Bottom line: FAIL (directional).** The measured two-sided fill+inventory cost is **~−47%/day in the
> mid-range markets that carry 93% of the reward pool** — roughly **8× the ~6%/day reward income**, and
> ~10× the first-pass's guessed `τ`. Forecast-free farming is **net-negative for a small operator at any
> realistic competition level.** The "free" reward is not free: capturing it means resting near mid on a
> binary that resolves to 0/1 the same day, which forces you to hold adversely-selected inventory through
> convergence — the §12 / replica adverse-selection wall, in its most acute form. The live trading rail
> stays **DORMANT**.

- **Branch:** `feat/reward-farming`. Build: typecheck 0 · suite **1368 green** · new module 100% line/fn coverage.
- **Code:** pure `packages/core/src/sim/reward-inventory.ts` (+34 tests) · spine
  `scripts/research/reward-inventory-backtest.ts` · output `scripts/research/out/reward-inventory-backtest.{json,md}`.
- **Reproduce:** `pnpm tsx scripts/research/reward-inventory-backtest.ts` (read-only; `packages/trading` never imported).

---

## 1. The question, precisely (and why it is the last standing candidate)

`FINDINGS.md` falsified every **outcome-predictive** signal this system can see (seven of them). The one
genuinely-orthogonal reopening was the 2026-06-24 launch of **funded liquidity rewards on weather** —
income for *resting near mid regardless of fill or outcome*, forecast-free and selection-free. REC-8
modelled its economics and got a headline +$28/market, but stamped it un-actionable: the implied
**~6.5%/day** yield is "too good to be a standing forecast-free return," and the result was load-bearing
on a **guessed** fill cost.

The honest reduction (REC-8 §9 + this work): a small operator's gross reward **yield** ≈ `pool ÷ in-band
competing capital` — *independent of stake* when small — which is exactly the observed ~6.5%/day. So the
entire net-profit question collapses to **one measurable quantity**:

> **Is the realized two-sided maker fill+inventory P&L (per $ resting capital, per ~1-day market) a
> smaller loss than the ~6.5%/day reward income?**

If the measured fill cost exceeds the reward, farming is net-negative. REC-8 *assumed* the cost (`τ`);
REC-10 **measures** it.

---

## 2. Method (read-only; fictive capital; real odds)

**Cost side — measured on resolved history.** For every resolved weather bucket with a real best-bid/ask
`market_snapshots` series and a known `resolved_outcome` (`win`/`lose`), simulate a **continuously
re-centred two-sided maker quote**:

- Each epoch (snapshot pair) rest a BUY `restOffsetCents` (1¢) below the mid and a SELL 1¢ above, both
  inside the program `max_spread` (4.5¢), size = capital (≈ $100, honouring `min_size`).
- A resting **BUY fills** when the book's best **ask comes down** to it (`next.ask ≤ bidPx`); a resting
  **SELL fills** when the best **bid comes up** to it (`next.bid ≥ askPx`). This is the two-sided
  generalisation of the frozen `maker-spray.simulateFill` ask-touch model — it **embeds adverse selection
  with no free parameter**: on a loser the ask collapses → your bid fills (long a loser); on a winner the
  bid lifts → your ask fills (short a winner); you round-trip the spread only when the book oscillates.
- Fills accumulate **signed inventory**, bounded by a minimal `inv-cap` (1× size — the least risk control
  a farmer applies: stop quoting the side that would breach the cap). Each fill earns the live
  `weather_fees` maker rebate (0.25 × taker fee).
- **Two markings, both reported:** residual inventory marked to the **real resolution** (PRIMARY — the
  purely-passive farmer who never flattens) and to the **last observed mid** (FLATTEN — the farmer who
  closes out at end-of-day). The two agreeing is the proof the magnitude is *not* a hold-to-resolution
  gambling artifact.

**Income side — measured on the live funded universe.** From the real `market_rewards` captures (pool +
in-band competing capital per market), the capital-share reward yield `pool ÷ (capital + κ·competing)`,
swept over the competition multiplier κ (1 = realistic full book … →0 = alone-in-market ceiling).

**Synthesis + verdict.** Net = reward income + measured fill cost, per **regime** (cheap `<0.10` / mid
`0.10–0.90` / rich `>0.90`). The **binding regime is MID-RANGE** — 93% of the live pool sits there, so
that is where the verdict is decided. CIs are **cluster-mean t-intervals over weather-days** (the unit of
synoptic independence). Kill-criterion **pre-registered** in the module header (frozen before the number
was seen).

---

## 3. The data (and its hard limit)

| Side | Source | Coverage |
|---|---|---|
| Income | `market_rewards` (live cron, 2026-06-24) | **442 funded markets**, $32k/day pool, $480k in-band, **6.55%/day** implied gross yield |
| Cost | resolved weather buckets + `market_snapshots` + `resolved_outcome` | **852 buckets** with a book series; **459 modelled** (≥8 usable epochs); 393 too sparse |

**The binding caveat — only 2 independent weather-days.** The dense (≥4-snapshot) book history exists on
**only 2 weather-days (2026-06-12 / 06-13)** — the month-long snapshot span is otherwise too sparse to
simulate a fill path. A weather-day is the unit of independence (all stations share one synoptic state),
so the cluster-level CI is **uninformative** (df=1, the interval is meaninglessly wide). The market is
**perfectly calibrated** by regime over this set (cheap price 0.019/win 0.018; mid 0.302/0.308; rich
0.980/1.000), which re-confirms efficiency and means *there is no directional edge to exploit* — any maker
P&L is pure spread/rebate minus adverse selection.

This is the same book-density wall REC-1 hit. **The verdict is therefore DIRECTIONAL, not CI-certified.**
But the margin is overwhelming (see §4), and the live Phase-A cron accumulates more dense days for a
future certified re-run.

---

## 4. Results (realistic κ=1, $100/market, 1¢ off mid, inv-cap 1× size)

### Reward income (live)
| regime | markets | pool/day | in-band cap | reward yield/day |
|---|--:|--:|--:|--:|
| **mid (0.10–0.90)** | 341 | **$30,363** | $468,889 | **6.04%** |
| cheap (<0.10) | 98 | $1,814 | $34,957 | 4.05% |
| rich (>0.90) | 3 | $848 | $489 | 107.4% (n=3, noise) |

### Measured fill+inventory cost (resolved history)
| regime | nBkt | nDays | meanFillYield (resolution) | flatten bound | median | % net-negative | adverse-sel signature |
|---|--:|--:|--:|--:|--:|--:|---|
| **mid** | 226 | 2 | **−47.40%** [−126%, +31%] | **−47.37%** | −45.4% | **95%** | win −72.2% · lose −37.8% |
| cheap | 233 | 2 | **−8.32%** [−26%, +9%] | −7.12% | −3.9% | 77% | win −122% (n7) · lose −7.8% |

The **resolution and flatten marks are near-identical** (−47.40% vs −47.37% in mid) — the magnitude is
**not** a hold-to-binary-resolution artifact; these buckets converge to ~0/1 inside the observed window,
so the inventory you carry is already deep underwater at the last mid. **95% of mid buckets lose money on
fills.**

### Net = reward + measured cost
| regime | reward/day | measured fill/day | **net/day** |
|---|--:|--:|--:|
| **mid (binding)** | +6.04% | −47.40% | **−41.36%** |
| cheap | +4.05% | −8.32% | **−4.27%** |

### Robustness
- **κ sweep (mid net):** κ=1 → **−41.4%** · κ=0.5 → −36.1% · κ=0.2 → −23.7% · κ=0.05 → **+5.4%**. Net only
  turns positive at the *alone-in-market ceiling* (κ=0.05 ⇒ 52.8%/day reward ⇒ you capture ~90% of **every**
  pool — implausible against a $480k incumbent book). At any realistic competition level the net is deeply
  negative.
- **Gentlest regime + gentlest mark both fail:** cheap (−4.3% net), flatten bound (mid net −41.3%).
- **First-pass `τ` was ~10× too small:** REC-8 swept τ ∈ {0, 1.7%, 5%, 10%, 32.8%}; the *measured* mid cost
  is **47%** — off the top of that range. The +$28/market PASS was an artifact of an optimistic guess.

---

## 5. The verdict — FAIL (directional)

> **FAIL.** Mid-range net **−41.4%/day**: reward yield +6.04% + **measured** two-sided fill yield −47.4%.
> The fills erase the reward share by ~8×. Forecast-free liquidity-reward farming on weather is
> **net-negative** for a small operator at any realistic competition level. The live rail stays DORMANT.
>
> *Directional, not CI-certified* — the dense book history spans only 2 independent weather-days, so the
> cluster CI is uninformative. But the margin (cost ≈ 8× reward, 95% of buckets negative, every κ corner
> and both marking models agree) is far beyond what additional days could overturn.

**Why this is the expected, coherent result, not a surprise.** The reward pays you to provide liquidity
near mid. But these are **binaries that resolve to 0/1 the same day** on a **calibrated, efficient**
market (FINDINGS). The price *must* trend to 0 or 1, and informed flow crosses your stale quote on exactly
the adverse side as it converges. The spread you quote (~2¢) is structurally too small to offset a fraction
of a 0→1 move. This is the §12 maker-spray finding (−1.7pp on one-sided cheap resting) and the
badatmath-replica adverse-selection tax (32.8pp), now measured for **two-sided near-mid** resting where the
inventory risk is worst.

**What this does NOT claim.** It does not prove farming is unprofitable for *everyone* — a professional MM
with sub-second cancel/replace, inventory skewing, and a latency edge can flatten before convergence. But
that is **active inventory management requiring exactly the forecasting/latency skill this market has
already been shown to price efficiently** (FINDINGS). The "forecast-free, selection-free" thesis — the only
reason rewards were a *new* lever — is what fails. Capturing the reward net-positive collapses back into
the falsified skill problem.

**Honest model caveats (all bias toward over-stating the cost; the FAIL is robust to them):**
1. **Full-size fill on every touch** — real queues give partial/no fills, so true churn is lower. (But more
   fills also means more spread capture; the *net* −47% says adverse ≫ spread regardless.)
2. **2 weather-days** — directional only; re-run when the cron accumulates dense days (the CI guard in the
   verdict downgrades any future *positive* result that is still data-limited).
3. **No active inventory cutting beyond the 1× cap** — a real MM flattens sooner; but that reintroduces the
   falsified skill requirement, which is the point.

---

## 6. Reuse / extend

- Pure model + frozen verdict: `packages/core/src/sim/reward-inventory.ts` (`simulateBucketInventory`,
  `regimeFillCost`, `rewardYieldPerDay`, `regimeRewardYield`, `regimeNet`, `runInventoryStudy`,
  `rewardInventoryVerdict`). Tests: `packages/core/test/reward-inventory.test.ts`.
- Spine: `scripts/research/reward-inventory-backtest.ts` —
  `[--capital 100] [--offset 1] [--inv-cap 1] [--min-epochs 8] [--from] [--to] [--json]`.
- **Re-run for a certified CI** once `market_rewards` + dense `market_snapshots` accumulate ≥ 8 distinct
  weather-days (the `MIN_CI_DAYS` floor in the module). The same harness then adjudicates decisively.

_Analytics & forecasting record. Nothing here is trading advice; the live rail is DORMANT._
