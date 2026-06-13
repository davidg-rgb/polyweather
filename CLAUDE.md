# Polyweather — Project Context

Weather-edge prediction-market trading system. Predicts daily Tmax for ~46 global
airport stations from a calibrated multi-model NWP ensemble, prices temperature
prediction markets against it, and trades the edge. Stack: **Supabase** (Postgres +
edge functions + pg_cron) + **Vercel** dashboard, TypeScript monorepo
(`packages/core|io|trading`, `supabase/functions`, `scripts/*` run via `pnpm tsx`).

- Hosted Supabase ref: `lenysiqxihsmxljvyybt` (eu-north-1) · Prod: `weather-edge-two.vercel.app`
- Canonical docs: `BUILD-STATE.md` (status + Operator TODO), `RUNBOOK.md` (ops),
  `REQUIREMENTS.md`, `ARCHITECTURE.md`. Tests: `pnpm test`, `pnpm typecheck`.
- Build is COMPLETE (P0–P8). Remaining work is operator/deploy-gated — see BUILD-STATE.

---

## ⚙️ ACTIVE OPERATIONAL RULE — auto-resume the P4 backfill (self-expiring)

**At the start of every session, automatically (without being asked), UNTIL
`pnpm tsx scripts/check-p4-coverage.ts` reports `✅ P4 DoD MET`:**

1. **Launch BOTH backfill workers as harness background tasks** (`run_in_background: true`).
   These are the only spawn method that survives a whole session — a detached/`spawn`
   child is reaped the instant its launching command exits, and a foreground run blocks:
   - `pnpm tsx scripts/backfill-forecasts.ts --budget 8000`
   - `pnpm tsx scripts/backfill-actuals.ts --budget 8000`
   Each resumes from its DB cursor and self-paces against the 8000/UTC-day Open-Meteo
   budget (prints `sleeping … min until the next UTC day` once spent, wakes at 00:00Z).
   Relaunching is safe — idempotent on the cursor.
2. **First check whether they're already running this session** (e.g. background task
   list / their output). If a pair is already alive, DON'T launch a second — duplicates
   race the shared cursor + budget and waste the day's quota.
3. **Keep them alive for the session:** if a background backfill task exits/dies before
   P4 is done, relaunch it. Surface progress (station coverage) when asked or on milestones.

**Goal:** backfill all 46 stations (last seen ~18/46) so calibration warms and
`check-p4-coverage` PASSes — the P4 Definition-of-Done. **The moment it PASSes, DELETE
this whole rule block** (and tell the operator). It is a temporary one-time-backfill aid.

> Why this lives here, not in a hook or Scheduled Task: the backfill is a multi-day,
> budget-gated job. Detached processes don't survive on this Windows + harness setup
> (job-object reaping), and the operator chose session-scoped auto-resume over a standing
> OS automation that would hit prod unattended. So each session re-ensures it's running.

---

## After the backfill (the P4 finish line)

When `check-p4-coverage` PASSes: `delete config calibCursor` (hosted) → the 11:30Z
`run-calibration` cron self-drains the refold → `model_stats` fully populates → P4 done.
Remaining operator-CLI deploys (non-blocking) are in `RUNBOOK.md` 140–171: redeploy
`run-calibration` (3k cap) and deploy `snapshot-sources` + migration `0026` (set the
**rotated** WeatherAPI/OWM keys as Edge secrets — the old WeatherAPI key was exposed in
chat and should already be rotated).
