/**
 * maker-exit-realbook-sweep.ts — the HONEST re-tune: sweep the maker-exit config over the REAL captured book
 * (not the synthetic house_gaussian book sim-maker-exit.ts uses), to answer the operator's question directly:
 * "the backtest was +6.7% on a synthetic book; the live gate is −12.6% on the real book — can ANY config recover
 * a real-book edge?"
 *
 * Mechanism (established 2026-07-06): the +6.7% backtest replays against a book CENTERED on the calibrated
 * house_gaussian forecast (tune-convergence.ts buildSet → synthetic bid = seed ± calibrated spread), which
 * converges to truth by construction. The live §9R-E gate replays the REAL Polymarket book (convergence_capture_
 * inputs, real execBid), which is efficient and does NOT converge to our forecast → 87% of positions run to the
 * taker time-stop at −13.4%, maker-fill 6.5% vs the synthetic 49%. The pinned tp0.12/sl0.20/tstop18h optimum was
 * fit on the synthetic book; this sweep re-optimizes tp / tpMode / sl / tstop on the REAL book the gate sees.
 *
 * READ-ONLY (identical DATABASE_URL path as gate-read.ts). Pulls the SAME per-city convergence_capture_inputs the
 * maker-exit-panel edge fn pulls, then replays buildMakerExitView across a config grid in-memory. No writes, no
 * capital, no live config change. Run: pnpm tsx scripts/research/maker-exit-realbook-sweep.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { buildMakerExitView } from '../../packages/core/src/sim/opening-maker-exit-view.ts';
import { makerExitCfg, type MakerExitCfg } from '../../packages/core/src/sim/opening-maker-exit-replay.ts';
import { BOT_DEFAULTS, parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';
import type { RawCaptureRow } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { RawResolution } from '../../packages/core/src/sim/opening-convergence-view.ts';

const PANEL_DAYS = 14; // lighter per-city query than the gate's 21 (still covers every resolved market — they settle within ~2d)
const FETCH_CONCURRENCY = 1; // SEQUENTIAL — the Micro DB self-contends under any concurrency (the same wall starving the gate)
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1).padStart(6) + '%' : '    n/a');
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : 'n/a');

type CaptureInputs = { captures: RawCaptureRow[]; resolutions: RawResolution[] };

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    // the panel scope = the live bot.cities capture universe (same as the edge fn parseBotConfig path); fall back
    // to BOT_DEFAULTS. Query all config rows and let the authoritative parser extract .cities.
    let cities = BOT_DEFAULTS.cities as string[];
    try {
      const cfgRows = await db.query<{ key: string; value: string | null }>(`SELECT key, value::text AS value FROM config`);
      const parsed = parseBotConfig(cfgRows).cities;
      if (Array.isArray(parsed) && parsed.length) cities = parsed;
    } catch (e) { console.error(`  [warn] config read failed, using BOT_DEFAULTS.cities: ${e instanceof Error ? e.message : String(e)}`); }
    process.stderr.write(`scope: ${cities.length} cities\n`);

    // pull the REAL captured book per city (bounded), exactly the maker-exit-panel inputs.
    const captures: RawCaptureRow[] = [];
    const resolutions: RawResolution[] = [];
    let cityErrors = 0;
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= cities.length) return;
        const city = cities[i]!;
        let ok = false;
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            const t0 = Date.now();
            const rows = await db.query<{ r: CaptureInputs }>(
              `SELECT convergence_capture_inputs($1, $2) AS r`,
              [PANEL_DAYS, [city]],
            );
            const inp = rows[0]?.r ?? { captures: [], resolutions: [] };
            const n = Array.isArray(inp.captures) ? inp.captures.length : 0;
            if (Array.isArray(inp.captures)) captures.push(...inp.captures);
            if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
            process.stderr.write(`  [${i + 1}/${cities.length}] ${city}: ${n} rows (${Date.now() - t0}ms)\n`);
            ok = true;
          } catch (e) {
            if (attempt === 1) { cityErrors++; console.error(`  [warn] ${city}: ${e instanceof Error ? e.message : String(e)}`); }
          }
        }
      }
    };
    process.stderr.write(`fetching real book for ${cities.length} cities (${FETCH_CONCURRENCY}-way)…\n`);
    await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));
    process.stderr.write(`  captureRows=${captures.length}  resolutions=${resolutions.length}  cityErrors=${cityErrors}\n\n`);

    // the config grid — the two real-book hypotheses:
    //   (a) a LOWER TP fills more often (the resting sell sits closer to entry);
    //   (b) a LONGER hold (smaller tstopHoursBeforeResolve = flatten closer to resolution) gives real convergence
    //       more time; plus the tpMode variants (absolute convergence target / our forecast prob).
    type Cell = { label: string; over: Partial<MakerExitCfg> };
    const cells: Cell[] = [];
    for (const tstop of [24, 18, 12, 6]) {
      for (const tp of [0.12, 0.10, 0.08, 0.06, 0.04, 0.02]) {
        cells.push({ label: `delta tp+${tp} tstop${tstop}`, over: { tpMode: 'delta', tpDeltaPp: tp, tstopHoursBeforeResolve: tstop } });
      }
    }
    for (const tstop of [18, 6]) {
      cells.push({ label: `model    tstop${tstop}`, over: { tpMode: 'model', tstopHoursBeforeResolve: tstop } });
      cells.push({ label: `abs 0.25 tstop${tstop}`, over: { tpMode: 'abs', tpAbsTarget: 0.25, tstopHoursBeforeResolve: tstop } });
    }
    // a wider stop too (does letting it breathe past −20pp help, or just deepen losses?)
    for (const sl of [0.12, 0.30]) cells.push({ label: `delta tp+0.12 sl${sl} tstop18`, over: { tpMode: 'delta', tpDeltaPp: 0.12, slDeltaPp: sl, tstopHoursBeforeResolve: 18 } });

    console.log(`REAL-BOOK maker-exit re-tune sweep — ${cities.length} cities / ${PANEL_DAYS}d window (the live gate's data)`);
    console.log(`baseline (pinned tp0.12/sl0.20/tstop18) is the first row.\n`);
    console.log(
      `${'config'.padEnd(30)}${'nMkt'.padStart(6)}${'fill'.padStart(8)}${'meanNet'.padStart(9)}` +
        `${'ciLow'.padStart(9)}${'ciHigh'.padStart(9)}${'win'.padStart(7)}  label`,
    );
    const results: { label: string; ciLow: number; meanNet: number; fill: number; n: number; verdict: string }[] = [];
    for (const c of cells) {
      const cfg = makerExitCfg(cities, c.over);
      const v = buildMakerExitView(captures, resolutions, cfg);
      const g = v.gate;
      results.push({ label: c.label, ciLow: g.ciLow, meanNet: g.meanNetReturn, fill: v.assumptions.makerFillRate, n: g.nMarkets, verdict: g.label });
      console.log(
        `${c.label.padEnd(30)}${String(g.nMarkets).padStart(6)}${r3(v.assumptions.makerFillRate).padStart(8)}` +
          `${pct(g.meanNetReturn)}${pct(g.ciLow)}${pct(g.ciHigh)}${r3(g.winFrac).padStart(7)}  ${g.label}`,
      );
    }

    const positive = results.filter((r) => r.ciLow > 0);
    const bestMean = [...results].sort((a, b) => b.meanNet - a.meanNet)[0];
    console.log(`\n=== verdict ===`);
    if (positive.length) {
      console.log(`  ${positive.length} config(s) clear ciLow>0 on the REAL book (a genuine lever — needs OOS re-validation):`);
      for (const p of positive.sort((a, b) => b.ciLow - a.ciLow)) console.log(`    ${p.label}: meanNet ${pct(p.meanNet)}, ciLow ${pct(p.ciLow)}, fill ${r3(p.fill)}`);
    } else {
      console.log(`  NO config clears ciLow>0 on the real book. Best mean-net cell: "${bestMean?.label}" at ${pct(bestMean?.meanNet ?? NaN)} (fill ${r3(bestMean?.fill ?? NaN)}).`);
      console.log(`  → the +6.7% lived only on the SYNTHETIC (forecast-centered) book; the real book has no maker-exit edge at any tested config.`);
    }
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
