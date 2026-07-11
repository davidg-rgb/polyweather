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

- **▶▶ CHECK TOMORROW (2026-07-11, operator-requested at C8) — two §12-R day-1 verifications:**
  1. **The 13:50Z and 20:45Z ticks must actually fire and place** (first scheduled runs of the new `-b`/`-c`
     per-slot periodKeys). Verify: `job_runs` shows two extra `city-paper-trade` runs with `placedByCity`
     covering ankara (13:50Z) + houston (20:45Z) for target 07-11; if either 409s, the periodKey body isn't
     reaching runJob — inspect `net._http_response` for the cron's request.
     **↳ C10 (07-11 ~13:15Z): PENDING — checked before the first -b fire.** The 10:00Z tick itself ran clean
     (period_key `city-paper-trade:2026-07-11`, OPKC-14 @0.992 + WSSS-15 @0.984 placed, pending). The -b/-c
     verification stands for the next check-in.
     **↳ C10 (07-11 13:50Z): the -b HALF PASSES.** First scheduled fire landed on the second (13:50:02Z),
     period_key `city-paper-trade:2026-07-11:b`, status ok, NO 409 — the §8.1 body periodKey works live.
     placedByCity {ankara: 2}: LTAC-14 30°C @0.66 + LTAC-16 29°C @0.48 (+2 maker twins, both filled). Note the
     arms picked DIFFERENT buckets — the race is producing divergent picks, which is what §12-R exists to
     adjudicate. The 20:45Z -c (houston) half remains.
  2. **The Houston 6°F pick gap grades**: 07-10 KHOU-14 bought 92–93°F @0.11 vs KHOU-15 86–87°F @0.59 (3
     buckets apart, same day). When 07-10 grades (~10:00Z tick), check which won and whether the 14h lock's
     forecast snapshot was a real intraday swing or a °F-path anomaly (C25/C37 verified the path, but this
     is the widest arm divergence seen).
     **↳ C10 (07-11): GRADED — the CHEAP 14h arm WON.** Actual 92°F: KHOU-14 92–93°F @0.11 → **won +$80.46**;
     KHOU-15 86–87°F @0.59 → lost −$10.21 (LTAC 29°C won both arms; 07-10 gap-fill day settled 5/6). The 15h
     pick sat on the then-observed running-max floor (87.08 at stamp) while the forecast said 92.05 and the
     high arrived late — a real late-day swing, not a °F-path bug. n=1 day; the frozen §12-R gate decides,
     not this.
  3. **Efficiency-monitor Action (the C2 watch item): the 07-11 SCHEDULED run FIRED** — drifted to 08:00:36Z
     (GitHub cron congestion), success in 55s, snapshot 08:01:27Z as-of 07-10: **S1 KILL n=3,735/45c/23d,
     mean −0.25%, city-CI [−0.99%, +0.49%], zsMC 1.5% · S2 INSUFFICIENT 10 troughs** — the well-powered null
     keeps tightening. (A second scheduled attempt on 07-10 09:40Z had failed in 20s — transient; today clean.
     No manual dispatch needed; the off-:00 cron mitigation stays optional.)

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
     ~~Fix is a one-line cron change (operator-gated): add a second daily run of the same fn at ~21:30Z~~
     **↳ RESOLVED at C8 (07-10 ~22:05Z, operator "activate" in-session): §12-R APPLIED LIVE** — arms
     ankara `[14,16]` / houston `[14,15]`, runway 09-30 all four cities, crons 13:50Z + 20:45Z added
     (WITH per-slot §8.1 periodKeys — the staged plain crons would have 409'd against runJob's daily
     claim; caught live), 07-10 gap-filled (4 bets placed). The §12-R frozen confirmation gate is accruing.
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
| ⑤ | trade_config.mode | anything ≠ off/dry-run → fold v16 Phase-C monitoring in as a lane | **`live` — OPERATOR-SET 07-11 12:56Z** (authorized live test, not a reopen). Still inert: active_until null + no gate PASS/override + daemon not running (ledger last wrote 07-07, 0 live rows). Phase-C monitoring folds in the moment the daemon actually runs live. | 07-11 C11 |

## Cycle log

- **C11 (2026-07-11 ~14:10Z) — OPERATOR armed the live test in /trading; verified state + named the three
  blocks.** Audit trail: 12:55:54Z mode dry-run→**live** (the C9-owed positive click test implicitly done —
  updated_at moves on save now) · 13:57:05Z allowlist −ankara +mexico-city · 13:57:31Z +shanghai (the 0094
  picker's first real use). Config now: mode live · stake $5/buy · allowlist [houston, karachi, mexico-city,
  shanghai] · caps 25/40/100 · kill min($30, $25). **NOT ACTIVE — three independent blocks, each verified:**
  (1) `active_until` NULL → preflight run-window check fails; (2) gate branch unsatisfied — latest
  bot_gate_snapshot 07-05 INSUFFICIENT (the settled verdict is the 07-07 KILL), trade_gate_override 0 rows
  ever; (3) the daemon is a LOCAL process and isn't running — live_orders last wrote 07-07 04:49Z (356 rows,
  ALL dry-run, 0 live, 0 fills), and a real post additionally needs env TRADE_MODE=live. City-taker lane
  (arms table) separately INERT: `city_live_arms` is empty on prod. Tripwire ⑤ updated (operator-authorized,
  not a reopen). Watch item: **ankara was dropped from the allowlist at 13:57Z** — flagged to the operator as
  possibly accidental (the paper §12-R race is unaffected; the allowlist only gates the live daemon).
- **C10 (2026-07-11 ~13:20Z) — OPERATOR: allowlist picker REGRESSION (0093's UI was narrower than the DB) →
  fixed via 0094 (APPLIED); day-1 verifications part-done.** The operator could not add ANY new city to the
  /trading buying allowlist: the 0093 checkbox picker's options came from `dash_city_live().arms` — and prod's
  `city_live_arms` is EMPTY (0085 seeded dark, no arm ever set) — so the picker offered zero enrolled options
  and only the 3 stored slugs, while `trade_config_set` validates against the FULL 45-row `cities.slug` domain.
  Fix: migration **0094 APPLIED to prod** — `dash_city_live()` gains `allCities` (the whole validation domain
  as { slug, displayName, enrolled }); the page prefers it (falls back to arms pre-0094), enrolled cities are
  label-flagged, the picker scrolls at 45 options. Guard re-verified live (non-operator call still
  ERR_FORBIDDEN). Suite **3,112 green** (new PGlite allCities-domain test + loader/render assertions),
  typecheck clean. Verifications: KHOU pick-gap graded (⚑ #2 ↳), 07-11 10:00Z tick clean, monitor Action
  fired scheduled (⚑ #3 ↳); the -b/-c first fires were still ahead at write time (⚑ #1 ↳ PENDING).
  **UI half needs the merge to main to deploy; the DB half is live.**
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
- **C9 (2026-07-10 ~22:40Z) — OPERATOR: /trading mode-switch verification + allowlist SAFEGUARD (0093).**
  (1) **The operator's browser mode-flip DID NOT land** — trade_config.updated_at still 07-07T16:21Z (the
  updated_at trigger fires on every write); mode was never 'live' tonight. Likely the diff-aware save button
  (0 changes) or save not clicked; the positive end-to-end click test is STILL OWED (off→save→dry-run→save
  while watching updated_at). Layers verified tonight: component/route code-traced, 15 web tests green, and
  the live negative test — trade_config_set from a non-operator session raises ERR_FORBIDDEN (guard
  unbypassable). (2) **Allowlist footgun closed (operator-requested):** migration **0093 APPLIED to prod** —
  trade_config_set now normalizes (lower/trim/dedupe) + RAISES on unknown slugs vs cities.slug and on an
  empty-normalizing list ('all cities' = the clear flag, never '{}'); + the /trading editor's free-text
  allowlist replaced by an all-cities/restrict radio + per-city checkbox picker (options = enrolled cities ∪
  stored entries). 4 new PGlite tests (migrations 100/100), typecheck clean; prod verified (new body present,
  guard intact at line 7, config row untouched — allowlist still [karachi,houston,ankara], NOTE singapore
  absent: operator should confirm that restriction is intentional). Full suite caught ONE downstream break —
  trade-config.test.ts's loadTradeConfig test wrote an allowlist without seeding cities (now correctly
  rejected under 0093) → seeded + expectation updated to the normalized-sorted contract; suite 3,111 green.
  **UI half deploys with the next merge to main; the DB guarantee is already live.**
- **C8 (2026-07-10 ~22:05Z) — OPERATOR "ACTIVATE" → §12-R APPLIED LIVE (paper); ⚑ #1 RESOLVED; a real
  cron-design defect caught and fixed in the act.** Operator asked for surgical best-time-per-market buys
  on a couple of cities = exactly §12-R. Applied under C21-class in-session approval: config (ankara
  `[14,16]`, houston `[14,15]`, ×4 runway 09-30) + crons -b 13:50Z / -c 20:45Z. **DEFECT: the staged crons
  would have 409'd daily** — runJob claims a per-UTC-day periodKey before the handler's idempotency; the
  10:00Z tick owns the day (first gap-fill attempt returned ERR_ALREADY_RAN and exposed it). Fixed with
  §8.1 body periodKeys (`…:b`/`…:c` stamped at fire time), zero code changes. Gap-fill 07-10 then placed
  **4/4**: KHOU-14 92–93°F @0.11 · KHOU-15 86–87°F @0.59 · LTAC-14 29°C @0.89 · LTAC-16 29°C @0.95
  (+4 maker twins). Watch: the Houston arms' 6°F pick gap (intraday swing vs °F-path anomaly — check at
  07-11 grading); tomorrow's 13:50Z/20:45Z ticks are the first scheduled fires of the -b/-c keys — verify.
  Boundary intact: paper only; live capital stays behind the standing law + operator-physical toggles.
- **C7 (2026-07-10 ~23:30Z) — OPERATOR ASK: review the actual-money order path + prove it runs.** Reviewed
  the full money path (live.ts 1041 lines + order-intent pricing + gate/preflight/smoke). Ran: trading suite
  **150/150 green** (incl. the §15 repo-walk invariant: the wallet key is read nowhere outside packages/
  trading) + `trade-smoke.ts` SAFE DEFAULT → **all green against the LIVE venue**: L2 creds derived (apiKey
  632d3ff9…, sigType 2, funder set), authenticated getOpenOrders OK (0 open — dormant as expected), real V2
  order built+signed for a live market, NOT posted; TRADE_MODE resolved dry-run; step 4 refused correctly.
  Review verdict: fail-directional discipline is sound (post-succeeded never frees the key; transport-throw
  holds for startup reconcile; only clean venue rejection frees). Residual risks named in-chat: (a) maker-ness
  is price-enforced only — a book move in the read→post window can cross as an unbooked-fee taker fill (C75
  deliberate, post_only is the gated lever); (b) getOrder fill shapes are mock/shadow-verified until the first
  real fill; (c) reconcile's adopt heuristic can adopt an identical operator-manual order; (d) cancelAllForMarket
  bypasses ledger transitions until next poll; (e) preflight has no on-chain balance/allowance check — the
  operator `--live-smoke` probe is what proves funding. Remaining unproven live steps = postOrder/cancelOrder
  real responses → exactly the operator-run `--live-smoke` ($0 far-from-market place+cancel; needs
  TRADE_MODE=live + preflight or the explicit escape). Rail posture unchanged: quadruple-locked, strategy
  KILLed, nothing to trade — this was a plumbing verification, not a reopen.
- **C6 (2026-07-10 ~22:00Z) — OPERATOR ASK: "put the city-scan candidates to true testing" → §12-R written
  (restoration + frozen forward gate), SQL staged.** Found the confirmation stream broken TWICE: the 07-07
  C101 narrowing removed arm 14 from houston/ankara (an in-sample-driven pick displacing the pre-registered
  forward test — C101's read for those cities was mostly the in-sample backfill), and the 10:00Z-tick gap
  (⚑ #1) has blocked ALL placement for both cities since 07-08 → only ~4 qualifying forward days exist
  (07-04→07-07). Corrected C1's 21:30Z cron suggestion (wrong for Ankara: handler targets local-today).
  Design: race arms {14,15}/{14,16}, ticks 13:50Z+20:45Z, runway 09-30, gate frozen BEFORE data (n≥30
  forward days/cell, day-clustered CI LB>0=CONFIRMED / UB<0=KILL / else NOT-CONFIRMED, hard stop n=45,
  joint zsMC<5%, power stated: decisive for ankara-sized, ~50% for houston-sized at n=30). Null honesty:
  2-of-4 TRAIN survivors passing TEST is the EXPECTED count under pure noise — the forward gate is the only
  read that counts. Operator: apply the §12-R SQL block (one decision, rollback included).
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

- **C12 (2026-07-11 ~15:25Z) — BUY-TABLE-LIVE cloud lane DEPLOYED + LIVE (operator-directed).** Operator set
  window (07-14), directed the model swap (buy-table: predicted bucket, taker ≤15¢, lead 2–12h, hold to close)
  + cloud execution. Built via agent (0095 + buy-table-tick fn + 39 tests, suite 3,151 green), merged PR #14.
  Operator set Edge secrets; override created to 07-15 (direct row, operator-instructed). Two launch defects
  found live and fixed: cron timeout 4500ms < cold boot (→10000ms, live + mirrored to 0095) and gateway JWT
  verification 401 (→ redeployed --no-verify-jwt, runbook updated). **First clean LIVE tick 15:20:03Z:**
  mode live, 4 cities / 217 captures / 8 evaluated / 0 candidates / 0 placed — the ≤15¢ gate correctly found
  nothing. Lane self-runs */10; deadman armed; expires with window+override unless operator renews.
