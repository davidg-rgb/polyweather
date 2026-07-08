/**
 * depth-capture — the KEYLESS continuous executable-depth layer for market_snapshots (migration 0087).
 *
 * The money-path-SAFE isolation of what poll-markets deliberately won't do: poll-markets only walks BOOK DEPTH
 * for the ≤15 edge-CANDIDATE buckets per cycle, so the cheap longshot buckets the /convergence GOOGLE panel buys
 * carry only TOP-OF-BOOK in market_snapshots. This tick (every 5 min) walks the TRUE CLOB depth of the near-dated
 * live 'highest' buckets discover/poll already ingested (bucket_id guaranteed — no Gamma re-poll, no parse risk)
 * and writes the COMPUTED depth {execAsk, execBid, depthUsd, sellbackDepthUsd, bestBid, sellbackUsd} into the new
 * market_snapshots.depth jsonb — powering the repointed google_paper_inputs WITHOUT touching the poll-markets
 * consensus→edges→recommendations money engine.
 *
 * Read-only against Polymarket; no key, no packages/trading, rail-DORMANT-safe. Best-effort: an unfetchable book
 * → that bucket is skipped this tick (it re-walks on the next), NEVER fails the job. Bounded concurrency keeps the
 * external-fetch burst small; the single bulk write is the only DB touch (Micro-safe).
 */
import {
  executableAsk,
  executableBid,
  normalizeBook,
  type RawClobBook,
} from '../../../packages/core/src/index.ts';
import { parseBotConfig, type BotConfig } from '../../../packages/core/src/sim/opening-convergence.ts';
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

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface DepthCaptureDeps {
  now: Date;
  fetchJson: FetchJsonLike;
}

/** One near-dated live bucket to walk (from depth_capture_targets). */
interface DepthTarget {
  bucket_id: string;
  token_yes: string;
  event_id: string;
  city_slug: string;
  target_date: string;
  first_seen: string | null;
}

/** One assembled market_snapshots row carrying computed depth (consumed by record_depth_captures). */
interface DepthRow {
  bucket_id: string;
  best_bid: number | null;
  best_ask: number | null;
  mid: number | null;
  spread: number | null;
  depth: {
    execAsk: number | null;
    execBid: number | null;
    depthUsd: number;
    sellbackDepthUsd: number;
    bestBid: number | null;
    sellbackUsd: number;
  };
}

/** Bounded-concurrency async map (F16 burst bound) — at most `limit` thunks in flight. Copied from
 *  opening-capture/handler.ts (kept local so this money-path-independent job imports nothing from it). */
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

/**
 * Walk the TRUE CLOB /book for one YES token → top-of-book + BOTH sides of the round-trip: BUY {execAsk,
 * depthUsd(+10% band)} and SELL {execBid, sellbackDepthUsd(−10% band)} for the same position size. null on a
 * failed/absent book (best-effort — the bucket re-walks next tick). Mirrors opening-capture's walkBucketDepth,
 * plus the top-of-book (best_ask/mid/spread) the market_snapshots row needs.
 */
async function walkBucketFull(
  fetchJson: FetchJsonLike,
  token: string,
  perPositionUsd: number,
): Promise<Omit<DepthRow, 'bucket_id'> | null> {
  try {
    const book = normalizeBook(
      (await fetchJson(`${CLOB}/book?token_id=${token}`, { headers: HEADERS } as RequestInit, {
        timeoutMs: 6000,
        retries: 1,
      })) as RawClobBook,
    );
    const bestAsk = book.asks[0]?.price ?? null;
    const bestBid = book.bids[0]?.price ?? null;
    const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;

    // BUY side: executable avg ask for $perPositionUsd of shares + buyable $ within +10% of best ask.
    const band = bestAsk != null && bestAsk > 0 ? bestAsk * 1.1 : Number.POSITIVE_INFINITY;
    const depthUsd = book.asks.filter((l) => l.price <= band).reduce((s, l) => s + l.price * l.size, 0);
    const targetShares = bestAsk != null && bestAsk > 0 ? perPositionUsd / bestAsk : 0;
    const exec = targetShares > 0 ? executableAsk(book, targetShares).avgPrice : NaN;
    // SELL side (the round-trip's other half): realizable avg sell of the SAME share count + sellable $ within
    // −10% of best bid (the symmetric mirror of the +10% ask band).
    const execBidRes = targetShares > 0 ? executableBid(book, targetShares) : { avgPrice: NaN, fillableShares: 0 };
    const bidBand = bestBid != null && bestBid > 0 ? bestBid * 0.9 : 0;
    const sellbackDepthUsd = book.bids.filter((l) => l.price >= bidBand).reduce((s, l) => s + l.price * l.size, 0);
    const sellbackUsd = bestBid != null ? bestBid * (book.bids[0]?.size ?? 0) : 0;

    return {
      best_bid: bestBid,
      best_ask: bestAsk,
      mid,
      spread,
      depth: {
        execAsk: Number.isFinite(exec) ? exec : null,
        execBid: Number.isFinite(execBidRes.avgPrice) ? execBidRes.avgPrice : null,
        depthUsd,
        sellbackDepthUsd,
        bestBid,
        sellbackUsd,
      },
    };
  } catch {
    return null; // unfetchable book ⇒ skip this bucket this tick (best-effort, the series continues)
  }
}

export async function depthCapture(ctx: JobCtx, deps: DepthCaptureDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const { now, fetchJson } = deps;
  const capturedAt = now.toISOString();

  // the taker fill size for executableAsk/Bid — the same per-position stake the panel replays on.
  let perPositionUsd = 20;
  try {
    const botCfg: BotConfig = parseBotConfig(await db.getConfigRows());
    if (Number.isFinite(botCfg.perPositionUsd) && botCfg.perPositionUsd > 0) perPositionUsd = botCfg.perPositionUsd;
  } catch (e) {
    log('parseBotConfig failed (non-fatal — default perPositionUsd)', { error: msg(e) });
  }

  // the near-dated live buckets to walk (DB-read seam — bucket_id guaranteed, no Gamma re-poll).
  let targets: DepthTarget[] = [];
  try {
    targets = await db.rpc<DepthTarget>('depth_capture_targets', { p_max_lead: MAX_LEAD_DAYS, p_limit: TARGET_LIMIT });
  } catch (e) {
    log('depth_capture_targets failed (non-fatal — empty tick)', { error: msg(e) });
  }

  const walked = await mapLimit(targets, WALK_CONCURRENCY, async (t) => {
    const d = await walkBucketFull(fetchJson, t.token_yes, perPositionUsd);
    return d ? ({ bucket_id: t.bucket_id, ...d } as DepthRow) : null;
  });
  const rows = walked.filter((r): r is DepthRow => r !== null);

  let inserted = 0;
  if (rows.length > 0) {
    try {
      const res = await db.rpc<{ record_depth_captures: number }>('record_depth_captures', {
        p_rows: rows,
        p_captured_at: capturedAt,
      });
      inserted = Number(res[0]?.record_depth_captures ?? rows.length);
    } catch (e) {
      log('record_depth_captures failed (non-fatal)', { error: msg(e) });
    }
  }

  const stats: JobStats = {
    asOf: capturedAt,
    targets: targets.length,
    walked: rows.length,
    events: new Set(targets.map((t) => t.event_id)).size,
    cities: new Set(targets.map((t) => t.city_slug)).size,
    perPositionUsd,
    inserted,
  };
  log('depth-capture complete', stats);
  return stats;
}
