/**
 * packages/core/sim/signals-findings — the committed, typed mirror of FINDINGS.md (the canonical R&D
 * verdict record). Every signal the system ever tested — the numbered orthogonal signals + the major prior
 * angles + the pre-registered signal-backlog kills — as structured rows: the lever, the ONE load-bearing
 * number (with its CI), the mechanism class it died on, the verdict, and the doc that proves it. The
 * /signals "verdict explorer" (the product flagship) renders this server-side.
 *
 * IDIOM: this mirrors core/sim/city-scan-results.ts — a committed, display-ready record, NOT a live data
 * source (no DB round trip, no client fetch) and NOT auto-generated (there is no regen script). It is the
 * broader sibling of apps/web/src/lib/efficiency-findings.ts (which /efficiency renders): that file carries
 * the 12-lever proof table; THIS one is the complete flagship record, including the live 12th signal, the
 * prior-angle diagnostics, and the 2026-07-03 signal-backlog sweep.
 *
 * SOURCE OF TRUTH (every figure below is COPIED verbatim, never recomputed or re-rounded): FINDINGS.md —
 * the bottom-line signal table, the two arcs, the concrete confirmation, and the "Where each finding lives"
 * appendix — plus the deep docs each row points to. Do NOT edit a number here without updating FINDINGS.md;
 * the golden-value tests (test/signals-findings.test.ts) assert the load-bearing figures match verbatim so a
 * bad hand-edit can't silently ship a number the record doesn't support.
 *
 * THE ONE DYNAMIC EXCEPTION: the 12th signal (opening convergence / maker-exit) is under a LIVE forward
 * paper test. Its STATIC context lives here (OPENING_CONVERGENCE_SIGNAL); its live §9R-E gate LABEL is read
 * at request time from dash_maker_exit by the /signals page (the /maker-exit loader pattern). Nothing else
 * here is live — the investigation is CLOSED (operator decision 2026-06-15); these are settled facts.
 */

// ─── taxonomy ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The adjudicated verdict of a lever. FINDINGS.md uses the first three for settled kills, plus NO-GO for the
 * pre-registered spike gate, INSUFFICIENT_DATA for data-limited (directionally-negative) levers, and
 * UNDER_TEST for the single live forward measurement (the 12th signal's surviving maker-exit variant).
 */
export type SignalVerdict = 'KILL' | 'FAIL' | 'AMBIGUOUS' | 'NO-GO' | 'INSUFFICIENT_DATA' | 'UNDER_TEST';

/**
 * The mechanism the lever died on. The four the brief names — adverse-selection, fee-fill-wall, latency,
 * structural — plus the forecasting-arc walls that none of the four fit (point-skill ceiling; the market is
 * the sharper forecaster) and survivorship (the sports "edge" is winners-only). One row = one dominant wall.
 */
export type MechanismClass =
  | 'point-skill-ceiling'
  | 'market-sharper'
  | 'latency'
  | 'adverse-selection'
  | 'fee-fill-wall'
  | 'survivorship'
  | 'structural';

/** Human labels + a semantic tone (drives the chip colour on /signals). */
export const MECHANISM_CLASS_META: Record<MechanismClass, { label: string; tone: 'red' | 'amber' | 'sky' }> = {
  'point-skill-ceiling': { label: 'point-skill ceiling', tone: 'sky' },
  'market-sharper': { label: 'market is sharper', tone: 'sky' },
  latency: { label: 'no latency window', tone: 'amber' },
  'adverse-selection': { label: 'adverse selection', tone: 'red' },
  'fee-fill-wall': { label: 'fee / fill / depth wall', tone: 'red' },
  survivorship: { label: 'survivorship + latency', tone: 'amber' },
  structural: { label: 'structurally unavailable', tone: 'amber' },
};

/** One tested signal / lever — a row of the flagship verdict explorer. */
export interface SignalRow {
  id: string;
  /** the doc-assigned ordinal ("8th signal" …) where FINDINGS.md assigns one; null for un-numbered angles. */
  signalLabel: string | null;
  /** the lever / signal, named. */
  lever: string;
  /** the question it asked, one line. */
  question: string;
  verdict: SignalVerdict;
  mechClass: MechanismClass;
  /** the ONE load-bearing figure(s), with units + CI — copied verbatim from FINDINGS.md. */
  keyNumber: string;
  /** short wall tag for the chip. */
  wall: string;
  /** where the proof lives. */
  doc: string;
  /** true only for the single live forward-tested row (renders its gate label from dash_maker_exit). */
  live?: boolean;
}

/** A research arc — a coherent group of levers that asked one shape of question. */
export interface SignalArc {
  key: string;
  title: string;
  /** the arc's question, one line. */
  blurb: string;
  rows: SignalRow[];
}

// ─── the arcs (in the order FINDINGS.md tells the story) ─────────────────────────────────────────────────

export const SIGNAL_ARCS: SignalArc[] = [
  {
    key: 'forecasting',
    title: 'Arc 1 — the forecasting levers',
    blurb: 'Does our own calibrated forecast beat the market? (FORECASTING-RD.md)',
    rows: [
      {
        id: 'nwp-blend',
        signalLabel: '1st–3rd signals',
        lever: 'Multi-day NWP blend (4 sub-levers)',
        question: 'Can tuning the multi-model ensemble out-forecast the market?',
        verdict: 'KILL',
        mechClass: 'point-skill-ceiling',
        keyNumber:
          '1.33°C lead-1 RMSE (blend beats icon_seamless 1.46°C); 4 levers rejected: −3.32% / −0.01% / R² 0.60% / −0.05%',
        wall: 'point-skill ceiling',
        doc: 'FORECASTING-RD §1 (WO-3, L3-b)',
      },
      {
        id: 'intraday-nowcast',
        signalLabel: null,
        lever: 'Intraday nowcast (running-max + lift)',
        question: 'Does the same-day signal that beats our NWP blend also beat the market?',
        verdict: 'KILL',
        mechClass: 'market-sharper',
        keyNumber: 'by h15 the market RMSE 0.40 ≈ the unrealizable oracle 0.43, vs our nowcast 0.65 — already priced',
        wall: 'market at the oracle ceiling',
        doc: 'FORECASTING-RD WO-4',
      },
      {
        id: 'deadmass-latency',
        signalLabel: null,
        lever: 'Running-max "dead bucket" latency',
        question: 'Once a max prints, is there a latency window to sell the logically-dead buckets?',
        verdict: 'KILL',
        mechClass: 'latency',
        keyNumber: 'realizable (bid) dead mass median 0.0000; only 1.39% of polls clear the fee; no decay vs time-since-print',
        wall: 'no latency window',
        doc: 'FORECASTING-RD WO-5',
      },
    ],
  },
  {
    key: 'sharp-wallet',
    title: 'Arc 2 — the sharp wallet',
    blurb:
      'A verifiably-profitable sharp (badatmath, +$25,407 realized, #1 on the WEATHER board) trades our exact universe. Can we learn or copy whatever they do? (WALLET-RECON-HANDOFF.md)',
    rows: [
      {
        id: 'day-before',
        signalLabel: null,
        lever: 'Our forecast vs the day-before market',
        question: 'Are we the sharper forecaster the day before resolution?',
        verdict: 'FAIL',
        mechClass: 'market-sharper',
        keyNumber:
          'edge +0.46pp, CI [−0.92, +1.83] (straddles 0); 0/44 stations clear zero; our Brier 0.740/0.756 vs market 0.715',
        wall: 'the market is sharper',
        doc: 'WALLET-RECON §10 (KILL-GATE 2)',
      },
      {
        id: 'copy-trade',
        signalLabel: null,
        lever: 'Copy-trading the sharp’s fills',
        question: 'Can we mirror the sharp’s revealed fills as a taker?',
        verdict: 'FAIL',
        mechClass: 'adverse-selection',
        keyNumber: 'taker-follower −6.05pp vs the sharp’s +1.34pp; robust to lag / staleness / price-cut — it is a maker edge',
        wall: 'non-followable',
        doc: 'WALLET-RECON §11',
      },
      {
        id: 'maker-spray',
        signalLabel: null,
        lever: 'Maker-spray (rest our own cheap bids)',
        question: 'Does resting our forecast’s cheap tail below the ask pay?',
        verdict: 'FAIL',
        mechClass: 'adverse-selection',
        keyNumber:
          'maker edge −1.46pp CI [−2.51, −0.41] (all) / −1.73pp CI [−3.16, −0.30] (forecast) — both exclude 0',
        wall: 'adverse selection',
        doc: 'WALLET-RECON §12',
      },
      {
        id: 'sharp-as-forecaster',
        signalLabel: null,
        lever: 'Stacking the sharp’s picks onto the market (Move 5)',
        question: 'Does the sharp’s revealed distribution add orthogonal skill?',
        verdict: 'FAIL',
        mechClass: 'adverse-selection',
        keyNumber: 'improvement −1.74pp / −1.20pp, CI excludes 0 (it subtracts skill); zero-skill P(PASS) = 0.0%',
        wall: 'value-negative',
        doc: 'WALLET-RECON §14 (Move 5)',
      },
      {
        id: 'selector-learn',
        signalLabel: 'REC-1',
        lever: 'Learning the sharp’s maker selection',
        question: 'Can we learn which cheap buckets to rest on, out-of-sample?',
        verdict: 'INSUFFICIENT_DATA',
        mechClass: 'adverse-selection',
        keyNumber:
          'in-sample ceiling +10.6pp collapses to −5.7pp OOS (overfit); the cheap book lives on only 4 independent weather-days < the validation floor',
        wall: 'overfits / data-limited',
        doc: 'SELECTOR-LEARNABILITY §10',
      },
      {
        id: 'tail-calibration',
        signalLabel: null,
        lever: 'Tail-calibration diagnosis (M1, §13)',
        question: 'Do the sharp’s revealed cheap picks beat our EMOS tail?',
        verdict: 'AMBIGUOUS',
        mechClass: 'market-sharper',
        keyNumber:
          'gap +2.37pp / +2.76pp (lead 1/2) — below the pre-registered +3pp bar; our tail ≈ calibrated to the sharp, the market sharper than both',
        wall: 'below the bar',
        doc: 'WALLET-RECON §13 (M1)',
      },
    ],
  },
  {
    key: 'structural',
    title: 'Forecast-free & structural signals',
    blurb:
      'Forget forecasting — is the market consistent with itself, or against another venue, beyond the cost to harvest it? Every row died on a wall other than efficiency.',
    rows: [
      {
        id: 'reward-farming',
        signalLabel: 'REC-10',
        lever: 'Forecast-free reward farming (two-sided MM)',
        question: 'Do the funded liquidity rewards pay more than the cost of resting near mid?',
        verdict: 'KILL',
        mechClass: 'adverse-selection',
        keyNumber:
          'measured fill + inventory cost −47%/day ≈ 8× the ~6%/day reward → net −41%/day; 95% of mid buckets lose',
        wall: 'inventory / adverse selection',
        doc: 'REWARD-INVENTORY-BACKTEST §4 (REC-10)',
      },
      {
        id: 'complete-set',
        signalLabel: '8th signal',
        lever: 'Complete-set structural arb (forecast-free)',
        question: 'Is one book internally consistent (a complete YES set is worth exactly $1)?',
        verdict: 'KILL',
        mechClass: 'fee-fill-wall',
        keyNumber:
          'raw book inconsistent Σask<1 4.0% / Σbid>1 11.8%, but the taker fee > the mispricing → 0.37% / 0.06% clear, live 0/107; 0 of 5 fee-cleared instants clear at depth ≥ 25',
        wall: 'fee + depth wall',
        doc: 'COMPLETE-SET-ARB.md',
      },
      {
        id: 'sports-sharps',
        signalLabel: '9th signal',
        lever: 'Copy-trading the top SPORTS sharps',
        question: 'Can we copy the only live-edge signature this project ever isolated?',
        verdict: 'KILL',
        mechClass: 'survivorship',
        keyNumber:
          'volume machines’ edge → ≈0; specialists’ 100% win is survivorship; fishalive’s $9M is ONE pre-match bet (n=1, reconciles to the pnl curve at 0.74%)',
        wall: 'survivorship + latency',
        doc: 'SPORTS-TRADERS.md §9–§10',
      },
      {
        id: 'cross-venue',
        signalLabel: '10th signal',
        lever: 'Cross-venue RV: Kalshi vs Polymarket',
        question: 'Do two independent venues price the same city’s daily high differently — beyond the cost to harvest it?',
        verdict: 'KILL',
        mechClass: 'fee-fill-wall',
        keyNumber:
          '6 of 7 city-days quoted net-positive, but the cumulative synthetic fills at only 1–10 contracts of true touch depth → winFrac over executable wins = 0',
        wall: 'capacity wall',
        doc: 'CROSS-VENUE-SPIKE.md',
      },
      {
        id: 'whale-insider',
        signalLabel: null,
        lever: 'Whale-insider signature scan',
        question: 'Is there an insider footprint in the largest trades on the board?',
        verdict: 'KILL',
        mechClass: 'structural',
        keyNumber: 'NO insider signature at $100k or $25k ($3.0B / 43k fills) — the edge is sports / live-trading, not weather',
        wall: 'no signature',
        doc: 'WHALE-INSIDER-SCAN.md',
      },
    ],
  },
];

// ─── the concrete confirmation — the badatmath replica ───────────────────────────────────────────────────

/**
 * FINDINGS.md's tangible demonstration that "non-replicable" is real: the sharp's §15 buying model recreated
 * as a fictional, no-money paper-trial and tracked three ways (n=180 seed backtest). All three CIs straddle 0
 * at this n — the DURABLE finding is the structure (adverse-sel tax ≫ spread tax), not the absolute ROI.
 */
export const BADATMATH_REPLICA = {
  doc: 'BADATMATH-REPLICA.md',
  nSeed: 180,
  curves: [
    { key: 'maker-ideal', label: 'maker-ideal (his cheap price, assume filled)', roiPct: 19.3, winPct: 19.4, ci: [-16, 55] as [number, number] },
    { key: 'maker-realistic', label: 'maker-realistic (rest the bid, fill only if the book touches it)', roiPct: -13.4, winPct: 13.7, ci: [-47, 21] as [number, number] },
    { key: 'taker', label: 'taker (cross to the ask — what copying him costs)', roiPct: 3.9, winPct: 19.4, ci: [-27, 35] as [number, number] },
  ],
  /** ideal → taker: what crossing to the ask costs. */
  spreadTaxPp: 15.4,
  /** ideal → realistic: the book only touches your rest when you’re wrong. Dwarfs the spread tax. */
  adverseSelTaxPp: 32.8,
} as const;

// ─── the executable-depth hardening sweep (the "eleventh way") ───────────────────────────────────────────

/**
 * The 2026-06-26 four-lane "turn every stone" sweep — the eleventh WAY the market measured efficient (it
 * HARDENS signals 8–10 at true touch depth rather than adding a new signal). All four lanes KILL. Copied
 * verbatim from FINDINGS.md.
 */
export const HARDENING_SWEEP = {
  date: '2026-06-26',
  blurb:
    'A four-lane, read-only, multi-agent sweep re-interrogated the last open threads at TRUE touch depth — each lane with a pre-registered kill-gate and an adversarial refute pass. All four KILL; they harden signals 8–10 rather than adding new ones.',
  lanes: [
    { lane: 'B', title: 'negRisk mint-and-sell', result: '0/16 ladders net-positive at executable depth (winFrac 0%, CI [0, 0]); raw overround only 1.3¢/set.' },
    { lane: 'D', title: 'complete-set on the depth axis', result: '0 of 5 fee-cleared instants clear at binding depth ≥ 25 (exec_sets 8/6/5/5/3, max net $0.0474).' },
    { lane: 'C1', title: 'sports-specialist fingerprint', result: 'the "98.6% same-second sweep" was a 120s-window artifact; true 2.0 / 14.6 / 13.1% — the edge is survivorship.' },
    { lane: 'C2', title: 'in-play staleness as the fast actor', result: 'staleness window <1s vs our reachable latency 300–1800s — a 300–1800× gap the wrong way.' },
  ],
} as const;

// ─── the live 12th signal (opening convergence / maker-exit) ─────────────────────────────────────────────

/**
 * The single row still under a LIVE forward test. Its STATIC context is frozen here; its live §9R-E gate
 * LABEL + counts are read at request time from dash_maker_exit by the /signals page (the /maker-exit loader
 * pattern). The flat-open PREMISE is dead (Phase-0.5 spike NO-GO); the surviving maker-exit VARIANT PASSes
 * the backtest gate marginally but the forward paper loop is the gate of record — no capital before a frozen
 * forward paper PASS. Copied verbatim from FINDINGS.md (the 12th-signal row + the 2026-07-03 notes).
 */
export const OPENING_CONVERGENCE_SIGNAL: SignalRow = {
  id: 'opening-convergence',
  signalLabel: '12th signal',
  lever: 'Opening convergence → maker-exit variant',
  question: 'Buy the forecast-center bucket cheap, take profit as a MAKER into the convergence — is there net edge at executable depth?',
  verdict: 'UNDER_TEST',
  mechClass: 'adverse-selection',
  keyNumber:
    'flat-open premise FALSIFIED — Phase-0.5 spike NO-GO 0/325 (Wilson CI [0%, 1%]); the surviving maker-exit variant PASSes the backtest gate marginally (+6.9% / +$534, CI [+0.4%, +12.1%]) — the forward paper loop is the gate of record',
  wall: 'adverse selection (measured forward)',
  doc: 'OPENING-CONVERGENCE-HANDOFF.md · MAKER-EXIT-SIM.md',
  live: true,
};

// ─── the 2026-07-03 signal-backlog sweep (pre-registered, priority-ordered, all adjudicated) ─────────────

export interface BacklogKill {
  item: string;
  lever: string;
  verdict: SignalVerdict;
  /** the load-bearing figure, verbatim from FINDINGS.md "Where each finding lives". */
  keyNumber: string;
  doc: string;
}

/**
 * FINDINGS.md's "Where each finding lives" appendix — the pre-registered signal-backlog items, all
 * adjudicated 2026-07-03 (a defined kill-gate before measuring). Copied verbatim. Ordered as the appendix
 * lists them. #12 (CITY-SCAN) selected two analytics candidates — not capital — and #1b PASSed a backtest
 * gate whose pool-share input stays UNMEASURED (the forward loop is the gate of record).
 */
export const SIGNAL_BACKLOG_KILLS: BacklogKill[] = [
  {
    item: '#9',
    lever: 'precip / snow / wind markets',
    verdict: 'KILL',
    keyNumber: 'liquidity gate: temp ladders median $34k/24h; precip/wind are sparse one-offs ≤ $802/24h — no universe worth a forecast pipeline',
    doc: 'SIGNAL-BACKLOG.md item 9',
  },
  {
    item: '#7',
    lever: 'sharp order-arrival signal',
    verdict: 'KILL',
    keyNumber: 'structurally impossible keyless: the public book is anonymous by design; the only wallet-attributed feed is fills/settlements',
    doc: 'SIGNAL-BACKLOG.md item 7',
  },
  {
    item: '#11',
    lever: 'nonlinear-ML residual post-processing',
    verdict: 'KILL',
    keyNumber: 'corrected TEST MAE WORSE than raw by 0.0159°C, day-clustered CI [−0.0280, −0.0051]; TEST residual R² −6.11% vs the linear +0.60% bound',
    doc: 'SIGNAL-BACKLOG.md item 11',
  },
  {
    item: '#10',
    lever: 'model-update-shock latency',
    verdict: 'INSUFFICIENT_DATA',
    keyNumber: 'the pre-registered TRAIN half has 0 build-pair deltas; 0/221 deltas classifiable — testable only via a forward-designed capture',
    doc: 'SIGNAL-BACKLOG.md item 10',
  },
  {
    item: '#6',
    lever: 'cross-horizon information-propagation lag',
    verdict: 'KILL',
    keyNumber: 'well-powered null: n=568 bets / 44 cities, edge +0.80pp, CI [−1.74, +3.34]; day-clustered [−2.14, +3.61]',
    doc: 'SIGNAL-BACKLOG.md item 6',
  },
  {
    item: '#5',
    lever: 'multi-bucket basket entry',
    verdict: 'KILL',
    keyNumber: 'basket 2/3 full mean 3.78% vs pinned 6.81%, ciLow −3.23% vs +0.25%; jackknife fragility explodes LOCO 15/45→45/45',
    doc: 'SIGNAL-BACKLOG.md item 5',
  },
  {
    item: '#2',
    lever: 'post-bust reaction pricing',
    verdict: 'KILL',
    keyNumber: 'n=84 bust-triggered bets ≥ the 40 bar, edge +2.91pp but 95% CI [−3.21, +9.03] straddles 0 — a measured null',
    doc: 'SIGNAL-BACKLOG.md item 2',
  },
  {
    item: '#3',
    lever: 'conditional efficiency by disagreement regime',
    verdict: 'INSUFFICIENT_DATA',
    keyNumber: 'the naive Q4 +7.47pp gate-PASS collapses to a day-clustered CI [−7.86, +23.09] on 3 weather-days; permutation false-PASS 17.3%',
    doc: 'SIGNAL-BACKLOG.md item 3',
  },
  {
    item: '#4',
    lever: 'extreme-day tail calibration',
    verdict: 'KILL',
    keyNumber: 'sign-reversed: tail gap −1.73pp, CI [−2.77, −0.69], n=281 far-tail bets / 236 extreme days — the market OVERPRICES far tails',
    doc: 'SIGNAL-BACKLOG.md item 4',
  },
  {
    item: '#12',
    lever: 'CITY-SCAN — all-45-city historical replay',
    verdict: 'AMBIGUOUS',
    keyNumber: 'two analytics candidates (ankara/14h + houston/14h), no capital; POOLED ROI negative at EVERY entry hour (−11.4pp @14h → −101.9pp @19h)',
    doc: 'SIGNAL-BACKLOG.md item 12',
  },
  {
    item: '#1b',
    lever: 'reward-stacking on the maker-exit sell leg',
    verdict: 'AMBIGUOUS',
    keyNumber: 'backtest gate-PASS: full-panel ciLow +0.25% → +2.38% at the 0.05 pool-share floor — but pool share is UNMEASURED (forward loop is the gate of record)',
    doc: 'SIGNAL-BACKLOG.md item 1b',
  },
];

// ─── the twelve ways + the headline figures ──────────────────────────────────────────────────────────────

/**
 * "The market measured efficient TWELVE ways." The canonical tally, derived from FINDINGS.md: the 10
 * orthogonal signals (per "the market is now measured efficient ELEVEN ways = 10 signals + this hardening
 * sweep"), + the executable-depth hardening sweep (the 11th way), + the opening-convergence FLAT-OPEN
 * premise, which the Phase-0.5 spike gate formally falsified 2026-07-03 (NO-GO, 0/325) — the 12th way. Each
 * entry is a DISTINCT falsified mechanism the record adjudicates as settled. (The prior-angle diagnostics
 * and the signal-backlog kills are additional falsifications beyond this canonical headline count.)
 */
export const TWELVE_WAYS: { n: number; way: string; verdict: SignalVerdict; ref: string }[] = [
  { n: 1, way: 'Multi-day NWP blend at its point-skill ceiling', verdict: 'KILL', ref: 'FORECASTING-RD §1' },
  { n: 2, way: 'Intraday nowcast — the market is already at the oracle ceiling', verdict: 'KILL', ref: 'FORECASTING-RD WO-4' },
  { n: 3, way: 'Running-max dead-bucket latency — no realizable window', verdict: 'KILL', ref: 'FORECASTING-RD WO-5' },
  { n: 4, way: 'Our forecast vs the day-before market — the market is sharper', verdict: 'FAIL', ref: 'WALLET-RECON §10' },
  { n: 5, way: 'Copy-trading the sharp’s fills — non-followable', verdict: 'FAIL', ref: 'WALLET-RECON §11' },
  { n: 6, way: 'Maker-spray our own cheap bids — adverse selection', verdict: 'FAIL', ref: 'WALLET-RECON §12' },
  { n: 7, way: 'Stacking the sharp’s picks onto the market — value-negative', verdict: 'FAIL', ref: 'WALLET-RECON §14' },
  { n: 8, way: 'Complete-set structural arb — fee + depth wall', verdict: 'KILL', ref: 'COMPLETE-SET-ARB.md' },
  { n: 9, way: 'Copy-trading the top SPORTS sharps — survivorship', verdict: 'KILL', ref: 'SPORTS-TRADERS.md' },
  { n: 10, way: 'Cross-venue RV (Kalshi vs Polymarket) — capacity wall', verdict: 'KILL', ref: 'CROSS-VENUE-SPIKE.md' },
  { n: 11, way: 'Executable-depth hardening sweep (B/D/C1/C2) — all KILL', verdict: 'KILL', ref: 'FINDINGS.md 2026-06-26' },
  { n: 12, way: 'Opening-convergence flat-open premise — Phase-0.5 spike NO-GO 0/325', verdict: 'NO-GO', ref: 'FINDINGS.md 2026-07-03' },
];

/** Curated headline figures (frozen, verbatim from FINDINGS.md). */
export const SIGNAL_HERO = {
  /** the canonical "measured efficient N ways" count (10 signals + hardening sweep + the flat-open NO-GO). */
  measuredWays: 12,
  /** distinct orthogonal signals falsified (FINDINGS.md: "10 signals + this hardening sweep = eleven ways"). */
  signalsFalsified: 10,
  /** total structured signal rows across the arcs + the live 12th (the full flagship record). */
  totalRows: SIGNAL_ARCS.reduce((s, a) => s + a.rows.length, 0) + 1,
  /** lead-1 point-skill RMSE of the calibrated blend (beats every single model). */
  forecastRmseLead1C: 1.33,
  bestSingleModel: 'icon_seamless 1.46°C',
  /** the one edge that demonstrably exists in this universe — and is non-replicable. */
  sharpRealizedUsd: 25407,
  /** the replica trial's two taxes: why the sharp's edge doesn't transfer. */
  spreadTaxPp: 15.4,
  adverseSelTaxPp: 32.8,
  /** the id of the single live forward-tested row (its gate label comes from dash_maker_exit). */
  liveSignalId: 'opening-convergence',
  sourceDoc: 'FINDINGS.md',
  /** investigation CLOSED (operator decision); the trading rail is DORMANT. */
  investigationStatus: 'CLOSED · analytics retained · rail DORMANT',
} as const;
