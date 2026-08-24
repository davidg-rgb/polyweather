# PAUSE / RESTORE — rebuilding Polyweather's Supabase project from the 2026-08-24 backup

**Why this exists.** The hosted Supabase project (`lenysiqxihsmxljvyybt`, Postgres 17.6, eu-north-1)
is being **paused** for cost. Pausing is reversible and loses nothing — *un-pausing the same project
restores everything as-is with zero restore work.* **This runbook is for the other case**: the project
is deleted, expires, or the operator decides to rebuild on a fresh ref. Everything below assumes the
old project is gone and only `backups/2026-08-24-pause/` survives.

Produced and verified by `scripts/ops/pause-backup.ts` on **2026-08-24**. Verification **PASSED** —
see §1.3. The DB was **read-only** throughout (pg_dump + SELECTs; no DDL, no writes).

---

## 1 · What was backed up

### 1.1 Files

`backups/2026-08-24-pause/` (gitignored — this is local-only, **it is not in the repo**):

| File | Size | What it is |
|---|---|---|
| `db-full.dump` | 157.1 MB | `pg_dump -Fc` (custom, compressed) — schema **and** data, schemas `public` + `supabase_migrations`. **Primary restore artifact.** |
| `db-data.sql` | 545.4 MB | Plain `--data-only` COPY text. Tooling-independent; readable with any psql, forever. |
| `schema.sql` | 0.5 MB | Plain `--schema-only`, `--no-owner --no-privileges`. |
| `inventory/` | ~40 KB | Everything pg_dump does **not** capture — see §1.2. |
| `verification.json` | 10 KB | Machine-written proof the dump is complete (§1.3). |

Total on disk: **0.69 GB**.

All three dumps and the row counts read **one exported snapshot**
(`pg_export_snapshot()` in a repeatable-read read-only transaction), so they are mutually consistent
to a single instant despite the 19 pg_cron writers that were live at capture time.

> **Binaries.** Taken with **`pg_dump (PostgreSQL) 17.6`** — the server is also 17.6. `tools/` is
> gitignored, so the client binaries are **not** kept. To restore, re-download the same portable set:
> ```bash
> curl -sSL -o tools/pg17-binaries.zip https://get.enterprisedb.com/postgresql/postgresql-17.6-1-windows-x64-binaries.zip
> unzip -q tools/pg17-binaries.zip -d tools/pg17     # -> tools/pg17/pgsql/bin/{pg_dump,pg_restore,psql}.exe
> ```
> Fallback: `winget install --id PostgreSQL.PostgreSQL.17 --scope user`.
> **pg_restore must be ≥ the server that produced the dump.** Do not restore a 17.6 dump with a 16.x
> pg_restore.

### 1.2 Inventory (`inventory/`)

| File | Contents |
|---|---|
| `row_counts.json` | Exact `count(*)` for all **75** public tables, taken inside the dump's snapshot. |
| `cron_jobs.json` | All 19 `cron.job` rows verbatim. |
| `cron_jobs_recreate.sql` | Executable, **idempotent** `cron.schedule(...)` regenerated from those rows. |
| `migrations_applied.json` | The 112 recorded `supabase_migrations.schema_migrations` rows + the 36-file diff vs the repo. |
| `extensions.json` | Installed extensions + versions. |
| `vault_secret_names.json` | Vault secret **id/name/created_at only** — no values, ever. |
| `edge_functions.json` | 32 deployed functions (name/version/status/updated_at) + parity vs the repo's 33 dirs. |
| `edge_secret_names.json` | The 23 Edge secret **names only** — no values, no digests. |

**Secrets are not in this backup and never will be.** Values live in the operator's `.env.local` and
password manager. Restoring requires the operator to re-enter them by hand (§3.2, §3.3).

### 1.3 Verification result — PASSED

Run: `pnpm tsx scripts/ops/pause-backup.ts` → exit 0, `verification.json.pass = true`.

- `pg_restore --list db-full.dump` → **76 TABLE DATA entries** == 76 dumped tables
  (75 `public` + `supabase_migrations.schema_migrations`). Nothing missing.
- **0 row-count mismatches across all 75 public tables** — the COPY payload rows counted inside
  `db-data.sql` equal the live `count(*)` exactly, table for table. The seven headline tables:

  | Table | Live | In dump |
  |---|---:|---:|
  | `market_snapshots` | 438,536 | 438,536 |
  | `forecast_snapshots` | 272,336 | 272,336 |
  | `edge_evaluations` | 176,187 | 176,187 |
  | `opening_captures` | 55,811 | 55,811 |
  | `cheap_early_variant_ledger` | 806 | 806 |
  | `config` | 160 | 160 |
  | `trade_config` | 1 | 1 |

- No COPY block left open (the plain dump is not truncated); all three files non-zero.

**Grand total: 1,372,971 rows across 75 tables.** Full per-table list in `inventory/row_counts.json`;
the top of it is reproduced in §5 so this document stands alone.

---

## 2 · Restoring the database

### Path A — RECOMMENDED: restore the custom dump into a fresh project

1. Create a new Supabase project (**Postgres 17**, region eu-north-1 to keep latency and the pooler
   hostname shape). Note the new ref — call it `<NEWREF>`.
2. Grab its connection string from the dashboard (Settings → Database). Use the **session pooler**
   form if the direct host is IPv6-only:
   `postgresql://postgres.<NEWREF>:<PW>@aws-0-eu-north-1.pooler.supabase.com:5432/postgres`.
3. Restore. `--no-owner --no-privileges` is required — the old dump references the old project's role
   grants, which do not exist on the new one:
   ```bash
   tools/pg17/pgsql/bin/pg_restore.exe \
     --dbname "<NEW_CONNINFO>" \
     --no-owner --no-privileges \
     --clean --if-exists \
     --jobs 4 \
     backups/2026-08-24-pause/db-full.dump
   ```
   Expect **non-fatal** errors on `--clean` for objects that never existed, and on extension-owned
   objects the `postgres` role cannot alter. Fatal-vs-noise: re-run `pg_restore --list` and compare
   against `verification.json.tableDataEntries` (76).
4. **Migration history arrives with the dump** — the `supabase_migrations` schema is included, so the
   new project already believes the 112 recorded migrations are applied. Reconcile the rest per §2.3.
5. Verify: re-run the row counts and diff against `inventory/row_counts.json`.

### Path B — FALLBACK: replay migrations, then load the data

Use this if the custom dump will not restore (version skew, corruption).

1. Apply all **129** repo migrations in filename order:
   ```bash
   for f in supabase/migrations/*.sql; do pnpm tsx scripts/ops/apply-migration.ts "$f"; done
   ```
   `apply-migration.ts` is transactional and records the ledger row; it skips anything already applied.
2. Load the data:
   ```bash
   tools/pg17/pgsql/bin/psql.exe "<NEW_CONNINFO>" \
     -v ON_ERROR_STOP=1 \
     -c "set session_replication_role = 'replica';" \
     -f backups/2026-08-24-pause/db-data.sql
   ```
   `session_replication_role = 'replica'` **is settable by the `postgres` role on Supabase** and
   disables FK and trigger enforcement for the session, so the COPY blocks load in whatever order
   pg_dump emitted them. **Set it back to `'origin'` afterwards** (or just reconnect — it is
   session-scoped). Note this also suppresses the write-time fold triggers (e.g. the 0106 grades
   fold); the dumped data already contains their output, so that is what you want.
3. Because the data dump includes `supabase_migrations.schema_migrations`, you may get conflicts with
   the rows step 1 just wrote. If so, load with the `public` schema only and skip §2.3 (history is
   already correct from the replay).

### 2.3 The migration-history gap

`supabase_migrations.schema_migrations` has **112 rows** but the repo has **129** migration files —
**36 files are unrecorded** (some recorded rows do not correspond to current filenames, which is why
the two numbers do not simply differ by 36). The repo's 129 files are **canonical**; the ledger is not.

Unrecorded (from `inventory/migrations_applied.json`): `0001_extensions`, `0002_reference`,
`0003_ingestion`, `0004_markets`, `0005_analytics`, `0006_trading`, `0007_ops`, `0008_rls`,
`0009_cron`, `0010_seed`, `0011_job_rpcs`, `0012_discovery_rpcs`, `0013_grading_rpcs`,
`0014_snapshot_rpcs`, `0015_truth_rpcs`, `0016_distribution_rpcs`, `0022_dashboard_rpcs`,
`0023_bet_delivery`, `0025_source_forecasts`, `0034_lockdown_internal_rpcs`,
`0035_dashboard_station_observations`, `0036_grading_sweep_window_and_today_market`,
`0037_operator_export_predictions`, `0038_dashboard_station_predictions`, `0039_amsterdam_paper_sim`,
`0040_amsterdam_forecast_nowcast`, `0041_amsterdam_nowcast_trailing_bias`,
`0043_amsterdam_truth_floor_accuracy`, `0044_amsterdam_inputs_wrap`, `0050_wallet_forensics_persist`,
`0054_market_fee_reward_config`, `0056_replica_forward_cloud`, `0075_city_sim_run_window`,
`0088_google_paper_repoint`, `0089_depth_capture_v2`, `0102_buy_table_entry_rules`.

These are all **already applied to the schema** (they are in `db-full.dump`/`schema.sql`) — only the
ledger is missing them. After a Path A restore, mark them applied so future `supabase db push` runs
do not try to re-run them:

```bash
supabase migration repair --status applied <version> --project-ref <NEWREF>
```

or, equivalently and in bulk, insert directly (the same shape `apply-migration.ts` writes):

```sql
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('<YYYYMMDDHHMMSS>', '0001_extensions', array[]::text[])
on conflict do nothing;
```

---

## 3 · Post-restore wiring — in this order

The database is only half the system. Do these in order; each depends on the previous.

### 3.1 Deploy the edge functions

**33** function dirs in `supabase/functions/` (excluding `_shared`, which is shared code, not a
function). **32 were deployed** at capture time — `replica-forward` exists in the repo but is **not**
deployed, and that is the pre-existing state, not a backup gap. Deploy the 32, or all 33 if you want
`replica-forward` live.

```bash
for d in supabase/functions/*/; do
  n=$(basename "$d"); [ "$n" = "_shared" ] && continue
  pnpm tsx scripts/ops/sb.ts functions deploy "$n" --project-ref <NEWREF> --use-api
done
```

Deployed set (from `inventory/edge_functions.json`): `account-snapshot`, `amsterdam-paper-trade`,
`arb-depth-capture`, `build-distributions`, `buy-table-tick`, `cheap-early-panel`, `city-paper-trade`,
`clob-egress-probe`, `clob-sdk-probe`, `convergence-panel`, `cross-venue-capture`, `daily-digest`,
`depth-capture`, `discover-markets`, `execute-bet`, `fetch-actuals`, `google-paper-panel`,
`grade-bets`, `health-monitor`, `maker-exit-panel`, `metar-nowcast`, `opening-capture`,
`poll-markets`, `reward-snapshot`, `run-calibration`, `sharp-wallet-track`, `sharps-snapshot`,
`snapshot-ensembles`, `snapshot-forecasts`, `snapshot-sources`, `synoptic-nowcast`, `whale-watch`.

### 3.2 Set the Edge secrets — 23 names, values from the operator

**Names only** are in the backup. The operator supplies every value from `.env.local` / the password
manager. Never paste a value into chat or a commit.

```bash
pnpm tsx scripts/ops/sb.ts secrets set --project-ref <NEWREF> NAME=value   # one at a time
```

| Name | Where the value comes from |
|---|---|
| `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL` | **New** project URL |
| `SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **New** project anon key |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEYS`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_JWKS` | **New** project keys |
| `DATABASE_URL`, `SUPABASE_DB_URL` | **New** conninfo |
| `CRON_SECRET` | Operator — regenerate; must match the vault `cron_secret` (§3.3) |
| `SLACK_WEBHOOK_URL` | Operator |
| `OPERATOR_EMAIL`, `NEXT_PUBLIC_APP_URL` | Operator |
| `WEATHERAPI_API_KEY`, `OPENWEATHERMAP_API_KEY`, `Google_MAPS_DEMO_API_KEY`, `checkwxapi_API_KEY`, `SYNOPTIC_PUBLIC_TOKEN` | Provider dashboards. **The rotated WeatherAPI/OWM keys — the old WeatherAPI key was exposed and stays retired.** |
| `POLY_PRIVATE_KEY`, `POLY_FUNDER_ADDRESS`, `POLY_SIGNATURE_TYPE`, `TRADE_MODE` | **Operator only.** Set `TRADE_MODE=dry-run` — the live lane is STOPPED. Do not set the signing key unless the operator explicitly re-arms live trading. |

Note `OPENMETEO_API_KEY` is absent by design — Open-Meteo is keyless. `GOOGLE_WEATHER_API_KEY` was
also not set as an Edge secret at capture time.

### 3.3 Seed the vault secrets

Two rows, read at runtime by every cron job (§3.4). Values from the operator; `cron_secret` must
equal the `CRON_SECRET` Edge secret set in §3.2.

```sql
select vault.create_secret('<NEW_PROJECT_URL>', 'project_url');
select vault.create_secret('<CRON_SECRET>',     'cron_secret');
```

### 3.4 Recreate the cron jobs

```bash
tools/pg17/pgsql/bin/psql.exe "<NEW_CONNINFO>" -v ON_ERROR_STOP=1 \
  -f backups/2026-08-24-pause/inventory/cron_jobs_recreate.sql
```

The generated SQL **unschedules each job by name before scheduling it**, so migration `0009_cron`
(and friends) having already created same-named jobs is fine — no duplicates. The commands read
`project_url` / `cron_secret` from the vault at call time, so **§3.3 must be done first** or every
tick posts to a null URL.

The 19 jobs (all `active` at capture):

| # | Job | Schedule (UTC) | Target |
|---|---|---|---|
| 1 | `discover-markets` | `10 2,11,17 * * *` | edge fn `discover-markets` |
| 2 | `snapshot-forecasts` | `17 10,22 * * *` | edge fn `snapshot-forecasts` |
| 3 | `snapshot-ensembles` | `35 10,22 * * *` | edge fn `snapshot-ensembles` |
| 4 | `build-distributions` | `50 10,22 * * *` | edge fn `build-distributions` |
| 5 | `poll-markets` | `12,42 * * * *` | edge fn `poll-markets` |
| 6 | `metar-nowcast` | `4,34 * * * *` | edge fn `metar-nowcast` |
| 7 | `fetch-actuals` | `20 * * * *` | edge fn `fetch-actuals` |
| 8 | `run-calibration` | `28 11 * * *` | edge fn `run-calibration` |
| 9 | `grade-bets` | `28 6 * * *` | edge fn `grade-bets` |
| 11 | `health-monitor` | `7 * * * *` | edge fn `health-monitor` |
| 12 | `snapshot-downsample` | `0 3 * * *` | SQL `public.ops_downsample()` |
| 24 | `opening-captures-prune` | `30 3 * * *` | SQL prune of `opening_captures` |
| 25 | `bot-tick-log-prune` | `35 3 * * *` | SQL prune of `bot_tick_log` |
| 29 | `snapshot-sources` | `25 10,22 * * *` | edge fn `snapshot-sources` |
| 30 | `job-run-details-retention` | `15 3 * * *` | SQL prune of `cron.job_run_details` |
| 31 | `google-paper-panel` | `24 * * * *` | edge fn `google-paper-panel` |
| 32 | `opening-capture` | `3,23,43 * * * *` | edge fn `opening-capture` |
| 48 | `buy-table-tick` | `1,6,11,16,21,26,31,36,41,46,51,56 * * * *` | edge fn `buy-table-tick` |
| 49 | `cheap-early-panel` | `38 1,7,13,19 * * *` | edge fn `cheap-early-panel` |

Keep the **minute-lane stagger**: `:00/:15/:30/:45` are permanently bad minutes for heavy functions
(same-second pileups cause statement timeouts). The schedules above already respect that — do not
"tidy" them.

Extensions required (auto-restored by the schema dump, listed for a from-scratch build):
`pg_cron@1.6.4`, `pg_net@0.20.3`, `pg_stat_statements@1.11`, `pgcrypto@1.3`, `plpgsql@1.0`,
`supabase_vault@0.3.1`, `uuid-ossp@1.1`.

### 3.5 Recreate the auth users

**2 `auth.users` rows** (operator logins). Auth data was **deliberately not dumped**. Recreate both by
hand in the dashboard (Authentication → Users) with the operator's addresses.

### 3.6 Repoint Vercel and redeploy

Update the project env on `weather-edge-two.vercel.app`: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` → the new project.
Redeploy.

### 3.7 Verify end-to-end

```bash
pnpm tsx scripts/diag-buy-lane.ts          # the remote verdict tool — "why no buys" lives here
pnpm tsx scripts/check-db.ts               # connectivity + wiring, prints no secrets
```
Then confirm `/operation`, `/cheap-early` and `/data` render on the redeployed dashboard, and that
`job_runs` gets fresh rows within an hour (the cron lanes are hourly or denser).

---

## 4 · Pause-day notes

- **Pausing stops all pg_cron jobs and edge functions.** Stopping mid-flight is safe: the live lane is
  already `dry-run` with the override cleared, there are no open orders, and every tick is idempotent
  (upserts / rebuilds). Nothing needs draining first.
- **The Vercel dashboard will error against a paused project.** Expected and harmless — every page
  reads through Supabase RPCs. It recovers on un-pause with no action.
- **Un-pausing the same project is a no-op restore.** Data, crons, edge functions, secrets and auth
  users all come back untouched. **None of §2 or §3 applies in that case** — this runbook is only for
  a deleted project or a fresh ref.
- **Capture stops while paused.** Every hour paused is an hour of `market_snapshots`,
  `forecast_snapshots` and `opening_captures` that will never exist. The forward paper loops
  (`cheap-early-panel` and the six pre-registered variants) lose that window permanently; their `n`
  simply stops growing. The 0129 variant ledger keeps already-realized entries.
- **Re-run this backup before un-pausing→re-pausing cycles** if meaningful data accumulated in
  between: `pnpm tsx scripts/ops/pause-backup.ts` writes a fresh dated directory and re-verifies.
  `--cli-inventory-only` refreshes just the edge-function/secret listings without re-dumping.

---

## 5 · Row counts at capture (2026-08-24) — top 20 of 75

Full list: `inventory/row_counts.json`. Grand total **1,372,971** rows.

| Table | Rows | | Table | Rows |
|---|---:|---|---|---:|
| `market_snapshots` | 438,536 | | `ensemble_snapshots` | 15,501 |
| `forecast_snapshots` | 272,336 | | `job_runs` | 8,666 |
| `edge_evaluations` | 176,187 | | `model_stats` | 6,471 |
| `model_stats_history` | 81,913 | | `cross_venue_captures` | 4,675 |
| `source_forecasts` | 73,658 | | `market_events` | 4,658 |
| `bucket_probabilities` | 68,301 | | `config_audit` | 3,693 |
| `opening_captures` | 55,811 | | `alerts_log` | 3,467 |
| `market_buckets` | 51,035 | | `city_prediction_grades` | 2,243 |
| `intraday_advances` | 47,054 | | `buy_table_cycle_ranges` | 2,143 |
| `observations` | 42,543 | | `google_replay_cache` | 2,084 |

**19 tables are empty** and that is their real state, not a backup failure: `bets`, `bot_bankroll`,
`bot_circuit_state`, `bot_daily_kill`, `bot_loop_lease`, `bot_orders`, `bot_positions`,
`bot_tick_log`, `city_live_arms`, `city_live_audit`, `complete_set_depth_captures`,
`convergence_panel`, `maker_exit_panel`, `market_price_history`, `market_rewards`, `synoptic_obs`,
`wallet_bet_calibration`, `wallet_positions_daily`, `whale_trades`. (`market_price_history` and
`bot_tick_log` were emptied by the free-tier sweep and the nightly prunes; `bets` has always been
empty — no capital was ever risked.)

---

## 6 · Re-running the backup

```bash
pnpm tsx scripts/ops/pause-backup.ts                       # -> backups/<today>-pause/
pnpm tsx scripts/ops/pause-backup.ts backups/my-dir        # explicit output dir
pnpm tsx scripts/ops/pause-backup.ts --cli-inventory-only  # refresh edge fn/secret listings only
```

Idempotent and re-runnable; exits non-zero if verification fails. Requires the Postgres 17 binaries
(§1.1) and `DATABASE_URL` + `SUPABASE_ACCESS_TOKEN` in `.env.local`. Helper unit tests:
`pnpm vitest run scripts/ops/pause-backup.test.ts`.
