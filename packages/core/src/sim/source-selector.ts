/**
 * core/sim/source-selector — the PURE per-city "best-matching forecast source" selector for the
 * Fahrenheit US-city bidding test (WS-A, the operator's "Test 3": run the Google-bucket play on US °F
 * markets, but bid on GOOGLE + the source that best matches that city's resolved high, not raw Google).
 *
 * WHY THIS SHAPE. Raw Google is cold-biased on °F (GOOGLE-FAHRENHEIT-INVESTIGATION.md: 14% bucket hit,
 * +1.05 buckets too cold, ZERO take-profits, −$125 on 6 markets — a forecast-quality problem, not a
 * rounding bug). So the lever is "use a better source per city." BUT the committed record
 * (source-accuracy-findings.ts) warns the naive version is a false positive: a best-of-N per-city pick
 * `survivesMultipleComparisons: false` at n≈48. That verdict was measured on HOUSE sources in °C-space at
 * ±1°C; this selector is different (commercial Lane-B sources, scored on the actual °F-ladder BIDDING
 * metric) — so it is not redundant, but it MUST confront the multiple-comparisons problem head-on:
 *   1. Score on the ladder-bucket match (googleBucketIdx vs the resolved winning bucket) — the bidding
 *      objective in the market's native unit — NOT °C MAE.
 *   2. Pick the winner on a TRAIN window, VALIDATE it out-of-sample on a disjoint TEST window.
 *   3. Override raw Google for a city ONLY when the picked source beats BOTH raw Google AND the calibrated
 *      blend on TEST by a margin; otherwise SHRINK to the blend (the record's proven default).
 *   4. Gate on per-city TRAIN/TEST coverage; below it → fall back. `INSUFFICIENT` is an honest outcome
 *      (the whole °F universe is ~22 bucketable events — expect most cities to fall back today; the value
 *      is the frozen selector that accrues forward).
 *
 * Pure + total: junk in → the source simply scores 0/n or falls back; never throws, no IO, no look-ahead
 * (TRAIN and TEST are caller-partitioned by time). Imports only ./google-bucket-replay.ts (the shared,
 * unit-agnostic bucketer) + ../types.ts. Paper/analysis only; no capital.
 */
import { googleBucketIdx } from './google-bucket-replay.ts';
import type { OpeningBucket } from './opening-convergence.ts';
import type { Unit } from '../types.ts';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One resolved market event carrying EACH candidate source's forecast center (°C) + the ladder & outcome.
 * `forecastC[source]` is the same shape as RawGooglePrediction.tmaxC (a °C center; googleBucketIdx converts
 * to native °F for °F markets). A missing/null/undefined entry = that source had no forecast for this event.
 */
export interface SourceSelEvent {
  eventId: string;
  /** the per-city grouping key (icao or slug). */
  city: string;
  unit: Unit;
  ladder: OpeningBucket[];
  /** the resolved winning bucket idx (NOT array position), or null if unresolved (event is then unscoreable). */
  winningBucketIdx: number | null;
  /** per-source forecast center in °C; keys are source ids ('google' | 'weatherapi' | 'openweathermap' | 'blend' | …). */
  forecastC: Record<string, number | null | undefined>;
}

export type SelMetric = 'exact' | 'within1';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Scoring
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Per-source aggregate over a set of events (only events where BOTH the source center AND the winner bucket). */
export interface SourceScore {
  source: string;
  /** scoreable events (source center present, winner present, forecast bucketable). */
  n: number;
  exact: number;
  within1: number;
  /** Σ |predIdx − winnerIdx| over the n scoreable events. */
  missSum: number;
  /** exact / n — NaN when n = 0. */
  exactRate: number;
  within1Rate: number;
  meanMiss: number;
}

const rateOf = (s: SourceScore, m: SelMetric): number => (m === 'exact' ? s.exactRate : s.within1Rate);

/** Score ONE source over the given events. Pure + total. */
export function scoreSource(events: readonly SourceSelEvent[], source: string): SourceScore {
  let n = 0;
  let exact = 0;
  let within1 = 0;
  let missSum = 0;
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.winningBucketIdx == null || !Number.isFinite(e.winningBucketIdx)) continue;
    const c = e.forecastC?.[source];
    if (c == null || !Number.isFinite(c)) continue;
    const predIdx = googleBucketIdx(e.ladder, c as number, e.unit);
    if (predIdx == null) continue; // unbucketable forecast/ladder — not a scoreable data point
    const miss = Math.abs(predIdx - (e.winningBucketIdx as number));
    n += 1;
    missSum += miss;
    if (miss === 0) exact += 1;
    if (miss <= 1) within1 += 1;
  }
  return {
    source,
    n,
    exact,
    within1,
    missSum,
    exactRate: n > 0 ? exact / n : NaN,
    within1Rate: n > 0 ? within1 / n : NaN,
    meanMiss: n > 0 ? missSum / n : NaN,
  };
}

/** Score every named source over the events. */
export function scoreSources(
  events: readonly SourceSelEvent[],
  sources: readonly string[],
): Record<string, SourceScore> {
  const out: Record<string, SourceScore> = {};
  for (const s of sources) out[s] = scoreSource(events, s);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Selection (frozen: TRAIN pick → OOS validate → shrink to blend)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SelectorCfg {
  /** sources eligible to WIN a city (should include the fallback + baseline so the report is complete). */
  candidates: string[];
  /** the incumbent a pick must BEAT out-of-sample (raw Google — the thing we suspect is cold-biased). */
  baseline: string;
  /** the proven default a non-qualifying city SHRINKS to (the calibrated blend). */
  fallback: string;
  /** 'within1' (mode within one bucket — the stable ranker on a short sample) or 'exact'. */
  metric: SelMetric;
  /** per-city min TRAIN scoreable events for the winner before an override is even considered. */
  minTrainN: number;
  /** per-city min TEST scoreable events (of the chosen source) to validate OOS. */
  minTestN: number;
  /** OOS: chosen must beat BOTH baseline and fallback by ≥ this many percentage points (0.05 = 5pp). */
  marginPp: number;
}

/** Sensible defaults; tune per the °F universe's realized coverage. */
export const SOURCE_SELECTOR_DEFAULTS: SelectorCfg = {
  candidates: ['google', 'weatherapi', 'openweathermap', 'blend'],
  baseline: 'google',
  fallback: 'blend',
  metric: 'within1',
  minTrainN: 8,
  minTestN: 6,
  marginPp: 0.05,
};

export type SelReason =
  | 'selected' // train winner beat baseline AND fallback OOS by the margin
  | 'fallback-insufficient-train' // not enough TRAIN events to pick
  | 'fallback-insufficient-test' // not enough TEST events to validate the pick OOS
  | 'fallback-no-oos-margin'; // pick did not clear the OOS margin over baseline AND fallback

export interface CitySelection {
  city: string;
  /** the source to bid on for this city (== fallback whenever `reason` starts with 'fallback'). */
  chosen: string;
  reason: SelReason;
  /** the best candidate on TRAIN (null when no candidate had a scoreable TRAIN event). */
  trainWinner: string | null;
  metric: SelMetric;
  train: { winnerN: number; winnerRate: number };
  /** TEST rates for the three actors, on the SAME disjoint window (NaN when uncovered). */
  test: { chosenN: number; chosenRate: number; baselineRate: number; fallbackRate: number };
}

/** deterministic argmax over candidates by (rate desc, n desc, name asc). Requires a scoreable n≥1. */
function pickTrainWinner(
  scores: Record<string, SourceScore>,
  candidates: readonly string[],
  metric: SelMetric,
): string | null {
  let best: string | null = null;
  let bestRate = -Infinity;
  let bestN = -1;
  for (const c of [...candidates].sort()) {
    const s = scores[c];
    if (!s || s.n < 1) continue;
    const r = rateOf(s, metric);
    if (!Number.isFinite(r)) continue;
    if (r > bestRate || (r === bestRate && s.n > bestN)) {
      best = c;
      bestRate = r;
      bestN = s.n;
    }
  }
  return best;
}

/**
 * The frozen per-city selection. TRAIN and TEST MUST be disjoint, time-ordered by the caller (TRAIN =
 * earlier window, TEST = later) — this function does no splitting and no look-ahead. Pure + total.
 */
export function selectSourcesPerCity(
  train: readonly SourceSelEvent[],
  test: readonly SourceSelEvent[],
  cfg: SelectorCfg = SOURCE_SELECTOR_DEFAULTS,
): CitySelection[] {
  const cities = new Set<string>();
  for (const e of train) if (e?.city) cities.add(e.city);
  for (const e of test) if (e?.city) cities.add(e.city);

  const out: CitySelection[] = [];
  for (const city of [...cities].sort()) {
    const trEv = train.filter((e) => e?.city === city);
    const teEv = test.filter((e) => e?.city === city);
    const trScores = scoreSources(trEv, cfg.candidates);
    const teScores = scoreSources(teEv, cfg.candidates);

    const trainWinner = pickTrainWinner(trScores, cfg.candidates, cfg.metric);
    const winnerScore = trainWinner ? trScores[trainWinner]! : null;
    const winnerN = winnerScore?.n ?? 0;
    const winnerRate = winnerScore ? rateOf(winnerScore, cfg.metric) : NaN;

    const teChosen = trainWinner ? teScores[trainWinner]! : null;
    const teBase = teScores[cfg.baseline];
    const teFall = teScores[cfg.fallback];
    const chosenN = teChosen?.n ?? 0;
    const chosenRate = teChosen ? rateOf(teChosen, cfg.metric) : NaN;
    const baselineRate = teBase ? rateOf(teBase, cfg.metric) : NaN;
    const fallbackRate = teFall ? rateOf(teFall, cfg.metric) : NaN;

    let chosen = cfg.fallback;
    let reason: SelReason;
    if (!trainWinner || winnerN < cfg.minTrainN) {
      reason = 'fallback-insufficient-train';
    } else if (chosenN < cfg.minTestN || !Number.isFinite(chosenRate)) {
      reason = 'fallback-insufficient-test';
    } else {
      const beatsBaseline =
        Number.isFinite(baselineRate) && chosenRate - baselineRate >= cfg.marginPp;
      const beatsFallback =
        Number.isFinite(fallbackRate) && chosenRate - fallbackRate >= cfg.marginPp;
      if (beatsBaseline && beatsFallback) {
        chosen = trainWinner;
        reason = 'selected';
      } else {
        reason = 'fallback-no-oos-margin';
      }
    }

    out.push({
      city,
      chosen,
      reason,
      trainWinner,
      metric: cfg.metric,
      train: { winnerN, winnerRate },
      test: { chosenN, chosenRate, baselineRate, fallbackRate },
    });
  }
  return out;
}

/** CitySelection[] → Map<city, chosenSource> for the buildGoogleView injection (selectedByEvent seam). */
export function selectionMap(selections: readonly CitySelection[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of selections) m.set(s.city, s.chosen);
  return m;
}

/** A one-line-per-city + rollup summary for the research CLI / doc. Pure. */
export interface SelectionSummary {
  nCities: number;
  nSelected: number;
  nFallback: number;
  selectedCities: { city: string; source: string }[];
}
export function summarizeSelections(selections: readonly CitySelection[]): SelectionSummary {
  const selected = selections.filter((s) => s.reason === 'selected');
  return {
    nCities: selections.length,
    nSelected: selected.length,
    nFallback: selections.length - selected.length,
    selectedCities: selected.map((s) => ({ city: s.city, source: s.chosen })),
  };
}
