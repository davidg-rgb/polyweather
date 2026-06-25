/**
 * cross-venue-capture — the forward matched-panel capture for the cross-venue (Kalshi ↔ Polymarket)
 * relative-value measurement (10th-signal candidate, CROSS-VENUE-SPIKE.md, migration 0062).
 *
 * Each tick (every 30 min):
 *   STEP 1 — enumerate all open Polymarket temperature ladders from Gamma (tag 104596), parse, and
 *            keep the near-dated (lead≤2d) "highest" °F events for the 6 cities Kalshi also lists
 *            (NYC, LA, Chicago, Miami, Austin, Denver).
 *   STEP 2 — for each of those cities fetch the Kalshi KXHIGH series once (keyless market data), and
 *            for every matched (city, target_date) build BOTH venues' ladders CONTEMPORANEOUSLY from
 *            top-of-book (Gamma bestBid/Ask + Kalshi yes_bid/ask_dollars).
 *   STEP 3 — run the cross-venue engine (impliedLadder ×2 → divergence + executable basis-adjusted
 *            edge) and capture one row per matched city-day into cross_venue_captures.
 *
 * Read-only against both venues. No orders, no packages/trading. Rail DORMANT. Best-effort: a venue
 * outage on one city yields a smaller panel that tick, never a failed job.
 */
import {
  normalizeBook,
  parseGammaEvent,
  type ParsedEvent,
  type RawClobBook,
  type RawGammaEvent,
} from '../../../packages/core/src/index.ts';
import {
  MIN_EXEC_SIZE,
  bindingExecutable,
  type CrossVenueEdge,
} from '../../../packages/core/src/sim/cross-venue-arb.ts';
import { parseKalshiOrderbook, type KalshiBin } from '../../../packages/core/src/kalshi/markets.ts';
import {
  KALSHI_HIGH_SERIES,
  buildCaptureRow,
  executableLegSpecs,
  isOverlapEvent,
  parseKalshiLadder,
  polyLadderFromEvent,
  type CrossVenueCaptureRow,
  type LegRef,
} from './pure.ts';
import type { FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596; // "Highest temperature" — the daily-Tmax ladders
const HEADERS: Record<string, string> = {
  'User-Agent': 'weather-edge/0.1 (cross-venue-capture)',
  Accept: 'application/json',
};

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface CrossVenueCaptureDeps {
  now: Date;
  fetchJson: FetchJsonLike;
}

/** Page all active open temperature events from Gamma → parsed (parse failures skipped). */
async function fetchOpenEvents(fetchJson: FetchJsonLike, log: JobCtx['log']): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  let parseFails = 0;
  for (let offset = 0; ; offset += 100) {
    const url = `${GAMMA}/events?tag_id=${TAG}&active=true&closed=false&limit=100&offset=${offset}`;
    let page: unknown;
    try {
      page = await fetchJson(url, { headers: HEADERS } as RequestInit, { timeoutMs: 10_000, retries: 1 });
    } catch (e) {
      log('gamma page failed (non-fatal — partial universe)', { error: msg(e), offset });
      break;
    }
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page as RawGammaEvent[]) {
      try {
        out.push(parseGammaEvent(raw));
      } catch {
        parseFails++;
      }
    }
    if (page.length < 100) break;
  }
  log('gamma enumeration done', { parsed: out.length, parseFails });
  return out;
}

/** Fetch the open KXHIGH markets for one city's Kalshi series (best-effort; [] on failure). */
async function fetchKalshiMarkets(fetchJson: FetchJsonLike, series: string, log: JobCtx['log']): Promise<unknown[]> {
  try {
    const res = (await fetchJson(
      `${KALSHI}/markets?series_ticker=${series}&status=open&limit=200`,
      { headers: HEADERS } as RequestInit,
      { timeoutMs: 8_000, retries: 1 },
    )) as { markets?: unknown };
    return Array.isArray(res?.markets) ? res.markets : [];
  } catch (e) {
    log('kalshi markets fetch failed (non-fatal)', { error: msg(e), series });
    return [];
  }
}

/**
 * Walk the TRUE both-venue order books at the best position's legs and return the BINDING (min) executable
 * size — the capacity-wall gate. The cumulative YES≥k synthetic must fill EVERY leg to be hedged: buy legs
 * hit the ASK, sell legs hit the BID. Kalshi via /markets/{ticker}/orderbook, Polymarket via CLOB /book.
 * A leg whose book we cannot map or fetch contributes size 0 ⇒ the position is not provably executable
 * (the safe direction for a kill gate). Best-effort: a fetch failure on any leg → that leg counts as 0.
 */
async function walkExecutableDepth(
  fetchJson: FetchJsonLike,
  ev: ParsedEvent,
  bins: KalshiBin[],
  edge: CrossVenueEdge,
): Promise<number> {
  const { buyLegs, sellLegs } = executableLegSpecs(ev, bins, edge); // pure loF→ticker/token mapping (tested)

  const sizeOf = async (l: LegRef): Promise<number> => {
    if (!l.id) return 0; // unmappable leg ⇒ not provably executable
    try {
      if (l.venue === 'kalshi') {
        const { yesBids, yesAsks } = parseKalshiOrderbook(
          await fetchJson(`${KALSHI}/markets/${l.id}/orderbook`, { headers: HEADERS } as RequestInit, { timeoutMs: 6000, retries: 1 }),
        );
        return (l.side === 'ask' ? yesAsks[0]?.size : yesBids[0]?.size) ?? 0;
      }
      const book = normalizeBook(
        (await fetchJson(`${CLOB}/book?token_id=${l.id}`, { headers: HEADERS } as RequestInit, { timeoutMs: 6000, retries: 1 })) as RawClobBook,
      );
      return (l.side === 'ask' ? book.asks[0]?.size : book.bids[0]?.size) ?? 0;
    } catch {
      return 0; // unfetchable leg ⇒ not provably executable
    }
  };

  const buySizes = await Promise.all(buyLegs.map(sizeOf));
  const sellSizes = await Promise.all(sellLegs.map(sizeOf));
  return bindingExecutable(buySizes, sellSizes);
}

export async function crossVenueCapture(ctx: JobCtx, deps: CrossVenueCaptureDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const { now, fetchJson } = deps;
  const capturedAt = now.toISOString();

  // ── STEP 1: Polymarket events for the overlap cities, near-dated ──────────────────────────────
  const allEvents = await fetchOpenEvents(fetchJson, log);
  const overlap = allEvents.filter((ev) => isOverlapEvent(ev, now));
  const cities = [...new Set(overlap.map((ev) => ev.citySlug))];
  log('overlap events selected', { overlapEvents: overlap.length, cities: cities.length });

  // ── STEP 2: Kalshi books for those cities (concurrent), one fetch per series ───────────────────
  const kalshiByCity = new Map<string, unknown[]>();
  await Promise.all(
    cities.map(async (city) => {
      const series = KALSHI_HIGH_SERIES[city];
      if (!series) return;
      kalshiByCity.set(city, await fetchKalshiMarkets(fetchJson, series, log));
    }),
  );

  // ── STEP 3: match each poly event to its Kalshi ladder for the same date → engine → row + edge ──
  const built: { row: CrossVenueCaptureRow; edge: CrossVenueEdge; ev: ParsedEvent; bins: KalshiBin[] }[] = [];
  for (const ev of overlap) {
    const markets = kalshiByCity.get(ev.citySlug);
    if (!markets || markets.length === 0) continue;
    const { ladder: kalshiLadder, bins } = parseKalshiLadder(markets, ev.citySlug, ev.targetDate);
    if (bins.length === 0) continue; // Kalshi has no market for this exact target date
    const out = buildCaptureRow(ev.citySlug, ev.targetDate, polyLadderFromEvent(ev), kalshiLadder, capturedAt);
    if (out) built.push({ ...out, ev, bins });
  }

  // ── STEP 3.5: TRUE executable-depth walk for NET-POSITIVE rows only (the capacity-wall gate) ────
  // Quoted edges are common; a quoted edge is only a WIN if the cumulative synthetic fills at real touch
  // depth on BOTH books (CROSS-VENUE-SPIKE.md found 1–10 units — an order of magnitude below tradable).
  // Efficient (≤0-edge) rows skip the walk (not the false-PASS risk) and keep the cheap proxy denominator.
  const netPos = built.filter((b) => b.row.netPositive && b.edge.ok);
  await Promise.all(
    netPos.map(async (b) => {
      const exec = await walkExecutableDepth(fetchJson, b.ev, b.bins, b.edge);
      b.row.execSize = Number.isFinite(exec) ? exec : 0;
      b.row.isExecutable = b.row.execSize >= MIN_EXEC_SIZE;
    }),
  );
  log('cross-venue depth walked', { netPositive: netPos.length, executable: netPos.filter((b) => b.row.isExecutable).length });

  const rows = built.map((b) => b.row);

  // ── insert via service-role RPC ────────────────────────────────────────────────────────────────
  let inserted = 0;
  if (rows.length > 0) {
    try {
      const res = await db.rpc<{ record_cross_venue_captures: number }>('record_cross_venue_captures', { p_rows: rows });
      inserted = Number(res[0]?.record_cross_venue_captures ?? rows.length);
    } catch (e) {
      log('record_cross_venue_captures failed (non-fatal)', { error: msg(e) });
    }
  }

  const stats = {
    asOf: capturedAt,
    polyEvents: allEvents.length,
    overlapEvents: overlap.length,
    citiesProbed: kalshiByCity.size,
    citiesMatched: new Set(rows.map((r) => r.city)).size, // cities that actually produced a captured row
    captured: rows.length,
    inserted,
    netPositive: rows.filter((r) => r.netPositive).length,
    realDepth: rows.filter((r) => r.hasRealDepth).length,
    executable: rows.filter((r) => r.isExecutable).length, // net-positive AND fills at real touch depth
  };
  log('cross-venue-capture complete', stats);
  return stats;
}
