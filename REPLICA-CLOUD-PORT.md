# REPLICA-CLOUD-PORT — move the daily replica forward loop off the local PC → Supabase Edge + pg_cron

> **BUILT 2026-06-24 (code complete; deploy operator-gated).** Migration `0056_replica_forward_cloud.sql`
> (note: 0055 went to whale-watch, so this is **0056**, not the 0055 the plan below assumed) adds
> `replica_positions.entry_captured_ts`, restates `replica_record_positions`/`dash_replica_sim` to carry it,
> adds the `replica_forward_inputs` RPC, and registers the `replica-forward` cron (05:00 UTC). The reconcile/
> place decision logic moved into core as the pure `reconcilePure`/`placeBuysPure` (+ `ForwardPosition`), shared
> by the local task and the new `supabase/functions/replica-forward/{index,handler}.ts` Edge tick; a Gamma
> fallback resolver lives in `_shared/polymarket-wallet.ts` (`fetchGammaWinners`). Tests:
> `supabase/tests/replica-forward.test.ts` + new core cases — `pnpm typecheck` 0, `pnpm test` 1239 green. Deploy
> + retire the local task per **RUNBOOK.md → "Replica forward — cloud go-live"**. The rest of this doc is the
> original build spec, kept for provenance.

> **Authored 2026-06-24.** The build spec for porting the **badatmath-replica forward loop** from a local
> Windows Scheduled Task (`scripts/research/badatmath-replica-forward.ts`, runs 07:00 daily) to a **Supabase
> Edge Function + pg_cron** — the `amsterdam-paper-trade` twin. Operator chose this target (over Vercel cron,
> which is off-pattern: the web app is read-only and would need a service-role write + a 2nd cron secret).
> Everything below is the result of a full code investigation; the next session can BUILD directly from it.
>
> **Honest scope/value note (carry forward):** this is a sizable port (a new inputs RPC + a pure refactor +
> an Edge fn + cron + tests) of a tracker for a strategy `FINDINGS.md` already proved DEAD — the replica just
> *watches* the spread/adverse-selection tax in real time. The higher-value open thread is **REC-8**
> (`REWARD-FARMING-HANDOFF.md`, the now-funded weather liquidity rewards). The local task works fine (ran
> clean 2026-06-24 07:00, result 0, 0 missed). Build this if cloud-resilience matters more than that tradeoff.

---

## 0. The decision + why it's tractable

- **Target:** a `replica-forward` Edge Function on a daily pg_cron (05:00Z = 07:00 local), self-authing via
  `x-cron-secret` through `runJob` — exactly like `amsterdam-paper-trade` (the template; read its `index.ts`
  + `handler.ts`).
- **Why feasible:** migration `0053` ALREADY mirrors the full forward state to the DB (`replica_positions`
  source='forward' = open+closed positions; `replica_runs` = whitelist+strat+counts; write RPCs
  `replica_record_positions(p_source,p_replace,p_rows)` / `replica_record_run(p_payload)`; read
  `dash_replica_sim`). The `/replica` dashboard renders from the DB, so the local `.md`/`.csv`/`state.json`
  artifacts become redundant in the cloud.
- **The binding constraint:** the Supabase Edge **port is RPC-only** (`functions/_shared/db.ts` `DbPort.rpc`,
  no raw SQL). The script's `loadCandidates`/`loadResolutions`/`reloadAskSeries` use raw SQL via
  `makeScriptDb` — those reads MUST become an **inputs RPC** (the amsterdam `*_inputs` pattern).
- **The one schema gap:** `reconcile` needs `entryCapturedTs` (the fill-window start) but `replica_positions`
  has NO such column and `forwardToRow` drops it. **Migration 0055 must add `entry_captured_ts` + persist it.**

## 1. State-as-DB transformation (the core change)

Today the source of truth is `out/badatmath-replica-state.json` (`ForwardState = {whitelist, strat, open[],
closed[]}`). In the cloud, the DB is the source of truth. The Edge run is:

1. **Load** via `replica_forward_inputs` RPC → `{ run:{whitelist,strat}, open:[ForwardPosition], resolutions:{eventId:winnerIdx}, askSeries:{conditionId:[{capturedAt,bid,ask,mid}]}, candidates:[ReplicaCandidate-with tz+targetDate+snapshots] }`.
2. **Reconcile** (pure): Gamma-fallback in the handler (fetch + the pure `winnerFromGamma`), merge with DB `resolutions`, close resolved open positions (set bucketWon + maker-realistic fill via `simulateFill` over `askSeries[conditionId]` filtered to `>= entryCapturedTs`).
3. **Place** (pure): from `candidates`, compute `resolutionTs` via `localDayWindow(tz,targetDate)` (core/time — keep tz correctness in TS, NOT SQL), filter to live (entryTs ≤ now < resolutionTs, unresolved), `selectBuys`, dedupe against open, open new ForwardPositions.
4. **Persist (UPSERT-ONLY — `p_replace=false`):** send ONLY changed rows (newly-closed + newly-opened) to `replica_record_positions('forward', false, rows)` — the natural-key upsert flips status/fills the closed and inserts the opened. **Do NOT replace=true** (that would need re-sending all closed history; upsert avoids loading it). Then `replica_record_run` with the run counts.
- No ledger/CSV rendering in the Edge fn — `dash_replica_sim` + the `/replica` loader already roll up from the DB.

## 2. Build plan (file by file)

### 2a. Migration `0055_replica_forward_cloud.sql`
- `alter table public.replica_positions add column if not exists entry_captured_ts bigint;`
- Extend `replica_record_positions` insert/upsert to read/write `entryCapturedTs` from the jsonb rows (add the column to the INSERT list + the `on conflict do update set`). Also add it to `dash_replica_sim` output (harmless, keeps the projection complete).
- New `replica_forward_inputs(p_now bigint, p_place_from date, p_place_to date)` returns jsonb with the 5 keys in §1.1:
  - `run`: latest `replica_runs where mode='forward'` → `{whitelist, strat}` (fallback to defaults when none).
  - `open`: `replica_positions where source='forward' and status='open'` as the engine shape (incl `entry_captured_ts → entryCapturedTs`, `placed_at_utc → placedAtUtc`, etc.).
  - `resolutions`: `{event_id: winning_bucket_idx}` for the open positions' events (join `market_events`, only resolved).
  - `askSeries`: `{condition_id: [{capturedAt,bid,ask,mid}]}` for the open positions' condition_ids (join `market_snapshots` via `market_buckets`, ASC) — small (~17 open).
  - `candidates`: the `loadCandidates` SQL as nested jsonb — events (market_events+cities, `target_date in [from,to]`, optional `lower(slug)=any(whitelist)`, `ladder_ok`) → per-event buckets (idx,low,high,tick,fee,condition) → per-bucket windowed snapshots (`captured_at` in `target_date−5d .. +2d`). Carry `tz`, `target_date`, `unit`, `winning_bucket_idx` so TS computes `resolutionTs`/`bucketWon`/`bucketLabel`. Mirror `dash_replica_sim`'s jsonb_agg style.
- pg_cron: `select cron.schedule('replica-forward', '0 5 * * *', $$ ...net.http_post to the edge fn with x-cron-secret... $$);` — copy the EXACT cron body shape from migration `0039` (amsterdam-paper-trade's `30 15 * * *`).
- grants: `revoke all ... ; grant execute on replica_forward_inputs(bigint,date,date) to service_role;` (post-0034 contract).
- Add `0055_replica_forward_cloud.sql` to the expected list in `supabase/tests/migrations.test.ts` (the "has the migration files in order" test — it WILL fail otherwise, like 0054 did).

### 2b. Pure refactor — move reconcile/place logic into `packages/core/src/sim/badatmath-replica.ts`
The Edge fn (Deno) CANNOT import `scripts/` (node:fs, makeScriptDb). Extract pure variants into core:
- `reconcilePure(open: ForwardPosition[], resolutions: Map<eventId,winnerIdx>, askSeriesByCondition: Map<cond, AskPoint[]>, nowSec): { stillOpen, newlyClosed }` — the body of the script's `reconcile` minus the DB reads (which become the passed-in maps). Reuse `simulateFill` (already in core/sim/maker-spray).
- `placeBuysPure(candidates: ReplicaCandidate[], open+closedKeys: Set<string>, strat, nowSec): ForwardPosition[]` — the body of `placeBuys` minus `loadCandidates` (passed in). Computes resolutionTs via `localDayWindow`, filters live, `selectBuys`, dedupe.
- Move `ForwardPosition` type to core (it currently lives in the forward script). The script's `reconcile`/`placeBuys` become thin wrappers: do the DB reads, call the pure core fn, keep the file-state path working (local task UNCHANGED).
- Keep `core/sim/badatmath-replica.test.ts` green; add tests for the two pure fns.

### 2c. Edge function `supabase/functions/replica-forward/{index.ts, handler.ts}`
- `index.ts`: copy amsterdam-paper-trade's — `periodKey = 'replica-forward:'+YYYY-MM-DD`, `getServiceDb`, `runJob('replica-forward', periodKey, req, ctx => replicaForward(ctx, {now, fetchJson}), {db})`.
- `handler.ts` `replicaForward(ctx, deps)`: `db.rpc('replica_forward_inputs', {p_now, p_place_from, p_place_to})` → reconstruct → Gamma fallback (fetch `${GAMMA}/markets?condition_ids=…&closed=true`, `winnerFromGamma` is pure in `polymarket/gamma`? it's in `scripts/research/badatmath-purchase-map.ts` — MOVE `winnerFromGamma` + the chunked resolver to a shared spot, e.g. `_shared/polymarket-wallet.ts` already has resolution helpers — check `resolveMarketsMeta`) → `reconcilePure` → `placeBuysPure` → `db.rpc('replica_record_positions', {p_source:'forward', p_replace:false, p_rows: changed})` → `db.rpc('replica_record_run', {p_payload})`. Return JobStats `{reconciled, opened, open, closed}`.

### 2d. Tests
- `supabase/tests/replica-forward.test.ts` (pglite, mirror `amsterdam-paper-trade.test.ts`): apply migrations, seed a forward open position + a resolved event + book, call `replica_forward_inputs`, assert the jsonb shape; run the handler with a stub fetch (Gamma) + assert reconcile closes it + a candidate gets placed + the upsert lands. Plus the `migrations.test.ts` list update.
- `packages/core/test/badatmath-replica.test.ts`: add `reconcilePure`/`placeBuysPure` cases.

### 2e. RUNBOOK + retire the local task
- Add a "Replica forward — cloud go-live" section (deploy steps: apply 0055, `supabase functions deploy replica-forward`, the cron self-registers; verify `select dash_replica_sim()`).
- After cloud go-live is verified, retire the local task: `pwsh scripts/research/install-badatmath-replica-task.ps1 -Remove` (the script supports removal). Keep the local script for ad-hoc/backtest use.

## 3. Reuse map (exact)
- Template: `supabase/functions/amsterdam-paper-trade/{index,handler}.ts` + migration `0039` (the cron body) + `0044` ({rows:[…]} envelope lesson — wrap top-level jsonb arrays or supabasePort misreads them as row sets).
- Engine (pure, core): `selectBuys`, `scoreLocked`, `ReplicaStrategy`, `ReplicaCandidate`, `LockedBuy`, `DEFAULT_REPLICA_STRATEGY` (`core/sim/badatmath-replica.ts`); `simulateFill` (`core/sim/maker-spray.ts`); `snapshotAtOrAfter` (`core/sim/copy-trade.ts`); `localDayWindow` (`core/time.ts`).
- DB write RPCs: `replica_record_positions` / `replica_record_run` (0053) — already RPC-callable by the port.
- Gamma resolver: `winnerFromGamma` + `fetchResolutions` currently in `scripts/research/badatmath-purchase-map.ts` (node). For the Edge, reimplement the small fetch loop in the handler (or share `winnerFromGamma`, which is pure) — drop the file CACHE (no fs in Edge; only ~17 open ids/run, re-fetch is cheap).
- `runJob` / `getServiceDb` / `supabasePort` (`functions/_shared/`); `fetchJson` (`packages/io`).

## 4. Gotchas (live-verified, do not relearn the hard way)
- **`entry_captured_ts` is the load-bearing gap** — without it the maker-realistic fill window is wrong. 0055 first.
- **supabasePort RPC-only** — no raw SQL in Edge; all reads via `replica_forward_inputs`.
- **0044 envelope** — if an `*_inputs` RPC returns a TOP-LEVEL jsonb array, supabasePort misreads it as a RETURNS-TABLE row set. Return a single jsonb OBJECT (the 5-key shape) — it's an object, so fine; just don't return a bare array.
- **`create or replace function` adds an overload if the signature changes** ("function not unique" — the 0054 trap). `replica_record_positions` signature is UNCHANGED (same 3 args, just more jsonb keys read) so no drop needed; new functions are new names.
- **tz correctness** — compute `resolutionTs` in TS via `localDayWindow`, never `(target_date±1)::timestamptz` in SQL (the db1 bug).
- **migrations.test.ts list** — append `0055_…` or the suite fails (deterministic, like 0054).
- **Parallel whale-watcher** (operator's build) is uncommitted on the same tree (`polymarket-wallet.ts` ×2 + `research/dataapi-trades-whales-sample.json`). Stage replica-port files EXPLICITLY; never `git add -A`.

## 5. Acceptance
`pnpm typecheck` 0 · `pnpm test` green (was 1204 + new). Deploy operator-gated. Live rail stays DORMANT
(this is a paper trial; no `packages/trading`). After cloud go-live verified, remove the local scheduled task.
