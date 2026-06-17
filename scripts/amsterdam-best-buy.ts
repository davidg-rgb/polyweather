/**
 * scripts/amsterdam-best-buy — the continuous-time best-buy curve (AMSTERDAM-EV-MODEL.md Deliverable 2).
 *
 * The live sim races four hourly arms (13/14/15/16). This backtest sweeps a fine 5-min BUY-TIME grid
 * across the day and, for every grid time t over all resolved Amsterdam days, estimates:
 *   hit(t)  = P(our predicted bucket at t == the winning bucket),
 *   ask(t)  = the market ask on our predicted bucket at t (forward-filled, never read past t),
 *   edge(t) = mean(won − ask)        — the LOW-VARIANCE headline (paired; mean ± 1.96·SE),
 *   EV(t)   = mean(won ? 1/ask−1 : −1) — the payout-weighted signal (heavy-tailed; seeded bootstrap),
 * each WITH a 95% CI and n(t), then reports t* = argmax of a chosen objective. The shape is the result:
 * a window where our skill leads the market's price is a real edge; edge(t) → 0 everywhere is the WO-5
 * efficiency null, measured precisely. Either is a publishable analytics finding — we do not force a win.
 *
 * NO LOOK-AHEAD, and FAITHFUL to the live engine:
 *   - The running max is hourly (intraday_advances). At buy-time t we use the running max through the
 *     last COMPLETED local hour h_eff = floor(hour(t)) − 1 (hour H's bucket isn't final until H+1:00), and
 *     the bias-corrected lead-1 forecast lifts the floor at h_eff ≤ 14 — via the real seam nowcastBasisC.
 *     This makes the live arm h EXACTLY the grid point t = (h+1):00 (the arm locks odds at end-of-hour h,
 *     using runMax≤h) — so the four arms are the model's PRE-REGISTERED reference points on the curve.
 *   - The ask is the last snapshot with captured_at ≤ t (forward-fill); the bias is the trailing-30 window
 *     of (actual − forecast) over finalized days STRICTLY before the target (≥ 20 pairs) — the same
 *     walk-forward the RPC + amsterdam-nowcast-backtest use. Constants/seam shared with the engine.
 *
 * DATA REALITY (probed 2026-06-17): the odds-backtrack depth is our own market_snapshots archive
 * (~2026-05-14 → present; dense ~5-min only since ~June 12). Polymarket's /prices-history retains only
 * ~2–3 days per daily token at a coarser 10-min fidelity and 0 for events older than ~5 weeks — strictly
 * worse than our archive, so there is no deeper odds source to fetch. The curve is THIN and EXPLORATORY
 * until ~30+ dense days; n(t) is printed everywhere and t* is caveated for multiple comparisons.
 *
 * Run: pnpm tsx scripts/amsterdam-best-buy.ts [--from 11:00] [--to 18:00] [--step 5] [--min-n 10]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  AMSTERDAM_SIM_ARM_HOURS,
  AMSTERDAM_SIM_DEBIAS_MIN_PAIRS,
  AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS,
  AMSTERDAM_SIM_FORECAST_MAX_HOUR,
  armEdgeStats,
  nowcastBasisC,
  predictedBucketIdx,
  type GradedBet,
  type SimLadderBucket,
} from '../packages/core/src/index.ts';
import { loadEnv } from './lib/load-env.ts';
import { makeScriptDb, type ScriptDb } from './lib/script-db.ts';

/** Etc/GMT-2 = UTC+2 → a local wall-clock instant is this many ms ahead of UTC. */
const LOCAL_UTC_OFFSET_MS = 2 * 60 * 60 * 1000;

interface DayObs {
  date: string;
  fc1: number | null; // raw cross-model lead-1 forecast (°C)
  actual: number; // finalized WU high (°C)
}
interface AskPoint {
  t: number; // epoch SECONDS (captured_at), ascending per bucket
  ask: number;
}
interface ResolvedEvent {
  eventId: string;
  date: string;
  winnerIdx: number;
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

/** All finalized EHAM days with their raw lead-1 forecast + actual — the bias population + the day list. */
async function fetchObsDays(db: ScriptDb): Promise<DayObs[]> {
  const rows = await db.query<{ date_local: string; fc1: string | null; actual: string }>(
    `with fc as (
       select fs.target_date, avg(fs.tmax_c) filter (where fs.lead_days = 1) as fc1
       from forecast_snapshots fs where fs.icao = 'EHAM' and fs.lead_days = 1 group by fs.target_date
     )
     select o.date_local::text, fc.fc1,
       (case when o.unit = 'F' then (o.tmax_wu_native - 32) * 5.0 / 9.0 else o.tmax_wu_native end)::numeric as actual
     from observations o
     left join fc on fc.target_date = o.date_local
     where o.icao = 'EHAM' and o.finalized_at is not null and o.tmax_wu_native is not null
     order by o.date_local`,
  );
  return rows.map((r) => ({ date: r.date_local, fc1: num(r.fc1), actual: Number(r.actual) }));
}

/** Per finalized date, the running max (°C) through each local hour 0..23 (null = no obs by that hour). */
async function fetchHourMax(db: ScriptDb): Promise<Map<string, (number | null)[]>> {
  const rows = await db.query<{ date_local: string; local_hour: number; max_tenths_c: string }>(
    `select date_local::text, local_hour, max_tenths_c
     from intraday_advances where icao = 'EHAM' order by date_local, local_hour`,
  );
  const byDate = new Map<string, (number | null)[]>();
  for (const r of rows) {
    let arr = byDate.get(r.date_local);
    if (!arr) {
      arr = new Array<number | null>(24).fill(null);
      byDate.set(r.date_local, arr);
    }
    const h = Number(r.local_hour);
    if (h >= 0 && h <= 23) {
      const v = Number(r.max_tenths_c); // already °C despite the legacy name
      arr[h] = arr[h] == null ? v : Math.max(arr[h]!, v);
    }
  }
  // Forward-fill the cumulative max across hours (running max only ratchets up).
  for (const arr of byDate.values()) {
    let running: number | null = null;
    for (let h = 0; h < 24; h++) {
      if (arr[h] != null) running = running == null ? arr[h]! : Math.max(running, arr[h]!);
      arr[h] = running;
    }
  }
  return byDate;
}

/** Canonical resolved Amsterdam events (one per target_date, latest created_at) + their winners. */
async function fetchResolvedEvents(db: ScriptDb): Promise<ResolvedEvent[]> {
  const rows = await db.query<{ id: string; d: string; winning_bucket_idx: number }>(
    `select distinct on (me.target_date) me.id, me.target_date::text as d, me.winning_bucket_idx
     from market_events me join cities c on c.id = me.city_id
     where c.slug = 'amsterdam' and me.kind = 'highest' and me.winning_bucket_idx is not null
     order by me.target_date, me.created_at desc`,
  );
  return rows.map((r) => ({ eventId: r.id, date: r.d, winnerIdx: Number(r.winning_bucket_idx) }));
}

async function fetchLadders(db: ScriptDb, ids: Set<string>): Promise<Map<string, SimLadderBucket[]>> {
  const rows = await db.query<{ event_id: string; bucket_idx: number; low_native: string | null; high_native: string | null }>(
    `select mb.event_id, mb.bucket_idx, mb.low_native, mb.high_native
     from market_buckets mb
     join market_events me on me.id = mb.event_id
     join cities c on c.id = me.city_id
     where c.slug = 'amsterdam' and me.kind = 'highest' and me.winning_bucket_idx is not null
     order by mb.event_id, mb.bucket_idx`,
  );
  const byEvent = new Map<string, SimLadderBucket[]>();
  for (const r of rows) {
    if (!ids.has(r.event_id)) continue;
    let arr = byEvent.get(r.event_id);
    if (!arr) {
      arr = [];
      byEvent.set(r.event_id, arr);
    }
    arr.push({ bucketIdx: Number(r.bucket_idx), low: num(r.low_native), high: num(r.high_native) });
  }
  return byEvent;
}

/**
 * Per event → per bucketIdx → ascending ask points (epoch seconds). The forward-fill source.
 * priceMode 'ask' = the executable best_ask only (faithful, but only exists since ~2026-06-12 when the
 * live snapshot path began storing it); 'mid' = coalesce(best_ask, mid) — extends the backtrack to the
 * mid-only history (back to ~2026-05-14, "prefer our captured ask where both exist") at the cost of
 * faithfulness, since mid < ask, so a mid-based edge is an OPTIMISTIC upper bound, not executable.
 */
async function fetchAskPaths(
  db: ScriptDb,
  ids: Set<string>,
  priceMode: 'ask' | 'mid',
): Promise<Map<string, Map<number, AskPoint[]>>> {
  const priceExpr = priceMode === 'mid' ? 'coalesce(ms.best_ask, ms.mid)' : 'ms.best_ask';
  const rows = await db.query<{ event_id: string; bucket_idx: number; best_ask: string; t_epoch: string }>(
    `select mb.event_id, mb.bucket_idx, ${priceExpr} as best_ask, extract(epoch from ms.captured_at) as t_epoch
     from market_snapshots ms
     join market_buckets mb on mb.id = ms.bucket_id
     join market_events me on me.id = mb.event_id
     join cities c on c.id = me.city_id
     where c.slug = 'amsterdam' and me.kind = 'highest' and me.winning_bucket_idx is not null
       and ${priceExpr} is not null
     order by mb.event_id, mb.bucket_idx, ms.captured_at`,
  );
  const byEvent = new Map<string, Map<number, AskPoint[]>>();
  for (const r of rows) {
    if (!ids.has(r.event_id)) continue;
    let byBucket = byEvent.get(r.event_id);
    if (!byBucket) {
      byBucket = new Map();
      byEvent.set(r.event_id, byBucket);
    }
    const idx = Number(r.bucket_idx);
    let arr = byBucket.get(idx);
    if (!arr) {
      arr = [];
      byBucket.set(idx, arr);
    }
    arr.push({ t: Number(r.t_epoch), ask: Number(r.best_ask) });
  }
  return byEvent;
}

/** Last ask at-or-before targetSec (forward-fill), or null when none — binary search on ascending t. */
function askAsOf(points: AskPoint[] | undefined, targetSec: number): number | null {
  if (!points || points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.t <= targetSec) {
      best = points[mid]!.ask;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** Walk-forward bias-corrected lead-1 forecast per date (trailing window, ≥ MIN_PAIRS, else null). */
function buildBcfByDate(days: DayObs[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const prior: { fc: number; actual: number }[] = [];
  for (const d of days) {
    const windowed = prior.slice(-AMSTERDAM_SIM_DEBIAS_WINDOW_DAYS);
    const bias =
      windowed.length >= AMSTERDAM_SIM_DEBIAS_MIN_PAIRS
        ? windowed.reduce((s, p) => s + (p.actual - p.fc), 0) / windowed.length
        : null;
    out.set(d.date, d.fc1 != null && bias != null ? d.fc1 + bias : null);
    if (d.fc1 != null) prior.push({ fc: d.fc1, actual: d.actual });
  }
  return out;
}

const parseHHMM = (s: string): number => {
  const [h, m] = s.split(':').map((x) => Number(x));
  return (h ?? 0) * 60 + (m ?? 0);
};
const fmtHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const ci2 = (lo: number, hi: number): string =>
  Number.isFinite(lo) && Number.isFinite(hi)
    ? `[${lo >= 0 ? '+' : ''}${lo.toFixed(2)}, ${hi >= 0 ? '+' : ''}${hi.toFixed(2)}]`
    : '[—]';
const pct = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : '—');

interface GridRow {
  min: number; // minutes from local midnight
  stats: ReturnType<typeof armEdgeStats>;
}

async function main(): Promise<void> {
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string', default: '11:00' },
      to: { type: 'string', default: '18:00' },
      step: { type: 'string', default: '5' },
      'min-n': { type: 'string', default: '10' },
      price: { type: 'string', default: 'ask' },
    },
  });
  const fromMin = parseHHMM(values.from ?? '11:00');
  const toMin = parseHHMM(values.to ?? '18:00');
  const step = Math.max(1, Number(values.step ?? 5));
  const minN = Math.max(1, Number(values['min-n'] ?? 10));
  const priceMode: 'ask' | 'mid' = values.price === 'mid' ? 'mid' : 'ask';

  const db = makeScriptDb();
  try {
    const [obsDays, hourMaxByDate, events] = await Promise.all([
      fetchObsDays(db),
      fetchHourMax(db),
      fetchResolvedEvents(db),
    ]);
    const eventIds = new Set(events.map((e) => e.eventId));
    const [ladders, askPaths] = await Promise.all([
      fetchLadders(db, eventIds),
      fetchAskPaths(db, eventIds, priceMode),
    ]);
    const bcfByDate = buildBcfByDate(obsDays);
    const actualByDate = new Map(obsDays.map((d) => [d.date, d.actual]));

    // Accumulate (won, ask) per grid minute across all scorable days.
    const byGrid = new Map<number, GradedBet[]>();
    for (let m = fromMin; m <= toMin; m += step) byGrid.set(m, []);

    let scoredDays = 0;
    let firstScored = '';
    let lastScored = '';
    for (const ev of events) {
      const ladder = ladders.get(ev.eventId);
      const hourMax = hourMaxByDate.get(ev.date);
      const asks = askPaths.get(ev.eventId);
      // scorable = resolved + has intraday running max + has an actual + a ladder
      if (!ladder || !hourMax || !actualByDate.has(ev.date)) continue;
      const bcf = bcfByDate.get(ev.date) ?? null;
      const dayStartUtcSec = (Date.UTC(
        Number(ev.date.slice(0, 4)), Number(ev.date.slice(5, 7)) - 1, Number(ev.date.slice(8, 10)),
      ) - LOCAL_UTC_OFFSET_MS) / 1000;

      let dayContributed = false;
      for (let m = fromMin; m <= toMin; m += step) {
        const hourOfT = Math.floor(m / 60);
        const hEff = hourOfT - 1; // running max through the last COMPLETED local hour (no look-ahead)
        if (hEff < 0) continue;
        const runMax = hourMax[Math.min(23, hEff)];
        if (runMax == null) continue; // no running max known that early on this day
        const basis = nowcastBasisC(runMax, hEff, bcf);
        const predIdx = predictedBucketIdx(ladder, basis);
        const tSec = dayStartUtcSec + m * 60;
        const ask = askAsOf(asks?.get(predIdx), tSec);
        if (ask == null || ask <= 0 || ask > 1) continue; // no usable quote on our bucket → no-bet
        byGrid.get(m)!.push({ won: predIdx === ev.winnerIdx, ask });
        dayContributed = true;
      }
      if (dayContributed) {
        scoredDays += 1;
        if (!firstScored || ev.date < firstScored) firstScored = ev.date;
        if (ev.date > lastScored) lastScored = ev.date;
      }
    }

    const grid: GridRow[] = [...byGrid.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([min, bets]) => ({ min, stats: armEdgeStats(bets, { bootstrapSeed: 42 }) }));

    // ---- report ------------------------------------------------------------------------------------
    console.log('\nAmsterdam best-buy curve — EHAM, 5-min buy-time grid (our archive only)');
    console.log(
      `  ${events.length} resolved events; ${scoredDays} scored (intraday + odds), ` +
        `${firstScored || '—'} → ${lastScored || '—'}. Grid ${values.from}→${values.to} local, step ${step}min.`,
    );
    console.log(
      priceMode === 'mid'
        ? '  PRICE = coalesce(best_ask, mid): extends the backtrack to mid-only history (~May 14→), but mid < ' +
            'ask so the edge here is an OPTIMISTIC upper bound, NOT an executable price. Use --price ask for the faithful curve.'
        : '  PRICE = best_ask (executable). It only exists since ~2026-06-12 (older snapshots stored mid only), ' +
            'so this faithful curve is ~5 resolved days. Use --price mid to extend (optimistically) to the mid-only history.',
    );
    console.log(
      `  Pred = wuRound(max(runMax≤h_eff, biasForecast)) at h_eff≤${AMSTERDAM_SIM_FORECAST_MAX_HOUR}, else floor; ` +
        `h_eff = hour(t)−1 (last completed hour). Ask forward-filled ≤ t. Walk-forward, no look-ahead. All °C.`,
    );
    console.log('  ◀ = a live arm (arm h ≡ grid (h+1):00). edge = mean(won−ask); EV/$1 = mean(won?1/ask−1:−1); 95% CIs.\n');
    console.log('  time   n   hit   ask  │ edge   95% CI            │ EV/$1  95% CI');
    console.log('  ──────────────────────┼──────────────────────────┼────────────────────────────');
    for (const row of grid) {
      const s = row.stats;
      if (s.nGraded === 0) continue; // skip empty grid points for readability (n(t)=0)
      const armH = Math.floor(row.min / 60) - 1;
      const isArm = row.min % 60 === 0 && (AMSTERDAM_SIM_ARM_HOURS as readonly number[]).includes(armH);
      const verdict = s.edgeCiLo > 0 ? ' ✚' : s.edgeCiHi < 0 ? ' ✖' : '  ';
      console.log(
        `  ${fmtHHMM(row.min)} ${String(s.nGraded).padStart(3)}  ${pct(s.hitRate).padStart(4)}  ` +
          `${s.avgAsk.toFixed(2)} │ ${(s.edge >= 0 ? '+' : '') + s.edge.toFixed(2)}  ${ci2(s.edgeCiLo, s.edgeCiHi).padEnd(20)}│ ` +
          `${(s.ev >= 0 ? '+' : '') + s.ev.toFixed(2)}  ${ci2(s.evCiLo, s.evCiHi)}${verdict}${isArm ? '  ◀ arm ' + armH : ''}`,
      );
    }

    // ---- t* (caveated for multiple comparisons) ----------------------------------------------------
    const credible = grid.filter((r) => r.stats.nGraded >= minN && Number.isFinite(r.stats.edge));
    const pickMax = (rows: GridRow[], key: (s: GridRow['stats']) => number): GridRow | null =>
      rows.reduce<GridRow | null>((best, r) => (best == null || key(r.stats) > key(best.stats) ? r : best), null);
    const tStarEdge = pickMax(credible, (s) => s.edge);
    const tStarEv = pickMax(credible, (s) => s.ev);
    const anyOffZero = credible.filter((r) => r.stats.edgeCiLo > 0);

    console.log('\n  ── t* (credible points only, n ≥ ' + minN + ') ──');
    if (credible.length === 0) {
      console.log(`  No grid point yet has ≥ ${minN} graded bets — the dense-odds window is still too thin to call.`);
    } else {
      if (tStarEdge) {
        const s = tStarEdge.stats;
        console.log(
          `  argmax edge: ${fmtHHMM(tStarEdge.min)}  edge ${(s.edge >= 0 ? '+' : '') + s.edge.toFixed(3)} ` +
            `${ci2(s.edgeCiLo, s.edgeCiHi)}  (n=${s.nGraded}, hit ${pct(s.hitRate)}, ask ${s.avgAsk.toFixed(2)})`,
        );
      }
      if (tStarEv) {
        const s = tStarEv.stats;
        console.log(
          `  argmax EV/$1: ${fmtHHMM(tStarEv.min)}  EV ${(s.ev >= 0 ? '+' : '') + s.ev.toFixed(3)} ` +
            `${ci2(s.evCiLo, s.evCiHi)}  (n=${s.nGraded})`,
        );
      }
      console.log(
        `  ${anyOffZero.length} of ${credible.length} credible grid points have an edge CI strictly above 0` +
          (anyOffZero.length === 0 ? ' → consistent with the efficient-market null (WO-5).' : ' (✚ above).'),
      );
      console.log(
        '  CAVEAT: scanning ' + grid.length + ' grid times and picking the max inflates significance ' +
          '(multiple comparisons). Treat t* as a hypothesis, not a verdict — the pre-registered tests are the ' +
          '4 live arms (◀). Re-read at ~30+ dense-odds days.',
      );
    }
    console.log('');
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('amsterdam-best-buy crashed:', err?.message ?? err);
    process.exit(1);
  });
}
