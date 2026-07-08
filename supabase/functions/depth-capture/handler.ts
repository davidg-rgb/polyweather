/**
 * depth-capture — the KEYLESS continuous executable-depth layer for the repointed Google forward-paper panel
 * (v2 redesign, DEPTH-CAPTURE-V2-HANDOFF.md; migration 0089's `market_depth`).
 *
 * poll-markets only walks BOOK DEPTH for the ≤15 edge-CANDIDATE buckets per cycle, so the cheap longshot buckets
 * the /convergence GOOGLE panel buys carry only TOP-OF-BOOK in market_snapshots. This tick (every 5 min) walks the
 * TRUE CLOB depth of the near-dated live 'highest' buckets discover/poll already ingested (bucket_id guaranteed —
 * no Gamma re-poll, no parse risk) and writes the COMPUTED depth into the dedicated `market_depth` table — NOT into
 * shared market_snapshots (v1's finding C-bloat + G-shadowing) — powering google_paper_inputs (0088) WITHOUT
 * touching the poll-markets consensus→edges→recommendations money engine.
 *
 * v2 defenses vs the v1 build (all live-confirmed / review-found):
 *   - DEDICATED TABLE (§4.1) — no shared-table pollution, no dashboard shadowing.
 *   - DELTA-DEDUPE + HEARTBEAT write gate (§4.2 / finding C) — write only on a meaningful exec move or a heartbeat.
 *   - TWO-SIDED gate (§4.5 / finding E) — an asks-only book gets no row (no exit-less entry).
 *   - GOOGLE_DEFAULTS walk size (§4.7 / finding H) — walk at the size the panel actually replays at, not the bot stake.
 *   - WALL-CLOCK BUDGET + INCREMENTAL CHUNKED FLUSH + honest stats + throw-on-total-write-failure (§4.6 / findings B/D):
 *     a slow/rate-limited tick persists partial depth and never silently reports ok on a swallowed write error; the
 *     depth-staleness deadman (0089) is the secondary net.
 *   - CAP logging (§4.2 / finding C) — surface when market_depth_targets truncated (near-resolution buckets dropped).
 *
 * Read-only against Polymarket; no key, no packages/trading, rail-DORMANT-safe. Best-effort on FETCH (an unfetchable
 * book is skipped this tick and re-walked next — a fetch failure never fails the tick). But a WRITE error DOES fail
 * the tick (finding B): the chunks that already succeeded stay flushed, and the failure surfaces via runJob + the
 * depth deadman rather than a silent ok — a partial write failure is still a swallowed error.
 */
import {
  normalizeBook,
  type RawClobBook,
} from '../../../packages/core/src/index.ts';
import { GOOGLE_DEFAULTS } from '../../../packages/core/src/sim/google-bucket-replay.ts';
import { computeDepth, shouldWrite, type DepthRow } from './pure.ts';
import type { FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const CLOB = 'https://clob.polymarket.com';
const HEADERS: Record<string, string> = {
  'User-Agent': 'weather-edge/0.1 (depth-capture)',
  Accept: 'application/json',
};
const MAX_LEAD_DAYS = 2;      // near-dated: the fresh-open window + the still-resolving trajectory
const TARGET_LIMIT = 800;     // safety cap on buckets walked per tick (~45 events × ~7 buckets ≈ 315 typical)
const WALK_CONCURRENCY = 8;   // F16 burst bound — at most this many CLOB /book fetches in flight
// per-invocation wall-clock budget (§4.6 / finding D — mirror google-paper-panel's 270s). Checked per walk chunk;
// once exceeded, the walk stops and the tick persists whatever it has flushed (partial depth, never a lost tick).
const WALK_TIME_BUDGET_MS = 270_000;
const WALK_CHUNK = 60;        // targets per walk+flush cycle — the budget granularity + the incremental-flush unit
const WRITE_CHUNK = 200;      // max rows per record_market_depth statement (kills v1's single 800-row write timeout)
const DEPTH_DELTA = 0.005;    // min exec_ask/exec_bid move to write (else deduped) — mirrors poll-markets DELTA_MID
const HEARTBEAT_MS = 30 * 60_000; // write an unchanged bucket at least this often — mirrors poll-markets candidate heartbeat
// walk size = the size the panel actually replays at (finding H), NOT the bot's per-position stake.
const PER_POSITION_USD = GOOGLE_DEFAULTS.perPositionUsd;

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface DepthCaptureDeps {
  now: Date;
  fetchJson: FetchJsonLike;
  /** monotonic wall-clock for the time budget (production: Date.now; tests inject a deterministic clock). */
  clock?: () => number;
}

/** One near-dated live bucket to walk (from market_depth_targets), carrying its last depth row for the delta gate. */
interface DepthTarget {
  bucket_id: string;
  token_yes: string;
  event_id: string;
  city_slug: string;
  target_date: string;
  first_seen: string | null;
  /** the bucket's most-recent market_depth row (null on first observation) — the delta/heartbeat gate reads these. */
  last_exec_ask: number | null;
  last_exec_bid: number | null;
  last_captured_at: string | null;
  /** the PRE-CAP candidate count (count(*) over () — same on every row) so a p_limit truncation is observable. */
  total_candidates: number | null;
}

/** Bounded-concurrency async map (F16 burst bound) — at most `limit` thunks in flight. Kept local so this
 *  money-path-independent job imports nothing from opening-capture. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Fetch + normalize one YES token's CLOB /book; null on a failed/absent book (best-effort skip). */
async function fetchBook(fetchJson: FetchJsonLike, token: string): Promise<ReturnType<typeof normalizeBook> | null> {
  try {
    return normalizeBook(
      (await fetchJson(`${CLOB}/book?token_id=${token}`, { headers: HEADERS } as RequestInit, {
        timeoutMs: 6000,
        retries: 1,
      })) as RawClobBook,
    );
  } catch {
    return null; // unfetchable book ⇒ skip this bucket this tick (best-effort, the series continues)
  }
}

type WalkResult =
  | { kind: 'skip' }        // unfetchable book — not counted as fetched
  | { kind: 'oneSided' }    // fetched but no two-sided quote (§4.5) — no row
  | { kind: 'deduped' }     // two-sided but unchanged within heartbeat (§4.2) — no row
  | { kind: 'row'; row: DepthRow };

export async function depthCapture(ctx: JobCtx, deps: DepthCaptureDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const { now, fetchJson } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const capturedAt = now.toISOString();
  const nowMs = now.getTime();
  const startMs = clock();

  // the near-dated live buckets to walk + each one's last depth row for the delta gate (DB-read seam — bucket_id
  // guaranteed, no Gamma re-poll).
  let targets: DepthTarget[] = [];
  try {
    targets = await db.rpc<DepthTarget>('market_depth_targets', { p_max_lead: MAX_LEAD_DAYS, p_limit: TARGET_LIMIT });
  } catch (e) {
    log('market_depth_targets failed (non-fatal — empty tick)', { error: msg(e) });
  }

  // finding C: surface truncation. total_candidates is the pre-LIMIT count (window count over ()); when it exceeds
  // the returned rows, market_depth_targets dropped the oldest-first_seen (near-resolution) buckets this tick.
  const totalCandidates = targets.length > 0 ? Number(targets[0]!.total_candidates ?? targets.length) : 0;
  const capped = totalCandidates > targets.length;
  if (capped) {
    log('market_depth_targets CAPPED — near-resolution buckets dropped this tick', {
      returned: targets.length,
      totalCandidates,
      cap: TARGET_LIMIT,
    });
  }

  let fetched = 0;
  let oneSided = 0;
  let deduped = 0;
  let written = 0;
  let inserted = 0;
  let writeErrors = 0;
  let writeCalls = 0;
  let budgetHit = false;

  // incremental flush (§4.6): write each chunk's rows as it completes, in ≤WRITE_CHUNK batches, so a walk cut
  // short by the budget or a killed isolate still persists the depth it already gathered.
  const flush = async (rows: DepthRow[]): Promise<void> => {
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      const chunk = rows.slice(i, i + WRITE_CHUNK);
      writeCalls++;
      try {
        const res = await db.rpc<{ record_market_depth: number }>('record_market_depth', {
          p_rows: chunk,
          p_captured_at: capturedAt,
        });
        inserted += Number(res[0]?.record_market_depth ?? 0);
      } catch (e) {
        writeErrors++;
        log('record_market_depth failed (LOUD — depth may stall; the deadman backstops)', {
          error: msg(e),
          chunk: chunk.length,
        });
      }
    }
  };

  for (let off = 0; off < targets.length; off += WALK_CHUNK) {
    if (clock() - startMs > WALK_TIME_BUDGET_MS) {
      budgetHit = true;
      log('walk time budget exhausted — partial tick (flushed depth persists)', {
        walkedTargets: off,
        totalTargets: targets.length,
        budgetMs: WALK_TIME_BUDGET_MS,
      });
      break;
    }
    const slice = targets.slice(off, off + WALK_CHUNK);
    const results = await mapLimit(slice, WALK_CONCURRENCY, async (t): Promise<WalkResult> => {
      const book = await fetchBook(fetchJson, t.token_yes);
      if (book == null) return { kind: 'skip' };
      const d = computeDepth(book, PER_POSITION_USD);
      if (d == null) return { kind: 'oneSided' }; // §4.5 — asks-only / one-sided / empty book → no row
      const row: DepthRow = { bucket_id: t.bucket_id, ...d };
      if (
        !shouldWrite(
          row,
          { exec_ask: t.last_exec_ask, exec_bid: t.last_exec_bid, captured_at: t.last_captured_at },
          nowMs,
          DEPTH_DELTA,
          HEARTBEAT_MS,
        )
      ) {
        return { kind: 'deduped' }; // §4.2 — unchanged within heartbeat
      }
      return { kind: 'row', row };
    });

    const toWrite: DepthRow[] = [];
    for (const r of results) {
      if (r.kind === 'skip') continue;
      fetched++;
      if (r.kind === 'oneSided') oneSided++;
      else if (r.kind === 'deduped') deduped++;
      else toWrite.push(r.row);
    }
    written += toWrite.length;
    await flush(toWrite);
  }

  // finding B (extended, review R1-F5): NEVER report ok on ANY swallowed write error — TOTAL or PARTIAL. Every
  // chunk that already succeeded was flushed incrementally, so the partial depth persists; but a chunk that FAILED
  // (e.g. the tail near-resolution chunks timing out under Micro saturation while the fresh chunks land) must fail
  // the tick — else runJob records ok, the deadman sees a fresh whole-table max(captured_at) from the successful
  // chunks, and the stall is invisible. Throw → runJob marks the tick failed + pages; the next tick re-walks
  // (freshest-first) and re-attempts the stalled buckets (their heartbeat also forces a re-write).
  if (writeErrors > 0) {
    throw new Error(
      `record_market_depth failed on ${writeErrors} of ${writeCalls} chunk(s) — wrote ${inserted} of ${written} rows; depth layer degraded`,
    );
  }

  const stats: JobStats = {
    asOf: capturedAt,
    targets: targets.length,
    totalCandidates,
    capped,
    fetched,
    oneSided,
    deduped,
    written,
    inserted,
    writeErrors,
    budgetHit,
    perPositionUsd: PER_POSITION_USD,
    events: new Set(targets.map((t) => t.event_id)).size,
    cities: new Set(targets.map((t) => t.city_slug)).size,
  };
  log('depth-capture complete', stats);
  return stats;
}
