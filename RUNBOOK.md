# RUNBOOK — operating Weather Edge

Operator procedures for incidents, manual actions, backfills, and the
recurring hygiene the go-live gate depends on. The dashboard (/admin, /system)
is the primary console; every mutation there is audited.

## Whale-watch + Slack-alert pause (2026-06-24)

Polymarket large-trade alarm (`whale-watch` Edge, every 10 min) + a global Slack-alert pause gate. Full
design/ops: `WHALE-WATCH.md`. Knobs live in the `config` table (set via SQL or /admin):

- **Pause every Slack alert except whales (LIVE now):** `update config set value='true' where key='alerts_slack_paused';`
- **Resume all alerts:** `update config set value='false' where key='alerts_slack_paused';`
  ⚠ While paused, CRITICAL `JOB_FAIL` and every other kind is silenced — only `WHALE_TRADE` gets through.
- **Allow extra kinds through while paused:** `update config set value='WHALE_TRADE,DEAD_MAN,JOB_FAIL' where key='alerts_slack_allow_kinds';`
- **Change the whale threshold (e.g. $50k):** `update config set value='50000' where key='whale_min_usd';` (no redeploy)
- **Deploy the alarm** (prod applied through `0053`): set `SLACK_WEBHOOK_URL` Edge secret → apply `0054`,`0055`
  → `supabase functions deploy whale-watch` (cron self-registers). Verify: `select public.dash_whale_watch(20);` (operator).
- **Mute the alarm without unpausing others:** drop `WHALE_TRADE` from `alerts_slack_allow_kinds`, or unschedule the
  `whale-watch` cron job.

## Replica forward — cloud go-live (badatmath replica; REPLICA-CLOUD-PORT.md)

Ports the daily replica forward loop off the local Windows Scheduled Task to a `replica-forward` Edge tick +
pg_cron (05:00 UTC = 07:00 local, the local task's hour) — the amsterdam-paper-trade twin. The DB is the source
of truth (migration `0053` already mirrors the forward state; `0056` adds the `entry_captured_ts` fill-window
column + the `replica_forward_inputs` RPC). NOT trading; the live rail stays DORMANT. Operator-gated, one time:

```bash
# 1) apply migration 0056 (entry_captured_ts + replica_record_positions/dash_replica_sim restated +
#    replica_forward_inputs + the 05:00Z replica-forward cron). The cron 404s harmlessly until step 2 lands.
supabase db push --project-ref "$SUPABASE_REF"   # or the SQL editor / MCP apply_migration
# 2) deploy the daily reconcile+place job (self-auth via x-cron-secret; cron self-registers)
supabase functions deploy replica-forward --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
```

Then `/replica` is self-updating: each 05:00Z tick reconciles resolved open positions (DB winner + a Gamma
fallback for the lagging ~45% our pipeline hasn't resolved) and places today's live cheap-Yes buys, upsert-only.
Verify: `select public.dash_replica_sim();` (operator) → the `runs.forward` block + new positions advance.
**After cloud go-live is verified, retire the local task:** `pwsh scripts/research/install-badatmath-replica-task.ps1 -Remove`
(keep `scripts/research/badatmath-replica.ts --mode forward` for ad-hoc/backtest use — it writes the same DB).
**Turn it off:** `select cron.unschedule('replica-forward');` (data + dashboard remain; no new positions).

## Incidents

### WU key incident (CRITICAL `WU_KEY`)
**Symptom:** fetch-actuals alerts WU_KEY CRITICAL; observations stop finalizing.
**Self-heal:** the job already retried — 401 forces a page re-scrape
(`extractWuApiKey`) and one retry; the stale key is retained on refresh failure.
**Manual:** open any wunderground.com history page, view source, find the
32-hex `apiKey`, set config `wuApiKey` via /admin (value is redacted in the UI
afterwards, §11.5). If the page layout changed, fix `extractWuApiKey` against
a fresh saved page (research/ has the fixture pattern).

### Station change (CRITICAL `STATION_CHANGE`)
**Symptom:** discovery saw a different ICAO in the market description (ADR-03):
betting suspended, old mapping closed, provisional station row created.
**Action:** open the live market description, confirm the new ICAO/coordinates
(OurAirports), run `pnpm tsx scripts/seed-stations.ts` if the station lacks
coordinates, then /admin → verify station (re-enables betting). History stays
split across `city_stations` validity windows — calibration never mixes stations.

### Dead-man (halt:global from staleness, §9.8)
**Symptom:** no fresh forecasts ≥ `staleForecastHaltH` (30h) → evaluateBreakers
applied `halt:global` + CRITICAL.
**Action:** /system → find the stalled job (gap matrix + failures); typical
causes: Open-Meteo outage (check status), pg_cron stopped (check `cron.job`),
CRON_SECRET drift (Vault vs function secrets). After snapshots flow again,
/admin → resume with the typed confirmation. Breakers re-halt if still stale.

### Position drift (live only, CRITICAL `POSITION_DRIFT`)
F-033 nightly reconciliation found bets ≠ data-api positions. Stop: set
`tradingMode=paper` via /admin, reconcile manually against
data-api.polymarket.com positions, record any external fill via the
manual-bet form (`executedExternally`), then re-enable.

## Manual job triggers

/admin → "Trigger a job manually" (server-proxies CRON_SECRET; period key
suffixed `:manual:{ts}` so the cron slot's idempotency is untouched). Or curl:

```bash
curl -X POST "$SUPABASE_URL/functions/v1/poll-markets" \
  -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" \
  -d '{"periodKey":"poll-markets:manual:2026-06-11T12:00:00Z"}'
```

`202` = accepted; `409` = that period already ran (expected for cron slots).

## Backfill operations (§6.22)

All resumable via `backfill_progress` (kill-safe; re-run continues at the
cursor) and budget-aware (the budgeter sleeps to UTC midnight when the daily
weighted-call budget is spent). The CLIs auto-load `DATABASE_URL` (and
`OPENMETEO_API_KEY`) from `.env.local` — no shell export needed; a real shell
var still wins. Run `seed-stations` first so every ICAO has coordinates. The
full-universe sequence (hosted Pro project, `DATABASE_URL` in `.env.local`,
~3 days on the free Open-Meteo tier):

```bash
pnpm tsx scripts/check-db.ts                              # pre-flight: DATABASE_URL connects (non-secret diagnostics)
pnpm tsx scripts/seed-stations.ts
# forecasts (Open-Meteo) + actuals (WU/IEM) hit different upstreams and have
# SEPARATE per-script daily-budget rows — run them in PARALLEL (two terminals):
pnpm tsx scripts/backfill-forecasts.ts --budget 8000     # ~2–3 budget-days
pnpm tsx scripts/backfill-actuals.ts   --budget 8000     # in parallel; truth for the residuals
pnpm tsx scripts/backfill-market-history.ts --limit 500  # repeat until eventsSeen exhausts
# fold the backfill into model_stats — wait for the 11:30Z run-calibration cron,
# or trigger it now (server-side secret; never echoes the value):
curl -fsS -X POST "$SUPABASE_URL/functions/v1/run-calibration" -H "x-cron-secret: $CRON_SECRET"
pnpm tsx scripts/check-p4-coverage.ts                    # P4 DoD gate: ≥90% cells / ≥40 stations / ≥12 months
pnpm tsx scripts/simulate-historical-edge.ts --from 2025-06-01 --to 2026-06-01 --out reports
```

**Multi-day, by design.** The free Open-Meteo tier paces forecasts to ~8000
weighted calls/UTC-day (the budgeter sleeps to midnight, then resumes from the
cursor). Total ≈ 3 days for forecasts, plus actuals in parallel. A paid
`OPENMETEO_API_KEY` in `.env.local` raises throughput and switches to the
customer- hosts automatically — the single lever that collapses the timeline.
Run the backfills in a persistent terminal (they survive longer than a chat
session); kill/re-run any time — they resume with zero refetch.

**`check-p4-coverage` is the P4 DoD gate.** Reports `model_stats` cell coverage
for the 5 core models (horizon ≥7d → cover leads 0–5) across coord stations ×
leads 0–5 × both slots; exits 0 only when ≥90% cells / ≥40 stations / ≥12
months. Run it after each calibration fold to watch coverage climb to PASS.

**`check-db` is the DATABASE_URL doctor.** It prints the connection's wiring
(host/port/user/db — never the password) and, on failure, the exact fix:
SASL/auth → reset the DB password (dashboard → Project Settings → Database) and
re-encode special chars; `Tenant or user not found` → the Supavisor pooler needs
user `postgres.<ref>`; timeout on `db.<ref>.supabase.co` → that endpoint is
IPv6-only, switch to the **Session pooler** host (`aws-*.pooler.supabase.com:5432`).
Quote the value in `.env.local`: `DATABASE_URL="postgresql://…"`.

### `model_stats` is still 0 after a backfill? — the cursor race + the full re-fold

`run-calibration` advances a forward-only cursor by observation `finalized_at`
(`config.calibCursor`): each run folds only the pairs whose observation finalized
since the last run. In **steady state** this is correct — a forecast is always
captured days before its day's observation finalizes, so all leads are present
when the obs is folded. But the **one-time full-universe backfill runs forecasts
and actuals in parallel**, so an observation can finalize (and the daily 11:30Z
cron can consume it past the cursor) *before* that station's forecast scope has
landed — orphaning those pairs. Symptom: `statsUpserted: 0 / residualsAdded: 0`
in the run-calibration job stats even though `forecast_snapshots` and finalized
`observations` overlap richly.

**The clean fix is one full re-fold once the backfill is complete** (all coord
stations have both forecasts and actuals). Reset the cursor and let calibration
re-pair from scratch — it deterministically rebuilds `model_stats` from every
available pair (the bias fold is date-ordered; σ/MSE windows are date-bounded,
not cursor-bounded):

```bash
# 1) reset the cursor so calibration re-pairs from the beginning
psql "$DATABASE_URL" -c "delete from config where key = 'calibCursor';"
# 2) trigger run-calibration; repeat until residualsAdded == 0. Each run folds
#    MAX_OBS_PER_RUN = 3000 observations (≈8 MB payload — bounded so the edge
#    runtime never OOMs/times out), so a full universe drains over
#    ceil(totalObs / 3000) triggers — or just let the 11:30Z cron self-drain it
#    (~14 days for ~40k obs; warm enough well inside a 60-day paper campaign).
curl -fsS -X POST "$SUPABASE_URL/functions/v1/run-calibration" \
  -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" \
  -d '{"periodKey":"run-calibration:manual:refold"}'
pnpm tsx scripts/check-p4-coverage.ts                    # watch coverage climb to PASS
```

Do NOT bother chasing orphaned pairs mid-backfill — the daily cron keeps moving
the cursor regardless; the final reset re-fold recovers everything.

### DF-5 — scored model-vs-market history (the no-peek backtest)

Grows `calibration_scores(window_tag='backtest')`: a real `house_gaussian`-vs-
`market_consensus` Brier track record built at the ADR-16 cutoffs, **no peeking**.
NO code change — pure ops wiring of the already-tested `backfill-market-history`
(the consensus prerequisite) + `simulate-historical-edge` (the scorer).

```bash
# 1) PREREQUISITE — synthesize historical market_consensus at pre-cutoff made_at.
#    Gamma returns closed events OLDEST-first; --from skips pre-cutoff events
#    BEFORE the (expensive, Cloudflare-fronted) prices-history fetch, so set it
#    to the start of the CLOB-retained window (see note). Resumable per event.
pnpm tsx scripts/backfill-market-history.ts --from 2026-05-13   # ~1300 events, ~60–90 min
# 2) SCORE — walk-forward, information-time-matched; writes window_tag='backtest'
#    + a CSV (fidelity / decile / equity) to reports/ (gitignored). --to = today-2.
pnpm tsx scripts/simulate-historical-edge.ts --from 2026-05-13 --to <today-2> \
      --source house_gaussian --out reports
```

**CLOB prices-history retention ≈ 30 days (the binding constraint).** Probed
2026-06-14: April-2026 events return 0 points; May-16 returns 249, June-4 returns
388 — each event's history spans only its ~2–3-day active life. So the honest
backtest is **capped at ~30 days deep** — there is no older house-vs-market history
to be had from Polymarket's API. The live `poll-markets` consensus already accrues
forward from when capture went live (2026-06-12); `backfill-market-history` fills
the ~30-day window *before* that which is still in CLOB retention. Set `--from` to
~30 days before today; earlier events just skip (empty history → `leads skipped
(no pre-cutoff)`, no consensus, ~1 wasted CLOB call each).

**R-A3 (the central hazard) — the consensus `made_at` MUST be the historical
pre-cutoff instant, never `now()`.** The script stamps `made_at =
new Date(maxPricePointTime ≤ cutoff)` (backfill-market-history.ts:281,288), so a
peek is impossible by construction. Spot-check after a run (closed events only —
the live cron stops writing consensus once an event closes, so any lead∈{0,1}
consensus row on a past target is purely backfill):

```sql
-- expect 0 violations and 0 rows stamped today
select count(*) filter (where bp.made_at >
         ((me.target_date::timestamp at time zone c.tz)
            - make_interval(days => bp.lead_days::int)) + interval '2 min') as peeks,
       count(*) filter (where bp.made_at::date = current_date)            as now_stamped
from bucket_probabilities bp
join market_events me on me.id = bp.event_id
join cities c on c.id = me.city_id
where bp.source='market_consensus' and bp.nowcast=false and bp.lead_days in (0,1)
  and me.target_date between current_date - 5 and current_date - 2;
```

**The backtest is indicative-only.** `go_live_gate_inputs` reads ONLY
`window_tag='60d'` (migration `0019`), so backtest rows never leak into the live
go-live gate. The HONEST-FIDELITY note the scorer prints on every run holds: the
consensus-mid proxy is not an executable book (no depth/spread/volume veto) — use
the result for **gating direction** (is house even competitive with the market?),
never as a go-live justification. F-019 promotion needs out-of-sample scored pairs;
this is how they accrue.

> **Why 3000 and not the whole window at once (found live 2026-06-13).** A
> 7.9k-obs catch-up window made `calib_new_pairs` aggregate ~365k pairs into a
> **21 MB** jsonb in ~7.2s, tripping the default ~8s `statement_timeout` — the
> run failed and folded nothing (clean: the cursor only advances after a
> successful upsert). Fix shipped: `MAX_OBS_PER_RUN` 20k→3k (bounds the payload)
> + migration `0027` adds `statement_timeout` headroom on the two heavy calib
> aggregations. **Both require deploying** — apply `0027` and redeploy
> `run-calibration` (`supabase functions deploy run-calibration --use-api
> --no-verify-jwt`) before the refold/cron will fold a large backlog.

## Analytics buildout — Phase 1 + 2a deploy (BLUEPRINT-analytics-buildout.md)

Phase 1 (surface) + Phase 2a (capture instrument) are built + tested locally
(typecheck 0, 597 green). All hosted effects are **operator-deploy-gated**; the
code is safe to deploy now — the new poll-markets analytics audit lands DORMANT
(writes 0 `edge_evaluations` until a `house_gaussian` champion exists, which
needs the Phase-2 capture fix + Phase-3 de-gate). Steps:

```bash
# 1) apply migration 0029 (dash_events_list — additive, read-only, zero existing
#    readers; safe). Via MCP apply_migration OR:
supabase db push --project-ref "$SUPABASE_REF"      # or management API / MCP
# 2) redeploy the three edge functions that changed (same bundler/no-JWT as the stack):
supabase functions deploy poll-markets       --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
supabase functions deploy snapshot-forecasts --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
supabase functions deploy snapshot-ensembles --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
# 3) redeploy the web app (Vercel) for /events + nav + calibration + event-page changes
vercel --prod          # or the project's normal deploy trigger
```

**What to watch after deploy:**
- `/events` lists all open events with collection-health + a `model?` chip (all
  "pending" today — flips to "built" automatically once house rows appear).
- **The capture instrument (ADR-19) pins the `stations:0` defect on the next
  scheduled `snapshot-forecasts`/`snapshot-ensembles` fire (10Z/22Z):** read the
  edge logs for the `'capture inputs'` line (the `{stations,models}` cardinality)
  and the `db.ts` empty-result line `{"rpc":"list_active_stations","empty":true,
  "dataWasNull":?}` — `dataWasNull:true` = PostgREST sent null (no rows over the
  wire); `false` = an empty SETOF `[]`. A 0-station run now records
  `job_runs.status='failed'` (retryable) + a Slack JOB_FAIL, NOT a silent `ok`.
- This is **Phase 2a only** — it INSTRUMENTS the defect; the root fix (and HD-1
  de-gate, migration 0028, `operator_resume('halt:global')`) is the next session
  once the one hosted fire reveals the mechanism. See BUILD-STATE "NOT built".

## External-source collection (snapshot-sources)

External comparison sources (OpenWeatherMap, WeatherAPI.com) are captured into
`source_forecasts`, **isolated from trading** — scored against the same WU/IEM
truth by `source_accuracy` / `scripts/check-source-accuracy.ts` but never in
`list_enabled_models`, the house blend, or `model_stats`. Two capture paths,
one shared loop (`functions/_shared/source-capture.ts`):

- **Autonomous (production):** the `snapshot-sources` Edge Function on pg_cron,
  `25 10,22 * * *` UTC (10Z/22Z slots, just after the Open-Meteo snapshot). This
  is what accrues daily history so the sources score in over time.
- **Manual seed/backfill:** `pnpm tsx scripts/snapshot-source-forecasts.ts` (one
  capture against `DATABASE_URL`; keys from `.env.local`).

**Deploy + enable (operator, one-time):**

```bash
# 1) set the source keys as Edge Function secrets (NOT echoed; .env.functions or inline)
supabase secrets set OPENWEATHERMAP_API_KEY=… WEATHERAPI_API_KEY=… --project-ref "$SUPABASE_REF"
# 2) deploy the function (matches the rest of the stack: api bundler, no JWT)
supabase functions deploy snapshot-sources --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
# 3) apply migration 0026 to register the cron job (or via the management API / MCP apply_migration)
```

With **no keys set** the function still runs but writes nothing and raises a
one-time `CONFIG` WARN (`snapshot-sources:no-keys`); if **every fetch fails**
(dead key / outage) it raises a `SOURCE_FETCH` WARN (`snapshot-sources:all-failed`).
Verify a tick: `select source, count(*), max(captured_at) from source_forecasts
group by source;` should advance each slot. Rank the sources any time with
`pnpm tsx scripts/check-source-accuracy.ts --leads`.

## Vault secret seeding (W11 — pg_cron reads these at run time)

```sql
select vault.create_secret('<the CRON_SECRET value>', 'cron_secret');
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
```

Rotate by updating the vault row AND the Edge Function secret together.

## Weekly backup (F-037) + restore drill

```bash
pnpm tsx scripts/backup-db.ts        # → backups/{date}.sql.gz, newest 8 kept
```

Schedule weekly (OS scheduler or CI cron). **Restore drill (run once after
the hosted deploy, then quarterly):** create a scratch database, then
`gunzip -c backups/<date>.sql.gz | psql "$SCRATCH_DATABASE_URL"` and verify
`select count(*) from bets;` matches production. The evidentiary core
(bets, bankroll_ledger, config_audit) has no PITR on the free tier — these
dumps are the audit trail.

## Monthly sweep (F-036) + attestations

On the 1st (the daily digest reminds in live mode): reconcile
`bankroll_ledger` against actual balances (paper: sanity-check `/bets` totals;
live: wallet + positions), withdraw profits above the high-water mark, then
set via /admin config: `ledgerReconciledAt` = today. Quarterly: verify
Polymarket account standing and set `kycAttestedAt` = today. Both feed the
go-live gate (≤35d / current-quarter checks).

## Pre-deploy + weekly: live shape check

```bash
pnpm tsx scripts/smoke-live-apis.ts   # exits 1 naming any drifted upstream
```

## Amsterdam paper-sim — go-live + operate (analytics deliverable; see AMSTERDAM-SIM.md)

Operator-gated (hosted DDL/deploys need per-action authorization). One time:

```bash
# 1) apply migration 0039 (amsterdam_paper_bets + place/grade RPCs + dash_amsterdam_sim + the 15:30Z cron)
supabase db push --project-ref "$SUPABASE_REF"   # or the SQL editor / MCP apply_migration
# 2) deploy the daily place+grade job (self-auth via x-cron-secret, like every job)
supabase functions deploy amsterdam-paper-trade --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
# 3) seed the curve from history (idempotent; the cron carries it forward after)
pnpm tsx scripts/amsterdam-sim.ts
# 4) redeploy the web app (Vercel) for the /amsterdam page + nav
vercel --prod
```

Then `/amsterdam` is live and self-updating (15:30 UTC daily: places today's four arms at
13/14/15/16 local, grades pending days once their EHAM obs finalizes). Inspect / extend any time:
`pnpm tsx scripts/amsterdam-sim.ts --analyze-only`. **Turn it off:**
`select cron.unschedule('amsterdam-paper-trade');` (data + dashboard remain; no new bets placed).

**`/amsterdam` 0046/0047 (2026-06-21, applied to hosted):** the decision-strip redesign added `tomorrow`
(bias-corrected lead-1 forecast → bucket → live odds) and `liveRunMax` (intraday_max as-of) to
`dash_amsterdam_sim`; 0047 fixed `nModels` to count distinct models. Both are pure `create-or-replace` of the
RPC (no table change), applied via Supabase MCP `apply_migration`; the frontend ships via the normal Vercel
push. To re-apply by CLI: `supabase db push` (idempotent — the function body is the latest in 0047).

## Sharp-wallet tracker — go-live (analytics benchmark; WALLET-RECON-HANDOFF.md Build #1)

Tracks the #1 WEATHER-leaderboard sharp "badatmath." + the top-N board as an independent third forecaster on
`/amsterdam` (3-way disagreement: their bucket vs our `house_ensemble` vs the market modal). NOT trading.
**State 2026-06-22:** migration `0049` **applied to hosted** (via MCP `apply_migration`) and the prod tables
**seeded live** (`scripts/sharp-wallets.ts --leaderboard` — 495 badatmath legs, 20 Amsterdam; rank #1). Remaining
operator steps:

```bash
# 1) deploy the daily ingest job (self-auth via x-cron-secret; cron 'sharp-wallet-track' 16:00 UTC already
#    registered by 0049 — it 404s harmlessly until this lands)
supabase functions deploy sharp-wallet-track --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
# 2) redeploy the web app (Vercel) for the SharpDisagreement card on /amsterdam (ships on the normal push)
#    — the dash_amsterdam_sim.sharps key is already live; the card renders once the frontend deploys.
```

Re-pull / extend any time: `pnpm tsx scripts/sharp-wallets.ts --leaderboard` (idempotent; `--analyze-only` to
just re-report). **Turn it off:** `select cron.unschedule('sharp-wallet-track');` (data + card remain). Builds
#2 (wallet-forensics/PnL ledger) and #3 (day-before efficiency study) are not yet built — see the hand-off.

## REC-3 fee/reward config ingest + REC-4 rewards monitor (MAKER-REBATE-HANDOFF.md §4)

**REC-3 — capture the full per-market fee + reward config (migration `0054`).** Adds `market_buckets`
columns (`fee_taker_only`, `fee_rebate_rate`, `fee_type`, `reward_max_spread`, `reward_min_size`,
`holding_rewards_enabled`) and extends `upsert_bucket` (drops the 12-arg overload, recreates with 6 new
defaulted params). The `discover-markets` parser already captures them from the Gamma event; existing rows
stay null until a `discover` re-run repopulates them (downstream EV readers fall back to the conservative
hardcoded 0.05/0.25 while null). Operator-gated deploy:
```bash
# 1) apply migration 0054 (idempotent; additive columns + function replace)
supabase db push --project-ref "$SUPABASE_REF"        # or SQL editor / MCP apply_migration
# 2) redeploy discover-markets so new discoveries persist the fee/reward config
supabase functions deploy discover-markets --use-api --no-verify-jwt --project-ref "$SUPABASE_REF"
# (no backfill needed — the next discover cycle fills the columns going forward)
```
Once populated, the maker-spray / m6 / m7 EV can read `fee_rebate_rate` per bucket instead of the assumed
0.25 (a one-line change in `loadEvents`, with a null→0.25 fallback to keep frozen results byte-identical).

**REC-4 — liquidity-rewards monitor (no deploy needed to RUN).** `pnpm tsx scripts/reward-monitor.ts`
paginates the live CLOB `/sampling-markets` (the funded reward pool) and reports whether any weather market
is funded. Exit 2 = TRIGGER (weather is in the pool); exit 0 = dormant. **2026-06-24: the trigger FIRED —
395/396 temperature markets are in the funded pool with real USDC daily rates (this reverses the §2 "rewards
DEAD on weather" finding).** Promotion to a continuous Edge+cron monitor (Slack-alert on a daily cron) is a
small follow-up: wrap `scanWeatherRewards` in an Edge function + `cron.schedule`, alerting when
`fundedWeather.length > 0` flips. Forecast-free reward farming on weather is now a live, un-analysed path —
see the hand-off for the recommended next work order (reward-farming economics).

**REC-8 economics first-pass + REC-9 probe (no deploy/capital needed to RUN).**
`pnpm tsx scripts/research/reward-farming-firstpass.ts` — live economics of forecast-free reward farming
(469 funded weather markets); frozen criterion PASSes but is NOT actionable (load-bearing on advertised
rate being paid). `pnpm tsx scripts/research/reward-probe.ts --mode plan` → an ~$59 real-money probe order
sheet that settles "do the pools pay as advertised?" (operator funds + rests + `--mode reconcile` after 24h —
full steps in `REWARD-FARMING-HANDOFF.md` §10, "Operator runbook"). Phase A (the rate + near-mid book-depth
time-series that makes the competition denominator time-integrated) is CLOUD-PORTED — Edge fn `reward-snapshot`
+ pg_cron `*/20 * * * *` (migration `0057`); deploy-gated go-live (`supabase db push` + `functions deploy
reward-snapshot --use-api --no-verify-jwt`) in `REWARD-FARMING-HANDOFF.md` §11. (Local ad-hoc form:
`pnpm tsx scripts/reward-snapshot.ts`.) All read-only/public; the live trading rail stays DORMANT.

## Failure-drill log (each upstream killed under test)

Every upstream's failure path is exercised by the committed suite — re-run
`pnpm test` to repeat the full drill:

| Upstream killed | Where drilled | Asserted outcome |
|---|---|---|
| Open-Meteo (per-station failure) | snapshots.test | station skipped, >20% → WARN, MODEL_DEGRADED after 3 null runs |
| WU 401 / key rotation | truth.test | forced-401 → re-scrape + retry; refresh failure → CRITICAL + stale key kept |
| WU empty/sparse day | backfill.test, truth.test | IEM fallback with `iem_fallback` provenance |
| CLOB book fetch failure | poll-markets.test | bucket excluded with `book_unavailable` (audit honesty) |
| Gamma malformed event | discovery.test | stored FLAGGED (known city) or alert-only; never guessed |
| Slack webhook down | runjob-notify.test, support-jobs.test | row kept unsent, dedupe key NOT consumed, resend sweep delivers |
| Job isolate death | job-rpcs.test | W16 started_at-predicate CAS takeover; reaper flips to failed (ADR-12) |
| Stale forecasts (dead-man) | support-jobs.test, ui-data.test | halt:global + CRITICAL at exactly 30h |
| Market resolves without truth | support-jobs.test | TRUTH_BEHIND_MARKET CRITICAL |
| Backfill killed mid-run | backfill.test (§9.7) | restart resumes at cursor, zero refetch, no duplicates |
