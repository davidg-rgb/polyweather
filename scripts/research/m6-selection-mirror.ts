/**
 * scripts/research/m6-selection-mirror — the 6th angle: rest OUR maker bids on badatmath's REVEALED
 * cheap picks (his SELECTION), priced with the real `weather_fees` maker rebate, and measure the
 * maker fee-net EV with a bootstrap CI + a zero-skill Monte-Carlo guard.
 *
 * THE CEILING of the maker-mirror strategy. It assumes we capture his exact fills — queue competition
 * is IGNORED (the §11 structural objection: to rest his bids we'd compete with him for the same fills
 * in thin books). So this is an UPPER BOUND: if even this ceiling's edge CI does not clear zero, the
 * maker-mirror path is dead; if it does, the only remaining risk is execution (capturing the fills).
 *
 * WHY THIS IS A DISTINCT, UNRUN ANGLE:
 *   §11 copy-trade  → mirror his fills as a TAKER (cross to ask)        → −6.05pp (spread tax).
 *   §14 Move 5      → his revealed distribution as a FORECAST input     → value-negative.
 *   §12 maker-spray → rest OUR-forecast-selected bids as a maker        → −1.5..−1.7pp (our selection).
 *   THIS (§16)      → rest on HIS selection as a maker, WITH the rebate → the untested cell.
 *
 * THE TWO METRICS (kept separate on purpose):
 *   • SELECTION EDGE = won − price. REBATE-INDEPENDENT — it is purely how good HIS picks are versus the
 *     price he rests at (badatmath ≈ +1.3pp, §11). The robust, low-variance read; the GATE.
 *   • MAKER FEE-NET EV/$1 = makerNetEvPerDollar(price, won, feeRate, 0, rebateRate). The money number,
 *     but heavy-tailed (longshot payoffs), so its bootstrap CI is wide. Reported conservative (rebate 0)
 *     vs realistic (weather_fees rebateRate 0.25 — the committed model).
 *
 * INPUT: the §15 forensic purchase CSV (his scored cheap picks: vwap_price, won, lead_hours, stake) —
 * the validated +$22.4k/+12.9% map (BADATMATH-REPLICA / WALLET-RECON §15). Read-only; no DB; no crawl;
 * ships nothing; never imports `packages/trading`. Reuses the committed `makerNetEvPerDollar`
 * (weather_fees rebate model) + `bootstrapMeanCi`/`meanConfidenceInterval` + `mulberry32`.
 *
 * Run: pnpm tsx scripts/research/m6-selection-mirror.ts
 *        [--csv scripts/research/out/badatmath-purchases-may23-jun21.csv]
 *        [--fee-rate 0.05] [--rebate-rate 0.25] [--cheap-max 0.25] [--seed 42] [--mc-iters 1000] [--json]
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makerNetEvPerDollar } from '../../packages/core/src/sim/maker-spray.ts';
import { bootstrapMeanCi, meanConfidenceInterval } from '../../packages/core/src/sim/stats.ts';
import { mulberry32 } from '../../packages/core/src/calibration/scores.ts';

export const SCRIPT = 'm6-selection-mirror';

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PURE: the selection-mirror statistics
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One of badatmath's resolved cheap picks reduced to what the mirror needs. */
export interface MirrorPick {
  /** The price he rested at (vwap of his fills on this position) = our hypothetical rest price. */
  price: number;
  won: boolean;
  /** Hours from first fill to resolution (his 24–72h sweet spot); null when unbridged. */
  leadHours: number | null;
  stakeUsd: number;
  outcome: string;
}

export interface MirrorStats {
  n: number;
  nWon: number;
  winRate: number;
  /** Maker fee-net EV/$1, bootstrap CI (the money number; heavy-tailed). */
  ev: { mean: number; lo: number; hi: number };
  /** Selection edge won−price, analytic mean CI (REBATE-INDEPENDENT; the robust gate). */
  edge: { mean: number; lo: number; hi: number };
  /** P(selection-edge CI clears 0 | outcomes shuffled) — the false-positive guard. < 5% to trust. */
  zeroSkillPPass: number;
}

/**
 * Score a maker-mirror of `picks`: the (rebate-independent) selection edge `won−price`, the fee-net
 * maker EV/$1 at the given `rebateRate` (0 = conservative, 0.25 = realistic weather_fees), and the
 * zero-skill MC false-positive rate of the edge gate. Pure; total ({NaN,…} on empty input).
 */
export function mirrorStats(
  picks: MirrorPick[],
  opts: { feeRate: number; rebateRate: number; seed?: number; mcIters?: number },
): MirrorStats {
  const seed = opts.seed ?? 42;
  const mcIters = opts.mcIters ?? 1000;
  const n = picks.length;
  if (n === 0) {
    return {
      n: 0,
      nWon: 0,
      winRate: NaN,
      ev: { mean: NaN, lo: NaN, hi: NaN },
      edge: { mean: NaN, lo: NaN, hi: NaN },
      zeroSkillPPass: NaN,
    };
  }
  const evs = picks.map((p) => makerNetEvPerDollar(p.price, p.won, opts.feeRate, 0, opts.rebateRate));
  const edges = picks.map((p) => (p.won ? 1 : 0) - p.price);
  const evCi = bootstrapMeanCi(evs, { seed, iters: 2000 });
  const edgeCi = meanConfidenceInterval(edges);
  const nWon = picks.filter((p) => p.won).length;

  // zero-skill MC — the CALIBRATION null (NOT a within-sample shuffle: the pooled linear edge mean is
  // shuffle-invariant, so a shuffle is useless here). Draw each pick's outcome from a fair coin at its
  // OWN price (won_i ~ Bernoulli(price_i)) — a perfectly-calibrated market where E[won−price]=0 — and
  // count the fraction whose edge CI lower bound clears 0. ~2.5% under H0 (one-sided); <5% to trust.
  const prices = picks.map((p) => p.price);
  const rand = mulberry32(seed);
  let passes = 0;
  for (let it = 0; it < mcIters; it++) {
    const sEdges = prices.map((px) => (rand() < px ? 1 : 0) - px);
    const ci = meanConfidenceInterval(sEdges);
    if (Number.isFinite(ci.lo) && ci.lo > 0) passes++;
  }
  return {
    n,
    nWon,
    winRate: nWon / n,
    ev: { mean: evCi.mean, lo: evCi.lo, hi: evCi.hi },
    edge: { mean: edgeCi.mean, lo: edgeCi.lo, hi: edgeCi.hi },
    zeroSkillPPass: mcIters > 0 ? passes / mcIters : NaN,
  };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// CSV loader (quote-aware; the §15 purchase log is the input)
// ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Split ONE CSV line, respecting double-quoted fields (the bucket_label column is quoted). Total. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parse the §15 purchase CSV → resolved cheap MirrorPicks (price < cheapMax). Read-only. */
export function loadPicks(csvPath: string, cheapMax: number): MirrorPick[] {
  const raw = readFileSync(csvPath, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]!);
  const col = (name: string): number => header.indexOf(name);
  const iPrice = col('vwap_price');
  const iWon = col('won');
  const iResolved = col('resolved');
  const iLead = col('lead_hours');
  const iStake = col('total_stake_usd');
  const iOutcome = col('outcome');
  if (iPrice < 0 || iWon < 0 || iResolved < 0) {
    throw new Error(`CSV missing required columns (need vwap_price, won, resolved); header=${header.join('|')}`);
  }
  const picks: MirrorPick[] = [];
  for (let r = 1; r < lines.length; r++) {
    const f = splitCsvLine(lines[r]!);
    if (f.length <= iWon) continue;
    if (f[iResolved] !== '1') continue; // resolved only
    const price = Number(f[iPrice]);
    if (!Number.isFinite(price) || price <= 0 || price >= cheapMax) continue; // cheap longshots only
    const wonRaw = f[iWon];
    if (wonRaw !== '0' && wonRaw !== '1') continue;
    const leadStr = iLead >= 0 ? f[iLead] : '';
    picks.push({
      price,
      won: wonRaw === '1',
      leadHours: leadStr ? Number(leadStr) : null,
      stakeUsd: iStake >= 0 ? Number(f[iStake]) || 0 : 0,
      outcome: iOutcome >= 0 ? (f[iOutcome] ?? '') : '',
    });
  }
  return picks;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// REPORT
// ──────────────────────────────────────────────────────────────────────────────────────────────────

const pct = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—');
const pp = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}pp` : '—');

const LEAD_BANDS: { label: string; lo: number; hi: number }[] = [
  { label: '<24h (day-of)', lo: -1e9, hi: 24 },
  { label: '24–48h', lo: 24, hi: 48 },
  { label: '48–72h', lo: 48, hi: 72 },
  { label: '≥72h', lo: 72, hi: 1e9 },
];
const PRICE_BANDS: { label: string; lo: number; hi: number }[] = [
  { label: '[0.00,0.05)', lo: 0, hi: 0.05 },
  { label: '[0.05,0.10)', lo: 0.05, hi: 0.1 },
  { label: '[0.10,0.15)', lo: 0.1, hi: 0.15 },
  { label: '[0.15,0.25)', lo: 0.15, hi: 0.25 },
];

export interface MirrorArgs {
  csv: string;
  feeRate: number;
  rebateRate: number;
  /** Engine-band FLOOR (default 0.10 — the §15 pre-established engine; below it is the dead zone). */
  lo: number;
  cheapMax: number;
  seed: number;
  mcIters: number;
  json: boolean;
}

export function reportMirror(allPicks: MirrorPick[], args: MirrorArgs, log: (m: string) => void): void {
  // Headline = his PRE-ESTABLISHED §15 engine band [lo, cheapMax). The <lo dead zones (which he largely
  // avoids) are shown in the by-price table for transparency but excluded from the strategy headline.
  const picks = allPicks.filter((p) => p.price >= args.lo);
  const cons = mirrorStats(picks, { feeRate: args.feeRate, rebateRate: 0, seed: args.seed, mcIters: args.mcIters });
  const real = mirrorStats(picks, { feeRate: args.feeRate, rebateRate: args.rebateRate, seed: args.seed, mcIters: args.mcIters });

  log(`=== m6 selection-mirror — rest OUR maker bids on badatmath's REVEALED picks (the CEILING) ===`);
  log(`input: ${args.csv}`);
  log(`scope: ENGINE BAND [${args.lo},${args.cheapMax}) — ${real.n} resolved picks · win rate ${pct(real.winRate)} (${real.nWon}/${real.n})  (of ${allPicks.length} all-cheap; <${args.lo} dead zone excluded — §15)`);
  log(`fee ${args.feeRate} · realistic rebateRate ${args.rebateRate} (weather_fees) · seed ${args.seed} · mc ${args.mcIters}`);
  log('');

  log('── SELECTION EDGE (won − price) — REBATE-INDEPENDENT, the robust gate ──');
  log(`  ★ edge ${pp(real.edge.mean)}  95% CI [${pp(real.edge.lo)}, ${pp(real.edge.hi)}]  (n=${real.n})`);
  log(`     ← clears 0 ⇒ his picks robustly beat their price (badatmath ≈ +1.3pp, §11)`);
  log(`  zero-skill P(edge CI clears 0 | shuffled outcomes) ${pct(real.zeroSkillPPass)}  ← MUST be < 5%`);
  log('');

  log('── MAKER FEE-NET EV / $1 (the money number — heavy-tailed longshot payoffs) ──');
  log(`  conservative (rebate 0):     ${pct(cons.ev.mean)}  95% CI [${pct(cons.ev.lo)}, ${pct(cons.ev.hi)}]`);
  log(`  REALISTIC (rebateRate ${args.rebateRate}): ${pct(real.ev.mean)}  95% CI [${pct(real.ev.lo)}, ${pct(real.ev.hi)}]`);
  log(`  rebate lift (realistic − conservative): ${pp(real.ev.mean - cons.ev.mean)} /$1`);
  log('');

  // by lead band (his timing edge)
  log('── BY ENTRY-LEAD BAND (realistic EV + selection edge) ──');
  log(`  ${'band'.padEnd(16)} ${'n'.padStart(6)} ${'win%'.padStart(7)} ${'edge'.padStart(9)} ${'edge CI'.padStart(20)} ${'real EV/$1'.padStart(11)}`);
  for (const b of LEAD_BANDS) {
    const sub = picks.filter((p) => p.leadHours != null && p.leadHours >= b.lo && p.leadHours < b.hi);
    if (sub.length === 0) continue;
    const s = mirrorStats(sub, { feeRate: args.feeRate, rebateRate: args.rebateRate, seed: args.seed, mcIters: 0 });
    log(
      `  ${b.label.padEnd(16)} ${String(s.n).padStart(6)} ${pct(s.winRate).padStart(7)} ${pp(s.edge.mean).padStart(9)} ${`[${pp(s.edge.lo)}, ${pp(s.edge.hi)}]`.padStart(20)} ${pct(s.ev.mean).padStart(11)}`,
    );
  }
  log('');

  // by price band — over ALL cheap picks (incl. the <lo dead zones) to show WHY we floor at `lo`.
  log('── BY ENTRY-PRICE BAND (all cheap; the <0.10 dead zones are why the engine floor is 0.10 — §15) ──');
  log(`  ${'band'.padEnd(16)} ${'n'.padStart(6)} ${'win%'.padStart(7)} ${'edge'.padStart(9)} ${'edge CI'.padStart(20)} ${'real EV/$1'.padStart(11)}`);
  for (const b of PRICE_BANDS) {
    const sub = allPicks.filter((p) => p.price >= b.lo && p.price < b.hi);
    if (sub.length === 0) continue;
    const s = mirrorStats(sub, { feeRate: args.feeRate, rebateRate: args.rebateRate, seed: args.seed, mcIters: 0 });
    log(
      `  ${b.label.padEnd(16)} ${String(s.n).padStart(6)} ${pct(s.winRate).padStart(7)} ${pp(s.edge.mean).padStart(9)} ${`[${pp(s.edge.lo)}, ${pp(s.edge.hi)}]`.padStart(20)} ${pct(s.ev.mean).padStart(11)}`,
    );
  }
  log('');

  // ── verdict ──
  const edgeClears = Number.isFinite(real.edge.lo) && real.edge.lo > 0;
  const zeroSkillOk = Number.isFinite(real.zeroSkillPPass) && real.zeroSkillPPass < 0.05;
  const evPositive = Number.isFinite(real.ev.mean) && real.ev.mean > 0;
  log('──────── VERDICT (the maker-mirror CEILING; queue competition IGNORED — §11) ────────');
  if (edgeClears && zeroSkillOk) {
    log(`  CEILING HOLDS: his selection edge ${pp(real.edge.mean)} clears 0 (CI [${pp(real.edge.lo)}, ${pp(real.edge.hi)}],`);
    log(`    zero-skill ${pct(real.zeroSkillPPass)} < 5%); realistic maker EV/$1 ${pct(real.ev.mean)}${evPositive ? ' (positive)' : ''}.`);
    log(`    → IF we could capture his fills, the rebate-inclusive economics are positive. The remaining`);
    log(`      risk is PURELY EXECUTION: resting his bids means competing with him (and other makers) for`);
    log(`      the SAME fills in thin books (§11). NEXT: model queue competition / our realistic fill share.`);
  } else {
    log(`  CEILING FAILS: even assuming we capture his exact fills, his selection edge ${pp(real.edge.mean)}`);
    log(`    CI [${pp(real.edge.lo)}, ${pp(real.edge.hi)}]${edgeClears ? '' : ' does NOT clear 0'}` +
      `${zeroSkillOk ? '' : ` / zero-skill ${pct(real.zeroSkillPPass)} ≥ 5%`}.`);
    log(`    → the maker-mirror path is too noisy to trade. The live rail stays DORMANT.`);
  }

  if (args.json) {
    log('\nJSON ' + JSON.stringify({ args, conservative: cons, realistic: real }));
  }
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// SELF-TEST + CLI
// ──────────────────────────────────────────────────────────────────────────────────────────────────

function sanity(): void {
  // splitCsvLine respects the one quoted field
  const cells = splitCsvLine('a,b,"x,y",c');
  if (cells.length !== 4 || cells[2] !== 'x,y') throw new Error('sanity: splitCsvLine quoted field');

  // a perfectly-calibrated set (won iff a fair coin at `price`) → edge ≈ 0; rebate lifts EV above conservative.
  const picks: MirrorPick[] = [
    { price: 0.1, won: true, leadHours: 36, stakeUsd: 10, outcome: 'Yes' },
    { price: 0.1, won: false, leadHours: 36, stakeUsd: 10, outcome: 'Yes' },
    { price: 0.2, won: false, leadHours: 50, stakeUsd: 10, outcome: 'Yes' },
  ];
  const cons = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0, seed: 42, mcIters: 50 });
  const real = mirrorStats(picks, { feeRate: 0.05, rebateRate: 0.25, seed: 42, mcIters: 50 });
  if (real.ev.mean <= cons.ev.mean) throw new Error('sanity: the rebate must lift the realistic EV above conservative');
  // edge is rebate-independent
  if (Math.abs(real.edge.mean - cons.edge.mean) > 1e-12) throw new Error('sanity: edge must be rebate-independent');
  // empty input is total
  const empty = mirrorStats([], { feeRate: 0.05, rebateRate: 0.25 });
  if (empty.n !== 0 || Number.isFinite(empty.ev.mean)) throw new Error('sanity: empty input must be {n:0, NaN}');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  const { values } = parseArgs({
    options: {
      csv: { type: 'string' },
      'fee-rate': { type: 'string' },
      'rebate-rate': { type: 'string' },
      lo: { type: 'string' },
      'cheap-max': { type: 'string' },
      seed: { type: 'string' },
      'mc-iters': { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const args: MirrorArgs = {
    csv: values.csv ?? 'scripts/research/out/badatmath-purchases-may23-jun21.csv',
    feeRate: values['fee-rate'] ? Number(values['fee-rate']) : 0.05,
    rebateRate: values['rebate-rate'] ? Number(values['rebate-rate']) : 0.25,
    lo: values.lo ? Number(values.lo) : 0.1,
    cheapMax: values['cheap-max'] ? Number(values['cheap-max']) : 0.25,
    seed: values.seed ? Number(values.seed) : 42,
    mcIters: values['mc-iters'] ? Number(values['mc-iters']) : 1000,
    json: Boolean(values.json),
  };
  if (!existsSync(args.csv)) {
    console.error(
      `input CSV not found: ${args.csv}\n` +
        `Generate it first: pnpm tsx scripts/research/badatmath-purchase-map.ts`,
    );
    process.exit(1);
  }
  const picks = loadPicks(args.csv, args.cheapMax);
  reportMirror(picks, args, console.log);
}
