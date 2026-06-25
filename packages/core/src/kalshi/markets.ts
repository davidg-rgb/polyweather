/**
 * core/kalshi/markets — pure parsers for Kalshi's keyless public market-data API, the SECOND venue
 * for the cross-venue relative-value measurement (CROSS-VENUE-SPIKE.md, the 10th signal). Mirrors the
 * role of polymarket/gamma.ts + clob.ts: turn the raw venue JSON into the engine's venue-agnostic
 * ladder (core/sim/cross-venue-arb.ts). No network here — the HTTP fetch lives in the edge handler /
 * scan via packages/io fetchJson; these helpers are pure + total (a malformed market → skipped, never
 * a throw) so they unit-test in Node and run unchanged in Deno.
 *
 * KALSHI TEMPERATURE LADDER (verified live 2026-06-25, KXHIGHNY): one daily-high event = a ladder of
 * 2°F "between" bins on an ODD-start grid (…79-80, 81-82, 83-84…) bracketed by a "less" floor bin and
 * a "greater" cap bin, resolving on the NWS Climatological Report (CLI). Strike → integer-°F span:
 *   strike_type 'between' (floor=83, cap=84, "83° to 84°")     → [83, 84]
 *   strike_type 'greater' (floor=86,        "87° or above")    → loF = floor + 1, hiF = null
 *   strike_type 'less'    (cap=79,          "78° or below")    → loF = null, hiF = cap − 1
 * The ODD-start grid vs Polymarket's EVEN-start grid is the 1°F bin offset the engine prices.
 */
import type { VenueBucket, VenueLadder } from '../sim/cross-venue-arb.ts';

/**
 * The Polymarket↔Kalshi city overlap, mapped to Kalshi's KXHIGH series ticker. Of the 11 US cities we
 * track on Polymarket, Kalshi lists daily-high markets for exactly these 6 (verified live 2026-06-25;
 * KXHIGHHOU/DAL/ATL/SF/SEA all return no open market — Kalshi simply does not cover them). A city
 * whose series returns nothing on a given tick is just absent from that day's matched panel.
 */
export const KALSHI_HIGH_SERIES: Record<string, string> = {
  nyc: 'KXHIGHNY',
  'los-angeles': 'KXHIGHLAX',
  chicago: 'KXHIGHCHI',
  miami: 'KXHIGHMIA',
  austin: 'KXHIGHAUS',
  denver: 'KXHIGHDEN',
};

/** Raw Kalshi market (the subset of `/markets` fields we consume; all `_dollars` are decimal strings). */
export interface KalshiRawMarket {
  ticker?: string;
  event_ticker?: string;
  strike_type?: string;
  floor_strike?: number | null;
  cap_strike?: number | null;
  yes_sub_title?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  open_interest_fp?: string;
  volume_24h_fp?: string;
  status?: string;
}

/** A parsed Kalshi ladder bin: the engine's VenueBucket + the open interest (the depth proxy). */
export interface KalshiBin extends VenueBucket {
  ticker: string;
  openInterest: number;
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

const num = (s: unknown): number | null => {
  if (s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};
const px = (s: unknown): number | null => {
  const v = num(s);
  return v != null && v > 0 && v < 1 ? v : null; // a usable probability (0,1); 0.00 ⇒ no quote
};

/**
 * Parse the YYYY-MM-DD target date out of a Kalshi ticker's date segment, e.g.
 * `KXHIGHNY-26JUN25-B83.5` → `2026-06-25`. Returns null on any malformed segment.
 */
export function kalshiTickerDate(ticker: string | undefined): string | null {
  const seg = String(ticker ?? '').split('-')[1]; // '26JUN25'
  const m = /^(\d{2})([A-Z]{3})(\d{2})$/.exec(seg ?? '');
  if (!m) return null;
  const mm = MONTHS[m[2]!];
  if (!mm) return null;
  return `20${m[1]}-${mm}-${m[3]}`;
}

/** The integer-°F [loF, hiF] span of a Kalshi market from its strike fields (subtitle as a fallback). */
export function kalshiStrikeSpan(mkt: KalshiRawMarket): { loF: number | null; hiF: number | null } | null {
  const type = String(mkt.strike_type ?? '').toLowerCase();
  const floor = num(mkt.floor_strike);
  const cap = num(mkt.cap_strike);
  if (type === 'between' && floor != null && cap != null) return { loF: Math.round(floor), hiF: Math.round(cap) };
  if ((type === 'greater' || type === 'greater_or_equal') && floor != null) {
    return { loF: Math.round(floor) + (type === 'greater' ? 1 : 0), hiF: null };
  }
  if ((type === 'less' || type === 'less_or_equal') && cap != null) {
    return { loF: null, hiF: Math.round(cap) - (type === 'less' ? 1 : 0) };
  }
  // fallback: parse the human subtitle ("83° to 84°", "87° or above", "78° or below")
  const sub = String(mkt.yes_sub_title ?? '');
  let m = /(-?\d+)°?\s*(?:to|–|-)\s*(-?\d+)°/.exec(sub);
  if (m) return { loF: Number(m[1]), hiF: Number(m[2]) };
  m = /(-?\d+)°?\s*or\s*(above|higher)/i.exec(sub);
  if (m) return { loF: Number(m[1]), hiF: null };
  m = /(-?\d+)°?\s*or\s*(below|lower)/i.exec(sub);
  if (m) return { loF: null, hiF: Number(m[1]) };
  return null;
}

/** Parse one raw market into a KalshiBin, or null if its strike/quotes are unusable. */
export function parseKalshiBin(mkt: KalshiRawMarket): KalshiBin | null {
  const span = kalshiStrikeSpan(mkt);
  if (!span) return null;
  return {
    ticker: String(mkt.ticker ?? ''),
    loF: span.loF,
    hiF: span.hiF,
    yesAsk: px(mkt.yes_ask_dollars),
    yesBid: px(mkt.yes_bid_dollars),
    openInterest: num(mkt.open_interest_fp) ?? 0,
  };
}

/**
 * Parse a Kalshi `/markets?series_ticker=…` response into the engine's VenueLadder for ONE target
 * date, plus the per-bin open interest (the depth proxy). Filters to markets matching `targetDate`
 * (YYYY-MM-DD) via the ticker date segment, drops unparseable / quote-less bins, sorts by loF. Pure +
 * total — a junk payload yields an empty ladder, never a throw.
 */
export function parseKalshiLadder(
  rawMarkets: unknown,
  city: string,
  targetDate: string,
): { ladder: VenueLadder; bins: KalshiBin[]; eventTicker: string } {
  const arr = Array.isArray(rawMarkets) ? (rawMarkets as KalshiRawMarket[]) : [];
  const bins = arr
    .filter((m) => kalshiTickerDate(m.ticker) === targetDate)
    .map(parseKalshiBin)
    .filter((b): b is KalshiBin => b != null && (b.yesAsk != null || b.yesBid != null))
    .sort((a, b) => (a.loF ?? -Infinity) - (b.loF ?? -Infinity));
  const eventTicker = arr.find((m) => kalshiTickerDate(m.ticker) === targetDate)?.event_ticker ?? '';
  const ladder: VenueLadder = {
    venue: 'kalshi',
    buckets: bins.map(
      (b): VenueBucket => ({
        loF: b.loF,
        hiF: b.hiF,
        yesAsk: b.yesAsk,
        yesBid: b.yesBid,
        topAskSize: b.openInterest, // depth proxy v1: open interest stands in for top-of-book size
        topBidSize: b.openInterest,
      }),
    ),
  };
  return { ladder, bins, eventTicker };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// orderbook depth (the v2 seam — true top-of-book size, used only for candidate cities)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One price level (best-first), shared shape with the complete-set depth walker. */
export interface KalshiLevel {
  price: number;
  size: number;
}

/**
 * Parse a Kalshi `/markets/{ticker}/orderbook` response (`orderbook_fp.yes_dollars`/`no_dollars`,
 * each `[priceDollars, size]` ASCENDING by price) into best-first YES bid & YES ask ladders. Kalshi's
 * book is reciprocal: a resting NO bid at price p IS a YES ask at (1 − p). So the YES ask ladder is
 * derived from the NO bids. Pure + total — junk → empty ladders.
 */
export function parseKalshiOrderbook(raw: unknown): { yesBids: KalshiLevel[]; yesAsks: KalshiLevel[] } {
  const ob = (raw as { orderbook_fp?: { yes_dollars?: unknown; no_dollars?: unknown } } | null)?.orderbook_fp;
  const lvl = (a: unknown): KalshiLevel | null => {
    if (!Array.isArray(a) || a.length < 2) return null;
    const price = Number(a[0]);
    const size = Number(a[1]);
    return Number.isFinite(price) && Number.isFinite(size) && size > 0 ? { price, size } : null;
  };
  const yesRaw = (Array.isArray(ob?.yes_dollars) ? ob!.yes_dollars : []).map(lvl).filter((x): x is KalshiLevel => x != null);
  const noRaw = (Array.isArray(ob?.no_dollars) ? ob!.no_dollars : []).map(lvl).filter((x): x is KalshiLevel => x != null);
  // YES bids: highest price first. YES asks: NO bids mapped to (1 − p), lowest ask first.
  const yesBids = yesRaw.filter((l) => l.price > 0 && l.price < 1).sort((a, b) => b.price - a.price);
  const yesAsks = noRaw
    .filter((l) => l.price > 0 && l.price < 1)
    .map((l) => ({ price: 1 - l.price, size: l.size }))
    .sort((a, b) => a.price - b.price);
  return { yesBids, yesAsks };
}
