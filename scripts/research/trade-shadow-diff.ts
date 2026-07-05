/**
 * scripts/research/trade-shadow-diff — the SHADOW-DIFF harness (LIVE-RAIL T5, BUILD-ONLY).
 *
 * WHY THIS EXISTS. The live maker-exit DAEMON (`scripts/trade-bot.ts`, side A) and the maker-exit PAPER LOOP
 * (`supabase/functions/maker-exit-panel` → `core/sim/opening-maker-exit-view.buildMakerExitView`, side B) are
 * meant to be twins running the SAME tuned strategy — the daemon executes it against the real venue while the
 * paper loop RE-REPLAYS the `opening_captures` stream through `replayMakerExitEvent`. During the shadow week
 * the daemon runs in `dry-run` (records intents to `live_orders`/`live_fills` with mode='dry-run`, never posts).
 * This harness reads the daemon's dry-run ledger (side A, via the 0082 read surfaces — the `live_orders` /
 * `live_fills` tables, service-role SELECT) and DIFFS it against what the replay would have decided over the
 * SAME capture window (side B), per market/day: entry chosen y/n, bucket, price, size, timing, exit kind/price,
 * realized P&L. Every divergence is a candidate BUG the shadow week exists to surface before any capital.
 *
 * ⚠ CANNOT RUN YET (build + fixture-test only). The dry-run ledger does not exist until (1) migration 0082 is
 * applied (operator-gated) and (2) the dry-run daemon has accrued rows. The CLI path touches the DB read-only
 * (SELECT only) when actually run; tonight it is NEVER run — the exported PURE pipeline is fixture-tested
 * (`sanity()` + `trade-shadow-diff.test.ts`), NO network. Read-only: no migrations/DDL, no writes, no venue,
 * no key read (service creds via env-var NAMES only, the repo's script idiom).
 *
 * ── SIDE-ALIGNMENT (how A and B land on the same key) ──────────────────────────────────────────────────────
 *   Both sides are keyed on the market EVENT (the negRisk temperature-market group), NOT the per-bucket
 *   conditionId — so a bucket DISAGREEMENT (A entered a different bucket than B for the same event) is VISIBLE
 *   instead of splitting into two "one-side-only" rows. The captured `buckets` jsonb is the Rosetta stone:
 *     • side B (`replayMakerExitEvent`) already carries eventId + city + targetDate + bucketIdx + label.
 *     • side A ledger rows carry only market_id (= the chosen bucket's conditionId) + trade_date; the capture
 *       index (`buildCaptureIndex`) maps that conditionId → its eventId + bucketIdx + label + city.
 *   Rows join on eventId; a ledger market_id absent from the captured window is surfaced as an A-only "unmapped"
 *   divergence (a capture-coverage gap, not hidden).
 *
 * ── EXPECTED DIVERGENCE CLASSES (documented, never hidden — a divergence in these classes is EXPECTED, so it
 *    is tagged EXPECTED(...) and does NOT inflate the bug-hunting divergence score) ──────────────────────────
 *   1. dry-run-no-fill      — dry-run NEVER touches the venue, so a dry-run entry stays size_matched=0 forever:
 *                             side A carries entry INTENTS ONLY (no TP/SL/time-stop, no realized P&L). Only the
 *                             ENTRY dimensions are truly comparable in a dry-run shadow; the exit/P&L dimensions
 *                             come from side B alone until the rail runs live.
 *   2. reprice-vs-taker-fallback — when the maker window elapses the DAEMON re-pegs the resting entry
 *                             (`executor.reprice`, a new ledger row), whereas the REPLAY takes a pessimistic
 *                             taker fallback. So side A may show N repriced entry rows for one intent; side B a
 *                             single maker/taker fill.
 *   3. live-mark-vs-captured-execBid — the daemon's SL/time-stop fires on the CURRENT executable bid at decision
 *                             time; the replay reads the captured tick's execBid. (Only bites once live.)
 *   4. degraded-hold        — the daemon HOLDS sells while venue sell-truth (getTrades) is degraded; the replay
 *                             has no such concept. (Only bites once live.)
 *   5. consensus-source     — buckets can diverge if the daemon's capture stream seeds a different house prob
 *                             than the replay cfg assumes (bot.consensusSource); tagged when the bucket differs.
 *   6. config-stake-scale   — side A sizes at trade_config.stake_per_buy_usd (seeded $10), side B at the
 *                             replay's perPositionUsd ($20): a CONSTANT B/A share ratio on EVERY market. The
 *                             harness detects it ONCE (median B/A over both-entered rows, applied at ≥3
 *                             samples), surfaces it as a summary config-mismatch line, and scores per-row size
 *                             only on the RESIDUAL — a global knob mismatch cannot crush the ranking (lens M1).
 *   7. maker-shade          — side A's ledger price is the post_only-SHADED maker limit (≈1 tick inside the
 *                             book, order-intent.ts makerLimitPrice) vs side B's modeled fill: a near-constant
 *                             offset. Detected as the median B−A price delta and normalized out of per-row
 *                             scores the same way (lens M1).
 *
 * SCORING DISCIPLINE (lens M3): per-row price/size deltas are SCORED only when side A's entry actually FILLED
 * and was never repriced — an unfilled dry-run intent's resting limit is not a fill price, and a repriced
 * entry's first-row limit is stale by construction (expected classes #1/#2). The deltas are still computed +
 * summarized; they just cannot inflate the per-row ranking. Likewise a side's "realized P&L" exists only once a
 * SELL fill exists (the 0082 N1 realized-at-sell convention) — an open filled BUY is cost, not realized P&L.
 * ENTRY TIMING (lens L2): entryAtDeltaMs compares DELIBERATELY ASYMMETRIC clocks — A's intent-reservation
 * created_at (≈ the daemon's first-enterable decision) vs B's modeled FILL tick (decision + maker-rest
 * latency). A positive delta ≈ B's modeled fill latency; a LARGE NEGATIVE one is the anomaly. Rendered (Δmin),
 * never scored — timing noise would drown the ranking.
 *
 * CITY SCOPE (lens L3): the ledger read is city-UNFILTERED while the capture window / side B honor --cities —
 * a daemon row for a city outside --cities surfaces as an A-only row: tagged EXPECTED(city-scope) + UNscored
 * when its city is derivable from the capture index, else kept as a scored "unmapped" row (it could equally be
 * a real capture-coverage gap). Widen --cities to cover the daemon allowlist for a clean read.
 *
 * Pure + total: junk → empty sections / NaN, never throws. The pure core imports only sibling core mappers +
 * the maker-exit replay engine — never packages/trading, never io, never fs (the DB read lives in the CLI tail).
 *
 * Run (ONLY after 0082 is applied AND the dry-run daemon has rows):
 *   pnpm tsx scripts/research/trade-shadow-diff.ts --days 3 [--cities a,b] [--top 30] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  buildEvents,
  mapBucket,
  type RawBucket,
  type RawCaptureRow,
  type Resolution,
} from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import {
  makerExitCfg,
  replayMakerExitEvent,
  type MakerExitCfg,
  type MakerExitTrade,
} from '../../packages/core/src/sim/opening-maker-exit-replay.ts';
import { BOT_DEFAULTS } from '../../packages/core/src/sim/opening-convergence.ts';
// type-only (erased at compile) — the pure pipeline carries NO postgres runtime dep; the CLI tail lazily
// imports the concrete makeScriptDb.
import type { ScriptDb } from '../lib/script-db.ts';

export const SCRIPT = 'trade-shadow-diff';
export const DEFAULT_DAYS = 3;
export const DEFAULT_TOP = 30;

// Re-export the shared raw→core mappers so the CI seam test imports them from here (the opening-bracket-score
// idiom): the ledger loader's row shape and the capture ingest cannot drift from the tested source.
export { buildEvents, mapBucket };
export type { RawBucket, RawCaptureRow, Resolution };

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const numOrNull = (v: unknown): number | null => (fin(v) ? Number(v) : null);
const num0 = (v: unknown): number => (fin(v) ? Number(v) : 0);
const parseMs = (iso: string | null | undefined): number | null => {
  if (iso == null) return null;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? ms : null;
};
const median = (xs: number[]): number => {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = s.length;
  return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

/** M1 — a detected global systematic delta is normalized out of per-row scores only at this many both-entered
 *  samples or more; below it a "global" is indistinguishable from a per-row divergence, so scoring stays raw. */
export const GLOBAL_NORMALIZE_MIN_SAMPLES = 3;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Types — side A (the dry-run ledger), the capture index, the normalized per-side decision, the diff
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One `live_orders` row (+ its aggregated `live_fills`) as the ledger query emits it (camelCase, ::float8
 *  numerics, ::text timestamps — the opening-bracket-score direct-query idiom). fill* are 0 in true dry-run
 *  (no fills ever record), non-zero only if this harness is ever pointed at a live/filled ledger. */
export interface DryRunLedgerRow {
  mode: string;
  intentKey: string | null;
  clientOrderId: string | null;
  orderId: string | null;
  marketId: string;
  tokenId: string;
  side: string; // BUY | SELL
  purpose: string; // entry | take_profit | stop_loss | time_stop
  orderType: string;
  price: number;
  size: number;
  sizeMatched: number;
  avgPrice: number | null;
  tradeDate: string; // YYYY-MM-DD
  status: string;
  createdAt: string | null;
  placedAt: string | null;
  /** Σ live_fills.fill_notional for the row (N2 exact marginal cash; SELL = proceeds, BUY = cost). */
  fillNotionalUsd: number;
  fillFeeUsd: number;
  fillSize: number;
}

/** One captured bucket's identity — the conditionId→event Rosetta entry. */
export interface CaptureMarketRef {
  eventId: string;
  city: string;
  targetDate: string;
  bucketIdx: number;
  label: string;
  tokenYes: string;
}

/** One event's center (argmax-houseProb) bucket at its latest capture — mirrors the daemon's buildEventMeta. */
export interface CaptureEventRef {
  eventId: string;
  city: string;
  targetDate: string;
  centerConditionId: string;
  centerBucketIdx: number;
  centerLabel: string;
}

export interface CaptureIndex {
  /** conditionId → the bucket it belongs to (latest-capture wins for label/idx). */
  market: Map<string, CaptureMarketRef>;
  /** eventId → its center bucket (the strategy's forecast-center target). */
  event: Map<string, CaptureEventRef>;
  /** eventId → venue resolution epoch ms (the maker-exit time-stop anchor); null → local-noon fallback. */
  resolvesByEvent: Map<string, number | null>;
}

/** The normalized decision one side made about one event (entry-centric; exits present only once live/filled). */
export interface SideDecision {
  entered: boolean;
  bucketIdx: number | null;
  bucketLabel: string;
  conditionId: string | null;
  /** the resting maker limit (side A) / the modeled fill price (side B). */
  entryPrice: number | null;
  entrySizeShares: number | null;
  entryAtMs: number | null;
  /** shares actually filled (side A: entry size_matched — 0 in dry-run; side B: the full modeled fill). */
  entryFilledShares: number | null;
  /** normalized exit kind: maker_take_profit | taker_stop_loss | taker_time_stop | resolution_* | mtm_* |
   *  tp_resting | null (no exit — the dry-run steady state on side A). */
  exitKind: string | null;
  exitPrice: number | null;
  exitAtMs: number | null;
  realizedPnlUsd: number | null;
  // ── side-A extras ──
  nEntryRows?: number;
  nReprices?: number;
  bucketsEntered?: number[];
  multiBucket?: boolean;
  unmapped?: boolean;
  // ── side-B extras ──
  notEnteredReason?: string;
}

/** One aligned market/day: the two sides' decisions + per-dimension agreement + the ranked divergence score. */
export interface ShadowDiffRow {
  key: string;
  eventId: string | null;
  city: string;
  targetDate: string;
  a: SideDecision; // the dry-run ledger
  b: SideDecision; // the replay
  enteredAgree: boolean;
  bucketAgree: boolean | null; // null unless BOTH entered
  entryPriceDelta: number | null; // b − a (price units)
  entrySizeDelta: number | null; // b − a (shares)
  /** b − a entry timing (ms) — SEMANTICS DELIBERATELY ASYMMETRIC (lens L2, documented not matched): A stamps
   *  the daemon's intent RESERVATION (created_at ≈ its first-enterable decision tick + one tick-loop latency),
   *  B stamps the replay's modeled FILL tick (its decision tick + the maker-rest latency). A positive delta ≈
   *  B's modeled fill latency (+ capture-vs-daemon clock skew); a LARGE NEGATIVE delta (B filled long before A
   *  even reserved) is the anomaly worth investigating. Rendered as Δmin in the table; NEVER scored. */
  entryAtDeltaMs: number | null; // b − a
  exitKindAgree: boolean | null; // null unless BOTH have an exit kind
  realizedPnlDelta: number | null; // b − a (only meaningful once both realize)
  /** L3 — A entered a market whose city is derivably OUTSIDE the harness --cities scope (an expected scope
   *  artifact, tagged + unscored — widen --cities); absent/false for in-scope and unmapped rows. */
  outOfScopeA?: boolean;
  divergenceScore: number;
  notes: string[];
}

export interface ShadowDiffSummary {
  nEvents: number;
  nBothEntered: number;
  nAOnly: number;
  nBOnly: number;
  nBothSkipped: number;
  nUnmappedA: number;
  entryAgreementRate: number; // (bothEntered + bothSkipped) / nEvents
  bucketAgreementRate: number; // over both-entered
  meanEntryPriceDeltaCents: number; // signed b − a
  meanAbsEntryPriceDeltaCents: number;
  meanEntrySizeDelta: number; // signed b − a shares
  nARepricesTotal: number; // expected class #2
  nAEntriesUnfilled: number; // expected class #1
  /** M1 — the detected GLOBAL size scale: median B/A entry shares over both-entered rows (NaN with no samples).
   *  A ratio ≠ 1 means the two sides' stake knobs differ (trade_config.stake_per_buy_usd vs the replay's
   *  perPositionUsd) — an EXPECTED config-level divergence surfaced ONCE here; per-row size scores use the
   *  residual after dividing this out (applied at ≥ GLOBAL_NORMALIZE_MIN_SAMPLES samples). */
  globalSizeRatioBOverA: number;
  /** M1 — the detected systematic entry-price offset: median B−A in CENTS over both-entered rows (NaN with no
   *  samples). The maker post_only shade shows up here as a ≈1-tick constant; per-row price scores use the
   *  residual after subtracting it (same ≥3-sample floor). */
  medianEntryPriceDeltaCents: number;
  /** whether the two global normalizations above were actually applied to scoring (≥3 both-entered samples). */
  globalNormalizationApplied: boolean;
  /** L3 — A-only rows whose city is derivably OUTSIDE the harness cities (expected scope artifacts, unscored). */
  nOutOfScopeA: number;
  exitKindDistB: Record<string, number>;
  totalRealizedPnlA: number;
  totalRealizedPnlB: number;
  windowDays: number;
  cities: string[];
  ledgerRowsRead: number;
  /** false when NO dry-run rows were read (0082 not applied / daemon not run yet) — the report is a template. */
  runnable: boolean;
}

export interface ShadowDiffReport {
  summary: ShadowDiffSummary;
  rows: ShadowDiffRow[]; // sorted DESC by divergenceScore
  expectedDivergenceClasses: string[];
  generatedAt: string;
}

/** The documented expected-divergence classes (surfaced in the report so a reader never mistakes them for bugs). */
export const EXPECTED_DIVERGENCE_CLASSES: string[] = [
  'dry-run-no-fill: dry-run entries never fill → side A carries entry intents only (no exits / no realized P&L); its price/size deltas are reported, not scored',
  'reprice-vs-taker-fallback: the daemon re-pegs the maker entry; the replay takes a taker fallback — repriced rows report price/size deltas but never score them',
  'live-mark-vs-captured-execBid: daemon SL/time-stop reads the live bid; the replay reads the captured execBid',
  'degraded-hold: the daemon holds sells while venue sell-truth is degraded; the replay has no such concept',
  'consensus-source: a bucket can diverge if the capture seed differs from the replay cfg (bot.consensusSource)',
  'config-stake-scale: A sizes at trade_config.stake_per_buy_usd, B at the replay perPositionUsd — detected ONCE as the global median B/A share ratio and normalized out of per-row scores',
  'maker-shade: A ledger price is the post_only-SHADED maker limit (≈1 tick inside the book) — detected as the median B−A price offset and normalized out of per-row scores',
  'city-scope: the ledger read is city-unfiltered; a daemon row for a city outside --cities is out-of-scope (widen --cities), not a capture bug',
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// buildCaptureIndex — the conditionId→event Rosetta + the resolution anchor (pure, from the raw captures)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Build the capture index from the RAW `opening_captures` rows (pure + total). For every bucket of every tick
 * it records conditionId → its bucket identity (latest capturedAt wins, so label/idx reflect the freshest book),
 * and per event the argmax-houseProb bucket at the latest tick (the forecast center — the daemon's buildEventMeta
 * choice) + the venue resolution epoch (first finite resolvesAt per event; constant per event = the Gamma endDate).
 */
export function buildCaptureIndex(rows: RawCaptureRow[]): CaptureIndex {
  const market = new Map<string, CaptureMarketRef>();
  const event = new Map<string, CaptureEventRef>();
  const resolvesByEvent = new Map<string, number | null>();
  // track the latest capturedAt seen per (conditionId) and per (eventId) so latest wins deterministically.
  const marketAtMs = new Map<string, number>();
  const eventAtMs = new Map<string, number>();

  for (const r of Array.isArray(rows) ? rows : []) {
    const eventId = r?.eventId;
    if (eventId == null) continue;
    const city = String(r.city ?? '');
    const targetDate = String(r.targetDate ?? '');
    const atMs = parseMs(r.capturedAt) ?? 0;
    const buckets: RawBucket[] = Array.isArray(r.buckets) ? r.buckets : [];

    // resolution anchor — first finite resolvesAt per event wins.
    if (!resolvesByEvent.has(eventId)) {
      const ms = parseMs(r.resolvesAt);
      resolvesByEvent.set(eventId, ms);
    }

    // per-bucket conditionId → identity (latest capture wins).
    let center: { prob: number; idx: number; label: string; conditionId: string } | null = null;
    for (const b of buckets) {
      const conditionId = String(b?.conditionId ?? '');
      const idx = num0(b?.idx);
      const label = String(b?.label ?? '');
      const tokenYes = String(b?.tokenYes ?? '');
      if (conditionId) {
        const prevAt = marketAtMs.get(conditionId);
        if (prevAt == null || atMs >= prevAt) {
          market.set(conditionId, { eventId, city, targetDate, bucketIdx: idx, label, tokenYes });
          marketAtMs.set(conditionId, atMs);
        }
      }
      const prob = numOrNull(b?.houseProb);
      if (fin(prob) && conditionId && (center == null || prob > center.prob)) {
        center = { prob, idx, label, conditionId };
      }
    }

    // per-event center (argmax houseProb at the latest tick).
    if (center) {
      const prevAt = eventAtMs.get(eventId);
      if (prevAt == null || atMs >= prevAt) {
        event.set(eventId, {
          eventId,
          city,
          targetDate,
          centerConditionId: center.conditionId,
          centerBucketIdx: center.idx,
          centerLabel: center.label,
        });
        eventAtMs.set(eventId, atMs);
      }
    }
  }
  return { market, event, resolvesByEvent };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Side A — normalize the dry-run ledger rows into per-market decisions
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One (marketId, tradeDate) group of ledger rows collapsed to a decision (entry-centric + any exit rows). */
export interface MarketDecision extends SideDecision {
  marketId: string;
  tradeDate: string;
  eventId: string | null;
  city: string;
}

/** normalize the exit rows of one market group → an exit kind + price/time (mirrors the replay's exit labels).
 *  In true dry-run there are NO exit rows (the entry never fills), so this returns { kind:null } — the
 *  dry-run-no-fill expected class; it is written fully so a later LIVE ledger is handled correctly. */
function exitOf(rows: DryRunLedgerRow[]): { kind: string | null; price: number | null; atMs: number | null } {
  const filledOf = (purpose: string): DryRunLedgerRow | null => {
    const r = rows.filter((x) => x.purpose === purpose && x.sizeMatched > 1e-9);
    if (r.length === 0) return null;
    // prefer the latest by created_at
    return r.sort((a, b) => (parseMs(b.createdAt) ?? 0) - (parseMs(a.createdAt) ?? 0))[0]!;
  };
  const sl = filledOf('stop_loss');
  if (sl) return { kind: 'taker_stop_loss', price: sl.avgPrice ?? sl.price, atMs: parseMs(sl.placedAt ?? sl.createdAt) };
  const ts = filledOf('time_stop');
  if (ts) return { kind: 'taker_time_stop', price: ts.avgPrice ?? ts.price, atMs: parseMs(ts.placedAt ?? ts.createdAt) };
  const tp = filledOf('take_profit');
  if (tp) return { kind: 'maker_take_profit', price: tp.avgPrice ?? tp.price, atMs: parseMs(tp.placedAt ?? tp.createdAt) };
  // an unfilled resting TP is a partial exit signal (armed, not fired).
  const tpResting = rows.some((x) => x.purpose === 'take_profit' && (x.status === 'placed' || x.status === 'partial'));
  return { kind: tpResting ? 'tp_resting' : null, price: null, atMs: null };
}

/** collapse one (marketId, tradeDate) group of ledger rows → a MarketDecision. */
function marketDecisionOf(marketId: string, tradeDate: string, rows: DryRunLedgerRow[], index: CaptureIndex): MarketDecision {
  const ref = index.market.get(marketId) ?? null;
  const entryRows = rows
    .filter((r) => r.purpose === 'entry')
    .sort((a, b) => (parseMs(a.createdAt) ?? 0) - (parseMs(b.createdAt) ?? 0));
  const entered = entryRows.length > 0;
  const first = entryRows[0] ?? null;
  const entryFilled = entryRows.reduce((m, r) => Math.max(m, r.sizeMatched), 0);
  // realized P&L over the group's fills: Σ SELL proceeds − Σ BUY cost − Σ fees (N2 exact notionals). REALIZED
  // only once a SELL fill exists (the 0082 N1 realized-at-sell convention, lens M3): an open filled BUY is
  // deployed cost, not P&L — reporting it as a negative "realized" number would fabricate a P&L divergence
  // against side B on every open position.
  // CAVEAT (lens R2 L-N1, live-only): this is whole-position cashflow, which equals N1 only at FULL close. A
  // PARTIALLY-sold position transiently subtracts the full buy cost against partial proceeds (N1's true basis is
  // per-sold-share average cost) → overstates side A's realized loss until the last share sells; self-heals at
  // full close, and dry-run (the shadow week) never fills, so it cannot bias the shadow read.
  const sellUsd = rows.filter((r) => r.side === 'SELL').reduce((a, r) => a + r.fillNotionalUsd, 0);
  const buyUsd = rows.filter((r) => r.side === 'BUY').reduce((a, r) => a + r.fillNotionalUsd, 0);
  const feeUsd = rows.reduce((a, r) => a + r.fillFeeUsd, 0);
  const hasSellFill = rows.some((r) => r.side === 'SELL' && r.sizeMatched > 1e-9);
  // L1 — a REPRICE leaves its PREDECESSOR entry row terminal-'canceled' (executor.reprice = cancel-then-repost),
  // so reprices = canceled rows among all-but-the-last entry row. A failed-then-retried predecessor ('failed')
  // is a RETRY, not a reprice; a trailing canceled row with no successor is a kill-cancel, also not a reprice.
  const nReprices = entryRows.slice(0, -1).filter((r) => r.status === 'canceled').length;
  const ex = exitOf(rows);

  return {
    marketId,
    tradeDate,
    eventId: ref?.eventId ?? null,
    city: ref?.city ?? '',
    entered,
    bucketIdx: ref?.bucketIdx ?? null,
    bucketLabel: ref?.label ?? '',
    conditionId: marketId,
    entryPrice: first ? first.price : null,
    entrySizeShares: first ? first.size : null,
    entryAtMs: first ? parseMs(first.createdAt) : null,
    entryFilledShares: entered ? entryFilled : null,
    exitKind: ex.kind,
    exitPrice: ex.price,
    exitAtMs: ex.atMs,
    realizedPnlUsd: hasSellFill ? sellUsd - buyUsd - feeUsd : null,
    nEntryRows: entryRows.length,
    nReprices,
    unmapped: ref == null,
  };
}

/** Group the dry-run ledger rows by (marketId, tradeDate) → the per-market decisions. */
export function normalizeLedger(rows: DryRunLedgerRow[], index: CaptureIndex): MarketDecision[] {
  const byKey = new Map<string, DryRunLedgerRow[]>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !r.marketId || !r.tradeDate) continue;
    const k = `${r.marketId}|${r.tradeDate}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }
  const out: MarketDecision[] = [];
  for (const [k, rs] of byKey) {
    const [marketId, tradeDate] = k.split('|');
    out.push(marketDecisionOf(marketId!, tradeDate!, rs, index));
  }
  return out;
}

/** Collapse the (possibly multiple, one-per-bucket) A market decisions of ONE event into a single SideDecision.
 *  Picks the bucket matching side B when present, else the earliest-entered — and flags a multi-bucket event
 *  (the daemon's argmax shifted mid-window, entering two buckets — a real bucket-instability divergence). */
function collapseADecisions(mkts: MarketDecision[], bBucketIdx: number | null): SideDecision {
  if (mkts.length === 0) {
    return { entered: false, bucketIdx: null, bucketLabel: '', conditionId: null, entryPrice: null, entrySizeShares: null, entryAtMs: null, entryFilledShares: null, exitKind: null, exitPrice: null, exitAtMs: null, realizedPnlUsd: null };
  }
  const entered = mkts.filter((m) => m.entered);
  const bucketsEntered = [...new Set(entered.map((m) => m.bucketIdx).filter((v): v is number => v != null))];
  const pool = entered.length > 0 ? entered : mkts;
  const primary =
    (bBucketIdx != null ? pool.find((m) => m.bucketIdx === bBucketIdx) : undefined) ??
    [...pool].sort((a, b) => (a.entryAtMs ?? Infinity) - (b.entryAtMs ?? Infinity))[0]!;
  const nReprices = mkts.reduce((a, m) => a + (m.nReprices ?? 0), 0);
  const nEntryRows = mkts.reduce((a, m) => a + (m.nEntryRows ?? 0), 0);
  const realized = mkts.reduce((a, m) => a + (fin(m.realizedPnlUsd) ? m.realizedPnlUsd! : 0), 0);
  const anyRealized = mkts.some((m) => fin(m.realizedPnlUsd));
  return {
    entered: entered.length > 0,
    bucketIdx: primary.bucketIdx,
    bucketLabel: primary.bucketLabel,
    conditionId: primary.conditionId,
    entryPrice: primary.entryPrice,
    entrySizeShares: primary.entrySizeShares,
    entryAtMs: primary.entryAtMs,
    entryFilledShares: primary.entryFilledShares,
    exitKind: primary.exitKind,
    exitPrice: primary.exitPrice,
    exitAtMs: primary.exitAtMs,
    realizedPnlUsd: anyRealized ? realized : null,
    nEntryRows,
    nReprices,
    bucketsEntered,
    multiBucket: bucketsEntered.length > 1,
    unmapped: mkts.every((m) => m.unmapped === true),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Side B — the replay decision for one event
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Map one replay trade → a SideDecision. */
export function replayDecisionOf(trade: MakerExitTrade): SideDecision {
  if (!trade.executed) {
    return { entered: false, bucketIdx: null, bucketLabel: '', conditionId: null, entryPrice: null, entrySizeShares: null, entryAtMs: null, entryFilledShares: null, exitKind: null, exitPrice: null, exitAtMs: null, realizedPnlUsd: null, notEnteredReason: trade.exitKind || 'not_entered' };
  }
  const shares = fin(trade.entryPrice) && trade.entryPrice! > 0 ? trade.stakeUsd / trade.entryPrice! : null;
  return {
    entered: true,
    bucketIdx: trade.bucketIdx,
    bucketLabel: trade.entryLabel,
    conditionId: null, // resolved from the index at diff time (bucketIdx → conditionId)
    entryPrice: fin(trade.entryPrice) ? trade.entryPrice : null,
    entrySizeShares: shares,
    entryAtMs: parseMs(trade.entryAt),
    entryFilledShares: shares,
    exitKind: trade.exitKind,
    exitPrice: fin(trade.exitPrice) ? trade.exitPrice : null,
    exitAtMs: parseMs(trade.exitAt),
    realizedPnlUsd: trade.exitKind.startsWith('mtm_') ? null : fin(trade.netPnlUsd) ? trade.netPnlUsd : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// computeShadowDiff — the pure diff pipeline
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** normalize an exit-kind to its comparable base (drop the resolution win/lose suffix). */
const baseExitKind = (k: string | null): string | null => (k == null ? null : k.split(':')[0]!);

/** M1 — the global systematic deltas detected ONCE over both-entered rows, normalized out of per-row scores. */
interface ScoreGlobals {
  /** median B/A entry-share ratio (identity 1 when below the sample floor). */
  sizeRatioBOverA: number;
  /** median B−A entry-price delta in PRICE UNITS (identity 0 when below the sample floor). */
  priceDeltaMedian: number;
}

/** score + annotate one aligned row (higher score = more divergent = more bug-worthy). EXPECTED classes are
 *  tagged but do NOT inflate the score — the score ranks the UNEXPECTED disagreements to the top. Notes are
 *  ordered by SEVERITY: scored ALERTS first, EXPECTED(...) tags last (the table shows notes[0] — lens M2). */
function scoreRow(row: ShadowDiffRow, globals: ScoreGlobals, scopeCities: string[]): void {
  const { a, b } = row;
  const alerts: string[] = [];
  const tags: string[] = [];
  let score = 0;

  // M3 — the expected STRUCTURAL cases where A's entry price/size are intent-only observables: an unfilled
  // dry-run intent's resting limit is not a fill price, and a repriced entry's first-row limit is stale by
  // construction. Deltas stay computed + summarized; they are TAGGED here and never scored.
  const intentOnly = (a.nReprices ?? 0) > 0 || (a.entered && (a.entryFilledShares ?? 0) < 1e-9);

  // M2 — a REAL daemon anomaly, hoisted FIRST so its alert leads notes[0]: one event, MULTIPLE buckets entered
  // (capital doubling; reachable because the daemon's positioned-set keys on conditionId, not eventId).
  if (a.multiBucket) {
    score += 50;
    alerts.push(
      `MULTI-BUCKET: A entered ${(a.bucketsEntered ?? []).length} buckets [${(a.bucketsEntered ?? []).join(', ')}] for ONE event — capital doubling; the daemon's positioned-set keys on conditionId, not eventId`,
    );
  }

  if (a.entered !== b.entered) {
    if (a.entered && !b.entered) {
      // L3 — a city derivably outside the harness scope is an expected artifact, not an enter-disagreement.
      const outOfScope = a.unmapped !== true && row.city.length > 0 && !scopeCities.includes(row.city);
      if (outOfScope) {
        row.outOfScopeA = true;
        tags.push(`EXPECTED(city-scope): A traded ${row.city}, outside the harness cities — widen --cities to the daemon allowlist; not a capture bug`);
      } else if (a.unmapped === true) {
        score += 100;
        alerts.push('ENTER DISAGREE (A-only, UNMAPPED): market_id absent from the captured window — EITHER the daemon allowlist is wider than --cities (widen --cities) OR a real capture-coverage gap');
      } else {
        score += 100;
        alerts.push(`ENTER DISAGREE: A entered, replay(B) did NOT (${b.notEnteredReason ?? 'no reason'}) — investigate live discovery vs replay universe`);
      }
    } else {
      score += 100;
      alerts.push('ENTER DISAGREE: replay(B) entered, A did NOT — daemon skipped a market the replay would enter');
    }
  } else if (a.entered && b.entered) {
    if (row.bucketAgree === false) {
      score += 50;
      alerts.push(`BUCKET DISAGREE: A idx ${a.bucketIdx} (${a.bucketLabel}) vs B idx ${b.bucketIdx} (${b.bucketLabel}) — EXPECTED(consensus-source) if the seed differs, else a bug`);
    }
    if (intentOnly) {
      tags.push('EXPECTED(intent-only price/size): A price/size are unfilled-intent observables (dry-run no-fill / repriced) — deltas reported, not scored');
    } else {
      // M1 — score the RESIDUAL after the global systematic deltas (config-stake scale + maker shade).
      if (fin(row.entryPriceDelta)) {
        const residualPp = Math.abs(row.entryPriceDelta! - globals.priceDeltaMedian) * 100;
        score += Math.min(30, residualPp); // 1 pt per residual cent, capped
      }
      if (fin(row.entrySizeDelta) && fin(a.entrySizeShares) && a.entrySizeShares! > 0 && fin(b.entrySizeShares)) {
        const ratio = b.entrySizeShares! / a.entrySizeShares!;
        const residualRel = globals.sizeRatioBOverA > 0 ? Math.abs(ratio / globals.sizeRatioBOverA - 1) : Math.abs(ratio - 1);
        score += Math.min(10, residualRel * 10);
        if (residualRel > 0.25) {
          alerts.push(`SIZE divergence beyond the global scale: A ${Math.round(a.entrySizeShares!)}sh vs B ${Math.round(b.entrySizeShares!)}sh (global B/A ×${globals.sizeRatioBOverA.toFixed(2)})`);
        }
      }
    }
    // exit-kind + P&L only score when BOTH sides realized (side A does not in dry-run — expected class #1).
    if (row.exitKindAgree === false) {
      score += 20;
      alerts.push(`EXIT DISAGREE: A ${a.exitKind} vs B ${b.exitKind}`);
    }
    if (fin(row.realizedPnlDelta)) score += Math.min(20, Math.abs(row.realizedPnlDelta!));
  }

  // ── expected-class annotations (tagged, not scored; always AFTER the alerts) ──
  if (a.entered && (a.entryFilledShares ?? 0) < 1e-9) tags.push('EXPECTED(dry-run-no-fill): A entry unfilled — dry-run never posts, so A carries no exit / no realized P&L');
  if ((a.nReprices ?? 0) > 0) tags.push(`EXPECTED(reprice-vs-taker-fallback): A repriced the maker entry ${a.nReprices}× (replay takes a taker fallback)`);
  if (b.exitKind && b.exitKind.startsWith('mtm_')) tags.push('B still open (mtm_unresolved) — its exit/P&L not yet realized');

  row.notes = [...alerts, ...tags];
  row.divergenceScore = Math.round(score * 100) / 100;
}

/**
 * Diff the dry-run ledger (side A) against the maker-exit replay (side B) over the same capture window.
 * Pure + total. `events` = buildEvents(rawCaptures, resMap); `index` = buildCaptureIndex(rawCaptures);
 * `ledgerRows` = the mode='dry-run' live_orders rows (+ fills); `cfg` = the pinned maker-exit config the
 * paper loop replays with (makerExitCfg(cities)).
 */
export function computeShadowDiff(
  events: EventReplayInput[],
  index: CaptureIndex,
  ledgerRows: DryRunLedgerRow[],
  cfg: MakerExitCfg,
  windowDays: number,
): ShadowDiffReport {
  // side B — the replay decision per event.
  const bByEvent = new Map<string, { dec: SideDecision; city: string; targetDate: string }>();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !e.eventId) continue;
    const trade = replayMakerExitEvent(e, cfg, index.resolvesByEvent.get(e.eventId) ?? null);
    const dec = replayDecisionOf(trade);
    // resolve B's conditionId from the index (bucketIdx → conditionId) for the cross-check display.
    if (dec.entered && dec.bucketIdx != null) {
      const centerRef = index.event.get(e.eventId);
      dec.conditionId = centerRef && centerRef.centerBucketIdx === dec.bucketIdx ? centerRef.centerConditionId : dec.conditionId;
    }
    bByEvent.set(e.eventId, { dec, city: e.city, targetDate: e.targetDate });
  }

  // side A — the dry-run ledger decisions, grouped by event key (unmapped markets get their own key).
  const aMarkets = normalizeLedger(ledgerRows, index);
  const aByKey = new Map<string, MarketDecision[]>();
  for (const m of aMarkets) {
    const key = m.eventId ?? `unmapped:${m.marketId}|${m.tradeDate}`;
    (aByKey.get(key) ?? aByKey.set(key, []).get(key)!).push(m);
  }

  const keys = new Set<string>([...bByEvent.keys(), ...aByKey.keys()]);
  const rows: ShadowDiffRow[] = [];
  for (const key of keys) {
    const bEntry = bByEvent.get(key) ?? null;
    const aMkts = aByKey.get(key) ?? [];
    const b: SideDecision = bEntry
      ? bEntry.dec
      : { entered: false, bucketIdx: null, bucketLabel: '', conditionId: null, entryPrice: null, entrySizeShares: null, entryAtMs: null, entryFilledShares: null, exitKind: null, exitPrice: null, exitAtMs: null, realizedPnlUsd: null, notEnteredReason: 'not_in_capture_window' };
    const a = collapseADecisions(aMkts, b.bucketIdx);

    const eventId = bEntry ? key : aMkts[0]?.eventId ?? null;
    const city = bEntry?.city || aMkts[0]?.city || '';
    const targetDate = bEntry?.targetDate || aMkts[0]?.tradeDate || '';

    const bothEntered = a.entered && b.entered;
    const row: ShadowDiffRow = {
      key,
      eventId,
      city,
      targetDate,
      a,
      b,
      enteredAgree: a.entered === b.entered,
      bucketAgree: bothEntered ? a.bucketIdx === b.bucketIdx : null,
      entryPriceDelta: bothEntered && fin(a.entryPrice) && fin(b.entryPrice) ? b.entryPrice! - a.entryPrice! : null,
      entrySizeDelta: bothEntered && fin(a.entrySizeShares) && fin(b.entrySizeShares) ? b.entrySizeShares! - a.entrySizeShares! : null,
      entryAtDeltaMs: bothEntered && fin(a.entryAtMs) && fin(b.entryAtMs) ? b.entryAtMs! - a.entryAtMs! : null,
      exitKindAgree: a.exitKind != null && b.exitKind != null ? baseExitKind(a.exitKind) === baseExitKind(b.exitKind) : null,
      realizedPnlDelta: fin(a.realizedPnlUsd) && fin(b.realizedPnlUsd) ? b.realizedPnlUsd! - a.realizedPnlUsd! : null,
      divergenceScore: 0,
      notes: [],
    };
    rows.push(row);
  }

  // ── M1: detect the GLOBAL systematic deltas ONCE, over ALL both-entered rows (including intent-only rows —
  //    the dry-run shadow is exactly where a config-scale mismatch shows), THEN score each row on the residual.
  //    Below the sample floor a "global" is indistinguishable from a per-row divergence → identity (no normalize).
  const bothEntered = rows.filter((r) => r.a.entered && r.b.entered);
  const sizeRatioSamples = bothEntered
    .map((r) => (fin(r.a.entrySizeShares) && r.a.entrySizeShares! > 0 && fin(r.b.entrySizeShares) ? r.b.entrySizeShares! / r.a.entrySizeShares! : NaN))
    .filter((v) => Number.isFinite(v));
  const priceDeltas = bothEntered.map((r) => r.entryPriceDelta).filter((v): v is number => fin(v));
  const normalize = sizeRatioSamples.length >= GLOBAL_NORMALIZE_MIN_SAMPLES || priceDeltas.length >= GLOBAL_NORMALIZE_MIN_SAMPLES;
  const globals: ScoreGlobals = {
    sizeRatioBOverA: sizeRatioSamples.length >= GLOBAL_NORMALIZE_MIN_SAMPLES ? median(sizeRatioSamples) : 1,
    priceDeltaMedian: priceDeltas.length >= GLOBAL_NORMALIZE_MIN_SAMPLES ? median(priceDeltas) : 0,
  };
  for (const row of rows) scoreRow(row, globals, cfg.cities);

  rows.sort((x, y) => y.divergenceScore - x.divergenceScore || (x.city + x.targetDate).localeCompare(y.city + y.targetDate));

  // ── summary stats ──
  const sizeDeltas = bothEntered.map((r) => r.entrySizeDelta).filter((v): v is number => fin(v));
  const exitKindDistB: Record<string, number> = {};
  for (const r of rows) {
    if (r.b.entered && r.b.exitKind) exitKindDistB[r.b.exitKind] = (exitKindDistB[r.b.exitKind] ?? 0) + 1;
  }
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

  const nBothEntered = bothEntered.length;
  const nAOnly = rows.filter((r) => r.a.entered && !r.b.entered).length;
  const nBOnly = rows.filter((r) => !r.a.entered && r.b.entered).length;
  const nBothSkipped = rows.filter((r) => !r.a.entered && !r.b.entered).length;
  const nUnmappedA = rows.filter((r) => r.a.unmapped === true).length;

  const summary: ShadowDiffSummary = {
    nEvents: rows.length,
    nBothEntered,
    nAOnly,
    nBOnly,
    nBothSkipped,
    nUnmappedA,
    entryAgreementRate: rows.length ? (nBothEntered + nBothSkipped) / rows.length : NaN,
    bucketAgreementRate: nBothEntered ? bothEntered.filter((r) => r.bucketAgree === true).length / nBothEntered : NaN,
    meanEntryPriceDeltaCents: mean(priceDeltas.map((d) => d * 100)),
    meanAbsEntryPriceDeltaCents: mean(priceDeltas.map((d) => Math.abs(d) * 100)),
    meanEntrySizeDelta: mean(sizeDeltas),
    nARepricesTotal: rows.reduce((a, r) => a + (r.a.nReprices ?? 0), 0),
    nAEntriesUnfilled: rows.filter((r) => r.a.entered && (r.a.entryFilledShares ?? 0) < 1e-9).length,
    globalSizeRatioBOverA: median(sizeRatioSamples),
    medianEntryPriceDeltaCents: median(priceDeltas.map((d) => d * 100)),
    globalNormalizationApplied: normalize,
    nOutOfScopeA: rows.filter((r) => r.outOfScopeA === true).length,
    exitKindDistB,
    totalRealizedPnlA: rows.reduce((a, r) => a + (fin(r.a.realizedPnlUsd) ? r.a.realizedPnlUsd! : 0), 0),
    totalRealizedPnlB: rows.reduce((a, r) => a + (fin(r.b.realizedPnlUsd) ? r.b.realizedPnlUsd! : 0), 0),
    windowDays,
    cities: cfg.cities,
    ledgerRowsRead: Array.isArray(ledgerRows) ? ledgerRows.length : 0,
    runnable: Array.isArray(ledgerRows) && ledgerRows.length > 0,
  };

  return { summary, rows, expectedDivergenceClasses: EXPECTED_DIVERGENCE_CLASSES, generatedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// render — the console table (default) + the --json machine-readable form
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number | null): string => (v != null && Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}` : '—');
const px = (v: number | null): string => (v != null && Number.isFinite(v) ? v.toFixed(3) : '—');
const yn = (v: boolean): string => (v ? 'Y' : '·');
const bkt = (d: SideDecision): string => (d.bucketIdx != null ? `${d.bucketIdx}` : '—');

export function render(report: ShadowDiffReport, top: number, log: (m: string) => void): void {
  const s = report.summary;
  log('=== trade-shadow-diff · dry-run daemon ledger (A) vs maker-exit replay (B) ===');
  log(`  window ${s.windowDays}d · cities ${s.cities.length} · ledger rows ${s.ledgerRowsRead} · ${report.generatedAt}`);
  if (!s.runnable) {
    log('');
    log('  ⚠ NOT RUNNABLE YET — zero dry-run ledger rows read. This is EXPECTED until:');
    log('      (1) migration 0082 is applied (operator-gated), AND');
    log('      (2) the dry-run daemon (TRADE_MODE=dry-run pnpm tsx scripts/trade-bot.ts) has accrued rows.');
    log('    The diff below is a template (side B / replay only). Re-run after the shadow week starts.');
  }
  log('');
  log('  EXPECTED divergence classes (tagged EXPECTED(...) below — NOT bugs, NOT scored):');
  for (const c of report.expectedDivergenceClasses) log(`    • ${c}`);
  log('');
  log('  NOTE (city scope): the ledger read is city-UNFILTERED while side B honors --cities — daemon rows for');
  log('  cities outside --cities surface as out-of-scope/unmapped A-only rows. Widen --cities to the daemon');
  log('  allowlist for a clean read.');
  log('');
  log('  ── summary ──');
  log(`  events ${s.nEvents} · bothEntered ${s.nBothEntered} · A-only ${s.nAOnly} (out-of-scope ${s.nOutOfScopeA}) · B-only ${s.nBOnly} · bothSkipped ${s.nBothSkipped} · unmappedA ${s.nUnmappedA}`);
  log(`  entry-agreement ${pct(s.entryAgreementRate)} · bucket-agreement ${pct(s.bucketAgreementRate)} (of both-entered)`);
  log(`  entry-price Δ(B−A): mean ${signedCents(s.meanEntryPriceDeltaCents)} · meanAbs ${absCents(s.meanAbsEntryPriceDeltaCents)} · size Δ mean ${signed(s.meanEntrySizeDelta)} sh`);
  // M1 — the detected GLOBAL systematic deltas (config-stake scale + maker shade), surfaced ONCE here instead
  // of polluting every row's score. Residual-only per-row scoring applies when the sample floor is met.
  if (Number.isFinite(s.globalSizeRatioBOverA) && Math.abs(s.globalSizeRatioBOverA - 1) > 0.1) {
    log(
      `  ⚠ GLOBAL SIZE SCALE: B/A ×${s.globalSizeRatioBOverA.toFixed(2)} — trade_config.stake_per_buy_usd vs the replay's perPositionUsd differ (EXPECTED(config-stake-scale)); ` +
        (s.globalNormalizationApplied ? 'per-row size scored on the residual only' : `below the n≥${GLOBAL_NORMALIZE_MIN_SAMPLES} floor — NOT yet normalized out of scores`),
    );
  }
  if (Number.isFinite(s.medianEntryPriceDeltaCents) && Math.abs(s.medianEntryPriceDeltaCents) > 0.5) {
    log(
      `  ⚠ SYSTEMATIC ENTRY-PRICE OFFSET: median B−A ${signedCents(s.medianEntryPriceDeltaCents)} — consistent with the maker post_only shade (EXPECTED(maker-shade)); ` +
        (s.globalNormalizationApplied ? 'per-row price scored on the residual only' : `below the n≥${GLOBAL_NORMALIZE_MIN_SAMPLES} floor — NOT yet normalized out of scores`),
    );
  }
  log(`  A reprices total ${s.nARepricesTotal} · A entries unfilled ${s.nAEntriesUnfilled} (dry-run-no-fill) · realized P&L A ${usd(s.totalRealizedPnlA)} / B ${usd(s.totalRealizedPnlB)}`);
  const exitDist = Object.entries(s.exitKindDistB).map(([k, n]) => `${k}:${n}`).join(' · ') || '—';
  log(`  B exit-kind mix: ${exitDist}`);
  log('');
  log(`  ── most-divergent markets (top ${Math.min(top, report.rows.length)} of ${report.rows.length}) ──`);
  log('  Δmin = B modeled-fill tick − A intent-created (ASYMMETRIC by design: ≈ B fill latency; big negatives are the anomaly). Unscored.');
  log(
    `  ${'score'.padStart(6)}  ${'city'.padEnd(12)} ${'date'.padEnd(10)} ` +
      `${'A?'.padStart(2)} ${'B?'.padStart(2)}  ${'bktA'.padStart(4)} ${'bktB'.padStart(4)}  ` +
      `${'pxA'.padStart(6)} ${'pxB'.padStart(6)}  ${'Δmin'.padStart(5)}  ${'exitB'.padEnd(18)} ${'pnlB'.padStart(8)}  note`,
  );
  for (const r of report.rows.slice(0, top)) {
    const note = r.notes[0] ?? '';
    log(
      `  ${String(r.divergenceScore).padStart(6)}  ${(r.city || '—').slice(0, 12).padEnd(12)} ${(r.targetDate || '—').padEnd(10)} ` +
        `${yn(r.a.entered).padStart(2)} ${yn(r.b.entered).padStart(2)}  ${bkt(r.a).padStart(4)} ${bkt(r.b).padStart(4)}  ` +
        `${px(r.a.entryPrice).padStart(6)} ${px(r.b.entryPrice).padStart(6)}  ${dmin(r.entryAtDeltaMs).padStart(5)}  ${(r.b.exitKind ?? '—').slice(0, 18).padEnd(18)} ` +
        `${usd(r.b.realizedPnlUsd).padStart(8)}  ${note.slice(0, 72)}`,
    );
  }
  log('');
  log('  This decides NOTHING about capital — it surfaces daemon/replay divergences for the shadow week to');
  log('  investigate. Divergences in the EXPECTED classes above are by-design; the ranked score hunts the rest.');
}

const dmin = (ms: number | null): string => (ms != null && Number.isFinite(ms) ? `${ms >= 0 ? '+' : '−'}${Math.round(Math.abs(ms) / 60000)}` : '—');

const signed = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}` : '—');
const signedCents = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}¢` : '—');
const absCents = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(2)}¢` : '—');

/** The machine-readable form (--json): the full report, unabbreviated. */
export function renderJson(report: ShadowDiffReport): string {
  return JSON.stringify(report);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// sanity — the CLI self-test (runs on invocation, no DB/network — mirrors the sibling research spines)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function sanity(): void {
  const TZ = 'Europe/Amsterdam';
  const DATE = '2026-07-06';
  const cfg = makerExitCfg(['amsterdam']);

  // a ladder whose center (idx 2) enters + a later up-tick that takes the maker profit (mirrors
  // opening-bracket-score's known-good ladder; center depth bumped to clear the maker-exit $150 floor).
  // conditionIds are EVENT-SCOPED (each Polymarket bucket is globally unique) so the index never collides.
  const bk = (eventId: string, idx: number, over: Partial<RawBucket> = {}): RawBucket => ({
    idx, label: `b${idx}`, loF: null, hiF: null, mid: 0.1, bestAsk: 0.11, execAsk: 0.11, depthUsd: 100,
    bestBid: 0.09, sellbackUsd: 100, execBid: 0.1, sellbackDepthUsd: 100, houseProb: null,
    tokenYes: `${eventId}-y${idx}`, tokenNo: `${eventId}-n${idx}`, conditionId: `${eventId}-c${idx}`, ...over,
  });
  const ladder = (eventId: string, center: Partial<RawBucket> = {}): RawBucket[] => [
    bk(eventId, 0, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
    bk(eventId, 1, { houseProb: 0.2 }),
    bk(eventId, 2, { houseProb: 0.35, depthUsd: 200, ...center }),
    bk(eventId, 3, { houseProb: 0.2 }),
    bk(eventId, 4, { houseProb: 0.1, execAsk: 0.09, bestAsk: 0.09 }),
  ];
  const row = (eventId: string, capturedAt: string, age: number, center: Partial<RawBucket> = {}): RawCaptureRow => ({
    eventId, capturedAt, city: 'amsterdam', targetDate: DATE, tzName: TZ, createdAtGamma: null, resolvesAt: null,
    hoursSinceListing: age, peakMid: 0.1, isFlatOpen: true, houseSeeded: true, buckets: ladder(eventId, center), evVol24h: 5000, negRisk: true,
  });
  // three ticks: entry (execAsk 0.18) → maker fill (0.11) → up-tick execBid 0.45 (TP at entry+0.12).
  const evtRows = (eventId: string): RawCaptureRow[] => [
    row(eventId, '2026-07-06T08:00:00.000Z', 0.2, { execAsk: 0.18, bestAsk: 0.12, execBid: 0.1 }),
    row(eventId, '2026-07-06T08:00:30.000Z', 0.3, { execAsk: 0.11, execBid: 0.1 }),
    row(eventId, '2026-07-06T08:01:00.000Z', 0.35, { execBid: 0.45 }),
  ];
  const raw = [...evtRows('E1'), ...evtRows('E2')];
  const index = buildCaptureIndex(raw);
  if (index.market.get('E1-c2')?.eventId !== 'E1') throw new Error('sanity: E1-c2 must map to E1');
  if (index.event.get('E1')?.centerBucketIdx !== 2) throw new Error('sanity: E1 center must be idx 2');
  const events = buildEvents(raw, new Map());
  if (events.length !== 2) throw new Error(`sanity: expected 2 fresh events, got ${events.length}`);

  const led = (over: Partial<DryRunLedgerRow>): DryRunLedgerRow => ({
    mode: 'dry-run', intentKey: 'k', clientOrderId: 'co', orderId: 'dry-run:co', marketId: 'E1-c2', tokenId: 'E1-y2',
    side: 'BUY', purpose: 'entry', orderType: 'GTC', price: 0.12, size: 66, sizeMatched: 0, avgPrice: null,
    tradeDate: DATE, status: 'placed', createdAt: '2026-07-06T08:00:10.000Z', placedAt: '2026-07-06T08:00:10.000Z',
    fillNotionalUsd: 0, fillFeeUsd: 0, fillSize: 0, ...over,
  });
  // A entered E1's center (E1-c2) — agreement; a repriced 2nd entry row (canceled); an UNMAPPED market (zzz).
  const ledger: DryRunLedgerRow[] = [
    led({ clientOrderId: 'e1a', marketId: 'E1-c2', status: 'canceled', createdAt: '2026-07-06T08:00:05.000Z' }),
    led({ clientOrderId: 'e1b', marketId: 'E1-c2', status: 'placed', createdAt: '2026-07-06T08:00:40.000Z' }),
    led({ clientOrderId: 'zz', marketId: 'zzz', tokenId: 'yz', status: 'placed' }),
  ];

  const report = computeShadowDiff(events, index, ledger, cfg, 3);

  // side B entered both events (the ladder is designed to enter+TP).
  const e1 = report.rows.find((r) => r.eventId === 'E1');
  const e2 = report.rows.find((r) => r.eventId === 'E2');
  const zz = report.rows.find((r) => r.key.startsWith('unmapped:zzz'));
  if (!e1 || !e2 || !zz) throw new Error('sanity: expected E1, E2 and the unmapped zzz rows');
  if (!e1.a.entered || !e1.b.entered) throw new Error('sanity: E1 should be entered by BOTH sides');
  if (e1.bucketAgree !== true) throw new Error('sanity: E1 buckets should agree (both idx 2)');
  if ((e1.a.nReprices ?? 0) !== 1) throw new Error(`sanity: E1 should show 1 reprice, got ${e1.a.nReprices}`);
  if (!e1.notes.some((n) => n.includes('dry-run-no-fill'))) throw new Error('sanity: E1 must tag the dry-run-no-fill class');
  if (!e1.notes.some((n) => n.includes('reprice-vs-taker-fallback'))) throw new Error('sanity: E1 must tag the reprice class');
  // M3: an agreement row whose A entry is an unfilled/repriced INTENT scores 0 — expected classes never score.
  if (e1.divergenceScore !== 0) throw new Error(`sanity: E1 (agreement, intent-only) should score 0, got ${e1.divergenceScore}`);
  // E2: B entered, A absent → B-only, high score.
  if (e2.a.entered || !e2.b.entered) throw new Error('sanity: E2 should be B-only');
  if (e2.divergenceScore < 100) throw new Error(`sanity: E2 (B-only) score should be ≥100, got ${e2.divergenceScore}`);
  // the unmapped A market → A entered, B absent, unmapped tagged.
  if (!zz.a.unmapped) throw new Error('sanity: zzz must be flagged unmapped');
  if (zz.divergenceScore < 100) throw new Error('sanity: zzz (A-only) score should be ≥100');
  // the B-only / A-only rows must sort above the agreement row.
  if (report.rows[0]!.divergenceScore < e1.divergenceScore) throw new Error('sanity: ranking must put divergences first');

  // summary sanity
  if (report.summary.nBothEntered !== 1) throw new Error(`sanity: nBothEntered should be 1, got ${report.summary.nBothEntered}`);
  if (report.summary.nBOnly !== 1 || report.summary.nAOnly !== 1) throw new Error('sanity: expected exactly one A-only and one B-only');
  if (report.summary.nUnmappedA !== 1) throw new Error('sanity: expected one unmapped A market');
  if (!report.summary.runnable) throw new Error('sanity: runnable must be true with ledger rows present');

  // render + json totality (must not throw), incl. the empty-ledger NOT-RUNNABLE path.
  render(report, 30, () => {});
  if (!renderJson(report).includes('summary')) throw new Error('sanity: renderJson must carry the summary');
  const emptyReport = computeShadowDiff(events, index, [], cfg, 3);
  if (emptyReport.summary.runnable) throw new Error('sanity: empty ledger must be NOT runnable');
  render(emptyReport, 30, () => {}); // must not throw on the not-runnable path
  // total on all-empty input
  render(computeShadowDiff([], { market: new Map(), event: new Map(), resolvesByEvent: new Map() }, [], cfg, 3), 30, () => {});
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DB I/O (read-only; used ONLY by the CLI tail below). Typed against ScriptDb via the top-of-file
// type-only import, so the pure module carries no postgres runtime dep (the CLI lazily imports it).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The mode='dry-run' order ledger over the window, each row joined to its aggregated fills (0 in dry-run). */
export async function loadDryRunLedger(db: ScriptDb, days: number): Promise<DryRunLedgerRow[]> {
  const rows = await db.query<DryRunLedgerRow>(
    `select o.mode                       as "mode",
            o.intent_key                 as "intentKey",
            o.client_order_id            as "clientOrderId",
            o.order_id                   as "orderId",
            o.market_id                  as "marketId",
            o.token_id                   as "tokenId",
            o.side                       as "side",
            o.purpose                    as "purpose",
            o.order_type                 as "orderType",
            o.price::float8              as "price",
            o.size::float8               as "size",
            o.size_matched::float8       as "sizeMatched",
            o.avg_price::float8          as "avgPrice",
            o.trade_date::text           as "tradeDate",
            o.status                     as "status",
            o.created_at::text           as "createdAt",
            o.placed_at::text            as "placedAt",
            coalesce(f.notional, 0)::float8 as "fillNotionalUsd",
            coalesce(f.fee, 0)::float8      as "fillFeeUsd",
            coalesce(f.sz, 0)::float8       as "fillSize"
       from public.live_orders o
       left join (
         select order_id, sum(fill_notional) as notional, sum(fee_usd) as fee, sum(fill_size) as sz
           from public.live_fills group by order_id
       ) f on f.order_id = o.id
      where o.mode = 'dry-run'
        and o.created_at > now() - ($1 || ' days')::interval
      order by o.created_at`,
    [Math.max(1, Math.floor(days))],
  );
  return rows.map((r) => ({
    mode: String(r.mode),
    intentKey: r.intentKey == null ? null : String(r.intentKey),
    clientOrderId: r.clientOrderId == null ? null : String(r.clientOrderId),
    orderId: r.orderId == null ? null : String(r.orderId),
    marketId: String(r.marketId ?? ''),
    tokenId: String(r.tokenId ?? ''),
    side: String(r.side ?? ''),
    purpose: String(r.purpose ?? ''),
    orderType: String(r.orderType ?? ''),
    price: num0(r.price),
    size: num0(r.size),
    sizeMatched: num0(r.sizeMatched),
    avgPrice: numOrNull(r.avgPrice),
    tradeDate: String(r.tradeDate ?? ''),
    status: String(r.status ?? ''),
    createdAt: r.createdAt == null ? null : String(r.createdAt),
    placedAt: r.placedAt == null ? null : String(r.placedAt),
    fillNotionalUsd: num0(r.fillNotionalUsd),
    fillFeeUsd: num0(r.fillFeeUsd),
    fillSize: num0(r.fillSize),
  }));
}

/** Per-event resolution map (winnerIdx = poly_resolved_winner_idx ?? winning_bucket_idx; grading_mismatch). The
 *  same read as opening-bracket-score.loadResolutionMap — kept local so this harness stays self-contained. */
export async function loadResolutionMap(db: ScriptDb, ids: string[]): Promise<Map<string, Resolution>> {
  const m = new Map<string, Resolution>();
  if (!Array.isArray(ids) || ids.length === 0) return m;
  const rows = await db.query<Record<string, unknown>>(
    `select id, poly_resolved_winner_idx, winning_bucket_idx, grading_mismatch
       from public.market_events where id = any($1::uuid[])`,
    [ids],
  );
  for (const r of rows) {
    const poly = numOrNull(r['poly_resolved_winner_idx']);
    const win = numOrNull(r['winning_bucket_idx']);
    m.set(String(r['id']), { winnerIdx: poly ?? win, gradingMismatch: r['grading_mismatch'] === true });
  }
  return m;
}

/** The RAW `opening_captures` rows for the fresh+city window (the SAME server-side filter as
 *  opening-bracket-score.loadEvents, but returning the RAW rows so this harness can additionally build the
 *  resolvesByEvent anchor + the conditionId→event index that the grouped EventReplayInput drops). Numerics are
 *  ::float8-cast, timestamps ::text-cast (the TS fresh/finite gates + new Date() see numbers/ISO). */
export async function loadCaptureRows(db: ScriptDb, days: number, cities: string[]): Promise<RawCaptureRow[]> {
  const allow = (Array.isArray(cities) ? cities : []).filter((c) => typeof c === 'string' && c.length > 0);
  if (allow.length === 0) return [];
  return db.query<RawCaptureRow>(
    `with fresh as (
       select event_id
         from public.opening_captures
        where captured_at > now() - ($1 || ' days')::interval
          and event_id is not null
          and city = any($2::text[])
        group by event_id
       having min(hours_since_listing) < 1
     )
     select oc.event_id                    as "eventId",
            oc.captured_at::text           as "capturedAt",
            oc.city                        as "city",
            oc.target_date::text           as "targetDate",
            oc.tz_name                     as "tzName",
            oc.created_at_gamma::text      as "createdAtGamma",
            oc.resolves_at::text           as "resolvesAt",
            oc.hours_since_listing::float8 as "hoursSinceListing",
            oc.peak_mid::float8            as "peakMid",
            oc.is_flat_open                as "isFlatOpen",
            oc.house_seeded                as "houseSeeded",
            oc.buckets                     as "buckets",
            oc.ev_vol24h::float8           as "evVol24h",
            oc.neg_risk                    as "negRisk"
       from public.opening_captures oc
       join fresh f on f.event_id = oc.event_id
      where oc.captured_at > now() - ($1 || ' days')::interval
      order by oc.event_id, oc.captured_at`,
    [Math.max(1, Math.floor(days)), allow],
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI — read-only DB tail (ONLY runs when invoked directly; NEVER reached by a fixture test). Reads the
// dry-run ledger + the capture window via DATABASE_URL (service role, env-var NAME only) and diffs.
// NOT RUN tonight: 0082 is DARK and the dry-run daemon has no rows yet — this path stays dormant.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity(); // the pure self-test always runs first (no DB) — a broken pipeline fails loudly before any read.
  const { values } = parseArgs({
    options: {
      days: { type: 'string' },
      cities: { type: 'string' },
      top: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const days = Math.max(1, Math.floor(Number(values.days ?? DEFAULT_DAYS) || DEFAULT_DAYS));
  const top = Math.max(1, Math.floor(Number(values.top ?? DEFAULT_TOP) || DEFAULT_TOP));
  const cities =
    values.cities != null
      ? String(values.cities).split(',').map((s) => s.trim()).filter((c) => c.length > 0)
      : [...BOT_DEFAULTS.cities];
  const cfg = makerExitCfg(cities);

  // Lazy dynamic import of the DB/env libs — the pure pipeline above never touches them, so a fixture test
  // that imports this module pulls in NO postgres/fs dependency; only the CLI path does.
  const { makeScriptDb } = await import('../lib/script-db.ts');
  const { loadEnv } = await import('../lib/load-env.ts');
  loadEnv();
  const db = makeScriptDb();
  try {
    process.stderr.write(
      `${SCRIPT} · ${new Date().toISOString()} · reading live_orders(mode='dry-run') ⋈ live_fills + opening_captures(${days}d, ${cities.length} cities) — read-only; places NOTHING\n`,
    );
    const rawCaptures = await loadCaptureRows(db, days, cities);
    const resMap = await loadResolutionMap(db, [...new Set(rawCaptures.map((r) => r.eventId).filter((v): v is string => !!v))]);
    const events = buildEvents(rawCaptures, resMap);
    const index = buildCaptureIndex(rawCaptures);
    const ledger = await loadDryRunLedger(db, days);
    process.stderr.write(`  ${events.length} fresh events · ${rawCaptures.length} capture rows · ${ledger.length} dry-run ledger rows\n`);
    const report = computeShadowDiff(events, index, ledger, cfg, days);
    if (values.json) process.stdout.write(renderJson(report) + '\n');
    else render(report, top, console.log);
  } finally {
    await db.end();
  }
}
