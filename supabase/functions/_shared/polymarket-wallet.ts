/**
 * _shared/polymarket-wallet — the Polymarket public-data client for the sharp-wallet benchmark tracker
 * (migration 0049, WALLET-RECON-HANDOFF.md Build #1).
 *
 * Polymarket's data plane is fully public and keyless: per-wallet open positions, the WEATHER trader
 * leaderboard, and the cumulative realized-PnL curve. We ingest the #1 weather sharp ("badatmath.",
 * 0x8fbd…a959) + the top-N leaderboard as an INDEPENDENT third forecaster on /amsterdam — NOT to copy-trade
 * (the live-trading thesis stays closed per FORECASTING-RD.md), but to surface where a verified-profitable
 * peer's revealed bet disagrees with our forecast and the market mid.
 *
 * Idiom mirrors _shared/knmi.ts: the PARSERS are pure + total (`[]` on a junk/non-array payload, skip
 * malformed rows — never throw on upstream drift); the fetch wrappers take the injected fetchJson
 * (packages/io — timeout/retry/JSON) so the same module serves the Edge Function (sharp-wallet-track) and
 * the script (scripts/sharp-wallets.ts) without drift, and the parsers stay unit-testable with no network.
 *
 * Field names are fixture-verified live (research/dataapi-positions-badatmath-sample.json,
 * dataapi-weather-leaderboard-sample.json, userpnl-badatmath.json) — never assumed. The market slug parse
 * mirrors core/polymarket/gamma.ts (the canonical STRICT parser) but is non-throwing here: a position on a
 * non-temperature market just yields a null market, it does not abort the ingest.
 */

/** All read surfaces are auth-free; pass the proxy wallet as `user` / `user_address`. */
export const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
/** Undocumented-but-stable host powering the profile PnL chart (Build #2 reconstructs from /activity as fallback). */
export const POLYMARKET_USER_PNL_API = 'https://user-pnl-api.polymarket.com';

/** The seeded #1 WEATHER sharp (WALLET-RECON-HANDOFF.md). Polygon proxy wallet. */
export const SHARP_WALLET_ADDRESS = '0x8fbd7cf5f806f563080864694415829f7229a959';
export const SHARP_WALLET_LABEL = 'badatmath.';

/** A polite UA + JSON Accept (the feasibility note asks for a UA; Deno honours it, browsers drop it harmlessly). */
const REQUEST_HEADERS = { 'User-Agent': 'polyweather-analytics/1.0', Accept: 'application/json' };

export interface WalletPosition {
  /** Per-bucket market condition id — joins market_buckets.condition_id (0004). */
  conditionId: string;
  /** ERC-1155 token id (the YES or NO leg the wallet holds). */
  asset: string;
  /** 'Yes' | 'No' (raw casing kept — it is the side the wallet holds). */
  outcome: string;
  /** Shares held (Polymarket field `size`, NOT `shares`). */
  sizeShares: number;
  /** Volume-weighted entry price (the implied probability the wallet paid). */
  avgPrice: number;
  curPrice: number | null;
  currentValueUsd: number | null;
  cashPnlUsd: number | null;
  realizedPnlUsd: number | null;
  redeemable: boolean;
  title: string;
  slug: string;
  eventSlug: string;
  endDate: string | null;
  /** Derived from eventSlug (null when the market is not a temperature-bucket market). */
  kind: 'highest' | 'lowest' | null;
  citySlug: string | null;
  targetDate: string | null;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  label: string;
  pnlUsd: number;
  volumeUsd: number;
}

export interface UserPnlPoint {
  /** Unix seconds (one point per day at fidelity=1d). */
  t: number;
  /** Cumulative realized PnL in USDC as of t. */
  cumPnlUsd: number;
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a Polymarket event slug ('highest-temperature-in-amsterdam-on-june-22-2026') into
 * { kind, citySlug, targetDate }. Mirrors the slug regex of core/polymarket/gamma.ts (the authoritative
 * strict parser) — the slug date IS the station-local target date — but is TOTAL: returns null on any
 * non-temperature / unparseable slug instead of throwing, so one odd position never aborts an ingest.
 * Note: a bucket-leg slug carries a trailing bucket suffix ('…-25c', '…-25corbelow') — pass the EVENT slug.
 * Scoped divergence from gamma.ts: we ALSO tolerate the `arch-` archived-market prefix Polymarket stamps
 * onto resolved markets. The ALL-history /activity crawl (Build #2) surfaces archived slugs; an archived
 * market is the SAME market (same kind/city/date), just renamed on archival, so parsing it identically lets
 * those resolved positions grade instead of silently falling to a null targetDate. The live gamma parser
 * never sees `arch-` slugs (archived markets aren't tradeable), so it stays strict; the two wallet twins
 * stay byte-identical to each other.
 */
export function parsePositionMarket(
  eventSlug: string,
): { kind: 'highest' | 'lowest'; citySlug: string; targetDate: string } | null {
  const m = /^(?:arch-)?(highest|lowest)-temperature-in-(.+)-on-([a-z]+)-(\d{1,2})-(\d{4})$/.exec(eventSlug ?? '');
  if (!m) return null;
  const month = MONTHS[m[3]!];
  if (!month) return null;
  const day = Number(m[4]);
  const year = Number(m[5]);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { kind: m[1] as 'highest' | 'lowest', citySlug: m[2]!, targetDate: `${year}-${pad(month)}-${pad(day)}` };
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

interface RawPosition {
  conditionId?: unknown;
  asset?: unknown;
  outcome?: unknown;
  size?: unknown;
  avgPrice?: unknown;
  curPrice?: unknown;
  currentValue?: unknown;
  cashPnl?: unknown;
  realizedPnl?: unknown;
  redeemable?: unknown;
  title?: unknown;
  slug?: unknown;
  eventSlug?: unknown;
  endDate?: unknown;
}

/**
 * Parse a /positions payload into WalletPosition[]. Drops rows without a conditionId or a finite size
 * (an empty / dust / malformed entry); derives the temperature market from eventSlug. Pure + total —
 * `[]` on a non-array payload.
 */
export function parsePositions(payload: unknown): WalletPosition[] {
  if (!Array.isArray(payload)) return [];
  const out: WalletPosition[] = [];
  for (const raw of payload as RawPosition[]) {
    if (!raw || typeof raw.conditionId !== 'string' || raw.conditionId === '') continue;
    const sizeShares = num(raw.size);
    if (sizeShares === null) continue;
    const avgPrice = num(raw.avgPrice) ?? 0;
    const eventSlug = typeof raw.eventSlug === 'string' ? raw.eventSlug : '';
    const market = parsePositionMarket(eventSlug);
    out.push({
      conditionId: raw.conditionId,
      asset: typeof raw.asset === 'string' ? raw.asset : '',
      outcome: typeof raw.outcome === 'string' ? raw.outcome : '',
      sizeShares,
      avgPrice,
      curPrice: num(raw.curPrice),
      currentValueUsd: num(raw.currentValue),
      cashPnlUsd: num(raw.cashPnl),
      realizedPnlUsd: num(raw.realizedPnl),
      redeemable: raw.redeemable === true,
      title: typeof raw.title === 'string' ? raw.title : '',
      slug: typeof raw.slug === 'string' ? raw.slug : '',
      eventSlug,
      endDate: typeof raw.endDate === 'string' ? raw.endDate : null,
      kind: market?.kind ?? null,
      citySlug: market?.citySlug ?? null,
      targetDate: market?.targetDate ?? null,
    });
  }
  return out;
}

interface RawLeaderboardEntry {
  rank?: unknown;
  proxyWallet?: unknown;
  userName?: unknown;
  pnl?: unknown;
  vol?: unknown;
}

/**
 * Parse a /v1/leaderboard payload into LeaderboardEntry[]. `rank` arrives as a STRING ('1'); pnl/vol are
 * numbers. Drops rows without a wallet address. Pure + total — `[]` on a non-array payload.
 */
export function parseLeaderboard(payload: unknown): LeaderboardEntry[] {
  if (!Array.isArray(payload)) return [];
  const out: LeaderboardEntry[] = [];
  for (const raw of payload as RawLeaderboardEntry[]) {
    if (!raw || typeof raw.proxyWallet !== 'string' || raw.proxyWallet === '') continue;
    const rank = num(raw.rank);
    out.push({
      rank: rank === null ? 0 : Math.trunc(rank),
      address: raw.proxyWallet,
      label: typeof raw.userName === 'string' && raw.userName !== '' ? raw.userName : raw.proxyWallet,
      pnlUsd: num(raw.pnl) ?? 0,
      volumeUsd: num(raw.vol) ?? 0,
    });
  }
  return out;
}

interface RawPnlPoint {
  t?: unknown;
  p?: unknown;
}

/**
 * Parse a user-pnl payload ([{t,p}]) into UserPnlPoint[]. Drops rows without a finite t or p. Pure +
 * total — `[]` on a non-array payload.
 */
export function parseUserPnl(payload: unknown): UserPnlPoint[] {
  if (!Array.isArray(payload)) return [];
  const out: UserPnlPoint[] = [];
  for (const raw of payload as RawPnlPoint[]) {
    if (!raw) continue;
    const t = num(raw.t);
    const p = num(raw.p);
    if (t === null || p === null) continue;
    out.push({ t: Math.trunc(t), cumPnlUsd: p });
  }
  return out;
}

export type FetchJsonLike = (
  url: string,
  init?: RequestInit,
  opts?: { timeoutMs?: number; retries?: number; backoffMs?: number },
) => Promise<unknown>;

/**
 * Fetch a wallet's open positions (the revealed bets). `sizeThreshold` drops dust; `limit` caps the page
 * (≤500 — the API hard cap; page with `offset` for a wallet holding more). Throws (via fetchJson) on an
 * exhausted/!ok upstream — the cron path catches it as non-fatal.
 */
export async function fetchWalletPositions(
  fetchJson: FetchJsonLike,
  address: string,
  opts: { sizeThreshold?: number; limit?: number; offset?: number; timeoutMs?: number; retries?: number } = {},
): Promise<WalletPosition[]> {
  const sizeThreshold = opts.sizeThreshold ?? 0.1;
  const limit = Math.min(opts.limit ?? 500, 500); // ≤500 API hard cap (twin-identical with io fetchPositions)
  const offset = opts.offset ?? 0;
  const url =
    `${POLYMARKET_DATA_API}/positions?user=${encodeURIComponent(address)}` +
    `&sizeThreshold=${sizeThreshold}&limit=${limit}&offset=${offset}&sortBy=CURRENT`;
  const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, {
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
  return parsePositions(payload);
}

/**
 * Fetch the WEATHER trader leaderboard (documented endpoint; default MONTH/PNL — the window that shows the
 * sharp's recent edge). Pure parse of the response.
 */
export async function fetchWeatherLeaderboard(
  fetchJson: FetchJsonLike,
  opts: { timePeriod?: 'DAY' | 'WEEK' | 'MONTH' | 'ALL'; limit?: number; timeoutMs?: number; retries?: number } = {},
): Promise<LeaderboardEntry[]> {
  const timePeriod = opts.timePeriod ?? 'MONTH';
  const limit = opts.limit ?? 50;
  const url =
    `${POLYMARKET_DATA_API}/v1/leaderboard?category=WEATHER` +
    `&timePeriod=${timePeriod}&orderBy=PNL&limit=${limit}`;
  const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, {
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
  return parseLeaderboard(payload);
}

/**
 * Fetch the cumulative realized-PnL curve (one point/day, interval=all). The ground-truth profitability
 * curve Build #2 reconciles its own /activity reconstruction against.
 */
export async function fetchUserPnl(
  fetchJson: FetchJsonLike,
  address: string,
  opts: { interval?: string; fidelity?: string; timeoutMs?: number; retries?: number } = {},
): Promise<UserPnlPoint[]> {
  const interval = opts.interval ?? 'all';
  const fidelity = opts.fidelity ?? '1d';
  const url = `${POLYMARKET_USER_PNL_API}/user-pnl?user_address=${encodeURIComponent(address)}&interval=${interval}&fidelity=${fidelity}`;
  const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, {
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
  });
  return parseUserPnl(payload);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- global trade feed + whale detection (whale-watch, migration 0055) -------
// The Data API /trades endpoint is GLOBAL and keyless: with no `market`/`user` filter it returns the
// most-recent taker fills across ALL of Polymarket, newest-first. It supports a SERVER-SIDE size floor
// (`filterType=CASH&filterAmount=N` → only fills whose USDC notional ≥ N), so a whale watcher pulls only the
// handful of large trades per poll — well under the 200-req/10s /trades budget. Notional = size × price
// (live-verified: filterAmount thresholds on size × price). One row = one taker order = one "bet".

export interface Trade {
  /** Polygon proxy wallet that placed the (taker) trade. */
  proxyWallet: string;
  /** Display handle if set, else the pseudonym, else '' — the "who" for the alert. */
  traderName: string;
  /** 'BUY' | 'SELL' (taker side); null on an unrecognised value. */
  side: 'BUY' | 'SELL' | null;
  /** ERC-1155 token id traded. */
  asset: string;
  /** Market condition id. */
  conditionId: string;
  /** Outcome bought/sold ('Yes'|'No'|'Under'|… raw casing — multi-outcome markets are not Yes/No). */
  outcome: string;
  /** Shares transacted (Polymarket field `size`, NOT `shares`). */
  sizeShares: number;
  /** Fill price in 0..1 (the implied probability). */
  price: number;
  /** USDC notional = sizeShares × price (what the CASH filter thresholds on). */
  notionalUsd: number;
  /** Unix seconds. */
  timestamp: number;
  title: string;
  /** Market-leg slug. */
  slug: string;
  /** Event slug → the https://polymarket.com/event/{eventSlug} permalink. */
  eventSlug: string;
  /** Polygon tx hash — the stable per-trade id; the alert/dedupe spine. */
  transactionHash: string;
}

interface RawTrade {
  proxyWallet?: unknown;
  name?: unknown;
  pseudonym?: unknown;
  side?: unknown;
  asset?: unknown;
  conditionId?: unknown;
  outcome?: unknown;
  size?: unknown;
  price?: unknown;
  timestamp?: unknown;
  title?: unknown;
  slug?: unknown;
  eventSlug?: unknown;
  transactionHash?: unknown;
}

/**
 * Parse a /trades payload into Trade[]. Pure + total — `[]` on a non-array payload; never throws on drift.
 * Drop rule: a row needs a non-empty `transactionHash` (the stable id we dedup + alert on) and finite
 * `size`/`price`/`timestamp`; everything else is permissive. notionalUsd is derived (size × price). `name`
 * falls back to `pseudonym` then '' for the trader label. `side`/`outcome` are kept verbatim (multi-outcome
 * markets carry outcomes like 'Under', not just Yes/No).
 */
export function parseTrades(payload: unknown): Trade[] {
  if (!Array.isArray(payload)) return [];
  const out: Trade[] = [];
  for (const raw of payload as RawTrade[]) {
    if (!raw) continue;
    const transactionHash = typeof raw.transactionHash === 'string' ? raw.transactionHash : '';
    if (transactionHash === '') continue; // no stable id → cannot dedup or alert safely
    const sizeShares = num(raw.size);
    const price = num(raw.price);
    const timestamp = num(raw.timestamp);
    if (sizeShares === null || price === null || timestamp === null) continue;
    const sideRaw = typeof raw.side === 'string' ? raw.side.toUpperCase() : '';
    const side: 'BUY' | 'SELL' | null = sideRaw === 'BUY' ? 'BUY' : sideRaw === 'SELL' ? 'SELL' : null;
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name : '';
    const pseudonym = typeof raw.pseudonym === 'string' && raw.pseudonym !== '' ? raw.pseudonym : '';
    out.push({
      proxyWallet: typeof raw.proxyWallet === 'string' ? raw.proxyWallet : '',
      traderName: name || pseudonym,
      side,
      asset: typeof raw.asset === 'string' ? raw.asset : '',
      conditionId: typeof raw.conditionId === 'string' ? raw.conditionId : '',
      outcome: typeof raw.outcome === 'string' ? raw.outcome : '',
      sizeShares,
      price,
      notionalUsd: sizeShares * price,
      timestamp: Math.trunc(timestamp),
      title: typeof raw.title === 'string' ? raw.title : '',
      slug: typeof raw.slug === 'string' ? raw.slug : '',
      eventSlug: typeof raw.eventSlug === 'string' ? raw.eventSlug : '',
      transactionHash,
    });
  }
  return out;
}

/**
 * Fetch recent trades from the Data API /trades feed. With no `market`/`user` it is the GLOBAL feed (all of
 * Polymarket, newest-first); pass `filterType:'CASH'` + `filterAmount` for the server-side USD-notional floor
 * (the whale filter). Pages by offset up to `maxPages`, stopping at the first short page; dedup is the
 * caller's job (trade rows are stable by transactionHash). Throws (via fetchJson) on an exhausted/!ok
 * upstream — the cron path catches it as non-fatal.
 */
export async function fetchTrades(
  fetchJson: FetchJsonLike,
  opts: {
    filterType?: 'CASH' | 'TOKENS';
    filterAmount?: number;
    takerOnly?: boolean;
    market?: string;
    user?: string;
    limit?: number;
    offset?: number;
    maxPages?: number;
    pageDelayMs?: number;
    timeoutMs?: number;
    retries?: number;
  } = {},
): Promise<Trade[]> {
  const limit = Math.min(opts.limit ?? 100, 500); // ≤500 API page cap
  const takerOnly = opts.takerOnly ?? true;
  const maxPages = opts.maxPages ?? 1;
  const pageDelayMs = opts.pageDelayMs ?? 120;
  const baseOffset = opts.offset ?? 0;
  const out: Trade[] = [];
  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pageDelayMs > 0) await sleep(pageDelayMs);
    const offset = baseOffset + page * limit;
    let url = `${POLYMARKET_DATA_API}/trades?limit=${limit}&offset=${offset}&takerOnly=${takerOnly}`;
    if (opts.filterType) url += `&filterType=${opts.filterType}`;
    if (typeof opts.filterAmount === 'number') url += `&filterAmount=${Math.trunc(opts.filterAmount)}`;
    if (opts.market) url += `&market=${encodeURIComponent(opts.market)}`;
    if (opts.user) url += `&user=${encodeURIComponent(opts.user)}`;
    const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, {
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
    });
    const rawLen = Array.isArray(payload) ? payload.length : 0;
    out.push(...parseTrades(payload));
    if (rawLen < limit) break; // short/empty page = last page
  }
  return out;
}
