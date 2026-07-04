/**
 * packages/core/sim/source-accuracy-findings — the committed, typed mirror of the 2026-07-03 per-city
 * source-accuracy verdict: on ~2,100 resolved events (all 45 cities, leads 0/1/2) the CALIBRATED house
 * blend dominates every individual weather source at every lead, and the two consumers of a forecast want
 * DIFFERENT sources for different jobs (accuracy forecast = bias-corrected blend; convergence seed = raw
 * crowd consensus). The /data "Model use by use-case" section renders this server-side.
 *
 * Mirrors the amsterdam-climatology.ts / city-scan-results.ts committed-asset idiom — this file IS the
 * display-ready record; it is NOT auto-generated (there is no regen script) and NOT a live data source (no
 * DB round trip, no client fetch). The investigation it records is CLOSED (analytics only; trading DORMANT).
 *
 * SOURCE OF TRUTH (every figure below is COPIED verbatim, never recomputed or re-rounded):
 *  - MAKER-EXIT-SIM.md "## The 2026-07-03 improvement campaign" §per-city source-accuracy paragraph
 *    (lines ~253-261): the ~2,100-event aggregate — calibrated blend hit-±1 88/79/75 at lead 0/1/2 vs the
 *    best single NWP model ~70/66/62 and the raw ensemble 66/62/59; the per-city highlights (karachi/LA/
 *    miami ≥95% bracket at lead 1; amsterdam 52%); the "8 cities beat the blend >10pp are best-of-10 picks
 *    at n≈48, don't survive multiple comparisons" note; the "seed choice (calibrated > raw everywhere)"
 *    and Lane-B caveats.
 *  - CONVERGENCE-TUNING.md Finding 2 (lines ~147-165) + the top banner (line ~13): the selector diagnostic
 *    (house_gaussian vs house_ensemble bracket-the-winner rate at centerHalfWidth 0/1/2, 708-event panel;
 *    819-event banner chw1 74.4% vs 53.0%; the ~2,100-event lead-1 corroboration 79% vs 62%).
 *  - CITY-SIM.md §7 "The convergence/accuracy forecast split": the two use-cases — paper-trade/Amsterdam
 *    holds to resolution → wants the calibrated (bias-corrected) center; opening-convergence sells into the
 *    convergence → bets on what the crowd will believe → wants the RAW cross-model consensus, governed by
 *    BotConfig.consensusSource (default 'ensemble_raw'; 'calibrated' restores the old center).
 *
 * Do NOT edit a number here without updating those records; the golden-value tests
 * (test/source-accuracy-findings.test.ts) assert every load-bearing figure matches verbatim so a bad
 * hand-edit can't silently ship a number the record doesn't support.
 *
 * SCOPE HONESTY (this is a surface-only view, flagged not fudged): the FULL per-city
 * best-single-source-vs-blend table was NOT archived in-repo — only the aggregate-by-lead comparison, the
 * handful of illustrative cities above, and the "8 cities" summary were recorded. A complete 45-city × source
 * breakdown would need a fresh DB pull (a heavy op, out of scope for this static surface). See
 * SOURCE_ACCURACY_CAVEATS[0].
 */

// ─── metadata ────────────────────────────────────────────────────────────────────────────────────────────

export interface SourceAccuracyMeta {
  /** ~2,100 resolved events — "3× the tuning panel, all 45 cities, leads 0/1/2" (MAKER-EXIT-SIM.md). */
  nEventsApprox: number;
  nCities: number;
  /** the forecast leads scored: 0 = day-of, 1 = day-before, 2 = two-days-out. */
  leads: number[];
  /** the accuracy metric: mode within ±1° (one bucket) of the resolved daily high — the "bracket" rate. */
  metric: string;
  /** one-line description of the scored panel. */
  panel: string;
  /** when the operator's per-city hypothesis was answered + recorded. */
  recordedAt: string;
  sourceDocs: string[];
}

export const SOURCE_ACCURACY_META: SourceAccuracyMeta = {
  nEventsApprox: 2100,
  nCities: 45,
  leads: [0, 1, 2],
  metric: 'mode within ±1° (one bucket) of the resolved daily high — the "bracket" rate',
  panel: '~2,100 resolved events (3× the maker-exit tuning panel), all 45 cities, leads 0/1/2',
  recordedAt: '2026-07-03',
  sourceDocs: [
    'MAKER-EXIT-SIM.md §2026-07-03 improvement campaign (per-city source-accuracy paragraph)',
    'CONVERGENCE-TUNING.md Finding 2 + top banner',
    'CITY-SIM.md §7 (the convergence/accuracy forecast split)',
  ],
};

// ─── the aggregate source comparison by lead (the headline: blend dominates every source at every lead) ────

/** The three source CLASSES the record compares (not individual models — the classes the verdict names). */
export type SourceClass = 'calibrated-blend' | 'best-single-nwp' | 'raw-ensemble';

export interface SourceAccuracyRow {
  source: SourceClass;
  /** display label. */
  label: string;
  /** what this class maps to in the live system. */
  systemName: string;
  /** hit-within-1° bracket rate as a percentage, per lead — index 0/1/2 = lead 0/1/2. */
  hitWithin1ByLead: [number, number, number];
  /** the source doc records the NWP-model row as approximate ("~70/66/62"); the other two are exact. */
  approx: boolean;
  /** one-line read. */
  note: string;
}

/**
 * MAKER-EXIT-SIM.md §per-city, copied verbatim: "hit-±1 88 %/79 %/75 % at lead 0/1/2 vs the best single NWP
 * model ~70 %/66 %/62 % and the raw ensemble 66 %/62 %/59 %". The calibrated house blend is highest at every
 * lead — the operator's per-city hypothesis, answered: the blend dominates every source everywhere.
 */
export const SOURCE_ACCURACY_BY_LEAD: SourceAccuracyRow[] = [
  {
    source: 'calibrated-blend',
    label: 'Calibrated house blend',
    systemName: 'house_gaussian (the calibrated blend)',
    hitWithin1ByLead: [88, 79, 75],
    approx: false,
    note: 'The champion — every per-model bias correction folded in. Dominates every source at every lead.',
  },
  {
    source: 'best-single-nwp',
    label: 'Best single NWP model',
    systemName: 'best of the 8 Open-Meteo deterministic models',
    hitWithin1ByLead: [70, 66, 62],
    approx: true,
    note: 'The best individual physics model per lead (recorded as approximate). Still ~15–18pp behind the blend.',
  },
  {
    source: 'raw-ensemble',
    label: 'Raw cross-model ensemble',
    systemName: 'ensemble_raw',
    hitWithin1ByLead: [66, 62, 59],
    approx: false,
    note: 'The un-corrected cross-model consensus — what the crowd sees. The convergence seed, NOT the accuracy pick.',
  },
];

// ─── per-city highlights (recorded illustrative cities — NOT the full per-city table; see caveats) ────────

export interface PerCityHighlight {
  /** city slugs. */
  cities: string[];
  /** the lead the bracket rate is quoted at. */
  lead: number;
  /** the recorded bracket rate (%). */
  bracketPct: number;
  /** '>=' for the ≥95% group; '=' for the single amsterdam figure. */
  comparator: '>=' | '=';
  /** best = a high-accuracy exemplar; worst = a low-accuracy exemplar. */
  kind: 'best' | 'worst';
}

/**
 * MAKER-EXIT-SIM.md §per-city: "Per-city accuracy VARIES enormously (karachi/LA/miami ≥95 % bracket at lead
 * 1; amsterdam 52 %)". These are the ONLY per-city figures the record archives (illustrative extremes) — the
 * full 45-city table was not saved (SOURCE_ACCURACY_CAVEATS[0]).
 */
export const PER_CITY_HIGHLIGHTS: PerCityHighlight[] = [
  { cities: ['karachi', 'los-angeles', 'miami'], lead: 1, bracketPct: 95, comparator: '>=', kind: 'best' },
  { cities: ['amsterdam'], lead: 1, bracketPct: 52, comparator: '=', kind: 'worst' },
];

/**
 * The multiple-comparisons guard: MAKER-EXIT-SIM.md — "No per-city single-model override survives
 * multiple-comparisons scrutiny (the 8 cities where one model beats the blend >10 pp are best-of-10 picks at
 * n≈48 — and mostly the low-accuracy cities anyway)." I.e. a per-city single-source override is a false
 * positive; the blend stays the pick everywhere.
 */
export interface PerCityOverrideNote {
  /** cities where some single model beat the blend by more than the margin. */
  nCitiesBeatingBlend: number;
  /** the margin (percentage points) that "beat" required. */
  minMarginPp: number;
  /** the per-city selection pool (best-OF-10 models) that makes it a best-of pick. */
  selectionPoolPerCity: number;
  /** approximate per-city sample size. */
  nPerCityApprox: number;
  /** whether the override survives multiple-comparisons scrutiny. */
  survivesMultipleComparisons: boolean;
}

export const PER_CITY_OVERRIDE_NOTE: PerCityOverrideNote = {
  nCitiesBeatingBlend: 8,
  minMarginPp: 10,
  selectionPoolPerCity: 10,
  nPerCityApprox: 48,
  survivesMultipleComparisons: false,
};

// ─── the two use-cases (which source for which job) — CITY-SIM.md §7 ───────────────────────────────────────

export type UseCaseKey = 'accuracy-forecast' | 'convergence-seed';

export interface ForecastUseCase {
  key: UseCaseKey;
  title: string;
  /** which surface consumes this forecast. */
  consumer: string;
  /** how the position resolves — the reason the two want different forecasts. */
  horizon: string;
  /** what the forecast is optimizing for. */
  wants: string;
  /** which source CLASS this use-case picks. */
  sourceClass: SourceClass;
  /** the live seed name. */
  seedName: string;
  /** the BotConfig.consensusSource value (or 'n/a' for the accuracy surface, which is always calibrated). */
  consensusSource: string;
  /** the recorded rationale. */
  rationale: string;
}

/**
 * CITY-SIM.md §7 "The convergence/accuracy forecast split": the paper-trade holds to resolution → wants the
 * most ACCURATE (bias-corrected) forecast; the opening-convergence bot sells into the convergence before
 * resolution → bets on WHAT THE CROWD WILL BELIEVE → wants the RAW cross-model consensus. Same data, opposite
 * pick. The tension: per CONVERGENCE-TUNING Finding 2, even the convergence SELECTION step brackets better on
 * the calibrated seed (see SELECTOR_DIAGNOSTIC + SELECTOR_DIAGNOSTIC_META.alignmentNote).
 */
export const FORECAST_USE_CASES: ForecastUseCase[] = [
  {
    key: 'accuracy-forecast',
    title: 'Accuracy forecast',
    consumer: 'Paper-trade / Amsterdam (and every /data accuracy number)',
    horizon: 'bets and HOLDS to resolution — scored on the actual high',
    wants: 'the most ACCURATE forecast: every per-model bias correction, the calibrated center',
    sourceClass: 'calibrated-blend',
    seedName: 'house_gaussian (calibrated)',
    consensusSource: 'calibrated',
    rationale:
      'Held to resolution and graded on the real high, so the truth-corrected blend — which dominates every ' +
      'source at every lead — is unambiguously the right pick.',
  },
  {
    key: 'convergence-seed',
    title: 'Convergence seed',
    consumer: 'Opening-convergence bot',
    horizon: 'buys cheap at the flat open and SELLS INTO the convergence before resolution',
    wants: "what the crowd will believe: the RAW cross-model consensus the marginal trader's weather app shows",
    sourceClass: 'raw-ensemble',
    seedName: 'ensemble_raw',
    consensusSource: 'ensemble_raw',
    rationale:
      "A −1° truth correction that WINS the accuracy paper-trade LOSES the convergence — it moves off the " +
      "crowd's Schelling point. So the bot's house seed drops the per-model bias (keeps weights + sigma). " +
      'Default BotConfig.consensusSource = ensemble_raw.',
  },
];

// ─── the selector diagnostic (why the seed choice is live-relevant) — CONVERGENCE-TUNING.md Finding 2 ──────

export interface SelectorBracketRow {
  selector: 'house_gaussian' | 'house_ensemble';
  label: string;
  bias: 'calibrated' | 'raw';
  /** bracket-the-winner rate (%) at centerHalfWidth 0/1/2 — index 0/1/2. */
  bracketByChw: [number, number, number];
}

/**
 * CONVERGENCE-TUNING.md Finding 2 table (708-event panel, reads the DB seed + true resolution directly),
 * copied verbatim. Does the forecast bracket the eventual winner? The calibrated gaussian brackets ~21pp more
 * often than the raw ensemble at every width — so for the SELECTION objective (which bucket to enter so it
 * re-rates up), the calibrated seed is materially stronger, even though the convergence PRICE-TARGET argument
 * (above) picks the raw consensus. That tension is the open operator note.
 */
export const SELECTOR_DIAGNOSTIC: SelectorBracketRow[] = [
  { selector: 'house_gaussian', label: 'Calibrated gaussian', bias: 'calibrated', bracketByChw: [33.6, 73.9, 91.2] },
  { selector: 'house_ensemble', label: 'Raw ensemble', bias: 'raw', bracketByChw: [21.9, 52.8, 73.4] },
];

export interface SelectorDiagnosticMeta {
  /** the panel the Finding 2 table was computed on. */
  nEvents: number;
  /** the grown-panel banner corroboration (CONVERGENCE-TUNING.md line ~13). */
  bannerNEvents: number;
  bannerChw1Calibrated: number;
  bannerChw1Raw: number;
  /** the ~2,100-event lead-1 corroboration (calibrated vs raw ensemble) — ties back to SOURCE_ACCURACY_BY_LEAD. */
  dbPanelLead1Calibrated: number;
  dbPanelLead1Raw: number;
  /** the 2026-07-03 operator-gated alignment action (NOT applied — rail DORMANT). */
  alignmentNote: string;
}

export const SELECTOR_DIAGNOSTIC_META: SelectorDiagnosticMeta = {
  nEvents: 708,
  bannerNEvents: 819,
  bannerChw1Calibrated: 74.4,
  bannerChw1Raw: 53.0,
  dbPanelLead1Calibrated: 79,
  dbPanelLead1Raw: 62,
  alignmentNote:
    'For the SELECTION objective the calibrated gaussian out-selects the raw ensemble at every width — so the ' +
    "07-03 record carries an operator-gated alignment action (flip bot.consensusSource → calibrated). NOT " +
    'applied: no cell clears the §9R-E gate, the rail stays DORMANT, live config unchanged.',
};

// ─── caveats (surface-only honesty) ────────────────────────────────────────────────────────────────────────

export const SOURCE_ACCURACY_CAVEATS: string[] = [
  'The FULL per-city best-single-source-vs-blend table was not archived in-repo — only this aggregate-by-lead ' +
    'comparison, the handful of illustrative cities (karachi/LA/miami, amsterdam), and the "8 cities" summary ' +
    'were recorded. A complete 45-city × source breakdown would need a fresh DB pull, out of scope for this ' +
    'static surface.',
  'Per-city accuracy is NOT harvestable as a trade filter (a per-city accuracy gate widened the clustered CI ' +
    'and was rejected). Its real use is the SEED CHOICE — calibrated > raw everywhere — and the eventual ' +
    'capital-scope decision.',
  'The commercial Lane-B sources (Google / OWM / WeatherAPI) have only days of history — re-scoreable in ~a month.',
];
