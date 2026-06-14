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

1. **FIRST kill any existing backfill processes — they DO survive across sessions on this
   setup, so launching without this STACKS DUPLICATES** that race the shared cursor and
   split the 8000/day budget N-ways (observed 2026-06-14: 3 actuals + 2 forecasts stacked
   from prior sessions). Run in Git Bash (PowerShell is denied here); `wmic` targets only
   backfill node procs by command line, so it won't touch other node processes:
   ```
   wmic process where "name='node.exe' and commandline like '%backfill-%'" call terminate
   ```
2. **THEN launch exactly ONE of each as harness background tasks** (`run_in_background: true`):
   - `pnpm tsx scripts/backfill-forecasts.ts --budget 8000`
   - `pnpm tsx scripts/backfill-actuals.ts --budget 8000`
   Each resumes from its DB cursor and self-paces against the 8000/UTC-day Open-Meteo
   budget (prints `sleeping … min until the next UTC day` once spent, wakes at 00:00Z).
   Relaunching is safe — idempotent on the cursor. **Forecasts rate-limit caveat:** on a
   fresh-day wake the forecasts worker fires fast and can trip Open-Meteo's free-tier
   rate limit — it logs `retries exhausted … previous-runs-api` per cell, keeps the
   cursor, and recovers when the window resets. Benign (~1 weighted call per failed
   scope); do NOT panic-kill or relaunch into the same wall — let it ride or pause it.
3. **Keep them alive for the session:** if a backfill task exits/dies before P4 is done,
   re-run step 1 (kill) then step 2 (launch one pair). Surface progress (station coverage)
   when asked or on milestones.

**Goal:** backfill all 46 stations so calibration warms and `check-p4-coverage` PASSes —
the P4 Definition-of-Done. **The moment it PASSes, DELETE this whole rule block** (and
tell the operator). It is a temporary one-time-backfill aid.

> Why this lives here, not in a hook or Scheduled Task: the backfill is a multi-day,
> budget-gated job, and the operator chose session-scoped auto-resume over a standing OS
> automation that would hit prod unattended.
> **CORRECTION (2026-06-14):** the earlier claim that detached procs are reaped was WRONG
> — `run_in_background` tasks each open a cmd window that PERSISTS across sessions, so
> pairs stacked into duplicates. Step 1's kill-first makes re-ensuring idempotent. To
> close a stray worker, kill its node proc (step 1's `wmic`); its cmd window then exits.

---

## After the backfill (the P4 finish line)

When `check-p4-coverage` PASSes: `delete config calibCursor` (hosted) → the 11:30Z
`run-calibration` cron self-drains the refold → `model_stats` fully populates → P4 done.
Remaining operator-CLI deploys (non-blocking) are in `RUNBOOK.md` 140–171: redeploy
`run-calibration` (3k cap) and deploy `snapshot-sources` + migration `0026` (set the
**rotated** WeatherAPI/OWM keys as Edge secrets — the old WeatherAPI key was exposed in
chat and should already be rotated).
