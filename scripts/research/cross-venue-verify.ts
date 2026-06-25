/**
 * scripts/research/cross-venue-verify — ONE-SHOT live diagnostic for the cross-venue (Kalshi ↔
 * Polymarket) 10th-signal panel (CROSS-VENUE-SPIKE.md, migration 0062). Read-only, KEYLESS (Gamma tag
 * 104596 + Kalshi public market-data + Polymarket CLOB /book), places NOTHING; never imports
 * packages/trading.
 *
 * WHY IT EXISTS. The day-1 forward panel showed several net-positive city-days (NYC +0.26, Miami +0.23)
 * that the recorded narrative ("all 6 cities agree <1°F, KILL intact") did NOT predict — trending the
 * FROZEN gate toward a possibly-FALSE PASS. The stored capture row cannot separate the three things that
 * decide whether that PASS would be real, so this script does, against live books on BOTH venues:
 *
 *   1. SAME-DAY vs NEXT-DAY. A days_ahead=0 row is captured mid-afternoon, when Polymarket (Wunderground
 *      running-max) has already seen most of today's high while Kalshi's CLI book still prices the
 *      forecast — the WO-5 running-max LATENCY, already-falsified-as-untradable, NOT the cross-venue
 *      forecast thesis. Each row is tagged with days_ahead so latency rows can be isolated.
 *   2. QUOTED edge vs EXECUTABLE edge. The capture's `has_real_depth` is a 24h-volume / open-interest
 *      PROXY. This walks the TRUE order book on BOTH venues at the touch legs of each net-positive
 *      position — Kalshi via parseKalshiOrderbook, Polymarket via the CLOB /book + normalizeBook — and
 *      reports the BINDING executable size = min over every leg that must fill to be hedged. A thin
 *      binding leg ⇒ the edge is a top-of-book mirage, not capturable money. Sampled over `--rounds`
 *      snapshots (default 3, ~4s apart) for a within-session capacity distribution (min/median/max).
 *   3. The OFFSET-INTEGER risk. The edge decomposes as cashflow + expPayoff, where −expPayoff ≈ the
 *      consensus P(high = the offset integer) the position is short. Both are printed.
 *
 * NOTE (live-verified premise correction): Kalshi's bin parity is CITY-DEPENDENT, not universally odd as
 * CROSS-VENUE-SPIKE.md / kalshi/markets.ts state — NYC is odd-start (a real 1°F offset), but Miami/LA/
 * Denver are EVEN-start = the SAME grid as Polymarket, so those venues SHARE thresholds (expPayoff=0).
 *
 *   pnpm tsx scripts/research/cross-venue-verify.ts [--rounds 3]
 */
import { parseArgs } from 'node:util';
import {
  parseGammaEvent,
  normalizeBook,
  type RawClobBook,
  type ParsedEvent,
  type ParsedBucket,
  type RawGammaEvent,
} from '../../packages/core/src/index.ts';
import {
  NEUTRAL_BASIS,
  crossVenueDivergence,
  crossVenueEdge,
  impliedLadder,
  type VenueBucket,
  type VenueLadder,
} from '../../packages/core/src/sim/cross-venue-arb.ts';
import {
  KALSHI_HIGH_SERIES,
  parseKalshiLadder,
  parseKalshiOrderbook,
  type KalshiBin,
} from '../../packages/core/src/kalshi/markets.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596;
const HEADERS: Record<string, string> = {
  'User-Agent': 'weather-edge/0.1 (cross-venue-verify)',
  Accept: 'application/json',
};
const MAX_LEAD_DAYS = 2;

const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—');
const f3 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `$${v >= 0 ? '+' : ''}${v.toFixed(3)}` : '—');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/** Days until a target date (YYYY-MM-DD) from now (negative = past). */
function leadDays(targetDate: string, now: Date): number {
  return (new Date(`${targetDate}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000;
}

/** Polymarket ParsedEvent → engine VenueLadder (top-of-book, 24h vol as the depth proxy). */
function polyLadder(ev: ParsedEvent): VenueLadder {
  return {
    venue: 'polymarket',
    buckets: ev.buckets.map(
      (b): VenueBucket => ({
        loF: b.def.low,
        hiF: b.def.high,
        yesAsk: b.bestAsk,
        yesBid: b.bestBid,
        topAskSize: b.volume24h ?? 0,
        topBidSize: b.volume24h ?? 0,
      }),
    ),
  };
}

/** Page every open temperature event from Gamma, parsed (parse failures skipped). */
async function fetchOpenEvents(): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await getJson(`${GAMMA}/events?tag_id=${TAG}&active=true&closed=false&limit=100&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page as RawGammaEvent[]) {
      try {
        out.push(parseGammaEvent(raw));
      } catch {
        /* skip unparseable */
      }
    }
    if (page.length < 100) break;
  }
  return out;
}

/** TRUE Kalshi orderbook touch for one bin: best ask/bid resting size. */
async function kalshiTouch(ticker: string): Promise<{ askSize: number; bidSize: number }> {
  try {
    const { yesBids, yesAsks } = parseKalshiOrderbook(await getJson(`${KALSHI}/markets/${ticker}/orderbook`));
    return { askSize: yesAsks[0]?.size ?? 0, bidSize: yesBids[0]?.size ?? 0 };
  } catch {
    return { askSize: 0, bidSize: 0 };
  }
}

/** TRUE Polymarket CLOB touch for one YES token: best ask/bid resting size (shares). */
async function polyTouch(tokenYes: string): Promise<{ askSize: number; bidSize: number }> {
  try {
    const book = normalizeBook((await getJson(`${CLOB}/book?token_id=${tokenYes}`)) as RawClobBook);
    return { askSize: book.asks[0]?.size ?? 0, bidSize: book.bids[0]?.size ?? 0 };
  } catch {
    return { askSize: 0, bidSize: 0 };
  }
}

/** Largest clean lower-boundary ≤ k among a set of integer lows (the engine's kClean selection). */
const kClean = (lows: number[], k: number): number => Math.max(...lows.filter((x) => x <= k), -Infinity);

interface NetPos {
  city: string;
  targetDate: string;
  dAhead: number;
  edge: number;
  dir: 'buyKalshiSellPoly' | 'buyPolySellKalshi';
  atF: number;
  /** Kalshi legs (tickers) that must fill, with which side (ask=buy / bid=sell). */
  kLegs: { ticker: string; side: 'ask' | 'bid' }[];
  /** Poly legs (YES tokens) that must fill, with which side. */
  pLegs: { token: string; side: 'ask' | 'bid' }[];
}

/** Identify the Kalshi + Poly legs (and sides) of the best position, for the true-depth walk. */
function legsOf(np: { dir: NetPos['dir']; atF: number }, bins: KalshiBin[], buckets: ParsedBucket[]): Pick<NetPos, 'kLegs' | 'pLegs'> {
  const kLows = bins.map((b) => b.loF).filter((x): x is number => x != null);
  const pLows = buckets.map((b) => b.def.low).filter((x): x is number => x != null);
  if (np.dir === 'buyKalshiSellPoly') {
    // LONG Kalshi YES≥atF (buy=ask); SHORT Poly YES≥kClean_poly (sell=bid)
    const pk = kClean(pLows, np.atF);
    return {
      kLegs: bins.filter((b) => b.loF != null && b.loF >= np.atF).map((b) => ({ ticker: b.ticker, side: 'ask' })),
      pLegs: buckets.filter((b) => b.def.low != null && b.def.low >= pk).map((b) => ({ token: b.tokenYes, side: 'bid' })),
    };
  }
  // buyPolySellKalshi: LONG Poly YES≥atF (buy=ask); SHORT Kalshi YES≥kClean_kalshi (sell=bid)
  const kk = kClean(kLows, np.atF);
  return {
    kLegs: bins.filter((b) => b.loF != null && b.loF >= kk).map((b) => ({ ticker: b.ticker, side: 'bid' })),
    pLegs: buckets.filter((b) => b.def.low != null && b.def.low >= np.atF).map((b) => ({ token: b.tokenYes, side: 'ask' })),
  };
}

/** One depth sample: binding (min) executable size on each venue + overall (both must fill). */
async function sampleDepth(np: NetPos): Promise<{ kCap: number; pCap: number; exec: number }> {
  let kCap = Infinity;
  for (const l of np.kLegs) {
    const t = await kalshiTouch(l.ticker);
    kCap = Math.min(kCap, l.side === 'ask' ? t.askSize : t.bidSize);
  }
  let pCap = Infinity;
  for (const l of np.pLegs) {
    const t = await polyTouch(l.token);
    pCap = Math.min(pCap, l.side === 'ask' ? t.askSize : t.bidSize);
  }
  kCap = Number.isFinite(kCap) ? kCap : 0;
  pCap = Number.isFinite(pCap) ? pCap : 0;
  return { kCap, pCap, exec: Math.min(kCap, pCap) };
}

interface Matched {
  city: string;
  targetDate: string;
  ev: ParsedEvent;
  bins: KalshiBin[];
  ladderK: VenueLadder;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { rounds: { type: 'string' } } });
  const rounds = Math.max(1, Math.min(10, Number(values.rounds ?? 3) || 3));
  const now = new Date();
  process.stderr.write(`cross-venue-verify · ${now.toISOString()} · keyless BOTH-venue live snapshot · rounds=${rounds}\n`);

  // STEP 1 — Polymarket overlap events (the 6 Kalshi-listed cities, near-dated)
  const events = await fetchOpenEvents();
  const overlap = events.filter(
    (ev) =>
      ev.kind === 'highest' &&
      ev.unit === 'F' &&
      KALSHI_HIGH_SERIES[ev.citySlug] != null &&
      leadDays(ev.targetDate, now) >= -0.5 &&
      leadDays(ev.targetDate, now) <= MAX_LEAD_DAYS,
  );
  process.stderr.write(`  ${events.length} gamma events · ${overlap.length} overlap city-days\n`);

  // STEP 2 — Kalshi books for those cities (one series fetch each)
  const cities = [...new Set(overlap.map((ev) => ev.citySlug))];
  const kBy = new Map<string, unknown[]>();
  await Promise.all(
    cities.map(async (city) => {
      const res = (await getJson(`${KALSHI}/markets?series_ticker=${KALSHI_HIGH_SERIES[city]}&status=open&limit=200`).catch(
        () => ({}),
      )) as { markets?: unknown };
      kBy.set(city, Array.isArray(res?.markets) ? res.markets : []);
    }),
  );

  // STEP 3 — match, run the SAME engine, decompose
  const matched: Matched[] = [];
  for (const ev of overlap) {
    const mk = kBy.get(ev.citySlug);
    if (!mk || mk.length === 0) continue;
    const { ladder, bins } = parseKalshiLadder(mk, ev.citySlug, ev.targetDate);
    if (bins.length === 0) continue;
    matched.push({ city: ev.citySlug, targetDate: ev.targetDate, ev, bins, ladderK: ladder });
  }
  matched.sort((a, b) => a.city.localeCompare(b.city) || a.targetDate.localeCompare(b.targetDate));

  console.log('');
  console.log('=== Cross-venue LIVE verification — quoted edge + decomposition ===');
  console.log(`as of ${now.toISOString()}  ·  ${matched.length} matched city-days`);
  console.log('');
  console.log('  city          tgtDate     dAhead  polyμ  kalμ   diff   bestEdge   cashflow  expPay(−P[offset])  dir');

  const netPos: NetPos[] = [];
  for (const m of matched) {
    const pImpl = impliedLadder(polyLadder(m.ev));
    const kImpl = impliedLadder(m.ladderK);
    if (!pImpl.ok || !kImpl.ok) continue;
    const div = crossVenueDivergence(pImpl, kImpl);
    const edge = crossVenueEdge(pImpl, kImpl, NEUTRAL_BASIS);
    const dAhead = Math.round(leadDays(m.targetDate, now));
    console.log(
      `  ${m.city.padEnd(13).slice(0, 13)} ${m.targetDate}  ${String(dAhead).padStart(5)}  ` +
        `${f2(pImpl.meanF).padStart(5)}  ${f2(kImpl.meanF).padStart(5)}  ${f2(div.meanDiffF).padStart(5)}  ` +
        `${usd(edge.bestNetEdge).padStart(9)}  ${usd(edge.cashflow).padStart(9)}  ${usd(edge.expPayoff).padStart(9)}` +
        `         ${edge.bestNetEdge > 0 ? edge.direction : '·'}`,
    );
    if (edge.ok && edge.bestNetEdge > 0 && edge.direction !== 'none') {
      const { kLegs, pLegs } = legsOf({ dir: edge.direction, atF: edge.atF }, m.bins, m.ev.buckets);
      netPos.push({ city: m.city, targetDate: m.targetDate, dAhead, edge: edge.bestNetEdge, dir: edge.direction, atF: edge.atF, kLegs, pLegs });
    }
  }

  // STEP 4 — TRUE both-venue executable capacity, sampled over `rounds`
  console.log('');
  console.log(`=== TRUE both-venue executable capacity (binding leg = min over all legs that must fill) ===`);
  console.log(`  Kalshi size = resting contracts (fp); Poly size = resting shares. Sampled ${rounds}× (~4s apart).`);
  console.log('');
  console.log('  city          tgtDate     dAhead  edge      kalshiCap(legs)   polyCap(legs)   EXECUTABLE  min/med/max');
  const summary: Array<{ np: NetPos; samples: { kCap: number; pCap: number; exec: number }[] }> = netPos.map((np) => ({ np, samples: [] }));
  for (let r = 0; r < rounds; r++) {
    for (const s of summary) s.samples.push(await sampleDepth(s.np));
    if (r < rounds - 1) await sleep(4000);
  }
  for (const { np, samples } of summary) {
    const execs = samples.map((s) => s.exec);
    const last = samples[samples.length - 1]!;
    console.log(
      `  ${np.city.padEnd(13).slice(0, 13)} ${np.targetDate}  ${String(np.dAhead).padStart(5)}  ${usd(np.edge).padStart(7)}  ` +
        `${f2(last.kCap).padStart(8)}(${np.kLegs.length})   ${f2(last.pCap).padStart(8)}(${np.pLegs.length})   ` +
        `${f2(last.exec).padStart(9)}  ${f2(Math.min(...execs))}/${f2(median(execs))}/${f2(Math.max(...execs))}`,
    );
  }

  // Aggregate read
  const dA1 = summary.filter((s) => s.np.dAhead >= 1);
  const execMeds = dA1.map((s) => median(s.samples.map((x) => x.exec)));
  console.log('');
  console.log('=== READ ===');
  console.log(`  net-positive city-days: ${netPos.length}  (${netPos.filter((n) => n.dAhead === 0).length} same-day/latency, ${dA1.length} next-day/forecast)`);
  if (execMeds.length) {
    console.log(
      `  next-day executable capacity (median exec, contracts/shares): ` +
        `min ${f2(Math.min(...execMeds))} · median ${f2(median(execMeds))} · max ${f2(Math.max(...execMeds))}`,
    );
  }
  console.log('  → if every net-positive day is single/double-digit capacity, the quoted edge is NOT scalable: KILL on a capacity wall.');
}

main().catch((e) => {
  process.stderr.write(`FATAL ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
