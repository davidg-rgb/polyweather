/**
 * core/sim/amsterdam-besttime — "what is the best hour to lock the Amsterdam bet?", fusing the two
 * independent things that decide whether a fixed-stake bucket bet wins:
 *
 *   1. PEAK-HOUR FLOOR CONFIDENCE (structural, from the 20-yr KNMI climatology, amsterdam-climatology.ts):
 *      by local hour h, how sure are we the running-max floor is essentially the day's final high — i.e.
 *      the day won't climb enough after h to break our °C bucket. Operationalised as leUpside05 =
 *      P(remaining warming after h ≤ 0.5°C). Rises monotonically through the afternoon; on hot days it
 *      rises later (the peak runs ~1h later), so we switch to the month's ≥25°C sub-climatology when the
 *      day's forecast is hot.
 *
 *   2. PREDICTION ACCURACY (empirical, from the graded paper-trade bets): our model's measured hit rate at
 *      lock hour h. Small-sample early on, so it is SHRUNK toward a structural prior derived from the floor
 *      confidence (floorConfidence × a baseline given-floor skill) — the peak-hour knowledge IS the prior.
 *
 * The fusion is a sample-size-weighted blend → a per-hour win probability ("predictive confidence"). The
 * recommended lock hour then maximises the blended expected value against the live market odds
 *      EV(h) = predictiveConfidence(h) / ask(h) − 1,
 * among hours whose floor is credibly locked — so the recommendation trades floor-certainty (rises with h)
 * against odds value (the market prices the floor in as the day resolves, so ask → 1 and EV → 0 late). When
 * the market odds aren't yet observed, it falls back to the earliest structurally-safe hour. This is a
 * transparent decision aid (P(win) ≈ P(floor locked) × P(call right), assumed independent), NOT a
 * calibrated probability — see AMSTERDAM-SIM.md §"peak-hour model".
 *
 * Pure + deterministic. The single source of truth for the /amsterdam best-time panel (via the loader).
 */
import { AMSTERDAM_CLIMATOLOGY } from './amsterdam-climatology.ts';
import type {
  AmsterdamClimatology,
  HourDecisionStat,
  MonthClimatology,
  PeriodClimatology,
} from './amsterdam-climatology.ts';

export type { AmsterdamClimatology, HourDecisionStat, MonthClimatology, PeriodClimatology };
export { AMSTERDAM_CLIMATOLOGY };

/**
 * Baseline probability our whole-°C call is correct GIVEN the running-max floor is locked — i.e. the
 * residual nowcast/rounding error, independent of further warming. Anchored to the walk-forward backtest
 * (15:00/16:00 sit ~86% exact once the floor has peaked); used only as the prior the empirical hit rate
 * shrinks away from as graded bets accumulate. Conservative on purpose.
 */
export const AMSTERDAM_MODEL_SKILL_PRIOR = 0.85;

/** Shrinkage strength: the empirical hit rate outweighs the structural prior past ~this many graded bets. */
export const BESTTIME_SHRINKAGE_K = 10;

/** A bet hour is only eligible for the EV-max recommendation once its floor confidence clears this. */
export const BESTTIME_MIN_FLOOR_CONF = 0.5;

/** The structural fallback (no live odds) recommends the earliest hour whose floor confidence clears this. */
export const BESTTIME_FLOOR_CONF_TARGET = 0.8;

/** °C at/above which we treat the day as "hot" and use the later-peaking ≥25°C sub-climatology. */
export const BESTTIME_HOT_FORECAST_C = 25;

export interface BestTimeParams {
  modelSkillPrior: number;
  shrinkageK: number;
  minFloorConf: number;
  floorConfTarget: number;
  hotForecastC: number;
}

const DEFAULTS: BestTimeParams = {
  modelSkillPrior: AMSTERDAM_MODEL_SKILL_PRIOR,
  shrinkageK: BESTTIME_SHRINKAGE_K,
  minFloorConf: BESTTIME_MIN_FLOOR_CONF,
  floorConfTarget: BESTTIME_FLOOR_CONF_TARGET,
  hotForecastC: BESTTIME_HOT_FORECAST_C,
};

/** One arm's empirical signal — the prediction-accuracy half of the fusion. */
export interface BestTimeArmInput {
  hour: number;
  /** Empirical market hit rate (0..1) over graded bets, or null when none graded yet. */
  hitRate: number | null;
  /** Mean recorded ask (market price in (0,1]) at this lock hour, or null when no quotes. */
  avgAsk: number | null;
  /** Graded bets behind hitRate — the shrinkage weight. */
  nGraded: number;
}

export interface RecommendBestTimeInput {
  /** Europe/Amsterdam calendar month (1..12) the recommendation is for. */
  month: number;
  /** Today's de-biased lead-1 forecast high (°C), or null — selects the hot-day climatology when ≥ hot cut. */
  forecastC?: number | null;
  arms: BestTimeArmInput[];
  climatology?: AmsterdamClimatology;
  opts?: Partial<BestTimeParams>;
}

export interface BestTimeHourRow {
  hour: number;
  /** P(daily max already reached by this hour) — climatology. */
  peakedPct: number;
  /** Floor confidence = P(remaining warming ≤ 0.5°C) — the peak-hour half. */
  floorConfidence: number;
  meanUpsideC: number;
  p90UpsideC: number;
  /** Empirical market hit rate (0..1) or null — the accuracy half. */
  empiricalHitRate: number | null;
  nGraded: number;
  /** floorConfidence × modelSkillPrior — the structural prior win prob the empirical rate shrinks from. */
  structuralWinProb: number;
  /** The fusion: sample-size-weighted blend of empirical hit and structural prior → P(win) at this hour. */
  predictiveConfidence: number;
  avgAsk: number | null;
  /** predictiveConfidence/ask − 1, fee-free; null when no live odds. */
  evBlended: number | null;
  recommended: boolean;
}

export interface BestTimeView {
  month: number;
  /** Whether today reads as a hot day (forecast ≥ hot cut). */
  hot: boolean;
  /** Whether the ≥25°C sub-climatology was actually used (hot AND the month has one). */
  usedHotClimatology: boolean;
  /** Median local hour of the daily max for the active period — the "peak typically at HH" stat. */
  medianPeakHour: number;
  rows: BestTimeHourRow[];
  recommendedHour: number | null;
  /** How the recommendation was reached: EV-max over locked hours, or the structural earliest-safe fallback. */
  basis: 'ev' | 'structural' | 'none';
  rationale: string;
  headline: {
    recommendedHour: number | null;
    predictiveConfidence: number | null;
    floorConfidence: number | null;
    empiricalHitRate: number | null;
  };
}

function monthClim(climatology: AmsterdamClimatology, month: number): MonthClimatology {
  const m = climatology.months.find((x) => x.month === month);
  if (m) return m;
  // Defensive: clamp to the nearest available month so the page never hard-fails on a bad month value.
  return climatology.months[Math.min(climatology.months.length - 1, Math.max(0, month - 1))]!;
}

/** The decision stats + median-peak for the active period (hot sub-climatology when applicable). */
function activePeriod(
  m: MonthClimatology,
  hot: boolean,
): { stats: HourDecisionStat[]; medianPeakHour: number; usedHot: boolean } {
  if (hot && m.hot) return { stats: m.hot.decisionByHour, medianPeakHour: m.hot.medianPeakHour, usedHot: true };
  return { stats: m.decisionByHour, medianPeakHour: m.medianPeakHour, usedHot: false };
}

/**
 * Sample-size-weighted blend of an empirical hit rate toward a prior; returns prior when no samples. The
 * empirical rate is clamped to [0,1] — it is a probability, and a malformed upstream value (>1 or <0 from a
 * bad RPC payload) must not leak a >100% "confidence" or a fabricated positive-EV signal onto the table. The
 * prior is already structurally bounded (floorConfidence·skill ≤ 1), so the blend output is then in [0,1].
 */
export function blendWinProb(empirical: number | null, nGraded: number, prior: number, k: number): number {
  if (empirical == null || !Number.isFinite(empirical) || nGraded <= 0) return prior;
  const e = Math.min(1, Math.max(0, empirical));
  return (nGraded * e + k * prior) / (nGraded + k);
}

const fmtHour = (h: number): string => `${String(h).padStart(2, '0')}:00`;
const pctStr = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Rank the candidate lock hours by the fused win-probability × market-odds model and recommend one.
 * Deterministic; safe on empty/partial inputs (returns recommendedHour null with an explanatory rationale).
 */
export function recommendBestTime(input: RecommendBestTimeInput): BestTimeView {
  const p = { ...DEFAULTS, ...(input.opts ?? {}) };
  const climatology = input.climatology ?? AMSTERDAM_CLIMATOLOGY;
  const m = monthClim(climatology, input.month);
  const hot = input.forecastC != null && Number.isFinite(input.forecastC) && input.forecastC >= p.hotForecastC;
  const { stats, medianPeakHour, usedHot } = activePeriod(m, hot);
  const statByHour = new Map(stats.map((s) => [s.hour, s]));

  const armsSorted = [...input.arms].sort((a, b) => a.hour - b.hour);
  const rows: BestTimeHourRow[] = [];
  for (const arm of armsSorted) {
    const stat = statByHour.get(arm.hour);
    if (!stat) continue; // hour outside the climatology's decision window — skip rather than guess
    const floorConfidence = stat.leUpside05;
    const structuralWinProb = floorConfidence * p.modelSkillPrior;
    const predictiveConfidence = blendWinProb(arm.hitRate, arm.nGraded, structuralWinProb, p.shrinkageK);
    // ask is a market price in (0,1]; anything outside that (no quote, or an out-of-spec >1 price) degrades to
    // "no odds" (null → EV omitted) rather than producing a bogus EV.
    const ask =
      arm.avgAsk != null && Number.isFinite(arm.avgAsk) && arm.avgAsk > 0 && arm.avgAsk <= 1 ? arm.avgAsk : null;
    const evBlended = ask != null ? predictiveConfidence / ask - 1 : null;
    rows.push({
      hour: arm.hour,
      peakedPct: stat.peakedPct,
      floorConfidence,
      meanUpsideC: stat.meanUpsideC,
      p90UpsideC: stat.p90UpsideC,
      empiricalHitRate: arm.hitRate,
      nGraded: arm.nGraded,
      structuralWinProb,
      predictiveConfidence,
      avgAsk: ask,
      evBlended,
      recommended: false,
    });
  }

  // Choose: EV-max among hours whose floor is credibly locked; else the earliest structurally-safe hour.
  let recommendedHour: number | null = null;
  let basis: BestTimeView['basis'] = 'none';
  const evEligible = rows.filter((r) => r.evBlended != null && r.floorConfidence >= p.minFloorConf);
  if (evEligible.length > 0) {
    const best = evEligible.reduce((a, b) =>
      (b.evBlended ?? -Infinity) > (a.evBlended ?? -Infinity) ||
      ((b.evBlended ?? -Infinity) === (a.evBlended ?? -Infinity) && b.hour < a.hour)
        ? b
        : a,
    );
    recommendedHour = best.hour;
    basis = 'ev';
  } else if (rows.length > 0) {
    const safe = rows.find((r) => r.floorConfidence >= p.floorConfTarget);
    const pick = safe ?? rows.reduce((a, b) => (b.floorConfidence > a.floorConfidence ? b : a));
    recommendedHour = pick.hour;
    basis = 'structural';
  }
  for (const r of rows) r.recommended = r.hour === recommendedHour;
  const rec = rows.find((r) => r.hour === recommendedHour) ?? null;

  const rationale = buildRationale({ rows, rec, basis, hot, usedHot, medianPeakHour, month: input.month });

  return {
    month: input.month,
    hot,
    usedHotClimatology: usedHot,
    medianPeakHour,
    rows,
    recommendedHour,
    basis,
    rationale,
    headline: {
      recommendedHour,
      predictiveConfidence: rec?.predictiveConfidence ?? null,
      floorConfidence: rec?.floorConfidence ?? null,
      empiricalHitRate: rec?.empiricalHitRate ?? null,
    },
  };
}

function buildRationale(a: {
  rows: BestTimeHourRow[];
  rec: BestTimeHourRow | null;
  basis: BestTimeView['basis'];
  hot: boolean;
  usedHot: boolean;
  medianPeakHour: number;
  month: number;
}): string {
  if (!a.rec) return 'Not enough climatology/odds to recommend a lock hour yet.';
  const hotNote = a.usedHot
    ? ` Today reads hot (forecast ≥ ${BESTTIME_HOT_FORECAST_C}°C), so the later-peaking ≥${BESTTIME_HOT_FORECAST_C}°C climatology is used — the peak typically runs ~1h later.`
    : a.hot
      ? ' Today reads hot, but this month has too small a hot-day sample, so the all-day climatology is used.'
      : '';
  const earliest = a.rows[0];
  const earlyNote =
    earliest && earliest.hour < a.rec.hour && earliest.floorConfidence < a.rec.floorConfidence
      ? ` Earlier arms are riskier — ${fmtHour(earliest.hour)} has only ${pctStr(earliest.floorConfidence)} floor confidence (${earliest.meanUpsideC.toFixed(1)}°C avg still to climb).`
      : '';
  const evNote =
    a.basis === 'ev' && a.rec.evBlended != null
      ? ` Best blended EV/$1 = ${a.rec.evBlended >= 0 ? '+' : ''}${a.rec.evBlended.toFixed(2)} at avg ask ${a.rec.avgAsk?.toFixed(2)}.`
      : a.basis === 'structural'
        ? ' No live odds yet — recommending the earliest structurally-safe hour from the climatology.'
        : '';
  return (
    `Lock at ${fmtHour(a.rec.hour)}: by then ~${pctStr(a.rec.floorConfidence)} of comparable days have the floor ` +
    `locked (≤0.5°C left to climb) and predictive confidence is ${pctStr(a.rec.predictiveConfidence)}. ` +
    `The daily max typically lands around ${fmtHour(a.medianPeakHour)} local.${evNote}${earlyNote}${hotNote}`
  );
}

// --- peak-hour chart geometry helpers (shared by the hero SVG; pure so they unit-test) ----------------

export interface PeakWindow {
  /** Modal local hour of the daily max. */
  modeHour: number;
  /** Inter-quartile-ish window [from,to] capturing the central ~50% of peak times. */
  fromHour: number;
  toHour: number;
}

/**
 * The central peak-hour window from a period's histogram: the modal hour plus the smallest contiguous
 * band around it covering ≥50% of days — what the hero chart shades as "when the max usually lands".
 */
export function peakHourWindow(period: PeriodClimatology | MonthClimatology): PeakWindow {
  const hist = period.peakHourHistogram;
  // Degenerate (empty / all-zero) histogram → collapse to the median peak hour, so the hero chart marks one
  // honest hour rather than shading the whole 0..23 axis as a "peak window". Unreachable from the committed
  // asset (every period sums to ≈1); this guards a future regen / sparse sub-period.
  if (hist.length === 0 || hist.reduce((a, b) => a + (b ?? 0), 0) < 1e-9) {
    return { modeHour: period.medianPeakHour, fromHour: period.medianPeakHour, toHour: period.medianPeakHour };
  }
  let modeHour = 0;
  for (let h = 1; h < hist.length; h++) if ((hist[h] ?? 0) > (hist[modeHour] ?? 0)) modeHour = h;
  let from = modeHour;
  let to = modeHour;
  let mass = hist[modeHour] ?? 0;
  // Grow toward whichever neighbour adds more mass until we cover ≥50%.
  while (mass < 0.5 && (from > 0 || to < hist.length - 1)) {
    const left = from > 0 ? (hist[from - 1] ?? 0) : -1;
    const right = to < hist.length - 1 ? (hist[to + 1] ?? 0) : -1;
    if (right >= left) {
      to += 1;
      mass += hist[to] ?? 0;
    } else {
      from -= 1;
      mass += hist[from] ?? 0;
    }
  }
  return { modeHour, fromHour: from, toHour: to };
}
