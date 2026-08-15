/**
 * core/sim/cheap-early-entry-replay — the PURE forward-paper engine for the operator's CHEAP-EARLY-ENTRY
 * proposal (docs/ops/CHEAP-EARLY-ENTRY.md → CHEAP-EARLY-ENTRY-FORWARD-HANDOFF.md).
 *
 * THE STRATEGY BEING MEASURED (frozen — the point of the forward run is to test THIS, not to re-tune it).
 * Buy our house-pick bucket EARLY — in the [24,36]h-to-close band, NOT the final [2,12]h lost-causes window —
 * capped at a cheap ask that pays ≥3× (0.20–0.33), and HOLD TO RESOLUTION (no take-profit, no stop). The
 * operator's two instincts both checked out on the ~1 month of real book we have (CHEAP-EARLY-ENTRY.md): moving
 * the entry off the final hours lifts the win rate out of the "field already abandoned it" hole, and the real
 * spread (~0.3c) + house-pick depth ($130–310 median) are ample — cost is NOT the wall. But the edge itself did
 * not clear: the calibration gap (+1.2pp) sits inside the round-trip cost and the small real-book cells straddle
 * zero by ±100%. So it is INSUFFICIENT — not KILL, not GO. This engine scores it FORWARD on the live
 * `opening_captures` book so the §9R-E gate can adjudicate it as forward days accrue. PAPER ONLY — no capital,
 * no trade, no credentials; the bot rail stays DORMANT (FINDINGS.md, the 12th signal). A GO needs a frozen
 * §9R-E PASS across ≥2 non-overlapping windows + an explicit operator decision — never this build.
 *
 * THE ENGINE (the maker-exit forward loop's simpler twin — sim/opening-maker-exit-replay.ts). Per market:
 *   1. window: among the captured ticks whose HOURS-TO-CLOSE (resolvesAt − capturedAt) sits in [windowLoH,
 *      windowHiH], take the LATEST allowable — the tick with the SMALLEST hours-to-close (closest to the near
 *      edge), matching cheap-entry-realbook.py's `r.htc < picks[k].htc`. No look-ahead: the window is defined by
 *      the wall clock to resolution, never the outcome.
 *   2. pick: argmax(houseProb) over the quotable buckets AT that tick — the SAME live seed the buy lane /
 *      convergence bot use (NOT our bias-corrected accuracy forecast; the archive's houseProb is the pick of
 *      record). First-wins on a houseProb tie (matches the Python's strict `>`).
 *   3. gate: enter iff the pick's bestAsk ∈ [askBandLo, askBandHi] AND its depthUsd ≥ stakeUsd (the depth gate
 *      is the ONE addition over the Python twin — a thin pick must not count as fillable, handoff §0).
 *   4. fill: paper-buy at bestAsk as a TAKER, pay the frozen taker fee; HOLD TO RESOLUTION (no exit leg).
 *   5. grade: won = (pick temperature == winning temperature), parsing the integer from the LABEL, NEVER the
 *      bucket index (the sort-safe join — traps #7). Net per $1 = (won − ask − takerFeePerShare(ask))/ask, the
 *      exact form cheap-entry-realbook.py:net_return uses — so the forward engine and the offline twin agree on
 *      a shared event set (the handoff §5 regression check).
 *
 * THE VARIANT LAYER (2026-08-15, CHEAP-EARLY-IMPROVE.md §8). The rule above stays the CANONICAL config and the
 * only gate of record. On top of it the engine carries three extra knobs — `entryRule` ('first' = what the live
 * lane actually did), `minEdge` (a houseProb − ask margin; 0 = off) and `cityFilter` (top-K by recent hit rate)
 * — and a PRE-REGISTERED set of six variants (CHEAP_EARLY_VARIANTS) the forward loop scores side by side, so
 * "would a change to the failed live rule have helped?" is measured forward rather than re-tuned in hindsight.
 * The canonical path with the frozen defaults is unchanged, knob for knob. A variant verdict is NEVER written to
 * bot_gate_snapshot — there is no capital path off a variant, by construction.
 *
 * Pure + total (junk → entered:false / NaN, never throws). Imports only sibling pure modules (the shared ingest
 * types + the fee curve + the §9R-E verdict) — never io/trading/fs.
 */
import {
  openingVerdict,
  type OpeningMarketResult,
  type OpeningVerdict,
  type VerdictOpts,
  type OpeningBucket,
} from './opening-convergence.ts';
import type { EventReplayInput, ReplayTick } from './opening-bracket-replay.ts';
import { takerFeePerShare } from '../fees.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);
function mean(xs: number[]): number {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** how the entry tick is chosen among the in-window captures.
 *  'latest' — the SMALLEST hours-to-close in the window (the frozen/tested rule, the default);
 *  'first'  — the EARLIEST capture (ascending capturedAt) whose pick clears the band + depth (+ minEdge) gates,
 *             i.e. what the LIVE buy lane actually did (it fires on the first quote it sees in its window). */
export type CheapEarlyEntryRule = 'latest' | 'first';

/** which of `cities` the panel actually scores.
 *  'all'  — every configured city (the frozen default);
 *  'topK' — only the k best cities by recent prediction hit rate (graded ≥ minGraded over windowDays), the
 *           "survivor" pre-registration. Requires cityHitRates on the panel call; without them NO city is
 *           eligible (fail-closed — a missing input must never silently widen the universe). */
export type CheapEarlyCityFilter =
  | { kind: 'all' }
  | { kind: 'topK'; k: number; minGraded: number; windowDays: number };

/** one city's recent prediction hit rate (cheap_early_city_hit_rates, 0127) — the topK filter's input. */
export interface CheapEarlyCityHitRate {
  hitRate: number;
  graded: number;
}

/** citySlug → its recent hit rate. */
export type CheapEarlyCityHitRates = Record<string, CheapEarlyCityHitRate>;

/** The cheap-early engine's frozen config — the strategy under test (handoff §0). */
export interface CheapEarlyCfg {
  /** the scored universe. Default the 4 live cities; WIDENING is the one allowed variation (it raises the fire
   *  rate + powers the gate sooner — the mechanism is not city-specific). Make it a config list, record which
   *  set each snapshot used. */
  cities: string[];
  /** the near edge of the entry window in HOURS-TO-CLOSE (24 — the latest allowable, most-liquid entry). */
  windowLoH: number;
  /** the far edge of the entry window in hours-to-close (36 — before the thin open, after the lost-causes hours). */
  windowHiH: number;
  /** the cheap-ask band lower bound (0.20). */
  askBandLo: number;
  /** the cheap-ask band upper bound (0.33 — the ≥3× cap the operator's thesis requires). */
  askBandHi: number;
  /** the paper stake ($) — ALSO the executable-depth floor a pick must carry to count as fillable (handoff §0). */
  stakeUsd: number;
  /** the weather taker fee rate the paper model charges (V2 fees are protocol-set; paper models it). */
  takerFeeRate: number;
  /** which in-window tick to enter on ('latest' — the frozen/tested rule; 'first' — the live lane's rule). */
  entryRule: CheapEarlyEntryRule;
  /** minimum houseProb − ask the pick must carry to be entered. 0 DISABLES the gate (the frozen default —
   *  the canonical rule enters on the band alone, so a 0 must not start filtering picks priced above house). */
  minEdge: number;
  /** which configured cities are actually scored (the frozen default is every one of them). */
  cityFilter: CheapEarlyCityFilter;
}

/** the frozen 4 live cities (cheap-entry-realbook.py's LIVE set). Widening is the one allowed variation. */
export const CHEAP_EARLY_CITIES = ['ankara', 'helsinki', 'kuala-lumpur', 'wellington'] as const;

/** the frozen strategy params (PINNED IN CODE, like MAKER_EXIT_TUNED — so the loop never mutates the shared
 *  bot.* config keys the capture + convergence panels read). Only `cities` is operator-tunable (the widening). */
export const CHEAP_EARLY_DEFAULTS = {
  windowLoH: 24,
  windowHiH: 36,
  askBandLo: 0.2,
  askBandHi: 0.33,
  stakeUsd: 20,
  takerFeeRate: 0.05,
  entryRule: 'latest',
  minEdge: 0,
  cityFilter: { kind: 'all' },
} as const;

/** Build the frozen CheapEarlyCfg for a city set. `over` lets a test/override tighten one knob without forking. */
export function cheapEarlyCfg(cities: string[], over: Partial<CheapEarlyCfg> = {}): CheapEarlyCfg {
  return { cities, ...CHEAP_EARLY_DEFAULTS, ...over };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The PRE-REGISTERED forward variants (2026-08-15, docs/ops/CHEAP-EARLY-IMPROVE.md §8)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** the offline real-book sweep's read for a variant (Jul 5 – Aug 15, city-clustered CI on net per $1) — carried
 *  in code so the page can show BACKTEST vs FORWARD side by side and the forward run cannot be re-narrated. */
export interface CheapEarlyBacktestRef {
  n: number;
  netRet: number;
  ciLow: number;
  ciHigh: number;
}

/** one pre-registered variant: an id, the operator-facing label, the cfg delta off the canonical config, and the
 *  backtest cell it was registered from. The set is CODE (pre-registered) — there is no config surface to edit
 *  it, because a variant you can re-tune after seeing the forward read is not a forward test. */
export interface CheapEarlyVariant {
  id: string;
  label: string;
  over: Partial<CheapEarlyCfg>;
  backtestRef: CheapEarlyBacktestRef;
}

/** the canonical variant's id — its block mirrors the view's top-level entries/money/gate and it is the ONLY
 *  one whose verdict is ever written to the gate of record (bot_gate_snapshot). */
export const CANONICAL_VARIANT_ID = 'canonical';

/**
 * The six variants scored side by side on every tick. Pre-registered 2026-08-15 from the 3,960-cell real-book
 * sweep (CHEAP-EARLY-IMPROVE.md): the sweep found NO lever that improves the cell — every CI straddles zero —
 * with one exception, `survivor`, the single positive cell of 3,960, which is exactly the shape a multiple-
 * comparisons artifact takes. It is registered here to be KILLED or CONFIRMED forward, not to be believed.
 * PAPER ONLY: a variant verdict never touches bot_gate_snapshot (only the canonical gate write does).
 */
export const CHEAP_EARLY_VARIANTS: readonly CheapEarlyVariant[] = [
  {
    id: CANONICAL_VARIANT_ID,
    label: 'tested rule [24,36] × [0.20,0.33]',
    over: {},
    backtestRef: { n: 689, netRet: -0.037, ciLow: -0.181, ciHigh: 0.11 },
  },
  {
    id: 'live-replica',
    label: 'what live did — first-in-window (~36h)',
    over: { entryRule: 'first' },
    backtestRef: { n: 689, netRet: -0.069, ciLow: -0.2, ciHigh: 0.069 },
  },
  {
    id: 'wide-band',
    label: '[24,36] × [0.15,0.40]',
    over: { askBandLo: 0.15, askBandHi: 0.4 },
    backtestRef: { n: 895, netRet: -0.005, ciLow: -0.13, ciHigh: 0.09 },
  },
  {
    id: 'wide-band-open',
    label: '[24,36] × [0.10,0.50]',
    over: { askBandLo: 0.1, askBandHi: 0.5 },
    backtestRef: { n: 978, netRet: 0.004, ciLow: -0.13, ciHigh: 0.1 },
  },
  {
    id: 'late-12h',
    label: '[12,15] × [0.15,0.40]',
    over: { windowLoH: 12, windowHiH: 15, askBandLo: 0.15, askBandHi: 0.4 },
    backtestRef: { n: 860, netRet: -0.005, ciLow: -0.12, ciHigh: 0.1 },
  },
  {
    id: 'survivor',
    label: '[33,36] × [0.30,0.33] · margin 0.05 · top-20 cities',
    over: {
      windowLoH: 33,
      windowHiH: 36,
      askBandLo: 0.3,
      askBandHi: 0.33,
      minEdge: 0.05,
      cityFilter: { kind: 'topK', k: 20, minGraded: 8, windowDays: 28 },
    },
    backtestRef: { n: 42, netRet: 0.396, ciLow: 0.004, ciHigh: 1.24 },
  },
] as const;

/** Bump when the entry/gate semantics or the variant set change — the tag is stamped on the view so an old
 *  snapshot can never be read as if it came from the current engine. ce2 (2026-08-15): the variant sweep
 *  (entryRule / minEdge / cityFilter) lands on top of the frozen ce1 canonical rule. */
export const CHEAP_EARLY_ENGINE_VERSION = 'ce2';

/** Build a variant's effective cfg off the live canonical config (so a city widening/pause applies to all six). */
export function cheapEarlyVariantCfg(base: CheapEarlyCfg, v: CheapEarlyVariant): CheapEarlyCfg {
  return { ...base, ...v.over };
}

/** The UNION entry window across the canonical cfg + every variant — what the slim inputs RPC must ship so no
 *  variant is starved of the ticks its window needs (0126's p_window_lo_h / p_window_hi_h). */
export function cheapEarlyWindowUnion(
  base: CheapEarlyCfg,
  variants: readonly CheapEarlyVariant[] = CHEAP_EARLY_VARIANTS,
): { loH: number; hiH: number } {
  let loH = base.windowLoH;
  let hiH = base.windowHiH;
  for (const v of Array.isArray(variants) ? variants : []) {
    const c = cheapEarlyVariantCfg(base, v);
    if (Number.isFinite(c.windowLoH)) loH = Math.min(loH, c.windowLoH);
    if (Number.isFinite(c.windowHiH)) hiH = Math.max(hiH, c.windowHiH);
  }
  return { loH, hiH };
}

/**
 * The cities a cfg actually scores. 'all' → every configured city. 'topK' → the k highest recent hit rates
 * among the configured cities with graded ≥ minGraded (ties broken stably by slug). FAIL-CLOSED: a topK filter
 * with no hit rates scores NOTHING (a missing input must never silently widen the universe back to 'all').
 */
export function cheapEarlyEligibleCities(cfg: CheapEarlyCfg, hitRates?: CheapEarlyCityHitRates): string[] {
  const cities = Array.isArray(cfg?.cities) ? cfg.cities : [];
  const filter = cfg?.cityFilter ?? { kind: 'all' };
  if (filter.kind !== 'topK') return [...cities];
  if (!hitRates) return [];
  const minGraded = Number.isFinite(filter.minGraded) ? filter.minGraded : 0;
  const k = Number.isFinite(filter.k) ? Math.max(0, Math.trunc(filter.k)) : 0;
  return cities
    .map((city) => ({ city, r: hitRates[city] }))
    .filter((x) => !!x.r && fin(x.r.hitRate) && (x.r.graded ?? 0) >= minGraded)
    .sort((a, b) => (b.r!.hitRate - a.r!.hitRate) || a.city.localeCompare(b.city))
    .slice(0, k)
    .map((x) => x.city);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Trade
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** why a market did not produce an entry (the non-fill reasons — surfaced in the panel's reasonTally). */
export type CheapEarlyReason =
  | 'off_universe' // city outside the scored allowlist
  | 'no_ticks' // empty/absent capture series
  | 'no_resolve_clock' // no Gamma endDate → hours-to-close is uncomputable → cannot window
  | 'grading_mismatch' // venue↔truth disagreement — ambiguous payout, out of scoring
  | 'no_in_window_capture' // no capture in [windowLoH, windowHiH]h-to-close with a quotable, temperature-labelled pick
  | 'ask_out_of_band' // the latest in-window pick's bestAsk fell outside [askBandLo, askBandHi]
  | 'thin_depth' // the pick's executable depth was below the stake (not fillable)
  | 'below_min_edge'; // houseProb − ask fell short of cfg.minEdge (only ever raised when minEdge > 0)

/** One market's realized cheap-early paper trade (or a non-entry, entered:false + reason). */
export interface CheapEarlyTrade {
  eventId: string;
  city: string;
  targetDate: string;
  /** passed EVERY gate (in-window capture + ask band + depth) — the ledger/verdict inclusion flag. */
  entered: boolean;
  /** '' when entered; else the gate that failed (a CheapEarlyReason). */
  reason: string;
  /** the house-pick bucket label bought — our predicted-Tmax bucket / the temperature the bet opened on. */
  entryLabel: string;
  /** the integer temperature parsed from entryLabel (the sort-safe grade key — traps #7). null when unparseable. */
  entryTemp: number | null;
  /** hours-to-close at the entry (fill) tick — the "latest allowable" point in the window. */
  htcAtEntry: number | null;
  /** the bestAsk paid (taker). NaN when never entered. */
  entryAsk: number;
  /** the pick's executable buy-side depth ($) at the entry tick. */
  depthUsd: number;
  /** observed top-of-book spread (bestAsk − bestBid) at entry — the measured round-trip cost (confirms §3). NaN
   *  if a side is missing. */
  observedSpread: number;
  /** the winning bucket's temperature (parsed from ITS label by winnerIdx lookup — never an index compare). null
   *  when unresolved / unlabelled. */
  winnerTemp: number | null;
  /** won = (entryTemp === winnerTemp); null when unresolved (an open position). */
  won: boolean | null;
  /** realized = graded at resolution; open = still pending (excluded from the §9R-E verdict, marked for money). */
  status: 'realized' | 'open';
  stakeUsd: number;
  feeUsd: number;
  netPnlUsd: number;
  netReturn: number;
}

const NOT_ENTERED = (
  eventId: string,
  city: string,
  targetDate: string,
  reason: CheapEarlyReason,
  diag: Partial<CheapEarlyTrade> = {},
): CheapEarlyTrade => ({
  eventId, city, targetDate, entered: false, reason,
  entryLabel: '', entryTemp: null, htcAtEntry: null, entryAsk: NaN, depthUsd: NaN, observedSpread: NaN,
  winnerTemp: null, won: null, status: 'realized', stakeUsd: 0, feeUsd: 0, netPnlUsd: 0, netReturn: NaN,
  ...diag,
});

/** Parse the leading (signed) integer temperature from a bucket label — the sort-safe grade key. Mirrors
 *  cheap-entry-realbook.py's `re.search(r"-?\d+", label)`. null when the label carries no integer. */
export function parseTemp(label: string | null | undefined): number | null {
  const m = /-?\d+/.exec(String(label ?? ''));
  return m ? parseInt(m[0], 10) : null;
}

/** the argmax-houseProb bucket over the quotable buckets at a tick (first-wins on a tie — the Python's strict `>`).
 *  null when no bucket carries a finite houseProb. */
function pickBucket(buckets: OpeningBucket[]): OpeningBucket | null {
  let best: OpeningBucket | null = null;
  for (const b of Array.isArray(buckets) ? buckets : []) {
    if (!b || !fin(b.houseProb)) continue;
    if (best === null || b.houseProb > (best.houseProb as number)) best = b;
  }
  return best;
}

/** the winning bucket's LABEL by winnerIdx lookup across the event's ticks (the buckets are internally
 *  index-consistent within a capture) → parsed temperature. NEVER an index compare against the pick (traps #7):
 *  we route the winner through its own label so the grade is temperature-vs-temperature. null when no tick
 *  carries a labelled bucket at winnerIdx. */
function winnerTempOf(ticks: ReplayTick[], winnerIdx: number): number | null {
  for (const t of Array.isArray(ticks) ? ticks : []) {
    for (const b of Array.isArray(t.buckets) ? t.buckets : []) {
      if (b && b.idx === winnerIdx) {
        const temp = parseTemp(b.label);
        if (temp !== null) return temp;
      }
    }
  }
  return null;
}

/** the pick bucket's last realizable execBid (or bestBid) across ticks from `fromIdx` — the conservative mark for
 *  an unresolved (open) position (mtm; never a trade, so no exit fee). null when the book showed no bid. */
function lastBidOf(ticks: ReplayTick[], idx: number, fromIdx: number): number | null {
  let last: number | null = null;
  for (let j = Math.max(0, fromIdx); j < ticks.length; j++) {
    const b = (Array.isArray(ticks[j]!.buckets) ? ticks[j]!.buckets : []).find((x) => x && x.idx === idx);
    if (b && fin(b.execBid)) last = b.execBid;
    else if (b && fin(b.bestBid)) last = b.bestBid;
  }
  return last;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · replayCheapEarlyEvent — window → pick → band/depth gate → hold-to-resolution grade
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Replay ONE market's cheap-early paper trade. `resolvesAtMs` is the venue resolution epoch (the Gamma endDate)
 * — the hours-to-close clock the entry window is defined against (the ReplayTick series drops resolvesAt, so it
 * is threaded in, exactly as replayMakerExitEvent threads its time-stop anchor). Pure + total.
 */
export function replayCheapEarlyEvent(
  input: EventReplayInput,
  cfg: CheapEarlyCfg,
  resolvesAtMs: number | null,
): CheapEarlyTrade {
  const eventId = input?.eventId ?? '';
  const city = input?.city ?? '';
  const targetDate = input?.targetDate ?? '';
  if (!input || !Array.isArray(input.ticks) || input.ticks.length === 0) {
    return NOT_ENTERED(eventId, city, targetDate, 'no_ticks');
  }
  if (!cfg.cities.includes(city)) return NOT_ENTERED(eventId, city, targetDate, 'off_universe');
  if (input.resolution?.gradingMismatch) return NOT_ENTERED(eventId, city, targetDate, 'grading_mismatch');
  if (!fin(resolvesAtMs)) return NOT_ENTERED(eventId, city, targetDate, 'no_resolve_clock');

  const ticks = input.ticks;

  // ── (1) the in-window CANDIDATES: ticks whose hours-to-close sits in [windowLoH, windowHiH] and whose
  //    argmax-houseProb pick is quotable (finite bestAsk) AND temperature-labelled (matches the Python's
  //    bestAsk-not-None + pick_temp-not-None candidate filter). No look-ahead — the window is the wall clock
  //    to resolution, never the outcome. ──
  interface Candidate { i: number; htc: number; capMs: number; pick: OpeningBucket }
  const candidates: Candidate[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]!;
    const capMs = new Date(t.capturedAt).getTime();
    if (!Number.isFinite(capMs)) continue;
    const htc = (resolvesAtMs - capMs) / 3_600_000;
    if (!(htc >= cfg.windowLoH && htc <= cfg.windowHiH)) continue;
    const pick = pickBucket(t.buckets);
    if (!pick || !fin(pick.bestAsk) || parseTemp(pick.label) === null) continue;
    candidates.push({ i, htc, capMs, pick });
  }
  if (candidates.length === 0) return NOT_ENTERED(eventId, city, targetDate, 'no_in_window_capture');

  // ── (2) the price + depth (+ margin) gate, as a predicate — 'latest' applies it to the chosen tick,
  //    'first' searches for the earliest tick that clears it (what the live lane does). minEdge 0 disables
  //    the margin leg entirely, so the canonical rule is byte-identical to the pre-variant engine. ──
  const gateOf = (pick: OpeningBucket): CheapEarlyReason | '' => {
    const ask = pick.bestAsk as number;
    if (ask < cfg.askBandLo || ask > cfg.askBandHi) return 'ask_out_of_band';
    if (!(pick.depthUsd >= cfg.stakeUsd)) return 'thin_depth';
    if (cfg.minEdge > 0 && !(fin(pick.houseProb) && pick.houseProb - ask >= cfg.minEdge)) return 'below_min_edge';
    return '';
  };

  // ── (3) choose the entry tick.
  //    'latest' (frozen/tested): the SMALLEST hours-to-close in the window — first minimum wins on a tie,
  //      matching cheap-entry-realbook.py's `r.htc < picks[k].htc`; the gate is then applied to it.
  //    'first' (live replica): the EARLIEST capture that clears the gate. When none does, the reported reason
  //      is the earliest candidate's failure — the deterministic, interpretable representative. ──
  let entry: Candidate | null = null;
  let blocked: { c: Candidate; reason: CheapEarlyReason } | null = null;
  if (cfg.entryRule === 'first') {
    const ascending = [...candidates].sort((a, b) => a.capMs - b.capMs || a.i - b.i);
    for (const c of ascending) {
      const r = gateOf(c.pick);
      if (!r) { entry = c; break; }
      if (!blocked) blocked = { c, reason: r };
    }
  } else {
    let best = candidates[0]!;
    for (const c of candidates) if (c.htc < best.htc) best = c;
    const r = gateOf(best.pick);
    if (r) blocked = { c: best, reason: r };
    else entry = best;
  }

  const shown = entry ?? blocked!.c;
  const entryPick = shown.pick;
  const entryIdx = shown.i;
  const entryHtc = shown.htc;
  const entryAsk = entryPick.bestAsk as number;
  const depthUsd = entryPick.depthUsd;
  const observedSpread = fin(entryPick.bestBid) ? entryAsk - entryPick.bestBid : NaN;
  const entryLabel = entryPick.label;
  const entryTemp = parseTemp(entryLabel);
  const bucketIdx = entryPick.idx;
  const diag: Partial<CheapEarlyTrade> = {
    entryLabel, entryTemp, htcAtEntry: entryHtc, entryAsk, depthUsd, observedSpread,
  };
  if (!entry) return NOT_ENTERED(eventId, city, targetDate, blocked!.reason, diag);

  // ── (4) taker fill at bestAsk + hold to resolution ─────────────────────────────────────────────────────
  const stakeUsd = cfg.stakeUsd;
  const shares = stakeUsd / entryAsk;
  const feeUsd = takerFeePerShare(entryAsk, cfg.takerFeeRate) * shares; // the entry taker fee (only leg — we hold)

  // ── (5) grade at resolution (label-based; winnerIdx routed through ITS label — never a pick-index compare) ──
  const winnerIdx = input.resolution?.winnerIdx ?? null;
  if (winnerIdx == null) {
    // unresolved → an OPEN position: mark conservatively to the last realizable bid (mtm; excluded from the gate).
    const mark = lastBidOf(ticks, bucketIdx, entryIdx);
    const markPx = fin(mark) ? mark : 0;
    const netPnlUsd = shares * markPx - stakeUsd - feeUsd;
    return {
      eventId, city, targetDate, entered: true, reason: '',
      entryLabel, entryTemp, htcAtEntry: entryHtc, entryAsk, depthUsd, observedSpread,
      winnerTemp: null, won: null, status: 'open', stakeUsd, feeUsd, netPnlUsd,
      netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN,
    };
  }

  const winnerTemp = winnerTempOf(ticks, winnerIdx);
  const won = entryTemp != null && winnerTemp != null ? entryTemp === winnerTemp : false;
  const payout = won ? shares : 0; // redeem at resolution ($1/share on the winner) — no taker exit fee
  const netPnlUsd = payout - stakeUsd - feeUsd;
  return {
    eventId, city, targetDate, entered: true, reason: '',
    entryLabel, entryTemp, htcAtEntry: entryHtc, entryAsk, depthUsd, observedSpread,
    winnerTemp, won, status: 'realized', stakeUsd, feeUsd, netPnlUsd,
    netReturn: stakeUsd > 0 ? netPnlUsd / stakeUsd : NaN,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · replayCheapEarlyPanel — run every event, return the §9R-E verdict + the ledger + the cost/extent reads
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface CheapEarlyPanel {
  /** every ENTERED trade (realized + open) — the ledger the money tracker + entries table read. */
  ledger: CheapEarlyTrade[];
  /**
   * the frozen §9R-E verdict over the REALIZED entered trades. minWinFrac is forced to 0: this is a PRICE-RETURN
   * bet (a cheap longshot that pays ≥3×), not a bucket-hit bet — a 25%-win-rate panel can be strongly +EV, so
   * the gate binds on the city-clustered mean net-return ciLow > 0 + the zero-skill sign-flip MC < 5% (handoff
   * §2), NOT on winFrac ≥ 0.5. priceBasis 'real-book' — the loop replays the REAL captured book.
   */
  verdict: OpeningVerdict;
  /** mean realized net return + total net $ over the realized trades. */
  meanNetReturn: number;
  totalNetUsd: number;
  /** the bucket-hit rate over realized trades (winFrac == the fraction with netPnl>0 for a hold bet) —
   *  INFORMATIONAL (it is NOT the gate bar; a ≥3× bet wins < 50% of the time and is still +EV). */
  winRate: number;
  nExecuted: number; // entered trades (realized + open)
  nRealized: number;
  /** cost + capacity reads over realized trades (confirm CHEAP-EARLY-ENTRY.md §3: tight spread, ample depth). */
  meanEntryAsk: number;
  meanDepthUsd: number;
  meanObservedSpread: number;
  /** the entry-rate denominator (fresh, gm-excluded events considered) + why the rest did not enter. */
  nConsidered: number;
  reasonTally: Record<string, number>;
  /** the cities this run actually scored — cfg.cities under 'all', the surviving top-K under 'topK' (empty when
   *  a topK filter had no hit rates: fail-closed, the variant simply scores nothing). */
  scoredCities: string[];
}

/**
 * Replay the cheap-early strategy over a panel. `resolvesByEvent` maps eventId → the venue resolution epoch ms
 * (the hours-to-close clock); a missing/absent entry drops that market (no_resolve_clock — cannot window). The
 * verdict scores REALIZED trades only (open/mtm excluded — the one false-GO direction). grading_mismatch markets
 * are excluded from scoring (ambiguous payout) but still counted as considered (reasonTally.grading_mismatch).
 */
export function replayCheapEarlyPanel(
  events: EventReplayInput[],
  cfg: CheapEarlyCfg,
  resolvesByEvent: Map<string, number | null>,
  verdictOpts: VerdictOpts = {},
  cityHitRates?: CheapEarlyCityHitRates,
): CheapEarlyPanel {
  const evs = (Array.isArray(events) ? events : []).filter((e): e is EventReplayInput => !!e && Array.isArray(e.ticks));
  // the cityFilter is resolved ONCE per panel and folded into the scoped cfg, so the per-event replay keeps its
  // single "is this city in scope" test (cfg.cities) and cannot drift from the panel's denominator.
  const scoredCities = cheapEarlyEligibleCities(cfg, cityHitRates);
  const scoped: CheapEarlyCfg = { ...cfg, cities: scoredCities };
  const ledger: CheapEarlyTrade[] = [];
  const panel: OpeningMarketResult[] = [];
  const reasonTally: Record<string, number> = {};
  let nConsidered = 0;
  let realized = 0;
  for (const e of evs) {
    // off-universe markets are not "considered" (they were never in scope); everything else counts toward the
    // fresh entry-rate denominator, including grading_mismatch (tallied but never scored).
    if (!scoped.cities.includes(e.city)) continue;
    nConsidered++;
    const t = replayCheapEarlyEvent(e, scoped, resolvesByEvent.get(e.eventId) ?? null);
    if (!t.entered) {
      reasonTally[t.reason] = (reasonTally[t.reason] ?? 0) + 1;
      continue;
    }
    if (!Number.isFinite(t.netReturn) || !Number.isFinite(t.netPnlUsd)) continue;
    ledger.push(t);
    if (t.status === 'realized') {
      realized++;
      panel.push({ city: e.city, targetDate: e.targetDate, netPnlUsd: t.netPnlUsd, stakeUsd: t.stakeUsd, netReturn: t.netReturn, executed: true });
    }
  }
  // minWinFrac 0 → the gate binds on ciLow>0 + zero-skill MC only (handoff §2); real-book basis (the whole point
  // vs the synthetic-book backtests that false-passed). A caller MAY override, but never RAISE minWinFrac here.
  const verdict = openingVerdict(panel, { priceBasis: 'real-book', minWinFrac: 0, ...verdictOpts });
  const realizedRows = ledger.filter((t) => t.status === 'realized');
  return {
    ledger,
    verdict,
    meanNetReturn: mean(realizedRows.map((t) => t.netReturn)),
    totalNetUsd: realizedRows.reduce((a, t) => a + t.netPnlUsd, 0),
    winRate: realizedRows.length ? realizedRows.filter((t) => t.netPnlUsd > 0).length / realizedRows.length : NaN,
    nExecuted: ledger.length,
    nRealized: realized,
    meanEntryAsk: mean(realizedRows.map((t) => t.entryAsk)),
    meanDepthUsd: mean(realizedRows.map((t) => t.depthUsd)),
    meanObservedSpread: mean(realizedRows.map((t) => t.observedSpread)),
    nConsidered,
    reasonTally,
    scoredCities,
  };
}
