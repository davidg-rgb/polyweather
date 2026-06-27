/**
 * core/sim/opening-convergence — the PURE decision core of the opening-convergence bot.
 *
 * Flat-open detection, entry selection, the bracket exit decision, the deterministic pessimistic
 * paper-fill model, and the frozen, pre-registered net-profit verdict — all pure + total functions
 * (junk → null/[]/INSUFFICIENT, never throw). Mirrors `sim/cross-venue-arb.ts`. Imports only
 * `../fees.ts` and `../time.ts`; NEVER `packages/trading` or any I/O (ADR-OC-3 / §15 grep invariant).
 *
 * These same functions drive the paper backtest, the forward paper loop, AND the live loop — one
 * source of truth for "what would we do". The impure wiring (`packages/bot`, the capture handler,
 * the scripts) is a thin shell over THIS.
 *
 * THE THESIS (OPENING-CONVERGENCE-HANDOFF.md §2): a freshly-listed daily-Tmax market opens FLAT
 * (every °C bucket ~10–12% — the book is uninformed) and CONVERGES to a peaked distribution. Buy the
 * `house_gaussian` forecast-center buckets cheap at the flat open; sell them back into the
 * convergence on bracket orders (TP / SL / hard station-local-noon time-stop) — capture the
 * re-rating, never need to hit the exact temperature.
 *
 * See ARCHITECTURE-OPENING-CONVERGENCE.md §6.1 + §16/§17 for the load-bearing fixes honored here:
 *   F1  — the exit mark is the BID side (executableBid), never the ask; bracketDecision/MTM are unsafe otherwise.
 *   F13/F1 — the stop-loss is the TERNARY `(entry−12pp>0) ? entry−12pp : entry×(1−slFrac)`, NOT max() (which
 *            would silently override the operator-locked −12pp for the whole (0.12,0.20] universe).
 *   F11 — the time-stop is `localHourInstant(tz,date,noon)` (DST-correct), NOT startUtc+12h.
 *   W6/W6b — houseProb is aligned to each bucket BY LABEL/RANGE IDENTITY at capture; modeIdx = argmax of houseProb.
 *   F7-r10 — selectEntries enforces a minimum hold-runway to the time-stop (skip after-noon lead-0 markets).
 *   F28 — the verdict's zero-skill Monte-Carlo is a cluster-PRESERVING sign-flip (wild-cluster) bootstrap,
 *         which doubles as the few-cluster (C≈6–10) calibration the naive t-CI under-covers.
 */
import { takerFeePerShare } from '../fees.ts';
import { localHourInstant } from '../time.ts';

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One captured bucket of a Polymarket temperature ladder (the `opening_captures.buckets` jsonb shape). */
export interface OpeningBucket {
  idx: number;
  label: string;
  /** integer °-span [loF, hiF] (null = open tail). */
  loF: number | null;
  hiF: number | null;
  /** (bestBid + bestAsk)/2 implied-prob proxy (null = no two-sided quote). */
  mid: number | null;
  bestAsk: number | null;
  /** the executable (walked) ask for the entry size — the price you can actually BUY at. */
  execAsk: number | null;
  /** buyable $ within the +10% band (the true CLOB depth-walk, not the vol proxy). */
  depthUsd: number;
  bestBid: number | null;
  /** $ recoverable selling into the bid (the realizable exit side). */
  sellbackUsd: number;
  /**
   * our house_gaussian prob for THIS bucket, aligned BY LABEL/RANGE IDENTITY at capture time (W6),
   * null if the dist was unseeded OR the seed-quality gate failed (F15 — existence ≠ enterable).
   */
  houseProb: number | null;
  tokenYes: string;
  tokenNo: string;
  conditionId: string;
}

/** One captured snapshot of a freshly-listed (or near-dated) market — the `opening_captures` row. */
export interface OpeningCapture {
  eventId: string | null;
  city: string;
  /** station-local YYYY-MM-DD (C-6 — NOT UTC midnight). */
  targetDate: string;
  /** the city's real IANA tz NAME from cities.tz (Etc/* already rejected upstream — C2/C2b). */
  tz: string;
  /** the event's TRUE Gamma listing time (the flat-open anchor); null if unsurfaced. */
  createdAtGamma: string | null;
  /** now − createdAtGamma at capture (NOT first-sighting — the listing-anchor fix). */
  hoursSinceListing: number;
  /** the Gamma event endDate — the venue-independent resolution clock. */
  resolvesAt: string | null;
  /** parseGammaEvent.negRiskMarketId != null — weather is negRisk winner-take-all (default true). */
  negRisk: boolean;
  /** event 24h volume — the §9R $7k+ liquidity filter input. */
  evVol24h: number | null;
  buckets: OpeningBucket[];
  /** was a fresh, quality-passing house_gaussian seeded for this event (C1 diagnostic). */
  houseSeeded: boolean;
}

/** The config the pure decision functions read (defaults mirror §9R-locked params + §16-D). */
export interface OpeningCfg {
  /** the §9R 6–10-city allowlist. */
  cities: string[];
  /** ≈7000 — the $7k+ vol24h liquidity floor. */
  minVol24hUsd: number;
  /** 0.18 — flat-open iff the peak bucket mid is at or below this. */
  peakMidMax: number;
  /** ≈1 — the flat-open window is ≤~1h (§16-D, NOT §9R-B's 6h); the peak threshold does the real work. */
  listingMaxHours: number;
  /** 1 — buy house_gaussian mode ± this many buckets (3 buckets at 1). */
  centerHalfWidth: number;
  /** the ask must be below our model prob by at least this margin. */
  entryEdgeMargin: number;
  /** 0.20 — hard cap; never buy above this regardless of edge. */
  maxEntryPrice: number;
  /** the true-depth floor ($) a center bucket must carry to be enterable. */
  depthFloorUsd: number;
  /** per-position $ stake. */
  perPositionUsd: number;
  /** 0.25 — take-profit when mark ≥ entry + this. */
  tpDeltaPp: number;
  /** true — also take-profit when mark ≥ our model prob (let winners run toward the dist). */
  tpAtModelProb: boolean;
  /** 0.12 — the operator-locked absolute stop, applied WHENEVER entry − 0.12 > 0. */
  slDeltaPp: number;
  /** 0.5 — the relative stop floor (entry × (1 − slFrac)), used ONLY for the cheapest band where −12pp is inert. */
  slFrac: number;
  /** 12 — flatten by local noon of lead-0. */
  timeStopLocalHour: number;
  /** the maker-resting window (minutes) before cancel + taker fallback. */
  makerFillWindowMin: number;
  /** F7-r10 — minimum minutes from now to the local-noon time-stop for an entry to be allowed. */
  minHoldRunwayMin: number;
  /** additive pessimistic paper slippage on a taker fill. */
  paperSlippage: number;
  /** the weather taker fee rate the paper model charges (V2 fees are protocol-set; paper models it). */
  takerFeeRate: number;
}

/** A bucket selected to buy at the flat open. */
export interface EntryCandidate {
  eventId: string | null;
  city: string;
  targetDate: string;
  tz: string;
  bucketIdx: number;
  label: string;
  tokenYes: string;
  tokenNo: string;
  /** the venue market conditionId — the venue-INDEPENDENT redeem/resolve key (F2-r8). */
  conditionId: string;
  negRisk: boolean;
  resolvesAt: string | null;
  /** the executable ask at the entry size (the price we'd take). */
  execAsk: number;
  /** our house_gaussian prob (the convergence target). */
  modelProb: number;
  /** modelProb − execAsk. */
  edge: number;
  /** the maker resting price ceiling (the live signer shades by one tick + posts post_only). */
  makerLimit: number;
  targetShares: number;
  targetUsd: number;
}

/** The pure decision-relevant subset of a position (the persisted shape lives in §7). */
export interface OpenPosition {
  entryPrice: number;
  modelProb: number;
  tokenYes: string;
  targetDate: string;
  side: 'BUY-YES';
  /** ISO timestamp the maker entry began resting (for the maker-window cancel). */
  makerRestingSince?: string | null;
  state: string;
}

/** The pure exit decision for one position. */
export type BracketAction =
  | { kind: 'hold' }
  | { kind: 'take_profit'; reason: string }
  | { kind: 'stop_loss'; reason: string }
  | { kind: 'time_stop'; reason: string }
  | { kind: 'cancel_maker_take'; reason: string };

/** A deterministic pessimistic paper fill (or null = no fill this tick). */
export interface PaperFill {
  price: number;
  shares: number;
  feeUsd: number;
  mode: 'paper';
  isMaker: boolean;
}

/** One CLOSED paper market's realized result — the verdict panel row. */
export interface OpeningMarketResult {
  city: string;
  targetDate: string;
  netPnlUsd: number;
  stakeUsd: number;
  netReturn: number;
  executed: boolean;
}

export type OpeningLabel = 'PASS' | 'KILL' | 'INSUFFICIENT_DATA';

export interface OpeningVerdict {
  label: OpeningLabel;
  nMarkets: number;
  nCities: number;
  nDistinctDays: number;
  winFrac: number;
  meanNetReturn: number;
  ciLow: number;
  ciHigh: number;
  zeroSkillPassRate: number;
  reason: string;
}

export interface VerdictOpts {
  minMarkets?: number;
  minCities?: number;
  minDistinctDays?: number;
  minWinFrac?: number;
  /** zero-skill Monte-Carlo trials (default 1000). */
  trials?: number;
  /** the deterministic shuffle salt (no Math.random — index-seeded LCG). */
  seedSalt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Frozen defaults (§9R-locked / §16-D)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export const OPENING_DEFAULTS: OpeningCfg = {
  cities: [],
  minVol24hUsd: 7000,
  peakMidMax: 0.18,
  listingMaxHours: 1,
  centerHalfWidth: 1,
  entryEdgeMargin: 0.05,
  maxEntryPrice: 0.2,
  depthFloorUsd: 50,
  perPositionUsd: 20,
  tpDeltaPp: 0.25,
  tpAtModelProb: true,
  slDeltaPp: 0.12,
  slFrac: 0.5,
  timeStopLocalHour: 12,
  makerFillWindowMin: 15,
  minHoldRunwayMin: 30,
  paperSlippage: 0.01,
  takerFeeRate: 0.05,
};

/** the §9R-E gate sufficiency bars. */
export const GATE_MIN_MARKETS = 40;
// ≥6 cities is LOAD-BEARING, not arbitrary: the cluster-preserving sign-flip null (zeroSkillPassRate, F28)
// includes the no-flip (all-+1) sign vector, which reproduces the real panel exactly and therefore ALWAYS
// counts toward the pass-rate when the panel passes the bar. That vector recurs at ~2^(−nCities), so the
// achievable floor on zsp is ~2^(−C): at C=4 the floor is 0.0625 > ZERO_SKILL_MAX_PASS (0.05) → a genuinely
// skillful 4-city panel could ONLY ever KILL (un-passable gate, false-KILL of a real edge). C=5 floors at
// 0.03125 (marginal). C≥6 floors at ≤0.0156, clearing 0.05 with headroom — and matches F28's "effective
// df = #cities (≈6–10)". Do NOT lower below 6 without also raising ZERO_SKILL_MAX_PASS.
export const GATE_MIN_CITIES = 6;
export const GATE_MIN_DISTINCT_DAYS = 7;
export const GATE_MIN_WIN_FRAC = 0.5;
export const ZERO_SKILL_MAX_PASS = 0.05;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** The peak (max) bucket mid — low peak = flat/open-like. NaN if no bucket carries a two-sided quote. */
function peakMidOf(buckets: OpeningBucket[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  for (const b of buckets) if (fin(b.mid)) peak = Math.max(peak, b.mid);
  return Number.isFinite(peak) ? peak : NaN;
}

/** Student-t two-sided 95% critical value (copied from the cross-venue-arb idiom). */
function tCrit(df: number): number {
  if (df <= 0) return Number.POSITIVE_INFINITY;
  const T: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447,
    7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
  };
  if (df <= 10) return T[df]!;
  if (df <= 15) return 2.131;
  if (df <= 20) return 2.086;
  if (df <= 30) return 2.042;
  return 1.96;
}

/**
 * Deterministic, well-MIXED hash of an integer key → [0,1) (the splitmix32 finalizer) — no Math.random
 * (keeps the verdict reproducible). A single LCG STEP is NOT enough here: keys that differ by a small
 * constant (consecutive city indices) would advance by a fixed increment and land on the same side of 0.5,
 * collapsing the per-city sign flips into one coin flip (the cluster-preserving MC would degenerate — it
 * floored zeroSkillPassRate ~0.4 and made the §9R-E gate un-passable). The avalanche below decorrelates
 * adjacent keys so each city draws an independent Rademacher sign.
 */
function hashUnit(key: number): number {
  let h = (key + 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 4294967296;
}

/** A decorrelated [0,1) draw for trial t × city i × salt — each (t,i) mixes to an independent value. */
function drawUnit(t: number, i: number, salt: number): number {
  const key = (Math.imul(t + 1, 0x9e3779b1) ^ Math.imul(i + 1, 0x85ebca77) ^ Math.imul(salt + 1, 0xc2b2ae3d)) >>> 0;
  return hashUnit(key);
}

/** The clustered-by-city mean-return 95% t-CI over a panel (the crossVenueVerdict idiom). */
function clusteredCi(rows: OpeningMarketResult[]): { cityMeans: number[]; mean: number; ciLow: number; ciHigh: number } {
  const cities = [...new Set(rows.map((r) => r.city))];
  const cityMeans = cities.map((c) => {
    const cr = rows.filter((r) => r.city === c);
    return cr.reduce((a, r) => a + r.netReturn, 0) / cr.length;
  });
  const C = cityMeans.length;
  const mean = C > 0 ? cityMeans.reduce((a, v) => a + v, 0) / C : NaN;
  const variance = C > 1 ? cityMeans.reduce((a, v) => a + (v - mean) ** 2, 0) / (C - 1) : 0;
  const se = Math.sqrt(variance / Math.max(1, C));
  const t = tCrit(C - 1);
  return { cityMeans, mean, ciLow: mean - t * se, ciHigh: mean + t * se };
}

/** The frozen PASS predicate, shared by openingVerdict + zeroSkillPassRate so both test the SAME bar. */
function passesBar(rows: OpeningMarketResult[], minWinFrac: number): boolean {
  if (rows.length === 0) return false;
  const winFrac = rows.filter((r) => r.netPnlUsd > 0).length / rows.length;
  const { ciLow } = clusteredCi(rows);
  return winFrac >= minWinFrac && ciLow > 0;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · isFlatOpen — the uninformed-window gate (F-OC-02 / §16-D)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function isFlatOpen(
  cap: OpeningCapture,
  cfg: OpeningCfg,
): { flat: boolean; peakMid: number; hoursSinceListing: number; reasons: string[] } {
  const reasons: string[] = [];
  const peakMid = peakMidOf(cap.buckets ?? []);
  const hours = cap.hoursSinceListing;

  if (!Number.isFinite(peakMid)) reasons.push('no_quotes');
  if (!fin(hours)) reasons.push('no_listing_time');
  if (Number.isFinite(peakMid) && peakMid > cfg.peakMidMax) reasons.push('peak_above_max');
  if (fin(hours) && hours > cfg.listingMaxHours) reasons.push('past_listing_window');

  return { flat: reasons.length === 0, peakMid, hoursSinceListing: hours, reasons };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · selectEntries — pick the buckets to buy at the flat open (F-OC-03 / §9R-B)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function selectEntries(cap: OpeningCapture, cfg: OpeningCfg, now: Date): EntryCandidate[] {
  // universe + liquidity + flat-open gate (the §9R-B universe + I-13 vol floor)
  if (!cfg.cities.includes(cap.city)) return [];
  if (!fin(cap.evVol24h) || cap.evVol24h < cfg.minVol24hUsd) return [];
  if (!isFlatOpen(cap, cfg).flat) return [];

  // MINIMUM-RUNWAY guard (F7-r10): a freshly-listed lead-0 market in a far-east tz can be flat yet ALREADY
  // past local noon → entered then immediately time-stop-flattened at a deterministic spread+fee loss for
  // ~zero hold, polluting the §9R-E gate. A tz that cannot resolve a DST-correct noon fails closed (the
  // position would never have a valid time-stop — ADR-OC-12). 'past_or_near_timestop' / 'no_tz'.
  let timeStopAt: Date;
  try {
    timeStopAt = localHourInstant(cap.tz, cap.targetDate, cfg.timeStopLocalHour);
  } catch {
    return []; // no_tz — fail closed (never enter without a real IANA time-stop)
  }
  const runwayMin = (timeStopAt.getTime() - now.getTime()) / 60_000;
  if (!(runwayMin >= cfg.minHoldRunwayMin)) return []; // past_or_near_timestop

  // modeIdx = argmax of the LIVE-aligned houseProb (W6b — never a dist-space index)
  let modeIdx = -1;
  let modeProb = Number.NEGATIVE_INFINITY;
  for (const b of cap.buckets) {
    if (fin(b.houseProb) && b.houseProb > modeProb) {
      modeProb = b.houseProb;
      modeIdx = b.idx;
    }
  }
  if (modeIdx < 0) return []; // no_house_prob — unseeded / quality-gate-failed (C1/F15)

  const out: EntryCandidate[] = [];
  for (const b of cap.buckets) {
    if (Math.abs(b.idx - modeIdx) > cfg.centerHalfWidth) continue; // mode ± centerHalfWidth
    if (!fin(b.houseProb)) continue; // no_house_prob for this bucket
    if (!fin(b.execAsk) || b.execAsk <= 0) continue; // no executable ask (a 0/neg ask → Infinity/neg shares — CORE2-1)
    if (!(b.depthUsd >= cfg.depthFloorUsd)) continue; // below_depth_floor

    const reservation = Math.min(cfg.maxEntryPrice, b.houseProb - cfg.entryEdgeMargin);
    if (!(b.execAsk <= reservation)) continue; // ask_above_reservation (also enforces the 20% hard cap)

    const targetUsd = cfg.perPositionUsd;
    const targetShares = targetUsd / b.execAsk;
    // the maker resting ceiling (the live signer subtracts one tick + posts post_only — §16-B / ADR-OC-6).
    const makerLimit = Math.min(reservation, fin(b.bestAsk) ? b.bestAsk : b.execAsk);

    out.push({
      eventId: cap.eventId,
      city: cap.city,
      targetDate: cap.targetDate,
      tz: cap.tz,
      bucketIdx: b.idx,
      label: b.label,
      tokenYes: b.tokenYes,
      tokenNo: b.tokenNo,
      conditionId: b.conditionId,
      negRisk: cap.negRisk,
      resolvesAt: cap.resolvesAt,
      execAsk: b.execAsk,
      modelProb: b.houseProb,
      edge: b.houseProb - b.execAsk,
      makerLimit,
      targetShares,
      targetUsd,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · bracketDecision — the pure exit decision (F-OC-05 / §9R-C / ADR-OC-7)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function bracketDecision(
  pos: OpenPosition,
  mark: number | null,
  nowUtc: Date,
  tz: string,
  cfg: OpeningCfg,
): BracketAction {
  // (a) the hard station-local-noon time-stop — clock-only, the dominant backstop. DST-correct via
  // localHourInstant (F11). A tz that fails the IANA/Etc guard ⇒ conservative time_stop (fail toward
  // flatten — ADR-OC-12; such a position is never entered, so this is a defensive backstop only).
  let timeStopFired = false;
  try {
    if (nowUtc.getTime() >= localHourInstant(tz, pos.targetDate, cfg.timeStopLocalHour).getTime()) {
      timeStopFired = true;
    }
  } catch {
    return { kind: 'time_stop', reason: `invalid_tz_conservative_flatten:${tz}` };
  }
  if (timeStopFired) {
    return { kind: 'time_stop', reason: `local_noon_reached (${tz} ${pos.targetDate} ${cfg.timeStopLocalHour}:00)` };
  }

  // (b) an unfilled maker entry past its window → cancel + (manager) taker-fallback.
  if (pos.state === 'maker_resting' && pos.makerRestingSince) {
    const restMin = (nowUtc.getTime() - new Date(pos.makerRestingSince).getTime()) / 60_000;
    if (restMin >= cfg.makerFillWindowMin) {
      return { kind: 'cancel_maker_take', reason: `maker_window_elapsed (${restMin.toFixed(1)}m ≥ ${cfg.makerFillWindowMin}m)` };
    }
  }

  // (c) TP / SL on the BID-side realizable mark (F1 — caller supplies via executableBid). No mark ⇒ hold.
  if (!fin(mark)) return { kind: 'hold' };

  const tpThreshold = pos.entryPrice + cfg.tpDeltaPp;
  if (mark >= tpThreshold || (cfg.tpAtModelProb && mark >= pos.modelProb)) {
    return {
      kind: 'take_profit',
      reason: `mark ${mark.toFixed(4)} ≥ ${mark >= tpThreshold ? `entry+${cfg.tpDeltaPp}` : `modelProb ${pos.modelProb.toFixed(4)}`}`,
    };
  }

  // the TERNARY stop (F13/F1): the locked −12pp absolute stop WHEREVER it is positive (entry > 0.12),
  // falling to the relative floor entry×(1−slFrac) ONLY for the cheapest band where −12pp is inert.
  // NOT a max() (which would take the tighter relative stop for the whole (0.12,0.20] universe and
  // silently override the operator-locked −12pp).
  const slStop = pos.entryPrice - cfg.slDeltaPp > 0 ? pos.entryPrice - cfg.slDeltaPp : pos.entryPrice * (1 - cfg.slFrac);
  if (mark <= slStop) {
    return { kind: 'stop_loss', reason: `mark ${mark.toFixed(4)} ≤ slStop ${slStop.toFixed(4)}` };
  }

  return { kind: 'hold' };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · paperFill — deterministic pessimistic fill (F-OC-09 / ADR-OC-6/9)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function paperFill(
  candidate: EntryCandidate,
  storedAsk: number | null,
  liveWalkedAsk: number | null,
  cfg: OpeningCfg,
  isMaker: boolean,
): PaperFill | null {
  if (isMaker) {
    // a resting maker BUY at makerLimit fills only if a LATER live ask traded THROUGH the limit
    // (book ran down to/below it) — never assumed (adverse-selection-aware; ADR-OC-6).
    if (!fin(liveWalkedAsk) || liveWalkedAsk > candidate.makerLimit) return null;
    const price = candidate.makerLimit;
    const shares = candidate.targetUsd / price;
    return { price, shares, feeUsd: 0, mode: 'paper', isMaker: true }; // $0 maker fee (the certain margin)
  }

  // taker: the WORSE-OF the stored decision-time ask and the live re-walked ask, + pessimistic slippage.
  const asks = [storedAsk, liveWalkedAsk].filter(fin);
  if (asks.length === 0) return null; // both unusable (book gone + stored stale) ⇒ no fill, not a throw
  const price = Math.max(...asks) + cfg.paperSlippage;
  const shares = candidate.targetUsd / price;
  const feeUsd = takerFeePerShare(price, cfg.takerFeeRate) * shares;
  return { price, shares, feeUsd, mode: 'paper', isMaker: false };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 5 · openingVerdict — the frozen, pre-registered net-profit gate (F-OC-10 / §9R-E / ADR-OC-10)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function openingVerdict(panel: OpeningMarketResult[], opts: VerdictOpts = {}): OpeningVerdict {
  const minMarkets = opts.minMarkets ?? GATE_MIN_MARKETS;
  const minCities = opts.minCities ?? GATE_MIN_CITIES;
  const minDistinctDays = opts.minDistinctDays ?? GATE_MIN_DISTINCT_DAYS;
  const minWinFrac = opts.minWinFrac ?? GATE_MIN_WIN_FRAC;

  // EXECUTED markets only — an executed-but-void market is not a skill outcome (excluded upstream too).
  const rows = (Array.isArray(panel) ? panel : []).filter(
    (r) => r && r.executed === true && Number.isFinite(r.netReturn) && Number.isFinite(r.netPnlUsd),
  );
  const nMarkets = rows.length;
  const cities = [...new Set(rows.map((r) => r.city))];
  const nCities = cities.length;
  const nDistinctDays = new Set(rows.map((r) => r.targetDate)).size;
  const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

  if (nMarkets < minMarkets || nCities < minCities || nDistinctDays < minDistinctDays) {
    return {
      label: 'INSUFFICIENT_DATA', nMarkets, nCities, nDistinctDays,
      winFrac: NaN, meanNetReturn: NaN, ciLow: NaN, ciHigh: NaN, zeroSkillPassRate: NaN,
      reason:
        `INSUFFICIENT_DATA — ${nMarkets} closed paper markets across ${nCities} cities / ${nDistinctDays} dates ` +
        `(need ≥ ${minMarkets} markets, ≥ ${minCities} cities, ≥ ${minDistinctDays} dates). Keep the forward paper run going.`,
    };
  }

  const winFrac = rows.filter((r) => r.netPnlUsd > 0).length / nMarkets;
  const { mean, ciLow, ciHigh } = clusteredCi(rows);
  const zsp = zeroSkillPassRate(rows, opts.trials ?? 1000, opts.seedSalt ?? 0, minWinFrac);

  const stat =
    `winFrac ${pct(winFrac)} (bar ${pct(minWinFrac)}); city-clustered mean net-return ${pct(mean)} ` +
    `95% CI [${pct(ciLow)}, ${pct(ciHigh)}] (t, ${nCities} cities — for C<15 the cluster-preserving ` +
    `sign-flip MC is the binding calibration, F28); zero-skill MC pass-rate ${pct(zsp)} (bar < ${pct(ZERO_SKILL_MAX_PASS)})`;

  if (winFrac >= minWinFrac && ciLow > 0 && zsp < ZERO_SKILL_MAX_PASS) {
    return {
      label: 'PASS', nMarkets, nCities, nDistinctDays, winFrac, meanNetReturn: mean, ciLow, ciHigh, zeroSkillPassRate: zsp,
      reason:
        `PASS — ${nMarkets} closed paper markets: ${stat}. A standing, executable opening-convergence edge net ` +
        `of fees + measured slippage. The §9R-E gate clears — eligible for the small-real step (operator funds the ` +
        `dedicated wallet; the first ~10 live fills are post-fill reviewed). The maker rebate stays a MEASURED input, never assumed.`,
    };
  }
  return {
    label: 'KILL', nMarkets, nCities, nDistinctDays, winFrac, meanNetReturn: mean, ciLow, ciHigh, zeroSkillPassRate: zsp,
    reason:
      `KILL — ${nMarkets} closed paper markets: ${stat}. The opening-convergence edge does NOT clear the frozen ` +
      `net-profit bar at executable depth net of costs (the same discipline that closed the other eleven signals). ` +
      `Rail returns DORMANT; update FINDINGS.md.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 6 · zeroSkillPassRate — the LEARNINGS statistical-gate guard (cluster-preserving sign-flip MC)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function zeroSkillPassRate(
  panel: OpeningMarketResult[],
  trials: number,
  seedSalt: number,
  minWinFrac: number = GATE_MIN_WIN_FRAC,
): number {
  const rows = (Array.isArray(panel) ? panel : []).filter(
    (r) => r && r.executed === true && Number.isFinite(r.netReturn) && Number.isFinite(r.netPnlUsd),
  );
  const cities = [...new Set(rows.map((r) => r.city))];
  if (cities.length < 2) return 1; // <2 clusters ⇒ no calibration possible; fail closed

  const cityIdx = new Map(cities.map((c, i) => [c, i]));
  const nTrials = Math.max(1, trials);
  let pass = 0;
  for (let t = 0; t < nTrials; t++) {
    // a Rademacher (±1) weight PER CITY — cluster-preserving (the whole cluster flips together, F28),
    // each city drawn INDEPENDENTLY (a decorrelated hash, not one LCG step over an arithmetic seed).
    const sign = cities.map((_c, i) => (drawUnit(t, i, seedSalt) < 0.5 ? -1 : 1));
    const flipped = rows.map((r) => {
      const s = sign[cityIdx.get(r.city)!]!;
      return { ...r, netReturn: r.netReturn * s, netPnlUsd: r.netPnlUsd * s };
    });
    if (passesBar(flipped, minWinFrac)) pass++;
  }
  return pass / nTrials;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// BotConfig — the operational config the keyless capture + the (Phase-2) loop read from the `config`
// table. The CODE defaults below are AUTHORITATIVE; migration 0066 seeds a MIRROR for ops visibility +
// an equality test asserts they match (F10-r8-FP). Pure (reads flat key/value rows) — no I/O.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BotConfig extends OpeningCfg {
  /** the operator instant-kill (bot_enabled='1'/'0'). */
  enabled: boolean;
  // caps (absolute-$, §9R-A / I-11)
  perMarketUsd: number;
  totalConcurrentUsd: number;
  paperBankrollUsd: number;
  bankrollBaseUsd: number;
  killLossUsd: number;
  killLossPct: number;
  firstNApprove: number;
  realTradesApproved: number;
  // loop / watchdog (invariant: leaseTtlSec > max(tickWatchdogSec, reconcileWatchdogSec) + margin — F12/F9-r10)
  tickIntervalSec: number;
  tickWatchdogSec: number;
  leaseTtlSec: number;
  reconcileWatchdogSec: number;
  reconcileEveryTicks: number;
  markMaxAgeMin: number;
  maxClockDriftSec: number;
  paperBookMaxAgeMin: number;
  // circuit breaker (two dimensions — F18/F44)
  maxConsecutiveFailures: number;
  maxConsecutiveAmbiguous: number;
  // on-demand seed
  seedFreshnessMin: number;
  seedMinModels: number;
  // producer deadman (capture staleness + seeded-fraction collapse — F21/F35)
  captureSeededFracMin: number;
  captureSeededFracWindow: number;
  // exit dust floor (dual share/notional — F34/F7) + gas/cash
  minOrderSizeShares: number;
  minOrderNotionalUsd: number;
  freeCashReserveUsd: number;
  minPolGas: number;
  // daily-loss latch
  killDayTz: string;
  killLatchPersistTicks: number;
  // Phase-0.5 spike GO threshold
  spikeGoFrac: number;
  // the §9R-E net-profit gate
  gate: { minMarkets: number; minCities: number; minDistinctDays: number; minWinFrac: number };
}

/** the authoritative code defaults (the §9R-locked params + §16-D); the migration mirror must equal these. */
export const BOT_DEFAULTS: BotConfig = {
  ...OPENING_DEFAULTS,
  // the §9R 6–10 most-liquid daily-Tmax cities the cheap gate observed flat-open + real depth on
  // (handoff §3 + §16-D). Operator-tunable via the `bot.cities` config row; migration 0066 mirrors THIS.
  cities: ['amsterdam', 'chengdu', 'manila', 'qingdao', 'madrid', 'guangzhou', 'kuala-lumpur', 'beijing', 'shanghai', 'paris'],
  enabled: false,
  perMarketUsd: 40,
  totalConcurrentUsd: 100,
  paperBankrollUsd: 200,
  bankrollBaseUsd: 200,
  killLossUsd: 30,
  killLossPct: 0.25,
  firstNApprove: 10,
  realTradesApproved: 0,
  tickIntervalSec: 30,
  tickWatchdogSec: 120,
  leaseTtlSec: 600,
  reconcileWatchdogSec: 300,
  reconcileEveryTicks: 20,
  markMaxAgeMin: 5,
  maxClockDriftSec: 5,
  paperBookMaxAgeMin: 5,
  maxConsecutiveFailures: 5,
  maxConsecutiveAmbiguous: 4,
  seedFreshnessMin: 180,
  seedMinModels: 3,
  captureSeededFracMin: 0.25,
  captureSeededFracWindow: 50,
  minOrderSizeShares: 5,
  minOrderNotionalUsd: 1,
  freeCashReserveUsd: 5,
  minPolGas: 0.5,
  killDayTz: 'America/New_York',
  killLatchPersistTicks: 3,
  spikeGoFrac: 0.5,
  gate: {
    minMarkets: GATE_MIN_MARKETS,
    minCities: GATE_MIN_CITIES,
    minDistinctDays: GATE_MIN_DISTINCT_DAYS,
    minWinFrac: GATE_MIN_WIN_FRAC,
  },
};

/** Parse a flat `config` key/value list into a BotConfig — every key falls back to the BOT_DEFAULTS code value. */
export function parseBotConfig(rows: { key: string; value: string | null }[]): BotConfig {
  const map = new Map((Array.isArray(rows) ? rows : []).map((r) => [r.key, r.value]));
  const num = (key: string, dflt: number): number => {
    const v = map.get(key);
    if (v == null || v === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  // Like num(), but a FINITE override is clamped into a sane domain (a non-finite/empty one falls to dflt).
  // Money/safety keys must fail safe against a typo: e.g. slFrac=1.5 would make the relative SL floor negative
  // (mark ≤ slStop never true ⇒ the stop silently never fires) — the [0,0.999] clamp keeps (1−slFrac) > 0. The
  // clamp enforces each key's valid DOMAIN (prices/probabilities ∈ [0,1], stakes ≥ 0); it is not the thesis
  // envelope (e.g. the cheap-entry cap is the operator-tunable maxEntryPrice DEFAULT 0.20, not the [0,1] bound).
  const clamp = (key: string, dflt: number, lo: number, hi: number): number => {
    return Math.min(hi, Math.max(lo, num(key, dflt)));
  };
  const bool = (key: string, dflt: boolean): boolean => {
    const v = map.get(key);
    if (v == null || v === '') return dflt;
    return v === '1' || v.toLowerCase() === 'true';
  };
  const str = (key: string, dflt: string): string => {
    const v = map.get(key);
    return v == null || v === '' ? dflt : v;
  };
  const csv = (key: string, dflt: string[]): string[] => {
    const v = map.get(key);
    if (v == null || v.trim() === '') return dflt;
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  };
  const D = BOT_DEFAULTS;
  return {
    cities: csv('bot.cities', D.cities),
    minVol24hUsd: clamp('bot.minVol24hUsd', D.minVol24hUsd, 0, 1e12),
    peakMidMax: clamp('bot.peakMidMax', D.peakMidMax, 0, 1),
    listingMaxHours: clamp('bot.listingMaxHours', D.listingMaxHours, 0, 1e6),
    centerHalfWidth: clamp('bot.centerHalfWidth', D.centerHalfWidth, 0, 50),
    entryEdgeMargin: clamp('bot.entryEdgeMargin', D.entryEdgeMargin, 0, 1),
    maxEntryPrice: clamp('bot.maxEntryPrice', D.maxEntryPrice, 0, 1),
    depthFloorUsd: clamp('bot.depthFloorUsd', D.depthFloorUsd, 0, 1e9),
    perPositionUsd: clamp('bot.perPositionUsd', D.perPositionUsd, 0, 1e7),
    tpDeltaPp: clamp('bot.tpDeltaPp', D.tpDeltaPp, 0, 1),
    tpAtModelProb: bool('bot.tpAtModelProb', D.tpAtModelProb),
    slDeltaPp: clamp('bot.slDeltaPp', D.slDeltaPp, 0, 1),
    slFrac: clamp('bot.slFrac', D.slFrac, 0, 0.999),
    // round to an integer hour: localHourInstant throws on a non-integer, which would fail-closed but silently
    // disable the bot (selectEntries → [] and bracketDecision → conservative flatten on every call) — CORE2-2.
    timeStopLocalHour: Math.round(clamp('bot.timeStopLocalHour', D.timeStopLocalHour, 0, 23)),
    makerFillWindowMin: clamp('bot.makerFillWindowMin', D.makerFillWindowMin, 0, 1e6),
    minHoldRunwayMin: clamp('bot.minHoldRunwayMin', D.minHoldRunwayMin, 0, 1e6),
    paperSlippage: clamp('bot.paperSlippage', D.paperSlippage, 0, 1),
    takerFeeRate: clamp('bot.takerFeeRate', D.takerFeeRate, 0, 1),
    enabled: bool('bot_enabled', D.enabled),
    perMarketUsd: clamp('bot.perMarketUsd', D.perMarketUsd, 0, 1e7),
    totalConcurrentUsd: clamp('bot.totalConcurrentUsd', D.totalConcurrentUsd, 0, 1e7),
    paperBankrollUsd: clamp('bot.paperBankrollUsd', D.paperBankrollUsd, 0, 1e9),
    bankrollBaseUsd: clamp('bot.bankrollBaseUsd', D.bankrollBaseUsd, 0, 1e9),
    killLossUsd: clamp('bot.killLossUsd', D.killLossUsd, 0, 1e7),
    killLossPct: clamp('bot.killLossPct', D.killLossPct, 0, 1),
    firstNApprove: num('bot.firstNApprove', D.firstNApprove),
    realTradesApproved: num('bot.realTradesApproved', D.realTradesApproved),
    tickIntervalSec: num('bot.tickIntervalSec', D.tickIntervalSec),
    tickWatchdogSec: num('bot.tickWatchdogSec', D.tickWatchdogSec),
    leaseTtlSec: num('bot.leaseTtlSec', D.leaseTtlSec),
    reconcileWatchdogSec: num('bot.reconcileWatchdogSec', D.reconcileWatchdogSec),
    reconcileEveryTicks: num('bot.reconcileEveryTicks', D.reconcileEveryTicks),
    markMaxAgeMin: num('bot.markMaxAgeMin', D.markMaxAgeMin),
    maxClockDriftSec: num('bot.maxClockDriftSec', D.maxClockDriftSec),
    paperBookMaxAgeMin: num('bot.paperBookMaxAgeMin', D.paperBookMaxAgeMin),
    maxConsecutiveFailures: num('bot.maxConsecutiveFailures', D.maxConsecutiveFailures),
    maxConsecutiveAmbiguous: num('bot.maxConsecutiveAmbiguous', D.maxConsecutiveAmbiguous),
    seedFreshnessMin: num('bot.seedFreshnessMin', D.seedFreshnessMin),
    seedMinModels: num('bot.seedMinModels', D.seedMinModels),
    captureSeededFracMin: num('bot.captureSeededFracMin', D.captureSeededFracMin),
    captureSeededFracWindow: num('bot.captureSeededFracWindow', D.captureSeededFracWindow),
    minOrderSizeShares: num('bot.minOrderSizeShares', D.minOrderSizeShares),
    minOrderNotionalUsd: num('bot.minOrderNotionalUsd', D.minOrderNotionalUsd),
    freeCashReserveUsd: num('bot.freeCashReserveUsd', D.freeCashReserveUsd),
    minPolGas: num('bot.minPolGas', D.minPolGas),
    killDayTz: str('bot.killDayTz', D.killDayTz),
    killLatchPersistTicks: num('bot.killLatchPersistTicks', D.killLatchPersistTicks),
    spikeGoFrac: clamp('bot.spikeGoFrac', D.spikeGoFrac, 0, 1),
    gate: {
      // The §9R-E net-profit gate is FROZEN / pre-registered (ADR-OC-10): config may only TIGHTEN it, never
      // weaken it (a stray `bot.gate.minMarkets=1` must not authorize a PASS on a 1-market panel — the
      // false-PASS → premature-capital direction). So floor EVERY bound at its frozen constant, not just
      // minCities (CORE2-3/CS3-1). minCities ≥ GATE_MIN_CITIES is doubly load-bearing — the 2^−C sign-flip-null
      // floor exceeds the 0.05 bar below 6, making the gate un-passable (false-KILL). Override → stricter only.
      minMarkets: Math.max(GATE_MIN_MARKETS, num('bot.gate.minMarkets', D.gate.minMarkets)),
      minCities: Math.max(GATE_MIN_CITIES, num('bot.gate.minCities', D.gate.minCities)),
      minDistinctDays: Math.max(GATE_MIN_DISTINCT_DAYS, num('bot.gate.minDistinctDays', D.gate.minDistinctDays)),
      minWinFrac: clamp('bot.gate.minWinFrac', D.gate.minWinFrac, GATE_MIN_WIN_FRAC, 1),
    },
  };
}
