/**
 * scripts/research/whale-insider-scan — forensic scan for likely INSIDER-INFORMATION wallets among
 * Polymarket "whales" (single fills ≥ $threshold) over a trailing window. Operator ask (2026-06-24):
 * *"run an extensive analysis of trades above $100k for the past 6 months; identify users with a high
 * amount of wins on big bets and the best net profit — the theory is that individuals with a certain
 * behaviour act on insider information and we want to isolate those users."*
 *
 * READ-ONLY analytics — places no trades (the live-trading rail stays DORMANT per CLAUDE.md / FINDINGS.md).
 * Sibling of the whale-watch alarm (0055) and the sharp-wallet tracker (0049); same keyless Polymarket data
 * client (packages/io/src/polymarket-wallet.ts).
 *
 * ── DATA PLAN (live-verified API constraints, 2026-06-24) ───────────────────────────────────────────────
 *  DISCOVER whales:
 *   • global /trades?filterType=CASH&filterAmount=N — the only enumeration of large fills, but hard-caps at
 *     offset 3000, times out past ~offset 600, IGNORES start/end → used only for RECENTLY-active whales.
 *   • /v1/leaderboard?orderBy=PNL (offset-pageable, 50/pg, ALL+MONTH) → biggest net-profit wallets ("best
 *     net profit"), regardless of recency.
 *  PER WALLET:
 *   • /trades?user=W&filterType=CASH&filterAmount=N → that wallet's big fills newest-first (cut to the window
 *     client-side — the endpoint has no time param) = the exact, cheap big-bet extractor.
 *  GRADE (per fill, held-to-resolution):
 *   • CLOB /markets/{conditionId} → tokens[].winner — the AUTHORITATIVE winning outcome (serves archived
 *     markets). Each big fill is marked to its market's resolution; cached + shared across wallets.
 *   • user-pnl → lifetime realized P&L (corroboration column).
 *
 * ── THE INSIDER DISCRIMINATOR ───────────────────────────────────────────────────────────────────────────
 *  Net profit + a high win rate alone do NOT imply information: buying at 0.97 and winning is skill-free, and
 *  SELLING a near-certain YES at 0.999 is just profit-taking. Under an EFFICIENT market a bet entered at price
 *  p wins with probability p, so over a wallet's resolved big bets expected wins = Σ p (the odds it paid). A
 *  wallet whose ACTUAL wins ≫ Σ p — Poisson-binomial z = (wins − Σp)/sqrt(Σ p(1−p)) — is winning far more than
 *  its entry odds implied. We measure z over INDEPENDENT MARKETS (not fills, so splitting a bet can't fake
 *  significance) and EXCLUDE near-certain entries (price ≥ 0.98 / ≤ 0.02 — pure microstructure, no information
 *  content). Excess wins at non-trivial odds, shortly before resolution, is the behavioural signature we flag:
 *  watchlist = (≥ min-resolved non-trivial big bets) ∧ (z ≥ z-flag) ∧ (held-to-resolution profit > 0).
 *
 * Run: pnpm tsx scripts/research/whale-insider-scan.ts
 *        [--threshold 100000] [--days 180] [--min-resolved 4] [--z-flag 3]
 *        [--feed-pages 2] [--lb-pages-all 8] [--lb-pages-month 4] [--concurrency 6]
 *        [--quick] [--out scripts/research/out/whale-insider-scan.json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchJson } from '../../packages/io/src/index.ts';
import {
  fetchTrades,
  fetchUserPnlSeries,
  parseLeaderboard,
  POLYMARKET_DATA_API,
  SHARP_WALLET_ADDRESS,
  type LeaderboardEntry,
  type Trade,
} from '../../packages/io/src/polymarket-wallet.ts';

const CLOB_API = 'https://clob.polymarket.com';
const REQUEST_HEADERS = { 'User-Agent': 'polyweather-analytics/1.0', Accept: 'application/json' };
const DAY = 86_400;
/** Entries this near to 0/1 carry ~no information (pure microstructure) → excluded from the z statistic. */
const EXTREME_LO = 0.02;
const EXTREME_HI = 0.98;
/** Lead time (days, bet→resolution) at/under which a win is "live/last-minute" (e.g. in-game sports), not early information. */
const LIVE_LEAD_DAYS = 1;
/** An "informative" entry — odds not already near-decided — for the insider-shaped statistic. */
const INFO_ODDS_HI = 0.9;

type Category = 'sports' | 'crypto' | 'politics' | 'weather' | 'macro' | 'other';
/**
 * Coarse market category from title/slug. The point is to separate SPORTS (huge, live-tradeable — a high win
 * rate there is skill/live-betting, not material non-public info) from the markets where "insider" information
 * is the natural explanation (a crypto move, a political/appointment outcome, a world event). Best-effort, total.
 */
function categorize(title: string, slug: string): Category {
  const t = `${title} ${slug}`.toLowerCase();
  if (/temperature-in-|highest temperature|lowest temperature/.test(t)) return 'weather';
  if (
    /\bvs\.?\b|spread:|o\/u|moneyline|\b(nba|nfl|nhl|mlb|epl|ufc|atp|wta|cfb|laliga|serie a|bundesliga)\b|\bwin on \d{4}-\d{2}-\d{2}|\bopen:|\bgrand prix\b|dota|valorant|counter-strike|league of legends|\bcs2\b/.test(
      t,
    )
  )
    return 'sports';
  if (/bitcoin|ethereum|\bbtc\b|\beth\b|solana|\bxrp\b|crypto|dogecoin|price of|\$\d+k? by|reach \$/.test(t)) return 'crypto';
  if (/election|president|nominee|congress|senate|\btrump\b|\bbiden\b|government|prime minister|cabinet|resign|impeach|parliament|\bfed\b|nominee|appoint/.test(t)) return 'politics';
  if (/\b(cpi|inflation|rate cut|interest rate|gdp|jobs report|recession|tariff)\b/.test(t)) return 'macro';
  return 'other';
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const commas = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const usd = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n < 0 ? '-$' : '$'}${commas(Math.abs(n))}`;
const pct = (n: number | null | undefined, dp = 1): string =>
  n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(dp)}%`;
const dayStr = (tsSec: number): string => new Date(tsSec * 1000).toISOString().slice(0, 10);
const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
const padL = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s.padStart(n));
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Bounded-concurrency map; resolves in input order. */
async function mapPool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── discovery feeds ─────────────────────────────────────────────────────────────────────────────────────
async function fetchPnlLeaderboard(timePeriod: 'ALL' | 'MONTH' | 'WEEK', pages: number): Promise<LeaderboardEntry[]> {
  const out: LeaderboardEntry[] = [];
  for (let p = 0; p < pages; p++) {
    const url = `${POLYMARKET_DATA_API}/v1/leaderboard?timePeriod=${timePeriod}&orderBy=PNL&limit=50&offset=${p * 50}`;
    try {
      const rows = parseLeaderboard(await fetchJson(url, { headers: REQUEST_HEADERS }, { timeoutMs: 15_000, retries: 2 }));
      out.push(...rows);
      if (rows.length < 50) break;
    } catch (e) {
      process.stderr.write(`  leaderboard ${timePeriod} p${p} failed: ${msg(e)}\n`);
      break;
    }
  }
  return out;
}

async function fetchRecentWhaleFeed(threshold: number, pages: number): Promise<Trade[]> {
  const out: Trade[] = [];
  for (let p = 0; p < pages; p++) {
    try {
      const rows = await fetchTrades(fetchJson, {
        filterType: 'CASH',
        filterAmount: threshold,
        takerOnly: true,
        limit: 500,
        offset: p * 500,
        maxPages: 1,
        timeoutMs: 20_000,
        retries: 3,
      });
      out.push(...rows);
      if (rows.length < 500) break;
    } catch (e) {
      process.stderr.write(`  whale-feed page ${p} failed (offset cap/timeout): ${msg(e)}\n`);
      break;
    }
  }
  return out;
}

// ── market resolution (authoritative winner via CLOB; cached + shared) ──────────────────────────────────
interface MarketResolution {
  resolved: boolean;
  winnerOutcome: string | null;
  endTs: number | null;
}
async function fetchMarketResolution(cid: string): Promise<MarketResolution> {
  try {
    const d = (await fetchJson(`${CLOB_API}/markets/${cid}`, { headers: REQUEST_HEADERS }, {
      timeoutMs: 12_000,
      retries: 2,
    })) as Record<string, unknown>;
    const tokens = Array.isArray(d?.tokens) ? (d.tokens as Record<string, unknown>[]) : [];
    const closed = d?.closed === true;
    const winTok = tokens.find((t) => t?.winner === true);
    const endIso = typeof d?.end_date_iso === 'string' ? (d.end_date_iso as string) : null;
    const endTs = endIso ? Math.floor(Date.parse(endIso) / 1000) : null;
    return {
      resolved: closed && winTok != null,
      winnerOutcome: typeof winTok?.outcome === 'string' ? (winTok.outcome as string) : null,
      endTs: Number.isFinite(endTs) ? endTs : null,
    };
  } catch {
    return { resolved: false, winnerOutcome: null, endTs: null };
  }
}

// ── per-wallet model ────────────────────────────────────────────────────────────────────────────────────
interface BigBetMarket {
  conditionId: string;
  title: string;
  eventSlug: string;
  category: Category;
  side: 'BUY' | 'SELL' | 'MIXED';
  bigFillCount: number;
  bigNotionalUsd: number;
  entryPrice: number; // notional-weighted price of the big fills
  impliedPwin: number; // notional-weighted P(profit) under efficiency: BUY→price, SELL→1−price
  extreme: boolean; // near-certain entry → excluded from the z statistic
  /** Insider-shaped bet: non-extreme odds, entry ≤ INFO_ODDS_HI, placed > LIVE_LEAD_DAYS before resolution, non-sports. */
  informative: boolean;
  firstBigTs: number;
  lastBigTs: number;
  resolved: boolean;
  win: boolean | null; // held-to-resolution P&L of the big fills > 0
  heldPnlUsd: number | null; // held-to-resolution P&L of the big fills
  daysToResolve: number | null;
}
interface WalletReport {
  address: string;
  label: string;
  lbPnlAllUsd: number | null;
  lifetimePnlUsd: number | null;
  nBigFills: number;
  nBigMarkets: number;
  totalBigNotionalUsd: number;
  nResolved: number; // resolved big-bet markets
  nWins: number;
  nLosses: number;
  winRate: number | null; // over all resolved big-bet markets
  netBigBetPnlUsd: number; // Σ held-to-resolution P&L over resolved big bets
  nUnresolved: number;
  openExposureUsd: number; // notional of unresolved big bets
  // insider statistic — over NON-EXTREME resolved markets only
  nz: number; // count of non-trivial resolved markets
  nzWins: number;
  expectedWins: number;
  z: number | null;
  edgePp: number | null; // (nzWinRate − mean implied) ×100
  wAvgEntryPrice: number | null;
  // insider-shaped subset (non-sports, informative odds, lead time)
  nInfo: number;
  infoWins: number;
  zInfo: number | null;
  infoPnlUsd: number;
  catNotional: Record<Category, number>;
  domCategory: Category;
  sportsShare: number; // fraction of resolved big-notional that is sports
  flagged: boolean;
  infoFlagged: boolean;
  markets: BigBetMarket[];
}

function buildWalletReport(
  address: string,
  label: string,
  lbPnlAllUsd: number | null,
  bigFills: Trade[],
  resByCid: Map<string, MarketResolution>,
  lifetimePnlUsd: number | null,
  minResolved: number,
  zFlag: number,
): WalletReport {
  const groups = new Map<string, Trade[]>();
  for (const t of bigFills) {
    if (t.conditionId === '') continue;
    const g = groups.get(t.conditionId);
    if (g) g.push(t);
    else groups.set(t.conditionId, [t]);
  }

  const markets: BigBetMarket[] = [];
  for (const [cid, fills] of groups) {
    const bigNotional = fills.reduce((s, f) => s + f.notionalUsd, 0);
    const entryPrice = bigNotional > 0 ? fills.reduce((s, f) => s + f.notionalUsd * f.price, 0) / bigNotional : 0;
    const impliedPwin =
      bigNotional > 0
        ? fills.reduce((s, f) => s + f.notionalUsd * (f.side === 'SELL' ? 1 - f.price : f.price), 0) / bigNotional
        : 0;
    const buyN = fills.filter((f) => f.side === 'BUY').reduce((s, f) => s + f.notionalUsd, 0);
    const sellN = fills.filter((f) => f.side === 'SELL').reduce((s, f) => s + f.notionalUsd, 0);
    const side: 'BUY' | 'SELL' | 'MIXED' = buyN > 0 && sellN > 0 ? 'MIXED' : sellN > buyN ? 'SELL' : 'BUY';
    const tss = fills.map((f) => f.timestamp);
    const lastBigTs = Math.max(...tss);

    const res = resByCid.get(cid) ?? { resolved: false, winnerOutcome: null, endTs: null };
    let resolved = false;
    let win: boolean | null = null;
    let heldPnlUsd: number | null = null;
    let daysToResolve: number | null = null;
    if (res.resolved) {
      resolved = true;
      // held-to-resolution P&L summed over the big fills (inventory-correct: each fill is cash↔shares, marked
      // to the resolved winner). BUY of outcome O: shares×((O won?1:0)−price); SELL: shares×(price−(O won?1:0)).
      heldPnlUsd = fills.reduce((s, f) => {
        const oWon = f.outcome === res.winnerOutcome ? 1 : 0;
        return s + (f.side === 'SELL' ? f.sizeShares * (f.price - oWon) : f.sizeShares * (oWon - f.price));
      }, 0);
      win = heldPnlUsd > 0;
      if (res.endTs != null) daysToResolve = Math.max(0, (res.endTs - lastBigTs) / DAY);
    }
    const category = categorize(fills[0]!.title, fills[0]!.eventSlug);
    const extreme = entryPrice >= EXTREME_HI || entryPrice <= EXTREME_LO;
    const informative =
      !extreme &&
      entryPrice <= INFO_ODDS_HI &&
      category !== 'sports' &&
      (daysToResolve == null || daysToResolve > LIVE_LEAD_DAYS);
    markets.push({
      conditionId: cid,
      title: fills[0]!.title,
      eventSlug: fills[0]!.eventSlug,
      category,
      side,
      bigFillCount: fills.length,
      bigNotionalUsd: bigNotional,
      entryPrice,
      impliedPwin,
      extreme,
      informative,
      firstBigTs: Math.min(...tss),
      lastBigTs,
      resolved,
      win,
      heldPnlUsd,
      daysToResolve,
    });
  }

  const resolvedM = markets.filter((m) => m.resolved);
  const unresolvedM = markets.filter((m) => !m.resolved);
  const nResolved = resolvedM.length;
  const nWins = resolvedM.filter((m) => m.win === true).length;
  const nLosses = nResolved - nWins;
  const netBigBetPnlUsd = resolvedM.reduce((s, m) => s + (m.heldPnlUsd ?? 0), 0);

  // win-rate-edge statistic over non-extreme resolved markets
  const nzM = resolvedM.filter((m) => !m.extreme);
  const nz = nzM.length;
  const nzWins = nzM.filter((m) => m.win === true).length;
  const expectedWins = nzM.reduce((s, m) => s + m.impliedPwin, 0);
  const varExp = nzM.reduce((s, m) => s + m.impliedPwin * (1 - m.impliedPwin), 0);
  const z = varExp > 1e-9 ? (nzWins - expectedWins) / Math.sqrt(varExp) : null;
  const nzNotional = nzM.reduce((s, m) => s + m.bigNotionalUsd, 0);
  const wAvgEntryPrice = nzNotional > 0 ? nzM.reduce((s, m) => s + m.bigNotionalUsd * m.entryPrice, 0) / nzNotional : null;
  const meanImplied = nz > 0 ? expectedWins / nz : null;
  const edgePp = nz > 0 && meanImplied != null ? (nzWins / nz - meanImplied) * 100 : null;

  // INSIDER-SHAPED statistic — the same z restricted to "informative" bets: non-sports, non-near-decided
  // odds, placed with lead time before resolution. Strips out live in-game sports trading & favorite-backing
  // (skill, not material non-public info), isolating the "knew something early, odds hadn't moved" tell.
  const infoM = resolvedM.filter((m) => m.informative);
  const nInfo = infoM.length;
  const infoWins = infoM.filter((m) => m.win === true).length;
  const infoExp = infoM.reduce((s, m) => s + m.impliedPwin, 0);
  const infoVar = infoM.reduce((s, m) => s + m.impliedPwin * (1 - m.impliedPwin), 0);
  const zInfo = infoVar > 1e-9 ? (infoWins - infoExp) / Math.sqrt(infoVar) : null;
  const infoPnl = infoM.reduce((s, m) => s + (m.heldPnlUsd ?? 0), 0);

  // category mix (by big-notional) of the resolved bets — what is this whale actually betting on?
  const catNotional: Record<Category, number> = { sports: 0, crypto: 0, politics: 0, weather: 0, macro: 0, other: 0 };
  for (const m of resolvedM) catNotional[m.category] += m.bigNotionalUsd;

  const flagged = nz >= minResolved && z != null && z >= zFlag && netBigBetPnlUsd > 0;
  const infoFlagged = nInfo >= minResolved && zInfo != null && zInfo >= zFlag && infoPnl > 0;

  return {
    address,
    label,
    lbPnlAllUsd,
    lifetimePnlUsd,
    nBigFills: bigFills.length,
    nBigMarkets: markets.length,
    totalBigNotionalUsd: markets.reduce((s, m) => s + m.bigNotionalUsd, 0),
    nResolved,
    nWins,
    nLosses,
    winRate: nResolved > 0 ? nWins / nResolved : null,
    netBigBetPnlUsd,
    nUnresolved: unresolvedM.length,
    openExposureUsd: unresolvedM.reduce((s, m) => s + m.bigNotionalUsd, 0),
    nz,
    nzWins,
    expectedWins,
    z,
    edgePp,
    wAvgEntryPrice,
    nInfo,
    infoWins,
    zInfo,
    infoPnlUsd: infoPnl,
    catNotional,
    domCategory: (Object.entries(catNotional).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other') as Category,
    sportsShare: (() => {
      const tot = Object.values(catNotional).reduce((s, v) => s + v, 0);
      return tot > 0 ? catNotional.sports / tot : 0;
    })(),
    flagged,
    infoFlagged,
    markets: markets.sort((a, b) => (b.heldPnlUsd ?? 0) - (a.heldPnlUsd ?? 0)),
  };
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      threshold: { type: 'string' },
      days: { type: 'string' },
      'min-resolved': { type: 'string' },
      'z-flag': { type: 'string' },
      'feed-pages': { type: 'string' },
      'lb-pages-all': { type: 'string' },
      'lb-pages-month': { type: 'string' },
      concurrency: { type: 'string' },
      quick: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  const threshold = Number(values.threshold ?? 100_000);
  const days = Number(values.days ?? 180);
  const minResolved = Number(values['min-resolved'] ?? 4);
  const zFlag = Number(values['z-flag'] ?? 3);
  const quick = values.quick === true;
  const feedPages = Number(values['feed-pages'] ?? (quick ? 1 : 2));
  const lbPagesAll = Number(values['lb-pages-all'] ?? (quick ? 2 : 8));
  const lbPagesMonth = Number(values['lb-pages-month'] ?? (quick ? 1 : 4));
  const concurrency = Number(values.concurrency ?? 6);
  const outPath = values.out ?? 'scripts/research/out/whale-insider-scan.json';

  const nowSec = Math.floor(Date.now() / 1000);
  const cutoff = nowSec - days * DAY;
  const log = (s: string) => process.stderr.write(s + '\n');

  log(`\n🐋 Whale-insider scan — fills ≥ ${usd(threshold)}, trailing ${days}d (since ${dayStr(cutoff)})`);
  log('──────────────────────────────────────────────────────────────────────────────');

  // 1. DISCOVERY
  log('1. Discovery: global whale feed + PNL leaderboards…');
  const [feed, lbAll, lbMonth] = await Promise.all([
    fetchRecentWhaleFeed(threshold, feedPages),
    fetchPnlLeaderboard('ALL', lbPagesAll),
    fetchPnlLeaderboard('MONTH', lbPagesMonth),
  ]);
  log(`   • recent ≥${usd(threshold)} feed: ${feed.length} fills (${new Set(feed.map((t) => t.proxyWallet)).size} wallets)`);
  log(`   • PNL leaderboard ALL: ${lbAll.length} · MONTH: ${lbMonth.length}`);

  const label = new Map<string, string>();
  const lbPnl = new Map<string, number>();
  const candidates = new Set<string>();
  const add = (addr: string, lbl: string | null, pnl: number | null) => {
    const a = addr.toLowerCase();
    if (!a.startsWith('0x') || a.length < 10) return;
    candidates.add(a);
    if (lbl && lbl !== '' && !label.has(a)) label.set(a, lbl);
    if (pnl != null && !lbPnl.has(a)) lbPnl.set(a, pnl);
  };
  for (const t of feed) add(t.proxyWallet, t.traderName, null);
  for (const e of lbAll) add(e.address, e.label, e.pnlUsd);
  for (const e of lbMonth) add(e.address, e.label, e.pnlUsd);
  add(SHARP_WALLET_ADDRESS, 'badatmath.', null);
  const candList = [...candidates];
  log(`   → ${candList.length} candidate wallets\n`);

  // 2. PER-WALLET BIG-BET PULL (cheap filter first)
  log("2. Pulling each candidate's in-window big fills…");
  let probed = 0;
  const bigFillsByWallet = await mapPool(candList, concurrency, async (w) => {
    let fills: Trade[] = [];
    try {
      const raw = await fetchTrades(fetchJson, {
        user: w,
        filterType: 'CASH',
        filterAmount: threshold,
        takerOnly: false,
        limit: 500,
        maxPages: 5,
        timeoutMs: 15_000,
        retries: 2,
      });
      fills = raw.filter((f) => f.timestamp >= cutoff && f.notionalUsd >= threshold);
    } catch { /* non-fatal */ }
    if (++probed % 50 === 0) log(`   …probed ${probed}/${candList.length}`);
    return fills;
  });
  const survivorIdx = candList.map((_, i) => i).filter((i) => bigFillsByWallet[i]!.length > 0);
  log(`   → ${survivorIdx.length}/${candList.length} wallets bet ≥${usd(threshold)} in the window\n`);

  // 3. RESOLVE every distinct big-bet market (authoritative winner via CLOB; shared cache)
  const allCids = new Set<string>();
  for (const i of survivorIdx) for (const f of bigFillsByWallet[i]!) if (f.conditionId) allCids.add(f.conditionId);
  const cidList = [...allCids];
  log(`3. Resolving ${cidList.length} distinct big-bet markets (CLOB winner)…`);
  let resolvedN = 0;
  const resByCid = new Map<string, MarketResolution>();
  const resResults = await mapPool(cidList, Math.max(concurrency, 10), async (cid) => {
    const r = await fetchMarketResolution(cid);
    if (++resolvedN % 200 === 0) log(`   …resolved ${resolvedN}/${cidList.length}`);
    return [cid, r] as const;
  });
  for (const [cid, r] of resResults) resByCid.set(cid, r);
  log(`   → ${[...resByCid.values()].filter((r) => r.resolved).length}/${cidList.length} markets settled\n`);

  // 4. GRADE survivors (+ lifetime PnL corroboration)
  log('4. Grading survivors…');
  let graded = 0;
  const reports = await mapPool(survivorIdx, concurrency, async (i) => {
    const w = candList[i]!;
    let lifetime: number | null = null;
    try {
      const series = await fetchUserPnlSeries(fetchJson, w, { timeoutMs: 15_000, retries: 1 });
      lifetime = series.length > 0 ? series[series.length - 1]!.cumPnlUsd : null;
    } catch { /* non-fatal */ }
    if (++graded % 25 === 0) log(`   …graded ${graded}/${survivorIdx.length}`);
    return buildWalletReport(
      w, label.get(w) ?? w, lbPnl.get(w) ?? null, bigFillsByWallet[i]!, resByCid, lifetime, minResolved, zFlag,
    );
  });
  log(`   → graded ${reports.length} wallets\n`);

  // 5. RANK + REPORT
  const byNetProfit = [...reports].sort((a, b) => b.netBigBetPnlUsd - a.netBigBetPnlUsd);
  const byEdgeZ = reports
    .filter((r) => r.nz >= minResolved && r.z != null)
    .sort((a, b) => (b.z ?? -99) - (a.z ?? -99));
  const watchlist = reports
    .filter((r) => r.flagged)
    .sort((a, b) => (b.z ?? 0) - (a.z ?? 0) || b.netBigBetPnlUsd - a.netBigBetPnlUsd);

  const totalBigFills = reports.reduce((s, r) => s + r.nBigFills, 0);
  const totalBigNotional = reports.reduce((s, r) => s + r.totalBigNotionalUsd, 0);

  const lines: string[] = [];
  const P = (s = '') => {
    lines.push(s);
    console.log(s);
  };
  P('');
  P(`# Whale-insider scan — ≥${usd(threshold)} fills, trailing ${days}d`);
  P(`Generated ${new Date().toISOString()} · window ${dayStr(cutoff)} → ${dayStr(nowSec)}`);
  P('');
  P(`Candidates ${candList.length} · in-window big bettors ${survivorIdx.length} · distinct big markets ${cidList.length}`);
  P(`Total in-window ≥${usd(threshold)} fills: ${commas(totalBigFills)} · notional ${usd(totalBigNotional)}`);
  P('');

  const byInfoZ = reports
    .filter((r) => r.nInfo >= minResolved && r.zInfo != null)
    .sort((a, b) => (b.zInfo ?? -99) - (a.zInfo ?? -99));
  const infoWatchlist = reports
    .filter((r) => r.infoFlagged)
    .sort((a, b) => (b.zInfo ?? 0) - (a.zInfo ?? 0) || b.infoPnlUsd - a.infoPnlUsd);

  const fmtRow = (r: WalletReport, i: number): string =>
    `${padL(String(i + 1), 3)} ${pad(r.label, 20)} ${pad(r.address.slice(0, 8) + '…', 10)} ` +
    `mk ${padL(String(r.nBigMarkets), 3)} res ${padL(String(r.nResolved), 3)} ` +
    `W/L ${padL(`${r.nWins}/${r.nLosses}`, 7)} win ${padL(pct(r.winRate), 6)} ` +
    `cat ${pad(`${r.domCategory}(${Math.round(r.sportsShare * 100)}%sp)`, 14)} ` +
    `z ${padL(r.z == null ? '—' : r.z.toFixed(1), 5)} zInfo ${padL(`${r.zInfo == null ? '—' : r.zInfo.toFixed(1)}/${r.nInfo}`, 8)} ` +
    `held ${padL(usd(r.netBigBetPnlUsd), 11)} life ${padL(usd(r.lifetimePnlUsd), 11)}`;

  P('## A) Best NET PROFIT on in-window big bets (held-to-resolution P&L of the ≥$threshold fills)');
  P('    wallet               addr       mk  res  W/L     win    cat              z     zInfo/n  held         life');
  byNetProfit.slice(0, 30).forEach((r, i) => P(fmtRow(r, i)));
  P('');
  P(`## B) Highest WIN-RATE EDGE over entry odds (z; ≥${minResolved} non-trivial resolved bets)`);
  P('    Wins ≫ Σ(entry price), excluding near-certain (≥0.98/≤0.02) entries. NOTE: dominated by SPORTS sharps');
  P('    (incl. live in-game trading) — a high z here is skill, not necessarily information. See C for the filter.');
  P('    wallet               addr       mk  res  W/L     win    cat              z     zInfo/n  held         life');
  byEdgeZ.slice(0, 30).forEach((r, i) => P(fmtRow(r, i)));
  P('');
  P(`## C) ⚑ INFORMATION PROFILE — the insider-shaped lens (zInfo; ≥${minResolved} INFORMATIVE bets)`);
  P('    Same z but restricted to NON-sports markets, odds ≤0.90, placed >1d before resolution — i.e. "knew');
  P('    something early, the price had not moved yet." This is the subset where insider info is the natural read.');
  P('    wallet               addr       mk  res  W/L     win    cat              z     zInfo/n  held         life');
  byInfoZ.slice(0, 25).forEach((r, i) => P(fmtRow(r, i)));
  P('');

  const renderWatch = (r: WalletReport, i: number, mode: 'stat' | 'info') => {
    P('');
    P(`### ${i + 1}. ${r.label}  (${r.address})`);
    P(
      `   ${r.nBigMarkets} big bets · ${r.nResolved} resolved · ${r.nWins}W/${r.nLosses}L = ${pct(r.winRate)} · ` +
        `category mix: ${(Object.entries(r.catNotional) as [Category, number][])
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([c, v]) => `${c} ${usd(v)}`)
          .join(' · ')}`,
    );
    P(
      `   all-non-trivial z=${r.z?.toFixed(2)} (won ${r.nzWins}/${r.nz} vs ${r.expectedWins.toFixed(1)} exp) · ` +
        `INFORMATIVE-subset zInfo=${r.zInfo == null ? '—' : r.zInfo.toFixed(2)} (won ${r.infoWins}/${r.nInfo}, P&L ${usd(r.infoPnlUsd)})`,
    );
    P(
      `   held-to-resolution P&L ${usd(r.netBigBetPnlUsd)} · lifetime PnL ${usd(r.lifetimePnlUsd)} · ` +
        `avg entry ${pct(r.wAvgEntryPrice)} · open big exposure ${usd(r.openExposureUsd)} (${r.nUnresolved})`,
    );
    const evid = r.markets.filter((m) => m.resolved && m.win && (mode === 'stat' || m.informative));
    P(`   Top winning ${mode === 'info' ? 'INFORMATIVE ' : ''}big bets (market · cat · side @ odds · size · profit · lead):`);
    evid.slice(0, 7).forEach((m) =>
      P(
        `     • ${pad(m.title, 40)} ${pad(m.category, 8)} ${m.side.padEnd(5)} @${m.entryPrice.toFixed(3)} ` +
          `${padL(usd(m.bigNotionalUsd), 10)} → ${padL(usd(m.heldPnlUsd), 11)}` +
          `${m.daysToResolve == null ? '' : `  (${m.daysToResolve.toFixed(1)}d)`}`,
      ),
    );
  };

  P(`## ⚑⚑ INFORMATION WATCHLIST — insider-shaped (zInfo ≥ ${zFlag}, ≥${minResolved} informative bets, P&L > 0)`);
  P('   The tightest "likely acted on information" shortlist. Empty is itself a finding: at $100k+, the edges are');
  P('   sports/live-trading skill, not information.');
  if (infoWatchlist.length === 0) P('    (none cleared the bar — see discussion)');
  infoWatchlist.forEach((r, i) => renderWatch(r, i, 'info'));
  P('');
  P(`## ⚑ STATISTICAL-ANOMALY watchlist (all-odds z ≥ ${zFlag}, ≥${minResolved} non-trivial bets, P&L > 0)`);
  P('   Wins far more than the odds it paid — but read the category mix: mostly sports sharps & live traders.');
  if (watchlist.length === 0) P('    (none cleared the bar)');
  watchlist.forEach((r, i) => renderWatch(r, i, 'stat'));
  P('');

  // 6. PERSIST
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        meta: {
          generatedAt: new Date().toISOString(),
          thresholdUsd: threshold,
          windowDays: days,
          window: { from: dayStr(cutoff), to: dayStr(nowSec) },
          candidates: candList.length,
          survivors: survivorIdx.length,
          distinctMarkets: cidList.length,
          minResolved,
          zFlag,
          method:
            'Per-fill held-to-resolution grading via CLOB tokens[].winner. z = (wins − Σ entry-price) / ' +
            'sqrt(Σ p(1−p)) over INDEPENDENT resolved markets, excluding near-certain entries (≥0.98/≤0.02). ' +
            'zInfo restricts to the INSIDER-SHAPED subset: non-sports, odds ≤0.90, placed >1d before resolution. ' +
            'Discovery is recency+leaderboard bounded (the global /trades feed caps at offset 3000 and ignores ' +
            'time), so a whale active only mid-window with no leaderboard footprint can be missed.',
        },
        infoWatchlist: infoWatchlist.map((r) => ({
          address: r.address, label: r.label, zInfo: r.zInfo, nInfo: r.nInfo, infoPnlUsd: r.infoPnlUsd,
        })),
        statWatchlist: watchlist.map((r) => ({
          address: r.address, label: r.label, z: r.z, sportsShare: r.sportsShare, netBigBetPnlUsd: r.netBigBetPnlUsd,
        })),
        reports: byNetProfit,
      },
      null,
      2,
    ),
  );
  const mdPath = outPath.replace(/\.json$/, '.md');
  writeFileSync(mdPath, lines.join('\n'));
  log(`Wrote ${outPath} and ${mdPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('whale-insider-scan crashed:', err?.stack ?? err);
    process.exit(1);
  });
}
