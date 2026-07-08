/**
 * hold-band-gate.ts — C10 (2026-07-08): adjudicate the house-blend HOLD-TO-RESOLUTION band with the frozen §9R-E gate.
 *
 * WS-A C9 found the °C 20¢ hold band nets +1.1% (+$50 / 447 markets) — the first non-negative hold across °F/°C,
 * but a RAW ungated point estimate. This runs it properly: build one {city, targetDate, netReturn, netPnlUsd}
 * row per market entered in the band, then feed the TS SOURCE-OF-TRUTH `openingVerdict` (city-clustered 95% CI
 * with ciLow>0 + zero-skill sign-flip MC <5%, plus the opt-in DAY-BLOCK tightening — same-day weather correlates
 * across cities, so days are the stricter independent unit). Only a clustered ciLow>0 promotes it; else efficient.
 *
 * Play: house_gaussian earliest-forecast bucket, buy the first ask in the band, HOLD for $1/$0. $10/position,
 * real book (`market_snapshots` best_ask), no look-ahead, taker entry fee.
 * READ-ONLY (DATABASE_URL):  pnpm tsx scripts/research/hold-band-gate.ts [--unit F|C] [--band <center¢>]  (default C, 20)
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import { openingVerdict, type OpeningMarketResult } from '../../packages/core/src/sim/opening-convergence.ts';

const STAKE = 10;
const FEE_RATE = 0.05;

const arg = (flag: string, def: string): string => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? def) : def;
};
const UNIT = arg('--unit', 'C').toUpperCase();
if (UNIT !== 'F' && UNIT !== 'C') { console.error(`--unit must be F or C (got '${UNIT}')`); process.exit(1); }
const BAND_C = Number(arg('--band', '20')); // band centre in cents
const LO = (BAND_C - 2) / 100, HI = (BAND_C + 2) / 100; // ±2¢ band — matches fahrenheit-blend-grid ENTRY_BANDS

interface Row {
  event_id: string; city: string; target_date: string;
  winning_bucket_idx: number; pred_idx: number; best_ask: string | number | null;
}
const n = (x: string | number | null | undefined): number | null =>
  x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null;

const SQL = `
with f as (
  select me.id, c.slug city, me.target_date, me.winning_bucket_idx
  from market_events me join cities c on c.id=me.city_id
  where me.kind='highest' and me.unit=$1 and me.winning_bucket_idx is not null
),
pred as (
  select distinct on (bp.event_id) bp.event_id,
    (select ord-1 from unnest(bp.probs) with ordinality t(p,ord) order by p desc limit 1)::int pred_idx
  from bucket_probabilities bp
  where bp.source='house_gaussian' and bp.probs is not null
  order by bp.event_id, bp.made_at asc
)
select f.id event_id, f.city, f.target_date::text target_date, f.winning_bucket_idx, p.pred_idx, ms.best_ask
from f join pred p on p.event_id=f.id
join market_buckets mb on mb.event_id=f.id and mb.bucket_idx=p.pred_idx
join market_snapshots ms on ms.bucket_id=mb.id
order by f.id, ms.captured_at`;

const pct = (x: number | undefined): string => (x == null || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(2)}%`);

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, [UNIT]);
    const byEvent = new Map<string, Row[]>();
    for (const r of rows) (byEvent.get(r.event_id) ?? byEvent.set(r.event_id, []).get(r.event_id)!).push(r);

    // one hold-to-resolution row per market that traded through the band (same entry rule as the grid)
    const results: OpeningMarketResult[] = [];
    for (const snaps of byEvent.values()) {
      let entryAsk = NaN;
      for (const s of snaps) { const a = n(s.best_ask); if (a != null && a >= LO && a <= HI) { entryAsk = a; break; } }
      if (!Number.isFinite(entryAsk)) continue; // never entered the band
      const shares = STAKE / entryAsk;
      const entryFee = shares * takerFeePerShare(entryAsk, FEE_RATE);
      const won = snaps[0]!.pred_idx === snaps[0]!.winning_bucket_idx; // per-event constant
      const netPnlUsd = shares * (won ? 1 : 0) - STAKE - entryFee; // hold → $1/$0, no exit fee
      results.push({
        city: snaps[0]!.city, targetDate: snaps[0]!.target_date,
        netPnlUsd, stakeUsd: STAKE, netReturn: netPnlUsd / STAKE, executed: true,
      });
    }

    const v = openingVerdict(results, { dayBlockNull: true }); // frozen city gate + the opt-in day-block tightening
    const nWon = results.filter((r) => r.netPnlUsd > 0).length;
    const rawRoi = results.length ? results.reduce((a, r) => a + r.netPnlUsd, 0) / (results.length * STAKE) : NaN;

    console.log(`\n§9R-E GATE — °${UNIT} house-blend HOLD-TO-RESOLUTION, ${BAND_C}¢ band [${LO.toFixed(2)}, ${HI.toFixed(2)}]`);
    console.log(`raw: n=${results.length} markets · ${new Set(results.map((r) => r.city)).size} cities · ` +
      `${new Set(results.map((r) => r.targetDate)).size} days · ROI ${pct(rawRoi)} · winFrac ${pct(nWon / results.length)}`);
    console.log(`\n  VERDICT: ${v.label}`);
    console.log(`  city-clustered mean netReturn ${pct(v.meanNetReturn)}  95% CI [${pct(v.ciLow)}, ${pct(v.ciHigh)}]  (${v.nCities} cities, t)`);
    console.log(`  winFrac ${pct(v.winFrac)} (bar 50%)  ·  zero-skill sign-flip MC ${pct(v.zeroSkillPassRate)} (bar <5%)`);
    console.log(`  DAY-BLOCK (stricter): day-clustered CI [${pct(v.dayBlockCiLow)}, ${pct(v.dayBlockCiHigh)}]  ·  day-flip MC ${pct(v.zeroSkillPassRateDayBlock)}`);
    console.log(`\n  ${v.reason}\n`);
    // machine-readable line for the loop/agent harness
    console.log('RESULT ' + JSON.stringify({
      unit: UNIT, band: BAND_C, label: v.label, nMarkets: v.nMarkets, nCities: v.nCities, nDays: v.nDistinctDays,
      rawRoi, winFrac: v.winFrac, meanNetReturn: v.meanNetReturn, ciLow: v.ciLow, ciHigh: v.ciHigh,
      zsMC: v.zeroSkillPassRate, dayCiLow: v.dayBlockCiLow, dayCiHigh: v.dayBlockCiHigh, dayZsMC: v.zeroSkillPassRateDayBlock,
    }));
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
