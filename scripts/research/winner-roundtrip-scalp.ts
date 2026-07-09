/**
 * scripts/research/winner-roundtrip-scalp — the PEAK→DIP→RECOVER round-trip test.
 *
 * The operator's hypothesis: a bucket that trades UP past ~25¢, then DIPS to 10–15¢, then RECOVERS
 * back to 25–35¢ is a mean-reversion round-trip you can scalp — buy the dip, sell the recovery.
 * Unlike the C19 "buy the lifetime minimum" test (hindsight/survivorship), this entry condition
 * (ALREADY peaked, now dipped) is fully observable at entry time, so the rule is FORWARD-EXECUTABLE.
 * That is the new contribution over C19/C20.
 *
 * Two parts, both over the full local `market-history` archive (46 cities, ~1-min implied-prob/MID
 * series — NOT bid/ask; the real taker ask sits a spread above via CALIBRATED_BOOK):
 *
 *   PART A — CURVATURE by offset from the winner. For every bucket in every resolved event we compute
 *     offset = idx − winnerIdx, group into {winner 0, ±1, ±2, FAR |off|≥3}, and characterise the
 *     peak→dip→recover shape: peak-rate, dip-after-peak rate, oscillation cycle count, and the
 *     RECOVERY rate (P(back to 25¢ | peaked then dipped)). This answers the operator's question —
 *     "is the curvature different near the winner vs far from it?"
 *
 *   PART B — the TRADE, scored honestly. One round-trip per bucket (first peak→dip entry). Population
 *     = every bucket that triggers, UNCONDITIONAL on offset (live we don't know the winner). Buy at
 *     the dip mid, sell when mid first ≥ SELL (25¢); if it never recovers, hold to resolution
 *     (win→$1, lose→$0). Scored frictionless, then as a real TAKER round-trip (execAsk in / execBid
 *     out via CALIBRATED_BOOK + 0.05·p·(1−p) fee both legs), swept over spread ×{0..2} for the
 *     breakeven multiple, plus the MARTINGALE NULL (empirical recover rate vs entry/SELL). Emits a
 *     per-trade panel CSV for the §9R-E gate (analytics.py gate --panel).
 *
 * Read-only; writes only out/. Run:
 *   pnpm tsx scripts/research/winner-roundtrip-scalp.ts
 *   pnpm tsx scripts/research/winner-roundtrip-scalp.ts --peak 0.25 --dipLo 0.10 --dipHi 0.15 --sell 0.25
 *   pnpm tsx scripts/research/winner-roundtrip-scalp.ts --cities nyc,london
 * Output: out/winner-roundtrip-panel.csv, out/winner-roundtrip-panel-maker.csv,
 *         out/WINNER-ROUNDTRIP-ANALYSIS.md
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CALIBRATED_BOOK, synthBook } from '../../packages/core/src/sim/history-replay-ingest.ts';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import { type Bucket, type EventFile, quantile, winnerIdx } from './winner-band-prices.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = join(HERE, 'out', 'market-history');
const OUT_DIR = join(HERE, 'out');
const FEE_RATE = 0.05; // Polymarket weather taker fee replica (fees.ts / analytics.py)

// ── Params (defaults = the operator's numbers) ────────────────────────────────────────────────────
export interface ScalpParams {
  peak: number; // arm once price trades ≥ this ("go past 25¢")
  dipLo: number; // buy when price dips into [dipLo, dipHi]
  dipHi: number;
  sell: number; // limit-sell target (first touch of "back at 25–35¢" band lower edge)
}
export const DEFAULT_PARAMS: ScalpParams = { peak: 0.25, dipLo: 0.1, dipHi: 0.15, sell: 0.25 };

// ── The state machine ─────────────────────────────────────────────────────────────────────────────

export interface RoundTrip {
  entryP: number; // mid at the dip-buy
  targetHit: boolean; // recovered to SELL before resolution
  proceedsMid: number; // SELL if targetHit, else resolution value (won?1:0)
  won: boolean; // the bucket's resolvedOutcome
  entryIdx: number; // point index of entry (for timing)
  exitIdx: number; // point index of exit
}

/**
 * One round-trip per bucket: arm on the first p≥peak, buy on the first later p∈[dipLo,dipHi], exit on
 * the first later p≥sell (targetHit) else hold to the end (resolution). Returns null if it never
 * triggered an entry. Pure — operates on the raw MID point series.
 */
export function simulateRoundTrip(points: Array<[number, number]>, won: boolean, pp: ScalpParams): RoundTrip | null {
  let armed = false;
  let entered = false;
  let entryP = 0;
  let entryIdx = -1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]![1];
    if (!entered) {
      if (!armed) {
        if (p >= pp.peak) armed = true;
      } else if (p >= pp.dipLo && p <= pp.dipHi) {
        entered = true;
        entryP = p;
        entryIdx = i;
      }
    } else if (p >= pp.sell) {
      return { entryP, targetHit: true, proceedsMid: pp.sell, won, entryIdx, exitIdx: i };
    }
  }
  if (entered) return { entryP, targetHit: false, proceedsMid: won ? 1 : 0, won, entryIdx, exitIdx: points.length - 1 };
  return null;
}

/** Curvature/oscillation shape of one bucket path (no trading). */
export interface Curvature {
  peaked: boolean; // ever ≥ peak
  dippedAfterPeak: boolean; // entered [dipLo,dipHi] after a peak
  recovered: boolean; // reached ≥ sell after such a dip
  cycles: number; // completed peak→dip→recover oscillations
  peakDips: number; // peak→dip events (whether or not they recovered)
}
export function curvature(points: Array<[number, number]>, pp: ScalpParams): Curvature {
  let peaked = false;
  let dippedAfterPeak = false;
  let recovered = false;
  let cycles = 0;
  let peakDips = 0;
  // rolling state: awaitingDip (armed) → holding (dipped) → recover re-arms
  let awaitingDip = false;
  let holding = false;
  for (const [, p] of points) {
    if (p >= pp.peak) peaked = true;
    if (holding) {
      if (p >= pp.sell) {
        recovered = true;
        cycles++;
        holding = false; // re-arm from scratch (needs a fresh peak)
      }
    } else if (awaitingDip) {
      if (p >= pp.dipLo && p <= pp.dipHi) {
        dippedAfterPeak = true;
        peakDips++;
        awaitingDip = false;
        holding = true;
      }
    } else if (p >= pp.peak) {
      awaitingDip = true;
    }
  }
  return { peaked, dippedAfterPeak, recovered, cycles, peakDips };
}

// ── Costed scoring (real taker round-trip via CALIBRATED_BOOK + fee) ────────────────────────────────

export interface Costed {
  cost: number; // what you pay to acquire 1 share
  proceeds: number; // what you receive on exit
  netPnl: number;
  netReturn: number; // netPnl / cost
}

/**
 * Score a round-trip. mode 'frictionless' = mid in / mid out, no fee. mode 'taker' = buy execAsk +
 * fee, sell execBid + fee (or redeem at resolution, no fee). mode 'maker' = buy execAsk + fee, but
 * the recovery exit rests a MAKER sell at `sell` (fills at `sell`, $0 fee) — the optimistic ceiling.
 * spreadMult scales the CALIBRATED_BOOK half-spreads (0 = frictionless book, 1 = calibrated).
 */
export function scoreTrip(rt: RoundTrip, pp: ScalpParams, mode: 'frictionless' | 'taker' | 'maker', spreadMult: number): Costed | null {
  if (mode === 'frictionless') {
    const cost = rt.entryP;
    const proceeds = rt.proceedsMid;
    return { cost, proceeds, netPnl: proceeds - cost, netReturn: (proceeds - cost) / cost };
  }
  const qBuy = synthBook(rt.entryP, CALIBRATED_BOOK, spreadMult);
  if (!qBuy) return null;
  const cost = qBuy.execAsk + takerFeePerShare(qBuy.execAsk, FEE_RATE);
  let proceeds: number;
  if (rt.targetHit) {
    if (mode === 'maker') {
      proceeds = pp.sell; // rest a sell at the target: fill at the target, no taker fee
    } else {
      const qSell = synthBook(pp.sell, CALIBRATED_BOOK, spreadMult);
      if (!qSell) return null;
      proceeds = qSell.execBid - takerFeePerShare(qSell.execBid, FEE_RATE);
    }
  } else {
    proceeds = rt.won ? 1 : 0; // resolution redemption, no fee
  }
  return { cost, proceeds, netPnl: proceeds - cost, netReturn: (proceeds - cost) / cost };
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs: number[]): number => quantile(xs, 0.5);
const pc = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
const c2 = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}¢` : '—');
const csv = (v: string | number | null): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function offsetGroup(off: number): string {
  if (off === 0) return '0 (winner)';
  if (Math.abs(off) === 1) return '±1';
  if (Math.abs(off) === 2) return '±2';
  return 'far (≥3)';
}

// ── Runner ────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cities: { type: 'string' },
      peak: { type: 'string' },
      dipLo: { type: 'string' },
      dipHi: { type: 'string' },
      sell: { type: 'string' },
    },
  });
  if (!existsSync(OUT_ROOT)) throw new Error(`no archive at ${OUT_ROOT} — run pull-market-history first`);
  const pp: ScalpParams = {
    peak: values.peak ? Number(values.peak) : DEFAULT_PARAMS.peak,
    dipLo: values.dipLo ? Number(values.dipLo) : DEFAULT_PARAMS.dipLo,
    dipHi: values.dipHi ? Number(values.dipHi) : DEFAULT_PARAMS.dipHi,
    sell: values.sell ? Number(values.sell) : DEFAULT_PARAMS.sell,
  };
  const cityFilter = values.cities ? new Set(values.cities.split(',').map((s) => s.trim())) : null;
  const cities = readdirSync(OUT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (!cityFilter || cityFilter.has(d.name)))
    .map((d) => d.name)
    .sort();

  // PART A aggregates: group -> counts
  interface GroupAgg {
    nBuckets: number;
    peaked: number;
    dippedAfterPeak: number;
    recovered: number; // among dippedAfterPeak
    peakDipsTotal: number;
    cyclesTotal: number;
    entryPs: number[]; // entry mids for triggered trades
    targetHits: number; // trades that hit target
    trades: number;
  }
  const groups = new Map<string, GroupAgg>();
  const g = (k: string): GroupAgg => {
    if (!groups.has(k))
      groups.set(k, { nBuckets: 0, peaked: 0, dippedAfterPeak: 0, recovered: 0, peakDipsTotal: 0, cyclesTotal: 0, entryPs: [], targetHits: 0, trades: 0 });
    return groups.get(k)!;
  };

  // PART B panel: one row per triggered trade (taker ×1 for the gate) + a maker-exit twin
  const panelHeader = ['city', 'target_date', 'event_id', 'bucket_idx', 'offset', 'entry_p', 'target_hit', 'won', 'net_return', 'net_pnl_usd'].join(',');
  const takerLines: string[] = [panelHeader];
  const makerLines: string[] = [panelHeader];
  const fricLines: string[] = [panelHeader];

  // spread sweep accumulators (mean net-return over all trades at each mult, taker mode)
  const sweepMults = [0, 0.5, 0.7, 1.0, 1.5, 2.0];
  const sweepNet = new Map<number, number[]>(sweepMults.map((m) => [m, []]));
  const makerNet: number[] = [];
  const fricNet: number[] = [];

  let totalEvents = 0;
  let resolvedEvents = 0;
  let skipped = 0;
  let trades = 0;

  for (const city of cities) {
    const dir = join(OUT_ROOT, city);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      totalEvents++;
      let ev: EventFile;
      try {
        ev = JSON.parse(readFileSync(join(dir, f), 'utf8')) as EventFile;
      } catch {
        skipped++;
        continue;
      }
      const wi = winnerIdx(ev.buckets);
      if (wi === null) continue;
      resolvedEvents++;
      for (const b of ev.buckets as Bucket[]) {
        if (!b.points || b.points.length === 0) continue;
        const off = b.idx - wi;
        const grp = g(offsetGroup(off));
        grp.nBuckets++;
        const cv = curvature(b.points, pp);
        if (cv.peaked) grp.peaked++;
        if (cv.dippedAfterPeak) {
          grp.dippedAfterPeak++;
          if (cv.recovered) grp.recovered++;
        }
        grp.peakDipsTotal += cv.peakDips;
        grp.cyclesTotal += cv.cycles;

        const won = b.resolvedOutcome === 'win';
        const rt = simulateRoundTrip(b.points, won, pp);
        if (!rt) continue;
        trades++;
        grp.trades++;
        grp.entryPs.push(rt.entryP);
        if (rt.targetHit) grp.targetHits++;

        // scored variants
        const fric = scoreTrip(rt, pp, 'frictionless', 1);
        const taker = scoreTrip(rt, pp, 'taker', 1);
        const maker = scoreTrip(rt, pp, 'maker', 1);
        for (const m of sweepMults) {
          const s = scoreTrip(rt, pp, 'taker', m);
          if (s) sweepNet.get(m)!.push(s.netReturn);
        }
        if (fric) fricNet.push(fric.netReturn);
        if (maker) makerNet.push(maker.netReturn);

        const rowBase = [csv(ev.city), csv(ev.targetDate), csv(ev.eventId), b.idx, off, rt.entryP.toFixed(4), rt.targetHit ? 1 : 0, won ? 1 : 0];
        if (fric) fricLines.push([...rowBase, fric.netReturn.toFixed(6), fric.netPnl.toFixed(6)].join(','));
        if (taker) takerLines.push([...rowBase, taker.netReturn.toFixed(6), taker.netPnl.toFixed(6)].join(','));
        if (maker) makerLines.push([...rowBase, maker.netReturn.toFixed(6), maker.netPnl.toFixed(6)].join(','));
      }
    }
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'winner-roundtrip-panel.csv'), takerLines.join('\n') + '\n');
  writeFileSync(join(OUT_DIR, 'winner-roundtrip-panel-maker.csv'), makerLines.join('\n') + '\n');
  writeFileSync(join(OUT_DIR, 'winner-roundtrip-panel-frictionless.csv'), fricLines.join('\n') + '\n');

  // ── analysis MD ────────────────────────────────────────────────────────────────────────────────
  const order = ['0 (winner)', '±1', '±2', 'far (≥3)'];
  const md: string[] = [];
  md.push('# Peak→dip→recover round-trip — 46-city market-history');
  md.push('');
  md.push(
    `_Params: arm on p≥**${pc(pp.peak)}**, buy on dip into **[${pc(pp.dipLo)}, ${pc(pp.dipHi)}]**, sell on recover to **≥${pc(pp.sell)}**. Prices are ~1-min MID (a LOWER bound on the taker ask; real costs applied via the committed CALIBRATED_BOOK synthetic-book model + ${pc(FEE_RATE)}·p·(1−p) fee)._`,
  );
  md.push('');
  md.push(`- Cities: **${cities.length}** · events scanned: **${totalEvents.toLocaleString()}** · resolved: **${resolvedEvents.toLocaleString()}** · corrupt skipped: ${skipped} · triggered trades: **${trades.toLocaleString()}**`);
  md.push('');

  // Part A
  md.push('## Part A — curvature by offset from the winner');
  md.push('');
  md.push('_"Is the peak→dip→recover shape different near the winner vs far from it?" One row per offset group; rates are per-bucket._');
  md.push('');
  md.push('| offset group | buckets | % ever peaked (≥25¢) | % dip-after-peak | mean peak→dips/bkt | **recovery rate** (recover \\| dipped) | trades | target-hit rate |');
  md.push('|:--|---:|---:|---:|---:|---:|---:|---:|');
  for (const k of order) {
    const a = groups.get(k);
    if (!a) continue;
    md.push(
      `| ${k} | ${a.nBuckets.toLocaleString()} | ${pc(a.peaked / a.nBuckets)} | ${pc(a.dippedAfterPeak / a.nBuckets)} | ${(a.peakDipsTotal / a.nBuckets).toFixed(2)} | **${pc(a.recovered / a.dippedAfterPeak)}** | ${a.trades.toLocaleString()} | ${pc(a.targetHits / a.trades)} |`,
    );
  }
  md.push('');
  md.push(
    '> **Recovery rate** = P(price returns to ≥25¢ | it peaked ≥25¢ then dipped to 10–15¢). If this is ~equal across offset groups, the peak→dip→recover oscillation carries NO information about which bucket wins — it is microstructure, priced by the current level, not a winner signal.',
  );
  md.push('');

  // Part B — the trade
  const allEntryPs = order.flatMap((k) => groups.get(k)?.entryPs ?? []);
  const allHits = order.reduce((s, k) => s + (groups.get(k)?.targetHits ?? 0), 0);
  const medEntry = median(allEntryPs);
  const hitRate = allHits / trades;
  const martingaleP = medEntry / pp.sell; // martingale prediction of hit-rate
  md.push('## Part B — the trade (buy the dip, sell the recovery)');
  md.push('');
  md.push(`- **Population:** ${trades.toLocaleString()} triggered round-trips (one per bucket, UNCONDITIONAL on offset — live you don't know the winner).`);
  md.push(`- **Median entry (dip mid):** ${c2(medEntry)}. **Target-hit rate:** ${pc(hitRate)}.`);
  md.push(`- **Martingale null:** a fair (martingale) book hits ${pc(pp.sell)} before 0 with prob entry/sell = ${c2(medEntry)}/${pc(pp.sell)} = **${pc(martingaleP)}**. Empirical hit-rate **${pc(hitRate)}** ${hitRate > martingaleP ? 'exceeds' : hitRate < martingaleP ? 'is below' : 'equals'} the null.`);
  md.push('');
  md.push('### Net return by cost model (mean over all trades)');
  md.push('');
  md.push('| cost model | mean net-return | note |');
  md.push('|:--|---:|:--|');
  md.push(`| Frictionless (mid in/out, no fee) | ${pc(mean(fricNet))} | the raw path edge (upper bound) |`);
  for (const m of sweepMults) {
    const arr = sweepNet.get(m)!;
    md.push(`| Taker, spread ×${m} + fee | ${pc(mean(arr))} | ${m === 1 ? '**the realistic taker round-trip**' : m === 0 ? 'fee only, no spread' : ''} |`);
  }
  md.push(`| Maker-exit (rest sell at target, $0 fee) + fee entry | ${pc(mean(makerNet))} | optimistic ceiling (adverse-selection-unadjusted) |`);
  md.push('');

  // breakeven spread multiple (linear interp on taker sweep where mean crosses 0)
  const sweepPairs = sweepMults.map((m) => [m, mean(sweepNet.get(m)!)] as [number, number]).sort((a, b) => a[0] - b[0]);
  let breakeven = NaN;
  for (let i = 1; i < sweepPairs.length; i++) {
    const [m0, v0] = sweepPairs[i - 1]!;
    const [m1, v1] = sweepPairs[i]!;
    if (v0 === 0) breakeven = m0;
    else if (v0 > 0 !== v1 > 0) breakeven = m0 + ((m1 - m0) * (0 - v0)) / (v1 - v0);
  }
  md.push(`- **Breakeven spread multiple** (taker mean net-return crosses 0): **×${Number.isFinite(breakeven) ? breakeven.toFixed(2) : '—'}** of the calibrated spread. ${Number.isFinite(breakeven) && breakeven < 1 ? '(< ×1 ⇒ the real spread consumes the edge — a MAKER edge at best, not a taker edge.)' : Number.isFinite(breakeven) ? '(≥ ×1 ⇒ survives the real spread.)' : '(never positive at any spread — dead frictionless too.)'}`);
  md.push('');
  md.push(
    '_The §9R-E GO/KILL gate (city + day clustered, zero-skill MC) is run separately over `winner-roundtrip-panel.csv` (taker ×1) — see the run log / verdict. A positive point estimate with a CI that includes 0 is a KILL._',
  );
  md.push('');

  const mdPath = join(OUT_DIR, 'WINNER-ROUNDTRIP-ANALYSIS.md');
  writeFileSync(mdPath, md.join('\n') + '\n');

  // ── console summary ──────────────────────────────────────────────────────────────────────────────
  console.log(`\n=== round-trip scalp: ${resolvedEvents.toLocaleString()}/${totalEvents.toLocaleString()} resolved · ${trades.toLocaleString()} trades ===`);
  console.log(`    params peak≥${pc(pp.peak)} dip[${pc(pp.dipLo)},${pc(pp.dipHi)}] sell≥${pc(pp.sell)}`);
  for (const k of order) {
    const a = groups.get(k);
    if (!a) continue;
    console.log(`    ${k.padEnd(11)} recover ${pc(a.recovered / a.dippedAfterPeak)} · target-hit ${pc(a.targetHits / a.trades)} (n=${a.trades})`);
  }
  console.log(`    median entry ${c2(medEntry)} · hit ${pc(hitRate)} · martingale null ${pc(martingaleP)}`);
  console.log(`    frictionless ${pc(mean(fricNet))} · taker×1 ${pc(mean(sweepNet.get(1)!))} · maker ${pc(mean(makerNet))} · breakeven ×${Number.isFinite(breakeven) ? breakeven.toFixed(2) : '—'}`);
  console.log(`    panel → out/winner-roundtrip-panel.csv (taker×1) · maker twin · frictionless twin`);
  console.log(`    analysis → ${mdPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
