/**
 * reward-snapshot — the REC-8/9 Phase A liquidity-reward time-series tick, ported off the local Windows
 * logger (scripts/reward-snapshot.ts) to a Supabase Edge Function + pg_cron (the replica-forward twin).
 * REWARD-FARMING-HANDOFF §11.
 *
 * One idempotent run: pull the live CLOB funded-reward universe + books, reduce each funded weather market
 * to its near-mid depth, and bulk-insert the capture into market_rewards. The competition denominator
 * (§0.2 — the load-bearing weakness of the first-pass PASS) becomes TIME-INTEGRATED as captures accumulate.
 *   FETCH   — paginate /sampling-markets (the funded pool) + batch POST /books for the YES tokens (public,
 *             keyless; via the injected fetchJson). Reuses the core detectors (isWeatherMarket/isFunded/
 *             fundedDailyRate) and the shared reducer (reduceBookDepth) — ONE depth definition with the local logger.
 *   PERSIST — record_reward_snapshots(p_rows) inserts the capture (append-only series; distinct captured_at/run).
 *
 * NOT trading — analytics data capture only; no `packages/trading`, no orders, rail DORMANT. Best-effort: a
 * Polymarket outage just yields a smaller/empty capture (logged), never a failed job. Schedule: every 20 min.
 */
import {
  fundedDailyRate,
  isFunded,
  isWeatherMarket,
  type RawSamplingMarket,
  reduceBookDepth,
} from '../../../packages/core/src/index.ts';
import type { FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const CLOB_BASE = 'https://clob.polymarket.com';
const END_CURSOR = 'LTE=';

export interface RewardSnapshotDeps {
  now: Date;
  fetchJson: FetchJsonLike;
}

/** Runtime-richer sampling market (the core type omits tokens; the live payload carries them). */
interface SamplingMarketFull extends RawSamplingMarket {
  tokens?: { token_id?: string; outcome?: string }[];
}
interface SamplingPage {
  data?: SamplingMarketFull[];
  next_cursor?: string;
}
interface RawBook {
  asset_id?: string;
  bids?: { price?: unknown; size?: unknown }[];
  asks?: { price?: unknown; size?: unknown }[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const yesTokenId = (m: SamplingMarketFull): string | null => {
  const toks = Array.isArray(m.tokens) ? m.tokens : [];
  const yes = toks.find((t) => /yes/i.test(t?.outcome ?? '')) ?? toks[0];
  return typeof yes?.token_id === 'string' && yes.token_id.length > 0 ? yes.token_id : null;
};

/** Page through /sampling-markets (cursor-based) collecting the funded weather markets with a real pool. */
async function fetchFundedWeather(
  fetchJson: FetchJsonLike,
  minPool: number,
  maxPages: number,
  log: (m: string, e?: Record<string, unknown>) => void,
): Promise<SamplingMarketFull[]> {
  const out: SamplingMarketFull[] = [];
  let cursor = '';
  const seen = new Set<string>();
  for (let pages = 0; pages < maxPages; pages++) {
    const url = `${CLOB_BASE}/sampling-markets${cursor ? `?next_cursor=${encodeURIComponent(cursor)}` : ''}`;
    let page: SamplingPage;
    try {
      page = (await fetchJson(url, undefined, { timeoutMs: 8000, retries: 1 })) as SamplingPage;
    } catch (e) {
      log('sampling-markets page failed (non-fatal — capture what we have)', { error: msg(e) });
      break;
    }
    const data = Array.isArray(page.data) ? page.data : [];
    for (const m of data) {
      if (isWeatherMarket(m) && isFunded(m) && fundedDailyRate(m) >= minPool) out.push(m);
    }
    const next = page.next_cursor ?? '';
    if (data.length === 0 || next === '' || next === END_CURSOR || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return out;
}

/** POST /books in chunks of ≤50 token_ids (the batch endpoint, well inside the 50/10s budget). */
async function fetchBooks(
  fetchJson: FetchJsonLike,
  tokenIds: string[],
  log: (m: string, e?: Record<string, unknown>) => void,
): Promise<Map<string, RawBook>> {
  const out = new Map<string, RawBook>();
  const CHUNK = 50;
  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    const chunk = tokenIds.slice(i, i + CHUNK);
    try {
      const res = (await fetchJson(
        `${CLOB_BASE}/books`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(chunk.map((token_id) => ({ token_id }))),
        },
        { timeoutMs: 8000, retries: 1 },
      )) as RawBook[];
      for (const b of Array.isArray(res) ? res : []) {
        if (typeof b?.asset_id === 'string') out.set(b.asset_id, b);
      }
    } catch (e) {
      log('books chunk failed (non-fatal)', { error: msg(e), chunk: chunk.length });
    }
  }
  return out;
}

export async function rewardSnapshot(ctx: JobCtx, deps: RewardSnapshotDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const minPool = 1; // skip the $0.001 dust; capture every market that can actually pay
  const capturedUtc = deps.now.toISOString();

  const funded = await fetchFundedWeather(deps.fetchJson, minPool, 60, log);
  const withTok = funded
    .map((m) => ({ m, tid: yesTokenId(m) }))
    .filter((x): x is { m: SamplingMarketFull; tid: string } => x.tid != null);
  const books = await fetchBooks(deps.fetchJson, withTok.map((x) => x.tid), log);

  const rows: Record<string, unknown>[] = [];
  for (const { m, tid } of withTok) {
    const book = books.get(tid);
    if (!book) continue;
    const maxSpreadCents = Number.isFinite(m.rewards?.max_spread) ? m.rewards!.max_spread! : 4.5;
    const d = reduceBookDepth(book.bids, book.asks, maxSpreadCents);
    rows.push({
      capturedUtc,
      conditionId: typeof m.condition_id === 'string' ? m.condition_id : tid,
      slug: typeof m.market_slug === 'string' ? m.market_slug : (m.question ?? ''),
      dailyPoolUsd: fundedDailyRate(m),
      minSize: Number.isFinite(m.rewards?.min_size) ? m.rewards!.min_size! : 50,
      maxSpreadCents,
      mid: d.mid,
      bestBid: d.bestBid,
      bestAsk: d.bestAsk,
      bidDepthShares: d.bidDepthShares,
      askDepthShares: d.askDepthShares,
      bidDepthUsd: d.bidDepthUsd,
      askDepthUsd: d.askDepthUsd,
    });
  }

  let inserted = 0;
  if (rows.length > 0) {
    const res = await db.rpc<{ record_reward_snapshots: number }>('record_reward_snapshots', { p_rows: rows });
    inserted = Number(res[0]?.record_reward_snapshots ?? rows.length);
  }

  const poolUsd = rows.reduce((a, r) => a + (Number(r.dailyPoolUsd) || 0), 0);
  const inBandUsd = rows.reduce((a, r) => a + (Number(r.bidDepthUsd) || 0) + (Number(r.askDepthUsd) || 0), 0);
  const stats = {
    asOf: capturedUtc,
    funded: funded.length,
    books: books.size,
    inserted,
    poolUsd: Math.round(poolUsd),
    inBandUsd: Math.round(inBandUsd),
  };
  log('reward-snapshot complete', stats);
  return stats;
}
