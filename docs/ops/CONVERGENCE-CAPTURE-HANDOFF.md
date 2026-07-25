# CONVERGENCE-CAPTURE — analytics-run handoff (prepped 2026-07-24 for a fresh session)

> **Read this top-to-bottom. It is self-contained.** It was written to hand a NEW session (different model,
> clean context) everything needed to run one specific analytics investigation correctly, without re-deriving
> context. You build software and run read-only analysis. **You never place a trade, never touch credentials,
> never reactivate `packages/trading`.** Load the `betting-market-analytics` skill first (`Skill` tool) — it is
> the house analyst playbook this run follows.

---

## 0 · The ask (operator, 2026-07-24)

> *"The play is to bet what the market will guess the max temperature will be, catch the guess at an early
> cheap stage and sell it as it enters higher likelihood."*

Translate to a testable bet:

> **On a freshly-listed daily-Tmax market, buy — while it is still cheap at the flat-ish open — the bucket the
> MARKET will converge toward, and sell it as its price re-rates UP (into higher implied likelihood), for a net
> profit after real round-trip costs at executable depth.**

The novel word is **MARKET**. Every prior convergence run picked which bucket to buy from *our forecast*. This
run picks it from *the market's own revealed signal* (the bids). That single swap is the whole point — see §4.

---

## 1 · Why this frame is correct (what the last session verified)

Do not re-derive this; it is settled and it is WHY the operator reframed:

- The Google buy/sell paper track's "win rate" (~40%) is **not** a forecast-accuracy rate — it is a
  **convergence rate**. Verified against the engine (`packages/core/src/sim/google-bucket-replay.ts:394–426`):
  a "win" = `take_profit` (the bid rose to ≥ 0.30 and we SOLD before resolution) **or** `resolution_win` (held
  to settle and the bucket won).
- Of the "wins", **~93% were `take_profit` convergence sells** (28 of 30, deduped) — we banked the price bump
  and never verified whether the bucket would have won. Of the trades actually **held to resolution, only
  ~5% won** (2/41) — and that pool is adversely selected (the likely-correct ones got sold early as TP), so 5%
  is a floor, not the unconditional forecast hit rate.
- Conclusion the operator drew (correctly): **the money in this strategy is the convergence re-rating, not
  correct temperature calls.** So test the convergence-capture on its own terms — and pick the bucket the way
  the *market* reveals it, not the way our forecast guesses it.

---

## 2 · What is ALREADY DEAD (do NOT re-run these — cite them)

Signal #12 (opening convergence) is the canonical falsified signal. Read `FINDINGS.md` + `SIGNAL-BACKLOG.md`
before spending effort. The convergence-capture specifically has died in these forms — with numbers:

| Form | Verdict | Doc |
|---|---|---|
| Buy forecast-center cheap, **TAKER** sell into convergence | **KILL** — edge is REAL (+8.2% frictionless) but the taker round-trip **spread eats it** (breakeven ×0.70 of the real spread) | `CONVERGENCE-TUNING.md` (708 events) |
| Same, **MAKER** exit (rest the sell, $0 fee + rebate) | Flips +EV frictionless (+5.1%) but the **forward gate KILLed −12.6%** — resting sells almost never fill on the real efficient book (`makerFillRate` 6.5% live vs 49% in the synthetic backtest) | `MAKER-EXIT-SIM.md`, `01 Memory` [[maker-exit-synthetic-vs-real-book]] |
| Google-forecast-seeded, taker convergence | **KILL** (last full read 2026-07-21: n=53, winFrac 45.3% < 50%) | this session's chat + `google_paper_panel` |
| Seed = `ensemble_raw` vs `calibrated` vs `house_gaussian` | calibrated out-selects (73.9% vs 52.8%) but still **KILL** | `CONVERGENCE-TUNING.md` |

**The vise that kills it every time:** taker-exit → you cross the spread and it eats the edge; maker-exit →
the resting sell doesn't fill on an efficient book. Escaping that vise is the bar. If this run does not escape
it, the honest answer is **KILL** and you say so and cite these.

**The specific capture gap to attack** (from `scripts/research/opening-bracket-score.ts` header, measured on
the real book): the bracket mechanism has a pulse — execBid re-rates UP on **~79%** of enterable events, a
profitable sell-back **existed ~62%** of the time, avg best round-trip **+10.4pp** vs entry ask — **BUT only
~12% reached the +25pp take-profit under the REAL no-look-ahead rule.** "A profitable exit existed" is a
look-ahead ceiling; "our fixed rule captured it" is the real number. The gap **62% → 12%** is the money left
on the table. This run asks: **does picking the bucket by market signal (not forecast) — and/or a smarter
exit — close that gap enough to clear the gate net of the spread?**

---

## 3 · The genuinely-new content (why this earns a run despite the KILLs)

1. **Market-signal SELECTION instead of forecast selection.** Prior runs bought `argmax(houseProb)` (our
   model's mode). This run buys the bucket the *market* points to — highest early bid, market-implied mode,
   floor-adjacent, or early momentum (§6). Un-run. The cost structure is unchanged, so the prior says this
   probably still dies — but if market-selection yields cheaper entries or a materially higher capture rate,
   the arithmetic could shift. That is the empirical question.
2. **Honest full-population accounting with the resolution tail.** Score the WHOLE population: TP-captured
   winners (+) AND the non-converging tail held to resolution (−, mostly $0). Does the capture cover the tail
   NET, at executable depth + real round-trip taker cost? (The archive carries the winner — see §5 — so this
   is computable, unlike in the live cache.)
3. **Momentum-vs-information diagnostic.** Of the buckets we TP-sold, what fraction would have *won* at
   resolution? If most resolve to $0, the convergence is a transient bump we harvest (pure momentum); if most
   win, it is the market pricing in a correct outcome. Different mechanisms, same P&L — worth knowing.

---

## 4 · The one code change (the selection seam)

- Current selection: **`selectEntries`** in `packages/core/src/sim/opening-convergence.ts:432` →
  `modeIdx = argmax(b.houseProb)` (line ~465–470), then buys buckets within `modeIdx ± centerHalfWidth`
  whose `execAsk ≤ min(maxEntryPrice, houseProb − entryEdgeMargin)`.
- **This run swaps `modeIdx` from the forecast argmax to a MARKET-SIGNAL target index. Everything else — the
  entry cap, the depth floor, the exit bracket, the gate — stays identical** (that is what makes the
  comparison clean: selection is the only moving part).

The `OpeningBucket` fields you have per bucket per tick (confirmed present): `idx`, `label`, `bestBid`,
`bestAsk`, `mid` (implied-prob proxy), `execAsk`, `houseProb`, plus depth. No look-ahead: the target is
chosen from the ENTRY tick's book (M1/M2/M3) or from *earlier* ticks only (M4).

---

## 5 · Data + engines (all present, paths verified 2026-07-24)

**Data — the real bid/ask book:**
- Archive: `scripts/research/out/opening-captures-archive/` — **835 events / ~312k tick rows / 548 MB**,
  gzipped NDJSON shards + `_manifest.json` + `_events.json` (event-id list). This is the **only** historical
  bid/ask archive. (`opening-captures-archive-c96-20260707/` is the older pre-07-06 copy — ignore unless you
  need pre-06 history.)
- **The live `opening_captures` table is pruned to ~2 days** (storage tiering) — so the existing runner's
  DB query only sees ~2 days. **For the full 835-event history you MUST ingest the archive, not the DB.**
- **Resolution (`winnerIdx`)** is NOT in the archive; it comes from the persisted **`market_events`** table
  (`poly_resolved_winner_idx ?? winning_bucket_idx`), which is NOT pruned. Join archive-event → `market_events`
  by event id. ⚠ Check coverage first: not every archived event is guaranteed to have a `market_events`
  resolution row (the buy-table live universe is absent from `market_events`; the §9R convergence-panel
  universe should be present). Report the covered/uncovered split — silent drops bias the panel.

**Engines (reuse verbatim — do not reinvent):**
- `packages/core/src/sim/opening-bracket-replay.ts` — `replayEvent(input, cfg, tpDeltaPp)` + `replayPanel(...)`.
  The pure, no-look-ahead bracket lifecycle (entry → maker/taker fill → TP/SL/time-stop → settle). THIS is the
  engine. Its header documents the whole thesis.
- `packages/core/src/sim/opening-bracket-ingest.ts` — `buildEvents(rawRows)` maps raw capture rows →
  `EventReplayInput[]`. Point its input at the **archive shards** (decompress the NDJSON) instead of the DB
  query. This is the main integration task.
- `packages/core/src/sim/opening-convergence.ts` — `selectEntries` (the seam, §4), `bracketDecision`,
  `paperFill`, and **`openingVerdict`** (the FROZEN §9R-E gate — the source of truth).
- `scripts/research/opening-bracket-score.ts` — the existing runner. **Copy it** as the template; it already
  wires ingest → replayPanel → TP sweep → `openingVerdict`. Adapt: (a) read the archive, (b) add a `--select`
  flag choosing the M0..M4 target rule.
- `scripts/research/cost_model.py` — the CALIBRATED_BOOK cost mirror (import it if you cross-check in Python;
  every Python backtest must use it — zero-drift with the TS costs). Note: there is **no** `scripts/analytics.py`
  in this repo (the skill mentions one; it is absent) — the gate lives in TS `openingVerdict`.

---

## 6 · The run plan (execute in order)

**Step 1 — Baseline / control (works today, proves the pipeline).**
Run the existing forecast-seeded bracket scorer to reproduce the known control on the archive:
```
pnpm tsx scripts/research/opening-bracket-score.ts --days <N> --fee-rate 0.05
```
(`--fee-rate 0.05` = the real weather taker rate; it feeds `takerFeePerShare = rate·p·(1−p)` on every taker
leg. Maker fills pay $0.) This currently reads the live DB → adapt it to the archive first (see Step 0 below).
Record: TP-sweep table + the §9R-E verdict at the pre-registered `tpDeltaPp = 0.25` headline.

**Step 0 — Archive ingest (the integration task).** Add an archive loader: decompress
`opening-captures-archive/*.ndjson.gz`, feed rows to `buildEvents`, join `market_events` for `winnerIdx`.
Verify: event count ≈ 835 (minus resolution-uncovered), tick series ordered ascending, no look-ahead.

**Step 2 — Market-signal selection variants (the new content).** Add `--select` with these target rules
(the target index at the entry tick; everything else identical to baseline):
- `M0` (baseline): `argmax(houseProb)` — the forecast seed (control).
- `M1` bid-leader: `argmax(bestBid)` among buckets with `execAsk ≤ maxEntryPrice` — bet where the book's money
  already leans, while still cheap.
- `M2` market-mode: `argmax(mid)` — the market's own implied-probability mode.
- `M3` floor-adjacent: the bucket whose native range sits just ABOVE the current observed running-max floor
  (convergence flows here as the day heats). Needs the per-tick floor — if the tick lacks it, derive from the
  emerging bid mass (document the choice).
- `M4` momentum: over the first K ticks (past only — NOT look-ahead), `argmax(Δ bestBid)`.
Run each through the SAME `replayPanel` + TP sweep + `openingVerdict`.

**Step 3 — Gate + rigor (non-negotiable, per the skill's §6/§7).**
- **Executable depth**, not top-of-book — walk the book for the size traded (`execAsk`/`execBid`).
- **Round-trip cost** — taker fee on BOTH legs + the spread crossed. Report the breakeven spread multiple.
- **Cluster on the independent unit** — city (frozen gate) and `--day-block` (weather-days). N bets on 5 days
  is 5 observations, not N.
- **OOS** — train/test split by date; select any threshold by **max `ciLow`**, never max point estimate;
  label in-sample bests a winner's-curse ceiling.
- **The gate** — `openingVerdict` enforces ≥40 executed markets / ≥6 cities / ≥7 days, `winFrac ≥ 0.5`,
  city-clustered `ciLow > 0`, and the zero-skill sign-flip MC < 5%. A positive point estimate with a CI that
  includes 0 is a **KILL**, not "promising".

**Step 4 — Diagnostics (answer the mechanism, §3.3).** Per select-rule: re-rate-up rate, TP-capture rate,
avg entry price, hold-to-resolution win rate, and the would-TP-buckets-have-won-at-resolution fraction.

---

## 7 · Traps that have burned this exact analysis (pre-belief checklist)

Read `references/traps.md` from the skill. The ones most likely to bite THIS run:
1. **Synthetic-vs-real book** (`traps.md #1`) — the maker-exit backtest PASSed only because it replayed a
   synthetic forecast-centered book that converges by construction; the real efficient book does not. This run
   replays the REAL captured book — keep it that way. A PASS on anything synthetic is not a PASS.
2. **Mid-vs-real-book** — the one +EV cohort in the non-price hunt flipped +3.4% → −9.8% when scored on the
   real bid/ask at $2 depth. Score on `execAsk`/`execBid` at your size, never the mid.
3. **Look-ahead** — the exit at tick t reads ONLY tick t. "A profitable exit existed" (62%) is a ceiling, not
   a rule (12%). Selection M4 may read earlier ticks only.
4. **Day-clustering** — the panel spans few weather-days; correlated days masquerade as N. Use `--day-block`.
5. **Selecting the best TP / best select-rule in-sample** — that is the winner's-curse. The headline is the
   pre-registered rule (M0 baseline, `tpDeltaPp = 0.25`); anything else is exploratory and needs OOS + a
   forward paper test before it means anything.

---

## 8 · Success criteria + the honest prior

- **PASS** = at least one (select-rule × TP) cell clears `openingVerdict` at executable depth + real round-trip
  cost, city-clustered `ciLow > 0`, zero-skill MC < 5%, and **survives OOS** (selected by `ciLow`, confirmed on
  held-out dates). A PASS earns a **forward paper test ×2 non-overlapping windows + explicit operator go** —
  **never capital directly** (backtest ≠ GO; the forward gate is the gate of record).
- **Honest prior:** most likely **KILL**. The market is efficient; the convergence edge is real but the taker
  spread eats it and the maker leg doesn't fill. Market-signal selection changes *which* bucket, not the cost
  structure — so unless it produces a materially bigger frictionless edge or cheaper/higher-capture entries,
  it dies at the same vise. Say KILL plainly if that is the result; the value is the clean, powered record.
- **What a surprise would look like** (worth escalating): a select-rule where the frictionless edge is large
  enough that even after the full real round-trip spread the clustered `ciLow > 0` OOS — i.e., market-selection
  catches the convergence from a **cheaper** entry than the forecast seed does. That is the only door.

## 9 · Deliverable + boundary

- Write the verdict to `docs/ops/CONVERGENCE-CAPTURE-RESULTS.md` (hypothesis, panel n/cities/days, numbers with
  CIs, which traps you ruled out, GO/KILL, carry-forward). Emit the machine artifact to `scripts/research/out/`.
  Update `FINDINGS.md` / `SIGNAL-BACKLOG.md` with the one-liner. Lead the operator report with the verdict + the
  number, blunt.
- **Boundary (non-negotiable):** read-only. Reads the archive + `market_events` + writes only to
  `scripts/research/out/` and the verdict doc. Never place/cancel an order, never touch `packages/trading`,
  never read credentials.
