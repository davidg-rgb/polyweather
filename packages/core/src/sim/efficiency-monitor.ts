/**
 * efficiency-monitor — the forward PAPER "efficiency monitor" scorer (operator-requested 2026-07-09).
 *
 * WHAT THIS IS. A forward paper loop that trades the two most-recent falsified findings on real,
 * forward, day-before executable prices and lets the frozen §9R-E gate adjudicate them over time. It is
 * a CONFIRMATION instrument, not a profit engine: every backtest (C19–C24) says the market is efficient,
 * so the honest expectation is that both strategies wash or bleed. Its one high-value outcome is the
 * small chance a signal holds FORWARD against expectation — the only thing that could reopen trading
 * under the project's standing rule (FINDINGS.md). No capital, ever; the rail stays DORMANT.
 *
 * TWO STRATEGIES, scored side by side:
 *   S1 · REGIME + FORECAST CHEAP-SUBSET (forward-confirms KILL-GATE 2 + C24). Paper-buy our calibrated
 *        forecast's cheap-longshot subset (`selectEntries`, ask < CHEAP_LONGSHOT_MAX_ASK) at the real
 *        day-before ask; tag each bet by the event's ensemble-disagreement quartile so the Q4
 *        high-disagreement cell (C24's only positive point estimate) is tracked separately.
 *   S2 · LADDER-GEOMETRY TROUGHS (forward-confirms C23-T2/T3). Detect interior price-troughs (a bimodal
 *        ladder a single-peaked Tmax distribution shouldn't price) on the day-before ask ladder and
 *        paper-buy the trough bucket at its real ask. Top-of-book is the GENEROUS bound — C23 showed
 *        depth ($4 median) worsens it further; a KILL at top-of-book is therefore conclusive.
 *
 * This module is PURE (no DB, no clock): it takes pre-walked `MonitorEvent`s and returns the per-strategy
 * §9R-E verdicts + the C24 per-quartile / day-clustered breakdown. The DB walk lives in the run script
 * and the edge function; both feed this one scorer so the number is computed identically everywhere.
 *
 * Net-return convention (identical to the pricing-bucket gate, `won − ask − fee`): each paper purchase is
 * one panel row — buy 1 share at the real ask, pay the taker fee, collect $1 iff the bucket wins.
 *   netReturn = (won ? 1 : 0) − ask − takerFeePerShare(ask)   ∈ [−1, 1]
 * winFrac = fraction of purchases with netReturn > 0; the frozen gate clusters these by city.
 */
import { openingVerdict, type OpeningMarketResult, type OpeningVerdict } from './opening-convergence.ts';
import { takerFeePerShare } from '../fees.ts';
import { armEdgeStats, type GradedBet, type ArmEdgeStats } from './stats.ts';
import { clusterMeanTCi, type Ci } from './selector-learn.ts';

/** One temperature-ordered ladder leg at the day-before read (ask + realized outcome). */
export interface LadderLeg {
  tempKey: number; // temperature sort key parsed from the label (NOT the raw bucket_idx — trap #7)
  ask: number; // the real day-before best ask
  won: boolean; // did this bucket resolve YES?
}

/** One closed market, pre-walked, carrying everything both strategies need. */
export interface MonitorEvent {
  city: string;
  targetDate: string;
  /** ensemble-disagreement quartile at decision time (S1 regime split); null if unclassifiable. */
  quartile: 1 | 2 | 3 | 4 | null;
  /** S1: the calibrated-forecast cheap-subset paper buys for this event ({won, ask}). */
  cheapBets: GradedBet[];
  /** S2: the day-before ask ladder (≥3 legs) for interior-trough detection. */
  ladder: LadderLeg[];
}

export interface MonitorCfg {
  feeRate: number; // 0.05 (Polymarket weather taker replica)
  troughDelta: number; // a trough must sit ≥ this below BOTH neighbours (0.02 = 2¢, noise floor)
  shoulderMin: number; // at least one shoulder ≥ this to be material (0.05)
  seed: number; // permutation / MC seed (reproducibility)
}

export const MONITOR_DEFAULTS: MonitorCfg = { feeRate: 0.05, troughDelta: 0.02, shoulderMin: 0.05, seed: 20260709 };

/**
 * Interior price-troughs on a TEMPERATURE-ORDERED ask ladder. A unimodal (single-peaked) distribution
 * cannot have an interior strict local minimum, so any bucket ≥ `troughDelta` below BOTH neighbours (with
 * a material shoulder) is a pricing inconsistency — the S2 fade candidate. Returns the trough leg indices.
 * Pure; [] on < 3 legs. (Mirror of pricing-bucket-exhaustive.py's `interior_extrema` trough branch.)
 */
export function detectLadderTroughs(ladder: LadderLeg[], cfg: Pick<MonitorCfg, 'troughDelta' | 'shoulderMin'>): number[] {
  const out: number[] = [];
  for (let k = 1; k < ladder.length - 1; k++) {
    const p = ladder[k]!.ask;
    const lo = ladder[k - 1]!.ask;
    const hi = ladder[k + 1]!.ask;
    if (p < lo - cfg.troughDelta && p < hi - cfg.troughDelta && Math.max(lo, hi) >= cfg.shoulderMin) out.push(k);
  }
  return out;
}

/** One paper purchase → its net-return panel row (won − ask − fee). */
function toResult(city: string, targetDate: string, won: boolean, ask: number, feeRate: number): OpeningMarketResult {
  const netReturn = (won ? 1 : 0) - ask - takerFeePerShare(ask, feeRate);
  return { city, targetDate, netPnlUsd: netReturn, stakeUsd: 1, netReturn, executed: true };
}

export interface StrategyReport {
  nPurchases: number;
  verdict: OpeningVerdict;
  edge: ArmEdgeStats; // per-bet won−ask (frictionless; the C24/KILL-GATE 2 headline metric)
}

export interface RegimeReport extends StrategyReport {
  byQuartile: Record<1 | 2 | 3 | 4, ArmEdgeStats>;
  /** Q4 day-clustered edge CI (the C24 hardening metric — the independent unit is the weather-day). */
  q4DayClustered: { nClusters: number; mean: number; lo: number; hi: number };
  q4DistinctWeatherDays: number;
}

export interface MonitorReport {
  nEvents: number;
  s1Regime: RegimeReport;
  s2Geometry: StrategyReport & { nTroughs: number };
}

/** Score both strategies over the walked events and adjudicate each with the frozen §9R-E gate. Pure. */
export function scoreEfficiencyMonitor(events: MonitorEvent[], cfg: MonitorCfg = MONITOR_DEFAULTS): MonitorReport {
  // ── S1: regime + forecast cheap-subset ─────────────────────────────────────────────────────────
  const s1Panel: OpeningMarketResult[] = [];
  const s1Bets: GradedBet[] = [];
  const byQ: Record<1 | 2 | 3 | 4, GradedBet[]> = { 1: [], 2: [], 3: [], 4: [] };
  const q4DayVals: number[] = [];
  const q4DayKeys: string[] = [];
  for (const ev of events) {
    for (const b of ev.cheapBets) {
      if (!(Number.isFinite(b.ask) && b.ask > 0 && b.ask <= 1)) continue;
      s1Panel.push(toResult(ev.city, ev.targetDate, b.won, b.ask, cfg.feeRate));
      s1Bets.push(b);
      if (ev.quartile != null) {
        byQ[ev.quartile].push(b);
        if (ev.quartile === 4) {
          q4DayVals.push((b.won ? 1 : 0) - b.ask);
          q4DayKeys.push(ev.targetDate);
        }
      }
    }
  }
  const q4Ci: Ci = clusterMeanTCi(q4DayVals, q4DayKeys);
  const s1Regime: RegimeReport = {
    nPurchases: s1Panel.length,
    verdict: openingVerdict(s1Panel, { dayBlockNull: true, seedSalt: cfg.seed }),
    edge: armEdgeStats(s1Bets),
    byQuartile: { 1: armEdgeStats(byQ[1]), 2: armEdgeStats(byQ[2]), 3: armEdgeStats(byQ[3]), 4: armEdgeStats(byQ[4]) },
    q4DayClustered: { nClusters: new Set(q4DayKeys).size, mean: q4Ci.mean, lo: q4Ci.lo, hi: q4Ci.hi },
    q4DistinctWeatherDays: new Set(q4DayKeys).size,
  };

  // ── S2: ladder-geometry troughs ────────────────────────────────────────────────────────────────
  const s2Panel: OpeningMarketResult[] = [];
  const s2Bets: GradedBet[] = [];
  let nTroughs = 0;
  for (const ev of events) {
    const legs = ev.ladder.filter((l) => Number.isFinite(l.ask) && l.ask > 0 && l.ask < 1).sort((a, b) => a.tempKey - b.tempKey);
    if (legs.length < 3) continue;
    for (const k of detectLadderTroughs(legs, cfg)) {
      nTroughs++;
      const leg = legs[k]!;
      s2Panel.push(toResult(ev.city, ev.targetDate, leg.won, leg.ask, cfg.feeRate));
      s2Bets.push({ won: leg.won, ask: leg.ask });
    }
  }
  const s2Geometry = {
    nPurchases: s2Panel.length,
    nTroughs,
    verdict: openingVerdict(s2Panel, { dayBlockNull: true, seedSalt: cfg.seed }),
    edge: armEdgeStats(s2Bets),
  };

  return { nEvents: events.length, s1Regime, s2Geometry };
}
