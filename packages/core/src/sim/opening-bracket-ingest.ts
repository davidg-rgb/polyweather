/**
 * core/sim/opening-bracket-ingest — the PURE raw→core mappers for the opening-convergence capture series.
 *
 * Shared by BOTH the research harness (scripts/research/opening-bracket-score.ts) and the dashboard loader
 * (apps/web — the /convergence overview), so the row shapes + the FRESH-universe grouping live in ONE tested
 * place and cannot drift between the two consumers (the RPC payload shape == the script's loadEvents shape).
 *
 * `RawCaptureRow` is the `opening_captures` row as the camelCase jsonb the harness query / the dash_convergence
 * RPC both emit (`tzName`, not `tz`); `RawBucket` mirrors a `buckets` jsonb element. mapBucket maps one bucket
 * to the core OpeningBucket (preserving nulls vs flooring to 0 per field), and buildEvents groups the flat
 * per-tick rows into per-event replay inputs — DB-free, so the grouping + the FRESH filter (min
 * hours_since_listing < 1) stay unit-testable with no network. Pure + total (junk → []/0/'' , never throws).
 */
import type { OpeningBucket } from './opening-convergence.ts';
import type { EventReplayInput, ReplayTick } from './opening-bracket-replay.ts';

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const num0 = (v: unknown): number => (fin(v) ? Number(v) : 0);
const numOrNull = (v: unknown): number | null => (fin(v) ? Number(v) : null);
const tms = (iso: unknown): number => new Date(String(iso)).getTime();

/** One bucket inside a capture row's `buckets` jsonb (same shape as core's OpeningBucket). */
export interface RawBucket {
  idx: number;
  label: string | null;
  loF: number | null;
  hiF: number | null;
  mid: number | null;
  bestAsk: number | null;
  execAsk: number | null;
  depthUsd: number | null;
  bestBid: number | null;
  sellbackUsd: number | null;
  execBid: number | null;
  sellbackDepthUsd: number | null;
  houseProb: number | null;
  tokenYes: string | null;
  tokenNo: string | null;
  conditionId: string | null;
}

/** One `opening_captures` row as the harness query / dash_convergence RPC return it (`tzName`, not `tz`). */
export interface RawCaptureRow {
  eventId: string | null;
  capturedAt: string;
  city: string | null;
  targetDate: string | null;
  tzName: string | null;
  createdAtGamma: string | null;
  resolvesAt: string | null;
  hoursSinceListing: number | null;
  peakMid: number | null;
  isFlatOpen: boolean | null;
  houseSeeded: boolean | null;
  buckets: RawBucket[] | null;
  evVol24h: number | null;
  negRisk: boolean | null;
}

/** The per-event resolution (poly_resolved_winner_idx ?? winning_bucket_idx + the grading_mismatch flag). */
export interface Resolution {
  winnerIdx: number | null;
  gradingMismatch: boolean;
}

/** Map one raw `buckets` jsonb element → the core OpeningBucket (null-preserving per field). */
export function mapBucket(b: RawBucket): OpeningBucket {
  return {
    idx: num0(b.idx),
    label: String(b.label ?? ''),
    loF: numOrNull(b.loF),
    hiF: numOrNull(b.hiF),
    mid: numOrNull(b.mid),
    bestAsk: numOrNull(b.bestAsk),
    execAsk: numOrNull(b.execAsk),
    depthUsd: num0(b.depthUsd),
    bestBid: numOrNull(b.bestBid),
    sellbackUsd: num0(b.sellbackUsd),
    execBid: numOrNull(b.execBid),
    sellbackDepthUsd: num0(b.sellbackDepthUsd),
    houseProb: numOrNull(b.houseProb),
    tokenYes: String(b.tokenYes ?? ''),
    tokenNo: String(b.tokenNo ?? ''),
    conditionId: String(b.conditionId ?? ''),
  };
}

/**
 * Group the flat per-tick rows into one EventReplayInput per event — pure + total (DB-free, so the grouping +
 * the FRESH-universe filter are unit-testable). Each event keeps its captures ordered ASC by capturedAt; the
 * FRESH filter (min hours_since_listing < 1) mirrors the capture/spike/resolution-scorer universe; a missing
 * resolution maps to { winnerIdx: null, gradingMismatch: false } (unresolved → the engine marks to last bid).
 */
export function buildEvents(rows: RawCaptureRow[], resMap: Map<string, Resolution>): EventReplayInput[] {
  const byEvent = new Map<string, RawCaptureRow[]>();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r?.eventId == null) continue;
    const arr = byEvent.get(r.eventId) ?? [];
    arr.push(r);
    byEvent.set(r.eventId, arr);
  }
  const out: EventReplayInput[] = [];
  for (const [eventId, rs] of byEvent) {
    const ages = rs.map((x) => x.hoursSinceListing).filter((v): v is number => v != null && Number.isFinite(v));
    // FRESH universe only (min hours_since_listing < 1). Safe under the dashboard RPC's downsample:
    // hours_since_listing is monotone in captured_at (stable createdAtGamma), so the series min sits at the
    // earliest tick (rn=1), which the 0069 `rn % 3 = 1` stride always retains — this re-check sees the same min
    // the SQL `having min(...) < 1` did, so it can only DROP a SQL-fresh event (never false-include). The
    // authoritative scorer's loader does NOT downsample, so there the SQL/TS universes are byte-identical.
    if (!(ages.length > 0 && Math.min(...ages) < 1)) continue;
    const sorted = [...rs].sort((a, b) => tms(a.capturedAt) - tms(b.capturedAt));
    const meta = sorted[0]!;
    const ticks: ReplayTick[] = sorted.map((r) => ({
      capturedAt: String(r.capturedAt),
      buckets: Array.isArray(r.buckets) ? r.buckets.map(mapBucket) : [],
      tz: String(r.tzName ?? ''),
      targetDate: String(r.targetDate ?? ''),
      // hoursSinceListing must stay NaN (not 0) when absent — selectEntries' fin() gate then refuses entry.
      hoursSinceListing: r.hoursSinceListing == null ? NaN : num0(r.hoursSinceListing),
    }));
    out.push({
      eventId,
      city: String(meta.city ?? ''),
      targetDate: String(meta.targetDate ?? ''),
      tz: String(meta.tzName ?? ''),
      ticks,
      resolution: resMap.get(eventId) ?? { winnerIdx: null, gradingMismatch: false },
    });
  }
  return out;
}
