/**
 * scripts/research/opening-resolution-score — the HOLD-TO-RESOLUTION realized-P&L scorer for the
 * opening-convergence capture panel (the companion to opening-spike.ts).
 *
 * WHY THIS EXISTS. opening-spike.ts asks "is the forecast signal AVAILABLE cheap while the book is still
 * flat-open?" — a t≈0 availability test. The 2026-06-28 first-full-universe run answered that question's
 * premise NO: markets do NOT open flat (11-bucket books peak ~0.33 at first sight, not ~0.09), and the
 * intraday "buy our center cheap, sell into convergence" round-trip runs NEGATIVE (the market marks our
 * forecast-center DOWN ~77% of the time over the first few hours — adverse selection, the project's
 * recurring wall). See FINDINGS / the 2026-06-28 memory entry.
 *
 * BUT intraday mark-to-market and HOLD-TO-RESOLUTION are DIFFERENT BETS. The convergence thesis is a
 * short-hold trade that needs the price to re-rate UP within hours; a buy-and-hold-to-resolution trade does
 * not care about the intraday drift AT ALL — its only question is whether
 *
 *        P(our forecast-center bucket actually WINS at resolution)  >  the price we paid for it.
 *
 * That is the pure forecasting-edge question, net of all microstructure noise. This script measures it on
 * the SAME captured panel, SWEEPING the entry age (0–15m … 16–48h) so we can see WHETHER there is any entry
 * window where our center is mispriced cheap relative to its true resolution frequency — i.e. "widen the
 * buying-time and check for patterns". It joins each event's chosen entry snapshot to the realized winner
 * (`market_events.poly_resolved_winner_idx`, with `winning_bucket_idx` = our truth-graded fallback) and
 * reports, per entry-age bin: center hit-rate, avg entry ask, the raw calibration edge (hitRate − price),
 * the per-$ ROI with a 95% interval, and a MARKET-FAVORITE baseline (the max-mid bucket) so we can see
 * whether OUR forecast adds anything over naively buying the market's own favorite.
 *
 * VERDICT (per bin + best bin): GO iff the ROI 95%-CI lower bound > 0 over ≥ MIN_RESOLVED resolved markets;
 * NO-GO if the CI upper bound < 0 (a real, measured loss); else INSUFFICIENT_DATA (too few resolved, or the
 * CI straddles 0). NOTE the CI is the naive iid normal interval — at this scale the markets are CLUSTERED by
 * target_date, so the TRUE interval is wider; a GO here is necessary-not-sufficient and still defers to the
 * §9R-E openingVerdict cluster-bootstrap capital gate. This script decides nothing about capital; it tells us
 * whether the hold-to-resolution path is even worth modelling further.
 *
 * Read-only, KEYLESS. Reads opening_captures ⋈ market_events via the service-role script-db client. Places
 * NOTHING, writes NOTHING, never imports packages/trading. Resolved rows only appear after the markets settle
 * (~station-local midnight of target_date + grading), so BEFORE then this prints INSUFFICIENT_DATA by design.
 * Run:  pnpm tsx scripts/research/opening-resolution-score.ts [--days N] [--fee-bps B]
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { ScriptDb } from '../lib/script-db.ts';

export const SCRIPT = 'opening-resolution-score';

// The §9R-E spirit: a meaningful realized-edge read needs a real panel of settled markets. Below this we
// only ever say INSUFFICIENT — never GO, never NO-GO — because one or two weather-days of resolved markets
// is all one climatic draw. (The capital gate's bar is ≥40 with a cluster-bootstrap CI; we mirror the count.)
export const MIN_RESOLVED = 40;

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// formatting
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(3) : '—');
const fin = (v: unknown): v is number => v != null && Number.isFinite(Number(v));
const numOrNull = (v: unknown): number | null => (fin(v) ? Number(v) : null);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// row shape (one chosen entry snapshot per event × entry-age bin, already reduced to the center bucket)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface ScoreRow {
  eventId: string;
  city: string;
  targetDate: string;
  binIdx: number;
  binLabel: string;
  entryAgeH: number | null;
  /** argmax-houseProb bucket idx at this snapshot (our forecast center). */
  centerIdx: number | null;
  execAsk: number | null;
  execBid: number | null;
  depthUsd: number | null;
  evVol24h: number | null;
  /** max-mid bucket idx at this snapshot (the MARKET's own favorite — the baseline). */
  mktFavIdx: number | null;
  mktFavAsk: number | null;
  /** realized winner (venue resolution); winningBucketIdx = our truth-graded fallback. */
  winnerIdx: number | null;
  winningBucketIdx: number | null;
  resolvedAt: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// pure stats
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
/** sample standard deviation (n−1). */
export function sampleStd(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
}
/** naive iid normal 95% CI on the mean (z=1.96). Clustered data → true CI wider; see header. */
export function meanCi95(xs: number[]): { mean: number; low: number; high: number } {
  const m = mean(xs);
  const n = xs.length;
  if (n < 2) return { mean: m, low: NaN, high: NaN };
  const se = sampleStd(xs) / Math.sqrt(n);
  return { mean: m, low: m - 1.96 * se, high: m + 1.96 * se };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// per-bin aggregation
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export type ScoreLabel = 'GO' | 'NO-GO' | 'INSUFFICIENT_DATA';

export interface BinScore {
  binIdx: number;
  binLabel: string;
  nEvents: number;
  nResolved: number;
  nDistinctDates: number;
  /** how often our center bucket actually won at resolution. */
  centerHitRate: number;
  avgEntryAsk: number;
  /** the raw calibration edge: hitRate − avgPrice (>0 ⇒ our center is underpriced before fees). */
  edgePerShare: number;
  /** mean per-$ ROI of buy-and-hold = mean((win − execAsk − fee)/execAsk), with its 95% CI. */
  meanRoi: number;
  roiLow: number;
  roiHigh: number;
  /** the baseline: buy the MARKET's own favorite (max-mid) and hold — does OUR pick beat it? */
  mktHitRate: number;
  mktAvgAsk: number;
  mktEdgePerShare: number;
  label: ScoreLabel;
}

/** Score one entry-age bin's resolved rows. feeBps applies to the $1 notional per share (taker). */
export function scoreBin(binIdx: number, binLabel: string, rows: ScoreRow[], feeBps: number): BinScore {
  const fee = feeBps / 10_000;
  const resolved = rows.filter(
    (r) => fin(r.execAsk) && r.execAsk! > 0 && fin(r.centerIdx) && r.winnerIdx != null,
  );
  const nResolved = resolved.length;
  const nDistinctDates = new Set(resolved.map((r) => r.targetDate).filter(Boolean)).size;

  const wins = resolved.map((r) => (r.centerIdx === r.winnerIdx ? 1 : 0));
  const asks = resolved.map((r) => r.execAsk!);
  const rois = resolved.map((r, i) => (wins[i]! - asks[i]! - fee) / asks[i]!);
  const { mean: meanRoi, low: roiLow, high: roiHigh } = meanCi95(rois);

  // market-favorite baseline (only rows where the fav bucket + its ask are usable)
  const mkt = resolved.filter((r) => fin(r.mktFavIdx) && fin(r.mktFavAsk) && r.mktFavAsk! > 0);
  const mktWins = mkt.map((r) => (r.mktFavIdx === r.winnerIdx ? 1 : 0));
  const mktAsks = mkt.map((r) => r.mktFavAsk!);

  const centerHitRate = mean(wins);
  const avgEntryAsk = mean(asks);
  const mktHitRate = mean(mktWins);
  const mktAvgAsk = mean(mktAsks);

  let label: ScoreLabel = 'INSUFFICIENT_DATA';
  if (nResolved >= MIN_RESOLVED && Number.isFinite(roiLow) && Number.isFinite(roiHigh)) {
    if (roiLow > 0) label = 'GO';
    else if (roiHigh < 0) label = 'NO-GO';
  }

  return {
    binIdx,
    binLabel,
    nEvents: rows.length,
    nResolved,
    nDistinctDates,
    centerHitRate,
    avgEntryAsk,
    edgePerShare: centerHitRate - avgEntryAsk,
    meanRoi,
    roiLow,
    roiHigh,
    mktHitRate,
    mktAvgAsk,
    mktEdgePerShare: mktHitRate - mktAvgAsk,
    label,
  };
}

export interface ScoreResult {
  nRows: number;
  nEvents: number;
  nResolvedEvents: number;
  bins: BinScore[];
  /** the bin with the highest ROI CI lower bound among bins that have ≥ MIN_RESOLVED resolved. */
  bestBin: BinScore | null;
}

export function scoreAll(rows: ScoreRow[], feeBps: number): ScoreResult {
  const byBin = new Map<number, ScoreRow[]>();
  for (const r of rows) {
    const arr = byBin.get(r.binIdx) ?? [];
    arr.push(r);
    byBin.set(r.binIdx, arr);
  }
  const bins = [...byBin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, rs]) => scoreBin(idx, rs[0]!.binLabel, rs, feeBps));

  const eligible = bins.filter((b) => b.nResolved >= MIN_RESOLVED && Number.isFinite(b.roiLow));
  const bestBin = eligible.length
    ? eligible.reduce((best, b) => (b.roiLow > best.roiLow ? b : best))
    : null;

  return {
    nRows: rows.length,
    nEvents: new Set(rows.map((r) => r.eventId)).size,
    nResolvedEvents: new Set(rows.filter((r) => r.winnerIdx != null).map((r) => r.eventId)).size,
    bins,
    bestBin,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// forecast-band (predicted-high ±1°, 3 buckets) entry envelope + resolution
//
// The center-only score above buys ONE bucket (argmax houseProb). But our predicted high carries ±1°
// forecast error, so the realized winner very often lands one bucket either side. This section evaluates
// the 3-bucket BAND [forecastIdx−1 … forecastIdx+1] (forecastIdx = the event's representative argmax-house
// bucket, the most frequent center across its captures = our predicted high). For each event, over the FULL
// capture series, it records the ENTRY ENVELOPE the operator asked to log: the LOWEST and HIGHEST yes-buy
// execAsk seen in the band (cheapest/dearest you could have entered), both as a single bucket and as the
// 3-bucket basket cost; and at resolution whether the truth fell inside the band, with the best-/worst-entry
// basket ROI bracketing the hold-to-resolution outcome.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One band bucket's full-series envelope for an event (min/max execAsk + when), with the event's resolution. */
export interface BandBucketRow {
  eventId: string;
  targetDate: string;
  forecastIdx: number;
  bucketIdx: number;
  minAsk: number;
  maxAsk: number;
  lowAgeH: number | null;
  highAgeH: number | null;
  winnerIdx: number | null;
  resolvedAt: string | null;
}

/** Per-event reduction over its ≤3 band buckets. */
export interface EventBand {
  eventId: string;
  targetDate: string;
  forecastIdx: number;
  nBuckets: number;
  /** cheapest single yes-buy anywhere in the band over the series (the lowest entry point asked for). */
  singleLowAsk: number;
  /** dearest single yes-buy in the band over the series (the highest entry point asked for). */
  singleHighAsk: number;
  /** 3-bucket basket cost if you caught each bucket's series-low ask (best-case entry). */
  basketCostLow: number;
  /** 3-bucket basket cost if you caught each bucket's series-high ask (worst-case entry). */
  basketCostHigh: number;
  winnerIdx: number | null;
  /** truth landed within forecast±1 (null until resolved). */
  bandHit: boolean | null;
  resolved: boolean;
}

export interface BandSummary {
  nEvents: number;
  nResolved: number;
  nDistinctDates: number;
  avgSingleLowAsk: number;
  avgSingleHighAsk: number;
  avgBasketCostLow: number;
  avgBasketCostHigh: number;
  /** P(truth within forecast±1) over resolved events. */
  bandHitRate: number;
  /** mean basket ROI if every bucket entered at its series-low (best case) — resolved only. */
  bestCaseBasketRoi: number;
  /** mean basket ROI if every bucket entered at its series-high (worst case) — resolved only. */
  worstCaseBasketRoi: number;
}

/** Group the per-bucket band rows into one EventBand each. Pure + total. */
export function reduceEventBands(rows: BandBucketRow[]): EventBand[] {
  const byEvent = new Map<string, BandBucketRow[]>();
  for (const r of rows) {
    const arr = byEvent.get(r.eventId) ?? [];
    arr.push(r);
    byEvent.set(r.eventId, arr);
  }
  const out: EventBand[] = [];
  for (const [eventId, bs] of byEvent) {
    const meta = bs[0]!;
    const lows = bs.map((b) => b.minAsk).filter((v) => Number.isFinite(v) && v > 0);
    const highs = bs.map((b) => b.maxAsk).filter((v) => Number.isFinite(v) && v > 0);
    if (!lows.length || !highs.length) continue;
    const winnerIdx = meta.winnerIdx;
    const resolved = winnerIdx != null;
    out.push({
      eventId,
      targetDate: meta.targetDate,
      forecastIdx: meta.forecastIdx,
      nBuckets: bs.length,
      singleLowAsk: Math.min(...lows),
      singleHighAsk: Math.max(...highs),
      basketCostLow: bs.reduce((a, b) => a + (Number.isFinite(b.minAsk) ? b.minAsk : 0), 0),
      basketCostHigh: bs.reduce((a, b) => a + (Number.isFinite(b.maxAsk) ? b.maxAsk : 0), 0),
      winnerIdx,
      bandHit: resolved ? Math.abs(winnerIdx! - meta.forecastIdx) <= 1 : null,
      resolved,
    });
  }
  return out;
}

/** Panel summary of the forecast-band envelope + resolution. Pure + total. */
export function summarizeBand(rows: BandBucketRow[]): BandSummary {
  const events = reduceEventBands(rows);
  const resolved = events.filter((e) => e.resolved);
  const hit = resolved.map((e) => (e.bandHit ? 1 : 0));
  const bestRoi = resolved
    .filter((e) => e.basketCostLow > 0)
    .map((e) => ((e.bandHit ? 1 : 0) - e.basketCostLow) / e.basketCostLow);
  const worstRoi = resolved
    .filter((e) => e.basketCostHigh > 0)
    .map((e) => ((e.bandHit ? 1 : 0) - e.basketCostHigh) / e.basketCostHigh);
  return {
    nEvents: events.length,
    nResolved: resolved.length,
    nDistinctDates: new Set(resolved.map((e) => e.targetDate).filter(Boolean)).size,
    avgSingleLowAsk: mean(events.map((e) => e.singleLowAsk)),
    avgSingleHighAsk: mean(events.map((e) => e.singleHighAsk)),
    avgBasketCostLow: mean(events.map((e) => e.basketCostLow)),
    avgBasketCostHigh: mean(events.map((e) => e.basketCostHigh)),
    bandHitRate: mean(hit),
    bestCaseBasketRoi: mean(bestRoi),
    worstCaseBasketRoi: mean(worstRoi),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function report(res: ScoreResult, band: BandSummary | null, feeBps: number, log: (m: string) => void): void {
  log('=== opening-resolution-score · hold-to-resolution realized edge by entry age ===');
  log(
    `rows ${res.nRows} · events ${res.nEvents} · resolved events ${res.nResolvedEvents} · ` +
      `taker fee ${feeBps}bps · MIN_RESOLVED ${MIN_RESOLVED} (GO/NO-GO bar)`,
  );
  log('');
  log('  the bet scored: BUY our forecast-center bucket at the entry-age snapshot, HOLD to resolution.');
  log('  edge = centerHit − avgAsk (raw, pre-fee); ROI = mean per-$ net incl fee, with iid-95% CI (clustered ⇒');
  log('  true CI WIDER — a GO here still defers to the §9R-E cluster-bootstrap capital gate).');
  log('');
  log(
    `  ${'entryAge'.padEnd(8)}  ${'n'.padStart(4)}  ${'res'.padStart(4)}  ${'dates'.padStart(5)}  ` +
      `${'centerHit'.padStart(9)}  ${'avgAsk'.padStart(7)}  ${'edge'.padStart(7)}  ` +
      `${'ROI'.padStart(7)}  ${'ROI 95% CI'.padStart(18)}  ${'mktHit'.padStart(7)}  ${'mktEdge'.padStart(7)}  verdict`,
  );
  for (const b of res.bins) {
    log(
      `  ${b.binLabel.padEnd(8)}  ${String(b.nEvents).padStart(4)}  ${String(b.nResolved).padStart(4)}  ` +
        `${String(b.nDistinctDates).padStart(5)}  ${pct(b.centerHitRate).padStart(9)}  ${f2(b.avgEntryAsk).padStart(7)}  ` +
        `${(b.edgePerShare >= 0 ? '+' : '') + pct(b.edgePerShare)}`.padStart(7) +
        `  ${(b.meanRoi >= 0 ? '+' : '') + pct(b.meanRoi)}`.padStart(7) +
        `  ${`[${pct(b.roiLow)}, ${pct(b.roiHigh)}]`.padStart(18)}  ${pct(b.mktHitRate).padStart(7)}  ` +
        `${((b.mktEdgePerShare >= 0 ? '+' : '') + pct(b.mktEdgePerShare)).padStart(7)}  ${b.label}`,
    );
  }
  log('');
  if (band) {
    log('=== FORECAST-BAND (predicted high ±1°, 3 buckets) — entry envelope & resolution ===');
    log(
      `  events ${band.nEvents} · resolved ${band.nResolved} · dates ${band.nDistinctDates}  ` +
        '(envelope = over the FULL capture series of each event)',
    );
    log(`  cheapest single yes-buy in band (avg of per-event lows):  ${f2(band.avgSingleLowAsk)}   <- lowest entry point`);
    log(`  dearest  single yes-buy in band (avg of per-event highs): ${f2(band.avgSingleHighAsk)}   <- highest entry point`);
    log(
      `  3-bucket BASKET cost — best-entry (Σ series-lows): ${f2(band.avgBasketCostLow)}   ` +
        `worst-entry (Σ series-highs): ${f2(band.avgBasketCostHigh)}`,
    );
    if (band.nResolved > 0) {
      log(`  band hit rate (truth within ±1°): ${pct(band.bandHitRate)}  over ${band.nResolved} resolved`);
      log(
        `  basket hold-to-resolution ROI — best-case ${pct(band.bestCaseBasketRoi)} · ` +
          `worst-case ${pct(band.worstCaseBasketRoi)}  (bracket; true entry sits between)`,
      );
    } else {
      log('  band hit rate / ROI: — (no resolved markets yet; envelope above is live, resolution stats fill in after settle)');
    }
    log('');
  }
  log('=== VERDICT ===');
  if (res.nResolvedEvents === 0) {
    log(
      '  INSUFFICIENT_DATA — 0 markets in the panel have resolved yet. This scorer is meant to run AFTER the ' +
        'captured markets settle (≈ station-local midnight of their target_date + grading). Re-run then.',
    );
    return;
  }
  if (!res.bestBin) {
    log(
      `  INSUFFICIENT_DATA — no entry-age bin yet has ≥ ${MIN_RESOLVED} resolved markets with a finite CI. ` +
        `${res.nResolvedEvents} resolved event(s) so far; keep the capture cron running and re-run as more settle.`,
    );
    return;
  }
  const b = res.bestBin;
  const head =
    b.label === 'GO'
      ? `GO — best entry window "${b.binLabel}": hold-to-resolution ROI ${pct(b.meanRoi)} ` +
        `(95% CI [${pct(b.roiLow)}, ${pct(b.roiHigh)}], lower bound > 0) over ${b.nResolved} resolved markets ` +
        `across ${b.nDistinctDates} dates. Our center won ${pct(b.centerHitRate)} vs ${f2(b.avgEntryAsk)} paid ` +
        `(edge ${pct(b.edgePerShare)}); market-favorite baseline edge ${pct(b.mktEdgePerShare)}. ` +
        'The hold-to-resolution path carries measured edge — model it further (still gated by §9R-E for capital).'
      : b.label === 'NO-GO'
        ? `NO-GO — best entry window "${b.binLabel}" still has ROI CI upper bound < 0 (${pct(b.roiHigh)}) over ` +
          `${b.nResolved} resolved markets: buying our center and holding LOSES at every entry age. Our center won ` +
          `${pct(b.centerHitRate)} vs ${f2(b.avgEntryAsk)} paid (edge ${pct(b.edgePerShare)}). The hold path is dead too; ` +
          'fold opening-convergence into the falsified column. The other eleven signals stay dead — this makes twelve.'
        : `INSUFFICIENT_DATA — best bin "${b.binLabel}" ROI ${pct(b.meanRoi)} but its 95% CI ` +
          `[${pct(b.roiLow)}, ${pct(b.roiHigh)}] straddles 0 over ${b.nResolved} resolved markets. No call yet; ` +
          'let more markets settle and re-run.';
  log(`  ${head}`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DB I/O (read-only)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One chosen entry snapshot per (event × entry-age bin), reduced in-SQL to the center bucket (argmax
 * houseProb) + the market-favorite bucket (max mid), joined to the event's resolution. The bin's snapshot
 * is the capture whose hours_since_listing is closest to the bin centre. Only events that were a FRESH
 * listing in the window (min hours_since_listing < 1) are scored, matching the capture/spike universe.
 */
export async function loadRows(db: ScriptDb, days: number): Promise<ScoreRow[]> {
  const sql = `
    with bins(bin_idx, lo, hi, ctr, label) as (
      values (0, 0.0::numeric, 0.25::numeric, 0.12::numeric, '0-15m'),
             (1, 0.25, 0.5, 0.37, '15-30m'),
             (2, 0.5, 1.0, 0.75, '30-60m'),
             (3, 1.0, 2.0, 1.5, '1-2h'),
             (4, 2.0, 4.0, 3.0, '2-4h'),
             (5, 4.0, 8.0, 6.0, '4-8h'),
             (6, 8.0, 16.0, 12.0, '8-16h'),
             (7, 16.0, 48.0, 24.0, '16-48h')
    ),
    fresh as (
      select event_id from public.opening_captures
      where captured_at > now() - ($1 || ' days')::interval and event_id is not null
      group by event_id having min(hours_since_listing) < 1
    ),
    exploded as (
      select oc.id, oc.event_id, oc.city, oc.target_date, oc.hours_since_listing, oc.ev_vol24h,
             (b->>'idx')::int as idx,
             (b->>'houseProb')::numeric as house_prob,
             (b->>'mid')::numeric as mid,
             (b->>'execAsk')::numeric as exec_ask,
             (b->>'execBid')::numeric as exec_bid,
             (b->>'depthUsd')::numeric as depth_usd,
             row_number() over (partition by oc.id order by (b->>'houseProb')::numeric desc nulls last) as rk_house,
             row_number() over (partition by oc.id order by (b->>'mid')::numeric desc nulls last) as rk_mid
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      cross join lateral jsonb_array_elements(oc.buckets) as arr(b)
      where oc.captured_at > now() - ($1 || ' days')::interval and oc.buckets is not null
    ),
    perCap as (
      select e.id, e.event_id, e.city, e.target_date, e.hours_since_listing, e.ev_vol24h,
             max(e.idx)      filter (where e.rk_house = 1) as center_idx,
             max(e.exec_ask) filter (where e.rk_house = 1) as exec_ask,
             max(e.exec_bid) filter (where e.rk_house = 1) as exec_bid,
             max(e.depth_usd)filter (where e.rk_house = 1) as depth_usd,
             max(e.idx)      filter (where e.rk_mid = 1)   as mkt_fav_idx,
             max(e.exec_ask) filter (where e.rk_mid = 1)   as mkt_fav_ask
      from exploded e
      group by e.id, e.event_id, e.city, e.target_date, e.hours_since_listing, e.ev_vol24h
    ),
    binned as (
      select c.*, bn.bin_idx, bn.label as bin_label, bn.ctr,
             row_number() over (partition by c.event_id, bn.bin_idx
                                order by abs(c.hours_since_listing - bn.ctr)) as rn
      from perCap c
      join bins bn on c.hours_since_listing >= bn.lo and c.hours_since_listing < bn.hi
    )
    select b.event_id, b.city, b.target_date, b.bin_idx, b.bin_label,
           round(b.hours_since_listing, 3)::float8 as entry_age_h,
           b.center_idx, b.exec_ask::float8, b.exec_bid::float8, b.depth_usd::float8, b.ev_vol24h::float8,
           b.mkt_fav_idx, b.mkt_fav_ask::float8,
           me.poly_resolved_winner_idx, me.winning_bucket_idx, me.resolved_at
    from binned b
    join public.market_events me on me.id = b.event_id
    where b.rn = 1
    order by b.event_id, b.bin_idx;
  `;
  const out = await db.query<Record<string, unknown>>(sql, [Math.max(1, Math.floor(days))]);
  return out.map((r) => ({
    eventId: String(r['event_id']),
    city: String(r['city'] ?? ''),
    targetDate: String(r['target_date'] ?? ''),
    binIdx: Number(r['bin_idx']),
    binLabel: String(r['bin_label']),
    entryAgeH: numOrNull(r['entry_age_h']),
    centerIdx: numOrNull(r['center_idx']),
    execAsk: numOrNull(r['exec_ask']),
    execBid: numOrNull(r['exec_bid']),
    depthUsd: numOrNull(r['depth_usd']),
    evVol24h: numOrNull(r['ev_vol24h']),
    mktFavIdx: numOrNull(r['mkt_fav_idx']),
    mktFavAsk: numOrNull(r['mkt_fav_ask']),
    winnerIdx: numOrNull(r['poly_resolved_winner_idx']) ?? numOrNull(r['winning_bucket_idx']),
    winningBucketIdx: numOrNull(r['winning_bucket_idx']),
    resolvedAt: r['resolved_at'] == null ? null : String(r['resolved_at']),
  }));
}

/**
 * Per-event forecast-band envelope: for each event, the min/max execAsk (over the full series) of every
 * bucket within ±1 of the event's representative argmax-house bucket (forecastIdx = the mode of each
 * capture's argmax-houseProb idx — our predicted-high bucket), joined to the event's resolution.
 */
export async function loadBandEnvelope(db: ScriptDb, days: number): Promise<BandBucketRow[]> {
  const sql = `
    with fresh as (
      select event_id from public.opening_captures
      where captured_at > now() - ($1 || ' days')::interval and event_id is not null
      group by event_id having min(hours_since_listing) < 1
    ),
    exploded as (
      select oc.id, oc.event_id, oc.target_date, oc.hours_since_listing,
             (arr.b->>'idx')::int as idx,
             (arr.b->>'houseProb')::numeric as house_prob,
             (arr.b->>'execAsk')::numeric as exec_ask
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      cross join lateral jsonb_array_elements(oc.buckets) as arr(b)
      where oc.captured_at > now() - ($1 || ' days')::interval and oc.buckets is not null
    ),
    capmode as (   -- the argmax-houseProb bucket idx for each capture
      select id, event_id, (array_agg(idx order by house_prob desc nulls last))[1] as mode_idx
      from exploded where house_prob is not null group by id, event_id
    ),
    eventmode as ( -- the event's representative predicted-high bucket = most frequent capture mode
      select event_id, mode() within group (order by mode_idx) as forecast_idx
      from capmode group by event_id
    ),
    band as (      -- every band-bucket observation across the series (±1 of forecast_idx, a real buyable ask)
      select e.event_id, em.forecast_idx, e.idx, e.exec_ask, e.hours_since_listing
      from exploded e
      join eventmode em on em.event_id = e.event_id
      where e.idx between em.forecast_idx - 1 and em.forecast_idx + 1
        and e.exec_ask is not null and e.exec_ask > 0
    )
    select b.event_id, me.target_date, b.forecast_idx, b.idx as bucket_idx,
           min(b.exec_ask)::float8 as min_ask, max(b.exec_ask)::float8 as max_ask,
           (array_agg(b.hours_since_listing order by b.exec_ask asc))[1]::float8  as low_age,
           (array_agg(b.hours_since_listing order by b.exec_ask desc))[1]::float8 as high_age,
           me.poly_resolved_winner_idx, me.winning_bucket_idx, me.resolved_at
    from band b
    join public.market_events me on me.id = b.event_id
    group by b.event_id, me.target_date, b.forecast_idx, b.idx,
             me.poly_resolved_winner_idx, me.winning_bucket_idx, me.resolved_at
    order by b.event_id, b.idx;
  `;
  const out = await db.query<Record<string, unknown>>(sql, [Math.max(1, Math.floor(days))]);
  return out.map((r) => ({
    eventId: String(r['event_id']),
    targetDate: String(r['target_date'] ?? ''),
    forecastIdx: Number(r['forecast_idx']),
    bucketIdx: Number(r['bucket_idx']),
    minAsk: Number(r['min_ask']),
    maxAsk: Number(r['max_ask']),
    lowAgeH: numOrNull(r['low_age']),
    highAgeH: numOrNull(r['high_age']),
    winnerIdx: numOrNull(r['poly_resolved_winner_idx']) ?? numOrNull(r['winning_bucket_idx']),
    resolvedAt: r['resolved_at'] == null ? null : String(r['resolved_at']),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// self-test (runs on CLI invocation, no DB/network — mirrors the other research spines)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
function sanity(): void {
  const row = (over: Partial<ScoreRow>): ScoreRow => ({
    eventId: 'E', city: 'x', targetDate: '2026-06-29', binIdx: 3, binLabel: '1-2h', entryAgeH: 1.5,
    centerIdx: 5, execAsk: 0.3, execBid: 0.25, depthUsd: 100, evVol24h: 5000,
    mktFavIdx: 5, mktFavAsk: 0.3, winnerIdx: null, winningBucketIdx: null, resolvedAt: null, ...over,
  });

  // unresolved rows ⇒ INSUFFICIENT, no NaN crash
  const s0 = scoreAll([row({}), row({ eventId: 'F' })], 0);
  if (s0.nResolvedEvents !== 0 || s0.bestBin !== null) throw new Error('sanity: unresolved should yield no bestBin');

  // a clearly-winning panel: center wins 70% at price 0.30 ⇒ edge +0.40, ROI strongly +, CI low > 0 ⇒ GO
  const win = Array.from({ length: 60 }, (_, i) =>
    row({ eventId: `W${i}`, targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5, winnerIdx: i % 10 < 7 ? 5 : 1, winningBucketIdx: i % 10 < 7 ? 5 : 1, resolvedAt: 'r' }),
  );
  const gs = scoreAll(win, 0).bins.find((b) => b.binIdx === 3)!;
  if (gs.label !== 'GO') throw new Error(`sanity: winning panel should GO, got ${gs.label} roiLow=${gs.roiLow}`);
  if (Math.abs(gs.centerHitRate - 0.7) > 1e-9) throw new Error(`sanity: hitRate ${gs.centerHitRate} != 0.7`);

  // a clearly-losing panel: center wins 5% at price 0.30 ⇒ ROI strongly negative, CI high < 0 ⇒ NO-GO
  const lose = Array.from({ length: 60 }, (_, i) =>
    row({ eventId: `L${i}`, targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5, winnerIdx: i % 20 === 0 ? 5 : 2, winningBucketIdx: i % 20 === 0 ? 5 : 2, resolvedAt: 'r' }),
  );
  const ls = scoreAll(lose, 0).bins.find((b) => b.binIdx === 3)!;
  if (ls.label !== 'NO-GO') throw new Error(`sanity: losing panel should NO-GO, got ${ls.label} roiHigh=${ls.roiHigh}`);

  // a fair panel (center wins exactly at its price, 30% @ 0.30) ⇒ ROI ≈ 0, CI straddles ⇒ INSUFFICIENT
  const fair = Array.from({ length: 60 }, (_, i) =>
    row({ eventId: `Fa${i}`, targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5, winnerIdx: i % 10 < 3 ? 5 : 9, winningBucketIdx: i % 10 < 3 ? 5 : 9, resolvedAt: 'r' }),
  );
  const fs = scoreAll(fair, 0).bins.find((b) => b.binIdx === 3)!;
  if (fs.label !== 'INSUFFICIENT_DATA') throw new Error(`sanity: fair panel should be INSUFFICIENT, got ${fs.label}`);

  // below MIN_RESOLVED ⇒ never GO/NO-GO even if lopsided
  const few = Array.from({ length: 10 }, (_, i) => row({ eventId: `Few${i}`, winnerIdx: 5, winningBucketIdx: 5, resolvedAt: 'r' }));
  if (scoreAll(few, 0).bins[0]!.label !== 'INSUFFICIENT_DATA') throw new Error('sanity: <MIN_RESOLVED should be INSUFFICIENT');

  // stats helpers
  if (Math.abs(mean([1, 2, 3]) - 2) > 1e-9) throw new Error('sanity: mean');
  if (Math.abs(sampleStd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) > 1e-3) throw new Error('sanity: sampleStd');

  // forecast-band envelope: forecastIdx 5, band {4,5,6}. Two events: one resolved-hit (winner 6 ∈ band),
  // one resolved-miss (winner 9 ∉ band). Envelope lows/highs + basket costs + band hit rate.
  const bb = (over: Partial<BandBucketRow>): BandBucketRow => ({
    eventId: 'B1', targetDate: '2026-06-29', forecastIdx: 5, bucketIdx: 5,
    minAsk: 0.2, maxAsk: 0.4, lowAgeH: 2, highAgeH: 0.1, winnerIdx: 6, resolvedAt: 'r', ...over,
  });
  const bandRows: BandBucketRow[] = [
    bb({ eventId: 'B1', bucketIdx: 4, minAsk: 0.10, maxAsk: 0.30, winnerIdx: 6 }),
    bb({ eventId: 'B1', bucketIdx: 5, minAsk: 0.20, maxAsk: 0.40, winnerIdx: 6 }),
    bb({ eventId: 'B1', bucketIdx: 6, minAsk: 0.15, maxAsk: 0.35, winnerIdx: 6 }),
    bb({ eventId: 'B2', targetDate: '2026-06-30', bucketIdx: 4, minAsk: 0.12, maxAsk: 0.32, winnerIdx: 9 }),
    bb({ eventId: 'B2', targetDate: '2026-06-30', bucketIdx: 5, minAsk: 0.22, maxAsk: 0.42, winnerIdx: 9 }),
    bb({ eventId: 'B2', targetDate: '2026-06-30', bucketIdx: 6, minAsk: 0.18, maxAsk: 0.38, winnerIdx: 9 }),
  ];
  const evb = reduceEventBands(bandRows);
  const b1 = evb.find((e) => e.eventId === 'B1')!;
  if (b1.singleLowAsk !== 0.10 || b1.singleHighAsk !== 0.40) throw new Error(`sanity: band B1 envelope ${b1.singleLowAsk}/${b1.singleHighAsk}`);
  if (Math.abs(b1.basketCostLow - 0.45) > 1e-9) throw new Error(`sanity: band B1 basketLow ${b1.basketCostLow} != 0.45`);
  if (b1.bandHit !== true) throw new Error('sanity: B1 winner 6 should be in band');
  const bs = summarizeBand(bandRows);
  if (bs.nEvents !== 2 || bs.nResolved !== 2) throw new Error('sanity: band nEvents/nResolved');
  if (Math.abs(bs.bandHitRate - 0.5) > 1e-9) throw new Error(`sanity: bandHitRate ${bs.bandHitRate} != 0.5`);
  // best-case ROI: B1 (hit) (1−0.45)/0.45=+1.222 ; B2 (miss) (0−0.52)/0.52=−1.0 ; mean ≈ +0.111
  if (Math.abs(bs.bestCaseBasketRoi - 0.1111) > 1e-3) throw new Error(`sanity: bestCaseBasketRoi ${bs.bestCaseBasketRoi}`);
  if (summarizeBand([]).nEvents !== 0) throw new Error('sanity: empty band');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({ options: { days: { type: 'string' }, 'fee-bps': { type: 'string' } } });
  const days = Math.max(1, Math.floor(Number(values.days ?? 14) || 14));
  const feeBps = Math.max(0, Number(values['fee-bps'] ?? 0) || 0);
  const db = makeScriptDb();
  try {
    process.stderr.write(
      `${SCRIPT} · ${new Date().toISOString()} · reading opening_captures ⋈ market_events over ${days}d — read-only\n`,
    );
    const rows = await loadRows(db, days);
    const bandRows = await loadBandEnvelope(db, days);
    process.stderr.write(`  ${rows.length} entry snapshots (events × age-bin) · ${bandRows.length} band-bucket envelopes\n`);
    const res = scoreAll(rows, feeBps);
    const band = summarizeBand(bandRows);
    report(res, band, feeBps, console.log);
  } finally {
    await db.end();
  }
}
