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

- **▶▶ C18 (2026-07-16 ~11:05–12:00Z, operator IN-SESSION: "today we verify functionality") — "no buys
  recognized" TROUBLESHOT → NOTHING BROKEN; verification tooling shipped; one config revert + one ledger
  reconcile, both operator-instructed.**
  - **Why no buys — two independent gates, both by design:** ① the C17 planned lapse LANDED — the override
    expired 07-15 00:00Z, so `trade_live_preflight('buy-table')` fails on exactly that one reason (everything
    else green: mode live, window 07-20, loss $0); ② the tick has had **0 candidates every tick anyway** —
    the [2,12]h lead window is a mid-day-UTC dead zone for the 4 allowlisted cities (their markets sit at
    ~0.6 / 24.6 / 48.6h to close; the window populates only ~00:00–10:00Z, and at the 15¢ cap no natural
    candidate has EVER appeared). The tick itself is healthy: every */10 fire ok, degraded:false.
  - **NEW REMOTE CHECK TOOL (committed `86c5c3e`): `pnpm tsx scripts/diag-buy-lane.ts`** — read-only,
    one command, prints CAN-A-BUY-HAPPEN-NOW + the interlock reasons + the per-market skip funnel (reuses
    the tick's OWN selector — zero drift) + the next-window estimate + dangling intents. Use it FIRST for
    any future "why no buys". (+ fixed a pre-existing suite time-bomb: trading-db.test.ts's hardcoded
    07-06 seeds aged out of the 7-day lookback — red daily since ~07-13; seeds now track the constant.
    Suite 3211 green.)
  - **Local credential smoke PASS** (safe steps 1–3): creds derive (sigType 2, funder SET), authenticated
    read OK, 0 open orders at venue → the 07-12 shapeless-post root cause (missing sig-type/funder) is
    FIXED in `.env.local`; **the EDGE-secret copy stays unproven until the first clean live post.**
  - **The 07-12 stuck shanghai intent RECONCILED** `intent→failed` via `bot_order_record_failed`
    (operator-authorized in-session; venue-confirmed nothing resting; market long resolved) — open
    exposure $4.95→$0, dangling intents 0, audit reason on the row.
  - **`buy_table.price_cap` 0.33 → 0.15 REVERTED** (operator-instructed; the 0.33 was the operator's own
    phone-side probe while racing the 07-12 issue — the block was never price, it's the lead window).
  - **OPERATOR — to verify a live buy today:** ① renew the gate override from /trading (≤14d) — the ONLY
    closed gate; ② optional write-path proof, local: `pnpm tsx scripts/trade-smoke.ts --live-smoke
    --i-know-no-preflight` (needs TRADE_MODE=live in `.env.local`; ~$0 place+cancel far from market);
    ③ next natural candidate window opens ~**2026-07-17 00:00Z** — and at 15¢ a natural candidate is rare,
    so if today MUST see a strategy buy, the honest lever is a temporary lead/cap widening (your call,
    revert after).
  - **↳ C18b (07-16 ~12:20Z, operator-instructed): `buy_table.price_cap` raised 0.15 → 0.40 TEMPORARILY
    for the verification** ("increase cap for today, I'll lower it myself later — viable entry point given
    the cities min"). Basis, measured off the live captures at ~12:10Z: tonight's-window (07-17) predicted-
    bucket asks houston 0.32 · shanghai 0.35 · mexico-city 0.36 · karachi 0.49 → min 0.32 + drift headroom
    = 0.40 (admits 3/4 cities on current prices; karachi's 49¢ favorite excluded; worst case 4×$5=$20,
    inside the $25/$30 kills). **⚑ THE OPERATOR LOWERS IT BACK — if this note is stale and the cap still
    reads 0.40, surface it.** A live buy tonight still additionally needs the override renewal (his click).
  - **↳ C18c (07-16 ~14:20Z, operator-instructed): the ENTRY RULES shipped (migration 0102 + handler +
    REDEPLOYED to prod)** — "if trade fails → reset and get the next entry; if trade successful → no
    further buying trials." Rule 1: `buy_table.max_entry_attempts` (LIVE `3`, default `1` = the old
    one-EVER gate) — only PROVABLY-dead attempts retry (clean-rejection `failed` / zero-fill `canceled`);
    unknown-state rows (stuck `intent`, unfilled `placed` — the needs-reconcile classes) still always
    block, so the 07-12 double-place discipline holds. Rule 2: `buy_table.stop_after_first_success`
    (LIVE `true`) — the first REAL fill halts all further entries, including same-tick; visible as
    `stats.laneHalted` + a by-design blocker in the diag tool. Defaults reproduce the original lane
    exactly (both flags are the operator's to flip back, no redeploy needed — config is read per tick).
    Suite 3,220 green; deploy verified on the next scheduled tick.
- **▶▶ C17 (2026-07-12 ~15:10Z) — OPERATOR DECISION: the live lane's dates LAPSE NATURALLY (no renewal);
  everything else runs and collects.** Per the pre-absence recommendation: the gate override expires
  **07-15 00:00Z** and `active_until` **07-20** — neither will be renewed; the lane keeps hunting (unpaged,
  Slack dark) until 07-15, then goes quietly inert by design (ticks keep running, candidates skip at
  preflight; preflight-skip alerts are suppressed unrecorded under C16, so nothing accumulates). Nothing is
  cleared early — the remaining ~2.5 live days stand as authorized. **All data collection continues
  unattended:** opening-capture (5-min, 45 cities), buy-table-tick, §12-R city race (runway 09-30 ×4 cities),
  google panel hourly, whale/metar/poll on the C15 lanes, efficiency-monitor Action 06:17Z. To revive the
  live lane later: /trading → gate-override panel (≤14d) + bump active_until — both remote, both yours.
  (Also resolved: the 07-11 ankara allowlist drop was confirmed INTENTIONAL — [houston, karachi,
  mexico-city, shanghai] is the intended set.)
- **▶▶ C16 (2026-07-12 ~14:45Z) — ALL SLACK POSTS HALTED (your order: "halt all slack posts … until I tell you
  otherwise").** `alerts_slack_paused` was already `true`; the 14-kind allowlist that pushed through it is now
  EMPTY (`alerts_slack_allow_kinds=''`) → every kind (digest, deadmen, buy-table/order CRITICALs) is skipped
  WITHOUT recording, and 0 unsent rows existed, so the ADR-11 resend sweep has nothing to re-post and nothing
  accumulates to flood you on re-enable. **Consequence while this holds: NOTHING pages — monitoring is
  pull-only (/trading, /system, /monitor). The C14 "Slack is your heartbeat" line is suspended**, including
  the live lane's post-failure CRITICALs. **To re-enable**: restore the routing table —
  `update config set value='DAILY_DIGEST,BOT_DEADMAN,CAPTURE_DEADMAN,DEPTH_CAPTURE_DEADMAN,DEPTH_CAPTURE_PARTIAL_WRITE,EXIT_FAILED,CIRCUIT_BREAK,POL_LOW,DAILY_KILL,BUY_TABLE_DEADMAN,BUY_TABLE_DEGRADED,BUY_TABLE_POST_FAILED,ORDER_FAIL,ORDER_NEEDS_RECONCILE' where key='alerts_slack_allow_kinds';`
  (or just tell Claude "re-enable slack").
- **▶▶ C15 (2026-07-12) — the compute-shed you asked for is APPLIED: ~2.5h/day of edge-fn time freed** (google
  panel 15-min→hourly, whale 10→30-min, metar 15→30-min, poll-markets 5→15-min on clean minute lanes). Nothing
  you need to do; freshness alarms + the price dead-man were re-calibrated first so nothing false-alarms. All
  measurement fidelity kept (google replay is deterministic over stored captures; the buy-table lane + google
  panel read opening_captures, whose 5-min capture cadence is UNTOUCHED). Rollback lines in cycle log C15.
- **▶▶ C14 (2026-07-12, operator-requested pre-absence verification) — the system is REMOTE-OPERABLE; two
  renewal dates are YOURS while away: ← SETTLED at C17 (operator: let both lapse; see ▶▶ C17 above)**
  1. **Gate override expires 07-15 00:00Z** — the live lane's gate branch fails then (run window alone is not
     enough). **You can now renew it FROM /trading**: the new "gate override" panel (under Interlock gate)
     sets/renews/clears via `trade_gate_override_set` (≤14d per renewal, confirmed + audited). `active_until`
     (07-20) was already editable in the config editor. Letting either lapse = the lane goes quietly inert
     (ticks keep running, candidates skip at preflight) — that is a valid choice too, just make it on purpose.
  2. ~~**Slack is your heartbeat again**~~ **← SUSPENDED by your C16 order (all posts halted; see ▶▶ C16
     above for the one-line restore)**: 0092 applied + daily-digest redeployed — ONE digest/day at 07:00Z
     (monitor S1/S2, city ledger, whales-24h) + the five buy-table/order CRITICAL kinds + deadmen (1/kind/day).
     Root cause found during verify: **the digest had NEVER sent** — its 4–5k-char body exceeded Slack's
     3,000-char section limit and 400'd every day since 06-14; bodies now chunk across blocks.
  3. **DB stability restored**: the 07-11 lane launch tipped the Micro over at :00/:15/:30/:45 (5–7 fns firing
     the same second → statement-timeout cluster: poll-markets ~50/day, grade-bets + snapshot-forecasts +
     city-paper-trade dailies). Crons are now minute-staggered per function (rollback = old schedules in C14
     cycle notes); failed dailies were re-run same-day (attempt 2, ledger caught up). Watch: `job_runs` failures
     should stay ≈0; if the timeout cluster returns at peak, the durable fix is the compute upgrade (Micro).
  4. **/system fixed** (was 500 since the tables grew): dash_system_health needed 16.5s vs the 8s ceiling —
     exact count(*) gauges → reltuples estimates + a set-based gap matrix (migration 0101, applied).
  5. **The efficiency-monitor Action moved to 06:17Z** (0 6 → 17 6; GitHub drops :00 runs and nobody will be
     around to hand-dispatch).
  6. **Still PENDING a real candidate: the first-ever clean live post.** Nothing under the 25¢ cap in-window
     yet since the secrets fix. If the first post FAILS, the Slack CRITICAL now carries the venue's status +
     error body verbatim (PR #20) — remote playbook: set mode `dry-run` from /trading while it's diagnosed
     (every failed post permanently burns that market's one-entry key).

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
     **↳ C13 (07-11 20:45Z): the -c HALF PASSES — ⚑ #1 fully RESOLVED.** Fired 20:45:04Z, period_key
     `city-paper-trade:2026-07-11:c`, ok, placedByCity {houston: 2}: KHOU-14 90–91°F @0.80 + KHOU-15
     88–89°F @0.31 (pending). Both new §12-R crons verified live on their first scheduled fires; the race
     accrues on its own now. (Buy-table lane concurrently healthy: every */10 tick since 15:20Z clean,
     mode live, 0 candidates yet — nothing under the 15¢ cap in-window.)
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
| ⑤ | trade_config.mode | anything ≠ off/dry-run → fold v16 Phase-C monitoring in as a lane | **`live` — OPERATOR-SET 07-11 12:56Z** (authorized live test, not a reopen). C18 state: mode live + window 07-20 BUT the override expired 07-15 (C17 planned lapse) → preflight fails → lane inert as designed; 0 live posts ever (the one 07-12 attempt failed shapeless, reconciled `failed` at C18). | 07-16 C18 |

## Cycle log

- **C18 (2026-07-16 ~11:05–12:00Z) — OPERATOR IN-SESSION: "no buys recognized" troubleshoot + "today we
  verify functionality".** Full detail in ⚑ C18. Facts established: the C17 lapse landed exactly as designed
  (override expired 07-15 00:00Z; preflight fails on that single reason; mode/window/loss all green);
  independently the tick has 0 candidates every tick — lead-window dead zone (~00:00–10:00Z is the only
  populated stretch for the 4 cities) and 0-ever at the 15¢ cap. Actions: built + committed
  `scripts/diag-buy-lane.ts` (+10 tests; read-only remote verdict tool, reuses the tick's own selector);
  fixed the trading-db.test.ts stale-date time-bomb (red daily since ~07-13; suite back to 3211 green);
  ran the SAFE credential smoke (PASS: sigType 2 + funder set + authenticated read — the 07-12 root cause
  fixed locally, Edge copy unproven until a clean post); reconciled the 07-12 stuck shanghai intent
  `intent→failed` (operator-authorized; venue-confirmed 0 open; exposure $4.95→$0); reverted
  `buy_table.price_cap` 0.33→0.15 (operator-instructed — the 0.33 was the operator's phone probe).
  Boundary intact: no trade placed, no keys touched, no authorization extended (the override renewal
  stays the operator's click; the `--live-smoke` write-path probe left for the operator to run).
  **↳ C18b (~12:20Z): cap raised 0.15→0.40 TEMPORARILY on operator instruction** (verification day; he
  lowers it himself later) — sized off measured tonight's-window predicted-bucket asks (min houston 0.32
  + headroom; karachi 0.49 excluded; see ⚑ C18b). Watch item: if the cap still reads 0.40 in a later
  cycle, surface it to the operator.
  **↳ C18c (~14:20Z): the operator's entry rules BUILT + DEPLOYED** (0102 + deriveEntryGate + redeploy;
  see ⚑ C18c): retry-after-provably-dead-failure (max 3 attempts/market, unknown-state rows still hard-block)
  + halt-all-buying-after-first-fill (live `true`). Live config: cap 0.40 · attempts 3 · stop-on-success on.
  Suite 3,220 green, typecheck clean. Boundary intact: config + code only, operator-instructed; the override
  renewal (the actual arming click) remains his.
- **C16 (2026-07-12 ~14:40Z) — OPERATOR: "halt all slack posts … until I tell you otherwise" → TOTAL Slack
  silence applied.** Lever: `alerts_slack_allow_kinds` `'DAILY_DIGEST,…,ORDER_NEEDS_RECONCILE'` (the 0092+0095
  14-kind routing table, verbatim restore string in the ⚑ block) → `''`, with `alerts_slack_paused` staying
  `true` — under the 0055 mechanism every claim_alert now returns skip WITHOUT recording (no sent=false
  accumulation → no ADR-11 flood at re-enable; verified 0 unsent rows at flip time). Named consequence: the
  live buy-table lane's CRITICALs no longer page; monitoring is pull-only until the operator reverses.
  **+ C15 post-cut watch CLOSED ALL GREEN:** every first fire on the new lanes ok — poll 13:57/14:12/14:27
  (new-lane ticks clean, incl. :27 which replaces the contended :30 class), whale 14:02/14:32, metar
  14:04/14:34, google's first hourly 14:24 (periodKey floors to `T14:15` — harmless at one run/hour), health
  14:07 + 14:37 with ZERO alerts raised (no JOB_STALE / no dead-man) → the recalibrated matrix + halt
  thresholds hold. 0 job failures anywhere in the window.
- **C15 (2026-07-12 ~13:35–14:45Z) — COMPUTE-SHED APPLIED (the C14 handoff): four cron cuts live; ~2.5h/day of
  edge-fn time freed for the priorities (trading rail + buy-table + google picks).** Applied via cron.alter_job:
  **google-paper-panel `9,24,39,54` → `24 * * * *`** (hourly; deterministic replay over stored captures — zero
  measurement fidelity lost, only dash refresh latency; periodKey embeds hh:mm so no idempotency conflict) ·
  **whale-watch `2,12,…,52` → `2,32 * * * *`** (feed is most-recent-300 by trade_key, not time-windowed — a 30-min
  gap loses nothing at ~42 whales/day) · **metar-nowcast `4,19,34,49` → `4,34 * * * *`** · **poll-markets `*/5` →
  `12,27,42,57 * * * *`**. Prerequisites done FIRST: STALENESS_MATRIX poll-markets 15→35 + metar 45→75
  (health-monitor redeployed; support-jobs test updated, 18 green, typecheck clean) + config
  **stalePriceHaltMin 30→45** (at 15-min cadence one missed tick = 30-min price age = the old dead-man bar).
  A full consumer sweep (subagent, every market_snapshots + `bucket_probabilities source='market_consensus'`
  reader) found exactly TWO cadence-coupled consumers — both are those thresholds; everything else is latest-row
  / windowed-asof / day-lead granularity: SAFE (dashboards show "~15 min ago"; paper sims lose minor
  inter-tick fill fidelity — maker-twin fill detect was already a documented lower bound). **Lane choice
  deviation from the C14 sketch: NOT `0,15,30,45`** — job_runs showed ALL 9 of today's poll-markets timeouts
  sat exactly on quarter-hour slots (07:45→11:00, poll_known_events/upsert_market_snapshots statement timeouts)
  even after the C14 stagger moved every other fn off them → something still loads the DB at quarters (no cron,
  no Vercel cron, no Action — unidentified, possibly platform-side); `12,27,42,57` is collision-free across the
  whole cron table AND takes poll off the contended quarters entirely (side benefit: its failure rate should
  DROP vs */5). **Rollback lines:** google `9,24,39,54 * * * *` · whale `2,12,22,32,42,52 * * * *` · metar
  `4,19,34,49 * * * *` · poll `*/5 * * * *` · config stalePriceHaltMin `30` · matrix 35/75 → 15/45 + redeploy.
  Post-cut watch (first fires 13:57/14:02/14:04/14:24Z + health 14:07/14:37Z): see ↳ below.
- **C14 (2026-07-12 ~11:20–12:10Z) — OPERATOR: pre-absence verification run ("verify every interactive function
  + trading connections primed"; away from the local machine for weeks).** Full sweep + four fixes, all live:
  (1) **Cron stagger** — the 07-11 lane launch saturated the Micro at quarter-hour slots (5–7 fns same second):
  poll-markets failing ~every :00/:15/:30/:45 (poll_known_events / upsert_market_snapshots timeouts, max_exec
  7.9s vs the 8s ceiling), grade-bets KILLed 2 mornings (sweep_grading_targets), snapshot-forecasts 2× at 10:15Z
  (forecast_gap_matrix), city-paper-trade 07-12 10:00Z. Applied per-function minute lanes via cron.alter_job
  (bodies carry no fixed periodKeys; -b/-c untouched): metar 4,19,34,49 · google 9,24,39,54 · buy-table-deadman
  14,29,44,59 · health 7,37 · whale 2,12,…,52 · buy-table-tick 3,13,…,53 · opening-capture +1 lane · grade-bets
  06:28 · city-paper-trade 10:28 · run-calibration 11:28 · snapshot-forecasts 10:17/22:17 (rollback = these
  reversed). Failed dailies re-run same-day (attempt 2 ok; ledger placed ankara+singapore, karachi had landed
  pre-timeout; 07-11 graded). 45 post-stagger minutes: 0 failures. (2) **Slack digest NEVER-SENT root cause** —
  every DAILY_DIGEST row ever (06-14→) was sent=false: the 4–5k-char body exceeds Slack's 3,000-char section
  limit → webhook 400 → ADR-11 correctly never consumed the key. Fixed buildAlertBlocks (line-boundary chunking
  ≤2,900/section, 50-block cap; 10 io tests). Applied the AMENDED 0092 (the staged hard-set predated 0095 —
  unioned the five buy-table/order kinds in, else the live lane's CRITICALs would have gone silent), retired the
  10 stale June digests (sent=true), redeployed daily-digest + health-monitor (both carry the chunking fix; the
  resend sweep delivers today's digest). (3) **/system 500 root cause** — dash_system_health 16.5s vs 8s: three
  exact count(*) gauges (2.4+3.5+6.8s) + the ~2,520-probe gap matrix (3.8s) → migration **0101 APPLIED**
  (reltuples estimates + ONE set-based anti-join; 3.2s total, page renders 200; also de-fragilizes
  snapshot-forecasts which calls the same fn). (4) **Gate-override remote renewal built** — the 0082 §3 RPCs
  (trade_gate_override_set/_clear, operator_guard, ≤14d) had NO route/UI; the ONLY unlock after the gate KILL is
  the override and it expires 07-15 with the operator away. New /api/admin/trading/gate-override + a
  GateOverridePanel on /trading (§8.2 idiom: confirm-before-set, clear immediate, DB RAISE verbatim; 6 route
  tests + render assertions); the stale "rail DORMANT" h1 chip now tracks trade_config.mode. + the
  efficiency-monitor Action moved off :00 → `17 6 * * *`. Browser sweep: every dash page 200 (nav "google" →
  /convergence is intentional; /city is a dynamic segment), /trading console renders live state matching the DB
  exactly. Suite 3,201 green post-fixes; typecheck clean. Boundary intact: verification + software only — no
  trade placed, no keys touched, no authorization extended (the override renewal is the operator's click).
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
  **↳ RESOLVED (07-12, operator): the ankara drop was ON PURPOSE — allowlist [houston, karachi, mexico-city,
  shanghai] is the intended set; do not re-flag.**
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
