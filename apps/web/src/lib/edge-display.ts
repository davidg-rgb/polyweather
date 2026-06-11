/**
 * EdgeChart display recompute (§6.21; §15 "no silent drift between engine
 * and UI") — re-runs the SAME core computeBucketEdges the engine ran (§6.17
 * step 4) over the data the dashboard already loaded: champion probs +
 * the stored book_top3 + per-bucket fee/spread. The stored hourly
 * edge_evaluations (F-038) render side-by-side; any numeric disagreement
 * beyond the numeric(8,6) storage rounding is flagged as drift.
 *
 * Scope of the comparison (honest by construction):
 * - q / execAsk / edge / minEdge are time-invariant given the same book,
 *   champion row, and config — these four are compared.
 * - Liquidity vetoes (volume, time-to-close, halts) are time-dependent —
 *   the engine evaluated them at captured_hour; the page loads later. The
 *   stored pass/reasons are displayed verbatim, never recomputed.
 * - book_top3 keeps 3 levels; when either side hit depth truncation
 *   (insufficient_depth) asymmetrically, the bucket is reported as
 *   non-comparable instead of producing a phantom drift.
 */
import { computeBucketEdges } from '@weather-edge/core';
import type { AppConfig, BucketDef, EdgeRow, NormalizedBook, Unit } from '@weather-edge/core';

export interface StoredBookLevel {
  price: number | string;
  size: number | string;
}

export interface LadderRowPayload {
  idx: number;
  label: string;
  low: number | string | null;
  high: number | string | null;
  feeRate: number | string | null;
  minOrderSize: number | string | null;
  lastSnapshot: {
    bestBid: unknown;
    bestAsk: unknown;
    mid: unknown;
    spread: number | string | null;
    capturedAt: string;
    bookTop3: { bids?: StoredBookLevel[]; asks?: StoredBookLevel[] } | null;
  } | null;
}

export interface StoredEdgeEval {
  bucketIdx: number;
  hour: string;
  q: number | string | null;
  execAsk: number | string | null;
  edge: number | string | null;
  minEdge: number | string | null;
  pass: boolean;
  reasons: string[];
}

export interface EventDetailForEdges {
  event: { unit: string };
  ladder: LadderRowPayload[] | null;
  houseDist: { probs: unknown[] } | null;
  edgeEvaluations: StoredEdgeEval[] | null;
}

/** numeric(8,6) round-trips move a stored value by ≤5e-7. */
export const NUMERIC_TOL = 1.0e-6;

const n = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

function toBook(l: LadderRowPayload): NormalizedBook | null {
  const b = l.lastSnapshot?.bookTop3;
  if (!b || !Array.isArray(b.asks) || b.asks.length === 0) return null;
  const level = (lv: StoredBookLevel): { price: number; size: number } => ({
    price: Number(lv.price),
    size: Number(lv.size),
  });
  return {
    // Only asks/bids feed computeBucketEdges — identity fields are display stubs.
    market: '', assetId: '', timestamp: 0, hash: '',
    bids: (Array.isArray(b.bids) ? b.bids : []).map(level),
    asks: b.asks.map(level),
    minOrderSize: n(l.minOrderSize) ?? 5,
    tickSize: 0.01,
    negRisk: true,
    lastTradePrice: null,
  };
}

/**
 * Re-run computeBucketEdges over the loaded event payload — the EdgeConfig
 * mirrors poll-markets §6.17 step 4 verbatim (per-market feeRate comes from
 * the ladder row; cfg.feeRate is the same 0.05 placeholder the engine passes,
 * overridden per market inside computeBucketEdges).
 */
export function recomputeEdgeRows(detail: EventDetailForEdges, cfg: AppConfig): EdgeRow[] | null {
  if (!detail.houseDist || !detail.ladder || detail.ladder.length === 0) return null;
  const q = detail.houseDist.probs.map(Number);
  const unit = detail.event.unit as Unit;
  const ladder: BucketDef[] = detail.ladder.map((l) => ({ low: n(l.low), high: n(l.high), unit }));
  const books = detail.ladder.map(toBook);
  const marketRows = detail.ladder.map((l) => ({
    feeRate: n(l.feeRate) ?? 0.05,
    spread: l.lastSnapshot ? n(l.lastSnapshot.spread) : null,
  }));
  const edgeCfg = {
    uncertaintyMargin: cfg.uncertaintyMargin,
    spreadBufferMin: cfg.spreadBufferMin,
    feeRate: 0.05,
    probeStakeUsd: cfg.probeStakeUsd,
    maxSpread: cfg.maxSpread,
    minEventVolumeUsd: cfg.minEventVolumeUsd,
    minHoursBeforeClose: cfg.minHoursBeforeClose,
  };
  return computeBucketEdges(q, ladder, books, marketRows, edgeCfg);
}

/** The latest captured hour's stored rows, keyed by bucket_idx. */
export function latestEdgeEvalRows(evals: StoredEdgeEval[] | null): Map<number, StoredEdgeEval> {
  const out = new Map<number, StoredEdgeEval>();
  if (!evals || evals.length === 0) return out;
  const latest = evals.reduce((max, e) => (e.hour > max ? e.hour : max), evals[0]!.hour);
  for (const e of evals) {
    if (e.hour === latest) out.set(e.bucketIdx, e);
  }
  return out;
}

export interface EdgeComparisonRow {
  bucketIdx: number;
  label: string;
  stored: StoredEdgeEval | null;
  recomputed: EdgeRow | null;
  /** Both sides produced full numeric rows without asymmetric depth truncation. */
  comparable: boolean;
  /** Field names disagreeing beyond NUMERIC_TOL — non-empty means drift. */
  drift: string[];
}

export interface EdgeComparison {
  rows: EdgeComparisonRow[];
  comparedCount: number;
  driftCount: number;
}

const COMPARED_FIELDS = ['q', 'execAsk', 'edge', 'minEdge'] as const;

export function compareEdgeRows(
  detail: EventDetailForEdges,
  recomputed: EdgeRow[] | null,
): EdgeComparison {
  const stored = latestEdgeEvalRows(detail.edgeEvaluations);
  const rows: EdgeComparisonRow[] = (detail.ladder ?? []).map((l) => {
    const s = stored.get(l.idx) ?? null;
    const r = recomputed?.[l.idx] ?? null;
    const sExec = s ? n(s.execAsk) : null;
    let comparable = s !== null && r !== null && sExec !== null && r.execAsk !== null;
    if (comparable) {
      const sTrunc = s!.reasons.includes('insufficient_depth');
      const rTrunc = r!.reasons.includes('insufficient_depth');
      if (sTrunc !== rTrunc) comparable = false; // top-3 storage truncation, not drift
    }
    const drift = comparable
      ? COMPARED_FIELDS.filter((f) => {
          const sv = n(s![f]);
          const rv = r![f];
          if (sv === null || rv === null) return sv !== rv;
          return Math.abs(sv - rv) > NUMERIC_TOL;
        })
      : [];
    return { bucketIdx: l.idx, label: l.label, stored: s, recomputed: r, comparable, drift };
  });
  return {
    rows,
    comparedCount: rows.filter((r) => r.comparable).length,
    driftCount: rows.filter((r) => r.drift.length > 0).length,
  };
}
