# Flat-open window — how long is it really? (2026-06-27, additive evidence)

> Captured while the `architect` builds `ARCHITECTURE-OPENING-CONVERGENCE.md` in parallel. Additive
> only — modifies no handoff/state/architecture file. Script: `scripts/research/flat-open-window.ts`
> (`pnpm tsx scripts/research/flat-open-window.ts --n 8`). Read-only, keyless.

**Question:** the §9R-B entry rule fires only while peak bucket mid ≤ 18% AND within ~6h of listing.
How long does that window actually last? Walked EVERY bucket's hourly `/prices-history` on 8
recently-resolved markets, built the cross-bucket peak-mid series, measured listing→first-cross-18%.

## Result (8 markets, all 2026-06-26)
| market | life | open-peak | peak>18% after | peak>25% after |
|---|---|---|---|---|
| madrid | 64h | **12%** | 0.0h | 0.0h |
| guangzhou | 59h | **7%** | 1.0h | 1.0h |
| kuala-lumpur | 59h | **11%** | 0.0h | 1.0h |
| manila | 59h | 21% | already >18% | 1.0h |
| nyc | 51h | 25% | already >18% | 1.0h |
| munich | 64h | 22% | already >18% | 0.0h |
| panama-city | 51h | 28% | already >18% | >25% at open |
| tel-aviv | 63h | 43% | already >18% | >25% at open |

## The two hard findings

1. **The flat-open window is ≤ ~1 hour — and absent in 5/8 markets.** Only **3/8** opened ≤18%
   (madrid 12%, guangzhou 7%, KL 11%); the other **5/8 were already >18% at the first hourly candle.**
   For the 3 that did open cheap, the peak crossed 18% within **0–1h** (madrid/KL within the first
   candle). So the §9R "within ~6h of listing" parameter is **far too generous — the real window is
   ≤1h**, often minutes.

2. **Entry opportunities are RARER than §9R assumed.** §9R framed the edge as "every freshly-listed
   market opens flat." Data says ~**3/8 (~38%)** actually present a ≤18% open; the rest list already
   converged. This stretches the **≥40-captured-markets paper gate (§9R-A/E)** — at ~3/8 qualifying,
   the bot must scan ~100+ listings to accumulate 40 entries. Timeline input, not a kill.

## What this changes for the architect (capture layer, designing now)
- **Cron cadence must be MINUTES, not 15–30 min.** A ≤1h window (often <1 candle) means a 15-min
  cron risks missing the open entirely. Recommend **first-seen detection on a ~2–5 min poll of new
  Gamma listings**, snapshotting full book + our forecast the instant a market appears — not a fixed
  slow sweep.
- **The time-bound in the entry rule is nearly moot** — the peak≤18% threshold + first-seen capture
  do the work; "within ~1h of first-seen" is the honest replacement for §9R-B's "~6h".

## Caveat (foreground it — don't overstate)
`/prices-history` fidelity=60 is **hourly** — it under-resolves the genuine sub-hour open (David's
Paris obs was all-buckets ~10–12% at 6:10 AM, finer than a 60-min candle). So:
- The "already >18% at open" for 5/8 is partly a resolution artifact: the true ~10–12% open likely
  existed but closed inside the first candle. This **bounds the window from ABOVE** ("no slower than
  ~1h") and makes the minute-cadence capture requirement STRONGER, not weaker.
- The true sub-hour shape (and whether the <1h open carries fillable depth) is **only measurable by
  the live forward capture layer** — reconfirming "the build is the experiment" (handoff §7.2). The
  capture layer's first job is to log first-seen → minute-by-minute peak decay on real new listings.

**Net:** thesis not killed — the 3/8 cheap opens are real and we know center buckets re-rate (median
75pp, PROBE-RERUN). But the window is **much briefer and rarer** than §9R modeled. The capture layer
must be a fast first-seen snapshotter (minutes), the entry-rule time bound shrinks to ~1h, and the
paper gate will take more calendar time to reach n=40. All three should land in the architecture.
