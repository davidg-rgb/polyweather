# Winners-board best entry hour — the realized-paper answer (4 cities)

> **Written 2026-07-07 (C101), operator-directed.** "Establish the best betting hour per city from predictive
> accuracy + avg buy price; run all board cities as $10 paper trades at that hour." This is the decision of
> record. It **corrects** the same-session `KARACHI-ENTRY-HOUR.md` conclusion (which used a flat accuracy and
> pointed at cheap early hours — wrong; see below). Boundary intact: paper only, no capital/keys.

## The headline the operator needs

**There is no "low price + high accuracy" hour.** Price and accuracy rise *together* through the day, because
the strategy bets the **running-max floor** (the day's high once it's observed), not a fixed forecast. Early, the
floor isn't in yet → the bet is a forecast guess (~36–50% right) and the ask is cheap (~40–55¢). Late, the floor
is locked → the bet is near-certain (~85–96% right) and the ask is expensive (~80–98¢). The best NET is the
**first hour after the floor locks where accuracy has jumped but the price hasn't fully caught up** — i.e. just
after each city's `forecast_max_hour`.

**Best/least-bad hour (realized forward paper P&L, ~22–25 real bets/hour since 06-29):**

| city | tz | forecast_max_hour | **best hour** | win rate | avg ask | realized P&L/bet | realized net |
|:--|:--|--:|:--:|--:|--:|--:|--:|
| **Karachi** | Asia/Karachi | 12 | **14:00** (13:00 ties) | 96% | 90¢ | **+$0.99** | +$23.76 |
| **Houston** | America/Chicago | 14 | **15:00** | 95% | 87¢ | **+$1.56** | +$34.40 |
| **Singapore** | Asia/Singapore | 12 | **15:00** (14:00 close) | 95% | 86¢ | **+$2.20** | +$46.11 |
| **Ankara** | Europe/Istanbul | 14 | **16:00** | 79% | 79¢ | **+$0.48** | +$11.50 |

These **validate the board's `recommendedHour`** (Karachi 14 / Houston 15 / Singapore 15 / Ankara 16).

## Full realized per-hour ledger (accuracy vs price, done right)

`EV/$1 = win_rate / avg_ask − 1`. The cheap early hours are NEGATIVE; the edge is the first floor-locked hour.

**Karachi** (arms 10–15; floor from 13):
| hr | n | win | avg ask | EV/$1 | realized P&L/bet |
|--:|--:|--:|--:|--:|--:|
| 10 | 23 | 39% | 45.7¢ | −0.15 | −$0.51 |
| 11 | 22 | 36% | 44.4¢ | −0.18 | −$1.35 |
| 12 | 22 | 59% | 55.5¢ | +0.06 | +$0.51 |
| **13** | 23 | 83% | 75.2¢ | **+0.10** | **+$0.99** |
| **14** | 24 | 96% | 89.6¢ | +0.07 | **+$0.99** |
| 15 | 23 | 96% | 98.0¢ | −0.02 | −$0.27 |

**Houston** (arms 11–16; floor from 15):
| hr | n | win | avg ask | EV/$1 | realized P&L/bet |
|--:|--:|--:|--:|--:|--:|
| 11 | 23 | 39% | 53.7¢ | −0.27 | −$2.56 |
| 12 | 23 | 48% | 55.8¢ | −0.14 | −$2.28 |
| 13 | 23 | 52% | 55.3¢ | −0.06 | −$2.00 |
| 14 | 22 | 68% | 67.4¢ | +0.01 | −$0.59 |
| **15** | 22 | 95% | 86.8¢ | **+0.10** | **+$1.56** |
| 16 | 21 | 95% | 94.8¢ | +0.00 | −$0.04 |

**Singapore** (arms 10–15; floor from 13):
| hr | n | win | avg ask | EV/$1 | realized P&L/bet |
|--:|--:|--:|--:|--:|--:|
| 10 | 22 | 36% | 40.7¢ | −0.11 | −$2.28 |
| 11 | 22 | 36% | 39.2¢ | −0.07 | −$1.99 |
| 12 | 22 | 45% | 46.6¢ | −0.03 | −$1.63 |
| 13 | 22 | 50% | 60.3¢ | −0.17 | −$0.60 |
| 14 | 21 | 86% | 78.4¢ | +0.09 | +$1.57 |
| **15** | 21 | 95% | 86.2¢ | **+0.10** | **+$2.20** |

**Ankara** (arms 11–16; floor from 15) — the weakest, ~breakeven at best:
| hr | n | win | avg ask | EV/$1 | realized P&L/bet |
|--:|--:|--:|--:|--:|--:|
| 11 | 23 | 48% | 48.2¢ | −0.01 | −$0.30 |
| 12 | 24 | 46% | 48.2¢ | −0.05 | −$0.54 |
| 13 | 24 | 46% | 50.8¢ | −0.10 | −$0.64 |
| 14 | 23 | 48% | 58.1¢ | −0.18 | −$1.44 |
| 15 | 23 | 57% | 61.6¢ | −0.08 | +$0.46 |
| **16** | 24 | 79% | 79.2¢ | +0.00 | +$0.48 |

## Why the opening_captures analysis was wrong (the correction)

`scripts/research/city-best-hour.ts` reads the REAL executable book (bestAsk/execAsk/depth/purchasability by
hour) — that part is correct and useful. Its error was applying a **flat** l0 accuracy (~51%) across all hours,
which made cheap early hours look +EV. But the system bets the **running-max floor**, whose accuracy is
hour-varying (the win-rate columns above). With the correct hour-varying accuracy, the cheap early hours are
negative and the edge is late — matching the realized ledger. **Lesson: always cross-check a backtest against the
realized forward data; a flat-accuracy assumption inverts this strategy.** (Recorded in memory.)

## What's actually true about the edge (be blunt)

The best-hour edge is **real but marginal and provisional**: +$0.5–2.2/bet on ~22 bets, and every board row's
`edgeCiLo` is **below zero** (CI includes 0). The market slightly underprices the near-certain floor outcome
(~95% true vs ~87¢), which is the ~6–9pp WATCH edge — not promotable. Ankara is ~breakeven (efficient). This is
why the play stays **paper**, not capital.

## Action proposed (paper only — city_sim_config; pending operator confirm)

The sim ALREADY places $10/day at every arm 10–16 for all 4 cities (that's the data above). To focus the paper
test on each city's best hour: narrow `arm_hours` → Karachi `[14]`, Houston `[15]`, Singapore `[15]`, Ankara
`[16]` (stake $10, active to 2026-07-31 unchanged). Trade-off: focus vs keeping the full per-hour comparison —
operator's call. Live rail stays paused/inert (`preflight('city-taker')` ok:FALSE). Reproduce: the real-book tool
`pnpm tsx scripts/research/city-best-hour.ts`; realized ledger = `city_paper_bets` grouped by city + arm_hour.
