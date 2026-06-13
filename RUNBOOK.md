# RUNBOOK — operating Weather Edge

Operator procedures for incidents, manual actions, backfills, and the
recurring hygiene the go-live gate depends on. The dashboard (/admin, /system)
is the primary console; every mutation there is audited.

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

**`check-db` is the DATABASE_URL doctor.** It prints the connection's wiring
(host/port/user/db — never the password) and, on failure, the exact fix:
SASL/auth → reset the DB password (dashboard → Project Settings → Database) and
re-encode special chars; `Tenant or user not found` → the Supavisor pooler needs
user `postgres.<ref>`; timeout on `db.<ref>.supabase.co` → that endpoint is
IPv6-only, switch to the **Session pooler** host (`aws-*.pooler.supabase.com:5432`).
Quote the value in `.env.local`: `DATABASE_URL="postgresql://…"`.

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
