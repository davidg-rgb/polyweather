/**
 * scripts/research/sim-fluctuation-taker — run the FLUCTUATION-TAKER variant (BUILD-STATE 2026-07-03 #3,
 * operator-requested) over the archive panel: pair the price paths with the production forecasts at leads
 * 2/1/0 (made_at-anchored — no look-ahead), re-center the key bucket set (predicted Tmax ±1 bucket) per lead,
 * and sweep PRICE-PATH taker entries/exits (dip-depth × momentum-window × exit-rule, incl. path-based exits)
 * against the calibrated synthetic book + the real fee curve, judged by the frozen §9R-E gate + the OOS date
 * split + the day-block tightening (VerdictOpts.dayBlockNull — always ON here, per the operator's spec).
 *
 * CONTEXT. The corrected archive moved the plain taker bracket's breakeven ×0.70 → ×1.14 of the calibrated
 * spread (CONVERGENCE-TUNING.md banner) — mean-positive at the real spread, CI-blocked — so path variants are
 * not pre-doomed; but dip-buys rhyme with the §12 adverse-selection wall and delayed entry was monotone toxic
 * (MAKER-EXIT-SIM.md §campaign), so expect a fight. This harness measures it honestly: TRAIN-select, TEST-quote.
 *
 * CACHES. Reuses the maker-exit panel cache (out/maker-exit-cache.json.gz — the SAME events/cadence/spread,
 * built by sim-maker-exit --build-cache) for the tick series + resolves, and adds ONE cheap DB artifact of its
 * own: the per-event production `house_gaussian` dist stream at leads 0..2 (thinned to the freshest per 6h),
 * cached to out/fluctuation-dists.json.gz. First pass runs on the 20-min cadence; rebuild finer only for
 * survivors (the BUILD-STATE instruction).
 *
 * Read-only: reads the DB (dist streams) + the local caches; writes only out/ artifacts. Places nothing,
 * never imports packages/trading.
 *
 * Run: pnpm tsx scripts/research/sim-fluctuation-taker.ts --build-cache     # needs the maker-exit cache first
 *      pnpm tsx scripts/research/sim-fluctuation-taker.ts --from-cache --split          # one cell, OOS quoted
 *      pnpm tsx scripts/research/sim-fluctuation-taker.ts --from-cache --sweep dip:0.03,0.05,0.08 --split
 *      pnpm tsx scripts/research/sim-fluctuation-taker.ts --grid            # the named sweep: TRAIN→TEST/FULL
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { loadCache } from './sim-maker-exit.ts';
import { splitByDate } from './tune-convergence.ts';
import {
  replayFluctuationPanel,
  FLUCTUATION_DEFAULTS,
  type FluctuationCfg,
  type FluctuationDist,
  type FluctuationPanelInput,
  type FluctuationTrade,
} from '../../packages/core/src/sim/opening-fluctuation-replay.ts';
import type { EventReplayInput } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import { BOT_DEFAULTS, GATE_MIN_MARKETS } from '../../packages/core/src/sim/opening-convergence.ts';

export const SCRIPT = 'sim-fluctuation-taker';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const DISTS_CACHE_PATH = join(OUT_DIR, 'fluctuation-dists.json.gz');
/** thin the dist stream to the freshest per this many hours — re-centering is a daily-refresh phenomenon;
 *  6h granularity keeps the cache small while never letting a tick read a dist that postdates it. */
const THIN_HOURS = 6;
/** DB gentleness after the 2026-07-03 IO incident: chunk the id list so no single statement is heavy. */
const ID_CHUNK = 100;

interface DistsCache {
  builtAt: string;
  thinHours: number;
  /** eventId → [madeAtMs, probs[] (by bucket idx, null-sparse)] ascending by madeAtMs. */
  byEvent: Record<string, Array<[number, Array<number | null>]>>;
}

// ── cache build (the ONE DB touch) ─────────────────────────────────────────────────────────────────────
async function buildDistsCache(): Promise<{ events: number; withDists: number; dists: number }> {
  loadEnv();
  const { events } = loadCache(); // throws with a clear message if the maker-exit cache is absent
  const ids = [...new Set(events.map((e) => e.eventId))];
  const db = makeScriptDb();
  const byEvent: DistsCache['byEvent'] = {};
  let nDists = 0;
  try {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const rows = await db.query<{ poly_event_id: string; made_at: string | Date; probs: unknown }>(
        `with ev as (
           select me.id, me.poly_event_id, me.target_date, c.tz
             from market_events me
             join cities c on c.id = me.city_id
            where me.poly_event_id = any($1::text[])
         ), d as (
           select ev.poly_event_id,
                  bp.made_at,
                  bp.probs,
                  (ev.target_date - (bp.made_at at time zone ev.tz)::date) as lead,
                  floor(extract(epoch from bp.made_at) / ${THIN_HOURS * 3600})::bigint as hbin
             from bucket_probabilities bp
             join ev on ev.id = bp.event_id
            where bp.source = 'house_gaussian'
              and coalesce(bp.seeded, false) = false
              -- coarse, INDEX-PRUNABLE made_at window (leads 0..2 always fall inside target_date −3d…+1d in any
              -- tz); the precise tz-aware lead filter below stays authoritative. Without this the per-row
              -- "at time zone" ran over an event's ENTIRE dist history and timed out on the convalescing DB.
              and bp.made_at >= (ev.target_date - 3)::timestamptz
              and bp.made_at <  (ev.target_date + 2)::timestamptz
         )
         select distinct on (poly_event_id, hbin) poly_event_id, made_at, probs
           from d
          where lead between 0 and 2
          order by poly_event_id, hbin, made_at desc`,
        [chunk],
      );
      for (const r of rows) {
        const ms = new Date(r.made_at as string).getTime();
        if (!Number.isFinite(ms) || !Array.isArray(r.probs)) continue;
        const arr = (r.probs as unknown[]).map((p) => (p != null && Number.isFinite(Number(p)) ? Number(p) : null));
        (byEvent[r.poly_event_id] ??= []).push([ms, arr]);
        nDists++;
      }
      process.stderr.write(`  dists: ${Math.min(i + ID_CHUNK, ids.length)}/${ids.length} events queried\r`);
    }
  } finally {
    await db.end();
  }
  for (const k of Object.keys(byEvent)) byEvent[k]!.sort((a, b) => a[0] - b[0]);
  const cache: DistsCache = { builtAt: new Date().toISOString(), thinHours: THIN_HOURS, byEvent };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(DISTS_CACHE_PATH, gzipSync(Buffer.from(JSON.stringify(cache)), { level: 6 }));
  return { events: ids.length, withDists: Object.keys(byEvent).length, dists: nDists };
}

export function loadDists(): { byEvent: Map<string, FluctuationDist[]>; meta: string } {
  if (!existsSync(DISTS_CACHE_PATH)) {
    throw new Error(`no dists cache at ${DISTS_CACHE_PATH} — run with --build-cache first`);
  }
  const cache = JSON.parse(gunzipSync(readFileSync(DISTS_CACHE_PATH)).toString('utf8')) as DistsCache;
  const byEvent = new Map<string, FluctuationDist[]>();
  let n = 0;
  for (const [eventId, rows] of Object.entries(cache.byEvent)) {
    const ds: FluctuationDist[] = [];
    for (const [ms, probs] of rows) {
      const m = new Map<number, number>();
      probs.forEach((p, idx) => {
        if (p != null && Number.isFinite(p)) m.set(idx, p);
      });
      if (m.size > 0 && Number.isFinite(ms)) ds.push({ madeAtMs: ms, probsByIdx: m });
    }
    if (ds.length > 0) {
      byEvent.set(eventId, ds);
      n += ds.length;
    }
  }
  return { byEvent, meta: `${n} dists · ${byEvent.size} events · ${cache.thinHours}h-thinned · built ${cache.builtAt}` };
}

// ── params + cfg ───────────────────────────────────────────────────────────────────────────────────────
export interface FluxParams {
  entryMode: 'dip' | 'momentum';
  dip: number;
  windowMin: number;
  exitRule: 'bracket' | 'trail';
  tp: number;
  trail: number;
  sl: number;
  tstopHours: number;
  chw: number;
  maxEntry: number;
  depth: number;
  recenter: boolean;
  perPos: number;
  feeRate: number;
  slip: number;
}
export const DEFAULT_PARAMS: FluxParams = {
  entryMode: FLUCTUATION_DEFAULTS.entryMode,
  dip: FLUCTUATION_DEFAULTS.dipDepth,
  windowMin: FLUCTUATION_DEFAULTS.momentumWindowMin,
  exitRule: FLUCTUATION_DEFAULTS.exitRule,
  tp: FLUCTUATION_DEFAULTS.tpDeltaPp,
  trail: FLUCTUATION_DEFAULTS.trailPp,
  sl: FLUCTUATION_DEFAULTS.slDeltaPp,
  tstopHours: FLUCTUATION_DEFAULTS.tstopHoursBeforeResolve,
  chw: FLUCTUATION_DEFAULTS.centerHalfWidth,
  maxEntry: FLUCTUATION_DEFAULTS.maxEntryPrice,
  depth: FLUCTUATION_DEFAULTS.depthFloorUsd,
  recenter: FLUCTUATION_DEFAULTS.exitOnRecenter,
  perPos: FLUCTUATION_DEFAULTS.perPositionUsd,
  feeRate: FLUCTUATION_DEFAULTS.takerFeeRate,
  slip: FLUCTUATION_DEFAULTS.paperSlippage,
};

export function cfgFrom(p: FluxParams, cities: string[]): FluctuationCfg {
  return {
    ...FLUCTUATION_DEFAULTS,
    cities,
    entryMode: p.entryMode,
    dipDepth: p.dip,
    momentumWindowMin: p.windowMin,
    exitRule: p.exitRule,
    tpDeltaPp: p.tp,
    trailPp: p.trail,
    slDeltaPp: p.sl,
    tstopHoursBeforeResolve: p.tstopHours,
    centerHalfWidth: p.chw,
    maxEntryPrice: p.maxEntry,
    depthFloorUsd: p.depth,
    exitOnRecenter: p.recenter,
    perPositionUsd: p.perPos,
    takerFeeRate: p.feeRate,
    paperSlippage: p.slip,
  };
}

const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const usd = (v: number): string => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}` : '—');

/** One scored run's flattened summary (the RESULT line / the grid row). */
export interface FluxRow {
  params: FluxParams;
  scope: string;
  nEventsScoped: number;
  nExecuted: number;
  nRealized: number;
  winFrac: number;
  meanNetReturn: number;
  totalNetUsd: number;
  ciLow: number;
  ciHigh: number;
  dayCiLow: number;
  dayCiHigh: number;
  zsMC: number;
  zsMCDay: number;
  verdict: string;
  exitKinds: Record<string, number>;
}

export function run(
  p: FluxParams,
  items: FluctuationPanelInput[],
  resolves: Map<string, number | null>,
  scope: string,
): { row: FluxRow; ledger: FluctuationTrade[] } {
  const cities = [...new Set(items.map((x) => x.event.city))];
  // the day-block tightening is ALWAYS ON here (the operator's spec) — a strict tightening of the frozen gate.
  const panel = replayFluctuationPanel(items, cfgFrom(p, cities), resolves, { dayBlockNull: true });
  const exitKinds: Record<string, number> = {};
  for (const t of panel.ledger) exitKinds[t.exitKind] = (exitKinds[t.exitKind] ?? 0) + 1;
  return {
    row: {
      params: p,
      scope,
      nEventsScoped: items.length,
      nExecuted: panel.nExecuted,
      nRealized: panel.nRealized,
      winFrac: panel.winFrac,
      meanNetReturn: panel.meanNetReturn,
      totalNetUsd: panel.totalNetUsd,
      ciLow: panel.verdict.ciLow,
      ciHigh: panel.verdict.ciHigh,
      dayCiLow: panel.verdict.dayBlockCiLow ?? NaN,
      dayCiHigh: panel.verdict.dayBlockCiHigh ?? NaN,
      zsMC: panel.verdict.zeroSkillPassRate,
      zsMCDay: panel.verdict.zeroSkillPassRateDayBlock ?? NaN,
      verdict: panel.verdict.label,
      exitKinds,
    },
    ledger: panel.ledger,
  };
}

/**
 * Grid-cell selection tiering (the pickBest idiom from tune-convergence, on the TIGHTENED verdict):
 *   1. cells that PASS on TRAIN → max ciLow (the conservative bound, never the point estimate);
 *   2. cells with sufficient counts → max ciLow (closest-to-passing);
 *   3. any cell → max meanNetReturn (descriptive only — flagged not-actionable).
 */
export function pickBestCell(rows: FluxRow[]): { best: FluxRow; basis: string } | null {
  const flat = rows.filter((r) => r && Number.isFinite(r.nRealized));
  if (flat.length === 0) return null;
  const byCiLow = (a: FluxRow, b: FluxRow): number =>
    (Number.isFinite(b.ciLow) ? b.ciLow : -Infinity) - (Number.isFinite(a.ciLow) ? a.ciLow : -Infinity);
  const passing = flat.filter((r) => r.verdict === 'PASS').sort(byCiLow);
  if (passing.length) return { best: passing[0]!, basis: 'PASS on TRAIN (max ciLow)' };
  const sufficient = flat.filter((r) => r.verdict !== 'INSUFFICIENT_DATA' && Number.isFinite(r.ciLow)).sort(byCiLow);
  if (sufficient.length) return { best: sufficient[0]!, basis: 'closest-to-passing (max ciLow, counts sufficient)' };
  const descriptive = flat
    .filter((r) => Number.isFinite(r.meanNetReturn))
    .sort((a, b) => b.meanNetReturn - a.meanNetReturn);
  return descriptive.length
    ? { best: descriptive[0]!, basis: 'descriptive only (insufficient counts — NOT actionable)' }
    : null;
}

// ── the named grid (dip-depth × momentum-window × entry-mode × exit-rule[× its knob] × recenter) ────────
export const GRID_ENTRY_MODES: Array<'dip' | 'momentum'> = ['dip', 'momentum'];
export const GRID_DIPS = [0.03, 0.05, 0.08, 0.12];
export const GRID_WINDOWS = [60, 120, 240, 480];
export const GRID_TPS = [0.06, 0.1, 0.15];
export const GRID_TRAILS = [0.05, 0.08, 0.12];
export const GRID_RECENTER = [false, true];

export function gridCells(base: FluxParams): FluxParams[] {
  const out: FluxParams[] = [];
  for (const entryMode of GRID_ENTRY_MODES) {
    for (const dip of GRID_DIPS) {
      for (const windowMin of GRID_WINDOWS) {
        for (const recenter of GRID_RECENTER) {
          for (const tp of GRID_TPS) out.push({ ...base, entryMode, dip, windowMin, recenter, exitRule: 'bracket', tp });
          for (const trail of GRID_TRAILS) out.push({ ...base, entryMode, dip, windowMin, recenter, exitRule: 'trail', trail });
        }
      }
    }
  }
  return out;
}

export function formatCell(p: FluxParams): string {
  const exit = p.exitRule === 'bracket' ? `bracket TP+${pct(p.tp, 0)}` : `trail −${pct(p.trail, 0)}`;
  return `${p.entryMode} depth ${pct(p.dip, 0)} window ${p.windowMin}m ${exit}${p.recenter ? ' +recenter' : ''} ` +
    `(sl ${p.sl} tstop ${p.tstopHours}h chw ${p.chw} max ${p.maxEntry} depth$${p.depth})`;
}

// ── ledger artifacts ───────────────────────────────────────────────────────────────────────────────────
function writeLedger(ledger: FluctuationTrade[], p: FluxParams): void {
  const header =
    'eventId,city,targetDate,entryLabel,entryLead,signalMagnitude,entryAt,entryPrice,exitAt,exitPrice,exitKind,feeUsd,netPnlUsd,netReturn\n';
  const rows = ledger.map((t) =>
    [t.eventId, t.city, t.targetDate, `"${t.entryLabel}"`, t.entryLead ?? '', Number.isFinite(t.signalMagnitude) ? t.signalMagnitude.toFixed(4) : '',
     t.entryAt, t.entryPrice.toFixed(4), t.exitAt, t.exitPrice.toFixed(4), t.exitKind, t.feeUsd.toFixed(4),
     t.netPnlUsd.toFixed(4), Number.isFinite(t.netReturn) ? t.netReturn.toFixed(4) : ''].join(','),
  );
  writeFileSync(join(OUT_DIR, 'fluctuation-ledger.csv'), header + rows.join('\n') + '\n');
  const realized = ledger.filter((t) => !t.exitKind.startsWith('mtm_'));
  const sample = realized.slice(0, 25).map((t) =>
    `  ${t.city.padEnd(13)} ${t.targetDate} lead${t.entryLead ?? '?'} ${t.entryLabel.padEnd(7)} ` +
    `buy ${t.entryPrice.toFixed(3)} (sig ${Number.isFinite(t.signalMagnitude) ? t.signalMagnitude.toFixed(3) : '—'}) → ` +
    `${t.exitKind.padEnd(22)} sell ${t.exitPrice.toFixed(3)} = ${usd(t.netPnlUsd)} (${pct(t.netReturn)})`,
  );
  const md = [`# fluctuation-taker ledger — ${formatCell(p)}`, `${realized.length} realized trades. First 25:`, '', ...sample].join('\n');
  writeFileSync(join(OUT_DIR, 'fluctuation-ledger.md'), md + '\n');
}

function emitRow(row: FluxRow, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`RESULT ${JSON.stringify({ ...extra, ...row })}\n`);
  process.stderr.write(
    `  [${row.scope}] realized ${row.nRealized}/${row.nEventsScoped} · winFrac ${pct(row.winFrac)} · ` +
    `meanNetRet ${pct(row.meanNetReturn)} · total ${usd(row.totalNetUsd)} · CI[${pct(row.ciLow)},${pct(row.ciHigh)}] ` +
    `dayCI[${pct(row.dayCiLow)},${pct(row.dayCiHigh)}] · ${row.verdict}\n`,
  );
}

// ── sanity self-test (no DB/network — mirrors the other research spines) ───────────────────────────────
export function sanity(): void {
  const cells = gridCells(DEFAULT_PARAMS);
  const expected = GRID_ENTRY_MODES.length * GRID_DIPS.length * GRID_WINDOWS.length * GRID_RECENTER.length * (GRID_TPS.length + GRID_TRAILS.length);
  if (cells.length !== expected) throw new Error(`sanity: gridCells count ${cells.length} ≠ ${expected}`);

  const row = (over: Partial<FluxRow>): FluxRow => ({
    params: DEFAULT_PARAMS, scope: 'train', nEventsScoped: 100, nExecuted: 80, nRealized: 60,
    winFrac: 0.6, meanNetReturn: 0.03, totalNetUsd: 50, ciLow: 0.01, ciHigh: 0.05,
    dayCiLow: 0.005, dayCiHigh: 0.06, zsMC: 0.02, zsMCDay: 0.03, verdict: 'PASS', exitKinds: {}, ...over,
  });
  const pick = pickBestCell([row({ ciLow: 0.005 }), row({ ciLow: 0.02 })]);
  if (!pick || Math.abs(pick.best.ciLow - 0.02) > 1e-9) throw new Error('sanity: pickBestCell max-ciLow among passers');
  const tier2 = pickBestCell([row({ verdict: 'KILL', ciLow: -0.01 }), row({ verdict: 'KILL', ciLow: -0.02 })]);
  if (!tier2 || tier2.basis.includes('PASS') || Math.abs(tier2.best.ciLow - -0.01) > 1e-9) throw new Error('sanity: tier-2 pick');
  const tier3 = pickBestCell([row({ verdict: 'INSUFFICIENT_DATA', ciLow: NaN, meanNetReturn: 0.5 })]);
  if (!tier3 || !tier3.basis.includes('NOT actionable')) throw new Error('sanity: tier-3 descriptive pick');
  if (pickBestCell([]) !== null) throw new Error('sanity: pickBestCell empty');
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  const { values } = parseArgs({
    options: {
      'build-cache': { type: 'boolean' }, 'from-cache': { type: 'boolean' }, grid: { type: 'boolean' },
      'entry-mode': { type: 'string' }, dip: { type: 'string' }, window: { type: 'string' },
      'exit-rule': { type: 'string' }, tp: { type: 'string' }, trail: { type: 'string' },
      sl: { type: 'string' }, 'tstop-hours': { type: 'string' }, chw: { type: 'string' },
      'max-entry': { type: 'string' }, depth: { type: 'string' }, recenter: { type: 'boolean' },
      'per-pos': { type: 'string' }, 'fee-rate': { type: 'string' }, slip: { type: 'string' },
      cities: { type: 'string' }, split: { type: 'boolean' }, sweep: { type: 'string' },
    },
  });

  if (values['build-cache']) {
    const { events, withDists, dists } = await buildDistsCache();
    process.stdout.write(`RESULT ${JSON.stringify({ builtCache: true, events, withDists, dists, cache: DISTS_CACHE_PATH })}\n`);
  } else {
    const num = (k: string, d: number): number => {
      const v = values[k as keyof typeof values];
      const n = Number(v);
      return v != null && Number.isFinite(n) ? n : d;
    };
    const base: FluxParams = {
      entryMode: values['entry-mode'] === 'momentum' ? 'momentum' : DEFAULT_PARAMS.entryMode,
      dip: num('dip', DEFAULT_PARAMS.dip),
      windowMin: num('window', DEFAULT_PARAMS.windowMin),
      exitRule: values['exit-rule'] === 'trail' ? 'trail' : DEFAULT_PARAMS.exitRule,
      tp: num('tp', DEFAULT_PARAMS.tp),
      trail: num('trail', DEFAULT_PARAMS.trail),
      sl: num('sl', DEFAULT_PARAMS.sl),
      tstopHours: num('tstop-hours', DEFAULT_PARAMS.tstopHours),
      chw: num('chw', DEFAULT_PARAMS.chw),
      maxEntry: num('max-entry', DEFAULT_PARAMS.maxEntry),
      depth: num('depth', DEFAULT_PARAMS.depth),
      recenter: values['recenter'] === true,
      perPos: num('per-pos', DEFAULT_PARAMS.perPos),
      feeRate: num('fee-rate', DEFAULT_PARAMS.feeRate),
      slip: num('slip', DEFAULT_PARAMS.slip),
    };

    const { events: allEvents, resolves, meta: eventsMeta } = loadCache();
    const { byEvent, meta: distsMeta } = loadDists();
    const citiesRaw = values['cities'] as string | undefined;
    const cityScope = citiesRaw
      ? new Set(citiesRaw === 'allowlist' ? BOT_DEFAULTS.cities : citiesRaw.split(',').map((s) => s.trim()))
      : null;
    const scoped = cityScope ? allEvents.filter((e) => cityScope.has(e.city)) : allEvents;
    // no silent caps: report events dropped for having NO production dist stream (they cannot be scored).
    const items: FluctuationPanelInput[] = [];
    let noDist = 0;
    for (const e of scoped) {
      const ds = byEvent.get(e.eventId);
      if (ds && ds.length > 0) items.push({ event: e, dists: ds });
      else noDist++;
    }
    process.stderr.write(`${SCRIPT} · ${eventsMeta}\n  dists: ${distsMeta}\n  panel: ${items.length} scoreable events` +
      (noDist ? ` (+${noDist} dropped: no production dist at leads 0–2)` : '') +
      (cityScope ? ` · scoped to ${new Set(items.map((x) => x.event.city)).size} cities` : '') + '\n');

    const splitScopes = (): Array<{ scope: string; its: FluctuationPanelInput[] }> => {
      const evs = items.map((x) => x.event);
      const { train, test, cutDate } = splitByDate(evs, 0.6);
      const trainSet = new Set(train.map((e: EventReplayInput) => e.eventId));
      const testSet = new Set(test.map((e: EventReplayInput) => e.eventId));
      process.stderr.write(`  split at ${cutDate}: train ${train.length} / test ${test.length} events\n`);
      return [
        { scope: 'train', its: items.filter((x) => trainSet.has(x.event.eventId)) },
        { scope: 'test', its: items.filter((x) => testSet.has(x.event.eventId)) },
        { scope: 'full', its: items },
      ];
    };

    if (values['grid']) {
      // ── the named sweep: select on TRAIN only, then quote the ONE selected cell on TEST + FULL ──
      const [trainScope, testScope, fullScope] = splitScopes() as [
        { scope: string; its: FluctuationPanelInput[] },
        { scope: string; its: FluctuationPanelInput[] },
        { scope: string; its: FluctuationPanelInput[] },
      ];
      const cells = gridCells(base);
      process.stderr.write(`  grid: ${cells.length} cells on TRAIN (${trainScope.its.length} events)\n`);
      const trainRows: FluxRow[] = [];
      for (let i = 0; i < cells.length; i++) {
        trainRows.push(run(cells[i]!, trainScope.its, resolves, 'train').row);
        if ((i + 1) % 48 === 0) process.stderr.write(`  … ${i + 1}/${cells.length} cells\n`);
      }
      const picked = pickBestCell(trainRows);
      if (!picked) {
        process.stdout.write(`RESULT ${JSON.stringify({ grid: true, error: 'no_gradeable_cell' })}\n`);
      } else {
        process.stderr.write(`\n  SELECTED on TRAIN (${picked.basis}):\n    ${formatCell(picked.best.params)}\n`);
        emitRow(picked.best, { grid: true, selected: true, basis: picked.basis });
        const testRun = run(picked.best.params, testScope.its, resolves, 'test');
        emitRow(testRun.row, { grid: true, selected: true });
        const fullRun = run(picked.best.params, fullScope.its, resolves, 'full');
        emitRow(fullRun.row, { grid: true, selected: true });
        writeLedger(fullRun.ledger, picked.best.params);
        // the top-10 train cells, for the report's honesty about the selection surface
        const top = [...trainRows]
          .sort((a, b) => (Number.isFinite(b.ciLow) ? b.ciLow : -Infinity) - (Number.isFinite(a.ciLow) ? a.ciLow : -Infinity))
          .slice(0, 10);
        for (const r of top) process.stdout.write(`RESULT ${JSON.stringify({ grid: true, top10: true, ...r })}\n`);
        writeFileSync(join(OUT_DIR, 'fluctuation-grid.json'), JSON.stringify({
          generatedAt: new Date().toISOString(), meta: { eventsMeta, distsMeta, nItems: items.length, noDist },
          basis: picked.basis, selected: picked.best, test: testRun.row, full: fullRun.row, top10: top,
        }, null, 2));
        process.stderr.write(`  → wrote out/fluctuation-grid.json + out/fluctuation-ledger.csv/.md\n`);
      }
    } else {
      const scopes = values['split'] ? splitScopes() : [{ scope: 'full', its: items }];
      const sweep = values['sweep'] as string | undefined;
      if (sweep) {
        const [param, listRaw] = sweep.split(':');
        const KEY: Record<string, keyof FluxParams> = {
          dip: 'dip', window: 'windowMin', tp: 'tp', trail: 'trail', sl: 'sl', 'tstop-hours': 'tstopHours',
          chw: 'chw', 'max-entry': 'maxEntry', depth: 'depth',
        };
        const key = KEY[String(param)];
        const vals = (listRaw ?? '').split(',').map((s) => Number(s.trim())).filter((v) => Number.isFinite(v));
        if (!key || vals.length === 0) {
          process.stderr.write(`bad --sweep "${sweep}" (params: ${Object.keys(KEY).join(', ')})\n`);
          process.exit(1);
        }
        for (const v of vals) {
          for (const { scope, its } of scopes) {
            emitRow(run({ ...base, [key]: v }, its, resolves, scope).row, { sweepParam: param, sweepValue: v });
          }
        }
      } else {
        for (const { scope, its } of scopes) {
          const r = run(base, its, resolves, scope);
          emitRow(r.row);
          if (scope === 'full') writeLedger(r.ledger, base);
        }
      }
    }
    // the objective floor note (the same discipline as sim-maker-exit): a cell only "wins" with ≥40 realized.
    process.stderr.write(`  (§9R-E count floor: ≥${GATE_MIN_MARKETS} realized markets; day-block tightening ON for all verdicts)\n`);
  }
}
