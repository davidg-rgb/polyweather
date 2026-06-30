/**
 * scripts/research/pull-market-history — pull the FULL prices-history series for daily-weather
 * markets and save LOCALLY (no DB, no prod writes). Research archive of the implied-prob price path.
 *
 * WHY startTs/endTs (NOT interval=max): the CLOB prices-history `interval=max` form returns an EMPTY
 * history for markets older than ~2 weeks (verified live 2026-06-30: london jan-2025, vol 116k → 0 pts).
 * The explicit `startTs`/`endTs` form returns the full series for ANY age — so this puller spans each
 * event's createdAt→endDate window. fidelity is in MINUTES (1 = ~per-minute, ~3000 pts/bucket over a
 * 2–3 day market life; 10 ≈ ~300; 60 ≈ ~47).
 *
 * Reach: per-city series_id (reaches events Gamma archived out of the closed list — london/nyc to
 * 2025-01-22). 44/45 of our cities resolve on the {city}-daily-weather stem (panama-city → panama,
 * via SERIES_SLUG_OVERRIDES in backfill-market-history).
 *
 * Output (gitignored — scripts/research/out/): out/market-history/{city}/{YYYY-MM-DD}__{eventId}.json
 *   { city, seriesId, slug, eventId, targetDate, createdAt, endDate, fidelityMin,
 *     buckets: [{ idx, label, tokenYes, resolvedOutcome: 'win'|'lose'|null, points: [[t,p], …] }] }
 * Resumable: an event whose file already exists is skipped (unless --refetch). A per-city summary.json
 * and a top-level summary.json record counts.
 *
 * Run: pnpm tsx scripts/research/pull-market-history.ts            # london,nyc @ fidelity 1 (default)
 *      pnpm tsx scripts/research/pull-market-history.ts --cities all --fidelity 10
 *      pnpm tsx scripts/research/pull-market-history.ts --cities nyc --from 2025-06-01 --limit 50
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveSeriesId } from '../backfill-market-history.ts';

const HEADERS = { 'User-Agent': 'weather-edge/0.1 (research backfill)', Accept: 'application/json' };
const PAGE_SIZE = 100;
const OUT_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'out', 'market-history');

/** Our 45 modeled cities (the cities table slug set, 2026-06-30). */
const ALL_CITIES = [
  'amsterdam', 'ankara', 'atlanta', 'austin', 'beijing', 'buenos-aires', 'busan', 'cape-town',
  'chengdu', 'chicago', 'chongqing', 'dallas', 'denver', 'guangzhou', 'helsinki', 'houston', 'jeddah',
  'karachi', 'kuala-lumpur', 'london', 'los-angeles', 'lucknow', 'madrid', 'manila', 'mexico-city',
  'miami', 'milan', 'munich', 'nyc', 'panama-city', 'paris', 'qingdao', 'san-francisco', 'sao-paulo',
  'seattle', 'seoul', 'shanghai', 'shenzhen', 'singapore', 'taipei', 'tokyo', 'toronto', 'warsaw',
  'wellington', 'wuhan',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const epoch = (iso: string): number => Math.floor(new Date(iso).getTime() / 1000);

interface RawMarket {
  groupItemTitle?: string;
  clobTokenIds?: string;
  outcomePrices?: string;
}
interface RawEvent {
  id: string | number;
  slug: string;
  endDate?: string;
  closedTime?: string;
  createdAt?: string;
  markets?: RawMarket[];
}
interface PricePointRaw {
  t: number;
  p: number;
}

/** GET JSON with retry + 429-aware backoff. Returns null on persistent failure (caller counts it). */
async function fetchJson(url: string, tries = 4): Promise<unknown> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return await res.json();
      // 429 / 5xx → back off and retry; 4xx (other) → give up (bad request)
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      /* network blip — retry */
    }
    await sleep(500 * attempt + Math.floor(attempt * 137)); // linear backoff + small jitter
  }
  return null;
}

/** Map N async tasks through a fixed-size worker pool (concurrency cap). */
async function pool<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

const seriesEventsUrl = (id: number, offset: number): string =>
  `https://gamma-api.polymarket.com/events?series_id=${id}&order=endDate&ascending=true&limit=${PAGE_SIZE}&offset=${offset}`;
const pricesHistoryUrl = (token: string, startTs: number, endTs: number, fidelity: number): string =>
  `https://clob.polymarket.com/prices-history?market=${token}&startTs=${startTs}&endTs=${endTs}&fidelity=${fidelity}`;

interface CitySummary {
  city: string;
  seriesId: number | null;
  events: number;
  eventsWritten: number;
  eventsSkippedExisting: number;
  buckets: number;
  points: number;
  emptyBuckets: number;
}

async function pullCity(
  city: string,
  opts: { fidelity: number; from?: string; limit?: number; refetch: boolean; concurrency: number },
): Promise<CitySummary> {
  const sum: CitySummary = {
    city, seriesId: null, events: 0, eventsWritten: 0, eventsSkippedExisting: 0,
    buckets: 0, points: 0, emptyBuckets: 0,
  };
  const seriesId = await resolveSeriesId(city, { fetchSeries: (s) => fetchJson(`https://gamma-api.polymarket.com/series?slug=${s}`) });
  sum.seriesId = seriesId;
  if (seriesId === null) {
    console.log(`· ${city}: no daily-weather series — skipped`);
    return sum;
  }

  // enumerate the full series, ascending (offset 0 = the floor)
  const events: RawEvent[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = (await fetchJson(seriesEventsUrl(seriesId, offset))) as RawEvent[] | null;
    if (!page || page.length === 0) break;
    events.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  sum.events = events.length;

  const cityDir = join(OUT_ROOT, city);
  mkdirSync(cityDir, { recursive: true });
  let written = 0;

  for (const ev of events) {
    const endIso = ev.closedTime ?? ev.endDate;
    if (!endIso) continue;
    const targetDate = endIso.slice(0, 10);
    if (opts.from && targetDate < opts.from) continue;
    if (opts.limit && written >= opts.limit) break;

    const file = join(cityDir, `${targetDate}__${ev.id}.json`);
    if (existsSync(file) && !opts.refetch) {
      sum.eventsSkippedExisting++;
      continue;
    }

    const startTs = ev.createdAt ? epoch(ev.createdAt) : epoch(endIso) - 4 * 86400;
    const endTs = epoch(endIso);
    const markets = ev.markets ?? [];

    const buckets = await pool(markets, opts.concurrency, async (m, idx) => {
      const tokenYes = m.clobTokenIds ? (JSON.parse(m.clobTokenIds) as string[])[0] : null;
      let resolvedOutcome: 'win' | 'lose' | null = null;
      if (m.outcomePrices) {
        const op = (JSON.parse(m.outcomePrices) as string[]).map(Number);
        if (op.length === 2 && op.every(Number.isFinite)) resolvedOutcome = op[0] === 1 ? 'win' : 'lose';
      }
      let points: Array<[number, number]> = [];
      if (tokenYes) {
        const ph = (await fetchJson(pricesHistoryUrl(tokenYes, startTs, endTs, opts.fidelity))) as
          | { history?: PricePointRaw[] }
          | null;
        points = (ph?.history ?? [])
          .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.p))
          .map((h) => [h.t, h.p] as [number, number]);
      }
      return { idx, label: m.groupItemTitle ?? null, tokenYes, resolvedOutcome, points };
    });

    for (const b of buckets) {
      sum.buckets++;
      sum.points += b.points.length;
      if (b.points.length === 0) sum.emptyBuckets++;
    }

    writeFileSync(
      file,
      JSON.stringify({
        city, seriesId, slug: ev.slug, eventId: String(ev.id), targetDate,
        createdAt: ev.createdAt ?? null, endDate: endIso, fidelityMin: opts.fidelity, buckets,
      }),
    );
    written++;
    sum.eventsWritten++;
    if (written % 25 === 0) {
      console.log(`  ${city}: ${written} events written (${sum.points.toLocaleString()} pts so far)`);
    }
  }

  console.log(
    `✓ ${city} (series ${seriesId}): ${sum.eventsWritten} written` +
      (sum.eventsSkippedExisting ? ` (+${sum.eventsSkippedExisting} already on disk)` : ``) +
      ` · ${sum.buckets} buckets · ${sum.points.toLocaleString()} points` +
      (sum.emptyBuckets ? ` · ${sum.emptyBuckets} empty buckets` : ``),
  );
  return sum;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cities: { type: 'string' }, // comma list, or 'all'
      fidelity: { type: 'string' },
      from: { type: 'string' },
      limit: { type: 'string' },
      refetch: { type: 'boolean' },
      concurrency: { type: 'string' },
    },
  });
  const cities =
    !values.cities || values.cities === 'all' ? ALL_CITIES : values.cities.split(',').map((c) => c.trim());
  const requested = !values.cities ? ['london', 'nyc'] : cities; // default scope = the deep cities
  const fidelity = values.fidelity ? Number(values.fidelity) : 1;
  const opts = {
    fidelity,
    from: values.from,
    limit: values.limit ? Number(values.limit) : undefined,
    refetch: values.refetch ?? false,
    concurrency: values.concurrency ? Number(values.concurrency) : 6,
  };
  mkdirSync(OUT_ROOT, { recursive: true });
  console.log(
    `pull-market-history → ${OUT_ROOT}\n` +
      `cities: ${requested.join(', ')} · fidelity ${fidelity}min · concurrency ${opts.concurrency}` +
      (opts.from ? ` · from ${opts.from}` : ``) +
      (opts.limit ? ` · limit ${opts.limit}/city` : ``) +
      `\n`,
  );

  const summaries: CitySummary[] = [];
  for (const city of requested) summaries.push(await pullCity(city, opts));

  const totals = summaries.reduce(
    (a, s) => ({
      events: a.events + s.eventsWritten,
      buckets: a.buckets + s.buckets,
      points: a.points + s.points,
      empty: a.empty + s.emptyBuckets,
    }),
    { events: 0, buckets: 0, points: 0, empty: 0 },
  );
  writeFileSync(
    join(OUT_ROOT, 'summary.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), fidelity, cities: summaries, totals }, null, 2),
  );
  console.log(
    `\n=== pull complete: ${totals.events} events · ${totals.buckets} buckets · ` +
      `${totals.points.toLocaleString()} points (${totals.empty} empty buckets) ===\n` +
      `summary: ${join(OUT_ROOT, 'summary.json')}`,
  );
}

await main();
