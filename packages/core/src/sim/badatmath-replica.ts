/**
 * core/sim/badatmath-replica — the PURE, deterministic "recreate badatmath's buying model" engine.
 * A fictional paper-trial that mimics the #1 WEATHER sharp's REVEALED strategy (NOT a mirror of its
 * individual fills) and scores it three ways so the operator can watch, day by day, exactly where the
 * money is — and where it leaks. WALLET-RECON-HANDOFF.md §15 is the reverse-engineered playbook this
 * encodes; §11/§12 are why the three price legs exist.
 *
 * THE STRATEGY DNA (WALLET-RECON-HANDOFF.md §15 — his buying patterns, distilled to rules):
 *   • ENGINE   — cheap **Yes** in the **0.10–0.25** band. §15.1: [0.10,0.15) +23%, [0.15,0.25) +24%;
 *                the very cheapest [0.05,0.10) is a confirmed DEAD ZONE (−22%), so the band excludes it.
 *   • TIMING   — the **24–48h-before-resolution** window is his +ROI band (§15.3: 24–48h +18.3%,
 *                48–72h +15.5%, <24h break-even). He does NOT bet day-of. We operationalize "peak odds
 *                buying hours" as a single representative entry instant at his median **36h** lead
 *                (inside that band) — a fixed instant so the BACKTEST and the FORWARD run price the
 *                identical way (a retrospective "pick the cheapest in the window" would not be
 *                implementable forward).
 *   • BREADTH  — ~**3 distinct buckets per city·day** (§15.4 median 3, max 11): a spray across the
 *                plausible cheap range, not one modal pick.
 *   • SIZING   — micro-grind, ~**$12/position** (§15.5 median $12.12).
 *   • CITIES   — his profit is global and concentrated in stable/tropical climates (§15.6: SE-Asia
 *                +84% ROI, KL +199%, E-Asia +abs); volatile mid-latitudes bleed. The "best cities"
 *                whitelist is supplied by the caller (the backtest computes it via `rankCitiesByRoi`).
 *
 * THE THREE PRICE LEGS (why a paper trial of a known-non-replicable edge is still worth running).
 * WALLET-RECON proved badatmath's edge is a MAKER edge: he rests cheap bids ~7pp below the ask and
 * collects the rebate + breadth; it is NOT followable as a taker (§11: −6.05pp) nor replicable as a
 * maker on our own forecast (§12: adverse selection). So a copycat's realized P&L depends entirely on
 * WHICH PRICE it transacts at. We score all three, side by side, so the gaps between them ARE the
 * deliverable:
 *   • makerIdeal     — fill at his cheap rested-bid price, ASSUME filled. Reproduces the §15 +12.9%
 *                      hold-to-resolution ceiling: "his strategy's theoretical edge."
 *   • makerRealistic — rest the same bid, but fill ONLY if the book later touches it (the §12 ask-touch
 *                      model — `simulateFill`). Embeds adverse selection for free: cheap bids fill on
 *                      the buckets the market marks DOWN (losers), winners' asks rise away unfilled.
 *                      "What we'd actually get resting bids ourselves."
 *   • taker          — cross to the ask, always fill. "What we'd net chasing him as a taker" (§11).
 *   The makerIdeal→taker gap is the **spread tax**; the makerIdeal→makerRealistic gap is the
 *   **adverse-selection tax**. Both are reported.
 *
 * Idiom: pure + total + deterministic. No DB, no network, no `packages/trading`. Empty / all-ineligible
 * inputs return zeroed reports (NaN point estimates), never throw. Reuses the proven primitives —
 * `restPrice` + `simulateFill` (the §12 maker fill model), `armEdgeStats`/`wilsonInterval` (stats.ts),
 * `takerFeeTotal` (the canonical weather fee) — never a bespoke re-implementation. Resolution (`bucketWon`)
 * and the resolution instant (`resolutionTs`) are computed UPSTREAM by the impure spine; this module is
 * the strategy + scoring only.
 */
import { takerFeeTotal } from '../fees.ts';
import type { BucketSnapshot } from './copy-trade.ts';
import { snapshotAtOrAfter } from './copy-trade.ts';
import { restPrice, simulateFill } from './maker-spray.ts';
import { type ArmEdgeStats, type GradedBet, armEdgeStats, wilsonInterval } from './stats.ts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// strategy
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The badatmath playbook as tunable knobs (WALLET-RECON-HANDOFF.md §15). */
export interface ReplicaStrategy {
  /** Cheap-Yes entry band LOWER bound (inclusive) — banded on the rested BID (his fill-price proxy). */
  cheapBandLo: number;
  /** Cheap-Yes entry band UPPER bound (exclusive). §15.1 engine = [0.10, 0.25). */
  cheapBandHi: number;
  /** Hours before resolution we place the buy (the "peak odds buying hours" instant; §15.3 median 36h). */
  entryLeadHours: number;
  /** Max distinct buckets bought per city·day (§15.4 median 3). */
  breadthPerCityDay: number;
  /** Stake per position, USDC (§15.5 median $12.12). */
  positionStakeUsd: number;
  /** Daily total-stake cap across all cities, USDC (the operator's bankroll knob). */
  dailyBankrollCapUsd: number;
  /** Default tick a rested bid is floored to when a bucket omits its own. */
  tickSize: number;
  /** Fallback fee rate when a bucket omits its own (Polymarket weather replica rate, 0.05). */
  feeRate: number;
}

/** The §15 defaults: cheap-Yes 0.10–0.25, 36h lead, 3/city·day, $12/position, $250/day cap. */
export const DEFAULT_REPLICA_STRATEGY: ReplicaStrategy = {
  cheapBandLo: 0.1,
  cheapBandHi: 0.25,
  entryLeadHours: 36,
  breadthPerCityDay: 3,
  positionStakeUsd: 12,
  dailyBankrollCapUsd: 250,
  tickSize: 0.01,
  feeRate: 0.05,
};

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// inputs / outputs
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One buyable Yes-bucket on one city·day — the market data the engine selects + prices from. Every
 * field is loaded from our own Postgres (market_events / market_buckets / market_snapshots); no
 * forecast, no wallet. The buy is always the bucket's **Yes** leg (the §15 engine).
 */
export interface ReplicaCandidate {
  conditionId: string;
  eventId: string;
  citySlug: string;
  region: string;
  /** Station-local resolution day, 'YYYY-MM-DD' (the day-to-day ledger axis). */
  targetDate: string;
  bucketIdx: number;
  /** Human label for the ledger (e.g. "29–30°C"). */
  bucketLabel: string;
  /** Did THIS bucket's Yes leg resolve in the money? null = not yet resolved (a pending forward bet). */
  bucketWon: boolean | null;
  /** market_buckets.fee_rate (0 → fall back to the strategy default). */
  feeRate: number;
  /** market_buckets.tick_size (0 → fall back to the strategy default). */
  tickSize: number;
  /** Resolution instant, unix seconds = localDayWindow(tz, targetDate).endUtc (computed upstream). */
  resolutionTs: number;
  /** The bucket's book snapshots, ASCENDING by capturedAt (caller-sorted). */
  snapshots: BucketSnapshot[];
}

const usablePrice = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p <= 1;

/** The entry quote for one candidate at the strategy's peak-odds instant. */
export interface EntryQuote {
  /** unix seconds = resolutionTs − entryLeadHours·3600. */
  entryTs: number;
  /** First snapshot at/after entryTs (the placement book), or null. */
  entrySnapshot: BucketSnapshot | null;
  /** Rested-bid price (best_bid, tick-floored) — the maker legs transact here. null when no usable bid. */
  makerPrice: number | null;
  /** The ask at entry — the taker leg transacts here. null when no usable ask. */
  takerPrice: number | null;
}

/**
 * Resolve a candidate's entry quote at the strategy's peak-odds instant. The maker price is the rested
 * bid (`restPrice`, floored to the bucket's tick); the taker price is the ask. Pure; never throws.
 */
export function entryQuote(c: ReplicaCandidate, strat: ReplicaStrategy): EntryQuote {
  const entryTs = c.resolutionTs - strat.entryLeadHours * 3600;
  const snap = snapshotAtOrAfter(c.snapshots, entryTs);
  if (snap === null) return { entryTs, entrySnapshot: null, makerPrice: null, takerPrice: null };
  const tick = Number.isFinite(c.tickSize) && c.tickSize > 0 ? c.tickSize : strat.tickSize;
  // restPrice reads only {bid, ask}; BucketSnapshot is the structural subset FillSnapshot needs.
  const makerPrice = restPrice(snap, 'bid', { tickSize: tick, askOffset: 0.07 });
  const takerPrice = usablePrice(snap.ask) ? snap.ask : null;
  return { entryTs, entrySnapshot: snap, makerPrice, takerPrice };
}

/** True iff the candidate is a band-eligible buy: a usable maker bid in the cheap band + a usable ask. */
export function bandEligible(c: ReplicaCandidate, strat: ReplicaStrategy): boolean {
  const q = entryQuote(c, strat);
  return (
    q.makerPrice !== null &&
    q.makerPrice >= strat.cheapBandLo &&
    q.makerPrice < strat.cheapBandHi &&
    q.takerPrice !== null &&
    q.entrySnapshot !== null
  );
}

/** A candidate the engine decided to buy (after the breadth filter), with its bankroll allocation. */
export interface SelectedBuy {
  candidate: ReplicaCandidate;
  entryTs: number;
  /** UTC calendar day the buy is placed (the bankroll-cap grouping key). */
  entryDayUtc: string;
  entrySnapshot: BucketSnapshot;
  makerPrice: number;
  takerPrice: number;
  /** Allocated stake (positionStakeUsd) when within the day's bankroll cap; else 0 (skipped-by-cap). */
  stakeUsd: number;
  /** True when the buy fit under the day's bankroll cap (and so deploys stake). */
  allocated: boolean;
}

const isoDayUtc = (unixSec: number): string => new Date(unixSec * 1000).toISOString().slice(0, 10);

/**
 * Apply the §15 playbook to a candidate set: keep band-eligible Yes buckets, take the cheapest
 * `breadthPerCityDay` per (city, targetDate), then allocate `positionStakeUsd` per buy in deterministic
 * order until each entry-day's `dailyBankrollCapUsd` is exhausted (over-cap buys are returned with
 * stake 0 / allocated false, so the caller can see what the bankroll dropped — no silent cap). Pure +
 * deterministic; SQL-ordered input → identical output. Returns ONLY the breadth-selected buys.
 */
export function selectBuys(candidates: ReplicaCandidate[], strat: ReplicaStrategy): SelectedBuy[] {
  // 1. band-eligible buys with their entry quotes
  const eligible: { c: ReplicaCandidate; q: EntryQuote }[] = [];
  for (const c of candidates) {
    const q = entryQuote(c, strat);
    if (
      q.makerPrice !== null &&
      q.makerPrice >= strat.cheapBandLo &&
      q.makerPrice < strat.cheapBandHi &&
      q.takerPrice !== null &&
      q.entrySnapshot !== null
    ) {
      eligible.push({ c, q });
    }
  }

  // 2. breadth: the cheapest `breadthPerCityDay` per (city, targetDate). Ascending makerPrice prefers
  //    the cheaper end of the engine band (more longshot upside, §15.1); bucketIdx breaks ties.
  const byCityDay = new Map<string, { c: ReplicaCandidate; q: EntryQuote }[]>();
  for (const e of eligible) {
    const k = `${e.c.citySlug}|${e.c.targetDate}`;
    const arr = byCityDay.get(k);
    if (arr) arr.push(e);
    else byCityDay.set(k, [e]);
  }
  const breadthSelected: { c: ReplicaCandidate; q: EntryQuote }[] = [];
  for (const arr of byCityDay.values()) {
    arr.sort((a, b) => a.q.makerPrice! - b.q.makerPrice! || a.c.bucketIdx - b.c.bucketIdx);
    for (const e of arr.slice(0, Math.max(0, strat.breadthPerCityDay))) breadthSelected.push(e);
  }

  // 3. bankroll cap per entry-UTC-day. Deterministic order within a day: city, then makerPrice, then
  //    bucketIdx. Allocate positionStakeUsd while cumulative + stake ≤ cap.
  const buys: SelectedBuy[] = breadthSelected.map((e) => ({
    candidate: e.c,
    entryTs: e.q.entryTs,
    entryDayUtc: isoDayUtc(e.q.entryTs),
    entrySnapshot: e.q.entrySnapshot!,
    makerPrice: e.q.makerPrice!,
    takerPrice: e.q.takerPrice!,
    stakeUsd: 0,
    allocated: false,
  }));
  const spentByDay = new Map<string, number>();
  const ordered = buys
    .map((b, i) => ({ b, i }))
    .sort(
      (x, y) =>
        x.b.entryDayUtc.localeCompare(y.b.entryDayUtc) ||
        x.b.candidate.citySlug.localeCompare(y.b.candidate.citySlug) ||
        x.b.makerPrice - y.b.makerPrice ||
        x.b.candidate.bucketIdx - y.b.candidate.bucketIdx,
    );
  for (const { b } of ordered) {
    const spent = spentByDay.get(b.entryDayUtc) ?? 0;
    if (spent + strat.positionStakeUsd <= strat.dailyBankrollCapUsd) {
      b.stakeUsd = strat.positionStakeUsd;
      b.allocated = true;
      spentByDay.set(b.entryDayUtc, spent + strat.positionStakeUsd);
    }
  }
  return buys;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// the three price legs
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Leg = 'makerIdeal' | 'makerRealistic' | 'taker';
export const LEGS: Leg[] = ['makerIdeal', 'makerRealistic', 'taker'];

/** The hold-to-resolution outcome of ONE price leg of ONE buy. */
export interface LegOutcome {
  leg: Leg;
  /** Transaction price (rested bid for maker legs, ask for the taker). */
  price: number;
  /** Stake actually deployed, $ — 0 for an unfilled maker-realistic rest. */
  stakeUsd: number;
  /** Contracts held = stakeUsd / price. */
  shares: number;
  /** Filled & in-position (the maker-realistic leg fills only if the book touches the bid). */
  filled: boolean;
  /** Yes-bucket resolution; null while pending. */
  won: boolean | null;
  /** Gross hold-to-resolution P&L = payoff − stake (0 while pending or unfilled). */
  grossPnlUsd: number;
  /** Fee on the position (Polymarket weather fee); 0 while pending or unfilled. */
  feeUsd: number;
  /** Fee-net P&L = gross − fee. */
  netPnlUsd: number;
}

function gradeLeg(leg: Leg, price: number, stakeUsd: number, filled: boolean, won: boolean | null, feeRate: number): LegOutcome {
  const shares = filled && usablePrice(price) && stakeUsd > 0 ? stakeUsd / price : 0;
  const resolved = won !== null;
  // gross/fee/net only crystallize once the bucket has resolved AND the leg actually holds a position.
  let grossPnlUsd = 0;
  let feeUsd = 0;
  if (filled && resolved && shares > 0) {
    const payoff = won ? shares : 0;
    grossPnlUsd = payoff - stakeUsd;
    feeUsd = takerFeeTotal(price, shares, feeRate);
  }
  return {
    leg,
    price,
    stakeUsd: filled ? stakeUsd : 0,
    shares,
    filled,
    won,
    grossPnlUsd,
    feeUsd,
    netPnlUsd: grossPnlUsd - feeUsd,
  };
}

/** All three legs of one allocated buy, scored to resolution. */
export interface ScoredBuy {
  buy: SelectedBuy;
  makerIdeal: LegOutcome;
  makerRealistic: LegOutcome;
  taker: LegOutcome;
  /** True once the bucket has resolved (candidate.bucketWon != null). */
  resolved: boolean;
}

/**
 * Score one ALLOCATED buy across all three price legs (the §11/§12 trichotomy). makerIdeal + taker
 * always fill; makerRealistic rests at the bid and fills only if some post-entry snapshot's ask ≤ the
 * bid (`simulateFill` ask-touch — the §12 adverse-selection model). Pure; never throws. A buy that was
 * NOT allocated (bankroll-capped) deploys $0 on every leg.
 */
export function scoreBuy(buy: SelectedBuy, strat: ReplicaStrategy): ScoredBuy {
  const c = buy.candidate;
  const won = c.bucketWon;
  const feeRate = Number.isFinite(c.feeRate) && c.feeRate > 0 ? c.feeRate : strat.feeRate;
  const stake = buy.allocated ? buy.stakeUsd : 0;

  // maker-realistic: does the rested bid fill before resolution? post-entry = snapshots at/after the
  // placement book (mirrors maker-spray's `series.filter(s => s.capturedAt >= entryCaptured)`).
  const entryCaptured = buy.entrySnapshot.capturedAt;
  const postEntry = c.snapshots.filter((s) => s.capturedAt >= entryCaptured);
  const fill = simulateFill(buy.makerPrice, postEntry, 'ask_touch');

  return {
    buy,
    makerIdeal: gradeLeg('makerIdeal', buy.makerPrice, stake, stake > 0, won, feeRate),
    makerRealistic: gradeLeg('makerRealistic', buy.makerPrice, stake, stake > 0 && fill.filled, won, feeRate),
    taker: gradeLeg('taker', buy.takerPrice, stake, stake > 0, won, feeRate),
    resolved: won !== null,
  };
}

/** Score a whole selection (allocated buys deploy stake; capped buys score to $0). Pure. */
export function scoreBuys(buys: SelectedBuy[], strat: ReplicaStrategy): ScoredBuy[] {
  return buys.map((b) => scoreBuy(b, strat));
}

/**
 * A position whose entry prices are already LOCKED (the forward paper-trade persists these when it
 * places a buy) and whose maker-realistic fill was already decided by replaying the book at resolution.
 * Scoring a locked buy needs no snapshots — the prices + the fill flag + the outcome are enough.
 */
export interface LockedBuy {
  conditionId: string;
  eventId: string;
  citySlug: string;
  region: string;
  targetDate: string;
  bucketIdx: number;
  bucketLabel: string;
  resolutionTs: number;
  entryTs: number;
  entryDayUtc: string;
  makerPrice: number;
  takerPrice: number;
  stakeUsd: number;
  feeRate: number;
  /** Yes-bucket resolution; null while still pending. */
  bucketWon: boolean | null;
  /** Whether the rested maker bid filled (decided by `simulateFill` over the full book at reconcile). */
  makerRealisticFilled: boolean;
}

/**
 * Score a LOCKED buy (the forward path) through the SAME `gradeLeg` engine the backtest uses — so a
 * forward closed position and a backtest position aggregate identically. The maker-realistic fill is the
 * caller's pre-decided flag (NOT re-derived here — the live book was replayed at reconcile). The synthetic
 * candidate carries no snapshots (none are needed once prices + fill + outcome are known). Pure.
 */
export function scoreLocked(lb: LockedBuy, strat: ReplicaStrategy): ScoredBuy {
  const feeRate = Number.isFinite(lb.feeRate) && lb.feeRate > 0 ? lb.feeRate : strat.feeRate;
  const won = lb.bucketWon;
  const candidate: ReplicaCandidate = {
    conditionId: lb.conditionId,
    eventId: lb.eventId,
    citySlug: lb.citySlug,
    region: lb.region,
    targetDate: lb.targetDate,
    bucketIdx: lb.bucketIdx,
    bucketLabel: lb.bucketLabel,
    bucketWon: won,
    feeRate,
    tickSize: strat.tickSize,
    resolutionTs: lb.resolutionTs,
    snapshots: [],
  };
  const buy: SelectedBuy = {
    candidate,
    entryTs: lb.entryTs,
    entryDayUtc: lb.entryDayUtc,
    entrySnapshot: { capturedAt: lb.entryTs, bid: lb.makerPrice, ask: lb.takerPrice, mid: null },
    makerPrice: lb.makerPrice,
    takerPrice: lb.takerPrice,
    stakeUsd: lb.stakeUsd,
    allocated: true,
  };
  return {
    buy,
    makerIdeal: gradeLeg('makerIdeal', lb.makerPrice, lb.stakeUsd, true, won, feeRate),
    makerRealistic: gradeLeg('makerRealistic', lb.makerPrice, lb.stakeUsd, lb.makerRealisticFilled, won, feeRate),
    taker: gradeLeg('taker', lb.takerPrice, lb.stakeUsd, true, won, feeRate),
    resolved: won !== null,
  };
}

const legOf = (s: ScoredBuy, leg: Leg): LegOutcome =>
  leg === 'makerIdeal' ? s.makerIdeal : leg === 'makerRealistic' ? s.makerRealistic : s.taker;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// forward paper-trade — the pure reconcile + place steps (the daily /loop engine)
//
// The FORWARD run reconciles resolved open positions and places today's live buys. It lives partly in the
// impure spine (scripts/research/badatmath-replica-forward.ts — file state, the local task) and partly in the
// Supabase Edge tick (functions/replica-forward — DB state, the cloud port). Both call these two PURE steps;
// the only difference is WHERE the open positions / resolutions / book / candidates come from (a state.json
// file vs the replica_forward_inputs RPC). Keeping the decision logic here means the local task and the cloud
// tick can never drift. REPLICA-CLOUD-PORT.md.
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One forward paper position — a LockedBuy (the engine scores it) plus the forward bookkeeping. Lives in core
 * (not the script) so the Edge handler can import it without pulling in node:fs. The maker-realistic fill is
 * decided once at reconcile (replaying the live book) and frozen into `makerRealisticFilled` — `scoreLocked`
 * trusts that flag rather than re-deriving it.
 */
export interface ForwardPosition extends LockedBuy {
  /** The placement snapshot's capturedAt (the fill-window start; postEntry = book at/after this). */
  entryCapturedTs: number;
  /** ISO timestamp we placed it. */
  placedAtUtc: string;
  /** ISO timestamp we closed it (resolution observed); null while open. */
  closedAtUtc: string | null;
}

/** Resolution sources for reconcile: our DB winners (eventId → bucket idx) + an optional Gamma overlay. */
export interface ReconcileResolution {
  /** eventId → winning_bucket_idx (our DB `market_events.winning_bucket_idx`). Primary, lags ~45%. */
  dbWinners: Map<string, number>;
  /** conditionId → 'Yes'|'No' (Polymarket Gamma, ~97% + timely). Fallback for events our DB hasn't resolved. */
  gammaWinners?: Map<string, 'Yes' | 'No'>;
}

const forwardPosKey = (p: { eventId: string; bucketIdx: number }): string => `${p.eventId}|${p.bucketIdx}`;

/**
 * Reconcile open forward positions against resolution. For each: our DB `winning_bucket_idx` is primary (won =
 * bucketIdx === winner); a Gamma Yes/No on the conditionId is the fallback when the DB hasn't resolved the event
 * yet (so positions close promptly instead of waiting on the lagging pipeline). For each newly-resolved one:
 * set bucketWon, replay the post-entry book to decide the §12 maker-realistic fill (`simulateFill` ask-touch
 * over the bucket's ask series filtered to ≥ entryCapturedTs), stamp closedAtUtc, and move it to `newlyClosed`.
 * Unresolved positions stay in `stillOpen`. Pure + total: returns NEW position objects (never mutates inputs);
 * a missing ask series just yields an unfilled rest. The impure callers do the DB reads → pass the three maps.
 */
export function reconcilePure(
  open: ForwardPosition[],
  resolution: ReconcileResolution,
  askSeriesByCondition: Map<string, BucketSnapshot[]>,
  nowSec: number,
): { stillOpen: ForwardPosition[]; newlyClosed: ForwardPosition[] } {
  const closedAtUtc = new Date(nowSec * 1000).toISOString();
  const stillOpen: ForwardPosition[] = [];
  const newlyClosed: ForwardPosition[] = [];
  for (const p of open) {
    let won: boolean | null = null;
    const dbw = resolution.dbWinners.get(p.eventId);
    if (dbw !== undefined) won = p.bucketIdx === dbw;
    else if (p.conditionId) {
      const g = resolution.gammaWinners?.get(p.conditionId);
      if (g !== undefined) won = g === 'Yes';
    }
    if (won === null) {
      stillOpen.push(p);
      continue;
    }
    // resolved → lock the outcome + the maker-realistic fill from the now-complete book.
    const series = askSeriesByCondition.get(p.conditionId) ?? [];
    const entryCaptured = Number.isFinite(p.entryCapturedTs) ? p.entryCapturedTs : p.entryTs;
    const postEntry = series.filter((s) => s.capturedAt >= entryCaptured);
    const fill = simulateFill(p.makerPrice, postEntry, 'ask_touch');
    newlyClosed.push({ ...p, bucketWon: won, makerRealisticFilled: fill.filled, closedAtUtc });
  }
  return { stillOpen, newlyClosed };
}

/**
 * Place today's buys from a pre-loaded candidate set: keep only LIVE candidates (unresolved, the 36h-before
 * entry instant has arrived but resolution hasn't — entryTs ≤ now < resolutionTs), run the §15 playbook
 * (`selectBuys`), drop anything already placed (`placedKeys` = posKey of every open+closed position), and
 * return the newly-opened ForwardPositions with entry prices LOCKED at the placement book — the identical
 * instant the backtest prices at. Pure + deterministic: the impure callers load the candidates (file state or
 * the inputs RPC) and supply `placedKeys`; this is the placement DECISION only.
 *
 * `placedKeys` MUST include every already-placed position that could still match the live gate — OPEN positions
 * AND any CLOSED-but-resolutionTs-still-future one (a market resolved early via Gamma). The live gate alone is
 * not a substitute: such a closed position would otherwise be re-opened. Both callers pass open+closed keys.
 */
export function placeBuysPure(
  candidates: ReplicaCandidate[],
  placedKeys: Set<string>,
  strat: ReplicaStrategy,
  nowSec: number,
): ForwardPosition[] {
  const placedAtUtc = new Date(nowSec * 1000).toISOString();
  const entryLeadSec = strat.entryLeadHours * 3600;
  const live = candidates.filter(
    (c) => c.bucketWon === null && c.resolutionTs > nowSec && c.resolutionTs - entryLeadSec <= nowSec,
  );
  const buys = selectBuys(live, strat);
  const placed = new Set(placedKeys);
  const opened: ForwardPosition[] = [];
  for (const b of buys) {
    if (!b.allocated) continue;
    const c = b.candidate;
    const key = forwardPosKey({ eventId: c.eventId, bucketIdx: c.bucketIdx });
    if (placed.has(key)) continue;
    placed.add(key);
    opened.push({
      conditionId: c.conditionId,
      eventId: c.eventId,
      citySlug: c.citySlug,
      region: c.region,
      targetDate: c.targetDate,
      bucketIdx: c.bucketIdx,
      bucketLabel: c.bucketLabel,
      resolutionTs: c.resolutionTs,
      entryTs: b.entryTs,
      entryDayUtc: b.entryDayUtc,
      entryCapturedTs: b.entrySnapshot.capturedAt,
      makerPrice: b.makerPrice,
      takerPrice: b.takerPrice,
      stakeUsd: b.stakeUsd,
      feeRate: Number.isFinite(c.feeRate) && c.feeRate > 0 ? c.feeRate : strat.feeRate,
      bucketWon: null,
      makerRealisticFilled: false,
      placedAtUtc,
      closedAtUtc: null,
    });
  }
  return opened;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// aggregate stats per leg
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Per-leg rolled-up performance (the headline a curve renders). */
export interface LegStats {
  leg: Leg;
  /** Resolved positions that actually held stake on this leg (filled + resolved). */
  nResolved: number;
  wins: number;
  losses: number;
  /** Total deployed stake on resolved positions, $. */
  stakeUsd: number;
  grossPnlUsd: number;
  netPnlUsd: number;
  hitRate: number;
  hitCiLo: number;
  hitCiHi: number;
  /** Gross hold-to-resolution ROI on deployed stake. */
  roiGross: number;
  /** Fee-net ROI. */
  roiNet: number;
  /** Mean realized EV/$1 (gross) + bootstrap CI (armEdgeStats on {won, ask=price}). */
  ev: number;
  evCiLo: number;
  evCiHi: number;
  /** Mean paired edge (won − price) + CI — the low-variance headline. */
  edge: number;
  edgeCiLo: number;
  edgeCiHi: number;
}

const emptyLegStats = (leg: Leg): LegStats => ({
  leg,
  nResolved: 0,
  wins: 0,
  losses: 0,
  stakeUsd: 0,
  grossPnlUsd: 0,
  netPnlUsd: 0,
  hitRate: NaN,
  hitCiLo: NaN,
  hitCiHi: NaN,
  roiGross: NaN,
  roiNet: NaN,
  ev: NaN,
  evCiLo: NaN,
  evCiHi: NaN,
  edge: NaN,
  edgeCiLo: NaN,
  edgeCiHi: NaN,
});

/** Reduce the resolved, filled outcomes of ONE leg to its full stat bundle. Pure + total. */
export function legStats(scored: ScoredBuy[], leg: Leg): LegStats {
  const out = scored.map((s) => legOf(s, leg)).filter((o) => o.filled && o.won !== null);
  if (out.length === 0) return emptyLegStats(leg);
  const bets: GradedBet[] = out.map((o) => ({ won: o.won === true, ask: o.price }));
  const arm: ArmEdgeStats = armEdgeStats(bets);
  const wins = out.filter((o) => o.won === true).length;
  const stakeUsd = out.reduce((a, o) => a + o.stakeUsd, 0);
  const grossPnlUsd = out.reduce((a, o) => a + o.grossPnlUsd, 0);
  const netPnlUsd = out.reduce((a, o) => a + o.netPnlUsd, 0);
  return {
    leg,
    nResolved: out.length,
    wins,
    losses: out.length - wins,
    stakeUsd,
    grossPnlUsd,
    netPnlUsd,
    hitRate: arm.hitRate,
    hitCiLo: arm.hitCiLo,
    hitCiHi: arm.hitCiHi,
    roiGross: stakeUsd > 0 ? grossPnlUsd / stakeUsd : NaN,
    roiNet: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN,
    ev: arm.ev,
    evCiLo: arm.evCiLo,
    evCiHi: arm.evCiHi,
    edge: arm.edge,
    edgeCiLo: arm.edgeCiLo,
    edgeCiHi: arm.edgeCiHi,
  };
}

/** The full three-curve report — the deliverable the operator reads. */
export interface ReplicaSummary {
  /** Candidates considered (all loaded buyable Yes-buckets in scope). */
  nCandidates: number;
  /** Band-eligible (cheap-Yes bid in band + usable ask). */
  nBandEligible: number;
  /** Breadth-selected (≤ breadthPerCityDay per city·day). */
  nSelected: number;
  /** Allocated under the daily bankroll cap (the ones that deploy stake). */
  nAllocated: number;
  /** Of allocated, how many have resolved. */
  nResolved: number;
  /** Of allocated, how many are still pending (open forward bets). */
  nPending: number;
  makerIdeal: LegStats;
  makerRealistic: LegStats;
  taker: LegStats;
  /** Spread tax = makerIdeal.roiGross − taker.roiGross (the cost of crossing to the ask). */
  spreadTaxRoi: number;
  /** Adverse-selection tax = makerIdeal.roiGross − makerRealistic.roiGross (the cost of real maker fills). */
  adverseSelTaxRoi: number;
  /** Fraction of allocated, resolved maker rests that filled (the §12 fill rate). */
  makerFillRate: number;
}

/**
 * Roll a scored selection up into the three-curve summary + the two tax deltas. `nCandidates` and
 * `nBandEligible` are passed in (the caller knows the full candidate set; `scored` carries only the
 * selected buys). Pure + total — an empty selection yields a zeroed summary, never throws.
 */
export function summarize(scored: ScoredBuy[], counts: { nCandidates: number; nBandEligible: number }): ReplicaSummary {
  const allocated = scored.filter((s) => s.buy.allocated);
  const resolved = allocated.filter((s) => s.resolved);
  const makerIdeal = legStats(scored, 'makerIdeal');
  const makerRealistic = legStats(scored, 'makerRealistic');
  const taker = legStats(scored, 'taker');
  // fill rate among allocated + resolved maker rests (the honest §12 denominator).
  const makerRests = allocated.filter((s) => s.resolved);
  const makerFilled = makerRests.filter((s) => s.makerRealistic.filled).length;
  const sub = (a: number, b: number): number =>
    Number.isFinite(a) && Number.isFinite(b) ? a - b : NaN;
  return {
    nCandidates: counts.nCandidates,
    nBandEligible: counts.nBandEligible,
    nSelected: scored.length,
    nAllocated: allocated.length,
    nResolved: resolved.length,
    nPending: allocated.length - resolved.length,
    makerIdeal,
    makerRealistic,
    taker,
    spreadTaxRoi: sub(makerIdeal.roiGross, taker.roiGross),
    adverseSelTaxRoi: sub(makerIdeal.roiGross, makerRealistic.roiGross),
    makerFillRate: makerRests.length === 0 ? NaN : makerFilled / makerRests.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// day-to-day ledger (the "easy to understand" axis)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One resolution-day row: each leg's P&L that day + the running cumulative. */
export interface DailyRow {
  /** target_date (resolution day) — the day-to-day axis the operator watches. */
  date: string;
  nResolved: number;
  makerIdealPnl: number;
  makerIdealCum: number;
  makerRealisticPnl: number;
  makerRealisticCum: number;
  takerPnl: number;
  takerCum: number;
}

/**
 * Build the day-by-day ledger, keyed by resolution day (candidate.targetDate). `net=true` uses fee-net
 * P&L; otherwise gross hold-to-resolution P&L (the §15-consistent headline). Only resolved buys
 * contribute. Sorted ascending by date with running cumulatives per leg. Pure + total.
 */
export function dailyLedger(scored: ScoredBuy[], opts: { net?: boolean } = {}): DailyRow[] {
  const net = opts.net === true;
  const pnl = (o: LegOutcome): number => (net ? o.netPnlUsd : o.grossPnlUsd);
  const byDate = new Map<string, { n: number; mi: number; mr: number; tk: number }>();
  for (const s of scored) {
    if (!s.resolved || !s.buy.allocated) continue;
    const d = s.buy.candidate.targetDate;
    const row = byDate.get(d) ?? { n: 0, mi: 0, mr: 0, tk: 0 };
    row.n += 1;
    row.mi += pnl(s.makerIdeal);
    row.mr += pnl(s.makerRealistic);
    row.tk += pnl(s.taker);
    byDate.set(d, row);
  }
  const dates = [...byDate.keys()].sort();
  let cmi = 0;
  let cmr = 0;
  let ctk = 0;
  const rows: DailyRow[] = [];
  for (const d of dates) {
    const r = byDate.get(d)!;
    cmi += r.mi;
    cmr += r.mr;
    ctk += r.tk;
    rows.push({
      date: d,
      nResolved: r.n,
      makerIdealPnl: r.mi,
      makerIdealCum: cmi,
      makerRealisticPnl: r.mr,
      makerRealisticCum: cmr,
      takerPnl: r.tk,
      takerCum: ctk,
    });
  }
  return rows;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// city ranking (defines "his best performing cities" from the data, not a hardcode)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** A city's performance under the replica strategy (one leg) — the basis for the whitelist. */
export interface CityRoi {
  city: string;
  region: string;
  nResolved: number;
  stakeUsd: number;
  grossPnlUsd: number;
  roiGross: number;
  hitRate: number;
  hitCiLo: number;
  hitCiHi: number;
}

/**
 * Rank cities by the strategy's realized ROI on a given leg (default makerIdeal — the strategy's own
 * theoretical edge, the cleanest "where does THIS playbook perform best" signal). Cities with fewer than
 * `minResolved` resolved positions are dropped (an ROI on n=2 is noise). Descending by ROI. Pure + total.
 */
export function rankCitiesByRoi(scored: ScoredBuy[], opts: { leg?: Leg; minResolved?: number } = {}): CityRoi[] {
  const leg = opts.leg ?? 'makerIdeal';
  const minResolved = opts.minResolved ?? 8;
  const byCity = new Map<string, { region: string; outs: LegOutcome[] }>();
  for (const s of scored) {
    if (!s.resolved || !s.buy.allocated) continue;
    const o = legOf(s, leg);
    if (!o.filled || o.won === null) continue;
    const k = s.buy.candidate.citySlug;
    const g = byCity.get(k) ?? { region: s.buy.candidate.region, outs: [] };
    g.outs.push(o);
    byCity.set(k, g);
  }
  const out: CityRoi[] = [];
  for (const [city, g] of byCity) {
    if (g.outs.length < minResolved) continue;
    const stakeUsd = g.outs.reduce((a, o) => a + o.stakeUsd, 0);
    const grossPnlUsd = g.outs.reduce((a, o) => a + o.grossPnlUsd, 0);
    const wins = g.outs.filter((o) => o.won === true).length;
    const hit = wilsonInterval(wins, g.outs.length);
    out.push({
      city,
      region: g.region,
      nResolved: g.outs.length,
      stakeUsd,
      grossPnlUsd,
      roiGross: stakeUsd > 0 ? grossPnlUsd / stakeUsd : NaN,
      hitRate: g.outs.length > 0 ? wins / g.outs.length : NaN,
      hitCiLo: hit.lo,
      hitCiHi: hit.hi,
    });
  }
  out.sort((a, b) => (Number.isFinite(b.roiGross) ? b.roiGross : -Infinity) - (Number.isFinite(a.roiGross) ? a.roiGross : -Infinity));
  return out;
}
