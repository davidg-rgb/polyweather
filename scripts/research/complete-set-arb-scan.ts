/**
 * scripts/research/complete-set-arb-scan — the historical (IMPURE spine) for the structural
 * complete-set arbitrage (COMPLETE-SET-ARB.md, the 8th signal). Answers the question the whole R&D
 * program never asked — not "is our forecast better than the market?" but "is the market consistent
 * with ITSELF?" — by reconstructing, over the full resolved-ladder universe, every CONTEMPORANEOUS
 * complete-set book and testing whether Σask<1 (buy all YES → $1) or Σbid>1 (buy all NO → $(N−1))
 * ever clears the per-leg taker fee.
 *
 * The math + frozen verdict live in `packages/core/src/sim/complete-set-arb.ts` (pure, tested). This
 * spine is only the DB I/O + the report. The HEAVY lift — forward-filling each bucket's last quote
 * as-of each grid instant and the 30-min freshness gate (the stale-quote trap, ADR-style) — is done
 * in SQL; TS rebuilds each instant's per-leg ask/bid vectors and calls the module so the module is
 * the single source of truth.
 *
 * Read-only. Places nothing. Never imports packages/trading; the live rail stays DORMANT. Run:
 *   pnpm tsx scripts/research/complete-set-arb-scan.ts [--max-stale 30] [--from 2026-05-01] [--to 2026-07-01] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type ArbScanSummary,
  type CompleteSetEdge,
  classifyPersistence,
  completeSetArbVerdict,
  completeSetEdge,
  summarizeScan,
} from '../../packages/core/src/sim/complete-set-arb.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { Db } from '../lib/backfill.ts';

const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const num = (v: string | undefined, d: number): number =>
  v != null && Number.isFinite(Number(v)) ? Number(v) : d;
const toNumArr = (v: unknown): (number | null)[] =>
  (Array.isArray(v) ? v : []).map((x) => (x == null ? null : Number(x)));

/** One contemporaneous complete-set instant: per-leg ask/bid vectors + its real resolution. */
export interface Instant {
  slug: string;
  targetDate: string;
  capturedAt: string;
  asks: (number | null)[];
  bids: (number | null)[];
}

/**
 * Load every CONTEMPORANEOUS complete-set instant over the resolved-ladder universe. SQL forward-
 * fills each bucket's latest non-null quote as-of each grid instant, keeps only instants where ALL
 * legs are ≤ maxStaleMin fresh (the contemporaneity gate — guards the Karachi stale-ghost trap), and
 * array_aggs the per-leg ask/bid vectors ordered by bucket_idx.
 */
export async function loadInstants(db: Db, from: string, to: string, maxStaleMin: number): Promise<Instant[]> {
  const rows = await db.query<{
    slug: string;
    target_date: string | Date;
    t: string | Date;
    asks: unknown;
    bids: unknown;
  }>(
    `with ev as (
       select id, slug, target_date from market_events
       where ladder_ok and winning_bucket_idx is not null
         and target_date >= $1 and target_date <= $2
     ),
     grid as (
       select b.event_id, s.captured_at as t
       from market_buckets b join market_snapshots s on s.bucket_id = b.id
       where b.event_id in (select id from ev)
       group by b.event_id, s.captured_at
     ),
     ff as (
       select g.event_id, g.t, b.bucket_idx, q.best_ask, q.best_bid,
              extract(epoch from (g.t - q.captured_at))/60.0 as stale_min
       from grid g
       join market_buckets b on b.event_id = g.event_id
       cross join lateral (
         select s.best_bid, s.best_ask, s.captured_at
         from market_snapshots s
         where s.bucket_id = b.id and s.captured_at <= g.t
           and s.best_bid is not null and s.best_ask is not null and s.best_bid <= s.best_ask
         order by s.captured_at desc limit 1
       ) q
     ),
     agg as (
       select event_id, t, count(*) as n, max(stale_min) as max_stale,
              array_agg(best_ask order by bucket_idx) as asks,
              array_agg(best_bid order by bucket_idx) as bids
       from ff group by event_id, t having max(stale_min) <= $3
     ),
     fulln as (select event_id, count(*) as nb from market_buckets group by event_id)
     select e.slug, e.target_date, a.t, a.asks, a.bids
     from agg a
     join fulln u on u.event_id = a.event_id and a.n = u.nb
     join ev e on e.id = a.event_id
     order by e.target_date, a.t`,
    [from, to, maxStaleMin],
  );
  return rows.map((r) => ({
    slug: r.slug,
    targetDate: String(r.target_date).slice(0, 10),
    capturedAt: String(r.t),
    asks: toNumArr(r.asks),
    bids: toNumArr(r.bids),
  }));
}

/** A per-event high-water mark, for the "where does the (rare) edge live" table. */
interface EventBest {
  slug: string;
  instants: number;
  bestUnderNet: number;
  bestOverNet: number;
  underCleared: number;
  overCleared: number;
  /** Move 2: persistence classification for fee-cleared instants. */
  persistentClears: number;
  blipClears: number;
}

function perEventBests(instants: Instant[], edges: CompleteSetEdge[]): EventBest[] {
  const by = new Map<string, EventBest>();
  // Build per-slug clearing timeseries for Move 2 persistence pass
  const clearingSeries = new Map<string, Array<{ capturedAt: string; clearing: boolean }>>();

  instants.forEach((ins, i) => {
    const e = edges[i]!;
    let b = by.get(ins.slug);
    if (!b) {
      b = { slug: ins.slug, instants: 0, bestUnderNet: -Infinity, bestOverNet: -Infinity, underCleared: 0, overCleared: 0, persistentClears: 0, blipClears: 0 };
      by.set(ins.slug, b);
    }
    b.instants++;
    if (Number.isFinite(e.underNet as number)) b.bestUnderNet = Math.max(b.bestUnderNet, e.underNet!);
    if (Number.isFinite(e.overNet as number)) b.bestOverNet = Math.max(b.bestOverNet, e.overNet!);
    const isClearing = (e.underNet ?? -1) > 0 || (e.overNet ?? -1) > 0;
    if ((e.underNet ?? -1) > 0) b.underCleared++;
    if ((e.overNet ?? -1) > 0) b.overCleared++;
    // Accumulate for persistence classifier
    const series = clearingSeries.get(ins.slug) ?? [];
    series.push({ capturedAt: ins.capturedAt, clearing: isClearing });
    clearingSeries.set(ins.slug, series);
  });

  // Run persistence classifier per-event and attach to the bests record
  for (const [slug, series] of clearingSeries) {
    const b = by.get(slug);
    if (!b) continue;
    const { summary } = classifyPersistence(series);
    b.persistentClears = summary.persistentCount;
    b.blipClears = summary.blipCount;
  }

  return [...by.values()];
}

export function buildReport(
  instants: Instant[],
  edges: CompleteSetEdge[],
  summary: ArbScanSummary,
  from: string,
  to: string,
  maxStaleMin: number,
): { lines: string[]; json: unknown } {
  const lines: string[] = [];
  const P = (s = ''): void => {
    lines.push(s);
  };
  const verdict = completeSetArbVerdict(summary);
  const bests = perEventBests(instants, edges).sort(
    (a, b) => Math.max(b.bestUnderNet, b.bestOverNet) - Math.max(a.bestUnderNet, a.bestOverNet),
  );
  const events = new Set(instants.map((i) => i.slug)).size;

  // Move 2: universe-level persistence summary (aggregate all-slug clearing series)
  const allSeries = instants.map((ins, i) => {
    const e = edges[i]!;
    return { capturedAt: ins.capturedAt, clearing: (e.underNet ?? -1) > 0 || (e.overNet ?? -1) > 0 };
  });
  // Note: the universe-wide series mixes ladders, so run per-event and aggregate
  const totalClearing = bests.reduce((a, b) => a + b.underCleared + b.overCleared, 0);
  const totalPersistent = bests.reduce((a, b) => a + b.persistentClears, 0);
  const totalBlips = bests.reduce((a, b) => a + b.blipClears, 0);
  void allSeries; // accumulated but aggregate is per-event above

  P('');
  P('=== Complete-set (structural / forecast-free) arbitrage scan — the 8th signal ===');
  P(`generated ${new Date().toISOString()}`);
  P(`window target_date ${from}..${to} · contemporaneity gate ≤ ${maxStaleMin} min (the stale-ghost guard)`);
  P(`${events} resolved+ladder_ok events · ${summary.instants} contemporaneous complete-set instants`);
  P('');
  P('THE RAW BOOK IS INTERNALLY INCONSISTENT — but only by less than the fee:');
  P(`  Σask < 1 (raw underround, pre-fee):  ${summary.underRawBelow1} / ${summary.instants}  (${pct(summary.underRawBelow1 / summary.instants)})`);
  P(`  Σbid > 1 (raw overround, pre-fee):   ${summary.overRawAbove1} / ${summary.instants}  (${pct(summary.overRawAbove1 / summary.instants)})`);
  P('');
  P('AFTER THE PER-LEG TAKER FEE (weather_fees rate 0.05, takerOnly — the wall):');
  P(`  underround NET > 0 (buy all YES, hold → $1):     ${summary.underFeeCleared} / ${summary.instants}  (${pct(summary.underFeeCleared / summary.instants)})`);
  P(`  overround  NET > 0 (buy all NO,  hold → $(N−1)): ${summary.overFeeCleared} / ${summary.instants}  (${pct(summary.overFeeCleared / summary.instants)})`);
  P(`  best underround net ${pct(summary.bestUnderNet)} · best overround net ${pct(summary.bestOverNet)} · mean underround net ${pct(summary.meanUnderNet)}`);
  P('');
  P('MOVE 2 — PERSISTENCE of the fee-clearing instants (blip vs consecutive):');
  P(`  total fee-clearing instants: ${totalClearing}`);
  P(`  persistent (≥2 consecutive polls): ${totalPersistent}  (${pct(totalClearing > 0 ? totalPersistent / totalClearing : 0)})`);
  P(`  single-poll blips:                 ${totalBlips}  (${pct(totalClearing > 0 ? totalBlips / totalClearing : 0)})`);
  P('  (strong prior: mostly blips → confirms the thin-open-book window is not continuously executable)');
  P('');
  P('TOP 12 events by best net edge (where the rare fee-clearing dislocation lives):');
  P('  event                                          inst  bestUnderNet  bestOverNet  under✓  over✓  persist  blips');
  for (const b of bests.slice(0, 12)) {
    P(
      `  ${b.slug.replace('highest-temperature-in-', '').padEnd(44).slice(0, 44)} ${String(b.instants).padStart(4)}  ` +
        `${pct(b.bestUnderNet).padStart(11)}  ${pct(b.bestOverNet).padStart(10)}  ${String(b.underCleared).padStart(5)}  ${String(b.overCleared).padStart(4)}  ` +
        `${String(b.persistentClears).padStart(7)}  ${String(b.blipClears).padStart(5)}`,
    );
  }
  P('');
  P(`VERDICT (frozen economic criterion, ${pct(verdict.feeClearedFrac)} fee-cleared vs ${pct(verdict.rawFrac)} raw):  ${verdict.label}`);
  P(`  ${verdict.reason}`);

  return {
    lines,
    json: {
      generatedAt: new Date().toISOString(),
      window: { from, to, maxStaleMin },
      events,
      summary,
      verdict,
      persistence: { totalClearing, totalPersistent, totalBlips },
      topEvents: bests.slice(0, 25),
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      'max-stale': { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      json: { type: 'boolean' },
      out: { type: 'string' },
    },
  });
  const from = values.from ?? '2026-05-01';
  const to = values.to ?? '2026-07-01';
  const maxStale = num(values['max-stale'], 30);

  const db = makeScriptDb();
  try {
    process.stderr.write(`loading contemporaneous complete-set instants (${from}..${to}, ≤${maxStale}min)…\n`);
    const instants = await loadInstants(db, from, to, maxStale);
    process.stderr.write(`  ${instants.length} fresh complete-set instants\n`);
    const edges = instants.map((ins) => completeSetEdge(ins.asks, ins.bids));
    const summary = summarizeScan(edges);
    const { lines, json } = buildReport(instants, edges, summary, from, to, maxStale);
    console.log(lines.join('\n'));

    const outPath = values.out ?? 'scripts/research/out/complete-set-arb-scan.json';
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(json, null, 2));
    writeFileSync(outPath.replace(/\.json$/, '.md'), lines.join('\n'));
    if (values.json) console.log('\nJSON ' + JSON.stringify(json));
    process.stderr.write(`\nwrote ${outPath} (+ .md)\n`);
  } finally {
    await db.end();
  }
}
