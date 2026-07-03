/**
 * scripts/research/maker-exit-ledger-analytics — decompose the corrected-panel maker-exit ledger.
 *
 * Answers three operator questions about WHERE the +6.7% / +$515 backtest PASS comes from
 * (MAKER-EXIT-SIM.md banner), at the pinned MAKER_EXIT_TUNED config over the cached panel:
 *
 *   1. EXIT-KIND decomposition — how much P&L each exit path carries (maker TP / taker SL / time-stop /
 *      resolution), with count, win rate, mean return, total $.
 *   2. MAKER-FILL LATENCY — the distribution of ticks a winning maker sell rested before a bid lifted it
 *      (the cache is 20-min cadence ⇒ ticks ≈ 20-min units; the live loop measures the real-book analogue).
 *   3. PER-CITY attribution — net $ + mean return per city, best/worst, share of total.
 *
 * Cache-only (out/maker-exit-cache.json.gz): no DB, no archive parse. Read-only; writes
 * out/maker-exit-ledger-analytics.md + a RESULT json line. Never imports packages/trading.
 *
 * Run: pnpm tsx scripts/research/maker-exit-ledger-analytics.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCache, cfgFrom, DEFAULT_PARAMS, type SimParams } from './sim-maker-exit.ts';
import { replayMakerExitPanel, type MakerExitTrade } from '../../packages/core/src/sim/opening-maker-exit-replay.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

/** the pinned MAKER_EXIT_TUNED config (MAKER-EXIT-SIM.md §5 — the corrected-archive PASS cell). */
const TUNED: SimParams = { ...DEFAULT_PARAMS, tp: 0.12, sl: 0.2, tstopHours: 18, depth: 150, makerWindow: 30 };

const { events, resolves, meta } = loadCache();
const cities = [...new Set(events.map((e) => e.city))];
const panel = replayMakerExitPanel(events, cfgFrom(TUNED, cities), resolves);
const executed = panel.ledger.filter((t) => t.executed);
const realized = executed.filter((t) => !t.exitKind.startsWith('mtm_'));

const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}` : '—');
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ── 1 · exit-kind decomposition ────────────────────────────────────────────────────────────────────────
interface KindAgg { kind: string; n: number; wins: number; totalUsd: number; meanReturn: number }
const byKind = new Map<string, MakerExitTrade[]>();
for (const t of executed) {
  const arr = byKind.get(t.exitKind) ?? [];
  arr.push(t);
  byKind.set(t.exitKind, arr);
}
const kinds: KindAgg[] = [...byKind.entries()]
  .map(([kind, ts]) => ({
    kind,
    n: ts.length,
    wins: ts.filter((t) => t.netPnlUsd > 0).length,
    totalUsd: ts.reduce((a, t) => a + t.netPnlUsd, 0),
    meanReturn: mean(ts.map((t) => t.netReturn)),
  }))
  .sort((a, b) => b.totalUsd - a.totalUsd);

// ── 2 · maker-fill latency (ticks; 20-min cadence in the cache) ────────────────────────────────────────
const latencies = realized
  .filter((t) => t.isMakerExit && Number.isFinite(t.makerFillLatencyTicks as number))
  .map((t) => t.makerFillLatencyTicks as number)
  .sort((a, b) => a - b);
const q = (p: number): number => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]! : NaN);

// ── 3 · per-city attribution ───────────────────────────────────────────────────────────────────────────
interface CityAgg { city: string; n: number; totalUsd: number; meanReturn: number; winFrac: number }
const byCity = new Map<string, MakerExitTrade[]>();
for (const t of realized) {
  const arr = byCity.get(t.city) ?? [];
  arr.push(t);
  byCity.set(t.city, arr);
}
const cityRows: CityAgg[] = [...byCity.entries()]
  .map(([city, ts]) => ({
    city,
    n: ts.length,
    totalUsd: ts.reduce((a, t) => a + t.netPnlUsd, 0),
    meanReturn: mean(ts.map((t) => t.netReturn)),
    winFrac: ts.filter((t) => t.netPnlUsd > 0).length / ts.length,
  }))
  .sort((a, b) => b.totalUsd - a.totalUsd);
const totalUsd = realized.reduce((a, t) => a + t.netPnlUsd, 0);
const posCities = cityRows.filter((c) => c.totalUsd > 0).length;

const md = [
  `# maker-exit ledger analytics — pinned config over the corrected panel (${new Date().toISOString().slice(0, 10)})`,
  '',
  `Cache: ${meta}`,
  `Executed ${executed.length} · realized ${realized.length} · total realized ${usd(totalUsd)} · makerExitFrac ${pct(panel.makerExitFrac)}`,
  '',
  '## 1 · Exit-kind decomposition (executed trades)',
  '',
  '| exit kind | n | win rate | mean return | total $ |',
  '|---|---|---|---|---|',
  ...kinds.map((k) => `| ${k.kind} | ${k.n} | ${pct(k.wins / k.n)} | ${pct(k.meanReturn)} | ${usd(k.totalUsd)} |`),
  '',
  '## 2 · Maker-fill latency (winning maker sells; ticks ≈ 20-min cache cadence)',
  '',
  latencies.length
    ? `n ${latencies.length} · median ${q(0.5)} ticks (~${q(0.5) * 20} min) · p75 ${q(0.75)} · p90 ${q(0.9)} · max ${latencies[latencies.length - 1]}`
    : 'no maker take-profit fills in the ledger',
  '',
  '## 3 · Per-city attribution (realized)',
  '',
  `${posCities}/${cityRows.length} cities net-positive. Top/bottom 8:`,
  '',
  '| city | n | winFrac | mean return | total $ |',
  '|---|---|---|---|---|',
  ...cityRows.slice(0, 8).map((c) => `| ${c.city} | ${c.n} | ${pct(c.winFrac)} | ${pct(c.meanReturn)} | ${usd(c.totalUsd)} |`),
  '| … | | | | |',
  ...cityRows.slice(-8).map((c) => `| ${c.city} | ${c.n} | ${pct(c.winFrac)} | ${pct(c.meanReturn)} | ${usd(c.totalUsd)} |`),
  '',
].join('\n');

writeFileSync(join(OUT_DIR, 'maker-exit-ledger-analytics.md'), md + '\n');
process.stdout.write(md + '\n');
process.stdout.write(
  `RESULT ${JSON.stringify({
    realized: realized.length,
    totalUsd,
    makerExitFrac: panel.makerExitFrac,
    kinds: kinds.map((k) => ({ kind: k.kind, n: k.n, totalUsd: Math.round(k.totalUsd) })),
    latencyMedianTicks: q(0.5),
    posCities,
    nCities: cityRows.length,
    bestCity: cityRows[0],
    worstCity: cityRows[cityRows.length - 1],
    out: 'scripts/research/out/maker-exit-ledger-analytics.md',
  })}\n`,
);
