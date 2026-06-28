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
 * buying-time and check for patterns". RESOLUTION RULER: it scores against the VENUE winner
 * (`market_events.poly_resolved_winner_idx`, what actually pays) where the venue has settled, falling back to
 * OUR truth grade (`winning_bucket_idx` = the realized station Tmax through our ladder) when the venue backfill
 * hasn't run yet — the two agree EXCEPT on the `grading_mismatch` population, which is EXCLUDED from scoring
 * (ambiguous payout) and reported. The report prints the venue-vs-grade split so a "venue P&L" read is never
 * silently a forecast-skill proxy. It reports, per entry-age bin: center hit-rate, avg entry ask, the raw calibration edge (hitRate − price),
 * the per-$ ROI with a 95% interval, and a MARKET-FAVORITE baseline (the max-mid bucket) so we can see
 * whether OUR forecast adds anything over naively buying the market's own favorite.
 *
 * An entry is COUNTED only if it is actually fillable: a positive executable ask AND +10%-band depth ≥ --min-depth
 * (default $50 — the capacity-wall floor; a $-thin top-of-book is not a position). It does NOT apply the bot's
 * flat-open price cap — this scores the hold-to-resolution variant (buy the center at whatever it costs, hold),
 * a distinct strategy from the falsified taker-convergence one.
 *
 * VERDICT. The per-bin table shows each bin's NOMINAL (z=1.96, unadjusted) GO/NO-GO — informational only. Any
 * GO/NO-GO (per-bin or headline) requires the independence floors — ≥MIN_RESOLVED(40) resolved AND ≥MIN_DATES(7)
 * distinct target_dates AND ≥MIN_CITIES(6) distinct cities — mirroring opening-spike's MIN_SPIKE_DAYS and §9R-E's
 * co-equal GATE_MIN_DISTINCT_DAYS/GATE_MIN_CITIES, so neither a GO nor a terminal NO-GO can fire on one climatic
 * draw. The HEADLINE additionally corrects for the bin sweep being an 8-window fishing screen: picking the best of
 * k eligible bins at nominal 5% inflates the family-wise false-GO rate, so it pays a Šidák penalty — GO iff the
 * SELECTED bin's ROI lower bound at the Šidák-adjusted z (over k eligible bins) is still > 0. A terminal NO-GO is
 * the EXPENSIVE error, so the kill side is held to at least the GO side's rigor: every eligible bin's Šidák-WIDENED
 * UPPER bound < 0 (not the looser nominal interval) AND ≥ MIN_NOGO_BINS(3) eligible bins; else INSUFFICIENT_DATA.
 * Even so the bins are age-snapshots of the same events (win component correlated across age), so a NO-GO is a
 * strong SCREEN-NEGATIVE, not a unilateral falsification — the signal-#12 kill call is the operator's + the §9R-E
 * cluster gate's. Both intervals are still the naive iid normal — within a weather-day outcomes are spatially
 * correlated, so the TRUE interval is wider again; a GO is necessary-not-sufficient and defers to the §9R-E
 * openingVerdict cluster-bootstrap capital gate. This script decides nothing about capital; it says whether the
 * hold-to-resolution path is worth modelling further.
 *
 * Read-only, KEYLESS. Reads opening_captures ⋈ market_events via the service-role script-db client. Places
 * NOTHING, writes NOTHING, never imports packages/trading. Resolved rows only appear after the markets settle
 * (~station-local midnight of target_date + grading), so BEFORE then this prints INSUFFICIENT_DATA by design.
 * Run:  pnpm tsx scripts/research/opening-resolution-score.ts [--days N] [--fee-rate R] [--min-depth USD]
 *   --fee-rate is a FRACTION (e.g. 0.05) feeding the canonical takerFeePerShare = rate·p·(1−p); default 0 (gross).
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { takerFeePerShare } from '../../packages/core/src/fees.ts';
import { makeScriptDb } from '../lib/script-db.ts';
import { loadEnv } from '../lib/load-env.ts';
import type { ScriptDb } from '../lib/script-db.ts';

export const SCRIPT = 'opening-resolution-score';

// The §9R-E spirit: a meaningful realized-edge read needs a real panel of settled markets across MANY
// independent weather-days. A raw market count is NOT enough — at 45 cities a single daily batch lists ~45
// markets for ONE target_date, so 40 resolved markets can be one spatially-correlated climatic draw (the
// forecast model shares structure across stations), which the iid CI would treat as 40 independent samples
// and badly under-cover. So the GO/NO-GO label requires ALL THREE floors below, mirroring the two hardened
// sibling gates: opening-spike's nDistinctTargetDates ≥ MIN_SPIKE_DAYS(7) and core §9R-E's co-equal
// GATE_MIN_DISTINCT_DAYS(7) / GATE_MIN_CITIES(6). Below any floor we only ever say INSUFFICIENT — never GO,
// never (terminally) NO-GO — because a single bad weather-day must not KILL the one reactivated lever.
export const MIN_RESOLVED = 40; // distinct resolved markets
export const MIN_DATES = 7; // distinct target_dates = independent weather-days (mirrors MIN_SPIKE_DAYS)
export const MIN_CITIES = 6; // distinct cities (mirrors §9R-E GATE_MIN_CITIES)
// A TERMINAL NO-GO (the lever-killing verdict) must cover a real fraction of the entry-age sweep, not one lone
// bin: "every eligible bin negative" is trivially true at k=1, which would generalize a single window's loss to
// "loses at every entry age / falsified". Require ≥ this many eligible bins before a terminal NO-GO; else
// INSUFFICIENT (the other windows are unmeasured, not measured-losing). GO is unaffected (it needs one good bin).
export const MIN_NOGO_BINS = 3;
// A tradable GO/NO-GO is a VENUE-P&L claim, so it requires real VENUE resolution (poly_resolved_winner_idx),
// not just our truth-grade. In routine operation only the manual market-history backfill writes the venue winner
// (the cron grader writes winning_bucket_idx = our station-Tmax grade), so without it the panel is graded on OUR
// basis while priced at the VENUE ask — the dual-source/1°F wedge the cross-venue signal already died on. Below
// this many venue-resolved markets the headline is INSUFFICIENT (forecast-skill diagnostic only), never GO/NO-GO.
export const MIN_VENUE_RESOLVED = MIN_RESOLVED;
// Executable-depth floor (USD) on a scored entry: the capacity-wall discipline (migration 0064 — gate WINS on
// TRUE both-book depth, never the vol proxy). A $-thin top-of-book ask is NOT a fillable position, so an entry
// counts only if its +10%-band depth-walk clears this. Matches the bot's depthFloorUsd; overridable via --min-depth.
export const DEFAULT_MIN_DEPTH_USD = 50;

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
  /** the VENUE-resolved winner (poly_resolved_winner_idx) — what actually PAYS. Null until the venue settles
   *  (only the manual market-history backfill writes it; the routine grader writes winningBucketIdx instead). */
  polyWinnerIdx: number | null;
  /** OUR truth-graded winner (winning_bucket_idx = the realized station Tmax through our ladder). A legitimate
   *  realized-outcome ruler that equals the venue EXCEPT on the grading_mismatch population. */
  winningBucketIdx: number | null;
  /** the effective ruler used for scoring = polyWinnerIdx ?? winningBucketIdx (venue where settled, else truth). */
  winnerIdx: number | null;
  /** our grader flagged venue↔truth disagreement for this market — excluded from scoring (ambiguous payout). */
  gradingMismatch: boolean;
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

/**
 * Acklam's rational-approximation inverse normal CDF (probit). |abs error| < 1.15e-9 over 0<p<1; NaN outside.
 * Used to turn a multiplicity-adjusted tail probability into a z multiplier for the headline GO test.
 */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/**
 * The two-sided z multiplier for a Šidák family-wise-error correction across k correlated comparisons at
 * family-wise α=fwer. Per-comparison α' = 1−(1−fwer)^(1/k); z = probit(1−α'/2). k=1 → exactly 1.96 (no
 * penalty); k=8 → ≈2.73. This is what the bin-sweep headline pays for picking the luckiest of k entry-age
 * windows (the winner's-curse fix); the per-bin table stays at the nominal z=1.96 and is labelled as such.
 */
export function sidakZ(k: number, fwer = 0.05): number {
  if (!(k >= 1) || !(fwer > 0 && fwer < 1)) return NaN;
  const alphaAdj = 1 - Math.pow(1 - fwer, 1 / k);
  return probit(1 - alphaAdj / 2);
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
  nDistinctCities: number;
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

/**
 * Score one entry-age bin's resolved rows. feeRate drives the CANONICAL Polymarket fee curve
 * takerFeePerShare(p, rate) = rate·p·(1−p) (core/fees.ts — same as the bot/paper backtest), NOT a flat per-share
 * charge. An entry is counted only if it is actually FILLABLE (positive executable ask AND +10%-band depth ≥
 * minDepthUsd) AND its market was NOT flagged grading_mismatch (venue↔truth disagreement → ambiguous payout,
 * dropped). NOTE: this scorer deliberately does NOT apply the bot's flat-open price cap — it tests the DISTINCT
 * hold-to-resolution variant (buy the center at whatever it costs and hold); the cap is the falsified taker leg.
 */
export function scoreBin(
  binIdx: number,
  binLabel: string,
  rows: ScoreRow[],
  feeRate: number,
  minDepthUsd: number,
): BinScore {
  const resolved = rows.filter(
    (r) =>
      fin(r.execAsk) && r.execAsk! > 0 && fin(r.centerIdx) && r.winnerIdx != null && !r.gradingMismatch &&
      (minDepthUsd <= 0 || (fin(r.depthUsd) && r.depthUsd! >= minDepthUsd)),
  );
  const nResolved = resolved.length;
  const nDistinctDates = new Set(resolved.map((r) => r.targetDate).filter(Boolean)).size;
  const nDistinctCities = new Set(resolved.map((r) => r.city).filter(Boolean)).size;

  const wins = resolved.map((r) => (r.centerIdx === r.winnerIdx ? 1 : 0));
  const asks = resolved.map((r) => r.execAsk!);
  const rois = resolved.map((r, i) => (wins[i]! - asks[i]! - takerFeePerShare(asks[i]!, feeRate)) / asks[i]!);
  const { mean: meanRoi, low: roiLow, high: roiHigh } = meanCi95(rois);

  // market-favorite baseline (only rows where the fav bucket + its ask are usable)
  const mkt = resolved.filter((r) => fin(r.mktFavIdx) && fin(r.mktFavAsk) && r.mktFavAsk! > 0);
  const mktWins = mkt.map((r) => (r.mktFavIdx === r.winnerIdx ? 1 : 0));
  const mktAsks = mkt.map((r) => r.mktFavAsk!);

  const centerHitRate = mean(wins);
  const avgEntryAsk = mean(asks);
  const mktHitRate = mean(mktWins);
  const mktAvgAsk = mean(mktAsks);

  // A GO/NO-GO label requires the independence floors (≥MIN_DATES weather-days AND ≥MIN_CITIES cities), not a
  // raw market count — else one climatic draw could fire a (terminal) NO-GO. Below any floor the bin is
  // INSUFFICIENT regardless of how lopsided the count looks.
  let label: ScoreLabel = 'INSUFFICIENT_DATA';
  const clearsFloors = nResolved >= MIN_RESOLVED && nDistinctDates >= MIN_DATES && nDistinctCities >= MIN_CITIES;
  if (clearsFloors && Number.isFinite(roiLow) && Number.isFinite(roiHigh)) {
    if (roiLow > 0) label = 'GO';
    else if (roiHigh < 0) label = 'NO-GO';
  }

  return {
    binIdx,
    binLabel,
    nEvents: rows.length,
    nResolved,
    nDistinctDates,
    nDistinctCities,
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
  /** of the resolved events, how many were scored on the VENUE winner (poly non-null) vs OUR truth-grade only. */
  nVenueResolved: number;
  nGradeResolved: number;
  /** events dropped from scoring because our grader flagged a venue↔truth disagreement (ambiguous payout). */
  nMismatchExcluded: number;
  bins: BinScore[];
  /** the headline bin = the one with the highest MULTIPLICITY-ADJUSTED ROI lower bound (winner's-curse fix),
   *  among bins with ≥ MIN_RESOLVED resolved. Null when none is eligible. */
  bestBin: BinScore | null;
  /** number of bins entering the headline selection (the Šidák family size k). */
  nEligibleBins: number;
  /** the Šidák two-sided z applied to the headline (1.96 when k≤1, wider as k grows). */
  headlineZ: number;
  /** bestBin's ROI lower bound at headlineZ (the multiplicity-adjusted bound the GO test uses). NaN if none. */
  bestBinRoiLowAdj: number;
  /** the FAMILY-WISE headline verdict (Šidák-adjusted), distinct from any single bin's nominal label. */
  headlineLabel: ScoreLabel;
  /** true when the headline was forced to INSUFFICIENT because venue resolution is below MIN_VENUE_RESOLVED —
   *  the per-bin numbers are then a FORECAST-SKILL diagnostic (our truth grade), not a venue-P&L verdict. */
  venueGated: boolean;
}

export function scoreAll(rows: ScoreRow[], feeRate: number, minDepthUsd = 0): ScoreResult {
  const byBin = new Map<number, ScoreRow[]>();
  for (const r of rows) {
    const arr = byBin.get(r.binIdx) ?? [];
    arr.push(r);
    byBin.set(r.binIdx, arr);
  }
  const bins = [...byBin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, rs]) => scoreBin(idx, rs[0]!.binLabel, rs, feeRate, minDepthUsd));

  // resolution provenance, counted over distinct events (a row resolves when winnerIdx is non-null): venue =
  // poly settled it, grade-only = no venue resolution yet (the routine grader's winning_bucket_idx is the ruler),
  // mismatch = excluded from scoring. Surfaced so the operator sees whether the "venue P&L" is venue or proxy.
  const venueEvents = new Set<string>();
  const gradeEvents = new Set<string>();
  const mismatchEvents = new Set<string>();
  for (const r of rows) {
    if (r.gradingMismatch) { mismatchEvents.add(r.eventId); continue; }
    if (r.polyWinnerIdx != null) venueEvents.add(r.eventId);
    else if (r.winningBucketIdx != null) gradeEvents.add(r.eventId);
  }
  for (const id of mismatchEvents) { venueEvents.delete(id); gradeEvents.delete(id); }

  // The bin sweep is an 8-window fishing screen, so picking the best bin and testing it at a nominal 5% would
  // inflate the family-wise false-GO rate. Pay for the selection with a Šidák z over the eligible family, and
  // pick the headline bin by the ADJUSTED lower bound (not the nominal one — the bin maximising the nominal
  // roiLow need not maximise the adjusted bound when bins differ in se). se is re-derived from each bin's
  // nominal interval (roiLow = mean − 1.96·se ⇒ se = (mean − roiLow)/1.96), avoiding re-passing the raw rois.
  // Eligibility requires the SAME independence floors as the per-bin label (dates + cities), so the headline
  // family — and the NO-GO "every eligible bin negative" test — is never built from a single climatic draw.
  const eligible = bins.filter(
    (b) =>
      b.nResolved >= MIN_RESOLVED && b.nDistinctDates >= MIN_DATES && b.nDistinctCities >= MIN_CITIES &&
      Number.isFinite(b.roiLow) && Number.isFinite(b.roiHigh),
  );
  const nEligibleBins = eligible.length;
  const headlineZ = nEligibleBins > 0 ? sidakZ(nEligibleBins) : NaN;
  const seOf = (b: BinScore): number => (b.meanRoi - b.roiLow) / 1.96; // ≥ 0 for an eligible bin
  const adjLow = (b: BinScore): number => b.meanRoi - headlineZ * seOf(b);
  const adjHigh = (b: BinScore): number => b.meanRoi + headlineZ * seOf(b);
  const bestBin = nEligibleBins > 0 ? eligible.reduce((best, b) => (adjLow(b) > adjLow(best) ? b : best)) : null;
  const bestBinRoiLowAdj = bestBin ? adjLow(bestBin) : NaN;

  // Headline GO requires the best bin to clear 0 at the Šidák-widened LOWER bound. A TERMINAL NO-GO is the
  // expensive error (it folds the lever into the falsified column), so the kill side is held to AT LEAST the GO
  // side's rigor: every eligible bin's Šidák-WIDENED UPPER bound < 0 (not the looser nominal z=1.96 roiHigh), AND
  // ≥ MIN_NOGO_BINS eligible bins. CAVEAT (logged in the verdict, not silently): the bins are different-age
  // snapshots of the SAME fresh events, so the win component (centerIdx==winner) is correlated across adjacent
  // young bins — k is "measured price-windows over ≥7 weather-days", not k independent signals. The widened
  // bound + the per-bin ≥7-date/≥6-city floors keep the kill conservative, but the falsification call is the
  // operator's + the §9R-E cluster gate's — this screen only reports "no profitable entry age found".
  let headlineLabel: ScoreLabel = 'INSUFFICIENT_DATA';
  if (bestBin) {
    if (bestBinRoiLowAdj > 0) headlineLabel = 'GO';
    else if (nEligibleBins >= MIN_NOGO_BINS && eligible.every((b) => adjHigh(b) < 0)) headlineLabel = 'NO-GO';
  }
  // A GO/NO-GO is a VENUE-P&L claim — refuse it until enough markets carry real venue resolution. Below the floor
  // the per-bin numbers are a forecast-SKILL diagnostic on our truth grade, NOT what the venue pays (the basis
  // wedge). This blocks the dangerous "first verdict is grade-only but labelled what-pays" false-GO path.
  const venueGated = venueEvents.size < MIN_VENUE_RESOLVED;
  if (venueGated) headlineLabel = 'INSUFFICIENT_DATA';

  return {
    nRows: rows.length,
    nEvents: new Set(rows.map((r) => r.eventId)).size,
    nResolvedEvents: new Set(rows.filter((r) => r.winnerIdx != null && !r.gradingMismatch).map((r) => r.eventId)).size,
    nVenueResolved: venueEvents.size,
    nGradeResolved: gradeEvents.size,
    nMismatchExcluded: mismatchEvents.size,
    bins,
    bestBin,
    nEligibleBins,
    headlineZ,
    bestBinRoiLowAdj,
    headlineLabel,
    venueGated,
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
  /** effective ruler = polyWinnerIdx ?? winningBucketIdx (venue where settled, else our realized-truth grade). */
  winnerIdx: number | null;
  /** our grader flagged venue↔truth disagreement — the event is excluded from band scoring (ambiguous payout). */
  gradingMismatch: boolean;
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
  /** Σ canonical taker fee over the held buckets at their series-low / series-high asks (rate·p·(1−p)). */
  basketFeeLow: number;
  basketFeeHigh: number;
  winnerIdx: number | null;
  /** truth landed within forecast±1 — the forecast-ACCURACY stat (index distance), null until resolved. */
  bandHit: boolean | null;
  /** truth landed on a bucket we ACTUALLY HELD (winner ∈ purchased band buckets) — the basket PAYOUT indicator.
   *  Differs from bandHit when a within-±1 bucket had no buyable ask across the series (not in the basket). */
  basketPaid: boolean | null;
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
  /** P(truth within forecast±1) over resolved events — forecast ACCURACY (index distance). */
  bandHitRate: number;
  /** P(truth on a HELD bucket) over resolved — the basket payout rate (≤ bandHitRate; gap = unbought hits). */
  basketPaidRate: number;
  /** mean basket ROI if every bucket entered at its series-low (best case), net of per-bucket fee — resolved only. */
  bestCaseBasketRoi: number;
  /** mean basket ROI if every bucket entered at its series-high (worst case), net of per-bucket fee — resolved only. */
  worstCaseBasketRoi: number;
}

/** Group the per-bucket band rows into one EventBand each. grading_mismatch events are dropped (ambiguous
 *  payout). feeRate drives the canonical per-bucket taker fee on the basket. Pure + total. */
export function reduceEventBands(rows: BandBucketRow[], feeRate = 0): EventBand[] {
  const byEvent = new Map<string, BandBucketRow[]>();
  for (const r of rows) {
    if (r.gradingMismatch) continue; // exclude venue↔truth disagreements from band scoring
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
    // the buckets we actually HELD = those present in the band CTE (a buyable ask somewhere in the series). A
    // within-±1 winner that had no ask all series is NOT in this set, so the basket never bought it → pays $0.
    const purchased = new Set(bs.map((b) => b.bucketIdx));
    out.push({
      eventId,
      targetDate: meta.targetDate,
      forecastIdx: meta.forecastIdx,
      nBuckets: bs.length,
      singleLowAsk: Math.min(...lows),
      singleHighAsk: Math.max(...highs),
      basketCostLow: bs.reduce((a, b) => a + (Number.isFinite(b.minAsk) ? b.minAsk : 0), 0),
      basketCostHigh: bs.reduce((a, b) => a + (Number.isFinite(b.maxAsk) ? b.maxAsk : 0), 0),
      basketFeeLow: bs.reduce((a, b) => a + (Number.isFinite(b.minAsk) ? takerFeePerShare(b.minAsk, feeRate) : 0), 0),
      basketFeeHigh: bs.reduce((a, b) => a + (Number.isFinite(b.maxAsk) ? takerFeePerShare(b.maxAsk, feeRate) : 0), 0),
      winnerIdx,
      bandHit: resolved ? Math.abs(winnerIdx! - meta.forecastIdx) <= 1 : null,
      basketPaid: resolved ? purchased.has(winnerIdx!) : null,
      resolved,
    });
  }
  return out;
}

/**
 * Panel summary of the forecast-band envelope + resolution. Pure + total. The basket ROI pays $1 only when the
 * winner was a HELD bucket (basketPaid, not the index-distance bandHit), and nets out the taker fee on each of
 * the event's nBuckets held shares — consistent with the fee-aware center score.
 */
export function summarizeBand(rows: BandBucketRow[], feeRate = 0): BandSummary {
  const events = reduceEventBands(rows, feeRate);
  const resolved = events.filter((e) => e.resolved);
  const hit = resolved.map((e) => (e.bandHit ? 1 : 0));
  const paid = resolved.map((e) => (e.basketPaid ? 1 : 0));
  const bestRoi = resolved
    .filter((e) => e.basketCostLow > 0)
    .map((e) => ((e.basketPaid ? 1 : 0) - e.basketCostLow - e.basketFeeLow) / e.basketCostLow);
  const worstRoi = resolved
    .filter((e) => e.basketCostHigh > 0)
    .map((e) => ((e.basketPaid ? 1 : 0) - e.basketCostHigh - e.basketFeeHigh) / e.basketCostHigh);
  return {
    nEvents: events.length,
    nResolved: resolved.length,
    nDistinctDates: new Set(resolved.map((e) => e.targetDate).filter(Boolean)).size,
    avgSingleLowAsk: mean(events.map((e) => e.singleLowAsk)),
    avgSingleHighAsk: mean(events.map((e) => e.singleHighAsk)),
    avgBasketCostLow: mean(events.map((e) => e.basketCostLow)),
    avgBasketCostHigh: mean(events.map((e) => e.basketCostHigh)),
    bandHitRate: mean(hit),
    basketPaidRate: mean(paid),
    bestCaseBasketRoi: mean(bestRoi),
    worstCaseBasketRoi: mean(worstRoi),
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// report
// ─────────────────────────────────────────────────────────────────────────────────────────────────
export function report(
  res: ScoreResult,
  band: BandSummary | null,
  feeRate: number,
  minDepthUsd: number,
  log: (m: string) => void,
): void {
  const roiLabel = feeRate > 0 ? 'net incl fee (rate·p·(1−p))' : 'GROSS (fee 0)';
  log('=== opening-resolution-score · hold-to-resolution realized edge by entry age ===');
  log(
    `rows ${res.nRows} · events ${res.nEvents} · resolved events ${res.nResolvedEvents} · ` +
      `taker fee rate ${pct(feeRate)} · min depth $${minDepthUsd}`,
  );
  log(
    `  GO/NO-GO floors (ALL required): ≥${MIN_RESOLVED} resolved · ≥${MIN_DATES} distinct dates · ` +
      `≥${MIN_CITIES} distinct cities · terminal NO-GO needs ≥${MIN_NOGO_BINS} eligible bins`,
  );
  log(
    `  resolution ruler: ${res.nVenueResolved} via VENUE (poly) · ${res.nGradeResolved} via our truth-grade only ` +
      `· ${res.nMismatchExcluded} grading_mismatch EXCLUDED` +
      (res.nResolvedEvents > 0 && res.nVenueResolved === 0 ? '  ⚠ no venue resolution yet — run the market-history backfill for a true venue P&L' : ''),
  );
  log('');
  log('  the bet scored: BUY our forecast-center bucket at the entry-age snapshot, HOLD to resolution.');
  log(`  edge = centerHit − avgAsk (raw, pre-fee); ROI = mean per-$ ${roiLabel}, with iid-95% CI (clustered by`);
  log('  target_date ⇒ true CI WIDER — a GO here still defers to the §9R-E cluster-bootstrap capital gate).');
  log('  entries counted only if fillable: execAsk>0 AND +10%-band depth ≥ min depth (no flat-open price cap —');
  log('  this scores the hold-to-resolution variant, not the falsified taker-convergence one).');
  log('  the per-bin "verdict" column is NOMINAL (z=1.96, no multiplicity correction) — informational only; the');
  log('  headline VERDICT below applies a Šidák penalty for selecting the best of the eligible bins.');
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
      log(`  band hit rate (truth within ±1°, forecast accuracy): ${pct(band.bandHitRate)}  over ${band.nResolved} resolved`);
      log(`  basket PAID rate (truth on a HELD bucket — the payout): ${pct(band.basketPaidRate)}  (≤ hit rate; gap = unbought hits)`);
      log(
        `  basket hold-to-resolution ROI (net fee) — best-case ${pct(band.bestCaseBasketRoi)} · ` +
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
  if (res.venueGated) {
    log(
      `  INSUFFICIENT_DATA (venue-gated) — only ${res.nVenueResolved} markets carry VENUE resolution ` +
        `(poly_resolved_winner_idx), below the ${MIN_VENUE_RESOLVED} floor, so a tradable GO/NO-GO cannot fire. The ` +
        `${res.nGradeResolved} grade-resolved markets above are a FORECAST-SKILL diagnostic (our center vs our ` +
        'station-Tmax grade), NOT venue P&L — our basis ≠ the venue\'s (the dual-source/1°F wedge). To get a venue ' +
        'verdict, run the market-history backfill (populates poly_resolved_winner_idx + grading_mismatch), then re-run.',
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
  const adj = `Šidák-adjusted across ${res.nEligibleBins} eligible bin(s): z=${f2(res.headlineZ)}, ` +
    `adjusted ROI lower bound ${pct(res.bestBinRoiLowAdj)}`;
  const head =
    res.headlineLabel === 'GO'
      ? `GO — best entry window "${b.binLabel}": hold-to-resolution ROI ${pct(b.meanRoi)} over ${b.nResolved} ` +
        `resolved markets across ${b.nDistinctDates} dates, and it CLEARS 0 after the multiplicity penalty (${adj} > 0). ` +
        `Our center won ${pct(b.centerHitRate)} vs ${f2(b.avgEntryAsk)} paid (edge ${pct(b.edgePerShare)}); ` +
        `market-favorite baseline edge ${pct(b.mktEdgePerShare)}. The hold-to-resolution path carries measured edge ` +
        'surviving the bin-sweep correction — model it further (still gated by §9R-E for capital).'
      : res.headlineLabel === 'NO-GO'
        ? `NO-GO (screen-negative) — all ${res.nEligibleBins} MEASURED entry-age windows (of 8) have their ` +
          `Šidák-WIDENED ROI upper bound < 0 (z=${f2(res.headlineZ)}) over ${b.nResolved} resolved markets across ` +
          `≥${MIN_DATES} weather-days: no profitable entry age found — our center won ${pct(b.centerHitRate)} vs ` +
          `${f2(b.avgEntryAsk)} paid (edge ${pct(b.edgePerShare)}), not enough to cover even the cheapest entry. ` +
          'NOTE the measured windows share event cohorts (correlated across age), so this is a strong screen-negative, ' +
          'NOT a unilateral falsification — the operator + the §9R-E cluster gate make the signal-#12 kill call.'
        : `INSUFFICIENT_DATA — best bin "${b.binLabel}" ROI ${pct(b.meanRoi)} (nominal CI [${pct(b.roiLow)}, ` +
          `${pct(b.roiHigh)}]) does NOT clear 0 after the multiplicity penalty (${adj}), and not every bin is ` +
          `negative either — no family-wise call yet over ${b.nResolved} resolved markets. Let more settle and re-run.`;
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
export async function loadRows(db: ScriptDb, days: number, minDepthUsd = 0): Promise<ScoreRow[]> {
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
             -- deterministic lowest-idx-on-tie (matches core selectEntries / opening-spike modeIdxOf), so the
             -- center/favorite pick is reproducible run-to-run and aligned with the live executor on exact ties.
             row_number() over (partition by oc.id order by (b->>'houseProb')::numeric desc nulls last, (b->>'idx')::int) as rk_house,
             row_number() over (partition by oc.id order by (b->>'mid')::numeric desc nulls last, (b->>'idx')::int) as rk_mid
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      cross join lateral jsonb_array_elements(oc.buckets) as arr(b)
      where oc.captured_at > now() - ($1 || ' days')::interval and oc.buckets is not null
    ),
    perCap as (
      -- the center pick REQUIRES a non-null houseProb (rk_house orders nulls last, so an all-null-houseProb
      -- capture would otherwise hand rk_house=1 to an arbitrary bucket → a garbage center_idx scored as our
      -- forecast center, biasing the hit-rate toward the ~1/11 base rate). The houseProb guard yields NULL
      -- center_idx for an un-seeded / W6-unaligned capture, which scoreBin then drops. Mirrors
      -- loadBandEnvelope's capmode (house_prob is not null guard) + opening-spike's modeIdxOf (-1).
      select e.id, e.event_id, e.city, e.target_date, e.hours_since_listing, e.ev_vol24h,
             max(e.idx)      filter (where e.rk_house = 1 and e.house_prob is not null) as center_idx,
             max(e.exec_ask) filter (where e.rk_house = 1 and e.house_prob is not null) as exec_ask,
             max(e.exec_bid) filter (where e.rk_house = 1 and e.house_prob is not null) as exec_bid,
             max(e.depth_usd)filter (where e.rk_house = 1 and e.house_prob is not null) as depth_usd,
             -- mirror the center guard: an all-null-mid (one-sided flat-open) book must not score an arbitrary
             -- nulls-last bucket as the market favorite → NULL favorite, dropped by scoreBin's baseline filter.
             max(e.idx)      filter (where e.rk_mid = 1 and e.mid is not null) as mkt_fav_idx,
             max(e.exec_ask) filter (where e.rk_mid = 1 and e.mid is not null) as mkt_fav_ask
      from exploded e
      group by e.id, e.event_id, e.city, e.target_date, e.hours_since_listing, e.ev_vol24h
    ),
    binned as (
      -- the bin's representative = the capture closest to the bin centre, but PREFERRED in FILLABILITY order so we
      -- never pick a snapshot scoreBin will then discard while a usable one existed in the same bin (non-random
      -- starving — the TEST2-7 class). Rungs, before distance: (1) carries a forecast center (center_idx not null),
      -- (2) has a buyable ask (exec_ask > 0), (3) clears the depth floor ($2 = minDepthUsd). Mirrors opening-spike.
      select c.*, bn.bin_idx, bn.label as bin_label, bn.ctr,
             row_number() over (partition by c.event_id, bn.bin_idx
                                order by (c.center_idx is not null) desc,
                                         (c.exec_ask is not null and c.exec_ask > 0) desc,
                                         (c.depth_usd is not null and c.depth_usd >= $2) desc,
                                         abs(c.hours_since_listing - bn.ctr)) as rn
      from perCap c
      join bins bn on c.hours_since_listing >= bn.lo and c.hours_since_listing < bn.hi
    )
    select b.event_id, b.city, me.target_date, b.bin_idx, b.bin_label,
           round(b.hours_since_listing, 3)::float8 as entry_age_h,
           b.center_idx, b.exec_ask::float8, b.exec_bid::float8, b.depth_usd::float8, b.ev_vol24h::float8,
           b.mkt_fav_idx, b.mkt_fav_ask::float8,
           me.poly_resolved_winner_idx, me.winning_bucket_idx, me.grading_mismatch, me.resolved_at
    from binned b
    join public.market_events me on me.id = b.event_id
    where b.rn = 1
    order by b.event_id, b.bin_idx;
  `;
  const out = await db.query<Record<string, unknown>>(sql, [Math.max(1, Math.floor(days)), Math.max(0, minDepthUsd)]);
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
    polyWinnerIdx: numOrNull(r['poly_resolved_winner_idx']),
    winningBucketIdx: numOrNull(r['winning_bucket_idx']),
    winnerIdx: numOrNull(r['poly_resolved_winner_idx']) ?? numOrNull(r['winning_bucket_idx']),
    gradingMismatch: r['grading_mismatch'] === true,
    resolvedAt: r['resolved_at'] == null ? null : String(r['resolved_at']),
  }));
}

/**
 * Per-event forecast-band envelope: for each event, the min/max execAsk (over the full series) of every
 * bucket within ±1 of the event's representative argmax-house bucket (forecastIdx = the mode of each
 * capture's argmax-houseProb idx — our predicted-high bucket), joined to the event's resolution.
 */
export async function loadBandEnvelope(db: ScriptDb, days: number, minDepthUsd = 0): Promise<BandBucketRow[]> {
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
             (arr.b->>'execAsk')::numeric as exec_ask,
             (arr.b->>'depthUsd')::numeric as depth_usd
      from public.opening_captures oc
      join fresh f on f.event_id = oc.event_id
      cross join lateral jsonb_array_elements(oc.buckets) as arr(b)
      where oc.captured_at > now() - ($1 || ' days')::interval and oc.buckets is not null
    ),
    capmode as (   -- the argmax-houseProb bucket idx for each capture (lowest-idx-on-tie, matching core)
      select id, event_id, (array_agg(idx order by house_prob desc nulls last, idx))[1] as mode_idx
      from exploded where house_prob is not null group by id, event_id
    ),
    eventmode as ( -- the event's representative predicted-high bucket = most frequent capture mode
      select event_id, mode() within group (order by mode_idx) as forecast_idx
      from capmode group by event_id
    ),
    band as (      -- every band-bucket observation across the series (±1 of forecast_idx, a FILLABLE buyable ask:
                   -- a positive ask AND ≥ $2 depth, so the logged "lowest entry point" is the cheapest you could
                   -- actually FILL — the capacity-wall discipline, consistent with the depth-gated center score).
      select e.event_id, em.forecast_idx, e.idx, e.exec_ask, e.hours_since_listing
      from exploded e
      join eventmode em on em.event_id = e.event_id
      where e.idx between em.forecast_idx - 1 and em.forecast_idx + 1
        and e.exec_ask is not null and e.exec_ask > 0
        and ($2 <= 0 or (e.depth_usd is not null and e.depth_usd >= $2))
    )
    select b.event_id, me.target_date, b.forecast_idx, b.idx as bucket_idx,
           min(b.exec_ask)::float8 as min_ask, max(b.exec_ask)::float8 as max_ask,
           (array_agg(b.hours_since_listing order by b.exec_ask asc))[1]::float8  as low_age,
           (array_agg(b.hours_since_listing order by b.exec_ask desc))[1]::float8 as high_age,
           me.poly_resolved_winner_idx, me.winning_bucket_idx, me.grading_mismatch, me.resolved_at
    from band b
    join public.market_events me on me.id = b.event_id
    group by b.event_id, me.target_date, b.forecast_idx, b.idx,
             me.poly_resolved_winner_idx, me.winning_bucket_idx, me.grading_mismatch, me.resolved_at
    order by b.event_id, b.idx;
  `;
  const out = await db.query<Record<string, unknown>>(sql, [Math.max(1, Math.floor(days)), Math.max(0, minDepthUsd)]);
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
    gradingMismatch: r['grading_mismatch'] === true,
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
    mktFavIdx: 5, mktFavAsk: 0.3, polyWinnerIdx: null, winningBucketIdx: null, winnerIdx: null,
    gradingMismatch: false, resolvedAt: null, ...over,
  });

  // unresolved rows ⇒ INSUFFICIENT, no NaN crash
  const s0 = scoreAll([row({}), row({ eventId: 'F' })], 0);
  if (s0.nResolvedEvents !== 0 || s0.bestBin !== null) throw new Error('sanity: unresolved should yield no bestBin');

  // a clearly-winning panel: center wins 70% at price 0.30 ⇒ edge +0.40, ROI strongly +, CI low > 0 ⇒ GO.
  // 9 dates × 7 cities clears the independence floors; single bin (binIdx 3) ⇒ k=1 ⇒ Šidák z = 1.96 ⇒ headline
  // matches the nominal bin label.
  const win = Array.from({ length: 60 }, (_, i) =>
    row({ eventId: `W${i}`, city: `c${i % 7}`, targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5, winnerIdx: i % 10 < 7 ? 5 : 1, winningBucketIdx: i % 10 < 7 ? 5 : 1, polyWinnerIdx: i % 10 < 7 ? 5 : 1, resolvedAt: 'r' }),
  );
  const winRes = scoreAll(win, 0);
  const gs = winRes.bins.find((b) => b.binIdx === 3)!;
  if (gs.label !== 'GO') throw new Error(`sanity: winning panel bin should GO, got ${gs.label} roiLow=${gs.roiLow}`);
  if (Math.abs(gs.centerHitRate - 0.7) > 1e-9) throw new Error(`sanity: hitRate ${gs.centerHitRate} != 0.7`);
  if (winRes.headlineLabel !== 'GO') throw new Error(`sanity: winning panel headline should GO (k=1), got ${winRes.headlineLabel}`);
  if (Math.abs(winRes.headlineZ - 1.959964) > 1e-3) throw new Error(`sanity: k=1 headlineZ should be 1.96, got ${winRes.headlineZ}`);

  // a clearly-losing panel across 3 bins (center wins 5% @ 0.30) ⇒ every eligible bin's CI < 0 AND
  // nEligibleBins (3) ≥ MIN_NOGO_BINS ⇒ terminal NO-GO.
  const lose: ScoreRow[] = [];
  for (let bin = 0; bin < 3; bin++) {
    for (let i = 0; i < 40; i++) {
      const w = i % 20 === 0 ? 5 : 2;
      lose.push(row({
        eventId: `L${bin}_${i}`, binIdx: bin, binLabel: `b${bin}`, city: `c${i % 7}`,
        targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5, winnerIdx: w,
        winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r',
      }));
    }
  }
  const loseRes = scoreAll(lose, 0);
  const ls = loseRes.bins.find((b) => b.binIdx === 0)!;
  if (ls.label !== 'NO-GO') throw new Error(`sanity: losing panel bin should NO-GO, got ${ls.label} roiHigh=${ls.roiHigh}`);
  if (loseRes.headlineLabel !== 'NO-GO') throw new Error(`sanity: losing panel (3 bins) headline should NO-GO, got ${loseRes.headlineLabel}`);

  // MIN_NOGO_BINS guard: a SINGLE losing eligible bin is nominally NO-GO but must NOT TERMINAL-NO-GO the lever —
  // the other 7 entry-age windows are unmeasured, not measured-losing ⇒ headline INSUFFICIENT.
  const oneBinLoss = scoreAll(lose.filter((r) => r.binIdx === 0), 0);
  if (oneBinLoss.bins.find((b) => b.binIdx === 0)!.label !== 'NO-GO') throw new Error('sanity: single losing bin is nominally NO-GO');
  if (oneBinLoss.nEligibleBins !== 1) throw new Error('sanity: single-bin loss should have 1 eligible bin');
  if (oneBinLoss.headlineLabel !== 'INSUFFICIENT_DATA') throw new Error(`sanity: 1 losing bin (< MIN_NOGO_BINS) headline must be INSUFFICIENT, got ${oneBinLoss.headlineLabel}`);

  // WIDENED-BOUND kill side: 8 bins each 13/40 wins @ $0.50 ⇒ meanRoi −0.35, nominal roiHigh ≈ −0.056 (every bin
  // nominally NO-GO), but the k=8 Šidák-widened upper bound ≈ +0.059 > 0 ⇒ headline must be INSUFFICIENT (the kill
  // side is held to the GO side's rigor — no terminal NO-GO on the looser nominal interval).
  const marginal: ScoreRow[] = [];
  for (let bin = 0; bin < 8; bin++) {
    for (let i = 0; i < 40; i++) {
      const w = i < 13 ? 5 : 1;
      marginal.push(row({
        eventId: `Mg${bin}_${i}`, binIdx: bin, binLabel: `b${bin}`, city: `c${i % 7}`,
        targetDate: `2026-06-${10 + (i % 9)}`, execAsk: 0.5, mktFavAsk: 0.5,
        centerIdx: 5, winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r',
      }));
    }
  }
  const marginalRes = scoreAll(marginal, 0);
  if (!marginalRes.bins.every((b) => b.label === 'NO-GO')) throw new Error('sanity: marginal bins should each be nominally NO-GO');
  if (marginalRes.headlineLabel !== 'INSUFFICIENT_DATA') throw new Error(`sanity: widened bound must spare a marginal nominal-NO-GO, got ${marginalRes.headlineLabel}`);

  // a fair panel (center wins exactly at its price, 30% @ 0.30) ⇒ ROI ≈ 0, CI straddles ⇒ INSUFFICIENT
  const fair = Array.from({ length: 60 }, (_, i) =>
    row({ eventId: `Fa${i}`, city: `c${i % 7}`, targetDate: `2026-06-${10 + (i % 9)}`, centerIdx: 5, winnerIdx: i % 10 < 3 ? 5 : 9, winningBucketIdx: i % 10 < 3 ? 5 : 9, resolvedAt: 'r' }),
  );
  const fs = scoreAll(fair, 0).bins.find((b) => b.binIdx === 3)!;
  if (fs.label !== 'INSUFFICIENT_DATA') throw new Error(`sanity: fair panel should be INSUFFICIENT, got ${fs.label}`);

  // below MIN_RESOLVED ⇒ never GO/NO-GO even if lopsided
  const few = Array.from({ length: 10 }, (_, i) => row({ eventId: `Few${i}`, winnerIdx: 5, winningBucketIdx: 5, resolvedAt: 'r' }));
  if (scoreAll(few, 0).bins[0]!.label !== 'INSUFFICIENT_DATA') throw new Error('sanity: <MIN_RESOLVED should be INSUFFICIENT');

  // INDEPENDENCE FLOOR: 48 strongly-winning resolved markets but only 2 target_dates / 2 cities ⇒ a single
  // climatic draw ⇒ MUST be INSUFFICIENT (never a GO) despite nResolved ≥ 40 and a huge edge. Guards the false-GO
  // / false-terminal-NO-GO on one weather-day.
  const clustered = Array.from({ length: 48 }, (_, i) => {
    const w = i % 10 < 8 ? 5 : 1;
    return row({ eventId: `Cl${i}`, city: `c${i % 2}`, targetDate: `2026-06-${10 + (i % 2)}`, centerIdx: 5, winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r' });
  });
  const clRes = scoreAll(clustered, 0);
  const clBin = clRes.bins.find((b) => b.binIdx === 3)!;
  if (clBin.nResolved < MIN_RESOLVED) throw new Error('sanity: clustered panel should still have ≥40 resolved');
  if (clBin.label !== 'INSUFFICIENT_DATA') throw new Error(`sanity: clustered (2 dates/2 cities) bin must be INSUFFICIENT, got ${clBin.label}`);
  if (clRes.headlineLabel !== 'INSUFFICIENT_DATA') throw new Error(`sanity: clustered headline must be INSUFFICIENT, got ${clRes.headlineLabel}`);

  // EXECUTABLE-DEPTH FLOOR: the winning panel but every entry only $10 deep. With --min-depth 50 every row is
  // dropped (not fillable) ⇒ INSUFFICIENT; with 0 it scores as before (GO). Guards the thin-top-of-book false-pass.
  const thin = win.map((r) => ({ ...r, depthUsd: 10 }));
  if (scoreAll(thin, 0, 50).bins.find((b) => b.binIdx === 3)!.nResolved !== 0) throw new Error('sanity: $10-deep rows must be dropped at min-depth 50');
  if (scoreAll(thin, 0, 50).bins.find((b) => b.binIdx === 3)!.label !== 'INSUFFICIENT_DATA') throw new Error('sanity: thin panel at min-depth 50 must be INSUFFICIENT');
  if (scoreAll(thin, 0, 0).bins.find((b) => b.binIdx === 3)!.label !== 'GO') throw new Error('sanity: thin panel at min-depth 0 must still GO');

  // grading_mismatch EXCLUSION + venue/grade PROVENANCE: take the winning panel, flag 1/3 of the events as
  // grading_mismatch (must be dropped from scoring) and resolve the rest via VENUE (polyWinnerIdx) vs our grade.
  const prov = win.map((r, i) => ({
    ...r,
    gradingMismatch: i % 3 === 0,
    polyWinnerIdx: i % 3 === 1 ? r.winnerIdx : null, // a third venue-settled, a third grade-only, a third mismatch
  }));
  const provRes = scoreAll(prov, 0);
  if (provRes.nMismatchExcluded !== 20) throw new Error(`sanity: 20 grading_mismatch events excluded, got ${provRes.nMismatchExcluded}`);
  if (provRes.nVenueResolved !== 20 || provRes.nGradeResolved !== 20) throw new Error(`sanity: provenance venue/grade ${provRes.nVenueResolved}/${provRes.nGradeResolved} != 20/20`);
  if (provRes.bins.find((b) => b.binIdx === 3)!.nResolved !== 40) throw new Error('sanity: mismatch rows must be dropped from nResolved (40 of 60 remain)');
  // a fully-mismatch-flagged winning panel scores nothing ⇒ INSUFFICIENT (not a GO off ambiguous payouts)
  const allMismatch = scoreAll(win.map((r) => ({ ...r, gradingMismatch: true })), 0);
  if (allMismatch.headlineLabel !== 'INSUFFICIENT_DATA' || allMismatch.bins.find((b) => b.binIdx === 3)!.nResolved !== 0) {
    throw new Error('sanity: all-grading_mismatch panel must be INSUFFICIENT with 0 scored');
  }

  // VENUE GATE: a strong-GO panel resolved ONLY by our truth grade (no venue) ⇒ headline INSUFFICIENT (the per-bin
  // GO is a forecast-skill diagnostic, NOT venue P&L) — the dangerous "first verdict is grade-only, labelled
  // what-pays" false-GO path is blocked.
  const gradeOnly = win.map((r) => ({ ...r, polyWinnerIdx: null }));
  const goRes = scoreAll(gradeOnly, 0);
  if (goRes.nVenueResolved !== 0) throw new Error('sanity: grade-only panel should have 0 venue-resolved');
  if (goRes.bins.find((b) => b.binIdx === 3)!.label !== 'GO') throw new Error('sanity: grade-only bin is still a nominal forecast-skill GO');
  if (!goRes.venueGated || goRes.headlineLabel !== 'INSUFFICIENT_DATA') throw new Error(`sanity: grade-only headline must be venue-gated INSUFFICIENT, got ${goRes.headlineLabel}`);

  // canonical price-dependent fee: a non-zero --fee-rate lowers ROI via takerFeePerShare = rate·p·(1−p), and the
  // winning panel's GO survives the real 5% rate (fee at p=0.30 is only 0.05·0.3·0.7 = 0.0105/share).
  if (!(scoreAll(win, 0.05).bins.find((b) => b.binIdx === 3)!.meanRoi < winRes.bins.find((b) => b.binIdx === 3)!.meanRoi)) {
    throw new Error('sanity: fee-rate must reduce center ROI');
  }
  if (scoreAll(win, 0.05).headlineLabel !== 'GO') throw new Error('sanity: winning panel should survive the 5% canonical fee');

  // stats helpers
  if (Math.abs(mean([1, 2, 3]) - 2) > 1e-9) throw new Error('sanity: mean');
  if (Math.abs(sampleStd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) > 1e-3) throw new Error('sanity: sampleStd');

  // probit (inverse normal CDF) + Šidák z
  if (Math.abs(probit(0.975) - 1.959964) > 1e-4) throw new Error(`sanity: probit(0.975)=${probit(0.975)}`);
  if (Math.abs(probit(0.95) - 1.644854) > 1e-4) throw new Error(`sanity: probit(0.95)=${probit(0.95)}`);
  if (Math.abs(probit(0.5)) > 1e-6) throw new Error(`sanity: probit(0.5)=${probit(0.5)}`);
  if (!Number.isNaN(probit(0)) || !Number.isNaN(probit(1))) throw new Error('sanity: probit out-of-range should be NaN');
  if (Math.abs(sidakZ(1) - 1.959964) > 1e-4) throw new Error(`sanity: sidakZ(1)=${sidakZ(1)} should equal nominal z`);
  if (!(sidakZ(8) > 2.7 && sidakZ(8) < 2.75)) throw new Error(`sanity: sidakZ(8)=${sidakZ(8)} expected ≈2.73`);
  if (!(sidakZ(8) > sidakZ(2) && sidakZ(2) > sidakZ(1))) throw new Error('sanity: sidakZ should grow with k');

  // MULTIPLICITY (winner's curse) fix: 8 eligible bins each marginally GO at the NOMINAL z (27/40 wins @ $0.50,
  // roi ±1 ⇒ mean 0.35, nominal roiLow ≈ +0.06 > 0) but NONE clears 0 after the k=8 Šidák penalty (z≈2.73 ⇒
  // adj low ≈ −0.06). Each bin's nominal label is GO, yet the family-wise headline must be INSUFFICIENT_DATA.
  const multi: ScoreRow[] = [];
  for (let bin = 0; bin < 8; bin++) {
    for (let i = 0; i < 40; i++) {
      const w = i < 27 ? 5 : 1;
      multi.push(row({
        eventId: `M${bin}_${i}`, binIdx: bin, binLabel: `b${bin}`,
        city: `c${i % 7}`, targetDate: `2026-06-${10 + (i % 9)}`, execAsk: 0.5, mktFavAsk: 0.5,
        centerIdx: 5, winnerIdx: w, winningBucketIdx: w, polyWinnerIdx: w, resolvedAt: 'r',
      }));
    }
  }
  const multiRes = scoreAll(multi, 0);
  if (multiRes.nEligibleBins !== 8) throw new Error(`sanity: multi nEligibleBins ${multiRes.nEligibleBins} != 8`);
  if (multiRes.bins.every((b) => b.label === 'GO') !== true) throw new Error('sanity: each multi bin should be nominally GO');
  if (multiRes.headlineLabel !== 'INSUFFICIENT_DATA') {
    throw new Error(`sanity: multiplicity headline should be INSUFFICIENT (nominal GO killed by Šidák), got ${multiRes.headlineLabel} adjLow=${multiRes.bestBinRoiLowAdj}`);
  }

  // forecast-band envelope: forecastIdx 5, band {4,5,6}. Two events: one resolved-hit (winner 6 ∈ band),
  // one resolved-miss (winner 9 ∉ band). Envelope lows/highs + basket costs + band hit rate.
  const bb = (over: Partial<BandBucketRow>): BandBucketRow => ({
    eventId: 'B1', targetDate: '2026-06-29', forecastIdx: 5, bucketIdx: 5,
    minAsk: 0.2, maxAsk: 0.4, lowAgeH: 2, highAgeH: 0.1, winnerIdx: 6, gradingMismatch: false, resolvedAt: 'r', ...over,
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
  if (b1.basketPaid !== true) throw new Error('sanity: B1 winner 6 was held ⇒ basketPaid true');
  const bs = summarizeBand(bandRows);
  if (bs.nEvents !== 2 || bs.nResolved !== 2) throw new Error('sanity: band nEvents/nResolved');
  if (Math.abs(bs.bandHitRate - 0.5) > 1e-9) throw new Error(`sanity: bandHitRate ${bs.bandHitRate} != 0.5`);
  // best-case ROI: B1 (paid) (1−0.45)/0.45=+1.222 ; B2 (miss) (0−0.52)/0.52=−1.0 ; mean ≈ +0.111
  if (Math.abs(bs.bestCaseBasketRoi - 0.1111) > 1e-3) throw new Error(`sanity: bestCaseBasketRoi ${bs.bestCaseBasketRoi}`);
  if (summarizeBand([]).nEvents !== 0) throw new Error('sanity: empty band');

  // basketPaid DIVERGES from bandHit when a within-±1 winner was never purchasable. forecastIdx 5, only buckets
  // 5,6 present (bucket 4 had no ask all series); winner 4 ⇒ bandHit true (|4−5|=1, forecast-accurate) but
  // basketPaid false (4 ∉ held {5,6}) ⇒ the basket pays $0, NOT the $1 the old index-distance payout credited.
  const unbought: BandBucketRow[] = [
    bb({ eventId: 'B3', bucketIdx: 5, minAsk: 0.2, maxAsk: 0.4, winnerIdx: 4 }),
    bb({ eventId: 'B3', bucketIdx: 6, minAsk: 0.15, maxAsk: 0.35, winnerIdx: 4 }),
  ];
  const e3 = reduceEventBands(unbought)[0]!;
  if (e3.bandHit !== true) throw new Error('sanity: B3 winner 4 is a band hit (index distance)');
  if (e3.basketPaid !== false) throw new Error('sanity: B3 winner 4 unbought ⇒ basketPaid false');
  const bs3 = summarizeBand(unbought);
  if (bs3.bandHitRate !== 1 || bs3.basketPaidRate !== 0) throw new Error(`sanity: B3 hit ${bs3.bandHitRate} paid ${bs3.basketPaidRate}`);
  if (!(bs3.bestCaseBasketRoi < 0)) throw new Error(`sanity: B3 basket ROI must be negative (unbought hit pays $0), got ${bs3.bestCaseBasketRoi}`);

  // band basket ROI nets the canonical per-bucket fee: a non-zero --fee-rate strictly lowers it.
  if (!(summarizeBand(bandRows, 0.05).bestCaseBasketRoi < summarizeBand(bandRows, 0).bestCaseBasketRoi)) {
    throw new Error('sanity: band fee-rate must reduce basket ROI');
  }
  // a grading_mismatch band event is excluded entirely (not scored).
  const bmm = summarizeBand(bandRows.map((r) => ({ ...r, gradingMismatch: r.eventId === 'B2' })));
  if (bmm.nEvents !== 1 || bmm.nResolved !== 1) throw new Error(`sanity: band grading_mismatch should drop B2, got ${bmm.nEvents} events`);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  sanity();
  loadEnv();
  const { values } = parseArgs({
    options: { days: { type: 'string' }, 'fee-rate': { type: 'string' }, 'min-depth': { type: 'string' } },
  });
  const days = Math.max(1, Math.floor(Number(values.days ?? 14) || 14));
  // taker fee as a FRACTION (e.g. 0.05 = the §9R 5% weather rate) → the canonical rate·p·(1−p) curve, NOT a flat
  // per-share charge. Default 0 (gross). This is the bot/paper-backtest convention; never a bespoke flat fee.
  const feeRate = Math.max(0, Number(values['fee-rate'] ?? 0) || 0);
  const minDepthUsd = values['min-depth'] != null ? Math.max(0, Number(values['min-depth']) || 0) : DEFAULT_MIN_DEPTH_USD;
  const db = makeScriptDb();
  try {
    process.stderr.write(
      `${SCRIPT} · ${new Date().toISOString()} · reading opening_captures ⋈ market_events over ${days}d — read-only\n`,
    );
    const rows = await loadRows(db, days, minDepthUsd);
    const bandRows = await loadBandEnvelope(db, days, minDepthUsd);
    process.stderr.write(`  ${rows.length} entry snapshots (events × age-bin) · ${bandRows.length} band-bucket envelopes\n`);
    const res = scoreAll(rows, feeRate, minDepthUsd);
    const band = summarizeBand(bandRows, feeRate);
    report(res, band, feeRate, minDepthUsd, console.log);
  } finally {
    await db.end();
  }
}
