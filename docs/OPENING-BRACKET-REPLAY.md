# Opening-Bracket Replay — the bracket-EXIT realized-P&L screen

> **What it is.** A read-only, keyless paper *replay* that measures the **bracket-exit** variant of the
> 12th signal (opening convergence): buy our forecast-center temperature bucket when its executable ask is
> cheap, then **sell into the convergence** — on a fixed take-profit / stop-loss / station-local-noon
> time-stop — *before* resolution, walking the captured per-tick order book tick by tick. It answers the
> one thing the hold-to-resolution scorer cannot: does the **bracket exit** net positive after spread +
> fees + the stop-loss leg — i.e. is there a convergence *re-rating* edge that does **not** depend on the
> forecast being correct at resolution.
>
> Status: BUILT + TESTED + VERIFIED (typecheck clean, full suite **1671 green**; engine independently
> re-audited for the no-look-ahead invariant; runs live read-only end-to-end). Read-only, keyless, places
> NOTHING. Verdict defers to the §9R-E `openingVerdict` cluster gate + the operator. No capital moves on this
> screen. First live read (2026-06-28, ~26h panel): only 2 §9R fresh markets enterable+filled → `INSUFFICIENT_DATA`
> by design (needs ≥40 markets / ≥6 cities / ≥7 days); keep capturing.

---

## Why this exists

This project falsified a tradable forecast edge **eleven** ways (`FINDINGS.md`). The 12th lever —
opening convergence — had its **flat-open premise falsified 2026-06-28**: the first full-universe capture
(51,880 snapshots / 147 markets / 45 cities / 26h) showed weather markets list **pre-informed** (0 of 147
flat at first sight; peak bucket median ~27%, never the ~9–12% the original "buy the flat open" thesis
needed).

But the convergence itself is **real and directional** (peak +16pp first→last, 117/147 up), and a forward
mark-path probe over the captured data showed the **bracket-exit mechanism has a pulse**:

- on the enterable-center subset the realizable `execBid` **re-rates UP in ~79%** of events,
- a profitable sell-back **existed in ~62%**,
- the **avg best round-trip was +10.4pp** vs the entry ask —
- **but only ~12% reached** the configured **+25pp** take-profit.

"A profitable exit *existed*" is a **look-ahead ceiling**, not a capture rule. This replay applies the
**REAL fixed bracket rule** (no look-ahead) for the honest net P&L, and **sweeps the take-profit** to see
whether a *lower* TP harvests the convergence better than +25pp.

This is distinct from `opening-resolution-score.ts`, which scores the **hold-to-resolution** bet (does our
forecast-center bucket *win* more often than it costs at settlement — the pure forecasting-edge question).
That entry rule reduces to the forecast-vs-market bet already falsified 7×. **This** screen tests the
orthogonal question — the trade-around-the-re-rating — and so is worth measuring on its own.

---

## The exact strategy it measures

1. **Buy cheap forecast-center.** At the first *enterable* tick, select the buckets our `house_gaussian`
   mode ± `centerHalfWidth` covers, gated exactly as the live bot does **minus the flat-open gate**:
   a finite `houseProb`, `execAsk > 0`, `execAsk ≤ min(maxEntryPrice, houseProb − entryEdgeMargin)` (the
   20% hard cap + the edge margin), and `depthUsd ≥ depthFloorUsd`. The **forecast center** = the
   highest-`modelProb` (argmax `houseProb`) candidate. **One entry per event** (the first enterable tick) —
   never multiple correlated intra-event re-entries.
2. **Sell into the convergence.** Walk the captured per-tick series forward from the fill, feeding each
   tick's realizable `execBid` to `bracketDecision`, and exit on the **first** of:
   - **take-profit** — mark ≥ entry + `tpDeltaPp`, OR (if `tpAtModelProb`) mark ≥ our model prob;
   - **stop-loss** — the F13/F1 TERNARY stop (the operator-locked −12pp wherever entry > 0.12, else the
     relative floor `entry × (1 − slFrac)` for the cheapest band);
   - **time-stop** — the DST-correct **station-local-noon** flatten (`localHourInstant`, via `bracketDecision`).
3. **Settle whatever is still open** at series end at the venue/truth winner ($1 / $0), or — if unresolved —
   mark conservatively to the last realizable `execBid`. Most positions close on the time-stop *before*
   resolution.

---

## Design + semantics

The pure engine is **`packages/core/src/sim/opening-bracket-replay.ts`** (`replayEvent`, `replayPanel`);
the read-only harness is **`scripts/research/opening-bracket-score.ts`**. The split mirrors the existing
`opening-convergence.ts` / `opening-resolution-score.ts` pair.

**One source of truth.** The engine **reuses** the existing pure functions verbatim — `selectEntries`,
`bracketDecision`, `paperFill`, `openingVerdict` — and is *only* the per-tick lifecycle around them. The
**single** change to `opening-convergence.ts` is an optional 4th parameter:
`selectEntries(cap, cfg, now, opts?: { requireFlatOpen?: boolean })`, defaulting `requireFlatOpen` to
**TRUE** so every existing caller + test is byte-identical. When `false`, only the flat-open gate line is
skipped — the universe, runway, mode, edge, depth and 20%-price-cap gates are all intact.

**Per-event tick replay.** `replayEvent(input, cfg, tpDeltaPp)`:
- finds the **first enterable tick** via `selectEntries(..., { requireFlatOpen:false })`;
- runs the **maker-first fill lifecycle** — rest at `makerLimit`; over later ticks `paperFill` maker if a
  later ask trades **through** the limit within `makerFillWindowMin`, else **cancel + taker fallback**
  (the `cancel_maker_take` path, `paperFill` taker = worse-of stored/live ask + slippage + taker fee);
- walks ticks forward calling `bracketDecision` until an exit fires; the exit fills at that tick's
  `execBid` and pays a **taker fee on the exit** (a sell into the bid);
- settles leftover-open at resolution ($1/$0, no taker fee — a redeem) or marks to the last `execBid`.
- Returns a `BracketTrade` (`executed:false` if never filled, dropped from the verdict).

**Spread + fees are real.** BUY at the executable ask (taker) or the maker limit; SELL at the executable
**bid** (`execBid`, invariant F1). Fees via `takerFeePerShare(price, rate)` = `rate·p·(1−p)`
(`packages/core/src/fees.ts`). **Maker fills pay $0** fee.

**Panel + verdict.** `replayPanel(events, cfg, tpValues)` runs `replayEvent` for every event × every swept
TP; per TP it assembles `OpeningMarketResult[]` (executed trades only feed the verdict) and calls the
**frozen §9R-E `openingVerdict`** (city-clustered CI + the cluster-preserving sign-flip zero-skill MC).
The **headline** is the row at the pre-registered bot-default `tpDeltaPp` (**0.25**) — that row is THE GATE;
the rest of the sweep is **exploratory**.

---

## The NO-LOOK-AHEAD guarantee + the ceiling-vs-capture gap

The exit decision at tick *t* reads **only** the `execBid` mark at *t* + the wall clock at *t*. The series
is walked in strict time order and the exit loop **breaks at the first firing** — a later up-tick can
**never** rescue a trade that already stopped out. The single legitimate use of a later tick is the
maker-fill model: a resting maker BUY fills only if a *later* ask trades through the limit (the order rests
in the book — realistic `paperFill` maker semantics, not look-ahead).

`bestReachableBid` (the max `execBid` after entry) is computed in a **separate pass** and is **REPORT-ONLY**
— it is the look-ahead ceiling a *perfect* sell-back could have realised, and it **never touches a
decision**. The report prints both:
- **`ruleCaptureRoi`** — what the **fixed rule actually caught** (mean realized net ROI over executed trades);
- **`avgBestReachableRoundtrip`** — the **ceiling** (mean `bestReachableBid − entryPrice`).

The **gap** between them is the unharvested re-rating headroom — a tighter TP *might* close some of it, but
**selecting that TP in-sample is the winner's-curse** and is never a GO. The NO-LOOK-AHEAD property is pinned
by a dedicated test: a huge up-tick *after* a stop-loss fired must not change the realized exit, though
`bestReachableBid` records it.

---

## How to run

```
pnpm tsx scripts/research/opening-bracket-score.ts --days 3 --fee-rate 0.05
```

Flags:
- `--days` (default **3**) — look-back window. The query filters to the §9R allowlist cities' fresh events
  SERVER-SIDE, so the payload stays small regardless of the 45-city capture universe (the live panel is ~26h today).
- `--fee-rate` (default **0.05** = the real weather taker rate) — a FRACTION feeding `rate·p·(1−p)`; the
  bracket pays it on its **taker legs** (a taker-fallback entry + every bracket-exit sell). Maker fills pay $0.
- `--min-depth` (default **50**) — the executable-depth floor on a scored entry (the capacity-wall discipline,
  matches the bot's `depthFloorUsd`).
- `--tps` (csv, default `0.06,0.08,0.10,0.12,0.15,0.20,0.25`) — the take-profit sweep. The headline 0.25 is
  always added to the sweep even if omitted.

It reads the per-tick series with a **direct, targeted query** (mirroring `opening-resolution-score`'s
`loadRows` idiom, NOT the `bot_capture_series` RPC): a `fresh` CTE restricts to the **§9R allowlist cities**
(`cfg.cities`) AND the **FRESH universe** (events with min `hours_since_listing < 1`) **server-side** — so it
never hauls the whole 45-city universe (a full-universe fetch both hangs on ~175 MB of aggregated jsonb AND
would inflate `exec%` with structurally-unenterable non-allowlist markets). Numerics are `::float8`-cast and
timestamps `::text`-cast so the TS finite/fresh gates + `new Date()` see numbers/ISO, not pg `numeric` strings or
a Date object. It groups rows by `eventId` ordered ASC by `capturedAt`, and separately fetches a resolution map
from `market_events` (`winnerIdx = poly_resolved_winner_idx ?? winning_bucket_idx`, `gradingMismatch`).
Read-only, keyless — places NOTHING, writes NOTHING, never imports `packages/trading`.

---

## How to read the output

**The per-TP table** (one row per swept take-profit, `*` marks the headline 0.25):

| Column | Meaning |
|---|---|
| `TP` | the swept take-profit delta (pp) |
| `nMkts` / `cities` / `dates` | the **REALIZED**-market panel size + its independence spread (in-flight marks excluded) |
| `exec%` | share of considered markets the bracket rule actually **entered** (fill happened — incl. still-in-flight) |
| `winFrac` | fraction of realized markets with net P&L > 0 (bar 0.50) |
| `meanNetRet` + `CI95` | city-clustered mean net return + its 95% CI (the gate looks at `ciLow > 0`) |
| `zsMC` | the cluster-preserving sign-flip zero-skill MC pass-rate (bar < 5%) |
| `ruleRoi` | what the FIXED rule caught (`ruleCaptureRoi`) |
| `ceiling` | the look-ahead best-sell-back ceiling (`avgBestReachableRoundtrip`) — REPORT-ONLY |
| `verdict` | the §9R-E `openingVerdict` label at that TP (PASS / KILL / INSUFFICIENT_DATA) |

**The headline verdict** is the row at the **pre-registered bot-default TP (+25%)**, under the
`openingVerdict` floors: ≥40 **realized** markets, ≥6 cities, ≥7 distinct days. Below any floor it reads
**INSUFFICIENT_DATA by design** — that is expected until enough markets are both *entered* and *closed*.

**Limits — read these before drawing any conclusion:**
- The **TP sweep is EXPLORATORY.** Picking the best TP in-sample is the winner's-curse; a low-TP "PASS"
  requires **OOS re-validation** and is never promoted to a GO. Only the +25% headline row is the gate.
- A PASS at the headline is **necessary, not sufficient** — the whole screen **defers to the §9R-E
  `openingVerdict` cluster gate + the operator** for any capital decision. This script decides **nothing**
  about capital.
- `grading_mismatch` events (ambiguous payout) are **excluded** from scoring entirely.
- **REALIZED-ONLY gate (2026-06-29).** The §9R-E verdict scores only **closed** markets — bracket-exited
  (TP/SL/time-stop) or resolution-settled. Still-in-flight positions conservatively marked-to-bid
  (`mtm_unresolved`) are **entered** (they count toward `exec%`) but **excluded** from `nMkts`/`winFrac`/the
  CI/the label. Rationale: the gate certifies *closed* net profit and can never PASS on an unrealized mark (the
  one path to a false-GO); the in-flight tail self-realizes within ~24h (the noon time-stop), so the ≥40 floor is
  reached on closed markets regardless.
- **Post-realization curve (2026-06-29).** Each realized bracket exit also records `postExitBestBid` /
  `postExitWorstBid` — the best & worst value the market reached *after* we closed (later bids + the resolution
  terminal). REPORT-ONLY (never a decision); it powers the `/convergence` "Exit timing" panel (did we close too
  early?) and the per-row post-exit bar.
- The `ceiling` column is a *diagnostic*, not a strategy — it is what a perfect (impossible) exit would have
  realised. The gap to `ruleRoi` is the unharvested headroom, nothing more.
- The **maker entry fill is modeled at top-of-book** (`makerLimit = min(reservation, bestAsk)`, full size, $0
  fee — the shared-core `paperFill` / `selectEntries` assumption, partially guarded by `depthFloorUsd`). That is
  mildly **optimistic on the entry leg** (a size-walked fill would be worse), so it biases results *positive* and
  is conservative-safe while the read is negative — but a marginal-positive PASS would warrant a size-walked entry
  model before it is trusted. (Independent re-audit 2026-06-28 confirmed the no-look-ahead invariant CLEAN; this
  fill-optimism was the only modeling caveat it surfaced.)

---

## The `/convergence` dashboard is INDICATIVE, not the authoritative gate

The `/convergence` page (migration 0069 + the `convergence-panel` Edge tick) runs the **same engine**
(`buildConvergenceView` → `replayPanel`/`replayEvent`) but on **downsampled** inputs — `convergence_capture_inputs`
keeps ~every-3rd tick (`rn % 3 = 1 OR rn = cnt`, ~6-min resolution) so the isolate stays light. That downsample
is the one divergence vector from this full-fidelity scorer, and it is **two-sided**:

- **maker → taker**: the resting maker gets fewer through-the-limit chances before the 15-min window forces a
  taker fallback, so the dashboard over-converts to taker fills (extra slippage + fee → P&L biased **down**).
- **missed intra-window breach**: a stop-loss dip (or take-profit spike) that occurs and recovers **between** two
  6-min snapshots is missed, so the panel can read **more optimistically** than this scorer (the false-PASS
  direction for the `ciLow > 0` test).

The §9R-E **count** gate (≥40 markets / ≥6 cities / ≥7 days) is robust — the stride always retains each event's
first (`rn=1`, the freshest tick) and last tick, so the counts cannot flip from downsampling; only the PASS/KILL
discrimination at n ≥ 40 can drift. The page therefore labels its gate **indicative** and names this scorer as the
**binding** verdict. `grading_mismatch` markets are excluded identically in both (the dashboard view derives
entries / money / per-day / gate from the same gm-excluded population the verdict uses).

## Relationship to `opening-resolution-score.ts`

| | `opening-bracket-score.ts` (this) | `opening-resolution-score.ts` |
|---|---|---|
| **The bet** | sell into the convergence **before** resolution (the bracket EXIT) | buy-and-**hold to resolution** |
| **The question** | is there a **re-rating** edge net of spread + fees + the stop leg? | does our forecast-**center win** more often than it costs? |
| **Depends on the forecast being right at settle?** | **No** — it trades the price path | **Yes** — it IS the forecasting-edge test |
| **Exit** | TP / SL / station-local-noon time-stop (`bracketDecision`) | resolution settlement |
| **Verdict** | §9R-E `openingVerdict` (city-clustered CI + zero-skill MC), headline at TP +25% | per-bin GO/NO-GO + Šidák multiplicity headline |
| **Pure core** | `sim/opening-bracket-replay.ts` | inline in the script |

Both are read-only, keyless screens over the same captured panel; both defer to the §9R-E cluster gate +
the operator for capital. They measure **different bets** — running both is how the 12th signal gets a fair,
two-sided forward test before any verdict is written into `FINDINGS.md`.

---

## Files

- `packages/core/src/sim/opening-bracket-replay.ts` — the pure engine (`replayEvent`, `replayPanel`, the types).
- `packages/core/test/opening-bracket-replay.test.ts` — engine tests (entry on a non-flat book; maker vs taker
  fill; each exit; settle win/lose; grading_mismatch; never-filled; the TP sweep; the §9R-E labels; NO-LOOK-AHEAD;
  totality).
- `scripts/research/opening-bracket-score.ts` — the read-only harness (RPC read, raw→core mapping, `report()`,
  `sanity()`, the CLI).
- `scripts/research/opening-bracket-score.test.ts` — harness tests (row mapping, grouping + FRESH filter,
  `report()` totality, the `sanity()` self-test).
- The single edit to `packages/core/src/sim/opening-convergence.ts`: the optional `requireFlatOpen` 4th param
  on `selectEntries` (defaults TRUE — every existing caller/test byte-identical).
