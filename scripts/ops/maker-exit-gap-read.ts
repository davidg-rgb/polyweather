/**
 * maker-exit-gap-read.ts — read-only local fallback (MCP-proxy outage) for the backtest-vs-live gap analysis.
 *
 * Pulls the latest maker_exit_panel.view and decomposes the maker-fill-rate collapse (backtest 0.49 → live ~0.065):
 *   - exitKind breakdown over the REALIZED ledger (where did the would-be maker fills go?)
 *   - censoring: open (mtm) vs realized (a young panel censors slow maker fills)
 *   - for OPEN positions: distance of the current mark from the resting TP limit (are they "about to fill"?)
 *   - fill latency + observed spreads (live microstructure vs the backtest)
 *   - tick density proxy (captureRows / freshEvents from the latest job_runs stats)
 * No writes, ever. Run: pnpm tsx scripts/ops/maker-exit-gap-read.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';

type Entry = {
  exitKind: string;
  status: 'realized' | 'open';
  entryPrice: number;
  exitPrice: number;
  netReturn: number;
  isMakerExit: boolean;
  makerFillLatencyTicks: number | null;
  observedEntrySpread: number;
  observedExitSpread: number;
};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
const meanOf = (xs: number[]): number => {
  const f = xs.filter((x) => Number.isFinite(x));
  return f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN;
};
const pct = (x: number) => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a');
const r4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : 'n/a');

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    const rows = await db.query<{ captured_at: string; view: unknown }>(
      `SELECT captured_at, view FROM maker_exit_panel ORDER BY captured_at DESC LIMIT 1`,
    );
    if (!rows.length) {
      console.log('no maker_exit_panel rows');
      return;
    }
    const capturedAt = rows[0]!.captured_at;
    const view = rows[0]!.view as Record<string, any>;
    const entries: Entry[] = Array.isArray(view.entries) ? view.entries : [];
    const money = view.money ?? {};
    const asmp = view.assumptions ?? {};
    const gate = view.gate ?? {};

    console.log(`\n=== maker_exit_panel view @ ${capturedAt} ===`);
    console.log(
      `gate: ${gate.label}  meanNet=${pct(num(gate.meanNetReturn))}  CI=[${pct(num(gate.ciLow))}, ${pct(num(gate.ciHigh))}]  ` +
        `n=${gate.nMarkets}mkts/${gate.nCities}cities/${gate.nDistinctDays}days  winFrac=${r4(num(gate.winFrac))}`,
    );
    console.log(
      `money: nEntries=${money.nEntries}  nRealized=${money.nRealized}  nOpen=${money.nOpen}  ` +
        `(censoring: ${pct((num(money.nOpen) || 0) / Math.max(1, num(money.nEntries) || 1))} of entries still OPEN/mtm)`,
    );
    console.log(
      `assumptions: makerFillRate=${r4(num(asmp.makerFillRate))}  meanFillLatencyTicks=${r4(num(asmp.meanMakerFillLatencyTicks))}  ` +
        `entrySpread=${r4(num(asmp.meanObservedEntrySpread))}  exitSpread=${r4(num(asmp.meanObservedExitSpread))}  ` +
        `qualTickFrac=${r4(num(asmp.qualifyingTickFrac))}`,
    );

    // exitKind breakdown over the REALIZED ledger (the makerFillRate denominator)
    const realized = entries.filter((e) => e.status === 'realized');
    const open = entries.filter((e) => e.status === 'open');
    const byKind = new Map<string, Entry[]>();
    for (const e of realized) {
      const k = e.exitKind;
      (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(e);
    }
    console.log(`\n--- REALIZED exit-kind breakdown (n=${realized.length}) ---`);
    for (const [k, es] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(
        `  ${k.padEnd(18)}  n=${String(es.length).padStart(3)} (${pct(es.length / Math.max(1, realized.length))})  ` +
          `meanNet=${pct(meanOf(es.map((e) => num(e.netReturn))))}  ` +
          `exitSpread=${r4(meanOf(es.map((e) => num(e.observedExitSpread))))}  ` +
          `fillLatTicks=${r4(meanOf(es.map((e) => num(e.makerFillLatencyTicks as number))))}`,
      );
    }

    // CENSORING discriminator: for OPEN positions, how far is the current mark below the resting TP limit?
    // TP limit ≈ entryPrice + 0.12 (tuned tpDeltaPp). distToTp = (entry+0.12) - currentBid(exitPrice mtm mark).
    // Small/negative distToTp on many open positions ⇒ they are "about to fill" (censored maker fills, edge REAL);
    // large distToTp ⇒ drifting away from the limit (edge genuinely absent live).
    const tpDelta = num(view.tpDeltaPp) || 0.12;
    const distToTp = open.map((e) => num(e.entryPrice) + tpDelta - num(e.exitPrice)).filter((x) => Number.isFinite(x));
    const nearTp = distToTp.filter((d) => d <= 0.02).length; // within 2c of lifting
    const aboveTp = distToTp.filter((d) => d <= 0).length; // mark already at/above the limit (would have filled live)
    console.log(`\n--- OPEN/censored positions (n=${open.length}) — distance of current bid to the TP limit (entry+${tpDelta}) ---`);
    console.log(
      `  meanDistToTp=${r4(meanOf(distToTp))}  medianDistToTp=${r4(distToTp.sort((a, b) => a - b)[Math.floor(distToTp.length / 2)] ?? NaN)}  ` +
        `atOrAboveLimit=${aboveTp} (${pct(aboveTp / Math.max(1, open.length))})  within2c=${nearTp} (${pct(nearTp / Math.max(1, open.length))})`,
    );

    // tick-density proxy from the latest job_runs stats
    const jr = await db.query<{ captureRows: string | null; freshEvents: string | null; started_at: string }>(
      `SELECT stats->>'captureRows' AS "captureRows", stats->>'freshEvents' AS "freshEvents", started_at
         FROM job_runs WHERE job='maker-exit-panel' AND status='ok' ORDER BY started_at DESC LIMIT 1`,
    );
    if (jr.length) {
      const cr = Number(jr[0]!.captureRows), fe = Number(jr[0]!.freshEvents);
      console.log(
        `\n--- live tick density (latest ok tick @ ${jr[0]!.started_at}) ---\n  captureRows=${cr}  freshEvents=${fe}  ` +
          `ticks/event≈${Number.isFinite(cr / fe) ? (cr / fe).toFixed(1) : 'n/a'} (20-min-thinned; backtest uses raw bot_capture_series)`,
      );
    }
    console.log('');
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
