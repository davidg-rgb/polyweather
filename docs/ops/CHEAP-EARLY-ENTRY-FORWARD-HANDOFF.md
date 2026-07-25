# CHEAP-EARLY-ENTRY — forward paper test: BUILD + DEPLOY handoff (prepped 2026-07-25)

> **For the next run (clean context, possibly switched model).** Self-contained. Goal: build + deploy a
> **forward paper panel** that scores the operator's cheap-early-entry strategy live, so the §9R-E gate can
> adjudicate it on real forward books. **Paper only — no capital, no trade, no credentials.** The verdict that
> earned this test: `docs/ops/CHEAP-EARLY-ENTRY.md` (INSUFFICIENT-but-not-dead; the first cheap-buy variant to
> survive its cheap gates). This is a **scoring layer on the capture stream that already runs**, not new capture.

## 0 · The frozen strategy (do not re-tune during the build — the point is to test THIS)

- **Universe:** the 4 live cities (`ankara, helsinki, kuala-lumpur, wellington`). **Widening to more cities is
  the one allowed variation** — it raises the fire rate and powers the gate sooner (the mechanism isn't
  city-specific). If you widen, make it a config list, default the 4, and record which set each snapshot used.
- **Pick:** `argmax(houseProb)` from the `opening_captures` bucket seed (the SAME seed the buy lane/convergence
  bot uses — do NOT swap to the calibrated forecast; the archive's `houseProb` is the pick of record).
- **Entry window:** `hoursToClose ∈ [24, 36]` (the liquid, best-looking cell; NOT the final [2,12]h, NOT the
  thin open [36,60]h). Take the capture closest to 24h (latest allowable entry in-window), no look-ahead.
- **Price gate:** enter iff `bestAsk ∈ [0.20, 0.33]` AND `depthUsd ≥ stake` (paper stake e.g. $20; ~99% of
  in-band picks clear $5, but enforce the depth gate so a thin pick doesn't count as fillable).
- **Fill/exit:** paper-buy at `bestAsk` (taker), pay the frozen taker fee, **hold to resolution** (no TP/stop).
- **Grade:** `won = (pick temperature == winning temperature)` — parse the integer from the label, **never the
  bucket index** (sort-safe join; traps #7). Net per $1 = `won/bestAsk − 1 − takerFee(bestAsk)/bestAsk`.

## 1 · Reuse the maker-exit forward loop pattern (closest analog — do NOT invent a new shape)

The maker-exit forward panel is the template. Mirror it:

| Piece | Maker-exit analog | Build for cheap-early |
|---|---|---|
| pure engine | `core/sim/opening-maker-exit-replay.ts` (`replayMakerExitEvent`) | `core/sim/cheap-early-entry-replay.ts` — `replayCheapEarlyEvent(ticks, resolution, cfg)` → `{entered, entryAsk, depth, won, netReturn}`; pure, no I/O, unit-tested |
| view/aggregate + gate | `core/sim/opening-maker-exit-view.ts` (`buildMakerExitView`) | `buildCheapEarlyView(events, cfg)` → per-entry rows + `openingVerdict(...)` (§9R-E) |
| snapshot table + RPC + gate write | migration `0073` (`maker_exit_panel`, `dash_maker_exit`, forward `bot_gate_snapshot`) | new migration (next number) `cheap_early_panel` + `dash_cheap_early` + `bot_gate_snapshot` rows tagged `source='forward'`, a distinct strategy label |
| edge fn (cron) | `maker-exit-panel` (*/15) | `cheap-early-panel` — pick a CLEAN minute lane (NOT :00/:15/:30/:45 — the Micro-pileup gotcha, memory `cron-minute-lane-stagger`); hourly is plenty (the panel only changes as events resolve) |
| dashboard | `/maker-exit` | `/cheap-early` (or fold into an existing analytics page) — headline the gate verdict + n/cities/days + the money curve |

**Data seam:** the panel re-replays the live `opening_captures` stream (already captured, 45 cities, 5-min)
joined to `market_events` resolution (`winning_bucket_idx` → label). Same inputs the convergence/maker-exit
panels read. No new capture, no new cron on the capture side.

## 2 · The gate of record (unchanged discipline)

`openingVerdict` / `analytics.py gate`: sufficiency **n≥40 markets / ≥6 cities / ≥7 days**, `winFrac ≥ 0.5`
is NOT the bar here (this is a price-return bet, not a bucket-hit bet) — bind on **city-clustered mean
net-return `ciLow > 0`** + the **zero-skill sign-flip MC < 5%**. Write each snapshot's verdict to
`bot_gate_snapshot(source='forward')`. **No capital before a frozen PASS across ≥2 non-overlapping windows +
explicit operator go** (the standing rule). Expect ~2 months at 4 cities to reach the sufficiency floor
(~0.6 qualifying entries/day); widening cities shortens this.

## 3 · Build checklist

1. `core/sim/cheap-early-entry-replay.ts` + `buildCheapEarlyView` — pure, with unit tests (degenerate cases:
   no in-window capture → no entry; ask out of band → no entry; thin depth → no entry; win/lose grading;
   fee math pinned). Copy the skeleton + `RESULT {json}` contract from `opening-maker-exit-replay.ts`.
2. Migration (create-or-replace / if-not-exists / on-conflict; object-envelope RPCs, no top-level jsonb
   arrays — the 0081 idiom): `cheap_early_panel` snapshot + `dash_cheap_early` read RPC + forward
   `bot_gate_snapshot` writes + config defaults (`cheap_early.window_h=[24,36]`, `.ask_band=[0.20,0.33]`,
   `.cities`, `.stake_usd`, `.enabled`). **Not applied** until operator deploy.
3. Edge fn `cheap-early-panel` + `config.toml` (`verify_jwt=false`, clean minute lane).
4. `/cheap-early` dashboard page (renders "migration NOT APPLIED" until deployed — mirror `/trading`).
5. `pnpm test` + `pnpm typecheck` green after every change.

## 4 · Deploy (operator-gated, at the end)

Apply the migration → deploy the `cheap-early-panel` edge fn → verify one tick writes a `cheap_early_panel`
snapshot + a `bot_gate_snapshot(source='forward')` row → then it accrues on its own; the gate adjudicates at
the sufficiency floor. **Boundary: paper only. Claude never trades, never touches credentials; the operator
funds/keys/authorizes any future capital step — which is gated on a frozen PASS, not on this build.**

## 5 · Gotchas to respect (from memory / this session)

- **Grade by temperature label, not bucket index** (the enriched-archive index-space trap #7).
- **Cron minute-lane stagger** — never :00/:15/:30/:45 for a heavy fn (memory `cron-minute-lane-stagger`).
- **Freshness** — the pick bucket in [24,36]h is liquid (depth $130–310 median), but still take the capture
  *closest to the window*, and skip an event with no in-window capture rather than reaching outside it.
- **Slack is dark (C16)** — no new alert kind needed; if you add one it must be allowlisted or it's silently
  suppressed (memory `slack-alert-allowlist-gotcha`). The panel is pull-only (dashboard + gate snapshot).
- **Reproduce/backtest reference:** `scripts/research/cheap-entry-realbook.py` is the offline twin — the
  forward engine must agree with it on a shared event set (a cheap regression check).
