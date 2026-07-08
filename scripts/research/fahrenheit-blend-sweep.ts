/**
 * fahrenheit-blend-sweep.ts — WS-A operator iteration (2026-07-08): stop-loss + entry-ceiling sweep, no time limit.
 *
 * Change set vs `fahrenheit-blend-replay.ts` (the buy-10–15¢/sell-30¢ play):
 *   1. STOP-LOSS below 10¢: after entry, if the MID falls under 0.10 we sell at the prevailing best_bid (a taker
 *      dump). Trigger is the MID (not the bid) so the entry bid-ask spread doesn't insta-stop a position bought at
 *      a 13–20¢ ask. Whichever of TP (bid ≥ 0.30, maker) / SL (mid < 0.10, taker) fires FIRST in time order wins.
 *   2. ENTRY-CEILING SWEEP: floor 0.10, ceiling ∈ {0.15, 0.16, 0.17, 0.18, 0.19, 0.20}.
 *   3. NO TIME LIMIT: enter at the FIRST in-band ask at ANY time in the market's life (the 24h-after-live window
 *      is removed).
 * Everything else identical: house_gaussian earliest-forecast bucket, $10/position, hold-to-resolution fallback,
 * real book (`market_snapshots`), no look-ahead. READ-ONLY (DATABASE_URL).
 *   pnpm tsx scripts/research/fahrenheit-blend-sweep.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';

const STAKE = 10;
const ENTRY_MIN = 0.1;
const ENTRY_MAX_BANDS = [0.15, 0.16, 0.17, 0.18, 0.19, 0.2];
const TP = 0.3;
const SL_TRIGGER = 0.1; // mid < this ⇒ stop out
const FEE_RATE = 0.05;

interface Row {
  event_id: string; icao: string; winning_bucket_idx: number; pred_idx: number;
  first_seen: string; captured_at: string;
  best_bid: string | number | null; best_ask: string | number | null; mid: string | number | null;
}
const n = (x: string | number | null | undefined): number | null =>
  x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null;

const SQL = `
with f as (
  select me.id, me.icao_at_creation icao, me.winning_bucket_idx, me.first_seen
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
select f.id event_id, f.icao, f.winning_bucket_idx, p.pred_idx, f.first_seen,
  ms.captured_at, ms.best_bid, ms.best_ask, ms.mid
from f join pred p on p.event_id=f.id
join market_buckets mb on mb.event_id=f.id and mb.bucket_idx=p.pred_idx
join market_snapshots ms on ms.bucket_id=mb.id
order by f.id, ms.captured_at`;

const ENTRY_WINDOW_H = 24;
type Exit = 'TP' | 'SL' | 'HOLD_WIN' | 'HOLD_LOSS';
interface Trade { exit: Exit; entryAsk: number; net: number; entryH: number }
interface Opts { stopLoss: boolean; timeLimit: boolean }

function replay(snaps: Row[], predWon: boolean, entryMax: number, o: Opts): Trade | null {
  const first = new Date(snaps[0]!.first_seen).getTime();
  let ei = -1, entryAsk = NaN, entryH = NaN;
  for (let i = 0; i < snaps.length; i++) {
    const ask = n(snaps[i]!.best_ask);
    const h = (new Date(snaps[i]!.captured_at).getTime() - first) / 3.6e6;
    if (ask != null && ask >= ENTRY_MIN && ask <= entryMax && (!o.timeLimit || (h >= 0 && h <= ENTRY_WINDOW_H))) {
      ei = i; entryAsk = ask; entryH = h; break;
    }
  }
  if (ei < 0) return null;
  const shares = STAKE / entryAsk;
  const entryFee = shares * takerFeePerShare(entryAsk, FEE_RATE);
  let exit: Exit | null = null, payoff = 0, exitFee = 0;
  for (let i = ei + 1; i < snaps.length; i++) {
    const bid = n(snaps[i]!.best_bid);
    const mid = n(snaps[i]!.mid);
    if (bid != null && bid >= TP) { exit = 'TP'; payoff = shares * TP; exitFee = 0; break; } // maker sell @0.30
    if (o.stopLoss && mid != null && mid < SL_TRIGGER) {
      const fill = bid != null && bid > 0 ? bid : mid ?? 0; // dump at the bid
      exit = 'SL'; payoff = shares * fill; exitFee = shares * takerFeePerShare(fill, FEE_RATE); break;
    }
  }
  if (exit == null) { exit = predWon ? 'HOLD_WIN' : 'HOLD_LOSS'; payoff = predWon ? shares : 0; }
  return { exit, entryAsk, entryH, net: payoff - STAKE - entryFee - exitFee };
}

const money = (x: number) => (x >= 0 ? '+$' : '-$') + Math.abs(x).toFixed(2);

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, []);
    const byEvent = new Map<string, Row[]>();
    for (const r of rows) (byEvent.get(r.event_id) ?? byEvent.set(r.event_id, []).get(r.event_id)!).push(r);
    const events = [...byEvent.values()].map((s) => ({ snaps: s, predWon: s[0]!.pred_idx === s[0]!.winning_bucket_idx }));

    console.log(`\nFAHRENHEIT HOUSE-BLEND — stop-loss + entry-ceiling sweep, decomposed. Source market_snapshots · $${STAKE}/pos · ${byEvent.size} markets`);
    console.log(`sell@30¢ (maker); SL = mid<10¢ → dump at bid (taker); hold-to-resolution fallback. Baseline (10–15¢/24h/no-SL) = 42 trades, 42.9% win, −$32 / −7.6%.\n`);

    const configs: { name: string; o: Opts }[] = [
      { name: 'A · NO stop-loss, 24h entry window (baseline + sweep)', o: { stopLoss: false, timeLimit: true } },
      { name: 'B · + stop-loss (mid<10¢), 24h entry window', o: { stopLoss: true, timeLimit: true } },
      { name: 'C · + stop-loss + NO time limit  ← the full request', o: { stopLoss: true, timeLimit: false } },
    ];
    for (const cfg of configs) {
      console.log(`  ${cfg.name}`);
      console.log(`    entryBand   N    win%    TP   SL   holdW holdL   avgEntry  avgEntryH   netMaker    ROI`);
      for (const emax of ENTRY_MAX_BANDS) {
        const ts: Trade[] = [];
        for (const e of events) { const t = replay(e.snaps, e.predWon, emax, cfg.o); if (t) ts.push(t); }
        const N = ts.length;
        if (N === 0) { console.log(`    10–${(emax * 100).toFixed(0)}¢       0`); continue; }
        const c = (x: Exit) => ts.filter((t) => t.exit === x).length;
        const wins = ts.filter((t) => t.net > 0).length;
        const net = ts.reduce((a, t) => a + t.net, 0);
        const avgE = ts.reduce((a, t) => a + t.entryAsk, 0) / N;
        const avgH = ts.reduce((a, t) => a + t.entryH, 0) / N;
        console.log(
          `    10–${(emax * 100).toFixed(0)}¢     ${String(N).padStart(3)}   ${((wins / N) * 100).toFixed(1).padStart(4)}%   ${String(c('TP')).padStart(3)}  ${String(c('SL')).padStart(3)}   ${String(c('HOLD_WIN')).padStart(3)}   ${String(c('HOLD_LOSS')).padStart(3)}     ${avgE.toFixed(3)}   ${avgH.toFixed(1).padStart(5)}h   ${money(net).padStart(9)}  ${((net / (N * STAKE)) * 100).toFixed(1)}%`,
        );
      }
      console.log('');
    }
    console.log(`  win% = net-positive trades. TP=sold@30¢, SL=stopped (mid<10¢, sold at bid), holdL=resolved $0.\n`);
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
