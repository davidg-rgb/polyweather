/**
 * packages/core/sim/city-scan-results — a committed, typed mirror of the SIGNAL-BACKLOG.md "## 12.
 * CITY-SCAN" verdict: the one-time historical replay of the city-sim $10/day predicted-bucket bet across
 * all 45 cities × entry hours 9..19 local (run 2026-07-03, `scripts/research/city-scan.ts`). Mirrors the
 * amsterdam-climatology.ts committed-asset idiom — this file IS the display-ready record; the /paper-trade
 * "45-City Scan" section renders it server-side. NOT auto-generated (there is no regen script — this is a
 * closed, pre-registered, one-shot analysis) and NOT a live data source: no DB round trip, no client fetch.
 *
 * SOURCE OF TRUTH (every figure below is copied, not recomputed): SIGNAL-BACKLOG.md "## 12. CITY-SCAN"
 * (the pre-registration + the ✅ VERDICT block + the 2026-07-04 Data appendix, which carries the full
 * LEGACY-mode pooled tables from the two bit-identical independent runs — i.e. exactly the recorded
 * verdict's data) + FASTTRACK-PLAN.md cycle-log entries C15–C21 + the FINDINGS.md item-12 row. Do NOT
 * edit a number here without updating those records, and do NOT re-run city-scan.ts to "refresh" this file
 * — the study is a closed, pre-registered SELECTION analysis (TRAIN selects, TEST confirms ONCE); a
 * post-hoc re-run would be exactly the selection-drift the record explicitly declined to do (see §12's
 * "Residual" note). The live paper loop (city_sim_config, confirmation reads from target_date ≥
 * CITY_SCAN_CONFIRMATION_CLOCK) is the forward-going instrument now — this file stays frozen.
 *
 * APPENDIX CONSISTENCY NOTES (verified at copy time; flagged, not adjusted):
 * - Curve n sums to 7,262 = nBets; per-row ROI = net/(n×$10) exactly at display precision; tercile and
 *   ask-split ns both sum to 7,262.
 * - Curve total net −$21,042.14 vs tercile total net −$21,042.13 — a $0.01 display-rounding gap.
 * - The curve's monotone collapse holds from 14h→19h ONLY; 9h–13h are flat-ish with a local dip at 12h
 *   (−15.9pp) — "best @14h" does NOT mean the curve rises into 14h.
 * - buenos-aires/14h: TEST day-CI [−9.4,+37.9]pp leans positive while TEST net is −$6.77 — not an error
 *   (the CI is on per-bet edge = won−ask; net P&L weights payouts by 1/ask), just two different metrics.
 * - helsinki/15h HAS a TEST record (+$44.23, positive) — it is still NOT a candidate because it fails the
 *   TRAIN-LB prong; its TEST read is descriptive only (the bar is TRAIN LB > 0 AND TEST net > 0).
 */

// ─── metadata ────────────────────────────────────────────────────────────────────────────────────────────

export interface CityScanSkipBreakdown {
  /** ask > MAX_ENTRY_ASK (0.95) — binds almost entirely at late arms (3 skips @9h → 500 @19h). */
  askTooHigh: number;
  /** the market had already resolved by the qualifying tick. */
  alreadyResolved: number;
  /** no captured tick at/after the arm hour for that event. */
  noTick: number;
}

export interface CityScanMeta {
  /** when the design was locked, BEFORE any measurement (SIGNAL-BACKLOG.md §12). */
  preRegisteredAt: string;
  /** when the orchestrator adjudicated + recorded the verdict. */
  verdictRecordedAt: string;
  nEvents: number;
  nCities: number;
  nDays: number;
  /** nEvents × 11 arm hours, minus a handful of bad-tz cells; nCells = nBets + nSkips. */
  nCells: number;
  nBets: number;
  nSkips: number;
  skipBreakdown: CityScanSkipBreakdown;
  /** % of bets whose forecast came from a genuine pre-entry point-in-time DB build. */
  pctDbRecoveredForecast: number;
  /** % of bets that fell back to the cache's frozen first-ever-build seed (look-ahead by construction). */
  pctFrozenSeedFallback: number;
  nFallbackBets: number;
  /** rows in the single `bucket_probabilities` DB pull (source='house_gaussian', seeded=false). */
  nDbPullRows: number;
  /** TRAIN = target_date <= this date (selection only). */
  trainLastDate: string;
  /** TEST = target_date >= this date (confirmation only, once). */
  testFirstDate: string;
  /** independent executions that reproduced bit-identical numbers. */
  nIndependentRuns: number;
  /** adversarial review lenses run against the script's load-bearing paths. */
  nReviewLenses: number;
  scriptPath: string;
  sourceDocs: string[];
}

export const CITY_SCAN_META: CityScanMeta = {
  preRegisteredAt: '2026-07-03T19:10:00Z', // ~21:10 local (CEST, UTC+2)
  verdictRecordedAt: '2026-07-03T19:55:00Z', // ~21:55 local
  nEvents: 844,
  nCities: 45,
  nDays: 21,
  nCells: 9284,
  nBets: 7262,
  nSkips: 2022,
  skipBreakdown: { askTooHigh: 1851, alreadyResolved: 131, noTick: 40 },
  pctDbRecoveredForecast: 95.9,
  pctFrozenSeedFallback: 4.1,
  nFallbackBets: 296,
  nDbPullRows: 10909,
  trainLastDate: '2026-06-24',
  testFirstDate: '2026-06-25',
  nIndependentRuns: 2,
  nReviewLenses: 1,
  scriptPath: 'scripts/research/city-scan.ts',
  sourceDocs: [
    'SIGNAL-BACKLOG.md §12 (verdict + Data appendix 2026-07-04)',
    'FASTTRACK-PLAN.md cycle log C15–C21',
    'FINDINGS.md (item 12)',
  ],
};

// ─── pooled arm-hour curve (descriptive, all 45 cities pooled, TRAIN+TEST) ────────────────────────────────

export interface CityScanArmPoint {
  /** local entry hour, city tz. */
  hour: number;
  /** graded bets pooled at this hour. */
  n: number;
  /** pooled net P&L (USD) at this hour. */
  netUsd: number;
  /** pooled ROI in percentage points (= netUsd / (n × $10), at display precision). */
  roiPp: number;
  /** pooled win rate (fraction). */
  winRate: number;
  /** mean entry ask at this hour. */
  meanAsk: number;
  /** day-clustered ROI CI in percentage points [lo, hi]. */
  ciPp: [number, number];
  label: 'best' | 'worst' | null;
}

/**
 * SIGNAL-BACKLOG.md §12 Data appendix, copied verbatim. Negative at EVERY hour — the mechanism-A
 * pooled-efficiency prior re-confirmed. Monotone collapse from the 14h best (−11.4pp) to the 19h worst
 * (−101.9pp); the 16h–19h leg is largely the locked fixed-bucket bet rule (see CITY_SCAN_CAVEATS[0]).
 */
export const CITY_SCAN_POOLED_CURVE: CityScanArmPoint[] = [
  { hour: 9, n: 828, netUsd: -1147.82, roiPp: -13.9, winRate: 0.365, meanAsk: 0.386, ciPp: [-23.8, 4.7], label: null },
  { hour: 10, n: 828, netUsd: -1125.98, roiPp: -13.6, winRate: 0.37, meanAsk: 0.389, ciPp: [-23.4, 8.3], label: null },
  { hour: 11, n: 822, netUsd: -1065.9, roiPp: -13.0, winRate: 0.373, meanAsk: 0.389, ciPp: [-23.9, -1.5], label: null },
  { hour: 12, n: 815, netUsd: -1299.13, roiPp: -15.9, winRate: 0.38, meanAsk: 0.399, ciPp: [-26.0, -4.6], label: null },
  { hour: 13, n: 802, netUsd: -1116.98, roiPp: -13.9, winRate: 0.385, meanAsk: 0.394, ciPp: [-26.3, -1.6], label: null },
  { hour: 14, n: 742, netUsd: -843.89, roiPp: -11.4, winRate: 0.388, meanAsk: 0.381, ciPp: [-24.5, 4.5], label: 'best' },
  { hour: 15, n: 672, netUsd: -1713.85, roiPp: -25.5, winRate: 0.351, meanAsk: 0.339, ciPp: [-45.5, 0.8], label: null },
  { hour: 16, n: 557, netUsd: -2513.81, roiPp: -45.1, winRate: 0.294, meanAsk: 0.294, ciPp: [-54.3, -33.7], label: null },
  { hour: 17, n: 470, netUsd: -3228.25, roiPp: -68.7, winRate: 0.191, meanAsk: 0.221, ciPp: [-79.1, -55.6], label: null },
  { hour: 18, n: 399, netUsd: -3653.32, roiPp: -91.6, winRate: 0.085, meanAsk: 0.132, ciPp: [-96.2, -87.7], label: null },
  { hour: 19, n: 327, netUsd: -3333.21, roiPp: -101.9, winRate: 0.015, meanAsk: 0.062, ciPp: [-104.6, -99.8], label: 'worst' },
];

/** Winner/loser mean entry ask (pooled), with ns from the Data appendix: winners 0.539 (n=2,351) vs losers
 *  0.241 (n=4,911) — higher forecast confidence → monotonically better ROI, never pooled-positive. */
export interface CityScanAskSplit {
  winMeanAsk: number;
  winN: number;
  loseMeanAsk: number;
  loseN: number;
}

export const CITY_SCAN_ASK_SPLIT: CityScanAskSplit = { winMeanAsk: 0.539, winN: 2351, loseMeanAsk: 0.241, loseN: 4911 };

/** Confidence terciles (mode-bucket probability of the distribution actually used) — Data appendix,
 *  copied verbatim. The monotone "higher confidence → less bad, never positive" read. */
export interface CityScanTercileRow {
  tercile: 'low' | 'mid' | 'high';
  /** mode-probability range of the tercile [lo, hi]. */
  confRange: [number, number];
  n: number;
  netUsd: number;
  roiPp: number;
  winRate: number;
}

export const CITY_SCAN_CONFIDENCE_TERCILES: CityScanTercileRow[] = [
  { tercile: 'low', confRange: [0.169, 0.382], n: 2424, netUsd: -9177.01, roiPp: -37.9, winRate: 0.255 },
  { tercile: 'mid', confRange: [0.382, 0.497], n: 2419, netUsd: -6487.46, roiPp: -26.8, winRate: 0.313 },
  { tercile: 'high', confRange: [0.498, 1.0], n: 2419, netUsd: -5377.66, roiPp: -22.2, winRate: 0.404 },
];

// ─── top-5 TRAIN cells, confirmed on TEST only ──────────────────────────────────────────────────────────

export interface CityScanCandidate {
  city: string;
  /** ICAO code — only recorded for the two enrolled candidates in the source docs. */
  icao: string | null;
  /** local entry hour. */
  arm: number;
  /** TRAIN graded-bet count for this cell. */
  trainN: number;
  /** TRAIN net P&L (USD). */
  trainNetUsd: number;
  /** TRAIN-only entry-watch shrinkage lower bound (pp) — the selection score; the locked bar requires > 0. */
  trainLbPp: number;
  /** TEST graded-bet count. */
  testN: number;
  /** TEST-holdout net P&L (USD). */
  testNetUsd: number;
  /** TEST-holdout win rate (fraction). */
  testWinRate: number;
  /** TEST-holdout day-clustered CI in percentage points. */
  testCiPp: [number, number];
  /** bets in this cell skipped by the ask>0.95 gate. INTERPRETED, not appendix-verbatim: §12's review
   *  record gives only "(2/0/1/0/1 skips total)" without naming cells — mapped positionally onto the
   *  TRAIN-LB ranking order below. */
  askGateSkips: number;
  /** clears BOTH prongs of the locked bar: TRAIN LB > 0 AND TEST net > 0. */
  isCandidate: boolean;
  failReason: string | null;
}

/**
 * The locked candidate bar (pre-registered before measurement): TRAIN LB > 0 AND TEST net > 0 among the
 * top-5 TRAIN cells. Rows in the Data appendix's TRAIN-LB ranking order. Note the poster child for why the
 * TEST prong exists: munich/16h ranks FIRST on TRAIN (+6.9pp LB) and then loses on TEST (−$30.86); and
 * helsinki/15h posts a positive TEST net (+$44.23) that does NOT count — it failed the TRAIN prong.
 */
export const CITY_SCAN_TOP5_TRAIN_CELLS: CityScanCandidate[] = [
  {
    city: 'munich', icao: null, arm: 16, trainN: 10, trainNetUsd: 42.24, trainLbPp: 6.9,
    testN: 8, testNetUsd: -30.86, testWinRate: 0.5, testCiPp: [-32.4, 23.6], askGateSkips: 2,
    isCandidate: false, failReason: 'TEST net negative',
  },
  {
    city: 'ankara', icao: 'LTAC', arm: 14, trainN: 11, trainNetUsd: 78.82, trainLbPp: 3.6,
    testN: 8, testNetUsd: 44.88, testWinRate: 0.75, testCiPp: [-28.1, 64.4], askGateSkips: 0,
    isCandidate: true, failReason: null,
  },
  {
    city: 'houston', icao: 'KHOU', arm: 14, trainN: 11, trainNetUsd: 29.32, trainLbPp: 3.1,
    testN: 7, testNetUsd: 12.04, testWinRate: 0.857, testCiPp: [-25.6, 47.4], askGateSkips: 1,
    isCandidate: true, failReason: null,
  },
  {
    city: 'buenos-aires', icao: null, arm: 14, trainN: 10, trainNetUsd: 13.25, trainLbPp: 2.7,
    testN: 8, testNetUsd: -6.77, testWinRate: 0.625, testCiPp: [-9.4, 37.9], askGateSkips: 0,
    isCandidate: false, failReason: 'TEST net negative',
  },
  {
    city: 'helsinki', icao: null, arm: 15, trainN: 11, trainNetUsd: 88.0, trainLbPp: -0.1,
    testN: 7, testNetUsd: 44.23, testWinRate: 0.571, testCiPp: [-16.0, 59.6], askGateSkips: 1,
    isCandidate: false, failReason: 'TRAIN LB ≤ 0 — TEST read is descriptive only',
  },
];

// ─── the three headline review-record caveats (task-specified, verbatim-condensed) ─────────────────────────

export const CITY_SCAN_CAVEATS: string[] = [
  'Fixed-bucket late-hour artifact: the 16h–19h pooled-curve collapse is largely the locked bet rule pricing ' +
    "a FIXED forecast-mode-bucket ask, not the live sim's floor-lifted temperature — spec-compliant, but it " +
    'inflates how bad the late hours look.',
  'Every TEST-holdout confidence interval straddles zero at n=7–8 bets per candidate cell (ankara ' +
    '[−28.1,+64.4]pp, houston [−25.6,+47.4]pp) — the candidate signal is directionally suggestive, not ' +
    'statistically decisive.',
  'This is a SELECTION study, not a confirmation: the scan SELECTS candidates on TRAIN and checks them once ' +
    'on TEST; only the live paper loop CONFIRMS them going forward, and only from target_date ≥ ' +
    'CITY_SCAN_CONFIRMATION_CLOCK (the backfilled window is in-sample vs the scan itself). No capital ' +
    'implication either way — analytics selection only.',
];

// ─── enrollment (operator-executed 2026-07-03 ~22:15 local) ────────────────────────────────────────────────

export interface CityScanEnrollment {
  city: string;
  icao: string;
  tz: string;
  armHours: number[];
  forecastMaxHour: number;
  stakeUsd: number;
  activeUntil: string;
  enrolledAt: string;
  backfillNBets: number;
  backfillNGraded: number;
  backfillFirstDate: string;
  backfillLastDate: string;
  note: string | null;
}

/** SIGNAL-BACKLOG.md §12 "↳ ENROLLMENT EXECUTED 2026-07-03 ~22:15 local" — the staged SQL applied verbatim
 *  + the one-time `city-sim.ts` backfill. */
export const CITY_SCAN_ENROLLMENT: CityScanEnrollment[] = [
  {
    city: 'ankara', icao: 'LTAC', tz: 'Europe/Istanbul', armHours: [11, 12, 13, 14, 15, 16],
    forecastMaxHour: 14, stakeUsd: 10, activeUntil: '2026-07-31', enrolledAt: '2026-07-03T20:15:00Z',
    backfillNBets: 126, backfillNGraded: 121, backfillFirstDate: '2026-06-12', backfillLastDate: '2026-07-03',
    note: null,
  },
  {
    city: 'houston', icao: 'KHOU', tz: 'America/Chicago', armHours: [11, 12, 13, 14, 15, 16],
    forecastMaxHour: 14, stakeUsd: 10, activeUntil: '2026-07-31', enrolledAt: '2026-07-03T20:15:00Z',
    backfillNBets: 125, backfillNGraded: 120, backfillFirstDate: '2026-06-12', backfillLastDate: '2026-07-03',
    note: 'first °F city in the sim — 0070 bucketing is unit-agnostic by design',
  },
];

/**
 * Candidate CONFIRMATION reads use `target_date >= this date` ONLY — the backfilled window overlaps the
 * scan's own TRAIN/TEST split, so it is in-sample for the two candidates (SIGNAL-BACKLOG.md §12).
 */
export const CITY_SCAN_CONFIRMATION_CLOCK = '2026-07-04';
