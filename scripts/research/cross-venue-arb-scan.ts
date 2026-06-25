/**
 * scripts/research/cross-venue-arb-scan — the read side of the cross-venue (Kalshi ↔ Polymarket)
 * relative-value measurement (CROSS-VENUE-SPIKE.md, the 10th-signal candidate). Reads the forward
 * matched panel accumulated by the cross-venue-capture Edge cron (migration 0062, table
 * cross_venue_captures), collapses it to ONE city-day per (city, target_date) = the latest capture,
 * and renders the FROZEN, operator-ratified verdict via the pure engine.
 *
 * The math + the frozen gate live in `packages/core/src/sim/cross-venue-arb.ts` (pure, tested). This
 * spine is only the DB I/O + the report. Read-only. Places nothing. Never imports packages/trading;
 * the live rail stays DORMANT. Run:
 *   pnpm tsx scripts/research/cross-venue-arb-scan.ts [--days 14] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MIN_CITIES,
  MIN_DISTINCT_DAYS,
  MIN_PANEL_DAYS,
  MIN_WIN_FRAC,
  type PanelDay,
  crossVenueVerdict,
} from '../../packages/core/src/sim/cross-venue-arb.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { Db } from '../lib/backfill.ts';

const pct = (v: number, d = 2): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `$${v.toFixed(4)}` : '—');
const num = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);

/** One collapsed matched city-day: the latest capture of each (city, target_date). */
export interface PanelRow extends PanelDay {
  meanDiffF: number;
  maxAbsGap: number;
  direction: string;
  /** TRUE binding executable size (both order books); NaN for non-walked / efficient rows. */
  execSize: number;
}

/** Load the latest capture per (city, target_date) within the look-back window. */
export async function loadPanel(db: Db, days: number): Promise<PanelRow[]> {
  const rows = await db.query<{
    city: string;
    target_date: string | Date;
    best_net_edge: string | number | null;
    has_real_depth: boolean;
    is_executable: boolean;
    exec_size: string | number | null;
    mean_diff_f: string | number | null;
    max_abs_gap: string | number | null;
    direction: string | null;
  }>(
    `select distinct on (city, target_date)
       city, target_date, best_net_edge, has_real_depth, is_executable, exec_size, mean_diff_f, max_abs_gap, direction
     from cross_venue_captures
     where captured_at >= now() - ($1 || ' days')::interval
     order by city, target_date, captured_at desc`,
    [String(Math.max(days, 1))],
  );
  return rows.map((r) => ({
    city: r.city,
    targetDate: String(r.target_date).slice(0, 10),
    netEdge: Number(r.best_net_edge ?? 0),
    hasRealDepth: !!r.has_real_depth,
    // a WIN requires real executable touch depth (the capacity-wall gate), not just a quoted edge
    executable: !!r.is_executable,
    execSize: r.exec_size == null ? NaN : Number(r.exec_size),
    meanDiffF: Number(r.mean_diff_f ?? NaN),
    maxAbsGap: Number(r.max_abs_gap ?? NaN),
    direction: r.direction ?? 'none',
  }));
}

interface CityAgg {
  city: string;
  days: number;
  realDepthDays: number;
  netPosDays: number;
  execWinDays: number;
  maxExecSize: number;
  meanDiffF: number;
  meanAbsGap: number;
  bestEdge: number;
}

function perCity(panel: PanelRow[]): CityAgg[] {
  const by = new Map<string, PanelRow[]>();
  for (const r of panel) (by.get(r.city) ?? by.set(r.city, []).get(r.city)!).push(r);
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : NaN);
  return [...by.entries()]
    .map(([city, rs]) => {
      const depthRows = rs.filter((r) => r.hasRealDepth);
      const netPos = depthRows.filter((r) => r.netEdge > 0);
      return {
        city,
        days: rs.length,
        realDepthDays: depthRows.length,
        netPosDays: netPos.length, // QUOTED net-positive
        execWinDays: netPos.filter((r) => r.executable).length, // real EXECUTABLE wins
        maxExecSize: netPos.length ? Math.max(...netPos.map((r) => r.execSize).filter(Number.isFinite), 0) : NaN,
        meanDiffF: mean(rs.map((r) => r.meanDiffF).filter(Number.isFinite)),
        meanAbsGap: mean(rs.map((r) => r.maxAbsGap).filter(Number.isFinite)),
        // headline best edge over REAL-DEPTH rows only (a thin-book edge is not executable — phantom-Denver class)
        bestEdge: depthRows.length ? Math.max(...depthRows.map((r) => r.netEdge)) : NaN,
      };
    })
    .sort((a, b) => a.city.localeCompare(b.city));
}

export function buildReport(panel: PanelRow[], days: number): { lines: string[]; json: unknown } {
  const lines: string[] = [];
  const P = (s = ''): void => void lines.push(s);
  const verdict = crossVenueVerdict(panel);
  const cities = perCity(panel);

  P('');
  P('=== Cross-venue (Kalshi ↔ Polymarket) relative-value scan — the 10th signal ===');
  P(`generated ${new Date().toISOString()} · window ${days}d`);
  P(`${panel.length} matched city-days (latest capture per city+date) · ${cities.length} cities`);
  P('');
  P('THE DESCRIPTIVE DIVERGENCE (analytics — always exists, even with no profit):');
  P('  city           days  realDepth  netPos  execWin  maxExec  meanDiff°F  meanKSgap   bestNetEdge');
  for (const c of cities) {
    P(
      `  ${c.city.padEnd(14).slice(0, 14)} ${String(c.days).padStart(4)}  ${String(c.realDepthDays).padStart(9)}  ` +
        `${String(c.netPosDays).padStart(6)}  ${String(c.execWinDays).padStart(7)}  ${(Number.isFinite(c.maxExecSize) ? c.maxExecSize.toFixed(0) : '—').padStart(7)}  ` +
        `${(Number.isFinite(c.meanDiffF) ? c.meanDiffF.toFixed(2) : '—').padStart(10)}  ` +
        `${pct(c.meanAbsGap).padStart(9)}  ${usd(c.bestEdge).padStart(11)}`,
    );
  }
  P('');
  P('THE EXECUTABLE, BASIS-ADJUSTED EDGE (the gate input — real-depth city-days only):');
  P(`  real-depth city-days: ${verdict.nDepthDays}  ·  ${verdict.nCities} cities  ·  ${verdict.nDistinctDays} distinct dates`);
  P(`  QUOTED net-positive:    ${cities.reduce((a, c) => a + c.netPosDays, 0)} city-days`);
  P(`  EXECUTABLE wins:        ${cities.reduce((a, c) => a + c.execWinDays, 0)} city-days  (binding touch depth ≥ MIN_EXEC_SIZE on BOTH books)`);
  P(`  win fraction (executable):  ${pct(verdict.winFrac)}  (bar ≥ ${pct(MIN_WIN_FRAC)})`);
  P(`  city-clustered mean edge: ${usd(verdict.meanNetEdge)}  95% CI [${usd(verdict.ciLow)}, ${usd(verdict.ciHigh)}]`);
  P('');
  P(`VERDICT (frozen gate: ≥${MIN_PANEL_DAYS} rows, ≥${MIN_CITIES} cities, ≥${MIN_DISTINCT_DAYS} dates):  ${verdict.label}`);
  P(`  ${verdict.reason}`);

  return { lines, json: { generatedAt: new Date().toISOString(), windowDays: days, panelDays: panel.length, verdict, perCity: cities } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({ options: { days: { type: 'string' }, json: { type: 'boolean' }, out: { type: 'string' } } });
  const days = num(values.days, 14);
  const db = makeScriptDb();
  try {
    process.stderr.write(`loading cross-venue matched panel (${days}d)…\n`);
    const panel = await loadPanel(db, days);
    process.stderr.write(`  ${panel.length} matched city-days\n`);
    const { lines, json } = buildReport(panel, days);
    console.log(lines.join('\n'));
    const outPath = values.out ?? 'scripts/research/out/cross-venue-arb-scan.json';
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(json, null, 2));
    writeFileSync(outPath.replace(/\.json$/, '.md'), lines.join('\n'));
    if (values.json) console.log('\nJSON ' + JSON.stringify(json));
    process.stderr.write(`\nwrote ${outPath} (+ .md)\n`);
  } finally {
    await db.end();
  }
}
