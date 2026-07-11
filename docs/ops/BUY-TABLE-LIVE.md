# BUY-TABLE LIVE — the cloud buying lane (migration 0095, operator directive 2026-07-11)

> **The honest verdict first (BUY-TABLE.md, 2026-07-09):** *"Verdict: KILL / no demonstrable edge — at both
> cost bases."* On the canonical calibrated book + taker fee, the strategy nets **−9.2% ROI / −$51 over 55
> fillable bets at the 12h sweet-spot, day-CI [−62.9%, +56.8%]** — an underpowered wash leaning negative;
> every well-populated lead is negative; this is signal #12 (opening-convergence) re-confirmed with the
> cheap-entry filter. **The operator knows this and has explicitly chosen to run it live small.** Nothing
> here weakens the interlock: every live placement still passes the full 0082 preflight architecture, and the
> practical unlock for this lane is the **expiring (≤14d) `trade_gate_override`** — the forward paper gate of
> record is a settled KILL and will not PASS on its own.

## The model (what the tick does, every 10 minutes)

Buy **our predicted daily-high bucket** (argmax `houseProb` from the opening-capture stream — the same house
seed the maker-exit daemon reads) as a **TAKER FAK**, only when:

| Gate | Value | Source |
|---|---|---|
| Executable ask | ≤ **$0.15** | `config buy_table.price_cap` (the BUY-TABLE cheap gate) |
| Lead to close | **2–12 h** | `config buy_table.lead_min_h / lead_max_h` (the C25 calibrated sweet-spot is ≤12h; the final 2h is excluded — the record's worst regime: near close the cheap filter keeps only near-certain losers) |
| Stake per buy | `trade_config.stake_per_buy_usd` (currently **$5**) | `/trading` console |
| Cities | `trade_config.city_allowlist` | `/trading` console (0093-validated slugs) |
| Entries per market | **ONE, EVER** | `buy_table_entries` (ANY-status ledger read — even a terminal `failed` row blocks re-entry; no chase) + the `(mode, intent_key)` partial-unique index underneath |

Then **HOLD TO RESOLUTION** — no take-profit, no stop-loss, no time-stop. A market that resolves against a
held position gets its full-stake loss **booked into the N1 daily-loss kill** every tick via the idempotent
`bot_order_record_resolution_loss` (0084 #18), so the kill switch sees hold-to-close losses.

Sizing: `shares = floor(stake / ask)`, respecting the venue min-order floor (`bot.minOrderSizeShares`,
default 5; the executor re-checks the live book's own floor at placement). Ledger rows carry
`strategy = 'buy-table'` so `/trading` and the shadow harness tell lanes apart.

## Architecture (cloud tick vs the retired-from-duty local daemon)

- **This lane** = Edge Function `buy-table-tick` (`supabase/functions/buy-table-tick/`) on a `*/10` pg_cron
  schedule, each fire stamping a per-tick `periodKey` into the request body (§8.1). Discovery is the same
  `convergence_capture_inputs` RPC the daemon used; placement goes through the same T1 `MakerExecutor`
  (`placeTaker`, FAK) — the wallet key + clob client stay inside `packages/trading/src/live.ts` (§15).
- **The local maker-exit daemon** (`scripts/trade-bot.ts`) is **retired from buying duty but stays in the
  repo, dormant** — do not run it concurrently in live mode with this lane armed (both write the same
  ledger; intents are mode+key-scoped so nothing double-places, but two live writers is not a supported
  posture). Its maker-exit strategy remains KILLed (`FINDINGS.md`).
- **Trade-mode ladder (unchanged double gate):** the Edge secret `TRADE_MODE` resolved by `resolveTradeMode`
  — absent/typo ⇒ **dry-run** (records intents under `mode='dry-run'`, never posts), `off` ⇒ inert. A real
  post needs `TRADE_MODE=live` **AND** `trade_config.mode='live'` **AND**
  `trade_live_preflight('buy-table').ok` (run window + forward-gate PASS **or** active override + the
  daily-loss kill un-tripped), read per tick and gating every placement.
- **Degraded ≠ empty:** a failed/shapeless discovery or lane-ledger read places NOTHING and marks the run
  degraded in `job_runs.stats`; `buy_table_deadman_check` (pure-SQL cron, `*/15`) pages `BUY_TABLE_DEADMAN`
  **once per UTC day** on tick staleness (>30 min) or an all-degraded run window.
- **Alerts that push** (0095 allowlists them through the prod Slack pause): `BUY_TABLE_DEADMAN`,
  `BUY_TABLE_DEGRADED` (discovery down while live), `BUY_TABLE_POST_FAILED` (a live entry attempt failed
  pre-venue), and the executor's `ORDER_FAIL` / `ORDER_NEEDS_RECONCILE` CRITICALs (the local daemon posted
  these over a raw webhook; the cloud lane goes through the `claim_alert` gate, so they must be allowlisted).
  Everything else is structured logs.

## OPERATOR DEPLOY STEPS (in order)

1. **Apply migration 0095** (`supabase/migrations/0095_buy_table_live.sql`) — config defaults, the
   `buy_table_entries` read, the `'buy-table'` preflight branch, the deadman, the allowlist append, and both
   crons. (`supabase db push`, or paste into the SQL editor.)

2. **Set the Edge secrets** (names only — NEVER paste values anywhere else):

   ```bash
   supabase secrets set TRADE_MODE=live            # omit or set dry-run for the shadow posture first
   supabase secrets set POLY_PRIVATE_KEY=…          # the dedicated wallet signing key (read ONLY inside packages/trading)
   supabase secrets set POLY_SIGNATURE_TYPE=…       # only if your wallet needs it (defaults to 0)
   supabase secrets set POLY_FUNDER_ADDRESS=…       # only if you trade through a proxy/Safe funder
   ```

   These are exactly the names `packages/trading/src/live.ts` reads (`POLY_PRIVATE_KEY`,
   `POLY_SIGNATURE_TYPE`, `POLY_FUNDER_ADDRESS`) plus the `TRADE_MODE` ladder. **Note: dry-run also needs
   the key** — the executor signs the would-be order to record it (the daemon behaved the same way); without
   it every dry-run placement logs `ERR_NO_KEY` and counts as failed.

3. **Deploy the function:** `supabase functions deploy buy-table-tick --no-verify-jwt` (JWT verification OFF like every sibling cron fn — the gateway 401s cron posts otherwise; auth stays in-function via x-cron-secret). The cron starts POSTing immediately;
   until this deploy it 404s harmlessly and the deadman stays silent.

4. **Arm the interlock** (the placement gate — do this last):
   - `/trading` console (or SQL): `trade_config_set(p_mode := 'live', p_active_until := current_date + N)`
     with the stake at `$5` and the `city_allowlist` you want (0093 validates slugs).
   - The override (the forward gate is a settled KILL — it will not PASS):
     `select trade_gate_override_set('buy-table live small — operator-accepted KILL record', now() + interval '14 days', 'BUY-TABLE-LIVE.md');`
     (max 14 days by design — re-issue deliberately when it expires).
   - To pause: `trade_config_set(p_mode := 'off')` or set `config buy_table.tick_enabled = 'false'` (tick
     no-ops) or `trade_gate_override_clear()` (live posts blocked; dry-run recording continues).

5. **Verify** (after 20–30 min):

   ```sql
   -- the tick is claiming per-fire period keys and completing
   select period_key, status, stats from job_runs where job = 'buy-table-tick' order by started_at desc limit 6;
   -- lane intents/orders (strategy-tagged; dry-run rows carry mode='dry-run')
   select mode, status, market_id, price, size, size_matched, created_at
     from live_orders where strategy = 'buy-table' order by created_at desc limit 20;
   -- the interlock verdict the tick sees
   select public.trade_live_preflight('buy-table');
   -- the deadman is silent
   select public.buy_table_deadman_check();
   ```

## ⚠ Capture-universe coverage (read this before picking the allowlist)

Discovery reads the **opening-capture stream**, whose universe is the `bot.cities` config row
(`select value from config where key = 'bot.cities'`). The capture scope was **10 cities** at one point and
the **45-city redeploy was operator-gated** — verify which is live before arming. A city in
`trade_config.city_allowlist` that is **not** in the captured universe simply **never gets candidates** (no
error, no alert — there is nothing to discover). If you want it traded, add it to `bot.cities` first and let
captures accrue. Also remember `convergence_capture_inputs` only returns FRESH-listed events (first seen
within ~1h of listing) — that is by design: the cheap flat-open window is where the ≤15¢ gate can fill.

## Files

- `supabase/migrations/0095_buy_table_live.sql` — the whole SQL surface (header carries the rollback).
- `supabase/functions/buy-table-tick/{index.ts,handler.ts}` — the tick (framework-free handler, unit-tested).
- Tests: `supabase/tests/buy-table-live.test.ts` (PGlite) + `supabase/tests/buy-table-tick-handler.test.ts`.
- The record this lane runs against: `BUY-TABLE.md` (KILL) · the interlock: `0082` + `docs/ops/TRADING-ACTIVATION.md`.
