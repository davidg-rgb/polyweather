/**
 * no-fade.ts — C11 (2026-07-08, operator-directed): the NEGATIVE / "NO-fade" convergence play across all cities.
 *
 * Thesis: in a daily-Tmax bucket ladder exactly ONE bucket wins, so NO pays on all the others. For buckets within
 * ±3 of our house-blend predicted bucket (1°/1°F per bucket → ±3 buckets ≈ ±3 degrees), BUY NO when it is priced
 * 50–70¢ (== YES best_bid 30–50¢), FLIP-sell (maker) when NO ≥ 80¢ (== YES best_ask ≤ 20¢); if never reached,
 * dump at the last observed NO bid. Also scores the HOLD-to-resolution reference (NO pays $1 if the bucket does
 * NOT win). Graded through the frozen §9R-E gate (`openingVerdict`, city-clustered) — one net-return row per
 * MARKET (a market's ±3 NO bets are one correlated portfolio; per-bucket rows would pseudo-replicate).
 *
 * NO prices are the complement of the stored YES top-of-book: buy NO at 1−best_bid, sell NO at 1−best_ask; the
 * taker fee rate·p·(1−p) is symmetric in p↔1−p. Real book (`market_snapshots`), no look-ahead, taker entry fee.
 * CAVEAT: top-of-book only (no depth walk — market_snapshots has no NO-side depth); this is an UPPER bound on
 * executability, exactly the quoted-vs-executable gap that false-passed cross-venue. Flag, don't forget.
 *
 * READ-ONLY (DATABASE_URL):  pnpm tsx scripts/research/no-fade.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import { openingVerdict, type OpeningMarketResult, type OpeningVerdict } from '../../packages/core/src/sim/opening-convergence.ts';

const STAKE = 10;
const FEE_RATE = 0.05;
const TP_NO = 0.8; // flip: maker-sell NO at 80¢ when the NO bid reaches it

interface Row {
  event_id: string; unit: string; city: string; td: string;
  bidx: number; pred_idx: number; win: number; dist: number; won: boolean;
  entry_no_ask: string | number; exit_reached: boolean; last_no_bid: string | number | null;
}
const num = (x: string | number | null | undefined): number => (x == null ? NaN : Number(x));

// entry NO_ask in [0.50,0.70] == YES best_bid in [0.30,0.50]; exit NO_bid ≥ 0.80 == YES best_ask ≤ 0.20.
const SQL = `
with pred as (
  select distinct on (bp.event_id) bp.event_id,
    (select ord-1 from unnest(bp.probs) with ordinality t(p,ord) order by p desc limit 1)::int pred_idx
  from bucket_probabilities bp
  where bp.source='house_gaussian' and bp.probs is not null
  order by bp.event_id, bp.made_at asc
),
nb as (
  select me.id event_id, me.unit, c.slug city, me.target_date::text td,
         me.winning_bucket_idx win, p.pred_idx, mb.bucket_idx bidx, ms.captured_at t,
         (1 - ms.best_bid::numeric) no_ask, (1 - ms.best_ask::numeric) no_bid
  from market_events me
  join pred p on p.event_id=me.id
  join cities c on c.id=me.city_id
  join market_buckets mb on mb.event_id=me.id and abs(mb.bucket_idx-p.pred_idx)<=3
  join market_snapshots ms on ms.bucket_id=mb.id
  where me.kind='highest' and me.winning_bucket_idx is not null
    and ms.best_bid is not null and ms.best_ask is not null
),
entry as (
  select distinct on (event_id,bidx) event_id,bidx,unit,city,td,win,pred_idx,t entry_t, no_ask entry_no_ask
  from nb where no_ask >= 0.50 and no_ask <= 0.70
  order by event_id,bidx,t asc
),
ex as (
  select distinct on (nb.event_id,nb.bidx) nb.event_id,nb.bidx
  from nb join entry e on e.event_id=nb.event_id and e.bidx=nb.bidx
  where nb.t > e.entry_t and nb.no_bid >= 0.80
  order by nb.event_id,nb.bidx,nb.t asc
),
lastbid as (
  select distinct on (nb.event_id,nb.bidx) nb.event_id,nb.bidx, nb.no_bid last_no_bid
  from nb join entry e on e.event_id=nb.event_id and e.bidx=nb.bidx
  where nb.t >= e.entry_t
  order by nb.event_id,nb.bidx,nb.t desc
)
select e.event_id, e.unit, e.city, e.td, e.bidx, e.pred_idx, e.win,
       abs(e.bidx-e.pred_idx) dist, (e.bidx <> e.win) won,
       e.entry_no_ask, (ex.event_id is not null) exit_reached, lb.last_no_bid
from entry e
left join ex on ex.event_id=e.event_id and ex.bidx=e.bidx
join lastbid lb on lb.event_id=e.event_id and lb.bidx=e.bidx
order by e.event_id, e.bidx`;

interface Trade { flipNet: number; holdNet: number; won: boolean; completed: boolean; dist: number; city: string; td: string; event_id: string; }

function grade(r: Row): Trade {
  const entry = num(r.entry_no_ask);
  const shares = STAKE / entry;
  const entryFee = shares * takerFeePerShare(entry, FEE_RATE);
  // FLIP: maker sell at 0.80 if reached (0 fee), else taker dump at last NO bid.
  let flipPayoff: number, flipExitFee = 0;
  if (r.exit_reached) { flipPayoff = shares * TP_NO; }
  else { const dump = num(r.last_no_bid) || 0; flipPayoff = shares * dump; flipExitFee = shares * takerFeePerShare(dump, FEE_RATE); }
  const flipNet = flipPayoff - STAKE - entryFee - flipExitFee;
  // HOLD: NO pays $1 if the bucket does NOT win.
  const holdNet = shares * (r.won ? 1 : 0) - STAKE - entryFee;
  return { flipNet, holdNet, won: r.won, completed: r.exit_reached, dist: r.dist, city: r.city, td: r.td, event_id: r.event_id };
}

/** aggregate per MARKET (sum the bucket trades) → one net-return row per market for the gate. */
function perMarket(trades: Trade[], pick: (t: Trade) => number): OpeningMarketResult[] {
  const byEvent = new Map<string, { city: string; td: string; net: number; n: number }>();
  for (const t of trades) {
    const e = byEvent.get(t.event_id) ?? { city: t.city, td: t.td, net: 0, n: 0 };
    e.net += pick(t); e.n += 1; byEvent.set(t.event_id, e);
  }
  return [...byEvent.values()].map((e) => {
    const stake = e.n * STAKE;
    return { city: e.city, targetDate: e.td, netPnlUsd: e.net, stakeUsd: stake, netReturn: e.net / stake, executed: true };
  });
}

const pct = (x: number | undefined): string => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(2)}%`);
const money = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(0);

function reportGate(label: string, rows: OpeningMarketResult[]): OpeningVerdict {
  const v = openingVerdict(rows, { dayBlockNull: true });
  const nWon = rows.filter((r) => r.netPnlUsd > 0).length;
  const rawRoi = rows.length ? rows.reduce((a, r) => a + r.netPnlUsd, 0) / rows.reduce((a, r) => a + r.stakeUsd, 0) : NaN;
  console.log(`\n  ── ${label} ──  (n=${rows.length} markets, ${new Set(rows.map((r) => r.city)).size} cities, ${new Set(rows.map((r) => r.targetDate)).size} days)`);
  console.log(`     raw ROI ${pct(rawRoi)} · market-winFrac ${pct(nWon / rows.length)} · net ${money(rows.reduce((a, r) => a + r.netPnlUsd, 0))}`);
  console.log(`     §9R-E: ${v.label} — city-clustered mean ${pct(v.meanNetReturn)} CI [${pct(v.ciLow)}, ${pct(v.ciHigh)}] (${v.nCities} cities) · winFrac ${pct(v.winFrac)} · zsMC ${pct(v.zeroSkillPassRate)} · dayCI [${pct(v.dayBlockCiLow)}, ${pct(v.dayBlockCiHigh)}]`);
  return v;
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, []);
    const trades = rows.map(grade);
    console.log(`\nNO-FADE — buy NO 50–70¢ on ±3-neighborhood buckets, flip-sell at ≥80¢ (else dump); HOLD reference too.`);
    console.log(`${trades.length} NO positions entered across ${new Set(trades.map((t) => t.event_id)).size} markets / ${new Set(trades.map((t) => t.city)).size} cities · $${STAKE}/position · real book (top-of-book NO = 1−YES) · taker entry fee`);

    // per-distance breakdown (0 = our own predicted bucket; 1–3 = neighbors)
    console.log(`\n  BY DISTANCE FROM PREDICTED BUCKET (dist 0 = fading our own pick):`);
    console.log(`    dist   n    NO-win%  flipDone%   flip net    flip ROI    hold net    hold ROI`);
    for (const d of [0, 1, 2, 3]) {
      const ts = trades.filter((t) => t.dist === d);
      if (!ts.length) continue;
      const fnet = ts.reduce((a, t) => a + t.flipNet, 0), hnet = ts.reduce((a, t) => a + t.holdNet, 0);
      const stake = ts.length * STAKE;
      console.log(`    ${String(d).padEnd(5)} ${String(ts.length).padStart(4)}   ${pct(ts.filter((t) => t.won).length / ts.length).padStart(6)}   ${pct(ts.filter((t) => t.completed).length / ts.length).padStart(7)}   ${money(fnet).padStart(8)}   ${pct(fnet / stake).padStart(7)}   ${money(hnet).padStart(8)}   ${pct(hnet / stake).padStart(7)}`);
    }

    // §9R-E gate: per-market portfolios, both filter directions × {flip, hold}
    console.log(`\n  §9R-E GATE (per-market portfolios, city-clustered):`);
    const all = trades, neigh = trades.filter((t) => t.dist >= 1); // all±3 (incl our pick) vs neighbors-only
    const verdicts = {
      flip_all: reportGate('FLIP · all ±3 (incl our own bucket)', perMarket(all, (t) => t.flipNet)),
      flip_neigh: reportGate('FLIP · neighbors only (dist 1–3)', perMarket(neigh, (t) => t.flipNet)),
      hold_all: reportGate('HOLD · all ±3', perMarket(all, (t) => t.holdNet)),
      hold_neigh: reportGate('HOLD · neighbors only (dist 1–3)', perMarket(neigh, (t) => t.holdNet)),
    };
    console.log('');
    console.log('RESULT ' + JSON.stringify(Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, { label: v.label, mean: v.meanNetReturn, ciLow: v.ciLow, ciHigh: v.ciHigh, winFrac: v.winFrac, zsMC: v.zeroSkillPassRate, n: v.nMarkets, cities: v.nCities }]))));
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
