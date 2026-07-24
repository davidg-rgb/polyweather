# CONVERGENCE-CAPTURE — results + verdict (2026-07-24)

> **VERDICT: KILL, on all three arms.** Selecting the buy bucket from the MARKET's own signal instead of our
> forecast is **decisively worse**, not better (14 of 14 bracket cells KILL). Betting **NO** on the selected
> bucket is a **NULL** — not a loss, not an edge: the favorite-longshot bias is real at **+2–3¢/share** and is
> almost exactly cancelled by the **2.2–2.3¢ half-spread** a taker crosses, with the **0.55–0.58¢** fee eating
> whatever residual survives. **Holding to resolution is a clear loss** (−4.3¢ to −5.6¢/share, CI excludes 0).
> Signal #12 stays dead; no arm earns a forward paper test. Read-only run — no capital, nothing placed.

Run brief: `CONVERGENCE-CAPTURE-HANDOFF.md` (operator ask, 2026-07-24: *"bet what the market will guess the max
temperature will be, catch the guess at an early cheap stage and sell it as it enters higher likelihood"*, plus
the follow-up: *"crosscheck a potential negative buying pattern, betting 'no' … or possibly hold to finish"*).

---

## 1 · Hypotheses tested

| # | Bet | Arm | Verdict |
|---|---|---|---|
| H1 | Buy the bucket the MARKET points to at the flat-ish open, sell into the convergence re-rating | bracket | **KILL** — 14/14 cells |
| H2 | The selected bucket is systematically OVERPRICED → bet NO on it | NO | **NULL** — straddles 0 on every powered cell |
| H3 | Skip the convergence sell; buy cheap and HOLD to resolution | hold | **KILL** — CI excludes 0, negative |

H1 is the operator's original framing. H2/H3 are the requested cross-checks. All three were scored on the same
real captured order book, the same gates, and the same frozen §9R-E estimators.

## 2 · Panel

Two on-disk archives **merged** (primary wins every `event_id` collision — duplicates dropped whole, never
interleaved, since interleaving two dumps of one series corrupts the ordering the no-look-ahead walk depends on):

- `scripts/research/out/opening-captures-archive/` — 835 events
- `scripts/research/out/opening-captures-archive-c96-20260707/` — the pre-07-06 copy; only 131 events overlapped,
  so it contributed **344 genuinely new events (+41% panel)**. Row and bucket shapes identical between dumps.

**Merged: 1,179 events / 45 cities / 27 target dates. Resolution coverage 100%** (`market_events`,
`poly_resolved_winner_idx ?? winning_bucket_idx`) — zero missing rows, zero null winners, zero grading
mismatches. The handoff's warning about partial coverage did not materialise; nothing was silently dropped.

Gate universe = the frozen 10-city `bot.cities` allowlist (270 events → 200 after the fresh filter, 100,569
ticks). A 45-city run is reported **EXPLORATORY** alongside it — 4–6× the rows, CI width roughly halved.

## 3 · H1 — market-signal selection into the bracket exit

Selection rules, all computed from ticks[0..i] only (no look-ahead, enforced structurally by slicing before the
rule is called): **M0** forecast `argmax(houseProb)` (control) · **M1** bid-leader `argmax(bestBid)` ·
**M2** market-mode `argmax(mid)` · **M3** floor-adjacent (**PROXY** — see §7) · **M4** momentum (**NOT
LIKE-FOR-LIKE** — see §7). `HE` = the forecast reservation gate: `on` = strict (`execAsk ≤ houseProb −
entryEdgeMargin` retained), `off` = pure market selection (cap only, no forecast anywhere).

**Frozen 10-city gate universe, headline TP 0.25:**

| select | HE | n | cities | days | winFrac | meanNet | clustered CI95 | zsMC | verdict |
|---|---|---|---|---|---|---|---|---|---|
| M0 | on | 125 | 10 | 19 | 26.4% | −32.2% | [−52.2%, −12.2%] | 2.2% | KILL |
| M0 | off | 159 | 10 | 20 | 24.5% | −23.9% | [−42.9%, −4.8%] | 2.8% | KILL |
| M1 | on | 121 | 10 | 19 | 27.3% | −31.3% | [−51.6%, −11.1%] | 2.1% | KILL |
| M1 | off | 174 | 10 | 20 | **13.8%** | −34.1% | [−44.5%, −23.7%] | 2.2% | KILL |
| M2 | on | 104 | 10 | 19 | 31.7% | −31.1% | [−46.5%, −15.7%] | 2.9% | KILL |
| M2 | off | 164 | 10 | 20 | 15.9% | −30.5% | [−42.0%, −19.0%] | 2.1% | KILL |
| M3 | on | 40 | 10 | 16 | 22.5% | −59.9% | [−82.8%, −36.9%] | 3.0% | KILL |
| M3 | off | 104 | 10 | 19 | 8.7% | −38.7% | [−59.7%, −17.7%] | 2.5% | KILL |
| M4 | on | 113 | 10 | 19 | 32.7% | −26.1% | [−45.0%, −7.2%] | 3.3% | KILL |
| M4 | off | 167 | 10 | 20 | 12.6% | −34.6% | [−43.5%, −25.6%] | 3.0% | KILL |

**EXPLORATORY 45-city universe** (not the gate):

| select | HE | n | cities | days | winFrac | meanNet | clustered CI95 | zsMC | verdict |
|---|---|---|---|---|---|---|---|---|---|
| M0 | on | 623 | 45 | 22 | 25.8% | −36.2% | [−43.1%, −29.2%] | 2.7% | KILL |
| M0 | off | 754 | 45 | 23 | 25.1% | −31.8% | [−38.2%, −25.4%] | 2.2% | KILL |
| M1 | on | 602 | 45 | 22 | 26.1% | −36.7% | [−43.6%, −29.9%] | 2.4% | KILL |
| M1 | off | 813 | 45 | 23 | 15.1% | −35.9% | [−40.6%, −31.3%] | 2.3% | KILL |

**Every cell fails every leg** — winFrac far under the 0.50 bar, the whole clustered CI negative. The 45-city
panel lands in the same place with half the CI width, so **the KILL is not a small-panel artifact**.

**Market selection is worse than the forecast, not better.** The pure cells are the clean read: M1 13.8%,
M2 15.9%, M4 12.6%, M3 8.7% — against M0's 24.5%. Corroborated independently on the unfiltered ladder
(§4): the forecast picks the winner **31.3%** of the time vs M1 21.8% / M2 25.5% / M4 20.9%. Our forecast has
real skill; the market has already priced it. The operator's premise — that the market's revealed signal is a
better bucket-picker than our model — is **falsified**.

## 4 · H2 — the NO side

**Cheap gate first, on the unfiltered ladder** (1,179 events / 45 cities / 27 dates; every selected bucket held
notionally, no TP/stop — an *unconditional* population, deliberately not the adversely-selected residue of the
live Google track):

| rule | n | P (Wilson95) | ask A | bid B | YES edge | NO edge | day-clustered CI |
|---|---|---|---|---|---|---|---|
| M0 | 652 | 31.3% [27.8, 34.9] | .495 | .149 | −19.8% | −16.7% | [−25.4%, −13.2%] |
| M1 | 775 | 21.8% [19.0, 24.8] | .507 | .166 | −29.9% | −5.7% | [−11.9%, −2.2%] |
| M2 | 789 | 25.5% [22.6, 28.6] | .505 | .183 | −27.6% | −7.6% | [−14.1%, −4.6%] |
| M4 | 774 | 20.9% [18.2, 23.9] | .454 | .075 | −25.4% | −13.7% | [−15.6%, −8.5%] |
| CHEAP | 415 | 0.96% [0.4, 2.5] | .064 | .012 | −5.8% | +0.16% | [+0.11%, +0.78%] |

**But this is the wrong population for a strategy verdict** — it scores the selected bucket *unfiltered*,
including expensive and unquoted rungs the entry gates would never buy. On this population YES edge + NO edge
≈ −37% ≈ −(ladder spread + both fees) for every rule, which says the ladder-wide market is efficient but says
little about the cheap bucket we actually trade.

**The real answer is on the gated per-trade rows** — the buckets that passed the price cap and depth floor.
NO cost basis `1 − execBid` (the honest executable price, not `1 − bestBid` which flatters it):

| run | n | cities | days | NO win% | mean edge/sh | city-clustered CI | seeded cluster bootstrap | read |
|---|---|---|---|---|---|---|---|---|
| 45c M0 strict | 622 | 45 | 22 | 88.1% | **+0.28¢** | [−2.54¢, +2.47¢] | [−2.57¢, +2.37¢] | STRADDLES_0 |
| 45c M0 pure | 754 | 45 | 23 | 86.3% | **−0.83¢** | [−3.77¢, +1.82¢] | [−3.85¢, +1.65¢] | STRADDLES_0 |
| 45c M1 strict | 601 | 45 | 22 | 87.0% | **−0.44¢** | [−3.46¢, +1.70¢] | [−3.56¢, +1.57¢] | STRADDLES_0 |
| 45c M1 pure | 811 | 45 | 23 | 85.6% | **−2.42¢** | [−5.33¢, +0.13¢] | [−5.34¢, +0.01¢] | STRADDLES_0 |
| 10c M0 pure | 159 | 10 | 20 | 86.8% | **−0.22¢** | [−5.84¢, +7.05¢] | [−5.32¢, +5.16¢] | STRADDLES_0 |

Per $1 staked on the 10-city M0-pure cell: **−0.1%, CI [−6.7%, +8.3%]**. The seeded bootstrap agrees with the
t-CI everywhere, so the inverted tail (risk ~0.86 to win ~0.14) is **not** what drives the answer — it
genuinely sits on zero.

### The mechanism — why NO is a null and not a win

Decomposing the 45-city pure panel (n=754) at the fill tick:

```
executable ask   0.1807
executable bid   0.1341   →  half-spread 2.33¢,  mid 0.1574
true win rate    13.66%   →  favorite-longshot bias at mid = +2.08¢
bias − half-spread                                          = −0.25¢   ← what a taker selling into the bid captures
NO taker fee (0.05·p·(1−p))                                 =  0.57¢
net                                                         = −0.83¢
```

Same structure on the strict panel (+3.00¢ bias, 2.18¢ half-spread, 0.55¢ fee → **+0.28¢**) and on the 10-city
M0-pure cell (+2.70¢, 2.34¢, 0.58¢ → **−0.22¢**). Three panels, one shape.

**The cheap bucket really is overpriced — by 2–3¢ — and that is almost exactly the width of the half-spread a
taker must cross to monetise it.** The taker hands the entire bias back at the point of execution, and the fee
is the same order as any residual. This is the *identical* shape as `CONVERGENCE-TUNING.md`'s bracket finding —
**a maker edge, not a taker edge** — now measured independently from the inverse side over 754 events / 45
cities / 23 days. It is the tightest efficiency measurement this project has produced: **the market prices the
NO side correctly to within ±2.5¢ at 95% confidence.**

### Depth binds harder than price

Fillable size for NO is the YES **bid**-side depth (`sellbackDepthUsd`) — a different, thinner number than the
ask depth every prior run checked. Distribution on the gated rows: min $0.30 / p25 $16 / **median $49.5** /
p75 $75 / max $1,503.

- **$50 floor** — loses **55.6%** of the 45-city panel (754 → 335 rows). Survivors still straddle zero.
- **$150 floor** — **every cell across all 14 runs** falls under the §9R-E floor (n = 2 to 24). Unreadable.

This is the same capacity wall that killed the cross-venue signal (`CROSS-VENUE-SPIKE.md`, trap #8).

## 5 · H3 — hold to resolution

**Clear loss.** All four 45-city panels at the $0 depth floor exclude zero on the negative side: **−4.30¢ to
−5.57¢/share** (45c M0 strict −5.57¢, CI [−7.81¢, −2.75¢]). You pay ~18¢ for a bucket that wins ~13% of the
time. Not close, and not rescued by any depth floor.

Note the arithmetic that makes H2 and H3 consistent: the same 2–3¢ overpricing that makes NO *nearly* work is
exactly what makes HOLD lose. They are the two sides of one measurement.

## 6 · Two methodology catches (worth more than the numbers)

**① Silent select-rule contamination.** A `selectRule` returning `null` meant *"fall back to forecast argmax"* —
so M1–M4 were silently **becoming M0** at every tick their rule was quiet, worst exactly where the market
signal is weakest. Every market-signal trade was partly a forecast trade wearing a different name, and the
blend was flattering the market arms. Fixed behind a `requireRuleTarget` opt (**default off**, frozen behavior
untouched; **on** for M1–M4). Pinned by a test demonstrating both the contaminated and the pure outcome.
Without this fix the run would have reported "market selection ≈ neutral" — a pure artifact.

**② An underpowered constant-outcome cell that read as a screaming PASS.** The first pass produced
*"NO, $150 floor, +16.02¢/share, CI [+13.24¢, +18.44¢], POSITIVE_EXCLUDES_0."* It is not a finding: **n=10 and
all 10 won**. With zero outcome variance the clustered t-CI collapses to measuring *price dispersion*, so it
"excludes zero" regardless of how few rows produced it. Three more cells had the same shape (M2-off $150: 15
rows, 100% win, +16.59¢; M3-off $150: 3 rows; M3-on $150: 2 rows). Rather than caveat it in prose, the guard
went **into the tool**: every cell is checked against the §9R-E floors (n≥40 / ≥6 cities / ≥7 days) plus a
constant-outcome check, and a failing cell prints its numbers **without a sign read**, labelled
`✗ UNDERPOWERED · CONSTANT OUTCOME`. Pinned by a test constructing exactly that 10-row all-winners cell.
**Under that rule no cell anywhere in the 14 runs shows a readable positive.**

This is trap #11 (wrong estimator for the shape) in a new costume, and it is the same failure mode that made
the CHEAP longshot cell in §4 look positive — breakeven needs P < 1.13%, observed was 0.96% on **4 winners in
415**, Wilson upper 2.45% = more than double breakeven. Nothing was established there either.

## 7 · Traps ruled out, and caveats that stand

| Trap | How it was handled |
|---|---|
| #1 synthetic vs real book | **Real captured book throughout** — the observed per-tick bid/ask from `opening_captures`, never a constructed one. This is the trap that produced the maker-exit false PASS. |
| #3 frictionless vs taker-consumed | Round-trip taker fee on both legs + the spread crossed; the §4 decomposition reports the bias against the half-spread explicitly. |
| #6 in-sample overfit | Headline is the **pre-registered** TP 0.25 and the M0 control. No rule or band was selected on its point estimate. |
| #8 proxy depth | Executable depth walked for the traded size; NO priced on the **bid**-side depth, with $0/$50/$150 sensitivity. |
| #10 pseudo-replication | **City- and day-clustered** CIs on every cell, using the gate's own `clusteredMeanCi` (now exported and shared, so the arms and the gate cannot drift by a t-table row). |
| #11 wrong estimator | Wilson for proportions, mean±z·SE for the paired gap, seeded bootstrap for the NO tail; plus the new underpowered/constant-outcome guard (§6②). |
| Look-ahead | Rules receive `ticks[0..i]` only, enforced by slicing before the call; exit at tick t reads only tick t. |

**Caveats that stand and are not resolved by this run:**

- **M3 is a PROXY, not the floor rule the handoff imagined.** The per-tick running-max floor is **not** in the
  archive rows. The substitute (one rung above the highest bucket bid ≥0.90) degenerates at cheap early ticks
  to *"one above the coldest quoted rung"* — close to buying the least likely bucket on purpose, which is why
  M3-strict is the worst cell in the grid (−59.9%). Do not read M3 as a test of the floor-adjacent idea.
- **M4 is NOT like-for-like.** Δ`bestBid` first→entry is identically 0 because the entry tick *is* the first
  captured tick, so M4 was respecified to baseline on tick 1 and enter no earlier than tick 2. It therefore
  enters later than the other rules.
- **The NO book is assumed to be the mirror of the YES book** (a bid on YES at 0.20 *is* an ask on NO at 0.80 —
  complementary CTF tokens). negRisk conversion and separately-quoted NO liquidity could break this. The
  conclusion is NULL/KILL under the assumption's *most generous* reading, so breaking it cannot rescue the arm.
- Book fields snapshot the **fill** tick, matching the existing `entryPrice`/`entryAgeH` convention. 74 of 159
  headline fills were makers, so fill and decision ticks genuinely differ for a large minority.

## 8 · Carry-forward

- **No arm earns a forward paper test.** H1 and H3 are KILLs; H2 is a powered NULL, and a null does not earn
  capital — it earns being written down. Signal #12 stays dead with **no scoped exception pending**; reopen
  only per `SIGNAL-BACKLOG.md` §13.
- **The one structural door, unchanged and still shut:** every convergence result now says *maker, not taker*.
  The bias exists (2–3¢) but sits inside the spread. Capturing it requires **resting** orders that fill — and
  the forward maker-exit gate already measured the real-book fill rate at **6.5%** (vs 49% synthetic), which is
  why that arm died. Nothing here changes that mechanism; a tripwire on it already exists (`EDGE-WATCH-LOOP.md`
  tripwire ①).
- **The tooling is durable and reusable**: an archive loader that merges both dumps, a select-rule seam that is
  backward-compatible by default, per-trade row emission that makes any future side-arm pure arithmetic rather
  than a new engine, and two guards that now fail loudly instead of producing false positives.

## 9 · Reproduce

```bash
# bracket grid (one cell)
pnpm tsx scripts/research/convergence-capture-score.ts --select M1 --house-edge off \
  --cities bot --fee-rate 0.05 --min-depth 50 --out scripts/research/out/cap-M1-off.json

# NO / HOLD side arms off the emitted per-trade rows
pnpm tsx scripts/research/convergence-side-arms.ts --out scripts/research/out/side-arms-full.json

# the unfiltered-ladder cheap gate
pnpm tsx scripts/research/convergence-no-side-gate.ts
```

**Artifacts:** `scripts/research/out/side-arms-full.json` (14 runs × 9 arm×depth cells) ·
`side-arms-M0-M1.json` · `cap-M{0,1,2,3,4}-{on,off}.json` · `cap-all-M{0,1}-{on,off}.json` ·
`convergence-no-side-gate.json`.

**Verification at close:** `pnpm typecheck` clean · `pnpm test` **203 files / 3,421 tests / 0 failed**
(baseline 3,397 — +24 new tests, no regression, which is what confirms the seam and the gate refactor are inert).

**Boundary held:** read-only throughout. Nothing placed, `packages/trading` never imported, no credentials read,
writes confined to `scripts/research/out/` and this doc.
