/**
 * scripts/lib/trade-bot-decide — the PURE decision spine of the live maker-exit trading daemon (T2 lane).
 *
 * The daemon (`scripts/trade-bot.ts`) is a thin I/O shell over THIS module: every tick it discovers
 * candidates + reconstructs open positions (I/O), then calls `decideTick(state) → TickPlan` (PURE), then
 * `applyPlan(plan, executor, …)` drives the T1 MakerExecutor. Splitting the decision from the I/O is what
 * makes the money-path logic unit-testable with NO network — the whole point of the "tick → intents"
 * contract. Nothing here opens a socket, reads a key, or touches the DB; it maps facts → intents.
 *
 * STRATEGY = the tuned MAKER-EXIT convergence lever (MAKER-EXIT-SIM.md, the §5 sweep optimum:
 * tp 0.12 / sl 0.20 / tstop 18h / chw 0 / maxEntry 0.30 / depth $150 / makerWindow 30). The live twin of
 * `core/sim/opening-maker-exit-replay.ts` (`runMakerExitLeg`): buy the forecast-center bucket cheap as a
 * resting MAKER, rest a MAKER take-profit at entry+tp, and flatten as a TAKER on the stop-loss or the
 * `resolvesAt − 18h` time-stop. The entry gate reuses the replay's own `selectEntries` verbatim
 * (`discoverCandidates` below) — one source of truth for "which bucket, at what price".
 *
 * DELIBERATE LIVE-vs-REPLAY DIVERGENCE (documented, not accidental):
 *   • Entry maker window: the replay's fill MODEL, when the maker window elapses, takes a pessimistic
 *     TAKER fallback (it is scoring what a fill WOULD cost). The LIVE rail instead RE-PEGS the resting
 *     maker entry via `executor.reprice` (cancel-then-repost the remainder inside the current spread) —
 *     preserving the maker $0-fee entry rather than crossing the spread and paying taker fees + chasing a
 *     runaway book (§12 adverse-selection). If the book has run past the reservation the reprice's inner
 *     place returns `not_makeable` and the entry is abandoned (key freed) — the opportunity passed.
 *   • Mark source: the replay reads a captured tick's `execBid`; the live rail reads the CURRENT
 *     executable bid at decision time (the daemon fetches it and passes it in as `position.mark`).
 *
 * GATING (checklist semantics — every reason is surfaced, never short-circuited into silence):
 *   ENTRIES are gated by allowlist / maxEntry / depth-floor / min-size, and in LIVE mode additionally by
 *   the preflight interlock (`trade_live_preflight`) + the per-market / total-concurrent caps read from the
 *   preflight `checks` payload. EXITS (TP rest / SL / time-stop) are NEVER cap- or preflight-gated: a
 *   position must always be able to flatten (the daily-loss kill + a de-activated console only gate NEW
 *   entries, exactly as GO-LIVE-CHECKLIST-OPENING.md §5 requires). When the LIVE preflight FAILS (kill
 *   tripped / console off / window expired), FULLY-UNFILLED resting maker ENTRIES are additionally
 *   CANCELLED — a working entry is future exposure and must stop within one tick of a kill; reprice_entry
 *   is likewise preflight-gated (lens MEDIUM-2). A PARTIALLY-filled entry's resting remainder is
 *   DELIBERATELY LEFT WORKING under a kill (lens NEW-LOW-2): cancelling it would `record_canceled` the
 *   entry row → terminal → invisible to `bot_order_by_intent` → the NEXT tick could no longer reconstruct
 *   the position and the HELD shares would lose their stop-loss/time-stop backstop. The remainder's
 *   exposure is already counted by the preflight as committed capital, so cancelling buys little and
 *   costs the position's reconstructability — held shares staying managed outranks it. `off` → the plan
 *   is empty. `dry-run` → the caps/preflight gates are skipped (dry-run rows never count toward live
 *   caps, 0082 header) but every strategy gate still applies.
 *
 * SOLD-TRUTH ACCOUNTING (lens CRITICAL-1 + LOW-5): `remaining = filledSize − soldSize`, where `soldSize`
 * counts EVERY sell-side fill of the position — the take-profit's, the stop-loss's, AND the time-stop's.
 * The ledger read alone cannot carry this: `bot_order_by_intent` hides terminal canceled/failed rows
 * (0082 `status not in ('canceled','failed')`), and `executor.cancel` records a lifted-then-cancelled TP
 * as canceled — its partial fills VANISH from the visible rows (`size_matched` is preserved in the DB but
 * unreadable through the port). So `assemblePosition` also takes venue trade truth (`getTrades`, the same
 * evidence read reconcile uses — the daemon sums our SELL fills for the token) and uses
 * `max(visibleLedgerFills, venueSold)`; dry-run has no venue and its rows never fill, so the visible sum
 * is exact. A fully-covered position plans NOTHING — once the TP has filled everything, neither the
 * stop-loss nor the time-stop can ever fire (the over-sell path is closed).
 *
 * DEGRADED-MODE SELL HOLD (lens NEW-LOW-1): the venue trade read is SAFETY-LOAD-BEARING, not telemetry.
 * While `getTrades` is unavailable for a live position's token (`soldTruthDegraded`), `soldSize` may be
 * UNDERSTATED (fills on invisible terminal-canceled rows), so NO sell may be sized from it:
 * `planForPosition` holds the taker exits AND the TP rest for that position this tick (an ALREADY-resting
 * TP stays — it was sized when truth was known), `decideTick` surfaces a `sell_hold_degraded` skip, and
 * the daemon fires a CRITICAL `sellHoldAlerts` alert EVERY affected tick — never silent. The over-sell
 * guarantee outranks exit latency: the position is §9R-capped, and relying on the venue's balance check
 * to reject an oversized SELL is not accounting. Sells resume, correctly sized, the tick the read
 * recovers. Dry-run is never degraded (no venue; its rows never fill, so the visible sum is exact).
 *
 * FAK ADJUDICATION (lens MEDIUM-3): a taker exit posts as FAK — venue-dead the instant its immediate
 * execution completes. A partial (or 0-fill, still-'placed') FAK row is therefore a CORPSE holding the
 * intent key: `placeTaker` would return a silent 'duplicate' forever and the remainder could never
 * re-fire (a stuck time-stop rides to resolution). `applyPlan` adjudicates such a row terminal via
 * `recordCanceled` (the seam preserves `size_matched`; the partial-unique frees the key) — loudly (log +
 * WARN alert), never silently — then re-fires the remainder. Rows still at 'intent' (no orderId — the
 * post outcome is unknown) are NOT adjudicated: the startup reconcile sweep owns those.
 *
 * TP-CANCEL RACE GUARD: before a taker exit, the resting TP is cancelled. If the venue reports the cancel
 * did NOT fully take (`allCanceled=false` — the TP raced a fill), the taker is ABORTED for this tick: the
 * raced fill means `remaining` is stale-high and posting would over-sell. The next tick's fill-poll picks
 * up the raced fill and re-decides with correct accounting.
 */
import {
  localHourInstant,
  mapBucket,
  selectEntries,
  type EntryCandidate,
  type MakerExitCfg,
  type OpeningBucket,
  type OpeningCapture,
  type RawCaptureRow,
} from '../../packages/core/src/index.ts';
import {
  orderIntentKey,
  redactText,
  STAKE_CEILING_USD,
  type CancelResult,
  type MakerOrderRequest,
  type OrderLedger,
  type OrderLedgerRow,
  type OrderPlacementResult,
  type OrderPurpose,
  type TakerOrderRequest,
  type TradeAlert,
  type TradeConfig,
  type TradeMode,
  type TradePreflight,
} from '../../packages/trading/src/index.ts';

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Config — the subset of the tuned MAKER-EXIT strategy the decision spine reads. The daemon derives it
// from `makerExitCfg(cities)` (core, the pinned §9R + tuned constants) via `toDecideCfg`; tests build a
// literal. `minOrderSizeShares` is a BotConfig field (not on MakerExitCfg's type), so it is passed
// explicitly rather than reached through the wider config.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface DecideCfg {
  /** the effective trade allowlist (trade_config.city_allowlist ∩ the capture universe). */
  cities: string[];
  /** 0.30 — never enter above this (also the entry reservation ceiling). */
  maxEntryPrice: number;
  /** $150 — a center bucket needs at least this walked depth to be enterable. */
  depthFloorUsd: number;
  /** the ask must sit at least this far below our model prob (the entry reservation margin). */
  entryEdgeMargin: number;
  /** 0.12 — resting maker take-profit at entry + this. */
  tpDeltaPp: number;
  /** 0.20 — the operator-locked absolute stop (ternary with slFrac). */
  slDeltaPp: number;
  /** 0.50 — the relative stop floor for the cheapest band where −slDeltaPp is inert. */
  slFrac: number;
  /** 30 — a resting maker ENTRY past this many minutes is re-pegged (reprice). */
  makerFillWindowMin: number;
  /** 18 — the hard time-stop: flatten (taker) at the latest this many hours before resolution. */
  tstopHoursBeforeResolve: number;
  /** 12 — the local-noon fallback time-stop hour when resolvesAt is unknown. */
  timeStopLocalHour: number;
  /** the venue order floor in shares (BotConfig.minOrderSizeShares, ≈5) — below it the venue rejects. */
  minOrderSizeShares: number;
  /** weather is negRisk winner-take-all (default true). */
  negRisk: boolean;
}

/** Build the decision cfg from the pinned `makerExitCfg(cities)` + the BotConfig min-order-size floor. */
export function toDecideCfg(cfg: MakerExitCfg, minOrderSizeShares: number): DecideCfg {
  return {
    cities: cfg.cities,
    maxEntryPrice: cfg.maxEntryPrice,
    depthFloorUsd: cfg.depthFloorUsd,
    entryEdgeMargin: cfg.entryEdgeMargin,
    tpDeltaPp: cfg.tpDeltaPp,
    slDeltaPp: cfg.slDeltaPp,
    slFrac: cfg.slFrac,
    makerFillWindowMin: cfg.makerFillWindowMin,
    tstopHoursBeforeResolve: cfg.tstopHoursBeforeResolve,
    timeStopLocalHour: cfg.timeStopLocalHour,
    minOrderSizeShares,
    negRisk: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Discovery — the fresh-market candidate pool, derived from the live `opening_captures` stream (the same
// pipeline the maker-exit paper loop replays), reusing `selectEntries` for the entry semantics.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One enterable forecast-center bucket, plus the round-trip metrics the live gates + time-stop need. */
export interface DiscoveredCandidate {
  /** conditionId — the market identity (the idempotency-key market component + cancel-by-market). */
  marketId: string;
  /** the YES token of the forecast-center bucket. */
  tokenId: string;
  city: string;
  /** station-local YYYY-MM-DD — the intent-key date + the local-noon time-stop calendar day. */
  targetDate: string;
  tz: string;
  bucketIdx: number;
  label: string;
  /** the executable ask at the entry size — the maxEntry gate input + the share-sizing denominator. */
  execAsk: number;
  /** our house_gaussian prob for the bucket (the convergence target; consensusSource-dependent). */
  modelProb: number;
  /** the walked $ depth of the bucket — the depth-floor gate input. */
  depthUsd: number;
  /** the resting maker BUY ceiling (`selectEntries` — the executor shades it one tick + posts post_only). */
  makerLimit: number;
  bestBid: number | null;
  bestAsk: number | null;
  /** the venue resolution epoch (Gamma endDate) — the `resolvesAt − Nh` time-stop anchor; null ⇒ noon fallback. */
  resolvesAtMs: number | null;
}

const tms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

/** Map one raw `opening_captures` row → the core `OpeningCapture` `selectEntries` reads. Pure + total. */
export function captureFromRaw(raw: RawCaptureRow): OpeningCapture {
  const buckets: OpeningBucket[] = Array.isArray(raw.buckets) ? raw.buckets.map(mapBucket) : [];
  return {
    eventId: raw.eventId ?? null,
    city: String(raw.city ?? ''),
    targetDate: String(raw.targetDate ?? ''),
    tz: String(raw.tzName ?? ''),
    createdAtGamma: raw.createdAtGamma ?? null,
    hoursSinceListing: raw.hoursSinceListing == null ? NaN : Number(raw.hoursSinceListing),
    resolvesAt: raw.resolvesAt ?? null,
    negRisk: raw.negRisk ?? true,
    evVol24h: raw.evVol24h ?? null,
    buckets,
    houseSeeded: raw.houseSeeded ?? false,
  };
}

/**
 * Turn the raw capture series into the current enterable candidate pool: group by event, take the LATEST
 * tick per event (the freshest live book), and run `selectEntries(requireFlatOpen:false)` on it — the exact
 * entry semantics the replay twin uses (`enterAndFill`). The tuned `centerHalfWidth = 0` means at most ONE
 * candidate per event (the forecast center). The depth-floor / maxEntry / edge / runway gates all live in
 * `selectEntries`; `decideTick` re-checks the cheap ones (allowlist/maxEntry/depth) as the live authority.
 */
export function discoverCandidates(
  captures: RawCaptureRow[],
  cfg: MakerExitCfg,
  now: Date,
): DiscoveredCandidate[] {
  const latestByEvent = new Map<string, RawCaptureRow>();
  for (const r of Array.isArray(captures) ? captures : []) {
    if (r?.eventId == null) continue;
    const prev = latestByEvent.get(r.eventId);
    if (!prev || tms(r.capturedAt) > tms(prev.capturedAt)) latestByEvent.set(r.eventId, r);
  }

  const out: DiscoveredCandidate[] = [];
  for (const raw of latestByEvent.values()) {
    const cap = captureFromRaw(raw);
    const cands: EntryCandidate[] = selectEntries(cap, cfg, now, { requireFlatOpen: false });
    for (const c of cands) {
      const bucket = cap.buckets.find((b) => b.idx === c.bucketIdx);
      out.push({
        marketId: c.conditionId,
        tokenId: c.tokenYes,
        city: c.city,
        targetDate: c.targetDate,
        tz: c.tz,
        bucketIdx: c.bucketIdx,
        label: c.label,
        execAsk: c.execAsk,
        modelProb: c.modelProb,
        depthUsd: bucket ? bucket.depthUsd : 0,
        makerLimit: c.makerLimit,
        bestBid: bucket ? bucket.bestBid : null,
        bestAsk: bucket ? bucket.bestAsk : null,
        resolvesAtMs: fin(tms(cap.resolvesAt)) ? tms(cap.resolvesAt) : null,
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Position reconstruction — from the ledger rows (+ the live mark). Restart-safe: state is re-derived
// every tick from the ledger + venue, never held in memory (the daemon crash-resume contract).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A live handle on one order of a position (from its ledger row, refreshed by a venue fill-poll). */
export interface OrderHandle {
  orderId: string | null;
  clientOrderId: string;
  status: OrderLedgerRow['status'];
  purpose: OrderPurpose;
  price: number;
  size: number;
  sizeMatched: number;
  /** ISO createdAt → epoch ms (the maker-window clock); null when the DB omits it. */
  restingSinceMs: number | null;
}

/** The pure, decision-relevant state of one open market position. */
export interface LivePosition {
  marketId: string;
  tokenId: string;
  city: string;
  targetDate: string;
  tz: string;
  resolvesAtMs: number | null;
  /** the maker entry limit = the realized fill price (a maker order fills AT its resting limit). */
  entryPrice: number;
  /** the bucket's house prob (unused by the delta-TP path; kept for parity / future model-TP). */
  modelProb: number;
  /** cumulative shares held (the entry order's cumulative sizeMatched). */
  filledSize: number;
  /**
   * cumulative shares already SOLD — the sum of ALL sell-side fills (TP + stop_loss + time_stop),
   * floored by venue trade truth so fills on canceled rows (invisible to `bot_order_by_intent`) are never
   * lost (lens CRITICAL-1/LOW-5). The single source for `remaining = filledSize − soldSize`.
   */
  soldSize: number;
  /**
   * true when the venue trade read (`getTrades`) was ATTEMPTED and FAILED for this live position's token
   * (lens NEW-LOW-1) — `soldSize` may then be UNDERSTATED (invisible terminal-canceled fills), so NO sell
   * may be sized from it this tick: the taker exits + the TP rest are held and the daemon alerts
   * CRITICAL. Always false in dry-run (no venue read is applicable; the visible sum is exact).
   */
  soldTruthDegraded: boolean;
  /**
   * true when the entry order's venue fill state was FRESHLY and SUCCESSFULLY polled this tick (§11.2) — or
   * when no poll was needed (dry-run/off, no orderId, terminal status). Only false when a LIVE poll of the
   * resting entry THREW, leaving a possibly-stale `filledSize`. A live kill (§preflight fail) may cancel a
   * fully-unfilled resting entry ONLY when this is true: a stale `sizeMatched=0` could hide a poll-missed
   * partial fill that `cancel_entry` would orphan from reconstruction (entry BUYs have no `getTrades`
   * floor). Defaults true (dry-run / non-kill paths never consult it). Set by the daemon's `refreshFill`.
   */
  entryPollFresh: boolean;
  /** the CURRENT executable bid — the realizable sell mark (the daemon fetches it live). */
  mark: number | null;
  entry: OrderHandle | null;
  tp: OrderHandle | null;
  exit: OrderHandle | null;
}

const handleOf = (row: OrderLedgerRow | null): OrderHandle | null =>
  row == null
    ? null
    : {
        orderId: row.orderId,
        clientOrderId: row.clientOrderId,
        status: row.status,
        purpose: row.purpose,
        price: row.price,
        size: row.size,
        sizeMatched: row.sizeMatched,
        restingSinceMs: fin(tms(row.createdAt)) ? tms(row.createdAt) : null,
      };

/**
 * Assemble one `LivePosition` from its ledger rows + the current mark + venue sell truth. Returns null when
 * there is no entry row (the market is a fresh candidate, not yet a position). PURE — the daemon does the
 * I/O (findByIntentKey per purpose + a fill-poll + a book read + a `getTrades` sweep) and hands the facts
 * in; this is the tested "ledger → resumed state" mapping.
 *
 * `soldSize` (lens CRITICAL-1 + LOW-5) = max(Σ visible sell-row fills, venueSoldSize): the visible sum
 * covers dry-run (no venue, rows never fill) and live rows still open; the venue floor covers fills whose
 * rows have gone terminal-canceled (a lifted-then-cancelled TP, an adjudicated FAK corpse) — invisible to
 * `bot_order_by_intent` (0082). BOTH exit rows contribute when both exist (LOW-5: no fill is dropped, none
 * is double-counted — each row's `sizeMatched` is its own order's fills). `stop_loss` takes precedence over
 * `time_stop` for the single observability `exit` handle.
 */
export function assemblePosition(args: {
  meta: {
    marketId: string;
    tokenId: string;
    city: string;
    targetDate: string;
    tz: string;
    modelProb: number;
    resolvesAtMs: number | null;
  };
  entry: OrderLedgerRow | null;
  tp: OrderLedgerRow | null;
  stopLoss: OrderLedgerRow | null;
  timeStop: OrderLedgerRow | null;
  mark: number | null;
  /** Σ our SELL trade sizes for this token from venue `getTrades` (live); null = unavailable/dry-run. */
  venueSoldSize?: number | null;
  /** the venue trade read was attempted and FAILED (live) — sells are held this tick (NEW-LOW-1). */
  soldTruthDegraded?: boolean;
  /** the entry's fill state was freshly + successfully polled this tick (§11.2). Defaults true. */
  entryPollFresh?: boolean;
}): LivePosition | null {
  const { meta, entry, tp, stopLoss, timeStop, mark } = args;
  if (entry == null) return null;
  const exitRow = stopLoss ?? timeStop ?? null;
  const visibleSold = (tp?.sizeMatched ?? 0) + (stopLoss?.sizeMatched ?? 0) + (timeStop?.sizeMatched ?? 0);
  const venueSold = args.venueSoldSize;
  const soldSize = Math.max(visibleSold, fin(venueSold) ? venueSold : 0);
  return {
    marketId: meta.marketId,
    tokenId: meta.tokenId,
    city: meta.city,
    targetDate: meta.targetDate,
    tz: meta.tz,
    resolvesAtMs: meta.resolvesAtMs,
    entryPrice: entry.price,
    modelProb: meta.modelProb,
    filledSize: entry.sizeMatched,
    soldSize,
    soldTruthDegraded: args.soldTruthDegraded === true,
    entryPollFresh: args.entryPollFresh !== false, // default true; only an explicit false (a failed poll) gates
    mark: mark ?? null,
    entry: handleOf(entry),
    tp: handleOf(tp),
    exit: handleOf(exitRow),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Intents + the plan
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type Intent =
  | { kind: 'enter'; marketRef: string; req: MakerOrderRequest }
  | { kind: 'rest_tp'; marketRef: string; req: MakerOrderRequest }
  | { kind: 'reprice_entry'; marketRef: string; oldOrderId: string; oldClientOrderId: string; req: MakerOrderRequest }
  | {
      /** cancel a FULLY-UNFILLED resting maker ENTRY — the live-kill "stop new exposure" action (lens
       *  MEDIUM-2): emitted instead of reprice/hold when the LIVE preflight fails. Never emitted for a
       *  partially-filled entry (NEW-LOW-2 — record_canceled would orphan the held shares from
       *  reconstruction; see planForPosition). */
      kind: 'cancel_entry';
      marketRef: string;
      orderId: string;
      clientOrderId: string;
      reason: string;
    }
  | {
      kind: 'exit_taker';
      marketRef: string;
      purpose: 'stop_loss' | 'time_stop';
      req: TakerOrderRequest;
      /** cancel the resting maker TP first (you cannot rest a SELL and taker-SELL the same shares). */
      cancelTp?: { orderId: string; clientOrderId: string };
    };

/** A candidate/position the tick deliberately did NOT act on, with the verbatim reason (logged + tested). */
export interface Skip {
  ref: string;
  reason: string;
}

export interface TickPlan {
  intents: Intent[];
  skips: Skip[];
}

export interface TickState {
  mode: TradeMode;
  config: TradeConfig;
  /** the live interlock verdict — REQUIRED in live mode, null otherwise (dry-run/off never post live). */
  preflight: TradePreflight | null;
  cfg: DecideCfg;
  now: Date;
  candidates: DiscoveredCandidate[];
  positions: LivePosition[];
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Exit math — the ternary stop + the resolvesAt−Nh (else local-noon) time-stop, mirroring
// core/sim/opening-maker-exit-replay.ts (`stopOf` / `runMakerExitLeg`'s time-stop).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** the F13/F1 ternary stop: the operator-locked −slDeltaPp wherever entry>slDeltaPp, else the relative floor. */
export function stopOf(entryPrice: number, cfg: DecideCfg): number {
  return entryPrice - cfg.slDeltaPp > 0 ? entryPrice - cfg.slDeltaPp : entryPrice * (1 - cfg.slFrac);
}

/** the hard time-stop epoch: resolvesAt − tstopHoursBeforeResolve; the local-noon clock when resolvesAt is unknown. */
export function timeStopMsOf(p: LivePosition, cfg: DecideCfg): number | null {
  if (fin(p.resolvesAtMs)) return p.resolvesAtMs - Math.max(0, cfg.tstopHoursBeforeResolve) * 3_600_000;
  try {
    return localHourInstant(p.tz, p.targetDate, cfg.timeStopLocalHour).getTime();
  } catch {
    return null; // no clock → no time-stop this position (SL-only; a bad-tz position never enters upstream)
  }
}

/** the entry reservation ceiling — the live re-peg target for a resting maker entry (matches selectEntries). */
function repriceTarget(modelProb: number, cfg: DecideCfg): number {
  return Math.min(cfg.maxEntryPrice, modelProb - cfg.entryEdgeMargin);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// decideTick — the pure spine: (mode, config, preflight, candidates, positions, now) → intents.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Is this entry handle a live, cancellable resting order at the venue? */
function restingEntry(e: OrderHandle | null): e is OrderHandle & { orderId: string } {
  return e != null && e.orderId != null && (e.status === 'placed' || e.status === 'partial');
}

const cancelEntryIntent = (p: LivePosition, e: OrderHandle & { orderId: string }, reason: string): Intent => ({
  kind: 'cancel_entry',
  marketRef: p.marketId,
  orderId: e.orderId,
  clientOrderId: e.clientOrderId,
  reason,
});

/**
 * §11.2 — true when a live kill WANTS to cancel a fully-unfilled resting entry but THIS tick's fill poll of
 * that entry did NOT freshly succeed (`entryPollFresh === false`). Cancelling on a stale `sizeMatched=0`
 * could `record_canceled` an entry that actually partial-filled (the poll just missed it) → the missed fill
 * is orphaned from reconstruction (entry BUYs have no `getTrades` floor — only SELLs do). So the cancel is
 * DEFERRED (planForPosition holds it, decideTick surfaces a skip, the daemon fires a WARN); it retries next
 * tick once a healthy poll confirms 0 matched. A KNOWN partial (`filledSize>0`) is a different case — its
 * remainder is deliberately left working (NEW-LOW-2), never cancelled — so this predicate excludes it.
 */
function entryCancelDeferredByStalePoll(p: LivePosition, entriesBlocked: boolean): boolean {
  return entriesBlocked && !(p.filledSize > 0) && restingEntry(p.entry) && !p.entryPollFresh;
}

/**
 * Manage one open position: exits (never gated) take priority over resting the TP, over the entry window.
 * `entriesBlocked` (live preflight failed): reprice is suppressed and a FULLY-UNFILLED resting maker
 * ENTRY is CANCELLED (MEDIUM-2: a kill stops new exposure within one tick); exits + the TP rest keep
 * working (they only flatten). A PARTIALLY-filled entry's resting remainder is deliberately NOT cancelled
 * (NEW-LOW-2): `executor.cancel` would `record_canceled` the entry row → terminal → invisible to
 * `bot_order_by_intent` → the next tick could not reconstruct the position, orphaning the HELD shares
 * from their stop-loss/time-stop backstop. Its exposure is already committed capital in the preflight
 * accounting; reconstructability of the held shares wins. (The evaluated alternative — a venue-only
 * cancel that skips the ledger write to keep the row visible — was rejected: it re-cancels at the venue
 * every kill tick, leaves a permanent ledger/venue divergence on an "open" row that is venue-dead, and
 * inflates the open-exposure read.)
 */
function planForPosition(p: LivePosition, cfg: DecideCfg, nowMs: number, entriesBlocked: boolean): Intent[] {
  const held = p.filledSize;
  const out: Intent[] = [];

  // (A) NOTHING filled yet — the entry maker order is still working (held == 0 ⇒ fully unfilled).
  if (!(held > 0)) {
    const e = p.entry;
    if (!restingEntry(e)) return out; // dangling ('intent', no orderId) → reconcile owns it; terminal → done
    if (entriesBlocked) {
      // §11.2 — only cancel when the entry's 0-matched state is FRESHLY confirmed this tick; a stale poll
      // could be hiding a partial fill that record_canceled would orphan → DEFER (retry next tick, WARN).
      if (!p.entryPollFresh) return out;
      return [cancelEntryIntent(p, e, 'preflight_blocked — kill cancels fully-unfilled resting entries')];
    }
    if (e.restingSinceMs == null) return out; // no clock → cannot age the window; hold
    const restMin = (nowMs - e.restingSinceMs) / 60_000;
    if (restMin < cfg.makerFillWindowMin) return out; // within the window → keep resting
    return [
      {
        kind: 'reprice_entry',
        marketRef: p.marketId,
        oldOrderId: e.orderId,
        oldClientOrderId: e.clientOrderId,
        req: {
          marketId: p.marketId,
          tokenId: p.tokenId,
          side: 'BUY',
          purpose: 'entry',
          tradeDate: p.targetDate,
          targetPrice: repriceTarget(p.modelProb, cfg),
          size: e.size, // the ORIGINAL intent size — executor.reprice reposts the remainder
          negRisk: cfg.negRisk,
          orderType: 'GTC',
        },
      },
    ];
  }

  // (B) HOLDING `held` shares — manage the exit. `remaining` subtracts EVERY sell-side fill (TP + SL +
  // time-stop, venue-floored — soldSize; lens CRITICAL-1/LOW-5): a fully-filled TP closes the position, a
  // partial TP shrinks what any later stop may sell. A FAK exit re-fires only its unsold remainder.
  const remaining = held - p.soldSize;
  if (!(remaining > 1e-9)) return out; // fully flattened — nothing may sell

  // NEW-LOW-1 — DEGRADED-MODE SELL HOLD: the venue sell-truth read failed, so `remaining` may be
  // OVERSTATED (invisible terminal-canceled fills). No sell may be sized from it: hold the taker exits
  // AND the TP rest this tick (an already-resting TP stays — it was sized when truth was known).
  // decideTick surfaces the skip; the daemon fires a CRITICAL sellHoldAlerts alert every affected tick.
  if (p.soldTruthDegraded) return out;

  const timeStopMs = timeStopMsOf(p, cfg);
  const slStop = stopOf(p.entryPrice, cfg);
  const mark = p.mark;

  // priority 1 — the HARD time-stop (clock-only, the dominant backstop): flatten as a taker.
  if (timeStopMs != null && nowMs >= timeStopMs) {
    out.push(exitTaker(p, cfg, 'time_stop', pickWorst(mark, slStop), remaining));
    return out;
  }
  // priority 2 — the stop-loss on the realizable bid mark: cut the loss (cannot rest above a falling book, §12).
  if (fin(mark) && mark <= slStop) {
    out.push(exitTaker(p, cfg, 'stop_loss', mark, remaining));
    return out;
  }
  // priority 3 — rest the MAKER take-profit once (idempotent via the ledger; skip if already resting/terminal).
  if (p.tp == null) {
    out.push({
      kind: 'rest_tp',
      marketRef: p.marketId,
      req: {
        marketId: p.marketId,
        tokenId: p.tokenId,
        side: 'SELL',
        purpose: 'take_profit',
        tradeDate: p.targetDate,
        targetPrice: p.entryPrice + cfg.tpDeltaPp,
        size: remaining,
        negRisk: cfg.negRisk,
        orderType: 'GTC',
      },
    });
    return out;
  }
  return out; // TP resting, no stop, before the time-stop → hold (the venue fills the maker TP)
}

/** the worst price a flatten will accept — the current bid mark, else the stop, else a 1¢ floor (never NaN). */
function pickWorst(mark: number | null, slStop: number): number {
  if (fin(mark)) return mark;
  if (fin(slStop) && slStop > 0) return slStop;
  return 0.01;
}

function exitTaker(
  p: LivePosition,
  cfg: DecideCfg,
  purpose: 'stop_loss' | 'time_stop',
  worstPrice: number,
  size: number,
): Intent {
  const cancelTp =
    p.tp && p.tp.orderId != null && (p.tp.status === 'placed' || p.tp.status === 'partial')
      ? { orderId: p.tp.orderId, clientOrderId: p.tp.clientOrderId }
      : undefined;
  return {
    kind: 'exit_taker',
    marketRef: p.marketId,
    purpose,
    req: {
      marketId: p.marketId,
      tokenId: p.tokenId,
      side: 'SELL',
      purpose,
      tradeDate: p.targetDate,
      worstPrice,
      size,
      negRisk: cfg.negRisk,
    },
    ...(cancelTp ? { cancelTp } : {}),
  };
}

export function decideTick(state: TickState): TickPlan {
  const { mode, config, preflight, cfg, now, candidates, positions } = state;
  const intents: Intent[] = [];
  const skips: Skip[] = [];

  if (mode === 'off') return { intents, skips: [{ ref: 'ALL', reason: 'mode_off — the rail is inert' }] };

  const nowMs = now.getTime();
  const liveGated = mode === 'live';
  const entriesBlocked = liveGated && (preflight == null || !preflight.ok);

  // 1 · MANAGE existing positions first (exits are NEVER cap/preflight-gated — a position must always be
  //     able to flatten; the daily-loss kill + a de-activated console gate only NEW entries). Under a live
  //     kill (entriesBlocked), reprice is suppressed and FULLY-UNFILLED resting entries are CANCELLED
  //     (MEDIUM-2/NEW-LOW-2). A degraded sell-truth position holds its sells this tick (NEW-LOW-1).
  const positioned = new Set(positions.map((p) => `${p.marketId}|${p.targetDate}`));
  for (const p of positions) {
    if (p.soldTruthDegraded && p.filledSize - p.soldSize > 1e-9) {
      skips.push({
        ref: p.marketId,
        reason:
          'sell_hold_degraded — venue sell-truth (getTrades) unavailable; soldSize may be understated, so taker exits + the TP rest are HELD this tick (over-sell guard; the daemon alerts CRITICAL)',
      });
    }
    if (entryCancelDeferredByStalePoll(p, entriesBlocked)) {
      skips.push({
        ref: p.marketId,
        reason:
          'cancel_entry_deferred_stale_poll — live kill wants to cancel this fully-unfilled resting entry, but its fill state was not freshly polled this tick (getOrder failed); a stale sizeMatched=0 could hide a partial fill, so the cancel is DEFERRED to next tick (the daemon fires a WARN)',
      });
    }
    intents.push(...planForPosition(p, cfg, nowMs, entriesBlocked));
  }

  // 2 · ENTER new positions. LIVE mode enforces the preflight interlock + the caps; dry-run skips them
  //     (its ledger rows never count toward live caps) but keeps every strategy gate.
  if (entriesBlocked) {
    const why = preflight?.reasons?.length ? preflight.reasons.join('; ') : 'preflight verdict unavailable';
    for (const c of candidates) skips.push({ ref: c.marketId, reason: `preflight_blocked: ${why}` });
    return { intents, skips };
  }

  // per-tick running exposure — seed from the live preflight snapshot, then add each accepted entry's stake
  // so two same-tick entries into the same market (or the whole book) cannot both slip under a cap.
  let openExposure = liveGated ? preflight?.checks.openExposureUsd ?? 0 : 0;
  const perMarketExposure: Record<string, number> = liveGated ? { ...(preflight?.checks.perMarketExposureUsd ?? {}) } : {};
  const perPositionCap = Math.min(config.perPositionCapUsd, STAKE_CEILING_USD);

  for (const c of candidates) {
    const key = `${c.marketId}|${c.targetDate}`;
    if (positioned.has(key)) {
      skips.push({ ref: c.marketId, reason: 'already_positioned' });
      continue;
    }
    if (!cfg.cities.includes(c.city)) {
      skips.push({ ref: c.marketId, reason: `off_allowlist (${c.city})` });
      continue;
    }
    if (!(c.execAsk > 0 && c.execAsk <= cfg.maxEntryPrice)) {
      skips.push({ ref: c.marketId, reason: `above_max_entry (execAsk ${c.execAsk} > ${cfg.maxEntryPrice})` });
      continue;
    }
    if (!(c.depthUsd >= cfg.depthFloorUsd)) {
      skips.push({ ref: c.marketId, reason: `below_depth_floor (${c.depthUsd} < ${cfg.depthFloorUsd})` });
      continue;
    }

    const stake = config.stakePerBuyUsd;
    const shares = c.execAsk > 0 ? stake / c.execAsk : 0;
    if (!(shares >= cfg.minOrderSizeShares)) {
      skips.push({ ref: c.marketId, reason: `below_min_size (${shares.toFixed(2)} sh < ${cfg.minOrderSizeShares})` });
      continue;
    }

    if (liveGated) {
      if (!(stake <= perPositionCap)) {
        skips.push({ ref: c.marketId, reason: `stake $${stake} > per-position cap $${perPositionCap}` });
        continue;
      }
      const mkt = perMarketExposure[c.marketId] ?? 0;
      if (!(mkt + stake <= config.perMarketCapUsd)) {
        skips.push({ ref: c.marketId, reason: `per-market cap ($${mkt}+$${stake} > $${config.perMarketCapUsd})` });
        continue;
      }
      if (!(openExposure + stake <= config.totalConcurrentCapUsd)) {
        skips.push({ ref: c.marketId, reason: `total-concurrent cap ($${openExposure}+$${stake} > $${config.totalConcurrentCapUsd})` });
        continue;
      }
      perMarketExposure[c.marketId] = mkt + stake;
      openExposure += stake;
    }

    intents.push({
      kind: 'enter',
      marketRef: c.marketId,
      req: {
        marketId: c.marketId,
        tokenId: c.tokenId,
        side: 'BUY',
        purpose: 'entry',
        tradeDate: c.targetDate,
        targetPrice: c.makerLimit,
        size: shares,
        negRisk: cfg.negRisk,
        orderType: 'GTC',
      },
    });
  }

  return { intents, skips };
}

/**
 * NEW-LOW-1 — the CRITICAL escalation for the degraded-mode sell hold. PURE: maps every position whose
 * sells are held this tick (venue sell-truth unavailable + an unsold remainder that WOULD otherwise be
 * sellable) to a CRITICAL alert. The daemon fires these through `notify` EVERY affected tick — the raw
 * local channel does not dedupe, so a persisting outage keeps paging until the read recovers (never
 * silent: exits are paused, the operator must know).
 */
export function sellHoldAlerts(positions: LivePosition[]): TradeAlert[] {
  const out: TradeAlert[] = [];
  for (const p of positions) {
    if (!p.soldTruthDegraded) continue;
    if (!(p.filledSize - p.soldSize > 1e-9)) continue; // fully covered by visible fills — nothing is held back
    out.push({
      kind: 'TRADE_BOT_SELL_HOLD',
      severity: 'CRITICAL',
      title: `trade-bot: SELLS HELD on ${p.city} ${p.targetDate} (${p.marketId}) — venue sell-truth unavailable`,
      body:
        `getTrades for token ${p.tokenId} is failing, so soldSize may be understated (fills on ` +
        `terminal-canceled rows are invisible to the ledger read). All taker exits + TP rests for this ` +
        `position are PAUSED until the venue trade read recovers — the over-sell guarantee outranks exit ` +
        `latency (the position is §9R-capped). Investigate CLOB /trades connectivity now; sells resume ` +
        `automatically, correctly sized, on the first healthy tick.`,
      dedupeKey: `trade-bot-sellhold:${p.marketId}`,
    });
  }
  return out;
}

/**
 * §11.2 — the WARN escalation for a DEFERRED kill-cancel. PURE: maps every position where a live kill wants
 * to cancel a fully-unfilled resting entry but the entry's fill state was NOT freshly polled this tick
 * (`entryPollFresh === false`) to a WARN alert. The daemon fires these through `notify` (a structured WARN
 * log + a raw Slack post) so the operator sees that a kill-cancel is waiting on a healthy `getOrder`. WARN,
 * NOT CRITICAL: the entry is §9R-capped and retries next tick, and the deferral is the SAFE choice (a stale
 * poll cannot hide an over-sell — it only risks orphaning a poll-missed partial, which the deferral avoids).
 */
export function entryCancelDeferredAlerts(positions: LivePosition[], entriesBlocked: boolean): TradeAlert[] {
  const out: TradeAlert[] = [];
  for (const p of positions) {
    if (!entryCancelDeferredByStalePoll(p, entriesBlocked)) continue;
    out.push({
      kind: 'TRADE_BOT_ENTRY_CANCEL_DEFERRED',
      severity: 'WARN',
      title: `trade-bot: kill-cancel DEFERRED on ${p.city} ${p.targetDate} (${p.marketId}) — entry poll stale this tick`,
      body:
        `A live kill wants to cancel this fully-unfilled resting entry, but getOrder failed this tick so ` +
        `its fill state (sizeMatched=0) is STALE — cancelling now could record_canceled an entry that ` +
        `actually partial-filled and orphan the fill from reconstruction (entry BUYs have no getTrades ` +
        `floor). The cancel is DEFERRED to the next tick once a healthy poll confirms 0 matched. No NEW ` +
        `entries are placed meanwhile (blocked by the kill), but this already-resting entry stays working ` +
        `and CAN still be lifted while the poll outage lasts — bounded by the §9R stake cap.`,
      dedupeKey: `trade-bot-cancel-deferred:${p.marketId}`,
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// applyPlan — the thin driver: execute each intent against the T1 MakerExecutor. Never suppresses a
// failure (the ledgerWriteOrAlert discipline: a record_* raise on the live path is a needs-reconcile
// event, already alerted inside the executor); a throw is caught, re-alerted at the daemon level, and the
// loop CONTINUES so one bad intent never strands the other positions.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The slice of the T1 MakerExecutor the driver touches (the real executor satisfies it structurally). */
export interface DaemonExecutor {
  readonly mode: TradeMode;
  place(req: MakerOrderRequest): Promise<OrderPlacementResult>;
  placeTaker(req: TakerOrderRequest): Promise<OrderPlacementResult>;
  reprice(
    oldOrderId: string,
    oldClientOrderId: string,
    newReq: MakerOrderRequest,
  ): Promise<{ cancel: CancelResult; placed: OrderPlacementResult }>;
  cancel(orderId: string, clientOrderId?: string): Promise<CancelResult>;
}

export interface AppliedIntent {
  intent: Intent;
  result: OrderPlacementResult | null;
  error: string | null;
}

export interface ApplyResult {
  applied: AppliedIntent[];
  posted: number;
  dryRun: number;
  duplicate: number;
  failed: number;
  /** cancel_entry intents executed (the live-kill new-exposure stop, MEDIUM-2). */
  canceled: number;
  /** taker exits ABORTED this tick because the TP cancel raced a fill (the over-sell race guard). */
  aborted: number;
}

export async function applyPlan(
  plan: TickPlan,
  executor: DaemonExecutor,
  notify: (a: TradeAlert) => Promise<boolean>,
  log: (entry: Record<string, unknown>) => void,
  /** the order ledger — enables the venue-dead FAK adjudication (MEDIUM-3). Optional for pure-driver tests. */
  ledger?: OrderLedger,
): Promise<ApplyResult> {
  const applied: AppliedIntent[] = [];
  let posted = 0;
  let dryRun = 0;
  let duplicate = 0;
  let failed = 0;
  let canceled = 0;
  let aborted = 0;

  for (const intent of plan.intents) {
    try {
      let result: OrderPlacementResult;
      switch (intent.kind) {
        case 'enter':
        case 'rest_tp':
          result = await executor.place(intent.req);
          break;
        case 'reprice_entry': {
          const rr = await executor.reprice(intent.oldOrderId, intent.oldClientOrderId, intent.req);
          result = rr.placed;
          break;
        }
        case 'cancel_entry': {
          // the live-kill "stop new exposure" action (MEDIUM-2): cancel the resting maker entry at the
          // venue; executor.cancel records the row canceled when the venue confirms (frees the key).
          const cr = await executor.cancel(intent.orderId, intent.clientOrderId);
          canceled++;
          applied.push({ intent, result: null, error: null });
          log({
            msg: 'trade-bot.intent',
            kind: intent.kind,
            marketRef: intent.marketRef,
            allCanceled: cr.allCanceled,
            reason: intent.reason,
          });
          continue;
        }
        case 'exit_taker': {
          // cancel the resting maker TP FIRST (never rest a SELL and taker-SELL the same shares).
          if (intent.cancelTp) {
            const cr = await executor.cancel(intent.cancelTp.orderId, intent.cancelTp.clientOrderId);
            if (!cr.allCanceled) {
              // RACE GUARD: the TP raced a fill — `remaining` is stale-high and the taker would over-sell.
              // ABORT this tick; the next tick's fill-poll picks up the raced fill and re-decides.
              aborted++;
              applied.push({ intent, result: null, error: null });
              log({ msg: 'trade-bot.exit_aborted', level: 'WARN', kind: intent.kind, marketRef: intent.marketRef, purpose: intent.purpose, reason: 'TP cancel raced a fill (allCanceled=false) — taker aborted this tick' });
              await notify({
                kind: 'TRADE_BOT_EXIT_ABORTED',
                severity: 'WARN',
                title: `trade-bot ${intent.purpose} aborted: TP cancel raced a fill (${intent.marketRef})`,
                body: 'The resting take-profit was lifted while being cancelled; the taker exit is deferred one tick so the raced fill enters the sold accounting first.',
                dedupeKey: `trade-bot-abort:${intent.marketRef}:${intent.purpose}`,
              });
              continue;
            }
          }
          // FAK ADJUDICATION (MEDIUM-3): a prior FAK for this same exit intent that partial- (or zero-)
          // filled left an OPEN 'partial'/'placed' row — a venue-dead corpse (FAK never rests) that would
          // make this re-fire a silent 'duplicate' forever. Adjudicate it terminal (record_canceled
          // preserves size_matched; the partial-unique frees the key), loudly, then place.
          if (ledger) {
            const key = orderIntentKey(intent.req);
            const open = await ledger.findByIntentKey(key, executor.mode);
            if (open && open.orderId != null && (open.status === 'partial' || open.status === 'placed')) {
              await ledger.recordCanceled(open.clientOrderId);
              log({ msg: 'trade-bot.fak_adjudicated', level: 'WARN', marketRef: intent.marketRef, purpose: intent.purpose, clientOrderId: open.clientOrderId, orderId: open.orderId, sizeMatched: open.sizeMatched, reason: 'venue-dead FAK exit row adjudicated terminal so the remainder can re-fire' });
              await notify({
                kind: 'TRADE_BOT_FAK_ADJUDICATED',
                severity: 'WARN',
                title: `trade-bot adjudicated a dead FAK ${intent.purpose} (${intent.marketRef})`,
                body: `Row ${open.clientOrderId} (order ${open.orderId}, matched ${open.sizeMatched}/${open.size}) was a venue-dead FAK still holding the intent key — recorded canceled (fills preserved) so the unsold remainder re-fires.`,
                dedupeKey: `trade-bot-fak:${open.clientOrderId}`,
              });
            }
          }
          result = await executor.placeTaker(intent.req);
          break;
        }
      }
      applied.push({ intent, result, error: null });
      if (result.status === 'placed') posted++;
      else if (result.status === 'dry_run') dryRun++;
      else if (result.status === 'duplicate') duplicate++;
      log({
        msg: 'trade-bot.intent',
        kind: intent.kind,
        marketRef: intent.marketRef,
        status: result.status,
        side: result.side,
        purpose: result.purpose,
        limitPrice: result.limitPrice,
        size: result.size,
        sizeMatched: result.sizeMatched,
        reason: result.reason,
      });
    } catch (e) {
      failed++;
      const message = redactText(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      applied.push({ intent, result: null, error: message });
      // The executor already fired a needs-reconcile / order-fail CRITICAL through this same notify on the
      // live money path (ledgerWriteOrAlert). We re-log CRITICAL + a daemon-level alert (never suppress) and
      // CONTINUE — a single failed intent must not stall the loop or strand the other positions' exits.
      log({ msg: 'trade-bot.intent_failed', level: 'CRITICAL', kind: intent.kind, marketRef: intent.marketRef, error: message });
      await notify({
        kind: 'TRADE_BOT_INTENT_FAILED',
        severity: 'CRITICAL',
        title: `trade-bot intent failed: ${intent.kind} ${intent.marketRef}`,
        body: message,
        dedupeKey: `trade-bot-intent:${intent.kind}:${intent.marketRef}`,
      });
    }
  }

  return { applied, posted, dryRun, duplicate, failed, canceled, aborted };
}
