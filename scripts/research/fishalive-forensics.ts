/**
 * scripts/research/fishalive-forensics — soccer-aware mechanism fingerprint for Polymarket @fishalive
 * (the re-opened 9th-signal KILL: SPORTS-TRADERS.md §9). READ-ONLY, keyless public data, rail DORMANT.
 *
 * WHY THIS EXISTS. `scripts/wallet-forensics.ts` already proved the headline: fishalive's ~$9.0M is REAL
 * realized cash (Σ REDEEM $13.28M − Σ BUY $4.28M, zero SELL; reconciles to the user-pnl curve at 0.74%),
 * on an account whose first fill is 2026-06-15. But that script's per-bet grader is WEATHER-specific
 * (parsePositionMarket only parses temperature slugs), so its win-rate / bucket / Brier blocks are noise
 * for a soccer wallet. This script answers the questions the cash-flow identity can't on its own:
 *
 *   - TRUE win rate NET OF LOSERS — by market, by shares, by notional — using AUTHORITATIVE CLOB resolution
 *     (`/markets/{conditionId}` → which token has `winner:true`), not a price-tail heuristic and not the
 *     redeem-only view (which is survivorship by construction: losers leave no redeem row).
 *   - The ENTRY-PRICE distribution (is it really the ~0.47 the operator sees, or a cheap-longshot spread?).
 *   - WHICH outcome the 47c is (group resolved winners/losers by entry band → realized PnL per band).
 *   - TIMING vs kickoff (`game_start_time`): pre-match accumulation vs in-play — the executability axis.
 *   - Per-event sizing, sub-sport / league mix, same-second burst share (the co-located-bot tell).
 *   - WASH screen: does he ever hold BOTH sides (Yes+No) of the same market? round-trips? (sells=0 already.)
 *   - OPEN exposure still unresolved (so the realized vs open split is explicit, not assumed).
 *
 * Reuses the canonical io client (crawlActivity / fetchActivity parsers) + the tested market categorizers
 * from core/sim/sports-copytrade. The only new network is CLOB `/markets/{cid}` resolution (one per distinct
 * market, polite-delayed) — cached to out/ so re-runs are free. Run:
 *   pnpm tsx scripts/research/fishalive-forensics.ts [wallet] [--max-markets N] [--refresh]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchJson } from '../../packages/io/src/index.ts';
import type { WalletActivity } from '../../packages/io/src/polymarket-wallet.ts';
import { crawlActivity } from '../lib/polymarket-crawl.ts';
import {
  categorizeMarket,
  sportsSubcategory,
  type MarketCategory,
  type SportsSubcategory,
} from '../../packages/core/src/sim/sports-copytrade.ts';

const FISHALIVE = '0xed64a7bf029040aa331abc87902434d815ef217d';
const HEADERS = { 'User-Agent': 'polyweather-analytics/1.0', Accept: 'application/json' };
const RESOLVE_CACHE = 'scripts/research/out/fishalive-market-resolution.json';

interface ClobMarket {
  closed?: boolean;
  game_start_time?: string | null;
  accepting_order_timestamp?: string | null;
  end_date_iso?: string | null;
  question?: string | null;
  market_slug?: string | null;
  tokens?: { token_id?: string; outcome?: string; winner?: boolean }[];
}

const isoToUnix = (s: string | null | undefined): number | null => {
  if (!s || typeof s !== 'string') return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.trunc(t / 1000) : null;
};
const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: number[], q: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch + cache CLOB market resolution (winner token + kickoff) for a set of condition ids. */
async function resolveMarkets(cids: string[], refresh: boolean): Promise<Map<string, ClobMarket>> {
  const cache: Record<string, ClobMarket> = existsSync(RESOLVE_CACHE) && !refresh
    ? JSON.parse(readFileSync(RESOLVE_CACHE, 'utf8'))
    : {};
  let fetched = 0;
  for (const cid of cids) {
    if (cache[cid] && !refresh) continue;
    try {
      const m = (await fetchJson(`https://clob.polymarket.com/markets/${cid}`, { headers: HEADERS }, { timeoutMs: 30_000, retries: 2 })) as ClobMarket;
      cache[cid] = m && typeof m === 'object' ? m : {};
    } catch {
      cache[cid] = {};
    }
    fetched++;
    if (fetched % 25 === 0) process.stderr.write(`  …resolved ${fetched}/${cids.length} markets\r`);
    await sleep(90);
  }
  process.stderr.write(`  …resolved ${fetched} new markets (${cids.length} distinct total)\n`);
  mkdirSync(dirname(RESOLVE_CACHE), { recursive: true });
  writeFileSync(RESOLVE_CACHE, JSON.stringify(cache, null, 0));
  const map = new Map<string, ClobMarket>();
  for (const [k, v] of Object.entries(cache)) map.set(k, v);
  return map;
}

const winnerTokenOf = (m: ClobMarket | undefined): string | null => {
  if (!m || m.closed !== true) return null;
  for (const t of m.tokens ?? []) if (t?.winner === true) return String(t.token_id ?? '');
  return null;
};

const BANDS = [
  { label: '0.00-0.10', lo: 0, hi: 0.1 },
  { label: '0.10-0.25', lo: 0.1, hi: 0.25 },
  { label: '0.25-0.40', lo: 0.25, hi: 0.4 },
  { label: '0.40-0.50', lo: 0.4, hi: 0.5 },
  { label: '0.50-0.60', lo: 0.5, hi: 0.6 },
  { label: '0.60-0.75', lo: 0.6, hi: 0.75 },
  { label: '0.75-0.90', lo: 0.75, hi: 0.9 },
  { label: '0.90-1.00', lo: 0.9, hi: 1.0001 },
];
const bandOf = (p: number): string => BANDS.find((b) => p >= b.lo && p < b.hi)?.label ?? '—';

const usd = (v: number): string => (Number.isFinite(v) ? `$${Math.round(v).toLocaleString('en-US')}` : '—');
const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—');

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'max-markets': { type: 'string' }, refresh: { type: 'boolean', default: false } },
  });
  const wallet = (positionals[0] ?? FISHALIVE).toLowerCase();

  process.stderr.write(`[fishalive] crawling full /activity for ${wallet} …\n`);
  const { fills, mode, pagesFetched } = await crawlActivity(wallet, { maxPages: 1000 });
  process.stderr.write(`[fishalive] ${fills.length} fills (mode=${mode}, pages=${pagesFetched})\n`);

  const buys = fills.filter((f) => f.type === 'TRADE' && f.side === 'BUY');
  const sells = fills.filter((f) => f.type === 'TRADE' && f.side === 'SELL');
  const redeems = fills.filter((f) => f.type === 'REDEEM');

  // per-condition redeem proceeds (winning-share payout, $1/share → usdcSize)
  const redeemByCid = new Map<string, number>();
  for (const r of redeems) redeemByCid.set(r.conditionId, (redeemByCid.get(r.conditionId) ?? 0) + r.usdcSize);

  // distinct markets he BOUGHT — resolve them authoritatively
  const distinctCids = [...new Set(buys.map((b) => b.conditionId).filter((c) => c !== ''))];
  const capN = values['max-markets'] ? Number(values['max-markets']) : distinctCids.length;
  const resolved = await resolveMarkets(distinctCids.slice(0, capN), values.refresh);

  // ---- aggregate per (conditionId, asset/token) the buys, then grade by CLOB winner ----
  interface Pos { cid: string; asset: string; outcome: string; title: string; eventSlug: string;
    shares: number; cost: number; vwap: number; firstTs: number; lastTs: number; }
  const posByKey = new Map<string, Pos>();
  for (const b of buys) {
    const key = `${b.conditionId}|${b.asset}`;
    let p = posByKey.get(key);
    if (!p) { p = { cid: b.conditionId, asset: b.asset, outcome: b.outcome, title: b.title, eventSlug: b.eventSlug,
      shares: 0, cost: 0, vwap: 0, firstTs: b.timestamp, lastTs: b.timestamp }; posByKey.set(key, p); }
    p.shares += b.sizeShares; p.cost += b.usdcSize;
    p.firstTs = Math.min(p.firstTs, b.timestamp); p.lastTs = Math.max(p.lastTs, b.timestamp);
  }
  for (const p of posByKey.values()) p.vwap = p.shares > 0 ? p.cost / p.shares : NaN;

  // ---- grading: each position is WIN / LOSS / OPEN by CLOB resolution ----
  let mWin = 0, mLoss = 0, mOpen = 0;
  let costWin = 0, costLoss = 0, costOpen = 0;
  let sharesWin = 0, sharesLoss = 0, sharesOpen = 0;
  let redeemWin = 0;
  const winVwaps: number[] = [], lossVwaps: number[] = [];
  // entry-band table over RESOLVED positions
  const bandAgg = new Map<string, { n: number; cost: number; redeem: number; win: number }>();
  for (const b of BANDS) bandAgg.set(b.label, { n: 0, cost: 0, redeem: 0, win: 0 });

  for (const p of posByKey.values()) {
    const m = resolved.get(p.cid);
    const wt = winnerTokenOf(m);
    const cidRedeem = redeemByCid.get(p.cid) ?? 0;
    if (wt == null) { // unresolved/open (or unknown)
      mOpen++; costOpen += p.cost; sharesOpen += p.shares; continue;
    }
    const won = p.asset === wt;
    const bandRow = bandAgg.get(bandOf(p.vwap))!;
    bandRow.n++; bandRow.cost += p.cost;
    if (won) {
      mWin++; costWin += p.cost; sharesWin += p.shares; redeemWin += Math.min(cidRedeem, p.shares); // share of redeem for this leg
      winVwaps.push(p.vwap); bandRow.win++; bandRow.redeem += p.shares; // winning shares redeem at $1
    } else {
      mLoss++; costLoss += p.cost; sharesLoss += p.shares; lossVwaps.push(p.vwap);
    }
  }

  // ---- timing vs kickoff ----
  const latencies: number[] = []; let withKick = 0, preKick = 0, within5 = 0;
  for (const p of posByKey.values()) {
    const m = resolved.get(p.cid);
    const k = isoToUnix(m?.game_start_time) ?? isoToUnix(m?.accepting_order_timestamp);
    if (k == null) continue;
    withKick++; const dt = p.firstTs - k; latencies.push(dt);
    if (dt < 0) preKick++; else if (dt <= 300) within5++;
  }

  // ---- same-second burst share (co-located tell) over BUY fills ----
  const secGroups = new Map<string, number>();
  for (const b of buys) secGroups.set(`${b.conditionId}@${b.timestamp}`, (secGroups.get(`${b.conditionId}@${b.timestamp}`) ?? 0) + 1);
  let burstFills = 0; for (const b of buys) if ((secGroups.get(`${b.conditionId}@${b.timestamp}`) ?? 0) > 1) burstFills++;

  // ---- wash screen: does he hold BOTH sides of a market? ----
  const sidesByCid = new Map<string, Set<string>>();
  for (const p of posByKey.values()) { const s = sidesByCid.get(p.cid) ?? new Set(); s.add(p.outcome.toLowerCase()); sidesByCid.set(p.cid, s); }
  const bothSides = [...sidesByCid.values()].filter((s) => s.has('yes') && s.has('no')).length;

  // ---- category / sub-sport / league mix by cost ----
  const catCost: Partial<Record<MarketCategory, number>> = {};
  const subCost: Partial<Record<SportsSubcategory, number>> = {};
  const leagueCost = new Map<string, number>(); // eventSlug prefix as a rough league/tournament key
  let totalCost = 0;
  for (const p of posByKey.values()) {
    totalCost += p.cost;
    const cat = categorizeMarket(p.title, p.eventSlug);
    catCost[cat] = (catCost[cat] ?? 0) + p.cost;
    if (cat === 'sports') { const sub = sportsSubcategory(p.title, p.eventSlug); subCost[sub] = (subCost[sub] ?? 0) + p.cost; }
    const leagueKey = (p.eventSlug || p.title).split('-').slice(0, 3).join('-') || '(none)';
    leagueCost.set(leagueKey, (leagueCost.get(leagueKey) ?? 0) + p.cost);
  }

  // ---- entry-price histogram over BUY fills (by fills + by notional) ----
  const pxHist = BANDS.map((b) => ({ label: b.label, fills: 0, cost: 0 }));
  for (const b of buys) { const i = BANDS.findIndex((bb) => b.price >= bb.lo && b.price < bb.hi); if (i >= 0) { pxHist[i]!.fills++; pxHist[i]!.cost += b.usdcSize; } }

  const firstTs = Math.min(...buys.map((b) => b.timestamp));
  const lastTs = Math.max(...buys.map((b) => b.timestamp));
  const resolvedN = mWin + mLoss;

  // ================= REPORT =================
  const L: string[] = [];
  L.push('# fishalive — soccer-aware mechanism forensics', '');
  L.push(`_Wallet \`${wallet}\`. Read-only, keyless public data + authoritative CLOB resolution. Rail DORMANT._`, '');
  L.push(`- **Account span:** ${new Date(firstTs * 1000).toISOString().slice(0, 10)} → ${new Date(lastTs * 1000).toISOString().slice(0, 10)} (${((lastTs - firstTs) / 86400).toFixed(0)} days)`);
  L.push(`- **Fills:** ${buys.length} BUY · ${sells.length} SELL · ${redeems.length} REDEEM · ${posByKey.size} distinct (market,side) positions · ${distinctCids.length} distinct markets`);
  L.push(`- **Cash flow:** Σ buy cost ${usd(buys.reduce((a, b) => a + b.usdcSize, 0))} · Σ redeem ${usd(redeems.reduce((a, r) => a + r.usdcSize, 0))} · Σ sell ${usd(sells.reduce((a, s) => a + s.usdcSize, 0))} → realized ${usd(redeems.reduce((a, r) => a + r.usdcSize, 0) - buys.reduce((a, b) => a + b.usdcSize, 0))}`, '');

  L.push('## TRUE win rate (authoritative CLOB resolution, net of losers)', '');
  L.push(`- **By market:** ${mWin}W / ${mLoss}L / ${mOpen} open → win ${pct(resolvedN ? mWin / resolvedN : NaN)} of ${resolvedN} resolved`);
  L.push(`- **By shares (resolved):** ${pct(sharesWin + sharesLoss ? sharesWin / (sharesWin + sharesLoss) : NaN)} (${Math.round(sharesWin).toLocaleString()} win / ${Math.round(sharesLoss).toLocaleString()} loss shares)`);
  L.push(`- **By cost (resolved):** win-leg cost ${usd(costWin)} vs loss-leg cost ${usd(costLoss)} → ${pct(costWin + costLoss ? costWin / (costWin + costLoss) : NaN)} of staked $ won`);
  L.push(`- **Realized on resolved:** redeem ${usd(redeemWin)} − cost ${usd(costWin + costLoss)} = ${usd(redeemWin - costWin - costLoss)}`);
  L.push(`- **Still OPEN (unresolved):** ${mOpen} positions, ${usd(costOpen)} cost at risk`);
  L.push(`- **VWAP entry:** winners ${median(winVwaps).toFixed(3)} (median) · losers ${median(lossVwaps).toFixed(3)} (median)`, '');

  L.push('## Entry-price distribution (all BUY fills)', '');
  L.push('| band | fills | cost | %cost |');
  L.push('|---|--:|--:|--:|');
  for (const h of pxHist) if (h.fills > 0) L.push(`| ${h.label} | ${h.fills} | ${usd(h.cost)} | ${pct(totalCost ? h.cost / buys.reduce((a, b) => a + b.usdcSize, 0) : NaN)} |`);
  L.push('');

  L.push('## Realized PnL by entry band (resolved positions)', '');
  L.push('| entry band | positions | won | cost | redeem | realized | ROI |');
  L.push('|---|--:|--:|--:|--:|--:|--:|');
  for (const b of BANDS) {
    const r = bandAgg.get(b.label)!;
    if (r.n === 0) continue;
    const realized = r.redeem - r.cost;
    L.push(`| ${b.label} | ${r.n} | ${r.win} | ${usd(r.cost)} | ${usd(r.redeem)} | ${usd(realized)} | ${pct(r.cost ? realized / r.cost : NaN)} |`);
  }
  L.push('');

  L.push('## Timing vs kickoff', '');
  L.push(`- Positions with a known kickoff: ${withKick}`);
  L.push(`- **Pre-kickoff entry:** ${pct(withKick ? preKick / withKick : NaN)} · within 5min of kickoff: ${pct(withKick ? within5 / withKick : NaN)}`);
  L.push(`- First-fill latency vs kickoff: median ${median(latencies).toFixed(0)}s · p10 ${quantile(latencies, 0.1).toFixed(0)}s · p90 ${quantile(latencies, 0.9).toFixed(0)}s`, '');

  L.push('## Microstructure & wash screen', '');
  L.push(`- Same-second burst fills: ${pct(buys.length ? burstFills / buys.length : NaN)} of BUY fills share their exact second+market`);
  L.push(`- Holds BOTH Yes+No of the same market: **${bothSides}** markets (wash/self-cross tell; 0 = clean directional)`);
  L.push(`- Median fill size: ${usd(median(buys.map((b) => b.usdcSize)))} · max single fill: ${usd(Math.max(...buys.map((b) => b.usdcSize)))}`, '');

  L.push('## League / sub-sport mix (by cost)', '');
  const subs = Object.entries(subCost).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  L.push(`- Category: ${Object.entries(catCost).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => `${k} ${pct((v ?? 0) / totalCost)}`).join(', ')}`);
  L.push(`- Sub-sport: ${subs.map(([k, v]) => `${k} ${pct((v ?? 0) / (subs.reduce((a, e) => a + (e[1] ?? 0), 0)))}`).join(', ') || '—'}`);
  L.push('- Top tournament/league keys by cost:');
  for (const [k, v] of [...leagueCost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`  - \`${k}\` — ${usd(v)} (${pct(v / totalCost)})`);
  L.push('');

  L.push('## Top resolved positions by realized $ (the engine of the $9M)', '');
  L.push('| event | outcome | vwap | shares | cost | redeem | realized | result |');
  L.push('|---|---|--:|--:|--:|--:|--:|:--|');
  const graded = [...posByKey.values()].map((p) => {
    const wt = winnerTokenOf(resolved.get(p.cid));
    const won = wt != null && p.asset === wt;
    const open = wt == null;
    const redeem = won ? p.shares : 0;
    return { p, won, open, redeem, realized: redeem - p.cost };
  });
  for (const g of graded.filter((x) => !x.open).sort((a, b) => b.realized - a.realized).slice(0, 15)) {
    const ev = (g.p.eventSlug || g.p.title).slice(0, 42);
    L.push(`| ${ev} | ${g.p.outcome} | ${g.p.vwap.toFixed(3)} | ${Math.round(g.p.shares).toLocaleString()} | ${usd(g.p.cost)} | ${usd(g.redeem)} | ${usd(g.realized)} | ${g.won ? 'WIN' : 'loss'} |`);
  }
  L.push('');

  const md = L.join('\n');
  const out = 'scripts/research/out/fishalive-forensics';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.md`, md);
  writeFileSync(`${out}.json`, JSON.stringify({
    wallet, span: { from: new Date(firstTs * 1000).toISOString(), to: new Date(lastTs * 1000).toISOString() },
    fills: { buy: buys.length, sell: sells.length, redeem: redeems.length, positions: posByKey.size, markets: distinctCids.length },
    winByMarket: resolvedN ? mWin / resolvedN : null, mWin, mLoss, mOpen,
    costWin, costLoss, costOpen, redeemWin, realizedResolved: redeemWin - costWin - costLoss,
    winVwapMedian: median(winVwaps), lossVwapMedian: median(lossVwaps),
    preKickoffPct: withKick ? preKick / withKick : null, burstPct: buys.length ? burstFills / buys.length : null,
    bothSidesMarkets: bothSides,
    pxHist, bandAgg: Object.fromEntries(bandAgg),
  }, null, 2));
  process.stderr.write(`[fishalive] wrote ${out}.md + .json\n`);
  process.stdout.write(md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('fishalive-forensics crashed:', e?.message ?? e); process.exit(1); });
}
