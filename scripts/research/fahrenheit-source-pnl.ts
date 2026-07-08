/**
 * fahrenheit-source-pnl.ts — WS-A C3b: does the blend's °F forecast accuracy convert to TAKER P&L, or is it
 * already priced? The money half of the C3a forecast-match verdict (blend 88% within-1 / 38% exact on °F).
 *
 * Strategy tested (the Google-play rules, blend-centered): for each resolved °F market, take the bucket the
 * chosen forecast points at (googleBucketIdx), read its taker ASK at a lead-1 bid time (the last book snapshot
 * before target_date 00:00 UTC — no look-ahead), ENTER if that ask is in a cheap band [askMin, askMax], and
 * HOLD TO RESOLUTION ($1 if the bought bucket won, else $0). Net per contract = payoff − ask − takerFee.
 * Sweeps askMax and compares BLEND vs raw GOOGLE vs the MARKET's own favorite (the cheapest-isn't-always-right
 * adverse-selection check the project keeps hitting, §12). City-clustered bootstrap CI on the net EV — the
 * §9R-E-style honest gate (is the whole CI > 0?).
 *
 * Reads persistent tables only (market_events / market_buckets / source_forecasts / bucket_probabilities /
 * market_snapshots) — the FULL resolved °F universe, not the pruned capture stream. READ-ONLY (DATABASE_URL).
 *   pnpm tsx scripts/research/fahrenheit-source-pnl.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { googleBucketIdx } from '../../packages/core/src/sim/google-bucket-replay.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import type { OpeningBucket } from '../../packages/core/src/sim/opening-convergence.ts';

const LEAD = 1;
const STAKE = 10;
const ASK_MIN = 0.02;
const ASK_MAX_BANDS = [0.12, 0.2, 0.3, 0.5, 1.0]; // 1.0 = "always enter at ask" (unconditional baseline)
const FEE_RATE = 0.05; // GOOGLE_DEFAULTS.takerFeeRate — the Polymarket taker fee used by every replay engine
const BOOT = 2000;

interface Row {
  event_id: string;
  icao: string;
  target_date: string;
  winning_bucket_idx: number;
  ladder: { idx: number; label: string }[] | null;
  blend_c: string | number | null;
  google_c: string | number | null;
  asks: Record<string, string | number | null> | null; // {bucket_idx: best_ask}
}
const num = (x: string | number | null | undefined): number | null =>
  x == null ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const mkBucket = (idx: number, label: string): OpeningBucket =>
  ({ idx, label, loF: null, hiF: null, mid: 0, bestAsk: 0, execAsk: 0, depthUsd: 0, bestBid: 0, sellbackUsd: 0, execBid: 0, sellbackDepthUsd: 0, houseProb: null, tokenYes: '', tokenNo: '', conditionId: '' }) as OpeningBucket;

const SQL = `
with fev as (
  select me.id, me.icao_at_creation icao, me.target_date, me.winning_bucket_idx
  from market_events me
  where me.kind='highest' and me.unit='F' and me.winning_bucket_idx is not null
),
last_ask as (
  select distinct on (mb.event_id, mb.bucket_idx) mb.event_id, mb.bucket_idx, ms.best_ask
  from fev f join market_buckets mb on mb.event_id=f.id
  join market_snapshots ms on ms.bucket_id=mb.id and ms.captured_at < f.target_date::timestamptz
  order by mb.event_id, mb.bucket_idx, ms.captured_at desc
),
asks as (select event_id, jsonb_object_agg(bucket_idx::text, best_ask) asks from last_ask group by event_id)
select f.id event_id, f.icao, f.target_date::text target_date, f.winning_bucket_idx,
  (select jsonb_agg(jsonb_build_object('idx', mb.bucket_idx, 'label', mb.label) order by mb.bucket_idx)
     from market_buckets mb where mb.event_id=f.id) as ladder,
  (select (bp.mu_native-32)*5.0/9.0 from bucket_probabilities bp where bp.event_id=f.id
     and bp.source='house_gaussian' and bp.lead_days=$1 and bp.mu_native is not null order by bp.made_at desc limit 1) blend_c,
  (select sf.tmax_c from source_forecasts sf where sf.icao=f.icao and sf.target_date=f.target_date
     and sf.source='google' and sf.lead_days=$1 order by sf.captured_at desc limit 1) google_c,
  a.asks
from fev f left join asks a on a.event_id=f.id
order by f.target_date, f.icao`;

interface Trade { city: string; net: number; win: number; ask: number }
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

/** deterministic city-clustered bootstrap 95% CI of mean net (per-contract), seeded per band index. */
function clusterCI(trades: Trade[], seed: number): [number, number] {
  if (trades.length < 2) return [NaN, NaN];
  const byCity = new Map<string, number[]>();
  for (const t of trades) (byCity.get(t.city) ?? byCity.set(t.city, []).get(t.city)!).push(t.net);
  const cities = [...byCity.values()];
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (1103515245 * s + 12345) >>> 0) / 0xffffffff);
  const means: number[] = [];
  for (let b = 0; b < BOOT; b++) {
    const pool: number[] = [];
    for (let i = 0; i < cities.length; i++) pool.push(...cities[Math.floor(rnd() * cities.length)]!);
    means.push(mean(pool));
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.025 * BOOT)]!, means[Math.floor(0.975 * BOOT)]!];
}

function run(events: Row[], pick: (r: Row) => number | null, askMax: number, seed: number) {
  const trades: Trade[] = [];
  for (const r of events) {
    const predIdx = pick(r);
    if (predIdx == null || !r.asks) continue;
    const ask = num(r.asks[String(predIdx)]);
    if (ask == null || ask < ASK_MIN || ask > askMax) continue;
    const win = predIdx === r.winning_bucket_idx ? 1 : 0;
    const shares = STAKE / ask;
    const netPerContract = win - ask - takerFeePerShare(ask, FEE_RATE); // $1 if win − ask paid − entry taker fee
    trades.push({ city: r.icao, net: netPerContract, win, ask });
  }
  const n = trades.length;
  const evNet = mean(trades.map((t) => t.net));
  const winR = mean(trades.map((t) => t.win));
  const avgAsk = mean(trades.map((t) => t.ask));
  const [lo, hi] = clusterCI(trades, seed);
  const totalNet = trades.reduce((a, t) => a + t.net * (STAKE / t.ask), 0);
  return { n, winR, avgAsk, evNet, lo, hi, totalNet, cities: new Set(trades.map((t) => t.city)).size };
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<Row>(SQL, [LEAD]);
    const events = rows.filter((r) => Array.isArray(r.ladder) && r.ladder.length > 0);
    const bucketIdx = (r: Row, c: number | null): number | null =>
      c == null ? null : googleBucketIdx(r.ladder!.map((b) => mkBucket(Number(b.idx), String(b.label))), c, 'F');
    const blendPick = (r: Row) => bucketIdx(r, num(r.blend_c));
    const googlePick = (r: Row) => bucketIdx(r, num(r.google_c));

    console.log(`\nFAHRENHEIT BLEND-BID P&L (WS-A C3b) — hold-to-resolution, lead-${LEAD} entry ask, $${STAKE}/entry`);
    console.log(`${events.length} resolved °F events with a ladder; entry band [${ASK_MIN}, askMax]; per-contract net EV + city-clustered 95% CI\n`);
    for (const [label, pick] of [['BLEND-centered', blendPick], ['GOOGLE-centered', googlePick]] as const) {
      console.log(`  ${label}:`);
      console.log(`    askMax   n / cities   win%   avgAsk   netEV/contract   CI95            total net$`);
      let seed = 1;
      for (const am of ASK_MAX_BANDS) {
        const x = run(events, pick, am, seed++);
        const ci = Number.isFinite(x.lo) ? `[${x.lo >= 0 ? '+' : ''}${x.lo.toFixed(3)}, ${x.hi >= 0 ? '+' : ''}${x.hi.toFixed(3)}]` : '  n/a';
        const pass = Number.isFinite(x.lo) && x.lo > 0 ? '  ✓PASS' : '';
        console.log(
          `    ${am.toFixed(2).padStart(5)}   ${String(x.n).padStart(3)} / ${String(x.cities).padStart(2)}    ${(x.winR * 100).toFixed(0).padStart(3)}%   ${x.avgAsk.toFixed(3)}   ${(x.evNet >= 0 ? '+' : '') + x.evNet.toFixed(3)}          ${ci.padEnd(18)} ${(x.totalNet >= 0 ? '+$' : '-$') + Math.abs(x.totalNet).toFixed(0)}${pass}`,
        );
      }
      console.log('');
    }
    console.log(`  Read: netEV/contract > 0 with CI95 excluding 0 = a real taker edge; ≤ 0 = the market prices it (efficient).`);
    console.log(`  (unconditional baseline = askMax 1.00; cheap bands test the underpriced-longshot / adverse-selection edge.)\n`);
  } finally {
    await db.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
