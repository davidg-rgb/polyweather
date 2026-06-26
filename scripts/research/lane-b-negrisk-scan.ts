/**
 * scripts/research/lane-b-negrisk-scan — LANE B: the negRisk MINT-AND-SELL measurement (the
 * un-measured structural DUAL of the 8th signal / complete-set arb).
 *
 * THE OPEN QUESTION (COMPLETE-SET-ARB-HANDOFF.md "Move 5"). The 8th signal only tested the two
 * TAKER trades: buy-all-YES (underround, Σask<1) and buy-all-NO (overround) — both aggressive buys,
 * both fee-walled by the takerOnly per-leg fee. The textbook OVERROUND harvest was never measured:
 *
 *   MINT a complete YES set for exactly $1 via Polymarket's NegRiskAdapter split (locks $1 USDC as
 *   collateral, mints one YES of every bucket; NO protocol fee, only Polygon gas — fraction of a
 *   cent — verified docs.polymarket.com/developers/neg-risk + Polymarket/neg-risk-ctf-adapter), then
 *   SELL each YES leg into its bid AS A RESTING MAKER. Polymarket makers pay ZERO fees ("place a
 *   limit order and wait for it to be filled, you pay nothing" — help.polymarket.com/trading-fees,
 *   2026-03-30 schedule). So a resting sell DODGES the per-leg taker fee that walled the buy side.
 *
 * The mint-and-sell P&L per complete set, if every leg fills:
 *     harvest = Σ bid(YESᵢ)  −  $1 (mint)  −  gas
 * Σbid>1 is the OVERROUND the 8th signal saw on ~12% of raw instants. The fee no longer eats it.
 * So this is the one place the "maker route just re-opens the dead adverse-selection wall" argument
 * is NOT airtight — you hold the WHOLE hedged set ($1 deterministic redemption), not a directional
 * single-bucket leg, so the maker-spray / §12 directional adverse-selection has a different shape.
 *
 * WHAT KILLS IT ANYWAY (the two surviving walls, both measured here):
 *   1. DEPTH (the cross-venue lesson). Σbid>1 is a TOP-OF-BOOK quote. To harvest k complete sets you
 *      must fill a resting sell of k shares on EVERY leg. Binding executable size = min bid-side
 *      resting depth across ALL legs (bindingExecutable, cross-venue-arb.ts). The cross-venue signal
 *      FALSE-PASSED on a 24h-vol/OI proxy (winFrac 0.857) and KILLed at 1–10 contracts of true touch
 *      depth. The thin tail legs of a weather ladder throttle the whole set the same way.
 *   2. MAKER-ROUTE ADVERSE SELECTION (the §12 / replica wall, two-sided). A resting sell fills
 *      PREFERENTIALLY when the market is moving up through that bin (the eventual high lands there) —
 *      i.e. you are lifted on exactly the legs that were about to become the winner, and left holding
 *      the legs that stay cheap. Modelled as a per-leg haircut on the bid proceeds (ADVERSE_HAIRCUT):
 *      you do NOT realise the full Σbid; you realise Σbid minus the selection cost of being picked off.
 *
 * PRE-REGISTERED KILL-GATE (frozen BEFORE measuring — WO-5 discipline; do NOT tune to the result):
 *   PASS if, after mint cost ($1) + gas + the maker-route adverse-selection haircut, a complete-set
 *   MINT-AND-SELL nets > 0 AT EXECUTABLE DEPTH (binding bid-side fill ≥ MIN_EXEC_SIZE shares) on
 *   ≥ 10% of observed open-ladder instants, CI-aware (a normal-approx 95% CI on the win fraction whose
 *   lower bound must exceed 0). Else KILL — the same fee/depth wall as the buy side. Prior: low.
 *
 * READ-ONLY. Places nothing. NEVER imports packages/trading. Reads only public Polymarket Gamma
 * (open temperature ladders) + the public CLOB book endpoint (bid-side depth). The live rail stays
 * DORMANT. Run:  pnpm tsx scripts/research/lane-b-negrisk-scan.ts [--books N] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  normalizeBook,
  parseGammaEvent,
  type NormalizedBook,
  type ParsedEvent,
  type RawClobBook,
  type RawGammaEvent,
} from '../../packages/core/src/index.ts';
import { bindingExecutable, MIN_EXEC_SIZE } from '../../packages/core/src/sim/cross-venue-arb.ts';
import { fetchJson as ioFetchJson } from '../../packages/io/src/index.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596; // "Highest temperature" — the daily-Tmax negRisk ladders
const HEADERS = { 'User-Agent': 'weather-edge/0.1 (lane-b research probe)', Accept: 'application/json' };

const fj = (url: string): Promise<unknown> => ioFetchJson(url, { headers: HEADERS });
const usd = (v: number, d = 4): string => (Number.isFinite(v) ? `$${v.toFixed(d)}` : '—');
const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');

// ── pre-registered economic constants (frozen) ─────────────────────────────────────────────────────
/** NegRiskAdapter split: locks exactly $1 USDC, mints one YES per bucket. No protocol fee. */
const MINT_COST_USD = 1;
/**
 * Polygon gas to split a complete set + place N resting sells, amortised per complete set. Polygon
 * gas is "a fraction of a cent" (Polymarket docs); a generous $0.01/set covers the split + the maker
 * order relays (Polymarket relays gasless orders, so this is conservative-high). Per $1 set it is
 * negligible vs the bid sum — included for honesty, not load-bearing.
 */
const GAS_PER_SET_USD = 0.01;
/**
 * Maker-route adverse-selection haircut on the resting-sell proceeds, in probability points per leg.
 * The §12/replica wall measured a directional maker edge of −1.5 to −1.7pp from adverse selection on
 * a SINGLE resting leg. A complete-set sell rests on EVERY leg; the legs that fill first are the ones
 * the market is moving toward (about to win), so the realised average sell price is below the quoted
 * bid. We charge the falsified directional magnitude (1.7pp) per leg as the proceeds haircut. This is
 * a MODEL (no fill data on our own un-placed orders exists), pre-registered, applied to BOTH the point
 * estimate and a sensitivity sweep (0 / 1.7 / 3.4pp) so the verdict's dependence on it is visible.
 */
const ADVERSE_HAIRCUT_PP = 0.017;

// ── the mint-and-sell measurement for one ladder snapshot ────────────────────────────────────────
interface MintSellRow {
  slug: string;
  n: number;
  /** Σ best-bid across all legs (top-of-book), from the live CLOB books. */
  sumBid: number;
  /** Raw harvest at top-of-book: Σbid − mint − gas (NO fee — maker sell). */
  rawHarvest: number;
  /** Harvest after the per-leg adverse-selection haircut: Σ(bid − haircut) − mint − gas. */
  netHarvest: number;
  /** Binding bid-side resting depth across ALL legs (min top-bid size) — the executable size. */
  bindingDepth: number;
  /** netHarvest > 0 AND bindingDepth ≥ MIN_EXEC_SIZE — a real, executable mint-and-sell win. */
  executableWin: boolean;
}

/** Compute the mint-and-sell row for one event from its live per-leg CLOB books (bid touch). */
function mintSellRow(slug: string, books: NormalizedBook[], haircutPp: number): MintSellRow | null {
  if (books.length === 0) return null;
  // every leg must carry a usable best bid AND positive resting size — else the YES set cannot be
  // sold complete (a missing/empty bid leg = a hole = no hedged harvest; binding depth → 0).
  const bids: number[] = [];
  const bidSizes: number[] = [];
  for (const bk of books) {
    const top = bk.bids[0];
    if (!top || !(top.price > 0 && top.price < 1) || !(top.size > 0)) {
      // an unsellable leg caps the whole position; record it as a zero-depth, no-win row
      return {
        slug, n: books.length, sumBid: NaN, rawHarvest: NaN, netHarvest: NaN,
        bindingDepth: 0, executableWin: false,
      };
    }
    bids.push(top.price);
    bidSizes.push(top.size);
  }
  const sumBid = bids.reduce((s, x) => s + x, 0);
  const rawHarvest = sumBid - MINT_COST_USD - GAS_PER_SET_USD;
  // adverse-selection haircut: each resting sell realises (bid − haircut) on average
  const sumBidNet = bids.reduce((s, x) => s + Math.max(0, x - haircutPp), 0);
  const netHarvest = sumBidNet - MINT_COST_USD - GAS_PER_SET_USD;
  const bindingDepth = bindingExecutable(bidSizes, []); // all legs are sell legs (bid touch)
  return {
    slug, n: books.length, sumBid, rawHarvest, netHarvest, bindingDepth,
    executableWin: netHarvest > 0 && bindingDepth >= MIN_EXEC_SIZE,
  };
}

/** Wilson-free normal-approx 95% CI on a win fraction (lower bound is the load-bearing number). */
function winFracCi(wins: number, n: number): { frac: number; lo: number; hi: number } {
  if (n <= 0) return { frac: NaN, lo: NaN, hi: NaN };
  const p = wins / n;
  const se = Math.sqrt((p * (1 - p)) / n);
  return { frac: p, lo: Math.max(0, p - 1.96 * se), hi: Math.min(1, p + 1.96 * se) };
}

export async function scanLaneB(
  deps: { fetchJson: (u: string) => Promise<unknown>; log: (s: string) => void },
  opts: { books: number },
): Promise<{ rows: MintSellRow[]; lines: string[] }> {
  const { fetchJson, log } = deps;
  const lines: string[] = [];
  const P = (s = ''): void => { lines.push(s); log(s); };

  // 1) page all active, open temperature events
  const events: ParsedEvent[] = [];
  let parseFails = 0;
  for (let offset = 0; ; offset += 100) {
    const page = (await fetchJson(
      `${GAMMA}/events?tag_id=${TAG}&active=true&closed=false&limit=100&offset=${offset}`,
    )) as RawGammaEvent[];
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page) {
      try { events.push(parseGammaEvent(raw)); } catch { parseFails++; }
    }
    if (page.length < 100) break;
  }
  const ladders = events.filter((e) => e.buckets.length >= 3);
  P('');
  P('=== LANE B — negRisk MINT-AND-SELL probe (mint $1 → rest a sell on every YES leg, no maker fee) ===');
  P(`generated ${new Date().toISOString()}`);
  P(`fetched ${events.length} open temperature ladders (${parseFails} unparseable) · ${ladders.length} with ≥3 buckets`);
  P(`mint=${usd(MINT_COST_USD)} gas=${usd(GAS_PER_SET_USD)} adverseHaircut=${pct(ADVERSE_HAIRCUT_PP)}/leg · MIN_EXEC_SIZE=${MIN_EXEC_SIZE} shares`);
  P('');

  // 2) prioritise the ladders most likely overround at top-of-book (Σ gamma bestBid highest), then
  //    fetch the REAL bid-side depth from the CLOB book per leg for the top `books` of them.
  const ranked = ladders
    .map((e) => ({
      e,
      sumGammaBid: e.buckets.reduce((s, b) => s + (b.bestBid ?? 0), 0),
      negRisk: undefined as boolean | undefined,
    }))
    .sort((a, b) => b.sumGammaBid - a.sumGammaBid);

  const toProbe = ranked.slice(0, opts.books);
  const rows: MintSellRow[] = [];
  P(`DEPTH ground-truth — fetching live CLOB books (bid side) for the top ${toProbe.length} ladders by Σ bestBid:`);
  P('  slug                                              n   Σbid    rawHarv   netHarv   bindDepth  win');
  for (const { e } of toProbe) {
    try {
      const books: NormalizedBook[] = [];
      let allNegRisk = true;
      for (const b of e.buckets) {
        const raw = (await fetchJson(`${CLOB}/book?token_id=${b.tokenYes}`)) as RawClobBook;
        const bk = normalizeBook(raw);
        if (!bk.negRisk) allNegRisk = false;
        books.push(bk);
      }
      const row = mintSellRow(e.slug, books, ADVERSE_HAIRCUT_PP);
      if (!row) continue;
      rows.push(row);
      const negTag = allNegRisk ? '' : ' [NON-negRisk! mint mechanic N/A]';
      P(
        `  ${e.slug.replace('highest-temperature-in-', '').padEnd(48).slice(0, 48)} ${String(row.n).padStart(2)}  ` +
          `${Number.isFinite(row.sumBid) ? row.sumBid.toFixed(3) : ' inc '}  ${usd(row.rawHarvest).padStart(8)}  ` +
          `${usd(row.netHarvest).padStart(8)}  ${String(row.bindingDepth).padStart(8)}  ${row.executableWin ? 'YES' : 'no'}${negTag}`,
      );
    } catch (err) {
      P(`  ${e.slug}: book fetch failed — ${String(err).slice(0, 70)}`);
    }
  }

  // 3) the frozen verdict
  const valid = rows.filter((r) => Number.isFinite(r.netHarvest) || r.bindingDepth === 0);
  const N = rows.length;
  const rawOverround = rows.filter((r) => Number.isFinite(r.rawHarvest) && r.rawHarvest > 0).length;
  const netPositive = rows.filter((r) => Number.isFinite(r.netHarvest) && r.netHarvest > 0).length;
  const execWins = rows.filter((r) => r.executableWin).length;
  const ci = winFracCi(execWins, N);

  // sensitivity: re-evaluate executable-win count at haircut 0 and 2× (does the verdict flip?)
  const recount = (hp: number): number =>
    rows.filter((r) => {
      if (!Number.isFinite(r.sumBid)) return false;
      // reconstruct netHarvest at this haircut from sumBid is lossy (per-leg), so use a conservative
      // bound: full Σbid haircut = n·hp. This OVER-states the haircut slightly (≤, since bids may be
      // below hp and floor at 0) — safe direction. Pair with bindingDepth gate.
      const netAtHp = r.sumBid - r.n * hp - MINT_COST_USD - GAS_PER_SET_USD;
      return netAtHp > 0 && r.bindingDepth >= MIN_EXEC_SIZE;
    }).length;
  const winNoHaircut = recount(0);
  const winDoubleHaircut = recount(2 * ADVERSE_HAIRCUT_PP);

  P('');
  P('=== VERDICT — negRisk mint-and-sell ===');
  P(`ladders depth-probed (instants):           ${N}`);
  P(`  raw overround (Σbid − 1 − gas > 0):      ${rawOverround}  (${pct(N ? rawOverround / N : NaN)})`);
  P(`  net-positive after adverse haircut:       ${netPositive}  (${pct(N ? netPositive / N : NaN)})`);
  P(`  EXECUTABLE wins (net>0 AND depth≥${MIN_EXEC_SIZE}):     ${execWins}  (winFrac ${pct(ci.frac)}, 95% CI [${pct(ci.lo)}, ${pct(ci.hi)}])`);
  P(`  sensitivity execWins  haircut 0 / 1.7pp / 3.4pp:  ${winNoHaircut} / ${execWins} / ${winDoubleHaircut}`);
  const bindingDepths = rows.map((r) => r.bindingDepth).filter((d) => d > 0).sort((a, b) => a - b);
  if (bindingDepths.length) {
    const med = bindingDepths[Math.floor(bindingDepths.length / 2)]!;
    P(`  binding bid-side depth (shares) min/median/max across legs: ${bindingDepths[0]} / ${med} / ${bindingDepths[bindingDepths.length - 1]}`);
  } else {
    P(`  binding bid-side depth: every probed ladder had ≥1 leg with no resting bid (depth 0).`);
  }
  P('');
  const minWinFrac = 0.10;
  const pass = N > 0 && ci.frac >= minWinFrac && ci.lo > 0;
  if (N === 0) {
    P('INSUFFICIENT_DATA — no open negRisk weather ladders depth-probed.');
  } else if (pass) {
    P(`PASS — ${pct(ci.frac)} of ${N} open-ladder instants net-positive AT EXECUTABLE DEPTH (≥${pct(minWinFrac)} bar, CI lower ${pct(ci.lo)} > 0). The maker mint-and-sell escapes the taker wall AND fills. Escalate to a depth/persistence study.`);
  } else {
    P(`KILL — mint-and-sell is walled. ${pct(ci.frac)} of ${N} instants clear net>0 at executable depth (vs ${pct(minWinFrac)} bar; CI lower ${pct(ci.lo)}). ${rawOverround === 0 ? 'The live book is NOT even raw-overround (Σbid<1 everywhere): there is no harvest to capture, fee or no fee — the overround is the thin-open-book transient the 8th signal already flagged.' : 'Where Σbid>1 exists it is throttled by thin tail-leg bid depth and/or eaten by the maker-route adverse-selection haircut.'} Same depth/selection wall as the buy side + cross-venue. Rail stays DORMANT.`);
  }
  P('');
  return { rows, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { books: { type: 'string' }, json: { type: 'boolean' } } });
  const booksN = Number(values.books ?? '12');
  const { rows } = await scanLaneB(
    { fetchJson: fj, log: (s) => console.log(s) },
    { books: Number.isFinite(booksN) ? booksN : 12 },
  );
  if (values.json) {
    console.log('\nJSON ' + JSON.stringify(rows));
  }
}
