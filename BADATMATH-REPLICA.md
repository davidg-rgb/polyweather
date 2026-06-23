# BADATMATH-REPLICA — a fictional paper-trial of the #1 weather sharp's buying model

> **Authored 2026-06-23.** A no-money, read-only trial run that **recreates badatmath's revealed buying
> strategy** (cheap-Yes longshots, his best cities, his peak-odds entry timing, his sizing) and **tracks
> it day by day**, scored three ways so we can watch — in real time — exactly where his edge lives and
> where a copycat's money leaks. This is the operator's explicit ask: *"recreate badatmath's model to the
> best of our ability for a fictional trial run … mimic what has worked … track our progress day to day."*
>
> **It is NOT trading and NOT a reopening of the live rail.** WALLET-RECON-HANDOFF.md falsified all five
> replication angles; badatmath's edge is a non-followable MAKER edge. This trial doesn't dispute that —
> it *makes it visible*. The whole point is to watch the spread tax and the adverse-selection tax accrue
> against a faithful mimic, live. See §6 (honest caveats).

Cross-refs: `WALLET-RECON-HANDOFF.md` (§11 copy-trade, §12 maker-spray, §15 the forensic purchase map this
encodes), `AMSTERDAM-SIM.md` (the paper-sim precedent), memory `polymarket-sharp-weather-wallet.md`.

---

## 1. What it is (one paragraph)

Each day, the trial looks at the live daily-Tmax bucket markets, applies **badatmath's reverse-engineered
playbook** to pick which buckets to "buy," records the buy at three different prices, and — when the market
resolves — scores the hold-to-resolution P&L of each. It runs over the data we already have (**BACKTEST**, to
seed a real track record) and **FORWARD** on live markets (the daily loop). The three prices are the whole
story: the gap between them is precisely why the edge is *his* and not *ours*.

---

## 2. The strategy DNA (WALLET-RECON-HANDOFF.md §15, distilled to rules)

| Lever | Rule | §15 evidence |
|---|---|---|
| **Engine** | buy the **Yes** leg of buckets whose rested **bid is in 0.10–0.25** | §15.1: [0.10,0.15) +23%, [0.15,0.25) +24% ROI; [0.05,0.10) is a −22% DEAD ZONE → excluded |
| **Timing** | enter **36h before resolution** (his median; the "peak odds buying hours") | §15.3: 24–48h +18.3%, 48–72h +15.5%, **<24h break-even** — he does NOT bet day-of |
| **Breadth** | up to **3 buckets per city·day** | §15.4 median 3 (max 11) — sprays the plausible cheap range, not one modal pick |
| **Sizing** | **$12 per position** | §15.5 median $12.12 — a micro-grind |
| **Bankroll** | cap total daily stake at **$250/day** (operator's knob) | "same volume as him" at a sane scale (his is hundreds/day) |
| **Cities** | only **his best-performing cities** | §15.6: tropical/stable pay (SE-Asia, E-Asia), volatile mid-latitudes bleed — the whitelist is **computed from the backtest**, not hardcoded |

The pure engine encoding these rules is `packages/core/src/sim/badatmath-replica.ts` (22 unit tests); it needs
**no forecast and no wallet feed** — his strategy is price + city + timing, all in our own Postgres.

---

## 3. The three curves (why a paper trial of a known-non-replicable edge is still worth running)

Every buy is scored at three prices, side by side. The gaps between them are the deliverable:

| Curve | the price it pays | what it answers |
|---|---|---|
| 🟢 **maker-ideal** | his cheap rested **bid**, **assume filled** | "his strategy's theoretical edge" — reproduces the §15 +12.9% hold-to-resolution ceiling |
| 🟡 **maker-realistic** | rest the bid, **fill only if the book later touches it** (§12 ask-touch model) | "what we'd actually get resting bids ourselves" — embeds adverse selection (cheap bids fill on the losers) |
| 🔴 **taker** | cross to the **ask**, always fill | "what we'd net chasing him as a taker" (§11) |

- **Spread tax** = maker-ideal ROI − taker ROI (the cost of crossing to the ask instead of resting cheap).
- **Adverse-selection tax** = maker-ideal ROI − maker-realistic ROI (the cost of REAL maker fills).

---

## 4. The seed backtest (2026-04-21 → 2026-06-21, all cities, run 2026-06-23)

7,584 candidate buckets → 599 band-eligible → 588 breadth-selected → **180 bought** (the $250/day cap binds at
20/day) → 180 resolved (our DB-resolved subset).

| Curve | resolved | stake | gross P&L | ROI | win% | EV/$1 (95% CI) |
|---|--:|--:|--:|--:|--:|--:|
| 🟢 maker-ideal | 180 | $2,160 | **+$418** | **+19.3%** | 19.4% | +19.4% [−16.8%, +56.6%] |
| 🟡 maker-realistic | 168 | $2,016 | **−$271** | **−13.4%** | 13.7% | −13.4% [−47.5%, +21.6%] |
| 🔴 taker | 180 | $2,160 | **+$85** | **+3.9%** | 19.4% | +3.9% [−27.9%, +35.7%] |

- **Spread tax 15.4% ROI · adverse-selection tax 32.8% ROI · maker fill rate 93.3%.**
- **The reads:** (1) maker-ideal reproduces his positive hold-to-resolution edge (+19%, the §15 ceiling). (2)
  maker-realistic **flips negative** — when you actually rest bids and only fill when the book touches, you fill
  on the **losers** (win rate 19.4% → 13.7%): the §12 adverse-selection trap, now visible. (3) The
  adverse-selection tax (32.8%) **dwarfs** the spread tax (15.4%) — being a *real* maker hurts more than
  crossing the spread. (4) Every CI is wide at n=180 — which is exactly why we run it **forward** to accrue more.
- **His best cities (computed):** chicago, beijing, busan, buenos-aires, amsterdam, denver, chongqing cleared a
  positive maker-ideal ROI at n≥8; the bleeders (cape-town, ankara, dallas, guangzhou…) fall below.

---

## 5. How to run

```bash
# BACKTEST — seed the track record over the resolved history; writes the ledger + a per-position CSV
pnpm tsx scripts/research/badatmath-replica.ts

# …with Gamma resolution (~97% vs our DB's ~45%): loads the FULL window + settles every selected buy
pnpm tsx scripts/research/badatmath-replica.ts --gamma

# just rank cities (pick / inspect the whitelist)
pnpm tsx scripts/research/badatmath-replica.ts --rank-cities

# FORWARD — the daily loop: reconcile resolved (DB + Gamma), place today's buys, re-render the live ledger
pnpm tsx scripts/research/badatmath-replica.ts --mode forward --gamma
```

Knobs (all optional, defaults = §15): `--from --to --cities <slugs> --cheap-lo --cheap-hi --lead-h --breadth
--stake --cap --min-city-n --top --out <dir> --gamma --res-cache <file> --net --json`.

**`--gamma`** resolves each scored buy against Polymarket Gamma (authoritative, ~97% settled, cache-first) with
our DB `winning_bucket_idx` as fallback — Gamma is primary because the DB pipeline lags (~45%). In the forward
run it also makes positions **close promptly** instead of waiting on the DB. The daily Scheduled Task runs with
`--gamma`. **Note (measured 2026-06-23):** Gamma did *not* enlarge the current seed — see §7.

**Artifacts** (under `scripts/research/out/`, gitignored — regenerated on each run):
- `badatmath-replica-ledger.md` — the backtest seed ledger (three curves + day-by-day + best cities).
- `badatmath-replica-forward-ledger.md` — the **LIVE** forward ledger (the real day-to-day track record + open positions).
- `badatmath-replica-positions.csv` / `…-forward-positions.csv` — per-position drill-down.
- `badatmath-replica-state.json` — the forward open/closed positions + whitelist (resumable).

---

## 6. How the forward loop works (the daily driver)

`scripts/research/badatmath-replica-forward.ts`, once per day:

1. **RECONCILE** — for every OPEN position placed on a prior day, check our DB for the event's resolution
   (`winning_bucket_idx`). When resolved, replay the bucket's full book to decide whether the rested maker bid
   filled (§12 ask-touch), lock the outcome, and CLOSE it.
2. **PLACE** — find live OPEN markets in the whitelist cities whose 36h-before entry instant has arrived but
   which haven't resolved, run the §15 playbook (band + breadth + the $250/day cap), and OPEN the new buys with
   their entry prices **locked at the 36h book** (the identical instant the backtest prices at → forward +
   backtest are one methodology). Each event is placed exactly once (deduped against state).
3. **PERSIST + RENDER** — write the state file and re-render the live forward ledger.

On day 1 the forward ledger shows "0 resolved / N open"; as positions resolve over the following days, the
three-curve table and the day-by-day cumulative P&L grow. **That growing forward ledger is the deliverable the
operator watches.** Resolution uses our own DB's `winning_bucket_idx` (the trusted §15 basis the rest of R&D used).

---

## 7. Honest caveats (read these)

- **This is a paper trial, not a strategy recommendation.** WALLET-RECON falsified all five replication angles;
  the maker-realistic curve flipping negative in §4 is that same finding, reproduced from the front. The
  *value here is the live measurement*, not a tradable edge. The live rail stays DORMANT.
- **maker-ideal is a CEILING, not achievable.** It assumes you get his cheap fill on the buckets you pick — the
  §12 maker-spray study proved adverse selection eats that in practice (the maker-realistic curve is the honest one).
- **The seed is bounded by SNAPSHOT density, not resolution (measured).** With `--gamma` every selected buy
  resolves (180/180, ~97% Gamma + DB fallback) — yet the seed stays **~180** positions. Diagnosis (2026-06-23):
  `market_snapshots` spans May 14→Jun 23 but is *dense* only from ~Jun 8 (Jun 15 week ≈ 397k rows vs May weeks
  3–12k). The strategy needs a **36h-before-resolution book** to price an entry, so band-eligible buys only
  exist for the ~2 recent dense weeks; the $250/day cap then throttles those to ~20/day → ~180, with wide CIs.
  Resolution was never the bottleneck. **Gamma is still wired** (it guarantees resolution *completeness* and
  makes forward positions close promptly), but **the real path to a bigger sample is the forward run accruing
  dense data daily** — `poll-markets` is now dense, so the live ledger grows from here. (Raising `--cap` would
  also enlarge it but breaks the chosen "his volume" sizing.)
- **"Peak odds buying hours" = a fixed 36h instant.** Operationalized as his median lead (inside his 24–48h
  +ROI band) so the backtest and forward price identically. A retrospective "pick the cheapest in the window"
  would not be implementable forward.
- **Band on the BID.** We band cheap-eligibility on the rested bid (his fill-price proxy, ≈0.107 in §11), and let
  the taker leg pay whatever ask sits above it — so the taker curve honestly carries the full spread tax.

---

## 8. Files

| File | What |
|---|---|
| `packages/core/src/sim/badatmath-replica.ts` | the pure engine (strategy, 3-leg scoring, aggregation, city ranking) |
| `packages/core/test/badatmath-replica.test.ts` | 22 unit tests |
| `scripts/research/badatmath-replica.ts` | the impure spine — DB loaders, backtest, ledger/CSV render, CLI |
| `scripts/research/badatmath-replica-forward.ts` | the forward daily driver (reconcile → place → persist → render) |

Read-only. No migration. Never imports `packages/trading`. 1,142 tests green; typecheck clean.
