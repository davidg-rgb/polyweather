# PHASE-0 BUILD HANDOFF — Opening-Convergence Bot

> **Read this first in the fresh session.** The blueprint is done and the review loop is CLOSED. This file tells a
> cold-start session exactly what to build for **Phase 0**, with no prior context needed.
> Created 2026-06-27, at the end of the blueprint-review campaign.

---

## 0. Where we are (one paragraph)

The opening-convergence bot is the one scoped trading-rail reactivation in the otherwise-CLOSED Polyweather
trading thesis (`FINDINGS.md` / `CLAUDE.md` header). The **blueprint is finished**:
`ARCHITECTURE-OPENING-CONVERGENCE.md` went through a Phase-9 self-review (3 passes) **+ 10 adversarial
agent-team rounds — ~160 validated findings resolved**. The review loop was deliberately STOPPED (operator
decision, 2026-06-27): it is asymptotic (it keeps finding real but increasingly build-surfaceable edge cases on a
~2,500-line money-safety spec), and the residual is the class a **compiler + tests** catch cheaply. **Next action
is to BUILD, not to review.** Do **NOT** re-run the review workflow.

**The thesis (why this exists):** freshly-listed daily-weather Polymarket markets open *flat* (~10–12%/bucket,
uninformed book) and *converge* to a peaked distribution. Buy our `house_gaussian` forecast-center buckets cheap
at the flat open, sell back into the convergence on **bracket** orders (TP/SL/hard time-stop) — capture the
re-rating, never need to hit the exact temperature. Paper-first; no capital until a frozen net-profit gate PASSes.

**Boundary (NON-NEGOTIABLE):** Claude builds the software. The **operator** funds a dedicated wallet + holds the
signing key (`.env.local`, never in chat) + authorizes runs. Claude never places a trade, never touches
credentials. **Phase 0 is fully KEYLESS — no wallet, no money, no `POLY_*` secret.**

---

## 1. Read order (authoritative docs)

1. **This file** — the Phase-0 build start.
2. **`ARCHITECTURE-OPENING-CONVERGENCE.md`** — THE blueprint. For Phase 0 read: **§5** (project structure / file
   map), **§6.10 + §6.10c** (the capture handler + `seedHouseDist`), **§7** (data models — the 9 tables), **§8.2**
   (the migration-0066 RPCs), **§14 Phase 0 + Phase 0.5** (roadmap + DoD), **§15** (the build-verification
   checklist = your DoD gate), and **§16/§17** (the CLOB-V2 corrections + the 10 review-remediation passes —
   **authoritative over any earlier prose where they conflict**).
3. **`OPENING-CONVERGENCE-HANDOFF.md` §9R** — the operator-locked parameters (caps, entry/exit rules, universe).
4. **`GO-LIVE-CHECKLIST-OPENING.md`** — operator runbook; **not needed until Phase 6** (live).
5. **`REVIEW-opening-convergence.md`** — the full review campaign log (context only; do not act on it directly —
   every finding is already applied into the blueprint's §6/§7/§8/§17).

`§15` is your definition-of-done. `§17` lists every load-bearing fix by F-number — when you implement a function,
grep §17 for that function's name to see the hardening it must honor.

---

## 2. What Phase 0 is

**Phase 0 — Capture (keyless) + on-demand seed + schema.** The forward measurement harness. It captures
freshly-listed weather markets at/near listing — full bucket distribution + **true CLOB depth** (walked, not the
vol proxy) + our on-demand-seeded `house_gaussian` + listing age + flat-open flag — into an append-only table on
a cron. No key, no positions, no money. **The build IS the experiment**: this data is what **Phase 0.5** (the hard
go/no-go spike) then reads to decide whether the lever is even real before any execution layer is built.

It is independently testable and leaves nothing broken. Depends on nothing (can run parallel with Phase 1).

---

## 3. The Phase-0 build list (the exact deliverables)

Per **§14 Phase 0** + **§5** file map + **§7/§8.2**:

**A. Migration `0066_opening_convergence.sql`** — the 9 tables + RPCs + crons + grants. The full schema is **§7**;
the RPCs are **§8.2**. The 9 tables: `opening_captures`, `bot_positions`, `bot_orders`, `bot_loop_lease`,
`bot_gate_snapshot`, `bot_tick_log` (F19), `bot_bankroll` (F14), `bot_daily_kill` (F32), `bot_circuit_state`
(F11). For Phase 0 you only *exercise* the capture path, but build the whole schema now (later phases need it).
Migration must also include:
   - The capture/seed RPCs: `record_opening_captures`, `latest_house_dist` + the reused upsert RPCs
     (`upsert_forecast_rows`, `upsert_distribution`, etc. — already exist, reuse).
   - **The bot CRITICAL-kinds Slack-allowlist append (F4-r8)** — idempotently append the bot's alert kinds
     (`BOT_DEADMAN`, `CAPTURE_DEADMAN`, `EXIT_FAILED`, `CIRCUIT_BREAK`, `POL_LOW`, `DAILY_KILL`) to
     `alerts_slack_allow_kinds` (guarded `LIKE` so a re-run can't double-append) so the bot's safety alarms
     survive the global Slack pause that is TRUE on prod for whale-noise. **§11.1.**
   - **Retention prune crons (F15-r10)** — `DELETE FROM opening_captures WHERE captured_at < now() − interval '90
     days'` + `DELETE FROM bot_tick_log WHERE as_of < now() − interval '30 days'` (daily pg_cron).
   - **The seed-isolation column (F11-r10/F16-r9)** — a nullable `seeded`/`seed_origin` on `bucket_probabilities`
     (+ `forecast_rows`) so bot-seeded snapshots can be EXCLUDED from `dash_data` (0065) / run-calibration /
     `/amsterdam` / bets. **This is load-bearing and must ship in the SAME phase as the seed** (see §6 below).
   - **`bot_positions.condition_id` + `token_yes` NOT-NULL** and the per-bucket `tokenYes`/`tokenNo`/`conditionId`
     on the `opening_captures.buckets` jsonb (F2-r8) — the venue identifiers placement + redeem/resolve need.

**B. The `opening-capture` edge fn** (`supabase/functions/opening-capture/`) — keyless, a clone of
`cross-venue-capture`. The handler logic is **§6.10** (`openingCapture`) + **§6.10c** (`seedHouseDist`, the TS
on-demand seed). Restricted to the §9R liquid-city universe (`bot.cities`) + the vol floor. Walk true CLOB depth;
seed `house_gaussian` on-demand (reuse `buildDistributionForEvent` + `snapshot-forecasts` logic) with the
**seed-quality gate (F15)** → `houseProb=null` on any failure (capture depth, don't enter). Align houseProb by
**label/range identity** (W6), not positional index.

**C. The crons** (all in `0066`, all Phase-0 objects — F5-r8):
   - the `opening-capture` capture cron — **~2–3 min first-seen poll** (§16-D — the flat-open window is ≤~1h).
   - `capture_deadman_check` pg_cron (F35) — Slack-CRITICAL on capture staleness OR seeded-fraction collapse.
   - `bot_deadman_check` pg_cron (F19/F13) — **mode-aware** so the Phase-5 PAPER loop's liveness alarms too.

**D. The Phase-0 data corrections** (§14 Phase-0 DoD, "Also"):
   - **Correct the §9R liquid cities' `cities.tz`** to real DST-aware IANA names (they default to no-DST
     `Etc/GMT±N`) + wire the `Etc/*`-rejection in the tz read (C2/C2b).
   - **Surface Gamma `createdAt`** through `parseGammaEvent`/`ParsedEvent` (or read it off the raw payload) so
     `hours_since_listing` anchors on true listing time (the listing-anchor fix).

---

## 4. Phase-0 Definition of Done (the gate to Phase 0.5)

From **§14 Phase 0 DoD** + **§15**:
- `opening_captures` accrues **real rows on prod** on a ~2–3 min first-seen poll **AND a non-trivial fraction of
  flat-open captures carry a seeded `houseProb` (not null)** — "rows accrue" alone is NOT enough.
- **PGlite twin test green** (mirror the existing `cross-venue-capture` test idiom); no key, no positions.
- The `cities.tz` correction + `Etc/*` rejection + Gamma `createdAt` surfacing all landed.
- The Slack-allowlist append, retention crons, both deadman crons, and the seed-isolation tag+exclusions are in
  `0066` (the exclusions wired into `dash_data`/calibration/amsterdam/bets — F11-r10 says ship them WITH the
  seed, not after).
- Walk §15 and tick every Phase-0 / capture / data-model item.

**Then STOP and run Phase 0.5 before building anything else.**

---

## 5. The hard gate immediately after Phase 0 — do not skip

**Phase 0.5 — SIGNAL-AVAILABILITY GO/NO-GO SPIKE (gates Phases 2–6).** Over ≥1 week of Phase-0 captures, the new
artifact **`scripts/research/opening-spike.ts`** (§6.13c) measures: when a usable `house_gaussian` first exists
for a market, **is the book still flat-open (peak ≤ 18%) and is there cheap center depth?** Emits a numeric GO
fraction; **GO iff ≥ `bot.spikeGoFrac` (e.g. 0.5)** of ≥1-week events pass, else **KILL the lever cheaply here**
(update `FINDINGS.md`) before building the whole execution stack. This is the cheapest falsification of the
thesis — it is the entire reason capture is built first.

---

## 6. Build-critical fixes the campaign already pinned (honor these as you build)

These are the review findings most likely to bite during the build. The blueprint already specs all of them
(§6/§7/§8/§17); this is just the "don't miss it" shortlist. For Phase 0 the load-bearing ones are the **schema +
data + seed-isolation** items above. The rest are flagged for when you reach their phase:

- **Phase 1/2 — `Signer.getHeldShares` is mode-aware (F3-r8/F2-r9).** Every manager venue-held read goes through
  it; live wraps `fetchPositions`, **paper derives the synthetic `Σentry − Σexit_taker` from the bot's own
  ledger** (raw `fetchPositions` returns 0 for the keyless paper wallet → paper exits would never fire). This is
  the one that silently breaks the whole paper experiment if missed.
- **Phase 2 — `bot_record_exit_order` (F3-r10).** `bot_close_position` SUM-derives `exit_taker` rows; a dedicated
  writer must persist them FIRST (do NOT reuse `bot_record_order_result`, which does entry-CAS + touches the
  entry breaker). Symmetric to the entry-side writer.
- **Phase 2 — the daily-loss kill credits the SOLD leg (F1-r10).** Book partial-exit realized incrementally;
  resolution combines both legs. Else a partial-exit-into-dust loss is invisible to the kill all day.
- **Phase 3 — `bot_closed_market_panel` + the `source` split (F2-r10).** The FORWARD verdict reads ACTUAL closed
  paper fills (not the backtest's capture replay); `bot_gate_snapshot.source ∈ {backtest, forward}` and the
  capital gate reads **forward only** — so a backtest PASS can never authorize real money.
- **Phase 6 (live, much later) — proxy-aware approvals (F6-r10) + the smoke-test size ≥ max(5sh,$1) (F12-r10) +
  the proxy/redeem ABI "verify vs live SDK before building" gates.** All in `GO-LIVE-CHECKLIST-OPENING.md`.

When in doubt, the §6 function spec is authoritative; §17 (round-by-round) explains *why* each guard exists.

---

## 7. Reuse map (don't rebuild)

- `supabase/functions/cross-venue-capture/` — the keyless edge-fn + cron + `runJob` pattern to CLONE.
- `packages/core/src/polymarket/{gamma,clob}.ts` — `parseGammaEvent`, `normalizeBook`, the depth-walk; tag
  `104596`; reachable from here (Sweden), no 403.
- `supabase/functions/_shared/distributions.ts` — `buildDistributionForEvent` (the seed reuses it).
- `supabase/functions/snapshot-forecasts/handler.ts` — the OM fetch+parse the seed reuses.
- `packages/core/src/config.ts` — `parseConfigRows` + the code-default+migration-mirror idiom (the `bot.*` keys
  default in code; 0066 seeds a MIRROR + an equality test — F10-r8-FP).
- Migrations `0062`/`0065` — the recent capture + dashboard migration patterns.
- Tests: `pnpm test`, `pnpm typecheck`. PGlite twin for the RPCs.

---

## 8. After Phase 0.5 = GO (the rest of the roadmap, per §14)

Phase 1 (pure core: isFlatOpen/selectEntries/bracketDecision/paperFill/openingVerdict) → Phase 2 (paper executor +
loop, GATED on 0.5) → Phase 3 (paper backtest + the gate) → Phase 4 (`/bot` dashboard) → Phase 5 (≥2-week/≥40-mkt
forward paper run — **the go/no-go for real capital**) → **Phase 6 live, GATED on Phase-5 PASS** → Phase 7
scale-or-kill. The operator funds the dedicated wallet + holds the key only at Phase 6.

---

## 9. First moves for the fresh session

1. Read §5 + §6.10/§6.10c + §7 + §8.2 + §14 Phase 0 + §15 of the blueprint.
2. Scaffold migration `0066` from `0062`/`0065`; clone `cross-venue-capture` → `opening-capture`.
3. Implement the capture handler + `seedHouseDist` + the seed-quality gate + the data corrections.
4. Wire the three crons + the Slack-allowlist append + the retention prunes + the seed-isolation tag/exclusions.
5. PGlite twin test; deploy to prod (the operator/CLI is authed via `npx --no-install supabase … --use-api
   --project-ref lenysiqxihsmxljvyybt`); confirm rows accrue with a non-trivial seeded fraction.
6. Tick the §15 Phase-0 / capture / data-model items; then write `scripts/research/opening-spike.ts` and run
   Phase 0.5 after ≥1 week of captures.

**Do not** re-open the review loop. Build.
