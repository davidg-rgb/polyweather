# GOOGLE-CITY-PNL — per-city net P&L of the Google-picks-bucket paper lane (2026-07-27)

**Operator question:** deep-diving the Google paper-trade setup — are there any cities showing a net profit over time?

**Answer: nominally yes — a small European-city cluster prints positive — but nothing that survives the
skeptical checklist yet, and the strategy as a whole is a loser. The panel TOTAL over the full record is
−$431 realized on 115 entries (win 33.6%, day-clustered CI [−55.8%, +3.6%]). No config change, no capital
implication; the flagged cities earn a pre-registered forward watch on the already-running panel, nothing more.**

## The run

`scripts/research/google-city-pnl.ts` — replays the exact g2 engine (`replayGoogleBracket`, band
[0.10, 0.15] · TP 0.30 · no SL · °C-only · ≤24h entry age · ≥20h to resolution · dead-pick 0.02 /
favorite-veto 0.85 · $20/position, taker fees + slippage) over the **full record**: the DB hot window
(461 events) + both opening-captures archives (+988 events) = **2026-07-01 → 07-29, 115 entries / 107
realized / 24 days / 23 °C cities**. Google's pick is resolved **as-of entry eligibility** (latest
`source_forecasts` google row captured ≤ listing + 24h) — one no-look-ahead rule across both eras, unlike
the live panel's "latest row at tick time". Artifacts: `scripts/research/out/google-city-pnl.json` +
`google-city-pnl-ledger.csv`.

## Per-city (ranked by realized net; halves split at 07-16)

| city | n real | exit mix tp/rw/rl | netReal | win | day-CI | halfA/halfB |
|---|---|---|---|---|---|---|
| warsaw | 2 | 2/0/0 | **+$98** | 100% | [−58%, +546%] | +98 / 0 |
| milan | 4 | 4/0/0 | **+$89** | 100% | [+96%, +127%] | +89 / 0 |
| lucknow | 2 | 2/0/0 | **+$85** | 100% | [+100%, +325%] | +85 / 0 |
| ankara | 6 | 4/0/2 | +$66 | 67% | [−46%, +156%] | −21 / +87 |
| paris | 3 | 3/0/0 | **+$59** | 100% | [+89%, +107%] | +37 / +21 |
| cape-town | 2 | 2/0/0 | **+$57** | 100% | [+106%, +176%] | +25 / +32 |
| london | 2 | 2/0/0 | **+$44** | 100% | [+95%, +126%] | +21 / +24 |
| … 3 small positives (munich +29, singapore +20, toronto +18), KL ≈ 0 … | | | | | | |
| madrid | 8 | 2/0/6 | −$76 | 25% | [−121%, +27%] | −32 / −43 |
| mexico-city | 10 | 0/1/9 | −$79 | 10% | | +4 / −83 |
| jeddah | 8 | 1/0/7 | −$107 | 13% | | −21 / −86 |
| wellington | 9 | 1/0/8 | −$142 | 11% | [−129%, −30%] | −83 / −59 |
| sao-paulo | 11 | 1/0/10 | −$184 | 9% | [−124%, −43%] | −125 / −59 |
| taipei | 10 | 0/0/10 | −$209 | 0% | [−104%, −104%] | −83 / −125 |

## Why the positives don't clear the bar (yet)

1. **n = 2–4 per flagged city.** Five cities flag day-clustered ciLow > 0 (milan, lucknow, paris,
   cape-town, london) against ≈1.2 expected false flags across 23 cities — more than chance, but the CIs
   are z-based on 2–4 day clusters and **conditioned on all-TP streaks**: a sample with zero observed
   losses has deceptively tight spread. One resolution loss (−104%) craters a 3-trade mean.
2. **In-sample config.** Every g2 lever (°C-only, band, ≤24h age, TP 0.30, the guards) was tuned on
   overlapping July data — this table is a winner's-curse upper bound by construction (§traps 6).
3. **All profit is convergence sells, not wins.** **1 resolution win in 107 realized** (mexico-city).
   Google's pick almost never wins the market; the profitable cities are where the market later *came
   around* to Google's number and the TP sold into it. This is signal #12's shape per-city — and #12
   died at executable spread for our *better* forecast. The payoff asymmetry at 10–15¢ entries (≈+110%
   per TP vs −104% per hold-death) is what makes small convergence-rate differences swing the sign.
4. **The entry itself is adverse selection.** A cheap (≤15¢) Google pick exists only when the market
   *disagrees* with Google. Milan/warsaw/lucknow produced **zero entries after 07-15** with the Google
   feed fully intact (292+ H2 rows each) — the market stopped offering the disagreement. The signal, if
   real, is self-extinguishing.
5. **Mechanistic plausibility is real but cuts both ways.** The bimodal table tracks Google's known
   per-city forecast quality (good European/temperate, bad tropics + the °F cold-bias record —
   `GOOGLE-FAHRENHEIT-INVESTIGATION.md`). Heterogeneity is believable; *profitable-after-costs* in
   specific cities is the claim that needs forward data.

## What it earns

The already-running `google-paper-panel` keeps accruing exactly this strategy forward. The flagged
six (milan, paris, london, cape-town, warsaw, lucknow) are hereby the **pre-registered** city set —
adjudicate them on FORWARD entries only (post-2026-07-27), §9R-E day-clustered, no re-selection. No
capital, no live-lane change (the buy-table lane is a different strategy — madrid is 81–100% there and
−$76 here). Do not re-tune the config on this table; that would be trap #6 again.
