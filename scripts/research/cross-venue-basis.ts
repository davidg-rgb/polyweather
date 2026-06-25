/**
 * scripts/research/cross-venue-basis — the EMPIRICAL basis estimator for the cross-venue measurement
 * (CROSS-VENUE-SPIKE.md). The engine's executable edge is basis-adjusted by a BasisModel — the
 * distribution of δ = (Kalshi/NWS-CLI high) − (Polymarket/Wunderground high). v1 ships a conservative
 * research prior (DEFAULT_BASIS_PRIOR); this script REFINES it from data we already capture.
 *
 * METHOD (no external NWS fetch): if each venue prices its own resolution source efficiently, the
 * systematic component of the implied-mean difference (kalshi_mean − poly_mean) IS the basis. So the
 * distribution of round(kalshi_mean − poly_mean) over matched city-days estimates δ. This conflates
 * basis with any persistent mispricing (documented caveat); the gold-standard refinement is the
 * REALIZED (CLI−WU) from each venue's settled outcome, which accrues as captured days resolve.
 *
 * Read-only. Prints the estimated BasisModel as a ready-to-paste literal. Run:
 *   pnpm tsx scripts/research/cross-venue-basis.ts [--days 30]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEFAULT_BASIS_PRIOR, type BasisModel } from '../../packages/core/src/sim/cross-venue-arb.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { Db } from '../lib/backfill.ts';

const num = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

/** Minimum matched city-days before the empirical estimate supersedes the prior. */
export const MIN_BASIS_DAYS = 20;

/**
 * Build a BasisModel from a list of (kalshi_mean − poly_mean) per matched city-day. δ is the NWS-CLI
 * minus Wunderground integer offset; CLI ≥ WU is the documented expectation, so negative δ are clamped
 * to 0 (CLI never resolves below WU in the prior's support — a hot QC adjustment only adds). Returns
 * the prior unchanged when there are too few days. Pure.
 */
export function estimateBasis(meanDiffs: number[], minDays = MIN_BASIS_DAYS): { model: BasisModel; n: number; fromData: boolean } {
  const ds = (Array.isArray(meanDiffs) ? meanDiffs : []).filter((x) => Number.isFinite(x));
  if (ds.length < minDays) return { model: DEFAULT_BASIS_PRIOR, n: ds.length, fromData: false };
  const counts = new Map<number, number>();
  for (const md of ds) {
    const delta = Math.max(0, Math.round(-md)); // δ = CLI − WU = kalshi − poly = −(poly − kalshi); clamp ≥0
    counts.set(delta, (counts.get(delta) ?? 0) + 1);
  }
  const pmf: Record<number, number> = {};
  for (const [d, c] of counts) pmf[d] = c / ds.length;
  return { model: { pmf }, n: ds.length, fromData: true };
}

async function loadMeanDiffs(db: Db, days: number): Promise<number[]> {
  const rows = await db.query<{ mean_diff_f: string | number | null }>(
    `select distinct on (city, target_date) mean_diff_f
     from cross_venue_captures
     where captured_at >= now() - ($1 || ' days')::interval and mean_diff_f is not null
     order by city, target_date, captured_at desc`,
    [String(Math.max(days, 1))],
  );
  return rows.map((r) => Number(r.mean_diff_f)).filter(Number.isFinite);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({ options: { days: { type: 'string' } } });
  const days = num(values.days, 30);
  const db = makeScriptDb();
  try {
    const diffs = await loadMeanDiffs(db, days);
    const { model, n, fromData } = estimateBasis(diffs);
    console.log(`\n=== Cross-venue basis estimate (${days}d, ${n} matched city-days) ===`);
    if (!fromData) {
      console.log(`fewer than ${MIN_BASIS_DAYS} days — using the conservative research prior:`);
    } else {
      console.log('empirical δ = round(kalshi_mean − poly_mean) distribution (CLI − WU, °F):');
    }
    const entries = Object.entries(model.pmf).sort((a, b) => Number(a[0]) - Number(b[0]));
    for (const [d, p] of entries) console.log(`  δ=${d}°F : ${(Number(p) * 100).toFixed(1)}%`);
    console.log('\nBasisModel literal:');
    console.log(`  { pmf: { ${entries.map(([d, p]) => `${d}: ${Number(p).toFixed(3)}`).join(', ')} } }`);
  } finally {
    await db.end();
  }
}
