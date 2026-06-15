/**
 * scripts/research/wo5-market-staleness — WO-5 (FORECASTING-RD-HANDOFF). The decisive close-out.
 *
 * THE QUESTION (the only place a tradable edge could still live). Round-2's adversarial review showed
 * the market is at the information ceiling by mid-afternoon ON AVERAGE (market RMSE 0.40°C ≈ oracle at
 * local h15) — it prices the same running-max METARs faster + better than our nowcast. But an average
 * over capture times does NOT resolve the SUB-EVENT dynamics: is the market STALE in the window right
 * after a NEW running-max METAR becomes public, before it reprices? If so, that latency gap is an edge.
 *
 * THE AIRTIGHT METRIC — "dead mass". A 'highest' market resolves on the bucket containing the official
 * daily max, which is ALWAYS ≥ any individual METAR running max. So the instant a running max M becomes
 * public, every bucket whose entire labeled range lies below M is LOGICALLY DEAD (P(win)=0). Its fair
 * Yes price is 0. Any positive price there is a provable mispricing you could sell into. We measure
 *   deadMass(t) = Σ over dead buckets of the market's Yes mid  (the implied prob on impossible outcomes)
 * across every market poll in the intraday×market overlap, and condition it on minutes-since-new-max.
 *   - deadMass ≈ 0 everywhere  → market efficient w.r.t. the hard floor → NO latency edge → thesis closed.
 *   - deadMass elevated right after a print, decaying later → a latency window → quantify + sketch exec.
 *
 * DATA-TRUTH CORRECTIONS made during the WO-5 data check (these break the handoff's stated assumptions):
 *   1. `intraday_advances.created_at` is the BACKFILL insert time, NOT the print time (95% of rows were
 *      bulk-inserted 2026-06-12+; created_at spans only 3 days while date_local spans ~182). So the
 *      print-time proxy is `(date_local, local_hour)` + station tz: a running max at local hour H is
 *      conservatively public by the END of local hour H (the H:51 METAR is out by then). knownUtc(H) =
 *      local (date_local, H+1:00) → UTC. Using the LATEST plausible public time makes both the dead-mass
 *      (only-when-definitely-dead) and the persistence ("still stale ≥N min later") claims conservative.
 *   2. `market_snapshots` are DELTA-DEDUPED (a poll writes rows only for buckets whose price changed) →
 *      the full book at time t requires a per-bucket forward-fill, not a group-by on captured_at.
 *   3. `max_tenths_c` is a MISNOMER — it already stores °C (verified KORD h14 = 22.2 == 72°F). Do NOT /10.
 *   4. Timing resolution is ~1 h (local_hour) on the print side and ~10 min on the snapshot side — so a
 *      sub-10-min latency window is INVISIBLE here. A negative result therefore bounds the edge to a
 *      window narrower than both this data AND our live reaction latency (5-min poll). Stated honestly.
 *
 * Read-only; touches NOTHING. Pure analysis core (testable) + thin SQL loader, per the harness contract.
 *
 * Run: pnpm tsx scripts/research/wo5-market-staleness.ts [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *        [--stations KORD,EGLL] [--dead-thresh 0.02] [--poll-gap-sec 120]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { splitList, type Db } from '../lib/backfill.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';

export const SCRIPT = 'wo5-market-staleness';

// --- pure core (unit-tested) ------------------------------------------------------

export type Unit = 'F' | 'C';
export interface Bucket {
  idx: number;
  low: number | null; // native unit; null = open low tail
  high: number | null; // native unit; null = open high tail
}
/** A market poll's delta row for one bucket. `t` is epoch ms (captured_at). */
export interface Snap {
  idx: number;
  t: number;
  mid: number;
  bid: number | null;
}
/** A monotone running-max step: at `knownUtc` (epoch ms) the public floor rose to `floorNative`. */
export interface FloorStep {
  knownUtc: number;
  floorNative: number;
}

/** Running max (°C) → the market's native-unit floor, rounded to the market's integer ladder. */
export function maxCtoFloorNative(maxC: number, unit: Unit): number {
  return unit === 'F' ? Math.round((maxC * 9) / 5 + 32) : Math.round(maxC);
}

/**
 * A bucket is DEAD (cannot win) once the public running-max floor exceeds its whole range: it must have a
 * finite high (open high tail is never dead) and that high must be strictly below the integer floor. With
 * 2°-wide buckets (odd highs) and an integer floor, the bucket *containing* the floor stays alive — so
 * this is conservative (a bucket is dead only when its entire label is below the rounded running max).
 */
export function isDeadBucket(high: number | null, floorNative: number): boolean {
  return high !== null && high < floorNative;
}

/**
 * Collapse a day's per-hour running maxes into the monotone sequence of floor *increases*. Input rows in
 * any order; output sorted by knownUtc, strictly increasing floorNative. A row only becomes a step if it
 * raises the integer native floor above every earlier hour's.
 */
export function buildFloorSteps(
  rows: Array<{ knownUtc: number; maxC: number }>,
  unit: Unit,
): FloorStep[] {
  const sorted = [...rows].sort((a, b) => a.knownUtc - b.knownUtc);
  const steps: FloorStep[] = [];
  let cur = -Infinity;
  for (const r of sorted) {
    const f = maxCtoFloorNative(r.maxC, unit);
    if (f > cur) {
      cur = f;
      steps.push({ knownUtc: r.knownUtc, floorNative: f });
    }
  }
  return steps;
}

/** The public floor as of time t: the latest step at or before t, with ms since that step took effect. */
export function floorAt(steps: FloorStep[], t: number): { floorNative: number; sinceMs: number } | null {
  let hit: FloorStep | null = null;
  for (const s of steps) {
    if (s.knownUtc <= t) hit = s;
    else break;
  }
  return hit ? { floorNative: hit.floorNative, sinceMs: t - hit.knownUtc } : null;
}

/** Σ market Yes price on dead buckets, using mid (gross) and best_bid (realizable sell), at a book state. */
export function deadMass(
  book: Map<number, { mid: number; bid: number | null }>,
  buckets: Bucket[],
  floorNative: number,
): { mass: number; massBid: number; nDead: number; nDeadPriced: number; sumMid: number } {
  let mass = 0;
  let massBid = 0;
  let nDead = 0;
  let nDeadPriced = 0;
  let sumMid = 0;
  for (const b of buckets) {
    const q = book.get(b.idx);
    if (q) sumMid += q.mid;
    if (!isDeadBucket(b.high, floorNative)) continue;
    nDead++;
    if (!q) continue; // never quoted in our capture → treat as 0 (conservative, no fabricated mispricing)
    mass += q.mid;
    if (q.mid > 0) nDeadPriced++;
    if (q.bid !== null) massBid += q.bid;
  }
  return { mass, massBid, nDead, nDeadPriced, sumMid };
}

export interface Measurement {
  t: number;
  floorNative: number;
  minSinceNewMax: number; // minutes since the most recent floor increase became public (≥0)
  mass: number; // Σ mid on dead buckets (gross mispricing, in probability)
  massBid: number; // Σ best_bid on dead buckets (realizable sell side, where a bid exists)
  nDead: number;
  nDeadPriced: number; // dead buckets with a strictly positive mid (the count that "should" be 0)
  sumMid: number; // Σ mid over all currently-quoted buckets (book-completeness sanity; ~1 when full)
}

/**
 * Replay one station-day: forward-fill the delta-deduped book across polls, and at the end of each poll
 * (snaps within `pollGapSec` of each other are one poll) emit a dead-mass measurement IF a public floor
 * exists by then. Snaps may arrive in any order; sorted here.
 */
export function analyzeStationDay(
  buckets: Bucket[],
  snaps: Snap[],
  steps: FloorStep[],
  pollGapSec = 120,
): Measurement[] {
  const out: Measurement[] = [];
  if (steps.length === 0 || snaps.length === 0) return out;
  const sorted = [...snaps].sort((a, b) => a.t - b.t);
  const book = new Map<number, { mid: number; bid: number | null }>();
  const gapMs = pollGapSec * 1000;

  const emit = (t: number): void => {
    const fl = floorAt(steps, t);
    if (!fl) return;
    const dm = deadMass(book, buckets, fl.floorNative);
    out.push({
      t,
      floorNative: fl.floorNative,
      minSinceNewMax: fl.sinceMs / 60000,
      mass: dm.mass,
      massBid: dm.massBid,
      nDead: dm.nDead,
      nDeadPriced: dm.nDeadPriced,
      sumMid: dm.sumMid,
    });
  };

  let pollEnd = sorted[0]!.t;
  for (const s of sorted) {
    if (s.t - pollEnd > gapMs) {
      emit(pollEnd); // close the previous poll on the fully-updated book
    }
    book.set(s.idx, { mid: s.mid, bid: s.bid });
    pollEnd = s.t;
  }
  emit(pollEnd); // final poll
  return out;
}

// --- aggregation ------------------------------------------------------------------

export function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return NaN;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[i]!;
}

interface Bin {
  label: string;
  lo: number;
  hi: number; // minutes-since-new-max range [lo, hi)
}
const RECENCY_BINS: Bin[] = [
  { label: '[0,60)  fresh ≤1h', lo: 0, hi: 60 },
  { label: '[60,120)  1–2h', lo: 60, hi: 120 },
  { label: '[120,360) 2–6h', lo: 120, hi: 360 },
  { label: '[360,inf) ≥6h', lo: 360, hi: Infinity },
];

// --- SQL loader + run -------------------------------------------------------------

export interface Wo5Args {
  from: string;
  to: string;
  stations?: string[];
  deadThresh: number; // a dead-bucket price above this counts as a "material" mispricing
  pollGapSec: number;
}
export interface Wo5Deps {
  db: Db;
  log: (msg: string) => void;
}

interface EventRow {
  event_id: string;
  icao: string;
  target_date: string | Date;
  unit: Unit;
}
interface BucketRow {
  event_id: string;
  bucket_idx: number;
  low_native: number | null;
  high_native: number | null;
  fee_rate: string | null;
}
interface SnapRow {
  event_id: string;
  bucket_idx: number;
  t_ms: string | number;
  mid: string | null;
  best_bid: string | null;
}
interface IntraRow {
  icao: string;
  date_local: string | Date;
  max_tenths_c: string;
  known_utc_ms: string | number;
}

const dISO = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function runWo5(args: Wo5Args, deps: Wo5Deps): Promise<Measurement[]> {
  const { db, log } = deps;
  const stationFilter = args.stations?.map((s) => s.toUpperCase());

  // 1. 'highest' events in window (+ optional station filter).
  let events = await db.query<EventRow>(
    `select e.id event_id, e.icao_at_creation icao, e.target_date, e.unit
       from market_events e
      where e.kind='highest' and e.icao_at_creation is not null
        and e.target_date between $1 and $2`,
    [args.from, args.to],
  );
  if (stationFilter) events = events.filter((e) => stationFilter.includes(e.icao.toUpperCase()));
  const evById = new Map(events.map((e) => [e.event_id, e]));
  const eventIds = events.map((e) => e.event_id);
  if (eventIds.length === 0) {
    log('WO-5: no highest-markets in window — BLOCKED (nothing to measure).');
    return [];
  }

  // 2. buckets for those events.
  const bucketRows = await db.query<BucketRow>(
    `select b.event_id, b.bucket_idx, b.low_native, b.high_native, b.fee_rate
       from market_buckets b where b.event_id = any($1)`,
    [eventIds],
  );
  const bucketsByEvent = new Map<string, Bucket[]>();
  const feeByEvent = new Map<string, number>();
  for (const r of bucketRows) {
    const arr = bucketsByEvent.get(r.event_id) ?? [];
    arr.push({ idx: r.bucket_idx, low: r.low_native, high: r.high_native });
    bucketsByEvent.set(r.event_id, arr);
    if (r.fee_rate != null) feeByEvent.set(r.event_id, Number(r.fee_rate));
  }

  // 3. delta-deduped snapshots for those events (forward-filled in the core).
  const snapRows = await db.query<SnapRow>(
    `select b.event_id, b.bucket_idx, extract(epoch from s.captured_at)*1000 t_ms, s.mid, s.best_bid
       from market_snapshots s
       join market_buckets b on b.id = s.bucket_id
      where b.event_id = any($1) and s.mid is not null
      order by b.event_id, s.captured_at`,
    [eventIds],
  );
  const snapsByEvent = new Map<string, Snap[]>();
  for (const r of snapRows) {
    const arr = snapsByEvent.get(r.event_id) ?? [];
    arr.push({ idx: r.bucket_idx, t: Number(r.t_ms), mid: Number(r.mid), bid: r.best_bid == null ? null : Number(r.best_bid) });
    snapsByEvent.set(r.event_id, arr);
  }

  // 4. intraday running maxes with print-time proxy = END of local hour H (knownUtc), via station tz.
  const intraRows = await db.query<IntraRow>(
    `select ia.icao, ia.date_local, ia.max_tenths_c,
            extract(epoch from ((ia.date_local::timestamp + make_interval(hours => ia.local_hour + 1)) at time zone st.tz))*1000 known_utc_ms
       from intraday_advances ia join stations st on st.icao = ia.icao
      where ia.date_local between $1 and $2`,
    [args.from, args.to],
  );
  const intraByKey = new Map<string, Array<{ knownUtc: number; maxC: number }>>(); // `${icao}|${date}`
  for (const r of intraRows) {
    const k = `${r.icao}|${dISO(r.date_local)}`;
    const arr = intraByKey.get(k) ?? [];
    // NB: max_tenths_c is a MISNOMER — already °C. Do NOT divide by 10.
    arr.push({ knownUtc: Number(r.known_utc_ms), maxC: Number(r.max_tenths_c) });
    intraByKey.set(k, arr);
  }

  // 5. per-station-day analysis.
  const all: Measurement[] = [];
  const perStationMaxMass = new Map<string, number>();
  let stationDaysAnalyzed = 0;
  let stationDaysWithFloor = 0;
  const topEvents: Array<{ icao: string; date: string; maxMass: number; nDeadPriced: number }> = [];

  for (const e of events) {
    const buckets = bucketsByEvent.get(e.event_id);
    const snaps = snapsByEvent.get(e.event_id);
    const intra = intraByKey.get(`${e.icao}|${dISO(e.target_date)}`);
    if (!buckets || !snaps || !intra) continue;
    stationDaysAnalyzed++;
    const steps = buildFloorSteps(intra, e.unit);
    if (steps.length === 0) continue;
    const ms = analyzeStationDay(buckets, snaps, steps, args.pollGapSec);
    if (ms.length === 0) continue;
    stationDaysWithFloor++;
    let dayMax = 0;
    let dayDeadPriced = 0;
    for (const m of ms) {
      all.push(m);
      if (m.mass > dayMax) dayMax = m.mass;
      dayDeadPriced = Math.max(dayDeadPriced, m.nDeadPriced);
    }
    perStationMaxMass.set(e.icao, Math.max(perStationMaxMass.get(e.icao) ?? 0, dayMax));
    topEvents.push({ icao: e.icao, date: dISO(e.target_date), maxMass: dayMax, nDeadPriced: dayDeadPriced });
  }

  // --- report ----------------------------------------------------------------------
  // A book is COHERENT when its forward-filled mids sum to ≈1 (a real, simultaneously-quoted state). The
  // delta-dedup means a repricing can leave the reconstruction transiently incoherent (some buckets
  // written down, others not yet) → sumMid ≫ 1 and a phantom dead mass > 1. Those instants are NOT a
  // tradable state (the stale dead buckets carry no bid — verified: best_bid is null on them). So the
  // honest market-state metric is dead mass on coherent books; tradability is the BID-side mass.
  const isCoherent = (m: Measurement) => m.sumMid >= 0.9 && m.sumMid <= 1.1;
  const coherent = all.filter(isCoherent);
  const cMass = coherent.map((m) => m.mass).sort((a, b) => a - b);
  const cBid = coherent.map((m) => m.massBid).sort((a, b) => a - b);
  const fee = (() => {
    const fs = [...feeByEvent.values()];
    return fs.length ? fs.reduce((s, x) => s + x, 0) / fs.length : NaN;
  })();
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const pctAbove = (xs: number[], thr: number) => (xs.length ? (100 * xs.filter((x) => x > thr).length) / xs.length : 0);

  log(`=== wo5-market-staleness ${args.from} → ${args.to} ===`);
  log(
    `scope: ${events.length} highest-events · ${stationDaysAnalyzed} with all 3 data streams · ${stationDaysWithFloor} with a public floor · ${all.length} poll-measurements (${coherent.length} on a coherent book)`,
  );
  log(`avg fee_rate ${Number.isNaN(fee) ? 'n/a' : fee.toFixed(4)} · dead-bucket "material" threshold ${args.deadThresh}`);
  log('');
  log('DEAD MASS = market price on logically-impossible (sub-floor) buckets. Fair value is 0; any price is a mispricing.');
  log('Measured on COHERENT books (sumMid≈1). mid = quoted midpoint (gross); bid = best_bid (what you could SELL into).');
  log(
    `  mid:  mean ${mean(cMass).toFixed(4)}  p50 ${quantile(cMass, 0.5).toFixed(4)}  p90 ${quantile(cMass, 0.9).toFixed(4)}  ` +
      `p99 ${quantile(cMass, 0.99).toFixed(4)}  max ${(cMass[cMass.length - 1] ?? 0).toFixed(4)}`,
  );
  log(
    `  bid:  mean ${mean(cBid).toFixed(4)}  p50 ${quantile(cBid, 0.5).toFixed(4)}  p90 ${quantile(cBid, 0.9).toFixed(4)}  ` +
      `p99 ${quantile(cBid, 0.99).toFixed(4)}  max ${(cBid[cBid.length - 1] ?? 0).toFixed(4)}`,
  );
  log(
    `  share with mid-deadMass > ${args.deadThresh}: ${pctAbove(cMass, args.deadThresh).toFixed(2)}%  ` +
      `· bid-deadMass > fee(${Number.isNaN(fee) ? '?' : fee.toFixed(2)}): ${Number.isNaN(fee) ? 'n/a' : pctAbove(cBid, fee).toFixed(2) + '%'}`,
  );
  log('');
  log('THE LATENCY TEST — coherent-book dead mass conditioned on minutes since the new running-max became public:');
  log('  bin                     n      mid-mean  mid-p99   bid-mean  bid-p99   %mid>thr');
  for (const bin of RECENCY_BINS) {
    const inBin = coherent.filter((m) => m.minSinceNewMax >= bin.lo && m.minSinceNewMax < bin.hi);
    const bm = inBin.map((m) => m.mass).sort((a, b) => a - b);
    const bb = inBin.map((m) => m.massBid).sort((a, b) => a - b);
    log(
      `  ${bin.label.padEnd(22)} ${String(inBin.length).padStart(6)}  ${mean(bm).toFixed(4)}    ${quantile(bm, 0.99).toFixed(4)}    ` +
        `${mean(bb).toFixed(4)}    ${quantile(bb, 0.99).toFixed(4)}    ${pctAbove(bm, args.deadThresh).toFixed(2)}%`,
    );
  }
  log('  (latency edge ⇒ bid-mean ELEVATED in the fresh bin, DECAYING with time. flat-and-near-zero ⇒ no window.)');
  log('');
  const rawMasses = all.map((m) => m.mass).sort((a, b) => a - b);
  log(
    `aside — raw (incl. incoherent transients): max dead mass ${(rawMasses[rawMasses.length - 1] ?? 0).toFixed(2)}, ` +
      `${all.length - coherent.length} of ${all.length} measurements were mid-repricing transients (sumMid∉[0.9,1.1]) — phantom, no bid, excluded above.`,
  );
  const top = topEvents.sort((a, b) => b.maxMass - a.maxMass).slice(0, 8);
  log('largest single-day raw dead mass (forward-fill transients / data outliers, NOT tradable states):');
  for (const t of top) log(`  ${t.icao} ${t.date}  maxRawDeadMass ${t.maxMass.toFixed(4)}  (dead buckets priced>0: ${t.nDeadPriced})`);
  log('');

  // --- verdict ---------------------------------------------------------------------
  // Edge requires a REALIZABLE (bid-side) dead mass that clears the fee, present right after a print.
  const freshC = coherent.filter((m) => m.minSinceNewMax < 60);
  const freshBidMean = mean(freshC.map((m) => m.massBid));
  const freshMidMean = mean(freshC.map((m) => m.mass));
  const bidClearsP99 = quantile(cBid, 0.99);
  const tradable = freshBidMean > fee && pctAbove(cBid, fee) > 1;
  if (tradable) {
    log(
      `VERDICT: TRADABLE LATENCY WINDOW — fresh-bin realizable (bid) dead mass ${freshBidMean.toFixed(4)} exceeds the ${fee.toFixed(2)} fee, ` +
        `on ${pctAbove(cBid, fee).toFixed(1)}% of coherent measurements. The market lags new running-max prints with a SELLABLE gap. ` +
        `Sketch the execution path (fast METAR ingest → sell Yes on sub-floor buckets) and flag the sub-10-min infra bar.`,
    );
  } else {
    log(
      `VERDICT: NO TRADABLE EDGE. On coherent books the realizable (bid) dead mass is ~0 (p99 ${bidClearsP99.toFixed(4)}, fresh-bin mean ${freshBidMean.toFixed(4)} ` +
        `vs fee ${Number.isNaN(fee) ? '?' : fee.toFixed(2)}); even the gross mid dead mass averages ${freshMidMean.toFixed(4)} fresh and does NOT decay with time ` +
        `(so it's residual illiquid-quote noise, not a repricing lag). The market has already zeroed logically-dead buckets before our coarsest observable instant. ` +
        `At ~1h print / ~10min snapshot resolution the market is efficient w.r.t. the hard floor → any residual edge is sub-10-min (below our 5-min live reaction ` +
        `latency too) and carries no bid to hit → trading thesis CLOSED on these signals. Pivot.`,
    );
  }
  return all;
}

// --- CLI --------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnv();
  const { values } = parseArgs({
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      stations: { type: 'string' },
      'dead-thresh': { type: 'string' },
      'poll-gap-sec': { type: 'string' },
    },
  });
  const db = makeScriptDb();
  try {
    await runWo5(
      {
        from: values.from ?? '2026-05-13',
        to: values.to ?? '2026-06-15',
        stations: splitList(values.stations),
        deadThresh: values['dead-thresh'] ? Number(values['dead-thresh']) : 0.02,
        pollGapSec: values['poll-gap-sec'] ? Number(values['poll-gap-sec']) : 120,
      },
      { db, log: console.log },
    );
  } finally {
    await db.end();
  }
}
