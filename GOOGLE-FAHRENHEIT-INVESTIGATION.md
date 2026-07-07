# GOOGLE-FAHRENHEIT-INVESTIGATION — why US °F markets lose in the Google-picks-bucket panel

**Date:** 2026-07-07 · **Status:** READ-ONLY R&D · **Signal:** DORMANT (analytics only — the 12th signal is dead, `FINDINGS.md`).
**Diagnostic:** `scripts/research/google-fahrenheit-diagnostic.ts` (reproducible; `pnpm tsx scripts/research/google-fahrenheit-diagnostic.ts`).
**Scope:** 45 cities / 21-day window / 68 Google-bucketable markets (°F=22, °C=46). Config PINNED to band [0.10, 0.15] (the sweep's baseline, where the anomaly was observed) — NOT the live `GOOGLE_DEFAULTS`, which the operator is editing concurrently.

---

## TL;DR — the verdict

**It is NOT the floor-vs-round rounding bug. The °F loss is genuine Google forecast inaccuracy — a systematic COLD bias plus large scatter.** The `Math.floor` artifact the operator suspected is *real but marginal*, and — the twist — it does **not** rescue °F at all. Swapping floor→round leaves °F bucket accuracy **unchanged at 14%** and flips **1 of 6** realized °F losers (**0 of 3** at the operator's new live 0.12 band). Excluding °F (`excludeFahrenheit: true`, already set) is justified — but on *forecast-quality* grounds, not a fixable code bug.

**Bonus finding (unexpected):** the floor→round swap is a real improvement for the **°C** cohort — bucket accuracy **6% → 23%**, realized **+$13 → +$108**. Round-half-up is the grading-consistent choice; it helps °C and is harmless to °F. That's the one actionable lever here, and it lands on the °C-only strategy that is now the live product path.

| Metric (band [0.10,0.15], 21d) | °F / US | °C / intl |
|---|---|---|
| Bucketable events | 22 | 46 |
| Resolved | 22 | 35 |
| **FLOOR bucket hit-rate** (as-shipped) | **14% (3/22)** | **6% (2/35)** |
| **ROUND bucket hit-rate** (the "fix") | **14% (3/22)** | **23% (8/35)** |
| Δ from round | **0** | **+6** |
| Mean signed offset FLOOR (buckets, >0 ⇒ too cold) | **+1.05** | +1.43 |
| Mean signed offset ROUND | **+0.82** | +1.00 |
| Realized FLOOR: n / wins / net | 6 / 0 / **−$125** | 18 / 8 / +$13 |
| Realized ROUND: n / wins / net | 4 / 1 / −$15 | 15 / 8 / **+$108** |

---

## The mechanism, decomposed

The strategy buys the bucket Google's °C forecast points at (converted to native °F for US cities via `cToF`, then `Math.floor` to a whole degree), cheap at the flat open, and either sells into a re-rate (bid ≥ 30¢) or holds to resolution. The market grades the daily high on the **round-half-up** whole degree.

**1. The floor artifact is real — but small.** Comparing the pick's ladder position to the actual winner's position (in whole buckets):

- **The floor biases the pick ~0.2–0.4 buckets colder than round.** °F: floor offset **+1.05** → round **+0.82** (artifact ≈ 0.23 bucket). °C: floor **+1.43** → round **+1.00** (artifact ≈ 0.43 bucket). So the operator's suspicion — that `Math.floor` on a fractional `cToF` value (31.0°C → 87.8°F → floor 87 → "86-87°F" when the rounded 88°F resolves "88-89°F") systematically picks one bucket too cold — is **confirmed to exist**.
- **But the artifact is dwarfed by the genuine miss.** After de-artifacting (round), Google's pick is *still* **+0.82 buckets too cold** for °F and **+1.00** for °C, with mean |offset| ≈ **1.4 buckets** in both cohorts. Google systematically **under-forecasts the daily high** for these markets. The rounding is ~20–30% of the total miss; genuine forecast error is the other ~70–80%.

**2. Round does NOT help °F — it's a wash.** Of the 22 °F events, floor and round differ on only **5** (for whole-ish °C, `cToF` scatters the fractional part so floor and round usually agree). Of those 5, round **fixes 1** (NYC 68-69→70-71 = winner) and **breaks 1** (Chicago 78-79 correct → 80-81 wrong); the other 3 stay wrong. Net hit-rate change: **0**. °F accuracy is **14% under both**.

**3. Round genuinely helps °C.** Google emits one-decimal °C forecasts that frequently sit at ≥ x.5 (25.6, 15.6, 30.5, 30.6, 12.6, 25.7, …), where floor drops a whole degree and round recovers it. Floor and round differ on **19** of 46 °C events; round nets **+6** correct picks (fixes ~7 — Buenos Aires, Karachi, London, Milan, Panama, Toronto, Wellington — breaks 1, Lucknow). Bucket accuracy **6% → 23%**.

**4. Why °F loses money while °C breaks even.** Both cohorts are cold-biased, yet °C makes money and °F doesn't. The reason is *re-rating, not winning*: nearly all °C wins are **take-profits** (Amsterdam, Buenos Aires, Milan, Munich, Paris, Toronto — an adjacent-to-truth bucket re-rated to 30¢ and we sold), plus one resolution win (Mexico City +$109). **°F produced ZERO take-profits.** Every entered °F market either held to resolution and lost (−$21) or wasn't enterable. Mechanistically: Google picks a too-cold °F bucket; as the hot day is realized the market prices that cold bucket *down* (it's below the actual), so its bid never reaches the 30¢ take-profit — it decays to $0. The entered °F losers are dominated by coastal California marine-layer days (SF ×2, LA) where Google badly under-called the high (63→68, 63→66, 70→74°F) — genuine, large forecast misses.

---

## Secondary hypotheses

- **(2) Genuine Google inaccuracy for US stations — CONFIRMED as the primary cause.** Residual cold bias +0.82 bucket and |offset| 1.4 after removing the rounding artifact; 14% bucket accuracy on an 11-bucket ladder (a decent forecast should hit 30–50%). This is the mechanism.
- **(3) Bucket width — RULED OUT (wrong sign).** °F interior buckets are 2°F ≈ **1.11°C** wide vs °C's 1°C. °F is *wider* in °C-space, so width alone predicts °F should be *easier* to hit — it cannot explain °F underperformance.
- **(4) Direction / clustering.** The bias is consistently **cold** (winner hotter than the pick) for both cohorts. °F realized losses cluster on hard-to-forecast coastal-California hot days.

---

## Confidence — proven vs suggestive

- **PROVEN (config-independent, all 22 bucketable °F events):** round does **not** improve °F bucket accuracy (14% = 14%); the loss is genuine cold-biased forecast error, not the floor artifact. This does not depend on the entry band.
- **SUGGESTIVE (tiny n):** the realized P&L and flip counts rest on 3–9 entered °F markets (6 at the observed band), dominated by the SF/LA cluster. "Round flips 1 of 6" is one NYC event and it *breaks* Chicago's correct floor pick elsewhere; at the live 0.12 band it flips 0 of 3. Treat the exact P&L magnitudes as directional. The °C round-fix (+6 correct, +$95 realized) is on 35 resolved / 19 differing — stronger, but still merits OOS re-validation before shipping. The project's recurring lesson (cross-check backtests against realized forward data) applies: this is a 21-day forward panel, not a large backtest.

---

## Recommendation

1. **Keep `excludeFahrenheit: true`.** The operator's current setting is correct. **Do not** expect a floor→round swap to make °F tradable — it flips at most 1 of 6 °F losers (0 at the live 0.12 band) and does not move °F bucket accuracy. The justification for exclusion is **genuine Google forecast inaccuracy** (systematic cold bias + poor bucket resolution for US airport stations), *not* a rounding bug. The engine comment that frames this as an open "if it proves fixable, revert" question can be closed: **it is not fixable by rounding.**
2. **Consider swapping `googleBucketIdx` from `Math.floor` to round-half-up (`wuRound`) — for the °C cohort's benefit.** This is grading-consistent (the venue rounds; we should too), lifts °C bucket accuracy 6% → 23% and °C realized +$13 → +$108 on this panel, and is harmless to °F. It's a one-line change in `googleBucketIdx`. Validate OOS first (n is small).
3. **Insight, not a trade:** Google's daily-Tmax under-forecasts the high by ~1 bucket (both cohorts). The strategy's premise — Google's bucket is right and will re-rate — is weak (14% °F / 6–23% °C bucket accuracy). A bias-correction (shift up ~1 bucket / center on round-up) would help more than any rounding tweak. Given all 12 signals are dead and this is DORMANT analytics, this is a note for the record, not capital.

---

## Reproduce

```
pnpm tsx scripts/research/google-fahrenheit-diagnostic.ts
```

Prints the per-event floor/round/winner table, °F-vs-°C cohort accuracy + offset decomposition, the realized P&L, the FLIP analysis, and an entry-band sensitivity (0.12 = operator's live ceiling). Config is pinned (band [0.10,0.15]) so results are stable regardless of concurrent edits to `GOOGLE_DEFAULTS`; the script also warns if the engine's `googleBucketIdx` is swapped floor→round under it. READ-ONLY — no writes, no capital, no config change.
