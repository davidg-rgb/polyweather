/**
 * scripts/research/sim-maker-exit — run the MAKER-EXIT convergence strategy over the 708-event archive panel
 * and print a per-trade LEDGER (entries + exits, "like the logged potential entries & exits") + the §9R-E verdict.
 *
 * The strategy (CONVERGENCE-TUNING.md Finding 1 → the maker-exit redirect): enter the forecast-center bucket per
 * the live bot's `selectEntries` spec (maker-first fill), then TAKE PROFIT AS A MAKER (rest a sell at entry+TP,
 * fill at the limit with $0 taker fee + an optional rebate) — with a TAKER stop-loss and a HARD time-stop at the
 * latest `--tstop-hours` BEFORE the market resolves (the spec: "exit … or at the latest N hours from bet closing").
 *
 * The panel + the synthetic (calibrated) book are built ONCE and cached (`--build-cache`) so the tuning loop's
 * agents re-run the replay fast (`--from-cache`, no DB / no archive parse). The synthetic book is FIXED at the
 * calibrated spread (×1) in the cache — the maker-exit + entry/exit knobs are decision params applied at replay
 * time, so one cache serves every param set the optimizer tries.
 *
 * Read-only: reads the DB (gaussian seed + resolution) + the local archive; writes only out/ artifacts. Places
 * nothing, never imports packages/trading.
 *
 * Run: pnpm tsx scripts/research/sim-maker-exit.ts --build-cache            # build the panel cache once
 *      pnpm tsx scripts/research/sim-maker-exit.ts --from-cache --tp 0.10 --sl 0.20 --tstop-hours 12 \
 *        --chw 0 --max-entry 0.30 --depth 100 --rebate 0                    # one parameterized run
 *   Emits a one-line `RESULT {json}` to stdout (the optimizer reads it) + out/maker-exit-ledger.csv + .md.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { indexArchive, loadPanel, buildSet, type PanelEvent } from './tune-convergence.ts';
import {
  replayMakerExitPanel,
  MAKER_EXIT_DEFAULTS,
  type MakerExitCfg,
  type MakerExitTrade,
} from '../../packages/core/src/sim/opening-maker-exit-replay.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { BOT_DEFAULTS, GATE_MIN_MARKETS } from '../../packages/core/src/sim/opening-convergence.ts';

export const SCRIPT = 'sim-maker-exit';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const ARCHIVE_ROOT = join(OUT_DIR, 'market-history');
const CACHE_PATH = join(OUT_DIR, 'maker-exit-cache.json.gz');
// 20-min cadence keeps the built-panel cache serializable (a finer cache OOMs on the giant JSON). The maker EXIT
// (the headline lever) is checked at EVERY tick regardless of cadence, so 20-min is faithful for it. The maker
// ENTRY needs makerFillWindowMin ≥ the cadence to get a fill chance — that window is an OPTIMIZER lever (--maker-window),
// so the loop can probe whether a longer maker-entry rest helps (the default 15 ⇒ a realistic taker-leaning entry).
const SAMPLE_MIN = 20;

interface Cache {
  builtAt: string;
  sampleMin: number;
  events: EventReplayInput[];
  resolves: [string, number | null][];
}

/** Build the panel once (gaussian seed, calibrated spread ×1) + the resolvesAt map → a gzip cache for the loop. */
async function buildCache(): Promise<{ n: number; cities: number; days: number }> {
  loadEnv();
  const archiveIdx = indexArchive(ARCHIVE_ROOT);
  const db = makeScriptDb();
  try {
    const panel = await loadPanel(db, archiveIdx, false);
    const events = buildSet(panel, 'house_gaussian', 1, SAMPLE_MIN);
    // resolves: eventId → the market's resolution epoch ms (the archive endDate = the venue resolution clock).
    const byId = new Map<string, PanelEvent>(panel.map((p) => [p.eventId, p]));
    const resolves: [string, number | null][] = events.map((e) => {
      const p = byId.get(e.eventId);
      const ms = p?.archive.endDate ? new Date(p.archive.endDate).getTime() : null;
      return [e.eventId, Number.isFinite(ms as number) ? ms : null];
    });
    const cache: Cache = { builtAt: new Date().toISOString(), sampleMin: SAMPLE_MIN, events, resolves };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, gzipSync(Buffer.from(JSON.stringify(cache)), { level: 6 }));
    const cities = new Set(events.map((e) => e.city)).size;
    const days = new Set(events.map((e) => e.targetDate)).size;
    return { n: events.length, cities, days };
  } finally {
    await db.end();
  }
}

function loadCache(): { events: EventReplayInput[]; resolves: Map<string, number | null>; meta: string } {
  if (!existsSync(CACHE_PATH)) throw new Error(`no cache at ${CACHE_PATH} — run with --build-cache first`);
  const cache = JSON.parse(gunzipSync(readFileSync(CACHE_PATH)).toString('utf8')) as Cache;
  return {
    events: cache.events,
    resolves: new Map(cache.resolves),
    meta: `${cache.events.length} events · ${cache.sampleMin}-min cadence · built ${cache.builtAt}`,
  };
}

export interface SimParams {
  tp: number; sl: number; tstopHours: number; chw: number; maxEntry: number; depth: number;
  rebate: number; makerWindow: number; perPos: number; feeRate: number;
}
export const DEFAULT_PARAMS: SimParams = {
  tp: 0.1, sl: 0.2, tstopHours: 12, chw: 0, maxEntry: 0.3, depth: 100,
  rebate: 0, makerWindow: BOT_DEFAULTS.makerFillWindowMin, perPos: BOT_DEFAULTS.perPositionUsd, feeRate: BOT_DEFAULTS.takerFeeRate,
};

export function cfgFrom(p: SimParams, cities: string[]): MakerExitCfg {
  return {
    ...BOT_DEFAULTS, ...MAKER_EXIT_DEFAULTS, cities,
    centerHalfWidth: p.chw, maxEntryPrice: p.maxEntry, depthFloorUsd: p.depth, perPositionUsd: p.perPos,
    tpDeltaPp: p.tp, slDeltaPp: p.sl, takerFeeRate: p.feeRate, makerFillWindowMin: p.makerWindow,
    makerRebateRate: p.rebate, tstopHoursBeforeResolve: p.tstopHours,
  };
}

const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}` : '—');

/** Write the per-trade ledger (entries + exits) — csv + a readable md sample. */
function writeLedger(ledger: MakerExitTrade[], p: SimParams): void {
  const realized = ledger.filter((t) => !t.exitKind.startsWith('mtm_'));
  const header = 'eventId,city,targetDate,entryLabel,entryAt,entryPrice,isMakerEntry,exitAt,exitPrice,exitKind,isMakerExit,feeUsd,rebateUsd,netPnlUsd,netReturn\n';
  const rows = ledger.map((t) =>
    [t.eventId, t.city, t.targetDate, `"${t.entryLabel}"`, t.entryAt, t.entryPrice.toFixed(4), t.isMakerEntry,
     t.exitAt, t.exitPrice.toFixed(4), t.exitKind, t.isMakerExit, t.feeUsd.toFixed(4), t.rebateUsd.toFixed(4),
     t.netPnlUsd.toFixed(4), Number.isFinite(t.netReturn) ? t.netReturn.toFixed(4) : ''].join(','),
  );
  writeFileSync(join(OUT_DIR, 'maker-exit-ledger.csv'), header + rows.join('\n') + '\n');

  const sample = realized.slice(0, 25).map((t) =>
    `  ${t.city.padEnd(13)} ${t.targetDate} ${t.entryLabel.padEnd(7)} buy ${t.entryPrice.toFixed(3)}${t.isMakerEntry ? 'M' : 'T'} → ` +
    `${t.exitKind.replace('taker_', 'T:').replace('maker_', 'M:').padEnd(16)} sell ${t.exitPrice.toFixed(3)} = ${usd(t.netPnlUsd)} (${pct(t.netReturn)})`,
  );
  const md = [
    `# maker-exit ledger — tp ${p.tp} sl ${p.sl} tstop ${p.tstopHours}h chw ${p.chw} maxEntry ${p.maxEntry} depth $${p.depth} rebate ${p.rebate}`,
    `${realized.length} realized trades. First 25:`, '', ...sample,
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'maker-exit-ledger.md'), md + '\n');
}

export function run(p: SimParams, events: EventReplayInput[], resolves: Map<string, number | null>, writeFiles: boolean): Record<string, unknown> {
  const cities = [...new Set(events.map((e) => e.city))];
  const panel = replayMakerExitPanel(events, cfgFrom(p, cities), resolves);
  if (writeFiles) writeLedger(panel.ledger, p);
  // the optimizer objective: mean realized net return, but only credited when the §9R-E count floor is met
  // (≥40 realized markets) — so it cannot "win" by entering a handful of lucky trades.
  const objective = panel.nRealized >= GATE_MIN_MARKETS ? panel.meanNetReturn : -1;
  return {
    params: p,
    nRealized: panel.nRealized,
    nExecuted: panel.nExecuted,
    makerExitFrac: panel.makerExitFrac,
    winFrac: panel.winFrac,
    meanNetReturn: panel.meanNetReturn,
    totalNetUsd: panel.totalNetUsd,
    ciLow: panel.verdict.ciLow,
    ciHigh: panel.verdict.ciHigh,
    zeroSkillPassRate: panel.verdict.zeroSkillPassRate,
    verdict: panel.verdict.label,
    objective,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      'build-cache': { type: 'boolean' }, 'from-cache': { type: 'boolean' },
      tp: { type: 'string' }, sl: { type: 'string' }, 'tstop-hours': { type: 'string' },
      chw: { type: 'string' }, 'max-entry': { type: 'string' }, depth: { type: 'string' },
      rebate: { type: 'string' }, 'maker-window': { type: 'string' }, 'per-pos': { type: 'string' }, 'fee-rate': { type: 'string' },
      sweep: { type: 'string' },
    },
  });
  if (values['build-cache']) {
    const { n, cities, days } = await buildCache();
    process.stdout.write(`RESULT ${JSON.stringify({ builtCache: true, events: n, cities, days, cache: CACHE_PATH })}\n`);
  } else {
    const num = (k: string, d: number): number => { const v = values[k as keyof typeof values]; const n = Number(v); return v != null && Number.isFinite(n) ? n : d; };
    const base: SimParams = {
      tp: num('tp', DEFAULT_PARAMS.tp), sl: num('sl', DEFAULT_PARAMS.sl), tstopHours: num('tstop-hours', DEFAULT_PARAMS.tstopHours),
      chw: num('chw', DEFAULT_PARAMS.chw), maxEntry: num('max-entry', DEFAULT_PARAMS.maxEntry), depth: num('depth', DEFAULT_PARAMS.depth),
      rebate: num('rebate', DEFAULT_PARAMS.rebate), makerWindow: num('maker-window', DEFAULT_PARAMS.makerWindow),
      perPos: num('per-pos', DEFAULT_PARAMS.perPos), feeRate: num('fee-rate', DEFAULT_PARAMS.feeRate),
    };
    const { events, resolves, meta } = loadCache();
    process.stderr.write(`${SCRIPT} · ${meta}\n`);

    // --sweep "param:v1,v2,…" runs the sim once per value (others held at the flags) → one RESULT line each, so a
    // tuning agent line-searches a coordinate in ONE command. param ∈ the SimParams kebab keys.
    const sweep = values['sweep'] as string | undefined;
    if (sweep) {
      const [param, listRaw] = sweep.split(':');
      const vals = (listRaw ?? '').split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
      const KEY: Record<string, keyof SimParams> = {
        tp: 'tp', sl: 'sl', 'tstop-hours': 'tstopHours', chw: 'chw', 'max-entry': 'maxEntry',
        depth: 'depth', rebate: 'rebate', 'maker-window': 'makerWindow',
      };
      const key = KEY[String(param)];
      if (!key || vals.length === 0) { process.stderr.write(`bad --sweep "${sweep}"\n`); process.exit(1); }
      for (const v of vals) {
        const out = run({ ...base, [key]: v }, events, resolves, false);
        process.stdout.write(`RESULT ${JSON.stringify({ sweepParam: param, sweepValue: v, ...out })}\n`);
      }
    } else {
      const out = run(base, events, resolves, true);
      process.stderr.write(
        `  realized ${out['nRealized']} · makerExit ${pct(out['makerExitFrac'] as number)} · winFrac ${pct(out['winFrac'] as number)} · ` +
        `meanNetRet ${pct(out['meanNetReturn'] as number)} · total ${usd(out['totalNetUsd'] as number)} · ${out['verdict']}\n`,
      );
      process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
    }
  }
}
