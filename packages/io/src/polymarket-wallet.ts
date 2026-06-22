/**
 * io/polymarket-wallet — the Node twin of supabase/functions/_shared/polymarket-wallet.ts
 * (WALLET-RECON-HANDOFF.md §6, the documented Deno/Node seam). This is the CANONICAL Node-side
 * Polymarket public-data client and the data spine for Build #2 (wallet forensics).
 *
 * The DENO/NODE SEAM (WALLET-RECON-HANDOFF.md §6 "write the pure parsers once and copy across the
 * seam"): the PURE PARSERS + TYPES in this file (parsePositions, parseLeaderboard, parseUserPnl,
 * parsePositionMarket, the `num` helper, MONTHS, WalletPosition/LeaderboardEntry/UserPnlPoint,
 * SHARP_WALLET_ADDRESS/LABEL, POLYMARKET_DATA_API/POLYMARKET_USER_PNL_API, REQUEST_HEADERS) are a
 * VERBATIM behavioural copy of the _shared Deno module. They must stay behaviourally identical — if
 * one side changes a field name or a drop rule, change the other in the same breath. The only deltas
 * are Node-side ADDITIONS for Build #2: the Activity parser (TRADE/REDEEM reconstruction spine) and
 * the paged/batched fetch wrappers (fetchActivity, resolveMarketsMeta).
 *
 * Idiom (mirrors _shared/knmi.ts + the Deno twin): the PARSERS are pure + total (`[]` on a
 * junk/non-array payload, skip malformed rows — never throw on upstream drift); the fetch wrappers
 * take the injected fetchJson (packages/io — timeout/retry/JSON) so the same parser serves the Edge
 * Function and the Node scripts without drift, and the parsers stay unit-testable with no network.
 *
 * Field names are fixture-verified LIVE (research/dataapi-positions-badatmath-sample.json,
 * dataapi-weather-leaderboard-sample.json, userpnl-badatmath.json, dataapi-activity-badatmath-sample.json)
 * — never assumed. Positions use `size` NOT `shares`; leaderboard rows are
 * `proxyWallet/userName/vol/pnl/rank`-as-string; /activity rows carry `size` (shares), `usdcSize`
 * (notional), `price` (0..1), `side` ('BUY'|'SELL'|'' for non-trade events), `type`
 * ('TRADE'|'REDEEM'|'MERGE'|'SPLIT'|…). Gamma's outcomes/clobTokenIds arrive as stringified JSON.
 */

/** All read surfaces are auth-free; pass the proxy wallet as `user` / `user_address`. */
export const POLYMARKET_DATA_API = 'https://data-api.polymarket.com';
/** Undocumented-but-stable host powering the profile PnL chart (Build #2 reconstructs from /activity as fallback). */
export const POLYMARKET_USER_PNL_API = 'https://user-pnl-api.polymarket.com';
/** Gamma — market metadata (outcomes, clobTokenIds, endDate, createdAt, negRisk). */
export const POLYMARKET_GAMMA_API = 'https://gamma-api.polymarket.com';

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

/**
 * One /activity row — the Build #2 reconstruction spine. A wallet's full fill+redemption history is
 * paged from /activity; TRADE rows are the buys/sells, REDEEM rows the settlements. Non-trade events
 * (REDEEM/MERGE/SPLIT/CONVERSION) carry an empty `side`/`asset`/`outcome` and `price:0` upstream but
 * still carry conditionId/size/usdcSize/eventSlug/title — surfaced as null/empty here.
 */
export interface WalletActivity {
  /** Event type — 'TRADE' | 'REDEEM' and any other upstream value passed through verbatim. */
  type: 'TRADE' | 'REDEEM' | string;
  /** 'BUY' | 'SELL' for a TRADE; null for non-trade events (upstream sends `''`). */
  side: 'BUY' | 'SELL' | null;
  /** Market condition id ('' on the merged-leg `outcomeIndex:999` rows — kept, not dropped). */
  conditionId: string;
  /** ERC-1155 token id ('' on non-trade events). */
  asset: string;
  /** 'Yes' | 'No' ('' on non-trade events). */
  outcome: string;
  /** Shares transacted (Polymarket field `size`, NOT `shares`). */
  sizeShares: number;
  /** Fill/redeem price in 0..1 (0 on REDEEM/MERGE/SPLIT). */
  price: number;
  /** USDC notional (field `usdcSize`). */
  usdcSize: number;
  /** Unix seconds. */
  timestamp: number;
  eventSlug: string;
  title: string;
  /** Derived from eventSlug (null when the market is not a temperature-bucket market). */
  kind: 'highest' | 'lowest' | null;
  citySlug: string | null;
  targetDate: string | null;
}

/** Batch-resolved gamma market metadata (resolveMarketsMeta value), keyed by conditionId. */
export interface MarketMeta {
  /** Decoded outcomes (gamma sends a stringified JSON array, e.g. `["Yes","No"]`). */
  outcomes: string[];
  /** Decoded clob token ids ([yes, no]); gamma sends a stringified JSON array. */
  clobTokenIds: string[];
  endDate: string | null;
  createdAt: string | null;
  negRisk: boolean | null;
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

interface RawActivity {
  type?: unknown;
  side?: unknown;
  conditionId?: unknown;
  asset?: unknown;
  outcome?: unknown;
  size?: unknown;
  price?: unknown;
  usdcSize?: unknown;
  timestamp?: unknown;
  eventSlug?: unknown;
  title?: unknown;
}

/**
 * Parse a /activity payload (TRADE + REDEEM/MERGE/SPLIT/… events) into WalletActivity[] — the Build #2
 * reconstruction spine. Field names are LIVE-verified (research/dataapi-activity-badatmath-sample.json):
 * `size` (shares, NOT `shares`), `usdcSize` (notional), `price` (0..1), `side` ('BUY'|'SELL'|'' for
 * non-trade events → mapped to null), `type` ('TRADE'|'REDEEM'|…). Derives the temperature market from
 * eventSlug via parsePositionMarket.
 *
 * Drop rule (kept deliberately permissive — every real fill matters for the FIFO P&L reconstruction):
 * a row is dropped ONLY if it has no usable `type` (non-string/empty) or no finite `timestamp`, `size`,
 * or `usdcSize`. Rows with an empty conditionId/eventSlug (the `outcomeIndex:999` merged-leg rows) are
 * KEPT — they are real trades, just without resolvable market metadata. Pure + total — `[]` on a
 * non-array payload; never throws on upstream drift.
 */
export function parseActivity(payload: unknown): WalletActivity[] {
  if (!Array.isArray(payload)) return [];
  const out: WalletActivity[] = [];
  for (const raw of payload as RawActivity[]) {
    if (!raw || typeof raw.type !== 'string' || raw.type === '') continue;
    const timestamp = num(raw.timestamp);
    const sizeShares = num(raw.size);
    const usdcSize = num(raw.usdcSize);
    if (timestamp === null || sizeShares === null || usdcSize === null) continue;
    const sideRaw = typeof raw.side === 'string' ? raw.side.toUpperCase() : '';
    const side: 'BUY' | 'SELL' | null = sideRaw === 'BUY' ? 'BUY' : sideRaw === 'SELL' ? 'SELL' : null;
    const eventSlug = typeof raw.eventSlug === 'string' ? raw.eventSlug : '';
    const market = parsePositionMarket(eventSlug);
    out.push({
      type: raw.type,
      side,
      conditionId: typeof raw.conditionId === 'string' ? raw.conditionId : '',
      asset: typeof raw.asset === 'string' ? raw.asset : '',
      outcome: typeof raw.outcome === 'string' ? raw.outcome : '',
      sizeShares,
      price: num(raw.price) ?? 0,
      usdcSize,
      timestamp: Math.trunc(timestamp),
      eventSlug,
      title: typeof raw.title === 'string' ? raw.title : '',
      kind: market?.kind ?? null,
      citySlug: market?.citySlug ?? null,
      targetDate: market?.targetDate ?? null,
    });
  }
  return out;
}

/** Decode gamma's stringified-JSON array fields (outcomes/clobTokenIds). Total — `[]` on junk. */
function parseGammaStringArray(v: unknown): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  if (typeof v !== 'string' || v === '') return [];
  try {
    const parsed = JSON.parse(v);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed as string[];
  } catch {
    /* fall through */
  }
  return [];
}

interface RawGammaMeta {
  conditionId?: unknown;
  outcomes?: unknown;
  clobTokenIds?: unknown;
  endDate?: unknown;
  createdAt?: unknown;
  negRisk?: unknown;
}

/**
 * Parse a gamma /markets payload into Map(conditionId → MarketMeta). Pure + total — empty Map on a
 * non-array payload; skips rows without a conditionId. Decodes the stringified outcomes/clobTokenIds.
 */
export function parseMarketsMeta(payload: unknown): Map<string, MarketMeta> {
  const map = new Map<string, MarketMeta>();
  if (!Array.isArray(payload)) return map;
  for (const raw of payload as RawGammaMeta[]) {
    if (!raw || typeof raw.conditionId !== 'string' || raw.conditionId === '') continue;
    map.set(raw.conditionId, {
      outcomes: parseGammaStringArray(raw.outcomes),
      clobTokenIds: parseGammaStringArray(raw.clobTokenIds),
      endDate: typeof raw.endDate === 'string' ? raw.endDate : null,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
      negRisk: typeof raw.negRisk === 'boolean' ? raw.negRisk : null,
    });
  }
  return map;
}

// --- fetch wrappers (impure; inject fetchJson) -------------------------------

export type FetchJsonLike = (
  url: string,
  init?: RequestInit,
  opts?: { timeoutMs?: number; retries?: number; backoffMs?: number },
) => Promise<unknown>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a wallet's open positions (the revealed bets). `sizeThreshold` drops dust; `limit` caps the page
 * (≤500 — the API hard cap; page with `offset` for a wallet holding more). Throws (via fetchJson) on an
 * exhausted/!ok upstream — the caller path catches it as non-fatal.
 *
 * (Twin of the Deno `fetchWalletPositions`; the §6/Build #2 name is `fetchPositions` — both exported.)
 */
export async function fetchPositions(
  fetchJson: FetchJsonLike,
  address: string,
  opts: { sizeThreshold?: number; limit?: number; offset?: number; timeoutMs?: number; retries?: number } = {},
): Promise<WalletPosition[]> {
  const sizeThreshold = opts.sizeThreshold ?? 0.1;
  const limit = Math.min(opts.limit ?? 500, 500);
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

/** Deno-seam alias — keep the _shared name callable from Node too. */
export const fetchWalletPositions = fetchPositions;

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
 *
 * (Twin of the Deno `fetchUserPnl`; the §6/Build #2 name is `fetchUserPnlSeries` — both exported.)
 */
export async function fetchUserPnlSeries(
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

/** Deno-seam alias — keep the _shared name callable from Node too. */
export const fetchUserPnl = fetchUserPnlSeries;

/**
 * Fetch a wallet's FULL activity history (the reconstruction spine), PAGED. Pages by `offset` within an
 * optional [start, end] unix-seconds window (the API caps a single sort window; window by time + page by
 * offset to recover everything — WALLET-RECON-HANDOFF.md §5). Each page is ≤500 rows.
 *
 * Politeness: a small inter-page delay (`pageDelayMs`, default 120ms ≈ <500 req/min, well under the
 * published 200 req/10s on trade-style surfaces) + bounded per-page retries via fetchJson. `maxPages`
 * caps the crawl; `onProgress(pageRows, totalSoFar)` lets a caller stream/cap.
 *
 * Total: stops at the first short/empty page (fewer than `limit` rows = last page). Returns the
 * concatenated parsed activity in upstream order (default newest-first; pass sortDirection:'ASC' for
 * oldest-first FIFO ingest).
 */
export async function fetchActivity(
  fetchJson: FetchJsonLike,
  address: string,
  opts: {
    type?: 'TRADE' | 'REDEEM' | 'ALL';
    start?: number;
    end?: number;
    limit?: number;
    sortDirection?: 'ASC' | 'DESC';
    maxPages?: number;
    pageDelayMs?: number;
    timeoutMs?: number;
    retries?: number;
    onProgress?: (pageRows: WalletActivity[], totalSoFar: number) => void;
  } = {},
): Promise<WalletActivity[]> {
  const limit = Math.min(opts.limit ?? 500, 500);
  const maxPages = opts.maxPages ?? Infinity;
  const pageDelayMs = opts.pageDelayMs ?? 120;
  const sortDirection = opts.sortDirection ?? 'DESC';
  const out: WalletActivity[] = [];

  for (let page = 0; page < maxPages; page++) {
    if (page > 0 && pageDelayMs > 0) await sleep(pageDelayMs);
    const offset = page * limit;
    let url = `${POLYMARKET_DATA_API}/activity?user=${encodeURIComponent(address)}&limit=${limit}&offset=${offset}` +
      `&sortBy=TIMESTAMP&sortDirection=${sortDirection}`;
    if (opts.type && opts.type !== 'ALL') url += `&type=${opts.type}`;
    if (typeof opts.start === 'number') url += `&start=${Math.trunc(opts.start)}`;
    if (typeof opts.end === 'number') url += `&end=${Math.trunc(opts.end)}`;

    const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, {
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
    });
    // A non-array page (shouldn't happen on 200) ends the crawl rather than throwing.
    const rawLen = Array.isArray(payload) ? payload.length : 0;
    const rows = parseActivity(payload);
    out.push(...rows);
    opts.onProgress?.(rows, out.length);
    if (rawLen < limit) break; // short/empty page = last page
  }
  return out;
}

/**
 * Batch-resolve gamma market metadata for a list of conditionIds → Map(conditionId → MarketMeta).
 * Chunks the ids (default 50/req — gamma accepts repeated `condition_ids=` params) with a small
 * inter-chunk delay; merges every chunk into one Map. Pure parsing via parseMarketsMeta; total —
 * an unresolved id is simply absent from the Map (gamma omits archived/unknown markets). Dedupes ids.
 */
export async function resolveMarketsMeta(
  fetchJson: FetchJsonLike,
  conditionIds: string[],
  opts: { chunkSize?: number; pageDelayMs?: number; timeoutMs?: number; retries?: number } = {},
): Promise<Map<string, MarketMeta>> {
  const chunkSize = Math.min(opts.chunkSize ?? 50, 50);
  const pageDelayMs = opts.pageDelayMs ?? 120;
  const ids = [...new Set(conditionIds.filter((id) => typeof id === 'string' && id !== ''))];
  const map = new Map<string, MarketMeta>();
  for (let i = 0; i < ids.length; i += chunkSize) {
    if (i > 0 && pageDelayMs > 0) await sleep(pageDelayMs);
    const chunk = ids.slice(i, i + chunkSize);
    const qs = chunk.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&');
    const url = `${POLYMARKET_GAMMA_API}/markets?${qs}&limit=${chunkSize}`;
    const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, {
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
    });
    for (const [k, v] of parseMarketsMeta(payload)) map.set(k, v);
  }
  return map;
}
