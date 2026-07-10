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

- **▶▶ C4 (2026-07-10, operator-directed) — SLACK REWORK: pushes are FULLY PAUSED now; the reworked routing
  is BUILT + tested and awaits your two deploy steps.**
  - **Applied live already:** `alerts_slack_allow_kinds = ''` → nothing pushes (the master pause was already
    on; the allowlist is the routing table). The measured spam: WHALE_TRADE ~42/day (100 on 07-10 alone;
    the 06-24 insider scan found no actionable signature at $100k) + ~230 deadman messages for ONE incident
    (30-min dedupe buckets). Meanwhile the ONE high-value message — the 07:00Z daily digest — had been
    silently suppressed since 06-24 (its kind was never allowlisted). Exactly inverted value.
  - **The rework (your AskUserQuestion picks):** whale pushes → DIGEST-ONLY (data keeps recording) · ONE
    daily digest as the backbone, now covering the forward instruments (efficiency-monitor S1/S2, city paper
    ledger, whales-24h summary) · deadmen page max 1/kind/UTC-day. Rail-guard kinds stay armed.
  - **DEPLOY (2 steps):** ① apply migration `0092_slack_rework.sql` (digest data v2 + day-bucket deadmen +
    suppression-aware whale queue + the allowlist reroute — Slack resumes AT APPLY with the new routing) ·
    ② redeploy the `daily-digest` edge fn (the handler gained the three sections; without it the digest
    still sends, just without the new sections). Rollback line is in the migration header.

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
  2. **Efficiency monitor — the 06:00Z SCHEDULED run did NOT fire on 07-10** (watched through 06:59Z; GitHub
     drops scheduled runs under load at congested slots like :00, and brand-new schedules are the most
     drop-prone). **I dispatched it manually at 06:59Z → success (run 29075331802, 1m32s) → snapshot landed
     07:00:58Z: S1 KILL n=3,615 / 22 days · S2 INSUFFICIENT 10.** No data lost — the driver re-derives, so a
     late run still records the day. **Watch tomorrow's 06:00Z:** if it also skips, the standard mitigation is
     moving the cron off :00 (e.g. `17 6 * * *`) — a one-line workflow edit that must go to main to take
     effect (operator push), or use the Task-Scheduler alternative in the workflow header. I'll keep
     dispatching manually as the stopgap while the loop runs.
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
- **C2 (2026-07-10 ~07:05Z) — 06:00Z scheduled Action MISSED → manual dispatch recovered the day.** Watched
  06:07/06:33/06:59Z: no scheduled run (GitHub drops cron runs at congested :00 slots; new schedules most
  affected). Dispatched via `gh workflow run` 06:59Z → success (29075331802, 1m32s) → snapshot 07:00:58Z:
  **S1 KILL n=3,615/45c/22d · S2 INSUFFICIENT 10 troughs** (S1 n +85 vs last night; verdicts unchanged vs the
  C24 baseline — the forward accrual is confirming the KILL). Operator option logged in ⚑ #2 (cron off :00 if
  tomorrow also skips). Next checkpoint: 10:00Z city tick.
- **C3 (2026-07-10 ~10:04Z) — 10:00Z city tick HEALTHY; tripwires no-change.** OPKC-14 (ask 0.95) + WSSS-15
  (ask 0.997) placed 10:00:14/23Z, pending; KHOU/LTAC absent exactly per the C1 diagnosis (⚑ #1 stands).
  Tripwires: ⑤ dry-run ✓ · ①②no signal · ③④ deferred to an occasional sweep. Both daily checkpoints done;
  idling until tomorrow's 06:00Z Action watch.
- **C5 (2026-07-10 ~21:00Z) — Lane-3 gauntlet: "World Cup maker whales / safer maker bets during WC volume"
  (operator idea) → NOT A REOPEN.** Fresh keyless reads: WC knockout volume real (esp-bel 1X2 $30M/24h);
  **flagship match markets carry $16,322/day maker-reward pools** (vs $25–500 typical) — the genuinely new datum,
  logged against tripwire ② (expires with the final 07-19); the active maker whale (`ferrariChampions2026`,
  $53.6M/$599k this week, 1.1% ROI, $130 median clips across in-play sports) is a professional sub-second MM bot,
  the SPORTS-TRADERS §3 archetype. Reduces to REC-10 (−41%/day two-sided inventory) + maker-spray/maker-exit
  adverse-selection kills with the in-play sign made worse (goals gap 10–40¢; our latency 300–1800× short, §9 C2);
  and structurally: PASS ×2 non-overlapping ≥7d windows cannot fit before 07-19. Full record: SPORTS-TRADERS §11.
  Carry-forward: watch pool RATES — flagship-scale pools going STANDING on weather would reopen REC-8, not football.
- **C4 (2026-07-10 ~13:00–15:30Z) — OPERATOR-DIRECTED Slack rework (spam → value).** Measured the spam
  (alerts_log 14d: WHALE_TRADE 587 — 100 sent on 07-10 alone; deadmen 230/incident via 30-min dedupe
  buckets; the daily digest suppressed since 06-24 — never allowlisted). Applied the full pause live
  (allowlist=''). Operator picked: whale digest-only · daily digest backbone · deadmen 1/day. Built:
  migration `0092` (digest_data + monitor/cityLedger/whales24h — handles the double-encoded panel view;
  capture/bot deadmen re-stated with UTC-day dedupe buckets; whale_pending_alerts suppression-aware + 48h
  recency floor so a permanent pause can't grow the queue nor a resume flood it; allowlist hard-set without
  WHALE_TRADE) + `daily-digest` handler sections + staged `0089` bucket fixed in place. Tests: new 0092
  describe (5 tests) + support-jobs digest assertions + whale-watch re-pinned to the 0092 routing
  (fixture re-stamped past the recency floor). Deploy = ⚑ steps ① ②.
