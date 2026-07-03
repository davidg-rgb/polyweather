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
 *
 * SIGNAL-BACKLOG.md #1b (reward-stacking, OFF by default): --reward-pool <dailyPoolUsd> turns on
 * liquidity-reward accrual on the resting TP sell (0 = disabled, byte-identical); --reward-max-spread
 * <cents> (default 4.5, the weather-market rewards.max_spread) and --reward-share <fraction> (default 0,
 * the conservative swept-assumption floor — raise only once cross-checked, same convention as --rebate).
 *   pnpm tsx scripts/research/sim-maker-exit.ts --from-cache --reward-pool 240 --reward-share 0.01 ...
 *
 * SIGNAL-BACKLOG.md #5 (basket entry, OFF by default): --basket-size <N> (default 1 = the historical
 * single-bucket engine) splits perPositionUsd probability-weighted across the top-N candidates by
 * modelProb and writes out/maker-exit-basket-ledger.csv/.md instead of the single-bucket ledger.
 *   pnpm tsx scripts/research/sim-maker-exit.ts --from-cache --basket-size 3 ...
 *
 * Both levers are sweepable: --sweep "reward-pool:0,50,100,240" / --sweep "reward-share:0,0.005,0.01" /
 * --sweep "basket-size:1,2,3".
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { indexArchive, loadPanel, buildSet, splitByDate, type PanelEvent } from './tune-convergence.ts';
import {
  replayMakerExitPanel,
  replayMakerExitPanelBasket,
  MAKER_EXIT_DEFAULTS,
  type MakerExitCfg,
  type MakerExitTrade,
  type MakerExitBasketTrade,
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

export function loadCache(): { events: EventReplayInput[]; resolves: Map<string, number | null>; meta: string } {
  if (!existsSync(CACHE_PATH)) throw new Error(`no cache at ${CACHE_PATH} — run with --build-cache first`);
  const cache = JSON.parse(gunzipSync(readFileSync(CACHE_PATH)).toString('utf8')) as Cache;
  return {
    events: cache.events,
    resolves: new Map(cache.resolves),
    meta: `${cache.events.length} events · ${cache.sampleMin}-min cadence · built ${cache.builtAt}`,
  };
}

// ── the per-city selector-accuracy gate (the 2026-07-03 entry lever) ────────────────────────────────
/**
 * Per-city selector accuracy fitted on PRE-PANEL data ONLY: resolved 'highest' markets with target_date
 * 2026-05-13 → 2026-06-12 (the archive panel starts 2026-06-13, so a gate derived from this table is
 * temporally OUT-OF-SAMPLE for the whole replay). Pick = the CALIBRATED house blend's bucket (latest
 * model_stats debias+weights over forecast_snapshots, floor→market_buckets span), scored vs the market-
 * resolved winner, leads 1+2 pooled (the entry-decision leads). hits0 = exact bucket, hits1 = within ±1.
 * Source query: CONVERGENCE-TUNING.md §per-city (run 2026-07-03 against prod). lucknow n=2 → ungated-out
 * by the Wilson bound naturally.
 */
export const CITY_GATE_PRE0613: Record<string, { n: number; hits0: number; hits1: number }> = {
  amsterdam: { n: 58, hits0: 5, hits1: 20 },   ankara: { n: 58, hits0: 20, hits1: 53 },
  atlanta: { n: 56, hits0: 12, hits1: 36 },    austin: { n: 56, hits0: 32, hits1: 48 },
  beijing: { n: 58, hits0: 25, hits1: 49 },    'buenos-aires': { n: 58, hits0: 15, hits1: 49 },
  busan: { n: 58, hits0: 23, hits1: 44 },      'cape-town': { n: 56, hits0: 16, hits1: 48 },
  chengdu: { n: 58, hits0: 12, hits1: 35 },    chicago: { n: 58, hits0: 29, hits1: 44 },
  chongqing: { n: 58, hits0: 16, hits1: 32 },  dallas: { n: 58, hits0: 31, hits1: 48 },
  denver: { n: 58, hits0: 36, hits1: 49 },     guangzhou: { n: 58, hits0: 21, hits1: 44 },
  helsinki: { n: 58, hits0: 11, hits1: 34 },   houston: { n: 58, hits0: 25, hits1: 47 },
  jeddah: { n: 58, hits0: 11, hits1: 44 },     karachi: { n: 58, hits0: 28, hits1: 54 },
  'kuala-lumpur': { n: 58, hits0: 25, hits1: 48 }, london: { n: 58, hits0: 9, hits1: 40 },
  'los-angeles': { n: 58, hits0: 23, hits1: 53 }, lucknow: { n: 2, hits0: 1, hits1: 2 },
  madrid: { n: 58, hits0: 30, hits1: 55 },     manila: { n: 58, hits0: 20, hits1: 42 },
  'mexico-city': { n: 58, hits0: 41, hits1: 47 }, miami: { n: 52, hits0: 23, hits1: 47 },
  milan: { n: 58, hits0: 10, hits1: 45 },      munich: { n: 58, hits0: 20, hits1: 51 },
  nyc: { n: 58, hits0: 18, hits1: 51 },        'panama-city': { n: 56, hits0: 36, hits1: 55 },
  paris: { n: 58, hits0: 34, hits1: 53 },      qingdao: { n: 58, hits0: 18, hits1: 47 },
  'san-francisco': { n: 56, hits0: 31, hits1: 46 }, 'sao-paulo': { n: 56, hits0: 25, hits1: 46 },
  seattle: { n: 56, hits0: 26, hits1: 39 },    seoul: { n: 58, hits0: 17, hits1: 37 },
  shanghai: { n: 58, hits0: 15, hits1: 43 },   shenzhen: { n: 58, hits0: 8, hits1: 36 },
  singapore: { n: 58, hits0: 16, hits1: 47 },  taipei: { n: 58, hits0: 21, hits1: 43 },
  tokyo: { n: 58, hits0: 21, hits1: 45 },      toronto: { n: 58, hits0: 10, hits1: 38 },
  warsaw: { n: 58, hits0: 14, hits1: 48 },     wellington: { n: 58, hits0: 23, hits1: 43 },
  wuhan: { n: 58, hits0: 18, hits1: 44 },
};

/** Wilson 95% lower bound on a binomial proportion (the shrinkage the entry-watch idiom uses — rank by the
 *  conservative bound, never the point estimate). Pure; 0 on an empty sample. */
export function wilsonLower(hits: number, n: number, z = 1.96): number {
  if (!(n > 0) || !Number.isFinite(hits)) return 0;
  const p = Math.min(1, Math.max(0, hits / n));
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const rad = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return Math.max(0, (center - rad) / (1 + z2 / n));
}

/** The cities whose pre-panel Wilson-LB accuracy clears `minLb` on `metric` ('hit0' = exact bucket — the
 *  chw0 pick quality; 'hit1' = ±1 bracket). Pure. minLb ≤ 0 = no gate (every table city passes). */
export function gateCities(
  table: Record<string, { n: number; hits0: number; hits1: number }>,
  metric: 'hit0' | 'hit1',
  minLb: number,
): string[] {
  return Object.entries(table)
    .filter(([, r]) => wilsonLower(metric === 'hit0' ? r.hits0 : r.hits1, r.n) >= minLb)
    .map(([c]) => c)
    .sort();
}

export interface SimParams {
  tp: number; sl: number; tstopHours: number; chw: number; maxEntry: number; depth: number;
  rebate: number; makerWindow: number; perPos: number; feeRate: number;
  /** exit-structure lever: where the resting maker sell sits ('delta' = entry+tp — the historical default). */
  tpMode: 'delta' | 'abs' | 'model';
  /** the absolute resting-sell target for tpMode='abs'. */
  tpAbs: number;
  /** entry-timing lever: hours past listing before an entry is allowed (0 = first enterable tick). */
  minEntryAgeH: number;
  /** entry-selection lever: the per-city accuracy gate's Wilson-LB floor (0 = no gate). */
  cityGateLb: number;
  /** which accuracy metric the gate uses (hit0 = exact bucket, hit1 = ±1 bracket). */
  gateMetric: 'hit0' | 'hit1';
  /** entry lever: never let the taker fallback chase a book past the entry reservation (false = historical). */
  noChase: boolean;
  /** SIGNAL-BACKLOG.md #1b: the market's daily USDC liquidity-reward pool. 0 (default) = disabled — cfgFrom
   *  leaves MakerExitCfg.rewardCfg unset, byte-identical to every run before this lever existed. */
  rewardPoolUsd: number;
  /** SIGNAL-BACKLOG.md #1b: rewards.max_spread in CENTS (weather markets: 4.5, per REC-3/MAKER-REBATE-HANDOFF.md). */
  rewardMaxSpreadCents: number;
  /** SIGNAL-BACKLOG.md #1b: MY assumed share of the pool once qualifying — a SWEPT assumption (the competition
   *  denominator is the dominant unknown per reward-farming.ts), default 0 (the conservative floor). */
  rewardShare: number;
  /** SIGNAL-BACKLOG.md #5: split entry across the top-N candidates by modelProb (variance reduction, not a
   *  new edge). 1 (default) = the historical single-bucket engine (replayMakerExitPanel), byte-identical.
   *  >1 dispatches to the basket engine (replayMakerExitPanelBasket). */
  basketSize: number;
}
export const DEFAULT_PARAMS: SimParams = {
  tp: 0.1, sl: 0.2, tstopHours: 12, chw: 0, maxEntry: 0.3, depth: 100,
  rebate: 0, makerWindow: BOT_DEFAULTS.makerFillWindowMin, perPos: BOT_DEFAULTS.perPositionUsd, feeRate: BOT_DEFAULTS.takerFeeRate,
  tpMode: 'delta', tpAbs: 0.35, minEntryAgeH: 0, cityGateLb: 0, gateMetric: 'hit1', noChase: false,
  rewardPoolUsd: 0, rewardMaxSpreadCents: 4.5, rewardShare: 0, basketSize: 1,
};

export function cfgFrom(p: SimParams, cities: string[]): MakerExitCfg {
  return {
    ...BOT_DEFAULTS, ...MAKER_EXIT_DEFAULTS, cities,
    centerHalfWidth: p.chw, maxEntryPrice: p.maxEntry, depthFloorUsd: p.depth, perPositionUsd: p.perPos,
    tpDeltaPp: p.tp, slDeltaPp: p.sl, takerFeeRate: p.feeRate, makerFillWindowMin: p.makerWindow,
    makerRebateRate: p.rebate, tstopHoursBeforeResolve: p.tstopHours,
    tpMode: p.tpMode, tpAbsTarget: p.tpAbs, minEntryAgeH: p.minEntryAgeH, noChaseTakerFallback: p.noChase,
    // #1b: rewardCfg stays unset (byte-identical) unless the pool is actually turned on (rewardPoolUsd > 0).
    ...(p.rewardPoolUsd > 0
      ? { rewardCfg: { dailyPoolUsd: p.rewardPoolUsd, maxSpreadCents: p.rewardMaxSpreadCents, myPoolShareIfQualifying: p.rewardShare } }
      : {}),
    // #5: basketSize stays unset/1 (byte-identical, replayMakerExitEvent's own path) unless explicitly raised.
    ...(p.basketSize > 1 ? { basketSize: p.basketSize } : {}),
  };
}

const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}` : '—');

/** Write the per-trade ledger (entries + exits) — csv + a readable md sample. */
function writeLedger(ledger: MakerExitTrade[], p: SimParams): void {
  const realized = ledger.filter((t) => !t.exitKind.startsWith('mtm_'));
  const header = 'eventId,city,targetDate,entryLabel,entryAt,entryPrice,isMakerEntry,exitAt,exitPrice,exitKind,isMakerExit,feeUsd,rebateUsd,rewardUsd,netPnlUsd,netReturn\n';
  const rows = ledger.map((t) =>
    [t.eventId, t.city, t.targetDate, `"${t.entryLabel}"`, t.entryAt, t.entryPrice.toFixed(4), t.isMakerEntry,
     t.exitAt, t.exitPrice.toFixed(4), t.exitKind, t.isMakerExit, t.feeUsd.toFixed(4), t.rebateUsd.toFixed(4), t.rewardUsd.toFixed(4),
     t.netPnlUsd.toFixed(4), Number.isFinite(t.netReturn) ? t.netReturn.toFixed(4) : ''].join(','),
  );
  writeFileSync(join(OUT_DIR, 'maker-exit-ledger.csv'), header + rows.join('\n') + '\n');

  const sample = realized.slice(0, 25).map((t) =>
    `  ${t.city.padEnd(13)} ${t.targetDate} ${t.entryLabel.padEnd(7)} buy ${t.entryPrice.toFixed(3)}${t.isMakerEntry ? 'M' : 'T'} → ` +
    `${t.exitKind.replace('taker_', 'T:').replace('maker_', 'M:').padEnd(16)} sell ${t.exitPrice.toFixed(3)} = ${usd(t.netPnlUsd)} (${pct(t.netReturn)})`,
  );
  const md = [
    `# maker-exit ledger — tp ${p.tp} sl ${p.sl} tstop ${p.tstopHours}h chw ${p.chw} maxEntry ${p.maxEntry} depth $${p.depth} rebate ${p.rebate}` +
      (p.rewardPoolUsd > 0 ? ` rewardPool $${p.rewardPoolUsd} rewardShare ${p.rewardShare}` : ''),
    `${realized.length} realized trades. First 25:`, '', ...sample,
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'maker-exit-ledger.md'), md + '\n');
}

/** SIGNAL-BACKLOG.md #5 — the basket twin of writeLedger: flattens every basket's legs into one per-leg
 *  csv (+ an added basketWeight column) and a readable md sample. */
function writeLedgerBasket(ledger: MakerExitBasketTrade[], p: SimParams): void {
  const legs = ledger.flatMap((bt) => bt.legs);
  const realized = legs.filter((t) => !t.exitKind.startsWith('mtm_'));
  const header = 'eventId,city,targetDate,bucketIdx,basketWeight,entryLabel,entryAt,entryPrice,isMakerEntry,exitAt,exitPrice,exitKind,isMakerExit,feeUsd,rebateUsd,rewardUsd,netPnlUsd,netReturn\n';
  const rows = legs.map((t) =>
    [t.eventId, t.city, t.targetDate, t.bucketIdx, t.basketWeight.toFixed(4), `"${t.entryLabel}"`, t.entryAt, t.entryPrice.toFixed(4),
     t.isMakerEntry, t.exitAt, t.exitPrice.toFixed(4), t.exitKind, t.isMakerExit, t.feeUsd.toFixed(4), t.rebateUsd.toFixed(4),
     t.rewardUsd.toFixed(4), t.netPnlUsd.toFixed(4), Number.isFinite(t.netReturn) ? t.netReturn.toFixed(4) : ''].join(','),
  );
  writeFileSync(join(OUT_DIR, 'maker-exit-basket-ledger.csv'), header + rows.join('\n') + '\n');

  const sample = realized.slice(0, 25).map((t) =>
    `  ${t.city.padEnd(13)} ${t.targetDate} b${t.bucketIdx} (w${t.basketWeight.toFixed(2)}) ${t.entryLabel.padEnd(7)} buy ${t.entryPrice.toFixed(3)}${t.isMakerEntry ? 'M' : 'T'} → ` +
    `${t.exitKind.replace('taker_', 'T:').replace('maker_', 'M:').padEnd(16)} sell ${t.exitPrice.toFixed(3)} = ${usd(t.netPnlUsd)} (${pct(t.netReturn)})`,
  );
  const md = [
    `# maker-exit BASKET ledger (basketSize ${p.basketSize}) — tp ${p.tp} sl ${p.sl} tstop ${p.tstopHours}h chw ${p.chw} maxEntry ${p.maxEntry} depth $${p.depth} rebate ${p.rebate}`,
    `${ledger.length} baskets / ${realized.length} realized legs. First 25 legs:`, '', ...sample,
  ].join('\n');
  writeFileSync(join(OUT_DIR, 'maker-exit-basket-ledger.md'), md + '\n');
}

/** the panel fields run()'s summary reads — MakerExitPanel and MakerExitPanelBasket share this shape
 *  structurally, so summarize() serves both dispatch branches with no duplicated field-mapping. */
interface PanelSummaryShape {
  nRealized: number;
  nExecuted: number;
  makerExitFrac: number;
  winFrac: number;
  meanNetReturn: number;
  totalNetUsd: number;
  verdict: { label: string; ciLow: number; ciHigh: number; zeroSkillPassRate: number };
}

function summarize(p: SimParams, scoped: EventReplayInput[], cities: string[], panel: PanelSummaryShape): Record<string, unknown> {
  // the optimizer objective: mean realized net return, but only credited when the §9R-E count floor is met
  // (≥40 realized markets) — so it cannot "win" by entering a handful of lucky trades.
  const objective = panel.nRealized >= GATE_MIN_MARKETS ? panel.meanNetReturn : -1;
  return {
    params: p,
    nEventsScoped: scoped.length,
    nGatedCities: cities.length,
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

export function run(p: SimParams, events: EventReplayInput[], resolves: Map<string, number | null>, writeFiles: boolean): Record<string, unknown> {
  // the per-city accuracy gate (fitted PRE-panel → OOS here): drop events in cities whose Wilson-LB accuracy
  // misses the floor. cityGateLb ≤ 0 = no gate (the historical full-universe behavior).
  const gated = p.cityGateLb > 0 ? new Set(gateCities(CITY_GATE_PRE0613, p.gateMetric, p.cityGateLb)) : null;
  const scoped = gated ? events.filter((e) => gated.has(e.city)) : events;
  const cities = [...new Set(scoped.map((e) => e.city))];
  const cfg = cfgFrom(p, cities);

  // SIGNAL-BACKLOG.md #5: basketSize>1 dispatches to the basket engine; ≤1 (the historical default) uses the
  // pinned single-bucket engine, completely unchanged — byte-identical to every run before this lever existed.
  if (p.basketSize > 1) {
    const panel = replayMakerExitPanelBasket(scoped, cfg, resolves);
    if (writeFiles) writeLedgerBasket(panel.ledger, p);
    return summarize(p, scoped, cities, panel);
  }
  const panel = replayMakerExitPanel(scoped, cfg, resolves);
  if (writeFiles) writeLedger(panel.ledger, p);
  return summarize(p, scoped, cities, panel);
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      'build-cache': { type: 'boolean' }, 'from-cache': { type: 'boolean' },
      tp: { type: 'string' }, sl: { type: 'string' }, 'tstop-hours': { type: 'string' },
      chw: { type: 'string' }, 'max-entry': { type: 'string' }, depth: { type: 'string' },
      rebate: { type: 'string' }, 'maker-window': { type: 'string' }, 'per-pos': { type: 'string' }, 'fee-rate': { type: 'string' },
      'tp-mode': { type: 'string' }, 'tp-abs': { type: 'string' }, 'min-entry-age-h': { type: 'string' },
      'city-gate-lb': { type: 'string' }, 'gate-metric': { type: 'string' },
      cities: { type: 'string' }, // comma list, or 'allowlist' = BOT_DEFAULTS.cities (the live forward loop's scope)
      'no-chase': { type: 'boolean' },
      split: { type: 'boolean' },
      sweep: { type: 'string' },
      // SIGNAL-BACKLOG.md #1b (reward-stacking) + #5 (basket entry) — both default OFF (0 / 1), byte-identical.
      'reward-pool': { type: 'string' }, 'reward-max-spread': { type: 'string' }, 'reward-share': { type: 'string' },
      'basket-size': { type: 'string' },
    },
  });
  if (values['build-cache']) {
    const { n, cities, days } = await buildCache();
    process.stdout.write(`RESULT ${JSON.stringify({ builtCache: true, events: n, cities, days, cache: CACHE_PATH })}\n`);
  } else {
    const num = (k: string, d: number): number => { const v = values[k as keyof typeof values]; const n = Number(v); return v != null && Number.isFinite(n) ? n : d; };
    const tpModeRaw = String(values['tp-mode'] ?? DEFAULT_PARAMS.tpMode);
    const tpMode: SimParams['tpMode'] = tpModeRaw === 'abs' || tpModeRaw === 'model' ? tpModeRaw : 'delta';
    const gateMetricRaw = String(values['gate-metric'] ?? DEFAULT_PARAMS.gateMetric);
    const base: SimParams = {
      tp: num('tp', DEFAULT_PARAMS.tp), sl: num('sl', DEFAULT_PARAMS.sl), tstopHours: num('tstop-hours', DEFAULT_PARAMS.tstopHours),
      chw: num('chw', DEFAULT_PARAMS.chw), maxEntry: num('max-entry', DEFAULT_PARAMS.maxEntry), depth: num('depth', DEFAULT_PARAMS.depth),
      rebate: num('rebate', DEFAULT_PARAMS.rebate), makerWindow: num('maker-window', DEFAULT_PARAMS.makerWindow),
      perPos: num('per-pos', DEFAULT_PARAMS.perPos), feeRate: num('fee-rate', DEFAULT_PARAMS.feeRate),
      tpMode, tpAbs: num('tp-abs', DEFAULT_PARAMS.tpAbs), minEntryAgeH: num('min-entry-age-h', DEFAULT_PARAMS.minEntryAgeH),
      cityGateLb: num('city-gate-lb', DEFAULT_PARAMS.cityGateLb),
      gateMetric: gateMetricRaw === 'hit0' ? 'hit0' : 'hit1',
      noChase: values['no-chase'] === true,
      rewardPoolUsd: num('reward-pool', DEFAULT_PARAMS.rewardPoolUsd),
      rewardMaxSpreadCents: num('reward-max-spread', DEFAULT_PARAMS.rewardMaxSpreadCents),
      rewardShare: num('reward-share', DEFAULT_PARAMS.rewardShare),
      basketSize: num('basket-size', DEFAULT_PARAMS.basketSize),
    };
    const { events: allEvents, resolves, meta } = loadCache();
    // --cities: scope the panel (e.g. 'allowlist' = the §9R 10-city TRADABLE set the live forward loop runs on).
    const citiesRaw = values['cities'] as string | undefined;
    const cityScope = citiesRaw
      ? new Set(citiesRaw === 'allowlist' ? BOT_DEFAULTS.cities : citiesRaw.split(',').map((s) => s.trim()))
      : null;
    const events = cityScope ? allEvents.filter((e) => cityScope.has(e.city)) : allEvents;
    process.stderr.write(`${SCRIPT} · ${meta}${cityScope ? ` · scoped to ${new Set(events.map((e) => e.city)).size} cities (${events.length} events)` : ''}\n`);

    // --split: score the SAME params on the date-based TRAIN/TEST folds (+ FULL) — the OOS discipline the
    // 2026-06-30 review demanded (the in-sample headline was the winner's-curse). Select on train, QUOTE test.
    const scopes: Array<{ scope: string; evs: EventReplayInput[] }> = (() => {
      if (!values['split']) return [{ scope: 'full', evs: events }];
      const { train, test, cutDate } = splitByDate(events, 0.6);
      process.stderr.write(`  split at ${cutDate}: train ${train.length} / test ${test.length} events\n`);
      return [{ scope: 'train', evs: train }, { scope: 'test', evs: test }, { scope: 'full', evs: events }];
    })();

    // --sweep "param:v1,v2,…" runs the sim once per value (others held at the flags) → one RESULT line each
    // (× each --split scope), so a tuning agent line-searches a coordinate in ONE command.
    const sweep = values['sweep'] as string | undefined;
    if (sweep) {
      const [param, listRaw] = sweep.split(':');
      const vals = (listRaw ?? '').split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
      const KEY: Record<string, keyof SimParams> = {
        tp: 'tp', sl: 'sl', 'tstop-hours': 'tstopHours', chw: 'chw', 'max-entry': 'maxEntry',
        depth: 'depth', rebate: 'rebate', 'maker-window': 'makerWindow',
        'tp-abs': 'tpAbs', 'min-entry-age-h': 'minEntryAgeH', 'city-gate-lb': 'cityGateLb',
        'reward-pool': 'rewardPoolUsd', 'reward-share': 'rewardShare', 'basket-size': 'basketSize',
      };
      const key = KEY[String(param)];
      if (!key || vals.length === 0) { process.stderr.write(`bad --sweep "${sweep}"\n`); process.exit(1); }
      for (const v of vals) {
        for (const { scope, evs } of scopes) {
          const out = run({ ...base, [key]: v }, evs, resolves, false);
          process.stdout.write(`RESULT ${JSON.stringify({ sweepParam: param, sweepValue: v, scope, ...out })}\n`);
        }
      }
    } else {
      for (const { scope, evs } of scopes) {
        const out = run(base, evs, resolves, scope === 'full');
        process.stderr.write(
          `  [${scope}] realized ${out['nRealized']} · makerExit ${pct(out['makerExitFrac'] as number)} · winFrac ${pct(out['winFrac'] as number)} · ` +
          `meanNetRet ${pct(out['meanNetReturn'] as number)} · total ${usd(out['totalNetUsd'] as number)} · ${out['verdict']}\n`,
        );
        process.stdout.write(`RESULT ${JSON.stringify({ scope, ...out })}\n`);
      }
    }
  }
}
