# EDGE-WATCH-LOOP — continuous evaluation (v18)

> **v18 (2026-07-16, operator-instructed): MULTI-DAY AUTONOMOUS SESSION.** The operator's standing order:
> "long build session across multiple days … autonomous fixing machine that makes sure this project works";
> he connects remotely on occasion. Everything in v17 stands; v18 adds the **Cycle rota** below (run every
> self-paced wakeup) + explicit escalation rules + a calm-day build queue. Idle is still correct — but
> broken is fixed without waiting.
>
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

> **⟳ Idle heartbeat (rolled in place each quiet cycle — no new bullet for zero-change sweeps):** 2026-07-26
> **~10:40Z — GREEN; loop RE-ARMED since ~09:45Z (the /clear disarm is over; all re-entry watch items
> cleared).** Today's efficiency-monitor Action **LANDED 08:39Z success** (drift-window normal) · buy window
> 00–10Z CLOSED with **NO fills 07-26** (344 ok / 0 fail ticks 24h, latest 10:33Z; 0 candidates the whole
> window — asks never dipped under the caps; next window ~**07-27 00:00Z**; interlock ok:true, override
> id=2 → 07-31; the 2 benign orphan `placed` rows + the known 07-25 partial unchanged, dangling intents
> empty) · **all crons 0-fail/24h** (metar/synoptic/captures/health/digest/google + the 10Z city tick all
> on schedule) · cheap-early panel hourly (snap 18 @08:47Z: 38 considered / 10 entered / **8 realized mkts,
> mean −20.1%, win 25%** — small-n sawtooth under the ≥40 floor, INSUFFICIENT as designed; cityErrors 0) ·
> DB **2193 MB** / captures **720 MB** (under bars) · 0 unsent alerts · mode live (tripwire ⑤ unchanged) ·
> main→loop reconcile after PR #47 confirmed (`8dd4f23`). **Still owed today: rota 6b synoptic top-up
> late-day (~18Z).** Nothing needs the operator (07-31 override renewal re-surfaces ~07-28). Material
> events get their own dated bullet below.

- **▶▶ 2026-07-26 ~00:00Z (operator-directed handoff session: "Start from CITY-ORACLE-BUILDOUT-HANDOFF.md")
  — BUILDS 1→2→3 EXECUTED COMPLETE on the resolution-oracle data layer (analytics product; no trading, no
  §13 reopen; commits `3646c42`+`66c28e8` pushed; suite 212 files / 3,577 green).** ① **Build 1 (flagship):**
  IEM archive extended **2021→2026** (45 stations, ~4.3M METAR/SPECI rows, 91,187 complete local days, every
  city ≥3 calendar years) → the 45-city × 12-month **floor-formation climatology in RENDERED-INTEGER space**
  (committed `core/sim/city-floor-climatology.ts`; `/cities` "When is the day decided?" strip). ② **Build 2:**
  WU-truth vs METAR-replica crosscheck, **market-winner-adjudicated** (`docs/RESOLUTION-RISK.md` + asset +
  `/cities` column): 97.25% overall; **shenzhen 22.9% — WU is NOT a ZGSZ METAR render (market sides with WU
  46:2; replica-based analytics untrustworthy there)**; °F cities 94–97% with a one-sided +1°F replica-higher
  pattern where the market sides with the REPLICA 17:4 → our stored v1-API truth misses the resolved value on
  ~1–2% of °F days (SPECI-peak-shaped; truth-hardening + fallback proposals written, operator-gated, ADR-04
  untouched). Stretch smearing test adjudicated NOT-RUNNABLE (premise fails — one broken-instrument city +
  a truth-side bias, not per-city noise). ③ **Build 3:** intraday convergence on 1,779 city-days
  (`docs/INTRADAY-CONVERGENCE.md`): **market locks (Brier ≤0.1, stays) at median local 14–18 on ~100% of
  days; our house_gaussian locks on only 2–51% (median 0.31 at day end); floor-only baseline never locks** —
  "intraday is priced by a faster market", quantified per city; shenzhen's house curve alone never falls
  (cross-validates ②). **Tool-law catch worth keeping: DB `market_consensus` is UNUSABLE for resolution-day
  intraday reads** (dedup upsert never refreshes made_at + polling dies pre-resolution-day; 15.5h median
  forward-fill lag at local 23:00 — the first naive read produced a flat "market never converges" curve,
  pure censoring; the ghost-quote law INVERTS on dedup-upsert tables). Dashboard fold DEFERRED with reason.
  Boundary intact throughout; live lane untouched. **Pending next cycle: main→loop merge-back** (cheap-early
  PR #46 squash reconcile still outstanding on this branch).
- **▶▶ 2026-07-25 ~22:45Z (operator: "Build it") — the DEEP-HISTORY RESOLUTION-STATE CAPABILITY is BUILT +
  the 90-DAY METAR-GRADE KILL REPLAY is ADJUDICATED: the fresh-kill scrap is ZERO at scale; the one
  positive band is artifact-class. No signal; capability + two tool-guards retained.** ① `iem-backfill.py`
  pulled the resolution stream for **45 stations × 90 days** (109,954 METAR/SPECI rows, 1 ranged
  request/station, merge-idempotent, `out/iem-asos-archive/`) + committed `city-map.json` (DB export).
  ② `metar-kill-replay.py`: **2,161 events · replication 96.2%** (divergence city-dependent — shenzhen 16 /
  seoul 7 winner-"kills", 0.27% of 13,406 kills, kept as the honest fabrication channel). **Methodology
  catch pinned in the tool:** entry at the METAR's *valid* time = LOOK-AHEAD (AWC publishes 2–6 min later) —
  it faked +0.78..+1.08/$1; honest [T+6m,T+21m] entry collapses the universe **−88%** (the market eats METAR
  kills in minutes). ③ **Verdict:** the clean <10¢ fresh-kill fade = **−0.003/$1 on optimistic mids (n=145)**
  → dead before the real book's cut; the +0.33/$1 headline is 18 trades at ≥60¢ entries (+3.93) with an
  unresolved COR-revision look-ahead channel (IEM archives *corrected* METARs; WU honors revisions till
  next-day) → **artifact-risk, mid-basis-capped, no build**. The July margin-3 INSUFFICIENT cell is expected
  to die as n grows — 08-06 re-run prior now firmly negative. Denominator law at scale: **64.6% of METAR
  kills land on an already-dead (<1¢) bucket**; alive-cohort mid 0.115 (T) → 0.0005 (T+15). Full record:
  `OBS-TRANSMISSION.md` §Pass 3. ④ Prod verify from the oracle fix landed clean: 19:49Z synoptic tick =
  capture-only shape (no floor keys); 20:04Z metar tick re-floored all 11 US stations METAR-grade (several
  floors dropped 1–2°F — the contamination was real, now gone).
- **▶▶ 2026-07-25 ~21:45Z (operator: "read polymarket-temp-oracle.md, implement what benefits the cause") —
  the RESOLUTION ORACLE is DECODED + VALIDATED 66/66 → the OBS-TRANSMISSION fabrication mechanism is
  RESOLVED, and a WRONG-GRADE floor write in the day-old synoptic lane is FIXED + REDEPLOYED.** The
  operator's doc claims WU's resolution table is a bit-for-bit re-render of the METAR/SPECI stream (T-group
  tenths, rounded once; no 5-min obs; no 6-hr max groups; station-local day). **Verified in-house before
  building** (`oracle-replica-validation.py`, IEM per-ob `asos.py` feed): the replica reproduces the
  resolved market winner on **66/66 city-days** — and the synoptic 5-min max EXCEEDS the METAR-table max on
  **28/66 days (42%, 1–3°F)**. That is the OBS-TRANSMISSION fabrication mechanism, exactly: the 19
  winner-"kills" were 5-min blips resolution never sees; the market's high residual bids were sharps who
  know the oracle. **Shipped:** ① `synoptic-nowcast` → **CAPTURE-ONLY** (the 0118 `upsert_intraday` writes
  were tightening the resolution-grade 0111 floor with wrong-grade data — removed; fn redeployed ~21:40Z;
  the 11 contaminated 07-25 `intraday_max` rows deleted → metar-nowcast re-floors METAR-grade on its next
  */30 tick, rebuild fires on the advance; live lane untouched — its 4 cities are non-US). ② Tests: the
  suite pins "synoptic NEVER touches intraday_max" incl. the overshoot case (suite 3,471+ green,
  typecheck clean). ③ Docs: `docs/DATA-SOURCES.md` §resolution-oracle (the law: only METAR/SPECI-grade
  data writes the resolution floor) + the operator doc preserved at `docs/ops/POLYMARKET-TEMP-ORACLE.md` +
  `OBS-TRANSMISSION.md` addendum. ④ The **08-06 re-adjudication design corrected**: METAR-grade kills
  (fabrication-free by construction) + the 5-min stream as anticipatory trigger; per-city blip-confirmation
  rates now measurable from the two archived streams. ⑤ Bonus checks: our `wuRound`/`metarMaxToNative` was
  already the exact WU rule (doubly confirmed); `city_stations` matches every station gotcha in the doc
  (KLGA/KHOU/KBKF/LFPB/EGLC). Verify next wake: first capture-only tick stats (no maxesAdvanced key) + the
  US floors re-created METAR-grade.
- **▶▶ 2026-07-25 ~19:45Z (the decisive cheap test from last session) — the REAL-BOOK CROSS-CHECK is DONE
  and ADJUDICATED: the 5-min obs LEAD is REAL, the taker trade is NOT — the market's residual bid on
  "obs-dead" buckets is correctly-priced resolution-source insurance. No §13 reopen; no build.** Ran the
  first pass's 354 floor-kill events against the real `opening_captures` bids (66 city-days joined; archive
  brought current first via `--incremental`, +88k rows — build-queue item ③ done for real). ① **Timing
  CONFIRMED on quotes:** median pre-print bid drift **0.0000**; the whole collapse is post-print — the
  sub-hourly lead is real (analytics value; the nowcast lane already eats it). ② **The trade dies on
  adverse selection:** at walked `execBid` the city-day-clustered CI straddles 0 at margin 1–2 (best
  [−0.095, +0.266]); **19/19 winner-"kills"** (buckets our °C→°F conversion killed that then WON —
  SF 4 / Austin 3 / Chicago 3, the WU-vs-sensor divergence cities) kept 0.05–0.93 bids and the market won
  every one. ③ The clean-looking **margin ≥3°F cell (0 fabrications, CI [+0.111,+0.385]) is a
  CONSTANT-OUTCOME cell** — all 14 trades won, the CI measures price dispersion not fabrication risk (the
  07-24 convergence-capture trap, now guarded in this tool too) — at a **$52–156/week** pot. **Label
  INSUFFICIENT** (n=14 ≪ 40). ④ Denominator the mid-basis pass hid: only **~22%** of obs-kills had ≥5¢
  real bids at T−30. **Standing item: re-run `synoptic-realbook-crosscheck.py` ~08-06** (both corpora
  accrue daily; ~3× window by then) — if margin-3 reaches ≥40 trades / 0 fabrications / clean CI, surface
  to the operator as a scrap-sized finding, caveat first. Full record: **`OBS-TRANSMISSION.md`** +
  FINDINGS.md row.
- **▶▶ 2026-07-25 ~19:10Z (operator: "log every 5-min ob per relevant city, connect to Polymarket minute
  prices, isolate how fresh obs affect price — backtrack as far as possible") — the OBS↔PRICE RESEARCH
  CORPUS is BUILT + the FIRST-PASS TRANSMISSION READ is in; the trial's rolling history window is SECURED.**
  ① **0119** widened the lane: capture universe = `list_active_stations` around the clock (45 polled / **11 US
  returned incl. KBKF**; live-verified on the 18:19Z scheduled fire) + retention 14d→90d. ② **History
  boundary probed: the trial serves ~6 rolling days** (5d back OK, 7d back 403 — deep backfill vs the 522-day
  price archive is NOT possible); pulled the full available window immediately (time-sensitive — it slides
  daily): **20,587 five-min obs / 11 stations / 07-19..07-25** → local NDJSON archive + DB. ③ Minute prices
  pulled for the same window: **99 events / 1,089 buckets / 3.09M points**. ④ **First-pass event study**
  (`synoptic-price-join.py`; two bugs caught: the label-regex range-dash read hi=−79, and the archive
  `targetDate`-is-resolution-date trap — weather day now parsed from the SLUG): **A. floor-kill events**
  (n=88, bucket ≥5¢ at T−30): median Δp **−0.5¢ in [T−30,T) vs −6.0¢ in [T,T+15) and −2.2¢ in [T+15,T+60)**
  — the collapse concentrates AFTER the 5-min obs timestamp; 45% pre-drop ≥1¢, 88% post. **B. winner
  lead-lag**: argmax at **+25 min median** (obs leads price 55/67 city-days; pooled r small ~0.03).
  **Honest caveats (NOT a signal yet):** trade-print MID basis (no bid/ask — trap #1/#8), selection excludes
  buckets the market killed BEFORE the obs (the "market faster" cases), obs-time ≠ publish-time, and the
  tradable form (buy NO on freshly-killed buckets) must clear fees+spread+depth on the real book. **Next:
  the real-book cross-check on `opening_captures` for these exact events** (we hold 5-min book snapshots for
  the same markets), + the pre-kill denominator. Consistent with WO-5's 5–30-min reaction read — the open
  question is only whether ANY meat survives the first 15 min at executable prices. Forward capture accrues
  daily; trial ends ~08-08.
- **▶▶ 2026-07-25 ~18:05Z (operator: "test the Synoptic API and if it works, integrate/log data") — the
  SYNOPTIC SUB-HOURLY NOWCAST LANE is BUILT + DEPLOYED + VERIFIED LIVE end-to-end in one session.** The
  first source from the new-data-sources research is in production: ① **Smoke-tested** the operator's new
  account (token in-process only, never printed): US stations serve the **hfmetars 5-min variant** (median
  5.0-min cadence on KORD/KHOU vs our 30-min METAR lane) but the open-access tier is **US-ONLY** (EGLL/CYYZ/
  LTAC probe: "no access" — a tier upgrade lights intl with zero code change). ② **Built** the metar-nowcast
  twin: `parseSynopticTimeseries` (core, emits the same `MetarOb` shape → `metarRunningMax` reused verbatim),
  edge fn `synoptic-nowcast` (feeds the SAME monotonic `upsert_intraday` — the 0111 floor can only TIGHTEN),
  migration **0118** (`synoptic_obs` 14d raw log + cron `5,19,35,49` — minute lane checked against LIVE prod
  crons after the first two picks collided with health-monitor/opening-capture). ③ **Deployed + secret set**
  (`scripts/ops/synoptic-set-secret.ts` — loadEnv→CLI, value never surfaced) + **first prod tick verified
  17:57Z: 10 US stations returned, 76 five-min obs logged, 8 intraday floors advanced, 7 nowcasts rebuilt** —
  sub-hourly floors the METAR lane hadn't caught, propagated into distributions immediately. Suite green
  (+12 tests: 6 parser / 6 PGlite handler incl. token-redaction + monotone-floor pins), typecheck clean.
  **Free-tier budget noted: 5,000 req + 5M SU/mo; the lane uses ≈2,976 req/mo (59%)** — research pulls share
  the account, keep them in the remainder. Boundary intact (data source, not trading; no credentials touched
  beyond the operator's new data token, set without display).
- **▶▶ 2026-07-25 ~17:15Z (operator: "turn every stone — how do we improve live trading net profit from all
  historic data?") — ADJUDICATED FROM THE RECORD, no new run: every named dimension already carries a
  well-powered verdict; the ONE live candidate is the cheap-early forward panel, already running.** The Lane-3
  filter's step-2 check found the question fully covered: **data patterns** = BID-PATH-DISCOVERY (238M rows:
  mid-price martingale, path shape ~0 OOS AUC, NO missed pattern) + pricing-bucket exhaustive ("any future
  price-only angle is a re-skin") + nonprice-fingerprint (price is a sufficient statistic; only `house_gap`
  carries residual info and its trade loses); **time patterns** = entry-hour/lead (07-23: win rate purchasable,
  rises ≈1:1 with price+hour, EV flat; MARKET-PNL: the bet-earlier ramp is convergence carry), horizon
  freshness (the 23h ghost-quote artifact), regime/season/extreme-day/cross-horizon all KILL; **prediction
  patterns** = BREAKEVEN-SKILL (our forecast's residual info is REAL, +2.7…+6.7pp within-band, but buying our
  own bucket nets **−2.2%/$1, day-clustered CI [−4.3,−0.2]** against a 3.7–5.1pp cost wall) + C24 disagreement
  quartiles (+1.05pp, CI incl 0, 21 Q4 days) + model-trim/source-accuracy (calibrated blend dominates). REC-1's
  INSUFFICIENT (the one non-KILL) is moot — it's a maker-selection lever and the maker path measured 6.5% live
  fills. **Structural conclusion: the edge exists and is smaller than the toll; only cost-side mechanisms
  (maker: dead live · fee/rewards flip: tripwire ②) or NEW out-of-market info can change the sign — historic
  data cannot.** No new computation run (re-litigation refused per board law); full per-dimension map delivered
  in-chat. Live candidate status: cheap-early panel day one, running mean +7.65%, INSUFFICIENT (<40 mkts).
- **▶▶ 2026-07-25 ~16:35Z (loop wake — first cycle after the cheap-early build session) — the CHEAP-EARLY
  FORWARD PAPER PANEL is LIVE END-TO-END + the loop branch is reconciled with main.** ① PR #46 (squash
  `bbbc0f8`: replay engine + view + migration **0117** + edge fn `cheap-early-panel` + the `/cheap-early` page)
  merged to main and deployed last session; this cycle merged origin/main back into the loop branch (`a417392`,
  pushed — the standing post-squash reconcile, PR-#23 lesson). ② Panel verified on prod: cron `47 * * * *`
  active; the two build-session ticks wrote snapshots 1–2 (**34 considered / 9 entered / 6 realized markets /
  4 cities, running mean net +7.65%**, label INSUFFICIENT_DATA, cityErrors 0, ~33 s/tick);
  `gateWriteSkipped:'degraded'` confirmed as the INTENDED sufficiency withhold (`nMarkets 6 <` the 40 floor —
  NOT the maker-exit infra-block pattern; the gate-of-record row starts writing at ≥40 markets, source
  `forward-cheap-early`, distinct from the live lane's preflight source by design). First SCHEDULED cron fire
  **verified 16:47:00Z: pg_cron fired + the fn answered 409 `ERR_ALREADY_RAN`** — the hourly period claim
  `…T16:00` was already consumed by the 16:01Z build-session verification tick, so the dedupe did exactly its
  job (same claim discipline as the §8.1 periodKey lesson; NOT a failure). **↳ ~18:00Z: the first CLEAN
  scheduled snapshot CONFIRMED — 17:47:01Z claimed `…T17:00`, ok, snapshotId 3, 7 markets.** The running
  mean flipped **+7.65% → −8.2%** as the 7th market realized — the day-one positive is already small-n
  noise, exactly what the ≥40-market sufficiency floor exists to gate; no verdict until it fills. **No
  capital before a frozen paper PASS; watch-only.** ③ Sweep otherwise
  GREEN (numbers in the heartbeat); the 07-24 22:23Z `maker-exit`-tagged SELL row in orders-24h is the routine
  resolution-loss bookkeeping for the 07-24 @0.23 buy (21.68 sh, basis $4.99, expired worthless) — already
  folded into the cash accounting, not a new event.
- **▶▶ 2026-07-25 ~06:42Z (loop wake, +1h) — STILL ALL-GREEN; one routine live fill confirms the lane is actively
  working.** A 07-25 city market entered the [2,12]h window between cycles and the lane bought it: **partial FAK fill
  06:20:06Z, 18 of 28 sh @ 0.14 avg = $2.52** (market 0x371c…f9dd, one of the 4 allowlisted cities). Within envelope
  by construction — 0.14 ≪ the 0.30 cap, $2.52 < the $5 stake, passed the allowlist/dead-pick/favorite-veto gates —
  and `status='partial'` is a terminal recorded fill (the FAK killed the unfilled 10 sh), NOT dangling. Everything
  else steady vs the 05:40Z sweep: jobs 0-fail/24h (the same 1 transient metar blip in-window) · 0 unsent alerts ·
  DB **2053 MB** / captures **612 MB** (under bars) · the 2 benign orphan `placed` rows unchanged · mode live ·
  Google panel 6 dates (sawtooth). Efficiency-monitor: today's Action is drift-pending (`gh run list` shows its
  scheduled fire lands stably ~08:44Z, not 06:17Z — so 07-24 08:44Z is still the latest snapshot; **not a skip**, no
  dispatch). Nothing needs you; 07-31 override renewal re-surfaces from ~07-28.
  - **↳ ~07:46Z (+1h): quiet, still green.** No new fills (lead_window; 06:20Z partial stands, cash **$97.39** =
    $99.94 − the $2.52 fill, accounting checks out). DB **2058 MB** / captures **616 MB** (under bars). Google panel
    ticked **6→7 dates** (27 mkts / 12 cities — INSUFFICIENT still, <40-market bar; the sawtooth re-accruing).
    A momentary `opening-capture:1` in the raw fail count was an **in-flight `running` row**, not a failure (C96
    false-positive: last 12 runs all ok, direct fail-query empty) — captures 100% healthy. 2 orphan `placed` rows
    and mode live unchanged; eff-monitor Action still pending its ~08:44Z fire.
  - **↳ ~08:48Z (+1h): green; today's eff-monitor Action LANDED (08:25Z) → S1 KILL n=5,757** (the well-powered
    null holds). No new fills (lead_window, cash **$97.39** unchanged). DB **2063 MB** / captures **620 MB** (under
    bars). Only real cron blip in 24h is still the aging 07-24 18:04Z metar transient (fail filter now excludes
    in-flight `running` rows, so the raw count is clean). Mode live · 2 orphans · 0 unsent alerts — all unchanged.
- **▶▶ 2026-07-25 ~05:40Z (loop wake — first cycle after the convergence-capture close) — ALL-GREEN sweep; the
  live lane is still confirming the KILL with real money and is HEALTHY; nothing needs you today.** ① **Buy lane:**
  mode live, interlock **ok:true** (override id=2 → **07-31 00:00Z**), 4-city allowlist, cap 0.30,
  `stopAfterFirstSuccess` false (continuous), `laneHalted` false; tick clean (**344 ok / 0 fail / 24h**, latest
  05:36Z). No candidates now = `lead_window` (all 8 markets 30.5h/54.5h to close; next window ~**07-26 00:00Z**).
  Recent fills all within per-city caps: 07-24 @0.23 (21.7 sh) + @0.27 (18 sh) · 07-23 @0.34 + @0.42 · 07-22 ×3.
  **Money-safe:** cash **$99.94**, positions_value **$0.00** (12 dust positions), no unaccounted exposure.
  **One benign housekeeping note (no money, no action needed):** 2 orphan `placed`/zero-fill FAK rows (07-23 04:18Z,
  07-24 07:48Z) — the fill-poll threw at placement (same class as the 07-19 wellington incident), so they skipped
  the inline zero-fill→canceled adjudication AND sit outside the reconcile sweep (`bot_order_list_dangling` only
  covers `intent`+no-order_id). They filled nothing (cash is *up* since 07-22, not down), their markets have
  resolved, and they block nothing live. This is the **conservative-safe** outcome by design — an orphan `placed`
  row over-blocks rather than risking a double-place — so it is NOT broken; logged as a LOW-severity build-queue
  item (§7④), not rushed into the live double-place guard. ② **Cron health:** all 19 jobs 0-fail/24h except **1**
  transient `metar-nowcast` fail (07-24 18:04Z, `aviationweather.gov` upstream, self-recovered — 47 ok since);
  **0 unsent alerts / 7d**; deadmen quiet. ③ **Storage:** DB **2046 MB** · opening_captures **606 MB** — far under
  the 3.5 GB / 2 GB bars (~80 MB/day regrowth); no action, retention re-runs ~weekly. ④ **Forward instruments:**
  efficiency-monitor **S1 KILL** (n=5,785 / 45c / 36d, mean −0.85% — well-powered null, still tightening; snapshot
  07-24 08:44Z, today's Action not yet due) · **S2 INSUFFICIENT**. **Google panel INSUFFICIENT** (26 scored / 12
  cities / **6 dates** — the expected post-prune sawtooth, just under the 7-date bar, re-accruing; non-load-bearing,
  #12 dead). ⑤ **mode = live** (unchanged; the authorized live test, not a reopen). **YOURS — one click, not due
  yet:** the 07-31 override renewal (I re-surface it from ~07-28). Everything else runs unattended.
- **▶▶ 2026-07-24 (later) — the CONVERGENCE-CAPTURE run is COMPLETE (the entry below prepped it; this ran it).
  All three arms closed, all KILL-or-NULL. Signal #12 stays dead; nothing needs you from this run.** ① **Market-signal
  SELECTION** (buy the bucket the market's own bids point to, sell into convergence — your exact framing):
  **KILL, 14 of 14 cells** (frozen 10-city gate + an exploratory 45-city panel, headline TP 0.25) — every clustered CI
  wholly negative, winFrac **8.7–32.7%** against a 0.50 bar. ② **Betting NO** on that bucket: a **powered NULL** —
  straddles zero on every powered cell (45c M0-pure **−0.83¢/share**, CI **[−3.77¢, +1.82¢]**, seeded bootstrap
  agrees). ③ **HOLD to resolution**: **KILL**, −4.30¢ to −5.57¢/share, CI excludes zero. **One-line mechanism:** the
  favorite-longshot bias on the cheap bucket is **real at +2–3¢/share** and the **2.2–2.3¢ half-spread a taker crosses
  cancels it almost exactly**, with the 0.55–0.58¢ fee eating the residual — *maker edge, not taker edge*, the same
  wall as CONVERGENCE-TUNING, now measured from the inverse side. Your premise came back falsified the other way:
  **market selection is WORSE than our forecast at picking winners** (pure winFrac M1 13.8% / M2 15.9% / M4 12.6% vs
  M0 24.5%; unfiltered ladder 31.3% ours vs 21.8/25.5/20.9%). Panel: two archives merged → **1,179 events / 45 cities
  / 27 dates**, 100% resolution coverage. **Two methodology catches worth more than the numbers:** a `selectRule`
  returning `null` silently meant *"fall back to forecast argmax"*, so M1–M4 were partly becoming **M0** — without the
  `requireRuleTarget` fix the run would have reported "market selection ≈ neutral", a pure artifact; and an
  underpowered constant-outcome cell read as a screaming **+16¢ PASS** (n=10, all 10 won → zero outcome variance, the
  t-CI collapses to measuring price dispersion) — now guarded **in the tool**, and under that guard **no cell anywhere
  in the 14 runs shows a readable positive**. Both pinned by tests. Suite **3,421 green** (+24, no regression),
  typecheck clean. Read-only throughout — nothing placed, no credentials read. Full record:
  **`docs/ops/CONVERGENCE-CAPTURE-RESULTS.md`**; folded into `FINDINGS.md` + `SIGNAL-BACKLOG.md` §13-R. **Live lane +
  Google panel keep running unchanged; the 07-31 override renewal is still the one operator click.**
- **▶▶ 2026-07-24 (operator: "the play is to bet what the MARKET will guess … catch it cheap early and sell
  into likelihood … prep another analytics run for next session — switching model, clean context") — HANDOFF
  PREPPED, not run.** Verified (last session) the Google "win rate" is a CONVERGENCE rate, not forecast
  accuracy (engine `google-bucket-replay.ts:394-426`: 93% of wins = `take_profit` sells before resolution;
  hold-to-resolution hit ~5%). New run tests the operator's exact framing: **select the buy bucket from the
  MARKET's bids (not our forecast) + sell into convergence.** Only code change = the `selectEntries` seam
  (`opening-convergence.ts:432`, argmax(houseProb) → market-signal). Engine/data/gate all exist
  (`opening-bracket-replay.ts` + `openingVerdict` + the 835-event `opening-captures-archive` + `market_events`
  resolution). Turnkey doc: **`docs/ops/CONVERGENCE-CAPTURE-HANDOFF.md`** (self-contained for a fresh model;
  cites the KILLs so it doesn't redo dead work; honest prior = likely KILL — signal #12's home turf, taker
  spread eats it / maker won't fill). Memory + index updated so next session's startup surfaces it. Read-only,
  boundary intact. **Live lane + Google panel keep running unchanged; override renewal (07-31) still the one
  operator click.**
- **▶▶ 2026-07-23 ~12:00Z (operator: "we buy bad positions … some of our limits are holding our win rate
  back" → "let it run a couple more days, improve what can be improved") — DIAGNOSED + verified; NO edge fix
  exists, so improvement = the anti-junk guards (confirmed live) + a durable record.** Powered the operator's
  hypothesis on the **624-bet / 4-city / 41-day** `city_paper_bets` corpus (live lane is n=13): the traded
  edge is a **day-clustered null, mean −0.66%, 95% CI [−5.3%, +4.0%]**, net −$96 at a 63% win rate. Mechanism:
  the lane enters at ~00:02Z = **12h before close** (far edge of [2,12]h) = pre-floor, max-uncertainty →
  market prices our bucket cheap → we buy a low-prob bucket → it "realises faulty soon after." **Win rate
  rises ≈1:1 with price** (≥0.60 favorites win 80% but are the biggest loser, −$237) and ≈1:1 with entry hour
  (38%→85% as the floor forms, ask tracks it) → **win rate is a purchasable vanity metric; no cap/lead setting
  adds profit** — signal #12, killed six ways (full write-up: `BUY-TABLE-LIVE.md` §2026-07-23). **What IS
  improvable — verified live 2026-07-23:** the guards that stop pathological buys are firing —
  `deadPickMinBid 0.02` + `favoriteVetoProb 0.85` (0115), 0111 dead-bucket floor, hard $0.01 min ask; post-guard
  fills sit 0.26–0.44, no lottery tickets since. Did NOT build per-bet live grading (buy-table markets aren't in
  `market_events`; winner source is the 2-day-pruned capture RPC — machinery not worth it for a dead signal /
  n=13; the wallet aggregate + the paper corpus already answer it). **Operator-only levers surfaced, not
  actioned** (they change the scoreboard, not the P&L): narrow the lead window / add a min-ask floor. **Decision:
  run continues (operator), config unchanged; reassess ~07-25.** Lane state unchanged: mode live, override →
  07-31, 4-city, cap 0.30, continuous; 3 fills 07-22 + 2 fills/1 pending 07-23 within caps.
- **▶▶ 2026-07-22 ~18:00Z (loop wake — Cycle rota) — ALL-GREEN sweep; the continuous live lane is quietly
  confirming the KILL with real money (≈−$30 over 5 days); the ONE upcoming click is the 07-31 override
  renewal.** ① **Buy lane healthy:** mode live, interlock **ok:true** (override id=2 active → expires
  **2026-07-31 00:00Z**), 4-city allowlist, `stopAfterFirstSuccess` false (continuous), `laneHalted` false;
  tick 17:43Z clean, **344 ok / 0 fail / 24h**. **3 fills at the 07-22 00:02Z window** — the FIRST full
  window under the 0115 dead-bucket guards: @0.32/15sh · @0.26/19sh · @0.40/12sh, all within their per-city
  caps ($14.61 staked), resolved 12:00Z, ≥1 booked loss. Quiet now (all 8 markets outside the [2,12]h lead
  window; next ~**07-23 00:00Z**). ② **Jobs:** all 19 crons **0-fail/24h**, 0 error rows/48h, deadmen quiet,
  efficiency-monitor Action fired (snapshot 08:46Z). ③ **Storage:** DB **1744 MB** · opening_captures
  **362 MB** — far under the 3.5 GB / 2 GB bars (~110 MB/day regrowth off the 07-21 reclaim floor of 1634 MB);
  no action, retention re-runs ~weekly. ④ **Forward instruments:** efficiency-monitor **S1 KILL** (n=5,487 /
  45c / 34d, mean −0.51% CI [−1.17%, +0.14%], zsMC 2.0% — tightening) · **S2 INSUFFICIENT** (15 troughs).
  **Google panel: INSUFFICIENT (15 scored / 8 cities / 4 dates)** — dropped **53→15** after the 07-21 captures
  prune (it replays opening_captures; the 2-day retention knocked its scorable window back to 07-19..07-22).
  **NOT a regression** — it re-accrues dates between the ~weekly prunes (a sawtooth around the 7-date bar), and
  #12 is dead so its verdict isn't load-bearing. ⑤ **mode = live** (unchanged; the authorized live test, not a
  reopen). **YOURS — one click:** the 07-31 override renewal (I re-surface it from ~07-28). **DECISION FOR
  YOU:** the lane is now down ≈**$30 real** since the 07-18 first fill (start $107.80 → cash $77.68 + $0.02
  dust, 10 dust positions), staking ~$51 over 5 days — plumbing AND the KILL are both proven live now; keep it
  running to 07-31 or wind it down early is your call (I never touch caps/allowlist/mode).
- **▶▶ 2026-07-22 ~00:10Z (operator: "Run the multi-agent code review protocol") — 15-agent adversarial review of
  today's storage builds → 1 HIGH data-loss finding + 5 LOW, ALL fixed + re-verified.** Workflow: 6 dimension
  reviewers → adversarially refute each finding (9 raw → 6 confirmed). **HIGH (real):** the incremental gate
  trusted id-monotonicity (`maxId ≤ lastId`) and `verifyCoverage` was a count-only rubber-stamp once prunes
  inflate `rowsWritten` — an out-of-order commit could leave a live low-id row in no shard, and the prune would
  then delete it (breaks "no archive, no delete"). **Fix:** replaced with a **row-level count gate**
  (`underArchivedCandidates`: refuse any event whose archived-row-count < live-row-count; a per-event
  `_event_counts.json` sidecar) — verifies actual archival, no monotonicity assumption. **LOWs fixed:**
  archive-retention drift now SELF-HEALS (re-archive on drift-up, `covered = archive ⊇ live`) instead of
  permanently wedging the prune; `--incremental` clears a stale `verified` before appending; the retention test
  now actually pins 30d→7d (a 10-day row); dry-run count relabeled. Live-revalidated (sidecar written,
  count-gate dry-run clean). +9 ops tests, suite green, typecheck clean.
- **▶▶ 2026-07-21 ~23:15Z (operator: "Build it") — the DURABLE fix for opening_captures retention is BUILT: an
  incremental-append dump + per-event coverage gate → the recurring 863 MB chore is now two cheap commands, no
  `--force`, no rename foot-gun, no forced VACUUM FULL.** `dump-opening-captures.ts --incremental` continues from
  the manifest `lastId` even on a `done` archive, appending ONLY new rows; `verifyCoverage` replaces exact-match
  (the append-only archive is a SUPERSET of live after a prune → checks live ⊆ archive on the id-prefix); the
  prune gained `coverageBeyondArchive` (per-event `maxId ≤ lastId`) as the real delete gate — monotonic
  append-only ids ⇒ maxId ≤ lastId means every one of that event's rows is archived. **Proven live:** appended
  330 rows in one shard (from `id > 614347`), coverage-verified ✅, prune dry-run clean. Loop's ongoing path is
  now `--incremental` → `prune --preflight dump --resolved-age-days 2 --execute` (VACUUM only when bloated;
  steady prune keeps it flat). +16 ops tests, typecheck clean. Runbook: `STORAGE-TIERING.md`.
- **▶▶ 2026-07-21 ~20:55Z (operator: "Run it — make sure no data is lost") — the BIG chunk is RECLAIMED:
  `opening_captures` 1300 MB → 277 MB (~1,023 MB), DB 2652 → 1634 MB. Zero data lost, zero job failures.**
  No-data-loss method: preserved the C96 archive (renamed `opening-captures-archive-c96-20260707` — the only copy
  of the pre-07-06 book) → **fresh full dump** of the current table (311,406 rows / 835 events / 208 shards / 546
  MB local) → **`--verify` PASS** (archive rows == live 311,406, events == 835 — the delete gate) → dry-run
  preflight (all **644** candidates present in the verified dump) → archive-gated **prune resolved > 2d**
  (246,297 rows / 644 events, ~817 MB) → **`VACUUM FULL`** (survived the MCP client timeout, ran ~2 min
  server-side, nothing blocked). Capture + buy-tick ran clean throughout (the transient "1 fail" was an in-flight
  `running` capture row, not a failure). **Session total: DB ~2.9 GB → 1634 MB (~1.27 GB reclaimed).**
  **RECURRING:** opening_captures regrows ~95 MB/day → re-run retention every ~1–2 weeks — now the two cheap
  incremental commands (see the 23:15Z entry above; the `--force`/rename/VACUUM-FULL chore is retired). Floor now
  ~1.6 GB; lower still needs the dashboard summary-table
  re-architecture (forecast_snapshots + bucket_probabilities).
- **▶▶ 2026-07-21 ~15:30Z (operator-directed) — STORAGE TIERING shipped: a table-driven archive→prune tool + an
  edge-retention cron tightening → ~305 MB reclaimed now with the full history kept LOCAL; the big 863 MB
  opening_captures reclaim is now a one-command off-peak op.** Operator's call: "utilise only what operations
  need on Supabase, keep the bulk local for training/testing." Mapped every large table's live-vs-research
  readers first, then: ① NEW `scripts/ops/archive-retention.ts` — config-driven LOCAL archive (gzipped NDJSON
  day-shards under `scripts/research/out/<table>-archive/`) → verify → archive-gated prune (dry-run default;
  a Supabase cron can't verify a local archive, so keep-local tables must be pruned by a local script), +4
  tests; ran live → **market_rewards 140 MB → 32 kB** (dead signal, 336k rows now local) + **model_stats_history
  37 → 24 MB** (63k rows local). ② migration **0116** — ops_downsample `edge_evaluations` 30d→7d (no research
  reader; live /events wants only latest ~44/event) → one-time delete + VACUUM FULL **186 → 34 MB**. **DB ~2.9 GB
  → 2652 MB.** Full policy + runbook: **`STORAGE-TIERING.md`**. `opening_captures` ~863 MB was then **DONE** the
  same day (see the 20:55Z entry above → DB 1634 MB). Going below ~1.6 GB needs materialised dashboard summaries
  so forecast_snapshots + bucket_probabilities scored history can also go local (flagged, not built). Suite green,
  typecheck clean.
- **▶▶ 2026-07-21 ~12:10Z (loop wake) — PR #42 MERGED to main (0114 fast lane + 0115 dead-bucket guards +
  g2 Google port); ALL-GREEN health verified; the Google g2 re-replay CONVERGED → KILL (signal #12 stays
  dead).** Main was behind deployed prod (the fns/migrations went live 07-20/07-21 but the PR sat unmerged) —
  squash-merged `47dc6a6`, CI green, loop branch reconciled (zero content diff vs main). **Buy lane health:**
  buy-table-tick clean (12:03Z ok, mode live, 344/0 runs/24h; the 0115 guards are LIVE in the tick stats —
  `deadPickMinBid 0.02`, `favoriteVetoProb 0.85`, `slimRead true`); interlock ok:true (override id=2 → 07-31);
  config mode live / cap 0.30 / 4-city / `laneHalted` false. No candidates now = `lead_window` (12:03Z is
  outside the 00:00–10:00Z window — expected; the guards first get exercised in the 07-22 window). **All 19
  cron jobs 0-fail/24h.** **Google panel:** the g1→g2 cold re-replay finished — `askMax 0.15`,
  `nSafeguardBlocked 5`, 53 scored markets → gate **KILL** (winFrac 45.28% < 50% bar). The guards + wider band
  did NOT resurrect the signal; the positive meanNetReturn CI [+10.8%, +112%] is the documented cheap-longshot
  payoff-variance artifact the winFrac sub-gate exists to catch (nonprice-fingerprint-kill). #12 stays dead.
  **The 07-21 KL dead-bucket buy** (500 sh 33°C @ $0.01, 06:04Z — the 0115 motivator) predates the ~07:10Z
  guard deploy; hold-to-close −$5, books on the next post-poll tick. **Storage (approaching, not at bar):**
  opening_captures **1298 MB** (832 at C19 07-16; ~93 MB/day → 2 GB bar ~07-29). ~863 MB is aggressive-prunable
  (671 events resolved 1–25d) but the on-disk dump is stale (07-05) so the reclaim is NOT one-command-ready —
  the stock 25-day path is a no-op (07-07 cleared through 07-05). Playbook when it threatens (off-peak):
  `dump-opening-captures.ts --force` → `--verify` → `prune-opening-captures.ts --preflight dump
  --resolved-age-days 1 --execute` → `VACUUM ANALYZE`. Deferred deliberately (a re-dump now would be redone at
  prune time). **Yours:** nothing needs you today; the ONE upcoming click is the gate-override renewal (expires
  07-31 00:00Z — surfaced from ~07-28). price_cap is now 0.30 (you lowered it from the C18b 0.40 — that watch
  item is CLOSED); active_until 09-15.
- **▶▶ 2026-07-19 ~10:15Z — the "wellington bought $10" operator report → an ACCOUNTING bug, not an
  overspend: FILL-PRICE TRUTH fix shipped + the ledger row corrected to venue reality.** The 00:53Z
  wellington retry (15-sh FAK, limit 0.34) was filled by the negRisk adapter at a BETTER price:
  venue trade = **32.179165 sh @ 0.1585 avg = $5.10** (exactly the intended notional; wallet debit
  confirms — balance $89.48). Our fill poll recorded the LIMIT as the price (getOrder's `price` field
  is the limit, not the execution average) → a phantom $10.94 notional in the ledger + Slack.
  Fixed: `postAndRecord` now reads the venue TRADE RECORDS (taker legs by order id) for the
  size-weighted average — fallback poll price → limit (fail-soft); helsinki/KL were exact-at-limit so
  unaffected. Prod ledger row corrected ($10.94 → $5.10, fee 0.547 → 0.255, avg 0.34 → 0.1585;
  venue-verified via public data-api + balance arithmetic). Suite 3,306 green; fn redeployed.
  NOTE: wellington 14°C sits at cur ~0.02 (likely loss ~$5.10 at 12:00Z) — bought pre-floor-gate;
  under 0111 it would need the running max to allow 14°C (13.0°C at last read — technically alive).
- **▶▶ 2026-07-19 ~08:15Z (operator-directed) — TWO FIXED PRICE RULES SHIPPED after the helsinki
  dead-on-arrival buy: the 0111 DEAD-BUCKET FLOOR gate + a HARD non-configurable $0.01 min ask.**
  Operator confirmed the helsinki mechanism ("at purchase time the temperature had already reached 20°C —
  a direct loss") and ordered a dead-buy rule set + "global min price at 1c — non changeable". Shipped:
  ① migration `0111` `buy_table_intraday_floor` (observed intraday running max per city+date from
  `intraday_max` ⋈ `city_stations`) + the tick's `dead_bucket` gate — skip any predicted bucket whose top
  `wuRound(observed max → native)` has cleared (top tails never dead; FAIL-OPEN by monotonicity); live
  check: helsinki 07-19 floor reads 20.0°C → yesterday's buy would have been skipped. ② `HARD_MIN_ASK
  = $0.01` — a CODE CONSTANT by operator order (no config key, no /trading input; distinct from the
  removed 0109 per-city min INPUT — this is fixed model law, tested to be config-immune).
  diag-buy-lane reads the same floor RPC (zero drift). Suite 3,305 green; 0111 applied + fn redeployed
  mid-window (~08:10Z); PR #34. Panel copy + BUY-TABLE-LIVE.md state both rules.
- **▶▶ 2026-07-19 ~01:00Z — FIRST CONTINUOUS-MODE WINDOW: 2 fills at the OPENING TICK (00:03Z), Slack
  delivery PROVEN end-to-end; 1 wellington zero-fill reconciled venue-verified.** Fills: **kuala-lumpur 32°C
  17 sh @ 0.29 = $4.93** · **helsinki 19°C 5000 sh @ 0.001 = $5.00** — both pushed to Slack `sent=true`
  (the webhook's first delivery since 07-12). The helsinki buy is the cheap-longshot fingerprint on full
  display: our house argmax says 19°C, the market says ~0.05% (marked −50% within the hour) — $5 bounded,
  resolves 12:00Z; watch whether the house seed (`ensemble_raw`) is stale/miscentered for helsinki before
  reading it as bad luck. Wellington: 00:23Z FAK @ 0.34 got venue order 0x2d2a…7db1 but the fill poll threw →
  row held 'placed'/0 (fail-safe; the failure alerts were C16-suppressed unrecorded, as configured). Venue
  truth established via PUBLIC reads (data-api: NO wellington position; pUSD $94.73 = exact no-fill
  arithmetic) → row adjudicated `canceled` ~00:45Z (the F1 outcome the failed poll blocked; C18 reconcile
  precedent + the standing continuous-buying order) — wellington retryable (attempt 2/3) while the window
  runs to 10:00Z. Also fixed+redeployed: sub-cent fill prices rendered "@ 0.00" in the Slack body
  (toFixed(2)) — now exact ("@ 0.001"). Positions now: ankara 07-19 6 sh @ 0.44 (cur 0.65, +48%!) ·
  KL 17 sh @ 0.29 · helsinki 5000 sh @ 0.001 · old 07-05 karachi dust (1.9 sh, worthless). Balance $94.73.
- **▶▶ 2026-07-18 ~18:25Z (operator-directed) — SLACK RE-OPENED FOR BUY FILLS ONLY (C16 narrowed by exactly
  one kind, not lifted).** Operator: "Open up slack to push info on buy orders, what was bought and at what
  price." No fill-success alert kind existed (0095's kinds are all failure classes) → built `BUY_TABLE_FILLED`
  (INFO): every LIVE fill pushes city · bucket · shares · **actual avg fill price** (the venue poll's, threaded
  through the executor as `OrderPlacementResult.avgPrice`) · cost · hours to close. Migration `0110` appends the
  kind to the C16-emptied allowlist → prod allowlist is now exactly `BUY_TABLE_FILLED` (verified). Everything
  else (whale/deadman/digest/ORDER_* CRITICALs) stays dark per the standing C16 order — **failure alerts still
  push NOWHERE; keep reading Edge logs/diag for those.** Fn redeployed; suite 3,295 green. Slack delivery itself
  is proven on the first fill (webhook last delivered 07-12; an undelivered push lands sent=false and the
  health-monitor resend sweep retries it).
- **▶▶ 2026-07-18 ~18:00Z (operator-directed, interactive session) — CONTINUOUS BUYING IS ON (the expected
  state is now an ACTIVELY BUYING lane, not a quiet one).** Operator: "I want buying to be active … set
  everything up for it to run continuously." Set live (direct writes, trigger-audited, authorization = the
  chat instruction): `stop_after_first_success` → **false** (the post-ankara self-halt is OFF), allowlist →
  the 4 measured-strongest cities with max-caps set below each city's measured prediction success rate
  (EV = rate − ask): **ankara 0.45** (92% success, n=13) · **wellington 0.40** (79%) · **helsinki 0.35**
  (69%) · **kuala-lumpur 0.30** (57%); `active_until` → **2026-09-15**. Dropped from the allowlist:
  karachi/shanghai/mexico-city/chongqing/houston (measured 46–57% — negative-EV at their caps).
  diag-buy-lane verdict post-change: interlock **ok:true**, laneHalted false, only blocker = lead_window
  (next buy window ~**2026-07-19 00:00Z**; expect up to ~4 × $5 buys/day). **The ONE remaining expiry:
  gate override id=2 ends 2026-07-31 00:00Z** (DB-capped ≤14d — the §9R deadman, not defeatable): buying
  stops there unless renewed from /trading. Loop: re-surface the renewal daily from ~07-28. Slack stays
  dark per C16 — fills push nowhere; monitoring is pull-only (/trading, diag-buy-lane).
- **▶▶ 2026-07-18 (operator-directed, interactive session) — BUY-TABLE PRICE INPUT IS NOW MAX-ONLY (0109).**
  The 0097 per-city **[min, max]** purchase range lost its min everywhere: the lane buys whenever the
  predicted bucket's ask is **at or below the effective cap** (per-city max when set, else the global
  `buy_table.price_cap`). Rationale: every live override sat at min 0 anyway — the min input was pure
  foot-gun surface. Shipped end-to-end: migration `0109` (new flat `buy_table.city_price_caps` map + RPC
  `buy_table_city_cap_set`; the old range RPC dropped, existing ranges folded to their maxes — all 9 city
  maxes preserved verbatim, behavior unchanged at cutover), the tick's gate, the §8.2 route, the `/trading`
  "Buy-table price caps" panel (min column gone). Also fixed in passing: `derive-deposit-wallet.ts`'s §15
  boundary violation (key read moved into `live.ts` `deriveOwnerIdentity`; the invariants suite had been red
  since C46d) + `buy-table-tick` codified `verify_jwt=false` in `config.toml`. Suite 3,293 green.
- **▶▶ C19 (2026-07-16 ~13:45Z, operator-instructed) — MULTI-DAY AUTONOMOUS SESSION STARTED (v18).**
  The loop now self-paces around the clock: every wakeup runs the **Cycle rota** (section below), fixes
  breakage within the escalation rules, and works the calm-day build queue when all green. **C19 baseline
  ALL-GREEN:** jobs 24h clean (1 transient metar fail 07-15 17:34, 47 ok since; buy-table-tick 144/144;
  every C15 lane on schedule), 0 live orders beyond the reconciled 07-12 row (0 live fills ever), lane
  inert on the expired override exactly as designed, Slack dark per C16.
  - **Yours (surfaced, not acted):** ① **override renewal from /trading — the ONLY closed gate**; after a
    renewal the first natural candidate window is ~00:00–10:00Z (any day), and at cap 0.40 three of the
    four cities were admitted on 07-16 prices. ② **price_cap still 0.40** (C18b: you lower it yourself —
    I re-surface this every day until it changes, per your instruction). ③ **active_until 2026-07-20** —
    the run-window closes then; bump it from /trading if the lane should keep hunting past it. ④ Slack
    stays dark until your word (restore string in ⚑ C16).
  - **Storage watch OPENED: `opening_captures` is 832 MB** (75 MB after the 07-07 prune → ~85 MB/day
    regrowth; DB total 2,376 MB; next tiers market_snapshots 432 MB, bucket_probabilities 346 MB). The
    C96 dump→prune→VACUUM-FULL playbook stands ready; if it threatens the Micro before you're back I
    archive-verify-then-prune off-peak and log it here first.
  - **↳ C20 (~14:25Z): PR #23 MERGED to main (CI green — main now matches deployed prod) + the F4
    calm-day build item is DONE: the cloud buy-table tick now opens every LIVE tick with the
    lane-scoped reconcile sweep** (the daemon startup sweep's periodic twin — a stuck 'intent' row
    like the 07-12 shanghai one is now auto-adjudicated against venue evidence and, if freed, the
    market is retryable the SAME tick; foreign/daemon rows untouched; sweep failure isolated).
    Suite 3,237 green · deployed ~14:21Z · verified on the 14:23Z tick (reconcileFailed:false).
    The PR-#23 conflict lesson: the loop branch must merge origin/main back after every squash.
  - **↳ C19a (~14:00Z): REAL BREAKAGE FOUND + FIXED — the efficiency-monitor Action died 07-15 AND
    07-16** (both days' snapshots lost, accrual stalled since 07-14). Root cause: GitHub's scheduled-run
    drift (2–3.5h; fires landed ~08:35Z) put the start inside the script's own reserved :32–:42 UTC
    window, whose guard HARD-THREW. Fixed: the guard now waits until :43 (bounded ≤11 min; +5 tests);
    recovered today by manual dispatch → **snapshot id=9 as-of 07-16: S1 KILL n=4,742 · S2 12 troughs**
    (nothing lost — the walk is cumulative, the missed days folded in). Fix must live on main →
    **PR #23** (also ships the deployed C18 build, closing the main-vs-prod drift). City race verified
    same cycle: 13:50Z -b fired on the second, ankara ×2 placed.
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

## Cycle rota (v18 — run every wakeup, in this order)

1. **Buy lane (highest priority).** `job_runs` buy-table-tick clean since last cycle; any new
   `live_orders` rows with `strategy='buy-table'`; override state (has the operator renewed?). **If a
   real post/fill appears** — the first ever — that becomes the cycle's whole job: verify ledger
   transitions, caps honored, `stop_after_first_success` halt (`stats.laneHalted`), zero-fill FAK
   adjudication (C18d F1), no dangling intents; then track it to grading. For any "why no buys":
   `pnpm tsx scripts/diag-buy-lane.ts` FIRST (read-only, one command).
2. **Cron/job health.** `job_runs` failures last 24h ≈ 0 (a failed daily re-fires same day — verify
   attempt 2 landed); deadmen quiet; efficiency-monitor Action fired 06:17Z (`gh run list`; on a skip,
   manual-dispatch — C2 precedent).
3. **Storage (~daily).** DB + top-table sizes. Alarm bars: DB > 3.5 GB or `opening_captures` > 2 GB →
   run the C96 archive→prune→VACUUM-FULL playbook off-peak, archive verified before any delete, board
   log first. Baseline C19: DB 2,376 MB · captures 832 MB (~85 MB/day).
4. **Forward instruments.** City race: 10:00/13:50/20:45Z lanes placed + grading current. Google panel
   toward n≥40 — **but note (07-22): it replays opening_captures, so the 2-day retention prune caps its
   scorable window; INSUFFICIENT between the ~weekly prunes is EXPECTED (sawtooth around the 7-date bar),
   NOT breakage — #12 is dead so its verdict is non-load-bearing.** Efficiency-monitor S1/S2 verdict drift.
   `/paper-trade`, `/monitor` RPCs healthy.
5. **Tripwires.** ⑤ (trade_config.mode) every cycle; ①–④ sweep every ~2–3 days.
6. **Watch items.** ~~price_cap 0.40~~ **CLOSED** (operator lowered to 0.30 at the 07-18 continuous-buying
   config) · **gate override expires 07-31 00:00Z** → surface the renewal from ~07-28 (the one live click) ·
   active_until **09-15** (operator-extended) → surface before expiry · city_sim_config runway 09-30 →
   surface ~09-25 · storage: opening_captures → 2 GB bar ~07-29 (run the §Storage prune playbook off-peak) ·
   **synoptic TRIAL ends ~08-08** (operator-corrected 07-25: 14-day trial, commercial = contact-sales, no
   self-serve tier, .edu-only open access) → when the tick starts 401ing/empty, `cron.unschedule
   ('synoptic-nowcast')` (0118 rollback header) + keep the 14d `synoptic_obs` corpus; do NOT recommend
   enterprise pricing (sub-hourly obs = truth/analytics freshness, zero trading edge per WO-5); free
   freshness fallback = restore metar-nowcast to */15 (C15 shed it for compute, not necessity) ·
   **OBS-TRANSMISSION re-adjudication ~08-06** (before the trial dies), on the CORRECTED design
   (oracle addendum): kills at METAR/SPECI grade (IEM `asos.py` replica), 5-min stream as the
   anticipatory trigger, after the daily obs top-up + an `--incremental` capture dump. **Prior now
   firmly negative** — the 90-day deep replay (§Pass 3) reads the clean <10¢ scrap at −0.003/$1 on
   mids; expect the July margin-3 cell to die as n grows. Surface only at ≥40 trades + wholly-positive
   clustered CI on the REAL book (caveat first; INSUFFICIENT as of 07-25, `OBS-TRANSMISSION.md`).
6b. **Synoptic daily top-up (while the trial lives, ends ~08-08).** Once per day:
   `pnpm tsx scripts/research/synoptic-history-pull.ts` (defaults = last 5 days; idempotent both sides,
   ~6 requests) — keeps the LOCAL NDJSON archive current with the rolling trial window so nothing is lost
   when history access dies at trial end. After 08-08: dump any DB-only remainder from `synoptic_obs` to
   the archive, then `cron.unschedule('synoptic-nowcast')`.
7. **Calm-day build queue (all-green cycles only, in order).** ① ~~F4 cloud reconcile sweep~~ **DONE
   C20** (deployed + tick-verified + merged, PR #24). ② ~~google-paper-panel incremental replay~~
   **DONE C34** (0103 applied + fn deployed ~10:15Z 07-17; first incremental tick verification = the
   next :24 run — check stats.incremental=true + duration collapse; then PR to main). ③ ~~opening_captures
   archive prep~~ **DONE 07-25** (incremental append ran live for the OBS-TRANSMISSION cross-check: +88k
   rows to id 703395, coverage-verified — the prune is one command whenever the 2 GB bar threatens). ④ **[NEW, 07-25, LOW]
   orphan zero-fill FAK reconcile gap.** When the fill-poll THROWS at placement (net/timeout), the row is
   left `status='placed'`+order_id/0-fill and the inline F1 zero-fill→canceled adjudication (handler.ts:1086,
   acts on the SAME-tick result only) is skipped; the reconcile sweep never re-examines it because
   `bot_order_list_dangling` (0082) filters `status='intent' AND order_id IS NULL`. Result: a permanent orphan
   `placed` row that BLOCKS re-entry into that one market for the rest of its window (2 seen: 07-23, 07-24;
   money-safe, resolved). The **safe** fix (do NOT blind-cancel — that would erode the double-place guard):
   widen the dangling candidate set to also include `placed AND size_matched=0 AND order_id IS NOT NULL` rows
   older than N min, and branch the reconcile "freed" path so a posted-then-zero-filled row records `canceled`
   (FAK died) not `failed` (never posted). Touches the LIVE money-path reconcile → do it deliberately with
   venue-evidence tests, not reflexively; lane winds down 07-31 so it is genuinely optional. ⑤ Anything newly
   broken beats the queue. Suite + typecheck green after every change; board updated every material cycle.

**Escalation rules.** *Autonomous (do, then log):* code/test/cron fixes, edge-fn redeploys with in-session
precedent (buy-table-tick, health-monitor, daily-digest), failed-daily re-runs, GH Action manual dispatch,
docs/commits on this branch, read-only DB/venue checks. *Operator-only (surface, never act):* gate
override, mode, caps/price_cap, active_until, allowlist, Slack re-enable, anything placing/canceling
orders, credentials, capital. *Hard never:* trade, touch keys, re-enable Slack without his word.

**Pacing.** Self-paced wakeups (≤1h apart by clamp). Quiet: ~60 min. Event windows (a renewal lands, the
00:00–10:00Z candidate stretch while armed, a first fill, an incident, a deploy): 15–30 min. Scheduled
checkpoints to align on: 06:17Z Action · 10:00/13:50/20:45Z city ticks · 07:00Z digest job.

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
| ⑤ | trade_config.mode | anything ≠ off/dry-run → fold v16 Phase-C monitoring in as a lane | **`live` — OPERATOR-SET 07-11 12:56Z** (authorized live test, not a reopen). C18 state: mode live + window 07-20 BUT the override expired 07-15 (C17 planned lapse) → preflight fails → lane inert as designed; 0 live posts ever (the one 07-12 attempt failed shapeless, reconciled `failed` at C18). C19: unchanged — mode live, override expired + not renewed, 0 live posts. **C44 (07-18 00:03Z): first ARMED candidates — 2 live post ATTEMPTS, both failed pre-venue (transport class, $0 moved, venue-confirmed never posted); see C44.** | 07-18 C44 |

## Cycle log

- **C46e (2026-07-18 14:33Z) — ✅ FIRST LIVE FILL EVER — THE OPERATOR'S VERIFICATION IS COMPLETE.**
  Operator supplied the dedicated account (@crayzwman, trading wallet 0xD082A28C…6901). Pre-set
  verification (all public reads): the wallet is a DEPLOYED new-type deposit wallet (EIP-1822 UUPS clone →
  sigType 3), `owner()` == the dedicated signing key's EOA (0xe3C2C877…7E36 — identity chain closed), and
  it holds **$107.80 pUSD** (the C46d "never funded" verdict was an artifact of checking USDC — the new
  system wraps deposits into pUSD at 0xC011a7E1…DFB; the 0x3468 funder was indeed wrong regardless — a
  codeless, transferless address). Fix executed FROM CHAT (operator had no cmd access): Edge secrets
  POLY_FUNDER_ADDRESS→0xD082A28C…6901 + POLY_SIGNATURE_TYPE→3 set 14:21Z via the authenticated CLI (both
  public-class values; the key untouched); one tick-cycle skipped for env propagation; window opened
  (lead_max 26) at ~14:30Z. **14:33:05Z: ankara/2026-07-19 "32°C" FAK 6 sh @ 0.44 = $2.64 — size_matched
  6.0, status `filled`, venue order 0x6c6202e7…4fe1; position venue-confirmed on the public data-api.**
  The entire production chain is proven live: candidate selection → interlock (override id=2) → sizing →
  Dublin-pinned egress (0108) → clob-client-v2 sigType-3 deposit-wallet signing → venue accept → fill →
  ledger. Post-fill state: rule 2 (stop_after_first_success) halts new entries — one successful buy, then
  quiet, as designed; trial config RESTORED (stake $5, 6-city allowlist, cap 0.40, lead [2,12]);
  .env.local funder/sigType synced to match. Open position: 6 sh ankara 32°C, resolves 07-19 12:00Z
  (win → $6.00, lose → $0; risk $2.64). Operator decisions ahead: un-halt policy (stop_after_first_success
  stays true = lane stays quiet after this), the C16 alert gap, and whether the lane continues at all now
  that functionality is proven against the standing KILL record.
- **C46d (2026-07-18 ~12:45Z, same session) — ON-CHAIN TRACE: the dedicated wallet was NEVER FUNDED and the
  configured funder has no on-chain existence — the verification buy is blocked on ACCOUNT SETUP, not
  software or secrets syntax.** Operator asked to fix it through chat (no local cmd access) → public-only
  diagnostics: new `scripts/derive-deposit-wallet.ts` (loadEnv in-process, prints ONLY public identity —
  the deriveClobApiKeyPreview idiom) shows owner EOA 0xe3C2C877…7E36, funder 0x3468f892…489C (≠ EOA),
  sigType 2. Public Polygon RPC + Blockscout: the funder has **no contract code, zero USDC, zero token
  transfers ever** (it is nobody's Safe/proxy/deposit wallet — plausibly the UI's one-time deposit-funding
  address copied at setup, or an unconsummated Magic counterfactual); the owner EOA likewise has **zero
  transfers ever**. Conclusion: no Polymarket account/deposit exists for this key pair — even perfect
  secrets would next fail on balance/allowance. OPERATOR-ONLY next step (keys + capital, his side of the
  boundary): create/log into polymarket.com WITH the dedicated wallet (import the key into a browser
  wallet), deposit a small USDC amount, then hand over the account's TRADING wallet address (the profile
  address — PUBLIC; not the one-time funding address). Claude then verifies it on-chain (code + USDC
  present), sets POLY_FUNDER_ADDRESS + POLY_SIGNATURE_TYPE (3 for the new deposit-wallet type / 2 for a
  Safe — determined from the deployed bytecode, not guessed) via the authenticated CLI, opens the window
  for one tick, and the ledger records the outcome. SDK-side readiness already confirmed (clob-client-v2
  1.0.8 carries POLY_1271; executor passes sigType through — no code change). Lane state unchanged:
  allowlist ['ankara'] $3 cap 0.60 window [2,12], ankara/07-19 holds 2 attempts.
- **C46c (2026-07-18 ~12:20Z, same session) — THE REAL WALLET'S VENUE VERDICT IS RECORDED (fn v9 worked
  first try): `http 400: maker address not allowed, please use the deposit wallet flow` — the LAST blocker
  is the WALLET SETUP, an operator credentials item; the software chain is proven clean end-to-end.**
  Operator ordered the purchase completed immediately, rules skipped → lead_max lifted to 26 for one
  window; the 12:13Z tick posted ankara/07-19 (FAK 7 sh @ 0.39) from Dublin and the venue REFUSED it with
  the exact same error the throwaway-wallet probe got — now durably in `live_orders.reason` (the C46 fix's
  first live proof: decisive 4xx classification + record-without-push). Meaning: the address in
  `POLY_FUNDER_ADDRESS` is not a Polymarket-created DEPOSIT wallet (the venue no longer accepts raw-EOA
  makers; every order must trade through the account's proxy). Lane state: lead_max restored to 12
  immediately (attempt burn stopped — ankara/07-19 keeps 2 of 3 attempts); allowlist ['ankara'], stake $3,
  cap 0.60, mode live, override to 07-31. **Operator fix (BUY-TABLE-LIVE.md §2; values never in chat):
  set `POLY_FUNDER_ADDRESS` = the DEPOSIT WALLET address shown in the Polymarket UI for the dedicated
  account (not the signer EOA), `POLY_SIGNATURE_TYPE` = 2 for a browser-wallet account / 1 for an
  email-Magic account (Edge currently carries 2), keep `POLY_PRIVATE_KEY` = the account-owner key, and
  make sure USDC is deposited INTO the Polymarket account.** If the secrets are fixed before ~09:50Z
  07-19, the natural 00:00–10:00Z window auto-retries ankara (attempts 2/3) — a fill halts the lane (rule
  2, verification complete). If not fixed, ankara/07-19 exhausts harmlessly and each new day brings a
  fresh market. Restore-after-verification items unchanged: stake→5, 6-city allowlist, cap→0.40.
- **C46b (2026-07-18 ~12:10Z, same session) — TRIAL EXECUTED EARLY ON OPERATOR ORDER ("any price point");
  held ambiguous at the venue → the SDK probe EXONERATED transport entirely → the REAL classification gap
  found + FIXED + DEPLOYED (fn v9); tonight's ankara attempt is now decisive either way.** Operator wrote:
  *"You can make this trial purchase at any price point - we are sacrificing the potential bet to verify
  functionality."* By reply time the in-window markets (houston/mexico-city 07-18) were 0.4h from close →
  lead floor dropped to 0.1 + cap 0.99 + stake $5 for ONE tick: the 11:43Z tick posted a real FAK (9 sh @
  0.54, ~$4.86) — row held at 'intent' (the same ambiguous class), market closed 12:00Z, reconcile frees it.
  Then the breakthrough, keyless as always: (1) the egress pin IS honored on the cron's pg_net path (probe
  via pg_net + x-region → loc=IE, order endpoint reachable) — so the 11:43Z post ran from Dublin and STILL
  came back "shapeless"; (2) NEW `clob-sdk-probe` (throwaway Wallet.createRandom, real ankara token, 1¢ bid
  — unfillable) walked the EXACT live.ts sequence from the pinned runtime: **every step OK — import, L1
  auth, EIP-712 sign, postOrder — and the venue answered clean JSON** `{"error":"maker address not allowed,
  please use the deposit wallet flow","status":400}`. Transport, SDK, signing: ALL exonerated. **Root cause
  of the "shapeless" class: v2's http-helper returns HTTP-level failures as `{error, status}` — no
  `success` field — so the executor classed EVERY venue 4xx (DE geoblock 403 then, whatever the real wallet
  gets now) as ambiguous and the verbatim reason lived only in console logs.** Fix (packages/trading
  live.ts postAndRecord, +3 maker tests, §15 invariant exception for the keyless probe; suite 3292 green):
  a 4xx `{error,status}` is now a DECISIVE clean rejection → key freed, bounded retry, and **the venue's
  verbatim words land durably in live_orders.reason** (record-without-push — C16-untouched); 5xx/undefined
  stays held-for-reconcile. Deployed to buy-table-tick (v9). Discovery: ALL markets in this universe resolve
  12:00Z → the buy window exists ONLY 00:00–10:00Z; no afternoon retry is possible. Tonight's config
  (audited): allowlist ['ankara'] (92.3%), stake $3, cap 0.60, lead floor restored to 2h. **00:03Z outcome
  is decisive: a FILL (verification complete; rule 2 halts the lane) or a `failed` row whose reason quotes
  the venue** — if it quotes "maker address not allowed" the funder secret isn't the deposit-wallet
  address; if "invalid signature", the sigType is wrong for the account type; if "not enough balance /
  allowance", the wallet needs USDC/allowance. Each of those is an OPERATOR morning item (credentials
  side); the software side is now clean end-to-end.
- **C46 (2026-07-18 ~07:20Z, INTERACTIVE operator session) — OPERATOR-INSTRUCTED $-MINIMAL VERIFICATION BUY
  armed for tonight's window: ankara/2026-07-19 (the highest-accuracy allowlist city), stake $2.** Operator's
  written instruction (this session, verbatim): *"please crosscheck and verify trade functionality again. Do
  one $1 buy for current prediction in a high accuracy market."* Crosscheck done first: interlock ok:true
  (override id=2 active to 07-31, mode live, lane not halted), egress fix live (first pinned tick 06:23Z ok),
  diag funnel healthy. Market selection by the graded record (city_prediction_grades): **ankara 92.3%
  (12/13)** ≫ wellington 76.9% ≫ mexico-city 60% ≫ … ≫ houston 23.1% — the two in-window-NOW markets
  (houston/mexico-city 07-18) are the two WORST fits and both sit over the 0.40 cap, so the test targets
  **ankara/2026-07-19** (current pick 32°C, houseProb 0.51, ask 0.372 ≤ cap), which enters the [2,12]h
  window ~00:00Z. **$1 literally cannot execute** — the bucket's venue min_order_size = 5 shares (and
  bot.minOrderSizeShares = 5), so the floor at cap is 5×0.40 = $2 → stake set to **$2** (≈$1.86 notional at
  the current ask; max loss $2), the smallest compliant order — surfaced to the operator, not silently
  chosen. Config change (direct audited UPDATE, the C43 operator_guard precedent): stake_per_buy_usd 5→2,
  city_allowlist 6-cities→['ankara']; price cap, caps, attempts (3), stop_after_first_success (true — "one
  successful buy, then quiet", 0102 rule 2) all untouched. Expected: 00:03Z tick posts FAK 5 sh ≤0.40 from
  the Dublin-pinned runtime; a fill halts further entries; a failure is bounded at 3 attempts and burns
  nothing else (allowlist). **RESTORE (operator morning item): stake→5, allowlist→[ankara,houston,karachi,
  mexico-city,shanghai,wellington]** — deliberately NOT auto-restored mid-window so the overnight blast
  radius stays exactly one $2 ankara order. C16 alert gap still open → no push either way; the session set a
  best-effort ~00:40Z local background check as the reporting channel, morning /trading as the fallback.
- **C45 (2026-07-18 ~06:30Z, INTERACTIVE operator session — not a loop wake) — C44 ROOT CAUSE PROVEN +
  FIXED: Polymarket REGION-BLOCKS the order endpoint for the Edge runtime's default egress (geolocated
  DE); tick pinned to eu-west-1 (migration 0108, APPLIED).** Operator asked "can you fix it yourself?" →
  yes, and done. Evidence chain: (1) the C44 leading hypothesis is DISPROVEN — `supabase secrets list`
  (names/digests only) shows POLY_SIGNATURE_TYPE + POLY_FUNDER_ADDRESS set since 07-11 14:55Z alongside
  the key; (2) overnight the failure burned BOTH markets' bounded attempts: 6 identical live-post
  failures 00:03–00:53Z (karachi + one more, all `failed`, venue-confirmed never posted, $0 moved — the
  3/market bound worked); (3) a NEW keyless diagnostic Edge fn `clob-egress-probe` (deployed; no secrets,
  no signed order — an empty unauthenticated POST) invoked over the cron's own pg_net path shows the
  runtime egresses on an AWS IP Cloudflare geolocates **DE/FRA**: GET /time → 200 but POST /order → 403
  `{"error":"Trading restricted in your region…"}` — Germany is on Polymarket's restricted list, market
  data is exempt. That IS the deterministic "shapeless" HIGH-A transport failure (both 07-12 and C44).
  (4) Region sweep via the `x-region` header: **eu-west-1 (Dublin) → POST /order 401 "missing address
  header" = the CLOB API itself answering (REACHABLE)**; eu-central-1 (DE) + ap-southeast-2 (AU) → 403
  blocked. **Fix: 0108 re-schedules the buy-table-tick cron with `'x-region','eu-west-1'` in the headers**
  (also codifies the C15 minute lane 3,13,…,53 into the lineage). Interlock/override/bounds untouched;
  boundary held (no order placed by Claude, no credential touched — the probe is keyless by construction).
  **Next live proof: tonight's ~00:03Z window (07-19 markets — the two 07-18 markets stay blocked by the
  attempt bound, by design).** C44 items (a) resolved (secrets were never missing), (b) moot (Edge posts
  work from Dublin; the local daemon stays the fallback), (c) the C16 alert gap REMAINS OPEN — post
  failures still push nowhere and record nothing; operator's call (re-allowlist = Slack pushes, vs a
  record-only path).
- **C44 (2026-07-18 ~00:20Z) — FIRST-LIVE-BUY verification wake: the interlock/candidate machinery WORKED
  end-to-end; both live posts FAILED at the venue-transport layer (no order ever reached Polymarket, $0
  moved); the failure is DETERMINISTIC and its CRITICAL alerts were silently unrecorded (the C16 gap).**
  Pre-window ticks (23:33/23:43/23:53Z): 0 candidates, 8 skips — correct (lead window shut). **00:03Z: the
  window opened and everything up to the venue worked**: preflightOk=true (override id=2 satisfied the gate
  branch — the C42 blocker is gone), 1 candidate = karachi 2026-07-18 bucket "32°C" @ ask 0.27 (≤ cap 0.40),
  18 sh (=$4.86 of the $5 stake), lead window honored. The post: `failed:1, placed:0` — ledger row created
  then left at **'intent'** with no order_id = the executor's HIGH-A class (postOrder INVOKED — so the
  Edge wallet key + client construction are fine — but it threw without a decisive response). 00:13Z: the F4
  lane-scoped sweep adjudicated row 1 → `failed` ("reconcile: confirmed never posted — no open order, no
  matching trade" = venue-verified nothing posted), then attempt 2 ran and failed IDENTICALLY (row 2 at
  'intent', awaiting the 00:23 sweep). max_entry_attempts=3 → one bounded retry remains, then karachi
  blocks; stop_after_first_success=true untouched (no fill). **Diagnosis:** deterministic transport-layer
  failure of the CLOB postOrder from the Edge runtime — the exact "Edge copy unproven until first clean
  post" unknown from C18, and the SAME signature as the 07-12 shanghai failure. **Leading hypothesis
  (per the 07-12 postmortem evidence): the Edge secrets are missing the `POLY_SIGNATURE_TYPE` /
  `POLY_FUNDER_ADDRESS` mirror** — the local smoke passed only AFTER those were set locally, and CLOB
  *GETs work fine from this same Edge runtime*, making an IP/geo block second-ranked. The PR #20 response
  snapshot IS deployed (fn v8), so the Edge console logs now carry the redacted venue response verbatim
  (Supabase dashboard → buy-table-tick → Logs) — but only there, because
  **BUY_TABLE_POST_FAILED / ORDER_NEEDS_RECONCILE CRITICALs were silently suppressed AND unrecorded** —
  C16 emptied the allowlist and claim_alert drops un-allowlisted kinds entirely (the known gotcha, now
  live-money-relevant: there is NO record-without-push path today). Boundary held: no orders placed/canceled
  by Claude, no credentials touched, Slack dark. **Operator decides:** (a) check/set the
  `POLY_SIGNATURE_TYPE` + `POLY_FUNDER_ADDRESS` Edge secrets (runbook §2 — a proxy-funded wallet NEEDS
  them) and read the verbatim response snapshot in the dashboard console logs to confirm; (b) if it turns
  out to be an egress block instead, the LOCAL daemon `scripts/trade-bot.ts` (T2) is the built non-Edge
  alternative; (c) whether the two ORDER-class CRITICALs should be re-allowlisted (they would push to
  Slack — the halt is operator-owned) or a record-only path built. NOTE: attempts are BOUNDED (3) — no
  renewal of attempts without a config change, so the failure cannot burn more than 3 rows per market.
- **C43 (2026-07-17 ~16:55Z) — OPERATOR: "Activate the override - see if it works" → OVERRIDE SET
  (id=2, expires 2026-07-31 00:00Z) — THE LANE IS ARMED for the first time with a passing interlock.**
  Direct insert per the 07-11 precedent (operator's explicit written instruction quoted in the audit
  note; operator_guard blocks the MCP session's RPC; expiry aligned to his active_until, inside the
  14-day cap). **Verified: `trade_live_preflight('buy-table')` now returns ok:true** — the only
  remaining condition is a candidate; the window opens ~00:00Z nightly. Root cause of the never-click
  (same session, C42→C43 troubleshoot): he WAS on /trading (Vercel 16:16Z hits) but the panel's
  set-button is disabled until reason+date are BOTH filled, and setting requires a SECOND "Confirm
  override" click in an amber banner ABOVE the form — zero gate-override API hits ever. Expected
  tonight: first candidate after 00:00Z → ~$5 FAK ≤0.40 → `stop_after_first_success` halts after ONE
  fill; worst case one $5 stake; kills $30/25% stand. TRADE_MODE's Edge copy gets its final proof at
  the first post — post-failure CRITICALs are Slack-DARK (C16), so the scheduled 00:17Z one-shot wake
  is the reporting channel. Loop otherwise stays PAUSED (operator's C42 order).
- **C38 (2026-07-17 ~12:30–12:35Z) — INCREMENTAL PANEL VERIFIED LIVE + SHIPPED TO MAIN (the C27→C38
  arc CLOSED).** The 12:24Z tick: **ok in 13.7s** (vs ~290s + daily reaps — ~21×), incremental=true,
  cacheUnitsUsed 376 + replayed 119 open events, cityErrors 0, snapshot 575 recorded, gate accruing
  (n=19 INSUFFICIENT — the real record, restored). **PR #25 squash-merged 12:34Z** (0103+0104+0105 +
  handler + warm script), loop branch reconciled. The google panel's death-by-growth is permanently
  fixed; steady-state runs replay only open events. (One poll-markets statement timeout 12:12Z — the
  known Micro class, n=1, watch only.) Buy lane throughout: no override, no orders, ticks green.
- **C37 (2026-07-17 ~11:37–11:50Z) — the warm pass couldn't fit the wall + a second latent bug found →
  BOTH fixed; cache BOOTSTRAPPED (376 rows).** The 11:24Z warm run was reaped with the cache still at
  0 rows: the first design wrote the cache once at the END, so a reaped bootstrap made zero progress
  forever. Fix 1 (handler, redeployed ~11:50Z): the incremental pool now replays + cache-writes PER
  CITY — every run's progress is durable, bootstrap converges unattended. Fix 2 (**0105 APPLIED**):
  the write RPC's type guard returned 0 on the driver's DOUBLE-ENCODED jsonb-string payload (the
  project's known trap — found because the new local warm script wrote 0×45; fn now unwraps; the
  migrations suite exercises the exact shape). New `scripts/research/google-cache-warm.ts` (local, no
  isolate wall, re-runnable after any cache-key bump) finished the bootstrap in one run: **376 rows**.
  Migrations 104/104, typecheck clean, pushed. **VERIFY 12:24Z tick: incremental=true, cityErrors 0,
  cacheUnitsUsed ~376-ish, replayed ~open-only, duration <60s — then PR 0103+0104+0105 to main.**
- **C35 (2026-07-17 ~10:35–10:45Z) — first incremental tick CAUGHT A REAL 0103 BUG → 0104 hotfix
  applied + guard added, same cycle.** The 10:24Z tick ran incremental in **6.2s** (vs ~290s — the
  collapse works) but **45/45 city fetches failed**: the v2 event filter compared `uuid = text[]`
  (42883, runtime-only — DDL application can't catch it; the index/cache RPCs worked, which is what
  made v2 the standout). An EMPTY view overwrote the good dash snapshot → **row 574 deleted, dash
  restored**. Fixes: **0104 APPLIED** (`event_id::text = any(...)`; verified live: 191 caps for one
  filtered event) + the migrations suite now exercises the exact call shape + a C35 handler guard —
  an all-failed fetch (0 folded events + errors) SKIPS the record entirely (never blank a good
  snapshot) — **redeployed ~10:42Z**. +5 tests, typecheck clean. **VERIFY 11:24Z tick:
  incremental=true, cityErrors 0, cacheWrites ≈ all resolved events (first warm), duration <60s.**
- **C34 (2026-07-17 ~09:50–10:15Z) — the google-panel INCREMENTAL REPLAY built + APPLIED + DEPLOYED
  (queue item ② done; the C27 wall-death fix).** Failure rate was climbing into daytime (09:24Z run
  reaped). Build: core decomposition `buildGoogleView = assembleGoogleView(buildGoogleReplayUnits(…))`
  — existing tests = the equivalence proof — + `googleReplayCacheKey` (engine version g1 + every
  replay-relevant cfg field; cities scope deliberately excluded) + `replayGoogleEvent` per-event units;
  **migration 0103 APPLIED** (google_replay_cache RLS-deny-all + event index + cache read/write with
  self-prune + google_paper_inputs_v2 event-filtered, v1 untouched); handler now replays ONLY
  open/uncached events (a RESOLVED non-gm event's unit is deterministic forever) and staged-dark falls
  back to the legacy full path if any 0103 RPC is absent/failing — the panel can never die of its own
  cache. +10 tests (5 core equivalence/jsonb-round-trip, 5 handler incl. gm-exclusion + fallbacks),
  **suite 3,247 green**, typecheck clean. Deployed `--no-verify-jwt` ~10:15Z. **VERIFY next :24 tick:
  stats.incremental=true, duration collapse (~290s → expect <60s), then it rides the next PR to main.**
  First run warms the cache (replays everything once, cacheWrites≈all-resolved); steady state replays
  only ~2-6 open events. Deploy-hold rationale dropped deliberately: the panel is fully isolated from
  the trading lane, and every undeployed hour risked another reaped run.
- **C32 (2026-07-17 ~08:47Z) — the C19a monitor fix VERIFIED ON A SCHEDULED RUN (watch item closed) +
  the override-never-clicked troubleshoot delivered.** Today's efficiency-monitor Action fired 08:29Z
  scheduled and succeeded (1m07s) → snapshot id=10 (S1 KILL n=4,889, +147/day accrual; S2 14 troughs)
  — first clean scheduled run since the 07-15/07-16 deaths; the wait-guard fix holds. Earlier (C28–C31,
  operator asked "why no trades" twice): full troubleshoot delivered with proof — the override table has
  ONE row in its entire history (07-11, expired 07-15) and Vercel prod logs show ZERO gate-override API
  hits in 14h → **the renewal click never reached the server; his active_until edit (18:49Z, landed)
  was the config editor, not the override panel.** Exact click-path given (Interlock gate card → Gate
  override panel → set → CONFIRM step). Mexico-city candidate held all morning (in-window to ~11:50Z);
  google-panel incremental-replay build HELD until the first-buy event resolves (one risky change
  domain at a time). All lanes green throughout.
- **C27 (2026-07-17 ~06:15–06:40Z) — FIRST NATURAL CANDIDATE EVER (blocked only by the override) + a
  growing google-panel failure diagnosed.** (1) **Since 00:03Z every buy-table tick has held 1 candidate
  — mexico-city/2026-07-17 (in-window until ~11:50Z; houston/07-17 misses only on price, ask 0.489 >
  cap 0.40) — and every tick skips it on `preflight: false` = the expired override, exactly as designed.**
  The C18b sizing was right: at cap 0.40 the 00:00–10:00Z window produces candidates. One operator click
  (override renewal) → the first live buy lands within 10 min. (2) **google-paper-panel: 4 of the last
  ~10 hourly runs reaped ("exceeded wall limit, ADR-12")**; runtime 64s (07-12) → 114–150s (07-16 day)
  → 281–290s (overnight) — the post-07-07-prune 21d replay window is REFILLING (full ~07-28, est ~590s
  > the Edge wall ≈400s → all runs die by ~07-24 untreated). MEASURED: the SQL read is NOT the cost
  (nyc slim scan+window = 187ms warm) — the cost is Deno-side TS replay CPU over all events hourly.
  Correct fix (top of the calm-day queue): **incremental replay — persist per-event results (a resolved
  event's deterministic replay never changes), re-replay only open/new events, cfg-hash invalidation.**
  Panel data still accruing meanwhile (44 ok / 4 failed per 48h). (3) 20:45Z -c tick verified (houston
  ×2, on the second). (4) Today's monitor Action not yet fired (yesterday's drift ~08:35Z; manual
  dispatch if nothing by ~10:00Z — the fixed guard's first scheduled test is TODAY). Heartbeats C26
  (19:58Z) green; override still down through the night.
- **C25 (2026-07-16 ~19:00Z) — OPERATOR CHECK-IN: "can we buy US markets?" answered + his active_until
  extension observed.** (1) Diag run (read-only): lane blocked on exactly ONE interlock reason — the
  expired override; **`active_until` now 2026-07-31 (operator's own /trading edit at 18:49:29Z — the
  07-20 watch item is superseded)**; 8/8 markets skip on lead_window, next candidate window ~00:00Z.
  (2) US answer, verified live: **Polymarket US-city °F markets are FULLY supported today** — houston
  is already allowlisted; 10 more US cities (atlanta austin chicago dallas denver los-angeles miami
  nyc san-francisco seattle) are in the 45-city capture universe with fresh house-seeded captures
  (300–650/city/24h, latest 18:51Z) and are ONE /trading allowlist edit away (config read per tick —
  no code, no deploy). **Kalshi (the US-regulated venue) is NOT supported**: execution is
  Polymarket-CLOB-only (§15 seam); a Kalshi rail would need operator-side US-KYC account + API keys +
  USD funding, plus a new venue adapter/ledger surface — and no strategy reason exists (signal #10
  cross-venue KILLed on the 1–10-contract capacity wall). Heartbeats C21–C24 (15:28/16:29/17:30/18:31Z)
  all-green: 7/7 ticks each hour, 0 failed jobs, 0 orders, override down, cap 0.40.
- **C20 (2026-07-16 ~14:05–14:30Z) — PR #23 landed + F4 BUILT/DEPLOYED/VERIFIED (the calm-day queue's
  top item).** (1) PR #23 was stuck CONFLICTING/DIRTY — CI never fires on a conflicted PR (GitHub can't
  build the merge ref); root cause: main's #22 squash was never reconciled back into the loop branch.
  Merged origin/main in (board kept ours — the C17-C19 superset), CI went green (3m30s), **squash-merged
  14:08Z**, reconciled the new squash back immediately. Rule captured: after every squash-merge, merge
  origin/main → loop right away. (2) **F4**: `reconcileOpenOrders` gained an opts.strategies scope
  (packages/trading — unfiltered = daemon byte-identical; OrderLedgerRow + mapLedgerRow now carry the
  0085 strategy tag), and the tick handler opens every LIVE tick with the 'buy-table'-scoped sweep
  BEFORE the entries read (freed → retryable same tick; N9 ≥5-min floor + 10-min cadence vs Edge
  wall-clock = every listed row's writer provably dead; failure isolated, never degraded). +14 tests
  (5 handler incl. an end-to-end freed-then-rebought-same-tick + held-on-ambiguity, 3 executor scope,
  5 monitor guard from C19a, 1 mapper), **suite 3,237 green**, typecheck clean. Deployed
  `--no-verify-jwt` ~14:21Z; the 14:23:03Z scheduled tick ran the new build clean (reconcileFailed
  false / 0-0-0 counts — nothing dangling, as expected). Boundary intact: no trade, no keys; the sweep
  only adjudicates ledger rows against venue evidence, the same discipline the daemon ships.
- **C19 (2026-07-16 ~13:45Z) — v18 MULTI-DAY AUTONOMOUS SESSION INIT + baseline.** Operator instruction
  (in-session): prepare a multi-day self-running loop — "evaluate current build, current buys, data
  storage etc … autonomous fixing machine that makes sure this project works"; he checks in remotely.
  Wrote the v18 rota/escalation/build-queue (sections above). Baseline reads (light selects): trade_config
  mode live · window 07-20 · allowlist 4 cities · $5 · caps 25/40/100 · kill 30/25%; buy_table cap **0.40**
  (C18b temp stands) · attempts 3 · stop_after_first_success true · lead [2,12]h · tick enabled; override
  EXPIRED 07-15 not renewed (lane inert by design); Slack paused + allowlist '' (C16 holds); jobs 24h all
  ok except 1 transient metar fail 07-15 17:34Z (47 ok since); live_orders = only the reconciled 07-12 row,
  0 live fills ever; **storage: DB 2,376 MB, opening_captures 832 MB regrown from 75 MB post-07-07-prune
  (~85 MB/day) → standing watch item #3 in the rota**, market_snapshots 432 MB, bucket_probabilities
  346 MB, job_runs 28 MB. Boundary intact: read-only cycle, docs-only commit.
  **↳ C19a (~13:40–14:05Z) — efficiency-monitor Action 2-day failure ROOT-CAUSED + FIXED + RECOVERED.**
  `gh run list` showed schedule fires 07-15 08:36Z + 07-16 08:35Z both failed in ~16–20s; log tail =
  the script's OWN reserved-window guard (`:32–:42` hard-throw at efficiency-monitor-run.ts:198). The
  06-17Z cron drifts 2–3.5h under GitHub congestion (07-13 09:48 ok · 07-14 08:28 ok · 07-15/16 ~08:35
  DEAD — ~50% daily loss odds). Fix: extracted `reservedWindowWaitMs()` (pure, 5 tests) — the guard now
  sleeps to :43 instead of dying; yml header documents drift-vs-drop. Recovery dispatch 13:44Z succeeded
  (44s) → snapshot id=9 as-of 07-16 (S1 KILL n=4,742 — up from 3,735 at C11, null tightening; S2 12
  troughs, was 10). Typecheck + new tests green. **PR #23 → main** (squash; carries the whole C18 build
  — prod Edge already runs it, main lagged). Also verified this cycle: 13:50Z -b tick ok (ankara ×2),
  false-alarm on "missed -b" was local clock skew (DB now() is authoritative — use it, not local time). — OPERATOR IN-SESSION: "no buys recognized" troubleshoot + "today we
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
  **↳ C18d (~14:40Z, operator-requested code review of the C18 build) — 2 real defects found in C18c,
  FIXED + REDEPLOYED same cycle:** **F1 (HIGH)**: a zero-fill FAK (the most likely live failure — ask
  drifts above worstPrice between the 5-min capture and the post; FAK dies at post) landed as `placed`/0
  = unknown-state = PERMANENT market block — rule 1 would never have fired on it. Fix: in-tick
  adjudication to `canceled` (poll-verified dead by the FAK contract) → retryable; `stats.zeroFillAdjudicated`.
  **F2 (MEDIUM)**: an ambiguous post failure (ERR_CLOB/ERR_CLOB_POST — possible hidden fill) let the same
  tick keep buying seconds later; with stop-on-success on it now halts the tick's remainder
  (`stats.haltedOnAmbiguous`); clean rejections/pre-venue throws still continue (rule 1). **F3 (LOW)**:
  stats now echo `stopOnFirstSuccess`. Known gap ISOLATED not fixed (F4): the cloud lane has no reconcile
  sweep for stuck intent/placed rows (the daemon's startup sweep never ported) — rare, diag-visible,
  deliberate no-rush pre-window; candidate for a calm-day port. +3 tests (36 handler total), suite
  **3,223 green**, redeployed ~14:37Z, tick-verified. Everything else in the C18 build verified clean
  (gate defaults = legacy byte-exact, strategy scoping, no attempt burn on preflight-block, migration
  idempotency, diag shares the gate).
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
