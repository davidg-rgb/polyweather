/**
 * scripts/research/complete-set-arb-live — LIVE ground-truth probe for the complete-set
 * (structural / forecast-free) arbitrage on Polymarket weather ladders.
 *
 * The historical `market_snapshots` capture top-of-book bid/ask but rarely the DEPTH in the
 * thin freshly-opened window where any sum-of-YES<$1 dislocation lives (book_top3 is only
 * attached to ≤15 candidate books/cycle). So history can show the SIGNAL but not the
 * CAPACITY. This probe reads the live book directly to answer the binding question:
 *
 *   Right now, across every open temperature ladder, is Σ ask(YES) < 1 (buy whole set, hold,
 *   collect $1) or Σ bid(YES) > 1 (buy whole NO set, collect $N-1) net of the per-leg taker
 *   fee — and if so, how many complete sets can actually be bought at top-of-book depth?
 *
 * Read-only. Places nothing. Never imports packages/trading. Run:
 *   pnpm tsx scripts/research/complete-set-arb-live.ts [--books N] [--json]
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
import {
  FEE_RATE_WEATHER,
  type CompleteSetEdge,
  completeSetEdge,
  underroundExecutable as underroundExecutableLadders,
} from '../../packages/core/src/sim/complete-set-arb.ts';
import { fetchJson as ioFetchJson } from '../../packages/io/src/index.ts';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const TAG = 104596; // "Highest temperature" — the daily-Tmax ladders
const HEADERS = { 'User-Agent': 'weather-edge/0.1 (research probe)', Accept: 'application/json' };

const fj = (url: string): Promise<unknown> => ioFetchJson(url, { headers: HEADERS });
const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number, d = 2): string => (Number.isFinite(v) ? `$${v.toFixed(d)}` : '—');

/** The module's complete-set edge for a parsed live event (carries the event for depth probing). */
type SetEdge = CompleteSetEdge & { slug: string; event: ParsedEvent };

function topOfBookEdge(ev: ParsedEvent): SetEdge {
  const edge = completeSetEdge(
    ev.buckets.map((b) => b.bestAsk),
    ev.buckets.map((b) => b.bestBid),
  );
  return { ...edge, slug: ev.slug, event: ev };
}

export async function probeLive(
  deps: { fetchJson: (u: string) => Promise<unknown>; log: (s: string) => void },
  opts: { books: number },
): Promise<{ edges: SetEdge[]; lines: string[] }> {
  const { fetchJson, log } = deps;
  // 1) page all active, open temperature events
  const events: ParsedEvent[] = [];
  let parseFails = 0;
  for (let offset = 0; ; offset += 100) {
    const page = (await fetchJson(
      `${GAMMA}/events?tag_id=${TAG}&active=true&closed=false&limit=100&offset=${offset}`,
    )) as RawGammaEvent[];
    if (!Array.isArray(page) || page.length === 0) break;
    for (const raw of page) {
      try {
        events.push(parseGammaEvent(raw));
      } catch {
        parseFails++;
      }
    }
    if (page.length < 100) break;
  }
  log(`fetched ${events.length} open temperature ladders (${parseFails} unparseable)`);

  // 2) top-of-book complete-set edge per event
  const edges = events
    .filter((e) => e.buckets.length >= 3)
    .map(topOfBookEdge)
    .sort(
      (a, b) =>
        Math.max(b.underNet ?? -9, b.overNet ?? -9) - Math.max(a.underNet ?? -9, a.overNet ?? -9),
    );

  const lines: string[] = [];
  const P = (s = ''): void => {
    lines.push(s);
    log(s);
  };

  P('');
  P('=== LIVE complete-set arbitrage probe (top-of-book, Gamma bestBid/bestAsk) ===');
  P(`generated ${new Date().toISOString()}  ·  ${edges.length} ladders  ·  fee ${FEE_RATE_WEATHER} (weather_fees)`);
  const underPos = edges.filter((e) => (e.underNet ?? -1) > 0);
  const overPos = edges.filter((e) => (e.overNet ?? -1) > 0);
  P(
    `top-of-book dislocations: UNDER (Σask<1 net) ${underPos.length}/${edges.length} · OVER (Σbid>1 net) ${overPos.length}/${edges.length}`,
  );
  P('');
  P('TOP 15 ladders by best top-of-book net edge (per $1 complete set):');
  P('  slug                                                  n   Σask   underNet    Σbid   overNet');
  for (const e of edges.slice(0, 15)) {
    P(
      `  ${e.slug.replace('highest-temperature-in-', '').padEnd(50).slice(0, 50)} ${String(e.n).padStart(2)}  ` +
        `${(e.sumAsk ?? NaN).toFixed(3).padStart(5)}  ${pct(e.underNet ?? NaN).padStart(8)}  ` +
        `${(e.sumBid ?? NaN).toFixed(3).padStart(5)}  ${pct(e.overNet ?? NaN).padStart(8)}`,
    );
  }
  P('');

  // 3) DEPTH ground-truth: fetch full books for the most dislocated UNDER ladders.
  const toProbe = underPos.slice(0, opts.books);
  if (toProbe.length === 0) {
    P('No top-of-book UNDER dislocation among open ladders right now — nothing to depth-probe.');
    P('(The complete-set ask-sum straddles $1 from ABOVE on every open ladder: the live book is internally consistent.)');
  } else {
    P(`DEPTH ground-truth — fetching full CLOB books for the top ${toProbe.length} UNDER ladder(s):`);
    for (const e of toProbe) {
      try {
        const books: NormalizedBook[] = [];
        for (const b of e.event.buckets) {
          const raw = (await fetchJson(`${CLOB}/book?token_id=${b.tokenYes}`)) as RawClobBook;
          books.push(normalizeBook(raw));
        }
        const exec = underroundExecutableLadders(books.map((bk) => bk.asks));
        // recompute live Σ best-ask from the actual books (Gamma can lag a few seconds)
        const liveSumAsk = books.reduce((s, bk) => s + (bk.asks[0]?.price ?? 1), 0);
        P(
          `  ${e.slug.replace('highest-temperature-in-', '')}: live Σask(book)=${liveSumAsk.toFixed(3)} → ` +
            `executable ${exec.sets} sets, cost ${usd(exec.costUsd)}, PROFIT ${usd(exec.profitUsd)}`,
        );
      } catch (err) {
        P(`  ${e.slug}: book fetch failed — ${String(err).slice(0, 80)}`);
      }
    }
  }
  P('');
  return { edges, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { books: { type: 'string' }, json: { type: 'boolean' } } });
  const booksN = Number(values.books ?? '5');
  const { edges } = await probeLive(
    { fetchJson: fj, log: (s) => console.log(s) },
    { books: Number.isFinite(booksN) ? booksN : 5 },
  );
  if (values.json) {
    console.log(
      '\nJSON ' +
        JSON.stringify(
          edges.map((e) => ({
            slug: e.slug,
            n: e.n,
            sumAsk: e.sumAsk,
            underNet: e.underNet,
            sumBid: e.sumBid,
            overNet: e.overNet,
          })),
        ),
    );
  }
}
