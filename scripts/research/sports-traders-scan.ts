/**
 * scripts/research/sports-traders-scan — "Who are the most successful SPORTS traders on Polymarket, and
 * can we MIRROR (copy-trade) them?" The impure spine; the pure analytics live in
 * @weather-edge/core (sim/sports-copytrade.ts + the reused sim/copy-trade.ts), both unit-tested.
 *
 * WHAT IT DOES (two parts, matching the question):
 *   PART 1 — ROSTER. Pull the Polymarket SPORTS leaderboard (data-api /v1/leaderboard?category=SPORTS)
 *     across PNL + VOLUME × {DAY,WEEK,MONTH,ALL}, dedupe wallets, and rank by lifetime P&L with a
 *     ROI proxy (pnl/vol). This is the direct answer to "find the most successful sports traders".
 *   PART 2 — COPYABILITY. For the top-N sports wallets: crawl their large fills (/trades?user=…),
 *     fingerprint their style (entry-odds histogram, sweep/burst signature, sub-sport mix, win rate vs
 *     implied), then run the COPY-TRADE FEASIBILITY probe — for each resolved BUY, pull the bought
 *     token's CLOB /prices-history, build the book series, and ask (via the tested simulateMirror): a
 *     follower who detects the fill after a realistic LAG and TAKES the ask — does the fee-net EV still
 *     clear 0? Swept across detection lags × spread haircuts. The aligned post-fill DRIFT CURVE shows
 *     WHEN the price moves relative to the fill (the live-trading-latency signature).
 *
 * POSTURE: analytics study, NOT a trading green-light (project posture: live rail DORMANT). The
 * PRE-REGISTERED kill-criterion is sim/copy-trade copyTradeVerdict: the follower fee-net EV 95%
 * bootstrap-CI lower bound must clear 0. CI straddles/below 0 → "late follower" confirmed; the clean
 * efficiency measurement IS the deliverable. Do NOT move the criterion to fit the result (WO-5
 * discipline). A PASS would be the out-of-market information the posture needs to even consider the rail.
 *
 * OPTIMISM DIAL: spreadHaircut=0 is the OPTIMISTIC follower (pays the mark, not the ask) — a kill test.
 * The script also reports realistic haircuts so a PASS at 0 can be stress-tested.
 *
 * Run: pnpm tsx scripts/research/sports-traders-scan.ts
 *        [--top N=12]            # how many top sports wallets to fingerprint
 *        [--probe-wallets N=3]   # how many of those to run the full copyability probe on
 *        [--min-cash 5000]       # per-wallet fill notional floor (server-side CASH filter)
 *        [--max-fills 120]       # cap fills crawled per probed wallet
 *        [--lags 60,300,900]     # detection lags (seconds) to sweep
 *        [--haircuts 0,0.01,0.02]# spread haircuts to sweep
 *        [--cache file.json]     # cache raw HTTP (respect rate limits across reruns)
 *        [--json] [--out PATH]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  alignDriftCurve,
  copyTradeVerdict,
  type DriftPoint,
  type FingerprintFill,
  parsePricesHistory,
  type PricePoint,
  simulateMirror,
  sharpOwnEdge,
  type SportsFillInput,
  toMirrorFill,
  traderFingerprint,
  type TraderFingerprint,
} from '../../packages/core/src/index.ts';
import { fetchJson } from '../../packages/io/src/index.ts';
import {
  fetchTrades,
  type LeaderboardEntry,
  parseLeaderboard,
  POLYMARKET_DATA_API,
  type Trade,
} from '../../packages/io/src/polymarket-wallet.ts';

const CLOB_API = 'https://clob.polymarket.com';
const HEADERS = { 'User-Agent': 'polyweather-analytics/1.0', Accept: 'application/json' };
type TimePeriod = 'DAY' | 'WEEK' | 'MONTH' | 'ALL';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// tiny disk cache (so reruns don't re-hit Polymarket — politeness + reproducibility)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Cache {
  get(key: string): unknown | undefined;
  set(key: string, val: unknown): void;
  save(): void;
}
function makeCache(path: string | undefined): Cache {
  const store: Record<string, unknown> = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return {
    get: (k) => store[k],
    set: (k, v) => {
      store[k] = v;
    },
    save: () => {
      if (path) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(store));
      }
    },
  };
}

async function cachedJson(cache: Cache, url: string): Promise<unknown> {
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  const val = await fetchJson(url, { headers: HEADERS }, { timeoutMs: 25_000, retries: 3 });
  cache.set(url, val);
  return val;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PART 1 — the SPORTS leaderboard roster
// ──────────────────────────────────────────────────────────────────────────────────────────────────

async function fetchSportsLeaderboard(
  cache: Cache,
  timePeriod: TimePeriod,
  orderBy: 'PNL' | 'VOLUME',
  limit = 50,
): Promise<LeaderboardEntry[]> {
  const url =
    `${POLYMARKET_DATA_API}/v1/leaderboard?category=SPORTS&timePeriod=${timePeriod}&orderBy=${orderBy}&limit=${limit}`;
  return parseLeaderboard(await cachedJson(cache, url));
}

interface RosterRow {
  rank: number;
  wallet: string;
  label: string;
  pnlAllUsd: number | null;
  volAllUsd: number | null;
  pnlMonthUsd: number | null;
  roiProxy: number | null; // pnlAll / volAll
}

/** Build a deduped roster keyed by wallet, ranked by all-time P&L, with a month P&L + ROI proxy column. */
async function buildRoster(cache: Cache, limit: number): Promise<RosterRow[]> {
  const all = await fetchSportsLeaderboard(cache, 'ALL', 'PNL', Math.max(limit, 50));
  const month = await fetchSportsLeaderboard(cache, 'MONTH', 'PNL', 100);
  const monthByWallet = new Map(month.map((e) => [e.address.toLowerCase(), e.pnlUsd]));
  return all.slice(0, limit).map((e, i) => ({
    rank: i + 1,
    wallet: e.address,
    label: e.label || '(anon)',
    pnlAllUsd: e.pnlUsd,
    volAllUsd: e.volumeUsd,
    pnlMonthUsd: monthByWallet.get(e.address.toLowerCase()) ?? null,
    roiProxy: e.volumeUsd && e.volumeUsd > 0 ? e.pnlUsd / e.volumeUsd : null,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PART 2 — per-wallet fills, fingerprint, copyability probe
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** All of a wallet's fills ≥ minCash (server-side CASH floor), newest-first, capped at maxFills. */
async function fetchWalletFills(cache: Cache, wallet: string, minCash: number, maxFills: number): Promise<Trade[]> {
  const out: Trade[] = [];
  for (let page = 0; page < 6 && out.length < maxFills; page++) {
    const url =
      `${POLYMARKET_DATA_API}/trades?user=${wallet}&filterType=CASH&filterAmount=${Math.trunc(minCash)}` +
      `&takerOnly=false&limit=100&offset=${page * 100}`;
    const rows = await cachedJson(cache, url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    // parse via the shared client parser shape
    out.push(
      ...(rows as Record<string, unknown>[])
        .filter((r) => typeof r.transactionHash === 'string')
        .map((r) => ({
          proxyWallet: String(r.proxyWallet ?? ''),
          traderName: String(r.name ?? r.pseudonym ?? ''),
          side: (String(r.side ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as 'BUY' | 'SELL',
          asset: String(r.asset ?? ''),
          conditionId: String(r.conditionId ?? ''),
          outcome: String(r.outcome ?? ''),
          sizeShares: Number(r.size),
          price: Number(r.price),
          notionalUsd: Number(r.size) * Number(r.price),
          timestamp: Math.trunc(Number(r.timestamp)),
          title: String(r.title ?? ''),
          slug: String(r.slug ?? ''),
          eventSlug: String(r.eventSlug ?? ''),
          transactionHash: String(r.transactionHash ?? ''),
        })),
    );
    if (rows.length < 100) break;
  }
  return out.slice(0, maxFills);
}

/**
 * AUTHORITATIVE market resolution from CLOB /markets/{conditionId}: `closed` + the per-token `winner`
 * flag. This is the source of truth for win/loss — far cleaner than reading a price tail, because an OPEN
 * market can sit at an extreme price without having settled. Returns the winning token id (or null when
 * the market is not closed / shape-unknown). Total — never throws.
 */
interface MarketResolution {
  closed: boolean;
  winnerTokenId: string | null;
}
async function fetchMarketResolution(cache: Cache, conditionId: string): Promise<MarketResolution> {
  if (!conditionId) return { closed: false, winnerTokenId: null };
  const url = `${CLOB_API}/markets/${conditionId}`;
  try {
    const raw = (await cachedJson(cache, url)) as {
      closed?: unknown;
      tokens?: { token_id?: unknown; winner?: unknown }[];
    };
    const closed = raw?.closed === true;
    let winnerTokenId: string | null = null;
    for (const tok of raw?.tokens ?? []) {
      if (tok?.winner === true) winnerTokenId = String(tok.token_id ?? '');
    }
    return { closed, winnerTokenId };
  } catch {
    return { closed: false, winnerTokenId: null };
  }
}

/** Narrow-window 1-min history around a fill (the fidelity the live edge plays out at). */
async function fetchTokenHistoryWindow(
  cache: Cache,
  tokenId: string,
  startTs: number,
  endTs: number,
): Promise<PricePoint[]> {
  const url = `${CLOB_API}/prices-history?market=${tokenId}&startTs=${Math.trunc(startTs)}&endTs=${Math.trunc(endTs)}&fidelity=1`;
  try {
    return parsePricesHistory(await cachedJson(cache, url));
  } catch {
    return [];
  }
}

const num = (s: string | undefined, d: number): number => (s != null && Number.isFinite(Number(s)) ? Number(s) : d);
const list = (s: string | undefined, d: number[]): number[] =>
  s ? s.split(',').map((x) => Number(x)).filter((x) => Number.isFinite(x)) : d;

interface ProbeCell {
  lagSec: number;
  haircut: number;
  nUsable: number;
  sharpEv: number;
  followerNetEv: number;
  followerNetCiLo: number;
  followerNetCiHi: number;
  capturableFraction: number;
  pass: boolean;
  summary: string;
}

interface WalletReport {
  rank: number;
  wallet: string;
  label: string;
  fingerprint: TraderFingerprint;
  sharpEdgeEv: number;
  sharpEdgeN: number;
  nResolvedProbed: number;
  driftCurve: DriftPoint[];
  probe: ProbeCell[];
}

async function probeWallet(
  cache: Cache,
  roster: RosterRow,
  opts: { minCash: number; maxFills: number; lags: number[]; haircuts: number[] },
): Promise<WalletReport> {
  const fills = await fetchWalletFills(cache, roster.wallet, opts.minCash, opts.maxFills);

  // --- AUTHORITATIVE resolution per market (closed + winning token), from CLOB /markets/{cid} ---
  const resByCondition = new Map<string, MarketResolution>();
  for (const f of fills) {
    if (f.conditionId && !resByCondition.has(f.conditionId)) {
      resByCondition.set(f.conditionId, await fetchMarketResolution(cache, f.conditionId));
    }
  }
  // won = the market is CLOSED and the leg the sharp bought (its `asset` token) is the winner. A market
  // still open → null (unresolved, dropped). This is leak-free: resolution is the settled outcome only.
  const wonOf = (f: Trade): boolean | null => {
    const r = resByCondition.get(f.conditionId);
    if (!r || !r.closed || !r.winnerTokenId) return null;
    return f.asset === r.winnerTokenId;
  };

  // --- fingerprint (descriptive style profile over ALL fills) ---
  const fpFills: FingerprintFill[] = fills.map((f) => ({
    title: f.title,
    slug: f.eventSlug || f.slug,
    side: f.side,
    price: f.price,
    notionalUsd: f.notionalUsd,
    timestamp: f.timestamp,
    won: f.side === 'BUY' ? wonOf(f) : null,
  }));
  const fingerprint = traderFingerprint(fpFills, { burstWindowSec: 120 });
  const sharpEdge = sharpOwnEdge(fpFills);

  // --- copyability probe: resolved BUY fills (market closed) ---
  const resolvedBuys = fills.filter((f) => f.side === 'BUY' && wonOf(f) !== null);

  // narrow 1-min windows around each fill for the drift curve + the mirror (coarse `max` history is
  // ~10-min spaced; the live edge needs 1-min resolution near the fill).
  const windows = new Map<string, PricePoint[]>();
  for (const f of resolvedBuys) {
    const key = `${f.asset}@${f.timestamp}`;
    windows.set(key, await fetchTokenHistoryWindow(cache, f.asset, f.timestamp - 1800, f.timestamp + 7200));
  }
  const windowOf = (f: Trade): PricePoint[] => windows.get(`${f.asset}@${f.timestamp}`) ?? [];

  // aligned post-fill drift curve (price delta from the at-fill price, averaged over fills)
  const driftCurve = alignDriftCurve(
    resolvedBuys.map((f) => ({ timestamp: f.timestamp, history: windowOf(f) })),
    [-600, -300, -120, -60, 0, 60, 120, 300, 600, 900, 1800, 3600],
  );

  // mirror sweep over (lag × haircut). Each cell builds MirrorFills from the windowed history (which
  // carries the settle tail for resolution via the long-history fallback inside windowOf when needed).
  const probe: ProbeCell[] = [];
  for (const haircut of opts.haircuts) {
    for (const lagSec of opts.lags) {
      const mirror = resolvedBuys.map((f) => {
        const input: SportsFillInput = {
          conditionId: f.conditionId,
          asset: f.asset,
          fillPrice: f.price,
          sizeShares: f.sizeShares,
          usdcSize: f.notionalUsd,
          timestamp: f.timestamp,
          history: windowOf(f), // price PATH for the follower entry + drift
          feeRate: 0.05,
          outcomeWon: wonOf(f), // AUTHORITATIVE win/loss (not the price tail)
        };
        return toMirrorFill(input, { spreadHaircut: haircut });
      });
      const report = simulateMirror(mirror, {
        cheapMaxPrice: 0.97,
        detectionLagSec: lagSec,
        maxEntryStalenessSec: 1800,
      });
      const verdict = copyTradeVerdict(report);
      probe.push({
        lagSec,
        haircut,
        nUsable: report.nUsable,
        sharpEv: report.sharpGross.ev,
        followerNetEv: report.followerNet.ev,
        followerNetCiLo: report.followerNet.evCiLo,
        followerNetCiHi: report.followerNet.evCiHi,
        capturableFraction: report.capturableFraction,
        pass: verdict.pass,
        summary: verdict.summary,
      });
    }
  }

  return {
    rank: roster.rank,
    wallet: roster.wallet,
    label: roster.label,
    fingerprint,
    sharpEdgeEv: sharpEdge.ev,
    sharpEdgeN: sharpEdge.nGraded,
    nResolvedProbed: resolvedBuys.length,
    driftCurve,
    probe,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// reporting
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const usd = (v: number | null): string =>
  v == null || !Number.isFinite(v) ? '—' : `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');

function renderMarkdown(roster: RosterRow[], wallets: WalletReport[], meta: Record<string, unknown>): string {
  const L: string[] = [];
  L.push('# Polymarket — Top Sports Traders + Copyability Probe', '');
  L.push(`_Generated by \`scripts/research/sports-traders-scan.ts\` · params: \`${JSON.stringify(meta)}\`_`, '');

  L.push('## Part 1 — The roster (SPORTS leaderboard, by all-time P&L)', '');
  L.push('| # | Trader | Wallet | P&L (all) | Volume (all) | ROI proxy | P&L (30d) |');
  L.push('|--:|--------|--------|----------:|-------------:|----------:|----------:|');
  for (const r of roster) {
    L.push(
      `| ${r.rank} | ${r.label} | \`${r.wallet.slice(0, 10)}…\` | ${usd(r.pnlAllUsd)} | ${usd(r.volAllUsd)} | ` +
        `${r.roiProxy != null ? pct(r.roiProxy) : '—'} | ${usd(r.pnlMonthUsd)} |`,
    );
  }
  L.push('', '> ROI proxy = lifetime P&L / lifetime volume (a thin edge on huge turnover is the sports norm).', '');

  L.push('## Part 2 — Style fingerprints + copyability', '');
  for (const w of wallets) {
    const fp = w.fingerprint;
    L.push(`### #${w.rank} ${w.label} — \`${w.wallet}\``, '');
    L.push(
      `- **${fp.nFills} large fills**, ${usd(fp.totalNotionalUsd)} notional · mean ${usd(fp.meanNotionalUsd)} / ` +
        `median ${usd(fp.medianNotionalUsd)} · buy-side ${pct(fp.buyFraction)}`,
    );
    L.push(`- **VWAP entry odds ${f2(fp.vwapEntry)}** · mid-odds (0.2–0.8) BUY notional share ${pct(fp.midOddsBuyNotionalFraction)} · sweep/burst ${pct(fp.sweepFraction)}`);
    const cats = Object.entries(fp.categoryMix)
      .filter(([, v]) => v > 0.01)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${pct(v)}`)
      .join(', ');
    L.push(`- **Category mix:** ${cats}`);
    const sports = Object.entries(fp.sportsMix)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([k, v]) => `${k} ${pct(v ?? 0)}`)
      .join(', ');
    if (sports) L.push(`- **Sub-sport mix:** ${sports}`);
    if (fp.resolved.n > 0) {
      L.push(
        `- **Resolved ${fp.resolved.n} BUYs:** win ${pct(fp.resolved.winRate)} ` +
          `[${pct(fp.resolved.winRateLo)}, ${pct(fp.resolved.winRateHi)}] vs implied ${pct(fp.resolved.meanImpliedProb)} ` +
          `→ edge ${pct(fp.resolved.edgeOverImplied)}; own per-$1 EV ${pct(w.sharpEdgeEv)} (n=${w.sharpEdgeN})`,
      );
    }
    // odds histogram
    L.push('', '  Entry-odds histogram (count · notional):');
    for (const b of fp.oddsBins) {
      if (b.count > 0) L.push(`  - \`${b.label}\` — ${b.count} fills · ${usd(b.notionalUsd)}`);
    }

    // drift curve
    L.push('', `  **Post-fill drift** (mean price Δ from the at-fill price, over ${w.nResolvedProbed} resolved BUYs):`);
    const dc = (o: number) => w.driftCurve.find((d) => d.offsetSec === o);
    for (const o of [-300, -60, 0, 60, 300, 600, 900, 1800]) {
      const d = dc(o);
      if (d) L.push(`  - t${o >= 0 ? '+' : ''}${o}s — Δ ${Number.isFinite(d.meanDeltaFromFill) ? (d.meanDeltaFromFill >= 0 ? '+' : '') + (d.meanDeltaFromFill * 100).toFixed(2) + 'pp' : '—'} (n=${d.n})`);
    }

    // copyability verdict grid
    L.push('', '  **Copyability — follower fee-net EV/$1 (✅PASS = 95% CI lower bound > 0):**');
    L.push('  | spread haircut | detection lag | n | sharp EV | follower net EV | 95% CI | captured | verdict |');
    L.push('  |---:|---:|--:|--:|--:|:--|--:|:--|');
    for (const c of w.probe) {
      L.push(
        `  | ${pct(c.haircut)} | ${c.lagSec}s | ${c.nUsable} | ${pct(c.sharpEv)} | **${pct(c.followerNetEv)}** | ` +
          `[${pct(c.followerNetCiLo)}, ${pct(c.followerNetCiHi)}] | ${Number.isFinite(c.capturableFraction) ? pct(c.capturableFraction) : '—'} | ${c.pass ? '✅ PASS' : '❌ FAIL'} |`,
      );
    }
    L.push('');
  }
  return L.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      top: { type: 'string' },
      'probe-wallets': { type: 'string' },
      'min-cash': { type: 'string' },
      'max-fills': { type: 'string' },
      lags: { type: 'string' },
      haircuts: { type: 'string' },
      cache: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const top = num(values.top, 12);
  const probeWallets = num(values['probe-wallets'], 3);
  const minCash = num(values['min-cash'], 5000);
  const maxFills = num(values['max-fills'], 120);
  const lags = list(values.lags, [60, 300, 900]);
  const haircuts = list(values.haircuts, [0, 0.01, 0.02]);
  const cache = makeCache(values.cache);
  const meta = { top, probeWallets, minCash, maxFills, lags, haircuts, generatedAt: new Date().toISOString() };

  process.stderr.write(`[sports-scan] building roster (top ${top})…\n`);
  const roster = await buildRoster(cache, top);
  cache.save();

  const reports: WalletReport[] = [];
  for (const r of roster.slice(0, probeWallets)) {
    process.stderr.write(`[sports-scan] probing #${r.rank} ${r.label} (${r.wallet})…\n`);
    reports.push(await probeWallet(cache, r, { minCash, maxFills, lags, haircuts }));
    cache.save();
  }

  const md = renderMarkdown(roster, reports, meta);
  const outBase = values.out ?? 'scripts/research/out/sports-traders-scan';
  mkdirSync(dirname(outBase), { recursive: true });
  writeFileSync(`${outBase}.md`, md);
  writeFileSync(`${outBase}.json`, JSON.stringify({ meta, roster, reports }, null, 2));
  process.stderr.write(`[sports-scan] wrote ${outBase}.md + .json\n`);
  if (values.json) process.stdout.write(JSON.stringify({ meta, roster, reports }, null, 2));
  else process.stdout.write(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`[sports-scan] FATAL ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
