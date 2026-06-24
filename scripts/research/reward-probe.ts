/**
 * scripts/research/reward-probe — REC-9: the minimal real-money liquidity-reward PROBE driver
 * (REWARD-FARMING-HANDOFF.md §9). The REC-8 first-pass PASS is load-bearing on the advertised
 * `rewards_daily_rate` being PAID; this probe settles it empirically with ~$50 instead of more modeling.
 *
 *   --mode plan       Pull the live funded-weather universe, pick the top-N markets by predicted reward,
 *                     and emit the EXACT order list (market, token, prices, min_size, capital) + the
 *                     model's prediction. Writes out/reward-probe-plan.json + a markdown order sheet.
 *                     NOTHING is placed — the live rail stays DORMANT. The operator funds + rests these
 *                     orders manually (RUNBOOK "REC-9 reward probe"), then records actuals after 24h.
 *
 *   --mode reconcile  Read the saved plan + out/reward-probe-actuals.json (operator-filled: the ACTUAL
 *                     USDC reward paid per market over 24h, optional fills), score actual vs. predicted,
 *                     and print the ground-truth verdict (GROUND_TRUTH_CONFIRMS / OVER_ADVERTISED /
 *                     INCONCLUSIVE) — the §9 "real-but-ephemeral vs. artifact" decider.
 *
 * Read-only/public for `plan`; `reconcile` reads only local files. No `packages/trading` import; no money
 * moves from this code. Pure brain in core/sim/reward-probe.ts (tested). Run:
 *   pnpm tsx scripts/research/reward-probe.ts --mode plan [--n 3] [--offset 1] [--min-pool 5]
 *   pnpm tsx scripts/research/reward-probe.ts --mode reconcile
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  type ProbeActual,
  type ProbePlan,
  buildProbePlan,
  scoreProbe,
} from '../../packages/core/src/sim/reward-probe.ts';
import { buildUniverse } from './reward-farming-firstpass.ts';

const OUT_DIR = 'scripts/research/out';
const PLAN_PATH = `${OUT_DIR}/reward-probe-plan.json`;
const ACTUALS_PATH = `${OUT_DIR}/reward-probe-actuals.json`;
const SHEET_PATH = `${OUT_DIR}/reward-probe-order-sheet.md`;
const SCORE_PATH = `${OUT_DIR}/reward-probe-score.md`;

const usd = (v: number, d = 2): string => (Number.isFinite(v) ? `$${v.toFixed(d)}` : '—');
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');

const writeFile = (p: string, s: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, s);
};

/** Build the live plan and persist it + a human order sheet. */
export async function runPlan(
  opts: { nMarkets: number; offsetCents: number; minPool: number; maxPages: number; tax: number; phi: number; minHours: number },
  log: (m: string) => void,
): Promise<ProbePlan> {
  const inputs = await buildUniverse({ maxPages: opts.maxPages, minPool: opts.minPool, limit: 0 }, log);
  const plan = buildProbePlan(inputs, {
    nMarkets: opts.nMarkets,
    offsetCents: opts.offsetCents,
    minPoolUsd: opts.minPool,
    nowSec: Math.floor(Date.now() / 1000),
    minHoursToResolution: opts.minHours,
    params: { adverseTaxPerDollar: opts.tax, fillFraction: opts.phi },
  });
  writeFile(PLAN_PATH, JSON.stringify(plan, null, 2));

  const L: string[] = [];
  L.push('# REC-9 reward-farming PROBE — order sheet (forecast-free, ~$' + plan.totalCapitalUsd.toFixed(0) + ' at risk)');
  L.push('');
  L.push(`Rest each as a **resting maker** order and leave it live for 24h. Strict-two-sided markets (mid<0.10) earn NOTHING unless BOTH legs are live. After 24h, record the ACTUAL reward earned per market into \`${ACTUALS_PATH}\` and run \`--mode reconcile\`.`);
  L.push('');
  L.push('| # | market | mid | rest BID @ | rest ASK @ | size (shares) | capital | pred. reward/day | ~hrs left | strict 2-sided |');
  L.push('|--:|---|--:|--:|--:|--:|--:|--:|--:|:-:|');
  plan.targets.forEach((t, i) => {
    L.push(
      `| ${i + 1} | ${t.slug} | ${t.mid.toFixed(3)} | ${t.bidPx.toFixed(3)} | ${t.askPx.toFixed(3)} | ${t.sizeShares} | ${usd(t.capitalUsd)} | ${usd(t.predictedDailyRewardUsd, 3)} | ${Number.isFinite(t.hoursToResolution) ? t.hoursToResolution.toFixed(0) : '—'} | ${t.strictTwoSided ? 'YES' : 'no'} |`,
    );
  });
  L.push('');
  L.push(`**Totals:** ${plan.nMarkets} markets · capital ${usd(plan.totalCapitalUsd)} · predicted reward ${usd(plan.totalPredictedRewardUsd, 2)}/day · predicted net ${usd(plan.totalPredictedNetUsd, 2)}/day.`);
  L.push('');
  L.push('**condition_ids (for the actuals ledger):**');
  for (const t of plan.targets) L.push(`- \`${t.conditionId}\` — ${t.slug}`);
  L.push('');
  L.push('> If actual reward lands near predicted → the pools pay as advertised (REC-8 PASS was real → scale up). If it is a small fraction → over-advertised (PASS was an artifact; rail stays dormant). That is the whole point of the $' + plan.totalCapitalUsd.toFixed(0) + '.');
  writeFile(SHEET_PATH, L.join('\n'));

  log('');
  log('=== REC-9 PROBE PLAN (nothing placed — rail DORMANT) ===');
  for (const line of L.slice(4)) log(line);
  log('');
  log(`Plan JSON → ${PLAN_PATH}`);
  log(`Order sheet → ${SHEET_PATH}`);
  log(`Next: fund ~${usd(plan.totalCapitalUsd, 0)}, rest the orders above, wait 24h, fill ${ACTUALS_PATH}, run --mode reconcile.`);
  return plan;
}

/** A starter actuals ledger so the operator just fills in the numbers. */
function writeActualsTemplate(plan: ProbePlan, log: (m: string) => void): void {
  if (existsSync(ACTUALS_PATH)) return;
  const template: ProbeActual[] = plan.targets.map((t) => ({
    conditionId: t.conditionId,
    actualRewardUsd: 0,
    actualFilledNotionalUsd: 0,
    actualFillPnlUsd: 0,
  }));
  writeFile(ACTUALS_PATH, JSON.stringify(template, null, 2));
  log(`Wrote a starter actuals ledger → ${ACTUALS_PATH} (fill actualRewardUsd after 24h).`);
}

/** Read the saved plan + the operator-filled actuals and print the ground-truth verdict. */
export function runReconcile(log: (m: string) => void): void {
  if (!existsSync(PLAN_PATH)) {
    log(`No plan at ${PLAN_PATH} — run \`--mode plan\` first.`);
    return;
  }
  const plan = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as ProbePlan;
  if (!existsSync(ACTUALS_PATH)) {
    writeActualsTemplate(plan, log);
    log('Fill the actual reward earned per market (from your Polymarket portfolio → rewards), then re-run.');
    return;
  }
  const actuals = JSON.parse(readFileSync(ACTUALS_PATH, 'utf8')) as ProbeActual[];
  const score = scoreProbe(plan, actuals);

  const L: string[] = [];
  L.push('# REC-9 reward-farming PROBE — reconciliation (predicted vs. actual)');
  L.push('');
  L.push('| market | predicted reward/day | actual reward | ratio | predicted net | actual net |');
  L.push('|---|--:|--:|--:|--:|--:|');
  for (const r of score.rows) {
    L.push(
      `| ${r.slug} | ${usd(r.predictedDailyRewardUsd, 3)} | ${usd(r.actualRewardUsd, 3)} | ${pct(r.rewardRatio)} | ${usd(r.predictedNetUsd, 3)} | ${usd(r.actualNetUsd, 3)} |`,
    );
  }
  L.push('');
  L.push(`**Matched ${score.nMatched} markets** · mean reward ratio **${pct(score.meanRewardRatio)}** · total actual reward ${usd(score.totalActualRewardUsd, 2)} vs predicted ${usd(score.totalPredictedRewardUsd, 2)} · total actual net ${usd(score.totalActualNetUsd, 2)}.`);
  L.push('');
  L.push(`## VERDICT: ${score.label}`);
  L.push(score.reason);
  writeFile(SCORE_PATH, L.join('\n'));

  for (const line of L) log(line);
  log('');
  log(`Score → ${SCORE_PATH}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      n: { type: 'string' },
      offset: { type: 'string' },
      'min-pool': { type: 'string' },
      'min-hours': { type: 'string' },
      'max-pages': { type: 'string' },
      tax: { type: 'string' },
      phi: { type: 'string' },
    },
  });
  const num = (v: string | undefined, d: number): number => (v != null && Number.isFinite(Number(v)) ? Number(v) : d);
  const mode = values.mode ?? 'plan';
  if (mode === 'reconcile') {
    runReconcile(console.log);
  } else {
    await runPlan(
      {
        nMarkets: num(values.n, 3),
        offsetCents: num(values.offset, 1),
        minPool: num(values['min-pool'], 5),
        minHours: num(values['min-hours'], 18),
        maxPages: num(values['max-pages'], 50),
        tax: num(values.tax, 0.05),
        phi: num(values.phi, 0.5),
      },
      console.log,
    );
  }
}
