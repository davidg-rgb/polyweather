/**
 * core/sim/amsterdam — the Amsterdam paper-trade simulation math (single source
 * of truth for the engine; the edge function, the backfill script, and the tests
 * all call these, so the P&L is computed exactly once).
 *
 * The product (NOT trading — see CLAUDE.md analytics pivot): every day we place a
 * fixed-stake YES bet on our model's predicted whole-°C bucket for EHAM at a chosen
 * intraday "lock hour", record the live market odds at placement, and — once the day
 * resolves to the Wunderground daily high — log win/loss + P&L. The cumulative sum is
 * a live, falsifiable score of our nowcast against a real market: if the market is
 * efficient (the WO-5 prior) the curve hovers near zero net of fees; if we ever evolve
 * a real edge, it drifts up.
 *
 * Bucketing is whole-°C: our predicted bucket = wuRound(runningMax) routed through the
 * market ladder, EXACTLY how the market resolves (winningBucket). The P&L formula
 * mirrors the house backtest (scripts/simulate-historical-edge.ts): buy `shares =
 * stake/ask` YES shares; on win each pays $1 (profit `shares·(1−ask)`), on loss the
 * stake is lost — both net of the Polymarket taker fee.
 */
import { winningBucket } from '../buckets.ts';
import { takerFeeTotal } from '../fees.ts';
import type { BucketDef } from '../types.ts';
import { wuRound } from '../units.ts';

/** Fixed paper stake per bet — "$10 of fictitious money on our predictor every day". */
export const AMSTERDAM_SIM_STAKE_USD = 10;

/**
 * The candidate intraday lock hours we race as parallel arms (station-local, the
 * Etc/GMT-2 clock `intraday_advances.local_hour` uses). Each arm stakes its own $10/day
 * on our predicted bucket from the running max known by that hour, under identical rules,
 * so the "best time of day" proves itself empirically — who gains the most after N days.
 * 13:00 is a ~coin-flip on fat odds; 14:00 trades some accuracy for odds; 15:00 is the
 * confident sweet spot (86% exact on 182 days, odds still ~0.82); 16:00 is near-certain
 * but the market has priced it (~0.98 ask → almost no payout). The head-to-head IS the
 * deliverable (operator directive 2026-06-16: race 13/14/15/16, see who wins after 14 days).
 */
export const AMSTERDAM_SIM_ARM_HOURS = [13, 14, 15, 16] as const;

/** The headline arm whose cumulative sum is the dashboard's single total. */
export const AMSTERDAM_SIM_PRIMARY_HOUR = 15;

/** The operator's comparison horizon — the leaderboard's milestone marker. */
export const AMSTERDAM_SIM_COMPARE_DAYS = 14;

/** A market bucket as the sim needs it — the ladder row plus its native °C range. */
export interface SimLadderBucket {
  bucketIdx: number;
  low: number | null;
  high: number | null;
}

export interface SimPlacement {
  /** wuRound(runningMax) — the whole-°C call, exactly the market's resolution grain. */
  predictedNativeC: number;
  /** Index of the ladder bucket that whole-°C value lands in. */
  bucketIdx: number;
  /** Market ask (price per YES share, in (0,1]) at the lock hour — the recorded odds. */
  ask: number;
  stakeUsd: number;
  /** stake / ask — YES shares bought, each worth $1 if the bucket wins. */
  shares: number;
  feeRate: number;
}

export interface SimGrade {
  won: boolean;
  /** Net of the taker fee — the value that accumulates into the running total. */
  pnlUsd: number;
  /** Gross USD returned on settlement (shares on a win, else 0). */
  payoutUsd: number;
  feeUsd: number;
}

/** Convert a continuous running-max °C into the whole-°C value the market resolves on. */
export function predictedNativeC(runningMaxC: number): number {
  return wuRound(runningMaxC);
}

function toBucketDefs(ladder: SimLadderBucket[]): BucketDef[] {
  // winningBucket scans in array order and relies on tail nulls; keep ladder order.
  return ladder.map((b) => ({ low: b.low, high: b.high, unit: 'C' as const }));
}

/**
 * Index of the market bucket whose native range contains our whole-°C prediction.
 * Throws LadderGapError (via winningBucket) only on a malformed ladder with no covering
 * bucket — impossible on a valid tail-terminated ladder, surfaced loudly if it happens.
 */
export function predictedBucketIdx(ladder: SimLadderBucket[], runningMaxC: number): number {
  const pos = winningBucket(toBucketDefs(ladder), predictedNativeC(runningMaxC));
  return ladder[pos]!.bucketIdx;
}

/**
 * Build a fixed-stake YES placement on our predicted bucket at the given ask. Returns
 * null when the odds are unusable (no live quote, or a degenerate price) — a no-bet day,
 * not a loss. ask must be in (0,1]; a 0/▒ ask would imply infinite shares.
 */
export function placeSimBet(
  ladder: SimLadderBucket[],
  runningMaxC: number,
  ask: number | null | undefined,
  opts: { stakeUsd?: number; feeRate?: number } = {},
): SimPlacement | null {
  if (ask == null || !Number.isFinite(ask) || ask <= 0 || ask > 1) return null;
  if (!Number.isFinite(runningMaxC)) return null;
  const stakeUsd = opts.stakeUsd ?? AMSTERDAM_SIM_STAKE_USD;
  const feeRate = opts.feeRate ?? 0;
  const pos = winningBucket(toBucketDefs(ladder), predictedNativeC(runningMaxC));
  return {
    predictedNativeC: predictedNativeC(runningMaxC),
    bucketIdx: ladder[pos]!.bucketIdx,
    ask,
    stakeUsd,
    shares: stakeUsd / ask,
    feeRate,
  };
}

/**
 * Resolve a placement against the actual winning bucket index. P&L mirrors the house
 * backtest: win → shares·(1−ask) profit; loss → −stake; both net of the taker fee
 * (charged on the trade regardless of outcome).
 */
export function gradeSimBet(p: SimPlacement, winnerIdx: number): SimGrade {
  const feeUsd = takerFeeTotal(p.ask, p.shares, p.feeRate);
  const won = p.bucketIdx === winnerIdx;
  return {
    won,
    payoutUsd: won ? p.shares : 0,
    pnlUsd: (won ? p.shares * (1 - p.ask) : -p.stakeUsd) - feeUsd,
    feeUsd,
  };
}

/**
 * Expected value per $1 staked, fee-free — the analysis lens for ranking lock hours:
 * EV = hitRate/ask − 1. Positive only when our hit rate beats the market's implied
 * price on our bucket. Returns 0 for a non-positive ask (no quote → no signal).
 */
export function evPerDollar(hitRate: number, ask: number): number {
  if (!Number.isFinite(ask) || ask <= 0) return 0;
  return hitRate / ask - 1;
}

// --- planners: the seam the edge function (Deno) and backfill script (Node) share -----
// Both fetch inputs their own way (DbPort.rpc vs ScriptDb.query) and write their own way,
// but the DECISION — which bet to place at which odds, and how it resolves — runs here once.

/** One arm's reconstructable state: the running max and the per-bucket ask, both as of hour H. */
export interface PlaceArmInput {
  hour: number;
  /** max running °C known by hour H (intraday_advances.max_tenths_c is already °C). */
  runMaxC: number;
  /** Forward-filled best_ask per bucket as of the end of hour H (null = no quote). */
  asks: { bucketIdx: number; ask: number | null }[];
}

/** Everything needed to place a day's arms — produced by the amsterdam_sim_place_inputs RPC. */
export interface PlaceInputs {
  targetDate: string;
  eventId: string;
  feeRate: number;
  ladder: SimLadderBucket[];
  /** Labels keyed by bucketIdx, for storage/readability (optional). */
  labels?: Record<number, string>;
  arms: PlaceArmInput[];
}

/** A placement ready to persist (one row per (targetDate, armHour)). */
export interface PlacementRow {
  targetDate: string;
  armHour: number;
  eventId: string;
  predictedNativeC: number;
  bucketIdx: number;
  label: string | null;
  ask: number;
  stakeUsd: number;
  shares: number;
  feeRate: number;
  /** The running max (°C) that drove the prediction — stored for the log. */
  runMaxC: number;
}

/**
 * Decide the bets to place for a day from its reconstructed per-arm state. An arm with no
 * usable quote on our predicted bucket is silently skipped (a no-bet day for that arm —
 * never a phantom loss). Deterministic and side-effect-free, so the edge function and the
 * backfill produce byte-identical placements from the same inputs.
 */
export function planPlacements(input: PlaceInputs, opts: { stakeUsd?: number } = {}): PlacementRow[] {
  const out: PlacementRow[] = [];
  for (const arm of input.arms) {
    const idx = predictedBucketIdx(input.ladder, arm.runMaxC);
    const ask = arm.asks.find((a) => a.bucketIdx === idx)?.ask;
    const place = placeSimBet(input.ladder, arm.runMaxC, ask, {
      stakeUsd: opts.stakeUsd,
      feeRate: input.feeRate,
    });
    if (!place) continue;
    out.push({
      targetDate: input.targetDate,
      armHour: arm.hour,
      eventId: input.eventId,
      predictedNativeC: place.predictedNativeC,
      bucketIdx: place.bucketIdx,
      label: input.labels?.[place.bucketIdx] ?? null,
      ask: place.ask,
      stakeUsd: place.stakeUsd,
      shares: place.shares,
      feeRate: place.feeRate,
      runMaxC: arm.runMaxC,
    });
  }
  return out;
}

/** A pending bet plus its now-known resolution — produced by amsterdam_sim_grade_inputs. */
export interface GradeInputRow {
  betId: string;
  bucketIdx: number;
  ask: number;
  shares: number;
  stakeUsd: number;
  feeRate: number;
  /** Bucket the finalized actual landed in (the integer-containment winner). */
  winnerIdx: number;
  /** Finalized actual in native °C (for the log). */
  actualNativeC: number;
}

export interface SettlementRow {
  betId: string;
  won: boolean;
  pnlUsd: number;
  feeUsd: number;
  winnerIdx: number;
  actualNativeC: number;
}

/** Resolve a batch of pending bets against their known winners — pure, mirrors gradeSimBet. */
export function planSettlements(rows: GradeInputRow[]): SettlementRow[] {
  return rows.map((r) => {
    const g = gradeSimBet(
      {
        predictedNativeC: 0, // unused by gradeSimBet — the bucketIdx carries the decision
        bucketIdx: r.bucketIdx,
        ask: r.ask,
        stakeUsd: r.stakeUsd,
        shares: r.shares,
        feeRate: r.feeRate,
      },
      r.winnerIdx,
    );
    return {
      betId: r.betId,
      won: g.won,
      pnlUsd: g.pnlUsd,
      feeUsd: g.feeUsd,
      winnerIdx: r.winnerIdx,
      actualNativeC: r.actualNativeC,
    };
  });
}
