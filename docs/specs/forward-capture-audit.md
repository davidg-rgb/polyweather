# Forward-Capture Data-Spine Audit — Phase 0 (`capture:forward-spine`)

**Lane:** `capture:forward-spine` (WALLET-RECON-HANDOFF.md §7.1 + §9 capture-agent)
**Date:** 2026-06-22 · **Method:** code audit + READ-ONLY prod measurement against
`lenysiqxihsmxljvyybt` (eu-north-1). No writes, no migration applied, no deploy.

---

## VERDICT — EXISTING COVERAGE IS SUFFICIENT. Do NOT build a forward-capture pipeline.

The repo **already** accrues intraday day-before bucket-market price convergence data,
going forward, at a **~30-minute cadence** across the **entire tracked universe**. The
`poll-markets` Edge Function (`*/5 * * * *`, every 5 min, 24/7) writes
`best_bid`/`best_ask`/`mid`/`spread` per bucket into `market_snapshots`, and discovery
lists upcoming markets ~2 days out, so the day-before window is captured densely with no
gap. **Build #3 should read `market_snapshots` directly** (tables/columns below). No new
table, no new Edge Function, no cron change is required.

This **corrects a stale premise in WALLET-RECON-HANDOFF.md** (§7.1 item 1, line ~384, and
§8 checklist item 3, and §9 line ~360 "day-before cadence — cron is twice-daily"): the
handoff's "start the forward-capture cron now" recommendation conflated the *forecast/model*
snapshot cron (`snapshot-forecasts`, twice-daily `15 10,22`) with the **market price-poll
cron** (`poll-markets`, every 5 min). The market-price spine is NOT twice-daily — it polls
every 5 minutes and was already persisting Gamma `bestBid/Ask` on live markets, which is
*exactly* the action item the handoff recommended building ("Gamma `bestBid/Ask` on live
markets → persist"). It predates the handoff and is live in prod today.

---

## What Build #3 should read

Day-before intraday market-price series for a resolved (or upcoming) bucket market:

```sql
-- One bucket's full intraday price series for a target_date's day-before window.
select ms.captured_at, ms.best_bid, ms.best_ask, ms.mid, ms.spread, ms.last_trade
from market_events me
join market_buckets mb on mb.event_id = me.id
join market_snapshots ms on ms.bucket_id = mb.id
where me.slug = $1                       -- e.g. 'highest-temperature-in-atlanta-on-june-21-2026'
  and mb.bucket_idx = $2
  and ms.captured_at >= (me.target_date - 1)::timestamptz   -- UTC day-before approx (see caveat)
  and ms.captured_at <  (me.target_date)::timestamptz
order by ms.captured_at;
```

**Tables / columns (canonical):**

| table | column | meaning |
|---|---|---|
| `market_events` | `id`, `slug`, `target_date` (station-local date), `city_id`, `closed`, `resolved_at`, `winning_bucket_idx`, `ladder_ok`, `unit` | the daily temp market |
| `market_buckets` | `id`, `event_id`, `bucket_idx`, `label`, `low_native`/`high_native`, `condition_id`, `token_yes`, `fee_rate` | one ladder rung |
| `market_snapshots` | `bucket_id` (FK→buckets), `captured_at`, **`best_bid`**, **`best_ask`**, **`mid`**, `spread`, `last_trade`, `book_top3` | the price time-series |

The market-implied distribution per tick is reconstructable from the per-bucket `mid`
across the ladder; the consensus is also pre-computed in `bucket_probabilities`
(`source = 'market_consensus'`) by `poll-markets` step (2), if a ready-made distribution is
preferred over raw mids.

**Day-before window:** the SQL above uses a **UTC** approximation of "the local day before".
The precise local window is `localDayWindow(tz, target_date)` shifted back one local day; it
differs from the UTC cut by ≤14h (the max city UTC offset). For a day-before *efficiency*
study this UTC approximation is fine (it captures the same ~24h of pre-resolution ticks). If
Build #3 wants the exact local day-before, join `cities.tz` and compute the local-midnight
boundaries the same way `core/time.ts → localDayWindow` does.

---

## How the existing pipeline produces this

`supabase/functions/poll-markets/handler.ts`, step (1) "PRICES":

- **Cadence cron:** `poll-markets` = `*/5 * * * *` (every 5 min, 24/7) — `0009_cron.sql`.
- **Day-before tier:** `lead = leadDays(now, target_date, tz)`; `isCandidateTier = lead <= 2
  && acceptingOrders`. The day-before is `lead = 1`, so it is in the candidate tier.
- **Heartbeat:** candidate tier → `HEARTBEAT_CANDIDATE_MS = 30 min`. A snapshot row is
  written for a bucket if EITHER (a) the mid moved ≥ `DELTA_MID = 0.005` (0.5¢) since the
  last capture, OR (b) ≥ 30 min has elapsed since the last capture. So the worst case is one
  row / 30 min / bucket; movement densifies it.
- **Fields:** `best_bid`, `best_ask`, `mid = (bid+ask)/2`, `spread` are written every tick;
  `last_trade` is null on the price pass; `book_top3` is only attached for *bettable
  candidate* buckets that pass the quick screen (≤15 book fetches/cycle), so it is mostly
  null in the day-before window — irrelevant to Build #3, which needs bid/ask/mid.
- **Discovery lead:** `discover-markets` (`10 2,4,5,11,17 * * *`, 5×/day) ingests every
  non-zombie Gamma event from tag 104596 — Polymarket lists daily temp markets ~2 days
  ahead, so the day-before market exists in the DB before its day-before window opens.

---

## Measured prod coverage (2026-06-22, READ-ONLY)

Probe: `scripts/_audit-forward-capture.ts` (throwaway, read-only; safe to delete).

### Discovery lead — upcoming markets ARE in the DB ~2 days out
- Open `ladder_ok` events: **108** (70 future-dated). Max lead = **2 days**.
- Future lead distribution: **44 events at lead=1 (day-before)**, 26 at lead=2, 38 at lead=0.

### Day-before snapshot presence — 100%, no gap
- Resolved `ladder_ok` events, last 30d: **1,302**.
- Events with ≥1 day-before snapshot: **1,302 / 1,302 = 100%**.
- Total day-before snapshot rows (30d): **194,992**.

### Cadence — the headline number (FRESH ≤7-day, full-density tier)
The ≤7-day tier reflects what Build #3 reads going forward, before `ops_downsample`'s >7d
hourly collapse touches it:

| metric (fresh ≤7d day-before window) | value |
|---|---|
| events | 292 |
| buckets | 3,212 |
| **avg captures / bucket / day-before** | **50.7** (median 45) |
| **median gap between captures** | **30.0 min** |
| p90 gap | 35.0 min |

≈ **48–51 intraday price points per bucket per day-before window** — far above the
"≥4 captures/day" bar and the handoff's "1–2 points/day" minimum. The 30.0-min median = the
candidate-tier heartbeat floor; delta-on-move fills between.

### Universe coverage — global, not US-only
Fresh-tier avg captures/bucket/day-before by region (all 12 regions covered ~uniformly):

| region | avg snaps/bucket | region | avg snaps/bucket |
|---|---|---|---|
| africa | 51.2 | na-central | 47.4 |
| east-asia | 53.8 | na-east | 48.2 |
| europe-east | 50.4 | na-west | 47.4 |
| europe-west | 52.9 | oceania | 50.7 |
| latam | 46.0 | south-asia | 46.8 |
| mideast | 50.5 | southeast-asia | 50.5 |

Tracked universe (open): **44 cities, 108 events, 1,188 buckets**.

### Field population (fresh-tier day-before rows)
- `best_ask` present ~95%, `mid` ~90%, `best_bid` ~85% (of 30d rows).
- **null-mid recoverability:** of fresh-tier rows with null `mid`, **0** had both bid+ask
  present (`null_mid_recoverable = 0`, `null_both = 0`). A null `mid` therefore always
  coincides with a **one-sided book** (only a bid OR only an ask quoted) — a real market
  state, not data loss. Build #3 should use `mid` when present and treat a null `mid` as a
  one-sided tick (use the present side, or skip, per the study's needs).

### Poll health
- `poll-markets` runs in last 24h: **288** (= 24h × 12/h). Median inter-run gap **5.0 min**.
  Cron firing exactly on schedule.

---

## One caveat for Build #3: retention downsampling (`ops_downsample`, `0009_cron.sql`)

Day-before snapshots are full-density only while **fresh**. The daily 03:00 UTC retention job
thins `market_snapshots`:

- **> 7 days old** → downsampled to **hourly** (keep earliest per bucket per UTC hour).
- **> 30 days old** → **4/day** (6-hour windows).
- **> 180 days old** → **1/day**.

Implication: a day-before window studied **within 7 days** of resolution retains the full
~30-min cadence (50+ points/bucket); studied **after** 7 days it is hourly (~24 points/bucket
across the day-before, still well above the ≥4/day bar). This is the reason the *naïve* 30-day
median in the first probe pass read low (1 capture/bucket/day for the median event) — the
median was dominated by the long, already-downsampled tail; the fresh tier is the real
forward cadence. **Build #3 has two clean options:**
1. Run the day-before study on a **rolling fresh window** (events resolved in the last ~7d)
   to use the full ~30-min cadence, accumulating coverage over time, OR
2. Accept **hourly** fidelity for older events (≥24 day-before points/bucket) — sufficient
   for a day-before *efficiency* study (not a sub-hour microstructure study).

If a sub-hour study of *older* events is ever needed, the only minimal lever is to relax the
>7-day hourly tier in `ops_downsample` for day-before windows specifically — a one-line
retention tweak, NOT a new pipeline. Not recommended now (storage vs. value); flagged for
completeness.

---

## Optional lever (NOT needed; documented for completeness)

If a future study wants tighter-than-30-min day-before cadence on **fresh** events, the
minimal change is to densify the candidate heartbeat — **no new table, no new function**:

- File: `supabase/functions/poll-markets/handler.ts`, constant
  `HEARTBEAT_CANDIDATE_MS = 30 * 60_000`.
- Current effective cadence: ≤30 min (delta-on-move fills between).
- Proposed (only if needed): `15 * 60_000` (15 min). The poll cron already runs every 5 min,
  so this is purely a heartbeat-floor change; no cron expression changes.
- **Recommendation: leave as-is.** 30 min / ~50 points per day-before window already exceeds
  every stated requirement. Tightening only adds rows (and downsample churn) for no
  measured study benefit.

**No migration 0051 was created.** There is no schema gap to fill: `market_snapshots`
(`0004_markets.sql`) + the `poll-markets` cron (`0009_cron.sql`) are the forward-capture
spine, and they already satisfy the Phase-0 goal.

---

## Files

- This audit: `docs/specs/forward-capture-audit.md` (this file).
- Read-only probe (throwaway): `scripts/_audit-forward-capture.ts` — safe to delete; kept
  for reproducibility. Run `pnpm tsx scripts/_audit-forward-capture.ts` to re-measure.
- No migration, Edge Function, or production change was made by this lane.
