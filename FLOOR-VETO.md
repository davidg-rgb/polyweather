# FLOOR-VETO — the intraday running-max entry guard (built + backtested 2026-07-28)

**Verdict: SHIP as a cost-reduction guard (armed at gap ≥3°C / local ≥10h). It is NOT an edge** — the
buy-table lane's candidate pool stays ≈zero-to-negative EV (consistent with `FINDINGS.md`); this guard
trims a robustly-toxic slice of it. Backtest: the vetoed entry class returns **−25.3% per $1**
(n=524; city-day CI [−0.39, −0.11]), **−35.4%** on the out-of-sample test split
(CI [−0.55, −0.16]); **75% of vetoed entries lose**. Morning big-gap entries WIN and are
deliberately spared by the hour cutoff.

---

## 1. Hypothesis (framed 2026-07-28, after the three live entries that day)

The house gaussian does not condition on the intraday METAR running max; the market does
(CITY-ORACLE build 3: the market locks at local 14–18 on ~100% of days, the house distribution locks
2–51%). Therefore a buy-table pick whose bucket LOW sits well above the observed running-max floor
**late in the station-local heating day** marks a state where the model is fighting the thermometer
and the "edge" (house q − ask) is model overconfidence vs an informed book. Claim: vetoing that
entry class has negative mean return, i.e. the veto saves money.

Motivating case (NOT in the backtest window): 07-28 KL 33°C @ 0.15, filled 13:14 local with the
floor at 31°C for 2+ h (house q 0.473, market 0.15; floor data was in our own DB 2 h before the buy).

## 2. Panel — real book, no synthetic anything

Replay source: the **opening-captures archive** (458,359 ticks / 1,150 events after the 07-28
incremental top-up) — the per-tick real order book + houseProb, exactly what the lane's selector
sees. One hypothetical $1 entry per (event × UTC hour) inside the lane's gates
(00–10Z clock, lead 2–12 h, dead-pick bid ≥ 0.02, favorite-veto 0.85, ask = execAsk→bestAsk ≤ 0.50);
pick = argmax houseProb over identity-complete buckets (the 0106 fold / `selectBuyTableCandidates`
idiom). Floor at each tick = `intraday_advances` as of its `created_at` — **what our DB knew at that
moment**, the exact information a production veto would have had. Outcome = pick vs resolved winner.
Return per $1: win → 1/ask − 1, loss → −1.

- **5,856 entries / 839 events / 44 cities / 22 days** (2026-07-05 → 07-27; graded, mismatch excluded).
- shenzhen excluded (WU resolution station ≠ our METAR — floor not resolution-grade there).
- Train = days ≤ 07-16 (2,642 entries) for the threshold sweep; test = 07-17..27 (3,214) frozen.

**Validation.** Selector reproduces the graded ledger's pick **1006/1006 (100%)** on each event's
last pre-resolution capture. Floor-quality probe: 11 panel entries were already floor-IMPOSSIBLE
(bucket high < floor) — **0 of them won** (floor grade is resolution-consistent).

## 3. Sweep (train only) → frozen config

Veto = bucket LOW ≥ G °C above the current floor AND station-local hour ≥ H (integer °C ladders make
G∈{1.5,2} and {0.5,1} degenerate). Selected by most-negative clustered ciHigh of the vetoed class:

**G = 3 °C, H = 10 h** — train vetoed n=275, mean −0.160, CI [−0.361, +0.042] (direction only;
not significant on train alone).

## 4. Results at the frozen config

| Split | vetoed n | vetoed mean/$1 | city-day CI | day-block CI | precision | win rate vetoed vs kept |
|---|---|---|---|---|---|---|
| Train | 275 | −0.160 | [−0.36, +0.04] | [−0.39, +0.26] | 65.5% | 34.6% vs 37.4% |
| **Test (OOS)** | **249** | **−0.354** | **[−0.55, −0.16]** | **[−0.64, −0.02]** | **75.1%** | 24.9% vs 32.5% |
| Full | 524 | −0.253 | [−0.39, −0.11] | [−0.40, +0.01] | 70.0% | 30.0% vs 34.6% |

- The veto touches ~9% of candidate entries → panel-level lift is modest (**+$2.85 saved per $100
  staked** on test); its value is concentrated exactly where the lane bleeds.
- **Current-allowlist cities only** (KL/madrid/singapore/wellington, n=231): vetoed n=33, mean
  **−0.515**, CI [−0.98, −0.05]; the kept remainder runs +0.065.
- **Current-config lane replay** (caps 0.28/0.40/0.35/0.40, $5 stakes, first eligible tick,
  07-05..27): 38 entries, baseline +$11.36 → veto blocks 2 (both losses) → **+$21.36 (+$10.00 saved)**.
- **Actual live fills** (17 to date): of the 14 resolved, the veto blocks exactly one —
  helsinki 07-23 19°C (gap 4.0 °C @ 11.7 h local, lost) — **+$4.88 saved, no winner blocked**.
- The hour cutoff is load-bearing: morning big-gap entries (e.g. KL 07-19 32°C, gap 6 @ 08:06 local,
  WON +$19.90) pass untouched. Same-gap-any-hour variants scored ≈0 on train.

**Honest limits.** (a) The frozen 3°C veto does **NOT** catch the motivating 07-28 KL buy (gap was
exactly 2°C). The tighter **G=2, H=12** variant would — its test split is strongly negative
(n=136, −0.477, CI [−0.72, −0.23], win 17.6%) but its train split showed nothing
(−0.016, CI [−0.39, +0.35]), so it was not selectable by the pre-registered sweep. It is an
**operator option** (`buy_table.floor_veto_gap_c = 2`, `floor_veto_min_local_hour = 12`), not the
default; the running lane will adjudicate it forward. (b) Per-city effects vary (chongqing/paris
vetoed entries win 57–63% — late-advancing climates); per the MODEL-TRIM lesson, no city gating —
it widens the clustered CI for a point-estimate mirage. (c) °F cities carry the known ~1–2%
stored-truth divergence; the °C-space gap makes the veto conservative there (3°C ≈ 5.4°F).

## 5. Traps ruled out (references/traps.md)

Real book only (execAsk, the lane's own capture stream) · costs = the crossed ask itself
(hold-to-resolution, no exit leg) · city-day clustering + day-block sensitivity · train/test date
split with the config frozen on train · motivating examples excluded from the panel by construction ·
selector validated against the production fold · floor look-ahead impossible (floors keyed by DB
write time) · floor-grade validated (0 impossible-bucket wins).

## 6. What shipped (merged-dark; arming is the operator's click)

- **`supabase/functions/buy-table-tick/handler.ts`** — `floor_veto` skip inside the existing 0111
  floor-gate block: fires when `pick.low − floor ≥ buy_table.floor_veto_gap_c` (°C, unit-converted)
  AND `stationLocalHour(now, tzName) ≥ buy_table.floor_veto_min_local_hour`. Fails OPEN on missing
  floor/tz/label (the 0111 posture). Code default gap 0 = **OFF** — the merged fn is inert until seeded.
- **`supabase/migrations/0121_buy_table_floor_veto.sql`** — seeds `3` / `10`. **Applying = arming**
  (the 0115 precedent).
- Tests: 7 new handler cases (°C fire/boundary, hour-spare, °F conversion, bottom-tail, default-off,
  fail-open) — suite 212 files / 3,593 green, typecheck clean.
- Research artifacts: `scripts/research/floor-veto-pull.ts`, `scripts/research/floor-veto-backtest.py`
  → `scripts/research/out/floor-veto/{panel.csv,RESULT.json}` (gitignored).

**Operator go-live (deploy law: fn first, migration second):**
1. `supabase functions deploy buy-table-tick` — inert (keys absent → veto off);
2. apply `0121` — the veto arms at 3°C/10h on the next tick. Skips surface in the tick logs as
   `buy-table.skip` with a `floor_veto (…)` reason; `floorVetoGapC` is in every tick's job stats.

## 7. Carry-forward

- The 2°C/12h tightening: re-adjudicate on forward lane data once ~2 weeks of armed-veto ticks exist.
- The deeper fix stays open and is NOT this guard: the house gaussian itself could floor-condition
  (truncate mass below the running max and renormalize) — that changes every downstream consumer and
  needs its own backtest before anyone touches `bucket_probabilities`.
