# OBS-TRANSMISSION — does the 5-min obs feed lead the market, and is any of it takeable?

> **↳ ADDENDUM (2026-07-25, same evening — the fabrication mechanism is RESOLVED, and it rewrites
> the experiment.** The operator supplied `docs/ops/POLYMARKET-TEMP-ORACLE.md`: WU's resolution
> table is a bit-for-bit re-render of the **METAR/SPECI stream only** — the 5-min obs stream never
> appears in it. **Validated in-house at 100%**: `oracle-replica-validation.py` reproduces the
> resolved market winner on **66/66** city-days from IEM's per-ob METAR/SPECI feed
> (`max(round_half_up(tmpf))`, report_type 3,4), and shows the synoptic 5-min max **EXCEEDS the
> METAR-table max on 28/66 days (42%, by 1–3°F)**. So the 19 winner-"kills" were not "WU sensor
> divergence" — they were 5-min blips that resolution, by construction, never sees; the market's
> 0.30–0.93 residual bids were sharps who know the oracle. **Consequences shipped same-day:**
> ① the `synoptic-nowcast` lane is now **CAPTURE-ONLY** (its `upsert_intraday` writes removed —
> it was tightening the resolution-grade 0111 floor with wrong-grade data; 11 contaminated
> `intraday_max` rows deleted + re-floored METAR-grade); ② the **08-06 re-adjudication design is
> corrected**: kills must be METAR/SPECI-grade (zero fabrication risk *by construction* — no
> margin heuristic needed), with the 5-min stream as the **anticipatory trigger** (hit the bid
> when a 5-min ob makes the next METAR's kill near-certain; the risk to price = "no METAR/SPECI
> confirms", now measurable per city from the two streams). The margin≥3 cell was a crude proxy
> for exactly this; the clean design measures it directly. Verdict unchanged today (INSUFFICIENT,
> scrap-sized pot) — but the re-run gets a fabrication-free kill rule and a per-city
> blip-confirmation prior.

> **VERDICT (2026-07-25, real-book cross-check): the LEAD IS REAL, the TRADE IS NOT (yet/likely ever).**
> On real `opening_captures` bids, the floor-kill collapse concentrates **after** the 5-min obs print
> (median pre-print quote drift **0.0000**) — the sub-hourly obs genuinely lead the book. But the
> tradable form ("buy NO on freshly obs-killed buckets") **does not clear the clustered gate at the
> executable price**: at walked `execBid`, the city-day-clustered CI straddles zero at every margin-1/2
> cell (best: mean +0.10/$1, CI **[−0.098, +0.329]**), because **the market's residual 5–20¢ bid on
> "dead" buckets is its price for resolution-source risk — and it is right**: 19/19 winner-"kills"
> (buckets our °C→°F conversion killed that then WON) kept high bids (0.05–0.93) and beat the obs call.
> The one clean-looking cell — **margin ≥3°F (0 fabrications in-window)** — is a **CONSTANT-OUTCOME
> cell** (all 14 trades won → the CI measures price dispersion, not fabrication risk; the exact 07-24
> convergence-capture trap, now guarded in this tool too) with a **$52–156/week** pot. Label:
> **INSUFFICIENT, n far under the ≥40-market floor; no §13 reopen; no build.**
> Re-adjudicate ~**08-06** on the grown corpus (obs top-up + captures accrue daily; window triples).

## The question

Operator (2026-07-25): *"log every 5-min ob per relevant city, connect to Polymarket minute prices,
isolate how fresh obs affect price."* The Synoptic trial (ends ~08-08) gives 5-min US obs vs our 30-min
METAR lane. WO-5 (`FORECASTING-RD.md`) already proved the market efficient w.r.t. the hard running-max
floor at METAR cadence — the open question was whether the **sub-hourly** window (obs the METAR watchers
haven't seen yet) holds anything at executable prices.

## Pass 1 — trade-print study (2026-07-25, `synoptic-price-join.py`)

Corpus: 20,587 five-min obs / 11 US stations / 07-19..07-25 joined to 99 events / 3.09M minute price
points. Findings (85 city-days): floor-kill Δp median **−0.5¢ in [T−30,T)** vs **−6.0¢ in [T,T+15)**
(88% of the drop post-print); winner lead-lag argmax **+25 min** (obs leads 55/67 city-days).
**Caveats that motivated pass 2:** trade-print MID basis (traps #1/#8), selection excluded
market-faster kills, obs-time ≠ publish-time.

## Pass 2 — real-book cross-check (2026-07-25, `synoptic-realbook-crosscheck.py`)

Same events joined to the **real CLOB book snapshots** in `out/opening-captures-archive` (~5-min cadence;
`bestBid` / walked `execBid` / `sellbackUsd` / `sellbackDepthUsd` captured live from `/book`). Join:
city + `target_date` (**verified = the weather day** in `opening_captures` — unlike gamma's
`targetDate` = resolution day) + bucket-label-set equality. Outcomes from the resolved market-history
archive. 66 city-days joined; 354 structural kills (margin-1 rule).

**1. The denominator the first pass couldn't see** (all 335 loser kills, real bid at T−30):

| bid at T−30 | n | share |
|---|---|---|
| alive ≥5¢ | 74 | 22.1% |
| marginal 1–5¢ | 48 | 14.3% |
| dead <1¢ | 92 | 27.5% |
| no snapshot ≤90min | 121 | 36.1% |

→ At most **~22%** of obs-kills had meaningful meat left half an hour before the print. The market (or
the open) had already flattened the rest.

**2. Timing on real quotes** (alive cohort, n=74): median bestBid 0.185 (T−30) → 0.18 (last pre-print)
→ 0.17 (first post-print) → 0.09 (T+15) → 0.12 (T+60). Median per-kill quote drift: **pre-print 0.0000,
across-print 0.0000, post-print −0.03**. The collapse is post-print — pass 1's timing read CONFIRMED on
quotes (no trade-print staleness artifact).

**3. The executable EV — and the fabrication wall.** Strategy: on each obs-kill, sell YES into the
first post-print bid (== buy NO; negRisk book identity; canonical taker fee). Winner-"kills" counted at
full loss. Day-clustered bootstrap (4,000 draws):

| margin | fabrications | best execBid cell | clustered CI | pot (top/band $/wk) |
|---|---|---|---|---|
| ≥1°F | 19/354 = 5.4% | +0.078/$1 (n=81) | **[−0.095, +0.266]** | $123 / $349 |
| ≥2°F | 7/322 = 2.2% | +0.089/$1 (n=42) | **[−0.149, +0.359]** | $157 / $417 |
| ≥3°F | 0/288 = 0.0% | +0.215/$1 (n=14) | [+0.111, +0.385] ⚠ | $67 / $156 |

⚠ = **CONSTANT-OUTCOME** (every trade won → CI unreliable; flags automatically in the tool). The
breakeven fabrication rate at margin-3 prices is ~0.2 — upper 95% bound on 0/14 trades is ~0.21:
**unresolvable at this n.**

**4. Why the fabrications happen (and why the market wins them):** the 19 margin-1 winner-"kills"
cluster where the Synoptic °C-converted 5-min feed and the resolution source (WU daily max, native °F)
diverge by 1–2°F — SF 4 · Austin 3 · Chicago 3 (marine layer / sensor-vs-CLI divergence cities). The
market held bids of **0.30–0.93** on 13 of 19 — it was not guessing; it prices the source divergence
better than a naive °C→°F conversion does. This is the `wuRound` lesson surfacing as adverse selection:
**the residual bid on an "obs-dead" bucket is not free money, it is an insurance premium quoted by
someone who understands the resolution source.**

## Adjudication

- **Transmission (the operator's question): ANSWERED YES** — 5-min obs lead the real book by ~5–25 min.
  This is analytics value (the `synoptic-nowcast` lane already feeds it into our floors/nowcasts).
- **Taker trade at margin 1–2: NO EDGE** (clustered CI straddles 0 at execBid; the market prices the
  fabrication risk approximately fairly).
- **Margin ≥3 residual-bid scalp: INSUFFICIENT** — constant-outcome cell, n=14 ≪ 40, pot $52–156/wk.
  Even a clean PASS at this pot would be scrap-collection, not a signal. **No build, no config change,
  no §13 reopen** (§13 requires a maker-fill mechanism change; this is unrelated to it).
- **Standing re-adjudication:** re-run `synoptic-realbook-crosscheck.py` ~**08-06** (both corpora accrue
  daily via rota 6b + opening-capture; window 07-19..08-06 ≈ 3× n). If margin-3 then shows ≥40 trades,
  0 fabrications AND a wholly-positive clustered CI, bring it to the operator as a **scrap-sized**
  finding — with the constant-outcome caveat stated first.

## Pass 3 — the deep-history METAR-grade replay (2026-07-25 evening, operator: "Build it")

The oracle finding unlocked the capability this study lacked: the **historical resolution-state
path**. `iem-backfill.py` pulled the METAR/SPECI stream for **all 45 stations × 90 days**
(109,954 rows, one polite ranged request per station); `metar-kill-replay.py` replayed
resolution-grade kills against the deep price archive: **2,161 events joined · replication 96.2%**
(divergence is city-dependent: US/EU ≈ perfect; hotspots shenzhen 16 / seoul 7 winner-"kills" —
IEM≠WU divergence, kept in the trade panel as the honest fabrication channel, 36 kills = 0.27%).

**The methodology catch worth more than the numbers:** entering at the first print ≥ T (the
METAR's *valid* time) produced +0.78..+1.08/$1 "edge" — pure LOOK-AHEAD, because AWC publishes
2–6 min after valid time. Shifting entry to [T+6m, T+21m] collapsed the universe **2,523 → 298
trades (−88%)**: the market eats METAR kills within minutes. Now pinned in the tool.

**Honest read (13,406 kills · 12,872 clean):**
- **Denominator law at scale:** 64.6% of METAR kills land with the bucket already **<1¢**;
  only 19.8% alive ≥5¢ at T−30. Timing (alive cohort): mid 0.215 (T−30) → 0.115 (T) →
  **0.0005 (T+15)** — once the METAR lands it is over in minutes. Unified story with passes
  1–2: the only window where any bid survives is the 5-min-obs → confirming-METAR gap.
- **The clean scrap is ZERO:** entries <10¢ (n=145, the margin-3 thesis at scale): mean
  **−0.003/$1** on optimistic mids → dead before the real book even takes its cut. The July
  margin-3 INSUFFICIENT cell should be expected to die as n grows; prior for the 08-06 re-run
  is now firmly negative.
- **The +0.33/$1 headline CI[+0.19,+0.50] is carried by 18 trades at ≥60¢ entries (+3.93
  mean)** — post-kill prints where the market REFUSED the METAR's finality. Unclaimable:
  mid-basis (law: ≤ PASS_PENDING_REAL_BOOK), n=18, and an unresolved look-ahead channel —
  IEM archives *corrected* METARs while WU honors revisions until the next-day first print,
  so some "kills" may not have existed in the live stream when those prints traded.
  **Classified artifact-risk, not a signal; no build.** The passive forward corpora
  (opening_captures + synoptic_obs through ~08-08) already record what a real-book
  confirmation would need.

## Reproduce

```
pnpm tsx scripts/research/synoptic-history-pull.ts        # daily obs top-up (trial ends ~08-08)
pnpm tsx scripts/ops/dump-opening-captures.ts --incremental
python scripts/research/synoptic-price-join.py            # pass 1 (mid-basis, timing only)
python scripts/research/synoptic-realbook-crosscheck.py   # pass 2 (the July real-book verdict)
python scripts/research/iem-backfill.py --days 90         # resolution-stream backfill (45 stations)
python scripts/research/metar-kill-replay.py --days 90    # pass 3 (deep-history METAR-grade replay)
```

Full outputs: `scripts/research/out/synoptic-realbook-crosscheck-result.txt` +
`out/metar-kill-replay-result.json`; the oracle validation: `oracle-replica-validation.py` (66/66).
