# Architecture Review — Opening-Convergence Bot

> Reviewed: 2026-06-27
> Source: ARCHITECTURE-OPENING-CONVERGENCE.md (1,157 lines) vs OPENING-CONVERGENCE-HANDOFF.md
> Reviewers: Integrity, Coverage, Adversarial (parallel) · Phase 9 Full

## Pass 1 — 2026-06-27

### Summary
- **3 CRITICAL** (all from Adversarial source-verification — "claims to mirror X, but X actually does Y")
- **8 WARNING** (6 Adversarial + 2 Coverage/Integrity structural, several overlapping)
- **~14 INFO** (cross-ref drift + prose corrections)

### CRITICAL findings

**C1 [Adversarial] — `house_gaussian` does NOT exist at the flat open; the thesis may be unexecutable as designed.**
`house_gaussian` is written only when `forecasts.length>0` ∧ station icao mapped ∧ ladderOk
(`_shared/distributions.ts:82,157,177`). A brand-new market has no forecasts until `snapshot-forecasts`
runs; the discovery "seed" writes nothing. Cadence (`0009_cron.sql:159-162`): discover 5×/day,
snapshot-forecasts 2×/day, build-distributions 2×/day. The handoff's own Paris-06:10 example isn't even
*discovered* until 11:10 UTC and has no dist until forecasts+build run — by then peak mid > 18% and the
flat-open filter rejects it. `bot_house_dist_for_event(event_id)` is keyed on the internal event_id which
only exists post-discovery; the blueprint's own `opening_captures.event_id` is "nullable if pre-discovery."
**The lever cannot fire in the window it targets on the current cadence.**
*Fix:* (a) give capture an on-demand forecast+build path for the known-city universe (snapshot the station's
forecast now → `buildDistributionForEvent`), AND (b) make "does a usable house_gaussian coincide with a
still-flat book?" the build's FIRST go/no-go spike before Phases 2–6. → ADR-OC-14 (new), F-OC-01, R-10, §2.4,
Phase 0.5.

**C2 [Adversarial] — Time-stop tz: the model stores an OFFSET, but `localDayWindow` requires an IANA NAME, and `derivedTzOffset` is null for the target cities.**
`localDayWindow(tz, date)` calls `assertTimezone` → throws `InvalidTimezoneError` on a non-IANA string
(`time.ts:16-24,45-56`) — an offset `2.0` is type- and semantics-wrong. `parseGammaEvent` sets
`derivedTzOffset` only when `!knownTz && gameStartTime` (`gamma.ts:293-295`); for a known/liquid city
`knownTz` is supplied (`discover-markets/handler.ts:100`) → offset undefined. The real IANA name is
`cities.tz` (`handler.ts:93-100,139`).
*Fix:* store the city's real IANA `tz` NAME (from `cities.tz`) on `opening_captures`/`bot_positions`; pass it
to `localDayWindow`; drop `tz_offset_hours` as the time-stop input. → ADR-OC-12 rewrite, §7, §6.1.

**C3 [Adversarial] — Idempotency: a client-minted order id cannot be attached to a Polymarket CLOB order.**
The CLOB wrapper places via `createOrder({tokenID,price,size,side},{tickSize,negRisk})` → `postOrder(order,'GTC')`
→ `{orderID?}` (`live.ts:21-25,101-109`). There is NO clientOrderId/metadata field; the order's only identity
is the server hash returned AFTER posting; the signed `salt` is internal/unqueryable. So in the crash window
between "intent written" and "orderID recorded," a landed order carries no trace of our UUID —
reconcile-by-`client_order_id` against the venue is impossible. `UNIQUE(client_order_id)` only dedupes our own
DB rows.
*Fix:* reconcile heuristically by `(tokenId, side, price, size, time-window)`; `client_order_id` dedupes DB
rows only; lean on never-auto-retry (correctly mirrored, `live.ts:136-150`) + a tight place→record critical
section. → ADR-OC-5 rewrite, F-OC-06, §6.6 reconcilePosition.

### WARNING findings

**W1 [Adversarial] — `@polymarket/clob-client` not installed/exercised; `openOrders` + `FOK` unverified, and FOK is WRONG for the exit.**
The lib is in no package.json/node_modules — only Deno `npm:` + mock-tested (`live.ts:6-13,64-67`). ADR-OC-1's
"plain Node imports" path is unvalidated. `ClobClientish` (`live.ts:19-32`) has no `openOrders` (reconcile
depends on it). `postOrder` hardcodes `'GTC'`; FOK is not mirrored AND is wrong for a taker exit — FOK cancels
entirely if depth < size, so the time-stop flatten could fail on a thin book (R-4, the worst case).
*Fix:* taker exit = marketable GTC (cross the spread) or FAK/IOC, never FOK; add a go-live verification item
for `getOpenOrders`/order-types against the live lib (mirror live.ts's "re-verify at go-live"); Phase 6 adds
the npm dep. → §6.2/§6.3/§6.6, §14.

**W2 [Adversarial] — `setInterval` allows in-process tick overlap; the lease only guards cross-process; no partial-unique stops a double-open.**
`setInterval(tick,…)` doesn't await; a slow tick fires a second concurrently in-process, sharing the lease
owner. `scanEntries` dedupes by reading `bot_positions` at tick start → two overlapping ticks both read
"not held" and both insert. `(event_id,bucket_idx)` is only an INDEX, not a partial-unique.
*Fix:* self-chaining `setTimeout` (schedule next only after the prior tick resolves); add partial-unique
`(event_id,bucket_idx) where state in (open states)`. → §6.13b, §7.

**W3 [Adversarial] — Daily-loss kill reads realized loss only; open unrealized losses don't trip it.**
`bot_should_run` checks "today's realized loss"; positions deep underwater but unexited contribute $0 realized,
so the −$30/−25% breaker won't fire while the bot keeps opening.
*Fix:* include mark-to-market unrealized PnL of open positions (marked from the latest capture mids) in the
kill check, or at minimum gate new entries on open-position MTM. → ADR-OC-8, §8.2 bot_should_run.

**W4 [Adversarial + Coverage §5-C] — Partial fills representable but not handled.**
`matched_shares`/`entry_shares` can store a partial, but `manageFill` arms brackets "on full fill" only; the
partial-then-window path (arm the filled portion, size the exit to actual shares, blended maker-partial +
taker-remainder entry price) is unspecified. §5-C explicitly requires partial-fill handling.
*Fix:* define the partial path explicitly. → §6.6, §7 note, §15, F-OC feature text.

**W5 [Adversarial] — Flat-open race vs first-N approval: the cheap entry is gone by approval.**
ADR-OC-13 parks the first ~10 live positions in `pending_approval` BEFORE placement; the book converges in
minutes, so by one-click approval the 10–18% entry is gone — approval latency destroys the edge being approved.
*Fix:* pre-authorize the STRATEGY/params up front; make the first-N a fast POST-FILL review (place within caps
immediately, surface the first N fills, operator can halt) — preserves the flat-open entry. → ADR-OC-13 rewrite.

**W6 [Adversarial] — Bucket alignment is positional (`probs[i]` ↔ capture `buckets[i]`); a ladder change desyncs → wrong bucket.**
`bucket_probabilities.probs` is aligned to `bucket_idx` (ascending-temp sort at discovery, `gamma.ts:275`).
Positional alignment holds only if the bucket set is byte-identical between discovery and capture; an added/
removed Gamma bucket desyncs `probs[i]` vs live `buckets[i]`.
*Fix:* align by bucket label/range identity, not raw index. → §6.1 selectEntries, §6.10 capture row, §7.

### INFO observations
- **I-1 [Integrity]** loop helpers `placeEntries`/`manageBrackets`/`loadOpenPositions` referenced but undefined → declare them under §6.7.
- **I-2 [Integrity]** RPCs `bot_open_or_closed_today` + `bot_exposure` called but undefined → add to §8.2 (or fold into a `bot_open_positions` RPC).
- **I-3 [Integrity+Coverage]** `bot_gate_snapshot` written/read/checklisted but has no §7 table def + no writer RPC; "3 tables" should be **5** (incl. `bot_loop_lease`).
- **I-4 [Integrity]** `createPaperSigner` Called-by lists 6.13a, but 6.13a calls `paperFill` directly (no signer) → remove.
- **I-5 [Integrity]** cross-ref drift: `paperFill` add 6.3 to Called-by; `openingVerdict` Called-by "dash_bot (6.9)" wrong (dash_bot reads the snapshot, doesn't call it); `scanEntries` use canonical `bot_house_dist_for_event`; `bot_record_order_result` mapping vs manageFill; `isFlatOpen` attribute to 6.10b.
- **I-6 [Integrity]** config keys `bot.centerHalfWidth`, `bot.tpAtModelProb` used in §6 but absent from §7 roster.
- **I-7 [Adversarial]** ADR-OC-10 prose wrong: `crossVenueVerdict` has NO Monte-Carlo (it's clustered-CI only); the zero-skill MC is the LEARNINGS/other-sim standard. Fix the attribution.
- **I-8 [Adversarial]** Clustering by city → effective t-test N = #cities (6–10), not the 40 markets; state both the ≥40-markets bar and the CI's effective df.
- **I-9 [Adversarial]** Time-stop "clock-only guarantee" overstated — `applyExit` still needs the venue at noon; describe as aggressive-retry + loudest-alert, not a guarantee.
- **I-10 [Adversarial]** Maker-rebate (`weather_fees` 25%) is "the entire thin margin" but REC-8/MAKER-REBATE never confirmed it pays net on weather — keep it MEASURED in the gate, not assumed.
- **I-11 [Adversarial]** Caps: existing `fill_bet_with_caps` is %-of-bankroll; §9R is absolute $; the bot's bankroll source is undefined → specify absolute-$ caps over the bot's own tracked balance (separate from `bankroll_ledger`).
- **I-12 [Adversarial]** Index gap: the daily-loss "today realized" sum isn't actually covered by `(mode,target_date)` → add `(mode,state,updated_at)` or note negligible.
- **I-13 [Coverage]** §9R-B "$7k+ vol24h / 6–10 cities" captured as data but not WIRED as an entry filter → add `bot.cities` allowlist + `bot.minVol24hUsd` to capture eligibility + selectEntries.
- **I-14 [Coverage]** J-1 (fund/connect) + J-5 (scale) have no §9 data flow — J-1 is setup (legit flowless); J-5 scale reuses the DF-6 verdict over live results (note it).

### CONFIRMED-GOOD (Adversarial, against real source)
- Caps lock is **pool-safe** — `fill_bet_with_caps` uses transaction-scoped `pg_advisory_xact_lock` (`0019:30-35,70`); the bot mirror is correct (no session-lock-over-PostgREST trap).
- Capture mirror is **faithful** — `runJob` (requireCronAuth → claim_job_run → 202 → waitUntil → complete_job_run) + service `getServiceDb` reaching `bucket_probabilities` from the edge fn all check out (`_shared/runJob.ts:50-132`, `db.ts:29-82`, `cross-venue-capture/index.ts`).
- Statistical gate **matches+exceeds** the house standard (clustered-CI like `crossVenueVerdict:609-675` + the added MC).
- Never-auto-retry discipline is **correctly mirrored** from `live.ts:136-150`.

### Recommended next steps (Pass 1 → revision)
1. Address all 3 CRITICAL + 6 WARNING inline (C1 is the gating design change — add ADR-OC-14 + Phase 0.5 spike).
2. Apply the cheap, clearly-correct INFO prose/cross-ref fixes (I-1…I-13).
3. Re-run Phase 9 (Pass 2) on the revised doc.

## Pass 2 — 2026-06-27

### Summary
- **1 CRITICAL** (a Pass-1 fix mis-placed across the runtime seam — the convergence pattern)
- **6 WARNING** (3 new defects from the revision + C2 false-premise + 2 integrity)
- **~5 INFO**

### CRITICAL
**C1b [Adversarial] — `bot_seed_house_dist` was specified as a Postgres RPC, but the work is TS/Deno-only.**
`buildDistributionForEvent` is a TS function (`_shared/distributions.ts:69`) reading forecasts via
`get_build_inputs`; the OM forecast snapshot is an outbound HTTP fetch+parse+upsert (`snapshot-forecasts/handler.ts:68-98`).
plpgsql can do neither (the only `pg_net` use is async cron→edge-fn). The real seam is TS:
`discover-markets/handler.ts:204-206` injects `buildDistributionForEvent` as a TS dep.
*Fix:* respecify the seed as a **TS helper in the `opening-capture` handler** (discover-upsert → single-station
OM snapshot → `buildDistributionForEvent` → read `bucket_probabilities`), DB RPCs only for the writes;
enumerate its inputs (station lat/lon, model list, OM base+key); add a freshness check (don't re-snapshot OM
every 10 min). → §6.10, §8.2, §9 DF-1, §10, §15.

### WARNING
**C2b [Adversarial] — `cities.tz` is often `Etc/GMT±N` (no DST), and the fail-closed guard doesn't catch it.**
`cities.tz` is IANA-typed (`0002_reference.sql:21`) but auto-discovered cities get
`etcZoneForOffset(offset)` = `Etc/GMT±N` (`risk.ts:169-172`); Amsterdam is `Etc/GMT-2`
(`amsterdam-truth-backfill.ts:31`). `assertTimezone` accepts `Etc/*` (Intl-valid), so `no_tz` never fires and
`localDayWindow` computes a DST-wrong (≤1h) noon. *Fix:* the fail-closed guard must reject `Etc/`-prefixed
zones (real-IANA allowlist), and the §9R liquid cities' `cities.tz` must be corrected to real names before live
time-stop. → ADR-OC-12, §7, §14 Phase-0, §15.

**W4b [Adversarial] — partial-fill accounting can strand held shares into resolution (R-4).** Multi-tick
incremental maker fills: first partial CAS→'armed'; the next partial hits 'armed' → `bad_state` → dropped while
shares are really held → `applyExit` sells `entry_shares` (undercount) → surplus held to resolution. Plus a
cancel-races-a-fill TOCTOU. *Fix:* `bot_fill_with_caps` must idempotently ACCUMULATE onto 'armed' (re-blend
entry, resize bracket; CAS WHERE includes 'armed'); after `cancelOrder`, re-`getOrder` the terminal matched
count before arming. → §6.6, §8.2.

**W3b [Adversarial] — MTM kill marks from `opening_captures`, which stops emitting once a held market leaves
the flat-open/universe window → stale optimistic mark → kill fails to trip.** The loop ALREADY fetches a fresh
per-position `/book` mark in `decideForPosition` (§6.4). *Fix:* mark the MTM kill from that fresh source with a
max-age fallback to a conservative worst-case mark. → §6.9, §8.2, ADR-OC-8.

**W2b [Adversarial] — the driver spec STILL says `setInterval(tick,…)` (§6.13b) while §15/R-5/ADR-OC-8 say
self-chaining setTimeout** — the implementable spot reintroduces the overlap bug; and no per-tick watchdog (a
hung tick freezes the kill-check). *Fix:* §6.13b → `await tick(); setTimeout(next)` + a wall-clock timeout per
tick. → §6.13b.

**hours_since_listing [Adversarial] — anchored to `listing_detected_at` ("first tick we saw"), which lags true
listing by up to a capture interval × outages → biases the ≤6h flat-open gate downward.** Gamma exposes
`createdAt` (`polymarket-wallet.ts:123`). *Fix:* anchor the window on Gamma `createdAt`. → §7, §6.10.

**INT-W1 [Integrity] — `scanEntries` Called-by stale: now called by `loop.placeEntries`, not `loop.tick`.** Fix the edge.
**INT-W2 [Integrity] — `bot_record_order_result` says "CAS position state (intent→maker_resting | placed)" but
`placed` is a bot_orders STATUS, not a bot_positions state.** Disambiguate.

### INFO
- **W6b [Adversarial]** — `bucket_probabilities.probs` is a bare `numeric[]` with NO labels (`0005_analytics.sql:5-13`); alignment must join `probs[idx]`→`market_buckets` for labels then match live Gamma labels. `modeIdx` double-defined (RPC dist-index vs live argmax) — keep only the live-aligned argmax. The seed must return labels via the join.
- **W5b [Adversarial]** — first-N has no one-at-a-time throttle: all ~10 can fill before the operator sees #1 (blast radius still bounded by caps). Tighten: ≤1 unreviewed live position open at a time.
- **W1b [Adversarial]** — `'GTC_marketable'` isn't a real order type; the real lib has GTC/GTD/FOK/FAK. Frame the taker exit as FAK/IOC + the retry-until-flat loop does the flattening (one order ≠ a guaranteed flatten). Honestly flagged already.
- **C3b [Adversarial]** — C3 reconcile is sound; specify the price≈/size≈ match tolerances (token+side exact, price within 1 tick, size within minOrderSize).
- **INT-INFO [Integrity]** — `isFlatOpen` list direct callers (selectEntries / buildOpeningCaptureRow); the paper-backtest needs a historical capture-SERIES reader (bot_latest_captures only returns freshest-per-open-event) — name it; `'exiting'` state has no explicit writer (applyExit goes straight to 'closed').

### Convergence note
Pass-2 yield < Pass-1 (1 CRITICAL vs 3; the new findings are localized spec-placement/accounting, not
fundamental design holes) — the expected sub-1.0 convergence. C1b is the one substantive correction (runtime
seam); the rest tighten. After this revision, a focused single-adversarial Pass 3 (delta + new-defect sweep)
is the right cost call.

### Recommended next steps (Pass 2 → revision)
1. Fix C1b (TS-seam respec — the substantive one), C2b, W4b, W3b, W2b, the listing anchor, + the 2 integrity edges.
2. Apply the INFO tightenings (W6b modeIdx, W5b throttle, W1b naming, C3b tolerances, the backtest reader).
3. Re-run a focused Phase 9 Pass 3 (adversarial delta + integrity spot-check).

## Pass 3 — 2026-06-27 (focused single-adversarial delta, source-verified)

### Summary
- **0 CRITICAL** · **2 WARNING** (both new from the Pass-2 revision; both fixed) · **2 INFO** (fixed)
- 5 of 7 Pass-2 fixes **CONFIRMED sound against real source** (C1b, C2b, W4b, W2b, W6b).

### Confirmed sound (verified file:line)
- **C1b ✓** — `buildDistributionForEvent` is exported TS (`distributions.ts:69`), cross-fn-injected at
  `discover-markets/index.ts:34-35`; one-station snapshot reuses `snapshot-forecasts/handler.ts:67-98`
  (`forecastUrl`/`parseMultiModelDaily` exported). §8.2 now lists only `latest_house_dist` as a read; the
  build/snapshot are TS. The reused RPCs are all real (`upsert_forecast_rows` 0014/0025, `upsert_distribution`
  0016, `upsert_event` 0012, `fill_bet_with_caps` 0019:43 txn-scoped lock :70).
- **C2b ✓** — `etcZoneForOffset`→`Etc/GMT±N` (`risk.ts:169-173`); `assertTimezone` accepts `Etc/*` so the
  explicit reject is needed and is now wired (ADR-OC-12/§7/§14/§15).
- **W4b ✓** — `bot_fill_with_caps` accumulates on cumulative `size_matched`, CAS `maker_resting|armed→armed`,
  re-getOrder-after-cancel for the TOCTOU. `applyExit` sells the accumulated held shares.
- **W2b ✓** — §6.13b now the awaited self-chain + `tickWatchdogSec`, not `setInterval`.
- **W6b ✓** — `latest_house_dist` joins `market_buckets` for labels; `modeIdx` defined once (live argmax).

### WARNING (both fixed this turn)
**P3-W1 — the W3b kill froze the WHOLE tick → exits frozen + reboot self-wedge.** Step-1 `shouldRun` aborted
the tick, skipping step-3 `manageBrackets` (the only place exits fire AND marks refresh): (a) a daily-loss kill
would strand underwater positions into resolution (the R-4 loss the kill exists to prevent); (b) reboot-while-
holding > $30 → conservative-worst-case marks → trips kill → aborts before refresh → re-trips forever.
*Fixed:* reordered `tick` — lease (only whole-tick abort) → `manageBrackets` ALWAYS → `entryGate` → place.
Split `risk-guard` into `acquireLease` + `entryGate`; the kill/pause gates ONLY new entries; flatten is a
separate deliberate action. (§6.7, §6.9, ADR-OC-8, DF-2/3, §15.)

**P3-W2 — `hours_since_listing` anchored on Gamma `createdAt`, but `parseGammaEvent`/`ParsedEvent` don't
surface it** (`gamma.ts` has no `createdAt`; the cited `polymarket-wallet.ts:123` is per-market io meta, not
the event parser). *Fixed:* added a Phase-0 task to surface `createdAt` through `RawGammaEvent`+zod+`ParsedEvent`
(or read off the raw payload). (§6.10, §14, §15.)

### INFO (fixed)
- Exit-side fill accumulation was asymmetric with W4b → `bot_close_position` now accumulates/blends multi-FAK
  retry fills, CAS 'exiting'→'closed' only when fully flat.
- §7 config-keys list was missing `markMaxAgeMin`/`tickWatchdogSec`/`seedFreshnessMin`/`championSource` → added.
- §6.10c injection cite corrected (`index.ts:34-35` injects; `handler.ts:204` uses).

## Agent-team review loop (operator-requested "iterate to 0") — 2026-06-27

A 4-lens agent team (integrity / adversarial-source / logic-races / completeness) → consolidate → adversarially
validate each finding against real source → fix only validated REAL findings → reiterate. Workflow saved at
`…/workflows/scripts/arch-review-validate-wf_96646da4-3cf.js` (re-run with `{scriptPath, args:{round:N}}`).

- **Round 1: 24 raw → 22 consolidated → 21 REAL / 1 FALSE-POS.** Found 3 CRITICAL logic bugs + drift. ALL FIXED.
  (Note: this "Round 1" of the team loop is the 4th review pass overall, after the Phase-9 3-pass convergence above.)
- **Round 2: 24 → 22 → 21 REAL / 1 FALSE-POS.** Surfaced 4 deep CRITICALs the prior passes missed —
  exit-decision mark on the BUY side not the SELL/bid side (F1); caps silently DROPPING already-held shares →
  under-flatten → R-4 (F2); exit unable to RESUME without a reboot (F3); backtest exit-fill unspecified → gate
  false-PASS (F4) — plus ~7 drift items the round-1 fixes introduced + WARNINGs (live bankroll = floating
  free-cash → premature kill F9; absent-mark hides drawdown F10; my own F13 SL `max()` tightened the stop for
  the whole universe F12). ALL 21 FIXED (CRITICALs at their function homes; the rest consolidated in §17).
- **Round 3: 21 → 20 → 18 REAL / 2 FALSE-POS.** Count + severity trending DOWN (F1 downgraded CRITICAL→WARNING).
  Genuine: reconcile has no arm to ADOPT an entry that filled during the crash window → rides unmanaged into
  resolution (F2, the entry-side analog of §17-F20) — FIXED; `bot_bankroll` left with 3 inconsistent schemas by
  the round-2 additions (F1) — FIXED. The remaining 16 round-3 findings were in `tasks/wvv5dhk9c.output`.
- **Round 3 — ALL 16 REMAINING APPLIED (next session, 2026-06-27).** Worked from the already-source-validated
  recommendations (no re-discovery). Mapped to doc-level §17 third-pass F-numbers + inline homes:
  **§17-F32** latched daily-loss kill + `bot_daily_kill` table + floor-each-unrealized-at-0 (the un-trip defeat);
  **§17-F33** one-time gas-funded on-chain approval bootstrap (corrects §16-A "never raw approve()") + arm-time
  ensure; **§17-F34** exit dust-floor → `resolveHeldPosition` (no exit_failed/CRITICAL on un-sellable sub-min
  dust); **§17-F35** `capture_deadman_check` producer-side staleness + seeded-fraction-collapse alarm; **§17-F36**
  void/refund/UMA settlement branch (actual settled value, gate-excluded); **§17-F37** daily-loss MTM scoped to
  share-holding positions (no phantom drawdown on resting entries); **§17-F38** free-cash spend ceiling +
  `ERR_INSUFFICIENT_BALANCE` skip (not a breaker trip); **§17-F39** funds lifecycle (deposit/onboarding +
  profit-sweep); **§17-F14c** negRisk redeem via NegRiskAdapter (plain CTF reverts on weather); **§17-F17c** GTD
  entry time-stop OUT OF SCOPE. Hygiene applied in place: **F4** ID collisions (§17-F9→F9b, §17-F17→F17b), **F5**
  §15 wiring of F14b/F15/F22, **F6** §16-F "RESOLVED→source-unverified, F2 OPEN until the resting-survival smoke
  test", **F7** ADR-OC-8 capture-emission reword + §6.13a continuous-mark-series DoD, **F16** `bot.bankrollBaseUsd`
  config key, **F18** §6.3 `getCollateralBalance`-is-a-viem-port-method-not-an-SDK-call. Two round-3 FALSE-POS
  recorded so they aren't re-raised (no anomalous-fill breaker needed — venue-limit orders; Slack "one-click" is
  `/bot`, not an interactive button). **NEW FILE: `GO-LIVE-CHECKLIST-OPENING.md`** created (root) — resolves the
  F39/F33/F30/F21/F22/F14b/F14c dangling "must include …" references with a real paper→real→scale runbook. Table
  count 7→8 (`bot_daily_kill`) propagated through §1/§5/§7/§14/§15.
- **Round 4 — RAN + ALL 19 APPLIED (2026-06-27).** Rebuilt workflow `arch-review-validate-wf_99e2d4a3-543.js`
  (4 lenses → consolidate → per-finding adversarial validate). **27 raw → 21 consolidated → 17 REAL + 2 recovered
  (validators F8/F9 hit the StructuredOutput retry cap; pulled them from the consolidate transcript and
  self-validated) / 1 UNCERTAIN→INFO / 1 FALSE_POSITIVE.** Count held flat (19 vs 18) because the round-3 fixes
  ADDED surface — but only ONE new CRITICAL (F1, PRE-EXISTING) + zero new design holes; the rest are the predicted
  edge cases of the round-3 edits. New §17 IDs: **F1** SL-ternary-not-max() unified across §6.1/ADR-OC-7/DF-3/§17-F13
  (the one pre-existing CRITICAL); **F32b** latch anti-self-wedge guards (fresh-mark-confirm + kill_date predicate
  — a transient /book outage could have latched the bot dead for the day); **F2/F14c** persisted `neg_risk` +
  fail-closed redeem (the round-3 F14c claimed a parser field that doesn't exist); **F36b** loser/void resolution
  detection (redeemable fires only for winners); **F6b** manageBrackets resolution-FIRST; **F40** ambiguous-throw
  non-terminal + ENTRY-ADOPT; **F41** honest first-N surfacing-throttle (the "operator eyeballs #1" claim was
  un-deliverable); **F42** persisted `bot_circuit_state` (process-memory counter resets on the crash-loop F18
  catches); **F35b** backtest continuous-mark-series; **F10b** POL-gas surface (getGasBalance + pol_balance +
  minPolGas); **F7b** dual share/notional dust floor; **F14** `resumeExit` now a defined §6.6 function. Plus INFO
  hygiene (F13/F15/F16/F19/F20/F21 + the bare-F2 collision documented). FALSE_POSITIVE: **F4** (approval bootstrap —
  safety already in the pre-go-live mandate; tightened traceability). Tables 8→9 (`bot_circuit_state`). ~70
  validated findings resolved across the whole campaign (Phase-9 3-pass + 4 team rounds).
- **Round 5 — RAN + ALL 15 APPLIED (2026-06-27).** **25 raw → 19 consolidated → 9 REAL / 6 UNCERTAIN / 4
  FALSE_POSITIVE — ZERO CRITICAL** (REAL: 28→21→18→19→**9**, convergence finally bending down hard). The 6
  UNCERTAIN were validator retry-cap failures (the patched `.catch` preserved their text); they self-validate
  against source, so applied alongside the 9 REAL. Almost all were edge cases the round-4 fixes introduced. New
  §17 IDs: **F43b** circuit-breaker operator-reset (the F42 breaker had NO reset → permanently wedged after trip);
  **F44** breaker brownout/timeout dimension + periodic reconcile (the breaker was blind to a CLOB brownout — the
  common down-venue mode — and ENTRY-ADOPT was boot-only); **F6** resolution detection re-sourced (the `closed`
  flag is on the gamma EVENT, not /positions; persist `resolves_at`); **F45** kill cancels resting entries (a
  pre-kill maker entry could still fill after "done for the day"); **F46** redeem idempotency; **F34b** dust
  parked mid-life (no per-tick churn); **F17** killLossPct pinned to the day-start base (floating equity is a
  moving target). Plus completeness/integrity: F4 (Signer port method declarations), F5 (ENTRY-ADOPT writes a
  bot_orders row first), F10 (clockSanityCheck home), F11 (bootstrap/smoke live-boot gate), F16 (two drawdown
  sums), F13/F14/F12/F1 (hygiene incl. §17-F14→F43 dedup). 4 FALSE_POSITIVE recorded. Tables 8→9 already (round-4).
  ~90 validated findings resolved across the campaign.
- **Round 6 — RAN + ALL 16 APPLIED → LOOP CLOSED (2026-06-27).** **28 raw → 20 consolidated → 14 REAL / 2
  UNCERTAIN / 4 FALSE_POSITIVE — REAL bounced UP 9→14 with 2 CRITICAL, NOT down.** The asymptote is real: the
  round-5 fixes added surface and the lens found the wiring each introduced. Both CRITICALs closed: **F1/§17-F44**
  — the round-5 breaker was spec'd-but-UNWIRED (consecutive_ambiguous had no writer RPC, reset zeroed only
  failures, tripped_at never set → added `bot_record_ambiguous`, fixed the reset, set tripped_at); **F2/§17-F47**
  — `bot_close_position` was never made symmetric to F10 (caller-supplied accumulate → double-count → premature
  'closed' → R-16 stranding → now SUM-derives exit_taker rows + venue-held==0 flat check). WARNINGs: F3 (caps
  false-trip decoupled from breaker), F4/§17-F48 (exit-path double-FAK guard `exit_in_flight_until`), F6
  (cancelRestingEntries straggler-book + openOrders sweep), F7 (void via MarketMeta not mergeable), F8
  (bootstrapApprovals + NegRiskAdapter — else first live redeem reverts), F9 (flatten is DB-CAS + next-tick, key
  boundary), F11 (dust_parked skipped in reconcile too), F13 (deadman mode-aware — Phase-5 is paper). INFOs:
  F14/F15/F16/F17/F18/F19. 4 FALSE_POSITIVE refuted. New bot_positions cols: `exit_in_flight_until`, `over_cap`;
  new RPC `bot_record_ambiguous`.
- **Round 7 — RAN + ALL 16 APPLIED (2026-06-27, operator RE-OPENED the loop).** Re-ran
  `arch-review-validate-wf_99e2d4a3-543.js`. **27 raw → 22 consolidated → 16 REAL / 1 UNCERTAIN / 5 FALSE_POSITIVE.**
  REAL 14→**16** with 3 CRITICAL — but ALL THREE were HALF-PROPAGATED round-6 edits, NOT new design holes:
  **F1** the round-6 `caps_exceeded_held`→`over_cap_halt` decoupling left 3 stale producer sites still routing
  into the systemic `consecutive_failures` breaker AND the `over_cap_halt` consumer unwired in
  `bot_should_run`/`entryGate` — struck the stale increments + wired the reason with an auto-clearing EXISTS
  predicate; **F2** `executableBid` bid-depth-shortfall→scalar-mark unspecified — kill MTM now values the
  unfillable remainder conservatively + excludes sub-depth from the §17-F32b CONFIRMED latch, brackets require
  fillable≥held, closing the fetch-SUCCESS-thin-bid hole Guard 1 left open; **F3** the round-6 F8 THREE-contract
  approval bootstrap (incl. the NegRiskAdapter redeem contract) had only reached §6.2 — propagated to GO-LIVE §2,
  §14 Phase 6, §15 gate, §6.3. WARNINGs: **F4** boot EXIT-RESUME `applyExit`→`resumeExit` (the CAS no-ops on an
  already-'exiting' position → silent non-flatten); **F5** deadman crons Phase-6→Phase-0 + `bot_deadman_check`
  mode-aware for the Phase-5 paper run; **F7** `bot_close_position` 'closed' now corroborated by
  exit-shortfall+`resolves_at`, not a bare venue-held==0 (F36b proves the /positions row drops → spurious 0
  strands a residual, R-16); **F8/F9** `exit_in_flight_until` committed BEFORE the await in resumeExit+applyExit
  (place-then-set leaves the watchdog-abort window open → double-FAK); **F10** unfilled-flatten entry-cancel wired
  into resumeExit's first step + DF-5 flatten→applyExit drift fixed; **F11** §15 DoD synced to round-6/7 +
  `bot_record_ambiguous`; **F12** clock-drift keeps exits best-effort + CRITICAL, halts placement only (the
  rationale was backwards). INFO: F13/F15/F17/F18/F21/F22 (Calls-list/Maps-to/module-count/cite/seeded-frac-knob/
  mode-assert hygiene). **F6** UNCERTAIN→prose tighten (§17-F45 kill-tick overclaim — the validator confirmed the
  manageFill-arms-before-gate behavior is INTENDED). 5 FALSE_POSITIVE refuted + recorded (exposure-cap-counts-
  intents would self-wedge §17-F37; §10.1 curated-summary; dust_parked is a derived predicate; the
  ERR_INSUFFICIENT_BALANCE backstop is cause-agnostic; the additive parser field is pre-authorized). ~121
  validated findings across the campaign (Phase-9 3-pass + 7 team rounds).
- **Round 8 — RAN + ALL 13 APPLIED (2026-06-27).** Re-ran the workflow over the round-7-fixed doc. **19 raw → 18
  consolidated → 13 REAL / 0 UNCERTAIN / 5 FALSE_POSITIVE.** REAL 16→**13** with 4 CRITICAL — but the TEXTURE
  changed: TWO CRITICALs were GENUINELY-NEW design holes no prior round caught. **F1** (propagation) a FOURTH stale
  `caps_exceeded_held`→§17-F18-breaker site in manageFill (round-7 F1 fixed only 3) → routed to `over_cap_halt`.
  **F2 (NEW)** per-bucket `tokenYes`/`tokenNo`/`conditionId` dropped from the persisted schema → can't place
  (needs tokenId) or redeem/resolve (needs conditionId); added to capture buckets jsonb + selectEntries→
  EntryCandidate + a new `bot_positions.condition_id` column (mirroring the neg_risk threading). **F3 (NEW)** the
  Signer port had NO holdings read — every exit/close/settle reads venue-by-address `fetchPositions`, so keyless
  paper reads 0 held → applyExit sizes the FAK to 0 (no exit books) + winners book $0 → Phase-5 gate corrupted;
  added a mode-aware `getHeldShares` (live=fetchPositions, paper=synthetic entry−exit SUM) + routed all reads
  through it. **F4 (NEW)** the bot reuses `notifySlack` → `claim_alert`, which suppresses BY-KIND while prod is
  paused (WHALE_TRADE-only) → every bot safety alarm (deadmen/exit_failed/breaker/POL-low/daily-kill) silently
  muted; named the kinds + 0066 allowlist-append + §15/GO-LIVE paused-Slack test gate. WARNINGs: F5 (localDayWindow
  →localHourInstant in ADR-OC-12/OQ-4/R-7 — §17-F43 rename only hit §6.1), F6 (§17-F46 whole-wallet reconcile
  contradicts §6.6/round-6-F17 — struck), F7 (applyExit didn't book a cancel-race straggler → cost-basis under-
  count + SUM>entry wedge), F8 (daily-loss realized window not pinned to killDayTz like the latch → cross-UTC-day
  desync), F9 (bot_close_position required resolves_at-in-future even for a confirmed full flatten → late-but-
  complete exit mis-booked as a held=0 loss — an over-broad add-on from my own round-7 F7), F11 (Phase 0.5 — the
  gate that authorizes Phases 2–6 — had a DoD but no artifact; added `opening-spike.ts` §6.13c + `bot.spikeGoFrac`
  bar). INFO: F15 (throwOnError would-cross is a THROW, classify it), F16 (pUSD approve over-spec'd on the redeem-
  only NegRiskAdapter — scope to the two Exchanges), F17 (clockSanityCheck CLOB-time comparand has no source → pin
  Supabase now() via db). 5 FALSE_POSITIVE refuted + recorded (F10 config-defaults-live-in-code; F12 endDate→
  resolveHeldPosition releases never-filled entries; F13 deadman+reconcile already cover a Supabase outage; F14
  §17-F36 stale clause superseded by precedence convention; F18 per-tick captures fill the seeded-fraction window —
  validates the round-7 F21 fix). ~134 validated findings across the campaign (Phase-9 3-pass + 8 team rounds).
- **Round 9 — RAN + ALL 10 REAL + 2 UNCERTAIN APPLIED (2026-06-27).** Re-ran the workflow over the round-8-fixed
  doc. **18 raw → 16 consolidated → 10 REAL / 2 UNCERTAIN / 4 FALSE_POSITIVE.** REAL 13→**10**, and the texture
  inflected: **ZERO CRITICAL survived** (the one CRITICAL-tagged finding F1 was DOWNGRADED to WARNING) AND **zero
  genuinely-new design holes** — every finding was (a) round-8 `getHeldShares` propagation, (b) a second-order
  effect of the round-7 depth-shortfall mark, (c) a half-propagated prior fix, or (d) a bounded pre-existing edge
  needing an operator error. **F1** depth-shortfall mark vs latched MTM kill — sub-depth underwater inventory (the
  NORM) could never persist the latch → added a `killLatchPersistTicks` sustained-breach rule. **F2** round-8 F3
  getHeldShares propagation incomplete on the boot reconcile path (+ 3 stale Calls edges) → paper restart-recovery
  silently broken; routed reconcile through the mode-aware read. **F4** reconcile.run runs at boot BEFORE the lease
  → double-start reconcile-FAKs lease-less; acquire lease before reconcile. **F5** resumeExit entry-cancel by-id
  only (no openOrders sweep for ambiguous-'intent' — cancelRestingEntries has it); ported the sweep. **F7**
  clockSanityCheck still in `interface Signer` though §17-F17 made it driver-run; moved it out. **F9** the redeem
  pre-guard called the data-api-indexer read "on-chain" (lags → re-redeem revert churn); switched to viem
  ERC-1155 balanceOf. **F10** §15 DoD stale at round-7; appended round-8/9 gates. Self-validated UNCERTAIN: **F3**
  MTM didn't net sold shares (partial-exit/dust_parked phantom drawdown) → net `entry_shares − Σexit_taker`; **F6**
  per-token attribution can't split two own positions on one token → keep 'failed'-with-holding in the
  partial-unique/dedupe. INFO: F14 (Calls list), F15 (script count 2→3), F16 (seed writes shared dash_data/
  calibration tables → tag + exclude). 4 FALSE_POSITIVE refuted (F8 updateBalanceAllowance is cache-only not
  gasful; F11 lease handoff is clean not co-place; F12 redeem ABI deferred by design; F13 RawGammaMarket type
  confusion — §17-F36b already mandates the MarketMeta extension). ~146 validated findings across the campaign.
- **Round 10 — RAN + ALL 14 REAL + the F13 DECISION APPLIED (2026-06-27).** Re-ran over the round-9-fixed doc.
  **23 raw → 17 consolidated → 14 REAL / 1 UNCERTAIN / 2 FALSE_POSITIVE.** REAL bounced 10→**14** with **2
  CRITICAL** — round 9's "clean" pass was a FLUCTUATION, not convergence. **F1** (the OTHER horn of round-9 F3):
  the sold-at-loss leg of a partial-exit-into-dust position is booked nowhere until terminal close → invisible to
  the daily kill all day → §9R-D silently fails; now credit sold proceeds in the kill realized sum + resolution.
  **F2 (NEW)**: the GO-LIVE gate's data path was unsound — no RPC produced the FORWARD verdict panel + no
  backtest/forward provenance split → an operator could fund real money off a backtest PASS; added
  `bot_closed_market_panel` + a `source` column read forward-only. WARNINGs: F3 (exit_taker row WRITER unwired —
  added `bot_record_exit_order`), F4 (bot reused the GLOBAL `alerts_slack_paused` as its kill, TRUE on prod →
  decoupled to `bot_enabled`), F6 (proxy-vs-EOA approvals → first BUY/SELL reverts; proxy-aware routing), F7 (no
  runway guard → after-noon-listed lead-0 markets flatten immediately; minHoldRunwayMin), F8 (maker→taker fallback
  no entry-cap re-gate → buys above 20% cap on a converged book), F9 (the OTHER horn of round-9 F4 — lease
  bounds only one tick not reconcile duration; re-CAS during reconcile), F10 (first-N throttle mis-homed → moved
  to placeEntries), F11 (round-9 seed-exclude not buildable/sequenced; pinned p_seeded + Phase-0 DoD), F12
  (smoke-test 1-share < the max(5sh,$1) venue floor → can't rest; sized to floor). INFO: F14 (DF-3/DF-4 sync), F15
  (table retention prune), F17 (citation fix). F13 UNCERTAIN→decision (cancel-on-over_cap is intended). 2
  FALSE_POSITIVE (F5 §17-F45 already adjudicates; F16 §17-F39 already resolved). ~160 validated findings across
  the campaign.
- **STATUS: ASYMPTOTIC — RECOMMEND STOP + BUILD (2026-06-27).** REAL across 10 rounds:
  28→21→18→19→9→14→16→13→10→**14**. The loop does NOT converge to zero — round 9's clean pass was noise, and
  round 10 re-surfaced 2 CRITICALs (one a second-order effect of my own round-9 fix, one a genuinely-new
  pre-existing hole). The rounds-5→10 trajectory (9→14→16→13→10→14) is a stationary asymptote. **RECOMMENDATION:
  stop the blueprint-review loop and BUILD** — the residual is the class a compiler + tests surface concretely
  (the unwired exit writer a builder hits in minute one; the proxy/redeem on-chain legs already gated "verify vs
  live SDK"; the gate RPC a Phase-3 deliverable). Build is paper-first with hard downstream gates, so safety
  doesn't hinge on a literally-perfect blueprint. **Operator's call: start Phase 0, or run more rounds (real but
  asymptotic money-safety returns).**

**Convergence reality (honest):** 28 → 21 → 18 validated REAL across the team rounds, severity trending down,
but **literal-0 is an asymptote** on a 1,700-line real-money autonomous-bot blueprint under a 4-lens adversarial
team — each fix round adds surface and the lens keeps finding deeper edge cases. **51 validated findings
resolved so far** (28 round-1, 21 round-2, 2 of round-3); ~16 round-3 items logged for continuation. The build-
critical machinery (bracket/fill/exit/reconcile/resolution/idempotency/caps/kill) has been substantially
hardened. **Recommended stop: the doc is far more build-ready than at Phase-9 close; resume the loop in a fresh
session** (re-run the saved workflow, `args.round:3` re-reads the fixed doc) until the tail is INFO-only.

### Phase-9 convergence — CONVERGED, BUILD-READY (pre-team-loop)
3 CRITICAL (P1) → 1 CRITICAL (P2) → 0 CRITICAL (P3); the sub-1.0 yield held (P1 fixes → P2 defects → P3
defects, each smaller + more localized). The adversarial-reads-real-source pass was the MVP every pass (the
project's documented pattern). All CRITICAL + WARNING resolved inline; remaining items are the operator's
build-time verifications already enumerated in §15 (the clob-client API surface, the cities.tz data
correction, the createdAt surfacing). **Status: BUILD-READY** — gated, as designed, on the Phase-0.5
signal-availability spike before any execution and the Phase-5 paper PASS before any capital.
