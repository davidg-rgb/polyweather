/**
 * scripts/research/reward-inventory-backtest — REC-10 (the IMPURE spine). Answers the question the
 * REC-8 first-pass left open with a GUESS: what is the REAL two-sided maker fill+inventory cost of
 * forecast-free liquidity-reward farming on weather — and does it leave the ~6.5%/day reward income
 * net-positive? Fictive capital, real odds. Pure analytics — places nothing, never imports
 * `packages/trading`, the live rail stays DORMANT.
 *
 * WHAT IT DOES (read-only):
 *   1. COST side (measured on history): load every RESOLVED weather bucket with a real best-bid/ask
 *      `market_snapshots` series + its win/lose outcome + weather-day, and simulate a continuously
 *      re-centred two-sided maker quote over that real book, carrying inventory to the REAL outcome
 *      (`core/sim/reward-inventory.simulateBucketInventory`). This MEASURES the adverse-selection /
 *      inventory cost the first-pass modelled as a free parameter `τ`.
 *   2. INCOME side (measured on the live funded universe): the reward yield from the real
 *      `market_rewards` captures (pool + in-band competing capital), via the capital-share model.
 *   3. SYNTHESIS + VERDICT: net = income + measured cost, per regime, with the binding MID-RANGE
 *      (93% of the pool) adjudicated against the PRE-REGISTERED REC-10 kill-criterion + a κ sweep.
 *
 * The model + frozen verdict live in `packages/core/src/sim/reward-inventory.ts` (pure, tested). This
 * spine is only the DB I/O + the report.
 *
 * Run: pnpm tsx scripts/research/reward-inventory-backtest.ts [--capital 100] [--offset 1]
 *        [--inv-cap 1] [--min-epochs 8] [--from 2026-05-01] [--to 2026-07-01] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type BucketInventoryResult,
  type FundedMarket,
  type InventoryParams,
  type QuoteSnapshot,
  type Regime,
  type ResolvedBucketSeries,
  DEFAULT_INVENTORY_PARAMS,
  regimeOf,
  runInventoryStudy,
  simulateBucketInventory,
} from '../../packages/core/src/sim/reward-inventory.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { Db } from '../lib/backfill.ts';

const dISO = (v: string | Date): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number, d = 0): string => (Number.isFinite(v) ? `$${v.toFixed(d)}` : '—');
const num = (v: string | undefined, d: number): number =>
  v != null && Number.isFinite(Number(v)) ? Number(v) : d;

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// loaders
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Load every resolved weather bucket with a real best-bid/ask series + win/lose + weather-day. */
export async function loadResolvedBuckets(db: Db, from: string, to: string): Promise<ResolvedBucketSeries[]> {
  const rows = await db.query<{
    bucket_id: string;
    icao: string | null;
    target_date: string | Date;
    resolved_outcome: string;
    ts: string | number;
    best_bid: string | number;
    best_ask: string | number;
  }>(
    `select b.id as bucket_id, me.icao_at_creation as icao, me.target_date, b.resolved_outcome,
            extract(epoch from s.captured_at)::bigint as ts, s.best_bid, s.best_ask
     from market_buckets b
     join market_events me on me.id = b.event_id
     join market_snapshots s on s.bucket_id = b.id
     where b.resolved_outcome in ('win','lose')
       and s.best_bid is not null and s.best_ask is not null
       and me.target_date >= $1 and me.target_date <= $2
     order by b.id, s.captured_at`,
    [from, to],
  );

  const byBucket = new Map<string, ResolvedBucketSeries>();
  for (const r of rows) {
    let b = byBucket.get(r.bucket_id);
    if (!b) {
      b = {
        key: r.bucket_id,
        station: r.icao ?? 'UNKNOWN',
        weatherDay: dISO(r.target_date),
        won: r.resolved_outcome === 'win',
        snapshots: [],
      };
      byBucket.set(r.bucket_id, b);
    }
    const s: QuoteSnapshot = { capturedAt: Number(r.ts), bid: Number(r.best_bid), ask: Number(r.best_ask) };
    b.snapshots.push(s);
  }
  return [...byBucket.values()];
}

/** Load the live funded universe (market_rewards), per-market averaged over all captured snapshots. */
export async function loadFundedUniverse(db: Db): Promise<{ markets: FundedMarket[]; captures: number; impliedYield: number }> {
  const rows = await db.query<{
    condition_id: string;
    pool: string | number;
    comp: string | number;
    mid: string | number | null;
  }>(
    `select condition_id,
            avg(daily_pool_usd) as pool,
            avg(coalesce(bid_depth_usd,0)+coalesce(ask_depth_usd,0)) as comp,
            avg(mid) as mid
     from market_rewards
     group by condition_id`,
  );
  const capRows = await db.query<{ n: string | number }>(
    `select count(distinct captured_at) as n from market_rewards`,
  );
  const markets: FundedMarket[] = rows.map((r) => ({
    conditionId: r.condition_id,
    dailyPoolUsd: Number(r.pool),
    competingCapitalUsd: Number(r.comp),
    mid: r.mid == null ? null : Number(r.mid),
  }));
  const totalPool = markets.reduce((a, m) => a + (Number.isFinite(m.dailyPoolUsd) ? m.dailyPoolUsd : 0), 0);
  const totalComp = markets.reduce((a, m) => a + (Number.isFinite(m.competingCapitalUsd) ? m.competingCapitalUsd : 0), 0);
  return {
    markets,
    captures: Number(capRows[0]?.n ?? 0),
    impliedYield: totalComp > 0 ? totalPool / totalComp : NaN,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const REGIMES: Regime[] = ['mid', 'cheap', 'rich'];

const meanArr = (xs: number[]): number => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN);

/** The adverse-selection signature: mean measured fill yield split by the real outcome. */
function adverseSignature(results: BucketInventoryResult[], regime: Regime): { onWinners: number; onLosers: number; nWin: number; nLose: number } {
  const rows = results.filter((r) => !r.skipped && r.regime === regime && Number.isFinite(r.fillYield));
  const win = rows.filter((r) => r.won).map((r) => r.fillYield);
  const lose = rows.filter((r) => !r.won).map((r) => r.fillYield);
  return { onWinners: meanArr(win), onLosers: meanArr(lose), nWin: win.length, nLose: lose.length };
}

/** Bucket-level robustness stats (large-n, not clustered): flatten bound + fraction net-negative. */
function regimeExtra(results: BucketInventoryResult[], regime: Regime): { meanFlatten: number; fracNeg: number; n: number } {
  const rows = results.filter((r) => !r.skipped && r.regime === regime && Number.isFinite(r.fillYield));
  return {
    meanFlatten: meanArr(rows.map((r) => r.fillYieldFlatten).filter((v) => Number.isFinite(v))),
    fracNeg: rows.length ? rows.filter((r) => r.fillYield < 0).length / rows.length : NaN,
    n: rows.length,
  };
}

export function buildReport(
  results: BucketInventoryResult[],
  universe: { markets: FundedMarket[]; captures: number; impliedYield: number },
  params: InventoryParams,
  from: string,
  to: string,
): { lines: string[]; json: unknown } {
  const lines: string[] = [];
  const P = (s = ''): void => {
    lines.push(s);
  };
  const capital = params.sizeShares;

  const study1 = runInventoryStudy(results, universe.markets, { kappa: 1, capitalPerMarketUsd: capital });

  P('');
  P('=== REC-10 reward-inventory backtest — MEASURED two-sided maker fill cost on weather ===');
  P(`generated ${new Date().toISOString()}`);
  P(
    `COST data: ${results.length} resolved weather buckets (${study1.nModelled} modelled, ${study1.nSkipped} skipped: <${params.minEpochs} usable epochs) with real book series, target_date ${from}..${to}`,
  );
  P(`INCOME data: ${universe.markets.length} live funded markets (market_rewards, avg over ${universe.captures} capture(s))`);
  P(`quote: rest ${capital} shares/side ($${capital} capital) ${params.restOffsetCents}c inside mid, max_spread ${params.maxSpreadCents}c, inv cap ${params.invCapMult}× size, weather_fees rebate ${params.rebateRate}`);
  P('');

  P('LIVE REWARD INCOME (capital-share model, realistic κ=1):');
  P(`  observed implied gross yield (Σpool / Σ in-band capital) = ${pct(universe.impliedYield)}/day  ← the "too good to be standing" headline`);
  for (const r of REGIMES) {
    const rw = study1.reward[r];
    P(
      `  ${r.padEnd(6)} ${rw.nMarkets} mkts · pool ${usd(rw.totalPoolUsd)}/d · in-band cap ${usd(rw.totalCompetingUsd)} · reward yield ${pct(rw.meanRewardYield)}/day on $${capital}`,
    );
  }
  P('');

  P('MEASURED FILL+INVENTORY COST (real resolved buckets, two-sided quote over the real book):');
  P('  PRIMARY = residual inventory marked to the REAL win/lose resolution (passive farmer, never flattens).');
  P('  FLATTEN = residual marked to the last observed mid (farmer who closes out at end-of-day) — the gentler bound.');
  P('  regime  nBkt  nDays   meanFillYield(resolution) [95% cluster-t CI]   median   flatten-bound   %neg   bid/ask fills');
  for (const r of REGIMES) {
    const c = study1.cost[r];
    const x = regimeExtra(results, r);
    P(
      `  ${r.padEnd(6)} ${String(c.nBuckets).padStart(4)}  ${String(c.nDays).padStart(4)}   ` +
        `${pct(c.meanFillYield).padStart(9)} [${pct(c.ciLo)}, ${pct(c.ciHi)}]   ${pct(c.medianFillYield).padStart(7)}   ` +
        `${pct(x.meanFlatten).padStart(8)}   ${pct(x.fracNeg, 0).padStart(5)}   ${c.bidFillsPerBucket.toFixed(1)}/${c.askFillsPerBucket.toFixed(1)}`,
    );
  }
  const asMid = adverseSignature(results, 'mid');
  P(`  adverse-selection signature (mid): fill yield on WINNERS ${pct(asMid.onWinners)} (n${asMid.nWin}) vs LOSERS ${pct(asMid.onLosers)} (n${asMid.nLose}) — fills land adversely on both`);
  P('');

  P('NET = reward income + MEASURED fill cost (κ=1, per ~1-day market):');
  P('  regime  reward%/day   fill%/day [CI]              net%/day [CI]');
  for (const r of REGIMES) {
    const n = study1.net[r];
    P(
      `  ${r.padEnd(6)} ${pct(n.rewardYield).padStart(9)}   ${pct(n.fillYield).padStart(9)} [${pct(n.fillCi.lo)}, ${pct(n.fillCi.hi)}]   ` +
        `${pct(n.netYield).padStart(9)} [${pct(n.netLo)}, ${pct(n.netHi)}]`,
    );
  }
  P('');

  P('κ SWEEP — MID-RANGE net (κ=1 realistic full-book competition … →0 alone-in-market ceiling):');
  const sweep: { kappa: number; net: number; lo: number; hi: number; reward: number }[] = [];
  for (const kappa of [1, 0.5, 0.2, 0.05]) {
    const s = runInventoryStudy(results, universe.markets, { kappa, capitalPerMarketUsd: capital });
    const n = s.net.mid;
    sweep.push({ kappa, net: n.netYield, lo: n.netLo, hi: n.netHi, reward: n.rewardYield });
    P(`  κ=${String(kappa).padEnd(4)} reward ${pct(n.rewardYield).padStart(8)}/day  net ${pct(n.netYield).padStart(8)}/day [${pct(n.netLo)}, ${pct(n.netHi)}]`);
  }
  P('');

  // robustness: even at the alone-in-market income ceiling (κ→0), is mid net still negative?
  const ceil = sweep[sweep.length - 1]!;
  const midFlatten = regimeExtra(results, 'mid').meanFlatten;
  P('ROBUSTNESS:');
  P(`  • income ceiling (κ=0.05, ${pct(ceil.reward)}/day reward) → mid net STILL ${pct(ceil.net)}/day ${ceil.net < 0 ? '(negative)' : '(positive)'}`);
  P(`  • gentler flatten-bound mid fill cost ${pct(midFlatten)}/day vs κ=1 reward ${pct(study1.net.mid.rewardYield)}/day → net ${pct(study1.net.mid.rewardYield + midFlatten)}/day`);
  P(`  • data limit: ${study1.verdict.dataLimited ? `binding regime spans only ${study1.net.mid.nDays} independent weather-day(s) — the cluster CI is uninformative; the verdict is DIRECTIONAL` : 'sufficient weather-days for a certified CI'}`);
  P('');
  P(`VERDICT (frozen REC-10 criterion, binding = MID-RANGE, realistic κ=1):  ${study1.verdict.label}`);
  P(`  ${study1.verdict.reason}`);

  return {
    lines,
    json: {
      generatedAt: new Date().toISOString(),
      window: { from, to },
      params,
      coverage: { nBuckets: results.length, nModelled: study1.nModelled, nSkipped: study1.nSkipped, fundedMarkets: universe.markets.length, captures: universe.captures },
      impliedGrossYield: universe.impliedYield,
      kappa1: study1,
      kappaSweepMid: sweep,
      verdict: study1.verdict,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// main
// ──────────────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      capital: { type: 'string' },
      offset: { type: 'string' },
      'inv-cap': { type: 'string' },
      'min-epochs': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  const from = values.from ?? '2026-05-01';
  const to = values.to ?? '2026-07-01';
  const params: InventoryParams = {
    ...DEFAULT_INVENTORY_PARAMS,
    sizeShares: num(values.capital, DEFAULT_INVENTORY_PARAMS.sizeShares),
    restOffsetCents: num(values.offset, DEFAULT_INVENTORY_PARAMS.restOffsetCents),
    invCapMult: num(values['inv-cap'], DEFAULT_INVENTORY_PARAMS.invCapMult),
    minEpochs: num(values['min-epochs'], DEFAULT_INVENTORY_PARAMS.minEpochs),
  };

  const db = makeScriptDb();
  try {
    process.stderr.write(`loading resolved weather buckets (${from}..${to})…\n`);
    const buckets = await loadResolvedBuckets(db, from, to);
    process.stderr.write(`  ${buckets.length} resolved buckets with a real book series\n`);
    process.stderr.write('loading live funded universe (market_rewards)…\n');
    const universe = await loadFundedUniverse(db);
    process.stderr.write(`  ${universe.markets.length} funded markets over ${universe.captures} capture(s)\n`);

    const results = buckets.map((b) => simulateBucketInventory(b, params));
    const { lines, json } = buildReport(results, universe, params, from, to);
    console.log(lines.join('\n'));

    const outPath = values.out ?? 'scripts/research/out/reward-inventory-backtest.json';
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(json, null, 2));
    writeFileSync(outPath.replace(/\.json$/, '.md'), lines.join('\n'));
    if (values.json) console.log('\nJSON ' + JSON.stringify(json));
    process.stderr.write(`\nwrote ${outPath} (+ .md)\n`);
  } finally {
    await db.end();
  }
}
