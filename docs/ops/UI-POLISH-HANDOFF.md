# UI-POLISH-HANDOFF — /trading friction fixes + the CITIES PREDICTION TABLE

> Operator-requested 2026-07-17 (in-session, right after the override-activation troubleshoot):
> *"Prepare handoff for the UI polish splash — I further want a clean visible table of all available
> cities, our prediction for each active day along with our historic success rate per city, active day
> and time to close. Easy to read and understand."*
>
> Two workstreams. Both are READ-ONLY dashboard work — the §15 boundary (wallet key + clob client stay
> inside `packages/trading`) is untouched; no new write paths to the trading rail. Standing laws that
> bite here: **verify every new RPC's latency under the CALLING role's 8s statement_timeout** (the
> 0098/0101 lesson — a fast-as-postgres check is a false pass), and any heavy per-row work belongs in a
> write-time fold or an indexed read, never an on-request scan of the big tables.

---

## WS-A — /trading override-panel + console polish

**Why (diagnosed 2026-07-17, C42→C43):** the operator was ON `/trading` (Vercel hits 16:16Z) trying to
set the gate override across FOUR separate asks over two days — and the gate-override API showed **zero
hits ever**. The flow silently defeated him:

1. `GateOverridePanel` (`apps/web/src/components/trading-controls.tsx:355`): the **"set override"
   button renders disabled** until BOTH the reason text AND the date input are non-empty (`ready`,
   line ~373) — an untouched panel just looks like a dead grey button. No hint says why.
2. Clicking "set override" doesn't set anything — it opens a **second "Confirm override" banner** that
   renders ABOVE the form (line ~411) — off-screen on mobile; the flow dies unnoticed.
3. Success state is only a transient action message — no strong ACTIVE badge flip.

**Required fixes (acceptance criteria):**
- [ ] Pre-fill the expiry date input with today+14d (the DB cap) so the panel is one-field-from-ready;
      keep the RAISE as the hard cap.
- [ ] Replace the silent disabled state: show an inline hint under the button while `!ready`
      ("fill reason + expiry to enable"), or enable the button and validate on click with visible errors.
- [ ] Render the confirm step BELOW the trigger button (or as a centered modal) so it is visible where
      the user just clicked — especially on mobile viewports (test at 390px).
- [ ] On success: the panel header's "Currently: none/ACTIVE" line must flip to ACTIVE immediately
      (optimistic or refetch), with the expiry shown.
- [ ] When the interlock is the ONLY failing preflight check, surface a primary call-to-action in the
      `VerdictBanner` at the top of /trading ("1 click from armed → set the gate override") that
      scrolls/links to the panel. The operator should never have to diagnose which section matters.
- [ ] Mobile pass over the whole /trading page: section order, sticky verdict, tap targets.
- Files: `apps/web/src/app/(dash)/trading/page.tsx` (~line 767–781), `trading-controls.tsx:355–470`.
- Tests: extend the existing route/render tests (C14 added GateOverridePanel render assertions);
  add: disabled-state hint renders, confirm step position, ACTIVE flip after a 200.

## WS-B — the CITIES PREDICTION TABLE (new headline analytics surface)

**What the operator wants (verbatim requirements):** one clean table, all available cities, showing per
ACTIVE market (city × target day):
1. **Our prediction** for that day,
2. **Historic success rate for that city**,
3. **Active day** (the target date),
4. **Time to close**,
easy to read and understand.

**Data contract (one row per OPEN city-day market):**
| column | source | notes |
|---|---|---|
| City | `opening_captures` latest row per event (`city`, display via `cities.display_name`) | all 45-city capture universe; cities with no open market simply have no rows (or render a "no market" muted row — builder's call, lean toward showing all 45 so "all available cities" is literal) |
| Active day | `target_date` (station-local) | group/sort key |
| Our prediction | the argmax-`houseProb` bucket of the latest capture's ladder — its `label` (e.g. "31°C", "88–89°F") | EXACTLY the buy-table selector's pick (`selectBuyTableCandidates` idiom: argmax houseProb, identity-required) so the table never disagrees with what the live lane would buy. Show the bucket label, optionally the house probability % |
| Market ask | the predicted bucket's `execAsk` (fallback `bestAsk`) | context: what the market charges for our pick right now |
| Time to close | `resolves_at` − now, rendered as "5.7h" / "29.7h" | sort ascending by default — actionable first; highlight rows inside the live lane's [2,12]h window |
| Historic success rate | per-city % of GRADED days where our predicted bucket == the resolved winner + the n it's based on | see the definition below — the number must be pinned and honest |

**Success-rate definition (pin this, don't improvise):** per city, over ALL graded events in
`opening_captures`⋈`market_events` since the capture stream began (2026-06-27): take each event's
LAST pre-resolution capture, compute the argmax-houseProb bucket, compare to the resolved winner
(`coalesce(poly_resolved_winner_idx, winning_bucket_idx)`), exclude `grading_mismatch`. Render as
"62% (n=18)" — ALWAYS with n; grey out below n=8 (small-n honesty, the shrinkage lesson from the
entry-watch). Do NOT reuse the C25 backtest asset (different frame: fillability-filtered $10 bets);
this is pure prediction-vs-winner accuracy. Cross-check one city by hand against `/data`'s per-station
numbers during build — they answer a related but different question (°C-accuracy vs bucket-win), so
they won't match exactly; document the difference in the page's footnote.

**Serving path (the perf law applies):**
- New migration `010X_dash_city_predictions.sql`: ONE security-definer RPC `dash_city_predictions()`
  returning `{generatedAt, rows:[…]}` — operator-guarded like the other dash RPCs (`authenticated` +
  `operator_guard()` if it exposes nothing sensitive → plain authenticated is fine; match `dash_data`'s
  posture).
- The success-rate half is a scan of ALL graded events (~2 months × 45 cities ≈ a few thousand events,
  each needing its last capture + argmax over the ladder jsonb) — **too heavy for on-request**. Either:
  (a) fold it into a small `city_prediction_stats` table maintained by a daily/hourly job (the 0100
  trigger-fold precedent), or (b) compute it inside the RPC but from a materialized/cached snapshot
  refreshed by an existing cron. (a) is the project idiom. The OPEN-markets half (predictions/ask/
  time-to-close) is cheap: latest capture per open event via `oc_event_captured_idx`.
- **Verify the RPC under the `authenticated` role's timeout before shipping the page** (0099 lesson).
- PGlite tests for the migration + the RPC envelope; loader/render tests for the page.

**Page placement & UX:**
- Recommended: a new top-level page `/cities` in the dash nav (the ask is a HEADLINE surface — don't
  bury it inside /paper-trade, which already has its own per-city backtest table with a different
  frame). Reuse the Terminal-Glass bento idiom.
- Default sort: time-to-close ascending; secondary group by active day. Filters: day tabs (today /
  tomorrow / +2), "in buy window" toggle. Success-rate cell gets a subtle green→red scale WITH the
  n visible; prediction cell shows bucket label + house prob %.
- Mobile: the table must collapse to cards or horizontal-scroll cleanly (46 rows × 6 cols).
- Read `dataviz` skill guidance if adding any sparkline/heat elements; keep v1 a plain excellent table.

**Explicitly out of scope:** anything that writes to the trading rail; changing the buy-table
selector; new Slack anything (global halt stands).

## Build order & size

1. WS-B data layer (stats fold + RPC + migration + tests) — the long pole, ~half day.
2. WS-B page + tests — ~half day.
3. WS-A panel fixes + tests — ~2–3h.
4. Browser sweep (desktop + 390px), suite + typecheck green, PR to main (reconcile the loop branch
   after the squash — the #23 lesson).

## Context a fresh session needs

- Live lane state at handoff: override ACTIVE (id=2, exp 07-31), first live buy expected after
  00:00Z 07-18 (board C43); loop paused; Slack dark (C16).
- Board: `docs/ops/EDGE-WATCH-LOOP.md`. Buy-table selector: `supabase/functions/buy-table-tick/
  handler.ts` (`selectBuyTableCandidates`). Capture shape: `packages/core/src/sim/
  opening-bracket-ingest.ts`. Dash RPC idiom: `dash_data` (0065), `dash_google_paper` (0086).
- `opening_captures.event_id` is **uuid** (cast to ::text when comparing to text[] — the 0104 lesson);
  jsonb params through the DbPort can arrive double-encoded (the 0105 lesson — unwrap or exercise the
  real call shape in tests).
