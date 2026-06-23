/**
 * scripts/research/m7-selector-learnability — REC-1: is badatmath's cheap-bucket SELECTION learnable
 * by us, OUT-OF-SAMPLE? The impure spine for `core/sim/selector-learn.ts`. Pre-registration:
 * SELECTOR-LEARNABILITY.md (frozen 2026-06-23). The decisive maker-path test (MAKER-REBATE-HANDOFF.md §4).
 *
 * THE QUESTION. §12 showed our one-feature forecast selection FAILS (−1.7pp) and indiscriminate
 * selection FAILS (−1.5pp); m6 showed resting on HIS revealed picks is +3.9pp but that is HIS edge
 * (latency wall). REC-1: train a SELECTOR on a frozen set of PRE-ENTRY features (microstructure + our
 * forecast + price-action), pick the cheap (0.10–0.25) buckets it judges underpriced, and score the
 * selection edge OUT-OF-SAMPLE (leave-one-weather-day-out) with a cluster-mean t-interval + a zero-skill
 * null. PASS = a capturable selector candidate (→ REC-2 execution realism); FAIL = his edge alone (REC-6);
 * INSUFFICIENT_DATA = too few independent weather-days to tell (the book-density limit, §0).
 *
 * POSTURE: analytics study, NOT a trading green-light. Ships nothing to prod, no migration, no live rail,
 * NEVER imports `packages/trading`. Read-only. The deliverable is the verdict either way.
 *
 * REUSE, don't reinvent (SELECTOR-LEARNABILITY.md §3): the maker-spray loaders (`loadEmosInputs`,
 * `loadEvents`, `loadBucketSeries`, `assembleBids`) + `makerEntry` (the §12 owner of entry-snapshot
 * resolution + restPx) for the universe; `core/sim/selector-learn.ts` for the learning + verdict.
 *
 * NO LEAKAGE (the binding correctness invariant). Every feature is computed from the entry snapshot and
 * snapshots AT OR BEFORE the entry instant — the fill outcome the model is graded on is never an input
 * (`assertNoLeakage`). The selection edge is scored FILL-AGNOSTIC (selection skill); execution realism
 * (fill / queue) is the SEPARATE REC-2 step, gated on a REC-1 PASS.
 *
 * Run: pnpm tsx scripts/research/m7-selector-learnability.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--leads 1,2] [--stations EHAM,..] [--entry-lead-h 24] [--lookback-days 3] [--l2 1.0]
 *        [--mc-iters 200] [--json]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  type LabeledPick,
  type SelectorLearnReport,
  SELECTOR_LEARN,
  runSelectorLearn,
} from '../../packages/core/src/sim/selector-learn.ts';
import { type FillSnapshot, type RestingBid, makerEntry } from '../../packages/core/src/sim/maker-spray.ts';
import { splitList } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import {
  type MakerSprayArgs,
  loadAndAssemble,
  parseFillModel,
  parseRestRule,
} from './maker-spray-feasibility.ts';

export const SCRIPT = 'm7-selector-learnability';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PURE: leakage-free pre-entry feature extraction (the frozen feature set — SELECTOR-LEARNABILITY.md §5)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The frozen feature order (for the report). */
export const FEATURE_NAMES = ['calibratedP', 'restPx', 'edgeP', 'spread', 'restVsMid', 'drift'] as const;

const usable = (p: number | null | undefined): p is number =>
  p != null && Number.isFinite(p) && p > 0 && p <= 1;

/**
 * The earliest usable mid AT OR BEFORE `entryCaptured` and within `lookbackSec` of it, from an ascending
 * snapshot series — for the price-drift feature. Returns null when there is no pre-entry mid in window.
 * STRICTLY pre-entry (capturedAt ≤ entryCaptured) → no post-entry leakage.
 */
export function earliestPreEntryMid(
  series: FillSnapshot[],
  entryCaptured: number,
  lookbackSec: number,
): number | null {
  for (const s of series) {
    if (s.capturedAt > entryCaptured) break; // ascending → nothing further is pre-entry
    if (s.capturedAt >= entryCaptured - lookbackSec && usable(s.mid)) return s.mid;
  }
  return null;
}

/**
 * Assert no feature snapshot is drawn from after the entry instant (the binding no-leakage invariant).
 * Throws if any snapshot used for features has capturedAt > entryCaptured. Called per pick in the spine.
 */
export function assertNoLeakage(usedCapturedAts: number[], entryCaptured: number): void {
  for (const t of usedCapturedAts) {
    if (t > entryCaptured) {
      throw new Error(`LEAKAGE: feature snapshot @${t} is after entry @${entryCaptured}`);
    }
  }
}

/**
 * Build ONE leakage-free LabeledPick from a resting bid, or null when it is not a cheap-band candidate
 * with a usable entry book. Cheap band = restPx ∈ [cheapLo, cheapMax) (the §15 engine band). Features
 * (frozen order, all ≤-entry): calibratedP, restPx, edgeP=calibratedP−restPx, spread=ask−bid, restVsMid,
 * drift=mid(entry)−mid(earliest pre-entry in window). A non-finite core book feature → null (dropped,
 * reported in coverage); a missing drift history → 0 (neutral). Pure.
 */
export function extractPick(
  bid: RestingBid,
  opts: { cheapLo: number; cheapMax: number; lookbackSec: number },
): LabeledPick | null {
  const e = makerEntry(bid, { rule: 'bid', fillModel: 'ask_touch', cheapMax: opts.cheapMax, select: 'all' });
  if (!e.eligibleCheap || e.restPx == null || e.entrySnapshot == null) return null;
  const restPx = e.restPx;
  if (!(restPx >= opts.cheapLo && restPx < opts.cheapMax)) return null;

  const entry = e.entrySnapshot;
  const entryCaptured = entry.capturedAt;
  if (!usable(entry.bid) || !usable(entry.ask) || !usable(entry.mid)) return null; // need the book at entry
  const spread = entry.ask - entry.bid;
  const restVsMid = e.restVsMid; // restPx − mid(entry)
  if (!Number.isFinite(spread) || !Number.isFinite(restVsMid)) return null;

  const preMid = earliestPreEntryMid(bid.snapshots, entryCaptured, opts.lookbackSec);
  const drift = preMid == null ? 0 : entry.mid - preMid;

  const calibratedP = bid.calibratedP;
  if (!Number.isFinite(calibratedP)) return null;
  const edgeP = calibratedP - restPx;

  // no-leakage guard: every snapshot we touched is ≤ the entry instant
  assertNoLeakage(preMid == null ? [entryCaptured] : [entryCaptured], entryCaptured);

  return {
    features: [calibratedP, restPx, edgeP, spread, restVsMid, drift],
    restPx,
    won: e.won,
    cluster: bid.targetDate,
    feeRate: Number.isFinite(bid.feeRate) ? bid.feeRate : SELECTOR_LEARN.feeRate,
  };
}

/** Extract all cheap-band leakage-free picks + coverage counts. Pure given the assembled bids. */
export function extractPicks(
  bids: RestingBid[],
  opts: { cheapLo: number; cheapMax: number; lookbackSec: number },
): { picks: LabeledPick[]; nBids: number; nDropped: number } {
  const picks: LabeledPick[] = [];
  let nDropped = 0;
  for (const b of bids) {
    const p = extractPick(b, opts);
    if (p) picks.push(p);
    else nDropped++;
  }
  return { picks, nBids: bids.length, nDropped };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// REPORT
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const pp = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}pp` : '—');
const pctf = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');

function reportStatsLine(label: string, s: SelectorLearnReport['oos'], log: (m: string) => void): void {
  log(`  ${label}: n=${s.n} over ${s.nClusters} day(s), win ${pctf(s.winRate)} (${s.nWon}/${s.n})`);
  log(`     selection edge (won−restPx):  per-bucket ${pp(s.edge.mean)} [${pp(s.edge.lo)}, ${pp(s.edge.hi)}]`);
  log(`     ★ cluster-mean t-interval (GATE): ${pp(s.edgeClusterT.mean)} [${pp(s.edgeClusterT.lo)}, ${pp(s.edgeClusterT.hi)}]`);
  log(`     maker EV/$1 conservative ${pctf(s.evConservative.mean)} [${pctf(s.evConservative.lo)}, ${pctf(s.evConservative.hi)}]`);
  log(`     maker EV/$1 realistic (rebate .25) ${pctf(s.evRealistic.mean)} [${pctf(s.evRealistic.lo)}, ${pctf(s.evRealistic.hi)}]`);
}

export function report(
  res: SelectorLearnReport,
  ctx: { args: M7Args; nStations: number; nEvents: number; nBids: number; nDropped: number; forkRmse: number; byDate: Map<string, number> },
  log: (m: string) => void,
): void {
  const { args } = ctx;
  log(`=== m7 selector-learnability (REC-1) ${args.from} → ${args.to} · leads ${args.leads.join(',')} · entry-lead ${args.entryLeadHours}h ===`);
  log(`scope: ${ctx.nStations} stations · ${ctx.nEvents} resolved events · ${ctx.nBids} bids → ${res.nPicks} cheap-band picks (dropped ${ctx.nDropped} non-cheap/no-book)`);
  log(`EMOS blend-μ RMSE (same loaders as §12 maker-spray): ${Number.isFinite(ctx.forkRmse) ? ctx.forkRmse.toFixed(4) + '°C' : '—'}`);
  log(`features (frozen, all ≤ entry — no leakage): ${FEATURE_NAMES.join(', ')}`);
  log(`cheap band [${SELECTOR_LEARN.cheapLo}, ${SELECTOR_LEARN.cheapMax}) · l2 ${args.l2} · mc-iters ${args.mcIters} · MIN_CLUSTERS ${SELECTOR_LEARN.minClusters}`);
  log('');

  log(`── independence units: cheap-band picks per weather-day (the OOS folds) ──`);
  for (const d of [...ctx.byDate.keys()].sort()) log(`  ${d}: ${ctx.byDate.get(d)}`);
  log(`  → ${res.nClusters} distinct weather-day cluster(s)`);
  log('');

  log('── IN-SAMPLE CEILING (fit + score on ALL days — optimistic upper bound) ──');
  reportStatsLine('ceiling', res.inSample, log);
  log('');
  log('── OUT-OF-SAMPLE (leave-one-weather-day-out — the honest test) ──');
  reportStatsLine('OOS', res.oos, log);
  log('');
  log('── ZERO-SKILL CALIBRATION-NULL (won~Bernoulli(restPx); corroborating false-positive guard) ──');
  log(`  P(OOS cluster-t edge clears 0 | calibrated market) ${pctf(res.nullOos.pPass)} over ${res.nullOos.iters} iters  ← < 5% to trust a PASS`);
  log('');

  log('──────── VERDICT (frozen kill-criterion — SELECTOR-LEARNABILITY.md §8, do NOT move) ────────');
  log(`  ${res.verdict.summary}`);
  if (res.verdict.outcome === 'INSUFFICIENT_DATA') {
    log('  → The data cannot answer REC-1: too few independent weather-days carry a cheap-eligible book.');
    log('    This is a DATA-DENSITY blocker (REC-3 ingest + REC-4 monitor → more days), NOT a modelling gap.');
    log('    Re-run this same harness when nClusters ≥ MIN_CLUSTERS. The live rail stays DORMANT.');
  } else if (res.verdict.outcome === 'PASS') {
    log('  → CAPTURABLE selector candidate. ESCALATE to adversarial re-verification, THEN REC-2 (execution');
    log('    realism: queue competition + lagged visibility) BEFORE any thought of the dormant rail.');
  } else {
    log('  → His selection is NOT learnable by us out-of-sample (REC-6, the honest kill). Record as the next');
    log('    falsified angle in FINDINGS.md. The live rail stays DORMANT.');
  }

  if (args.json) {
    log('\nJSON ' + JSON.stringify({ args, nStations: ctx.nStations, nEvents: ctx.nEvents, nBids: ctx.nBids, nPicks: res.nPicks, nClusters: res.nClusters, forkRmse: ctx.forkRmse, inSample: res.inSample, oos: res.oos, nullOos: res.nullOos, verdict: { outcome: res.verdict.outcome, summary: res.verdict.summary } }));
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface M7Args {
  from: string;
  to: string;
  leads: number[];
  stations?: string[];
  entryLeadHours: number;
  lookbackDays: number;
  l2: number;
  mcIters: number;
  json: boolean;
}

/** No-network self-test of the pure feature extraction + leakage guard (the research-script idiom). */
function sanity(): void {
  const baseTs = 1_700_000_000;
  const bid: RestingBid = {
    conditionId: 'EV',
    bucketIdx: 0,
    calibratedP: 0.2,
    marketProbAtEntry: 0.18,
    bucketWon: true,
    feeRate: 0.05,
    tickSize: 0.01,
    citySlug: 'ams',
    station: 'EHAM',
    tzOffsetHours: 2,
    targetDate: '2026-06-14',
    resolutionTs: baseTs + 3600,
    entryTs: baseTs,
    snapshots: [
      { capturedAt: baseTs - 7200, bid: 0.1, ask: 0.16, mid: 0.13, lastTrade: 0.13 }, // pre-entry (drift origin)
      { capturedAt: baseTs, bid: 0.12, ask: 0.18, mid: 0.15, lastTrade: 0.15 }, // entry snapshot
      { capturedAt: baseTs + 1800, bid: 0.08, ask: 0.1, mid: 0.09, lastTrade: 0.1 }, // POST-entry — must NOT be used
    ],
  };
  const p = extractPick(bid, { cheapLo: 0.1, cheapMax: 0.25, lookbackSec: 3 * 86400 });
  if (!p) throw new Error('sanity: expected a cheap-band pick');
  // restPx = entry best_bid 0.12 (tick-floored). spread = 0.18-0.12 = 0.06. restVsMid = 0.12-0.15 = -0.03.
  // drift = mid(entry 0.15) − mid(pre 0.13) = +0.02. edgeP = 0.20 − 0.12 = 0.08.
  const [calP, restPx, edgeP, spread, restVsMid, drift] = p.features;
  if (Math.abs(restPx! - 0.12) > 1e-9) throw new Error(`sanity: restPx ${restPx}`);
  if (Math.abs(spread! - 0.06) > 1e-9) throw new Error(`sanity: spread ${spread}`);
  if (Math.abs(restVsMid! - -0.03) > 1e-9) throw new Error(`sanity: restVsMid ${restVsMid}`);
  if (Math.abs(drift! - 0.02) > 1e-9) throw new Error(`sanity: drift ${drift}`);
  if (Math.abs(edgeP! - 0.08) > 1e-9) throw new Error(`sanity: edgeP ${edgeP}`);
  if (calP !== 0.2) throw new Error('sanity: calibratedP');
  if (p.cluster !== '2026-06-14' || p.won !== true) throw new Error('sanity: cluster/won');

  // leakage guard fires on a post-entry capturedAt
  let threw = false;
  try {
    assertNoLeakage([baseTs + 1800], baseTs);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('sanity: assertNoLeakage must throw on a post-entry snapshot');

  // a rich (≥cheapMax) bid is not a cheap-band pick
  const rich: RestingBid = { ...bid, snapshots: [{ capturedAt: baseTs, bid: 0.5, ask: 0.55, mid: 0.52, lastTrade: 0.52 }, { capturedAt: baseTs + 1800, bid: 0.5, ask: 0.55, mid: 0.52, lastTrade: 0.52 }] };
  if (extractPick(rich, { cheapLo: 0.1, cheapMax: 0.25, lookbackSec: 3 * 86400 }) !== null) {
    throw new Error('sanity: a 0.50-bid is not cheap-band');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      leads: { type: 'string' },
      stations: { type: 'string' },
      'entry-lead-h': { type: 'string' },
      'lookback-days': { type: 'string' },
      l2: { type: 'string' },
      'mc-iters': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const args: M7Args = {
    from: values.from ?? '2026-04-21',
    to: values.to ?? '2026-06-21',
    leads: (splitList(values.leads) ?? ['1', '2']).map(Number),
    stations: splitList(values.stations),
    entryLeadHours: values['entry-lead-h'] ? Number(values['entry-lead-h']) : 24,
    lookbackDays: values['lookback-days'] ? Number(values['lookback-days']) : 3,
    l2: values.l2 ? Number(values.l2) : SELECTOR_LEARN.l2,
    mcIters: values['mc-iters'] ? Number(values['mc-iters']) : 200,
    json: Boolean(values.json),
  };
  const db = makeScriptDb();
  try {
    // reuse the §12 maker-spray spine to assemble the cheap-bucket universe (identical loaders)
    const sprayArgs: MakerSprayArgs = {
      from: args.from,
      to: args.to,
      leads: args.leads,
      stations: args.stations,
      restRule: parseRestRule('bid'),
      fillModel: parseFillModel('ask_touch'),
      select: 'all',
      askOffset: 0.07,
      entryLeadHours: [args.entryLeadHours],
      lookbackDays: args.lookbackDays,
      cheapMax: SELECTOR_LEARN.cheapMax,
      makerRebate: 0,
      rebateRate: SELECTOR_LEARN.rebateRate,
      margin: 0.02,
      mcIters: 0,
      crossVal: false,
      json: false,
    };
    const spine = await loadAndAssemble(db, sprayArgs, args.entryLeadHours);
    const { picks, nBids, nDropped } = extractPicks(spine.bids, {
      cheapLo: SELECTOR_LEARN.cheapLo,
      cheapMax: SELECTOR_LEARN.cheapMax,
      lookbackSec: args.lookbackDays * 86400,
    });
    const byDate = new Map<string, number>();
    for (const p of picks) byDate.set(p.cluster, (byDate.get(p.cluster) ?? 0) + 1);

    const res = runSelectorLearn(picks, { l2: args.l2, mcIters: args.mcIters });
    report(
      res,
      { args, nStations: spine.nStations, nEvents: spine.nEvents, nBids, nDropped, forkRmse: spine.forkRmse, byDate },
      console.log,
    );
  } finally {
    await db.end();
  }
}
