/**
 * scripts/research/lane-c1-fingerprint — LANE C1 FORENSICS (read-only, public data only).
 *
 * "Learn from the best": the three named Polymarket SPORTS specialists (mintblade / fishalive /
 * frostrizz) are the ONLY live-edge signature this project ever isolated. COPYING them already FAILED
 * (9th signal — survivorship + a non-executable book-sweep mark). This script does NOT re-run the copy
 * probe. It produces a quantified MECHANISM FINGERPRINT to answer ONE question: does their fingerprint
 * surface ANY concrete, executable, NON-latency angle a non-co-located outsider in Sweden (reaction
 * latency in minutes) could exploit?
 *
 * It reuses the EXISTING raw cache (scripts/research/out/sports-scan-cache.json) — the same data-api
 * /trades pages, CLOB /markets/{cid} resolutions, and /prices-history windows the prior scan already
 * pulled — so it adds ZERO new network load and is byte-reproducible. (Pass --cache to point elsewhere.)
 *
 * What it computes per specialist that the prior fingerprint did NOT:
 *   - SAME-SECOND sweep structure: how many distinct fills land on the EXACT same unix second in the
 *     same market (the co-located-bot tell), distribution of legs-per-second, share of notional swept.
 *   - EVENT->FILL LATENCY: from the CLOB market's `game_start_time` to each fill timestamp — how long
 *     after kickoff the bot acts (the live-trading window an outsider would have to beat).
 *   - INTRA-SECOND price displacement: at a same-second sweep, how far the bot moves the mark in that
 *     one second (the liquidity it eats — what a follower would have to find UN-swept).
 *   - Entry-odds histogram, sub-sport mix, win-rate vs implied (re-confirmed from the same cache).
 *   - What they do NOT touch (categories / odds bands with zero exposure).
 *
 * READ-ONLY. No orders, no trading import, rail DORMANT. Run: pnpm tsx scripts/research/lane-c1-fingerprint.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  categorizeMarket,
  sportsSubcategory,
  type MarketCategory,
  type SportsSubcategory,
} from '../../packages/core/src/sim/sports-copytrade.ts';

const CACHE_PATH_DEFAULT = 'scripts/research/out/sports-scan-cache.json';

const SPECIALISTS: { label: string; wallet: string }[] = [
  { label: 'mintblade', wallet: '0x96cfcb0c30942cfcd1cdf76c7d408794d66b1acb' },
  { label: 'fishalive', wallet: '0xed64a7bf029040aa331abc87902434d815ef217d' },
  { label: 'frostrizz', wallet: '0xbc11a64ab34a03a043fbe80598fa065ee87eeec6' },
];

interface RawTrade {
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  transactionHash: string;
}

interface MarketObj {
  closed?: boolean;
  game_start_time?: string | null;
  accepting_order_timestamp?: string | null;
  end_date_iso?: string | null;
  tokens?: { token_id?: string; winner?: boolean }[];
}

type Cache = Record<string, unknown>;

function loadCache(path: string): Cache {
  if (!existsSync(path)) throw new Error(`cache not found: ${path} — run sports-traders-scan.ts first`);
  return JSON.parse(readFileSync(path, 'utf8')) as Cache;
}

/** All cached /trades pages for a wallet, flattened, parsed minimally. */
function walletTrades(cache: Cache, wallet: string): RawTrade[] {
  const out: RawTrade[] = [];
  for (const [k, v] of Object.entries(cache)) {
    if (!k.includes('/trades?user=') || !k.toLowerCase().includes(wallet.toLowerCase())) continue;
    if (!Array.isArray(v)) continue;
    for (const r of v as Record<string, unknown>[]) {
      if (typeof r.transactionHash !== 'string' || r.transactionHash === '') continue;
      out.push({
        side: String(r.side ?? '').toUpperCase(),
        asset: String(r.asset ?? ''),
        conditionId: String(r.conditionId ?? ''),
        size: Number(r.size),
        price: Number(r.price),
        timestamp: Math.trunc(Number(r.timestamp)),
        title: String(r.title ?? ''),
        slug: String(r.slug ?? ''),
        eventSlug: String(r.eventSlug ?? ''),
        outcome: String(r.outcome ?? ''),
        transactionHash: String(r.transactionHash ?? ''),
      });
    }
  }
  // dedupe by txHash+asset+timestamp (pages can overlap)
  const seen = new Set<string>();
  return out.filter((t) => {
    const id = `${t.transactionHash}|${t.asset}|${t.timestamp}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function marketOf(cache: Cache, conditionId: string): MarketObj | null {
  const k = `https://clob.polymarket.com/markets/${conditionId}`;
  const v = cache[k];
  return v && typeof v === 'object' ? (v as MarketObj) : null;
}

function winnerTokenOf(m: MarketObj | null): string | null {
  if (!m || m.closed !== true) return null;
  for (const tok of m.tokens ?? []) if (tok?.winner === true) return String(tok.token_id ?? '');
  return null;
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
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo]! : s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};

const ODDS_BINS: { label: string; lo: number; hi: number }[] = [
  { label: '0.00-0.10', lo: 0, hi: 0.1 },
  { label: '0.10-0.25', lo: 0.1, hi: 0.25 },
  { label: '0.25-0.40', lo: 0.25, hi: 0.4 },
  { label: '0.40-0.60', lo: 0.4, hi: 0.6 },
  { label: '0.60-0.75', lo: 0.6, hi: 0.75 },
  { label: '0.75-0.90', lo: 0.75, hi: 0.9 },
  { label: '0.90-1.00', lo: 0.9, hi: 1.0001 },
];

interface Fingerprint {
  label: string;
  wallet: string;
  nFills: number;
  totalNotional: number;
  medianNotional: number;
  // same-second sweep structure
  nSecondGroups: number; // distinct (conditionId, exact second) groups
  nGroupsMultiLeg: number; // groups with >1 fill in the SAME second + market
  sameSecondFillShare: number; // fraction of FILLS that share their second+market with another fill
  sameSecondNotionalShare: number;
  legsPerSecondMax: number;
  legsPerSecondP90: number;
  // event->fill latency (kickoff to fill)
  nWithKickoff: number;
  latencyMedianSec: number | null;
  latencyP10Sec: number | null;
  latencyP90Sec: number | null;
  fillsBeforeKickoffPct: number | null; // pre-match (pure price-pick, not in-game)
  fillsWithin5minPct: number | null;
  // intra-second mark displacement (how much they move price in their sweep second)
  sweepMarkMoveMeanPp: number | null;
  // odds + sport + resolution
  oddsHist: { label: string; count: number; notional: number }[];
  sportsMix: Partial<Record<SportsSubcategory, number>>;
  categoryMix: Partial<Record<MarketCategory, number>>;
  vwapEntry: number;
  resolvedN: number;
  winRate: number | null;
  meanImplied: number | null;
  // what they do NOT touch
  untouchedOddsBands: string[];
  untouchedCategories: MarketCategory[];
}

function fingerprint(cache: Cache, label: string, wallet: string): Fingerprint {
  const trades = walletTrades(cache, wallet).filter((t) => t.side === 'BUY');
  const n = trades.length;
  const notionals = trades.map((t) => t.size * t.price);
  const totalNotional = notionals.reduce((a, v) => a + v, 0);

  // --- same-second sweep structure: group by (conditionId, exact unix second) ---
  const groups = new Map<string, RawTrade[]>();
  for (const t of trades) {
    const key = `${t.conditionId}@${t.timestamp}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  let multiLegGroups = 0;
  let sameSecondFills = 0;
  let sameSecondNotional = 0;
  const legsPerSecond: number[] = [];
  for (const arr of groups.values()) {
    legsPerSecond.push(arr.length);
    if (arr.length > 1) {
      multiLegGroups++;
      sameSecondFills += arr.length;
      sameSecondNotional += arr.reduce((a, t) => a + t.size * t.price, 0);
    }
  }

  // --- event->fill latency: kickoff (game_start_time) to fill ---
  const latencies: number[] = [];
  let beforeKickoff = 0;
  let within5min = 0;
  let withKickoff = 0;
  for (const t of trades) {
    const m = marketOf(cache, t.conditionId);
    const kickoff = isoToUnix(m?.game_start_time) ?? isoToUnix(m?.accepting_order_timestamp);
    if (kickoff == null) continue;
    withKickoff++;
    const dt = t.timestamp - kickoff;
    latencies.push(dt);
    if (dt < 0) beforeKickoff++;
    else if (dt <= 300) within5min++;
  }

  // --- intra-second mark displacement from prices-history windows ---
  // For each multi-leg sweep group, look at the bought token's price at the sweep second vs +60s.
  const sweepMoves: number[] = [];
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    const t = arr[0]!;
    const phKey = `https://clob.polymarket.com/prices-history?market=${t.asset}`;
    // find any cached prices-history for this asset
    const phEntry = Object.entries(cache).find(([k]) => k.startsWith(phKey));
    if (!phEntry) continue;
    const hist = (phEntry[1] as { history?: { t: number; p: number }[] })?.history;
    if (!Array.isArray(hist) || !hist.length) continue;
    const atOrBefore = (ts: number): number | null => {
      let out: number | null = null;
      for (const pt of hist) {
        if (pt.t <= ts) out = pt.p;
        else break;
      }
      return out;
    };
    const at = atOrBefore(t.timestamp);
    const after = atOrBefore(t.timestamp + 60);
    if (at != null && after != null) sweepMoves.push(after - at);
  }

  // --- odds histogram ---
  const oddsHist = ODDS_BINS.map((b) => ({ label: b.label, count: 0, notional: 0 }));
  for (const t of trades) {
    const b = ODDS_BINS.findIndex((bb) => t.price >= bb.lo && t.price < bb.hi);
    if (b >= 0) {
      oddsHist[b]!.count++;
      oddsHist[b]!.notional += t.size * t.price;
    }
  }
  const vwapEntry = totalNotional > 0 ? trades.reduce((a, t) => a + t.price * t.size * t.price, 0) / totalNotional : NaN;

  // --- category + sport mix (by notional) ---
  const catNotional: Partial<Record<MarketCategory, number>> = {};
  const sportNotional: Partial<Record<SportsSubcategory, number>> = {};
  let sportsTotal = 0;
  for (const t of trades) {
    const w = t.size * t.price;
    const cat = categorizeMarket(t.title, t.eventSlug || t.slug);
    catNotional[cat] = (catNotional[cat] ?? 0) + w;
    if (cat === 'sports') {
      const sub = sportsSubcategory(t.title, t.eventSlug || t.slug);
      sportNotional[sub] = (sportNotional[sub] ?? 0) + w;
      sportsTotal += w;
    }
  }
  const categoryMix: Partial<Record<MarketCategory, number>> = {};
  for (const [k, v] of Object.entries(catNotional)) categoryMix[k as MarketCategory] = totalNotional > 0 ? v / totalNotional : 0;
  const sportsMix: Partial<Record<SportsSubcategory, number>> = {};
  for (const [k, v] of Object.entries(sportNotional)) sportsMix[k as SportsSubcategory] = sportsTotal > 0 ? v / sportsTotal : 0;

  // --- resolution (win-rate vs implied) ---
  let resolvedN = 0;
  let wins = 0;
  let impliedSum = 0;
  for (const t of trades) {
    const m = marketOf(cache, t.conditionId);
    const wt = winnerTokenOf(m);
    if (wt == null) continue;
    resolvedN++;
    if (t.asset === wt) wins++;
    impliedSum += t.price;
  }

  const ALL_CATS: MarketCategory[] = ['sports', 'crypto', 'politics', 'weather', 'macro', 'other'];

  return {
    label,
    wallet,
    nFills: n,
    totalNotional,
    medianNotional: median(notionals),
    nSecondGroups: groups.size,
    nGroupsMultiLeg: multiLegGroups,
    sameSecondFillShare: n ? sameSecondFills / n : NaN,
    sameSecondNotionalShare: totalNotional ? sameSecondNotional / totalNotional : NaN,
    legsPerSecondMax: legsPerSecond.length ? Math.max(...legsPerSecond) : 0,
    legsPerSecondP90: quantile(legsPerSecond, 0.9),
    nWithKickoff: withKickoff,
    latencyMedianSec: withKickoff ? median(latencies) : null,
    latencyP10Sec: withKickoff ? quantile(latencies, 0.1) : null,
    latencyP90Sec: withKickoff ? quantile(latencies, 0.9) : null,
    fillsBeforeKickoffPct: withKickoff ? beforeKickoff / withKickoff : null,
    fillsWithin5minPct: withKickoff ? within5min / withKickoff : null,
    sweepMarkMoveMeanPp: sweepMoves.length ? (sweepMoves.reduce((a, v) => a + v, 0) / sweepMoves.length) * 100 : null,
    oddsHist,
    sportsMix,
    categoryMix,
    vwapEntry,
    resolvedN,
    winRate: resolvedN ? wins / resolvedN : null,
    meanImplied: resolvedN ? impliedSum / resolvedN : null,
    untouchedOddsBands: oddsHist.filter((b) => b.count === 0).map((b) => b.label),
    untouchedCategories: ALL_CATS.filter((c) => !(categoryMix[c] && categoryMix[c]! > 0)),
  };
}

const pct = (v: number | null): string => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);
const usd = (v: number): string => (Number.isFinite(v) ? `$${Math.round(v).toLocaleString('en-US')}` : '—');
const secs = (v: number | null): string => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}s (${(v / 60).toFixed(1)}min)`);

function render(fps: Fingerprint[]): string {
  const L: string[] = [];
  L.push('# LANE C1 — Mechanism fingerprint of the live-edge SPORTS specialists', '');
  L.push('_Read-only forensics over the existing sports-scan cache. No new network, no orders, rail DORMANT._', '');
  for (const f of fps) {
    L.push(`## ${f.label} — \`${f.wallet}\``, '');
    L.push(`- **${f.nFills} BUY fills**, ${usd(f.totalNotional)} notional · median ${usd(f.medianNotional)} · VWAP entry ${f.vwapEntry.toFixed(3)}`);
    L.push(
      `- **SAME-SECOND SWEEP:** ${f.nGroupsMultiLeg}/${f.nSecondGroups} (condition,second) groups are multi-leg · ` +
        `${pct(f.sameSecondFillShare)} of fills share their exact second+market · ${pct(f.sameSecondNotionalShare)} of notional · ` +
        `max ${f.legsPerSecondMax} legs/second, p90 ${f.legsPerSecondP90.toFixed(0)}`,
    );
    L.push(
      `- **EVENT→FILL LATENCY** (kickoff→fill, n=${f.nWithKickoff}): median ${secs(f.latencyMedianSec)} · p10 ${secs(f.latencyP10Sec)} · p90 ${secs(f.latencyP90Sec)} · ` +
        `pre-kickoff ${pct(f.fillsBeforeKickoffPct)} · within 5min of kickoff ${pct(f.fillsWithin5minPct)}`,
    );
    L.push(`- **Intra-sweep mark move (+60s after a sweep second):** ${f.sweepMarkMoveMeanPp == null ? '—' : (f.sweepMarkMoveMeanPp >= 0 ? '+' : '') + f.sweepMarkMoveMeanPp.toFixed(2) + 'pp'}`);
    const sports = Object.entries(f.sportsMix).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => `${k} ${pct(v ?? 0)}`).join(', ');
    L.push(`- **Sub-sport mix:** ${sports || '—'}`);
    const cats = Object.entries(f.categoryMix).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k, v]) => `${k} ${pct(v ?? 0)}`).join(', ');
    L.push(`- **Category mix:** ${cats}`);
    L.push(`- **Resolved ${f.resolvedN} BUYs:** win ${pct(f.winRate)} vs implied ${pct(f.meanImplied)}`);
    L.push('- **Entry-odds histogram:**');
    for (const b of f.oddsHist) if (b.count > 0) L.push(`  - \`${b.label}\` — ${b.count} fills · ${usd(b.notional)}`);
    L.push(`- **DOES NOT touch:** odds bands [${f.untouchedOddsBands.join(', ')}] · categories [${f.untouchedCategories.join(', ')}]`);
    L.push('');
  }
  return L.join('\n');
}

function main(): void {
  const { values } = parseArgs({ options: { cache: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' } } });
  const cache = loadCache(values.cache ?? CACHE_PATH_DEFAULT);
  const fps = SPECIALISTS.map((s) => fingerprint(cache, s.label, s.wallet));
  const md = render(fps);
  const outBase = values.out ?? 'scripts/research/out/lane-c1-fingerprint';
  mkdirSync(dirname(outBase), { recursive: true });
  writeFileSync(`${outBase}.md`, md);
  writeFileSync(`${outBase}.json`, JSON.stringify(fps, null, 2));
  process.stderr.write(`[lane-c1] wrote ${outBase}.md + .json\n`);
  process.stdout.write(values.json ? JSON.stringify(fps, null, 2) : md);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
