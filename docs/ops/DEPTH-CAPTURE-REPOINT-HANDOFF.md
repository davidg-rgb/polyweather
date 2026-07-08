> **⚠ SUPERSEDED 2026-07-08 — v1 FAILED live (write times out → 0 rows) and a 5-agent review found 12 confirmed
> issues. The full redesign is `DEPTH-CAPTURE-V2-HANDOFF.md` (execute that, not this). The `depth-capture` cron is
> PAUSED; `0087` is applied (to be superseded); `0088` is unapplied; the panel runs on the revived `opening_captures`.
> This doc is kept for the v1 context only.**

# Depth-capture + Google-panel repoint — operator handoff (v1, superseded)

**Built 2026-07-08.** Moves the /convergence **Google panel** off the flaky `opening_captures` table and onto
the durable `market_snapshots` continuous store — *without* the +5.85¢ top-of-book optimism, by capturing true
executable depth in an isolated, money-path-safe job. Nothing here is deployed yet; Claude never deploys/keys.

## Context (what happened)

- The `opening_captures` **writer had been silently unscheduled for ~38h** (its cron was dropped in the 2026-07-07
  reclaim and never re-armed) → the Google/convergence/maker-exit panels were rendering off frozen data.
- **FIXED live this session (interim):** re-armed `opening-capture` (`*/5`, jobid 32) + `opening-capture-deadman`
  (`*/10`, jobid 33) and fired one immediate capture (73 rows @ 08:42 UTC). Panels are live again.
- `opening-capture` **stays running permanently** — the convergence + maker-exit siblings still read
  `opening_captures` for `houseProb` (the house_gaussian seed). Only the **Google panel** repoints.

## Feasibility verdict (measured, why the depth job is necessary)

| Question | Result |
|---|---|
| Does `market_snapshots` sample the first hour of listing? | ✅ 98.9% within 1h, ~7 min avg; 10× more events than `opening_captures` |
| Reconstruct `resolvesAt`? | ✅ uniform venue rule — `target_date` **12:00 UTC** |
| Reconstruct depth-walked `execAsk/execBid`? | 🔴 no — `book_top3` is only filled for edge-candidate buckets; the longshots we buy carry only top-of-book, and best_ask vs execAsk diverges **+5.85¢** at the entry band → the depth-capture job fills this gap |

## What was built (all tested — suite 2958 green, typecheck clean)

- **Migration `0087_depth_capture.sql`** — `market_snapshots.depth jsonb` (+ partial index), `record_depth_captures`
  (write), `depth_capture_targets` (read), and the `depth-capture` `*/5` cron. **Nothing reads `depth` yet** —
  applying 0087 is harmless (staged cutover).
- **Edge fn `supabase/functions/depth-capture/`** — DB-read-driven (no Gamma re-poll), walks the true CLOB depth of
  near-dated live `'highest'` buckets, writes computed `{execAsk, execBid, depthUsd, sellbackDepthUsd, bestBid,
  sellbackUsd}` into `market_snapshots.depth`. Bounded concurrency (8 in flight); best-effort. **poll-markets
  untouched.** Registered in `config.toml`.
- **Migration `0088_google_paper_repoint.sql`** — THE cutover: `google_paper_inputs` rewritten to read
  `market_snapshots.depth`. Handler unchanged. `create or replace` → reverting = re-apply 0086's body.

## Deploy sequence (staged — each step reversible)

0. **`0087` is APPLIED (2026-07-08, via MCP)** — `depth` column + both RPCs + the `depth-capture` `*/5` cron are
   live; `depth_capture_targets` returns ~73 events / 45 cities. The cron is currently 404ing every 5 min because
   the edge fn is not deployed yet (harmless). **⚠ `db push` caveat:** both `0087` and `0088` are committed migration
   files; a blanket `supabase db push` would apply `0088` (the repoint) prematurely. Apply `0088` explicitly/targeted
   when ready — do NOT rely on `db push` for the staged cutover.
1. **Deploy the `depth-capture` edge fn** (the only remaining stage-1 step — a CLI op; MCP can't bundle the monorepo
   imports):
   ```bash
   supabase functions deploy depth-capture --project-ref lenysiqxihsmxljvyybt
   ```
   Then verify within ~10 min (the cron stops 404ing and depth lands):
   ```sql
   select count(*), max(captured_at) from market_snapshots where depth is not null;
   ```
   Expect a growing count, freshest `captured_at` within ~5 min.
2. **Let `depth` accrue ≥ ~1 day** so fresh events + at least one resolution exist across several cities.
3. **Parity check** — the would-be repointed inputs vs the current path, for a couple of cities:
   ```sql
   -- fresh-event coverage the repointed RPC would see (should be in the same ballpark as the live panel's nFreshEvents)
   select count(distinct mb.event_id)
   from market_snapshots ms
   join market_buckets mb on mb.id = ms.bucket_id
   join market_events   me on me.id = mb.event_id
   join cities c on c.id = me.city_id
   where ms.depth is not null and ms.captured_at > now() - interval '21 days'
     and me.kind='highest' and me.first_seen is not null
   group by 1 having min(extract(epoch from (ms.captured_at - me.first_seen))/3600.0) < 1;
   ```
   Sanity: execAsk present + in [0,1] on the depth rows; fresh-event count is not near-zero.
4. **Apply `0088`.** The panel now reads `market_snapshots.depth`. Watch the next `google-paper-panel` snapshot —
   `nFreshEvents/nGoogleEvents` should be non-trivial and the gate should progress as depth accrues. **History
   resets** at cutover (the panel re-accrues from the new source) — expected and fine; the prior +$163/5-entry
   number was never a signal (gate was INSUFFICIENT_DATA).
5. **Monitor Micro** after step 1 — two `*/5` capture jobs now run (`opening-capture` + `depth-capture`). The
   2026-07-06 saturation was at `opening-capture` `*/2` and has resolved, but if per-tick latency climbs, back off
   `depth-capture` (raise its cron interval, or lower `depth_capture_targets` `p_limit`).

## Rollback

- Before 0088: nothing to roll back (0087 is additive; the fn is read-only).
- After 0088: re-apply the `google_paper_inputs` body from `0086_google_paper.sql` (reverts the source to
  `opening_captures`).

## NOT changed

poll-markets (money engine), the convergence + maker-exit panels, the trading rail (DORMANT), any capital path.
