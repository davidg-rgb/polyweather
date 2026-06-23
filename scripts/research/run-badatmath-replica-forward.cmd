@echo off
REM ============================================================================
REM Daily forward run of the badatmath-replica paper-trial (see BADATMATH-REPLICA.md).
REM Registered as a Windows Scheduled Task by install-badatmath-replica-task.ps1
REM (runs ~07:00 daily). Idempotent + resumable: reconciles resolved positions and
REM places new buys; a missed day self-heals on the next run. --persist projects the
REM live state into replica_positions/_runs so the /replica web dashboard stays fresh.
REM Read-only against the market data; the only writes are the paper-trial's own tables.
REM Appends each run's output to out\badatmath-replica-forward.log.
REM ============================================================================
cd /d "D:\Second Brain\03 Projects\Polyweather"
if not exist "scripts\research\out" mkdir "scripts\research\out"
echo. >> "scripts\research\out\badatmath-replica-forward.log"
echo ===== %DATE% %TIME% ===== >> "scripts\research\out\badatmath-replica-forward.log"
call pnpm tsx scripts\research\badatmath-replica.ts --mode forward --gamma --persist >> "scripts\research\out\badatmath-replica-forward.log" 2>&1
