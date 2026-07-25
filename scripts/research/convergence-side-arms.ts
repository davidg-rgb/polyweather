/**
 * scripts/research/convergence-side-arms — the INVERSE-SIDE (NO) and HOLD-TO-RESOLUTION arms, computed as pure
 * ARITHMETIC over the per-trade rows `convergence-capture-score --out` already emitted.
 *
 * WHY THIS IS NOT A SECOND ENGINE. Both arms bet on the SAME executed population the bracket run produced —
 * identical select rule, identical entry cap / depth floor / runway / flat-open gate, identical fill tick. Only the
 * SIDE and the EXIT change. Re-simulating them would silently re-open every one of those knobs; replaying the rows
 * cannot. If a row is not in the artifact, no arm gets to trade it.
 *
 * THE THREE ARMS (per share; `payoff` is the $1-or-$0 settle):
 *   BRACKET  — the as-run YES bracket, straight off `netReturn`. Included ONLY as the like-for-like baseline the
 *              other two are read against, so the same depth filter applies to all three.
 *   NO       — buy NO on the SAME bucket at the SAME fill tick. Cost basis `1 − entryExecBid`: the YES bid is the
 *              NO ask, and it is the EXECUTABLE (depth-walked) bid, never `entryBestBid` — top-of-book would price
 *              a fill nobody could get and flatter the arm by exactly the amount that matters. Payoff 1 when the
 *              bucket LOST. Always a TAKER (you are lifting the YES bid), so the fee always applies.
 *   HOLD     — buy YES at what we actually paid and simply never sell: payoff 1 when the bucket WON. Entry fee only
 *              (a resolution redeem is free, and a maker entry paid $0 — `isMaker` is honored, not overridden).
 *
 * THE DEPTH FLOOR IS THE POINT, NOT A ROBUSTNESS CHECK. Each arm is scored at $0 / $50 / $150 of executable size —
 * `entrySellbackDepthUsd` (the YES BID side) for NO, `entryDepthUsd` (the ASK side) for BRACKET/HOLD. $0 is the
 * QUOTED-PRICE fiction and is reported only so the decay is visible: CROSS-VENUE-SPIKE.md killed a signal that
 * looked +EV on quotes and died at 1–10 contracts of true depth, and the NO arm's own capacity is the thinner side
 * of an already-thin book. Read the $0 column as "what a paper model would have claimed", never as an achievable
 * result.
 *
 * TWO STATISTICAL TRAPS THIS HANDLES EXPLICITLY:
 *   1. INVERTED TAIL. NO risks ~$0.86 to win ~$0.14, so the loss is ~6× the win and the per-bet distribution is
 *      hard left-skewed. mean ± z·SE assumes symmetry it does not have, so a SEEDED PERCENTILE BOOTSTRAP is
 *      reported alongside — and it is a CLUSTER bootstrap (resample whole cities / whole days), because resampling
 *      rows would treat 17 same-city bets as 17 independent draws and shrink the interval by ~√17.
 *   2. THE DEGENERATE $1.00 NO. When the YES bucket shows no bid, `1 − entryExecBid` = $1.00: the arithmetic says
 *      "risk $1 to win $1", i.e. a free option that loses only when the bucket wins. No such trade exists — there is
 *      nothing to lift. Those rows are COUNTED (`nDegeneratePrice`) and reported, and any depth floor above $0
 *      removes them by construction. A NO arm that looks good only at floor $0 is made of them.
 *
 * The clustered CI is `clusteredMeanCi` IMPORTED from the gate's own module, not a re-derivation — an arm scored
 * with a differently-rounded t-table than the gate that killed the bracket is not a comparison.
 *
 * Read-only + DB-free: reads `--in` artifacts, writes `--out`. Places nothing, imports no trading code.
 *
 * Run:
 *   pnpm tsx scripts/research/convergence-side-arms.ts --in scripts/research/out/cap-M0-off.json \
 *     --out scripts/research/out/side-arms.json
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { clusteredMeanCi } from '../../packages/core/src/sim/opening-convergence.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';
import type { TradeRow, SelectRuleId } from './convergence-capture-score.ts';

export const SCRIPT = 'convergence-side-arms';

export const DEFAULT_DEPTH_FLOORS = [0, 50, 150];
export const DEFAULT_FEE_RATE = 0.05;
export const DEFAULT_BOOT_ITERS = 5000;
export const DEFAULT_SEED = 20260724;
/** a NO cost basis at or above this is the no-bid fiction, not a quote (see the header's trap #2). */
export const DEGENERATE_NO_PRICE = 0.99;

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const spct = (v: number, d = 1): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${pct(v, d)}` : '—');
const cents = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}¢` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `$${v.toFixed(0)}` : '—');
const meanOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · one row → one arm bet (pure; null = this row cannot express this arm)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ArmId = 'BRACKET' | 'NO' | 'HOLD';

/** One row reduced to a single side's economics. `edgePerShare` is in probability points ($ per $1 of payoff). */
export interface ArmBet {
  eventId: string;
  city: string;
  targetDate: string;
  /** what one share cost, before fee. */
  price: number;
  /** the taker fee actually charged on that share (0 for a maker YES entry). */
  fee: number;
  /** $1 if this side settled in the money, else $0. NaN for BRACKET (it exits before resolution). */
  payoff: number;
  /** payoff − price − fee. The honest per-share edge. */
  edgePerShare: number;
  /** edgePerShare / (price + fee) — return on capital actually put up, fee included in the denominator. */
  edgePerDollar: number;
  /** the executable size backing THIS side (bid-side $ for NO, ask-side $ for BRACKET/HOLD). */
  depthUsd: number;
  /** did this side make money. */
  won: boolean;
}

/** Why a row could not be turned into a bet — surfaced so an arm is never quietly scored on a subset. */
export interface ArmDrops {
  noPrice: number;
  unknownResolution: number;
  belowDepthFloor: number;
}

const perDollar = (edge: number, price: number, fee: number): number => {
  const stake = price + fee;
  return stake > 0 ? edge / stake : NaN;
};

/**
 * NO on the same bucket at the same fill tick. Requires `entryExecBid` — `entryBestBid` is NOT an acceptable
 * substitute (top-of-book is a size-1 quote; the arm's whole question is whether size exists).
 */
export function noArmBet(r: TradeRow, feeRate: number): ArmBet | null {
  if (!fin(r.entryExecBid) || r.bucketWon == null) return null;
  const price = 1 - r.entryExecBid;
  if (!(price > 0 && price <= 1)) return null;
  const fee = takerFeePerShare(price, feeRate); // buying NO lifts the YES bid ⇒ always a taker
  const payoff = r.bucketWon === false ? 1 : 0;
  const edgePerShare = payoff - price - fee;
  return {
    eventId: r.eventId, city: r.city, targetDate: r.targetDate,
    price, fee, payoff, edgePerShare, edgePerDollar: perDollar(edgePerShare, price, fee),
    depthUsd: r.entrySellbackDepthUsd ?? 0,
    won: edgePerShare > 0,
  };
}

/** YES at the price actually paid, held to the settle. Entry fee only, and $0 of it when the entry was a maker. */
export function holdArmBet(r: TradeRow, feeRate: number): ArmBet | null {
  if (!fin(r.entryPrice) || r.bucketWon == null) return null;
  const price = r.entryPrice;
  if (!(price > 0 && price <= 1)) return null;
  const fee = r.isMaker ? 0 : takerFeePerShare(price, feeRate);
  const payoff = r.bucketWon === true ? 1 : 0;
  const edgePerShare = payoff - price - fee;
  return {
    eventId: r.eventId, city: r.city, targetDate: r.targetDate,
    price, fee, payoff, edgePerShare, edgePerDollar: perDollar(edgePerShare, price, fee),
    depthUsd: r.entryDepthUsd ?? 0,
    won: edgePerShare > 0,
  };
}

/**
 * The as-run bracket, straight off the engine's `netReturn` (fees already inside it). Kept in the same table so
 * every comparison is filtered identically; `payoff` is NaN because this arm exits before resolution.
 */
export function bracketBet(r: TradeRow, _feeRate: number): ArmBet | null {
  if (!fin(r.netReturn) || !fin(r.entryPrice)) return null;
  const price = r.entryPrice;
  return {
    eventId: r.eventId, city: r.city, targetDate: r.targetDate,
    price, fee: NaN, payoff: NaN,
    edgePerShare: r.netReturn * price, // netReturn is per $ staked; × price ⇒ back to per-share
    edgePerDollar: r.netReturn,
    depthUsd: r.entryDepthUsd ?? 0,
    won: r.netReturn > 0,
  };
}

export const ARM_BUILDERS: Record<ArmId, (r: TradeRow, feeRate: number) => ArmBet | null> = {
  BRACKET: bracketBet,
  NO: noArmBet,
  HOLD: holdArmBet,
};

/** Build one arm's bets at one depth floor, counting every row that fell out and why. */
export function buildArm(
  rows: readonly TradeRow[],
  arm: ArmId,
  feeRate: number,
  depthFloorUsd: number,
): { bets: ArmBet[]; drops: ArmDrops } {
  const drops: ArmDrops = { noPrice: 0, unknownResolution: 0, belowDepthFloor: 0 };
  const bets: ArmBet[] = [];
  for (const r of rows) {
    if (arm !== 'BRACKET' && r.bucketWon == null) { drops.unknownResolution++; continue; }
    const bet = ARM_BUILDERS[arm](r, feeRate);
    if (bet == null) { drops.noPrice++; continue; }
    if (bet.depthUsd < depthFloorUsd) { drops.belowDepthFloor++; continue; }
    bets.push(bet);
  }
  return { bets, drops };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · the estimators — clustered t-CI (shared with the gate) + a seeded CLUSTER bootstrap
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface Ci { mean: number; ciLow: number; ciHigh: number; nClusters: number }

export function clusterCi(bets: readonly ArmBet[], keyOf: (b: ArmBet) => string, valueOf: (b: ArmBet) => number): Ci {
  if (bets.length === 0) return { mean: NaN, ciLow: NaN, ciHigh: NaN, nClusters: 0 };
  const { groupMeans, mean, ciLow, ciHigh } = clusteredMeanCi(bets, keyOf, valueOf);
  return { mean, ciLow, ciHigh, nClusters: groupMeans.length };
}

/**
 * Seeded percentile bootstrap on the CLUSTERED mean. Resamples whole clusters with replacement (C draws of the C
 * cluster means), which is the resample that matches the clustered estimand — an iid ROW bootstrap would treat
 * every bet in a city as independent and return an interval ~√(rows per cluster) too narrow.
 *
 * `clusterUnit: 'row'` deliberately does that iid resample anyway, reported side-by-side so the size of the
 * clustering correction is visible rather than asserted. mulberry32 ⇒ byte-identical across runs.
 */
export function clusterBootstrapCi(
  bets: readonly ArmBet[],
  keyOf: (b: ArmBet) => string,
  valueOf: (b: ArmBet) => number,
  opts: { iters?: number; seed?: number; alpha?: number; clusterUnit?: 'cluster' | 'row' } = {},
): { lo: number; hi: number; n: number } {
  const iters = opts.iters ?? DEFAULT_BOOT_ITERS;
  const alpha = opts.alpha ?? 0.05;
  const rand = mulberry32(opts.seed ?? DEFAULT_SEED);
  const units = opts.clusterUnit === 'row'
    ? bets.map((b) => valueOf(b))
    : [...new Set(bets.map(keyOf))].map((k) => {
      const cr = bets.filter((b) => keyOf(b) === k);
      return cr.reduce((a, b) => a + valueOf(b), 0) / cr.length;
    });
  const n = units.length;
  if (n < 2) return { lo: NaN, hi: NaN, n };
  const means = new Array<number>(iters);
  for (let i = 0; i < iters; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += units[Math.floor(rand() * n)]!;
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  const q = (p: number): number => {
    const pos = (means.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? means[lo]! : means[lo]! * (hi - pos) + means[hi]! * (pos - lo);
  };
  return { lo: q(alpha / 2), hi: q(1 - alpha / 2), n };
}

/** A MECHANICAL description of where an interval sits — NOT a §9R-E verdict, which this script never renders. */
export type CiSign = 'POSITIVE_EXCLUDES_0' | 'NEGATIVE_EXCLUDES_0' | 'STRADDLES_0' | 'UNDEFINED';
export function ciSign(lo: number, hi: number): CiSign {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 'UNDEFINED';
  if (lo > 0) return 'POSITIVE_EXCLUDES_0';
  if (hi < 0) return 'NEGATIVE_EXCLUDES_0';
  return 'STRADDLES_0';
}

/**
 * The §9R-E power floors, applied to an ARM cell. Not decoration — a depth floor shrinks a panel fast, and the
 * cells it shrinks hardest are exactly the ones that come back with the most exciting sign.
 */
export const MIN_N = 40;
export const MIN_CITIES = 6;
export const MIN_DAYS = 7;

/** Why a cell must not be read as evidence, '' when it may be. */
export function powerWarning(n: number, nCities: number, nDays: number, winFrac: number): string {
  const parts: string[] = [];
  if (n < MIN_N || nCities < MIN_CITIES || nDays < MIN_DAYS) {
    parts.push(`UNDERPOWERED (n ${n}/${MIN_N} · ${nCities}/${MIN_CITIES} cities · ${nDays}/${MIN_DAYS} days)`);
  }
  // A cell where EVERY bet won (or every bet lost) has zero outcome variance, so the clustered t-CI measures the
  // spread of PRICES, not of results — it collapses toward a point mass and "excludes 0" no matter how few rows
  // produced it. This is the exact shape of a false positive, so it is named rather than left for the reader.
  if (n > 0 && (winFrac === 0 || winFrac === 1)) {
    parts.push(`CONSTANT OUTCOME (${winFrac === 1 ? 'every' : 'no'} bet won ⇒ the CI reflects price spread, not risk)`);
  }
  return parts.join(' · ');
}

export interface ArmSummary {
  arm: ArmId;
  depthFloorUsd: number;
  n: number;
  drops: ArmDrops;
  nWins: number;
  winFrac: number;
  meanPrice: number;
  meanDepthUsd: number;
  medianDepthUsd: number;
  /** NO rows priced ≥ DEGENERATE_NO_PRICE — the no-bid fiction (header trap #2). 0 for the other arms. */
  nDegeneratePrice: number;
  meanEdgePerShare: number;
  meanEdgePerDollar: number;
  /** clustered t-CIs on the per-SHARE edge (the natural unit for an inverse-side bet). */
  perShareCityCi: Ci;
  perShareDayCi: Ci;
  /** clustered t-CIs on the per-$1 return (the gate's unit — directly comparable to the bracket verdict). */
  perDollarCityCi: Ci;
  perDollarDayCi: Ci;
  /** seeded percentile bootstraps on the per-SHARE edge: city clusters, day clusters, and the iid row resample. */
  bootPerShareCity: { lo: number; hi: number; n: number };
  bootPerShareDay: { lo: number; hi: number; n: number };
  bootPerShareRowIid: { lo: number; hi: number; n: number };
  /** mechanical read of the CITY-clustered per-share interval. Descriptive only. */
  sign: CiSign;
  bootSign: CiSign;
  /** non-empty ⇒ this cell is below the §9R-E power floor and/or has no outcome variance: NOT evidence. */
  powerWarning: string;
}

export function summarizeArm(
  bets: ArmBet[],
  drops: ArmDrops,
  arm: ArmId,
  depthFloorUsd: number,
  opts: { iters?: number; seed?: number } = {},
): ArmSummary {
  const perShare = (b: ArmBet): number => b.edgePerShare;
  const perDol = (b: ArmBet): number => b.edgePerDollar;
  const byCity = (b: ArmBet): string => b.city;
  const byDay = (b: ArmBet): string => b.targetDate;
  const depths = bets.map((b) => b.depthUsd).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const perShareCityCi = clusterCi(bets, byCity, perShare);
  const perShareDayCi = clusterCi(bets, byDay, perShare);
  const boot = clusterBootstrapCi(bets, byCity, perShare, opts);
  const winFrac = bets.length ? bets.filter((b) => b.won).length / bets.length : NaN;
  return {
    arm,
    depthFloorUsd,
    n: bets.length,
    drops,
    nWins: bets.filter((b) => b.won).length,
    winFrac,
    meanPrice: meanOf(bets.map((b) => b.price).filter((v) => Number.isFinite(v))),
    meanDepthUsd: meanOf(depths),
    medianDepthUsd: depths.length ? depths[Math.floor((depths.length - 1) / 2)]! : NaN,
    nDegeneratePrice: arm === 'NO' ? bets.filter((b) => b.price >= DEGENERATE_NO_PRICE).length : 0,
    meanEdgePerShare: meanOf(bets.map(perShare)),
    meanEdgePerDollar: meanOf(bets.map(perDol).filter((v) => Number.isFinite(v))),
    perShareCityCi,
    perShareDayCi,
    perDollarCityCi: clusterCi(bets, byCity, perDol),
    perDollarDayCi: clusterCi(bets, byDay, perDol),
    bootPerShareCity: boot,
    bootPerShareDay: clusterBootstrapCi(bets, byDay, perShare, opts),
    bootPerShareRowIid: clusterBootstrapCi(bets, byCity, perShare, { ...opts, clusterUnit: 'row' }),
    sign: ciSign(perShareCityCi.ciLow, perShareCityCi.ciHigh),
    bootSign: ciSign(boot.lo, boot.hi),
    powerWarning: powerWarning(bets.length, perShareCityCi.nClusters, perShareDayCi.nClusters, winFrac),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · one artifact → every (arm × depth floor) cell
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The subset of a capture artifact this script reads (structurally typed — it never needs the whole panel). */
export interface CaptureArtifact {
  params?: { select?: SelectRuleId; houseEdge?: boolean; cities?: string; feeRate?: number; requireRuleTarget?: boolean };
  tradeRowsMeta?: { headlineTp?: number; nExecutedPerTp?: number; nUnknownResolution?: number };
  panel?: { headlineTp?: number; perTp?: { tpDeltaPp: number; label?: string; nMarkets?: number }[] };
  tradeRows?: TradeRow[];
}

export interface ArtifactArms {
  source: string;
  select: SelectRuleId;
  houseEdge: boolean;
  cities: string;
  headlineTp: number;
  bracketLabel: string;
  nHeadlineRows: number;
  nUnknownResolution: number;
  arms: ArmSummary[];
}

export function analyzeArtifact(
  art: CaptureArtifact,
  source: string,
  opts: { feeRate?: number; depthFloors?: number[]; iters?: number; seed?: number } = {},
): ArtifactArms {
  const feeRate = opts.feeRate ?? art.params?.feeRate ?? DEFAULT_FEE_RATE;
  const floors = opts.depthFloors ?? DEFAULT_DEPTH_FLOORS;
  const headlineTp = art.panel?.headlineTp ?? art.tradeRowsMeta?.headlineTp ?? 0.25;
  const rows = (art.tradeRows ?? []).filter((r) => r.tpDeltaPp === headlineTp);
  const arms: ArmSummary[] = [];
  for (const arm of ['BRACKET', 'NO', 'HOLD'] as const) {
    for (const floor of floors) {
      const { bets, drops } = buildArm(rows, arm, feeRate, floor);
      arms.push(summarizeArm(bets, drops, arm, floor, { iters: opts.iters, seed: opts.seed }));
    }
  }
  return {
    source,
    select: art.params?.select ?? 'M0',
    houseEdge: art.params?.houseEdge ?? true,
    cities: art.params?.cities ?? 'bot',
    headlineTp,
    bracketLabel: art.panel?.perTp?.find((r) => r.tpDeltaPp === headlineTp)?.label ?? '—',
    nHeadlineRows: rows.length,
    nUnknownResolution: rows.filter((r) => r.bucketWon == null).length,
    arms,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · report
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function report(results: ArtifactArms[], feeRate: number, log: (m: string) => void): void {
  log('=== convergence-side-arms · the NO and HOLD arms on the SAME executed population ===');
  log(
    `  taker fee ${pct(feeRate)} (rate·p·(1−p)) · NO pays 1 − entryExecBid (executable bid, NOT top-of-book) and is ` +
      'ALWAYS a taker · HOLD honors the maker entry ($0 fee) and pays no exit fee (resolution redeem).',
  );
  log('  depth floors are executable size at the FILL tick: entrySellbackDepthUsd (bid side) for NO,');
  log('  entryDepthUsd (ask side) for BRACKET/HOLD. The $0 row is the QUOTED-PRICE FICTION — reported so the');
  log('  decay is visible, never as an achievable number.');
  log('  CIs: city/day-clustered t (the gate\'s own clusteredMeanCi) + a seeded CLUSTER bootstrap, because a NO bet');
  log('  risks ~86¢ to win ~14¢ and mean ± z·SE assumes a symmetry that inverted tail does not have.');
  for (const res of results) {
    log('');
    log(
      `── ${basename(res.source)} · select ${res.select} · house-edge ${res.houseEdge ? 'on' : 'off'} · cities ` +
        `${res.cities} · TP +${pct(res.headlineTp, 0)} · bracket verdict ${res.bracketLabel} · ` +
        `${res.nHeadlineRows} executed rows (${res.nUnknownResolution} unresolved) ──`,
    );
    log(
      `  ${'arm'.padEnd(8)} ${'floor'.padStart(6)}  ${'n'.padStart(4)}  ${'win%'.padStart(6)}  ${'price'.padStart(6)}  ` +
        `${'medDep'.padStart(7)}  ${'edge/sh'.padStart(8)}  ${'cityCI/sh'.padStart(20)}  ${'bootCI/sh'.padStart(20)}  ` +
        `${'edge/$1'.padStart(8)}  ${'cityCI/$1'.padStart(20)}  read`,
    );
    for (const a of res.arms) {
      const deg = a.nDegeneratePrice > 0 ? ` ⚠${a.nDegeneratePrice}@$1.00` : '';
      // a cell below the §9R-E floor never gets to show a sign — that is how a 10-row all-winners cell
      // reads as "positive, CI excludes 0" and becomes a finding nobody can reproduce.
      const read = a.powerWarning ? `✗ ${a.powerWarning}` : (a.sign === a.bootSign ? a.sign : `${a.sign}/boot ${a.bootSign}`);
      log(
        `  ${a.arm.padEnd(8)} ${usd(a.depthFloorUsd).padStart(6)}  ${String(a.n).padStart(4)}  ` +
          `${pct(a.winFrac, 1).padStart(6)}  ${(Number.isFinite(a.meanPrice) ? a.meanPrice.toFixed(3) : '—').padStart(6)}  ` +
          `${usd(a.medianDepthUsd).padStart(7)}  ${cents(a.meanEdgePerShare).padStart(8)}  ` +
          `${`[${cents(a.perShareCityCi.ciLow)}, ${cents(a.perShareCityCi.ciHigh)}]`.padStart(20)}  ` +
          `${`[${cents(a.bootPerShareCity.lo)}, ${cents(a.bootPerShareCity.hi)}]`.padStart(20)}  ` +
          `${spct(a.meanEdgePerDollar).padStart(8)}  ` +
          `${`[${pct(a.perDollarCityCi.ciLow)}, ${pct(a.perDollarCityCi.ciHigh)}]`.padStart(20)}  ` +
          `${read}${deg}`,
      );
    }
    const no0 = res.arms.find((a) => a.arm === 'NO' && a.depthFloorUsd === 0);
    if (no0) {
      log(
        `  NO drops @$0 floor: ${no0.drops.noPrice} no executable bid · ${no0.drops.unknownResolution} unresolved · ` +
          `${no0.drops.belowDepthFloor} below floor. At $50: ${res.arms.find((a) => a.arm === 'NO' && a.depthFloorUsd === 50)?.drops.belowDepthFloor ?? '—'} below floor.`,
      );
    }
  }
  log('');
  log('  READ THE $0 ROW AS FICTION. Quoted-price economics with no size behind them is the exact shape that');
  log('  produced a FALSE PASS in CROSS-VENUE-SPIKE (winFrac 0.857 on a 24h-volume proxy → 0 on true depth).');
  log(`  A "✗" cell is below the §9R-E floor (n ≥ ${MIN_N} · ${MIN_CITIES} cities · ${MIN_DAYS} days) and/or has a`);
  log('  CONSTANT outcome, so its interval is narrow for want of variance, not for want of risk. Those cells are');
  log('  shown with their numbers but WITHOUT a sign read, on purpose — they are not evidence in either direction.');
  log('  Nothing here is a §9R-E verdict: this script re-scores an already-executed population and renders no gate.');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5 · self-test (no I/O)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function sanity(): void {
  const row = (over: Partial<TradeRow> = {}): TradeRow => ({
    eventId: 'E1', city: 'ankara', targetDate: '2026-07-10', bucketIdx: 3, entryLabel: '30°C',
    entryAgeH: 0.2, entryPrice: 0.2, isMaker: false, entryBestBid: 0.15, entryExecBid: 0.14,
    entryDepthUsd: 200, entrySellbackDepthUsd: 200, exitReason: 'take_profit:x', exitPrice: 0.3,
    stakeUsd: 5, netPnlUsd: 1, netReturn: 0.2, bestReachableBid: 0.3, winnerIdx: 3, bucketWon: true,
    tpDeltaPp: 0.25, select: 'M0', houseEdge: true, ...over,
  });
  // NO on a bucket that WON is a total loss of the 86¢ put up
  const lost = noArmBet(row(), 0.05)!;
  if (Math.abs(lost.price - 0.86) > 1e-12) throw new Error('sanity: NO price = 1 − execBid');
  if (lost.payoff !== 0 || lost.edgePerShare >= 0) throw new Error('sanity: NO loses when the bucket wins');
  // …and wins ~14¢ minus fee when it loses
  const won = noArmBet(row({ bucketWon: false }), 0.05)!;
  if (Math.abs(won.edgePerShare - (1 - 0.86 - 0.05 * 0.86 * 0.14)) > 1e-12) throw new Error('sanity: NO edge');
  if (!won.won) throw new Error('sanity: NO win flag');
  // no executable bid ⇒ not expressible, never silently priced at 0¢
  if (noArmBet(row({ entryExecBid: null }), 0.05) !== null) throw new Error('sanity: NO needs execBid');
  // unknown resolution is dropped, not scored as a loss
  if (noArmBet(row({ bucketWon: null, winnerIdx: null }), 0.05) !== null) throw new Error('sanity: NO needs resolution');
  // HOLD: a maker entry pays NO fee
  const hm = holdArmBet(row({ isMaker: true }), 0.05)!;
  if (hm.fee !== 0 || Math.abs(hm.edgePerShare - 0.8) > 1e-12) throw new Error('sanity: HOLD maker fee-free');
  const ht = holdArmBet(row({ isMaker: false }), 0.05)!;
  if (Math.abs(ht.fee - 0.05 * 0.2 * 0.8) > 1e-12) throw new Error('sanity: HOLD taker fee');
  // the depth floor bites on the SIDE's own book
  const rows = [row(), row({ eventId: 'E2', entrySellbackDepthUsd: 10 })];
  if (buildArm(rows, 'NO', 0.05, 50).bets.length !== 1) throw new Error('sanity: NO depth floor');
  if (buildArm(rows, 'NO', 0.05, 50).drops.belowDepthFloor !== 1) throw new Error('sanity: NO depth drop count');
  if (buildArm(rows, 'HOLD', 0.05, 50).bets.length !== 2) throw new Error('sanity: HOLD reads ask-side depth');
  // report + summarize are total on an empty arm
  const empty = buildArm([], 'NO', 0.05, 0);
  const s = summarizeArm(empty.bets, empty.drops, 'NO', 0, { iters: 10 });
  if (s.n !== 0 || s.sign !== 'UNDEFINED') throw new Error('sanity: empty arm');
  report([analyzeArtifact({ tradeRows: [], panel: { headlineTp: 0.25 } }, 'x', { iters: 10 })], 0.05, () => {});
  if (ciSign(0.1, 0.2) !== 'POSITIVE_EXCLUDES_0' || ciSign(-0.2, 0.1) !== 'STRADDLES_0') throw new Error('sanity: ciSign');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6 · CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  const { values } = parseArgs({
    options: {
      in: { type: 'string' },
      depths: { type: 'string' },
      'fee-rate': { type: 'string' },
      iters: { type: 'string' },
      seed: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const inputs = String(values.in ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (inputs.length === 0) throw new Error('--in <artifact.json[,artifact2.json…]> is required');
  const depthFloors = values.depths != null
    ? String(values.depths).split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v) && v >= 0)
    : DEFAULT_DEPTH_FLOORS;
  const feeRate = Math.max(0, Number(values['fee-rate'] ?? DEFAULT_FEE_RATE) || 0);
  const iters = values.iters != null ? Math.max(100, Math.floor(Number(values.iters) || 0)) : DEFAULT_BOOT_ITERS;
  const seed = values.seed != null ? Math.floor(Number(values.seed) || 0) : DEFAULT_SEED;

  process.stderr.write(`${SCRIPT} · ${new Date().toISOString()} · ${inputs.length} artifact(s) · DB-free, read-only\n`);
  const results = inputs.map((p) => {
    const art = JSON.parse(readFileSync(p, 'utf8')) as CaptureArtifact;
    return analyzeArtifact(art, p, { feeRate, depthFloors, iters, seed });
  });
  report(results, feeRate, console.log);

  if (values.out != null) {
    const outPath = String(values.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      `${JSON.stringify(
        { script: SCRIPT, generatedAt: new Date().toISOString(), params: { inputs, depthFloors, feeRate, bootIters: iters, seed }, results },
        null,
        2,
      )}\n`,
      'utf8',
    );
    process.stderr.write(`  artifact → ${outPath} · ${results.length} run(s) × ${results[0]?.arms.length ?? 0} arm×floor cells\n`);
  }
}
