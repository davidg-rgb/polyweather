/**
 * scripts/research/opening-convergence-probe — ONE-SHOT live diagnostic for the OPENING-CONVERGENCE
 * thesis (operator idea 2026-06-27): a freshly-listed daily-weather market opens FLAT (all buckets
 * ~10-12%) and converges to a peaked distribution (mode ~30-40%) over its life. Can you buy the
 * eventual-mode bucket cheap at open and sell it back after convergence — even without hitting the
 * right temperature? Read-only, KEYLESS, places NOTHING; never imports packages/trading.
 *
 * It tests the three walls that decide whether the quoted opening edge is real money:
 *
 *   WALL 1 — CAPACITY (decisive). The flat open exists BECAUSE the book is near-empty. Walk the TRUE
 *     CLOB /book on every bucket of currently-open near-dated markets and report real buyable size
 *     ($ at the touch + cumulative within +10%) AND sell-back size at the bid. Quoted ≠ fillable.
 *   WALL 2/3 — UPDATING-vs-MISPRICING + SURVIVORSHIP. For recently-RESOLVED near-dated markets, pull
 *     each bucket's intraday mark series (CLOB /prices-history), reconstruct the OPENING distribution
 *     and the eventual winner, and measure: did the winner start cheap and rise (a real sell-back
 *     gain), or is 12%->38% just correct convergence on the survivor?
 *   DATA ACCURACY (operator's explicit concern). Verify /prices-history returns a REAL declining
 *     series for LOSER buckets — not 0-throughout (the front-end artifact he flagged) — and that
 *     Gamma bestBid/bestAsk is consistent with the live CLOB book.
 *
 *   pnpm tsx scripts/research/opening-convergence-probe.ts [--live N] [--hist N]
 */
import { parseArgs } from 'node:util';
import {
  parseGammaEvent,
  normalizeBook,
  parsePricesHistory,
  type RawClobBook,
  type ParsedEvent,
  type ParsedBucket,
  type RawGammaEvent,
} from '../../packages/core/src/index.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596;
const HEADERS: Record<string, string> = { 'User-Agent': 'weather-edge/0.1 (opening-convergence-probe)', Accept: 'application/json' };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const pct = (v: number | null): string => (v == null || !Number.isFinite(v) ? '  —  ' : `${(v * 100).toFixed(0)}%`.padStart(5));
const usd = (v: number): string => (Number.isFinite(v) ? `$${v.toFixed(1)}` : '—');

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

/** Days until a target date (YYYY-MM-DD local-midnight-UTC proxy) from now (negative = past). */
function leadDays(targetDate: string, now: Date): number {
  return (new Date(`${targetDate}T23:59:59Z`).getTime() - now.getTime()) / 86_400_000;
}

/** Page weather temp events (one query), parsed (parse failures skipped). */
async function fetchEvents(query: string): Promise<ParsedEvent[]> {
  const out: ParsedEvent[] = [];
  for (let offset = 0; offset < 600; offset += 100) {
    const page = await getJson(`${GAMMA}/events?tag_id=${TAG}&${query}&limit=100&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page as RawGammaEvent[]) {
      try {
        out.push(parseGammaEvent(raw));
      } catch {
        /* skip unparseable (zombies, yearless slugs) */
      }
    }
    if (page.length < 100) break;
  }
  return out;
}

/** mid of a bucket (the implied prob proxy) — null if no two-sided quote. */
function mid(b: ParsedBucket): number | null {
  if (b.bestBid == null || b.bestAsk == null) return null;
  if (b.bestBid === 0 && b.bestAsk === 1) return null; // degenerate
  return (b.bestBid + b.bestAsk) / 2;
}

/** Peak implied prob across buckets — low peak = flat/open-like. */
function peakMid(ev: ParsedEvent): number {
  return Math.max(0, ...ev.buckets.map((b) => mid(b) ?? 0));
}

interface BookDepth {
  bestAsk: number;
  askSize: number; // shares at the touch ask
  buyTouchUsd: number; // $ to take the touch ask
  buyBandUsd: number; // cumulative $ buyable within +10% of best ask
  bestBid: number;
  bidSize: number; // shares at the touch bid (sell-back)
  sellTouchUsd: number; // $ recovered selling into the touch bid
}

/** Walk the TRUE CLOB book for one YES token: touch + cumulative-within-band buyable/sellable $. */
async function bookDepth(token: string): Promise<BookDepth | null> {
  try {
    const book = normalizeBook((await getJson(`${CLOB}/book?token_id=${token}`)) as RawClobBook);
    const a0 = book.asks[0];
    const b0 = book.bids[0];
    const bestAsk = a0?.price ?? NaN;
    const bestBid = b0?.price ?? NaN;
    // cumulative buyable $ within +10% of best ask
    const band = Number.isFinite(bestAsk) ? bestAsk * 1.1 : Infinity;
    const buyBandUsd = book.asks.filter((l) => l.price <= band).reduce((s, l) => s + l.price * l.size, 0);
    return {
      bestAsk,
      askSize: a0?.size ?? 0,
      buyTouchUsd: Number.isFinite(bestAsk) ? bestAsk * (a0?.size ?? 0) : 0,
      buyBandUsd,
      bestBid,
      bidSize: b0?.size ?? 0,
      sellTouchUsd: Number.isFinite(bestBid) ? bestBid * (b0?.size ?? 0) : 0,
    };
  } catch {
    return null;
  }
}

async function pricesHistory(token: string): Promise<{ t: number; p: number }[] | null> {
  try {
    return parsePricesHistory(await getJson(`${CLOB}/prices-history?market=${token}&interval=max&fidelity=60`));
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({ options: { live: { type: 'string' }, hist: { type: 'string' } } });
  const nLive = Math.max(1, Math.min(12, Number(values.live ?? 4) || 4));
  const nHist = Math.max(1, Math.min(12, Number(values.hist ?? 5) || 5));
  const now = new Date();
  process.stderr.write(`opening-convergence-probe · ${now.toISOString()} · keyless live CLOB walk\n`);

  // ===== PART A — LIVE DEPTH on currently-open near-dated FLAT markets (WALL 1) =====
  const open = await fetchEvents('active=true&closed=false');
  const nearOpen = open
    .filter((ev) => ev.kind === 'highest' && ev.acceptingOrders)
    .map((ev) => ({ ev, lead: leadDays(ev.targetDate, now), peak: peakMid(ev) }))
    .filter((x) => x.lead >= -0.2 && x.lead <= 2.5 && x.peak > 0) // has a real two-sided quote somewhere
    .sort((a, b) => a.peak - b.peak || a.lead - b.lead); // flattest (most open-like) first
  process.stderr.write(`  ${open.length} open events · ${nearOpen.length} near-dated two-sided · sampling ${Math.min(nLive, nearOpen.length)} flattest\n`);

  console.log('\n=== PART A · LIVE BOOK DEPTH — flattest near-dated open markets (WALL 1: is the flat open fillable?) ===');
  console.log(`as of ${now.toISOString()}\n`);
  for (const { ev, lead, peak } of nearOpen.slice(0, nLive)) {
    console.log(`▸ ${ev.citySlug} ${ev.targetDate}  (lead ${lead.toFixed(1)}d · peak ${pct(peak).trim()} · ${ev.buckets.length} buckets · evVol24h ${ev.eventVolume24h ?? '—'})`);
    console.log('   bucket            mid   bestAsk  BUYABLE: touch / +10%band      bestBid  SELLBACK touch');
    // walk only the buckets that carry real implied mass (mid >= 5%) + their neighbors — the tradeable core
    const ranked = [...ev.buckets].map((b) => ({ b, m: mid(b) ?? 0 })).sort((x, y) => y.m - x.m);
    const core = ranked.slice(0, 6).filter((x) => x.m > 0);
    for (const { b, m } of core) {
      const d = await bookDepth(b.tokenYes);
      await sleep(250);
      if (!d) {
        console.log(`   ${b.label.padEnd(16).slice(0, 16)}  ${pct(m)}   (book fetch failed)`);
        continue;
      }
      console.log(
        `   ${b.label.padEnd(16).slice(0, 16)}  ${pct(m)}   ${pct(d.bestAsk)}   ${usd(d.buyTouchUsd).padStart(7)} / ${usd(d.buyBandUsd).padStart(7)}` +
          `          ${pct(d.bestBid)}   ${usd(d.sellTouchUsd).padStart(7)} (${d.bidSize.toFixed(0)} sh)`,
      );
    }
    console.log('');
  }

  // ===== PART B — RESOLVED-market convergence + DATA ACCURACY (WALLS 2/3 + operator concern) =====
  const closed = await fetchEvents('closed=true&order=endDate&ascending=false');
  const recentResolved = closed
    .map((ev) => ({ ev, lead: leadDays(ev.targetDate, now) }))
    .filter((x) => x.lead >= -6 && x.lead <= 0.5)
    .filter((x) => x.ev.kind === 'highest' && x.ev.buckets.some((b) => b.outcomePricesResolved?.[0] === 1))
    .sort((a, b) => b.lead - a.lead);
  process.stderr.write(`  ${closed.length} closed events · ${recentResolved.length} recently-resolved with a known winner · sampling ${Math.min(nHist, recentResolved.length)}\n`);

  console.log('=== PART B · CONVERGENCE + DATA ACCURACY — recently-resolved markets (WALLS 2/3 + "are losers 0?") ===\n');
  const arcs: { city: string; date: string; winnerOpen: number | null; winnerPeak: number | null; winnerSellbackGain: number | null }[] = [];
  for (const { ev, lead } of recentResolved.slice(0, nHist)) {
    const winner = ev.buckets.find((b) => b.outcomePricesResolved?.[0] === 1);
    const losers = ev.buckets.filter((b) => b.outcomePricesResolved?.[0] === 0);
    if (!winner) continue;
    console.log(`▸ ${ev.citySlug} ${ev.targetDate}  (resolved ${(-lead).toFixed(1)}d ago · winner=${winner.label} · ${ev.buckets.length} buckets)`);

    const wHist = await pricesHistory(winner.tokenYes);
    await sleep(250);
    // pick 2 losers near the winner (likely to have carried real mass) to check the "0 throughout" claim
    const wLo = winner.def.low ?? -Infinity;
    const neighbors = [...losers].sort((a, b) => Math.abs((a.def.low ?? 0) - (wLo as number)) - Math.abs((b.def.low ?? 0) - (wLo as number))).slice(0, 2);

    if (wHist && wHist.length) {
      const open0 = wHist[0]!.p;
      const peak = Math.max(...wHist.map((h) => h.p));
      const peakIdx = wHist.findIndex((h) => h.p === peak);
      // realistic sell-back: max price reached AFTER open, before the final resolution jump (drop last 10% of points)
      const preResolve = wHist.slice(0, Math.max(1, Math.floor(wHist.length * 0.9)));
      const sellMax = Math.max(...preResolve.map((h) => h.p));
      const sellbackGain = open0 > 0 ? sellMax - open0 : null;
      arcs.push({ city: ev.citySlug, date: ev.targetDate, winnerOpen: open0, winnerPeak: peak, winnerSellbackGain: sellbackGain });
      console.log(
        `   WINNER ${winner.label.padEnd(14).slice(0,14)} series n=${wHist.length}  open ${pct(open0)}  ->  peak ${pct(peak)} @${((peakIdx / Math.max(1, wHist.length - 1)) * 100).toFixed(0)}% of life  ` +
          `·  pre-resolution sell-max ${pct(sellMax)}  ·  buy-open→sell-back gain ${sellbackGain == null ? '—' : `${(sellbackGain * 100).toFixed(0)}pp`}`,
      );
    } else {
      console.log(`   WINNER ${winner.label}: NO history returned (data gap)`);
    }
    for (const lb of neighbors) {
      const lh = await pricesHistory(lb.tokenYes);
      await sleep(250);
      if (!lh || !lh.length) {
        console.log(`   loser  ${lb.label.padEnd(14).slice(0,14)} : NO history (── this is the "0 throughout" artifact if it repeats)`);
        continue;
      }
      const nonZero = lh.filter((h) => h.p > 0.01).length;
      const lo = lh[0]!.p;
      const lpeak = Math.max(...lh.map((h) => h.p));
      console.log(
        `   loser  ${lb.label.padEnd(14).slice(0,14)} : series n=${lh.length} · ${nonZero} pts >1%  · open ${pct(lo)} · peak ${pct(lpeak)} · last ${pct(lh[lh.length-1]!.p)}` +
          `   ${nonZero <= 1 ? '⚠ flat-zero (artifact?)' : '✓ real series'}`,
      );
    }
    console.log('');
  }

  // ===== READ =====
  console.log('=== READ ===');
  if (arcs.length) {
    const gains = arcs.map((a) => a.winnerSellbackGain).filter((g): g is number => g != null);
    const opens = arcs.map((a) => a.winnerOpen).filter((g): g is number => g != null);
    const cheapOpens = opens.filter((o) => o <= 0.2).length;
    const med = (xs: number[]) => { const s=[...xs].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length? (s.length%2? s[m]! : (s[m-1]!+s[m]!)/2):NaN; };
    console.log(`  winners that opened ≤20% (cheap): ${cheapOpens}/${opens.length}`);
    console.log(`  winner buy-open→pre-resolution-sellback gain: median ${(med(gains)*100).toFixed(0)}pp · min ${(Math.min(...gains)*100).toFixed(0)} · max ${(Math.max(...gains)*100).toFixed(0)}  (MARKS only — NOT depth-adjusted)`);
    console.log(`  ⚠ these are SURVIVOR winners; the real test buys at open NOT knowing the winner. Edge needs (a) depth at open [Part A] and (b) our forecast to pick the riser at lead 1-2 (our WORST horizon).`);
  } else {
    console.log('  no resolved arcs reconstructed (history gap or no recent winners)');
  }
  console.log('  WALL 1 verdict = read Part A: if buyable-$-at-touch on the flat leaders is single/low-double digits, the opening edge is a top-of-book mirage → KILL on capacity, same as cross-venue/complete-set.');
}

main().catch((e) => {
  process.stderr.write(`FATAL ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
