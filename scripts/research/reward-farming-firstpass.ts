/**
 * scripts/research/reward-farming-firstpass — REC-8 Phase B+C FIRST-PASS on LIVE data
 * (REWARD-FARMING-HANDOFF.md). Answers the operator's question — "is forecast-free liquidity-reward
 * farming on weather net-positive?" — with a fast, defensible read on a live snapshot, BEFORE building
 * the multi-day data-capture pipeline or any bot.
 *
 * What it does (all read-only, public, keyless):
 *   1. Paginate the CLOB `/sampling-markets` funded-reward pool (reuse `fetchSamplingMarkets`), keep the
 *      funded weather/temperature markets with a real pool (≥ --min-pool USD/day; drops the $0.001 dust).
 *   2. Batch-fetch the live `/books` (POST, ≤50 token_ids/request) for each market's YES token — this is
 *      the MEASURED competition denominator (the §0.2 dominant unknown), not an assumption.
 *   3. Run `estimateMarketEconomics` across the universe at the REALISTIC corner + a κ×φ×τ sweep, and
 *      adjudicate the realistic corner against the FROZEN REC-8 first-pass kill-criterion.
 *
 * The model + the frozen verdict live in `packages/core/src/sim/reward-farming.ts` (pure, tested). This
 * script is only the live I/O + the report. NOTHING ships; `packages/trading` is never imported; the
 * live rail stays DORMANT (a PASS only justifies *designing* the full study, never resting real orders).
 *
 * Run: pnpm tsx scripts/research/reward-farming-firstpass.ts [--min-pool 1] [--capital 100] [--phi 0.5]
 *      [--tax 0.05] [--kappa 1] [--max-pages 50] [--limit N] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  type MarketRewardInputs,
  type RewardFarmingParams,
  type BookOrder,
  DEFAULT_PARAMS,
  estimateMarketEconomics,
  rewardFarmingVerdict,
  summarizeUniverse,
} from '../../packages/core/src/sim/reward-farming.ts';
import { isFunded, isWeatherMarket, type RawSamplingMarket } from '../../packages/core/src/polymarket/rewards.ts';
import { fetchSamplingMarkets } from '../reward-monitor.ts';
import { fetchJson } from '../../packages/io/src/http.ts';

const CLOB_BASE = 'https://clob.polymarket.com';

/** Runtime-richer view of a sampling market (the type omits these; the live payload carries them). */
interface SamplingMarketFull extends RawSamplingMarket {
  tokens?: { token_id?: string; outcome?: string; price?: number }[];
  end_date_iso?: string;
}

interface RawBook {
  asset_id?: string;
  bids?: { price?: string | number; size?: string | number }[];
  asks?: { price?: string | number; size?: string | number }[];
}

const dailyPool = (m: RawSamplingMarket): number =>
  (m.rewards?.rates ?? []).reduce((a, r) => a + (Number.isFinite(r?.rewards_daily_rate) ? r!.rewards_daily_rate! : 0), 0);

const yesTokenId = (m: SamplingMarketFull): string | null => {
  const toks = Array.isArray(m.tokens) ? m.tokens : [];
  const yes = toks.find((t) => /yes/i.test(t?.outcome ?? '')) ?? toks[0];
  return typeof yes?.token_id === 'string' && yes.token_id.length > 0 ? yes.token_id : null;
};

const toOrders = (raw: { price?: string | number; size?: string | number }[] | undefined): BookOrder[] =>
  (Array.isArray(raw) ? raw : [])
    .map((o) => ({ price: Number(o?.price), size: Number(o?.size) }))
    .filter((o) => o.price > 0 && o.price < 1 && o.size > 0);

/** POST /books in chunks of ≤50 token_ids (the batch endpoint; well inside the 50/10s budget). */
async function fetchBooks(tokenIds: string[], log: (m: string) => void): Promise<Map<string, RawBook>> {
  const out = new Map<string, RawBook>();
  const CHUNK = 50;
  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    const chunk = tokenIds.slice(i, i + CHUNK);
    try {
      const res = (await fetchJson(
        `${CLOB_BASE}/books`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(chunk.map((token_id) => ({ token_id }))),
        },
        { timeoutMs: 25_000 },
      )) as RawBook[];
      for (const b of Array.isArray(res) ? res : []) {
        if (typeof b?.asset_id === 'string') out.set(b.asset_id, b);
      }
    } catch (e) {
      log(`  books chunk ${i / CHUNK + 1} failed (${(e as Error)?.message ?? e}) — skipping ${chunk.length} markets`);
    }
  }
  return out;
}

const bestBid = (orders: BookOrder[]): number | null =>
  orders.length ? orders.reduce((m, o) => (o.price > m ? o.price : m), 0) : null;
const bestAsk = (orders: BookOrder[]): number | null =>
  orders.length ? orders.reduce((m, o) => (o.price < m ? o.price : m), 1) : null;

const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number, d = 2): string => (Number.isFinite(v) ? `$${v.toFixed(d)}` : '—');

/** Build the live universe of MarketRewardInputs (funded weather, real pool, with a book). */
export async function buildUniverse(
  opts: { maxPages: number; minPool: number; limit: number },
  log: (m: string) => void,
): Promise<MarketRewardInputs[]> {
  const { markets, pages, complete } = await fetchSamplingMarkets(opts.maxPages, log);
  const funded = (markets as SamplingMarketFull[]).filter(
    (m) => isWeatherMarket(m) && isFunded(m) && dailyPool(m) >= opts.minPool,
  );
  log(`scanned ${markets.length} sampling markets across ${pages} page(s)${complete ? '' : ' (INCOMPLETE)'} → ${funded.length} funded weather markets with pool ≥ ${usd(opts.minPool)}`);

  const limited = opts.limit > 0 ? funded.slice(0, opts.limit) : funded;
  const withTok = limited
    .map((m) => ({ m, tid: yesTokenId(m) }))
    .filter((x): x is { m: SamplingMarketFull; tid: string } => x.tid != null);
  const books = await fetchBooks(withTok.map((x) => x.tid), log);

  const inputs: MarketRewardInputs[] = [];
  for (const { m, tid } of withTok) {
    const book = books.get(tid);
    if (!book) continue;
    const bids = toOrders(book.bids);
    const asks = toOrders(book.asks);
    inputs.push({
      conditionId: typeof m.condition_id === 'string' ? m.condition_id : tid,
      slug: typeof m.market_slug === 'string' ? m.market_slug : (m.question ?? tid),
      dailyPoolUsd: dailyPool(m),
      maxSpreadCents: Number.isFinite(m.rewards?.max_spread) ? m.rewards!.max_spread! : 4.5,
      minSize: Number.isFinite(m.rewards?.min_size) ? m.rewards!.min_size! : 50,
      bestBid: bestBid(bids),
      bestAsk: bestAsk(asks),
      bids,
      asks,
      endDateIso: typeof m.end_date_iso === 'string' ? m.end_date_iso : null,
    });
  }
  log(`fetched ${books.size} live order books → ${inputs.length} modellable markets`);
  return inputs;
}

function reportCorner(label: string, inputs: MarketRewardInputs[], params: RewardFarmingParams, log: (m: string) => void): void {
  const rows = inputs.map((m) => estimateMarketEconomics(m, params));
  const s = summarizeUniverse(rows);
  log(
    `  ${label.padEnd(34)} net/mkt mean ${usd(s.meanNetUsd.mean, 3)} [${usd(s.meanNetUsd.lo, 3)}, ${usd(
      s.meanNetUsd.hi, 3,
    )}] · median ${usd(s.medianNetUsd, 3)} · ${pct(s.fracNetPositive, 0)} positive · portfolio ${usd(
      s.totalNetUsd, 0,
    )}/d on ${usd(s.totalCapitalUsd, 0)} = ${pct(s.portfolioDailyYield)}/day`,
  );
}

export function reportAll(inputs: MarketRewardInputs[], central: RewardFarmingParams, log: (m: string) => void): void {
  log('');
  log('=== REC-8 reward-farming FIRST-PASS — forecast-free liquidity-reward economics on weather ===');
  log(`universe: ${inputs.length} funded weather markets (live pools + live books, ${new Date().toISOString().slice(0, 10)})`);
  const totalPool = inputs.reduce((a, m) => a + m.dailyPoolUsd, 0);
  log(`total daily reward pool across the universe: ${usd(totalPool, 0)}/day`);

  // ── decisive diagnostic: how much maker capital is ALREADY resting in-band? ───────────────────────
  // If competing in-band notional is small relative to the pool, nobody is seriously farming yet
  // (real-but-ephemeral: rewards just launched). If large, the instantaneous-book share is an artifact.
  const inBandNotional = (m: MarketRewardInputs): number => {
    const mid = m.bestBid != null && m.bestAsk != null ? (m.bestBid + m.bestAsk) / 2 : null;
    if (mid == null) return 0;
    const band = m.maxSpreadCents / 100;
    const bidCap = m.bids.filter((o) => mid - o.price <= band + 1e-9).reduce((a, o) => a + o.size * o.price, 0);
    const askCap = m.asks.filter((o) => o.price - mid <= band + 1e-9).reduce((a, o) => a + o.size * (1 - o.price), 0);
    return bidCap + askCap;
  };
  const competingCapital = inputs.reduce((a, m) => a + inBandNotional(m), 0);
  log(`competing maker capital ALREADY resting in-band (live): ${usd(competingCapital, 0)} across the universe`);
  log(`  → if that capital alone split the pool, universe gross yield ≈ ${pct(competingCapital > 0 ? totalPool / competingCapital : NaN)}/day (the thin-book paradox check)`);
  log('');

  // ── the REALISTIC corner (the headline the verdict adjudicates) ──────────────────────────────────
  const rows = inputs.map((m) => estimateMarketEconomics(m, central));
  const summary = summarizeUniverse(rows);
  const grossYield = summary.totalCapitalUsd > 0 ? summary.totalGrossUsd / summary.totalCapitalUsd : NaN;
  log('REALISTIC corner (κ=1 full-aggregate-book competition; central fill+tax):');
  log(`  capital/market ${usd(central.capitalPerMarketUsd, 0)} · restOffset ${central.restOffsetCents}c · φ(fill) ${central.fillFraction} · τ(adverse) ${central.adverseTaxPerDollar} · rebate ${central.rebateRate}`);
  log(`  gross reward income ${usd(summary.totalGrossUsd, 0)}/day  (gross yield ${pct(grossYield)}/day on ${usd(summary.totalCapitalUsd, 0)} capital)`);
  log(`  − adverse-selection fill cost ${usd(summary.totalFillCostUsd, 0)}/day`);
  log(`  = NET ${usd(summary.totalNetUsd, 0)}/day  → portfolio net yield ${pct(summary.portfolioDailyYield)}/day`);
  log(`  per-market net: mean ${usd(summary.meanNetUsd.mean, 4)} [${usd(summary.meanNetUsd.lo, 4)}, ${usd(summary.meanNetUsd.hi, 4)}] · median ${usd(summary.medianNetUsd, 4)} · ${pct(summary.fracNetPositive, 0)} of markets net-positive`);
  log('');

  // ── sensitivity sweep (competition κ, fill φ, adverse tax τ) ──────────────────────────────────────
  log('SWEEP — competition κ (1=realistic aggregate book … →0 = alone-in-market ceiling):');
  for (const kappa of [1, 0.5, 0.2, 0.05]) reportCorner(`κ=${kappa}`, inputs, { ...central, kappa }, log);
  log('SWEEP — fill fraction φ (share of resting notional that fills):');
  for (const phi of [0.2, 0.5, 0.8, 1.0]) reportCorner(`φ=${phi}`, inputs, { ...central, fillFraction: phi }, log);
  log('SWEEP — adverse-selection tax τ ($/[$ filled]; §12 floor 0.017 … replica tail 0.328):');
  for (const tax of [0.0, 0.017, 0.05, 0.1, 0.328]) reportCorner(`τ=${tax}`, inputs, { ...central, adverseTaxPerDollar: tax }, log);
  log('SWEEP — capital/market (sizing):');
  for (const cap of [50, 100, 250, 500]) reportCorner(`$${cap}`, inputs, { ...central, capitalPerMarketUsd: cap }, log);
  log('');

  // ── the FROZEN verdict (realistic corner) ─────────────────────────────────────────────────────────
  const verdict = rewardFarmingVerdict(summary);
  log(`VERDICT (frozen REC-8 first-pass criterion): ${verdict.label}`);
  log(`  ${verdict.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      'max-pages': { type: 'string' },
      'min-pool': { type: 'string' },
      capital: { type: 'string' },
      phi: { type: 'string' },
      tax: { type: 'string' },
      kappa: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const num = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  const central: RewardFarmingParams = {
    ...DEFAULT_PARAMS,
    capitalPerMarketUsd: num(values.capital, DEFAULT_PARAMS.capitalPerMarketUsd),
    fillFraction: num(values.phi, DEFAULT_PARAMS.fillFraction),
    adverseTaxPerDollar: num(values.tax, DEFAULT_PARAMS.adverseTaxPerDollar),
    kappa: num(values.kappa, DEFAULT_PARAMS.kappa),
  };
  const inputs = await buildUniverse(
    { maxPages: num(values['max-pages'], 50), minPool: num(values['min-pool'], 1), limit: num(values.limit, 0) },
    console.log,
  );
  reportAll(inputs, central, console.log);
  if (values.json) {
    const rows = inputs.map((m) => estimateMarketEconomics(m, central));
    console.log('\nJSON ' + JSON.stringify({ summary: summarizeUniverse(rows), n: inputs.length }));
  }
}
