# DATA.md — the `/data` forecast-accuracy-by-market page

The analytics product's **measurement surface**: across all ~46 global airport stations, how accurate is our
calibrated forecast — at day-of, day-before and two-days-out — which **markets** do we forecast best and worst,
and how does our skill stack against the market it is priced against? Built 2026-06-26 (operator ask: "identify
the markets with the highest accuracy and the lowest"). Read-only analytics; the trading rail stays **DORMANT**.

Live (operator-gated, behind the `(dash)` login): `weather-edge-two.vercel.app/data`.

---

## What "accuracy" means here

The champion (`house_gaussian`) **point prediction** = its single most-likely whole-°C bucket (the **argmax** of
the probability vector) vs the **resolved** daily high (`market_events.winning_bucket_idx`). Two intuitive,
unit-agnostic lenses (1 bucket = 1 degree in that market's native unit — °C abroad, °F in the US):

- **Exact** — argmax == winner (nailed the degree).
- **Within 1°** — |argmax − winner| ≤ 1 (mode within one bucket).
- **Mean miss** — average |argmax − winner| in whole degrees (the **stable ranker** on a short sample).

The market's own call (`market_consensus`, the freshest snapshot at that lead) is scored on the **same matched
events**, so every head-to-head is honest. We report the champion (`house_gaussian`) deliberately: the EMOS
`house_ensemble` is a calibrated-but-vague mixture whose *mode* is a poor point predictor (it is an unpromoted
challenger), so its argmax accuracy is not what the product uses.

> **Why a point/mode lens and not just Brier?** Brier (the gate's proper score) lives on `/calibration` and
> `/efficiency`. This page answers the operator's plain-language question — "how often are we right, and where?"
> — which is a hit-rate question. The Brier gap is shown too (below), and tells the same story.

## The three sections (and what they found)

1. **Accuracy by horizon** (`byLead`) — pooled over all markets, our model vs the market at leads 0/1/2.
   Exact-hit holds flat (~35–36%) while the distribution widens with lead (mean miss 0.78° → 0.94° → 1.06°) —
   the real skill decay. **Day-of is mixed — we lead on within-1°, the market on exact and mean-miss — and from
   one day out the market is clearly sharper on every measure, its lead widening the further out you forecast**
   (within-1°: ~tied day-of, but 70% vs 82% two-days-out). This is the efficiency verdict in plain accuracy terms. Day-of (lead 0) is the least clean comparison: the market's
   day-of figure is its freshest same-day quote and can embed an already-observed running max, while our
   distribution is fixed at the NWP cutoff — so the head-to-head is strictest at leads 1–2.
2. **Best & worst markets** (`byStation`, day-before / lead 1) — ranked by mean miss. **The ranking tracks
   meteorology, not noise**: the sharpest markets are stable maritime/temperate regimes (Madrid, Munich, London,
   Warsaw, Miami; low-variance equatorial like Singapore/Wellington hit ~100% within-1° but low exact because the
   high hugs a bucket boundary); the hardest are physically jumpy climates — afternoon convection (Shenzhen, KL,
   Chengdu), frontal passages (Beijing, Dallas), desert/sea-breeze extremes (Jeddah, the single worst within-1°).
   A mean-miss "skyline" bar chart shows every market sorted best→worst.
3. **Forecast-vs-market Brier gap over time** (`brierSeries`, daily, lead 1) — our daily Brier sits persistently
   a few points **above** the market's, **with no convergence** — orthogonal confirmation of efficiency in a
   proper score rather than a hit rate.

## How far back the data goes (provenance)

The **outcome** record is long but the **forecast-vs-outcome** record — the only thing skill can be measured
against — is a ~3-month book, only ~2 weeks of it from live capture (measured 2026-06-26):

| Dataset | Since | Span | Note |
|---|---|---|---|
| Observed highs (truth) | 2024-01-21 | ~29 mo | 45 stations — but no matching forecast before Mar 2026 |
| Raw NWP forecasts captured | 2026-03-28 | ~3 mo | backfilled archive to late Mar; live twice-daily since Jun 13 |
| Forecast ↔ outcome pairs | 2026-03-28 | ~3 mo | ~250k pairs, 45 stations — the real skill record |
| Bucket distributions (this page) | 2026-06-13 | ~2 wk | the house probability vectors these accuracy numbers score (rendered live from the scored window) |

The docs' "28.8 months" figure is **observation** depth, not forecast skill. Calibration itself runs on a
**30-day rolling window** (`model_stats.window_days = 30`), so the live model conditions on ~1 month of recent
error per station-model-lead — the deep outcome archive trains nothing directly. **Treat all numbers as
indicative** — a short, summery sample (per-station ranks rest on ~10 day-before observations each).

## Build (as-shipped)

- **Migration `0065_data_accuracy_dashboard.sql`** — `dash_data(p_lead smallint default 1)` → one jsonb OBJECT
  (`meta` / `byLead` / `byStation` / `brierSeries`). `security definer`, `operator_guard()`, `set
  statement_timeout = '60s'`, grant to `authenticated`/`service_role` (the operator's logged-in session passes
  the guard). argmax in SQL via `unnest(probs) with ordinality` (i-1 = 0-based, matching `winning_bucket_idx`);
  `market_consensus` deduped to the latest snapshot per (event, lead). No table, no cron (count stays 21).
- **Web**: `apps/web/src/app/(dash)/data/page.tsx` (Terminal-Glass bento), loader `getDataAccuracy`
  (`lib/loaders.ts`), new `components/LineChart.tsx` (generic two-series line, data-scaled y — for the Brier
  gap) + reused `BarChart.tsx` (the mean-miss skyline), nav link `['/data', 'accuracy']`.
- **Tests**: `apps/web/test/data-page.render.test.ts` (populated + graceful-empty); `migrations.test.ts`
  updated (file list + `dash_data` ∈ `WEB_AUTHENTICATED`). Full suite green (1495), typecheck 0, web build OK.
- **Deploy**: `0065` applied to prod via Supabase MCP; the page ships on the next `main` → Vercel deploy.

## Extending it

- The per-station lead is the `p_lead` param (default 1 = day-before); call `dash_data(0)` / `dash_data(2)` for
  the other horizons. The page currently fixes lead 1; a horizon toggle is a purely additive UI change.
- As live 10Z/22Z capture accrues, the per-station n grows and the ranks firm up — re-eyeball best/worst monthly.
- A natural follow-up: a per-station **MAE in native degrees** (not just bucket miss) once we expose `mu_native`
  vs the decimal observed high in the RPC.
