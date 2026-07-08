/**
 * fahrenheit-blend-replay.ts — WS-A operator spec (2026-07-08): the house-blend °F buy-cheap / sell-at-30¢ replay.
 *
 * STRATEGY (exact, per the operator): our HOUSE BLEND model (`house_gaussian`) predicts a bucket for each °F
 * market's target day. Across the historic per-tick Polymarket book for ALL °F cities (`market_snapshots`, the
 * poll-markets book, ~5-min cadence — our saved book covering each market's full life), for every market whose
 * predicted bucket is offered CHEAP — best_ask in [0.10, 0.15] within 24h of the position going live — simulate a
 * $10 BUY at that ask, then SELL at 0.30 (a resting maker limit that fills the first time the bid reaches 0.30);
 * if 0.30 is never reached, HOLD TO RESOLUTION ($1 if the bought bucket won, else $0). Report win-rate + net P&L.
 *
 * NO LOOK-AHEAD: the predicted bucket = the EARLIEST `house_gaussian` argmax for the event (the forecast available
 * within 24h of listing, not a later one); the entry is the FIRST qualifying tick in time order; the exit walk
 * starts strictly AFTER entry and takes the FIRST bid ≥ 0.30 (a later up-tick can't retro-fill an earlier one).
 *
 * Fees: entry is a TAKER buy (cross to the ask) → 5% taker fee (GOOGLE_DEFAULTS.takerFeeRate). The 0.30 exit is a
 * resting MAKER sell → $0 fee (weather-market maker; the conservative sensitivity with a taker exit is printed too).
 *
 * READ-ONLY (DATABASE_URL). Run:  pnpm tsx scripts/research/fahrenheit-blend-replay.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';

const STAKE = 10;
const ENTRY_MIN = 0.1;
const ENTRY_MAX = 0.15;
const ENTRY_WINDOW_H = 24;
const TP = 0.3;
const FEE_RATE = 0.05;

interface Row {
  event_id: string;
  icao: string;
  target_date: string;
  winning_bucket_idx: number;
  pred_idx: number;
  first_seen: string;
  captured_at: string;
  best_bid: string | number | null;
  best_ask: string | number | null;
}
const n = (x: string | number | null | undefined): number | null =>
  x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null;

const SQL = `
with f as (
  select me.id, me.icao_at_creation icao, me.target_date, me.winning_bucket_idx, me.first_seen
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
select f.id event_id, f.icao, f.target_date::text target_date, f.winning_bucket_idx, p.pred_idx,
  f.first_seen, ms.captured_at, ms.best_bid, ms.best_ask
from f join pred p on p.event_id=f.id
join market_buckets mb on mb.event_id=f.id and mb.bucket_idx=p.pred_idx
join market_snapshots ms on ms.bucket_id=mb.id
order by f.id, ms.captured_at`;

interface Trade {
  event: string; city: string; date: string;
  entryAsk: number; entryH: number; shares: number;
  exit: 'TP' | 'HOLD_WIN' | 'HOLD_LOSS';
  won: boolean; // did the predicted bucket actually resolve as the winner?
  netMaker: number; netTaker: number;
  netHold: number; // counterfactual: no 30¢ TP, hold every entry to resolution ($1 win / $0 loss)
}

function replay(snaps: Row[], predWon: boolean): Trade | null {
  const first = new Date(snaps[0]!.first_seen).getTime();
  // ENTRY: first tick with ask in [ENTRY_MIN, ENTRY_MAX] within the first ENTRY_WINDOW_H hours.
  let entryI = -1;
  let entryAsk = NaN;
  let entryH = NaN;
  for (let i = 0; i < snaps.length; i++) {
    const ask = n(snaps[i]!.best_ask);
    const h = (new Date(snaps[i]!.captured_at).getTime() - first) / 3.6e6;
    if (ask != null && h >= 0 && h <= ENTRY_WINDOW_H && ask >= ENTRY_MIN && ask <= ENTRY_MAX) {
      entryI = i; entryAsk = ask; entryH = h; break;
    }
  }
  if (entryI < 0) return null; // never offered cheap in the window → no trade
  const shares = STAKE / entryAsk;
  const entryFee = shares * takerFeePerShare(entryAsk, FEE_RATE);
  // EXIT: first tick AFTER entry with bid ≥ TP → sell at TP; else hold to resolution.
  let exit: Trade['exit'];
  let payoff: number;
  let hitTp = false;
  for (let i = entryI + 1; i < snaps.length; i++) {
    const bid = n(snaps[i]!.best_bid);
    if (bid != null && bid >= TP) { hitTp = true; break; }
  }
  if (hitTp) { exit = 'TP'; payoff = shares * TP; }
  else if (predWon) { exit = 'HOLD_WIN'; payoff = shares * 1; }
  else { exit = 'HOLD_LOSS'; payoff = 0; }
  const exitFeeTaker = exit === 'TP' ? shares * takerFeePerShare(TP, FEE_RATE) : 0; // resolution has no exit trade
  const s = snaps[0]!;
  return {
    event: s.event_id, city: s.icao, date: s.target_date,
    entryAsk, entryH, shares,
    exit, won: predWon,
    netMaker: payoff - STAKE - entryFee, // 0.30 exit = maker (no fee)
    netTaker: payoff - STAKE - entryFee - exitFeeTaker, // conservative: taker exit
    netHold: shares * (predWon ? 1 : 0) - STAKE - entryFee, // no TP — hold every entry to resolution
  };
}

const money = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, []);
    const byEvent = new Map<string, Row[]>();
    for (const r of rows) (byEvent.get(r.event_id) ?? byEvent.set(r.event_id, []).get(r.event_id)!).push(r);

    const trades: Trade[] = [];
    for (const snaps of byEvent.values()) {
      const predWon = snaps[0]!.pred_idx === snaps[0]!.winning_bucket_idx;
      const t = replay(snaps, predWon);
      if (t) trades.push(t);
    }

    const N = trades.length;
    const nTp = trades.filter((t) => t.exit === 'TP').length;
    const nHoldWin = trades.filter((t) => t.exit === 'HOLD_WIN').length;
    const nHoldLoss = trades.filter((t) => t.exit === 'HOLD_LOSS').length;
    const wins = trades.filter((t) => t.netMaker > 0).length;
    const staked = N * STAKE;
    const sum = (f: (t: Trade) => number) => trades.reduce((a, t) => a + f(t), 0);
    const netMaker = sum((t) => t.netMaker);
    const netTaker = sum((t) => t.netTaker);
    const avgEntry = sum((t) => t.entryAsk) / N;
    const avgEntryH = sum((t) => t.entryH) / N;

    console.log(`\nFAHRENHEIT HOUSE-BLEND · BUY 10–15¢ within 24h of live · SELL at 30¢ (else hold to resolution)`);
    console.log(`Source: market_snapshots (poll-markets book, ~5-min) · house_gaussian earliest-forecast bucket · $${STAKE}/position\n`);
    console.log(`  Markets with a predicted-bucket book series : ${byEvent.size}`);
    console.log(`  ENTERED (ask 10–15¢ in first 24h)          : ${N}   (avg entry ${avgEntry.toFixed(3)} at ${avgEntryH.toFixed(1)}h after live)`);
    console.log(`\n  OUTCOME`);
    console.log(`    sold at 30¢ (TP hit)      : ${nTp}   (${((nTp / N) * 100).toFixed(0)}%)`);
    console.log(`    held → bucket WON ($1)    : ${nHoldWin}`);
    console.log(`    held → bucket LOST ($0)   : ${nHoldLoss}`);
    console.log(`\n  WIN-RATE (net-positive trades) : ${wins}/${N} = ${((wins / N) * 100).toFixed(1)}%`);
    console.log(`\n  NET P&L over ${N} positions ($${staked} staked):`);
    console.log(`    maker exit (0.30 limit, $0 fee) : ${money(netMaker)}   (ROI ${((netMaker / staked) * 100).toFixed(1)}%, ${money(netMaker / N)}/trade)`);
    console.log(`    taker exit (conservative)       : ${money(netTaker)}   (ROI ${((netTaker / staked) * 100).toFixed(1)}%, ${money(netTaker / N)}/trade)`);

    // counterfactual: what if we DIDN'T sell at 30¢ and just held every entry to resolution?
    const netHold = sum((t) => t.netHold);
    const nResWon = trades.filter((t) => t.won).length;
    console.log(`\n  COUNTERFACTUAL — no 30¢ TP, HOLD every entry to resolution:`);
    console.log(`    predicted bucket actually won : ${nResWon}/${N} = ${((nResWon / N) * 100).toFixed(1)}%`);
    console.log(`    net (hold-to-resolution)      : ${money(netHold)}   (ROI ${((netHold / staked) * 100).toFixed(1)}%, ${money(netHold / N)}/trade)`);
    console.log(`    ⇒ the 30¢ TP ${netMaker > netHold ? 'HELPS' : 'HURTS'} vs holding (${money(netMaker - netHold)} difference)`);

    // per-city
    const cities = [...new Set(trades.map((t) => t.city))].sort();
    console.log(`\n  BY CITY (net maker):`);
    console.log(`    city    n   win%   sold@30¢   net$`);
    for (const c of cities) {
      const ct = trades.filter((t) => t.city === c);
      const w = ct.filter((t) => t.netMaker > 0).length;
      const tp = ct.filter((t) => t.exit === 'TP').length;
      console.log(`    ${c.padEnd(6)} ${String(ct.length).padStart(2)}   ${((w / ct.length) * 100).toFixed(0).padStart(3)}%   ${String(tp).padStart(2)}        ${money(sum2(ct))}`);
    }
    console.log('');
    function sum2(ts: Trade[]) { return ts.reduce((a, t) => a + t.netMaker, 0); }
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
