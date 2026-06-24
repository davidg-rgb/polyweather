/**
 * replica-forward — the daily badatmath-replica forward paper-trade tick, ported off the local Windows
 * Scheduled Task to a Supabase Edge Function + pg_cron (the amsterdam-paper-trade twin). REPLICA-CLOUD-PORT.md.
 *
 * One idempotent run, mirroring scripts/research/badatmath-replica-forward.ts but with the DB as the source of
 * truth (the local .md/.csv/state.json artifacts are redundant — /replica renders from Postgres):
 *   LOAD       — replica_forward_inputs reconstructs the run/open/resolutions/book/candidates the engine needs
 *                (the RPC-only replacement for the script's raw-SQL reads — the Edge port is RPC-only).
 *   RECONCILE  — reconcilePure (core) closes resolved open positions: DB winning_bucket_idx primary, a Gamma
 *                Yes/No overlay (fetched here via the injected fetchJson) for events our DB hasn't resolved yet,
 *                then replays the post-entry book for the §12 maker-realistic fill.
 *   PLACE      — placeBuysPure (core) opens today's live buys from the candidate set (§15 playbook, deduped).
 *   PERSIST    — UPSERT-ONLY (p_replace=false): send ONLY the changed rows (newly-closed + newly-opened) to
 *                replica_record_positions; the natural-key upsert flips closed + inserts opened without loading
 *                closed history. Then replica_record_run records the run counts.
 *
 * NOT trading — the live rail stays DORMANT (CLAUDE.md / FINDINGS.md). Best-effort: a Gamma outage just leaves
 * a position open for the next tick. (The no-inputs early-return is defensive only — replica_forward_inputs
 * always returns a non-null object; a missing/erroring RPC throws in supabasePort before we reach it.)
 * Schedule: 05:00 UTC = 07:00 local.
 */
import {
  type BucketSnapshot,
  DEFAULT_REPLICA_STRATEGY,
  type ForwardPosition,
  localDayWindow,
  placeBuysPure,
  reconcilePure,
  type ReplicaCandidate,
  type ReplicaStrategy,
} from '../../../packages/core/src/index.ts';
import { fetchGammaWinners, type FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

export interface ReplicaForwardDeps {
  now: Date;
  /**
   * Injected JSON fetcher (packages/io fetchJson) — used to widen reconcile coverage via Polymarket Gamma for
   * positions our DB hasn't resolved. Optional: omit it (e.g. in tests) to skip Gamma; DB-resolved positions
   * still close from the inputs RPC's `resolutions` map.
   */
  fetchJson?: FetchJsonLike;
}

// --- the replica_forward_inputs payload shape (migration 0056) ---------------------------------------------
interface InputCandidateBucket {
  bucketIdx: number;
  low: number | null;
  high: number | null;
  tickSize: number | null;
  feeRate: number | null;
  conditionId: string | null;
  snapshots: { capturedAt: number; bid: number | null; ask: number | null; mid: number | null }[];
}
interface InputCandidateEvent {
  eventId: string;
  citySlug: string;
  region: string;
  tz: string;
  unit: 'C' | 'F';
  targetDate: string;
  winningBucketIdx: number | null;
  buckets: InputCandidateBucket[];
}
interface ReplicaForwardInputs {
  run: { whitelist: string[] | null; strat: Partial<ReplicaStrategy> | null } | null;
  closedCount: number;
  /** All forward placement keys (`eventId|bucketIdx`, open AND resolved) — the open+closed dedup set. */
  placedKeys: string[];
  open: Record<string, unknown>[];
  resolutions: Record<string, number>;
  askSeries: Record<string, { capturedAt: number; bid: number | null; ask: number | null; mid: number | null }[]>;
  candidates: InputCandidateEvent[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isoDayUtc = (unixSec: number): string => new Date(unixSec * 1000).toISOString().slice(0, 10);
const num = (v: unknown): number => Number(v);

/** Human bucket label for the ledger (mirrors the script's bucketLabel). */
function bucketLabel(low: number | null, high: number | null, unit: string): string {
  const u = `°${unit}`;
  if (low == null && high != null) return `≤${high}${u}`;
  if (high == null && low != null) return `≥${low}${u}`;
  if (low != null && high != null) return `${low}–${high}${u}`;
  return 'bucket';
}

/** Reconstruct an open ForwardPosition from its replica_forward_inputs jsonb row. */
function toPosition(r: Record<string, unknown>): ForwardPosition {
  const entryTs = num(r.entryTs);
  return {
    conditionId: typeof r.conditionId === 'string' ? r.conditionId : '',
    eventId: String(r.eventId),
    citySlug: String(r.citySlug),
    region: typeof r.region === 'string' ? r.region : '',
    targetDate: String(r.targetDate),
    bucketIdx: num(r.bucketIdx),
    bucketLabel: typeof r.bucketLabel === 'string' ? r.bucketLabel : '',
    resolutionTs: num(r.resolutionTs),
    entryTs,
    entryDayUtc: String(r.entryDayUtc),
    entryCapturedTs: r.entryCapturedTs == null ? entryTs : num(r.entryCapturedTs),
    makerPrice: num(r.makerPrice),
    takerPrice: num(r.takerPrice),
    stakeUsd: num(r.stakeUsd),
    feeRate: r.feeRate == null ? 0 : num(r.feeRate),
    bucketWon: r.bucketWon == null ? null : Boolean(r.bucketWon),
    makerRealisticFilled: Boolean(r.makerRealisticFilled),
    placedAtUtc: r.placedAtUtc == null ? '' : String(r.placedAtUtc),
    closedAtUtc: r.closedAtUtc == null ? null : String(r.closedAtUtc),
  };
}

const toSnap = (s: { capturedAt: number; bid: number | null; ask: number | null; mid: number | null }): BucketSnapshot => ({
  capturedAt: num(s.capturedAt),
  bid: s.bid == null ? null : num(s.bid),
  ask: s.ask == null ? null : num(s.ask),
  mid: s.mid == null ? null : num(s.mid),
});

/**
 * Flatten the inputs' nested events→buckets→snapshots into the engine's ReplicaCandidate[] (one per
 * event×bucket = buying that bucket's Yes leg). resolutionTs is computed HERE via localDayWindow (tz
 * correctness stays in TS, never SQL — the db1 bug); an unknown tz or a book-less bucket is skipped, exactly
 * like the script's loadCandidates.
 */
function toCandidates(events: InputCandidateEvent[]): ReplicaCandidate[] {
  const out: ReplicaCandidate[] = [];
  for (const ev of events) {
    let resolutionTs: number;
    try {
      resolutionTs = Math.floor(localDayWindow(ev.tz, ev.targetDate).endUtc.getTime() / 1000);
    } catch {
      continue; // unknown tz → skip (rare)
    }
    for (const b of ev.buckets) {
      const snapshots = (b.snapshots ?? []).map(toSnap);
      if (snapshots.length === 0) continue; // no book → can't price an entry
      out.push({
        conditionId: b.conditionId ?? '',
        eventId: ev.eventId,
        citySlug: ev.citySlug,
        region: ev.region,
        targetDate: ev.targetDate,
        bucketIdx: num(b.bucketIdx),
        bucketLabel: bucketLabel(
          b.low == null ? null : num(b.low),
          b.high == null ? null : num(b.high),
          ev.unit,
        ),
        bucketWon: ev.winningBucketIdx == null ? null : num(b.bucketIdx) === ev.winningBucketIdx,
        feeRate: b.feeRate == null ? 0 : num(b.feeRate),
        tickSize: b.tickSize == null ? 0 : num(b.tickSize),
        resolutionTs,
        snapshots,
      });
    }
  }
  return out;
}

/** Map a ForwardPosition → the replica_record_positions jsonb row (camelCase; status from the resolution). */
function toRow(p: ForwardPosition): Record<string, unknown> {
  return {
    conditionId: p.conditionId,
    eventId: p.eventId,
    citySlug: p.citySlug,
    region: p.region,
    targetDate: p.targetDate,
    bucketIdx: p.bucketIdx,
    bucketLabel: p.bucketLabel,
    resolutionTs: p.resolutionTs,
    entryTs: p.entryTs,
    entryDayUtc: p.entryDayUtc,
    entryCapturedTs: p.entryCapturedTs,
    makerPrice: p.makerPrice,
    takerPrice: p.takerPrice,
    stakeUsd: p.stakeUsd,
    feeRate: p.feeRate,
    bucketWon: p.bucketWon,
    makerRealisticFilled: p.makerRealisticFilled,
    status: p.bucketWon == null ? 'open' : 'resolved',
    placedAtUtc: p.placedAtUtc,
    closedAtUtc: p.closedAtUtc,
  };
}

export async function replicaForward(ctx: JobCtx, deps: ReplicaForwardDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const nowSec = Math.floor(deps.now.getTime() / 1000);
  const placeFrom = isoDayUtc(nowSec - 2 * 86_400);
  const placeTo = isoDayUtc(nowSec + 4 * 86_400);

  const inputRows = await db.rpc<{ replica_forward_inputs: ReplicaForwardInputs | null }>(
    'replica_forward_inputs',
    { p_now: nowSec, p_place_from: placeFrom, p_place_to: placeTo },
  );
  const input = inputRows[0]?.replica_forward_inputs ?? null;
  if (!input) {
    log('replica-forward: no inputs payload — clean no-op');
    return { asOf: deps.now.toISOString(), openBefore: 0, reconciled: 0, opened: 0, open: 0, gammaResolved: 0 };
  }

  // --- reconstruct the engine inputs -------------------------------------------------------------
  const strat: ReplicaStrategy = { ...DEFAULT_REPLICA_STRATEGY, ...(input.run?.strat ?? {}) };
  const whitelist = input.run?.whitelist ?? [];
  const open = (input.open ?? []).map(toPosition);
  const dbWinners = new Map<string, number>(
    Object.entries(input.resolutions ?? {}).map(([k, v]) => [k, num(v)]),
  );
  const askSeries = new Map<string, BucketSnapshot[]>(
    Object.entries(input.askSeries ?? {}).map(([k, arr]) => [k, (arr ?? []).map(toSnap)]),
  );

  // --- Gamma fallback for open positions our DB hasn't resolved (timelier + wider coverage) ------
  let gammaWinners = new Map<string, 'Yes' | 'No'>();
  if (deps.fetchJson) {
    const need = open
      .filter((p) => !dbWinners.has(p.eventId) && p.conditionId !== '')
      .map((p) => p.conditionId);
    if (need.length > 0) {
      try {
        gammaWinners = await fetchGammaWinners(deps.fetchJson, [...new Set(need)], { timeoutMs: 8000, retries: 1 });
      } catch (e) {
        log('gamma resolution failed (non-fatal — positions stay open for next tick)', { error: msg(e) });
      }
    }
  }

  // --- RECONCILE + PLACE (pure core, shared with the local task) ---------------------------------
  const { stillOpen, newlyClosed } = reconcilePure(open, { dbWinners, gammaWinners }, askSeries, nowSec);
  const candidates = toCandidates(input.candidates ?? []);
  // Dedupe placements against open AND closed keys (the RPC's placedKeys) — parity with the local script's
  // `[...state.open, ...state.closed]`. Open-only dedup would let a position resolved early via Gamma (DB winner
  // still null, resolutionTs still future → passes the live gate) be re-placed; the closed keys close that hole.
  // (The replica_record_positions upsert also refuses to downgrade a resolved row, as defence-in-depth.)
  const placedKeys = new Set<string>(input.placedKeys ?? open.map((p) => `${p.eventId}|${p.bucketIdx}`));
  const opened = placeBuysPure(candidates, placedKeys, strat, nowSec);

  // --- PERSIST: upsert ONLY the changed rows (newly-closed flip + newly-opened insert) -----------
  const changed = [...newlyClosed, ...opened].map(toRow);
  if (changed.length > 0) {
    await db.rpc('replica_record_positions', { p_source: 'forward', p_replace: false, p_rows: changed });
  }

  const nOpen = stillOpen.length + opened.length;
  const nClosed = num(input.closedCount) + newlyClosed.length;
  await db.rpc('replica_record_run', {
    p_payload: {
      mode: 'forward',
      ranAt: deps.now.toISOString(),
      seedFrom: placeFrom,
      seedTo: placeTo,
      whitelist,
      strat,
      // Funnel counts (nBand/nSelected) aren't surfaced for the forward scope (the /replica loader derives the
      // forward roll-up from the positions themselves); the meaningful run tallies are below.
      nCandidates: candidates.length,
      nBand: 0,
      nSelected: 0,
      nAllocated: opened.length,
      nOpen,
      nClosed,
      nOpened: opened.length,
      nReconciled: newlyClosed.length,
    },
  });

  const stats = {
    asOf: deps.now.toISOString(),
    openBefore: open.length,
    reconciled: newlyClosed.length,
    opened: opened.length,
    open: nOpen,
    gammaResolved: gammaWinners.size,
  };
  log('replica-forward complete', stats);
  return stats;
}
