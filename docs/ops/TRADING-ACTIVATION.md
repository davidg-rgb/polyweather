# TRADING-ACTIVATION — operating the live maker-exit daemon

The operator runbook for `scripts/trade-bot.ts` (the live maker-exit trading DAEMON) + `scripts/trade-smoke.ts`
(the credential smoke). It sits under the T1 execution rail (`packages/trading`) and the T3 activation console
(migration `0082_trading_activation.sql`). Read alongside **`GO-LIVE-CHECKLIST-OPENING.md`** (the funds/approvals
lifecycle — this doc is the *software activation* half) and **`MAKER-EXIT-SIM.md`** (the strategy of record).

> **BOUNDARY (NON-NEGOTIABLE — §9R / GO-LIVE-CHECKLIST-OPENING.md §8).** Claude builds the software. **The
> operator funds the dedicated wallet, holds the signing key in `.env.local`, and authorizes every run.** Claude
> never places a trade, never handles the wallet key, never touches credentials. The key + the CLOB client live
> ONLY inside `packages/trading/src/live.ts` (§15); the daemon reaches the venue exclusively through the
> `createClobClient` seam + the `MakerExecutor`. **NO CAPITAL until a frozen forward-paper PASS** — the SQL
> interlock (`trade_live_preflight`) encodes that gate; the daemon cannot post live until it clears.

---

## 1. The three env vars (names only)

The daemon reads these from the shell / `.env.local` (via `scripts/lib/load-env.ts`; a shell export always wins).
It NEVER prints a value.

| var | purpose |
|---|---|
| `TRADE_MODE` | the master posture: `off` \| `dry-run` \| `live`. **Unset ⇒ `dry-run`.** A real post needs the literal `live`. |
| `DATABASE_URL` | the **service-role Postgres DSN** — how the daemon reaches the 0082 activation console + the T1 order ledger. |
| `POLY_​PRIVATE_KEY` | the wallet signing key in `.env.local`. Read ONLY by `createClobClient` inside `packages/trading` — dry-run + live both sign the would-be order (dry-run to *log* it, live to *post* it). Set `POLY_SIGNATURE_TYPE` / `POLY_FUNDER_ADDRESS` as your wallet requires. **Never paste it into chat, a commit, or a log.** |

Optional: `SLACK_WEBHOOK_URL` (the daemon posts CRITICAL/WARN alerts RAW — see §7), `TRADE_TICK_SEC` (tick
interval; default = `bot.tickIntervalSec` ≈ 30 s).

> **Service-creds note.** The LIVE-RAIL brief names `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. This repo's
> scripts reach Postgres **directly** via `DATABASE_URL` + the `postgres` driver (`scripts/lib/script-db.ts`) —
> using `@supabase/supabase-js` would add a runtime dependency, which is forbidden. **`DATABASE_URL` IS the
> service-role connection** and is the faithful, no-new-dep realization of "service creds". Point it at the
> Supabase service-role Postgres URL for the prod project (`lenysiqxihsmxljvyybt`).

---

## 2. The mode ladder: `off` → `dry-run` → `live`

There are **two** independent mode gates; a real post requires **BOTH** to say live.

1. **`TRADE_MODE` (env)** — the *executor* posture (`resolveTradeMode`, T1):
   - `off` → the daemon logs and **exits 0** immediately (nothing constructed, no key read).
   - `dry-run` (default) → each tick discovers + decides + builds the exact order, RECORDS the intent under
     `mode='dry-run'` (the shadow harness reads it), logs the redacted payload, and **never posts/cancels** at
     the venue. Dry-run rows never count toward live caps (0082).
   - `live` → post for real — but only after gate #2 passes, per placement.
2. **`trade_config.mode` (DB) + `trade_live_preflight()`** — the *activation console* interlock (0082). A live
   post requires the preflight to PASS, which itself requires `trade_config.mode='live'`, an active run window,
   a PASS forward-paper gate (or an operator override), and the daily-loss kill un-tripped.

**Recommended progression:** run for days in `dry-run` (shadow) → confirm the ledger rows + logs look right →
flip `trade_config.mode='live'` and `TRADE_MODE=live` only once the forward-paper §9R-E gate is `PASS`.

Set the DB mode/caps via the operator RPC (never edit the table directly):

```sql
select public.trade_config_set(p_mode => 'dry-run');   -- or 'live' / 'off'
```

---

## 3. What each cap does (all LIVE-mode only; dry-run rows never count)

Read from `trade_config`; enforced per placement by the daemon from the `trade_live_preflight().checks` payload.

| cap | default | effect |
|---|---|---|
| `stake_per_buy_usd` | $10 | the $ staked per entry. **Hard §9R ceiling: ≤ $25 (a DB CHECK — code, not config).** |
| `per_position_cap_usd` | $25 | max $ in one position. **Hard §9R ceiling: ≤ $25.** |
| `per_market_cap_usd` | $40 | `perMarketExposure[market] + stake` must stay ≤ this — blocks stacking one market. |
| `total_concurrent_cap_usd` | $100 | `openExposure + stake` must stay ≤ this — the deployable-bankroll ceiling. |
| `daily_loss_kill_usd` | $30 | the absolute daily realized-loss kill (see §6). |
| `daily_loss_kill_frac` | 0.25 | the fractional kill: loss ≥ `frac × total_concurrent_cap_usd` also trips it. |
| `city_allowlist` | null (= all) | the trade universe. **Honored by the daemon** — only these cities are entered. |
| `active_until` | null | the run-window day-cap (0075 idiom); the preflight fails once `active_until < today`. |

**Only ENTRIES are cap/preflight-gated.** Exits (the resting take-profit, the taker stop-loss, the time-stop)
are NEVER gated — a position must always be able to flatten (the kill + a de-activated console gate new entries
only, per GO-LIVE §5). **On a live preflight FAIL the daemon additionally CANCELS FULLY-UNFILLED resting maker
entries within one tick** (lens MEDIUM-2): a working entry is future exposure, and the kill must stop it, not
merely stop re-pricing it. **A PARTIALLY-filled entry's resting remainder is deliberately LEFT WORKING under a
kill** (lens NEW-LOW-2): cancelling it would record the entry row terminal-canceled, which hides it from the
ledger read the next tick reconstructs positions from — the HELD shares would be orphaned from their
stop-loss/time-stop backstop. The remainder's exposure is already counted by the preflight as committed capital,
so cancelling buys little and costs the position's reconstructability. Exit management and the TP rest keep
running throughout.

---

## 4. The preflight interlock + the override (14-day cap)

`trade_live_preflight()` returns `{ ok, reasons[], checks{} }` — `ok` only when EVERY blocking condition clears
(checklist semantics; every failing reason is surfaced). The daemon reads it before any live placement and, if
`!ok`, blocks all entries that tick (logging the reasons) while still managing exits.

The gate branch requires the **latest `mode='paper' source='forward'` `bot_gate_snapshot`** to be `label='PASS'`
— OR an ACTIVE operator override:

```sql
-- open a short-lived override (max 14 days out — a longer bypass is a policy change, not an override):
select public.trade_gate_override_set(
  p_reason     => 'first-N live review window',
  p_expires_at => now() + interval '3 days',
  p_note       => 'GO-LIVE §5 first ~10 fills'
);

-- clear every active override (keeps the audit trail):
select public.trade_gate_override_clear();
```

---

## 5. The smoke procedure (`scripts/trade-smoke.ts`)

The zero-cost credential dress rehearsal (GO-LIVE-CHECKLIST-OPENING.md §3). **Safe by default** — steps 1–3
read/build only, nothing is posted:

```bash
pnpm tsx scripts/trade-smoke.ts
#  [1] derive L2 CLOB creds → 'derived OK · apiKey <prefix> · sigType N · funder set/unset'
#  [2] authenticated read (getOpenOrders)   → 'funder recognized · N open orders'
#  [3] dry-run order build for a real market → prints the exact would-be payload, REDACTED
```

The optional write-path proof (operator-run only, **costs nothing**):

```bash
TRADE_MODE=live pnpm tsx scripts/trade-smoke.ts --live-smoke
```

`--live-smoke` places ONE resting `post_only` maker BUY FAR below market and cancels it immediately (CLOB
place/cancel is gasless; the order never fills). **`TRADE_MODE=live` is ALWAYS required — the env mode gate is
never bypassable** (lens LOW-4). On top of that the probe needs `trade_live_preflight()` to PASS, OR
`--i-know-no-preflight`, which bypasses **only the preflight** for that cancel-immediately probe (a loud WARN
prints) — the smoke deliberately precedes the paper-gate PASS. **The brief's "1-share" order is raised to the
venue floor (≥ 5 shares AND ≥ $1 notional, F12-r10)** — a literal 1-share order is rejected and cannot rest, so
it would not prove the resting write path.

---

## 6. Daily-loss kill semantics (realized-at-sell, UTC window)

The kill (0082 §4.5, the ONE shared definition) is **realized P&L attributed at SELL time**, NOT within-day net
cashflow: each SELL fill realizes `proceeds − (avg cost basis × size sold) − its fee`, summed over SELL fills
with `filled_at ≥ date_trunc('day', now())` (**UTC midnight**), plus buy-side fees paid inside the window.
`todayLossUsd = greatest(0, −Σ realized_delta) + window buy fees`. The preflight blocks when it reaches
`daily_loss_kill_usd` OR `daily_loss_kill_frac × total_concurrent_cap_usd`. The window start is surfaced verbatim
as `checks.lossWindowStart`. (Re-buys mix lifetime basis — an accepted approximation off the one-market-per-day
strategy path; see the 0082 N8 note.)

---

## 7. Alerting

The daemon's alerts go two ways, always: (a) a structured, **redacted** local log line; (b) a **RAW** Slack post
via `SLACK_WEBHOOK_URL`. The raw post **bypasses the DB Slack pause gate by design** (that gate lives in
`functions/_shared notifySlack`, which this local process never touches) — so a daemon CRITICAL always pages,
regardless of the prod whale-noise pause. A missing webhook never silences a safety event (the log still fires).

---

## 8. Ops notes

- **Startup reconcile is STARTUP-ONLY.** The daemon runs `reconcileOpenOrders()` once before the first tick
  (adopt/free dangling `intent` rows against venue evidence). It is **never** run mid-run (the T1 contract — a
  just-posted order in the post→record window would be wrongly freed → double-place).
- **Staleness × restart interaction (safe).** The ledger's dangling sweep lists intents older than **5 min**. A
  crash+restart *within* 5 min of a reserve leaves that fresh intent unadjudicated until it ages — SAFE: the key
  stays reserved (a re-place returns `duplicate`, never a double); adjudication is merely delayed.
- **`orderId`-bearing stuck rows need MANUAL ops.** A row kept at `placed`/`partial` with a needs-reconcile
  CRITICAL means a live order may rest at the venue but the post-place flow failed. The daemon NEVER frees such a
  key. Inspect + resolve by hand:
  ```sql
  select id, market_id, token_id, side, purpose, status, order_id, client_order_id, size, size_matched, price, created_at
    from public.live_orders
   where mode='live' and status in ('intent','placed','partial')
   order by created_at desc;
  select public.dash_trading();  -- the operator console: config + preflight + open orders + today's spend/loss
  ```
  Cross-check the `order_id` against Polymarket; cancel/settle manually as needed. Do NOT restart into a live
  tick until the row is resolved.
- **Sold-truth accounting (venue trades as the sell floor).** Per position each tick, the daemon sums our
  SELL fills for the token from the venue's trade log (`getTrades` — the same evidence read the startup
  reconcile uses) and floors the position's `soldSize` with it. This is what makes "how much have we already
  sold?" survive rows going terminal-canceled (a lifted-then-cancelled TP, an adjudicated FAK corpse), whose
  fills are invisible to `bot_order_by_intent` (0082). A read counts as trustworthy ONLY when the page is
  COMPLETE: a cursor-bearing / at-page-limit response (`tradesResponseTruncated`, §11.1) is treated as
  degraded, exactly like a throw — an incomplete page could under-count `soldSize` and defeat the over-sell
  guard, so it self-pauses the sells rather than trusting a partial sum. The read stays a single call (no
  pagination — the strategy trades ~1 BUY + ≤3 SELLs per token, so a real page never reaches the limit).
- **Exits SELF-PAUSE during a venue-trades outage OR a truncated read (lens NEW-LOW-1 / §11.1).** The
  `getTrades` read is safety-load-bearing, not telemetry: while it is failing — OR returning an incomplete
  page — for a position's token, `soldSize` may be understated, so the daemon **holds every SELL for that
  position** — the taker stop-loss/time-stop AND the TP rest — and fires a **CRITICAL `TRADE_BOT_SELL_HOLD`
  alert every affected tick** (never silent). Why:
  the over-sell guarantee outranks exit latency — positions are §9R-capped ($10 stake / $25 ceiling), so a
  few ticks of exit delay is bounded risk, while sizing a SELL from understated accounting and hoping the
  venue's balance check rejects it is not accounting. An already-resting TP stays working (it was sized when
  truth was known). Sells resume automatically, correctly sized, on the first healthy read. If the CRITICAL
  persists, treat it as an incident: check CLOB `/trades` connectivity, then §9.
- **Venue-dead FAK adjudication (automatic, loud).** A taker exit posts FAK — dead at the venue the moment its
  immediate execution completes. If a FAK exit partial-fills (or fills nothing), its OPEN 'partial'/'placed'
  ledger row would block every re-fire as a silent 'duplicate'. The daemon adjudicates such rows terminal via
  `record_canceled` (fills preserved) with a WARN log + alert, then re-fires the unsold remainder. Rows still at
  'intent' (no orderId) are never touched — the startup reconcile owns those.
- **Heartbeat / deadman (a flagged coverage gap).** The daemon writes a mode-scoped `bot_tick_log` row each tick
  via the 0073 `record_bot_tick` idiom (+ a structured log line). But `bot_deadman_check` watches a **single**
  mode (`config.tradingMode`, default `paper`), so it will **NOT auto-alarm on this daemon's staleness** unless
  you point `tradingMode` at the daemon's mode (which would stop watching the paper loop). Until a dedicated
  live-mode deadman is wired (needs a config/cron change — out of scope: 0082 is final), **monitor the daemon's
  own logs / process supervisor** (GO-LIVE §8) for liveness.

---

## 9. Incident playbook — kill + drain

1. **Instant kill (halt new exposure):** set the console off. Within one tick the preflight fails (`mode≠'live'`)
   → new entries stop AND **the daemon itself cancels every FULLY-UNFILLED resting maker ENTRY** (lens MEDIUM-2).
   A partially-filled entry's resting remainder is deliberately left working (lens NEW-LOW-2 — cancelling it would
   orphan the held shares from reconstruction; see §3); cancel it MANUALLY on Polymarket if you want it gone too.
   Exit management (TP rest / SL / time-stop) keeps running while the process is up, so open positions still
   flatten on their triggers.
   ```sql
   select public.trade_config_set(p_mode => 'off');
   ```
   Then stop the daemon (SIGINT). Shutdown **leaves whatever still rests in place** (resting take-profits ARE the
   strategy) and logs the open state loudly.
2. **Cancel the remaining resting orders (MANUAL — the daemon does not cancel on shutdown):** after a kill tick,
   what remains resting is exit-side (take-profits) plus anything from a daemon that was already stopped. Read the
   open orders (SQL above), then cancel each on Polymarket (UI or the operator's CLOB tooling). There is no bulk
   kill RPC on the service-role surface by design (the kill is a policy flip; cancellation is an operator action).
3. **Suspected key exposure:** follow GO-LIVE-CHECKLIST-OPENING.md §7 — `bot_enabled=false`, **DRAIN** the
   dedicated wallet to a cold address, rotate the key, re-derive CLOB creds, re-run §1–§3. Re-issuing creds is
   insufficient; the funds must move.

---

## 10. The §9R boundary, restated

Claude builds; the **operator** funds the dedicated wallet, holds the signing key, authorizes runs, and reviews
the first ~10 live fills (GO-LIVE §5). Claude never trades, never keys, never drains. No capital crosses a gate
that has not passed — and the forward-paper §9R-E `PASS` is the gate of record.

---

## 11. Known venue-edge residuals — both CLOSED (built + tested, 2026-07-05)

Two LOW findings from the T2 review series were originally accepted as follow-ups — both narrow
venue-eventual-consistency edges, bounded by the §9R caps and self-limited by this strategy's tiny per-token
trade count (~1 entry BUY + ≤3 exit SELLs; a single-`asset_id` `/trades` read does not paginate at that size).
**Both are now BUILT + TESTED** (they earned the fix because each is a correctness backstop on the over-sell /
no-orphan-fill guarantees, not a taker-edge lever):

1. **CLOSED — silent `getTrades` truncation no longer false-negatives the degraded flag.** The parse layer now
   exposes `tradesResponseTruncated(raw)` (order-intent.ts): a response is truncated when it carries a
   non-terminal `next_cursor` (present, non-empty, ≠ the `"LTE="` sentinel) OR its page is ≥
   `CLOB_TRADES_PAGE_LIMIT` (100). The daemon's `venueSoldFor` (§8) treats a truncated page **exactly like a
   throw** → `{ sold: null, degraded: true }` → the sells self-pause + `TRADE_BOT_SELL_HOLD` CRITICAL, so an
   incomplete page can never under-count `soldSize`. The read stays a SINGLE call (no pagination-following, out
   of scope). Same detector also hardens the startup-reconcile trades read in `live.ts` (a truncated page is
   incomplete evidence → HOLD, never free a key). Tests: `order-intent.test.ts` (the detector, all shapes) +
   `scripts/trade-bot.test.ts` (`venueSoldFor` truncated/at-limit/throw → degraded end-to-end into the CRITICAL).
   Scope honesty (lens LOW, 07-05): against the CURRENT @polymarket/clob-client this guard is **latent
   defense-in-depth, not an active-gap fix** — the client's `getTrades` exhausts the cursor internally and
   returns the full array (or throws), so it cannot silently truncate today. The guard exists for a future
   client/shape swap (a Data-API-style offset endpoint or a raw cursor envelope), where it becomes load-bearing.
2. **CLOSED — a poll-missed partial entry fill can no longer be orphaned by a kill-cancel.** `refreshFill`
   now returns `{ row, fresh }`; `fresh` is false ONLY when a LIVE poll of the resting entry THREW. That
   `entryPollFresh` flag rides on the `LivePosition`, and the decide spine's kill-path cancel of a
   fully-unfilled resting entry (`planForPosition`) may only fire when `entryPollFresh === true` — a stale
   `sizeMatched=0` DEFERS the cancel to the next tick (a `cancel_entry_deferred_stale_poll` skip +
   `entryCancelDeferredAlerts` WARN, never CRITICAL), so a partial fill the poll missed is never
   `record_canceled`-orphaned. The known-partial (`filledSize>0`) remainder is still left working (NEW-LOW-2),
   and the fully-filled case stays self-protected (`allCanceled=false`). Tests: `trade-bot-decide.test.ts`
   (stale → defer + skip; fresh → cancel; alert mapping) + `scripts/trade-bot.test.ts` (`refreshFill` freshness).
