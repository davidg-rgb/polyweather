# EDGE-WATCH-LOOP — continuous evaluation (v17)

> **What this is.** The v17 EDGE-WATCH loop (started 2026-07-10, from the strategic-fork answer in
> `FASTTRACK-PLAN.md`): **forward adjudication + structural tripwires + the new-idea filter — nothing else.**
> The prior is settled and not re-litigated: twelve of twelve signals dead (`FINDINGS.md`); BREAKEVEN-SKILL
> closed forecast-for-trading by arithmetic. This loop watches the instruments that are already running,
> sweeps the tripwire bars daily, and filters any new idea through the Lane-3 gauntlet. **Idle is correct.**
> Files are the state; this board is refreshed every material cycle. Branch: `loop/2026-07-10-edge-watch`
> off `main @ 62a143d`. Boundary unchanged: operator funds/keys/toggles; Claude never trades, never touches
> credentials; no capital before a frozen forward PASS ×2 non-overlapping windows + explicit operator go.

---

## ⚑ FOR THE OPERATOR (remote check-in) — read this first

_Claude keeps this block current every material cycle. Whole status in 20 seconds._

- **▶▶ C1 (2026-07-10 ~23:30Z 07-09): loop initialized; ONE real finding + two watch items:**
  1. **The /paper-trade forward ledger is silently accruing only 2 of 4 cities since 07-08.** The 07-07
     18:11Z config change (deliberate — C101 best-hours) narrowed each city to its single best arm, but
     **Houston (15 local = 20:00Z) and Ankara (16 local = 13:00Z) fall AFTER the single daily 10:00Z
     `city-paper-trade` tick, which only places arms whose local hour has already passed** — so they can
     structurally never place. (The full-arm 07-04/07-05 rows came from manual runs at 22:08Z/18:53Z, which
     is why this wasn't visible at the change.) Karachi-14 (09:00Z) + Singapore-15 (07:00Z) are fine.
     **Fix is a one-line cron change (operator-gated):** add a second daily run of the same fn at ~21:30Z
     (clear of the reserved :32–:42 window; the fn is idempotent per city/date/arm) — or re-hour the two
     cities pre-10Z, which contradicts the C101 best-hour finding. Say the word and I stage the SQL.
  2. **Efficiency monitor: the manual dispatch at 22:59Z succeeded** (run 29056098243, 57s — proves the
     `DATABASE_URL` secret + driver end-to-end; snapshot landed, S1 KILL / S2 INSUFFICIENT as expected).
     **First scheduled 06:00Z run is this morning** — I verify after it fires and log here.
  3. **`city_sim_config.active_until = 2026-07-31`** (21 days runway). I'll re-surface before ~07-29 so the
     silent-pause gotcha doesn't eat the ledger if you still want it accruing.
- **Nothing needs you right now beyond #1** (and #1 only costs unaccrued Houston/Ankara data-days while it waits).

## State snapshot (C1 baseline, 2026-07-09 ~23:30Z)

- **Efficiency monitor (Lane 1①):** 3 snapshots; latest as-of 07-09: **S1 KILL** — n=3,530 / 45 cities /
  22 days, winFrac 5.84%, mean net −0.17%, city-CI [−1.02%, +0.69%], day-block CI [−1.22%, +0.63%], zsMC
  1.6% (consistent with the C24 baseline; MDE ≈ ±0.9pp — a well-powered null and tightening).
  **S2 INSUFFICIENT_DATA** — still 10 troughs (slow accrual is itself the finding).
- **/paper-trade ledger (Lane 1②):** tick firing on time (last placed 07-09 10:00:19Z); grading current
  (07-08 rows settled); **accrual gap = operator item #1 above.** 550 bets total.
- **trade_config.mode = `dry-run`**, active_until null (tripwire ⑤ clear — rail DORMANT as expected).

## Tripwires (Lane 2) — bars from the recorded KILLs

| # | Tripwire | Bar (reopen only if crossed) | C1 read | Last checked |
|---|---|---|---|---|
| ① | Maker-fill mechanism (§13) | documented queue/depth-provisioning change plausibly restoring fills toward 40–49% (live read 6.5%); never a backtest re-tune | no change | 07-10 C1 |
| ② | Polymarket fee/rebate/rewards program | a program flip at the root (REC-8 lineage, like the 06-24 rewards funding) | no signal; whale-watch+Slack cover the big-print side | 07-10 C1 |
| ③ | New-instrument volume (precip/wind/snow) | ~10× regime change vs the $802/24h read (floor $7k, signal #9) | not swept C1 (occasional) | — |
| ④ | Cross-venue true both-book depth | growth vs the 1–10-contract KILL read (#10) | not swept C1 (occasional) | — |
| ⑤ | trade_config.mode | anything ≠ off/dry-run → fold v16 Phase-C monitoring in as a lane | `dry-run` ✓ | 07-10 C1 |

## Cycle log

- **C1 (2026-07-09 ~23:30Z / 07-10 01:30 local) — loop init + baseline.** Read the state files (BUYING-BUILDS
  ⚑ + C25 wrap, FINDINGS bottom-line + power legend + REPLICATION RULE, SIGNAL-BACKLOG §13 + What-NOT-to-do,
  EFFICIENCY-MONITOR frozen gates, BREAKEVEN-SKILL, BUY-TABLE addendum). Branch created. Baseline DB reads
  (light selects only): monitor panel (S1 KILL n=3530/45/22 · S2 INSUFFICIENT 10), city ledger health,
  trade_config dry-run, city_sim_config 4×active→07-31. **Finding: KHOU+LTAC structurally can't place under
  the single 10:00Z tick since the 07-07 best-hour narrowing** (post-10Z local hours; manual runs had masked
  it) → operator item #1. Efficiency-monitor manual dispatch 22:59Z success verified via `gh run list`.
  Next checkpoints: 06:00Z Action run, then 10:00Z city tick. Board created (docs-only commit).
