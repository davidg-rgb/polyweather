# WS-1 + WS-5 rollout — panel data-path structural fix + ops hardening (0077 + 0078 + hardened handlers + retention prune)

> **2026-07-03 integration note (single combined bundle):** this runbook now also carries WS-5 —
> migration **0078** (`claim_job_run` janitor: a job's own `running` rows >30 min are swept to `failed`
> at its next claim — dead-isolate rows self-heal) and the **hardened handlers** (bounded retry on the
> terminal snapshot write; 10s-bounded, never-retried bookkeeping writes; complete wall arithmetic
> 346s worst case vs the 400s isolate wall). Both are in the same deploy artifacts as WS-1, so the
> steps below are unchanged in shape: step 1 applies BOTH migrations, steps 2/4 deploy the hardened
> handlers. Local commits: `52f115d` (WS-1) + `6c053f1` (WS-5); combined suite 135 files / 1928 green.

> **What this bundle does.** Kills the 2026-07-03 incident class at the root: `opening_captures` is 46 MB heap
> + ~1.2 GB TOAST (`buckets` jsonb), and every 45-city maker-exit-panel tick detoasted ~1.2 GB (> the instance
> buffer cache) → disk-bound ticks (cityErrors ~41/45, 343–378 s). Migration **0077** thins the shared read RPC
> server-side to a 20-min grid + the newest tick per event (the backtest's cadence class; skipped rows never
> detoast); **convergence-panel v7** gets
> the maker-exit v4 bounded worker pool so it can safely reactivate; the **prune** clears TOAST for events the
> archive already permanently holds. Spec: `FASTTRACK-PLAN.md` §WS-1.
>
> **Hard rules while rolling out:** one heavy DB operation at a time; the maker-exit tick minute (currently
> `:35` hourly) is a blackout window for heavy reads (FASTTRACK hard rule 1). Stop on ANY regression — every
> step below has a verification query and a rollback line.

Project ref: `lenysiqxihsmxljvyybt`. All `psql`/SQL via the SQL editor or MCP `execute_sql`; deploys via the
authed CLI (`npx --no-install supabase … --use-api --project-ref lenysiqxihsmxljvyybt`, the repo's idiom).

> **✅ EXECUTED 2026-07-03 ~14:55–15:20Z (operator-approved "all"; run by the orchestrator session). Outcome
> per step, including three evidence-based deviations:**
> - **Step 1 ✅** 0077 + 0078 applied via MCP; verify: 1 overload/thinned/janitor all true; **the single-city
>   canary went from >60 s (pre-0077, timed out the MCP client) to instant** (506 thinned captures).
> - **Step 2 ✅** maker-exit-panel deployed (hardened). **Step 3 ⚠ ADJUDICATED, not literally met:** two manual
>   probe ticks: 149.7 s/cityErrors 4/58 mkts (cold), then 213 s/15 (back-to-back — consecutive heavy ticks
>   still cycle the cache; the disk is the floor). Both `ok` + snapshot + gate. **Deviation 1: maker-exit-panel
>   STAYS HOURLY (`35 * * * *`, `bot.tickStaleMin.paper` stays '180')** — 4×/hour heavy ticks is the exact
>   compounding-load pattern of the 07-03 incidents; hourly ticks complete reliably and the gate accrues.
>   Revisit after the */2-era rows age out of the 21-day window (~2 wks) or on an instance upsize.
>   **HUGE side-benefit: the forward gate now sees 43–58 markets/tick (was 5–8)** — the broken fetch path had
>   been starving the gate-of-record's accrual all along.
> - **Step 4 ✅** convergence-panel v7 deployed. **Step 5 ✅** cron 26 re-enabled `*/15`; **first tick: `ok`,
>   23.2 s, cityErrors 0, snapshot 350** (10-city scope + 0077 + bounded pool = fully clean).
> - **Steps 6–7 ✅ / Step 8 skipped-correctly:** dry-run = **0 candidates** (the table only has data since
>   06-27 — nothing is resolved ≥25 d). The tool is proven; it becomes the real TOAST relief valve from ~late
>   July. **Deviation 2: no `--execute`** (nothing to delete). **Deviation 3 / Step 9 DEFERRED:** VACUUM
>   ANALYZE moved to a quiet overnight window — stats are sane (reltuples correct); the disk, not the planner,
>   is the current floor. **Step 10 superseded by Deviation 1** (capture stays `*/10` permanently — operator-
>   approved: the flat-open thesis is dead and `*/10` halves TOAST growth).
> - **Steady state as left:** capture `*/10` · maker-exit-panel hourly `:35` · convergence-panel `*/15` (23 s
>   clean) · deadman thresholds matched · suite 135 files/1928 green · local commits `52f115d`+`6c053f1`+`c0892ec`.

---

## Current state assumed (verify before starting)

```sql
select jobname, schedule, active from cron.job where jobname in ('maker-exit-panel', 'convergence-panel');
-- expect: maker-exit-panel '35 * * * *' active · convergence-panel */15 INACTIVE (paused on v6)
select key, value from config where key in ('bot.tickStaleMin.paper', 'bot.gateStaleMin');
-- expect: bot.tickStaleMin.paper = '180' (hourly-cadence relaxation) · bot.gateStaleMin = '180'
```

If these differ, reconcile with BUILD-STATE.md before proceeding — the restore steps below assume them.

## Step 1 — apply migrations `0077_capture_read_thinning.sql` + `0078_job_runs_janitor.sql`

```bash
npx --no-install supabase db push --project-ref lenysiqxihsmxljvyybt
# or: MCP apply_migration with each file body (0077 first, then 0078 — both plain create-or-replace)
```

**Verify** (cheap; 0077: the fn body thins on the 20-min grid, exactly ONE 2-arg overload; 0078: the
claim fn carries the janitor sweep):

```sql
select pronargs, prosrc like '%grid_rn%' as thinned
  from pg_proc where proname = 'convergence_capture_inputs' and pronamespace = 'public'::regnamespace;
-- expect exactly one row: (2, true)

select prosrc like '%30 minutes%' as janitor
  from pg_proc where proname = 'claim_job_run' and pronamespace = 'public'::regnamespace;
-- expect: true

-- single-city canary — should return in well under a second and count FEWER captures than before:
select jsonb_array_length(public.convergence_capture_inputs(21, array['amsterdam'])->'captures');
```

**Rollback:** 0077 → re-apply the 0076 §2 body (`supabase/migrations/0076_capture_read_scaling.sql`, the
`convergence_capture_inputs` statement + its grants); 0078 → re-apply the 0011 `claim_job_run` body + the
0034 grants. Same signatures, so both are plain `create or replace`.

## Step 2 — deploy `maker-exit-panel` (v5)

No functional change (the RPC signature is unchanged; v5 is a traceability comment) — deploy so the prod
artifact matches repo HEAD:

```bash
npx --no-install supabase functions deploy maker-exit-panel --use-api --no-verify-jwt --project-ref lenysiqxihsmxljvyybt
```

**Rollback:** redeploy the previous artifact (git: the pre-WS-1 commit of `supabase/functions/maker-exit-panel/`).

## Step 3 — verify ONE clean maker-exit tick (the go/no-go for the rest of the bundle)

Wait for the next `:35` tick, then:

```sql
-- PASS bar: status 'ok' · duration_ms < 120000 · cityErrors ≤ 2
select started_at, status, duration_ms,
       stats->>'cityErrors' as city_errors, stats->>'budgetSkipped' as budget_skipped,
       stats->>'captureRows' as capture_rows, stats->>'nMarkets' as n_markets, stats->>'label' as label
  from job_runs where job = 'maker-exit-panel' order by started_at desc limit 3;

-- the snapshot landed this tick:
select captured_at from maker_exit_panel order by captured_at desc limit 1;

-- the forward gate-of-record advanced this tick:
select computed_at, label, n_markets, n_cities, n_distinct_days
  from bot_gate_snapshot where mode = 'paper' and source = 'forward' order by computed_at desc limit 1;
```

**On regression** (duration ≥ 120 s or cityErrors > 2): STOP here. Roll back step 1 (and step 2 if deployed);
the system returns to the known hourly steady state. Do not proceed to convergence-panel or the prune.

## Step 4 — deploy `convergence-panel` (v7, bounded worker pool)

```bash
npx --no-install supabase functions deploy convergence-panel --use-api --no-verify-jwt --project-ref lenysiqxihsmxljvyybt
```

**Rollback:** redeploy the previous artifact — but then KEEP the cron paused (v6 unbounded fetch must never
run at 45-city TOAST scale; it is only safe behind 0077 + the pool).

## Step 5 — re-enable the convergence-panel cron (prod job 26, `*/15`)

```sql
select cron.alter_job(26, schedule => '*/15 * * * *', active => true);
-- verify it is the right job first if in doubt: select jobid, jobname from cron.job where jobname = 'convergence-panel';
```

**Verify one tick** (next quarter-hour; permanently offset from maker-exit's `:35` — and after step 10, from
`5,20,35,50`):

```sql
select started_at, status, duration_ms, stats->>'cityErrors' as city_errors, stats->>'snapshotId' as snapshot_id
  from job_runs where job = 'convergence-panel' order by started_at desc limit 3;
-- PASS bar: status 'ok', duration well under the isolate wall, cityErrors ≤ 2 (10-city allowlist scope)
select captured_at from convergence_panel order by captured_at desc limit 1;
```

**Rollback:** `select cron.alter_job(26, active => false);` — the panel goes back to paused; nothing else is affected.

## Step 6 — prune DRY-RUN (read-only; off the tick minutes)

Local shell (needs `DATABASE_URL` in `.env.local` + the price-history archive at
`scripts/research/out/market-history/`):

```bash
pnpm tsx scripts/ops/prune-opening-captures.ts
```

Prints candidate events (resolved ≥ 25 days ago), row counts, a stored-bytes estimate, and the MANDATORY
archive pre-flight result (every candidate `poly_event_id` must exist in the local archive index — no archive
file, no delete). **Rollback:** none needed — read-only.

## Step 7 — operator decision

Proceed only if: the dry-run pre-flight PASSED, the counts look sane (candidates are old resolved events, not
the live panel window), and steps 3+5 verified clean. Otherwise stop — the system is already healthy without
the prune; it only reclaims TOAST headroom.

## Step 8 — prune `--execute` (destructive; off the tick minutes)

```bash
pnpm tsx scripts/ops/prune-opening-captures.ts --execute
```

Batched deletes (≤ 5000 rows/statement); the script re-runs the pre-flight and REFUSES if any candidate is
un-archived. **Rollback:** none — deletion is final BY DESIGN; the on-disk price-history archive is the
permanent record (that is what the pre-flight guarantees). If in doubt, stop at step 7.

## Step 9 — `VACUUM ANALYZE` (IO-heavy; quiet window, never during a tick minute)

```sql
vacuum analyze public.opening_captures;
-- afterwards, confirm the TOAST shrank / stats refreshed:
select pg_size_pretty(pg_total_relation_size('public.opening_captures')) as total,
       pg_size_pretty(pg_relation_size('public.opening_captures')) as heap;
```

**Rollback:** n/a (vacuum is non-destructive). If the pooler jams during it, wait it out — do not cancel-spam.

## Step 10 — restore steady-state cadence + deadman threshold

```sql
-- maker-exit-panel back to 4×/hour, permanently STAGGERED from convergence-panel's */15 (:00/:15/:30/:45):
select cron.alter_job((select jobid from cron.job where jobname = 'maker-exit-panel'),
                      schedule => '5,20,35,50 * * * *');
-- deadman tick threshold back to the 15-min-cadence value (3× cadence):
update config set value = '45' where key = 'bot.tickStaleMin.paper';
```

**Verify:** the next two maker-exit ticks land at :05/:20/:35/:50 with the step-3 PASS bar, and
`select public.bot_deadman_check();` shows `alarmed: false`.

**Rollback:** `schedule => '35 * * * *'` + `value = '180'` (the incident-era hourly relaxation).

---

## Restore-state table (steady state after this bundle)

| Knob | Steady-state value |
| --- | --- |
| `cron` `maker-exit-panel` | `5,20,35,50 * * * *`, active |
| `cron` `convergence-panel` (job 26) | `*/15 * * * *`, active |
| `config` `bot.tickStaleMin.paper` | `'45'` |
| `config` `bot.gateStaleMin` | `'180'` (unchanged) |
| `convergence_capture_inputs` | 0077 body (20-min grid thinning + last-tick retention), 2-arg signature, service_role-only |
| `opening_captures` retention | 0066 90-day cron + this manual resolved≥25d prune (archive-pre-flighted) |
