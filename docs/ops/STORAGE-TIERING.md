# STORAGE-TIERING — Supabase hot window + local training corpus

**The rule.** Supabase (the Micro instance) holds only the **hot window** each *live* consumer needs — edge
functions, pg_cron, and the dashboard RPCs. The **full history** lives in local gzipped NDJSON shards under
`scripts/research/out/<table>-archive/` for training / testing / backtesting. Two of the big accumulators (the
raw order book and the market price history) were already mirrored locally; this generalises the pattern to the
rest and adds a table-driven tool so it stays lean.

> Boundary: pruning is always **archive-gated** — no verified local (or resolution-based) archive of a row, no
> delete. The offload never destroys the only copy.

## Per-table policy (established 2026-07-21)

| Table | Live read need | Policy | Mechanism |
|---|---|---|---|
| `opening_captures` | ≤21d (panels), latest/event (buy lane) | keep ~25d; archive+prune the rest (~863 MB) | **`scripts/ops/dump-opening-captures.ts` → `--verify` → `prune-opening-captures.ts --preflight dump`** (resolution-based, price-path/dump-gated) |
| `edge_evaluations` | latest ~44 rows/event (<2d) | **7d** server-side prune (was 30d) | pg_cron `ops_downsample` (migration **0116**) — no local archive (no training value) |
| `market_rewards` | ≤7d (page); signal CLOSED 2026-07-06 | keep 14d, archive the rest | **`scripts/ops/archive-retention.ts`** (local, archive-gated) |
| `model_stats_history` | none (pure audit log) | keep 30d, archive the rest | **`scripts/ops/archive-retention.ts`** |
| `market_snapshots` | latest/bucket, ≤5d | already downsampled (0009: 1/hr>7d, 4/day>30d, 1/day>180d) | pg_cron `ops_downsample` — cold tail is candidate for local offload later |
| `forecast_snapshots` | **full walk-forward** (/station, /amsterdam trailing-bias) | **keep hot** — live dashboards read the full lead-1 history | 0009 prune >90d except lead 0–2 @10Z |
| `bucket_probabilities` | scored slice **full history** (/data) | **keep the scored slice hot**; unscored pruned 30d-post-resolve | 0009 |

**Why a LOCAL script and not a pg_cron for the keep-local tables:** the archive is the operator's local disk,
which a Supabase cron cannot write — a blind cron prune would delete rows that were never archived. So tables
whose history we keep (market_rewards, model_stats_history, opening_captures) are archive-gated by a local
script; only `edge_evaluations` (no training value) is pruned purely server-side.

## Runbook

**Keep-local tables (market_rewards, model_stats_history) — `scripts/ops/archive-retention.ts`:**
```bash
pnpm tsx scripts/ops/archive-retention.ts                     # DRY-RUN: what would archive + prune
pnpm tsx scripts/ops/archive-retention.ts --execute           # archive completed UTC days → local shards + verify (non-destructive)
pnpm tsx scripts/ops/archive-retention.ts --execute --prune   # + delete the VERIFIED cold tail (archive-gated)
# then, quiet window (returns the disk space):  VACUUM (FULL, ANALYZE) public.<table>;
```
Only **completed** UTC days are archived (never today — no race with a live writer); the prune deletes only days
older than the table's hot window that are verified shards. Config is `RETENTION` in the script — adding a table
is one entry `{ table, tsColumn, hotWindowDays, note }`. Cadence: run from the loop every ~week (append-only, cheap).

**`opening_captures` raw book (the 863 MB, off-peak — its VACUUM FULL locks the hot capture table):**
```bash
pnpm tsx scripts/ops/dump-opening-captures.ts --force         # refresh the local raw-book archive (resumable)
pnpm tsx scripts/ops/dump-opening-captures.ts --verify        # stamp manifest.verified (prune pre-flight)
pnpm tsx scripts/ops/prune-opening-captures.ts --preflight dump --resolved-age-days 1 --execute
# then, OFF-PEAK:  VACUUM (FULL, ANALYZE) public.opening_captures;
```

**`edge_evaluations`:** automatic — the 0116 cron keeps 7d. A one-time `VACUUM FULL` was run 2026-07-21 to
realise the reclaim; the file now tracks the 7d working set.

## Reclaim log

- **2026-07-21 (first pass):** DB **~2.9 GB → 2652 MB**. market_rewards **140 MB → 32 kB** (dead signal, 336k rows
  archived local), edge_evaluations **186 MB → 34 MB** (624k rows pruned to 7d + VACUUM FULL), model_stats_history
  **37 MB → 24 MB** (63k rows archived+pruned). ~305 MB reclaimed; full history preserved locally
  (`market_rewards-archive` 27 MB gz, `model_stats_history-archive` 3.5 MB gz).
- **2026-07-21 (same day, opening_captures):** **1300 MB → 277 MB (~1,023 MB)**, DB **2652 → 1634 MB**. Preserved
  the prior archive (renamed `opening-captures-archive-c96-20260707`), fresh full dump (311,406 rows / 835 events,
  546 MB local) → `--verify` PASS → archive-gated prune resolved>2d (246,297 rows / 644 events) → `VACUUM FULL`.
  Zero data lost, zero job failures. **Session total: DB ~2.9 GB → 1634 MB (~1.27 GB).**
  - _Recurring:_ opening_captures regrows ~95 MB/day → re-run the dump→prune→VACUUM playbook every ~1–2 weeks
    until the incremental-append dump (below) is built. **Each `--force` run must first preserve the prior archive
    dir** (rename) — a fresh dump matches the current (post-prune) live table, so it does NOT contain
    previously-pruned events; overwriting the old dir would lose their raw book.

## Durable follow-up (not built)

**Incremental-append dump** for opening_captures so retention is a cheap daily delta instead of a ~1.3 GB
`--force` re-dump. Requires changing the verify from "manifest == live" (full-snapshot) to **"every live row is
covered by some shard" (live ⊆ archive)**, because after a prune the append-only archive is a *superset* of the
live table. Until then, the rename-then-`--force` playbook above is the safe manual path.

## The floor, and how to go lower

`forecast_snapshots` (283 MB) and the scored slice of `bucket_probabilities` (~most of 357 MB) are the
training/testing corpus **and** are read live over full history by `/station`, `/amsterdam` and `/data`. To move
those local too, materialise small per-station/per-day **summary** tables for those pages to read, then archive
+ prune the raw detail. That's the only remaining lever and it touches live dashboards — a separate, scoped piece
of work, not part of the safe reclaim.
