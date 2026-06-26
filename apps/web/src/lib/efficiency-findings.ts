/**
 * efficiency-findings — the curated, settled R&D record rendered by /efficiency.
 *
 * These are FACTS, not live data: the falsified-lever table from FINDINGS.md (the canonical R&D
 * verdict). Every number here is sourced from FINDINGS.md + its deep docs and is FROZEN — the
 * investigation is CLOSED (operator decision 2026-06-15). The /efficiency page composes this static
 * record with LIVE calibration + Amsterdam data, so the page can show that the instrument which did
 * the measuring is itself calibrated (i.e. the efficiency verdict is a measurement, not sour grapes).
 *
 * Source of truth: FINDINGS.md. Do NOT edit a number here without updating that record — this file is
 * a faithful, typed mirror of the signal table, nothing more.
 */

export type Verdict = 'KILL' | 'FAIL' | 'AMBIGUOUS';

/** One falsified lever / signal — a row of the FINDINGS.md proof table. */
export interface FalsifiedLever {
  id: string;
  /** the lever / signal, named */
  lever: string;
  /** the question it asked, one line */
  question: string;
  verdict: Verdict;
  /** the load-bearing number(s), with units — what actually settles it */
  evidence: string;
  /** the wall it died on (short tag, for the chip) */
  wall: string;
  /** where the proof lives */
  doc: string;
}

/** A research arc — a coherent group of levers that asked one shape of question. */
export interface FindingsArc {
  key: string;
  title: string;
  /** the arc's question, one line */
  blurb: string;
  levers: FalsifiedLever[];
}

/** The three arcs, in the order FINDINGS.md tells the story. */
export const FINDINGS_ARCS: FindingsArc[] = [
  {
    key: 'forecasting',
    title: 'Arc 1 — the forecasting levers',
    blurb: 'Does our own calibrated forecast beat the market?',
    levers: [
      {
        id: 'nwp-blend',
        lever: 'Multi-day NWP blend (4 sub-levers)',
        question: 'Can tuning the multi-model ensemble out-forecast the market?',
        verdict: 'KILL',
        evidence: '1.33°C lead-1 RMSE — beats every single member; 4 independent levers rejected (−3.32% / −0.01% / R² 0.6% / −0.05%).',
        wall: 'point-skill ceiling',
        doc: 'FORECASTING-RD §1',
      },
      {
        id: 'intraday-nowcast',
        lever: 'Intraday nowcast (running-max + lift)',
        question: 'Does the same-day signal that beats our NWP blend beat the market?',
        verdict: 'KILL',
        evidence: 'By h15 the market RMSE 0.40 ≈ the unrealizable oracle 0.43, vs our nowcast 0.65 — the market already priced it.',
        wall: 'market at the oracle ceiling',
        doc: 'FORECASTING-RD WO-4',
      },
      {
        id: 'deadmass-latency',
        lever: 'Running-max "dead bucket" latency',
        question: 'Once a max prints, is there a latency window to sell the logically-dead buckets?',
        verdict: 'KILL',
        evidence: 'Realizable (bid) dead mass median 0.0000; only 1.39% of polls clear the fee; the residual is flat across time-since-print — no decay.',
        wall: 'no latency window',
        doc: 'FORECASTING-RD WO-5',
      },
    ],
  },
  {
    key: 'sharp-wallet',
    title: 'Arc 2 — the sharp wallet',
    blurb: 'A verifiably-profitable sharp (badatmath, +$25.4k) trades our exact universe. Can we learn or copy whatever they do?',
    levers: [
      {
        id: 'day-before',
        lever: 'Our forecast vs the day-before market',
        question: 'Are we the sharper forecaster the day before resolution?',
        verdict: 'FAIL',
        evidence: 'Edge +0.46pp, CI [−0.92, +1.83] (straddles 0); 0/44 stations clear zero; our Brier 0.740 vs the market 0.715.',
        wall: 'the market is sharper',
        doc: 'WALLET-RECON §10',
      },
      {
        id: 'copy-trade',
        lever: 'Copy-trading the sharp’s fills',
        question: 'Can we mirror the sharp’s revealed fills as a taker?',
        verdict: 'FAIL',
        evidence: 'Taker-follower −6.05pp vs the sharp’s +1.34pp; robust to lag / staleness / price-cut. It is a maker edge.',
        wall: 'non-followable',
        doc: 'WALLET-RECON §11',
      },
      {
        id: 'maker-spray',
        lever: 'Maker-spray (rest our own cheap bids)',
        question: 'Does resting our forecast’s cheap tail below the ask pay?',
        verdict: 'FAIL',
        evidence: 'Maker edge −1.46pp CI [−2.51, −0.41] (all) / −1.73pp (forecast) — both exclude 0. Adverse selection confirmed.',
        wall: 'adverse selection',
        doc: 'WALLET-RECON §12',
      },
      {
        id: 'sharp-as-forecaster',
        lever: 'Stacking the sharp’s picks onto the market',
        question: 'Does the sharp’s revealed distribution add orthogonal skill?',
        verdict: 'FAIL',
        evidence: 'Improvement −1.74pp / −1.20pp, CI excludes 0 (it subtracts skill); zero-skill P(PASS) = 0.0%.',
        wall: 'value-negative',
        doc: 'WALLET-RECON §14',
      },
      {
        id: 'selector-learn',
        lever: 'Learning the sharp’s maker selection (REC-1)',
        question: 'Can we learn which cheap buckets to rest on, out-of-sample?',
        verdict: 'KILL',
        evidence: 'In-sample ceiling +10.6pp collapses to −5.7pp OOS (overfit); the cheap book lives on only 4 independent weather-days < the validation floor.',
        wall: 'overfits / data-limited',
        doc: 'SELECTOR-LEARNABILITY §10',
      },
    ],
  },
  {
    key: 'structural',
    title: 'Arc 3 — forecast-free & structural',
    blurb: 'Forget forecasting — is the market consistent with itself, or against another venue, beyond the cost to harvest it?',
    levers: [
      {
        id: 'reward-farming',
        lever: 'Forecast-free reward farming (two-sided MM)',
        question: 'Do the funded liquidity rewards pay more than the cost of resting near mid?',
        verdict: 'KILL',
        evidence: 'Measured fill + inventory cost −47%/day ≈ 8× the ~6%/day reward → net −41%/day; 95% of mid buckets lose.',
        wall: 'inventory / adverse selection',
        doc: 'REWARD-INVENTORY-BACKTEST §4',
      },
      {
        id: 'complete-set',
        lever: 'Complete-set structural arb (signal 8)',
        question: 'Is one book internally consistent (a complete YES set is worth exactly $1)?',
        verdict: 'KILL',
        evidence: 'Raw book inconsistent ~16%, but the taker fee > the mispricing (0.37% / 0.06% clear; live 0/107). 0 of 5 fee-cleared instants clear at executable depth ≥ 25.',
        wall: 'fee + depth wall',
        doc: 'COMPLETE-SET-ARB.md',
      },
      {
        id: 'sports-sharps',
        lever: 'Copy-trading the top SPORTS sharps (signal 9)',
        question: 'Can we copy the only live-edge signature this project ever isolated?',
        verdict: 'KILL',
        evidence: 'Volume machines’ edge regresses to ≈0; specialists’ 100% win is survivorship; the "98.6% same-second sweep" was a 120s-window artifact (true 2.0 / 14.6 / 13.1%).',
        wall: 'survivorship + latency',
        doc: 'SPORTS-TRADERS.md',
      },
      {
        id: 'cross-venue',
        lever: 'Cross-venue RV: Kalshi vs Polymarket (signal 10)',
        question: 'Do two independent venues price the same city’s daily high differently — beyond the cost to harvest it?',
        verdict: 'KILL',
        evidence: '6 of 7 city-days quoted net-positive, but the cumulative synthetic fills at only 1–10 contracts of true touch depth → winFrac over executable wins = 0.',
        wall: 'capacity wall',
        doc: 'CROSS-VENUE-SPIKE.md',
      },
    ],
  },
];

/** Curated headline figures (frozen, from FINDINGS.md). */
export const EFFICIENCY_HEADLINE = {
  /** distinct orthogonal signals falsified (the canonical count) */
  signalsFalsified: 10,
  /** total falsified levers in the proof table (some signals carry sub-levers) */
  leversFalsified: 12,
  /** 10 signals + the executable-depth hardening sweep = measured eleven ways */
  measuredWays: 11,
  /** lead-1 point-skill RMSE of the calibrated blend (beats every single model) */
  forecastRmseLead1C: 1.33,
  bestSingleModel: 'icon_seamless 1.46°C',
  /** the one edge that demonstrably exists in this universe — and is non-replicable */
  sharpRealizedUsd: 25407,
  /** the replica trial's two taxes: why the sharp's edge doesn't transfer */
  spreadTaxPp: 15.4,
  adverseSelTaxPp: 32.8,
} as const;

/** The discipline that makes these findings a proof rather than a null result. */
export const METHODOLOGY: { title: string; body: string }[] = [
  {
    title: 'Pre-registered kill-gates',
    body: 'Every gate was defined by the economics BEFORE measuring (WO-5 discipline) and never tuned to the result.',
  },
  {
    title: 'The executable-depth lens',
    body: 'A quoted edge is not money until the cumulative position fills at real touch depth on every leg. Quoted ≠ capturable — a volume / open-interest proxy is not depth.',
  },
  {
    title: 'Adversarial verification',
    body: 'Every non-dead finding faced independent skeptics instructed to refute it, defaulting to refuted under uncertainty. Several plausible-but-wrong findings were killed this way (a fake +137% stale-quote arb; a 21°F open-tail phantom).',
  },
  {
    title: 'Symmetric, information-time-matched scoring',
    body: 'Model-vs-market Brier scoring compares like with like at the same instant, so neither side gets a look-ahead.',
  },
];

/** The 2026-06-26 executable-depth hardening sweep — the "eleventh way". */
export const HARDENING_SWEEP = {
  date: '2026-06-26',
  blurb:
    'A four-lane, read-only, multi-agent sweep re-interrogated the last open threads at TRUE touch depth — each lane with a pre-registered kill-gate and an adversarial refute pass. All four KILL; they harden signals 8–10 rather than adding new ones.',
  lanes: [
    {
      lane: 'B',
      title: 'negRisk mint-and-sell',
      result: '0/16 ladders net-positive at executable depth (winFrac 0%, CI [0, 0]); raw overround only 1.3¢/set.',
    },
    {
      lane: 'D',
      title: 'complete-set on the depth axis',
      result: '0 of 5 fee-cleared instants clear at binding depth ≥ 25 (exec_sets 8/6/5/5/3, max net $0.0474).',
    },
    {
      lane: 'C1',
      title: 'sports-specialist fingerprint',
      result: 'the "98.6% same-second sweep" was a 120s-window artifact; true 2.0 / 14.6 / 13.1% — the edge is survivorship.',
    },
    {
      lane: 'C2',
      title: 'in-play staleness as the fast actor',
      result: 'staleness window <1s vs our reachable latency 300–1800s — a 300–1800× gap the wrong way.',
    },
  ],
} as const;
