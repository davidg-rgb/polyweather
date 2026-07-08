# Depth-capture v2 — full-redesign handoff (execute in a fresh session)

**Written 2026-07-08.** The v1 depth-capture build shipped (commit `c85158a`) and was live-verified — it **fails**
(write times out → 0 rows) and a 5-agent adversarial review surfaced **12 confirmed findings**. Operator decision:
**full v2 redesign, fix everything**, executed post-`/clear`. This doc is the complete, self-contained spec. A
fresh Claude should be able to execute it end-to-end. Read it top to bottom before touching anything.

> **Guardrails (NON-NEGOTIABLE).** Money-path (`poll-markets`: consensus→edges→recommendations) stays UNTOUCHED.
> The trading rail stays DORMANT. Claude builds software only; the operator funds/keys/deploys and never pastes
> secrets in chat. `opening-capture` STAYS running (the convergence + maker-exit siblings read `opening_captures`
> for `houseProb`). This is analytics-only — the /convergence Google forward-paper panel. No capital anywhere.

---

## 1. Current live/prod state (the exact starting point)

- **`main` @ `c85158a`** (LOCAL, not pushed) = the v1 build. Working tree clean at handoff (this doc + the review
  JSON + a memory update will be committed on top).
- **Migration `0087_depth_capture.sql` IS APPLIED to prod** (via MCP `apply_migration`, recorded under a timestamp
  version). It added: `market_snapshots.depth jsonb` (+ partial index `market_snapshots_depth_idx`),
  `record_depth_captures()`, `depth_capture_targets()`, and a `depth-capture` `*/5` cron. **v2 discards this design**
  → these must be cleaned up (see §5).
- **`depth-capture` cron is PAUSED** (`cron.unschedule('depth-capture')` was run). The edge fn (`supabase/functions/
  depth-capture/`) is deployed but inert.
- **Migration `0088_google_paper_repoint.sql` is COMMITTED but NOT applied.** The panel still runs on its 0086
  RPC (reading `opening_captures`). Do NOT apply 0088 as-is — it embeds the anchor bug (finding A).
- **~61 synthetic `market_snapshots.depth` rows** exist from manual RPC tests (fake `execAsk 0.11` etc.). Dropping
  the `depth` column in §5 removes them; no separate cleanup needed.
- **`opening-capture` revived and healthy**: cron `opening-capture` (`*/5`, jobid 32) + `opening-capture-deadman`
  (`*/10`, jobid 33). It feeds the Google panel today AND the convergence/maker-exit panels permanently. KEEP IT.
- Hosted Supabase ref: `lenysiqxihsmxljvyybt` (eu-north-1). Prod: `weather-edge-two.vercel.app`.
- **Full review detail** (all 12 findings with per-finding `verifyReasoning`): `docs/ops/depth-capture-review-findings.json`.

---

## 2. What v2 must achieve

Repoint the **Google forward-paper panel** off the flaky/pruned `opening_captures` onto a **durable, clean,
purpose-built executable-depth store** — WITHOUT the v1 defects: no shared-table pollution, no bloat, no write
timeout, no anchor drift, no silent stalls, honest entry population. Convergence + maker-exit stay on
`opening_captures`. `poll-markets` untouched.

Why v1 was wrong (root causes, two of them structural):
- **Wrote into shared `market_snapshots`** → (a) bloat (~230k rows/day, 13×), (b) shadowed the dashboard's
  latest-snapshot `book_top3` reads. A **dedicated table** kills both.
- **Re-anchored `hoursSinceListing` to `first_seen`** (ingestion time) instead of the true Gamma listing time →
  the flat-open `fresh<1h` gate became near-tautological and the panel measures a different population.

---

## 3. The 12 confirmed findings (consolidated; full text in the review JSON)

Grouped, de-duplicated (the review flagged some at two severities across dimensions). Severity is the corrected
(post-verification) value.

### BLOCKERS (must fix before any cutover)
- **A — Listing-anchor break (HIGH, `0088:44/69/71`).** `hoursSinceListing = captured_at − first_seen` and
  `createdAtGamma = first_seen`. `first_seen` is *ingestion* time (`upsert_event` sets `first_seen=now()`), not the
  Gamma `createdAt`. Because depth-capture walks within ~5 min of first_seen, `min(...)<1h` is ~always true → the
  fresh cohort is no longer "listed <1h ago"; and `maxEntryAgeH=24` (measured from first_seen) admits late entries.
  The codebase explicitly warns against this: `opening-convergence.ts:78` — "NOT first-sighting — the listing-anchor
  fix." **Fix: source the true Gamma `createdAt`** (see §4.3).
- **B — Write times out → 0 rows (HIGH, live-confirmed).** The single 800-row `record_depth_captures` upsert
  exceeds PostgREST's statement timeout under load (`canceling statement due to statement timeout` in pg logs at
  each tick's write); the handler's `catch` swallows it → `inserted:0`, job reports `ok`. **Fix: dedicated table +
  chunked writes + statement_timeout + delta-dedupe (far fewer rows) + surface a write-count mismatch in stats.**

### MEDIUM
- **C — Write volume / bloat + silent 800-truncation (`0087:106`, `handler.ts:181`).** 800 buckets × `*/5`,
  unconditional insert ≈ 230k rows/day; `limit 800` silently drops the oldest (near-resolution) buckets, unlogged.
  **Fix: delta-dedupe writes (only on meaningful change, like poll-markets' moved/heartbeat gate); dedicated table;
  log truncation when the target count hits the cap.**
- **D — No per-tick wall-clock budget + terminal-only write (`handler.ts:160`).** Every sibling job has a time
  budget; this one doesn't, and writes once at the end → a slow/rate-limited CLOB tick blows the ~400s isolate
  before the write → silent stall (no deadman watches depth). `0087:76` even documents an intended budget that was
  never implemented. **Fix: per-invocation time budget + incremental/flush writes + a depth-staleness deadman.**
- **E — Asks-only entries (`handler.ts:160`).** No two-sided-quote gate, so the panel now enters buckets with an
  ask but no bid (execBid null → no TP/SL → held to resolution) that `opening-capture` filtered out
  (`opening-capture/handler.ts:242-244`). **Fix: mirror the two-sided-quote gate before walking/storing.**
- **I — Test gaps (×2).** (1) `handler.test.ts` only uses a full-fill book → never tests execAsk *diverging* from
  best_ask (the job's raison d'être), partial fills, empty/one-sided books, or non-default `perPositionUsd`.
  (2) No end-to-end test of the `DepthRow ↔ jsonb_to_recordset` column contract (a key rename silently inserts
  NULLs — literally bug B's cousin). **Fix: add a thin-book/partial-fill/empty-book/perPositionUsd unit matrix +
  a PGlite round-trip that asserts a handler-shaped row lands and reads back through the panel RPC.**

### LOW
- **F — Partial per-tick ladder drops the event (`0088:80`).** `jsonb_agg` builds each tick's ladder from only the
  present depth rows; a failed walk or the 800-cap can omit the Google-predicted bucket → `googleBucketIdx` null →
  event silently dropped. **Fix: carry the COMPLETE ladder per tick (all `market_buckets` labels, execAsk null for
  un-walked) so the bucketer never sees a gap.**
- **G — Dashboard `book_top3` shadowing (`0087:54`).** depth-capture inserts new `market_snapshots` rows with
  `book_top3=null`; `dash_event_detail`'s "latest snapshot per bucket" then renders null between poll ticks.
  **Fixed for free by the dedicated table (§4.1)** — depth-capture no longer writes to `market_snapshots`.
- **H — perPositionUsd size invariant (`handler.ts:147`, pre-existing).** Walk size = `botCfg.perPositionUsd`;
  panel replays at `GOOGLE_DEFAULTS.perPositionUsd=20`. Coincide only while both are 20. **Fix: walk at
  `GOOGLE_DEFAULTS.perPositionUsd` (the size the panel actually replays at), or assert equality.**
- **J — Staged-cutover db-push foot-gun (`handoff:40`).** `0088` is a committed migration; a blanket
  `supabase db push` applies the repoint prematurely; only a prose caveat guards it. **Fix: a technical guard —
  e.g. the repoint RPC no-ops / falls back to opening_captures until `market_depth` has ≥N rows, or keep the
  repoint migration out of the auto-applied set until cutover.**

### Refuted (do NOT "fix" — it's correct)
- **resolvesAt = `target_date` 12:00 UTC.** Raised HIGH, refuted by both a direct measurement (8 tz all resolve at
  12:00 UTC) and the verifier. It IS the uniform venue rule. Keep hardcoding it.

---

## 4. The v2 design

### 4.1 Dedicated `market_depth` table (kills C-bloat + G-shadowing)
New migration. Do NOT write depth into `market_snapshots`.
```
market_depth (
  id            bigint generated always as identity primary key,
  bucket_id     uuid not null references market_buckets(id),
  captured_at   timestamptz not null,
  best_bid numeric, best_ask numeric, mid numeric, spread numeric,
  exec_ask numeric, exec_bid numeric, depth_usd numeric,
  sellback_depth_usd numeric, sellback_usd numeric,
  unique (bucket_id, captured_at)
)
-- index (bucket_id, captured_at desc); index on captured_at for the panel window scan.
```
Store computed exec prices as real columns (not a jsonb blob) so the panel RPC reads them directly and PGlite tests
can assert them. RLS on; service-role write; operator read via the panel RPC only.

### 4.2 Fresh + trajectory scope with DELTA-DEDUPE (kills C-volume + B-load; keeps the exit trajectory)
The panel needs each event's price PATH from listing → resolution (for TP/exit), so do NOT drop the trajectory.
Cut volume by **only writing when depth moved meaningfully** (mirror poll-markets' `moved || heartbeat` gate,
`poll-markets/handler.ts:234-241`): compare exec_ask/exec_bid to the bucket's last `market_depth` row; write only
on a delta ≥ threshold or a heartbeat interval. This collapses ~230k rows/day to a small fraction. Keep a bounded
target set but **log when the cap is hit** (fetch an un-capped count or a `capped` boolean). Consider walking fresh
events every tick and established-trajectory events on a longer heartbeat.

### 4.3 True listing anchor (kills A)
`market_events` has NO Gamma `createdAt` column (only `first_seen`=ingestion, `created_at`=our row). Two options:
1. **PREFERRED: add `market_events.gamma_created_at timestamptz`**, populated where the Gamma `createdAt` is
   parsed — `discover-markets/handler.ts` already parses events (`parseGammaEvent → ev.createdAt`) and upserts them;
   thread `createdAt` into `upsert_event` (`0012_discovery_rpcs.sql`). This is discovery/liveness, NOT the
   money-critical edge path — low risk. Then the panel RPC computes `hoursSinceListing = captured_at −
   gamma_created_at` and sets `createdAtGamma = gamma_created_at`. Backfill is impossible for old rows (accept
   forward-only; the panel is a forward seed anyway).
2. Fallback (zero schema change, keeps a dependency): join each event to `opening_captures.created_at_gamma` (still
   being written by the revived opening-capture) — but coverage is narrower and it re-couples to the table we're
   escaping. Prefer option 1.

### 4.4 Complete ladder per tick (kills F)
When building each tick's `buckets[]` in the panel RPC, LEFT JOIN all of the event's `market_buckets` (idx+label)
and attach exec prices where a `market_depth` row exists, `execAsk/execBid=null` where not — so the bucketer
(`googleBucketIdx`) always sees the full ladder and never drops the event on a partial walk. (This mirrors how the
old `opening_captures` stored the complete ladder with null exec for un-walked buckets.)

### 4.5 Two-sided gate (kills E)
Before walking/storing a bucket, require a real two-sided quote (`bestBid != null && bestAsk != null && !(bestBid==0
&& bestAsk==1)`) — mirror `opening-capture/handler.ts:242-244`. Asks-only buckets get no `market_depth` row (and
appear as execAsk=null in the complete ladder), so the panel won't enter an exit-less position.

### 4.6 Robust write (kills B/D)
- Chunk the write (e.g. ≤200 rows/statement) and/or add `set statement_timeout` on the write RPC.
- Add a per-invocation wall-clock budget to the walk (like `opening-capture` SEED_TIME_BUDGET_MS) + flush
  incrementally so a truncated tick persists partial depth.
- Surface a write mismatch in stats (`inserted` vs `walked`) and DON'T report `ok` on a swallowed write error —
  log LOUD or let the deadman catch it.
- Add a **depth-staleness deadman** (like `capture_deadman_check`) that alarms if `market_depth` stops growing.

### 4.7 Panel walk size (kills H)
Walk exec prices at `GOOGLE_DEFAULTS.perPositionUsd` (the size the panel replays at), not `botCfg.perPositionUsd`.

### 4.8 Staging guard (kills J)
Make the repoint safe against a premature `db push`: e.g. the rewritten `google_paper_inputs` falls back to the
`opening_captures` source (or returns the old shape) until `market_depth` has ≥N rows, OR gate the cutover behind a
config flag the operator flips. A prose caveat is not enough.

---

## 5. File-by-file work plan

1. **New migration `0089_depth_capture_v2.sql`** (supersedes the applied 0087 design):
   - `drop index if exists market_snapshots_depth_idx; alter table market_snapshots drop column if exists depth;`
     (removes the applied column + the 61 synthetic rows).
   - `drop function if exists record_depth_captures(jsonb, timestamptz); drop function if exists
     depth_capture_targets(int,int);` (v1 RPCs).
   - Create `market_depth` (§4.1) + `record_market_depth()` (delta-aware, chunk-friendly, statement_timeout) +
     `market_depth_targets()` (fresh + trajectory, logs cap) + a depth-staleness deadman + the `depth-capture` cron
     (re-scheduled `*/5`, or the operator re-arms it post-deploy).
   - `alter table market_events add column if not exists gamma_created_at timestamptz;` (§4.3).
2. **`upsert_event` (in `0012` or a new migration) + `discover-markets/handler.ts`**: thread the Gamma `createdAt`
   into `gamma_created_at`. Verify no money-path change.
3. **`0088_google_paper_repoint.sql`**: REWRITE to read `market_depth` + the complete-ladder join (§4.4) + the
   `gamma_created_at` anchor (§4.3) + the staging guard (§4.8). Keep `resolvesAt = target_date 12:00 UTC`. It stays
   the FINAL cutover migration (applied only after parity).
4. **`supabase/functions/depth-capture/handler.ts` + `pure.ts`**: rewrite for the two-sided gate (§4.5), delta-dedupe
   (§4.2), `GOOGLE_DEFAULTS.perPositionUsd` (§4.7), wall-clock budget + incremental flush + honest stats (§4.6),
   writing to `market_depth`. Consider extracting the walk into a testable `pure.ts`.
5. **Tests**: `handler.test.ts` — add the thin-book/partial-fill/empty-book/perPositionUsd matrix (§I-1). New
   PGlite round-trip test — assert a handler-shaped row inserts into `market_depth` and reads back through the
   rewritten `google_paper_inputs` (§I-2). Update `migrations.test.ts` (file list, cron list/count, any new
   natural-key/tripwire rows for `market_depth`).
6. **Docs**: update `DEPTH-CAPTURE-REPOINT-HANDOFF.md` (mark v1 superseded) and this file's deploy section.
7. `pnpm test` + `pnpm typecheck` green before committing.

---

## 6. Deploy + verify sequence (operator-gated; Claude never deploys/keys)

1. Apply `0089` (drops v1 depth column/RPCs, creates `market_depth`, adds `gamma_created_at`, re-arms cron) +
   redeploy `discover-markets` (anchor population) + redeploy the `depth-capture` fn. Harmless — panel still on
   `opening_captures`.
2. Let `market_depth` accrue ≥1 day (fresh events + resolutions across cities). Verify: rows growing, `exec_ask`
   in [0,1], `gamma_created_at` populated, fresh-event count sane, **no statement-timeout errors in pg logs**,
   Micro not saturating (watch `poll-markets` + the two capture jobs).
3. Parity check vs the (revived) `opening_captures` path — the rewritten RPC's fresh-event set + entries should be
   in the same ballpark.
4. Apply the rewritten `0088` (the cutover). Watch the next `google-paper-panel` snapshot. History resets (fine).
5. `opening-capture` STAYS (convergence/maker-exit). Do NOT retire it.

Rollback: before `0088`, nothing to undo (additive). After: re-apply `0086`'s `google_paper_inputs` body.

---

## 7. Pointers
- v1 build commit: `c85158a`. Full review JSON: `docs/ops/depth-capture-review-findings.json`.
- Reference code: `opening-capture/handler.ts` (walk + two-sided gate + createdAtGamma), `poll-markets/handler.ts:234-241`
  (delta/heartbeat gate — reuse for §4.2), `google-bucket-view.ts` + `opening-bracket-ingest.ts` (RawCaptureRow/
  RawBucket shape the panel consumes), `0086_google_paper.sql` (the original RPC to preserve parity with).
- Canonical project verdict: `FINDINGS.md` (all 12 signals dead; this is analytics, not a trade).
