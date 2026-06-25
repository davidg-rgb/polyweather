/**
 * sharps-snapshot — the daily SPORTS-leaderboard roster + per-trader fingerprint tick (migration 0059).
 * SPORTS-TRADERS.md §3–4.
 *
 * One idempotent run: pull the SPORTS leaderboard across 4 time-period combos (DAY/WEEK/MONTH/ALL ×
 * PNL), dedup by wallet (keep the row with the most filled-in fields), and bulk-insert the capture into
 * sports_sharps via record_sports_sharps. Lightweight fingerprint computed inline (volume-machine vs
 * high-roi-specialist archetype; entry-odds histogram; sweep/burst fraction; mid-odds fraction; VWAP;
 * sub-sport mix). Bounds to 200 fills per wallet via /trades?user — within the cron wall-time budget.
 *
 * NOT trading — analytics / insight page only; copy-trade rail DORMANT (9th signal, FINDINGS.md §9).
 * Best-effort: a Polymarket outage just yields a smaller/empty capture, never a failed job.
 *
 * API surface (all public, keyless):
 *   GET  https://data-api.polymarket.com/v1/leaderboard?category=SPORTS&timePeriod=X&orderBy=PNL&limit=50
 *   GET  https://data-api.polymarket.com/trades?user=<wallet>&takerOnly=false&limit=200
 *   POST https://clob.polymarket.com/books  (batch YES-token book snapshot — mid-odds ref for fingerprint)
 */
import type { FetchJsonLike } from '../_shared/polymarket-wallet.ts';
import type { JobCtx, JobStats } from '../_shared/runJob.ts';

const DATA_API = 'https://data-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';
const REQUEST_HEADERS = { 'User-Agent': 'polyweather-analytics/1.0', Accept: 'application/json' };

export interface SharpsSnapshotDeps {
  now: Date;
  fetchJson: FetchJsonLike;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Leaderboard fetch + parse (SPORTS category, keyless)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface RawLeader {
  rank?: unknown;
  proxyWallet?: unknown;
  userName?: unknown;
  pnl?: unknown;
  vol?: unknown;
}

export interface Leader {
  rank: number;
  wallet: string;
  traderName: string;
  pnlAllUsd: number;
  volAllUsd: number;
  roiProxy: number; // pnl / vol (null-safe; 0 when vol=0)
}

const toN = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

export function parseLeaders(payload: unknown): Leader[] {
  if (!Array.isArray(payload)) return [];
  const out: Leader[] = [];
  for (const raw of payload as RawLeader[]) {
    if (!raw || typeof raw.proxyWallet !== 'string' || raw.proxyWallet === '') continue;
    const pnl = toN(raw.pnl) ?? 0;
    const vol = toN(raw.vol) ?? 0;
    const rank = toN(raw.rank);
    out.push({
      rank: rank === null ? 0 : Math.trunc(rank),
      wallet: raw.proxyWallet,
      traderName: typeof raw.userName === 'string' && raw.userName !== '' ? raw.userName : raw.proxyWallet,
      pnlAllUsd: pnl,
      volAllUsd: vol,
      roiProxy: vol > 0 ? pnl / vol : 0,
    });
  }
  return out;
}

async function fetchSportsLeaderboard(
  fetchJson: FetchJsonLike,
  timePeriod: string,
  limit: number,
  log: (m: string, e?: Record<string, unknown>) => void,
): Promise<Leader[]> {
  const url = `${DATA_API}/v1/leaderboard?category=SPORTS&timePeriod=${timePeriod}&orderBy=PNL&limit=${limit}`;
  try {
    const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, { timeoutMs: 8000, retries: 1 });
    return parseLeaders(payload);
  } catch (e) {
    log('leaderboard fetch failed (non-fatal)', { timePeriod, error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Trade fetch + fingerprint computation (per wallet)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface RawTrade {
  side?: unknown;
  price?: unknown;
  size?: unknown;
  timestamp?: unknown;
  outcome?: unknown;
  slug?: unknown;
}

export interface ParsedTrade {
  side: 'BUY' | 'SELL';
  price: number;
  sizeShares: number;
  notionalUsd: number;
  timestamp: number;
  outcome: string;
  slug: string;
}

export function parseTrades(payload: unknown): ParsedTrade[] {
  if (!Array.isArray(payload)) return [];
  const out: ParsedTrade[] = [];
  for (const raw of payload as RawTrade[]) {
    if (!raw) continue;
    const price = toN(raw.price);
    const size = toN(raw.size);
    const ts = toN(raw.timestamp);
    if (price === null || size === null || ts === null) continue;
    const sideRaw = typeof raw.side === 'string' ? raw.side.toUpperCase() : '';
    const side: 'BUY' | 'SELL' = sideRaw === 'SELL' ? 'SELL' : 'BUY';
    out.push({
      side,
      price,
      sizeShares: size,
      notionalUsd: price * size,
      timestamp: Math.trunc(ts),
      outcome: typeof raw.outcome === 'string' ? raw.outcome : '',
      slug: typeof raw.slug === 'string' ? raw.slug : '',
    });
  }
  return out;
}

async function fetchWalletTrades(
  fetchJson: FetchJsonLike,
  wallet: string,
  limit: number,
  log: (m: string, e?: Record<string, unknown>) => void,
): Promise<ParsedTrade[]> {
  const url = `${DATA_API}/trades?user=${encodeURIComponent(wallet)}&takerOnly=false&limit=${limit}`;
  try {
    const payload = await fetchJson(url, { headers: REQUEST_HEADERS }, { timeoutMs: 8000, retries: 1 });
    return parseTrades(payload);
  } catch (e) {
    log('wallet trades fetch failed (non-fatal)', { wallet: wallet.slice(0, 10), error: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

/** Simple sub-sport heuristic from market slug (no DB join — best-effort slug keyword matching). */
export function inferSport(slug: string): string {
  const s = slug.toLowerCase();
  if (/soccer|football|premier|bundesliga|serie|laliga|mls|ucl|world.cup/.test(s)) return 'soccer';
  if (/nba|basketball|lakers|celtics|bucks|warriors/.test(s)) return 'basketball';
  if (/nfl|american.football|superbowl|super.bowl/.test(s)) return 'americanfootball';
  if (/mlb|baseball/.test(s)) return 'baseball';
  if (/nhl|hockey/.test(s)) return 'hockey';
  if (/tennis|wimbledon|us.open|french.open|roland/.test(s)) return 'tennis';
  if (/ufc|mma|boxing/.test(s)) return 'mma';
  if (/golf|pga|masters/.test(s)) return 'golf';
  if (/cricket/.test(s)) return 'cricket';
  return 'other';
}

/** Odds histogram bucket boundaries (the fingerprint's entry-price distribution). */
const HIST_BINS: { label: string; lo: number; hi: number }[] = [
  { label: '≤5¢', lo: 0, hi: 0.05 },
  { label: '5–15¢', lo: 0.05, hi: 0.15 },
  { label: '15–30¢', lo: 0.15, hi: 0.30 },
  { label: '30–50¢', lo: 0.30, hi: 0.50 },
  { label: '50–70¢', lo: 0.50, hi: 0.70 },
  { label: '70–85¢', lo: 0.70, hi: 0.85 },
  { label: '>85¢', lo: 0.85, hi: 1.01 },
];

export interface TraderFingerprint {
  nFills: number;
  sweepFraction: number;
  midOddsFraction: number;
  vwapEntry: number;
  sportsMix: Record<string, number>;
  oddsHistogram: { label: string; lo: number; hi: number; count: number; notionalUsd: number }[];
  archetype: 'volume-machine' | 'high-roi-specialist';
}

export function computeFingerprint(trades: ParsedTrade[], roiProxy: number): TraderFingerprint {
  const buys = trades.filter((t) => t.side === 'BUY' && t.price > 0 && t.price < 1);
  const nFills = buys.length;

  // Sweep / burst: the study's sharp signature (SPORTS-TRADERS.md §1) is the same-second book-sweep —
  // multiple fills sharing one timestamp (a fast bot taking every cheap offer as a match breaks; mintblade
  // was 98.6% same-second). A buy is "in a burst" if ≥2 of the wallet's buys share its exact
  // (second-granularity) timestamp. This is the actual fingerprint the page labels "sweep/burst %".
  const tsCounts = new Map<number, number>();
  for (const t of buys) tsCounts.set(t.timestamp, (tsCounts.get(t.timestamp) ?? 0) + 1);
  const sweepFraction = nFills > 0
    ? buys.filter((t) => (tsCounts.get(t.timestamp) ?? 0) >= 2).length / nFills
    : 0;

  // Mid-odds: 0.35 ≤ price ≤ 0.65 — balanced, not extreme-longshot or near-certain.
  const midOddsFraction = nFills > 0 ? buys.filter((t) => t.price >= 0.35 && t.price <= 0.65).length / nFills : 0;

  // Volume-weighted average price (VWAP) over buys.
  const totalNotional = buys.reduce((a, t) => a + t.notionalUsd, 0);
  const vwapEntry = totalNotional > 0
    ? buys.reduce((a, t) => a + t.price * t.notionalUsd, 0) / totalNotional
    : 0;

  // Sub-sport mix (by notional).
  const sportNotional: Record<string, number> = {};
  for (const t of buys) {
    const sport = inferSport(t.slug);
    sportNotional[sport] = (sportNotional[sport] ?? 0) + t.notionalUsd;
  }
  const sportsMix: Record<string, number> = {};
  if (totalNotional > 0) {
    for (const [sport, usd] of Object.entries(sportNotional)) {
      sportsMix[sport] = usd / totalNotional;
    }
  }

  // Odds histogram.
  const oddsHistogram = HIST_BINS.map((bin) => {
    const inBin = buys.filter((t) => t.price >= bin.lo && t.price < bin.hi);
    return {
      label: bin.label,
      lo: bin.lo,
      hi: bin.hi,
      count: inBin.length,
      notionalUsd: inBin.reduce((a, t) => a + t.notionalUsd, 0),
    };
  });

  // Archetype: volume-machines have high fill counts + low ROI proxy; specialists have lower counts + higher ROI.
  const archetype: 'volume-machine' | 'high-roi-specialist' =
    nFills >= 50 && roiProxy < 0.05 ? 'volume-machine' : 'high-roi-specialist';

  return { nFills, sweepFraction, midOddsFraction, vwapEntry, sportsMix, oddsHistogram, archetype };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// Main handler
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const LEADERBOARD_PERIODS = ['ALL', 'MONTH', 'WEEK', 'DAY'] as const;
const LEADERBOARD_LIMIT = 50;
const TRADES_LIMIT = 200; // bounded per wallet for cron wall-time budget

export async function sharpsSnapshot(ctx: JobCtx, deps: SharpsSnapshotDeps): Promise<JobStats> {
  const { db, log } = ctx;
  const capturedAt = deps.now.toISOString();

  // Step 1: pull the SPORTS leaderboard across all periods, dedup by wallet.
  // Keep the row with the highest absolute PnL (the most informative single snapshot per wallet).
  const walletMap = new Map<string, Leader>();
  let totalLeaderRows = 0;
  for (const period of LEADERBOARD_PERIODS) {
    const leaders = await fetchSportsLeaderboard(deps.fetchJson, period, LEADERBOARD_LIMIT, log);
    totalLeaderRows += leaders.length;
    for (const l of leaders) {
      const existing = walletMap.get(l.wallet);
      if (!existing || Math.abs(l.pnlAllUsd) > Math.abs(existing.pnlAllUsd)) {
        walletMap.set(l.wallet, l);
      }
    }
  }

  const wallets = [...walletMap.values()];
  log('leaderboard fetched', { periods: LEADERBOARD_PERIODS.length, rawRows: totalLeaderRows, uniqueWallets: wallets.length });

  if (wallets.length === 0) {
    log('no SPORTS leaderboard entries — empty capture');
    return { asOf: capturedAt, wallets: 0, inserted: 0 };
  }

  // Step 2: per-wallet trades + fingerprint (bounded to TRADES_LIMIT fills).
  const rows: Record<string, unknown>[] = [];
  for (const leader of wallets) {
    const trades = await fetchWalletTrades(deps.fetchJson, leader.wallet, TRADES_LIMIT, log);
    const fp = computeFingerprint(trades, leader.roiProxy);
    rows.push({
      capturedAt,
      wallet: leader.wallet,
      traderName: leader.traderName,
      rank: leader.rank,
      pnlAllUsd: leader.pnlAllUsd,
      volAllUsd: leader.volAllUsd,
      roiProxy: leader.roiProxy,
      archetype: fp.archetype,
      nFills: fp.nFills,
      sweepFraction: fp.sweepFraction,
      midOddsFraction: fp.midOddsFraction,
      vwapEntry: fp.vwapEntry,
      sportsMix: JSON.stringify(fp.sportsMix),
      oddsHistogram: JSON.stringify(fp.oddsHistogram),
    });
  }

  // Step 3: bulk insert.
  let inserted = 0;
  if (rows.length > 0) {
    const res = await db.rpc<{ record_sports_sharps: number }>('record_sports_sharps', { p_rows: rows });
    inserted = Number(res[0]?.record_sports_sharps ?? rows.length);
  }

  const stats = { asOf: capturedAt, wallets: wallets.length, tradesPulled: rows.reduce((a, r) => a + (Number(r.nFills) || 0), 0), inserted };
  log('sharps-snapshot complete', stats);
  return stats;
}
