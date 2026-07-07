/**
 * google-fahrenheit-diagnostic.ts — root-cause the °F (US) underperformance in the Google-picks-bucket panel.
 *
 * THE ANOMALY. In the buy/sell sweep (google-convergence-sweep.ts) the °F (US, Fahrenheit ladder) cities went
 * 0-for-6 realized under the live frozen config while °C cities went ~8/18 (≈44%). Dropping °F is the single
 * biggest P&L lever. THIS script asks WHY, and whether it is a fixable rounding artefact or genuine forecast miss.
 *
 * THE PRIMARY HYPOTHESIS (a °C→°F rounding artefact). googleBucketIdx (google-bucket-replay.ts) converts Google's
 * °C forecast to the city's native unit (cToF for °F cities) and then Math.FLOORs to the whole degree before
 * finding the ladder bucket — a deliberate spec choice. But the market/WU grades the daily high on the ROUND-HALF-UP
 * whole degree. °C→°F conversion of even a whole °C lands fractional (31.0°C → 87.8°F, 34.0°C → 93.2°F), so whenever
 * the converted value is ≥ x.5 the FLOOR assigns a bucket ONE DEGREE TOO LOW vs rounding — a systematic −1-bucket
 * (cold) bias that °C cities barely feel. If a perfect Google forecast still misses the graded bucket, the floor is
 * the culprit, not the forecast.
 *
 * WHAT THIS DOES (READ-ONLY). Pulls the EXACT same google_paper_inputs the panel/sweep pull, rebuilds the events,
 * and for every bucketable event computes THREE buckets and compares them to the ACTUAL resolved winner:
 *   • FLOOR bucket   = Math.floor(native)   — what we actually bought (byte-identical to the engine's googleBucketIdx).
 *   • ROUND bucket   = Math.round(native)    — the counterfactual fix (== wuRound for the positive °F temps here).
 *   • WINNER bucket  = resolution.winnerIdx  — the venue's graded truth.
 * It reports per-event rows + °F-vs-°C cohort summaries (floor hit-rate, round hit-rate, mean signed bucket-offset
 * floor-vs-winner and round-vs-winner — the offset decomposes ARTEFACT from genuine bias), a FLIP analysis (of the
 * floor-entered °F losers, how many the round bucket would rescue), and an entry-band sensitivity.
 *
 * REPRODUCIBILITY NOTE (load-bearing). This script PINS its own replay config (PINNED_CFG below) and computes the
 * floor/round bucket LOCALLY — it does NOT spread the engine's live GOOGLE_DEFAULTS, because that object is being
 * edited by the operator concurrently (during this investigation it flipped askMax 0.15→0.12 and gained an
 * excludeFahrenheit flag). Coupling the analysis to a moving default silently changes the entered population between
 * runs. We DO read the live GOOGLE_DEFAULTS once, for display + a consistency check that the engine's googleBucketIdx
 * still equals our local floor (it flags a warning if the operator swaps floor→round under us).
 *
 * READ-ONLY (identical DATABASE_URL path as google-convergence-sweep.ts). No writes, no capital, no config change.
 * Run:  pnpm tsx scripts/research/google-fahrenheit-diagnostic.ts
 */
import { loadEnv } from '../lib/load-env.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { buildEvents, type RawCaptureRow, type Resolution } from '../../packages/core/src/sim/opening-bracket-ingest.ts';
import type { EventReplayInput, ReplayTick } from '../../packages/core/src/sim/opening-bracket-replay.ts';
import type { RawResolution } from '../../packages/core/src/sim/opening-convergence-view.ts';
import { googleBucketIdx, replayGoogleBracket, GOOGLE_DEFAULTS, type GoogleBracketCfg } from '../../packages/core/src/sim/google-bucket-replay.ts';
import { parseBucketLabel, winningBucket } from '../../packages/core/src/buckets.ts';
import { cToF } from '../../packages/core/src/units.ts';
import { BOT_DEFAULTS, parseBotConfig } from '../../packages/core/src/sim/opening-convergence.ts';
import type { OpeningBucket } from '../../packages/core/src/sim/opening-convergence.ts';
import type { Unit } from '../../packages/core/src/types.ts';

const PANEL_DAYS = 21; // the gate window — matches the edge fn / the sweep
const FETCH_CONCURRENCY = 1; // SEQUENTIAL — the Micro DB self-contends under concurrency

/**
 * The config PINNED for this analysis — the band under which the anomaly was observed (ask 10–15¢, the sweep's
 * BASELINE cell), NOT the live GOOGLE_DEFAULTS (which the operator is editing concurrently). excludeFahrenheit is
 * forced FALSE so the engine replays °F (replayGoogleBracket ignores it anyway — it is a VIEW-level filter). Pinning
 * askMax=0.15 reproduces the sweep's "0-for-6 °F" headline; the sensitivity block sweeps the ceiling separately.
 */
const PINNED_CFG: GoogleBracketCfg = {
  cities: [],
  perPositionUsd: 20,
  askMin: 0.1,
  askMax: 0.15,
  tpAbs: 0.3,
  slAbs: 0,
  paperSlippage: 0.01,
  takerFeeRate: 0.05,
  minHoursToResolution: 20,
  excludeFahrenheit: false,
  maxEntryAgeH: 0, // age gate DISABLED for this analysis — reproduce the original band-[0.15] °F headline at any age
};

const pct = (num: number, den: number): string =>
  den > 0 ? ((num / den) * 100).toFixed(0).padStart(3) + `% (${num}/${den})` : '  n/a';
const sgn = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(2) : ' n/a');
const usd = (x: number): string => (Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(0) : 'n/a');

interface GoogleRow { eventId: string; tmaxC: number | null; unit: string | null; tz: string | null }
type GoogleInputs = { captures: RawCaptureRow[]; resolutions: RawResolution[]; google: GoogleRow[] };

/**
 * LOCAL bucket-idx mapper — byte-identical to the engine's googleBucketIdx EXCEPT the rounding fn is a parameter.
 * `Math.floor` reproduces the as-shipped pick; `Math.round` is the round-half-up counterfactual (== wuRound for the
 * positive °F temps in this sample, i.e. exactly the venue/WU grading round). Kept local so the analysis is
 * reproducible even while the engine is edited concurrently. Reuses parseBucketLabel / winningBucket / cToF verbatim.
 */
function pickIdx(buckets: OpeningBucket[], tmaxC: number, unit: Unit, roundFn: (x: number) => number): number | null {
  if (!Array.isArray(buckets) || buckets.length === 0 || !Number.isFinite(tmaxC)) return null;
  const ordered = [...buckets].filter((b) => b && Number.isFinite(b.idx)).sort((a, b) => a.idx - b.idx);
  if (ordered.length === 0) return null;
  let defs;
  try {
    defs = ordered.map((b) => parseBucketLabel(String(b.label ?? '')));
  } catch {
    return null;
  }
  const native = unit === 'F' ? cToF(tmaxC) : tmaxC;
  const deg = roundFn(native);
  try {
    return ordered[winningBucket(defs, deg)]!.idx;
  } catch {
    return null;
  }
}
const floorIdxOf = (b: OpeningBucket[], t: number, u: Unit) => pickIdx(b, t, u, Math.floor);
const roundIdxOf = (b: OpeningBucket[], t: number, u: Unit) => pickIdx(b, t, u, Math.round);

/** the sorted-by-idx ladder + an idx→position (temperature-rank) map for offset / label lookups. */
function orderedLadder(buckets: OpeningBucket[]): { ordered: OpeningBucket[]; posByIdx: Map<number, number> } {
  const ordered = [...(Array.isArray(buckets) ? buckets : [])]
    .filter((b) => b && Number.isFinite(b.idx))
    .sort((a, b) => a.idx - b.idx);
  const posByIdx = new Map<number, number>();
  ordered.forEach((b, i) => posByIdx.set(b.idx, i));
  return { ordered, posByIdx };
}

const labelOf = (ord: OpeningBucket[], posByIdx: Map<number, number>, idx: number | null): string => {
  if (idx == null) return '—';
  const p = posByIdx.get(idx);
  return p == null ? `idx${idx}?` : String(ord[p]!.label ?? `idx${idx}`);
};

const isRealized = (reason: string): boolean =>
  reason.startsWith('take_profit') || reason.startsWith('stop_loss') || reason === 'resolution_settle:win' || reason === 'resolution_settle:lose';

interface EventDiag {
  city: string;
  unit: Unit;
  tmaxC: number;
  native: number;
  floorIdx: number | null;
  roundIdx: number | null;
  winnerIdx: number | null;
  floorLabel: string;
  roundLabel: string;
  winnerLabel: string;
  floorCorrect: boolean | null; // null = unresolved
  roundCorrect: boolean | null;
  floorOffset: number; // winnerPos − floorPos  (>0 ⇒ picked too COLD/low)
  roundOffset: number;
  floorDiffersFromRound: boolean;
  engineDiverged: boolean; // engine googleBucketIdx != our local floor (flags a concurrent floor→round swap)
  // floor replay under PINNED_CFG:
  floorEntered: boolean;
  floorRealized: boolean;
  floorWon: boolean;
  floorPnl: number;
  floorExit: string;
  // round replay under PINNED_CFG (the counterfactual):
  roundEntered: boolean;
  roundRealized: boolean;
  roundWon: boolean;
  roundPnl: number;
  roundExit: string;
}

async function pullInputs(db: ReturnType<typeof makeScriptDb>, cities: string[]): Promise<GoogleInputs> {
  const captures: RawCaptureRow[] = [];
  const resolutions: RawResolution[] = [];
  const google: GoogleRow[] = [];
  let cityErrors = 0, next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= cities.length) return;
      const city = cities[i]!;
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          const t0 = Date.now();
          const rows = await db.query<{ r: GoogleInputs }>(`SELECT google_paper_inputs($1, $2) AS r`, [PANEL_DAYS, [city]]);
          const inp = rows[0]?.r ?? { captures: [], resolutions: [], google: [] };
          if (Array.isArray(inp.captures)) captures.push(...inp.captures);
          if (Array.isArray(inp.resolutions)) resolutions.push(...inp.resolutions);
          if (Array.isArray(inp.google)) google.push(...inp.google);
          process.stderr.write(`  [${i + 1}/${cities.length}] ${city}: ${Array.isArray(inp.captures) ? inp.captures.length : 0} rows (${Date.now() - t0}ms)\n`);
          ok = true;
        } catch (e) {
          if (attempt === 1) { cityErrors++; console.error(`  [warn] ${city}: ${e instanceof Error ? e.message : String(e)}`); }
        }
      }
    }
  };
  process.stderr.write(`fetching google_paper_inputs for ${cities.length} cities (${FETCH_CONCURRENCY}-way)…\n`);
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, () => worker()));
  process.stderr.write(`  captureRows=${captures.length}  resolutions=${resolutions.length}  google=${google.length}  cityErrors=${cityErrors}\n\n`);
  return { captures, resolutions, google };
}

async function main(): Promise<void> {
  loadEnv();
  const db = makeScriptDb();
  try {
    // scope = the live bot.cities capture universe (the sweep's exact path), else BOT_DEFAULTS.cities.
    let cities = BOT_DEFAULTS.cities as string[];
    try {
      const cfgRows = await db.query<{ key: string; value: string | null }>(`SELECT key, value::text AS value FROM config`);
      const parsed = parseBotConfig(cfgRows).cities;
      if (Array.isArray(parsed) && parsed.length) cities = parsed;
    } catch (e) {
      console.error(`  [warn] config read failed, using BOT_DEFAULTS.cities: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.stderr.write(`scope: ${cities.length} cities\n`);

    const { captures, resolutions, google } = await pullInputs(db, cities);

    // build events (mirror buildGoogleView's ingest exactly).
    const resMap = new Map<string, Resolution>(
      resolutions.map((r) => [String(r.id), { winnerIdx: r.winnerIdx ?? null, gradingMismatch: r.gradingMismatch === true }]),
    );
    const events: EventReplayInput[] = buildEvents(captures, resMap);
    const resolvesAtByEvent = new Map<string, string>();
    for (const r of captures) {
      if (r?.eventId == null || r.resolvesAt == null) continue;
      const k = String(r.eventId);
      if (!resolvesAtByEvent.has(k)) resolvesAtByEvent.set(k, String(r.resolvesAt));
    }
    const googleByEvent = new Map<string, { tmaxC: number | null; unit: Unit }>();
    for (const g of google) {
      if (!g || g.eventId == null) continue;
      const unit: Unit = g.unit === 'F' ? 'F' : 'C';
      const tmaxC = g.tmaxC != null && Number.isFinite(Number(g.tmaxC)) ? Number(g.tmaxC) : null;
      googleByEvent.set(String(g.eventId), { tmaxC, unit });
    }

    // ── per-event diagnostics (all replays under PINNED_CFG; floor/round computed LOCALLY) ──────────────────
    const diags: EventDiag[] = [];
    let nFresh = 0, engineDivergences = 0;
    for (const e of events) {
      if (e.resolution.gradingMismatch) continue; // excluded from scoring (same as the panel/sweep)
      nFresh++;
      const g = googleByEvent.get(e.eventId);
      if (!g || g.tmaxC == null) continue;
      const ladder = e.ticks.find((t: ReplayTick) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
      const floorIdx = floorIdxOf(ladder, g.tmaxC, g.unit);
      if (floorIdx == null) continue; // unbucketable — not a Google trade (matches the sweep's predIdx==null skip)
      const roundIdx = roundIdxOf(ladder, g.tmaxC, g.unit);
      const engineIdx = googleBucketIdx(ladder, g.tmaxC, g.unit); // consistency check vs the (mutating) engine
      const engineDiverged = engineIdx !== floorIdx;
      if (engineDiverged) engineDivergences++;

      const { ordered, posByIdx } = orderedLadder(ladder);
      const winnerIdx = e.resolution.winnerIdx;
      const native = g.unit === 'F' ? cToF(g.tmaxC) : g.tmaxC;
      const winnerPos = winnerIdx == null ? null : posByIdx.get(winnerIdx) ?? null;
      const floorPos = posByIdx.get(floorIdx) ?? null;
      const roundPos = roundIdx == null ? null : posByIdx.get(roundIdx) ?? null;
      const resolvesAt = resolvesAtByEvent.get(e.eventId) ?? null;

      const fT = replayGoogleBracket(e, floorIdx, { ...PINNED_CFG }, resolvesAt);
      const rT = replayGoogleBracket(e, roundIdx, { ...PINNED_CFG }, resolvesAt);

      diags.push({
        city: e.city,
        unit: g.unit,
        tmaxC: g.tmaxC,
        native,
        floorIdx,
        roundIdx,
        winnerIdx,
        floorLabel: labelOf(ordered, posByIdx, floorIdx),
        roundLabel: labelOf(ordered, posByIdx, roundIdx),
        winnerLabel: labelOf(ordered, posByIdx, winnerIdx),
        floorCorrect: winnerIdx == null ? null : floorIdx === winnerIdx,
        roundCorrect: winnerIdx == null ? null : roundIdx === winnerIdx,
        floorOffset: winnerPos != null && floorPos != null ? winnerPos - floorPos : NaN,
        roundOffset: winnerPos != null && roundPos != null ? winnerPos - roundPos : NaN,
        floorDiffersFromRound: floorIdx !== roundIdx,
        engineDiverged,
        floorEntered: fT.executed,
        floorRealized: fT.executed && isRealized(fT.exitReason),
        floorWon: fT.executed && isRealized(fT.exitReason) && fT.netPnlUsd > 0,
        floorPnl: fT.executed ? fT.netPnlUsd : NaN,
        floorExit: fT.exitReason,
        roundEntered: rT.executed,
        roundRealized: rT.executed && isRealized(rT.exitReason),
        roundWon: rT.executed && isRealized(rT.exitReason) && rT.netPnlUsd > 0,
        roundPnl: rT.executed ? rT.netPnlUsd : NaN,
        roundExit: rT.exitReason,
      });
    }

    const nF = diags.filter((d) => d.unit === 'F').length;
    const nC = diags.filter((d) => d.unit === 'C').length;
    process.stderr.write(`fresh(gm-excl)=${nFresh}  google-bucketable=${diags.length}  (°C=${nC}, °F/US=${nF})  engineDivergences=${engineDivergences}\n\n`);

    // ── config banner (pinned vs the live panel default — they can differ; the operator edits GOOGLE_DEFAULTS) ─
    console.log(`GOOGLE °F DIAGNOSTIC — ${cities.length} cities / ${PANEL_DAYS}d window · bucketable events=${diags.length} (°F=${nF}, °C=${nC})`);
    console.log(`ANALYSIS config (PINNED, reproducible): band [${PINNED_CFG.askMin}, ${PINNED_CFG.askMax}]  tp ${PINNED_CFG.tpAbs}  sl ${PINNED_CFG.slAbs}  win ${PINNED_CFG.minHoursToResolution}h`);
    console.log(`LIVE panel default (GOOGLE_DEFAULTS, operator-edited): band [${GOOGLE_DEFAULTS.askMin}, ${GOOGLE_DEFAULTS.askMax}]  excludeFahrenheit=${GOOGLE_DEFAULTS.excludeFahrenheit}`);
    if (engineDivergences > 0) console.log(`⚠ engine googleBucketIdx diverged from local FLOOR on ${engineDivergences} event(s) — the engine may have been swapped floor→round mid-run.`);
    console.log(`FLOOR = Math.floor(native) (as-shipped pick)   ROUND = Math.round(native) (fix)   WINNER = venue grade`);
    console.log(`fOff/rOff = winnerPos − pickPos in BUCKETS (>0 ⇒ pick too COLD/low; the floor artefact biases fOff positive)`);
    console.log(`fC/rC = pick == winner?   Δfr = floor≠round?   entered/pnl = PINNED-config FLOOR replay\n`);
    console.log(
      'city'.padEnd(9) + 'u'.padEnd(2) + 'gC'.padStart(6) + 'nat'.padStart(7) +
      'FLOORbkt'.padStart(11) + 'ROUNDbkt'.padStart(11) + 'WINbkt'.padStart(11) +
      'fC'.padStart(3) + 'rC'.padStart(3) + 'fOff'.padStart(5) + 'rOff'.padStart(5) + 'Δfr'.padStart(4) +
      'ent'.padStart(4) + 'pnl'.padStart(6) + '  floorExit',
    );
    console.log('  ' + '─'.repeat(120));
    const sorted = [...diags].sort((a, b) => (a.unit === b.unit ? a.city.localeCompare(b.city) : a.unit === 'F' ? -1 : 1));
    for (const d of sorted) {
      const fc = d.floorCorrect == null ? ' ?' : d.floorCorrect ? ' Y' : ' n';
      const rc = d.roundCorrect == null ? ' ?' : d.roundCorrect ? ' Y' : ' n';
      console.log(
        d.city.slice(0, 8).padEnd(9) + d.unit.padEnd(2) +
        d.tmaxC.toFixed(1).padStart(6) + d.native.toFixed(1).padStart(7) +
        d.floorLabel.slice(0, 10).padStart(11) + d.roundLabel.slice(0, 10).padStart(11) + d.winnerLabel.slice(0, 10).padStart(11) +
        fc.padStart(3) + rc.padStart(3) +
        (Number.isFinite(d.floorOffset) ? String(d.floorOffset) : ' -').padStart(5) +
        (Number.isFinite(d.roundOffset) ? String(d.roundOffset) : ' -').padStart(5) +
        (d.floorDiffersFromRound ? '  y' : '  ·').padStart(4) +
        (d.floorEntered ? ' Y' : ' ·').padStart(4) +
        (d.floorEntered && Number.isFinite(d.floorPnl) ? usd(d.floorPnl) : '  ·').padStart(6) +
        '  ' + d.floorExit,
      );
    }

    // ── cohort summaries (the mechanism test) ─────────────────────────────────────────────────────────────
    const cohort = (u: Unit) => {
      const ds = diags.filter((d) => d.unit === u);
      const resolved = ds.filter((d) => d.floorCorrect != null);
      const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
      const meanAbs = (a: number[]) => (a.length ? a.reduce((s, x) => s + Math.abs(x), 0) / a.length : NaN);
      const fOff = resolved.map((d) => d.floorOffset).filter(Number.isFinite) as number[];
      const rOff = resolved.map((d) => d.roundOffset).filter(Number.isFinite) as number[];
      return {
        n: ds.length, nResolved: resolved.length,
        floorHits: resolved.filter((d) => d.floorCorrect).length,
        roundHits: resolved.filter((d) => d.roundCorrect).length,
        meanFloorOff: mean(fOff), meanRoundOff: mean(rOff), meanAbsFloorOff: meanAbs(fOff), meanAbsRoundOff: meanAbs(rOff),
        nDiffer: ds.filter((d) => d.floorDiffersFromRound).length,
        floorRealized: ds.filter((d) => d.floorRealized).length,
        floorWins: ds.filter((d) => d.floorWon).length,
        floorNet: ds.filter((d) => d.floorEntered && Number.isFinite(d.floorPnl)).reduce((s, d) => s + d.floorPnl, 0),
        roundRealized: ds.filter((d) => d.roundRealized).length,
        roundWins: ds.filter((d) => d.roundWon).length,
        roundNet: ds.filter((d) => d.roundEntered && Number.isFinite(d.roundPnl)).reduce((s, d) => s + d.roundPnl, 0),
      };
    };
    const cF = cohort('F');
    const cC = cohort('C');

    console.log(`\n=== COHORT SUMMARY (mechanism test — band-INDEPENDENT bucket accuracy over all bucketable events) ===`);
    console.log(`                                   °F / US            °C / intl`);
    console.log(`  bucketable events            ${String(cF.n).padStart(10)}       ${String(cC.n).padStart(10)}`);
    console.log(`  resolved (have a winner)     ${String(cF.nResolved).padStart(10)}       ${String(cC.nResolved).padStart(10)}`);
    console.log(`  FLOOR bucket hit-rate        ${pct(cF.floorHits, cF.nResolved).padStart(10)}   ${pct(cC.floorHits, cC.nResolved).padStart(10)}`);
    console.log(`  ROUND bucket hit-rate        ${pct(cF.roundHits, cF.nResolved).padStart(10)}   ${pct(cC.roundHits, cC.nResolved).padStart(10)}`);
    console.log(`  floor≠round (buckets differ) ${String(cF.nDiffer).padStart(10)}       ${String(cC.nDiffer).padStart(10)}`);
    console.log(`  mean signed offset  FLOOR    ${sgn(cF.meanFloorOff).padStart(10)}       ${sgn(cC.meanFloorOff).padStart(10)}   (buckets; >0 ⇒ pick too cold)`);
    console.log(`  mean signed offset  ROUND    ${sgn(cF.meanRoundOff).padStart(10)}       ${sgn(cC.meanRoundOff).padStart(10)}`);
    console.log(`  mean |offset|       FLOOR    ${sgn(cF.meanAbsFloorOff).padStart(10)}       ${sgn(cC.meanAbsFloorOff).padStart(10)}`);
    console.log(`  mean |offset|       ROUND    ${sgn(cF.meanAbsRoundOff).padStart(10)}       ${sgn(cC.meanAbsRoundOff).padStart(10)}`);

    console.log(`\n=== PINNED-CONFIG REALIZED (band [0.10,0.15] — reproduces the sweep's 0-for-6 / 8-of-18) ===`);
    console.log(`  FLOOR (as-shipped)   °F realized ${cF.floorRealized}  wins ${cF.floorWins}  net ${usd(cF.floorNet)}   |   °C realized ${cC.floorRealized}  wins ${cC.floorWins}  net ${usd(cC.floorNet)}`);
    console.log(`  ROUND (the fix)      °F realized ${cF.roundRealized}  wins ${cF.roundWins}  net ${usd(cF.roundNet)}   |   °C realized ${cC.roundRealized}  wins ${cC.roundWins}  net ${usd(cC.roundNet)}`);

    // ── FLIP analysis: of the floor-entered °F LOSERS, how many the round bucket rescues ─────────────────
    const fLosers = diags.filter((d) => d.unit === 'F' && d.floorRealized && !d.floorWon);
    const roundPicksWinner = fLosers.filter((d) => d.roundCorrect === true);
    const roundTradesToWin = fLosers.filter((d) => d.roundWon);
    console.log(`\n=== FLIP ANALYSIS — the °F-losers question (floor-entered & lost, band [0.10,0.15]) ===`);
    console.log(`  floor-entered °F losers                         : ${fLosers.length}`);
    console.log(`  …whose ROUND bucket IS the winner (correct pick): ${roundPicksWinner.length}`);
    console.log(`  …that ROUND actually TRADES to a win            : ${roundTradesToWin.length}   ← how many the fix flips`);
    for (const d of fLosers) {
      console.log(
        `    ${d.city.slice(0, 11).padEnd(12)} floorBkt ${d.floorLabel.padStart(10)}  winner ${d.winnerLabel.padStart(10)}  ` +
        `roundBkt ${d.roundLabel.padStart(10)}  roundCorrect=${d.roundCorrect ? 'Y' : 'n'}  roundExit=${d.roundExit}  roundPnl=${Number.isFinite(d.roundPnl) ? usd(d.roundPnl) : 'n/a'}`,
      );
    }

    // ── entry-band sensitivity: floor vs round realized across ceilings (0.12 = the operator's new live band) ─
    console.log(`\n=== ENTRY-BAND SENSITIVITY (°F, floor vs round realized; 0.12 = operator's new live ceiling) ===`);
    console.log(`  askMax    FLOOR realized/wins/net       ROUND realized/wins/net    round-flips`);
    for (const askMax of [0.12, 0.15, 0.18, 0.2]) {
      let fReal = 0, fWin = 0, fNet = 0, rReal = 0, rWin = 0, rNet = 0, flips = 0;
      for (const e of events) {
        if (e.resolution.gradingMismatch) continue;
        const g = googleByEvent.get(e.eventId);
        if (!g || g.tmaxC == null || g.unit !== 'F') continue;
        const ladder = e.ticks.find((t: ReplayTick) => Array.isArray(t.buckets) && t.buckets.length > 0)?.buckets ?? [];
        const fIdx = floorIdxOf(ladder, g.tmaxC, g.unit);
        if (fIdx == null) continue;
        const rIdx = roundIdxOf(ladder, g.tmaxC, g.unit);
        const resolvesAt = resolvesAtByEvent.get(e.eventId) ?? null;
        const cfg = { ...PINNED_CFG, askMax };
        const ft = replayGoogleBracket(e, fIdx, cfg, resolvesAt);
        const rt = replayGoogleBracket(e, rIdx, cfg, resolvesAt);
        if (ft.executed && isRealized(ft.exitReason)) { fReal++; if (ft.netPnlUsd > 0) fWin++; fNet += ft.netPnlUsd; }
        if (rt.executed && isRealized(rt.exitReason)) { rReal++; if (rt.netPnlUsd > 0) rWin++; rNet += rt.netPnlUsd; }
        if (ft.executed && isRealized(ft.exitReason) && ft.netPnlUsd <= 0 && rt.executed && isRealized(rt.exitReason) && rt.netPnlUsd > 0) flips++;
      }
      console.log(`   ${askMax.toFixed(2)}          ${String(fReal).padStart(2)} / ${fWin} / ${usd(fNet).padStart(4)}                ${String(rReal).padStart(2)} / ${rWin} / ${usd(rNet).padStart(4)}            ${flips}`);
    }

    // ── bucket-width note (hypothesis 3) ─────────────────────────────────────────────────────────────────
    console.log(`\n=== BUCKET WIDTH (hypothesis 3) ===`);
    console.log(`  °F ladders = 2°F interior buckets ≈ 1.11°C wide; °C ladders = 1°C wide. °F is WIDER in °C-space,`);
    console.log(`  so width alone predicts °F should be EASIER to hit — it CANNOT explain °F underperformance (opposite sign).`);

    console.log(`\n=== VERDICT INPUTS (for the write-up) ===`);
    console.log(`  °F bucket accuracy: floor ${pct(cF.floorHits, cF.nResolved)}  vs  round ${pct(cF.roundHits, cF.nResolved)}   (Δ = ${cF.roundHits - cF.floorHits} with round)`);
    console.log(`  °C bucket accuracy: floor ${pct(cC.floorHits, cC.nResolved)}  vs  round ${pct(cC.roundHits, cC.nResolved)}   (Δ = ${cC.roundHits - cC.floorHits} with round)`);
    console.log(`  °F offset: floor ${sgn(cF.meanFloorOff)} → round ${sgn(cF.meanRoundOff)} buckets (residual after de-artefacting = genuine Google cold bias)`);
    console.log(`  °C offset: floor ${sgn(cC.meanFloorOff)} → round ${sgn(cC.meanRoundOff)} buckets`);
    console.log(`  °F losers a round-fix flips (band [0.10,0.15]): ${roundTradesToWin.length} of ${fLosers.length}.`);
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
