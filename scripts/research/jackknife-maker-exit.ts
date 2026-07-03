/**
 * scripts/research/jackknife-maker-exit — robustness of the corrected-archive §9R-E backtest PASS.
 *
 * The 2026-07-03 headline (MAKER-EXIT-SIM.md banner) rests on ciLow = +0.3% — a thin margin. This script
 * measures how much of that PASS is carried by any single city or any single target date:
 *
 *   1. BASELINE — the pinned MAKER_EXIT_TUNED config over the full cached panel, with the frozen verdict AND
 *      the opt-in DAY-BLOCK tightening (VerdictOpts.dayBlockNull) reported side by side.
 *   2. LOCO — leave-one-CITY-out: re-replay with each city excluded; report the verdict deltas, worst-first.
 *   3. LODO — leave-one-DATE-out: same across target dates.
 *
 * Loads the local sim cache ONCE (out/maker-exit-cache.json.gz — no DB, no archive parse) and replays
 * in-memory, so the ~65 exclusion runs take seconds, not process spawns. Read-only; writes only
 * out/jackknife-maker-exit.md + a RESULT json line. Never imports packages/trading.
 *
 * CLI (SIGNAL-BACKLOG.md #5 amended spec, 2026-07-03): --chw <N> overrides centerHalfWidth on the pinned
 * config (basket sizes >1 need a candidate set wider than the mode-only default); --basket-size <N>
 * dispatches to replayMakerExitPanelBasket (mirrors sim-maker-exit.ts's run() dispatch — 1 = the historical
 * single-bucket engine); --out <path> overrides the report destination. No flags = today's exact behavior.
 *
 * Run: pnpm tsx scripts/research/jackknife-maker-exit.ts
 *      pnpm tsx scripts/research/jackknife-maker-exit.ts --chw 1 --basket-size 2 --out scripts/research/out/jackknife-maker-exit-basket2.md
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadCache, cfgFrom, DEFAULT_PARAMS, type SimParams } from './sim-maker-exit.ts';
import { replayMakerExitPanel, replayMakerExitPanelBasket } from '../../packages/core/src/sim/opening-maker-exit-replay.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { OpeningVerdict } from '../../packages/core/src/sim/opening-convergence.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');

// ── CLI: --chw / --basket-size / --out (SIGNAL-BACKLOG.md #5 amended spec) — no flags = today's behavior. ──
const { values: cliArgs } = parseArgs({
  options: { chw: { type: 'string' }, 'basket-size': { type: 'string' }, out: { type: 'string' } },
});
const num = (k: 'chw' | 'basket-size', d: number): number => {
  const v = cliArgs[k];
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : d;
};
const OUT_PATH = cliArgs.out ?? join(OUT_DIR, 'jackknife-maker-exit.md');
const OUT_LABEL = cliArgs.out ?? 'scripts/research/out/jackknife-maker-exit.md';

/** the pinned MAKER_EXIT_TUNED config (MAKER-EXIT-SIM.md §5 — the corrected-archive PASS cell), with the
 *  optional --chw / --basket-size CLI overrides (default: chw 0 / basket 1, identical to the pinned config). */
const TUNED: SimParams = {
  ...DEFAULT_PARAMS, tp: 0.12, sl: 0.2, tstopHours: 18, depth: 150, makerWindow: 30,
  chw: num('chw', DEFAULT_PARAMS.chw), basketSize: num('basket-size', DEFAULT_PARAMS.basketSize),
};

interface JackRow {
  held: string;
  n: number;
  label: string;
  mean: number;
  ciLow: number;
  ciHigh: number;
  zsp: number;
}

function replay(
  events: EventReplayInput[],
  resolves: Map<string, number | null>,
  dayBlockNull: boolean,
): OpeningVerdict {
  const cities = [...new Set(events.map((e) => e.city))];
  const cfg = cfgFrom(TUNED, cities);
  const opts = dayBlockNull ? { dayBlockNull: true } : {};
  // mirrors sim-maker-exit.ts's run() dispatch: basketSize>1 → the basket engine, else the historical single-bucket path.
  return TUNED.basketSize > 1
    ? replayMakerExitPanelBasket(events, cfg, resolves, opts).verdict
    : replayMakerExitPanel(events, cfg, resolves, opts).verdict;
}

const pct = (v: number | undefined, d = 1): string => (v != null && Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');

function jackknife(
  events: EventReplayInput[],
  resolves: Map<string, number | null>,
  keyOf: (e: EventReplayInput) => string,
): JackRow[] {
  const keys = [...new Set(events.map(keyOf))].sort();
  return keys
    .map((k) => {
      const kept = events.filter((e) => keyOf(e) !== k);
      const v = replay(kept, resolves, false);
      return { held: k, n: v.nMarkets, label: v.label, mean: v.meanNetReturn, ciLow: v.ciLow, ciHigh: v.ciHigh, zsp: v.zeroSkillPassRate };
    })
    .sort((a, b) => (Number.isFinite(a.ciLow) ? a.ciLow : Infinity) - (Number.isFinite(b.ciLow) ? b.ciLow : Infinity));
}

const { events, resolves, meta } = loadCache();

// 1 · baseline: the frozen verdict + the opt-in day-block tightening side by side.
const frozen = replay(events, resolves, false);
const tightened = replay(events, resolves, true);

// 2/3 · LOCO + LODO under the FROZEN verdict (the gate of record — the tightening is reported, not applied).
const loco = jackknife(events, resolves, (e) => e.city);
const lodo = jackknife(events, resolves, (e) => e.targetDate);

const flips = (rows: JackRow[]): JackRow[] => rows.filter((r) => r.label !== 'PASS');
const fmt = (r: JackRow): string =>
  `| ${r.held} | ${r.n} | ${r.label} | ${pct(r.mean)} | [${pct(r.ciLow)}, ${pct(r.ciHigh)}] | ${pct(r.zsp)} |`;

const md = [
  `# jackknife — maker-exit corrected-archive PASS robustness (${new Date().toISOString().slice(0, 10)})`,
  '',
  `Cache: ${meta}`,
  `Pinned config: tp ${TUNED.tp} / sl ${TUNED.sl} / tstop ${TUNED.tstopHours}h / chw ${TUNED.chw} / maxEntry ${TUNED.maxEntry} / depth $${TUNED.depth} / makerWindow ${TUNED.makerWindow} / rebate ${TUNED.rebate}` +
    (TUNED.basketSize > 1 ? ` / basket ${TUNED.basketSize}` : ''),
  '',
  '## Baseline',
  '',
  `- FROZEN gate: **${frozen.label}** — n ${frozen.nMarkets} / ${frozen.nCities} cities / ${frozen.nDistinctDays} days · mean ${pct(frozen.meanNetReturn)} · CI [${pct(frozen.ciLow)}, ${pct(frozen.ciHigh)}] · zsp ${pct(frozen.zeroSkillPassRate)}`,
  `- DAY-BLOCK tightening (opt-in, reported): **${tightened.label}** — day-clustered CI [${pct(tightened.dayBlockCiLow)}, ${pct(tightened.dayBlockCiHigh)}] · day-flip MC ${pct(tightened.zeroSkillPassRateDayBlock)}`,
  '',
  `## Leave-one-CITY-out (${loco.length} runs, worst ciLow first) — ${flips(loco).length} flip(s) off PASS`,
  '',
  '| held-out | n | label | mean | 95% CI | zsp |',
  '|---|---|---|---|---|---|',
  ...loco.map(fmt),
  '',
  `## Leave-one-DATE-out (${lodo.length} runs, worst ciLow first) — ${flips(lodo).length} flip(s) off PASS`,
  '',
  '| held-out | n | label | mean | 95% CI | zsp |',
  '|---|---|---|---|---|---|',
  ...lodo.map(fmt),
  '',
].join('\n');

writeFileSync(OUT_PATH, md + '\n');
process.stdout.write(md + '\n');
process.stdout.write(
  `RESULT ${JSON.stringify({
    baseline: { label: frozen.label, ciLow: frozen.ciLow, ciHigh: frozen.ciHigh, mean: frozen.meanNetReturn, n: frozen.nMarkets },
    dayBlock: {
      label: tightened.label,
      dayCiLow: tightened.dayBlockCiLow,
      dayCiHigh: tightened.dayBlockCiHigh,
      zspDay: tightened.zeroSkillPassRateDayBlock,
    },
    locoFlips: flips(loco).map((r) => r.held),
    lodoFlips: flips(lodo).map((r) => r.held),
    locoWorst: loco[0],
    lodoWorst: lodo[0],
    out: OUT_LABEL,
  })}\n`,
);
