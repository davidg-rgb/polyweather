/**
 * scripts/research/tune-convergence — TUNE the opening-convergence bot's entry/exit thresholds on the LOCAL
 * price-history archive (scripts/research/out/market-history, 6 275 events / ~238 M points) joined to the bot's
 * REAL forecast seed (`bucket_probabilities.house_gaussian`/`house_ensemble`) and the true resolution.
 *
 * WHY. The forward bracket-exit screen (opening-bracket-score.ts) is STARVED: its §9R-E gate needs ≥40 resolved
 * markets but the live `opening_captures` enterable+filled panel is n≈2 (OPENING-BRACKET-REPLAY.md). The archive
 * + the archived house seed give a 708-event / 45-city / 17-day RESOLVED panel — enough for the frozen §9R-E
 * verdict AND a real out-of-sample (train/test by date) split. This harness runs the SAME pure engine
 * (`replayEvent`/`replayPanel`, one source of truth) over that panel across a grid of entry/exit thresholds,
 * picks the best cell IN-SAMPLE on TRAIN, and reports its OUT-OF-SAMPLE verdict on TEST — so the tuned thresholds
 * are not a winner's-curse artifact. It also sweeps the synthetic-book spread (→ a BREAKEVEN spread) and reports
 * the SELECTION diagnostic (does the forecast bracket the winner — the dominant lever the reality-check found).
 *
 * THE LOAD-BEARING CAVEAT (stated, not hidden). The archive is MID-ONLY; the two-sided book is SYNTHESIZED from
 * the mid via `CALIBRATED_BOOK` (fit from the live real books). So this harness measures the PRICE-PATH edge
 * (does the convergence re-rating clear spread + fees) and the THRESHOLDS that maximize it — it does NOT certify
 * executable depth at size, which stays gated by the live forward §9R-E capture on REAL books. The spread sweep +
 * the reported breakeven make the conclusion's robustness to the synth-book assumption explicit. CONVERGENCE-TUNING.md.
 *
 * Read-only: reads the DB (house seed + resolution) + the local archive; writes ONLY to out/ (a report + a
 * recommended-config artifact). Places NOTHING, never imports packages/trading.
 *
 * Run: pnpm tsx scripts/research/tune-convergence.ts                 # full panel, calibrated spread
 *      pnpm tsx scripts/research/tune-convergence.ts --sample-min 15 # coarser cadence (faster)
 *      pnpm tsx scripts/research/tune-convergence.ts --max-events 80 # smoke run
 *      pnpm tsx scripts/research/tune-convergence.ts --allowlist     # restrict to the bot's 10-city allowlist
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeScriptDb, type ScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import { replayPanel, type EventReplayInput, type TpSweepRow } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import {
  buildHistoryEvent,
  selectionDiagnostic,
  CALIBRATED_BOOK,
  type ArchiveEvent,
} from '../../packages/core/src/sim/history-replay-ingest.ts';
import { BOT_DEFAULTS, type OpeningCfg } from '../../packages/core/src/sim/opening-convergence.ts';

export const SCRIPT = 'tune-convergence';
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'out');
const ARCHIVE_ROOT = join(OUT_DIR, 'market-history');

// ── the sweep grids (entry × exit × the synthetic-book spread) ──────────────────────────────────────
export const SELECTORS = ['house_gaussian', 'house_ensemble'] as const;
export type Selector = (typeof SELECTORS)[number];
export const SPREAD_MULTS = [0, 0.5, 1, 1.5, 2];
export const CENTER_HALF_WIDTHS = [0, 1, 2];
export const MAX_ENTRY_PRICES = [0.15, 0.2, 0.25, 0.3];
export const DEPTH_FLOORS = [25, 50, 100];
export const TPS = [0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.25];
// a COARSE TP set for the (expensive) entry-grid selection pass; the full TPS refines on the SELECTED cell (§3).
export const GRID_TPS = [0.06, 0.1, 0.15, 0.25];
export const SL_DELTAS = [0.08, 0.12, 0.2, 0.99]; // 0.99 ≈ "no stop"
export const TIME_STOPS = [11, 12, 14, 16];
export const TRAIN_FRAC = 0.6; // earliest 60% of distinct dates = TRAIN, the rest = TEST

// ── types ───────────────────────────────────────────────────────────────────────────────────────────
/** one panel event: the DB meta (seed + resolution) + its parsed archive price paths. */
export interface PanelEvent {
  eventId: string;
  city: string;
  tz: string;
  targetDate: string; // the station-local WEATHER DAY (DB) — the time-stop calendar day
  winnerIdx: number | null;
  gradingMismatch: boolean;
  gaussian: Map<number, number>;
  ensemble: Map<number, number>;
  archive: ArchiveEvent;
  createdAtMs: number | null;
}

/** a grid cell's identity (the entry/exit/spread knobs) + the TP-swept verdict rows on the scored subset. */
export interface GridCell {
  selector: Selector;
  spreadMult: number;
  centerHalfWidth: number;
  maxEntryPrice: number;
  depthFloorUsd: number;
  rows: TpSweepRow[]; // one per TP
}

// ── pure helpers (exported for the tests) ───────────────────────────────────────────────────────────

const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));

/** Split events into TRAIN (earliest `trainFrac` of distinct dates) and TEST (the rest). Pure. */
export function splitByDate(
  events: EventReplayInput[],
  trainFrac: number,
): { train: EventReplayInput[]; test: EventReplayInput[]; cutDate: string | null } {
  const dates = [...new Set(events.map((e) => e.targetDate))].sort();
  if (dates.length < 2) return { train: events, test: [], cutDate: null };
  const cutIdx = Math.max(1, Math.min(dates.length - 1, Math.floor(dates.length * trainFrac)));
  const trainDates = new Set(dates.slice(0, cutIdx));
  const train = events.filter((e) => trainDates.has(e.targetDate));
  const test = events.filter((e) => !trainDates.has(e.targetDate));
  return { train, test, cutDate: dates[cutIdx] ?? null };
}

/** does a TP row clear the frozen §9R-E count floors AND show an in-sample edge (winFrac ≥ .5 & ciLow > 0)? */
export function rowPasses(r: TpSweepRow): boolean {
  return (
    r.nMarkets >= BOT_DEFAULTS.gate.minMarkets &&
    r.nCities >= BOT_DEFAULTS.gate.minCities &&
    r.nDistinctDays >= BOT_DEFAULTS.gate.minDistinctDays &&
    r.winFrac >= BOT_DEFAULTS.gate.minWinFrac &&
    fin(r.ciLow) &&
    r.ciLow > 0
  );
}

/** has a TP row enough counts for the §9R-E gate to even render a PASS/KILL (vs INSUFFICIENT)? */
export function rowSufficient(r: TpSweepRow): boolean {
  return (
    r.nMarkets >= BOT_DEFAULTS.gate.minMarkets &&
    r.nCities >= BOT_DEFAULTS.gate.minCities &&
    r.nDistinctDays >= BOT_DEFAULTS.gate.minDistinctDays
  );
}

/** A flattened (cell, TP) candidate the selector ranks. */
export interface CellTp {
  cell: Omit<GridCell, 'rows'>;
  row: TpSweepRow;
}

/**
 * Pick the best (cell, TP) on a set of cells' TP rows. Preference order, each a winner's-curse-aware tightening:
 *   1. rows that PASS the §9R-E bar in-sample (counts + winFrac + ciLow>0), by MAX ciLow (the conservative lower
 *      bound, not the point estimate — shrinkage, the entry-watch idiom);
 *   2. else rows with sufficient counts, by MAX ciLow (the closest-to-passing);
 *   3. else any row, by MAX meanNetReturn (purely descriptive — flagged not-actionable).
 * Returns null only on an empty input. The `basis` says which tier won.
 */
export function pickBest(cells: GridCell[]): { best: CellTp; basis: string } | null {
  const flat: CellTp[] = [];
  for (const c of cells) for (const row of c.rows) flat.push({ cell: { ...c, rows: [] } as Omit<GridCell, 'rows'>, row });
  if (flat.length === 0) return null;
  const byCiLow = (a: CellTp, b: CellTp): number => (b.row.ciLow || -Infinity) - (a.row.ciLow || -Infinity);

  const passing = flat.filter((x) => rowPasses(x.row)).sort(byCiLow);
  if (passing.length) return { best: passing[0]!, basis: 'PASS in-sample (max ciLow)' };

  const sufficient = flat.filter((x) => rowSufficient(x.row) && fin(x.row.ciLow)).sort(byCiLow);
  if (sufficient.length) return { best: sufficient[0]!, basis: 'closest-to-passing (max ciLow, counts sufficient)' };

  const descriptive = flat
    .filter((x) => fin(x.row.meanNetReturn))
    .sort((a, b) => (b.row.meanNetReturn || -Infinity) - (a.row.meanNetReturn || -Infinity));
  return descriptive.length ? { best: descriptive[0]!, basis: 'descriptive only (insufficient counts — NOT actionable)' } : null;
}

/**
 * The breakeven spread multiplier: the smallest `spreadMult` at which the headline mean net return crosses from
 * ≥0 to <0 (linearly interpolated between the bracketing knots). null if it is negative even at spread 0 (no edge
 * at any cost) or positive even at the widest swept spread (robust). Pure.
 */
export function breakevenSpread(points: { spreadMult: number; meanNetReturn: number }[]): number | null {
  const pts = points.filter((p) => fin(p.spreadMult) && fin(p.meanNetReturn)).sort((a, b) => a.spreadMult - b.spreadMult);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (a.meanNetReturn >= 0 && b.meanNetReturn < 0) {
      const w = a.meanNetReturn / (a.meanNetReturn - b.meanNetReturn); // fraction toward b where it hits 0
      return a.spreadMult + w * (b.spreadMult - a.spreadMult);
    }
  }
  return null;
}

// ── DB + archive loading (impure) ────────────────────────────────────────────────────────────────────

/** Build eventId → archive filepath over the whole local archive (filenames are {date}__{eventId}.json). */
export function indexArchive(root: string): Map<string, string> {
  const idx = new Map<string, string>();
  if (!existsSync(root)) return idx;
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = join(root, d.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const eventId = f.replace(/\.json$/, '').split('__').pop();
      if (eventId) idx.set(eventId, join(dir, f));
    }
  }
  return idx;
}

const toProbMap = (probs: unknown): Map<number, number> => {
  const m = new Map<number, number>();
  if (Array.isArray(probs)) probs.forEach((p, i) => { if (fin(p)) m.set(i, Number(p)); });
  return m;
};

/** Load the resolved-with-house-seed panel from the DB, joined to its local archive price paths. */
export async function loadPanel(db: ScriptDb, archiveIdx: Map<string, string>, allowlistOnly: boolean): Promise<PanelEvent[]> {
  const rows = await db.query<Record<string, unknown>>(
    `with ev as (
       select me.id, me.poly_event_id, c.slug city, c.tz tz, me.target_date::text target_date,
              coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) winner_idx, me.grading_mismatch
         from market_events me
         join cities c on c.id = me.city_id
        where me.poly_event_id is not null
          and coalesce(me.poly_resolved_winner_idx, me.winning_bucket_idx) is not null
          and exists (select 1 from bucket_probabilities bp where bp.event_id=me.id and bp.source='house_gaussian')
          ${allowlistOnly ? 'and c.slug = any($1::text[])' : ''}
     ),
     hg as (select distinct on (bp.event_id) bp.event_id, bp.probs from bucket_probabilities bp
              join ev on ev.id=bp.event_id where bp.source='house_gaussian' order by bp.event_id, bp.made_at asc),
     he as (select distinct on (bp.event_id) bp.event_id, bp.probs from bucket_probabilities bp
              join ev on ev.id=bp.event_id where bp.source='house_ensemble' order by bp.event_id, bp.made_at asc)
     select ev.poly_event_id, ev.city, ev.tz, ev.target_date, ev.winner_idx, ev.grading_mismatch,
            hg.probs house_gaussian, he.probs house_ensemble
       from ev left join hg on hg.event_id=ev.id left join he on he.event_id=ev.id`,
    allowlistOnly ? [BOT_DEFAULTS.cities] : [],
  );

  const out: PanelEvent[] = [];
  let missingFile = 0;
  for (const r of rows) {
    const eventId = String(r['poly_event_id']);
    const path = archiveIdx.get(eventId);
    if (!path) { missingFile++; continue; }
    let archive: ArchiveEvent;
    try {
      archive = JSON.parse(readFileSync(path, 'utf8')) as ArchiveEvent;
    } catch { missingFile++; continue; }
    const createdAtMs = archive.createdAt ? new Date(archive.createdAt).getTime() : null;
    out.push({
      eventId,
      city: String(r['city']),
      tz: String(r['tz'] ?? ''),
      targetDate: String(r['target_date']),
      winnerIdx: fin(r['winner_idx']) ? Number(r['winner_idx']) : null,
      gradingMismatch: r['grading_mismatch'] === true,
      gaussian: toProbMap(r['house_gaussian']),
      ensemble: toProbMap(r['house_ensemble']),
      archive,
      createdAtMs: Number.isFinite(createdAtMs as number) ? createdAtMs : null,
    });
  }
  if (missingFile) process.stderr.write(`  (${missingFile} DB events had no local archive file — skipped)\n`);
  return out;
}

/** Assemble the engine inputs for one (selector, spreadMult). Drops events the selector cannot seed. */
export function buildSet(panel: PanelEvent[], selector: Selector, spreadMult: number, sampleMin: number): EventReplayInput[] {
  const out: EventReplayInput[] = [];
  for (const p of panel) {
    const seed = selector === 'house_gaussian' ? p.gaussian : p.ensemble;
    if (seed.size === 0) continue; // this selector has no seed for the event
    const input = buildHistoryEvent(p.archive, {
      houseProbByIdx: seed,
      resolution: { winnerIdx: p.winnerIdx, gradingMismatch: p.gradingMismatch },
      targetDate: p.targetDate,
      tz: p.tz,
      spreadMult,
      sampleEveryMin: sampleMin,
      createdAtMs: p.createdAtMs,
      // every swept time-stop is ≤16:00 local; trim the dead post-weather-day tail at 20:00 local (verdict-
      // preserving — it cuts ~half the ticks/allocations without touching any entry/exit decision or P&L).
      trimAtLocalHour: 20,
    });
    if (input) out.push(input);
  }
  return out;
}

const baseCfg = (cities: string[], over: Partial<OpeningCfg>): OpeningCfg => ({ ...BOT_DEFAULTS, cities, ...over });

// ── report (pure-ish — takes the computed numbers, returns lines) ─────────────────────────────────────
const pct = (v: number, d = 1): string => (fin(v) ? `${(v * 100).toFixed(d)}%` : '—');
const spct = (v: number): string => (fin(v) ? `${v >= 0 ? '+' : ''}${pct(v)}` : '—');

export function formatCell(c: Omit<GridCell, 'rows'>, tp: number): string {
  return `${c.selector.replace('house_', '')} chw${c.centerHalfWidth} max${c.maxEntryPrice} depth$${c.depthFloorUsd} TP+${pct(tp, 0)} spread×${c.spreadMult}`;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'sample-min': { type: 'string' },
      'max-events': { type: 'string' },
      allowlist: { type: 'boolean' },
    },
  });
  const sampleMin = Math.max(1, Math.floor(Number(values['sample-min'] ?? 10) || 10));
  const maxEvents = values['max-events'] != null ? Math.max(1, Math.floor(Number(values['max-events']))) : null;
  const allowlistOnly = values.allowlist ?? false;
  mkdirSync(OUT_DIR, { recursive: true });

  const log = (m: string): void => console.log(m);
  process.stderr.write(`${SCRIPT} · ${new Date().toISOString()} · loading DB house seed ⋈ local archive (read-only)\n`);

  const archiveIdx = indexArchive(ARCHIVE_ROOT);
  process.stderr.write(`  archive index: ${archiveIdx.size} events on disk\n`);

  const db = makeScriptDb();
  const lines: string[] = [];
  const emit = (m: string): void => { log(m); lines.push(m); };
  try {
    let panel = await loadPanel(db, archiveIdx, allowlistOnly);
    if (maxEvents) panel = panel.slice(0, maxEvents);
    const cities = [...new Set(panel.map((p) => p.city))];
    const days = [...new Set(panel.map((p) => p.targetDate))].sort();
    emit('=== tune-convergence · TUNE entry/exit thresholds on the 708-event resolved archive panel ===');
    emit(`  panel: ${panel.length} events · ${cities.length} cities · ${days.length} days (${days[0]}…${days[days.length - 1]})` +
      (allowlistOnly ? ' · BOT ALLOWLIST only' : '') + ` · ${sampleMin}-min cadence`);
    emit('  engine: the SAME replayEvent/replayPanel the live capture drives (one source of truth). Book SYNTHESIZED');
    emit('  from the mid via CALIBRATED_BOOK (spread×1 = calibrated); the historical edge is the PRICE-PATH edge —');
    emit('  executable depth at size stays gated by the live forward §9R-E capture. CONVERGENCE-TUNING.md.');
    emit('');

    if (panel.length < 10) {
      emit('  INSUFFICIENT panel (<10 events joined). Is the archive pulled (pull-market-history) + the DB reachable?');
      writeReport(lines, { error: 'insufficient_panel', panel: panel.length });
      return;
    }

    // ── 1 · SELECTION diagnostic — the dominant lever (does the forecast bracket the eventual winner?) ────
    emit('--- 1 · SELECTION diagnostic (does the forecast bracket the winner — the dominant lever) ---');
    emit(`  ${'selector'.padEnd(16)}${'chw'.padStart(4)}${'seeded'.padStart(8)}${'winInBought'.padStart(12)}${'winnerHarvest(open→peakBid)'.padStart(28)}`);
    const selDiag: Record<string, unknown>[] = [];
    for (const selector of SELECTORS) {
      for (const chw of CENTER_HALF_WIDTHS) {
        let seeded = 0, inBought = 0;
        const harvest: number[] = [];
        for (const p of panel) {
          const seed = selector === 'house_gaussian' ? p.gaussian : p.ensemble;
          const d = selectionDiagnostic(seed, p.winnerIdx, chw);
          if (!d) continue;
          seeded++;
          if (d.winnerInBought) {
            inBought++;
            // the winner's harvestable re-rating: its peak archive mid after open − its open mid (forecast-free).
            const wb = p.archive.buckets.find((b) => b.idx === p.winnerIdx);
            if (wb && wb.points.length > 1) {
              const open = wb.points[0]![1];
              const peak = Math.max(...wb.points.map((pt) => pt[1]));
              if (fin(open) && fin(peak)) harvest.push(peak - open);
            }
          }
        }
        const meanHarvest = harvest.length ? harvest.reduce((a, b) => a + b, 0) / harvest.length : NaN;
        emit(`  ${selector.padEnd(16)}${String(chw).padStart(4)}${String(seeded).padStart(8)}` +
          `${pct(seeded ? inBought / seeded : NaN).padStart(12)}${spct(meanHarvest).padStart(28)}`);
        selDiag.push({ selector, chw, seeded, winInBoughtFrac: seeded ? inBought / seeded : null, meanWinnerHarvest: meanHarvest });
      }
    }
    emit('  (winnerHarvest = mean, over markets where the winner was bracketed, of the winner bucket\'s peak mid −');
    emit('   its open mid — the upside a perfect exit on the WINNER could harvest; the basket nets the losers against it.)');
    emit('');

    // ── 2 · the GRID on TRAIN (select) → TEST (validate). spread×1 (calibrated). ──────────────────────────
    emit('--- 2 · entry-grid sweep on TRAIN, validated OUT-OF-SAMPLE on TEST (calibrated spread ×1) ---');
    // SELECTION is on TRAIN only (the FULL/TEST scoring of just the WINNING cell happens after pickBest — so the
    // grid does not pay to score every cell on the full panel; that was pure redundant compute).
    const trainCells: GridCell[] = [];
    const splitMeta: { selector: Selector; trainN: number; testN: number; cut: string | null }[] = [];
    for (const selector of SELECTORS) {
      const set = buildSet(panel, selector, 1, sampleMin);
      const { train, test, cutDate } = splitByDate(set, TRAIN_FRAC);
      splitMeta.push({ selector, trainN: train.length, testN: test.length, cut: cutDate });
      for (const chw of CENTER_HALF_WIDTHS) {
        for (const maxEntry of MAX_ENTRY_PRICES) {
          for (const depth of DEPTH_FLOORS) {
            const cfg = baseCfg(cities, { centerHalfWidth: chw, maxEntryPrice: maxEntry, depthFloorUsd: depth });
            const id = { selector, spreadMult: 1, centerHalfWidth: chw, maxEntryPrice: maxEntry, depthFloorUsd: depth };
            trainCells.push({ ...id, rows: replayPanel(train, cfg, GRID_TPS).perTp });
          }
        }
      }
    }
    for (const m of splitMeta) emit(`  ${m.selector}: TRAIN ${m.trainN} / TEST ${m.testN} events (cut at ${m.cut})`);
    emit('');

    const picked = pickBest(trainCells);
    if (!picked) { emit('  no gradeable cell on TRAIN.'); writeReport(lines, { error: 'no_cell' }); return; }
    const { best, basis } = picked;
    emit(`  SELECTED on TRAIN (${basis}):`);
    emit(`    ${formatCell(best.cell, best.row.tpDeltaPp)}`);
    emit(`    TRAIN: n=${best.row.nMarkets} winFrac ${pct(best.row.winFrac)} meanNetRet ${spct(best.row.meanNetReturn)} ` +
      `CI[${pct(best.row.ciLow)},${pct(best.row.ciHigh)}] zsMC ${pct(best.row.zeroSkillPassRate)} ruleRoi ${spct(best.row.ruleCaptureRoi)} → ${best.row.label}`);

    // evaluate the SAME (cell, TP) on TEST and on the FULL panel
    const evalOn = (events: EventReplayInput[]): TpSweepRow => {
      const cfg = baseCfg(cities, {
        centerHalfWidth: best.cell.centerHalfWidth, maxEntryPrice: best.cell.maxEntryPrice,
        depthFloorUsd: best.cell.depthFloorUsd, tpDeltaPp: best.row.tpDeltaPp,
      });
      const r = replayPanel(events, cfg, [best.row.tpDeltaPp]).perTp.find((x) => x.tpDeltaPp === best.row.tpDeltaPp);
      return r as TpSweepRow;
    };
    const setSel = buildSet(panel, best.cell.selector, 1, sampleMin);
    const { test: testSet } = splitByDate(setSel, TRAIN_FRAC);
    const testRow = evalOn(testSet);
    const fullRow = evalOn(setSel);
    emit(`    TEST  (out-of-sample): n=${testRow.nMarkets} winFrac ${pct(testRow.winFrac)} meanNetRet ${spct(testRow.meanNetReturn)} ` +
      `CI[${pct(testRow.ciLow)},${pct(testRow.ciHigh)}] zsMC ${pct(testRow.zeroSkillPassRate)} → ${testRow.label}`);
    emit(`    FULL  panel:          n=${fullRow.nMarkets} winFrac ${pct(fullRow.winFrac)} meanNetRet ${spct(fullRow.meanNetReturn)} ` +
      `CI[${pct(fullRow.ciLow)},${pct(fullRow.ciHigh)}] zsMC ${pct(fullRow.zeroSkillPassRate)} → ${fullRow.label}`);
    emit('');

    // headline pre-registered TP (+25%) at the selected cell, for the honest "stock bot" read
    const headlineRow = setSel.length ? (() => {
      const cfg = baseCfg(cities, {
        centerHalfWidth: best.cell.centerHalfWidth, maxEntryPrice: best.cell.maxEntryPrice, depthFloorUsd: best.cell.depthFloorUsd,
      });
      return replayPanel(setSel, cfg, TPS).perTp.find((x) => x.tpDeltaPp === BOT_DEFAULTS.tpDeltaPp) as TpSweepRow;
    })() : null;
    if (headlineRow) emit(`  reference — the PRE-REGISTERED TP +25% at the selected entry cell (FULL): n=${headlineRow.nMarkets} ` +
      `winFrac ${pct(headlineRow.winFrac)} meanNetRet ${spct(headlineRow.meanNetReturn)} → ${headlineRow.label}`);
    emit('');

    // ── 3 · the TP sweep at the selected entry cell (FULL panel) ──────────────────────────────────────
    emit('--- 3 · take-profit sweep at the selected entry cell (FULL panel) ---');
    emit(`  ${'TP'.padStart(5)}${'nMkts'.padStart(7)}${'exec%'.padStart(8)}${'winFrac'.padStart(9)}${'meanNetRet'.padStart(12)}${'CI95'.padStart(20)}${'ruleRoi'.padStart(9)}${'verdict'.padStart(20)}`);
    const fullCellRows = replayPanel(setSel, baseCfg(cities, {
      centerHalfWidth: best.cell.centerHalfWidth, maxEntryPrice: best.cell.maxEntryPrice, depthFloorUsd: best.cell.depthFloorUsd,
    }), TPS).perTp;
    for (const r of fullCellRows) {
      const mark = r.tpDeltaPp === best.row.tpDeltaPp ? '◀ sel' : (r.tpDeltaPp === BOT_DEFAULTS.tpDeltaPp ? '· pre' : '');
      emit(`  ${('+' + pct(r.tpDeltaPp, 0)).padStart(5)}${String(r.nMarkets).padStart(7)}${pct(r.executedFrac).padStart(8)}` +
        `${pct(r.winFrac).padStart(9)}${spct(r.meanNetReturn).padStart(12)}${`[${pct(r.ciLow)},${pct(r.ciHigh)}]`.padStart(20)}` +
        `${spct(r.ruleCaptureRoi).padStart(9)}${r.label.padStart(16)} ${mark}`);
    }
    emit('');

    // ── 4 · the SPREAD sweep at the selected cell → breakeven (FULL panel) ─────────────────────────────
    emit('--- 4 · synthetic-book SPREAD sweep at the selected cell → breakeven (FULL panel) ---');
    emit(`  ${'spread×'.padStart(8)}${'nMkts'.padStart(7)}${'winFrac'.padStart(9)}${'meanNetRet'.padStart(12)}${'CI95'.padStart(20)}${'verdict'.padStart(18)}`);
    const spreadPts: { spreadMult: number; meanNetReturn: number }[] = [];
    for (const sm of SPREAD_MULTS) {
      const set = buildSet(panel, best.cell.selector, sm, sampleMin);
      const cfg = baseCfg(cities, {
        centerHalfWidth: best.cell.centerHalfWidth, maxEntryPrice: best.cell.maxEntryPrice,
        depthFloorUsd: best.cell.depthFloorUsd, tpDeltaPp: best.row.tpDeltaPp,
      });
      const r = replayPanel(set, cfg, [best.row.tpDeltaPp]).perTp.find((x) => x.tpDeltaPp === best.row.tpDeltaPp) as TpSweepRow;
      spreadPts.push({ spreadMult: sm, meanNetReturn: r.meanNetReturn });
      emit(`  ${('×' + sm).padStart(8)}${String(r.nMarkets).padStart(7)}${pct(r.winFrac).padStart(9)}${spct(r.meanNetReturn).padStart(12)}` +
        `${`[${pct(r.ciLow)},${pct(r.ciHigh)}]`.padStart(20)}${r.label.padStart(18)}`);
    }
    const be = breakevenSpread(spreadPts);
    emit(`  breakeven spread multiplier: ${be == null ? (spreadPts[0]!.meanNetReturn < 0 ? 'NONE (negative even at spread 0)' : 'ROBUST (positive through the widest swept spread)') : '×' + be.toFixed(2) + ' of the calibrated spread'}`);
    emit('');

    // ── 5 · the EXIT sweep (SL × time-stop) at the selected cell, calibrated spread (FULL panel) ───────
    emit('--- 5 · exit sweep: stop-loss × time-stop at the selected cell (FULL panel, spread ×1) ---');
    emit(`  ${'SL'.padStart(6)}${'tStop'.padStart(7)}${'nMkts'.padStart(7)}${'winFrac'.padStart(9)}${'meanNetRet'.padStart(12)}${'CI95'.padStart(20)}${'verdict'.padStart(18)}`);
    let bestExit: { sl: number; ts: number; row: TpSweepRow } | null = null;
    for (const sl of SL_DELTAS) {
      for (const ts of TIME_STOPS) {
        const cfg = baseCfg(cities, {
          centerHalfWidth: best.cell.centerHalfWidth, maxEntryPrice: best.cell.maxEntryPrice,
          depthFloorUsd: best.cell.depthFloorUsd, tpDeltaPp: best.row.tpDeltaPp, slDeltaPp: sl, timeStopLocalHour: ts,
        });
        const r = replayPanel(setSel, cfg, [best.row.tpDeltaPp]).perTp.find((x) => x.tpDeltaPp === best.row.tpDeltaPp) as TpSweepRow;
        emit(`  ${sl.toFixed(2).padStart(6)}${String(ts).padStart(7)}${String(r.nMarkets).padStart(7)}${pct(r.winFrac).padStart(9)}` +
          `${spct(r.meanNetReturn).padStart(12)}${`[${pct(r.ciLow)},${pct(r.ciHigh)}]`.padStart(20)}${r.label.padStart(18)}`);
        if (rowSufficient(r) && fin(r.ciLow) && (!bestExit || r.ciLow > bestExit.row.ciLow)) bestExit = { sl, ts, row: r };
      }
    }
    emit('');

    // ── 6 · the verdict + the recommended config ──────────────────────────────────────────────────────
    emit('--- 6 · VERDICT + recommended config ---');
    const passes = testRow.label === 'PASS' && fullRow.label === 'PASS';
    if (passes) {
      emit('  ✅ A tuned threshold set clears the frozen §9R-E gate OUT-OF-SAMPLE and on the full panel.');
    } else {
      emit('  ❌ NO tuned threshold set clears the frozen §9R-E gate out-of-sample on this archive panel.');
      emit('     The convergence price-path edge does NOT survive the synthetic-but-calibrated round-trip cost net of');
      emit('     fees at the cheap entry depths the bot can actually reach — consistent with the reality-check finding');
      emit('     that cheap buckets re-rate DOWN on average (the selection, not the exit, is the binding constraint).');
    }
    const rec = {
      selector: best.cell.selector,
      'bot.centerHalfWidth': best.cell.centerHalfWidth,
      'bot.maxEntryPrice': best.cell.maxEntryPrice,
      'bot.depthFloorUsd': best.cell.depthFloorUsd,
      'bot.tpDeltaPp': best.row.tpDeltaPp,
      'bot.slDeltaPp': bestExit?.sl ?? BOT_DEFAULTS.slDeltaPp,
      'bot.timeStopLocalHour': bestExit?.ts ?? BOT_DEFAULTS.timeStopLocalHour,
    };
    emit(`  recommended cell: ${JSON.stringify(rec)}`);
    emit(`  consensusSource: the better SELECTOR here was ${best.cell.selector} ` +
      `(${best.cell.selector === 'house_ensemble' ? 'the RAW ensemble — matches the 2026-06-29 convergence/accuracy split' : 'the calibrated gaussian'}).`);
    emit(passes
      ? '  → eligible to PROPOSE these as config overrides, STILL gated behind a live forward §9R-E re-confirm on real-book depth.'
      : '  → DO NOT change live config to chase this; the gate is the discipline. Record the result; the rail stays DORMANT.');
    emit('');
    emit('  CAVEATS: synthetic (calibrated) book — see the spread sweep + breakeven; 17-day temporal extent; TP/SL/exit');
    emit('  sweeps are EXPLORATORY (the OOS TEST row is the honest read). Defers to the live §9R-E capture + the operator.');

    writeReport(lines, {
      generatedAt: new Date().toISOString(),
      panel: { events: panel.length, cities: cities.length, days: days.length, span: [days[0], days[days.length - 1]], allowlistOnly, sampleMin },
      selectionDiagnostic: selDiag,
      selectedOnTrain: { cell: best.cell, tp: best.row.tpDeltaPp, basis, train: best.row },
      test: testRow, full: fullRow, headlinePreReg: headlineRow,
      tpSweep: fullCellRows, spreadSweep: spreadPts, breakevenSpread: be,
      bestExit, recommended: rec, passesOutOfSample: passes,
    });
  } finally {
    await db.end();
  }
}

function writeReport(lines: string[], json: unknown): void {
  writeFileSync(join(OUT_DIR, 'tune-convergence.md'), lines.join('\n') + '\n');
  writeFileSync(join(OUT_DIR, 'tune-convergence.json'), JSON.stringify(json, null, 2));
  process.stderr.write(`\n  → wrote out/tune-convergence.md + out/tune-convergence.json\n`);
}

// ── sanity self-test (no DB/network — mirrors the other research spines) ───────────────────────────────
export function sanity(): void {
  // splitByDate
  const mk = (d: string): EventReplayInput => ({ eventId: d, city: 'x', targetDate: d, tz: 'UTC', ticks: [], resolution: { winnerIdx: null, gradingMismatch: false } });
  const evs = ['2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17'].map(mk);
  const sp = splitByDate(evs, 0.6);
  if (sp.train.length !== 3 || sp.test.length !== 2) throw new Error('sanity: splitByDate 60/40');
  if (splitByDate([mk('a')], 0.6).test.length !== 0) throw new Error('sanity: splitByDate single-day');

  // breakevenSpread interpolation
  const be = breakevenSpread([{ spreadMult: 0, meanNetReturn: 0.04 }, { spreadMult: 1, meanNetReturn: -0.04 }]);
  if (be == null || Math.abs(be - 0.5) > 1e-9) throw new Error('sanity: breakevenSpread midpoint');
  if (breakevenSpread([{ spreadMult: 0, meanNetReturn: -0.01 }, { spreadMult: 1, meanNetReturn: -0.05 }]) != null) throw new Error('sanity: breakeven none');
  if (breakevenSpread([{ spreadMult: 0, meanNetReturn: 0.05 }, { spreadMult: 2, meanNetReturn: 0.01 }]) != null) throw new Error('sanity: breakeven robust');

  // pickBest tiering
  const row = (over: Partial<TpSweepRow>): TpSweepRow => ({
    tpDeltaPp: 0.1, nEvents: 100, nExecuted: 80, executedFrac: 0.8, nMarkets: 50, nCities: 8, nDistinctDays: 9,
    winFrac: 0.6, meanNetReturn: 0.03, ciLow: 0.01, ciHigh: 0.05, zeroSkillPassRate: 0.02,
    ruleCaptureRoi: 0.03, avgBestReachableRoundtrip: 0.1, label: 'PASS', reason: '', ...over,
  });
  const cell = (rows: TpSweepRow[]): GridCell => ({ selector: 'house_gaussian', spreadMult: 1, centerHalfWidth: 1, maxEntryPrice: 0.2, depthFloorUsd: 50, rows });
  const passPick = pickBest([cell([row({ ciLow: 0.005 }), row({ ciLow: 0.02 })])]);
  if (!passPick || Math.abs(passPick.best.row.ciLow - 0.02) > 1e-9) throw new Error('sanity: pickBest max-ciLow among passers');
  const insufficient = pickBest([cell([row({ nMarkets: 5, label: 'INSUFFICIENT_DATA', ciLow: NaN, meanNetReturn: 0.5 })])]);
  if (!insufficient || !insufficient.basis.includes('NOT actionable')) throw new Error('sanity: pickBest descriptive tier');
  if (pickBest([]) !== null) throw new Error('sanity: pickBest empty');

  // rowPasses / rowSufficient floors
  if (!rowPasses(row({}))) throw new Error('sanity: rowPasses true');
  if (rowPasses(row({ ciLow: -0.01 }))) throw new Error('sanity: rowPasses ciLow gate');
  if (rowPasses(row({ nCities: 4 }))) throw new Error('sanity: rowPasses cities floor');
  if (rowSufficient(row({ nDistinctDays: 3 }))) throw new Error('sanity: rowSufficient days floor');
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  await main();
}
