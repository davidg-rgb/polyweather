/**
 * scripts/research/item6-crosshorizon — SIGNAL-BACKLOG.md item 6: cross-horizon (day+1/day+2)
 * information-propagation lag, pre-registered 2026-07-03 ~18:55 (see SIGNAL-BACKLOG.md "## 6." for the
 * full rationale). Locked design, implemented verbatim — NOT improvised around if the data can't support it.
 *
 * THE QUESTION. For the same city, day N and day N+1 draw on the same NWP initialization (correlated
 * forecast errors). When day N's sibling market RESOLVES (R_N), does day N+1's still-open ladder get
 * mispriced relative to our own forecast pipeline's day N+1 view — a fresh, fast-decaying window a taker
 * could act on?
 *
 * THE LOCKED DESIGN (verbatim from SIGNAL-BACKLOG.md):
 *   - Information event: day-N sibling market resolution at R_N (`market_events.resolved_at`).
 *   - Signal (NO LOOK-AHEAD): our day-N+1 CALIBRATED distribution (`bucket_probabilities.source=
 *     'house_gaussian'`, `seeded=false` — the production, non-bot-seeded blend) as of the LAST pipeline
 *     build strictly BEFORE R_N (`made_at < r_n`, `order by made_at desc limit 1` — the natural-key index
 *     `bucket_probabilities_event_source_time_idx (event_id, source, made_at desc)` makes this a cheap,
 *     indexed lookup, not a scan).
 *   - Mispricing `m = calibratedP − ask` read at the FIRST captured tick ≥ R_N+20min (the achievable
 *     detection latency at capture cadence).
 *   - Entry rule: taker buy the max-m bucket iff `m ≥ +5pp` and `ask ≤ 0.60`; entry window capped at
 *     R_N+2h (no qualifying tick in that window → no bet — a transient window exists early or not at all).
 *     Hold to resolution.
 *   - Gate: PASS iff n ≥ 40 pairs, ≥ 6 cities, per-bet edge 95% CI excludes 0 on the positive side
 *     (day-clustered CI reported alongside as a sanity read). Honest prior: KILL (same forecast-timing
 *     family as copy-trade/maker-spray/bracket-exit-taker/fluctuation-taker — all 4 died to adverse
 *     selection). INSUFFICIENT_DATA is an honest outcome if the DB can't recover a pre-R_N snapshot for
 *     enough pairs — this script does NOT improvise a substitute design if that happens.
 *
 * DATA-AVAILABILITY RISK (why this might come back INSUFFICIENT_DATA). `bucket_probabilities` carries a
 * 30-day post-resolution retention prune (0009_cron.sql §7.12) that DELETES every row except the final row
 * per (event_id, source) and nowcast extrema. For a day-N+1 event resolved > 30 days before "now", the
 * intermediate build history needed to reconstruct "the last build strictly before ANOTHER event's R_N"
 * may already be gone — only that event's OWN final build (typically near ITS OWN resolution, which is
 * ~24h after R_N, i.e. AFTER the cutoff we need) would survive. This script does not special-case that —
 * it just runs the literal `made_at < r_n` query and reports how many pairs come back with vs. without a
 * usable pre-R_N row. A low hit rate on older pairs (vs. a high hit rate on the last ~30 days) would
 * CONFIRM this mechanism; the script reports the raw counts either way.
 *
 * ONE DATA PULL. Sibling pairs + the pre-R_N distribution + the ≥2h coverage flag + the entry-window ask
 * per bucket are all fetched in ONE SQL statement (CTEs + LATERAL joins bounded by indexed windows — the
 * same idiom as db1-daybefore-efficiency.ts's day-before-ask subquery and conditional-efficiency-scan.ts's
 * shared pull), never an unbounded aggregate over full snapshot history.
 *
 * Reuses `armEdgeStats`/`GradedBet` (per-bet CI) and `clusterMeanTCi` (the day-clustered CI, the same
 * cluster-mean t-interval SELECTOR-LEARNABILITY.md's REC-1 gate uses) — no new statistical framework.
 *
 * Run: pnpm tsx scripts/research/item6-crosshorizon.ts --from 2026-04-21 --to 2026-06-29 [--cities EHAM,EGLC] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { armEdgeStats, type GradedBet } from '../../packages/core/src/sim/stats.ts';
import { clusterMeanTCi } from '../../packages/core/src/sim/selector-learn.ts';
import { splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'item6-crosshorizon';

// =====================================================================================
// PRE-REGISTERED CONFIG (locked — do not move to fit a result)
// =====================================================================================
export const ITEM6 = {
  /** Minimum mispricing to enter, in probability units (5pp). */
  minEdge: 0.05,
  /** Maximum entry ask (taker buy only below this). */
  maxAsk: 0.6,
  /** Entry window opens this many minutes after R_N (the achievable detection latency). */
  entryOpenMin: 20,
  /** Entry window closes this many hours after R_N (no qualifying tick inside → no bet). */
  entryCloseHours: 2,
  /** The ≥2h-of-price-history-after-R_N coverage requirement for a pair to even be eligible. */
  minCoverageHours: 2,
} as const;

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));

// =====================================================================================
// PURE HELPERS (no DB access — the testable core)
// =====================================================================================

/** One (pair, bucket) row as returned by the SQL pull, pre-typed for the grouping step. */
export interface RawPairBucketRow {
  n1Id: string;
  city: string;
  nDate: string;
  n1Date: string;
  n1Winner: number | null;
  houseProbs: number[] | null; // null = no pre-R_N snapshot recoverable
  hasCoverage: boolean;
  bucketIdx: number;
  entryAsk: number | null; // null = no qualifying tick in the [open,close] window for this bucket
}

/** One sibling pair, fully assembled from its (possibly many) bucket rows. Pure aggregate, no DB. */
export interface PairInput {
  n1Id: string;
  city: string;
  nDate: string;
  n1Date: string;
  n1Winner: number | null;
  houseProbs: number[] | null;
  hasCoverage: boolean;
  buckets: Array<{ bucketIdx: number; entryAsk: number | null }>;
}

/** Group flat (pair,bucket) SQL rows into one PairInput per n1Id. Pure. */
export function groupPairRows(rows: RawPairBucketRow[]): PairInput[] {
  const byPair = new Map<string, PairInput>();
  for (const r of rows) {
    let p = byPair.get(r.n1Id);
    if (!p) {
      p = {
        n1Id: r.n1Id, city: r.city, nDate: r.nDate, n1Date: r.n1Date, n1Winner: r.n1Winner,
        houseProbs: r.houseProbs, hasCoverage: r.hasCoverage, buckets: [],
      };
      byPair.set(r.n1Id, p);
    }
    p.buckets.push({ bucketIdx: r.bucketIdx, entryAsk: r.entryAsk });
  }
  return [...byPair.values()];
}

/** Why a pair did not produce a graded bet — an honest accounting, not a silent drop. */
export type PairSkipReason = 'no_pre_snapshot' | 'no_coverage' | 'no_qualifying_tick' | 'gate_not_cleared';

export type PairOutcome =
  | { status: 'skipped'; reason: PairSkipReason }
  | { status: 'bet'; won: boolean; ask: number; m: number; bucketIdx: number; city: string; cluster: string };

/**
 * Evaluate ONE sibling pair against the locked entry rule. Pure, total. Order of checks matches the
 * pre-registered design: data-availability (pre-R_N snapshot) → coverage (≥2h of price history) → the
 * entry-window tick existing at all → the mispricing/ask gate.
 */
export function evaluatePair(p: PairInput): PairOutcome {
  if (!p.houseProbs || p.houseProbs.length === 0) return { status: 'skipped', reason: 'no_pre_snapshot' };
  if (!p.hasCoverage) return { status: 'skipped', reason: 'no_coverage' };

  let best: { bucketIdx: number; ask: number; m: number } | null = null;
  for (const b of p.buckets) {
    if (!fin(b.entryAsk) || b.entryAsk! <= 0 || b.entryAsk! > 1) continue;
    const houseP = p.houseProbs[b.bucketIdx];
    if (!fin(houseP)) continue;
    const m = houseP - b.entryAsk!;
    if (!best || m > best.m) best = { bucketIdx: b.bucketIdx, ask: b.entryAsk!, m };
  }
  if (!best) return { status: 'skipped', reason: 'no_qualifying_tick' };
  if (best.m < ITEM6.minEdge || best.ask > ITEM6.maxAsk) return { status: 'skipped', reason: 'gate_not_cleared' };

  return {
    status: 'bet',
    won: p.n1Winner != null && best.bucketIdx === p.n1Winner,
    ask: best.ask,
    m: best.m,
    bucketIdx: best.bucketIdx,
    city: p.city,
    cluster: p.n1Date, // day-clustered CI: one calendar day (the entry day) = one independence unit
  };
}

export interface Item6Result {
  nPairsTotal: number;
  nNoPreSnapshot: number;
  nNoCoverage: number;
  nNoQualifyingTick: number;
  nGateNotCleared: number;
  nBets: number;
  nCities: number;
  stats: ReturnType<typeof armEdgeStats>;
  clustered: ReturnType<typeof clusterMeanTCi>;
  nClusters: number;
}

/** Reduce all PairOutcomes to the reported bundle. Pure. */
export function summarize(outcomes: PairOutcome[]): Item6Result {
  const bets = outcomes.filter((o): o is Extract<PairOutcome, { status: 'bet' }> => o.status === 'bet');
  const skips = outcomes.filter((o): o is Extract<PairOutcome, { status: 'skipped' }> => o.status === 'skipped');
  const count = (r: PairSkipReason): number => skips.filter((s) => s.reason === r).length;
  const graded: GradedBet[] = bets.map((b) => ({ won: b.won, ask: b.ask }));
  const edgeVals = bets.map((b) => (b.won ? 1 : 0) - b.ask);
  const clusters = bets.map((b) => b.cluster);
  return {
    nPairsTotal: outcomes.length,
    nNoPreSnapshot: count('no_pre_snapshot'),
    nNoCoverage: count('no_coverage'),
    nNoQualifyingTick: count('no_qualifying_tick'),
    nGateNotCleared: count('gate_not_cleared'),
    nBets: bets.length,
    nCities: new Set(bets.map((b) => b.city)).size,
    stats: armEdgeStats(graded),
    clustered: clusterMeanTCi(edgeVals, clusters),
    nClusters: new Set(clusters).size,
  };
}

// =====================================================================================
// DB PULL (SQL prepared against the live schema — one statement, bounded/indexed lookups only)
// =====================================================================================

export interface PullArgs {
  from: string;
  to: string;
  cities?: string[];
}

export async function pullRows(db: Db, args: PullArgs): Promise<RawPairBucketRow[]> {
  const citiesFilter = args.cities && args.cities.length > 0 ? 'and c.slug = any($3::text[])' : '';
  const sql = `
    with sib as (
      select n.id as n_id, n.resolved_at as r_n, n.target_date::text as n_date,
             n1.id as n1_id, n1.target_date::text as n1_date, n1.winning_bucket_idx as n1_winner,
             c.slug as city_slug
        from market_events n
        join market_events n1
          on n1.city_id = n.city_id
         and n1.target_date = n.target_date + 1
         and n1.kind = 'highest' and n1.ladder_ok and n1.winning_bucket_idx is not null
        join cities c on c.id = n.city_id
       where n.kind = 'highest' and n.ladder_ok and n.winning_bucket_idx is not null
         and n.resolved_at is not null
         and n.target_date >= $1::date and n.target_date <= $2::date
         ${citiesFilter}
    ),
    pre as (
      select sib.n1_id, bp.probs, bp.made_at
        from sib
        left join lateral (
          select bp.probs, bp.made_at
            from bucket_probabilities bp
           where bp.event_id = sib.n1_id
             and bp.source = 'house_gaussian'
             and coalesce(bp.seeded, false) = false
             and bp.made_at < sib.r_n
           order by bp.made_at desc
           limit 1
        ) bp on true
    ),
    cov as (
      select sib.n1_id,
             exists (
               select 1 from market_buckets mb
                 join market_snapshots ms on ms.bucket_id = mb.id
                where mb.event_id = sib.n1_id
                  and ms.captured_at >= sib.r_n + make_interval(hours => ${ITEM6.minCoverageHours})
                limit 1
             ) as has_coverage
        from sib
    )
    select sib.n1_id, sib.city_slug, sib.n_date, sib.n1_date, sib.n1_winner,
           pre.probs as house_probs, cov.has_coverage,
           mb.bucket_idx, ea.best_ask as entry_ask
      from sib
      left join pre on pre.n1_id = sib.n1_id
      left join cov on cov.n1_id = sib.n1_id
      join market_buckets mb on mb.event_id = sib.n1_id
      left join lateral (
        select ms.best_ask
          from market_snapshots ms
         where ms.bucket_id = mb.id
           and ms.captured_at >= sib.r_n + make_interval(mins => ${ITEM6.entryOpenMin})
           and ms.captured_at <= sib.r_n + make_interval(hours => ${ITEM6.entryCloseHours})
           and ms.best_ask is not null
         order by ms.captured_at asc
         limit 1
      ) ea on true
     order by sib.n1_id, mb.bucket_idx`;
  const params: unknown[] = [args.from, args.to];
  if (citiesFilter) params.push(args.cities);
  const rows = await db.query<{
    n1_id: string; city_slug: string; n_date: string; n1_date: string; n1_winner: number | null;
    house_probs: unknown; has_coverage: boolean | null; bucket_idx: number; entry_ask: string | number | null;
  }>(sql, params);
  return rows.map((r) => ({
    n1Id: r.n1_id,
    city: r.city_slug,
    nDate: r.n_date,
    n1Date: r.n1_date,
    n1Winner: r.n1_winner,
    houseProbs: Array.isArray(r.house_probs) ? r.house_probs.map(Number) : null,
    hasCoverage: r.has_coverage === true,
    bucketIdx: r.bucket_idx,
    entryAsk: fin(r.entry_ask) ? Number(r.entry_ask) : null,
  }));
}

// =====================================================================================
// REPORT
// =====================================================================================

const pp = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + 'pp' : 'n/a');

export function report(res: Item6Result, args: PullArgs, log: (m: string) => void): void {
  log(`=== ${SCRIPT} ${args.from} → ${args.to} ===`);
  log('');
  log('ITEM 6 — CROSS-HORIZON INFORMATION-PROPAGATION LAG (gate: n>=40 pairs, >=6 cities, edge CI excludes 0):');
  log(`  sibling pairs found: ${res.nPairsTotal}`);
  log(`  skipped — no pre-R_N house_gaussian snapshot: ${res.nNoPreSnapshot}`);
  log(`  skipped — <${ITEM6.minCoverageHours}h price history after R_N: ${res.nNoCoverage}`);
  log(`  skipped — no qualifying tick in [${ITEM6.entryOpenMin}min, ${ITEM6.entryCloseHours}h] window: ${res.nNoQualifyingTick}`);
  log(`  skipped — mispricing/ask gate not cleared (m<${ITEM6.minEdge * 100}pp or ask>${ITEM6.maxAsk}): ${res.nGateNotCleared}`);
  log(`  bets entered: n=${res.nBets}, cities=${res.nCities}`);
  log(`  per-bet edge ${pp(res.stats.edge)} [${pp(res.stats.edgeCiLo)}, ${pp(res.stats.edgeCiHi)}]`);
  log(`  day-clustered edge (${res.nClusters} clusters) ${pp(res.clustered.mean)} [${pp(res.clustered.lo)}, ${pp(res.clustered.hi)}]`);
  if (res.nBets === 0) log('  INSUFFICIENT_DATA (self-reported): zero bets entered — see skip breakdown above.');
}

// =====================================================================================
// SELF-TEST + CLI
// =====================================================================================

function sanity(): void {
  const rows: RawPairBucketRow[] = [
    { n1Id: 'a', city: 'x', nDate: '2026-05-01', n1Date: '2026-05-02', n1Winner: 1, houseProbs: [0.1, 0.6, 0.3], hasCoverage: true, bucketIdx: 0, entryAsk: 0.05 },
    { n1Id: 'a', city: 'x', nDate: '2026-05-01', n1Date: '2026-05-02', n1Winner: 1, houseProbs: [0.1, 0.6, 0.3], hasCoverage: true, bucketIdx: 1, entryAsk: 0.4 },
    { n1Id: 'a', city: 'x', nDate: '2026-05-01', n1Date: '2026-05-02', n1Winner: 1, houseProbs: [0.1, 0.6, 0.3], hasCoverage: true, bucketIdx: 2, entryAsk: 0.3 },
  ];
  const pairs = groupPairRows(rows);
  if (pairs.length !== 1 || pairs[0]!.buckets.length !== 3) throw new Error('sanity: groupPairRows wrong');
  const out = evaluatePair(pairs[0]!);
  // unambiguous max: bucket0 m=0.05, bucket1 m=0.6-0.4=0.20, bucket2 m=0.3-0.3=0 -> bucket1 wins clearly
  if (out.status !== 'bet') throw new Error('sanity: evaluatePair should enter a bet');
  if (out.ask > ITEM6.maxAsk || out.m < ITEM6.minEdge) throw new Error('sanity: gate check wrong');
  if (out.bucketIdx !== 1) throw new Error('sanity: max-m bucket selection wrong');
  if (out.won !== true) throw new Error('sanity: winner check wrong (bucketIdx 1 === n1Winner 1)');

  const noSnap = evaluatePair({ ...pairs[0]!, houseProbs: null });
  if (noSnap.status !== 'skipped' || noSnap.reason !== 'no_pre_snapshot') throw new Error('sanity: no_pre_snapshot wrong');
  const noCov = evaluatePair({ ...pairs[0]!, hasCoverage: false });
  if (noCov.status !== 'skipped' || noCov.reason !== 'no_coverage') throw new Error('sanity: no_coverage wrong');
  const noTick = evaluatePair({ ...pairs[0]!, buckets: pairs[0]!.buckets.map((b) => ({ ...b, entryAsk: null })) });
  if (noTick.status !== 'skipped' || noTick.reason !== 'no_qualifying_tick') throw new Error('sanity: no_qualifying_tick wrong');
  // fresh asks close to each bucket's houseProb so every m stays under the 5pp gate (m: 0.02, -0.01, 0.03)
  const noGate = evaluatePair({
    ...pairs[0]!,
    houseProbs: [0.34, 0.33, 0.33],
    buckets: [{ bucketIdx: 0, entryAsk: 0.32 }, { bucketIdx: 1, entryAsk: 0.34 }, { bucketIdx: 2, entryAsk: 0.3 }],
  });
  if (noGate.status !== 'skipped' || noGate.reason !== 'gate_not_cleared') throw new Error('sanity: gate_not_cleared wrong');

  const summary = summarize([out, noSnap, noCov, noTick, noGate]);
  if (summary.nBets !== 1 || summary.nPairsTotal !== 5) throw new Error('sanity: summarize wrong');
  if (summary.nNoPreSnapshot !== 1 || summary.nNoCoverage !== 1) throw new Error('sanity: summarize breakdown wrong');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      cities: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const db = makeScriptDb();
  try {
    const args: PullArgs = {
      from: values.from ?? '2026-04-21',
      to: values.to ?? '2026-06-29',
      cities: splitList(values.cities),
    };
    const rows = await pullRows(db, args);
    const pairs = groupPairRows(rows);
    const outcomes = pairs.map(evaluatePair);
    const res = summarize(outcomes);
    report(res, args, console.log);
    if (values.json) console.log('JSON ' + JSON.stringify(res));
  } finally {
    await db.end();
  }
}
