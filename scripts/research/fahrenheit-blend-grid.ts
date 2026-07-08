/**
 * fahrenheit-blend-grid.ts — WS-A operator "full analysis" (2026-07-08): best ENTRY × EXIT for the °F flip.
 *
 * The play is a PURE FLIP — buy cheap, sell slightly more expensive, NEVER hold to resolution:
 *   • ENTRY: buy the first tick the house-blend-predicted bucket's ask lands in a band centred on E (so each row
 *     is a genuine "bought at ~E¢"). Any time in the market's life (no window — the only rule is buy-cheap).
 *   • EXIT: a resting maker limit SELL at X (X > E) — fills the first tick the bid reaches X. (0 fee, maker.)
 *   • NOT HOLD TO FINISH: if X is never reached before the market resolves, DUMP at the last available bid
 *     (taker) — no $1/$0 resolution payout is ever collected.
 * Grid: entry E ∈ {5,10,15,20,25¢} × exit X ∈ {15,20,25,30,40,50¢}, cells with X > entry-band-high only.
 * house_gaussian earliest-forecast bucket · $10/position · real book (market_snapshots) · no look-ahead.
 * READ-ONLY (DATABASE_URL):  pnpm tsx scripts/research/fahrenheit-blend-grid.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';

const STAKE = 10;
const FEE_RATE = 0.05;
// entry bands (buy the first ask in [lo,hi]); label = the nominal entry price.
const ENTRY_BANDS = [
  { e: 5, lo: 0.03, hi: 0.07 },
  { e: 10, lo: 0.08, hi: 0.12 },
  { e: 15, lo: 0.13, hi: 0.17 },
  { e: 20, lo: 0.18, hi: 0.22 },
  { e: 25, lo: 0.23, hi: 0.27 },
];
const EXITS = [0.15, 0.2, 0.25, 0.3, 0.4, 0.5];

interface Row {
  event_id: string; icao: string; winning_bucket_idx: number; pred_idx: number;
  best_bid: string | number | null; best_ask: string | number | null;
}
const n = (x: string | number | null | undefined): number | null =>
  x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null;

const SQL = `
with f as (
  select me.id, me.icao_at_creation icao, me.winning_bucket_idx
  from market_events me
  where me.kind='highest' and me.unit='F' and me.winning_bucket_idx is not null
),
pred as (
  select distinct on (bp.event_id) bp.event_id,
    (select ord-1 from unnest(bp.probs) with ordinality t(p,ord) order by p desc limit 1)::int pred_idx
  from bucket_probabilities bp
  where bp.source='house_gaussian' and bp.probs is not null
  order by bp.event_id, bp.made_at asc
)
select f.id event_id, f.icao, f.winning_bucket_idx, p.pred_idx, ms.best_bid, ms.best_ask
from f join pred p on p.event_id=f.id
join market_buckets mb on mb.event_id=f.id and mb.bucket_idx=p.pred_idx
join market_snapshots ms on ms.bucket_id=mb.id
order by f.id, ms.captured_at`;

interface Cell { n: number; wins: number; flips: number; net: number; entrySum: number }
const fresh = (): Cell => ({ n: 0, wins: 0, flips: 0, net: 0, entrySum: 0 });

/** one market through one (band,X) flip; returns {net, entryAsk, flipped} or null (never entered the band). */
function flip(snaps: Row[], lo: number, hi: number, X: number): { net: number; entryAsk: number; flipped: boolean } | null {
  let ei = -1, entryAsk = NaN;
  for (let i = 0; i < snaps.length; i++) {
    const ask = n(snaps[i]!.best_ask);
    if (ask != null && ask >= lo && ask <= hi) { ei = i; entryAsk = ask; break; }
  }
  if (ei < 0) return null;
  const shares = STAKE / entryAsk;
  const entryFee = shares * takerFeePerShare(entryAsk, FEE_RATE);
  let lastBid: number | null = null;
  let payoff: number | null = null;
  let exitFee = 0;
  let flipped = false;
  for (let i = ei + 1; i < snaps.length; i++) {
    const bid = n(snaps[i]!.best_bid);
    if (bid == null) continue;
    lastBid = bid;
    if (bid >= X) { payoff = shares * X; exitFee = 0; flipped = true; break; } // maker sell @ X
  }
  if (payoff == null) {
    // NOT hold to finish — dump at the last observed bid (taker); ~0 if the bucket died.
    const fill = lastBid ?? 0;
    payoff = shares * fill;
    exitFee = shares * takerFeePerShare(fill, FEE_RATE);
  }
  return { net: payoff - STAKE - entryFee - exitFee, entryAsk, flipped };
}

const money = (x: number) => (x >= 0 ? '+' : '-') + '$' + Math.abs(x).toFixed(0);

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, []);
    const byEvent = new Map<string, Row[]>();
    for (const r of rows) (byEvent.get(r.event_id) ?? byEvent.set(r.event_id, []).get(r.event_id)!).push(r);
    const events = [...byEvent.values()];

    // compute every (band, X) cell
    interface Result { e: number; x: number; n: number; win: number; flip: number; net: number; roi: number; avgE: number }
    const results: Result[] = [];
    for (const b of ENTRY_BANDS) {
      for (const X of EXITS) {
        if (X <= b.hi) continue; // must sell higher than the entry band
        const c = fresh();
        for (const snaps of events) {
          const r = flip(snaps, b.lo, b.hi, X);
          if (!r) continue;
          c.n++; c.net += r.net; c.entrySum += r.entryAsk;
          if (r.net > 0) c.wins++;
          if (r.flipped) c.flips++;
        }
        if (c.n > 0)
          results.push({ e: b.e, x: X * 100, n: c.n, win: c.wins / c.n, flip: c.flips / c.n, net: c.net, roi: c.net / (c.n * STAKE), avgE: c.entrySum / c.n });
      }
    }

    console.log(`\n°F HOUSE-BLEND FLIP — full ENTRY×EXIT grid (buy cheap, sell higher, NEVER hold to resolution)`);
    console.log(`Source market_snapshots · $${STAKE}/position · ${events.length} °F markets · maker sell @ exit, taker dump if it never fills\n`);

    // ── matrix: net$ (rows entry, cols exit) ──
    console.log(`  NET $ (rows = buy ~E¢, cols = sell @ X¢):`);
    console.log(`    buy\\sell  ` + EXITS.map((x) => `${(x * 100).toFixed(0)}¢`.padStart(7)).join(''));
    for (const b of ENTRY_BANDS) {
      const cells = EXITS.map((x) => {
        const r = results.find((r) => r.e === b.e && r.x === x * 100);
        return (r ? money(r.net) : '·').padStart(7);
      });
      console.log(`    ${(b.e + '¢').padEnd(9)}` + cells.join(''));
    }
    // ── matrix: win% ──
    console.log(`\n  WIN % (net-positive trades):`);
    console.log(`    buy\\sell  ` + EXITS.map((x) => `${(x * 100).toFixed(0)}¢`.padStart(7)).join(''));
    for (const b of ENTRY_BANDS) {
      const cells = EXITS.map((x) => {
        const r = results.find((r) => r.e === b.e && r.x === x * 100);
        return (r ? `${(r.win * 100).toFixed(0)}%` : '·').padStart(7);
      });
      console.log(`    ${(b.e + '¢').padEnd(9)}` + cells.join(''));
    }

    // ── full sorted table (the operator's ask) ──
    console.log(`\n  ALL CELLS, ranked by net $ (n = positions entered, avgEntry = realized fill, flip% = sold at target):`);
    console.log(`    buy   sell   n    avgEntry  flip%   WIN%    net$      ROI`);
    for (const r of [...results].sort((a, b) => b.net - a.net)) {
      console.log(
        `    ${(r.e + '¢').padEnd(5)} ${(r.x + '¢').padEnd(5)}  ${String(r.n).padStart(3)}   ${r.avgE.toFixed(3)}    ${(r.flip * 100).toFixed(0).padStart(3)}%   ${(r.win * 100).toFixed(0).padStart(3)}%   ${money(r.net).padStart(6)}   ${(r.roi * 100).toFixed(1).padStart(6)}%`,
      );
    }
    const best = [...results].sort((a, b) => b.roi - a.roi)[0]!;
    const bestNet = [...results].sort((a, b) => b.net - a.net)[0]!;
    console.log(`\n  BEST by ROI : buy ${best.e}¢ / sell ${best.x}¢ → ${(best.win * 100).toFixed(0)}% win, ${money(best.net)} on ${best.n} trades (${(best.roi * 100).toFixed(1)}% ROI)`);
    console.log(`  BEST by net$: buy ${bestNet.e}¢ / sell ${bestNet.x}¢ → ${(bestNet.win * 100).toFixed(0)}% win, ${money(bestNet.net)} on ${bestNet.n} trades (${(bestNet.roi * 100).toFixed(1)}% ROI)\n`);
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
