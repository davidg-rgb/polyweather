/**
 * scripts/research/calibrate-history-spread — fit the synthetic-book model (CALIBRATED_BOOK in
 * core/sim/history-replay-ingest.ts) from the LIVE `opening_captures` real books. The price-history archive is
 * MID-ONLY; to replay the bracket strategy on it we synthesize a two-sided book from the mid, and THIS is where
 * the spread + depth come from — the median execAsk−mid, mid−execBid, and depthUsd by mid price-band over the
 * real captured books (so the synth is grounded in the live microstructure, not guessed).
 *
 * It PRINTS the fitted knots (paste into CALIBRATED_BOOK) and, when --check is passed, diffs them against the
 * committed model so drift is visible in CI/manual review. Read-only; writes nothing. Re-run after a structural
 * book change (a fee/tick change, a liquidity-program change); a pure price drift does NOT require a re-fit.
 *
 * Run: pnpm tsx scripts/research/calibrate-history-spread.ts            # print the fitted knots
 *      pnpm tsx scripts/research/calibrate-history-spread.ts --days 7   # wider capture window
 *      pnpm tsx scripts/research/calibrate-history-spread.ts --check    # diff vs the committed CALIBRATED_BOOK
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { CALIBRATED_BOOK, type BookKnot } from '../../packages/core/src/sim/history-replay-ingest.ts';

export const SCRIPT = 'calibrate-history-spread';

/** The mid-band knot centers the fit reports (the entry-relevant zone is densely sampled, the deep tail coarse). */
export const KNOT_MIDS = [0.07, 0.12, 0.17, 0.23, 0.27, 0.33, 0.37, 0.43, 0.48];

/** Pull the per-band median ask-over-mid, mid-over-bid, and depth from the live books. */
export async function fitKnots(db: ScriptDb, days: number, limit: number): Promise<BookKnot[]> {
  const rows = await db.query<Record<string, unknown>>(
    `with sampled as (
       select buckets from public.opening_captures
       where captured_at > now() - ($1 || ' days')::interval
       order by captured_at desc limit $2
     ),
     b as (
       select (x->>'mid')::numeric mid, (x->>'execAsk')::numeric exec_ask,
              (x->>'execBid')::numeric exec_bid, (x->>'depthUsd')::numeric depth
       from sampled, lateral jsonb_array_elements(buckets) x
     )
     select width_bucket(mid, 0, 0.5, 10) band,
            round(avg(mid),4) avg_mid,
            round((percentile_cont(0.5) within group (order by exec_ask - mid))::numeric,4) ask_over,
            round((percentile_cont(0.5) within group (order by mid - exec_bid))::numeric,4) bid_over,
            round((percentile_cont(0.5) within group (order by depth))::numeric,0) depth
       from b
      where mid is not null and mid > 0.04 and mid < 0.5 and exec_ask is not null and exec_bid is not null
      group by band order by band`,
    [Math.max(1, Math.floor(days)), Math.max(1000, Math.floor(limit))],
  );
  // map each modeled knot center to the nearest sampled band's medians
  const sampled = rows.map((r) => ({
    avgMid: Number(r['avg_mid']), askOver: Number(r['ask_over']), bidOver: Number(r['bid_over']), depth: Number(r['depth']),
  })).filter((s) => Number.isFinite(s.avgMid));
  return KNOT_MIDS.map((mid) => {
    let nearest = sampled[0];
    let best = Infinity;
    for (const s of sampled) {
      const d = Math.abs(s.avgMid - mid);
      if (d < best) { best = d; nearest = s; }
    }
    return {
      mid,
      askOver: nearest ? Math.max(0, nearest.askOver) : 0.01,
      bidOver: nearest ? Math.max(0, nearest.bidOver) : 0.01,
      depthUsd: nearest ? Math.max(0, nearest.depth) : 0,
    };
  });
}

export function printKnots(knots: BookKnot[], log: (m: string) => void): void {
  log('export const CALIBRATED_BOOK: BookModel = [');
  for (const k of knots) {
    log(`  { mid: ${k.mid}, askOver: ${k.askOver}, bidOver: ${k.bidOver}, depthUsd: ${Math.round(k.depthUsd)} },`);
  }
  log('];');
}

/** Diff fitted vs committed; returns the knots whose any field moved more than `tol` (relative for depth). */
export function driftedKnots(fit: BookKnot[], committed: BookKnot[], tol = 0.5): string[] {
  const out: string[] = [];
  for (const f of fit) {
    const c = committed.find((k) => Math.abs(k.mid - f.mid) < 1e-9);
    if (!c) { out.push(`mid ${f.mid}: missing in committed`); continue; }
    const spreadMoved = Math.abs(f.askOver - c.askOver) > 0.01 || Math.abs(f.bidOver - c.bidOver) > 0.01;
    const depthMoved = c.depthUsd > 0 ? Math.abs(f.depthUsd - c.depthUsd) / c.depthUsd > tol : f.depthUsd > 50;
    if (spreadMoved || depthMoved) {
      out.push(`mid ${f.mid}: ask ${c.askOver}→${f.askOver} bid ${c.bidOver}→${f.bidOver} depth ${c.depthUsd}→${f.depthUsd}`);
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({ options: { days: { type: 'string' }, limit: { type: 'string' }, check: { type: 'boolean' } } });
  const days = Math.max(1, Math.floor(Number(values.days ?? 4) || 4));
  const limit = Math.max(1000, Math.floor(Number(values.limit ?? 8000) || 8000));
  const db = makeScriptDb();
  try {
    process.stderr.write(`${SCRIPT} · fitting from opening_captures (last ${days}d, ${limit} rows) — read-only\n\n`);
    const knots = await fitKnots(db, days, limit);
    printKnots(knots, console.log);
    if (values.check) {
      const drift = driftedKnots(knots, CALIBRATED_BOOK);
      console.log('');
      if (drift.length === 0) console.log('✓ committed CALIBRATED_BOOK is within tolerance of the live fit.');
      else { console.log('⚠ committed CALIBRATED_BOOK has drifted — review:'); for (const d of drift) console.log(`  ${d}`); }
    }
  } finally {
    await db.end();
  }
}
