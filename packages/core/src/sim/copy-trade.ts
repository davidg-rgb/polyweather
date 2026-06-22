/**
 * core/sim/copy-trade — the PURE, deterministic copy-trade (fill-mirror) feasibility analytics
 * (WALLET-RECON-HANDOFF.md §11 — the one path to "get as close to badatmath's automated buying
 * protocol as possible" left open after KILL-GATE 2).
 *
 * THE QUESTION KILL-GATE 2 DID NOT ANSWER. KILL-GATE 2 proved our EMOS forecast is *worse* than the
 * day-before market — so running badatmath's protocol on OUR forecast loses money. But badatmath
 * itself BEATS the market (KILL-GATE 1: real edge). The only replication path left is to MIRROR its
 * revealed bucket choices — copy-trade — riding its superior forecast for free. The handoff dismissed
 * this as "structurally a late follower in thin books" but never MEASURED it. This module measures it:
 * for each badatmath BUY fill, joined to the bucket's `market_snapshots` book time-series and its
 * resolution, it asks whether a FOLLOWER who detects the fill and TAKES the ask can still net a
 * positive EV after the spread, the taker fee, and a realistic detection lag.
 *
 * WHY TAKE THE ASK (the honest follower price). badatmath rests MAKER bids at cheap prices (it earns
 * MAKER_REBATE) — a follower cannot out-rest a maker who is already there in a thin book, so to
 * guarantee a fill after seeing the trade it must TAKE (cross to the ask). The taker fee
 * (`takerFeeTotal`, rate·p·(1−p)) is charged; badatmath's maker rebate is NOT available to the
 * follower. If even taking-at-the-ask is +EV, copy-trading is viable; if not, the "late follower"
 * intuition is confirmed quantitatively. This is the conservative, correct framing.
 *
 * THE 30-MIN SNAPSHOT GRID (the binding limitation, surfaced honestly). `market_snapshots` is captured
 * at ~30-min cadence per bucket — coarser than a 5-min detection lag. So we cannot resolve "the ask
 * exactly L seconds after the fill". The realistic primary entry is therefore the FIRST snapshot
 * at-or-after the fill timestamp (the first book a follower could act on once the trade is public);
 * on a uniform 30-min grid that bakes in ~15 min of post-fill drift on average — conservative for a
 * follower chasing a market moving toward badatmath's pick (the ask rises). The contemporaneous
 * (at-or-before) ask is reported as an optimistic bound, and the maker-at-fill-price as the most
 * optimistic bound.
 *
 * Reuse, don't reimplement (handoff §6 directive): `armEdgeStats` / `bootstrapMeanCi` / `wilsonInterval`
 * from sim/stats.ts (a mirrored bet IS a GradedBet {won, ask}); the fee model from `core/fees.ts`
 * (`takerFeeTotal`) — the SAME fee math the Amsterdam sim grades with, never a bespoke fee here.
 *
 * Idiom: pure + total. An empty fill list returns an empty/zero report, never throws; a fill with no
 * usable snapshot or unknown resolution is dropped from the usable set (and counted). Deterministic —
 * the EV CIs seed mulberry32 via stats.ts, so every run is byte-identical.
 */
import { takerFeeTotal } from '../fees.ts';
import {
  type ArmEdgeStats,
  armEdgeStats,
  bootstrapMeanCi,
  meanConfidenceInterval,
} from './stats.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One row of a bucket's order-book time-series (from market_snapshots), as the mirror needs it. */
export interface BucketSnapshot {
  /** Unix seconds (market_snapshots.captured_at). */
  capturedAt: number;
  /** best_bid in (0,1] or null (no resting bid). */
  bid: number | null;
  /** best_ask in (0,1] or null (no resting ask). */
  ask: number | null;
  /** mid = (bid+ask)/2 (or last_trade fallback) or null. */
  mid: number | null;
}

/**
 * A badatmath BUY fill enriched with everything the mirror needs: the price it paid, the bucket's
 * resolution (did the fill's OUTCOME win), the bucket's fee rate, and the bucket's snapshot book series
 * (ASCENDING by capturedAt — the caller sorts once). A fill with `outcomeWon === null` (unresolved /
 * unknown) or no snapshots is dropped from the usable set.
 */
export interface MirrorFill {
  conditionId: string;
  /** 'Yes' | 'No' — the leg badatmath bought. */
  outcome: string;
  /** badatmath's fill (entry) price in (0,1] — the implied prob it paid as a maker. */
  fillPrice: number;
  sizeShares: number;
  usdcSize: number;
  /** Unix seconds of the fill. */
  timestamp: number;
  citySlug: string | null;
  targetDate: string | null;
  /** Did the leg badatmath bought resolve in the money? null when unresolved/unknown (dropped). */
  outcomeWon: boolean | null;
  /** market_buckets.fee_rate (Polymarket weather fee replica rate; 0.05 everywhere today). */
  feeRate: number;
  /** The bucket's book snapshots, ASCENDING by capturedAt (caller-sorted). */
  snapshots: BucketSnapshot[];
}

/** Knobs for the follower simulation. All have honest, conservative defaults. */
export interface MirrorOpts {
  /** Detection lag in seconds added to the fill time before the follower can act (default 300 = 5 min). */
  detectionLagSec?: number;
  /**
   * Max seconds a follower-entry snapshot may sit AFTER (fill + lag) and still be used (default 3600 =
   * 1h). Beyond this the book is too stale to call a realistic entry → the fill is dropped from the
   * usable set. The 30-min grid means the typical gap is ~15 min; 1h tolerates one missed capture.
   */
  maxEntryStalenessSec?: number;
  /** Only fills with fillPrice < this enter the cheap-longshot study (default 0.25 — the §3 cut). */
  cheapMaxPrice?: number;
  /** Seed for the EV bootstrap CIs (default 42 — the repo reproducibility contract). */
  bootstrapSeed?: number;
}

/** Mean + bootstrap CI of an EV/$1 series (a thin wrapper shape for the report). */
export interface EvCi {
  ev: number;
  evCiLo: number;
  evCiHi: number;
  n: number;
}

/** The per-fill follower outcome (exported for tests / drill-down). */
export interface FollowerEntry {
  fill: MirrorFill;
  /** The snapshot the follower entered on (first at-or-after fill+lag, within staleness), or null. */
  entrySnapshot: BucketSnapshot | null;
  /** Seconds the entry snapshot sat after (fill + lag); NaN when no entry snapshot. */
  entryStalenessSec: number;
  /** The ask the follower paid (entrySnapshot.ask); null when no usable entry. */
  entryAsk: number | null;
  /** Contemporaneous mid at/just-before the fill (the maker/taker reference); null when none. */
  fillMid: number | null;
  /** Last mid before resolution (the drift target); null when none. */
  lastMid: number | null;
  /** fee-net EV per $1 staked TAKING the entry ask; NaN when no usable entry. */
  netEvTaker: number;
  /** fee-net EV per $1 staked TAKING the contemporaneous (at/before fill) ask; NaN when none. */
  netEvTakerContemporaneous: number;
  /** fee-net EV per $1 staked as a MAKER at badatmath's own fill price (optimistic bound). */
  netEvMaker: number;
  /** fillPrice − fillMid: negative ⇒ badatmath bought BELOW the mid (maker/passive). NaN when no mid. */
  fillVsMid: number;
  /** signed mid drift toward badatmath's outcome after the fill (lastMid−fillMid for Yes; negated for No). NaN when missing. */
  driftToward: number;
}

/** The full feasibility report — the pre-registered headline is `followerNet` (taker, fee-net, CI). */
export interface CopyTradeReport {
  /** Total BUY fills passed in. */
  nFills: number;
  /** Cheap (<cheapMaxPrice) BUY fills with a known resolution (the candidate set). */
  nCheapResolved: number;
  /** Of those, the ones with a usable follower entry snapshot (the scored set). */
  nUsable: number;
  /** badatmath's OWN realized edge on the usable set, at its fill price, FEE-FREE (the maker it is). */
  sharpGross: ArmEdgeStats;
  /** Follower TAKING the (post-fill) ask, FEE-FREE — isolates the spread+lag cost from the fee. */
  followerGross: ArmEdgeStats;
  /** ★ PRE-REGISTERED HEADLINE: follower taking the post-fill ask, NET of the taker fee. */
  followerNet: EvCi;
  /** Optimistic bound: follower taking the CONTEMPORANEOUS (≤fill) ask, net of fee. */
  followerNetContemporaneous: EvCi;
  /** Most-optimistic bound: follower as a MAKER at badatmath's own fill price, net of fee. */
  followerNetMaker: EvCi;
  /** followerNet.ev / sharpGross.ev — the fraction of badatmath's gross edge a taker-follower keeps. NaN when sharp ev ≤ 0. */
  capturableFraction: number;
  /** badatmath's maker/taker character: mean fillPrice−mid (negative ⇒ maker) + fraction below mid. */
  fillVsMid: { mean: number; fracBelowMid: number; n: number };
  /** Post-fill price discovery: mean signed mid drift toward badatmath's outcome (positive ⇒ follower room). */
  driftToward: { mean: number; ciLo: number; ciHi: number; n: number };
  /** Entry-snapshot staleness (the 30-min-grid diagnostic), in seconds. */
  entryStaleness: { medianSec: number; p90Sec: number; n: number };
}

/** The adjudication of a report against the pre-registered kill-criterion. */
export interface CopyTradeVerdict {
  /** PASS = the follower fee-net EV 95% CI lower bound clears 0 (copy-trading viable). */
  pass: boolean;
  /** Whether it ALSO clears the operational-margin threshold (default +2% EV/$1). */
  clearsMargin: boolean;
  /** The headline fee-net follower EV + CI used to adjudicate. */
  followerNet: EvCi;
  /** The pre-registered margin threshold (EV/$1) the `clearsMargin` flag uses. */
  marginThreshold: number;
  /** One-line human verdict. */
  summary: string;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// snapshot lookups (the series is ASCENDING by capturedAt)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Last snapshot with capturedAt ≤ t (the contemporaneous book), or null. Linear scan (series are short). */
export function snapshotAtOrBefore(series: BucketSnapshot[], t: number): BucketSnapshot | null {
  let out: BucketSnapshot | null = null;
  for (const s of series) {
    if (s.capturedAt <= t) out = s;
    else break;
  }
  return out;
}

/** First snapshot with capturedAt ≥ t (the first book a follower could act on), or null. */
export function snapshotAtOrAfter(series: BucketSnapshot[], t: number): BucketSnapshot | null {
  for (const s of series) if (s.capturedAt >= t) return s;
  return null;
}

/** First snapshot at/after t whose ask is a usable price (0,1]; or null. */
function entrySnapshotWithAsk(series: BucketSnapshot[], t: number): BucketSnapshot | null {
  for (const s of series) {
    if (s.capturedAt >= t && s.ask != null && Number.isFinite(s.ask) && s.ask > 0 && s.ask <= 1) return s;
  }
  return null;
}

/** Last snapshot with a usable mid (the drift target), or null. */
function lastUsableMid(series: BucketSnapshot[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const m = series[i]!.mid;
    if (m != null && Number.isFinite(m)) return m;
  }
  return null;
}

const usablePrice = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p <= 1;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// per-fill follower simulation
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Fee-net EV per $1 staked at a given entry price, using the canonical Polymarket weather fee
 * (`takerFeeTotal`, rate·p·(1−p)) — the SAME fee math gradeSimBet uses. Per $1: shares = 1/ask;
 * win → shares·(1−ask) profit; loss → −1; both minus the taker fee. (For a true MAKER we still pass the
 * same fee as a conservative choice — the maker bound's edge comes from the cheaper price, not a rebate.)
 */
export function netEvPerDollar(ask: number, won: boolean, feeRate: number): number {
  if (!usablePrice(ask)) return NaN;
  const shares = 1 / ask;
  const feeUsd = takerFeeTotal(ask, shares, feeRate);
  return (won ? shares * (1 - ask) : -1) - feeUsd;
}

/** Simulate one follower entry from a fill + its snapshot series. Pure; never throws. */
export function followerEntry(fill: MirrorFill, opts: MirrorOpts = {}): FollowerEntry {
  const lag = opts.detectionLagSec ?? 300;
  const maxStale = opts.maxEntryStalenessSec ?? 3600;
  const won = fill.outcomeWon === true;

  const fillSnap = snapshotAtOrBefore(fill.snapshots, fill.timestamp);
  const fillMid = fillSnap && usablePrice(fillSnap.mid) ? fillSnap.mid : null;
  const lastMid = lastUsableMid(fill.snapshots);

  // realistic entry: first snapshot with a usable ask at/after (fill + lag), within the staleness cap.
  const entrySnap = entrySnapshotWithAsk(fill.snapshots, fill.timestamp + lag);
  const entryStalenessSec = entrySnap ? entrySnap.capturedAt - (fill.timestamp + lag) : NaN;
  const entryUsable = entrySnap !== null && entryStalenessSec <= maxStale;
  const entryAsk = entryUsable ? entrySnap!.ask : null;

  // optimistic bound: take the contemporaneous (≤fill) ask, if any.
  const contemporaneousAsk = fillSnap && usablePrice(fillSnap.ask) ? fillSnap.ask : null;

  const fillVsMid = fillMid != null ? fill.fillPrice - fillMid : NaN;
  const driftRaw = fillMid != null && lastMid != null ? lastMid - fillMid : NaN;
  const driftToward = Number.isFinite(driftRaw)
    ? fill.outcome.toLowerCase() === 'no'
      ? -driftRaw
      : driftRaw
    : NaN;

  return {
    fill,
    entrySnapshot: entryUsable ? entrySnap : null,
    entryStalenessSec,
    entryAsk,
    fillMid,
    lastMid,
    netEvTaker: entryAsk != null ? netEvPerDollar(entryAsk, won, fill.feeRate) : NaN,
    netEvTakerContemporaneous:
      contemporaneousAsk != null ? netEvPerDollar(contemporaneousAsk, won, fill.feeRate) : NaN,
    netEvMaker: netEvPerDollar(fill.fillPrice, won, fill.feeRate),
    fillVsMid,
    driftToward,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// aggregate report
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const evCiOf = (values: number[], seed: number): EvCi => {
  const finite = values.filter((v) => Number.isFinite(v));
  const b = bootstrapMeanCi(finite, { seed });
  return { ev: b.mean, evCiLo: b.lo, evCiHi: b.hi, n: b.n };
};

/**
 * Run the full copy-trade feasibility study over a set of BUY fills. Filters to cheap (<cheapMaxPrice)
 * fills with a KNOWN resolution, simulates a taker-follower per fill, and aggregates:
 *
 *  - sharpGross    : badatmath's own fee-free edge at its fill price ({won, ask=fillPrice}).
 *  - followerGross : the follower's fee-free edge taking the post-fill ask ({won, ask=entryAsk}).
 *  - followerNet   : ★ the pre-registered headline — follower taking the post-fill ask NET of fee.
 *  - capturableFraction, fill-vs-mid (maker character), post-fill drift, entry staleness.
 *
 * Pure + total — an empty/all-unresolved input returns a zeroed report (NaN point estimates).
 */
export function simulateMirror(fills: MirrorFill[], opts: MirrorOpts = {}): CopyTradeReport {
  const seed = opts.bootstrapSeed ?? 42;
  const cheapMax = opts.cheapMaxPrice ?? 0.25;

  const buys = fills.filter((f) => usablePrice(f.fillPrice));
  const cheapResolved = buys.filter(
    (f) => f.fillPrice < cheapMax && f.outcomeWon !== null && f.snapshots.length > 0,
  );

  const entries = cheapResolved.map((f) => followerEntry(f, opts));
  const usable = entries.filter((e) => e.entryAsk != null);

  // GradedBet sets reuse armEdgeStats (Wilson hit + mean±SE edge + bootstrap EV CI).
  const sharpBets = usable.map((e) => ({ won: e.fill.outcomeWon === true, ask: e.fill.fillPrice }));
  const followerBets = usable.map((e) => ({ won: e.fill.outcomeWon === true, ask: e.entryAsk! }));
  const sharpGross = armEdgeStats(sharpBets, { bootstrapSeed: seed });
  const followerGross = armEdgeStats(followerBets, { bootstrapSeed: seed });

  const followerNet = evCiOf(usable.map((e) => e.netEvTaker), seed);
  const followerNetContemporaneous = evCiOf(
    entries.map((e) => e.netEvTakerContemporaneous),
    seed,
  );
  const followerNetMaker = evCiOf(entries.map((e) => e.netEvMaker), seed);

  const capturableFraction = sharpGross.ev > 0 ? followerNet.ev / sharpGross.ev : NaN;

  const fvm = usable.map((e) => e.fillVsMid).filter((v) => Number.isFinite(v));
  const fillVsMid = {
    mean: fvm.length ? fvm.reduce((a, v) => a + v, 0) / fvm.length : NaN,
    fracBelowMid: fvm.length ? fvm.filter((v) => v < 0).length / fvm.length : NaN,
    n: fvm.length,
  };

  const drifts = cheapResolved
    .map((f) => followerEntry(f, opts).driftToward)
    .filter((v) => Number.isFinite(v));
  const driftCi = meanConfidenceInterval(drifts);
  const driftToward = { mean: driftCi.mean, ciLo: driftCi.lo, ciHi: driftCi.hi, n: driftCi.n };

  const stale = usable.map((e) => e.entryStalenessSec).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number =>
    arr.length === 0 ? NaN : arr[Math.min(arr.length - 1, Math.floor(p * arr.length))]!;
  const entryStaleness = { medianSec: q(stale, 0.5), p90Sec: q(stale, 0.9), n: stale.length };

  return {
    nFills: fills.length,
    nCheapResolved: cheapResolved.length,
    nUsable: usable.length,
    sharpGross,
    followerGross,
    followerNet,
    followerNetContemporaneous,
    followerNetMaker,
    capturableFraction,
    fillVsMid,
    driftToward,
    entryStaleness,
  };
}

/**
 * Adjudicate a report against the PRE-REGISTERED kill-criterion (WALLET-RECON-HANDOFF.md §11, written
 * before the number was seen — WO-5 discipline, do not move it to fit the result):
 *
 *   PASS  = the follower fee-net EV 95% bootstrap CI LOWER BOUND clears 0 (copy-trading is viable —
 *           a taker-follower keeps a statistically positive edge after spread + fee + detection lag).
 *   FAIL  = CI straddles/below 0 → the "late follower" intuition is confirmed quantitatively; the live
 *           rail stays dormant; the clean copy-trade-efficiency measurement IS the deliverable.
 *
 * `clearsMargin` additionally checks the point EV against an operational-margin threshold (default +2%
 * EV/$1) — a PASS that barely clears 0 is not worth the operational risk of going live.
 */
export function copyTradeVerdict(
  report: CopyTradeReport,
  opts: { marginThreshold?: number } = {},
): CopyTradeVerdict {
  const marginThreshold = opts.marginThreshold ?? 0.02;
  const net = report.followerNet;
  const pass = Number.isFinite(net.evCiLo) && net.evCiLo > 0;
  const clearsMargin = pass && Number.isFinite(net.ev) && net.ev >= marginThreshold;
  const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
  const summary = pass
    ? `PASS — follower fee-net EV ${pctf(net.ev)} /$1, 95% CI [${pctf(net.evCiLo)}, ${pctf(net.evCiHi)}] clears 0` +
      (clearsMargin ? ` and the +${(marginThreshold * 100).toFixed(0)}% margin` : ` but BELOW the +${(marginThreshold * 100).toFixed(0)}% margin`)
    : `FAIL — follower fee-net EV ${pctf(net.ev)} /$1, 95% CI [${pctf(net.evCiLo)}, ${pctf(net.evCiHi)}] does not clear 0 → late-follower confirmed; market efficient to a mirror`;
  return { pass, clearsMargin, followerNet: net, marginThreshold, summary };
}
