/**
 * no-fade-grid.ts — C12 (2026-07-08, operator-directed): sweep buy × sell for the NO-fade, find any net-profitable cell.
 *
 * Extends no-fade.ts: instead of the single (buy 50–70¢ / sell 80¢) cell, grid the full ENTRY band × EXIT target
 * space on the NO side and gate every cell for net profitability. Goal: is ANY (buy,sell) combination net-profitable
 * (city-clustered mean net-return with ciLow > 0)?
 *   • ENTRY: buy NO the first tick its ask lands in a band [lo,hi] (NO ask = 1 − YES best_bid).
 *   • EXIT (flip): maker-sell NO at the target X when the NO bid first reaches it (NO bid = 1 − YES best_ask); if X
 *     is never reached, dump at the last observed NO bid (taker). HOLD-to-resolution reference per entry band too.
 * One net-return row per MARKET (a market's ±3 NO bets are one correlated portfolio) through `openingVerdict`.
 *
 * Micro-safe: ONE plain neighborhood pull (no DB-side window functions — those trip the 8s statement timeout), all
 * grid + gate work in-memory. Real book, top-of-book NO (depth only makes it worse), no look-ahead, taker fees.
 * READ-ONLY (DATABASE_URL):  pnpm tsx scripts/research/no-fade-grid.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import { openingVerdict, type OpeningMarketResult, type OpeningVerdict } from '../../packages/core/src/sim/opening-convergence.ts';

const STAKE = 10;
const FEE_RATE = 0.05;
const ENTRY_BANDS = [
  { c: 35, lo: 0.30, hi: 0.40 }, { c: 45, lo: 0.40, hi: 0.50 }, { c: 55, lo: 0.50, hi: 0.60 },
  { c: 65, lo: 0.60, hi: 0.70 }, { c: 75, lo: 0.70, hi: 0.80 }, { c: 85, lo: 0.80, hi: 0.90 },
];
const EXITS = [0.70, 0.75, 0.80, 0.85, 0.90, 0.95];

interface Raw { event_id: string; city: string; td: string; bidx: number; won: boolean; dist: number; no_ask: string | number; no_bid: string | number; }
const num = (x: string | number | null | undefined): number => (x == null ? NaN : Number(x));

const SQL = `
with pred as (
  select distinct on (bp.event_id) bp.event_id,
    (select ord-1 from unnest(bp.probs) with ordinality t(p,ord) order by p desc limit 1)::int pred_idx
  from bucket_probabilities bp where bp.source='house_gaussian' and bp.probs is not null
  order by bp.event_id, bp.made_at asc
)
select me.id event_id, c.slug city, me.target_date::text td, mb.bucket_idx bidx,
       (mb.bucket_idx <> me.winning_bucket_idx) won, abs(mb.bucket_idx - p.pred_idx) dist,
       (1 - ms.best_bid::numeric) no_ask, (1 - ms.best_ask::numeric) no_bid
from market_events me
join pred p on p.event_id=me.id
join cities c on c.id=me.city_id
join market_buckets mb on mb.event_id=me.id and abs(mb.bucket_idx - p.pred_idx) <= 3
join market_snapshots ms on ms.bucket_id=mb.id
where me.kind='highest' and me.winning_bucket_idx is not null and ms.best_bid is not null and ms.best_ask is not null
order by me.id, mb.bucket_idx, ms.captured_at`;

interface Series { event_id: string; city: string; td: string; won: boolean; dist: number; ask: number[]; bid: number[]; }
interface Trade { entry: number; maxBidAfter: number; lastBid: number; won: boolean; event_id: string; city: string; td: string; }

/** first tick whose NO ask is in [lo,hi]; then max NO bid strictly after, and the last NO bid. null if never entered. */
function enter(s: Series, lo: number, hi: number): Trade | null {
  let ei = -1;
  for (let i = 0; i < s.ask.length; i++) { const a = s.ask[i]!; if (Number.isFinite(a) && a >= lo && a <= hi) { ei = i; break; } }
  if (ei < 0) return null;
  let maxAfter = Number.NEGATIVE_INFINITY;
  for (let i = ei + 1; i < s.bid.length; i++) { const b = s.bid[i]!; if (Number.isFinite(b) && b > maxAfter) maxAfter = b; }
  let lastBid = NaN;
  for (let i = s.bid.length - 1; i >= ei; i--) { if (Number.isFinite(s.bid[i]!)) { lastBid = s.bid[i]!; break; } }
  return { entry: s.ask[ei]!, maxBidAfter: maxAfter, lastBid, won: s.won, event_id: s.event_id, city: s.city, td: s.td };
}

/** flip P&L: maker-sell at X if the NO bid reached it after entry (0 fee); else taker-dump at the last NO bid. */
function flipNet(t: Trade, X: number): number {
  const shares = STAKE / t.entry;
  const entryFee = shares * takerFeePerShare(t.entry, FEE_RATE);
  if (Number.isFinite(t.maxBidAfter) && t.maxBidAfter >= X) return shares * X - STAKE - entryFee; // maker sell @ X
  const dump = Number.isFinite(t.lastBid) ? t.lastBid : 0;
  return shares * dump - STAKE - entryFee - shares * takerFeePerShare(dump, FEE_RATE); // taker dump
}
function holdNet(t: Trade): number {
  const shares = STAKE / t.entry;
  return shares * (t.won ? 1 : 0) - STAKE - shares * takerFeePerShare(t.entry, FEE_RATE);
}

function perMarket(trades: Trade[], pick: (t: Trade) => number): OpeningMarketResult[] {
  const by = new Map<string, { city: string; td: string; net: number; n: number }>();
  for (const t of trades) { const e = by.get(t.event_id) ?? { city: t.city, td: t.td, net: 0, n: 0 }; e.net += pick(t); e.n++; by.set(t.event_id, e); }
  return [...by.values()].map((e) => ({ city: e.city, targetDate: e.td, netPnlUsd: e.net, stakeUsd: e.n * STAKE, netReturn: e.net / (e.n * STAKE), executed: true }));
}
const pct = (x: number | undefined): string => (x == null || !Number.isFinite(x) ? '  —' : `${(x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(1)}%`);

interface Cell { entry: number; exit: number | 'hold'; label: string; mean: number; ciLow: number; ciHigh: number; roi: number; n: number; cities: number; }
function cellOf(entry: number, exit: number | 'hold', rows: OpeningMarketResult[]): Cell {
  const v: OpeningVerdict = openingVerdict(rows, { dayBlockNull: true });
  const roi = rows.length ? rows.reduce((a, r) => a + r.netPnlUsd, 0) / rows.reduce((a, r) => a + r.stakeUsd, 0) : NaN;
  return { entry, exit, label: v.label, mean: v.meanNetReturn, ciLow: v.ciLow, ciHigh: v.ciHigh, roi, n: v.nMarkets, cities: v.nCities };
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    console.error('pulling neighborhood NO series (one plain join)…');
    const raw = await db.query<Raw>(SQL, []);
    console.error(`  ${raw.length} ticks; grouping…`);
    // group ordered rows into per-(event,bucket) series
    const series: Series[] = [];
    let cur: Series | null = null; let curKey = '';
    for (const r of raw) {
      const key = r.event_id + '|' + r.bidx;
      if (key !== curKey) { cur = { event_id: r.event_id, city: r.city, td: r.td, won: r.won, dist: r.dist, ask: [], bid: [] }; series.push(cur); curKey = key; }
      cur!.ask.push(num(r.no_ask)); cur!.bid.push(num(r.no_bid));
    }

    const cells: Cell[] = [];
    console.log(`\nNO-FADE GRID — buy NO in band × sell NO at target, all ±3 buckets, ${new Set(series.map((s) => s.event_id)).size} markets`);
    console.log(`(cell = city-clustered mean net-return; a robustly-profitable cell needs ciLow > 0)\n`);
    console.log(`  BUY↓ \\ SELL→ ` + EXITS.map((x) => `${(x * 100).toFixed(0)}¢`.padStart(8)).join('') + '     HOLD');
    for (const b of ENTRY_BANDS) {
      const trades = series.map((s) => enter(s, b.lo, b.hi)).filter((t): t is Trade => t !== null);
      const rowStr: string[] = [];
      for (const X of EXITS) {
        if (X <= b.hi) { rowStr.push('   —'.padStart(8)); continue; } // must sell higher than the entry band
        const c = cellOf(b.c, X, perMarket(trades, (t) => flipNet(t, X))); cells.push(c);
        rowStr.push((pct(c.mean) + (c.ciLow > 0 ? '*' : '')).padStart(8));
      }
      const hc = cellOf(b.c, 'hold', perMarket(trades, holdNet)); cells.push(hc);
      console.log(`  buy ${String(b.c).padStart(2)}¢  ` + rowStr.join('') + `   ` + (pct(hc.mean) + (hc.ciLow > 0 ? '*' : '')).padStart(7) + `  (n=${trades.length})`);
    }

    const profitable = cells.filter((c) => c.ciLow > 0);
    const best = [...cells].sort((a, b) => b.mean - a.mean).slice(0, 8);
    console.log(`\n  BEST CELLS (by city-clustered mean net-return):`);
    console.log(`    buy   sell    n    cities   mean      95% CI              §9R-E`);
    for (const c of best) console.log(`    ${String(c.entry).padStart(2)}¢   ${String(c.exit).padStart(4)}  ${String(c.n).padStart(4)}    ${String(c.cities).padStart(2)}    ${pct(c.mean).padStart(6)}   [${pct(c.ciLow)}, ${pct(c.ciHigh)}]   ${c.label}`);
    console.log(`\n  NET-PROFITABLE cells (city-clustered ciLow > 0): ${profitable.length === 0 ? 'NONE — no buy/sell combination is robustly profitable.' : profitable.map((c) => `buy ${c.entry}¢/sell ${c.exit}`).join(', ')}`);
    console.log('');
    console.log('RESULT ' + JSON.stringify({ best: best.map((c) => ({ buy: c.entry, sell: c.exit, mean: c.mean, ciLow: c.ciLow, roi: c.roi, label: c.label, n: c.n })), nProfitable: profitable.length }));
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
