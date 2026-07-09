# MARKET-PNL — "$10/day on our predicted bucket" net P&L

> **Verdict (2026-07-09): break-even to a NET LOSS. You would not have profited.** Staking $10/day on our
> predicted daily-high bucket across all 45 cities, held to resolution, bet ~24h out on the **causal**
> forecast, nets **−1.4% ROI at the mid (−$253) / −5.9% at a 1¢ ask (−$1,032)** over 1,751 bets on 48
> weather-days; the day-clustered 95% CI **[−10.0%, +6.9%]** includes zero and leans negative. The
> tempting **+13.1% / +$2,352** you get from a naive backtest is a **mirage** produced by two things this
> analysis removes: (1) a **look-ahead** forecast (the archive's `pred_c_l1` is calibrated with *latest*
> `model_stats` = hindsight), and (2) **mid-pricing the already-falsified opening-convergence carry**. This
> reconfirms the project's core finding on real prices — the market prices these buckets at least as well
> as we forecast them. **Nothing here reopens the trading rail.**

- **Engines:** `scripts/research/city-accuracy.ts --emit-forecast` (the causal blend μ, source of truth) →
  `scripts/research/pnl-backtest.py` (joins the price archive, does the honest scoring). Reproduce below.
- **Artifacts:** `out/causal-forecast.csv`, `out/pnl-causal-lead1.csv`.

## The question & method

*If we'd put $10/day on our predicted bucket in every city, net profit or loss?* Accuracy is not profit —
you only win money if the bucket resolves for more than you paid. So we join the market **mid** price path
(the 238M-row enriched archive) to a forecast, pick the bucket by **parsing temperature from the label**
(bucket_idx is raw gamma order — trap #7), price it ~24h before resolution, and pay $10 → net
`+10·(1/p − 1)` if it wins, `−10` if it loses. Two forecasts side by side, because the gap *is* the finding:

- **CAUSAL** — the walk-forward blend μ from `city-accuracy.ts`, bias-corrected on **prior data only**. Deployable.
- **ARCHIVE** — the enriched archive's `pred_c_l1`, calibrated with **hindsight** (`model_stats` latest version).

## Results (lead 1, 45 cities, 2026-05-13→06-30, 48 weather-days)

**ROI by bet-timing — the tell is the ramp (win rate is fixed; only the entry price changes):**

| Bet time | CAUSAL ROI (mid) | ARCHIVE ROI (mid) | Market-favorite (control) |
|---|---|---|---|
| 6h before | **−60.5%** | −52.8% | +1.6% |
| 12h | −23.3% | −7.9% | +3.7% |
| **24h** | **−1.4%** | +13.1% | −0.6% |
| 48h | +13.8% | +34.0% | +5.7% |

The monotonic ramp (worst same-day, best far-out) is a **convergence carry, not forecast skill**: the
"profit" comes purely from buying a not-yet-converged bucket cheap and riding it up. A real forecast edge
would show up *strongest near resolution* (6h, when our forecast is most accurate) — instead that's where
it loses most (−60%). The **market-favorite control** carries the same way at 48h (+5.7%), confirming it's
a market pricing artifact. This is **opening-convergence — signal #12 — already KILLED on the live forward
book (−12.6%)**; the convergence-tuning study (708 events) already showed it is a *maker* edge the real
taker spread consumes.

**Look-ahead:** the archive's hindsight calibration inflates win rate **41.4% → 34.9%** and 24h ROI
**+13.1% → −1.4%**. The entire nominal profit is the look-ahead plus the convergence mirage.

**Primary (causal, 24h), clustered on the independent unit:**

| | mid | +1¢ ask |
|---|---|---|
| day-clustered ROI | −1.4% [−10.0%, +6.9%] | −5.9% [−13.8%, +1.9%] |
| city-clustered ROI | −1.4% [−11.4%, +8.5%] | −5.9% [−15.2%, +3.2%] |

Both CIs include zero (and lean negative), on ~48 correlated weather-days. **Not a distinguishable edge;
expected outcome ≈ break-even to a modest loss.** Per-city (`out/pnl-causal-lead1.csv`) is even noisier —
high-*accuracy* cities (Madrid, Munich) don't translate to reliable profit, because the market prices
their predictability into the price.

## Traps ruled out

Executable-ish cost (real ~1¢ top-of-book spread + floor) ✔ · day + city clustering ✔ · offset robustness
✔ · look-ahead removed (causal forecast) ✔ · gamma-order bucket match by label ✔ · market-favorite control ✔.
The one thing this *cannot* fully remove is that the archive price is a **mid, not the executable ask at
depth** — which only makes the real number worse (the convergence-tuning KILL used the real bid/ask book).

## Reproduce

```bash
pnpm tsx scripts/research/city-accuracy.ts --leads 0,1,2 --slot 22Z --emit-forecast scripts/research/out/causal-forecast.csv
python scripts/research/pnl-backtest.py --stake 10 --lead 1     # + --selftest
```

Read-only: reads the local parquet archive + the causal-forecast CSV; writes only `out/`; places no trade.
